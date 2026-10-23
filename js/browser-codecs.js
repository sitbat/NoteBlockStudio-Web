// FFmpeg runs inside the vendored module Worker. All URLs stay on this website;
// audio is passed to that Worker in memory and is never sent over HTTP.
export const BROWSER_CODEC_VERSION = Object.freeze({wrapper: '0.12.15', core: '0.12.10', ffmpeg: '5.1.4', threading: 'single'});
const MiB = 1024 * 1024;
const FORMATS = Object.freeze({
  mp3: {mime: 'audio/mpeg', codec: ['-c:a', 'libmp3lame'], muxer: 'mp3'},
  flac: {mime: 'audio/flac', codec: ['-c:a', 'flac'], muxer: 'flac'},
  aiff: {mime: 'audio/aiff', codec: ['-c:a', 'pcm_s16be'], muxer: 'aiff'},
  ogg: {mime: 'audio/ogg', codec: ['-c:a', 'libvorbis', '-q:a', '6'], muxer: 'ogg'},
  wav: {mime: 'audio/wav', codec: ['-c:a', 'pcm_s16le'], muxer: 'wav'},
});
const LOCAL_ASSETS = Object.freeze({
  module: new URL('../vendor/ffmpeg/esm/index.js', import.meta.url).href,
  classWorkerURL: new URL('../vendor/ffmpeg/esm/worker.js', import.meta.url).href,
  coreURL: new URL('../vendor/ffmpeg/core/ffmpeg-core.js', import.meta.url).href,
  wasmURL: new URL('../vendor/ffmpeg/core/ffmpeg-core.wasm', import.meta.url).href,
});
const fail = (code, message) => Object.assign(new Error(message), {code});
const aborted = () => Object.assign(new Error('音频编码已取消。'), {name: 'AbortError', code: 'ABORTED'});
const notify = (callback, event) => { try { callback?.(event); } catch { /* A progress view must not break encoding. */ } };
const boundedInteger = (value, fallback, min, max) => {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new RangeError('编码器内存或时间上限无效。');
  return result;
};

/** Validate generated WAV without decoding it or accepting arbitrary FFmpeg inputs. */
export function inspectCodecWav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) throw fail('INVALID_WAV', '输入必须是完整的 PCM WAV。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw fail('INVALID_WAV', '输入必须是 RIFF/WAVE 音频。');
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.byteLength || end < 44) throw fail('INVALID_WAV', 'WAV 文件长度无效。');
  let fmt, dataBytes = 0, hasData = false;
  let chunks = 0;
  for (let offset = 12; offset + 8 <= end;) {
    if (++chunks > 4096) throw fail('INVALID_WAV', 'WAV 数据块过多。');
    const length = view.getUint32(offset + 4, true), start = offset + 8;
    if (length > end - start) throw fail('INVALID_WAV', 'WAV 数据块不完整。');
    if (tag(offset) === 'fmt ') {
      if (fmt || length < 16) throw fail('INVALID_WAV', 'WAV 格式块无效。');
      let encoding = view.getUint16(start, true);
      if (encoding === 65534 && length >= 40) {
        // WAVE_FORMAT_EXTENSIBLE, PCM or IEEE float with the standard subtype GUID.
        const suffix = [0,0,0,0,16,0,128,0,0,170,0,56,155,113];
        if (!suffix.every((value, i) => bytes[start + 26 + i] === value)) throw fail('INVALID_WAV', '不支持该 WAV 子格式。');
        encoding = view.getUint16(start + 24, true);
      }
      fmt = {encoding, channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true), align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true)};
    } else if (tag(offset) === 'data') { hasData = true; dataBytes += length; }
    offset = start + length + (length & 1);
  }
  if (!fmt || !hasData || !dataBytes || ![1,3].includes(fmt.encoding) || ![1,2].includes(fmt.channels) || fmt.sampleRate < 8000 || fmt.sampleRate > 384000 || ![8,16,24,32].includes(fmt.bits) || (fmt.encoding === 3 && fmt.bits !== 32) || fmt.align !== fmt.channels * fmt.bits / 8 || fmt.byteRate !== fmt.sampleRate * fmt.align || dataBytes % fmt.align) throw fail('INVALID_WAV', 'WAV 仅支持 8–384 kHz、单/双声道 PCM 或 32 位浮点音频。');
  const duration = dataBytes / fmt.byteRate;
  if (duration > 3600) throw fail('INPUT_TOO_LONG', '单次编码最长支持一小时音频，请分段导出。');
  return {...fmt, dataBytes, duration};
}

export function codecArguments({format = 'mp3', rate = 48000, channels = 2, bitrate = 320} = {}, maxOutputBytes = 128 * MiB) {
  if (!Object.hasOwn(FORMATS, format)) throw fail('INVALID_FORMAT', '不支持该音频格式。');
  if (!Number.isInteger(rate) || rate < 8000 || rate > 384000 || ![1,2].includes(channels) || !Number.isInteger(bitrate) || bitrate < 32 || bitrate > 320) throw fail('INVALID_OPTIONS', '采样率、通道数或 MP3 码率无效。');
  if (format === 'mp3' && ![8000,11025,12000,16000,22050,24000,32000,44100,48000].includes(rate)) throw fail('INVALID_OPTIONS', 'MP3 支持 8–48 kHz 的标准采样率；高采样率请使用 FLAC、AIFF 或 WAV。');
  if (format === 'ogg' && rate > 192000) throw fail('INVALID_OPTIONS', 'OGG Vorbis 最高支持 192 kHz；更高采样率请使用 FLAC、AIFF 或 WAV。');
  const info = FORMATS[format];
  return ['-hide_banner', '-v', 'error', '-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe', '-f', 'wav', '-i', 'input.wav', '-map', '0:a:0', '-map_metadata', '-1', '-vn', '-ar', String(rate), '-ac', String(channels), ...info.codec, ...(format === 'mp3' ? ['-b:a', `${bitrate}k`] : []), '-threads', '1', '-fs', String(maxOutputBytes + 1), '-f', info.muxer, `output.${format}`];
}

/** A bounded, serial FFmpeg Worker queue. The factory option is for isolated tests. */
export class BrowserCodecs {
  constructor({maxInputBytes, maxOutputBytes, maxQueuedBytes, maxTasks, loadTimeoutMs, encodeTimeoutMs, ffmpegFactory} = {}) {
    this.limits = Object.freeze({
      maxInputBytes: boundedInteger(maxInputBytes, 128 * MiB, 44, 512 * MiB),
      maxOutputBytes: boundedInteger(maxOutputBytes, 128 * MiB, 44, 512 * MiB),
      maxQueuedBytes: boundedInteger(maxQueuedBytes, 256 * MiB, 44, 512 * MiB),
      maxTasks: boundedInteger(maxTasks, 8, 1, 32),
      loadTimeoutMs: boundedInteger(loadTimeoutMs, 120000, 10, 600000),
      encodeTimeoutMs: boundedInteger(encodeTimeoutMs, 300000, 10, 1800000),
    });
    this.factory = ffmpegFactory;
    this.ffmpeg = null;
    this.queue = [];
    this.active = null;
    this.queuedBytes = 0;
    this.generation = 0;
    this.state = 'idle';
    this.lastError = null;
  }
  getState() { return {state: this.state, version: {...BROWSER_CODEC_VERSION}, queued: this.queue.length, active: !!this.active, lastError: this.lastError, limits: {...this.limits}}; }
  load({onProgress, signal} = {}) { return this._enqueue({kind: 'load', size: 0, onProgress, signal}); }
  encode(wav, options = {}) {
    try {
      const args = codecArguments(options, this.limits.maxOutputBytes);
      const size = wav instanceof Blob ? wav.size : wav instanceof ArrayBuffer ? wav.byteLength : wav instanceof Uint8Array ? wav.byteLength : -1;
      if (size < 44) throw fail('INVALID_WAV', '输入必须是 PCM WAV Blob、ArrayBuffer 或 Uint8Array。');
      if (size > this.limits.maxInputBytes) throw fail('INPUT_TOO_LARGE', `单次编码输入不能超过 ${this.limits.maxInputBytes / MiB} MiB。`);
      return this._enqueue({kind: 'encode', wav, size, args, format: options.format || 'mp3', onProgress: options.onProgress, signal: options.signal});
    } catch (error) { return Promise.reject(error); }
  }
  terminate() {
    const error = aborted();
    this._discardWorker();
    this.active?.controller.abort();
    for (const task of this.queue.splice(0)) { task.signal?.removeEventListener('abort', task.abort); task.reject(error); this.queuedBytes -= task.size; }
    this.state = 'idle';
    this.lastError = null;
  }
  _enqueue(data) {
    if (data.signal?.aborted) return Promise.reject(aborted());
    if (this.queue.length + (this.active ? 1 : 0) >= this.limits.maxTasks || this.queuedBytes + data.size > this.limits.maxQueuedBytes) return Promise.reject(fail('QUEUE_FULL', '本地编码队列已满，请等待当前任务完成。'));
    return new Promise((resolve, reject) => {
      const task = {...data, resolve, reject, controller: new AbortController()};
      task.abort = () => {
        if (this.active === task) { task.controller.abort(); return; }
        const index = this.queue.indexOf(task);
        if (index !== -1) { this.queue.splice(index, 1); this.queuedBytes -= task.size; task.signal?.removeEventListener('abort', task.abort); reject(aborted()); }
      };
      task.signal?.addEventListener('abort', task.abort, {once: true});
      this.queue.push(task); this.queuedBytes += task.size;
      void this._pump();
    });
  }
  async _pump() {
    if (this.active) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    try {
      const result = await this._guard(task, () => this._run(task), task.kind === 'load' ? this.limits.loadTimeoutMs : this.limits.loadTimeoutMs + this.limits.encodeTimeoutMs);
      task.resolve(result);
    } catch (error) {
      this._discardWorker();
      this.lastError = error?.name === 'AbortError' ? null : String(error?.message || error);
      this.state = error?.name === 'AbortError' ? 'idle' : 'error';
      task.reject(error instanceof Error ? error : fail('CODEC_FAILED', String(error)));
    } finally {
      task.signal?.removeEventListener('abort', task.abort);
      this.queuedBytes -= task.size;
      this.active = null;
      void this._pump();
    }
  }
  _guard(task, operation, timeoutMs) {
    const signal = task.controller.signal;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => { if (!finished) { finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); callback(value); } };
      const cancel = () => { this._discardWorker(); finish(reject, aborted()); };
      const timer = setTimeout(() => { this._discardWorker(); finish(reject, fail('CODEC_TIMEOUT', '浏览器编码器超时，已释放 Worker；可重试或分段导出。')); }, timeoutMs);
      signal.addEventListener('abort', cancel, {once: true});
      if (signal.aborted) { cancel(); return; }
      Promise.resolve().then(operation).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  _discardWorker() {
    this.generation++;
    try { this.ffmpeg?.terminate(); } catch { /* Already terminated. */ }
    this.ffmpeg = null;
  }
  async _ready(task) {
    if (this.ffmpeg?.loaded) return this.ffmpeg;
    const generation = this.generation;
    this.state = 'loading'; this.lastError = null;
    notify(task.onProgress, {stage: 'load', progress: 0});
    let ffmpeg;
    if (this.factory) ffmpeg = await this.factory();
    else {
      if (typeof Worker === 'undefined' || !['http:', 'https:'].includes(globalThis.location?.protocol)) throw fail('BROWSER_REQUIRED', '请通过 HTTPS 或 localhost 网站打开，浏览器需要支持模块 Worker 和 WebAssembly。');
      const {FFmpeg} = await import(LOCAL_ASSETS.module);
      ffmpeg = new FFmpeg();
    }
    if (task.controller.signal.aborted || generation !== this.generation) { ffmpeg.terminate(); throw aborted(); }
    this.ffmpeg = ffmpeg;
    await this._guard(task, () => ffmpeg.load({classWorkerURL: LOCAL_ASSETS.classWorkerURL, coreURL: LOCAL_ASSETS.coreURL, wasmURL: LOCAL_ASSETS.wasmURL}), this.limits.loadTimeoutMs);
    if (generation !== this.generation || task.controller.signal.aborted) throw aborted();
    this.state = 'ready';
    notify(task.onProgress, {stage: 'load', progress: 1});
    return ffmpeg;
  }
  async _run(task) {
    if (task.kind === 'load') { await this._ready(task); return this.getState(); }
    const generation = this.generation;
    const bytes = task.wav instanceof Blob ? new Uint8Array(await task.wav.arrayBuffer()) : task.wav instanceof ArrayBuffer ? new Uint8Array(task.wav.slice(0)) : task.wav.slice();
    if (task.controller.signal.aborted || generation !== this.generation) throw aborted();
    inspectCodecWav(bytes);
    const ffmpeg = await this._ready(task);
    this.state = 'encoding';
    const logs = [];
    const log = ({message}) => { if (message) { logs.push(String(message).slice(0, 300)); if (logs.length > 5) logs.shift(); } };
    const progress = event => notify(task.onProgress, {stage: 'encode', progress: Math.max(0, Math.min(1, Number(event.progress) || 0)), time: Math.max(0, Number(event.time) || 0) / 1e6});
    ffmpeg.on('log', log); ffmpeg.on('progress', progress);
    const output = `output.${task.format}`;
    notify(task.onProgress, {stage: 'encode', progress: 0});
    try {
      await ffmpeg.writeFile('input.wav', bytes);
      const status = await this._guard(task, () => ffmpeg.exec(task.args, this.limits.encodeTimeoutMs), this.limits.encodeTimeoutMs);
      if (status !== 0) throw fail('ENCODE_FAILED', `音频编码失败（${status}）。${logs.join(' ').slice(-500)}`);
      const data = await ffmpeg.readFile(output);
      if (!(data instanceof Uint8Array) || !data.byteLength) throw fail('EMPTY_OUTPUT', '编码器没有生成音频。');
      if (data.byteLength >= this.limits.maxOutputBytes) throw fail('OUTPUT_TOO_LARGE', `编码输出达到 ${this.limits.maxOutputBytes / MiB} MiB 上限，请分段导出。`);
      const blob = new Blob([data], {type: FORMATS[task.format].mime});
      this.state = 'ready'; this.lastError = null;
      notify(task.onProgress, {stage: 'encode', progress: 1});
      return blob;
    } finally {
      ffmpeg.off('log', log); ffmpeg.off('progress', progress);
      if (this.ffmpeg === ffmpeg && generation === this.generation && !task.controller.signal.aborted) {
        // Cleanup is inside the serial job; the next encoding cannot race these files.
        await Promise.allSettled([ffmpeg.deleteFile('input.wav'), ffmpeg.deleteFile(output)]);
      }
    }
  }
}

export const browserCodecs = new BrowserCodecs();
export const loadBrowserCodecs = options => browserCodecs.load(options);
export const encodeAudio = (wav, options) => browserCodecs.encode(wav, options);
export const getBrowserCodecState = () => browserCodecs.getState();
export const terminateBrowserCodecs = () => browserCodecs.terminate();
