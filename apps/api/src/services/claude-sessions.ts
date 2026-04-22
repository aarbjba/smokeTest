import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { db } from '../db.js';
import { resolveAttachmentPaths } from '../routes/attachments.js';

const CLAUDE_CMD = process.env.CLAUDE_CLI ?? 'claude';
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const TERMINATE_TOKEN = 'TERMINATE';

// ─── werkbank MCP wiring ────────────────────────────────────────────────────
// Every per-todo Claude session gets the werkbank MCP server attached so the
// agent can query/mutate todos without the user pasting anything. Each spawn
// launches its own MCP process (stdio), so concurrent sessions don't share
// state — all mutations funnel through the werkbank HTTP API.

const __dirname_es = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname_es, '../../../..'); // apps/api/{src|dist}/services → repo root

interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Absolute path to the built werkbank MCP entry, or null if not built yet. */
function findWerkbankMcpEntry(): string | null {
  const override = process.env.WERKBANK_MCP_ENTRY;
  if (override && existsSync(override)) return override;
  const candidate = resolve(__dirname_es, '../../../mcp/dist/index.js');
  return existsSync(candidate) ? candidate : null;
}

/** Read per-todo MCP overrides stored as JSON on todos.mcp_servers. */
function loadTodoMcpServers(todoId: number): McpServerEntry[] | null {
  const row = db
    .prepare(`SELECT mcp_servers FROM todos WHERE id = ?`)
    .get(todoId) as { mcp_servers: string | null } | undefined;
  if (!row?.mcp_servers) return null;
  try {
    const parsed = JSON.parse(row.mcp_servers);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as McpServerEntry[];
  } catch {
    return null;
  }
}

function writeTempMcpConfig(mcpServers: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'werkbank-mcp-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2), 'utf8');
  return path;
}

/**
 * Resolve any relative paths in an args array against `baseDir`.
 * Heuristic: an arg is treated as a path if it looks like one (contains a
 * slash/backslash or ends with .js/.mjs/.cjs/.ts). This prevents us from
 * rewriting bare flags like `-y` or scalar values.
 *
 * Claude CLI runs MCP commands with the SESSION cwd (the user's project dir),
 * not the werkbank repo — so relative paths in `.mcp.json` or per-todo configs
 * would otherwise fail to resolve and the MCP handshake would hang.
 */
function absolutizeArgs(args: string[], baseDir: string): string[] {
  return args.map((a) => {
    if (isAbsolute(a)) return a;
    const looksLikePath = /[\\/]/.test(a) || /\.(m?js|cjs|ts)$/i.test(a);
    return looksLikePath ? resolve(baseDir, a) : a;
  });
}

/** Read the repo-root .mcp.json, resolving its relative args to absolute paths. */
function readRepoRootConfig(): Record<string, unknown> | null {
  const p = join(REPO_ROOT, '.mcp.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { mcpServers?: Record<string, unknown> };
    if (!raw?.mcpServers) return null;
    const out: Record<string, unknown> = {};
    for (const [name, serverRaw] of Object.entries(raw.mcpServers)) {
      const server = serverRaw as { command?: string; args?: string[]; env?: Record<string, string> };
      out[name] = {
        command: server.command,
        args: absolutizeArgs(server.args ?? [], REPO_ROOT),
        env: server.env ?? {},
      };
    }
    return out;
  } catch {
    return null;
  }
}

/** Built-in fallback: just the werkbank MCP, using the compiled dist entry. */
function builtinWerkbankConfig(): Record<string, unknown> | null {
  const entry = findWerkbankMcpEntry();
  if (!entry) return null;
  const apiUrl = `http://localhost:${process.env.API_PORT ?? '3001'}`;
  return {
    werkbank: { command: 'node', args: [entry], env: { WERKBANK_API_URL: apiUrl } },
  };
}

/**
 * Resolve the MCP config path for a specific todo.
 * Precedence:
 *   1. Per-todo overrides in todos.mcp_servers.
 *   2. Repo-root .mcp.json (relative paths resolved against repo root).
 *   3. Generated werkbank-only config (if apps/mcp/dist/index.js exists).
 *   4. null — spawn Claude without --mcp-config.
 *
 * Always emits a fresh temp config file per spawn with absolute paths — this
 * avoids Claude resolving relative paths against the session's cwd (which is
 * the user's project, not the werkbank repo) and hanging on the MCP handshake.
 */
function mcpConfigPathForTodo(todoId: number): string | null {
  const perTodo = loadTodoMcpServers(todoId);
  let map: Record<string, unknown> | null = null;
  if (perTodo && perTodo.length > 0) {
    map = {};
    for (const s of perTodo) {
      map[s.name] = {
        command: s.command,
        args: absolutizeArgs(s.args ?? [], REPO_ROOT),
        env: s.env ?? {},
      };
    }
  } else {
    map = readRepoRootConfig() ?? builtinWerkbankConfig();
  }
  if (!map || Object.keys(map).length === 0) return null;
  return writeTempMcpConfig(map);
}

export interface ClaudeTurn {
  index: number;
  prompt: string;
  output: string;
  startedAt: number;
  endedAt: number | null;
  result: 'success' | 'error' | null;
}

export interface ClaudeSession {
  todoId: number;
  status: 'running' | 'exited' | 'error';
  turnActive: boolean;
  output: string;
  turns: ClaudeTurn[];
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  cwd: string;
  prompt: string;
}

function persistSessionId(todoId: number, sessionId: string | null): void {
  try {
    db.prepare('UPDATE todos SET claude_session_id = ? WHERE id = ?').run(sessionId, todoId);
  } catch {
    /* ignore */
  }
}

// ─── Preprompt rendering ────────────────────────────────────────────────────
// Default template. User-editable via settings key 'agent.preprompt'.
// Placeholders: {{todo_id}}, {{todo_title}}, {{todo_description}}, {{todo_status}},
//               {{subtasks}}, {{analyses}}, {{user_prompt}}
//
// {{analyses}} expands to the full "## Bisherige Analysen" block (incl. heading)
// when the caller opted to include them, or to an empty string otherwise.
const DEFAULT_PREPROMPT = `Du arbeitest an einer Aufgabe aus der Werkbank. Nutze die MCP-Tools "werkbank" um den Fortschritt live zu tracken.

## Aktuelle Aufgabe
ID: {{todo_id}}
Titel: {{todo_title}}
Status: {{todo_status}}

Beschreibung:
{{todo_description}}

## Bestehende Subtasks
{{subtasks}}
{{analyses}}
## Arbeitsweise
1. Prüfe zuerst die oben aufgeführten bestehenden Subtasks. Entscheide, ob sie die Aufgabe vollständig abdecken. Sind sie ausreichend, arbeite sie direkt ab. Fehlen Schritte oder existieren noch keine, ergänze sie via mcp__werkbank__add_subtask, bevor du mit der Umsetzung beginnst.
2. Arbeite die Subtasks ab und hake jeden Schritt ab, sobald er erledigt ist (mcp__werkbank__update_subtask mit done=true).
3. Wenn du fertig bist, rufe mcp__werkbank__finalize_todo mit einer kurzen Zusammenfassung der Ergebnisse auf. Setze next_status auf "test" wenn Review nötig ist, sonst "done".

## User-Prompt
{{user_prompt}}
`;

// Analyse-mode template: read-only understanding pass, produces an analysis +
// suggested subtasks. Does NOT implement or finalize.
// Placeholders: {{todo_id}}, {{todo_title}}, {{todo_description}}, {{todo_status}}, {{subtasks}}
const ANALYSE_PREPROMPT = `Du arbeitest im **Analyse-Modus** an einer Aufgabe aus der Werkbank. Ziel: die Aufgabe verstehen, strukturiert analysieren und Umsetzungsschritte vorschlagen. Du setzt selbst nichts um und veränderst keinen Code.

## Aktuelle Aufgabe
ID: {{todo_id}}
Titel: {{todo_title}}
Status: {{todo_status}}

Beschreibung:
{{todo_description}}

## Bestehende Subtasks
{{subtasks}}

## Ablauf
1. Sichte Titel, Beschreibung, bestehende Subtasks und angehängte Dateien (falls übergeben).
2. Verfasse eine strukturierte Analyse in Markdown mit folgenden Abschnitten:
   - **Ziel**: Was will der User wirklich erreichen?
   - **Vorgehen**: Wie lässt sich das umsetzen? Skizziere 2–3 Optionen falls relevant.
   - **Risiken / offene Fragen**: Was ist unklar? Wo drohen Probleme?
   - **Komplexität**: Grobe Einschätzung (klein / mittel / groß) mit Begründung.
3. Speichere die Analyse mit mcp__werkbank__add_analysis (genau einmal pro Durchlauf).
4. Schlage für jeden konkreten Umsetzungsschritt, der als Subtask sinnvoll wäre, einen Eintrag via mcp__werkbank__suggest_subtask vor. Dupliziere keine Subtasks, die oben bereits gelistet sind.
5. Beende danach. Rufe NICHT mcp__werkbank__finalize_todo auf — die Aufgabe ist nicht erledigt, sie ist analysiert.
`;

export type AgentMode = 'work' | 'analyse';

function getPreprompt(mode: AgentMode): string {
  if (mode === 'analyse') {
    try {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'agent.analyse_preprompt'`).get() as { value: string } | undefined;
      if (!row) return ANALYSE_PREPROMPT;
      const parsed = JSON.parse(row.value);
      return typeof parsed === 'string' && parsed.trim() ? parsed : ANALYSE_PREPROMPT;
    } catch {
      return ANALYSE_PREPROMPT;
    }
  }
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'agent.preprompt'`).get() as { value: string } | undefined;
    if (!row) return DEFAULT_PREPROMPT;
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'string' && parsed.trim() ? parsed : DEFAULT_PREPROMPT;
  } catch {
    return DEFAULT_PREPROMPT;
  }
}

interface TodoLite {
  id: number;
  title: string;
  description: string;
  status: string;
}

interface SubtaskLite {
  id: number;
  title: string;
  done: 0 | 1;
  suggested: 0 | 1;
}

interface AnalysisLite {
  id: number;
  content: string;
  created_at: string;
}

function renderPreprompt(todoId: number, userPrompt: string, mode: AgentMode, includeAnalyses: boolean): string {
  const template = getPreprompt(mode);
  const todo = db.prepare(
    `SELECT id, title, description, status FROM todos WHERE id = ?`,
  ).get(todoId) as TodoLite | undefined;
  if (!todo) return userPrompt; // fallback if todo gone — don't wrap.

  // Work mode sees only committed subtasks (suggested ones are not yet real work).
  // Analyse mode sees all, labelled, to avoid re-suggesting duplicates.
  const subtaskSql = mode === 'analyse'
    ? `SELECT id, title, done, suggested FROM subtasks WHERE todo_id = ? ORDER BY position ASC, id ASC`
    : `SELECT id, title, done, suggested FROM subtasks WHERE todo_id = ? AND suggested = 0 ORDER BY position ASC, id ASC`;
  const subtasks = db.prepare(subtaskSql).all(todoId) as SubtaskLite[];

  const subtasksStr = subtasks.length === 0
    ? '(keine)'
    : subtasks.map((s) => {
        const mark = s.done ? 'x' : ' ';
        const tag = s.suggested ? ' [Vorschlag]' : '';
        return `- [${mark}] (#${s.id})${tag} ${s.title}`;
      }).join('\n');

  // Previously saved analyses from analyse-mode runs, injected only when the
  // caller opted in (Analyse-einbeziehen checkbox in the agent panel). Newest
  // first so the most recent thinking leads.
  let analysesBlock = '';
  if (includeAnalyses) {
    const analyses = db.prepare(
      `SELECT id, content, created_at FROM analyses WHERE todo_id = ? ORDER BY created_at DESC, id DESC`,
    ).all(todoId) as AnalysisLite[];
    if (analyses.length > 0) {
      const parts = analyses.map((a) => `### Analyse vom ${a.created_at}\n${a.content.trim()}`);
      analysesBlock = `\n## Bisherige Analysen\n${parts.join('\n\n')}\n`;
    }
  }

  return template
    .replace(/\{\{todo_id\}\}/g, String(todo.id))
    .replace(/\{\{todo_title\}\}/g, todo.title)
    .replace(/\{\{todo_description\}\}/g, todo.description || '(leer)')
    .replace(/\{\{todo_status\}\}/g, todo.status)
    .replace(/\{\{subtasks\}\}/g, subtasksStr)
    .replace(/\{\{analyses\}\}/g, analysesBlock)
    .replace(/\{\{user_prompt\}\}/g, userPrompt);
}

/** Move todo to 'in_progress' if it's currently 'todo'. Leaves test/done/in_progress untouched. */
function autoMoveToInProgress(todoId: number): void {
  try {
    db.prepare(
      `UPDATE todos SET status = 'in_progress', updated_at = datetime('now')
       WHERE id = ? AND status = 'todo' AND deleted_at IS NULL`,
    ).run(todoId);
  } catch {
    /* ignore — not worth failing the start over */
  }
}

class SessionStore extends EventEmitter {
  private sessions = new Map<number, ClaudeSession>();
  private processes = new Map<number, ChildProcess>();
  private stdoutBuffers = new Map<number, string>();

  get(todoId: number): ClaudeSession | undefined {
    return this.sessions.get(todoId);
  }

  has(todoId: number): boolean {
    return this.sessions.has(todoId);
  }

  start(todoId: number, prompt: string, cwd: string, attachmentIds: number[] = [], mode: AgentMode = 'work', includeAnalyses: boolean = false): ClaudeSession {
    if (!existsSync(cwd)) throw Object.assign(new Error(`Directory does not exist: ${cwd}`), { status: 400 });
    if (!statSync(cwd).isDirectory()) throw Object.assign(new Error(`Not a directory: ${cwd}`), { status: 400 });

    this.killProcess(todoId);
    persistSessionId(todoId, null);

    // Analyse mode is a read-only pass; don't flip the board status. Work mode
    // auto-moves 'todo' → 'in_progress' so the board reflects that work started.
    if (mode === 'work') {
      autoMoveToInProgress(todoId);
    }

    // Wrap the user prompt with the configured preprompt template (todo context,
    // subtasks, workflow instructions). Users can edit the template in Settings
    // — see apps/web/src/views/SettingsView.vue.
    const renderedPrompt = renderPreprompt(todoId, prompt, mode, includeAnalyses);

    const session: ClaudeSession = {
      todoId,
      status: 'running',
      turnActive: false,
      output: '',
      turns: [],
      sessionId: null,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      errorMessage: null,
      cwd,
      prompt: renderedPrompt,
    };
    this.sessions.set(todoId, session);

    this.spawnProcess(session);
    this.submitTurn(session, renderedPrompt, attachmentIds);
    return session;
  }

  send(todoId: number, prompt: string, attachmentIds: number[] = []): ClaudeSession {
    const session = this.sessions.get(todoId);
    if (!session) {
      throw Object.assign(new Error('No active session. Start one first.'), { status: 400 });
    }
    if (session.status !== 'running') {
      throw Object.assign(new Error('Session has exited. Clear and start a new one.'), { status: 409 });
    }
    if (session.turnActive) {
      throw Object.assign(new Error('A turn is already in progress.'), { status: 409 });
    }

    if (prompt.trim() === TERMINATE_TOKEN) {
      this.append(session, `\n── Turn ${session.turns.length + 1} ──\n> ${TERMINATE_TOKEN}\n\n[terminating session]\n`, null);
      this.endProcessGracefully(todoId);
      return session;
    }

    this.submitTurn(session, prompt, attachmentIds);
    return session;
  }

  private spawnProcess(session: ClaudeSession): void {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    // Attach MCP servers for this todo. Precedence: per-todo overrides →
    // repo-root .mcp.json → generated werkbank-only config. Every spawn
    // gets its own fresh config path when per-todo overrides are set so
    // concurrent sessions don't race on the same temp file.
    const mcpConfigPath = mcpConfigPathForTodo(session.todoId);
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }

    const child = spawn(CLAUDE_CMD, args, {
      cwd: session.cwd,
      env: { ...process.env },
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.processes.set(session.todoId, child);
    this.stdoutBuffers.set(session.todoId, '');

    child.stdout?.on('data', (chunk: Buffer) => {
      this.onStdout(session, chunk.toString('utf8'));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.trim()) {
        this.append(session, `[stderr] ${text}`, null);
      }
    });

    child.on('error', (err) => {
      session.status = 'error';
      session.turnActive = false;
      session.errorMessage = err.message;
      session.endedAt = Date.now();
      this.append(
        session,
        `\n[spawn error: ${err.message}]\n` +
          `Try setting CLAUDE_CLI in .env to the full path of the claude executable.\n`,
        null,
      );
      this.processes.delete(session.todoId);
      this.stdoutBuffers.delete(session.todoId);
      this.emit('end', session.todoId, session);
    });

    child.on('close', (code) => {
      this.flushStdoutBuffer(session, true);
      if (this.processes.get(session.todoId) === child) {
        this.processes.delete(session.todoId);
      }
      this.stdoutBuffers.delete(session.todoId);
      session.turnActive = false;
      if (session.status === 'running') {
        session.status = code === 0 ? 'exited' : 'error';
        session.exitCode = code;
        session.endedAt = Date.now();
        this.append(session, `\n[session ended — exit ${code ?? '?'}]\n`, null);
      }
      const lastTurn = session.turns[session.turns.length - 1];
      if (lastTurn && lastTurn.endedAt === null) {
        lastTurn.endedAt = Date.now();
        if (lastTurn.result === null) lastTurn.result = code === 0 ? 'success' : 'error';
      }
      if (session.sessionId) persistSessionId(session.todoId, session.sessionId);
      this.emit('end', session.todoId, session);
    });
  }

  private submitTurn(session: ClaudeSession, prompt: string, attachmentIds: number[] = []): void {
    // Resolve selected attachments to absolute paths, then prepend a small
    // preamble so Claude knows which files are available and can open them
    // via its Read tool. Only the user's intent is echoed at the turn header —
    // the preamble is summarized with a short "📎 N Anhänge" note.
    const attachments = attachmentIds.length > 0
      ? resolveAttachmentPaths(session.todoId, attachmentIds)
      : [];

    let contentForClaude = prompt;
    if (attachments.length > 0) {
      const lines = attachments.map(
        (a) => `- ${a.absPath}  (${a.kind}${a.mime ? `, ${a.mime}` : ''}, "${a.filename}")`,
      );
      contentForClaude =
        `Angehängte Dateien (absolute Pfade — lies sie mit dem Read-Tool, falls relevant für die Aufgabe):\n` +
        lines.join('\n') +
        `\n\n${prompt}`;
    }

    const turn: ClaudeTurn = {
      index: session.turns.length + 1,
      prompt,
      output: '',
      startedAt: Date.now(),
      endedAt: null,
      result: null,
    };
    session.turns.push(turn);
    session.turnActive = true;
    session.prompt = prompt;

    const attachNote = attachments.length > 0
      ? `[📎 ${attachments.length} Anhang${attachments.length === 1 ? '' : 'e'}: ${attachments.map((a) => a.filename).join(', ')}]\n`
      : '';

    const separator = session.turns.length === 1
      ? `── Turn 1 ──\n> ${prompt}\n${attachNote}\n`
      : `\n\n── Turn ${turn.index} ──\n> ${prompt}\n${attachNote}\n`;
    this.append(session, separator, turn);

    const child = this.processes.get(session.todoId);
    if (!child || !child.stdin || child.stdin.destroyed) {
      turn.result = 'error';
      turn.endedAt = Date.now();
      session.turnActive = false;
      session.status = 'error';
      session.errorMessage = 'claude stdin is not available';
      this.append(session, `[stdin unavailable]\n`, turn);
      this.emit('end', session.todoId, session);
      return;
    }

    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: contentForClaude,
      },
    };

    try {
      child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
    } catch (err) {
      turn.result = 'error';
      turn.endedAt = Date.now();
      session.turnActive = false;
      session.status = 'error';
      session.errorMessage = err instanceof Error ? err.message : 'stdin write failed';
      this.append(session, `[stdin write failed: ${session.errorMessage}]\n`, turn);
      this.emit('end', session.todoId, session);
    }
  }

  private onStdout(session: ClaudeSession, text: string): void {
    const buf = (this.stdoutBuffers.get(session.todoId) ?? '') + text;
    this.stdoutBuffers.set(session.todoId, buf);
    this.flushStdoutBuffer(session, false);
  }

  private flushStdoutBuffer(session: ClaudeSession, final: boolean): void {
    let buffer = this.stdoutBuffers.get(session.todoId) ?? '';
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      this.handleJsonLine(session, line);
    }
    if (final && buffer.trim()) {
      this.handleJsonLine(session, buffer);
      buffer = '';
    }
    this.stdoutBuffers.set(session.todoId, buffer);
  }

  private handleJsonLine(session: ClaudeSession, raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      this.append(session, line + '\n', session.turns[session.turns.length - 1] ?? null);
      return;
    }

    if (!ev || typeof ev !== 'object') return;

    if (ev.session_id && typeof ev.session_id === 'string' && SESSION_ID_RE.test(ev.session_id)) {
      if (!session.sessionId) {
        session.sessionId = ev.session_id;
        persistSessionId(session.todoId, ev.session_id);
      }
    }

    const currentTurn = session.turns[session.turns.length - 1] ?? null;

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          const model = ev.model ? ` (${ev.model})` : '';
          this.append(session, `[claude started${model}]\n`, currentTurn);
        }
        return;

      case 'assistant': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            this.append(session, c.text, currentTurn);
          } else if (c.type === 'tool_use') {
            const summary = summarizeToolInput(c.name, c.input);
            this.append(session, `\n[tool: ${c.name}] ${summary}\n`, currentTurn);
          } else if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) {
            this.append(session, `[thinking…]\n`, currentTurn);
          }
        }
        return;
      }

      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type === 'tool_result') {
            const body = typeof c.content === 'string'
              ? c.content
              : Array.isArray(c.content)
                ? c.content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
                : '';
            const first = body.split('\n')[0]?.slice(0, 100) ?? '';
            const moreLines = body.split('\n').length > 1;
            const truncated = body.length > 100 || moreLines;
            const suffix = c.is_error ? ' (error)' : '';
            this.append(session, `  → ${first}${truncated ? '…' : ''}${suffix}\n`, currentTurn);
          }
        }
        return;
      }

      case 'result': {
        if (currentTurn) {
          currentTurn.endedAt = Date.now();
          currentTurn.result = ev.subtype === 'success' ? 'success' : 'error';
        }
        if (ev.subtype === 'success') {
          this.append(session, `\n[done]\n`, currentTurn);
        } else {
          const msg = ev.error ?? ev.subtype ?? 'error';
          this.append(session, `\n[result: ${msg}]\n`, currentTurn);
        }
        session.turnActive = false;
        this.emit('turn-end', session.todoId, session);
        return;
      }

      default:
        return;
    }
  }

  private append(session: ClaudeSession, text: string, turn: ClaudeTurn | null): void {
    if (!text) return;
    if (session.output.length + text.length > MAX_OUTPUT_BYTES) {
      const room = Math.max(0, MAX_OUTPUT_BYTES - session.output.length);
      const slice = text.slice(0, room);
      const notice = '\n\n[… output truncated at 10 MB …]\n';
      session.output += slice + notice;
      if (turn) turn.output += slice + notice;
    } else {
      session.output += text;
      if (turn) turn.output += text;
    }
    this.emit('chunk', session.todoId, text);
  }

  /** Close stdin so claude exits gracefully after finishing current work. */
  private endProcessGracefully(todoId: number): void {
    const child = this.processes.get(todoId);
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  }

  /** Hard kill — used by stop/clear. */
  private killProcess(todoId: number): void {
    const child = this.processes.get(todoId);
    if (child && !child.killed) {
      try { child.kill(); } catch { /* ignore */ }
    }
    this.processes.delete(todoId);
    this.stdoutBuffers.delete(todoId);
  }

  stop(todoId: number): ClaudeSession | undefined {
    const session = this.sessions.get(todoId);
    if (session && session.status === 'running') {
      this.killProcess(todoId);
      session.status = 'exited';
      session.turnActive = false;
      session.exitCode = null;
      session.endedAt = Date.now();
      const lastTurn = session.turns[session.turns.length - 1];
      if (lastTurn && lastTurn.endedAt === null) {
        lastTurn.endedAt = session.endedAt;
        if (lastTurn.result === null) lastTurn.result = 'error';
      }
      this.append(session, '\n[session stopped by user]\n', lastTurn ?? null);
      this.emit('end', todoId, session);
    } else {
      this.killProcess(todoId);
    }
    return session;
  }

  clear(todoId: number): void {
    this.killProcess(todoId);
    this.sessions.delete(todoId);
    persistSessionId(todoId, null);
    this.emit('cleared', todoId);
  }

  all(): ClaudeSession[] {
    return Array.from(this.sessions.values());
  }
}

function summarizeToolInput(name: string | undefined, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const n = String(name ?? '').toLowerCase();
  if (n === 'read' || n === 'write' || n === 'edit' || n === 'notebookedit') {
    return String(input.file_path ?? input.path ?? '').trim();
  }
  if (n === 'bash' || n === 'powershell') {
    const cmd = String(input.command ?? '').split('\n')[0] ?? '';
    return cmd.length > 140 ? cmd.slice(0, 140) + '…' : cmd;
  }
  if (n === 'grep') {
    const pattern = String(input.pattern ?? '');
    const path = input.path ? ` in ${input.path}` : '';
    return `${pattern}${path}`;
  }
  if (n === 'glob') {
    return String(input.pattern ?? '');
  }
  if (n === 'webfetch' || n === 'websearch') {
    return String(input.url ?? input.query ?? '');
  }
  if (n === 'task' || n === 'agent') {
    return String(input.description ?? input.subagent_type ?? '');
  }
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length) {
      const one = v.split('\n')[0] ?? '';
      return `${k}=${one.length > 100 ? one.slice(0, 100) + '…' : one}`;
    }
  }
  return '';
}

export const claudeSessions = new SessionStore();
