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
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','test','done')),
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
  // Seed positions for existing rows so ordering is stable.
  db.exec(`
    UPDATE todos SET position = id WHERE position = 0;
  `);
  // Expand status CHECK to include 'test' if the existing schema predates it.
  migrateTodosStatusCheck();
  // Heal any DB where the earlier version of the above migration silently
  // rewrote child-table FKs to point at `todos_old`. No-op on clean DBs.
  repairDanglingTodosOldFks();

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
 * Rebuild the `todos` table if its CHECK constraint on `status` does not yet include 'test'.
 * SQLite cannot ALTER a CHECK constraint in place, so we clone, copy, drop, rename.
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
  if (row.sql.includes("'test'")) return; // already expanded

  // Gather all columns from the existing table so we copy them verbatim.
  const cols = db.prepare(`PRAGMA table_info(todos)`).all() as { name: string }[];
  const colList = cols.map((c) => c.name).join(', ');

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE todos RENAME TO todos_old`);
    db.exec(`
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','test','done')),
        priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 4),
        tags TEXT NOT NULL DEFAULT '[]',
        due_date TEXT,
        source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','github','jira')),
        source_ref TEXT,
        source_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_writeback_error TEXT,
        last_writeback_at TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source, source_ref)
      )
    `);
    db.exec(`INSERT INTO todos (${colList}) SELECT ${colList} FROM todos_old`);
    db.exec(`DROP TABLE todos_old`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_source ON todos(source)`);
    db.exec('COMMIT');
    console.log('[migration] todos table rebuilt with expanded status CHECK (test included)');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
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
