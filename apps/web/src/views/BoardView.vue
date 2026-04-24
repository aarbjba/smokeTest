<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTodosStore } from '../stores/todos';
import { BOARD_STATUSES, type TodoStatus } from '../types';
import { api } from '../api';
import Column from '../components/Column.vue';
import NewTodoForm from '../components/NewTodoForm.vue';
import FilterBar from '../components/FilterBar.vue';
import SavedViewsBar from '../components/SavedViewsBar.vue';
import StandupButton from '../components/StandupButton.vue';
import BulkActionsBar from '../components/BulkActionsBar.vue';

const todos = useTodosStore();
const router = useRouter();
// `pending` is handled by the Pendliste view (/pending), not the board.
const statuses: TodoStatus[] = BOARD_STATUSES;
const search = ref(todos.search ?? '');
const newTodoForm = ref<InstanceType<typeof NewTodoForm> | null>(null);

const fileDragOver = ref(false);
const dropFlash = ref<string | null>(null);
let dragCounter = 0;
let refreshTimer: number | null = null;

onMounted(() => {
  void todos.fetchAll();
  window.addEventListener('keydown', onKeydown);
  // Auto-refresh every 60s so new tickets from the backend scheduler appear automatically.
  refreshTimer = window.setInterval(() => { void todos.fetchAll(); }, 60_000);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (refreshTimer) clearInterval(refreshTimer);
});

function onKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'n' && ev.key !== 'N') return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const active = document.activeElement as HTMLElement | null;
  if (active) {
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) return;
  }
  ev.preventDefault();
  newTodoForm.value?.focus();
}

function onSearch() { todos.search = search.value; }

function onApplySearch(value: string) { search.value = value; }

async function onColumnDropTodo(id: number, status: TodoStatus) {
  try { await todos.move(id, status); } catch (e) { console.error(e); }
}

async function onColumnDropCard(draggedId: number, targetId: number, position: 'before' | 'after', status: TodoStatus) {
  // Compute new order for the target column.
  const currentIds = todos.byStatus(status).map((t) => t.id).filter((id) => id !== draggedId);
  const targetIdx = currentIds.indexOf(targetId);
  if (targetIdx < 0) return; // target was filtered out?
  const insertAt = position === 'before' ? targetIdx : targetIdx + 1;
  const newOrder = [...currentIds.slice(0, insertAt), draggedId, ...currentIds.slice(insertAt)];

  const dragged = todos.byId(draggedId);
  try {
    if (dragged && dragged.status !== status) await todos.update(draggedId, { status });
    await todos.reorderInColumn(status, newOrder);
  } catch (e) { console.error(e); }
}

async function onColumnDropFiles(files: File[], status: TodoStatus) {
  await createTodoFromFiles(files, status);
}

// ---------------- Outer board drop (fallback when not on a column) ----------------

function isFileDrag(ev: DragEvent): boolean {
  return ev.dataTransfer?.types.includes('Files') ?? false;
}

function onDragEnter(ev: DragEvent) {
  if (!isFileDrag(ev)) return;
  dragCounter++;
  fileDragOver.value = true;
}
function onDragOver(ev: DragEvent) {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
}
function onDragLeave() {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) fileDragOver.value = false;
}
async function onDrop(ev: DragEvent) {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  fileDragOver.value = false;
  dragCounter = 0;

  const files = ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
  if (files.length === 0) return;

  // If the drop landed inside a column, the column's onDrop handles it and
  // stops propagation; this fallback only runs for drops outside columns.
  const target = ev.target as HTMLElement | null;
  const col = target?.closest('[data-status]') as HTMLElement | null;
  const status = (col?.dataset.status as TodoStatus | undefined) ?? 'todo';
  await createTodoFromFiles(files, status);
}

// ---------------- Create todo from files ----------------

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

async function createTodoFromFiles(files: File[], status: TodoStatus) {
  const first = files[0];
  const title = files.length === 1
    ? `📎 ${first.name}`
    : `📎 ${first.name} (+${files.length - 1} weitere)`;
  const descLines: string[] = ['**Angeheftete Dateien:**', ''];
  for (const f of files) {
    descLines.push(`- \`${f.name}\` — ${humanSize(f.size)}${f.type ? ` · ${f.type}` : ''}`);
  }
  const tags = Array.from(new Set(files.map((f) => extOf(f.name)).filter(Boolean)));

  try {
    const todo = await todos.create({ title, description: descLines.join('\n'), tags, status });
    await api.attachments.upload(todo.id, files);
    await todos.fetchAll();
    flash(`${files.length} Datei${files.length === 1 ? '' : 'en'} angeheftet → ${status}`);
  } catch (e) {
    flash(`Fehler beim Anheften: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function flash(msg: string, isError = false) {
  dropFlash.value = (isError ? '⚠️ ' : '✅ ') + msg;
  setTimeout(() => { dropFlash.value = null; }, 3500);
}
</script>

<template>
  <div
    class="board-wrapper"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="row board-topbar">
      <input
        v-model="search"
        type="search"
        placeholder="🔍 Suchen in Titel / Beschreibung..."
        @input="onSearch"
        style="max-width: 24rem;"
      />
      <FilterBar />
      <div class="spacer" style="flex: 1;" />
      <StandupButton />
      <button
        class="primary"
        title="Neue Aufgabe mit vollständigem Formular erstellen"
        @click="router.push('/todo/new')"
      >
        ➕ Neue Aufgabe
      </button>
      <button class="ghost" @click="todos.fetchAll()" :disabled="todos.loading">
        {{ todos.loading ? 'Lade…' : '↻ Aktualisieren' }}
      </button>
    </div>

    <SavedViewsBar :search="search" @apply-search="onApplySearch" />

    <NewTodoForm ref="newTodoForm" />

    <div v-if="dropFlash" class="flash" :class="{ error: dropFlash.startsWith('⚠️') }">{{ dropFlash }}</div>
    <div v-if="todos.error" class="error-banner">{{ todos.error }}</div>

    <div class="board" :class="{ 'file-drag-over': fileDragOver }">
      <Column
        v-for="s in statuses"
        :key="s"
        :status="s"
        :todos="todos.byStatus(s)"
        @drop-todo="onColumnDropTodo"
        @drop-card="onColumnDropCard"
        @drop-files="onColumnDropFiles"
      />
    </div>

    <div v-if="fileDragOver" class="file-drop-hint">
      📎 Datei auf eine Spalte ziehen → neue Aufgabe in der Spalte
    </div>

    <BulkActionsBar />
  </div>
</template>
