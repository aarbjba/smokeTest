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
        insertEvent(caller_id, 'blackboard:write', { key, value_excerpt: value.slice(0, 200), version });
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
      insertEvent(caller_id, 'bus:message', { from: caller_id, to: target, kind, payload_excerpt: payload.slice(0, 200), hop_count: hopCount });
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

// ─── Start ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[swarm-mcp] ready run=${RUN_ID} db=${RUN_DB_PATH}`);
