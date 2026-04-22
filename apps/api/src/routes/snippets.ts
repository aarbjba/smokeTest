import { Router } from 'express';
import { db, touchUpdatedAt } from '../db.js';
import { SnippetSchema } from '../schemas.js';

export const snippetsRouter = Router();

type SnippetRow = {
  id: number;
  todo_id: number;
  title: string;
  language: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
};

snippetsRouter.get('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const rows = db.prepare(
    `SELECT * FROM snippets WHERE todo_id = ? ORDER BY position ASC, id ASC`
  ).all(todoId) as SnippetRow[];
  res.json(rows);
});

snippetsRouter.post('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const data = SnippetSchema.parse(req.body);
  const info = db.prepare(
    `INSERT INTO snippets (todo_id, title, language, content, position)
     VALUES (?, ?, ?, ?, ?)`
  ).run(todoId, data.title ?? '', data.language ?? 'markdown', data.content ?? '', data.position ?? 0);
  const row = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(info.lastInsertRowid) as SnippetRow;
  res.status(201).json(row);
});

snippetsRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(id) as SnippetRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const patch = SnippetSchema.partial().parse(req.body);
  db.prepare(
    `UPDATE snippets SET title=?, language=?, content=?, position=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    patch.title ?? existing.title,
    patch.language ?? existing.language,
    patch.content ?? existing.content,
    patch.position ?? existing.position,
    id
  );
  const row = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(id) as SnippetRow;
  res.json(row);
});

snippetsRouter.delete('/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM snippets WHERE id = ?`).run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});
