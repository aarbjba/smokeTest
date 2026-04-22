<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { marked } from 'marked';
import { api } from '../api';
import type { Todo, Snippet, TodoStatus, Analysis } from '../types';
import { STATUS_LABELS, STATUS_ICONS } from '../types';
import { useTodosStore } from '../stores/todos';
import { useQueueStore } from '../stores/queue';
import SnippetEditor from '../components/SnippetEditor.vue';
import SubtaskList from '../components/SubtaskList.vue';
import TodoPomodoro from '../components/TodoPomodoro.vue';
import AttachmentPanel from '../components/AttachmentPanel.vue';
import ClaudeAgent from '../components/ClaudeAgent.vue';
import GitBranchButton from '../components/GitBranchButton.vue';
import McpServersPanel from '../components/McpServersPanel.vue';
import { linkifyStackTraceInHtml } from '../utils/linkifyStackTrace';

const props = defineProps<{ id: string }>();
const router = useRouter();
const todos = useTodosStore();
const queueStore = useQueueStore();

const todo = ref<Todo | null>(null);
const snippets = ref<Snippet[]>([]);
const analyses = ref<Analysis[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const saving = ref(false);
const tagsText = ref('');
const agentActive = ref(false);

// Queue integration.
// queuedItem reflects this todo's entry in the automation queue (if any).
// While queued, the user can edit queue_prompt and the runner will pick it up.
// Once the runner starts a session, the queue row clears and status flips to
// 'in_progress' — at which point we LOCK the main editable fields.
const queuePromptDraft = ref('');
const queuedItem = computed(() =>
  todo.value ? queueStore.byTodoId(todo.value.id) : undefined,
);
const isQueued = computed(() => !!queuedItem.value);
const canEnqueue = computed(
  () => !!todo.value && todo.value.status === 'todo' && !isQueued.value,
);
// Lock edits once work has actually started (agent session live AND status
// already in_progress). Per the user's spec: editable while queued, read-only
// once being worked on.
const editLocked = computed(() => agentActive.value && todo.value?.status === 'in_progress');

const ANALYSES_POLL_MS = 5000;
let analysesPollHandle: ReturnType<typeof setInterval> | null = null;

async function loadAnalyses() {
  try {
    analyses.value = await api.analyses.byTodo(todoId.value);
  } catch {
    // Non-fatal — the rest of the detail page works without analyses.
  }
}

function startAnalysesPolling() {
  if (analysesPollHandle !== null) return;
  analysesPollHandle = setInterval(loadAnalyses, ANALYSES_POLL_MS);
}
function stopAnalysesPolling() {
  if (analysesPollHandle !== null) {
    clearInterval(analysesPollHandle);
    analysesPollHandle = null;
  }
}

const renderedAnalyses = computed(() =>
  analyses.value.map((a) => ({
    ...a,
    html: marked.parse(a.content ?? '', { async: false }) as string,
  })),
);

async function deleteAnalysis(id: number) {
  if (!confirm('Analyse löschen?')) return;
  try {
    await api.analyses.remove(id);
    analyses.value = analyses.value.filter((a) => a.id !== id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

const statuses: TodoStatus[] = ['todo', 'in_progress', 'test', 'done'];
const todoId = computed(() => Number(props.id));

// Description preview: render markdown, then linkify any stack-trace paths.
// Toggle between editing and preview modes.
const descriptionPreview = ref(false);
const renderedDescription = computed(() => {
  const src = todo.value?.description ?? '';
  if (!src.trim()) return '';
  const html = marked.parse(src, { async: false }) as string;
  return linkifyStackTraceInHtml(html);
});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    todo.value = await api.todos.get(todoId.value);
    tagsText.value = todo.value.tags.join(', ');
    snippets.value = await api.snippets.byTodo(todoId.value);
    await loadAnalyses();
    // Refresh the queue snapshot so the Warteschlange card reflects reality
    // without waiting for the next poll tick.
    await queueStore.fetchAll();
    syncQueuePromptDraft();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function syncQueuePromptDraft() {
  queuePromptDraft.value = queuedItem.value?.queue_prompt ?? '';
}

// Whenever the queue store updates (poll tick, action elsewhere), re-sync the
// draft prompt — but only if the user hasn't typed changes the server hasn't
// seen yet. A simple heuristic: overwrite only when the current queued prompt
// matches the draft OR the draft is empty.
watch(
  () => queuedItem.value?.queue_prompt,
  (remote) => {
    if (remote === undefined) return;
    if (queuePromptDraft.value === '' || queuePromptDraft.value === remote) {
      queuePromptDraft.value = remote ?? '';
    }
  },
);

async function enqueue() {
  if (!todo.value || !canEnqueue.value) return;
  try {
    await queueStore.enqueue(todo.value.id, queuePromptDraft.value, []);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function dequeue() {
  if (!todo.value || !isQueued.value) return;
  try {
    await queueStore.dequeue(todo.value.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveQueuePrompt() {
  if (!todo.value || !isQueued.value) return;
  try {
    await queueStore.update(todo.value.id, { prompt: queuePromptDraft.value });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
onUnmounted(stopAnalysesPolling);
watch(() => props.id, () => {
  stopAnalysesPolling();
  analyses.value = [];
  void load();
});

// While the agent is running, poll for analyses so a freshly persisted
// analyse-mode result appears without a manual reload.
watch(agentActive, (active) => {
  if (active) {
    void loadAnalyses();
    startAnalysesPolling();
  } else {
    stopAnalysesPolling();
    // Final refresh after agent ends so we pick up anything saved on the last turn.
    void loadAnalyses();
  }
});

async function save() {
  if (!todo.value) return;
  saving.value = true;
  try {
    const updated = await todos.update(todo.value.id, {
      title: todo.value.title,
      description: todo.value.description,
      status: todo.value.status,
      priority: todo.value.priority,
      tags: tagsText.value.split(',').map((t) => t.trim()).filter(Boolean),
      due_date: todo.value.due_date,
    });
    todo.value = updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!todo.value) return;
  if (!confirm('Aufgabe wirklich löschen?')) return;
  await todos.remove(todo.value.id);
  router.push('/');
}

async function addSnippet() {
  const s = await api.snippets.create(todoId.value, { title: '', language: 'markdown', content: '' });
  snippets.value.push(s);
}

async function saveSnippet(id: number, patch: Partial<Snippet>) {
  const updated = await api.snippets.update(id, patch);
  const idx = snippets.value.findIndex((s) => s.id === id);
  if (idx >= 0) snippets.value.splice(idx, 1, updated);
}

async function deleteSnippet(id: number) {
  if (!confirm('Snippet löschen?')) return;
  await api.snippets.remove(id);
  snippets.value = snippets.value.filter((s) => s.id !== id);
}

function onAgentCwdUpdate(cwd: string | null) {
  if (todo.value) todo.value.working_directory = cwd;
}
</script>

<template>
  <div class="detail" :class="{ 'two-col': agentActive }">
    <button class="ghost" @click="router.back()" style="align-self: flex-start;">← Zurück</button>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading">Lade…</div>

    <template v-if="todo">
      <div class="detail-grid" :class="{ 'two-col': agentActive }">
        <div class="detail-main">
          <div class="card">
            <h2>
              <span>{{ STATUS_ICONS[todo.status] }}</span>
              <input v-model="todo.title" type="text" :disabled="editLocked" style="display: inline-block; width: calc(100% - 3rem);" />
            </h2>

            <div v-if="editLocked" class="lock-banner">
              🔒 Aufgabe läuft — Felder sind gesperrt, bis der Agent fertig ist.
            </div>

            <div class="row" style="margin-bottom: 0.5rem;">
              <label class="stacked" style="flex: 1;">
                <span>Status</span>
                <select v-model="todo.status">
                  <option v-for="s in statuses" :key="s" :value="s">{{ STATUS_ICONS[s] }} {{ STATUS_LABELS[s] }}</option>
                </select>
              </label>
              <label class="stacked" style="flex: 1;">
                <span>Priorität</span>
                <select v-model.number="todo.priority">
                  <option :value="1">🔴 Dringend</option>
                  <option :value="2">🟡 Normal</option>
                  <option :value="3">🟢 Niedrig</option>
                  <option :value="4">⚪ Irgendwann</option>
                </select>
              </label>
              <label class="stacked" style="flex: 1;">
                <span>Fälligkeit</span>
                <input type="date"
                  :value="todo.due_date ? todo.due_date.slice(0, 10) : ''"
                  @input="(e) => todo && (todo.due_date = (e.target as HTMLInputElement).value ? new Date((e.target as HTMLInputElement).value).toISOString() : null)"
                />
              </label>
            </div>

            <label class="stacked">
              <span>Tags (komma-getrennt)</span>
              <input v-model="tagsText" type="text" />
            </label>

            <label class="stacked" style="margin-top: 0.5rem;">
              <span style="display: flex; justify-content: space-between; align-items: center;">
                <span>Beschreibung</span>
                <button type="button" class="ghost" @click="descriptionPreview = !descriptionPreview">
                  {{ descriptionPreview ? 'Bearbeiten' : 'Vorschau' }}
                </button>
              </span>
              <textarea
                v-if="!descriptionPreview"
                v-model="todo.description"
                :disabled="editLocked"
                rows="18"
                style="min-height: 26rem; font-family: var(--font-mono); line-height: 1.5;"
              />
              <div
                v-else
                class="preview description-preview"
                style="min-height: 26rem; line-height: 1.5;"
                v-html="renderedDescription"
              />
            </label>

            <div v-if="todo.source !== 'local'" class="row" style="margin-top: 0.5rem;">
              <span class="tag">Quelle: {{ todo.source }}</span>
              <a v-if="todo.source_url" :href="todo.source_url" target="_blank" rel="noopener">Original öffnen ↗</a>
              <span v-if="todo.last_writeback_at" class="tag" :title="new Date(todo.last_writeback_at).toLocaleString()">
                ⬆ Letzter Writeback: {{ new Date(todo.last_writeback_at).toLocaleString() }}
              </span>
            </div>

            <div v-if="todo.last_writeback_error" class="error-banner" style="margin-top: 0.5rem;">
              ⚠️ Writeback fehlgeschlagen: {{ todo.last_writeback_error }}
            </div>

            <div class="row" style="margin-top: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
              <button class="primary" :disabled="saving || editLocked" @click="save">Speichern</button>
              <button class="danger" :disabled="editLocked" @click="remove">Löschen</button>
              <GitBranchButton :title="todo.title" :todo-id="todo.id" />
            </div>
          </div>

          <div class="card">
            <div class="row" style="justify-content: space-between; align-items: baseline;">
              <h3 style="margin: 0;">📥 Warteschlange</h3>
              <span v-if="isQueued && queuedItem" class="tag">Position {{ queuedItem.queue_position + 1 }}</span>
            </div>
            <p v-if="!isQueued && !canEnqueue" style="color: var(--fg-muted); font-size: 0.85rem; margin: 0.5rem 0 0 0;">
              Nur Aufgaben im Status "🔧 Werkbank" können eingereiht werden.
            </p>
            <template v-else>
              <p style="color: var(--fg-muted); font-size: 0.85rem; margin: 0.5rem 0;">
                Der Runner startet die Aufgabe automatisch, sobald sie an der Reihe ist — dasselbe wie "Run Claude" manuell zu klicken.
                Prompt und Auswahl sind hier bearbeitbar, bis der Lauf beginnt.
              </p>
              <label class="stacked">
                <span>User-Prompt für den automatischen Start (optional)</span>
                <textarea
                  v-model="queuePromptDraft"
                  rows="4"
                  spellcheck="false"
                  :placeholder="isQueued ? 'Zusätzliche Anweisung für Claude…' : 'Leer lassen, um nur die Aufgabenbeschreibung zu verwenden.'"
                />
              </label>
              <div class="row" style="margin-top: 0.5rem; gap: 0.4rem; flex-wrap: wrap;">
                <button
                  v-if="!isQueued"
                  class="primary"
                  :disabled="!canEnqueue"
                  @click="enqueue"
                  title="In die Warteschlange einreihen"
                >▶ In Warteschlange einreihen</button>
                <template v-else>
                  <button class="ghost" @click="saveQueuePrompt" title="Prompt aktualisieren">💾 Prompt speichern</button>
                  <button class="danger" @click="dequeue" title="Aus der Warteschlange entfernen">✕ Aus Warteschlange</button>
                </template>
              </div>
            </template>
          </div>

          <div class="card">
            <h3 style="margin: 0 0 0.75rem 0;">🔨 Pomodoro</h3>
            <TodoPomodoro :todo-id="todo.id" />
          </div>

          <div class="card">
            <AttachmentPanel :todo-id="todo.id" />
          </div>

          <div v-if="analyses.length > 0" class="card">
            <h3 style="margin: 0 0 0.75rem 0;">🔍 Analysen</h3>
            <ul class="analysis-list">
              <li v-for="a in renderedAnalyses" :key="a.id" class="analysis-item">
                <div class="analysis-header">
                  <span class="analysis-time" :title="a.created_at">
                    {{ new Date(a.created_at.replace(' ', 'T') + 'Z').toLocaleString() }}
                  </span>
                  <button
                    class="danger"
                    type="button"
                    @click="deleteAnalysis(a.id)"
                    title="Analyse löschen"
                  >🗑</button>
                </div>
                <div class="analysis-body preview" v-html="a.html" />
              </li>
            </ul>
          </div>

          <div class="card">
            <h3 style="margin: 0 0 0.75rem 0;">☑ Subtasks</h3>
            <SubtaskList :todo-id="todo.id" :agent-active="agentActive" />
          </div>

          <div class="card">
            <div class="row" style="justify-content: space-between;">
              <h3 style="margin: 0;">📝 Snippets &amp; Notizen</h3>
              <button class="primary" @click="addSnippet">+ Neues Snippet</button>
            </div>
            <div v-if="snippets.length === 0" class="empty">Noch keine Snippets.</div>
            <div class="snippet-grid">
              <SnippetEditor
                v-for="s in snippets"
                :key="s.id"
                :snippet="s"
                @save="(patch) => saveSnippet(s.id, patch)"
                @delete="deleteSnippet(s.id)"
              />
            </div>
          </div>

          <div class="card">
            <McpServersPanel :todo-id="todo.id" />
          </div>
        </div>

        <div class="detail-side">
          <div class="card">
            <ClaudeAgent
              :todo="todo"
              @update-cwd="onAgentCwdUpdate"
              @active="agentActive = $event"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.analysis-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.analysis-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.6rem 0.75rem;
}
.analysis-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.4rem;
  gap: 0.5rem;
}
.analysis-time {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--fg-muted);
}
.analysis-body {
  font-size: 0.92rem;
  line-height: 1.5;
}
.analysis-body :deep(h1),
.analysis-body :deep(h2),
.analysis-body :deep(h3) {
  margin-top: 0.6rem;
  margin-bottom: 0.3rem;
}
.analysis-body :deep(ul),
.analysis-body :deep(ol) {
  margin: 0.3rem 0;
  padding-left: 1.2rem;
}
.lock-banner {
  margin: 0.25rem 0 0.75rem 0;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--fg-muted);
  font-size: 0.85rem;
}
</style>
