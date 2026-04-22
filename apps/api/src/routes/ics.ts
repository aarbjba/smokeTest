import { Router, type Request, type Response } from 'express';
import { db } from '../db.js';

export const icsRouter = Router();

type TodoIcsRow = {
  id: number;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'test' | 'done';
  due_date: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Escape a text value per RFC 5545 §3.3.11:
 * - Backslashes, commas, and semicolons must be escaped.
 * - Newlines must be encoded as the literal two-char sequence `\n`.
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/**
 * Format a date (either an ISO 8601 string or a SQLite `YYYY-MM-DD HH:MM:SS`
 * timestamp stored as UTC) into RFC 5545 basic UTC form: `YYYYMMDDTHHMMSSZ`.
 * Returns null for unparseable inputs.
 */
function toIcsUtc(input: string): string | null {
  // SQLite default `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` in UTC
  // without a `T` or `Z`. Normalize to an ISO parseable form.
  const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input)
    ? input.replace(' ', 'T') + 'Z'
    : input;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * RFC 5545 §3.1 line folding: lines longer than 75 octets MUST be split on
 * octet boundaries by inserting CRLF followed by a single whitespace (we use
 * a regular space). We approximate octets with UTF-8 byte length.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let offset = 0;
  // First chunk: up to 75 octets. Subsequent chunks: up to 74 octets
  // (the leading space counts as one octet of the folded line).
  let limit = 75;
  while (offset < bytes.length) {
    // Find a safe slice that does not split a multi-byte UTF-8 sequence.
    let end = Math.min(offset + limit, bytes.length);
    while (end > offset && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
      end--;
    }
    chunks.push(bytes.slice(offset, end).toString('utf8'));
    offset = end;
    limit = 74;
  }
  return chunks.join('\r\n ');
}

function buildVEvent(todo: TodoIcsRow): string[] {
  const dtstart = toIcsUtc(todo.due_date!);
  if (!dtstart) return [];

  // 1-hour event as specified.
  const startMs = new Date(
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(todo.due_date!)
      ? todo.due_date!.replace(' ', 'T') + 'Z'
      : todo.due_date!,
  ).getTime();
  const dtend = toIcsUtc(new Date(startMs + 60 * 60 * 1000).toISOString())!;

  const dtstamp = toIcsUtc(todo.updated_at) ?? toIcsUtc(new Date().toISOString())!;
  const status = todo.status === 'done' ? 'COMPLETED' : 'CONFIRMED';

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:todo-${todo.id}@werkbank.local`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeIcsText(todo.title)}`,
  ];
  if (todo.description && todo.description.trim().length > 0) {
    lines.push(`DESCRIPTION:${escapeIcsText(todo.description)}`);
  }
  lines.push(`STATUS:${status}`);
  lines.push('END:VEVENT');
  return lines.map(foldLine);
}

icsRouter.get('/ics.ics', (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT id, title, description, status, due_date, created_at, updated_at
       FROM todos
       WHERE due_date IS NOT NULL AND due_date != '' AND deleted_at IS NULL
       ORDER BY due_date ASC`,
    )
    .all() as TodoIcsRow[];

  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//werkbank//todos//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:werkbank',
  ];
  const footer = ['END:VCALENDAR'];

  const body = rows.flatMap(buildVEvent);
  const all = [...header, ...body, ...footer];

  // RFC 5545 mandates CRLF between content lines and requires a trailing CRLF.
  const payload = all.join('\r\n') + '\r\n';

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="werkbank.ics"');
  res.send(payload);
});
