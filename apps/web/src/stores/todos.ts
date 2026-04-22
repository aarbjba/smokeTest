import { defineStore } from 'pinia';
import { api } from '../api';
import type { Todo, TodoStatus, SourceFilter } from '../types';
import { useUndoStore } from './undo';

const SOURCE_FILTER_KEY = 'werkbank:source-filter';

export const useTodosStore = defineStore('todos', {
  state: () => ({
    items: [] as Todo[],
    loading: false,
    error: null as string | null,
    search: '',
    sourceFilter: (localStorage.getItem(SOURCE_FILTER_KEY) as SourceFilter | null) ?? 'all' as SourceFilter,
    lastFetchAt: null as number | null,
  }),
  getters: {
    // Filter chain: status → source → search. Server already orders by (status, position, ...).
    byStatus: (state) => (status: TodoStatus) => {
      const q = state.search.toLowerCase();
      return state.items
        .filter((t) => t.status === status)
        .filter((t) => state.sourceFilter === 'all' || t.source === state.sourceFilter)
        .filter((t) => !q || (t.title + ' ' + t.description).toLowerCase().includes(q));
    },
    byId: (state) => (id: number) => state.items.find((t) => t.id === id),
    counts: (state) => {
      const bySource = { local: 0, github: 0, jira: 0 } as Record<'local' | 'github' | 'jira', number>;
      for (const t of state.items) bySource[t.source]++;
      return bySource;
    },
  },
  actions: {
    setSourceFilter(filter: SourceFilter) {
      this.sourceFilter = filter;
      localStorage.setItem(SOURCE_FILTER_KEY, filter);
    },
    async fetchAll() {
      this.loading = true;
      this.error = null;
      try {
        this.items = await api.todos.list();
        this.lastFetchAt = Date.now();
      }
      catch (e) { this.error = e instanceof Error ? e.message : String(e); }
      finally { this.loading = false; }
    },
    async create(data: Partial<Todo>) {
      const created = await api.todos.create(data);
      this.items.unshift(created);
      return created;
    },
    async update(id: number, data: Partial<Todo>) {
      // Capture BEFORE mutation so we can restore original field values.
      const before = this.items.find((t) => t.id === id);
      const beforeSnapshot = before ? { ...before } : null;

      const updated = await api.todos.update(id, data);
      const idx = this.items.findIndex((t) => t.id === id);
      if (idx >= 0) this.items.splice(idx, 1, updated);

      // Push undo entry unless this update came from a revert() itself.
      if (beforeSnapshot) {
        const undo = useUndoStore();
        // Only restore the fields that were actually changed in `data`.
        const changedKeys = Object.keys(data) as (keyof Todo)[];
        if (changedKeys.length > 0) {
          const restore: Partial<Todo> = {};
          for (const k of changedKeys) {
            // @ts-expect-error indexed assignment across Partial<Todo>
            restore[k] = beforeSnapshot[k];
          }
          const label = this._describeUpdate(beforeSnapshot, changedKeys);
          undo.push({
            label,
            revert: async () => {
              await this.update(id, restore);
            },
          });
        }
      }
      return updated;
    },
    /** Human-readable label for an update-undo entry. */
    _describeUpdate(before: Todo, keys: (keyof Todo)[]): string {
      const title = before.title || `Todo #${before.id}`;
      if (keys.length === 1 && keys[0] === 'status') {
        return `"${title}" verschoben`;
      }
      if (keys.length === 1 && keys[0] === 'title') {
        return `Titel geändert`;
      }
      if (keys.length === 1) {
        return `"${title}" geändert`;
      }
      return `"${title}" aktualisiert`;
    },
    async move(id: number, status: TodoStatus) {
      // Capture the pre-move status so revert hits the opposite direction.
      const before = this.items.find((t) => t.id === id);
      const oldStatus = before?.status;
      const title = before?.title || `Todo #${id}`;

      // Optimistic: update local first for snappier UX, then sync.
      const idx = this.items.findIndex((t) => t.id === id);
      if (idx >= 0) this.items[idx] = { ...this.items[idx], status };

      // Do the API call directly (not via this.update) to avoid pushing an "update" undo;
      // we push a single, purpose-built "move" undo below.
      const updated = await api.todos.update(id, { status });
      const idx2 = this.items.findIndex((t) => t.id === id);
      if (idx2 >= 0) this.items.splice(idx2, 1, updated);

      if (oldStatus && oldStatus !== status) {
        const undo = useUndoStore();
        undo.push({
          label: `"${title}" verschoben`,
          revert: async () => {
            const i = this.items.findIndex((t) => t.id === id);
            if (i >= 0) this.items[i] = { ...this.items[i], status: oldStatus };
            const restored = await api.todos.update(id, { status: oldStatus });
            const j = this.items.findIndex((t) => t.id === id);
            if (j >= 0) this.items.splice(j, 1, restored);
          },
        });
      }
      return updated;
    },
    async reorderInColumn(status: TodoStatus, orderedIds: number[]) {
      // Capture the previous in-column order so we can restore on undo.
      const prevOrdered = this.items
        .filter((t) => t.status === status)
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((t) => t.id);

      // Optimistic: update positions AND physically reorder so byStatus() reflects new order immediately.
      const posById = new Map<number, number>();
      orderedIds.forEach((id, pos) => posById.set(id, pos));
      this.items = this.items
        .map((t) =>
          t.status === status && posById.has(t.id)
            ? { ...t, position: posById.get(t.id)! }
            : t,
        )
        .sort((a, b) => {
          // Mirror the server ORDER BY (status, position, priority, updated_at DESC).
          if (a.status !== b.status) return a.status < b.status ? -1 : 1;
          const pa = a.position ?? 0, pb = b.position ?? 0;
          if (pa !== pb) return pa - pb;
          if (a.priority !== b.priority) return a.priority - b.priority;
          return a.updated_at < b.updated_at ? 1 : -1;
        });
      try {
        await api.todos.reorder(status, orderedIds);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        await this.fetchAll(); // revert from server on failure
        return;
      }

      // Only push an undo entry if the order actually changed.
      const changed =
        prevOrdered.length !== orderedIds.length ||
        prevOrdered.some((id, i) => id !== orderedIds[i]);
      if (changed && prevOrdered.length > 0) {
        const undo = useUndoStore();
        undo.push({
          label: 'Reihenfolge geändert',
          revert: async () => {
            await this.reorderInColumn(status, prevOrdered);
          },
        });
      }
    },
    /**
     * Soft-delete: moves the todo to Papierkorb. The item disappears from the board
     * but is still recoverable via the Papierkorb view (or Ctrl+Z undo, which calls
     * the server's restore endpoint — preserving the original id, source_ref, etc.).
     */
    async remove(id: number) {
      const snapshot = this.items.find((t) => t.id === id);
      await api.todos.remove(id);
      this.items = this.items.filter((t) => t.id !== id);

      if (snapshot) {
        const undo = useUndoStore();
        const title = snapshot.title || `Todo #${id}`;
        undo.push({
          label: `"${title}" in den Papierkorb verschoben`,
          revert: async () => {
            const restored = await api.todos.restore(id);
            this.items.unshift(restored);
          },
        });
      }
    },
    /** Restore a todo from the Papierkorb. Used by PapierkorbView. */
    async restore(id: number) {
      const restored = await api.todos.restore(id);
      // Add to the active list if it's not there yet (so the board reflects it immediately).
      if (!this.items.find((t) => t.id === id)) this.items.unshift(restored);
    },
    /** Permanently delete a todo (bypasses Papierkorb). No undo. */
    async purge(id: number) {
      await api.todos.remove(id, { permanent: true });
      this.items = this.items.filter((t) => t.id !== id);
    },
  },
});
