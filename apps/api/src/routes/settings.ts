import { Router } from 'express';
import { db } from '../db.js';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const result: Record<string, unknown> = {};
  for (const r of rows) {
    try { result[r.key] = JSON.parse(r.value); } catch { result[r.key] = r.value; }
  }
  res.json(result);
});

settingsRouter.put('/:key', (req, res) => {
  const key = req.params.key;
  const value = JSON.stringify(req.body ?? null);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
  res.json({ key, value: JSON.parse(value) });
});
