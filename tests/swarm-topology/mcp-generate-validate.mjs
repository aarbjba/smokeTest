#!/usr/bin/env node
/**
 * MCP generate_config dry-run validator.
 *
 * Tests the generate_config MCP tool logic by:
 *   1. Validating all 13 topology sample configs from /api/swarm/topology
 *   2. Generating a custom-goal config for every topology and validating it
 *   3. Validating every existing test suite config.json (runner.mjs --dry-run)
 *
 * All tests hit POST /api/swarm/validate — no agent spawns, no tokens burned.
 *
 * Usage:
 *   node mcp-generate-validate.mjs              # all three suites
 *   node mcp-generate-validate.mjs --samples    # suite 1 only
 *   node mcp-generate-validate.mjs --generate   # suite 2 only
 *   node mcp-generate-validate.mjs --testconfigs # suite 3 only
 *
 * Requires Node 18+. No npm deps. Werkbank API must be running.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync }        from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath }     from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE  = process.env.WERKBANK_API ?? 'http://127.0.0.1:3001/api';

// ─── Colour helpers ──────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const log  = (l) => process.stdout.write(l + '\n');
const info = (l) => log(c.cyan + l + c.reset);
const pass = (l) => log(c.green + '✓ ' + c.reset + l);
const fail = (l) => log(c.red   + '✗ ' + c.reset + l);

// ─── API helpers ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, body: text }; }
}

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

// ─── generate_config logic (mirrors the MCP tool exactly) ───────────────────
//
// This function reproduces what the MCP generate_config tool does internally.
// Testing it here validates that the tool will produce valid configs for every
// topology without spending real tokens.

const PRESET_FLAG_MAP = {
  'debate-with-judge': 'debatePresetAgents',
  'mixture-of-agents': 'moaPresetAggregator',
  'majority-voting':   'majorityPresetConsensus',
  'hierarchical':      'hierarchicalPresetAgents',
  'planner-worker':    'plannerWorkerPresetAgents',
  'round-robin':       'roundRobinPresetAgents',
  'council-as-judge':  'councilPresetAgents',
  groupchat:           'groupchatPresetAgents',
  'heavy-swarm':       'heavyPresetAgents',
  'agent-rearrange':   'agentRearrangePresetAgents',
  'graph-workflow':    'graphWorkflowPresetAgents',
};

function buildConfig(sampleConfig, goal, modelTier = 'haiku', usePresetAgents = true) {
  const config = JSON.parse(JSON.stringify(sampleConfig));
  config.goal = goal;
  for (const coord of config.coordinators) {
    coord.model = modelTier;
  }
  const presetFlag = PRESET_FLAG_MAP[config.topology];
  if (presetFlag) {
    config.topologyOptions ??= {};
    config.topologyOptions[presetFlag] = usePresetAgents;
  }
  return config;
}

// ─── Suite 1: sample configs from topology metadata ─────────────────────────

async function runSampleSuite(topologies) {
  info('\n── Suite 1: Topology sample configs ──');
  const results = [];

  for (const meta of topologies) {
    const name = meta.topology;
    const res  = await postJson('/swarm/validate', { config: meta.sampleConfig });
    const ok   = res.body?.ok === true;
    if (ok) {
      pass(`${name}  (${meta.sampleConfig.coordinators.length} coordinators)`);
    } else {
      fail(`${name}  errors: ${JSON.stringify(res.body?.errors ?? res.body)}`);
    }
    results.push({ name, ok });
  }
  return results;
}

// ─── Suite 2: generate_config for each topology with a test goal ─────────────

const TEST_GOAL = 'Analyse the trade-offs of a monolithic vs micro-services architecture for a 5-person startup building a SaaS product.';

async function runGenerateSuite(topologies) {
  info('\n── Suite 2: generate_config (custom goal, haiku, preset=true) ──');
  const results = [];

  for (const meta of topologies) {
    const name   = meta.topology;
    const config = buildConfig(meta.sampleConfig, TEST_GOAL, 'haiku', true);
    const res    = await postJson('/swarm/validate', { config });
    const ok     = res.body?.ok === true;
    if (ok) {
      pass(`${name}  coordinator_count=${config.coordinators.length}`);
    } else {
      fail(`${name}  errors: ${JSON.stringify(res.body?.errors ?? res.body)}`);
    }
    results.push({ name, ok });
  }
  return results;
}

// ─── Suite 3: existing test suite config.json files ─────────────────────────
//
// Mirrors the --dry-run behaviour of runner.mjs: every test in the suite is
// posted to /api/swarm/validate. Tests with expected.mode == "validate-only"
// carry their own shouldFail / errorIncludes contract; all others are expected
// to pass validation.

async function discoverTests() {
  const entries = await readdir(__dirname, { withFileTypes: true });
  const dirs    = [];

  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{2}-/.test(e.name)) continue;
    const sub   = join(__dirname, e.name);
    const inner = await readdir(sub, { withFileTypes: true });
    if (inner.some(i => i.name === 'config.json')) {
      dirs.push(sub);
    } else {
      // one-level drill for grouped folders (e.g. 16-validation-edge-cases/)
      for (const i of inner) {
        if (!i.isDirectory()) continue;
        const ss = join(sub, i.name);
        if (existsSync(join(ss, 'config.json'))) dirs.push(ss);
      }
    }
  }
  dirs.sort();
  return dirs;
}

async function runTestConfigSuite() {
  info('\n── Suite 3: Existing test suite config.json (dry-run validate) ──');
  const testDirs = await discoverTests();
  const results  = [];

  for (const dir of testDirs) {
    const name = basename(dir);
    const config   = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));

    const res = await postJson('/swarm/validate', { config });
    const validateMode = expected.mode === 'validate-only';

    let ok;
    let detail = '';

    if (validateMode && expected.shouldFail) {
      // Test expects validation to fail with specific errors
      if (res.body?.ok !== false) {
        ok     = false;
        detail = `expected validation to fail, got ok=${res.body?.ok}`;
      } else {
        const errorText = JSON.stringify(res.body?.errors ?? []);
        const missing   = (expected.errorIncludes ?? []).filter(s => !errorText.includes(s));
        ok     = missing.length === 0;
        detail = ok ? '' : `missing error substrings: ${JSON.stringify(missing)}`;
      }
    } else if (validateMode && expected.shouldFail === false) {
      ok     = res.body?.ok === true;
      detail = ok ? '' : `expected pass, got: ${JSON.stringify(res.body?.errors ?? res.body)}`;
    } else {
      // Normal test — config should always be valid
      ok     = res.body?.ok === true;
      detail = ok ? '' : `unexpected validation failure: ${JSON.stringify(res.body?.errors ?? res.body)}`;
    }

    if (ok) {
      pass(`${name}`);
    } else {
      fail(`${name}  ${detail}`);
    }
    results.push({ name, ok });
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await preflight();

  const args        = process.argv.slice(2);
  const runSamples  = args.length === 0 || args.includes('--samples');
  const runGenerate = args.length === 0 || args.includes('--generate');
  const runTests    = args.length === 0 || args.includes('--testconfigs');

  info(`\n=== MCP generate_config dry-run validator ===`);
  info(`API: ${API_BASE}`);

  // Fetch topology metadata once (used by suites 1 + 2)
  const { topologies } = await getJson('/swarm/topology');
  info(`Topologies: ${topologies.length}`);

  const allResults = [];

  if (runSamples)  allResults.push(...await runSampleSuite(topologies));
  if (runGenerate) allResults.push(...await runGenerateSuite(topologies));
  if (runTests)    allResults.push(...await runTestConfigSuite());

  const passed = allResults.filter(r => r.ok).length;
  const failed = allResults.length - passed;

  log('');
  info(`=== Summary ===`);
  log(`${c.green}${passed} passed${c.reset}  /  ${failed > 0 ? c.red : c.dim}${failed} failed${c.reset}  /  ${allResults.length} total`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  fail(`runner crashed: ${err.stack ?? err.message}`);
  process.exit(2);
});
