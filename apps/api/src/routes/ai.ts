import { Router } from 'express';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { db } from '../db.js';

export const aiRouter = Router();

const CLAUDE_CMD = process.env.CLAUDE_CLI ?? 'claude';
const TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 2_000;

const ReformulateSchema = z.object({
  text: z.string().min(1).max(MAX_INPUT_CHARS),
});

interface ReformulateResult {
  title: string;
  description: string;
  tags: string[];
  subtasks: string[];
}

/**
 * Collect the set of tags already in use across active todos. Tags are stored
 * per-todo as a JSON string column, so we parse in JS. Returned most-used first
 * so the LLM's shortlist stays tight.
 */
function collectExistingTags(limit = 60): string[] {
  const rows = db
    .prepare(`SELECT tags FROM todos WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags != ''`)
    .all() as Array<{ tags: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.tags); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const t of parsed) {
      if (typeof t !== 'string') continue;
      const norm = t.trim();
      if (!norm) continue;
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/**
 * Run `claude -p --model haiku --output-format text` with a prompt piped on
 * stdin (avoids argv escaping). Haiku is the cheapest Claude model; we use
 * one-shot print mode since we don't need a session.
 */
function runClaudeHaiku(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_CMD,
      ['-p', '--model', 'haiku', '--output-format', 'text'],
      { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(Object.assign(new Error('AI call timed out'), { status: 504 }));
    }, TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`Claude CLI not runnable: ${err.message}`), { status: 500 }));
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(Object.assign(
          new Error(`Claude CLI exited ${code}: ${stderr.trim() || 'no output'}`),
          { status: 502 },
        ));
      }
      resolve(stdout);
    });

    child.stdin?.end(prompt, 'utf8');
  });
}

/**
 * Claude may return raw JSON, fenced JSON (```json ... ```), or prose around it.
 * Extract the first {...} block and parse it. Falls back to using the whole
 * output as the title if no JSON can be parsed.
 */
function parseReformulateOutput(raw: string, original: string): ReformulateResult {
  const cleaned = raw.trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as {
        title?: unknown;
        description?: unknown;
        tags?: unknown;
        subtasks?: unknown;
      };
      const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : original;
      const description = typeof obj.description === 'string' ? obj.description.trim() : '';
      const tags = Array.isArray(obj.tags)
        ? obj.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().replace(/^#/, ''))
            .filter(Boolean)
            .slice(0, 10)
        : [];
      const subtasks = Array.isArray(obj.subtasks)
        ? obj.subtasks
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      return { title, description, tags, subtasks };
    } catch {
      // fall through
    }
  }
  // No parseable JSON — treat the whole (short) response as a reformulated title.
  const oneLine = cleaned.split(/\r?\n/).find((l) => l.trim()) ?? original;
  return { title: oneLine.trim().slice(0, 500) || original, description: '', tags: [], subtasks: [] };
}

aiRouter.post('/reformulate-todo', async (req, res, next) => {
  try {
    const { text } = ReformulateSchema.parse(req.body);
    const existingTags = collectExistingTags();

    // Preprompt. Tag handling is the important bit: the model sees the list of
    // tags already in use and is told in no uncertain terms to reuse them —
    // new tags only as a last resort. Otherwise every run drifts the tag set.
    const tagSection = existingTags.length > 0
      ? [
          'Bestehende Tags (nutze bevorzugt diese, damit der Tag-Pool nicht zerfasert):',
          existingTags.map((t) => `- ${t}`).join('\n'),
          '',
          'Regeln für Tags:',
          '- Wähle 0–3 passende Tags AUSSCHLIESSLICH aus der obigen Liste, wenn möglich.',
          '- Nur im Notfall (wirklich kein bestehender Tag passt) darfst du EINEN neuen Tag erfinden — kurz, lowercase, ohne "#".',
          '- Wenn nichts passt, liefere eine leere Liste. Lieber keine Tags als schlechte Tags.',
        ].join('\n')
      : [
          'Es existieren noch keine Tags. Wenn ein Tag offensichtlich passt, schlage maximal einen kurzen, lowercase Tag vor. Sonst leere Liste.',
        ].join('\n');

    const prompt = [
      'Du bist ein Assistent, der rohe Todo-Eingaben in klare, prägnante Aufgaben umschreibt.',
      'Behalte die Sprache der Eingabe bei (Deutsch bleibt Deutsch, Englisch bleibt Englisch).',
      '',
      'Liefere für jede Eingabe:',
      '1. title: kurzer, klarer Titel (wie bisher).',
      '2. description: 1–3 Sätze, die Ziel und Kontext der Aufgabe zusammenfassen. Leerstring wenn die Eingabe bereits alles Nötige sagt.',
      '3. tags: siehe Tag-Regeln unten.',
      '4. subtasks: 0–6 kleine Umsetzungsschritte (leere Liste wenn nicht sinnvoll).',
      '',
      tagSection,
      '',
      'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau diesem Format – ohne Code-Fence, ohne Kommentar, ohne zusätzlichen Text:',
      '{"title": "<reformulierter Titel>", "description": "<kurze Beschreibung oder leer>", "tags": ["<tag1>"], "subtasks": ["<schritt 1>", "<schritt 2>"]}',
      '',
      'Eingabe:',
      text,
    ].join('\n');

    const raw = await runClaudeHaiku(prompt);
    const result = parseReformulateOutput(raw, text);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
