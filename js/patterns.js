/** Open Note Block Studio NBP v1 and its native pipe-delimited selection code. */
import {MAX_NOTES, MAX_LAYERS} from './model.js';
import {bounds, pasteNotes} from './edit.js';

const MAX_TICK = 999999;
const MAX_CODE_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}超出范围（${min}–${max}）。`);
  return value;
};
const finite = (value, min, max, label) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出范围（${min}–${max}）。`);
  return value;
};
const bytesOf = value => value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : (() => {throw new TypeError('分段数据必须是 ArrayBuffer 或 TypedArray。');})();
const maxInstrument = options => options.customInstrumentCount === undefined ? 270 : 15 + integer(options.customInstrumentCount, 0, 255, '自定义乐器数量');

function validateNotes(notes, options = {}) {
  if (!Array.isArray(notes) || notes.length > MAX_NOTES) throw new Error(`分段最多支持 ${MAX_NOTES} 个音符。`);
  const cells = new Set(), maxIns = maxInstrument(options);
  return notes.map(note => {
    if (!note || typeof note !== 'object') throw new Error('分段包含无效音符。');
    const result = {...note,
      tick: integer(Number(note.tick), 0, MAX_TICK, '音符时间'), layer: integer(Number(note.layer), 0, MAX_LAYERS - 1, '音符图层'),
      instrument: integer(Number(note.instrument), 0, maxIns, '乐器编号'), key: integer(Number(note.key), 0, 87, '音高'),
      velocity: finite(Number(note.velocity ?? 100), 0, 100, '力度'), pan: finite(Number(note.pan ?? 0), -100, 100, '声像'),
      pitch: finite(Number(note.pitch ?? 0), -32768, 32767, '微调音高')};
    const cell = `${result.tick}:${result.layer}`;
    if (cells.has(cell)) throw new Error('分段在同一时间和图层包含重复音符。');
    cells.add(cell);
    return result;
  }).sort((a, b) => a.tick - b.tick || a.layer - b.layer);
}

/** Parse uncompressed native code. Deltas start at zero; -1 is a column terminator only in the layer field. */
export function parseSelectionCode(text, options = {}) {
  if (typeof text !== 'string' || text.length > MAX_CODE_BYTES || text.includes('\0')) throw new Error('分段代码无效或过长。');
  text = text.trim();
  if (!text) return {notes: [], width: 1, height: 1};
  if (!text.includes('|')) throw new Error('压缩分段代码请使用 decodeSelectionCode() 读取。');
  const tokens = text.split('|');
  if (tokens.at(-1) === '') tokens.pop();
  let index = 0, tick = 0, lastTick = -1, maxLayer = 0;
  const notes = [];
  const next = label => {
    if (index >= tokens.length || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(tokens[index].trim())) throw new Error(`分段代码缺少或包含无效的${label}（字段 ${index + 1}）。`);
    return Number(tokens[index++]);
  };
  while (index < tokens.length) {
    const delta = integer(next('时间增量'), 0, MAX_TICK, '时间增量');
    tick += delta;
    integer(tick, 0, MAX_TICK, '音符时间');
    if (tick <= lastTick) throw new Error('分段列的时间必须递增。');
    let layer = 0, count = 0;
    while (true) {
      const deltaLayer = next('图层增量');
      if (deltaLayer === -1) break;
      integer(deltaLayer, 0, MAX_LAYERS - 1, '图层增量');
      if (count && !deltaLayer) throw new Error('同一列不能包含重复图层。');
      layer += deltaLayer;
      integer(layer, 0, MAX_LAYERS - 1, '音符图层');
      notes.push({tick, layer, instrument: next('乐器'), key: next('音高'), velocity: next('力度'), pan: next('声像') - 100, pitch: next('微调音高')});
      if (notes.length > MAX_NOTES) throw new Error(`分段最多支持 ${MAX_NOTES} 个音符。`);
      count++; maxLayer = Math.max(maxLayer, layer);
    }
    if (!count) throw new Error('分段代码包含空列。');
    lastTick = tick;
  }
  return {notes: validateNotes(notes, options), width: lastTick + 1, height: maxLayer + 1};
}

export function writeSelectionCode(notes, options = {}) {
  const sorted = validateNotes(notes, options), values = [];
  let previousTick = 0, index = 0;
  while (index < sorted.length) {
    const tick = sorted[index].tick;
    values.push(tick - previousTick);
    let previousLayer = 0;
    while (index < sorted.length && sorted[index].tick === tick) {
      const note = sorted[index++];
      values.push(note.layer - previousLayer, note.instrument, note.key, note.velocity, note.pan + 100, note.pitch);
      previousLayer = note.layer;
    }
    values.push(-1); previousTick = tick;
  }
  const code = values.length ? values.join('|') + '|' : '';
  if (code.length > MAX_CODE_BYTES) throw new Error('分段代码超过 64 MiB。');
  return code;
}

/** Also accepts GameMaker's base64-encoded zlib clipboard form; decompression is bounded. */
export async function decodeSelectionCode(text, options = {}) {
  if (typeof text !== 'string' || text.length > MAX_CODE_BYTES) throw new Error('分段代码无效或过长。');
  if (!text || text.includes('|')) return parseSelectionCode(text, options);
  if (typeof DecompressionStream !== 'function') throw new Error('此浏览器不支持原版压缩分段代码；请先从原版导出 .nbp 文件。');
  const base64 = text.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4) throw new Error('压缩分段代码不是有效的 Base64。');
  let reader;
  try {
    const binary = atob(base64), input = Uint8Array.from(binary, char => char.charCodeAt(0));
    reader = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks = []; let size = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_CODE_BYTES) { await reader.cancel(); throw new Error('解压后的分段代码超过 64 MiB。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    return parseSelectionCode(decoder.decode(bytes).replace(/\0+$/, ''), options);
  } catch (error) { throw new Error(`无法读取压缩分段代码：${error.message}`); }
  finally { reader?.releaseLock(); }
}

export function parseNBP(input, options = {}) {
  const bytes = bytesOf(input);
  if (bytes.length < 8 || bytes.length > MAX_CODE_BYTES + 131078) throw new Error('NBP 文件过短或超过大小限制。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version !== 1) throw new Error(`不支持 NBP 版本 ${version}；当前支持原版 v1。`);
  const width = view.getUint16(5, true);
  if (!width) throw new Error('NBP 分段宽度不能为零。');
  const end = bytes.indexOf(0, 7);
  if (end < 0 || end - 7 > MAX_CODE_BYTES) throw new Error('NBP 文件缺少分段代码终止符。');
  if (bytes.length - end - 1 < width * 2) throw new Error('NBP 文件的列边界数据被截断。');
  let text;
  try { text = decoder.decode(bytes.subarray(7, end)); } catch { throw new Error('NBP 分段代码不是有效 UTF-8。'); }
  const pattern = parseSelectionCode(text, options);
  if (pattern.notes.length && pattern.width > width) throw new Error('NBP 音符位于声明的分段宽度之外。');
  return {...pattern, version, width, metadata: {songLastTick: view.getUint16(1, true), songLastLayer: view.getUint16(3, true),
    columnBounds: bytes.slice(end + 1, end + 1 + width * 2), trailingBytes: bytes.slice(end + 1 + width * 2)}};
}

export function writeNBP(pattern, options = {}) {
  if (!pattern || typeof pattern !== 'object') throw new Error('缺少待导出的分段。');
  const notes = validateNotes(pattern.notes, options), area = bounds(notes);
  const width = integer(Number(pattern.width ?? (notes.length ? area.maxTick + 1 : 1)), 1, 65535, 'NBP 分段宽度');
  if (notes.some(note => note.tick >= width)) throw new Error('NBP 音符位于声明的分段宽度之外。');
  const code = encoder.encode(writeSelectionCode(notes, options));
  const bytes = new Uint8Array(8 + code.length + width * 2), view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(1, integer(Number(pattern.metadata?.songLastTick ?? area.maxTick), 0, 65535, 'NBP 原曲长度'), true);
  view.setUint16(3, integer(Number(pattern.metadata?.songLastLayer ?? area.maxLayer), 0, 65535, 'NBP 原曲图层'), true);
  view.setUint16(5, width, true); bytes.set(code, 7);
  const start = 8 + code.length;
  bytes.fill(255, start);
  const seenColumns = new Set();
  for (const note of notes) {
    const offset = start + note.tick * 2;
    // The original format stores these as signed bytes. The code remains authoritative above 127 layers.
    if (!seenColumns.has(note.tick)) { bytes[offset] = note.layer & 255; seenColumns.add(note.tick); }
    bytes[offset + 1] = note.layer & 255;
  }
  return bytes;
}

export function patternFromSelection(song, ids) {
  const selected = new Set(ids || []), notes = song.notes.filter(note => selected.has(note.id));
  if (!notes.length) throw new Error('请先选择要保存的音符。');
  const area = bounds(notes);
  return {version: 1, width: area.maxTick - area.minTick + 1, height: area.maxLayer - area.minLayer + 1,
    notes: notes.map(({id, ...note}) => ({...note, tick: note.tick - area.minTick, layer: note.layer - area.minLayer})),
    metadata: {songLastTick: Math.min(65535, Math.max(0, (song.length || 1) - 1)), songLastLayer: song.layers.length - 1}};
}

/** Custom instruments are index references in native NBP, so require corresponding definitions in the destination. */
export function insertPattern(song, pattern, {tick = 0, layer = 0, instrumentMap} = {}) {
  let notes = validateNotes(pattern?.notes);
  if (instrumentMap) notes = notes.map(note => ({...note, instrument: instrumentMap[note.instrument] ?? note.instrument}));
  notes = validateNotes(notes, {customInstrumentCount: song.customInstruments?.length || 0});
  return pasteNotes(song, notes, {tick, layer});
}
