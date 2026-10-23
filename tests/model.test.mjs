import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoSong, createBlankSong, normalizeSong, noteName, uniqueId, History, MAX_NOTES, MAX_LAYERS} from '../js/model.js';

test('blank projects are independent, use four layers, and have sensible NBS defaults', () => {
  const a = createBlankSong();
  const b = createBlankSong();
  assert.equal(a.tempo, 10);
  assert.equal(a.timeSignature, 4);
  assert.equal(a.length, 64);
  assert.equal(a.layers.length, 4);
  assert.equal(a.layers[0].volume, 100);
  assert.equal(a.layers[0].pan, 0);
  assert.equal(a.layers[0].reverb, 0);
  a.layers[0].name = 'Changed';
  assert.notEqual(a.layers[0].name, b.layers[0].name);
});

test('ten thousand independent tracks keep their own reverb and note references', () => {
  const raw={layers:Array.from({length:10000},(_,id)=>({id,reverb:id%101})),notes:Array.from({length:10000},(_,layer)=>({tick:0,layer,key:45,instrument:0}))};
  const normalized=normalizeSong(raw);
  assert.equal(normalized.layers.length,10000);
  assert.equal(normalized.notes.length,10000);
  assert.equal(normalized.layers[9999].reverb,9999%101);
  assert.equal(normalized.notes[9999].layer,9999);
  normalized.layers[0].reverb=99;
  assert.equal(normalized.layers[101].reverb,0);
  assert.equal(raw.layers[0].reverb,0);
});

test('the original demo contains 128 notes, six instruments, and no overlapping cells', () => {
  const demo = createDemoSong();
  assert.equal(demo.notes.length, 128);
  assert.equal(demo.layers.length, 6);
  assert.equal(demo.length, 128);
  assert.equal(Math.max(...demo.notes.map(note => note.tick)), 63);
  assert.deepEqual([...new Set(demo.notes.map(note => note.instrument))].sort((a, b) => a - b), [0, 1, 2, 3, 4, 13]);
  assert.equal(new Set(demo.notes.map(note => `${note.tick}:${note.layer}`)).size, demo.notes.length);
  assert.equal(new Set(demo.notes.map(note => note.id)).size, demo.notes.length);
});

test('NBS keys map to MIDI-based note names across all octaves', () => {
  assert.equal(noteName(0), 'A0');
  assert.equal(noteName(39), 'C4');
  assert.equal(noteName(45), 'F♯4');
  assert.equal(noteName(87), 'C8');
  assert.notEqual(uniqueId(), uniqueId());
});

test('normalization preserves extensions, metadata and custom samples without mutating input', () => {
  const raw = {title: 'Song', extra: {nested: true}, metadata: {nbsVersion: 5, clicks: 10},
    layers: [{id: 12, name: 'Piano', color: '#f00', volume: 50}],
    notes: [{id: 'a', tick: 90, layer: 12, key: 45, extra: 'note'}],
    customInstruments: [{name: 'Sample', file: 'sample.wav', key: 57, pressKey: true, additional: 9}]};
  const song = normalizeSong(raw);
  assert.equal(song.notes[0].layer, 0);
  assert.equal(song.layers[0].id, 0);
  assert.equal(song.layers[0].color, '#f00');
  assert.equal(song.notes[0].extra, 'note');
  assert.equal(song.length, 91);
  assert.deepEqual(song.metadata, raw.metadata);
  assert.deepEqual(song.customInstruments, raw.customInstruments);
  song.extra.nested = false;
  song.metadata.clicks = 20;
  assert.equal(raw.extra.nested, true);
  assert.equal(raw.metadata.clicks, 10);
  assert.equal(raw.notes[0].layer, 12);
});

test('array-position layer references remain stable when layer IDs are renumbered', () => {
  const song = normalizeSong({layers: [{id: 9}, {id: 4}], notes: [{tick: 0, layer: 1}, {tick: 1, layer: 4}, {tick: 2, layer: 3}]});
  assert.deepEqual(song.layers.map(layer => layer.id), [0, 1, 2, 3]);
  assert.deepEqual(song.notes.map(note => note.layer), [1, 1, 3]);
});

test('normalization clamps malformed numbers, grows layers, and keeps the last duplicate cell', () => {
  const song = normalizeSong({tempo: Infinity, timeSignature: -2, length: 1, loopStart: 99999999,
    layers: [{id: 0, volume: 300, pan: -300}],
    notes: [null, {id: 'same', tick: 0, layer: 0, key: -2}, {id: 'same', tick: 0, layer: 0, key: 90, velocity: -5, pan: 999, pitch: -999999}, {id: 'same', tick: 100000000, layer: 1, key: NaN}]});
  assert.equal(song.tempo, 10);
  assert.equal(song.timeSignature, 1);
  assert.equal(song.length, 1000000);
  assert.equal(song.loopStart, 999999);
  assert.equal(song.layers.length, 2);
  assert.equal(song.layers[0].volume, 100);
  assert.equal(song.layers[0].pan, -100);
  assert.equal(song.notes.length, 2);
  assert.equal(song.notes[0].key, 87);
  assert.equal(song.notes[0].velocity, 0);
  assert.equal(song.notes[0].pan, 100);
  assert.equal(song.notes[0].pitch, -32768);
  assert.equal(song.notes[1].key, 45);
  assert.equal(song.notes[1].tick, 999999);
  assert.equal(new Set(song.notes.map(note => note.id)).size, 2);
});

test('invalid array shapes and excessive counts fail before copying or iterating', () => {
  assert.throws(() => normalizeSong([]), /对象/);
  assert.throws(() => normalizeSong({notes: {}}), /数组/);
  assert.throws(() => normalizeSong({notes: new Array(MAX_NOTES+1)}), /1000000/);
  assert.throws(() => normalizeSong({layers: new Array(MAX_LAYERS+1)}), /65535/);
  assert.throws(() => normalizeSong({customInstruments: new Array(256)}), /255/);
});

test('undo/redo deep clone snapshots, obey the limit and clear abandoned redo branches', () => {
  const history = new History(2);
  const song = createBlankSong();
  assert.equal(history.undo(song), null);
  history.push(song);
  song.title = 'First';
  history.push(song);
  song.title = 'Second';
  history.push(song);
  song.title = 'Third';
  assert.equal(history.canUndo, true);
  let previous = history.undo(song);
  assert.equal(previous.title, 'Second');
  previous.layers[0].name = 'Mutated';
  const before = history.undo(previous);
  assert.equal(before.title, 'First');
  assert.notEqual(before.layers[0].name, 'Mutated');
  assert.equal(history.undo(before), null);
  assert.equal(history.canRedo, true);
  const next = history.redo(before);
  assert.equal(next.title, 'Second');
  assert.equal(next.layers[0].name, 'Mutated');
  history.push(next);
  assert.equal(history.canRedo, false);
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test('history exposes exact depths and adaptively keeps the nearest undo/redo snapshots', () => {
  const history = new History(10);
  for (let title = 0; title < 6; title++) history.push({title});
  assert.equal(history.undoDepth, 6);
  assert.equal(history.redoDepth, 0);
  let current = history.undo({title: 6});
  current = history.undo(current);
  current = history.undo(current);
  assert.deepEqual(current, {title: 3});
  assert.equal(history.undoDepth, 3);
  assert.equal(history.redoDepth, 3);
  assert.equal(history.setLimit(2), history);
  assert.equal(history.undoDepth, 2);
  assert.equal(history.redoDepth, 2);
  current = history.redo(current);
  assert.deepEqual(current, {title: 4});
  assert.equal(history.undoDepth, 2);
  assert.equal(history.redoDepth, 1);
  current = history.redo(current);
  assert.deepEqual(current, {title: 5});
  assert.equal(history.redoDepth, 0);
  current = history.undo(current);
  assert.deepEqual(current, {title: 4});
  current = history.undo(current);
  assert.deepEqual(current, {title: 3});
  assert.equal(history.undoDepth, 0);
  assert.equal(history.redoDepth, 2);
  history.clear();
  assert.equal(history.undoDepth, 0);
  assert.equal(history.redoDepth, 0);
});

test('lowered history limits bound subsequent transfers and preserve valid range', () => {
  const history = new History(10);
  for (let title = 0; title < 6; title++) history.push({title});
  let current = history.undo({title: 6});
  current = history.undo(current);
  current = history.undo(current);
  history.setLimit(2);
  current = history.undo(current);
  assert.deepEqual(current, {title: 2});
  assert.equal(history.redoDepth, 2);
  history.setLimit(0);
  assert.equal(history.limit, 1);
  assert.equal(history.undoDepth, 1);
  assert.equal(history.redoDepth, 1);
  history.setLimit(Infinity);
  assert.equal(history.limit, 1);
});
