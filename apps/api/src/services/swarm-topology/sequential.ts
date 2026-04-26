/**
 * Sequential topology — coordinators run in pipeline order A → B → C → …
 * Each coordinator's stage output (written to the blackboard) becomes the
 * `{{previous_output}}` input for the next coordinator.
 *
 * Ported from kyegomez/swarms `SequentialWorkflow` (Apache-2.0). The Python
 * original delegates execution to `AgentRearrange` with a flow string of the
 * form "A -> B -> C", relying on `Conversation` to thread each agent's output
 * into the next agent's input. Werkbank coordinators are independent
 * subprocesses that communicate via the blackboard, so the equivalent is to
 * spawn them one at a time and read each stage's blackboard key before
 * starting the next stage.
 *
 * Mapping reference → werkbank:
 *   sequential_workflow.py  agents=[A, B, C]                → ctx.config.coordinators (array order = pipeline order)
 *   sequential_workflow.py  flow = "A -> B -> C"            → for-loop over coordinators
 *   AgentRearrange.run() threading prior agent output       → spawnCoordinator(c, ctx, { previous_output })
 *   Conversation.add(name, output)                          → coordinator writes 'sequential:stage_<n>:<id>' via MCP
 *   sequential_workflow.py  drift_detection=True            → topologyOptions.sequentialDriftDetection (optional, off by default)
 *   sequential_workflow.py  DRIFT_DETECTION_PROMPT          → DRIFT_JUDGE_SYSTEM_PROMPT (preset, embedded below)
 *   sequential_workflow.py  drift_threshold (rerun loop)    → DEVIATION: see header note – we record one score, no rerun.
 *
 * Drift detection deviation:
 *   The Python version reruns the entire pipeline whenever the judge's score is
 *   below `drift_threshold`, and uses an OpenAI-style tool-call to extract the
 *   number. Werkbank coordinators terminate of their own accord and the rerun
 *   loop would multiply token spend without a stop guarantee, so this port
 *   spawns the drift judge once (as an extra coordinator-like Claude run) and
 *   stores its score under blackboard key `sequential:drift_score`. Re-running
 *   on low score is intentionally NOT implemented; the score is surfaced for
 *   the operator to act on. `sequentialDriftThreshold` is still accepted so a
 *   future reviewer can wire up the rerun if desired without a schema change.
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built drift-judge prompt (semantics from sequential_workflow.py) ───

const DRIFT_JUDGE_SYSTEM_PROMPT = `You are a semantic alignment judge. Evaluate how well a pipeline's final output addresses the original task.

Score the alignment on a scale from 0.0 to 1.0:
- 1.0  fully and precisely addresses the task
- 0.75 mostly addresses the task with minor gaps
- 0.5  partially addresses the task
- 0.25 barely addresses the task
- 0.0  completely unrelated to the task

---
Werkbank protocol (you are the SequentialWorkflow drift judge, coordinator {{id}}):
- Original task: {{goal}}
- Final pipeline output (from stage {{total_stages}}):

{{final_output}}

- Decide a single number between 0.0 and 1.0 (inclusive) using the rubric above.
- Write ONLY that number (e.g. "0.85") to blackboard key 'sequential:drift_score' (overwrite).
- Then call terminate() with a one-sentence justification. Do not exceed {{max_turns_hint}} turns.`;

// ─── Blackboard helpers ─────────────────────────────────────────────────────

function readKey(ctx: RunContext, key: string): string {
  const row = ctx.runDb
    .prepare('SELECT value FROM blackboard WHERE key = ? AND is_current = 1')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/**
 * Per-stage blackboard key, namespaced by loop number so multi-loop runs
 * don't clobber each other's stage outputs. Loop 1 still produces
 * `sequential:loop_1:stage_1:<id>` etc. — the older single-key shape
 * (`sequential:stage_<n>:<id>`) is intentionally not preserved because
 * no existing topology consumer reads those keys outside this handler.
 */
function stageKey(loop: number, stage: number, id: string): string {
  return `sequential:loop_${loop}:stage_${stage}:${id}`;
}

/** Build a JSON object {stageId → output} of every stage that has produced output so far IN THIS LOOP. */
function priorOutputsJson(
  ctx:                 RunContext,
  loop:                number,
  completedThroughIdx: number,
  coordinators:        readonly CoordinatorConfig[],
): string {
  const out: Record<string, string> = {};
  for (let i = 0; i < completedThroughIdx; i++) {
    const c     = coordinators[i]!;
    const value = readKey(ctx, stageKey(loop, i + 1, c.id));
    if (value) out[c.id] = value;
  }
  return JSON.stringify(out);
}

function withPresetDriftJudgePrompt(coord: CoordinatorConfig): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: DRIFT_JUDGE_SYSTEM_PROMPT };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const sequentialHandler: TopologyHandler = {
  topology: 'sequential',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];

    if (config.coordinators.length < 2) {
      errors.push(`sequential requires at least 2 coordinators (got ${config.coordinators.length})`);
    }

    // Drift judge, when enabled, needs a coordinator whose role contains "drift" or "judge".
    // It is always pulled OUT of the pipeline (it does not run as a stage).
    if (config.topologyOptions?.sequentialDriftDetection) {
      const judge = findDriftJudge(config.coordinators);
      if (!judge) {
        errors.push('sequentialDriftDetection=true requires one coordinator whose role contains "drift" or "judge"');
      } else if (config.coordinators.length - 1 < 2) {
        errors.push('sequentialDriftDetection=true reserves one coordinator as the judge; you need at least 3 total to keep a 2-stage pipeline');
      }
    }

    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const driftEnabled = ctx.config.topologyOptions?.sequentialDriftDetection ?? false;
    const totalLoops   = ctx.config.topologyOptions?.sequentialLoops          ?? 1;
    const judge        = driftEnabled ? findDriftJudge(ctx.config.coordinators) : null;

    // Pipeline = all coordinators except the (optional) drift judge, in array order.
    const pipeline = judge
      ? ctx.config.coordinators.filter(c => c.id !== judge.id)
      : [...ctx.config.coordinators];

    const totalStages = pipeline.length;

    // Outer loop carries the previous loop's final stage output forward
    // as "previous_output" seed for the next loop's stage 1 — mirrors
    // AgentRearrange.run() max_loops semantics (agent_rearrange.py:662).
    let priorLoopFinal = '';

    for (let loop = 1; loop <= totalLoops; loop++) {
      if (ctx.abort.signal.aborted) break;

      if (totalLoops > 1) {
        emitTopologyEvent(ctx, 'topology:phase_change', {
          topology:   'sequential',
          phase:      'loop_start',
          loop,
          totalLoops,
        });
      }

      for (let idx = 0; idx < pipeline.length; idx++) {
        if (ctx.abort.signal.aborted) break;

        const coord = pipeline[idx]!;
        const stage = idx + 1;

        // Stage 1 input: prior loop's final stage output (empty string on loop 1).
        // Stage N>1 input: this loop's previous stage output.
        const previous = idx === 0
          ? priorLoopFinal
          : readKey(ctx, stageKey(loop, stage - 1, pipeline[idx - 1]!.id));

        emitTopologyEvent(ctx, 'topology:phase_change', {
          topology:      'sequential',
          phase:         'stage',
          loop,
          totalLoops,
          stage,
          totalStages,
          coordinatorId: coord.id,
        });

        await spawnCoordinator(coord, ctx, {
          previous_output:    previous || '(no prior stage — you are the first stage of this pipeline)',
          stage:              String(stage),
          total_stages:       String(totalStages),
          loop:               String(loop),
          total_loops:        String(totalLoops),
          prior_outputs_json: priorOutputsJson(ctx, loop, idx, pipeline),
          stage_output_key:   stageKey(loop, stage, coord.id),
          max_turns_hint:     String(coord.maxTurns ?? 8),
        });
      }
      if (ctx.abort.signal.aborted) break;

      // Snapshot this loop's final stage output for the next loop's stage 1.
      const finalCoord = pipeline[pipeline.length - 1]!;
      priorLoopFinal   = readKey(ctx, stageKey(loop, pipeline.length, finalCoord.id));
    }

    if (!judge || ctx.abort.signal.aborted) return;

    // Drift detection: a single judging pass over the FINAL loop's final stage output.
    // The last value of priorLoopFinal already holds it.
    emitTopologyEvent(ctx, 'topology:phase_change', {
      topology:    'sequential',
      phase:       'drift_check',
      stage:       pipeline.length + 1,
      totalStages: pipeline.length,
    });

    const judgeCoord = withPresetDriftJudgePrompt(judge);
    await spawnCoordinator(judgeCoord, ctx, {
      final_output:    priorLoopFinal || '(empty — final stage produced no blackboard output)',
      total_stages:    String(pipeline.length),
      max_turns_hint:  String(judge.maxTurns ?? 4),
    });
  },
};

// ─── Drift-judge resolution (only used when sequentialDriftDetection=true) ──

function findDriftJudge(coordinators: readonly CoordinatorConfig[]): CoordinatorConfig | null {
  // Prefer an explicit "drift" role; fall back to any role containing "judge".
  const drift = coordinators.find(c => c.role.toLowerCase().includes('drift'));
  if (drift) return drift;
  const judge = coordinators.find(c => c.role.toLowerCase().includes('judge'));
  return judge ?? null;
}
