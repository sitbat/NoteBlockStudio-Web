import {MAX_NOTES, MAX_LAYERS} from '../js/model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {bounds, moveNotes, pasteNotes} from '../js/edit.js';
import {createBlankSong} from '../js/model.js';

const note = (id, tick, layer, key = 45) => ({id, tick, layer, key, instrument: 0, velocity: 100, pan: 0, pitch: 0});
const makeSong = notes => ({...createBlankSong(), notes});

test('bounds processes 250000 notes without spreading function arguments', () => {
  const notes = Array.from({length: 250000}, (_, id) => note(String(id), id + 10, id % 4096));
  assert.deepEqual(bounds(notes), {minTick: 10, maxTick: 250009, minLayer: 0, maxLayer: 4095});
  assert.deepEqual(bounds([]), {minTick: 0, maxTick: 0, minLayer: 0, maxLayer: 0});
});

test('moving against the right edge keeps selected note spacing intact', () => {
  const song = makeSong([note('a', 999990, 0), note('b', 999995, 1)]);
  assert.equal(moveNotes(song, ['a', 'b'], {dt: 999}), true);
  assert.deepEqual(song.notes.map(n => n.tick), [999994, 999999]);
  assert.equal(song.length, 1000000);
});

test('negative offsets and layer boundaries clamp the common group offset', () => {
  const song = makeSong([note('a', 3, 1), note('b', 8, 2)]);
  assert.equal(moveNotes(song, new Set(['a', 'b']), {dt: -100, dl: -100}), true);
  assert.deepEqual(song.notes.map(n => [n.tick, n.layer]), [[0, 0], [5, 1]]);
  assert.equal(moveNotes(song, ['a', 'b'], {dl: 100}), true);
  assert.deepEqual(song.notes.map(n => n.layer), [2, 3]);
  assert.equal(moveNotes(song, ['a', 'b'], {dl: 100}), false);
});

test('group transposition retains musical intervals at the keyboard boundary', () => {
  const song = makeSong([note('a', 0, 0, 82), note('b', 1, 0, 85)]);
  assert.equal(moveNotes(song, ['a', 'b'], {dk: 12}), true);
  assert.deepEqual(song.notes.map(n => n.key), [84, 87]);
});

test('locked source notes stay put and any locked destination rejects a move atomically', () => {
  const song = makeSong([note('a', 0, 0), note('b', 1, 1)]);
  song.layers[1].locked = true;
  assert.equal(moveNotes(song, ['a', 'b'], {dt: 5}), true);
  assert.equal(song.notes.find(n => n.id === 'a').tick, 5);
  assert.equal(song.notes.find(n => n.id === 'b').tick, 1);
  const before = structuredClone(song);
  assert.equal(moveNotes(song, ['a'], {dt: 1, dl: 1}), false);
  assert.deepEqual(song, before);
});

test('moving selected notes replaces unselected destination notes without duplicate cells', () => {
  const song = makeSong([note('a', 0, 0), note('b', 1, 0), note('collision', 3, 0), note('keep', 9, 0)]);
  assert.equal(moveNotes(song, ['a', 'b'], {dt: 2}), true);
  assert.deepEqual(new Set(song.notes.map(n => n.id)), new Set(['a', 'b', 'keep']));
  assert.equal(new Set(song.notes.map(n => `${n.tick}:${n.layer}`)).size, song.notes.length);
  assert.equal(song.notes.find(n => n.id === 'a').tick, 2);
  assert.equal(song.notes.find(n => n.id === 'b').tick, 3);
});

test('invalid paste coordinates leave notes, layers and length unchanged', () => {
  const song = makeSong([note('existing', 0, 0)]);
  const before = structuredClone(song);
  assert.throws(() => pasteNotes(song, [note('x', 0, 0), note('y', 1, 1)], {tick: 999999, layer: 5}), /时间轴/);
  assert.deepEqual(song, before);
  assert.throws(() => pasteNotes(song, [note('x', 0, MAX_LAYERS)], {tick: 0, layer: 0}), /65535/);
  assert.deepEqual(song, before);
  assert.throws(() => pasteNotes(song, [note('x', 0, 0)], {tick: Infinity, layer: 0}), /无效/);
  assert.deepEqual(song, before);
});

test('valid paste replaces collisions, skips locked destinations, creates default layers and new IDs', () => {
  const song = makeSong([note('existing', 10, 2), note('locked', 11, 3)]);
  song.layers[3].locked = true;
  const relative = [note('a', 0, 0, 40), note('b', 1, 1), note('c', 2, 3), note('last', 0, 0, 50)];
  const original = structuredClone(relative);
  const ids = pasteNotes(song, relative, {tick: 10, layer: 2});
  assert.equal(ids.length, 2);
  assert.equal(ids.some(id => ['a', 'b', 'c', 'last'].includes(id)), false);
  assert.equal(song.notes.length, 3);
  assert.equal(song.notes.find(n => n.tick === 10 && n.layer === 2).key, 50);
  assert.equal(song.notes.find(n => n.id === 'locked').tick, 11);
  assert.equal(song.layers.length, 6);
  assert.deepEqual(song.layers[5], {id: 5, name: '音轨 6', volume: 100, pan: 0, reverb: 0, muted: false, solo: false, locked: false});
  assert.deepEqual(relative, original);
});

test('paste counts replacements correctly at the note limit and fails without mutation when exceeded', () => {
  const song = makeSong(Array.from({length: MAX_NOTES}, (_, id) => note(String(id), id, 0)));
  const originalNotes = song.notes;
  const originalLayers = song.layers;
  assert.throws(() => pasteNotes(song, [note('x', 0, 0)], {tick: 999999, layer: 8}), /1000000/);
  assert.equal(song.notes, originalNotes);
  assert.equal(song.layers, originalLayers);
  assert.equal(song.layers.length, 4);
  assert.equal(song.length, 64);
  const ids = pasteNotes(song, [note('x', 0, 0)], {tick: 2, layer: 0});
  assert.equal(ids.length, 1);
  assert.equal(song.notes.length, MAX_NOTES);
  assert.equal(song.notes.some(n => n.id === '2'), false);
});
