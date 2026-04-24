import { Router } from 'express';
import { db } from '../db.js';
import { CreateTodoSchema, UpdateTodoSchema, BulkTodoSchema, McpServersSchema } from '../schemas.js';
import { writebackStatus } from '../services/writeback.js';

export const todosRouter = Router();

type TodoRow = {
  id: number;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: number;
  tags: string;
  due_date: string | null;
  source: 'local' | 'github' | 'jira';
  source_ref: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
  last_writeback_error: string | null;
  last_writeback_at: string | null;
  task_type?: string;
  subtask_total?: number;
  subtask_done?: number;
  subtask_suggested?: number;
};

function hydrate(row: TodoRow) {
  const raw = row as unknown as {
    mcp_servers?: string | null;
    saved_paths?: string | null;
  };
  let mcpServers: unknown[] = [];
  if (raw.mcp_servers) {
    try {
      const parsed = JSON.parse(raw.mcp_servers);
      if (Array.isArray(parsed)) mcpServers = parsed;
    } catch {
      // Corrupted JSON — treat as empty rather than 500'ing the list call.
    }
  }
  let savedPaths: string[] = [];
  if (raw.saved_paths) {
    try {
      const parsed = JSON.parse(raw.saved_paths);
      if (Array.isArray(parsed)) savedPaths = parsed.filter((p) => typeof p === 'string');
    } catch {
      /* ignore */
    }
  }
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]') as string[],
    mcp_servers: mcpServers,
    saved_paths: savedPaths,
  };
}

// Select list includes subtask aggregates via correlated subqueries so the board
// can show "☑ done/total" progress without a per-card fetch.
const TODO_LIST_SELECT = `
  SELECT todos.*,
    (SELECT COUNT(*) FROM subtasks WHERE subtasks.todo_id = todos.id AND subtasks.suggested = 0) AS subtask_total,
    (SELECT COUNT(*) FROM subtasks WHERE subtasks.todo_id = todos.id AND subtasks.done = 1 AND subtasks.suggested = 0) AS subtask_done,
    (SELECT COUNT(*) FROM subtasks WHERE subtasks.todo_id = todos.id AND subtasks.suggested = 1) AS subtask_suggested
  FROM todos
`;

// Active (non-trashed) list for the board.
todosRouter.get('/', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const ORDER = `ORDER BY status, position ASC, priority ASC, updated_at DESC`;
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (search) { where.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const sql = `${TODO_LIST_SELECT} WHERE ${where.join(' AND ')} ${ORDER}`;
  const rows = db.prepare(sql).all(...params) as TodoRow[];
  res.json(rows.map(hydrate));
});

// Papierkorb listing — only soft-deleted todos, newest trashed first.
todosRouter.get('/trash', (_req, res) => {
  const rows = db.prepare(
    `${TODO_LIST_SELECT} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
  ).all() as TodoRow[];
  res.json(rows.map(hydrate));
});

// Restore one from Papierkorb.
todosRouter.post('/:id/restore', (req, res) => {
  const info = db.prepare(
    `UPDATE todos SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL`,
  ).run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found or not trashed' });
  const row = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(Number(req.params.id)) as TodoRow;
  res.json(hydrate(row));
});

// Empty Papierkorb (purge all soft-deleted).
todosRouter.delete('/trash', (_req, res) => {
  const info = db.prepare(`DELETE FROM todos WHERE deleted_at IS NOT NULL`).run();
  res.json({ ok: true, purged: info.changes });
});

/**
 * Bulk reorder todos within a single column.
 * Body: { status: 'todo'|'in_progress'|'done', orderedIds: number[] }
 * Positions are assigned 0..N in the given order.
 */
todosRouter.post('/reorder', (req, res) => {
  const status = req.body?.status as 'todo' | 'in_progress' | 'test' | 'done' | undefined;
  const ids = Array.isArray(req.body?.orderedIds) ? (req.body.orderedIds as unknown[]).map(Number).filter(Number.isFinite) : [];
  if (!status || !['todo', 'in_progress', 'test', 'done'].includes(status) || ids.length === 0) {
    return res.status(400).json({ error: 'status and orderedIds required' });
  }
  const update = db.prepare(`UPDATE todos SET position = ? WHERE id = ? AND status = ?`);
  const tx = db.transaction((list: number[]) => {
    list.forEach((id, idx) => update.run(idx, id, status));
  });
  tx(ids);
  res.json({ ok: true, count: ids.length });
});

/**
 * Bulk operation over a list of todos.
 * Body: { ids, action: 'move'|'tag'|'delete', payload: { status?, tag? } }
 * - 'move': requires payload.status
 * - 'tag':  requires payload.tag (adds the tag to every todo's tag set)
 * - 'delete': no payload needed
 *
 * Runs in a single transaction so partial failures don't leave half the set in
 * a new state. For GitHub/Jira-sourced todos, a status move does NOT trigger
 * writeback (keeping the bulk op fast and idempotent). Users who need writeback
 * should move each non-local todo individually.
 */
todosRouter.post('/bulk', (req, res) => {
  const data = BulkTodoSchema.parse(req.body);

  if (data.action === 'move' && !data.payload.status) {
    return res.status(400).json({ error: 'move requires payload.status' });
  }
  if (data.action === 'tag' && !data.payload.tag) {
    return res.status(400).json({ error: 'tag requires payload.tag' });
  }

  const updateStatus = db.prepare(
    `UPDATE todos SET status = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`,
  );
  const getTags = db.prepare(`SELECT tags FROM todos WHERE id = ? AND deleted_at IS NULL`);
  const updateTags = db.prepare(
    `UPDATE todos SET tags = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  // Soft delete: move to Papierkorb. Use /bulk with action='purge' for permanent delete.
  const softDeleteOne = db.prepare(
    `UPDATE todos SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`,
  );
  const restoreOne = db.prepare(
    `UPDATE todos SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL`,
  );
  const purgeOne = db.prepare(`DELETE FROM todos WHERE id = ?`);

  let affected = 0;
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) {
      if (data.action === 'move') {
        const info = updateStatus.run(data.payload.status, id);
        if (info.changes > 0) affected++;
      } else if (data.action === 'tag') {
        const row = getTags.get(id) as { tags: string } | undefined;
        if (!row) continue;
        const parsed = JSON.parse(row.tags || '[]') as string[];
        if (parsed.includes(data.payload.tag!)) { affected++; continue; }
        parsed.push(data.payload.tag!);
        updateTags.run(JSON.stringify(parsed), id);
        affected++;
      } else if (data.action === 'delete') {
        const info = softDeleteOne.run(id);
        if (info.changes > 0) affected++;
      } else if (data.action === 'restore') {
        const info = restoreOne.run(id);
        if (info.changes > 0) affected++;
      } else if (data.action === 'purge') {
        const info = purgeOne.run(id);
        if (info.changes > 0) affected++;
      }
    }
  });
  tx(data.ids);

  res.json({ ok: true, affected, total: data.ids.length });
});

// Per-todo MCP server list. An empty array means "no MCP servers"; NULL storage
// (treated by the spawner as fallback-to-defaults) can be set by PUT with an
// empty body — see the spawn precedence in claude-sessions.ts.
todosRouter.get('/:id/mcp', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT mcp_servers FROM todos WHERE id = ?`).get(id) as { mcp_servers: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  let servers: unknown[] = [];
  if (row.mcp_servers) {
    try { const p = JSON.parse(row.mcp_servers); if (Array.isArray(p)) servers = p; } catch { /* ignore */ }
  }
  res.json({ mcp_servers: servers });
});

todosRouter.put('/:id/mcp', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare(`SELECT 1 FROM todos WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const servers = McpServersSchema.parse(req.body?.mcp_servers ?? []);
  db.prepare(
    `UPDATE todos SET mcp_servers = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(servers.length === 0 ? null : JSON.stringify(servers), id);
  res.json({ mcp_servers: servers });
});

todosRouter.get('/:id', (req, res) => {
  // Detail view also serves Papierkorb entries so the user can inspect before restoring;
  // clients filter trashed items out of the board list via GET /todos.
  const row = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(Number(req.params.id)) as TodoRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(hydrate(row));
});

todosRouter.post('/', (req, res) => {
  const data = CreateTodoSchema.parse(req.body);
  const insertTodo = db.prepare(
    `INSERT INTO todos (title, description, status, priority, tags, due_date, source, task_type)
     VALUES (@title, @description, @status, @priority, @tags, @due_date, 'local', @task_type)`
  );
  const insertSubtask = db.prepare(
    `INSERT INTO subtasks (todo_id, title, done, position, suggested) VALUES (?, ?, 0, ?, 0)`
  );
  const tx = db.transaction(() => {
    const info = insertTodo.run({
      title: data.title,
      description: data.description ?? '',
      status: data.status ?? 'todo',
      priority: data.priority ?? 2,
      tags: JSON.stringify(data.tags ?? []),
      due_date: data.due_date ?? null,
      task_type: data.task_type ?? 'other',
    });
    const todoId = Number(info.lastInsertRowid);
    let pos = 0;
    for (const rawTitle of data.subtasks ?? []) {
      const trimmed = rawTitle.trim();
      if (!trimmed) continue;
      insertSubtask.run(todoId, trimmed, pos);
      pos += 1;
    }
    return todoId;
  });
  const id = tx();
  const row = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as TodoRow;
  res.status(201).json(hydrate(row));
});

todosRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as TodoRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const patch = UpdateTodoSchema.parse(req.body);
  const existingRaw = existing as unknown as {
    working_directory: string | null;
    task_type: string | null;
    preprompt: string | null;
    saved_paths: string | null;
  };
  const mergedSavedPaths = patch.saved_paths !== undefined
    ? (patch.saved_paths === null ? null : JSON.stringify(patch.saved_paths))
    : existingRaw.saved_paths;
  const merged = {
    title: patch.title ?? existing.title,
    description: patch.description ?? existing.description,
    status: (patch.status ?? existing.status) as 'todo' | 'in_progress' | 'test' | 'done',
    priority: patch.priority ?? existing.priority,
    tags: patch.tags !== undefined ? JSON.stringify(patch.tags) : existing.tags,
    due_date: patch.due_date !== undefined ? patch.due_date : existing.due_date,
    working_directory: patch.working_directory !== undefined ? patch.working_directory : existingRaw.working_directory,
    task_type: patch.task_type ?? existingRaw.task_type ?? 'other',
    preprompt: patch.preprompt !== undefined ? patch.preprompt : existingRaw.preprompt,
    saved_paths: mergedSavedPaths,
  };
  db.prepare(
    `UPDATE todos SET title=@title, description=@description, status=@status, priority=@priority,
     tags=@tags, due_date=@due_date, working_directory=@working_directory, task_type=@task_type,
     preprompt=@preprompt, saved_paths=@saved_paths,
     updated_at=datetime('now') WHERE id=@id`
  ).run({ ...merged, id });

  // Writeback to GitHub/Jira if status changed on a non-local todo.
  // Non-blocking semantics: we always return the updated local todo; any writeback error
  // is stored on the row (last_writeback_error) and surfaced by the client.
  if (existing.source !== 'local' && patch.status && patch.status !== existing.status) {
    await writebackStatus({
      id,
      source: existing.source,
      source_ref: existing.source_ref,
      status: merged.status,
      oldStatus: existing.status,
    });
  }

  const row = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as TodoRow;
  res.json(hydrate(row));
});

// Soft delete by default — moves todo to Papierkorb. Pass `?permanent=1` to hard delete.
todosRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  if (permanent) {
    const info = db.prepare(`DELETE FROM todos WHERE id = ?`).run(id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  }
  const info = db.prepare(
    `UPDATE todos SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`,
  ).run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found or already trashed' });
  res.status(204).end();
});
