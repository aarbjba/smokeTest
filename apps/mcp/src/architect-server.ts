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

// ─── list_topologies ─────────────────────────────────────────────────────────
//
// Pulls the live TOPOLOGY_METADATA single-source-of-truth (name, description,
// role conventions, options, sample config). Lets the agent discover all
// available topologies dynamically rather than relying on a stale list in the
// preprompt — and lets it copy a sample config as a starting point.
server.tool(
  'list_topologies',
  'List all available swarm topologies with their constraints, options and a runnable sample config. Call this when designing a new swarm and you are unsure which topology fits — or to copy a sample config as a starting point.',
  {
    detail: z.enum(['summary', 'full']).default('summary')
      .describe('"summary" returns name + description + role conventions; "full" includes ASCII diagram, options schema and a complete sampleConfig.'),
  },
  async ({ detail }) => {
    try {
      const result = await apiCall<{ topologies: Array<Record<string, unknown>> }>('/api/swarm/topology');
      const topologies = result.topologies.map((t) => {
        if (detail === 'full') return t;
        return {
          topology:        t['topology'],
          name:            t['name'],
          description:     t['description'],
          roleConventions: t['roleConventions'],
          options:         (t['options'] as Array<Record<string, unknown>>).map(o => ({
            key:         o['key'],
            type:        o['type'],
            default:     o['default'],
            description: o['description'],
          })),
        };
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, count: topologies.length, topologies }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
      };
    }
  },
);

// ─── validate_config ─────────────────────────────────────────────────────────
//
// Dry-run validation with no persistence. Two-stage check on the server:
// Zod schema (shape, defaults, regex) → topology-handler validate() (role
// assignments, agent counts, DAG cycles, flow-DSL, ...). Returns the normalized
// config on success so the agent can immediately pass it to run_swarm.
server.tool(
  'validate_config',
  'Validate a SwarmConfig WITHOUT saving or running it. Returns ok:true with the normalized (defaults applied) config, or ok:false with structured errors. Call before run_swarm to surface problems early.',
  {
    config: z.record(z.unknown()).describe('SwarmConfig object to validate'),
  },
  async ({ config }) => {
    try {
      const result = await apiCall<Record<string, unknown>>('/api/swarm/validate', {
        method: 'POST',
        body:   JSON.stringify({ config }),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
      };
    }
  },
);

// ─── run_swarm ───────────────────────────────────────────────────────────────
//
// Non-blocking start. Returns runId after the swarm:start event fires; the run
// continues in the background. Pair with get_run_status to poll progress and
// surface results to the user. Use validate_config first when in doubt.
server.tool(
  'run_swarm',
  'Start a swarm run from a SwarmConfig (non-blocking). Returns runId immediately; the run continues in the background. Use get_run_status to poll progress and fetch the final blackboard / token totals.',
  {
    config: z.record(z.unknown()).describe('Validated SwarmConfig object to run'),
    save:   z.boolean().default(false).describe('Also persist the config to swarm_configs (so it appears in the saved-configs list and can be re-run).'),
    name:   z.string().optional().describe('Name to use when save=true'),
  },
  async ({ config, save, name }) => {
    try {
      let savedConfigId: number | null = null;
      if (save) {
        const saved = await apiCall<{ id: number }>('/api/swarm/configs', {
          method: 'POST',
          body:   JSON.stringify({ name: name ?? CONFIG_NAME ?? '', config }),
        });
        savedConfigId = saved.id;
      }
      const result = await apiCall<{ runId: string; status: string; urls: Record<string, string> }>(
        '/api/swarm/run-async',
        { method: 'POST', body: JSON.stringify({ config }) },
      );
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok:       true,
            run_id:   result.runId,
            status:   result.status,
            saved_config_id: savedConfigId,
            urls:     result.urls,
          }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
      };
    }
  },
);

// ─── get_run_status ──────────────────────────────────────────────────────────
//
// Poll a swarm's progress. Returns status (running/done/error/aborted), token
// totals, per-agent status, blackboard key count, and (optionally) the current
// blackboard snapshot so the agent can summarize results without a separate call.
server.tool(
  'get_run_status',
  'Fetch the current status, token usage, agent states, and (optionally) blackboard snapshot of a swarm run. Use after run_swarm to monitor progress and to summarize results to the user.',
  {
    run_id:                z.string().min(1).describe('runId returned by run_swarm'),
    include_blackboard:    z.boolean().default(false).describe('Also fetch the current blackboard snapshot (entries[]).'),
    blackboard_key_prefix: z.string().optional().describe('Filter blackboard entries by key prefix (e.g. "moa:" or "debate:"). Ignored when include_blackboard=false.'),
  },
  async ({ run_id, include_blackboard, blackboard_key_prefix }) => {
    try {
      interface RunMeta {
        run: {
          id: string; goal: string; status: string;
          coordinator_count: number; total_tokens: number | null;
          started_at: number; ended_at: number | null;
          error_message: string | null;
        };
        agents: Array<Record<string, unknown>>;
        tokenSummary: Array<Record<string, unknown>>;
        eventCount: number;
        blackboardKeyCount: number;
      }
      const meta = await apiCall<RunMeta>(`/api/swarm/runs/${encodeURIComponent(run_id)}`);
      const summary: Record<string, unknown> = {
        ok:         true,
        run_id,
        status:     meta.run.status,
        goal:       meta.run.goal,
        coordinators: meta.agents.map(a => ({
          id:        a['id'],
          status:    a['status'],
          exit_code: a['exit_code'],
        })),
        total_tokens:        meta.run.total_tokens,
        event_count:         meta.eventCount,
        blackboard_key_count: meta.blackboardKeyCount,
        error_message:       meta.run.error_message,
      };
      if (include_blackboard) {
        const qs = blackboard_key_prefix ? `?prefix=${encodeURIComponent(blackboard_key_prefix)}` : '';
        const bb = await apiCall<{ entries: Array<{ key: string; value: string; written_by: string }> }>(
          `/api/swarm/runs/${encodeURIComponent(run_id)}/blackboard${qs}`,
        );
        summary['blackboard'] = bb.entries;
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
      };
    }
  },
);

// ─── generate_config ─────────────────────────────────────────────────────────
//
// Foolproof config generator: takes a topology + goal and returns a complete,
// validated SwarmConfig. Uses the topology's built-in sample as the structural
// template (correct roles, required options, valid coordinator IDs) and
// substitutes the caller's goal, model tier, and preset-agent preference.
// Always validates before returning so the result can be passed directly to
// run_swarm or finalize_config.
const PRESET_FLAG_MAP: Record<string, string> = {
  'debate-with-judge': 'debatePresetAgents',
  'mixture-of-agents': 'moaPresetAggregator',
  'majority-voting':   'majorityPresetConsensus',
  'hierarchical':      'hierarchicalPresetAgents',
  'planner-worker':    'plannerWorkerPresetAgents',
  'round-robin':       'roundRobinPresetAgents',
  'council-as-judge':  'councilPresetAgents',
  groupchat:           'groupchatPresetAgents',
  'heavy-swarm':       'heavyPresetAgents',
  'agent-rearrange':   'agentRearrangePresetAgents',
  'graph-workflow':    'graphWorkflowPresetAgents',
};

server.tool(
  'generate_config',
  [
    'Generate a complete, validated SwarmConfig for a given topology and goal.',
    'Uses the topology\'s built-in sample structure so all required roles and options are correct.',
    'Always validates before returning — pass the result directly to run_swarm.',
    'Prefer this over building configs by hand to avoid validation errors.',
  ].join(' '),
  {
    topology: z.enum([
      'concurrent', 'debate-with-judge', 'mixture-of-agents', 'majority-voting',
      'sequential', 'hierarchical', 'planner-worker', 'round-robin', 'council-as-judge',
      'groupchat', 'heavy-swarm', 'agent-rearrange', 'graph-workflow',
    ]).describe('Which swarm topology to use'),
    goal: z.string().min(10).describe('The task or question the swarm should solve'),
    model_tier: z.enum(['haiku', 'sonnet', 'opus']).default('haiku')
      .describe('"haiku" is fastest/cheapest, "sonnet" for quality, "opus" for hardest tasks'),
    use_preset_agents: z.boolean().default(true)
      .describe('Use built-in topology-specific agent prompts — strongly recommended, produces far better results'),
  },
  async ({ topology, goal, model_tier, use_preset_agents }) => {
    try {
      // 1. Fetch the sample config for this topology from the live metadata
      const result = await apiCall<{ topologies: Array<Record<string, unknown>> }>('/api/swarm/topology');
      const meta = result.topologies.find((t) => t['topology'] === topology);
      if (!meta) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Unknown topology: ${topology}` }) }],
        };
      }

      // 2. Deep-clone the sample so mutations don't bleed between calls
      const config = JSON.parse(JSON.stringify(meta['sampleConfig'])) as Record<string, unknown>;

      // 3. Substitute goal
      config['goal'] = goal;

      // 4. Apply model tier to every coordinator
      const coordinators = config['coordinators'] as Array<Record<string, unknown>>;
      for (const c of coordinators) {
        c['model'] = model_tier;
      }

      // 5. Apply preset-agents flag (topology-specific key name)
      const presetFlag = PRESET_FLAG_MAP[topology];
      if (presetFlag) {
        const opts = (config['topologyOptions'] ?? {}) as Record<string, unknown>;
        opts[presetFlag] = use_preset_agents;
        config['topologyOptions'] = opts;
      }

      // 6. Validate — fail loudly if the template itself is broken
      const validateResult = await apiCall<Record<string, unknown>>('/api/swarm/validate', {
        method: 'POST',
        body:   JSON.stringify({ config }),
      });

      if (validateResult['ok'] !== true) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok:               false,
              error:            'Generated config failed validation — this is a bug, please report it',
              validation_errors: validateResult['errors'],
              generated_config: config,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok:               true,
            topology,
            coordinator_count: coordinators.length,
            config:           validateResult['config'] ?? config,
            hint:             'Config validated. Pass directly to run_swarm or finalize_config.',
          }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
      };
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[architect-mcp] ready api=${API_URL}`);
