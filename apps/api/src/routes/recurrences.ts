import { Router } from 'express';
import { db } from '../db.js';
import { CreateRecurrenceSchema, UpdateRecurrenceSchema } from '../schemas.js';
import { computeNextFireAt } from '../services/recurrence-generator.js';

export const recurrencesRouter = Router();

type RecurrenceRow = {
  id: number;
  title: string;
  description: string;
  tags: string;
  priority: number;
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly';
  time_of_day: string;
  next_fire_at: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
};

function hydrate(row: RecurrenceRow) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]') as string[],
    enabled: row.enabled === 1,
  };
}

recurrencesRouter.get('/', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM recurrences ORDER BY created_at DESC`)
    .all() as RecurrenceRow[];
  res.json(rows.map(hydrate));
});

recurrencesRouter.post('/', (req, res) => {
  const data = CreateRecurrenceSchema.parse(req.body);
  const next = computeNextFireAt(data.frequency, data.time_of_day, new Date());
  const info = db
    .prepare(
      `INSERT INTO recurrences (title, description, tags, priority, frequency, time_of_day, next_fire_at, enabled)
       VALUES (@title, @description, @tags, @priority, @frequency, @time_of_day, @next_fire_at, @enabled)`,
    )
    .run({
      title: data.title,
      description: data.description,
      tags: JSON.stringify(data.tags),
      priority: data.priority,
      frequency: data.frequency,
      time_of_day: data.time_of_day,
      next_fire_at: next.toISOString(),
      enabled: data.enabled ? 1 : 0,
    });
  const row = db
    .prepare(`SELECT * FROM recurrences WHERE id = ?`)
    .get(info.lastInsertRowid) as RecurrenceRow;
  res.status(201).json(hydrate(row));
});

recurrencesRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db
    .prepare(`SELECT * FROM recurrences WHERE id = ?`)
    .get(id) as RecurrenceRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const patch = UpdateRecurrenceSchema.parse(req.body);

  const mergedFrequency = patch.frequency ?? existing.frequency;
  const mergedTimeOfDay = patch.time_of_day ?? existing.time_of_day;

  // When frequency or time_of_day changes, recompute next_fire_at from now so
  // the new cadence takes effect immediately. Otherwise leave it alone so the
  // scheduler doesn't drift backwards.
  const scheduleChanged =
    (patch.frequency && patch.frequency !== existing.frequency) ||
    (patch.time_of_day && patch.time_of_day !== existing.time_of_day);
  const nextFireAt = scheduleChanged
    ? computeNextFireAt(mergedFrequency, mergedTimeOfDay, new Date()).toISOString()
    : existing.next_fire_at;

  db.prepare(
    `UPDATE recurrences SET
      title = @title,
      description = @description,
      tags = @tags,
      priority = @priority,
      frequency = @frequency,
      time_of_day = @time_of_day,
      next_fire_at = @next_fire_at,
      enabled = @enabled,
      updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id,
    title: patch.title ?? existing.title,
    description: patch.description ?? existing.description,
    tags: patch.tags !== undefined ? JSON.stringify(patch.tags) : existing.tags,
    priority: patch.priority ?? existing.priority,
    frequency: mergedFrequency,
    time_of_day: mergedTimeOfDay,
    next_fire_at: nextFireAt,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
  });

  const row = db
    .prepare(`SELECT * FROM recurrences WHERE id = ?`)
    .get(id) as RecurrenceRow;
  res.json(hydrate(row));
});

recurrencesRouter.delete('/:id', (req, res) => {
  const info = db
    .prepare(`DELETE FROM recurrences WHERE id = ?`)
    .run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});
