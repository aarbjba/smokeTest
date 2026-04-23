<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

interface Option {
  value: string;
  count: number;
  // Optional display label — falls back to `value` when not provided.
  // Lets callers keep selection state as a stable enum slug while rendering
  // a prettified string (icon + German label) in the dropdown.
  label?: string;
}

const props = defineProps<{
  label: string;
  icon?: string;
  options: Option[];
  selected: string[];
  emptyText?: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'toggle', value: string): void;
  (e: 'clear'): void;
}>();

const open = ref(false);
const query = ref('');
const rootEl = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter(
    (o) => o.value.toLowerCase().includes(q) || (o.label ?? '').toLowerCase().includes(q),
  );
});

const selectedSet = computed(() => new Set(props.selected));

function toggleOpen() {
  open.value = !open.value;
}

function close() {
  open.value = false;
  query.value = '';
}

function onDocClick(ev: MouseEvent) {
  if (!open.value) return;
  const t = ev.target as Node | null;
  if (!t || !rootEl.value) return;
  if (!rootEl.value.contains(t)) close();
}

function onDocKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && open.value) {
    ev.stopPropagation();
    close();
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onDocKey);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});

watch(open, async (v) => {
  if (v) {
    await new Promise((r) => requestAnimationFrame(r));
    searchInput.value?.focus();
  }
});

function onToggle(value: string, ev?: Event) {
  ev?.stopPropagation();
  emit('toggle', value);
}

function onClear(ev: Event) {
  ev.stopPropagation();
  emit('clear');
}
</script>

<template>
  <div class="filter-picker" ref="rootEl">
    <button
      type="button"
      class="filter-picker-trigger"
      :class="{ active: selected.length > 0, open }"
      :aria-expanded="open"
      :aria-haspopup="true"
      @click="toggleOpen"
    >
      <span v-if="icon" class="icon">{{ icon }}</span>
      <span class="label">{{ label }}</span>
      <span v-if="selected.length > 0" class="badge">{{ selected.length }}</span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="open" class="filter-picker-popover" role="dialog" :aria-label="label">
      <div class="filter-picker-search">
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          :placeholder="placeholder ?? 'Suchen…'"
          autocomplete="off"
        />
        <button
          v-if="selected.length > 0"
          type="button"
          class="linklike"
          @click="onClear"
        >Zurücksetzen</button>
      </div>

      <div class="filter-picker-list" role="listbox">
        <div v-if="filtered.length === 0" class="filter-picker-empty">
          {{ options.length === 0 ? (emptyText ?? 'Keine Einträge') : 'Nichts gefunden' }}
        </div>
        <label
          v-for="opt in filtered"
          :key="opt.value"
          class="filter-picker-item"
          :class="{ checked: selectedSet.has(opt.value) }"
        >
          <input
            type="checkbox"
            :checked="selectedSet.has(opt.value)"
            @change="onToggle(opt.value, $event)"
          />
          <span class="value" :title="opt.label ?? opt.value">{{ opt.label ?? opt.value }}</span>
          <span class="count">{{ opt.count }}</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-picker {
  position: relative;
  display: inline-block;
}

.filter-picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.85rem;
  color: var(--fg-muted);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.filter-picker-trigger:hover {
  background: var(--bg-elev);
  border-color: var(--accent-2);
  color: var(--fg);
}
.filter-picker-trigger.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.filter-picker-trigger.open {
  border-color: var(--accent-2);
}
.filter-picker-trigger .icon {
  font-size: 0.9rem;
  line-height: 1;
}
.filter-picker-trigger .label {
  line-height: 1;
}
.filter-picker-trigger .badge {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 999px;
  padding: 0 0.45rem;
  font-size: 0.7rem;
  min-width: 1.2rem;
  text-align: center;
  line-height: 1.4;
}
.filter-picker-trigger:not(.active) .badge {
  background: var(--bg-elev);
  color: var(--fg);
}
.filter-picker-trigger .caret {
  font-size: 0.7rem;
  opacity: 0.7;
}

.filter-picker-popover {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  z-index: 50;
  min-width: 16rem;
  max-width: 22rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.filter-picker-search {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.filter-picker-search input {
  flex: 1;
  padding: 0.3rem 0.55rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  color: var(--fg);
  font-size: 0.85rem;
}
.filter-picker-search input:focus {
  outline: none;
  border-color: var(--accent-2);
}
.linklike {
  background: none;
  border: none;
  color: var(--fg-muted);
  font-size: 0.75rem;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
}
.linklike:hover { color: var(--fg); text-decoration: underline; }

.filter-picker-list {
  display: flex;
  flex-direction: column;
  max-height: 18rem;
  overflow-y: auto;
  gap: 0.1rem;
}

.filter-picker-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  border-radius: 0.35rem;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--fg);
}
.filter-picker-item:hover { background: var(--bg-card); }
.filter-picker-item.checked { background: var(--bg-card); }
.filter-picker-item input[type="checkbox"] {
  accent-color: var(--accent);
  cursor: pointer;
}
.filter-picker-item .value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filter-picker-item .count {
  color: var(--fg-muted);
  font-size: 0.75rem;
  background: var(--bg-elev);
  border-radius: 999px;
  padding: 0 0.4rem;
  min-width: 1.4rem;
  text-align: center;
}

.filter-picker-empty {
  padding: 0.8rem 0.4rem;
  color: var(--fg-muted);
  font-size: 0.8rem;
  text-align: center;
}
</style>
