<script setup lang="ts">
import { computed } from 'vue';
import { useTodosStore } from '../stores/todos';
import type { SourceFilter, TaskType } from '../types';
import { TASK_TYPE_LABELS, TASK_TYPE_ICONS } from '../types';
import FilterPicker from './FilterPicker.vue';

const todos = useTodosStore();

const filters: { id: SourceFilter; label: string; icon: string }[] = [
  { id: 'all',    label: 'Alle',   icon: '∗' },
  { id: 'local',  label: 'Eigen',  icon: '✏️' },
  { id: 'github', label: 'GitHub', icon: '⛓' },
  { id: 'jira',   label: 'Jira',   icon: '📋' },
];

function countFor(id: SourceFilter): number {
  if (id === 'all') return todos.items.length;
  return todos.counts[id] ?? 0;
}

const tagOptions = computed(() => todos.tagsWithCounts);
const repoOptions = computed(() => todos.reposWithCounts);

// Expose TaskType options as {value, count} with prettified German labels.
// FilterPicker speaks strings, so we pass the enum slug as value and render
// "<icon> <label>" in the display. Selection state is likewise enum slugs.
const typeOptions = computed(() =>
  todos.typesWithCounts.map((t) => ({
    value: t.value,
    label: `${TASK_TYPE_ICONS[t.value]} ${TASK_TYPE_LABELS[t.value]}`,
    count: t.count,
  })),
);

function onToggleTag(tag: string) { todos.toggleTag(tag); }
function onClearTags() { todos.setActiveTags([]); }
function onToggleRepo(repo: string) { todos.toggleRepo(repo); }
function onClearRepos() { todos.setActiveRepos([]); }
function onToggleType(type: string) { todos.toggleType(type as TaskType); }
function onClearTypes() { todos.setActiveTypes([]); }

function onResetAll() { todos.clearAllFilters(); }
</script>

<template>
  <div class="filter-group">
    <div class="filter-bar" role="group" aria-label="Filter nach Quelle">
      <button
        v-for="f in filters"
        :key="f.id"
        :class="{ active: todos.sourceFilter === f.id }"
        :aria-pressed="todos.sourceFilter === f.id"
        @click="todos.setSourceFilter(f.id)"
      >
        <span>{{ f.icon }}</span>
        <span>{{ f.label }}</span>
        <span class="count">{{ countFor(f.id) }}</span>
      </button>
    </div>

    <FilterPicker
      label="Tags"
      icon="🏷"
      :options="tagOptions"
      :selected="todos.activeTags"
      empty-text="Noch keine Tags vorhanden"
      placeholder="Tag suchen…"
      @toggle="onToggleTag"
      @clear="onClearTags"
    />

    <FilterPicker
      label="Repos"
      icon="📦"
      :options="repoOptions"
      :selected="todos.activeRepos"
      empty-text="Keine Repos verknüpft"
      placeholder="Repo suchen…"
      @toggle="onToggleRepo"
      @clear="onClearRepos"
    />

    <FilterPicker
      label="Typ"
      icon="🏗"
      :options="typeOptions"
      :selected="todos.activeTypes"
      empty-text="Keine Typen vorhanden"
      placeholder="Typ suchen…"
      @toggle="onToggleType"
      @clear="onClearTypes"
    />

    <button
      v-if="todos.activeFilterCount > 0"
      type="button"
      class="reset-filters"
      :title="`${todos.activeFilterCount} Filter aktiv — alle zurücksetzen`"
      @click="onResetAll"
    >
      <span class="reset-count">{{ todos.activeFilterCount }}</span>
      <span>× Zurücksetzen</span>
    </button>
  </div>
</template>

<style scoped>
.filter-group {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.reset-filters {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--fg-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.reset-filters:hover {
  color: var(--fg);
  border-color: var(--accent-2);
  border-style: solid;
}
.reset-filters .reset-count {
  background: var(--accent);
  color: #fff;
  border-radius: 999px;
  padding: 0 0.4rem;
  font-size: 0.7rem;
  min-width: 1.2rem;
  text-align: center;
  line-height: 1.4;
}
</style>
