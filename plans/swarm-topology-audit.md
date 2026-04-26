# Swarm-Topology Audit — werkbank ↔ kyegomez/swarms

**Status:** Ergebnis einer systematischen Prüfung aller 13 implementierten Topologien gegen ihre kyegomez Python-Referenzen.
**Datum:** 2026-04-26
**Scope:** Findet reale Abweichungen über den Default-Test-Pfad hinaus. Bewusste Werkbank-Deviations (REPL, autosave, networkx etc.) sind separat aufgeführt und nicht als Gaps gewertet.

---

## 1. Methodik

Pro Topologie geprüft:
1. **Reference-Datei** (`D:/programme/swarms-concept/_reference/swarms/structs/<topo>.py`) komplett gelesen — `__init__`-Signatur, `run()`-Hauptpfad, alle Feature-Flags
2. **Werkbank-Impl** (`D:/programme/werkbank/apps/api/src/services/swarm-topology/<topo>.ts`) gegen die Reference gelegt
3. **Schema** (`apps/api/src/swarm-schemas.ts`) auf Optionen geprüft
4. Klassifikation pro Feature: **✅ covered / ⚠️ partial / ❌ missing / 🚫 intentionally dropped**

Default-Test-Pfad = die Sample-Configs aus `metadata.ts`. Die kritische Frage: was passiert, wenn der User Optionen über die Defaults hinaus setzt?

---

## 2. Statusmatrix

| Topologie | Zeilen TS | Default-Pfad | Non-Default-Pfade | Schwerwiegende Gaps |
|---|---:|:---:|:---:|---|
| `concurrent`        |  25 | ✅ | ✅ (trivial — keine Optionen) | — |
| `sequential`        | 192 | ✅ | ⚠️ | **`max_loops` fehlt** |
| `mixture-of-agents` | 218 | ✅ | ✅ | — |
| `majority-voting`   | 250 | ✅ | ✅ | — |
| `debate-with-judge` | 243 | ✅ | ✅ | — |
| `hierarchical`      | 446 | ✅ | ⚠️ | `agent_as_judge`-Variante fehlt (niedrig) |
| `planner-worker`    | 278 | ✅ | ❌ | **multi-cycle Iteration fehlt komplett** |
| `round-robin`       | 187 | ✅ | ✅ | — |
| `council-as-judge`  | 244 | ✅ | ✅ | — |
| `groupchat`         | 307 | ✅ | ✅ | — |
| `heavy-swarm`       | 467 | ✅ | ✅ | — |
| `agent-rearrange`   | 277 | ✅ | ✅ | — |
| `graph-workflow`    | 299 | ✅ | ✅ | — |

**Score:** 11 von 13 Topologien decken Non-Default-Pfade vollständig ab. 2 Topologien (`sequential`, `planner-worker`) haben relevante Gaps. 1 Topologie (`hierarchical`) hat eine niedrig-prioritäre Variantenlücke.

---

## 3. Gap 1 (HOCH): `sequential` — fehlendes `max_loops`

### Reference-Verhalten

**Datei:** `D:/programme/swarms-concept/_reference/swarms/structs/sequential_workflow.py`

```python
# sequential_workflow.py:83
def __init__(
    self,
    ...
    max_loops: int = 1,  # 👈 konfigurierbar
    ...
):
    ...
    # sequential_workflow.py:152
    self.agent_rearrange = AgentRearrange(
        ...
        flow=self.flow,
        max_loops=self.max_loops,  # 👈 wird an AgentRearrange durchgereicht
        ...
    )
```

`SequentialWorkflow` delegiert intern an `AgentRearrange`, dessen `run()` die ganze Pipeline N-mal durchläuft:

```python
# agent_rearrange.py:662
loop_count = 0
while loop_count < self.max_loops:
    for task_idx, task in enumerate(tasks):
        # alle Steps in Reihenfolge
        ...
    loop_count += 1
```

Use-Case: iterative Verfeinerung. Pipeline läuft → letzter Output dient als Input für die nächste Iteration der gleichen Pipeline (z. B. Writer → Editor → Polish wiederholt durchlaufen).

### Werkbank-Status

**Datei:** `D:/programme/werkbank/apps/api/src/services/swarm-topology/sequential.ts:122`

```typescript
async run(ctx: RunContext): Promise<void> {
  const driftEnabled = ctx.config.topologyOptions?.sequentialDriftDetection ?? false;
  ...

  // sequential.ts:133
  for (let idx = 0; idx < pipeline.length; idx++) {
    // ein-malige Iteration über alle Stages
    ...
    await spawnCoordinator(coord, ctx, { previous_output, stage, total_stages, ... });
  }

  if (!judge || ctx.abort.signal.aborted) return;
  // optional drift judge — auch nur einmal
}
```

**Schema (`swarm-schemas.ts:75-77`):**
```typescript
// sequential
sequentialDriftDetection: z.boolean().default(false),
// 👆 nur diese eine Option — kein sequentialLoops
```

### Gap-Analyse

| Reference-Feature | Werkbank | Severity |
|---|---|---|
| `max_loops=1` Default | ✅ funktioniert | — |
| `max_loops > 1` (z. B. iterative refinement loop) | ❌ Schema-Option existiert nicht; Handler hat keinen äußeren Loop | **HOCH** |
| Output von Loop N seedet Loop N+1 als Input | ❌ Da kein Loop, Frage entfällt | folgt aus oben |

**Auswirkung auf Default-Tests:** Keine — Sample-Config in `metadata.ts:230-262` setzt kein `max_loops`. Default=1 funktioniert.

**Auswirkung auf reale Use-Cases:** Wer ein iterativ-verbessertes Pipeline-Ergebnis möchte (Writer→Editor→Polish dreimal), kann das nicht ausdrücken. Die werkbank ignoriert die Option stillschweigend wenn der User sie hinzufügt — schlimmster Fall, weil **die Default-Validierung den missglückten Versuch nicht catcht**.

---

## 4. Gap 2 (HOCH): `planner-worker` — multi-cycle Iteration fehlt

### Reference-Verhalten

**Datei:** `D:/programme/swarms-concept/_reference/swarms/structs/planner_worker_swarm.py`

```python
# planner_worker_swarm.py:542
def __init__(
    self,
    ...
    max_loops: int = 1,  # 👈 konfigurierbar
    ...
):
```

```python
# planner_worker_swarm.py:863-915
for cycle in range(self.max_loops):
    # Between cycles: prepare queue based on judge feedback
    if cycle > 0 and verdict is not None:
        self._prepare_next_cycle(verdict)

    # Phase 1: Planning
    if cycle == 0:
        planner_task = task
    else:
        planner_task = (
            f"Original goal: {task}\n\n"
            f"Previous cycle feedback: {verdict.follow_up_instructions}\n"
            f"Gaps identified: {verdict.gaps}\n\n"
            "Create new tasks to address these gaps."
        )

    self._run_planner(planner_task)

    # Phase 2: Worker execution
    worker_pool = WorkerPool(...)
    worker_pool.run(timeout=self.worker_timeout)

    # Phase 3: Judge evaluation
    verdict = self._run_judge()

    if verdict.is_complete:
        break  # 👈 early-break wenn Goal erreicht
```

### CycleVerdict-Schema (Python)

**Datei:** `_reference/swarms/schemas/planner_worker_schemas.py:145-178`

```python
class CycleVerdict(BaseModel):
    is_complete:        bool      # True → break loop
    overall_quality:    int       # 0-10
    summary:            str
    gaps:               List[str]
    follow_up_instructions: Optional[str]  # → seedet next planner_task
    needs_fresh_start:  bool      # True → clear ALL tasks; False → only non-terminal
```

### `_prepare_next_cycle`

```python
# planner_worker_swarm.py:816-829
def _prepare_next_cycle(self, verdict: CycleVerdict) -> None:
    if verdict.needs_fresh_start:
        # Drift-Reset: ganze Queue löschen
        self.task_queue.clear()
    else:
        # Inkrementell: nur pending/claimed/running Tasks löschen,
        # completed Tasks bleiben als Kontext erhalten
        self.task_queue.clear_non_terminal()
```

### Werkbank-Status

**Datei:** `D:/programme/werkbank/apps/api/src/services/swarm-topology/planner-worker.ts:227-277`

```typescript
async run(ctx: RunContext): Promise<void> {
  const roles = resolvePlannerWorkerRoles(ctx.config.coordinators);
  if (!roles) return;
  ...

  // Phase 1 — planner runs alone, must publish tasks before terminating.
  await spawnCoordinator(planner, ctx, sharedVars);

  // Phase 2 — workers race for tasks
  await runCoordinatorsInParallel(workers.map(w => () => spawnCoordinator(w, ctx, ...)));

  // Phase 3 (optional) — judge evaluates the task report.
  if (judge) {
    await spawnCoordinator(judge, ctx, { task_report: renderTaskReport(ctx), ... });
  }
}
// 👆 EINMALIGER Durchlauf, kein for-loop, keine verdict-Auswertung
```

**Schema (`swarm-schemas.ts:84-86`):**
```typescript
// planner-worker
plannerWorkerPresetAgents: z.boolean().default(false),
// 👆 nur eine Option — kein plannerWorkerLoops, kein verdict-Schema
```

### Gap-Analyse

| Reference-Feature | Werkbank | Severity |
|---|---|---|
| `max_loops=1` (single cycle) | ✅ funktioniert | — |
| `max_loops > 1` multi-cycle Iteration | ❌ kompletter Loop fehlt | **HOCH** |
| `verdict.is_complete` early-break | ❌ kein verdict-Parsing | folgt |
| `verdict.follow_up_instructions` seedet next planner | ❌ kein second-cycle Planner mit Gap-Kontext | folgt |
| `verdict.needs_fresh_start` queue-reset | ❌ keine `_prepare_next_cycle`-Logik | folgt |
| `verdict.gaps[]` strukturiert | ⚠️ Judge-Prompt verlangt sechs Felder, aber kein TS-Side Parsing | folgt |

**Auswirkung auf Default-Tests:** Keine — Sample-Config in `metadata.ts:309-352` enthält kein `max_loops`, Judge-Output wird nur ins Blackboard geschrieben aber ignoriert.

**Auswirkung auf reale Use-Cases:** Das **Kernfeature** des Original-Patterns ist Iterative-Refinement: Planner zerlegt → Workers erledigen → Judge bewertet → Planner verfeinert für nächsten Cycle bis is_complete=True. Unsere Impl deckt nur 1 Cycle ab — die "Iterative" Hälfte fehlt.

**Aktueller Judge-Prompt** (`planner-worker.ts:115-140`) verlangt korrekt die sechs Verdict-Felder (`is_complete`, `overall_quality`, `summary`, `gaps`, `follow_up_instructions`, ein sechstes), aber das TS-Side-Parsing existiert nicht — der Judge schreibt JSON ins Blackboard und niemand liest es.

---

## 5. Gap 3 (NIEDRIG): `hierarchical` — `agent_as_judge`-Variante fehlt

### Reference-Verhalten

**Datei:** `_reference/swarms/structs/hiearchical_swarm.py:677-703`

```python
def __init__(
    self,
    ...
    director_feedback_on: bool = True,   # 👈 Director self-eval (default)
    agent_as_judge:       bool = False,  # 👈 Optional: dedicated judge stattdessen
    judge_agent_model_name: str = "gpt-5.4",
    parallel_execution:   bool = True,   # 👈 Worker parallel vs sequenziell
    planning_enabled:     bool = True,   # 👈 Planning-Phase überspringbar
    ...
):
```

```python
# hiearchical_swarm.py:1198-1205
if self.agent_as_judge:
    feedback = self.run_judge_agent(outputs)   # dedizierter Judge
elif self.director_feedback_on is True:
    feedback = self.feedback_director(outputs) # Director macht Self-Eval
else:
    feedback = outputs                          # Eval-Phase wird übersprungen
```

### Werkbank-Status

**Datei:** `apps/api/src/services/swarm-topology/hierarchical.ts:285-444`

Unsere Impl hat genau einen Pfad: Director plant → Workers parallel → Director eval. Das entspricht dem Default `director_feedback_on=True, agent_as_judge=False, parallel_execution=True, planning_enabled=True`.

**Schema (`swarm-schemas.ts:80-82`):**
```typescript
// hierarchical
maxDirectorLoops:           z.number().int().min(1).max(10).default(3),
hierarchicalPresetAgents:   z.boolean().default(false),
```

### Gap-Analyse

| Reference-Feature | Werkbank | Severity |
|---|---|---|
| `director_feedback_on=True` (default) | ✅ Director self-eval | — |
| `agent_as_judge=True` (dedicated judge) | ❌ keine Schema-Option | NIEDRIG |
| `director_feedback_on=False` (skip eval) | ❌ unsere Impl macht immer Eval | NIEDRIG |
| `parallel_execution=False` | ❌ Worker laufen immer parallel | NIEDRIG |
| `planning_enabled=False` | ❌ Planning-Phase nicht überspringbar | NIEDRIG |

**Severity NIEDRIG-Begründung:** Diese Flags sind alle Variant-Switches, der Default-Pfad (alle True außer agent_as_judge) ist abgedeckt. Wer `parallel_execution=False` braucht (langsame APIs?) muss heute gleich auf `sequential` topology wechseln.

---

## 6. Bewusste Deviations (kein Gap, dokumentiert)

Die folgenden Reference-Features sind **absichtlich** nicht portiert worden. Jede ist im Header der jeweiligen TS-Datei dokumentiert.

| Pattern | Topologien | Werkbank-Begründung |
|---|---|---|
| LiteLLM tool-calling für structured output | `heavy-swarm` | replaced with JSON-on-blackboard (`heavy-swarm.ts:14-21`) |
| `tenacity.retry` auf agent failure | `round-robin` | run-DB captures failures (`round-robin.ts:32-37`) |
| Drift-threshold rerun-loop | `sequential` | unbounded token cost ohne stop-guarantee (`sequential.ts:24-32`) |
| `H` token (human-in-the-loop) | `agent-rearrange` | kein REPL-Channel im werkbank (`agent-rearrange.ts:14-15`) |
| `memory_system` / `autosave` | `agent-rearrange`, `sequential`, `hierarchical` | run-DB ist authoritative (`agent-rearrange.ts:17-19`) |
| `priority-speaker` (per-id weights) | `groupchat` | extra config-feld nötig, durch `random` und Selection-by-omission abgedeckt (`groupchat.ts:14-19`) |
| Checkpoint-resume (file-based JSON) | `graph-workflow` | run-DB + Replay decken state-recovery ab (`graph-workflow.ts:23-26`) |
| `interactive` REPL mode | `groupchat`, `hierarchical` | werkbank hat Browser-UI, kein Terminal-REPL |
| `run_batch` / `run_async` / `run_concurrently` | mehrere | single-task-per-run-Modell (1 SwarmConfig = 1 Goal) |
| `use_grok_agents` (3 hardcoded) / `use_grok_heavy` (15 hardcoded) | `heavy-swarm` | unsere N-flexible Variante deckt es ab (`heavy-swarm.ts:35-49`) |
| Rich-Terminal-Dashboards | `hierarchical`, `heavy-swarm` | UI-Layer ist Browser-Terrain |
| `random_model_name` | `council-as-judge` | werkbank-Modelle werden per Coordinator explizit gewählt |
| networkx/rustworkx | `graph-workflow` | replaced mit in-handler Kahn (`graph-workflow.ts:24-25`) |
| GraphViz Visualisierung | `graph-workflow` | UI-Concern, nicht im Backend |

---

## 7. Fix-Vorschläge

### Fix 1: `sequentialLoops` für sequential.ts

**Schema (`apps/api/src/swarm-schemas.ts`):**

```typescript
// sequential
sequentialDriftDetection: z.boolean().default(false),
+ /** Number of times the entire pipeline is re-executed. Subsequent loops use the prior loop's final stage as the new "previous_output" seed for stage 1. */
+ sequentialLoops:          z.number().int().min(1).max(5).default(1),
```

**Handler (`apps/api/src/services/swarm-topology/sequential.ts`):**

Äußerer Loop um die existierende Pipeline-Schleife. Pro Loop schreiben wir die Stage-Outputs unter loop-spezifischem Key, der `priorOutputsJson` macht weiter wie bisher pro Stage. Zwischen Loops: der letzte Stage-Output von Loop N wird `previous_output` für Stage 1 von Loop N+1.

```typescript
async run(ctx: RunContext): Promise<void> {
  const totalLoops = ctx.config.topologyOptions?.sequentialLoops ?? 1;
  ...
  let priorLoopFinal = '';

  for (let loop = 1; loop <= totalLoops; loop++) {
    if (ctx.abort.signal.aborted) break;

    emitTopologyEvent(ctx, 'topology:phase_change', {
      topology: 'sequential', phase: 'loop_start', loop, totalLoops,
    });

    for (let idx = 0; idx < pipeline.length; idx++) {
      ...
      const previous = idx === 0
        ? (priorLoopFinal || '(no prior stage — you are the first stage of this pipeline)')
        : readKey(ctx, stageKey(loop, stage - 1, pipeline[idx - 1]!.id));
      ...
    }
    priorLoopFinal = readKey(ctx, stageKey(loop, pipeline.length, pipeline.at(-1)!.id));
  }

  // drift judge danach (wie bisher)
}
```

**Aufwand:** ~30 Zeilen Code. `stageKey` muss um `loop` erweitert werden, sonst Kollision zwischen Loops.

### Fix 2: `plannerWorkerLoops` mit verdict-driven Iteration

**Schema (`apps/api/src/swarm-schemas.ts`):**

```typescript
// planner-worker
plannerWorkerPresetAgents: z.boolean().default(false),
+ /** Number of full Planner → Workers → Judge cycles. Judge can early-break with is_complete=true; gaps + follow_up_instructions seed next planner. Requires a judge coordinator. */
+ plannerWorkerLoops:        z.number().int().min(1).max(5).default(1),
```

**Handler (`apps/api/src/services/swarm-topology/planner-worker.ts`):**

Verdict-JSON parsen (analog zum hierarchical-Pattern), dann äußeren Loop um Phase-1/2/3.

```typescript
interface CycleVerdict {
  is_complete:            boolean;
  overall_quality:        number;
  summary:                string;
  gaps:                   string[];
  follow_up_instructions: string;
  needs_fresh_start:      boolean;
}

function parseCycleVerdict(raw: string): CycleVerdict | null {
  // analog hierarchical.ts parseDirectorVerdict — strip fence, JSON.parse, shape-check
  ...
}

async run(ctx: RunContext): Promise<void> {
  const totalLoops = ctx.config.topologyOptions?.plannerWorkerLoops ?? 1;
  ...
  let verdict: CycleVerdict | null = null;

  for (let cycle = 1; cycle <= totalLoops; cycle++) {
    if (ctx.abort.signal.aborted) break;

    // _prepare_next_cycle (analog Python:816)
    if (cycle > 1 && verdict) {
      if (verdict.needs_fresh_start) {
        ctx.runDb.exec('DELETE FROM swarm_tasks');
      } else {
        ctx.runDb.exec("DELETE FROM swarm_tasks WHERE status NOT IN ('completed','failed')");
      }
    }

    // Phase 1: Planner — auf Cycle > 1 mit gap-Kontext
    const plannerVars = cycle === 1
      ? sharedVars
      : { ...sharedVars,
          previous_gaps:           verdict!.gaps.join('\n- '),
          previous_followup:       verdict!.follow_up_instructions,
          previous_quality:        String(verdict!.overall_quality),
        };
    await spawnCoordinator(planner, ctx, plannerVars);
    ...

    // Phase 2: Workers (wie bisher)
    await runCoordinatorsInParallel(...);

    // Phase 3: Judge — verdict aus Blackboard parsen
    if (judge) {
      await spawnCoordinator(judge, ctx, { task_report: renderTaskReport(ctx), ... });
      const rawVerdict = readKey(ctx, 'planner_worker:verdict');
      verdict = parseCycleVerdict(rawVerdict);

      if (verdict?.is_complete) break;  // early-exit
    }
  }
}
```

**Planner-Prompt** muss um `{{previous_gaps}}` / `{{previous_followup}}` Templates erweitert werden, damit der Planner im 2.+ Cycle den Verdict-Kontext sieht.

**Aufwand:** ~80 Zeilen Code (Verdict-Schema, parseCycleVerdict, Cycle-Loop, fresh-start logic, planner-prompt-erweiterung).

### Fix 3 (optional, niedrig priorisiert): `hierarchical` Variant-Flags

| Flag | Aufwand | Empfehlung |
|---|---|---|
| `agent_as_judge` (separater Judge) | ~50 Zeilen — neue Rollen-Resolution + neue Eval-Phase | Aufschieben — selten gebrauchter Pfad |
| `director_feedback_on=False` (skip eval) | ~10 Zeilen — if-Guard um Phase 3 | Aufschieben — Default ist sinnvoll |
| `parallel_execution=False` | ~15 Zeilen — Promise.all → for-await | Aufschieben — `sequential` Topologie deckt das ab |
| `planning_enabled=False` | ~30 Zeilen — Phase 1 überspringen, Director nimmt Goal direkt | Aufschieben — kein klarer Use-Case |

Diese Flags sind alle Variant-Switches der gleichen Topologie. Für `werkbank` würde man sie aggregiert als `hierarchicalMode: 'with-eval' | 'no-eval' | 'with-dedicated-judge'` Enum exposing — aber das lohnt sich erst, wenn ein User-Use-Case auftaucht.

---

## 8. Empfohlene Reihenfolge

1. **Fix 2 first** — `planner-worker` multi-cycle ist der größte Funktionsverlust, weil das Iterative-Refinement-Pattern das **Hauptmotiv** der Topologie im Original ist. Ohne max_loops > 1 ist der Judge im Werkbank-Pattern fast dekorativ.

2. **Fix 1 second** — `sequential` max_loops ist konzeptuell einfacher (nur ein äußerer Loop), aber der Use-Case (iterative Pipeline-Verbesserung) ist seltener als planner-worker iterations.

3. **Fix 3 später** — die hierarchical Variant-Flags warten auf konkrete User-Anforderungen.

---

## 9. Validation der Fixes

Nach Implementation:

1. **Schema-Migration:** Beide Optionen sind additive Erweiterungen mit Defaults — keine bestehenden Configs brechen.

2. **Test-Configs für non-default Pfade** in `metadata.ts` ergänzen:
   - `sequential` Sample mit `sequentialLoops: 2`
   - `planner-worker` Sample mit `plannerWorkerLoops: 3`

3. **Smoke-Test:** Run starten, prüfen ob:
   - `topology:phase_change` Events pro Loop emittiert werden (Replay-View muss das verkraften)
   - `swarm_tasks`-Tabelle bei `needs_fresh_start=true` korrekt geleert wird
   - Early-break bei `is_complete=true` keine Phase-3-Spawns mehr triggert

4. **Backwards-Compat:** Existing Configs ohne die neuen Optionen verhalten sich exakt wie bisher (default = 1 Loop, single cycle).

---

## 10. Quellen-Index

| Topologie | Reference (Python) | Werkbank-Impl (TS) |
|---|---|---|
| concurrent          | — (trivial)                                                           | `apps/api/src/services/swarm-topology/concurrent.ts` |
| sequential          | `_reference/swarms/structs/sequential_workflow.py`                    | `apps/api/src/services/swarm-topology/sequential.ts` |
| mixture-of-agents   | `_reference/swarms/structs/mixture_of_agents.py`                      | `apps/api/src/services/swarm-topology/mixture-of-agents.ts` |
| majority-voting     | `_reference/swarms/structs/majority_voting.py`                        | `apps/api/src/services/swarm-topology/majority-voting.ts` |
| debate-with-judge   | `_reference/swarms/structs/debate_with_judge.py`                      | `apps/api/src/services/swarm-topology/debate-with-judge.ts` |
| hierarchical        | `_reference/swarms/structs/hiearchical_swarm.py`                      | `apps/api/src/services/swarm-topology/hierarchical.ts` |
| planner-worker      | `_reference/swarms/structs/planner_worker_swarm.py` + `schemas/planner_worker_schemas.py` | `apps/api/src/services/swarm-topology/planner-worker.ts` |
| round-robin         | `_reference/swarms/structs/round_robin.py`                            | `apps/api/src/services/swarm-topology/round-robin.ts` |
| council-as-judge    | `_reference/swarms/structs/council_as_judge.py`                       | `apps/api/src/services/swarm-topology/council-as-judge.ts` |
| groupchat           | `_reference/swarms/structs/groupchat.py`                              | `apps/api/src/services/swarm-topology/groupchat.ts` |
| heavy-swarm         | `_reference/swarms/structs/heavy_swarm.py`                            | `apps/api/src/services/swarm-topology/heavy-swarm.ts` |
| agent-rearrange     | `_reference/swarms/structs/agent_rearrange.py`                        | `apps/api/src/services/swarm-topology/agent-rearrange.ts` |
| graph-workflow      | `_reference/swarms/structs/graph_workflow.py`                         | `apps/api/src/services/swarm-topology/graph-workflow.ts` |

Schema-Datei: `apps/api/src/swarm-schemas.ts`
Dispatcher: `apps/api/src/services/swarm-topology/index.ts`
Metadata: `apps/api/src/services/swarm-topology/metadata.ts`
