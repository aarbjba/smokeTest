import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * Selection store for bulk-ops.
 *
 * Tracks a set of todo IDs the user has marked with checkboxes. Supports
 * shift-click range selection against a caller-provided ordered list of IDs
 * (the visible board order), which is why selection of a range needs a
 * "context" list rather than a global ordering.
 *
 * Anchor is the most recently single-clicked ID (not shift-clicked); a
 * subsequent shift-click selects the contiguous range between anchor and the
 * clicked ID within the provided ordered list.
 */
export const useSelectionStore = defineStore('selection', () => {
  const ids = ref<Set<number>>(new Set());
  const anchor = ref<number | null>(null);

  const count = computed(() => ids.value.size);
  const hasAny = computed(() => ids.value.size > 0);

  function has(id: number): boolean {
    return ids.value.has(id);
  }

  function set(next: Set<number>) {
    ids.value = new Set(next);
  }

  function toggle(id: number) {
    const s = new Set(ids.value);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    ids.value = s;
    anchor.value = id;
  }

  function selectOnly(id: number) {
    ids.value = new Set([id]);
    anchor.value = id;
  }

  function clear() {
    ids.value = new Set();
    anchor.value = null;
  }

  /**
   * Shift-click range: select everything between the anchor and `id` in the
   * given ordered list. If there is no anchor yet, behave like a plain toggle
   * and set the anchor.
   */
  function extendRange(id: number, orderedIds: number[]) {
    if (anchor.value === null || !orderedIds.includes(anchor.value)) {
      toggle(id);
      return;
    }
    const a = orderedIds.indexOf(anchor.value);
    const b = orderedIds.indexOf(id);
    if (a < 0 || b < 0) {
      toggle(id);
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const s = new Set(ids.value);
    for (let i = lo; i <= hi; i++) s.add(orderedIds[i]);
    ids.value = s;
    // Anchor stays where it was — standard shift-click semantics so further
    // shift-clicks extend the same anchor rather than collapsing to the newly
    // clicked item.
  }

  return { ids, anchor, count, hasAny, has, set, toggle, selectOnly, clear, extendRange };
});
