import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import * as ort from '../vendor/onnxruntime/ort.all.min.js';
import {MuscriptorONNX,greedyMuscriptorToken} from '../js/muscriptor-onnx.js';
import {CHUNK_SAMPLES} from '../js/transcription-dsp.js';
const close=values=>{for(const tensor of Object.values(values||{}))tensor?.dispose?.();};
const delta=(a,b)=>{assert.equal(a.length,b.length);let maximum=0;for(let i=0;i<a.length;i++){assert(Number.isFinite(a[i])&&Number.isFinite(b[i]));maximum=Math.max(maximum,Math.abs(a[i]-b[i]));}return maximum;};

test('static 8-step candidates are small graph-only files tied to exact original graphs',async()=>{
  for(const variant of ['small','medium']){
    const base=new URL(`../assets/transcription/gpu/${variant}/`,import.meta.url),metadata=JSON.parse(await readFile(new URL('step8.json',base),'utf8')),bytes=await readFile(new URL('step8.onnx',base));
    assert.equal(metadata.kind,'nbs-muscriptor-step-unroll');assert.equal(metadata.steps,8);assert.equal(metadata.weightFilesCopied,false);assert(bytes.length<2*1024*1024);assert.equal(bytes.length,metadata.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.sha256);
    const original=await readFile(new URL(`../assets/transcription/${variant}/step.onnx`,import.meta.url));assert.equal(createHash('sha256').update(original).digest('hex'),metadata.sourceGraphSHA256);
  }
});

const fixture=process.env.NBS_TRANSCRIPTION_FIXTURE,unrollFixture=process.env.NBS_TRANSCRIPTION_UNROLL_FIXTURE;
test('actual 8-step ONNX matches eight independent autoregressive steps, KV and full runtime fallback',{skip:fixture&&unrollFixture?false:'Set tiny NBS_TRANSCRIPTION_FIXTURE and NBS_TRANSCRIPTION_UNROLL_FIXTURE.',timeout:120000},async t=>{
  const directory=path.resolve(fixture),manifest=JSON.parse(await readFile(path.join(directory,'model.json'),'utf8'));assert(manifest.testOnly&&manifest.layers<=4&&manifest.precision==='fp32');
  const readAsset=async file=>new Uint8Array(await readFile(path.join(directory,file)));
  const engine=new MuscriptorONNX(manifest,{readAsset,ort,readUnrollAsset:async()=>{throw new Error('CPU must not load a third unroll session');}});t.after(()=>engine.release());const loaded=await engine.load({backend:'wasm',cpuThreads:1,gpuUnrollSteps:8,navigator:{}});assert.equal(loaded.optimization.activeUnrollSteps,1);assert.match(loaded.optimization.fallbackReason,/WebGPU/);
  const bytes=new Uint8Array(await readFile(path.join(unrollFixture,'step8.onnx'))),externalData=await Promise.all(manifest.externalData.map(async name=>({path:name,data:await readAsset(name)})));
  const eight=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],externalData});engine.unrollSession=eight;
  const Tensor=ort.Tensor,melBytes=await readAsset('validation/log-mel.f32'),mel=new Tensor('float32',new Float32Array(melBytes.buffer),[1,501,512]),bos=new Tensor('int64',BigInt64Array.of(BigInt(manifest.bos)),[1,1]);let first,unrolled,individual;
  try{
    first=await engine.prefill.run({log_mel:mel,tokens:bos});const initial=greedyMuscriptorToken(first.logits.data),token=new Tensor('int64',BigInt64Array.of(BigInt(initial)),[1,1]),position=new Tensor('int64',BigInt64Array.of(BigInt(manifest.prefixLength+1)),[1]),feeds={token,position};
    for(let i=0;i<manifest.layers;i++)for(const type of ['key','value'])feeds[`past_${type}_${i}`]=first[`present_${type}_${i}`];
    try{unrolled=await eight.run(feeds);}finally{token.dispose();position.dispose();}
    const expected=[];individual=first;let previous=initial;
    for(let index=0;index<8;index++){
      const value=new Tensor('int64',BigInt64Array.of(BigInt(previous)),[1,1]),at=new Tensor('int64',BigInt64Array.of(BigInt(manifest.prefixLength+1+index)),[1]),input={token:value,position:at};
      for(let i=0;i<manifest.layers;i++)for(const type of ['key','value'])input[`past_${type}_${i}`]=individual[`present_${type}_${i}`];
      let result;try{result=await engine.step.run(input);}finally{value.dispose();at.dispose();}
      if(individual!==first)close(individual);individual=result;previous=greedyMuscriptorToken(result.logits.data);expected.push(previous,1);
    }
    assert.deepEqual(Array.from(unrolled.token_history.data),expected);for(let i=0;i<8;i++){assert.equal(unrolled[`token_${i}`].type,'int64');assert.equal(Number(unrolled[`token_${i}`].data[0]),expected[i*2]);assert.equal(unrolled[`valid_${i}`].data[0],1);}let cacheError=0;
    for(let i=0;i<manifest.layers;i++)for(const type of ['key','value']){const name=`present_${type}_${i}`;assert.deepEqual(unrolled[name].dims,individual[name].dims);cacheError=Math.max(cacheError,delta(unrolled[name].data,individual[name].data));}
    const logitError=delta(unrolled.logits.data,individual.logits.data);assert(cacheError<5e-4);assert(logitError<5e-4);t.diagnostic(JSON.stringify({provider:'actual ONNX Runtime Web WASM',tokens:expected.filter((_,i)=>i%2===0),cacheError,logitError}));
  }finally{mel.dispose();bos.dispose();close(first);if(individual!==first)close(individual);close(unrolled);}
  const run=async enabled=>{engine.reset();engine.unrollSteps=enabled?8:1;const tokens=[];engine.decoder.promptTokens=()=>[manifest.bos];engine.decoder.begin=()=>{};engine.decoder.push=token=>tokens.push(token);let error;
    try{await engine.inferChunk(new Float32Array(CHUNK_SAMPLES),{maxTokens:19});}catch(problem){assert.equal(problem.code,'GENERATION_LIMIT');error=problem.code;}return {tokens,error,metrics:engine.lastMetrics};};
  const reference=await run(false),candidate=await run(true);assert.deepEqual(candidate.tokens,reference.tokens);assert.equal(candidate.error,reference.error);assert.equal(candidate.metrics.steps,18);assert.equal(candidate.metrics.tokenReadBatches,2);assert.equal(candidate.metrics.graphRuns,5,'one prefill, two 8-step calls and two strict single-step tails');
  const execute=eight.run.bind(eight);let injected=false;eight.run=async feeds=>{if(!injected){injected=true;throw new Error('injected step8 backend failure');}return execute(feeds);};
  const fallback=await run(true);assert.deepEqual(fallback.tokens,reference.tokens);assert.equal(fallback.metrics.decodingStrategy,'gpu-step8-fallback-greedy');assert.match(fallback.metrics.fallbackReason,/injected step8/);assert.equal(engine.unrollSteps,1);
});
