import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.cwd(), process.env.DB_PATH ?? './data/werkbank.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','test','done','pending')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 4),
      tags TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','github','jira')),
      source_ref TEXT,
      source_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, source_ref)
    );

    CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
    CREATE INDEX IF NOT EXISTS idx_todos_source ON todos(source);

    CREATE TABLE IF NOT EXISTS snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'markdown',
      content TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snippets_todo ON snippets(todo_id);

    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
      mode TEXT NOT NULL CHECK(mode IN ('work','break')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_pomodoro_todo ON pomodoro_sessions(todo_id);

    CREATE TABLE IF NOT EXISTS integrations (
      provider TEXT PRIMARY KEY CHECK(provider IN ('github','jira')),
      enabled INTEGER NOT NULL DEFAULT 0,
      token_enc TEXT,
      token_iv TEXT,
      token_tag TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      last_sync_at TEXT,
      last_sync_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      storage_name TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      kind TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('image','video','audio','pdf','text','archive','office','other')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_todo ON attachments(todo_id);

    CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON subtasks(todo_id);

    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_todo ON analyses(todo_id);

    CREATE TABLE IF NOT EXISTS repo_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('github','jira')),
      key TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, key)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_mappings_source_key ON repo_mappings(source, key);

    CREATE TABLE IF NOT EXISTS recurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 4),
      frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekdays','weekly','monthly')),
      time_of_day TEXT NOT NULL DEFAULT '08:00',
      next_fire_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recurrences_next ON recurrences(next_fire_at);

    CREATE TABLE IF NOT EXISTS swarm_configs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL DEFAULT '',
      goal        TEXT    NOT NULL,
      config_json TEXT    NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS swarm_runs (
      id                TEXT    PRIMARY KEY,
      config_id         INTEGER REFERENCES swarm_configs(id) ON DELETE SET NULL,
      config_json       TEXT    NOT NULL,
      goal              TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','done','error','aborted')),
      db_path           TEXT    NOT NULL,
      coordinator_count INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      started_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at          INTEGER,
      error_message     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_swarm_runs_started ON swarm_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swarm_runs_status  ON swarm_runs(status);

    CREATE TABLE IF NOT EXISTS coordinator_templates (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      name                   TEXT    NOT NULL UNIQUE,
      description            TEXT    NOT NULL DEFAULT '',
      role                   TEXT    NOT NULL,
      model                  TEXT    NOT NULL DEFAULT 'sonnet',
      max_turns              INTEGER NOT NULL DEFAULT 25,
      system_prompt_template TEXT    NOT NULL,
      tool_permissions       TEXT    NOT NULL DEFAULT '{}',
      created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      usage_count            INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subagent_templates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL UNIQUE,
      description   TEXT    NOT NULL DEFAULT '',
      prompt        TEXT    NOT NULL,
      model         TEXT    NOT NULL DEFAULT 'sonnet',
      tools         TEXT    NOT NULL DEFAULT '[]',
      output_schema TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      usage_count   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Lightweight migration: add columns that were added after the initial release.
  addColumnIfMissing('todos', 'last_writeback_error', 'TEXT');
  addColumnIfMissing('todos', 'last_writeback_at', 'TEXT');
  addColumnIfMissing('todos', 'position', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('todos', 'working_directory', 'TEXT');
  addColumnIfMissing('todos', 'claude_session_id', 'TEXT');
  // Soft-delete timestamp: NULL = active, ISO string = in Papierkorb.
  addColumnIfMissing('todos', 'deleted_at', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_deleted_at ON todos(deleted_at)`);
  // Per-todo MCP server overrides (JSON array). NULL = fall back to repo-root .mcp.json
  // or bundled defaults — see apps/api/src/services/claude-sessions.ts.
  addColumnIfMissing('todos', 'mcp_servers', 'TEXT');
  // Automation queue ("Warteschlange"): when queue_position is non-NULL the todo is waiting
  // to be picked up by the queue runner. queue_prompt is the editable user prompt that will
  // be handed to claudeSessions.start() once it's the todo's turn (same path the Details-page
  // "Run Claude" button uses). queue_attachment_ids is a JSON array of attachment IDs.
  // See apps/api/src/services/queue-runner.ts.
  addColumnIfMissing('todos', 'queue_position', 'INTEGER');
  addColumnIfMissing('todos', 'queue_prompt', 'TEXT');
  addColumnIfMissing('todos', 'queue_attachment_ids', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_queue_position ON todos(queue_position)`);
  // Analyse-mode artifact: subtasks flagged as suggestions awaiting accept/reject.
  addColumnIfMissing('subtasks', 'suggested', 'INTEGER NOT NULL DEFAULT 0');
  // Free-form description, edited inline in the subtask list. Optional; empty
  // string means "no extra notes" — UI hides the block when blank.
  addColumnIfMissing('subtasks', 'description', `TEXT NOT NULL DEFAULT ''`);
  // Link a subtask to an existing todo. When set, the subtask's `done` flag is
  // ignored at aggregate time and the linked todo's status='done' counts instead
  // (see TODO_LIST_SELECT in routes/todos.ts). FK uses ON DELETE SET NULL so a
  // deleted target turns the link into a regular standalone subtask. SQLite
  // honours REFERENCES on ALTER TABLE ADD COLUMN once foreign_keys=ON.
  addColumnIfMissing(
    'subtasks',
    'linked_todo_id',
    'INTEGER REFERENCES todos(id) ON DELETE SET NULL',
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_linked_todo ON subtasks(linked_todo_id)`);
  // Aufgabentyp: classifies the todo (feature/bug/chore/customer/research/other).
  // No CHECK constraint — validation happens in the Zod layer (schemas.ts) so we
  // can evolve the enum without schema rebuilds.
  addColumnIfMissing('todos', 'task_type', `TEXT NOT NULL DEFAULT 'other'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_task_type ON todos(task_type)`);
  // Per-todo preprompt override. When non-NULL this string replaces the
  // global preprompt template (settings key 'agent.preprompt') for this todo
  // only. Same {{placeholder}} syntax — see apps/api/src/services/claude-sessions.ts.
  addColumnIfMissing('todos', 'preprompt', 'TEXT');
  // Paths (relative to working_directory) the user has referenced in agent
  // prompts. JSON array of strings; NULL or '[]' means "none". Used by the
  // agent-panel path picker to show recently-used paths as quick chips.
  addColumnIfMissing('todos', 'saved_paths', 'TEXT');
  // Sandbox columns — per-todo overrides for the "In Sandbox starten" flow.
  // All nullable. Runtime state (sandbox_status, sandbox_pr_url) is validated
  // by Zod (SandboxStatusEnum), mirroring task_type's constraint-less column.
  addColumnIfMissing('todos', 'branch_name', 'TEXT');
  addColumnIfMissing('todos', 'base_branch', 'TEXT');
  addColumnIfMissing('todos', 'test_command', 'TEXT');
  addColumnIfMissing('todos', 'sandbox_status', 'TEXT');
  addColumnIfMissing('todos', 'sandbox_pr_url', 'TEXT');
  addColumnIfMissing('todos', 'sandbox_timeout_min', 'INTEGER');
  addColumnIfMissing('todos', 'sandbox_max_turns', 'INTEGER');
  // User-assignable sandbox target repo for locally-created todos that have
  // no source_ref. Format is `owner/name` (no #suffix). When set, wins over
  // source_ref in resolveRepoUrl so the user can sandbox a locally-created
  // todo against any configured GitHub repo.
  addColumnIfMissing('todos', 'sandbox_repo', 'TEXT');
  // Per-todo sandbox-backend override. NULL = use settings.sandbox.default_backend.
  // Validated by Zod (SandboxBackendEnum) — same constraint-less-column pattern
  // as task_type / sandbox_status, so adding a new backend later doesn't need
  // a schema rebuild.
  addColumnIfMissing('todos', 'sandbox_backend', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_sandbox_status ON todos(sandbox_status)`);
  // Sandbox default settings. Stored as JSON (parsed via JSON.parse throughout
  // — see claude-sessions.ts:296) so numbers stay numbers and strings keep
  // their quotes. INSERT OR IGNORE so user edits survive restart.
  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  insertSetting.run('sandbox.max_concurrent', '3');
  insertSetting.run('sandbox.image_tag', '"werkbank-sandbox:latest"');
  insertSetting.run('sandbox.docker_context', '"lp03"');
  insertSetting.run('sandbox.werkbank_public_url', '""');
  insertSetting.run('sandbox.default_timeout_min', '30');
  insertSetting.run('sandbox.default_max_turns', '40');
  insertSetting.run('sandbox.claude_model', '"claude-sonnet-4-5"');
  insertSetting.run('sandbox.git_author_name', '"claude-bot"');
  insertSetting.run('sandbox.git_author_email', '"claude-bot@users.noreply.github.com"');
  // Backend selector + AWS-microvm config. Defaults keep parity with the
  // shipped lp03 setup; the AWS keys are seeded with empty strings / sane
  // numbers so the AWS backend reports "not configured" instead of crashing
  // when the user hasn't filled them in. See services/sandbox-aws.ts.
  insertSetting.run('sandbox.default_backend', '"docker-lp03"');
  insertSetting.run('sandbox.aws.ssh_host', '""');
  insertSetting.run('sandbox.aws.ssh_key', '""');
  insertSetting.run('sandbox.aws.containerd_socket', '"/run/firecracker-containerd/containerd.sock"');
  insertSetting.run('sandbox.aws.runtime', '"aws.firecracker"');
  insertSetting.run('sandbox.aws.image_tag', '"werkbank-sandbox:latest"');
  insertSetting.run('sandbox.aws.pool_size', '2');
  insertSetting.run('sandbox.aws.per_vm_max', '3');
  insertSetting.run('sandbox.aws.werkbank_public_url', '""');
  insertSetting.run('sandbox.aws.repo_path', '"/opt/werkbank"');
  insertSetting.run('sandbox.aws.auth_volume', '"werkbank-claude-auth"');
  // Seed positions for existing rows so ordering is stable.
  db.exec(`
    UPDATE todos SET position = id WHERE position = 0;
  `);
  // Expand status CHECK to include 'test' if the existing schema predates it.
  migrateTodosStatusCheck();
  // Heal any DB where the earlier version of the above migration silently
  // rewrote child-table FKs to point at `todos_old`. No-op on clean DBs.
  repairDanglingTodosOldFks();
  // Seed default coordinator and subagent templates (INSERT OR IGNORE — safe to re-run).
  seedDefaultTemplates();

  const providers = db.prepare<{ provider: string }[], { count: number }>(
    `SELECT COUNT(*) AS count FROM integrations`
  ).get() as { count: number } | undefined;
  if (!providers || providers.count === 0) {
    const insert = db.prepare(
      `INSERT INTO integrations (provider, enabled, config) VALUES (?, 0, ?)`
    );
    insert.run('github', JSON.stringify({ repos: [] }));
    insert.run('jira', JSON.stringify({ baseUrl: '', email: '', jql: 'assignee = currentUser() AND statusCategory != Done' }));
  }
}

export function touchUpdatedAt(table: string, id: number) {
  db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

function addColumnIfMissing(table: string, column: string, typeDecl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
}

/**
 * Rebuild the `todos` table if its CHECK constraint on `status` is missing any
 * of the currently supported statuses (`test`, `pending`). SQLite cannot ALTER
 * a CHECK constraint in place, so we clone, copy, drop, rename.
 *
 * Crucially, we set `PRAGMA legacy_alter_table = 1` around the RENAME. Without
 * it, SQLite's "modern" ALTER TABLE behavior automatically rewrites foreign
 * key references in OTHER tables to point at the renamed name. So renaming
 * `todos → todos_old` would silently rewrite `attachments.todo_id` FKs to
 * reference `todos_old`, and after we drop `todos_old` those FKs point into
 * the void — causing any later INSERT on the child table to fail with
 * "no such table: main.todos_old". Legacy mode keeps the FK definitions in
 * child tables pointing at the name `todos` throughout.
 */
function migrateTodosStatusCheck() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todos'`).get() as { sql: string } | undefined;
  if (!row) return;
  // Short-circuit when every supported status is already listed. Add new
  // statuses here when the enum grows.
  if (row.sql.includes("'test'") && row.sql.includes("'pending'")) return;

  // Derive the NEW DDL from the EXISTING one: only the CHECK on `status` is
  // rewritten. This preserves every column (including the ones added via
  // addColumnIfMissing — working_directory, sandbox_*, etc.) so the subsequent
  // INSERT...SELECT has matching source/target shapes. Hard-coding a base
  // schema here would drop all post-release columns on any DB that wasn't
  // freshly created.
  const currentDdl = row.sql;
  const newDdl = currentDdl.replace(
    /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i,
    `CHECK(status IN ('todo','in_progress','test','done','pending'))`,
  );
  if (newDdl === currentDdl) {
    throw new Error('[migration] could not rewrite status CHECK — unexpected todos DDL shape');
  }
  // Swap the target table name so the temporary table we create is called
  // `todos_new`; we'll rename it into place after copying the data.
  const newDdlForTemp = newDdl.replace(/^CREATE\s+TABLE\s+todos\b/i, 'CREATE TABLE todos_new');
  if (newDdlForTemp === newDdl) {
    throw new Error('[migration] could not target temp table name — unexpected todos DDL shape');
  }

  // Column list for the copy step: must match source; SQLite doesn't care
  // about column order as long as names are given explicitly.
  const cols = db.prepare(`PRAGMA table_info(todos)`).all() as { name: string }[];
  const colList = cols.map((c) => c.name).join(', ');

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');
  db.exec('BEGIN');
  try {
    db.exec(newDdlForTemp);
    db.exec(`INSERT INTO todos_new (${colList}) SELECT ${colList} FROM todos`);
    db.exec(`DROP TABLE todos`);
    db.exec(`ALTER TABLE todos_new RENAME TO todos`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_source ON todos(source)`);
    db.exec('COMMIT');
    console.log('[migration] todos table rebuilt with expanded status CHECK (test + pending included)');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}

function seedDefaultTemplates() {
  const insertCoord = db.prepare(`
    INSERT OR IGNORE INTO coordinator_templates
      (name, description, role, model, max_turns, system_prompt_template, tool_permissions)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSub = db.prepare(`
    INSERT OR IGNORE INTO subagent_templates
      (name, description, prompt, model, tools, output_schema)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // ── Coordinator templates ──────────────────────────────────────────────────

  insertCoord.run(
    'Research Lead',
    'Coordinates parallel research subagents, synthesizes findings',
    'Research Lead',
    'sonnet',
    30,
    `Du bist der Research Lead für das Ziel: {{goal}}

Deine ID: {{id}}. Peers: {{peer_ids}}. Run: {{run_id}}.

## Deine Aufgabe
Als Research Lead koordinierst du 3–5 spezialisierte Forschungs-Subagents, die PARALLEL arbeiten. Deine Aufgabe ist es, Teilaufgaben zu definieren, Subagents zu spawnen, Ergebnisse zu sammeln und eine fundierte Gesamtsynthese zu erstellen.

## Arbeitsablauf
1. Analysiere das Ziel und teile es in 3–5 unabhängige Forschungsfragen auf.
2. Spawne alle Subagents GLEICHZEITIG (nicht nacheinander) — jeder bekommt eine klare Forschungsfrage.
3. Warte, bis alle Ergebnisse auf dem Blackboard erscheinen (key="result/<topic>").
4. Lese alle Ergebnisse: read_blackboard(prefix="result/").
5. Schreibe die Synthese: write_blackboard(key="summary", value=<JSON-Zusammenfassung>).
6. Rufe report_progress(message="Synthese abgeschlossen", percent=100) auf.
7. Rufe terminate(reason="Forschungsziel erreicht: <kurze Beschreibung>") auf.

## Regeln
- Spawne Subagents PARALLEL — warte NICHT, bis einer fertig ist, bevor du den nächsten startest.
- Schreibe strukturiertes JSON auf das Blackboard, kein Freitext.
- Rufe report_progress(percent=N) bei jedem Meilenstein auf (nach Spawn: 20%, nach Sammeln: 80%, nach Synthese: 100%).
- Terminiere NUR wenn das Hauptziel wirklich erreicht ist.
- Loop-Prevention: Wenn du dieselbe Aktion dreimal ohne Fortschritt ausgeführt hast, terminiere mit Fehlergrund.
- Blackboard-Key-Format: "result/<topic>" für Teilresultate, "summary" für Gesamtsynthese.`,
    JSON.stringify({ spawnSubagents: true, writeBlackboard: true, readBlackboard: true, listBlackboard: true, reportProgress: true, terminate: true, sendToPeer: false, checkInbox: false }),
  );

  insertCoord.run(
    'Code Review Lead',
    'Orchestrates thorough code review across multiple dimensions',
    'Code Review Lead',
    'sonnet',
    20,
    `Du bist der Code Review Lead für das Ziel: {{goal}}

Deine ID: {{id}}. Peers: {{peer_ids}}. Run: {{run_id}}.

## Deine Aufgabe
Du orchestrierst einen gründlichen Code-Review über mehrere Dimensionen (Sicherheit, Performance, Wartbarkeit, Tests). Jede Dimension wird von einem spezialisierten Subagent geprüft.

## Arbeitsablauf
1. Analysiere den Review-Scope aus dem Ziel (PR-Nummer, Branch, Dateipfade).
2. Spawne PARALLEL: Security-Reviewer, Performance-Reviewer, Maintainability-Reviewer, Test-Coverage-Reviewer.
3. Sammle Ergebnisse vom Blackboard (key="review/<dimension>").
4. Konsolidiere alle Findings: write_blackboard(key="review/consolidated", value=<JSON>).
5. Schreibe Gesamturteil: write_blackboard(key="summary", value={verdict, critical_count, warning_count, summary_text}).
6. terminate(reason="Code Review abgeschlossen").

## Regeln
- Jeder Subagent bewertet nur SEINE Dimension — kein Overlap.
- Format für Findings: {dimension, findings: [{severity: "critical"|"warning"|"info", file, line, message}]}.
- Kritische Findings (severity="critical") müssen explizit im Summary erscheinen.
- Loop-Prevention: Nach 3 erfolglosen Versuchen mit Fehler terminieren.`,
    JSON.stringify({ spawnSubagents: true, writeBlackboard: true, readBlackboard: true, listBlackboard: true, reportProgress: true, terminate: true, sendToPeer: false, checkInbox: false }),
  );

  insertCoord.run(
    'Market Analysis Lead',
    'Drives structured market research with specialized subagents',
    'Market Analysis Lead',
    'sonnet',
    30,
    `Du bist der Market Analysis Lead für das Ziel: {{goal}}

Deine ID: {{id}}. Peers: {{peer_ids}}. Run: {{run_id}}.

## Deine Aufgabe
Du steuerst eine strukturierte Marktanalyse mit spezialisierten Subagents für Marktgröße, Wettbewerb, technische Machbarkeit und Finanzmodellierung.

## Arbeitsablauf
1. Parse das Ziel: Identifiziere Produkt/Markt, Zielgruppe, geografischen Fokus.
2. Spawne PARALLEL: Market-Size-Analyst, Competitor-Analyst, Tech-Feasibility-Analyst, Financial-Analyst.
3. Optional: Spawne Risk-Analyst nach Eingang der ersten Ergebnisse.
4. Sammle alle Ergebnisse (Blackboard-Keys: "result/market_size", "result/competitors", "result/tech_feasibility", "result/financials", "result/risks").
5. Schreibe Executive Summary: write_blackboard(key="summary", value={market_size, top_competitors, feasibility, revenue_potential, key_risks, recommendation}).
6. terminate(reason="Marktanalyse abgeschlossen").

## Output-Format (summary)
{
  market_size: { tam_usd: number, sam_usd: number, cagr_percent: number },
  top_competitors: [{ name, market_share_percent, key_differentiator }],
  feasibility: "low" | "medium" | "high",
  revenue_potential_usd_y3: number,
  key_risks: [string],
  recommendation: "proceed" | "pivot" | "abandon",
  recommendation_rationale: string
}

## Regeln
- Spawne Subagents PARALLEL. Warte nicht auf einzelne Ergebnisse bevor du andere startest.
- Loop-Prevention: Nach 3 erfolglosen Iterationen terminieren.`,
    JSON.stringify({ spawnSubagents: true, writeBlackboard: true, readBlackboard: true, listBlackboard: true, reportProgress: true, terminate: true, sendToPeer: true, checkInbox: true }),
  );

  insertCoord.run(
    'Synthesis Lead',
    'Collects outputs from peers and synthesizes into final report',
    'Synthesis Lead',
    'sonnet',
    15,
    `Du bist der Synthesis Lead für das Ziel: {{goal}}

Deine ID: {{id}}. Peers: {{peer_ids}}. Run: {{run_id}}.

## Deine Aufgabe
Du wartest auf Ergebnisse von anderen Coordinators (via Blackboard) und synthetisierst sie in einen finalen, strukturierten Report.

## Arbeitsablauf
1. Liste alle vorhandenen Blackboard-Einträge: list_blackboard().
2. Lese alle relevanten Einträge (prefix="result/").
3. Prüfe ob alle erwarteten Ergebnisse vorhanden sind. Falls nicht: warte kurz und prüfe erneut (max. 3 Versuche).
4. Erstelle den finalen Report: write_blackboard(key="final_report", value=<strukturierter JSON-Report>).
5. report_progress(message="Finaler Report erstellt", percent=100).
6. terminate(reason="Synthese abgeschlossen").

## Report-Format
{
  goal: string,
  executive_summary: string,
  key_findings: [{ topic: string, finding: string, confidence: "low"|"medium"|"high" }],
  recommendations: [{ priority: number, action: string, rationale: string }],
  data_sources: [string],
  generated_at: ISO-timestamp
}

## Regeln
- Fasse ALLE vorhandenen Ergebnisse ein — lasse keine aus.
- Priorisiere Empfehlungen nach Impact (1 = höchste Priorität).
- Loop-Prevention: Nach 3 Blackboard-Checks ohne neue Daten terminieren.`,
    JSON.stringify({ spawnSubagents: false, writeBlackboard: true, readBlackboard: true, listBlackboard: true, reportProgress: true, terminate: true, sendToPeer: true, checkInbox: true }),
  );

  // ── Subagent templates ─────────────────────────────────────────────────────

  insertSub.run(
    'Web Research Analyst',
    'Searches and analyzes web sources for a specific topic',
    `Du bist ein Web Research Analyst. Du erhältst einen Forschungsauftrag und lieferst strukturierte Ergebnisse.

## INPUT
Du erhältst im User-Prompt:
- topic: Das zu recherchierende Thema
- focus: Spezifische Fragen oder Aspekte (optional)
- context: Übergeordnetes Projektziel (optional)

## AUFGABE
1. Suche nach 3–5 relevanten, vertrauenswürdigen Quellen zum Thema.
2. Extrahiere die wichtigsten Fakten, Zahlen und Erkenntnisse.
3. Beurteile die Qualität und Aktualität der Quellen.
4. Identifiziere Wissenslücken oder widersprüchliche Informationen.

## OUTPUT (JSON — exakt dieses Format)
{
  "topic": "<Thema>",
  "key_findings": [
    { "finding": "<Kernaussage>", "source": "<URL oder Titel>", "confidence": "high|medium|low" }
  ],
  "statistics": [
    { "metric": "<Kennzahl>", "value": "<Wert>", "source": "<Quelle>", "year": <Jahr> }
  ],
  "gaps": ["<Wissenslücke 1>", "<Wissenslücke 2>"],
  "sources_quality": "high|medium|low",
  "summary": "<2–3 Sätze Zusammenfassung>"
}

## REGELN
- Maximal 8 Turns. Sei präzise und faktisch.
- Keine Spekulationen ohne klare Kennzeichnung (confidence: "low").
- Gib NUR das JSON-Objekt als finale Antwort aus (kein Markdown-Wrapper).`,
    'sonnet',
    JSON.stringify(['WebSearch', 'WebFetch']),
    null,
  );

  insertSub.run(
    'Competitor Analyst',
    'Competitive landscape analysis for a product or market',
    `Du bist ein Competitive Intelligence Analyst. Du analysierst das Wettbewerbsumfeld für ein gegebenes Produkt oder einen Markt.

## INPUT
Du erhältst im User-Prompt:
- product_or_market: Das Produkt/der Markt, der analysiert werden soll
- geography: Geografischer Fokus (z.B. "DACH", "global", "USA")
- num_competitors: Anzahl der zu analysierenden Wettbewerber (default: 5)

## AUFGABE
1. Identifiziere die 5 direkten Hauptwettbewerber.
2. Analysiere für jeden: Produkt, Pricing, Stärken/Schwächen, Marktposition.
3. Identifiziere Differenzierungsmerkmale und Marktlücken.

## OUTPUT (JSON — exakt dieses Format)
{
  "market": "<Markt/Produkt>",
  "competitors": [
    {
      "name": "<Name>",
      "website": "<URL>",
      "founded": <Jahr>,
      "funding_usd": <Betrag oder null>,
      "market_position": "leader|challenger|niche|new_entrant",
      "key_product": "<Hauptprodukt>",
      "pricing_model": "<Modell>",
      "strengths": ["<Stärke>"],
      "weaknesses": ["<Schwäche>"],
      "differentiator": "<einzigartiges Merkmal>"
    }
  ],
  "market_gaps": ["<Lücke>"],
  "competitive_intensity": "low|medium|high",
  "summary": "<2–3 Sätze>"
}

## REGELN
- Maximal 6 Turns. Nur verifizierbare Fakten.
- Fehlende Daten als null markieren, nicht schätzen.`,
    'sonnet',
    JSON.stringify(['WebSearch', 'WebFetch']),
    null,
  );

  insertSub.run(
    'Tech Feasibility Analyst',
    'Assesses technical viability of an idea or approach',
    `Du bist ein Technical Feasibility Analyst. Du bewertest die technische Machbarkeit einer Idee oder eines Ansatzes.

## INPUT
Du erhältst im User-Prompt:
- idea: Die zu bewertende Idee oder technische Lösung
- constraints: Bekannte Einschränkungen (Budget, Zeit, Team-Größe)
- tech_stack: Vorhandener/bevorzugter Tech-Stack (optional)

## AUFGABE
1. Zerlege die Idee in technische Kernkomponenten.
2. Bewerte jede Komponente nach Machbarkeit, Reifegrad der benötigten Technologien und Build-vs-Buy.
3. Schätze den Entwicklungsaufwand (Wochen/Monate).
4. Identifiziere die größten technischen Risiken.

## OUTPUT (JSON — exakt dieses Format)
{
  "idea": "<Idee>",
  "overall_feasibility": "low|medium|high",
  "components": [
    {
      "name": "<Komponente>",
      "feasibility": "low|medium|high",
      "tech_maturity": "experimental|emerging|mature",
      "build_vs_buy": "build|buy|open_source",
      "complexity": "low|medium|high"
    }
  ],
  "estimated_months": { "min": <Zahl>, "max": <Zahl> },
  "team_size_recommended": <Zahl>,
  "top_risks": [
    { "risk": "<Risiko>", "impact": "low|medium|high", "mitigation": "<Maßnahme>" }
  ],
  "key_dependencies": ["<Abhängigkeit>"],
  "recommendation": "<1–2 Sätze Empfehlung>"
}

## REGELN
- Maximal 5 Turns. Faktenbasiert, keine Hype-Sprache.
- Bei "low" feasibility: konkrete Begründung angeben.`,
    'sonnet',
    JSON.stringify(['WebSearch']),
    null,
  );

  insertSub.run(
    'Financial Analyst',
    'Financial modeling and market size estimation',
    `Du bist ein Financial Analyst. Du erstellst Finanzmodelle und Marktgrößenschätzungen für Geschäftsideen.

## INPUT
Du erhältst im User-Prompt:
- business: Geschäftsmodell/Produkt
- market_data: Bereits bekannte Marktdaten (optional, z.B. vom Market-Size-Subagent)
- assumptions: Annahmen oder Einschränkungen

## AUFGABE
1. Schätze TAM (Total Addressable Market), SAM (Serviceable Addressable Market), SOM (Serviceable Obtainable Market).
2. Modelliere 3-Jahres-Revenue-Prognose (konservativ / realistisch / optimistisch).
3. Schätze wichtige Unit Economics (CAC, LTV, Payback Period).
4. Berechne Break-Even-Punkt.

## OUTPUT (JSON — exakt dieses Format)
{
  "business": "<Geschäftsmodell>",
  "market_size": {
    "tam_usd": <Zahl>,
    "sam_usd": <Zahl>,
    "som_usd": <Zahl>,
    "methodology": "<Berechnungsansatz>"
  },
  "revenue_projection": {
    "year1": { "conservative": <Zahl>, "realistic": <Zahl>, "optimistic": <Zahl> },
    "year2": { "conservative": <Zahl>, "realistic": <Zahl>, "optimistic": <Zahl> },
    "year3": { "conservative": <Zahl>, "realistic": <Zahl>, "optimistic": <Zahl> }
  },
  "unit_economics": {
    "cac_usd": <Zahl>,
    "ltv_usd": <Zahl>,
    "ltv_cac_ratio": <Zahl>,
    "payback_months": <Zahl>
  },
  "breakeven_months": <Zahl>,
  "key_assumptions": ["<Annahme>"],
  "confidence": "low|medium|high",
  "notes": "<Wichtige Einschränkungen der Schätzung>"
}

## REGELN
- Maximal 5 Turns. Alle Zahlen in USD.
- Konservative Schätzung = 30% unter realistisch, Optimistisch = 50% über realistisch.
- Fehlende Daten explizit als Annahme kennzeichnen.`,
    'sonnet',
    JSON.stringify(['WebSearch']),
    null,
  );

  insertSub.run(
    'Risk Analyst',
    'Identifies risks and mitigation strategies',
    `Du bist ein Risk Analyst. Du identifizierst und bewertest Risiken für Geschäftsideen oder Projekte und entwickelst Mitigationsstrategien.

## INPUT
Du erhältst im User-Prompt:
- subject: Das zu analysierende Projekt/Produkt/Vorhaben
- context: Relevante Hintergrundinformationen (optional, z.B. Competitor- oder Tech-Ergebnisse)
- risk_categories: Zu prüfende Risikoarten (optional; default: alle)

## AUFGABE
1. Analysiere Risiken in diesen Kategorien: Market, Technical, Regulatory, Financial, Operational, Reputational.
2. Bewerte jedes Risiko nach Wahrscheinlichkeit und Impact.
3. Entwickle konkrete Mitigationsstrategien für High-Priority-Risiken.
4. Erstelle eine Risk-Matrix.

## OUTPUT (JSON — exakt dieses Format)
{
  "subject": "<Projekt/Produkt>",
  "risks": [
    {
      "category": "market|technical|regulatory|financial|operational|reputational",
      "risk": "<Risikobeschreibung>",
      "probability": "low|medium|high",
      "impact": "low|medium|high",
      "priority": "low|medium|high|critical",
      "mitigation": "<Maßnahme>",
      "early_warning": "<Frühindikator>"
    }
  ],
  "top_3_risks": ["<Risiko 1>", "<Risiko 2>", "<Risiko 3>"],
  "overall_risk_level": "low|medium|high|critical",
  "go_no_go_recommendation": "go|conditional_go|no_go",
  "summary": "<2–3 Sätze Gesamtbewertung>"
}

## REGELN
- Maximal 5 Turns. Faktenbasiert, keine Panikmache.
- Priority = "critical" wenn Probability=high UND Impact=high.
- Mindestens 5 Risiken, maximal 15.`,
    'sonnet',
    JSON.stringify(['WebSearch']),
    null,
  );

  insertSub.run(
    'Summarizer',
    'Distills long content into structured key points',
    `Du bist ein Summarizer. Du kondensierst längere Inhalte in strukturierte, kompakte Zusammenfassungen.

## INPUT
Du erhältst im User-Prompt:
- content: Der zu zusammenfassende Text oder eine URL
- focus: Worauf die Zusammenfassung fokussieren soll (optional)
- output_length: "short" (3–5 Punkte) | "medium" (5–10 Punkte) | "long" (10–15 Punkte)

## AUFGABE
1. Extrahiere die wichtigsten Kernaussagen.
2. Identifiziere Handlungsempfehlungen (falls vorhanden).
3. Erkenne offene Fragen oder Widersprüche.

## OUTPUT (JSON — exakt dieses Format)
{
  "title": "<Titel oder Thema>",
  "one_liner": "<Ein Satz der den gesamten Inhalt beschreibt>",
  "key_points": [
    { "point": "<Kernaussage>", "importance": "high|medium|low" }
  ],
  "action_items": ["<Handlungsempfehlung>"],
  "open_questions": ["<Offene Frage>"],
  "sentiment": "positive|neutral|negative|mixed",
  "word_count_original": <Zahl oder null>
}

## REGELN
- Maximal 3 Turns. Prägnant und klar.
- Keine eigenen Meinungen oder Wertungen hinzufügen.
- Bei URLs: Inhalt zuerst fetchen, dann zusammenfassen.`,
    'haiku',
    JSON.stringify(['WebFetch']),
    null,
  );
}

/**
 * Self-heal databases where the earlier (broken) migration silently rewrote FKs
 * on child tables from `todos` to `todos_old`. Detects the exact symptom — a
 * table.sql text containing `REFERENCES "todos_old"` — and rebuilds the
 * affected tables with FKs pointing back to `todos`.
 *
 * Safe to run on clean DBs: does nothing if no broken FK is found.
 */
function repairDanglingTodosOldFks() {
  const broken = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table'
         AND sql LIKE '%REFERENCES "todos_old"%'`,
    )
    .all() as Array<{ name: string; sql: string }>;
  if (broken.length === 0) return;

  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const { name, sql } of broken) {
      const fixedSql = sql
        .replace(/REFERENCES "todos_old"/g, 'REFERENCES todos')
        .replace(new RegExp(`CREATE TABLE "?${name}"?`), `CREATE TABLE ${name}_new`);
      // Copy columns from the existing table.
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      const colList = cols.map((c) => c.name).join(', ');
      db.exec(fixedSql);
      db.exec(`INSERT INTO ${name}_new (${colList}) SELECT ${colList} FROM ${name}`);
      db.exec(`DROP TABLE ${name}`);
      db.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`);
    }
    const violations = db.prepare(`PRAGMA foreign_key_check`).all();
    if (violations.length > 0) {
      throw new Error(`FK violations after repair: ${JSON.stringify(violations)}`);
    }
    db.exec('COMMIT');
    console.log(`[migration] repaired FK references on ${broken.map((b) => b.name).join(', ')}`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
