# Swarm — MCP-Server Design (`swarm-mcp`)

## Zweck

Der `swarm-mcp`-Server ist der einzige Kommunikationskanal zwischen Coordinator-CLI-Subprocesses und der Run-DB. Da Coordinators als isolierte `claude`-Prozesse laufen, können sie keine JavaScript-Funktionen im Hauptprozess aufrufen. Der MCP-Protokoll-Kanal (JSON-RPC über stdio) ist die einzige Lösung.

Der Server wird pro Run **einmal** gestartet und den Coordinators via `--mcp-config` bekannt gemacht. Alle Coordinators desselben Runs teilen denselben MCP-Server-Prozess (und damit dieselbe Run-DB).

---

## Entscheidung: Ein Prozess pro Run vs. Globaler Server

**Wahl: Ein Prozess pro Run.**

Begründung:
- Isolation: Run A kann Run B nicht korrumpieren
- Einfaches Lifecycle-Management: MCP-Prozess stirbt mit dem Run
- `RUN_DB_PATH` und `RUN_ID` als Env-Variablen statt Routing-Header
- Kein globales State-Management nötig

Nachteil: Mehrere gleichzeitige Runs starten mehrere MCP-Prozesse. Bei typischer Nutzung (1 Run gleichzeitig) irrelevant. Bei Bedarf kann später auf globalen Server mit Run-ID-Routing umgestellt werden.

---

## Datei-Struktur

```
apps/mcp/src/
  swarm-server.ts      ← Haupt-Einstiegspunkt (neues File)
  architect-server.ts  ← Separater Server für Architect-Tools (→ 05-architect.md)
```

Der bestehende `apps/mcp/src/index.ts` (Werkbank-MCP) bleibt unverändert. `swarm-server.ts` ist ein eigenständiger Prozess.

**Einstiegspunkt in `package.json` (apps/mcp):**
```json
{
  "scripts": {
    "swarm": "tsx src/swarm-server.ts"
  }
}
```

Alternativ: via `npx tsx apps/mcp/src/swarm-server.ts` direkt aus dem Hauptprozess spawnen.

---

## Umgebungsvariablen

Der swarm-mcp-Prozess liest beim Start:

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `RUN_DB_PATH` | ✅ | Absoluter Pfad zur Run-DB-Datei |
| `RUN_ID` | ✅ | Run-ID (für Log-Präfixe) |
| `AGENT_IDS` | ✅ | Komma-getrennte Liste aller bekannten Coordinator-IDs (für Routing-Validierung) |

**Wichtig:** `AGENT_ID` (die ID des *aufrufenden* Coordinators) wird **nicht** global gesetzt — sie kommt aus dem MCP-Tool-Call-Kontext. Jeder Tool-Call enthält ein `caller_id`-Pflichtfeld (vom Coordinator selbst angegeben).

---

## Tool-Definitionen

### Konvention

Alle Tools haben:
- `caller_id: string` — Pflicht. Die ID des aufrufenden Coordinators. Wird gegen `AGENT_IDS` validiert.
- Rückgabe: immer `{ ok: true, ... }` bei Erfolg oder `{ ok: false, error: string }` bei Fehler (kein throw — MCP-Errors sind für Protocol-Errors, nicht Business-Logic)

---

### `write_blackboard`

Schreibt einen Key-Value-Pair ins Blackboard. Alte Version wird auf `is_current=0` gesetzt.

**Input:**
```ts
{
  caller_id: string,     // Pflicht: Coordinator-ID
  key:       string,     // Pflicht: beliebiger String, Konvention: "namespace:key"
  value:     string      // Pflicht: beliebiges JSON oder plain text
}
```

**Ablauf:**
1. Validiere `caller_id` gegen `AGENT_IDS`
2. Starte SQLite-Transaktion
3. `UPDATE blackboard SET is_current=0 WHERE key=? AND is_current=1`
4. `INSERT INTO blackboard (key, value, version, written_by, written_at, is_current) VALUES (...)`
5. `INSERT INTO events (agent_id, type, data, ts, seq) VALUES (caller_id, 'blackboard:write', {key, value_excerpt, version}, now, nextSeq(caller_id))`
6. Commit

**Output:** `{ ok: true, key, version: number }`

**Hinweis:** Inbox-Schlüssel (`inbox:{agent_id}:*`) werden geschrieben, aber kein separates Event emittiert (zu viel Rauschen). Normale Blackboard-Keys erzeugen immer ein `blackboard:write`-Event.

---

### `read_blackboard`

Liest den aktuellen Wert eines Keys.

**Input:**
```ts
{
  caller_id: string,
  key:       string
}
```

**Ablauf:**
1. `SELECT value, version FROM blackboard WHERE key=? AND is_current=1`
2. Optional: `INSERT INTO events` mit `type='blackboard:read'` (deaktivierbar via `SWARM_LOG_READS=1` Env)

**Output:** `{ ok: true, key, value: string | null, version: number | null }`

---

### `list_blackboard`

Gibt alle aktuellen Keys zurück, optional nach Präfix gefiltert.

**Input:**
```ts
{
  caller_id: string,
  prefix?:   string    // z.B. "market:" → alle Keys die mit "market:" beginnen
}
```

**Ablauf:**
1. `SELECT key, value, version FROM blackboard WHERE is_current=1 [AND key LIKE prefix%]`

**Output:** `{ ok: true, entries: Array<{key, value, version}> }`

---

### `send_to_peer`

Sendet eine Nachricht an einen anderen Coordinator. Die Nachricht landet in zwei Orten:
1. `bus_messages`-Tabelle (vollständige Persistenz)
2. `blackboard`-Key `inbox:{to_agent}:{msg_id}` (für `check_inbox`)

**Input:**
```ts
{
  caller_id:  string,
  to_agent:   string,    // Coordinator-ID oder 'broadcast'
  payload:    string,    // beliebiges JSON
  kind?:      'send' | 'request' | 'reply',   // default: 'send'
  reply_to?:  string     // msg_id einer vorherigen Nachricht (für reply)
}
```

**Ablauf:**
1. Validiere `to_agent` gegen `AGENT_IDS` (außer bei 'broadcast')
2. Validiere `hop_count` (aus `reply_to`-Lookup): max 6, sonst error
3. Generiere `msg_id = randomUUID()`
4. Transaktion:
   - `INSERT INTO bus_messages ...`
   - `INSERT INTO events (type='bus:message', ...)`
   - `write_blackboard({ key: 'inbox:${to_agent}:${msg_id}', value: payload, caller_id })`
5. Bei 'broadcast': für jeden Coordinator in `AGENT_IDS` außer `caller_id` wiederholen

**Output:** `{ ok: true, msg_id }`

---

### `check_inbox`

Liest alle ungelesenen Nachrichten für den aufrufenden Coordinator und löscht sie aus dem Blackboard (nicht aus `bus_messages`).

**Input:**
```ts
{
  caller_id: string
}
```

**Ablauf:**
1. `SELECT key, value FROM blackboard WHERE key LIKE 'inbox:{caller_id}:%' AND is_current=1`
2. Für jeden gefundenen Key:
   - `UPDATE blackboard SET is_current=0 WHERE key=? AND is_current=1`
   - `UPDATE bus_messages SET delivered=1 WHERE msg_id=?`
3. Kein Event-Eintrag (zu viel Rauschen; die ursprüngliche `send_to_peer`-Call hat bereits ein Event)

**Output:** `{ ok: true, messages: Array<{msg_id, from_agent, kind, payload, reply_to}> }`

---

### `report_progress`

Schreibt einen Fortschritts-Eintrag ins Event-Log. Erscheint im SSE-Stream als `progress`-Event.

**Input:**
```ts
{
  caller_id: string,
  message:   string,     // Freitext
  percent?:  number      // 0–100, optional
}
```

**Ablauf:**
1. `INSERT INTO events (agent_id=caller_id, type='progress', data={message, percent}, ...)`
2. Kein Blackboard-Eintrag

**Output:** `{ ok: true }`

---

### `terminate`

Markiert den aufrufenden Coordinator als terminiert. Der Hauptprozess erkennt dies im stream-json-Output (terminate-Tool-Result) und behandelt das als normales Ende.

**Input:**
```ts
{
  caller_id: string,
  reason?:   string
}
```

**Ablauf:**
1. `UPDATE agents SET status='terminated', ended_at=now WHERE id=caller_id`
2. `INSERT INTO events (type='coordinator:terminate', data={reason}, ...)`
3. Schreibe `blackboard` Key `status:{caller_id}` = `'terminated'` (für Peers sichtbar)

**Output:** `{ ok: true }`

---

## Server-Startup und Lifecycle

### Startup-Sequenz (`swarm-server.ts`)

```
1. Lese RUN_DB_PATH, RUN_ID, AGENT_IDS aus process.env
2. Öffne Run-DB mit better-sqlite3 (WAL bereits aktiviert von createRunDb)
3. Starte MCP-Server (stdio transport) via @modelcontextprotocol/sdk
4. Registriere alle 7 Tools (mit Zod-Schemas als input-Validierung)
5. Log: "[swarm-mcp] ready, run={RUN_ID}, db={RUN_DB_PATH}"
```

**Sequenz-Nummer `nextSeq(agent_id)`:** Wird via `SELECT MAX(seq) FROM events WHERE agent_id=?` + 1 berechnet. Innerhalb einer Transaktion threadsafe (Node single-threaded).

### Shutdown

Der MCP-Prozess wird vom Hauptprozess via `process.kill()` beendet, nachdem alle Coordinators des Runs terminiert sind. Kein graceful-shutdown nötig — WAL-Mode stellt sicher, dass offene Transaktionen beim Prozessende korrekt abgebrochen werden.

---

## Montage in Coordinator-Spawns (`swarm-mcp-config.ts`)

Der Hauptprozess (`swarm-runtime.ts`) baut für jeden Run eine `--mcp-config`-JSON-Datei:

```ts
// Konzeptuell (kein Code):
interface SwarmMcpConfigEntry {
  type: 'stdio';
  command: string;      // z.B. "node" oder "npx"
  args: string[];       // ["tsx", "apps/mcp/src/swarm-server.ts"]
  env: {
    RUN_DB_PATH: string;
    RUN_ID:      string;
    AGENT_IDS:   string;  // "coordinator-a,coordinator-b"
  };
}
```

Die MCP-Config-Datei wird als Temp-File angelegt (wie es `claude-sessions.ts` bereits für den Werkbank-MCP tut) und nach dem Run gelöscht.

**Alle Coordinators eines Runs erhalten dieselbe MCP-Config-Datei.** Der MCP-Server-Prozess wird vom ersten Coordinator-Spawn gestartet; folgende Coordinators verbinden sich ebenfalls zu demselben Prozess (das ist MCP stdio-Standard: ein Prozess kann von mehreren Clients verwendet werden).

**Alternative (falls stdio nicht multi-client unterstützt):** Server als HTTP-MCP starten statt stdio, alle Coordinators verbinden via HTTP. Dieser Fallback-Plan wird in `07-rollout.md` als Risiko notiert.

---

## Abhängigkeiten

```json
// apps/mcp/package.json — neue deps:
{
  "@modelcontextprotocol/sdk": "^1.x",   // bereits vorhanden (Werkbank-MCP)
  "better-sqlite3": "^11.x",             // bereits vorhanden (Werkbank-MCP nutzt es möglicherweise)
  "zod": "^3.x"                           // bereits vorhanden
}
```

Falls `@modelcontextprotocol/sdk` im MCP-Workspace noch nicht vorhanden: `npm -w apps/mcp install @modelcontextprotocol/sdk`.

---

## Offene Fragen / Risiken

1. **stdio multi-client:** MCP stdio-Transport ist typischerweise 1:1 (ein Server, ein Client). Wenn der Claude CLI erwartet, für jeden `--mcp-config`-Eintrag einen eigenen Prozess zu spawnen, würden N Coordinators N MCP-Prozesse starten, die alle denselben `RUN_DB_PATH` öffnen. Das funktioniert mit SQLite WAL-Mode — ist aber nicht das Gleiche wie ein gemeinsamer Prozess. **Mitigation:** WAL-Mode erlaubt N gleichzeitige Writer aus N Prozessen auf dieselbe DB. Das ist tatsächlich der robustere Ansatz und sollte bevorzugt werden.

2. **`AGENT_IDS` zum Spawn-Zeitpunkt:** Alle Coordinator-IDs müssen bekannt sein, bevor der erste Coordinator gestartet wird. Das setzt voraus, dass `swarm-runtime.ts` die Config vollständig parsed und alle IDs vorab generiert.

3. **Tool-Call von Subagents:** Subagents (via Task-Tool gespawnt) laufen als Claude-Kindprozesse ohne eigene MCP-Config. Sie haben keinen Zugriff auf `swarm-mcp`-Tools. Das ist bewusst — Subagents sind isolierte Worker, keine Swarm-Participants. Falls sich das als Problem erweist, kann man ihnen beim Spawn eine eigene `--mcp-config` mitgeben.

---

## Akzeptanzkriterien

- `npx mcp-inspector npx tsx apps/mcp/src/swarm-server.ts` zeigt alle 7 Tools
- `write_blackboard` + sofortiger `read_blackboard` gibt korrekten Wert zurück
- Zwei simultane `write_blackboard`-Aufrufe auf denselben Key erzeugen korrekte Versionen (Version 1 und 2, nicht beide Version 1)
- `send_to_peer` + `check_inbox` übergibt Nachricht korrekt
- Alle Calls erzeugen Events in der `events`-Tabelle
- Prozess terminiert sauber (kein Hang) wenn Haupt-DB-Verbindung per `db.close()` geschlossen wird
