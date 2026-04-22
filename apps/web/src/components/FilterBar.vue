<script setup lang="ts">
import { useTodosStore } from '../stores/todos';
import type { SourceFilter } from '../types';

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
</script>

<template>
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
</template>
