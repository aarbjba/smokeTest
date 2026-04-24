<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import type { Subtask, Todo, TodoStatus } from '../types';
import { STATUS_LABELS, STATUS_ICONS } from '../types';

const props = withDefaults(
  defineProps<{ todoId: number; agentActive?: boolean }>(),
  { agentActive: false },
);

const POLL_INTERVAL_MS = 5000;

const router = useRouter();

const items = ref<Subtask[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const newTitle = ref('');
const editingId = ref<number | null>(null);
const editBuffer = ref('');
// IDs of subtasks whose detail panel (description + link controls) is open.
const expandedIds = ref<Set<number>>(new Set());
// Per-subtask draft for description edits — committed on blur.
const descriptionDrafts = ref<Record<number, string>>({});

// Inline link picker — visible when non-null. The number is the subtask id we
// are picking a link target FOR, or `0` for the "new subtask" picker.
const pickerOpenFor = ref<number | null>(null);
const pickerQuery = ref('');
const pickerLoading = ref(false);
const pickerResults = ref<Todo[]>([]);
// Pending link target for the "create new subtask" form.
const newLinkTarget = ref<{ id: number; title: string; status: TodoStatus } | null>(null);

const realItems = computed(() => items.value.filter((s) => s.suggested !== 1));
const suggestedItems = computed(() => items.value.filter((s) => s.suggested === 1));

const progress = computed(() => {
  const total = realItems.value.length;
  // Linked subtasks count when the linked todo is done; standalone use the local flag.
  const done = realItems.value.filter((s) => isSubtaskDone(s)).length;
  return { done, total };
});

function isSubtaskDone(s: Subtask): boolean {
  if (s.linked_todo) return s.linked_todo.status === 'done';
  return s.done === 1;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    items.value = await api.subtasks.byTodo(props.todoId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// Background refresh used by the agent-driven poll. Merges server state into
// the existing list so in-flight edits aren't clobbered and Vue's keyed DOM
// nodes survive (no flicker, no lost focus on the row being edited).
async function refreshInBackground() {
  // Skip while the user is actively editing a row — replacing its title mid-
  // typing would feel hostile. Mutating ops and server writes race naturally;
  // the next tick will reconcile.
  if (editingId.value !== null) return;
  try {
    const fresh = await api.subtasks.byTodo(props.todoId);
    mergeSubtasks(fresh);
  } catch {
    // Non-fatal — agent-driven polling shouldn't surface transient network
    // errors (the initial load() already handles the loud path).
  }
}

function mergeSubtasks(fresh: Subtask[]) {
  const byId = new Map(items.value.map((s) => [s.id, s]));
  const next: Subtask[] = [];
  for (const f of fresh) {
    const existing = byId.get(f.id);
    if (existing) {
      existing.title = f.title;
      existing.description = f.description;
      existing.done = f.done;
      existing.position = f.position;
      existing.suggested = f.suggested;
      existing.linked_todo_id = f.linked_todo_id;
      existing.linked_todo = f.linked_todo;
      next.push(existing);
    } else {
      next.push(f);
    }
  }
  items.value = next;
}

async function acceptSuggestion(s: Subtask) {
  try {
    const updated = await api.subtasks.accept(s.id);
    const idx = items.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) items.value.splice(idx, 1, updated);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function rejectSuggestion(s: Subtask) {
  try {
    await api.subtasks.remove(s.id);
    items.value = items.value.filter((x) => x.id !== s.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function acceptAllSuggestions() {
  const ids = suggestedItems.value.map((s) => s.id);
  for (const id of ids) {
    try {
      const updated = await api.subtasks.accept(id);
      const idx = items.value.findIndex((x) => x.id === id);
      if (idx >= 0) items.value.splice(idx, 1, updated);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return;
    }
  }
}

let pollHandle: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  if (pollHandle !== null) return;
  pollHandle = setInterval(refreshInBackground, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

onMounted(() => {
  void load();
  if (props.agentActive) startPolling();
});
onUnmounted(stopPolling);

watch(() => props.todoId, () => {
  stopPolling();
  expandedIds.value = new Set();
  descriptionDrafts.value = {};
  pickerOpenFor.value = null;
  newLinkTarget.value = null;
  newTitle.value = '';
  void load();
  if (props.agentActive) startPolling();
});

watch(
  () => props.agentActive,
  (active) => {
    if (active) {
      // Kick off an immediate refresh so the first subtask appears without
      // waiting a full interval.
      void refreshInBackground();
      startPolling();
    } else {
      stopPolling();
    }
  },
);

async function addSubtask() {
  const title = newTitle.value.trim();
  // Allow link-only subtasks (no manual title) by reusing the link target's title.
  const finalTitle = title || newLinkTarget.value?.title || '';
  if (!finalTitle) return;
  try {
    const created = await api.subtasks.create(props.todoId, finalTitle, {
      ...(newLinkTarget.value ? { linked_todo_id: newLinkTarget.value.id } : {}),
    });
    items.value.push(created);
    newTitle.value = '';
    newLinkTarget.value = null;
    if (pickerOpenFor.value === 0) pickerOpenFor.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function toggleDone(s: Subtask) {
  // Linked subtasks track the linked todo's status — local toggle is disabled.
  if (s.linked_todo) return;
  const next = s.done === 1 ? 0 : 1;
  // Optimistic update
  s.done = next as 0 | 1;
  try {
    const updated = await api.subtasks.update(s.id, { done: next === 1 });
    const idx = items.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) items.value.splice(idx, 1, updated);
  } catch (e) {
    // Revert on failure
    s.done = (next === 1 ? 0 : 1) as 0 | 1;
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function startEdit(s: Subtask) {
  editingId.value = s.id;
  editBuffer.value = s.title;
}

async function commitEdit(s: Subtask) {
  const title = editBuffer.value.trim();
  if (!title || title === s.title) {
    editingId.value = null;
    return;
  }
  try {
    const updated = await api.subtasks.update(s.id, { title });
    const idx = items.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) items.value.splice(idx, 1, updated);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    editingId.value = null;
  }
}

function cancelEdit() {
  editingId.value = null;
}

async function removeSubtask(s: Subtask) {
  if (!confirm(`Subtask "${s.title}" löschen?`)) return;
  try {
    await api.subtasks.remove(s.id);
    items.value = items.value.filter((x) => x.id !== s.id);
    expandedIds.value.delete(s.id);
    delete descriptionDrafts.value[s.id];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function persistOrder() {
  try {
    // Only real subtasks participate in ordering; suggested ones are transient.
    await api.subtasks.reorder(
      props.todoId,
      realItems.value.map((s) => s.id),
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    await load(); // revert on failure
  }
}

async function moveUp(index: number) {
  if (index <= 0) return;
  const real = realItems.value.slice();
  [real[index - 1], real[index]] = [real[index], real[index - 1]];
  items.value = [...real, ...suggestedItems.value];
  await persistOrder();
}

async function moveDown(index: number) {
  if (index >= realItems.value.length - 1) return;
  const real = realItems.value.slice();
  [real[index], real[index + 1]] = [real[index + 1], real[index]];
  items.value = [...real, ...suggestedItems.value];
  await persistOrder();
}

function toggleExpanded(s: Subtask) {
  if (expandedIds.value.has(s.id)) {
    expandedIds.value.delete(s.id);
    delete descriptionDrafts.value[s.id];
  } else {
    expandedIds.value.add(s.id);
    descriptionDrafts.value[s.id] = s.description ?? '';
  }
}

async function commitDescription(s: Subtask) {
  const draft = (descriptionDrafts.value[s.id] ?? '').trim();
  if (draft === (s.description ?? '')) return;
  try {
    const updated = await api.subtasks.update(s.id, { description: draft });
    const idx = items.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) items.value.splice(idx, 1, updated);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function unlinkSubtask(s: Subtask) {
  try {
    const updated = await api.subtasks.update(s.id, { linked_todo_id: null });
    const idx = items.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) items.value.splice(idx, 1, updated);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function openPickerFor(subtaskId: number) {
  pickerOpenFor.value = subtaskId;
  pickerQuery.value = '';
  pickerResults.value = [];
  await runPickerSearch();
}

function closePicker() {
  pickerOpenFor.value = null;
  pickerQuery.value = '';
  pickerResults.value = [];
}

let pickerSearchSeq = 0;
async function runPickerSearch() {
  const seq = ++pickerSearchSeq;
  pickerLoading.value = true;
  try {
    const params = pickerQuery.value.trim() ? { q: pickerQuery.value.trim() } : undefined;
    const todos = await api.todos.list(params);
    if (seq !== pickerSearchSeq) return; // stale response
    // Exclude self and already-linked subtasks from the list to keep it useful.
    const linkedIds = new Set(
      items.value
        .filter((s) => s.linked_todo_id != null && s.id !== pickerOpenFor.value)
        .map((s) => s.linked_todo_id as number),
    );
    pickerResults.value = todos
      .filter((t) => t.id !== props.todoId && !linkedIds.has(t.id))
      .slice(0, 30);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === pickerSearchSeq) pickerLoading.value = false;
  }
}

async function pickTarget(target: Todo) {
  const subtaskId = pickerOpenFor.value;
  if (subtaskId === null) return;
  if (subtaskId === 0) {
    // New-subtask picker: stash the target, the user submits via the form button.
    newLinkTarget.value = { id: target.id, title: target.title, status: target.status };
    if (!newTitle.value.trim()) newTitle.value = target.title;
    closePicker();
    return;
  }
  try {
    const updated = await api.subtasks.update(subtaskId, { linked_todo_id: target.id });
    const idx = items.value.findIndex((x) => x.id === subtaskId);
    if (idx >= 0) items.value.splice(idx, 1, updated);
    closePicker();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function navigateToLinked(s: Subtask) {
  if (!s.linked_todo) return;
  void router.push(`/todo/${s.linked_todo.id}`);
}
</script>

<template>
  <div class="subtask-list">
    <div v-if="error" class="error-banner">{{ error }}</div>

    <div v-if="realItems.length > 0" class="subtask-progress">
      <span>☑ {{ progress.done }}/{{ progress.total }}</span>
    </div>

    <ul v-if="realItems.length > 0" class="subtask-items">
      <li
        v-for="(s, idx) in realItems"
        :key="s.id"
        class="subtask-row-wrapper"
      >
        <div
          class="subtask-row"
          :class="{ done: isSubtaskDone(s), linked: !!s.linked_todo }"
        >
          <input
            type="checkbox"
            :checked="isSubtaskDone(s)"
            :disabled="!!s.linked_todo"
            :title="s.linked_todo ? 'Status folgt dem verknüpften Todo' : 'Erledigt'"
            @change="toggleDone(s)"
            class="subtask-check"
          />
          <input
            v-if="editingId === s.id"
            v-model="editBuffer"
            type="text"
            class="subtask-edit"
            @keydown.enter.prevent="commitEdit(s)"
            @keydown.escape.prevent="cancelEdit"
            @blur="commitEdit(s)"
            autofocus
          />
          <span
            v-else
            class="subtask-title"
            @click="startEdit(s)"
            :title="'Klicken zum Bearbeiten'"
          >{{ s.title }}</span>

          <span
            v-if="s.linked_todo"
            class="link-chip"
            :title="`Verknüpft mit Todo #${s.linked_todo.id} — ${STATUS_LABELS[s.linked_todo.status]}`"
            @click.stop="navigateToLinked(s)"
          >
            🔗 #{{ s.linked_todo.id }} {{ STATUS_ICONS[s.linked_todo.status] }}
          </span>

          <div class="subtask-actions">
            <button
              type="button"
              class="ghost"
              :class="{ active: expandedIds.has(s.id) }"
              @click="toggleExpanded(s)"
              :title="expandedIds.has(s.id) ? 'Details schließen' : 'Beschreibung & Verknüpfung'"
            >{{ expandedIds.has(s.id) ? '▲' : '⋯' }}</button>
            <button
              type="button"
              class="ghost"
              :disabled="idx === 0"
              @click="moveUp(idx)"
              title="Nach oben"
            >▲</button>
            <button
              type="button"
              class="ghost"
              :disabled="idx === realItems.length - 1"
              @click="moveDown(idx)"
              title="Nach unten"
            >▼</button>
            <button
              type="button"
              class="danger"
              @click="removeSubtask(s)"
              title="Subtask löschen"
            >🗑</button>
          </div>
        </div>

        <div v-if="expandedIds.has(s.id)" class="subtask-detail">
          <label class="detail-label">Beschreibung</label>
          <textarea
            class="subtask-description"
            v-model="descriptionDrafts[s.id]"
            rows="3"
            placeholder="Optionale Notizen oder Kontext zu diesem Subtask…"
            @blur="commitDescription(s)"
          />

          <div class="link-section">
            <label class="detail-label">Verknüpftes Todo</label>
            <div v-if="s.linked_todo" class="link-current">
              <span class="link-current-info" @click="navigateToLinked(s)">
                🔗 #{{ s.linked_todo.id }} · {{ s.linked_todo.title }}
                <span class="link-status">{{ STATUS_ICONS[s.linked_todo.status] }} {{ STATUS_LABELS[s.linked_todo.status] }}</span>
              </span>
              <button class="ghost" type="button" @click="unlinkSubtask(s)" title="Verknüpfung lösen">✕ Lösen</button>
            </div>
            <div v-else-if="pickerOpenFor !== s.id" class="link-empty">
              <span class="link-empty-text">Keine Verknüpfung</span>
              <button class="primary" type="button" @click="openPickerFor(s.id)">🔗 Existierendes Todo verknüpfen</button>
            </div>

            <div v-if="pickerOpenFor === s.id" class="link-picker">
              <div class="picker-header">
                <input
                  v-model="pickerQuery"
                  type="text"
                  placeholder="Todo suchen…"
                  @input="runPickerSearch"
                />
                <button class="ghost" type="button" @click="closePicker">✕</button>
              </div>
              <div v-if="pickerLoading" class="picker-state">Suche…</div>
              <ul v-else-if="pickerResults.length > 0" class="picker-results">
                <li v-for="t in pickerResults" :key="t.id">
                  <button type="button" class="picker-result" @click="pickTarget(t)">
                    <span class="picker-status">{{ STATUS_ICONS[t.status] }}</span>
                    <span class="picker-title">#{{ t.id }} · {{ t.title }}</span>
                    <span class="picker-meta">{{ STATUS_LABELS[t.status] }}</span>
                  </button>
                </li>
              </ul>
              <div v-else class="picker-state">Keine Treffer.</div>
            </div>
          </div>
        </div>
      </li>
    </ul>

    <div v-else-if="!loading && suggestedItems.length === 0" class="empty">Noch keine Subtasks.</div>

    <div v-if="suggestedItems.length > 0" class="suggested-section">
      <div class="suggested-header">
        <span class="suggested-label">
          💡 Vorschläge vom Analyse-Agent
          <span class="suggested-count">({{ suggestedItems.length }})</span>
        </span>
        <button
          class="ghost"
          type="button"
          @click="acceptAllSuggestions"
          title="Alle Vorschläge übernehmen"
        >✓ Alle übernehmen</button>
      </div>
      <ul class="subtask-items">
        <li
          v-for="s in suggestedItems"
          :key="s.id"
          class="subtask-row suggested"
        >
          <span class="suggested-marker" aria-hidden="true">💡</span>
          <span class="subtask-title suggested-title">{{ s.title }}</span>
          <div class="subtask-actions">
            <button
              type="button"
              class="primary"
              @click="acceptSuggestion(s)"
              title="Als Subtask übernehmen"
            >✓ Übernehmen</button>
            <button
              type="button"
              class="ghost"
              @click="rejectSuggestion(s)"
              title="Vorschlag verwerfen"
            >✕ Verwerfen</button>
          </div>
        </li>
      </ul>
    </div>

    <div class="subtask-new">
      <input
        v-model="newTitle"
        type="text"
        :placeholder="newLinkTarget ? `(verknüpft mit #${newLinkTarget.id}) Titel überschreiben…` : 'Neuer Subtask…'"
        @keydown.enter.prevent="addSubtask"
      />
      <button
        class="ghost"
        type="button"
        :title="newLinkTarget ? `Verknüpft mit #${newLinkTarget.id}` : 'Existierendes Todo verknüpfen'"
        @click="newLinkTarget ? (newLinkTarget = null) : openPickerFor(0)"
      >{{ newLinkTarget ? '🔗 ✕' : '🔗' }}</button>
      <button
        class="primary"
        @click="addSubtask"
        :disabled="!newTitle.trim() && !newLinkTarget"
      >+ Neuer Subtask</button>
    </div>

    <div v-if="pickerOpenFor === 0" class="link-picker standalone">
      <div class="picker-header">
        <input
          v-model="pickerQuery"
          type="text"
          placeholder="Todo zum Verknüpfen suchen…"
          @input="runPickerSearch"
          autofocus
        />
        <button class="ghost" type="button" @click="closePicker">✕</button>
      </div>
      <div v-if="pickerLoading" class="picker-state">Suche…</div>
      <ul v-else-if="pickerResults.length > 0" class="picker-results">
        <li v-for="t in pickerResults" :key="t.id">
          <button type="button" class="picker-result" @click="pickTarget(t)">
            <span class="picker-status">{{ STATUS_ICONS[t.status] }}</span>
            <span class="picker-title">#{{ t.id }} · {{ t.title }}</span>
            <span class="picker-meta">{{ STATUS_LABELS[t.status] }}</span>
          </button>
        </li>
      </ul>
      <div v-else class="picker-state">Keine Treffer.</div>
    </div>
  </div>
</template>

<style scoped>
.subtask-list { display: flex; flex-direction: column; gap: 0.5rem; }

.subtask-progress {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--fg-muted);
}

.subtask-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.subtask-row-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.subtask-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
}

.subtask-row.done .subtask-title {
  text-decoration: line-through;
  color: var(--fg-muted);
}

.subtask-row.linked {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

.subtask-check { flex: 0 0 auto; }

.subtask-title {
  flex: 1;
  cursor: text;
  padding: 0.15rem 0.3rem;
  border-radius: 4px;
  min-height: 1.2rem;
}

.subtask-title:hover {
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.subtask-edit {
  flex: 1;
}

.subtask-actions {
  display: flex;
  gap: 0.25rem;
  flex: 0 0 auto;
}

.subtask-actions button {
  padding: 0.1rem 0.4rem;
  font-size: 0.75rem;
}

.subtask-actions button.active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.link-chip {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  cursor: pointer;
  user-select: none;
}

.link-chip:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.subtask-detail {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  margin-left: 1rem;
  border-left: 2px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  background: color-mix(in srgb, var(--accent) 3%, transparent);
  border-radius: 0 var(--radius) var(--radius) 0;
}

.detail-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
  font-weight: 500;
}

.subtask-description {
  width: 100%;
  font-family: inherit;
  font-size: 0.85rem;
  resize: vertical;
  min-height: 3.5rem;
}

.link-section {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.link-empty {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.link-empty-text {
  color: var(--fg-muted);
  font-size: 0.85rem;
}

.link-current {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.link-current-info {
  flex: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
}

.link-current-info:hover {
  text-decoration: underline;
}

.link-status {
  color: var(--fg-muted);
  font-size: 0.78rem;
}

.link-picker {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
}

.link-picker.standalone {
  margin-top: 0.4rem;
}

.picker-header {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.picker-header input {
  flex: 1;
}

.picker-state {
  font-size: 0.85rem;
  color: var(--fg-muted);
  padding: 0.3rem 0.2rem;
}

.picker-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-height: 16rem;
  overflow-y: auto;
}

.picker-result {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  padding: 0.35rem 0.5rem;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.85rem;
}

.picker-result:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}

.picker-status {
  flex: 0 0 auto;
}

.picker-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-meta {
  flex: 0 0 auto;
  color: var(--fg-muted);
  font-size: 0.75rem;
}

.subtask-new {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.subtask-new input { flex: 1; }

.suggested-section {
  margin-top: 0.6rem;
  padding: 0.5rem;
  border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--border));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 4%, transparent);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.suggested-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.suggested-label {
  font-size: 0.85rem;
  font-weight: 500;
}

.suggested-count {
  color: var(--fg-muted);
  font-weight: normal;
  font-size: 0.78rem;
}

.subtask-row.suggested {
  border-style: dashed;
  background: transparent;
}

.suggested-marker {
  flex: 0 0 auto;
  font-size: 1rem;
}

.suggested-title {
  font-style: italic;
  color: var(--fg);
}
</style>
