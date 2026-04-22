# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run from repo root — this is an npm workspaces monorepo (`apps/api`, `apps/web`).

```bash
npm install              # install all workspaces
npm run dev              # frees ports 3001 & 5173, then runs api + web concurrently
npm run build            # typecheck + build both api and web
npm run start            # run built api (node dist/index.js)
npm run kill-dev         # free common dev ports if a previous run hung
```

Per-workspace:
```bash
npm -w apps/api run dev    # tsx watch src/index.ts    (→ http://localhost:3001)
npm -w apps/api run build  # tsc (emits apps/api/dist/)
npm -w apps/web run dev    # vite                       (→ http://127.0.0.1:5173)
npm -w apps/web run build  # vue-tsc --noEmit && vite build
```

There is **no test suite** and **no linter** configured. Typechecking is the only automated gate (`tsc` for api, `vue-tsc --noEmit` for web).

### Environment

Before first run: `cp .env.example .env` and generate `ENCRYPTION_KEY` (32 bytes hex). `.env` lives at the **repo root**, not in `apps/api` — `apps/api/src/index.ts` explicitly resolves `../../../.env` to work around `npm -w` setting cwd to the workspace. `DB_PATH` is resolved relative to `apps/api` cwd (default `./data/werkbank.db`).

Optional: `CLAUDE_CLI` can point to the full path of the `claude` executable if it isn't on `PATH` (used by the in-app Claude agent feature).

### Dev server quirks

Vite is bound to `127.0.0.1` on purpose — on Windows, IPv6 ports ≥ 5173 are frequently reserved by Hyper-V/WSL and `localhost` collides. See `apps/web/vite.config.ts`. Vite proxies `/api` → `http://127.0.0.1:3001`; never call backend URLs directly from frontend code, always go through `/api/...`.

## Architecture

Two independently versioned apps share only the HTTP contract — no shared types package. When changing a route, the Zod schema in `apps/api/src/schemas.ts` is the source of truth; the frontend mirrors it by hand in `apps/web/src/types.ts` and `apps/web/src/api.ts`.

### Backend (`apps/api`)

Express + `better-sqlite3` + Zod, ESM (`"type": "module"`, so local imports use `.js` extensions even for `.ts` files).

- `src/index.ts` — loads `.env` from repo root, calls `initDb()`, mounts routers under `/api/*`, starts `scheduler` (GitHub/Jira sync every 5min) and `recurrence-generator` (every 10min). ZodError is caught by the global error handler and returned as 400.
- `src/db.ts` — single `Database` instance with `journal_mode=WAL` and `foreign_keys=ON`. Schema is created idempotently in `initDb()`. **Migrations are hand-written in code**:
  - `addColumnIfMissing` for additive columns (check `PRAGMA table_info`).
  - `migrateTodosStatusCheck` rebuilds the `todos` table when the CHECK constraint predates the `'test'` status. Wraps the rebuild in `PRAGMA legacy_alter_table=1` to prevent SQLite's modern ALTER from silently rewriting child-table FKs to `todos_old` (and the follow-up `repairDanglingTodosOldFks` heals DBs where an earlier version of the migration did corrupt FKs). Read the comments in `db.ts` before touching this.
- `src/crypto.ts` — AES-256-GCM token encryption. `ENCRYPTION_KEY` must be 64 hex chars OR any string (sha256-derived). Integration tokens are stored encrypted (`token_enc`/`token_iv`/`token_tag`); the frontend only ever sees a masked preview.
- `src/routes/*` — thin route handlers, all parse input via `schemas.ts`. Key ones:
  - `todos.ts` — list query uses correlated subqueries to include `subtask_done`/`subtask_total` so the board doesn't N+1. `POST /todos/bulk` and `POST /todos/reorder` wrap changes in `db.transaction`. Bulk status moves intentionally **skip writeback** to remote systems.
  - `agent.ts` — manages Claude CLI sessions per todo (start, send, stop, clear) plus an SSE stream at `/session/:todoId/stream`.
  - `attachments.ts` — disk-backed via multer, files under `{DB_PATH dir}/attachments/{todoId}/{uuid}`. Exports `resolveAttachmentPaths` for the agent to pass absolute paths into Claude prompts.
  - `ics.ts` — mounted at `/api` (not `/api/ics`) so subscribers get a stable `.ics` URL.
- `src/services/`:
  - `github.ts` / `jira.ts` — fetch remote issues, upsert into `todos` with `source`/`source_ref`/`source_url`.
  - `writeback.ts` — pushes local status changes back to the remote. **Status mapping is lossy and deliberate**: local has 4 statuses (`todo`/`in_progress`/`test`/`done`), GitHub has 2 (`open`/`closed`), Jira has 3 categories (`new`/`indeterminate`/`done`). The dispatcher compares `toJiraCategory(old)` vs `toJiraCategory(new)` and **skips the call when coarse-grained status is unchanged** (e.g. `in_progress ↔ test` doesn't touch Jira). Writeback failures are non-blocking — the error is stored on `todos.last_writeback_error` and the HTTP response still returns 200.
  - `scheduler.ts` — overlap-guarded via per-provider flags; only runs if the provider has `enabled=1` and an encrypted token.
  - `claude-sessions.ts` — spawns `claude` with `-p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions`, parses newline-delimited JSON events (`system`/`assistant`/`user`/`result`), tracks per-turn state, and emits `chunk`/`turn-end`/`end`/`cleared` events consumed by the SSE route. Output is capped at 10 MB per session. Sessions are keyed by `todoId` (one live session per todo at a time).
  - `recurrence-generator.ts` — `computeNextFireAt` handles daily/weekdays/weekly/monthly with local-timezone anchoring. Missed fires from downtime catch up on the next tick because the query is `next_fire_at <= now`.

### Frontend (`apps/web`)

Vue 3 (Composition API, `<script setup>`), Pinia, Vue Router, Vite. No UI framework — styles are hand-written in `src/styles/` with CSS custom properties per theme (`workshop`/`dark`/`light`/`terminal`).

- `src/main.ts` — creates router with three routes (`/`, `/todo/:id`, `/settings`), initializes Pinia, applies persisted theme before mount.
- `src/api.ts` — single `request()` helper handles JSON + error unwrapping; `requestForm()` variant for multipart uploads (must NOT set `Content-Type` so fetch adds the boundary).
- `src/stores/` — Pinia stores per concern:
  - `todos.ts` — in-memory mirror of server list, filtered client-side via getters (`byStatus`, with source + search layered). Every mutating action **pushes an undo entry** with a `revert()` closure capturing the pre-mutation snapshot. `move()` and `reorderInColumn()` are optimistic (apply locally first, then sync).
  - `undo.ts` — bounded stack (20), consumed by `Ctrl+Z` handler in `App.vue` that skips when focus is in a text input.
  - `selection.ts` — `Set<number>` for bulk ops (shift+click range select on cards).
  - `pomodoro.ts` — client-owned timer; on end, the stats endpoint is refetched.
  - `views.ts` — saved filter combinations, persisted via `/api/settings`.
- `src/composables/useDueNotifications.ts` — polls every 5min and fires Web Notifications for overdue todos. Permission is **not** requested automatically (browsers block non-user-initiated prompts); the Command Palette action "Benachrichtigungen aktivieren" is the prompt path.
- `src/components/` — board columns, cards, snippet/attachment editors, Claude agent panel (subscribes to `/api/agent/session/:id/stream` via `EventSource`).

### Data model cheatsheet

- `todos.status`: `'todo' | 'in_progress' | 'test' | 'done'` — column labels are Handwerker-themed (`Werkbank`/`Unter Hammer`/`Prüfstand`/`Ablage`), see `STATUS_LABELS` in `types.ts`.
- `todos.source`: `'local' | 'github' | 'jira'` + `UNIQUE(source, source_ref)` so re-imports update instead of duplicating.
- `todos.position` — user-controlled within-column ordering; list query sorts by `(status, position, priority, updated_at DESC)`. Frontend mirrors this ordering in `reorderInColumn`.
- `integrations` — one row per provider; tokens encrypted, config as JSON blob.
- Child tables (`snippets`, `subtasks`, `attachments`, `pomodoro_sessions`) use `ON DELETE CASCADE` / `SET NULL` on `todo_id`.

### UI language

The product UI and user-facing strings are **German** (Werkbank, Unter Hammer, Ablage, "Rückgängig gemacht", etc.). Code, commits, and comments are English. Preserve existing German labels when editing UI strings.


NOTE:
Always commit after implementing !
Du startest keine Projekte selber forderst mich nur auf sie selber  zu starten etc. nur wenn ICH dich dazu bitte machst du das!