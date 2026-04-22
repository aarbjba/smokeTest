<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
import type { StandupItem, StandupResponse } from '../api';

const busy = ref(false);
const feedback = ref<string | null>(null);
let feedbackTimer: number | null = null;

function flash(msg: string) {
  feedback.value = msg;
  if (feedbackTimer) window.clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    feedback.value = null;
    feedbackTimer = null;
  }, 2000);
}

/**
 * Render the standup as Markdown.
 * Empty-section policy: we ALWAYS include all three section headers.
 * Empty sections get a single `- — keine —` placeholder so that the
 * copied standup has a consistent shape regardless of the day.
 */
function renderMarkdown(data: StandupResponse): string {
  const lines: string[] = [];
  const doneLine = (t: StandupItem) => `- [x] ${t.title}`;
  const openLine = (t: StandupItem) => `- ${t.title}`;
  const empty = '- — keine —';

  lines.push('## Gestern');
  if (data.yesterday.length === 0) lines.push(empty);
  else lines.push(...data.yesterday.map(doneLine));
  lines.push('');

  lines.push('## Heute');
  if (data.today.length === 0) lines.push(empty);
  else lines.push(...data.today.map(openLine));
  lines.push('');

  lines.push('## Blockiert');
  if (data.blocked.length === 0) lines.push(empty);
  else lines.push(...data.blocked.map(openLine));

  return lines.join('\n');
}

async function copyStandup() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await api.standup.get();
    const md = renderMarkdown(data);
    await navigator.clipboard.writeText(md);
    flash('Kopiert!');
  } catch (e) {
    flash(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="standup-button-wrapper">
    <button
      type="button"
      class="ghost"
      @click="copyStandup"
      :disabled="busy"
      title="Standup-Markdown in die Zwischenablage kopieren"
    >
      {{ busy ? 'Lade…' : '📋 Standup kopieren' }}
    </button>
    <span v-if="feedback" class="standup-feedback">{{ feedback }}</span>
  </div>
</template>

<style scoped>
.standup-button-wrapper {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.standup-feedback {
  font-size: 0.85rem;
  opacity: 0.85;
}
</style>
