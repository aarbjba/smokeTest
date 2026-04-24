import { Router } from 'express';
import { db } from '../db.js';
import { PomodoroStartSchema, PomodoroEndSchema } from '../schemas.js';
import { writebackJiraWorklog } from '../services/writeback.js';

export const pomodoroRouter = Router();

type SessionRow = {
  id: number;
  todo_id: number | null;
  mode: 'work' | 'break';
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  completed: number;
};

pomodoroRouter.post('/start', (req, res) => {
  const data = PomodoroStartSchema.parse(req.body);
  const info = db.prepare(
    `INSERT INTO pomodoro_sessions (todo_id, mode, started_at) VALUES (?, ?, datetime('now'))`
  ).run(data.todo_id ?? null, data.mode);
  const row = db.prepare(`SELECT * FROM pomodoro_sessions WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json(row);
});

pomodoroRouter.post('/:id/end', async (req, res) => {
  const id = Number(req.params.id);
  const data = PomodoroEndSchema.parse(req.body);
  const info = db.prepare(
    `UPDATE pomodoro_sessions SET ended_at = datetime('now'), duration_seconds = ?, completed = ? WHERE id = ?`
  ).run(data.duration_seconds, data.completed ? 1 : 0, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  const session = db.prepare(`SELECT * FROM pomodoro_sessions WHERE id = ?`).get(id) as SessionRow;

  let worklog: { ok: true } | { ok: false; error: string } | { skipped: true } = { skipped: true };
  if (session.mode === 'work' && session.completed === 1 && session.todo_id) {
    const todo = db.prepare(
      `SELECT id, source, source_ref, status FROM todos WHERE id = ?`
    ).get(session.todo_id) as { id: number; source: 'local' | 'github' | 'jira'; source_ref: string | null; status: 'todo' | 'in_progress' | 'test' | 'done' | 'pending' } | undefined;
    if (todo && todo.source === 'jira') {
      worklog = await writebackJiraWorklog(todo, session.duration_seconds);
    }
  }

  res.json({ ...session, worklog });
});

pomodoroRouter.get('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const rows = db.prepare(
    `SELECT * FROM pomodoro_sessions WHERE todo_id = ? ORDER BY started_at DESC LIMIT 50`
  ).all(todoId);
  res.json(rows);
});

pomodoroRouter.get('/stats', (_req, res) => {
  const today = db.prepare(
    `SELECT COUNT(*) as sessions, COALESCE(SUM(duration_seconds),0) as seconds
     FROM pomodoro_sessions WHERE mode = 'work' AND completed = 1 AND date(started_at) = date('now')`
  ).get() as { sessions: number; seconds: number };
  const total = db.prepare(
    `SELECT COUNT(*) as sessions, COALESCE(SUM(duration_seconds),0) as seconds
     FROM pomodoro_sessions WHERE mode = 'work' AND completed = 1`
  ).get() as { sessions: number; seconds: number };
  res.json({ today, total });
});
