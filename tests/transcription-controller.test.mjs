import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranscriptionController,detectTranscriptionCapabilities} from '../js/transcription-controller.js';

const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture({handler,maxPendingAudio=8,requestTimeoutMs=0}={}) {
  const workers=[],observerErrors=[];
  class Worker {
    constructor(){this.messages=[];this.terminated=false;this.state={state:'idle',modelReady:false,model:'small',backend:'auto',modelId:null,notes:[],noteCount:0,receivedSeconds:0,processedSeconds:0,queuedSeconds:0};workers.push(this);}
    postMessage(message,transfer){
      if(this.terminated)throw new Error('terminated');
      const data=structuredClone(message,{transfer:transfer||[]});this.messages.push(data);
      queueMicrotask(()=>{
        if(this.terminated)return;
        if(handler?.(data,this)===true)return;
        if(data.type==='configure'){Object.assign(this.state,data.config);this.reply(data.id,{...this.state});}
        else if(data.type==='loadPackage'){Object.assign(this.state,{state:'ready',modelReady:true,modelId:'cached-small'});this.reply(data.id,{...this.state});}
        else if(data.type==='loadModel'){Object.assign(this.state,{state:'ready',modelReady:true,modelId:data.modelId});this.reply(data.id,{...this.state});}
        else if(data.type==='downloadModel'){Object.assign(this.state,{state:'ready',modelReady:true,modelId:`downloaded-${data.variant}`,model:data.variant,testOnly:false});this.reply(data.id,{...this.state});}
        else if(data.type==='diagnose')this.reply(data.id,{passed:true,milliseconds:12,backend:'wasm',layers:2,testOnly:!!this.state.testOnly});
        else if(data.type==='listModels')this.reply(data.id,[{id:'cached-small'}]);
        else if(data.type==='clearCache'){Object.assign(this.state,{state:'idle',modelReady:false,modelId:null});this.reply(data.id,{...this.state});}
        else if(data.type==='start'){Object.assign(this.state,{state:'running',jobId:data.options.jobId,notes:[],noteCount:0,receivedSeconds:0,processedSeconds:0,queuedSeconds:0});this.reply(data.id,{...this.state});}
        else if(data.type==='appendAudio'){this.state.receivedSeconds+=data.pcm.length/data.sampleRate;this.reply(data.id,{...this.state});}
        else if(data.type==='pause'){this.state.state='paused';this.reply(data.id,{...this.state});}
        else if(data.type==='resume'){this.state.state='running';this.reply(data.id,{...this.state});}
        else if(data.type==='finish'){Object.assign(this.state,{state:'completed',notes:[{startSeconds:0,endSeconds:1,midiKey:60,program:0}],noteCount:1});this.reply(data.id,{...this.state});}
      });
    }
    reply(replyTo,result){this.onmessage?.({data:{replyTo,ok:true,result}});}
    errorReply(replyTo,error){this.onmessage?.({data:{replyTo,ok:false,error}});}
    stateEvent(snapshot){this.onmessage?.({data:{type:'state',snapshot}});}
    terminate(){this.terminated=true;}
  }
  const controller=createTranscriptionController({workerFactory:()=>new Worker(),maxPendingAudio,requestTimeoutMs,loadTimeoutMs:0,onObserverError:error=>observerErrors.push(error)});
  return {controller,workers,observerErrors};
}
async function ready(f){await f.controller.loadPackage('https://example.test/models/small/manifest.json');await f.controller.start({sampleRate:16000,live:true});return f.workers.at(-1);}

test('controller construction and capabilities do not allocate a worker or claim model recognition works',()=>{
  const f=fixture();assert.equal(f.workers.length,0);assert.equal(f.controller.getSnapshot().modelReady,false);
  assert.deepEqual(detectTranscriptionCapabilities({WebAssembly,Worker(){},navigator:{gpu:{requestAdapter(){}},ml:{createContext(){}}}}),{secure:true,wasm:true,worker:true,webgpu:true,webnn:true});
  f.controller.destroy();
});

test('downloadModel is explicit, supports only built-in variants, and applies actual ready state',async()=>{
  const f=fixture();assert.equal(f.workers.length,0);await assert.rejects(f.controller.downloadModel('large'),/small 和 medium/);assert.equal(f.workers.length,0);
  await f.controller.downloadModel('medium');assert.equal(f.controller.getSnapshot().modelReady,true);assert.equal(f.controller.getSnapshot().model,'medium');assert.equal(f.workers[0].messages.filter(message=>message.type==='downloadModel').length,1);assert.deepEqual(f.workers[0].messages.find(message=>message.type==='downloadModel').options,{concurrency:2});f.controller.destroy();
});

test('download concurrency is validated before allocating a worker and copied at RPC start',async()=>{
  const f=fixture();for(const concurrency of [0,5,2.5,null,'4',NaN,Infinity])await assert.rejects(f.controller.downloadModel('small',{concurrency}),/1–4/);
  assert.equal(f.workers.length,0);const options={concurrency:4},pending=f.controller.downloadModel('small',options);options.concurrency=1;await pending;
  assert.deepEqual(f.workers[0].messages.find(message=>message.type==='downloadModel').options,{concurrency:4});f.controller.destroy();
});

test('a cache RPC must report actual runtime readiness and worker termination clears stale backend claims',async()=>{
  const f=fixture({handler(message,worker){if(message.type==='loadModel'){worker.reply(message.id,{state:'ready',modelReady:false,modelId:message.modelId});return true;}}});
  await f.controller.loadPackage('https://example.test/model.json');assert.equal(f.controller.getSnapshot().modelReady,true);
  await assert.rejects(f.controller.loadModel('not-runnable'),/未完成浏览器加载/);assert.equal(f.controller.getSnapshot().modelReady,false);assert.equal(f.controller.getSnapshot().state,'error');
  await f.controller.loadPackage('https://example.test/model.json');f.workers[0].stateEvent({actualBackend:'webgpu'});f.workers[0].onerror({message:'device lost'});
  assert.equal(f.controller.getSnapshot().modelReady,false);assert.equal(f.controller.getSnapshot().actualBackend,null);assert.equal(f.workers[0].terminated,true);f.controller.destroy();
});

test('large model download can be cancelled without waiting for an RPC timeout',async()=>{
  const f=fixture({requestTimeoutMs:8,handler:data=>data.type==='downloadModel'});const pending=f.controller.downloadModel('small');await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(f.controller.getSnapshot().state,'loading');f.controller.cancel();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(f.workers[0].terminated,true);f.controller.destroy();
});

test('cached loading and graph self-test are separate from starting a music recognition job',async()=>{
  const f=fixture();await f.controller.loadModel('cached-small');const result=await f.controller.diagnose();assert.equal(result.passed,true);assert.equal(f.controller.getSnapshot().diagnostic.milliseconds,12);assert.equal(f.controller.getSnapshot().actualBackend,'wasm');
  const worker=f.workers[0];worker.stateEvent({state:'ready',modelReady:true,testOnly:true});await assert.rejects(f.controller.start({sampleRate:16000}),error=>error.code==='TRANSCRIPTION_TEST_ONLY');
  assert.equal(worker.messages.filter(message=>message.type==='start').length,0);await f.controller.diagnose();f.controller.destroy();
});

test('package/configuration and audio RPCs use only the worker and preserve caller PCM by default',async()=>{
  const f=fixture(),worker=await ready(f),pcm=new Float32Array([.1,.2,.3]);
  await f.controller.appendAudio({pcm,sampleRate:16000});assert.equal(pcm.length,3);assert.ok(Math.abs(pcm[1]-.2)<1e-6);
  const command=worker.messages.find(message=>message.type==='appendAudio');assert.deepEqual([...command.pcm],[...pcm]);assert.equal(command.sampleRate,16000);
  assert.ok(worker.messages.find(message=>message.type==='start').options.live);assert.match(worker.messages.find(message=>message.type==='start').options.jobId,/^\d+:\d+$/);
  await f.controller.finish();assert.equal(f.controller.getSnapshot().state,'completed');assert.equal(f.controller.getSnapshot().notes.length,1);f.controller.destroy();
});

test('explicit full-buffer ownership permits transfer but a subarray never detaches neighboring audio',async()=>{
  const f=fixture();await ready(f);
  const owned=new Float32Array([1,2]);await f.controller.appendAudio({pcm:owned,sampleRate:16000,transfer:true});assert.equal(owned.byteLength,0);
  const parent=new Float32Array([1,2,3,4]),part=parent.subarray(1,3);await f.controller.appendAudio({pcm:part,sampleRate:16000,transfer:true});assert.deepEqual([...parent],[1,2,3,4]);f.controller.destroy();
});

test('out-of-order RPC replies resolve their own callers without replacing the current worker',async()=>{
  const delayed=[];const f=fixture({handler:(data,worker)=>{if(data.type==='listModels'){delayed.push([data.id,worker]);return true;}}});
  const first=f.controller.listModels(),second=f.controller.listModels();await turn();assert.equal(delayed.length,2);
  delayed[1][1].reply(delayed[1][0],['second']);delayed[0][1].reply(delayed[0][0],['first']);assert.deepEqual(await first,['first']);assert.deepEqual(await second,['second']);f.controller.destroy();
});

test('cancel terminates immediately, rejects in-flight work and ignores old worker callbacks',async()=>{
  const f=fixture({handler:data=>data.type==='appendAudio'}),worker=await ready(f);
  const pending=f.controller.appendAudio({pcm:new Float32Array(16000),sampleRate:16000});await turn();const oldHandler=worker.onmessage;
  f.controller.cancel();await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(worker.terminated,true);assert.equal(f.controller.getSnapshot().state,'cancelled');assert.equal(f.controller.getSnapshot().modelReady,false);assert.equal(f.controller.getSnapshot().actualBackend,null);assert.equal(f.controller.getSnapshot().modelId,'cached-small');assert.equal(f.controller.getSnapshot().notes.length,0);
  await f.controller.start({sampleRate:16000});assert.equal(f.workers.length,2);
  const next=f.workers[1];assert.equal(next.messages[0].config.modelId,'cached-small','only cached package metadata is replayed');
  oldHandler({data:{type:'state',snapshot:{state:'completed',notes:[{midiKey:99}]}}});assert.equal(f.controller.getSnapshot().state,'running');assert.equal(f.controller.getSnapshot().notes.length,0);f.controller.destroy();
});

test('cancel during worker bootstrap does not let a delayed start create a hidden session',async()=>{
  const f=fixture({handler:data=>data.type==='configure'});const pending=f.controller.start({sampleRate:16000});const handler=f.workers[0].onmessage;
  f.controller.cancel();await assert.rejects(pending,error=>error.name==='AbortError');handler({data:{replyTo:1,ok:true,result:{state:'ready',modelReady:true}}});
  assert.equal(f.controller.getSnapshot().state,'cancelled');assert.equal(f.workers[0].messages.length,1);f.controller.destroy();
});

test('pending PCM is bounded; overload fails rather than dropping audio or growing the queue',async()=>{
  const f=fixture({maxPendingAudio:2,handler:data=>data.type==='appendAudio'}),worker=await ready(f);
  const first=f.controller.appendAudio({pcm:new Float32Array(160),sampleRate:16000}),second=f.controller.appendAudio({pcm:new Float32Array(160),sampleRate:16000});
  const results=Promise.allSettled([first,second,f.controller.appendAudio({pcm:new Float32Array(160),sampleRate:16000})]);
  for(const result of await results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'TRANSCRIPTION_BACKPRESSURE');}
  assert.equal(worker.terminated,true);assert.equal(f.controller.getSnapshot().backpressure,true);assert.equal(f.controller.getSnapshot().state,'error');f.controller.destroy();
});

test('finish retains the complete result when later progress snapshots contain only preview notes',async()=>{
  const full=Array.from({length:6002},(_,i)=>({startSeconds:i/100,midiKey:60}));
  const f=fixture({handler:(data,worker)=>{if(data.type==='finish'){worker.reply(data.id,{...worker.state,state:'completed',notes:full,noteCount:full.length});return true;}}}),worker=await ready(f);
  const final=await f.controller.finish();assert.equal(final.notes.length,6002);
  worker.stateEvent({state:'completed',jobId:worker.state.jobId,notes:full.slice(-5000),noteCount:6002});assert.equal(f.controller.getSnapshot().notes.length,6002);
  worker.stateEvent({state:'running',jobId:worker.state.jobId,notes:full.slice(-3)});assert.equal(f.controller.getSnapshot().state,'completed');assert.equal(f.controller.getSnapshot().notes.length,6002);
  assert.throws(()=>f.controller.getSnapshot().notes.push({}),TypeError);f.controller.destroy();
});

test('events tagged for the previous job cannot change a newer session on the same worker',async()=>{
  const f=fixture(),worker=await ready(f);const oldJob=worker.state.jobId;await f.controller.finish();await f.controller.start({sampleRate:16000});
  worker.stateEvent({state:'completed',jobId:oldJob,notes:[{midiKey:90}],noteCount:1});assert.equal(f.controller.getSnapshot().state,'running');assert.equal(f.controller.getSnapshot().notes.length,0);f.controller.destroy();
});

test('pause/resume and clearing a loaded cache reflect worker results',async()=>{
  const f=fixture();await ready(f);await f.controller.pause();assert.equal(f.controller.getSnapshot().state,'paused');await f.controller.resume();assert.equal(f.controller.getSnapshot().state,'running');
  await assert.rejects(f.controller.configure({model:'medium'}),/完成或取消/);await f.controller.finish();await f.controller.clearCache('cached-small');assert.equal(f.controller.getSnapshot().modelReady,false);f.controller.destroy();
});

test('switching variants discards a stale modelId while an identical configuration keeps it',async()=>{
  const f=fixture();await f.controller.loadPackage('https://example.test/manifest.json');await f.controller.configure({backend:'wasm'});let config=f.workers.at(-1).messages.at(-1).config;assert.equal(config.modelId,'cached-small');
  await f.controller.configure({model:'medium'});config=f.workers.at(-1).messages.at(-1).config;assert.equal(config.modelId,undefined);assert.equal(config.model,'medium');f.controller.destroy();
});

test('switching an idle GPU worker to WASM recreates its ORT realm and reloads the same cache without a download',async()=>{
  const f=fixture();await f.controller.configure({backend:'webgpu',cpuThreads:2});await f.controller.loadPackage('https://example.test/manifest.json');const old=f.workers[0],oldListener=old.onmessage;old.stateEvent({actualBackend:'webgpu'});
  await f.controller.configure({backend:'wasm',cpuThreads:4});assert.equal(old.terminated,true);assert.equal(f.workers.length,2);assert.equal(f.controller.getSnapshot().modelReady,false);assert.equal(f.controller.getSnapshot().actualBackend,null);assert.equal(f.controller.getSnapshot().modelId,'cached-small');
  const fresh=f.workers[1];assert.ok(fresh.messages.every(message=>message.type==='configure'));assert.ok(fresh.messages.every(message=>message.config.backend==='wasm'&&message.config.cpuThreads===4&&message.config.modelId==='cached-small'));
  oldListener({data:{type:'state',snapshot:{state:'ready',modelReady:true,actualBackend:'webgpu'}}});assert.equal(f.controller.getSnapshot().actualBackend,null);
  await f.controller.loadModel('cached-small');assert.ok(fresh.messages.some(message=>message.type==='loadModel'&&message.modelId==='cached-small'));assert.ok(!fresh.messages.some(message=>['downloadModel','loadPackage'].includes(message.type)));f.controller.destroy();
});

test('CPU thread changes recreate only idle workers; model/batch/same-thread configuration reuses the existing realm',async()=>{
  const f=fixture();await f.controller.configure({backend:'wasm',cpuThreads:2});await f.controller.loadPackage('https://example.test/manifest.json');const original=f.workers[0];
  await f.controller.configure({cpuThreads:2,gpuTokenBatchSize:4});assert.equal(f.workers.length,1);assert.equal(original.terminated,false);
  await f.controller.configure({cpuThreads:4});assert.equal(original.terminated,true);assert.equal(f.workers.length,2);assert.equal(f.workers[1].messages[0].config.model,'small');assert.equal(f.workers[1].messages[0].config.cpuThreads,4);assert.equal(f.workers[1].messages[0].config.modelId,'cached-small');
  await f.controller.configure({model:'medium'});assert.equal(f.workers.length,2);assert.equal(f.workers[1].messages.at(-1).config.modelId,undefined);
  await f.controller.start({sampleRate:16000});await assert.rejects(f.controller.configure({cpuThreads:1}),/完成或取消/);await assert.rejects(f.controller.configure({backend:'webgpu'}),/完成或取消/);assert.equal(f.workers.length,2);assert.equal(f.workers[1].terminated,false);f.controller.destroy();
});

test('reconfiguration aborts old idle metadata RPCs and validates thread requests before dropping a worker',async()=>{
  const f=fixture({handler:message=>message.type==='listModels'});await f.controller.configure({backend:'wasm'});const old=f.workers[0];
  for(const cpuThreads of [0,5,1.5,NaN,'4'])await assert.rejects(f.controller.configure({cpuThreads}),/1–4/);assert.equal(old.terminated,false);
  const waiting=f.controller.listModels(),rejected=assert.rejects(waiting,error=>error.name==='AbortError');await turn();await f.controller.configure({cpuThreads:4});await rejected;assert.equal(old.terminated,true);assert.equal(f.workers.length,2);f.controller.destroy();
});

test('a reply already queued for an old worker cannot restore ready state after cancellation',async()=>{
  let reply;const f=fixture({handler(message,worker){if(message.type==='configure'&&message.config.allowSlow){reply=()=>worker.reply(message.id,{state:'ready',modelReady:true,modelId:'old-cache',actualBackend:'webgpu'});return true;}}});
  await f.controller.configure({backend:'wasm'});const changing=f.controller.configure({allowSlow:true});await turn();reply();f.controller.cancel();await assert.rejects(changing,error=>error.name==='AbortError');assert.equal(f.controller.getSnapshot().state,'cancelled');assert.equal(f.controller.getSnapshot().modelReady,false);assert.equal(f.controller.getSnapshot().actualBackend,null);f.controller.destroy();
});

test('NO_ACTIVE_JOB after a worker inference failure preserves and rejects with the first actionable error',async()=>{
  for(const original of [{message:'GPU buffer no longer exists',code:'GPU_DEVICE_LOST'},null]){
    const f=fixture({handler(message,worker){if(message.type==='appendAudio'){if(original)worker.stateEvent({state:'error',error:original});worker.errorReply(message.id,{message:'No active job',code:'NO_ACTIVE_JOB'});return true;}}});
    await ready(f);await assert.rejects(f.controller.appendAudio({pcm:new Float32Array(160),sampleRate:16000}),error=>error.code===(original?.code||'NO_ACTIVE_JOB')&&error.message===(original?.message||'No active job'));
    assert.equal(f.controller.getSnapshot().error.code,original?.code||'NO_ACTIVE_JOB');assert.equal(f.controller.getSnapshot().error.message,original?.message||'No active job');f.controller.destroy();
  }
});

test('invalid sources and PCM fail before transfer or worker allocation',async()=>{
  const f=fixture();for(const source of ['file:///model.json','javascript:alert(1)','https://user:pass@example.test/model.json'])await assert.rejects(f.controller.loadPackage(source),/HTTP/);
  await assert.rejects(f.controller.start({sampleRate:1}),/采样率/);assert.equal(f.workers.length,0);
  await ready(f);const source=new Float32Array(160001);await assert.rejects(f.controller.appendAudio({pcm:source,sampleRate:16000,transfer:true}),/10 秒/);assert.equal(source.length,160001);f.controller.destroy();
});

test('worker failures reject pending requests and stale observers cannot suppress other subscribers',async()=>{
  const f=fixture({handler:data=>data.type==='listModels'}),seen=[];f.controller.subscribe(()=>{throw new Error('observer');});f.controller.subscribe(snapshot=>seen.push(snapshot.state));
  const pending=f.controller.listModels();await turn();let prevented=false;f.workers[0].onerror({message:'lost',preventDefault(){prevented=true;}});
  await assert.rejects(pending,/lost/);assert.equal(prevented,true);assert.equal(f.controller.getSnapshot().error.code,'TRANSCRIPTION_WORKER_FAILED');assert.ok(seen.includes('error'));assert.ok(f.observerErrors.length);f.controller.destroy();
});

test('request timeout releases an unresponsive worker and a later command can recover',async()=>{
  let stuck=true;const f=fixture({requestTimeoutMs:8,handler:data=>data.type==='listModels'&&stuck});
  await assert.rejects(f.controller.listModels(),error=>error.code==='TRANSCRIPTION_TIMEOUT');assert.equal(f.workers[0].terminated,true);stuck=false;
  assert.deepEqual(await f.controller.listModels(),[{id:'cached-small'}]);assert.equal(f.workers.length,2);f.controller.destroy();
});

test('destroy aborts pending work and rejects later commands',async()=>{
  const f=fixture({handler:data=>data.type==='listModels'});const pending=f.controller.listModels();await turn();f.controller.destroy();await assert.rejects(pending,error=>error.name==='AbortError');await assert.rejects(f.controller.listModels(),error=>error.code==='TRANSCRIPTION_DESTROYED');
});
