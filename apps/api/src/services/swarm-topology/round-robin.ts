/**
 * Round-robin topology — N loops over the coordinator list, re-shuffled each
 * loop, every coordinator runs sequentially and sees the full conversation
 * accumulated so far.
 *
 * Ported from kyegomez/swarms `RoundRobinSwarm` (Apache-2.0). The Python
 * original uses `random.shuffle` per loop, threads the conversation through
 * `Conversation.return_history_as_string()`, and prompts each agent with a
 * "build upon prior contributions" template. Werkbank coordinators are
 * isolated subprocesses, so the equivalent is to spawn them one by one with
 * the canonical conversation key as a template variable, then append the
 * agent's output to that key before the next agent starts.
 *
 * Mapping reference → werkbank:
 *   self.conversation                      → blackboard "round_robin:conversation" (handler-owned)
 *   for _ in range(max_loops): step()      → for loop in 1..N
 *   random.shuffle(self.agents)            → fisher-yates shuffle of coordinator list per loop
 *   collaborative_task (per-agent prompt)  → ROUND_ROBIN_AGENT_PROMPT (preset, embedded below)
 *   conversation.add(name, output)         → handler reads coord output key, appends to canonical conversation
 *   max_retries (tenacity.retry)           → DEVIATION: see header note — werkbank surfaces failures via the
 *                                            run-DB instead of silently retrying
 *
 * Retry deviation:
 *   The Python version wraps each agent call in `tenacity.retry(stop_after=3)`.
 *   Werkbank coordinators are Claude-CLI subprocesses; a transient failure is
 *   already visible in the run-DB (`coordinator:error`, exit_code) and reruns
 *   would multiply token spend without a stop guarantee. If a coordinator
 *   fails, the loop continues with the remaining agents — the conversation
 *   gets partial coverage instead of the whole loop being aborted.
 *
 * Shuffle determinism:
 *   The Python original uses unseeded `random.shuffle`. We use Math.random
 *   for parity; Replay shows the actual order via `topology:phase_change`
 *   events that record `agentOrder` per loop.
 *
 * Source: D:/programme/swarms-concept/_reference/swarms/structs/round_robin.py
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built collaborative prompt (semantics from round_robin.py:run) ─────

const ROUND_ROBIN_AGENT_PROMPT = `You are a collaborator in a round-robin agent swarm. Each loop, every agent contributes once in a randomized order; every agent sees the full conversation history and builds on what came before.

Operating principles:
- Acknowledge prior contributions where relevant — name agents you build on.
- Add YOUR unique angle: do not repeat earlier points verbatim.
- Be concise but thorough.
- If the conversation is empty (you are first), address the original task directly.

---
Werkbank protocol (you are coordinator {{id}}, agent {{position}} of {{agent_count}} this loop, loop {{loop}}/{{total_loops}}):

Original task: {{goal}}

Other agents this loop (in shuffled order, your position marked):
{{agent_order}}

Full conversation history so far (task + every agent output across every loop so far):

{{conversation_so_far}}

---

Your task this turn:
1. Review the conversation history above carefully.
2. As {{id}}, contribute your unique perspective, building on prior agents where useful.
3. Write your contribution as a STRING to blackboard key '{{contribution_key}}' (overwrite). The handler appends it to the canonical conversation before the next agent runs.
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

// ─── Blackboard helpers (handler-owned, mirrors majority-voting/hierarchical) ─

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
  return { ...coord, systemPromptTemplate: ROUND_ROBIN_AGENT_PROMPT };
}

/** Fisher-Yates shuffle, mirrors random.shuffle semantics. */
function shuffle<T>(input: readonly T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const roundRobinHandler: TopologyHandler = {
  topology: 'round-robin',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 2) {
      errors.push(`round-robin requires at least 2 coordinators (got ${config.coordinators.length})`);
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const loops     = ctx.config.topologyOptions?.roundRobinLoops        ?? 1;
    const usePreset = ctx.config.topologyOptions?.roundRobinPresetAgents ?? false;

    // Seed conversation with the task (matches kyegomez `Conversation.add(role="User", content=task)`).
    writeKey(
      ctx,
      'round_robin:conversation',
      `# Task\n${ctx.config.goal}\n`,
    );

    for (let loop = 1; loop <= loops; loop++) {
      if (ctx.abort.signal.aborted) break;

      const order        = shuffle(ctx.config.coordinators);
      const orderListing = order.map((c, i) => `${i + 1}. ${c.id} (${c.role || 'agent'})`).join('\n');

      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:   'round-robin',
        phase:      'loop_start',
        loop,
        totalLoops: loops,
        agentOrder: order.map(c => c.id),
      });

      for (let pos = 0; pos < order.length; pos++) {
        if (ctx.abort.signal.aborted) break;
        const coord     = order[pos]!;
        const effective = usePreset ? withPresetPrompt(coord) : coord;
        const contribKey = `round_robin:loop_${loop}:${coord.id}`;
        const conversationSnapshot = readKey(ctx, 'round_robin:conversation');

        await spawnCoordinator(effective, ctx, {
          loop:                String(loop),
          total_loops:         String(loops),
          position:            String(pos + 1),
          agent_count:         String(order.length),
          agent_order:         orderListing,
          conversation_so_far: conversationSnapshot,
          contribution_key:    contribKey,
          max_turns_hint:      String(coord.maxTurns ?? 8),
        });

        // Append this agent's contribution to the canonical conversation so
        // the next agent sees it. Missing/empty output (failure or
        // non-compliance) leaves the conversation unchanged — partial
        // coverage rather than aborting the whole loop, see header note.
        const contribution = readKey(ctx, contribKey);
        if (contribution) {
          const updated = `${conversationSnapshot}\n## Loop ${loop} – ${coord.id} (${coord.role || 'agent'}):\n${contribution}\n`;
          writeKey(ctx, 'round_robin:conversation', updated);
        }
      }
    }
  },
};
