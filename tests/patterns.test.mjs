import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {parseNBP, writeNBP, parseSelectionCode, writeSelectionCode, decodeSelectionCode, patternFromSelection, insertPattern} from '../js/patterns.js';
import {createBlankSong} from '../js/model.js';

const fixture = new URL('./fixtures/Drum Example.nbp', import.meta.url);
test('reads actual original bundled NBP v1 fixture, signed pitch and panning', async () => {
  const bytes = await readFile(fixture), pattern = parseNBP(bytes);
  assert.equal(pattern.width, 15); assert.equal(pattern.height, 3); assert.equal(pattern.notes.length, 12);
  assert.deepEqual(pattern.notes[0], {tick: 0, layer: 1, instrument: 2, key: 39, velocity: 100, pan: 40, pitch: 5});
  assert.equal(pattern.notes[1].pitch, -5); assert.equal(pattern.notes[1].pan, -40);
  assert.equal(pattern.metadata.songLastTick, 14);
  assert.deepEqual(writeNBP(pattern), new Uint8Array(bytes), 'native file round-trips byte for byte');
});
test('selection-code sentinel is recognized only as a layer delta, not a pitch', () => {
  const pattern = parseSelectionCode('0|0|0|45|50|0|-1|2|1|46|80|200|20|-1|3|0|2|40|100|100|-1|-1|');
  assert.equal(pattern.notes.length, 3); assert.equal(pattern.notes[0].pitch, -1); assert.equal(pattern.notes[2].tick, 3);
  assert.equal(writeSelectionCode(pattern.notes), '0|0|0|45|50|0|-1|2|1|46|80|200|20|-1|3|0|2|40|100|100|-1|-1|');
});
test('native compressed clipboard selection decodes zlib/base64 with and without final NUL', async () => {
  const text = '0|0|0|45|100|100|-1|-1|';
  for (const suffix of ['', '\0']) {
    const encoded = deflateSync(Buffer.from(text + suffix)).toString('base64');
    assert.deepEqual(await decodeSelectionCode(encoded), parseSelectionCode(text));
  }
  await assert.rejects(decodeSelectionCode('AAAA'), /无法读取/);
});
test('NBP rejects truncated, unknown, inconsistent and malformed data', async () => {
  const fixtureBytes = new Uint8Array(await readFile(fixture));
  assert.throws(() => parseNBP(fixtureBytes.subarray(0, -1)), /截断/);
  const future = fixtureBytes.slice(); future[0] = 2; assert.throws(() => parseNBP(future), /版本/);
  const narrow = fixtureBytes.slice(); narrow[5] = 1; narrow[6] = 0; assert.throws(() => parseNBP(narrow), /宽度之外/);
  assert.throws(() => parseSelectionCode('0|0|0|45|100|100|0|'), /缺少/);
  assert.throws(() => parseSelectionCode('0|0|0|45|101|100|0|-1|'), /力度/);
  assert.throws(() => parseSelectionCode('0|0|0|45|100|100|0|0|1|40|100|100|0|-1|'), /重复图层/);
  assert.throws(() => parseSelectionCode('0|0|16|45|100|100|0|-1|', {customInstrumentCount: 0}), /乐器编号/);
});
test('extract and insert are relative, preserve properties, grow layers and protect locked destinations', () => {
  const source = createBlankSong(); source.notes = [{id: 'a', tick: 8, layer: 2, instrument: 0, key: 44, velocity: 37, pan: -60, pitch: -1}, {id: 'b', tick: 10, layer: 3, instrument: 0, key: 48, velocity: 99, pan: 60, pitch: 7}];
  const pattern = patternFromSelection(source, ['a', 'b']);
  assert.equal(pattern.width, 3); assert.equal(pattern.notes[0].tick, 0); assert.equal(pattern.notes[0].layer, 0);
  const destination = createBlankSong(); destination.layers[0].locked = true;
  const ids = insertPattern(destination, pattern, {tick: 20, layer: 4});
  assert.equal(ids.length, 2); assert.equal(destination.layers.length, 6); assert.equal(destination.notes[1].tick, 22); assert.equal(destination.notes[0].pitch, -1);
  assert.notEqual(ids[0], 'a');
  const snapshot = JSON.stringify(destination);
  assert.throws(() => insertPattern(destination, {...pattern, notes: [{...pattern.notes[0], instrument: 16}]}, {tick: 0}), /乐器编号/);
  assert.equal(JSON.stringify(destination), snapshot);
  assert.equal(insertPattern(destination, pattern, {layer: 0}).length, 1, 'locked destination note is skipped');
});
test('large layer indices survive NBP code even when native byte-only column hints overflow', () => {
  const pattern = {width: 1, notes: [{tick: 0, layer: 10000, instrument: 0, key: 44, velocity: 100, pan: 0, pitch: 0}]};
  assert.equal(parseNBP(writeNBP(pattern)).notes[0].layer, 10000);
});
