/**
 * Message body markup: detect ```lang fenced blocks and highlight inline.
 *
 * Visual constraint: keep extreme minimalism — no separate code-block boxes,
 * no border, no background. Code lives inline with the rest of the line,
 * just with monochromatic-but-distinct hljs class colors. The font is
 * already JetBrains Mono so prose and code share the same glyphs.
 *
 * Parser rules (deliberately strict for predictability):
 *   - A code block opens on a line matching /^\s*```(\w*)\s*$/.
 *   - It closes on the next line matching /^\s*```\s*$/.
 *   - If no closing fence exists, the entire message is rendered as plain
 *     text — we do NOT try to half-parse.
 *   - Multiple blocks per message are allowed.
 *   - The fence lines themselves are not rendered.
 *
 * Languages are registered lazily. The first 10 common ones are eager so
 * typing `js` / `rust` / `py` etc. works instantly without a network round
 * trip. Unknown languages fall through to plaintext (no highlight).
 */

import hljs from 'highlight.js/lib/core';

import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import rust from 'highlight.js/lib/languages/rust';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('zsh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

const FENCE_OPEN = /^\s*```([a-zA-Z0-9+#_.-]*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

export interface MessageSegment {
  kind: 'text' | 'code';
  /** For code segments: the language tag from the opening fence (may be ''). */
  lang?: string;
  /** Plain text or code body (without the fence lines). */
  body: string;
}

/**
 * Parse a message body into text/code segments. If no valid fenced block
 * exists (or the opener has no closer), the whole input is one text segment.
 */
export function parseMessage(input: string): MessageSegment[] {
  const lines = input.split('\n');
  const segments: MessageSegment[] = [];
  let i = 0;
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      segments.push({ kind: 'text', body: textBuf.join('\n') });
      textBuf = [];
    }
  };

  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN);
    if (open) {
      // Look ahead for a closer.
      let j = i + 1;
      while (j < lines.length && !FENCE_CLOSE.test(lines[j])) j++;
      if (j < lines.length) {
        // Valid fenced block: lines[i+1..j) is the body.
        flushText();
        segments.push({
          kind: 'code',
          lang: open[1] || '',
          body: lines.slice(i + 1, j).join('\n'),
        });
        i = j + 1; // skip past the closing fence
        continue;
      }
      // No closer — fall through and treat the opener line as text.
    }
    textBuf.push(lines[i]);
    i++;
  }

  flushText();
  // If we somehow produced nothing (empty message), return an empty text seg
  // so the renderer still has something to map.
  if (segments.length === 0) segments.push({ kind: 'text', body: '' });
  return segments;
}

/**
 * Highlight a code body. Returns HTML string (already escaped by hljs).
 * Falls back to a pre-escaped plaintext span if the language is unknown.
 */
export function highlight(body: string, lang: string): string {
  const langLower = lang.toLowerCase();
  if (langLower && hljs.getLanguage(langLower)) {
    try {
      return hljs.highlight(body, { language: langLower, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  // Unknown language: return escaped plaintext, no coloring.
  return escapeHtml(body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
