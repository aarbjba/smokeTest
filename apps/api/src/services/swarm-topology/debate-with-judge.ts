/**
 * Debate-with-judge topology — three coordinators (pro, con, judge) run in N
 * sequential rounds. Each round: pro argues, con counters, judge evaluates.
 * Judge's synthesis becomes the topic of the next round (refinement loop).
 *
 * Ported from kyegomez/swarms `DebateWithJudge` (Apache-2.0). The Python
 * original uses three Agent.run() calls per round and a Conversation object
 * that accumulates strings; here the equivalent is three Claude-CLI subprocess
 * spawns plus the existing blackboard, since werkbank coordinators write back
 * via MCP tools, not return values.
 *
 * Mapping reference → werkbank:
 *   pro_agent.run(prompt)               → spawnCoordinator(pro, ctx, vars)
 *   con_agent.run(prompt)               → spawnCoordinator(con, ctx, vars)
 *   judge_agent.run(prompt)             → spawnCoordinator(judge, ctx, vars)
 *   self.conversation.add(name, output) → coordinator writes "debate:history" via MCP
 *   current_topic = judge_synthesis     → debate:current_topic blackboard key
 *   round_num == max_loops - 1          → {{is_final_round}} template var ("true"|"false")
 *
 * Coordinators are matched by their `role` field (case-insensitive substring
 * "pro" / "con" / "judge"). With debatePresetAgents=true the user-supplied
 * systemPromptTemplate is overridden by the built-in role prompts.
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built role prompts (ported verbatim semantics from reference) ──────

const PRO_AGENT_SYSTEM_PROMPT = `You are an expert debater specializing in arguing IN FAVOR of propositions.

Your Role:
- Present compelling, well-reasoned arguments supporting your assigned position
- Use evidence, logic, and persuasive rhetoric to make your case
- Anticipate and preemptively address potential counterarguments
- Build upon previous arguments when refining your position

Debate Guidelines:
1. Structure your arguments clearly with main points and supporting evidence
2. Use concrete examples and data when available
3. Acknowledge valid opposing points while explaining why your position is stronger
4. Maintain a professional, respectful tone throughout the debate
5. Focus on the strongest aspects of your position

Your goal is to present the most compelling case possible for the Pro position.

---
Werkbank protocol (this is a multi-process swarm, you are coordinator {{id}}):
- Topic of this round: {{current_topic}}
- Round {{round}}/{{total_rounds}}. Final round: {{is_final_round}}.
- Conversation so far:
{{prior_turn}}
- Append your contribution to blackboard key 'debate:history' with prefix '## Round {{round}} – PRO ({{id}}):'.
  Always read 'debate:history' first, then write the concatenation (history + your new turn).
- Call terminate() once you have written your turn. Do not exceed {{max_turns_hint}} turns.`;

const CON_AGENT_SYSTEM_PROMPT = `You are an expert debater specializing in arguing AGAINST propositions.

Your Role:
- Present compelling, well-reasoned counter-arguments opposing the given position
- Identify weaknesses, flaws, and potential negative consequences
- Challenge assumptions and evidence presented by the opposing side
- Build upon previous arguments when refining your position

Debate Guidelines:
1. Structure your counter-arguments clearly with main points and supporting evidence
2. Use concrete examples and data to support your opposition
3. Directly address and refute the Pro's arguments
4. Maintain a professional, respectful tone throughout the debate
5. Focus on the most significant weaknesses of the opposing position

Your goal is to present the most compelling case possible against the proposition.

---
Werkbank protocol (this is a multi-process swarm, you are coordinator {{id}}):
- Topic of this round: {{current_topic}}
- Round {{round}}/{{total_rounds}}. Final round: {{is_final_round}}.
- Conversation so far:
{{prior_turn}}
- Append your contribution to blackboard key 'debate:history' with prefix '## Round {{round}} – CON ({{id}}):'.
  Always read 'debate:history' first, then write the concatenation (history + your new turn).
- Call terminate() once you have written your turn. Do not exceed {{max_turns_hint}} turns.`;

const JUDGE_AGENT_SYSTEM_PROMPT = `You are an impartial judge and critical evaluator of debates.

Your Role:
- Objectively evaluate arguments from both Pro and Con sides
- Identify strengths and weaknesses in each position
- Provide constructive feedback for improvement
- Synthesize the best elements from both sides when appropriate
- Render fair verdicts based on argument quality, not personal bias

Evaluation Criteria:
1. Logical coherence and reasoning quality
2. Evidence and supporting data quality
3. Persuasiveness and rhetorical effectiveness
4. Responsiveness to opposing arguments
5. Overall argument structure and clarity

Judgment Guidelines:
- Be specific about what makes arguments strong or weak
- Provide actionable feedback for improvement
- When synthesizing, explain how elements from both sides complement each other
- In final rounds, provide clear conclusions with justification

Your goal is to facilitate productive debate and arrive at well-reasoned conclusions.

---
Werkbank protocol (this is a multi-process swarm, you are coordinator {{id}}):
- Topic of this round: {{current_topic}}
- Round {{round}}/{{total_rounds}}. Final round: {{is_final_round}}.
- Conversation so far:
{{prior_turn}}
- If is_final_round is "true": produce a comprehensive final evaluation — strongest points from both
  sides, declare a winner OR a balanced synthesis, and present a refined answer that incorporates
  the best elements from both arguments. This is the final output of the debate.
- Otherwise: assess strengths/weaknesses, give a refined synthesis, and provide specific feedback
  for the next round. Your synthesis becomes the topic of the next round.
- Append to blackboard 'debate:history' with prefix '## Round {{round}} – JUDGE ({{id}}):'.
- Also write your synthesis to blackboard 'debate:current_topic' (overwrite — it seeds the next round).
- Call terminate() once both writes are done. Do not exceed {{max_turns_hint}} turns.`;

const PRESET_PROMPTS = {
  pro:   PRO_AGENT_SYSTEM_PROMPT,
  con:   CON_AGENT_SYSTEM_PROMPT,
  judge: JUDGE_AGENT_SYSTEM_PROMPT,
} as const;

// ─── Role resolution ────────────────────────────────────────────────────────

interface DebateRoles {
  pro:   CoordinatorConfig;
  con:   CoordinatorConfig;
  judge: CoordinatorConfig;
}

function findRole(coordinators: CoordinatorConfig[], needle: string): CoordinatorConfig | null {
  const lower = needle.toLowerCase();
  return coordinators.find(c => c.role.toLowerCase().includes(lower)) ?? null;
}

function resolveDebateRoles(coordinators: CoordinatorConfig[]): DebateRoles | null {
  const pro   = findRole(coordinators, 'pro');
  const con   = findRole(coordinators, 'con');
  const judge = findRole(coordinators, 'judge');
  if (!pro || !con || !judge) return null;
  if (pro.id === con.id || pro.id === judge.id || con.id === judge.id) return null;
  return { pro, con, judge };
}

function readBlackboardKey(ctx: RunContext, key: string): string {
  const row = ctx.runDb
    .prepare('SELECT value FROM blackboard WHERE key = ? AND is_current = 1')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/**
 * Apply preset prompts when debatePresetAgents=true. Returns a new
 * coordinator object with the prompt swapped; the original config is not
 * mutated. The role's id, model, tools, etc. are preserved.
 */
function withPresetPrompt(coord: CoordinatorConfig, kind: 'pro' | 'con' | 'judge'): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: PRESET_PROMPTS[kind] };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const debateWithJudgeHandler: TopologyHandler = {
  topology: 'debate-with-judge',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length !== 3) {
      errors.push(`debate requires exactly 3 coordinators (got ${config.coordinators.length})`);
    }
    if (!resolveDebateRoles(config.coordinators)) {
      errors.push('debate needs coordinators whose role contains "pro", "con", and "judge"');
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const roles = resolveDebateRoles(ctx.config.coordinators);
    if (!roles) return;

    const rounds       = ctx.config.topologyOptions?.debateRounds       ?? 3;
    const usePresets   = ctx.config.topologyOptions?.debatePresetAgents ?? false;

    const proCoord   = usePresets ? withPresetPrompt(roles.pro,   'pro')   : roles.pro;
    const conCoord   = usePresets ? withPresetPrompt(roles.con,   'con')   : roles.con;
    const judgeCoord = usePresets ? withPresetPrompt(roles.judge, 'judge') : roles.judge;

    for (let round = 1; round <= rounds; round++) {
      if (ctx.abort.signal.aborted) break;
      const isFinalRound = round === rounds;

      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:    'debate-with-judge',
        round,
        totalRounds: rounds,
        isFinalRound,
      });

      await spawnSpeaker(ctx, proCoord,   round, rounds, isFinalRound, 'pro');
      if (ctx.abort.signal.aborted) break;

      await spawnSpeaker(ctx, conCoord,   round, rounds, isFinalRound, 'con');
      if (ctx.abort.signal.aborted) break;

      await spawnSpeaker(ctx, judgeCoord, round, rounds, isFinalRound, 'judge');
    }
  },
};

async function spawnSpeaker(
  ctx:          RunContext,
  coord:        CoordinatorConfig,
  round:        number,
  totalRounds:  number,
  isFinalRound: boolean,
  speakerKind:  'pro' | 'con' | 'judge',
): Promise<void> {
  // Read prior turns + current topic FRESH before each spawn, so each agent sees
  // what the previous one just wrote (the blackboard is the conversation memory).
  const priorTurn    = readBlackboardKey(ctx, 'debate:history');
  const currentTopic = readBlackboardKey(ctx, 'debate:current_topic') || ctx.config.goal;

  await spawnCoordinator(coord, ctx, {
    round:           String(round),
    total_rounds:    String(totalRounds),
    is_final_round:  isFinalRound ? 'true' : 'false',
    speaker:         speakerKind,
    current_topic:   currentTopic,
    prior_turn:      priorTurn || '(no prior turns yet — you are the first speaker of this debate)',
    max_turns_hint:  String(coord.maxTurns ?? 8),
  });
}
