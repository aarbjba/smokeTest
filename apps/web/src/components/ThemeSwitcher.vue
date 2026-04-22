<script setup lang="ts">
import { useSettingsStore } from '../stores/settings';
import type { ThemeName } from '../types';

const settings = useSettingsStore();

const themes: { id: ThemeName; label: string; icon: string }[] = [
  { id: 'workshop', label: 'Workshop', icon: '🪵' },
  { id: 'dark',     label: 'Dark',     icon: '🌒' },
  { id: 'light',    label: 'Light',    icon: '☀️' },
  { id: 'terminal', label: 'Terminal', icon: '💻' },
];
</script>

<template>
  <div class="theme-switcher" role="radiogroup" aria-label="Theme">
    <button
      v-for="t in themes"
      :key="t.id"
      :class="{ active: settings.theme === t.id }"
      :aria-pressed="settings.theme === t.id"
      @click="settings.applyTheme(t.id)"
      :title="t.label"
    >
      <span>{{ t.icon }}</span>
      <span v-if="settings.theme === t.id">&nbsp;{{ t.label }}</span>
    </button>
  </div>
</template>
