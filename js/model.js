/** Pure project data and undo history, shared by the editor and local file import. */
export const MAX_NOTES = 1000000;
export const MAX_LAYERS = 65535;
const MAX_TICKS = 1000000;
let sequence = 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, fallback) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, fallback, min, max) => clamp(Math.round(number(value, fallback)), min, max);
const bool = value => value === true || value === 1 || value === 'true';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, fallback = '', max = 65536) => typeof value === 'string' ? value.slice(0, max) : fallback;
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

export function uniqueId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  sequence++;
  return `n-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function noteName(key) {
  const midi = integer(key, 45, 0, 87) + 21;
  return `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12]}${Math.floor(midi / 12) - 1}`;
}

const defaultLayer = (id, name = `图层 ${id + 1}`) => ({id, name, volume: 100, pan: 0, reverb: 0, muted: false, solo: false, locked: false});

export function createBlankSong() {
  return {
    title: '未命名作品', author: '', originalAuthor: '', description: '',
    tempo: 10, timeSignature: 4, length: 64, loop: false, loopStart: 0, loopCount: 0,
    layers: Array.from({length: 4}, (_, id) => defaultLayer(id)),
    notes: [], customInstruments: [], metadata: {},
  };
}

/** Preserve imported extensions while repairing fields that the editor depends on.
 * Layers are stored by array position, as in NBS; external IDs outside that range
 * also resolve to the original layer ID before missing layers are generated.
 * Duplicate notes at the same tick/layer keep the last imported occurrence.
 */
export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目 JSON 必须是一个曲目对象。');
  if (raw.notes !== undefined && !Array.isArray(raw.notes)) throw new Error('项目的 notes 字段必须是数组。');
  if (raw.layers !== undefined && !Array.isArray(raw.layers)) throw new Error('项目的 layers 字段必须是数组。');
  if (raw.customInstruments !== undefined && !Array.isArray(raw.customInstruments)) throw new Error('项目的 customInstruments 字段必须是数组。');
  if ((raw.notes?.length || 0) > MAX_NOTES) throw new Error(`项目音符过多，最多支持 ${MAX_NOTES} 个音符。`);
  if ((raw.layers?.length || 0) > MAX_LAYERS) throw new Error(`项目图层过多，最多支持 ${MAX_LAYERS} 个图层。`);
  if ((raw.customInstruments?.length || 0) > 255) throw new Error('自定义乐器过多，最多支持 255 个。');
  const song = clone(raw);
  const originalLayers = song.layers || Array.from({length: 4}, (_, id) => defaultLayer(id));
  const idMap = new Map();
  const layers = Array.from({length: Math.max(1, originalLayers.length)}, (_, id) => {
    const layer = object(originalLayers[id]);
    if (layer.id !== undefined && !idMap.has(String(layer.id))) idMap.set(String(layer.id), id);
    return {...layer, id, name: text(layer.name, `图层 ${id + 1}`, 1024),
      volume: clamp(number(layer.volume, 100), 0, 100), pan: clamp(number(layer.pan, 0), -100, 100), reverb: clamp(number(layer.reverb, 0), 0, 100),
      muted: bool(layer.muted), solo: bool(layer.solo), locked: bool(layer.locked)};
  });
  const byCell = new Map();
  const usedIds = new Set();
  let lastTick = -1;
  for (const item of song.notes || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let layer = integer(item.layer, 0, 0, MAX_LAYERS - 1);
    if (!(Number(item.layer) >= 0 && Number(item.layer) < originalLayers.length) && idMap.has(String(item.layer))) layer = idMap.get(String(item.layer));
    while (layers.length <= layer) layers.push(defaultLayer(layers.length));
    let id = typeof item.id === 'string' && item.id && item.id.length <= 256 ? item.id : uniqueId();
    if (usedIds.has(id)) id = uniqueId();
    usedIds.add(id);
    const note = {...item, id, layer,
      tick: integer(item.tick, 0, 0, MAX_TICKS - 1), key: integer(item.key, 45, 0, 87),
      instrument: integer(item.instrument, 0, 0, 270), velocity: clamp(number(item.velocity, 100), 0, 100),
      pan: clamp(number(item.pan, 0), -100, 100), pitch: integer(item.pitch, 0, -32768, 32767)};
    byCell.set(`${note.tick}:${layer}`, note);
    lastTick = Math.max(lastTick, note.tick);
  }
  const notes = [...byCell.values()].sort((a, b) => a.tick - b.tick || a.layer - b.layer);
  const length = Math.max(lastTick + 1, integer(song.length, 64, 1, MAX_TICKS));
  const customInstruments = (song.customInstruments || []).map((entry, index) => {
    const instrument = object(entry);
    return {...instrument, name: text(instrument.name, `自定义乐器 ${index + 1}`, 1024),
      file: text(instrument.file, '', 4096), key: integer(instrument.key, 45, 0, 87), pressKey: bool(instrument.pressKey)};
  });
  return {...song, title: text(song.title, '未命名作品', 4096), author: text(song.author, '', 4096),
    originalAuthor: text(song.originalAuthor, '', 4096), description: text(song.description),
    tempo: clamp(number(song.tempo, 10), 0.05, 655.35), timeSignature: integer(song.timeSignature, 4, 1, 16),
    length, loop: bool(song.loop), loopStart: integer(song.loopStart, 0, 0, length - 1), loopCount: integer(song.loopCount, 0, 0, 255),
    layers, notes, customInstruments, metadata: object(song.metadata)};
}

/** Original 128-note C–Am–F–G study. The second half is open for editing. */
export function createDemoSong() {
  const song = createBlankSong();
  song.title = '晨光练习';
  song.author = '本地示例';
  song.description = '为这个 Web 移植版原创的 128 音符练习曲。试着移动音符、切换音色，或在后半段续写旋律。';
  song.length = 128;
  song.layers = ['晨光 · 竖琴', '回声 · 电子音', '低音提琴', '底鼓', '军鼓', '击棒'].map((name, id) => defaultLayer(id, name));
  [86, 38, 78, 76, 44, 23].forEach((volume, id) => { song.layers[id].volume = volume; });
  song.layers[0].pan = -12; song.layers[1].pan = 22; song.layers[5].pan = 12;
  const chords = [[39, 43, 46, 50], [36, 39, 43, 46], [32, 36, 39, 43], [34, 38, 41, 46]];
  const melody = [[55, 50, 46, 50], [51, 48, 46, 43], [48, 46, 43, 48], [50, 46, 45, 46]];
  const add = (tick, layer, key, instrument, velocity = 100, pan = 0) => song.notes.push({id: uniqueId(), tick, layer, key, instrument, velocity, pan, pitch: 0});
  chords.forEach((chord, bar) => {
    const start = bar * 16;
    [0, 1, 2, 3, 2, 1, 2, 3].forEach((index, step) => add(start + step * 2, 0, chord[index], 0, step % 4 === 0 ? 100 : 78));
    melody[bar].forEach((key, step) => add(start + 1 + step * 4, 1, key, 13, 82));
    for (let beat = 0; beat < 4; beat++) {
      add(start + beat * 4, 2, chord[0] - 12 + (beat === 3 ? 7 : 0), 1, beat % 2 ? 78 : 94);
      add(start + beat * 4, 3, 45, 2, beat % 2 ? 80 : 100);
    }
    [4, 6, 12, 14].forEach((step, index) => add(start + step, 4, 45, 3, index % 2 ? 32 : 88));
    for (let step = 0; step < 8; step++) add(start + step * 2 + 1, 5, 45, 4, step % 2 ? 55 : 78);
  });
  return normalizeSong(song);
}

export class History {
  constructor(limit = 80) {
    this.limit = integer(limit, 80, 1, 500);
    this._undo = [];
    this._redo = [];
  }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  get undoDepth() { return this._undo.length; }
  get redoDepth() { return this._redo.length; }
  /** Keep the nearest snapshots when the editor adapts history to song size. */
  setLimit(limit) {
    this.limit = integer(limit, this.limit, 1, 500);
    if (this._undo.length > this.limit) this._undo.splice(0, this._undo.length - this.limit);
    if (this._redo.length > this.limit) this._redo.splice(0, this._redo.length - this.limit);
    return this;
  }
  push(song) {
    this._undo.push(clone(song));
    if (this._undo.length > this.limit) this._undo.shift();
    this._redo.length = 0;
  }
  undo(currentSong) {
    if (!this.canUndo) return null;
    this._redo.push(clone(currentSong));
    if (this._redo.length > this.limit) this._redo.shift();
    return clone(this._undo.pop());
  }
  redo(currentSong) {
    if (!this.canRedo) return null;
    this._undo.push(clone(currentSong));
    if (this._undo.length > this.limit) this._undo.shift();
    return clone(this._redo.pop());
  }
  clear() { this._undo.length = 0; this._redo.length = 0; }
}
