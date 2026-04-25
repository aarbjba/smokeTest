# Swarm — Express-Routen und SSE-Format

## Datei

```
apps/api/src/routes/swarm-runs.ts
```

Eingebunden in `apps/api/src/index.ts`:
```ts
import swarmRunsRouter from './routes/swarm-runs.js';
app.use('/api/swarm', swarmRunsRouter);
```

---

## SSE-Format (konsistent mit `agent.ts`)

Alle SSE-Endpunkte verwenden dasselbe Pattern wie der bestehende Agent-Stream:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Jedes Event:
```
event: <type>\n
data: <JSON>\n
\n
```

Heartbeat alle 30 Sekunden:
```
:keepalive\n
\n
```

---

## Endpunkte

### `POST /api/swarm/run`

Startet einen neuen Swarm-Run mit inline übergebener Config. Antwortet als SSE-Stream — die Verbindung bleibt offen, bis der Run abgeschlossen ist.

**Request Body:**
```ts
{
  config: SwarmConfig   // Vollständige Config (Zod-validiert)
}
```

**Alternative:** `POST /api/swarm/run/:configId` — startet aus gespeicherter Config (nächster Abschnitt).

**SSE-Events (in Reihenfolge):**

| Event-Name | Data-Payload | Wann |
|---|---|---|
| `swarm_start` | `{ runId, goal, coordinatorCount }` | Sofort beim Start |
| `coordinator_start` | `{ agentId, role, model }` | Pro Coordinator beim Spawn |
| `text` | `{ agentId, text }` | Textausgabe eines Coordinators |
| `tool_call` | `{ agentId, toolName, toolUseId, input }` | Tool-Aufruf |
| `tool_result` | `{ agentId, toolUseId, toolName, output, isError }` | Tool-Ergebnis |
| `subagent_spawn` | `{ agentId, toolUseId, promptExcerpt, parentId }` | Task-Tool-Aufruf |
| `subagent_complete` | `{ agentId, toolUseId, resultExcerpt, success }` | Task-Tool-Result |
| `blackboard_write` | `{ agentId, key, valueExcerpt, version }` | Blackboard-Write |
| `bus_message` | `{ from, to, kind, payloadExcerpt }` | Peer-Nachricht |
| `progress` | `{ agentId, message, percent? }` | report_progress-Tool |
| `tokens` | `{ agentId, inputTokens, outputTokens, cacheRead, cacheWrite }` | Pro Turn |
| `coordinator_end` | `{ agentId, exitCode, turnCount }` | Coordinator fertig |
| `swarm_end` | `{ runId, status, totalTokens, durationMs }` | Run vollständig beendet |
| `error` | `{ agentId?, message, detail? }` | Fehler (non-fatal) |

**Abort:** Wenn der Client die Verbindung schließt (`req.on('close')`), wird `abort.abort()` aufgerufen → alle Coordinator-PIDs werden via `treeKill` beendet, Run-Status wird `'aborted'`.

**Implementierungs-Skizze:**
```
1. Parse und validiere body.config via SwarmConfigSchema
2. AbortController anlegen
3. SSE-Header setzen, flushHeaders()
4. write-Hilfsfunktion definieren (identisch zu agent.ts)
5. runSwarm(config, (event) => write(event.type, event.data), abort.signal) aufrufen (nicht await)
6. req.on('close') → abort.abort()
7. Heartbeat-Interval starten
8. runSwarm-Promise auflösen → letztes 'swarm_end' wird über emitEvent gesendet → res.end()
```

---

### `POST /api/swarm/run/:configId`

Wie `POST /api/swarm/run`, aber Config aus `swarm_configs`-Tabelle laden.

**Path-Parameter:** `configId` — INTEGER, Referenz auf `swarm_configs.id`

**Verhalten:**
1. `SELECT config_json FROM swarm_configs WHERE id=?`
2. Falls nicht gefunden: 404
3. `JSON.parse(config_json)` + SwarmConfigSchema-Validierung
4. Weiter wie `POST /api/swarm/run`

---

### `GET /api/swarm/runs`

Liste aller Runs (Metadaten, ohne Run-DB zu öffnen).

**Query-Parameter:**
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `limit` | int | 20 | Max. Ergebnisse |
| `offset` | int | 0 | Pagination |
| `status` | string | — | Filter: `running\|done\|error\|aborted` |

**Response:**
```ts
{
  runs: Array<{
    id:               string,
    goal:             string,
    status:           string,
    coordinator_count: number,
    total_tokens:     number,
    started_at:       number,    // Unix ms
    ended_at:         number | null,
    error_message:    string | null
  }>,
  total: number
}
```

---

### `GET /api/swarm/runs/:id`

Vollständige Metadaten eines Runs plus Zusammenfassung aus Run-DB.

**Response:**
```ts
{
  run: {
    id, goal, status, coordinator_count, total_tokens,
    started_at, ended_at, error_message,
    config: SwarmConfig      // aus config_json deserialisiert
  },
  agents: Array<{
    id, role, model, kind, status, started_at, ended_at, error_msg
  }>,
  token_summary: Array<{
    agent_id, total_input, total_output, total_cache_read, total_cache_write
  }>,
  event_count: number,
  blackboard_key_count: number
}
```

**Öffnet die Run-DB** via `openRunDb(run.db_path)`. Falls DB-Datei fehlt (gelöscht/verschoben): 404 mit Hinweis.

---

### `GET /api/swarm/runs/:id/replay`

Streamt alle Events eines abgeschlossenen Runs als SSE zurück — mit zeitlichen Abständen für Replay-Effekt.

**Query-Parameter:**
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `speed` | float | 1.0 | Wiedergabe-Geschwindigkeit (1.0 = Echtzeit, 2.0 = doppelt so schnell, 0 = instant) |
| `from_ts` | int | 0 | Nur Events ab diesem Unix-ms-Timestamp |
| `agent_id` | string | — | Nur Events eines bestimmten Agents |
| `types` | string | — | Komma-getrennte Event-Typen, z.B. `text,blackboard_write` |

**Ablauf:**
```
1. Run aus Hauptdb laden, Run-DB öffnen
2. SELECT * FROM events WHERE ts >= from_ts [AND agent_id=?] [AND type IN (?)] ORDER BY ts ASC
3. Erster Event → sofort senden
4. Für jeden weiteren Event:
   delay_ms = (event.ts - prev.ts) / speed
   if speed <= 0: delay_ms = 0
   if delay_ms > 5000: delay_ms = 5000  (Pausen über 5s kappen)
   setTimeout → writeSSE(event)
5. Nach letztem Event: writeSSE('replay_end', { total_events: n })
```

**SSE-Events:** Identisch zu Live-Run-Events + `replay_end`.

**Wichtig:** `speed=0` sendet alle Events sofort (für programmatischen Zugriff / Tests). `speed=1` simuliert den echten Zeitverlauf.

---

### `GET /api/swarm/runs/:id/blackboard`

Aktueller Blackboard-Snapshot (alle `is_current=1`-Einträge).

**Query-Parameter:**
| Parameter | Typ | Beschreibung |
|---|---|---|
| `prefix` | string | Key-Präfix-Filter |
| `at_ts` | int | Snapshot zu einem bestimmten Zeitpunkt (letzter Wert vor diesem Timestamp) |

**`at_ts`-Implementierung:**
```sql
-- Letzter Wert eines Keys vor dem Zeitpunkt ts:
SELECT DISTINCT key,
  FIRST_VALUE(value) OVER (PARTITION BY key ORDER BY written_at DESC) as value,
  FIRST_VALUE(version) OVER (PARTITION BY key ORDER BY written_at DESC) as version
FROM blackboard
WHERE written_at <= :at_ts
```

**Response:**
```ts
{
  snapshot_at: number | null,   // at_ts oder null (aktuell)
  entries: Array<{
    key:       string,
    value:     string,
    version:   number,
    written_by: string,
    written_at: number
  }>
}
```

---

### `GET /api/swarm/runs/:id/db`

Download der Run-DB-Datei (SQLite binary). Für Power-User, die mit `sqlite3` direkt inspizieren wollen.

**Response:**
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="swarm-run-{id}.db"`
- Binary-Stream der DB-Datei via `fs.createReadStream`

**Sicherheitshinweis:** Kein Auth in Werkbank (Single-User, lokale App) — daher kein Problem. Bei Multi-User-Deployment würde dieser Endpoint Auth erfordern.

---

## `apps/api/src/routes/swarm-configs.ts` (Architect-Configs)

Separates Router-File für Config-Verwaltung (wird in `05-architect.md` vollständig beschrieben, hier nur die Mounts):

```
POST   /api/swarm/configs          ← Config speichern (vom Architect)
GET    /api/swarm/configs          ← Liste aller gespeicherten Configs
GET    /api/swarm/configs/:id      ← Einzelne Config
DELETE /api/swarm/configs/:id      ← Config löschen
```

Beide Router (`swarm-runs` und `swarm-configs`) können in einem File oder separat sein. Empfehlung: ein gemeinsames `swarm-runs.ts` für Run-Operationen, ein separates `swarm-architect.ts` für Architect-Chat + Config-Speicherung (→ `05-architect.md`).

---

## Mount in `index.ts`

```ts
// In apps/api/src/index.ts, nach den bestehenden Mounts:
import swarmRunsRouter    from './routes/swarm-runs.js';
import swarmArchitectRouter from './routes/swarm-architect.js';

app.use('/api/swarm', swarmRunsRouter);
app.use('/api/swarm', swarmArchitectRouter);
```

Kein Port-Konflikt, kein neuer Prozess — alles unter bestehenden `:3001`.

---

## Akzeptanzkriterien

- `curl -N -X POST http://localhost:3001/api/swarm/run -H 'Content-Type: application/json' -d '{"config":{...}}'` streamt SSE-Events
- Verbindungsabbruch während Run → Run-Status `'aborted'` in Hauptdb innerhalb von 5 Sekunden
- `GET /api/swarm/runs` gibt Liste zurück (leer ist ok)
- `GET /api/swarm/runs/:id/replay?speed=0` gibt alle Events sofort zurück
- `GET /api/swarm/runs/:id/blackboard?at_ts=X` gibt korrekten Snapshot zurück
- `GET /api/swarm/runs/:id/db` liefert binäre SQLite-Datei
