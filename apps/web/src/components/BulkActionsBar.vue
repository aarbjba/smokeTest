<script setup lang="ts">
import { ref } from 'vue';
import { useSelectionStore } from '../stores/selection';
import { useTodosStore } from '../stores/todos';
import { api } from '../api';
import type { TodoStatus } from '../types';
import { STATUS_LABELS, STATUS_ICONS } from '../types';

const selection = useSelectionStore();
const todos = useTodosStore();

const tagInput = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const statuses: TodoStatus[] = ['todo', 'in_progress', 'test', 'done'];

async function bulkMove(status: TodoStatus) {
  if (selection.count === 0 || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const ids = [...selection.ids];
    await api.todos.bulk(ids, 'move', { status });
    await todos.fetchAll();
    selection.clear();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function bulkTag() {
  const tag = tagInput.value.trim();
  if (!tag || selection.count === 0 || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const ids = [...selection.ids];
    await api.todos.bulk(ids, 'tag', { tag });
    await todos.fetchAll();
    tagInput.value = '';
    // Keep the selection — user may want to chain another action.
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function bulkDelete() {
  if (selection.count === 0 || busy.value) return;
  if (!confirm(`${selection.count} Aufgabe${selection.count === 1 ? '' : 'n'} wirklich löschen?`)) return;
  busy.value = true;
  error.value = null;
  try {
    const ids = [...selection.ids];
    await api.todos.bulk(ids, 'delete');
    await todos.fetchAll();
    selection.clear();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="selection.hasAny" class="bulk-bar" role="region" aria-label="Mehrfachauswahl-Aktionen">
    <div class="bulk-count">
      <strong>{{ selection.count }}</strong>
      <span>{{ selection.count === 1 ? 'Aufgabe' : 'Aufgaben' }} ausgewählt</span>
      <button class="ghost" @click="selection.clear()" title="Auswahl leeren">✕</button>
    </div>

    <div class="bulk-actions">
      <label class="bulk-move">
        <span>Verschieben zu:</span>
        <select :disabled="busy" @change="(e) => { const v = (e.target as HTMLSelectElement).value as TodoStatus; if (v) bulkMove(v); (e.target as HTMLSelectElement).value = ''; }">
          <option value="">— wählen —</option>
          <option v-for="s in statuses" :key="s" :value="s">
            {{ STATUS_ICONS[s] }} {{ STATUS_LABELS[s] }}
          </option>
        </select>
      </label>

      <form class="bulk-tag" @submit.prevent="bulkTag">
        <input
          v-model="tagInput"
          type="text"
          placeholder="tag"
          :disabled="busy"
          style="max-width: 8rem;"
        />
        <button type="submit" :disabled="busy || !tagInput.trim()" class="ghost">+ Tag</button>
      </form>

      <button class="danger" :disabled="busy" @click="bulkDelete">
        🗑 Löschen
      </button>
    </div>

    <div v-if="error" class="bulk-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.bulk-bar {
  position: fixed;
  left: 50%;
  bottom: 1.25rem;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.6rem 0.9rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  z-index: 900;
  max-width: calc(100vw - 2rem);
  flex-wrap: wrap;
}
.bulk-count {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
}
.bulk-count strong {
  font-size: 1rem;
  color: var(--accent, #f59e0b);
}
.bulk-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.bulk-move,
.bulk-tag {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
}
.bulk-error {
  flex-basis: 100%;
  color: var(--danger, #ef4444);
  font-size: 0.8rem;
}
</style>
