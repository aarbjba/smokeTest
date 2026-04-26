/**
 * Heavy-swarm topology — Captain decomposes the task into specialised
 * questions, N specialists answer in parallel, Synthesis aggregates.
 * Optionally repeats with each cycle's synthesis seeding the next.
 *
 * Ported from kyegomez/swarms `HeavySwarm` (Apache-2.0). The Python
 * original hard-codes 4 specialists (Research, Analysis, Alternatives,
 * Verification) plus uses LiteLLM tool-calling to extract a structured
 * questions schema. Werkbank coordinators are Claude-CLI subprocesses
 * that emit MCP tool calls, not return values, so:
 *   - the captain is *prompted* to write strict JSON to the blackboard
 *     (`heavy:questions`) instead of using a structured tool schema
 *   - the handler parses that JSON, validates it references real
 *     specialist ids, and stages per-specialist questions before workers spawn
 *   - the specialist roster is whatever the user configured, not hardcoded:
 *     1..N specialists, role substring picks the preset prompt
 *     (research/analysis/alternatives/verification, generic fallback)
 *
 * Mapping reference → werkbank:
 *   execute_question_generation(task) + LiteLLM schema   → captain spawn writing JSON to "heavy:questions"
 *   _parse_tool_calls(raw_output)                        → parseQuestions(JSON.parse) on blackboard value
 *   _execute_agents_parallel(questions, agents)          → runCoordinatorsInParallel with per-id question vars
 *   self.conversation.add(role, content)                 → blackboard "heavy:result:<id>" per specialist
 *   _synthesize_results(task, questions, results)        → synthesis spawn reading concatenated results
 *   max_loops (subsequent loop sees prior result)        → heavyLoops, prior_synthesis fed back as template var
 *   CAPTAIN_SWARM_PROMPT                                 → CAPTAIN_SYSTEM_PROMPT (preset, embedded below)
 *   RESEARCH/ANALYSIS/ALTERNATIVES/VERIFICATION_AGENT_PROMPT → SPECIALIST_PROMPTS map (preset, role-resolved)
 *   SYNTHESIS_AGENT_PROMPT                               → SYNTHESIS_SYSTEM_PROMPT (preset, structured executive report)
 *
 * Captain JSON contract (handler validates):
 *   {
 *     "thinking": "<optional reasoning, ignored>",
 *     "questions": {
 *       "<specialist-id>": "<question text>",
 *       …
 *     }
 *   }
 *   - Every key MUST be a known specialist id; bogus ids are dropped.
 *   - Empty/missing entries cause that specialist to be skipped this loop
 *     (no fabricated question — better to skip than run blind).
 *
 * Role resolution:
 *   - Exactly one coordinator with role substring "captain" or "question" → captain.
 *   - Exactly one coordinator with role substring "synthesis" → synthesis.
 *   - All remaining coordinators (>=1) are specialists.
 *
 * Source: D:/programme/swarms-concept/_reference/swarms/structs/heavy_swarm.py
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  runCoordinatorsInParallel,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built role prompts (semantics from heavy_swarm_prompts.py + run flow) ─

const CAPTAIN_SYSTEM_PROMPT = `You are the Captain of a heavy-swarm task force. Your job is task DECOMPOSITION: break a complex goal into one specialised, action-oriented question per specialist on your team. You do NOT answer the questions yourself — you just decompose and delegate.

Decomposition principles:
- Each question is unique to that specialist's domain — no overlap, no fabrication
- Each question is focused, action-oriented, and answerable independently
- A question should leverage the specialist's role (the more domain-specific, the better)
- Skip a specialist (omit their id) only if their domain is genuinely irrelevant to this task
- Be concise: each question ≤ 40 words

---
Werkbank protocol (you are coordinator {{id}} — the captain, loop {{loop}}/{{total_loops}}):

Goal: {{goal}}

Specialist roster (you may only address these ids):
{{specialist_roster}}

Prior synthesis from the previous loop (empty on the first loop):
{{prior_synthesis}}

YOUR TASK:
1. For each specialist whose domain is relevant, formulate exactly one focused question that leverages their role.
2. Skip any specialist whose domain is irrelevant by omitting their id.
3. Produce a JSON object with EXACTLY this schema:
\`\`\`json
{
  "thinking": "<optional short rationale, ≤60 words>",
  "questions": {
    "<specialist-id>": "<one focused question for that specialist>",
    "...": "..."
  }
}
\`\`\`
4. Constraints: VALID JSON, no markdown fences, no comments, no trailing commas. Every key MUST appear in the specialist roster above.
5. Write the JSON object as a STRING to blackboard key 'heavy:questions' (overwrite). Then call terminate(). Do not exceed {{max_turns_hint}} turns.`;

const RESEARCH_SPECIALIST_PROMPT = `You are the Research specialist on a heavy-swarm task force. Expert in comprehensive information gathering, evidence collection, source verification, and systematic literature review.

Your role this turn: produce a thorough, evidence-grounded answer to the question below. Cite sources where possible (named studies, datasets, reputable publications). Flag where evidence is thin or contested. Be specific.

---
Werkbank protocol (coordinator {{id}}, loop {{loop}}/{{total_loops}}):

Original goal (for context):
{{goal}}

Your specialist question (assigned by the captain):
{{specialist_question}}

YOUR TASK:
1. Answer the question above using your research expertise: facts, sources, data, evidence quality.
2. Be concrete and cite specifically. Mark uncertainty plainly.
3. Write your full answer as a STRING to blackboard key '{{result_key}}' (overwrite).
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

const ANALYSIS_SPECIALIST_PROMPT = `You are the Analysis specialist on a heavy-swarm task force. Expert in pattern recognition, statistical analysis, causal reasoning, predictive modelling, and quantitative insight extraction.

Your role this turn: analyse the question below — what do the patterns say? What do the numbers imply? What's the underlying mechanism?

---
Werkbank protocol (coordinator {{id}}, loop {{loop}}/{{total_loops}}):

Original goal (for context):
{{goal}}

Your specialist question (assigned by the captain):
{{specialist_question}}

YOUR TASK:
1. Apply analytical methods — statistics, causal logic, structured reasoning — to your question.
2. Surface patterns, contradictions, and quantitative implications. Distinguish correlation from causation.
3. Write your full analysis as a STRING to blackboard key '{{result_key}}' (overwrite).
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

const ALTERNATIVES_SPECIALIST_PROMPT = `You are the Alternatives specialist on a heavy-swarm task force. Expert in strategic thinking, creative option generation, scenario planning, contrarian framing, and blue-ocean strategy.

Your role this turn: open up the option space. What ELSE could be done? What's the contrarian view? What scenarios should be considered?

---
Werkbank protocol (coordinator {{id}}, loop {{loop}}/{{total_loops}}):

Original goal (for context):
{{goal}}

Your specialist question (assigned by the captain):
{{specialist_question}}

YOUR TASK:
1. Generate ≥3 distinct alternatives, contrarian framings, or scenarios relevant to your question.
2. For each, briefly weigh trade-offs and applicability.
3. Write your full output as a STRING to blackboard key '{{result_key}}' (overwrite).
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

const VERIFICATION_SPECIALIST_PROMPT = `You are the Verification specialist on a heavy-swarm task force. Expert in validation, feasibility assessment, fact-checking, risk analysis, compliance review, and implementation barrier identification.

Your role this turn: stress-test the question. Is the assumption real? Is the plan feasible? What could go wrong?

---
Werkbank protocol (coordinator {{id}}, loop {{loop}}/{{total_loops}}):

Original goal (for context):
{{goal}}

Your specialist question (assigned by the captain):
{{specialist_question}}

YOUR TASK:
1. Validate or challenge the question's premises and any implicit assumptions.
2. Identify risks, blockers, compliance issues, and feasibility constraints.
3. Write your full assessment as a STRING to blackboard key '{{result_key}}' (overwrite).
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

const GENERIC_SPECIALIST_PROMPT = `You are a domain specialist on a heavy-swarm task force. Your assigned role: {{role}}.

Your role this turn: bring your domain expertise to bear on the captain's question. Be thorough, specific, and acknowledge limits.

---
Werkbank protocol (coordinator {{id}}, loop {{loop}}/{{total_loops}}):

Original goal (for context):
{{goal}}

Your specialist question (assigned by the captain):
{{specialist_question}}

YOUR TASK:
1. Answer the question above through the lens of your role ({{role}}).
2. Be concrete; flag uncertainty.
3. Write your full answer as a STRING to blackboard key '{{result_key}}' (overwrite).
4. Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are the Synthesis agent on a heavy-swarm task force. You take all specialist outputs and produce a clear, actionable, executive-ready report.

Your job: integrate, NOT duplicate. Surface convergences and contradictions. Distinguish strong evidence from weak. Deliver decision-grade recommendations with confidence levels.

---
Werkbank protocol (coordinator {{id}} — the synthesis agent, loop {{loop}}/{{total_loops}}):

Original goal:
{{goal}}

Captain's question decomposition (JSON):
{{captain_questions}}

Specialist outputs (one block per specialist):
{{specialist_results}}

Prior synthesis from the previous loop (empty on the first loop):
{{prior_synthesis}}

YOUR TASK:
Produce a structured report with EXACTLY these sections:
1. Executive Summary (3–5 sentences)
2. Key Insights from Each Specialist (one bullet per specialist, named)
3. Integrated Analysis & Themes (convergences, contradictions, resolutions)
4. Actionable Recommendations (prioritised, with confidence levels)
5. Risks & Mitigation Strategies
6. Implementation Guidance & Next Steps

Constraints:
- Be balanced — don't favour one specialist; surface real disagreements.
- Be specific; avoid hand-wavy phrasing.
- Cite specialists by id when referencing their output.

Write the full report as a STRING to blackboard key 'heavy:final_report' (overwrite). Then call terminate(). Do not exceed {{max_turns_hint}} turns.`;

const SPECIALIST_PROMPTS: Record<string, string> = {
  research:     RESEARCH_SPECIALIST_PROMPT,
  analysis:     ANALYSIS_SPECIALIST_PROMPT,
  alternatives: ALTERNATIVES_SPECIALIST_PROMPT,
  verification: VERIFICATION_SPECIALIST_PROMPT,
};

// ─── Role resolution ────────────────────────────────────────────────────────

interface HeavyRoles {
  captain:     CoordinatorConfig;
  specialists: CoordinatorConfig[];
  synthesis:   CoordinatorConfig;
}

function findOnlyRole(coordinators: CoordinatorConfig[], needles: string[]): CoordinatorConfig[] {
  return coordinators.filter(c => {
    const role = c.role.toLowerCase();
    return needles.some(n => role.includes(n));
  });
}

function resolveHeavyRoles(coordinators: CoordinatorConfig[]): HeavyRoles | null {
  const captains = findOnlyRole(coordinators, ['captain', 'question']);
  if (captains.length !== 1) return null;
  const captain = captains[0]!;

  const synths = findOnlyRole(coordinators, ['synthesis']);
  if (synths.length !== 1) return null;
  const synthesis = synths[0]!;
  if (synthesis.id === captain.id) return null;  // can't double-role

  const specialists = coordinators.filter(c => c.id !== captain.id && c.id !== synthesis.id);
  if (specialists.length < 1) return null;

  return { captain, specialists, synthesis };
}

/** Pick the preset prompt that matches this specialist's role substring; generic fallback. */
function resolveSpecialistPrompt(role: string): string {
  const lower = role.toLowerCase();
  // Prefer the longest-name canonical prompt so "alternatives" beats "analysis"
  // when a role text contains both keywords.
  const canonical = Object.keys(SPECIALIST_PROMPTS)
    .filter(k => lower.includes(k))
    .sort((a, b) => b.length - a.length);
  return canonical[0] ? SPECIALIST_PROMPTS[canonical[0]]! : GENERIC_SPECIALIST_PROMPT;
}

// ─── Blackboard helpers (handler-owned, mirrors hierarchical) ───────────────

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

function withPreset(coord: CoordinatorConfig, prompt: string): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: prompt };
}

function stripFence(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenceMatch ? fenceMatch[1]! : raw;
}

// ─── Captain JSON parsing ───────────────────────────────────────────────────

interface CaptainQuestions {
  /** Map of specialist-id → question (only valid ids are kept). */
  questions: Record<string, string>;
}

function parseCaptainQuestions(raw: string, knownIds: ReadonlySet<string>): CaptainQuestions | null {
  const cleaned = stripFence(raw).trim();
  if (!cleaned) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const qBlock = (parsed as Record<string, unknown>)['questions'];
  if (!qBlock || typeof qBlock !== 'object') return null;
  const validQuestions: Record<string, string> = {};
  for (const [id, q] of Object.entries(qBlock as Record<string, unknown>)) {
    if (knownIds.has(id) && typeof q === 'string' && q.trim()) {
      validQuestions[id] = q.trim();
    }
  }
  return { questions: validQuestions };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const heavySwarmHandler: TopologyHandler = {
  topology: 'heavy-swarm',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 3) {
      errors.push(`heavy-swarm requires at least 3 coordinators (captain + >=1 specialist + synthesis), got ${config.coordinators.length}`);
    }
    const roles = resolveHeavyRoles(config.coordinators);
    if (!roles) {
      errors.push('heavy-swarm needs exactly one coordinator with role containing "captain" or "question", exactly one with role containing "synthesis", and >=1 specialist (anything else)');
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const roles = resolveHeavyRoles(ctx.config.coordinators);
    if (!roles) return;

    const totalLoops = ctx.config.topologyOptions?.heavyLoops        ?? 1;
    const usePresets = ctx.config.topologyOptions?.heavyPresetAgents ?? false;

    const captainCoord = usePresets ? withPreset(roles.captain, CAPTAIN_SYSTEM_PROMPT) : roles.captain;
    const synthCoord   = usePresets ? withPreset(roles.synthesis, SYNTHESIS_SYSTEM_PROMPT) : roles.synthesis;
    const specialistCoords = usePresets
      ? roles.specialists.map(s => withPreset(s, resolveSpecialistPrompt(s.role)))
      : roles.specialists;

    const knownSpecialistIds = new Set(roles.specialists.map(s => s.id));
    const specialistRoster = roles.specialists
      .map(s => `- ${s.id} (${s.role || 'specialist'})`)
      .join('\n');

    let priorSynthesis = '';

    for (let loop = 1; loop <= totalLoops; loop++) {
      if (ctx.abort.signal.aborted) break;

      // ── Phase 1: Captain decomposes the goal into specialist questions ──
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology: 'heavy-swarm',
        loop,
        totalLoops,
        phase:    'questions',
      });

      await spawnCoordinator(captainCoord, ctx, {
        loop:               String(loop),
        total_loops:        String(totalLoops),
        specialist_roster:  specialistRoster,
        prior_synthesis:    priorSynthesis || '(no prior loops)',
        max_turns_hint:     String(captainCoord.maxTurns ?? 10),
      });
      if (ctx.abort.signal.aborted) break;

      const rawQuestions = readKey(ctx, 'heavy:questions');
      const parsed       = parseCaptainQuestions(rawQuestions, knownSpecialistIds);
      if (!parsed || Object.keys(parsed.questions).length === 0) {
        emitTopologyEvent(ctx, 'coordinator:error', {
          agentId:    roles.captain.id,
          message:    `Failed to parse captain questions JSON on loop ${loop} (no valid specialist-id → question mappings).`,
          rawExcerpt: rawQuestions.slice(0, 500),
        });
        break;
      }

      // Stage per-specialist questions before workers spawn so the spawn site
      // can pull the matching question via template variable.
      for (const [id, q] of Object.entries(parsed.questions)) {
        writeKey(ctx, `heavy:question:${id}`, q);
      }
      // Clear stale results from a prior loop so synthesis only sees this loop's outputs.
      for (const s of roles.specialists) {
        writeKey(ctx, `heavy:result:${s.id}`, '');
      }

      // ── Phase 2: Specialists answer in parallel (only those the captain addressed) ──
      const addressed = specialistCoords.filter(s => parsed.questions[s.id]);
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:        'heavy-swarm',
        loop,
        totalLoops,
        phase:           'specialists',
        specialistCount: addressed.length,
      });

      await runCoordinatorsInParallel(
        addressed.map(s => () => spawnCoordinator(s, ctx, {
          loop:                String(loop),
          total_loops:         String(totalLoops),
          specialist_question: parsed.questions[s.id]!,
          result_key:          `heavy:result:${s.id}`,
          max_turns_hint:      String(s.maxTurns ?? 10),
        })),
      );
      if (ctx.abort.signal.aborted) break;

      // ── Phase 3: Synthesis aggregates ───────────────────────────────────
      const resultBlocks: string[] = [];
      for (const s of roles.specialists) {
        const out = readKey(ctx, `heavy:result:${s.id}`);
        if (out) resultBlocks.push(`## ${s.id} (${s.role || 'specialist'}):\n${out}`);
      }
      const specialistResults = resultBlocks.join('\n\n') || '(no specialist outputs were produced)';

      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology: 'heavy-swarm',
        loop,
        totalLoops,
        phase:    'synthesis',
      });

      await spawnCoordinator(synthCoord, ctx, {
        loop:                String(loop),
        total_loops:         String(totalLoops),
        captain_questions:   JSON.stringify(parsed.questions, null, 2),
        specialist_results:  specialistResults,
        prior_synthesis:     priorSynthesis || '(no prior loops)',
        max_turns_hint:      String(synthCoord.maxTurns ?? 14),
      });
      if (ctx.abort.signal.aborted) break;

      // Capture this loop's synthesis to feed the next loop's captain + synthesis.
      priorSynthesis = readKey(ctx, 'heavy:final_report');
    }
  },
};
