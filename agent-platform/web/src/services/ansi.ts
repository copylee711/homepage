/**
 * Safe ANSI escape code parser and stripper for Linux Sandbox Virtual Terminal.
 * Converts ANSI color escape sequences into safe HTML spans.
 */

const ANSI_REGEX = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[A-Za-z]|\x1b\([AB0-2]|\x1b\[\?[0-9]+[hl]/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripAnsi(raw: string): string {
  return String(raw || '').replace(
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\([AB0-2]|\x1b\[\?[0-9]+[hl]|[\x00-\x08\x0b-\x1f\x7f]/g,
    ''
  );
}

export function renderAnsiToHtml(raw: string): string {
  if (!raw) return '';
  const text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '');

  let html = '';
  let lastIndex = 0;
  let currentColor = '';
  let isBold = false;
  let openSpan = false;

  let match: RegExpExecArray | null;
  ANSI_REGEX.lastIndex = 0;
  while ((match = ANSI_REGEX.exec(text)) !== null) {
    const textChunk = text.slice(lastIndex, match.index);
    if (textChunk) {
      // Strip any stray control characters
      html += escapeHtml(textChunk.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
    }
    lastIndex = ANSI_REGEX.lastIndex;

    const codeStr = match[1];
    if (codeStr !== undefined) {
      const codes = codeStr.split(';').map(c => parseInt(c, 10) || 0);
      for (const code of codes) {
        if (code === 0) {
          if (openSpan) { html += '</span>'; openSpan = false; }
          currentColor = '';
          isBold = false;
        } else if (code === 1) {
          isBold = true;
        } else if (code === 30) currentColor = 'term-c-black';
        else if (code === 31 || code === 91) currentColor = 'term-c-red';
        else if (code === 32 || code === 92) currentColor = 'term-c-green';
        else if (code === 33 || code === 93) currentColor = 'term-c-yellow';
        else if (code === 34 || code === 94) currentColor = 'term-c-blue';
        else if (code === 35 || code === 95) currentColor = 'term-c-magenta';
        else if (code === 36 || code === 96) currentColor = 'term-c-cyan';
        else if (code === 37 || code === 97) currentColor = 'term-c-white';
        else if (code === 39) currentColor = '';
      }

      if (openSpan) { html += '</span>'; openSpan = false; }
      const classes = [currentColor, isBold ? 'term-bold' : ''].filter(Boolean);
      if (classes.length) {
        html += `<span class="${classes.join(' ')}">`;
        openSpan = true;
      }
    }
  }

  const remaining = text.slice(lastIndex);
  if (remaining) {
    html += escapeHtml(remaining.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  }
  if (openSpan) {
    html += '</span>';
  }
  return html;
}
