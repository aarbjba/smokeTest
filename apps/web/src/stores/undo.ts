import { defineStore } from 'pinia';

export interface UndoEntry {
  label: string;
  revert: () => void | Promise<void>;
}

const MAX_STACK = 20;

export const useUndoStore = defineStore('undo', {
  state: () => ({
    stack: [] as UndoEntry[],
    // Transient label for the most recently reverted entry — used by UI for toast messaging.
    lastRevertedLabel: null as string | null,
    // Set while a revert() closure runs so mutating actions don't push new undo entries
    // (otherwise Ctrl+Z would ping-pong between the pre- and post- states).
    reverting: false,
  }),
  getters: {
    canUndo: (state) => state.stack.length > 0,
    depth: (state) => state.stack.length,
  },
  actions: {
    push(entry: UndoEntry) {
      if (this.reverting) return;
      this.stack.push(entry);
      // Cap: shift oldest when we exceed the limit.
      while (this.stack.length > MAX_STACK) this.stack.shift();
    },
    async undo(): Promise<UndoEntry | null> {
      const entry = this.stack.pop();
      if (!entry) return null;
      this.reverting = true;
      try {
        await entry.revert();
        this.lastRevertedLabel = entry.label;
      } catch (e) {
        // Revert failed — surface but don't re-push, since state may be inconsistent.
        // Keep the label so UI can indicate failure if desired.
        this.lastRevertedLabel = entry.label;
        throw e;
      } finally {
        this.reverting = false;
      }
      return entry;
    },
    clear() {
      this.stack = [];
      this.lastRevertedLabel = null;
    },
  },
});
