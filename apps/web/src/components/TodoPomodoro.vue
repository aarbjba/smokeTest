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
  <div class="pomodoro">
    <span class="mode-chip">🔨 Pomodoro</span>
    <span v-if="runningForThis" class="timer">{{ timerLabel }}</span>
    <span v-else class="timer" style="color: var(--fg-muted); font-size: 1rem;">bereit</span>
    <button v-if="!runningForThis" class="primary" @click="pomodoro.start('work', todoId)">Start (25 min)</button>
    <button v-else class="danger" @click="pomodoro.stop(false)">Abbrechen</button>
    <button v-if="!runningForThis" class="ghost" @click="pomodoro.start('break', todoId)">Pause (5 min)</button>
  </div>
</template>
