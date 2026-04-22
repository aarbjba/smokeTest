<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useViewsStore, type SavedView, type SavedViewFilters } from '../stores/views';
import { useTodosStore } from '../stores/todos';
import type { SourceFilter } from '../types';

const props = defineProps<{
  /** Local search ref value from BoardView, so "Speichern als…" can snapshot it. */
  search: string;
}>();

const emit = defineEmits<{
  (e: 'apply-search', value: string): void;
}>();

const views = useViewsStore();
const todos = useTodosStore();

onMounted(() => {
  if (!views.loaded) void views.load();
});

/** Snapshot of the currently applied board filters. */
const currentFilters = computed<SavedViewFilters>(() => ({
  sourceFilter: todos.sourceFilter,
  search: props.search,
  tags: [...todos.activeTags],
  repos: [...todos.activeRepos],
}));

function normalisedKey(f: SavedViewFilters): string {
  const sortedTags = f.tags && f.tags.length > 0 ? [...f.tags].sort() : undefined;
  const sortedRepos = f.repos && f.repos.length > 0 ? [...f.repos].sort() : undefined;
  return JSON.stringify({
    sourceFilter: f.sourceFilter === 'all' ? undefined : f.sourceFilter,
    search: f.search && f.search.trim() !== '' ? f.search : undefined,
    tags: sortedTags,
    repos: sortedRepos,
  });
}

// Auto-clear the active highlight as soon as the applied filters no longer
// match the active view (e.g. the user edited the search box manually).
watch(currentFilters, (now) => {
  if (!views.activeId) return;
  const active = views.byId(views.activeId);
  if (!active) { views.activeId = null; return; }
  if (normalisedKey(now) !== normalisedKey(active.filters)) {
    views.activeId = null;
  }
}, { deep: true });

function applyView(v: SavedView) {
  const sf = (v.filters.sourceFilter ?? 'all') as SourceFilter;
  todos.setSourceFilter(sf);
  todos.setActiveTags(v.filters.tags ?? []);
  todos.setActiveRepos(v.filters.repos ?? []);
  const search = v.filters.search ?? '';
  todos.search = search;
  emit('apply-search', search);
  views.setActive(v.id);
}

async function onSaveAs() {
  const name = window.prompt('Name für diese Ansicht?', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  await views.create(trimmed, {
    sourceFilter: todos.sourceFilter,
    search: props.search,
    tags: [...todos.activeTags],
    repos: [...todos.activeRepos],
  });
}

async function onDelete(v: SavedView, ev?: Event) {
  ev?.stopPropagation();
  ev?.preventDefault();
  if (!window.confirm(`Ansicht "${v.name}" löschen?`)) return;
  await views.remove(v.id);
}

function onContextMenu(v: SavedView, ev: MouseEvent) {
  ev.preventDefault();
  void onDelete(v, ev);
}
</script>

<template>
  <div class="saved-views-bar" role="group" aria-label="Gespeicherte Ansichten">
    <button
      v-for="v in views.views"
      :key="v.id"
      class="saved-view-chip"
      :class="{ active: views.activeId === v.id }"
      :aria-pressed="views.activeId === v.id"
      :title="v.name"
      @click="applyView(v)"
      @contextmenu="onContextMenu(v, $event)"
    >
      <span class="saved-view-label">{{ v.name }}</span>
      <span
        class="saved-view-x"
        role="button"
        aria-label="Löschen"
        title="Löschen"
        @click="onDelete(v, $event)"
      >×</span>
    </button>

    <button
      class="saved-view-save-as ghost"
      type="button"
      :title="'Aktuelle Filter als Ansicht speichern'"
      @click="onSaveAs"
    >+ Speichern als…</button>
  </div>
</template>

<style scoped>
.saved-views-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
  padding: 0.25rem 0;
}

.saved-view-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.65rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--fg-muted);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.saved-view-chip:hover {
  background: var(--bg-elev);
  border-color: var(--accent-2);
  color: var(--fg);
}
.saved-view-chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.saved-view-label {
  line-height: 1;
}

.saved-view-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 999px;
  font-size: 1rem;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.1s, background 0.15s;
  cursor: pointer;
}
.saved-view-chip:hover .saved-view-x,
.saved-view-chip.active .saved-view-x {
  opacity: 0.8;
}
.saved-view-x:hover {
  opacity: 1 !important;
  background: rgba(0, 0, 0, 0.2);
}

.saved-view-save-as {
  font-size: 0.8rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  border: 1px dashed var(--border);
  color: var(--fg-muted);
}
.saved-view-save-as:hover {
  border-style: solid;
  border-color: var(--accent-2);
  color: var(--fg);
}
</style>
