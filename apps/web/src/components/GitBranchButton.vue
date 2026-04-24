<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TaskType, TodoSource } from '../types';
import { computeAgentBranchName } from '../utils/branchName';

const props = defineProps<{
  title: string;
  todoId?: number;
  source?: TodoSource;
  sourceRef?: string | null;
  tags?: string[];
  taskType?: TaskType;
  // Sandbox mode short-circuits the feature/bugfix/chore heuristic and instead
  // emits `agent/<todoId>-<slug>` via the shared computeAgentBranchName helper
  // — the detail view's "Sandbox-Lauf" section uses this to preview the name
  // the sandbox runner will push to GitHub.
  sandboxMode?: boolean;
}>();

/**
 * Slug rules:
 *  - lowercase
 *  - replace any non-alphanumeric with "-"
 *  - collapse consecutive "-"
 *  - trim leading/trailing "-"
 *  - cap at 50 chars, preferring word boundary (last "-" in the cut window)
 *
 * Fallback: when the slug is empty (e.g. title is pure emoji/whitespace),
 * we use `task-<id>` if we have an id, otherwise `untitled`.
 */
function slugify(input: string, maxLen = 50): string {
  const lowered = input.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-');
  const collapsed = replaced.replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  if (trimmed.length <= maxLen) return trimmed;
  const window = trimmed.slice(0, maxLen);
  const lastDash = window.lastIndexOf('-');
  // Prefer word boundary if it lands in the 2nd half of the window
  if (lastDash >= Math.floor(maxLen / 2)) return window.slice(0, lastDash);
  return window;
}

/**
 * Jira/Bitbucket "Create branch" dialog prefixes by issue type:
 *   Bug             → bugfix/
 *   Story/Task/New  → feature/
 *   Epic            → epic/
 *   Chore/Subtask   → chore/
 * Hotfix is reserved for explicit hotfix labels/tags.
 */
function pickPrefix(): string {
  const tags = (props.tags ?? []).map((t) => t.toLowerCase());

  // 1) Explicit task_type wins over heuristics (user-chosen).
  if (props.taskType === 'bug') return 'bugfix/';
  if (props.taskType === 'feature') return 'feature/';
  if (props.taskType === 'chore') return 'chore/';

  // 2) Hotfix tag/label takes precedence over issuetype.
  if (tags.some((t) => t === 'hotfix' || t.includes('hotfix'))) return 'hotfix/';

  // 3) Jira issuetype is imported into tags (see services/jira.ts).
  if (tags.some((t) => t === 'bug')) return 'bugfix/';
  if (tags.some((t) => t === 'epic')) return 'epic/';
  if (tags.some((t) => t === 'story' || t === 'task' || t === 'new feature' || t === 'improvement')) {
    return 'feature/';
  }
  if (tags.some((t) => t === 'subtask' || t === 'sub-task' || t === 'chore')) return 'chore/';

  // 4) Title heuristic for local todos without classification.
  if (/\b(fix|bug)\b/i.test(props.title ?? '')) return 'bugfix/';
  return 'feature/';
}

/**
 * Strip a leading "[KEY] " prefix from Jira-imported titles so the slug
 * contains only the summary, not the duplicated key.
 */
function stripJiraKeyPrefix(title: string, key: string): string {
  const pattern = new RegExp(`^\\s*\\[${key}\\]\\s*`, 'i');
  return title.replace(pattern, '');
}

const branchName = computed(() => {
  // Sandbox mode: delegate to the shared helper so the server-side derivation
  // and every UI surface agree on the same name.
  if (props.sandboxMode) {
    return computeAgentBranchName({
      id: props.todoId ?? 0,
      title: props.title ?? '',
      source: props.source ?? 'local',
      source_ref: props.sourceRef ?? null,
    });
  }

  const prefix = pickPrefix();
  const title = props.title ?? '';

  // Jira: <prefix>/<KEY>-<summary-slug>, mirrors Bitbucket/Jira "Create branch".
  if (props.source === 'jira' && props.sourceRef) {
    const key = props.sourceRef.toUpperCase();
    const summary = stripJiraKeyPrefix(title, key);
    // Reserve chars for the KEY + dash; 50-char summary cap keeps total reasonable.
    const summarySlug = slugify(summary, 50);
    if (summarySlug) return `${prefix}${key}-${summarySlug}`;
    return `${prefix}${key}`;
  }

  // GitHub: include issue number for traceability, e.g. feature/123-add-login.
  if (props.source === 'github' && props.sourceRef) {
    const ref = props.sourceRef.replace(/^#/, '');
    const summarySlug = slugify(title, 50);
    if (summarySlug) return `${prefix}${ref}-${summarySlug}`;
    return `${prefix}${ref}`;
  }

  // Local todos: prefix + slug, fall back to task-<id> / untitled when empty.
  const slug = slugify(title);
  if (slug) return `${prefix}${slug}`;
  const fallback = props.todoId != null ? `task-${props.todoId}` : 'untitled';
  return `${prefix}${fallback}`;
});

const command = computed(() => `git checkout -b ${branchName.value}`);

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
      :title="source === 'jira' ? 'Branch-Name folgt dem Jira-Format: <type>/<KEY>-<summary>' : undefined"
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
