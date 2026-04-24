import { defineStore } from 'pinia';
import { api } from '../api';
import type { Todo, TodoStatus, SourceFilter, TaskType } from '../types';
import { useUndoStore } from './undo';

const SOURCE_FILTER_KEY = 'werkbank:source-filter';
const TAG_FILTER_KEY = 'werkbank:tag-filter';
const REPO_FILTER_KEY = 'werkbank:repo-filter';
const TYPE_FILTER_KEY = 'werkbank:type-filter';

function loadJsonArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Repo = GitHub `owner/name` (part before `#` in source_ref) or Jira project key
// (part before `-` in source_ref). Local todos have no repo concept.
export function repoOfTodo(t: Todo): string | null {
  if (!t.source_ref) return null;
  if (t.source === 'github') {
    const hash = t.source_ref.indexOf('#');
    return hash > 0 ? t.source_ref.slice(0, hash) : null;
  }
  if (t.source === 'jira') {
    const dash = t.source_ref.indexOf('-');
    return dash > 0 ? t.source_ref.slice(0, dash) : null;
  }
  return null;
}

export const useTodosStore = defineStore('todos', {
  state: () => ({
    items: [] as Todo[],
    loading: false,
    error: null as string | null,
    search: '',
    sourceFilter: (localStorage.getItem(SOURCE_FILTER_KEY) as SourceFilter | null) ?? 'all' as SourceFilter,
    activeTags: loadJsonArray(TAG_FILTER_KEY),
    activeRepos: loadJsonArray(REPO_FILTER_KEY),
    activeTypes: loadJsonArray(TYPE_FILTER_KEY) as TaskType[],
    lastFetchAt: null as number | null,
  }),
  getters: {
    // Filter chain: status → source → tags → repos → types → search. AND across dimensions,
    // OR within a dimension. Server already orders by (status, position, ...).
    byStatus(state) {
      return (status: TodoStatus) => {
        const q = state.search.toLowerCase();
        const tagSet = new Set(state.activeTags);
        const repoSet = new Set(state.activeRepos);
        const typeSet = new Set(state.activeTypes);
        return state.items.filter((t) => {
          if (t.status !== status) return false;
          if (state.sourceFilter !== 'all' && t.source !== state.sourceFilter) return false;
          if (tagSet.size > 0 && !t.tags.some((tag) => tagSet.has(tag))) return false;
          if (repoSet.size > 0) {
            const repo = repoOfTodo(t);
            if (!repo || !repoSet.has(repo)) return false;
          }
          if (typeSet.size > 0) {
            const type = (t.task_type ?? 'other') as TaskType;
            if (!typeSet.has(type)) return false;
          }
          if (q && !(t.title + ' ' + t.description).toLowerCase().includes(q)) return false;
          return true;
        });
      };
    },
    byId: (state) => (id: number) => state.items.find((t) => t.id === id),
    counts: (state) => {
      const bySource = { local: 0, github: 0, jira: 0 } as Record<'local' | 'github' | 'jira', number>;
      for (const t of state.items) bySource[t.source]++;
      return bySource;
    },
    // Unique tags across all todos with occurrence counts. Used by the tag picker.
    // Counts are over the full item set (not contextual) — keeps the picker stable
    // while the user toggles filters on/off.
    tagsWithCounts(state): { value: string; count: number }[] {
      const counts = new Map<string, number>();
      for (const t of state.items) {
        for (const tag of t.tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      return Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    },
    reposWithCounts(state): { value: string; count: number }[] {
      const counts = new Map<string, number>();
      for (const t of state.items) {
        const repo = repoOfTodo(t);
        if (!repo) continue;
        counts.set(repo, (counts.get(repo) ?? 0) + 1);
      }
      return Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    },
    typesWithCounts(state): { value: TaskType; count: number }[] {
      const counts = new Map<TaskType, number>();
      for (const t of state.items) {
        const type = (t.task_type ?? 'other') as TaskType;
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      return Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    },
    activeFilterCount(state): number {
      let n = 0;
      if (state.sourceFilter !== 'all') n++;
      n += state.activeTags.length;
      n += state.activeRepos.length;
      n += state.activeTypes.length;
      if (state.search && state.search.trim() !== '') n++;
      return n;
    },
  },
  actions: {
    setSourceFilter(filter: SourceFilter) {
      this.sourceFilter = filter;
      localStorage.setItem(SOURCE_FILTER_KEY, filter);
    },
    setActiveTags(tags: string[]) {
      this.activeTags = [...tags];
      localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(this.activeTags));
    },
    setActiveRepos(repos: string[]) {
      this.activeRepos = [...repos];
      localStorage.setItem(REPO_FILTER_KEY, JSON.stringify(this.activeRepos));
    },
    toggleTag(tag: string) {
      const idx = this.activeTags.indexOf(tag);
      if (idx >= 0) this.activeTags.splice(idx, 1);
      else this.activeTags.push(tag);
      localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(this.activeTags));
    },
    toggleRepo(repo: string) {
      const idx = this.activeRepos.indexOf(repo);
      if (idx >= 0) this.activeRepos.splice(idx, 1);
      else this.activeRepos.push(repo);
      localStorage.setItem(REPO_FILTER_KEY, JSON.stringify(this.activeRepos));
    },
    setActiveTypes(types: TaskType[]) {
      this.activeTypes = [...types];
      localStorage.setItem(TYPE_FILTER_KEY, JSON.stringify(this.activeTypes));
    },
    toggleType(type: TaskType) {
      const idx = this.activeTypes.indexOf(type);
      if (idx >= 0) this.activeTypes.splice(idx, 1);
      else this.activeTypes.push(type);
      localStorage.setItem(TYPE_FILTER_KEY, JSON.stringify(this.activeTypes));
    },
    clearAllFilters() {
      this.setSourceFilter('all');
      this.setActiveTags([]);
      this.setActiveRepos([]);
      this.setActiveTypes([]);
      this.search = '';
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
    async create(data: Partial<Todo> & { subtasks?: string[] }) {
      const created = await api.todos.create(data);
      this.items.unshift(created);
      return created;
    },
    /**
     * Mutate the local in-memory mirror WITHOUT an API call and WITHOUT
     * pushing to the undo stack. Purpose-built for optimistic sandbox status
     * updates (start + SSE end) where the server remains authoritative via
     * the SSE stream; surfacing these in Ctrl+Z would let the user "undo" a
     * machine-driven state transition which isn't meaningful.
     */
    _updateLocal(id: number, patch: Partial<Todo>) {
      const idx = this.items.findIndex((t) => t.id === id);
      if (idx < 0) return;
      this.items.splice(idx, 1, { ...this.items[idx], ...patch });
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
