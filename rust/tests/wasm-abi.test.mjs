import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const module = await WebAssembly.compile(await readFile(new URL('../../wasm/nbs_dsp.wasm', import.meta.url)));
class Engine {
  constructor(tracks = 1, frames = 128, voices = tracks * 4, compiled = module) {
    this.api = new WebAssembly.Instance(compiled, {}).exports;
    this.frames = frames;
    this.handle = this.api.engine_create(tracks, 48000, frames, voices);
    assert.notEqual(this.handle, 0);
  }
  sample(data, id = 0) {
    const pointer = this.api.engine_sample_alloc(this.handle, id, data.length);
    assert.notEqual(pointer, 0);
    new Float32Array(this.api.memory.buffer, pointer, data.length).set(data);
  }
  track(track = 0, gain = 1, pan = 0, reverb = 0, enabled = 1) {
    return this.api.engine_track(this.handle, track, gain, pan, reverb, enabled);
  }
  voice(track = 0, sample = 0, rate = 1, gain = 1, pan = 0, onset = 0, loop = 0) {
    return this.api.engine_voice(this.handle, track, sample, rate, gain, pan, onset, loop);
  }
  render() {
    const pointer = this.api.engine_render(this.handle);
    return new Float32Array(this.api.memory.buffer, pointer, this.frames * 2).slice();
  }
  destroy() { this.api.engine_destroy(this.handle); }
}
const near = (actual, expected, epsilon = 1e-5) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`);

test('real WASM exposes the documented ABI and SIMD build', () => {
  const e = new Engine();
  for (const name of ['engine_create','engine_destroy','engine_sample_alloc','engine_track','engine_voice','engine_render','engine_reset','engine_active_voices','engine_dropped_voices','engine_peak','engine_wasm_simd']) assert.equal(typeof e.api[name], 'function', name);
  assert.equal(e.api.engine_wasm_simd(), 1);
  assert.equal(e.api.engine_sample_rate(e.handle), 48000);
  assert.equal(e.track(), 1);
  assert.equal(e.track(2), 0);
  e.destroy();
});

test('dry sample onset, track gain, note gain and stereo pan are exact', () => {
  const e = new Engine(1, 8); e.sample([1, 0.5, 0]); e.track(0, 0.5, -1);
  assert.equal(e.voice(0, 0, 1, 0.5, -1, 2), 1);
  assert.deepEqual([...e.render()], [0,0,0.25,0.125,0,0,0,0,0,0,0,0,0,0,0,0]);
  assert.equal(e.api.engine_active_voices(e.handle), 0);
  e.destroy();
});

test('pitch interpolation and looping retain the expected sample phase', () => {
  const e = new Engine(1, 8); e.sample([0,1,0]); e.track(0, 1, -1);
  e.voice(0,0,0.5,1,-1);
  assert.deepEqual([...e.render().slice(0,8)], [0,0.5,1,0.5,0,0,0,0]);
  e.api.engine_reset(e.handle);
  e.voice(0,0,1,1,-1,0,1);
  assert.deepEqual([...e.render().slice(0,8)], [0,1,0,0,1,0,0,1]);
  assert.deepEqual([...e.render().slice(0,8)], [0,0,1,0,0,1,0,0]);
  assert.equal(e.api.engine_active_voices(e.handle), 1);
  e.destroy();
});

test('zero reverb is dry while full reverb produces a delayed stereo tail', () => {
  const dry = new Engine(); dry.sample([1]); dry.track(0,1,0,0); dry.voice();
  const first = dry.render(); near(first[0], Math.SQRT1_2); near(first[128], Math.SQRT1_2);
  for (let block=0;block<30;block++) assert.equal(dry.render().some(value=>value!==0),false);
  dry.destroy();
  const wet = new Engine(); wet.sample([1]); wet.track(0,1,0,1); wet.voice();
  let left=0,right=0;
  for(let block=0;block<30;block++) {
    const out=wet.render();
    if(block<4) assert.equal(out.some(value=>value!==0),false);
    for(let i=0;i<128;i++){left+=Math.abs(out[i]);right+=Math.abs(out[128+i]);}
  }
  assert.ok(left>0.1 && right>0.1);
  wet.api.engine_reset(wet.handle);
  assert.equal(wet.render().some(value=>value!==0),false);
  wet.destroy();
});

test('track reverb lanes cannot leak a muted source tail into other enabled tracks', () => {
  const e=new Engine(4);
  e.sample([1]); for(let i=0;i<4;i++)e.track(i,1,0,1);
  e.voice(0); e.render(); e.track(0,1,0,1,0);
  for(let i=0;i<40;i++) assert.equal(e.render().some(value=>Math.abs(value)>1e-12),false,`tail leaked at block ${i}`);
  e.destroy();
});

test('fixed voice capacity is reported honestly and reset restores the pool', () => {
  const e=new Engine(1,128,2);e.sample([1]);e.track();
  assert.equal(e.voice(0,0,1,1,0,0,1),1);assert.equal(e.voice(0,0,1,1,0,0,1),1);assert.equal(e.voice(),0);
  assert.equal(e.api.engine_active_voices(e.handle),2);assert.equal(e.api.engine_dropped_voices(e.handle),1);
  const memory=e.api.memory.buffer.byteLength;
  for(let i=0;i<100;i++)e.render();
  assert.equal(e.api.memory.buffer.byteLength,memory,'render grew WASM memory');
  e.api.engine_reset(e.handle);assert.equal(e.api.engine_active_voices(e.handle),0);assert.equal(e.api.engine_dropped_voices(e.handle),0);
  assert.equal(e.voice(),1);e.destroy();
});

test('muting, invalid parameters and nonfinite PCM never output invalid numbers', () => {
  const e=new Engine();e.sample([NaN,Infinity,-Infinity,1]);e.track(0,1,0,0.5,0);
  e.voice(0,0,1,1,0,0,1);assert.equal(e.render().some(value=>value!==0),false);
  assert.equal(e.voice(0,0,NaN),0);assert.equal(e.voice(0,0,1,Infinity),0);
  e.track(0,NaN,NaN,NaN,1);
  for(let i=0;i<30;i++)assert.equal(e.render().every(Number.isFinite),true);
  assert.equal(Number.isFinite(e.api.engine_peak(e.handle)),true);e.destroy();
});

test('gain changes finish smoothly in 32 samples including partial render blocks', () => {
  const e=new Engine(2,16);e.sample([1]);e.track(0,1,-1);e.track(1,1,1);
  e.voice(0,0,1,1,-1,0,1);e.voice(1,0,1,1,1,0,1);e.render();
  e.track(0,0,-1);let out=e.render();near(out[0],31/32);near(out[15],0.5);near(out[16],1);
  e.track(1,0,1);out=e.render();near(out[0],15/32);near(out[15],0);near(out[16],31/32);near(out[31],0.5);
  out=e.render();near(out[0],0);near(out[16],15/32);near(out[31],0);e.destroy();
});

const scalarPath=process.env.NBS_SCALAR_WASM;
test('native pan preserves note pan on a centred layer and averages on other layers', () => {
  for (const [layerPan,notePan,expected] of [[0,-1,-1],[0,1,1],[-1,0,-.5],[1,0,.5],[.4,-.1,.15],[-1,1,0],[1,-1,0],[-1,-1,-1],[1,1,1]]) {
    const e=new Engine(1,8);e.sample([1]);e.track(0,1,layerPan);e.voice(0,0,1,1,notePan);
    const out=e.render();near(out[0],Math.sqrt((1-expected)/2));near(out[8],Math.sqrt((1+expected)/2));e.destroy();
  }
});
test('SIMD matches the independently compiled scalar reverb across lanes, groups and gain ramps',{skip:!scalarPath},async()=>{
  const scalarModule=await WebAssembly.compile(await readFile(scalarPath));
  const simd=new Engine(9,16,64),scalar=new Engine(9,16,64,scalarModule);
  assert.equal(scalar.api.engine_wasm_simd(),0);
  const pcm=Array.from({length:129},(_,i)=>Math.sin(i*0.19)*0.1);
  for(const e of [simd,scalar]){
    e.sample(pcm);
    for(let t=0;t<9;t++){e.track(t,0.4+t*0.03,(t-4)/5,0.2+t*0.08);e.voice(t,0,0.5+t*0.15,0.7,(t%3-1)*0.1,t,1);}
  }
  let maxDifference=0;
  for(let block=0;block<400;block++){
    if(block===50)for(const e of [simd,scalar])e.track(1,0.1,0.4,0.9);
    if(block===51)for(const e of [simd,scalar])e.track(2,0.7,-0.4,0.7);
    const a=simd.render(),b=scalar.render();
    for(let i=0;i<a.length;i++)maxDifference=Math.max(maxDifference,Math.abs(a[i]-b[i]));
  }
  assert.ok(maxDifference<1e-5,`SIMD/scalar difference ${maxDifference}`);
  simd.destroy();scalar.destroy();
});
