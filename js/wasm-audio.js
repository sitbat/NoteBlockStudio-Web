import {AudioEngine, INSTRUMENTS, sampleRateForNote} from './audio.js';
import {assertRealtimeEnvironment} from './browser-environment.js';
import {GLOBAL, HEADER, STOPPED, PREROLL, RUNNING, PARAM_STRIDE, TIMING_SLOTS, createRing, shardRanges, transportConfig, tickAtFrame, tickFrameOffset, completedLoopsAtFrame, rainbowAtFrame} from './dsp-protocol.js';
import {controlType} from './tempo-map.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const floatBits = new Float32Array(1), intBits = new Int32Array(floatBits.buffer);
const bitsOf = value => { floatBits[0] = value; return intBits[0]; };
const bufferIds = new WeakMap(); let nextBufferId = 1;
function idOf(buffer) { if (!bufferIds.has(buffer)) bufferIds.set(buffer, nextBufferId++); return bufferIds.get(buffer); }

/** Rust SIMD in private worker heaps; the only real-time JS DSP is the final sum. */
export class WasmAudioEngine extends AudioEngine {
  constructor(options = {}) {
    super(options);
    this.config = {workers: 14, blockFrames: 256, leadBlocks: 6, voicesPerTrack: 4};
    this.configure(options);
    this.wasmURL = options.wasmURL || new URL('../wasm/nbs_dsp.wasm', import.meta.url);
    this._pool = null; this._poolPromise = null; this._pcmCache = new WeakMap();
    this._lastStats = null; this._transport = null; this._benchmarking = false;
    this._recordedMonitors = new Map(); this._songRevision = 0;
  }

  async init() {
    if (!this.context) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio。');
      this.context = new AudioContextClass({sampleRate: 48000, latencyHint: 'interactive'});
    }
    return super.init();
  }

  async preview(note, layer = {}, masterVolume = this.volume) {
    return this.previewNotes([{...note, layer: 0}], [{...layer, muted: false, solo: false}], masterVolume);
  }

  /** Audition an entire column/chord in one Rust play call, preserving each layer's mix. */
  async previewNotes(notes, layers = this._song?.layers || [], masterVolume = this.volume) {
    if (!Array.isArray(notes) || notes.length > 1000000) throw new Error('试听音符数量无效。');
    const request = this._previewRequest = (this._previewRequest || 0) + 1;
    const definitions = this.customInstruments ?? this._song?.customInstruments ?? [], solo = layers.some(layer => layer.solo);
    const compact = new Map(), previewLayers = [], previewNotes = [];
    for (const note of notes) {
      const source = Math.max(0, Math.trunc(Number(note.layer) || 0)), layer = layers[source] || {};
      if (layer.muted || solo && !layer.solo || controlType(note, {customInstruments: definitions})) continue;
      if (!compact.has(source)) { compact.set(source, previewLayers.length); previewLayers.push({...layer, id: previewLayers.length, muted: false, solo: false}); }
      previewNotes.push({...note, layer: compact.get(source), tick: 0});
    }
    if (!previewNotes.length) return this.warnings;
    const run = async () => {
      if (request !== this._previewRequest) return this.warnings;
      await this.init();
      if (request !== this._previewRequest) return this.warnings;
      const config = {workers: previewLayers.length > 64 ? this.config.workers : 1,
        blockFrames: previewLayers.length > 64 ? this.config.blockFrames : 128, leadBlocks: this.config.leadBlocks, voicesPerTrack: 16};
      if (!this._previewEngine) {
        this._previewEngine = new WasmAudioEngine({context: this.context, ...config});
        this._previewEngine.buffers = this.buffers; this._previewEngine.bundledCustomSamples = this.bundledCustomSamples;
        this._previewEngine._pcmCache = this._pcmCache;
      }
      const preview = this._previewEngine;
      if (Object.entries(config).some(([key, value]) => preview.config[key] !== value)) { preview.stop(); preview.configure(config); }
      preview.customSamples = this.customSamples;
      preview._modulePromise = this._modulePromise || preview._modulePromise;
      preview._workletPromise = this._workletPromise || preview._workletPromise;
      const song = {tempo: 10, length: 1, loop: false, customInstruments: definitions,
        layers: previewLayers, notes: previewNotes};
      await preview.play(song, {masterVolume, mono: !!this._mono});
      this._modulePromise = preview._modulePromise; this._workletPromise = preview._workletPromise;
      for (const warning of preview.warnings) if (!this.warnings.includes(warning)) this.warnings.push(warning);
      return this.warnings;
    };
    const pending = (this._previewChain || Promise.resolve()).catch(() => {}).then(run);
    this._previewChain = pending;
    return pending;
  }

  async _loadMetronome() {
    await this.init();
    if (!this._metronomePromise) this._metronomePromise = Promise.all(['metronome.ogg', 'metronome_click.ogg'].map(async (file, id) => {
      if (this.buffers.has(271 + id)) return;
      const response = await fetch(new URL(`UI/${file}`, this.assetBase));
      if (!response.ok) throw new Error(`无法加载节拍器音色 ${file}。`);
      this.buffers.set(271 + id, await this.context.decodeAudioData(await response.arrayBuffer()));
    })).catch(error => { this._metronomePromise = null; throw error; });
    await this._metronomePromise;
  }

  _metronomeMessage(enabled = this._metronome) {
    const ready = !!enabled && this.buffers.has(271) && this.buffers.has(272);
    return {enabled: ready, timeSignature: Math.max(1, Math.min(16, Number(this._song?.timeSignature) || 4)),
      samples: ready ? [271, 272].map((id, index) => ({id: index, pcm: this._monoPCM(this.buffers.get(id)).buffer})) : []};
  }

  async setMetronome(enabled) {
    this._metronome = !!enabled;
    if (enabled) await this._loadMetronome();
    const pool = this._pool;
    if (pool && !pool.destroyed) pool.workers[0].postMessage({type: 'metronome', epoch: Atomics.load(pool.control, GLOBAL.EPOCH), ...this._metronomeMessage(this._metronome)});
    return this._metronome;
  }

  setVolume(value) {
    super.setVolume(value);
    this._liveEngine?.setVolume(this.volume);
  }

  /** A final stereo-output downmix; changing it never resets transport or Rust state. */
  setMono(enabled) {
    this._mono = !!enabled;
    for (const engine of [this, this._previewEngine, this._liveEngine]) if (engine) {
      engine._mono = this._mono;
      if (engine._pool && !engine._pool.destroyed) Atomics.store(engine._pool.control, GLOBAL.MONO, this._mono ? 1 : 0);
    }
    return this._mono;
  }

  async _ensureLive() {
    if (this._livePromise) return this._livePromise;
    const session = this._liveSession || 0;
    const pending = (async () => {
      await this.init();
      if (session !== (this._liveSession || 0)) throw new DOMException('实时试听已停止。', 'AbortError');
      if (!this._liveEngine) {
        const live = new WasmAudioEngine({context: this.context, workers: 1, blockFrames: this.config.blockFrames, leadBlocks: this.config.leadBlocks, voicesPerTrack: 64});
        live.buffers = this.buffers; live.bundledCustomSamples = this.bundledCustomSamples; live._pcmCache = this._pcmCache;
        live._modulePromise = this._modulePromise; live._workletPromise = this._workletPromise;
        this._liveEngine = live;
      }
      const live = this._liveEngine;
      live.customSamples = this.customSamples;
      const definitions = this.customInstruments ?? this._song?.customInstruments ?? [];
      const oldSong = live._song;
      const song = {tempo: 10, length: 999999, loop: false, _sampleAllCustom: true, customInstruments: definitions,
        layers: oldSong?.layers || Array.from({length: 16}, (_, id) => ({id, volume: 100, pan: 0, reverb: 0, muted: false, solo: false})), notes: []};
      const bank = live._samplesFor(song);
      const key = `${16}/${this.context.sampleRate}/${JSON.stringify(live.config)}/${bank.signature}`;
      if (!live.playing || live._pool?.key !== key) await live.play(song, {masterVolume: this.volume, mono: !!this._mono});
      else { live._song = song; live.customInstruments = definitions; }
      if (session !== (this._liveSession || 0) || !live.playing) throw new DOMException('实时试听已停止。', 'AbortError');
      this._modulePromise = live._modulePromise; this._workletPromise = live._workletPromise;
      for (const warning of live.warnings) if (!this.warnings.includes(warning)) this.warnings.push(warning);
      return live;
    })();
    this._livePromise = pending;
    try { return await pending; } finally { if (this._livePromise === pending) this._livePromise = null; }
  }

  /** Polyphonic MIDI monitoring has its own persistent Rust voices and per-channel reverb states. */
  async triggerLive(note, {channel = 0, layer = {}} = {}) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) throw new Error('MIDI 通道必须在 0–15 之间。');
    if (!note || !Number.isInteger(Number(note.key)) || Number(note.key) < 0 || Number(note.key) > 87) throw new Error('实时试听音高必须在 0–87 之间。');
    const instrument = Number(note.instrument ?? 0), velocity = Number(note.velocity ?? 100), pan = Number(note.pan ?? 0), pitch = Number(note.pitch ?? 0);
    if (!Number.isInteger(instrument) || instrument < 0 || instrument > 270 || !Number.isFinite(velocity) || velocity < 0 || velocity > 100 || !Number.isFinite(pan) || pan < -100 || pan > 100 || !Number.isFinite(pitch) || pitch < -32768 || pitch > 32767) throw new Error('实时试听的乐器、力度、声像或微调音高无效。');
    const definitions = this.customInstruments ?? this._song?.customInstruments ?? [];
    if (controlType(note, {customInstruments: definitions})) return {accepted: false, activeVoices: 0, control: true};
    const session = this._liveSession || 0, live = await this._ensureLive();
    if (session !== (this._liveSession || 0)) throw new DOMException('实时试听已停止。', 'AbortError');
    if (instrument >= 16 + live._song.customInstruments.length) throw new Error('实时试听引用了未定义的自定义乐器。');
    const track = live._song.layers[channel];
    Object.assign(track, {volume: layer.volume ?? 100, pan: layer.pan ?? 0, reverb: layer.reverb ?? 0, muted: !!layer.muted, solo: false});
    live.updateTrackParams(live._song);
    const rate = sampleRateForNote({...note, pitch}, instrument >= 16 ? live._song.customInstruments[instrument - 16]?.key ?? 45 : 45);
    const pool = live._pool, request = live._liveRequest = (live._liveRequest || 0) + 1;
    pool.triggerRequests ||= new Map();
    if (pool.triggerRequests.size >= 1024) throw new Error('实时 MIDI 试听消息过多，请稍后重试。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pool.triggerRequests.delete(request); reject(new Error('实时 MIDI 试听线程响应超时。')); }, 5000);
      const receive = result => { clearTimeout(timer); pool.triggerRequests.delete(request); result.error ? reject(new Error(result.error)) : resolve({accepted: !!result.accepted, activeVoices: result.activeVoices}); };
      receive.cancel = () => { clearTimeout(timer); pool.triggerRequests.delete(request); reject(new DOMException('实时试听已停止。', 'AbortError')); };
      pool.triggerRequests.set(request, receive);
      pool.workers[0].postMessage({type: 'trigger', request, epoch: Atomics.load(pool.control, GLOBAL.EPOCH), event: {track: channel, sample: instrument, rate, gain: velocity / 100, pan: pan / 100}});
    });
  }

  /** Mark synchronously before publishing the edit, then audition without moving transport. */
  async monitorRecordedNote(note, {layer = {}, id = note?.id} = {}) {
    if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).length || String(id).length > 256) throw new Error('录制监听需要音符的有效唯一 ID。');
    const definitions = this.customInstruments ?? this._song?.customInstruments ?? [];
    if (controlType(note, {customInstruments: definitions})) return {accepted: false, activeVoices: 0, control: true};
    const now = performance.now();
    for (const [key, mark] of this._recordedMonitors) if (mark.expiresAt <= now) this._recordedMonitors.delete(key);
    const key = String(id), previous = this._recordedMonitors.get(key);
    if (!previous && this._recordedMonitors.size >= 4096) throw new Error('录制监听队列已满，请稍后重试。');
    // Pending sample/worker initialization must also suppress the initial timeline onset.
    const mark = {expiresAt: Infinity}; this._recordedMonitors.set(key, mark);
    this._songRevision++;
    if (this.playing && this._song) this.updateSong(this._song);
    try {
      const result = await this.triggerLive(note, {channel: note.channel ?? 0, layer});
      if (this._recordedMonitors.get(key) === mark) {
        if (result.accepted) mark.expiresAt = performance.now() + 1000;
        else if (previous) this._recordedMonitors.set(key, previous);
        else this._recordedMonitors.delete(key);
        this._songRevision++;
        if (this.playing && this._song) this.updateSong(this._song);
      }
      return result;
    } catch (error) {
      if (this._recordedMonitors.get(key) === mark) {
        if (previous) this._recordedMonitors.set(key, previous); else this._recordedMonitors.delete(key);
        this._songRevision++;
        if (this.playing && this._song) this.updateSong(this._song);
      }
      throw error;
    }
  }

  stopLive() {
    this._liveSession = (this._liveSession || 0) + 1;
    const live = this._liveEngine; this._liveEngine = null; this._livePromise = null;
    if (live) { live.stop(); live._destroyPool(); }
  }

  async setCustomSample(index, input, {isCurrent} = {}) {
    const checkCurrent = () => { if (isCurrent && !isCurrent()) throw new DOMException('此音色加载操作已被新的项目或操作替代。', 'AbortError'); };
    await this.init(); checkCurrent();
    const data = input instanceof Blob ? await input.arrayBuffer() : input;
    if (!(data instanceof ArrayBuffer)) throw new TypeError('自定义音色需要 ArrayBuffer 或本地音频文件。');
    const buffer = await this.context.decodeAudioData(data.slice(0));
    checkCurrent();
    const custom = Math.max(0, Math.trunc(Number(index)) - (Number(index) >= 16 ? 16 : 0));
    this.customSamples.set(custom, buffer);
    await this._uploadSample(16 + custom, buffer);
    checkCurrent();
    return buffer;
  }

  _uploadSample(id, buffer) {
    return Promise.all([this._uploadPoolSample(id, buffer), this._liveEngine?._uploadPoolSample(id, buffer), this._previewEngine?._uploadPoolSample(id, buffer)]);
  }

  _uploadPoolSample(id, buffer) {
    const pool = this._pool;
    if (!pool || pool.destroyed) return Promise.resolve();
    const pcm = this._monoPCM(buffer).buffer;
    pool.sampleRequests ||= new Map();
    const request = (this._sampleRequest = (this._sampleRequest || 0) + 1);
    return new Promise((resolve, reject) => {
      const pending = new Set(pool.workers.map((_, index) => index));
      const timeout = setTimeout(() => { pool.sampleRequests.delete(request); reject(new Error('本地音色上传至 Rust 线程超时。')); }, 15000);
      const acknowledge = index => { pending.delete(index); if (!pending.size) { clearTimeout(timeout); pool.sampleRequests.delete(request); pool.key = null; resolve(); } };
      acknowledge.cancel = () => { clearTimeout(timeout); pool.sampleRequests.delete(request); reject(new DOMException('音频池已重建，音色更新已取消。', 'AbortError')); };
      pool.sampleRequests.set(request, acknowledge);
      pool.workers.forEach(worker => worker.postMessage({type: 'sample', id, pcm, request}));
    });
  }

  configure(options = {}) {
    if (this.playing) throw new Error('请先暂停，再修改音频线程和缓冲配置。');
    const next = {...this.config};
    if (options.workers !== undefined) next.workers = Math.round(clamp(options.workers, 1, 32));
    if (options.blockFrames !== undefined) {
      if (![128, 256, 512].includes(Number(options.blockFrames))) throw new Error('音频块长度必须是 128、256 或 512 帧。');
      next.blockFrames = Number(options.blockFrames);
    }
    if (options.leadBlocks !== undefined) next.leadBlocks = Math.round(clamp(options.leadBlocks, 1, 16));
    if (options.voicesPerTrack !== undefined) next.voicesPerTrack = Math.round(clamp(options.voicesPerTrack, 1, 64));
    if (JSON.stringify(next) !== JSON.stringify(this.config)) { if (this._pool) this._halt(false); this._destroyPool(); this.config = next; }
    return {...this.config};
  }

  async _compile() {
    assertRealtimeEnvironment(this.context);
    if (!this._modulePromise) this._modulePromise = (async () => {
      const response = await fetch(this.wasmURL);
      if (!response.ok) throw new Error(`无法加载本地 Rust 核心 nbs_dsp.wasm（${response.status}）。`);
      try { return await WebAssembly.compile(await response.arrayBuffer()); }
      catch (error) { throw new Error(`Rust/WASM 核心编译失败，浏览器可能不支持 SIMD：${error.message}`); }
    })().catch(error => { this._modulePromise = null; throw error; });
    if (!this._workletPromise) this._workletPromise = this.context.audioWorklet.addModule(new URL('./output-worklet.js', import.meta.url)).catch(error => { this._workletPromise = null; throw new Error(`音频输出模块加载失败：${error.message}`); });
    const [module] = await Promise.all([this._modulePromise, this._workletPromise]);
    return module;
  }

  _monoPCM(buffer) {
    let pcm = this._pcmCache.get(buffer);
    if (pcm) return pcm;
    const shared = new SharedArrayBuffer(buffer.length * 4); pcm = new Float32Array(shared);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel), scale = 1 / buffer.numberOfChannels;
      for (let frame = 0; frame < data.length; frame++) if (Number.isFinite(data[frame])) pcm[frame] += data[frame] * scale;
    }
    for (let frame = 0; frame < pcm.length; frame++) if (!Number.isFinite(pcm[frame])) pcm[frame] = 0;
    this._pcmCache.set(buffer, pcm); return pcm;
  }

  _samplesFor(song) {
    const instruments = new Set(INSTRUMENTS.map(instrument => instrument.id));
    if (song._sampleAllCustom) for (let i = 0; i < (song.customInstruments?.length || 0); i++) instruments.add(16 + i);
    for (const note of song.notes || []) instruments.add(Number(note.instrument) || 0);
    const samples = [], signature = [];
    for (const instrument of [...instruments].sort((a, b) => a - b)) {
      if (controlType({instrument}, song)) continue;
      const {buffer} = this._sample({instrument}, song);
      if (!buffer) throw new Error(`音色 ${instrument + 1} 未解码，无法启动 Rust 音频。`);
      samples.push({id: instrument, pcm: this._monoPCM(buffer).buffer});
      signature.push(`${instrument}:${idOf(buffer)}`);
    }
    return {samples, signature: signature.join(',')};
  }

  async _ensurePool(song, {output = true} = {}) {
    const module = await this._compile();
    const tracks = Math.max(1, song.layers?.length || 1);
    if (tracks > 65536) throw new Error('实时引擎最多支持 65536 个轨道。');
    const bank = this._samplesFor(song);
    const key = `${tracks}/${this.context.sampleRate}/${JSON.stringify(this.config)}/${bank.signature}`;
    if (this._pool?.key === key) return this._pool;
    this._destroyPool();
    const ranges = shardRanges(tracks, this.config.workers), global = new SharedArrayBuffer(16 * 4);
    const control = new Int32Array(global), pool = {key, global, control, tracks, ranges, workers: [], rings: [], stats: [], simd: true, destroyed: false};
    this._pool = pool;
    const tasks = ranges.map((range, index) => new Promise((resolve, reject) => {
      const descriptor = createRing(range.tracks, this.config.blockFrames);
      const worker = new Worker(new URL('./dsp-worker.js', import.meta.url), {type: 'module', name: `NBS DSP ${index + 1}`});
      const ring = {...descriptor, headerView: new Int32Array(descriptor.header), paramsView: new Float32Array(descriptor.params), bitsView: new Int32Array(descriptor.params), timesView: new Float32Array(descriptor.timings), last: new Float32Array(range.tracks * PARAM_STRIDE).fill(NaN)};
      pool.rings.push(ring); pool.workers.push(worker);
      let ready = false;
      const timeout = setTimeout(() => reject(new Error(`Rust 音频线程 ${index + 1} 初始化超时。`)), 30000);
      worker.onmessage = ({data}) => {
        if (data.type === 'ready') { ready = true; clearTimeout(timeout); pool.simd &&= data.simd; resolve(); }
        else if (data.type === 'prepared') pool.prepared?.get(index)?.(data.epoch);
        else if (data.type === 'paramsApplied') this._acknowledgeControl(pool, index, data.revision, data.sequence);
        else if (data.type === 'sampleLoaded') pool.sampleRequests?.get(data.request)?.(index);
        else if (data.type === 'triggered') pool.triggerRequests?.get(data.request)?.(data);
        else if (data.type === 'error') {
          const error = new Error(`Rust 音频线程 ${index + 1}：${data.message}`);
          if (!ready) { clearTimeout(timeout); reject(error); }
          this._poolError(pool, error);
        }
      };
      worker.onerror = event => { const error = new Error(`音频 Worker ${index + 1} 失败：${event.message || '未知错误'}`); clearTimeout(timeout); reject(error); this._poolError(pool, error); };
      worker.postMessage({type: 'init', module, global, ring: descriptor, tracks: range.tracks, sampleRate: this.context.sampleRate,
        blockFrames: this.config.blockFrames, leadBlocks: this.config.leadBlocks, voicesPerTrack: this.config.voicesPerTrack, samples: bank.samples});
    }));
    try {
      await Promise.all(tasks);
      if (pool.destroyed) throw new Error('音频初始化已取消。');
      if (output) {
        pool.node = new AudioWorkletNode(this.context, 'nbs-wasm-output', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: {global, rings: pool.rings.map(({header, stamps, pcm, params, timings, slots}) => ({header, stamps, pcm, params, timings, slots})), blockFrames: this.config.blockFrames}});
        pool.node.onprocessorerror = () => this._poolError(pool, new Error('AudioWorklet 输出处理器发生错误，播放已停止。'));
        pool.node.connect(this.masterGain);
      }
      return pool;
    } catch (error) { if (this._pool === pool) this._destroyPool(); throw error; }
  }

  _poolError(pool, error) {
    if (pool !== this._pool || pool.destroyed) return;
    this._runtimeError = error; this.warnings.push(error.message);
    this._halt(false); this._onError?.(error);
  }

  _eventsFor(song, pool) {
    const events = pool.ranges.map(() => []);
    const now = performance.now(), frame = this.playing ? this._playedFrames() : 0, sampleRate = this.context?.sampleRate || 48000;
    for (const [id, mark] of this._recordedMonitors) if (mark.expiresAt <= now) this._recordedMonitors.delete(id);
    for (const note of song.notes || []) {
      if (controlType(note, song)) continue;
      const layer = Math.trunc(Number(note.layer));
      if (!Number.isInteger(layer) || layer < 0 || layer >= pool.tracks) continue;
      let shard = 0; while (layer >= pool.ranges[shard].end) shard++;
      const instrument = Math.max(0, Math.trunc(Number(note.instrument) || 0));
      const definition = instrument >= 16 ? song.customInstruments?.[instrument - 16] : null;
      const key = definition?.key ?? 45;
      const rate = sampleRateForNote(note, key);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('音符播放速率无效。');
      const mark = this._recordedMonitors.get(String(note.id));
      events[shard].push({tick: Math.max(0, Number(note.tick) || 0), track: layer - pool.ranges[shard].start, sample: instrument,
        rate, gain: clamp(note.velocity ?? 100, 0, 100) / 100, pan: clamp(note.pan, -100, 100) / 100,
        ...(mark ? {notBeforeFrame: Number.isFinite(mark.expiresAt) ? frame + Math.ceil((mark.expiresAt - now) * sampleRate / 1000) : Number.MAX_SAFE_INTEGER} : {})});
    }
    for (const list of events) list.sort((a, b) => a.tick - b.tick || a.track - b.track);
    return events;
  }

  /** Publish explicit UI changes; playback never polls/scans all track objects. */
  updateTrackParams(song = this._song) {
    const pool = this._pool;
    if (!pool || !song) return;
    const solo = song.layers?.some(layer => layer.solo);
    for (let worker = 0; worker < pool.ranges.length; worker++) {
      const range = pool.ranges[worker], ring = pool.rings[worker]; let changed = false;
      for (let index = range.start; index < range.end; index++) {
        const layer = song.layers?.[index] || {}, local = (index - range.start) * PARAM_STRIDE;
        const gain = clamp(layer.volume ?? 100, 0, 100) / 100, pan = clamp(layer.pan, -100, 100) / 100;
        const reverb = clamp(layer.reverb, 0, 100) / 100, enabled = !layer.muted && (!solo || layer.solo) ? 1 : 0;
        for (let p = 0; p < PARAM_STRIDE; p++) {
          const value = p === 0 ? gain : p === 1 ? pan : p === 2 ? reverb : enabled;
          if (ring.last[local + p] === Math.fround(value)) continue;
          if (!changed) { Atomics.add(ring.headerView, HEADER.PARAM_REV, 1); changed = true; }
          Atomics.store(ring.bitsView, local + p, bitsOf(value)); ring.last[local + p] = value;
        }
      }
      if (changed) {
        const revision = Atomics.add(ring.headerView, HEADER.PARAM_REV, 1) + 1;
        if (this.playing) ring.pendingControl = {revision, frame: this._playedFrames(), time: performance.now()};
      }
    }
  }

  _acknowledgeControl(pool, index, revision, sequence) {
    if (pool !== this._pool) return;
    const ring = pool.rings[index], pending = ring.pendingControl;
    if (!pending || revision < pending.revision) return;
    ring.lastControl = {controlAckMs: performance.now() - pending.time, controlPipelineMs: Math.max(0, sequence * this.config.blockFrames - pending.frame) / this.context.sampleRate * 1000};
    if (this._benchmarkMetrics) {
      this._benchmarkMetrics.maxControlAckMs = Math.max(this._benchmarkMetrics.maxControlAckMs, ring.lastControl.controlAckMs);
      this._benchmarkMetrics.maxControlPipelineMs = Math.max(this._benchmarkMetrics.maxControlPipelineMs, ring.lastControl.controlPipelineMs);
    }
    ring.pendingControl = null;
  }

  /** Membership edits replace only future event lists, preserving the live reverb states. */
  updateSong(song) {
    this._songRevision++;
    this._song = song; this.customInstruments = song.customInstruments || [];
    if (!this._pool) return true;
    if (Math.max(1, song.layers?.length || 1) !== this._pool.tracks) return false;
    this.updateTrackParams(song);
    if (this.playing) {
      const events = this._eventsFor(song, this._pool), epoch = Atomics.load(this._pool.control, GLOBAL.EPOCH);
      let transport;
      const current = this._transport, options = {...this._playOptions, loop: !!song.loop};
      const next = transportConfig(song, options, this.context.sampleRate);
      if (next.tempo !== current.tempo || next.length !== current.length || next.loop !== current.loop || next.loopStart !== current.loopStart || next.loopCount !== current.loopCount || next.tempoMap?.signature !== current.tempoMap?.signature || next.rainbowSignature !== current.rainbowSignature) {
        const frame = this._playedFrames(), tick = tickAtFrame(frame, current);
        transport = transportConfig(song, {...options, fromTick: tick, startFrame: frame,
          completedLoops: next.loop === current.loop && next.loopCount === current.loopCount ? completedLoopsAtFrame(frame, current) : 0,
          rainbowBaseParity: rainbowAtFrame(frame - 1, current)}, this.context.sampleRate);
        this._transport = transport;
      } else this._transport = {...current, rainbowEvents: next.rainbowEvents};
      this._pool.workers.forEach((worker, index) => worker.postMessage({type: 'events', events: events[index], epoch, transport, timeSignature: song.timeSignature}));
    }
    return true;
  }

  async play(song, options = {}) {
    const generation = ++this._generation;
    this._halt(false);
    this._song = song; this.customInstruments = song.customInstruments || []; this._playOptions = options;
    this._metronome = options.metronome === undefined ? !!this._metronome : !!options.metronome;
    if (options.mono !== undefined) this.setMono(!!options.mono);
    await this.init();
    if (generation !== this._generation) return;
    if (this._metronome) await this._loadMetronome();
    if (generation !== this._generation) return;
    try {
      // Recording can add chord notes/layers while asynchronous sample loading or
      // PREROLL runs. Refresh only this inaudible preparation, never a live tail.
      while (generation === this._generation) {
        const revision = this._songRevision, currentSong = this._song;
        const pool = await this._ensurePool(currentSong, {output: !options.offline});
        if (generation !== this._generation) return;
        if (revision !== this._songRevision) continue;
        this._transport = transportConfig(currentSong, options, this.context.sampleRate);
        this._pausedTick = this._transport.fromTick; this._onTick = options.onTick; this._onEnded = options.onEnded; this._onError = options.onError;
        this._runtimeError = null; this._ended = false; this._draining = false;
        this.setVolume(options.masterVolume ?? this.volume); this.setMono(this._mono);
        Atomics.store(pool.control, GLOBAL.MODE, STOPPED);
        const epoch = Atomics.add(pool.control, GLOBAL.EPOCH, 1) + 1;
        for (const i of [GLOBAL.READ, GLOBAL.OFFSET, GLOBAL.UNDERRUNS, GLOBAL.QUANTA, GLOBAL.OUTPUT_PEAK, GLOBAL.OUTPUT_RMS]) Atomics.store(pool.control, i, 0);
        this.updateTrackParams(currentSong);
        const events = this._eventsFor(currentSong, pool);
        pool.prepared = new Map();
        // Publish before posting: a fast worker may finish before the other posts.
        Atomics.store(pool.control, GLOBAL.MODE, PREROLL);
        const prepared = pool.workers.map((worker, index) => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('音频线程准备超时。')), 15000);
          pool.prepared.set(index, readyEpoch => { if (readyEpoch === epoch) { clearTimeout(timeout); resolve(); } });
          worker.postMessage({type: 'prepare', epoch, events: events[index], transport: this._transport, stress: !!options.stress,
            metronome: index === 0 ? this._metronomeMessage() : undefined});
        }));
        await Promise.all(prepared);
        const deadline = performance.now() + 15000;
        while (pool.rings.some(ring => Atomics.load(ring.headerView, HEADER.WRITE) < this.config.leadBlocks)) {
          if (generation !== this._generation || pool.destroyed) return;
          if (this._runtimeError) throw this._runtimeError;
          if (performance.now() > deadline) throw new Error('Rust 音频预缓冲超时。');
          await sleep(2);
        }
        if (generation !== this._generation) return;
        if (revision !== this._songRevision) continue;
        Atomics.store(pool.control, GLOBAL.MODE, RUNNING);
        pool.workers.forEach(worker => worker.postMessage({type: 'resume'}));
        this.playing = true;
        if (!options.offline) this._timer = setInterval(() => this._monitor(), 25);
        return this.warnings;
      }
    } catch (error) { this._halt(false); throw error; }
  }

  _playedFrames() {
    const pool = this._pool;
    if (!pool) return 0;
    let read, offset, again;
    do { read = Atomics.load(pool.control, GLOBAL.READ); offset = Atomics.load(pool.control, GLOBAL.OFFSET); again = Atomics.load(pool.control, GLOBAL.READ); } while (read !== again);
    return read * this.config.blockFrames + offset;
  }

  getTick() { return this.playing && this._transport ? tickAtFrame(this._playedFrames(), this._transport) : this._pausedTick; }

  /** AudioWorklet consumption clock for visuals; transport is a read-only snapshot. */
  getPlaybackPosition() {
    const frame = this._playedFrames();
    return {playing: this.playing, benchmarking: this._benchmarking, frame, sampleRate: this.context?.sampleRate || 48000,
      transport: this._transport ? {...this._transport} : null, rainbowActive: !!(this.playing && this._transport && rainbowAtFrame(frame, this._transport))};
  }

  _tailFrames() {
    let seconds = 3;
    for (const note of this._song?.notes || []) {
      const {buffer, key} = this._sample(note, this._song);
      const duration = buffer ? buffer.duration / sampleRateForNote(note, key) : 0;
      if (Number.isFinite(duration) && duration > 0) seconds = Math.max(seconds, duration + 3);
    }
    return Math.ceil(Math.min(seconds, 60) * this.context.sampleRate);
  }

  /** Keep the current Rust voices/FDNs and already published PCM, but no future notes. */
  _drain(tick) {
    const pool = this._pool;
    if (!pool || pool.destroyed || !this._transport || (!this.playing && !this._draining) || Atomics.load(pool.control, GLOBAL.MODE) !== RUNNING) return false;
    this._pausedTick = tick; this.playing = false; this._ended = true;
    if (!this._draining) {
      this._draining = true; this._tailEndFrame = this._playedFrames() + this._tailFrames();
      const epoch = Atomics.load(pool.control, GLOBAL.EPOCH);
      for (let i = 0; i < pool.workers.length; i++) {
        pool.workers[i].postMessage({type: 'drain', epoch});
        Atomics.add(pool.rings[i].headerView, HEADER.WAKE, 1); Atomics.notify(pool.rings[i].headerView, HEADER.WAKE);
      }
    }
    if (!this._timer) this._timer = setInterval(() => this._monitor(), 25);
    return true;
  }

  _monitor() {
    if (!this._pool || !this._transport) return;
    const frame = this._playedFrames();
    if (this.playing) this._onTick?.(tickAtFrame(frame, this._transport));
    if (!this._ended && frame >= this._transport.endFrame) {
      this._ended = true; this.playing = false; this._pausedTick = this._transport.length;
      // Keep rendering sample/reverb tails after the UI transport reaches its end.
      this._tailEndFrame = frame + this._tailFrames();
      this._draining = true; this._onEnded?.();
    }
    if (this._draining && frame >= this._tailEndFrame) this._halt(false);
  }

  _halt(resetTick) {
    clearInterval(this._timer); this._timer = null;
    if (this._pool) {
      Atomics.store(this._pool.control, GLOBAL.MODE, STOPPED);
      Atomics.add(this._pool.control, GLOBAL.EPOCH, 1);
      for (let i = 0; i < this._pool.workers.length; i++) {
        this._pool.workers[i].postMessage({type: 'stop'});
        Atomics.add(this._pool.rings[i].headerView, HEADER.WAKE, 1); Atomics.notify(this._pool.rings[i].headerView, HEADER.WAKE);
      }
    }
    for (const source of this._sources) { try { source.stop(); } catch {} }
    this._sources.clear(); this.playing = false; this._draining = false;
    if (resetTick) this._pausedTick = 0;
  }

  pause({tails = false} = {}) { const tick = this.getTick(); this._generation++; if (!tails || !this._drain(tick)) this._halt(false); this._pausedTick = tick; return tick; }
  stop({tails = false} = {}) { this._generation++; this._recordedMonitors.clear(); this._songRevision++; this._previewRequest = (this._previewRequest || 0) + 1; if (!tails || !this._drain(0)) this._halt(true); this._previewEngine?.stop(); this.stopLive(); this._onTick?.(0); }

  _destroyPool() {
    const pool = this._pool;
    if (!pool) return;
    this._lastStats = this.getStats(); pool.destroyed = true;
    Atomics.store(pool.control, GLOBAL.MODE, STOPPED);
    pool.node?.disconnect();
    for (const acknowledge of pool.sampleRequests?.values() || []) acknowledge.cancel?.();
    for (const receive of pool.triggerRequests?.values() || []) receive.cancel?.();
    for (const worker of pool.workers) worker.terminate();
    this._pool = null;
  }

  getStats() {
    const pool = this._pool;
    const empty = {workers: 0, blockFrames: this.config.blockFrames, leadFrames: 0, underruns: 0, activeVoices: 0, droppedVoices: 0, maxWorkerMs: 0, p95WorkerMs: 0, rtRatio: 0, latencyMs: 0, renderAheadMs: 0, controlPipelineMs: 0, controlAckMs: 0, outputPeak: 0, outputRms: 0, baseLatencyMs: (this.context?.baseLatency || 0) * 1000, outputLatencyMs: (this.context?.outputLatency || 0) * 1000, sampleRate: this.context?.sampleRate || 0, simd: false, tracks: 0, reverbTracks: 0, backend: 'Rust/WASM SIMD worker pool'};
    if (!pool) return this._lastStats ? {...this._lastStats, activeVoices: 0} : empty;
    const stats = {...empty, workers: pool.workers.length, simd: pool.simd, tracks: pool.tracks, reverbTracks: (this._song?.layers || []).filter(layer => Number(layer.reverb) > 0 && !layer.muted).length};
    const read = Atomics.load(pool.control, GLOBAL.READ), timing = [];
    stats.underruns = Atomics.load(pool.control, GLOBAL.UNDERRUNS);
    stats.outputPeak = Atomics.load(pool.control, GLOBAL.OUTPUT_PEAK) / 1000000;
    stats.outputRms = Atomics.load(pool.control, GLOBAL.OUTPUT_RMS) / 1000000;
    for (const ring of pool.rings) {
      const h = ring.headerView, count = Atomics.load(h, HEADER.BLOCKS);
      stats.activeVoices += Atomics.load(h, HEADER.ACTIVE); stats.droppedVoices += Atomics.load(h, HEADER.DROPPED);
      stats.maxWorkerMs = Math.max(stats.maxWorkerMs, Atomics.load(h, HEADER.MAX_US) / 1000);
      if (count) stats.rtRatio = Math.max(stats.rtRatio, (Atomics.load(h, HEADER.TOTAL_US) >>> 0) / 1000 / count / (this.config.blockFrames / this.context.sampleRate * 1000));
      stats.leadFrames = Math.max(stats.leadFrames, Math.max(0, Atomics.load(h, HEADER.WRITE) - read) * this.config.blockFrames - Atomics.load(pool.control, GLOBAL.OFFSET));
      const n = Math.min(TIMING_SLOTS, Atomics.load(h, HEADER.TIMING_COUNT));
      for (let i = 0; i < n; i++) if (ring.timesView[i] > 0) timing.push(ring.timesView[i]);
      if (ring.lastControl) { stats.controlAckMs = Math.max(stats.controlAckMs, ring.lastControl.controlAckMs); stats.controlPipelineMs = Math.max(stats.controlPipelineMs, ring.lastControl.controlPipelineMs); }
    }
    timing.sort((a, b) => a - b); stats.p95WorkerMs = timing.length ? timing[Math.floor((timing.length - 1) * .95)] : 0;
    stats.renderAheadMs = stats.leadFrames / this.context.sampleRate * 1000;
    stats.latencyMs = stats.renderAheadMs + stats.baseLatencyMs + stats.outputLatencyMs;
    if (this._benchmarking && this._benchmarkMetrics) { stats.controlChangeCount = this._benchmarkMetrics.liveControlChanges; stats.maxControlPipelineMs = this._benchmarkMetrics.maxControlPipelineMs; stats.maxControlAckMs = this._benchmarkMetrics.maxControlAckMs; }
    if (Atomics.load(pool.control, GLOBAL.MODE) === STOPPED) stats.activeVoices = 0;
    return stats;
  }

  getBenchmarkInfo() { return this._benchmarkSong ? {tracks: this._benchmarkSong.layers.length, running: this._benchmarking} : null; }

  updateBenchmarkTrack(index, {reverb} = {}) {
    const song = this._benchmarkSong;
    if (!song || !this._benchmarking) throw new Error('当前没有运行万轨测试。');
    if (!Number.isInteger(index) || index < 0 || index >= song.layers.length) throw new Error('测试轨道编号超出范围。');
    if (reverb !== undefined) song.layers[index].reverb = clamp(reverb, 0, 100);
    this._benchmarkMetrics.liveControlChanges++;
    this.updateTrackParams(song);
    return {index, reverb: song.layers[index].reverb};
  }

  /** Render the same Rust sampler and per-track reverb kernel to stereo PCM WAV. */
  async exportWav(song, {masterVolume = this.volume, sampleRate} = {}) {
    if (this._exporting) throw new Error('WAV 导出已在运行。');
    this._exporting = true;
    let renderer;
    try {
      await this.init();
      const rate = this.context.sampleRate;
      if (sampleRate !== undefined && Number(sampleRate) !== rate) throw new Error(`Rust WAV 使用当前音频设备采样率 ${rate} Hz。`);
      const config = transportConfig(song, {fromTick: 0, loop: false}, rate);
      let seconds = tickFrameOffset(config.length, config) / rate;
      for (const note of song.notes || []) {
        const {buffer, key} = this._sample(note, song);
        if (buffer) seconds = Math.max(seconds, tickFrameOffset(Math.max(0, note.tick), config) / rate + buffer.duration / sampleRateForNote(note, key));
      }
      seconds += song.layers.some(layer => Number(layer.reverb) > 0) ? 3 : .05;
      const frames = Math.ceil(seconds * rate), bytes = 44 + frames * 4;
      if (!Number.isSafeInteger(bytes) || bytes > 512 * 1024 * 1024) throw new Error('WAV 超过本地单次导出的 512 MB 内存预算，请分段导出。');
      const wav = new ArrayBuffer(bytes), view = new DataView(wav);
      const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
      text(0, 'RIFF'); view.setUint32(4, bytes - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true);
      view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 4, true);
      renderer = new WasmAudioEngine({context: this.context, ...this.config, blockFrames: 256, leadBlocks: 4});
      renderer.buffers = this.buffers; renderer.bundledCustomSamples = this.bundledCustomSamples; renderer.customSamples = this.customSamples;
      renderer._pcmCache = this._pcmCache; renderer._modulePromise = this._modulePromise; renderer._workletPromise = this._workletPromise;
      await renderer.play(song, {fromTick: 0, loop: false, offline: true});
      const {NBSOutputProcessor} = await import('./output-worklet.js');
      const pool = renderer._pool, block = renderer.config.blockFrames;
      const output = new NBSOutputProcessor({processorOptions: {global: pool.global, rings: pool.rings, blockFrames: block}});
      const left = new Float32Array(block), right = new Float32Array(block), scale = clamp(masterVolume, 0, 1);
      // MessageChannel yields avoid nested setTimeout's 4 ms clamp during offline export.
      const channel = new MessageChannel(), pending = [];
      channel.port1.onmessage = () => pending.shift()?.();
      const yieldTask = () => new Promise(resolve => { pending.push(resolve); channel.port2.postMessage(0); });
      try {
        for (let frame = 0, sequence = 0; frame < frames; frame += block, sequence++) {
          const deadline = performance.now() + 15000;
          while (pool.rings.some(ring => Atomics.load(ring.headerView, HEADER.WRITE) <= sequence)) {
            if (renderer._runtimeError) throw renderer._runtimeError;
            if (performance.now() > deadline) throw new Error('Rust WAV 渲染线程超时。');
            await yieldTask();
          }
          output.process([], [[left, right]]);
          const count = Math.min(block, frames - frame);
          for (let i = 0; i < count; i++) {
            const l = clamp(left[i] * scale, -1, 1), r = clamp(right[i] * scale, -1, 1);
            view.setInt16(44 + (frame + i) * 4, Math.round(l * (l < 0 ? 32768 : 32767)), true);
            view.setInt16(46 + (frame + i) * 4, Math.round(r * (r < 0 ? 32768 : 32767)), true);
          }
          if (sequence % 32 === 0) await yieldTask();
        }
      } finally { channel.port1.close(); channel.port2.close(); }
      return new Blob([wav], {type: 'audio/wav'});
    } finally { renderer?.stop(); renderer?._destroyPool(); this._exporting = false; }
  }

  /** Actual sustained voices in every track, including every independent reverb. */
  async runBenchmark({tracks = 10000, durationSeconds = 60, reverb = 50, onProgress, warmupSeconds = 3} = {}) {
    if (this._benchmarking) throw new Error('已有基准测试在运行。');
    tracks = Math.round(clamp(tracks, 4, 65536)); durationSeconds = clamp(durationSeconds, 1, 600);
    this._benchmarking = true;
    const song = {tempo: 10, length: Math.ceil((durationSeconds + warmupSeconds + 10) * 10), customInstruments: [],
      layers: Array.from({length: tracks}, (_, id) => ({id, name: `Stress ${id + 1}`, volume: .5 + (id % 7) * .015, pan: (id % 101) * 2 - 100, reverb: clamp(reverb, 1, 100)})),
      notes: Array.from({length: tracks}, (_, id) => ({tick: 0, layer: id, key: 33 + id % 37, instrument: id % 16, velocity: 50 + id % 51, pan: 0, pitch: (id % 13) - 6}))};
    this._benchmarkSong = song;
    this._benchmarkMetrics = {liveControlChanges: 0, maxControlPipelineMs: 0, maxControlAckMs: 0};
    try {
      await this.play(song, {stress: true, masterVolume: .12});
      const generation = this._generation;
      await sleep(Math.max(0, warmupSeconds) * 1000);
      if (!this.playing || generation !== this._generation) throw new Error('基准测试已取消。');
      const startupStats = this.getStats();
      startupStats.underruns = Atomics.exchange(this._pool.control, GLOBAL.UNDERRUNS, 0);
      this._pool.workers.forEach(worker => worker.postMessage({type: 'clearStats'}));
      const started = performance.now(), samples = []; let minimumVoices = Infinity, maximumDropped = 0;
      while (performance.now() - started < durationSeconds * 1000) {
        if (!this.playing || generation !== this._generation) throw new Error('基准测试已取消。');
        const stats = this.getStats(); minimumVoices = Math.min(minimumVoices, stats.activeVoices); maximumDropped = Math.max(maximumDropped, stats.droppedVoices);
        samples.push({...stats, elapsedSeconds: (performance.now() - started) / 1000}); onProgress?.(samples.at(-1));
        await sleep(250);
      }
      const stats = this.getStats();
      return {timestamp: new Date().toISOString(), browser: globalThis.navigator?.userAgent || '', sampleRate: this.context.sampleRate,
        requestedTracks: tracks, durationSeconds: (performance.now() - started) / 1000, warmupSeconds, reverbPercent: clamp(reverb, 1, 100),
        config: {...this.config}, ...stats, startupUnderruns: startupStats.underruns, steadyStateUnderruns: stats.underruns,
        underruns: startupStats.underruns + stats.underruns, startupMaxWorkerMs: startupStats.maxWorkerMs,
        minimumActiveVoices: minimumVoices, maximumDroppedVoices: Math.max(maximumDropped, startupStats.droppedVoices),
        simultaneousTracksVerified: minimumVoices >= tracks && maximumDropped === 0,
        nonSilentOutputVerified: samples.some(sample => sample.outputRms > .000001), ...this._benchmarkMetrics, controlChangeCount: this._benchmarkMetrics.liveControlChanges, samples};
    } finally { this.stop(); this._benchmarking = false; this._benchmarkSong = null; }
  }

  /** Select the lowest measured stable queue, then let a longer benchmark verify it. */
  async autoTune({tracks = 10000, durationSeconds = 6, reverb = 50, onProgress} = {}) {
    if (this._tuning || this._benchmarking) throw new Error('已有音频测量在运行。');
    this._tuning = true; this.stop();
    const original = {...this.config}, results = [];
    const candidates = [];
    for (const leadBlocks of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16]) {
      candidates.push({blockFrames: 128, leadBlocks});
      if (leadBlocks % 2 === 0) candidates.push({blockFrames: 256, leadBlocks: leadBlocks / 2});
    }
    try {
      for (const candidate of candidates) {
        this.configure(candidate);
        onProgress?.({phase: 'candidate', config: {...this.config}});
        const result = await this.runBenchmark({tracks, durationSeconds, reverb, warmupSeconds: 2,
          onProgress: stats => onProgress?.({phase: 'measuring', config: {...this.config}, stats})});
        results.push(result);
        if (result.simultaneousTracksVerified && result.nonSilentOutputVerified && result.underruns === 0 && result.droppedVoices === 0) return {selected: {...this.config}, results, note: '短测通过；仍需持续播放和编辑压力测试验证。'};
      }
      this.configure(original);
      throw new Error('当前测试配置都出现欠载或声部不足，未选出稳定低延迟设置。请查看测量结果并增加缓冲或减少负载。');
    } finally { this._tuning = false; this.lastTuningResults = results; }
  }
}
