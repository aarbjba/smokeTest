#!/usr/bin/env node
// Frees TCP ports by killing whatever is listening on them.
// Usage: node scripts/free-ports.mjs 3001 5173
// Cross-platform: uses netstat + taskkill on Windows, lsof on Unix.

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const ports = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
if (ports.length === 0) {
  console.log('[free-ports] no ports given, skipping');
  process.exit(0);
}

const isWindows = platform() === 'win32';

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
}

function pidsForPortWindows(port) {
  const out = run(`netstat -ano -p tcp`);
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    // Example line: "  TCP    0.0.0.0:3001   0.0.0.0:0   LISTENING   12345"
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (m && Number(m[1]) === port) pids.add(m[2]);
  }
  return [...pids];
}

function pidsForPortUnix(port) {
  const out = run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  return out.split(/\s+/).filter(Boolean);
}

function killPid(pid) {
  if (isWindows) run(`taskkill /PID ${pid} /F`);
  else run(`kill -9 ${pid}`);
}

let killed = 0;
for (const port of ports) {
  const pids = isWindows ? pidsForPortWindows(port) : pidsForPortUnix(port);
  for (const pid of pids) {
    killPid(pid);
    console.log(`[free-ports] killed pid ${pid} on port ${port}`);
    killed++;
  }
}
if (killed === 0) console.log(`[free-ports] ports ${ports.join(', ')} already free`);
