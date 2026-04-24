<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api';

const props = defineProps<{
  root: string;
  open: boolean;
  // Pre-fills the search input when the picker opens. Used by the inline
  // `@`-autocomplete to carry whatever the user has typed after the `@`.
  initialQuery?: string;
  // Where the popover should anchor — defaults to 'inline' (block-level
  // below the trigger). 'floating' positions absolutely using the supplied
  // x/y coordinates (cursor-follow mode for inline @ autocomplete).
  anchor?: 'inline' | 'floating';
  x?: number;
  y?: number;
}>();

const emit = defineEmits<{
  (e: 'select', path: string, type: 'file' | 'dir'): void;
  (e: 'close'): void;
}>();

interface Entry {
  path: string;
  type: 'file' | 'dir';
}

const entries = ref<Entry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const truncated = ref(false);
const query = ref(props.initialQuery ?? '');
const highlighted = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);

// Cache per root so reopening the picker is instant. Entries are static for
// a given working directory within a session — the user can hit 🔄 to refresh.
const cache = new Map<string, Entry[]>();

async function loadEntries(force = false) {
  if (!props.root) return;
  if (!force && cache.has(props.root)) {
    entries.value = cache.get(props.root)!;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const res = await api.fs.list(props.root);
    entries.value = res.entries;
    truncated.value = res.truncated;
    cache.set(props.root, res.entries);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

/**
 * Fuzzy match: every character in `q` must appear in `s` in order.
 * Lower is better: perfect prefix match wins, consecutive runs beat spread out
 * matches, shorter strings win over longer ones when score ties.
 */
function fuzzyScore(s: string, q: string): number | null {
  if (!q) return 0;
  const src = s.toLowerCase();
  const needle = q.toLowerCase();
  let si = 0;
  let score = 0;
  let consecutive = 0;
  for (let qi = 0; qi < needle.length; qi++) {
    const c = needle[qi];
    const idx = src.indexOf(c, si);
    if (idx === -1) return null;
    if (idx === si) {
      consecutive += 1;
      score -= consecutive * 2;
    } else {
      consecutive = 0;
      score += idx - si;
    }
    si = idx + 1;
  }
  return score + src.length * 0.01;
}

const filtered = computed<Entry[]>(() => {
  const q = query.value.trim();
  if (!q) return entries.value.slice(0, 200);
  const scored: { entry: Entry; score: number }[] = [];
  for (const e of entries.value) {
    const s = fuzzyScore(e.path, q);
    if (s !== null) scored.push({ entry: e, score: s });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 200).map((x) => x.entry);
});

watch(filtered, () => {
  if (highlighted.value >= filtered.value.length) {
    highlighted.value = Math.max(0, filtered.value.length - 1);
  }
});

watch(() => props.open, async (open) => {
  if (open) {
    query.value = props.initialQuery ?? '';
    highlighted.value = 0;
    await loadEntries();
    await nextTick();
    searchInput.value?.focus();
  }
});

watch(() => props.initialQuery, (v) => {
  if (props.open && v !== undefined) query.value = v;
});

function choose(entry: Entry) {
  emit('select', entry.path, entry.type);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlighted.value = Math.min(filtered.value.length - 1, highlighted.value + 1);
    scrollHighlightedIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlighted.value = Math.max(0, highlighted.value - 1);
    scrollHighlightedIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = filtered.value[highlighted.value];
    if (hit) choose(hit);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const hit = filtered.value[highlighted.value];
    if (hit) choose(hit);
  }
}

function scrollHighlightedIntoView() {
  nextTick(() => {
    const el = listEl.value?.children[highlighted.value] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function onBackdropClick() {
  emit('close');
}

onMounted(() => {
  if (props.open) void loadEntries();
});

onUnmounted(() => { /* nothing to tear down — cache persists per component instance */ });
</script>

<template>
  <div
    v-if="open"
    class="path-picker"
    :class="anchor === 'floating' ? 'floating' : 'inline'"
    :style="anchor === 'floating' ? { top: `${y ?? 0}px`, left: `${x ?? 0}px` } : {}"
    @click.stop
  >
    <div class="pp-head">
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        spellcheck="false"
        placeholder="Pfad suchen (fuzzy)…"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="ghost pp-refresh"
        :disabled="loading"
        title="Liste neu laden"
        @click="loadEntries(true)"
      >🔄</button>
      <button
        type="button"
        class="ghost pp-close"
        title="Schließen"
        @click="emit('close')"
      >✕</button>
    </div>
    <div v-if="error" class="pp-error">{{ error }}</div>
    <div v-if="loading && entries.length === 0" class="pp-empty">Lade…</div>
    <div v-else-if="!root" class="pp-empty">Kein Arbeitsverzeichnis gesetzt.</div>
    <div v-else-if="filtered.length === 0" class="pp-empty">Keine Treffer.</div>
    <ul v-else ref="listEl" class="pp-list">
      <li
        v-for="(e, i) in filtered"
        :key="e.path + ':' + e.type"
        :class="['pp-item', { active: i === highlighted, dir: e.type === 'dir' }]"
        @click="choose(e)"
        @mouseenter="highlighted = i"
      >
        <span class="pp-icon">{{ e.type === 'dir' ? '📁' : '📄' }}</span>
        <span class="pp-path">{{ e.path }}</span>
      </li>
    </ul>
    <div v-if="truncated" class="pp-note">Liste gekürzt (über {{ entries.length }} Einträge). Suche einschränken.</div>
    <div class="pp-hint">
      ↑↓ navigieren · ⏎ einfügen · Esc schließen
    </div>
  </div>
  <div v-if="open && anchor === 'floating'" class="path-picker-backdrop" @click="onBackdropClick" />
</template>

<style scoped>
.path-picker {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  width: min(560px, 92vw);
  max-height: 360px;
  z-index: 9000;
}
.path-picker.inline {
  position: relative;
  margin-top: 0.4rem;
}
.path-picker.floating {
  position: fixed;
}
.path-picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 8999;
  background: transparent;
}
.pp-head {
  display: flex;
  gap: 0.3rem;
  align-items: stretch;
}
.pp-head input {
  flex: 1;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}
.pp-refresh, .pp-close { padding: 0.35rem 0.55rem; }
.pp-error {
  color: var(--danger);
  font-size: 0.82rem;
  padding: 0.3rem 0.4rem;
}
.pp-empty {
  color: var(--fg-muted);
  font-size: 0.85rem;
  padding: 0.4rem;
}
.pp-list {
  list-style: none;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}
.pp-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  white-space: nowrap;
}
.pp-item.active {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  color: var(--fg);
}
.pp-item.dir .pp-path { color: color-mix(in srgb, var(--fg) 80%, var(--accent-2)); }
.pp-icon { flex-shrink: 0; }
.pp-path {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.pp-note {
  color: var(--fg-muted);
  font-size: 0.75rem;
  padding: 0.2rem 0.3rem;
  font-style: italic;
}
.pp-hint {
  color: var(--fg-muted);
  font-size: 0.72rem;
  padding: 0.15rem 0.3rem;
  text-align: right;
}
</style>
