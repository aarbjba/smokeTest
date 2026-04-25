# Swarm — Frontend (Vue 3)

## Neue Dateien

```
apps/web/src/
  views/
    SwarmArchitectView.vue    ← Interview-Chat + Config-Preview
    SwarmRunsView.vue         ← Run-Liste + Start-Button
    SwarmReplayView.vue       ← Replay-Player + Timeline
  stores/
    swarmArchitect.ts         ← Architect-Session-State
    swarmRuns.ts              ← Run-Liste + aktiver Run-State + Replay-State
```

Änderungen an bestehenden Dateien:
```
apps/web/src/main.ts          ← neue Routen registrieren
apps/web/src/api.ts           ← swarm-Namespace ergänzen
apps/web/src/types.ts         ← Swarm-Typen ergänzen
```

---

## Router-Routen

```ts
// In apps/web/src/main.ts:
{ path: '/swarm',              name: 'swarm-runs',     component: SwarmRunsView },
{ path: '/swarm/architect',    name: 'swarm-architect', component: SwarmArchitectView },
{ path: '/swarm/runs/:id',     name: 'swarm-replay',   component: SwarmReplayView, props: true },
```

Navigation: Ein "Swarm"-Link in der App-Navigation (neben den bestehenden Board/Settings-Links).

---

## `swarmArchitect.ts` — Pinia Store

```ts
// State
interface SwarmArchitectStore {
  todoId:              number | null;          // Todo-ID der laufenden Architect-Session
  messages:            ArchitectMessage[];     // Chat-History
  proposedConfig:      object | null;          // Letzte propose_config-Payload (Partial)
  finalConfig:         SwarmConfig | null;     // Nach finalize_config
  finalConfigId:       number | null;          // config_id nach finalizer
  status:              'idle' | 'interviewing' | 'finalized';
  eventSource:         EventSource | null;
}

interface ArchitectMessage {
  role:     'user' | 'assistant';
  content:  string;
  ts:       number;
}
```

**Actions:**
- `start(goal?)` → `POST /api/swarm/architect/start` → `todoId` setzen, EventSource öffnen
- `send(message)` → lokale Message pushen + `POST /api/swarm/architect/send`
- `connectStream(todoId)` → EventSource auf `/api/agent/session/{todoId}/stream`
  - `chunk`-Event: letzter `assistant`-Message-Content erweitern (oder neue Message anlegen)
  - `swarm_propose_config`-Event: `proposedConfig` setzen
  - `swarm_final_config`-Event: `finalConfig` + `finalConfigId` setzen, `status = 'finalized'`
- `reset()` → alles auf idle zurücksetzen

---

## `swarmRuns.ts` — Pinia Store

```ts
// State
interface SwarmRunsStore {
  runs:          SwarmRunMeta[];
  activeRun:     ActiveRun | null;          // Laufender Run (SSE-Stream aktiv)
  replayRun:     ReplayRun | null;          // Für SwarmReplayView
  configs:       SwarmConfigMeta[];
}

interface ActiveRun {
  runId:         string;
  goal:          string;
  events:        SwarmEvent[];              // Akumulierte Events (für Live-Anzeige)
  agents:        Map<string, AgentStatus>;
  blackboard:    Map<string, string>;       // Key → letzter Wert
  tokenTotal:    number;
  status:        'running' | 'done' | 'error' | 'aborted';
  eventSource:   EventSource | null;
}

interface ReplayRun {
  runId:         string;
  allEvents:     SwarmEvent[];              // Alle Events (aus Replay-Endpoint geladen)
  playhead:      number;                   // Index in allEvents (aktuell angezeigt)
  playing:       boolean;
  speed:         number;                   // 0.5 / 1 / 2 / 5 / instant
  blackboardAt:  Map<string, string>;      // Blackboard-Snapshot beim Playhead
  filterAgentId: string | null;
  filterTypes:   string[];
}
```

**Actions:**
- `loadRuns()` → `GET /api/swarm/runs`
- `loadConfigs()` → `GET /api/swarm/configs`
- `startRun(configOrId)` → `POST /api/swarm/run[/:id]`, öffnet EventSource, befüllt `activeRun`
- `connectRunStream(runId)` → EventSource auf SSE-Stream des laufenden Runs
  - Alle Events werden in `activeRun.events` gepusht
  - `blackboard_write` → `activeRun.blackboard` aktualisieren
  - `tokens` → `tokenTotal` aufaddieren
  - `swarm_end` → EventSource schließen, `status` setzen
- `loadReplay(runId)` → `GET /api/swarm/runs/:id/replay?speed=0` (instant), alle Events laden
- `replayPlay/Pause/Seek/SetSpeed(...)` → Replay-Player-State steuern

---

## `SwarmArchitectView.vue`

### Layout (zwei Spalten)

```
┌──────────────────────────────────────────────┐
│  Swarm Architect                              │
├───────────────────┬──────────────────────────┤
│  Chat (links)     │  Config-Preview (rechts) │
│                   │                          │
│  [AI-Antwort...]  │  {                       │
│                   │    "goal": "...",        │
│  [User-Eingabe]   │    "coordinators": [     │
│                   │      { "id": "..." }     │
│  ┌─────────────┐  │    ]                     │
│  │ Nachricht.. │  │  }                       │
│  └─────────────┘  │                          │
│  [Senden]         │  [Config ausführen]      │
└───────────────────┴──────────────────────────┘
```

**Chat-Panel (links):**
- Nachrichtenlist mit alternierenden User/Assistant-Blasen
- Textarea für User-Input (Enter = Senden, Shift+Enter = Zeilenumbruch)
- Senden-Button (disabled wenn Session nicht aktiv)
- Status-Indikator: "Interviewing..." / "Config finalisiert ✓"

**Config-Preview (rechts):**
- JSON-Block via `highlight.js` (Sprache: `json`) — identisch zur bestehenden Snippet-Darstellung in Werkbank
- Erscheint sobald erstes `propose_config`-Event eintrifft
- Aktualisiert sich bei jedem weiteren `propose_config`
- Grauer Hinweis "Vorschau — noch nicht gespeichert" solange `status !== 'finalized'`
- Nach `finalize_config`: grüner Hinweis "Gespeichert als Config #N"
- Button "Jetzt ausführen" → navigiert zu `/swarm/runs` und startet Run
- Button "Zur Run-Liste" → navigiert zu `/swarm/runs`

**Initialer Zustand:**
- Eingabefeld "Was willst du erreichen?" als Onboarding-Prompt
- Beim Absenden → `swarmArchitect.start(goal)` → Session startet

---

## `SwarmRunsView.vue`

### Layout

```
┌───────────────────────────────────────────────────────┐
│  Swarm Runs                          [+ Neuer Run]    │
├───────────────────────────────────────────────────────┤
│  Gespeicherte Configs:                                │
│  ┌──────────────────────────────────────────────┐    │
│  │  "Marktanalyse v1"  [Ausführen] [Löschen]    │    │
│  │  "Code Review Swarm"  [Ausführen] [Löschen]  │    │
│  └──────────────────────────────────────────────┘    │
├───────────────────────────────────────────────────────┤
│  Vergangene Runs:                                     │
│  ┌──────────────────────────────────────────────┐    │
│  │  run_20240115_…  ✅ done  4.2k tokens  1m23s │    │
│  │  "Marktanalyse für Produkt X"  [Replay]      │    │
│  │                                              │    │
│  │  run_20240114_…  ❌ error  1.1k tokens  0m45s│    │
│  │  "Code Review"  [Replay]                    │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

**Laufender Run (wenn `activeRun !== null`):**
- Separate Karte ganz oben mit Live-Ausgabe (letzte 5 Events)
- Abort-Button
- Token-Zähler (live aktualisiert)
- Agent-Status-Icons (jeder Coordinator: laufend / fertig / Fehler)

**"+ Neuer Run"-Button:** Öffnet Modal mit zwei Optionen:
- "Architect starten" → navigiert zu `/swarm/architect`
- "Gespeicherte Config wählen" → Dropdown der gespeicherten Configs → Direktstart

---

## `SwarmReplayView.vue`

Dies ist das Kern-Feature für "alles soll schön in der SQLite landen, dann können wir nen Replay machen".

### Layout

```
┌───────────────────────────────────────────────────────────────────────┐
│  Replay: "Marktanalyse für Produkt X"        [⬇ DB-Download]         │
├──────────────────────────────────────────────────────────────────────┤
│  ◄◄  ▶  ▶▶  ||   ████████████░░░░░░░░░░░░░░  47/203 Events  2.0x   │
│  Filter: [Alle Agents ▼]  [Alle Typen ▼]                             │
├──────────────────────────────┬────────────────────────────────────────┤
│  Timeline (links)            │  Detail + Blackboard (rechts)         │
│                              │                                        │
│  ● swarm:start               │  Event-Detail:                        │
│  ● coordinator-market start  │  ┌────────────────────────────────┐   │
│  │ text: "Ich analysiere..." │  │ type: coordinator:text         │   │
│  │ tool_call: write_blackbo… │  │ agent: coordinator-market      │   │
│  │ blackboard_write: …       │  │ ts: 2024-01-15 14:30:22.441    │   │
│  ● coordinator-feasibility   │  │ text: "Ich analysiere den      │   │
│  │ text: "Machbarkeitsprüf…  │  │ aktuellen Markt..."            │   │
│  │ subagent:spawn            │  └────────────────────────────────┘   │
│  │   └─ subagent complete    │                                        │
│  │ tokens: 1.2k              │  Blackboard-Snapshot:                 │
│  ● swarm:end                 │  ┌────────────────────────────────┐   │
│                              │  │ market:overview  "..."  v2      │   │
│  [Event #47 ausgewählt]      │  │ status:coord-market terminated  │   │
│                              │  └────────────────────────────────┘   │
└──────────────────────────────┴────────────────────────────────────────┘
```

### Timeline-Panel (links)

- Vertikale Liste aller Events (bis Playhead)
- Farbkodierung nach Event-Typ:
  - `coordinator:text` → grau
  - `tool_call` → gelb
  - `blackboard_write` → blau
  - `bus:message` → lila
  - `subagent:spawn/complete` → grün
  - `error` → rot
  - `swarm:start/end` → fett schwarz
- Coordinator-Spalten: Events eines Coordinators sind leicht eingerückt und farblich markiert (jeder Coordinator bekommt eine Akzentfarbe)
- Klick auf Event → Event-Detail-Panel aktualisieren + Blackboard-Snapshot laden

### Player-Controls

- **▶ / ||** — Play/Pause
- **◄◄ / ▶▶** — 10 Events zurück/vor
- **Scrubber** — Drag zum beliebigen Event springen
- **Geschwindigkeit:** 0.5x / 1x / 2x / 5x / Instant (Buttons)
- **Event-Counter:** "47/203 Events"

**Replay-Mechanismus (client-seitig):**
```
replayRun.allEvents ist vollständig geladen (via speed=0-Endpoint)
Play → setInterval: alle (delta_ms / speed) ms wird playhead um 1 erhöht
Bei Playhead-Änderung:
  - Timeline scrollt zum aktuellen Event
  - Blackboard-Snapshot wird aus allEvents berechnet
    (alle blackboard_write-Events bis playhead aufaddieren)
  - Event-Detail wird aktualisiert
```

Der Blackboard-Snapshot wird **client-seitig** berechnet — kein Server-Request pro Playhead-Position. Das macht Scrubbing lagfrei.

**Blackboard-Snapshot-Berechnung (client-seitig):**
```ts
function computeBlackboardAt(events: SwarmEvent[], upToIndex: number): Map<string, string> {
  const board = new Map<string, string>();
  for (let i = 0; i <= upToIndex; i++) {
    const e = events[i];
    if (e.type === 'blackboard_write') {
      board.set(e.data.key, e.data.valueExcerpt);  // Excerpt reicht für Anzeige
    }
  }
  return board;
}
```

Für vollständige Werte (nicht nur Excerpts): separater Request `GET /api/swarm/runs/:id/blackboard?at_ts=X`.

### Filter

- **Agent-Filter:** Dropdown mit allen Coordinators des Runs → Timeline zeigt nur Events dieses Agents
- **Typ-Filter:** Multi-Select (text / tool_call / blackboard / bus / subagent / tokens)

### Event-Detail-Panel (rechts)

- Zeigt vollständigen Event-Payload als formatiertes JSON (highlight.js)
- Für `coordinator:text`: plain text statt JSON
- Für `tool_call`: Input-JSON
- Für `tool_result`: Output-Text / JSON

### DB-Download-Button

`GET /api/swarm/runs/:id/db` → Browser-Download der SQLite-Datei.

---

## `apps/web/src/api.ts` — Neue swarm-Methoden

```ts
// Konzeptuell — kein Code
swarm: {
  architect: {
    start(goal?)         → POST /api/swarm/architect/start
    send(todoId, msg)    → POST /api/swarm/architect/send
    streamUrl(todoId)    → /api/agent/session/{todoId}/stream  (bestehend)
  },
  configs: {
    list()               → GET /api/swarm/configs
    get(id)              → GET /api/swarm/configs/:id
    save(name, config)   → POST /api/swarm/configs
    remove(id)           → DELETE /api/swarm/configs/:id
  },
  runs: {
    list(params)         → GET /api/swarm/runs
    get(id)              → GET /api/swarm/runs/:id
    start(config)        → POST /api/swarm/run          (gibt SSE-URL zurück)
    startFromConfig(id)  → POST /api/swarm/run/:id
    replayUrl(id)        → /api/swarm/runs/:id/replay
    blackboard(id, at?)  → GET /api/swarm/runs/:id/blackboard
    dbUrl(id)            → /api/swarm/runs/:id/db
  }
}
```

---

## Neue CSS / Theming

Werkbank hat CSS Custom Properties pro Theme (`workshop`/`dark`/`light`/`terminal`). Neue Farb-Variablen für Swarm-spezifische UI:

```css
/* In apps/web/src/styles/themes.css, pro Theme: */
--swarm-text:      #888;
--swarm-tool:      #c9a227;
--swarm-blackboard: #4a9eff;
--swarm-bus:       #9b59b6;
--swarm-subagent:  #27ae60;
--swarm-error:     #e74c3c;
--swarm-meta:      #fff;
```

Kein neues CSS-Framework. Handgeschrieben wie der Rest der Werkbank.

---

## Akzeptanzkriterien

- `/swarm/architect`: Chat-Eingabe funktioniert, propose_config-Events aktualisieren JSON-Preview, finalize_config zeigt Erfolgsmeldung
- `/swarm/runs`: Liste der Runs wird angezeigt, laufender Run zeigt Live-Events
- `/swarm/runs/:id`: Replay lädt alle Events, Play-Button startet Durchlauf, Scrubber springt zu beliebigem Event
- Blackboard-Snapshot ändert sich korrekt beim Scrubben durch die Timeline
- DB-Download-Link liefert binäre Datei
- Alle Views respektieren das aktive Theme (keine hardcodierten Farben)
