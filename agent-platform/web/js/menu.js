import { el, icon } from './dom.js';

let active = null;

function close({ restore = false } = {}) {
  if (!active) return;
  const record = active;
  active = null;
  record.anchor.setAttribute('aria-expanded', 'false');
  record.menu.remove();
  for (const cleanup of record.cleanups) cleanup();
  if (restore && record.anchor.isConnected) record.anchor.focus();
}

export function closeMenu(options) { close(options); }

export function openMenu({ anchor, items, label = '对话操作' }) {
  close();
  if (!anchor) return;
  const menu = el('div', { class: 'menu', attrs: { role: 'menu', 'aria-label': label } });
  const buttons = [];
  for (const item of items.filter(Boolean)) {
    const button = el('button', {
      type: 'button',
      class: 'menu-item' + (item.danger ? ' is-danger' : ''),
      attrs: { role: 'menuitem', tabindex: '-1' },
      disabled: item.disabled === true,
    }, icon(item.icon || 'file', 16), el('span', { class: 'menu-label', text: item.label }));
    if (item.shortcut) button.append(el('kbd', { class: 'menu-shortcut', text: item.shortcut }));
    button.addEventListener('click', () => {
      if (item.disabled) return;
      close({ restore: true });
      item.action();
    });
    buttons.push(button);
    menu.append(button);
  }
  document.body.append(menu);
  position(menu, anchor);
  anchor.setAttribute('aria-expanded', 'true');
  const cleanups = [];
  const record = { menu, anchor, cleanups };
  active = record;

  const focusAt = index => {
    const enabled = buttons.filter(button => !button.disabled);
    if (!enabled.length) return;
    enabled[(index + enabled.length) % enabled.length].focus();
  };
  const onKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      close({ restore: true });
      return;
    }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = buttons.filter(button => !button.disabled);
    const current = enabled.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') focusAt(current + 1);
    else if (event.key === 'ArrowUp') focusAt(current - 1);
    else if (event.key === 'Home') focusAt(0);
    else focusAt(enabled.length - 1);
  };
  const onPointer = event => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  document.addEventListener('keydown', onKey, true);
  const pointerTimer = setTimeout(() => document.addEventListener('pointerdown', onPointer, true), 0);
  const onViewport = () => close();
  window.addEventListener('resize', onViewport, { passive: true });
  window.addEventListener('scroll', onViewport, { passive: true, capture: true });
  cleanups.push(
    () => clearTimeout(pointerTimer),
    () => document.removeEventListener('keydown', onKey, true),
    () => document.removeEventListener('pointerdown', onPointer, true),
    () => window.removeEventListener('resize', onViewport),
    () => window.removeEventListener('scroll', onViewport, true),
  );
  requestAnimationFrame(() => focusAt(0));
}
function position(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 196;
  const height = menu.offsetHeight || 240;
  let left = rect.right - width;
  if (left < 8) left = Math.max(8, rect.left);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}
