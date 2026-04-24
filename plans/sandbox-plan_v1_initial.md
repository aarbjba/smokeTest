# Remote Docker sandbox on `lp03.uts` for autonomous Claude agent runs per todo

**STATUS:** Draft. Awaiting user's background researcher findings before ExitPlanMode — plan incorporates the decisions above; will integrate researcher points when they land.

## Context

Today `apps/api/src/services/claude-sessions.ts:529-536` spawns `claude -p ... --dangerously-skip-permissions` directly on the host in `session.cwd` (typically the user's local repo checkout). The werkbank server itself runs inside a **Windows VM where Docker cannot run** — so we cannot sandbox locally. The Linux box `lp03.uts` is the designated Docker host on the same network.

Problems today:

- Every run mutates the user's working tree — no isolation, no clean slate.
- No git workflow is baked in; the agent decides ad hoc when to branch, commit, push.
- `--dangerously-skip-permissions` on a dev Windows host has no network/process boundary.
- N todos in parallel = N mutations on the same tree = collisions.
- Nothing enforces "tests pass before push."

**Goal:** Add a second execution mode "Run in Sandbox" that runs Claude inside an **ephemeral Docker container on `lp03.uts`**, driven by the werkbank API over an SSH Docker context. Each run does clone → branch → work → test → commit → push → draft-PR → cleanup end-to-end. Up to N concurrent runs (configurable).

## Architecture overview

```
   ┌──────────────── Windows VM ────────────────┐           ┌──────── lp03.uts (Linux) ────────┐
   │                                            │           │                                   │
   │  werkbank API (node)                       │           │  Docker Engine                    │
   │    apps/api/src/services/sandbox-runner.ts │  SSH      │                                   │
   │       └─> exec: docker --context lp03 \    │  ───────► │  werkbank-sandbox:latest (image)  │
   │              run --rm -d ...               │           │    ┌─ container: werkbank-sbx-N ─┐│
   │                                            │           │    │  clone github repo           ││
   │  SSE to browser  ◄──── docker logs -f ─────┼───────────┤    │  git switch -c <branch>      ││
   │                                            │           │    │  claude -p --mcp-config ...  ││
   │  werkbank MCP at http://<vm-ip>:3001 ◄─────┼─ LAN ─────┤    │  run test gate               ││
   │                                            │           │    │  git push + gh pr create     ││
   └────────────────────────────────────────────┘           │    └──────────────────────────────┘│
                                                            └───────────────────────────────────┘
```

Two planes:
1. **Control plane** — werkbank on the VM talks to lp03 over SSH using a Docker **context**. All `docker run`, `docker logs`, `docker rm` calls are invoked as `docker --context lp03 ...`. Logs come back over the SSH pipe.
2. **Data plane** — container on lp03 clones the GitHub repo directly (never touches the VM filesystem) and calls back to the werkbank API at the VM's LAN IP for MCP tool-calls.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Execution host | **`lp03.uts`** — Linux server on the same LAN. New `DOCKER_CONTEXT=lp03` on the VM. |
| Control transport | **Docker context over SSH** (`docker context create lp03 --docker host=ssh://werkbank@lp03.uts`). No TCP/TLS exposure needed. Reuses SSH key auth. |
| Base image | **Fork Anthropic's official devcontainer** (`anthropics/claude-code/.devcontainer/Dockerfile` — Node 20 + zsh + `init-firewall.sh`). Add `gh`, `git-lfs`, `entrypoint.sh`. Whitelist `github.com`, `api.github.com`, `api.anthropic.com`, `registry.npmjs.org`, **plus the VM's LAN IP/hostname** for MCP reach-back. |
| Repo source | **Fresh clone from GitHub** inside the container via `https://x-access-token:$GITHUB_TOKEN@github.com/<org>/<repo>.git`. Remote never touches the VM's working tree. Base branch `develop` (configurable per todo). |
| Push target | **Feature branch + draft PR to `develop`** via `gh pr create --draft --base develop`. Never auto-merge. PR URL is persisted on the todo. |
| Test gate | **Hybrid: repo auto-detect** (`npm test` / `pytest` / `make test` / `cargo test`) + **per-todo `test_command` override** (new nullable DB column). If no gate is detected AND no override set: skip push, mark `sandbox_status='no_test'`, surface to UI. |
| Concurrency | **Configurable in Settings, default 3.** Semaphore in `sandbox-runner.ts`. Overflow enters `queued` state. |
| UI trigger | **Separate "Run in Sandbox" button** on `ClaudeAgent.vue`, distinct from the interactive Start. |
| Branch name | **New `branch_name` column on `todos`**, auto-populated from existing `GitBranchButton.vue` logic when missing, editable in the todo detail view. |
| MCP reach-back | Container envs `WERKBANK_API_URL=http://<VM-LAN-IP>:3001` (IP stored in setting `sandbox.werkbank_public_url`). Firewall whitelist adds this host. |
| Log transport | `docker --context lp03 logs -f <container>` piped into existing `SessionStore` events. `handleJsonLine` parser at `claude-sessions.ts:690` reused verbatim. |
| Credentials | Reuse existing `integrations.token_enc` (GitHub PAT, AES-GCM via `apps/api/src/crypto.ts:19-24`). Decrypt per run, pass via `-e GITHUB_TOKEN=...` at runtime only. Never bake into image, never log. Same for `ANTHROPIC_API_KEY` (reused from werkbank `.env`). |
| Runaway timeout | **Per-todo, default 30 min.** New column `todos.sandbox_timeout_min INT`. Host watchdog: if container still running after timeout → `docker kill` + `sandbox_status='failed'`. |
| Image build | **Lazy auto-build on first run.** `sandbox-runner.ts` runs `docker --context lp03 image inspect werkbank-sandbox:latest`; if missing, streams `docker --context lp03 build` (with build context piped over SSH) and the build output flows to the SSE stream. Manual rebuild trigger in Settings. |

## Phase 0: Bootstrap `lp03.uts` (one-time, manual)

This is **not code the agent writes** — it's a runbook. Document it in `docs/sandbox-setup.md` (new file). Steps:

1. On `lp03.uts`:
   ```
   sudo apt install openssh-server docker.io
   sudo usermod -aG docker werkbank           # create user if missing
   mkdir -p /home/werkbank/.ssh
   ```
2. On the Windows VM, as the user running werkbank:
   ```
   ssh-keygen -t ed25519 -C werkbank-sandbox
   # copy public key to lp03:/home/werkbank/.ssh/authorized_keys
   ssh werkbank@lp03.uts 'docker version'    # smoke test
   docker context create lp03 --docker host=ssh://werkbank@lp03.uts
   docker --context lp03 ps                  # verify
   ```
3. Open the VM's LAN port so `lp03` can reach `http://<VM-IP>:3001/api/health`. Record `<VM-IP>` in werkbank Settings under `sandbox.werkbank_public_url`.

## Files to change

### New files

- `docker/sandbox/Dockerfile` — fork of Anthropic's devcontainer; add `gh`, `git-lfs`, `jq`, `entrypoint.sh`.
- `docker/sandbox/init-firewall.sh` — fork of Anthropic's firewall init. Whitelist extended with `WERKBANK_HOST` env (from `sandbox.werkbank_public_url`) so the container can reach the MCP.
- `docker/sandbox/entrypoint.sh` — bash runner:
  1. `git clone https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git /workspace && cd /workspace`
  2. `git fetch origin $BASE_BRANCH && git switch -c $BRANCH origin/$BASE_BRANCH`
  3. `git config user.email/user.name` from `$GIT_AUTHOR_EMAIL/$GIT_AUTHOR_NAME`
  4. stream-json bridge → `claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --mcp-config /etc/werkbank-mcp.json`
  5. on agent exit code 0 → resolve test command (env `$TEST_CMD`, else auto-detect). Run it; exit early if gate fails.
  6. `git add -A && git commit -m "<todo title>\n\n<short summary>"` (skip if nothing changed)
  7. `git push -u origin $BRANCH`
  8. `gh auth login --with-token <<< $GITHUB_TOKEN && gh pr create --draft --base $BASE_BRANCH --title ... --body ...`
  9. echo final JSON `{"pr_url": "...", "status": "pushed"}` on stdout for the host to parse.

- `apps/api/src/services/sandbox-runner.ts` — core runner:
  - Resolves `DOCKER_CONTEXT` from env (default `lp03`).
  - Exports `startSandboxRun(todoId, prompt, opts)`. Steps: decrypt GitHub token → look up repo URL (from `integrations` + todo source) → ensure image exists on `lp03` (lazy build) → acquire semaphore slot → `docker --context $DOCKER_CONTEXT run --rm -d -e GITHUB_TOKEN=... -e ANTHROPIC_API_KEY=... -e REPO=... -e BRANCH=... -e BASE_BRANCH=... -e TEST_CMD=... -e WERKBANK_API_URL=... -e TODO_ID=... --name werkbank-sbx-<todoId>-<runId> werkbank-sandbox:latest` → spawn `docker --context $DOCKER_CONTEXT logs -f <name>` and feed chunks into `SessionStore` events.
  - Watchdog timer: per-todo timeout → `docker --context lp03 kill <name>`.
  - Cleanup: on container exit, read trailing JSON line to extract `pr_url`; update todo; release semaphore slot.
  - Handles SSH disconnect mid-run: best-effort retry of `docker logs -f`; if the container has exited, read final state via `docker inspect`.

- `apps/api/src/routes/sandbox.ts` — thin router mounted at `/api/sandbox`: `POST /:todoId/start`, `POST /:todoId/stop`, `GET /list`. Delegates to `sandbox-runner`. SSE is reused from existing `/api/agent/session/:todoId/stream` because we register sandbox runs into the same `SessionStore`.

- `docs/sandbox-setup.md` — the Phase 0 runbook.

### Modified files

- `apps/api/src/db.ts` — additive migrations via `addColumnIfMissing`:
  - `todos.branch_name TEXT`
  - `todos.base_branch TEXT`  (default `develop` when null at read time)
  - `todos.test_command TEXT`
  - `todos.sandbox_status TEXT`  (`idle|queued|running|pushed|failed|no_test`)
  - `todos.sandbox_pr_url TEXT`
  - `todos.sandbox_timeout_min INT`
  - New `settings` rows: `sandbox.max_concurrent` (default `3`), `sandbox.image_tag` (default `werkbank-sandbox:latest`), `sandbox.docker_context` (default `lp03`), `sandbox.werkbank_public_url` (user fills in with `http://<VM-IP>:3001`), `sandbox.default_timeout_min` (default `30`).

- `apps/api/src/services/claude-sessions.ts` — add `registerExternalSession(todoId, { cwd, emit })` that creates a `ClaudeSession` entry backed by external stdout (docker logs) rather than a local child. Reuses `handleJsonLine` (line 690), `ClaudeSession` shape, `MAX_OUTPUT_BYTES`, event emitter. The existing SSE route in `apps/api/src/routes/agent.ts:126-177` sees both local and sandbox runs without change.

- `apps/api/src/schemas.ts` — add `SandboxStartSchema` (prompt, optional `branch_name`/`base_branch`/`test_command` override, `attachmentIds`, `includeAnalyses`, `includeSnippets`).

- `apps/api/src/index.ts` — mount `sandboxRouter` under `/api/sandbox`.

- `apps/web/src/components/ClaudeAgent.vue` — add second primary button **"In Sandbox starten"** next to existing Start; calls `POST /api/sandbox/:todoId/start`. Same attachment/analyses/snippets picker reused. Same SSE consumer reused.

- `apps/web/src/views/TodoDetailView.vue` (and nested components) — expose editable `branch_name`, `base_branch`, `test_command`, `sandbox_timeout_min` fields + a read-only `sandbox_pr_url` link when set + `sandbox_status` chip.

- `apps/web/src/components/GitBranchButton.vue` — when the todo has no saved `branch_name` and the user opens the sandbox run, auto-save the computed name back to the todo (one-time write). Existing clipboard behavior unchanged.

- `apps/web/src/views/SettingsView.vue` — new "Sandbox" section: Docker context name, werkbank public URL (with "Erreichbarkeit testen" button that hits `/api/health`), max concurrent runs, default timeout, manual image rebuild button, whitelist preview, SSH fingerprint check.

- `.env.example` — document `DOCKER_CONTEXT=lp03` as optional override (default same).

## Reuse of existing code

- `apps/api/src/crypto.ts` `decryptToken(enc, iv, tag)` — decrypt GitHub PAT per run.
- `apps/api/src/services/claude-sessions.ts`:
  - `handleJsonLine` (line 690) — parses `docker logs -f` output (same stream-json format from claude inside container).
  - `ClaudeSession` + `SessionStore` EventEmitter — SSE unchanged.
  - `renderPreprompt` (line 332) — preprompt rendering reused; passed to container as the user prompt via stream-json stdin.
  - `MAX_OUTPUT_BYTES`, `treeKill` — for the `docker logs -f` child process wrapper.
- `apps/api/src/routes/agent.ts:126-177` — SSE endpoint is shared.
- `apps/web/src/components/GitBranchButton.vue:79-106` — branch-name heuristic reused; now persists.
- `apps/api/src/routes/attachments.ts` `resolveAttachmentPaths` — attachments must be transferred to remote. Options: (a) `docker cp` each attachment into the container after start; (b) POST them to a small `/api/internal/attachments/:runId/:id` endpoint that the entrypoint fetches with an ephemeral token. Start with (a) — less surface area.
- `apps/api/src/services/github.ts` / `repo-mappings.ts` — resolve repo URL for the todo's `source_ref`.

## Open questions (for the researcher's findings or follow-up)

- **Windows-side docker CLI:** does the VM have `docker` CLI installed (required to run `docker --context lp03 ...`)? If not, add a one-liner install step (Docker Desktop or `choco install docker-cli`).
- **SSH host-key TOFU:** first connection to `lp03` needs key acceptance. Pre-populate `~/.ssh/known_hosts` in Phase 0 to avoid a hang on first run.
- **Private repos behind SSO:** classic PATs sometimes fail on SSO-enforced orgs. Document the "Enable SSO for this token" step in `docs/sandbox-setup.md`.

## Verification

1. **Bootstrap:** after Phase 0, `docker --context lp03 ps` from the VM succeeds.
2. **Image build:** click "Build sandbox image" in Settings. Progress streams; ends with `docker --context lp03 image inspect werkbank-sandbox:latest` succeeding.
3. **Single run end-to-end:** todo with `source=github`, `branch_name=feature/test-sandbox`, `base_branch=develop`. Click "In Sandbox starten" with prompt "add a code comment to README explaining the project". Expect: SSE shows clone → claude run → test run → git push → `gh pr create` → `sandbox_pr_url` populated → todo status flips to `test`.
4. **Test gate fail:** same flow with `test_command=false`. Expect: agent completes, tests fail, push does NOT happen, `sandbox_status='failed'`, SSE shows test failure output.
5. **No test detected, no override:** clean repo with no test script. Expect: `sandbox_status='no_test'`, no push, clear UI message.
6. **Concurrency:** start 5 runs with `sandbox.max_concurrent=3`. Expect: 3 run immediately, 2 queued, queue drains as each completes. `docker --context lp03 ps` confirms.
7. **Watchdog:** start a run with `sandbox_timeout_min=1` and a long-looping prompt. Expect: after 60 s, container `docker kill`'ed, `sandbox_status='failed'`, SSE end event emitted.
8. **Cleanup:** after any run terminates, `docker --context lp03 ps -a` shows no leftover (removed via `--rm`), semaphore slot is released.
9. **MCP reach-back:** inside a running container, have the agent call `mcp__werkbank__get_todo`; verify the werkbank log shows the inbound request from lp03.
10. **Kill path:** click "In Sandbox stoppen" mid-run. Expect: `docker --context lp03 kill` triggers, SSE `end` emitted, slot released, no orphan container on lp03.
11. **Network outage:** pull the VM's network briefly during a run. Expect: `docker logs -f` reconnects (best-effort) or gracefully surfaces `sandbox_status='failed'` if retries exhaust. Container itself continues on lp03 and will try to push when it finishes — idempotent because branch name is unique per run.
