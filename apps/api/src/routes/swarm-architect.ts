import { Router } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db as mainDb } from '../db.js';
import { SwarmConfigSchema } from '../swarm-schemas.js';
import { claudeSessions } from '../services/claude-sessions.js';
import { z } from 'zod';

const __dirname_es = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname_es, '../../../..');

function architectMcpServers(): string {
  const compiledJs = resolve(REPO_ROOT, 'apps/mcp/dist/architect-server.js');
  const isCompiled  = existsSync(compiledJs);
  const apiUrl      = `http://localhost:${process.env.API_PORT ?? '3001'}`;
  const entry = isCompiled
    ? { command: 'node', args: [compiledJs] }
    : { command: 'node', args: ['--import', 'tsx/esm', resolve(REPO_ROOT, 'apps/mcp/src/architect-server.ts')] };
  return JSON.stringify([
    { name: 'architect', ...entry, env: { WERKBANK_API_URL: apiUrl } },
  ]);
}

export const swarmArchitectRouter = Router();

// ─── Architect session management ────────────────────────────────────────────

const StartSchema = z.object({
  goal: z.string().optional().default(''),
});

const SendSchema = z.object({
  todoId:  z.number().int().positive(),
  message: z.string().min(1).max(50_000),
});

/**
 * POST /api/swarm/architect/start
 * Creates a temporary todo and starts a claude session with the architect preprompt.
 */
swarmArchitectRouter.post('/architect/start', (req, res) => {
  const { goal } = StartSchema.parse(req.body);

  // Create a temporary todo for the architect session, with architect MCP servers
  const result = mainDb.prepare(
    `INSERT INTO todos (title, description, status, source, mcp_servers) VALUES (?, ?, 'todo', 'local', ?)`
  ).run(
    `Swarm Architect Session`,
    goal ? `Ziel: ${goal}` : 'Interaktive Swarm-Konfiguration',
    architectMcpServers(),
  );
  const todoId = result.lastInsertRowid as number;

  try {
    const cwd = process.cwd();
    claudeSessions.start(todoId, goal || 'Starte das Interview.', cwd, [], 'architect' as any, false, false);
    res.status(201).json({ todoId, sessionStarted: true });
  } catch (err) {
    // Clean up the temp todo if session start fails
    mainDb.prepare('DELETE FROM todos WHERE id = ?').run(todoId);
    const message = err instanceof Error ? err.message : 'Failed to start architect session';
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/swarm/architect/send
 * Sends a message to the running architect session.
 */
swarmArchitectRouter.post('/architect/send', (req, res) => {
  const { todoId, message } = SendSchema.parse(req.body);
  try {
    claudeSessions.send(todoId, message, []);
    res.json({ ok: true });
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const msg    = err instanceof Error ? err.message : 'send failed';
    res.status(status).json({ error: msg });
  }
});

/**
 * DELETE /api/swarm/architect/session/:todoId
 * Clears the architect session and removes the temp todo.
 */
swarmArchitectRouter.delete('/architect/session/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  claudeSessions.clear(todoId);
  // Remove the temp todo (only if it was created for the architect)
  mainDb.prepare(
    `DELETE FROM todos WHERE id = ? AND title = 'Swarm Architect Session'`
  ).run(todoId);
  res.status(204).end();
});

// ─── Config CRUD (architect-specific convenience endpoints) ──────────────────

const SaveConfigSchema = z.object({
  name:   z.string().optional().default(''),
  config: SwarmConfigSchema,
});

swarmArchitectRouter.post('/configs', (req, res) => {
  const data = SaveConfigSchema.parse(req.body);
  const result = mainDb.prepare(
    'INSERT INTO swarm_configs (name, goal, config_json) VALUES (?, ?, ?)'
  ).run(data.name, data.config.goal, JSON.stringify(data.config));
  res.status(201).json({ id: result.lastInsertRowid, name: data.name, goal: data.config.goal });
});

swarmArchitectRouter.get('/configs', (_req, res) => {
  const configs = mainDb.prepare(
    'SELECT id, name, goal, created_at, updated_at FROM swarm_configs ORDER BY created_at DESC'
  ).all();
  res.json({ configs });
});

swarmArchitectRouter.get('/configs/:id', (req, res) => {
  const config = mainDb.prepare(
    'SELECT id, name, goal, config_json, created_at, updated_at FROM swarm_configs WHERE id = ?'
  ).get(Number(req.params.id)) as Record<string, unknown> | undefined;
  if (!config) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ config: { ...config, config: JSON.parse(config['config_json'] as string) } });
});

swarmArchitectRouter.delete('/configs/:id', (req, res) => {
  mainDb.prepare('DELETE FROM swarm_configs WHERE id = ?').run(Number(req.params.id));
  res.status(204).end();
});
