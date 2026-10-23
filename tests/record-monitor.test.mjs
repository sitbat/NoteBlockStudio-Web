import test from 'node:test';
import assert from 'node:assert/strict';
import {WasmAudioEngine} from '../js/wasm-audio.js';
import {EventTimeline, transportConfig} from '../js/dsp-protocol.js';

const note = {id: 'recorded', tick: 0, layer: 0, key: 45, instrument: 0, velocity: 100};
const song = () => ({tempo: 10, length: 4, loop: true, layers: [{volume: 100}], notes: [{...note}]});
const pool = {tracks: 1, ranges: [{start: 0, end: 1}]};

test('record monitor marks synchronously, auditions immediately and restores later loop onsets', async () => {
  const audio = new WasmAudioEngine({context: {sampleRate: 1000}}), s = song(), before = JSON.stringify(s);
  let resolve, call;
  audio.triggerLive = (n, options) => { call = {n, options}; return new Promise(done => { resolve = done; }); };
  const pending = audio.monitorRecordedNote(s.notes[0], {layer: s.layers[0]});
  assert.equal(call.n, s.notes[0]); assert.equal(call.options.layer, s.layers[0]); assert.equal(call.options.channel, 0);
  assert.equal(audio._eventsFor(s, pool)[0][0].notBeforeFrame, Number.MAX_SAFE_INTEGER, 'pending init also prevents an initial double onset');
  resolve({accepted: true, activeVoices: 1}); assert.equal((await pending).accepted, true);
  const events = audio._eventsFor(s, pool)[0], threshold = events[0].notBeforeFrame;
  assert.ok(threshold > 900 && threshold <= 1000);
  const timeline = new EventTimeline(events, transportConfig(s, {}, 1000)), heard = [];
  for (let frame = 0; frame < 2000; frame += 100) timeline.dispatch(frame, 100, (_event, offset) => heard.push(frame + offset));
  assert.deepEqual(heard, [1200, 1600], 'short loops skip only the one-second window and recover without a new edit');
  assert.equal(JSON.stringify(s), before, 'runtime suppression is never stored in the song');
  audio.playing = true; audio._playedFrames = () => 2000;
  const rebased = audio._eventsFor(s, pool)[0][0].notBeforeFrame;
  assert.ok(rebased > 2900 && rebased <= 3000, 'event replacement uses the consumed audio clock');
  audio.playing = false;
  audio._recordedMonitors.get('recorded').expiresAt = performance.now() - 1;
  assert.equal(audio._eventsFor(s, pool)[0][0].notBeforeFrame, undefined, 'expired marks vanish on a new play/seek snapshot');
});

test('rejected monitoring rolls back suppression and controls are never auditioned or suppressed', async () => {
  const audio = new WasmAudioEngine(), s = song();
  audio.triggerLive = async () => { throw new Error('voice unavailable'); };
  await assert.rejects(audio.monitorRecordedNote(s.notes[0]), /unavailable/);
  assert.equal(audio._recordedMonitors.size, 0);
  audio.triggerLive = async () => ({accepted: false});
  assert.equal((await audio.monitorRecordedNote(s.notes[0])).accepted, false);
  assert.equal(audio._recordedMonitors.size, 0);
  audio.customInstruments = [{name: 'Tempo Changer'}];
  audio.triggerLive = () => assert.fail('control notes must not enter the sample voice pool');
  assert.deepEqual(await audio.monitorRecordedNote({...note, instrument: 16}), {accepted: false, activeVoices: 0, control: true});
  assert.equal(audio._recordedMonitors.size, 0);
});

test('stop cancels runtime marks and late monitoring replies cannot restore them', async () => {
  const audio = new WasmAudioEngine(); let resolve;
  audio.triggerLive = () => new Promise(done => { resolve = done; });
  const pending = audio.monitorRecordedNote(note);
  assert.equal(audio._recordedMonitors.size, 1);
  audio.stop(); assert.equal(audio._recordedMonitors.size, 0);
  resolve({accepted: true, activeVoices: 1}); await pending;
  assert.equal(audio._recordedMonitors.size, 0);
  await assert.rejects(audio.monitorRecordedNote({...note, id: undefined}), /唯一 ID/);
});
