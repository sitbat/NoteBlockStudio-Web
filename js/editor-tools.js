/** Native musical editing tools. All operations stage and validate before committing. */
import {MAX_NOTES, MAX_LAYERS, uniqueId} from './model.js';
import {bounds, pasteNotes} from './edit.js';

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const cell = note => `${note.tick}:${note.layer}`;
const order = (a, b) => a.tick - b.tick || a.layer - b.layer;
const fields = ['tick', 'layer', 'key', 'instrument', 'velocity', 'pan', 'pitch'];
const number = (value, fallback, min, max, label) => {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}应在 ${min}–${max} 之间。`);
  return n;
};
const option = (name, label, type, value, min, max) => ({name, label, type, default: value, min, max});
const tool = (id, label, options = []) => ({id, label, options, defaults: Object.fromEntries(options.map(item => [item.name, item.default]))});
export const EDITOR_TOOLS = [
  tool('tremolo', '震音 / Tremolo', [option('spacing', '间距（tick）', 'number', 1, 1, 2), option('fade', '包络（none/in/out）', 'text', 'none'), option('automatic', '自动包络', 'boolean', true), option('amount', '包络步进', 'number', 10, 1, 100), option('sustain', '保持力度', 'number', 80, 1, 100)]),
  tool('stereo', '立体声 / Stereo', [option('width', '立体声宽度', 'number', 40, 0, 100), option('reverse', '反转', 'boolean', false)]),
  tool('arpeggio', '琶音 / Arpeggio', [option('pattern', '半音偏移序列（| 分隔）', 'text', '0|4|7|12')]),
  tool('portamento', '滑音 / Portamento', [option('amount', '音分偏移', 'number', 100, -1200, 1200), option('reverse', '反转', 'boolean', false)]),
  tool('vibrato', '颤音 / Vibrato'),
  tool('stagger', '错开图层 / Stagger', [option('pattern', '图层增量序列（| 分隔）', 'text', '0|1|2|1')]),
  tool('chorus', '合唱 / Chorus'), tool('volume-lfo', '音量 LFO'), tool('fade-in', '淡入'), tool('fade-out', '淡出'), tool('replace-key', '统一为首个音高'),
  tool('set-velocity', '设置力度', [option('value', '力度 / 百分比', 'number', 100, 0, 1000), option('percent', '相对百分比', 'boolean', false)]),
  tool('set-panning', '设置声像', [option('value', '声像（左 -100 / 右 100）', 'number', 0, -100, 100)]),
  tool('set-pitch', '设置微调音高', [option('value', '音分', 'number', 0, -1200, 1200), option('add', '叠加', 'boolean', false)]),
  tool('reset-properties', '重置力度、声像和微调'), tool('expand', '时间展开 ×2'), tool('compress', '时间压缩 ÷2（保留重叠音符）'), tool('fold-octave', '移入音符盒八度范围'),
  tool('transpose', '移调', [option('amount', '半音', 'number', 12, -87, 87)]),
  tool('change-instrument', '更换乐器', [option('instrument', '乐器编号', 'number', 0, 0, 270)]),
];
export const MACROS = EDITOR_TOOLS.slice(0, 15);

function patternValues(value, {signed = true} = {}) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(/[|,\s]+/).filter(Boolean);
  if (!entries.length || entries.length > 4096) throw new Error('序列必须包含 1–4096 个整数。');
  return entries.map(entry => {
    const n = Number(entry);
    if (!Number.isInteger(n) || n < (signed ? -87 : 0) || n > (signed ? 87 : MAX_LAYERS - 1)) throw new Error('序列包含无效或超出范围的整数。');
    return n;
  });
}
function columns(notes) {
  const result = [];
  for (const note of notes) {
    if (!result.length || result.at(-1)[0].tick !== note.tick) result.push([]);
    result.at(-1).push(note);
  }
  return result;
}
function validate(note) {
  if (!Number.isInteger(note.tick) || note.tick < 0 || note.tick > 999999) throw new Error('操作后音符超出时间轴范围（0–999999 tick）。');
  if (!Number.isInteger(note.layer) || note.layer < 0 || note.layer >= MAX_LAYERS) throw new Error(`操作后音符超出 ${MAX_LAYERS} 条图层的限制。`);
  if (!Number.isInteger(note.key) || note.key < 0 || note.key > 87) throw new Error('操作后音高超出 0–87 的范围。');
  if (!Number.isInteger(note.instrument) || note.instrument < 0 || note.instrument > 270) throw new Error('无效的乐器编号。');
  for (const [field, low, high] of [['velocity', 0, 100], ['pan', -100, 100], ['pitch', -32768, 32767]]) {
    if (!Number.isFinite(note[field]) || note[field] < low || note[field] > high) throw new Error(`操作后 ${field} 超出范围。`);
  }
}
function commit(song, originals, changedNotes) {
  const oldIds = new Set(originals.map(note => note.id));
  const retained = new Map(song.notes.filter(note => !oldIds.has(note.id)).map(note => [cell(note), note]));
  const staged = new Map(); let maxLayer = song.layers.length - 1, lastTick = (song.length || 1) - 1;
  for (const note of changedNotes) {
    validate(note);
    if (song.layers[note.layer]?.locked) throw new Error('目标图层已锁定，未修改任何音符。');
    if (staged.has(cell(note))) throw new Error('变换产生重叠音符，未修改任何音符。');
    staged.set(cell(note), note); maxLayer = Math.max(maxLayer, note.layer); lastTick = Math.max(lastTick, note.tick);
  }
  const removedIds = [];
  for (const key of staged.keys()) if (retained.has(key)) { removedIds.push(retained.get(key).id); retained.delete(key); }
  if (staged.size + retained.size > MAX_NOTES) throw new Error(`操作后音符数量超过 ${MAX_NOTES} 个。`);
  const oldById = new Map(originals.map(note => [note.id, note]));
  const changed = removedIds.length > 0 || originals.length !== staged.size || [...staged.values()].some(note => !oldById.has(note.id) || fields.some(field => note[field] !== oldById.get(note.id)[field]));
  if (!changed) return {changed: false, selectedIds: originals.map(note => note.id), addedIds: [], removedIds: []};
  const addedIds = [], selectedIds = [], layers = song.layers.slice();
  for (const note of staged.values()) {
    if (!note.id || !oldIds.has(note.id)) { note.id = uniqueId(); addedIds.push(note.id); }
    selectedIds.push(note.id);
  }
  while (layers.length <= maxLayer) { const id = layers.length; layers.push({id, name: `图层 ${id + 1}`, volume: 100, pan: 0, reverb: 0, muted: false, solo: false, locked: false}); }
  const survivingIds = new Set(selectedIds);
  for (const id of oldIds) if (!survivingIds.has(id)) removedIds.push(id);
  song.layers = layers; song.notes = [...retained.values(), ...staged.values()].sort(order); song.length = Math.max(1, lastTick + 1);
  return {changed: true, selectedIds, addedIds, removedIds};
}

/** IDs are an iterable. Locked source layers are excluded; locked destinations fail atomically. */
export function applyEditorTool(song, ids, action, options = {}) {
  const descriptor = EDITOR_TOOLS.find(item => item.id === action);
  if (!descriptor) throw new Error(`未知的音乐编辑工具：${action}`);
  options = {...descriptor.defaults, ...options};
  const selected = new Set(ids || []);
  const originals = song.notes.filter(note => selected.has(note.id) && !song.layers[note.layer]?.locked).sort(order);
  if (!originals.length) return {changed: false, selectedIds: [], addedIds: [], removedIds: []};
  let notes = originals.map(note => ({...note}));
  const groups = columns(notes), area = bounds(notes), count = groups.length;
  switch (action) {
    case 'vibrato': groups.forEach((group, i) => group.forEach(note => { note.pitch = [40, 0, -40, 0][i % 4]; })); break;
    case 'volume-lfo': groups.forEach((group, i) => group.forEach(note => { note.velocity = [100, 50, 25, 50][i % 4]; if (i % 4 === 0 && note.pan === -100) note.pan = 0; })); break;
    case 'stereo': {
      const width = number(options.width, 40, 0, 100, '立体声宽度');
      groups.forEach((group, i) => group.forEach(note => { note.pan = width * (i % 2 ? -1 : 1) * (options.reverse ? -1 : 1); })); break;
    }
    case 'arpeggio': {
      const pattern = patternValues(options.pattern);
      groups.forEach((group, i) => group.forEach(note => { const key = note.key + pattern[i % pattern.length]; if (key >= 0 && key <= 87) note.key = key; })); break;
    }
    case 'stagger': {
      const pattern = patternValues(options.pattern, {signed: false});
      // Native code changes every row delta, so the nth note receives n times the offset.
      groups.forEach((group, i) => group.forEach((note, row) => { note.layer += (row + 1) * pattern[i % pattern.length]; })); break;
    }
    case 'portamento': {
      const amount = number(options.amount, 100, -1200, 1200, '音分偏移'), increment = amount / count;
      groups.forEach((group, i) => group.forEach(note => { note.pitch = Math.round(options.reverse ? amount + increment * (1 - i) : note.pitch + increment * (i + 1)); })); break;
    }
    case 'chorus':
      if (groups.some(group => group.length < 2)) throw new Error('合唱要求每个有音符的时间列至少包含两个音符。');
      groups.forEach(group => group.forEach((note, i) => { note.pan = i % 2 ? -40 : 40; note.pitch += i % 2 ? -5 : 5; })); break;
    case 'fade-in': case 'fade-out':
      // A one-column fade has no duration; retain its existing velocity.
      if (count > 1) groups.forEach((group, i) => group.forEach(note => { note.velocity = clamp(Math.ceil(note.velocity * (action === 'fade-in' ? i / (count - 1) : 1 - i / (count - 1))), 1, 100); })); break;
    case 'replace-key': notes.forEach(note => { note.key = notes[0].key; }); break;
    case 'reset-properties': notes.forEach(note => { note.velocity = 100; note.pan = 0; note.pitch = 0; }); break;
    case 'set-velocity': {
      const value = number(options.value, 100, 0, options.percent ? 1000 : 100, '力度');
      notes.forEach(note => { note.velocity = clamp(options.percent ? note.velocity * value / 100 : value, 0, 100); }); break;
    }
    case 'set-panning': { const value = number(options.value, 0, -100, 100, '声像'); notes.forEach(note => { note.pan = value; }); break; }
    case 'set-pitch': {
      const value = number(options.value, 0, -1200, 1200, '音分');
      notes.forEach(note => { const pitch = Math.round(options.add ? note.pitch + value : value); if (pitch >= -1200 && pitch <= 1200) note.pitch = pitch; }); break;
    }
    case 'transpose': {
      const amount = number(options.amount, 12, -87, 87, '半音');
      if (!Number.isInteger(amount)) throw new Error('移调半音必须是整数。');
      notes.forEach(note => { const key = note.key + amount; if (key >= 0 && key <= 87) note.key = key; }); break;
    }
    case 'change-instrument': {
      const instrument = number(options.instrument, 0, 0, 15 + (song.customInstruments?.length || 0), '乐器编号');
      if (!Number.isInteger(instrument)) throw new Error('乐器编号必须是整数。');
      notes.forEach(note => { note.instrument = instrument; }); break;
    }
    case 'fold-octave': notes.forEach(note => { while (note.key < 33) note.key += 12; while (note.key > 57) note.key -= 12; }); break;
    case 'expand': notes.forEach(note => { note.tick = area.minTick + (note.tick - area.minTick) * 2; }); break;
    case 'compress': {
      const taken = new Set();
      for (const note of notes) {
        note.tick = area.minTick + Math.floor((note.tick - area.minTick) / 2);
        while (taken.has(cell(note))) { note.layer++; if (note.layer >= MAX_LAYERS) throw new Error('压缩音符需要超出上限的图层。'); }
        taken.add(cell(note));
      }
      break;
    }
    case 'tremolo': {
      const spacing = number(options.spacing, 1, 1, 2, '间距');
      if (!Number.isInteger(spacing) || !['none', 'in', 'out'].includes(options.fade)) throw new Error('无效的震音间距或包络。');
      const manualIncrement = number(options.amount, 10, 1, 100, '包络步进'), sustain = number(options.sustain, 80, 1, 100, '保持力度');
      const expanded = []; let tick = area.minTick;
      const budget = MAX_NOTES - song.notes.length + originals.length;
      for (let column = 0; column < groups.length; column++) {
        const group = groups[column], last = column === groups.length - 1;
        const repetitions = last ? 1 : Math.ceil((groups[column + 1][0].tick - group[0].tick) / spacing);
        if (expanded.length + repetitions * group.length > budget) throw new Error(`震音生成后音符数量超过 ${MAX_NOTES} 个。`);
        const increment = options.automatic ? 100 / (repetitions > 4 ? repetitions - 4 : repetitions > 2 ? repetitions - 2 : repetitions) : manualIncrement;
        // Preserve native cumulative spacing, including rounding odd gaps up when spacing is two.
        for (let repeat = 0; repeat < repetitions; repeat++) {
          for (const source of group) {
            const note = {...source, tick: tick + repeat * spacing};
            if (repeat) delete note.id;
            if (!last && options.fade === 'in') note.velocity = Math.min(increment * (repeat + 1), options.automatic ? 80 : sustain);
            if (!last && options.fade === 'out') { const value = 100 - increment * (repeat + 1); note.velocity = options.automatic ? Math.max(value, 20) : value >= 20 ? value : sustain; }
            expanded.push(note);
          }
        }
        tick += repetitions * spacing;
        // The original fade variants use a one-tick final gap regardless of tremolo spacing.
        if (column === groups.length - 2 && options.fade !== 'none') tick -= spacing - 1;
      }
      notes = expanded; break;
    }
  }
  return commit(song, originals, notes);
}

export const runMacro = applyEditorTool;

/** Selection-only commands do not mutate the song, including its history. */
export function selectNotes(song, ids, {mode = 'all', instrument = 0} = {}) {
  const old = new Set(ids || []);
  if (!['all', 'none', 'invert', 'instrument', 'except-instrument'].includes(mode)) throw new Error('未知的选择方式。');
  return song.notes.filter(note => mode === 'all' || mode === 'invert' && !old.has(note.id) || mode === 'instrument' && note.instrument === instrument || mode === 'except-instrument' && note.instrument !== instrument).map(note => note.id);
}

/** Additional chord helper: inserts a real chord or a timed arpeggio; native NBP remains the interchange format. */
export const CHORDS = Object.freeze({major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], seventh: [0, 4, 7, 10], major7: [0, 4, 7, 11], minor7: [0, 3, 7, 10], power: [0, 7, 12]});
export function insertChord(song, {tick = 0, layer = 0, key = 45, chord = 'major', intervals, spacing = 0, instrument = 0, velocity = 100, pan = 0, pitch = 0} = {}) {
  const offsets = intervals ? patternValues(intervals) : CHORDS[chord];
  if (!offsets) throw new Error(`未知和弦：${chord}`);
  if (!Number.isInteger(spacing) || spacing < 0 || spacing > 999999) throw new Error('和弦间距必须是非负整数。');
  const notes = offsets.map((offset, i) => ({tick: spacing * i, layer: spacing ? 0 : i, key: Number(key) + offset, instrument, velocity, pan, pitch}));
  notes.forEach(validate);
  if (instrument >= 16 + (song.customInstruments?.length || 0)) throw new Error('和弦引用了未定义的自定义乐器。');
  return pasteNotes(song, notes, {tick, layer});
}
