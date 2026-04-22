import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

export const attachmentsRouter = Router();

const ATTACH_ROOT = resolve(process.cwd(), process.env.DB_PATH ?? './data/werkbank.db', '..', 'attachments');
mkdirSync(ATTACH_ROOT, { recursive: true });

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function kindFor(mime: string, filename: string): string {
  const m = (mime || '').toLowerCase();
  const ext = extname(filename).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    m.startsWith('text/') ||
    /^application\/(json|xml|javascript|typescript|x-sh|x-yaml|x-httpd-php)$/.test(m) ||
    ['.txt', '.log', '.md', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.xml', '.html', '.css', '.scss', '.vue', '.py', '.rb', '.go', '.rs', '.cs', '.java', '.kt', '.sh', '.bash', '.ps1', '.sql', '.eml'].includes(ext)
  ) return 'text';
  if (/zip|tar|gzip|bzip|rar|7z/.test(m) || ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return 'archive';
  if (
    m.includes('officedocument') ||
    m.includes('msword') ||
    m === 'application/vnd.ms-outlook' ||
    ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.msg'].includes(ext)
  ) return 'office';
  return 'other';
}

type AttachmentRow = {
  id: number;
  todo_id: number;
  filename: string;
  storage_name: string;
  size: number;
  mime: string;
  kind: string;
  created_at: string;
};

function pathFor(todoId: number, storageName: string): string {
  return join(ATTACH_ROOT, String(todoId), storageName);
}

/**
 * Resolve a list of attachment IDs (scoped to a todo) into their absolute
 * on-disk paths plus display metadata. Used by the Claude-agent service to
 * inject an "Attached files" preamble so the LLM can read them via its Read
 * tool. Silently skips IDs that don't belong to the todo or whose file has
 * been deleted on disk — the agent should not fail because of a stale UI state.
 */
export function resolveAttachmentPaths(
  todoId: number,
  ids: number[],
): Array<{ id: number; filename: string; absPath: string; mime: string; kind: string }> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  // Query one at a time to preserve caller order and keep the SQL trivial —
  // the list is tiny (dozens at most) and we run locally.
  const stmt = db.prepare(`SELECT * FROM attachments WHERE id = ? AND todo_id = ?`);
  const out: Array<{ id: number; filename: string; absPath: string; mime: string; kind: string }> = [];
  for (const id of ids) {
    const row = stmt.get(id, todoId) as AttachmentRow | undefined;
    if (!row) continue;
    const absPath = pathFor(row.todo_id, row.storage_name);
    if (!existsSync(absPath)) continue;
    out.push({ id: row.id, filename: row.filename, absPath, mime: row.mime, kind: row.kind });
  }
  return out;
}

// Multer: disk storage, per-todo sub-directory, UUID filenames.
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const todoId = Number(req.params.todoId);
    const dir = join(ATTACH_ROOT, String(todoId));
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, _file, cb) {
    cb(null, randomUUID());
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

attachmentsRouter.post(
  '/by-todo/:todoId',
  (req: Request, res: Response, next: NextFunction) => {
    const todoId = Number(req.params.todoId);
    const todo = db.prepare(`SELECT id FROM todos WHERE id = ?`).get(todoId);
    if (!todo) return res.status(404).json({ error: 'Todo not found' });
    upload.array('files', 20)(req, res, (err) => {
      if (err) return next(err);
      // Wrap the DB work in try/catch — this callback is invoked from a
      // WriteStream event inside multer, which is OUTSIDE Express' error
      // handling path. An uncaught throw here crashes the Node process. We
      // route failures through next(err) so the global error middleware can
      // respond with JSON instead.
      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        const insert = db.prepare(
          `INSERT INTO attachments (todo_id, filename, storage_name, size, mime, kind)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        const created: AttachmentRow[] = [];
        for (const f of files) {
          const info = insert.run(
            todoId,
            f.originalname,
            f.filename,
            f.size,
            f.mimetype || 'application/octet-stream',
            kindFor(f.mimetype, f.originalname),
          );
          const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(info.lastInsertRowid) as AttachmentRow;
          created.push(row);
        }
        res.status(201).json(created);
      } catch (dbErr) {
        next(dbErr);
      }
    });
  },
);

attachmentsRouter.get('/by-todo/:todoId', (req, res) => {
  const todoId = Number(req.params.todoId);
  const rows = db.prepare(
    `SELECT * FROM attachments WHERE todo_id = ? ORDER BY created_at DESC, id DESC`
  ).all(todoId) as AttachmentRow[];
  res.json(rows);
});

function streamAttachment(req: Request, res: Response, inline: boolean) {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const file = pathFor(row.todo_id, row.storage_name);
  if (!existsSync(file)) return res.status(410).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  // RFC 5987 encoding for non-ASCII filenames.
  const encoded = encodeURIComponent(row.filename);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${row.filename.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`,
  );
  res.sendFile(file);
}

attachmentsRouter.get('/:id/download', (req, res) => streamAttachment(req, res, false));
attachmentsRouter.get('/:id/preview', (req, res) => streamAttachment(req, res, true));

attachmentsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const file = pathFor(row.todo_id, row.storage_name);
  try { if (existsSync(file)) unlinkSync(file); } catch { /* tolerate missing */ }
  db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
  // Clean up empty per-todo folder
  try { rmSync(join(ATTACH_ROOT, String(row.todo_id)), { recursive: false }); } catch { /* non-empty or missing */ }
  res.status(204).end();
});
