import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {AudioEngine, INSTRUMENTS, BUNDLED_CUSTOM_SOUNDS, encodeWav, sampleRateForNote, nativePan} from '../js/audio.js';

class Param {
  value = 0;
  setTargetAtTime(value) { this.value = value; }
}
class MockNode {
  gain = new Param();
  pan = new Param();
  playbackRate = new Param();
  connect(destination) { this.destination = destination; return destination; }
  disconnect() {}
  start(when) { this.when = when; }
  stop() { this.stopped = true; this.onended?.(); }
}
class Context {
  currentTime = 10;
  state = 'running';
  destination = new MockNode();
  sources = [];
  createGain() { return new MockNode(); }
  createStereoPanner() { return new MockNode(); }
  createBufferSource() { const source = new MockNode(); this.sources.push(source); return source; }
}
function engine() {
  const context = new Context();
  const audio = new AudioEngine({context});
  audio.buffers.set(0, {duration: 1});
  audio.init = async () => {
    if (!audio.masterGain) { audio.masterGain = context.createGain(); audio.masterGain.connect(context.destination); }
    return audio;
  };
  return audio;
}

test('the original 16 sample files ship with unchanged instrument IDs', async () => {
  assert.equal(INSTRUMENTS.length, 16);
  assert.equal(INSTRUMENTS[1].file, 'dbass.ogg');
  assert.equal(INSTRUMENTS[8].file, 'icechime.ogg');
  assert.equal(INSTRUMENTS[15].file, 'pling.ogg');
  await Promise.all(INSTRUMENTS.map(instrument => access(new URL(`../assets/sounds/${instrument.file}`, import.meta.url))));
  assert.equal(BUNDLED_CUSTOM_SOUNDS.length, 4);
  await Promise.all(BUNDLED_CUSTOM_SOUNDS.map(file => access(new URL(`../assets/sounds/Custom/${file}`, import.meta.url))));
});

test('init fetches only the 20 fixed local samples once and resolves bundled custom references', async () => {
  const context = new Context(), requests = [], previousFetch = globalThis.fetch;
  context.decodeAudioData = async () => ({duration: 1});
  globalThis.fetch = async url => { requests.push(String(url)); return {ok: true, arrayBuffer: async () => new ArrayBuffer(1)}; };
  try {
    const audio = new AudioEngine({context, assetBase: new URL('http://127.0.0.1:8765/assets/sounds/')});
    await audio.init(); await audio.init();
    assert.equal(requests.length, 20);
    assert.ok(requests.every(url => url.startsWith('http://127.0.0.1:8765/assets/sounds/')));
    assert.equal(audio.buffers.size, 16);
    assert.equal(audio.bundledCustomSamples.size, 4);
    const sample = audio.bundledCustomSamples.get('entity.experience_orb.pickup.ogg');
    for (const file of ['Custom/entity.experience_orb.pickup.ogg', 'Custom\\entity.experience_orb.pickup.ogg', 'entity.experience_orb.pickup.ogg', './Custom/entity.experience_orb.pickup.ogg', '.\\Custom\\entity.experience_orb.pickup.ogg', 'custom/ENTITY.EXPERIENCE_ORB.PICKUP.OGG']) {
      assert.equal(audio._sample({instrument: 16}, {customInstruments: [{file}]}).buffer, sample);
    }
    assert.equal(audio.warnings.length, 0);
    const definition = {customInstruments: [{file: 'Custom/entity.experience_orb.pickup.ogg'}]};
    const override = {duration: 9}; audio.customSamples.set(0, override);
    assert.equal(audio._sample({instrument: 16}, definition).buffer, override);
    audio.removeCustomSample(16);
    assert.equal(audio._sample({instrument: 16}, definition).buffer, sample);
    for (const file of ['https://example.com/sample.ogg', '../Custom/entity.experience_orb.pickup.ogg', 'Custom/../entity.experience_orb.pickup.ogg', 'file:///C:/sample.ogg', '/Custom/entity.experience_orb.pickup.ogg', 'C:\\Custom\\entity.experience_orb.pickup.ogg', 'other/entity.experience_orb.pickup.ogg', 'Custom/entity.experience_orb.pickup.ogg/.']) {
      assert.equal(audio._sample({instrument: 16}, {customInstruments: [{file}]}).buffer, audio.buffers.get(0));
    }
    assert.equal(requests.length, 20);
    assert.equal(audio.warnings.length, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('native, octave, fine pitch and custom sample pitch match play_sound.gml', () => {
  assert.equal(sampleRateForNote({key: 45}), 1);
  assert.equal(sampleRateForNote({key: 57}), 2);
  assert.equal(sampleRateForNote({key: 33}), 0.5);
  assert.equal(sampleRateForNote({key: 44, pitch: 100}), 1);
  assert.equal(sampleRateForNote({key: 45}, 57), 2);
});

test('WAV has correct RIFF lengths, stereo interleaving and PCM clipping', async () => {
  const blob = encodeWav({numberOfChannels: 2, length: 3, sampleRate: 44100,
    getChannelData: index => index === 0 ? new Float32Array([-2, 0, 2]) : new Float32Array([1, -1, 0.5])});
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(bytes.byteLength, 56);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), 48);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint32(40, true), 12);
  assert.deepEqual(Array.from({length: 6}, (_, index) => view.getInt16(44 + index * 2, true)), [-32768, 32767, 0, -32768, 32767, 16384]);
});

test('audio graph multiplies velocity/layer volume and combines stereo pan', () => {
  const audio = engine();
  const song = {layers: [{volume: 50, pan: 40}], notes: []};
  audio._schedule({instrument: 0, key: 57, velocity: 50, pan: -10, layer: 0}, song, 10.1, audio.context, audio.context.destination);
  const source = audio.context.sources[0];
  assert.equal(source.when, 10.1);
  assert.equal(source.playbackRate.value, 2);
  assert.equal(source.destination.gain.value, 0.25);
  assert.equal(source.destination.destination.pan.value, 0.15);
});

test('native layer/note pan rules agree at centre, extremes and opposite directions', () => {
  for (const [layer, note, expected] of [[0,-100,-1],[0,100,1],[-100,0,-.5],[100,0,.5],[40,-10,.15],[-100,100,0],[100,-100,0],[-100,-100,-1],[100,100,1]]) assert.equal(nativePan(note,layer),expected);
});

test('mute and solo silence excluded layers', () => {
  const audio = engine();
  const song = {layers: [{solo: true}, {}, {muted: true, solo: true}]};
  for (let layer = 0; layer < 3; layer++) audio._schedule({instrument: 0, key: 45, layer}, song, 10, audio.context, audio.context.destination);
  assert.equal(audio.context.sources.length, 1);
});

test('lookahead schedules exact audio-clock times, pause captures tick and cancels voices', async () => {
  const audio = engine();
  const song = {tempo: 10, length: 20, layers: [{}], notes: [{tick: 5, key: 45, instrument: 0, layer: 0}, {tick: 8, key: 45, instrument: 0, layer: 0}]};
  await audio.play(song, {fromTick: 5});
  assert.equal(audio.context.sources.length, 1);
  assert.ok(Math.abs(audio.context.sources[0].when - 10.035) < 1e-9);
  audio.context.currentTime = 10.2;
  audio._pump();
  assert.equal(audio.context.sources.length, 2);
  assert.ok(Math.abs(audio.context.sources[1].when - 10.335) < 1e-9);
  assert.ok(Math.abs(audio.pause() - 6.65) < 1e-9);
  assert.equal(audio.playing, false);
  assert.equal(audio.context.sources.every(source => source.stopped), true);
  audio.stop();
  assert.equal(audio.currentTick, 0);
});

test('loop transport wraps to loopStart and schedules the new cycle ahead', async () => {
  const audio = engine();
  const song = {tempo: 10, length: 4, loopStart: 2, loop: true, layers: [{}], notes: [{tick: 2, key: 45, instrument: 0, layer: 0}]};
  await audio.play(song, {fromTick: 3});
  audio.context.currentTime = 10.16;
  audio._pump();
  assert.ok(Math.abs(audio.currentTick - 2.25) < 1e-9);
  assert.ok(Math.abs(audio.context.sources[0].when - 10.135) < 1e-9);
  audio.stop();
});

test('finite NBS loopCount repeats only the requested number of times and ends once', async () => {
  const audio = engine(); let ended = 0;
  const song = {tempo: 10, length: 4, loopStart: 2, loop: true, loopCount: 1, layers: [{}], notes: [{tick: 2, key: 45, instrument: 0, layer: 0}]};
  await audio.play(song, {onEnded: () => ended++});
  for (const time of [10.2, 10.4, 10.5, 10.64, 10.9]) { audio.context.currentTime = time; audio._pump(); }
  assert.equal(audio.context.sources.length, 2);
  assert.equal(audio.playing, false);
  assert.equal(audio.currentTick, 4);
  assert.equal(ended, 1);
  audio.stop();
});

test('future voices honor in-place mute, solo, volume and pan changes during playback', async () => {
  const audio = engine();
  const song = {tempo: 10, length: 12, layers: [{volume: 100, pan: 0}, {}], notes: [
    {tick: 4, layer: 0, key: 45, instrument: 0, velocity: 100},
    {tick: 6, layer: 0, key: 45, instrument: 0, velocity: 100},
    {tick: 8, layer: 0, key: 45, instrument: 0, velocity: 100},
  ]};
  await audio.play(song);
  song.layers[0].muted = true;
  audio.context.currentTime = 10.4; audio._pump();
  assert.equal(audio.context.sources.length, 0);
  song.layers[0].muted = false; song.layers[1].solo = true;
  audio.context.currentTime = 10.6; audio._pump();
  assert.equal(audio.context.sources.length, 0);
  song.layers[1].solo = false; song.layers[0].volume = 25; song.layers[0].pan = -50;
  audio.context.currentTime = 10.8; audio._pump();
  assert.equal(audio.context.sources.length, 1);
  assert.equal(audio.context.sources[0].destination.gain.value, 0.25);
  assert.equal(audio.context.sources[0].destination.destination.pan.value, -0.25);
  audio.stop();
});

test('WAV rejects a memory-heavy render before allocating an OfflineAudioContext', async () => {
  const audio = engine(); const oldContext = globalThis.OfflineAudioContext; let allocated = false;
  globalThis.OfflineAudioContext = class { constructor() { allocated = true; } };
  try {
    await assert.rejects(() => audio.exportWav({tempo: 1, length: 1200, layers: [], notes: []}), /WAV 过大/);
    assert.equal(allocated, false);
  } finally { globalThis.OfflineAudioContext = oldContext; }
});

test('missing custom samples warn once and reuse a local harp placeholder', () => {
  const audio = engine();
  const song = {customInstruments: [{name: 'Test', key: 57}]};
  const note = {instrument: 16};
  assert.equal(audio._sample(note, song).buffer, audio.buffers.get(0));
  assert.equal(audio._sample(note, song).key, 57);
  assert.equal(audio.warnings.length, 1);
  audio.customSamples.set(0, {duration: 2});
  assert.equal(audio._sample(note, song).buffer.duration, 2);
  audio.removeCustomSample(16);
  assert.equal(audio.customSamples.has(0), false);
});

test('audition uses current custom definitions after replacing a previously played song', async () => {
  const audio = engine();
  await audio.play({tempo: 10, length: 4, layers: [{}], notes: [], customInstruments: [{name: 'Old', key: 45}]});
  audio.stop();
  audio.customInstruments = [{name: 'Current', key: 57}];
  await audio.preview({instrument: 16, key: 45});
  assert.equal(audio.context.sources.at(-1).playbackRate.value, 2);
  assert.match(audio.warnings.at(-1), /Current/);
  audio.stop();
});
