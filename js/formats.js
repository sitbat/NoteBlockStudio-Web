/** Browser-only binary codecs. No network, dynamic code, or external dependencies. */
import {encodeProjectEffects, decodeProjectEffects} from './project-effects.js';
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_NOTES = 1000000;
const textEncoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
const integer = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback;
const defaultLayer = (id, name = `图层 ${id + 1}`) => ({ id, name, volume: 100, pan: 0, muted: false, solo: false, locked: false });

function bytesOf(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!bytes) throw new Error('需要 ArrayBuffer 或字节数组。');
  if (bytes.length > MAX_BYTES) throw new Error('文件过大（上限 128 MB）。');
  return bytes;
}

function decodeText(bytes) {
  try { return utf8.decode(bytes); }
  catch {
    // Classic NBS writes one byte per character; preserve its Latin-1 values.
    let str = '';
    for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return str;
  }
}

class Reader {
  constructor(input, label) { this.bytes = bytesOf(input); this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength); this.pos = 0; this.label = label; this.end = this.bytes.length; }
  need(n) { if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.end) throw new Error(`${this.label} 文件不完整或字段长度无效（字节 ${this.pos}）。`); }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  u16(le = true) { this.need(2); const v = this.view.getUint16(this.pos, le); this.pos += 2; return v; }
  i16(le = true) { this.need(2); const v = this.view.getInt16(this.pos, le); this.pos += 2; return v; }
  u32(le = true) { this.need(4); const v = this.view.getUint32(this.pos, le); this.pos += 4; return v; }
  take(n) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  str() { const len = this.u32(); if (len > 4 * 1024 * 1024) throw new Error('NBS 文本字段过长。'); return decodeText(this.take(len)); }
  vlq() { let v = 0; for (let i = 0; i < 4; i++) { const b = this.u8(); v = v * 128 + (b & 127); if (!(b & 128)) return v; } throw new Error('MIDI 可变长度整数超出 4 字节。'); }
}

class Writer {
  constructor() { this.data = []; }
  u8(v) { this.data.push(v & 255); }
  u16(v, le = true) { if (le) { this.u8(v); this.u8(v >>> 8); } else { this.u8(v >>> 8); this.u8(v); } }
  u32(v, le = true) { if (le) { this.u16(v); this.u16(v >>> 16); } else { this.u16(v >>> 16, false); this.u16(v, false); } }
  raw(bytes) { for (const b of bytes) this.u8(b); }
  str(value) { const bytes = textEncoder.encode(String(value || '')); if (bytes.length > 4 * 1024 * 1024) throw new Error('NBS 文本字段过长。'); this.u32(bytes.length); this.raw(bytes); }
  vlq(v) { if (!Number.isSafeInteger(v) || v < 0 || v > 0x0fffffff) throw new Error('MIDI 事件间隔超出范围。'); const b = [v & 127]; while ((v = Math.floor(v / 128))) b.unshift((v & 127) | 128); this.raw(b); }
  finish() { return Uint8Array.from(this.data); }
}

function songBase() {
  return { title: '', author: '', originalAuthor: '', description: '', tempo: 10, timeSignature: 4, length: 0, loop: false, loopStart: 0, loopCount: 0, layers: [], notes: [], customInstruments: [], metadata: {} };
}

/** Read classic NBS and NBS versions 1 through 5. Custom instruments start at 16. */
export function parseNBS(input) {
  const r = new Reader(input, 'NBS');
  const first = r.u16();
  let version = 0, vanillaCount = 10, declaredLength = first;
  if (first === 0) {
    version = r.u8();
    if (version < 1 || version > 5) throw new Error(`不支持 NBS 版本 ${version}，支持经典版和版本 1–5。`);
    vanillaCount = r.u8();
    if (vanillaCount < 1 || vanillaCount > 16) throw new Error('NBS 原版乐器数量无效。');
    declaredLength = version >= 3 ? r.u16() : 0;
  }
  const layerCount = r.u16();
  const song = songBase();
  song.title = r.str(); song.author = r.str(); song.originalAuthor = r.str(); song.description = r.str();
  song.tempo = r.u16() / 100;
  if (song.tempo <= 0) throw new Error('NBS 速度必须大于 0。');
  const autosave = r.u8(), autosaveMinutes = r.u8();
  song.timeSignature = clamp(r.u8(), 1, 16);
  const minutesSpent = r.u32(), leftClicks = r.u32(), rightClicks = r.u32(), blocksAdded = r.u32(), blocksRemoved = r.u32();
  const midiFile = r.str();
  song.metadata = { nbsVersion: version, vanillaInstrumentCount: vanillaCount, autosave, autosaveMinutes, minutesSpent, leftClicks, rightClicks, blocksAdded, blocksRemoved, midiFile };
  if (version >= 4) { song.loop = !!r.u8(); song.loopCount = r.u8(); song.loopStart = r.u16(); }
  let tick = -1, highestLayer = -1;
  while (true) {
    const jump = r.u16(); if (!jump) break;
    tick += jump;
    if (tick > 10000000) throw new Error('NBS 时间轴过长。');
    let layer = -1;
    while (true) {
      const layerJump = r.u16(); if (!layerJump) break;
      layer += layerJump;
      if (layer >= 65535) throw new Error('NBS 音符图层超出范围。');
      highestLayer = Math.max(highestLayer, layer);
      const rawInstrument = r.u8(), key = r.u8();
      if (key > 87) throw new Error(`NBS 第 ${tick} 格包含不支持的音高 ${key}（有效范围 0–87）。`);
      const instrument = rawInstrument >= vanillaCount ? 16 + rawInstrument - vanillaCount : rawInstrument;
      const velocity = version >= 4 ? r.u8() : 100;
      const pan = version >= 4 ? r.u8() - 100 : 0;
      if (velocity > 100 || pan < -100 || pan > 100) throw new Error(`NBS 第 ${tick} 格的音量或声像超出有效范围。`);
      const pitch = version >= 4 ? r.i16() : 0;
      song.notes.push({ id: `n${song.notes.length + 1}`, tick, layer, key, instrument, velocity, pan, pitch });
      if (song.notes.length > MAX_NOTES) throw new Error('NBS 音符数量过大（上限 100 万）。');
    }
  }
  // Layer metadata and the custom section were optional in some classic files.
  const nativeMutedLayers = [];
  for (let i = 0; i < layerCount; i++) {
    let layer = defaultLayer(i);
    if (r.pos < r.end) {
      layer.name = r.str();
      const lock = version >= 4 ? r.u8() : 0;
      layer.locked = lock === 1; layer.solo = lock === 2;
      if (lock === 1) nativeMutedLayers.push(i);
      layer.volume = clamp(r.u8(), 0, 100);
      layer.pan = version >= 2 ? clamp(r.u8() - 100, -100, 100) : 0;
    }
    song.layers.push(layer);
  }
  while (song.layers.length <= highestLayer) song.layers.push(defaultLayer(song.layers.length));
  if (!song.layers.length) song.layers.push(defaultLayer(0));
  if (r.pos < r.end) {
    const count = r.u8();
    for (let i = 0; i < count; i++) song.customInstruments.push({ name: r.str(), file: r.str(), key: clamp(r.u8(), 0, 87), pressKey: !!r.u8() });
  }
  if (r.pos < r.end) {
    const extension = decodeProjectEffects(r.take(r.end - r.pos), song.layers);
    if (extension.remaining.length) song.metadata.trailingBytes = extension.remaining;
    if (extension.restored) song.metadata.webEffectsVersion = 1;
  }
  // Native lock=1 also silences playback. A valid Web footer explicitly restores
  // the Web editor's independent edit-lock/mute flags, including omitted defaults.
  if (!song.metadata.webEffectsVersion) for (const index of nativeMutedLayers) song.layers[index].muted = true;
  song.length = Math.max(declaredLength, tick + 1, 1);
  return song;
}

/** Write interoperable version 5 by default; optional {version: 0..5} for compatibility. */
export function writeNBS(song, { version = 5, webExtensions = true } = {}) {
  if (!Number.isInteger(version) || version < 0 || version > 5) throw new Error('NBS 导出版本必须为 0–5。');
  if (!song || !Array.isArray(song.notes) || !Array.isArray(song.layers)) throw new Error('歌曲数据无效。');
  if (song.notes.length > MAX_NOTES) throw new Error('音符数量超过导出上限。');
  const notes = [...song.notes].sort((a, b) => a.tick - b.tick || a.layer - b.layer);
  const lastTick = notes.reduce((max, n) => Math.max(max, n.tick), -1);
  const length = Math.max(integer(song.length, 1), lastTick + 1, 1);
  const layerCount = notes.reduce((max, n) => Math.max(max, integer(n.layer) + 1), Math.max(song.layers.length, 1));
  if (length > 65535 || layerCount > 65535) throw new Error('NBS 导出最多支持 65535 个时间格和 65535 个图层。');
  const custom = song.customInstruments || [];
  const vanillaCount = version === 0 ? 10 : 16;
  if (custom.length > 240) throw new Error('自定义乐器数量超过 240。');
  const tempo = Math.round(Number(song.tempo) * 100);
  if (!Number.isInteger(tempo) || tempo < 1 || tempo > 65535) throw new Error('NBS 速度必须介于 0.01 和 655.35 之间。');
  const w = new Writer(), m = song.metadata || {};
  if (version >= 1) { w.u16(0); w.u8(version); w.u8(vanillaCount); }
  if (version === 0 || version >= 3) w.u16(length);
  w.u16(layerCount);
  for (const k of ['title', 'author', 'originalAuthor', 'description']) w.str(song[k]);
  w.u16(tempo); w.u8(m.autosave || 0); w.u8(m.autosaveMinutes || 10); w.u8(clamp(integer(song.timeSignature, 4), 1, 16));
  for (const key of ['minutesSpent', 'leftClicks', 'rightClicks', 'blocksAdded', 'blocksRemoved']) w.u32(clamp(integer(m[key]), 0, 0xffffffff));
  w.str(m.midiFile);
  if (version >= 4) { w.u8(song.loop ? 1 : 0); w.u8(clamp(integer(song.loopCount), 0, 255)); w.u16(clamp(integer(song.loopStart), 0, 65535)); }
  let previousTick = -1, previousLayer = -1;
  for (const n of notes) {
    if (!Number.isInteger(n.tick) || n.tick < 0 || n.tick > 65534 || !Number.isInteger(n.layer) || n.layer < 0 || n.layer >= layerCount) throw new Error('音符时间或图层无效。');
    if (n.tick !== previousTick) {
      if (previousTick !== -1) w.u16(0);
      w.u16(n.tick - previousTick); previousTick = n.tick; previousLayer = -1;
    }
    if (n.layer <= previousLayer) throw new Error(`第 ${n.tick} 格的图层 ${n.layer + 1} 有重叠音符，NBS 每格每层只能保存一个音符。`);
    w.u16(n.layer - previousLayer); previousLayer = n.layer;
    const instrument = integer(n.instrument);
    if (instrument < 0 || instrument >= 16 + custom.length || (version === 0 && instrument >= 10 && instrument < 16)) throw new Error(`乐器 ${instrument} 无法导出到此 NBS 版本。`);
    w.u8(instrument >= 16 ? instrument - 16 + vanillaCount : instrument);
    w.u8(clamp(integer(n.key), 0, 87));
    if (version >= 4) { w.u8(clamp(integer(n.velocity, 100), 0, 100)); w.u8(clamp(integer(n.pan), -100, 100) + 100); w.u16(clamp(integer(n.pitch), -32768, 32767)); }
  }
  if (notes.length) w.u16(0);
  w.u16(0);
  for (let i = 0; i < layerCount; i++) {
    const l = song.layers[i] || defaultLayer(i);
    w.str(l.name);
    if (version >= 4) w.u8(l.solo ? 2 : l.locked ? 1 : 0);
    w.u8(l.muted ? 0 : clamp(integer(l.volume, 100), 0, 100));
    if (version >= 2) w.u8(clamp(integer(l.pan), -100, 100) + 100);
  }
  w.u8(custom.length);
  for (const ins of custom) { w.str(ins.name); w.str(ins.file); w.u8(clamp(integer(ins.key, 45), 0, 87)); w.u8(ins.pressKey ? 1 : 0); }
  if (Array.isArray(m.trailingBytes)) w.raw(m.trailingBytes);
  if (webExtensions) w.raw(encodeProjectEffects(song.layers));
  return w.finish();
}

// General MIDI program numbers (zero based) chosen for the 16 Minecraft sounds.
const PROGRAMS = [0, 32, 116, 117, 115, 27, 73, 9, 112, 13, 11, 113, 109, 80, 105, 1];
// Optional source-exact preset, kept separate so existing automatic melodic imports stay compatible.
const NATIVE_PROGRAMS = [[0,0],[15,0],[15,0],[15,0],[0,0],[0,0],[5,1],[14,0],[7,-2],[7,-2],[7,-2],[10,0],[10,0],[9,-2],[7,-2],[5,1],[6,-1],[10,0],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[5,1],[5,1],[0,0],[5,1],[1,2],[12,2],[12,2],[5,3],[1,2],[1,2],[1,2],[1,2],[5,1],[5,1],[1,2],[15,0],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[1,2],[0,0],[3,0],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[3,-1],[6,-1],[6,-1],[6,-1],[12,2],[6,-1],[12,2],[12,2],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[13,0],[6,-1],[6,-1],[6,-1],[5,1],[6,-1],[6,-1],[1,2],[7,-2],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[6,-1],[8,-2],[8,-2],[6,-1],[8,-2],[5,1],[15,0],[6,-1],[6,-1],[5,1],[14,0],[14,0],[14,0],[5,1],[10,0],[6,-1],[6,-1],[6,-1],[8,-2],[11,-1],[10,0],[9,-2],[2,0],[3,0],[3,0],[8,-2],[4,1],[6,-1],[8,-2],[6,1],[7,2],[2,0],[3,0],[3,0]];
export const MIDI_PROGRAM_DEFAULTS = Object.freeze(Object.fromEntries(NATIVE_PROGRAMS.map(([instrument, octave], i) => [i, Object.freeze({instrument, octave})])));
// Native midi_instruments.gml shortened names, falling back to its full patch name.
export const MIDI_PROGRAM_NAMES = Object.freeze(["Piano 1","Piano 2","Piano 3","Honky-tonk","E.Piano 1","E.Piano 2","Harpsichord","Clavinet","Celesta","Glockenspiel","Music Box","Vibraphone","Marimba","Xylophone","Tubular Bells","Dulcimer","Organ 1","Organ 2","Rock Organ","Church Organ","Reed Organ","Accordion","Harmonica","Bandoneon","Nylon-str.Gt","Steel-str.Gt","Jazz Guitar","Clean Guitar","Muted Guitar","Overdrive Gt","Distortion Gt","Gt Harmonics","Acoustic Bass","Fingered Bass","Picked Bass","Fretless Bass","Slap Bass 1","Slap Bass 2","Synth Bass 1","Synth Bass 2","Violin","Viola","Cello","Contrabass","Tremolo Str.","Pizzicato","Harp","Timpani","Strings 1","Strings 2","Syn.Strings1","Syn.Strings2","Choir Aahs","Voice Oohs","Synth Voice","Orchestra Hit","Trumpet","Trombone","Tuba","Muted Trumpet","French Horn","Brass","Synth Brass 1","Synth Brass 2","Soprano Sax","Alto Sax","Tenor Sax","Baritone Sax","Oboe","English Horn","Bassoon","Clarinet","Piccolo","Flute","Recorder","Pan Flute","Blown Bottle","Shakuhachi","Whistle","Ocarina","Square Lead","Saw Lead","Calliope","Chiff Lead","Charang","Voice Lead","Fifth Lead","Bass+Lead","Fantasia","Warm Pad","Polysynth","Space Choir","Bowed Glass","Metal Pad","Halo Pad","Sweep Pad","Rain Drop","Soundtrack","Crystal","Atmosphere","Brightness","Goblins","Echoes","SF","Sitar","Banjo","Shamisen","Koto","Kalimba","Bag pipe","Fiddle","Shanai","Tinkle Bell","Agogo","Steel Drums","Woodblock","Taiko Drum","Melodic Tom","Synth Drum","Reverse Cym.","Gt Fret Noise","Breath Noise","Seashore","Bird","Telephone","Helicopter","Applause","Gunshot"]);
function programInstrument(program) {
  const exact = PROGRAMS.indexOf(program); if (exact >= 0) return exact;
  if (program >= 32 && program <= 39) return 1;
  if (program >= 24 && program <= 31) return 5;
  if (program >= 72 && program <= 79) return 6;
  if (program >= 8 && program <= 15) return 7;
  if (program >= 80 && program <= 103) return 13;
  return 0;
}
function drumInstrument(key) { return key === 35 || key === 36 ? 2 : key === 38 || key === 40 ? 3 : 4; }

// Exact native MIDI drum table: midi_instruments.gml keys24..87, pitch column +33.
const DRUMS = [[13,72],[3,41],[4,58],[3,51],[3,60],[4,49],[4,46],[4,42],[4,39],[4,35],[8,50],[2,43],[2,39],[4,39],[3,41],[4,39],[3,37],[2,39],[3,55],[2,46],[3,55],[2,48],[3,51],[2,53],[2,56],[3,50],[2,56],[3,57],[3,41],[3,46],[4,51],[3,51],[11,38],[3,46],[4,35],[3,46],[4,42],[4,35],[4,41],[2,55],[2,48],[3,46],[3,41],[9,45],[9,38],[4,53],[4,56],[6,67],[6,66],[4,50],[4,44],[4,51],[4,43],[4,38],[12,58],[12,59],[4,49],[8,52],[3,55],[8,39],[8,48],[4,54],[2,47],[2,40]];
export const MIDI_PERCUSSION_DEFAULTS = Object.freeze(Object.fromEntries(DRUMS.map(([instrument, key], i) => [i + 24, Object.freeze({instrument, key})])));

function midiImportOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('MIDI 导入设置必须是对象。');
  const numeric = (name, fallback, min, max, integral = false) => {
    const value = options[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integral && !Number.isInteger(value)) throw new Error(`MIDI ${name} 必须在 ${min}–${max} 之间${integral ? '且为整数' : ''}。`);
    return value;
  };
  const boolean = (name, fallback) => {
    const value = options[name] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`MIDI ${name} 必须是布尔值。`);
    return value;
  };
  const custom = options.customInstruments ?? [];
  const namingMode = options.namingMode ?? 'track';
  if (!['track', 'patch', 'channel'].includes(namingMode)) throw new Error('MIDI namingMode 必须为 track、patch 或 channel。');
  if (!Array.isArray(custom) || custom.length > 255) throw new Error('MIDI 自定义乐器必须是数组，最多 255 个。');
  const customInstruments = custom.map((definition, i) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) || typeof definition.name !== 'string' || definition.name.length > 1024 || typeof definition.file !== 'string' || definition.file.length > 4096 || !Number.isInteger(definition.key) || definition.key < 0 || definition.key > 87) throw new Error(`MIDI 自定义乐器 ${i + 1} 的定义无效。`);
    try { return {...structuredClone(definition), pressKey: !!definition.pressKey}; } catch { throw new Error(`MIDI 自定义乐器 ${i + 1} 不能复制。`); }
  });
  const mapping = (name, percussion, maxId = 127) => {
    const source = options[name] ?? {};
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length > maxId + 1) throw new Error(`MIDI ${name} 必须是最多 ${maxId + 1} 项的映射对象。`);
    return Object.fromEntries(Object.entries(source).map(([key, value]) => {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > maxId) throw new Error(`MIDI ${name} 的编号必须在 0–${maxId} 之间。`);
      const record = typeof value === 'number' ? {instrument: value} : value;
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isInteger(record.instrument) || record.instrument < -1 || record.instrument > 15 + customInstruments.length) throw new Error(`MIDI ${name}[${key}] 引用了无效或未定义的乐器。`);
      const result = {instrument: record.instrument};
      if (percussion && record.key !== undefined) {
        if (!Number.isInteger(record.key) || record.key < 0 || record.key > 87) throw new Error(`MIDI ${name}[${key}].key 必须在 0–87 之间。`);
        result.key = record.key;
      }
      if (!percussion && record.octave !== undefined) {
        if (!Number.isInteger(record.octave) || record.octave < -8 || record.octave > 8) throw new Error(`MIDI ${name}[${key}].octave 必须在 -8–8 之间。`);
        result.octave = record.octave;
      }
      return [key, result];
    }));
  };
  return {targetTempo: options.targetTempo == null ? null : numeric('targetTempo', 8, .05, 655.35),
    gridSubdivision: numeric('gridSubdivision', 1, 1, 16, true), octaveOffset: numeric('octaveOffset', 0, -8, 8, true),
    keepVelocity: boolean('keepVelocity', true), keepPan: boolean('keepPan', true), removeSilent: boolean('removeSilent', false),
    keepWithinOctaveRange: boolean('keepWithinOctaveRange', false), maxLayers: numeric('maxLayers', 65535, 1, 65535, true), trackNames: boolean('trackNames', true), namingMode,
    programMap: mapping('programMap', false), channelMap: mapping('channelMap', false, 15), percussionMap: mapping('percussionMap', true), customInstruments};
}

/** Import SMF 0/1. Flatten tempo changes in seconds onto a configurable fixed tick grid. */
export function parseMIDI(input, options = {}) {
  const settings = midiImportOptions(options);
  const r = new Reader(input, 'MIDI');
  const tag = () => String.fromCharCode(...r.take(4));
  if (tag() !== 'MThd') throw new Error('这不是标准 MIDI 文件（缺少 MThd）。');
  const headerLength = r.u32(false);
  if (headerLength < 6) throw new Error('MIDI 文件头长度无效。');
  const format = r.u16(false), trackCount = r.u16(false), division = r.u16(false);
  if (format > 1) throw new Error('仅支持 MIDI 格式 0 和 1；格式 2 包含独立的歌曲。');
  if (!trackCount || trackCount > 1024) throw new Error('MIDI 轨道数量无效。');
  if (!division) throw new Error('MIDI 时间分辨率不能为 0。');
  r.take(headerLength - 6);
  const song = songBase(), rawNotes = [], channelEvents = [], tempoEvents = [{ tick: 0, tempo: 500000, order: -1 }], trackNames = [], copyright = [];
  let lastTick = 0, eventOrder = 0;
  const text = bytes => decodeText(bytes).replace(/\0/g, '');
  for (let track = 0; track < trackCount; track++) {
    if (tag() !== 'MTrk') throw new Error('MIDI 轨道缺少 MTrk 标记。');
    const length = r.u32(false), trackEnd = r.pos + length;
    r.need(length);
    const fileEnd = r.end; r.end = trackEnd;
    let tick = 0, running = 0, ended = false;
    const active = new Map();
    while (r.pos < trackEnd) {
      tick += r.vlq(); lastTick = Math.max(lastTick, tick);
      if (tick > 0x7fffffff) throw new Error('MIDI 时间轴过长。');
      let status = r.u8(), firstData;
      if (status < 128) { firstData = status; if (!running) throw new Error('MIDI 运行状态无效。'); status = running; }
      if (status >= 0x80 && status < 0xf0) running = status;
      const dataByte = () => { const b = firstData !== undefined ? firstData : r.u8(); firstData = undefined; if (b > 127) throw new Error('MIDI 数据字节无效。'); return b; };
      if (status === 0xff) {
        const type = r.u8(), size = r.vlq(), data = r.take(size);
        if (type === 0x2f) { if (size !== 0) throw new Error('MIDI 结束事件无效。'); ended = true; break; }
        if (type === 0x51) { if (size !== 3) throw new Error('MIDI 速度事件长度无效。'); const tempo = data[0] * 65536 + data[1] * 256 + data[2]; if (!tempo) throw new Error('MIDI 速度不能为 0。'); tempoEvents.push({ tick, tempo, order: eventOrder++ }); }
        if (type === 0x03) { trackNames[track] = text(data); if (!song.title) song.title = text(data); }
        if (type === 0x02) copyright.push(text(data));
        if (type === 0x01 && !song.description) song.description = text(data);
        if (type === 0x58 && size >= 2) song.timeSignature = clamp(data[0], 1, 16);
      } else if (status === 0xf0 || status === 0xf7) { running = 0; r.take(r.vlq()); }
      else if (status >= 0x80 && status <= 0xef) {
        const type = status >> 4, channel = status & 15, a = dataByte(), b = type === 0xc || type === 0xd ? 0 : dataByte();
        if (type === 0xc || type === 0xb && (a === 7 || a === 10)) channelEvents.push({ tick, track, order: eventOrder++, channel, type, a, b });
        if (type === 0x9 && b > 0) {
          const n = { tick, track, order: eventOrder++, channel, midiKey: a, midiVelocity: b };
          rawNotes.push(n);
          channelEvents.push(n);
          const key = channel * 128 + a, queue = active.get(key) || { notes: [], head: 0 }; queue.notes.push(n); active.set(key, queue);
          if (rawNotes.length > MAX_NOTES) throw new Error('MIDI 音符数量过大（上限 100 万）。');
        } else if (type === 0x8 || type === 0x9 && b === 0) {
          const key = channel * 128 + a, queue = active.get(key);
          if (queue && queue.head < queue.notes.length) { queue.notes[queue.head++].endTick = tick; if (queue.head === queue.notes.length) active.delete(key); }
        }
      } else throw new Error(`不支持 MIDI 状态 0x${status.toString(16)}。`);
    }
    if (!ended) song.metadata.missingEndOfTrack = true;
    r.pos = trackEnd; r.end = fileEnd;
  }
  // Channel settings are shared across tracks in SMF, including conductor tracks.
  const programs = new Uint8Array(16), volumes = Array(16).fill(100), pans = Array(16).fill(0);
  channelEvents.sort((a, b) => a.tick - b.tick || a.track - b.track || a.order - b.order);
  for (const e of channelEvents) {
    if (e.type === 0xc) programs[e.channel] = e.a;
    else if (e.type === 0xb) {
      if (e.a === 7) volumes[e.channel] = e.b / 127 * 100;
      if (e.a === 10) pans[e.channel] = Math.round((e.b - 64) / (e.b < 64 ? 64 : 63) * 100);
    } else {
      e.program = programs[e.channel];
      e.velocity = Math.round(e.midiVelocity / 127 * volumes[e.channel]);
      e.pan = pans[e.channel];
      e.instrument = e.channel === 9 ? drumInstrument(e.midiKey) : programInstrument(e.program);
    }
  }
  tempoEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const tempos = [];
  for (const event of tempoEvents) { if (tempos.at(-1)?.tick === event.tick) tempos[tempos.length - 1] = event; else tempos.push(event); }
  const smpte = !!(division & 0x8000);
  let fps, ticksPerFrame;
  if (smpte) { const code = (division >> 8) - 256; fps = code === -29 ? 29.97 : -code; ticksPerFrame = division & 255; if (![24, 25, 29.97, 30].includes(fps) || !ticksPerFrame) throw new Error('MIDI SMPTE 时间分辨率无效。'); }
  const initialTempo = tempos[0].tempo;
  song.tempo = Math.round(4000000 / initialTempo * 100) / 100;
  if (song.tempo <= 0 || song.tempo > 655.35) song.tempo = 10;
  const baseTempo = settings.targetTempo ?? song.tempo;
  if (baseTempo * settings.gridSubdivision > 655.35 + 1e-9) throw new Error('MIDI 导入后的有效速度超过 655.35 tick/秒，请降低目标速度或时间精度。');
  song.tempo = Math.round(baseTempo * settings.gridSubdivision * 100) / 100;
  song.customInstruments = settings.customInstruments;
  let seconds = 0;
  for (let i = 0; i < tempos.length; i++) { if (i) seconds += (tempos[i].tick - tempos[i - 1].tick) / division * tempos[i - 1].tempo / 1000000; tempos[i].seconds = seconds; }
  const secondsAt = tick => {
    if (smpte) return tick / (fps * ticksPerFrame);
    let lo = 0, hi = tempos.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tempos[mid].tick <= tick) lo = mid; else hi = mid - 1; }
    const t = tempos[lo]; return t.seconds + (tick - t.tick) / division * t.tempo / 1000000;
  };
  const prepared = []; let outOfRange = 0, mappedOut = 0, percussionFallbacks = 0;
  for (const n of rawNotes.sort((a, b) => a.tick - b.tick || a.track - b.track)) {
    let key = n.midiKey - 21, instrument = n.instrument, octave = 0;
    if (n.channel === 9) {
      const native = MIDI_PERCUSSION_DEFAULTS[n.midiKey];
      if (!native && !settings.percussionMap[n.midiKey]) percussionFallbacks++;
      const selected = settings.percussionMap[n.midiKey] ?? native ?? {instrument: 4, key: 45};
      instrument = selected.instrument; key = selected.key ?? native?.key ?? 45;
    } else {
      const selected = settings.programMap[n.program];
      if (selected) { instrument = selected.instrument; octave = selected.octave || 0; }
    }
    // A channel override replaces the entire melodic patch mapping. On channel
    // 10 it keeps the per-drum absolute key, then transposes that resolved key.
    const channel = settings.channelMap[n.channel];
    if (channel) { instrument = channel.instrument; octave = channel.octave || 0; }
    if (instrument === -1) { mappedOut++; continue; }
    key += (settings.octaveOffset + octave) * 12;
    if (settings.keepWithinOctaveRange) { while (key < 33) key += 12; while (key > 57) key -= 12; }
    if (key < 0 || key > 87) { outOfRange++; continue; }
    prepared.push({raw: n, key, instrument, seconds: secondsAt(n.tick)});
  }
  const originSeconds = settings.removeSilent && prepared.length ? prepared[0].seconds : 0;
  const lanes = new Map();
  for (const {raw: n, key, instrument, seconds: noteSeconds} of prepared) {
    const tick = Math.max(0, Math.round((noteSeconds - originSeconds) * song.tempo));
    if (tick > 999999) throw new Error('MIDI 导入后的时间轴超过 1,000,000 tick；请降低目标速度或时间精度。');
    const groupKey = `${n.track}/${n.channel}`;
    let group = lanes.get(groupKey);
    if (!group) { group = {lanes: [], tick: -1, next: 0}; lanes.set(groupKey, group); }
    // Onsets are sorted. At each new quantized tick all prior lanes are reusable;
    // a cursor avoids quadratic scans for very large simultaneous chords.
    if (group.tick !== tick) { group.tick = tick; group.next = 0; }
    let lane = group.lanes[group.next++];
    if (!lane) {
      const id = song.layers.length;
      if (id >= settings.maxLayers) throw new Error(`MIDI 导入需要超过 ${settings.maxLayers} 个图层；未截断或丢弃任何和弦。`);
      lane = { id, tick: -1 }; group.lanes.push(lane);
      const name = !settings.trackNames ? `轨道 ${n.track + 1}` : settings.namingMode === 'patch' ? n.channel === 9 ? 'Percussion' : MIDI_PROGRAM_NAMES[n.program] : settings.namingMode === 'channel' ? `Channel ${n.channel + 1}` : trackNames[n.track] || `轨道 ${n.track + 1}`;
      song.layers.push(defaultLayer(id, `${name}${n.channel === 9 && settings.namingMode === 'track' ? ' · 打击乐' : ''}${group.lanes.length > 1 ? ` · ${group.lanes.length}` : ''}`));
    }
    lane.tick = tick;
    const duration = Math.max(1, Math.round((secondsAt(n.endTick ?? n.tick + division / 4) - secondsAt(n.tick)) * song.tempo));
    song.notes.push({ id: `n${song.notes.length + 1}`, tick, layer: lane.id, key, instrument, velocity: settings.keepVelocity ? n.velocity : 100, pan: settings.keepPan ? n.pan : 0, pitch: 0, duration });
  }
  if (!song.layers.length) song.layers.push(defaultLayer(0));
  song.author = copyright.join('\n');
  song.length = song.notes.reduce((max, n) => Math.max(max, n.tick + 1), Math.max(1, Math.ceil((secondsAt(lastTick) - originSeconds) * song.tempo - 1e-9)));
  if (song.length > 1000000) throw new Error('MIDI 导入后的时间轴超过 1,000,000 tick；请降低目标速度或时间精度。');
  const {customInstruments, ...recordedOptions} = settings;
  song.metadata = { ...song.metadata, midiFormat: format, midiDivision: division, tempoChanges: tempos.length, skippedOutOfRangeNotes: outOfRange,
    skippedMappedNotes: mappedOut, skippedNotes: outOfRange + mappedOut, percussionFallbackNotes: percussionFallbacks,
    midiBaseTempo: baseTempo, midiEffectiveTempo: song.tempo, leadingSilenceSecondsRemoved: originSeconds,
    midiImportOptions: {...recordedOptions, customInstrumentCount: customInstruments.length} };
  return song;
}

function midiTrack(events, endTick) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const w = new Writer(); let last = 0;
  for (const e of events) { w.vlq(e.tick - last); w.raw(e.bytes); last = e.tick; }
  w.vlq(Math.max(0, endTick - last)); w.raw([0xff, 0x2f, 0]);
  const track = new Writer(), data = w.finish(); track.raw([77, 84, 114, 107]); track.u32(data.length, false); track.raw(data); return track.finish();
}
function midiText(type, value) { const w = new Writer(), bytes = textEncoder.encode(String(value || '')); w.raw([0xff, type]); w.vlq(bytes.length); w.raw(bytes); return w.finish(); }

/** Export type 1 MIDI, 480 PPQN, 4 NBS ticks per quarter note. */
export function writeMIDI(song) {
  if (!song || !Array.isArray(song.notes) || !Array.isArray(song.layers)) throw new Error('歌曲数据无效。');
  if (!Number.isFinite(Number(song.tempo)) || song.tempo <= 0) throw new Error('歌曲速度必须大于 0。');
  if (song.notes.length > MAX_NOTES) throw new Error('音符数量超过 MIDI 导出上限。');
  const quarterMicros = Math.round(4000000 / song.tempo);
  if (quarterMicros < 1 || quarterMicros > 0xffffff) throw new Error('此速度超出 MIDI 可表示的范围。');
  const end = song.notes.reduce((max, n) => Math.max(max, integer(n.tick) + Math.max(1, integer(n.duration, 1))), Math.max(1, integer(song.length, 1))) * 120;
  if (end > 0x0fffffff) throw new Error('歌曲过长，无法导出 MIDI。');
  const conductor = [{ tick: 0, order: 0, bytes: [0xff, 0x51, 3, quarterMicros >>> 16, quarterMicros >>> 8 & 255, quarterMicros & 255] },
    { tick: 0, order: 1, bytes: [0xff, 0x58, 4, clamp(integer(song.timeSignature, 4), 1, 16), 2, 24, 8] }];
  if (song.title) conductor.push({ tick: 0, order: 2, bytes: midiText(3, song.title) });
  if (song.author) conductor.push({ tick: 0, order: 3, bytes: midiText(2, song.author) });
  if (song.description) conductor.push({ tick: 0, order: 4, bytes: midiText(1, song.description) });
  const groups = new Map(), solo = song.layers.some(l => l.solo);
  for (const n of song.notes) {
    const l = song.layers[n.layer] || defaultLayer(n.layer);
    if (l.muted || solo && !l.solo) continue;
    if (!Number.isInteger(n.tick) || n.tick < 0 || !Number.isInteger(n.key) || n.key < 0 || n.key > 87) throw new Error('音符时间或音高无效。');
    const rawInstrument = integer(n.instrument);
    const instrument = rawInstrument >= 0 && rawInstrument < 16 ? rawInstrument : 0;
    const key = `${n.layer}/${instrument}`;
    if (!groups.has(key)) groups.set(key, { layer: l, instrument, notes: [] });
    groups.get(key).notes.push(n);
  }
  if (groups.size > 1023) throw new Error('MIDI 导出最多支持 1023 个乐器图层。');
  const tracks = [midiTrack(conductor, end)];
  const instrumentChannels = new Map();
  for (let instrument = 0, channel = 0; instrument < 16; instrument++) {
    if ([2, 3, 4].includes(instrument)) { instrumentChannels.set(instrument, 9); continue; }
    if (channel === 9) channel++;
    instrumentChannels.set(instrument, channel++);
  }
  for (const g of groups.values()) {
    // Allocate by instrument so simultaneous tracks never fight over program.
    const ch = instrumentChannels.get(g.instrument);
    const events = [{ tick: 0, order: -4, bytes: midiText(3, g.layer.name || '图层') }];
    let order = 0;
    for (const n of g.notes) {
      const tick = n.tick * 120;
      const note = g.instrument === 2 ? 36 : g.instrument === 3 ? 38 : g.instrument === 4 ? 42 : n.key + 21;
      const velocity = Math.round(clamp(n.velocity ?? 100, 0, 100) * clamp(g.layer.volume ?? 100, 0, 100) / 100 / 100 * 127);
      if (!velocity) continue;
      const pan = Math.round((clamp((Number(n.pan) || 0) + (Number(g.layer.pan) || 0), -100, 100) + 100) / 200 * 127);
      if (ch !== 9) events.push({ tick, order: order++, bytes: [0xc0 | ch, PROGRAMS[g.instrument]] });
      events.push({ tick, order: order++, bytes: [0xb0 | ch, 10, pan] });
      events.push({ tick, order: order++, bytes: [0x90 | ch, note, Math.max(1, velocity)] });
      events.push({ tick: tick + Math.max(1, integer(n.duration, 1)) * 120, order: -1, bytes: [0x80 | ch, note, 0] });
    }
    tracks.push(midiTrack(events, end));
  }
  const w = new Writer(); w.raw([77, 84, 104, 100]); w.u32(6, false); w.u16(1, false); w.u16(tracks.length, false); w.u16(480, false);
  for (const t of tracks) w.raw(t);
  return w.finish();
}
