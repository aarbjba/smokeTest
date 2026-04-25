# Swarm — Datenbank-Schema

## Zwei Datenbankebenen

| Datenbank | Pfad | Zweck |
|---|---|---|
| **Hauptdatenbank** | `apps/api/data/werkbank.db` | Metadaten: Config-Liste, Run-Liste, Status |
| **Run-DB** | `apps/api/data/swarm-runs/{runId}.db` | Vollständige Run-Daten: Events, Blackboard, Bus, Tokens |

Die Trennung ist bewusst: Die Hauptdb bleibt kompakt und immer verfügbar. Die Run-DBs können groß werden (viele Events, große Blackboard-Werte) und sind pro Run isoliert — ein korrupter Run gefährdet nicht die Werkbank-Hauptdaten.

---

## Teil 1: Ergänzungen in der Hauptdatenbank (`werkbank.db`)

### `swarm_configs`

Gespeicherte Architect-Konfigurationen. Werden beim `finalize_config`-Tool-Call angelegt.

```sql
CREATE TABLE IF NOT EXISTS swarm_configs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL DEFAULT '',
  goal        TEXT    NOT NULL,
  config_json TEXT    NOT NULL,      -- vollständige SwarmConfig als JSON
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**Hinweis:** `config_json` enthält das gesamte validierte `SwarmConfig`-Objekt. Schema-Version ist implizit durch App-Version. Kein separates Versions-Feld nötig — bei Breaking Changes wird eine Migration in `db.ts` per `addColumnIfMissing` oder Rebuild ergänzt (wie im Rest der Werkbank).

### `swarm_runs`

Metadaten-Eintrag pro Run. Erlaubt das Auflisten aller Runs ohne Run-DB zu öffnen.

```sql
CREATE TABLE IF NOT EXISTS swarm_runs (
  id            TEXT    PRIMARY KEY,  -- UUID, z.B. "run_2024-01-15_abc123"
  config_id     INTEGER REFERENCES swarm_configs(id) ON DELETE SET NULL,
  config_json   TEXT    NOT NULL,     -- Snapshot der Config zum Run-Zeitpunkt (config_id kann später gelöscht werden)
  goal          TEXT    NOT NULL,     -- Denormalisiert aus config für schnelles Anzeigen
  status        TEXT    NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','done','error','aborted')),
  db_path       TEXT    NOT NULL,     -- absoluter Pfad zur Run-DB-Datei
  coordinator_count INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,  -- aktualisiert bei Run-Ende
  started_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at      INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_swarm_runs_started ON swarm_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_runs_status  ON swarm_runs(status);
```

**Warum `config_json` doppelt?** Die Config wird als Snapshot gespeichert, damit ein Replay immer die exakt verwendete Config zeigen kann, auch wenn `swarm_configs(config_id)` später gelöscht wird.

---

## Teil 2: Run-DB-Schema (`{runId}.db`)

Wird von `swarm-db.ts::createRunDb()` bei Runstart angelegt. WAL-Mode ist Pflicht.

### Setup (wird vor allen CREATE-Statements ausgeführt)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;   -- WAL + NORMAL ist sicher und schneller als FULL
```

---

### `agents`

Coordinator- und Subagent-Einträge. Jeder Coordinator wird beim Spawn eingetragen.

```sql
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT    PRIMARY KEY,   -- z.B. "coordinator-market", "subagent-abc123"
  parent_id   TEXT    REFERENCES agents(id) ON DELETE SET NULL,  -- für Subagents
  role        TEXT    NOT NULL DEFAULT '',   -- aus CoordinatorConfig.role
  model       TEXT    NOT NULL DEFAULT '',   -- z.B. "claude-opus-4-7"
  kind        TEXT    NOT NULL DEFAULT 'coordinator'
              CHECK(kind IN ('coordinator', 'subagent')),
  status      TEXT    NOT NULL DEFAULT 'running'
              CHECK(status IN ('running','terminated','error')),
  started_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),  -- ms
  ended_at    INTEGER,
  error_msg   TEXT,
  exit_code   INTEGER
);
```

**Warum ms-Timestamps?** Events werden im ms-Bereich erzeugt. Subsecond-Präzision ist für die Replay-Timeline wichtig (Sortierung, Zeitabstände).

---

### `events`

**Der Kern des Replay-Systems.** Jedes beobachtbare Ereignis landet hier. Die Tabelle ist append-only — niemals UPDATE oder DELETE.

```sql
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT    NOT NULL,             -- welcher Coordinator/Subagent
  type        TEXT    NOT NULL,             -- Event-Typ (siehe unten)
  data        TEXT    NOT NULL DEFAULT '{}', -- JSON-Payload, typ-spezifisch
  ts          INTEGER NOT NULL,             -- Unix ms (vom Parsing-Zeitpunkt)
  seq         INTEGER NOT NULL             -- monoton steigend pro agent_id (für Lücken-Erkennung)
);

CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts ASC);
CREATE INDEX IF NOT EXISTS idx_events_agent   ON events(agent_id, ts ASC);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type, ts ASC);
```

#### Event-Typen und ihre `data`-Payloads

| `type` | `data`-Felder | Auslöser |
|---|---|---|
| `swarm:start` | `{goal, coordinator_count, config_snapshot}` | Runstart |
| `swarm:end` | `{status, total_tokens, duration_ms}` | Runende |
| `coordinator:start` | `{id, role, model, system_prompt_length}` | Coordinator gespawnt |
| `coordinator:text` | `{text}` | Textblock aus stream-json |
| `coordinator:tool_call` | `{tool_name, tool_use_id, input}` | tool_use Block |
| `coordinator:tool_result` | `{tool_use_id, tool_name, output, is_error}` | tool_result Block |
| `coordinator:terminate` | `{reason}` | terminate MCP-Tool |
| `coordinator:error` | `{message, exit_code}` | Prozess-Fehler |
| `coordinator:end` | `{exit_code, turn_count}` | Prozess beendet |
| `subagent:spawn` | `{tool_use_id, prompt_excerpt, parent_id}` | Task-Tool-Call erkannt |
| `subagent:complete` | `{tool_use_id, result_excerpt, success}` | Task-Tool-Result erkannt |
| `blackboard:write` | `{key, value_excerpt, version}` | write_blackboard MCP-Tool |
| `blackboard:read` | `{key, found}` | read_blackboard MCP-Tool (optional, für Debugging) |
| `bus:message` | `{from, to, kind, payload_excerpt, hop_count}` | send_to_peer MCP-Tool |
| `progress` | `{message, percent}` | report_progress MCP-Tool |
| `tokens` | `{input_tokens, output_tokens, cache_read, cache_write}` | result-Event aus stream-json |

**Hinweis zu `_excerpt`-Feldern:** Lange Payloads werden auf 500 Zeichen gekürzt, um die Events-Tabelle kompakt zu halten. Vollständige Daten stehen in `blackboard` bzw. `bus_messages`.

---

### `blackboard`

Der gemeinsame Schreib-/Leseraum aller Coordinators. Append-with-version statt Update.

```sql
CREATE TABLE IF NOT EXISTS blackboard (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL,
  value       TEXT    NOT NULL,      -- JSON oder plain text
  version     INTEGER NOT NULL DEFAULT 1,
  written_by  TEXT    NOT NULL,      -- agent_id
  written_at  INTEGER NOT NULL,      -- Unix ms
  is_current  INTEGER NOT NULL DEFAULT 1  -- 0 = überschrieben
);

-- Schnelles Lesen des aktuellen Werts für einen Key
CREATE INDEX IF NOT EXISTS idx_blackboard_key_current ON blackboard(key, is_current);
-- Vollständige History für Replay
CREATE INDEX IF NOT EXISTS idx_blackboard_key_version ON blackboard(key, version ASC);
```

**Warum nicht einfach UPDATE?** Versionierte History ist die Basis für den Blackboard-Snapshot-zu-Zeitpunkt-X im Replay. Mit `is_current` kann man schnell den neuesten Wert lesen (`WHERE key=? AND is_current=1`) und trotzdem die History abrufen (`WHERE key=? ORDER BY version`).

**Read-Vorgang:** `SELECT value FROM blackboard WHERE key=? AND is_current=1` — O(1) via Index.

**Write-Vorgang (transaktional):**
```sql
UPDATE blackboard SET is_current=0 WHERE key=? AND is_current=1;
INSERT INTO blackboard (key, value, version, written_by, written_at, is_current)
  VALUES (?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM blackboard WHERE key=?), ?, ?, 1);
```

---

### `bus_messages`

Alle Inter-Coordinator-Nachrichten (vollständige Payloads, nicht nur Excerpts).

```sql
CREATE TABLE IF NOT EXISTS bus_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id      TEXT    NOT NULL UNIQUE,  -- UUID, für Deduplizierung
  from_agent  TEXT    NOT NULL,
  to_agent    TEXT    NOT NULL,          -- Coordinator-ID oder 'broadcast'
  kind        TEXT    NOT NULL DEFAULT 'send'
              CHECK(kind IN ('send', 'request', 'reply')),
  payload     TEXT    NOT NULL,          -- vollständiges JSON
  reply_to    TEXT    REFERENCES bus_messages(msg_id) ON DELETE SET NULL,
  hop_count   INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER NOT NULL,          -- Unix ms
  delivered   INTEGER NOT NULL DEFAULT 0  -- 0/1
);

CREATE INDEX IF NOT EXISTS idx_bus_to_agent ON bus_messages(to_agent, delivered);
CREATE INDEX IF NOT EXISTS idx_bus_from     ON bus_messages(from_agent, sent_at);
```

---

### `tokens`

Granulares Token-Tracking pro Turn und pro Agent. Summiert in `swarm_runs.total_tokens`.

```sql
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
```

---

### Pfad-Konvention

```
apps/api/data/
  werkbank.db                    ← Hauptdatenbank
  swarm-runs/
    run_20240115_143022_abc1.db  ← Format: run_{YYYYMMDD}_{HHMMSS}_{4-char-uuid}
    run_20240115_150301_def2.db
    ...
```

Run-ID-Format: `run_${date}_${time}_${randomUUID().slice(0,4)}`

Die Run-DB liegt im gleichen Verzeichnis wie die Hauptdb (bestimmt durch `DB_PATH`-Env). `swarm-runs/`-Unterverzeichnis wird beim ersten Run angelegt.

---

### Migrations-Strategie (Hauptdb)

Neue Tabellen werden in `apps/api/src/db.ts::initDb()` per `CREATE TABLE IF NOT EXISTS` hinzugefügt — identisch zum bestehenden Pattern. Keine neuen `addColumnIfMissing`-Calls nötig, da die Tabellen komplett neu sind.

### Cleanup-Strategie (Run-DBs)

Run-DBs werden standardmäßig **nicht** gelöscht. Geplant: optionaler Cleanup-Endpoint `DELETE /api/swarm/runs/:id` (löscht Metadaten-Eintrag + DB-Datei). Kein automatischer Cleanup in Phase 1.

---

## Akzeptanzkriterien

- `createRunDb(runId)` legt eine valide DB an, alle Tabellen vorhanden, WAL aktiv (`PRAGMA journal_mode` gibt `'wal'` zurück)
- `SELECT * FROM events ORDER BY ts` gibt Events in korrekter Reihenfolge zurück
- Blackboard-Write + sofortiger Read gibt den geschriebenen Wert zurück
- Blackboard-History (alle Versionen eines Keys) ist vollständig abrufbar
- Simultaner Zugriff: Hauptprozess schreibt in `swarm_runs`, MCP-Server schreibt in Run-DB — kein Deadlock, kein `SQLITE_BUSY` (WAL-Mode gewährleistet das)
