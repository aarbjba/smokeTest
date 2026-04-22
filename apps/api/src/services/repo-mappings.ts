import { db } from '../db.js';

export type RepoMappingSource = 'github' | 'jira';

export interface RepoMapping {
  id: number;
  source: RepoMappingSource;
  key: string;
  local_path: string;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the configured local git path for a given source/key, or null if no
 * mapping exists. Used by github/jira sync services to fill `todos.working_directory`
 * at import time so the Claude agent can spawn in the correct repo.
 */
export function resolveLocalPath(source: RepoMappingSource, key: string): string | null {
  const row = db
    .prepare(`SELECT local_path FROM repo_mappings WHERE source = ? AND key = ?`)
    .get(source, key) as { local_path: string } | undefined;
  return row?.local_path ?? null;
}

/**
 * Extract the Jira project key prefix from an issue key. `AAR-1163` → `AAR`.
 * Returns null if the input doesn't look like a `KEY-NUMBER` pair.
 */
export function jiraProjectKeyFor(issueKey: string): string | null {
  const m = issueKey.match(/^([A-Za-z][A-Za-z0-9_]*)-\d+$/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * One-shot backfill: for each todo with a NULL/empty working_directory and a
 * recognizable source (github/jira), look up the mapping and apply it. User
 * overrides (non-empty working_directory) are left alone.
 */
export function backfillWorkingDirectoriesFromMappings(): {
  updated: number;
  scanned: number;
} {
  type TodoRow = {
    id: number;
    source: 'local' | 'github' | 'jira';
    source_ref: string | null;
    tags: string;
  };
  const rows = db
    .prepare(
      `SELECT id, source, source_ref, tags
         FROM todos
        WHERE (working_directory IS NULL OR working_directory = '')
          AND source IN ('github','jira')`,
    )
    .all() as TodoRow[];

  const update = db.prepare(
    `UPDATE todos SET working_directory = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  let updated = 0;
  for (const row of rows) {
    const wd = resolveFromTodoRow(row);
    if (wd) {
      update.run(wd, row.id);
      updated++;
    }
  }
  return { updated, scanned: rows.length };
}

function resolveFromTodoRow(row: {
  source: 'local' | 'github' | 'jira';
  source_ref: string | null;
  tags: string;
}): string | null {
  if (row.source === 'github') {
    // GitHub source_ref format: `owner/name#kind-number` — strip after `#`.
    const ref = row.source_ref ?? '';
    const repoSlug = ref.split('#')[0];
    if (repoSlug) return resolveLocalPath('github', repoSlug);
    return null;
  }
  if (row.source === 'jira') {
    const projectKey = row.source_ref ? jiraProjectKeyFor(row.source_ref) : null;
    if (projectKey) {
      const direct = resolveLocalPath('jira', projectKey);
      if (direct) return direct;
    }
    // Fallback: Jira tickets sometimes carry a GitHub repo slug as a tag
    // (e.g. `HausPerfekt/HausPerfekt.Mobile.Sync`). Try those too.
    try {
      const tags = JSON.parse(row.tags || '[]') as string[];
      for (const tag of tags) {
        if (tag.includes('/')) {
          const hit = resolveLocalPath('github', tag);
          if (hit) return hit;
        }
      }
    } catch {
      /* ignore malformed tags */
    }
  }
  return null;
}
