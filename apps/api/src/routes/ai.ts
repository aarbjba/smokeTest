import { Router } from 'express';
import { spawn } from 'node:child_process';
import { z } from 'zod';

export const aiRouter = Router();

const CLAUDE_CMD = process.env.CLAUDE_CLI ?? 'claude';
const TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 2_000;

const ReformulateSchema = z.object({
  text: z.string().min(1).max(MAX_INPUT_CHARS),
});

interface ReformulateResult {
  title: string;
  subtasks: string[];
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
      const obj = JSON.parse(match[0]) as { title?: unknown; subtasks?: unknown };
      const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : original;
      const subtasks = Array.isArray(obj.subtasks)
        ? obj.subtasks
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      return { title, subtasks };
    } catch {
      // fall through
    }
  }
  // No parseable JSON — treat the whole (short) response as a reformulated title.
  const oneLine = cleaned.split(/\r?\n/).find((l) => l.trim()) ?? original;
  return { title: oneLine.trim().slice(0, 500) || original, subtasks: [] };
}

aiRouter.post('/reformulate-todo', async (req, res, next) => {
  try {
    const { text } = ReformulateSchema.parse(req.body);

    const prompt = [
      'Du bist ein Assistent, der rohe Todo-Eingaben in klare, prägnante Aufgaben umschreibt.',
      'Behalte die Sprache der Eingabe bei (Deutsch bleibt Deutsch, Englisch bleibt Englisch).',
      'Zerlege die Aufgabe falls sinnvoll in 2–6 kleine Subtasks (sonst leere Liste).',
      '',
      'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau diesem Format – ohne Code-Fence, ohne Kommentar, ohne zusätzlichen Text:',
      '{"title": "<reformulierter Titel>", "subtasks": ["<schritt 1>", "<schritt 2>"]}',
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
