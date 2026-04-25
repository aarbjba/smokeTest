import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { db } from '../db.js';
import { resolveAttachmentPaths } from '../routes/attachments.js';
import { claudeSessions, treeKill } from './claude-sessions.js';
import {
  CONTAINER_NAME_PREFIX,
  activeRuns,
  getSetting,
  markFailedDb,
  release,
  safeUnlink,
  writeEnvFile,
  mapExitToStatus,
  type QueuedItem,
  type RunSlot,
  type StatusPayload,
} from './sandbox-runner.js';

/**
 * AWS microVM backend.
 *
 * Runs containers on a remote EC2 host that has firecracker-containerd
 * installed. Multi-todo packing is achieved via the `firecracker.vm_id`
 * containerd annotation: containers with the same vm_id share a single
 * Firecracker microVM, while distinct vm_ids spawn fresh microVMs. We keep
 * an in-process pool of vm_ids — each vm_id holds at most `per_vm_max`
 * containers, and we cap the pool itself at `pool_size` (so total cap is
 * `pool_size × per_vm_max`).
 *
 * Transport: SSH to the EC2 host, then nerdctl drives containerd. nerdctl is
 * a docker-compatible CLI — most flags translate 1:1 from the existing Docker
 * backend. The `--runtime` and `--annotation` flags are the bits that route
 * the container into a Firecracker microVM via the firecracker-containerd
 * shim.
 *
 * This module is dynamic-imported by sandbox-runner.ts so that a circular
 * import (runner ↔ aws backend) is resolved at call time, not load time.
 *
 * NOTE: this backend is not testable without a configured EC2 host. When
 * `sandbox.aws.ssh_host` is empty all entry points throw a descriptive error
 * that surfaces in the SSE pipe as a sandbox failure — no silent no-ops.
 */

// ─── Settings readers ──────────────────────────────────────────────────────

interface AwsConfig {
  sshHost: string;        // e.g. "werkbank@ec2-…compute.amazonaws.com"
  sshKey: string;         // optional path to private key
  containerdSocket: string;
  runtime: string;        // typically "aws.firecracker"
  imageTag: string;
  poolSize: number;
  perVmMax: number;
  werkbankPublicUrl: string;
  // Path on the EC2 host where the werkbank repo is checked out. Used for
  // `nerdctl build` (the build context). The runbook documents that the
  // user must clone the repo here and keep it up to date — see
  // docs/sandbox-aws-setup.md.
  repoPath: string;
  authVolume: string;     // named containerd volume holding pre-logged-in OAuth creds
}

function loadAwsConfig(): AwsConfig {
  return {
    sshHost: getSetting<string>('sandbox.aws.ssh_host', ''),
    sshKey: getSetting<string>('sandbox.aws.ssh_key', ''),
    containerdSocket: getSetting<string>(
      'sandbox.aws.containerd_socket',
      '/run/firecracker-containerd/containerd.sock',
    ),
    runtime: getSetting<string>('sandbox.aws.runtime', 'aws.firecracker'),
    imageTag: getSetting<string>('sandbox.aws.image_tag', 'werkbank-sandbox:latest'),
    poolSize: clampInt(getSetting<number>('sandbox.aws.pool_size', 2), 1, 32),
    perVmMax: clampInt(getSetting<number>('sandbox.aws.per_vm_max', 3), 1, 32),
    werkbankPublicUrl: getSetting<string>('sandbox.aws.werkbank_public_url', ''),
    repoPath: getSetting<string>('sandbox.aws.repo_path', '/opt/werkbank'),
    authVolume: getSetting<string>('sandbox.aws.auth_volume', 'werkbank-claude-auth'),
  };
}

function clampInt(raw: unknown, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function requireConfigured(cfg: AwsConfig): void {
  if (!cfg.sshHost) {
    throw Object.assign(
      new Error(
        'AWS sandbox backend not configured — set sandbox.aws.ssh_host in Settings → Sandbox',
      ),
      { status: 400 },
    );
  }
}

// ─── SSH command helpers ───────────────────────────────────────────────────

function sshArgs(cfg: AwsConfig, remoteCmd: string): string[] {
  // BatchMode=yes prevents interactive password prompts (key-based only).
  // accept-new auto-trusts the host on first connect — the user has scoped
  // SSH access to one host so the TOFU risk is acceptable for this use case.
  // ServerAliveInterval keeps long-lived `nerdctl logs -f` pipes from being
  // dropped by NAT/idle timers.
  const opts = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (cfg.sshKey) {
    opts.push('-i', cfg.sshKey);
  }
  return [...opts, cfg.sshHost, '--', remoteCmd];
}

function nerdctlPrefix(cfg: AwsConfig): string {
  // Always pin --address so we hit firecracker-containerd specifically;
  // the host might also run a stock containerd on a different socket.
  return `nerdctl --address ${shellQuote(cfg.containerdSocket)}`;
}

/**
 * POSIX single-quote escaping. We're constructing remote shell commands that
 * SSH passes verbatim to the remote login shell, so anything user-controlled
 * (env-file paths, container names, image tags, paths) MUST be quoted.
 */
function shellQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./:@,=+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function sshSync(cfg: AwsConfig, remoteCmd: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync('ssh', sshArgs(cfg, remoteCmd), {
    shell: false,
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

function sshSpawn(cfg: AwsConfig, remoteCmd: string): ChildProcess {
  return spawn('ssh', sshArgs(cfg, remoteCmd), {
    shell: false,
    windowsHide: true,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Push a local file to the EC2 host via scp. Returns sync result. */
function scpUpload(cfg: AwsConfig, localPath: string, remotePath: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const opts = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (cfg.sshKey) {
    opts.push('-i', cfg.sshKey);
  }
  const args = [...opts, localPath, `${cfg.sshHost}:${remotePath}`];
  const r = spawnSync('scp', args, {
    shell: false,
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

// ─── microVM pool ──────────────────────────────────────────────────────────

interface VmSlot {
  vmId: string;
  containerCount: number;
}

/**
 * Tracks per-vm container counts. Lives in-process because it's the
 * single werkbank instance that drives the EC2 host. If werkbank restarts
 * we lose the picker state but `awsSweepOrphans()` cleans up dead containers
 * on the next boot, and a fresh container with the same vm_id annotation
 * will simply join whichever microVM still exists (firecracker-containerd
 * reuses the microVM keyed by vm_id).
 */
const vmPool = new Map<string, VmSlot>();
// Per-todoId record so release knows which VM slot to decrement.
const todoVmAssignment = new Map<number, string>();

function pickVm(cfg: AwsConfig): string {
  // Prefer a VM that already exists with capacity (so we pack tightly).
  for (const slot of vmPool.values()) {
    if (slot.containerCount < cfg.perVmMax) {
      slot.containerCount += 1;
      return slot.vmId;
    }
  }
  // No existing VM has capacity — open a new one if the pool isn't full.
  if (vmPool.size < cfg.poolSize) {
    const vmId = `werkbank-pool-${vmPool.size}`;
    vmPool.set(vmId, { vmId, containerCount: 1 });
    return vmId;
  }
  // Pool exhausted. The outer dispatcher's queue should have caught this
  // already (it runs maxSlots() = perVmMax × poolSize at most). If we got
  // here, treat it as a configuration error rather than silently overpack.
  throw Object.assign(
    new Error(
      `AWS sandbox pool full (size=${cfg.poolSize}, per-vm=${cfg.perVmMax}). ` +
        `Increase sandbox.aws.pool_size or sandbox.aws.per_vm_max.`,
    ),
    { status: 503 },
  );
}

function releaseVm(vmId: string): void {
  const slot = vmPool.get(vmId);
  if (!slot) return;
  slot.containerCount = Math.max(0, slot.containerCount - 1);
  // Don't remove empty VMs from the pool — keeping the entry maps to "this
  // microVM stays warm". A cleanup sweep can be added later (Open Q #3 in
  // the plan) to torch idle VMs after some grace period.
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Best-effort orphan sweep on werkbank boot. Lists `nerdctl ps -a` filtered
 * by the werkbank prefix, then `rm -f`s anything found. Non-fatal on any
 * failure (host unreachable, ssh down, runtime mis-set) — a misconfigured
 * AWS backend should not block werkbank startup.
 */
export async function awsSweepOrphans(): Promise<void> {
  const cfg = loadAwsConfig();
  if (!cfg.sshHost) return;
  const list = sshSync(
    cfg,
    `${nerdctlPrefix(cfg)} ps -a --filter name=${shellQuote(CONTAINER_NAME_PREFIX)} --format '{{.Names}}'`,
  );
  if (list.status !== 0) return;
  const names = list.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    sshSync(cfg, `${nerdctlPrefix(cfg)} rm -f ${shellQuote(n)}`);
  }
}

/** Best-effort container kill, used by the runner's stop dispatcher. */
export function killAwsContainer(containerName: string): void {
  const cfg = loadAwsConfig();
  if (!cfg.sshHost) return;
  sshSync(cfg, `${nerdctlPrefix(cfg)} kill ${shellQuote(containerName)}`);
}

/**
 * Probe the configured werkbank URL from inside a throwaway curl container
 * launched on the AWS host. Mirrors the docker-backend test-connection but
 * uses nerdctl over SSH and doesn't require the firecracker runtime — a
 * stock runc container is fine for the reach test.
 */
export async function awsTestConnection(): Promise<{
  ok: boolean;
  werkbankReachable: boolean;
  detail: string;
}> {
  const cfg = loadAwsConfig();
  if (!cfg.sshHost) {
    return {
      ok: false,
      werkbankReachable: false,
      detail: 'sandbox.aws.ssh_host is not set',
    };
  }
  const url = cfg.werkbankPublicUrl;
  if (!url) {
    return {
      ok: false,
      werkbankReachable: false,
      detail: 'sandbox.aws.werkbank_public_url is not set',
    };
  }
  const target = url.endsWith('/') ? `${url}api/health` : `${url}/api/health`;
  const r = sshSync(
    cfg,
    `${nerdctlPrefix(cfg)} run --rm curlimages/curl:latest -sSf --max-time 5 ${shellQuote(target)}`,
  );
  const ok = r.status === 0;
  return {
    ok,
    werkbankReachable: ok,
    detail: ok ? r.stdout.trim() : r.stderr.trim() || `nerdctl exited ${r.status}`,
  };
}

/**
 * Image rebuild — async generator so callers can stream the build log into
 * SSE. Assumes the werkbank repo is checked out at `cfg.repoPath` on the
 * EC2 host (see docs/sandbox-aws-setup.md). The build runs on the host's
 * stock containerd image store; nerdctl's image store is shared with
 * firecracker-containerd via the same content store.
 */
export async function* awsRebuildImage(): AsyncGenerator<
  string,
  { ok: boolean; imageTag: string },
  void
> {
  const cfg = loadAwsConfig();
  if (!cfg.sshHost) {
    yield '[aws-microvm] sandbox.aws.ssh_host is not configured\n';
    return { ok: false, imageTag: cfg.imageTag };
  }

  const remoteCmd =
    `cd ${shellQuote(cfg.repoPath)} && ` +
    `${nerdctlPrefix(cfg)} build ` +
    `-t ${shellQuote(cfg.imageTag)} ` +
    `-f ${shellQuote('docker/sandbox/Dockerfile')} .`;

  const child = sshSpawn(cfg, remoteCmd);
  const emitter = new EventEmitter();
  const queueOut: string[] = [];
  let ended = false;
  let exitCode: number | null = null;

  child.stdout?.on('data', (b: Buffer) => {
    queueOut.push(b.toString('utf8'));
    emitter.emit('data');
  });
  child.stderr?.on('data', (b: Buffer) => {
    queueOut.push(`[build stderr] ${b.toString('utf8')}`);
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

  return { ok: exitCode === 0, imageTag: cfg.imageTag };
}

/**
 * Full lifecycle for an AWS-microvm sandbox run. Mirrors the docker
 * `launchNow` 15-step pipeline as closely as possible, with these
 * substitutions:
 *
 *   - `docker --context lp03 …`     →  `ssh user@host -- nerdctl --address … …`
 *   - `docker run …`                →  `nerdctl run --runtime aws.firecracker
 *                                       --annotation firecracker.vm_id=<picked> …`
 *   - `docker cp localfile …`       →  `scp localfile host:/tmp/x` then
 *                                       `nerdctl cp /tmp/x container:/dst`
 *   - `--env-file localpath`        →  scp env-file to /tmp/<runId>.env on
 *                                       remote, point nerdctl at that path
 *
 * Status mapping (exit code → sandbox_status) is shared with the docker
 * backend via `mapExitToStatus` so the UI sees identical chip values.
 */
export async function launchAwsNow(item: QueuedItem): Promise<void> {
  const cfg = loadAwsConfig();
  requireConfigured(cfg);

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

  // Step 1 — register slot eagerly so duplicate starts are rejected.
  const slot: RunSlot = {
    todoId,
    runId,
    containerName,
    startedAt: Date.now(),
    state: 'running',
    branch: effective.branch,
    baseBranch: effective.baseBranch,
    timeoutMin: effective.timeoutMin,
    backend: 'aws-microvm',
  };
  activeRuns.set(todoId, slot);

  // Step 2 — assign a vm_id from the pool.
  let vmId: string;
  try {
    vmId = pickVm(cfg);
  } catch (err) {
    claudeSessions.registerExternalSession(todoId, {
      cwd: '(sandbox-aws)',
      prompt: renderedPromptRaw,
    });
    claudeSessions.endExternalSession(todoId, {
      exitCode: 1,
      errorMessage: err instanceof Error ? err.message : 'AWS pool exhausted',
    });
    markFailedDb(todoId);
    release(todoId);
    return;
  }
  todoVmAssignment.set(todoId, vmId);

  // Step 3 — register external session so the SSE pipe is live.
  claudeSessions.registerExternalSession(todoId, {
    cwd: '(sandbox-aws)',
    prompt: renderedPromptRaw,
  });
  claudeSessions.pushExternalStdout(
    todoId,
    `[aws-microvm] running on ${cfg.sshHost} (vm_id=${vmId})\n`,
  );

  // Step 4 — resolve attachments (optional).
  const attachments =
    opts.attachmentIds && opts.attachmentIds.length > 0
      ? resolveAttachmentPaths(todoId, opts.attachmentIds)
      : [];
  const attachmentPlan = attachments.map((a) => ({
    ...a,
    containerPath: `/attachments/${a.id}-${a.filename}`,
    // Intermediate path on the EC2 host. `nerdctl cp` only accepts paths
    // that already exist on the daemon's filesystem, so we scp first then
    // cp from there.
    remoteStagingPath: `/tmp/werkbank-sbx-${runId}-${a.id}`,
  }));

  // Step 5 — rewrite host paths in the prompt.
  let renderedPrompt = renderedPromptRaw;
  for (const a of attachmentPlan) {
    renderedPrompt = renderedPrompt.split(a.absPath).join(a.containerPath);
  }

  // Step 6 — write env-file locally, then scp to EC2. Same content shape as
  // the docker backend so the entrypoint reads identical KEY=VALUE pairs.
  const envFilePath = writeEnvFile(runId, {
    GITHUB_TOKEN: githubToken,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    REPO_URL: repoUrl,
    BASE_BRANCH: effective.baseBranch,
    BRANCH_NAME: effective.branch,
    TODO_TEXT: renderedPrompt,
    TODO_ID: String(todoId),
    TASK_ID: `${todoId}-${runId}`,
    WERKBANK_API_URL: cfg.werkbankPublicUrl || effective.werkbankPublicUrl,
    WERKBANK_HOST: cfg.werkbankPublicUrl || effective.werkbankPublicUrl,
    MAX_TURNS: String(effective.maxTurns),
    TEST_CMD: effective.testCommand ?? '',
    CLAUDE_MODEL: effective.model,
    GIT_AUTHOR_NAME: effective.gitAuthorName,
    GIT_AUTHOR_EMAIL: effective.gitAuthorEmail,
  });
  slot.envFilePath = envFilePath;
  const remoteEnvFilePath = `/tmp/werkbank-sbx-${runId}.env`;
  const scpEnv = scpUpload(cfg, envFilePath, remoteEnvFilePath);
  if (scpEnv.status !== 0) {
    const detail = scpEnv.stderr.trim() || `scp exited ${scpEnv.status}`;
    claudeSessions.pushExternalStdout(todoId, `[scp env-file failed] ${detail}\n`);
    claudeSessions.endExternalSession(todoId, { exitCode: scpEnv.status, errorMessage: detail });
    markFailedDb(todoId);
    safeUnlink(envFilePath);
    releaseVm(vmId);
    todoVmAssignment.delete(todoId);
    release(todoId);
    return;
  }
  // Make sure the remote env-file is mode 0600 — scp on Windows can leave
  // umask-derived perms wider than we want for a token-bearing file.
  sshSync(cfg, `chmod 600 ${shellQuote(remoteEnvFilePath)}`);

  // Step 7 — `nerdctl run -d`. Same hardening as docker backend; the
  // firecracker shim layers VM-level isolation on top.
  //
  // `--annotation firecracker.vm_id=<id>` is the multi-tenant lever:
  // containers sharing this annotation land in the same microVM. Distinct
  // values spawn fresh microVMs.
  const runArgs = [
    'run',
    '--rm',
    '-d',
    '--name', shellQuote(containerName),
    '--runtime', shellQuote(cfg.runtime),
    '--annotation', shellQuote(`firecracker.vm_id=${vmId}`),
    '--env-file', shellQuote(remoteEnvFilePath),
    '--cap-drop=ALL',
    '--cap-add=SETUID',
    '--cap-add=SETGID',
    '--cap-add=AUDIT_WRITE',
    '--cap-add=CHOWN',
    '--cap-add=DAC_OVERRIDE',
    '--cap-add=FOWNER',
    '--read-only',
    '--tmpfs', '/tmp:size=256m,noexec,nosuid',
    '--tmpfs', '/workspace:size=4g,exec,nosuid,uid=1000,gid=1000',
    '--tmpfs', '/home/node:size=64m,exec,nosuid,uid=1000,gid=1000',
    '-v', shellQuote(`${cfg.authVolume}:/home/node/.claude`),
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--pids-limit=512',
    '-u', '1000:1000',
    '--entrypoint', '/usr/local/bin/agent-entrypoint.sh',
    shellQuote(cfg.imageTag),
  ];
  const runResult = sshSync(cfg, `${nerdctlPrefix(cfg)} ${runArgs.join(' ')}`);
  if (runResult.status !== 0) {
    const detail = runResult.stderr.trim() || `nerdctl run exited ${runResult.status}`;
    claudeSessions.pushExternalStdout(todoId, `[nerdctl run failed] ${detail}\n`);
    claudeSessions.endExternalSession(todoId, { exitCode: runResult.status, errorMessage: detail });
    markFailedDb(todoId);
    safeUnlink(envFilePath);
    sshSync(cfg, `rm -f ${shellQuote(remoteEnvFilePath)}`);
    releaseVm(vmId);
    todoVmAssignment.delete(todoId);
    release(todoId);
    return;
  }

  // Step 8 — copy attachments. Two-step: scp local → ec2 staging, then
  // `nerdctl cp` staging → container. Non-fatal on per-file failure.
  for (const a of attachmentPlan) {
    const up = scpUpload(cfg, a.absPath, a.remoteStagingPath);
    if (up.status !== 0) {
      claudeSessions.pushExternalStdout(
        todoId,
        `[attachment scp failed for ${a.filename}] ${up.stderr.trim()}\n`,
      );
      continue;
    }
    const cp = sshSync(
      cfg,
      `${nerdctlPrefix(cfg)} cp ${shellQuote(a.remoteStagingPath)} ${shellQuote(`${containerName}:${a.containerPath}`)}`,
    );
    if (cp.status !== 0) {
      claudeSessions.pushExternalStdout(
        todoId,
        `[attachment nerdctl cp failed for ${a.filename}] ${cp.stderr.trim()}\n`,
      );
    }
    // Always try to clean up the staging file — even on cp failure.
    sshSync(cfg, `rm -f ${shellQuote(a.remoteStagingPath)}`);
  }
  sshSync(
    cfg,
    `${nerdctlPrefix(cfg)} exec ${shellQuote(containerName)} touch /attachments/.ready`,
  );

  // Step 9 — long-lived `nerdctl logs -f` over SSH. Same chunk-pushing /
  // status-line caching pattern as docker backend.
  const logsChild = sshSpawn(
    cfg,
    `${nerdctlPrefix(cfg)} logs -f ${shellQuote(containerName)}`,
  );
  slot.logsChild = logsChild;

  logsChild.stdout?.on('data', (b: Buffer) => {
    const text = b.toString('utf8');
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
      claudeSessions.pushExternalStdout(todoId, `[ssh stderr] ${text}`);
    }
  });

  // Step 10 — watchdog.
  slot.watchdog = setTimeout(
    () => killAwsRun(todoId, 'timeout'),
    Math.max(60_000, effective.timeoutMin * 60_000),
  );

  logsChild.on('close', async () => {
    if (slot.watchdog) {
      clearTimeout(slot.watchdog);
      slot.watchdog = undefined;
    }

    // Step 11 — poll container exit code via nerdctl inspect.
    const exitCode = await pollAwsContainerExit(cfg, containerName);

    // Step 12 — recover status payload (cp from container or cached log line).
    const statusPayload = recoverAwsStatusPayload(cfg, containerName, slot);

    // Step 13 — map exit → sandbox_status. Shared with docker backend.
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
      console.error('[sandbox-aws] status write failed:', err);
    }

    // Step 14 — end SSE session.
    claudeSessions.endExternalSession(todoId, {
      exitCode,
      errorMessage: mapped.status === 'pushed' ? null : mapped.detail ?? null,
    });

    // Step 15 — cleanup. `--rm` should have removed the container; rm -f
    // is a belt-and-braces fallback. Also drop the env-file on the host.
    sshSync(cfg, `${nerdctlPrefix(cfg)} rm -f ${shellQuote(containerName)}`);
    sshSync(cfg, `rm -f ${shellQuote(remoteEnvFilePath)}`);
    safeUnlink(envFilePath);
    releaseVm(vmId);
    todoVmAssignment.delete(todoId);
    release(todoId);
  });
}

// ─── Status recovery / kill helpers ────────────────────────────────────────

async function pollAwsContainerExit(cfg: AwsConfig, containerName: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const r = sshSync(
      cfg,
      `${nerdctlPrefix(cfg)} inspect -f '{{.State.Status}}|{{.State.ExitCode}}' ${shellQuote(containerName)}`,
    );
    if (r.status !== 0) {
      // Container is gone — see docker-backend pollContainerExit comments
      // for why we return -1 rather than 0 here.
      return -1;
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

function recoverAwsStatusPayload(
  cfg: AwsConfig,
  containerName: string,
  slot: RunSlot,
): StatusPayload | null {
  // Try `nerdctl cp container:/path /tmp/host-path`, then sftp it back.
  // Easier: ssh `cat /workspace/<id>-<runid>.status.json` after a cp from
  // container to a host tmp path. nerdctl cp writes to the daemon's local
  // filesystem so we can then read it back over SSH.
  const remoteTmp = `/tmp/werkbank-sbx-${slot.runId}.status.json`;
  const cp = sshSync(
    cfg,
    `${nerdctlPrefix(cfg)} cp ${shellQuote(`${containerName}:/workspace/${slot.todoId}-${slot.runId}.status.json`)} ${shellQuote(remoteTmp)}`,
  );
  if (cp.status === 0) {
    const cat = sshSync(cfg, `cat ${shellQuote(remoteTmp)} && rm -f ${shellQuote(remoteTmp)}`);
    if (cat.status === 0) {
      try {
        return JSON.parse(cat.stdout) as StatusPayload;
      } catch {
        /* fall through to cached line */
      }
    }
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

function killAwsRun(todoId: number, reason: string): void {
  const cfg = loadAwsConfig();
  const slot = activeRuns.get(todoId);
  if (!slot) return;
  if (cfg.sshHost) {
    sshSync(cfg, `${nerdctlPrefix(cfg)} kill ${shellQuote(slot.containerName)}`);
  }
  claudeSessions.pushExternalStdout(todoId, `\n[sandbox killed: ${reason}]\n`);
  if (slot.logsChild) treeKill(slot.logsChild.pid);
}

// ─── Internal — used by tests / future callers ─────────────────────────────

/** Inspect the in-process pool state. Useful for diagnostics. */
export function inspectAwsPool(): Array<{ vmId: string; containerCount: number }> {
  return Array.from(vmPool.values()).map((v) => ({ ...v }));
}

