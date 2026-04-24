<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import type { Todo, Subtask } from '../types';
import { SOURCE_ICON, SOURCE_LABEL, TASK_TYPE_ICONS, TASK_TYPE_LABELS } from '../types';
import { useTodosStore } from '../stores/todos';

const router = useRouter();
const todosStore = useTodosStore();

const loading = ref(true);
const error = ref<string | null>(null);
// Subtasks per todo. Loaded lazily (once per todo on mount) so the page shows
// both open questions (title starts with `[?]`) and other outstanding work.
const subtasksByTodo = ref<Record<number, Subtask[]>>({});

const pendingTodos = computed<Todo[]>(() =>
  todosStore.items
    .filter((t) => t.status === 'pending' && !t.deleted_at)
    .slice()
    .sort((a, b) => {
      const ua = new Date(a.updated_at).getTime();
      const ub = new Date(b.updated_at).getTime();
      return ub - ua;
    }),
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    await todosStore.fetchAll();
    // Fan out subtask fetches in parallel — Pendliste is usually small.
    const entries = await Promise.all(
      pendingTodos.value.map(async (t): Promise<[number, Subtask[]]> => {
        try {
          const rows = await api.subtasks.byTodo(t.id);
          return [t.id, rows];
        } catch {
          return [t.id, []];
        }
      }),
    );
    const next: Record<number, Subtask[]> = {};
    for (const [id, rows] of entries) next[id] = rows;
    subtasksByTodo.value = next;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openTodos(id: number) {
  router.push({ name: 'todo', params: { id } });
}

// Open questions: the analyse-agent marks subtasks that need user input with
// a `[?]` prefix in the title. We surface those as the "Fehlende Infos" group
// — everything else is collected info / follow-ups.
function openQuestions(todo: Todo): Subtask[] {
  const rows = subtasksByTodo.value[todo.id] ?? [];
  return rows.filter((s) => !s.done && /^\s*\[\?\]/.test(s.title));
}

function otherSubtasks(todo: Todo): Subtask[] {
  const rows = subtasksByTodo.value[todo.id] ?? [];
  return rows.filter((s) => !/^\s*\[\?\]/.test(s.title));
}

function countOpenQuestions(todo: Todo): number {
  return openQuestions(todo).length;
}

async function moveBack(id: number) {
  try {
    await todosStore.update(id, { status: 'todo' });
    // Todo is no longer pending — let the computed filter drop it automatically,
    // and clean up the cached subtasks.
    delete subtasksByTodo.value[id];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}

function stripQuestionPrefix(title: string): string {
  return title.replace(/^\s*\[\?\]\s*/, '');
}
</script>

<template>
  <div class="pendliste">
    <div class="pendliste-header">
      <h1>📥 Pendliste</h1>
      <p class="pendliste-sub">
        Aufgaben, bei denen der Analyse-Agent noch fehlende Infos gesammelt hat. Sobald die
        offenen Fragen beantwortet sind, kannst du die Aufgabe zurück auf die Werkbank schieben.
      </p>
      <div class="header-actions">
        <button class="ghost" :disabled="loading" @click="load">⟳ Neu laden</button>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div v-if="loading" class="pendliste-empty">Lade…</div>
    <div v-else-if="pendingTodos.length === 0" class="pendliste-empty">
      Keine Aufgaben in der Pendliste. Wenn der Analyse-Agent offene Fragen hat, landen sie hier.
    </div>

    <ul v-else class="pendliste-list">
      <li v-for="t in pendingTodos" :key="t.id" class="pendliste-card">
        <header class="pendliste-card-header">
          <button
            class="ghost pendliste-title-btn"
            :title="'Details öffnen (#' + t.id + ')'"
            @click="openTodos(t.id)"
          >
            <span class="source-tag" :title="SOURCE_LABEL[t.source]">{{ SOURCE_ICON[t.source] }}</span>
            <span v-if="t.task_type" class="tasktype-tag" :title="TASK_TYPE_LABELS[t.task_type]">
              {{ TASK_TYPE_ICONS[t.task_type] }}
            </span>
            <span class="pendliste-title">{{ t.title }}</span>
          </button>
          <span
            v-if="countOpenQuestions(t) > 0"
            class="pendliste-badge"
            :title="countOpenQuestions(t) + ' offene Rückfrage' + (countOpenQuestions(t) === 1 ? '' : 'n')"
          >❓ {{ countOpenQuestions(t) }}</span>
        </header>

        <p v-if="t.description && t.description.trim()" class="pendliste-desc">
          {{ t.description.trim().slice(0, 240) }}{{ t.description.trim().length > 240 ? '…' : '' }}
        </p>

        <section v-if="openQuestions(t).length > 0" class="pendliste-questions">
          <h3>Fehlende Infos</h3>
          <ul>
            <li v-for="q in openQuestions(t)" :key="q.id">
              <strong>{{ stripQuestionPrefix(q.title) }}</strong>
              <div v-if="q.description && q.description.trim()" class="pendliste-question-desc">
                {{ q.description.trim() }}
              </div>
            </li>
          </ul>
        </section>

        <section v-if="otherSubtasks(t).length > 0" class="pendliste-subtasks">
          <h3>Weitere Subtasks</h3>
          <ul>
            <li
              v-for="s in otherSubtasks(t)"
              :key="s.id"
              :class="{ done: s.done, suggested: s.suggested }"
            >
              <span class="pendliste-mark">{{ s.done ? '☑' : s.suggested ? '💡' : '☐' }}</span>
              {{ s.title }}
            </li>
          </ul>
        </section>

        <footer class="pendliste-card-footer">
          <span class="pendliste-meta">Aktualisiert: {{ formatDate(t.updated_at) }}</span>
          <div class="pendliste-actions">
            <button class="ghost" @click="openTodos(t.id)">Details</button>
            <button
              class="primary"
              :title="'Zurück auf die Werkbank (Status → todo)'"
              @click="moveBack(t.id)"
            >↩ Auf Werkbank</button>
          </div>
        </footer>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pendliste {
  max-width: 72rem;
  margin: 0 auto;
  padding: 1rem 1.25rem 2rem;
}
.pendliste-header {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
}
.pendliste-header h1 {
  margin: 0;
}
.pendliste-sub {
  margin: 0;
  color: var(--fg-muted);
  font-size: 0.9rem;
  max-width: 60ch;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.pendliste-empty {
  padding: 2rem 0;
  color: var(--fg-muted);
  text-align: center;
  font-style: italic;
}
.pendliste-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.pendliste-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.pendliste-card-header {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
}
.pendliste-title-btn {
  flex: 1;
  justify-content: flex-start;
  font-size: 1rem;
  font-weight: 600;
  text-align: left;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.pendliste-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.source-tag,
.tasktype-tag {
  font-size: 0.9rem;
  color: var(--fg-muted);
}
.pendliste-badge {
  background: color-mix(in srgb, var(--warning) 25%, var(--bg-elev));
  color: var(--warning);
  border: 1px solid var(--warning);
  border-radius: 999px;
  padding: 0.1rem 0.6rem;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}
.pendliste-desc {
  margin: 0;
  color: var(--fg-muted);
  font-size: 0.88rem;
  white-space: pre-wrap;
}
.pendliste-questions,
.pendliste-subtasks {
  border-top: 1px dashed var(--border);
  padding-top: 0.5rem;
}
.pendliste-questions h3,
.pendliste-subtasks h3 {
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
}
.pendliste-questions ul,
.pendliste-subtasks ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.pendliste-questions li {
  font-size: 0.9rem;
}
.pendliste-question-desc {
  color: var(--fg-muted);
  font-size: 0.82rem;
  margin-top: 0.15rem;
  padding-left: 0.25rem;
}
.pendliste-subtasks li {
  font-size: 0.85rem;
  color: var(--fg);
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
}
.pendliste-subtasks li.done {
  color: var(--fg-muted);
  text-decoration: line-through;
}
.pendliste-subtasks li.suggested {
  font-style: italic;
  color: var(--fg-muted);
}
.pendliste-mark {
  font-family: var(--font-mono);
  color: var(--fg-muted);
}
.pendliste-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-top: 0.25rem;
}
.pendliste-meta {
  font-size: 0.78rem;
  color: var(--fg-muted);
}
.pendliste-actions {
  display: flex;
  gap: 0.4rem;
}
</style>
