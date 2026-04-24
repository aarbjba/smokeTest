import type { Todo } from '../types';

/**
 * Slug rules (shared with GitBranchButton.vue and backend sandbox-runner.ts):
 *  - lowercase, replace non-alphanumeric with "-", collapse "-+", trim leading/trailing "-"
 *  - cap at maxLen, preferring word boundary (last "-" in the cut window)
 */
export function slugifyForBranch(input: string, maxLen = 40): string {
  const lowered = (input ?? '').toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-');
  const collapsed = replaced.replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  if (trimmed.length <= maxLen) return trimmed;
  const window = trimmed.slice(0, maxLen);
  const lastDash = window.lastIndexOf('-');
  if (lastDash >= Math.floor(maxLen / 2)) return window.slice(0, lastDash);
  return window;
}

/**
 * Compute the branch name the sandbox runner will derive server-side when
 * `todo.branch_name` is empty. The detail view and the "In Sandbox starten"
 * button share this function to display an accurate placeholder and pre-seed
 * the persisted name on first click.
 *
 * MUST match `deriveBranch` in apps/api/src/services/sandbox-runner.ts for
 * github-sourced todos — the plan hands sandbox off to GitHub only, so this
 * is the path that matters. See `sandbox-plan_v2_final.md#branch-naming`.
 *
 * Slimmed client port:
 *   - Sandbox is github-only. Jira gets the same github-style fallback since
 *     the start button gates on source_ref + github token, but we still want
 *     a useful preview string for other sources instead of an empty field.
 *   - prefix: `agent/` — sandbox always prefixes this way (the backend uses
 *     feature/bugfix/chore for plain GitBranchButton; sandbox mode collapses
 *     them into a single `agent/` namespace so CI rules can filter cleanly).
 */
export function computeAgentBranchName(
  todo: Pick<Todo, 'id' | 'title' | 'source' | 'source_ref'>,
): string {
  const prefix = 'agent/';
  const slug = slugifyForBranch(todo.title, 40);

  if (todo.source === 'github' && todo.source_ref) {
    // Mirror server-side parse: source_ref is typically `owner/repo#123` — pull
    // the issue/PR number from after the `#`, stripping optional `issue-`/`pr-`.
    const parts = todo.source_ref.split('#');
    const raw = (parts[1] ?? '').replace(/^issue-|^pr-/, '') || parts[0]?.replace('/', '-') || '';
    if (raw && slug) return `${prefix}${todo.id}-${slug}`;
    if (raw) return `${prefix}${todo.id}`;
  }

  if (slug) return `${prefix}${todo.id}-${slug}`;
  return `${prefix}${todo.id}`;
}
