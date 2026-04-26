<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { api } from '../api';
import type { SwarmTopologyMetadata, SwarmConfig } from '../types';

const topologies     = ref<SwarmTopologyMetadata[]>([]);
const activeKey      = ref<string>('concurrent');
const draftConfigs   = ref<Record<string, string>>({});
const events         = ref<Array<{ type: string; data: unknown; ts: number }>>([]);
const status         = ref<'idle' | 'running' | 'done' | 'error' | 'aborted'>('idle');
const runId          = ref<string | null>(null);
const runError       = ref<string | null>(null);
const streamEl       = ref<HTMLDivElement | null>(null);
const loading        = ref(true);
const streamFilter   = ref<string>('');
const showRaw        = ref<boolean>(false);
const expandedBb     = ref<Set<string>>(new Set());
const startedAt      = ref<number | null>(null);
const totalTokens    = ref<number>(0);

let abortCtl: AbortController | null = null;

const activeTopology = computed<SwarmTopologyMetadata | undefined>(
  () => topologies.value.find(t => t.topology === activeKey.value),
);

const activeDraft = computed({
  get: () => draftConfigs.value[activeKey.value] ?? '',
  set: (v: string) => { draftConfigs.value[activeKey.value] = v; },
});

const isRunning = computed(() => status.value === 'running');

onMounted(async () => {
  try {
    const res = await api.swarm.topology.list();
    topologies.value = res.topologies;
    for (const t of res.topologies) {
      draftConfigs.value[t.topology] = JSON.stringify(t.sampleConfig, null, 2);
    }
  } catch (err) {
    runError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  if (abortCtl) { abortCtl.abort(); abortCtl = null; }
});

function resetSample() {
  if (!activeTopology.value) return;
  draftConfigs.value[activeKey.value] = JSON.stringify(activeTopology.value.sampleConfig, null, 2);
}

function pushEvent(type: string, data: unknown) {
  events.value.push({ type, data, ts: Date.now() });
  if (type === 'tokens' && data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    totalTokens.value += Number(d['inputTokens'] ?? 0) + Number(d['outputTokens'] ?? 0);
  }
  requestAnimationFrame(() => {
    if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight;
  });
}

async function runDraft() {
  if (isRunning.value) return;

  let parsed: SwarmConfig;
  try {
    parsed = JSON.parse(activeDraft.value);
  } catch (e) {
    runError.value = `Config-JSON ist ungültig: ${e instanceof Error ? e.message : String(e)}`;
    status.value = 'error';
    return;
  }

  events.value      = [];
  runId.value       = null;
  runError.value    = null;
  totalTokens.value = 0;
  startedAt.value   = Date.now();
  status.value      = 'running';

  abortCtl = new AbortController();
  try {
    const resp = await fetch('/api/swarm/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body:    JSON.stringify({ config: parsed }),
      signal:  abortCtl.signal,
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Server returned ${resp.status}: ${text || resp.statusText}`);
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSseBlock(raw);
        if (evt) {
          if (evt.type === 'swarm:start' && typeof evt.data === 'object' && evt.data !== null && 'runId' in evt.data) {
            runId.value = String((evt.data as Record<string, unknown>).runId);
          }
          if (evt.type === 'swarm:end' && typeof evt.data === 'object' && evt.data !== null && 'status' in evt.data) {
            const s = String((evt.data as Record<string, unknown>).status);
            status.value = (s === 'done' || s === 'error' || s === 'aborted') ? s : 'done';
          }
          pushEvent(evt.type, evt.data);
        }
      }
    }
    if (status.value === 'running') status.value = 'done';
  } catch (err) {
    if (abortCtl?.signal.aborted) {
      status.value = 'aborted';
    } else {
      runError.value = err instanceof Error ? err.message : String(err);
      status.value = 'error';
    }
  } finally {
    abortCtl = null;
  }
}

function stopRun() {
  if (abortCtl) abortCtl.abort();
}

interface ParsedSse { type: string; data: unknown; }

function parseSseBlock(raw: string): ParsedSse | null {
  let evtName = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) evtName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && evtName === 'message') return null;
  const dataStr = dataLines.join('\n');
  let data: unknown = dataStr;
  if (dataStr) {
    try { data = JSON.parse(dataStr); } catch { /* keep as string */ }
  }
  return { type: evtName, data };
}

// ─── Derived run state (mirror of swarm-DB tables) ────────────────────────────
//
// Everything the runtime persists into the per-run SQLite (events, blackboard,
// agents, tokens) is also pushed through the SSE stream. We rebuild the same
// shape here so the UI doesn't need an extra fetch loop.

interface BlackboardEntry { value: string; agentId: string; ts: number; version: number; }

const blackboards = computed<Record<string, BlackboardEntry[]>>(() => {
  const out: Record<string, BlackboardEntry[]> = {};
  for (const e of events.value) {
    if (e.type !== 'blackboard:write') continue;
    const d = e.data as Record<string, unknown>;
    const key = String(d['key'] ?? '');
    if (!key) continue;
    const agent = String(d['agentId'] ?? '?');
    const value = String(d['value'] ?? '');
    if (!out[key]) out[key] = [];
    out[key].push({ value, agentId: agent, ts: e.ts, version: out[key].length + 1 });
  }
  return out;
});

const blackboardKeys = computed(() => Object.keys(blackboards.value).sort());

interface AgentInfo {
  id: string;
  role: string;
  model: string;
  status: 'pending' | 'running' | 'done' | 'error';
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  lastText: string | null;
  exitCode: number | null;
  turnCount: number;
  spawnCount: number;
}

const agents = computed<AgentInfo[]>(() => {
  const map = new Map<string, AgentInfo>();

  // Seed coordinators from the parsed draft so cards appear before any event.
  if (isRunning.value || events.value.length > 0) {
    try {
      const cfg = JSON.parse(activeDraft.value) as SwarmConfig;
      for (const c of cfg.coordinators ?? []) {
        if (!map.has(c.id)) {
          map.set(c.id, {
            id: c.id, role: c.role, model: c.model, status: 'pending',
            tokensIn: 0, tokensOut: 0, cacheRead: 0,
            lastText: null, exitCode: null, turnCount: 0, spawnCount: 0,
          });
        }
      }
    } catch { /* draft not valid; rely on events */ }
  }

  for (const e of events.value) {
    const d = e.data as Record<string, unknown> | null;
    if (!d) continue;
    const id = String(d['agentId'] ?? '');
    if (!id || id === 'swarm') continue;

    if (!map.has(id)) {
      map.set(id, {
        id, role: '', model: '', status: 'pending',
        tokensIn: 0, tokensOut: 0, cacheRead: 0,
        lastText: null, exitCode: null, turnCount: 0, spawnCount: 0,
      });
    }
    const a = map.get(id)!;

    switch (e.type) {
      case 'coordinator:start':
        a.role   = String(d['role']  ?? a.role);
        a.model  = String(d['model'] ?? a.model);
        a.status = 'running';
        break;
      case 'coordinator:text':
        a.lastText = String(d['text'] ?? '').slice(0, 240);
        break;
      case 'coordinator:end':
        a.exitCode  = d['exitCode']  != null ? Number(d['exitCode'])  : null;
        a.turnCount = d['turnCount'] != null ? Number(d['turnCount']) : 0;
        a.status    = a.exitCode === 0 ? 'done' : 'error';
        break;
      case 'coordinator:error':
        a.status = 'error';
        break;
      case 'subagent:spawn':
        a.spawnCount += 1;
        break;
      case 'tokens':
        a.tokensIn  += Number(d['inputTokens']  ?? 0);
        a.tokensOut += Number(d['outputTokens'] ?? 0);
        a.cacheRead += Number(d['cacheRead']    ?? 0);
        break;
    }
  }
  return Array.from(map.values());
});

const busMessages = computed(() => {
  const out: Array<{ from: string; to: string; kind: string; payload: string; ts: number }> = [];
  for (const e of events.value) {
    if (e.type !== 'bus:message') continue;
    const d = e.data as Record<string, unknown>;
    out.push({
      from:    String(d['from']    ?? '?'),
      to:      String(d['to']      ?? '?'),
      kind:    String(d['kind']    ?? 'send'),
      payload: String(d['payload'] ?? ''),
      ts:      e.ts,
    });
  }
  return out;
});

const currentPhase = computed<string | null>(() => {
  for (let i = events.value.length - 1; i >= 0; i--) {
    if (events.value[i].type === 'topology:phase_change') {
      const d = events.value[i].data as Record<string, unknown>;
      return String(d['phase'] ?? d['name'] ?? d['label'] ?? '') || null;
    }
  }
  return null;
});

// Communication-stream items: filter raw events down to the ones a human
// reader cares about (text, tool calls, peer messages, blackboard, phase
// changes, lifecycle). Token deltas and SSE keepalives stay out of the feed
// but still feed the right-hand panels.
const FEED_TYPES = new Set([
  'swarm:start', 'swarm:end',
  'topology:phase_change',
  'coordinator:start', 'coordinator:text', 'coordinator:end',
  'coordinator:tool_call', 'coordinator:tool_result',
  'coordinator:terminate', 'coordinator:error',
  'subagent:spawn', 'subagent:complete',
  'blackboard:write', 'bus:message', 'progress', 'error',
]);

const feedEvents = computed(() => {
  const filter = streamFilter.value.trim().toLowerCase();
  return events.value.filter(e => {
    if (!showRaw.value && !FEED_TYPES.has(e.type)) return false;
    if (!filter) return true;
    if (e.type.toLowerCase().includes(filter)) return true;
    const s = JSON.stringify(e.data).toLowerCase();
    return s.includes(filter);
  });
});

// ─── Visual helpers ───────────────────────────────────────────────────────────

const AGENT_PALETTE = [
  '#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68',
  '#f7768e', '#7dcfff', '#73daca', '#ff9e64',
  '#c0caf5', '#ff7a93',
];

function agentColor(id: string): string {
  if (!id || id === 'swarm') return 'var(--fg-muted, #888)';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

function eventIcon(type: string): string {
  if (type === 'swarm:start')              return '▶';
  if (type === 'swarm:end')                return '■';
  if (type === 'topology:phase_change')    return '↻';
  if (type === 'coordinator:start')        return '🎬';
  if (type === 'coordinator:end')          return '🏁';
  if (type === 'coordinator:text')         return '💬';
  if (type === 'coordinator:tool_call')    return '🔧';
  if (type === 'coordinator:tool_result')  return '✅';
  if (type === 'coordinator:terminate')    return '⏹';
  if (type === 'coordinator:error')        return '⚠';
  if (type === 'subagent:spawn')           return '✨';
  if (type === 'subagent:complete')        return '✓';
  if (type === 'blackboard:write')         return '📝';
  if (type === 'bus:message')              return '📨';
  if (type === 'progress')                 return '📊';
  if (type === 'tokens')                   return '🪙';
  return '·';
}

function statusLabel(s: typeof status.value): string {
  switch (s) {
    case 'idle':    return '— bereit —';
    case 'running': return 'läuft …';
    case 'done':    return 'fertig';
    case 'error':   return 'Fehler';
    case 'aborted': return 'abgebrochen';
  }
}

function relTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return 'gerade';
  if (sec < 60) return `vor ${sec}s`;
  if (sec < 3600) return `vor ${Math.floor(sec / 60)}m`;
  return `vor ${Math.floor(sec / 3600)}h`;
}

function clockTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000)      return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ─── Per-event accessors (keep the template terse) ────────────────────────────

function ev<T = unknown>(e: { data: unknown }, k: string, def: T): T {
  const d = e.data as Record<string, unknown> | null;
  if (!d) return def;
  const v = d[k];
  return (v === undefined || v === null) ? def : (v as T);
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function toggleBb(key: string) {
  const set = new Set(expandedBb.value);
  if (set.has(key)) set.delete(key); else set.add(key);
  expandedBb.value = set;
}

watch(activeKey, () => {
  // Switching topology during a run leaves the events/agents intact —
  // they belong to the run that's still finishing.
});

// Tick to refresh relative timestamps once a second while running.
const tickNow = ref(Date.now());
let tickHandle: number | null = null;
onMounted(() => {
  tickHandle = window.setInterval(() => { tickNow.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (tickHandle !== null) clearInterval(tickHandle);
});

const runDuration = computed(() => {
  if (!startedAt.value) return null;
  // Touch tickNow so the computed re-evaluates each second.
  void tickNow.value;
  return Date.now() - startedAt.value;
});
</script>

<template>
  <div class="topo-view">
    <header class="topo-header">
      <div class="topo-header-main">
        <h1>🧪 Topologien-Werkstatt</h1>
        <p class="topo-sub">Wähle eine Topologie, justiere die Config und beobachte jedes Wort, jede Notiz und jede Botschaft im Schwarm.</p>
      </div>
      <div class="topo-header-stats" v-if="runId || isRunning">
        <span class="topo-pill topo-pill--mono" v-if="runId">{{ runId }}</span>
        <span class="topo-pill" v-if="runDuration !== null">⏱ {{ fmtDuration(runDuration) }}</span>
        <span class="topo-pill" v-if="totalTokens > 0">🪙 {{ fmtNum(totalTokens) }}</span>
        <span class="topo-pill" v-if="currentPhase">↻ {{ currentPhase }}</span>
        <span class="topo-status-chip" :data-status="status">{{ statusLabel(status) }}</span>
      </div>
    </header>

    <div v-if="loading" class="topo-loading">Lade Topologien …</div>

    <div v-else class="topo-tabs" role="tablist">
      <button
        v-for="t in topologies"
        :key="t.topology"
        role="tab"
        :aria-selected="activeKey === t.topology"
        :class="['topo-tab', { 'topo-tab--active': activeKey === t.topology }]"
        @click="activeKey = t.topology"
      >
        {{ t.name }}
      </button>
    </div>

    <section v-if="activeTopology" class="topo-grid">

      <!-- ─── Column 1: Setup ───────────────────────────────────────────── -->
      <aside class="topo-col topo-col--setup">
        <div class="topo-panel">
          <div class="topo-panel-head">
            <h2>{{ activeTopology.name }}</h2>
            <span class="topo-key-tag">{{ activeTopology.topology }}</span>
          </div>
          <p class="topo-desc">{{ activeTopology.description }}</p>

          <details open>
            <summary>📐 Diagramm</summary>
            <pre class="topo-diagram">{{ activeTopology.diagram }}</pre>
          </details>

          <details>
            <summary>🎭 Rollen-Konventionen</summary>
            <ul class="topo-bullets">
              <li v-for="(rule, i) in activeTopology.roleConventions" :key="i">{{ rule }}</li>
            </ul>
          </details>

          <details v-if="activeTopology.options.length">
            <summary>⚙ Topology-Optionen</summary>
            <table class="topo-options">
              <thead><tr><th>Key</th><th>Typ</th><th>Default</th></tr></thead>
              <tbody>
                <tr v-for="o in activeTopology.options" :key="o.key">
                  <td><code>{{ o.key }}</code></td>
                  <td>{{ o.type }}<span v-if="o.min !== undefined || o.max !== undefined" class="topo-range"> ({{ o.min ?? '−∞' }}..{{ o.max ?? '∞' }})</span></td>
                  <td><code>{{ String(o.default) }}</code></td>
                </tr>
              </tbody>
            </table>
            <p class="topo-options-hint">Beschreibungen erscheinen als Tooltip über <code>option.description</code>.</p>
          </details>
        </div>

        <div class="topo-panel topo-panel--config">
          <div class="topo-panel-head">
            <strong>SwarmConfig (JSON)</strong>
            <button class="topo-btn topo-btn--ghost" @click="resetSample">↺ Sample</button>
          </div>
          <textarea
            v-model="activeDraft"
            class="topo-config-textarea"
            spellcheck="false"
            :disabled="isRunning"
          />
          <div class="topo-run-bar">
            <button v-if="!isRunning" class="topo-btn topo-btn--primary" @click="runDraft">▶ Run</button>
            <button v-else class="topo-btn topo-btn--danger" @click="stopRun">■ Stop</button>
            <span class="topo-status" :data-status="status">{{ statusLabel(status) }}</span>
          </div>
          <div v-if="runError" class="topo-error">⚠ {{ runError }}</div>
        </div>
      </aside>

      <!-- ─── Column 2: Communication stream ────────────────────────────── -->
      <main class="topo-col topo-col--stream">
        <div class="topo-stream-bar">
          <strong>📡 Kommunikation</strong>
          <span class="topo-mute">{{ feedEvents.length }} / {{ events.length }} Events</span>
          <input
            v-model="streamFilter"
            class="topo-filter"
            type="text"
            placeholder="Filter (Typ oder Inhalt) …"
          />
          <label class="topo-toggle" title="Zeige auch Token- und Lifecycle-Rauschen">
            <input type="checkbox" v-model="showRaw" />
            <span>roh</span>
          </label>
          <button
            v-if="events.length"
            class="topo-btn topo-btn--ghost"
            @click="events = []; totalTokens = 0;"
          >Leeren</button>
        </div>

        <div ref="streamEl" class="topo-stream">
          <div v-if="!events.length" class="topo-empty">
            <div class="topo-empty-glyph">💤</div>
            <div>Noch keine Events. Drücke <code>▶ Run</code> links, um den Schwarm zu starten.</div>
          </div>

          <template v-else>
            <article
              v-for="(e, i) in feedEvents"
              :key="i"
              :class="['feed', `feed--${e.type.replace(':', '-')}`]"
            >
              <!-- Phase divider: full-width separator -->
              <template v-if="e.type === 'topology:phase_change'">
                <div class="feed-phase">
                  <span class="feed-phase-line" />
                  <span class="feed-phase-label">↻ {{ ev(e, 'phase', ev(e, 'name', '?')) }}</span>
                  <span class="feed-phase-line" />
                </div>
              </template>

              <!-- Coordinator text: chat bubble in agent's color -->
              <template v-else-if="e.type === 'coordinator:text'">
                <div class="feed-bubble" :style="{ borderColor: agentColor(String(ev(e, 'agentId', ''))) }">
                  <div class="feed-bubble-head">
                    <span class="feed-dot" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }" />
                    <strong class="feed-agent">{{ ev(e, 'agentId', '?') }}</strong>
                    <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  </div>
                  <div class="feed-bubble-text">{{ ev(e, 'text', '') }}</div>
                </div>
              </template>

              <!-- Bus message: arrow A → B -->
              <template v-else-if="e.type === 'bus:message'">
                <div class="feed-bus">
                  <div class="feed-bus-head">
                    <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'from', ''))) }">{{ ev(e, 'from', '?') }}</span>
                    <span class="feed-arrow">→</span>
                    <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'to', ''))) }">{{ ev(e, 'to', '?') }}</span>
                    <span class="feed-kind">{{ ev(e, 'kind', 'send') }}</span>
                    <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  </div>
                  <pre class="feed-bus-payload">{{ ev(e, 'payload', '') }}</pre>
                </div>
              </template>

              <!-- Blackboard write: a sticky note inline -->
              <template v-else-if="e.type === 'blackboard:write'">
                <div class="feed-bb">
                  <div class="feed-bb-head">
                    <span class="feed-icon">📝</span>
                    <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }">{{ ev(e, 'agentId', '?') }}</span>
                    <span>schreibt</span>
                    <code class="feed-bb-key">{{ ev(e, 'key', '?') }}</code>
                    <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  </div>
                  <pre class="feed-bb-value">{{ ev(e, 'value', '') }}</pre>
                </div>
              </template>

              <!-- Subagent spawn -->
              <template v-else-if="e.type === 'subagent:spawn'">
                <div class="feed-spawn">
                  <span class="feed-icon">✨</span>
                  <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }">{{ ev(e, 'agentId', '?') }}</span>
                  <span>spawnt Subagent</span>
                  <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  <details class="feed-details">
                    <summary>Prompt anzeigen</summary>
                    <pre>{{ ev(e, 'prompt', '') }}</pre>
                  </details>
                </div>
              </template>

              <template v-else-if="e.type === 'subagent:complete'">
                <div class="feed-spawn feed-spawn--done">
                  <span class="feed-icon">{{ ev(e, 'success', false) ? '✓' : '✗' }}</span>
                  <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }">{{ ev(e, 'agentId', '?') }}</span>
                  <span>Subagent fertig</span>
                  <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  <details class="feed-details">
                    <summary>Ergebnis</summary>
                    <pre>{{ ev(e, 'result', '') }}</pre>
                  </details>
                </div>
              </template>

              <!-- Tool call -->
              <template v-else-if="e.type === 'coordinator:tool_call'">
                <div class="feed-tool">
                  <span class="feed-icon">🔧</span>
                  <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }">{{ ev(e, 'agentId', '?') }}</span>
                  <code class="feed-tool-name">{{ ev(e, 'toolName', '?') }}</code>
                  <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  <details class="feed-details">
                    <summary>Input</summary>
                    <pre>{{ JSON.stringify(tryParseJson(String(ev(e, 'input', ''))), null, 2) }}</pre>
                  </details>
                </div>
              </template>

              <template v-else-if="e.type === 'coordinator:tool_result'">
                <div :class="['feed-tool', 'feed-tool--result', { 'feed-tool--err': ev(e, 'isError', false) }]">
                  <span class="feed-icon">{{ ev(e, 'isError', false) ? '⚠' : '✅' }}</span>
                  <span class="feed-chip" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }">{{ ev(e, 'agentId', '?') }}</span>
                  <code class="feed-tool-name">{{ ev(e, 'toolName', '?') }}</code>
                  <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  <details class="feed-details">
                    <summary>Ausgabe</summary>
                    <pre>{{ String(ev(e, 'output', '')).slice(0, 4000) }}</pre>
                  </details>
                </div>
              </template>

              <!-- Lifecycle / error / generic fallback -->
              <template v-else>
                <div class="feed-line" :style="{ borderLeftColor: agentColor(String(ev(e, 'agentId', 'swarm'))) }">
                  <span class="feed-icon">{{ eventIcon(e.type) }}</span>
                  <code class="feed-type">{{ e.type }}</code>
                  <span v-if="ev(e, 'agentId', '')" class="feed-chip" :style="{ background: agentColor(String(ev(e, 'agentId', ''))) }">{{ ev(e, 'agentId', '') }}</span>
                  <span class="feed-time" :title="clockTime(e.ts)">{{ relTime(e.ts) }}</span>
                  <details v-if="e.data && typeof e.data === 'object'" class="feed-details">
                    <summary>Daten</summary>
                    <pre>{{ JSON.stringify(e.data, null, 2) }}</pre>
                  </details>
                </div>
              </template>
            </article>
          </template>
        </div>
      </main>

      <!-- ─── Column 3: Swarm-DB state ──────────────────────────────────── -->
      <aside class="topo-col topo-col--state">

        <!-- Blackboards -->
        <section class="topo-panel topo-panel--bb">
          <div class="topo-panel-head">
            <strong>📝 Blackboards</strong>
            <span class="topo-mute">{{ blackboardKeys.length }} Keys</span>
          </div>
          <div v-if="!blackboardKeys.length" class="topo-empty topo-empty--small">
            Noch nichts geschrieben.
          </div>
          <div v-else class="bb-grid">
            <article
              v-for="key in blackboardKeys"
              :key="key"
              :class="['bb-card', { 'bb-card--open': expandedBb.has(key) }]"
            >
              <header class="bb-card-head" @click="toggleBb(key)">
                <code class="bb-card-key">{{ key }}</code>
                <span class="bb-card-meta">
                  <span class="bb-version">v{{ blackboards[key].length }}</span>
                  <span
                    class="feed-chip"
                    :style="{ background: agentColor(blackboards[key][blackboards[key].length - 1].agentId) }"
                  >{{ blackboards[key][blackboards[key].length - 1].agentId }}</span>
                </span>
              </header>
              <pre class="bb-card-value">{{ blackboards[key][blackboards[key].length - 1].value }}</pre>
              <div v-if="expandedBb.has(key) && blackboards[key].length > 1" class="bb-card-history">
                <div class="bb-history-label">Verlauf</div>
                <div
                  v-for="(entry, i) in blackboards[key].slice(0, -1).reverse()"
                  :key="i"
                  class="bb-history-item"
                >
                  <div class="bb-history-meta">
                    <span class="bb-version">v{{ blackboards[key].length - 1 - i }}</span>
                    <span class="feed-chip" :style="{ background: agentColor(entry.agentId) }">{{ entry.agentId }}</span>
                    <span class="feed-time">{{ relTime(entry.ts) }}</span>
                  </div>
                  <pre class="bb-card-value">{{ entry.value }}</pre>
                </div>
              </div>
            </article>
          </div>
        </section>

        <!-- Agents -->
        <section class="topo-panel">
          <div class="topo-panel-head">
            <strong>🤖 Koordinatoren</strong>
            <span class="topo-mute">{{ agents.length }}</span>
          </div>
          <div v-if="!agents.length" class="topo-empty topo-empty--small">
            Noch keine Koordinatoren registriert.
          </div>
          <div v-else class="agent-grid">
            <article
              v-for="a in agents"
              :key="a.id"
              :class="['agent-card', `agent-card--${a.status}`]"
              :style="{ borderLeftColor: agentColor(a.id) }"
            >
              <header class="agent-head">
                <span class="feed-dot" :style="{ background: agentColor(a.id) }" />
                <strong class="agent-id">{{ a.id }}</strong>
                <span class="agent-status" :data-s="a.status" />
              </header>
              <div class="agent-meta">
                <span v-if="a.role" class="agent-role">{{ a.role }}</span>
                <span v-if="a.model" class="agent-model">{{ a.model.replace(/^claude-/, '') }}</span>
              </div>
              <div class="agent-stats">
                <span title="Input-Tokens">↓ {{ fmtNum(a.tokensIn) }}</span>
                <span title="Output-Tokens">↑ {{ fmtNum(a.tokensOut) }}</span>
                <span v-if="a.cacheRead > 0" title="Cache-Read-Tokens">⊕ {{ fmtNum(a.cacheRead) }}</span>
                <span v-if="a.spawnCount > 0" title="Subagent-Spawns">✨ {{ a.spawnCount }}</span>
                <span v-if="a.turnCount > 0" title="Turns">↺ {{ a.turnCount }}</span>
              </div>
              <div v-if="a.lastText" class="agent-last">{{ a.lastText }}</div>
            </article>
          </div>
        </section>

        <!-- Bus traffic summary -->
        <section v-if="busMessages.length" class="topo-panel">
          <div class="topo-panel-head">
            <strong>📨 Peer-Bus</strong>
            <span class="topo-mute">{{ busMessages.length }} Botschaften</span>
          </div>
          <div class="bus-list">
            <div v-for="(m, i) in busMessages.slice().reverse()" :key="i" class="bus-row">
              <span class="feed-chip" :style="{ background: agentColor(m.from) }">{{ m.from }}</span>
              <span class="feed-arrow">→</span>
              <span class="feed-chip" :style="{ background: agentColor(m.to) }">{{ m.to }}</span>
              <span class="feed-kind">{{ m.kind }}</span>
              <span class="feed-time">{{ relTime(m.ts) }}</span>
            </div>
          </div>
        </section>
      </aside>
    </section>
  </div>
</template>

<style scoped>
/* ─── Layout: viewport-bound, three columns scroll independently ─────────── */
.topo-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 14px 16px;
  gap: 10px;
  box-sizing: border-box;
  overflow: hidden;
}

.topo-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.topo-header-main h1 { margin: 0; font-size: 1.35rem; letter-spacing: 0.01em; }
.topo-sub { margin: 4px 0 0; font-size: 0.85rem; color: var(--fg-muted, #888); max-width: 80ch; }
.topo-header-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.topo-pill {
  font-size: 0.75rem;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--bg-card, rgba(255,255,255,0.05));
  border: 1px solid var(--border, #444);
  color: var(--fg-muted, #aaa);
}
.topo-pill--mono { font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace; font-size: 0.7rem; }

.topo-status-chip {
  font-size: 0.78rem;
  padding: 3px 12px;
  border-radius: 999px;
  background: var(--bg-card, rgba(255,255,255,0.06));
  border: 1px solid var(--border, #444);
}
.topo-status-chip[data-status='running'] { color: var(--accent, #69c); border-color: var(--accent, #69c); animation: topo-pulse 1.4s infinite; }
.topo-status-chip[data-status='done']    { color: var(--success, #0a0); border-color: var(--success, #0a0); }
.topo-status-chip[data-status='error']   { color: var(--danger, #d33);  border-color: var(--danger, #d33); }
.topo-status-chip[data-status='aborted'] { color: var(--warning, #c80); border-color: var(--warning, #c80); }

.topo-loading { padding: 24px; color: var(--fg-muted, #888); }

/* Tabs — horizontal scroll instead of multi-row wrap. Wrapping at narrow
   viewports steals vertical space from the 3-column grid below it and made
   the layout feel cramped/overlapping at 80% browser zoom. */
.topo-tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  border-bottom: 1px solid var(--border, #444);
  padding-bottom: 4px;
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.topo-tabs::-webkit-scrollbar { height: 6px; }
.topo-tabs::-webkit-scrollbar-thumb { background: var(--border, #444); border-radius: 3px; }
.topo-tab {
  padding: 5px 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted, #888);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.85rem;
  border-radius: 4px 4px 0 0;
  transition: background-color 120ms, color 120ms;
  white-space: nowrap;
  flex-shrink: 0;
}
.topo-tab:hover { color: var(--fg, #ccc); background: var(--bg-hover, rgba(255,255,255,0.04)); }
.topo-tab--active {
  color: var(--accent, #69c);
  background: var(--bg-card, rgba(255,255,255,0.06));
  border-color: var(--border, #444);
  border-bottom-color: var(--bg-card, rgba(255,255,255,0.06));
}

/* 3-column grid — equal-width thirds, each scrolls independently */
.topo-grid {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 1200px) {
  .topo-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .topo-col--state { display: none; }
}
@media (max-width: 800px) {
  .topo-grid { grid-template-columns: minmax(0, 1fr); }
  .topo-col--setup, .topo-col--stream { min-height: 0; }
}

.topo-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;       /* allow grid track to shrink below intrinsic content */
  gap: 10px;
  overflow: hidden;
}

.topo-panel {
  background: var(--bg-card, rgba(255,255,255,0.04));
  border: 1px solid var(--border, #444);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;       /* same — keep wide pre/JSON content inside the panel */
  overflow: hidden;
}
.topo-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-shrink: 0;
}
.topo-panel-head h2 { margin: 0; font-size: 1rem; flex: 1; }
.topo-panel-head strong { font-size: 0.85rem; }
.topo-key-tag {
  font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace;
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(120, 162, 247, 0.15);
  color: var(--accent, #7aa2f7);
}
.topo-mute { color: var(--fg-muted, #888); font-size: 0.75rem; margin-left: auto; }

/* Setup column.
   Column itself doesn't scroll — its two children share the height. The
   meta panel takes whatever's left and scrolls internally; the config panel
   anchors at the bottom with a min-height so the JSON editor + Run button
   stay reachable on short / zoomed-out viewports. */
.topo-col--setup { overflow: hidden; }
.topo-col--setup > .topo-panel:first-child {
  flex: 1 1 auto;
  min-height: 120px;
  overflow-y: auto;
}
.topo-desc { margin: 2px 0 8px; font-size: 0.85rem; line-height: 1.4; }
.topo-col--setup details { margin-top: 4px; }
.topo-col--setup summary {
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--fg-muted, #888);
  padding: 4px 0;
  user-select: none;
}
.topo-col--setup summary:hover { color: var(--fg, #ccc); }
.topo-bullets { margin: 4px 0 0 16px; padding: 0; }
.topo-bullets li { margin: 2px 0; font-size: 0.82rem; line-height: 1.35; }

.topo-diagram {
  font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace;
  font-size: 0.74rem;
  line-height: 1.3;
  background: rgba(0,0,0,0.25);
  padding: 8px 10px;
  border-radius: 4px;
  margin: 4px 0 0;
  white-space: pre;
  overflow-x: auto;
  max-width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border, #444);
}

.topo-options {
  width: 100%;
  font-size: 0.75rem;
  border-collapse: collapse;
  margin-top: 4px;
}
.topo-options th, .topo-options td {
  border-bottom: 1px solid var(--border, #444);
  text-align: left;
  padding: 3px 6px;
}
.topo-options th { color: var(--fg-muted, #888); font-weight: 600; }
.topo-range { color: var(--fg-muted, #888); }
.topo-options-hint { font-size: 0.7rem; color: var(--fg-muted, #888); margin: 4px 0 0; }

/* Config panel — anchored at the bottom of the setup column with a tight
   min-height so it never disappears when the meta panel grows. */
.topo-panel--config { flex: 0 0 auto; min-height: 220px; max-height: 55%; }
.topo-config-textarea {
  flex: 1;
  width: 100%;
  min-height: 160px;
  font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace;
  font-size: 0.74rem;
  background: rgba(0,0,0,0.25);
  color: var(--fg, #ccc);
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  padding: 8px;
  resize: none;
  box-sizing: border-box;
}
.topo-config-textarea:disabled { opacity: 0.6; }
.topo-run-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
}

/* Buttons */
.topo-btn {
  padding: 4px 12px;
  font-size: 0.82rem;
  border-radius: 4px;
  border: 1px solid var(--border, #444);
  cursor: pointer;
  font-family: inherit;
  background: var(--bg, rgba(0,0,0,0.2));
  color: var(--fg, #ccc);
  transition: filter 120ms, transform 60ms;
}
.topo-btn:hover:not(:disabled) { filter: brightness(1.2); }
.topo-btn:active:not(:disabled) { transform: translateY(1px); }
.topo-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.topo-btn--ghost   { background: transparent; }
.topo-btn--primary { background: var(--accent, #69c); border-color: var(--accent, #69c); color: #fff; font-weight: 600; }
.topo-btn--danger  { background: var(--danger, #d33); border-color: var(--danger, #d33); color: #fff; font-weight: 600; }

.topo-status {
  font-size: 0.78rem;
  color: var(--fg-muted, #888);
  margin-left: auto;
}
.topo-status[data-status='running'] { color: var(--accent, #69c); animation: topo-pulse 1.4s infinite; }
.topo-status[data-status='done']    { color: var(--success, #0a0); }
.topo-status[data-status='error']   { color: var(--danger, #d33); }
.topo-status[data-status='aborted'] { color: var(--warning, #c80); }
@keyframes topo-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.topo-error {
  color: var(--danger, #d33);
  font-size: 0.78rem;
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(211, 51, 51, 0.08);
  border-radius: 4px;
}

/* ─── Stream column ──────────────────────────────────────────────────────── */
.topo-stream-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.topo-filter {
  flex: 1;
  min-width: 120px;
  padding: 4px 8px;
  font-size: 0.78rem;
  border-radius: 4px;
  border: 1px solid var(--border, #444);
  background: var(--bg, rgba(0,0,0,0.2));
  color: var(--fg, #ccc);
}
.topo-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--fg-muted, #888);
  cursor: pointer;
}

.topo-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.08));
  border: 1px solid var(--border, #444);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}
.topo-stream::-webkit-scrollbar { width: 8px; }
.topo-stream::-webkit-scrollbar-thumb { background: var(--border, #444); border-radius: 4px; }

.topo-empty {
  color: var(--fg-muted, #888);
  text-align: center;
  padding: 32px 16px;
  font-size: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.topo-empty--small { padding: 12px 8px; font-size: 0.78rem; }
.topo-empty-glyph { font-size: 2rem; opacity: 0.5; }

/* Feed items */
.feed { display: flex; flex-direction: column; }
.feed-icon { font-size: 0.95em; }
.feed-time {
  font-size: 0.7rem;
  color: var(--fg-muted, #888);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.feed-chip {
  display: inline-block;
  padding: 1px 7px;
  font-size: 0.7rem;
  font-weight: 600;
  border-radius: 999px;
  color: #0d1117;
  font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace;
}
.feed-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.feed-arrow { color: var(--fg-muted, #888); font-weight: 700; }
.feed-kind {
  font-size: 0.7rem;
  padding: 1px 6px;
  background: rgba(255,255,255,0.06);
  border-radius: 3px;
  color: var(--fg-muted, #aaa);
  font-family: ui-monospace, monospace;
}

.feed-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 6px;
}
.feed-phase-line { flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--accent, #69c), transparent); }
.feed-phase-label {
  font-size: 0.78rem;
  color: var(--accent, #69c);
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 10px;
  border: 1px solid var(--accent, #69c);
  border-radius: 999px;
  background: rgba(120, 162, 247, 0.08);
}

.feed-bubble {
  border-left: 3px solid var(--fg-muted, #666);
  padding: 6px 10px 8px;
  background: rgba(255,255,255,0.025);
  border-radius: 0 6px 6px 0;
}
.feed-bubble-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.feed-agent { font-size: 0.78rem; font-family: ui-monospace, monospace; }
.feed-bubble-text {
  font-size: 0.84rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg, #ddd);
}

.feed-bus {
  border: 1px solid rgba(224, 175, 104, 0.3);
  background: rgba(224, 175, 104, 0.04);
  border-radius: 6px;
  padding: 6px 10px;
}
.feed-bus-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.feed-bus-payload {
  margin: 6px 0 0;
  font-family: ui-monospace, monospace;
  font-size: 0.74rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg, #ccc);
  max-height: 200px;
  overflow-y: auto;
}

.feed-bb {
  border: 1px solid rgba(158, 206, 106, 0.3);
  background: rgba(158, 206, 106, 0.05);
  border-radius: 6px;
  padding: 6px 10px;
}
.feed-bb-head { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; flex-wrap: wrap; }
.feed-bb-key {
  font-size: 0.78rem;
  padding: 1px 6px;
  background: rgba(158, 206, 106, 0.15);
  border-radius: 3px;
  color: var(--success, #9ece6a);
}
.feed-bb-value {
  margin: 6px 0 0;
  font-family: ui-monospace, monospace;
  font-size: 0.74rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg, #ccc);
  max-height: 200px;
  overflow-y: auto;
}

.feed-spawn, .feed-tool, .feed-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.02);
  flex-wrap: wrap;
}
.feed-spawn--done { background: rgba(158, 206, 106, 0.06); }
.feed-tool--err { background: rgba(247, 118, 142, 0.08); }
.feed-tool--result { opacity: 0.85; }
.feed-tool-name {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  padding: 1px 6px;
  background: rgba(187, 154, 247, 0.12);
  border-radius: 3px;
  color: #bb9af7;
}
.feed-line {
  border-left: 3px solid var(--fg-muted, #666);
  border-radius: 0 4px 4px 0;
}
.feed-type {
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
  color: var(--fg-muted, #aaa);
}
.feed-details { width: 100%; flex-basis: 100%; margin-top: 2px; }
.feed-details summary {
  cursor: pointer;
  font-size: 0.7rem;
  color: var(--fg-muted, #888);
  padding: 2px 0;
}
.feed-details summary:hover { color: var(--fg, #ccc); }
.feed-details pre {
  margin: 4px 0 0;
  font-family: ui-monospace, monospace;
  font-size: 0.7rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg-muted, #aaa);
  background: rgba(0,0,0,0.3);
  padding: 6px 8px;
  border-radius: 3px;
  max-height: 280px;
  overflow-y: auto;
}

/* ─── State column ───────────────────────────────────────────────────────── */
.topo-col--state { overflow-y: auto; }
.topo-col--state .topo-panel { overflow: visible; flex-shrink: 0; }

.topo-panel--bb { background: linear-gradient(180deg, rgba(158,206,106,0.04), rgba(255,255,255,0.03)); }

.bb-grid { display: flex; flex-direction: column; gap: 6px; }
.bb-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border, #444);
  border-left: 3px solid var(--success, #9ece6a);
  border-radius: 4px;
  padding: 6px 8px;
  transition: background 120ms;
}
.bb-card:hover { background: rgba(255,255,255,0.06); }
.bb-card--open { background: rgba(158,206,106,0.05); }
.bb-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.bb-card-key {
  font-family: ui-monospace, monospace;
  font-size: 0.78rem;
  color: var(--success, #9ece6a);
  flex: 1;
  word-break: break-all;
}
.bb-card-meta { display: flex; gap: 4px; align-items: center; }
.bb-version {
  font-size: 0.65rem;
  padding: 1px 5px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  color: var(--fg-muted, #888);
  font-variant-numeric: tabular-nums;
}
.bb-card-value {
  margin: 4px 0 0;
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fg, #ccc);
  max-height: 160px;
  overflow-y: auto;
  background: rgba(0,0,0,0.2);
  padding: 4px 6px;
  border-radius: 3px;
}
.bb-card-history { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border, #444); }
.bb-history-label { font-size: 0.7rem; color: var(--fg-muted, #888); margin-bottom: 4px; }
.bb-history-item { margin-bottom: 6px; }
.bb-history-meta { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }

/* Agent cards */
.agent-grid { display: flex; flex-direction: column; gap: 6px; }
.agent-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border, #444);
  border-left: 3px solid var(--fg-muted, #666);
  border-radius: 4px;
  padding: 6px 8px;
  transition: background 120ms;
}
.agent-card:hover { background: rgba(255,255,255,0.05); }
.agent-card--running { background: rgba(120, 162, 247, 0.06); }
.agent-card--done    { background: rgba(158, 206, 106, 0.05); }
.agent-card--error   { background: rgba(247, 118, 142, 0.07); }

.agent-head { display: flex; align-items: center; gap: 6px; }
.agent-id { font-family: ui-monospace, monospace; font-size: 0.78rem; flex: 1; }
.agent-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted, #666);
}
.agent-status[data-s='running'] { background: var(--accent, #7aa2f7); animation: topo-pulse 1.4s infinite; }
.agent-status[data-s='done']    { background: var(--success, #9ece6a); }
.agent-status[data-s='error']   { background: var(--danger, #f7768e); }

.agent-meta {
  display: flex;
  gap: 6px;
  margin-top: 3px;
  flex-wrap: wrap;
}
.agent-role, .agent-model {
  font-size: 0.7rem;
  padding: 1px 5px;
  background: rgba(255,255,255,0.05);
  border-radius: 3px;
  color: var(--fg-muted, #aaa);
}
.agent-stats {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  font-size: 0.7rem;
  color: var(--fg-muted, #888);
  font-variant-numeric: tabular-nums;
}
.agent-last {
  margin-top: 6px;
  font-size: 0.72rem;
  color: var(--fg-muted, #aaa);
  font-style: italic;
  line-height: 1.35;
  max-height: 3.6em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  border-top: 1px dashed var(--border, #444);
  padding-top: 4px;
}

/* Bus list */
.bus-list { display: flex; flex-direction: column; gap: 3px; max-height: 240px; overflow-y: auto; }
.bus-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  padding: 3px 4px;
  border-radius: 3px;
}
.bus-row:hover { background: rgba(255,255,255,0.04); }
</style>
