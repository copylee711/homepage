/* Compact, dependency-free syntax highlighting. Tokenizes with a small regex set and
   emits <span class="tok-*"> nodes only — never parses HTML. Covers the languages the
   agent emits most (js/ts, py, json, shell, css, html-ish, c-like). Unknown languages
   render as plain text. Kept intentionally light to avoid a 1 MB highlight.js payload. */

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default await async yield try catch finally throw typeof instanceof in of void delete null true false undefined',
  ts: 'const let var function return if else for while do switch case break continue new class extends super this import export from default await async yield try catch finally throw typeof instanceof in of void delete null true false undefined interface type enum implements public private protected readonly as keyof namespace declare',
  py: 'def class return if elif else for while break continue import from as pass lambda with try except finally raise yield global nonlocal assert del in is not and or None True False async await match case',
  go: 'func package import return if else for range switch case break continue type struct interface map chan go defer var const nil true false',
  rust: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return break continue self Self where as dyn ref move async await true false None Some Ok Err',
  c: 'int char float double void long short unsigned signed struct union enum typedef static const return if else for while do switch case break continue sizeof goto default extern volatile',
  sh: 'if then else elif fi for while do done case esac function return in export local echo cd read set unset source',
};
KEYWORDS.javascript = KEYWORDS.js; KEYWORDS.typescript = KEYWORDS.ts; KEYWORDS.jsx = KEYWORDS.js; KEYWORDS.tsx = KEYWORDS.ts;
KEYWORDS.python = KEYWORDS.py; KEYWORDS.bash = KEYWORDS.sh; KEYWORDS.shell = KEYWORDS.sh; KEYWORDS.zsh = KEYWORDS.sh;
KEYWORDS.cpp = KEYWORDS.c + ' namespace class public private protected template new delete this nullptr using virtual override';
KEYWORDS.java = 'public private protected class interface extends implements static final void int long double float boolean char return if else for while do switch case break continue new this super import package try catch finally throw throws null true false abstract';

function wordSet(language) {
  const key = (language || '').toLowerCase();
  const list = KEYWORDS[key];
  return list ? new Set(list.split(' ')) : null;
}

// Ordered token matchers. First match wins at each position.
function tokenize(code, keywords, language) {
  const out = [];
  let i = 0;
  const push = (cls, text) => out.push({ cls, text });
  const hash = language && /^(py|python|sh|bash|shell|zsh|rb|ruby|yaml|yml|toml|ini)$/.test(language);
  while (i < code.length) {
    const rest = code.slice(i);
    // line comment
    let m;
    if ((m = /^(\/\/[^\n]*)/.exec(rest)) || (hash && (m = /^(#[^\n]*)/.exec(rest)))) { push('com', m[1]); i += m[1].length; continue; }
    if ((m = /^(\/\*[\s\S]*?\*\/)/.exec(rest))) { push('com', m[1]); i += m[1].length; continue; }
    // strings (double, single, backtick/triple)
    if ((m = /^("""[\s\S]*?"""|'''[\s\S]*?''')/.exec(rest)) ||
        (m = /^("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/.exec(rest))) { push('str', m[1]); i += m[1].length; continue; }
    // numbers
    if ((m = /^(0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/.exec(rest))) { push('num', m[1]); i += m[1].length; continue; }
    // identifiers / keywords / function calls
    if ((m = /^([A-Za-z_$][\w$]*)/.exec(rest))) {
      const word = m[1];
      if (keywords && keywords.has(word)) push('kw', word);
      else if (code[i + word.length] === '(') push('fn', word);
      else push(null, word);
      i += word.length; continue;
    }
    // whitespace run
    if ((m = /^(\s+)/.exec(rest))) { push(null, m[1]); i += m[1].length; continue; }
    // punctuation
    if ((m = /^([{}()[\].,;:=+\-*/%<>!&|^~?]+)/.exec(rest))) { push('punc', m[1]); i += m[1].length; continue; }
    push(null, code[i]); i += 1;
  }
  return out;
}

/* Append highlighted tokens to `codeElement` (a <code>). Returns true when highlighting
   was applied, false when the language is unknown (caller keeps plain textContent). */
export function highlightInto(codeElement, code, language) {
  const keywords = wordSet(language);
  const key = (language || '').toLowerCase();
  const known = keywords || /^(json|css|scss|less|html|xml|svg|yaml|yml|toml|ini|md|markdown|sql|diff)$/.test(key);
  if (!known) { codeElement.textContent = code; return false; }
  const doc = codeElement.ownerDocument;
  codeElement.replaceChildren();
  if (key === 'json' || key === 'css' || key === 'scss' || key === 'less') {
    // JSON/CSS: strings, numbers, punctuation, property keys.
    for (const token of tokenize(code, null, key)) appendToken(doc, codeElement, token);
    return true;
  }
  for (const token of tokenize(code, keywords, key)) appendToken(doc, codeElement, token);
  return true;
}

function appendToken(doc, parent, token) {
  if (!token.cls) { parent.append(doc.createTextNode(token.text)); return; }
  const span = doc.createElement('span');
  span.className = 'tok-' + token.cls;
  span.textContent = token.text;
  parent.append(span);
}
