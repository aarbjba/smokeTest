#!/usr/bin/env node
/**
 * Swarm MCP server.
 *
 * Provides coordination tools for swarm coordinator processes:
 * blackboard read/write/list, peer messaging, progress reporting, terminate.
 *
 * Each swarm run spawns its own instance of this server (one MCP process per
 * coordinator process, all sharing the same SQLite Run-DB via WAL mode).
 *
 * Configuration (env):
 *   RUN_DB_PATH  — absolute path to the run SQLite database (required)
 *   RUN_ID       — run identifier for logging (required)
 *   AGENT_IDS    — comma-separated list of all valid coordinator IDs (required)
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const RUN_DB_PATH = process.env.RUN_DB_PATH ?? '';
const RUN_ID      = process.env.RUN_ID ?? 'unknown';
const AGENT_IDS   = new Set((process.env.AGENT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));

if (!RUN_DB_PATH) {
  console.error('[swarm-mcp] RUN_DB_PATH is required');
  process.exit(1);
}

const db = new Database(RUN_DB_PATH);
db.pragma('busy_timeout = 5000');

function now(): number { return Date.now(); }

function nextSeq(agentId: string): number {
  const row = db.prepare('SELECT MAX(seq) as m FROM events WHERE agent_id = ?').get(agentId) as { m: number | null };
  return (row?.m ?? 0) + 1;
}

function insertEvent(agentId: string, type: string, data: object): void {
  db.prepare(
    'INSERT INTO events (agent_id, type, data, ts, seq) VALUES (?, ?, ?, ?, ?)'
  ).run(agentId, type, JSON.stringify(data), now(), nextSeq(agentId));
}

const server = new McpServer({ name: 'swarm-mcp', version: '0.1.0' });

// ─── write_blackboard ───────────────────────────────────────────────────────
server.tool(
  'write_blackboard',
  'Write a key-value pair to the shared blackboard. Previous version is kept for history/replay.',
  {
    caller_id: z.string().describe('ID of the calling coordinator'),
    key:       z.string().min(1).describe('Blackboard key (e.g. "market:summary")'),
    value:     z.string().describe('Value to store (JSON or plain text)'),
  },
  ({ caller_id, key, value }) => {
    const isInbox = key.startsWith('inbox:');
    const writeStmt = db.transaction(() => {
      db.prepare('UPDATE blackboard SET is_current = 0 WHERE key = ? AND is_current = 1').run(key);
      const vRow = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM blackboard WHERE key = ?').get(key) as { v: number };
      const version = vRow.v;
      db.prepare(
        'INSERT INTO blackboard (key, value, version, written_by, written_at, is_current) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(key, value, version, caller_id, now());
      if (!isInbox) {
        insertEvent(caller_id, 'blackboard:write', { key, value, version });
      }
      return version;
    });
    const version = writeStmt();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, key, version }) }] };
  },
);

// ─── read_blackboard ────────────────────────────────────────────────────────
server.tool(
  'read_blackboard',
  'Read the current value of a blackboard key.',
  {
    caller_id: z.string().describe('ID of the calling coordinator'),
    key:       z.string().min(1).describe('Blackboard key to read'),
  },
  ({ caller_id: _caller_id, key }) => {
    const row = db.prepare('SELECT value, version FROM blackboard WHERE key = ? AND is_current = 1').get(key) as
      { value: string; version: number } | undefined;
    const result = { ok: true, key, value: row?.value ?? null, version: row?.version ?? null };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

// ─── list_blackboard ────────────────────────────────────────────────────────
server.tool(
  'list_blackboard',
  'List all current blackboard entries, optionally filtered by key prefix.',
  {
    caller_id: z.string().describe('ID of the calling coordinator'),
    prefix:    z.string().optional().describe('Key prefix filter (e.g. "market:")'),
  },
  ({ caller_id: _caller_id, prefix }) => {
    let rows: { key: string; value: string; version: number }[];
    if (prefix) {
      rows = db.prepare(
        'SELECT key, value, version FROM blackboard WHERE is_current = 1 AND key LIKE ? ORDER BY key'
      ).all(`${prefix}%`) as typeof rows;
    } else {
      rows = db.prepare(
        'SELECT key, value, version FROM blackboard WHERE is_current = 1 ORDER BY key'
      ).all() as typeof rows;
    }
    // Filter out inbox keys from list
    const entries = rows.filter(r => !r.key.startsWith('inbox:'));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, entries }) }] };
  },
);

// ─── send_to_peer ───────────────────────────────────────────────────────────
server.tool(
  'send_to_peer',
  'Send a message to another coordinator (or broadcast to all). Message lands in their inbox.',
  {
    caller_id: z.string().describe('ID of the sending coordinator'),
    to_agent:  z.string().describe('Target coordinator ID or "broadcast"'),
    payload:   z.string().describe('Message payload (JSON or text)'),
    kind:      z.enum(['send', 'request', 'reply']).default('send').describe('Message kind'),
    reply_to:  z.string().optional().describe('msg_id being replied to (for kind=reply)'),
  },
  ({ caller_id, to_agent, payload, kind, reply_to }) => {
    const targets = to_agent === 'broadcast'
      ? [...AGENT_IDS].filter(id => id !== caller_id)
      : [to_agent];

    // Check hop count if reply
    let hopCount = 0;
    if (reply_to) {
      const parent = db.prepare('SELECT hop_count FROM bus_messages WHERE msg_id = ?').get(reply_to) as { hop_count: number } | undefined;
      hopCount = (parent?.hop_count ?? 0) + 1;
      if (hopCount > 6) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'max hop count (6) exceeded' }) }] };
      }
    }

    const msgIds: string[] = [];
    const sendOne = db.transaction((target: string) => {
      const msgId = randomUUID();
      db.prepare(
        'INSERT INTO bus_messages (msg_id, from_agent, to_agent, kind, payload, reply_to, hop_count, sent_at, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
      ).run(msgId, caller_id, target, kind, payload, reply_to ?? null, hopCount, now());
      insertEvent(caller_id, 'bus:message', { from: caller_id, to: target, kind, payload, hop_count: hopCount });
      // Write to inbox blackboard key for check_inbox
      const inboxKey = `inbox:${target}:${msgId}`;
      db.prepare('UPDATE blackboard SET is_current = 0 WHERE key = ? AND is_current = 1').run(inboxKey);
      db.prepare(
        'INSERT INTO blackboard (key, value, version, written_by, written_at, is_current) VALUES (?, ?, 1, ?, ?, 1)'
      ).run(inboxKey, JSON.stringify({ msg_id: msgId, from_agent: caller_id, kind, payload, reply_to }), caller_id, now());
      return msgId;
    });

    for (const target of targets) {
      msgIds.push(sendOne(target));
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, msg_id: msgIds[0] ?? null, sent_to: targets }) }] };
  },
);

// ─── check_inbox ────────────────────────────────────────────────────────────
server.tool(
  'check_inbox',
  'Read and clear all pending messages in your inbox.',
  {
    caller_id: z.string().describe('ID of the calling coordinator — reads your own inbox'),
  },
  ({ caller_id }) => {
    const prefix = `inbox:${caller_id}:`;
    const rows = db.prepare(
      'SELECT key, value FROM blackboard WHERE key LIKE ? AND is_current = 1'
    ).all(`${prefix}%`) as { key: string; value: string }[];

    const messages: unknown[] = [];
    const clearInbox = db.transaction(() => {
      for (const row of rows) {
        try {
          const msg = JSON.parse(row.value);
          messages.push(msg);
          db.prepare('UPDATE blackboard SET is_current = 0 WHERE key = ? AND is_current = 1').run(row.key);
          if (msg?.msg_id) {
            db.prepare('UPDATE bus_messages SET delivered = 1 WHERE msg_id = ?').run(msg.msg_id);
          }
        } catch { /* skip malformed */ }
      }
    });
    clearInbox();

    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, messages }) }] };
  },
);

// ─── report_progress ────────────────────────────────────────────────────────
server.tool(
  'report_progress',
  'Report progress to the swarm orchestrator (visible in SSE stream and replay).',
  {
    caller_id: z.string().describe('ID of the calling coordinator'),
    message:   z.string().describe('Progress message (free text)'),
    percent:   z.number().min(0).max(100).optional().describe('Optional completion percentage 0–100'),
  },
  ({ caller_id, message, percent }) => {
    insertEvent(caller_id, 'progress', { message, percent });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
  },
);

// ─── terminate ──────────────────────────────────────────────────────────────
server.tool(
  'terminate',
  'Mark this coordinator as done and terminate the session.',
  {
    caller_id: z.string().describe('ID of the calling coordinator'),
    reason:    z.string().optional().describe('Optional reason for termination'),
  },
  ({ caller_id, reason }) => {
    db.prepare('UPDATE agents SET status = ?, ended_at = ? WHERE id = ?').run('terminated', now(), caller_id);
    insertEvent(caller_id, 'coordinator:terminate', { reason });
    // Write status to blackboard so peers can observe
    db.prepare('UPDATE blackboard SET is_current = 0 WHERE key = ? AND is_current = 1').run(`status:${caller_id}`);
    db.prepare(
      'INSERT INTO blackboard (key, value, version, written_by, written_at, is_current) VALUES (?, ?, 1, ?, ?, 1)'
    ).run(`status:${caller_id}`, 'terminated', caller_id, now());
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
  },
);

// ─── publish_tasks ──────────────────────────────────────────────────────────
// Planner publishes the full task graph in one call. Idempotent on (id):
// re-publishing an existing id is rejected so concurrent planners cannot
// silently mutate the queue. Each task's depends_on is stored as JSON.
server.tool(
  'publish_tasks',
  'Planner: publish the full task graph for workers to claim. Each task needs id, title, description, priority and depends_on (array of task ids).',
  {
    caller_id: z.string().describe('ID of the calling coordinator (the planner)'),
    tasks: z.array(z.object({
      id:          z.string().min(1).describe('Unique task id (short slug)'),
      title:       z.string().min(1).describe('Short label'),
      description: z.string().min(1).describe('Full instructions for the worker'),
      priority:    z.enum(['high', 'medium', 'low']).default('medium'),
      depends_on:  z.array(z.string()).default([]).describe('IDs of tasks that must complete first'),
    })).min(1),
  },
  ({ caller_id, tasks }) => {
    const ts = now();
    const inserted: string[] = [];
    const skipped: string[] = [];
    const insert = db.transaction(() => {
      const insertStmt = db.prepare(
        'INSERT OR IGNORE INTO swarm_tasks (id, title, description, priority, status, depends_on, version, created_at, updated_at) ' +
        "VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?)"
      );
      for (const t of tasks) {
        const res = insertStmt.run(t.id, t.title, t.description, t.priority, JSON.stringify(t.depends_on), ts, ts);
        if (res.changes > 0) inserted.push(t.id);
        else skipped.push(t.id);
      }
    });
    insert();
    insertEvent(caller_id, 'planner:publish_tasks', { inserted, skipped, total: tasks.length });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, inserted, skipped }) }] };
  },
);

// ─── claim_task ─────────────────────────────────────────────────────────────
// Atomic claim: inside a single transaction we (a) find the highest-priority
// pending task whose depends_on are all completed, (b) flip it to 'claimed'
// and bump its version, (c) collect the dep results so the worker has context.
// Returns { task: null } when nothing is claimable so the worker can terminate.
const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

server.tool(
  'claim_task',
  'Worker: atomically claim the next ready task (pending with all dependencies completed). Returns { task: null } when nothing is claimable.',
  {
    worker_id: z.string().describe('ID of the calling worker coordinator'),
  },
  ({ worker_id }) => {
    interface TaskRow {
      id: string; title: string; description: string; priority: string;
      depends_on: string; version: number; created_at: number;
    }
    const claim = db.transaction(() => {
      const completedRows = db.prepare(
        "SELECT id FROM swarm_tasks WHERE status = 'completed'"
      ).all() as { id: string }[];
      const completed = new Set(completedRows.map(r => r.id));

      const candidates = db.prepare(
        "SELECT id, title, description, priority, depends_on, version, created_at " +
        "FROM swarm_tasks WHERE status = 'pending'"
      ).all() as TaskRow[];

      const ready = candidates.filter(c => {
        let deps: string[];
        try { deps = JSON.parse(c.depends_on); } catch { deps = []; }
        return deps.every(d => completed.has(d));
      });
      if (ready.length === 0) return null;

      ready.sort((a, b) => {
        const pr = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
        if (pr !== 0) return pr;
        return a.created_at - b.created_at;
      });
      const chosen = ready[0]!;

      const ts = now();
      const newVersion = chosen.version + 1;
      const upd = db.prepare(
        "UPDATE swarm_tasks SET status = 'claimed', claimed_by = ?, version = ?, updated_at = ? " +
        "WHERE id = ? AND version = ?"
      ).run(worker_id, newVersion, ts, chosen.id, chosen.version);
      if (upd.changes === 0) return null; // lost the race

      // Gather dep results for worker context.
      let deps: string[];
      try { deps = JSON.parse(chosen.depends_on); } catch { deps = []; }
      const depResults: { id: string; title: string; result: string | null }[] = [];
      if (deps.length > 0) {
        const placeholders = deps.map(() => '?').join(',');
        const depRows = db.prepare(
          `SELECT id, title, result FROM swarm_tasks WHERE id IN (${placeholders})`
        ).all(...deps) as { id: string; title: string; result: string | null }[];
        depResults.push(...depRows);
      }

      return {
        id:          chosen.id,
        title:       chosen.title,
        description: chosen.description,
        priority:    chosen.priority,
        version:     newVersion,
        dependency_results: depResults,
      };
    });

    const task = claim();
    if (task) {
      insertEvent(worker_id, 'worker:claim_task', { task_id: task.id, title: task.title });
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, task }) }] };
  },
);

// ─── complete_task ──────────────────────────────────────────────────────────
// Optimistic-locking complete: only succeeds if status is still 'claimed' and
// the caller is the worker that claimed it. Bumps version so a stale fail_task
// from the original worker (if it retries after timeout) cannot overwrite.
server.tool(
  'complete_task',
  'Worker: report a claimed task as completed with its result.',
  {
    worker_id: z.string().describe('ID of the calling worker coordinator'),
    task_id:   z.string().describe('Task id returned by claim_task'),
    result:    z.string().describe('Task result text'),
  },
  ({ worker_id, task_id, result }) => {
    const ts = now();
    const upd = db.prepare(
      "UPDATE swarm_tasks SET status = 'completed', result = ?, version = version + 1, updated_at = ? " +
      "WHERE id = ? AND status = 'claimed' AND claimed_by = ?"
    ).run(result, ts, task_id, worker_id);
    if (upd.changes === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'task not claimed by this worker or already terminal' }) }] };
    }
    insertEvent(worker_id, 'worker:complete_task', { task_id, result });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
  },
);

// ─── fail_task ──────────────────────────────────────────────────────────────
// Marks a claimed task as failed. Does not auto-retry — the planner can re-publish
// new tasks in a future cycle if needed. (Matches our single-cycle topology spec.)
server.tool(
  'fail_task',
  'Worker: report a claimed task as failed with an error message.',
  {
    worker_id: z.string().describe('ID of the calling worker coordinator'),
    task_id:   z.string().describe('Task id returned by claim_task'),
    error_msg: z.string().describe('Why the task failed'),
  },
  ({ worker_id, task_id, error_msg }) => {
    const ts = now();
    const upd = db.prepare(
      "UPDATE swarm_tasks SET status = 'failed', error_msg = ?, version = version + 1, updated_at = ? " +
      "WHERE id = ? AND status = 'claimed' AND claimed_by = ?"
    ).run(error_msg, ts, task_id, worker_id);
    if (upd.changes === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'task not claimed by this worker or already terminal' }) }] };
    }
    insertEvent(worker_id, 'worker:fail_task', { task_id, error_msg });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
  },
);

// ─── Start ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[swarm-mcp] ready run=${RUN_ID} db=${RUN_DB_PATH}`);
