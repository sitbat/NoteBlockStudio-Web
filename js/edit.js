import {uniqueId, MAX_NOTES, MAX_LAYERS} from './model.js';
const MAX_TICK = 999999;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const offset = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
const cell = note => `${note.tick}:${note.layer}`;
const defaultLayer = id => ({id, name: `音轨 ${id + 1}`, volume: 100, pan: 0, reverb: 0, muted: false, solo: false, locked: false});

/** Iterative bounds avoid function-argument limits with large selections. */
export function bounds(notes) {
  let minTick = Infinity, maxTick = -Infinity, minLayer = Infinity, maxLayer = -Infinity;
  for (const note of notes) {
    if (!note || !Number.isFinite(note.tick) || !Number.isFinite(note.layer)) continue;
    minTick = Math.min(minTick, note.tick); maxTick = Math.max(maxTick, note.tick);
    minLayer = Math.min(minLayer, note.layer); maxLayer = Math.max(maxLayer, note.layer);
  }
  return minTick === Infinity ? {minTick: 0, maxTick: 0, minLayer: 0, maxLayer: 0} : {minTick, maxTick, minLayer, maxLayer};
}

/** Move unlocked selected notes with one common offset, replacing collisions. */
export function moveNotes(song, ids, {dt = 0, dl = 0, dk = 0} = {}) {
  const selectedIds = ids instanceof Set ? ids : new Set(ids || []);
  if (!selectedIds.size || !song.layers?.length) return false;
  const selected = song.notes.filter(note => selectedIds.has(note.id) && !song.layers[note.layer]?.locked);
  if (!selected.length) return false;
  const area = bounds(selected);
  dt = clamp(offset(dt), -area.minTick, MAX_TICK - area.maxTick);
  dl = clamp(offset(dl), -area.minLayer, song.layers.length - 1 - area.maxLayer);
  let minKey = Infinity, maxKey = -Infinity;
  for (const note of selected) { minKey = Math.min(minKey, note.key); maxKey = Math.max(maxKey, note.key); }
  dk = clamp(offset(dk), -minKey, 87 - maxKey);
  if (!dt && !dl && !dk) return false;
  // Check every destination before changing any note or removing a collision.
  if (selected.some(note => song.layers[note.layer + dl]?.locked)) return false;
  const movingIds = new Set(selected.map(note => note.id));
  const finalNotes = new Map();
  let lastTick = Math.max(1, Number(song.length) || 1) - 1;
  for (const note of song.notes) if (!movingIds.has(note.id)) { finalNotes.set(cell(note), note); lastTick = Math.max(lastTick, note.tick); }
  for (const note of selected) {
    note.tick += dt; note.layer += dl; note.key += dk;
    finalNotes.set(cell(note), note);
    lastTick = Math.max(lastTick, note.tick);
  }
  song.notes = [...finalNotes.values()];
  song.length = Math.min(MAX_TICK + 1, lastTick + 1);
  return true;
}

/** Paste relative notes atomically. Invalid ranges/counts leave the song untouched. */
export function pasteNotes(song, relativeNotes, {tick = 0, layer = 0} = {}) {
  if (!Array.isArray(relativeNotes)) throw new TypeError('粘贴内容必须是音符数组。');
  if (!relativeNotes.length) return [];
  if (!Number.isFinite(Number(tick)) || !Number.isFinite(Number(layer))) throw new Error('粘贴起点坐标无效。');
  const startTick = offset(tick), startLayer = offset(layer);
  const additions = new Map();
  let lastLayer = song.layers.length - 1;
  let lastTick = Math.max(1, Number(song.length) || 1) - 1;
  for (const relative of relativeNotes) {
    if (!relative || typeof relative !== 'object' || !Number.isFinite(Number(relative.tick)) || !Number.isFinite(Number(relative.layer))) throw new Error('粘贴内容包含无效音符坐标。');
    const targetTick = startTick + Math.round(Number(relative.tick));
    const targetLayer = startLayer + Math.round(Number(relative.layer));
    if (targetTick < 0 || targetTick > MAX_TICK) throw new Error('粘贴位置超出时间轴范围（0–999999 tick）。');
    if (targetLayer < 0 || targetLayer >= MAX_LAYERS) throw new Error(`粘贴位置超出音轨范围，最多支持 ${MAX_LAYERS} 条音轨。`);
    if (song.layers[targetLayer]?.locked) continue;
    const note = {...relative, tick: targetTick, layer: targetLayer};
    additions.set(cell(note), note);
    if (additions.size > MAX_NOTES) throw new Error(`粘贴后音符数量超过 ${MAX_NOTES} 个。`);
    lastLayer = Math.max(lastLayer, targetLayer);
    lastTick = Math.max(lastTick, targetTick);
  }
  if (!additions.size) return [];
  const retained = new Map();
  for (const note of song.notes) if (!additions.has(cell(note))) { retained.set(cell(note), note); lastTick = Math.max(lastTick, note.tick); }
  if (retained.size + additions.size > MAX_NOTES) throw new Error(`粘贴后音符数量超过 ${MAX_NOTES} 个。`);
  // Validation is complete; create IDs/layers and commit the staged edit.
  const addedIds = [];
  for (const note of additions.values()) { note.id = uniqueId(); addedIds.push(note.id); }
  const layers = song.layers.slice();
  while (layers.length <= lastLayer) layers.push(defaultLayer(layers.length));
  song.layers = layers;
  song.notes = [...retained.values(), ...additions.values()];
  song.length = Math.min(MAX_TICK + 1, lastTick + 1);
  return addedIds;
}
