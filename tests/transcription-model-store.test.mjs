import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {installTranscriptionSource,readTranscriptionAsset,listTranscriptionModels,getTranscriptionModel,ensureTranscriptionModelPreprocessing,clearTranscriptionModel,validateTranscriptionManifest} from '../js/transcription-model-store.js';
import {TRANSCRIPTION_PREPROCESSING_PATCHES} from '../js/transcription-preprocessing-patches.js';

const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const data=new Uint8Array(new Uint32Array([0x80000000,0x7fc01234]).buffer),header=encode({a:{dtype:'F32',shape:[2],data_offsets:[0,8]}}),prefix=new Uint8Array(8);
  new DataView(prefix.buffer).setBigUint64(0,BigInt(header.length),true);
  const original=new Uint8Array(prefix.length+header.length+data.length);original.set(prefix);original.set(header,8);original.set(data,8+header.length);
  const map={kind:'nbs-muscriptor-weight-map',version:1,source:{tensors:{a:{dtype:'F32',shape:[2],aliases:[]}}},target:{path:'weights.bin',bytes:8},segments:[{sourceKey:'a',sourceShape:[2],sourceDtype:'F32',targetDtype:'F32',shape:[2],op:'copy',offset:0,bytes:8}]};
  const assets=new Map([['prefill.onnx',Uint8Array.of(1,2)],['step.onnx',Uint8Array.of(3,4,5)],['weight-map.json',encode(map)]]);
  const template={kind:'nbs-muscriptor-onnx',version:1,id:'small-source-test',variant:'small',precision:'fp32',sampleRate:16000,chunkSamples:80000,melFrames:501,melBins:512,prefixLength:503,headDim:64,validTokenUpperExclusive:1393,layers:2,heads:2,card:1393,bos:1393,maxTokens:2000,graphs:{prefill:'prefill.onnx',step:'step.onnx'},externalData:['weights.bin'],files:[...assets].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}))};
  const source={kind:'nbs-muscriptor-source-onnx',version:1,runtimeTemplate:template,mapping:'weight-map.json',derivedAssets:[{path:'weights.bin',bytes:8,sha256:hash(data)}]};
  const info={available:true,variant:'small',bytes:original.length,sha256:hash(original),url:'https://models.example/original.safetensors',packageURL:'https://static.example/small/model.json'};
  return {data,original,map,assets,template,source,info};
}
function transport(f,{mutateAsset,mutateOriginal}={}){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const href=String(url);calls.push({url:href,options});if(options?.signal?.aborted)throw new DOMException('Cancelled','AbortError');
    let body;if(href===f.info.packageURL)body=encode(f.source);
    else if(href===f.info.url)body=mutateOriginal?mutateOriginal(f.original.slice()):f.original;
    else {const name=new URL(href).pathname.split('/').at(-1);assert(f.assets.has(name),`unexpected network request ${href}`);body=f.assets.get(name);if(mutateAsset)body=mutateAsset(name,body.slice());}
    return new Response(body,{headers:{'content-length':String(body.byteLength)}});
  };
  return {calls,fetchImpl,weightCalls:()=>calls.filter(call=>call.url===f.info.url).length};
}

// This transaction adapter exercises the real install/hash/map/cache orchestration
// with real Blob bytes; browser IndexedDB implementation is tested separately.
function memoryCache(t,{onPut}={}){
  const saved=Object.getOwnPropertyDescriptor(globalThis,'indexedDB'),savedCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  const tables={models:new Map(),assets:new Map()},writes=[];let opens=0;
  const resultRequest=result=>{const request={};queueMicrotask(()=>{request.result=result;request.onsuccess?.();});return request;};
  const database={close(){},transaction(names,mode='readonly'){
    let aborted=false;const pending=[],tx={abort(){if(aborted)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){return {get:key=>resultRequest(structuredClone(tables[name].get(key))),getAll:()=>resultRequest([...tables[name].values()].map(value=>structuredClone(value))),put:value=>{assert.equal(mode,'readwrite');if(aborted)throw new DOMException('Transaction aborted','InvalidStateError');const key=name==='models'?value.id:value.key;pending.push(()=>{tables[name].set(key,structuredClone(value));writes.push([name,key]);});onPut?.({name,key,tx});},delete:key=>pending.push(()=>tables[name].delete(key))};}};
    setImmediate(()=>{if(aborted)return;for(const operation of pending)operation();tx.oncomplete?.();});return tx;
  }};
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){opens++;return resultRequest(database);}}});
  if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  t.after(()=>{if(saved)Object.defineProperty(globalThis,'indexedDB',saved);else delete globalThis.indexedDB;if(savedCrypto)Object.defineProperty(globalThis,'crypto',savedCrypto);else delete globalThis.crypto;});
  return {tables,writes,get opens(){return opens;}};
}

test('source installer verifies graphs, original SHA and exact mapped bytes before one cache transaction',async t=>{
  const f=fixture(),network=transport(f),cache=memoryCache(t),progress=[];
  const manifest=await installTranscriptionSource(f.info,{fetchImpl:network.fetchImpl,estimate:async()=>({quota:1e9,usage:0}),onProgress:value=>progress.push(value)});
  assert.equal(network.weightCalls(),1);assert.equal(network.calls.length,5);assert.equal(cache.opens,1);assert.equal(cache.tables.models.size,1);assert.equal(cache.tables.assets.size,4);
  assert.deepEqual(await readTranscriptionAsset(manifest.id,'weights.bin'),f.data);assert.equal(manifest.files.find(file=>file.path==='weights.bin').sha256,hash(f.data));
  assert.deepEqual(manifest.source,{url:f.info.url,bytes:f.info.bytes,sha256:f.info.sha256});
  assert.deepEqual((await listTranscriptionModels()).map(item=>[item.id,item.variant,item.testOnly]),[[f.template.id,'small',false]]);
  assert(progress.some(item=>item.stage==='download'));assert(progress.some(item=>item.stage==='convert'));assert(progress.some(item=>item.stage==='cache'&&item.loaded===manifest.totalBytes));
  assert.equal(network.calls.at(-1).options.credentials,'omit');
});

test('unavailable model or invalid source hash is rejected without opening any connection or cache',async t=>{
  const f=fixture(),network=transport(f),cache=memoryCache(t);
  for(const info of [{...f.info,available:false},{...f.info,variant:'large'},{...f.info,sha256:'bad'},{...f.info,bytes:1.5}])await assert.rejects(installTranscriptionSource(info,{fetchImpl:network.fetchImpl}),{code:'MODEL_SOURCE_UNAVAILABLE'});
  assert.equal(network.calls.length,0);assert.equal(cache.opens,0);
});

test('source/template mismatches fail before downloading any large original weight',async t=>{
  const cache=memoryCache(t);
  for(const mutate of [f=>f.source.version=2,f=>f.source.runtimeTemplate.variant='medium',f=>f.source.derivedAssets[0].path='other.bin',f=>f.source.mapping='../weight-map.json',f=>f.template.testOnly=true,f=>f.template.files.push({path:'weights.bin',bytes:8,sha256:hash(f.data)})]){
    const f=fixture();mutate(f);const network=transport(f);await assert.rejects(installTranscriptionSource(f.info,{fetchImpl:network.fetchImpl}));assert.equal(network.weightCalls(),0);
  }
  assert.equal(cache.opens,0);
});

test('insufficient browser storage stops after the small manifest and before graphs or model bytes',async t=>{
  const f=fixture(),network=transport(f),cache=memoryCache(t);
  await assert.rejects(installTranscriptionSource(f.info,{fetchImpl:network.fetchImpl,estimate:async()=>({quota:1000,usage:999})}),{code:'CACHE_QUOTA'});
  assert.equal(network.calls.length,1);assert.equal(network.weightCalls(),0);assert.equal(cache.opens,0);
});

test('a corrupt graph or static package that declares a huge asset is rejected before model download',async t=>{
  const cache=memoryCache(t),f=fixture(),corrupt=transport(f,{mutateAsset:(name,body)=>{if(name==='prefill.onnx')body[0]^=255;return body;}});
  await assert.rejects(installTranscriptionSource(f.info,{fetchImpl:corrupt.fetchImpl}),{code:'MODEL_HASH_MISMATCH'});assert.equal(corrupt.weightCalls(),0);
  const huge=fixture();huge.template.files[0].bytes=16*1024*1024+1;const network=transport(huge);
  await assert.rejects(installTranscriptionSource(huge.info,{fetchImpl:network.fetchImpl}),/过大/);assert.equal(network.calls.length,1);assert.equal(network.weightCalls(),0);assert.equal(cache.opens,0);
});

test('a full-size original with the wrong SHA is never adapted or cached',async t=>{
  const f=fixture(),network=transport(f,{mutateOriginal:body=>{body[body.length-1]^=1;return body;}}),cache=memoryCache(t),progress=[];
  await assert.rejects(installTranscriptionSource(f.info,{fetchImpl:network.fetchImpl,onProgress:value=>progress.push(value)}),{code:'MODEL_HASH_MISMATCH'});
  assert.equal(network.weightCalls(),1);assert.equal(cache.opens,0);assert.equal(cache.writes.length,0);assert.equal(progress.some(item=>item.stage==='convert'),false);
});

test('derived SHA mismatch and cancellation after conversion leave no partial model in cache',async t=>{
  const cache=memoryCache(t),f=fixture();f.source.derivedAssets[0].sha256='0'.repeat(64);const network=transport(f);
  await assert.rejects(installTranscriptionSource(f.info,{fetchImpl:network.fetchImpl}),{code:'MODEL_HASH_MISMATCH'});assert.equal(cache.opens,0);
  const good=fixture(),second=transport(good),controller=new AbortController();
  await assert.rejects(installTranscriptionSource(good.info,{fetchImpl:second.fetchImpl,signal:controller.signal,onProgress:value=>{if(value.stage==='convert'&&value.loaded===8)controller.abort();}}),{name:'AbortError'});
  assert.equal(cache.opens,0);assert.equal(cache.writes.length,0);
});

test('manifest validation clones and deeply freezes the protocol and rejects URL-significant paths',()=>{
  const f=fixture(),raw={...f.template,files:[...f.template.files,{path:'weights.bin',bytes:8,sha256:hash(f.data)}]},manifest=validateTranscriptionManifest(raw);
  assert(Object.isFrozen(manifest));assert(Object.isFrozen(manifest.files));assert(Object.isFrozen(manifest.files[0]));assert(Object.isFrozen(manifest.graphs));
  raw.files[0].bytes=999;assert.equal(manifest.files[0].bytes,2);assert.throws(()=>manifest.files[0].bytes=999,TypeError);
  for(const path of ['../prefill.onnx','./prefill.onnx','/prefill.onnx','C:/prefill.onnx','x\\prefill.onnx','%2e%2e/prefill.onnx','prefill.onnx?url=x','prefill.onnx#part','folder//prefill.onnx',' x.onnx','x\non.onnx','x:prefill.onnx']){
    const invalid=structuredClone(manifest);invalid.files[0].path=path;invalid.graphs.prefill=path;assert.throws(()=>validateTranscriptionManifest(invalid),{code:'MODEL_INVALID'},path);
  }
});

function coefficientFixture(cache,{variant='small'}={}){
  const f=fixture(),id=`muscriptor-${variant}-fp32-source`,oldWindow=new Uint8Array(8192).fill(1),oldMel=new Uint8Array(2099200).fill(2),newWindow=new Uint8Array(8192).fill(3),newMel=new Uint8Array(2099200).fill(4);
  const file=(path,bytes)=>({path,bytes:bytes.length,sha256:hash(bytes)}),oldFiles={window:file('window.f32',oldWindow),melFilter:file('mel-filter.f32',oldMel)},source={sha256:hash('pinned original source'),bytes:variant==='small'?411888600:1228144472};
  const manifest=validateTranscriptionManifest({...f.template,id,variant,source,preprocessing:{window:'window.f32',melFilter:'mel-filter.f32'},files:[...f.template.files,oldFiles.window,oldFiles.melFilter,file('weights.bin',f.data)]});
  const next=[file('window-v2.f32',newWindow),file('mel-filter-v2.f32',newMel)],patch={version:2,variant,modelId:id,source,expected:{graphs:Object.fromEntries(['prefill','step'].map(role=>[role,manifest.files.find(item=>item.path===manifest.graphs[role])])),mapping:manifest.files.find(item=>item.path==='weight-map.json'),preprocessing:oldFiles},preprocessing:{window:'window-v2.f32',melFilter:'mel-filter-v2.f32'},files:next.map(item=>({...item,url:new URL(`../assets/transcription/${variant}/${item.path}`,import.meta.url).href}))};
  const weight=new Blob([f.data]),record={id,manifest,installedAt:12345,customMetadata:'preserved'};cache.tables.models.set(id,record);
  for(const [path,data]of [...f.assets,['window.f32',oldWindow],['mel-filter.f32',oldMel],['weights.bin',weight]])cache.tables.assets.set(`${id}/${path}`,{key:`${id}/${path}`,data:data instanceof Blob?data:new Blob([data])});
  const calls=[],fetchImpl=async url=>{calls.push(String(url));const name=String(url).split('/').at(-1);assert(['window-v2.f32','mel-filter-v2.f32'].includes(name),'only the two small coefficient assets may be fetched');const data=name==='window-v2.f32'?newWindow:newMel;return new Response(data,{headers:{'content-length':String(data.length)}});};
  return {id,manifest,patch,record,weight,originalWeightBytes:f.data,newWindow,newMel,calls,fetchImpl};
}

test('known cache coefficient upgrade is atomic, preserves old assets and never reads or rewrites large weights',async t=>{
  const cache=memoryCache(t),f=coefficientFixture(cache),oldWindow=cache.tables.assets.get(`${f.id}/window.f32`).data,oldMel=cache.tables.assets.get(`${f.id}/mel-filter.f32`).data,progress=[];
  const upgraded=await getTranscriptionModel(f.id,{patches:[f.patch],fetchImpl:f.fetchImpl,onProgress:value=>progress.push(value)});
  assert.equal(upgraded.preprocessingRevision,2);assert.equal(upgraded.preprocessingVersion,2);assert.deepEqual(upgraded.preprocessing,f.patch.preprocessing);
  assert.equal(upgraded.files.length,f.manifest.files.length+2);assert.equal(upgraded.totalBytes,f.manifest.totalBytes+8192+2099200);assert.match(upgraded.preprocessingPatch.fingerprintSHA256,/^[a-f0-9]{64}$/);
  assert.deepEqual(upgraded.preprocessingPatch.previousPreprocessing,f.manifest.preprocessing);assert.equal(upgraded.preprocessingPatch.sourceSHA256,f.patch.source.sha256);
  assert.equal(cache.tables.assets.get(`${f.id}/weights.bin`).data,f.weight,'same original Blob object remains stored');assert.deepEqual(new Uint8Array(await f.weight.arrayBuffer()),f.originalWeightBytes);
  assert.equal(cache.tables.assets.get(`${f.id}/window.f32`).data,oldWindow);assert.equal(cache.tables.assets.get(`${f.id}/mel-filter.f32`).data,oldMel);
  assert.equal(cache.tables.models.get(f.id).installedAt,12345);assert.equal(cache.tables.models.get(f.id).customMetadata,'preserved');assert.equal(cache.writes.length,3);assert(cache.writes.every(([,key])=>!key.endsWith('/weights.bin')));
  assert.equal(f.calls.length,2);assert(progress.every(item=>item.stage==='preprocessing'&&item.message.includes('不重新下载权重')));assert.equal(progress.at(-1).complete,true);
});

test('listing models never migrates and an already upgraded source is idempotent',async t=>{
  const cache=memoryCache(t),f=coefficientFixture(cache);assert.equal((await listTranscriptionModels())[0].id,f.id);assert.equal(f.calls.length,0);assert.equal(cache.writes.length,0);
  await ensureTranscriptionModelPreprocessing(f.id,{patches:[f.patch],fetchImpl:f.fetchImpl});const writes=cache.writes.length,requests=f.calls.length;
  const again=await getTranscriptionModel(f.id,{patches:[f.patch],fetchImpl:()=>{throw new Error('must not fetch twice');}});
  assert.equal(again.preprocessingRevision,2);assert.equal(cache.writes.length,writes);assert.equal(f.calls.length,requests);
});

test('custom/test sources or a mismatched source/graph/map/coefficient fingerprint are not patched',async t=>{
  const cache=memoryCache(t);
  for(const change of [m=>m.id='user-custom',m=>m.testOnly=true,m=>m.source.sha256='0'.repeat(64),m=>m.source.bytes++,m=>m.files.find(file=>file.path===m.graphs.prefill).sha256='0'.repeat(64),m=>m.files.find(file=>file.path==='weight-map.json').sha256='0'.repeat(64),m=>m.files.find(file=>file.path==='window.f32').sha256='0'.repeat(64)]){
    cache.tables.models.clear();cache.tables.assets.clear();const f=coefficientFixture(cache),modified=structuredClone(f.manifest);change(modified);cache.tables.models.delete(f.id);cache.tables.models.set(modified.id,{id:modified.id,manifest:modified,installedAt:123});
    const before=cache.tables.models.get(modified.id),result=await getTranscriptionModel(modified.id,{patches:[f.patch],fetchImpl:()=>{throw new Error('fingerprint mismatch must not fetch');}});
    assert.deepEqual(result.preprocessing,modified.preprocessing);assert.equal(cache.tables.models.get(modified.id),before);assert.equal(cache.writes.length,0);
  }
});

test('corrupt corrected coefficients or pre/during-fetch cancellation leave the original cache intact',async t=>{
  const cache=memoryCache(t),f=coefficientFixture(cache),before=cache.tables.models.get(f.id),controller=new AbortController();controller.abort();
  await assert.rejects(getTranscriptionModel(f.id,{patches:[f.patch],signal:controller.signal,fetchImpl:f.fetchImpl}),{name:'AbortError'});assert.equal(f.calls.length,0);
  await assert.rejects(getTranscriptionModel(f.id,{patches:[f.patch],fetchImpl:async url=>{const data=String(url).includes('window-v2')?f.newWindow.slice():f.newMel.slice();data[0]^=1;return new Response(data);}}),{code:'MODEL_HASH_MISMATCH'});
  const during=new AbortController();await assert.rejects(getTranscriptionModel(f.id,{patches:[f.patch],signal:during.signal,fetchImpl:f.fetchImpl,onProgress:value=>{if(value.loaded===8192)during.abort();}}),{name:'AbortError'});
  assert.equal(cache.writes.length,0);assert.equal(cache.tables.models.get(f.id),before);assert.equal(cache.tables.assets.get(`${f.id}/weights.bin`).data,f.weight);assert.equal(cache.tables.assets.has(`${f.id}/window-v2.f32`),false);
});

test('cancellation during the write transaction rolls back both new coefficient keys and manifest',async t=>{
  const controller=new AbortController(),cache=memoryCache(t,{onPut:({key})=>{if(key.endsWith('/window-v2.f32'))controller.abort();}}),f=coefficientFixture(cache),before=cache.tables.models.get(f.id);
  await assert.rejects(getTranscriptionModel(f.id,{patches:[f.patch],signal:controller.signal,fetchImpl:f.fetchImpl}),{name:'AbortError'});
  assert.equal(cache.writes.length,0);assert.equal(cache.tables.models.get(f.id),before);assert.equal(cache.tables.assets.has(`${f.id}/window-v2.f32`),false);assert.equal(cache.tables.assets.has(`${f.id}/mel-filter-v2.f32`),false);assert.equal(cache.tables.assets.get(`${f.id}/weights.bin`).data,f.weight);
});

test('a concurrent model replacement is not overwritten by a staged coefficient repair',async t=>{
  const cache=memoryCache(t),f=coefficientFixture(cache);let replacement;
  await assert.rejects(getTranscriptionModel(f.id,{patches:[f.patch],fetchImpl:f.fetchImpl,onProgress:value=>{if(value.loaded===value.total&&!value.complete){replacement={...cache.tables.models.get(f.id),manifest:{...f.manifest,title:'concurrent edit'}};cache.tables.models.set(f.id,replacement);}}}),{code:'MODEL_CACHE_CHANGED'});
  assert.equal(cache.tables.models.get(f.id),replacement);assert.equal(cache.writes.length,0);assert.equal(cache.tables.assets.has(`${f.id}/window-v2.f32`),false);assert.equal(cache.tables.assets.get(`${f.id}/weights.bin`).data,f.weight);
});

test('a versioned-path conflict is rejected and clear-cache removes old and new coefficients after upgrade',async t=>{
  const cache=memoryCache(t),f=coefficientFixture(cache),conflict={...f.manifest,files:[...f.manifest.files,{path:'window-v2.f32',bytes:8192,sha256:'0'.repeat(64)}]};cache.tables.models.set(f.id,{id:f.id,manifest:conflict});
  await assert.rejects(getTranscriptionModel(f.id,{patches:[f.patch],fetchImpl:f.fetchImpl}),{code:'MODEL_PATCH_CONFLICT'});assert.equal(f.calls.length,0);
  cache.tables.models.set(f.id,f.record);await getTranscriptionModel(f.id,{patches:[f.patch],fetchImpl:f.fetchImpl});await clearTranscriptionModel(f.id);assert.equal(cache.tables.models.size,0);assert.equal(cache.tables.assets.size,0);
});

test('both production patch descriptors upgrade the exact known old metadata using only real corrected static coefficients',async t=>{
  const cache=memoryCache(t);
  for(const patch of TRANSCRIPTION_PREPROCESSING_PATCHES){
    const template=JSON.parse(readFileSync(new URL(`../assets/transcription/${patch.variant}/model.json`,import.meta.url),'utf8')).runtimeTemplate;
    const correctedPaths=new Set(patch.files.map(file=>file.path)),weight=new Blob([Uint8Array.of(1,2,3,4)]),weightFile={path:'weights.bin',bytes:4,sha256:hash(Uint8Array.of(1,2,3,4))};
    const manifest=validateTranscriptionManifest({...template,preprocessingRevision:1,preprocessingVersion:1,preprocessing:Object.fromEntries(Object.entries(patch.expected.preprocessing).map(([role,file])=>[role,file.path])),source:{...patch.source},files:[...template.files.filter(file=>!correctedPaths.has(file.path)),...Object.values(patch.expected.preprocessing),weightFile]});
    cache.tables.models.set(patch.modelId,{id:patch.modelId,manifest,installedAt:123});cache.tables.assets.set(`${patch.modelId}/weights.bin`,{key:`${patch.modelId}/weights.bin`,data:weight});
    const requested=[],updated=await getTranscriptionModel(patch.modelId,{fetchImpl:async url=>{requested.push(String(url));assert(patch.files.some(file=>file.url===String(url)),'production migration only fetches descriptor-pinned coefficient files');return new Response(readFileSync(fileURLToPath(url)));}});
    assert.equal(requested.length,2);assert.equal(updated.preprocessingRevision,2);assert.equal(updated.preprocessing.window,'window-v2.f32');assert.equal(updated.preprocessing.melFilter,'mel-filter-v2.f32');
    assert.equal(updated.files.find(file=>file.path==='window-v2.f32').sha256,'0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b');
    assert.equal(updated.files.find(file=>file.path==='mel-filter-v2.f32').sha256,'a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb');
    assert.equal(cache.tables.assets.get(`${patch.modelId}/weights.bin`).data,weight);
  }
});
