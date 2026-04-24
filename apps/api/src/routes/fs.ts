import { Router } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join, parse, sep, relative } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const fsRouter = Router();

/**
 * Lightweight server-side folder browser used by the Repo-Pfade UI.
 *
 * - `GET /api/fs/drives` — on Windows, enumerate drive letters (C:\, D:\, ...).
 *   On POSIX systems, returns a single entry for `/`.
 * - `GET /api/fs/browse?path=<abs>` — list **subdirectories** (no files) at
 *   the given absolute path. Response includes the resolved path, the parent
 *   path (or null at a drive/filesystem root), and the sorted entries.
 *
 * Both endpoints are read-only and only return directory names. This is
 * intentionally a minimal API — just enough to build a "pick a folder" modal
 * without pulling in a heavy filesystem library. Hidden files (leading `.`)
 * and common system folders are filtered to keep the list navigable.
 */

const HIDDEN_WINDOWS_NAMES = new Set([
  'System Volume Information',
  '$RECYCLE.BIN',
  '$Recycle.Bin',
  'Recovery',
  'Config.Msi',
]);

function isHidden(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (HIDDEN_WINDOWS_NAMES.has(name)) return true;
  return false;
}

fsRouter.get('/drives', (_req, res) => {
  if (process.platform !== 'win32') {
    return res.json({ drives: [{ name: '/', path: '/' }] });
  }
  // Use `wmic` to enumerate logical drives. Fall back to trying letters A-Z
  // with statSync if wmic is not available (newer Windows variants).
  try {
    const raw = execFileSync('wmic', ['logicaldisk', 'get', 'name'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const drives = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[A-Z]:$/.test(l))
      .map((l) => ({ name: l + '\\', path: l + '\\' }));
    if (drives.length > 0) return res.json({ drives });
  } catch {
    /* fall through */
  }
  // Fallback: probe A:..Z:
  const drives: { name: string; path: string }[] = [];
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    const path = letter + ':\\';
    try {
      const s = require('node:fs').statSync(path);
      if (s && s.isDirectory()) drives.push({ name: path, path });
    } catch {
      /* skip */
    }
  }
  if (drives.length === 0) drives.push({ name: 'C:\\', path: 'C:\\' });
  res.json({ drives });
});

/**
 * Open a native OS folder-chooser dialog on the backend host (which is the
 * user's own machine in the local-only deployment this app targets). On
 * Windows we use PowerShell + `System.Windows.Forms.FolderBrowserDialog`.
 *
 * The call is *async* (not `execFileSync`) because the user may take many
 * seconds to pick a folder — blocking the Node event loop would freeze every
 * other request. A hidden TopMost owner form is created so the dialog pops
 * in front of the browser.
 *
 * Returns `{ path: string }` on OK, `{ path: null }` on cancel, and 501 on
 * non-Windows (where the frontend can fall back to the server-side browser
 * endpoints above).
 */
fsRouter.post('/pick-folder', async (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({
      error: 'Native folder picker is only supported on Windows',
    });
  }
  const initial = typeof req.body?.initial === 'string' ? req.body.initial.trim() : '';
  // Single-quote the path for PowerShell and double up any embedded single
  // quotes so paths with apostrophes don't break the script.
  const initialEscaped = initial ? initial.replace(/'/g, "''") : '';

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Arbeitsverzeichnis wählen'
$dlg.ShowNewFolderButton = $true
${initialEscaped ? `if (Test-Path -LiteralPath '${initialEscaped}') { $dlg.SelectedPath = '${initialEscaped}' }` : ''}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1,1)
$owner.Show() | Out-Null
$owner.Activate()
try {
  $result = $dlg.ShowDialog($owner)
} finally {
  $owner.Close()
}
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
`;

  try {
    const { stdout } = await execFileP(
      'powershell',
      ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 },
    );
    const path = stdout.trim();
    res.json({ path: path || null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * Recursive file + folder listing for fuzzy picker UIs.
 *
 * GET /api/fs/list?root=<abs>&limit=<n>
 *
 * Returns paths relative to `root` so the frontend can render
 * `@Folder\sub\file.txt`-style references. Skips the usual noisy heavy
 * directories (node_modules, .git, dist, build, ...) up-front so a large
 * monorepo doesn't blow the limit on framework files.
 *
 * This is intentionally a flat one-shot dump: the frontend does the fuzzy
 * filtering client-side. Capping at `limit` (default 5000) keeps the payload
 * manageable even for medium repos.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', '.turbo', '.vite', '.svelte-kit',
  'coverage', '.nyc_output', '.pytest_cache', '__pycache__',
  '.venv', 'venv', '.idea', '.vscode', '.gradle',
  'bin', 'obj',
]);

fsRouter.get('/list', async (req, res) => {
  const raw = typeof req.query.root === 'string' ? req.query.root : '';
  if (!raw.trim()) {
    return res.status(400).json({ error: 'root query parameter is required' });
  }
  const limit = Math.min(20_000, Math.max(100, Number(req.query.limit ?? 5000) || 5000));
  const root = resolve(raw);
  try {
    const s = await stat(root);
    if (!s.isDirectory()) {
      return res.status(400).json({ error: 'root is not a directory' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: message });
  }

  const entries: { path: string; type: 'file' | 'dir' }[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (entries.length >= limit) {
      truncated = true;
      return;
    }
    if (depth > 12) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (entries.length >= limit) { truncated = true; return; }
      if (isHidden(d.name)) continue;
      if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
      const full = join(dir, d.name);
      const rel = relative(root, full);
      if (d.isDirectory()) {
        entries.push({ path: rel, type: 'dir' });
        await walk(full, depth + 1);
      } else if (d.isFile()) {
        entries.push({ path: rel, type: 'file' });
      }
      // symlinks and other types are skipped
    }
  }

  await walk(root, 0);
  res.json({ root, entries, truncated, count: entries.length, limit });
});

fsRouter.get('/browse', async (req, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  if (!raw.trim()) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }
  const abs = resolve(raw);
  try {
    const s = await stat(abs);
    if (!s.isDirectory()) {
      return res.status(400).json({ error: 'path is not a directory' });
    }
    const entries = await readdir(abs, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !isHidden(e.name))
      .map((e) => ({ name: e.name, path: join(abs, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Parent: on Windows, parse(abs).root for a path like "C:\foo" returns "C:\".
    // If abs already equals the drive root, parent should be null (→ drives screen).
    const parsed = parse(abs);
    const atRoot = abs === parsed.root || abs === parsed.root.replace(/\\$/, '') || abs + sep === parsed.root;
    const parent = atRoot ? null : resolve(abs, '..');

    res.json({ path: abs, parent, entries: dirs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT / EACCES / EPERM — surface as 400 with a readable message so the
    // frontend can show it in the picker without crashing.
    res.status(400).json({ error: message });
  }
});
