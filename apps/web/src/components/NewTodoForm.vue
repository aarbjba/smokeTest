<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTodosStore } from '../stores/todos';
import { parseQuickAdd } from '../utils/parseQuickAdd';
import { api } from '../api';
import type { TaskType } from '../types';
import { TASK_TYPES, TASK_TYPE_LABELS, TASK_TYPE_ICONS } from '../types';

const todos = useTodosStore();
const title = ref('');
const priority = ref<1 | 2 | 3 | 4>(2);
const tagsText = ref('');
const dueDate = ref('');
const description = ref('');
const taskType = ref<TaskType>('other');
const saving = ref(false);

// AI reformulation state. Tags + description come back as editable fields the
// user can still tweak before submit; subtasks are tickable checkboxes.
// The whole AI panel is cleared on successful submit.
const aiLoading = ref(false);
const aiError = ref<string | null>(null);
const aiSubtasks = ref<Array<{ title: string; accepted: boolean }>>([]);
const aiDescriptionShown = ref(false);

async function reformulateWithAI() {
  const raw = title.value.trim();
  if (!raw || aiLoading.value) return;
  aiLoading.value = true;
  aiError.value = null;
  try {
    const result = await api.ai.reformulateTodo(raw);
    if (result.title) title.value = result.title;
    // Merge AI tags into whatever the user already typed, de-duped. Preserves
    // manual input so the AI pass feels additive, not destructive.
    if (result.tags.length > 0) {
      const manual = tagsText.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const merged = Array.from(new Set([...manual, ...result.tags]));
      tagsText.value = merged.join(', ');
    }
    if (result.description) {
      // Don't overwrite a description the user already typed.
      if (!description.value.trim()) description.value = result.description;
      aiDescriptionShown.value = true;
    }
    aiSubtasks.value = result.subtasks.map((s) => ({ title: s, accepted: true }));
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e);
  } finally {
    aiLoading.value = false;
  }
}

const titleInput = ref<HTMLInputElement | null>(null);

defineExpose({
  focus() {
    titleInput.value?.focus();
    titleInput.value?.select();
  },
});

// Live-parsed preview of the raw title input. Re-computed on every keystroke
// so the chips below the field stay in sync. The title input itself remains
// the source of truth — we only read from it here.
const parsed = computed(() => parseQuickAdd(title.value));

const parsedPriorityNum = computed<1 | 2 | 3 | 4 | null>(() => {
  const p = parsed.value.priority;
  if (!p) return null;
  const n = Number(p);
  return n === 1 || n === 2 || n === 3 || n === 4 ? (n as 1 | 2 | 3 | 4) : null;
});

const priorityLabel: Record<1 | 2 | 3 | 4, string> = {
  1: 'Dringend',
  2: 'Normal',
  3: 'Niedrig',
  4: 'Irgendwann',
};

const hasDetectedTokens = computed(
  () =>
    parsed.value.tags.length > 0 ||
    parsedPriorityNum.value !== null ||
    parsed.value.dueDate !== null,
);

async function submit() {
  const result = parseQuickAdd(title.value);
  // Fall back to the still-unparsed input if the user typed only tokens
  // (unlikely but defensive) so we never persist an empty title.
  const finalTitle = result.title || title.value.trim();
  if (!finalTitle) return;

  // Merge parsed tokens with the legacy side-fields so power users can still
  // use them together if they want. Parsed tokens take precedence for the
  // priority/date (explicit !high beats the default select).
  const manualTags = tagsText.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const mergedTags = Array.from(new Set([...result.tags, ...manualTags]));

  const parsedPrio = Number(result.priority);
  const finalPriority: 1 | 2 | 3 | 4 =
    parsedPrio === 1 || parsedPrio === 2 || parsedPrio === 3 || parsedPrio === 4
      ? (parsedPrio as 1 | 2 | 3 | 4)
      : priority.value;

  let finalDueDate: string | null = null;
  if (result.dueDate) {
    finalDueDate = new Date(`${result.dueDate}T00:00:00`).toISOString();
  } else if (dueDate.value) {
    finalDueDate = new Date(dueDate.value).toISOString();
  }

  saving.value = true;
  try {
    const finalDescription = description.value.trim();
    const created = await todos.create({
      title: finalTitle,
      priority: finalPriority,
      tags: mergedTags,
      due_date: finalDueDate,
      task_type: taskType.value,
      ...(finalDescription ? { description: finalDescription } : {}),
    });
    // If the AI panel produced subtasks and the user left them checked, persist
    // them. Errors here are non-fatal to the todo creation — surface them in
    // aiError but don't re-throw.
    const accepted = aiSubtasks.value.filter((s) => s.accepted && s.title.trim());
    if (created && accepted.length > 0) {
      try {
        for (const s of accepted) {
          await api.subtasks.create(created.id, s.title.trim());
        }
      } catch (e) {
        aiError.value = e instanceof Error ? e.message : String(e);
      }
    }
    title.value = '';
    tagsText.value = '';
    dueDate.value = '';
    priority.value = 2;
    description.value = '';
    taskType.value = 'other';
    aiDescriptionShown.value = false;
    aiSubtasks.value = [];
    aiError.value = null;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="new-todo-card">
    <header class="new-todo-header">
      <span>✏️ Neue Aufgabe</span>
      <span class="shortcut-hint">
        Drück <kbd>N</kbd> zum Fokussieren · z.B. <code>Fix login tomorrow #auth !high</code>
      </span>
    </header>
    <form class="row grow new-todo-form" @submit.prevent="submit">
      <input
        ref="titleInput"
        v-model="title"
        type="text"
        placeholder="Was steht heute auf der Werkbank?"
      />
      <select v-model.number="priority" style="max-width: 12rem;">
        <option :value="1">🔴 Dringend</option>
        <option :value="2">🟡 Normal</option>
        <option :value="3">🟢 Niedrig</option>
        <option :value="4">⚪ Irgendwann</option>
      </select>
      <select v-model="taskType" style="max-width: 10rem;" title="Aufgabentyp">
        <option v-for="t in TASK_TYPES" :key="t" :value="t">
          {{ TASK_TYPE_ICONS[t] }} {{ TASK_TYPE_LABELS[t] }}
        </option>
      </select>
      <input v-model="tagsText" type="text" placeholder="tags, komma-getrennt" style="max-width: 16rem;" />
      <input v-model="dueDate" type="date" style="max-width: 10rem;" />
      <button
        type="button"
        class="ghost ai-button"
        :disabled="aiLoading || saving || !title.trim()"
        :title="aiLoading ? 'Haiku denkt nach…' : 'Reformulieren + Subtasks vorschlagen (Haiku)'"
        @click="reformulateWithAI"
      >
        <span v-if="aiLoading">⏳</span>
        <span v-else>✨</span>
        KI
      </button>
      <button type="submit" class="primary" :disabled="saving || !parsed.title.trim()">Anheften</button>
    </form>
    <div v-if="aiError" class="ai-error">{{ aiError }}</div>
    <div v-if="aiDescriptionShown || description" class="ai-description">
      <div class="ai-description-header">
        <span>Beschreibung</span>
        <button
          type="button"
          class="ghost"
          @click="description = ''; aiDescriptionShown = false"
          title="Beschreibung verwerfen"
        >✕</button>
      </div>
      <textarea
        v-model="description"
        class="ai-description-input"
        rows="3"
        placeholder="Kurze Beschreibung zur Aufgabe…"
      />
    </div>
    <div v-if="aiSubtasks.length > 0" class="ai-subtasks">
      <div class="ai-subtasks-header">
        <span>Vorgeschlagene Subtasks</span>
        <button type="button" class="ghost" @click="aiSubtasks = []" title="Vorschläge verwerfen">✕</button>
      </div>
      <ul>
        <li v-for="(s, i) in aiSubtasks" :key="i">
          <label>
            <input type="checkbox" v-model="s.accepted" />
            <input
              type="text"
              v-model="s.title"
              class="ai-subtask-input"
              :disabled="!s.accepted"
            />
          </label>
        </li>
      </ul>
    </div>
    <div v-if="hasDetectedTokens" class="quick-add-preview" aria-live="polite">
      <span class="quick-add-preview-label">Erkannt:</span>
      <span
        v-for="tag in parsed.tags"
        :key="`tag-${tag}`"
        class="qa-chip qa-chip-tag"
      >#{{ tag }}</span>
      <span
        v-if="parsedPriorityNum !== null"
        class="qa-chip qa-chip-prio"
        :class="`qa-chip-prio-${parsedPriorityNum}`"
      >!{{ priorityLabel[parsedPriorityNum] }}</span>
      <span
        v-if="parsed.dueDate"
        class="qa-chip qa-chip-date"
      >📅 {{ parsed.dueDate }}</span>
    </div>
  </section>
</template>

<style scoped>
.quick-add-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  margin-top: 0.5rem;
  font-size: 0.8rem;
}
.quick-add-preview-label {
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.qa-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border-radius: 999px;
  padding: 0.1rem 0.55rem;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.4;
}
.qa-chip-tag {
  background: color-mix(in srgb, #22c55e 18%, var(--bg-elev));
  border-color: color-mix(in srgb, #22c55e 55%, var(--border));
  color: color-mix(in srgb, #22c55e 80%, var(--fg));
}
.qa-chip-prio-1 {
  background: color-mix(in srgb, #ef4444 20%, var(--bg-elev));
  border-color: color-mix(in srgb, #ef4444 60%, var(--border));
  color: color-mix(in srgb, #ef4444 80%, var(--fg));
}
.qa-chip-prio-2 {
  background: color-mix(in srgb, #eab308 20%, var(--bg-elev));
  border-color: color-mix(in srgb, #eab308 60%, var(--border));
  color: color-mix(in srgb, #eab308 85%, var(--fg));
}
.qa-chip-prio-3,
.qa-chip-prio-4 {
  background: var(--bg-elev);
  border-color: var(--border);
  color: var(--fg-muted);
}
.qa-chip-date {
  background: color-mix(in srgb, #3b82f6 20%, var(--bg-elev));
  border-color: color-mix(in srgb, #3b82f6 60%, var(--border));
  color: color-mix(in srgb, #3b82f6 85%, var(--fg));
}

.ai-button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
}
.ai-error {
  margin-top: 0.5rem;
  color: var(--danger, #ef4444);
  font-size: 0.82rem;
}
.ai-subtasks,
.ai-description {
  margin-top: 0.6rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  background: color-mix(in srgb, #8b5cf6 8%, var(--bg-elev));
}
.ai-description-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
  margin-bottom: 0.4rem;
}
.ai-description-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font-family: inherit;
  font-size: 0.9rem;
}
.ai-subtasks-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
  margin-bottom: 0.4rem;
}
.ai-subtasks ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.ai-subtasks li label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.ai-subtask-input {
  flex: 1;
  min-width: 0;
  font-size: 0.9rem;
}
</style>
