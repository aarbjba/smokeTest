import { z } from 'zod';

export const TodoStatus = z.enum(['todo', 'in_progress', 'test', 'done']);

export const CreateTodoSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional().default(''),
  status: TodoStatus.optional().default('todo'),
  priority: z.number().int().min(1).max(4).optional().default(2),
  tags: z.array(z.string().max(50)).optional().default([]),
  due_date: z.string().datetime().nullable().optional(),
  working_directory: z.string().max(1000).nullable().optional(),
});

export const UpdateTodoSchema = CreateTodoSchema.partial();

export const AgentRunSchema = z.object({
  prompt: z.string().min(1).max(50_000),
  cwd: z.string().min(1).max(1000),
  todoId: z.number().int().positive().nullable().optional(),
});

export const SnippetSchema = z.object({
  title: z.string().max(200).optional().default(''),
  language: z.string().max(30).optional().default('markdown'),
  content: z.string().max(100_000).optional().default(''),
  position: z.number().int().optional().default(0),
});

export const CreateSubtaskSchema = z.object({
  todo_id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  suggested: z.boolean().optional().default(false),
});

export const UpdateSubtaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  done: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  position: z.number().int().min(0).optional(),
  suggested: z.boolean().optional(),
});

export const CreateAnalysisSchema = z.object({
  todo_id: z.number().int().positive(),
  content: z.string().min(1).max(100_000),
});

export const ReorderSubtasksSchema = z.object({
  todo_id: z.number().int().positive(),
  ordered_ids: z.array(z.number().int().positive()),
});

export const RecurrenceFrequency = z.enum(['daily', 'weekdays', 'weekly', 'monthly']);

export const CreateRecurrenceSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional().default(''),
  tags: z.array(z.string().max(50)).optional().default([]),
  priority: z.number().int().min(1).max(4).optional().default(2),
  frequency: RecurrenceFrequency,
  time_of_day: z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM').optional().default('08:00'),
  enabled: z.boolean().optional().default(true),
});

export const UpdateRecurrenceSchema = CreateRecurrenceSchema.partial();

export const BulkTodoSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  // delete = soft delete (move to Papierkorb), restore = unmark, purge = permanent delete
  action: z.enum(['move', 'tag', 'delete', 'restore', 'purge']),
  payload: z
    .object({
      status: z.enum(['todo', 'in_progress', 'test', 'done']).optional(),
      tag: z.string().min(1).max(50).optional(),
    })
    .optional()
    .default({}),
});

export const PomodoroStartSchema = z.object({
  todo_id: z.number().int().positive().nullable().optional(),
  mode: z.enum(['work', 'break']),
});

export const PomodoroEndSchema = z.object({
  duration_seconds: z.number().int().min(0),
  completed: z.boolean(),
});

// A single MCP server config entry attached to a todo. Shape matches what
// Claude CLI's --mcp-config expects (minus the outer mcpServers wrapper).
export const McpServerSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'alphanumeric/underscore/hyphen only'),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(32).optional().default([]),
  env: z.record(z.string().max(2000)).optional().default({}),
});

export const McpServersSchema = z.array(McpServerSchema).max(20);

export const GitHubConfigSchema = z.object({
  token: z.string().min(10).optional(),
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name')).default([]),
});

export const JiraConfigSchema = z.object({
  token: z.string().min(10).optional(),
  baseUrl: z.string().url().optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  jql: z.string().max(2000).default(''),
});

export const RepoMappingSource = z.enum(['github', 'jira']);

// `key` is provider-specific: `owner/name` for GitHub (matches the format stored in
// GitHubConfig.repos), Jira project key (e.g. `AAR`) for Jira — parsed from issue keys
// like `AAR-1163`.
export const CreateRepoMappingSchema = z.object({
  source: RepoMappingSource,
  key: z.string().min(1).max(200),
  local_path: z.string().min(1).max(1000),
});

export const UpdateRepoMappingSchema = CreateRepoMappingSchema.partial();

// Automation queue. A todo is "queued" when queue_position is non-NULL;
// the queue runner picks the lowest position with status='todo' and spawns
// a Claude session the same way the Details-page Start button does.
export const EnqueueSchema = z.object({
  prompt: z.string().max(50_000).optional().default(''),
  attachmentIds: z.array(z.number().int().positive()).max(100).optional().default([]),
});

export const UpdateQueueItemSchema = z.object({
  prompt: z.string().max(50_000).optional(),
  attachmentIds: z.array(z.number().int().positive()).max(100).optional(),
});

export const ReorderQueueSchema = z.object({
  ordered_ids: z.array(z.number().int().positive()),
});
