import {GLOBAL, HEADER, STOPPED, PREROLL, RUNNING, PARAM_STRIDE, TIMING_SLOTS, EventTimeline, MetronomeTimeline, refillRing} from './dsp-protocol.js';

let api, handle = 0, ring, header, stamps, pcm, params, paramBits, parameterCopy, parameterBits, timings, control;
let blockFrames = 256, leadBlocks = 3, tracks = 0, epoch = -1, nextSequence = 0, timeline, stress = false;
let active = false, draining = false, scheduled = false, lastRevision = -1, outputBuffer, outputPointer = -1, outputLeft, outputRight;
let metronomeHandle = 0, metronomeEnabled = false, metronomeTimeline, metronomeSignature = 4, outputSampleRate = 48000;
let clickBuffer, clickPointerCache = -1, clickLeft, clickRight;
const channel = new MessageChannel();
channel.port1.onmessage = () => { scheduled = false; pump(); };
const kick = () => { if (!scheduled && active) { scheduled = true; channel.port2.postMessage(0); } };
const fail = error => { active = false; self.postMessage({type: 'error', message: error?.message || String(error)}); };

function setMetronome(data, frame) {
  metronomeEnabled = !!data?.enabled && !draining;
  metronomeSignature = Math.max(1, Math.min(16, Number(data?.timeSignature) || 4));
  if (metronomeEnabled && !metronomeHandle) {
    metronomeHandle = api.engine_create(1, outputSampleRate, blockFrames, 128);
    if (!metronomeHandle) throw new Error('无法分配 Rust 节拍器。');
    api.track(metronomeHandle, 0, 1, 0, 0, 1);
    for (const sample of data.samples || []) {
      const input = new Float32Array(sample.pcm), pointer = api.sample_alloc(metronomeHandle, sample.id, input.length);
      if (!pointer) throw new Error('无法加载 Rust 节拍器音色。');
      new Float32Array(api.memory.buffer, pointer, input.length).set(input);
    }
  }
  metronomeTimeline = metronomeEnabled && timeline ? new MetronomeTimeline(timeline.config, frame) : null;
}

function applyParameters() {
  const revision = Atomics.load(header, HEADER.PARAM_REV);
  if (revision === lastRevision || revision & 1) return;
  for (let i = 0; i < paramBits.length; i++) parameterBits[i] = Atomics.load(paramBits, i);
  if (revision !== Atomics.load(header, HEADER.PARAM_REV)) return;
  let reverbTracks=0;
  for (let track = 0; track < tracks; track++) {
    const p = track * PARAM_STRIDE;
    if (!api.track(handle, track, parameterCopy[p], parameterCopy[p + 1], parameterCopy[p + 2], parameterCopy[p + 3] > .5 ? 1 : 0)) throw new Error(`Rust track 参数更新失败：${track}`);
    if(parameterCopy[p+2]>0&&parameterCopy[p+3]>.5)reverbTracks++;
  }
  Atomics.store(header,HEADER.REVERB_TRACKS,reverbTracks);
  Atomics.store(header,HEADER.REVERB_BYTES,api.reverb_bytes?.(handle)||0);
  lastRevision = revision;
  Atomics.store(header, HEADER.APPLIED_SEQ, nextSequence);
  Atomics.store(header, HEADER.APPLIED_REV, revision);
  self.postMessage({type: 'paramsApplied', revision, sequence: nextSequence});
}

function renderOne(publish = true) {
  const started = performance.now();
  applyParameters();
  const frame = nextSequence * blockFrames;
  timeline.dispatch(frame, blockFrames, (event, offset) => api.voice(handle, event.track, event.sample, event.rate, event.gain, event.pan, offset, stress ? 1 : 0));
  const ptr = api.render(handle);
  if (!ptr) throw new Error('Rust render 返回空指针。');
  if (outputBuffer !== api.memory.buffer || outputPointer !== ptr) {
    outputBuffer = api.memory.buffer; outputPointer = ptr;
    outputLeft = new Float32Array(outputBuffer, ptr, blockFrames);
    outputRight = new Float32Array(outputBuffer, ptr + blockFrames * 4, blockFrames);
  }
  let clicksLeft, clicksRight;
  if (metronomeHandle && (metronomeEnabled || api.active_voices(metronomeHandle))) {
    if (metronomeEnabled) metronomeTimeline?.dispatch(frame, blockFrames, (tick, offset) => {
      api.voice(metronomeHandle, 0, tick % (4 * metronomeSignature) === 0 ? 1 : 0, 1, 1, 0, offset, 0);
    });
    const clickPointer = api.render(metronomeHandle);
    if (clickBuffer !== api.memory.buffer || clickPointerCache !== clickPointer) {
      clickBuffer = api.memory.buffer; clickPointerCache = clickPointer;
      clickLeft = new Float32Array(clickBuffer, clickPointer, blockFrames);
      clickRight = new Float32Array(clickBuffer, clickPointer + blockFrames * 4, blockFrames);
    }
    clicksLeft = clickLeft; clicksRight = clickRight;
  }
  if (publish && epoch === Atomics.load(control, GLOBAL.EPOCH) && Atomics.load(control, GLOBAL.MODE) !== STOPPED) {
    const slot = nextSequence % ring.slots, base = slot * blockFrames * 2;
    pcm.set(outputLeft, base); pcm.set(outputRight, base + blockFrames);
    if (clicksLeft) for (let i = 0; i < blockFrames; i++) { pcm[base + i] += clicksLeft[i]; pcm[base + blockFrames + i] += clicksRight[i]; }
    Atomics.store(stamps, slot, nextSequence + 1);
    Atomics.store(header, HEADER.WRITE, nextSequence + 1);
  }
  nextSequence++;
  const micros = Math.max(1, Math.round((performance.now() - started) * 1000));
  Atomics.store(header, HEADER.ACTIVE, api.active_voices(handle));
  Atomics.store(header, HEADER.DROPPED, api.dropped_voices?.(handle) || 0);
  Atomics.store(header, HEADER.PEAK_MILLI, Math.round((api.peak?.(handle) || 0) * 1000));
  Atomics.store(header, HEADER.MAX_US, Math.max(Atomics.load(header, HEADER.MAX_US), micros));
  Atomics.add(header, HEADER.TOTAL_US, micros); Atomics.add(header, HEADER.BLOCKS, 1);
  const count = Atomics.load(header, HEADER.TIMING_COUNT);
  timings[count % TIMING_SLOTS] = micros / 1000;
  Atomics.store(header, HEADER.TIMING_COUNT, count + 1);
  Atomics.store(header, HEADER.RENDER_SEQ, nextSequence);
}

function pump() {
  if (!active || !timeline) return;
  try {
    if (epoch !== Atomics.load(control, GLOBAL.EPOCH) || Atomics.load(control, GLOBAL.MODE) === STOPPED) { active = false; return; }
    refillRing(() => Atomics.load(control, GLOBAL.READ), () => nextSequence, leadBlocks, publish => {
      if (epoch !== Atomics.load(control, GLOBAL.EPOCH) || Atomics.load(control, GLOBAL.MODE) === STOPPED) { active = false; return; }
      renderOne(publish);
    });
    if (!active) return;
    if (nextSequence - Atomics.load(control, GLOBAL.READ) < leadBlocks) { kick(); return; }
    if (Atomics.load(control, GLOBAL.MODE) === PREROLL) return;
    const wake = Atomics.load(header, HEADER.WAKE);
    Atomics.wait(header, HEADER.WAKE, wake, 2);
    // A pure MessageChannel self-chain can starve incoming port messages.
    // Alternate a timer task only while full; the actual render runs in the
    // MessageChannel task, so timers are not recursively nested/clamped.
    setTimeout(kick, 0);
  } catch (error) { fail(error); }
}

self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') {
      const instance = new WebAssembly.Instance(data.module, {}), exports = instance.exports;
      api = {memory: exports.memory, engine_create: exports.engine_create, engine_destroy: exports.engine_destroy};
      for (const name of ['sample_alloc', 'track', 'voice', 'render', 'reset', 'active_voices', 'dropped_voices', 'peak', 'wasm_simd', 'reverb_bytes']) api[name] = exports[`engine_${name}`] || exports[name];
      for (const name of ['engine_create', 'engine_destroy', 'sample_alloc', 'track', 'voice', 'render', 'reset', 'active_voices']) if (typeof api[name] !== 'function') throw new Error(`WASM 缺少导出：${name}`);
      blockFrames = data.blockFrames; leadBlocks = data.leadBlocks; tracks = data.tracks; outputSampleRate = data.sampleRate;
      ring = data.ring; header = new Int32Array(ring.header); stamps = new Int32Array(ring.stamps); pcm = new Float32Array(ring.pcm);
      params = new Float32Array(ring.params); paramBits = new Int32Array(ring.params);
      parameterCopy = new Float32Array(params.length); parameterBits = new Int32Array(parameterCopy.buffer);
      timings = new Float32Array(ring.timings); control = new Int32Array(data.global);
      handle = api.engine_create(tracks, data.sampleRate, blockFrames, tracks * data.voicesPerTrack);
      if (!handle) throw new Error('Rust 音频状态分配失败，请减少轨道或声部数量。');
      for (const sample of data.samples) {
        const input = new Float32Array(sample.pcm);
        const ptr = api.sample_alloc(handle, sample.id, input.length);
        if (!ptr) throw new Error(`Rust 音色 ${sample.id} 分配失败。`);
        new Float32Array(api.memory.buffer, ptr, input.length).set(input);
      }
      self.postMessage({type: 'ready', simd: !!api.wasm_simd?.()});
    } else if (data.type === 'prepare') {
      active = false; draining = false; api.reset(handle); epoch = data.epoch; nextSequence = 0;
      timeline = new EventTimeline(data.events, data.transport); stress = !!data.stress; lastRevision = -1;
      if (metronomeHandle) api.reset(metronomeHandle);
      setMetronome(data.metronome, 0);
      const revision = Atomics.load(header, HEADER.PARAM_REV);
      header.fill(0); Atomics.store(header, HEADER.PARAM_REV, revision);
      stamps.fill(0); timings.fill(0); outputBuffer = null; outputPointer = -1;
      active = true; self.postMessage({type: 'prepared', epoch}); kick();
    } else if (data.type === 'resume') { active = true; kick(); }
    else if (data.type === 'events') { if (data.epoch === epoch && !draining) {
      if (data.transport) { timeline = new EventTimeline(data.events, data.transport); if (metronomeEnabled) metronomeTimeline = new MetronomeTimeline(data.transport, nextSequence * blockFrames); }
      else timeline.replace(data.events, nextSequence * blockFrames);
      if (data.timeSignature !== undefined) metronomeSignature = Math.max(1, Math.min(16, Number(data.timeSignature) || 4));
      if(Number.isSafeInteger(data.revision)&&data.revision>0)self.postMessage({type:'eventsApplied',epoch,revision:data.revision,sequence:nextSequence,eventCount:data.events.length});
    } }
    else if (data.type === 'metronome') { if (data.epoch === epoch) {
      setMetronome(data, nextSequence * blockFrames);
      self.postMessage({type: 'metronomeApplied', enabled: metronomeEnabled, sequence: nextSequence});
    } }
    else if (data.type === 'drain') { if (data.epoch === epoch && active) {
      draining = true;
      timeline.replace([], nextSequence * blockFrames);
      metronomeEnabled = false; metronomeTimeline = null;
      self.postMessage({type: 'drained', epoch, sequence: nextSequence}); kick();
    } }
    else if (data.type === 'stop') active = false;
    else if (data.type === 'trigger') {
      const event = data.event;
      const valid = active && !draining && data.epoch === epoch && Atomics.load(control, GLOBAL.MODE) !== STOPPED && event && Number.isInteger(event.track) && event.track >= 0 && event.track < tracks && Number.isInteger(event.sample) && event.sample >= 0 && event.sample <= 270 && Number.isFinite(event.rate) && event.rate > 0 && Number.isFinite(event.gain) && event.gain >= 0 && event.gain <= 1 && Number.isFinite(event.pan) && event.pan >= -1 && event.pan <= 1;
      if (!valid) { self.postMessage({type: 'triggered', request: data.request, accepted: false, error: '实时试听事件无效或播放池已停止。'}); return; }
      applyParameters();
      const accepted = api.voice(handle, event.track, event.sample, event.rate, event.gain, event.pan, 0, 0);
      self.postMessage({type: 'triggered', request: data.request, accepted: !!accepted, activeVoices: api.active_voices(handle)});
      kick();
    }
    else if (data.type === 'sample') {
      const input = new Float32Array(data.pcm), pointer = api.sample_alloc(handle, data.id, input.length);
      if (!pointer) throw new Error(`音色 ${data.id} 更新失败。`);
      new Float32Array(api.memory.buffer, pointer, input.length).set(input);
      self.postMessage({type: 'sampleLoaded', request: data.request});
    }
    else if (data.type === 'clearStats') {
      for (const index of [HEADER.DROPPED, HEADER.MAX_US, HEADER.TOTAL_US, HEADER.BLOCKS, HEADER.TIMING_COUNT, HEADER.UNDERRUNS]) Atomics.store(header, index, 0);
      timings.fill(0);
    } else if (data.type === 'destroy') { active = false; if (handle) api.engine_destroy(handle); if (metronomeHandle) api.engine_destroy(metronomeHandle); handle = 0; metronomeHandle = 0; self.close(); }
  } catch (error) { fail(error); }
};
