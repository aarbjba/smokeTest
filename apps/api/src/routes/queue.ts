import { Router } from 'express';
import { db } from '../db.js';
import { EnqueueSchema, UpdateQueueItemSchema, ReorderQueueSchema } from '../schemas.js';

export const queueRouter = Router();

/**
 * Automation queue (Warteschlange).
 *
 * A todo is "queued" when `todos.queue_position` is non-NULL. The queue runner
 * (services/queue-runner.ts) polls for the lowest position with status='todo'
 * and status != deleted, clears queue_position, and spawns a Claude session via
 * the same code path the Details-page Start button uses.
 *
 * Shape returned by list: QueueItem = {
 *   todo_id, queue_position, queue_prompt, queue_attachment_ids,
 *   title, status, working_directory
 * }
 * — a denormalized join so the UI strip can render without a second fetch.
 */

interface QueueRow {
  id: number;
  title: string;
  status: string;
  working_directory: string | null;
  queue_position: number;
  queue_prompt: string | null;
  queue_attachment_ids: string | null;
}

function hydrate(row: QueueRow) {
  let attachmentIds: number[] = [];
  if (row.queue_attachment_ids) {
    try {
      const parsed = JSON.parse(row.queue_attachment_ids);
      if (Array.isArray(parsed)) attachmentIds = parsed.filter((n) => typeof n === 'number');
    } catch {
      /* treat malformed JSON as empty */
    }
  }
  return {
    todo_id: row.id,
    title: row.title,
    status: row.status,
    working_directory: row.working_directory,
    queue_position: row.queue_position,
    queue_prompt: row.queue_prompt ?? '',
    queue_attachment_ids: attachmentIds,
  };
}

/**
 * Reorder the queue. Body: { ordered_ids: number[] }.
 * Positions are re-assigned 0..N-1 in the given order. IDs not in the list
 * are left untouched (they stay queued at their existing position, so only
 * pass the full ordering to avoid gaps).
 *
 * IMPORTANT: This route must be registered BEFORE POST /:todoId — Express
 * matches routes in registration order, and "reorder" would otherwise be
 * parsed as a todoId and fail with a 400.
 */
queueRouter.post('/reorder', (req, res) => {
  const data = ReorderQueueSchema.parse(req.body ?? {});
  const update = db.prepare(
    `UPDATE todos SET queue_position = ?
     WHERE id = ? AND queue_position IS NOT NULL`,
  );
  const tx = db.transaction((ids: number[]) => {
    ids.forEach((id, idx) => update.run(idx, id));
  });
  tx(data.ordered_ids);
  res.json({ ok: true, count: data.ordered_ids.length });
});

/** List all queued todos in run order. */
queueRouter.get('/', (_req, res) => {
  const rows = db.prepare(
    `SELECT id, title, status, working_directory, queue_position, queue_prompt, queue_attachment_ids
     FROM todos
     WHERE queue_position IS NOT NULL AND deleted_at IS NULL
     ORDER BY queue_position ASC, id ASC`,
  ).all() as QueueRow[];
  res.json(rows.map(hydrate));
});

/** Enqueue a todo. Appends at the end of the queue. No-op if already queued. */
queueRouter.post('/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  if (!Number.isFinite(todoId)) return res.status(400).json({ error: 'Invalid todoId' });

  const existing = db.prepare(
    `SELECT id, status, deleted_at, queue_position FROM todos WHERE id = ?`,
  ).get(todoId) as { id: number; status: string; deleted_at: string | null; queue_position: number | null } | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.deleted_at) return res.status(400).json({ error: 'Todo is in Papierkorb' });
  if (existing.status !== 'todo') {
    return res.status(400).json({ error: 'Only todos in status "todo" can be queued' });
  }

  const data = EnqueueSchema.parse(req.body ?? {});

  // Append at end: max(queue_position) + 1, or 0 if the queue is empty.
  const maxRow = db.prepare(
    `SELECT MAX(queue_position) AS m FROM todos WHERE queue_position IS NOT NULL`,
  ).get() as { m: number | null };
  const nextPos = existing.queue_position !== null
    ? existing.queue_position
    : (maxRow.m !== null ? maxRow.m + 1 : 0);

  db.prepare(
    `UPDATE todos
       SET queue_position = ?,
           queue_prompt = ?,
           queue_attachment_ids = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(nextPos, data.prompt ?? '', JSON.stringify(data.attachmentIds ?? []), todoId);

  const row = db.prepare(
    `SELECT id, title, status, working_directory, queue_position, queue_prompt, queue_attachment_ids
     FROM todos WHERE id = ?`,
  ).get(todoId) as QueueRow;
  res.status(201).json(hydrate(row));
});

/** Update the stored prompt/attachments while a todo is queued (not yet running). */
queueRouter.patch('/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  if (!Number.isFinite(todoId)) return res.status(400).json({ error: 'Invalid todoId' });

  const existing = db.prepare(
    `SELECT id, queue_position FROM todos WHERE id = ? AND deleted_at IS NULL`,
  ).get(todoId) as { id: number; queue_position: number | null } | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.queue_position === null) {
    return res.status(400).json({ error: 'Todo is not queued' });
  }

  const patch = UpdateQueueItemSchema.parse(req.body ?? {});

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.prompt !== undefined) { sets.push('queue_prompt = ?'); params.push(patch.prompt); }
  if (patch.attachmentIds !== undefined) { sets.push('queue_attachment_ids = ?'); params.push(JSON.stringify(patch.attachmentIds)); }
  if (sets.length === 0) {
    const row = db.prepare(
      `SELECT id, title, status, working_directory, queue_position, queue_prompt, queue_attachment_ids
       FROM todos WHERE id = ?`,
    ).get(todoId) as QueueRow;
    return res.json(hydrate(row));
  }
  sets.push(`updated_at = datetime('now')`);
  params.push(todoId);
  db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare(
    `SELECT id, title, status, working_directory, queue_position, queue_prompt, queue_attachment_ids
     FROM todos WHERE id = ?`,
  ).get(todoId) as QueueRow;
  res.json(hydrate(row));
});

/** Dequeue (remove from queue without starting work). */
queueRouter.delete('/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  if (!Number.isFinite(todoId)) return res.status(400).json({ error: 'Invalid todoId' });
  const info = db.prepare(
    `UPDATE todos
       SET queue_position = NULL,
           queue_prompt = NULL,
           queue_attachment_ids = NULL,
           updated_at = datetime('now')
     WHERE id = ? AND queue_position IS NOT NULL`,
  ).run(todoId);
  if (info.changes === 0) return res.status(404).json({ error: 'Not queued' });
  res.status(204).end();
});

