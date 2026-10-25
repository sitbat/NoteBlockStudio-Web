import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import * as ort from '../vendor/onnxruntime/ort.all.min.mjs';
import {MuscriptorONNX,greedyMuscriptorToken} from '../js/muscriptor-onnx.js';
import {CHUNK_SAMPLES} from '../js/transcription-dsp.js';

ort.env.wasm.wasmPaths=new URL('../vendor/onnxruntime/',import.meta.url).href;
ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
const helperURL=new URL('../assets/transcription/common/decoder-argmax.onnx',import.meta.url);
const helperBytes=new Uint8Array(await readFile(helperURL));
const dispose=outputs=>{for(const value of Object.values(outputs||{}))value?.dispose?.();};

test('actual shared ONNX argmax graph preserves masking, ties, numeric checks and token history',async t=>{
  const metadata=JSON.parse(await readFile(new URL('../assets/transcription/common/decoder-argmax.json',import.meta.url),'utf8'));
  assert.equal(helperBytes.length,metadata.bytes);assert.equal(createHash('sha256').update(helperBytes).digest('hex'),metadata.sha256);
  const session=await ort.InferenceSession.create(helperBytes,{executionProviders:['wasm']});t.after(()=>session.release());
  let history=new ort.Tensor('float32',Float32Array.of(0,1),[1,2]);
  t.after(()=>history.dispose());
  const logits=new Float32Array(1395).fill(-20);logits[0]=NaN;logits[1]=Infinity;logits[2]=-Infinity;logits[74]=3;logits[75]=3;logits[1393]=100;logits[1394]=1000;
  for(let index=0;index<8;index++){
    logits[74]=index===7?-4:3;const input=new ort.Tensor('float32',logits,[1,1395]);let result;
    try{result=await session.run({logits:input,history_in:history});assert.equal(Number(result.token.data[0]),greedyMuscriptorToken(logits));assert.deepEqual(result.token.dims,[1,1]);assert.deepEqual(result.history_out.dims,[1,2+(index+1)*2]);}
    finally{input.dispose();result?.token.dispose();}
    history.dispose();history=result.history_out;
  }
  assert.deepEqual(Array.from(history.data),[0,1,74,1,74,1,74,1,74,1,74,1,74,1,74,1,75,1]);
  const bad=new ort.Tensor('float32',new Float32Array(1393).fill(NaN),[1,1393]);let invalid;
  try{invalid=await session.run({logits:bad,history_in:history});assert.equal(invalid.history_out.data.at(-1),0,'an entirely nonfinite vocabulary is explicitly marked invalid');}
  finally{bad.dispose();dispose(invalid);}
});

const fixture=process.env.NBS_TRANSCRIPTION_FIXTURE;
test('actual tiny model yields identical greedy and batched GPU-token protocol sequences', {skip:fixture?false:'Set NBS_TRANSCRIPTION_FIXTURE to the tiny fp32 exporter fixture.',timeout:120000},async t=>{
  const directory=path.resolve(fixture.endsWith('.json')?path.dirname(fixture):fixture),manifest=JSON.parse(await readFile(path.join(directory,'model.json'),'utf8'));
  assert.equal(manifest.testOnly,true);assert.ok(manifest.layers<=4);assert.equal(manifest.precision,'fp32');
  const engine=new MuscriptorONNX(manifest,{readAsset:async file=>new Uint8Array(await readFile(path.join(directory,file))),ort});t.after(()=>engine.release());
  await engine.load({backend:'wasm',cpuThreads:1,navigator:{}});
  const run=async()=>{
    engine.reset();const tokens=[];engine.decoder.promptTokens=()=>[manifest.bos];engine.decoder.begin=()=>{};engine.decoder.push=token=>tokens.push(token);let error=null;
    try{await engine.inferChunk(new Float32Array(CHUNK_SAMPLES),{maxTokens:17});}catch(problem){assert.equal(problem.code,'GENERATION_LIMIT');error=problem.code;}
    return {tokens,error,metrics:engine.lastMetrics};
  };
  const reference=await run();
  engine.tokenDecoder=await ort.InferenceSession.create(helperBytes,{executionProviders:['wasm']});engine.tokenBatchSize=8;
  const batched=await run();assert.deepEqual(batched.tokens,reference.tokens);assert.equal(batched.error,reference.error);assert.equal(batched.metrics.tokens,reference.metrics.tokens);assert.equal(batched.metrics.decodingStrategy,'gpu-token-batch');assert.equal(batched.metrics.tokenReadBatches,Math.ceil(batched.metrics.tokens/8));
  const realRun=engine.tokenDecoder.run.bind(engine.tokenDecoder);let helperRuns=0;
  engine.tokenDecoder.run=async feeds=>{if(++helperRuns===3)throw new Error('injected decoder availability failure');return realRun(feeds);};engine.tokenBatchSize=8;
  const fallback=await run();assert.deepEqual(fallback.tokens,reference.tokens);assert.equal(fallback.error,reference.error);assert.equal(fallback.metrics.decodingStrategy,'gpu-token-batch-fallback-greedy');assert.match(fallback.metrics.fallbackReason,/injected decoder/);assert.equal(engine.tokenBatchSize,1);
  t.diagnostic(JSON.stringify({provider:'actual ONNX Runtime Web WASM, CPU tensors exercise pipeline protocol only',tokens:reference.tokens,batches:batched.metrics.tokenReadBatches,steps:batched.metrics.steps,fallback:fallback.metrics.fallbackReason,note:'WebGPU device residency and speed require independent browser A/B.'}));
});
