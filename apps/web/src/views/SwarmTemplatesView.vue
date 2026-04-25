<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSwarmTemplatesStore } from '../stores/swarmTemplates';
import type { CoordinatorTemplate, SubagentTemplate } from '../types';

const router = useRouter();
const store  = useSwarmTemplatesStore();

const activeTab = ref<'coordinators' | 'subagents'>('coordinators');

// ── New / Edit form state ─────────────────────────────────────────────────────

const showCoordForm  = ref(false);
const editCoordId    = ref<number | null>(null);
const coordForm      = ref<Partial<CoordinatorTemplate>>({});

const showSubForm    = ref(false);
const editSubId      = ref<number | null>(null);
const subForm        = ref<Partial<SubagentTemplate>>({});

// Expanded prompt preview
const expandedCoordId = ref<number | null>(null);
const expandedSubId   = ref<number | null>(null);

const saving = ref(false);
const formError = ref<string | null>(null);

onMounted(() => store.fetchAll());

// ── Coordinator form helpers ──────────────────────────────────────────────────

function openNewCoord() {
  editCoordId.value = null;
  coordForm.value = {
    name: '',
    description: '',
    role: '',
    model: 'sonnet',
    max_turns: 25,
    system_prompt_template: '',
    tool_permissions: {
      spawnSubagents: true, writeBlackboard: true, readBlackboard: true,
      listBlackboard: true, reportProgress: true, terminate: true,
      sendToPeer: false, checkInbox: false,
    },
  };
  showCoordForm.value = true;
  formError.value = null;
}

function openEditCoord(t: CoordinatorTemplate) {
  editCoordId.value = t.id;
  coordForm.value = { ...t, tool_permissions: { ...t.tool_permissions } };
  showCoordForm.value = true;
  formError.value = null;
}

function cancelCoordForm() {
  showCoordForm.value = false;
  editCoordId.value = null;
}

async function saveCoord() {
  saving.value = true;
  formError.value = null;
  try {
    if (editCoordId.value !== null) {
      await store.updateCoordinator(editCoordId.value, coordForm.value);
    } else {
      await store.createCoordinator(coordForm.value);
    }
    if (!store.error) {
      showCoordForm.value = false;
      editCoordId.value = null;
    } else {
      formError.value = store.error;
    }
  } finally {
    saving.value = false;
  }
}

async function deleteCoord(id: number) {
  if (!confirm('Coordinator-Template wirklich löschen?')) return;
  await store.deleteCoordinator(id);
}

// ── Subagent form helpers ─────────────────────────────────────────────────────

function openNewSub() {
  editSubId.value = null;
  subForm.value = {
    name: '',
    description: '',
    prompt: '',
    model: 'sonnet',
    tools: [],
    output_schema: null,
  };
  showSubForm.value = true;
  formError.value = null;
}

function openEditSub(t: SubagentTemplate) {
  editSubId.value = t.id;
  subForm.value = { ...t, tools: [...t.tools] };
  showSubForm.value = true;
  formError.value = null;
}

function cancelSubForm() {
  showSubForm.value = false;
  editSubId.value = null;
}

async function saveSub() {
  saving.value = true;
  formError.value = null;
  try {
    if (editSubId.value !== null) {
      await store.updateSubagent(editSubId.value, subForm.value);
    } else {
      await store.createSubagent(subForm.value);
    }
    if (!store.error) {
      showSubForm.value = false;
      editSubId.value = null;
    } else {
      formError.value = store.error;
    }
  } finally {
    saving.value = false;
  }
}

async function deleteSub(id: number) {
  if (!confirm('Subagent-Template wirklich löschen?')) return;
  await store.deleteSubagent(id);
}

// ── Tools string helper ───────────────────────────────────────────────────────

function toolsString(t: SubagentTemplate): string {
  return t.tools.join(', ') || '—';
}

function subFormToolsString(): string {
  return (subForm.value.tools ?? []).join(', ');
}

function setSubFormTools(val: string) {
  subForm.value.tools = val.split(',').map((s) => s.trim()).filter(Boolean);
}

function modelBadgeStyle(model: string) {
  if (model === 'opus')   return { background: 'var(--accent)', color: 'var(--bg)' };
  if (model === 'haiku')  return { background: 'var(--success)', color: 'var(--bg)' };
  return { background: 'var(--accent-2)', color: 'var(--bg)' };
}
</script>

<template>
  <div class="st-view">
    <header class="st-header">
      <button class="ghost st-back" @click="router.push({ name: 'swarm-runs' })">← Zurück</button>
      <h1>📚 Template-Bibliothek</h1>
      <p class="st-subtitle">Wiederverwendbare Coordinator- und Subagent-Templates für Swarm-Läufe.</p>
    </header>

    <div v-if="store.error" class="st-error-banner">{{ store.error }}</div>

    <!-- Tabs -->
    <div class="st-tabs">
      <button
        :class="['st-tab', activeTab === 'coordinators' ? 'active' : '']"
        @click="activeTab = 'coordinators'"
      >
        Coordinators ({{ store.coordinatorTemplates.length }})
      </button>
      <button
        :class="['st-tab', activeTab === 'subagents' ? 'active' : '']"
        @click="activeTab = 'subagents'"
      >
        Subagents ({{ store.subagentTemplates.length }})
      </button>
    </div>

    <!-- ── COORDINATORS ─────────────────────────────────────────────────────── -->
    <section v-if="activeTab === 'coordinators'" class="st-section">
      <div class="st-section-header">
        <h2 class="st-section-title">Coordinator-Templates</h2>
        <button class="primary" @click="openNewCoord">+ Neu</button>
      </div>

      <!-- New/Edit form -->
      <div v-if="showCoordForm" class="st-form-card">
        <h3 class="st-form-title">
          {{ editCoordId !== null ? 'Coordinator bearbeiten' : 'Neues Coordinator-Template' }}
        </h3>
        <div v-if="formError" class="st-form-error">{{ formError }}</div>

        <div class="st-form-grid">
          <label class="st-label">
            Name
            <input v-model="coordForm.name" class="st-input" placeholder="z.B. Research Lead" />
          </label>
          <label class="st-label">
            Rolle
            <input v-model="coordForm.role" class="st-input" placeholder="z.B. Research Lead" />
          </label>
          <label class="st-label">
            Modell
            <select v-model="coordForm.model" class="st-select">
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </label>
          <label class="st-label">
            Max. Turns
            <input v-model.number="coordForm.max_turns" type="number" min="1" class="st-input" />
          </label>
        </div>

        <label class="st-label st-label-full">
          Beschreibung
          <input v-model="coordForm.description" class="st-input" placeholder="Kurze Beschreibung" />
        </label>

        <label class="st-label st-label-full">
          System-Prompt-Template
          <textarea
            v-model="coordForm.system_prompt_template"
            class="st-textarea st-textarea-lg"
            placeholder="Du bist {{role}} für das Ziel: {{goal}}..."
          />
        </label>

        <div class="st-form-actions">
          <button class="ghost" @click="cancelCoordForm">Abbrechen</button>
          <button class="primary" :disabled="saving" @click="saveCoord">
            {{ saving ? 'Speichere…' : 'Speichern' }}
          </button>
        </div>
      </div>

      <div v-if="store.loading" class="st-empty">Lade…</div>
      <div v-else-if="store.coordinatorTemplates.length === 0 && !showCoordForm" class="st-empty">
        Keine Coordinator-Templates. Klicke „+ Neu" um eines zu erstellen.
      </div>

      <div v-else class="st-card-list">
        <div
          v-for="t in store.coordinatorTemplates"
          :key="t.id"
          class="st-card"
        >
          <div class="st-card-header">
            <div class="st-card-title-row">
              <span class="st-card-name">{{ t.name }}</span>
              <span class="st-model-badge" :style="modelBadgeStyle(t.model)">{{ t.model }}</span>
              <span class="st-usage-badge">× {{ t.usage_count }}</span>
            </div>
            <div class="st-card-actions">
              <button class="ghost small" @click="openEditCoord(t)">✎ Bearbeiten</button>
              <button class="ghost small danger" @click="deleteCoord(t.id)">✕</button>
            </div>
          </div>

          <div class="st-card-meta">
            <span class="st-meta-item">Rolle: <strong>{{ t.role }}</strong></span>
            <span class="st-meta-item">Max. Turns: <strong>{{ t.max_turns }}</strong></span>
          </div>

          <p v-if="t.description" class="st-card-desc">{{ t.description }}</p>

          <div class="st-prompt-section">
            <button
              class="st-expand-btn"
              @click="expandedCoordId = expandedCoordId === t.id ? null : t.id"
            >
              {{ expandedCoordId === t.id ? '▲ Prompt verbergen' : '▼ System-Prompt anzeigen' }}
            </button>
            <pre v-if="expandedCoordId === t.id" class="st-prompt-pre">{{ t.system_prompt_template }}</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ── SUBAGENTS ────────────────────────────────────────────────────────── -->
    <section v-if="activeTab === 'subagents'" class="st-section">
      <div class="st-section-header">
        <h2 class="st-section-title">Subagent-Templates</h2>
        <button class="primary" @click="openNewSub">+ Neu</button>
      </div>

      <!-- New/Edit form -->
      <div v-if="showSubForm" class="st-form-card">
        <h3 class="st-form-title">
          {{ editSubId !== null ? 'Subagent bearbeiten' : 'Neues Subagent-Template' }}
        </h3>
        <div v-if="formError" class="st-form-error">{{ formError }}</div>

        <div class="st-form-grid">
          <label class="st-label">
            Name
            <input v-model="subForm.name" class="st-input" placeholder="z.B. Web Research Analyst" />
          </label>
          <label class="st-label">
            Modell
            <select v-model="subForm.model" class="st-select">
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </label>
          <label class="st-label st-label-full">
            Tools (kommagetrennt)
            <input
              :value="subFormToolsString()"
              class="st-input"
              placeholder="z.B. WebSearch, WebFetch"
              @input="setSubFormTools(($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>

        <label class="st-label st-label-full">
          Beschreibung
          <input v-model="subForm.description" class="st-input" placeholder="Kurze Beschreibung" />
        </label>

        <label class="st-label st-label-full">
          Prompt
          <textarea
            v-model="subForm.prompt"
            class="st-textarea st-textarea-lg"
            placeholder="Du bist ein Analyst. INPUT: ... OUTPUT: ..."
          />
        </label>

        <div class="st-form-actions">
          <button class="ghost" @click="cancelSubForm">Abbrechen</button>
          <button class="primary" :disabled="saving" @click="saveSub">
            {{ saving ? 'Speichere…' : 'Speichern' }}
          </button>
        </div>
      </div>

      <div v-if="store.loading" class="st-empty">Lade…</div>
      <div v-else-if="store.subagentTemplates.length === 0 && !showSubForm" class="st-empty">
        Keine Subagent-Templates. Klicke „+ Neu" um eines zu erstellen.
      </div>

      <div v-else class="st-card-list">
        <div
          v-for="t in store.subagentTemplates"
          :key="t.id"
          class="st-card"
        >
          <div class="st-card-header">
            <div class="st-card-title-row">
              <span class="st-card-name">{{ t.name }}</span>
              <span class="st-model-badge" :style="modelBadgeStyle(t.model)">{{ t.model }}</span>
              <span class="st-usage-badge">× {{ t.usage_count }}</span>
            </div>
            <div class="st-card-actions">
              <button class="ghost small" @click="openEditSub(t)">✎ Bearbeiten</button>
              <button class="ghost small danger" @click="deleteSub(t.id)">✕</button>
            </div>
          </div>

          <div class="st-card-meta">
            <span class="st-meta-item">Tools: <strong>{{ toolsString(t) }}</strong></span>
          </div>

          <p v-if="t.description" class="st-card-desc">{{ t.description }}</p>

          <div class="st-prompt-section">
            <button
              class="st-expand-btn"
              @click="expandedSubId = expandedSubId === t.id ? null : t.id"
            >
              {{ expandedSubId === t.id ? '▲ Prompt verbergen' : '▼ Prompt anzeigen' }}
            </button>
            <pre v-if="expandedSubId === t.id" class="st-prompt-pre">{{ t.prompt }}</pre>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.st-view {
  max-width: 900px;
  margin: 0 auto;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.st-header {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.st-back {
  align-self: flex-start;
  font-size: 0.82rem;
  padding: 0.1rem 0.4rem;
}

.st-header h1 {
  margin: 0;
  font-size: 1.2rem;
}

.st-subtitle {
  margin: 0;
  color: var(--fg-muted);
  font-size: 0.85rem;
}

.st-error-banner {
  background: color-mix(in srgb, var(--danger) 15%, var(--bg-elev));
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  color: var(--danger);
  font-size: 0.85rem;
}

.st-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
}

.st-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.4rem 1rem;
  font-size: 0.88rem;
  cursor: pointer;
  color: var(--fg-muted);
  transition: color 0.15s, border-color 0.15s;
}

.st-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.st-tab:hover:not(.active) {
  color: var(--fg);
}

.st-section {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.st-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.st-section-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.st-empty {
  color: var(--fg-muted);
  font-size: 0.85rem;
  font-style: italic;
  padding: 0.5rem 0;
}

/* ── Form ── */
.st-form-card {
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.st-form-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
}

.st-form-error {
  background: color-mix(in srgb, var(--danger) 15%, var(--bg-elev));
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  padding: 0.4rem 0.6rem;
  color: var(--danger);
  font-size: 0.82rem;
}

.st-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

.st-label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.8rem;
  color: var(--fg-muted);
  font-weight: 500;
}

.st-label-full {
  grid-column: 1 / -1;
}

.st-input,
.st-select {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input, var(--bg));
  color: var(--fg);
  font-size: 0.85rem;
  font-family: var(--font);
}

.st-select {
  cursor: pointer;
}

.st-textarea {
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input, var(--bg));
  color: var(--fg);
  font-size: 0.82rem;
  font-family: var(--font-mono);
  resize: vertical;
}

.st-textarea-lg {
  min-height: 10rem;
}

.st-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/* ── Card list ── */
.st-card-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.st-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 0.7rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.st-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}

.st-card-title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.st-card-name {
  font-size: 0.92rem;
  font-weight: 600;
}

.st-model-badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.1rem 0.35rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.st-usage-badge {
  font-size: 0.72rem;
  color: var(--fg-muted);
  font-family: var(--font-mono);
}

.st-card-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}

.st-card-meta {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.st-meta-item {
  font-size: 0.78rem;
  color: var(--fg-muted);
}

.st-meta-item strong {
  color: var(--fg);
}

.st-card-desc {
  margin: 0;
  font-size: 0.82rem;
  color: var(--fg-muted);
}

.st-prompt-section {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.st-expand-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 0.75rem;
  color: var(--accent);
  cursor: pointer;
  text-align: left;
  width: fit-content;
}

.st-expand-btn:hover {
  text-decoration: underline;
}

.st-prompt-pre {
  margin: 0;
  padding: 0.6rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--fg-muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 24rem;
  overflow-y: auto;
}

button.small {
  font-size: 0.78rem;
  padding: 0.15rem 0.45rem;
}

button.danger {
  color: var(--danger);
}
</style>
