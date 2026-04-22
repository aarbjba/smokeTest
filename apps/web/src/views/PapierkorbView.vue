<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import type { Todo } from '../types';
import { STATUS_ICONS, STATUS_LABELS, SOURCE_ICON, SOURCE_LABEL } from '../types';
import { useTodosStore } from '../stores/todos';

const router = useRouter();
const todos = useTodosStore();

const items = ref<Todo[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref(false);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    items.value = await api.todos.listTrash();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function restore(id: number) {
  if (busy.value) return;
  busy.value = true;
  try {
    await todos.restore(id);
    items.value = items.value.filter((t) => t.id !== id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function purge(id: number) {
  if (busy.value) return;
  if (!confirm('Endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.')) return;
  busy.value = true;
  try {
    await todos.purge(id);
    items.value = items.value.filter((t) => t.id !== id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function emptyTrash() {
  if (items.value.length === 0 || busy.value) return;
  if (!confirm(`Papierkorb leeren? ${items.value.length} Aufgabe${items.value.length === 1 ? '' : 'n'} werden endgültig gelöscht.`)) return;
  busy.value = true;
  try {
    await api.todos.emptyTrash();
    items.value = [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function open(id: number) {
  router.push({ name: 'todo', params: { id } });
}

function formatDeletedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC). Normalize to Date.
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}
</script>

<template>
  <div class="papierkorb">
    <div class="papierkorb-header">
      <h1>🗑 Papierkorb</h1>
      <div class="header-actions">
        <button class="ghost" @click="load" :disabled="busy">⟳ Neu laden</button>
        <button
          class="danger"
          :disabled="busy || items.length === 0"
          @click="emptyTrash"
          :title="items.length === 0 ? 'Papierkorb ist leer' : 'Alle endgültig löschen'"
        >
          Papierkorb leeren
        </button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="empty">Lade…</div>

    <div v-else-if="items.length === 0" class="empty">
      Der Papierkorb ist leer.
    </div>

    <ul v-else class="trash-list">
      <li v-for="t in items" :key="t.id" class="trash-item">
        <div class="trash-main" @click="open(t.id)">
          <div class="trash-title">
            <span :title="STATUS_LABELS[t.status]">{{ STATUS_ICONS[t.status] }}</span>
            <span class="title-text">{{ t.title }}</span>
          </div>
          <div class="trash-meta">
            <span class="tag" :title="SOURCE_LABEL[t.source]">{{ SOURCE_ICON[t.source] }} {{ SOURCE_LABEL[t.source] }}</span>
            <span v-if="t.deleted_at" class="tag">
              Gelöscht: {{ formatDeletedAt(t.deleted_at) }}
            </span>
            <span v-for="tag in t.tags.slice(0, 4)" :key="tag" class="tag">#{{ tag }}</span>
          </div>
        </div>
        <div class="trash-actions">
          <button class="primary" :disabled="busy" @click.stop="restore(t.id)">Wiederherstellen</button>
          <button class="danger" :disabled="busy" @click.stop="purge(t.id)" title="Endgültig löschen">🗑</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.papierkorb {
  max-width: 1200px;
  width: min(100%, 1200px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.papierkorb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.papierkorb-header h1 {
  margin: 0;
  font-family: var(--font-display);
}
.header-actions { display: flex; gap: 0.5rem; }

.empty {
  padding: 2rem 1rem;
  color: var(--fg-muted);
  text-align: center;
  font-style: italic;
}

.trash-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.trash-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.trash-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.trash-main:hover .title-text { text-decoration: underline; }
.trash-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
}
.title-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trash-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--fg-muted);
}
.trash-actions {
  display: flex;
  gap: 0.4rem;
  flex: 0 0 auto;
}
</style>
