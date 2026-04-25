# Swarm — Runtime (`swarm-runtime.ts`)

## Zweck

`swarm-runtime.ts` ist der Kern des Executors. Es:
1. Nimmt eine validierte `SwarmConfig` entgegen
2. Legt die Run-DB an
3. Spawnt alle Coordinators als Claude-CLI-Subprocesses
4. Parst deren stream-json-Output in typisierte `SwarmEvent`s
5. Schreibt alle Events in die Run-DB
6. Leitet Events gleichzeitig an den SSE-Stream weiter
7. Tracked Token-Verbrauch und beendet den Run sauber

---

## Datei-Übersicht

```
apps/api/src/services/
  swarm-runtime.ts        ← dieser Plan
  swarm-db.ts             ← Run-DB anlegen/öffnen (Schema in 01-db-schema.md)
  swarm-mcp-config.ts     ← --mcp-config JSON bauen
```

---

## Typen

### `SwarmEvent` (Union)

Alle Events, die aus dem Runtime nach außen (SSE, DB) gehen:

```ts
// Konzeptuell — kein Code
type SwarmEvent =
  | { type: 'swarm:start';           data: { runId, goal, coordinatorCount } }
  | { type: 'swarm:end';             data: { status, totalTokens, durationMs } }
  | { type: 'coordinator:start';     data: { agentId, role, model } }
  | { type: 'coordinator:text';      data: { agentId, text } }
  | { type: 'coordinator:tool_call'; data: { agentId, toolName, toolUseId, input } }
  | { type: 'coordinator:tool_result'; data: { agentId, toolUseId, toolName, output, isError } }
  | { type: 'coordinator:terminate'; data: { agentId, reason? } }
  | { type: 'coordinator:error';     data: { agentId, message, exitCode? } }
  | { type: 'coordinator:end';       data: { agentId, exitCode, turnCount } }
  | { type: 'subagent:spawn';        data: { agentId, toolUseId, promptExcerpt, parentId } }
  | { type: 'subagent:complete';     data: { agentId, toolUseId, resultExcerpt, success } }
  | { type: 'blackboard:write';      data: { agentId, key, valueExcerpt, version } }
  | { type: 'bus:message';           data: { from, to, kind, payloadExcerpt, hopCount } }
  | { type: 'progress';              data: { agentId, message, percent? } }
  | { type: 'tokens';                data: { agentId, inputTokens, outputTokens, cacheRead, cacheWrite } }
  | { type: 'error';                 data: { agentId?, message, detail? } }
```

**Hinweis:** `blackboard:write`, `bus:message` und `progress` werden aus dem stream-json der Coordinators extrahiert — nämlich als `coordinator:tool_call`-Events mit spezifischen Tool-Namen. Der Runtime erkennt diese Tool-Namen und emittiert zusätzlich das semantische Event.

### `RunContext`

Gemeinsamer Zustand eines laufenden Runs:

```ts
interface RunContext {
  runId:        string;
  db:           Database;                    // Run-DB (better-sqlite3)
  mainDb:       Database;                    // Werkbank Hauptdb
  config:       SwarmConfig;
  emitEvent:    (event: SwarmEvent) => void; // SSE-Callback vom Route-Handler
  abort:        AbortController;
  coordinatorPids: Map<string, number>;      // agentId → PID (für Kill)
  seqCounters:  Map<string, number>;         // agentId → letzter seq-Wert
  pendingToolUseIds: Map<string, string>;    // toolUseId → toolName (für Task-Matching)
}
```

---

## Funktionen

### `runSwarm(config, emitEvent, signal?)`

**Signatur:**
```ts
async function runSwarm(
  config:     SwarmConfig,            // bereits validiert durch SwarmConfigSchema
  emitEvent:  (e: SwarmEvent) => void,
  signal?:    AbortSignal
): Promise<{ runId: string; status: 'done' | 'error' | 'aborted' }>
```

**Ablauf:**

```
1. Generiere runId = "run_${timestamp}_${uuid4chars}"
2. createRunDb(runId) → Run-DB anlegen
3. INSERT INTO swarm_runs (Hauptdb) mit status='running'
4. Alle Coordinator-IDs vorab sammeln (aus config.coordinators[].id)
5. emitEvent({ type: 'swarm:start', ... })
6. INSERT INTO events (Run-DB): swarm:start
7. Timeout: setTimeout → abort.abort() nach config.timeoutMs
8. Promise.allSettled(config.coordinators.map(c => spawnCoordinator(c, ctx)))
9. Timeout clearen
10. Status berechnen: 'done' wenn alle Coordinators ok, 'error' wenn einer fehlschlug, 'aborted' wenn abort.signal.aborted
11. Tokens summieren: SELECT SUM(input_tokens + output_tokens) FROM tokens (Run-DB)
12. UPDATE swarm_runs SET status=..., ended_at=..., total_tokens=... (Hauptdb)
13. INSERT INTO events: swarm:end
14. emitEvent({ type: 'swarm:end', ... })
15. db.close() (Run-DB)
16. return { runId, status }
```

**Abort-Handling:** Wenn `signal.aborted` vor Schritt 8, direkt zu Schritt 10 springen. Wenn Abort während laufender Coordinators: `abort.abort()` triggert in `spawnCoordinator` ein `treeKill()` für jeden laufenden PID.

---

### `spawnCoordinator(coordConfig, ctx)`

**Signatur:**
```ts
async function spawnCoordinator(
  coordConfig: CoordinatorConfig,
  ctx:         RunContext
): Promise<void>
```

**Ablauf:**

```
1. agentId = coordConfig.id
2. systemPrompt = renderCoordinatorPrompt(coordConfig, ctx)
3. mcpConfigPath = buildSwarmMcpConfig(ctx.runId, agentId, ctx.config.coordinators.map(c=>c.id))
   → schreibt Temp-JSON, gibt Pfad zurück
4. INSERT INTO agents (Run-DB): {id, role, model, kind='coordinator', status='running', started_at}
5. emitEvent({ type: 'coordinator:start', data: { agentId, role: coordConfig.role, model: coordConfig.model } })
6. INSERT INTO events: coordinator:start

7. Spawn claude CLI:
   args = [
     '-p',
     '--input-format', 'stream-json',
     '--output-format', 'stream-json',
     '--verbose',
     '--dangerously-skip-permissions',
     '--model', MODEL_IDS[coordConfig.model],
     '--mcp-config', mcpConfigPath,
   ]
   options = { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'], ... }

8. PID in ctx.coordinatorPids.set(agentId, child.pid)

9. Ersten Turn senden (systemPrompt als user-Message):
   child.stdin.write(JSON.stringify({ type:'user', message:{ role:'user', content: systemPrompt } }) + '\n')

10. stdout → line-by-line via stdoutBuffer + '\n'-Split → handleCoordinatorLine(agentId, line, ctx)

11. stderr → sammeln (für Fehler-Logs, kein SSE-Event)

12. ctx.abort.signal.addEventListener('abort', () => treeKill(child.pid))

13. await new Promise<void>((resolve, reject) => {
      child.on('close', (exitCode) => {
        ctx.coordinatorPids.delete(agentId)
        handleCoordinatorClose(agentId, exitCode, ctx)
        resolve()
      })
      child.on('error', (err) => {
        handleCoordinatorError(agentId, err, ctx)
        resolve()  // kein reject — Promise.allSettled soll alle abwarten
      })
    })

14. Temp-MCP-Config-Datei löschen
```

---

### `handleCoordinatorLine(agentId, rawLine, ctx)`

Parst eine stream-json-Zeile vom Claude CLI. Dies ist die kritischste Funktion.

**Ablauf:**

```
1. JSON.parse(rawLine) → falls Fehler: ignorieren (manche Zeilen sind kein JSON)

2. switch(parsed.type):

   case 'system':
     // Init-Nachricht vom Claude CLI, enthält session_id
     // Kein Event emittieren, nur loggen

   case 'assistant':
     für jeden Block in parsed.message.content:
       switch(block.type):
         'text':
           emitAndStore(agentId, 'coordinator:text', { agentId, text: block.text }, ctx)

         'tool_use':
           toolUseId = block.id
           toolName  = block.name
           input     = block.input (bereits als Objekt geparst)

           // Basis-Event
           emitAndStore(agentId, 'coordinator:tool_call', { agentId, toolName, toolUseId, input }, ctx)

           // Tool-Use-ID merken (für tool_result-Matching)
           ctx.pendingToolUseIds.set(toolUseId, toolName)

           // Semantische Events für bekannte MCP-Tools
           if (toolName === 'Task') {
             emitAndStore(agentId, 'subagent:spawn', {
               agentId, toolUseId,
               promptExcerpt: String(input.prompt ?? '').slice(0, 200),
               parentId: agentId
             }, ctx)
             // Subagent-Eintrag in agents-Tabelle (kind='subagent', status='running')
             INSERT INTO agents (Run-DB): { id: toolUseId, parent_id: agentId, kind: 'subagent', ... }
           }
           if (toolName === 'terminate') {
             // terminate-Tool wird vom MCP-Server in DB geschrieben
             // Hier nur emitEvent für SSE
             emitEvent({ type: 'coordinator:terminate', data: { agentId, reason: input.reason } })
           }
           if (toolName === 'report_progress') {
             emitEvent({ type: 'progress', data: { agentId, message: input.message, percent: input.percent } })
           }
           if (toolName === 'write_blackboard') {
             emitEvent({ type: 'blackboard:write', data: { agentId, key: input.key, valueExcerpt: String(input.value).slice(0,200) } })
           }
           if (toolName === 'send_to_peer') {
             emitEvent({ type: 'bus:message', data: { from: agentId, to: input.to_agent, kind: input.kind ?? 'send', payloadExcerpt: String(input.payload).slice(0,200) } })
           }

         'thinking':
           // Nicht weiterleiten (zu viel Rauschen), nur speichern wenn DEBUG_THINKING=1

   case 'user':
     für jeden Block in parsed.message.content:
       if (block.type === 'tool_result'):
         toolUseId = block.tool_use_id
         toolName  = ctx.pendingToolUseIds.get(toolUseId) ?? 'unknown'
         output    = extractToolResultText(block.content)
         isError   = block.is_error ?? false

         emitAndStore(agentId, 'coordinator:tool_result', { agentId, toolUseId, toolName, output: output.slice(0,500), isError }, ctx)
         ctx.pendingToolUseIds.delete(toolUseId)

         if (toolName === 'Task') {
           // Subagent abgeschlossen
           emitAndStore(agentId, 'subagent:complete', {
             agentId, toolUseId,
             resultExcerpt: output.slice(0, 200),
             success: !isError
           }, ctx)
           UPDATE agents SET status=(isError?'error':'terminated'), ended_at=now WHERE id=toolUseId (Run-DB)
         }

   case 'result':
     // Turn abgeschlossen
     if (parsed.usage) {
       tokensData = { agentId, inputTokens: parsed.usage.input_tokens, ... }
       INSERT INTO tokens (Run-DB)
       emitAndStore(agentId, 'tokens', tokensData, ctx)
     }
     if (parsed.is_error) {
       emitAndStore(agentId, 'coordinator:error', { agentId, message: parsed.error ?? 'unknown' }, ctx)
     }
```

---

### `emitAndStore(agentId, type, data, ctx)`

Hilfsfunktion — schreibt in DB und ruft emitEvent auf.

```ts
function emitAndStore(agentId: string, type: string, data: object, ctx: RunContext): void {
  const ts  = Date.now();
  const seq = nextSeq(ctx, agentId);
  ctx.db.prepare(
    'INSERT INTO events (agent_id, type, data, ts, seq) VALUES (?, ?, ?, ?, ?)'
  ).run(agentId, type, JSON.stringify(data), ts, seq);
  ctx.emitEvent({ type, data } as SwarmEvent);
}
```

**Warum sync?** `better-sqlite3` ist synchron. Da Node single-threaded ist, serialisieren sich alle `emitAndStore`-Aufrufe über den Event Loop — keine Race Conditions.

---

### `handleCoordinatorClose(agentId, exitCode, ctx)`

```
1. UPDATE agents SET status=(exitCode===0?'terminated':'error'), ended_at=now, exit_code=exitCode WHERE id=agentId
2. emitAndStore(agentId, 'coordinator:end', { agentId, exitCode, turnCount: SELECT COUNT(*) FROM tokens WHERE agent_id=agentId })
```

---

### `renderCoordinatorPrompt(coordConfig, ctx)`

Füllt Template-Platzhalter im `systemPromptTemplate`:

| Platzhalter | Ersetzung |
|---|---|
| `{{goal}}` | `ctx.config.goal` |
| `{{id}}` | `coordConfig.id` |
| `{{role}}` | `coordConfig.role` |
| `{{peer_ids}}` | komma-getrennte IDs aller anderen Coordinators |
| `{{subagent_names}}` | komma-getrennte Namen der konfigurierten Subagents |
| `{{run_id}}` | `ctx.runId` |

---

### `buildSwarmMcpConfig(runId, agentId, allAgentIds, runDbPath)` (in `swarm-mcp-config.ts`)

Erzeugt eine Temp-JSON-Datei mit dem MCP-Config-Objekt für einen Coordinator-Spawn.

**Output-Format:**
```json
{
  "mcpServers": {
    "swarm": {
      "type": "stdio",
      "command": "node",
      "args": ["--import", "tsx/esm", "ABSOLUTER_PFAD/apps/mcp/src/swarm-server.ts"],
      "env": {
        "RUN_DB_PATH": "/absoluter/pfad/data/swarm-runs/run_xxx.db",
        "RUN_ID": "run_xxx",
        "AGENT_IDS": "coordinator-a,coordinator-b"
      }
    }
  }
}
```

Die Datei wird in `os.tmpdir()` unter `swarm-mcp-{runId}-{agentId}.json` abgelegt. Nach dem Run gelöscht.

---

## Token-Budget

`SwarmConfig.globalTokenLimit` wird nicht turn-by-turn enforced (Token-Zahlen kommen erst am Ende eines Turns via `result`-Event). Enforcement-Mechanismus:

1. Nach jedem `tokens`-Event: Summe aller bisher verbrauchten Tokens aus `tokens`-Tabelle lesen
2. Wenn Summe > `globalTokenLimit`: `ctx.abort.abort()` aufrufen
3. Alle laufenden Coordinator-PIDs werden via `treeKill` beendet
4. Run-Status: `'aborted'`, Error-Message: `'global token limit exceeded'`

Dies ist ein "soft"-Enforcement (der aktuelle Turn läuft noch zu Ende). Für hartes Enforcement müsste man nach jedem Textblock prüfen — nicht empfohlen (zu viel Overhead).

---

## Risiken

1. **Task-Tool-Output nicht in Run-DB:** Subagents (Task-Tool) spawnen eigene Claude-Prozesse. Deren stdout erreicht `swarm-runtime.ts` nicht — nur das `tool_result` des Task-Tools. Die vollständige Subagent-Aktivität ist damit **nicht** im Replay sichtbar. Mitigation: Das ist dokumentiertes Verhalten, kein Fehler. Für Phase 2 könnte man Subagents ebenfalls als eigene Sessions mit eigenem stdout-Tracking spawnen — aber das ist komplex.

2. **Concurrent writes aus mehreren Coordinator-Prozessen in dieselbe Run-DB:** Wenn N Coordinator-Prozesse jeweils einen eigenen MCP-Prozess spawnen (weil stdio 1:1), schreiben N MCP-Prozesse gleichzeitig in die DB. SQLite WAL-Mode serialisiert das korrekt, aber bei vielen gleichzeitigen Writes kann `SQLITE_BUSY` auftreten. Mitigation: `busy_timeout=5000ms` in `createRunDb()` setzen.

3. **stream-json Format-Änderungen:** Der Claude CLI kann sein stream-json-Format ändern. `handleCoordinatorLine` ist dann fehlerhaft. Mitigation: graceful fallback in der `default`-Branch des `switch`.

---

## Akzeptanzkriterien

- `runSwarm(demoConfig, emitFn)` läuft durch ohne Fehler
- Run-DB enthält nach Abschluss: `swarm:start`, `coordinator:start` pro Coordinator, mind. ein `coordinator:text`, `swarm:end`
- `emitEvent` wird für jedes DB-Event aufgerufen (SSE-Side-by-Side mit DB)
- Abort via `AbortController` stoppt alle Coordinator-PIDs innerhalb von 5 Sekunden
- Token-Summe in `swarm_runs.total_tokens` stimmt mit `SUM(input_tokens + output_tokens) FROM tokens` überein
