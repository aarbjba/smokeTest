import { Router, type Response } from 'express';
import { z } from 'zod';
import { claudeSessions, type ClaudeSession } from '../services/claude-sessions.js';

export const agentRouter = Router();

const StartSchema = z.object({
  prompt: z.string().min(1).max(50_000),
  cwd: z.string().min(1).max(1000),
  attachmentIds: z.array(z.number().int().positive()).max(100).optional(),
  mode: z.enum(['work', 'analyse']).optional().default('work'),
  includeAnalyses: z.boolean().optional().default(false),
});

const SendSchema = z.object({
  prompt: z.string().min(1).max(50_000),
  attachmentIds: z.array(z.number().int().positive()).max(100).optional(),
});

function sessionSnapshot(s: ClaudeSession | undefined) {
  if (!s) return null;
  return {
    todoId: s.todoId,
    status: s.status,
    turnActive: s.turnActive,
    output: s.output,
    turns: s.turns.map((t) => ({
      index: t.index,
      prompt: t.prompt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      result: t.result,
    })),
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    exitCode: s.exitCode,
    errorMessage: s.errorMessage,
    cwd: s.cwd,
    prompt: s.prompt,
  };
}

agentRouter.get('/session/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const session = claudeSessions.get(todoId);
  res.json({ session: sessionSnapshot(session) });
});

agentRouter.get('/sessions', (_req, res) => {
  res.json({ sessions: claudeSessions.all().map(sessionSnapshot) });
});

agentRouter.post('/session/:todoId/start', (req, res) => {
  const todoId = Number(req.params.todoId);
  const data = StartSchema.parse(req.body);
  try {
    const session = claudeSessions.start(todoId, data.prompt, data.cwd, data.attachmentIds ?? [], data.mode, data.includeAnalyses);
    res.status(201).json({ session: sessionSnapshot(session) });
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'start failed';
    res.status(status).json({ error: message });
  }
});

agentRouter.post('/session/:todoId/send', (req, res) => {
  const todoId = Number(req.params.todoId);
  const data = SendSchema.parse(req.body);
  try {
    const session = claudeSessions.send(todoId, data.prompt, data.attachmentIds ?? []);
    res.status(200).json({ session: sessionSnapshot(session) });
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof Error ? err.message : 'send failed';
    res.status(status).json({ error: message });
  }
});

agentRouter.post('/session/:todoId/stop', (req, res) => {
  const todoId = Number(req.params.todoId);
  const session = claudeSessions.stop(todoId);
  res.json({ session: sessionSnapshot(session) });
});

agentRouter.delete('/session/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  claudeSessions.clear(todoId);
  res.status(204).end();
});

/**
 * Server-Sent Events stream of a session's lifecycle.
 */
agentRouter.get('/session/:todoId/stream', (req, res: Response) => {
  const todoId = Number(req.params.todoId);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const snapshot = claudeSessions.get(todoId);
  write('snapshot', sessionSnapshot(snapshot));

  const onChunk = (id: number, text: string) => {
    if (id !== todoId) return;
    write('chunk', { text });
  };
  const onEnd = (id: number, session: ClaudeSession) => {
    if (id !== todoId) return;
    write('end', sessionSnapshot(session));
  };
  const onCleared = (id: number) => {
    if (id !== todoId) return;
    write('cleared', { todoId: id });
  };

  const onTurnEnd = (id: number, session: ClaudeSession) => {
    if (id !== todoId) return;
    write('turn-end', sessionSnapshot(session));
  };

  claudeSessions.on('chunk', onChunk);
  claudeSessions.on('end', onEnd);
  claudeSessions.on('cleared', onCleared);
  claudeSessions.on('turn-end', onTurnEnd);

  const heartbeat = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    claudeSessions.off('chunk', onChunk);
    claudeSessions.off('end', onEnd);
    claudeSessions.off('cleared', onCleared);
    claudeSessions.off('turn-end', onTurnEnd);
  });
});
