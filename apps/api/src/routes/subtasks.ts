import { Router } from 'express';
import { db } from '../db.js';
import { CreateSubtaskSchema, UpdateSubtaskSchema, ReorderSubtasksSchema } from '../schemas.js';

export const subtasksRouter = Router();

type SubtaskRow = {
  id: number;
  todo_id: number;
  title: string;
  done: 0 | 1;
  position: number;
  created_at: string;
  suggested: 0 | 1;
};

subtasksRouter.get('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const rows = db.prepare(
    `SELECT * FROM subtasks WHERE todo_id = ? ORDER BY position ASC, id ASC`
  ).all(todoId) as SubtaskRow[];
  res.json(rows);
});

subtasksRouter.post('/', (req, res) => {
  const data = CreateSubtaskSchema.parse(req.body);
  // Append at end: next position = (max(position) + 1) or 0 if none exist.
  const maxRow = db.prepare(
    `SELECT COALESCE(MAX(position), -1) AS maxpos FROM subtasks WHERE todo_id = ?`
  ).get(data.todo_id) as { maxpos: number };
  const nextPos = (maxRow?.maxpos ?? -1) + 1;
  const info = db.prepare(
    `INSERT INTO subtasks (todo_id, title, done, position, suggested) VALUES (?, ?, 0, ?, ?)`
  ).run(data.todo_id, data.title, nextPos, data.suggested ? 1 : 0);
  const row = db.prepare(`SELECT * FROM subtasks WHERE id = ?`).get(info.lastInsertRowid) as SubtaskRow;
  res.status(201).json(row);
});

subtasksRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM subtasks WHERE id = ?`).get(id) as SubtaskRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const patch = UpdateSubtaskSchema.parse(req.body);
  const nextDone =
    patch.done === undefined
      ? existing.done
      : (typeof patch.done === 'boolean' ? (patch.done ? 1 : 0) : patch.done) as 0 | 1;
  const nextSuggested =
    patch.suggested === undefined ? existing.suggested : (patch.suggested ? 1 : 0);
  db.prepare(
    `UPDATE subtasks SET title = ?, done = ?, position = ?, suggested = ? WHERE id = ?`
  ).run(
    patch.title ?? existing.title,
    nextDone,
    patch.position ?? existing.position,
    nextSuggested,
    id
  );
  const row = db.prepare(`SELECT * FROM subtasks WHERE id = ?`).get(id) as SubtaskRow;
  res.json(row);
});

subtasksRouter.delete('/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM subtasks WHERE id = ?`).run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

/**
 * Bulk reorder subtasks belonging to a single todo.
 * Body: { todo_id, ordered_ids: number[] }
 * Positions are assigned 0..N in the given order.
 */
subtasksRouter.post('/reorder', (req, res) => {
  const data = ReorderSubtasksSchema.parse(req.body);
  const update = db.prepare(`UPDATE subtasks SET position = ? WHERE id = ? AND todo_id = ?`);
  const tx = db.transaction((ids: number[]) => {
    ids.forEach((id, idx) => update.run(idx, id, data.todo_id));
  });
  tx(data.ordered_ids);
  res.json({ ok: true, count: data.ordered_ids.length });
});
