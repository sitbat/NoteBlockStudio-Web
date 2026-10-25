import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranscriptionWorkerHost} from '../js/transcription-worker.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const model=(id='small-real',variant='small',testOnly=false)=>({id,variant,testOnly,precision:'fp32'});
function harness({models=[],download,install,load,infer,catalog}={}){
  const calls=[],messages=[],listeners=new Set(),instances=[];let serial=0,clock=0;
  const cache=new Map(models.map(item=>[item.id,item]));
  const scope={postMessage:message=>messages.push(structuredClone(message)),addEventListener:(type,fn)=>{assert.equal(type,'message');listeners.add(fn);},removeEventListener:(type,fn)=>listeners.delete(fn)};
  const store={
    list:async()=>{calls.push(['list']);return [...cache.values()];},
    get:async id=>{calls.push(['get',id]);return cache.get(id)||null;},
    read:async(id,path)=>{calls.push(['read',id,path]);return Uint8Array.of(1,2,3,4);},
    clear:async id=>{calls.push(['clear',id]);if(id)cache.delete(id);else cache.clear();},
    download:async(info,options)=>{calls.push(['download',info,options]);const result=download?await download(info,options):model(`${info.variant}-downloaded`,info.variant);cache.set(result.id,result);return result;},
    install:async(source,options)=>{calls.push(['install',source,options]);const result=install?await install(source,options):model('local-import');cache.set(result.id,result);return result;},
  };
  class Runtime{
    constructor(manifest,options){this.manifest=manifest;this.options=options;this.loaded=false;this.decoder={notes:[],warnings:0,snapshot:()=>this.decoder.notes.map(note=>({...note}))};instances.push(this);calls.push(['construct',manifest.id]);}
    async load(options){calls.push(['load',this.manifest.id,options]);await this.options.readAsset('weights.bin');await load?.(this,options);this.loaded=true;return {backend:options.backend==='auto'?'wasm':options.backend};}
    reset(){calls.push(['reset',this.manifest.id]);this.decoder.notes=[];}
    async release(){calls.push(['release',this.manifest.id]);this.loaded=false;}
    async probe(){calls.push(['probe',this.manifest.id]);return {ok:true};}
    async inferChunk(pcm,options){calls.push(['infer',pcm.slice(),options]);await options.wait();if(infer)return infer(this,pcm,options);this.decoder.notes.push({midiKey:60,program:0,startSeconds:options.startSeconds,endSeconds:options.startSeconds+.01});options.onPartial();return {milliseconds:10,noteCount:this.decoder.notes.length};}
    finish(seconds){calls.push(['finish',seconds]);}
  }
  const source=catalog||((variant)=>({available:variant!=='large',variant,bytes:24,url:`https://models.example/${variant}`,unavailableReason:'No browser graph for this variant'}));
  const host=createTranscriptionWorkerHost(scope,{Runtime,store,catalog:source,now:()=>clock+=100});
  const rpc=async command=>{const id=++serial;await Promise.all([...listeners].map(fn=>fn({data:{...command,id}})));const response=messages.findLast(message=>message.replyTo===id);assert(response,`missing RPC response ${id}`);return response;};
  return {host,rpc,scope,store,cache,calls,messages,listeners,instances,count:name=>calls.filter(call=>call[0]===name).length};
}

test('creating, configuring and listing the worker never initiates a model download',async t=>{
  const h=harness();t.after(()=>h.host.dispose());
  assert.equal(h.host.snapshot().state,'idle');assert.equal(h.calls.length,0);
  assert.equal((await h.rpc({type:'configure',config:{model:'medium',backend:'wasm',cpuThreads:3}})).ok,true);
  assert.deepEqual((await h.rpc({type:'listModels'})).result,[]);
  assert.equal(h.count('download'),0);assert.equal(h.count('load'),0);assert.equal(h.count('read'),0);
});

test('missing cached model fails explicitly without automatically fetching original weights',async t=>{
  const h=harness();t.after(()=>h.host.dispose());const response=await h.rpc({type:'start',options:{sampleRate:16000}});
  assert.equal(response.ok,false);assert.equal(response.error.code,'MODEL_NOT_INSTALLED');assert.equal(h.host.snapshot().state,'error');assert.equal(h.count('download'),0);
});

test('an unavailable catalog entry fails before cache lookup, installation or runtime allocation',async t=>{
  const h=harness();t.after(()=>h.host.dispose());const response=await h.rpc({type:'downloadModel',variant:'large'});
  assert.equal(response.ok,false);assert.equal(response.error.code,'MODEL_SOURCE_UNAVAILABLE');assert.equal(response.error.message,'No browser graph for this variant');assert.equal(h.calls.length,0);
});

test('download concurrency defaults to two, propagates the selected value and rejects invalid values before storage or network',async t=>{
  for(const concurrency of [undefined,1,4]){
    const h=harness();t.after(()=>h.host.dispose());assert.equal((await h.rpc({type:'downloadModel',variant:'small',options:{concurrency}})).ok,true);
    assert.equal(h.calls.find(call=>call[0]==='download')[2].concurrency,concurrency===undefined?2:concurrency);
  }
  for(const concurrency of [0,5,1.5,null,'4',NaN,Infinity]){
    const h=harness();t.after(()=>h.host.dispose());const response=await h.rpc({type:'downloadModel',variant:'small',options:{concurrency}});
    assert.equal(response.ok,false);assert.equal(response.error.code,'INVALID_OPTIONS');assert.equal(h.calls.length,0);
  }
});

test('explicit download reuses a real cached variant and reads weights only from local storage',async t=>{
  const cached=model('medium-official','medium'),h=harness({models:[model('random-test','medium',true),cached]});t.after(()=>h.host.dispose());
  const response=await h.rpc({type:'downloadModel',variant:'medium'});
  assert.equal(response.ok,true);assert.equal(response.result.modelId,cached.id);assert.equal(response.result.modelReady,true);
  assert.equal(h.count('download'),0);assert.equal(h.count('install'),0);assert.deepEqual(h.calls.find(call=>call[0]==='read'),['read',cached.id,'weights.bin']);
  assert.equal(h.instances[0].manifest.id,cached.id);
});

test('test-only cached weights do not suppress an explicitly requested real model download',async t=>{
  const info={available:true,variant:'small',bytes:24,url:'https://models.example/fixed-sha'},h=harness({models:[model('dummy','small',true)],catalog:()=>info});t.after(()=>h.host.dispose());
  const response=await h.rpc({type:'downloadModel',variant:'small'});
  assert.equal(response.ok,true);assert.equal(h.count('download'),1);assert.equal(h.calls.find(call=>call[0]==='download')[1],info);
  const options=h.calls.find(call=>call[0]==='download')[2];assert(options.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);
  assert.equal(response.result.modelId,'small-downloaded');assert.equal(response.result.state,'ready');assert.equal(h.instances[0].manifest.testOnly,false);
});

test('a loading operation takes its lock before the first asynchronous cache lookup',async t=>{
  const pending=deferred(),h=harness();t.after(()=>h.host.dispose());h.store.list=()=>pending.promise;
  const first=h.rpc({type:'downloadModel',variant:'small'});assert.equal(h.host.snapshot().state,'loading');
  const second=await h.rpc({type:'downloadModel',variant:'medium'});assert.equal(second.ok,false);assert.equal(second.error.code,'TRANSCRIPTION_BUSY');
  await h.host.execute({type:'cancel'});pending.resolve([]);const cancelled=await first;assert.equal(cancelled.error.name,'AbortError');assert.equal(h.count('download'),0);
});

test('download progress is published and failed download reports its original actionable code',async t=>{
  const problem=Object.assign(new Error('CORS blocked; choose local weights'),{code:'MODEL_NETWORK'}),h=harness({download:async(_info,{onProgress})=>{onProgress({stage:'download',loaded:7,total:24});throw problem;}});t.after(()=>h.host.dispose());
  const response=await h.rpc({type:'downloadModel',variant:'small'});
  assert.equal(response.ok,false);assert.equal(response.error.code,'MODEL_NETWORK');assert.match(response.error.message,/local weights/);
  assert.equal(h.host.snapshot().state,'error');assert.equal(h.host.snapshot().modelReady,false);assert.equal(h.count('load'),0);
  assert(h.messages.some(message=>message.snapshot?.modelProgress?.loaded===7));
});

test('cancel aborts download and ignores a late installer success even if the dependency ignores the signal',async t=>{
  const gate=deferred(),entered=deferred();let signal,progress;
  const h=harness({download:async(_info,options)=>{signal=options.signal;progress=options.onProgress;entered.resolve();return gate.promise;}});t.after(()=>h.host.dispose());
  const pending=h.rpc({type:'downloadModel',variant:'small'});await entered.promise;
  const cancelled=await h.rpc({type:'cancel'});assert.equal(cancelled.result.state,'cancelled');assert.equal(signal.aborted,true);
  const messageCount=h.messages.length;progress({stage:'download',loaded:24,total:24});assert.equal(h.messages.length,messageCount,'late progress ignored');
  gate.resolve(model('late'));const response=await pending;assert.equal(response.ok,false);assert.equal(response.error.name,'AbortError');
  assert.equal(h.host.snapshot().state,'cancelled');assert.equal(h.count('construct'),0);assert.equal(h.count('load'),0);
});

test('cancelling a local package load passes the signal and cannot publish a stale ready model',async t=>{
  const gate=deferred(),entered=deferred();let signal;
  const h=harness({install:async(_source,options)=>{signal=options.signal;entered.resolve();return gate.promise;}});t.after(()=>h.host.dispose());
  const pending=h.rpc({type:'loadPackage',source:new Blob(['local package'])});await entered.promise;await h.rpc({type:'cancel'});assert.equal(signal.aborted,true);
  gate.resolve(model('late-local'));assert.equal((await pending).error.name,'AbortError');assert.equal(h.host.snapshot().state,'cancelled');assert.equal(h.count('construct'),0);
});

test('cancelling while the cached runtime loads releases its candidate and suppresses ready',async t=>{
  const gate=deferred(),entered=deferred(),h=harness({models:[model()],load:async()=>{entered.resolve();await gate.promise;}});t.after(()=>h.host.dispose());
  const pending=h.rpc({type:'loadModel',modelId:'small-real'});await entered.promise;await h.rpc({type:'cancel'});gate.resolve();
  assert.equal((await pending).error.name,'AbortError');assert.equal(h.count('release'),1);assert.equal(h.host.snapshot().state,'cancelled');assert.equal(h.host.snapshot().modelReady,false);
});

for(const command of ['start','diagnose'])test(`cancel during ${command} model preparation ignores late runtime progress and never starts audio`,async t=>{
  const gate=deferred(),entered=deferred();let candidate;
  const h=harness({models:[model()],load:async runtime=>{candidate=runtime;entered.resolve();await gate.promise;}});t.after(()=>h.host.dispose());
  const pending=h.rpc({type:command,options:{sampleRate:16000}});await entered.promise;await h.rpc({type:'cancel'});
  const messageCount=h.messages.length;candidate.options.onProgress({stage:'compile',loaded:9,total:10});assert.equal(h.messages.length,messageCount,'cancelled runtime progress is suppressed');
  gate.resolve();const response=await pending;assert.equal(response.ok,false);assert.equal(response.error.name,'AbortError');assert.equal(h.count('release'),1);assert.equal(h.count('probe'),0);assert.equal(h.count('infer'),0);
  assert.equal(h.host.snapshot().state,'cancelled');assert.equal(h.host.snapshot().modelReady,false);
});

test('a backend load failure releases the failed candidate and stays an explicit error',async t=>{
  const h=harness({models:[model()],load:async()=>{throw Object.assign(new Error('No GPU device'),{code:'WEBGPU_UNAVAILABLE'});}});t.after(()=>h.host.dispose());
  const response=await h.rpc({type:'loadModel',modelId:'small-real'});
  assert.equal(response.error.code,'WEBGPU_UNAVAILABLE');assert.equal(h.count('release'),1);assert.equal(h.host.snapshot().modelReady,false);assert.equal(h.host.snapshot().state,'error');
});

test('random-weight models can diagnose the execution path but cannot begin musical transcription',async t=>{
  const h=harness({models:[model('dummy','small',true)]});t.after(()=>h.host.dispose());
  assert.deepEqual((await h.rpc({type:'diagnose'})).result,{ok:true});assert.equal(h.count('probe'),1);
  const response=await h.rpc({type:'start',options:{sampleRate:16000}});assert.equal(response.error.code,'TEST_MODEL_ONLY');assert.equal(h.count('infer'),0);assert.equal(h.count('download'),0);
});

test('chunked audio drains a padded final chunk without changing its actual duration or note count',async t=>{
  const h=harness({models:[model()]});t.after(()=>h.host.dispose());await h.rpc({type:'start',options:{sampleRate:16000,jobId:'job-A'}});
  await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(80000).fill(.25)});
  await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(1600).fill(.5),final:true});
  const response=await h.rpc({type:'finish'});assert.equal(response.ok,true);assert.equal(response.result.state,'completed');assert.equal(response.result.receivedSeconds,5.1);assert.equal(response.result.processedSeconds,5.1);assert.equal(response.result.noteCount,2);
  const chunks=h.calls.filter(call=>call[0]==='infer');assert.equal(chunks.length,2);assert.equal(chunks[1][1].length,80000);assert.equal(chunks[1][2].validSamples,1600);assert.equal(chunks[1][2].startSeconds,5);
  assert(chunks[1][1].subarray(0,1600).every(value=>value===.5));assert(chunks[1][1].subarray(1600).every(value=>value===0));assert.deepEqual(h.calls.find(call=>call[0]==='finish'),['finish',5.1]);
});

test('live input stays bounded and reports backpressure rather than allocating an unbounded queue',async t=>{
  const h=harness({models:[model()]});t.after(()=>h.host.dispose());await h.rpc({type:'start',options:{sampleRate:16000,live:true}});await h.rpc({type:'pause'});
  for(let index=0;index<12;index++)assert.equal((await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(160000)})).ok,true);
  const overflow=await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(1)});
  assert.equal(overflow.error.code,'BACKPRESSURE');assert.equal(h.host.snapshot().backpressure,true);assert.equal(h.host.snapshot().state,'error');assert.equal(h.host.snapshot().receivedSeconds,120);assert.equal(h.count('infer'),0);
});

test('active audio cancellation rejects a pending finish and clears unpublished notes',async t=>{
  const h=harness({models:[model()]});t.after(()=>h.host.dispose());await h.rpc({type:'start',options:{sampleRate:16000}});await h.rpc({type:'pause'});
  await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(1600)});
  const finish=h.rpc({type:'finish'});await turn();await h.rpc({type:'cancel'});const response=await finish;
  assert.equal(response.error.name,'AbortError');assert.equal(h.host.snapshot().state,'cancelled');assert.deepEqual(h.host.snapshot().notes,[]);
});

test('dispose unregisters messages, aborts installation and prevents allocating its late runtime',async()=>{
  const gate=deferred(),entered=deferred();let signal;
  const h=harness({download:async(_info,options)=>{signal=options.signal;entered.resolve();return gate.promise;}}),pending=h.rpc({type:'downloadModel',variant:'small'});await entered.promise;
  await h.host.dispose();assert.equal(h.listeners.size,0);assert.equal(signal.aborted,true);gate.resolve(model('disposed'));
  assert.equal((await pending).error.name,'AbortError');assert.equal(h.count('construct'),0);
});

// Simulate an uncancellable in-flight GPU kernel. The old pump must hand over to
// a new job as soon as that kernel returns, even when start follows cancel now.
test('cancel then immediate restart drains the new job after the old kernel returns',async t=>{
  const entered=deferred(),gate=deferred();let invocations=0;
  const h=harness({models:[model()],infer:async(runtime,_pcm,options)=>{
    if(++invocations===1){entered.resolve();await gate.promise;if(options.cancelled())throw new DOMException('cancelled','AbortError');}
    runtime.decoder.notes.push({midiKey:67,program:0,startSeconds:options.startSeconds,endSeconds:options.startSeconds+.05});
    options.onPartial();return {milliseconds:10,noteCount:runtime.decoder.notes.length};
  }});t.after(async()=>{gate.resolve();await h.host.dispose();});
  assert.equal((await h.rpc({type:'start',options:{sampleRate:16000,jobId:'old'}})).ok,true);
  await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(80000)});await entered.promise;
  const oldFinish=h.rpc({type:'finish'});await turn();await h.rpc({type:'cancel'});
  assert.equal((await oldFinish).error.name,'AbortError');
  assert.equal((await h.rpc({type:'start',options:{sampleRate:16000,jobId:'new'}})).ok,true);
  await h.rpc({type:'appendAudio',sampleRate:16000,pcm:new Float32Array(1600),final:true});
  const newFinish=h.rpc({type:'finish'});gate.resolve();let timeout;
  const response=await Promise.race([newFinish,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('new job stalled behind the cancelled pump')),2000);})]).finally(()=>clearTimeout(timeout));
  assert.equal(response.ok,true);assert.equal(response.result.jobId,'new');assert.equal(response.result.state,'completed');assert.equal(response.result.receivedSeconds,.1);assert.equal(response.result.processedSeconds,.1);
  assert.equal(response.result.noteCount,1);assert.equal(response.result.notes[0].midiKey,67);assert.equal(h.count('infer'),2);
});

test('GPU unroll configuration reaches model loading and changing it releases the old sessions',async t=>{
  const h=harness({models:[model()]});t.after(()=>h.host.dispose());
  assert.equal((await h.rpc({type:'configure',config:{gpuUnrollSteps:8}})).ok,true);
  assert.equal((await h.rpc({type:'loadModel',modelId:'small-real'})).ok,true);
  assert.equal(h.calls.findLast(call=>call[0]==='load')[2].gpuUnrollSteps,8);assert.equal(h.count('release'),0);
  const switched=await h.rpc({type:'configure',config:{gpuUnrollSteps:1}});assert.equal(switched.ok,true);assert.equal(switched.result.modelReady,false);assert.equal(switched.result.state,'idle');assert.equal(h.count('release'),1);
  await h.rpc({type:'loadModel',modelId:'small-real'});assert.equal(h.calls.findLast(call=>call[0]==='load')[2].gpuUnrollSteps,1);assert.equal(h.count('construct'),2);
  await h.rpc({type:'configure',config:{gpuUnrollSteps:1}});assert.equal(h.count('release'),1,'unchanged configuration retains the existing model');
});

test('invalid GPU unroll values fail before allocating, downloading or releasing anything',async t=>{
  const h=harness();t.after(()=>h.host.dispose());
  for(const value of [0,2,4,16,8.5,'8',null]){const response=await h.rpc({type:'configure',config:{gpuUnrollSteps:value}});assert.equal(response.ok,false);assert.equal(response.error.code,'INVALID_OPTIONS');}
  assert.equal(h.count('construct'),0);assert.equal(h.count('load'),0);assert.equal(h.count('release'),0);assert.equal(h.count('download'),0);assert.equal(h.host.snapshot().state,'idle');
});

test('unroll settings cannot replace the model while an audio job is active',async t=>{
  const h=harness({models:[model()]});t.after(()=>h.host.dispose());await h.rpc({type:'start',options:{sampleRate:16000}});
  const changed=await h.rpc({type:'configure',config:{gpuUnrollSteps:8}});assert.equal(changed.error.code,'TRANSCRIPTION_BUSY');assert.equal(h.count('release'),0);assert.equal(h.host.snapshot().state,'running');
});
