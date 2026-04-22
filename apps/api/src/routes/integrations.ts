import { Router } from 'express';
import { db } from '../db.js';
import { encryptToken, maskToken, decryptToken } from '../crypto.js';
import { GitHubConfigSchema, JiraConfigSchema } from '../schemas.js';
import { syncGithub } from '../services/github.js';
import { syncJira } from '../services/jira.js';

export const integrationsRouter = Router();

type Row = {
  provider: string;
  enabled: number;
  token_enc: string | null;
  token_iv: string | null;
  token_tag: string | null;
  config: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
};

function getRow(provider: 'github' | 'jira'): Row | undefined {
  return db.prepare(`SELECT * FROM integrations WHERE provider = ?`).get(provider) as Row | undefined;
}

function present(row: Row) {
  let tokenMasked = '';
  if (row.token_enc && row.token_iv && row.token_tag) {
    try {
      const t = decryptToken(row.token_enc, row.token_iv, row.token_tag);
      tokenMasked = maskToken(t);
    } catch {
      tokenMasked = '••••';
    }
  }
  return {
    provider: row.provider,
    enabled: row.enabled === 1,
    hasToken: Boolean(row.token_enc),
    tokenMasked,
    config: JSON.parse(row.config),
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
  };
}

integrationsRouter.get('/', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM integrations`).all() as Row[];
  res.json(rows.map(present));
});

integrationsRouter.put('/github', (req, res) => {
  const data = GitHubConfigSchema.parse(req.body);
  const existing = getRow('github');
  const config = JSON.stringify({ repos: data.repos });
  if (data.token) {
    const { enc, iv, tag } = encryptToken(data.token);
    db.prepare(
      `UPDATE integrations SET enabled = 1, token_enc = ?, token_iv = ?, token_tag = ?, config = ?, updated_at = datetime('now') WHERE provider='github'`
    ).run(enc, iv, tag, config);
  } else {
    db.prepare(
      `UPDATE integrations SET config = ?, enabled = COALESCE(?, enabled), updated_at = datetime('now') WHERE provider='github'`
    ).run(config, existing?.token_enc ? 1 : 0);
  }
  res.json(present(getRow('github')!));
});

integrationsRouter.put('/jira', (req, res) => {
  const data = JiraConfigSchema.parse(req.body);
  const existing = getRow('jira');
  const existingConfig = existing ? JSON.parse(existing.config) : {};
  const config = JSON.stringify({
    baseUrl: data.baseUrl ?? existingConfig.baseUrl ?? '',
    email: data.email ?? existingConfig.email ?? '',
    jql: data.jql ?? existingConfig.jql ?? '',
  });
  if (data.token) {
    const { enc, iv, tag } = encryptToken(data.token);
    db.prepare(
      `UPDATE integrations SET enabled = 1, token_enc = ?, token_iv = ?, token_tag = ?, config = ?, updated_at = datetime('now') WHERE provider='jira'`
    ).run(enc, iv, tag, config);
  } else {
    db.prepare(
      `UPDATE integrations SET config = ?, enabled = COALESCE(?, enabled), updated_at = datetime('now') WHERE provider='jira'`
    ).run(config, existing?.token_enc ? 1 : 0);
  }
  res.json(present(getRow('jira')!));
});

integrationsRouter.delete('/:provider', (req, res) => {
  const provider = req.params.provider;
  if (provider !== 'github' && provider !== 'jira') return res.status(400).json({ error: 'unknown provider' });
  db.prepare(
    `UPDATE integrations SET enabled = 0, token_enc = NULL, token_iv = NULL, token_tag = NULL, last_sync_at = NULL, last_sync_error = NULL WHERE provider = ?`
  ).run(provider);
  res.status(204).end();
});

integrationsRouter.post('/github/sync', async (_req, res, next) => {
  try {
    const result = await syncGithub();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'sync failed';
    db.prepare(`UPDATE integrations SET last_sync_error = ? WHERE provider='github'`).run(msg);
    next(err);
  }
});

integrationsRouter.post('/jira/sync', async (_req, res, next) => {
  try {
    const result = await syncJira();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'sync failed';
    db.prepare(`UPDATE integrations SET last_sync_error = ? WHERE provider='jira'`).run(msg);
    next(err);
  }
});
