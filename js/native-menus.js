const menuDefinitions = [
  { name: 'file', trigger: 'fileMenuBtn', label: '文件', items: [
    ['new', '新建歌曲', 'Ctrl+N', '00-new'], ['open', '打开歌曲…', 'Ctrl+O', '01-open'], null,
    ['save', '保存 NBS', 'Ctrl+S', '02-save'], ['export', '导出…', '', '03-save-as'], null,
    ['saveProject', '保存完整工程包…', '', '02-save'], ['backups', '备份与恢复…', '', '03-save-as'],
    ['openURL', '从链接打开…', '', '01-open'], ['audioExport', '音频导出设置…', '', '03-save-as'], ['minecraft', 'Minecraft 导入与导出…', '', '03-save-as'], null,
    ['info', '歌曲信息…', '', '40-information'], ['statistics', '曲谱统计…', '', '40-information']
  ] },
  { name: 'edit', trigger: 'editMenuBtn', label: '编辑', items: [
    ['undo', '撤销', 'Ctrl+Z', '29-undo'], ['redo', '重做', 'Ctrl+Shift+Z', '31-redo'], null,
    ['copy', '复制', 'Ctrl+C', '33-copy'], ['cut', '剪切', 'Ctrl+X', '35-cut'], ['paste', '粘贴', 'Ctrl+V', '37-paste'],
    ['delete', '删除', 'Delete', '39-delete'], null,
    ['selectAll', '全选', 'Ctrl+A', '46-check'], ['deselect', '取消选择', '', '48-check-inactive'], ['selectionTools','选择条件…','','46-check'], null,
    ['macros', '宏与音乐编辑…', '', '41-properties'], ['patterns', '图案与分段代码…', '', '33-copy'], ['chords', '插入和弦…', '', '42-instruments'], ['layerTools','图层管理…','','41-properties']
  ] },
  { name: 'settings', trigger: 'viewMenuBtn', label: '设置', items: [
    ['properties', '音符属性…', '', '41-properties'], ['engineSettings', '混音与混响设置…', '', '42-instruments'], null,
    ['performance', '播放性能…', '', '55-editmode-vel'], ['midi', 'MIDI 设备与录制…', '', '09-record'], ['instruments', '自定义乐器管理…', '', '42-instruments'],
    ['tempoTap', '敲击测速…', '', '41-properties'], ['preferences', '偏好设置…', '', '41-properties'], ['system', '本地服务与系统集成…', '', '40-information']
  ] },
  { name: 'help', trigger: 'helpMenuBtn', label: '帮助', items: [
    ['help', '操作指南…', 'F1', '44-help']
  ] }
];

/** Native-style browser menus. All operations are supplied by the editor. */
export function createNativeMenus(actions) {
  if (!actions || typeof actions !== 'object') throw new TypeError('Menu actions must be an object.');
  const menus = menuDefinitions.map(definition => ({ ...definition, button: document.getElementById(definition.trigger) })).filter(menu => menu.button);
  const removers = [];
  let current = null;
  let popup = null;
  let focusedIndex = -1;
  let entries = [];
  const listen = (node, event, listener, options) => {
    node.addEventListener(event, listener, options);
    removers.push(() => node.removeEventListener(event, listener, options));
  };
  const close = ({ restoreFocus = false } = {}) => {
    const previous = current;
    current = null;
    popup?.remove(); popup = null; entries = []; focusedIndex = -1;
    for (const menu of menus) {
      menu.button.setAttribute('aria-expanded', 'false');
      menu.button.classList.remove('native-menu-trigger-open');
    }
    if (restoreFocus) previous?.button.focus({ preventScroll: true });
  };
  const focusEntry = index => {
    if (!entries.length) return;
    focusedIndex = (index + entries.length) % entries.length;
    entries[focusedIndex].focus({ preventScroll: true });
  };
  const invoke = action => {
    close({ restoreFocus: true });
    if (typeof actions[action] === 'function') return actions[action]();
  };
  const position = () => {
    if (!popup || !current) return;
    const rect = current.button.getBoundingClientRect();
    const width = popup.getBoundingClientRect().width;
    popup.style.left = `${Math.max(3, Math.min(rect.left, window.innerWidth - width - 3))}px`;
    popup.style.top = `${Math.max(0, rect.bottom)}px`;
    popup.style.maxHeight = `${Math.max(80, window.innerHeight - rect.bottom - 5)}px`;
  };
  const open = (name, { focus = false, last = false } = {}) => {
    const menu = typeof name === 'string' ? menus.find(menu => menu.name === name) : name;
    if (!menu) return;
    close(); current = menu;
    popup = document.createElement('div');
    popup.className = 'native-menu';
    popup.id = `native-popup-${menu.name}`;
    popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-labelledby', menu.button.id);
    for (const item of menu.items) {
      if (!item) {
        const separator = document.createElement('div');
        separator.className = 'native-menu-separator';
        separator.setAttribute('role', 'separator');
        popup.append(separator); continue;
      }
      const [action, label, shortcut, image] = item;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'native-menu-item';
      button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
      button.dataset.action = action;
      button.disabled = typeof actions[action] !== 'function';
      const glyph = document.createElement('img');
      glyph.src = `assets/original/toolbar-light/${image}.png`; glyph.alt = ''; glyph.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.className = 'native-menu-label'; text.textContent = label;
      const hint = document.createElement('span'); hint.className = 'native-menu-shortcut'; hint.textContent = shortcut; hint.setAttribute('aria-hidden', 'true');
      button.append(glyph, text, hint);
      button.addEventListener('click', () => invoke(action));
      button.addEventListener('pointerenter', () => { if (!button.disabled) { focusedIndex = entries.indexOf(button); button.focus({ preventScroll: true }); } });
      popup.append(button);
      if (!button.disabled) entries.push(button);
    }
    menu.button.setAttribute('aria-expanded', 'true');
    menu.button.setAttribute('aria-controls', popup.id);
    menu.button.classList.add('native-menu-trigger-open');
    document.body.append(popup); position();
    if (focus) focusEntry(last ? entries.length - 1 : 0);
  };
  for (const menu of menus) {
    menu.button.setAttribute('aria-haspopup', 'menu');
    menu.button.setAttribute('aria-expanded', 'false');
    listen(menu.button, 'click', () => current === menu ? close({ restoreFocus: true }) : open(menu));
    listen(menu.button, 'pointerenter', () => { if (current && current !== menu) open(menu); });
  }
  listen(document, 'pointerdown', event => {
    if (current && !popup?.contains(event.target) && !menus.some(menu => menu.button.contains(event.target))) close();
  }, true);
  listen(document, 'keydown', event => {
    if (!current) {
      const menu = menus.find(menu => menu.button === event.target);
      if (menu && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        open(menu, { focus: true, last: event.key === 'ArrowUp' });
      }
      return;
    }
    // An open menu receives editor shortcuts before the grid's global handler.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close({ restoreFocus: true }); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); focusEntry(focusedIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusEntry(focusedIndex < 0 ? entries.length - 1 : focusedIndex - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusEntry(0); }
    else if (event.key === 'End') { event.preventDefault(); focusEntry(entries.length - 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const index = menus.indexOf(current), direction = event.key === 'ArrowRight' ? 1 : -1;
      open(menus[(index + direction + menus.length) % menus.length], { focus: true });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (focusedIndex >= 0) entries[focusedIndex]?.click(); else focusEntry(0);
    } else if (event.key === 'Tab') close({ restoreFocus: true });
    else if (event.key === 'F1') { event.preventDefault(); invoke('help'); }
    else if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      const action = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : ({ n: 'new', o: 'open', s: 'save', y: 'redo', c: 'copy', x: 'cut', v: 'paste', a: 'selectAll' })[key];
      if (action) { event.preventDefault(); invoke(action); }
    }
  }, true);
  listen(window, 'resize', position);
  listen(window, 'blur', () => close());
  return {
    open: name => open(name, { focus: true }), close,
    get isOpen() { return !!current; },
    destroy() { close(); for (const remove of removers) remove(); }
  };
}
