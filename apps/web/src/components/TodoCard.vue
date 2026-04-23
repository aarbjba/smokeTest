<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Todo, TaskType } from '../types';
import { PRIORITY_LABELS, TODO_DRAG_TYPE, TASK_TYPE_LABELS, TASK_TYPE_ICONS } from '../types';
import { beginCardDrag, endCardDrag, draggingCardId, isCardDragging } from '../stores/dragState';
import { useTodosStore } from '../stores/todos';
import { useSelectionStore } from '../stores/selection';
import { useQueueStore } from '../stores/queue';
import { useAgentSessionsStore } from '../stores/agentSessions';
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
const agentSessions = useAgentSessionsStore();
const toggling = ref(false);
const queueBusy = ref(false);

// Drives the iridescent "being worked on right now" border. True only while
// a Claude session is actively running for this todo (not for cards manually
// dragged to Unter Hammer without an agent).
const isAgentWorking = computed(() => agentSessions.isRunning(props.todo.id));

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

// Hide the "Sonstiges" chip — it's the default and adds noise on every card.
// Other types render as a compact icon+label chip in the meta row.
const taskType = computed<TaskType>(() => (props.todo.task_type ?? 'other') as TaskType);
const showTypeChip = computed(() => taskType.value !== 'other');
const typeChipLabel = computed(() => `${TASK_TYPE_ICONS[taskType.value]} ${TASK_TYPE_LABELS[taskType.value]}`);
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

/* "Agent is actively working on this right now" indicator.
   Gated on `.agent-working`, added by the template whenever the agentSessions
   store reports a running Claude session for this todo.

   Intentionally subtle: a thin animated rainbow line along the TOP edge of
   the card, plus a very soft pulsing shadow. Nothing that fights the card
   for attention — just a clear signal the agent is live. */
.todo-card.agent-working {
  position: relative;
  animation: agent-working-pulse 2.4s ease-in-out infinite;
}
.todo-card.agent-working::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  border-top-left-radius: inherit;
  border-top-right-radius: inherit;
  background: linear-gradient(
    90deg,
    #ff2e88, #ff8c00, #ffd700, #33ff99, #00d4ff, #7a5cff, #ff2e88
  );
  background-size: 300% 100%;
  animation: iridescent-wave 3s linear infinite;
  pointer-events: none;
}

@keyframes iridescent-wave {
  from { background-position: 0% 50%; }
  to   { background-position: 300% 50%; }
}
@keyframes agent-working-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, #7a5cff 0%, transparent); }
  50%      { box-shadow: 0 0 10px 1px color-mix(in srgb, #7a5cff 28%, transparent); }
}

/* Inline rotating spinner in the title row — companion to the iridescent
   border. More immediately readable at a glance, especially when the card is
   scrolled into a dense column. Sized to line-height so it doesn't disrupt
   baseline alignment. */
.agent-spinner {
  display: inline-block;
  width: 0.95em;
  height: 0.95em;
  flex: 0 0 auto;
  margin: 0 0.25rem;
  border: 2px solid color-mix(in srgb, #7a5cff 28%, transparent);
  border-top-color: #7a5cff;
  border-radius: 50%;
  animation: agent-spinner-rotate 0.9s linear infinite;
  vertical-align: -0.12em;
}
@keyframes agent-spinner-rotate {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .todo-card.agent-working,
  .todo-card.agent-working::after,
  .agent-spinner {
    animation: none;
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

/* Task-type chip — compact icon+label pill in the meta row. Each variant gets
   a tint that hints at intent without drowning out the card's own accent.
   "Sonstiges" isn't rendered (it's the default; showing it would add noise). */
.task-type-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  border-radius: 999px;
  padding: 0 0.5rem;
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--fg);
  white-space: nowrap;
}
.task-type-chip.task-type-feature {
  background: color-mix(in srgb, #3b82f6 18%, var(--bg-elev));
  border-color: color-mix(in srgb, #3b82f6 55%, var(--border));
  color: color-mix(in srgb, #3b82f6 85%, var(--fg));
}
.task-type-chip.task-type-bug {
  background: color-mix(in srgb, #ef4444 18%, var(--bg-elev));
  border-color: color-mix(in srgb, #ef4444 55%, var(--border));
  color: color-mix(in srgb, #ef4444 85%, var(--fg));
}
.task-type-chip.task-type-chore {
  background: color-mix(in srgb, #a3a3a3 18%, var(--bg-elev));
  border-color: color-mix(in srgb, #a3a3a3 55%, var(--border));
  color: color-mix(in srgb, #a3a3a3 85%, var(--fg));
}
.task-type-chip.task-type-customer {
  background: color-mix(in srgb, #eab308 18%, var(--bg-elev));
  border-color: color-mix(in srgb, #eab308 55%, var(--border));
  color: color-mix(in srgb, #eab308 90%, var(--fg));
}
.task-type-chip.task-type-research {
  background: color-mix(in srgb, #8b5cf6 18%, var(--bg-elev));
  border-color: color-mix(in srgb, #8b5cf6 55%, var(--border));
  color: color-mix(in srgb, #8b5cf6 85%, var(--fg));
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
      isAgentWorking ? 'agent-working' : '',
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
      <span
        v-if="isAgentWorking"
        class="agent-spinner"
        role="img"
        aria-label="Claude arbeitet an diesem Todo"
        title="Claude arbeitet an diesem Todo"
      />
      <span class="title-text">{{ todo.title }}</span>
      <span
        v-if="(todo.subtask_total ?? 0) > 0"
        class="subtask-progress-badge"
        :title="`${todo.subtask_done ?? 0} von ${todo.subtask_total} Subtasks erledigt`"
      >☑ {{ todo.subtask_done ?? 0 }}/{{ todo.subtask_total }}</span>
    </div>
    <div class="meta">
      <span class="source-badge">{{ sourceBadge() }}</span>
      <span
        v-if="showTypeChip"
        class="task-type-chip"
        :class="`task-type-${taskType}`"
        :title="`Aufgabentyp: ${TASK_TYPE_LABELS[taskType]}`"
      >{{ typeChipLabel }}</span>
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
