import { defineStore } from 'pinia';
import { api } from '../api';
import type { PomodoroSession } from '../types';
import { useTodosStore } from './todos';

interface ActiveSession {
  session: PomodoroSession;
  targetSeconds: number;
  startedAtMs: number;
  intervalId: number | null;
}

export const usePomodoroStore = defineStore('pomodoro', {
  state: () => ({
    active: null as ActiveSession | null,
    elapsed: 0,
    workMinutes: 25,
    breakMinutes: 5,
    todaySessions: 0,
    todaySeconds: 0,
  }),
  getters: {
    remaining: (state) => state.active ? Math.max(0, state.active.targetSeconds - state.elapsed) : 0,
    isRunning: (state) => state.active !== null,
    mode: (state) => state.active?.session.mode ?? null,
  },
  actions: {
    async start(mode: 'work' | 'break', todoId: number | null = null) {
      if (this.active) await this.stop(false);
      const session = await api.pomodoro.start(mode, todoId);
      const targetSeconds = (mode === 'work' ? this.workMinutes : this.breakMinutes) * 60;
      const startedAtMs = Date.now();
      this.elapsed = 0;
      const intervalId = window.setInterval(() => {
        if (!this.active) return;
        this.elapsed = Math.floor((Date.now() - this.active.startedAtMs) / 1000);
        if (this.elapsed >= this.active.targetSeconds) {
          void this.stop(true);
        }
      }, 500);
      this.active = { session, targetSeconds, startedAtMs, intervalId };
    },
    async stop(completed: boolean) {
      if (!this.active) return;
      const { session, intervalId } = this.active;
      if (intervalId) clearInterval(intervalId);
      const duration = Math.floor((Date.now() - this.active.startedAtMs) / 1000);
      const wasWorkOnTodo = session.mode === 'work' && completed && session.todo_id != null;
      try {
        await api.pomodoro.end(session.id, duration, completed);
      } catch { /* ignore */ }
      this.active = null;
      this.elapsed = 0;
      await this.refreshStats();
      // Worklog writeback may have flipped last_writeback_error on the linked todo — refresh the board.
      if (wasWorkOnTodo) {
        try { await useTodosStore().fetchAll(); } catch { /* ignore */ }
      }
    },
    async refreshStats() {
      try {
        const stats = await api.pomodoro.stats();
        this.todaySessions = stats.today.sessions;
        this.todaySeconds = stats.today.seconds;
      } catch { /* ignore */ }
    },
  },
});
