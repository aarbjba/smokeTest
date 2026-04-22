import { db } from '../db.js';
import { decryptToken } from '../crypto.js';
import { jiraProjectKeyFor, resolveLocalPath } from './repo-mappings.js';

type IntegrationRow = {
  token_enc: string | null;
  token_iv: string | null;
  token_tag: string | null;
  config: string;
};

type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string; statusCategory?: { key: string } };
    priority?: { name: string };
    labels?: string[];
    issuetype?: { name: string };
  };
};

function stripAdf(desc: unknown): string {
  if (typeof desc === 'string') return desc;
  if (!desc || typeof desc !== 'object') return '';
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: unknown[]; type?: string };
    if (n.text) parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(desc);
  return parts.join(' ').slice(0, 2000);
}

function mapStatus(category: string | undefined): 'todo' | 'in_progress' | 'done' {
  if (category === 'done') return 'done';
  if (category === 'indeterminate') return 'in_progress';
  return 'todo';
}

function mapPriority(name: string | undefined): number {
  switch ((name ?? '').toLowerCase()) {
    case 'highest': return 1;
    case 'high':    return 1;
    case 'medium':  return 2;
    case 'low':     return 3;
    case 'lowest':  return 4;
    default:        return 2;
  }
}

export async function syncJira(): Promise<{ imported: number; updated: number; total: number; pages: number }> {
  const row = db.prepare(`SELECT * FROM integrations WHERE provider = 'jira'`).get() as IntegrationRow | undefined;
  if (!row || !row.token_enc || !row.token_iv || !row.token_tag) {
    throw Object.assign(new Error('Jira token not configured'), { status: 400 });
  }
  const config = JSON.parse(row.config) as { baseUrl: string; email: string; jql: string };
  if (!config.baseUrl || !config.email || !config.jql) {
    throw Object.assign(new Error('Jira baseUrl, email and jql required'), { status: 400 });
  }
  const token = decryptToken(row.token_enc, row.token_iv, row.token_tag);
  const auth = Buffer.from(`${config.email}:${token}`).toString('base64');

  const baseUrl = config.baseUrl.replace(/\/$/, '');

  const insertNew = db.prepare(`
    INSERT INTO todos (title, description, status, priority, tags, source, source_ref, source_url, position, working_directory)
    VALUES (@title, @description, @status, @priority, @tags, 'jira', @source_ref, @source_url,
            (SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE status = @status),
            @working_directory)
  `);
  // Intentionally do NOT touch status on update: the user may have manually moved
  // the card (e.g. to Prüfstand) and we don't want to overwrite that.
  // Priority also stays — changing it would silently re-sort cards the user pinned.
  // working_directory: preserve user override, fill in only if still empty.
  const updateExisting = db.prepare(`
    UPDATE todos SET
      title = @title,
      description = @description,
      tags = @tags,
      source_url = @source_url,
      working_directory = COALESCE(NULLIF(working_directory, ''), @working_directory),
      updated_at = datetime('now')
    WHERE source = 'jira' AND source_ref = @source_ref
  `);

  let imported = 0, updated = 0, total = 0, pages = 0;
  let nextPageToken: string | undefined;

  // New enhanced-search API: POST /rest/api/3/search/jql with cursor pagination.
  // See https://developer.atlassian.com/changelog/#CHANGE-2046
  // Sanity cap so a runaway JQL can't loop forever.
  for (let page = 0; page < 20; page++) {
    const body: Record<string, unknown> = {
      jql: config.jql,
      fields: ['summary', 'description', 'status', 'priority', 'labels', 'issuetype'],
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const resp = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Jira ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = (await resp.json()) as { issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean };

    for (const issue of data.issues ?? []) {
      const existing = db.prepare(`SELECT id FROM todos WHERE source='jira' AND source_ref=?`).get(issue.key);
      const tags = [...(issue.fields.labels ?? []), issue.fields.issuetype?.name].filter((x): x is string => Boolean(x));
      // Resolve working_directory by project key first, then fall back to any
      // GitHub repo slug present in labels (common convention for cross-referencing).
      let workingDirectory: string | null = null;
      const projectKey = jiraProjectKeyFor(issue.key);
      if (projectKey) workingDirectory = resolveLocalPath('jira', projectKey);
      if (!workingDirectory) {
        for (const label of issue.fields.labels ?? []) {
          if (label.includes('/')) {
            const hit = resolveLocalPath('github', label);
            if (hit) { workingDirectory = hit; break; }
          }
        }
      }
      const params = {
        title: `[${issue.key}] ${issue.fields.summary}`,
        description: stripAdf(issue.fields.description),
        status: mapStatus(issue.fields.status?.statusCategory?.key),
        priority: mapPriority(issue.fields.priority?.name),
        tags: JSON.stringify(tags),
        source_ref: issue.key,
        source_url: `${baseUrl}/browse/${issue.key}`,
        working_directory: workingDirectory,
      };
      if (existing) { updateExisting.run(params); updated++; }
      else { insertNew.run(params); imported++; }
      total++;
    }
    pages++;

    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  db.prepare(`UPDATE integrations SET last_sync_at = datetime('now'), last_sync_error = NULL WHERE provider='jira'`).run();
  return { imported, updated, total, pages };
}
