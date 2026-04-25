# Swarm — Architektur-Übersicht

## Ziel

Ein zweistufiges System: Der **Architect** interviewt den User und baut eine validierte `SwarmConfig`. Der **Executor** führt diese Config aus — mehrere Claude-CLI-Coordinators laufen parallel, koordinieren sich über einen gemeinsamen MCP-Server, und alles landet in einer Run-spezifischen SQLite-DB. **Replay ist First-Class**: jedes Event, jede Bus-Nachricht, jeder Blackboard-Schreibvorgang ist abrufbar und zeitlich wiederholbar.

---

## Komponenten-Karte

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (Vue 3 + Pinia)                                                │
│                                                                         │
│  SwarmArchitectView   SwarmRunsView   SwarmReplayView                   │
│       │                    │               │                            │
│  swarmArchitect.ts    swarmRuns.ts    (replay state in swarmRuns.ts)    │
│       │                    │               │                            │
│  EventSource /api/swarm/architect/stream   EventSource /api/swarm/runs/:id/replay
└──────────────┬─────────────────────────────────┬───────────────────────┘
               │ HTTP + SSE                       │ HTTP + SSE
┌──────────────▼─────────────────────────────────▼───────────────────────┐
│  Express API  (apps/api, :3001)                                         │
│                                                                         │
│  routes/swarm-architect.ts          routes/swarm-runs.ts               │
│  ├── POST /api/swarm/architect/start ├── POST /api/swarm/run            │
│  ├── POST /api/swarm/architect/send  ├── POST /api/swarm/run/:configId  │
│  ├── GET  /api/swarm/architect/stream├── GET  /api/swarm/runs           │
│  ├── POST /api/swarm/configs         ├── GET  /api/swarm/runs/:id       │
│  ├── GET  /api/swarm/configs         ├── GET  /api/swarm/runs/:id/replay│
│  └── DELETE /api/swarm/configs/:id  ├── GET  /api/swarm/runs/:id/blackboard
│                                     └── GET  /api/swarm/runs/:id/db    │
│                                                                         │
│  services/swarm-runtime.ts     services/swarm-db.ts                    │
│  ├── runSwarm()                ├── createRunDb()                        │
│  ├── spawnCoordinator()        └── openRunDb()                          │
│  └── handleCoordinatorLine()                                            │
│                                                                         │
│  Hauptdatenbank (werkbank.db)                                           │
│  ├── swarm_configs    ← gespeicherte Architect-Configs                  │
│  └── swarm_runs       ← Metadaten laufender/vergangener Runs            │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ spawn (claude CLI als Subprocess)
               │ --mcp-config mit swarm-mcp + architect-mcp
┌──────────────▼──────────────────────────────────────────────────────────┐
│  Claude CLI Subprocesses                                                │
│                                                                         │
│  Coordinator A (claude -p --input-format stream-json ...)               │
│  Coordinator B (claude -p --input-format stream-json ...)               │
│  ...                                                                    │
│       │                                                                 │
│       │ stdio (stream-json)    MCP-Protokoll (JSON-RPC über stdio)      │
│       └──────────────────────────────────┐                              │
│                                          │                              │
│                              ┌───────────▼─────────────┐               │
│                              │  swarm-mcp Prozess       │               │
│                              │  (apps/mcp/swarm-server) │               │
│                              │                          │               │
│                              │  Tools:                  │               │
│                              │  write_blackboard        │               │
│                              │  read_blackboard         │               │
│                              │  list_blackboard         │               │
│                              │  send_to_peer            │               │
│                              │  check_inbox             │               │
│                              │  report_progress         │               │
│                              │  terminate               │               │
│                              └───────────┬──────────────┘               │
│                                          │ better-sqlite3 (sync)        │
│                              ┌───────────▼──────────────┐               │
│                              │  Run-DB                  │               │
│                              │  data/swarm-runs/{id}.db │               │
│                              │                          │               │
│                              │  events (Replay-Log)     │               │
│                              │  blackboard (k/v)        │               │
│                              │  bus_messages            │               │
│                              │  agents                  │               │
│                              │  tokens                  │               │
│                              └──────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Datenfluss: Architect → Config → Run → Replay

### Phase 1: Interview (Architect)

```
User-Eingabe
    → POST /api/swarm/architect/start
    → claude CLI gestartet mit Architect-Systemprompt + architect-mcp gemountet
    → SSE-Stream zurück ans Frontend (SwarmArchitectView)
        → event: text          → Architect-Text im Chat
        → event: propose_config → Partial-Config als JSON-Preview (rechts)
        → event: final_config   → Validierte Config gespeichert in swarm_configs
```

### Phase 2: Execution (Executor)

```
POST /api/swarm/run  (body: SwarmConfig oder configId)
    → swarm-runtime.ts::runSwarm()
        → createRunDb(runId)             ← leere Run-DB anlegen + Schema
        → INSERT INTO swarm_runs         ← Eintrag in Hauptdb
        → für jeden Coordinator:
            spawnCoordinator()
                → --mcp-config mit swarm-mcp (RUN_DB_PATH=.../runId.db, AGENT_ID=coord-id)
                → claude CLI spawnen
                → stream-json stdout parsen
                    → handleCoordinatorLine()
                        → INSERT INTO events (Run-DB)
                        → emit SwarmEvent → SSE an Frontend
    → Promise.allSettled aller Coordinators
    → UPDATE swarm_runs SET status='done', ended_at=...
    → SSE: event: swarm_end
```

### Phase 3: Replay

```
GET /api/swarm/runs/:id/replay?speed=2
    → openRunDb(runId)
    → SELECT * FROM events ORDER BY ts ASC
    → Events als SSE re-emittieren
        → Zeitabstände durch speed skaliert (wall_clock_delta / speed → setTimeout)
    → Frontend: SwarmReplayView spielt Timeline ab
        → Blackboard-Snapshot bei jedem blackboard_write Event aktualisiert
        → Agent-Status-Panel aktualisiert bei coordinator:start / terminate Events
```

---

## Technologie-Entscheidungen (Begründungen)

| Entscheidung | Wahl | Begründung |
|---|---|---|
| Ausführungsmodell | CLI-Subprocess | Konsistent mit Werkbank; kein `@anthropic-ai/claude-agent-sdk` nötig; kein API-Key in .env |
| Koordinationskanal | MCP-Server (swarm-mcp) | Einziger sauberer Kommunikationskanal zu CLI-Subprocesses; bewährtes Pattern in Werkbank |
| Persistenz Coordinator-Koordination | SQLite pro Run | Inspectability, Crash-Recovery, Replay without extra infrastructure |
| HTTP-Framework | Express (kein Hono) | Kein neues Dependency; SSE-Pattern identisch zu agent.ts |
| Blackboard im MCP oder Hauptprozess | Im MCP-Server | Coordinators laufen isoliert; der MCP-Prozess ist der zentrale State-Manager |
| Architect-Ausführung | CLI (wie Executor) | Konsistenz; architect-mcp liefert propose_config/finalize_config als echte MCP-Tools |
| Config-Persistenz | swarm_configs in Hauptdb | Natürlicher Fit; bereits gelöste Infrastruktur |
| Run-Metadaten | swarm_runs in Hauptdb | Liste der Runs ohne Run-DB öffnen |

---

## Neue Dateien (Gesamtübersicht)

```
apps/api/src/
  swarm-schemas.ts                  ← SwarmConfigSchema (Zod, shared source of truth)
  routes/
    swarm-architect.ts              ← Architect-Routes + MCP-Config-Builder
    swarm-runs.ts                   ← Executor-Routes, Replay, Download
  services/
    swarm-db.ts                     ← Run-DB anlegen/öffnen, Schema, WAL
    swarm-runtime.ts                ← Coordinator spawnen, stream-json parsen, Events schreiben
    swarm-mcp-config.ts             ← --mcp-config JSON für verschiedene Spawn-Typen bauen

apps/mcp/src/
  swarm-server.ts                   ← swarm-mcp: Blackboard/Bus/Progress/Terminate Tools
  architect-server.ts               ← architect-mcp: propose_config / finalize_config Tools

apps/web/src/
  views/
    SwarmArchitectView.vue
    SwarmRunsView.vue
    SwarmReplayView.vue
  stores/
    swarmArchitect.ts
    swarmRuns.ts
```

Änderungen an bestehenden Dateien:
```
apps/api/src/index.ts               ← swarm-architect + swarm-runs Router mounten
apps/api/src/db.ts                  ← swarm_configs + swarm_runs Tabellen in initDb()
apps/web/src/main.ts                ← neue Routen /swarm/*, /swarm/runs, /swarm/runs/:id
```

---

## Offene Risiken (Überblick, Details in jeweiliger Plan-Datei)

1. **swarm-mcp pro Run oder global?** Ein MCP-Serverprozess pro Run vs. ein globaler Server, der Runs via runId unterscheidet. Details → `02-swarm-mcp.md`.
2. **Coordinator-Subagent-Spawn via Task-Tool**: Subagents spawnen eigene Claude-Prozesse ohne Werkbank-Kontrolle. Deren stdout landet nicht in der Run-DB — nur der Task-tool-result. Details → `03-swarm-runtime.md`.
3. **Architect CLI vs. API**: Das Interview erfordert einfache Multi-Turn-Konversation, keinen echten Swarm. Entscheidung und Begründung → `05-architect.md`.
