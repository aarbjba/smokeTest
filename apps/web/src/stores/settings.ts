import { defineStore } from 'pinia';
import type { ThemeName } from '../types';

const THEME_KEY = 'werkbank:theme';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    theme: (localStorage.getItem(THEME_KEY) as ThemeName | null) ?? 'workshop' as ThemeName,
  }),
  actions: {
    applyTheme(theme: ThemeName) {
      this.theme = theme;
      document.body.dataset.theme = theme;
      localStorage.setItem(THEME_KEY, theme);
    },
  },
});
