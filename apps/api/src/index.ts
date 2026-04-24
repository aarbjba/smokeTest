import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the repo root, not the apps/api cwd that npm -w sets.
// Walking up from apps/api/src/index.ts: ../../../.env
const __dirname_es = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname_es, '../../../.env') });

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { initDb } from './db.js';
import { todosRouter } from './routes/todos.js';
import { snippetsRouter } from './routes/snippets.js';
import { subtasksRouter } from './routes/subtasks.js';
import { pomodoroRouter } from './routes/pomodoro.js';
import { integrationsRouter } from './routes/integrations.js';
import { settingsRouter } from './routes/settings.js';
import { attachmentsRouter } from './routes/attachments.js';
import { agentRouter } from './routes/agent.js';
import { icsRouter } from './routes/ics.js';
import { standupRouter } from './routes/standup.js';
import { recurrencesRouter } from './routes/recurrences.js';
import { aiRouter } from './routes/ai.js';
import { repoMappingsRouter } from './routes/repo-mappings.js';
import { analysesRouter } from './routes/analyses.js';
import { queueRouter } from './routes/queue.js';
import { sandboxRouter } from './routes/sandbox.js';
import { fsRouter } from './routes/fs.js';
import { startScheduler } from './services/scheduler.js';
import { startRecurrenceScheduler } from './services/recurrence-generator.js';
import { startQueueRunner } from './services/queue-runner.js';
import { sweepOrphans } from './services/sandbox-runner.js';

const app = express();
const PORT = Number(process.env.API_PORT ?? 3001);

initDb();

app.use(cors({ origin: true, credentials: true }));
// strict:false lets settings values be bare JSON strings/numbers/bools, not
// just objects/arrays — matches the contract of /api/settings/:key PUT and
// matches what api.settings.set() already sends (JSON.stringify of any value).
app.use(express.json({ limit: '2mb', strict: false }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/todos', todosRouter);
app.use('/api/snippets', snippetsRouter);
app.use('/api/subtasks', subtasksRouter);
app.use('/api/pomodoro', pomodoroRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/agent', agentRouter);
// ICS calendar feed: served directly under /api (the router itself handles
// the ics.ics path) so subscribers hit a stable, filename-ending URL.
app.use('/api', icsRouter);
app.use('/api/standup', standupRouter);
app.use('/api/recurrences', recurrencesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/repo-mappings', repoMappingsRouter);
app.use('/api/analyses', analysesRouter);
app.use('/api/queue', queueRouter);
app.use('/api/sandbox', sandboxRouter);
app.use('/api/fs', fsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'ValidationError', issues: err.issues });
  }
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  const status = (err as { status?: number })?.status ?? 500;
  console.error('[api error]', err);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`[werkbank-api] listening on http://localhost:${PORT}`);
  startScheduler();
  startRecurrenceScheduler();
  startQueueRunner();
  // Clean up orphan sandbox containers left behind by a crash / kill -9.
  // Non-blocking and non-fatal — the docker context may be unreachable on boot.
  sweepOrphans().catch(() => {});
});
