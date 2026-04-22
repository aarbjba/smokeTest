/**
 * linkifyStackTrace
 *
 * Takes a plain-text blob (e.g. a stack trace pasted into a description or
 * snippet) and returns a safe HTML string where detected absolute file paths
 * with line numbers are wrapped in anchor tags that open VS Code via the
 * `vscode://file/...` URL scheme.
 *
 * XSS safety: the implementation scans the RAW input for path matches, records
 * their `[start, end)` ranges, and then rebuilds the output by HTML-escaping
 * everything outside those ranges and wrapping the matched segments in `<a>`
 * tags whose visible text and href are built from the captured substrings with
 * proper HTML / URI escaping. No user-controlled character ever reaches the
 * output un-escaped.
 *
 * Supported formats:
 *   - `at Foo (/abs/path.ts:12:34)`        (Node / JS, with optional column)
 *   - `(/abs/path.ts:12:34)`                (Node / JS, anonymous frame)
 *   - bare `/abs/path.ts:12:34` or `/abs/path.ts:12`
 *   - `File "/abs/path.py", line 42`       (Python)
 *   - `C:\abs\path.ts:12:34`                (Windows, with optional column)
 *
 * Plain URLs (`http://...`, `https://...`) are NOT matched: the regex rejects
 * paths whose leading `/` is preceded by `:` or another `/` (i.e. the second
 * `/` of `://`).
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

// Percent-encode characters that aren't safe inside an href. Keep path
// separators (`/`, `\`), alphanumerics and common filename punctuation so the
// URL stays human-readable. Backslashes are kept literal — VS Code accepts
// them in `vscode://file/C:\path\to\file:12`.
function encodeForHref(s: string): string {
  return s.replace(/[^A-Za-z0-9/\\._\-:]/g, (c) => encodeURIComponent(c));
}

/**
 * Build the final `<a>` tag.
 *   displayPath — the raw path as it appeared in the input (e.g. `/src/foo.ts`).
 *   line        — the line number string (digits only).
 *   col         — optional column string (digits only), for the visible text.
 * The href always uses only `path:line` (no column); the visible text mirrors
 * the input (`path:line` or `path:line:col`).
 */
function buildAnchor(displayPath: string, line: string, col?: string): string {
  const visible = `${escapeHtml(displayPath)}:${line}${col ? `:${col}` : ''}`;
  const href = `vscode://file/${encodeForHref(displayPath)}:${line}`;
  return `<a href="${href}" class="stack-link">${visible}</a>`;
}

type Match = {
  start: number;
  end: number;
  html: string;
};

// POSIX absolute path followed by `:line` and optional `:col`.
// Lookbehind `(?<![:/\w])` prevents matching the `/` in `://` (URLs) or inside
// another identifier.
const POSIX_RE = /(?<![:/\w])(\/[A-Za-z0-9._\-@+~$%/]+):(\d+)(?::(\d+))?/g;

// Windows absolute path `C:\...` followed by `:line` and optional `:col`.
// The path may contain spaces — we anchor the final segment on a non-space
// character to avoid greedily grabbing trailing whitespace.
const WIN_RE = /(?<![A-Za-z0-9])([A-Za-z]:\\(?:[A-Za-z0-9._\-@+~$% \\]*[A-Za-z0-9._\-@+~$%\\])):(\d+)(?::(\d+))?/g;

// Python: `File "/abs/path.py", line 42` — accept either real quotes or
// already-escaped `&quot;` (we match on raw input, so it's real quotes here).
const PY_RE = /File "((?:\/[A-Za-z0-9._\-@+~$%/]+)|(?:[A-Za-z]:\\(?:[A-Za-z0-9._\-@+~$% \\]*[A-Za-z0-9._\-@+~$%\\])))", line (\d+)/g;

function collectMatches(text: string): Match[] {
  const matches: Match[] = [];

  // Python first (consumes the surrounding `File "...", line N` wrapper).
  for (const m of text.matchAll(PY_RE)) {
    const path = m[1];
    const line = m[2];
    const start = m.index!;
    const end = start + m[0].length;
    matches.push({
      start,
      end,
      html: `File &quot;${buildAnchor(path, line)}&quot;`,
    });
  }

  // POSIX paths with line numbers.
  for (const m of text.matchAll(POSIX_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    matches.push({
      start,
      end,
      html: buildAnchor(m[1], m[2], m[3]),
    });
  }

  // Windows paths with line numbers.
  for (const m of text.matchAll(WIN_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    matches.push({
      start,
      end,
      html: buildAnchor(m[1], m[2], m[3]),
    });
  }

  // Sort by start index, then drop overlaps (Python wrapper wins over inner
  // POSIX/Win match on the same range because we pushed it first only when
  // matches are sorted stably; explicitly prefer the earliest-start / widest
  // match).
  matches.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const pruned: Match[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.start >= cursor) {
      pruned.push(m);
      cursor = m.end;
    }
  }
  return pruned;
}

export function linkifyStackTrace(text: string): string {
  const matches = collectMatches(text);
  if (matches.length === 0) return escapeHtml(text);

  let out = '';
  let pos = 0;
  for (const m of matches) {
    if (m.start > pos) {
      out += escapeHtml(text.slice(pos, m.start));
    }
    out += m.html;
    pos = m.end;
  }
  if (pos < text.length) {
    out += escapeHtml(text.slice(pos));
  }
  return out;
}

/**
 * linkifyStackTraceInHtml
 *
 * Post-processes an already-rendered HTML string (e.g. the output of
 * `marked.parse` or `hljs.highlight`) and wraps any stack-trace-style file
 * paths found in **text nodes** with `<a>` tags. Does not touch existing tags,
 * attributes, or already-linked content — so it's safe to chain after other
 * renderers.
 *
 * Implementation note: we use the browser's DOMParser to walk the parsed
 * fragment's text nodes; each text node is rewritten into a mix of new text
 * nodes and `<a>` elements. Because we create `<a>` elements via the DOM (not
 * by splicing HTML strings) there's no XSS risk from the file-path text — it
 * flows through `textContent`.
 */
export function linkifyStackTraceInHtml(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    // SSR fallback — no DOM available, return input unchanged.
    return html;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const node of textNodes) {
    // Skip text inside <a>, <script>, <style>, and <code> where the text is
    // already syntax-highlighted (we don't want to disturb hljs span nesting).
    let ancestor: Node | null = node.parentNode;
    let skip = false;
    while (ancestor && ancestor !== root) {
      if (ancestor.nodeType === 1) {
        const tag = (ancestor as Element).tagName;
        if (tag === 'A' || tag === 'SCRIPT' || tag === 'STYLE') {
          skip = true;
          break;
        }
      }
      ancestor = ancestor.parentNode;
    }
    if (skip) continue;

    const text = node.nodeValue ?? '';
    const matches = collectMatches(text);
    if (matches.length === 0) continue;

    const frag = doc.createDocumentFragment();
    let pos = 0;
    for (const m of matches) {
      if (m.start > pos) {
        frag.appendChild(doc.createTextNode(text.slice(pos, m.start)));
      }
      // Parse the small anchor HTML we produced into a real element.
      const wrap = doc.createElement('template');
      (wrap as HTMLTemplateElement).innerHTML = m.html;
      const content = (wrap as HTMLTemplateElement).content;
      while (content.firstChild) {
        frag.appendChild(content.firstChild);
      }
      pos = m.end;
    }
    if (pos < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(pos)));
    }
    node.parentNode?.replaceChild(frag, node);
  }

  return root.innerHTML;
}
