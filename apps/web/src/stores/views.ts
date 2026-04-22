import { defineStore } from 'pinia';
import { api } from '../api';
import type { SourceFilter } from '../types';

/**
 * A persisted filter preset the user can switch back to with one click.
 * `filters` only contains the fields that actually exist as board filters today
 * (sourceFilter + search). Other fields in the type are optional placeholders so
 * we can extend later without a migration — older views simply won't carry them.
 */
export interface SavedViewFilters {
  sourceFilter?: SourceFilter;
  search?: string;
  // Reserved for future filters (see FEATURES.md #3). Unused today but kept in
  // the shape so persisted payloads are forward-compatible.
  tags?: string[];
  dueBefore?: string;
  status?: string[];
}

export interface SavedView {
  id: string;
  name: string;
  filters: SavedViewFilters;
}

const SETTINGS_KEY = 'savedViews';

function normaliseFilters(f: SavedViewFilters): SavedViewFilters {
  // Drop obviously-empty entries so comparison for "active" detection is stable.
  const out: SavedViewFilters = {};
  if (f.sourceFilter && f.sourceFilter !== 'all') out.sourceFilter = f.sourceFilter;
  if (f.search && f.search.trim() !== '') out.search = f.search;
  if (f.tags && f.tags.length > 0) out.tags = [...f.tags].sort();
  if (f.dueBefore) out.dueBefore = f.dueBefore;
  if (f.status && f.status.length > 0) out.status = [...f.status].sort();
  return out;
}

function filtersEqual(a: SavedViewFilters, b: SavedViewFilters): boolean {
  const na = normaliseFilters(a);
  const nb = normaliseFilters(b);
  return JSON.stringify(na) === JSON.stringify(nb);
}

export const useViewsStore = defineStore('views', {
  state: () => ({
    views: [] as SavedView[],
    activeId: null as string | null,
    loaded: false,
  }),
  getters: {
    byId: (state) => (id: string) => state.views.find((v) => v.id === id),
  },
  actions: {
    async load() {
      try {
        const all = await api.settings.getAll();
        const raw = all[SETTINGS_KEY];
        if (Array.isArray(raw)) {
          this.views = raw.filter(isSavedView);
        } else {
          this.views = [];
        }
      } catch (e) {
        console.warn('[views] failed to load saved views', e);
        this.views = [];
      } finally {
        this.loaded = true;
      }
    },
    async save() {
      await api.settings.set(SETTINGS_KEY, this.views);
    },
    async create(name: string, filters: SavedViewFilters): Promise<SavedView> {
      const view: SavedView = {
        id: crypto.randomUUID(),
        name: name.trim() || 'Unbenannt',
        filters: normaliseFilters(filters),
      };
      this.views.push(view);
      this.activeId = view.id;
      await this.save();
      return view;
    },
    async remove(id: string) {
      this.views = this.views.filter((v) => v.id !== id);
      if (this.activeId === id) this.activeId = null;
      await this.save();
    },
    async update(id: string, patch: Partial<Omit<SavedView, 'id'>>) {
      const idx = this.views.findIndex((v) => v.id === id);
      if (idx < 0) return;
      const current = this.views[idx];
      const next: SavedView = {
        ...current,
        ...patch,
        filters: patch.filters ? normaliseFilters(patch.filters) : current.filters,
      };
      this.views.splice(idx, 1, next);
      await this.save();
    },
    setActive(id: string | null) {
      this.activeId = id;
    },
    /** Find a view whose filters match the given snapshot, or null. */
    matchingView(current: SavedViewFilters): SavedView | null {
      return this.views.find((v) => filtersEqual(v.filters, current)) ?? null;
    },
  },
});

function isSavedView(x: unknown): x is SavedView {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && !!o.filters
    && typeof o.filters === 'object';
}
