import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {GLOBAL,HEADER,PREROLL,RUNNING,createRing,transportConfig} from '../js/dsp-protocol.js';
import {NBSOutputProcessor} from '../js/output-worklet.js';
import {WasmAudioEngine} from '../js/wasm-audio.js';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const end=performance.now()+10000;while(!predicate()){if(performance.now()>end)throw Error('Timed out waiting for Rust PCM');await wait(2);}}
function message(worker,type){return new Promise((resolve,reject)=>{const receive=data=>{if(data.type==='error'){worker.off('message',receive);reject(Error(data.message));}else if(data.type===type){worker.off('message',receive);resolve(data);}};worker.on('message',receive);worker.once('error',reject);});}
const shared=value=>{const pcm=new Float32Array(new SharedArrayBuffer(16*4));pcm.fill(value);return pcm.buffer;};
const makeSong=()=>({tempo:100,length:12,timeSignature:2,loop:false,layers:[{volume:100},{volume:100}],customInstruments:[{name:'Tempo Changer',file:''}],notes:[
  ...[0,4,8,10].map(tick=>({tick,layer:0,key:45,instrument:0,velocity:100})),{tick:4,layer:1,key:39,instrument:16,pitch:3000}]});
let compiled;
async function fixture(t,song,options,{metronome=false,muted=false,stress=false}={}){
  compiled||=WebAssembly.compile(await readFile(new URL('../wasm/nbs_dsp.wasm',import.meta.url)));
  const worker=new Worker(new URL('./dsp-worker-adapter.mjs',import.meta.url));t.after(()=>worker.terminate());
  const global=new SharedArrayBuffer(64),control=new Int32Array(global),ring=createRing(2,128),header=new Int32Array(ring.header),params=new Float32Array(ring.params);
  const ready=message(worker,'ready');worker.postMessage({type:'init',module:await compiled,global,ring,tracks:2,sampleRate:48000,blockFrames:128,leadBlocks:6,voicesPerTrack:4,samples:[{id:0,pcm:shared(.2)}]});await ready;
  for(let track=0;track<2;track++)params.set(muted?[0,1,1,0]:[1,0,0,1],track*4);
  const engine=new WasmAudioEngine(),events=engine._eventsFor(song,{tracks:2,ranges:[{start:0,end:2}]}),transport=transportConfig(song,options,48000);
  Atomics.store(control,GLOBAL.EPOCH,1);Atomics.store(control,GLOBAL.MODE,PREROLL);
  const prepared=message(worker,'prepared');worker.postMessage({type:'prepare',epoch:1,events:muted?[]:events[0],transport,stress,
    metronome:{enabled:metronome,timeSignature:2,samples:[{id:0,pcm:shared(-.3)},{id:1,pcm:shared(.6)}]}});await prepared;
  await until(()=>Atomics.load(header,HEADER.WRITE)>=6);
  const output=new NBSOutputProcessor({processorOptions:{global,rings:[ring],blockFrames:128}});
  Atomics.store(control,GLOBAL.MODE,RUNNING);worker.postMessage({type:'resume'});
  return {worker,control,header,transport,async consume(blocks){const result=new Float32Array(blocks*128),left=new Float32Array(128),right=new Float32Array(128);
    for(let block=0;block<blocks;block++){const sequence=Atomics.load(control,GLOBAL.READ);await until(()=>Atomics.load(header,HEADER.WRITE)>sequence);output.process([],[[left,right]]);result.set(left,block*128);}
    this.right=right.slice();return result;
  }};
}

test('actual Rust PCM follows Tempo Changer frames and excludes both ends outside a section',async t=>{
  const f=await fixture(t,makeSong(),{fromTick:2,endTick:10}),pcm=await f.consume(23),active=[];
  for(let frame=0;frame<pcm.length;frame++)if(Math.abs(pcm[frame])>1e-6)active.push(frame);
  assert.deepEqual(active,[...Array.from({length:16},(_,i)=>960+i),...Array.from({length:16},(_,i)=>1920+i)]);
  assert.equal(f.transport.endFrame,2400);assert.equal(Atomics.load(f.control,GLOBAL.UNDERRUNS),0);
});

test('actual Rust metronome has alternating bar accents, follows section loops and bypasses muted track mix',async t=>{
  const f=await fixture(t,makeSong(),{fromTick:2,endTick:10,loop:true,loopStart:2,loopCount:1},{metronome:true,muted:true}),pcm=await f.consume(41);
  for(const frame of [960,3360])assert(pcm[frame]<-.2,`ordinary click ${frame}`);
  for(const frame of [1920,4320])assert(pcm[frame]>.4,`bar accent ${frame}`);
  assert.equal(pcm.filter(value=>Math.abs(value)>1e-6).length,64);assert.equal(f.transport.endFrame,4800);
  assert.equal(Atomics.load(f.header,HEADER.ACTIVE),0,'clicks do not masquerade as active song tracks');
  assert.equal(Atomics.load(f.control,GLOBAL.UNDERRUNS),0);
});

test('live metronome toggle preserves the main epoch and consumption clock without prebuffer restart',async t=>{
  const f=await fixture(t,makeSong(),{fromTick:2,endTick:10,loop:true,loopStart:2},{metronome:true,muted:true});
  await f.consume(37);const before=Atomics.load(f.control,GLOBAL.READ),disabled=message(f.worker,'metronomeApplied');
  f.worker.postMessage({type:'metronome',epoch:1,enabled:false,timeSignature:2});const off=await disabled;
  const silent=await f.consume(20),silenceAfter=Math.max(0,off.sequence*128-before*128)+128;
  assert(silent.subarray(silenceAfter).every(value=>value===0));
  const enabled=message(f.worker,'metronomeApplied');f.worker.postMessage({type:'metronome',epoch:1,enabled:true,timeSignature:2});await enabled;
  const audible=await f.consume(40);assert(audible.some(value=>Math.abs(value)>.2));
  assert.equal(Atomics.load(f.control,GLOBAL.EPOCH),1);assert(Atomics.load(f.control,GLOBAL.READ)>before);assert.equal(Atomics.load(f.control,GLOBAL.UNDERRUNS),0);
});

test('actual Rust stereo can switch to equal mono output and back without resetting voices or epoch',async t=>{
  const s=makeSong();s.notes=s.notes.map(note=>({...note,pan:-100}));
  const f=await fixture(t,s,{}, {stress:true}),left=await f.consume(1);
  assert(left.some(value=>value>.1));assert(f.right.every(value=>value===0));
  const active=Atomics.load(f.header,HEADER.ACTIVE);Atomics.store(f.control,GLOBAL.MONO,1);
  const mono=await f.consume(1);assert.deepEqual(mono,f.right);assert(mono.some(value=>value>.05));
  Atomics.store(f.control,GLOBAL.MONO,0);const stereo=await f.consume(1);assert(stereo.some(value=>value>.1));assert(f.right.every(value=>value===0));
  assert.equal(Atomics.load(f.header,HEADER.ACTIVE),active);assert.equal(Atomics.load(f.control,GLOBAL.EPOCH),1);assert.equal(Atomics.load(f.control,GLOBAL.READ),3);assert.equal(Atomics.load(f.control,GLOBAL.UNDERRUNS),0);
});

test('drain stops future metronome/event scheduling and rejects re-enable without resetting the ring',async t=>{
  const f=await fixture(t,makeSong(),{fromTick:2,endTick:10,loop:true,loopStart:2},{metronome:true,muted:true});
  await f.consume(1);const before=Atomics.load(f.control,GLOBAL.READ),drained=message(f.worker,'drained');
  f.worker.postMessage({type:'drain',epoch:1});const ack=await drained;
  const enabled=message(f.worker,'metronomeApplied');f.worker.postMessage({type:'metronome',epoch:1,enabled:true,timeSignature:2});
  assert.equal((await enabled).enabled,false,'a stale/UI metronome message cannot restart paused beats');
  f.worker.postMessage({type:'events',epoch:1,events:[{tick:8,track:0,sample:0,rate:1,gain:1,pan:0}]});
  const pcm=await f.consume(50),after=(ack.sequence-before)*128+128;
  assert(pcm.subarray(after).every(value=>value===0));
  assert.equal(Atomics.load(f.control,GLOBAL.EPOCH),1);assert.equal(Atomics.load(f.control,GLOBAL.MODE),RUNNING);
  assert(Atomics.load(f.control,GLOBAL.READ)>before);assert.equal(Atomics.load(f.header,HEADER.ACTIVE),0);
  assert.equal(Atomics.load(f.control,GLOBAL.UNDERRUNS),0);
});
