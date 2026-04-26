/**
 * Hierarchical topology — one Director coordinator plans and delegates to N
 * Worker coordinators in iterative loops. Each loop: director writes a
 * SwarmSpec-shaped JSON plan to the blackboard, the handler dispatches
 * per-worker assignments, workers write outputs back, then the director
 * evaluates and decides whether to continue.
 *
 * Ported from kyegomez/swarms `HierarchicalSwarm` (Apache-2.0). The Python
 * original uses Pydantic `SwarmSpec` as an OpenAI structured-output
 * `response_format`; werkbank has no equivalent path because coordinators are
 * Claude-CLI subprocesses that emit MCP tool calls, not return values. So the
 * director is *prompted* to write strict JSON to the blackboard and the
 * handler parses it. On parse failure we emit `coordinator:error` and abort
 * the loop instead of retrying — keeping the failure mode loud and isolated
 * (special-general decomposition: the malformed-spec path doesn't pollute the
 * happy path).
 *
 * Mapping reference → werkbank:
 *   SwarmSpec(plan, orders[])              → blackboard "hierarchical:assignments" (JSON)
 *   parse_orders(director_output)          → JSON.parse of "hierarchical:assignments"
 *   call_single_agent(agent_name, task)    → spawnCoordinator(worker, ctx, vars)
 *                                            with assignment in "hierarchical:assignment:<id>"
 *   agent.run() return value               → worker writes to "hierarchical:result:<id>"
 *   feedback_director(outputs)             → director re-spawned in 'evaluation' phase,
 *                                            writes "hierarchical:director_verdict"
 *                                            ({ continue: bool, feedback: string })
 *   while current_loop < max_loops         → for loop in 1..maxDirectorLoops, early-exit
 *                                            when verdict.continue === false
 *   HIEARCHICAL_SWARM_SYSTEM_PROMPT        → DIRECTOR_SYSTEM_PROMPT (preset)
 *   MULTI_AGENT_COLLAB_PROMPT_TWO + roster → WORKER_SYSTEM_PROMPT (preset)
 *
 * Role resolution: exactly one coordinator with role substring "director";
 * all others are workers (>= 1). Matched case-insensitively, like debate's
 * pro/con/judge resolution.
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  runCoordinatorsInParallel,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Preset prompts (semantics ported from hiearchical_system_prompt.py) ────

const DIRECTOR_SYSTEM_PROMPT = `**SYSTEM PROMPT: HIERARCHICAL AGENT DIRECTOR**

You are a Hierarchical Agent Director — the central orchestrator responsible for breaking down overarching goals into granular tasks and intelligently assigning these tasks to the most suitable worker agents within the swarm. Your objective is to maximize overall performance by ensuring that every agent is given a task aligned with its strengths.

**Core Operating Principles**

1. Goal Alignment: Begin every operation by clearly reviewing the swarm's overall goals. Ensure every assigned task contributes directly to those objectives.
2. Task Decomposition: Break the goal into discrete, actionable subtasks. Avoid overly broad tasks; subdivide until each task can be executed by a single worker.
3. Agent Profiling and Matching: Match tasks to workers based on their declared role and capabilities. Do not invent workers that are not on the roster.
4. Adherence to Rules: Every order must comply with the operational rules. Be transparent and auditable — the plan field is your reasoning trail.
5. Iterative Refinement: After each round, evaluate worker outputs and decide whether another round is needed. Refine, do not repeat verbatim.

**Hierarchical Order Construction**

For each task you assign, produce a HierarchicalOrder containing:
  - agent_name: must exactly match one of the worker IDs from the roster below.
  - task: a clear, unambiguous instruction. Detail both the WHAT and the HOW.

---

**Werkbank protocol** (you are coordinator {{id}}, the Director, loop {{loop}}/{{max_loops}}):

Goal: {{goal}}
Worker roster (only assign to these IDs):
{{worker_roster}}

Prior loop history (empty on the first loop):
{{prior_history}}

**YOUR TASK FOR THIS LOOP**

Step 1 — Read the blackboard key 'hierarchical:results_summary' (it contains worker outputs from the previous loop, if any). On loop 1 it will be empty.

Step 2 — Produce a SwarmSpec-shaped JSON object with EXACTLY this schema:
\`\`\`json
{
  "plan": "<string: your reasoning and strategy for this loop>",
  "orders": [
    { "agent_name": "<worker-id>", "task": "<clear, actionable instruction>" }
  ]
}
\`\`\`

Constraints:
- Output MUST be valid JSON. No markdown fences, no comments, no trailing commas.
- Every \`agent_name\` MUST be present in the worker roster above.
- Provide at least one order. You MAY assign multiple orders to the same worker.
- The \`plan\` field is a free-form string — your audit trail.

Step 3 — Write the JSON object as a STRING to blackboard key 'hierarchical:assignments' (overwrite). Then call terminate(). Do not exceed {{max_turns_hint}} turns.`;

const DIRECTOR_EVALUATION_PROMPT = `**SYSTEM PROMPT: HIERARCHICAL AGENT DIRECTOR — EVALUATION PHASE**

You are a Hierarchical Agent Director reviewing worker outputs from loop {{loop}}/{{max_loops}}. Carefully analyze the results, decide whether the goal has been met to a high standard, and either signal completion or request another iteration with specific feedback.

---

**Werkbank protocol** (you are coordinator {{id}}, evaluation phase, loop {{loop}}/{{max_loops}}):

Goal: {{goal}}

Worker outputs from this loop:
{{worker_results}}

Loops remaining after this one: {{loops_remaining}}

**YOUR TASK**

Step 1 — Carefully review every worker output above. Identify strengths, weaknesses, and any missing pieces relative to the original goal.

Step 2 — Decide:
- If the goal is sufficiently addressed OR no loops remain, signal completion (\`continue: false\`).
- Otherwise, provide concrete, actionable feedback to guide the next loop (\`continue: true\`).

Step 3 — Produce a JSON object with EXACTLY this schema:
\`\`\`json
{
  "continue": <true|false>,
  "feedback": "<string: specific guidance for the next loop, or final assessment if continue=false>"
}
\`\`\`

Constraints:
- Output MUST be valid JSON. No markdown fences, no comments.
- If \`loops_remaining\` is 0 you MUST set \`continue: false\` (the loop ends regardless).

Step 4 — Write the JSON object as a STRING to blackboard key 'hierarchical:director_verdict' (overwrite). Then call terminate(). Do not exceed {{max_turns_hint}} turns.`;

const WORKER_SYSTEM_PROMPT = `You are a worker agent in a hierarchical swarm coordinated by a Director.

Your role: {{role}}
Your worker id: {{id}}

Operational guidelines:
- Read your assignment carefully and execute it precisely.
- Stay within scope — do not invent additional tasks the Director did not assign.
- If clarification is needed you may note it in your output, but still produce the best result you can.
- Be concise yet comprehensive. State assumptions and limitations explicitly.

---

**Werkbank protocol** (you are coordinator {{id}}, a Worker, loop {{loop}}/{{max_loops}}):

Goal of the swarm: {{goal}}

Your assignment for this loop (from the Director):
{{assignment}}

Prior worker outputs from this loop (may be empty if you are first):
{{peer_outputs}}

**YOUR TASK**

Step 1 — Read your assignment above and execute it.

Step 2 — Write your final output as a STRING to blackboard key '{{result_key}}' (overwrite). The output should be self-contained — the Director will read this directly.

Step 3 — Call terminate(). Do not exceed {{max_turns_hint}} turns.`;

// ─── Role resolution ────────────────────────────────────────────────────────

interface HierarchicalRoles {
  director: CoordinatorConfig;
  workers:  CoordinatorConfig[];
}

function resolveHierarchicalRoles(coordinators: CoordinatorConfig[]): HierarchicalRoles | null {
  const directors = coordinators.filter(c => c.role.toLowerCase().includes('director'));
  if (directors.length !== 1) return null;
  const director = directors[0]!;
  const workers = coordinators.filter(c => c.id !== director.id);
  if (workers.length < 1) return null;
  return { director, workers };
}

// ─── Blackboard helpers (handler-owned, mirrors mixture-of-agents) ──────────

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

function withPresetPrompt(coord: CoordinatorConfig, prompt: string): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: prompt };
}

// ─── SwarmSpec parsing ──────────────────────────────────────────────────────

interface HierarchicalOrder {
  agent_name: string;
  task:       string;
}

interface SwarmSpec {
  plan:   string;
  orders: HierarchicalOrder[];
}

interface DirectorVerdict {
  continue: boolean;
  feedback: string;
}

/**
 * Parse the director's JSON output. Accepts either bare JSON or JSON wrapped
 * in a markdown fence (```json ... ```), since LLMs occasionally still wrap
 * despite instructions. Returns null on any parse/shape failure — the caller
 * decides how to surface the error.
 */
function parseSwarmSpec(raw: string): SwarmSpec | null {
  const cleaned = stripFence(raw).trim();
  if (!cleaned) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['plan'] !== 'string') return null;
  if (!Array.isArray(obj['orders'])) return null;
  const orders: HierarchicalOrder[] = [];
  for (const item of obj['orders'] as unknown[]) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    if (typeof o['agent_name'] !== 'string' || typeof o['task'] !== 'string') return null;
    orders.push({ agent_name: o['agent_name'], task: o['task'] });
  }
  return { plan: obj['plan'], orders };
}

function parseDirectorVerdict(raw: string): DirectorVerdict | null {
  const cleaned = stripFence(raw).trim();
  if (!cleaned) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['continue'] !== 'boolean') return null;
  if (typeof obj['feedback'] !== 'string') return null;
  return { continue: obj['continue'], feedback: obj['feedback'] };
}

function stripFence(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenceMatch ? fenceMatch[1]! : raw;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const hierarchicalHandler: TopologyHandler = {
  topology: 'hierarchical',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 2) {
      errors.push(`hierarchical requires at least 2 coordinators (1 director + >=1 worker), got ${config.coordinators.length}`);
    }
    const roles = resolveHierarchicalRoles(config.coordinators);
    if (!roles) {
      errors.push('hierarchical needs exactly one coordinator whose role contains "director"; the rest are workers (>= 1)');
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const roles = resolveHierarchicalRoles(ctx.config.coordinators);
    if (!roles) return;

    const maxLoops      = ctx.config.topologyOptions?.maxDirectorLoops      ?? 3;
    const usePresets    = ctx.config.topologyOptions?.hierarchicalPresetAgents ?? false;

    const directorPlanCoord = usePresets
      ? withPresetPrompt(roles.director, DIRECTOR_SYSTEM_PROMPT)
      : roles.director;
    const directorEvalCoord = usePresets
      ? withPresetPrompt(roles.director, DIRECTOR_EVALUATION_PROMPT)
      : roles.director;
    const workerCoords = usePresets
      ? roles.workers.map(w => withPresetPrompt(w, WORKER_SYSTEM_PROMPT))
      : roles.workers;

    const workerRoster = roles.workers
      .map(w => `- ${w.id} (${w.role || 'worker'})`)
      .join('\n');

    // History accumulates across loops so the director can see the trajectory.
    let priorHistory = '';

    for (let loop = 1; loop <= maxLoops; loop++) {
      if (ctx.abort.signal.aborted) break;

      // ── Phase 1: Director plans ──────────────────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology: 'hierarchical',
        loop,
        phase:    'director',
      });

      await spawnCoordinator(directorPlanCoord, ctx, {
        loop:           String(loop),
        max_loops:      String(maxLoops),
        worker_roster:  workerRoster,
        prior_history:  priorHistory || '(no prior loops)',
        max_turns_hint: String(directorPlanCoord.maxTurns ?? 12),
      });
      if (ctx.abort.signal.aborted) break;

      const rawSpec = readKey(ctx, 'hierarchical:assignments');
      const spec    = parseSwarmSpec(rawSpec);
      if (!spec) {
        emitTopologyEvent(ctx, 'coordinator:error', {
          agentId: roles.director.id,
          message: `Failed to parse SwarmSpec JSON from blackboard key 'hierarchical:assignments' on loop ${loop}.`,
          rawExcerpt: rawSpec.slice(0, 500),
        });
        break;
      }

      // Validate that every assigned agent_name is a real worker; drop bogus orders.
      const workerById = new Map(roles.workers.map(w => [w.id, w] as const));
      const validOrders = spec.orders.filter(o => workerById.has(o.agent_name));
      if (validOrders.length === 0) {
        emitTopologyEvent(ctx, 'coordinator:error', {
          agentId: roles.director.id,
          message: `Director produced ${spec.orders.length} order(s) on loop ${loop}, none reference a known worker id.`,
        });
        break;
      }

      // Stage per-worker assignments before the workers spawn. A worker may
      // receive multiple orders (concatenated); workers without any order are
      // simply not spawned this loop.
      const ordersByWorker = new Map<string, string[]>();
      for (const order of validOrders) {
        const list = ordersByWorker.get(order.agent_name) ?? [];
        list.push(order.task);
        ordersByWorker.set(order.agent_name, list);
      }
      for (const [workerId, tasks] of ordersByWorker) {
        const assignment = tasks.length === 1
          ? tasks[0]!
          : tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');
        writeKey(ctx, `hierarchical:assignment:${workerId}`, assignment);
      }

      // Clear stale per-worker results from previous loops so the director's
      // evaluation phase only sees outputs from this loop.
      for (const worker of roles.workers) {
        writeKey(ctx, `hierarchical:result:${worker.id}`, '');
      }

      // ── Phase 2: Workers execute in parallel ────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology: 'hierarchical',
        loop,
        phase:    'workers',
      });

      const assignedWorkers = workerCoords.filter(w => ordersByWorker.has(w.id));
      const peerOutputsSnapshot = ''; // parallel workers don't see each other in this loop

      await runCoordinatorsInParallel(
        assignedWorkers.map(worker => () => spawnCoordinator(worker, ctx, {
          loop:           String(loop),
          max_loops:      String(maxLoops),
          assignment:     readKey(ctx, `hierarchical:assignment:${worker.id}`),
          peer_outputs:   peerOutputsSnapshot || '(no peer outputs visible during this layer)',
          result_key:     `hierarchical:result:${worker.id}`,
          max_turns_hint: String(worker.maxTurns ?? 8),
        })),
      );
      if (ctx.abort.signal.aborted) break;

      // ── Phase 3: Director evaluates ─────────────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology: 'hierarchical',
        loop,
        phase:    'evaluation',
      });

      const resultsBlocks: string[] = [];
      for (const worker of roles.workers) {
        const out = readKey(ctx, `hierarchical:result:${worker.id}`);
        if (out) resultsBlocks.push(`## ${worker.id} (${worker.role || 'worker'}):\n${out}`);
      }
      const resultsSummary = resultsBlocks.join('\n\n') || '(no worker outputs were produced this loop)';
      // Make the summary available to the next director plan-phase too.
      writeKey(ctx, 'hierarchical:results_summary', resultsSummary);

      const loopsRemaining = maxLoops - loop;

      await spawnCoordinator(directorEvalCoord, ctx, {
        loop:            String(loop),
        max_loops:       String(maxLoops),
        loops_remaining: String(loopsRemaining),
        worker_results:  resultsSummary,
        max_turns_hint:  String(directorEvalCoord.maxTurns ?? 8),
      });
      if (ctx.abort.signal.aborted) break;

      const rawVerdict = readKey(ctx, 'hierarchical:director_verdict');
      const verdict    = parseDirectorVerdict(rawVerdict);
      if (!verdict) {
        emitTopologyEvent(ctx, 'coordinator:error', {
          agentId: roles.director.id,
          message: `Failed to parse director verdict JSON from blackboard key 'hierarchical:director_verdict' on loop ${loop}.`,
          rawExcerpt: rawVerdict.slice(0, 500),
        });
        break;
      }

      // Append this loop's plan + results + verdict to the running history.
      priorHistory = [
        priorHistory,
        `# Loop ${loop}`,
        `## Director plan:\n${spec.plan}`,
        `## Worker results:\n${resultsSummary}`,
        `## Director verdict (continue=${verdict.continue}):\n${verdict.feedback}`,
      ].filter(Boolean).join('\n\n');

      if (!verdict.continue) break;
      if (loopsRemaining === 0) break;
    }
  },
};
