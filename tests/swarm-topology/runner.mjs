#!/usr/bin/env node
/**
 * Swarm-Topology Test Runner — sequential.
 *
 * For each test folder NN-name/:
 *   1. POST config.json to /api/swarm/run-async    → runId
 *   2. Poll GET /api/swarm/runs/:id every 5s until status != "running"
 *   3. Capture meta, blackboard, events, run.db into results/
 *   4. Verify against expected.json
 *
 * Folders matching 16-* contain VALIDATION-only tests (no spawn).
 * Their config.json is POSTed to /api/swarm/validate; expected.errorIncludes
 * is a list of substrings that must appear in the validate response.
 *
 * Usage:
 *   node runner.mjs                              # all tests in order
 *   node runner.mjs 14-sequential-multi-loop     # single test
 *   node runner.mjs 14                           # by NN-prefix
 *   node runner.mjs --dry-run                    # validate-only (no spawns)
 *   node runner.mjs --skip-existing              # skip if results/ exists
 *
 * Requires Node 18+ (built-in fetch). No npm deps.
 */
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE      = process.env.WERKBANK_API ?? 'http://127.0.0.1:3001/api';
const POLL_INTERVAL = 5_000;
const POLL_TIMEOUT  = 15 * 60_000; // 15 min hard cap per run

// ─── Argument parsing ──────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const dryRun      = args.includes('--dry-run');
const skipExist   = args.includes('--skip-existing');
const filterArg   = args.find(a => !a.startsWith('--'));

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const c = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

function log(line)  { process.stdout.write(line + '\n'); }
function info(line) { log(c.cyan + line + c.reset); }
function pass(line) { log(c.green + '✓ ' + c.reset + line); }
function fail(line) { log(c.red   + '✗ ' + c.reset + line); }
function warn(line) { log(c.yellow + '! ' + c.reset + line); }

async function preflight() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`/health returned ${res.status}`);
  } catch (err) {
    fail(`Werkbank API not reachable at ${API_BASE} — start \`npm run dev\` first.`);
    fail(`Detail: ${err.message}`);
    process.exit(2);
  }
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function getJson(path) {
  const res  = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function downloadBinary(path, dest) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  const out = createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body), out);
}

/**
 * Poll /runs/:id until status != "running" or timeout. Returns the final
 * metadata row.
 */
async function pollUntilDone(runId, deadline) {
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const body = await getJson(`/swarm/runs/${runId}`);
    // API returns { run: { id, status, total_tokens, ... }, agents, tokenSummary, ... }
    const meta = body.run ?? body;
    if (meta.status && meta.status !== 'running') return meta;
  }
  throw new Error(`run ${runId} did not finish within ${POLL_TIMEOUT/1000}s`);
}

/**
 * Stream the SSE replay (speed=0 = instant) and collect events as JSONL.
 * The replay endpoint always uses SSE; we parse it line-by-line.
 */
async function captureEvents(runId, dest) {
  const res = await fetch(`${API_BASE}/swarm/runs/${runId}/replay?speed=0`);
  if (!res.ok) throw new Error(`GET /replay → ${res.status}`);
  const reader = res.body.getReader();
  const out    = createWriteStream(dest);
  const td     = new TextDecoder();
  let buf      = '';
  let currentEventType = '';
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        if (line.startsWith('event:')) {
          currentEventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (currentEventType && data) {
            out.write(JSON.stringify({ type: currentEventType, data: JSON.parse(data) }) + '\n');
            count++;
          }
          currentEventType = '';
        }
      }
    }
  } finally {
    out.end();
  }
  return count;
}

// ─── Verification ───────────────────────────────────────────────────────────

function verify(meta, blackboard, events, expected) {
  const failures = [];

  // 1. Status
  if (expected.status && meta.status !== expected.status) {
    failures.push(`status mismatch: expected "${expected.status}", got "${meta.status}"`);
  }

  // 2. Blackboard keys
  const presentKeys = new Set((blackboard.entries ?? []).map(e => e.key));
  for (const key of (expected.blackboardKeys ?? [])) {
    if (!presentKeys.has(key)) failures.push(`missing blackboard key: ${key}`);
  }

  // 3. Phase events
  const observedPhases = new Set();
  for (const ev of events) {
    if (ev.type === 'topology:phase_change') {
      const phase = ev.data?.phase;
      if (phase) observedPhases.add(phase);
    }
  }
  for (const phase of (expected.phases ?? [])) {
    if (!observedPhases.has(phase)) failures.push(`missing phase: ${phase}`);
  }

  // 4. Phase event count (e.g. multi-loop expects N occurrences of "loop_start")
  for (const [phase, minCount] of Object.entries(expected.phaseCounts ?? {})) {
    const c = events.filter(e => e.type === 'topology:phase_change' && e.data?.phase === phase).length;
    if (c < minCount) failures.push(`phase "${phase}" occurred ${c} times, expected >= ${minCount}`);
  }

  return failures;
}

// ─── Per-test execution ─────────────────────────────────────────────────────

async function runFullTest(testDir, expected, config) {
  const resultsDir = join(testDir, 'results');
  await mkdir(resultsDir, { recursive: true });

  // 1. Start the run.
  const startRes = await postJson('/swarm/run-async', { config });
  if (!startRes.ok) {
    return { failures: [`run-async returned ${startRes.status}: ${JSON.stringify(startRes.body)}`] };
  }
  const runId = startRes.body.runId;
  if (!runId) return { failures: ['run-async did not return runId'] };

  // 2. Poll until done.
  const startedAt = Date.now();
  const deadline  = startedAt + POLL_TIMEOUT;
  const meta      = await pollUntilDone(runId, deadline);

  // 3. Capture artefacts.
  await writeFile(join(resultsDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const blackboard = await getJson(`/swarm/runs/${runId}/blackboard`);
  await writeFile(join(resultsDir, 'blackboard.json'), JSON.stringify(blackboard, null, 2));

  const eventCount = await captureEvents(runId, join(resultsDir, 'events.jsonl'));

  try {
    await downloadBinary(`/swarm/runs/${runId}/db`, join(resultsDir, 'run.db'));
  } catch (err) {
    warn(`could not download run.db: ${err.message}`);
  }

  // 4. Verify.
  const eventsRaw = await readFile(join(resultsDir, 'events.jsonl'), 'utf8');
  const events    = eventsRaw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const failures  = verify(meta, blackboard, events, expected);

  return {
    failures,
    runId,
    durationMs: Date.now() - startedAt,
    tokens:     meta.total_tokens ?? 0,
    eventCount,
    status:     meta.status,
  };
}

async function runValidationTest(testDir, expected, config) {
  const resultsDir = join(testDir, 'results');
  await mkdir(resultsDir, { recursive: true });

  const res = await postJson('/swarm/validate', { config });
  await writeFile(join(resultsDir, 'validate-response.json'), JSON.stringify({
    httpStatus: res.status,
    body:       res.body,
  }, null, 2));

  const failures = [];

  if (expected.shouldFail) {
    if (res.body?.ok !== false) {
      failures.push(`expected validation to fail, but got ok=${res.body?.ok}`);
    }
    const errorTexts = JSON.stringify(res.body?.errors ?? []);
    for (const needle of (expected.errorIncludes ?? [])) {
      if (!errorTexts.includes(needle)) {
        failures.push(`error message missing substring: "${needle}"`);
      }
    }
  } else {
    if (res.body?.ok !== true) {
      failures.push(`expected validation to pass, but got ok=${res.body?.ok}: ${JSON.stringify(res.body?.errors)}`);
    }
  }

  return { failures, mode: 'validate-only', status: res.body?.ok === true ? 'valid' : 'invalid' };
}

async function runOneTest(testDir) {
  const name = basename(testDir);
  const config   = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf8'));
  const expected = JSON.parse(await readFile(join(testDir, 'expected.json'), 'utf8'));

  process.stdout.write(`\n${c.bold}${name}${c.reset} — ${expected.description ?? ''}\n`);

  // Validation-only test (mode set OR --dry-run flag forces it)
  const validateOnly = expected.mode === 'validate-only' || dryRun;
  const result = validateOnly
    ? await runValidationTest(testDir, expected, config)
    : await runFullTest(testDir, expected, config);

  const tokenStr = result.tokens   != null ? `~${(result.tokens/1000).toFixed(0)}k tokens` : '';
  const timeStr  = result.durationMs != null ? `${(result.durationMs/1000).toFixed(0)}s` : '';
  const statusStr = result.status ?? '';

  if (result.failures.length === 0) {
    pass(`${name}  ${statusStr}  ${tokenStr}  ${timeStr}`);
  } else {
    fail(`${name}  ${statusStr}  ${tokenStr}  ${timeStr}`);
    for (const f of result.failures) log(`    ${c.red}└─${c.reset} ${f}`);
  }

  return { name, result };
}

// ─── Test discovery + main loop ─────────────────────────────────────────────

async function discoverTests() {
  const root = __dirname;
  const entries = await readdir(root, { withFileTypes: true });
  const testDirs = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^\d{2}-/.test(e.name)) continue;

    const sub = join(root, e.name);
    // Folder may contain sub-tests (e.g. 16-validation-edge-cases/16a-...)
    const inner = await readdir(sub, { withFileTypes: true });
    const hasConfig = inner.some(i => i.name === 'config.json');
    if (hasConfig) {
      testDirs.push(sub);
    } else {
      // Drill one level (NN-name/NNa-sub/)
      for (const i of inner) {
        if (!i.isDirectory()) continue;
        const subSub = join(sub, i.name);
        if (existsSync(join(subSub, 'config.json'))) testDirs.push(subSub);
      }
    }
  }

  testDirs.sort();
  return testDirs;
}

async function main() {
  await preflight();
  const all = await discoverTests();

  let selected = all;
  if (filterArg) {
    selected = all.filter(d => basename(d) === filterArg || basename(d).startsWith(filterArg + '-') || basename(d).startsWith(filterArg));
    if (selected.length === 0) {
      // Fallback: if filterArg is just a parent (e.g. "16"), include all sub-tests under it
      selected = all.filter(d => d.includes(`${filterArg}-`));
    }
    if (selected.length === 0) {
      fail(`No test matches "${filterArg}". Available:`);
      for (const d of all) log('    ' + basename(d));
      process.exit(1);
    }
  }

  if (skipExist) {
    selected = selected.filter(d => {
      const r = join(d, 'results');
      return !existsSync(r) || (existsSync(r) && !existsSync(join(r, 'meta.json')) && !existsSync(join(r, 'validate-response.json')));
    });
  }

  info(`\n=== Swarm Topology Test Suite ===`);
  info(`API:           ${API_BASE}`);
  info(`Tests:         ${selected.length}`);
  info(`Mode:          ${dryRun ? 'dry-run (validate only)' : 'live runs'}`);
  log('');

  const summary = [];
  for (const d of selected) {
    try {
      const r = await runOneTest(d);
      summary.push(r);
    } catch (err) {
      fail(`${basename(d)}  EXCEPTION: ${err.message}`);
      summary.push({ name: basename(d), result: { failures: [err.message] } });
    }
  }

  // Summary
  log('');
  info(`=== Summary ===`);
  const passed = summary.filter(s => s.result.failures.length === 0).length;
  const failed = summary.length - passed;
  log(`${c.green}${passed} passed${c.reset}  /  ${failed > 0 ? c.red : c.dim}${failed} failed${c.reset}  /  ${summary.length} total`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  fail(`runner crashed: ${err.stack ?? err.message}`);
  process.exit(2);
});
