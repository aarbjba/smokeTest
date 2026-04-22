<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue';
import { api } from '../api';
import type { Subtask } from '../types';

const props = withDefaults(
  defineProps<{ todoId: number; agentActive?: boolean }>(),
  { agentActive: false },
);

const POLL_INTERVAL_MS = 5000;

const items = ref<Subtask[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const newTitle = ref('');
const editingId = ref<number | null>(null);
const editBuffer = ref('');

const realItems = computed(() => items.value.filter((s) => s.suggested !== 1));
const suggestedItems = computed(() => items.value.filter((s) => s.suggested === 1));

const progress = computed(() => {
  const total = realItems.value.length;
  const done = realItems.value.filter((s) => s.done === 1).length;
  return { done, total };
});

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
      existing.done = f.done;
      existing.position = f.position;
      existing.suggested = f.suggested;
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
  if (!title) return;
  try {
    const created = await api.subtasks.create(props.todoId, title);
    items.value.push(created);
    newTitle.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function toggleDone(s: Subtask) {
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
        class="subtask-row"
        :class="{ done: s.done === 1 }"
      >
        <input
          type="checkbox"
          :checked="s.done === 1"
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

        <div class="subtask-actions">
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
        placeholder="Neuer Subtask…"
        @keydown.enter.prevent="addSubtask"
      />
      <button class="primary" @click="addSubtask" :disabled="!newTitle.trim()">+ Neuer Subtask</button>
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
