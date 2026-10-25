/** Local Web Audio renderer. Pitch follows the original play_sound.gml. */
import {controlType} from './tempo-map.js';
import {findLocalFileReference} from './file-paths.js';
export const INSTRUMENTS = [
  ['竖琴', 'Harp', 'harp.ogg', '#6ab4e6', '🎹'],
  ['低音提琴', 'Double Bass', 'dbass.ogg', '#a08de5', '♬'],
  ['底鼓', 'Bass Drum', 'bdrum.ogg', '#de9a67', '●'],
  ['军鼓', 'Snare Drum', 'sdrum.ogg', '#e9c177', '◉'],
  ['击棒', 'Click', 'click.ogg', '#c9d3da', '✦'],
  ['吉他', 'Guitar', 'guitar.ogg', '#d59c64', '♫'],
  ['长笛', 'Flute', 'flute.ogg', '#8cd3ac', '♩'],
  ['钟', 'Bell', 'bell.ogg', '#f1cf70', '♢'],
  ['风铃', 'Chime', 'icechime.ogg', '#8acfe5', '✧'],
  ['木琴', 'Xylophone', 'xylobone.ogg', '#eb929c', '▥'],
  ['铁木琴', 'Iron Xylophone', 'iron_xylophone.ogg', '#babfe9', '▤'],
  ['牛铃', 'Cow Bell', 'cow_bell.ogg', '#e5ba6d', '◇'],
  ['迪吉里杜管', 'Didgeridoo', 'didgeridoo.ogg', '#be9a85', '〰'],
  ['电子音', 'Bit', 'bit.ogg', '#88cba0', '⌁'],
  ['班卓琴', 'Banjo', 'banjo.ogg', '#d8aa86', '♬'],
  ['电钢琴', 'Pling', 'pling.ogg', '#b29ce6', '♪'],
].map(([name, englishName, file, color, symbol], id) => Object.freeze({id, name, englishName, file, color, symbol}));

// Only these original bundled custom files can resolve without a user upload.
export const BUNDLED_CUSTOM_SOUNDS = Object.freeze([
  'block.portal.trigger.ogg',
  'block.sand.break.ogg',
  'entity.experience_orb.pickup.ogg',
  'entity.firework.blast_far.ogg',
]);
const bundledCustomReferences = BUNDLED_CUSTOM_SOUNDS.flatMap(file => [file, `Custom/${file}`]);
export const bundledCustomFile = value => {
  const index = findLocalFileReference(value, bundledCustomReferences);
  return index < 0 ? null : BUNDLED_CUSTOM_SOUNDS[Math.floor(index / 2)];
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const numeric = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const customIndex = index => Math.max(0, Math.trunc(Number(index)) - (Number(index) >= 16 ? 16 : 0));
const tempoOf = song => clamp(numeric(song.tempo, 10), 0.05, 1000);
const lengthOf = song => (song.notes || []).reduce((length, note) => Math.max(length, numeric(note.tick, 0) + 1), Math.max(1, numeric(song.length, 0)));

/** NBS key45 = F#4 and the native sample's untransposed pitch. */
export function sampleRateForNote(note, instrumentKey = 45) {
  return 2 ** ((numeric(note.key, 45) + numeric(instrumentKey, 45) - 90 + numeric(note.pitch, 0) / 100) / 12);
}

/** Original control_draw.gml: a centred layer preserves note pan; otherwise average. */
export function nativePan(notePan = 0, layerPan = 0) {
  const note = clamp(numeric(notePan, 0), -100, 100), layer = clamp(numeric(layerPan, 0), -100, 100);
  return (layer === 0 ? note : (layer + note) / 2) / 100;
}

/** Encode an AudioBuffer as interleaved, little-endian stereo 16-bit PCM. */
export function encodeWav(buffer) {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({length: channels}, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++, offset += 2) {
      const sample = clamp(data[channel][frame], -1, 1);
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return new Blob([bytes], {type: 'audio/wav'});
}

export class AudioEngine {
  constructor(options = {}) {
    this.context = options.context || null;
    this.assetBase = options.assetBase || new URL('../assets/sounds/', import.meta.url);
    this.volume = clamp(numeric(options.masterVolume, 0.8), 0, 1);
    this.buffers = new Map();
    this.bundledCustomSamples = new Map();
    this.customSamples = new Map();
    this.warnings = [];
    this.playing = false;
    this._sources = new Set();
    this._pausedTick = 0;
    this._generation = 0;
    this._lookahead = 0.15;
    this._timer = null;
  }

  get currentTick() { return this.getTick(); }

  async init() {
    if (!this.context) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio，请使用新版 Chrome、Edge 或 Firefox。');
      this.context = new AudioContextClass({latencyHint: 'interactive'});
    }
    if (!this.masterGain) {
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.context.destination);
    }
    // Resume synchronously within the user's gesture, before loading samples.
    if (this.context.state === 'suspended') await this.context.resume();
    if (!this._initPromise) {
      const load = async (file, cache, key) => {
        if (cache.has(key)) return;
        const response = await fetch(new URL(file, this.assetBase));
        if (!response.ok) throw new Error(`无法加载本地音色 ${file}（${response.status}）。请用本地启动脚本打开项目。`);
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        cache.set(key, buffer);
      };
      this._initPromise = Promise.all([
        ...INSTRUMENTS.map(instrument => load(instrument.file, this.buffers, instrument.id)),
        ...BUNDLED_CUSTOM_SOUNDS.map(file => load(`Custom/${file}`, this.bundledCustomSamples, file)),
      ]).catch(error => { this._initPromise = null; throw error; });
    }
    await this._initPromise;
    return this;
  }

  setVolume(value) {
    this.volume = clamp(numeric(value, this.volume), 0, 1);
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.012);
  }

  async setCustomSample(index, input) {
    await this.init();
    const data = input instanceof Blob ? await input.arrayBuffer() : input;
    if (!(data instanceof ArrayBuffer)) throw new TypeError('自定义音色需要 ArrayBuffer 或本地音频文件。');
    const decoded = await this.context.decodeAudioData(data.slice(0));
    this.customSamples.set(customIndex(index), decoded);
    return decoded;
  }

  removeCustomSample(index) { this.customSamples.delete(customIndex(index)); }

  _sample(note, song = {}) {
    if (controlType(note, song)) return {buffer: null, key: 45};
    const instrument = Math.max(0, Math.trunc(numeric(note.instrument, 0)));
    if (instrument < 16) return {buffer: this.buffers.get(instrument), key: 45};
    const index = instrument - 16;
    const definition = song.customInstruments?.[index] || {};
    const buffer = this.customSamples.get(index) ?? this.bundledCustomSamples.get(bundledCustomFile(definition.file));
    if (!buffer) {
      const warning = `自定义音色「${definition.name || `音色 ${instrument + 1}`}」尚未加载，暂用竖琴试听。请重新选择本地音频文件。`;
      if (!this.warnings.includes(warning)) this.warnings.push(warning);
    }
    return {buffer: buffer || this.buffers.get(0), key: numeric(definition.key, 45)};
  }

  _audible(note, song) {
    const layer = song.layers?.[note.layer] || {};
    const anySolo = song.layers?.some(layer => layer.solo);
    return !layer.muted && (!anySolo || layer.solo);
  }

  _schedule(note, song, when, context, destination, track = false, volumeScale = 1) {
    if (!this._audible(note, song)) return 0;
    const {buffer, key} = this._sample(note, song);
    if (!buffer) return 0;
    const layer = song.layers?.[note.layer] || {};
    const volume = clamp(numeric(note.velocity, 100), 0, 100) / 100 * clamp(numeric(layer.volume, 100), 0, 100) / 100 * volumeScale;
    if (volume <= 0) return 0;
    const rate = sampleRateForNote(note, key);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = context.createGain();
    gain.gain.value = volume;
    const panner = context.createStereoPanner();
    panner.pan.value = nativePan(note.pan, layer.pan);
    source.connect(gain); gain.connect(panner); panner.connect(destination);
    if (track) {
      this._sources.add(source);
      source.onended = () => { this._sources.delete(source); source.disconnect(); gain.disconnect(); panner.disconnect(); };
    }
    source.start(Math.max(context.currentTime, when));
    return buffer.duration / rate;
  }

  async preview(note, layer = {}, masterVolume = this.volume) {
    await this.init();
    // Preview volume is per voice so it does not change an ongoing song mix.
    const scale = clamp(numeric(masterVolume, this.volume), 0, 1);
    const song = {layers: [layer], customInstruments: this.customInstruments ?? this._song?.customInstruments ?? []};
    this._schedule({...note, layer: 0}, song, this.context.currentTime, this.context, this.context.destination, true, scale);
    return this.warnings;
  }

  async play(song, options = {}) {
    const generation = ++this._generation;
    await this.init();
    if (generation !== this._generation) return;
    this._clearPlayback();
    this._song = song;
    this.customInstruments = song.customInstruments || [];
    this._tempo = tempoOf(song);
    this._length = lengthOf(song);
    this._loopStart = clamp(numeric(song.loopStart, 0), 0, this._length - 1);
    this._loop = options.loop === undefined ? Boolean(song.loop) : Boolean(options.loop);
    this._loopLimit = clamp(Math.trunc(numeric(options.loopCount ?? song.loopCount, 0)), 0, 255);
    this._loopsScheduled = 0;
    this._fromTick = clamp(numeric(options.fromTick, 0), 0, this._length);
    if (this._fromTick >= this._length) this._fromTick = 0;
    this._onTick = options.onTick;
    this._onEnded = options.onEnded;
    this.setVolume(options.masterVolume ?? this.volume);
    this._notes = (song.notes || []).filter(note => numeric(note.tick, -1) >= 0).slice().sort((a, b) => a.tick - b.tick);
    this._cursor = this._notes.findIndex(note => note.tick >= this._fromTick);
    if (this._cursor < 0) this._cursor = this._notes.length;
    this._originTime = this.context.currentTime + 0.035 - this._fromTick / this._tempo;
    this._cycleOrigin = this._originTime;
    this._cycleEnd = this._cycleOrigin + this._length / this._tempo;
    this._endTime = this._loop && this._loopLimit === 0 ? Infinity
      : this._originTime + (this._length + (this._loop ? this._loopLimit * (this._length - this._loopStart) : 0)) / this._tempo;
    this._pausedTick = this._fromTick;
    this.playing = true;
    this._pump();
    this._timer = setInterval(() => this._pump(), 25);
    return this.warnings;
  }

  _pump() {
    if (!this.playing) return;
    const now = this.context.currentTime;
    const horizon = now + this._lookahead;
    // AudioBufferSource start times use the audio clock; the UI timer only fills a queue.
    for (let cycles = 0; cycles < 256; cycles++) {
      while (this._cursor < this._notes.length) {
        const note = this._notes[this._cursor];
        const when = this._cycleOrigin + note.tick / this._tempo;
        if (note.tick >= this._length || when >= horizon) break;
        this._cursor++;
        if (when >= now - 0.03) this._schedule(note, this._song, when, this.context, this.masterGain, true);
      }
      if (!this._loop || this._loopLimit > 0 && this._loopsScheduled >= this._loopLimit || this._cycleEnd >= horizon) break;
      this._loopsScheduled++;
      this._cycleOrigin = this._cycleEnd - this._loopStart / this._tempo;
      this._cycleEnd = this._cycleOrigin + this._length / this._tempo;
      this._cursor = this._notes.findIndex(note => note.tick >= this._loopStart);
      if (this._cursor < 0) this._cursor = this._notes.length;
    }
    this._onTick?.(this.getTick());
    if (now >= this._endTime) {
      clearInterval(this._timer); this._timer = null;
      this.playing = false;
      this._pausedTick = this._length;
      this._onEnded?.();
    }
  }

  getTick() {
    if (!this.playing || !this.context) return this._pausedTick;
    if (this.context.currentTime >= this._endTime) return this._length;
    const tick = Math.max(this._fromTick, (this.context.currentTime - this._originTime) * this._tempo);
    if (this._loop && tick >= this._length) return this._loopStart + (tick - this._length) % (this._length - this._loopStart);
    return Math.min(tick, this._length);
  }

  _clearPlayback() {
    clearInterval(this._timer); this._timer = null;
    for (const source of this._sources) { try { source.stop(); } catch {} }
    this._sources.clear();
    this.playing = false;
  }

  pause() {
    const tick = this.getTick();
    this._generation++;
    this._clearPlayback();
    this._pausedTick = tick;
    return tick;
  }

  stop() {
    this._generation++;
    this._clearPlayback();
    this._pausedTick = 0;
    this._onTick?.(0);
  }

  /** Render one pass, including complete sample tails; playback loop is ignored. */
  async exportWav(song, {masterVolume = this.volume, sampleRate = 44100} = {}) {
    await this.init();
    const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineContext) throw new Error('当前浏览器不支持离线音频导出。');
    const tempo = tempoOf(song);
    let duration = lengthOf(song) / tempo;
    for (const note of song.notes || []) {
      if (!this._audible(note, song)) continue;
      const {buffer, key} = this._sample(note, song);
      if (buffer) duration = Math.max(duration, Math.max(0, note.tick) / tempo + buffer.duration / sampleRateForNote(note, key));
    }
    sampleRate = clamp(Math.round(numeric(sampleRate, 44100)), 8000, 96000);
    // Stereo float rendering + 16-bit WAV + Blob's immutable byte copy can coexist.
    // Also reserve space for the three audio nodes created for each note.
    const frames = Math.ceil((duration + 0.05) * sampleRate);
    const estimatedBytes = frames * 16 + (song.notes?.length || 0) * 4096;
    if (!Number.isSafeInteger(frames) || frames < 1 || estimatedBytes > 768 * 1024 * 1024) throw new Error('这首曲目的 WAV 过大。请缩短曲目或提高播放速度后再导出。');
    const offline = new OfflineContext(2, frames, sampleRate);
    const master = offline.createGain();
    master.gain.value = clamp(numeric(masterVolume, 0.8), 0, 1);
    master.connect(offline.destination);
    for (const note of song.notes || []) this._schedule(note, song, Math.max(0, numeric(note.tick, 0)) / tempo, offline, master);
    return encodeWav(await offline.startRendering());
  }
}
