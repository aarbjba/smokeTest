import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { decryptToken } from '../crypto.js';
import { resolveAttachmentPaths } from '../routes/attachments.js';
import { claudeSessions, renderPreprompt, treeKill } from './claude-sessions.js';

const IS_WINDOWS = process.platform === 'win32';
const CONTAINER_NAME_PREFIX = 'werkbank-sbx-';

// apps/api/{src|dist}/services → repo root: ../../../..
const __dirname_es = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname_es, '../../../..');

// ─── Settings helpers ──────────────────────────────────────────────────────

/**
 * Read a setting row and JSON.parse its value. Falls back to the provided
 * default on any read/parse failure. Mirrors the pattern in
 * claude-sessions.ts:296-302 — settings values are always JSON-encoded so a
 * bare string like `"werkbank-sandbox:latest"` comes out as an actual string.
 */
function getSetting<T>(key: string, fallback: T): T {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    const parsed = JSON.parse(row.value);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function getDockerContext(): string {
  return process.env.SANDBOX_DOCKER_CONTEXT || getSetting<string>('sandbox.docker_context', 'lp03');
}

function getImageTag(): string {
  return (
    process.env.SANDBOX_IMAGE_TAG || getSetting<string>('sandbox.image_tag', 'werkbank-sandbox:latest')
  );
}

function maxSlots(): number {
  const raw = getSetting<number>('sandbox.max_concurrent', 3);
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

// ─── Slug / resolvers ──────────────────────────────────────────────────────

/**
 * Kebab-case slug, capped at `maxLen` chars, preferring a word boundary in the
 * second half of the cut window. Kept in sync with apps/web/src/components/
 * GitBranchButton.vue so UI-rendered branch names round-trip cleanly.
 */
function slugify(input: string, maxLen = 40): string {
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

interface TodoRow {
  id: number;
  title: string;
  source: 'local' | 'github' | 'jira';
  source_ref: string | null;
  source_url: string | null;
  branch_name: string | null;
  base_branch: string | null;
  test_command: string | null;
  sandbox_timeout_min: number | null;
  sandbox_max_turns: number | null;
  working_directory: string | null;
  task_type: string | null;
  tags: string | null;
}

function loadTodo(todoId: number): TodoRow {
  const row = db
    .prepare(
      `SELECT id, title, source, source_ref, source_url, branch_name, base_branch,
              test_command, sandbox_timeout_min, sandbox_max_turns,
              working_directory, task_type, tags
         FROM todos WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(todoId) as TodoRow | undefined;
  if (!row) {
    throw Object.assign(new Error(`Todo ${todoId} not found`), { status: 404 });
  }
  return row;
}

/**
 * Build the git clone URL from a github-source todo. `source_ref` is stored
 * as `owner/name#kind-number`; we strip the `#…` suffix and wrap in the
 * standard HTTPS repo URL. Non-github todos are rejected — sandbox currently
 * only supports GitHub because the entrypoint opens a GitHub PR.
 */
function resolveRepoUrl(todo: TodoRow): string {
  if (todo.source !== 'github') {
    throw Object.assign(new Error('Sandbox requires a GitHub source todo'), { status: 400 });
  }
  const ref = (todo.source_ref ?? '').split('#')[0];
  if (!ref || !ref.includes('/')) {
    throw Object.assign(new Error(`Invalid GitHub source_ref: ${todo.source_ref}`), { status: 400 });
  }
  return `https://github.com/${ref}.git`;
}

/** Decrypt the stored GitHub PAT. Throws 400 if not configured. */
function getGithubToken(): string {
  const row = db
    .prepare(
      `SELECT token_enc, token_iv, token_tag FROM integrations WHERE provider = 'github'`,
    )
    .get() as
    | { token_enc: string | null; token_iv: string | null; token_tag: string | null }
    | undefined;
  if (!row || !row.token_enc || !row.token_iv || !row.token_tag) {
    throw Object.assign(new Error('GitHub token not configured'), { status: 400 });
  }
  return decryptToken(row.token_enc, row.token_iv, row.token_tag);
}

// ─── Spawn helper ──────────────────────────────────────────────────────────

function dockerSpawn(args: string[], opts: { cwd?: string } = {}): ChildProcess {
  return spawn('docker', args, {
    shell: true,
    windowsHide: true,
    detached: !IS_WINDOWS,
    cwd: opts.cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dockerSync(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, {
    shell: true,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  };
}

// ─── Types / semaphore ─────────────────────────────────────────────────────

export interface SandboxStartOpts {
  attachmentIds?: number[];
  includeAnalyses?: boolean;
  includeSnippets?: boolean;
  branchName?: string;
  baseBranch?: string;
  testCommand?: string | null;
  maxTurns?: number;
  timeoutMin?: number;
}

interface RunSlot {
  todoId: number;
  runId: string;
  containerName: string;
  startedAt: number;
  state: 'running' | 'queued';
  branch: string;
  baseBranch: string;
  timeoutMin: number;
  // Live handles — only populated once the slot is launched.
  logsChild?: ChildProcess;
  watchdog?: NodeJS.Timeout;
  cachedStatusLine?: string;
  envFilePath?: string;
}

interface QueuedItem {
  todoId: number;
  prompt: string;
  opts: SandboxStartOpts;
  renderedPrompt: string;
  effective: EffectiveConfig;
  repoUrl: string;
  githubToken: string;
  runId: string;
  containerName: string;
}

interface EffectiveConfig {
  branch: string;
  baseBranch: string;
  testCommand: string | null;
  maxTurns: number;
  timeoutMin: number;
  model: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  werkbankPublicUrl: string;
}

const activeRuns = new Map<number, RunSlot>();
const queue: QueuedItem[] = [];

// ─── Public API ────────────────────────────────────────────────────────────

export async function startSandboxRun(
  todoId: number,
  prompt: string,
  opts: SandboxStartOpts = {},
): Promise<{ runId: string; queued: boolean }> {
  if (activeRuns.has(todoId) || claudeSessions.has(todoId)) {
    throw Object.assign(new Error('A session is already running for this todo.'), { status: 409 });
  }

  const todo = loadTodo(todoId);
  const repoUrl = resolveRepoUrl(todo);
  const githubToken = getGithubToken();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not set'), { status: 400 });
  }

  const effective = computeEffective(todo, opts);

  const renderedPrompt = renderPreprompt(
    todoId,
    prompt,
    'work',
    opts.includeAnalyses ?? false,
    opts.includeSnippets ?? false,
  );

  const runId = randomUUID().slice(0, 8);
  const containerName = `${CONTAINER_NAME_PREFIX}${todoId}-${runId}`;

  const item: QueuedItem = {
    todoId,
    prompt,
    opts,
    renderedPrompt,
    effective,
    repoUrl,
    githubToken,
    runId,
    containerName,
  };

  if (activeRuns.size >= maxSlots()) {
    db.prepare(
      `UPDATE todos SET sandbox_status = 'queued', updated_at = datetime('now') WHERE id = ?`,
    ).run(todoId);
    // Track the queued slot so list() surfaces it.
    activeRuns.set(todoId, {
      todoId,
      runId,
      containerName,
      startedAt: Date.now(),
      state: 'queued',
      branch: effective.branch,
      baseBranch: effective.baseBranch,
      timeoutMin: effective.timeoutMin,
    });
    queue.push(item);
    return { runId, queued: true };
  }

  db.prepare(
    `UPDATE todos SET sandbox_status = 'running', updated_at = datetime('now') WHERE id = ?`,
  ).run(todoId);

  // Fire-and-forget — the caller doesn't await container lifecycle.
  launchNow(item).catch((err) => {
    console.error('[sandbox] launchNow failed:', err);
    try {
      db.prepare(
        `UPDATE todos SET sandbox_status = 'failed', updated_at = datetime('now') WHERE id = ?`,
      ).run(todoId);
    } catch {
      /* ignore */
    }
    release(todoId);
  });

  return { runId, queued: false };
}

export function stopSandboxRun(todoId: number): { stopped: boolean } {
  const slot = activeRuns.get(todoId);
  if (!slot) return { stopped: false };
  if (slot.logsChild) {
    treeKill(slot.logsChild.pid);
  }
  // Kill container on the remote context (best-effort).
  try {
    dockerSync(['--context', getDockerContext(), 'kill', slot.containerName]);
  } catch {
    /* ignore */
  }
  try {
    db.prepare(
      `UPDATE todos SET sandbox_status = 'failed', updated_at = datetime('now') WHERE id = ?`,
    ).run(todoId);
  } catch {
    /* ignore */
  }
  if (slot.watchdog) clearTimeout(slot.watchdog);
  release(todoId);
  return { stopped: true };
}

export function listRuns(): Array<{
  todoId: number;
  runId: string;
  containerName: string;
  startedAt: number;
  state: 'running' | 'queued';
  branch: string;
  baseBranch: string;
  timeoutMin: number;
}> {
  return Array.from(activeRuns.values()).map((s) => ({
    todoId: s.todoId,
    runId: s.runId,
    containerName: s.containerName,
    startedAt: s.startedAt,
    state: s.state,
    branch: s.branch,
    baseBranch: s.baseBranch,
    timeoutMin: s.timeoutMin,
  }));
}

/**
 * Rebuild the sandbox image on the configured docker context. Streams `docker
 * build` stdout line-by-line so the caller can pipe it into an SSE response.
 * Yields stderr as `[build stderr] …` prefixed lines so consumers can tell
 * them apart without needing stderr isolation.
 */
export async function* rebuildImage(): AsyncGenerator<string, { ok: boolean; imageTag: string }, void> {
  const imageTag = getImageTag();
  const ctx = getDockerContext();
  // Build context is the repo root (where docker/sandbox/Dockerfile lives).
  const repoRoot = REPO_ROOT;
  const dockerfilePath = join(repoRoot, 'docker', 'sandbox', 'Dockerfile');
  const child = spawn(
    'docker',
    ['--context', ctx, 'build', '-t', imageTag, '-f', dockerfilePath, '.'],
    {
      cwd: repoRoot,
      shell: true,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const emitter = new EventEmitter();
  const queueOut: string[] = [];
  let ended = false;
  let exitCode: number | null = null;

  child.stdout?.on('data', (b: Buffer) => {
    const text = b.toString('utf8');
    queueOut.push(text);
    emitter.emit('data');
  });
  child.stderr?.on('data', (b: Buffer) => {
    const text = b.toString('utf8');
    queueOut.push(`[build stderr] ${text}`);
    emitter.emit('data');
  });
  child.on('close', (code) => {
    exitCode = code;
    ended = true;
    emitter.emit('data');
  });

  while (!ended || queueOut.length > 0) {
    if (queueOut.length === 0) {
      await new Promise<void>((r) => emitter.once('data', () => r()));
      continue;
    }
    yield queueOut.shift()!;
  }

  return { ok: exitCode === 0, imageTag };
}

/**
 * Probe the configured werkbank public URL from inside the sandbox docker
 * context. Returns a small parsed result — UI shows "reachable" or the curl
 * detail so the user knows whether the container can reach back.
 */
export async function testConnection(): Promise<{
  ok: boolean;
  werkbankReachable: boolean;
  detail: string;
}> {
  const ctx = getDockerContext();
  const url = getSetting<string>('sandbox.werkbank_public_url', '');
  if (!url) {
    return { ok: false, werkbankReachable: false, detail: 'sandbox.werkbank_public_url is not set' };
  }
  const target = url.endsWith('/') ? `${url}api/health` : `${url}/api/health`;
  const r = spawnSync(
    'docker',
    [
      '--context',
      ctx,
      'run',
      '--rm',
      'curlimages/curl:latest',
      '-sSf',
      '--max-time',
      '5',
      target,
    ],
    { shell: true, windowsHide: true, encoding: 'utf8' },
  );
  const stdout = (r.stdout ?? '').toString();
  const stderr = (r.stderr ?? '').toString();
  const ok = r.status === 0;
  return {
    ok,
    werkbankReachable: ok,
    detail: ok ? stdout.trim() : stderr.trim() || `curl exited ${r.status}`,
  };
}

/**
 * Clean up orphaned sandbox containers on the configured docker context. Runs
 * on startup — a werkbank crash (or host reboot) can leave `--rm` containers
 * orphaned since --rm only fires on clean exit. Scoped by name prefix so we
 * never touch unrelated containers.
 */
export async function sweepOrphans(): Promise<void> {
  const ctx = getDockerContext();
  const r = dockerSync([
    '--context',
    ctx,
    'ps',
    '-a',
    '--filter',
    `name=${CONTAINER_NAME_PREFIX}`,
    '--format',
    '{{.Names}}',
  ]);
  if (r.status !== 0) {
    // Docker context unreachable (ssh not up yet, etc) — non-fatal on startup.
    return;
  }
  const names = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    dockerSync(['--context', ctx, 'rm', '-f', n]);
  }
}

// ─── Internal: effective config + launch lifecycle ─────────────────────────

function computeEffective(todo: TodoRow, opts: SandboxStartOpts): EffectiveConfig {
  // Precedence: per-todo column → opts override → setting default.
  // Branch: opts → todo.branch_name → derived from title.
  const defaultBranch = deriveBranch(todo);
  const branch = opts.branchName ?? todo.branch_name ?? defaultBranch;

  const baseBranch = opts.baseBranch ?? todo.base_branch ?? 'develop';

  // testCommand: explicit null from opts means "clear", undefined means "use default".
  const testCommand = 'testCommand' in opts
    ? opts.testCommand ?? null
    : todo.test_command ?? null;

  const maxTurns =
    opts.maxTurns ??
    todo.sandbox_max_turns ??
    getSetting<number>('sandbox.default_max_turns', 40);

  const timeoutMin =
    opts.timeoutMin ??
    todo.sandbox_timeout_min ??
    getSetting<number>('sandbox.default_timeout_min', 30);

  const model = getSetting<string>('sandbox.claude_model', 'claude-sonnet-4-5');
  const gitAuthorName = getSetting<string>('sandbox.git_author_name', 'claude-bot');
  const gitAuthorEmail = getSetting<string>(
    'sandbox.git_author_email',
    'claude-bot@users.noreply.github.com',
  );
  const werkbankPublicUrl = getSetting<string>('sandbox.werkbank_public_url', '');

  return {
    branch,
    baseBranch,
    testCommand,
    maxTurns: Number(maxTurns) || 40,
    timeoutMin: Number(timeoutMin) || 30,
    model,
    gitAuthorName,
    gitAuthorEmail,
    werkbankPublicUrl,
  };
}

function deriveBranch(todo: TodoRow): string {
  const prefix =
    todo.task_type === 'bug'
      ? 'bugfix/'
      : todo.task_type === 'chore'
        ? 'chore/'
        : 'feature/';
  if (todo.source === 'github' && todo.source_ref) {
    const parts = todo.source_ref.split('#');
    const ref = (parts[1] ?? '').replace(/^issue-|^pr-/, '') || parts[0]?.replace('/', '-') || '';
    const slug = slugify(todo.title, 40);
    if (ref && slug) return `${prefix}${ref}-${slug}`;
    if (ref) return `${prefix}${ref}`;
  }
  const slug = slugify(todo.title, 40);
  return slug ? `${prefix}${slug}` : `${prefix}task-${todo.id}`;
}

/**
 * The container/logs/watchdog lifecycle. Ordered per plan § Task 4 "Run
 * lifecycle (launchNow)" 1–15. Any step that fails abruptly routes to the
 * `markFailed` helper which releases the slot and emits the SSE end event.
 */
async function launchNow(item: QueuedItem): Promise<void> {
  const {
    todoId,
    renderedPrompt: renderedPromptRaw,
    effective,
    repoUrl,
    githubToken,
    runId,
    containerName,
    opts,
  } = item;
  const ctx = getDockerContext();
  const imageTag = getImageTag();

  // Register the slot eagerly so duplicate starts are rejected.
  const slot: RunSlot = {
    todoId,
    runId,
    containerName,
    startedAt: Date.now(),
    state: 'running',
    branch: effective.branch,
    baseBranch: effective.baseBranch,
    timeoutMin: effective.timeoutMin,
  };
  activeRuns.set(todoId, slot);

  // Step 2 — ensure image exists on the context; stream a rebuild if missing.
  const inspect = dockerSync(['--context', ctx, 'image', 'inspect', imageTag]);
  if (inspect.status !== 0) {
    // Stream build chunks into the SSE pipe BEFORE the session proper. We
    // still want to register the session early so the UI sees progress.
    claudeSessions.registerExternalSession(todoId, {
      cwd: '(sandbox)',
      prompt: renderedPromptRaw,
    });
    claudeSessions.pushExternalStdout(
      todoId,
      `[building sandbox image ${imageTag} on context ${ctx}]\n`,
    );
    try {
      const gen = rebuildImage();
      let next = await gen.next();
      while (!next.done) {
        claudeSessions.pushExternalStdout(todoId, `[building sandbox image …] ${next.value}`);
        next = await gen.next();
      }
      if (!next.value?.ok) {
        claudeSessions.endExternalSession(todoId, {
          exitCode: 1,
          errorMessage: 'image build failed',
        });
        markFailedDb(todoId);
        release(todoId);
        return;
      }
    } catch (err) {
      claudeSessions.endExternalSession(todoId, {
        exitCode: 1,
        errorMessage: err instanceof Error ? err.message : 'image build errored',
      });
      markFailedDb(todoId);
      release(todoId);
      return;
    }
  } else {
    // Step 3 — register the SSE-visible session once image is confirmed.
    claudeSessions.registerExternalSession(todoId, {
      cwd: '(sandbox)',
      prompt: renderedPromptRaw,
    });
  }

  // Step 4 — resolve attachments.
  const attachments =
    opts.attachmentIds && opts.attachmentIds.length > 0
      ? resolveAttachmentPaths(todoId, opts.attachmentIds)
      : [];
  const attachmentPlan = attachments.map((a) => ({
    ...a,
    containerPath: `/attachments/${a.id}-${a.filename}`,
  }));

  // Step 5 — rewrite host paths to container paths in the rendered prompt
  // before it gets handed to the container via env-file. `renderPreprompt`'s
  // attached-files preamble embeds the host paths verbatim; the agent runs in
  // the container, so those paths must be rewritten.
  let renderedPrompt = renderedPromptRaw;
  for (const a of attachmentPlan) {
    renderedPrompt = renderedPrompt.split(a.absPath).join(a.containerPath);
  }

  // Step 6 — build env-file. 0600 perms, temp dir, deleted in finally.
  const envFilePath = writeEnvFile(runId, {
    GITHUB_TOKEN: githubToken,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    REPO_URL: repoUrl,
    BASE_BRANCH: effective.baseBranch,
    BRANCH_NAME: effective.branch,
    TODO_TEXT: renderedPrompt,
    TODO_ID: String(todoId),
    TASK_ID: `${todoId}-${runId}`,
    WERKBANK_API_URL: effective.werkbankPublicUrl,
    WERKBANK_HOST: effective.werkbankPublicUrl,
    MAX_TURNS: String(effective.maxTurns),
    TEST_CMD: effective.testCommand ?? '',
    CLAUDE_MODEL: effective.model,
    GIT_AUTHOR_NAME: effective.gitAuthorName,
    GIT_AUTHOR_EMAIL: effective.gitAuthorEmail,
  });
  slot.envFilePath = envFilePath;

  // Hardened `docker run -d`.
  const runArgs = [
    '--context',
    ctx,
    'run',
    '--rm',
    '-d',
    '--name',
    containerName,
    '--env-file',
    envFilePath,
    '--cap-drop=ALL',
    '--cap-add=NET_ADMIN',
    '--cap-add=NET_RAW',
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--tmpfs',
    '/tmp:size=256m,noexec,nosuid',
    '--tmpfs',
    '/workspace:size=4g,exec,nosuid,uid=1000,gid=1000',
    '--tmpfs',
    '/home/node:size=64m,exec,nosuid,uid=1000,gid=1000',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--pids-limit=512',
    '-u',
    '1000:1000',
    imageTag,
  ];

  // Step 7 — synchronous `docker run -d`. On non-zero exit: bail.
  const runResult = dockerSync(runArgs);
  if (runResult.status !== 0) {
    const detail = runResult.stderr.trim() || `docker run exited ${runResult.status}`;
    claudeSessions.pushExternalStdout(todoId, `[docker run failed] ${detail}\n`);
    claudeSessions.endExternalSession(todoId, {
      exitCode: runResult.status,
      errorMessage: detail,
    });
    markFailedDb(todoId);
    safeUnlink(envFilePath);
    release(todoId);
    return;
  }

  // Step 8 — copy attachments one-by-one; non-fatal on failure. Once all copies
  // have been attempted, signal the entrypoint that attachments are ready.
  for (const a of attachmentPlan) {
    const cp = dockerSync([
      '--context',
      ctx,
      'cp',
      a.absPath,
      `${containerName}:${a.containerPath}`,
    ]);
    if (cp.status !== 0) {
      claudeSessions.pushExternalStdout(
        todoId,
        `[attachment copy failed for ${a.filename}] ${cp.stderr.trim()}\n`,
      );
    }
  }
  dockerSync(['--context', ctx, 'exec', containerName, 'touch', '/attachments/.ready']);

  // Step 9 — long-lived `docker logs -f` child. stdout → session; stderr →
  // annotated chunks. Cache the final `{"status":…}` line so step 12 has a
  // fallback when --rm wipes the status.json before we can cp it.
  const logsChild = dockerSpawn(['--context', ctx, 'logs', '-f', containerName]);
  slot.logsChild = logsChild;

  logsChild.stdout?.on('data', (b: Buffer) => {
    const text = b.toString('utf8');
    // Cache final status lines (entrypoint prints JSON like {"status":"pushed"})
    // — the cached one wins over a `docker cp` attempt in step 12.
    for (const line of text.split('\n')) {
      if (/^\s*\{\s*"status"\s*:/.test(line)) {
        slot.cachedStatusLine = line.trim();
      }
    }
    claudeSessions.pushExternalStdout(todoId, text);
  });
  logsChild.stderr?.on('data', (b: Buffer) => {
    const text = b.toString('utf8');
    if (text.trim()) {
      claudeSessions.pushExternalStdout(todoId, `[docker stderr] ${text}`);
    }
  });

  // Step 10 — watchdog.
  slot.watchdog = setTimeout(
    () => killRun(todoId, 'timeout'),
    Math.max(60_000, effective.timeoutMin * 60_000),
  );

  logsChild.on('close', async () => {
    if (slot.watchdog) {
      clearTimeout(slot.watchdog);
      slot.watchdog = undefined;
    }

    // Step 11 — poll container state for actual exit code.
    let exitCode = await pollContainerExit(ctx, containerName);

    // Step 12 — recover status. Try `docker cp` first, fall back to cached line.
    const statusPayload = recoverStatusPayload(ctx, containerName, slot);

    // Step 13 — map exit → sandbox_status.
    const mapped = mapExitToStatus(exitCode, statusPayload);
    try {
      db.prepare(
        `UPDATE todos
            SET sandbox_status = ?,
                sandbox_pr_url = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(mapped.status, mapped.prUrl ?? null, todoId);
    } catch (err) {
      console.error('[sandbox] status write failed:', err);
    }

    // Step 14 — end session (SSE `end` fires).
    claudeSessions.endExternalSession(todoId, {
      exitCode,
      errorMessage: mapped.status === 'pushed' ? null : mapped.detail ?? null,
    });

    // Step 15 — best-effort `rm -f`, unlink env-file, release slot, drain queue.
    dockerSync(['--context', ctx, 'rm', '-f', containerName]);
    safeUnlink(envFilePath);
    release(todoId);
  });
}

/**
 * Poll `docker inspect` for the container's real exit code. The logs-follow
 * pipe can close before the container actually exits (SSH-context reconnects
 * especially). Polls up to 10×1s.
 */
async function pollContainerExit(ctx: string, containerName: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const r = dockerSync([
      '--context',
      ctx,
      'inspect',
      '-f',
      '{{.State.Status}}|{{.State.ExitCode}}',
      containerName,
    ]);
    if (r.status !== 0) {
      // Container already gone (`--rm` fired) — no code to recover. Treat as 0.
      return 0;
    }
    const [state, codeRaw] = r.stdout.trim().split('|');
    const code = Number(codeRaw);
    if (state !== 'running') {
      return Number.isFinite(code) ? code : -1;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return -1;
}

interface StatusPayload {
  status?: string;
  pr_url?: string;
}

function recoverStatusPayload(
  ctx: string,
  containerName: string,
  slot: RunSlot,
): StatusPayload | null {
  // `docker cp container:/path -` writes the file to stdout as a tar stream.
  // We can't easily un-tar inline without extra deps, so prefer the simpler
  // approach: cp to a tmp path on the werkbank host, read, unlink.
  const tmpPath = join(tmpdir(), `werkbank-sbx-${slot.runId}.status.json`);
  try {
    const r = dockerSync([
      '--context',
      ctx,
      'cp',
      `${containerName}:/workspace/${slot.todoId}-${slot.runId}.status.json`,
      tmpPath,
    ]);
    if (r.status === 0) {
      try {
        const content = readFileSync(tmpPath, 'utf8');
        safeUnlink(tmpPath);
        return JSON.parse(content) as StatusPayload;
      } catch {
        /* fall through to cached line */
      }
    }
  } catch {
    /* container already gone; fall through */
  }
  if (slot.cachedStatusLine) {
    try {
      return JSON.parse(slot.cachedStatusLine) as StatusPayload;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function mapExitToStatus(
  exitCode: number,
  payload: StatusPayload | null,
): { status: string; prUrl?: string; detail?: string } {
  switch (exitCode) {
    case 0:
      return { status: 'pushed', prUrl: payload?.pr_url };
    case 2:
      return { status: 'no_changes' };
    case 3:
      return { status: 'failed', detail: 'claude error' };
    case 4:
      return { status: 'failed', detail: 'tests failed' };
    case 5:
      return { status: 'no_test' };
    case 130:
      return { status: 'failed', detail: 'interrupted' };
    default:
      return { status: 'failed', detail: `exit ${exitCode}` };
  }
}

function killRun(todoId: number, reason: string): void {
  const slot = activeRuns.get(todoId);
  if (!slot) return;
  const ctx = getDockerContext();
  try {
    dockerSync(['--context', ctx, 'kill', slot.containerName]);
  } catch {
    /* ignore */
  }
  claudeSessions.pushExternalStdout(todoId, `\n[sandbox killed: ${reason}]\n`);
  if (slot.logsChild) treeKill(slot.logsChild.pid);
}

function markFailedDb(todoId: number): void {
  try {
    db.prepare(
      `UPDATE todos SET sandbox_status = 'failed', updated_at = datetime('now') WHERE id = ?`,
    ).run(todoId);
  } catch {
    /* ignore */
  }
}

function release(todoId: number): void {
  activeRuns.delete(todoId);
  // FIFO drain via setImmediate so we never recurse within the same tick.
  setImmediate(() => {
    while (activeRuns.size < maxSlots() && queue.length > 0) {
      const next = queue.shift()!;
      // Re-check — the todo may have been stopped or cleared while queued.
      db.prepare(
        `UPDATE todos SET sandbox_status = 'running', updated_at = datetime('now') WHERE id = ?`,
      ).run(next.todoId);
      launchNow(next).catch((err) => {
        console.error('[sandbox] queued launchNow failed:', err);
        markFailedDb(next.todoId);
        release(next.todoId);
      });
    }
  });
}

// ─── Env-file write helpers ────────────────────────────────────────────────

function writeEnvFile(runId: string, env: Record<string, string>): string {
  const dir = join(tmpdir(), 'werkbank-sandbox');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.env`);
  // docker --env-file is line-delimited: one KEY=VALUE per line, no quoting,
  // and newlines terminate entries — so multi-line values can't be passed
  // through. TODO_TEXT (the rendered preprompt) has real newlines; we encode
  // them as literal `\n` so the env parses cleanly. The entrypoint's heredoc
  // won't re-interpret the escape, so the agent sees `\n` in its prompt —
  // degraded but fully readable. Base64-decoding would need an M1 entrypoint
  // change, which is out of scope for this milestone.
  const lines: string[] = [];
  for (const [k, vRaw] of Object.entries(env)) {
    const v = (vRaw ?? '').replace(/\r?\n/g, '\\n');
    lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  return path;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

