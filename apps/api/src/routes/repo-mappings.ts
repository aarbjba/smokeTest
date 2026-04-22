import { Router } from 'express';
import { db } from '../db.js';
import { CreateRepoMappingSchema, UpdateRepoMappingSchema } from '../schemas.js';
import {
  backfillWorkingDirectoriesFromMappings,
  jiraProjectKeyFor,
  type RepoMapping,
} from '../services/repo-mappings.js';

export const repoMappingsRouter = Router();

repoMappingsRouter.get('/', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM repo_mappings ORDER BY source, key`)
    .all() as RepoMapping[];
  res.json(rows);
});

repoMappingsRouter.post('/', (req, res) => {
  const data = CreateRepoMappingSchema.parse(req.body);
  const key = normalizeKey(data.source, data.key);
  try {
    const info = db
      .prepare(
        `INSERT INTO repo_mappings (source, key, local_path) VALUES (?, ?, ?)`,
      )
      .run(data.source, key, data.local_path);
    const row = db
      .prepare(`SELECT * FROM repo_mappings WHERE id = ?`)
      .get(info.lastInsertRowid) as RepoMapping;
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Mapping for (source, key) already exists' });
    }
    throw err;
  }
});

repoMappingsRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db
    .prepare(`SELECT * FROM repo_mappings WHERE id = ?`)
    .get(id) as RepoMapping | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const patch = UpdateRepoMappingSchema.parse(req.body);
  const nextSource = patch.source ?? existing.source;
  const nextKey = normalizeKey(nextSource, patch.key ?? existing.key);
  const nextPath = patch.local_path ?? existing.local_path;

  try {
    db.prepare(
      `UPDATE repo_mappings SET source = ?, key = ?, local_path = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(nextSource, nextKey, nextPath, id);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Mapping for (source, key) already exists' });
    }
    throw err;
  }

  const row = db
    .prepare(`SELECT * FROM repo_mappings WHERE id = ?`)
    .get(id) as RepoMapping;
  res.json(row);
});

repoMappingsRouter.delete('/:id', (req, res) => {
  const info = db
    .prepare(`DELETE FROM repo_mappings WHERE id = ?`)
    .run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// Backfill working_directory on existing todos where it is currently unset and
// a matching mapping exists. Only fills in NULL/empty — user overrides persist.
repoMappingsRouter.post('/backfill', (_req, res) => {
  const result = backfillWorkingDirectoriesFromMappings();
  res.json(result);
});

function normalizeKey(source: 'github' | 'jira', key: string): string {
  const trimmed = key.trim();
  if (source === 'github') return trimmed;
  // Jira project keys are conventionally uppercase (e.g. AAR) and may be entered
  // as full issue keys like `AAR-1163` — reduce to the project prefix.
  return jiraProjectKeyFor(trimmed) ?? trimmed.toUpperCase();
}
