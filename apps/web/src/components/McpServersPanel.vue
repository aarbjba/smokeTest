<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import type { McpServerConfig } from '../types';

const props = defineProps<{ todoId: number }>();

// Each row also carries raw string views for args/env so the user can edit
// them without JSON gymnastics. Serialized back on save.
interface EditableRow extends McpServerConfig {
  argsText: string;
  envText: string;
}

const rows = ref<EditableRow[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const dirty = ref(false);

function toEditable(s: McpServerConfig): EditableRow {
  return {
    name: s.name,
    command: s.command,
    args: s.args ?? [],
    env: s.env ?? {},
    argsText: (s.args ?? []).join(' '),
    envText: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  };
}

function parseArgs(text: string): string[] {
  // Space-separated args; quoted substrings stay together. Good enough for
  // the typical "node ./path/to/server.js" pattern the user will input.
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter(Boolean);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) env[k] = v;
  }
  return env;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const { mcp_servers } = await api.todos.getMcp(props.todoId);
    rows.value = mcp_servers.map(toEditable);
    dirty.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function addEmpty() {
  rows.value.push({
    name: '',
    command: '',
    args: [],
    env: {},
    argsText: '',
    envText: '',
  });
  dirty.value = true;
}

function addWerkbank() {
  rows.value.push({
    name: 'werkbank',
    command: 'node',
    args: ['./apps/mcp/dist/index.js'],
    env: { WERKBANK_API_URL: 'http://localhost:3001' },
    argsText: './apps/mcp/dist/index.js',
    envText: 'WERKBANK_API_URL=http://localhost:3001',
  });
  dirty.value = true;
}

function remove(i: number) {
  rows.value.splice(i, 1);
  dirty.value = true;
}

function onFieldChange() {
  dirty.value = true;
}

async function save() {
  saving.value = true;
  error.value = null;
  try {
    const payload: McpServerConfig[] = rows.value
      .filter((r) => r.name.trim() && r.command.trim())
      .map((r) => ({
        name: r.name.trim(),
        command: r.command.trim(),
        args: parseArgs(r.argsText),
        env: parseEnv(r.envText),
      }));
    const { mcp_servers } = await api.todos.setMcp(props.todoId, payload);
    rows.value = mcp_servers.map(toEditable);
    dirty.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mcp-panel">
    <div class="mcp-header">
      <h3>🔌 MCP-Server für diese Aufgabe</h3>
      <div class="mcp-actions">
        <button type="button" class="ghost" @click="addWerkbank" :disabled="saving">+ Werkbank</button>
        <button type="button" class="ghost" @click="addEmpty" :disabled="saving">+ Neu</button>
        <button type="button" class="primary" :disabled="saving || !dirty" @click="save">Speichern</button>
      </div>
    </div>
    <p class="mcp-hint">
      Wenn nichts eingetragen ist, verwendet die Claude-Sitzung dieser Aufgabe die Standard-Konfiguration
      (<code>.mcp.json</code> im Repo-Root oder der eingebaute Werkbank-Server).
    </p>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="empty">Lade…</div>
    <div v-else-if="rows.length === 0" class="empty">
      Keine benutzerdefinierten MCP-Server. Es wird die Standard-Konfiguration verwendet.
    </div>
    <ul v-else class="mcp-list">
      <li v-for="(r, i) in rows" :key="i" class="mcp-row">
        <div class="mcp-row-head">
          <input
            type="text"
            v-model="r.name"
            placeholder="name (z.B. werkbank)"
            class="mcp-name"
            @input="onFieldChange"
          />
          <button type="button" class="danger ghost" @click="remove(i)" title="Entfernen">✕</button>
        </div>
        <label class="stacked">
          <span>Command</span>
          <input
            type="text"
            v-model="r.command"
            placeholder="z.B. node"
            @input="onFieldChange"
          />
        </label>
        <label class="stacked">
          <span>Arguments (leerzeichen-getrennt, "…" für Pfade mit Leerzeichen)</span>
          <input
            type="text"
            v-model="r.argsText"
            placeholder="./apps/mcp/dist/index.js"
            @input="onFieldChange"
          />
        </label>
        <label class="stacked">
          <span>Environment (KEY=VALUE pro Zeile)</span>
          <textarea
            v-model="r.envText"
            rows="3"
            placeholder="WERKBANK_API_URL=http://localhost:3001"
            @input="onFieldChange"
          />
        </label>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.mcp-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.mcp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.mcp-header h3 {
  margin: 0;
}
.mcp-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.mcp-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--fg-muted);
}
.empty {
  padding: 0.75rem 0.5rem;
  color: var(--fg-muted);
  font-style: italic;
  font-size: 0.85rem;
}
.mcp-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.mcp-row {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.6rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.mcp-row-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.mcp-name {
  flex: 1;
  font-family: var(--font-mono);
  font-weight: 600;
}
.stacked {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8rem;
  color: var(--fg-muted);
}
.stacked input,
.stacked textarea {
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
</style>
