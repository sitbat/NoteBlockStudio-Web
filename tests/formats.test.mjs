import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNBS, writeNBS, parseMIDI, writeMIDI, MIDI_PERCUSSION_DEFAULTS, MIDI_PROGRAM_DEFAULTS, MIDI_PROGRAM_NAMES } from '../js/formats.js';

function sample() {
  return {
    title: '本地歌曲 🎵', author: 'Composer', originalAuthor: 'Original', description: 'A\nB',
    tempo: 12.5, timeSignature: 3, length: 64, loop: true, loopStart: 8, loopCount: 3,
    layers: [
      { id: 0, name: '钢琴', volume: 85, pan: -40, reverb: 0, locked: true, muted: false, solo: false },
      { id: 1, name: 'Bell', volume: 100, pan: 35, reverb: 0, locked: false, muted: false, solo: true },
    ],
    notes: [
      { id: 'a', tick: 0, layer: 0, key: 0, instrument: 0, velocity: 17, pan: -100, pitch: -250 },
      { id: 'b', tick: 0, layer: 1, key: 87, instrument: 7, velocity: 100, pan: 100, pitch: 32000 },
      { id: 'c', tick: 63, layer: 0, key: 45, instrument: 16, velocity: 79, pan: 0, pitch: -32768 },
    ],
    customInstruments: [{ name: '自定义', file: 'piano.ogg', key: 45, pressKey: true }],
    metadata: { minutesSpent: 22, leftClicks: 123, rightClicks: 4, blocksAdded: 9, blocksRemoved: 2, midiFile: 'original.mid' },
  };
}

test('NBS v5 preserves Unicode, signed pitch, loop, layer settings and custom instruments', () => {
  const s = sample(), actual = parseNBS(writeNBS(s));
  for (const key of ['title', 'author', 'originalAuthor', 'description', 'tempo', 'timeSignature', 'length', 'loop', 'loopStart', 'loopCount']) assert.equal(actual[key], s[key], key);
  assert.deepEqual(actual.notes.map(({ id, ...n }) => n), s.notes.map(({ id, ...n }) => n));
  assert.deepEqual(actual.layers, s.layers);
  assert.deepEqual(actual.customInstruments, s.customInstruments);
  assert.equal(actual.metadata.minutesSpent, 22);
  assert.equal(actual.metadata.midiFile, 'original.mid');
});

test('all historical NBS versions load and normalize their missing fields', () => {
  for (let version = 0; version <= 5; version++) {
    const s = sample();
    const actual = parseNBS(writeNBS(s, { version, webExtensions: false }));
    assert.equal(actual.metadata.nbsVersion, version);
    assert.equal(actual.notes.length, 3);
    assert.equal(actual.notes[2].instrument, 16, `custom index v${version}`);
    assert.equal(actual.notes[0].pitch, version >= 4 ? -250 : 0);
    assert.equal(actual.layers[0].pan, version >= 2 ? -40 : 0);
    assert.equal(actual.loop, version >= 4);
    assert.equal(actual.layers[0].locked, version >= 4);
    assert.equal(actual.layers[0].muted, version >= 4, 'native lock also silences playback without a Web footer');
    assert.equal(actual.length, 64);
  }
});

test('raw NBS custom sample keys clamp to the piano range in every supported version', () => {
  for (let version = 0; version <= 5; version++) for (const [stored, expected] of [[0, 0], [87, 87], [88, 87], [255, 87]]) {
    // A single custom definition ends with key and pressKey when no Web footer is written.
    const encoded = writeNBS(sample(), {version, webExtensions: false});
    assert.equal(encoded.at(-1), 1);
    encoded[encoded.length - 2] = stored;
    const actual = parseNBS(encoded), definition = actual.customInstruments[0];
    assert.deepEqual(definition, {...sample().customInstruments[0], key: expected}, `v${version}, stored key ${stored}`);
    assert.deepEqual(parseNBS(writeNBS(actual, {version, webExtensions: false})).customInstruments, actual.customInstruments);
  }
});

test('native patch/channel naming is optional, source-exact and independent from the default MIDI track labels',()=>{
  const name=[...new TextEncoder().encode('Original MIDI track')],data=midi([track([[0,0xff,3,name.length,...name],[0,0xc2,0],[0,0x92,60,100],[0,0xc4,73],[0,0x94,64,100],[0,0x99,36,100],[480,0xff,0x2f,0]])]);
  const original=parseMIDI(data),patch=parseMIDI(data,{namingMode:'patch'}),channel=parseMIDI(data,{namingMode:'channel'});
  assert.deepEqual(original.layers.map(layer=>layer.name),['Original MIDI track','Original MIDI track','Original MIDI track · 打击乐']);
  assert.deepEqual(patch.layers.map(layer=>layer.name),['Piano 1','Flute','Percussion']);
  assert.deepEqual(channel.layers.map(layer=>layer.name),['Channel 3','Channel 5','Channel 10']);
  assert.deepEqual(parseMIDI(data,{namingMode:'patch',trackNames:false}).layers.map(layer=>layer.name),['轨道 1','轨道 1','轨道 1']);
  assert.equal(patch.metadata.midiImportOptions.namingMode,'patch');assert.equal(MIDI_PROGRAM_NAMES.length,128);assert.equal(MIDI_PROGRAM_NAMES[127],'Gunshot');
  assert.throws(()=>parseMIDI(data,{namingMode:'unknown'}),/namingMode/);
});

test('NBS imports legacy byte strings without corrupting accented characters', () => {
  const bytes = writeNBS({ ...sample(), title: 'x' });
  // Modern header has 8 bytes, then a 4-byte title length and its text.
  bytes[12] = 0xe9;
  assert.equal(parseNBS(bytes).title, 'é');
});

test('NBS respects byte-array offsets and preserves unknown trailing bytes', () => {
  const s = sample(); s.metadata.trailingBytes = [0xaa, 0xbb, 0xcc];
  const bytes = writeNBS(s), framed = new Uint8Array(bytes.length + 20); framed.set(bytes, 11);
  const parsed = parseNBS(framed.subarray(11, 11 + bytes.length));
  assert.equal(parsed.title, s.title);
  assert.deepEqual(parsed.metadata.trailingBytes, [0xaa, 0xbb, 0xcc]);
});

test('NBS rejects truncated headers, unsupported versions, huge strings and overlapping cells', () => {
  for (let i = 0; i < 40; i++) assert.throws(() => parseNBS(writeNBS(sample()).subarray(0, i)));
  const unknown = writeNBS(sample()); unknown[2] = 99;
  assert.throws(() => parseNBS(unknown), /版本/);
  const huge = writeNBS(sample()); huge.set([255, 255, 255, 127], 8);
  assert.throws(() => parseNBS(huge), /文本/);
  const overlap = sample(); overlap.notes.push({ ...overlap.notes[0], id: 'duplicate' });
  assert.throws(() => writeNBS(overlap), /重叠/);
  const tooLong = sample(); tooLong.length = 65536;
  assert.throws(() => writeNBS(tooLong), /65535/);
});

test('NBS rejects unsupported note keys and velocity instead of silently changing the score', () => {
  const s = {title: '', author: '', originalAuthor: '', description: '', tempo: 10, timeSignature: 4, length: 1,
    layers: [{}], notes: [{tick: 0, layer: 0, key: 45, instrument: 0, velocity: 100, pan: 0, pitch: 0}], customInstruments: []};
  const key = writeNBS(s);
  // Empty strings yield a 57-byte header; tick/layer deltas and instrument follow.
  const noteStart = 8 + 16 + 2 + 3 + 20 + 4 + 4 + 4;
  key[noteStart + 1] = 200;
  assert.throws(() => parseNBS(key), /音高/);
  const velocity = writeNBS(s); velocity[noteStart + 2] = 127;
  assert.throws(() => parseNBS(velocity), /音量/);
});

function vlq(n) { const bytes = [n & 127]; while ((n = Math.floor(n / 128))) bytes.unshift(n & 127 | 128); return bytes; }
function be32(n) { return [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255]; }
function track(events) { const bytes = events.flatMap(([delta, ...data]) => [...vlq(delta), ...data]); return [77, 84, 114, 107, ...be32(bytes.length), ...bytes]; }
function midi(tracks, division = 480, format = 1) { return Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, format, tracks.length >>> 8, tracks.length & 255, division >>> 8, division & 255, ...tracks.flat()]); }

test('MIDI imports running status, polyphony, program changes and variable tempos across tracks', () => {
  const bytes = midi([
    track([[0, 0xff, 0x51, 3, 7, 161, 32], [480, 0xff, 0x51, 3, 15, 66, 64], [480, 0xff, 0x2f, 0]]),
    track([[0, 0xc0, 73], [0, 0x90, 60, 127], [0, 64, 100], [480, 60, 0], [0, 64, 0], [0, 67, 127], [480, 67, 0], [0, 0xff, 0x2f, 0]]),
  ]);
  const song = parseMIDI(bytes);
  assert.equal(song.tempo, 8);
  assert.equal(song.length, 12);
  assert.deepEqual(song.notes.map(n => n.tick), [0, 0, 4]);
  assert.deepEqual(song.notes.map(n => n.duration), [4, 4, 8]);
  assert.equal(new Set(song.notes.slice(0, 2).map(n => n.layer)).size, 2);
  assert.ok(song.notes.every(n => n.instrument === 6));
  assert.equal(song.metadata.tempoChanges, 2);
});

test('MIDI ignores percussion note-off, maps drums, skips keys outside the NBS piano', () => {
  const s = parseMIDI(midi([track([
    [0, 0x99, 36, 127], [0, 38, 90], [120, 36, 0], [0, 38, 0],
    [0, 0x90, 2, 100], [120, 2, 0], [0, 0xff, 0x2f, 0],
  ])], 480, 0));
  assert.deepEqual(s.notes.map(n => n.instrument), [2, 3]);
  assert.deepEqual(s.notes.map(n => n.key), [39, 41], 'original MIDI drum table pitch is used, not raw MIDI key minus21');
  assert.equal(s.metadata.skippedOutOfRangeNotes, 1);
});

test('MIDI applies conductor-track program and channel controllers to other tracks', () => {
  const s = parseMIDI(midi([
    track([[0, 0xc2, 32], [0, 0xb2, 7, 64], [0, 10, 0], [480, 0xff, 0x2f, 0]]),
    track([[0, 0x92, 60, 127], [480, 60, 0], [0, 0xff, 0x2f, 0]]),
  ]));
  assert.equal(s.notes[0].instrument, 1);
  assert.equal(s.notes[0].velocity, 50);
  assert.equal(s.notes[0].pan, -100);
});

test('GM xylophone, vibraphone, square wave, banjo and bright piano match native instrument IDs', () => {
  const programs = [13, 11, 80, 105, 1];
  const events = programs.flatMap(program => [[0, 0xc0, program], [0, 0x90, 60, 100], [120, 0x80, 60, 0]]);
  events.push([0, 0xff, 0x2f, 0]);
  assert.deepEqual(parseMIDI(midi([track(events)])).notes.map(note => note.instrument), [9, 10, 13, 14, 15]);
});

test('MIDI export and import preserve melodic onset, duration, instruments, tempo and text', () => {
  const s = sample();
  s.layers.forEach(l => { l.solo = false; l.volume = 100; });
  s.notes = s.notes.slice(0, 2).map((n, i) => ({ ...n, key: 40 + i, instrument: i ? 7 : 0, tick: i * 8, duration: 3 }));
  const actual = parseMIDI(writeMIDI(s));
  assert.equal(actual.title, s.title);
  assert.equal(actual.author, s.author);
  assert.equal(actual.description, s.description);
  assert.equal(actual.tempo, s.tempo);
  assert.equal(actual.length, s.length);
  assert.deepEqual(actual.notes.map(({ tick, key, instrument, duration }) => ({ tick, key, instrument, duration })), s.notes.map(({ tick, key, instrument, duration }) => ({ tick, key, instrument, duration })));
});

test('MIDI exporter honors mute/solo and emits standard SMF chunks', () => {
  const s = sample(); s.notes = s.notes.slice(0, 2);
  let parsed = parseMIDI(writeMIDI(s));
  assert.equal(parsed.notes.length, 1); assert.equal(parsed.notes[0].key, 87);
  s.layers[1].muted = true;
  parsed = parseMIDI(writeMIDI(s));
  assert.equal(parsed.notes.length, 0);
  assert.equal(parsed.title, s.title);
});

test('MIDI SMPTE files use frame timing and skip unknown metadata and SysEx', () => {
  const parsed = parseMIDI(midi([track([
    [0, 0xff, 0x7f, 3, 0, 1, 2], [0, 0xf0, 2, 0x7d, 0xf7],
    [0, 0x90, 60, 100], [1000, 0x80, 60, 0], [0, 0xff, 0x2f, 0],
  ])], 0xe728, 0)); // -25 fps, 40 ticks/frame = 1000 ticks/sec
  assert.equal(parsed.notes[0].duration, 8);
  assert.equal(parsed.length, 8);
});

test('MIDI rejects truncated tracks, invalid running status and overlong VLQ values', () => {
  const valid = midi([track([[0, 0x90, 60, 100], [120, 0x80, 60, 0], [0, 0xff, 0x2f, 0]])]);
  assert.throws(() => parseMIDI(valid.subarray(0, valid.length - 1)), /不完整/);
  assert.throws(() => parseMIDI(midi([track([[0, 60, 100]])])), /运行状态/);
  const overlong = midi([track([[0, 0xff, 0x2f, 0]])]);
  overlong.set([0xff, 0xff, 0xff, 0xff], 22);
  assert.throws(() => parseMIDI(overlong), /4 字节/);
  const format2 = valid.slice(); format2[9] = 2;
  assert.throws(() => parseMIDI(format2), /格式 2/);
});

test('MIDI target tempo and subdivisions retain variable-tempo onset/duration in seconds', () => {
  const bytes = midi([
    track([[0, 0xff, 0x51, 3, 7, 161, 32], [480, 0xff, 0x51, 3, 15, 66, 64], [480, 0xff, 0x2f, 0]]),
    track([[480, 0x90, 60, 100], [480, 0x80, 60, 0], [0, 0xff, 0x2f, 0]]),
  ]);
  const original = parseMIDI(bytes), changed = parseMIDI(bytes, {targetTempo: 10, gridSubdivision: 4});
  assert.equal(changed.tempo, 40); assert.equal(changed.notes[0].tick, 20); assert.equal(changed.notes[0].duration, 40); assert.equal(changed.length, 60);
  assert.equal(changed.notes[0].tick / changed.tempo, original.notes[0].tick / original.tempo);
  assert.equal(changed.notes[0].duration / changed.tempo, original.notes[0].duration / original.tempo);
  assert.equal(changed.metadata.midiBaseTempo, 10); assert.equal(changed.metadata.midiEffectiveTempo, 40);
  assert.equal(changed.metadata.midiImportOptions.gridSubdivision, 4);
});
test('finer MIDI grid preserves close onsets and can reduce quantization collision layers', () => {
  const bytes = midi([track([[0, 0x90, 60, 100], [30, 64, 100], [120, 0x80, 60, 0], [0, 64, 0], [0, 0xff, 0x2f, 0]])]);
  const coarse = parseMIDI(bytes), fine = parseMIDI(bytes, {gridSubdivision: 4, maxLayers: 1});
  assert.deepEqual(coarse.notes.map(note => note.tick), [0, 0]); assert.equal(coarse.layers.length, 2);
  assert.equal(fine.tempo, 32); assert.deepEqual(fine.notes.map(note => note.tick), [0, 1]); assert.equal(fine.layers.length, 1);
});
test('leading-silence removal starts at first retained note after mapping exclusions', () => {
  const bytes = midi([track([[480, 0xc0, 0], [0, 0x90, 60, 100], [480, 0xc0, 73], [0, 0x90, 64, 100], [480, 0x80, 64, 0], [0, 0xff, 0x2f, 0]])]);
  const options = {programMap: {0: -1}, removeSilent: true};
  const imported = parseMIDI(bytes, options), untrimmed = parseMIDI(bytes, {programMap: {0: -1}});
  assert.equal(imported.notes.length, 1); assert.equal(imported.notes[0].tick, 0); assert.equal(imported.notes[0].duration, 4); assert.equal(imported.length, 4);
  assert.equal(untrimmed.notes[0].tick, 8); assert.equal(untrimmed.length, 12);
  assert.equal(imported.metadata.leadingSilenceSecondsRemoved, 1); assert.equal(imported.metadata.skippedMappedNotes, 1); assert.equal(imported.metadata.skippedNotes, 1);
  assert.deepEqual(options, {programMap: {0: -1}, removeSilent: true});
});
test('per-program mappings follow actual channel program changes and clone current custom definitions', () => {
  const bytes = midi([
    track([[0, 0xc2, 0], [480, 0xc2, 73], [480, 0xff, 0x2f, 0]]),
    track([[0, 0x92, 60, 100], [480, 0x82, 60, 0], [0, 0x92, 60, 100], [480, 0x82, 60, 0], [0, 0xff, 0x2f, 0]]),
  ]);
  const customInstruments = [{name: 'Local sample', file: 'sample.ogg', key: 45, pressKey: false, metadata: {source: 'local'}}];
  const options = {octaveOffset: 1, programMap: {0: {instrument: 7, octave: 1}, 73: {instrument: 16, octave: -1}}, customInstruments};
  const imported = parseMIDI(bytes, options);
  assert.deepEqual(imported.notes.map(note => note.instrument), [7, 16]); assert.deepEqual(imported.notes.map(note => note.key), [63, 39]);
  assert.deepEqual(imported.customInstruments, customInstruments); assert.notEqual(imported.customInstruments, customInstruments);
  imported.customInstruments[0].metadata.source = 'changed'; assert.equal(customInstruments[0].metadata.source, 'local');
  assert.equal(imported.metadata.midiImportOptions.customInstrumentCount, 1); assert.equal(imported.metadata.midiImportOptions.programMap[73].octave, -1);
});
test('complete original GM preset is opt-in and reproduces native sample octave compensation', () => {
  assert.equal(Object.keys(MIDI_PROGRAM_DEFAULTS).length, 128);
  const events = [32, 9, 73].flatMap(program => [[0, 0xc0, program], [0, 0x90, 60, 100], [120, 0x80, 60, 0]]); events.push([0, 0xff, 0x2f, 0]);
  const bytes = midi([track(events)]), native = parseMIDI(bytes, {programMap: MIDI_PROGRAM_DEFAULTS});
  assert.deepEqual(native.notes.map(note => [note.instrument, note.key]), [[1, 63], [7, 15], [6, 27]]);
  assert.deepEqual(parseMIDI(bytes).notes.map(note => note.key), [39, 39, 39], 'existing melodic automatic mapping remains compatible');
});

test('per-channel mappings separate identical patches and override later program changes without changing other channels', () => {
  const bytes = midi([track([[0, 0xc0, 0], [0, 0xc1, 0], [0, 0xc2, 0], [0, 0x90, 60, 100], [0, 0x91, 60, 100], [0, 0x92, 60, 100], [480, 0xc0, 73], [0, 0x90, 60, 100], [480, 0xff, 0x2f, 0]])]);
  const options = {customInstruments: [{name: 'Sample', file: 'sample.ogg', key: 45, pressKey: true}], programMap: {0: {instrument: 7, octave: 1}, 73: -1}, channelMap: {0: {instrument: 5, octave: -1}, 1: {instrument: 16, octave: 1}}};
  const before = structuredClone(options), imported = parseMIDI(bytes, options);
  assert.deepEqual(imported.notes.map(note => [note.instrument, note.key]), [[5, 27], [16, 51], [7, 51], [5, 27]]);
  assert.deepEqual(imported.metadata.midiImportOptions.channelMap, options.channelMap);
  assert.deepEqual(options, before);
  assert.deepEqual(parseMIDI(bytes, {...options, channelMap: {0: 5, 1: -1}}).notes.map(note => [note.instrument, note.key]), [[5, 39], [7, 51], [5, 39]], 'omitted channel octave resets patch transposition to zero and -1 skips that channel');
});

test('channel 10 override retains resolved percussion keys then applies its own instrument and octave', () => {
  const bytes = midi([track([[0, 0xc9, 73], [0, 0x99, 36, 100], [0, 38, 100], [480, 0xff, 0x2f, 0]])]);
  const options = {percussionMap: {36: {instrument: 7, key: 57}}, programMap: {73: {instrument: 6, octave: 2}}, channelMap: {9: {instrument: 5, octave: -1}}};
  assert.deepEqual(parseMIDI(bytes, options).notes.map(note => [note.instrument, note.key]), [[5, 45], [5, 29]]);
  assert.deepEqual(parseMIDI(bytes, {percussionMap: options.percussionMap}).notes.map(note => [note.instrument, note.key]), [[7, 57], [3, 41]], 'without the channel override the native per-key drum mapping remains unchanged');
  const skipped = parseMIDI(bytes, {...options, channelMap: {9: -1}});
  assert.equal(skipped.notes.length, 0); assert.equal(skipped.metadata.skippedMappedNotes, 2);
});
test('complete original percussion table and explicit key/instrument/skip mappings are applied', () => {
  assert.equal(Object.keys(MIDI_PERCUSSION_DEFAULTS).length, 64);
  assert.deepEqual(MIDI_PERCUSSION_DEFAULTS[36], {instrument: 2, key: 39}); assert.deepEqual(MIDI_PERCUSSION_DEFAULTS[56], {instrument: 11, key: 38});
  const bytes = midi([track([[0, 0x99, 36, 100], [0, 38, 100], [0, 42, 100], [0, 56, 100], [0, 15, 100], [0, 20, 100], [480, 0xff, 0x2f, 0]])]);
  const original = parseMIDI(bytes);
  assert.deepEqual(original.notes.slice(0, 4).map(note => [note.instrument, note.key]), [[2, 39], [3, 41], [3, 55], [11, 38]]);
  const imported = parseMIDI(bytes, {percussionMap: {36: {instrument: 7, key: 57}, 38: -1, 42: 4, 15: {instrument: 2, key: 50}}});
  assert.deepEqual(imported.notes.map(note => [note.instrument, note.key]), [[7, 57], [4, 55], [11, 38], [2, 50], [4, 45]]);
  assert.equal(imported.metadata.skippedMappedNotes, 1); assert.equal(imported.metadata.percussionFallbackNotes, 1);
});
test('velocity/pan/name flags are independent and do not remove zero-volume notes', () => {
  const bytes = midi([track([[0, 0xff, 3, 4, 76, 101, 97, 100], [0, 0xb0, 7, 64], [0, 10, 0], [0, 0x90, 60, 127], [480, 0x80, 60, 0], [0, 0xb0, 7, 0], [0, 0x90, 60, 127], [480, 0x80, 60, 0], [0, 0xff, 0x2f, 0]])]);
  const original = parseMIDI(bytes), imported = parseMIDI(bytes, {keepVelocity: false, keepPan: false, trackNames: false});
  assert.deepEqual(original.notes.map(note => note.velocity), [50, 0]); assert.equal(original.notes[0].pan, -100); assert.equal(original.layers[0].name, 'Lead');
  assert.deepEqual(imported.notes.map(note => note.velocity), [100, 100]); assert.ok(imported.notes.every(note => note.pan === 0));
  assert.equal(imported.title, 'Lead'); assert.equal(imported.layers[0].name, '轨道 1'); assert.equal(imported.notes.length, 2);
});
test('octave offsets run before range checks, while native range folding preserves pitch classes', () => {
  const low = midi([track([[0, 0x90, 12, 100], [480, 0x80, 12, 0], [0, 0xff, 0x2f, 0]])]);
  assert.equal(parseMIDI(low).notes.length, 0); assert.equal(parseMIDI(low, {octaveOffset: 1}).notes[0].key, 3);
  const extremes = midi([track([[0, 0x90, 0, 100], [0, 127, 100], [480, 0xff, 0x2f, 0]])]);
  const folded = parseMIDI(extremes, {keepWithinOctaveRange: true});
  assert.deepEqual(folded.notes.map(note => note.key), [39, 46]); assert.equal(folded.metadata.skippedOutOfRangeNotes, 0);
});
test('maxLayers and invalid import settings reject without mutating input bytes or options', () => {
  const bytes = midi([track([[0, 0x90, 60, 100], [0, 64, 100], [0, 67, 100], [480, 0xff, 0x2f, 0]])]), before = bytes.slice();
  const options = {maxLayers: 2}; assert.throws(() => parseMIDI(bytes, options), /未截断或丢弃/);
  assert.deepEqual(bytes, before); assert.deepEqual(options, {maxLayers: 2}); assert.equal(parseMIDI(bytes, {maxLayers: 3}).notes.length, 3);
  for (const invalid of [{gridSubdivision: 0}, {gridSubdivision: 1.5}, {gridSubdivision: 17}, {octaveOffset: 9}, {targetTempo: 0}, {targetTempo: 655.35, gridSubdivision: 2}, {maxLayers: 0}, {keepPan: 'yes'}, {programMap: {128: 0}}, {programMap: {0: 16}}, {programMap: {0: {instrument: 0, octave: 9}}}, {percussionMap: {36: {instrument: 2, key: 88}}}, {channelMap: {16: 0}}, {channelMap: {'-1': 0}}, {channelMap: {0: 16}}, {channelMap: {9: {instrument: 2, octave: 1.5}}}, {channelMap: []}, {customInstruments: Array(256).fill({})}]) assert.throws(() => parseMIDI(bytes, invalid));
});
test('SMPTE timing accepts the same grid/trim options and excessive timelines fail explicitly', () => {
  const bytes = midi([track([[1000, 0x90, 60, 100], [1000, 0x80, 60, 0], [0, 0xff, 0x2f, 0]])], 0xe728, 0);
  const imported = parseMIDI(bytes, {targetTempo: 16, gridSubdivision: 2, removeSilent: true});
  assert.equal(imported.tempo, 32); assert.equal(imported.notes[0].tick, 0); assert.equal(imported.notes[0].duration, 32); assert.equal(imported.length, 32); assert.equal(imported.metadata.leadingSilenceSecondsRemoved, 1);
  const huge = midi([track([[0, 0x90, 60, 100], [0x0fffffff, 0x80, 60, 0], [0, 0xff, 0x2f, 0]])]);
  assert.throws(() => parseMIDI(huge), /1,000,000 tick/);
});
test('actual 65,535 simultaneous MIDI notes fit, while the 65,536th rejects without truncation', {timeout: 5000}, () => {
  const chord = count => {
    const data = new Uint8Array(count * 4 + 5);
    for (let i = 0; i < count; i++) data.set([0, 0x90, 60, 100], i * 4);
    data.set([0x83, 0x60, 0xff, 0x2f, 0], count * 4); // 480 ticks then end-of-track.
    const bytes = new Uint8Array(22 + data.length);
    bytes.set([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,...be32(data.length)]);bytes.set(data,22);
    return bytes;
  };
  const imported = parseMIDI(chord(65535));
  assert.equal(imported.notes.length, 65535);assert.equal(imported.layers.length, 65535);assert.equal(imported.notes.at(-1).layer, 65534);
  assert.equal(new Set(imported.notes.map(note => note.layer)).size, 65535);
  assert.throws(() => parseMIDI(chord(65536)), /超过 65535 个图层.*未截断/);
});
