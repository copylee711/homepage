const paths = {
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  'panel-left': ['M4 5h16v14H4z', 'M9 5v14'],
  'panel-right': ['M4 5h16v14H4z', 'M15 5v14'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M18 13l-6 6-6-6'],
  'more-horizontal': ['M5.5 12h.01', 'M12 12h.01', 'M18.5 12h.01'],
  pin: ['M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z', 'M12 14v6'],
  archive: ['M4 7h16v13H4z', 'M3 4h18v3H3z', 'M9 11h6'],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M4 19h16'],
  upload: ['M12 20V9', 'M7.5 13.5L12 9l4.5 4.5', 'M4 5h16'],
  edit: ['M4 20h4l11-11-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  'alert-circle': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5v5.5', 'M12 16.5h.01'],
  'alert-triangle': ['M12 3.5L22 20H2L12 3.5z', 'M12 9v5', 'M12 17h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.5h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
  square: ['M7 7h10v10H7z'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 9a7 7 0 0 1 11.2-2L20 12', 'M17.9 15a7 7 0 0 1-11.2 2L4 12'],
  folder: ['M3.5 6h6l2 2h9v11h-17z'],
  'folder-open': ['M3.5 7h17l-2 11h-15z', 'M3.5 7l1.5-3h6l2 3'],
  file: ['M6 3.5h8l4 4v13H6z', 'M14 3.5v4h4'],
  link: ['M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11 6.8', 'M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.8-1.8'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'M5 5l1.5 1.5', 'M17.5 17.5L19 19', 'M19 5l-1.5 1.5', 'M6.5 17.5L5 19'],
  moon: ['M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z'],
  logout: ['M15 4h4v16h-4', 'M11 8l-4 4 4 4', 'M7 12h9'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z'],
  users: ['M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20', 'M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M21 20v-1.5a4 4 0 0 0-3-3.8', 'M16 4a3.5 3.5 0 0 1 0 6.8'],
  keyboard: ['M3 6h18v12H3z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M19 10h.01', 'M8 14h8'],
  sparkle: ['M12 2.5l1.8 5.7L19.5 10l-5.7 1.8L12 17.5l-1.8-5.7L4.5 10l5.7-1.8z'],
  terminal: ['M4 5h16v14H4z', 'M7.5 9l3 3-3 3', 'M13 15h4'],
  shield: ['M12 3l7 3v5.5c0 4.2-3 7.4-7 9.5-4-2.1-7-5.3-7-9.5V6l7-3z'],
  'external-link': ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5H5V6h5'],
  message: ['M4 5h16v11H9l-5 4z'],
  inbox: ['M4 4h16v16H4z', 'M4 13h5l2 3h2l2-3h5'],
  play: ['M8 5l11 7-11 7z'],
  stop: ['M7 7h10v10H7z'],
  eye: ['M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  'eye-off': ['M4 4l16 16', 'M9.5 6.5A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3.1 3.5', 'M6.2 8.2A17 17 0 0 0 2.5 12s3.5 6 9.5 6a9.8 9.8 0 0 0 4.2-.9', 'M10 10a2.8 2.8 0 0 0 4 4'],
  'corner-down-left': ['M9 10l-5 5 5 5', 'M4 15h9a7 7 0 0 0 7-7V5'],
};
export function createIcon(name, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  for (const d of paths[name] || paths.file) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
export function iconMarkup(name, size = 18) {
  return { name, size };
}
