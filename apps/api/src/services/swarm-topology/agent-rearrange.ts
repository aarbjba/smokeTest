/**
 * Agent-rearrange topology — Flow-DSL scheduling. The user supplies a flow
 * string like `"research -> writer, reviewer -> editor"`; the handler runs
 * each `->`-separated step in order, and within a step runs `,`-separated
 * agents in parallel.
 *
 * Ported from kyegomez/swarms `AgentRearrange` (Apache-2.0). The Python
 * original supports memory_system, autosave, human-in-the-loop ("H" tokens),
 * custom_tasks, batch_run, async run, and structured output formatters. This
 * port keeps the core scheduling primitive — flow parsing + per-step
 * sequential/parallel execution — and drops everything else:
 *
 *   - "H" tokens (human-in-the-loop) are rejected at validate time. The
 *     werkbank has no REPL channel a coordinator could block on.
 *   - memory_system is replaced by the per-run blackboard.
 *   - custom_tasks, batch_run, async are not modelled.
 *
 * Mapping reference → werkbank:
 *   self.flow.split("->")                            → parseFlow() returns string[][]
 *   step.split(",")                                  → inner array of agent ids
 *   self.validate_flow()                             → validateFlow() — every id exists, no "H"
 *   _run_concurrent_workflow(agent_names)            → runCoordinatorsInParallel
 *   _run_sequential_workflow(agent_name, tasks)      → spawnCoordinator for the single agent
 *   self.conversation.add(role="User", task)         → blackboard "rearrange:conversation" seeded with goal
 *   _get_sequential_awareness(name, tasks, idx)      → per-spawn vars: agents_ahead / agents_behind / step_n
 *   _get_sequential_flow_info()                      → flow_structure template var (full flow listing)
 *   self.max_loops                                   → topologyOptions.agentRearrangeLoops
 *   AGENT_REARRANGE_PROMPT (team_awareness=True)     → AGENT_REARRANGE_PROMPT (preset, embedded below)
 *
 * Source: D:/programme/swarms-concept/_reference/swarms/structs/agent_rearrange.py
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  runCoordinatorsInParallel,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built flow-aware prompt (semantics from agent_rearrange.py:_get_sequential_awareness) ─

const AGENT_REARRANGE_PROMPT = `You are a member of an agent-rearrange flow. The flow string composes a workflow from sequential steps separated by "->" and parallel agents within a step separated by ",". Each agent sees the prior step's combined output and contributes their own output for the next step.

Flow principles:
- "step1 -> step2 -> step3": each step runs after the previous one finishes
- "agent_a, agent_b": agents in the same step run in parallel and don't see each other's output during that step
- Use the conversation history to build on prior steps; don't repeat what's already been done

---
Werkbank protocol (you are coordinator {{id}}, step {{step_n}}/{{total_steps}}, loop {{loop}}/{{total_loops}}):

Original goal: {{goal}}

Flow structure:
{{flow_structure}}

Sequential awareness:
{{awareness_line}}

Conversation history accumulated so far (one block per agent invocation):

{{conversation_so_far}}

---

YOUR TASK THIS TURN:
1. Read the conversation history above. Identify what prior steps produced.
2. As {{id}} ({{role}}), produce your contribution to step {{step_n}}. Be specific; build on prior steps.
3. Write your output as a STRING to blackboard key '{{step_output_key}}' (overwrite). The handler appends it to the conversation before the next step runs.
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

// ─── Flow parsing & validation ──────────────────────────────────────────────

const HUMAN_TOKEN = 'H';

/** Parse a flow string into [step][agent-id]. Trims whitespace. Empty input → []. */
function parseFlow(flow: string): string[][] {
  return flow
    .split('->')
    .map(step => step.split(',').map(s => s.trim()).filter(Boolean));
}

interface FlowValidation {
  valid:  boolean;
  errors: string[];
  steps:  string[][];
}

function validateFlow(flow: string, knownIds: ReadonlySet<string>): FlowValidation {
  const errors: string[] = [];
  if (!flow.trim()) {
    errors.push('agentRearrangeFlow is required (e.g. "agent_a -> agent_b, agent_c")');
    return { valid: false, errors, steps: [] };
  }
  if (!flow.includes('->')) {
    errors.push('agentRearrangeFlow must contain "->" to denote at least one step transition');
  }
  const steps = parseFlow(flow);
  if (steps.length < 2) {
    errors.push('agentRearrangeFlow must contain at least 2 steps separated by "->"');
  }
  for (const step of steps) {
    if (step.length === 0) {
      errors.push('agentRearrangeFlow contains an empty step (check for stray "->" or ",")');
      continue;
    }
    for (const id of step) {
      if (id === HUMAN_TOKEN) {
        errors.push(`agentRearrangeFlow contains "H" (human-in-the-loop) which is not supported in werkbank`);
        continue;
      }
      if (!knownIds.has(id)) {
        errors.push(`agentRearrangeFlow references unknown coordinator id "${id}"`);
      }
    }
  }
  return { valid: errors.length === 0, errors, steps };
}

// ─── Awareness rendering (per-step context for the agent prompt) ────────────

function renderFlowStructure(steps: readonly (readonly string[])[]): string {
  return steps.map((step, i) => `Step ${i + 1}: ${step.join(', ')}`).join('\n');
}

function renderAwarenessLine(steps: readonly (readonly string[])[], stepIdx: number): string {
  const parts: string[] = [];
  if (stepIdx > 0) parts.push(`Agents ahead (just ran): ${steps[stepIdx - 1]!.join(', ')}`);
  if (stepIdx < steps.length - 1) parts.push(`Agents behind (will run after this step): ${steps[stepIdx + 1]!.join(', ')}`);
  return parts.length === 0 ? '(no neighbours)' : parts.join(' | ');
}

// ─── Blackboard helpers (handler-owned, mirrors round-robin/groupchat) ──────

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
  return { ...coord, systemPromptTemplate: AGENT_REARRANGE_PROMPT };
}

function stepOutputKey(loop: number, stepIdx: number, agentId: string): string {
  return `rearrange:loop_${loop}:step_${stepIdx + 1}:${agentId}`;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const agentRearrangeHandler: TopologyHandler = {
  topology: 'agent-rearrange',

  validate(config: SwarmConfig): TopologyValidation {
    const flow     = config.topologyOptions?.agentRearrangeFlow ?? '';
    const knownIds = new Set(config.coordinators.map(c => c.id));
    const result   = validateFlow(flow, knownIds);
    return { valid: result.valid, errors: result.errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const flow       = ctx.config.topologyOptions?.agentRearrangeFlow         ?? '';
    const totalLoops = ctx.config.topologyOptions?.agentRearrangeLoops        ?? 1;
    const usePreset  = ctx.config.topologyOptions?.agentRearrangePresetAgents ?? false;

    const knownIds   = new Set(ctx.config.coordinators.map(c => c.id));
    const { steps }  = validateFlow(flow, knownIds);
    if (steps.length === 0) return;

    const byId = new Map(
      ctx.config.coordinators.map(c => [c.id, usePreset ? withPresetPrompt(c) : c] as const),
    );

    const flowStructure = renderFlowStructure(steps);

    // Seed conversation with the task (mirrors `Conversation.add(role="User", task)`).
    writeKey(ctx, 'rearrange:conversation', `# Task\n${ctx.config.goal}\n`);

    for (let loop = 1; loop <= totalLoops; loop++) {
      if (ctx.abort.signal.aborted) break;

      for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
        if (ctx.abort.signal.aborted) break;
        const step          = steps[stepIdx]!;
        const conversation  = readKey(ctx, 'rearrange:conversation');
        const awarenessLine = renderAwarenessLine(steps, stepIdx);

        emitTopologyEvent(ctx, 'topology:phase_change', {
          topology:   'agent-rearrange',
          phase:      'step',
          loop,
          totalLoops,
          stepNumber: stepIdx + 1,
          totalSteps: steps.length,
          stepAgents: step,
        });

        const sharedVars = (id: string, role: string): Record<string, string> => ({
          loop:                String(loop),
          total_loops:         String(totalLoops),
          step_n:              String(stepIdx + 1),
          total_steps:         String(steps.length),
          flow_structure:      flowStructure,
          awareness_line:      awarenessLine,
          conversation_so_far: conversation,
          step_output_key:     stepOutputKey(loop, stepIdx, id),
          role,
          max_turns_hint:      '8',
        });

        if (step.length === 1) {
          // Sequential step.
          const id = step[0]!;
          const coord = byId.get(id)!;
          await spawnCoordinator(coord, ctx, {
            ...sharedVars(id, coord.role),
            max_turns_hint: String(coord.maxTurns ?? 8),
          });
        } else {
          // Parallel step — agents don't see each other's output during this step (matches Python comma semantics).
          await runCoordinatorsInParallel(
            step.map(id => () => {
              const coord = byId.get(id)!;
              return spawnCoordinator(coord, ctx, {
                ...sharedVars(id, coord.role),
                max_turns_hint: String(coord.maxTurns ?? 8),
              });
            }),
          );
        }
        if (ctx.abort.signal.aborted) break;

        // Append this step's outputs to the canonical conversation in flow order
        // (single agent → one block; parallel step → blocks in declared order).
        const blocks: string[] = [];
        for (const id of step) {
          const coord = byId.get(id)!;
          const out   = readKey(ctx, stepOutputKey(loop, stepIdx, id));
          if (out) blocks.push(`## Loop ${loop} – Step ${stepIdx + 1} – ${id} (${coord.role || 'agent'}):\n${out}`);
        }
        if (blocks.length > 0) {
          const updated = `${conversation}\n${blocks.join('\n\n')}\n`;
          writeKey(ctx, 'rearrange:conversation', updated);
        }
      }
    }

    // Persist the final conversation under a stable key so consumers don't need
    // to know the loop/step count to find the result.
    writeKey(ctx, 'rearrange:final', readKey(ctx, 'rearrange:conversation'));
  },
};
