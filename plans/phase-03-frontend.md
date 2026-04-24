# Milestone 3 — Frontend Integration for Remote Sandbox

**Source of truth:** `plans/sandbox-plan_v2_final.md`. **Scope fence:** Wire the UI into the M2 HTTP contract so a user can trigger a sandbox run, watch the stream, open the PR, and see status on the board.

## Goal

From any todo detail page, click **"In Sandbox starten"**, watch the same SSE stream as the local agent, edit per-todo overrides, and on success click through to the draft PR. New "Sandbox" section in Settings houses host config, smoke-tests and manual image-rebuild. UI = German (CLAUDE.md); code/commits = English. No new UI framework — reuse `app.css` variables. Desktop-first.

## Dependencies

- **M1 done** — research locked.
- **M2 done** — blocking. Endpoints and DB columns below must exist before a single frontend line lands.
- No new npm deps. Plain fetch + existing `EventSource`.

## Inputs — the M2 API contract consumed here

If M2 ships different shapes, `api.ts` (Task 1) is the sole adjustment point.

| Method & path | Body / return |
|---|---|
| `POST /api/sandbox/:todoId/start` | `{ prompt, branch_name?, base_branch?, test_command?, max_turns?, timeout_min?, attachmentIds?, includeAnalyses?, includeSnippets? }` → `{ session, sandboxRunId }` |
| `POST /api/sandbox/:todoId/stop` | → `{ session \| null }` |
| `GET  /api/sandbox/runs` | → `{ runs: SandboxRun[] }` |
| `POST /api/sandbox/image/rebuild` | → `{ ok, streamTodoId: -1 }` (logs stream via existing SSE channel) |
| `POST /api/sandbox/settings/test-connection` | → `{ ok, status, latencyMs, error? }` |
| `POST /api/sandbox/token/check` | → `{ ok, scopes, missing, error? }` |
| *(existing)* `GET /api/agent/session/:todoId/stream` | reused verbatim |
| *(existing)* `PATCH /api/todos/:id` | now accepts the 7 new columns |

New `Todo` columns (M2 migrations): `branch_name`, `base_branch`, `test_command`, `sandbox_status`, `sandbox_pr_url`, `sandbox_timeout_min`, `sandbox_max_turns`.

## Deliverables

1. `src/types.ts` — mirror the 7 fields + `SandboxStatus` union + `SandboxRun`.
2. `src/api.ts` — `api.sandbox.*` wrappers.
3. `src/components/ClaudeAgent.vue` — "In Sandbox starten" button. Reuse attachments/analyses/snippets/preprompt.
4. `src/components/GitBranchButton.vue` — `agent/<todoId>-<slug>` prefix in sandbox mode; shared helper persists name.
5. `src/views/TodoDetailView.vue` — "Sandbox-Lauf" collapsible: editable overrides + read-only PR link + status chip.
6. `src/components/TodoCard.vue` — tiny `sandbox_status` chip (no wider restyle).
7. `src/views/SettingsView.vue` — "Sandbox" section: host config, 3 action buttons, read-only firewall whitelist.
8. `src/styles/app.css` — `.sandbox-chip` base + state modifiers using existing palette vars.

## German UI strings (ship verbatim)

| Element | Label |
|---|---|
| Primary button | `🐳 In Sandbox starten` |
| Stop button | `■ Sandbox stoppen` |
| Chip `idle`/`queued`/`running`/`pushed`/`failed`/`no_test` | `Leerlauf` / `In Warteschlange` / `Läuft…` / `Gepusht` / `Fehlgeschlagen` / `Keine Tests` |
| Detail section | `Sandbox-Lauf` |
| Settings section | `Sandbox` |
| PR link | `Draft-PR öffnen →` |
| Fields | `Branch-Name` / `Basis-Branch` / `Test-Kommando` / `Timeout (Minuten)` / `Max. Turns` |
| Settings | `Docker-Context` / `Werkbank-URL (aus Sandbox erreichbar)` / `Erreichbarkeit testen` / `Sandbox-Image neu bauen` / `Token-Scope prüfen` / `Firewall-Whitelist (nur Lesen)` |
| Error — host | `Sandbox-Container auf lp03 konnte nicht gestartet werden` |
| Error — PAT | `GitHub-Token fehlt folgende Scopes:` |
| Error — reach | `Werkbank vom lp03 aus nicht erreichbar` |
| Confirm stop | `Laufende Sandbox wirklich beenden?` |
| Tooltip (no repo) | `Sandbox benötigt ein verknüpftes GitHub-Repo` |

## Tasks (ordered; each bullet = one commit)

### 1. Foundation
- **Commit 1** `types(web): mirror sandbox columns`
  - `SandboxStatus = 'idle'|'queued'|'running'|'pushed'|'failed'|'no_test'`; extend `Todo` with the 7 optional fields; add `SandboxRun`; export `SANDBOX_STATUS_LABELS` (German) and `SANDBOX_STATUS_COLOR` (maps to `--fg-muted`/`--accent`/`--success`/`--danger`/`--warn`).
- **Commit 2** `api(web): add sandbox wrappers`
  - New `sandbox` namespace on `api` object matching Inputs table. Reuse existing `request` helper. Add `api.sandbox.streamImageBuildUrl()` returning `/api/agent/session/-1/stream` so the existing `EventSource` code is reused.

### 2. Branch-name heuristic & persistence
- **Commit 3** `components(web): sandbox-aware branch prefix`
  - `GitBranchButton.vue`: new optional prop `sandboxMode?: boolean`. When true, prefix becomes `agent/` and suffix `${todoId}-${slug}` (jira/github source-ref handling for the slug is preserved). Default false → unchanged behavior.
  - Export `computeAgentBranchName(todo)` from a new `src/utils/branchName.ts` so the detail view and the start button share one source of truth. Must match the server-side derivation in `sandbox-runner.ts`; add a comment linking to `sandbox-plan_v2_final.md#branch naming`.
  - Clipboard copy unchanged.

### 3. Start button on ClaudeAgent
- **Commit 4** `feat(web): sandbox start button on ClaudeAgent`
  - Add `🐳 In Sandbox starten` next to `▶ Run Claude`. Same `canRun` predicate PLUS a `source_ref` requirement (can't sandbox a local-only todo).
  - On click:
    1. If `todo.branch_name` empty → `todosStore.update(id, { branch_name: computeAgentBranchName(todo) })` first (idempotent).
    2. `api.sandbox.start(...)` with prompt/attachments/overrides/toggles.
    3. Optimistic local `sandbox_status='queued'` via a new non-undoable `_updateLocal(id, patch)` on the store (see "Pinia interaction").
    4. SSE subscription is reused — M2 writes into the same `SessionStore`, so the existing `eventSource` needs no changes.
  - Add `🐳 Sandbox stoppen` button that replaces `■ Stop` while `sandbox_status === 'running'`. German confirm dialog.
  - Use existing `.primary`/`.ghost`/`.danger`/`.warn` classes — no new CSS.

### 4. TodoDetailView: overrides + chip
- **Commit 5** `feat(web): sandbox overrides in TodoDetailView`
  - Below the Claude-Agent card, add a collapsible `🐳 Sandbox-Lauf` block (collapsed by default).
  - Fields all go through `todosStore.update` (undo-stack capture is desirable for overrides):
    - `branch_name` (placeholder = `computeAgentBranchName(todo)`)
    - `base_branch` (default `develop`)
    - `test_command` (placeholder `npm test / pytest / …`)
    - `sandbox_timeout_min` (1–120)
    - `sandbox_max_turns` (1–80)
  - Read-only `sandbox_pr_url` rendered as `<a target="_blank">Draft-PR öffnen →</a>` when non-null.
  - Status chip in section header — reuse `.agent-badge` class + new color mapping.
  - Fields disabled while `sandbox_status === 'running'` (mirror the existing queue-edit lock pattern in the file).

### 5. Board card chip
- **Commit 6** `feat(web): sandbox chip on TodoCard`
  - Tiny chip in `TodoCard.vue` next to pomodoro/attachment icons. Hidden when `sandbox_status` is falsy or `idle`. One line of template + one class + state modifiers. Card height must stay stable.

### 6. Settings
- **Commit 7** `feat(web): sandbox settings section`
  - Append a new `<section>` after integrations in `SettingsView.vue`.
  - Fields bind via `api.settings.set('sandbox.<key>', v)` — keys per `sandbox-plan_v2_final.md#Modified files`: `docker_context`, `werkbank_public_url`, `max_concurrent`, `default_timeout_min`, `default_max_turns`, `claude_model`, `git_author_name`, `git_author_email`.
  - Three action buttons, use the existing `flash` pattern:
    - `Erreichbarkeit testen` → `api.sandbox.testConnection()`
    - `Sandbox-Image neu bauen` → `api.sandbox.imageRebuild()` then open `EventSource` on `streamImageBuildUrl()` and append into a `<pre>`.
    - `Token-Scope prüfen` → `api.sandbox.tokenCheck()`; on missing scope render the German prefix + list.
  - Firewall-whitelist preview — read-only `<ul>`, hardcoded: `github.com`, `api.github.com`, `api.anthropic.com`, `registry.npmjs.org`, `statsig.com`, plus the configured public URL.

### 7. Styles
- **Commit 8** `styles(web): sandbox status chips`
  - Add `.sandbox-chip` base + five state modifiers in `app.css` consuming existing CSS variables only. Works across all themes.

## Pinia interaction — keeping undo sane

`todos.ts#update` pushes an undo entry per mutated field. Two rules:

- **Overrides in the detail view** → go through `todosStore.update` → undoable. Desired.
- **Optimistic `sandbox_status` on start and every SSE `end`** → must NOT enter undo. Extend `todos.ts` with a private `_updateLocal(id, patch)` that writes `items` only (no API, no undo push). Server remains source of truth.
- **Card column movement** — M2 writes `todos.status='test'` on `pushed`. Current `ClaudeAgent` flow does a `loadAttachments()`-etc. refetch on SSE `turn-end`; the card move will ride on the next `todosStore.fetchAll()` (triggered by focus/reload). If Verification step 5 finds a visible gap, add a targeted `fetchAll()` call on the sandbox SSE `end` event.

## Verification — manual UI walkthrough

Use a todo cloned from the GitHub integration (real `source_ref`).

1. `npm run build` at repo root green (vue-tsc + tsc).
2. `🐳 In Sandbox starten` is disabled without `source_ref`; enabled with. Click → SSE output in the existing agent `<pre>`; chip cycles `Leerlauf → In Warteschlange → Läuft…`.
3. Todo started with empty `branch_name` now shows `agent/<id>-<slug>`. Retry click does not overwrite.
4. On happy path `sandbox_pr_url` populates, link opens draft PR in a new tab.
5. After `pushed`, card moves to `Prüfstand` within 2 s. If not, add the targeted `fetchAll()` (see Pinia section).
6. Repo with no test-hook + empty `test_command` → chip `Keine Tests` (grey), no PR link.
7. Click `🐳 Sandbox stoppen` while running → confirm → SSE `end` → chip `Fehlgeschlagen`. `docker --context lp03 ps` shows no orphan.
8. All 5 override fields disabled while `running`.
9. Edit `test_command` → Ctrl+Z reverts. Sandbox-status changes absent from undo stack.
10. Settings reach-test button: `ok` with latency. With obviously wrong URL: German error.
11. Settings image rebuild button: streams `docker build` output into `<pre>`, ends with the final tag line.
12. Settings token check: valid PAT → scope list; read-only PAT → missing-scope list.
13. Cycle all themes (`workshop`/`dark`/`light`/`terminal`/`matrix`) — chip colors readable in each. No hard-coded hex.
14. Create `sandbox_status='running'` via SQL — board card shows `Läuft…` without layout shift.

## Risks

- **SSE reconnect after reload mid-run** — existing `ClaudeAgent` re-subscribes on mount and snapshots from server. Verify M2's sandbox sessions emit the `snapshot` event. If not, file a M2 follow-up, don't fork client logic.
- **Invalid branch-name input** — client-side trim + `/^[A-Za-z0-9._/-]+$/` with inline German hint; server-side Zod is the real gate.
- **Optimistic status rollback** — if the start POST throws after local write, catch block must call `_updateLocal(id, { sandbox_status: 'idle' })` and show the error banner.
- **Missing `source_ref`** — gate the button and show the tooltip „Sandbox benötigt ein verknüpftes GitHub-Repo".
- **`--warn` CSS var missing in matrix theme** — verify; add the var or fall back to `--accent` in chip CSS.

## Not in scope (deferred)

- Board filter "mit offenem PR" — scope-creep.
- Per-run history timeline (M2 persists rows; surfacing is later).
- Retry button on the chip — user re-clicks detail-view button for now.
- Cost/time telemetry.
- Mobile layout — werkbank is desktop-first.

## Handoff to Milestone 4

M4 owns: `docs/sandbox-setup.md` (copy from `sandbox-plan_v2_final.md`); manual E2E plan doc mirroring Verification; screenshots of each chip in each theme; troubleshooting for fine-grained PAT 403, SSO org, `docker context` drift, `lp03` SSH-TOFU. Nothing else blocks M4 once these 8 commits land.

---

**Plan review checklist:**
- [ ] M2 ships the exact endpoints in the Inputs table
- [ ] `branch_name` heuristic matches server-side derivation
- [ ] `sandbox_status` writes never enter undo stack
- [ ] German strings match the table verbatim
- [ ] No hard-coded theme colors — CSS vars only
