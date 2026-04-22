<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { Todo, TodoStatus } from '../types';
import { STATUS_LABELS, STATUS_ICONS, TODO_DRAG_TYPE } from '../types';
import { draggingCardId, endCardDrag, isCardDragging } from '../stores/dragState';
import TodoCard from './TodoCard.vue';

const props = defineProps<{ status: TodoStatus; todos: Todo[] }>();
const emit = defineEmits<{
  // Card moved to another column (empty area drop, no specific target card).
  (e: 'drop-todo', todoId: number, status: TodoStatus): void;
  // Card dropped onto another card → reorder in target status.
  (e: 'drop-card', draggedId: number, targetId: number, position: 'before' | 'after', status: TodoStatus): void;
  // External files dropped on this column → Board creates a todo in this status.
  (e: 'drop-files', files: File[], status: TodoStatus): void;
}>();

const searchOpen = ref(false);
const searchQuery = ref('');
const searchInput = ref<HTMLInputElement | null>(null);

const filteredTodos = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return props.todos;
  return props.todos.filter((t) =>
    (t.title + ' ' + (t.description ?? '') + ' ' + (t.tags ?? []).join(' '))
      .toLowerCase()
      .includes(q),
  );
});

async function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) {
    await nextTick();
    searchInput.value?.focus();
  } else {
    searchQuery.value = '';
  }
}

function onSearchKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    searchQuery.value = '';
    searchOpen.value = false;
  }
}

function onSearchBlur() {
  if (!searchQuery.value.trim()) searchOpen.value = false;
}

const dragOver = ref(false);

function isFileDrag(ev: DragEvent) {
  return ev.dataTransfer?.types.includes('Files') ?? false;
}

function onDragOver(ev: DragEvent) {
  // Accept both: file drops create a new todo in this column; card drags move status.
  // Custom MIME types are hidden during dragover ("protected mode"), so cards use a module-level flag.
  if (!isCardDragging() && !isFileDrag(ev)) return;
  ev.preventDefault();
  dragOver.value = true;
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = isFileDrag(ev) ? 'copy' : 'move';
}
function onDragLeave() { dragOver.value = false; }
function onDrop(ev: DragEvent) {
  if (!isCardDragging() && !isFileDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation(); // don't let the board re-process this
  dragOver.value = false;

  if (isFileDrag(ev)) {
    const files = ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
    if (files.length > 0) emit('drop-files', files, props.status);
    return;
  }
  // Card drag, no specific target card → append to this column.
  const raw =
    ev.dataTransfer?.getData(TODO_DRAG_TYPE) ||
    ev.dataTransfer?.getData('text/plain') ||
    String(draggingCardId.value ?? '');
  const id = Number(raw);
  endCardDrag();
  if (Number.isFinite(id)) emit('drop-todo', id, props.status);
}

function onCardDrop(draggedId: number, targetId: number, position: 'before' | 'after') {
  emit('drop-card', draggedId, targetId, position, props.status);
}
</script>

<template>
  <section
    class="column"
    :class="{ 'drag-over': dragOver }"
    :data-status="status"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <header
      class="column-header"
      :class="{ 'search-active': searchOpen }"
      @click="toggleSearch"
      :title="searchOpen ? 'Spaltensuche schließen' : 'In dieser Spalte suchen'"
    >
      <template v-if="!searchOpen">
        <span>{{ STATUS_ICONS[status] }}</span>
        <span>{{ STATUS_LABELS[status] }}</span>
        <span class="count" :class="{ filtered: searchQuery.trim() }">
          <template v-if="searchQuery.trim()">{{ filteredTodos.length }}/{{ todos.length }}</template>
          <template v-else>{{ todos.length }}</template>
        </span>
      </template>
      <template v-else>
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="search"
          class="column-search-input"
          :placeholder="`🔍 ${STATUS_LABELS[status]} filtern…`"
          @click.stop
          @keydown="onSearchKeydown"
          @blur="onSearchBlur"
        />
        <span class="count" :class="{ filtered: searchQuery.trim() }">
          <template v-if="searchQuery.trim()">{{ filteredTodos.length }}/{{ todos.length }}</template>
          <template v-else>{{ todos.length }}</template>
        </span>
      </template>
    </header>
    <TransitionGroup tag="div" name="card" class="cards">
      <TodoCard
        v-for="t in filteredTodos"
        :key="t.id"
        :todo="t"
        :ordered-ids="filteredTodos.map((x) => x.id)"
        @drop-card="onCardDrop"
      />
      <div v-if="filteredTodos.length === 0" key="__empty" class="empty">
        <template v-if="searchQuery.trim()">— keine Treffer —</template>
        <template v-else>— leer —</template>
      </div>
    </TransitionGroup>
  </section>
</template>
