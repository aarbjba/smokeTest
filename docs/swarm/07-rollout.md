# Swarm — Implementierungs-Reihenfolge

## Prinzip

Jeder Schritt ist **alleine lauffähig und testbar**, bevor der nächste beginnt. Kein Schritt setzt einen unfertigen vorherigen Schritt voraus. Die Reihenfolge ist von Infra → Runtime → API → UI.

---

## Schritt 1 — Infra: Schema + DB-Service

**Aufwand: S** (2–4 Stunden)

**Dateien:**
```
apps/api/src/swarm-schemas.ts          ← neu anlegen
apps/api/src/services/swarm-db.ts     ← neu anlegen
apps/api/src/db.ts                    ← 2 neue Tabellen in initDb()
```

**Was zu tun ist:**

1. `swarm-schemas.ts`: `SwarmConfigSchema` (Zod) aus dem Architect-Code übernehmen und auf ESM-Imports umstellen. Kein Hono, kein SDK. Reine Zod-Definitionen + TypeScript-Typen.

2. `swarm-db.ts`:
   - `createRunDb(runId): Database` — legt `data/swarm-runs/`-Verzeichnis an, öffnet neue SQLite-DB, setzt WAL + foreign_keys + busy_timeout=5000, führt alle `CREATE TABLE IF NOT EXISTS`-Statements aus (aus `01-db-schema.md`), gibt offene DB-Instanz zurück.
   - `openRunDb(dbPath): Database` — öffnet bestehende Run-DB read-only oder read-write (Parameter).
   - `runDbPath(runId): string` — berechnet Pfad aus `DB_PATH`-Env.
   - `generateRunId(): string` — `run_${format(now)}_${uuid.slice(0,4)}`.

3. `db.ts`: `CREATE TABLE IF NOT EXISTS swarm_configs` und `swarm_runs` in `initDb()` nach den bestehenden Tabellen ergänzen.

**Akzeptanzkriterien:**
- `node -e "import('./apps/api/src/services/swarm-db.js').then(m => { const db = m.createRunDb('test'); console.log(db.pragma('journal_mode')); db.close(); })"` gibt `['wal']` aus
- `swarm_configs` und `swarm_runs` existieren in werkbank.db nach Server-Start
- `createRunDb` + sofortiges `openRunDb` gibt korrekte DB-Instanz zurück

---

## Schritt 2 — swarm-mcp Server

**Aufwand: M** (1 Tag)

**Dateien:**
```
apps/mcp/src/swarm-server.ts          ← neu anlegen
apps/mcp/package.json                 ← ggf. @modelcontextprotocol/sdk prüfen/ergänzen
```

**Was zu tun ist:**

1. Prüfen ob `@modelcontextprotocol/sdk` im `apps/mcp`-Workspace vorhanden (bestehender Werkbank-MCP nutzt es vermutlich). Falls nicht: `npm -w apps/mcp install @modelcontextprotocol/sdk`.

2. `swarm-server.ts` implementieren:
   - Env-Variablen lesen: `RUN_DB_PATH`, `RUN_ID`, `AGENT_IDS`
   - `better-sqlite3`-DB öffnen
   - Alle 7 Tools implementieren (Details in `02-swarm-mcp.md`):
     - `write_blackboard`, `read_blackboard`, `list_blackboard`
     - `send_to_peer`, `check_inbox`
     - `report_progress`, `terminate`
   - MCP-Server via stdio starten

3. `swarm-mcp-config.ts` (Services):
   - `buildSwarmMcpConfigFile(runId, agentId, allAgentIds, runDbPath): Promise<string>` — schreibt Temp-JSON, gibt Pfad zurück
   - `cleanupMcpConfigFile(path): void` — löscht Temp-Datei

**Akzeptanzkriterien:**
- `RUN_DB_PATH=/tmp/test.db RUN_ID=test AGENT_IDS=a,b npx mcp-inspector npx tsx apps/mcp/src/swarm-server.ts` zeigt 7 Tools
- `write_blackboard({ caller_id: "a", key: "test", value: "hello" })` → `{ ok: true, key: "test", version: 1 }`
- `read_blackboard({ caller_id: "a", key: "test" })` → `{ ok: true, value: "hello", version: 1 }`
- `write_blackboard` auf denselben Key zweimal → zweiter Eintrag hat `version: 2`, erster hat `is_current: 0`
- `send_to_peer({ caller_id: "a", to_agent: "b", payload: "{}" })` → Eintrag in `bus_messages` + `check_inbox({ caller_id: "b" })` gibt Nachricht zurück

---

## Schritt 3 — swarm-runtime + `POST /api/swarm/run`

**Aufwand: M** (1–2 Tage)

**Dateien:**
```
apps/api/src/services/swarm-runtime.ts   ← neu anlegen
apps/api/src/routes/swarm-runs.ts        ← neu anlegen (zunächst nur POST /run)
apps/api/src/index.ts                    ← swarm-runs-Router mounten
```

**Was zu tun ist:**

1. `swarm-runtime.ts`: `runSwarm()`, `spawnCoordinator()`, `handleCoordinatorLine()`, `emitAndStore()`, `renderCoordinatorPrompt()` implementieren (Details in `03-swarm-runtime.md`).

2. `swarm-runs.ts`: `POST /api/swarm/run` mit SSE-Streaming.

3. Demo-Config hartcodieren (für Tests ohne Architect):
   ```ts
   const DEMO_CONFIG: SwarmConfig = {
     goal: "Schreibe eine kurze Zusammenfassung über Quantum Computing",
     coordinators: [{
       id: "researcher",
       role: "Rechercheur",
       model: "sonnet",
       maxTurns: 5,
       systemPromptTemplate: "Du bist ein Rechercheur. Ziel: {{goal}}. Deine ID: {{id}}.",
       toolPermissions: { terminate: true, reportProgress: true, /* rest false */ },
       subagents: []
     }],
     globalTokenLimit: 100_000,
     timeoutMs: 120_000
   };
   ```

4. **Wichtig:** In diesem Schritt wird der MCP-Server noch **nicht** automatisch gestartet. Der erste Test ist ohne MCP (Coordinator hat keine swarm-Tools). Swarm-Tools kommen in Schritt 3b.

**Schritt 3b:** MCP-Config in `spawnCoordinator` integrieren — `buildSwarmMcpConfigFile()` aufrufen, `--mcp-config`-Flag in CLI-Args übergeben.

**Akzeptanzkriterien Schritt 3 (ohne MCP):**
- `curl -N -X POST http://localhost:3001/api/swarm/run -H 'Content-Type: application/json' -d '{"config": <DEMO_CONFIG>}'` streamt SSE
- Run-DB enthält nach Abschluss: `swarm:start`, `coordinator:start`, mind. 1 `coordinator:text`, `swarm:end`
- `swarm_runs`-Tabelle in Hauptdb enthält Eintrag mit `status='done'`

**Akzeptanzkriterien Schritt 3b (mit MCP):**
- Coordinator kann `report_progress` aufrufen → erscheint als `progress`-Event im SSE-Stream
- Coordinator kann `write_blackboard` aufrufen → erscheint als `blackboard_write`-Event + Eintrag in Run-DB

---

## Schritt 4 — Replay-Endpoints + Run-Liste

**Aufwand: S** (4–6 Stunden)

**Dateien:**
```
apps/api/src/routes/swarm-runs.ts   ← bestehend, weitere Endpoints ergänzen
```

**Was zu tun ist:**

1. `GET /api/swarm/runs` — Liste aus Hauptdb.
2. `GET /api/swarm/runs/:id` — Metadaten + Run-DB-Zusammenfassung.
3. `GET /api/swarm/runs/:id/replay` — Events als SSE mit speed-Parameter.
4. `GET /api/swarm/runs/:id/blackboard` — Snapshot, optional `at_ts`.
5. `GET /api/swarm/runs/:id/db` — Binary-Download.

**Akzeptanzkriterien:**
- `GET /api/swarm/runs` gibt JSON-Array zurück (nach Schritt 3 mind. 1 Eintrag)
- `GET /api/swarm/runs/:id/replay?speed=0` gibt alle Events sofort zurück (kein Timeout)
- `GET /api/swarm/runs/:id/blackboard` gibt korrekten aktuellen Snapshot zurück
- `GET /api/swarm/runs/:id/blackboard?at_ts=X` gibt Snapshot vor Zeitpunkt X zurück
- `GET /api/swarm/runs/:id/db` liefert valide SQLite-Datei (öffenbar mit `sqlite3`)

---

## Schritt 5 — Architect: MCP-Server + Route

**Aufwand: M** (1 Tag)

**Dateien:**
```
apps/mcp/src/architect-server.ts           ← neu anlegen
apps/api/src/routes/swarm-architect.ts     ← neu anlegen
apps/api/src/index.ts                      ← swarm-architect-Router mounten
apps/api/src/services/claude-sessions.ts   ← ARCHITECT_PREPROMPT + 'architect' Mode + swarm_propose_config / swarm_final_config Events
```

**Was zu tun ist:**

1. `architect-server.ts`: `propose_config`- und `finalize_config`-Tools implementieren (Details in `05-architect.md`).

2. `swarm-architect.ts`: `POST /api/swarm/architect/start`, `POST /api/swarm/architect/send`, `GET/POST/DELETE /api/swarm/configs` implementieren.

3. `claude-sessions.ts`:
   - `ARCHITECT_PREPROMPT`-Template ergänzen
   - `'architect'`-Mode in `getPreprompt()` ergänzen
   - In `handleJsonLine()`: bei `tool_use` mit `name === 'propose_config'` → zusätzliches `swarm_propose_config`-Event emittieren; bei `finalize_config` → `swarm_final_config`-Event.

**Akzeptanzkriterien:**
- `POST /api/swarm/architect/start { goal: "Marktanalyse" }` → Session startet, SSE-Stream läuft
- Architect stellt Fragen und ruft `propose_config` auf → `swarm_propose_config`-Event im Stream
- Nach User-Bestätigung: `finalize_config` → `swarm_final_config` + Eintrag in `swarm_configs`
- `GET /api/swarm/configs` listet gespeicherte Config auf
- `finalize_config` mit invalider Config → Validation-Error als Tool-Result (kein Session-Abbruch)

---

## Schritt 6 — Frontend: Vue-Views

**Aufwand: M** (1–2 Tage)

**Dateien:** Alle in `06-frontend.md` beschrieben.

**Reihenfolge innerhalb dieses Schritts:**

6a. **Stores + api.ts** — Daten-Layer zuerst, ohne UI
- `swarmArchitect.ts`, `swarmRuns.ts` anlegen
- `api.ts` um `swarm`-Namespace erweitern
- `types.ts` um Swarm-Typen erweitern

6b. **SwarmRunsView** — einfachste View (nur Liste + Status)
- Router-Route registrieren
- Runs laden und anzeigen
- Status-Badges, Token-Anzeige, Zeitstempel

6c. **SwarmReplayView** — Replay-Player
- Events laden (speed=0)
- Timeline-Liste
- Player-Controls (Play/Pause/Scrubber/Speed)
- Blackboard-Snapshot-Berechnung client-seitig
- Event-Detail-Panel

6d. **SwarmArchitectView** — Chat + Preview
- Chat-Interface (analog ClaudeAgent.vue)
- JSON-Preview via highlight.js
- EventSource-Verbindung

**Akzeptanzkriterien:**
- `/swarm` lädt ohne Fehler, zeigt Run-Liste
- Klick auf Run → `/swarm/runs/:id` → Replay-Player erscheint
- Play-Button startet Durchlauf, Events erscheinen in Timeline
- Scrubber springt zu beliebigem Event, Blackboard-Snapshot ändert sich
- `/swarm/architect` → Chat-Input funktioniert, JSON-Preview erscheint nach `propose_config`
- Nach `finalize_config` → "Gespeichert" + "Jetzt ausführen"-Button
- "Jetzt ausführen" → startet Run, wechselt zu Run-Ansicht mit Live-Stream

---

## Schritt 7 — Polish und Integration

**Aufwand: S** (4–6 Stunden)

**Was zu tun ist:**

1. **Navigation:** Swarm-Link in App-Navigation (`App.vue`)
2. **Settings:** Optional — Swarm-Abschnitt in `SettingsView.vue` (Model-Defaults, Token-Budget-Default)
3. **Fehlerbehandlung:**
   - Run-DB nicht gefunden → 404 mit klarer Meldung
   - Coordinator-Spawn-Fehler → `error`-Event im SSE-Stream, Run-Status `'error'`
   - Token-Budget überschritten → `swarm_end` mit `status='aborted'`, Hinweis-Text
4. **DB-Cleanup:** `DELETE /api/swarm/runs/:id` (optional, löscht Metadaten + DB-Datei)
5. **Typecheck-Durchlauf:** `npm run build` ohne Errors

**Akzeptanzkriterien:**
- Vollständiger End-to-End-Flow ohne manuelle Eingriffe:
  1. `/swarm/architect` → Interview → `finalize_config`
  2. "Jetzt ausführen" → Run startet, SSE-Events sichtbar
  3. Nach Run-Ende → `/swarm/runs/:id` → Replay vollständig abspielbar
  4. DB-Download liefert valide Datei
- `npm run build` gibt keine TypeScript-Errors

---

## Risiken und Mitigationen (pro Schritt)

| Schritt | Risiko | Mitigation |
|---|---|---|
| 1 | `data/swarm-runs/`-Verzeichnis-Anlegen schlägt fehl (Permissions) | `fs.mkdirSync(..., { recursive: true })` |
| 2 | `@modelcontextprotocol/sdk` stdio multi-client-Problem | Jeder Coordinator spawnt eigenen MCP-Prozess (N Prozesse, alle auf gleicher DB) — WAL-Mode + busy_timeout hält das aus |
| 2 | `mcp-inspector` nicht installiert | `npx @modelcontextprotocol/inspector` (kein globales Install nötig) |
| 3 | stream-json-Format hat sich geändert | `default`-Branch in `handleCoordinatorLine` — unbekannte Events werden ignoriert, kein Crash |
| 3 | Task-Tool-Tracking per toolUseId klappt nicht (ID-Format anders erwartet) | Fallback: Task-Tool-Calls als normale `tool_call`-Events behandeln (kein subagent:spawn/complete) |
| 4 | `at_ts`-Blackboard-Query gibt falsche Ergebnisse | Unit-Test mit bekannten Timestamps schreiben |
| 5 | `claude-sessions.ts`-Änderungen brechen bestehende Sessions | Nur additive Ergänzungen (neuer Mode, neue Event-Types); bestehende Modes unverändert |
| 6 | highlight.js für JSON-Preview zu langsam bei großen Configs | `maxLength`-Check: Configs über 10kB als plain `<pre>` ohne Highlighting |

---

## Gesamtüberblick

| Schritt | Aufwand | Kumulativ | Lauffähig nach Schritt |
|---|---|---|---|
| 1 — Infra Schema | S | 0.5 Tage | DB-Tests im REPL |
| 2 — swarm-mcp | M | 1.5 Tage | mcp-inspector |
| 3 — Runtime + POST /run | M | 3 Tage | curl → SSE-Stream |
| 4 — Replay-Endpoints | S | 3.5 Tage | curl → Events + Blackboard |
| 5 — Architect | M | 4.5 Tage | Architect-Chat via curl/Postman |
| 6 — Frontend | M | 6 Tage | Vollständig im Browser |
| 7 — Polish | S | 6.5 Tage | Production-ready |

**Gesamtaufwand: ca. 6–7 Arbeitstage (M gesamt)**
