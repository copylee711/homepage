/* Compact, dependency-free syntax highlighting. Tokenizes with a small regex set and
   emits <span class="tok-*"> nodes only — never parses HTML. Covers JS/TS/Vue, Python,
   JSON, Shell, HTML/XML/SVG, CSS/SCSS, Go, Rust, C/C++, Java, SQL, YAML, TOML, Diff. */

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default await async yield try catch finally throw typeof instanceof in of void delete null true false undefined',
  ts: 'const let var function return if else for while do switch case break continue new class extends super this import export from default await async yield try catch finally throw typeof instanceof in of void delete null true false undefined interface type enum implements public private protected readonly as keyof namespace declare any unknown never string number boolean symbol bigint',
  py: 'def class return if elif else for while break continue import from as pass lambda with try except finally raise yield global nonlocal assert del in is not and or None True False async await match case self',
  go: 'func package import return if else for range switch case break continue type struct interface map chan go defer var const nil true false select default fallthrough',
  rust: 'fn let mut const static struct enum impl trait pub use mod match if else for while loop return break continue self Self super crate where as dyn ref move async await unsafe extern type true false None Some Ok Err',
  c: 'int char float double void long short unsigned signed struct union enum typedef static const return if else for while do switch case break continue sizeof goto default extern volatile inline restrict bool true false NULL size_t uint8_t uint16_t uint32_t uint64_t int32_t int64_t',
  sh: 'if then else elif fi for while do done case esac function return in export local readonly declare echo printf cd pwd ls rm cp mv mkdir cat grep sed awk find xargs read set unset shift source exit trap true false',
  sql: 'select from where insert into values update set delete create drop alter table index view join inner left right full outer on as and or not null is in between like exists group by order asc desc having limit offset distinct union all case when then else end primary key foreign references default constraint begin commit rollback transaction',
  ruby: 'def class module end if elsif else unless while until for in do return break next yield begin rescue ensure raise self super nil true false and or not require include extend attr_accessor attr_reader',
};
KEYWORDS.javascript = KEYWORDS.js;
KEYWORDS.mjs = KEYWORDS.js;
KEYWORDS.cjs = KEYWORDS.js;
KEYWORDS.jsx = KEYWORDS.js;
KEYWORDS.typescript = KEYWORDS.ts;
KEYWORDS.tsx = KEYWORDS.ts;
KEYWORDS.vue = KEYWORDS.ts;
KEYWORDS.python = KEYWORDS.py;
KEYWORDS.bash = KEYWORDS.sh;
KEYWORDS.shell = KEYWORDS.sh;
KEYWORDS.zsh = KEYWORDS.sh;
KEYWORDS.rs = KEYWORDS.rust;
KEYWORDS.rb = KEYWORDS.ruby;
KEYWORDS.cpp = KEYWORDS.c + ' namespace class public private protected template typename new delete this nullptr using virtual override final constexpr noexcept auto std';
KEYWORDS.cc = KEYWORDS.cpp;
KEYWORDS.cxx = KEYWORDS.cpp;
KEYWORDS.hpp = KEYWORDS.cpp;
KEYWORDS.h = KEYWORDS.cpp;
KEYWORDS.java = 'public private protected class interface record enum extends implements static final void int long double float boolean char byte short return if else for while do switch case break continue default new this super import package try catch finally throw throws null true false abstract synchronized volatile transient var';

const KNOWN_LANGS = new Set([
  ...Object.keys(KEYWORDS),
  'json', 'jsonc', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'dockerfile', 'makefile', 'diff', 'patch',
]);

function wordSet(language) {
  const key = (language || '').toLowerCase();
  const list = KEYWORDS[key];
  return list ? new Set(list.split(' ')) : null;
}

function tokenizeMarkup(code) {
  const out = [];
  let i = 0;
  const push = (cls, text) => out.push({ cls, text });
  while (i < code.length) {
    const rest = code.slice(i);
    let m;
    if ((m = /^(<!--[\s\S]*?-->)/.exec(rest))) { push('com', m[1]); i += m[1].length; continue; }
    if ((m = /^(<!DOCTYPE[^>]*>)/i.exec(rest))) { push('kw', m[1]); i += m[1].length; continue; }
    if ((m = /^(<\/?[A-Za-z][\w:-]*)/.exec(rest))) {
      push('tag', m[1]);
      i += m[1].length;
      while (i < code.length) {
        const tagRest = code.slice(i);
        let tm;
        if ((tm = /^(\s+)/.exec(tagRest))) { push(null, tm[1]); i += tm[1].length; continue; }
        if ((tm = /^(\/?>)/.exec(tagRest))) { push('tag', tm[1]); i += tm[1].length; break; }
        if ((tm = /^([@:#v-]?[A-Za-z_][\w:.-]*)/.exec(tagRest))) { push('attr', tm[1]); i += tm[1].length; continue; }
        if ((tm = /^(=)/.exec(tagRest))) { push('punc', tm[1]); i += 1; continue; }
        if ((tm = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(tagRest))) { push('str', tm[1]); i += tm[1].length; continue; }
        push(null, code[i]); i += 1; break;
      }
      continue;
    }
    const nextLt = rest.indexOf('<', 1);
    const chunk = nextLt === -1 ? rest : rest.slice(0, nextLt);
    push(null, chunk);
    i += chunk.length;
  }
  return out;
}

// Ordered token matchers. First match wins at each position.
function tokenize(code, keywords, language) {
  if (/^(html|htm|xml|svg)$/.test(language)) return tokenizeMarkup(code);
  const out = [];
  let i = 0;
  const push = (cls, text) => out.push({ cls, text });
  const hash = /^(py|python|sh|bash|shell|zsh|rb|ruby|yaml|yml|toml|ini|conf|env|dockerfile|makefile)$/.test(language);
  const sqlComment = language === 'sql';
  const caseInsensitiveKw = language === 'sql';
  const isJson = language === 'json' || language === 'jsonc';
  const isYamlToml = /^(yaml|yml|toml|ini|conf|env)$/.test(language);
  const isDiff = language === 'diff' || language === 'patch';

  if (isDiff) {
    const lines = code.split('\n');
    lines.forEach((line, idx) => {
      const text = idx < lines.length - 1 ? line + '\n' : line;
      if (line.startsWith('+') && !line.startsWith('+++')) push('str', text);
      else if (line.startsWith('-') && !line.startsWith('---')) push('tag', text);
      else if (line.startsWith('@@') || line.startsWith('diff ')) push('kw', text);
      else push(null, text);
    });
    return out;
  }

  while (i < code.length) {
    const rest = code.slice(i);
    let m;
    // HTML comments in Vue files
    if (language === 'vue' && (m = /^(<!--[\s\S]*?-->)/.exec(rest))) { push('com', m[1]); i += m[1].length; continue; }
    // line / block comments
    if ((m = /^(\/\/[^\n]*)/.exec(rest)) ||
        (hash && (m = /^(#[^\n]*)/.exec(rest))) ||
        (sqlComment && (m = /^(--[^\n]*)/.exec(rest)))) { push('com', m[1]); i += m[1].length; continue; }
    if ((m = /^(\/\*[\s\S]*?\*\/)/.exec(rest))) { push('com', m[1]); i += m[1].length; continue; }
    // Python/Rust/Java decorators & attributes
    if ((m = /^(@[A-Za-z_][\w.]*)/.exec(rest))) { push('attr', m[1]); i += m[1].length; continue; }
    // YAML/TOML key at start of line
    if (isYamlToml && (i === 0 || code[i - 1] === '\n') && (m = /^([ \t]*[A-Za-z0-9_.-]+)(?=[ \t]*[:=])/.exec(rest))) {
      push('attr', m[1]); i += m[1].length; continue;
    }
    // JSON property key ("key":)
    if (isJson && (m = /^("(?:\\.|[^"\\\n])*")(?=[ \t]*:)/.exec(rest))) {
      push('attr', m[1]); i += m[1].length; continue;
    }
    // strings (triple, double, single, template)
    if ((m = /^("""[\s\S]*?"""|'''[\s\S]*?''')/.exec(rest)) ||
        (m = /^([rfbuRFBU]{0,2}"(?:\\.|[^"\\\n])*"|[rfbuRFBU]{0,2}'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/.exec(rest))) {
      push('str', m[1]); i += m[1].length; continue;
    }
    // numbers
    if ((m = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?)\b/.exec(rest))) {
      push('num', m[1]); i += m[1].length; continue;
    }
    // Vue / HTML tags inside .vue
    if (language === 'vue' && (m = /^(<\/?[A-Za-z][\w-]*)/.exec(rest))) {
      push('tag', m[1]); i += m[1].length; continue;
    }
    // CSS property names
    if (/^(css|scss|less)$/.test(language) && (m = /^(--[\w-]+|[a-z-]+)(?=[ \t]*:)/.exec(rest))) {
      push('attr', m[1]); i += m[1].length; continue;
    }
    // identifiers / keywords / types / function calls
    if ((m = /^([A-Za-z_$][\w$]*)/.exec(rest))) {
      const word = m[1];
      const lookup = caseInsensitiveKw ? word.toLowerCase() : word;
      if (keywords && keywords.has(lookup)) push('kw', word);
      else if (!caseInsensitiveKw && isJson && /^(true|false|null)$/.test(word)) push('kw', word);
      else if (!caseInsensitiveKw && isYamlToml && /^(true|false|null|yes|no)$/i.test(word)) push('kw', word);
      else if (code[i + word.length] === '(') push('fn', word);
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word) && word.length > 1) push('type', word);
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
  const key = (language || '').toLowerCase();
  const keywords = wordSet(key);
  if (!keywords && !KNOWN_LANGS.has(key)) {
    codeElement.textContent = code;
    return false;
  }
  const doc = codeElement.ownerDocument;
  codeElement.replaceChildren();
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
