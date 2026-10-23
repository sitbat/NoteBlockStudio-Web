// Small original outline drawings. Only this fixed allowlist becomes SVG markup.
const drawings = Object.freeze({
  'file-plus': '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9h18"/>',
  save: '<path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v6h9V3M7 21v-8h10v8M14 5v2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-4L4 15z"/>',
  music: '<path d="M10 17V5l10-2v12M10 9l10-2"/><ellipse cx="7" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  'skip-back': '<path d="M5 4v16M19 5l-11 7 11 7z"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  volume: '<path d="M11 4 6 8H3v8h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="m16 3 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15zM5 15l4 4"/>',
  cursor: '<path d="m4 3 6 17 3-7 7-3zM13 13l6 6"/>',
  eraser: '<path d="m15 3 6 6a2 2 0 0 1 0 3l-8 8H7l-4-4a2 2 0 0 1 0-3l9-10a2 2 0 0 1 3 0ZM8 8l8 8M13 20h8"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14" transform="translate(0 -2)"/>',
  redo: '<path d="m16 4 5 5-5 5m5-5H11a7 7 0 0 0 0 14" transform="translate(0 -2)"/>',
  minus: '<path d="M5 12h14"/>',
  sliders: '<path d="M5 3v8m0 4v6M12 3v2m0 4v12M19 3v12m0 4v2"/><rect x="3" y="11" width="4" height="4" rx="1"/><rect x="10" y="5" width="4" height="4" rx="1"/><rect x="17" y="15" width="4" height="4" rx="1"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 7.5-2M12 14v3"/>',
  settings: '<path d="m10 3-.8 3-2 .9-2.8-.8-2 3.5 2.1 2.1v2.6l-2.1 2.1 2 3.5 2.8-.8 2 .9.8 3h4l.8-3 2-.9 2.8.8 2-3.5-2.1-2.1v-2.6l2.1-2.1-2-3.5-2.8.8-2-.9L14 3z" transform="translate(0 -1) scale(1 .96)"/><circle cx="12" cy="12" r="3"/>'
});

export const icon = name => {
  const drawing = Object.prototype.hasOwnProperty.call(drawings, name) ? drawings[name] : drawings.help;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawing}</svg>`;
};

export function hydrateIcons(root = document) {
  const nodes = Array.from(root.querySelectorAll('i[data-icon]'));
  if (root.matches?.('i[data-icon]')) nodes.unshift(root);
  for (const node of nodes) {
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = icon(node.dataset.icon);
  }
}
