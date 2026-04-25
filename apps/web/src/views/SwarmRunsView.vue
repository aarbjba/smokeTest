<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useSwarmRunsStore } from '../stores/swarmRuns';
import { api } from '../api';
import type { SwarmRunMeta } from '../types';
import { SWARM_RUN_STATUS_LABELS, SWARM_RUN_STATUS_COLOR } from '../types';

const router = useRouter();
const route = useRoute();
const store = useSwarmRunsStore();

// Active run streaming state
const activeRunEvents = ref<Array<{ type: string; data: unknown; ts: number }>>([]);
const activeRunId = ref<string | null>(null);
const activeRunStatus = ref<'running' | 'done' | 'error' | 'aborted' | null>(null);
const activeRunError = ref<string | null>(null);
let activeEvtSource: EventSource | null = null;
const activeRunEventsEl = ref<HTMLDivElement | null>(null);

const runConfigId = computed(() => {
  const q = route.query.run;
  return q ? Number(q) : null;
});

onMounted(async () => {
  await Promise.all([store.fetchRuns(), store.fetchConfigs()]);
  // Auto-start run if ?run=configId was passed (e.g. from architect view)
  if (runConfigId.value) {
    startRun(runConfigId.value);
  }
});

onUnmounted(() => {
  if (activeEvtSource) { activeEvtSource.close(); activeEvtSource = null; }
});

function formatDate(s: string | null | undefined) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function startRun(configId: number) {
  // Close any existing stream
  if (activeEvtSource) { activeEvtSource.close(); activeEvtSource = null; }
  activeRunEvents.value = [];
  activeRunId.value = null;
  activeRunStatus.value = 'running';
  activeRunError.value = null;

  const url = api.swarm.runs.runFromConfigUrl(configId);
  activeEvtSource = new EventSource(url);

  activeEvtSource.onmessage = () => { /* handled by named events */ };

  // Forward all named events into the log
  const genericHandler = (evtName: string) => (e: MessageEvent) => {
    let data: unknown;
    try { data = JSON.parse(e.data); } catch { data = e.data; }
    activeRunEvents.value.push({ type: evtName, data, ts: Date.now() });
    if (activeRunEventsEl.value) {
      activeRunEventsEl.value.scrollTop = activeRunEventsEl.value.scrollHeight;
    }
  };

  const eventTypes = [
    'swarm_start', 'swarm_end', 'agent_start', 'agent_end', 'agent_turn',
    'tool_use', 'tool_result', 'blackboard_write', 'bus_send', 'bus_deliver',
    'progress', 'terminate', 'token_update', 'error',
  ];

  for (const t of eventTypes) {
    activeEvtSource.addEventListener(t, genericHandler(t));
  }

  activeEvtSource.addEventListener('swarm_end', (e: MessageEvent) => {
    const d = JSON.parse(e.data) as { runId?: string; status?: string };
    activeRunId.value = d.runId ?? null;
    activeRunStatus.value = (d.status as SwarmRunMeta['status']) ?? 'done';
    activeEvtSource?.close();
    activeEvtSource = null;
    store.fetchRuns();
  });

  activeEvtSource.addEventListener('error', (e: MessageEvent) => {
    let d: { message?: string } = {};
    try { d = JSON.parse(e.data); } catch { /* ignore */ }
    activeRunError.value = d.message ?? 'Unbekannter Fehler';
    activeRunStatus.value = 'error';
    activeEvtSource?.close();
    activeEvtSource = null;
  });

  activeEvtSource.onerror = () => {
    if (activeRunStatus.value === 'running') {
      activeRunStatus.value = 'error';
      activeRunError.value = 'Verbindung unterbrochen';
    }
  };
}

async function deleteConfig(id: number, e: Event) {
  e.stopPropagation();
  if (!confirm('Konfiguration wirklich löschen?')) return;
  await store.deleteConfig(id);
}

function openReplay(runId: string) {
  router.push({ name: 'swarm-replay', params: { id: runId } });
}

function eventLabel(type: string): string {
  const map: Record<string, string> = {
    swarm_start: '▶ Swarm gestartet',
    swarm_end: '■ Swarm beendet',
    agent_start: '→ Agent gestartet',
    agent_end: '← Agent fertig',
    agent_turn: '💬 Turn',
    tool_use: '🔧 Tool',
    blackboard_write: '📝 Blackboard',
    bus_send: '📨 Bus senden',
    bus_deliver: '📬 Bus geliefert',
    progress: '⏳ Fortschritt',
    terminate: '🛑 Terminieren',
    token_update: '🪙 Token',
    error: '❌ Fehler',
  };
  return map[type] ?? type;
}
</script>

<template>
  <div class="swarm-runs">
    <header class="sr-header">
      <h1>⚡ Swarm</h1>
      <div class="sr-header-actions">
        <button class="ghost" @click="store.fetchRuns(); store.fetchConfigs()">⟳ Neu laden</button>
        <button class="primary" @click="router.push({ name: 'swarm-architect' })">
          🏗 Neuer Architekt
        </button>
      </div>
    </header>

    <div v-if="store.error" class="error-banner">{{ store.error }}</div>

    <div class="sr-layout">
      <!-- Saved configs -->
      <aside class="sr-sidebar">
        <h2 class="sr-section-title">Konfigurationen</h2>
        <div v-if="store.loadingConfigs" class="sr-empty">Lade…</div>
        <div v-else-if="store.configs.length === 0" class="sr-empty">
          Keine Konfigurationen. Starte den Architekten, um eine zu erstellen.
        </div>
        <ul v-else class="sr-config-list">
          <li v-for="c in store.configs" :key="c.id" class="sr-config-card">
            <div class="sr-config-info">
              <span class="sr-config-name">{{ c.name || `Config #${c.id}` }}</span>
              <span class="sr-config-goal">{{ c.goal }}</span>
            </div>
            <div class="sr-config-actions">
              <button class="primary small" @click="startRun(c.id)">▶ Starten</button>
              <button class="ghost small danger" @click="deleteConfig(c.id, $event)">✕</button>
            </div>
          </li>
        </ul>
      </aside>

      <!-- Main area -->
      <main class="sr-main">
        <!-- Active run stream -->
        <section v-if="activeRunStatus" class="sr-active-run">
          <div class="sr-active-header">
            <span class="sr-active-title">Aktueller Lauf</span>
            <span
              class="sr-status-badge"
              :style="{ color: `var(${SWARM_RUN_STATUS_COLOR[activeRunStatus ?? 'running']})` }"
            >
              {{ SWARM_RUN_STATUS_LABELS[activeRunStatus ?? 'running'] }}
            </span>
            <span v-if="activeRunId" class="sr-run-id">{{ activeRunId }}</span>
          </div>
          <div v-if="activeRunError" class="error-banner">{{ activeRunError }}</div>
          <div ref="activeRunEventsEl" class="sr-event-log">
            <div v-for="(ev, i) in activeRunEvents" :key="i" class="sr-event-row">
              <span class="sr-event-type">{{ eventLabel(ev.type) }}</span>
              <span class="sr-event-data">{{ JSON.stringify(ev.data).slice(0, 120) }}</span>
            </div>
            <div v-if="activeRunStatus === 'running'" class="sr-event-running">
              <span class="sr-dot" /><span class="sr-dot" /><span class="sr-dot" />
            </div>
          </div>
          <div v-if="activeRunId && activeRunStatus !== 'running'" class="sr-active-footer">
            <button class="ghost" @click="openReplay(activeRunId)">
              Replay ansehen →
            </button>
          </div>
        </section>

        <!-- Runs list -->
        <section class="sr-runs-section">
          <h2 class="sr-section-title">Letzte Läufe</h2>
          <div v-if="store.loadingRuns" class="sr-empty">Lade…</div>
          <div v-else-if="store.runs.length === 0" class="sr-empty">
            Noch keine Läufe. Starte eine Konfiguration.
          </div>
          <table v-else class="sr-runs-table">
            <thead>
              <tr>
                <th>Ziel</th>
                <th>Status</th>
                <th>Agents</th>
                <th>Token</th>
                <th>Gestartet</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in store.runs" :key="r.id" class="sr-run-row">
                <td class="sr-run-goal">{{ r.goal }}</td>
                <td>
                  <span
                    class="sr-status-badge"
                    :style="{ color: `var(${SWARM_RUN_STATUS_COLOR[r.status]})` }"
                  >{{ SWARM_RUN_STATUS_LABELS[r.status] }}</span>
                </td>
                <td class="sr-run-num">{{ r.coordinator_count }}</td>
                <td class="sr-run-num">{{ formatTokens(r.total_tokens) }}</td>
                <td class="sr-run-date">{{ formatDate(r.started_at) }}</td>
                <td>
                  <button class="ghost small" @click="openReplay(r.id)">Replay</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.swarm-runs {
  max-width: 100%;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.sr-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.sr-header h1 {
  margin: 0;
  font-size: 1.2rem;
}

.sr-header-actions {
  display: flex;
  gap: 0.5rem;
}

.sr-layout {
  display: grid;
  grid-template-columns: 18rem 1fr;
  gap: 0.75rem;
  align-items: start;
}

.sr-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.75rem;
}

.sr-section-title {
  margin: 0 0 0.3rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--fg-muted);
}

.sr-empty {
  color: var(--fg-muted);
  font-size: 0.85rem;
  font-style: italic;
  padding: 0.5rem 0;
}

.sr-config-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sr-config-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 0.55rem 0.65rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}

.sr-config-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.sr-config-name {
  font-size: 0.88rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-config-goal {
  font-size: 0.78rem;
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-config-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}

button.small {
  font-size: 0.78rem;
  padding: 0.15rem 0.45rem;
}

button.danger {
  color: var(--danger);
}

.sr-main {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.sr-active-run {
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sr-active-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.sr-active-title {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}

.sr-run-id {
  font-size: 0.72rem;
  font-family: var(--font-mono);
  color: var(--fg-muted);
}

.sr-event-log {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem;
  max-height: 18rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.sr-event-row {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
}

.sr-event-type {
  color: var(--accent);
  white-space: nowrap;
  min-width: 10rem;
}

.sr-event-data {
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-event-running {
  display: flex;
  gap: 0.25rem;
  padding: 0.2rem 0;
}

.sr-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: blink 1.2s infinite;
  display: inline-block;
}
.sr-dot:nth-child(2) { animation-delay: 0.2s; }
.sr-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.sr-active-footer {
  display: flex;
  justify-content: flex-end;
}

.sr-runs-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.75rem;
}

.sr-runs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.sr-runs-table th {
  text-align: left;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--border);
}

.sr-run-row td {
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  vertical-align: middle;
}

.sr-run-goal {
  max-width: 20rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-status-badge {
  font-size: 0.78rem;
  font-weight: 600;
}

.sr-run-num {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  text-align: right;
}

.sr-run-date {
  font-size: 0.78rem;
  color: var(--fg-muted);
  white-space: nowrap;
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
