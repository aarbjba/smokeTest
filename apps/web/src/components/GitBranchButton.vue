<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{
  title: string;
  todoId?: number;
}>();

/**
 * Slug rules:
 *  - lowercase
 *  - replace any non-alphanumeric with "-"
 *  - collapse consecutive "-"
 *  - trim leading/trailing "-"
 *  - cap at 50 chars, preferring word boundary (last "-" in the cut window)
 *
 * "fix"/"bug" in the title (case-insensitive) picks prefix `fix/`; default `feat/`.
 * We do NOT strip "fix"/"bug" from the slug itself — the heuristic only chooses
 * the prefix; the title remains recognizable. Example: "Fix login bug" →
 * `fix/fix-login-bug`. This keeps the slug a faithful reflection of the title.
 *
 * Fallback: when the slug is empty (e.g. title is pure emoji/whitespace),
 * we use `task-<id>` if we have an id, otherwise `untitled`.
 */
function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-');
  const collapsed = replaced.replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  if (trimmed.length <= 50) return trimmed;
  const window = trimmed.slice(0, 50);
  const lastDash = window.lastIndexOf('-');
  // Prefer word boundary if it lands in the 2nd half of the window
  if (lastDash >= 25) return window.slice(0, lastDash);
  return window;
}

function pickPrefix(input: string): 'fix/' | 'feat/' {
  return /fix|bug/i.test(input) ? 'fix/' : 'feat/';
}

const slug = computed(() => {
  const s = slugify(props.title ?? '');
  if (s) return s;
  return props.todoId != null ? `task-${props.todoId}` : 'untitled';
});

const prefix = computed(() => pickPrefix(props.title ?? ''));

const command = computed(() => `git checkout -b ${prefix.value}${slug.value}`);

const copied = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

async function copy() {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    // Clipboard may be unavailable (insecure context, permissions). Surface
    // minimally without throwing.
    console.warn('[GitBranchButton] clipboard write failed:', err);
    alert('Konnte nicht in die Zwischenablage kopieren.');
  }
}
</script>

<template>
  <div class="git-branch-button" style="display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
    <button
      type="button"
      class="ghost"
      :aria-label="copied ? 'Branch-Befehl kopiert' : 'Branch-Befehl in Zwischenablage kopieren'"
      @click="copy"
    >
      <span aria-hidden="true">📋</span>
      <span>{{ copied ? 'Kopiert!' : 'Branch kopieren' }}</span>
    </button>
    <code
      class="git-branch-preview"
      :title="command"
      style="
        font-family: var(--font-mono);
        font-size: 0.85rem;
        padding: 0.15rem 0.4rem;
        background: var(--bg-muted, rgba(127, 127, 127, 0.15));
        border-radius: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 32rem;
      "
    >{{ command }}</code>
  </div>
</template>
