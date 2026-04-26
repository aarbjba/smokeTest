import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { db as mainDb } from '../db.js';
import { createRunDb, generateRunId, runDbPath } from './swarm-db.js';
import { buildSwarmMcpConfigFile, cleanupMcpConfigFile } from './swarm-mcp-config.js';
import { treeKill } from './claude-sessions.js';
import type { SwarmConfig, CoordinatorConfig, ModelTier } from '../swarm-schemas.js';
import { MODEL_IDS } from '../swarm-schemas.js';
import { getTopologyHandler } from './swarm-topology/index.js';

const CLAUDE_CMD  = process.env.CLAUDE_CLI ?? 'claude';
const IS_WINDOWS  = process.platform === 'win32';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SwarmEventType =
  | 'swarm:start' | 'swarm:end'
  | 'coordinator:start' | 'coordinator:text' | 'coordinator:tool_call'
  | 'coordinator:tool_result' | 'coordinator:terminate' | 'coordinator:error' | 'coordinator:end'
  | 'subagent:spawn' | 'subagent:complete'
  | 'blackboard:write' | 'bus:message' | 'progress' | 'tokens' | 'error'
  | 'topology:phase_change';

export interface SwarmEvent {
  type: SwarmEventType;
  data: Record<string, unknown>;
}

export type EmitFn = (event: SwarmEvent) => void;

export interface RunContext {
  runId:            string;
  runDb:            Database.Database;
  config:           SwarmConfig;
  emitEvent:        EmitFn;
  abort:            AbortController;
  coordinatorPids:  Map<string, number>;
  seqCounters:      Map<string, number>;
  pendingToolUse:   Map<string, string>;   // toolUseId → toolName
  turnCounters:     Map<string, number>;
}

/**
 * Emit a structured event AND persist it to the run-DB events table.
 * Topology handlers use this to record phase changes without touching the DB directly.
 */
export function emitTopologyEvent(
  ctx: RunContext,
  type: SwarmEventType,
  data: Record<string, unknown>,
): void {
  emitAndStore(ctx, 'swarm', type, data);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextSeq(ctx: RunContext, agentId: string): number {
  const cur = ctx.seqCounters.get(agentId) ?? 0;
  const next = cur + 1;
  ctx.seqCounters.set(agentId, next);
  return next;
}

function emitAndStore(ctx: RunContext, agentId: string, type: SwarmEventType, data: Record<string, unknown>): void {
  const ts  = Date.now();
  const seq = nextSeq(ctx, agentId);
  ctx.runDb.prepare(
    'INSERT INTO events (agent_id, type, data, ts, seq) VALUES (?, ?, ?, ?, ?)'
  ).run(agentId, type, JSON.stringify(data), ts, seq);
  ctx.emitEvent({ type, data });
}

function renderCoordinatorPrompt(
  coordConfig: CoordinatorConfig,
  ctx: RunContext,
  extraVars: Record<string, string> = {},
): string {
  const peerIds = ctx.config.coordinators
    .filter(c => c.id !== coordConfig.id)
    .map(c => c.id)
    .join(', ');
  const subagentNames = coordConfig.subagents.map(s => s.name).join(', ');

  let rendered = coordConfig.systemPromptTemplate
    .replace(/\{\{goal\}\}/g,           ctx.config.goal)
    .replace(/\{\{id\}\}/g,             coordConfig.id)
    .replace(/\{\{role\}\}/g,           coordConfig.role)
    .replace(/\{\{peer_ids\}\}/g,       peerIds || '(none)')
    .replace(/\{\{subagent_names\}\}/g, subagentNames || '(none)')
    .replace(/\{\{run_id\}\}/g,         ctx.runId);

  for (const [key, value] of Object.entries(extraVars)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rendered = rendered.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'g'), value);
  }
  return rendered;
}

// ─── Stream-JSON Parser ───────────────────────────────────────────────────────

function handleCoordinatorLine(agentId: string, raw: string, ctx: RunContext): void {
  const line = raw.trim();
  if (!line) return;

  let ev: Record<string, unknown>;
  try { ev = JSON.parse(line); }
  catch { return; }

  if (!ev || typeof ev !== 'object') return;

  switch (ev['type']) {
    case 'system':
      // init message — no event needed
      return;

    case 'assistant': {
      const content = (ev['message'] as Record<string, unknown> | undefined)?.['content'];
      if (!Array.isArray(content)) return;
      for (const c of content as Record<string, unknown>[]) {
        if (c['type'] === 'text' && typeof c['text'] === 'string') {
          emitAndStore(ctx, agentId, 'coordinator:text', { agentId, text: c['text'] });
        } else if (c['type'] === 'tool_use') {
          const toolUseId = c['id'] as string;
          const toolName  = c['name'] as string;
          const input     = c['input'] as Record<string, unknown> ?? {};

          ctx.pendingToolUse.set(toolUseId, toolName);

          emitAndStore(ctx, agentId, 'coordinator:tool_call', {
            agentId, toolName, toolUseId,
            input: JSON.stringify(input),
          });

          // Semantic events for known swarm tools
          if (toolName === 'Task') {
            const prompt = String(input['prompt'] ?? '');
            emitAndStore(ctx, agentId, 'subagent:spawn', { agentId, toolUseId, prompt, parentId: agentId });
            ctx.runDb.prepare(
              'INSERT OR IGNORE INTO agents (id, parent_id, role, model, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(toolUseId, agentId, 'subagent', '', 'subagent', 'running', Date.now());
          } else if (toolName === 'terminate') {
            const reason = String(input['reason'] ?? '');
            ctx.emitEvent({ type: 'coordinator:terminate', data: { agentId, reason } });
          } else if (toolName === 'report_progress') {
            const msg     = String(input['message'] ?? '');
            const percent = typeof input['percent'] === 'number' ? input['percent'] : undefined;
            ctx.emitEvent({ type: 'progress', data: { agentId, message: msg, percent } });
          } else if (toolName === 'write_blackboard') {
            const key   = String(input['key'] ?? '');
            const value = String(input['value'] ?? '');
            ctx.emitEvent({ type: 'blackboard:write', data: { agentId, key, value } });
          } else if (toolName === 'send_to_peer') {
            const to      = String(input['to_agent'] ?? '');
            const kind    = String(input['kind'] ?? 'send');
            const payload = String(input['payload'] ?? '');
            ctx.emitEvent({ type: 'bus:message', data: { from: agentId, to, kind, payload } });
          }
        }
      }
      return;
    }

    case 'user': {
      const content = (ev['message'] as Record<string, unknown> | undefined)?.['content'];
      if (!Array.isArray(content)) return;
      for (const c of content as Record<string, unknown>[]) {
        if (c['type'] === 'tool_result') {
          const toolUseId = c['tool_use_id'] as string;
          const toolName  = ctx.pendingToolUse.get(toolUseId) ?? 'unknown';
          const isError   = Boolean(c['is_error']);
          const rawContent = c['content'];
          const output = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? (rawContent as Record<string, unknown>[])
                  .filter(b => b['type'] === 'text')
                  .map(b => b['text'])
                  .join('')
              : JSON.stringify(rawContent ?? '');

          ctx.pendingToolUse.delete(toolUseId);

          emitAndStore(ctx, agentId, 'coordinator:tool_result', {
            agentId, toolUseId, toolName,
            output,
            isError,
          });

          if (toolName === 'Task') {
            const success = !isError;
            emitAndStore(ctx, agentId, 'subagent:complete', {
              agentId, toolUseId,
              result: output,
              success,
            });
            ctx.runDb.prepare(
              'UPDATE agents SET status = ?, ended_at = ? WHERE id = ?'
            ).run(isError ? 'error' : 'terminated', Date.now(), toolUseId);
          }
        }
      }
      return;
    }

    case 'result': {
      const usage = ev['usage'] as Record<string, number> | undefined;
      if (usage) {
        const tokenData = {
          agentId,
          inputTokens:  usage['input_tokens']  ?? 0,
          outputTokens: usage['output_tokens'] ?? 0,
          cacheRead:    usage['cache_read_input_tokens'] ?? 0,
          cacheWrite:   usage['cache_creation_input_tokens'] ?? 0,
        };
        const turnIdx = ctx.turnCounters.get(agentId) ?? 0;
        ctx.runDb.prepare(
          'INSERT INTO tokens (agent_id, turn_index, input_tokens, output_tokens, cache_read, cache_write, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(agentId, turnIdx, tokenData.inputTokens, tokenData.outputTokens, tokenData.cacheRead, tokenData.cacheWrite, Date.now());
        ctx.turnCounters.set(agentId, turnIdx + 1);
        emitAndStore(ctx, agentId, 'tokens', tokenData);

        // Check global token limit
        const totalRow = ctx.runDb.prepare(
          'SELECT SUM(input_tokens + output_tokens) as total FROM tokens'
        ).get() as { total: number | null };
        if ((totalRow?.total ?? 0) > ctx.config.globalTokenLimit) {
          ctx.abort.abort();
        }
      }
      if (ev['is_error']) {
        const msg = String(ev['error'] ?? 'unknown error');
        emitAndStore(ctx, agentId, 'coordinator:error', { agentId, message: msg });
      }
      return;
    }

    default:
      // Unknown event — ignore gracefully
  }
}

// ─── Coordinator Spawn ───────────────────────────────────────────────────────

/**
 * Spawn one coordinator subprocess. Resolves when the child exits or errors.
 *
 * `extraVars` adds template-variable substitutions on top of the built-in ones
 * (`{{goal}}`, `{{role}}`, etc.). Topology handlers use this to inject
 * round-specific or phase-specific context.
 */
export async function spawnCoordinator(
  coordConfig: CoordinatorConfig,
  ctx: RunContext,
  extraVars: Record<string, string> = {},
): Promise<void> {
  const agentId    = coordConfig.id;
  const modelId    = MODEL_IDS[coordConfig.model as ModelTier] ?? MODEL_IDS.sonnet;
  const allAgentIds = ctx.config.coordinators.map(c => c.id);
  const dbPath     = runDbPath(ctx.runId);

  // Register agent in Run-DB
  ctx.runDb.prepare(
    'INSERT OR IGNORE INTO agents (id, role, model, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agentId, coordConfig.role, modelId, 'coordinator', 'running', Date.now());

  emitAndStore(ctx, agentId, 'coordinator:start', { agentId, role: coordConfig.role, model: modelId });

  // Build MCP config for this coordinator
  const mcpConfigPath = buildSwarmMcpConfigFile(ctx.runId, agentId, allAgentIds, dbPath);

  const systemPrompt = renderCoordinatorPrompt(coordConfig, ctx, extraVars);

  // One-shot spawn: pass the prompt as plain text via stdin (default
  // --input-format=text). Claude processes the single prompt and exits when
  // stdin reaches EOF. We keep --output-format=stream-json so we can parse
  // the per-message event stream as before.
  //
  // We deliberately do NOT use --input-format=stream-json here, even though
  // the architect session in claude-sessions.ts does. stream-json is for
  // multi-turn interactive sessions where the runtime pushes follow-up turns;
  // a coordinator is one-shot and self-terminates via the `terminate` MCP
  // tool, so stream-json would just leave the process blocked on stdin until
  // the global timeout aborted it.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model', modelId,
    '--mcp-config', mcpConfigPath,
  ];

  const child = spawn(CLAUDE_CMD, args, {
    cwd:         process.cwd(),
    env:         { ...process.env },
    shell:       true,
    windowsHide: true,
    stdio:       ['pipe', 'pipe', 'pipe'],
    detached:    !IS_WINDOWS,
  });

  if (child.pid) {
    ctx.coordinatorPids.set(agentId, child.pid);
  }

  // Plain-text prompt + EOF. Claude treats this as the single user message
  // and exits when stdin closes (per --input-format=text default).
  child.stdin?.write(systemPrompt, 'utf8');
  child.stdin?.end();

  // Stream stdout line by line
  let stdoutBuffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      handleCoordinatorLine(agentId, line, ctx);
    }
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    // MCP servers write to stderr; we capture it so a hard exit (no JSON
    // events on stdout) leaves a diagnostic trail in the run-DB instead of
    // an empty `coordinator:end` with exit code 1.
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-16_384);
  });

  // Abort signal → kill process
  const onAbort = () => treeKill(child.pid);
  ctx.abort.signal.addEventListener('abort', onAbort, { once: true });

  return new Promise<void>((resolve) => {
    child.on('error', (err) => {
      ctx.coordinatorPids.delete(agentId);
      ctx.abort.signal.removeEventListener('abort', onAbort);
      cleanupMcpConfigFile(mcpConfigPath);
      emitAndStore(ctx, agentId, 'coordinator:error', { agentId, message: err.message });
      ctx.runDb.prepare(
        'UPDATE agents SET status = ?, ended_at = ?, error_msg = ? WHERE id = ?'
      ).run('error', Date.now(), err.message, agentId);
      resolve();
    });

    child.on('close', (exitCode) => {
      // Flush remaining stdout
      if (stdoutBuffer.trim()) {
        handleCoordinatorLine(agentId, stdoutBuffer, ctx);
        stdoutBuffer = '';
      }
      ctx.coordinatorPids.delete(agentId);
      ctx.abort.signal.removeEventListener('abort', onAbort);
      cleanupMcpConfigFile(mcpConfigPath);

      // If the child exited non-zero without emitting any structured events,
      // surface stderr so the run-DB explains *why* (auth failure, bad args,
      // missing model, etc.) instead of forcing the operator to read logs.
      const turnCount = ctx.turnCounters.get(agentId) ?? 0;
      if (exitCode !== 0 && turnCount === 0 && stderrBuf.trim()) {
        emitAndStore(ctx, agentId, 'coordinator:error', {
          agentId,
          message: `child exited with code ${exitCode} before producing any output. stderr: ${stderrBuf.slice(-2000)}`,
        });
      }
      emitAndStore(ctx, agentId, 'coordinator:end', { agentId, exitCode, turnCount });
      ctx.runDb.prepare(
        'UPDATE agents SET status = ?, ended_at = ?, exit_code = ? WHERE id = ?'
      ).run(exitCode === 0 ? 'terminated' : 'error', Date.now(), exitCode, agentId);

      resolve();
    });
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runSwarm(
  config:    SwarmConfig,
  emitEvent: EmitFn,
  signal?:   AbortSignal,
): Promise<{ runId: string; status: 'done' | 'error' | 'aborted' }> {
  const runId  = generateRunId();
  const runDb  = createRunDb(runId);
  const dbPath = runDbPath(runId);
  const abort  = new AbortController();

  if (signal) {
    signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  const ctx: RunContext = {
    runId,
    runDb,
    config,
    emitEvent,
    abort,
    coordinatorPids: new Map(),
    seqCounters:     new Map(),
    pendingToolUse:  new Map(),
    turnCounters:    new Map(),
  };

  // Insert run record in main DB
  mainDb.prepare(
    `INSERT INTO swarm_runs (id, config_json, goal, status, db_path, coordinator_count, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, unixepoch())`
  ).run(runId, JSON.stringify(config), config.goal, dbPath, config.coordinators.length);

  emitAndStore(ctx, 'swarm', 'swarm:start', {
    runId,
    goal:             config.goal,
    topology:         config.topology,
    coordinatorCount: config.coordinators.length,
  });

  // Topology dispatch — handler decides scheduling (parallel, sequential, rounds, …).
  const handler = getTopologyHandler(config.topology);
  const validation = handler.validate(config);
  if (!validation.valid) {
    emitAndStore(ctx, 'swarm', 'error', {
      message: `Invalid config for topology "${config.topology}": ${validation.errors.join('; ')}`,
    });
    abort.abort();
  }

  // Timeout
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (config.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => abort.abort(), config.timeoutMs);
  }

  try {
    if (validation.valid) {
      await handler.run(ctx);
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Determine final status
  const isAborted = abort.signal.aborted && !!signal?.aborted === false
    ? true
    : abort.signal.aborted;

  let finalStatus: 'done' | 'error' | 'aborted';
  if (isAborted) {
    finalStatus = 'aborted';
  } else {
    const errorRow = runDb.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE status = 'error' AND kind = 'coordinator'"
    ).get() as { c: number };
    finalStatus = errorRow.c > 0 ? 'error' : 'done';
  }

  // Sum total tokens
  const tokenRow = runDb.prepare(
    'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM tokens'
  ).get() as { total: number };
  const totalTokens = tokenRow.total;
  const durationMs  = Date.now() - (
    (mainDb.prepare('SELECT started_at FROM swarm_runs WHERE id = ?').get(runId) as { started_at: number })?.started_at * 1000
  );

  emitAndStore(ctx, 'swarm', 'swarm:end', { runId, status: finalStatus, totalTokens, durationMs });

  mainDb.prepare(
    `UPDATE swarm_runs SET status = ?, ended_at = unixepoch(), total_tokens = ? WHERE id = ?`
  ).run(finalStatus, totalTokens, runId);

  runDb.close();

  return { runId, status: finalStatus };
}
