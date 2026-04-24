<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Todo, Attachment, Integration } from '../types';
import { api, type AgentSession } from '../api';
import PathPicker from './PathPicker.vue';
import { useTodosStore } from '../stores/todos';
import { computeAgentBranchName } from '../utils/branchName';

const ATTACHMENT_KIND_ICON: Record<string, string> = {
  image: '🖼',
  video: '🎞',
  audio: '🔊',
  pdf: '📄',
  text: '📝',
  archive: '🗜',
  office: '📊',
  other: '📎',
};

const props = defineProps<{ todo: Todo }>();
const emit = defineEmits<{
  (e: 'active', value: boolean): void;
}>();

const todosStore = useTodosStore();

// Working directory is owned by the parent ("Aktuelle Aufgabe" card in
// TodoDetailView.vue). We still load the default setting so effectiveCwd can
// fall back when the todo has no explicit working_directory.
const defaultCwd = ref<string>('');
const prompt = ref<string>(buildDefaultPrompt(props.todo));
const followup = ref<string>('');
const session = ref<AgentSession | null>(null);
const output = ref<string>('');
const error = ref<string | null>(null);
const outputEl = ref<HTMLPreElement | null>(null);

// Attachments for the current todo + the IDs the user has opted to hand over
// to Claude for the next turn. Sticky across sends — user unchecks what they
// don't want.
const attachments = ref<Attachment[]>([]);
const selectedAttachmentIds = ref<Set<number>>(new Set());

// Prior analyse-mode outputs saved on this todo. When analysisCount > 0 the
// panel shows a checkbox that injects them into the preprompt of the next
// work-mode session.
const analysisCount = ref<number>(0);
const includeAnalyses = ref<boolean>(false);

// Snippets attached to this todo. When snippetCount > 0 the panel shows a
// checkbox that injects them (as fenced code blocks) into the preprompt.
const snippetCount = ref<number>(0);
const includeSnippets = ref<boolean>(false);

// Per-todo preprompt override. Null = fall back to global setting. The editor
// is hidden by default behind a disclosure toggle so the panel stays compact.
const prepromptDraft = ref<string>(props.todo.preprompt ?? '');
const prepromptOpen = ref<boolean>(false);
const prepromptBusy = ref<boolean>(false);
const prepromptDirty = computed(
  () => (prepromptDraft.value ?? '') !== (props.todo.preprompt ?? ''),
);

// Saved paths for this todo — chips under the prompt textarea for quick reuse.
// Frontend source of truth mirrors props.todo.saved_paths; writes go through
// api.todos.update directly (bypassing the Pinia store's undo machinery, we
// don't want every path insert flooding the undo stack).
const savedPaths = ref<string[]>([...(props.todo.saved_paths ?? [])]);

// Fuzzy path picker state. Two usage modes:
//  - 'button'   → user clicked "📂 Pfad einfügen" — picker is block-level,
//                 below the textarea, full search input.
//  - 'inline'   → user typed `@` in the textarea — picker floats next to the
//                 caret and its query is the text after the `@`.
type PickerMode = 'button' | 'inline';
const pickerOpen = ref(false);
const pickerMode = ref<PickerMode>('button');
const pickerInitialQuery = ref('');
// Anchor for floating mode — pixel position of the `@` marker.
const pickerX = ref(0);
const pickerY = ref(0);
// Target textarea that should receive the inserted path. Either the first
// message textarea or the follow-up textarea depending on which is active.
const pickerTargetRef = ref<HTMLTextAreaElement | null>(null);
// Character offset in the textarea's value where the `@` trigger sits. When
// the picker closes with a selection we replace `@<query>` with `@<path>`.
const inlineAtStart = ref<number>(-1);

const promptTextareaRef = ref<HTMLTextAreaElement | null>(null);
const followupTextareaRef = ref<HTMLTextAreaElement | null>(null);

let eventSource: EventSource | null = null;

const running = computed(() => session.value?.status === 'running');
const turnActive = computed(() => !!session.value?.turnActive);
const hasOutput = computed(() => output.value.length > 0);
const hasSessionId = computed(() => !!session.value?.sessionId);
const turnCount = computed(() => session.value?.turns?.length ?? 0);
const active = computed(() => running.value || hasOutput.value || hasSessionId.value);

const effectiveCwd = computed(() => ((props.todo.working_directory ?? '') || defaultCwd.value || '').trim());
const canRun = computed(() => !running.value && effectiveCwd.value.length > 0 && prompt.value.trim().length > 0);
const canSend = computed(() => running.value && !turnActive.value && followup.value.trim().length > 0);

// ─── Sandbox run state ──────────────────────────────────────────────────────
// One sandbox run per todo at a time (M2 enforces this server-side). The UI
// gate keeps the button disabled until the user has both a linked GitHub
// source_ref AND a configured github PAT — the server will 400 otherwise.
const githubIntegration = ref<Integration | null>(null);
const sandboxBusy = ref(false);

const sandboxStatus = computed(() => (props.todo.sandbox_status ?? 'idle'));
const sandboxRunning = computed(() =>
  sandboxStatus.value === 'queued' || sandboxStatus.value === 'running',
);
const hasGithubToken = computed(() => !!githubIntegration.value?.hasToken);
const canSandbox = computed(
  () =>
    canRun.value &&
    !!props.todo.source_ref &&
    props.todo.source === 'github' &&
    hasGithubToken.value,
);
const sandboxTooltip = computed(() => {
  if (!props.todo.source_ref || props.todo.source !== 'github') {
    return 'Sandbox benötigt ein verknüpftes GitHub-Repo';
  }
  if (!hasGithubToken.value) return 'Sandbox benötigt ein verknüpftes GitHub-Repo';
  return '';
});

function buildDefaultPrompt(todo: Todo): string {
  const parts: string[] = [];
  parts.push(`Task: ${todo.title}`);
  if (todo.description && todo.description.trim()) {
    parts.push('');
    parts.push('Description:');
    parts.push(todo.description.trim());
  }
  if (todo.source_url) {
    parts.push('');
    parts.push(`Source: ${todo.source_url}`);
  }
  parts.push('');
  parts.push('Please help me complete this.');
  return parts.join('\n');
}

function scrollOutputToEnd() {
  nextTick(() => {
    if (outputEl.value) outputEl.value.scrollTop = outputEl.value.scrollHeight;
  });
}

function subscribe() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(api.agent.streamUrl(props.todo.id));

  eventSource.addEventListener('snapshot', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AgentSession | null;
    session.value = data;
    output.value = data?.output ?? '';
    if (data && data.prompt) prompt.value = data.prompt;
    scrollOutputToEnd();
  });

  eventSource.addEventListener('chunk', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as { text: string };
    output.value += data.text;
    scrollOutputToEnd();
  });

  eventSource.addEventListener('end', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AgentSession;
    session.value = data;
    output.value = data.output;
    scrollOutputToEnd();
    // Sandbox runs finish on the shared pipe too — refetch so the board card
    // moves to Prüfstand (status='test') once the server has set
    // sandbox_status='pushed'. Cheap compared to the full-page stream; only
    // fires at end-of-run.
    if (sandboxRunning.value) {
      void todosStore.fetchAll();
    }
  });

  eventSource.addEventListener('turn-end', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AgentSession;
    session.value = data;
    scrollOutputToEnd();
    // Pick up attachments that were uploaded while Claude was thinking so the
    // user can include them in the next send, plus any analyses a just-finished
    // analyse-mode turn persisted, plus any snippets saved mid-run.
    void loadAttachments();
    void loadAnalysisCount();
    void loadSnippetCount();
  });

  eventSource.addEventListener('cleared', () => {
    session.value = null;
    output.value = '';
    followup.value = '';
  });

  eventSource.onerror = () => {
    /* auto-retry */
  };
}

function unsubscribe() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function loadAttachments() {
  try {
    const rows = await api.attachments.byTodo(props.todo.id);
    attachments.value = rows;
    // Default selection: everything selected BEFORE first start, so the user
    // just hits "Run Claude" and all current files are handed over. After the
    // first turn the selection is sticky — new uploads stay unchecked until
    // the user opts them in.
    if (!session.value) {
      selectedAttachmentIds.value = new Set(rows.map((a) => a.id));
    } else {
      // Drop IDs that no longer exist (e.g. attachment deleted mid-session).
      const existing = new Set(rows.map((a) => a.id));
      selectedAttachmentIds.value = new Set(
        [...selectedAttachmentIds.value].filter((id) => existing.has(id)),
      );
    }
  } catch {
    /* non-fatal — agent still works without attachments */
  }
}

function toggleAttachment(id: number) {
  const s = new Set(selectedAttachmentIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedAttachmentIds.value = s;
}

function selectAllAttachments() {
  selectedAttachmentIds.value = new Set(attachments.value.map((a) => a.id));
}
function clearAttachmentSelection() {
  selectedAttachmentIds.value = new Set();
}

const selectedCount = computed(() => selectedAttachmentIds.value.size);

async function loadAnalysisCount() {
  try {
    const rows = await api.analyses.byTodo(props.todo.id);
    analysisCount.value = rows.length;
    // Default on when analyses exist — freshly relevant context. Only seed the
    // default before the user interacts; once they toggle it we respect their choice.
    if (rows.length > 0 && !session.value) includeAnalyses.value = true;
    if (rows.length === 0) includeAnalyses.value = false;
  } catch {
    /* non-fatal */
  }
}

async function loadSnippetCount() {
  try {
    const rows = await api.snippets.byTodo(props.todo.id);
    snippetCount.value = rows.length;
    // Default on when snippets exist — they're usually reference material the
    // user wanted Claude to see. Respect explicit toggles after first interaction.
    if (rows.length > 0 && !session.value) includeSnippets.value = true;
    if (rows.length === 0) includeSnippets.value = false;
  } catch {
    /* non-fatal */
  }
}

async function loadGithubIntegration() {
  try {
    const rows = await api.integrations.list();
    githubIntegration.value = rows.find((i) => i.provider === 'github') ?? null;
  } catch {
    /* non-fatal — sandbox button will just stay disabled */
  }
}

onMounted(async () => {
  try {
    const settings = await api.settings.getAll();
    defaultCwd.value = (settings.defaultWorkingDirectory as string) ?? '';
  } catch { /* ignore */ }
  subscribe();
  await loadAttachments();
  await loadAnalysisCount();
  await loadSnippetCount();
  await loadGithubIntegration();
});

onUnmounted(unsubscribe);

watch(() => props.todo.id, () => {
  prompt.value = buildDefaultPrompt(props.todo);
  followup.value = '';
  output.value = '';
  session.value = null;
  error.value = null;
  attachments.value = [];
  selectedAttachmentIds.value = new Set();
  analysisCount.value = 0;
  includeAnalyses.value = false;
  snippetCount.value = 0;
  includeSnippets.value = false;
  prepromptDraft.value = props.todo.preprompt ?? '';
  prepromptOpen.value = false;
  savedPaths.value = [...(props.todo.saved_paths ?? [])];
  pickerOpen.value = false;
  unsubscribe();
  subscribe();
  void loadAttachments();
  void loadAnalysisCount();
  void loadSnippetCount();
});

// When the parent reloads the todo (e.g. after save in the detail view), pick
// up the freshly persisted saved_paths / preprompt without a full remount.
watch(() => props.todo.saved_paths, (v) => {
  savedPaths.value = [...(v ?? [])];
});
watch(() => props.todo.preprompt, (v) => {
  if (!prepromptOpen.value) prepromptDraft.value = v ?? '';
});

watch(active, (v) => emit('active', v));

async function run() {
  if (!canRun.value) return;
  error.value = null;
  try {
    output.value = '';
    const ids = [...selectedAttachmentIds.value];
    const res = await api.agent.start(props.todo.id, prompt.value, effectiveCwd.value, ids, 'work', includeAnalyses.value, includeSnippets.value);
    session.value = res.session;
    output.value = res.session.output ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function runAnalyse() {
  if (running.value || !effectiveCwd.value) return;
  error.value = null;
  try {
    output.value = '';
    const ids = [...selectedAttachmentIds.value];
    // Analyse mode ignores the user prompt — the preprompt is the instruction.
    // We still send a non-empty placeholder because the API requires prompt.min(1).
    const placeholder = `Analyse der Aufgabe "${props.todo.title}"`;
    const res = await api.agent.start(props.todo.id, placeholder, effectiveCwd.value, ids, 'analyse', false, includeSnippets.value);
    session.value = res.session;
    output.value = res.session.output ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function send() {
  if (!canSend.value) return;
  error.value = null;
  const msg = followup.value;
  followup.value = '';
  try {
    const ids = [...selectedAttachmentIds.value];
    const res = await api.agent.send(props.todo.id, msg, ids);
    session.value = res.session;
    output.value = res.session.output ?? output.value;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    followup.value = msg;
  }
}

async function stop() {
  try {
    const res = await api.agent.stop(props.todo.id);
    session.value = res.session;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function runSandbox() {
  if (!canSandbox.value || sandboxBusy.value) return;
  error.value = null;
  sandboxBusy.value = true;
  try {
    // 1) Idempotent: persist branch_name the first time the user clicks. The
    //    server would derive the same name, but carrying it on the todo gives
    //    the user a stable preview in the detail view from now on.
    if (!props.todo.branch_name || !props.todo.branch_name.trim()) {
      const derived = computeAgentBranchName(props.todo);
      try {
        await todosStore.update(props.todo.id, { branch_name: derived });
      } catch {
        /* non-fatal — server will derive the same value on start */
      }
    }
    // 2) Optimistic: mark queued so the button flips immediately.
    todosStore._updateLocal(props.todo.id, { sandbox_status: 'queued' });
    // 3) Kick off the run. Output lands on the shared SSE pipe via
    //    registerExternalSession — no extra subscription needed.
    output.value = '';
    const ids = [...selectedAttachmentIds.value];
    await api.sandbox.start(props.todo.id, {
      prompt: prompt.value,
      attachmentIds: ids,
      includeAnalyses: includeAnalyses.value,
      includeSnippets: includeSnippets.value,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    // Rollback the optimistic status — the run never actually entered the queue.
    todosStore._updateLocal(props.todo.id, { sandbox_status: 'idle' });
  } finally {
    sandboxBusy.value = false;
  }
}

async function stopSandbox() {
  if (!confirm('Laufende Sandbox wirklich beenden?')) return;
  error.value = null;
  sandboxBusy.value = true;
  try {
    await api.sandbox.stop(props.todo.id);
    // Let the SSE `end` event + fetchAll settle the final status — don't
    // optimistically flip to 'failed' here because the server may record
    // the stop as a partial push.
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    sandboxBusy.value = false;
  }
}

// Soft interrupt — aborts the running turn but keeps the session alive via
// `claude --resume`. After it returns the user can just type a new message
// and send — Claude picks up from the saved session state.
async function interruptTurn() {
  if (!running.value) return;
  error.value = null;
  try {
    const res = await api.agent.interrupt(props.todo.id);
    session.value = res.session;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// Nuclear kill — tree-terminates claude + every child process (MCP servers,
// bash sub-shells, model process). Use when Stop doesn't fully clean up.
async function killAll() {
  if (!confirm('Wirklich ALLE Prozesse killen (claude + MCP + Sub-Shells)?')) return;
  error.value = null;
  try {
    const res = await api.agent.kill(props.todo.id);
    session.value = res.session;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function clearSession() {
  try {
    await api.agent.clear(props.todo.id);
    session.value = null;
    output.value = '';
    followup.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function copyOutput() {
  navigator.clipboard.writeText(output.value).catch(() => {});
}

async function saveAsSnippet() {
  if (!output.value.trim()) return;
  await api.snippets.create(props.todo.id, {
    title: `Claude run (${new Date().toLocaleTimeString()})`,
    language: 'markdown',
    content: output.value,
  });
}

function onFollowupKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void send();
  }
}

// ─── Fuzzy path insertion ───────────────────────────────────────────────────
// The prompt textareas support an `@` trigger: typing `@` opens a fuzzy picker
// anchored at the caret. Typing characters after the `@` narrows the list;
// ↑/↓/Enter pick an entry, Esc aborts. The picker is also available via a
// button for users who don't want to remember the shortcut.

function openPickerForButton(target: 'prompt' | 'followup') {
  pickerTargetRef.value = target === 'prompt'
    ? promptTextareaRef.value
    : followupTextareaRef.value;
  pickerMode.value = 'button';
  pickerInitialQuery.value = '';
  inlineAtStart.value = -1;
  pickerOpen.value = true;
}

function closePicker() {
  pickerOpen.value = false;
  pickerMode.value = 'button';
  inlineAtStart.value = -1;
}

/**
 * Measure the pixel position of a given character offset within a textarea by
 * rendering a mirror div with identical styling. Rough but good enough for
 * positioning the floating picker near the `@` that triggered it. Returns
 * coordinates in viewport (fixed) space so the popover can use `position:fixed`.
 */
function measureCaret(ta: HTMLTextAreaElement, offset: number): { x: number; y: number } {
  const rect = ta.getBoundingClientRect();
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(ta);
  const props = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'lineHeight', 'letterSpacing', 'textTransform', 'whiteSpace', 'wordSpacing',
    'wordBreak', 'tabSize', 'textAlign',
  ] as const;
  for (const p of props) {
    mirror.style[p as 'width'] = style[p as 'width'];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = ta.value.substring(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const mRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const x = rect.left + (mRect.left - mirrorRect.left) - ta.scrollLeft;
  const y = rect.top + (mRect.top - mirrorRect.top) - ta.scrollTop + parseFloat(style.lineHeight || '18');
  document.body.removeChild(mirror);
  return { x, y };
}

/**
 * Shared handler for both prompt and followup textarea input. Detects an
 * in-progress `@token` at the caret and opens/updates the picker. If the
 * caret moves away from the `@` region, the picker closes.
 */
function handlePathTrigger(
  ta: HTMLTextAreaElement | null,
  which: 'prompt' | 'followup',
) {
  if (!ta) return;
  const pos = ta.selectionStart ?? 0;
  const value = ta.value;
  // Find the nearest `@` to the left of the caret, stopping at whitespace.
  let start = pos - 1;
  while (start >= 0) {
    const ch = value[start];
    if (ch === '@') break;
    if (ch === ' ' || ch === '\n' || ch === '\t') { start = -1; break; }
    start -= 1;
  }
  if (start < 0 || value[start] !== '@') {
    if (pickerMode.value === 'inline') closePicker();
    return;
  }
  // `@` must be at the start of the input or preceded by whitespace, else
  // it's probably part of an email or handle — don't hijack.
  const before = start === 0 ? '' : value[start - 1];
  if (before && !/\s/.test(before)) {
    if (pickerMode.value === 'inline') closePicker();
    return;
  }
  const token = value.slice(start + 1, pos);
  pickerTargetRef.value = ta;
  pickerMode.value = 'inline';
  pickerInitialQuery.value = token;
  inlineAtStart.value = start;
  const caret = measureCaret(ta, pos);
  pickerX.value = Math.max(8, Math.min(window.innerWidth - 580, caret.x));
  pickerY.value = Math.min(window.innerHeight - 380, caret.y + 4);
  pickerOpen.value = true;
  // Silence TS: `which` kept for future per-target behaviour; we currently
  // route both textareas through the same logic.
  void which;
}

function onPromptInput() {
  handlePathTrigger(promptTextareaRef.value, 'prompt');
}
function onFollowupInput() {
  handlePathTrigger(followupTextareaRef.value, 'followup');
}

function onPathSelected(path: string, type: 'file' | 'dir') {
  const ta = pickerTargetRef.value;
  const withAt = '@' + path;
  if (ta && pickerMode.value === 'inline' && inlineAtStart.value >= 0) {
    // Replace `@<query>` with `@<path>` in place.
    const before = ta.value.slice(0, inlineAtStart.value);
    const after = ta.value.slice(ta.selectionStart ?? inlineAtStart.value);
    const newValue = before + withAt + ' ' + after;
    writeTextareaValue(ta, newValue);
    const newCaret = (before + withAt + ' ').length;
    nextTick(() => {
      ta.setSelectionRange(newCaret, newCaret);
      ta.focus();
    });
  } else if (ta) {
    // Button mode: insert at current caret (or end if not focused).
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const after = ta.value.slice(ta.selectionEnd ?? pos);
    // Add a space-prefix if the previous character isn't whitespace, so
    // Claude parses the token cleanly.
    const needSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needSpace ? ' ' : '') + withAt + ' ';
    const newValue = before + insert + after;
    writeTextareaValue(ta, newValue);
    const newCaret = (before + insert).length;
    nextTick(() => {
      ta.setSelectionRange(newCaret, newCaret);
      ta.focus();
    });
  }
  void rememberPath(path);
  closePicker();
  void type;
}

/**
 * Write a new value to a textarea AND sync it to the Vue reactive ref bound
 * to it. Textareas use `v-model` which listens for `input` events — we
 * dispatch one so v-model picks up the programmatic change.
 */
function writeTextareaValue(ta: HTMLTextAreaElement, value: string) {
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const SAVED_PATHS_CAP = 20;

async function rememberPath(path: string) {
  // Move-to-front so the chip row shows the most recently used paths. Cap at
  // SAVED_PATHS_CAP so the chip row doesn't sprawl.
  const next = [path, ...savedPaths.value.filter((p) => p !== path)].slice(0, SAVED_PATHS_CAP);
  if (arrayEquals(next, savedPaths.value)) return;
  savedPaths.value = next;
  try {
    await api.todos.update(props.todo.id, { saved_paths: next });
  } catch {
    /* non-fatal — the in-memory list is still updated */
  }
}

async function forgetPath(path: string) {
  const next = savedPaths.value.filter((p) => p !== path);
  if (arrayEquals(next, savedPaths.value)) return;
  savedPaths.value = next;
  try {
    await api.todos.update(props.todo.id, { saved_paths: next });
  } catch { /* ignore */ }
}

function insertSavedPath(path: string) {
  const ta = running.value ? followupTextareaRef.value : promptTextareaRef.value;
  if (!ta) return;
  pickerTargetRef.value = ta;
  ta.focus();
  onPathSelected(path, 'file');
}

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Per-todo preprompt ────────────────────────────────────────────────────
async function savePreprompt() {
  prepromptBusy.value = true;
  try {
    const value = prepromptDraft.value.trim() ? prepromptDraft.value : null;
    await todosStore.update(props.todo.id, { preprompt: value });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    prepromptBusy.value = false;
  }
}

function resetPreprompt() {
  prepromptDraft.value = props.todo.preprompt ?? '';
}

async function clearPreprompt() {
  if (!confirm('Eigenen Preprompt löschen und auf globalen Standard zurücksetzen?')) return;
  prepromptBusy.value = true;
  try {
    await todosStore.update(props.todo.id, { preprompt: null });
    prepromptDraft.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    prepromptBusy.value = false;
  }
}

const statusBadge = computed(() => {
  if (!session.value) return null;
  if (session.value.status === 'running') {
    if (session.value.turnActive) return { text: '● denkt…', cls: 'status-running' };
    return { text: '● bereit', cls: 'status-ready' };
  }
  if (session.value.status === 'error') return { text: '● Fehler', cls: 'status-error' };
  return { text: `● exit ${session.value.exitCode ?? '?'}`, cls: 'status-exited' };
});
</script>

<template>
  <div class="claude-agent">
    <div class="row" style="align-items: baseline; justify-content: space-between; gap: 0.75rem;">
      <h3 style="margin: 0;">🤖 Claude Agent</h3>
      <div class="row" style="gap: 0.5rem; align-items: baseline;">
        <span v-if="turnCount > 1" class="shortcut-hint" style="font-size: 0.78rem; color: var(--fg-muted);">
          {{ turnCount }} Turns
        </span>
        <span v-if="statusBadge" class="agent-badge" :class="statusBadge.cls">{{ statusBadge.text }}</span>
        <span v-else class="shortcut-hint" style="color: var(--fg-muted); font-size: 0.8rem;">
          Spawnt <kbd>claude -p …</kbd> im Arbeitsverzeichnis
        </span>
      </div>
    </div>

    <div v-if="!effectiveCwd" class="error-banner" style="margin-top: 0.75rem;">
      Kein Arbeitsverzeichnis gesetzt — oben am Todo hinterlegen oder einen Standard speichern.
    </div>

    <div v-if="attachments.length > 0" class="agent-attachments" style="margin-top: 0.75rem;">
      <div class="row" style="align-items: baseline; justify-content: space-between; gap: 0.5rem;">
        <span style="font-size: 0.85rem;">
          📎 Anhänge für Claude
          <span style="color: var(--fg-muted); font-weight: normal;">
            ({{ selectedCount }}/{{ attachments.length }} ausgewählt)
          </span>
        </span>
        <div class="row" style="gap: 0.4rem;">
          <button class="ghost" type="button" @click="selectAllAttachments" :disabled="selectedCount === attachments.length" style="font-size: 0.75rem;">Alle</button>
          <button class="ghost" type="button" @click="clearAttachmentSelection" :disabled="selectedCount === 0" style="font-size: 0.75rem;">Keine</button>
        </div>
      </div>
      <ul class="agent-attachment-list" style="list-style: none; margin: 0.4rem 0 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem;">
        <li
          v-for="a in attachments"
          :key="a.id"
          class="agent-attachment-item"
          :class="{ selected: selectedAttachmentIds.has(a.id) }"
        >
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.25rem 0.4rem; border-radius: 4px;">
            <input
              type="checkbox"
              :checked="selectedAttachmentIds.has(a.id)"
              @change="toggleAttachment(a.id)"
            />
            <span aria-hidden="true">{{ ATTACHMENT_KIND_ICON[a.kind] ?? '📎' }}</span>
            <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 0.82rem;">{{ a.filename }}</span>
            <span style="color: var(--fg-muted); font-size: 0.72rem; font-family: var(--font-mono);">{{ a.mime || '—' }}</span>
          </label>
        </li>
      </ul>
    </div>

    <label
      v-if="analysisCount > 0 && !running && turnCount === 0"
      class="row"
      style="margin-top: 0.75rem; align-items: baseline; gap: 0.5rem; cursor: pointer;"
    >
      <input type="checkbox" v-model="includeAnalyses" />
      <span style="font-size: 0.9rem;">
        🔍 Bisherige Analysen einbeziehen
        <span style="color: var(--fg-muted); font-weight: normal; font-size: 0.8rem;">
          ({{ analysisCount }} gespeichert — werden als Kontext in den Preprompt geladen)
        </span>
      </span>
    </label>

    <label
      v-if="snippetCount > 0 && !running && turnCount === 0"
      class="row"
      style="margin-top: 0.5rem; align-items: baseline; gap: 0.5rem; cursor: pointer;"
    >
      <input type="checkbox" v-model="includeSnippets" />
      <span style="font-size: 0.9rem;">
        💾 Snippets einbeziehen
        <span style="color: var(--fg-muted); font-weight: normal; font-size: 0.8rem;">
          ({{ snippetCount }} gespeichert — werden als Code-Fences in den Preprompt geladen)
        </span>
      </span>
    </label>

    <!-- Per-todo preprompt override (collapsed by default). -->
    <div v-if="!running && turnCount === 0" class="preprompt-section" style="margin-top: 0.75rem;">
      <button
        type="button"
        class="ghost"
        style="width: 100%; text-align: left; font-size: 0.85rem;"
        @click="prepromptOpen = !prepromptOpen"
      >
        <span v-if="prepromptOpen">▾</span><span v-else>▸</span>
        🧬 Preprompt
        <span v-if="todo.preprompt" style="color: var(--accent-2); font-weight: normal; font-size: 0.75rem;">
          (eigener aktiv)
        </span>
        <span v-else style="color: var(--fg-muted); font-weight: normal; font-size: 0.75rem;">
          (global)
        </span>
      </button>
      <div v-if="prepromptOpen" style="margin-top: 0.4rem;">
        <p style="color: var(--fg-muted); font-size: 0.75rem; margin: 0 0 0.3rem 0;">
          Leer lassen, um den globalen Preprompt (Einstellungen → Agent) zu verwenden. Platzhalter:
          <code v-pre>{{todo_id}}</code>, <code v-pre>{{todo_title}}</code>, <code v-pre>{{todo_description}}</code>,
          <code v-pre>{{subtasks}}</code>, <code v-pre>{{user_prompt}}</code>.
        </p>
        <textarea
          v-model="prepromptDraft"
          rows="8"
          spellcheck="false"
          style="font-family: var(--font-mono); font-size: 0.82rem;"
          placeholder="Eigene Vorlage für dieses Todo…"
        />
        <div class="row" style="margin-top: 0.3rem; gap: 0.3rem; flex-wrap: wrap;">
          <button class="primary" :disabled="prepromptBusy || !prepromptDirty" @click="savePreprompt">💾 Speichern</button>
          <button class="ghost" :disabled="prepromptBusy || !prepromptDirty" @click="resetPreprompt">↺ Zurücksetzen</button>
          <button
            v-if="todo.preprompt"
            class="danger"
            :disabled="prepromptBusy"
            @click="clearPreprompt"
            title="Eigenen Preprompt löschen und globalen wieder verwenden"
          >✕ Auf global</button>
        </div>
      </div>
    </div>

    <label v-if="!running && turnCount === 0" class="stacked" style="margin-top: 0.75rem;">
      <span class="row" style="justify-content: space-between; align-items: baseline;">
        <span>Erste Nachricht</span>
        <span class="shortcut-hint" style="font-size: 0.72rem; color: var(--fg-muted);">
          <code>@</code> öffnet Pfad-Picker
        </span>
      </span>
      <textarea
        ref="promptTextareaRef"
        v-model="prompt"
        rows="6"
        spellcheck="false"
        @input="onPromptInput"
        @click="onPromptInput"
        @keyup="onPromptInput"
      />
    </label>

    <!-- Saved paths quick-chip row + picker button. Always shown before the first
         turn so the user can prime the prompt; hidden while running since the
         follow-up textarea has its own picker. -->
    <div v-if="!running && turnCount === 0" class="row saved-paths" style="margin-top: 0.35rem; gap: 0.3rem; flex-wrap: wrap; align-items: center;">
      <button
        class="ghost"
        type="button"
        style="font-size: 0.78rem;"
        :disabled="!effectiveCwd"
        @click="openPickerForButton('prompt')"
      >📂 Pfad einfügen</button>
      <span v-if="savedPaths.length > 0" style="color: var(--fg-muted); font-size: 0.72rem;">Zuletzt:</span>
      <button
        v-for="p in savedPaths"
        :key="p"
        type="button"
        class="ghost saved-path-chip"
        :title="p"
        @click.exact="insertSavedPath(p)"
        @click.right.prevent="forgetPath(p)"
      >@{{ p }}</button>
      <PathPicker
        v-if="!running && turnCount === 0"
        :root="effectiveCwd"
        :open="pickerOpen && pickerMode === 'button'"
        :initial-query="pickerInitialQuery"
        anchor="inline"
        @select="onPathSelected"
        @close="closePicker"
      />
    </div>

    <div class="row" style="margin-top: 0.75rem; gap: 0.4rem; flex-wrap: wrap;">
      <button v-if="!running && turnCount === 0" class="primary" :disabled="!canRun" @click="run">
        ▶ Run Claude
      </button>
      <button
        v-if="!running && turnCount === 0 && !sandboxRunning"
        class="primary"
        :disabled="!canSandbox || sandboxBusy"
        :title="sandboxTooltip || 'Sandbox-Lauf auf lp03 starten (pusht Draft-PR bei Erfolg)'"
        @click="runSandbox"
      >
        🐳 In Sandbox starten
      </button>
      <button
        v-if="sandboxRunning"
        class="warn"
        :disabled="sandboxBusy"
        title="Laufende Sandbox stoppen"
        @click="stopSandbox"
      >■ Sandbox stoppen</button>
      <button
        v-if="!running && turnCount === 0"
        class="ghost"
        :disabled="running || !effectiveCwd"
        @click="runAnalyse"
        title="Analyse-Modus: Claude liest die Aufgabe, schreibt eine Analyse und schlägt Subtasks vor. Setzt nichts um."
      >
        🔍 Analyse starten
      </button>
      <button
        v-if="running && turnActive"
        class="warn"
        @click="interruptTurn"
        title="Aktuellen Turn unterbrechen — Session bleibt aktiv, du kannst neue Anweisung senden (via claude --resume)"
      >⏸ Interrupt</button>
      <button
        v-if="running"
        class="ghost"
        @click="stop"
        title="Session beenden (Prozess sauber killen, Session-State verworfen)"
      >■ Stop</button>
      <button
        v-if="running"
        class="danger"
        @click="killAll"
        title="Alles killen: claude + MCP-Server + Sub-Shells (Tree-Kill)"
      >💀 Kill</button>
      <button class="ghost" :disabled="!output" @click="copyOutput">📋 Copy</button>
      <button class="ghost" :disabled="!output || turnActive" @click="saveAsSnippet">💾 Als Snippet</button>
      <button class="ghost" :disabled="!session" @click="clearSession" title="Session verwerfen und neu starten">✕ Clear</button>
    </div>

    <div v-if="error" class="error-banner" style="margin-top: 0.5rem;">{{ error }}</div>

    <pre ref="outputEl" class="agent-output" v-if="output || running">{{ output || '(warte auf Output…)' }}</pre>

    <div v-if="running" class="claude-chat" style="margin-top: 0.75rem;">
      <label class="stacked">
        <span>
          Nachricht an Claude
          <span style="color: var(--fg-muted); font-weight: normal;">
            (Ctrl+Enter sendet — <code>TERMINATE</code> beendet die Session)
          </span>
        </span>
        <textarea
          ref="followupTextareaRef"
          v-model="followup"
          rows="3"
          spellcheck="false"
          :disabled="turnActive"
          placeholder="Antworte, stelle Rückfrage, gib nächste Anweisung… oder TERMINATE"
          @keydown="onFollowupKeydown"
          @input="onFollowupInput"
          @click="onFollowupInput"
          @keyup="onFollowupInput"
        />
      </label>
      <div class="row" style="margin-top: 0.4rem; gap: 0.4rem; align-items: baseline; flex-wrap: wrap;">
        <button class="primary" :disabled="!canSend" @click="send">
          ➤ Senden
        </button>
        <button
          class="ghost"
          type="button"
          style="font-size: 0.78rem;"
          :disabled="!effectiveCwd || turnActive"
          @click="openPickerForButton('followup')"
        >📂 Pfad einfügen</button>
        <button
          v-for="p in savedPaths"
          :key="p"
          type="button"
          class="ghost saved-path-chip"
          :title="p"
          @click.exact="insertSavedPath(p)"
          @click.right.prevent="forgetPath(p)"
        >@{{ p }}</button>
        <span v-if="session?.sessionId" class="shortcut-hint" style="color: var(--fg-muted); font-size: 0.75rem;">
          Session: <code>{{ session.sessionId.slice(0, 8) }}…</code>
        </span>
      </div>
      <PathPicker
        :root="effectiveCwd"
        :open="pickerOpen && pickerMode === 'button' && pickerTargetRef === followupTextareaRef"
        :initial-query="pickerInitialQuery"
        anchor="inline"
        @select="onPathSelected"
        @close="closePicker"
      />
    </div>

    <!-- Floating picker for inline `@` trigger — spans viewport-absolute, shown
         for both prompt and follow-up textareas. -->
    <PathPicker
      :root="effectiveCwd"
      :open="pickerOpen && pickerMode === 'inline'"
      :initial-query="pickerInitialQuery"
      anchor="floating"
      :x="pickerX"
      :y="pickerY"
      @select="onPathSelected"
      @close="closePicker"
    />
  </div>
</template>

<style scoped>
.saved-path-chip {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  padding: 0.15rem 0.4rem;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preprompt-section {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 0.25rem 0.4rem;
}
</style>
