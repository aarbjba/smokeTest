/**
 * Mixture-of-Agents (MoA) topology — N layers of parallel experts feeding into
 * a final aggregator. Each layer sees the conversation accumulated by all prior
 * layers; experts within the same layer do NOT see each other (they share the
 * snapshot taken before the layer started).
 *
 * Ported from kyegomez/swarms `MixtureOfAgents` (Apache-2.0). The Python
 * original uses a Conversation object that grows as each layer's outputs are
 * appended; here the equivalent is the blackboard, with a per-expert
 * scratch key per layer to avoid lost-update races on parallel writes.
 *
 * Mapping reference → werkbank:
 *   self.conversation                   → blackboard "moa:conversation" (handler-owned)
 *   for i in range(self.layers): step() → for layer in 1..N { Promise.all(experts) }
 *   step() returns dict[name → output]  → handler reads each "moa:layer_<L>:<id>"
 *   self.aggregator_agent.run(ctx)      → spawnCoordinator(aggregator, ctx, vars)
 *   AGGREGATOR_SYSTEM_PROMPT_MAIN       → embedded as preset (moaPresetAggregator=true)
 *
 * Concurrency model — important deviation from naive ports:
 *   The Python version returns expert outputs as a dict from a thread pool, then
 *   appends them in iteration order. We can't do that because each werkbank
 *   coordinator writes its own MCP-tool calls into the shared blackboard. To
 *   prevent two parallel experts from clobbering "moa:conversation", each
 *   expert writes to its own per-layer scratch key, and the handler assembles
 *   the canonical conversation between layers.
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  runCoordinatorsInParallel,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built aggregator prompt (verbatim from kyegomez ag_prompt.py) ──────

const AGGREGATOR_SYSTEM_PROMPT_MAIN = `# Multi-Agent Observer and Summarizer

You are an advanced AI agent tasked with observing, analyzing, and summarizing the responses of multiple other AI agents. Your primary function is to provide concise, insightful summaries of agent interactions and outputs. Follow these guidelines:

## Core Responsibilities:
1. Observe and record responses from all agents in a given interaction.
2. Analyze the content, tone, and effectiveness of each agent's contribution.
3. Identify areas of agreement, disagreement, and unique insights among agents.
4. Summarize key points and conclusions from the multi-agent interaction.
5. Highlight any inconsistencies, errors, or potential biases in agent responses.

## Operational Guidelines:
- Maintain strict objectivity in your observations and summaries.
- Use clear, concise language in your reports.
- Organize summaries in a structured format for easy comprehension.
- Adapt your summarization style based on the context and complexity of the interaction.
- Respect confidentiality and ethical guidelines in your reporting.

## Analysis Framework:
For each agent interaction, consider the following:
1. Relevance: How well did each agent address the given task or query?
2. Accuracy: Were the agents' responses factually correct and logically sound?
3. Creativity: Did any agents provide unique or innovative perspectives?
4. Collaboration: How effectively did the agents build upon or challenge each other's ideas?
5. Efficiency: Which agents provided the most value with the least verbose responses?

## Output Format:
Your summaries should include:
1. A brief overview of the interaction context
2. Key points from each agent's contribution
3. Areas of consensus and disagreement
4. Notable insights or breakthroughs
5. Potential improvements or areas for further exploration

Remember: Your role is crucial in distilling complex multi-agent interactions into actionable insights. Strive for clarity, accuracy, and impartiality in all your summaries.

---
Werkbank protocol (you are coordinator {{id}}, the MoA aggregator):
- Original task: {{goal}}
- Number of expert layers completed: {{total_layers}}
- Full conversation (experts across all layers):

{{conversation_so_far}}

- Synthesize a single, well-reasoned final answer that incorporates the strongest insights from all experts.
- Write your final synthesis to blackboard 'moa:final' (overwrite).
- Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

// ─── Role resolution ────────────────────────────────────────────────────────

interface MoaRoles {
  experts:    CoordinatorConfig[];
  aggregator: CoordinatorConfig;
}

function resolveMoaRoles(coordinators: CoordinatorConfig[]): MoaRoles | null {
  const aggregators = coordinators.filter(c => c.role.toLowerCase().includes('aggregator'));
  if (aggregators.length !== 1) return null;
  const aggregator = aggregators[0]!;
  const experts = coordinators.filter(c => c.id !== aggregator.id);
  if (experts.length < 1) return null;
  return { experts, aggregator };
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
 * canonical "moa:conversation" is assembled by the runtime, not by an agent.
 * Uses the same versioning scheme as write_blackboard so replay/history work.
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

function withPresetAggregator(coord: CoordinatorConfig): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: AGGREGATOR_SYSTEM_PROMPT_MAIN };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const mixtureOfAgentsHandler: TopologyHandler = {
  topology: 'mixture-of-agents',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 2) {
      errors.push(`mixture-of-agents requires at least 2 coordinators (1+ experts and 1 aggregator), got ${config.coordinators.length}`);
    }
    const roles = resolveMoaRoles(config.coordinators);
    if (!roles) {
      errors.push('mixture-of-agents needs exactly one coordinator whose role contains "aggregator"; the rest are experts');
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const roles = resolveMoaRoles(ctx.config.coordinators);
    if (!roles) return;

    const layers     = ctx.config.topologyOptions?.moaLayers           ?? 3;
    const usePreset  = ctx.config.topologyOptions?.moaPresetAggregator ?? false;
    const aggregator = usePreset ? withPresetAggregator(roles.aggregator) : roles.aggregator;

    // Seed conversation with the team roster (kyegomez `list_all_agents` equivalent).
    const roster = roles.experts
      .map(e => `- ${e.id} (${e.role || 'expert'})`)
      .join('\n');
    writeKey(ctx, 'moa:conversation', `# Task\n${ctx.config.goal}\n\n# Expert team\n${roster}\n`);

    for (let layer = 1; layer <= layers; layer++) {
      if (ctx.abort.signal.aborted) break;

      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:    'mixture-of-agents',
        phase:       'experts',
        layer,
        totalLayers: layers,
      });

      // Snapshot the conversation BEFORE the layer starts; all parallel experts
      // see the same input (matches Python `step(task=full_context)` semantics).
      const conversationSnapshot = readKey(ctx, 'moa:conversation');

      await runCoordinatorsInParallel(
        roles.experts.map(expert => () => spawnCoordinator(expert, ctx, {
          layer:               String(layer),
          total_layers:        String(layers),
          conversation_so_far: conversationSnapshot,
          expert_output_key:   `moa:layer_${layer}:${expert.id}`,
          max_turns_hint:      String(expert.maxTurns ?? 8),
        })),
      );

      if (ctx.abort.signal.aborted) break;

      // Assemble this layer's outputs into the canonical conversation.
      const layerOutputs: string[] = [];
      for (const expert of roles.experts) {
        const out = readKey(ctx, `moa:layer_${layer}:${expert.id}`);
        if (out) layerOutputs.push(`## Layer ${layer} – ${expert.id} (${expert.role || 'expert'}):\n${out}`);
      }
      if (layerOutputs.length > 0) {
        const updated = `${conversationSnapshot}\n${layerOutputs.join('\n\n')}\n`;
        writeKey(ctx, 'moa:conversation', updated);
      }
    }

    if (ctx.abort.signal.aborted) return;

    emitTopologyEvent(ctx, 'topology:phase_change', {
      topology:    'mixture-of-agents',
      phase:       'aggregation',
      layer:       layers + 1,
      totalLayers: layers,
    });

    const finalConversation = readKey(ctx, 'moa:conversation');
    await spawnCoordinator(aggregator, ctx, {
      total_layers:        String(layers),
      conversation_so_far: finalConversation,
      max_turns_hint:      String(aggregator.maxTurns ?? 12),
    });
  },
};
