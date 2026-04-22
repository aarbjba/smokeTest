import { onMounted, onUnmounted } from 'vue';
import { useTodosStore } from '../stores/todos';
import type { Todo } from '../types';

/**
 * localStorage key holding a JSON array of "notified" entries,
 * each formatted as `${todoId}:${due_date}`. When a todo's due_date
 * changes the old key no longer matches, so the todo is eligible
 * to notify again — intentional behavior per the feature spec.
 */
const NOTIFIED_KEY = 'werkbank.notified';

/** How often the composable re-scans todos (5 minutes). */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Delay before the first scan so stores can hydrate on boot. */
const INITIAL_DELAY_MS = 3000;

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set<string>(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set<string>();
  }
}

function saveNotified(set: Set<string>) {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Storage quota / private-mode failures are non-fatal; we just
    // might re-notify on the next load. Acceptable.
  }
}

function notifiedKeyFor(todo: Todo): string {
  // Non-null due_date is ensured by callers; include it verbatim so
  // any change (even whitespace / timezone-suffix) counts as a new
  // key and re-fires the notification.
  return `${todo.id}:${todo.due_date ?? ''}`;
}

/**
 * Request Notification permission. MUST be called from a user-gesture
 * handler (click, keypress) — browsers silently deny or block on page-load
 * requests. Returns the resulting permission string, or 'denied' if the
 * API is unavailable.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  try {
    // Chrome/Edge/Firefox return a Promise; older Safari takes a callback.
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return 'denied';
  }
}

/**
 * Composable that polls the todos store every 5 minutes and fires a
 * browser Notification for each todo whose `due_date` has passed and
 * whose status is not `done`, deduplicating via localStorage.
 *
 * Does NOT request permission — call `requestNotificationPermission()`
 * from a user gesture elsewhere (e.g. command-palette action).
 */
export function useDueNotifications() {
  const todosStore = useTodosStore();

  let intervalId: number | null = null;
  let initialTimeoutId: number | null = null;

  function scan() {
    if (!notificationsSupported()) return;
    if (Notification.permission !== 'granted') return;

    const now = Date.now();
    const notified = loadNotified();
    let changed = false;

    for (const todo of todosStore.items) {
      if (!todo.due_date) continue;
      if (todo.status === 'done') continue;

      const due = new Date(todo.due_date).getTime();
      if (!Number.isFinite(due)) continue;
      if (due > now) continue;

      const key = notifiedKeyFor(todo);
      if (notified.has(key)) continue;

      try {
        const body = todo.description
          ? todo.description.slice(0, 140)
          : 'Fälligkeitsdatum erreicht';
        new Notification(todo.title || `Todo #${todo.id}`, {
          body,
          tag: `werkbank-${todo.id}`,
        });
      } catch {
        // Some browsers throw if the Notification constructor is
        // called in an insecure or unsupported context. Skip silently.
        continue;
      }

      notified.add(key);
      changed = true;
    }

    if (changed) saveNotified(notified);
  }

  onMounted(() => {
    if (!notificationsSupported()) return;
    initialTimeoutId = window.setTimeout(() => {
      scan();
      initialTimeoutId = null;
    }, INITIAL_DELAY_MS);
    intervalId = window.setInterval(scan, POLL_INTERVAL_MS);
  });

  onUnmounted(() => {
    if (initialTimeoutId !== null) {
      window.clearTimeout(initialTimeoutId);
      initialTimeoutId = null;
    }
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  });
}
