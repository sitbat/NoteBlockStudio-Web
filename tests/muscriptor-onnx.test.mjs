import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MuscriptorONNX,chooseTranscriptionBackend,greedyMuscriptorToken} from '../js/muscriptor-onnx.js';
import {MT3,CHUNK_SAMPLES} from '../js/transcription-dsp.js';

const close = values => {for(const value of Object.values(values||{}))value?.dispose?.();};
const difference=(a,b)=>{
  assert.equal(a.length,b.length,'numeric reference dimensions');
  let maximum=0,squared=0;
  for(let i=0;i<a.length;i++){
    assert.ok(Number.isFinite(a[i])&&Number.isFinite(b[i]),`finite model output ${i}`);
    const delta=Math.abs(a[i]-b[i]);maximum=Math.max(maximum,delta);squared+=delta*delta;
  }
  return {maximum,rmse:Math.sqrt(squared/a.length)};
};

test('model backend selection refuses missing APIs and incompatible precision',async()=>{
  assert.equal(await chooseTranscriptionBackend('auto',{precision:'fp32'},{}),'wasm');
  await assert.rejects(chooseTranscriptionBackend('webgpu',{precision:'fp32'},{}),{code:'WEBGPU_UNAVAILABLE'});
  await assert.rejects(chooseTranscriptionBackend('webnn',{precision:'fp32'},{}),{code:'WEBNN_UNAVAILABLE'});
  await assert.rejects(chooseTranscriptionBackend('webgpu',{precision:'int8',eligibleBackends:['wasm']},{}),{code:'BACKEND_MODEL_UNSUPPORTED'});
});

test('greedy decode masks reserved logits and refuses unusable numeric output',()=>{
  const values=new Float32Array(1395);values.fill(-1);values[74]=3;values[1393]=100;values[1394]=1000;
  assert.equal(greedyMuscriptorToken(values),74);
  assert.throws(()=>greedyMuscriptorToken(new Float32Array(12)),{code:'MODEL_OUTPUT'});
  assert.throws(()=>greedyMuscriptorToken(new Float32Array(MT3.size).fill(NaN)),{code:'MODEL_NUMERIC'});
});

const fixture=process.env.NBS_TRANSCRIPTION_FIXTURE;
test('actual ONNX Runtime Web WASM matches official prefix logits and cached decoding', {skip:fixture?false:'Set NBS_TRANSCRIPTION_FIXTURE to an exporter --dummy package for real ONNX/WASM execution.',timeout:120000},async t=>{
  const directory=path.resolve(fixture.endsWith('.json')?path.dirname(fixture):fixture);
  const manifest=JSON.parse(await readFile(path.join(directory,'model.json'),'utf8'));
  assert.equal(manifest.kind,'nbs-muscriptor-onnx');
  assert.equal(manifest.testOnly,true,'This fast integration fixture must contain clearly marked random weights.');
  assert.ok(manifest.layers<=4,'Use the tiny --dummy fixture, not a full-size model, in unit tests.');
  const index=new Map(manifest.files.map(file=>[file.path,file]));
  const readAsset=async relative=>{
    const candidate=path.resolve(directory,relative),base=path.relative(directory,candidate);
    assert.ok(base&&!base.startsWith('..')&&!path.isAbsolute(base),'fixture asset remains inside package');
    const bytes=new Uint8Array(await readFile(candidate)),entry=index.get(relative);
    assert.ok(entry,`manifest declares ${relative}`);assert.equal(bytes.length,entry.bytes,relative);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,relative);
    return bytes;
  };
  const floats=async relative=>{const bytes=await readAsset(relative);assert.equal(bytes.byteLength%4,0);return new Float32Array(bytes.buffer);};
  const engine=new MuscriptorONNX(manifest,{readAsset});
  t.after(async()=>engine.release());
  const loaded=await engine.load({backend:'wasm',cpuThreads:1,navigator:{}});
  assert.equal(loaded.backend,'wasm');assert.equal(loaded.actualBackend,'wasm');assert.equal(loaded.testOnly,true);
  const Tensor=engine.ort.Tensor;
  const mel=await floats('validation/log-mel.f32');
  const expected=JSON.parse(Buffer.from(await readAsset('validation/golden.json')).toString('utf8')).prefillLogits;
  const executePrefill=async(logMel,sequence)=>{
    const log_mel=new Tensor('float32',logMel,[1,manifest.melFrames,manifest.melBins]);
    const tokens=new Tensor('int64',BigInt64Array.from(sequence,BigInt),[1,sequence.length]);
    try{return await engine.prefill.run({log_mel,tokens});}finally{log_mel.dispose();tokens.dispose();}
  };
  let outputs=await executePrefill(mel,[manifest.bos]);
  t.after(()=>close(outputs));
  assert.deepEqual(outputs.logits.dims,[1,manifest.card]);
  const nativeParity=difference(outputs.logits.data,expected);
  assert.ok(nativeParity.maximum<5e-4,JSON.stringify(nativeParity));
  assert.equal(greedyMuscriptorToken(outputs.logits.data),greedyMuscriptorToken(expected));
  for(let i=0;i<manifest.layers;i++)for(const type of ['key','value'])
    assert.deepEqual(outputs[`present_${type}_${i}`].dims,[1,manifest.heads,manifest.prefixLength+1,manifest.headDim]);

  // This exercises the browser FFT/filterbank all the way into a real ONNX graph.
  const computedMel=engine.mel.compute(await floats('validation/audio-16000.f32'));
  const computed=await executePrefill(computedMel,[manifest.bos]);
  const preprocessingLogits=difference(computed.logits.data,outputs.logits.data);
  // Dynamic INT8 activation rounding amplifies tiny Mel differences; report it
  // separately from exact same-input export parity rather than hiding the drift.
  const preprocessingLimit=manifest.precision==='int8'?.02:1e-3;
  assert.ok(preprocessingLogits.maximum<preprocessingLimit,JSON.stringify(preprocessingLogits));
  assert.equal(greedyMuscriptorToken(computed.logits.data),greedyMuscriptorToken(outputs.logits.data));
  close(computed);

  const sequence=[manifest.bos];let maximumCacheError=0,maximumLogitError=0;
  for(let iteration=0;iteration<3;iteration++){
    const next=greedyMuscriptorToken(outputs.logits.data);
    const token=new Tensor('int64',BigInt64Array.of(BigInt(next)),[1,1]);
    const position=new Tensor('int64',BigInt64Array.of(BigInt(manifest.prefixLength+sequence.length)),[1]);
    const feeds={token,position};
    for(let i=0;i<manifest.layers;i++)for(const type of ['key','value'])feeds[`past_${type}_${i}`]=outputs[`present_${type}_${i}`];
    let step;
    try{step=await engine.step.run(feeds);}finally{token.dispose();position.dispose();}
    sequence.push(next);
    const full=await executePrefill(mel,sequence);
    maximumLogitError=Math.max(maximumLogitError,difference(step.logits.data,full.logits.data).maximum);
    for(let i=0;i<manifest.layers;i++)for(const type of ['key','value']){
      const key=`present_${type}_${i}`;
      assert.deepEqual(step[key].dims,[1,manifest.heads,manifest.prefixLength+sequence.length,manifest.headDim]);
      maximumCacheError=Math.max(maximumCacheError,difference(step[key].data,full[key].data).maximum);
    }
    assert.equal(greedyMuscriptorToken(step.logits.data),greedyMuscriptorToken(full.logits.data));
    close(full);close(outputs);outputs=step;
  }
  // INT8 per-invocation activation scales can vary slightly with full prefill shape.
  const limit=manifest.precision==='int8'?.08:5e-4;
  assert.ok(maximumLogitError<limit,`cached logits ${maximumLogitError}`);
  assert.ok(maximumCacheError<limit,`cached tensors ${maximumCacheError}`);
  engine.reset();
  await assert.rejects(engine.inferChunk(new Float32Array(CHUNK_SAMPLES),{cancelled:()=>true}),error=>error.name==='AbortError');
  const probe=await engine.probe();assert.equal(probe.passed,true);assert.equal(probe.backend,'wasm');
  t.diagnostic(JSON.stringify({runtime:'vendored ONNX Runtime Web, WASM CPU',modelId:manifest.id,testOnly:true,precision:manifest.precision,nativeParity,preprocessingLogits,maximumLogitError,maximumCacheError,probe}));
});
