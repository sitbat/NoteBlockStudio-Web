import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {GLOBAL, HEADER, STOPPED, PREROLL, RUNNING, createRing, shardRanges, transportConfig, tickAtFrame, EventTimeline, refillRing} from '../js/dsp-protocol.js';
import {NBSOutputProcessor} from '../js/output-worklet.js';
import {WasmAudioEngine} from '../js/wasm-audio.js';
import {BUNDLED_CUSTOM_SOUNDS} from '../js/audio.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, limit = 10000) {
  const end = performance.now() + limit;
  while (!predicate()) { if (performance.now() > end) throw new Error('Timed out'); await wait(2); }
}
function message(worker, type) {
  return new Promise((resolve, reject) => {
    const listener = data => { if (data.type === 'error') { worker.off('message', listener); reject(new Error(data.message)); } else if (data.type === type) { worker.off('message', listener); resolve(data); } };
    worker.on('message', listener); worker.once('error', reject);
  });
}

test('10,000 tracks partition into non-overlapping four-lane shards across 14 workers', () => {
  const ranges = shardRanges(10000, 14);
  assert.equal(ranges.length, 14);
  assert.equal(ranges[0].start, 0); assert.equal(ranges.at(-1).end, 10000);
  assert.equal(ranges.filter(range => range.tracks === 716).length, 8);
  assert.equal(ranges.filter(range => range.tracks === 712).length, 6);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i - 1].end);
  assert.equal(shardRanges(3, 14).length, 1);
});

test('sample-clock transport and event offsets handle seeks and finite loop boundaries', () => {
  const config = transportConfig({tempo: 10, length: 8, loop: true, loopStart: 4, loopCount: 2}, {fromTick: 6}, 1000);
  assert.equal(config.endFrame, 1000);
  assert.equal(tickAtFrame(300, config), 5);
  assert.equal(tickAtFrame(1000, config), 8);
  const timeline = new EventTimeline([{tick: 2}, {tick: 4}, {tick: 6}], config), dispatch = [];
  for (let start = 0; start < 1200; start += 128) timeline.dispatch(start, 128, (event, offset) => dispatch.push({tick: event.tick, frame: start + offset}));
  assert.deepEqual(dispatch, [{tick: 6, frame: 0}, {tick: 4, frame: 200}, {tick: 6, frame: 400}, {tick: 4, frame: 600}, {tick: 6, frame: 800}]);
});

test('event list updates affect only future audio without repeating old events', () => {
  const config = transportConfig({tempo: 10, length: 8}, {}, 1000), timeline = new EventTimeline([{tick: 0}], config);
  const seen = [];
  timeline.dispatch(0, 128, (event, offset) => seen.push(offset));
  timeline.replace([{tick: 0}, {tick: 3}], 128);
  timeline.dispatch(128, 256, (event, offset) => seen.push(128 + offset));
  assert.deepEqual(seen, [0, 300]);
});

test('worklet never waits, reports missing blocks and rejects stale slot sequences', () => {
  const global = new SharedArrayBuffer(64), control = new Int32Array(global), ring = createRing(4, 128);
  const header = new Int32Array(ring.header), stamps = new Int32Array(ring.stamps), pcm = new Float32Array(ring.pcm);
  const processor = new NBSOutputProcessor({processorOptions: {global, rings: [ring], blockFrames: 128}});
  Atomics.store(control, GLOBAL.MODE, RUNNING); Atomics.store(control, GLOBAL.EPOCH, 1);
  const left = new Float32Array(128), right = new Float32Array(128);
  processor.process([], [[left, right]]);
  assert.equal(Atomics.load(control, GLOBAL.UNDERRUNS), 1);
  assert.equal(Atomics.load(control, GLOBAL.READ), 1);
  assert.ok(left.every(value => value === 0));
  pcm.fill(.25, 256, 512); stamps[1] = 1; // old data, current sequence expects 2
  processor.process([], [[left, right]]);
  assert.ok(left.every(value => value === 0));
  Atomics.store(control, GLOBAL.MODE, STOPPED);
  processor.process([], [[left, right]]);
  assert.equal(Atomics.load(control, GLOBAL.READ), 2);
  assert.equal(Atomics.load(header, HEADER.UNDERRUNS), 2);
});

test('worker/Wasm/shared-ring/worklet integration sustains all voices and responds to parameters', async t => {
  const module = await WebAssembly.compile(await readFile(new URL('../wasm/nbs_dsp.wasm', import.meta.url)));
  const global = new SharedArrayBuffer(64), control = new Int32Array(global), rings = [createRing(4, 128), createRing(4, 128)];
  const sample = new Float32Array(new SharedArrayBuffer(1024 * 4));
  for (let i = 0; i < sample.length; i++) sample[i] = Math.sin(i / 1024 * Math.PI * 16) * .02;
  const workers = rings.map(() => new Worker(new URL('./dsp-worker-adapter.mjs', import.meta.url)));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(async (worker, index) => {
    const ready = message(worker, 'ready');
    worker.postMessage({type: 'init', module, global, ring: rings[index], tracks: 4, sampleRate: 48000, blockFrames: 128, leadBlocks: 3, voicesPerTrack: 4, samples: [{id: 0, pcm: sample.buffer}]});
    assert.equal((await ready).simd, true);
  }));
  for (const ring of rings) {
    const params = new Float32Array(ring.params);
    for (let track = 0; track < 4; track++) params.set([1, 0, .5, 1], track * 4);
  }
  Atomics.store(control, GLOBAL.EPOCH, 1); Atomics.store(control, GLOBAL.MODE, PREROLL);
  const transport = transportConfig({tempo: 10, length: 100}, {}, 48000);
  await Promise.all(workers.map(async worker => {
    const prepared = message(worker, 'prepared');
    worker.postMessage({type: 'prepare', epoch: 1, transport, stress: true, events: Array.from({length: 4}, (_, track) => ({tick: 0, track, sample: 0, rate: 1 + track * .01, gain: 1, pan: 0}))});
    await prepared;
  }));
  await until(() => rings.every(ring => Atomics.load(new Int32Array(ring.header), HEADER.WRITE) >= 3));
  const processor = new NBSOutputProcessor({processorOptions: {global, rings, blockFrames: 128}});
  Atomics.store(control, GLOBAL.MODE, RUNNING); workers.forEach(worker => worker.postMessage({type: 'resume'}));
  const left = new Float32Array(128), right = new Float32Array(128); let energy = 0;
  for (let seq = 0; seq < 16; seq++) {
    await until(() => rings.every(ring => Atomics.load(new Int32Array(ring.header), HEADER.WRITE) > seq));
    processor.process([], [[left, right]]);
    energy += left.reduce((sum, value) => sum + value * value, 0);
  }
  assert.ok(energy > .01);
  assert.equal(rings.reduce((sum, ring) => sum + Atomics.load(new Int32Array(ring.header), HEADER.ACTIVE), 0), 8);
  assert.equal(Atomics.load(control, GLOBAL.UNDERRUNS), 0);
  for (const ring of rings) {
    const header = new Int32Array(ring.header), params = new Float32Array(ring.params);
    Atomics.add(header, HEADER.PARAM_REV, 1);
    for (let track = 0; track < 4; track++) params[track * 4 + 3] = 0;
    Atomics.add(header, HEADER.PARAM_REV, 1);
  }
  for (let seq = 16; seq < 32; seq++) {
    await until(() => rings.every(ring => Atomics.load(new Int32Array(ring.header), HEADER.WRITE) > seq));
    processor.process([], [[left, right]]);
  }
  assert.ok(left.every(value => Math.abs(value) < 1e-8));
  Atomics.store(control, GLOBAL.MODE, STOPPED); workers.forEach(worker => worker.postMessage({type: 'stop'}));
  processor.process([], [[left, right]]); assert.ok(left.every(value => value === 0));
});

test('Wasm engine configuration validates supported blocks without creating an AudioContext', () => {
  const audio = new WasmAudioEngine();
  assert.equal(audio.context, null);
  assert.equal(audio.config.workers, 14);
  assert.equal(audio.config.blockFrames, 256);
  assert.equal(audio.config.leadBlocks, 4);
  audio.configure({workers: 14, leadBlocks: 2, voicesPerTrack: 8});
  assert.equal(audio.config.leadBlocks, 2);
  assert.throws(() => audio.configure({blockFrames: 100}), /128/);
});

test('full WasmAudioEngine reuses workers across pause/seek, exposes PCM and parameter telemetry, and renders reverb WAV', async t => {
  const old = {Worker: globalThis.Worker, AudioWorkletNode: globalThis.AudioWorkletNode, isSecureContext: globalThis.isSecureContext, crossOriginIsolated: globalThis.crossOriginIsolated};
  class BrowserWorker {
    constructor() {
      this.inner = new Worker(new URL('./dsp-worker-adapter.mjs', import.meta.url));
      this.inner.on('message', data => this.onmessage?.({data}));
      this.inner.on('error', error => this.onerror?.({message: error.message}));
    }
    postMessage(data) {
      if (data.type === 'init') this.control = new Int32Array(data.global);
      // Enforce ordering even if another CPU handles prepare before this call returns.
      if (data.type === 'prepare') assert.equal(Atomics.load(this.control, GLOBAL.MODE), PREROLL, 'PREROLL must publish before the first prepare message');
      this.inner.postMessage(data);
    }
    terminate() { return this.inner.terminate(); }
  }
  class WorkletNode {
    constructor(_context, _name, options) { this.processor = new NBSOutputProcessor(options); }
    connect() {} disconnect() {}
  }
  globalThis.Worker = BrowserWorker; globalThis.AudioWorkletNode = WorkletNode;
  globalThis.isSecureContext = true; globalThis.crossOriginIsolated = true;
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const context = {sampleRate: 48000, state: 'running', baseLatency: .005, outputLatency: .01, destination: {}, audioWorklet: {addModule: async () => {}},
    createGain: () => ({gain: {value: 1, setTargetAtTime(value) { this.value = value; }}, connect() {}})};
  const audio = new WasmAudioEngine({context, workers: 2, blockFrames: 128, leadBlocks: 6});
  audio._modulePromise = WebAssembly.compile(await readFile(new URL('../wasm/nbs_dsp.wasm', import.meta.url)));
  const pcm = Float32Array.from({length: 1024}, (_, i) => Math.sin(i / 1024 * Math.PI * 16) * .1);
  const buffer = {length: pcm.length, numberOfChannels: 1, sampleRate: 48000, duration: pcm.length / 48000, getChannelData: () => pcm};
  for (let id = 0; id < 16; id++) audio.buffers.set(id, buffer);
  for (const file of BUNDLED_CUSTOM_SOUNDS) audio.bundledCustomSamples.set(file, buffer);
  t.after(() => { audio.stop(); audio._destroyPool(); audio._previewEngine?._destroyPool(); });
  const song = {tempo: 10, length: 20, loop: false, customInstruments: [],
    layers: Array.from({length: 8}, (_, id) => ({id, volume: 50, pan: 0, reverb: 50})),
    notes: Array.from({length: 8}, (_, layer) => ({tick: 0, layer, key: 45, instrument: 0, velocity: 100, pan: 0}))};
  await audio.play(song, {stress: true});
  assert.equal(audio.playing, true);
  const originalWorkers = [...audio._pool.workers], left = new Float32Array(128), right = new Float32Array(128);
  audio._pool.node.processor.process([], [[left, right]]);
  assert.equal(audio.getStats().activeVoices, 8);
  assert.ok(audio.getStats().outputRms > 0);
  const mainPool = audio._pool, mainFrame = audio._playedFrames();
  const [liveFirst, liveSecond] = await Promise.all([
    audio.triggerLive({key: 45, instrument: 0, velocity: 90}, {channel: 0, layer: {volume: 70, pan: -10, reverb: 35}}),
    audio.triggerLive({key: 49, instrument: 0, velocity: 80}, {channel: 1, layer: {volume: 80, pan: 10, reverb: 65}}),
  ]);
  assert.equal(liveFirst.accepted, true); assert.equal(liveSecond.accepted, true); assert.equal(liveSecond.activeVoices, 2, 'hardware chord adds a voice without resetting the first');
  const live = audio._liveEngine, livePool = live._pool;
  assert.equal(livePool.tracks, 16); assert.equal(livePool.workers.length, 1); assert.equal(live._song.notes.length, 0);
  assert.equal(live._song.layers[0].reverb, 35); assert.equal(live._song.layers[1].reverb, 65);
  assert.equal(audio._pool, mainPool); assert.equal(audio._playedFrames(), mainFrame); assert.equal(audio.playing, true, 'monitoring leaves the main transport untouched');
  let liveEnergy = 0;
  for (let sequence = 0; sequence < 10; sequence++) {
    await until(() => Atomics.load(livePool.rings[0].headerView, HEADER.WRITE) > sequence);
    livePool.node.processor.process([], [[left, right]]); liveEnergy += left.reduce((sum, value) => sum + value * value, 0);
  }
  assert.ok(liveEnergy > 0, 'actual Rust chord produces nonzero PCM');
  await assert.rejects(audio.triggerLive({key: 45}, {channel: 16}), /通道/);
  audio.stopLive(); assert.equal(livePool.destroyed, true); assert.equal(audio._liveEngine, null); assert.equal(audio.playing, true);
  const tick = audio.pause(); assert.ok(tick > 0);
  audio._pool.node.processor.process([], [[left, right]]); assert.ok(left.every(value => value === 0));
  await audio.play(song, {fromTick: 0, stress: true});
  assert.deepEqual(audio._pool.workers, originalWorkers);
  song.layers[0].reverb = 75; audio.updateTrackParams(song);
  for (let seq = 0; seq < 5; seq++) {
    await until(() => audio._pool.rings.every(ring => Atomics.load(ring.headerView, HEADER.WRITE) > seq));
    audio._pool.node.processor.process([], [[left, right]]); await wait(2);
  }
  const stats = audio.getStats();
  assert.equal(stats.baseLatencyMs, 5); assert.equal(stats.outputLatencyMs, 10);
  assert.ok(stats.controlAckMs > 0); assert.ok(stats.controlPipelineMs >= 0);
  assert.equal(stats.underruns, 0);
  audio.stop();
  const blob = await audio.exportWav({...song, length: 1}, {masterVolume: .5});
  const wav = await blob.arrayBuffer(), view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 48000);
  assert.ok(wav.byteLength > 48000 * 4 * 3);
  assert.ok(new Int16Array(wav, 44).some(value => value !== 0));

  // A -> live upload B -> undo restores Map A. A keyed pool must not retain B PCM.
  const constant = value => {
    const pcm = new Float32Array(256).fill(value);
    return {length: 256, numberOfChannels: 1, sampleRate: 48000, duration: 256 / 48000, getChannelData: () => pcm};
  };
  const sampleA = constant(.1), sampleB = constant(.6);
  const customSong = {tempo: 10, length: 10, loop: false, customInstruments: [{name: 'Custom', file: 'custom.ogg', key: 45}],
    layers: [{volume: 100, pan: 0, reverb: 0}], notes: [{tick: 0, layer: 0, key: 45, instrument: 16, velocity: 100}]};
  audio.customSamples = new Map([[0, sampleA]]);
  await audio.play(customSong, {stress: true});
  const poolA = audio._pool;
  const customLive = await audio.triggerLive({key: 45, instrument: 16, velocity: 100});
  assert.equal(customLive.accepted, true);
  const livePoolA = audio._liveEngine._pool;
  context.decodeAudioData = async () => sampleB;
  await audio.setCustomSample(16, new ArrayBuffer(4), {isCurrent: () => true});
  assert.equal(poolA.key, null, 'live upload invalidates cached PCM bank identity');
  assert.equal(livePoolA.key, null, 'custom upload also invalidates the monitoring pool bank');
  audio.pause(); audio.customSamples = new Map([[0, sampleA]]);
  await audio.play(customSong, {stress: true});
  assert.notEqual(audio._pool, poolA, 'undo rebuilds PCM from the restored sample map');
  audio._pool.node.processor.process([], [[left, right]]);
  assert.ok(left.some(value => value > .01));
  assert.ok(left.every(value => value < .15), 'the rendered PCM is sample A, not stale louder B');
  await audio.triggerLive({key: 45, instrument: 16, velocity: 100});
  assert.notEqual(audio._liveEngine._pool, livePoolA, 'monitoring after undo rebuilds the restored A sample bank');
  const liveAtStop = audio._liveEngine._pool;
  audio.stop();
  assert.equal(liveAtStop.destroyed, true, 'parent stop clears isolated monitoring voices and worker');
});

test('late custom-sample decode is aborted before mutating a replacement project', async () => {
  const audio = new WasmAudioEngine(); audio.init = async () => audio;
  let finishDecode, current = true;
  audio.context = {decodeAudioData: () => new Promise(resolve => { finishDecode = resolve; })};
  const pending = audio.setCustomSample(16, new ArrayBuffer(4), {isCurrent: () => current});
  await Promise.resolve();
  current = false; audio.customSamples = new Map();
  finishDecode({length: 1});
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(audio.customSamples.size, 0);
});

test('a project changed during PCM upload is not restored or committed by the stale operation', async () => {
  const audio = new WasmAudioEngine(); audio.init = async () => audio;
  let current = true; const replacementMap = new Map();
  audio.context = {decodeAudioData: async () => ({length: 1})};
  audio._uploadSample = async () => { current = false; audio.customSamples = replacementMap; };
  await assert.rejects(() => audio.setCustomSample(16, new ArrayBuffer(4), {isCurrent: () => current}), error => error.name === 'AbortError');
  assert.equal(audio.customSamples, replacementMap);
  assert.equal(replacementMap.size, 0);
});

test('benchmark control API updates only a valid independent track and counts actual changes', () => {
  const audio = new WasmAudioEngine();
  audio._benchmarking = true; audio._benchmarkSong = {layers: [{reverb: 20}, {reverb: 40}]};
  audio._benchmarkMetrics = {liveControlChanges: 0};
  assert.deepEqual(audio.updateBenchmarkTrack(1, {reverb: 85}), {index: 1, reverb: 85});
  assert.equal(audio._benchmarkSong.layers[0].reverb, 20);
  assert.equal(audio._benchmarkMetrics.liveControlChanges, 1);
  assert.throws(() => audio.updateBenchmarkTrack(2, {reverb: 5}), /超出/);
});

test('bounded pump catches up missed blocks and fills the ring in one task without starving controls', () => {
  let next = 4, clock = 0; const published = [];
  const count = refillRing(() => 7, () => next, 4, publish => { published.push(publish); next++; clock += .2; }, {now: () => clock, budgetMs: 3});
  assert.equal(count, 7); assert.equal(next, 11);
  assert.deepEqual(published, [false, false, false, true, true, true, true]);
  next = 0; clock = 0;
  const bounded = refillRing(() => 20, () => next, 4, () => { next++; clock += .8; }, {now: () => clock, budgetMs: 3});
  assert.equal(bounded, 4);
});
