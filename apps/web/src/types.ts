export type TodoStatus = 'todo' | 'in_progress' | 'test' | 'done';
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
}

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
  done: 0 | 1;
  position: number;
  created_at: string;
  suggested: 0 | 1;
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
};

export const STATUS_ICONS: Record<TodoStatus, string> = {
  todo: '🔧',
  in_progress: '🔨',
  test: '🧪',
  done: '✅',
};

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

// Per-todo MCP server config — matches Claude CLI --mcp-config shape,
// minus the outer "mcpServers" wrapper. Stored as JSON on todos.mcp_servers.
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
