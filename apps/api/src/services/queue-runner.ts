import { existsSync, statSync } from 'node:fs';
import { db } from '../db.js';
import { claudeSessions } from './claude-sessions.js';

/**
 * Automation queue runner.
 *
 * Picks the lowest `queue_position` todo in status='todo' and starts a Claude
 * session for it — the same path the Details-page "Run Claude" button uses.
 *
 * Concurrency: one at a time. We hold a single `runningTodoId` and refuse to
 * start a new one while that field is set. The guard is released when the
 * underlying session emits 'end' (success, stop, or error) OR when the spawn
 * itself fails synchronously.
 *
 * Triggers:
 *   - interval poll every POLL_MS (catches newly-enqueued items).
 *   - immediate retick on claudeSessions 'end' (so we don't wait up to POLL_MS
 *     between items — the queue stays hot).
 *
 * Edit-safety: the prompt + attachment selection are stored on the todo row.
 * As long as a todo is queued (queue_position != NULL) and not yet running,
 * the user can PATCH /api/queue/:todoId to update them. Once we pick it up we
 * clear queue_position and hand the values to claudeSessions.start(); from
 * that moment on the todo is status='in_progress' and the Details page takes
 * over.
 */

const POLL_MS = 3_000;

let runningTodoId: number | null = null;
let started = false;

interface NextRow {
  id: number;
  queue_prompt: string | null;
  queue_attachment_ids: string | null;
  working_directory: string | null;
}

function getDefaultWorkingDirectory(): string {
  const row = db.prepare(
    `SELECT value FROM settings WHERE key = 'defaultWorkingDirectory'`,
  ).get() as { value: string } | undefined;
  if (!row) return '';
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

function clearQueueFields(todoId: number): void {
  db.prepare(
    `UPDATE todos
       SET queue_position = NULL,
           queue_prompt = NULL,
           queue_attachment_ids = NULL,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(todoId);
}

function markWritebackError(todoId: number, message: string): void {
  // We reuse last_writeback_error to surface runner failures in the UI,
  // since there's no dedicated "queue error" column and the existing UI
  // already displays this string when set.
  try {
    db.prepare(
      `UPDATE todos
         SET last_writeback_error = ?,
             updated_at = datetime('now')
       WHERE id = ?`,
    ).run(`[queue] ${message}`, todoId);
  } catch {
    /* ignore */
  }
}

function tick(): void {
  if (runningTodoId !== null) return; // overlap guard

  const next = db.prepare(
    `SELECT id, queue_prompt, queue_attachment_ids, working_directory
       FROM todos
      WHERE queue_position IS NOT NULL
        AND deleted_at IS NULL
        AND status = 'todo'
      ORDER BY queue_position ASC, id ASC
      LIMIT 1`,
  ).get() as NextRow | undefined;
  if (!next) return;

  // Resolve cwd: per-todo working_directory → settings.defaultWorkingDirectory.
  const cwd = (next.working_directory && next.working_directory.trim())
    ? next.working_directory.trim()
    : getDefaultWorkingDirectory();

  if (!cwd) {
    markWritebackError(next.id, 'Kein Arbeitsverzeichnis gesetzt — Todo aus der Warteschlange entfernt.');
    clearQueueFields(next.id);
    // Try the next one on the next tick.
    setImmediate(tick);
    return;
  }

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    markWritebackError(next.id, `Arbeitsverzeichnis nicht gefunden: ${cwd}`);
    clearQueueFields(next.id);
    setImmediate(tick);
    return;
  }

  // Parse stored attachment IDs. Fall back to empty if malformed.
  let attachmentIds: number[] = [];
  if (next.queue_attachment_ids) {
    try {
      const parsed = JSON.parse(next.queue_attachment_ids);
      if (Array.isArray(parsed)) {
        attachmentIds = parsed.filter((n): n is number => typeof n === 'number');
      }
    } catch {
      /* ignore */
    }
  }

  // Empty prompt is fine — claude-sessions wraps it in the preprompt template
  // either way, and the template's {{user_prompt}} slot accepts an empty string.
  // We supply a small placeholder so the turn header in the output pane shows
  // something meaningful.
  const userPrompt = (next.queue_prompt && next.queue_prompt.trim())
    ? next.queue_prompt
    : '(aus Warteschlange gestartet — keine zusätzliche Anweisung)';

  runningTodoId = next.id;

  // Clear queue fields BEFORE starting so a fast poll doesn't re-pick the row
  // if the session takes a moment to report back. claudeSessions.start() will
  // also flip status to 'in_progress' via its internal autoMoveToInProgress.
  clearQueueFields(next.id);

  try {
    claudeSessions.start(next.id, userPrompt, cwd, attachmentIds, 'work');
    console.log(`[queue] started session for todo #${next.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[queue] failed to start todo #${next.id}: ${msg}`);
    markWritebackError(next.id, `Start fehlgeschlagen: ${msg}`);
    // Release the slot — the next tick will pick up the next queued item.
    runningTodoId = null;
    setImmediate(tick);
  }
}

export function startQueueRunner(): void {
  if (started) return;
  started = true;

  // Release the lock when the current session finishes, then retick immediately
  // so the next item doesn't wait for the poll interval.
  claudeSessions.on('end', (todoId: number) => {
    if (runningTodoId === todoId) {
      runningTodoId = null;
      // Don't await — fire-and-forget is fine, tick is synchronous.
      setImmediate(tick);
    }
  });
  claudeSessions.on('cleared', (todoId: number) => {
    // Clearing a session also frees our slot (e.g. user manually cleared on the
    // Details page before we got the 'end' event).
    if (runningTodoId === todoId) {
      runningTodoId = null;
      setImmediate(tick);
    }
  });

  // Initial kick after boot so queued items left over from a previous run get
  // picked up without the user needing to do anything.
  setTimeout(tick, 5_000);
  setInterval(tick, POLL_MS);

  console.log('[queue] runner started');
}
