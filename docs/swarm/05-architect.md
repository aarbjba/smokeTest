# Swarm — Architect-Route und UI

## Entscheidung: CLI vs. direkte Anthropic-API

### Frage
Der Architect ist ein interaktiver Interview-Agent mit zwei spezifischen Tools (`propose_config`, `finalize_config`). Soll er via Claude CLI laufen (konsistent mit Werkbank) oder direkt via `@anthropic-ai/sdk` (einfacher für strukturierte Tool-Use-Loops)?

### Analyse

| Aspekt | CLI-Ansatz | SDK-Ansatz |
|---|---|---|
| **Konsistenz** | ✅ Identisch zum Rest der Werkbank | ❌ Neues Dependency + Auth-Modell |
| **Multi-Turn** | ✅ `--resume`-Mechanismus vorhanden | ✅ `messages`-Array manuell verwalten |
| **Tool-Use-Kontrolle** | ✅ MCP-Server definiert erlaubte Tools explizit | ✅ Direkt in API-Call definiert |
| **propose_config Live-Preview** | ✅ Tool-Call erscheint im stream-json | ✅ Tool-Use im Stream |
| **API-Key** | ❌ Kein KEY nötig (CLI autht selbst) | ❌ `ANTHROPIC_API_KEY` in .env nötig |
| **Streaming** | ✅ Gleicher SSE-Parser wie Executor | ✅ SDK hat eigenen Streaming-Support |
| **Aufwand** | ✅ MCP-Server schreiben (1 neues File) | M SDK installieren + Streaming-Wrapper |
| **Debugbarkeit** | ✅ `claude` direkt im Terminal testbar | M Separates Test-Setup |

### Entscheidung: **CLI-Ansatz**

Begründung: Der Architect braucht nichts, was der CLI nicht kann. Ein kleiner `architect-mcp`-Server mit zwei Tools ist einfacher als ein neues SDK-Dependency mit eigenem Auth-Modell. Die `claude-sessions.ts`-Infrastruktur nimmt Multi-Turn und SSE-Streaming bereits ab.

---

## Komponenten

```
apps/api/src/routes/swarm-architect.ts   ← Express-Routen
apps/mcp/src/architect-server.ts         ← MCP-Server mit propose/finalize Tools
apps/api/src/services/swarm-db.ts        ← (bereits: swarm_configs-Tabelle in Hauptdb)
```

---

## `architect-server.ts` — MCP-Tools

### Setup

Läuft als separater Prozess (wie `swarm-server.ts`). Wird in den Architect-Spawn via `--mcp-config` gemountet.

Umgebungsvariablen:
| Variable | Beschreibung |
|---|---|
| `MAIN_DB_PATH` | Absoluter Pfad zur Werkbank-Hauptdb (werkbank.db) |
| `ARCHITECT_SESSION_ID` | Session-ID des laufenden Architect-Talks (für Zuordnung) |

### Tool: `propose_config`

Wird aufgerufen, wenn der Architect dem User einen Zwischenstand zeigen will — noch nicht final, noch änderbar.

**Input:**
```ts
{
  partial_config: object    // Partial<SwarmConfig> — beliebig unvollständig
}
```

**Ablauf:**
1. `partial_config` als JSON serialisieren
2. Kein DB-Schreiben — nur als SSE-Event weitergeben
3. Das Event erscheint im stream-json als `tool_use`-Block; `swarm-architect.ts` erkennt `toolName === 'propose_config'` und emittiert ein spezielles SSE-Event

**Output:** `{ ok: true, preview_shown: true }`

**Hinweis:** Der Architect ruft dieses Tool proaktiv auf — nicht nur wenn der User ausdrücklich fragt. Jede signifikante Config-Änderung im Interview löst einen `propose_config`-Call aus.

### Tool: `finalize_config`

Wird aufgerufen, wenn der User die Config abgesegnet hat.

**Input:**
```ts
{
  config: object,      // Vollständige SwarmConfig — wird gegen Schema validiert
  name?:  string       // Optionaler Name für die gespeicherte Config
}
```

**Ablauf:**
1. `SwarmConfigSchema.parse(config)` — wirft bei Validierungsfehler
2. Bei Validierungsfehler: Fehler als Tool-Result zurückgeben (kein throw) — Architect kann die Config korrigieren
3. Bei Erfolg:
   - `INSERT INTO swarm_configs (name, goal, config_json) VALUES (...)` in Hauptdb
   - Gibt `{ ok: true, config_id: number, config: validatedConfig }` zurück
4. `swarm-architect.ts` erkennt `toolName === 'finalize_config'` im stream-json und emittiert `final_config`-SSE-Event mit `config_id` und der validierten Config

**Output:** `{ ok: true, config_id: number }` oder `{ ok: false, validation_errors: ZodError['issues'] }`

---

## `swarm-architect.ts` — Express-Routen

### `POST /api/swarm/architect/start`

Startet eine neue Architect-Session (neuer Claude CLI Prozess).

**Request Body:**
```ts
{
  goal?: string    // Optional: initiales Ziel, das der Architect in seinem ersten Turn bekommt
}
```

**Ablauf:**
1. Nutzt `claudeSessions.start()` aus der bestehenden `claude-sessions.ts`
2. Übergabe eines speziellen Architect-Systemprompts (→ Architect-Preprompt-Template, s.u.)
3. `mode: 'architect'` (neuer Mode neben 'work'/'analyse'/'sandbox')
4. MCP-Config enthält `architect-mcp` (mit `MAIN_DB_PATH` und `ARCHITECT_SESSION_ID`)
5. Response: `{ todoId: ARCHITECT_SESSION_TODO_ID, sessionStarted: true }`

**Hinweis zu `todoId`:** Der Architect braucht keine Zuordnung zu einem echten Todo. Empfehlung: Spezieller fiktiver `todoId=-1` oder ein echtes "Meta-Todo" (z.B. `source='local', title='Swarm Architect Session'`). Klarer ist ein eigener Session-Key ohne Todo-Bezug — aber das erfordert Umbau von `claude-sessions.ts`. **Einfachste Lösung:** Ein temporäres Todo anlegen (`title='Swarm Architect', status='todo'`), Session daran hängen, nach Abschluss löschen.

### `POST /api/swarm/architect/send`

Sendet eine User-Nachricht an die laufende Architect-Session.

**Request Body:**
```ts
{
  todoId:  number,   // Die Todo-ID der Architect-Session
  message: string
}
```

Delegiert direkt an `claudeSessions.send(todoId, message, [])`. Keine Sonderbehandlung nötig — der bestehende SSE-Stream (`/api/agent/session/:todoId/stream`) liefert die Antwort.

### `GET /api/swarm/architect/stream/:todoId`

**Kein neuer Endpoint.** Der bestehende `/api/agent/session/:todoId/stream` liefert alle Events. `swarm-architect.ts` muss die Route nicht neu implementieren.

**Sonderbehandlung von propose_config und finalize_config:**
- In `handleJsonLine` (claude-sessions.ts) wird für `toolName === 'propose_config'` bzw. `'finalize_config'` ein semantisches Event emittiert
- Alternativer Weg: `swarm-architect.ts` hört auf den `claudeSessions`-EventEmitter und emittiert eigene SSE-Events auf einem separaten Stream-Endpoint

**Empfehlung:** Erweitern der bestehenden SSE-Infrastruktur — wenn `tool_use` mit `name in ['propose_config', 'finalize_config']` erkannt wird, emittiert `claude-sessions.ts` zusätzlich ein `swarm_propose_config`- bzw. `swarm_final_config`-Event. Das Frontend konsumiert beide aus demselben Stream.

### `POST /api/swarm/configs`

Speichert eine Config manuell (z.B. wenn User die finalize_config-Validierung übergehen will).

**Request Body:** `{ name?: string, config: SwarmConfig }`

**Ablauf:** SwarmConfigSchema validieren → `INSERT INTO swarm_configs`

### `GET /api/swarm/configs`

Liste aller gespeicherten Configs.

**Response:** `{ configs: Array<{ id, name, goal, created_at, updated_at }> }`

### `GET /api/swarm/configs/:id`

Einzelne Config mit vollständigem `config_json`.

### `DELETE /api/swarm/configs/:id`

Löscht gespeicherte Config. Laufende Runs, die diese Config verwenden, sind nicht betroffen (Run hat eigenen `config_json`-Snapshot).

---

## Architect-Systemprompt-Template

Wird in `claude-sessions.ts` als `ARCHITECT_PREPROMPT` neben `DEFAULT_PREPROMPT`, `ANALYSE_PREPROMPT`, `SANDBOX_PREPROMPT` definiert.

**Inhalt (Skizze):**
```
Du bist ein Swarm-Architect. Deine Aufgabe ist es, durch strukturiertes Interview eine SwarmConfig zu erstellen.

Workflow:
1. Verstehe das Ziel des Users
2. Schlage Coordinator-Rollen vor (nicht stupide fragen — mach konkrete Vorschläge)
3. Rufe propose_config() auf, sobald du genug für einen ersten Entwurf weißt
4. Verfeinere im Dialog
5. Wenn User zustimmt: rufe finalize_config() auf

Config-Schema (Zod):
{{schema_description}}

Regeln:
- Maximal 3-4 Coordinators für die meisten Aufgaben
- Subagent-Namen müssen lowercase-kebab-case sein (Regex: /^[a-z][a-z0-9-]{2,40}$/)
- systemPromptTemplate muss {{goal}}, {{id}}, {{peer_ids}} enthalten
- Erkläre deine Vorschläge kurz — der User soll verstehen, warum du so strukturierst

{{user_goal}}
```

`{{schema_description}}` wird aus `SwarmConfigSchema.describe()` oder einem statisch formulierten deutschen Text befüllt.
`{{user_goal}}` wird mit dem initialen Ziel aus dem Request-Body befüllt (oder leer).

---

## Sequenz: Kompletter Architect-Flow

```
1. User öffnet /swarm/architect
2. User gibt Ziel ein: "Ich will eine Marktanalyse für Produkt X"
3. Frontend: POST /api/swarm/architect/start { goal: "Marktanalyse für Produkt X" }
4. Backend: legt Temp-Todo an, startet claude mit ARCHITECT_PREPROMPT + propose_config/finalize_config MCP-Tools
5. Frontend: subscribt zu /api/agent/session/:todoId/stream (EventSource)
6. Architect: stellt Fragen, macht Vorschläge
   → SSE: event: chunk → wird im Chat angezeigt
7. Architect: ruft propose_config({ coordinators: [...] }) auf
   → SSE: event: swarm_propose_config, data: { partial_config: {...} }
   → Frontend: aktualisiert JSON-Preview-Panel rechts
8. User: "Der zweite Coordinator kann weg"
9. Frontend: POST /api/swarm/architect/send { todoId, message: "Der zweite Coordinator kann weg" }
10. Architect: überarbeitet, ruft propose_config erneut auf → Preview aktualisiert sich
11. User: "Gut so"
12. Architect: ruft finalize_config({ config: {...}, name: "Marktanalyse v1" }) auf
    → MCP-Server validiert, schreibt in swarm_configs, gibt config_id zurück
    → SSE: event: swarm_final_config, data: { config_id: 3, config: {...} }
    → Frontend: zeigt "Config gespeichert (ID 3)" + Buttons: "Direkt ausführen" / "Zurück zur Liste"
13. User klickt "Direkt ausführen"
    → Frontend: POST /api/swarm/run/3 (startet Run mit configId=3)
```

---

## Risiken

1. **Temp-Todo-Lifecycle:** Wenn der Architect-Tab geschlossen wird, bleibt das Temp-Todo in der DB. Mitigation: Tag `swarm_architect` auf dem Todo, Cleanup via `DELETE FROM todos WHERE title LIKE 'Swarm Architect%' AND updated_at < unixepoch()-3600`.

2. **propose_config mit ungültigem Schema:** Der Architect könnte `propose_config` mit einer Config aufrufen, die nicht vollständig gültig ist (das ist gewollt — Preview auch für Teilkonfigs). Frontend muss das robust handhaben (keine Zod-Validierung auf dem Preview-Panel nötig — zeigt rohen JSON).

3. **finalize_config Validierungsfehler:** Wenn die Config ungültig ist, bekommt der Architect den Fehler als Tool-Result zurück und kann korrigieren. Das muss im Systemprompt erklärt sein.

---

## Akzeptanzkriterien

- `POST /api/swarm/architect/start` liefert `{ todoId: N }`, SSE-Stream beginnt
- Architect stellt nach `{ goal: "test" }` mindestens eine Frage und ruft `propose_config` auf
- `propose_config`-Tool-Call erscheint im SSE-Stream als `swarm_propose_config`-Event
- `finalize_config` mit valider Config schreibt Eintrag in `swarm_configs` und emittiert `swarm_final_config`
- `finalize_config` mit invalider Config gibt Validierungsfehler zurück (kein 500, kein Session-Abbruch)
- `GET /api/swarm/configs` listet gespeicherte Configs auf
