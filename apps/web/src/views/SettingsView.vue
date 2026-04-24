<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { api } from '../api';
import type { Integration, GitHubConfig, JiraConfig, Recurrence, RecurrenceFrequency, RepoMapping, RepoMappingSource } from '../types';
import { FREQUENCY_LABELS } from '../types';

const integrations = ref<Integration[]>([]);
const loading = ref(true);
const flash = ref<{ type: 'ok' | 'err'; message: string } | null>(null);

const githubToken = ref('');
const githubReposText = ref('');
const githubBusy = ref(false);

const jiraToken = ref('');
const jiraBaseUrl = ref('');
const jiraEmail = ref('');
const jiraJql = ref('');
const jiraBusy = ref(false);

const github = computed<Integration | undefined>(() => integrations.value.find((i) => i.provider === 'github'));
const jira   = computed<Integration | undefined>(() => integrations.value.find((i) => i.provider === 'jira'));

async function load() {
  loading.value = true;
  try {
    integrations.value = await api.integrations.list();
    const gh = github.value?.config as GitHubConfig | undefined;
    githubReposText.value = gh?.repos?.join('\n') ?? '';
    const ji = jira.value?.config as JiraConfig | undefined;
    jiraBaseUrl.value = ji?.baseUrl ?? '';
    jiraEmail.value = ji?.email ?? '';
    jiraJql.value = ji?.jql ?? 'assignee = currentUser() AND statusCategory != Done';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function flashMsg(type: 'ok' | 'err', message: string) {
  flash.value = { type, message };
  setTimeout(() => { flash.value = null; }, 4000);
}

async function saveGithub() {
  githubBusy.value = true;
  try {
    const repos = githubReposText.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    await api.integrations.saveGithub({
      token: githubToken.value.trim() || undefined,
      repos,
    });
    githubToken.value = '';
    await load();
    flashMsg('ok', 'GitHub gespeichert.');
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    githubBusy.value = false;
  }
}

async function saveJira() {
  jiraBusy.value = true;
  try {
    await api.integrations.saveJira({
      token: jiraToken.value.trim() || undefined,
      baseUrl: jiraBaseUrl.value.trim(),
      email: jiraEmail.value.trim(),
      jql: jiraJql.value.trim(),
    });
    jiraToken.value = '';
    await load();
    flashMsg('ok', 'Jira gespeichert.');
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    jiraBusy.value = false;
  }
}

async function disconnect(provider: 'github' | 'jira') {
  if (!confirm(`${provider} wirklich trennen? Der Token wird gelöscht.`)) return;
  await api.integrations.disconnect(provider);
  await load();
  flashMsg('ok', `${provider} getrennt.`);
}

async function syncGithub() {
  githubBusy.value = true;
  try {
    const res = await api.integrations.syncGithub();
    flashMsg('ok', `GitHub: ${res.imported} importiert, ${res.updated} aktualisiert (${res.repos.join(', ')})`);
    await load();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    githubBusy.value = false;
  }
}

async function syncJira() {
  jiraBusy.value = true;
  try {
    const res = await api.integrations.syncJira();
    flashMsg('ok', `Jira: ${res.imported} importiert, ${res.updated} aktualisiert (${res.total} gesamt)`);
    await load();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    jiraBusy.value = false;
  }
}

// Full URL for the ICS calendar feed. We resolve against window.location.origin
// so users can paste this directly into Outlook/Google Calendar as a subscribed
// calendar. In dev, vite proxies /api to the backend on port 3001; in any
// production deploy the two services share an origin, so this just works.
const icsUrl = computed(() => `${window.location.origin}/api/ics.ics`);
const icsCopied = ref(false);

async function copyIcsUrl() {
  try {
    await navigator.clipboard.writeText(icsUrl.value);
    icsCopied.value = true;
    setTimeout(() => { icsCopied.value = false; }, 2000);
  } catch (e) {
    flashMsg('err', `Konnte URL nicht kopieren: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- Recurrences ----------

const recurrences = ref<Recurrence[]>([]);
const recurrencesLoading = ref(false);
const recurrenceBusy = ref(false);

const newRecurrence = ref<{
  title: string;
  frequency: RecurrenceFrequency;
  time_of_day: string;
  priority: 1 | 2 | 3 | 4;
  tagsText: string;
  description: string;
}>({
  title: '',
  frequency: 'weekdays',
  time_of_day: '08:00',
  priority: 2,
  tagsText: '',
  description: '',
});

async function loadRecurrences() {
  recurrencesLoading.value = true;
  try {
    recurrences.value = await api.recurrences.list();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    recurrencesLoading.value = false;
  }
}

async function createRecurrence() {
  const title = newRecurrence.value.title.trim();
  if (!title) return;
  recurrenceBusy.value = true;
  try {
    const tags = newRecurrence.value.tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    await api.recurrences.create({
      title,
      description: newRecurrence.value.description.trim(),
      tags,
      priority: newRecurrence.value.priority,
      frequency: newRecurrence.value.frequency,
      time_of_day: newRecurrence.value.time_of_day,
      enabled: true,
    });
    newRecurrence.value.title = '';
    newRecurrence.value.description = '';
    newRecurrence.value.tagsText = '';
    await loadRecurrences();
    flashMsg('ok', 'Wiederholung angelegt.');
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    recurrenceBusy.value = false;
  }
}

async function toggleRecurrence(r: Recurrence) {
  try {
    await api.recurrences.update(r.id, { enabled: !r.enabled });
    await loadRecurrences();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}

async function deleteRecurrence(r: Recurrence) {
  if (!confirm(`Wiederholung "${r.title}" löschen?`)) return;
  try {
    await api.recurrences.remove(r.id);
    await loadRecurrences();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}

onMounted(loadRecurrences);

// ─── Repo mappings (source + key → local git path) ──────────────────────────

const repoMappings = ref<RepoMapping[]>([]);
const repoMappingsLoading = ref(false);
const repoMappingBusy = ref(false);

const newMapping = ref<{ source: RepoMappingSource; key: string; local_path: string }>({
  source: 'github',
  key: '',
  local_path: '',
});

// Known project keys from Jira, harvested from existing todos so the user
// can pick from a dropdown instead of typing `AAR` by hand. GitHub repos come
// straight from the integration config above.
const knownJiraKeys = ref<string[]>([]);
async function loadKnownJiraKeys() {
  try {
    const todos = await api.todos.list();
    const keys = new Set<string>();
    for (const t of todos) {
      if (t.source === 'jira' && t.source_ref) {
        const m = t.source_ref.match(/^([A-Za-z][A-Za-z0-9_]*)-\d+$/);
        if (m) keys.add(m[1].toUpperCase());
      }
    }
    knownJiraKeys.value = Array.from(keys).sort();
  } catch {
    knownJiraKeys.value = [];
  }
}
onMounted(loadKnownJiraKeys);

// Repos configured in the GitHub integration — used to populate the key
// dropdown in the new-mapping form. Already-mapped repos are filtered out so
// the user doesn't try to create a duplicate (which would 409 on the backend).
const configuredGithubRepos = computed<string[]>(() => {
  const cfg = github.value?.config as GitHubConfig | undefined;
  return cfg?.repos ?? [];
});
const availableKeysForNewMapping = computed<string[]>(() => {
  const mappedKeys = new Set(
    repoMappings.value
      .filter((m) => m.source === newMapping.value.source)
      .map((m) => m.key),
  );
  const pool = newMapping.value.source === 'github'
    ? configuredGithubRepos.value
    : knownJiraKeys.value;
  return pool.filter((k) => !mappedKeys.has(k));
});

// Opens the native OS folder dialog on the backend host (which is the user's
// own machine in this local-only deployment). The backend spawns a PowerShell
// FolderBrowserDialog on Windows and returns the chosen absolute path.
const pickerBusy = ref(false);

async function pickFolder(initial: string): Promise<string | null> {
  pickerBusy.value = true;
  try {
    const { path } = await api.fs.pickFolder(initial);
    return path;
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    pickerBusy.value = false;
  }
}

async function pickForNew() {
  const p = await pickFolder(newMapping.value.local_path);
  if (p) newMapping.value.local_path = p;
}

async function pickForExisting(m: RepoMapping) {
  const p = await pickFolder(m.local_path);
  if (p) m.local_path = p;
}

async function loadRepoMappings() {
  repoMappingsLoading.value = true;
  try {
    repoMappings.value = await api.repoMappings.list();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    repoMappingsLoading.value = false;
  }
}

async function createRepoMapping() {
  const key = newMapping.value.key.trim();
  const local_path = newMapping.value.local_path.trim();
  if (!key || !local_path) return;
  repoMappingBusy.value = true;
  try {
    await api.repoMappings.create({ source: newMapping.value.source, key, local_path });
    newMapping.value.key = '';
    newMapping.value.local_path = '';
    await loadRepoMappings();
    flashMsg('ok', 'Repo-Mapping angelegt.');
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    repoMappingBusy.value = false;
  }
}

async function updateRepoMapping(m: RepoMapping) {
  try {
    await api.repoMappings.update(m.id, {
      source: m.source,
      key: m.key.trim(),
      local_path: m.local_path.trim(),
    });
    flashMsg('ok', 'Mapping gespeichert.');
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
    await loadRepoMappings();
  }
}

async function deleteRepoMapping(m: RepoMapping) {
  if (!confirm(`Mapping "${m.source}:${m.key}" löschen?`)) return;
  try {
    await api.repoMappings.remove(m.id);
    await loadRepoMappings();
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}

async function backfillMappings() {
  repoMappingBusy.value = true;
  try {
    const res = await api.repoMappings.backfill();
    flashMsg('ok', `Backfill: ${res.updated} von ${res.scanned} Todos aktualisiert.`);
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    repoMappingBusy.value = false;
  }
}

onMounted(loadRepoMappings);

// ─── Agent preprompt ────────────────────────────────────────────────────────
const DEFAULT_PREPROMPT = `Du arbeitest an einer Aufgabe aus der Werkbank. Nutze die MCP-Tools "werkbank" um den Fortschritt live zu tracken.

## Aktuelle Aufgabe
ID: {{todo_id}}
Titel: {{todo_title}}
Status: {{todo_status}}

Beschreibung:
{{todo_description}}

## Bestehende Subtasks
{{subtasks}}

## Andere offene Aufgaben auf der Werkbank (Kontext)
{{todos_list}}

## Arbeitsweise
1. Rufe **zuerst** mcp__werkbank__get_todo mit der oben genannten Todo-ID auf, um den aktuellen Stand der Aufgabe inklusive aller Subtasks live aus der Werkbank zu laden. Der Subtask-Block oben ist nur ein Snapshot vom Session-Start — er kann zwischenzeitlich ergänzt, umbenannt oder abgehakt worden sein. Arbeite grundsätzlich mit dem frisch geladenen Stand.
2. Prüfe die geladenen Subtasks. Decken sie die Aufgabe vollständig ab? Sind sie ausreichend, arbeite sie direkt ab. Fehlen Schritte oder existieren noch keine, ergänze sie via mcp__werkbank__add_subtask, bevor du mit der Umsetzung beginnst.
3. Arbeite die Subtasks nacheinander ab und hake jeden Schritt ab, sobald er erledigt ist (mcp__werkbank__update_subtask mit done=true). Bei längeren Sessions rufe zwischendurch erneut mcp__werkbank__get_todo auf, damit du nicht an veralteten Subtasks arbeitest.
4. Wenn du fertig bist, rufe mcp__werkbank__finalize_todo mit einer kurzen Zusammenfassung der Ergebnisse auf. Setze next_status auf "test" wenn Review nötig ist, sonst "done".

## User-Prompt
{{user_prompt}}
`;

const preprompt = ref('');
const prepromptBusy = ref(false);

async function loadPreprompt() {
  try {
    const all = await api.settings.getAll();
    const v = all['agent.preprompt'];
    preprompt.value = typeof v === 'string' && v.trim() ? v : DEFAULT_PREPROMPT;
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}
onMounted(loadPreprompt);

async function savePreprompt() {
  prepromptBusy.value = true;
  try {
    await api.settings.set('agent.preprompt', preprompt.value);
    flashMsg('ok', 'Preprompt gespeichert.');
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    prepromptBusy.value = false;
  }
}

function resetPreprompt() {
  preprompt.value = DEFAULT_PREPROMPT;
}

// ─── Sandbox (remote container runner) ──────────────────────────────────────
// Eight persisted keys under `sandbox.*` — each saves on blur so the user
// doesn't have to hunt for a save button. Two action buttons: reach-test
// (sanity check werkbank_public_url from inside the sandbox) and image
// rebuild (streams `docker build` output into a live <pre>). Token-scope
// check is intentionally NOT shipped — M2 did not provide the endpoint.

const sandbox = ref({
  docker_context: '',
  werkbank_public_url: '',
  max_concurrent: 3,
  default_timeout_min: 30,
  default_max_turns: 40,
  claude_model: 'claude-sonnet-4-5',
  git_author_name: 'claude-bot',
  git_author_email: 'claude-bot@users.noreply.github.com',
});

const sandboxBusy = ref(false);
const sandboxBuildLog = ref('');
const sandboxBuildActive = ref(false);

async function loadSandboxSettings() {
  try {
    const all = await api.settings.getAll();
    sandbox.value = {
      docker_context: (all['sandbox.docker_context'] as string) ?? 'lp03',
      werkbank_public_url: (all['sandbox.werkbank_public_url'] as string) ?? '',
      max_concurrent: (all['sandbox.max_concurrent'] as number) ?? 3,
      default_timeout_min: (all['sandbox.default_timeout_min'] as number) ?? 30,
      default_max_turns: (all['sandbox.default_max_turns'] as number) ?? 40,
      claude_model: (all['sandbox.claude_model'] as string) ?? 'claude-sonnet-4-5',
      git_author_name: (all['sandbox.git_author_name'] as string) ?? 'claude-bot',
      git_author_email: (all['sandbox.git_author_email'] as string)
        ?? 'claude-bot@users.noreply.github.com',
    };
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}
onMounted(loadSandboxSettings);

async function saveSandboxKey(key: keyof typeof sandbox.value) {
  try {
    await api.settings.set(`sandbox.${key}`, sandbox.value[key]);
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}

async function testSandboxConnection() {
  sandboxBusy.value = true;
  try {
    const r = await api.sandbox.testConnection();
    if (r.ok && r.werkbankReachable) {
      flashMsg('ok', `Werkbank vom Sandbox-Host erreichbar. ${r.detail}`);
    } else if (!r.werkbankReachable) {
      flashMsg('err', `Werkbank vom lp03 aus nicht erreichbar — ${r.detail}`);
    } else {
      flashMsg('err', `Sandbox-Container auf lp03 konnte nicht gestartet werden — ${r.detail}`);
    }
  } catch (e) {
    flashMsg('err', e instanceof Error ? e.message : String(e));
  } finally {
    sandboxBusy.value = false;
  }
}

async function rebuildSandboxImage() {
  if (sandboxBuildActive.value) return;
  sandboxBuildActive.value = true;
  sandboxBuildLog.value = '';
  try {
    await api.sandbox.rebuildImage(
      (text) => { sandboxBuildLog.value += text; },
      (result) => {
        sandboxBuildActive.value = false;
        if (result.ok) {
          flashMsg('ok', `Image gebaut: ${result.imageTag ?? '(kein Tag)'}`);
        } else {
          flashMsg('err', `Build fehlgeschlagen: ${result.error ?? 'unbekannter Fehler'}`);
        }
      },
    );
  } catch (e) {
    sandboxBuildActive.value = false;
    flashMsg('err', e instanceof Error ? e.message : String(e));
  }
}

// Firewall whitelist preview — the sandbox runner restricts outbound network
// traffic to these hosts plus the configured werkbank_public_url. Read-only
// in the UI because the list is wired into docker/sandbox/Dockerfile +
// iptables rules on lp03; changing it here would just mislead.
const sandboxWhitelist = computed<string[]>(() => {
  const base = ['github.com', 'api.github.com', 'api.anthropic.com', 'registry.npmjs.org', 'statsig.com'];
  const extra = sandbox.value.werkbank_public_url.trim();
  if (extra) {
    try {
      const host = new URL(extra).host;
      if (host && !base.includes(host)) base.push(host);
    } catch {
      base.push(extra);
    }
  }
  return base;
});

// ─── Tab navigation ─────────────────────────────────────────────────────────
type TabId = 'connections' | 'repos' | 'recurrences' | 'agent' | 'sandbox';
const activeTab = ref<TabId>('connections');
const tabs: { id: TabId; label: string }[] = [
  { id: 'connections', label: '🔌 Verbindungen' },
  { id: 'repos', label: '📁 Repo-Pfade' },
  { id: 'recurrences', label: '🔁 Wiederkehrend' },
  { id: 'agent', label: '🤖 Agent' },
  { id: 'sandbox', label: '🐳 Sandbox' },
];
</script>

<template>
  <div class="settings-page">
    <h2 style="font-family: var(--font-display); margin-top: 0;">⚙️ Einstellungen</h2>

    <nav class="settings-tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === t.id"
        :class="['tab', { active: activeTab === t.id }]"
        @click="activeTab = t.id"
      >{{ t.label }}</button>
    </nav>

    <div v-if="flash" :class="['flash', flash.type === 'err' ? 'error' : '']">{{ flash.message }}</div>

    <div v-if="loading">Lade…</div>

    <div class="settings-grid" v-show="!loading && activeTab === 'connections'">
      <section>
        <h3>⛓ GitHub</h3>
        <div class="kv"><span>Status</span>
          <span>
            <span class="status-dot" :class="github?.lastSyncError ? 'err' : (github?.hasToken ? 'on' : 'off')"></span>
            {{ github?.hasToken ? 'Verbunden' : 'Nicht verbunden' }}
          </span>
        </div>
        <div class="kv" v-if="github?.hasToken"><span>Token</span><span style="font-family: var(--font-mono);">{{ github.tokenMasked }}</span></div>
        <div class="kv" v-if="github?.lastSyncAt"><span>Letzter Sync</span><span>{{ new Date(github.lastSyncAt).toLocaleString() }}</span></div>
        <div class="kv" v-if="github?.lastSyncError"><span>Letzter Fehler</span><span style="color: var(--danger);">{{ github.lastSyncError }}</span></div>

        <label class="stacked" style="margin-top: 0.75rem;">
          <span>Personal Access Token (<code>repo</code> scope)</span>
          <input v-model="githubToken" type="password" :placeholder="github?.hasToken ? 'Leer lassen, um nicht zu ändern' : 'ghp_...'" autocomplete="off" />
        </label>
        <label class="stacked" style="margin-top: 0.5rem;">
          <span>Repos (eine pro Zeile, Format: <code>owner/name</code>)</span>
          <textarea v-model="githubReposText" rows="4" placeholder="anthropics/claude-code&#10;vuejs/core" />
        </label>

        <div class="row" style="margin-top: 0.75rem;">
          <button class="primary" :disabled="githubBusy" @click="saveGithub">Speichern</button>
          <button :disabled="githubBusy || !github?.hasToken" @click="syncGithub">↻ Jetzt synchronisieren</button>
          <button v-if="github?.hasToken" class="danger" @click="disconnect('github')">Trennen</button>
        </div>
      </section>

      <section>
        <h3>📋 Jira</h3>
        <div class="kv"><span>Status</span>
          <span>
            <span class="status-dot" :class="jira?.lastSyncError ? 'err' : (jira?.hasToken ? 'on' : 'off')"></span>
            {{ jira?.hasToken ? 'Verbunden' : 'Nicht verbunden' }}
          </span>
        </div>
        <div class="kv" v-if="jira?.hasToken"><span>Token</span><span style="font-family: var(--font-mono);">{{ jira.tokenMasked }}</span></div>
        <div class="kv" v-if="jira?.lastSyncAt"><span>Letzter Sync</span><span>{{ new Date(jira.lastSyncAt).toLocaleString() }}</span></div>
        <div class="kv" v-if="jira?.lastSyncError"><span>Letzter Fehler</span><span style="color: var(--danger);">{{ jira.lastSyncError }}</span></div>

        <label class="stacked" style="margin-top: 0.75rem;">
          <span>Base-URL</span>
          <input v-model="jiraBaseUrl" type="url" placeholder="https://example.atlassian.net" />
        </label>
        <label class="stacked" style="margin-top: 0.5rem;">
          <span>Email</span>
          <input v-model="jiraEmail" type="email" placeholder="you@example.com" />
        </label>
        <label class="stacked" style="margin-top: 0.5rem;">
          <span>API-Token</span>
          <input v-model="jiraToken" type="password" :placeholder="jira?.hasToken ? 'Leer lassen, um nicht zu ändern' : 'ATATT...'" autocomplete="off" />
        </label>
        <label class="stacked" style="margin-top: 0.5rem;">
          <span>JQL-Filter</span>
          <textarea v-model="jiraJql" rows="3" placeholder="assignee = currentUser() AND statusCategory != Done" />
        </label>

        <div class="row" style="margin-top: 0.75rem;">
          <button class="primary" :disabled="jiraBusy" @click="saveJira">Speichern</button>
          <button :disabled="jiraBusy || !jira?.hasToken" @click="syncJira">↻ Jetzt synchronisieren</button>
          <button v-if="jira?.hasToken" class="danger" @click="disconnect('jira')">Trennen</button>
        </div>
      </section>
    </div>

    <section v-show="!loading && activeTab === 'connections'" style="margin-top: 1.5rem;">
      <h3>📅 Kalender-Sync (ICS)</h3>
      <p style="color: var(--fg-muted); font-size: 0.85rem; margin-top: 0.25rem;">
        Alle Todos mit Fälligkeitsdatum werden als iCalendar-Feed veröffentlicht.
        URL in Outlook oder Google Calendar als abonnierten Kalender einfügen.
      </p>
      <div class="row" style="margin-top: 0.5rem; align-items: center;">
        <input
          type="text"
          :value="icsUrl"
          readonly
          style="flex: 1; font-family: var(--font-mono); font-size: 0.85rem;"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button class="primary" @click="copyIcsUrl">
          {{ icsCopied ? '✓ Kopiert!' : '📋 ICS-URL kopieren' }}
        </button>
      </div>
    </section>

    <section v-show="!loading && activeTab === 'repos'" style="margin-top: 1.5rem;">
      <h3>📁 Repo → lokaler Git-Pfad</h3>
      <p style="color: var(--fg-muted); font-size: 0.85rem; margin-top: 0.25rem;">
        Verknüpft ein GitHub-Repo (<code>owner/name</code>) oder einen Jira-Projektkey (<code>AAR</code>)
        mit einem lokalen Verzeichnis. Beim nächsten Sync wird das Arbeitsverzeichnis neuer Todos
        automatisch gesetzt — damit der Claude-Agent direkt im richtigen Repo startet.
      </p>

      <form class="repo-mapping-form" @submit.prevent="createRepoMapping" style="margin-top: 0.75rem; display: grid; grid-template-columns: 140px 1fr 2fr auto; gap: 0.5rem; align-items: end;">
        <label class="stacked">
          <span>Typ</span>
          <select v-model="newMapping.source">
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>
        </label>
        <label class="stacked">
          <span>{{ newMapping.source === 'github' ? 'Repo (owner/name)' : 'Projektkey (z.B. AAR)' }}</span>
          <select
            v-if="availableKeysForNewMapping.length > 0"
            v-model="newMapping.key"
            required
          >
            <option value="" disabled>— auswählen —</option>
            <option v-for="k in availableKeysForNewMapping" :key="k" :value="k">{{ k }}</option>
          </select>
          <input
            v-else
            v-model="newMapping.key"
            type="text"
            :placeholder="newMapping.source === 'github' ? 'HausPerfekt/HausPerfekt.Mobile.Sync' : 'AAR'"
            required
          />
        </label>
        <label class="stacked">
          <span>Lokaler Pfad</span>
          <div style="display: flex; gap: 0.3rem;">
            <input
              v-model="newMapping.local_path"
              type="text"
              placeholder="D:\BBA\HausPerfekt.Mobile.Sync"
              required
              style="flex: 1; font-family: var(--font-mono); font-size: 0.85rem;"
            />
            <button type="button" class="ghost" :disabled="pickerBusy" @click="pickForNew" title="Ordner durchsuchen">📁</button>
          </div>
        </label>
        <button
          type="submit"
          class="primary"
          :disabled="repoMappingBusy || !newMapping.key.trim() || !newMapping.local_path.trim()"
        >+ Anlegen</button>
      </form>
      <p v-if="newMapping.source === 'github' && configuredGithubRepos.length === 0" style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--fg-muted);">
        Noch keine GitHub-Repos konfiguriert — trag sie zuerst im Tab „🔌 Verbindungen" ein.
      </p>
      <p v-else-if="availableKeysForNewMapping.length === 0" style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--fg-muted);">
        Alle {{ newMapping.source === 'github' ? 'Repos' : 'Projekte' }} sind bereits gemappt.
      </p>

      <div v-if="repoMappingsLoading" style="margin-top: 0.75rem; color: var(--fg-muted);">Lade…</div>
      <div v-else-if="repoMappings.length === 0" style="margin-top: 0.75rem; color: var(--fg-muted);">
        Noch keine Mappings angelegt.
      </div>
      <ul v-else class="repo-mapping-list" style="list-style: none; margin: 0.75rem 0 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem;">
        <li
          v-for="m in repoMappings"
          :key="m.id"
          class="repo-mapping-item"
          style="display: grid; grid-template-columns: 140px 1fr 2fr auto auto auto; gap: 0.5rem; align-items: center; padding: 0.55rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev);"
        >
          <select v-model="m.source">
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>
          <input v-model="m.key" type="text" />
          <input v-model="m.local_path" type="text" style="font-family: var(--font-mono); font-size: 0.85rem;" />
          <button class="ghost" :disabled="pickerBusy" @click="pickForExisting(m)" title="Ordner durchsuchen">📁</button>
          <button class="ghost" @click="updateRepoMapping(m)" title="Speichern">💾</button>
          <button class="danger" @click="deleteRepoMapping(m)">Löschen</button>
        </li>
      </ul>

      <div class="row" style="margin-top: 0.75rem; gap: 0.5rem; align-items: baseline;">
        <button class="ghost" :disabled="repoMappingBusy" @click="backfillMappings" title="Setze Arbeitsverzeichnis auf allen bereits importierten Todos mit leerem Pfad">
          ↻ Auf bestehende Todos anwenden
        </button>
        <span style="color: var(--fg-muted); font-size: 0.8rem;">
          Bestehende Todos mit leerem Arbeitsverzeichnis werden anhand der Mappings aktualisiert. Vom Benutzer gesetzte Pfade bleiben unangetastet.
        </span>
      </div>
    </section>

    <section v-show="!loading && activeTab === 'recurrences'" style="margin-top: 1.5rem;">
      <h3>🔁 Wiederkehrende Aufgaben</h3>
      <p style="color: var(--fg-muted); font-size: 0.85rem; margin-top: 0.25rem;">
        Erzeugt einen neuen Todo zum gewählten Zeitpunkt — täglich, werktags, wöchentlich oder monatlich.
      </p>

      <form class="recurrence-form" @submit.prevent="createRecurrence" style="margin-top: 0.75rem; display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 0.5rem; align-items: end;">
        <label class="stacked">
          <span>Titel</span>
          <input v-model="newRecurrence.title" type="text" placeholder="Standup vorbereiten" required />
        </label>
        <label class="stacked">
          <span>Intervall</span>
          <select v-model="newRecurrence.frequency">
            <option value="daily">{{ FREQUENCY_LABELS.daily }}</option>
            <option value="weekdays">{{ FREQUENCY_LABELS.weekdays }}</option>
            <option value="weekly">{{ FREQUENCY_LABELS.weekly }}</option>
            <option value="monthly">{{ FREQUENCY_LABELS.monthly }}</option>
          </select>
        </label>
        <label class="stacked">
          <span>Uhrzeit</span>
          <input v-model="newRecurrence.time_of_day" type="time" required />
        </label>
        <label class="stacked">
          <span>Priorität</span>
          <select v-model.number="newRecurrence.priority">
            <option :value="1">🔴 Dringend</option>
            <option :value="2">🟡 Normal</option>
            <option :value="3">🟢 Niedrig</option>
            <option :value="4">⚪ Irgendwann</option>
          </select>
        </label>
        <button type="submit" class="primary" :disabled="recurrenceBusy || !newRecurrence.title.trim()">+ Anlegen</button>
      </form>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem;">
        <label class="stacked">
          <span>Tags (komma-getrennt)</span>
          <input v-model="newRecurrence.tagsText" type="text" placeholder="daily, standup" />
        </label>
        <label class="stacked">
          <span>Beschreibung (optional)</span>
          <input v-model="newRecurrence.description" type="text" />
        </label>
      </div>

      <div v-if="recurrencesLoading" style="margin-top: 0.75rem; color: var(--fg-muted);">Lade…</div>
      <div v-else-if="recurrences.length === 0" style="margin-top: 0.75rem; color: var(--fg-muted);">Keine Wiederholungen angelegt.</div>
      <ul v-else class="recurrence-list" style="list-style: none; margin: 0.75rem 0 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem;">
        <li v-for="r in recurrences" :key="r.id" class="recurrence-item" :class="{ disabled: !r.enabled }" style="display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev);">
          <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
            <input type="checkbox" :checked="r.enabled" @change="toggleRecurrence(r)" />
          </label>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ r.title }}</div>
            <div style="font-size: 0.78rem; color: var(--fg-muted); font-family: var(--font-mono);">
              {{ FREQUENCY_LABELS[r.frequency] }} · {{ r.time_of_day }} · nächster: {{ new Date(r.next_fire_at).toLocaleString() }}
            </div>
          </div>
          <button class="danger" @click="deleteRecurrence(r)">Löschen</button>
        </li>
      </ul>
    </section>

    <section v-show="!loading && activeTab === 'agent'" style="margin-top: 1.5rem;">
      <h3>🤖 Claude-Agent Preprompt</h3>
      <p v-pre style="color: var(--fg-muted); font-size: 0.85rem; margin-top: 0;">
        Diese Vorlage wird beim Start einer Agent-Sitzung um deinen User-Prompt gelegt. Verfügbare Platzhalter:
        <code>{{todo_id}}</code>,
        <code>{{todo_title}}</code>,
        <code>{{todo_description}}</code>,
        <code>{{todo_status}}</code>,
        <code>{{subtasks}}</code>,
        <code>{{snippets}}</code>,
        <code>{{analyses}}</code>,
        <code>{{todos_list}}</code>,
        <code>{{user_prompt}}</code>.
      </p>
      <textarea
        v-model="preprompt"
        rows="18"
        style="font-family: var(--font-mono); font-size: 0.82rem; line-height: 1.5;"
      />
      <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
        <button class="primary" :disabled="prepromptBusy" @click="savePreprompt">Speichern</button>
        <button class="ghost" :disabled="prepromptBusy" @click="resetPreprompt">Auf Standard zurücksetzen</button>
      </div>
    </section>

    <section v-show="!loading && activeTab === 'sandbox'" style="margin-top: 1.5rem;">
      <h3>🐳 Sandbox</h3>
      <p style="color: var(--fg-muted); font-size: 0.85rem; margin-top: 0.25rem;">
        Konfiguration für den Remote-Sandbox-Runner auf lp03. Einstellungen speichern beim Verlassen des Felds.
      </p>

      <div class="sandbox-grid">
        <label class="stacked">
          <span>Docker-Context</span>
          <input
            v-model="sandbox.docker_context"
            type="text"
            spellcheck="false"
            placeholder="lp03"
            style="font-family: var(--font-mono);"
            @blur="saveSandboxKey('docker_context')"
            @keydown.enter.prevent="saveSandboxKey('docker_context')"
          />
        </label>
        <label class="stacked">
          <span>Werkbank-URL (aus Sandbox erreichbar)</span>
          <input
            v-model="sandbox.werkbank_public_url"
            type="url"
            spellcheck="false"
            placeholder="http://lp03:3001"
            style="font-family: var(--font-mono);"
            @blur="saveSandboxKey('werkbank_public_url')"
            @keydown.enter.prevent="saveSandboxKey('werkbank_public_url')"
          />
        </label>
        <label class="stacked">
          <span>Max. parallele Runs</span>
          <input
            v-model.number="sandbox.max_concurrent"
            type="number"
            min="1"
            max="10"
            @blur="saveSandboxKey('max_concurrent')"
            @keydown.enter.prevent="saveSandboxKey('max_concurrent')"
          />
        </label>
        <label class="stacked">
          <span>Standard-Timeout (Minuten)</span>
          <input
            v-model.number="sandbox.default_timeout_min"
            type="number"
            min="1"
            max="120"
            @blur="saveSandboxKey('default_timeout_min')"
            @keydown.enter.prevent="saveSandboxKey('default_timeout_min')"
          />
        </label>
        <label class="stacked">
          <span>Standard Max. Turns</span>
          <input
            v-model.number="sandbox.default_max_turns"
            type="number"
            min="1"
            max="80"
            @blur="saveSandboxKey('default_max_turns')"
            @keydown.enter.prevent="saveSandboxKey('default_max_turns')"
          />
        </label>
        <label class="stacked">
          <span>Claude-Model</span>
          <input
            v-model="sandbox.claude_model"
            type="text"
            spellcheck="false"
            placeholder="claude-sonnet-4-5"
            style="font-family: var(--font-mono);"
            @blur="saveSandboxKey('claude_model')"
            @keydown.enter.prevent="saveSandboxKey('claude_model')"
          />
        </label>
        <label class="stacked">
          <span>Git-Author Name</span>
          <input
            v-model="sandbox.git_author_name"
            type="text"
            spellcheck="false"
            placeholder="claude-bot"
            @blur="saveSandboxKey('git_author_name')"
            @keydown.enter.prevent="saveSandboxKey('git_author_name')"
          />
        </label>
        <label class="stacked">
          <span>Git-Author E-Mail</span>
          <input
            v-model="sandbox.git_author_email"
            type="email"
            spellcheck="false"
            placeholder="claude-bot@users.noreply.github.com"
            @blur="saveSandboxKey('git_author_email')"
            @keydown.enter.prevent="saveSandboxKey('git_author_email')"
          />
        </label>
      </div>

      <div class="row" style="margin-top: 1rem; gap: 0.5rem; flex-wrap: wrap;">
        <button
          class="primary"
          :disabled="sandboxBusy"
          @click="testSandboxConnection"
          title="Startet einen Throwaway-Container auf lp03 und probiert, die Werkbank-URL zu erreichen"
        >🔌 Erreichbarkeit testen</button>
        <button
          class="ghost"
          :disabled="sandboxBuildActive"
          @click="rebuildSandboxImage"
          title="Baut das Sandbox-Image auf lp03 neu; Log-Ausgabe streamt unten"
        >🐳 Sandbox-Image neu bauen</button>
      </div>

      <pre
        v-if="sandboxBuildLog || sandboxBuildActive"
        class="sandbox-build-log"
      >{{ sandboxBuildLog || '(warte auf Build-Output…)' }}</pre>

      <div style="margin-top: 1rem;">
        <h4 style="margin: 0 0 0.25rem 0; font-family: var(--font-display);">Firewall-Whitelist (nur Lesen)</h4>
        <p style="color: var(--fg-muted); font-size: 0.8rem; margin: 0 0 0.5rem 0;">
          Ausgehender Traffic im Sandbox-Container ist auf diese Hosts beschränkt.
        </p>
        <ul class="sandbox-whitelist">
          <li v-for="host in sandboxWhitelist" :key="host">
            <code>{{ host }}</code>
          </li>
        </ul>
      </div>
    </section>

    <p style="color: var(--fg-muted); font-size: 0.85rem; margin-top: 1.5rem;">
      Tokens werden AES-256-GCM-verschlüsselt in SQLite abgelegt und verlassen das Backend nie. Im Frontend erscheinen sie nur maskiert.
    </p>

  </div>
</template>

<style scoped>
.recurrence-item.disabled {
  opacity: 0.55;
}

/* Make the settings page own its scroll. main.content has overflow:hidden
   and is a flex column, so we need flex:1 + min-height:0 + overflow-y:auto. */
.settings-page {
  max-width: 1200px;
  width: min(100%, 1200px);
  margin: 0 auto;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 0.5rem; /* keep the scrollbar off the card edges */
}

.settings-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0 0 1rem 0;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.4rem;
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 1;
}
.settings-tabs .tab {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: 0.35rem 0.8rem;
  color: var(--fg-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.settings-tabs .tab:hover {
  color: var(--fg);
  background: var(--bg-elev);
}
.settings-tabs .tab.active {
  color: var(--fg);
  background: var(--bg-elev);
  border-color: var(--accent-2);
}

.sandbox-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0.75rem;
  margin-top: 0.75rem;
}
.sandbox-build-log {
  margin: 0.75rem 0 0 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.sandbox-whitelist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.sandbox-whitelist li {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.2rem 0.65rem;
  font-size: 0.8rem;
}
.sandbox-whitelist code { background: transparent; }

</style>
