<script setup lang="ts">
import { RouterView, RouterLink } from 'vue-router';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import PomodoroBar from './components/PomodoroBar.vue';
import CommandPalette from './components/CommandPalette.vue';
import QueueStrip from './components/QueueStrip.vue';
import { onMounted, onUnmounted, ref } from 'vue';
import { usePomodoroStore } from './stores/pomodoro';
import { useUndoStore } from './stores/undo';
import { useAgentSessionsStore } from './stores/agentSessions';
import { useDueNotifications } from './composables/useDueNotifications';

const pomodoro = usePomodoroStore();
const undoStore = useUndoStore();
const agentSessions = useAgentSessionsStore();

// Due-date browser notifications — polls todos store every 5 min and fires a
// Notification for each overdue, undone todo. Permission is NOT requested here
// (must be user-initiated); see command-palette action "Benachrichtigungen
// aktivieren" for the permission prompt path.
useDueNotifications();

// Command Palette (Ctrl+K / Cmd+K) global state.
const paletteOpen = ref(false);

// Minimal inline toast: single message, auto-dismisses after ~2.5s.
const toastMessage = ref<string | null>(null);
let toastTimer: number | null = null;
function showToast(msg: string) {
  toastMessage.value = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMessage.value = null;
    toastTimer = null;
  }, 2500);
}

// Ctrl+Z / Cmd+Z handler — skip when user is editing text (let the browser handle native undo).
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

async function onKeydown(e: KeyboardEvent) {
  // Ctrl+K / Cmd+K → toggle command palette. Globally bound; fine to intercept
  // even inside inputs since no other control uses it.
  const isPalette = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K');
  if (isPalette) {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
    return;
  }

  const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z');
  if (!isUndo) return;
  if (isTextInput(e.target)) return; // let native undo win inside text fields
  if (!undoStore.canUndo) return;

  e.preventDefault();
  try {
    const entry = await undoStore.undo();
    if (entry) showToast(`Rückgängig gemacht: ${entry.label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Rückgängig fehlgeschlagen: ${msg}`);
  }
}

onMounted(() => {
  void pomodoro.refreshStats();
  // Poll /api/agent/sessions every few seconds so board cards can light up
  // with the iridescent "working right now" border for any todo whose
  // Claude session is currently running.
  agentSessions.startPolling();
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  agentSessions.stopPolling();
  window.removeEventListener('keydown', onKeydown);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="anvil">🛠</span> Werkbank</div>
      <nav>
        <RouterLink to="/">Board</RouterLink>
        <RouterLink to="/papierkorb">🗑 Papierkorb</RouterLink>
        <RouterLink to="/settings">Einstellungen</RouterLink>
      </nav>
      <div class="spacer" />
      <PomodoroBar />
      <ThemeSwitcher />
    </header>
    <QueueStrip />
    <main class="content">
      <RouterView />
    </main>
    <transition name="toast-fade">
      <div v-if="toastMessage" class="undo-toast" role="status" aria-live="polite">
        {{ toastMessage }}
      </div>
    </transition>
    <CommandPalette v-if="paletteOpen" @close="paletteOpen = false" />
  </div>
</template>

<style scoped>
.undo-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-elev, #222);
  color: var(--fg, #eee);
  border: 1px solid var(--border, #444);
  border-radius: var(--radius, 6px);
  padding: 0.6rem 1rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  z-index: 1000;
  font-size: 0.9rem;
  max-width: 80vw;
  pointer-events: none;
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
