<script setup lang="ts">
import { ref, nextTick, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSwarmArchitectStore } from '../stores/swarmArchitect';
import { useSwarmRunsStore } from '../stores/swarmRuns';

const router = useRouter();
const store = useSwarmArchitectStore();
const runsStore = useSwarmRunsStore();

const goalInput = ref('');
const messageInput = ref('');
const messagesEl = ref<HTMLDivElement | null>(null);

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  });
}

watch(() => store.messages.length, scrollToBottom);
watch(() => store.messages[store.messages.length - 1]?.content, scrollToBottom);

async function startSession() {
  await store.start(goalInput.value.trim() || undefined);
}

async function sendMessage() {
  const msg = messageInput.value.trim();
  if (!msg || store.streaming) return;
  messageInput.value = '';
  await store.send(msg);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// When finalize-config is detected, refetch configs to get the new id
watch(() => store.finalizedConfigId, async (v) => {
  if (v === -1) {
    await runsStore.fetchConfigs();
    // Pick the most recently created one
    const newest = runsStore.configs[0];
    if (newest) store.finalizedConfigId = newest.id;
  }
});

async function startRun() {
  if (!store.finalizedConfigId || store.finalizedConfigId < 0) return;
  router.push({ name: 'swarm-runs', query: { run: String(store.finalizedConfigId) } });
}

onUnmounted(() => {
  // Keep session alive — user may navigate back and continue chatting.
});
</script>

<template>
  <div class="swarm-architect">
    <header class="sa-header">
      <div class="sa-header-left">
        <button class="ghost sa-back" @click="router.push({ name: 'swarm-runs' })">← Zurück</button>
        <h1>🏗 Swarm Architekt</h1>
        <p class="sa-sub">Der Architekt-Agent interviewt dich und erstellt eine Swarm-Konfiguration.</p>
      </div>
      <div class="sa-header-right">
        <button v-if="store.isActive" class="ghost danger" @click="store.clear()">Sitzung beenden</button>
      </div>
    </header>

    <div v-if="store.error" class="error-banner">{{ store.error }}</div>

    <!-- Start screen -->
    <div v-if="!store.isActive" class="sa-start">
      <p class="sa-start-hint">
        Beschreibe dein Ziel (optional) — der Agent übernimmt dann das Interview.
      </p>
      <div class="sa-start-row">
        <input
          v-model="goalInput"
          class="sa-goal-input"
          placeholder="z.B. Analysiere das Repo und erstelle einen Refactoring-Plan"
          @keydown.enter="startSession"
        />
        <button class="primary" :disabled="store.loading" @click="startSession">
          {{ store.loading ? 'Starte…' : 'Starten' }}
        </button>
      </div>
    </div>

    <!-- Chat + preview layout -->
    <div v-else class="sa-workspace">
      <!-- Chat panel -->
      <div class="sa-chat">
        <div ref="messagesEl" class="sa-messages">
          <div
            v-for="(msg, i) in store.messages"
            :key="i"
            :class="['sa-msg', `sa-msg--${msg.role}`]"
          >
            <div class="sa-msg-role">{{ msg.role === 'user' ? 'Du' : 'Architekt' }}</div>
            <pre class="sa-msg-content">{{ msg.content }}</pre>
          </div>
          <div v-if="store.streaming && (!store.messages.length || store.messages[store.messages.length - 1]?.role === 'user')" class="sa-typing">
            <span class="sa-dot" />
            <span class="sa-dot" />
            <span class="sa-dot" />
          </div>
        </div>

        <div class="sa-input-row">
          <textarea
            v-model="messageInput"
            class="sa-textarea"
            placeholder="Antwort eingeben… (Enter zum Senden, Shift+Enter für Zeilenumbruch)"
            rows="3"
            :disabled="store.streaming"
            @keydown="onKeydown"
          />
          <button
            class="primary sa-send"
            :disabled="store.streaming || !messageInput.trim()"
            @click="sendMessage"
          >Senden</button>
        </div>
      </div>

      <!-- Preview panel -->
      <div class="sa-preview">
        <div class="sa-preview-header">
          <span class="sa-preview-title">Live-Vorschau</span>
          <span v-if="store.finalizedConfigId && store.finalizedConfigId > 0" class="sa-badge sa-badge--success">
            ✓ Gespeichert (#{{ store.finalizedConfigId }})
          </span>
        </div>

        <div v-if="!store.liveConfig" class="sa-preview-empty">
          Noch keine Konfiguration. Der Agent zeigt hier eine Vorschau, sobald er genug Infos hat.
        </div>
        <pre v-else class="sa-json">{{ JSON.stringify(store.liveConfig, null, 2) }}</pre>

        <div v-if="store.finalizedConfigId && store.finalizedConfigId > 0" class="sa-run-section">
          <p class="sa-run-hint">Konfiguration wurde gespeichert. Swarm jetzt starten?</p>
          <button class="primary" @click="startRun">▶ Swarm starten</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.swarm-architect {
  max-width: 100%;
  height: calc(100vh - 3rem);
  display: flex;
  flex-direction: column;
  padding: 0.75rem 1rem 0;
  gap: 0.5rem;
  overflow: hidden;
}

.sa-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-shrink: 0;
}

.sa-header-left {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.sa-header-left h1 {
  margin: 0;
  font-size: 1.2rem;
}

.sa-back {
  align-self: flex-start;
  font-size: 0.82rem;
  padding: 0.1rem 0.4rem;
}

.sa-sub {
  margin: 0;
  font-size: 0.82rem;
  color: var(--fg-muted);
}

.sa-start {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 2rem;
}

.sa-start-hint {
  color: var(--fg-muted);
  text-align: center;
  max-width: 50ch;
  margin: 0;
}

.sa-start-row {
  display: flex;
  gap: 0.6rem;
  width: 100%;
  max-width: 40rem;
}

.sa-goal-input {
  flex: 1;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--fg);
  font-family: var(--font);
  font-size: 0.9rem;
}

.sa-workspace {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  min-height: 0;
}

.sa-chat {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.75rem;
}

.sa-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 0;
}

.sa-msg {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.sa-msg-role {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}

.sa-msg--user .sa-msg-role { color: var(--accent); }
.sa-msg--assistant .sa-msg-role { color: var(--accent-2); }

.sa-msg-content {
  margin: 0;
  white-space: pre-wrap;
  font-family: var(--font);
  font-size: 0.88rem;
  line-height: 1.55;
}

.sa-typing {
  display: flex;
  gap: 0.3rem;
  align-items: center;
  padding: 0.2rem 0;
}

.sa-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-muted);
  animation: blink 1.2s infinite;
}
.sa-dot:nth-child(2) { animation-delay: 0.2s; }
.sa-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.sa-input-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
  flex-shrink: 0;
}

.sa-textarea {
  flex: 1;
  resize: none;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--fg);
  font-family: var(--font);
  font-size: 0.88rem;
  line-height: 1.5;
}

.sa-send {
  align-self: flex-end;
  white-space: nowrap;
}

.sa-preview {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.75rem;
}

.sa-preview-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
}

.sa-preview-title {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}

.sa-badge {
  font-size: 0.72rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
}

.sa-badge--success {
  background: color-mix(in srgb, var(--success) 20%, var(--bg-elev));
  color: var(--success);
  border: 1px solid var(--success);
}

.sa-preview-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  font-size: 0.85rem;
  text-align: center;
  font-style: italic;
  padding: 1.5rem;
}

.sa-json {
  flex: 1;
  overflow: auto;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre;
  min-height: 0;
}

.sa-run-section {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.sa-run-hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--fg-muted);
}

.error-banner {
  background: color-mix(in srgb, var(--danger) 15%, var(--bg-elev));
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  color: var(--danger);
  font-size: 0.85rem;
  flex-shrink: 0;
}

button.danger {
  color: var(--danger);
  border-color: var(--danger);
}
</style>
