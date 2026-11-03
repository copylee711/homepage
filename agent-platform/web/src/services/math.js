/* Math rendering via locally bundled KaTeX. Ported from dsh-better-display's dollar
   handling: tell real math from currency with Pandoc's tex_math_dollars rule, so
   prices like "$2 / $10" never become KaTeX. KaTeX builds its own DOM; we insert it
   as nodes and never parse untrusted HTML. */

let katexPromise = null;
function loadKatex() {
  if (!katexPromise) katexPromise = import('katex').then(m => m.default || m).catch(() => null);
  return katexPromise;
}
// Warm the import early so first render is instant.
export function preloadMath() { void loadKatex(); }

let katex = null;
void loadKatex().then(mod => { katex = mod; });

function isSpace(ch) { return ch === undefined || /\s/.test(ch); }
function isDigit(ch) { return ch !== undefined && ch >= '0' && ch <= '9'; }

// Index of a valid closing `$` for an opener at `open`, or -1 when there is none.
function closingDollar(line, open) {
  for (let i = open + 1; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') return -1;
    if (ch !== '$') continue;
    if (line[i + 1] === '$') return -1;
    if (!isSpace(line[i - 1]) && !isDigit(line[i + 1])) return i;
  }
  return -1;
}

/* Split a single line into literal text and inline-math segments. Accepts `$…$`
   and LaTeX-style `\(…\)` (models often emit the latter). Only `$…$` where the
   opener is followed by non-space and the closer preceded by non-space (and not
   followed by a digit) counts as math. Also handles LLM-emitted unescaped
   `(\operatorname{...})` formulas with explicit LaTeX macros. */
export function splitInlineMath(line) {
  if (!line.includes('$') && !line.includes('\\(') && !line.includes('\\')) return [{ text: line }];
  const parts = [];
  let buffer = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '(') {
      const close = findInlineParen(line, i + 2);
      if (close > i + 2) {
        if (buffer) { parts.push({ text: buffer }); buffer = ''; }
        parts.push({ math: line.slice(i + 2, close) });
        i = close + 2; continue;
      }
    }
    if (ch === '(' && line.slice(i).includes('\\')) {
      const close = findMatchingParen(line, i + 1);
      if (close > i + 1) {
        const candidate = line.slice(i + 1, close);
        if (/\\(operatorname|frac|dfrac|boxed|sqrt|sum|int|lim|mathbf|mathrm|vec|partial|cdot|alpha|beta|gamma|theta|pi|le|ge|neq|approx|infty)\b/.test(candidate) && !candidate.includes('\n')) {
          if (buffer) { parts.push({ text: buffer }); buffer = ''; }
          parts.push({ math: candidate.trim() });
          i = close + 1;
          continue;
        }
      }
    }
    if (ch === '\\' && line[i + 1] === '$') { buffer += '$'; i += 2; continue; }
    if (ch === '\\') { buffer += line.slice(i, i + 2); i += 2; continue; }
    if (ch === '`') { // skip a code span verbatim
      const run = /^`+/.exec(line.slice(i))[0];
      const end = line.indexOf(run, i + run.length);
      const stop = end === -1 ? line.length : end + run.length;
      buffer += line.slice(i, stop); i = stop; continue;
    }
    if (ch === '$' && line[i + 1] !== '$' && !isSpace(line[i + 1])) {
      const close = closingDollar(line, i);
      if (close > i + 1) {
        if (buffer) { parts.push({ text: buffer }); buffer = ''; }
        parts.push({ math: line.slice(i + 1, close) });
        i = close + 1; continue;
      }
    }
    buffer += ch; i += 1;
  }
  if (buffer) parts.push({ text: buffer });
  return parts;
}

// Balance nested parentheses and braces so formulas like `(\operatorname{Cov}(X,Y)=\dfrac2\pi)`
// find the correct outermost closing parenthesis.
function findMatchingParen(line, from) {
  let depth = 1;
  let inBrace = 0;
  for (let i = from; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') return -1;
    if (ch === '{') { inBrace += 1; continue; }
    if (ch === '}') { if (inBrace > 0) inBrace -= 1; continue; }
    if (inBrace === 0) {
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

// Index of the `\` in a closing `\)` at or after `from`, or -1.
function findInlineParen(line, from) {
  for (let i = from; i < line.length - 1; i += 1) {
    if (line[i] === '`') return -1;
    if (line[i] === '\\') {
      if (line[i + 1] === ')') return i;
      i += 1;
    }
  }
  return -1;
}

/* Scan block lines, pulling out `$$ … $$` display math (on their own lines or inline).
   Returns a list of { type:'text', lines } and { type:'math', tex } blocks so the Markdown
   parser only sees non-math text. */
export function extractDisplayMath(lines) {
  const blocks = [];
  let text = [];
  const flush = () => { if (text.length) { blocks.push({ type: 'text', lines: text }); text = []; } };
  let fence = null;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    if (fence) { text.push(line); if (line.trimStart().startsWith(fence)) fence = null; continue; }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1].slice(0, 3); text.push(line); continue; }
    const trimmed = line.trim();
    // Whole-line $$ … $$ (single line) or opening $$ that spans following lines.
    if (trimmed.startsWith('$$')) {
      const rest = trimmed.slice(2);
      if (rest.endsWith('$$') && rest.length > 2) { flush(); blocks.push({ type: 'math', tex: rest.slice(0, -2).trim() }); continue; }
      if (rest === '' || !rest.includes('$$')) {
        const body = rest === '' ? [] : [rest];
        let m = n + 1; let closed = false;
        while (m < lines.length) {
          const t = lines[m].trim();
          if (t.endsWith('$$')) { if (t.length > 2) body.push(t.slice(0, -2)); closed = true; break; }
          body.push(lines[m]); m += 1;
        }
        if (closed) { flush(); blocks.push({ type: 'math', tex: body.join('\n').trim() }); n = m; continue; }
      }
    }
    // LaTeX display delimiters \[ … \] behave exactly like $$ … $$.
    if (trimmed.startsWith('\\[')) {
      const rest = trimmed.slice(2);
      if (rest.endsWith('\\]') && rest.length > 2) { flush(); blocks.push({ type: 'math', tex: rest.slice(0, -2).trim() }); continue; }
      if (rest === '' || !rest.includes('\\]')) {
        const body = rest === '' ? [] : [rest];
        let m = n + 1; let closed = false;
        while (m < lines.length) {
          const t = lines[m].trim();
          if (t.endsWith('\\]')) { if (t.length > 2) body.push(t.slice(0, -2)); closed = true; break; }
          body.push(lines[m]); m += 1;
        }
        if (closed) { flush(); blocks.push({ type: 'math', tex: body.join('\n').trim() }); n = m; continue; }
      }
    }
    // Standalone unescaped [ ... ] emitted by some LLMs as display math blocks.
    if (trimmed === '[' || (trimmed.startsWith('[') && !trimmed.startsWith('[^') && !trimmed.startsWith('![') && trimmed.endsWith(']'))) {
      if (trimmed !== '[' && trimmed.endsWith(']')) {
        const inner = trimmed.slice(1, -1).trim();
        if (/\\(boxed|frac|dfrac|sum|int|sqrt|operatorname|text|begin|align|matrix|lim|mathbf|mathrm|vec|partial|alpha|beta|gamma|theta|pi|infty)\b/.test(inner)) {
          flush();
          blocks.push({ type: 'math', tex: inner });
          continue;
        }
      } else if (trimmed === '[') {
        const body = [];
        let m = n + 1;
        let closed = false;
        while (m < lines.length) {
          const t = lines[m].trim();
          if (t === ']') { closed = true; break; }
          body.push(lines[m]);
          m += 1;
        }
        const candidate = body.join('\n').trim();
        if (closed && /\\(boxed|frac|dfrac|sum|int|sqrt|operatorname|text|begin|align|matrix|lim|mathbf|mathrm|vec|partial|alpha|beta|gamma|theta|pi|infty|[a-zA-Z]{2,})\b/.test(candidate)) {
          flush();
          blocks.push({ type: 'math', tex: candidate });
          n = m;
          continue;
        }
      }
    }
    text.push(line);
  }
  flush();
  return blocks;
}

export function renderMathInto(node, tex, display) {
  if (katex) {
    try { katex.render(tex, node, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', trust: false }); return; }
    catch { /* fall through */ }
  }
  // KaTeX not ready yet (or failed): show the source, then upgrade when it loads.
  node.textContent = (display ? '$$' : '$') + tex + (display ? '$$' : '$');
  node.classList.add('md-math-pending');
  void loadKatex().then(mod => {
    if (!mod || !node.isConnected) return;
    katex = katex || mod;
    try { node.classList.remove('md-math-pending'); node.textContent = ''; mod.render(tex, node, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', trust: false }); }
    catch { /* leave source */ }
  });
}
