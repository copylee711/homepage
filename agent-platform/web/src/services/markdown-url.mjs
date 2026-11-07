/* URL and workspace-path checks shared by the Markdown renderer. No DOM, no network. */

export function isWsFilePath(raw) {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (!v || v.length > 500 || /\s/.test(v)) return false;
  if (v.startsWith('/workspace/') || v.startsWith('workspace/')) return true;
  return /^[a-zA-Z0-9_\-一-龥./]+\.(?:docx?|xlsx?|pptx?|pdf|zip|tar|gz|7z|rar|csv|tsv|py|js|mjs|cjs|ts|tsx|jsx|vue|html|css|scss|json|md|txt|png|jpe?g|gif|svg|webp|sh|bash|yml|yaml|sql|go|rs|c|cpp|h|toml|ini|env)$/i.test(v) && !v.includes('://');
}

export function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) return null;
  if (url.protocol === 'mailto:' && /[?&](?:body|cc|bcc)=/i.test(value)) return null;
  return url.href;
}
