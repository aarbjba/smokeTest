#!/usr/bin/env node
/**
 * Werkbank MCP server.
 *
 * Exposes the werkbank todo app as an MCP server so Claude Desktop / Claude Code
 * (and any other MCP client) can query and mutate todos via natural-language
 * tool calls.
 *
 * Transport: stdio. Each client spawns its own MCP process, so "multiple sessions
 * at once" is handled by process isolation — all instances share the same werkbank
 * HTTP API (which already serializes SQLite writes via better-sqlite3).
 *
 * Configuration (env):
 *   WERKBANK_API_URL   — base URL of the werkbank API (default http://localhost:3001)
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.WERKBANK_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let msg = resp.statusText;
    try { msg = JSON.parse(body).error ?? msg; } catch { /* ignore */ }
    throw new Error(`werkbank API ${resp.status}: ${msg}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

function asText(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

const server = new McpServer({ name: 'werkbank-mcp', version: '0.1.0' });

// ─── list_todos ────────────────────────────────────────────────────────────
server.tool(
  'list_todos',
  'List active (non-trashed) todos from the werkbank. Optionally filter by status or search query.',
  {
    status: z.enum(['todo', 'in_progress', 'test', 'done']).optional()
      .describe('Only return todos in this status. Omit for all statuses.'),
    search: z.string().optional()
      .describe('Case-insensitive substring match against title and description.'),
  },
  async ({ status, search }) => {
    const sp = new URLSearchParams();
    if (status) sp.set('status', status);
    if (search) sp.set('q', search);
    const qs = sp.toString();
    const todos = await call<unknown[]>(`/api/todos${qs ? `?${qs}` : ''}`);
    return asText(todos);
  },
);

// ─── get_todo ──────────────────────────────────────────────────────────────
server.tool(
  'get_todo',
  'Get a single todo by id (includes trashed todos). Also fetches its subtasks and attachments.',
  {
    id: z.number().int().positive().describe('Numeric todo id.'),
  },
  async ({ id }) => {
    const [todo, subtasks, attachments] = await Promise.all([
      call<unknown>(`/api/todos/${id}`),
      call<unknown[]>(`/api/subtasks/by-todo/${id}`),
      call<unknown[]>(`/api/attachments/by-todo/${id}`),
    ]);
    return asText({ todo, subtasks, attachments });
  },
);

// ─── create_todo ───────────────────────────────────────────────────────────
server.tool(
  'create_todo',
  'Create a new local todo. Optionally attach subtasks in one call.',
  {
    title: z.string().min(1).max(500),
    description: z.string().max(10_000).optional(),
    status: z.enum(['todo', 'in_progress', 'test', 'done']).optional(),
    priority: z.number().int().min(1).max(4).optional()
      .describe('1=urgent, 2=normal (default), 3=low, 4=someday.'),
    tags: z.array(z.string().max(50)).optional(),
    due_date: z.string().optional()
      .describe('ISO 8601 datetime string, or YYYY-MM-DD (converted to start of day).'),
    subtasks: z.array(z.string().min(1).max(500)).optional()
      .describe('Titles of subtasks to create under the new todo.'),
  },
  async (args) => {
    const due = args.due_date
      ? (args.due_date.includes('T')
          ? args.due_date
          : new Date(`${args.due_date}T00:00:00`).toISOString())
      : null;

    const body = {
      title: args.title,
      description: args.description ?? '',
      status: args.status ?? 'todo',
      priority: args.priority ?? 2,
      tags: args.tags ?? [],
      due_date: due,
    };
    const created = await call<{ id: number }>('/api/todos', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const subtasksCreated: unknown[] = [];
    if (args.subtasks && args.subtasks.length > 0) {
      for (const title of args.subtasks) {
        const sub = await call<unknown>('/api/subtasks', {
          method: 'POST',
          body: JSON.stringify({ todo_id: created.id, title }),
        });
        subtasksCreated.push(sub);
      }
    }
    return asText({ todo: created, subtasks: subtasksCreated });
  },
);

// ─── update_todo ───────────────────────────────────────────────────────────
server.tool(
  'update_todo',
  'Update fields on an existing todo. Only fields you pass are changed.',
  {
    id: z.number().int().positive(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10_000).optional(),
    status: z.enum(['todo', 'in_progress', 'test', 'done']).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    tags: z.array(z.string().max(50)).optional(),
    due_date: z.string().nullable().optional()
      .describe('ISO datetime, YYYY-MM-DD, or null to clear.'),
  },
  async ({ id, due_date, ...rest }) => {
    const patch: Record<string, unknown> = { ...rest };
    if (due_date !== undefined) {
      patch.due_date = due_date === null
        ? null
        : due_date.includes('T')
          ? due_date
          : new Date(`${due_date}T00:00:00`).toISOString();
    }
    const updated = await call<unknown>(`/api/todos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return asText(updated);
  },
);

// ─── delete_todo ───────────────────────────────────────────────────────────
server.tool(
  'delete_todo',
  'Delete a todo. By default this is a SOFT delete (moves to Papierkorb, recoverable). Pass permanent=true to hard-delete.',
  {
    id: z.number().int().positive(),
    permanent: z.boolean().optional()
      .describe('If true, delete permanently and bypass the Papierkorb.'),
  },
  async ({ id, permanent }) => {
    await call<void>(`/api/todos/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' });
    return asText({ ok: true, id, permanent: !!permanent });
  },
);

// ─── add_subtask ───────────────────────────────────────────────────────────
server.tool(
  'add_subtask',
  'Add a subtask to an existing todo.',
  {
    todo_id: z.number().int().positive(),
    title: z.string().min(1).max(500),
  },
  async ({ todo_id, title }) => {
    const created = await call<unknown>('/api/subtasks', {
      method: 'POST',
      body: JSON.stringify({ todo_id, title }),
    });
    return asText(created);
  },
);

// ─── suggest_subtask (analyse mode) ────────────────────────────────────────
server.tool(
  'suggest_subtask',
  'Propose a subtask for the user to accept or reject. Use this during analyse mode instead of add_subtask — the subtask is created with suggested=1 and renders with Accept/Reject buttons in the UI.',
  {
    todo_id: z.number().int().positive(),
    title: z.string().min(1).max(500),
  },
  async ({ todo_id, title }) => {
    const created = await call<unknown>('/api/subtasks', {
      method: 'POST',
      body: JSON.stringify({ todo_id, title, suggested: true }),
    });
    return asText(created);
  },
);

// ─── add_analysis (analyse mode) ───────────────────────────────────────────
server.tool(
  'add_analysis',
  'Persist an analysis of the current todo (Markdown body). Appears as its own section in the todo detail view. Call exactly once per analyse run.',
  {
    todo_id: z.number().int().positive(),
    content: z.string().min(1).max(100_000)
      .describe('Markdown body of the analysis — structure it with sections like Ziel / Vorgehen / Risiken / Komplexität.'),
  },
  async ({ todo_id, content }) => {
    const created = await call<unknown>('/api/analyses', {
      method: 'POST',
      body: JSON.stringify({ todo_id, content }),
    });
    return asText(created);
  },
);

// ─── finalize_todo (summary + status change when work is done) ─────────────
server.tool(
  'finalize_todo',
  'Call this when you have finished the task. Appends a summary to the todo description with a timestamp, and optionally moves the todo to a new status (default: "test" for review). Use this instead of update_todo at the end so the user gets a clear summary section.',
  {
    id: z.number().int().positive(),
    summary: z.string().min(1).max(20_000).describe('Short summary of what you did, what changed, what remains open.'),
    next_status: z.enum(['todo', 'in_progress', 'test', 'done']).optional()
      .describe('Target status after summarizing. Defaults to "test" (user reviews before closing).'),
  },
  async ({ id, summary, next_status }) => {
    // Fetch existing description so we can append rather than overwrite.
    const existing = await call<{ description?: string; status?: string }>(`/api/todos/${id}`);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const appended = [
      (existing.description ?? '').trimEnd(),
      '',
      `---`,
      `## Agent-Zusammenfassung (${now})`,
      summary.trim(),
    ].filter(Boolean).join('\n');

    const patch: Record<string, unknown> = {
      description: appended,
      status: next_status ?? 'test',
    };
    const updated = await call<unknown>(`/api/todos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return asText({ ok: true, todo: updated });
  },
);

// ─── update_subtask (cross off / rename) ───────────────────────────────────
server.tool(
  'update_subtask',
  'Update a subtask. Use `done: true` to cross it off, `done: false` to uncheck. Can also rename via `title`.',
  {
    id: z.number().int().positive().describe('Subtask id (not the parent todo id).'),
    title: z.string().min(1).max(500).optional(),
    done: z.boolean().optional().describe('true = crossed off, false = open.'),
  },
  async ({ id, title, done }) => {
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (done !== undefined) patch.done = done;
    const updated = await call<unknown>(`/api/subtasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return asText(updated);
  },
);

// ─── delete_subtask ────────────────────────────────────────────────────────
server.tool(
  'delete_subtask',
  'Permanently delete a subtask. The parent todo is not affected.',
  {
    id: z.number().int().positive(),
  },
  async ({ id }) => {
    await call<void>(`/api/subtasks/${id}`, { method: 'DELETE' });
    return asText({ ok: true, id });
  },
);

// ─── list_trash ────────────────────────────────────────────────────────────
server.tool(
  'list_trash',
  'List todos currently in the Papierkorb (soft-deleted). Newest deleted first.',
  {},
  async () => {
    const items = await call<unknown[]>('/api/todos/trash');
    return asText(items);
  },
);

// ─── restore_todo ──────────────────────────────────────────────────────────
server.tool(
  'restore_todo',
  'Restore a soft-deleted todo from the Papierkorb.',
  {
    id: z.number().int().positive(),
  },
  async ({ id }) => {
    const restored = await call<unknown>(`/api/todos/${id}/restore`, { method: 'POST' });
    return asText(restored);
  },
);

// ─── list_snippets ─────────────────────────────────────────────────────────
server.tool(
  'list_snippets',
  'List all snippets / Notizen on a todo.',
  {
    todo_id: z.number().int().positive(),
  },
  async ({ todo_id }) => {
    const snippets = await call<unknown[]>(`/api/snippets/by-todo/${todo_id}`);
    return asText(snippets);
  },
);

// ─── create_snippet ────────────────────────────────────────────────────────
server.tool(
  'create_snippet',
  'Add a snippet or note ("Notiz") to a todo. `language` accepts any highlight.js-style identifier ("markdown", "typescript", "bash", …); use "markdown" for plain notes.',
  {
    todo_id: z.number().int().positive(),
    title: z.string().max(200).optional(),
    language: z.string().max(30).optional().describe('Defaults to "markdown".'),
    content: z.string().max(100_000).describe('The snippet body.'),
  },
  async ({ todo_id, title, language, content }) => {
    const created = await call<unknown>(`/api/snippets/by-todo/${todo_id}`, {
      method: 'POST',
      body: JSON.stringify({
        title: title ?? '',
        language: language ?? 'markdown',
        content,
      }),
    });
    return asText(created);
  },
);

// ─── update_snippet ────────────────────────────────────────────────────────
server.tool(
  'update_snippet',
  'Update an existing snippet / Notiz. Only fields you pass are changed.',
  {
    id: z.number().int().positive(),
    title: z.string().max(200).optional(),
    language: z.string().max(30).optional(),
    content: z.string().max(100_000).optional(),
  },
  async ({ id, ...patch }) => {
    const updated = await call<unknown>(`/api/snippets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return asText(updated);
  },
);

// ─── delete_snippet ────────────────────────────────────────────────────────
server.tool(
  'delete_snippet',
  'Permanently delete a snippet / Notiz.',
  { id: z.number().int().positive() },
  async ({ id }) => {
    await call<void>(`/api/snippets/${id}`, { method: 'DELETE' });
    return asText({ ok: true, id });
  },
);

// ─── list_attachments ──────────────────────────────────────────────────────
server.tool(
  'list_attachments',
  'List files attached to a todo.',
  { todo_id: z.number().int().positive() },
  async ({ todo_id }) => {
    const items = await call<unknown[]>(`/api/attachments/by-todo/${todo_id}`);
    return asText(items);
  },
);

// ─── delete_attachment ─────────────────────────────────────────────────────
server.tool(
  'delete_attachment',
  'Remove a file attachment from its todo (also deletes it from disk).',
  { id: z.number().int().positive() },
  async ({ id }) => {
    await call<void>(`/api/attachments/${id}`, { method: 'DELETE' });
    return asText({ ok: true, id });
  },
);

// ─── attach_file ───────────────────────────────────────────────────────────
server.tool(
  'attach_file',
  'Attach a local file (by absolute path) to a todo. The file is uploaded to the werkbank API and stored on disk.',
  {
    todo_id: z.number().int().positive(),
    path: z.string().min(1).describe('Absolute local path to the file to upload.'),
    filename: z.string().optional()
      .describe('Override the filename stored on the todo. Defaults to basename(path).'),
  },
  async ({ todo_id, path, filename }) => {
    const buf = readFileSync(path);
    const name = filename ?? basename(path);
    const blob = new Blob([buf]);
    const fd = new FormData();
    fd.append('files', blob, name);

    const resp = await fetch(`${API_URL}/api/attachments/by-todo/${todo_id}`, {
      method: 'POST',
      body: fd,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`attach_file failed ${resp.status}: ${body || resp.statusText}`);
    }
    const attachments = await resp.json() as unknown[];
    return asText(attachments);
  },
);

// ─── boot ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr only — stdout is the MCP transport.
process.stderr.write(
  `[werkbank-mcp] connected (API=${API_URL}, pid=${process.pid})\n`,
);
