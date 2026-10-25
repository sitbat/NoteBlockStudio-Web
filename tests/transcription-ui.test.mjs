import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transcriptionViewState,transcriptionCapabilities,transcriptionMonoPCM,createMicrophoneCapture,formatTranscriptionBytes,createTranscriptionDownloadGate,transcriptionShortcutAction} from '../js/transcription-ui.js';

test('transcription UI never enables recording merely because a browser API exists',()=>{
  const scope={WebAssembly,navigator:{gpu:{requestAdapter(){}},ml:{createContext(){}},mediaDevices:{getUserMedia(){}}},AudioWorkletNode(){}};
  assert.deepEqual(transcriptionCapabilities(scope),{secure:true,webgpu:true,webnn:true,wasm:true,microphone:true});
  assert.equal(transcriptionViewState({state:'idle'}).canRecord,false);
  assert.equal(transcriptionViewState({state:'ready',modelReady:true}).canRecord,true);
  assert.equal(transcriptionViewState({state:'loading',modelReady:true}).canRecord,false);
  assert.equal(transcriptionViewState({state:'ready',modelReady:false}).canRecord,false);
  assert.equal(transcriptionViewState({state:'completed',modelReady:false}).canImport,false);
});

test('transcription shortcuts preserve text input, existing modals and composition instead of opening capture prompts',()=>{
  const event={ctrlKey:true,altKey:true,code:'KeyH',target:{closest:()=>null}};
  assert.equal(transcriptionShortcutAction(event),'toggleRecording');assert.equal(transcriptionShortcutAction({...event,code:'KeyA'}),'chooseAudio');assert.equal(transcriptionShortcutAction({...event,code:'KeyT'}),'open');
  for(const patch of [{repeat:true},{isComposing:true},{metaKey:true},{shiftKey:true},{altKey:false},{defaultPrevented:true},{target:{closest:()=>({})}}])assert.equal(transcriptionShortcutAction({...event,...patch}),null);
  assert.equal(transcriptionShortcutAction(event,{modalOpen:true}),null);
});

test('live results remain preview-only until a recording has stopped and inference completes',()=>{
  const notes=[{startSeconds:0,midiKey:60}];
  assert.equal(transcriptionViewState({state:'running',notes,modelReady:true},true).canInsert,false);
  assert.equal(transcriptionViewState({state:'draining',notes}).canInsert,false);
  assert.equal(transcriptionViewState({state:'completed',notes},true).canInsert,false);
  assert.equal(transcriptionViewState({state:'completed',notes}).canInsert,true);
  assert.equal(transcriptionViewState({state:'completed',notes,error:'failed'}).canInsert,false);
  assert.equal(transcriptionViewState({state:'cancelled',notes}).canInsert,false);
});

test('random-weight packages never enable music capture, import or project insertion',()=>{
  const view=transcriptionViewState({state:'completed',modelReady:true,testOnly:true,notes:[{midiKey:60}]});
  assert.equal(view.canRecord,false);assert.equal(view.canImport,false);assert.equal(view.canInsert,false);assert.equal(view.canConfigure,true);
});

function downloadFixture({models=[],available=true,download,load,cancel}={}) {
  let clock=0;const calls=[],source={small:{variant:'small',label:'small',url:'https://www.modelscope.cn/models/small/model.safetensors',packageURL:'https://localhost/models/small/model.json',bytes:412000000,available,unavailableReason:'缺少浏览器转换图'},medium:{variant:'medium',label:'medium',url:'https://www.modelscope.cn/models/medium/model.safetensors',bytes:1230000000,available}};
  const gate=createTranscriptionDownloadGate({getInfo:variant=>source[variant],now:()=>clock,listModels:async()=>{calls.push('list');return models;},loadModel:async id=>{calls.push(`cache:${id}`);return load?load(id):{modelReady:true,testOnly:false};},downloadModel:async(variant,options)=>{calls.push(`download:${variant}`);return download?download(variant,options):{modelReady:true,testOnly:false};},cancelDownload:async()=>{calls.push('cancel');return cancel?.();}});
  return {gate,calls,source,time:value=>clock=value};
}

test('opening or inspecting download information never fetches weights before explicit confirmation',async()=>{
  const f=downloadFixture();assert.equal(f.calls.length,0);assert.equal(f.gate.getSnapshot().phase,'idle');
  await assert.rejects(f.gate.confirm(),/确认/);assert.equal(f.calls.length,0);
  await f.gate.inspect('small');assert.deepEqual(f.calls,['list']);assert.equal(f.gate.getSnapshot().phase,'confirm');
  assert.equal(f.gate.getSnapshot().info.bytes,412000000);await f.gate.confirm();assert.deepEqual(f.calls,['list','download:small']);assert.equal(f.gate.getSnapshot().phase,'complete');assert.equal(f.gate.getSnapshot().progress.downloadedBytes,412000000,'a successful installation proves the full download even if the last progress event was throttled');
  assert.equal(formatTranscriptionBytes(412000000),'412.0 MB');assert.equal(formatTranscriptionBytes(1230000000),'1.23 GB');
});

test('usable cached models bypass weight downloads while test-only caches cannot be mistaken for music models',async()=>{
  const f=downloadFixture({models:[{id:'real-small',variant:'small',testOnly:false}]});await f.gate.inspect('small');assert.equal(f.gate.getSnapshot().phase,'cached');await f.gate.useCached();
  assert.deepEqual(f.calls,['list','cache:real-small']);assert.equal(f.gate.getSnapshot().phase,'complete');
  const testOnly=downloadFixture({models:[{id:'random-small',variant:'small',testOnly:true}]});await testOnly.gate.inspect('small');assert.equal(testOnly.gate.getSnapshot().phase,'confirm');assert.deepEqual(testOnly.calls,['list']);
});

test('download consent freezes concurrency for this attempt and a later retry can select another value',async()=>{
  let reject;const received=[],f=downloadFixture({download:(_variant,options)=>{received.push(options.concurrency);return received.length===1?new Promise((_resolve,no)=>{reject=no;}):Promise.resolve({modelReady:true,testOnly:false});}});
  await f.gate.inspect('small');for(const concurrency of [0,5,1.5,null,'4',Infinity])await assert.rejects(f.gate.confirm({concurrency}),/1–4/);
  assert.equal(received.length,0);assert.equal(f.gate.getSnapshot().phase,'confirm');const options={concurrency:4},pending=f.gate.confirm(options);options.concurrency=1;
  assert.equal(f.gate.getSnapshot().concurrency,4);assert.deepEqual(received,[4]);reject(new Error('network stopped'));await assert.rejects(pending,/network/);
  await f.gate.retry({concurrency:1});assert.deepEqual(received,[4,1]);assert.equal(f.gate.getSnapshot().concurrency,1);
});

test('missing browser graphs leave download unavailable instead of pretending raw weights are usable',async()=>{
  const f=downloadFixture({available:false});await f.gate.inspect('small');assert.equal(f.gate.getSnapshot().phase,'unavailable');assert.match(f.gate.getSnapshot().info.unavailableReason,/转换图/);
  await assert.rejects(f.gate.confirm());assert.deepEqual(f.calls,['list']);
  const invalid=downloadFixture({download:async()=>({modelReady:false})});await invalid.gate.inspect('small');await assert.rejects(invalid.gate.confirm(),/尚不可用于/);assert.equal(invalid.gate.getSnapshot().phase,'error');
});

test('download progress reports real byte totals, stage changes and observed transfer speed',async()=>{
  let complete;const f=downloadFixture({download:()=>new Promise(resolve=>{complete=resolve;})});await f.gate.inspect('small');const request=f.gate.confirm();
  f.time(1000);f.gate.progress({stage:'download',variant:'small',loaded:1000000,total:412000000,path:'model.safetensors'});assert.equal(f.gate.getSnapshot().progress.bytesPerSecond,1000000);
  f.time(1500);f.gate.progress({stage:'download',variant:'small',loaded:2000000,total:412000000,path:'model.safetensors'});assert.equal(f.gate.getSnapshot().progress.bytesPerSecond,2000000);
  f.gate.progress({stage:'convert',variant:'small',loaded:1,total:10});const progress=f.gate.getSnapshot().progress;assert.equal(progress.stage,'convert');assert.equal(progress.downloadedBytes,2000000);assert.equal(progress.bytesPerSecond,null);
  f.gate.progress({stage:'download',variant:'medium',loaded:12,total:100});assert.equal(f.gate.getSnapshot().progress.stage,'convert');complete({modelReady:true,testOnly:false});await request;
});

test('download cancellation invalidates late completion and retry requires the previously confirmed source',async()=>{
  let finish;const f=downloadFixture({download:()=>new Promise(resolve=>{finish=resolve;})});await f.gate.inspect('small');const request=f.gate.confirm();
  await f.gate.cancel();assert.equal(f.gate.getSnapshot().phase,'cancelled');assert.ok(f.calls.includes('cancel'));finish({modelReady:true,testOnly:false});await assert.rejects(request,error=>error.name==='AbortError');assert.equal(f.gate.getSnapshot().phase,'cancelled');
  f.source.small.url='https://elsewhere.test/model.safetensors';await assert.rejects(f.gate.retry(),/来源已改变/);assert.equal(f.calls.filter(x=>x.startsWith('download')).length,1);
});

test('failed downloads can retry after consent without an automatic background retry',async()=>{
  let attempt=0;const f=downloadFixture({download:async()=>{if(++attempt===1)throw new Error('network stopped');return {modelReady:true,testOnly:false};}});
  await f.gate.inspect('medium');await assert.rejects(f.gate.confirm(),/network stopped/);assert.equal(attempt,1);assert.equal(f.gate.getSnapshot().canRetry,true);
  await f.gate.retry();assert.equal(attempt,2);assert.equal(f.gate.getSnapshot().phase,'complete');
});

test('download confirmation covers the shown size and checksum as well as the URL',async()=>{
  for(const [field,value]of [['bytes',1230000000],['sha256','changed-sha']]){
    const f=downloadFixture();await f.gate.inspect('small');f.source.small[field]=value;
    await assert.rejects(f.gate.confirm(),/来源或大小已变化/);assert.ok(!f.calls.some(call=>call.startsWith('download:')));
  }
});

test('hard failures and backpressure stop an active microphone; pause keeps it controlled',()=>{
  assert.equal(transcriptionViewState({state:'paused'},true).shouldStopMicrophone,false);
  assert.equal(transcriptionViewState({state:'running',backpressure:true},true).shouldStopMicrophone,true);
  assert.equal(transcriptionViewState({state:'error'},true).shouldStopMicrophone,true);
  assert.equal(transcriptionViewState({state:'cancelled'},true).shouldStopMicrophone,true);
  assert.equal(transcriptionViewState({state:'error'},false).shouldStopMicrophone,false);
  const view=transcriptionViewState({receivedSeconds:NaN,processedSeconds:-2,queuedSeconds:3,firstNoteLatencyMs:15});
  assert.equal(view.receivedSeconds,0);assert.equal(view.processedSeconds,0);assert.equal(view.queuedSeconds,3);assert.equal(view.firstNoteLatencyMs,15);
});

test('native-rate downmix preserves duration, sanitizes samples and yields between bounded blocks',async()=>{
  const length=65538,a=new Float32Array(length).fill(.8),b=new Float32Array(length).fill(-.2);a[0]=NaN;b[1]=Infinity;a[2]=8;b[2]=8;
  let yields=0;const result=await transcriptionMonoPCM({length,numberOfChannels:2,sampleRate:48000,getChannelData:i=>[a,b][i]},{yieldTask:async()=>yields++});
  assert.equal(result.sampleRate,48000);assert.equal(result.duration,length/48000);assert.equal(result.pcm.length,length);assert.equal(yields,1);
  assert.ok(Math.abs(result.pcm[0]+.1)<1e-6);assert.ok(Math.abs(result.pcm[1]-.4)<1e-6);assert.equal(result.pcm[2],1);assert.ok(Math.abs(result.pcm.at(-1)-.3)<1e-6);
  assert.equal(a[2],8,'the decoded AudioBuffer is not rewritten');
});

test('oversized or malformed decoded audio is rejected before channel access or output allocation',async()=>{
  let reads=0;const buffer={length:48000*601,numberOfChannels:1,sampleRate:48000,getChannelData(){reads++;return new Float32Array();}};
  await assert.rejects(transcriptionMonoPCM(buffer),/600 秒/);assert.equal(reads,0);
  await assert.rejects(transcriptionMonoPCM({...buffer,length:3,numberOfChannels:33}),/PCM/);
  await assert.rejects(transcriptionMonoPCM({...buffer,length:3,getChannelData:()=>new Float32Array(2)}),/声道/);
});

function worklet(settings={}) {
  let Processor;const messages=[];
  class AudioWorkletProcessor {constructor(){this.port={onmessage:null,postMessage:(value,transfer)=>messages.push({value,transfer})};}}
  const context={AudioWorkletProcessor,Float32Array,Math,Number,sampleRate:48000,registerProcessor:(name,type)=>{assert.equal(name,'nbs-transcription-capture');Processor=type;}};
  vm.runInNewContext(readFileSync(new URL('../js/transcription-capture-worklet.js',import.meta.url),'utf8'),context);
  return {processor:new Processor({processorOptions:{chunkFrames:128,maxFrames:200,...settings}}),messages};
}

test('actual capture worklet sends bounded mono PCM, clamps bad samples and outputs silence',()=>{
  const f=worklet({maxFrames:1000}),a=new Float32Array(128).fill(.8),b=new Float32Array(128).fill(-.2),output=new Float32Array(128).fill(1);a[0]=Infinity;a[1]=5;b[1]=5;
  f.processor.process([[a,b]],[[output]]);
  assert.equal(f.messages.length,1);const {value,transfer}=f.messages[0];assert.equal(value.type,'audio');assert.equal(value.pcm.length,128);assert.equal(transfer[0],value.pcm.buffer);
  assert.ok(Math.abs(value.pcm[0]+.1)<1e-6);assert.equal(value.pcm[1],1);assert.ok(Math.abs(value.pcm[2]-.3)<1e-6);assert.ok(output.every(v=>v===0));
  f.processor.process([[new Float32Array(50).fill(.25)]],[[new Float32Array(50)]]);
  f.processor.port.onmessage({data:{type:'stop'}});assert.equal(f.messages[1].value.pcm.length,50);assert.equal(f.messages[2].value.type,'stopped');
  f.processor.process([[a]],[[output]]);assert.equal(f.messages.length,3,'stopped capture never emits additional input');
});

test('worklet duration limit includes the final partial block exactly once',()=>{
  const f=worklet(),pcm=new Float32Array(128).fill(.5);
  f.processor.process([[pcm]],[[new Float32Array(128)]]);f.processor.process([[pcm]],[[new Float32Array(128)]]);f.processor.process([[pcm]],[[new Float32Array(128)]]);
  const audio=f.messages.filter(item=>item.value.type==='audio');assert.deepEqual(audio.map(item=>item.value.pcm.length),[128,72]);
  assert.equal(f.messages.filter(item=>item.value.type==='limit').length,1);assert.equal(f.messages.filter(item=>item.value.type==='stopped').length,1);assert.equal(f.processor.frames,200);
});

function microphoneFixture({permission,moduleError,beforeStart}={}) {
  const log=[],nodes=[],contexts=[],tracks=[{stop(){log.push('track-stop');}},{stop(){log.push('track-stop');}}];
  const stream={getTracks:()=>tracks};
  class Context {
    constructor(){this.sampleRate=48000;this.state='suspended';this.destination={};this.audioWorklet={addModule:async url=>{log.push('module');assert.match(String(url),/transcription-capture-worklet\.js$/);if(moduleError)throw moduleError;}};contexts.push(this);}
    async resume(){this.state='running';log.push('resume');}
    createMediaStreamSource(value){assert.equal(value,stream);return {connect(){log.push('source-connect');},disconnect(){log.push('source-disconnect');}};}
    async close(){this.state='closed';log.push('context-close');}
  }
  class Node {
    constructor(context,name,options){assert.equal(name,'nbs-transcription-capture');assert.equal(options.processorOptions.maxFrames,48000*600);this.context=context;this.port={onmessage:null,postMessage:data=>{log.push(data.flush?'flush-stop':'discard-stop');queueMicrotask(()=>{if(data.flush)this.port.onmessage?.({data:{type:'audio',pcm:new Float32Array([.3]),sampleRate:48000}});this.port.onmessage?.({data:{type:'stopped'}});});}};nodes.push(this);}
    connect(){log.push('node-connect');}disconnect(){log.push('node-disconnect');}
  }
  const scope={isSecureContext:true,WebAssembly,AudioContext:Context,AudioWorkletNode:Node,navigator:{mediaDevices:{getUserMedia:async options=>{log.push('permission');assert.equal(options.video,false);return permission?permission(stream):stream;}}}};
  const audio=[],errors=[];
  const capture=createMicrophoneCapture({scope,onAudio:chunk=>{log.push('audio');audio.push(chunk);},onError:error=>errors.push(error),beforeStart:beforeStart||(({sampleRate})=>{assert.equal(sampleRate,48000);log.push('before-start');})});
  return {capture,scope,log,nodes,contexts,audio,errors,stream};
}

test('microphone permission is deferred until explicit start; stop flushes and releases all resources',async()=>{
  const f=microphoneFixture();assert.equal(f.log.length,0);assert.equal(f.capture.active,false);
  await f.capture.start();assert.equal(f.capture.active,true);assert.ok(f.log.indexOf('before-start')<f.log.indexOf('source-connect'));
  assert.ok(f.log.includes('permission'));await f.capture.stop();await f.capture.stop();
  assert.equal(f.capture.active,false);assert.equal(f.capture.state,'stopped');assert.equal(f.audio.length,1);assert.equal(f.contexts[0].state,'closed');assert.ok(f.log.includes('track-stop'));assert.equal(f.log.filter(x=>x==='context-close').length,1);
});

test('denied microphone permission and failed worklet/model preparation close audio contexts',async()=>{
  const denied=microphoneFixture({permission:async()=>{throw Object.assign(new Error('denied'),{name:'NotAllowedError'});}});
  await assert.rejects(denied.capture.start(),/denied/);assert.equal(denied.contexts[0].state,'closed');
  const moduleFailure=microphoneFixture({moduleError:new Error('module missing')});await assert.rejects(moduleFailure.capture.start(),/module missing/);assert.equal(moduleFailure.contexts[0].state,'closed');assert.equal(moduleFailure.log.filter(x=>x==='track-stop').length,2);
  const modelFailure=microphoneFixture({beforeStart:()=>{throw new Error('model failed');}});await assert.rejects(modelFailure.capture.start(),/model failed/);assert.equal(modelFailure.contexts[0].state,'closed');assert.equal(modelFailure.nodes.length,0);
});

test('cancelling while permission is pending stops a late stream and never starts capture',async()=>{
  let allow;const f=microphoneFixture({permission:stream=>new Promise(resolve=>{allow=()=>resolve(stream);})});
  const starting=f.capture.start();await Promise.resolve();await f.capture.destroy();allow();
  await assert.rejects(starting,error=>error.name==='AbortError');assert.equal(f.nodes.length,0);assert.equal(f.capture.active,false);assert.ok(f.log.filter(x=>x==='track-stop').length>=2);
});

test('a synchronous controller rejection stops the microphone rather than silently dropping chunks',async()=>{
  const f=microphoneFixture();let caught;
  const capture=createMicrophoneCapture({scope:f.scope,onAudio:()=>{throw new Error('queue full');},onError:error=>{caught=error;}});
  await capture.start();f.nodes[0].port.onmessage({data:{type:'audio',pcm:new Float32Array(128),sampleRate:48000}});
  await capture.stop({flush:false});await Promise.resolve();assert.equal(capture.active,false);assert.equal(caught?.message,'queue full');assert.equal(f.contexts[0].state,'closed');
});

test('an unavailable secure context never requests microphone permission',async()=>{
  const f=microphoneFixture();f.scope.isSecureContext=false;
  const capture=createMicrophoneCapture({scope:f.scope});await assert.rejects(capture.start(),/HTTPS/);assert.equal(f.log.length,0);
});

test('slow PCM handoff is bounded and reports one failure instead of accumulating chunks',async()=>{
  const f=microphoneFixture(),errors=[],release=[];
  const capture=createMicrophoneCapture({scope:f.scope,maxPendingChunks:2,onAudio:()=>new Promise(resolve=>release.push(resolve)),onError:error=>errors.push(error)});
  await capture.start();const port=f.nodes[0].port;
  for(let i=0;i<5;i++)port.onmessage?.({data:{type:'audio',pcm:new Float32Array(128),sampleRate:48000}});
  await capture.stop({flush:false});await Promise.resolve();
  assert.equal(release.length,2);assert.equal(errors.length,1);assert.match(errors[0].message,/积压/);assert.equal(capture.active,false);
  release.forEach(resolve=>resolve());
});
