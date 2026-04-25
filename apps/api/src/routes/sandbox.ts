import { Router, type Response } from 'express';
import { SandboxBackendEnum, SandboxStartSchema } from '../schemas.js';
import {
  startSandboxRun,
  stopSandboxRun,
  listRuns,
  rebuildImage,
  testConnection,
  type SandboxBackend,
} from '../services/sandbox-runner.js';

/**
 * Pull the optional backend selector out of either the query string or the
 * request body. Returns undefined if neither carries a valid value, so the
 * caller can fall back to the default. Invalid values are rejected with a
 * 400 via the Zod parse error.
 */
function parseBackendFromReq(query: unknown, body: unknown): SandboxBackend | undefined {
  const candidate =
    (query && typeof query === 'object' && 'backend' in query
      ? (query as Record<string, unknown>).backend
      : undefined) ??
    (body && typeof body === 'object' && 'backend' in body
      ? (body as Record<string, unknown>).backend
      : undefined);
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined;
  return SandboxBackendEnum.parse(candidate);
}

export const sandboxRouter = Router();

/**
 * Thin routes — all lifecycle lives in services/sandbox-runner.ts. Live
 * agent output is NOT streamed from this router; consumers subscribe to
 * `/api/agent/session/:todoId/stream` (the shared SSE pipe), where sandbox
 * output appears identically to local-agent output via
 * `claudeSessions.registerExternalSession`.
 */

sandboxRouter.post('/:todoId/start', async (req, res) => {
  const todoId = Number(req.params.todoId);
  const data = SandboxStartSchema.parse(req.body);
  try {
    const result = await startSandboxRun(todoId, data.prompt, {
      attachmentIds: data.attachmentIds,
      includeAnalyses: data.includeAnalyses,
      includeSnippets: data.includeSnippets,
      branchName: data.branchName,
      baseBranch: data.baseBranch,
      // Preserve explicit null so "clear the per-todo testCommand" works.
      testCommand: data.testCommand,
      maxTurns: data.maxTurns,
      timeoutMin: data.timeoutMin,
      // One-shot backend override; SandboxStartSchema validates the value.
      backend: data.backend,
    });
    res.status(201).json(result);
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'sandbox start failed';
    res.status(status).json({ error: message });
  }
});

sandboxRouter.post('/:todoId/stop', (req, res) => {
  const todoId = Number(req.params.todoId);
  try {
    const result = stopSandboxRun(todoId);
    res.json({ stopped: result.stopped });
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'sandbox stop failed';
    res.status(status).json({ error: message });
  }
});

sandboxRouter.get('/list', (_req, res) => {
  res.json({ runs: listRuns() });
});

/**
 * SSE-stream `docker build` chunks so the settings page can show live progress
 * during a rebuild. Event shape mirrors `routes/agent.ts:126-146` so existing
 * EventSource plumbing is reusable: `chunk { text }` per stdout/stderr fragment,
 * terminal `end { ok, imageTag }` once docker exits.
 */
sandboxRouter.post('/image/rebuild', async (req, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30_000);

  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
    clearInterval(heartbeat);
  });

  try {
    // Backend may come from `?backend=…` (preferred — body is unused on this
    // SSE-style POST) or `body.backend` if a future client switches.
    const backend = parseBackendFromReq(req.query, req.body);
    const gen = rebuildImage(backend);
    let next = await gen.next();
    while (!next.done) {
      if (clientGone) return;
      write('chunk', { text: next.value });
      next = await gen.next();
    }
    if (!clientGone) {
      write('end', { ok: next.value.ok, imageTag: next.value.imageTag });
    }
  } catch (err) {
    if (!clientGone) {
      write('end', {
        ok: false,
        error: err instanceof Error ? err.message : 'rebuild failed',
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!clientGone) res.end();
  }
});

sandboxRouter.post('/settings/test-connection', async (req, res) => {
  try {
    const backend = parseBackendFromReq(req.query, req.body);
    const result = await testConnection(backend);
    res.json(result);
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'test-connection failed';
    res.status(status).json({ ok: false, werkbankReachable: false, detail: message });
  }
});
