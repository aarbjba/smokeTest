import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';

/**
 * Lightweight store tracking which todos have an **actively running** Claude
 * agent session. Board cards use this to render the iridescent "being worked
 * on right now" border only while the agent is live — status='in_progress'
 * alone is not enough because users can manually drag cards to Unter Hammer
 * without any agent running.
 *
 * Backed by GET /api/agent/sessions which returns all current sessions with
 * their status. We only care about status==='running' AND session not ended.
 *
 * Polled every 3s while mounted. The poll is deliberately cheap — the backend
 * just snapshots in-memory SessionStore state, no DB hit.
 */
export const useAgentSessionsStore = defineStore('agentSessions', () => {
  // Set of todoIds with a running session. Reactive via `new Set(...)` reassignment.
  const runningIds = ref<Set<number>>(new Set());
  let timer: number | null = null;

  async function fetchAll() {
    try {
      const { sessions } = await api.agent.list();
      const next = new Set<number>();
      for (const s of sessions) {
        if (s.status === 'running' && s.endedAt === null) {
          next.add(s.todoId);
        }
      }
      // Reassign so Vue reactivity picks it up (mutating the existing Set would
      // work with ref<Set> on modern Vue, but reassignment is bulletproof).
      runningIds.value = next;
    } catch {
      /* transient errors are fine — next poll will recover */
    }
  }

  function isRunning(todoId: number): boolean {
    return runningIds.value.has(todoId);
  }

  function startPolling(intervalMs = 3000) {
    if (timer !== null) return;
    void fetchAll();
    timer = window.setInterval(() => {
      void fetchAll();
    }, intervalMs);
  }

  function stopPolling() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  return { runningIds, isRunning, fetchAll, startPolling, stopPolling };
});
