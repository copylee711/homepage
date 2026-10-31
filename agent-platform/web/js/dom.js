import { createIcon } from './icons.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'attrs') { for (const [name, attr] of Object.entries(value)) if (attr !== undefined && attr !== null) node.setAttribute(name, String(attr)); }
    else if (key === 'dataset') { for (const [name, data] of Object.entries(value)) node.dataset[name] = String(data); }
    else if (key === 'on') { for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler); }
    else if (key in node) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}
export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}
export function clear(node) { node.replaceChildren(); }
export function icon(name, size) { return createIcon(name, size); }
export function iconButton(name, label, className = 'icon-button', extra = {}) {
  const { attrs = {}, ...rest } = extra;
  return el('button', { type: 'button', class: className, title: label,
    attrs: { 'aria-label': label, ...attrs }, ...rest }, createIcon(name, 18));
}
export function hydrateIcons(root = document) {
  for (const holder of $$('[data-icon]', root)) {
    holder.replaceChildren(createIcon(holder.dataset.icon, Number(holder.dataset.size) || 18));
    holder.removeAttribute('data-icon');
    holder.removeAttribute('data-size');
  }
}
export function announce(text) {
  const region = document.getElementById('sr-status');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = text; });
}
export function focusable(container) {
  return $$('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
    .filter(node => node.offsetParent !== null || node === document.activeElement);
}
export function trapTab(container, event) {
  if (event.key !== 'Tab') return;
  const items = focusable(container);
  if (!items.length) { event.preventDefault(); container.focus(); return; }
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
export async function copyText(value) {
  const text = String(value ?? '');
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const area = document.createElement('textarea');
      area.value = text; area.className = 'copy-fallback';
      document.body.append(area); area.select();
      const ok = document.execCommand('copy');
      area.remove(); return ok;
    } catch { return false; }
  }
}
export function triggerDownload(url) {
  const link = document.createElement('a');
  link.href = url; link.rel = 'noopener'; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
}
export function isTyping(target) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
}
export function platformKey(key) {
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
  return (mac ? '⌘' : 'Ctrl+') + key;
}
export function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}
