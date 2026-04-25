import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DB_DIR = resolve(
  process.cwd(),
  dirname(process.env.DB_PATH ?? './data/werkbank.db'),
);
const SWARM_RUNS_DIR = join(DB_DIR, 'swarm-runs');

export function runDbPath(runId: string): string {
  return join(SWARM_RUNS_DIR, `${runId}.db`);
}

export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const suffix = randomBytes(2).toString('hex');
  return `run_${date}_${time}_${suffix}`;
}

const RUN_DB_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS agents (
    id         TEXT    PRIMARY KEY,
    parent_id  TEXT    REFERENCES agents(id) ON DELETE SET NULL,
    role       TEXT    NOT NULL DEFAULT '',
    model      TEXT    NOT NULL DEFAULT '',
    kind       TEXT    NOT NULL DEFAULT 'coordinator'
               CHECK(kind IN ('coordinator','subagent')),
    status     TEXT    NOT NULL DEFAULT 'running'
               CHECK(status IN ('running','terminated','error')),
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    error_msg  TEXT,
    exit_code  INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT    NOT NULL,
    type     TEXT    NOT NULL,
    data     TEXT    NOT NULL DEFAULT '{}',
    ts       INTEGER NOT NULL,
    seq      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts ASC);
  CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, ts ASC);
  CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type, ts ASC);

  CREATE TABLE IF NOT EXISTS blackboard (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    written_by TEXT    NOT NULL,
    written_at INTEGER NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_blackboard_key_current ON blackboard(key, is_current);
  CREATE INDEX IF NOT EXISTS idx_blackboard_key_version ON blackboard(key, version ASC);

  CREATE TABLE IF NOT EXISTS bus_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id     TEXT    NOT NULL UNIQUE,
    from_agent TEXT    NOT NULL,
    to_agent   TEXT    NOT NULL,
    kind       TEXT    NOT NULL DEFAULT 'send'
               CHECK(kind IN ('send','request','reply')),
    payload    TEXT    NOT NULL,
    reply_to   TEXT    REFERENCES bus_messages(msg_id) ON DELETE SET NULL,
    hop_count  INTEGER NOT NULL DEFAULT 0,
    sent_at    INTEGER NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_bus_to_agent ON bus_messages(to_agent, delivered);
  CREATE INDEX IF NOT EXISTS idx_bus_from     ON bus_messages(from_agent, sent_at);

  CREATE TABLE IF NOT EXISTS tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT    NOT NULL,
    turn_index    INTEGER NOT NULL DEFAULT 0,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    recorded_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_agent ON tokens(agent_id);
`;

export function createRunDb(runId: string): Database.Database {
  mkdirSync(SWARM_RUNS_DIR, { recursive: true });
  const path = runDbPath(runId);
  const db = new Database(path);
  db.exec(RUN_DB_SCHEMA);
  return db;
}

export function openRunDb(dbPath: string, readonly = false): Database.Database {
  return new Database(dbPath, { readonly });
}
