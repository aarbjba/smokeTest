import type { Todo, Snippet, Subtask, SubtaskDraft, PomodoroSession, Integration, TodoStatus, Attachment, Recurrence, RecurrenceFrequency, McpServerConfig, RepoMapping, RepoMappingSource, Analysis, QueueItem, SandboxRun } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let msg = resp.statusText;
    try { msg = JSON.parse(body).error ?? msg; } catch { /* ignore */ }
    throw new Error(`${resp.status}: ${msg}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

async function requestForm<T>(path: string, form: FormData): Promise<T> {
  // Do NOT set Content-Type — fetch will add the multipart boundary.
  const resp = await fetch(`/api${path}`, { method: 'POST', body: form });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let msg = resp.statusText;
    try { msg = JSON.parse(body).error ?? msg; } catch { /* ignore */ }
    throw new Error(`${resp.status}: ${msg}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const api = {
  todos: {
    list: (params?: { status?: TodoStatus; q?: string }) => {
      const sp = new URLSearchParams();
      if (params?.status) sp.set('status', params.status);
      if (params?.q) sp.set('q', params.q);
      const qs = sp.toString();
      return request<Todo[]>(`/todos${qs ? `?${qs}` : ''}`);
    },
    get:    (id: number) => request<Todo>(`/todos/${id}`),
    create: (data: Partial<Todo> & { subtasks?: Array<string | SubtaskDraft> }) =>
      request<Todo>(`/todos`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Todo>) => request<Todo>(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    // Soft delete by default (moves to Papierkorb). Pass { permanent: true } for hard delete.
    remove: (id: number, opts: { permanent?: boolean } = {}) =>
      request<void>(`/todos/${id}${opts.permanent ? '?permanent=1' : ''}`, { method: 'DELETE' }),
    restore: (id: number) =>
      request<Todo>(`/todos/${id}/restore`, { method: 'POST' }),
    listTrash: () => request<Todo[]>(`/todos/trash`),
    emptyTrash: () => request<{ ok: true; purged: number }>(`/todos/trash`, { method: 'DELETE' }),
    getMcp: (id: number) =>
      request<{ mcp_servers: McpServerConfig[] }>(`/todos/${id}/mcp`),
    setMcp: (id: number, servers: McpServerConfig[]) =>
      request<{ mcp_servers: McpServerConfig[] }>(`/todos/${id}/mcp`, {
        method: 'PUT',
        body: JSON.stringify({ mcp_servers: servers }),
      }),
    reorder: (status: TodoStatus, orderedIds: number[]) =>
      request<{ ok: true; count: number }>(`/todos/reorder`, {
        method: 'POST',
        body: JSON.stringify({ status, orderedIds }),
      }),
    bulk: (
      ids: number[],
      action: 'move' | 'tag' | 'delete' | 'restore' | 'purge',
      payload: { status?: TodoStatus; tag?: string } = {},
    ) =>
      request<{ ok: true; affected: number; total: number }>(`/todos/bulk`, {
        method: 'POST',
        body: JSON.stringify({ ids, action, payload }),
      }),
  },
  snippets: {
    byTodo: (todoId: number) => request<Snippet[]>(`/snippets/by-todo/${todoId}`),
    create: (todoId: number, data: Partial<Snippet>) => request<Snippet>(`/snippets/by-todo/${todoId}`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: Partial<Snippet>) => request<Snippet>(`/snippets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: number) => request<void>(`/snippets/${id}`, { method: 'DELETE' }),
  },
  subtasks: {
    byTodo: (todoId: number) => request<Subtask[]>(`/subtasks/by-todo/${todoId}`),
    create: (
      todoId: number,
      title: string,
      extras: { description?: string; linked_todo_id?: number | null } = {},
    ) =>
      request<Subtask>(`/subtasks`, {
        method: 'POST',
        body: JSON.stringify({
          todo_id: todoId,
          title,
          ...(extras.description !== undefined ? { description: extras.description } : {}),
          ...(extras.linked_todo_id !== undefined ? { linked_todo_id: extras.linked_todo_id } : {}),
        }),
      }),
    update: (
      id: number,
      patch: {
        title?: string;
        description?: string;
        done?: boolean | 0 | 1;
        position?: number;
        suggested?: boolean;
        // null clears the link, omit leaves it untouched.
        linked_todo_id?: number | null;
      },
    ) =>
      request<Subtask>(`/subtasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: number) => request<void>(`/subtasks/${id}`, { method: 'DELETE' }),
    // Accept an analyse-mode suggestion: clears the suggested flag, subtask becomes real work.
    accept: (id: number) =>
      request<Subtask>(`/subtasks/${id}`, { method: 'PATCH', body: JSON.stringify({ suggested: false }) }),
    reorder: (todoId: number, orderedIds: number[]) =>
      request<{ ok: true; count: number }>(`/subtasks/reorder`, {
        method: 'POST',
        body: JSON.stringify({ todo_id: todoId, ordered_ids: orderedIds }),
      }),
  },
  analyses: {
    byTodo: (todoId: number) => request<Analysis[]>(`/analyses/by-todo/${todoId}`),
    remove: (id: number) => request<void>(`/analyses/${id}`, { method: 'DELETE' }),
  },
  pomodoro: {
    start: (mode: 'work' | 'break', todoId?: number | null) =>
      request<PomodoroSession>(`/pomodoro/start`, { method: 'POST', body: JSON.stringify({ mode, todo_id: todoId ?? null }) }),
    end: (id: number, durationSeconds: number, completed: boolean) =>
      request<PomodoroSession>(`/pomodoro/${id}/end`, { method: 'POST', body: JSON.stringify({ duration_seconds: durationSeconds, completed }) }),
    byTodo: (todoId: number) => request<PomodoroSession[]>(`/pomodoro/by-todo/${todoId}`),
    stats: () => request<{ today: { sessions: number; seconds: number }; total: { sessions: number; seconds: number } }>(`/pomodoro/stats`),
  },
  integrations: {
    list: () => request<Integration[]>(`/integrations`),
    saveGithub: (data: { token?: string; repos: string[] }) =>
      request<Integration>(`/integrations/github`, { method: 'PUT', body: JSON.stringify(data) }),
    saveJira: (data: { token?: string; baseUrl?: string; email?: string; jql?: string }) =>
      request<Integration>(`/integrations/jira`, { method: 'PUT', body: JSON.stringify(data) }),
    disconnect: (provider: 'github' | 'jira') =>
      request<void>(`/integrations/${provider}`, { method: 'DELETE' }),
    syncGithub: () => request<{ imported: number; updated: number; repos: string[] }>(`/integrations/github/sync`, { method: 'POST' }),
    syncJira: () => request<{ imported: number; updated: number; total: number; pages: number }>(`/integrations/jira/sync`, { method: 'POST' }),
  },
  attachments: {
    byTodo: (todoId: number) => request<Attachment[]>(`/attachments/by-todo/${todoId}`),
    upload: (todoId: number, files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      return requestForm<Attachment[]>(`/attachments/by-todo/${todoId}`, fd);
    },
    remove: (id: number) => request<void>(`/attachments/${id}`, { method: 'DELETE' }),
    previewUrl:  (id: number) => `/api/attachments/${id}/preview`,
    downloadUrl: (id: number) => `/api/attachments/${id}/download`,
  },
  settings: {
    getAll: () => request<Record<string, unknown>>(`/settings`),
    set: (key: string, value: unknown) =>
      request<{ key: string; value: unknown }>(`/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
  },
  standup: {
    get: () => request<StandupResponse>(`/standup`),
  },
  recurrences: {
    list: () => request<Recurrence[]>(`/recurrences`),
    create: (data: {
      title: string;
      description?: string;
      tags?: string[];
      priority?: 1 | 2 | 3 | 4;
      frequency: RecurrenceFrequency;
      time_of_day?: string;
      enabled?: boolean;
    }) => request<Recurrence>(`/recurrences`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, patch: Partial<Omit<Recurrence, 'id' | 'created_at' | 'updated_at' | 'next_fire_at'>>) =>
      request<Recurrence>(`/recurrences/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: number) => request<void>(`/recurrences/${id}`, { method: 'DELETE' }),
  },
  ai: {
    reformulateTodo: (text: string) =>
      request<{ title: string; description: string; tags: string[]; subtasks: string[] }>(`/ai/reformulate-todo`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  },
  repoMappings: {
    list: () => request<RepoMapping[]>(`/repo-mappings`),
    create: (data: { source: RepoMappingSource; key: string; local_path: string }) =>
      request<RepoMapping>(`/repo-mappings`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: Partial<{ source: RepoMappingSource; key: string; local_path: string }>) =>
      request<RepoMapping>(`/repo-mappings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: number) => request<void>(`/repo-mappings/${id}`, { method: 'DELETE' }),
    backfill: () =>
      request<{ updated: number; scanned: number }>(`/repo-mappings/backfill`, { method: 'POST' }),
  },
  fs: {
    drives: () => request<{ drives: { name: string; path: string }[] }>(`/fs/drives`),
    browse: (path: string) =>
      request<{ path: string; parent: string | null; entries: { name: string; path: string }[] }>(
        `/fs/browse?path=${encodeURIComponent(path)}`,
      ),
    list: (root: string, limit = 5000) =>
      request<{
        root: string;
        entries: { path: string; type: 'file' | 'dir' }[];
        truncated: boolean;
        count: number;
        limit: number;
      }>(`/fs/list?root=${encodeURIComponent(root)}&limit=${limit}`),
    pickFolder: (initial?: string) =>
      request<{ path: string | null }>(`/fs/pick-folder`, {
        method: 'POST',
        body: JSON.stringify({ initial: initial ?? '' }),
      }),
  },
  queue: {
    list: () => request<QueueItem[]>(`/queue`),
    enqueue: (todoId: number, data: { prompt?: string; attachmentIds?: number[] } = {}) =>
      request<QueueItem>(`/queue/${todoId}`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: data.prompt ?? '',
          attachmentIds: data.attachmentIds ?? [],
        }),
      }),
    update: (todoId: number, patch: { prompt?: string; attachmentIds?: number[] }) =>
      request<QueueItem>(`/queue/${todoId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    dequeue: (todoId: number) =>
      request<void>(`/queue/${todoId}`, { method: 'DELETE' }),
    reorder: (orderedIds: number[]) =>
      request<{ ok: true; count: number }>(`/queue/reorder`, {
        method: 'POST',
        body: JSON.stringify({ ordered_ids: orderedIds }),
      }),
  },
  sandbox: {
    /**
     * Kick off a sandbox run. Server returns the generated runId and whether
     * the run is queued (slot cap hit) or launching immediately. Output lands
     * on the shared agent SSE pipe — no separate stream subscription needed.
     */
    start: (
      todoId: number,
      data: {
        prompt: string;
        branchName?: string | null;
        baseBranch?: string | null;
        testCommand?: string | null;
        maxTurns?: number | null;
        timeoutMin?: number | null;
        attachmentIds?: number[];
        includeAnalyses?: boolean;
        includeSnippets?: boolean;
      },
    ) =>
      request<{ runId: string; queued: boolean }>(`/sandbox/${todoId}/start`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    stop: (todoId: number) =>
      request<{ stopped: boolean }>(`/sandbox/${todoId}/stop`, { method: 'POST' }),
    list: () => request<{ runs: SandboxRun[] }>(`/sandbox/list`),
    testConnection: () =>
      request<{ ok: boolean; werkbankReachable: boolean; detail: string }>(
        `/sandbox/settings/test-connection`,
        { method: 'POST' },
      ),
    /**
     * Stream `docker build` output line-by-line via the SSE body of a POST.
     * EventSource can't do POST, so we read the ReadableStream ourselves and
     * parse SSE frames (`event: <name>\ndata: <json>\n\n`). `onChunk` fires for
     * each build line; `onEnd` fires once with the final {ok, imageTag}.
     */
    rebuildImage: async (
      onChunk: (text: string) => void,
      onEnd: (result: { ok: boolean; imageTag?: string; error?: string }) => void,
    ): Promise<void> => {
      const resp = await fetch(`/api/sandbox/image/rebuild`, { method: 'POST' });
      if (!resp.ok || !resp.body) {
        const body = await resp.text().catch(() => '');
        let msg = resp.statusText;
        try { msg = JSON.parse(body).error ?? msg; } catch { /* ignore */ }
        onEnd({ ok: false, error: `${resp.status}: ${msg}` });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      // Parse SSE frames: `event: <name>\ndata: <json>\n\n`. Empty line is the
      // frame terminator. A frame may arrive across multiple reads so we keep
      // a rolling buffer and split by `\n\n`.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIdx;
        while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          if (!frame.trim() || frame.startsWith(':')) continue; // heartbeat
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
          }
          if (event === 'chunk') {
            try {
              const parsed = JSON.parse(data) as { text: string };
              onChunk(parsed.text);
            } catch { /* malformed frame — skip */ }
          } else if (event === 'end') {
            try {
              const parsed = JSON.parse(data) as { ok: boolean; imageTag?: string; error?: string };
              onEnd(parsed);
            } catch {
              onEnd({ ok: false, error: 'invalid end frame' });
            }
            return;
          }
        }
      }
      // Stream closed without an explicit end frame.
      onEnd({ ok: false, error: 'stream closed without end event' });
    },
  },
  agent: {
    list: () =>
      request<{ sessions: AgentSession[] }>(`/agent/sessions`),
    getSession: (todoId: number) =>
      request<{ session: AgentSession | null }>(`/agent/session/${todoId}`),
    start: (todoId: number, prompt: string, cwd: string, attachmentIds: number[] = [], mode: 'work' | 'analyse' = 'work', includeAnalyses: boolean = false, includeSnippets: boolean = false) =>
      request<{ session: AgentSession }>(`/agent/session/${todoId}/start`, {
        method: 'POST',
        body: JSON.stringify({ prompt, cwd, attachmentIds, mode, includeAnalyses, includeSnippets }),
      }),
    send: (todoId: number, prompt: string, attachmentIds: number[] = []) =>
      request<{ session: AgentSession }>(`/agent/session/${todoId}/send`, {
        method: 'POST',
        body: JSON.stringify({ prompt, attachmentIds }),
      }),
    stop: (todoId: number) =>
      request<{ session: AgentSession | null }>(`/agent/session/${todoId}/stop`, { method: 'POST' }),
    /** Nuclear: tree-kills claude + all descendants (MCP, sub-shells). */
    kill: (todoId: number) =>
      request<{ session: AgentSession | null }>(`/agent/session/${todoId}/kill`, { method: 'POST' }),
    /** Soft: aborts current turn, keeps session context via --resume. */
    interrupt: (todoId: number) =>
      request<{ session: AgentSession | null }>(`/agent/session/${todoId}/interrupt`, { method: 'POST' }),
    clear: (todoId: number) =>
      request<void>(`/agent/session/${todoId}`, { method: 'DELETE' }),
    streamUrl: (todoId: number) => `/api/agent/session/${todoId}/stream`,
  },
};

export interface StandupItem {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'test' | 'done';
  tags: string[];
}

export interface StandupResponse {
  yesterday: StandupItem[];
  today: StandupItem[];
  blocked: StandupItem[];
}

export interface AgentTurnMeta {
  index: number;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  result: 'success' | 'error' | null;
}

export interface AgentSession {
  todoId: number;
  status: 'running' | 'exited' | 'error';
  turnActive: boolean;
  output: string;
  turns: AgentTurnMeta[];
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  cwd: string;
  prompt: string;
}
