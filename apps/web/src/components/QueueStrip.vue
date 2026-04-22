<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQueueStore } from '../stores/queue';
import type { QueueItem } from '../types';

/**
 * Collapsible queue strip. Shows the queued todos in run order.
 *
 * Layout: a row that sits between the topbar and the main content. Hidden
 * completely when the queue is empty (to not waste vertical space on the board).
 *
 * Drag-reorder: native HTML5 DnD. We track a dragging todo_id and, on drop,
 * splice the list locally, then call store.reorder() which re-fetches from
 * the server to get the authoritative 0..N-1 positions back.
 */
const queue = useQueueStore();
const router = useRouter();

const collapsed = ref(false);
const dragTodoId = ref<number | null>(null);

const items = computed<QueueItem[]>(() => queue.items);

onMounted(() => {
  queue.startPolling();
});
onUnmounted(() => {
  queue.stopPolling();
});

function openTodo(id: number) {
  void router.push(`/todo/${id}`);
}

async function remove(id: number) {
  try {
    await queue.dequeue(id);
  } catch (e) {
    console.warn('[queue] dequeue failed', e);
  }
}

function onDragStart(e: DragEvent, todoId: number) {
  dragTodoId.value = todoId;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs data set to start the drag.
    e.dataTransfer.setData('text/plain', String(todoId));
  }
}

function onDragOver(e: DragEvent) {
  if (dragTodoId.value === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}

async function onDrop(e: DragEvent, dropTargetId: number) {
  e.preventDefault();
  const src = dragTodoId.value;
  dragTodoId.value = null;
  if (src === null || src === dropTargetId) return;

  const order = queue.items.map((q) => q.todo_id);
  const fromIdx = order.indexOf(src);
  const toIdx = order.indexOf(dropTargetId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = order.splice(fromIdx, 1);
  order.splice(toIdx, 0, moved);
  try {
    await queue.reorder(order);
  } catch (err) {
    console.warn('[queue] reorder failed', err);
  }
}

function onDragEnd() {
  dragTodoId.value = null;
}
</script>

<template>
  <div v-if="items.length > 0" class="queue-strip" :class="{ collapsed }">
    <button
      type="button"
      class="queue-toggle ghost"
      :title="collapsed ? 'Warteschlange einblenden' : 'Warteschlange einklappen'"
      @click="collapsed = !collapsed"
    >
      <span class="queue-chip">📥 Warteschlange</span>
      <span class="queue-count">{{ items.length }}</span>
      <span class="queue-caret" :aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
    </button>

    <ol v-if="!collapsed" class="queue-list">
      <li
        v-for="(item, idx) in items"
        :key="item.todo_id"
        class="queue-item"
        :class="{ dragging: dragTodoId === item.todo_id }"
        draggable="true"
        :title="`Position ${idx + 1} — klicken zum Öffnen`"
        @dragstart="(e) => onDragStart(e, item.todo_id)"
        @dragover="onDragOver"
        @drop="(e) => onDrop(e, item.todo_id)"
        @dragend="onDragEnd"
      >
        <span class="queue-pos">{{ idx + 1 }}</span>
        <button type="button" class="queue-title ghost" @click="openTodo(item.todo_id)">
          {{ item.title }}
        </button>
        <button
          type="button"
          class="queue-remove ghost"
          title="Aus der Warteschlange entfernen"
          @click.stop="remove(item.todo_id)"
        >
          ✕
        </button>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.queue-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 1rem;
  background: var(--bg-elev, #1e1e1e);
  border-bottom: 1px solid var(--border, #333);
  font-size: 0.85rem;
}
.queue-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--border, #333);
  border-radius: 999px;
  background: var(--bg, #151515);
  cursor: pointer;
}
.queue-count {
  display: inline-block;
  min-width: 1.4em;
  padding: 0 0.35em;
  border-radius: 999px;
  background: var(--accent, #3c7);
  color: var(--bg, #111);
  font-weight: 600;
  text-align: center;
  font-size: 0.75rem;
}
.queue-caret {
  color: var(--fg-muted, #888);
  font-size: 0.7rem;
}
.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}
.queue-item {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.4rem 0.1rem 0.35rem;
  background: var(--bg, #151515);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  cursor: grab;
  max-width: 24rem;
}
.queue-item.dragging {
  opacity: 0.45;
}
.queue-item:hover {
  border-color: var(--accent, #3c7);
}
.queue-pos {
  display: inline-block;
  min-width: 1.4em;
  text-align: center;
  color: var(--fg-muted, #888);
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
}
.queue-title {
  background: none;
  border: none;
  padding: 0 0.15rem;
  color: var(--fg, #eee);
  cursor: pointer;
  max-width: 18rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.85rem;
}
.queue-title:hover {
  color: var(--accent, #3c7);
  text-decoration: underline;
}
.queue-remove {
  background: none;
  border: none;
  padding: 0 0.15rem;
  color: var(--fg-muted, #888);
  cursor: pointer;
  font-size: 0.85rem;
}
.queue-remove:hover {
  color: var(--danger, #e66);
}
</style>
