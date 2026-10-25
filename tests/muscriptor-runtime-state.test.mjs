import test from 'node:test';
import assert from 'node:assert/strict';
import {MuscriptorONNX,chooseTranscriptionBackend,greedyMuscriptorToken} from '../js/muscriptor-onnx.js';
import {MT3,CHUNK_SAMPLES} from '../js/transcription-dsp.js';

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const audio=()=>new Float32Array(CHUNK_SAMPLES);
// These protocol doubles test lifecycle/metrics only; numerical graph parity is
// tested separately against actual ONNX Runtime Web in muscriptor-onnx.test.mjs.
function fixture(sequence=[MT3.eos],{beforeRun}={}){
  const tensors=[],calls=[];let clock=0,index=0;
  class Tensor{
    constructor(type,data,dims){Object.assign(this,{type,data,dims,location:'cpu',disposed:false});tensors.push(this);}
    dispose(){this.disposed=true;}
    async getData(){clock+=2;return this.data;}
  }
  const m={id:'protocol-fixture',layers:1,heads:1,headDim:2,melFrames:501,melBins:512,prefixLength:503,card:1393,bos:1393,maxTokens:2000};
  const outputs=position=>{
    const data=new Float32Array(MT3.size).fill(-100);data[sequence[Math.min(index++,sequence.length-1)]]=1;
    return {logits:new Tensor('float32',data,[1,m.card]),present_key_0:new Tensor('float32',new Float32Array(position*2),[1,1,position,2]),present_value_0:new Tensor('float32',new Float32Array(position*2),[1,1,position,2])};
  };
  const session=name=>({run:async feeds=>{calls.push([name,feeds]);await beforeRun?.(name,feeds);clock+=name==='prefill'?5:3;return outputs(name==='prefill'?503+feeds.tokens.dims[1]:Number(feeds.position.data[0])+1);},release:async()=>calls.push(['release',name])});
  const engine=new MuscriptorONNX(m,{ort:{Tensor},now:()=>clock});engine.loaded=true;engine.backend='wasm';engine.prefill=session('prefill');engine.step=session('step');engine.mel={compute:()=>{clock+=1;return new Float32Array(501*512);}};
  return {engine,calls,tensors,advance:value=>{clock+=value;}};
}

test('explicit CPU selection never asks the browser for an unrelated GPU adapter',async()=>{
  let requested=0;
  assert.equal(await chooseTranscriptionBackend('wasm',{}, {gpu:{requestAdapter:async()=>{requested++;throw new Error('unexpected GPU probe');}}}),'wasm');
  assert.equal(requested,0);
});

test('runtime reports processing time separately from an intentional user pause',async t=>{
  let paused=false;const f=fixture([MT3.eos],{beforeRun:async()=>{paused=true;}});t.after(()=>f.engine.release());let waits=0;
  const result=await f.engine.inferChunk(audio(),{isPaused:()=>paused,wait:async()=>{waits++;if(waits===2){f.advance(500);paused=false;}}});
  assert.equal(result.milliseconds,8);assert.equal(result.wallMilliseconds,508);assert.equal(result.pausedMilliseconds,500);
  assert.equal(result.metrics.prefillMs,5);assert.equal(result.metrics.logitReadMs,2);assert.equal(result.metrics.steps,0);assert.equal(result.metrics.tokens,1);
  assert.equal(result.metrics.status,'completed');assert.deepEqual(result.metrics.cacheLocations,['cpu']);
  assert.equal(f.engine.chunks,1);assert(f.tensors.every(tensor=>tensor.disposed));
});

test('ordinary scheduling delays remain processing time while the user has not paused',async t=>{
  const f=fixture();t.after(()=>f.engine.release());let waits=0;
  const result=await f.engine.inferChunk(audio(),{isPaused:()=>false,wait:async()=>{if(++waits===2)f.advance(500);}});
  assert.equal(result.milliseconds,508);assert.equal(result.wallMilliseconds,508);assert.equal(result.pausedMilliseconds,0);
});

test('releasing a paused runtime wakes it, drains outstanding work and then releases sessions',async()=>{
  const f=fixture(),entered=deferred(),never=deferred();let waits=0;
  const pending=f.engine.inferChunk(audio(),{wait:async()=>{if(++waits===2){entered.resolve();await never.promise;}}});
  await entered.promise;assert.equal(f.calls.filter(([name])=>name==='release').length,0);
  const rejected=assert.rejects(pending,error=>error.name==='AbortError');
  await f.engine.release();await rejected;
  assert.equal(f.engine.lastMetrics.status,'cancelled');assert.equal(f.calls.filter(([name])=>name==='release').length,2);assert(f.tensors.every(tensor=>tensor.disposed));
  await f.engine.release();assert.equal(f.calls.filter(([name])=>name==='release').length,2,'release is idempotent');
});

test('one runtime never overlaps probe or a second decode with an active kernel',async t=>{
  const entered=deferred(),gate=deferred(),f=fixture([MT3.eos],{beforeRun:async()=>{entered.resolve();await gate.promise;}});t.after(()=>f.engine.release());
  const pending=f.engine.inferChunk(audio());await entered.promise;
  await assert.rejects(f.engine.probe(),{code:'MODEL_BUSY'});
  await assert.rejects(f.engine.inferChunk(audio()),{code:'MODEL_BUSY'});
  gate.resolve();await pending;
  await f.engine.inferChunk(audio());assert.equal(f.engine.chunks,2,'the drained runtime accepts a later job');
});

test('forced tie prompts consume the upstream total token budget and skip an unused last step',async t=>{
  const f=fixture([MT3.tie,MT3.tie]);t.after(()=>f.engine.release());
  await assert.rejects(f.engine.inferChunk(audio(),{maxTokens:2}),{code:'GENERATION_LIMIT'});
  assert.equal(f.calls.filter(([name])=>name==='step').length,1);assert.equal(f.engine.lastMetrics.tokens,2);assert.equal(f.engine.lastMetrics.steps,1);
  f.engine.chunks=1;f.engine.decoder.promptTokens=()=>[1393,1135,1064,1134];
  const before=f.calls.length;
  await assert.rejects(f.engine.inferChunk(audio(),{maxTokens:3}),{code:'PROMPT_LIMIT'});
  assert.equal(f.calls.length,before,'oversized prompt is rejected before graph execution');assert(f.tensors.every(tensor=>tensor.disposed));
});

test('old KV caches are disposed before pausing on the next step result',async t=>{
  const f=fixture([MT3.tie,MT3.eos]);t.after(()=>f.engine.release());let waits=0,previous;
  await f.engine.inferChunk(audio(),{wait:async()=>{
    waits++;
    if(waits===2)previous=f.tensors.filter(tensor=>tensor.dims.length===4);
    if(waits===3){assert.equal(previous.length,2);assert(previous.every(tensor=>tensor.disposed));}
  }});
  assert.equal(f.engine.lastMetrics.steps,1);assert.equal(f.engine.lastMetrics.concatOutputBytesEstimate,2*1*1*2*505*4);
  assert.equal(f.engine.lastMetrics.peakLogicalKVBytes,2*1*1*2*(504+505)*4);
});

test('first-note metric is not falsely satisfied by notes from previous chunks',async t=>{
  const f=fixture();t.after(()=>f.engine.release());f.engine.decoder.notes.push({program:0,midiKey:60,startSeconds:0,endSeconds:.1});
  await f.engine.inferChunk(audio());assert.equal(f.engine.lastMetrics.firstNoteMs,null);
});

test('nonfinite PCM never reaches preprocessing or a model kernel',async t=>{
  const f=fixture();t.after(()=>f.engine.release());const pcm=audio();pcm[100]=NaN;
  await assert.rejects(f.engine.inferChunk(pcm),{code:'AUDIO_INVALID'});assert.equal(f.calls.length,0);assert.equal(f.engine._activeWork,null);
});

function installProtocolDecoder(f,batch=8){
  const Tensor=f.engine.ort.Tensor;f.engine.tokenBatchSize=batch;
  f.engine.tokenDecoder={run:async({logits,history_in})=>{const token=greedyMuscriptorToken(logits.data),history=new Float32Array(history_in.data.length+2);history.set(history_in.data);history.set([token,1],history.length-2);const value=new Tensor('int64',BigInt64Array.of(BigInt(token)),[1,1]);value.location='gpu-buffer';return {token:value,history_out:new Tensor('float32',history,[1,history.length])};},release:async()=>{}};
}

test('batched decoding discards guesses after the first EOS and never exceeds the total budget',async t=>{
  const f=fixture([MT3.tie,MT3.eos,74,74,74,74,74,74]);t.after(()=>f.engine.release());installProtocolDecoder(f);
  const accepted=[];f.engine.decoder.push=token=>accepted.push(token);
  const result=await f.engine.inferChunk(audio(),{maxTokens:8});
  assert.deepEqual(accepted,[MT3.tie]);assert.equal(result.metrics.tokens,2);assert.equal(result.metrics.discardedTokens,6);assert.equal(result.metrics.steps,7);assert.equal(result.metrics.tokenReadBatches,1);assert.equal(f.calls.filter(([name])=>name==='step').length,7);assert(f.tensors.every(tensor=>tensor.disposed));
  const one=fixture([MT3.eos]);t.after(()=>one.engine.release());installProtocolDecoder(one);
  const single=await one.engine.inferChunk(audio(),{maxTokens:1});assert.equal(single.metrics.tokens,1);assert.equal(single.metrics.steps,0);assert.equal(single.metrics.discardedTokens,0);
});

test('a failed device-token feed retries the same position with a CPU token without losing notes',async t=>{
  let injected=false;const f=fixture([MT3.tie,MT3.eos],{beforeRun:async(name,feeds)=>{if(name==='step'&&feeds.token.location==='gpu-buffer'&&!injected){injected=true;throw new Error('injected device input failure');}}});t.after(()=>f.engine.release());installProtocolDecoder(f);
  const accepted=[];f.engine.decoder.push=token=>accepted.push(token);
  const result=await f.engine.inferChunk(audio(),{maxTokens:4});assert.deepEqual(accepted,[MT3.tie]);assert.equal(result.metrics.tokens,2);assert.equal(result.metrics.steps,1);assert.equal(result.metrics.decodingStrategy,'gpu-token-batch-fallback-greedy');assert.match(result.metrics.fallbackReason,/injected device input/);assert.equal(f.engine.tokenBatchSize,1);assert(f.tensors.every(tensor=>tensor.disposed));
});
