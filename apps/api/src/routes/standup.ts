import { Router, type Request, type Response } from 'express';
import { db } from '../db.js';

export const standupRouter = Router();

type TodoStandupRow = {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'test' | 'done' | 'pending';
  tags: string;
  updated_at: string;
};

export interface StandupItem {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'test' | 'done' | 'pending';
  tags: string[];
}

export interface StandupResponse {
  yesterday: StandupItem[];
  today: StandupItem[];
  blocked: StandupItem[];
}

function hydrate(row: TodoStandupRow): StandupItem {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
  } catch {
    // Corrupted tags JSON — treat as empty.
  }
  return { id: row.id, title: row.title, status: row.status, tags };
}

/**
 * Is this todo "blocked"?
 * - tag `blocked` (case-insensitive match) OR
 * - title contains the literal `[BLOCKED]` marker (case-insensitive substring).
 */
function isBlocked(item: StandupItem): boolean {
  if (item.tags.some((t) => t.toLowerCase() === 'blocked')) return true;
  if (item.title.toLowerCase().includes('[blocked]')) return true;
  return false;
}

/**
 * GET /api/standup
 *
 * Day window: the server's LOCAL day. SQLite stores timestamps as UTC
 * (via `datetime('now')`), so we compute the local day boundary with
 * `datetime('now','localtime','start of day')` and convert back to UTC
 * with the `'utc'` modifier for the WHERE comparison against the
 * UTC-stored `updated_at` column.
 *
 * Dedup priority: blocked > yesterday > today.
 * A todo that is both blocked and in_progress appears only in `blocked`.
 * A todo that was done yesterday but still matches today's in_progress/test
 * filter (shouldn't happen given status mutex, but defensive) appears only
 * in `yesterday`.
 */
standupRouter.get('/', (_req: Request, res: Response) => {
  // Yesterday (local day): todos marked done with updated_at in [yesterday 00:00 local, today 00:00 local).
  const yesterdayRows = db
    .prepare(
      `SELECT id, title, status, tags, updated_at
         FROM todos
        WHERE status = 'done'
          AND deleted_at IS NULL
          AND updated_at >= datetime('now','localtime','start of day','-1 day','utc')
          AND updated_at <  datetime('now','localtime','start of day','utc')
        ORDER BY updated_at DESC`,
    )
    .all() as TodoStandupRow[];

  // Today: everything currently in progress or in test.
  const todayRows = db
    .prepare(
      `SELECT id, title, status, tags, updated_at
         FROM todos
        WHERE status IN ('in_progress','test')
          AND deleted_at IS NULL
        ORDER BY priority ASC, updated_at DESC`,
    )
    .all() as TodoStandupRow[];

  // Blocked candidates: any non-done todo. We filter client-side because
  // tags are stored as JSON text — a LIKE on JSON would be fragile.
  const blockedCandidates = db
    .prepare(
      `SELECT id, title, status, tags, updated_at
         FROM todos
        WHERE status != 'done'
          AND deleted_at IS NULL
        ORDER BY priority ASC, updated_at DESC`,
    )
    .all() as TodoStandupRow[];

  const blocked = blockedCandidates.map(hydrate).filter(isBlocked);
  const blockedIds = new Set(blocked.map((t) => t.id));

  const yesterday = yesterdayRows
    .map(hydrate)
    .filter((t) => !blockedIds.has(t.id)); // done todos can't be blocked anyway, defensive

  const yesterdayIds = new Set(yesterday.map((t) => t.id));

  const today = todayRows
    .map(hydrate)
    .filter((t) => !blockedIds.has(t.id) && !yesterdayIds.has(t.id));

  const payload: StandupResponse = { yesterday, today, blocked };
  res.json(payload);
});
