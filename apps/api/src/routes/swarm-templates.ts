import { Router } from 'express';
import { db } from '../db.js';
import { z } from 'zod';

export const swarmTemplatesRouter = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CoordinatorTemplateSchema = z.object({
  name:                   z.string().min(1).max(100),
  description:            z.string().default(''),
  role:                   z.string().min(1).max(100),
  model:                  z.enum(['opus', 'sonnet', 'haiku']).default('sonnet'),
  max_turns:              z.number().int().positive().default(25),
  system_prompt_template: z.string().min(20),
  tool_permissions:       z.record(z.boolean()).default({}),
});

const SubagentTemplateSchema = z.object({
  name:          z.string().min(1).max(100),
  description:   z.string().default(''),
  prompt:        z.string().min(10),
  model:         z.enum(['opus', 'sonnet', 'haiku']).default('sonnet'),
  tools:         z.array(z.string()).default([]),
  output_schema: z.string().nullable().optional(),
});

// ─── Helper: parse coordinator row ───────────────────────────────────────────

function parseCoordRow(row: Record<string, unknown>) {
  return {
    ...row,
    tool_permissions: (() => {
      try { return JSON.parse(row['tool_permissions'] as string); } catch { return {}; }
    })(),
  };
}

function parseSubRow(row: Record<string, unknown>) {
  return {
    ...row,
    tools: (() => {
      try { return JSON.parse(row['tools'] as string); } catch { return []; }
    })(),
  };
}

// ─── GET /coordinators ───────────────────────────────────────────────────────

swarmTemplatesRouter.get('/coordinators', (_req, res) => {
  const rows = db.prepare(
    `SELECT id, name, description, role, model, max_turns, system_prompt_template,
            tool_permissions, created_at, updated_at, usage_count
     FROM coordinator_templates ORDER BY usage_count DESC, name ASC`
  ).all() as Record<string, unknown>[];
  res.json({ templates: rows.map(parseCoordRow) });
});

// ─── GET /coordinators/:id ───────────────────────────────────────────────────

swarmTemplatesRouter.get('/coordinators/:id', (req, res) => {
  const row = db.prepare(
    `SELECT id, name, description, role, model, max_turns, system_prompt_template,
            tool_permissions, created_at, updated_at, usage_count
     FROM coordinator_templates WHERE id = ?`
  ).get(Number(req.params.id)) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Template not found' }); return; }
  // Increment usage_count on fetch (used when architect pulls a template)
  db.prepare(`UPDATE coordinator_templates SET usage_count = usage_count + 1 WHERE id = ?`).run(Number(req.params.id));
  res.json({ template: parseCoordRow(row) });
});

// ─── POST /coordinators ──────────────────────────────────────────────────────

swarmTemplatesRouter.post('/coordinators', (req, res) => {
  const data = CoordinatorTemplateSchema.parse(req.body);
  const result = db.prepare(
    `INSERT INTO coordinator_templates
       (name, description, role, model, max_turns, system_prompt_template, tool_permissions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.name, data.description, data.role, data.model, data.max_turns,
    data.system_prompt_template, JSON.stringify(data.tool_permissions),
  );
  const created = db.prepare(`SELECT * FROM coordinator_templates WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown>;
  res.status(201).json({ template: parseCoordRow(created) });
});

// ─── PUT /coordinators/:id ───────────────────────────────────────────────────

swarmTemplatesRouter.put('/coordinators/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT id FROM coordinator_templates WHERE id = ?`).get(id);
  if (!existing) { res.status(404).json({ error: 'Template not found' }); return; }
  const data = CoordinatorTemplateSchema.parse(req.body);
  db.prepare(
    `UPDATE coordinator_templates
     SET name = ?, description = ?, role = ?, model = ?, max_turns = ?,
         system_prompt_template = ?, tool_permissions = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    data.name, data.description, data.role, data.model, data.max_turns,
    data.system_prompt_template, JSON.stringify(data.tool_permissions), id,
  );
  const updated = db.prepare(`SELECT * FROM coordinator_templates WHERE id = ?`).get(id) as Record<string, unknown>;
  res.json({ template: parseCoordRow(updated) });
});

// ─── DELETE /coordinators/:id ────────────────────────────────────────────────

swarmTemplatesRouter.delete('/coordinators/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT id FROM coordinator_templates WHERE id = ?`).get(id);
  if (!existing) { res.status(404).json({ error: 'Template not found' }); return; }
  db.prepare(`DELETE FROM coordinator_templates WHERE id = ?`).run(id);
  res.status(204).end();
});

// ─── GET /subagents ──────────────────────────────────────────────────────────

swarmTemplatesRouter.get('/subagents', (_req, res) => {
  const rows = db.prepare(
    `SELECT id, name, description, prompt, model, tools, output_schema,
            created_at, updated_at, usage_count
     FROM subagent_templates ORDER BY usage_count DESC, name ASC`
  ).all() as Record<string, unknown>[];
  res.json({ templates: rows.map(parseSubRow) });
});

// ─── GET /subagents/:id ──────────────────────────────────────────────────────

swarmTemplatesRouter.get('/subagents/:id', (req, res) => {
  const row = db.prepare(
    `SELECT id, name, description, prompt, model, tools, output_schema,
            created_at, updated_at, usage_count
     FROM subagent_templates WHERE id = ?`
  ).get(Number(req.params.id)) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Template not found' }); return; }
  db.prepare(`UPDATE subagent_templates SET usage_count = usage_count + 1 WHERE id = ?`).run(Number(req.params.id));
  res.json({ template: parseSubRow(row) });
});

// ─── POST /subagents ─────────────────────────────────────────────────────────

swarmTemplatesRouter.post('/subagents', (req, res) => {
  const data = SubagentTemplateSchema.parse(req.body);
  const result = db.prepare(
    `INSERT INTO subagent_templates (name, description, prompt, model, tools, output_schema)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    data.name, data.description, data.prompt, data.model,
    JSON.stringify(data.tools), data.output_schema ?? null,
  );
  const created = db.prepare(`SELECT * FROM subagent_templates WHERE id = ?`).get(result.lastInsertRowid) as Record<string, unknown>;
  res.status(201).json({ template: parseSubRow(created) });
});

// ─── PUT /subagents/:id ──────────────────────────────────────────────────────

swarmTemplatesRouter.put('/subagents/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT id FROM subagent_templates WHERE id = ?`).get(id);
  if (!existing) { res.status(404).json({ error: 'Template not found' }); return; }
  const data = SubagentTemplateSchema.parse(req.body);
  db.prepare(
    `UPDATE subagent_templates
     SET name = ?, description = ?, prompt = ?, model = ?, tools = ?,
         output_schema = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    data.name, data.description, data.prompt, data.model,
    JSON.stringify(data.tools), data.output_schema ?? null, id,
  );
  const updated = db.prepare(`SELECT * FROM subagent_templates WHERE id = ?`).get(id) as Record<string, unknown>;
  res.json({ template: parseSubRow(updated) });
});

// ─── DELETE /subagents/:id ───────────────────────────────────────────────────

swarmTemplatesRouter.delete('/subagents/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT id FROM subagent_templates WHERE id = ?`).get(id);
  if (!existing) { res.status(404).json({ error: 'Template not found' }); return; }
  db.prepare(`DELETE FROM subagent_templates WHERE id = ?`).run(id);
  res.status(204).end();
});
