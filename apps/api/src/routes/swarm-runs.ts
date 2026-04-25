import { Router, type Response } from 'express';
import { existsSync, createReadStream, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { db as mainDb } from '../db.js';
import { openRunDb, runDbPath } from '../services/swarm-db.js';
import { runSwarm, type SwarmEvent } from '../services/swarm-runtime.js';
import { SwarmConfigSchema } from '../swarm-schemas.js';
import { z } from 'zod';

export const swarmRunsRouter = Router();

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function setupSse(res: Response): (event: string, data: unknown) => void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

// ─── POST /run — start from inline config ────────────────────────────────────

swarmRunsRouter.post('/run', (req, res) => {
  let config;
  try {
    config = SwarmConfigSchema.parse(req.body?.config ?? req.body);
  } catch (err) {
    res.status(400).json({ error: 'Invalid SwarmConfig', detail: String(err) });
    return;
  }

  const write = setupSse(res);
  const abort = new AbortController();

  const heartbeat = setInterval(() => res.write(':keepalive\n\n'), 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    abort.abort();
  });

  runSwarm(config, (event: SwarmEvent) => write(event.type, event.data), abort.signal)
    .then(({ runId, status }) => {
      write('swarm_end', { runId, status });
      clearInterval(heartbeat);
      res.end();
    })
    .catch((err) => {
      write('error', { message: String(err) });
      clearInterval(heartbeat);
      res.end();
    });
});

// ─── POST /run/:configId — start from saved config ───────────────────────────

swarmRunsRouter.post('/run/:configId', (req, res) => {
  const configId = Number(req.params.configId);
  const row = mainDb.prepare('SELECT config_json FROM swarm_configs WHERE id = ?').get(configId) as
    { config_json: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Config not found' });
    return;
  }

  let config;
  try {
    config = SwarmConfigSchema.parse(JSON.parse(row.config_json));
  } catch (err) {
    res.status(400).json({ error: 'Stored config is invalid', detail: String(err) });
    return;
  }

  const write = setupSse(res);
  const abort = new AbortController();
  const heartbeat = setInterval(() => res.write(':keepalive\n\n'), 30_000);

  req.on('close', () => { clearInterval(heartbeat); abort.abort(); });

  runSwarm(config, (event: SwarmEvent) => write(event.type, event.data), abort.signal)
    .then(({ runId, status }) => {
      write('swarm_end', { runId, status });
      clearInterval(heartbeat);
      res.end();
    })
    .catch((err) => {
      write('error', { message: String(err) });
      clearInterval(heartbeat);
      res.end();
    });
});

// ─── GET /runs — list runs ────────────────────────────────────────────────────

swarmRunsRouter.get('/runs', (req, res) => {
  const limit  = Math.min(Number(req.query.limit  ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);
  const status = req.query.status as string | undefined;

  const whereClause = status ? 'WHERE status = ?' : '';
  const params: (string | number)[] = status ? [status, limit, offset] : [limit, offset];

  const runs = mainDb.prepare(
    `SELECT id, goal, status, coordinator_count, total_tokens, started_at, ended_at, error_message
     FROM swarm_runs ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`
  ).all(...params);

  const total = (mainDb.prepare(
    `SELECT COUNT(*) as c FROM swarm_runs ${whereClause}`
  ).get(...(status ? [status] : [])) as { c: number }).c;

  res.json({ runs, total });
});

// ─── GET /runs/:id — single run metadata ─────────────────────────────────────

swarmRunsRouter.get('/runs/:id', (req, res) => {
  const run = mainDb.prepare(
    `SELECT id, goal, status, config_json, coordinator_count, total_tokens, started_at, ended_at, error_message, db_path
     FROM swarm_runs WHERE id = ?`
  ).get(req.params.id) as Record<string, unknown> | undefined;

  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  const dbPath = run['db_path'] as string;
  if (!existsSync(dbPath)) {
    res.status(404).json({ error: 'Run DB file not found', dbPath });
    return;
  }

  const runDb = openRunDb(dbPath, true);
  try {
    const agents = runDb.prepare('SELECT * FROM agents ORDER BY started_at ASC').all();
    const tokenSummary = runDb.prepare(
      `SELECT agent_id,
         SUM(input_tokens)  as total_input,
         SUM(output_tokens) as total_output,
         SUM(cache_read)    as total_cache_read,
         SUM(cache_write)   as total_cache_write
       FROM tokens GROUP BY agent_id`
    ).all();
    const eventCount = (runDb.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c;
    const bbCount    = (runDb.prepare('SELECT COUNT(*) as c FROM blackboard WHERE is_current = 1').get() as { c: number }).c;

    res.json({
      run: { ...run, config: JSON.parse(run['config_json'] as string) },
      agents,
      tokenSummary,
      eventCount,
      blackboardKeyCount: bbCount,
    });
  } finally {
    runDb.close();
  }
});

// ─── GET /runs/:id/replay — stream events as SSE ─────────────────────────────

swarmRunsRouter.get('/runs/:id/replay', (req, res) => {
  const run = mainDb.prepare('SELECT db_path FROM swarm_runs WHERE id = ?').get(req.params.id) as
    { db_path: string } | undefined;
  if (!run || !existsSync(run.db_path)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  const speed    = Math.max(0, Number(req.query.speed ?? 1));
  const fromTs   = Number(req.query.from_ts ?? 0);
  const agentId  = req.query.agent_id as string | undefined;
  const rawTypes = req.query.types as string | undefined;
  const typeFilter = rawTypes ? new Set(rawTypes.split(',').map(t => t.trim())) : null;

  const runDb = openRunDb(run.db_path, true);

  let events: { id: number; agent_id: string; type: string; data: string; ts: number }[];
  try {
    let query = 'SELECT id, agent_id, type, data, ts FROM events WHERE ts >= ?';
    const params: (string | number)[] = [fromTs];
    if (agentId) { query += ' AND agent_id = ?'; params.push(agentId); }
    query += ' ORDER BY ts ASC, seq ASC';
    events = runDb.prepare(query).all(...params) as typeof events;
  } finally {
    runDb.close();
  }

  const filtered = typeFilter
    ? events.filter(e => typeFilter.has(e.type))
    : events;

  const write = setupSse(res);
  const heartbeat = setInterval(() => res.write(':keepalive\n\n'), 30_000);

  req.on('close', () => { clearInterval(heartbeat); });

  if (speed === 0 || filtered.length === 0) {
    // Instant mode — send everything immediately
    for (const e of filtered) {
      write(e.type, { agentId: e.agent_id, ...JSON.parse(e.data), _ts: e.ts });
    }
    write('replay_end', { totalEvents: filtered.length });
    clearInterval(heartbeat);
    res.end();
    return;
  }

  // Timed mode
  let i = 0;
  function sendNext() {
    if (i >= filtered.length) {
      write('replay_end', { totalEvents: filtered.length });
      clearInterval(heartbeat);
      res.end();
      return;
    }
    const e = filtered[i];
    write(e.type, { agentId: e.agent_id, ...JSON.parse(e.data), _ts: e.ts });
    i++;
    if (i < filtered.length) {
      const delay = Math.min((filtered[i].ts - e.ts) / speed, 5000);
      setTimeout(sendNext, Math.max(0, delay));
    } else {
      write('replay_end', { totalEvents: filtered.length });
      clearInterval(heartbeat);
      res.end();
    }
  }
  sendNext();
});

// ─── GET /runs/:id/blackboard — snapshot ─────────────────────────────────────

swarmRunsRouter.get('/runs/:id/blackboard', (req, res) => {
  const run = mainDb.prepare('SELECT db_path FROM swarm_runs WHERE id = ?').get(req.params.id) as
    { db_path: string } | undefined;
  if (!run || !existsSync(run.db_path)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  const atTs = req.query.at_ts ? Number(req.query.at_ts) : null;
  const prefix = req.query.prefix as string | undefined;

  const runDb = openRunDb(run.db_path, true);
  try {
    let entries: { key: string; value: string; version: number; written_by: string; written_at: number }[];
    if (atTs !== null) {
      const prefixClause = prefix ? ' AND key LIKE ?' : '';
      const params: (number | string)[] = [atTs];
      if (prefix) params.push(`${prefix}%`);
      entries = runDb.prepare(
        `SELECT key, value, version, written_by, written_at
         FROM blackboard
         WHERE written_at <= ? ${prefixClause} AND key NOT LIKE 'inbox:%'
         GROUP BY key HAVING written_at = MAX(written_at)
         ORDER BY key`
      ).all(...params) as typeof entries;
    } else {
      const prefixClause = prefix ? ' AND key LIKE ?' : '';
      const params: string[] = prefix ? [`${prefix}%`] : [];
      entries = runDb.prepare(
        `SELECT key, value, version, written_by, written_at
         FROM blackboard WHERE is_current = 1 AND key NOT LIKE 'inbox:%' ${prefixClause}
         ORDER BY key`
      ).all(...params) as typeof entries;
    }
    res.json({ snapshot_at: atTs, entries });
  } finally {
    runDb.close();
  }
});

// ─── GET /runs/:id/db — download SQLite file ──────────────────────────────────

swarmRunsRouter.get('/runs/:id/db', (req, res) => {
  const run = mainDb.prepare('SELECT db_path FROM swarm_runs WHERE id = ?').get(req.params.id) as
    { db_path: string } | undefined;
  if (!run || !existsSync(run.db_path)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const filename = `swarm-run-${req.params.id}.db`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  createReadStream(run.db_path).pipe(res);
});

// ─── DELETE /runs/:id — remove run metadata + DB file ────────────────────────

swarmRunsRouter.delete('/runs/:id', (req, res) => {
  const run = mainDb.prepare('SELECT db_path FROM swarm_runs WHERE id = ?').get(req.params.id) as
    { db_path: string } | undefined;
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  mainDb.prepare('DELETE FROM swarm_runs WHERE id = ?').run(req.params.id);
  if (existsSync(run.db_path)) {
    try { unlinkSync(run.db_path); } catch { /* ignore — file may be locked */ }
  }
  res.status(204).end();
});

// ─── Config CRUD ──────────────────────────────────────────────────────────────

const SaveConfigSchema = z.object({
  name:   z.string().optional().default(''),
  config: SwarmConfigSchema,
});

swarmRunsRouter.post('/configs', (req, res) => {
  const data = SaveConfigSchema.parse(req.body);
  const result = mainDb.prepare(
    'INSERT INTO swarm_configs (name, goal, config_json) VALUES (?, ?, ?)'
  ).run(data.name, data.config.goal, JSON.stringify(data.config));
  res.status(201).json({ id: result.lastInsertRowid, name: data.name, goal: data.config.goal });
});

swarmRunsRouter.get('/configs', (_req, res) => {
  const configs = mainDb.prepare(
    'SELECT id, name, goal, created_at, updated_at FROM swarm_configs ORDER BY created_at DESC'
  ).all();
  res.json({ configs });
});

swarmRunsRouter.get('/configs/:id', (req, res) => {
  const config = mainDb.prepare(
    'SELECT id, name, goal, config_json, created_at, updated_at FROM swarm_configs WHERE id = ?'
  ).get(Number(req.params.id)) as Record<string, unknown> | undefined;
  if (!config) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ config: { ...config, config: JSON.parse(config['config_json'] as string) } });
});

swarmRunsRouter.delete('/configs/:id', (req, res) => {
  mainDb.prepare('DELETE FROM swarm_configs WHERE id = ?').run(Number(req.params.id));
  res.status(204).end();
});
