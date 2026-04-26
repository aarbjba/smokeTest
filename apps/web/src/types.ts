export type TodoStatus = 'todo' | 'in_progress' | 'test' | 'done' | 'pending';
export type TodoSource = 'local' | 'github' | 'jira';
export type TaskType = 'feature' | 'bug' | 'chore' | 'customer' | 'research' | 'other';
export type TaskTypeFilter = 'all' | TaskType;

export interface Todo {
  id: number;
  title: string;
  description: string;
  status: TodoStatus;
  priority: 1 | 2 | 3 | 4;
  tags: string[];
  due_date: string | null;
  source: TodoSource;
  source_ref: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
  last_writeback_error: string | null;
  last_writeback_at: string | null;
  position?: number;
  working_directory?: string | null;
  task_type?: TaskType;
  subtask_total?: number;
  subtask_done?: number;
  subtask_suggested?: number;
  // Set to an ISO/SQLite timestamp when the todo is in the Papierkorb; NULL on active todos.
  deleted_at?: string | null;
  // Automation queue ("Warteschlange") — when queue_position != null, the todo
  // is waiting to be picked up by the runner. queue_prompt is the editable user
  // prompt, queue_attachment_ids a JSON-ish array (already hydrated by server).
  queue_position?: number | null;
  queue_prompt?: string | null;
  queue_attachment_ids?: number[] | string | null;
  // Per-todo preprompt override. NULL = fall back to global settings.
  preprompt?: string | null;
  // Paths the user has recently inserted with @-syntax in agent prompts.
  // Relative to working_directory. Frontend keeps them in insertion order
  // (most recent last) and caps at ~20 for the quick-chip UI.
  saved_paths?: string[] | null;
  // ─── Remote-sandbox columns (M2) ─────────────────────────────────────────
  // Overrides for the sandbox run plus its current lifecycle state and the
  // draft PR URL once the run finishes. Columns are optional because they
  // only exist after the M2 migration and are always nullable server-side.
  branch_name?: string | null;
  base_branch?: string | null;
  test_command?: string | null;
  sandbox_status?: SandboxStatus | null;
  sandbox_pr_url?: string | null;
  sandbox_timeout_min?: number | null;
  sandbox_max_turns?: number | null;
  // User-assigned target repo (`owner/name`) for sandboxing locally-created
  // todos that don't have a GitHub source_ref. Wins over source_ref in
  // resolveRepoUrl.
  sandbox_repo?: string | null;
  // Per-todo backend override. NULL falls back to settings.sandbox.default_backend.
  sandbox_backend?: SandboxBackend | null;
}

// Backend selector. Source of truth for the runner is in
// apps/api/src/services/sandbox-runner.ts (SandboxBackend); kept in sync
// here by hand because no shared-types package exists. Adding a new backend
// requires updating this enum, the Zod enum (schemas.ts: SandboxBackendEnum),
// the dispatcher table in sandbox-runner.ts, and SANDBOX_BACKEND_LABELS below.
export type SandboxBackend = 'docker-lp03' | 'aws-microvm';

export const SANDBOX_BACKEND_LABELS: Record<SandboxBackend, string> = {
  'docker-lp03': '🏭 Docker (lp03)',
  'aws-microvm': '☁️ AWS microVM',
};

export type SandboxStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'pushed'
  | 'failed'
  | 'no_test';

export interface SandboxRun {
  todoId: number;
  runId: string;
  containerName: string;
  startedAt: number;
  state: 'running' | 'queued';
  branch: string;
  baseBranch: string;
  timeoutMin: number;
  backend: SandboxBackend;
}

export const SANDBOX_STATUS_LABELS: Record<SandboxStatus, string> = {
  idle: 'Leerlauf',
  queued: 'In Warteschlange',
  running: 'Läuft…',
  pushed: 'Gepusht',
  failed: 'Fehlgeschlagen',
  no_test: 'Keine Tests',
};

// Maps a sandbox status to a CSS custom property (existing palette). The
// chip component consumes these via `color: var(…)` + `border-color: var(…)`.
// `--warning` exists across all themes; `--warn` does not (the button class
// `.warn` is the name, but themes define `--warning`).
export const SANDBOX_STATUS_COLOR: Record<SandboxStatus, string> = {
  idle: '--fg-muted',
  queued: '--accent-2',
  running: '--accent',
  pushed: '--success',
  failed: '--danger',
  no_test: '--warning',
};

export interface QueueItem {
  todo_id: number;
  title: string;
  status: TodoStatus;
  working_directory: string | null;
  queue_position: number;
  queue_prompt: string;
  queue_attachment_ids: number[];
}

export interface Subtask {
  id: number;
  todo_id: number;
  title: string;
  description: string;
  done: 0 | 1;
  position: number;
  created_at: string;
  suggested: 0 | 1;
  // FK to a real todo. When non-null the subtask's `done` flag is ignored —
  // completion follows the linked todo's status (mirrored in `linked_todo`).
  linked_todo_id: number | null;
  linked_todo: { id: number; title: string; status: TodoStatus } | null;
}

// Object form accepted by POST /todos when creating a todo with subtasks
// in the same payload. The Zod schema also accepts plain strings for legacy
// callers (AI reformulation), but the editor sends this richer shape.
export interface SubtaskDraft {
  title: string;
  description?: string;
  linked_todo_id?: number | null;
}

export interface Analysis {
  id: number;
  todo_id: number;
  content: string;
  created_at: string;
}

export interface Snippet {
  id: number;
  todo_id: number;
  title: string;
  language: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface PomodoroSession {
  id: number;
  todo_id: number | null;
  mode: 'work' | 'break';
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  completed: 0 | 1;
}

export interface Integration {
  provider: 'github' | 'jira';
  enabled: boolean;
  hasToken: boolean;
  tokenMasked: string;
  config: GitHubConfig | JiraConfig;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export interface GitHubConfig {
  repos: string[];
}

export interface JiraConfig {
  baseUrl: string;
  email: string;
  jql: string;
}

export type RepoMappingSource = 'github' | 'jira';

export interface RepoMapping {
  id: number;
  source: RepoMappingSource;
  key: string;
  local_path: string;
  created_at: string;
  updated_at: string;
}

export type ThemeName = 'workshop' | 'dark' | 'light' | 'terminal' | 'matrix';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'office' | 'other';

export interface Attachment {
  id: number;
  todo_id: number;
  filename: string;
  storage_name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  created_at: string;
}

export type SourceFilter = 'all' | 'local' | 'github' | 'jira';

export type RecurrenceFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Recurrence {
  id: number;
  title: string;
  description: string;
  tags: string[];
  priority: 1 | 2 | 3 | 4;
  frequency: RecurrenceFrequency;
  time_of_day: string;
  next_fire_at: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  daily: 'Täglich',
  weekdays: 'Werktags (Mo–Fr)',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
};

export const STATUS_LABELS: Record<TodoStatus, string> = {
  todo: 'Werkbank',
  in_progress: 'Unter Hammer',
  test: 'Prüfstand',
  done: 'Ablage',
  pending: 'Pendliste',
};

export const STATUS_ICONS: Record<TodoStatus, string> = {
  todo: '🔧',
  in_progress: '🔨',
  test: '🧪',
  done: '✅',
  pending: '📥',
};

// Statuses that appear as board columns. `pending` is intentionally excluded —
// Pendliste-todos live in /pending, not the board.
export const BOARD_STATUSES: TodoStatus[] = ['todo', 'in_progress', 'test', 'done'];

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'Dringend',
  2: 'Normal',
  3: 'Niedrig',
  4: 'Irgendwann',
};

export const SOURCE_LABEL: Record<TodoSource, string> = {
  local: 'Eigen',
  github: 'GitHub',
  jira: 'Jira',
};

export const SOURCE_ICON: Record<TodoSource, string> = {
  local: '✏️',
  github: '⛓',
  jira: '📋',
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  chore: 'Wartung',
  customer: 'Kunde',
  research: 'Recherche',
  other: 'Sonstiges',
};

export const TASK_TYPE_ICONS: Record<TaskType, string> = {
  feature: '✨',
  bug: '🐛',
  chore: '🧹',
  customer: '👤',
  research: '🔍',
  other: '📌',
};

export const TASK_TYPES: TaskType[] = ['feature', 'bug', 'chore', 'customer', 'research', 'other'];

// MIME type for our internal card-drag sentinel so board-level drop handlers
// can distinguish in-app card reorder from external file drops.
export const TODO_DRAG_TYPE = 'application/x-werkbank-todo';

// ─── Swarm types ─────────────────────────────────────────────────────────────

export type SwarmRunStatus = 'running' | 'done' | 'error' | 'aborted';

export interface CoordinatorConfig {
  id: string;
  role: string;
  systemPromptTemplate: string;
  model: 'opus' | 'sonnet' | 'haiku';
  toolPermissions: string[];
  maxTurns?: number;
  firstPrompt?: string;
}

export type SwarmTopology =
  | 'concurrent'
  | 'debate-with-judge'
  | 'mixture-of-agents'
  | 'majority-voting'
  | 'sequential'
  | 'hierarchical'
  | 'planner-worker';

export interface SwarmTopologyOptions {
  debateRounds?: number;
  debatePresetAgents?: boolean;
  moaLayers?: number;
  moaPresetAggregator?: boolean;
  majorityLoops?: number;
  majorityPresetConsensus?: boolean;
  sequentialDriftDetection?: boolean;
  maxDirectorLoops?: number;
  hierarchicalPresetAgents?: boolean;
  plannerWorkerPresetAgents?: boolean;
}

export interface SwarmConfig {
  goal: string;
  coordinators: CoordinatorConfig[];
  topology?: SwarmTopology;
  topologyOptions?: SwarmTopologyOptions;
  globalTokenLimit?: number;
  timeoutMs?: number;
}

export interface SwarmConfigMeta {
  id: number;
  name: string;
  goal: string;
  created_at: string;
  updated_at: string;
}

export interface SwarmRunMeta {
  id: string;
  goal: string;
  status: SwarmRunStatus;
  coordinator_count: number;
  total_tokens: number;
  started_at: number;
  ended_at: number | null;
  error_message: string | null;
}

export interface SwarmAgentMeta {
  id: string;
  run_id: string;
  role: string;
  model: string;
  status: string;
  turn_count: number;
  started_at: number;
  ended_at: number | null;
  error_message: string | null;
}

export interface SwarmTokenSummary {
  agent_id: string;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
}

export interface SwarmBlackboardEntry {
  key: string;
  value: string;
  version: number;
  written_by: string;
  written_at: number;
}

export const SWARM_RUN_STATUS_LABELS: Record<SwarmRunStatus, string> = {
  running: 'Läuft',
  done: 'Fertig',
  error: 'Fehler',
  aborted: 'Abgebrochen',
};

export const SWARM_RUN_STATUS_COLOR: Record<SwarmRunStatus, string> = {
  running: '--accent',
  done: '--success',
  error: '--danger',
  aborted: '--fg-muted',
};

// Per-todo MCP server config — matches Claude CLI --mcp-config shape,
// minus the outer "mcpServers" wrapper. Stored as JSON on todos.mcp_servers.
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ─── Swarm template library ───────────────────────────────────────────────────

export interface CoordinatorTemplate {
  id: number;
  name: string;
  description: string;
  role: string;
  model: 'opus' | 'sonnet' | 'haiku';
  max_turns: number;
  system_prompt_template: string;
  tool_permissions: Record<string, boolean>;
  created_at: string;
  updated_at: string;
  usage_count: number;
}

export interface SubagentTemplate {
  id: number;
  name: string;
  description: string;
  prompt: string;
  model: 'opus' | 'sonnet' | 'haiku';
  tools: string[];
  output_schema: string | null;
  created_at: string;
  updated_at: string;
  usage_count: number;
}
