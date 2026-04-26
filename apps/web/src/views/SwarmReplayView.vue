<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import type { SwarmRunMeta, SwarmAgentMeta, SwarmTokenSummary, SwarmBlackboardEntry, SwarmConfig } from '../types';
import { SWARM_RUN_STATUS_LABELS, SWARM_RUN_STATUS_COLOR } from '../types';

const router = useRouter();
const route = useRoute();

const runId = route.params.id as string;

const loading = ref(true);
const error = ref<string | null>(null);

type RunDetail = SwarmRunMeta & { config: SwarmConfig };
const run = ref<RunDetail | null>(null);
const agents = ref<SwarmAgentMeta[]>([]);
const tokenSummary = ref<SwarmTokenSummary[]>([]);
const eventCount = ref(0);
const blackboardKeyCount = ref(0);

const blackboardEntries = ref<SwarmBlackboardEntry[]>([]);
const bbLoading = ref(false);

// Replay state
const replayEvents = ref<Array<{ type: string; agentId?: string; _ts?: number; [k: string]: unknown }>>([]);
const replaying = ref(false);
const replayDone = ref(false);
const replaySpeed = ref(1);
let replayEvtSource: EventSource | null = null;
const replayEl = ref<HTMLDivElement | null>(null);

const totalTokens = computed(() =>
  tokenSummary.value.reduce((s, t) => s + t.total_input + t.total_output, 0),
);

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDate(s: string | number | null | undefined) {
  if (!s) return '—';
  const v = typeof s === 'number' ? new Date(s) : new Date(String(s).includes('T') ? s : s + 'Z');
  return v.toLocaleString();
}

async function loadDetail() {
  loading.value = true;
  error.value = null;
  try {
    const d = await api.swarm.runs.get(runId);
    run.value = d.run;
    agents.value = d.agents;
    tokenSummary.value = d.tokenSummary;
    eventCount.value = d.eventCount;
    blackboardKeyCount.value = d.blackboardKeyCount;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadBlackboard() {
  bbLoading.value = true;
  try {
    const d = await api.swarm.runs.blackboard(runId);
    blackboardEntries.value = d.entries;
  } catch { /* ignore */ } finally {
    bbLoading.value = false;
  }
}

function startReplay() {
  if (replayEvtSource) { replayEvtSource.close(); replayEvtSource = null; }
  replayEvents.value = [];
  replayDone.value = false;
  replaying.value = true;

  const url = api.swarm.runs.replayUrl(runId, replaySpeed.value);
  replayEvtSource = new EventSource(url);

  const push = (type: string, rawData: string) => {
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(rawData); } catch { d = { raw: rawData }; }
    replayEvents.value.push({ type, ...d });
    if (replayEl.value) {
      replayEl.value.scrollTop = replayEl.value.scrollHeight;
    }
  };

  replayEvtSource.onmessage = (e) => push('message', e.data);

  const eventNames = [
    'swarm:start', 'swarm:end', 'coordinator:start', 'coordinator:text',
    'coordinator:tool_call', 'coordinator:tool_result', 'coordinator:terminate',
    'coordinator:error', 'coordinator:end', 'subagent:spawn', 'subagent:complete',
    'blackboard:write', 'bus:message', 'progress', 'tokens', 'error',
    'topology:phase_change', 'replay_end',
  ];

  for (const n of eventNames) {
    replayEvtSource.addEventListener(n, (e: MessageEvent) => push(n, e.data));
  }

  replayEvtSource.addEventListener('replay_end', () => {
    replaying.value = false;
    replayDone.value = true;
    replayEvtSource?.close();
    replayEvtSource = null;
  });

  replayEvtSource.onerror = () => {
    replaying.value = false;
    replayEvtSource?.close();
    replayEvtSource = null;
  };
}

function stopReplay() {
  if (replayEvtSource) { replayEvtSource.close(); replayEvtSource = null; }
  replaying.value = false;
}

function eventColor(type: string): string {
  if (type.includes('error')) return 'var(--danger)';
  if (type === 'blackboard:write') return 'var(--success)';
  if (type.startsWith('bus:')) return 'var(--warning)';
  if (type.startsWith('coordinator:') || type.startsWith('subagent:')) return 'var(--accent-2)';
  if (type.includes('tool')) return 'var(--fg-muted)';
  return 'var(--accent)';
}

onMounted(async () => {
  await loadDetail();
  await loadBlackboard();
});

onUnmounted(() => {
  if (replayEvtSource) { replayEvtSource.close(); }
});
</script>

<template>
  <div class="swarm-replay">
    <header class="srep-header">
      <button class="ghost srep-back" @click="router.push({ name: 'swarm-runs' })">← Zurück</button>
      <div class="srep-title-row">
        <h1>🔁 Replay</h1>
        <code class="srep-run-id">{{ runId }}</code>
        <span
          v-if="run"
          class="srep-status"
          :style="{ color: `var(${SWARM_RUN_STATUS_COLOR[run.status]})` }"
        >{{ SWARM_RUN_STATUS_LABELS[run.status] }}</span>
      </div>
      <p v-if="run" class="srep-goal">{{ run.goal }}</p>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="srep-loading">Lade…</div>

    <div v-else-if="run" class="srep-layout">
      <!-- Left: metadata + blackboard -->
      <aside class="srep-sidebar">
        <!-- Stats -->
        <section class="srep-card">
          <h2 class="srep-card-title">Übersicht</h2>
          <dl class="srep-stats">
            <dt>Agents</dt><dd>{{ agents.length }}</dd>
            <dt>Events</dt><dd>{{ eventCount }}</dd>
            <dt>Token gesamt</dt><dd>{{ formatNum(totalTokens) }}</dd>
            <dt>Blackboard-Keys</dt><dd>{{ blackboardKeyCount }}</dd>
            <dt>Gestartet</dt><dd>{{ formatDate(run.started_at) }}</dd>
            <dt>Beendet</dt><dd>{{ formatDate(run.ended_at) }}</dd>
          </dl>
        </section>

        <!-- Agents -->
        <section class="srep-card">
          <h2 class="srep-card-title">Agents</h2>
          <div class="srep-agent-list">
            <div v-for="a in agents" :key="a.id" class="srep-agent-row">
              <span class="srep-agent-role">{{ a.role }}</span>
              <span class="srep-agent-model">{{ a.model }}</span>
              <span
                class="srep-agent-status"
                :style="{ color: a.status === 'done' ? 'var(--success)' : a.status === 'error' ? 'var(--danger)' : 'var(--accent)' }"
              >{{ a.status }}</span>
            </div>
          </div>
        </section>

        <!-- Token summary -->
        <section v-if="tokenSummary.length > 0" class="srep-card">
          <h2 class="srep-card-title">Token-Verteilung</h2>
          <table class="srep-token-table">
            <thead>
              <tr><th>Agent</th><th>In</th><th>Out</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in tokenSummary" :key="t.agent_id">
                <td class="srep-token-agent">{{ t.agent_id.split(':')[0] }}</td>
                <td class="srep-token-num">{{ formatNum(t.total_input) }}</td>
                <td class="srep-token-num">{{ formatNum(t.total_output) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- Blackboard -->
        <section class="srep-card srep-bb">
          <h2 class="srep-card-title">Blackboard ({{ blackboardEntries.length }})</h2>
          <div v-if="bbLoading" class="srep-empty">Lade…</div>
          <div v-else-if="blackboardEntries.length === 0" class="srep-empty">Leer</div>
          <div v-else class="srep-bb-list">
            <div v-for="e in blackboardEntries" :key="e.key" class="srep-bb-row">
              <span class="srep-bb-key">{{ e.key }}</span>
              <pre class="srep-bb-val">{{ e.value.slice(0, 200) }}{{ e.value.length > 200 ? '…' : '' }}</pre>
            </div>
          </div>
        </section>
      </aside>

      <!-- Right: replay player -->
      <main class="srep-main">
        <section class="srep-card srep-player">
          <div class="srep-player-header">
            <h2 class="srep-card-title">Event-Replay</h2>
            <div class="srep-player-controls">
              <label class="srep-speed-label">
                Geschwindigkeit
                <select v-model.number="replaySpeed" :disabled="replaying" class="srep-speed-select">
                  <option :value="0">Sofort</option>
                  <option :value="0.5">0.5×</option>
                  <option :value="1">1×</option>
                  <option :value="2">2×</option>
                  <option :value="5">5×</option>
                </select>
              </label>
              <button v-if="!replaying" class="primary" @click="startReplay">▶ Abspielen</button>
              <button v-else class="ghost" @click="stopReplay">■ Stop</button>
            </div>
          </div>

          <div ref="replayEl" class="srep-event-log">
            <div v-if="replayEvents.length === 0" class="srep-empty">
              Klicke „Abspielen", um die Events zu streamen.
            </div>
            <div v-for="(ev, i) in replayEvents" :key="i" class="srep-event-row">
              <span class="srep-ev-type" :style="{ color: eventColor(ev.type) }">{{ ev.type }}</span>
              <span v-if="ev.agentId" class="srep-ev-agent">{{ String(ev.agentId).split(':')[0] }}</span>
              <span class="srep-ev-data">{{ JSON.stringify(ev).slice(0, 160) }}</span>
            </div>
            <div v-if="replaying" class="srep-event-running">
              <span class="srep-dot" /><span class="srep-dot" /><span class="srep-dot" />
            </div>
            <div v-if="replayDone" class="srep-done">
              ✓ Replay abgeschlossen ({{ replayEvents.length }} Events)
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.swarm-replay {
  max-width: 100%;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.srep-header {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.srep-back {
  align-self: flex-start;
  font-size: 0.82rem;
  padding: 0.1rem 0.4rem;
}

.srep-title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.srep-title-row h1 { margin: 0; font-size: 1.2rem; }

.srep-run-id {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--fg-muted);
}

.srep-status { font-size: 0.85rem; font-weight: 600; }

.srep-goal {
  margin: 0;
  color: var(--fg-muted);
  font-size: 0.88rem;
}

.srep-loading {
  color: var(--fg-muted);
  font-style: italic;
  padding: 1rem 0;
}

.srep-layout {
  display: grid;
  grid-template-columns: 20rem 1fr;
  gap: 0.75rem;
  align-items: start;
}

.srep-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.srep-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.75rem;
}

.srep-card-title {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--fg-muted);
}

.srep-stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 0.75rem;
  font-size: 0.85rem;
  margin: 0;
}

.srep-stats dt { color: var(--fg-muted); }
.srep-stats dd { margin: 0; font-family: var(--font-mono); font-size: 0.82rem; }

.srep-agent-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.srep-agent-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.83rem;
}

.srep-agent-role { flex: 1; font-weight: 500; }
.srep-agent-model { font-size: 0.72rem; color: var(--fg-muted); font-family: var(--font-mono); }
.srep-agent-status { font-size: 0.78rem; font-weight: 600; }

.srep-token-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.srep-token-table th {
  text-align: left;
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--fg-muted);
  padding: 0.2rem 0.3rem;
  border-bottom: 1px solid var(--border);
}

.srep-token-table td {
  padding: 0.2rem 0.3rem;
}

.srep-token-agent {
  max-width: 7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srep-token-num {
  font-family: var(--font-mono);
  text-align: right;
}

.srep-bb {
  max-height: 20rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.srep-bb-list {
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.srep-bb-row {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.srep-bb-key {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--accent);
  font-weight: 600;
}

.srep-bb-val {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--fg-muted);
  white-space: pre-wrap;
  word-break: break-all;
}

.srep-empty {
  color: var(--fg-muted);
  font-size: 0.85rem;
  font-style: italic;
}

.srep-main {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.srep-player {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.srep-player-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
}

.srep-player-controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.srep-speed-label {
  font-size: 0.78rem;
  color: var(--fg-muted);
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.srep-speed-select {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--fg);
  font-size: 0.82rem;
}

.srep-event-log {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem;
  min-height: 12rem;
  max-height: calc(100vh - 16rem);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.srep-event-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.srep-ev-type {
  min-width: 9rem;
  font-weight: 600;
  white-space: nowrap;
}

.srep-ev-agent {
  color: var(--accent-2);
  white-space: nowrap;
  min-width: 5rem;
}

.srep-ev-data {
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srep-event-running {
  display: flex;
  gap: 0.25rem;
  padding: 0.3rem 0;
}

.srep-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: blink 1.2s infinite;
  display: inline-block;
}
.srep-dot:nth-child(2) { animation-delay: 0.2s; }
.srep-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.srep-done {
  color: var(--success);
  font-weight: 600;
  padding: 0.3rem 0;
}

.error-banner {
  background: color-mix(in srgb, var(--danger) 15%, var(--bg-elev));
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
