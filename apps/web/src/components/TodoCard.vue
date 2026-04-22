<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Todo } from '../types';
import { PRIORITY_LABELS, TODO_DRAG_TYPE } from '../types';
import { beginCardDrag, endCardDrag, draggingCardId, isCardDragging } from '../stores/dragState';
import { useTodosStore } from '../stores/todos';
import { useSelectionStore } from '../stores/selection';
import { useQueueStore } from '../stores/queue';
import { computed } from 'vue';

const props = defineProps<{ todo: Todo; orderedIds?: number[] }>();
const emit = defineEmits<{
  (e: 'dragstart', todoId: number): void;
  (e: 'drop-card', draggedId: number, targetId: number, position: 'before' | 'after'): void;
}>();
const router = useRouter();
const todos = useTodosStore();
const selection = useSelectionStore();
const queueStore = useQueueStore();
const toggling = ref(false);
const queueBusy = ref(false);

// Queue status for this card. Only meaningful for status='todo' cards — that's
// the only column where the enqueue button is shown.
const queuedItem = computed(() => queueStore.byTodoId(props.todo.id));
const isQueued = computed(() => !!queuedItem.value);

async function onQueueClick(ev: MouseEvent) {
  ev.stopPropagation(); // don't open detail view
  if (queueBusy.value) return;
  queueBusy.value = true;
  try {
    if (isQueued.value) {
      await queueStore.dequeue(props.todo.id);
    } else {
      await queueStore.enqueue(props.todo.id, '', []);
    }
  } catch {
    /* surface via the normal toast flow later if needed */
  } finally {
    queueBusy.value = false;
  }
}

function onSelectClick(ev: MouseEvent) {
  ev.stopPropagation(); // never open detail from the checkbox
  if (ev.shiftKey && props.orderedIds && props.orderedIds.length > 0) {
    selection.extendRange(props.todo.id, props.orderedIds);
  } else {
    selection.toggle(props.todo.id);
  }
}

async function toggleDone(ev: MouseEvent) {
  ev.stopPropagation(); // don't open the detail view
  if (toggling.value) return;
  toggling.value = true;
  try {
    const next = props.todo.status === 'done' ? 'todo' : 'done';
    await todos.move(props.todo.id, next);
  } finally {
    toggling.value = false;
  }
}

const deleting = ref(false);
async function onDeleteClick(ev: MouseEvent) {
  ev.stopPropagation(); // don't open detail view
  if (deleting.value) return;
  deleting.value = true;
  try {
    // Soft delete → Papierkorb. Undo via Ctrl+Z restores it (store.remove pushes an undo entry).
    await todos.remove(props.todo.id);
  } finally {
    deleting.value = false;
  }
}

const dropPos = ref<'before' | 'after' | null>(null);

function onDragStart(ev: DragEvent) {
  if (!ev.dataTransfer) return;
  ev.dataTransfer.setData(TODO_DRAG_TYPE, String(props.todo.id));
  ev.dataTransfer.setData('text/plain', String(props.todo.id));
  ev.dataTransfer.effectAllowed = 'move';
  beginCardDrag(props.todo.id);
  emit('dragstart', props.todo.id);
}

function onDragEnd() {
  endCardDrag();
  dropPos.value = null;
}

function isOurCardDrag() {
  // Chrome hides custom MIME types during dragover ("protected mode"),
  // so we rely on an in-memory flag set by beginCardDrag().
  return isCardDragging();
}

function onDragOver(ev: DragEvent) {
  if (!isOurCardDrag()) return; // let file drags bubble to the board
  ev.preventDefault();
  ev.stopPropagation();
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  dropPos.value = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
}

function onDragLeave(ev: DragEvent) {
  // Only clear the indicator when the cursor genuinely leaves the card — dragleave
  // also fires when moving over a child element, which would otherwise cause flicker.
  const el = ev.currentTarget as HTMLElement;
  const related = ev.relatedTarget as Node | null;
  if (related && el.contains(related)) return;
  dropPos.value = null;
}

function onDrop(ev: DragEvent) {
  if (!isOurCardDrag()) return;
  ev.preventDefault();
  ev.stopPropagation();
  const raw = ev.dataTransfer?.getData(TODO_DRAG_TYPE) ?? ev.dataTransfer?.getData('text/plain') ?? String(draggingCardId.value ?? '');
  const draggedId = Number(raw);
  const pos = dropPos.value ?? 'after';
  dropPos.value = null;
  endCardDrag();
  if (!Number.isFinite(draggedId) || draggedId === props.todo.id) return;
  emit('drop-card', draggedId, props.todo.id, pos);
}

function open() {
  router.push({ name: 'todo', params: { id: props.todo.id } });
}

function sourceBadge(): string {
  if (props.todo.source === 'github') return '⛓ GitHub';
  if (props.todo.source === 'jira')   return '📋 Jira';
  return '✏️ Eigen';
}
</script>

<style scoped>
.subtask-progress-badge {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--fg-muted);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.4rem;
  margin-left: 0.3rem;
  flex: 0 0 auto;
  white-space: nowrap;
}

/* Selection checkbox: hidden by default, shown on hover or when a selection
   is already active. Kept to the left of the done-check so the card's primary
   action (mark done) doesn't shift when the checkbox appears. */
.select-check {
  flex: 0 0 auto;
  width: 1.1rem;
  height: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease;
  cursor: pointer;
}
.select-check.visible,
.select-check.checked,
.todo-card:hover .select-check {
  opacity: 1;
}
.select-check input {
  margin: 0;
  cursor: pointer;
}

.todo-card.selected {
  outline: 2px solid var(--accent, #f59e0b);
  outline-offset: -2px;
}

/* "Currently being worked on" indicator — cards in the Unter-Hammer column
   (status=in_progress) get a slowly-shifting iridescent rainbow border that
   "waves" around the card. Uses mask-composite to cut out the interior so only
   the border shows, and animates both the gradient position (hue shift) and
   a subtle pulsing box-shadow for presence.

   The ::before sits just outside the card's normal border via inset: -2px and
   matches its border-radius (inherit falls back to common card radius).

   Respects prefers-reduced-motion to not annoy motion-sensitive users. */
.todo-card.status-in_progress {
  position: relative;
  isolation: isolate;
}
.todo-card.status-in_progress::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 2px;
  background: linear-gradient(
    110deg,
    #ff2e88 0%,
    #ff8c00 15%,
    #ffd700 30%,
    #33ff99 45%,
    #00d4ff 60%,
    #7a5cff 75%,
    #ff2e88 100%
  );
  background-size: 300% 100%;
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  animation:
    iridescent-wave 4s linear infinite,
    iridescent-pulse 2.4s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
  filter: saturate(1.15);
}
.todo-card.status-in_progress > * {
  position: relative;
  z-index: 1;
}

@keyframes iridescent-wave {
  from { background-position: 0% 50%; }
  to   { background-position: 300% 50%; }
}
@keyframes iridescent-pulse {
  0%, 100% { opacity: 0.85; filter: saturate(1.1) brightness(1); }
  50%      { opacity: 1;    filter: saturate(1.4) brightness(1.15); }
}

@media (prefers-reduced-motion: reduce) {
  .todo-card.status-in_progress::before {
    animation: none;
    background-position: 0% 50%;
  }
}

/* Hover-reveal delete button in the meta row. Hidden by default so cards stay
   clean, pushed to the right, appears on card hover. Mirrors .select-check's
   fade pattern so the interaction feels consistent. */
.delete-btn {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid transparent;
  color: var(--fg-muted);
  padding: 0 0.35rem;
  font-size: 0.85rem;
  line-height: 1.4;
  border-radius: var(--radius, 4px);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.todo-card:hover .delete-btn { opacity: 0.8; }
.delete-btn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--danger, #ef4444) 18%, transparent);
  border-color: color-mix(in srgb, var(--danger, #ef4444) 55%, var(--border));
  color: var(--danger, #ef4444);
}
.delete-btn:focus-visible { opacity: 1; }
.delete-btn:disabled { opacity: 0.5; cursor: progress; }

/* Queue button — sits next to the delete button in the meta row. Mirrors the
   delete-btn's hover-reveal pattern, but stays visible (non-hidden) when the
   todo is already queued so the user can see queue state at a glance. The
   margin-left:auto pushes both actions to the right edge of the meta row. */
.queue-btn {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  background: transparent;
  border: 1px solid transparent;
  color: var(--fg-muted);
  padding: 0 0.4rem;
  font-size: 0.78rem;
  line-height: 1.4;
  border-radius: var(--radius, 4px);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.todo-card:hover .queue-btn { opacity: 0.8; }
.queue-btn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--accent, #3c7) 18%, transparent);
  border-color: color-mix(in srgb, var(--accent, #3c7) 55%, var(--border));
  color: var(--accent, #3c7);
}
.queue-btn.queued {
  opacity: 1;
  color: var(--accent, #3c7);
  border-color: color-mix(in srgb, var(--accent, #3c7) 45%, var(--border));
  background: color-mix(in srgb, var(--accent, #3c7) 10%, transparent);
}
.queue-btn:focus-visible { opacity: 1; }
.queue-btn:disabled { opacity: 0.5; cursor: progress; }
.queue-btn .q-pos {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  font-weight: 600;
}
</style>

<template>
  <article
    class="todo-card"
    :class="[
      `prio-${todo.priority}`,
      `status-${todo.status}`,
      draggingCardId === todo.id ? 'dragging' : '',
      dropPos === 'before' ? 'drop-indicator-top' : '',
      dropPos === 'after'  ? 'drop-indicator-bottom' : '',
      selection.has(todo.id) ? 'selected' : '',
      selection.hasAny ? 'selection-active' : '',
    ]"
    draggable="true"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @click="open"
    :title="PRIORITY_LABELS[todo.priority]"
  >
    <div class="title">
      <label
        class="select-check"
        :class="{ checked: selection.has(todo.id), visible: selection.hasAny }"
        :title="selection.has(todo.id) ? 'Auswahl aufheben (Shift+Klick = Bereich)' : 'Für Mehrfachauswahl markieren (Shift+Klick = Bereich)'"
        @click.stop
        @mousedown.stop
      >
        <input
          type="checkbox"
          :checked="selection.has(todo.id)"
          @click="onSelectClick"
        />
      </label>
      <button
        class="done-check"
        :class="{ checked: todo.status === 'done' }"
        :disabled="toggling"
        :title="todo.status === 'done' ? 'Als offen markieren' : 'Als erledigt markieren'"
        :aria-pressed="todo.status === 'done'"
        @click="toggleDone"
      >
        <span aria-hidden="true">{{ todo.status === 'done' ? '✓' : '' }}</span>
      </button>
      <span
        v-if="todo.last_writeback_error"
        class="writeback-warn"
        :title="`Writeback fehlgeschlagen: ${todo.last_writeback_error}`"
      >⚠️</span>
      <span class="title-text">{{ todo.title }}</span>
      <span
        v-if="(todo.subtask_total ?? 0) > 0"
        class="subtask-progress-badge"
        :title="`${todo.subtask_done ?? 0} von ${todo.subtask_total} Subtasks erledigt`"
      >☑ {{ todo.subtask_done ?? 0 }}/{{ todo.subtask_total }}</span>
    </div>
    <div class="meta">
      <span class="source-badge">{{ sourceBadge() }}</span>
      <span v-if="todo.due_date" class="tag">📅 {{ new Date(todo.due_date).toLocaleDateString() }}</span>
      <span v-for="t in todo.tags.slice(0, 4)" :key="t" class="tag">#{{ t }}</span>
      <span v-if="todo.tags.length > 4" class="tag">+{{ todo.tags.length - 4 }}</span>
      <button
        v-if="todo.status === 'todo'"
        class="queue-btn"
        :class="{ queued: isQueued }"
        :disabled="queueBusy"
        :title="isQueued
          ? `In Warteschlange auf Position ${(queuedItem?.queue_position ?? 0) + 1} — klicken zum Entfernen`
          : 'In Warteschlange aufnehmen (wird automatisch gestartet)'"
        :aria-label="isQueued ? 'Aus Warteschlange entfernen' : 'In Warteschlange aufnehmen'"
        @click="onQueueClick"
        @mousedown.stop
      >
        <span aria-hidden="true">📥</span>
        <span v-if="isQueued && queuedItem" class="q-pos">{{ queuedItem.queue_position + 1 }}</span>
      </button>
      <button
        class="delete-btn"
        :disabled="deleting"
        title="In den Papierkorb (Strg+Z zum Wiederherstellen)"
        aria-label="In den Papierkorb"
        @click="onDeleteClick"
        @mousedown.stop
      >🗑</button>
    </div>
  </article>
</template>
