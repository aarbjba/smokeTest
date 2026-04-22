import { Router } from 'express';
import { db } from '../db.js';
import { CreateAnalysisSchema } from '../schemas.js';

export const analysesRouter = Router();

type AnalysisRow = {
  id: number;
  todo_id: number;
  content: string;
  created_at: string;
};

analysesRouter.get('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const rows = db
    .prepare(`SELECT * FROM analyses WHERE todo_id = ? ORDER BY created_at DESC, id DESC`)
    .all(todoId) as AnalysisRow[];
  res.json(rows);
});

analysesRouter.post('/', (req, res) => {
  const data = CreateAnalysisSchema.parse(req.body);
  const info = db
    .prepare(`INSERT INTO analyses (todo_id, content) VALUES (?, ?)`)
    .run(data.todo_id, data.content);
  const row = db.prepare(`SELECT * FROM analyses WHERE id = ?`).get(info.lastInsertRowid) as AnalysisRow;
  res.status(201).json(row);
});

analysesRouter.delete('/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM analyses WHERE id = ?`).run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});
