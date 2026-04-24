import { db } from '../db.js';
import { decryptToken } from '../crypto.js';

type IntegrationRow = {
  token_enc: string | null;
  token_iv: string | null;
  token_tag: string | null;
  config: string;
};

export type LocalStatus = 'todo' | 'in_progress' | 'test' | 'done' | 'pending';

export type TodoForWriteback = {
  id: number;
  source: 'local' | 'github' | 'jira';
  source_ref: string | null;
  status: LocalStatus;
  oldStatus?: LocalStatus;
};

/**
 * Map our local 4-value status to Jira's 3 status categories.
 * 'test' is a local-only concept that lives in Jira's 'indeterminate' bucket
 * alongside 'in_progress'.
 */
function toJiraCategory(s: LocalStatus): 'new' | 'indeterminate' | 'done' {
  if (s === 'done') return 'done';
  if (s === 'in_progress' || s === 'test') return 'indeterminate';
  return 'new';
}

/**
 * Map local status to GitHub's binary issue state.
 * Everything except 'done' keeps the issue open.
 */
function toGithubState(s: LocalStatus): 'open' | 'closed' {
  return s === 'done' ? 'closed' : 'open';
}

function loadToken(provider: 'github' | 'jira'): { token: string; config: Record<string, unknown> } {
  const row = db.prepare(`SELECT * FROM integrations WHERE provider = ?`).get(provider) as IntegrationRow | undefined;
  if (!row || !row.token_enc || !row.token_iv || !row.token_tag) {
    throw new Error(`${provider} not configured`);
  }
  return { token: decryptToken(row.token_enc, row.token_iv, row.token_tag), config: JSON.parse(row.config) };
}

function markWritebackError(todoId: number, error: string | null) {
  db.prepare(
    `UPDATE todos SET last_writeback_at = datetime('now'), last_writeback_error = ? WHERE id = ?`
  ).run(error, todoId);
}

// -------- GitHub --------

function parseGithubRef(ref: string): { owner: string; repo: string; number: number } | null {
  // Format: "owner/repo#issue-123" or "owner/repo#pr-456"
  const m = ref.match(/^([^/]+)\/([^#]+)#(?:issue|pr)-(\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function writebackGithubStatus(todo: TodoForWriteback): Promise<void> {
  if (!todo.source_ref) throw new Error('missing source_ref');
  const parsed = parseGithubRef(todo.source_ref);
  if (!parsed) throw new Error(`unexpected source_ref: ${todo.source_ref}`);
  const { token } = loadToken('github');
  const state = toGithubState(todo.status);
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'werkbank@aarbjba',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GitHub ${resp.status}: ${text.slice(0, 200)}`);
  }
}

// -------- Jira --------

type JiraTransition = {
  id: string;
  name: string;
  to?: { statusCategory?: { key: string } };
};

export async function writebackJiraStatus(todo: TodoForWriteback): Promise<void> {
  if (!todo.source_ref) throw new Error('missing source_ref');
  const { token, config } = loadToken('jira');
  const baseUrl = String(config.baseUrl ?? '').replace(/\/$/, '');
  const email = String(config.email ?? '');
  if (!baseUrl || !email) throw new Error('Jira baseUrl/email not configured');
  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  // 1) list available transitions
  const listResp = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(todo.source_ref)}/transitions`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!listResp.ok) throw new Error(`Jira list transitions ${listResp.status}`);
  const list = (await listResp.json()) as { transitions: JiraTransition[] };

  const wantedCategory = toJiraCategory(todo.status);
  const match = list.transitions.find((t) => t.to?.statusCategory?.key === wantedCategory);
  if (!match) {
    throw new Error(`no Jira transition with target category '${wantedCategory}' available (have: ${list.transitions.map((t) => t.name).join(', ')})`);
  }

  // 2) trigger transition
  const resp = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(todo.source_ref)}/transitions`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Jira transition ${resp.status}: ${text.slice(0, 200)}`);
  }
}

// -------- Dispatcher --------

export async function writebackStatus(todo: TodoForWriteback): Promise<{ ok: true } | { ok: false; error: string } | { skipped: true }> {
  // `pending` is a local-only "info-gathering" state with no remote analogue —
  // skip writeback on either side of the transition so we don't close issues
  // when the analyse-agent parks a todo in Pendliste, and don't reopen them
  // when the user moves it back.
  if (todo.status === 'pending' || todo.oldStatus === 'pending') {
    return { skipped: true };
  }
  // Skip writeback if mapping the old and new local status to the remote system's
  // coarser status produces the same value. Example: in_progress <-> test (both Jira 'indeterminate').
  if (todo.oldStatus) {
    if (todo.source === 'github' && toGithubState(todo.oldStatus) === toGithubState(todo.status)) {
      return { skipped: true };
    }
    if (todo.source === 'jira' && toJiraCategory(todo.oldStatus) === toJiraCategory(todo.status)) {
      return { skipped: true };
    }
  }
  try {
    if (todo.source === 'github') await writebackGithubStatus(todo);
    else if (todo.source === 'jira') await writebackJiraStatus(todo);
    else return { ok: true };
    markWritebackError(todo.id, null);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markWritebackError(todo.id, msg);
    return { ok: false, error: msg };
  }
}

// -------- Jira Worklog --------

export async function writebackJiraWorklog(todo: TodoForWriteback, durationSeconds: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (todo.source !== 'jira' || !todo.source_ref) return { ok: true };
  if (durationSeconds < 60) return { ok: true }; // Jira requires >= 60s
  try {
    const { token, config } = loadToken('jira');
    const baseUrl = String(config.baseUrl ?? '').replace(/\/$/, '');
    const email = String(config.email ?? '');
    if (!baseUrl || !email) throw new Error('Jira baseUrl/email not configured');
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    const resp = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(todo.source_ref)}/worklog`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeSpentSeconds: Math.round(durationSeconds),
        comment: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Logged via Werkbank 🔨' }] }],
        },
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Jira worklog ${resp.status}: ${text.slice(0, 200)}`);
    }
    markWritebackError(todo.id, null);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markWritebackError(todo.id, `worklog: ${msg}`);
    return { ok: false, error: msg };
  }
}
