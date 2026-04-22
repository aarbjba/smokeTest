import { defineStore } from 'pinia';
import { api } from '../api';
import type { QueueItem } from '../types';

/**
 * Automation queue store. Mirrors the server's `/api/queue` list and polls
 * periodically so the topbar strip stays in sync with:
 *   - newly enqueued todos from anywhere in the app
 *   - items the runner just pulled off (status flipped to in_progress → no
 *     longer in the query)
 *
 * Mutations are NOT optimistic — the queue is small and the network latency
 * is negligible, so we just re-fetch after each action to stay trivially
 * correct (especially for reorder which has subtle index semantics).
 */
export const useQueueStore = defineStore('queue', {
  state: () => ({
    items: [] as QueueItem[],
    loading: false,
    error: null as string | null,
    _pollTimer: null as number | null,
  }),
  getters: {
    byTodoId: (state) => (todoId: number) =>
      state.items.find((q) => q.todo_id === todoId),
    isQueued: (state) => (todoId: number) =>
      state.items.some((q) => q.todo_id === todoId),
    count: (state) => state.items.length,
    orderedIds: (state) => state.items.map((q) => q.todo_id),
  },
  actions: {
    async fetchAll() {
      this.loading = true;
      this.error = null;
      try {
        this.items = await api.queue.list();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },
    async enqueue(todoId: number, prompt = '', attachmentIds: number[] = []) {
      await api.queue.enqueue(todoId, { prompt, attachmentIds });
      await this.fetchAll();
    },
    async dequeue(todoId: number) {
      await api.queue.dequeue(todoId);
      this.items = this.items.filter((q) => q.todo_id !== todoId);
    },
    async update(todoId: number, patch: { prompt?: string; attachmentIds?: number[] }) {
      const updated = await api.queue.update(todoId, patch);
      const idx = this.items.findIndex((q) => q.todo_id === todoId);
      if (idx >= 0) this.items.splice(idx, 1, updated);
      return updated;
    },
    async reorder(orderedIds: number[]) {
      await api.queue.reorder(orderedIds);
      // Re-fetch so positions are authoritative (server reassigns 0..N-1).
      await this.fetchAll();
    },
    /**
     * Start a lightweight poll. The 5s cadence is generous — the runner kicks
     * items off in < 3s typically, and our board already triggers fetchAll on
     * user actions, so this is mostly there to catch queue drains while the
     * user is staring at the strip.
     */
    startPolling() {
      if (this._pollTimer !== null) return;
      void this.fetchAll();
      this._pollTimer = window.setInterval(() => {
        void this.fetchAll();
      }, 5000);
    },
    stopPolling() {
      if (this._pollTimer !== null) {
        window.clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
    },
  },
});
