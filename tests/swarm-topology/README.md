# Swarm-Topology Test Suite

Sequenzielle End-to-End-Tests für alle 13 implementierten Topologien plus die zwei Multi-Loop-Fix-Validierungen (Tests 14, 15) und Negativ-Edge-Cases (Test 16).

Jede Test-Konfiguration läuft gegen die laufende Werkbank-API (`POST /api/swarm/run-async`). Pro Test wird ein Unterordner `results/` mit gesammelten Artefakten angelegt:

```
NN-topology/
├── config.json        ← Test-Input (SwarmConfig)
├── expected.json      ← was wir erwarten (status, blackboard-keys)
└── results/           ← gitignored, populated by runner
    ├── meta.json      ← GET /api/swarm/runs/:id (Status + Token-Summe)
    ├── blackboard.json← GET /api/swarm/runs/:id/blackboard
    ├── events.jsonl   ← Event-Stream (eine Zeile pro Event)
    └── run.db         ← GET /api/swarm/runs/:id/db (binärer SQLite-Snapshot)
```

## Vorbereitung

```bash
# 1. Werkbank-Server starten (im Repo-Root):
npm run dev

# 2. Warten bis API auf 3001 antwortet:
curl http://127.0.0.1:3001/api/health
# → { "ok": true, ... }

# 3. (Optional) Existing Results löschen:
rm -rf tests/swarm-topology/*/results
```

## Tests laufen lassen

```bash
# Alle Tests sequenziell (Standard-Reihenfolge 01..16):
node tests/swarm-topology/runner.mjs

# Einzelner Test (Folder-Name oder NN):
node tests/swarm-topology/runner.mjs 14-sequential-multi-loop
node tests/swarm-topology/runner.mjs 15

# Nur Validation-Edge-Cases (kein Token-Spend):
node tests/swarm-topology/runner.mjs 16

# Dry-Run — nur /api/swarm/validate, kein Spawn (kostet 0 Token):
node tests/swarm-topology/runner.mjs --dry-run

# Skip Tests die bereits vollständige results/ haben:
node tests/swarm-topology/runner.mjs --skip-existing
```

## Erwartete Laufzeiten / Kosten

Alle Sample-Configs nutzen **Haiku 4.5** mit niedrigen `maxTurns`-Werten.

| Test | ~Dauer | ~Tokens |
|---|---:|---:|
| 01-concurrent           |  30s |  ~30k |
| 02-sequential           |  60s |  ~50k |
| 03-mixture-of-agents    | 100s |  ~80k |
| 04-majority-voting      | 100s |  ~70k |
| 05-debate-with-judge    |  90s |  ~60k |
| 06-hierarchical         | 150s | ~120k |
| 07-planner-worker       | 120s | ~100k |
| 08-round-robin          |  60s |  ~50k |
| 09-council-as-judge     | 120s | ~100k |
| 10-groupchat            |  90s |  ~60k |
| 11-heavy-swarm          | 180s | ~140k |
| 12-agent-rearrange      |  90s |  ~60k |
| 13-graph-workflow       | 120s |  ~80k |
| 14-sequential×2         | 120s | ~100k |
| 15-planner-worker×3     | 240s | ~250k |
| 16-validation-cases     | <1s  |     0 |
| **Total (Schätzung)** | **~30 min** | **~1.4M** |

## Verifikations-Logik

Pro Test prüft der Runner:
1. **Run-Status:** `meta.status` muss `expected.status` matchen (`done`/`error`/`aborted`)
2. **Blackboard-Keys:** alle in `expected.blackboardKeys` aufgelisteten Keys müssen im Snapshot existieren
3. **Phase-Events:** alle in `expected.phases` aufgelisteten `topology:phase_change`-Events müssen mindestens einmal vorkommen
4. **Token-Limit:** `meta.total_tokens < globalTokenLimit` (sanity-check)

Edge-Case-Tests (16a-d) gehen durch `POST /api/swarm/validate` — erwarten `ok: false` plus eine Substring-Match-Liste in `expected.errorIncludes`.

## Output

Der Runner gibt am Ende eine Zusammenfassung aus:

```
=== Swarm Topology Test Suite — Summary ===
✓ 01-concurrent             done   ~28k tokens   33s
✓ 02-sequential             done   ~52k tokens   58s
✓ 14-sequential-multi-loop  done  ~108k tokens  118s   [Fix 1 validated]
✗ 15-planner-worker×3       done  ~241k tokens  235s   [missing key: planner_worker:verdict]
...
13/15 passed | 2 failed | 4/4 edge-cases passed
```

Ergebnisse bleiben in `results/` für post-mortem Analyse — speziell `run.db` lässt sich mit einem SQLite-Browser öffnen oder per Script weiter analysieren.
