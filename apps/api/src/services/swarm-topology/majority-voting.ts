/**
 * Majority-voting topology — N loops of (parallel experts → consensus agent).
 * Each loop the experts see the full conversation accumulated so far (including
 * the previous loop's consensus). The consensus agent then synthesises a
 * verdict over the new round of expert outputs, and that verdict seeds the
 * next loop. After the final loop, the last consensus is the swarm output.
 *
 * Ported from kyegomez/swarms `MajorityVoting` (Apache-2.0). The Python
 * original uses a `Conversation` object that is mutated by each call to
 * `run_agents_concurrently` and then by `consensus_agent.run`; here the
 * equivalent is the blackboard, with per-expert per-loop scratch keys so
 * parallel experts do not race on the canonical conversation key.
 *
 * Mapping reference → werkbank:
 *   self.conversation                          → blackboard "majority:conversation" (handler-owned)
 *   for _ in range(self.max_loops): step()     → for loop in 1..N { Promise.all(experts) ; consensus }
 *   run_agents_concurrently(agents, task=conv) → Promise.all(spawnCoordinator(expert, ...))
 *   consensus_agent.run(task="History: …")     → spawnCoordinator(consensus, ctx, vars)
 *   CONSENSUS_AGENT_PROMPT                     → embedded as preset (mvPresetConsensus=true)
 *
 * Concurrency model:
 *   The Python version collects expert outputs as a parallel list/dict and
 *   appends them in agent order. We can't do that because each werkbank
 *   coordinator writes its own MCP-tool calls into the shared blackboard.
 *   To prevent two parallel experts from clobbering "majority:conversation",
 *   each expert writes to its own per-loop scratch key, and the handler
 *   assembles the canonical conversation between phases.
 *
 * Role resolution (werkbank convention — substring match on `role`):
 *   - Exactly one coordinator with role containing "consensus" → consensus agent.
 *   - All remaining coordinators are voting experts.
 *   - Source file: D:/programme/swarms-concept/_reference/swarms/structs/majority_voting.py
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built consensus prompt (verbatim from kyegomez majority_voting.py) ──

const CONSENSUS_AGENT_PROMPT = `
You are the Consensus Agent, responsible for synthesizing and evaluating the responses from a panel of expert agents. Your task is to deliver a rigorous, insightful, and actionable consensus based on their outputs.

**Instructions:**

1. **Comprehensive Evaluation:**
   For each agent (referenced by their name), provide a detailed, objective critique of their response. Assess the following dimensions:
   - Accuracy and correctness
   - Depth of analysis and insight
   - Relevance to the original task or question
   - Clarity, structure, and communication quality
   - Unique perspectives or innovative ideas

2. **Comparative Analysis:**
   Compare and contrast the agents’ responses. Highlight:
   - Overlapping themes or points of agreement
   - Divergent viewpoints or conflicting recommendations
   - Notable strengths and weaknesses of each approach

3. **Consensus Building:**
   - Identify which response(s) most effectively address the task, providing clear justification for your choices.
   - If appropriate, synthesize the best elements from multiple responses into a unified, superior answer.
   - Clearly explain your reasoning and the criteria used for your judgment.

4. **Ranking and Recommendation:**
   - Provide a ranked list of agent responses, from most to least effective, with concise rationales for each position.
   - Offer a final, well-justified recommendation or summary that represents the optimal consensus.

5. **Fairness and Rigor:**
   - Remain impartial, thorough, and evidence-based in your analysis.
   - Avoid bias towards any agent or perspective.
   - Ensure your consensus is actionable, well-supported, and clearly communicated.

**Output Format:**
- For each agent: [Agent Name]: [Evaluation]
- Comparative Analysis: [Summary]
- Ranked List: [1. Agent Name, 2. Agent Name, ...]
- Final Consensus/Recommendation: [Your synthesized answer or recommendation]

Your goal is to deliver a consensus that is not only fair and balanced, but also maximizes the quality, relevance, and utility of the collective agent output.

---
Werkbank protocol (you are coordinator {{id}}, the majority-voting consensus agent):
- Original task: {{goal}}
- Loop {{loop}}/{{total_loops}}. Final loop: {{is_final_loop}}.
- Full conversation history (task + every expert output across every loop so far):

{{conversation_so_far}}

- Produce your consensus per the format above.
- Write it to blackboard 'majority:consensus_loop_{{loop}}' (overwrite). On the final loop also write to 'majority:final'.
- Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

// ─── Role resolution ────────────────────────────────────────────────────────

interface MajorityRoles {
  experts:   CoordinatorConfig[];
  consensus: CoordinatorConfig;
}

function resolveMajorityRoles(coordinators: CoordinatorConfig[]): MajorityRoles | null {
  const consensusAgents = coordinators.filter(c => c.role.toLowerCase().includes('consensus'));
  if (consensusAgents.length !== 1) return null;
  const consensus = consensusAgents[0]!;
  const experts = coordinators.filter(c => c.id !== consensus.id);
  if (experts.length < 2) return null;
  return { experts, consensus };
}

// ─── Blackboard helpers ─────────────────────────────────────────────────────

function readKey(ctx: RunContext, key: string): string {
  const row = ctx.runDb
    .prepare('SELECT value FROM blackboard WHERE key = ? AND is_current = 1')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/**
 * Handler-owned blackboard write. Bypasses the MCP tool path because the
 * canonical "majority:conversation" is assembled by the runtime, not by an
 * agent. Uses the same versioning scheme as write_blackboard so replay/history
 * remain consistent.
 */
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

function withPresetConsensus(coord: CoordinatorConfig): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: CONSENSUS_AGENT_PROMPT };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const majorityVotingHandler: TopologyHandler = {
  topology: 'majority-voting',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 3) {
      errors.push(`majority-voting requires at least 3 coordinators (2+ experts and 1 consensus), got ${config.coordinators.length}`);
    }
    const roles = resolveMajorityRoles(config.coordinators);
    if (!roles) {
      errors.push('majority-voting needs exactly one coordinator whose role contains "consensus"; the rest (≥2) are voting experts');
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const roles = resolveMajorityRoles(ctx.config.coordinators);
    if (!roles) return;

    const loops        = ctx.config.topologyOptions?.majorityLoops           ?? 1;
    const usePreset    = ctx.config.topologyOptions?.majorityPresetConsensus ?? false;
    const consensus    = usePreset ? withPresetConsensus(roles.consensus) : roles.consensus;

    // Seed conversation with the task + voting roster (kyegomez `Conversation.add(role="user", task)`).
    const roster = roles.experts
      .map(e => `- ${e.id} (${e.role || 'expert'})`)
      .join('\n');
    writeKey(
      ctx,
      'majority:conversation',
      `# Task\n${ctx.config.goal}\n\n# Voting panel\n${roster}\n`,
    );

    for (let loop = 1; loop <= loops; loop++) {
      if (ctx.abort.signal.aborted) break;
      const isFinalLoop = loop === loops;

      // ── Phase 1: parallel experts ───────────────────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:   'majority-voting',
        phase:      'voting',
        loop,
        totalLoops: loops,
      });

      // Snapshot conversation BEFORE the loop starts; all parallel experts see
      // the same input (matches Python `task=self.conversation.get_str()`).
      const conversationSnapshot = readKey(ctx, 'majority:conversation');

      await Promise.allSettled(
        roles.experts.map(expert => spawnCoordinator(expert, ctx, {
          loop:                String(loop),
          total_loops:         String(loops),
          is_final_loop:       isFinalLoop ? 'true' : 'false',
          conversation_so_far: conversationSnapshot,
          expert_output_key:   `majority:loop_${loop}:${expert.id}`,
          max_turns_hint:      String(expert.maxTurns ?? 8),
        })),
      );

      if (ctx.abort.signal.aborted) break;

      // Assemble this loop's expert outputs into the canonical conversation.
      const loopOutputs: string[] = [];
      for (const expert of roles.experts) {
        const out = readKey(ctx, `majority:loop_${loop}:${expert.id}`);
        if (out) loopOutputs.push(`## Loop ${loop} – ${expert.id} (${expert.role || 'expert'}):\n${out}`);
      }
      let conversationAfterExperts = conversationSnapshot;
      if (loopOutputs.length > 0) {
        conversationAfterExperts = `${conversationSnapshot}\n${loopOutputs.join('\n\n')}\n`;
        writeKey(ctx, 'majority:conversation', conversationAfterExperts);
      }

      // ── Phase 2: consensus agent ────────────────────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:   'majority-voting',
        phase:      'consensus',
        loop,
        totalLoops: loops,
        isFinalLoop,
      });

      await spawnCoordinator(consensus, ctx, {
        loop:                String(loop),
        total_loops:         String(loops),
        is_final_loop:       isFinalLoop ? 'true' : 'false',
        conversation_so_far: conversationAfterExperts,
        max_turns_hint:      String(consensus.maxTurns ?? 12),
      });

      if (ctx.abort.signal.aborted) break;

      // Append the consensus output to the canonical conversation so the next
      // loop's experts can see it (matches Python `self.conversation.add(role=consensus_agent_name, content=consensus_output)`).
      const consensusOut = readKey(ctx, `majority:consensus_loop_${loop}`);
      if (consensusOut) {
        const updated = `${conversationAfterExperts}\n## Loop ${loop} – CONSENSUS (${consensus.id}):\n${consensusOut}\n`;
        writeKey(ctx, 'majority:conversation', updated);
      }
    }
  },
};
