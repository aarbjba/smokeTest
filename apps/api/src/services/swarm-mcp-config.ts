import { writeFileSync, mkdtempSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname_es = dirname(fileURLToPath(import.meta.url));
// services/ → src/ → api/ → apps/ → repo root
const REPO_ROOT = resolve(__dirname_es, '../../../..');

export function buildSwarmMcpConfigFile(
  runId:       string,
  agentId:     string,
  allAgentIds: string[],
  runDbPath:   string,
): string {
  const compiledJs = resolve(REPO_ROOT, 'apps/mcp/dist/swarm-server.js');
  const isCompiled = existsSync(compiledJs);

  const serverEntry = isCompiled
    ? { command: 'node', args: [compiledJs] }
    : {
        command: 'node',
        args: ['--import', 'tsx/esm', resolve(REPO_ROOT, 'apps/mcp/src/swarm-server.ts')],
      };

  const config = {
    mcpServers: {
      swarm: {
        type: 'stdio',
        ...serverEntry,
        env: {
          RUN_DB_PATH: runDbPath,
          RUN_ID:      runId,
          AGENT_IDS:   allAgentIds.join(','),
        },
      },
    },
  };

  const dir  = mkdtempSync(join(tmpdir(), 'swarm-mcp-'));
  const path = join(dir, `${runId}-${agentId}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  return path;
}

export function cleanupMcpConfigFile(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}
