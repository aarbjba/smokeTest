// Pure regex-based parser for the Quick-Add text field in NewTodoForm.
// Extracts tags (#foo), priority (!high or !1), and a due date (today,
// tomorrow, weekday, or ISO YYYY-MM-DD) from free-form input; the leftover
// text becomes the todo title.
//
// Priority is returned as the same 1|2|3|4 numeric value used by the Todo
// type (see apps/web/src/types.ts), normalised to a string so consumers can
// also accept null. urgent=1, high=1, normal=2, low=3, someday=4.

export type ParsedPriority = 1 | 2 | 3 | 4;

export interface ParsedQuickAdd {
  title: string;
  tags: string[];
  /**
   * Priority level as the numeric todo priority (1-4) stored as a string so
   * the field can cleanly be `null` when no priority was detected. Callers
   * that want the numeric value can `Number(priority)`.
   */
  priority: string | null;
  /** ISO date string (YYYY-MM-DD) or null. */
  dueDate: string | null;
}

const TAG_RE = /(^|\s)#([a-z][a-z0-9-]*)/gi;
const PRIORITY_RE = /(^|\s)!(urgent|high|normal|low|someday|[1-4])\b/gi;
const ISO_DATE_RE = /(^|\s)(\d{4}-\d{2}-\d{2})\b/g;

// Weekday tokens: mon, mon-day, monday, etc. (matches only at word
// boundaries to avoid eating words like "monitor"). "day" suffix optional
// for the short forms; full names are also accepted.
const WEEKDAY_RE =
  /(^|\s)(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;

const TODAY_RE = /(^|\s)(today|tomorrow)\b/gi;

const PRIORITY_MAP: Record<string, ParsedPriority> = {
  urgent: 1,
  high: 1,
  normal: 2,
  low: 3,
  someday: 4,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
};

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nextWeekday(from: Date, targetDow: number): Date {
  const current = from.getDay();
  // Always move forward: today + (targetDow - current + 7) % 7, but if that
  // lands on 0 (same day), jump a full week so "mon" on a Monday means next
  // Monday rather than today.
  let delta = (targetDow - current + 7) % 7;
  if (delta === 0) delta = 7;
  const out = new Date(from);
  out.setDate(out.getDate() + delta);
  return out;
}

/**
 * Parse a quick-add string into structured fields.
 *
 * The `now` argument is injectable for unit tests; in production it defaults
 * to the current date.
 */
export function parseQuickAdd(input: string, now: Date = new Date()): ParsedQuickAdd {
  const tags: string[] = [];
  let priority: ParsedPriority | null = null;
  let dueDate: string | null = null;

  // We collect matched ranges and strip them from the title in one pass at
  // the end so overlapping/adjacent matches don't leave stray whitespace.
  const ranges: Array<[number, number]> = [];

  // Tags — there can be several, dedupe while preserving order.
  for (const m of input.matchAll(TAG_RE)) {
    const tag = m[2].toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
    const leading = m[1].length;
    const start = (m.index ?? 0) + leading;
    ranges.push([start, start + 1 + m[2].length]);
  }

  // Priority — last one wins, which feels natural ("!low !high" -> high).
  for (const m of input.matchAll(PRIORITY_RE)) {
    const key = m[2].toLowerCase();
    priority = PRIORITY_MAP[key] ?? priority;
    const leading = m[1].length;
    const start = (m.index ?? 0) + leading;
    ranges.push([start, start + 1 + m[2].length]);
  }

  // Due date — first matching token wins (ISO > today/tomorrow > weekday
  // order is arbitrary; whichever appears earliest in the text is used).
  // We still strip every date token we matched so the title is clean.
  type DateCandidate = { start: number; end: number; iso: string };
  const dateCandidates: DateCandidate[] = [];

  for (const m of input.matchAll(ISO_DATE_RE)) {
    const leading = m[1].length;
    const start = (m.index ?? 0) + leading;
    dateCandidates.push({
      start,
      end: start + m[2].length,
      iso: m[2],
    });
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const m of input.matchAll(TODAY_RE)) {
    const word = m[2].toLowerCase();
    const leading = m[1].length;
    const start = (m.index ?? 0) + leading;
    const d = new Date(today);
    if (word === 'tomorrow') d.setDate(d.getDate() + 1);
    dateCandidates.push({
      start,
      end: start + m[2].length,
      iso: toIsoDate(d),
    });
  }

  for (const m of input.matchAll(WEEKDAY_RE)) {
    const word = m[2].toLowerCase();
    const leading = m[1].length;
    const start = (m.index ?? 0) + leading;
    const short = word.slice(0, 3);
    const dow = WEEKDAY_INDEX[short];
    if (dow === undefined) continue;
    const d = nextWeekday(today, dow);
    dateCandidates.push({
      start,
      end: start + m[2].length,
      iso: toIsoDate(d),
    });
  }

  if (dateCandidates.length > 0) {
    dateCandidates.sort((a, b) => a.start - b.start);
    dueDate = dateCandidates[0].iso;
    for (const c of dateCandidates) ranges.push([c.start, c.end]);
  }

  // Build the title by walking the input and skipping matched ranges.
  ranges.sort((a, b) => a[0] - b[0]);
  let title = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue; // overlapping/duplicate matches
    title += input.slice(cursor, start);
    cursor = end;
  }
  title += input.slice(cursor);
  title = title.replace(/\s+/g, ' ').trim();

  return {
    title,
    tags,
    priority: priority === null ? null : String(priority),
    dueDate,
  };
}
