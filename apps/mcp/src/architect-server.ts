#!/usr/bin/env node
/**
 * Architect MCP server.
 *
 * Provides two tools for the Swarm Architect interview agent:
 *   propose_config    — show a live preview of the current (partial) config
 *   finalize_config   — validate and persist the final SwarmConfig
 *
 * The server writes finalized configs to the werkbank API so they appear in
 * the swarm_configs table. propose_config is intentionally lightweight —
 * it just echoes back the partial config for the frontend to display.
 *
 * Configuration (env):
 *   WERKBANK_API_URL  — werkbank API base URL (default http://localhost:3001)
 *   CONFIG_NAME       — optional name for the saved config
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL     = (process.env.WERKBANK_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const CONFIG_NAME = process.env.CONFIG_NAME ?? '';

async function apiCall<T>(path: string, init: RequestInit = {}): Promise<T> {
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

const server = new McpServer({ name: 'architect-mcp', version: '0.1.0' });

// ─── propose_config ──────────────────────────────────────────────────────────
server.tool(
  'propose_config',
  'Show the user a live preview of the current (partial) SwarmConfig. Call this whenever the config changes significantly during the interview.',
  {
    partial_config: z.record(z.unknown()).describe('Current (potentially partial) SwarmConfig object'),
  },
  async ({ partial_config }) => {
    // The frontend detects "propose_config" tool calls in the stream-json
    // output and renders them as a live JSON preview. No DB write needed here.
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          preview_shown: true,
          config_preview: partial_config,
        }),
      }],
    };
  },
);

// ─── finalize_config ─────────────────────────────────────────────────────────
server.tool(
  'finalize_config',
  'Validate and save the final SwarmConfig. Call this when the user has approved the config. Returns config_id on success, or validation errors on failure.',
  {
    config: z.record(z.unknown()).describe('Complete SwarmConfig object to validate and save'),
    name:   z.string().optional().describe('Human-readable name for the saved config'),
  },
  async ({ config, name }) => {
    // Validate against SwarmConfigSchema via the werkbank API
    try {
      const result = await apiCall<{ id: number; goal: string }>('/api/swarm/configs', {
        method:  'POST',
        body:    JSON.stringify({ name: name ?? CONFIG_NAME ?? '', config }),
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, config_id: result.id, goal: result.goal }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: message }),
        }],
      };
    }
  },
);

// ─── list_templates ──────────────────────────────────────────────────────────
server.tool(
  'list_templates',
  'List available coordinator or subagent templates from the template library. Call this before designing new coordinators or subagents — reuse existing templates where possible.',
  {
    type: z.enum(['coordinators', 'subagents']).describe('Which template type to list'),
  },
  async ({ type }) => {
    try {
      const result = await apiCall<{ templates: Array<Record<string, unknown>> }>(
        `/api/swarm/templates/${type}`,
      );
      // Return a compact summary: id, name, description, role/prompt excerpt
      const summary = result.templates.map((t) => ({
        id:          t['id'],
        name:        t['name'],
        description: t['description'],
        ...(type === 'coordinators'
          ? { role: t['role'], model: t['model'], max_turns: t['max_turns'] }
          : { model: t['model'], tools: t['tools'], prompt_excerpt: typeof t['prompt'] === 'string' ? (t['prompt'] as string).slice(0, 120) + '…' : '' }),
        usage_count: t['usage_count'],
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, type, count: summary.length, templates: summary }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: message }),
        }],
      };
    }
  },
);

// ─── use_template ─────────────────────────────────────────────────────────────
server.tool(
  'use_template',
  'Fetch the full content of a specific coordinator or subagent template by ID. Use this to incorporate an existing template into the config being designed.',
  {
    type: z.enum(['coordinators', 'subagents']).describe('Template type'),
    id:   z.number().int().positive().describe('Template ID from list_templates'),
  },
  async ({ type, id }) => {
    try {
      const result = await apiCall<{ template: Record<string, unknown> }>(
        `/api/swarm/templates/${type}/${id}`,
      );
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, template: result.template }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: message }),
        }],
      };
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[architect-mcp] ready api=${API_URL}`);
