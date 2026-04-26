/**
 * Graph-workflow topology — DAG-based coordinator scheduling. The user
 * supplies directed edges; the handler computes topological layers
 * (Kahn's algorithm), runs each layer's nodes in parallel, layers in
 * sequence. Each node sees the outputs of all its predecessors as
 * context.
 *
 * Ported from kyegomez/swarms `GraphWorkflow` (Apache-2.0). The Python
 * original uses networkx (or rustworkx) for graph operations and supports
 * checkpoint resume, conditional edges, multimodal inputs, and JSON
 * serialisation. This port keeps the core scheduling primitive — DAG
 * topological sort + per-layer parallel execution + multi-loop with
 * end-node feedback — and drops everything else:
 *
 *   - networkx is replaced by an in-handler Kahn's algorithm
 *   - checkpoint dirs (file-based JSON resume) are dropped — werkbank's
 *     run-DB already records every output and replay restores state
 *   - conditional edges, dynamic graph mutations, and runtime add-node
 *     are not modelled (the DAG is fixed at config time)
 *   - JSON serialisation / GraphViz visualisation belongs in the UI
 *
 * Mapping reference → werkbank:
 *   self.add_edge(source, target)                        → graphWorkflowEdges: [from,to][]
 *   self.compile() + topological_generations()           → kahnLayers() — same algorithm, in TS
 *   self.entry_points / self.end_points (auto-detected)  → derived from in-degrees / out-degrees
 *   self._build_prompt(node, prev_outputs, …)            → spawnCoordinator with predecessor_outputs / position vars
 *   _run_node (ThreadPoolExecutor)                       → runCoordinatorsInParallel
 *   prior_loop_end_outputs (multi-loop carryover)        → handler reads end-node results, seeds next loop's entry context
 *   GRAPH_WORKFLOW_PROMPT (DAG-aware system prompt)      → GRAPH_WORKFLOW_PROMPT (preset, embedded below)
 *
 * Source: D:/programme/swarms-concept/_reference/swarms/structs/graph_workflow.py
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  runCoordinatorsInParallel,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built DAG-aware prompt (semantics from graph_workflow.py:_build_prompt) ─

const GRAPH_WORKFLOW_PROMPT = `You are a node in a directed-acyclic graph (DAG) workflow. The graph defines explicit dependencies — your immediate predecessors produce inputs you depend on, your immediate successors will consume your output.

DAG principles:
- Predecessors have already finished and their outputs are visible below
- Successors will see your output along with any other input they depend on
- Nodes in the same layer (same depth from entry points) run in parallel and don't see each other's output during this layer

---
Werkbank protocol (you are coordinator {{id}}, layer {{layer_n}}/{{total_layers}}, loop {{loop}}/{{total_loops}}):

Original goal: {{goal}}

Your immediate predecessors (whose outputs you may depend on):
{{predecessor_list}}

Your immediate successors (who will consume your output):
{{successor_list}}

Predecessor outputs (concatenated, one block per predecessor):

{{predecessor_outputs}}

Prior-loop end-node outputs (empty on the first loop):
{{prior_loop_outputs}}

---

YOUR TASK THIS TURN:
1. Read the predecessor outputs above (they're your direct inputs).
2. As {{id}} ({{role}}), produce your contribution to the graph at this node.
3. Be specific; reference predecessors where relevant; produce something your successors can build on.
4. Write your full output as a STRING to blackboard key '{{result_key}}' (overwrite). The handler stages it for your successors.
5. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

// ─── DAG validation + topological layering (Kahn's algorithm) ───────────────

interface DagAnalysis {
  layers:       string[][];           // each layer = ids that run in parallel
  predsById:    Map<string, string[]>;// inbound edges (predecessor ids)
  succsById:    Map<string, string[]>;// outbound edges (successor ids)
  endPoints:    string[];             // ids with no successors
}

interface DagValidation {
  valid:    boolean;
  errors:   string[];
  analysis?: DagAnalysis;
}

/**
 * Validate the DAG against the coordinator roster and compute topological
 * layers via Kahn's algorithm. A failed validation never returns analysis.
 * Behavior matches networkx.topological_generations().
 */
function validateAndLayer(
  edges:    readonly (readonly [string, string])[],
  nodeIds:  readonly string[],
): DagValidation {
  const errors:    string[]              = [];
  const knownIds  = new Set(nodeIds);
  const predsById = new Map<string, string[]>();
  const succsById = new Map<string, string[]>();
  for (const id of nodeIds) {
    predsById.set(id, []);
    succsById.set(id, []);
  }

  for (const [from, to] of edges) {
    if (from === to) {
      errors.push(`graphWorkflowEdges contains a self-loop on "${from}"`);
      continue;
    }
    if (!knownIds.has(from)) errors.push(`graphWorkflowEdges references unknown node id "${from}" (must be a coordinator id)`);
    if (!knownIds.has(to))   errors.push(`graphWorkflowEdges references unknown node id "${to}" (must be a coordinator id)`);
    if (knownIds.has(from) && knownIds.has(to)) {
      predsById.get(to)!.push(from);
      succsById.get(from)!.push(to);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // Kahn's algorithm — process nodes in topological-generation order.
  const indeg = new Map<string, number>(nodeIds.map(id => [id, predsById.get(id)!.length] as const));
  const layers: string[][] = [];
  const remaining = new Set(nodeIds);

  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const id of remaining) {
      if ((indeg.get(id) ?? 0) === 0) layer.push(id);
    }
    if (layer.length === 0) {
      // Cycle: nodes left over but none have zero in-degree.
      const cycleNodes = [...remaining].sort();
      errors.push(`graphWorkflowEdges contains a cycle (involves: ${cycleNodes.join(', ')})`);
      return { valid: false, errors };
    }
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      for (const succ of succsById.get(id) ?? []) {
        indeg.set(succ, (indeg.get(succ) ?? 0) - 1);
      }
    }
  }

  const endPoints = nodeIds.filter(id => (succsById.get(id)?.length ?? 0) === 0);
  return { valid: true, errors: [], analysis: { layers, predsById, succsById, endPoints } };
}

// ─── Blackboard helpers (handler-owned, mirrors agent-rearrange) ────────────

function readKey(ctx: RunContext, key: string): string {
  const row = ctx.runDb
    .prepare('SELECT value FROM blackboard WHERE key = ? AND is_current = 1')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function writeKey(ctx: RunContext, key: string, value: string): void {
  ctx.runDb.transaction(() => {
    ctx.runDb.prepare('UPDATE blackboard SET is_current = 0 WHERE key = ? AND is_current = 1').run(key);
    const vRow = ctx.runDb
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM blackboard WHERE key = ?')
      .get(key) as { v: number };
    ctx.runDb.prepare(
      'INSERT INTO blackboard (key, value, version, written_by, written_at, is_current) VALUES (?, ?, ?, ?, ?, 1)',
    ).run(key, value, vRow.v, 'swarm', Date.now());
  })();
}

function withPresetPrompt(coord: CoordinatorConfig): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: GRAPH_WORKFLOW_PROMPT };
}

function nodeResultKey(loop: number, id: string): string {
  return `graph:loop_${loop}:result:${id}`;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const graphWorkflowHandler: TopologyHandler = {
  topology: 'graph-workflow',

  validate(config: SwarmConfig): TopologyValidation {
    const edges  = config.topologyOptions?.graphWorkflowEdges ?? [];
    const nodeIds = config.coordinators.map(c => c.id);
    const result = validateAndLayer(edges, nodeIds);
    return { valid: result.valid, errors: result.errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const edges      = ctx.config.topologyOptions?.graphWorkflowEdges        ?? [];
    const totalLoops = ctx.config.topologyOptions?.graphWorkflowLoops        ?? 1;
    const usePreset  = ctx.config.topologyOptions?.graphWorkflowPresetAgents ?? false;

    const nodeIds = ctx.config.coordinators.map(c => c.id);
    const result  = validateAndLayer(edges, nodeIds);
    if (!result.valid || !result.analysis) return;
    const { layers, predsById, succsById, endPoints } = result.analysis;

    const byId = new Map(
      ctx.config.coordinators.map(c => [c.id, usePreset ? withPresetPrompt(c) : c] as const),
    );

    let priorLoopOutputs = '';

    for (let loop = 1; loop <= totalLoops; loop++) {
      if (ctx.abort.signal.aborted) break;

      // Clear prior loop's per-node results so the predecessor lookup
      // below picks up only outputs produced in THIS loop.
      for (const id of nodeIds) writeKey(ctx, nodeResultKey(loop, id), '');

      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        if (ctx.abort.signal.aborted) break;
        const layer = layers[layerIdx]!;

        emitTopologyEvent(ctx, 'topology:phase_change', {
          topology:    'graph-workflow',
          phase:       'layer',
          loop,
          totalLoops,
          layerNumber: layerIdx + 1,
          totalLayers: layers.length,
          layerNodes:  layer,
        });

        await runCoordinatorsInParallel(
          layer.map(id => () => {
            const coord = byId.get(id)!;
            const preds = predsById.get(id) ?? [];
            const succs = succsById.get(id) ?? [];

            const predBlocks: string[] = [];
            for (const predId of preds) {
              const out = readKey(ctx, nodeResultKey(loop, predId));
              const predCoord = byId.get(predId)!;
              if (out) predBlocks.push(`## ${predId} (${predCoord.role || 'agent'}):\n${out}`);
            }
            const predecessorOutputs = predBlocks.length === 0
              ? '(no predecessors — you are an entry node)'
              : predBlocks.join('\n\n');

            return spawnCoordinator(coord, ctx, {
              loop:                String(loop),
              total_loops:         String(totalLoops),
              layer_n:             String(layerIdx + 1),
              total_layers:        String(layers.length),
              role:                coord.role,
              predecessor_list:    preds.length === 0 ? '(none — entry node)' : preds.join(', '),
              successor_list:      succs.length === 0 ? '(none — end node)'   : succs.join(', '),
              predecessor_outputs: predecessorOutputs,
              prior_loop_outputs:  priorLoopOutputs || '(no prior loop)',
              result_key:          nodeResultKey(loop, id),
              max_turns_hint:      String(coord.maxTurns ?? 8),
            });
          }),
        );
      }
      if (ctx.abort.signal.aborted) break;

      // Snapshot end-node outputs so the next loop's entry nodes can see
      // the previous iteration's "answer" (matches Python's
      // prior_loop_end_outputs carryover).
      const endBlocks: string[] = [];
      for (const id of endPoints) {
        const out = readKey(ctx, nodeResultKey(loop, id));
        const coord = byId.get(id)!;
        if (out) endBlocks.push(`## ${id} (${coord.role || 'agent'}):\n${out}`);
      }
      priorLoopOutputs = endBlocks.length === 0
        ? '(no end-node outputs were produced in the previous loop)'
        : `# Loop ${loop} end-node outputs:\n${endBlocks.join('\n\n')}`;
    }

    // Write a stable "final" key bundling end-node outputs for downstream consumers.
    writeKey(ctx, 'graph:final', priorLoopOutputs);
  },
};
