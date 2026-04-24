# Milestone 2 — Backend Runner + DB + Session Bridge

Source of Truth: `plans/sandbox-plan_v2_final.md`. Research: `plans/finigs_just_as_resource_and_knowlege.txt`.

## Goal

After M2 the backend chain for "In Sandbox starten" works end-to-end: `POST /api/sandbox/:todoId/start` triggers a hardened container on `lp03` via `docker --context lp03`, streams `stream-json` through the existing `SessionStore` and SSE pipe at `/api/agent/session/:todoId/stream`, enforces a semaphore + watchdog, and on exit persists `sandbox_status` + `sandbox_pr_url`. Only the UI is missing — that's M3.

## Dependencies

- M1 done: image `werkbank-sandbox:latest` buildable on `lp03`, `docker context create lp03` active on the VM.
- Existing code **read, not modified**:
  - `claude-sessions.ts` — `SessionStore` (line 420), `handleJsonLine` (690), `MAX_OUTPUT_BYTES`, `treeKill` (30), `ClaudeSession` shape, `renderPreprompt` (332).
  - `routes/agent.ts` — SSE at 126–177 reused as-is.
  - `crypto.ts` `decryptToken(enc, iv, tag)`.
  - `services/github.ts` + `services/repo-mappings.ts` for repo-URL resolution.
  - `routes/attachments.ts` `resolveAttachmentPaths(todoId, ids)` (line 59).

## Inputs

- Env (repo-root `.env`): `ENCRYPTION_KEY`, `ANTHROPIC_API_KEY` (required). Optional `SANDBOX_DOCKER_CONTEXT`, `SANDBOX_IMAGE_TAG` override the corresponding settings rows.
- New settings rows: `sandbox.max_concurrent`, `.image_tag`, `.docker_context`, `.werkbank_public_url`, `.default_timeout_min`, `.default_max_turns`, `.claude_model`, `.git_author_name`, `.git_author_email`.
- New per-todo columns (all nullable): `branch_name`, `base_branch`, `test_command`, `sandbox_timeout_min`, `sandbox_max_turns`, and state `sandbox_status`, `sandbox_pr_url`.

## Tasks (atomic commit order)

### Task 1 — DB migrations

`apps/api/src/db.ts`, inside `initDb()` after existing `addColumnIfMissing` block (~line 168), before providers seed.

- `addColumnIfMissing` for: `branch_name TEXT`, `base_branch TEXT`, `test_command TEXT`, `sandbox_status TEXT`, `sandbox_pr_url TEXT`, `sandbox_timeout_min INTEGER`, `sandbox_max_turns INTEGER`. No CHECK on `sandbox_status` — Zod validates, mirroring `task_type` at line 159.
- `CREATE INDEX IF NOT EXISTS idx_todos_sandbox_status ON todos(sandbox_status)`.
- Seed settings with `INSERT OR IGNORE` using JSON-encoded values (settings is read via `JSON.parse` throughout — see `claude-sessions.ts:296`): `max_concurrent="3"`, `image_tag="\"werkbank-sandbox:latest\""`, `docker_context="\"lp03\""`, `werkbank_public_url="\"\""`, `default_timeout_min="30"`, `default_max_turns="40"`, `claude_model="\"claude-sonnet-4-5\""`, `git_author_name="\"claude-bot\""`, `git_author_email="\"claude-bot@users.noreply.github.com\""`.

Commit: `feat(sandbox): db migrations for sandbox columns and default settings`.

### Task 2 — Zod schema

`apps/api/src/schemas.ts` — append at EOF.

- `SandboxStatusEnum = z.enum(['idle','queued','running','pushed','failed','no_test','no_changes'])`.
- `SandboxStartSchema`: `prompt(1..50k)`, `attachmentIds(int positive, max 100, optional default [])`, `includeAnalyses bool optional`, `includeSnippets bool optional`, `branchName string(1..200) optional`, `baseBranch string(1..200) optional`, `testCommand string(max 500) nullable optional`, `maxTurns int(1..200) optional`, `timeoutMin int(1..240) optional`.

Commit: `feat(sandbox): SandboxStartSchema`.

### Task 3 — `registerExternalSession` on SessionStore

`apps/api/src/services/claude-sessions.ts` — add three public methods to `SessionStore` (below `start()` at line 433). **Do not touch existing code paths.**

- `registerExternalSession(todoId, { cwd, prompt }): ClaudeSession` — reject with `status:409` if a session already exists for this todo. Build a fresh `ClaudeSession` (`status:'running'`, `turnActive:true`, seed turn index 1 with the prompt), store in `sessions` map, init empty `stdoutBuffers` entry, return it. Do not spawn a child.
- `pushExternalStdout(todoId, chunk: string): void` — append to the per-todo buffer, call existing private `flushStdoutBuffer(session, false)`. That routes through `handleJsonLine` (line 690) verbatim — stream-json from `docker logs -f` is byte-identical to local spawn.
- `endExternalSession(todoId, { exitCode, errorMessage, statusOverride? })` — flush with `final=true`, set `status = statusOverride ?? (exitCode===0?'exited':'error')`, `endedAt`, `exitCode`, close last turn, emit `'end'` — same event the SSE consumer already handles.

Rationale: SSE client at `/api/agent/session/:id/stream` subscribes to the shared emitter. Pushing bytes into the same store makes sandbox runs appear in the exact same pipe with zero UI/SSE changes.

Commit: `feat(sandbox): register external docker-logs sessions in claudeSessions store`.

### Task 4 — `services/sandbox-runner.ts`

New file. Imports: `spawn` (`node:child_process`), `randomUUID` (`node:crypto`), `EventEmitter`, `db`, `decryptToken`, `resolveLocalPath`, `resolveAttachmentPaths`, `renderPreprompt` (if not exported, mark as a one-line export change noted in Task 3 — keep it a named export), `claudeSessions`.

**Helpers:**
- `getSetting<T>(key, fallback)` — `JSON.parse` of `settings.value`, fallback on any error (pattern from `claude-sessions.ts:296-302`).
- `getDockerContext()` = `process.env.SANDBOX_DOCKER_CONTEXT || getSetting('sandbox.docker_context','lp03')`.
- `getImageTag()` = `process.env.SANDBOX_IMAGE_TAG || getSetting('sandbox.image_tag','werkbank-sandbox:latest')`.
- `slugify(title, 40)` — same kebab-case heuristic as `GitBranchButton.vue`.
- `resolveRepoUrl(todoId)` — reads todos; for `source='github'` strip `#…` from `source_ref` → `https://github.com/<owner>/<name>.git`. Non-github todos: `throw { status:400, message:'Sandbox requires a GitHub source todo' }`.
- `getGithubToken()` — integrations row, `decryptToken` or throw.
- `dockerSpawn(args, opts)` = `spawn('docker', args, { shell:true, windowsHide:true, detached:!IS_WINDOWS, ...opts })`. Reuse `treeKill` (import from `claude-sessions.ts` — mark as export needed, tiny one-line change noted in Task 3).

**Semaphore:**
- In-memory `Map<todoId, RunSlot>` + FIFO queue array.
- `maxSlots()` reads `sandbox.max_concurrent` live at every scheduling decision.
- Overflow: set `todos.sandbox_status='queued'`, push to queue. `release()` pops FIFO via `setImmediate` (avoids unbounded stack).

**Public API:**
- `startSandboxRun(todoId, prompt, opts) → { runId, queued }` — validate, resolve repo+token, compute effective branch/base/test/timeout/maxTurns (per-todo column → opts override → setting default), render preprompt via `renderPreprompt(todoId, prompt, 'work', includeAnalyses, includeSnippets)` — this rendered text becomes the `TODO_TEXT` env. Queue or launch.
- `stopSandboxRun(todoId)` — `treeKill` the logs-follow child, fire `docker --context <ctx> kill <name>`, mark `sandbox_status='failed'`, release slot.
- `listRuns()` — snapshot of active + queued.
- `rebuildImage()` — async generator yielding stdout chunks from `docker --context <ctx> build -t <image_tag> -f - .` with build context piped.
- `testConnection()` — `docker --context <ctx> run --rm curlimages/curl:latest -sSf --max-time 5 <werkbank_public_url>/api/health`, parsed result.
- `sweepOrphans()` — on startup, `docker --context <ctx> ps -a --filter 'name=werkbank-sbx-' --format '{{.Names}}'` → `rm -f` each. Non-fatal if docker context unreachable.

**Run lifecycle (`launchNow`):**
1. `runId = randomUUID().slice(0,8)`; `containerName = werkbank-sbx-${todoId}-${runId}`.
2. `docker image inspect <imageTag>` on the context; if missing, stream `rebuildImage()` into the SSE as `[building sandbox image …]` chunks before proceeding.
3. `claudeSessions.registerExternalSession(todoId, { cwd:'(sandbox)', prompt: renderedPrompt })`.
4. Resolve attachments via `resolveAttachmentPaths`. Plan `docker cp <absPath> <name>:/attachments/<id>-<filename>` per attachment.
5. **Attachment path rewriting in the rendered prompt:** string-replace host paths (`D:\…\attachments\<todoId>\<uuid>`) with container paths (`/attachments/<id>-<filename>`). Operate on the prompt string right before building the run command — never mutate the preprompt template. This is load-bearing because `renderPreprompt`'s preamble already embeds host paths.
6. Build `docker run` arg list per v2 § Runtime hardening. Env values injected via `--env-file /tmp/werkbank-sbx-${runId}.env` (written with 0600 mode, deleted in finally) — avoids injection via attachment filenames containing `$(…)` and stays under Windows CLI length limits. Env keys: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `REPO_URL`, `BASE_BRANCH`, `BRANCH_NAME`, `TODO_TEXT`, `TODO_ID`, `TASK_ID=${todoId}-${runId}`, `WERKBANK_API_URL`, `WERKBANK_HOST`, `MAX_TURNS`, `TEST_CMD`, `CLAUDE_MODEL`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`. Hardening flags: `--rm -d --name <n> --cap-drop=ALL --cap-add=NET_ADMIN --cap-add=NET_RAW --security-opt no-new-privileges:true --read-only --tmpfs /tmp:size=256m,noexec,nosuid --tmpfs /workspace:size=4g,exec,nosuid,uid=1000,gid=1000 --tmpfs /home/node:size=64m,exec,nosuid,uid=1000,gid=1000 --memory=4g --memory-swap=4g --cpus=2 --pids-limit=512 -u 1000:1000 <imageTag>`.
7. `spawnSync docker run -d` → container ID from stdout. On non-zero exit: `endExternalSession` with errorMessage, `sandbox_status='failed'`, release slot, return.
8. Sequentially `docker cp` attachments (non-fatal — push `[attachment copy failed …]` chunk and continue). After all copies succeed, `docker exec <n> touch /attachments/.ready` (entrypoint waits for this — cross-ref M1 entrypoint adjustment).
9. Spawn `docker --context <ctx> logs -f <n>` as long-lived child with `shell:true, detached:!IS_WINDOWS`. Pipe stdout → `claudeSessions.pushExternalStdout(todoId, chunk.toString('utf8'))`. Stderr → append `[docker stderr] …`. While tailing, **also** cache any line matching `^\{"status":` — this is the entrypoint's final status printed to stdout (same one written to `status.json`); it's the robust source-of-truth when `--rm` wipes the file before we can `cp` it.
10. Watchdog `setTimeout(() => killRun(todoId,'timeout'), timeoutMin*60_000)`; clear on exit.
11. On logs-follow child `close`: `docker inspect -f '{{.State.ExitCode}}' <n>` to get container's real exit (logs pipe can close before container exits; poll up to 10× 1s if still running).
12. Attempt `docker cp <n>:/workspace/<taskId>.status.json -` to recover PR URL; if container already gone, fall back to the cached status line from step 9.
13. Map exit → `sandbox_status`: 0→`pushed`, 2→`no_changes`, 3→`failed`, 4→`failed`, 5→`no_test`, 130→`failed`, else→`failed`. On `pushed` write `sandbox_pr_url`. Single `UPDATE todos SET sandbox_status=?, sandbox_pr_url=?, updated_at=datetime('now') WHERE id=?`.
14. `claudeSessions.endExternalSession(todoId, { exitCode, errorMessage:null })` — SSE `end` fires.
15. `docker rm -f <n>` best-effort. Delete env-file. Release slot, drain queue via `setImmediate`.

Commit: `feat(sandbox): sandbox-runner service (semaphore, docker run/logs, watchdog, status parse)`.

### Task 5 — `routes/sandbox.ts`

Thin router, all logic in runner.

- `POST /:todoId/start` — `SandboxStartSchema.parse(req.body)`, call `startSandboxRun`, `201 { runId, queued }`.
- `POST /:todoId/stop` — `stopSandboxRun`, `200 { stopped:true }`.
- `GET /list` — `{ runs: listRuns() }`.
- `POST /image/rebuild` — SSE with the same header block as `agent.ts:126-177`; iterate `rebuildImage()` → `write('chunk',{text})`, then `write('end',{ok, imageTag})`.
- `POST /settings/test-connection` — `await testConnection()` → `200 { ok, werkbankReachable, detail }`.

Commit: `feat(sandbox): routes for start/stop/list/image-rebuild/test-connection`.

### Task 6 — Mount router + startup sweep

`apps/api/src/index.ts` after `queueRouter` mount (line 63):
- `import { sandboxRouter } from './routes/sandbox.js';`
- `app.use('/api/sandbox', sandboxRouter);`
- In the `app.listen` callback, call `sweepOrphans().catch(() => {})` alongside the other startup tasks.

Commit: `feat(sandbox): mount /api/sandbox router + orphan sweep on startup`.

## Internal API auth (decision)

**M2: leave werkbank API unauthenticated.** MCP reach-back already was. LAN-only threat model; VM firewall + `init-firewall.sh` egress whitelist on the container are the controls. Revisit in M4 if needed — a one-file addition of `WERKBANK_RUN_TOKEN` env + an `x-werkbank-run` header middleware is the escape hatch.

## Verification

Against todo `42` with `source='github'`, `source_ref='acme/demo#issue-7'`, valid GitHub PAT configured, `sandbox.werkbank_public_url='http://192.168.1.50:3001'`.

```bash
# Start
curl -sS -X POST http://localhost:3001/api/sandbox/42/start \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add a code comment to README"}' | jq .
# → { "runId":"...", "queued":false }

# Reuse agent SSE for live output
curl -N http://localhost:3001/api/agent/session/42/stream

# List
curl -sS http://localhost:3001/api/sandbox/list | jq .

# Stop
curl -sS -X POST http://localhost:3001/api/sandbox/42/stop

# Connection test
curl -sS -X POST http://localhost:3001/api/sandbox/settings/test-connection | jq .

# Image rebuild (SSE)
curl -N -X POST http://localhost:3001/api/sandbox/image/rebuild

# DB truth
sqlite3 data/werkbank.db \
  "SELECT id, sandbox_status, sandbox_pr_url FROM todos WHERE id=42;"
```

Success flavors (mirror v2 § Verification 3–10): happy path → `pushed` + PR URL; test-gate fail → `failed` exit 4; no test → `no_test` exit 5; max-turns → `failed` (entrypoint exit 3, JSON parsed by existing `handleJsonLine`); watchdog → `failed`; semaphore overflow with `max_concurrent=3` + 5 starts → 3 running, 2 queued, FIFO drain.

## Risks

1. **SSH-context reconnects** — `docker --context lp03` rebuilds SSH per call; transient drops lose `logs -f`. The container finishes independently on lp03. Mitigation: re-issue `logs -f` up to 3× with 2 s backoff; status-file (step 12) + cached status line (step 9) is ground truth, not the stream.
2. **`docker cp` after `--rm`** — container can be gone before we copy `status.json`. Mitigation: step 9 greps status lines out of the live log stream; step 12 falls back to the cached line if `cp` fails.
3. **Semaphore races** — concurrent start calls for the same todo from refreshed tabs. Mitigation: `sessions.has(todoId)` or active `RunSlot` → `409 already running`. All map + queue mutations stay in one event-loop tick.
4. **Orphaned containers on werkbank crash** — `--rm` doesn't fire on `kill -9`. Mitigation: `sweepOrphans()` on startup (Task 6), scoped by container name prefix `werkbank-sbx-`.
5. **Attachment upload timing** — entrypoint starts `claude` immediately, possibly before `docker cp` finishes. Mitigation: the entrypoint waits for `/attachments/.ready` (30 s timeout; M1 adjustment); runner `touch`es it after all copies land.
6. **Prompt injection via attachment filenames** — filenames with `$(…)` could leak through `-e TODO_TEXT=…`. Mitigation: use `--env-file` (step 6) — no shell interpolation of values; file mode 0600; deleted in finally.
7. **Preprompt references host paths** — `renderPreprompt` injects `D:\…` paths into the prompt envelope. Must be rewritten to container paths in step 5 before env-file write.
8. **`renderPreprompt`/`treeKill` exports** — both currently module-private in `claude-sessions.ts`. Task 3 includes adding `export` to both names; no other changes to that file.

## Handoff to Milestone 3 (UI)

Stable API contract — do not break without bumping M3.

- `POST /api/sandbox/:todoId/start` body: `{ prompt, attachmentIds?, includeAnalyses?, includeSnippets?, branchName?, baseBranch?, testCommand?, maxTurns?, timeoutMin? }` → `201 { runId, queued }`.
- `POST /api/sandbox/:todoId/stop` → `200 { stopped }`.
- `GET /api/sandbox/list` → `{ runs: Array<{ todoId, runId, containerName, startedAt, state:'running'|'queued', branch, baseBranch, timeoutMin }> }`.
- `POST /api/sandbox/image/rebuild` — SSE events `chunk {text}` + `end {ok, imageTag}`.
- `POST /api/sandbox/settings/test-connection` → `{ ok, werkbankReachable, detail }`.
- **Live output SSE reuses `/api/agent/session/:todoId/stream`** — same `chunk`/`turn-end`/`end`/`cleared` shape. UI doesn't distinguish sandbox from local at the SSE layer.
- New `todos` columns surface via existing `GET /api/todos/:id` (returns `SELECT *`): `branch_name`, `base_branch`, `test_command`, `sandbox_status`, `sandbox_pr_url`, `sandbox_timeout_min`, `sandbox_max_turns`. M3 mirrors these in `apps/web/src/types.ts`.
- New settings keys `sandbox.*` readable via existing `GET /api/settings/:key`; M3 writes via existing `PUT /api/settings/:key`.
