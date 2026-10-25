/** Browser-only custom-instrument edits. Input sample maps are never mutated. */
import {createBlankSong} from './model.js';
import {writeProjectBundle} from './project-bundle.js';
import {localFileKey,matchLocalFileReferences} from './file-paths.js';

export const MAX_CUSTOM_INSTRUMENTS = 240;
function definitions(value) {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_INSTRUMENTS) throw new Error('NBS 最多支持 240 个自定义音色。');
  return value.map((definition, index) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) || typeof definition.name !== 'string' || definition.name.length > 1024 || typeof definition.file !== 'string' || definition.file.length > 4096 || !Number.isInteger(definition.key) || definition.key < 0 || definition.key > 87) throw new Error(`自定义音色 ${index + 1} 的定义无效。`);
    return {...structuredClone(definition), pressKey: !!definition.pressKey};
  });
}
function checked(song, samples) {
  if (!song || !Array.isArray(song.notes)) throw new Error('缺少音色工程。');
  const custom = definitions(song.customInstruments);
  if (!(samples instanceof Map)) throw new Error('采样库必须为 Map。');
  for (const [index] of samples) if (!Number.isInteger(index) || index < 0 || index >= custom.length) throw new Error('采样库包含无效的音色索引。');
  for (const note of song.notes) if (!Number.isInteger(note.instrument) || note.instrument < 0 || note.instrument >= 16 + custom.length) throw new Error('工程音符引用了未定义的音色。');
  return custom;
}
function customIndex(index, count) { if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('当前自定义音色无效。'); }
function remap(song, custom, samples, mapping) {
  const instrumentMap = new Map(Array.from({length: 16 + song.customInstruments.length}, (_, instrument) => [instrument, instrument < 16 ? instrument : mapping[instrument - 16] < 0 ? -1 : 16 + mapping[instrument - 16]]));
  const notes = [], removedNoteIds = [], bank = new Map();
  for (const note of song.notes) { const instrument = instrumentMap.get(note.instrument); if (instrument < 0) removedNoteIds.push(note.id); else notes.push(instrument === note.instrument ? note : {...note, instrument}); }
  for (const [index, buffer] of samples) if (mapping[index] >= 0) bank.set(mapping[index], buffer);
  song.customInstruments = custom; song.notes = notes;
  return {changed: true, samples: bank, instrumentMap, removedNoteIds};
}

/** customIndex is zero based; deleting a definition also removes all its note references. */
export function removeInstrument(song, index, samples = new Map()) {
  const custom = checked(song, samples); customIndex(index, custom.length);
  const mapping = custom.map((_, source) => source === index ? -1 : source > index ? source - 1 : source);
  custom.splice(index, 1);
  return remap(song, custom, samples, mapping);
}

/** Swap definition order while retaining each note's original sound and each PCM buffer's identity. */
export function swapInstruments(song, index, target, samples = new Map()) {
  const custom = checked(song, samples); customIndex(index, custom.length); customIndex(target, custom.length);
  const mapping = custom.map((_, source) => source === index ? target : source === target ? index : source);
  if (index === target) return {changed: false, samples: new Map(samples), instrumentMap: new Map(Array.from({length: 16 + custom.length}, (_, i) => [i, i])), removedNoteIds: []};
  [custom[index], custom[target]] = [custom[target], custom[index]];
  return remap(song, custom, samples, mapping);
}
export function moveInstrument(song, index, direction, samples = new Map()) {
  if (!['up', 'down'].includes(direction)) throw new Error('音色移动方向必须为 up 或 down。');
  if (!Array.isArray(song?.customInstruments)) throw new Error('缺少音色工程。');
  const target = index + (direction === 'up' ? -1 : 1);
  return swapInstruments(song, index, Math.max(0, Math.min(song.customInstruments.length - 1, target)), samples);
}

/** Append imported NBS/project definitions only. Explicit decoded source PCM takes precedence over filename reuse. */
export function importInstrumentDefinitions(song, imported, {samples = new Map(), sourceSamples = new Map()} = {}) {
  const custom = checked(song, samples), incoming = definitions(imported?.customInstruments);
  if (custom.length + incoming.length > MAX_CUSTOM_INSTRUMENTS) throw new Error('导入后自定义音色超过 NBS 的 240 个上限，未修改工程。');
  if (!(sourceSamples instanceof Map)) throw new Error('待导入采样库必须为 Map。');
  for (const [index] of sourceSamples) customIndex(index, incoming.length);
  const bank = new Map(samples), matches = new Map(), addedIndices = [], sourceInstrumentMap = new Map(Array.from({length: 16}, (_, i) => [i, i]));
  const remember = (file, buffer, replace = false) => {
    const key = localFileKey(file); if (!key) return;
    if (replace || !matches.has(key)) matches.set(key, new Set());
    matches.get(key).add(buffer);
  };
  const reuse = file => {
    const keys = [...matches.keys()], {indices} = matchLocalFileReferences(file, keys);
    const buffers = new Set(indices.flatMap(index => [...matches.get(keys[index])]));
    if (buffers.size > 1) throw new Error('音色文件路径存在歧义：大小写或相同路径对应多个不同采样，未修改工程。请指定待导入音色的采样。');
    return buffers.values().next().value;
  };
  custom.forEach((definition, index) => { if (samples.has(index)) remember(definition.file, samples.get(index)); });
  incoming.forEach((definition, index) => {
    const target = custom.length; custom.push(definition); addedIndices.push(target); sourceInstrumentMap.set(16 + index, 16 + target);
    const supplied = sourceSamples.get(index), buffer = supplied ?? reuse(definition.file);
    if (buffer) { bank.set(target, buffer); remember(definition.file, buffer, supplied != null); }
  });
  if (incoming.length) song.customInstruments = custom;
  return {changed: incoming.length > 0, samples: bank, addedIndices, sourceInstrumentMap};
}

/** A portable NBPZ contains just definitions plus decoded PCM; no filesystem paths are accessed. */
export async function exportInstrumentBundle(song, samples = new Map()) {
  const custom = checked(song, samples), project = {...createBlankSong(), title: `${song.title || 'Untitled'} — Instruments`, customInstruments: custom, notes: []};
  return writeProjectBundle(project, new Map(samples));
}
