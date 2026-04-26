/**
 * Planner-Worker topology — one planner decomposes the goal into tasks, N workers
 * claim tasks atomically from a shared queue, optional judge evaluates the run.
 *
 * Ported from kyegomez/swarms `PlannerWorkerSwarm` (Apache-2.0). The Python
 * original uses an in-memory `TaskQueue` protected by a `threading.Lock` plus a
 * `ThreadPoolExecutor` of worker agents. Since werkbank coordinators are
 * separate Claude-CLI subprocesses, the queue lives in the per-run SQLite
 * database (`swarm_tasks` table) and atomicity comes from a transaction with
 * an optimistic-locking `version` column. Workers publish/claim/complete tasks
 * through dedicated MCP tools (publish_tasks, claim_task, complete_task,
 * fail_task) that wrap that table.
 *
 * Mapping reference → werkbank:
 *   PlannerTask                                 → row in swarm_tasks (per-run DB)
 *   TaskQueue (threading.Lock)                  → swarm_tasks + SQLite transaction + version
 *   TaskQueue.add_tasks(tasks)                  → MCP tool publish_tasks
 *   TaskQueue.claim(worker_name)                → MCP tool claim_task
 *   TaskQueue.complete(task_id, result, ver)    → MCP tool complete_task
 *   TaskQueue.fail(task_id, err, ver)           → MCP tool fail_task
 *   TaskQueue.get_dependency_results(task_id)   → claim_task returns dep results in payload
 *   PlannerWorkerSwarm._run_planner             → spawnCoordinator(planner) — sequential phase 1
 *   WorkerPool.run() (ThreadPoolExecutor)       → Promise.allSettled(spawnCoordinator(worker))
 *   WorkerPool._worker_loop                     → worker prompt instructs claim→execute→complete loop
 *   PlannerWorkerSwarm._run_judge (optional)    → spawnCoordinator(judge) — sequential phase 3
 *   PLANNER_SYSTEM_PROMPT / WORKER / JUDGE      → embedded as presets when plannerWorkerPresetAgents=true
 *
 * Concurrency model — important deviation from the Python original:
 *   The reference loops inside one Python process and lets workers atomically
 *   mutate a shared dict. Each werkbank worker is its own subprocess, so it
 *   reaches the queue through MCP. Atomic claim + dependency-readiness check
 *   is implemented as a single SQLite transaction in `claim_task` (in
 *   apps/mcp/src/swarm-server.ts) — only tasks whose `depends_on` are all
 *   `completed` become claimable, and the version field guards complete/fail
 *   against stale writes.
 *
 * Coordinators are matched by their `role` field (case-insensitive substring):
 *   "planner" → exactly 1 planner (runs first)
 *   "judge"   → 0 or 1 judges (runs last, optional)
 *   anything else → workers (≥1, run in parallel after planner)
 *
 * With plannerWorkerPresetAgents=true the user-supplied systemPromptTemplate
 * is overridden by the built-in role prompts.
 */
import type { SwarmConfig, CoordinatorConfig } from '../../swarm-schemas.js';
import {
  spawnCoordinator,
  runCoordinatorsInParallel,
  emitTopologyEvent,
  type RunContext,
} from '../swarm-runtime.js';
import type { TopologyHandler, TopologyValidation } from './index.js';

// ─── Pre-built role prompts (semantics from kyegomez planner_worker_prompts) ─

const PLANNER_SYSTEM_PROMPT = `You are a Planner Agent in a planner-worker swarm system. Your ONLY job is to plan -- you do NOT execute tasks.

Given a goal or objective, you must:

1. **Analyze** the goal to understand what needs to be accomplished
2. **Decompose** the goal into concrete, actionable tasks that a worker agent can execute independently
3. **Prioritize** tasks ('high' | 'medium' | 'low')
4. **Identify dependencies** between tasks (which tasks must complete before others can start)

Guidelines for creating tasks:
- Each task must be self-contained: a worker with no context beyond the task description should be able to execute it
- Tasks should be at a granularity where one agent can complete them in a single execution
- Be specific: "Analyze Q3 revenue data and identify top 3 growth drivers" not "Analyze data"
- Specify expected output format when relevant
- If a task depends on another, list the dependency by id

CRITICAL: You are a planner. You produce tasks. You do NOT execute them.

---
Werkbank protocol (this is a multi-process swarm, you are coordinator {{id}} — the planner, cycle {{cycle}}/{{total_cycles}}):
- Goal: {{goal}}
- Worker pool size: {{worker_count}} concurrent workers will claim tasks once you publish them.

Previous-cycle context (empty on cycle 1):
{{previous_cycle_context}}

- Produce ALL tasks in a single call to the publish_tasks MCP tool.
- Each task needs: id (unique short slug), title (short label), description (full instructions for the
  worker — include all context they need, since workers run in isolation), priority ('high'|'medium'|'low'),
  depends_on (array of other task ids that must complete first; empty array if none).
- On cycles > 1: focus your new tasks on closing the gaps the judge identified; you may build on
  completed tasks from earlier cycles (their results are part of the run history).
- After publish_tasks succeeds, call terminate(). Do not exceed {{max_turns_hint}} turns.
- Do NOT attempt to execute tasks yourself.`;

const WORKER_SYSTEM_PROMPT = `You are a Worker Agent in a planner-worker swarm system. You receive specific tasks from a shared task queue and execute them thoroughly.

Your responsibilities:
1. Read the task description carefully
2. Execute the task completely and accurately
3. Produce a clear, actionable result
4. If you encounter an issue, describe it clearly so the task can be retried or reassigned

Guidelines:
- Focus ONLY on the task you are given -- do not attempt to plan or coordinate with other workers
- Produce concrete output, not plans or suggestions
- If the task asks for analysis, provide the analysis
- If the task asks for code, write the code
- If the task asks for a decision, make the decision with reasoning
- Be thorough but concise

---
Werkbank protocol (this is a multi-process swarm, you are coordinator {{id}} — a worker):
- Original goal (for context only): {{goal}}
- Loop until no work remains:
  1. Call claim_task({ worker_id: "{{id}}" }). Response is either { task: null } (no work) or
     { task: { id, title, description, priority, version, dependency_results } }.
  2. If task is null → call terminate() and stop.
  3. Otherwise: execute the task using its description. The dependency_results field contains the
     results of any prerequisite tasks — use them as context.
  4. On success: call complete_task({ worker_id: "{{id}}", task_id, result: <your result text> }).
  5. On failure: call fail_task({ worker_id: "{{id}}", task_id, error_msg: <what went wrong> }).
  6. Go back to step 1.
- Do not exceed {{max_turns_hint}} turns total. If you hit the limit, call terminate().`;

const JUDGE_SYSTEM_PROMPT = `You are a Cycle Judge in a planner-worker swarm system. After workers execute all planned tasks, you evaluate whether the original goal has been achieved.

Your evaluation must determine:
1. **is_complete** (bool): Has the goal been satisfactorily achieved? Be strict — partial completion is NOT complete.
2. **overall_quality** (0-10): Quality of the combined results
3. **summary**: Brief assessment of what was accomplished
4. **gaps** (array of strings): Specific things that are missing or need improvement
5. **follow_up_instructions** (string): If not complete, what should the planner focus on in the next cycle?
6. **needs_fresh_start** (bool): True if accumulated drift or systemic issues require a complete restart (all prior tasks discarded). False to keep completed work and only address gaps incrementally.

Evaluation standards:
- A score of 10 means exceptional, comprehensive achievement of the goal
- A score of 5 means functional but with significant gaps
- A score of 0-2 means the output is inadequate
- Only set is_complete=true if the goal is genuinely and fully achieved
- Be specific in gaps: "Missing competitive analysis section" not "Needs more work"
- Set needs_fresh_start=true only if the prior plan was fundamentally misaligned; prefer incremental gap-filling otherwise

---
Werkbank protocol (you are coordinator {{id}} — the judge, cycle {{cycle}}/{{total_cycles}}):
- Original goal: {{goal}}
- Task execution report:

{{task_report}}

- Produce a JSON object with EXACTLY these six fields:
\`\`\`json
{
  "is_complete":            <true|false>,
  "overall_quality":        <0-10>,
  "summary":                "<brief assessment>",
  "gaps":                   ["<gap 1>", "<gap 2>"],
  "follow_up_instructions": "<guidance for next planner cycle, or empty string if complete>",
  "needs_fresh_start":      <true|false>
}
\`\`\`
- Constraints: VALID JSON, no markdown fences, no comments, no trailing commas.
- If this is the final cycle ({{is_final_cycle}} = "true"), set is_complete to your honest verdict regardless — there is no next cycle either way.
- Write the JSON object as a STRING to blackboard key 'planner_worker:verdict' (overwrite).
- Call terminate() when done. Do not exceed {{max_turns_hint}} turns.`;

const PRESET_PROMPTS = {
  planner: PLANNER_SYSTEM_PROMPT,
  worker:  WORKER_SYSTEM_PROMPT,
  judge:   JUDGE_SYSTEM_PROMPT,
} as const;

// ─── Role resolution ────────────────────────────────────────────────────────

interface PlannerWorkerRoles {
  planner: CoordinatorConfig;
  workers: CoordinatorConfig[];
  judge:   CoordinatorConfig | null;
}

function findOnlyRole(coordinators: CoordinatorConfig[], needle: string): CoordinatorConfig[] {
  const lower = needle.toLowerCase();
  return coordinators.filter(c => c.role.toLowerCase().includes(lower));
}

function resolvePlannerWorkerRoles(coordinators: CoordinatorConfig[]): PlannerWorkerRoles | null {
  const planners = findOnlyRole(coordinators, 'planner');
  if (planners.length !== 1) return null;
  const planner = planners[0]!;

  const judges = findOnlyRole(coordinators, 'judge');
  if (judges.length > 1) return null;
  const judge = judges[0] ?? null;

  const workers = coordinators.filter(c =>
    c.id !== planner.id && (judge === null || c.id !== judge.id),
  );
  if (workers.length < 1) return null;

  return { planner, workers, judge };
}

function withPresetPrompt(coord: CoordinatorConfig, kind: keyof typeof PRESET_PROMPTS): CoordinatorConfig {
  return { ...coord, systemPromptTemplate: PRESET_PROMPTS[kind] };
}

// ─── Task report rendering for the judge ────────────────────────────────────

interface TaskRow {
  id:        string;
  title:     string;
  status:    string;
  result:    string | null;
  error_msg: string | null;
}

function renderTaskReport(ctx: RunContext): string {
  const rows = ctx.runDb
    .prepare('SELECT id, title, status, result, error_msg FROM swarm_tasks ORDER BY created_at ASC')
    .all() as TaskRow[];
  if (rows.length === 0) return '(no tasks were published)';
  return rows
    .map(r => `- [${r.status}] ${r.id} — ${r.title}\n    ${r.result ?? r.error_msg ?? '(no result)'}`)
    .join('\n');
}

// ─── CycleVerdict (mirrors planner_worker_schemas.py:CycleVerdict) ──────────

interface CycleVerdict {
  is_complete:            boolean;
  overall_quality:        number;
  summary:                string;
  gaps:                   string[];
  follow_up_instructions: string;
  needs_fresh_start:      boolean;
}

function stripFence(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return m ? m[1]! : raw;
}

/**
 * Parse the judge's JSON verdict from blackboard. Tolerates markdown fences
 * and missing optional fields (gaps default to []; needs_fresh_start defaults
 * to false). Returns null on any structural failure — the cycle loop treats
 * that as is_complete=false and moves on.
 */
function parseCycleVerdict(raw: string): CycleVerdict | null {
  const cleaned = stripFence(raw).trim();
  if (!cleaned) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['is_complete'] !== 'boolean') return null;
  if (typeof o['overall_quality'] !== 'number') return null;
  if (typeof o['summary'] !== 'string') return null;
  if (typeof o['follow_up_instructions'] !== 'string') return null;
  const gaps = Array.isArray(o['gaps'])
    ? (o['gaps'] as unknown[]).filter((g): g is string => typeof g === 'string')
    : [];
  return {
    is_complete:            o['is_complete'],
    overall_quality:        o['overall_quality'],
    summary:                o['summary'],
    gaps,
    follow_up_instructions: o['follow_up_instructions'],
    needs_fresh_start:      typeof o['needs_fresh_start'] === 'boolean' ? o['needs_fresh_start'] : false,
  };
}

function readKey(ctx: RunContext, key: string): string {
  const row = ctx.runDb
    .prepare('SELECT value FROM blackboard WHERE key = ? AND is_current = 1')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/**
 * Apply the judge verdict to the task queue between cycles. Mirrors
 * planner_worker_swarm.py:_prepare_next_cycle (816-829):
 *   - needs_fresh_start=true  → wipe ALL tasks (drift-reset)
 *   - needs_fresh_start=false → drop only non-terminal tasks; completed/failed
 *                               results stay so the next planner can build on them
 */
function prepareNextCycle(ctx: RunContext, verdict: CycleVerdict): void {
  if (verdict.needs_fresh_start) {
    ctx.runDb.prepare('DELETE FROM swarm_tasks').run();
  } else {
    ctx.runDb.prepare(
      "DELETE FROM swarm_tasks WHERE status NOT IN ('completed', 'failed')",
    ).run();
  }
}

/** Render the prior verdict as planner-prompt context for cycles > 1. */
function renderPriorVerdictContext(verdict: CycleVerdict | null, cycle: number): string {
  if (!verdict || cycle === 1) return '(this is cycle 1 — no previous cycle)';
  const gapsList = verdict.gaps.length > 0
    ? verdict.gaps.map(g => `- ${g}`).join('\n')
    : '(judge listed no specific gaps)';
  return [
    `# Previous cycle ${cycle - 1} verdict:`,
    `- Quality score: ${verdict.overall_quality}/10`,
    `- Summary: ${verdict.summary}`,
    `# Gaps the judge identified:`,
    gapsList,
    `# Judge's follow-up instructions:`,
    verdict.follow_up_instructions || '(none)',
    verdict.needs_fresh_start
      ? `\n⚠ The judge requested a fresh start — all prior tasks have been cleared. Plan from scratch.`
      : `\nCompleted tasks from prior cycles remain in the run history; build on them, do not re-do them.`,
  ].join('\n');
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const plannerWorkerHandler: TopologyHandler = {
  topology: 'planner-worker',

  validate(config: SwarmConfig): TopologyValidation {
    const errors: string[] = [];
    if (config.coordinators.length < 2) {
      errors.push(`planner-worker requires at least 2 coordinators (1 planner + 1 worker), got ${config.coordinators.length}`);
    }
    const planners = findOnlyRole(config.coordinators, 'planner');
    if (planners.length !== 1) {
      errors.push(`planner-worker needs exactly one coordinator whose role contains "planner" (got ${planners.length})`);
    }
    const judges = findOnlyRole(config.coordinators, 'judge');
    if (judges.length > 1) {
      errors.push(`planner-worker allows at most one coordinator whose role contains "judge" (got ${judges.length})`);
    }
    const roles = resolvePlannerWorkerRoles(config.coordinators);
    if (!roles && errors.length === 0) {
      errors.push('planner-worker needs at least one worker coordinator (role does not contain "planner" or "judge")');
    }
    // Multi-cycle requires a judge to decide whether to break/iterate.
    const cycles = config.topologyOptions?.plannerWorkerLoops ?? 1;
    if (cycles > 1 && roles && !roles.judge) {
      errors.push(`plannerWorkerLoops=${cycles} requires a judge coordinator (role contains "judge"); without one there is no verdict to drive the loop`);
    }
    return { valid: errors.length === 0, errors };
  },

  async run(ctx: RunContext): Promise<void> {
    const roles = resolvePlannerWorkerRoles(ctx.config.coordinators);
    if (!roles) return;

    const usePresets  = ctx.config.topologyOptions?.plannerWorkerPresetAgents ?? false;
    const totalCycles = ctx.config.topologyOptions?.plannerWorkerLoops        ?? 1;
    const planner     = usePresets ? withPresetPrompt(roles.planner, 'planner') : roles.planner;
    const workers     = usePresets ? roles.workers.map(w => withPresetPrompt(w, 'worker')) : roles.workers;
    const judge       = roles.judge
      ? (usePresets ? withPresetPrompt(roles.judge, 'judge') : roles.judge)
      : null;

    let priorVerdict: CycleVerdict | null = null;

    for (let cycle = 1; cycle <= totalCycles; cycle++) {
      if (ctx.abort.signal.aborted) break;
      const isFinalCycle = cycle === totalCycles;

      // Between cycles: prune the queue based on the previous judge verdict.
      // Mirrors planner_worker_swarm.py:_prepare_next_cycle (816-829).
      if (cycle > 1 && priorVerdict) {
        prepareNextCycle(ctx, priorVerdict);
      }

      // ── Phase 1: Planner ────────────────────────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:    'planner-worker',
        phase:       'planning',
        cycle,
        totalCycles,
      });

      await spawnCoordinator(planner, ctx, {
        cycle:                   String(cycle),
        total_cycles:            String(totalCycles),
        worker_count:            String(workers.length),
        previous_cycle_context:  renderPriorVerdictContext(priorVerdict, cycle),
        max_turns_hint:          String(planner.maxTurns ?? 12),
      });
      if (ctx.abort.signal.aborted) break;

      // ── Phase 2: Workers race for tasks ─────────────────────────────────
      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:    'planner-worker',
        phase:       'execution',
        cycle,
        totalCycles,
        workerCount: workers.length,
      });

      await runCoordinatorsInParallel(
        workers.map(w => () => spawnCoordinator(w, ctx, {
          cycle:          String(cycle),
          total_cycles:   String(totalCycles),
          worker_count:   String(workers.length),
          max_turns_hint: String(w.maxTurns ?? 30),
        })),
      );
      if (ctx.abort.signal.aborted) break;

      // ── Phase 3: Judge (optional, but required for multi-cycle) ─────────
      if (!judge) {
        // No judge → single-pass mode; nothing more to do regardless of cycle count.
        break;
      }

      emitTopologyEvent(ctx, 'topology:phase_change', {
        topology:    'planner-worker',
        phase:       'judgement',
        cycle,
        totalCycles,
        isFinalCycle,
      });

      await spawnCoordinator(judge, ctx, {
        cycle:           String(cycle),
        total_cycles:    String(totalCycles),
        is_final_cycle:  isFinalCycle ? 'true' : 'false',
        task_report:     renderTaskReport(ctx),
        max_turns_hint:  String(judge.maxTurns ?? 8),
      });
      if (ctx.abort.signal.aborted) break;

      // Parse the verdict; on parse failure, treat as incomplete and continue
      // (matches planner_worker_swarm.py:797-807 fallback).
      const rawVerdict = readKey(ctx, 'planner_worker:verdict');
      priorVerdict = parseCycleVerdict(rawVerdict);

      if (!priorVerdict) {
        emitTopologyEvent(ctx, 'coordinator:error', {
          agentId:    roles.judge!.id,
          message:    `Failed to parse cycle ${cycle} verdict JSON from blackboard 'planner_worker:verdict'.`,
          rawExcerpt: rawVerdict.slice(0, 500),
        });
        // Continue to the next cycle; if this was the last cycle, the loop ends naturally.
        continue;
      }

      // Early-break when the goal is achieved (mirrors Python:911-915).
      if (priorVerdict.is_complete) break;
    }
  },
};
