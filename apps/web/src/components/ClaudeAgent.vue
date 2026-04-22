<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Todo, Attachment } from '../types';
import { api, type AgentSession } from '../api';

const ATTACHMENT_KIND_ICON: Record<string, string> = {
  image: '🖼',
  video: '🎞',
  audio: '🔊',
  pdf: '📄',
  text: '📝',
  archive: '🗜',
  office: '📊',
  other: '📎',
};

const props = defineProps<{ todo: Todo }>();
const emit = defineEmits<{
  (e: 'active', value: boolean): void;
}>();

// Working directory is owned by the parent ("Aktuelle Aufgabe" card in
// TodoDetailView.vue). We still load the default setting so effectiveCwd can
// fall back when the todo has no explicit working_directory.
const defaultCwd = ref<string>('');
const prompt = ref<string>(buildDefaultPrompt(props.todo));
const followup = ref<string>('');
const session = ref<AgentSession | null>(null);
const output = ref<string>('');
const error = ref<string | null>(null);
const outputEl = ref<HTMLPreElement | null>(null);

// Attachments for the current todo + the IDs the user has opted to hand over
// to Claude for the next turn. Sticky across sends — user unchecks what they
// don't want.
const attachments = ref<Attachment[]>([]);
const selectedAttachmentIds = ref<Set<number>>(new Set());

// Prior analyse-mode outputs saved on this todo. When analysisCount > 0 the
// panel shows a checkbox that injects them into the preprompt of the next
// work-mode session.
const analysisCount = ref<number>(0);
const includeAnalyses = ref<boolean>(false);

let eventSource: EventSource | null = null;

const running = computed(() => session.value?.status === 'running');
const turnActive = computed(() => !!session.value?.turnActive);
const hasOutput = computed(() => output.value.length > 0);
const hasSessionId = computed(() => !!session.value?.sessionId);
const turnCount = computed(() => session.value?.turns?.length ?? 0);
const active = computed(() => running.value || hasOutput.value || hasSessionId.value);

const effectiveCwd = computed(() => ((props.todo.working_directory ?? '') || defaultCwd.value || '').trim());
const canRun = computed(() => !running.value && effectiveCwd.value.length > 0 && prompt.value.trim().length > 0);
const canSend = computed(() => running.value && !turnActive.value && followup.value.trim().length > 0);

function buildDefaultPrompt(todo: Todo): string {
  const parts: string[] = [];
  parts.push(`Task: ${todo.title}`);
  if (todo.description && todo.description.trim()) {
    parts.push('');
    parts.push('Description:');
    parts.push(todo.description.trim());
  }
  if (todo.source_url) {
    parts.push('');
    parts.push(`Source: ${todo.source_url}`);
  }
  parts.push('');
  parts.push('Please help me complete this.');
  return parts.join('\n');
}

function scrollOutputToEnd() {
  nextTick(() => {
    if (outputEl.value) outputEl.value.scrollTop = outputEl.value.scrollHeight;
  });
}

function subscribe() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(api.agent.streamUrl(props.todo.id));

  eventSource.addEventListener('snapshot', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AgentSession | null;
    session.value = data;
    output.value = data?.output ?? '';
    if (data && data.prompt) prompt.value = data.prompt;
    scrollOutputToEnd();
  });

  eventSource.addEventListener('chunk', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as { text: string };
    output.value += data.text;
    scrollOutputToEnd();
  });

  eventSource.addEventListener('end', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AgentSession;
    session.value = data;
    output.value = data.output;
    scrollOutputToEnd();
  });

  eventSource.addEventListener('turn-end', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AgentSession;
    session.value = data;
    scrollOutputToEnd();
    // Pick up attachments that were uploaded while Claude was thinking so the
    // user can include them in the next send, plus any analyses a just-finished
    // analyse-mode turn persisted.
    void loadAttachments();
    void loadAnalysisCount();
  });

  eventSource.addEventListener('cleared', () => {
    session.value = null;
    output.value = '';
    followup.value = '';
  });

  eventSource.onerror = () => {
    /* auto-retry */
  };
}

function unsubscribe() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function loadAttachments() {
  try {
    const rows = await api.attachments.byTodo(props.todo.id);
    attachments.value = rows;
    // Default selection: everything selected BEFORE first start, so the user
    // just hits "Run Claude" and all current files are handed over. After the
    // first turn the selection is sticky — new uploads stay unchecked until
    // the user opts them in.
    if (!session.value) {
      selectedAttachmentIds.value = new Set(rows.map((a) => a.id));
    } else {
      // Drop IDs that no longer exist (e.g. attachment deleted mid-session).
      const existing = new Set(rows.map((a) => a.id));
      selectedAttachmentIds.value = new Set(
        [...selectedAttachmentIds.value].filter((id) => existing.has(id)),
      );
    }
  } catch {
    /* non-fatal — agent still works without attachments */
  }
}

function toggleAttachment(id: number) {
  const s = new Set(selectedAttachmentIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedAttachmentIds.value = s;
}

function selectAllAttachments() {
  selectedAttachmentIds.value = new Set(attachments.value.map((a) => a.id));
}
function clearAttachmentSelection() {
  selectedAttachmentIds.value = new Set();
}

const selectedCount = computed(() => selectedAttachmentIds.value.size);

async function loadAnalysisCount() {
  try {
    const rows = await api.analyses.byTodo(props.todo.id);
    analysisCount.value = rows.length;
    // Default on when analyses exist — freshly relevant context. Only seed the
    // default before the user interacts; once they toggle it we respect their choice.
    if (rows.length > 0 && !session.value) includeAnalyses.value = true;
    if (rows.length === 0) includeAnalyses.value = false;
  } catch {
    /* non-fatal */
  }
}

onMounted(async () => {
  try {
    const settings = await api.settings.getAll();
    defaultCwd.value = (settings.defaultWorkingDirectory as string) ?? '';
  } catch { /* ignore */ }
  subscribe();
  await loadAttachments();
  await loadAnalysisCount();
});

onUnmounted(unsubscribe);

watch(() => props.todo.id, () => {
  prompt.value = buildDefaultPrompt(props.todo);
  followup.value = '';
  output.value = '';
  session.value = null;
  error.value = null;
  attachments.value = [];
  selectedAttachmentIds.value = new Set();
  analysisCount.value = 0;
  includeAnalyses.value = false;
  unsubscribe();
  subscribe();
  void loadAttachments();
  void loadAnalysisCount();
});

watch(active, (v) => emit('active', v));

async function run() {
  if (!canRun.value) return;
  error.value = null;
  try {
    output.value = '';
    const ids = [...selectedAttachmentIds.value];
    const res = await api.agent.start(props.todo.id, prompt.value, effectiveCwd.value, ids, 'work', includeAnalyses.value);
    session.value = res.session;
    output.value = res.session.output ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function runAnalyse() {
  if (running.value || !effectiveCwd.value) return;
  error.value = null;
  try {
    output.value = '';
    const ids = [...selectedAttachmentIds.value];
    // Analyse mode ignores the user prompt — the preprompt is the instruction.
    // We still send a non-empty placeholder because the API requires prompt.min(1).
    const placeholder = `Analyse der Aufgabe "${props.todo.title}"`;
    const res = await api.agent.start(props.todo.id, placeholder, effectiveCwd.value, ids, 'analyse');
    session.value = res.session;
    output.value = res.session.output ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function send() {
  if (!canSend.value) return;
  error.value = null;
  const msg = followup.value;
  followup.value = '';
  try {
    const ids = [...selectedAttachmentIds.value];
    const res = await api.agent.send(props.todo.id, msg, ids);
    session.value = res.session;
    output.value = res.session.output ?? output.value;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    followup.value = msg;
  }
}

async function stop() {
  try {
    const res = await api.agent.stop(props.todo.id);
    session.value = res.session;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function clearSession() {
  try {
    await api.agent.clear(props.todo.id);
    session.value = null;
    output.value = '';
    followup.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function copyOutput() {
  navigator.clipboard.writeText(output.value).catch(() => {});
}

async function saveAsSnippet() {
  if (!output.value.trim()) return;
  await api.snippets.create(props.todo.id, {
    title: `Claude run (${new Date().toLocaleTimeString()})`,
    language: 'markdown',
    content: output.value,
  });
}

function onFollowupKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void send();
  }
}

const statusBadge = computed(() => {
  if (!session.value) return null;
  if (session.value.status === 'running') {
    if (session.value.turnActive) return { text: '● denkt…', cls: 'status-running' };
    return { text: '● bereit', cls: 'status-ready' };
  }
  if (session.value.status === 'error') return { text: '● Fehler', cls: 'status-error' };
  return { text: `● exit ${session.value.exitCode ?? '?'}`, cls: 'status-exited' };
});
</script>

<template>
  <div class="claude-agent">
    <div class="row" style="align-items: baseline; justify-content: space-between; gap: 0.75rem;">
      <h3 style="margin: 0;">🤖 Claude Agent</h3>
      <div class="row" style="gap: 0.5rem; align-items: baseline;">
        <span v-if="turnCount > 1" class="shortcut-hint" style="font-size: 0.78rem; color: var(--fg-muted);">
          {{ turnCount }} Turns
        </span>
        <span v-if="statusBadge" class="agent-badge" :class="statusBadge.cls">{{ statusBadge.text }}</span>
        <span v-else class="shortcut-hint" style="color: var(--fg-muted); font-size: 0.8rem;">
          Spawnt <kbd>claude -p …</kbd> im Arbeitsverzeichnis
        </span>
      </div>
    </div>

    <div v-if="!effectiveCwd" class="error-banner" style="margin-top: 0.75rem;">
      Kein Arbeitsverzeichnis gesetzt — oben am Todo hinterlegen oder einen Standard speichern.
    </div>

    <div v-if="attachments.length > 0" class="agent-attachments" style="margin-top: 0.75rem;">
      <div class="row" style="align-items: baseline; justify-content: space-between; gap: 0.5rem;">
        <span style="font-size: 0.85rem;">
          📎 Anhänge für Claude
          <span style="color: var(--fg-muted); font-weight: normal;">
            ({{ selectedCount }}/{{ attachments.length }} ausgewählt)
          </span>
        </span>
        <div class="row" style="gap: 0.4rem;">
          <button class="ghost" type="button" @click="selectAllAttachments" :disabled="selectedCount === attachments.length" style="font-size: 0.75rem;">Alle</button>
          <button class="ghost" type="button" @click="clearAttachmentSelection" :disabled="selectedCount === 0" style="font-size: 0.75rem;">Keine</button>
        </div>
      </div>
      <ul class="agent-attachment-list" style="list-style: none; margin: 0.4rem 0 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem;">
        <li
          v-for="a in attachments"
          :key="a.id"
          class="agent-attachment-item"
          :class="{ selected: selectedAttachmentIds.has(a.id) }"
        >
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.25rem 0.4rem; border-radius: 4px;">
            <input
              type="checkbox"
              :checked="selectedAttachmentIds.has(a.id)"
              @change="toggleAttachment(a.id)"
            />
            <span aria-hidden="true">{{ ATTACHMENT_KIND_ICON[a.kind] ?? '📎' }}</span>
            <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 0.82rem;">{{ a.filename }}</span>
            <span style="color: var(--fg-muted); font-size: 0.72rem; font-family: var(--font-mono);">{{ a.mime || '—' }}</span>
          </label>
        </li>
      </ul>
    </div>

    <label
      v-if="analysisCount > 0 && !running && turnCount === 0"
      class="row"
      style="margin-top: 0.75rem; align-items: baseline; gap: 0.5rem; cursor: pointer;"
    >
      <input type="checkbox" v-model="includeAnalyses" />
      <span style="font-size: 0.9rem;">
        🔍 Bisherige Analysen einbeziehen
        <span style="color: var(--fg-muted); font-weight: normal; font-size: 0.8rem;">
          ({{ analysisCount }} gespeichert — werden als Kontext in den Preprompt geladen)
        </span>
      </span>
    </label>

    <label v-if="!running && turnCount === 0" class="stacked" style="margin-top: 0.75rem;">
      <span>Erste Nachricht</span>
      <textarea v-model="prompt" rows="6" spellcheck="false" />
    </label>

    <div class="row" style="margin-top: 0.75rem; gap: 0.4rem; flex-wrap: wrap;">
      <button v-if="!running && turnCount === 0" class="primary" :disabled="!canRun" @click="run">
        ▶ Run Claude
      </button>
      <button
        v-if="!running && turnCount === 0"
        class="ghost"
        :disabled="running || !effectiveCwd"
        @click="runAnalyse"
        title="Analyse-Modus: Claude liest die Aufgabe, schreibt eine Analyse und schlägt Subtasks vor. Setzt nichts um."
      >
        🔍 Analyse starten
      </button>
      <button v-if="running" class="danger" @click="stop" title="Prozess sofort beenden">■ Stop</button>
      <button class="ghost" :disabled="!output" @click="copyOutput">📋 Copy</button>
      <button class="ghost" :disabled="!output || turnActive" @click="saveAsSnippet">💾 Als Snippet</button>
      <button class="ghost" :disabled="!session" @click="clearSession" title="Session verwerfen und neu starten">✕ Clear</button>
    </div>

    <div v-if="error" class="error-banner" style="margin-top: 0.5rem;">{{ error }}</div>

    <pre ref="outputEl" class="agent-output" v-if="output || running">{{ output || '(warte auf Output…)' }}</pre>

    <div v-if="running" class="claude-chat" style="margin-top: 0.75rem;">
      <label class="stacked">
        <span>
          Nachricht an Claude
          <span style="color: var(--fg-muted); font-weight: normal;">
            (Ctrl+Enter sendet — <code>TERMINATE</code> beendet die Session)
          </span>
        </span>
        <textarea
          v-model="followup"
          rows="3"
          spellcheck="false"
          :disabled="turnActive"
          placeholder="Antworte, stelle Rückfrage, gib nächste Anweisung… oder TERMINATE"
          @keydown="onFollowupKeydown"
        />
      </label>
      <div class="row" style="margin-top: 0.4rem; gap: 0.4rem; align-items: baseline;">
        <button class="primary" :disabled="!canSend" @click="send">
          ➤ Senden
        </button>
        <span v-if="session?.sessionId" class="shortcut-hint" style="color: var(--fg-muted); font-size: 0.75rem;">
          Session: <code>{{ session.sessionId.slice(0, 8) }}…</code>
        </span>
      </div>
    </div>
  </div>
</template>
