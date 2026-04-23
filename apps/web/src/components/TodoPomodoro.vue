<script setup lang="ts">
import { computed } from 'vue';
import { usePomodoroStore } from '../stores/pomodoro';

const props = defineProps<{ todoId: number }>();
const pomodoro = usePomodoroStore();

const runningForThis = computed(() =>
  pomodoro.isRunning && pomodoro.active?.session.todo_id === props.todoId
);

const timerLabel = computed(() => {
  if (!runningForThis.value) return '';
  const s = pomodoro.remaining;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
});
</script>

<template>
  <div class="pomodoro-compact" :class="{ running: runningForThis }">
    <span v-if="runningForThis" class="timer" :title="`Pomodoro läuft (${pomodoro.mode === 'break' ? 'Pause' : 'Arbeit'})`">
      <span class="dot" />{{ timerLabel }}
    </span>
    <template v-if="!runningForThis">
      <button
        type="button"
        class="mini-btn"
        title="Pomodoro starten (25 min)"
        @click="pomodoro.start('work', todoId)"
      >🔨 25m</button>
      <button
        type="button"
        class="mini-btn ghost"
        title="Pause starten (5 min)"
        @click="pomodoro.start('break', todoId)"
      >☕ 5m</button>
    </template>
    <button
      v-else
      type="button"
      class="mini-btn danger"
      title="Pomodoro abbrechen"
      @click="pomodoro.stop(false)"
    >✕</button>
  </div>
</template>

<style scoped>
.pomodoro-compact {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.timer {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--accent);
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
}
.dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 var(--accent);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
.mini-btn {
  font-size: 0.78rem;
  padding: 0.2rem 0.55rem;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  line-height: 1;
}
.mini-btn:hover {
  color: var(--fg);
  background: var(--bg-elev);
}
.mini-btn.danger:hover {
  color: #f87171;
  border-color: #f87171;
  background: transparent;
}
</style>
