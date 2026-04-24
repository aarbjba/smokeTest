import { Router, type Response } from 'express';
import { SandboxStartSchema } from '../schemas.js';
import {
  startSandboxRun,
  stopSandboxRun,
  listRuns,
  rebuildImage,
  testConnection,
} from '../services/sandbox-runner.js';

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
    const gen = rebuildImage();
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

sandboxRouter.post('/settings/test-connection', async (_req, res) => {
  try {
    const result = await testConnection();
    res.json(result);
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'test-connection failed';
    res.status(status).json({ ok: false, werkbankReachable: false, detail: message });
  }
});
