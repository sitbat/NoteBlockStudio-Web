import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserCodecs, codecArguments, inspectCodecWav, getBrowserCodecState} from '../js/browser-codecs.js';
import {encodeWav} from '../js/audio.js';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
async function input(rate = 48000) {
  const pcm = Float32Array.from({length: 96}, (_, i) => Math.sin(i / 4) * 0.5);
  return new Uint8Array(await encodeWav({length: pcm.length, numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm}).arrayBuffer());
}
class FakeFFmpeg {
  loaded = false; events = new Map(); calls = []; files = new Map(); terminated = false;
  constructor({hold, cleanupHold, status = 0, size = 100} = {}) { Object.assign(this, {hold, cleanupHold, status, size}); }
  on(type, fn) { this.events.set(type, fn); }
  off(type) { this.events.delete(type); }
  async load(config) { this.calls.push(['load', config]); this.loaded = true; }
  async writeFile(path, data) { this.calls.push(['write', path]); this.files.set(path, structuredClone(data, {transfer: [data.buffer]})); }
  async exec(args, timeout) {
    this.calls.push(['exec', args, timeout]);
    this.events.get('progress')?.({progress: 0.5, time: 500000});
    if (this.hold) await this.hold.promise;
    return this.status;
  }
  async readFile(path) { this.calls.push(['read', path]); return new Uint8Array(this.size).fill(1); }
  async deleteFile(path) { this.calls.push(['delete', path]); if (this.cleanupHold) await this.cleanupHold.promise; this.files.delete(path); }
  terminate() { this.terminated = true; this.loaded = false; this.hold?.resolve(); this.cleanupHold?.resolve(); }
}

test('codec options use a fixed local-file argument list and enforce format sample rates', () => {
  const args = codecArguments({format: 'mp3', rate: 44100, channels: 1, bitrate: 192});
  assert.equal(args.at(-1), 'output.mp3'); assert.equal(args[args.indexOf('-b:a') + 1], '192k');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  for (const options of [{format:'url'}, {format:'mp3', rate:96000}, {format:'ogg',rate:384000}, {channels:3}, {bitrate:Infinity}, {rate:7999}]) assert.throws(() => codecArguments(options));
  assert.doesNotThrow(() => codecArguments({format:'flac',rate:384000}));
  assert.equal(getBrowserCodecState().state, 'idle');
});

test('WAV inspector validates actual PCM boundaries without trusting names', async () => {
  for (const rate of [8000,48000,384000]) assert.equal(inspectCodecWav(await input(rate)).sampleRate, rate);
  for (const patch of [[0,0],[32,0]]) {
    const bytes = await input(); bytes[patch[0]] = patch[1];
    assert.throws(() => inspectCodecWav(bytes), {code:'INVALID_WAV'});
  }
  const lowRate = await input(); new DataView(lowRate.buffer).setUint32(24, 7999, true);
  assert.throws(() => inspectCodecWav(lowRate), {code:'INVALID_WAV'});
  const invalid = await input(); new DataView(invalid.buffer).setUint32(4, 0xffffffff, true);
  assert.throws(() => inspectCodecWav(invalid), {code:'INVALID_WAV'});
});

test('real caller buffer stays attached, local assets are explicit, five output MIME types', async () => {
  const ff = new FakeFFmpeg(), codecs = new BrowserCodecs({ffmpegFactory: () => ff});
  const wav = await input(), original = wav.slice(), events = [];
  for (const [format, mime] of Object.entries({mp3:'audio/mpeg',flac:'audio/flac',aiff:'audio/aiff',ogg:'audio/ogg',wav:'audio/wav'})) {
    const blob = await codecs.encode(wav, {format, onProgress: event => events.push(event)});
    assert.equal(blob.type, mime); assert.equal(blob.size, 100); assert.deepEqual(wav, original);
    assert.equal(ff.files.size, 0);
  }
  const loads = ff.calls.filter(call => call[0] === 'load'); assert.equal(loads.length, 1);
  for (const value of Object.values(loads[0][1])) assert.match(value, /\/vendor\/ffmpeg\//);
  assert(events.some(event => event.stage === 'load' && event.progress === 1));
  assert(events.some(event => event.stage === 'encode' && event.progress === .5 && event.time === .5));
  assert.equal(codecs.getState().state, 'ready'); codecs.terminate();
});

test('next serial encode waits for file cleanup and enforces bounded queue', async () => {
  const cleanupHold = gate(), ff = new FakeFFmpeg({cleanupHold});
  const codecs = new BrowserCodecs({ffmpegFactory: () => ff, maxTasks: 2});
  const wav = await input(), first = codecs.encode(wav), second = codecs.encode(wav);
  await assert.rejects(codecs.encode(wav), {code:'QUEUE_FULL'});
  while (!ff.calls.some(call => call[0] === 'delete')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ff.calls.filter(call => call[0] === 'exec').length, 1);
  cleanupHold.resolve(); await Promise.all([first, second]);
  assert.equal(ff.calls.filter(call => call[0] === 'exec').length, 2); assert.equal(codecs.getState().queued, 0);
  codecs.terminate();
});

test('aborting queued request does not stop active encode; aborting active worker permits fresh load', async () => {
  const hold = gate(), firstFF = new FakeFFmpeg({hold}), instances = [];
  const codecs = new BrowserCodecs({ffmpegFactory: () => { const ff = instances.length ? new FakeFFmpeg() : firstFF; instances.push(ff); return ff; }});
  const wav = await input(), activeAbort = new AbortController(), queuedAbort = new AbortController();
  const first = codecs.encode(wav, {signal: activeAbort.signal}), queued = codecs.encode(wav, {signal: queuedAbort.signal});
  const firstRejected = assert.rejects(first, {name:'AbortError'}), queuedRejected = assert.rejects(queued, {name:'AbortError'});
  queuedAbort.abort(); await queuedRejected; assert.equal(firstFF.terminated, false);
  while (!firstFF.calls.some(call => call[0] === 'exec')) await new Promise(resolve => setImmediate(resolve));
  activeAbort.abort(); await firstRejected; assert.equal(firstFF.terminated, true);
  assert.equal((await codecs.encode(wav)).size, 100); assert.equal(instances.length, 2); codecs.terminate();
});

test('input/output limits, worker error and timeout recover rather than poisoning later jobs', async () => {
  const wav = await input(), bad = new FakeFFmpeg({status: 1}), good = new FakeFFmpeg(), instances = [bad, good];
  const codecs = new BrowserCodecs({ffmpegFactory: () => instances.shift()});
  await assert.rejects(codecs.encode(wav), {code:'ENCODE_FAILED'}); assert(bad.terminated);
  assert.equal((await codecs.encode(wav)).size, 100); codecs.terminate();
  const tiny = new BrowserCodecs({maxInputBytes: 44, ffmpegFactory: () => { throw Error('must not load'); }});
  await assert.rejects(tiny.encode(wav), {code:'INPUT_TOO_LARGE'});
  const large = new BrowserCodecs({maxOutputBytes: 100, ffmpegFactory: () => new FakeFFmpeg()});
  await assert.rejects(large.encode(wav), {code:'OUTPUT_TOO_LARGE'}); large.terminate();
  const hold = gate(), hung = new FakeFFmpeg({hold}), timeout = new BrowserCodecs({encodeTimeoutMs: 20, ffmpegFactory: () => hung});
  await assert.rejects(timeout.encode(wav), {code:'CODEC_TIMEOUT'}); assert(hung.terminated); timeout.terminate();
});

test('terminate rejects active and queued work and resets public state', async () => {
  const hold = gate(), ff = new FakeFFmpeg({hold}), codecs = new BrowserCodecs({ffmpegFactory: () => ff});
  const wav = await input(), first = codecs.encode(wav), second = codecs.encode(wav);
  const settled = Promise.allSettled([first, second]); codecs.terminate();
  const results = await settled; assert(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(codecs.getState().state, 'idle'); assert.equal(codecs.getState().active, false); assert.equal(codecs.getState().queued, 0);
});
