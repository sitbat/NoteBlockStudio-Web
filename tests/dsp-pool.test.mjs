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
  assert.equal(rings.reduce((sum,ring)=>sum+Atomics.load(new Int32Array(ring.header),HEADER.REVERB_TRACKS),0),8,'every Rust track accepted a nonzero enabled reverb');
  assert.ok(rings.every(ring=>Atomics.load(new Int32Array(ring.header),HEADER.REVERB_BYTES)>0),'each actual WASM heap allocated its own reverb state');
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
  assert.equal(rings.reduce((sum,ring)=>sum+Atomics.load(new Int32Array(ring.header),HEADER.REVERB_TRACKS),0),0,'disabled wet tracks are not counted as processing the target load');
  Atomics.store(control, GLOBAL.MODE, STOPPED); workers.forEach(worker => worker.postMessage({type: 'stop'}));
  processor.process([], [[left, right]]); assert.ok(left.every(value => value === 0));
});

test('Wasm engine configuration validates supported blocks without creating an AudioContext', () => {
  const audio = new WasmAudioEngine();
  assert.equal(audio.context, null);
  assert.equal(audio.config.workers, 14);
  assert.equal(audio.config.blockFrames, 256);
  assert.equal(audio.config.leadBlocks, 6);
  audio.configure({workers: 14, leadBlocks: 2, voicesPerTrack: 8});
  assert.equal(audio.config.leadBlocks, 2);
  assert.throws(() => audio.configure({blockFrames: 100}), /128/);
});

test('full WasmAudioEngine reuses workers across pause/seek, exposes PCM and parameter telemetry, and renders reverb WAV', async t => {
  const old = {Worker: globalThis.Worker, AudioWorkletNode: globalThis.AudioWorkletNode, isSecureContext: globalThis.isSecureContext, crossOriginIsolated: globalThis.crossOriginIsolated};
  let onPrepare;
  class BrowserWorker {
    constructor() {
      this.messages = [];
      this.inner = new Worker(new URL('./dsp-worker-adapter.mjs', import.meta.url));
      this.inner.on('message', data => { this.messages.push(data); this.onmessage?.({data}); });
      this.inner.on('error', error => this.onerror?.({message: error.message}));
    }
    postMessage(data) {
      if (data.type === 'init') this.control = new Int32Array(data.global);
      // Enforce ordering even if another CPU handles prepare before this call returns.
      if (data.type === 'prepare') assert.equal(Atomics.load(this.control, GLOBAL.MODE), PREROLL, 'PREROLL must publish before the first prepare message');
      if (data.type === 'prepare') onPrepare?.(data);
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
  assert.equal(audio.getStats().verifiedReverbTracks,8);assert.ok(audio.getStats().reverbStateBytes>0);
  song.notes.push({id:'edited-future',tick:1,layer:0,key:52,instrument:0,velocity:90,pan:0});
  assert.equal(audio.updateSong(song),true);
  const eventRevision=audio.getEventUpdateStatus().revision;
  assert.equal(audio.getEventUpdateStatus(eventRevision).applied,false);
  await until(()=>audio.getEventUpdateStatus(eventRevision).applied);
  const eventAck=audio.getEventUpdateStatus(eventRevision);assert.deepEqual(eventAck.pendingShards,[]);assert.equal(eventAck.appliedFrames.length,2);assert.ok(eventAck.ackMs>0);assert.ok(eventAck.pipelineMs>=0);assert.equal(audio.getStats().eventChangeCount,1);
  for(let seq=1;seq<42;seq++){await until(()=>audio._pool.rings.every(ring=>Atomics.load(ring.headerView,HEADER.WRITE)>seq));audio._pool.node.processor.process([],[[left,right]]);}
  assert.equal(audio.getStats().activeVoices,9,'the accepted future edit actually starts a new Rust voice without replaying the original eight');
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
  assert(audio._pool.rings.some(ring=>Atomics.load(ring.headerView,HEADER.ACTIVE)>0),'stopped worker headers retain the prior looping voice count');
  assert.equal(audio.getStats().activeVoices,0,'a stopped pool reports zero currently rendering voices despite historical headers');
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

  const tempoSong = {tempo:100,length:8,loop:false,customInstruments:[{name:'Tempo Changer',file:''}],
    layers:[{volume:100,pan:0,reverb:0}],notes:[{tick:0,layer:0,key:45,instrument:0,velocity:100},{tick:4,layer:0,key:39,instrument:16,pitch:3000}]};
  const tempoWav = new DataView(await (await audio.exportWav(tempoSong)).arrayBuffer());
  assert(Math.abs(tempoWav.getUint32(40,true)/4-5280)<=1,'offline Rust duration uses the same variable tempo map (0.06 s plus 0.05 s tail)');
  await audio.play(tempoSong,{stress:true});
  const auditionMainPool=audio._pool,auditionMainFrame=audio._playedFrames();
  await audio.previewNotes([{tick:4,layer:0,key:33,instrument:0,velocity:100},{tick:4,layer:2,key:37,instrument:0,velocity:100},{tick:4,layer:7,key:40,instrument:0,velocity:100}],song.layers);
  assert.equal(audio._previewEngine.getStats().activeVoices,3,'a column/chord is one polyphonic play operation');
  assert.equal(audio._previewEngine._song.layers.length,3,'only participating source tracks are compacted');
  assert.deepEqual(audio._previewEngine._song.layers.map(layer=>layer.reverb),[75,50,50]);
  assert.equal(audio._pool,auditionMainPool);assert.equal(audio._playedFrames(),auditionMainFrame);assert.equal(audio.playing,true);
  await Promise.all([audio.previewNotes([{layer:0,key:45,instrument:0}],song.layers),audio.previewNotes([{layer:0,key:49,instrument:0},{layer:1,key:52,instrument:0}],song.layers)]);
  assert.deepEqual(audio._previewEngine._song.notes.map(note=>note.key),[49,52],'a newer scrub request replaces queued older work');
  audio.stop();

  // Initial recording, including another key arriving during PREROLL, must
  // immediately use the isolated monitor but not double in the song timeline.
  const recordedSong={tempo:100,length:10,loop:true,layers:[{volume:100,pan:0,reverb:0}],customInstruments:[],
    notes:[{id:'first',tick:0,layer:0,key:45,instrument:0,velocity:100}]};
  let lateMonitor, inserted=false;const preparedLists=[];
  onPrepare=data=>{
    if(data.events.length)preparedLists.push(data.events);
    if(inserted || data.events[0]?.notBeforeFrame===undefined)return;
    inserted=true;
    const late={id:'late',tick:4,layer:0,key:49,instrument:0,velocity:100};recordedSong.notes.push(late);
    lateMonitor=audio.monitorRecordedNote(late,{layer:recordedSong.layers[0]});audio.updateSong(recordedSong);
  };
  await Promise.all([audio.monitorRecordedNote(recordedSong.notes[0],{layer:recordedSong.layers[0]}),audio.play(recordedSong)]);
  await lateMonitor;onPrepare=null;
  assert.equal(inserted,true);assert.ok(preparedLists.some(events=>events.length===2),'the final initial snapshot includes the chord note added during prepare');
  const recordPool=audio._pool,recordLivePool=audio._liveEngine._pool;
  let earlyEnergy=0,laterEnergy=0,monitorEnergy=0;
  for(let sequence=0;sequence<400;sequence++){
    await until(()=>Atomics.load(recordPool.rings[0].headerView,HEADER.WRITE)>sequence);
    recordPool.node.processor.process([],[[left,right]]);
    const energy=left.reduce((sum,value)=>sum+value*value,0);
    if(sequence<4)earlyEnergy+=energy;if(sequence*128>=48000)laterEnergy+=energy;
    if(sequence<12){await until(()=>Atomics.load(recordLivePool.rings[0].headerView,HEADER.WRITE)>sequence);recordLivePool.node.processor.process([],[[left,right]]);monitorEnergy+=left.reduce((sum,value)=>sum+value*value,0);}
  }
  assert.equal(earlyEnergy,0,'new recorded onsets are absent from actual Rust timeline PCM');
  assert.ok(monitorEnergy>0,'the isolated Rust monitor immediately produces audible PCM');
  assert.ok(laterEnergy>0,'actual repeated Rust timeline notes resume after the one-second frame threshold');
  assert.equal(recordedSong.notes.some(note=>'notBeforeFrame'in note),false);
  audio.stop();

  let tailEnded=0,tailTicks=0;
  const tailSong={tempo:10,length:100,loop:false,layers:[{volume:100,pan:0,reverb:80}],customInstruments:[],notes:[
    {tick:0,layer:0,key:45,instrument:0,velocity:100},{tick:4,layer:0,key:45,instrument:0,velocity:100}]};
  await audio.play(tailSong,{onEnded:()=>tailEnded++,onTick:()=>tailTicks++});
  audio._pool.node.processor.process([],[[left,right]]);
  const tailPool=audio._pool,tailEpoch=Atomics.load(tailPool.control,GLOBAL.EPOCH),tailRead=Atomics.load(tailPool.control,GLOBAL.READ);
  const paused=audio.pause({tails:true}),ticksBefore=tailTicks;
  assert(paused>0);assert.equal(audio.playing,false);assert.equal(audio._draining,true);
  assert.equal(Atomics.load(tailPool.control,GLOBAL.EPOCH),tailEpoch);assert.equal(Atomics.load(tailPool.control,GLOBAL.READ),tailRead);
  assert.equal(Atomics.load(tailPool.control,GLOBAL.MODE),RUNNING);
  await until(()=>tailPool.workers.every(worker=>worker.messages.some(data=>data.type==='drained'&&data.epoch===tailEpoch)));
  let pauseTailEnergy=0;
  for(let i=0;i<200;i++){
    const sequence=Atomics.load(tailPool.control,GLOBAL.READ);
    await until(()=>Atomics.load(tailPool.rings[0].headerView,HEADER.WRITE)>sequence);
    tailPool.node.processor.process([],[[left,right]]);pauseTailEnergy+=left.reduce((sum,value)=>sum+value*value,0);
    if(sequence>=20)assert.equal(audio.getStats().activeVoices,0,'drained song does not trigger the future column at frame 19,200');
    audio._monitor();assert.equal(audio.getTick(),paused);
  }
  assert(pauseTailEnergy>0,'actual Rust samples/FDN remain audible after pause');
  assert.equal(tailEnded,0);assert.equal(tailTicks,ticksBefore,'a draining clock never advances the editor cursor');
  assert(audio._tailEndFrame>tailRead*128&&audio._tailEndFrame<=tailRead*128+48000*60);
  audio.stop();assert.equal(audio.getStats().activeVoices,0);assert.equal(Atomics.load(tailPool.control,GLOBAL.MODE),STOPPED);
  tailPool.node.processor.process([],[[left,right]]);assert(left.every(value=>value===0));

  await audio.play(tailSong,{onEnded:()=>tailEnded++});
  assert(Atomics.load(audio._pool.control,GLOBAL.EPOCH)>tailEpoch,'restart hard-cancels the previous tail');
  audio._pool.node.processor.process([],[[left,right]]);audio.stop({tails:true});
  assert.equal(audio.getTick(),0);assert.equal(audio.playing,false);assert.equal(audio._draining,true);
  const stopTailPool=audio._pool,stopTailEpoch=Atomics.load(stopTailPool.control,GLOBAL.EPOCH);
  await until(()=>stopTailPool.workers.every(worker=>worker.messages.some(data=>data.type==='drained'&&data.epoch===stopTailEpoch)));
  let stopEnergy=0;
  for(let i=0;i<16;i++){const sequence=Atomics.load(stopTailPool.control,GLOBAL.READ);await until(()=>Atomics.load(stopTailPool.rings[0].headerView,HEADER.WRITE)>sequence);stopTailPool.node.processor.process([],[[left,right]]);stopEnergy+=left.reduce((sum,value)=>sum+value*value,0);assert.equal(audio.getTick(),0);}
  assert(stopEnergy>0);assert.equal(tailEnded,0);
  const underruns=audio.getStats().underruns,dropped=audio.getStats().droppedVoices;
  const actualClock=audio._playedFrames;audio._playedFrames=()=>audio._tailEndFrame;audio._monitor();audio._playedFrames=actualClock;
  assert.equal(audio._draining,false);assert.equal(audio._timer,null);assert.equal(Atomics.load(stopTailPool.control,GLOBAL.MODE),STOPPED);
  assert.equal(tailEnded,0,'bounded tail completion never fires the song-ended callback');
  audio.stop();audio._destroyPool();assert.equal(audio.getStats().activeVoices,0);
  assert.equal(audio.getStats().underruns,underruns);assert.equal(audio.getStats().droppedVoices,dropped);
});

test('metronome lazily loads only its original local samples and publishes independently of song layers',async()=>{
  const originalFetch=globalThis.fetch,requests=[],messages=[];
  const audio=new WasmAudioEngine({context:{sampleRate:48000,decodeAudioData:async()=>({length:16,numberOfChannels:1,sampleRate:48000,getChannelData:()=>new Float32Array(16).fill(.1)})},assetBase:new URL('https://local.invalid/sub/assets/sounds/')});
  audio.init=async()=>audio;audio._song={timeSignature:3,layers:[{muted:true,volume:0,reverb:100}]};
  audio._pool={control:new Int32Array(new SharedArrayBuffer(64)),workers:[{postMessage:message=>messages.push(message)}]};
  globalThis.fetch=async url=>{requests.push(String(url));return {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)};};
  try{
    await audio.setMetronome(false);assert.equal(requests.length,0);
    await audio.setMetronome(true);await audio.setMetronome(false);await audio.setMetronome(true);
    assert.deepEqual(requests,['https://local.invalid/sub/assets/sounds/UI/metronome.ogg','https://local.invalid/sub/assets/sounds/UI/metronome_click.ogg']);
    assert.equal(messages.at(-1).timeSignature,3);assert.equal(messages.at(-1).samples.length,2);assert.equal(messages.at(-1).enabled,true);
    assert.equal(audio._song.layers[0].muted,true);assert.equal(audio._song.layers[0].volume,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('setMono propagates to main, preview and MIDI output flags without restarting any pool',()=>{
  const audio=new WasmAudioEngine(),controls=Array.from({length:3},()=>new Int32Array(new SharedArrayBuffer(64)));
  for(const control of controls){Atomics.store(control,GLOBAL.EPOCH,7);Atomics.store(control,GLOBAL.READ,91);}
  const pools=controls.map(control=>({control}));audio._pool=pools[0];audio._previewEngine={_pool:pools[1]};audio._liveEngine={_pool:pools[2]};
  for(const enabled of [true,false,true]){
    assert.equal(audio.setMono(enabled),enabled);
    for(const control of controls){assert.equal(Atomics.load(control,GLOBAL.MONO),Number(enabled));assert.equal(Atomics.load(control,GLOBAL.EPOCH),7);assert.equal(Atomics.load(control,GLOBAL.READ),91);}
    assert.equal(audio._pool,pools[0]);assert.equal(audio._previewEngine._pool,pools[1]);assert.equal(audio._liveEngine._pool,pools[2]);
  }
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

async function editableCustomPool(t) {
  const old = Object.fromEntries(['Worker', 'AudioWorkletNode', 'isSecureContext', 'crossOriginIsolated'].map(key => [key, globalThis[key]]));
  class BrowserWorker {
    constructor() {
      this.sent = []; this.received = []; this.heldAcks = []; this.heldEventAcks = []; this.holdSampleAcks = false; this.holdEventAcks = false;
      this.inner = new Worker(new URL('./dsp-worker-adapter.mjs', import.meta.url));
      this.inner.on('message', data => { this.received.push(data); if (data.type === 'sampleLoaded' && this.holdSampleAcks) this.heldAcks.push(data); else if (data.type === 'eventsApplied' && this.holdEventAcks) this.heldEventAcks.push(data); else this.onmessage?.({data}); });
      this.inner.on('error', error => this.onerror?.({message: error.message}));
    }
    postMessage(data) { this.sent.push(data); this.inner.postMessage(data); }
    releaseSampleAcks(reverse = false) { const acks = this.heldAcks.splice(0); if (reverse) acks.reverse(); for (const data of acks) this.onmessage?.({data}); }
    releaseEventAcks() { for (const data of this.heldEventAcks.splice(0)) this.onmessage?.({data}); }
    terminate() { return this.inner.terminate(); }
  }
  class WorkletNode {
    constructor(_context, _name, options) { this.processor = new NBSOutputProcessor(options); }
    connect() {} disconnect() {}
  }
  globalThis.Worker = BrowserWorker; globalThis.AudioWorkletNode = WorkletNode; globalThis.isSecureContext = true; globalThis.crossOriginIsolated = true;
  const constant = (value, length = 1024) => { const pcm = new Float32Array(length).fill(value); return {length, numberOfChannels: 1, sampleRate: 48000, duration: length / 48000, getChannelData: () => pcm}; };
  let decoded = constant(.1, 1024 * 1024);
  const context = {sampleRate: 48000, state: 'running', destination: {}, audioWorklet: {addModule: async () => {}},
    createGain: () => ({gain: {value: 1, setTargetAtTime(value) { this.value = value; }}, connect() {}}), decodeAudioData: async () => decoded};
  const audio = new WasmAudioEngine({context, workers: 2, blockFrames: 128, leadBlocks: 6});
  audio._modulePromise = WebAssembly.compile(await readFile(new URL('../wasm/nbs_dsp.wasm', import.meta.url)));
  const builtin = constant(.02); for (let id = 0; id < 16; id++) audio.buffers.set(id, builtin);
  for (const file of BUNDLED_CUSTOM_SOUNDS) audio.bundledCustomSamples.set(file, builtin);
  t.after(() => { audio.stop(); audio._destroyPool(); audio._previewEngine?._destroyPool(); audio._liveEngine?._destroyPool(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  // Loading before the main pool exists must not preload unused definitions.
  await audio.setCustomSample(16, new ArrayBuffer(1)); audio.customSamples.set(1, builtin);
  const song = {tempo: 10, length: 20, loop: false, customInstruments: [{name: 'ready', file: 'ready.wav', key: 45}, {name: 'unused', file: 'unused.wav', key: 45}],
    layers: Array.from({length: 8}, (_, id) => ({id, volume: 50, pan: 0, reverb: 50})),
    notes: Array.from({length: 8}, (_, layer) => ({id: `base-${layer}`, tick: 0, layer, key: 45, instrument: 0, velocity: 100, pan: 0, pitch: 0}))};
  await audio.play(song, {stress: true});
  const left = new Float32Array(128), right = new Float32Array(128);
  const consume = async blocks => { for (let i = 0; i < blocks; i++) { const sequence = Atomics.load(audio._pool.control, GLOBAL.READ); await until(() => audio._pool.rings.every(ring => Atomics.load(ring.headerView, HEADER.WRITE) > sequence)); audio._pool.node.processor.process([], [[left, right]]); } };
  await consume(1);
  return {audio, song, constant, consume, left, right, decodeAs: value => { decoded = value; }};
}

test('first live custom use queues only needed PCM before every worker event edit and preserves voices/reverb', async t => {
  const {audio, song, consume, decodeAs, constant} = await editableCustomPool(t), pool = audio._pool;
  const epoch = Atomics.load(pool.control, GLOBAL.EPOCH), workers = [...pool.workers], reverbBytes = audio.getStats().reverbStateBytes;
  for (const worker of workers) { assert.equal(worker.sent.find(message => message.type === 'init').samples.some(sample => sample.id >= 16), false); worker.holdSampleAcks = true; }
  assert.equal(audio.getStats().activeVoices, 8);
  song.notes.push({id: 'first-custom', tick: 1, layer: 0, key: 45, instrument: 16, velocity: 100, pan: 0, pitch: 0});
  assert.equal(audio.updateSong(song), true); const firstRevision = audio.getEventUpdateStatus().revision;
  song.notes.at(-1).key = 47; assert.equal(audio.updateSong(song), true); const latestRevision = audio.getEventUpdateStatus().revision;
  await until(() => audio.getEventUpdateStatus(latestRevision).applied);
  for (const worker of workers) {
    const uploads = worker.sent.filter(message => message.type === 'sample');
    assert.deepEqual(uploads.map(message => message.id), [16], 'rapid edits queue only one needed sample, not the unused definitions');
    assert(worker.sent.indexOf(uploads[0]) < worker.sent.findIndex(message => message.type === 'events' && message.revision === firstRevision));
    assert.equal(worker.received.filter(message => message.type === 'sampleLoaded').length, 1);
    assert(worker.received.find(message => message.type === 'sampleLoaded').testMemoryBytes > worker.received.find(message => message.type === 'ready').testMemoryBytes, 'the PCM upload actually grows this worker heap');
  }
  assert.equal(pool.sampleRequests.size, 1, 'worker FIFO orders processing before the delayed host sample ACK');
  await consume(42);
  assert.equal(audio.getStats().activeVoices, 9, 'the new sample starts even after the large upload grows the WASM heaps');
  assert.equal(audio.getStats().droppedVoices, 0); assert.equal(audio._pool, pool); assert.deepEqual(pool.workers, workers);
  assert.equal(Atomics.load(pool.control, GLOBAL.EPOCH), epoch); assert.equal(audio.getStats().reverbStateBytes, reverbBytes); assert.equal(audio.getStats().verifiedReverbTracks, 8);
  // A reload followed by an edit must use the replacement already in the FIFO.
  decodeAs(constant(.2)); const reloaded = audio.setCustomSample(16, new ArrayBuffer(2));
  await until(() => workers.every(worker => worker.sent.filter(message => message.type === 'sample' && message.id === 16).length === 2));
  song.notes.at(-1).velocity = 80; audio.updateSong(song); const reloadRevision = audio.getEventUpdateStatus().revision;
  await until(() => audio.getEventUpdateStatus(reloadRevision).applied);
  for (const worker of workers) assert.equal(worker.sent.filter(message => message.type === 'sample' && message.id === 16).length, 2);
  workers.forEach(worker => worker.releaseSampleAcks(true)); await reloaded; assert.equal(pool.sampleRequests.size, 0);
  audio.updateSong(song); const afterReloadRevision = audio.getEventUpdateStatus().revision;
  await until(() => audio.getEventUpdateStatus(afterReloadRevision).applied);
  for (const worker of workers) assert.equal(worker.sent.filter(message => message.type === 'sample' && message.id === 16).length, 2, 'late ACKs from the old PCM cannot overwrite the queued replacement identity');
  // Internal ID 270 remains valid and receives the documented harp fallback.
  song.notes.push({id: 'fallback', tick: 2, layer: 4, key: 45, instrument: 270, velocity: 100, pan: 0, pitch: 0});
  audio.updateSong(song); const fallbackRevision = audio.getEventUpdateStatus().revision;
  await until(() => audio.getEventUpdateStatus(fallbackRevision).applied); await consume(40);
  assert.equal(audio.getStats().activeVoices, 10); assert.equal(audio.getStats().droppedVoices, 0); assert(audio.warnings.some(warning => warning.includes('暂用竖琴')));
  for (const worker of workers) assert.deepEqual(worker.sent.filter(message => message.type === 'sample').map(message => message.id), [16, 16, 270]);
  workers.forEach(worker => worker.releaseSampleAcks());
});

test('held sample ACKs cannot publish a cancelled edit into a replacement song or destroyed pool', async t => {
  const {audio, song} = await editableCustomPool(t), oldPool = audio._pool;
  oldPool.workers.forEach(worker => { worker.holdSampleAcks = true; worker.holdEventAcks = true; });
  song.notes.push({id: 'cancelled-custom', tick: 1, layer: 0, key: 45, instrument: 16, velocity: 100, pan: 0, pitch: 0});
  audio.updateSong(song); const revision = audio.getEventUpdateStatus().revision;
  await until(() => oldPool.workers.every(worker => worker.heldAcks.length === 1));
  audio.stop(); assert.equal(audio.getEventUpdateStatus(revision).cancelled, true);
  const replacement = {...song, customInstruments: [], notes: song.notes.filter(note => note.instrument < 16)};
  await audio.play(replacement, {stress: true}); const newPool = audio._pool;
  assert.notEqual(newPool, oldPool); assert.equal(oldPool.destroyed, true); assert.equal(oldPool.sampleRequests.size, 0);
  const sentCounts = newPool.workers.map(worker => worker.sent.length);
  oldPool.workers.forEach(worker => { worker.releaseSampleAcks(); worker.releaseEventAcks(); }); await wait(5);
  assert.deepEqual(newPool.workers.map(worker => worker.sent.length), sentCounts, 'no async ACK continuation sends stale events');
  assert.equal(audio._song, replacement); assert.equal(audio.playing, true); assert.equal(audio._runtimeError, null);
  assert(newPool.workers.every(worker => !worker.sent.some(message => message.type === 'events')));
});

test('a failed live PCM message stops the pool and cancels confirmations without publishing dependent events', async t => {
  const {audio, song} = await editableCustomPool(t), pool = audio._pool, errors = [];
  const worker = pool.workers[1], originalPost = worker.postMessage.bind(worker), failure = new Error('sample transport failed');
  worker.postMessage = message => { if (message.type === 'sample') throw failure; originalPost(message); };
  audio._onError = error => errors.push(error);
  song.notes.push({id: 'failed-custom', tick: 1, layer: 0, key: 45, instrument: 16, velocity: 100, pan: 0, pitch: 0});
  assert.throws(() => audio.updateSong(song), error => error === failure);
  await wait(5);
  assert.equal(audio.playing, false); assert.equal(pool.failed, true); assert.equal(pool.key, null); assert.equal(pool.sampleRequests.size, 0);
  assert.deepEqual(errors, [failure]); assert(pool.workers.every(item => !item.sent.some(message => message.type === 'events')));
  const replacement = {...song, customInstruments: [], notes: song.notes.filter(note => note.instrument < 16)};
  await audio.play(replacement, {stress: true});
  assert.notEqual(audio._pool, pool); assert.equal(audio.playing, true); assert.equal(audio._runtimeError, null);
});
