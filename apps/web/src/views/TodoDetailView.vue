<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { marked } from 'marked';
import { api } from '../api';
import type { Todo, Snippet, TodoStatus, Analysis, TaskType, SandboxStatus, Integration, GitHubConfig } from '../types';
import { STATUS_LABELS, STATUS_ICONS, TASK_TYPE_LABELS, TASK_TYPE_ICONS, TASK_TYPES, SANDBOX_STATUS_LABELS, SANDBOX_STATUS_COLOR } from '../types';
import { computeAgentBranchName } from '../utils/branchName';
import { useTodosStore } from '../stores/todos';
import { useQueueStore } from '../stores/queue';
import SnippetEditor from '../components/SnippetEditor.vue';
import SubtaskList from '../components/SubtaskList.vue';
import TodoPomodoro from '../components/TodoPomodoro.vue';
import AttachmentPanel from '../components/AttachmentPanel.vue';
import ClaudeAgent from '../components/ClaudeAgent.vue';
import GitBranchButton from '../components/GitBranchButton.vue';
import McpServersPanel from '../components/McpServersPanel.vue';
import PathPicker from '../components/PathPicker.vue';
import { linkifyStackTraceInHtml } from '../utils/linkifyStackTrace';

const props = defineProps<{ id: string }>();
const router = useRouter();
const todos = useTodosStore();
const queueStore = useQueueStore();

const isNew = computed(() => props.id === 'new');

const todo = ref<Todo | null>(null);
const snippets = ref<Snippet[]>([]);
const analyses = ref<Analysis[]>([]);
const attachmentCount = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const saving = ref(false);
const tagsText = ref('');
const agentActive = ref(false);
const defaultWorkingDirectory = ref<string>('');
const savingCwd = ref(false);

// Pre-save subtask drafts — only used while creating a new todo. Get shipped
// to the server as `subtasks: string[]` in the POST /todos body and inserted
// atomically alongside the todo itself.
const newSubtaskDrafts = ref<string[]>([]);
const subtaskInputRefs = ref<HTMLInputElement[]>([]);

function addSubtaskDraft() {
  newSubtaskDrafts.value.push('');
  nextTick(() => {
    const last = subtaskInputRefs.value[newSubtaskDrafts.value.length - 1];
    last?.focus();
  });
}

function removeSubtaskDraft(idx: number) {
  newSubtaskDrafts.value.splice(idx, 1);
}

function emptyTodoDraft(): Todo {
  return {
    id: 0,
    title: '',
    description: '',
    status: 'todo',
    priority: 2,
    tags: [],
    due_date: null,
    source: 'local',
    source_ref: null,
    source_url: null,
    created_at: '',
    updated_at: '',
    last_writeback_error: null,
    last_writeback_at: null,
    working_directory: '',
    task_type: 'other',
  };
}

// Tab state — "overview" is the default landing tab. Description, Subtasks and
// Warteschlange live here because the user asked for them to always be one
// click away.
type TabKey = 'overview' | 'material' | 'analyses' | 'mcp';
const activeTab = ref<TabKey>('overview');

// Queue integration.
// The runner now auto-injects a default prompt (title + description +
// source_url) when queue_prompt is empty, mirroring the ClaudeAgent panel's
// "Erste Nachricht" default. So the UI here no longer *requires* a prompt —
// it's an optional override behind a small toggle.
const queuePromptDraft = ref('');
const queuePromptOverride = ref(false);
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

async function loadAttachmentCount() {
  try {
    const rows = await api.attachments.byTodo(todoId.value);
    attachmentCount.value = rows.length;
  } catch {
    /* non-fatal — badge just stays at 0 */
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

// Path picker integration for the description textarea — lets the user paste
// `@path/to/file` references into their markdown description the same way
// they can in the agent prompt. Helpful for linking source files the todo
// relates to without manually typing the path.
const descriptionTextareaRef = ref<HTMLTextAreaElement | null>(null);
const descriptionPickerOpen = ref(false);
const effectiveDescriptionCwd = computed(() =>
  ((todo.value?.working_directory ?? '') || defaultWorkingDirectory.value || '').trim(),
);

function openDescriptionPicker() {
  if (!effectiveDescriptionCwd.value) return;
  descriptionPickerOpen.value = true;
}
function closeDescriptionPicker() {
  descriptionPickerOpen.value = false;
}

function insertIntoDescription(snippet: string) {
  if (!todo.value) return;
  const ta = descriptionTextareaRef.value;
  const current = todo.value.description ?? '';
  if (ta && document.activeElement === ta) {
    const pos = ta.selectionStart ?? current.length;
    const end = ta.selectionEnd ?? pos;
    const before = current.slice(0, pos);
    const after = current.slice(end);
    const needSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needSpace ? ' ' : '') + snippet;
    todo.value.description = before + insert + after;
    const newCaret = (before + insert).length;
    nextTick(() => {
      ta.setSelectionRange(newCaret, newCaret);
      ta.focus();
    });
  } else {
    const sep = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    todo.value.description = current + sep + snippet;
  }
}

function onDescriptionPathSelected(path: string, type: 'file' | 'dir') {
  insertIntoDescription('@' + path);
  closeDescriptionPicker();
  void type;
}

// Insert an attachment reference as markdown. Images get an `![alt](url)`
// embed so the preview renders inline; everything else becomes a plain link.
function insertAttachment(a: { id: number; filename: string; kind: string }) {
  const url = api.attachments.previewUrl(a.id);
  const snippet = a.kind === 'image'
    ? `![${a.filename}](${url})`
    : `[📎 ${a.filename}](${url})`;
  insertIntoDescription(snippet);
}

// Popover state for the attachment picker — lists the todo's current
// attachments so the user can insert a reference in one click.
const attachmentPickerOpen = ref(false);
const attachmentList = ref<Array<{ id: number; filename: string; kind: string }>>([]);

async function toggleAttachmentPicker() {
  if (attachmentPickerOpen.value) {
    attachmentPickerOpen.value = false;
    return;
  }
  try {
    attachmentList.value = (await api.attachments.byTodo(todoId.value)).map((a) => ({
      id: a.id, filename: a.filename, kind: a.kind,
    }));
  } catch {
    attachmentList.value = [];
  }
  attachmentPickerOpen.value = true;
}

async function uploadIntoDescription(ev: Event) {
  const files = (ev.target as HTMLInputElement).files;
  if (!files || files.length === 0 || !todo.value) return;
  try {
    const created = await api.attachments.upload(todo.value.id, Array.from(files));
    attachmentCount.value += created.length;
    for (const a of created) insertAttachment({ id: a.id, filename: a.filename, kind: a.kind });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  (ev.target as HTMLInputElement).value = '';
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    if (isNew.value) {
      todo.value = emptyTodoDraft();
      tagsText.value = '';
      snippets.value = [];
      analyses.value = [];
      attachmentCount.value = 0;
      await loadDefaultCwd();
      return;
    }
    todo.value = await api.todos.get(todoId.value);
    tagsText.value = todo.value.tags.join(', ');
    snippets.value = await api.snippets.byTodo(todoId.value);
    await Promise.all([loadAnalyses(), loadAttachmentCount(), loadDefaultCwd()]);
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

async function loadDefaultCwd() {
  try {
    const settings = await api.settings.getAll();
    defaultWorkingDirectory.value = (settings.defaultWorkingDirectory as string) ?? '';
  } catch {
    /* non-fatal — hint just won't show */
  }
}

async function saveWorkingDirectory() {
  if (!todo.value) return;
  savingCwd.value = true;
  try {
    const next = (todo.value.working_directory ?? '').trim() || null;
    const updated = await todos.update(todo.value.id, { working_directory: next });
    todo.value = updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    savingCwd.value = false;
  }
}

function syncQueuePromptDraft() {
  const remote = queuedItem.value?.queue_prompt ?? '';
  queuePromptDraft.value = remote;
  // If the queue already carries a custom prompt, keep the override editor
  // open so the user can see it.
  if (remote.trim()) queuePromptOverride.value = true;
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
    const prompt = queuePromptOverride.value ? queuePromptDraft.value : '';
    await queueStore.enqueue(todo.value.id, prompt, []);
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
    const prompt = queuePromptOverride.value ? queuePromptDraft.value : '';
    await queueStore.update(todo.value.id, { prompt });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
onUnmounted(stopAnalysesPolling);
watch(() => props.id, () => {
  stopAnalysesPolling();
  analyses.value = [];
  attachmentCount.value = 0;
  activeTab.value = 'overview';
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
    void loadAttachmentCount();
  }
});

async function save() {
  if (!todo.value) return;
  if (isNew.value && !todo.value.title.trim()) {
    error.value = 'Titel darf nicht leer sein.';
    return;
  }
  saving.value = true;
  try {
    const tags = tagsText.value.split(',').map((t) => t.trim()).filter(Boolean);
    if (isNew.value) {
      const subtasks = newSubtaskDrafts.value
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await todos.create({
        title: todo.value.title.trim(),
        description: todo.value.description ?? '',
        status: todo.value.status,
        priority: todo.value.priority,
        tags,
        due_date: todo.value.due_date,
        working_directory: (todo.value.working_directory ?? '').trim() || null,
        task_type: todo.value.task_type ?? 'other',
        ...(subtasks.length > 0 ? { subtasks } : {}),
      });
      router.replace(`/todo/${created.id}`);
      return;
    }
    const updated = await todos.update(todo.value.id, {
      title: todo.value.title,
      description: todo.value.description,
      status: todo.value.status,
      priority: todo.value.priority,
      tags,
      due_date: todo.value.due_date,
      task_type: todo.value.task_type ?? 'other',
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

// ─── Sandbox-Lauf block ─────────────────────────────────────────────────────
const sandboxOpen = ref(false);
const sandboxStatus = computed<SandboxStatus>(
  () => (todo.value?.sandbox_status ?? 'idle') as SandboxStatus,
);
const sandboxRunning = computed(() => sandboxStatus.value === 'running');
const sandboxBranchPlaceholder = computed(() => {
  if (!todo.value) return '';
  return computeAgentBranchName(todo.value);
});

/**
 * Persist a sandbox override through the regular undoable update path.
 * Empty strings on text fields and nullable numerics are translated to `null`
 * so the server clears the override and falls back to the global default.
 */
async function saveSandboxField<K extends keyof Todo>(key: K, value: Todo[K] | null) {
  if (!todo.value) return;
  try {
    const updated = await todos.update(todo.value.id, { [key]: value } as Partial<Todo>);
    todo.value = updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onSandboxBranchBlur(ev: FocusEvent) {
  const value = ((ev.target as HTMLInputElement).value ?? '').trim();
  void saveSandboxField('branch_name', value || null);
}
function onSandboxBaseBranchBlur(ev: FocusEvent) {
  const value = ((ev.target as HTMLInputElement).value ?? '').trim();
  void saveSandboxField('base_branch', value || null);
}
function onSandboxTestCommandBlur(ev: FocusEvent) {
  const value = ((ev.target as HTMLInputElement).value ?? '').trim();
  void saveSandboxField('test_command', value || null);
}
function onSandboxTimeoutBlur(ev: FocusEvent) {
  const raw = (ev.target as HTMLInputElement).value;
  if (raw === '') { void saveSandboxField('sandbox_timeout_min', null); return; }
  const n = Math.max(1, Math.min(120, Number(raw)));
  if (Number.isFinite(n)) void saveSandboxField('sandbox_timeout_min', n);
}
function onSandboxMaxTurnsBlur(ev: FocusEvent) {
  const raw = (ev.target as HTMLInputElement).value;
  if (raw === '') { void saveSandboxField('sandbox_max_turns', null); return; }
  const n = Math.max(1, Math.min(80, Number(raw)));
  if (Number.isFinite(n)) void saveSandboxField('sandbox_max_turns', n);
}
function onSandboxRepoChange(ev: Event) {
  const value = (ev.target as HTMLSelectElement).value;
  void saveSandboxField('sandbox_repo', value || null);
}

// Configured GitHub repos — populated from the GitHub integration so the user
// can pick a sandbox target for locally-created todos that don't have a
// source_ref from a GitHub sync.
const configuredGithubRepos = ref<string[]>([]);
async function loadConfiguredGithubRepos() {
  try {
    const list: Integration[] = await api.integrations.list();
    const gh = list.find((i) => i.provider === 'github');
    const cfg = gh?.config as GitHubConfig | undefined;
    configuredGithubRepos.value = cfg?.repos ?? [];
  } catch {
    configuredGithubRepos.value = [];
  }
}
onMounted(loadConfiguredGithubRepos);

// Tab list driving the nav. Order matches the visual order of the tabs.
const tabs = computed(() => [
  { key: 'overview' as TabKey, label: '📝 Übersicht', badge: null as number | null },
  { key: 'material' as TabKey, label: '📎 Material', badge: (snippets.value.length + attachmentCount.value) || null },
  { key: 'analyses' as TabKey, label: '🔍 Analysen', badge: analyses.value.length || null },
  { key: 'mcp' as TabKey, label: '⚙️ MCP', badge: null },
]);
</script>

<template>
  <div class="detail">
    <div class="detail-topbar">
      <button class="ghost" @click="router.back()">← Zurück</button>
      <TodoPomodoro v-if="!isNew && todo" :todo-id="todo.id" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading">Lade…</div>

    <template v-if="todo">
      <div class="detail-grid" :class="{ 'two-col': !isNew && agentActive }">
        <div class="detail-main">
          <!-- Header: always-visible meta strip -->
          <div class="card detail-header">
            <div v-if="isNew" class="new-banner">
              ➕ Neue Aufgabe erstellen — fülle die Felder aus und klicke auf <strong>Erstellen</strong>.
            </div>
            <div class="title-row">
              <span class="status-icon" :title="STATUS_LABELS[todo.status]">{{ STATUS_ICONS[todo.status] }}</span>
              <input v-model="todo.title" type="text" :disabled="editLocked" placeholder="Titel…" />
            </div>

            <div v-if="editLocked" class="lock-banner">
              🔒 Aufgabe läuft — Felder sind gesperrt, bis der Agent fertig ist.
            </div>

            <div class="meta-grid">
              <label>
                <span>Status</span>
                <select v-model="todo.status">
                  <option v-for="s in statuses" :key="s" :value="s">{{ STATUS_ICONS[s] }} {{ STATUS_LABELS[s] }}</option>
                </select>
              </label>
              <label>
                <span>Priorität</span>
                <select v-model.number="todo.priority">
                  <option :value="1">🔴 Dringend</option>
                  <option :value="2">🟡 Normal</option>
                  <option :value="3">🟢 Niedrig</option>
                  <option :value="4">⚪ Irgendwann</option>
                </select>
              </label>
              <label>
                <span>Typ</span>
                <select v-model="todo.task_type">
                  <option v-for="t in TASK_TYPES" :key="t" :value="t">
                    {{ TASK_TYPE_ICONS[t] }} {{ TASK_TYPE_LABELS[t] }}
                  </option>
                </select>
              </label>
              <label>
                <span>Fälligkeit</span>
                <input type="date"
                  :value="todo.due_date ? todo.due_date.slice(0, 10) : ''"
                  @input="(e) => todo && (todo.due_date = (e.target as HTMLInputElement).value ? new Date((e.target as HTMLInputElement).value).toISOString() : null)"
                />
              </label>
              <label style="grid-column: span 2;">
                <span>Tags (komma-getrennt)</span>
                <input v-model="tagsText" type="text" placeholder="bugfix, api, urgent…" />
              </label>
              <label style="grid-column: span 2;">
                <span>
                  Arbeitsverzeichnis
                  <span style="color: var(--fg-muted); font-weight: normal; font-size: 0.78rem;">
                    (leer lassen für Standard<template v-if="defaultWorkingDirectory">: <code>{{ defaultWorkingDirectory }}</code></template>)
                  </span>
                </span>
                <div class="row" style="gap: 0.4rem; align-items: stretch;">
                  <input
                    v-model="todo.working_directory"
                    type="text"
                    spellcheck="false"
                    :placeholder="defaultWorkingDirectory || 'z. B. D:\\programme\\werkbank'"
                    style="flex: 1; font-family: var(--font-mono);"
                    @keydown.enter.prevent="saveWorkingDirectory"
                  />
                  <button
                    type="button"
                    class="ghost"
                    :disabled="savingCwd"
                    @click="saveWorkingDirectory"
                    title="Arbeitsverzeichnis übernehmen"
                  >💾</button>
                </div>
              </label>
            </div>

            <div v-if="!isNew && (todo.source !== 'local' || todo.last_writeback_at)" class="source-row">
              <span v-if="todo.source !== 'local'" class="tag">Quelle: {{ todo.source }}</span>
              <a v-if="todo.source_url" :href="todo.source_url" target="_blank" rel="noopener">Original öffnen ↗</a>
              <span v-if="todo.last_writeback_at" class="tag" :title="new Date(todo.last_writeback_at).toLocaleString()">
                ⬆ Letzter Writeback: {{ new Date(todo.last_writeback_at).toLocaleString() }}
              </span>
            </div>

            <div v-if="!isNew && todo.last_writeback_error" class="error-banner">
              ⚠️ Writeback fehlgeschlagen: {{ todo.last_writeback_error }}
            </div>

            <div class="actions-row">
              <button class="primary" :disabled="saving || editLocked" @click="save">
                {{ isNew ? '➕ Erstellen' : '💾 Speichern' }}
              </button>
              <button v-if="isNew" class="ghost" :disabled="saving" @click="router.back()">Abbrechen</button>
              <template v-else>
                <button class="danger" :disabled="editLocked" @click="remove">🗑 Löschen</button>
                <GitBranchButton
                  :title="todo.title"
                  :todo-id="todo.id"
                  :source="todo.source"
                  :source-ref="todo.source_ref"
                  :tags="todo.tags"
                  :task-type="todo.task_type"
                />
              </template>
            </div>
          </div>

          <!-- In new-mode: a simplified description editor replaces the tab layout.
               Snippets/attachments/analyses/pomodoro/MCP all need a persistent
               todo id, so they only appear after creation. Subtasks are the
               exception: we collect title drafts here and the POST /todos
               endpoint inserts them in the same transaction. -->
          <div v-if="isNew" class="card description-card">
            <div class="description-head">
              <h3 style="margin: 0;">📝 Beschreibung</h3>
              <button type="button" class="ghost" @click="descriptionPreview = !descriptionPreview">
                {{ descriptionPreview ? 'Bearbeiten' : 'Vorschau' }}
              </button>
            </div>
            <textarea
              v-if="!descriptionPreview"
              v-model="todo.description"
              rows="18"
              placeholder="Worum geht's? Markdown unterstützt…"
            />
            <div
              v-else-if="renderedDescription"
              class="preview description-preview"
              v-html="renderedDescription"
            />
            <div v-else class="empty description-preview">Keine Beschreibung.</div>
          </div>

          <div v-if="isNew" class="card">
            <h3 style="margin: 0 0 0.75rem 0;">☑ Subtasks (optional)</h3>
            <ul v-if="newSubtaskDrafts.length > 0" class="new-subtask-list">
              <li
                v-for="(_, idx) in newSubtaskDrafts"
                :key="idx"
                class="new-subtask-row"
              >
                <input
                  ref="subtaskInputRefs"
                  v-model="newSubtaskDrafts[idx]"
                  type="text"
                  placeholder="Subtask-Titel…"
                  @keydown.enter.prevent="addSubtaskDraft"
                />
                <button
                  type="button"
                  class="danger"
                  @click="removeSubtaskDraft(idx)"
                  title="Subtask entfernen"
                >🗑</button>
              </li>
            </ul>
            <div class="new-subtask-add">
              <button class="primary" type="button" @click="addSubtaskDraft">
                + Subtask hinzufügen
              </button>
            </div>
          </div>

          <!-- Tab navigation (only for existing todos) -->
          <nav v-if="!isNew" class="detail-tabs" role="tablist">
            <button
              v-for="t in tabs"
              :key="t.key"
              type="button"
              role="tab"
              :aria-selected="activeTab === t.key"
              :class="{ active: activeTab === t.key }"
              @click="activeTab = t.key"
            >
              {{ t.label }}<span v-if="t.badge" class="tab-badge">{{ t.badge }}</span>
            </button>
          </nav>

          <!-- Tab: Übersicht -->
          <div v-if="!isNew && activeTab === 'overview'" class="tab-panel">
            <div class="card description-card">
              <div class="description-head">
                <h3 style="margin: 0;">📝 Beschreibung</h3>
                <div class="row" style="gap: 0.3rem; position: relative;">
                  <button
                    v-if="!descriptionPreview"
                    type="button"
                    class="ghost"
                    style="font-size: 0.78rem;"
                    :disabled="editLocked || !effectiveDescriptionCwd"
                    :title="effectiveDescriptionCwd ? 'Datei-/Ordnerpfad einfügen' : 'Kein Arbeitsverzeichnis gesetzt'"
                    @click="openDescriptionPicker"
                  >📂 Pfad</button>
                  <button
                    v-if="!descriptionPreview"
                    type="button"
                    class="ghost"
                    style="font-size: 0.78rem;"
                    :disabled="editLocked"
                    title="Anhang einfügen"
                    @click="toggleAttachmentPicker"
                  >📎 Anhang</button>
                  <label
                    v-if="!descriptionPreview"
                    class="ghost button-like"
                    style="font-size: 0.78rem; cursor: pointer;"
                    :class="{ disabled: editLocked }"
                    title="Datei hochladen und direkt einfügen"
                  >
                    ⬆ Upload
                    <input
                      type="file"
                      multiple
                      style="display: none;"
                      :disabled="editLocked"
                      @change="uploadIntoDescription"
                    />
                  </label>
                  <button type="button" class="ghost" @click="descriptionPreview = !descriptionPreview">
                    {{ descriptionPreview ? 'Bearbeiten' : 'Vorschau' }}
                  </button>
                  <div v-if="attachmentPickerOpen" class="attachment-popover">
                    <div class="row" style="justify-content: space-between; align-items: baseline;">
                      <strong style="font-size: 0.85rem;">Anhang einfügen</strong>
                      <button class="ghost" type="button" style="font-size: 0.75rem;" @click="attachmentPickerOpen = false">✕</button>
                    </div>
                    <div v-if="attachmentList.length === 0" class="empty" style="margin: 0.5rem 0;">
                      Keine Anhänge. Nutze ⬆ Upload zum Hinzufügen.
                    </div>
                    <ul v-else class="attachment-popover-list">
                      <li
                        v-for="a in attachmentList"
                        :key="a.id"
                        @click="insertAttachment(a); attachmentPickerOpen = false"
                      >
                        <span>{{ a.kind === 'image' ? '🖼' : '📎' }}</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ a.filename }}</span>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
              <textarea
                v-if="!descriptionPreview"
                ref="descriptionTextareaRef"
                v-model="todo.description"
                :disabled="editLocked"
                rows="18"
                placeholder="Worum geht's? Markdown unterstützt…"
              />
              <PathPicker
                v-if="!descriptionPreview"
                :root="effectiveDescriptionCwd"
                :open="descriptionPickerOpen"
                anchor="inline"
                @select="onDescriptionPathSelected"
                @close="closeDescriptionPicker"
              />
              <div
                v-else-if="renderedDescription"
                class="preview description-preview"
                v-html="renderedDescription"
              />
              <div v-else class="empty description-preview">Keine Beschreibung.</div>
            </div>

            <div class="card">
              <h3 style="margin: 0 0 0.75rem 0;">☑ Subtasks</h3>
              <SubtaskList :todo-id="todo.id" :agent-active="agentActive" />
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
                  Der Runner startet die Aufgabe automatisch mit <strong>Titel + Beschreibung</strong> als Prompt —
                  genau wie "Run Claude" im Agent-Panel.
                </p>
                <label class="row" style="gap: 0.5rem; margin: 0.25rem 0; cursor: pointer; align-items: center;">
                  <input type="checkbox" v-model="queuePromptOverride" />
                  <span style="font-size: 0.88rem;">Prompt überschreiben (optional)</span>
                </label>
                <label v-if="queuePromptOverride" class="stacked">
                  <span style="color: var(--fg-muted); font-size: 0.8rem;">
                    Eigener User-Prompt — ersetzt Titel + Beschreibung im ersten Turn
                  </span>
                  <textarea
                    v-model="queuePromptDraft"
                    rows="4"
                    spellcheck="false"
                    placeholder="Zusätzliche Anweisung für Claude…"
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
          </div>

          <!-- Tab: Material — Attachments + Snippets -->
          <div v-if="!isNew && activeTab === 'material'" class="tab-panel">
            <div class="card">
              <AttachmentPanel :todo-id="todo.id" />
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
          </div>

          <!-- Tab: Analysen -->
          <div v-if="!isNew && activeTab === 'analyses'" class="tab-panel">
            <div class="card">
              <h3 style="margin: 0 0 0.75rem 0;">🔍 Analysen</h3>
              <p v-if="analyses.length === 0" class="empty" style="margin: 0;">
                Noch keine Analysen. Starte im Agent-Panel den Analyse-Modus.
              </p>
              <ul v-else class="analysis-list">
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
          </div>

          <!-- Tab: MCP -->
          <div v-if="!isNew && activeTab === 'mcp'" class="tab-panel">
            <div class="card">
              <McpServersPanel :todo-id="todo.id" />
            </div>
          </div>
        </div>

        <!-- Claude agent panel: sticky sidebar while active.
             Hidden in new-mode — the agent needs a persisted todo id. -->
        <div v-if="!isNew" class="detail-side">
          <div class="card">
            <ClaudeAgent
              :todo="todo"
              @update-cwd="onAgentCwdUpdate"
              @active="agentActive = $event"
            />
          </div>

          <!-- Sandbox-Lauf: collapsible block with overrides + chip + PR link.
               Fields go through saveSandboxField → todos.update so Ctrl+Z
               reverts them; status changes bypass undo via _updateLocal. -->
          <div class="card sandbox-section">
            <button
              type="button"
              class="ghost sandbox-head"
              @click="sandboxOpen = !sandboxOpen"
            >
              <span>{{ sandboxOpen ? '▾' : '▸' }} 🐳 Sandbox-Lauf</span>
              <span
                class="agent-badge sandbox-chip"
                :class="`sandbox-chip-${sandboxStatus}`"
                :style="{ color: `var(${SANDBOX_STATUS_COLOR[sandboxStatus]})`, borderColor: `var(${SANDBOX_STATUS_COLOR[sandboxStatus]})` }"
              >{{ SANDBOX_STATUS_LABELS[sandboxStatus] }}</span>
            </button>
            <div v-if="sandboxOpen" class="sandbox-body">
              <a
                v-if="todo.sandbox_pr_url"
                :href="todo.sandbox_pr_url"
                target="_blank"
                rel="noopener"
                class="sandbox-pr-link"
              >Draft-PR öffnen →</a>

              <label class="stacked" v-if="todo.source !== 'github' || !todo.source_ref">
                <span>
                  GitHub-Repo
                  <span v-if="configuredGithubRepos.length === 0" style="color: var(--fg-muted); font-weight: normal;"> — keine Repos in den Einstellungen konfiguriert</span>
                </span>
                <select
                  :value="todo.sandbox_repo ?? ''"
                  :disabled="sandboxRunning || configuredGithubRepos.length === 0"
                  style="font-family: var(--font-mono); font-size: 0.85rem;"
                  @change="onSandboxRepoChange"
                >
                  <option value="">— nicht zugewiesen —</option>
                  <option v-for="r in configuredGithubRepos" :key="r" :value="r">{{ r }}</option>
                </select>
              </label>

              <label class="stacked">
                <span>Branch-Name</span>
                <input
                  type="text"
                  :value="todo.branch_name ?? ''"
                  :placeholder="sandboxBranchPlaceholder"
                  :disabled="sandboxRunning"
                  spellcheck="false"
                  style="font-family: var(--font-mono); font-size: 0.85rem;"
                  @blur="onSandboxBranchBlur"
                  @keydown.enter.prevent="onSandboxBranchBlur($event as unknown as FocusEvent)"
                />
              </label>
              <label class="stacked">
                <span>Basis-Branch</span>
                <input
                  type="text"
                  :value="todo.base_branch ?? ''"
                  placeholder="develop"
                  :disabled="sandboxRunning"
                  spellcheck="false"
                  style="font-family: var(--font-mono); font-size: 0.85rem;"
                  @blur="onSandboxBaseBranchBlur"
                  @keydown.enter.prevent="onSandboxBaseBranchBlur($event as unknown as FocusEvent)"
                />
              </label>
              <label class="stacked">
                <span>Test-Kommando</span>
                <input
                  type="text"
                  :value="todo.test_command ?? ''"
                  placeholder="npm test / pytest / …"
                  :disabled="sandboxRunning"
                  spellcheck="false"
                  style="font-family: var(--font-mono); font-size: 0.85rem;"
                  @blur="onSandboxTestCommandBlur"
                  @keydown.enter.prevent="onSandboxTestCommandBlur($event as unknown as FocusEvent)"
                />
              </label>
              <div class="row" style="gap: 0.5rem;">
                <label class="stacked" style="flex: 1;">
                  <span>Timeout (Minuten)</span>
                  <input
                    type="number"
                    min="1"
                    max="120"
                    :value="todo.sandbox_timeout_min ?? ''"
                    placeholder="30"
                    :disabled="sandboxRunning"
                    @blur="onSandboxTimeoutBlur"
                    @keydown.enter.prevent="onSandboxTimeoutBlur($event as unknown as FocusEvent)"
                  />
                </label>
                <label class="stacked" style="flex: 1;">
                  <span>Max. Turns</span>
                  <input
                    type="number"
                    min="1"
                    max="80"
                    :value="todo.sandbox_max_turns ?? ''"
                    placeholder="40"
                    :disabled="sandboxRunning"
                    @blur="onSandboxMaxTurnsBlur"
                    @keydown.enter.prevent="onSandboxMaxTurnsBlur($event as unknown as FocusEvent)"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  align-self: stretch;
}
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
.new-banner {
  margin: 0 0 0.75rem 0;
  padding: 0.4rem 0.6rem;
  border: 1px dashed color-mix(in srgb, #3b82f6 60%, var(--border));
  border-radius: var(--radius);
  background: color-mix(in srgb, #3b82f6 12%, var(--bg-elev));
  color: var(--fg);
  font-size: 0.88rem;
}
.new-subtask-list {
  list-style: none;
  margin: 0 0 0.6rem 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.new-subtask-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.new-subtask-row input {
  flex: 1;
}
.new-subtask-add {
  display: flex;
}
.attachment-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 0.4rem);
  z-index: 50;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  padding: 0.5rem;
  width: 280px;
}
.attachment-popover-list {
  list-style: none;
  margin: 0.3rem 0 0 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.attachment-popover-list li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.45rem;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.82rem;
}
.attachment-popover-list li:hover {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}
.button-like {
  display: inline-flex;
  align-items: center;
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.45rem 0.85rem;
}
.button-like.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Sandbox-Lauf block — collapsible card in the detail-side column. Header is
   a full-width ghost button so the chip sits flush right. */
.sandbox-section {
  padding: 0.75rem 1rem;
}
.sandbox-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  text-align: left;
  padding: 0.25rem 0.1rem;
  font-family: var(--font-display);
  letter-spacing: 0.04em;
}
.sandbox-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-top: 0.75rem;
}
.sandbox-pr-link {
  display: inline-block;
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--success);
  color: var(--success);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  text-decoration: none;
  align-self: flex-start;
}
.sandbox-pr-link:hover { filter: brightness(1.1); text-decoration: none; }
</style>
