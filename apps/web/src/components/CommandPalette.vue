<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTodosStore } from '../stores/todos';
import { useSettingsStore } from '../stores/settings';
import type { Todo, SourceFilter, ThemeName } from '../types';
import { SOURCE_ICON, STATUS_ICONS } from '../types';
import { requestNotificationPermission } from '../composables/useDueNotifications';

const emit = defineEmits<{ (e: 'close'): void }>();

const router = useRouter();
const todosStore = useTodosStore();
const settingsStore = useSettingsStore();

const query = ref('');
const selectedIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);

// --- Action registry --------------------------------------------------------

interface PaletteAction {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  perform: () => void | Promise<void>;
}

const actions: PaletteAction[] = [
  {
    id: 'nav-board',
    label: 'Board öffnen',
    icon: '🗂',
    hint: 'Navigation',
    perform: () => { void router.push({ name: 'board' }); },
  },
  {
    id: 'nav-settings',
    label: 'Einstellungen öffnen',
    icon: '⚙️',
    hint: 'Navigation',
    perform: () => { void router.push({ name: 'settings' }); },
  },
  {
    id: 'new-todo',
    label: 'Neuer Todo',
    icon: '＋',
    hint: 'Aktion',
    perform: async () => {
      if (router.currentRoute.value.name !== 'board') {
        await router.push({ name: 'board' });
      }
      await nextTick();
      // Focus the title input of the NewTodoForm without requiring a ref.
      const input = document.querySelector<HTMLInputElement>(
        '.new-todo-form input[type="text"]',
      );
      input?.focus();
      input?.select();
    },
  },
  ...(['all', 'local', 'github', 'jira'] as SourceFilter[]).map<PaletteAction>((f) => ({
    id: `filter-${f}`,
    label: `Filter: ${filterLabel(f)}`,
    icon: filterIcon(f),
    hint: 'Filter',
    perform: () => todosStore.setSourceFilter(f),
  })),
  ...(
    [
      { id: 'workshop', label: 'Workshop', icon: '🪵' },
      { id: 'dark', label: 'Dark', icon: '🌒' },
      { id: 'light', label: 'Light', icon: '☀️' },
      { id: 'terminal', label: 'Terminal', icon: '💻' },
      { id: 'matrix', label: 'Matrix', icon: '🟢' },
    ] as { id: ThemeName; label: string; icon: string }[]
  ).map<PaletteAction>((t) => ({
    id: `theme-${t.id}`,
    label: `Theme: ${t.label}`,
    icon: t.icon,
    hint: 'Theme',
    perform: () => settingsStore.applyTheme(t.id),
  })),
  {
    id: 'refresh-todos',
    label: 'Todos neu laden',
    icon: '↻',
    hint: 'Aktion',
    perform: () => { void todosStore.fetchAll(); },
  },
  {
    id: 'notify-enable',
    label: 'Benachrichtigungen aktivieren',
    icon: '🔔',
    hint: 'Aktion',
    // Called from a real user-gesture path (Enter/click in the palette),
    // which is what browsers require to surface the permission prompt.
    perform: () => { void requestNotificationPermission(); },
  },
];

function filterLabel(f: SourceFilter): string {
  return f === 'all' ? 'Alle' : f === 'local' ? 'Eigen' : f === 'github' ? 'GitHub' : 'Jira';
}
function filterIcon(f: SourceFilter): string {
  return f === 'all' ? '∗' : f === 'local' ? '✏️' : f === 'github' ? '⛓' : '📋';
}

// --- Fuzzy scoring ----------------------------------------------------------

/**
 * Subsequence fuzzy score: every needle char must appear in order in haystack.
 * Consecutive matches get a bonus; matches after a word boundary (space, -, _, /)
 * get a small bonus too. Returns null if no subsequence match.
 * Score range: higher = better. For empty needle returns 0 (tie).
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  let prevMatched = false;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    let found = -1;
    for (let j = hi; j < h.length; j++) {
      if (h[j] === ch) { found = j; break; }
    }
    if (found === -1) return null;
    score += 1;
    if (prevMatched && found === hi) score += 2; // consecutive
    if (found === 0) score += 3;
    else {
      const prev = h[found - 1];
      if (prev === ' ' || prev === '-' || prev === '_' || prev === '/') score += 2;
    }
    hi = found + 1;
    prevMatched = true;
  }
  // Prefer shorter haystacks when scores tie.
  score -= h.length * 0.01;
  return score;
}

// --- Results ---------------------------------------------------------------

interface Result {
  kind: 'todo' | 'action';
  id: string;
  score: number;
  label: string;
  icon: string;
  hint?: string;
  todo?: Todo;
  action?: PaletteAction;
}

const MAX_RESULTS = 20;

const results = computed<Result[]>(() => {
  const q = query.value.trim();
  const out: Result[] = [];

  for (const a of actions) {
    const s = fuzzyScore(q, a.label);
    if (s === null) continue;
    out.push({
      kind: 'action',
      id: `a:${a.id}`,
      score: s + 0.5, // slight boost so actions surface above equally-scored todos
      label: a.label,
      icon: a.icon,
      hint: a.hint,
      action: a,
    });
  }

  for (const t of todosStore.items) {
    const haystack = t.title || '';
    const s = fuzzyScore(q, haystack);
    if (s === null) continue;
    out.push({
      kind: 'todo',
      id: `t:${t.id}`,
      score: s,
      label: t.title || `Todo #${t.id}`,
      icon: STATUS_ICONS[t.status] || SOURCE_ICON[t.source],
      hint: `${SOURCE_ICON[t.source]} ${t.source}`,
      todo: t,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_RESULTS);
});

// Reset selection whenever the result list changes.
function clampSelection() {
  if (selectedIndex.value >= results.value.length) {
    selectedIndex.value = Math.max(0, results.value.length - 1);
  } else if (selectedIndex.value < 0) {
    selectedIndex.value = 0;
  }
}

function onInput() {
  selectedIndex.value = 0;
}

function move(delta: number) {
  const len = results.value.length;
  if (len === 0) return;
  selectedIndex.value = (selectedIndex.value + delta + len) % len;
  void nextTick(() => scrollSelectedIntoView());
}

function scrollSelectedIntoView() {
  const ul = listEl.value;
  if (!ul) return;
  const el = ul.children[selectedIndex.value] as HTMLElement | undefined;
  el?.scrollIntoView({ block: 'nearest' });
}

async function confirm() {
  clampSelection();
  const r = results.value[selectedIndex.value];
  if (!r) return;
  if (r.kind === 'todo' && r.todo) {
    emit('close');
    await router.push({ name: 'todo', params: { id: String(r.todo.id) } });
  } else if (r.kind === 'action' && r.action) {
    emit('close');
    await r.action.perform();
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    void confirm();
    return;
  }
}

function onBackdropClick() {
  emit('close');
}

onMounted(async () => {
  // Populate the todo list so search has something to match against.
  if (todosStore.items.length === 0) {
    void todosStore.fetchAll();
  }
  await nextTick();
  inputEl.value?.focus();
});

onUnmounted(() => {
  // Nothing global to clean up — the parent unmounts the component.
});
</script>

<template>
  <div class="cmd-palette-backdrop" @mousedown.self="onBackdropClick">
    <div class="cmd-palette" role="dialog" aria-modal="true" aria-label="Befehlspalette">
      <div class="cmd-palette-input-row">
        <span class="cmd-palette-icon" aria-hidden="true">🔍</span>
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="cmd-palette-input"
          placeholder="Todos oder Aktionen suchen…"
          autocomplete="off"
          spellcheck="false"
          @input="onInput"
          @keydown="onKeydown"
        />
        <kbd class="cmd-palette-kbd">Esc</kbd>
      </div>
      <ul
        v-if="results.length > 0"
        ref="listEl"
        class="cmd-palette-results"
        role="listbox"
      >
        <li
          v-for="(r, i) in results"
          :key="r.id"
          role="option"
          :class="['cmd-palette-result', { active: i === selectedIndex }]"
          :aria-selected="i === selectedIndex"
          @mouseenter="selectedIndex = i"
          @mousedown.prevent="() => { selectedIndex = i; void confirm(); }"
        >
          <span class="cmd-palette-result-icon">{{ r.icon }}</span>
          <span class="cmd-palette-result-label">{{ r.label }}</span>
          <span v-if="r.hint" class="cmd-palette-result-hint">{{ r.hint }}</span>
        </li>
      </ul>
      <div v-else class="cmd-palette-empty">
        Keine Treffer.
      </div>
      <div class="cmd-palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigation</span>
        <span><kbd>Enter</kbd> Öffnen</span>
        <span><kbd>Esc</kbd> Schließen</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmd-palette-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 1100;
  backdrop-filter: blur(2px);
}
.cmd-palette {
  width: min(640px, calc(100vw - 2rem));
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev, #222);
  color: var(--fg, #eee);
  border: 1px solid var(--border, #444);
  border-radius: var(--radius, 8px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.cmd-palette-input-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 0.9rem;
  border-bottom: 1px solid var(--border, #444);
}
.cmd-palette-icon {
  font-size: 1rem;
  opacity: 0.7;
}
.cmd-palette-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 1rem;
  color: inherit;
  padding: 0.35rem 0;
}
.cmd-palette-kbd,
.cmd-palette-footer kbd {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  background: var(--bg, #111);
  color: var(--fg-muted, #aaa);
}
.cmd-palette-results {
  list-style: none;
  margin: 0;
  padding: 0.25rem 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.cmd-palette-result {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0.9rem;
  cursor: pointer;
  font-size: 0.92rem;
  border-left: 3px solid transparent;
}
.cmd-palette-result.active {
  background: color-mix(in srgb, var(--accent, #f59e0b) 18%, transparent);
  border-left-color: var(--accent, #f59e0b);
}
.cmd-palette-result-icon {
  width: 1.5rem;
  text-align: center;
  flex-shrink: 0;
}
.cmd-palette-result-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmd-palette-result-hint {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  color: var(--fg-muted, #aaa);
  opacity: 0.8;
}
.cmd-palette-empty {
  padding: 1.25rem;
  text-align: center;
  color: var(--fg-muted, #aaa);
  font-size: 0.9rem;
}
.cmd-palette-footer {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  padding: 0.5rem 0.9rem;
  border-top: 1px solid var(--border, #444);
  font-size: 0.75rem;
  color: var(--fg-muted, #aaa);
}
.cmd-palette-footer kbd {
  margin-right: 0.25rem;
}
</style>
