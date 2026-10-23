// Real vendored FFmpeg WASM executes here; Node supplies a test-only browser shim.
// Production uses the upstream module Worker, independently checked in the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BrowserCodecs, inspectCodecWav} from '../js/browser-codecs.js';
import {encodeWav} from '../js/audio.js';

test('real FFmpeg WASM encodes all five formats and decodes nonzero stereo PCM at requested rate', async () => {
  const coreURL = new URL('../vendor/ffmpeg/core/ffmpeg-core.js', import.meta.url);
  const wasm = new Uint8Array(await readFile(new URL('../vendor/ffmpeg/core/ffmpeg-core.wasm', import.meta.url)));
  assert.equal(createHash('sha256').update(wasm).digest('hex'), '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7');
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self'), originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.self = globalThis; globalThis.location = {href: coreURL.href};
  const {default:createCore} = await import(coreURL.href);
  const core = await createCore({wasmBinary: wasm});
  const listeners = new Map(), versionLogs = [];
  core.setLogger(data => { versionLogs.push(data.message); listeners.get('log')?.(data); });
  core.setProgress(data => listeners.get('progress')?.(data));
  core.exec('-version'); assert.match(versionLogs[0], /^ffmpeg version 5\.1\.4/); core.reset();
  const ffmpeg = {
    loaded: false,
    async load() { this.loaded = true; },
    on(type, callback) { listeners.set(type, callback); }, off(type) { listeners.delete(type); },
    async writeFile(path, data) { core.FS.writeFile(path, data); },
    async exec(args) { const code = core.exec(...args); core.reset(); return code; },
    async readFile(path) { return core.FS.readFile(path); },
    async deleteFile(path) { core.FS.unlink(path); },
    terminate() { this.loaded = false; },
  };
  const codecs = new BrowserCodecs({ffmpegFactory: () => ffmpeg});
  try {
    const pcm = Float32Array.from({length:4800}, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 48000) * .4);
    const input = encodeWav({length:pcm.length,numberOfChannels:1,sampleRate:48000,getChannelData:()=>pcm});
    for (const format of ['mp3','flac','aiff','ogg','wav']) {
      const encoded = await codecs.encode(input, {format, rate:44100, channels:2, bitrate:192});
      assert(encoded.size > 100, format);
      core.FS.writeFile(`encoded.${format}`, new Uint8Array(await encoded.arrayBuffer()));
      assert.equal(core.exec('-v','error','-protocol_whitelist','file,pipe','-i',`encoded.${format}`,'-c:a','pcm_s16le','-f','wav','decoded.wav'), 0, format);
      core.reset();
      const decoded = core.FS.readFile('decoded.wav'), info = inspectCodecWav(decoded);
      assert.equal(info.sampleRate, 44100, format); assert.equal(info.channels, 2, format);
      assert(info.duration > .05 && info.duration < .3, `${format}: ${info.duration}`);
      assert(decoded.some((value, i) => i > decoded.length / 2 && value !== 0), format);
      core.FS.unlink(`encoded.${format}`); core.FS.unlink('decoded.wav');
    }
  } finally {
    codecs.terminate();
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf); else delete globalThis.self;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
  }
});
