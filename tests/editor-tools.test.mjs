import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlankSong} from '../js/model.js';
import {EDITOR_TOOLS, MACROS, applyEditorTool, selectNotes, insertChord} from '../js/editor-tools.js';

function songAt(columns = [[0], [0], [0], [0], [0]]) {
  const song = createBlankSong();
  song.notes = columns.flatMap((layers, tick) => layers.map(layer => ({id: `${tick}-${layer}`, tick: tick * 3 + 10, layer, key: 40 + layer, instrument: 0, velocity: 80, pan: 0, pitch: 10})));
  return song;
}
const all = song => song.notes.map(note => note.id);
const run = (song, action, options) => applyEditorTool(song, all(song), action, options);

test('all 15 native macros are concrete descriptors; vibrato/LFO/stereo follow occupied columns', () => {
  assert.equal(MACROS.length, 15); assert.equal(new Set(EDITOR_TOOLS.map(tool => tool.id)).size, EDITOR_TOOLS.length);
  const song = songAt(); run(song, 'vibrato'); assert.deepEqual(song.notes.map(note => note.pitch), [40, 0, -40, 0, 40]);
  run(song, 'volume-lfo'); assert.deepEqual(song.notes.map(note => note.velocity), [100, 50, 25, 50, 100]);
  run(song, 'stereo', {width: 70, reverse: true}); assert.deepEqual(song.notes.map(note => note.pan), [-70, 70, -70, 70, -70]);
});
test('arpeggio and portamento match native column cycles and reverse ramp', () => {
  const song = songAt(); run(song, 'arpeggio', {pattern: '0|4|7'}); assert.deepEqual(song.notes.map(note => note.key), [40, 44, 47, 40, 44]);
  run(song, 'portamento', {amount: 100}); assert.deepEqual(song.notes.map(note => note.pitch), [30, 50, 70, 90, 110]);
  run(song, 'portamento', {amount: 100, reverse: true}); assert.deepEqual(song.notes.map(note => note.pitch), [120, 100, 80, 60, 40]);
  song.notes[0].key = 87; run(song, 'arpeggio', {pattern: [12]}); assert.equal(song.notes[0].key, 87, 'invalid transposition keeps valid original key');
});
test('chorus validates every column before committing and alternates row pan/pitch', () => {
  const song = songAt([[0, 1], [0]]), snapshot = JSON.stringify(song);
  assert.throws(() => run(song, 'chorus'), /至少包含两个/); assert.equal(JSON.stringify(song), snapshot);
  song.notes.pop(); run(song, 'chorus'); assert.deepEqual(song.notes.map(note => note.pan), [40, -40]); assert.deepEqual(song.notes.map(note => note.pitch), [15, 5]);
});
test('fades multiply original velocities, protect single-column selections and reset properties', () => {
  const song = songAt([[0], [0], [0]]); run(song, 'fade-in'); assert.deepEqual(song.notes.map(note => note.velocity), [1, 40, 80]);
  run(song, 'reset-properties'); run(song, 'fade-out'); assert.deepEqual(song.notes.map(note => note.velocity), [100, 50, 1]);
  const single = songAt([[0]]); assert.equal(run(single, 'fade-in').changed, false);
  run(song, 'set-velocity', {value: 150, percent: true}); assert.deepEqual(song.notes.map(note => note.velocity), [100, 75, 1.5]);
  run(song, 'set-panning', {value: -90}); run(song, 'set-pitch', {value: 1200, add: true});
  assert.ok(song.notes.every(note => note.pan === -90 && note.pitch === 1200));
});
test('native stagger applies each row delta, compression preserves collisions and expansion is anchored', () => {
  const song = songAt([[0, 1, 3]]); run(song, 'stagger', {pattern: [2]}); assert.deepEqual(song.notes.map(note => note.layer), [2, 5, 9]); assert.equal(song.layers.length, 10);
  const compressed = songAt([[0], [0], [0]]); compressed.notes.forEach((note, i) => {note.tick = 10 + i;});
  run(compressed, 'compress'); assert.equal(compressed.notes.length, 3); assert.deepEqual(compressed.notes.map(note => [note.tick, note.layer]), [[10, 0], [10, 1], [11, 0]]);
  run(compressed, 'expand'); assert.deepEqual(compressed.notes.map(note => note.tick), [10, 10, 12]);
});
test('tremolo emits actual repeated notes, rounds native spacing and supports fade envelopes', () => {
  const song = songAt([[0], [0]]); const result = run(song, 'tremolo', {spacing: 2});
  assert.deepEqual(song.notes.map(note => note.tick), [10, 12, 14]); assert.equal(result.addedIds.length, 1); assert.equal(new Set(all(song)).size, 3);
  const faded = songAt([[0], [0]]); run(faded, 'tremolo', {spacing: 1, fade: 'in'});
  assert.deepEqual(faded.notes.map(note => note.velocity), [80, 80, 80, 80]);
  const manual = songAt([[0], [0]]); run(manual, 'tremolo', {spacing: 1, fade: 'out', automatic: false, amount: 30, sustain: 25});
  assert.deepEqual(manual.notes.map(note => note.velocity), [70, 40, 25, 80]);
});
test('locked sources remain intact; locked destination or tick overflow fails atomically', () => {
  const song = songAt([[0, 1]]); song.layers[0].locked = true;
  run(song, 'set-panning', {value: 80}); assert.equal(song.notes[0].pan, 0); assert.equal(song.notes[1].pan, 80);
  song.layers[2].locked = true; const snapshot = JSON.stringify(song);
  assert.throws(() => run(song, 'stagger', {pattern: [1]}), /锁定/); assert.equal(JSON.stringify(song), snapshot);
  const overflow = songAt([[0], [0]]); overflow.notes[0].tick = 999998; overflow.notes[1].tick = 999999;
  const before = JSON.stringify(overflow); assert.throws(() => run(overflow, 'expand'), /时间轴/); assert.equal(JSON.stringify(overflow), before);
});
test('range folding, selection modes, instrument replacement and chord insertion are functional', () => {
  const song = songAt([[0], [1], [0]]); song.notes[0].key = 0; song.notes[1].key = 87; song.notes[1].instrument = 1;
  run(song, 'fold-octave'); assert.deepEqual(song.notes.map(note => note.key), [36, 51, 40]);
  assert.deepEqual(selectNotes(song, [song.notes[0].id], {mode: 'invert'}), [song.notes[1].id, song.notes[2].id]);
  assert.equal(selectNotes(song, [], {mode: 'instrument', instrument: 1}).length, 1);
  run(song, 'change-instrument', {instrument: 3}); assert.ok(song.notes.every(note => note.instrument === 3));
  run(song, 'replace-key'); assert.ok(song.notes.every(note => note.key === 36));
  const ids = insertChord(song, {tick: 30, layer: 4, key: 45, chord: 'minor7'}); assert.equal(ids.length, 4); assert.deepEqual(song.notes.filter(note => ids.includes(note.id)).map(note => note.key), [45, 48, 52, 55]);
  const before = JSON.stringify(song); assert.throws(() => insertChord(song, {key: 87, chord: 'major'}), /音高/); assert.equal(JSON.stringify(song), before);
});
