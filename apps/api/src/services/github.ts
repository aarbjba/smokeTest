import { db } from '../db.js';
import { decryptToken } from '../crypto.js';
import { resolveLocalPath } from './repo-mappings.js';

type IntegrationRow = {
  token_enc: string | null;
  token_iv: string | null;
  token_tag: string | null;
  config: string;
};

type GitHubItem = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  pull_request?: unknown;
  repository_url?: string;
  labels?: { name: string }[];
};

async function fetchRepoIssues(token: string, repo: string): Promise<GitHubItem[]> {
  // Issues endpoint also returns PRs; we handle both.
  const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'werkbank',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GitHub ${resp.status} for ${repo}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as GitHubItem[];
}

export async function syncGithub(): Promise<{ imported: number; updated: number; repos: string[] }> {
  const row = db.prepare(`SELECT * FROM integrations WHERE provider = 'github'`).get() as IntegrationRow | undefined;
  if (!row || !row.token_enc || !row.token_iv || !row.token_tag) {
    throw Object.assign(new Error('GitHub token not configured'), { status: 400 });
  }
  const token = decryptToken(row.token_enc, row.token_iv, row.token_tag);
  const config = JSON.parse(row.config) as { repos: string[] };
  const repos = (config.repos ?? []).filter(Boolean);
  if (repos.length === 0) {
    throw Object.assign(new Error('No repos configured'), { status: 400 });
  }

  let imported = 0;
  let updated = 0;

  const insertNew = db.prepare(`
    INSERT INTO todos (title, description, status, priority, tags, source, source_ref, source_url, position, working_directory)
    VALUES (@title, @description, 'todo', @priority, @tags, 'github', @source_ref, @source_url,
            (SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE status = 'todo'),
            @working_directory)
  `);
  // On re-sync we preserve any user-set working_directory but fill it in if
  // it's still empty and a repo mapping exists (configured after initial import).
  const updateExisting = db.prepare(`
    UPDATE todos SET
      title = @title,
      description = @description,
      tags = @tags,
      source_url = @source_url,
      working_directory = COALESCE(NULLIF(working_directory, ''), @working_directory),
      updated_at = datetime('now')
    WHERE source = 'github' AND source_ref = @source_ref
  `);

  for (const repo of repos) {
    const items = await fetchRepoIssues(token, repo);
    const workingDirectory = resolveLocalPath('github', repo);
    for (const item of items) {
      const kind = item.pull_request ? 'pr' : 'issue';
      const tags = [repo, kind, ...(item.labels ?? []).map((l) => l.name)];
      const sourceRef = `${repo}#${kind}-${item.number}`;
      const existing = db.prepare(`SELECT id FROM todos WHERE source='github' AND source_ref=?`).get(sourceRef);
      const params = {
        title: `[${repo}#${item.number}] ${item.title}`,
        description: item.body ?? '',
        priority: 2,
        tags: JSON.stringify(tags),
        source_ref: sourceRef,
        source_url: item.html_url,
        working_directory: workingDirectory,
      };
      if (existing) { updateExisting.run(params); updated++; }
      else { insertNew.run(params); imported++; }
    }
  }

  db.prepare(`UPDATE integrations SET last_sync_at = datetime('now'), last_sync_error = NULL WHERE provider='github'`).run();
  return { imported, updated, repos };
}
