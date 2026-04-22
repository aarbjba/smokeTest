import { db } from '../db.js';

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'monthly';

type RecurrenceRow = {
  id: number;
  title: string;
  description: string;
  tags: string;
  priority: number;
  frequency: Frequency;
  time_of_day: string;
  next_fire_at: string;
  enabled: 0 | 1;
};

/**
 * Compute the next fire date for a recurrence. Always anchored at the
 * requested time-of-day in LOCAL time (the user's wall clock), returned as a
 * Date instance. Returns the first slot strictly after `from`.
 */
export function computeNextFireAt(
  frequency: Frequency,
  timeOfDay: string,
  from: Date,
): Date {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  const today = new Date(from);
  today.setHours(hh, mm, 0, 0);

  // If today's slot is still ahead of `from`, use it — except for 'weekdays',
  // which also requires today to be Mon-Fri.
  const todayValid = (() => {
    if (today.getTime() <= from.getTime()) return false;
    if (frequency === 'weekdays') {
      const dow = today.getDay(); // 0=Sun..6=Sat
      return dow >= 1 && dow <= 5;
    }
    return true;
  })();
  if (todayValid) return today;

  const next = new Date(today);
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      return next;
    case 'weekdays': {
      // Advance day-by-day until we land on Mon-Fri.
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6);
      return next;
    }
    case 'weekly':
      next.setDate(next.getDate() + 7);
      return next;
    case 'monthly':
      // setMonth handles overflow (e.g. Jan 31 + 1mo → Mar 3). Users who care
      // about "last day of month" should pick day-28 or use a different tool.
      next.setMonth(next.getMonth() + 1);
      return next;
  }
}

/**
 * Poll enabled recurrences whose next_fire_at has passed, create a todo for
 * each, and advance their next_fire_at. Idempotent: if called twice quickly
 * the second call finds nothing to fire.
 */
export function fireDueRecurrences(now: Date = new Date()): number {
  const nowIso = now.toISOString();
  const due = db
    .prepare(`SELECT * FROM recurrences WHERE enabled = 1 AND next_fire_at <= ?`)
    .all(nowIso) as RecurrenceRow[];

  if (due.length === 0) return 0;

  const insertTodo = db.prepare(
    `INSERT INTO todos (title, description, status, priority, tags, due_date, source)
     VALUES (@title, @description, 'todo', @priority, @tags, @due_date, 'local')`,
  );
  const updateRecurrence = db.prepare(
    `UPDATE recurrences SET next_fire_at = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  const tx = db.transaction((rows: RecurrenceRow[]) => {
    for (const r of rows) {
      insertTodo.run({
        title: r.title,
        description: r.description,
        priority: r.priority,
        tags: r.tags, // already JSON-encoded in the recurrence row
        due_date: r.next_fire_at,
      });
      const next = computeNextFireAt(r.frequency, r.time_of_day, now);
      updateRecurrence.run(next.toISOString(), r.id);
    }
  });
  tx(due);

  console.log(`[recurrence] fired ${due.length} recurring todo(s)`);
  return due.length;
}

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — plan allows hourly but 10min is cheap on SQLite

export function startRecurrenceScheduler() {
  // Initial tick ~15s after boot so missed fires from downtime catch up fast.
  setTimeout(() => {
    try { fireDueRecurrences(); } catch (err) { console.warn('[recurrence] fire error:', err); }
  }, 15_000);

  setInterval(() => {
    try { fireDueRecurrences(); } catch (err) { console.warn('[recurrence] fire error:', err); }
  }, CHECK_INTERVAL_MS);

  console.log(`[recurrence] scheduler enabled (interval: ${CHECK_INTERVAL_MS / 1000}s)`);
}
