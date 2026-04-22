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
1. Plane die Umsetzung in kleine Schritte und lege sie als Subtasks an (mcp__werkbank__add_subtask).
2. Arbeite die Subtasks ab und hake jeden Schritt ab, sobald er erledigt ist (mcp__werkbank__update_subtask mit done=true).
3. Wenn du fertig bist, rufe mcp__werkbank__finalize_todo mit einer kurzen Zusammenfassung der Ergebnisse auf. Setze next_status auf "test" wenn Review nötig ist, sonst "done".

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

// ─── Tab navigation ─────────────────────────────────────────────────────────
type TabId = 'connections' | 'repos' | 'recurrences' | 'agent';
const activeTab = ref<TabId>('connections');
const tabs: { id: TabId; label: string }[] = [
  { id: 'connections', label: '🔌 Verbindungen' },
  { id: 'repos', label: '📁 Repo-Pfade' },
  { id: 'recurrences', label: '🔁 Wiederkehrend' },
  { id: 'agent', label: '🤖 Agent' },
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
          <input
            v-model="newMapping.key"
            type="text"
            :placeholder="newMapping.source === 'github' ? 'HausPerfekt/HausPerfekt.Mobile.Sync' : 'AAR'"
            required
          />
        </label>
        <label class="stacked">
          <span>Lokaler Pfad</span>
          <input
            v-model="newMapping.local_path"
            type="text"
            placeholder="D:\BBA\HausPerfekt.Mobile.Sync"
            required
          />
        </label>
        <button
          type="submit"
          class="primary"
          :disabled="repoMappingBusy || !newMapping.key.trim() || !newMapping.local_path.trim()"
        >+ Anlegen</button>
      </form>

      <div v-if="repoMappingsLoading" style="margin-top: 0.75rem; color: var(--fg-muted);">Lade…</div>
      <div v-else-if="repoMappings.length === 0" style="margin-top: 0.75rem; color: var(--fg-muted);">
        Noch keine Mappings angelegt.
      </div>
      <ul v-else class="repo-mapping-list" style="list-style: none; margin: 0.75rem 0 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem;">
        <li
          v-for="m in repoMappings"
          :key="m.id"
          class="repo-mapping-item"
          style="display: grid; grid-template-columns: 140px 1fr 2fr auto auto; gap: 0.5rem; align-items: center; padding: 0.55rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev);"
        >
          <select v-model="m.source">
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>
          <input v-model="m.key" type="text" />
          <input v-model="m.local_path" type="text" style="font-family: var(--font-mono); font-size: 0.85rem;" />
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
</style>
