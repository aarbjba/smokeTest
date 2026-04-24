import { Router } from 'express';
import { db } from '../db.js';
import { CreateSubtaskSchema, UpdateSubtaskSchema, ReorderSubtasksSchema } from '../schemas.js';

export const subtasksRouter = Router();

type SubtaskRow = {
  id: number;
  todo_id: number;
  title: string;
  description: string;
  done: 0 | 1;
  position: number;
  created_at: string;
  suggested: 0 | 1;
  linked_todo_id: number | null;
};

type SubtaskJoinedRow = SubtaskRow & {
  linked_title: string | null;
  linked_status: 'todo' | 'in_progress' | 'test' | 'done' | 'pending' | null;
  linked_deleted_at: string | null;
};

type HydratedSubtask = SubtaskRow & {
  linked_todo: { id: number; title: string; status: string } | null;
};

const SELECT_WITH_LINK = `
  SELECT s.*,
    lt.title       AS linked_title,
    lt.status      AS linked_status,
    lt.deleted_at  AS linked_deleted_at
  FROM subtasks s
  LEFT JOIN todos lt ON lt.id = s.linked_todo_id
`;

function hydrate(row: SubtaskJoinedRow): HydratedSubtask {
  const { linked_title, linked_status, linked_deleted_at, ...rest } = row;
  // A linked todo that landed in the Papierkorb is treated as cleared so the
  // chip doesn't show stale info — the FK still points at the row, restore
  // brings the link back.
  const linkActive = row.linked_todo_id !== null && linked_title !== null && linked_deleted_at === null;
  return {
    ...rest,
    linked_todo: linkActive
      ? { id: row.linked_todo_id as number, title: linked_title as string, status: linked_status as string }
      : null,
  };
}

function getById(id: number): HydratedSubtask | undefined {
  const row = db.prepare(`${SELECT_WITH_LINK} WHERE s.id = ?`).get(id) as SubtaskJoinedRow | undefined;
  return row ? hydrate(row) : undefined;
}

subtasksRouter.get('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const rows = db.prepare(
    `${SELECT_WITH_LINK} WHERE s.todo_id = ? ORDER BY s.position ASC, s.id ASC`,
  ).all(todoId) as SubtaskJoinedRow[];
  res.json(rows.map(hydrate));
});

subtasksRouter.post('/', (req, res) => {
  const data = CreateSubtaskSchema.parse(req.body);
  // Reject self-link and dangling FK up front so the error surfaces on the
  // creating call rather than as an opaque SQLITE_CONSTRAINT.
  if (data.linked_todo_id != null) {
    if (data.linked_todo_id === data.todo_id) {
      return res.status(400).json({ error: 'A subtask cannot link to its own parent todo' });
    }
    const exists = db.prepare(`SELECT 1 FROM todos WHERE id = ? AND deleted_at IS NULL`).get(data.linked_todo_id);
    if (!exists) return res.status(400).json({ error: 'linked_todo_id does not reference an active todo' });
  }
  // Append at end: next position = (max(position) + 1) or 0 if none exist.
  const maxRow = db.prepare(
    `SELECT COALESCE(MAX(position), -1) AS maxpos FROM subtasks WHERE todo_id = ?`,
  ).get(data.todo_id) as { maxpos: number };
  const nextPos = (maxRow?.maxpos ?? -1) + 1;
  const info = db.prepare(
    `INSERT INTO subtasks (todo_id, title, description, done, position, suggested, linked_todo_id)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    data.todo_id,
    data.title,
    data.description ?? '',
    nextPos,
    data.suggested ? 1 : 0,
    data.linked_todo_id ?? null,
  );
  res.status(201).json(getById(Number(info.lastInsertRowid)));
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
  let nextLinkedTodoId = existing.linked_todo_id;
  if (patch.linked_todo_id !== undefined) {
    if (patch.linked_todo_id === null) {
      nextLinkedTodoId = null;
    } else {
      if (patch.linked_todo_id === existing.todo_id) {
        return res.status(400).json({ error: 'A subtask cannot link to its own parent todo' });
      }
      const exists = db.prepare(`SELECT 1 FROM todos WHERE id = ? AND deleted_at IS NULL`).get(patch.linked_todo_id);
      if (!exists) return res.status(400).json({ error: 'linked_todo_id does not reference an active todo' });
      nextLinkedTodoId = patch.linked_todo_id;
    }
  }
  db.prepare(
    `UPDATE subtasks SET title = ?, description = ?, done = ?, position = ?, suggested = ?, linked_todo_id = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.description ?? existing.description,
    nextDone,
    patch.position ?? existing.position,
    nextSuggested,
    nextLinkedTodoId,
    id,
  );
  res.json(getById(id));
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
