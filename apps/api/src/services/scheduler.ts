import { db } from '../db.js';
import { syncGithub } from './github.js';
import { syncJira } from './jira.js';

type Provider = 'github' | 'jira';

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const running: Record<Provider, boolean> = { github: false, jira: false };

function hasToken(provider: Provider): boolean {
  const row = db.prepare(`SELECT token_enc FROM integrations WHERE provider = ? AND enabled = 1`).get(provider) as { token_enc: string | null } | undefined;
  return !!row?.token_enc;
}

async function runOne(provider: Provider, fn: () => Promise<unknown>): Promise<void> {
  if (running[provider]) return; // overlap guard
  if (!hasToken(provider)) return;
  running[provider] = true;
  try {
    await fn();
    console.log(`[scheduler] ${provider} sync ok`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[scheduler] ${provider} sync failed: ${msg}`);
    db.prepare(`UPDATE integrations SET last_sync_error = ? WHERE provider = ?`).run(msg, provider);
  } finally {
    running[provider] = false;
  }
}

export function startScheduler() {
  // One initial pass ~10s after boot so the user has a fresh view quickly.
  setTimeout(() => {
    void runOne('github', syncGithub);
    void runOne('jira', syncJira);
  }, 10_000);

  setInterval(() => { void runOne('github', syncGithub); }, INTERVAL_MS);
  setInterval(() => { void runOne('jira',   syncJira); },   INTERVAL_MS);

  console.log(`[scheduler] auto-sync enabled (interval: ${INTERVAL_MS / 1000}s)`);
}
