<script setup lang="ts">
import { computed } from 'vue';
import { usePomodoroStore } from '../stores/pomodoro';

const pomodoro = usePomodoroStore();

const label = computed(() => {
  if (!pomodoro.isRunning) return `${pomodoro.todaySessions} heute`;
  const s = pomodoro.remaining;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
});

function toggle() {
  if (pomodoro.isRunning) void pomodoro.stop(false);
  else void pomodoro.start('work', null);
}
</script>

<template>
  <div class="pomodoro" :title="pomodoro.isRunning ? `Pomodoro läuft (${pomodoro.mode})` : 'Pomodoro starten'">
    <span class="mode-chip">{{ pomodoro.isRunning ? (pomodoro.mode === 'work' ? '🔨 Arbeit' : '☕ Pause') : '⏱️' }}</span>
    <span class="timer">{{ label }}</span>
    <button class="ghost" @click="toggle">
      {{ pomodoro.isRunning ? 'Stop' : 'Start' }}
    </button>
  </div>
</template>
