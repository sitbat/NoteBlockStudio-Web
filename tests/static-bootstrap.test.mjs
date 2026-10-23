import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {bootstrap,prepareStaticIsolation} from '../static-bootstrap.js';
import {isolationEnvironment,assertRealtimeEnvironment} from '../js/browser-environment.js';

const MODULE='https://static.example/music/static-bootstrap.js';
function fixture({isolated=false,storage=new Map(),claim=true}={}){
  const calls={register:[],reload:0,app:0},serviceWorker=new EventTarget();
  serviceWorker.getRegistration=async()=>undefined;
  serviceWorker.register=async(url,options)=>{calls.register.push({url,options});if(claim){serviceWorker.controller={scriptURL:url};serviceWorker.dispatchEvent(new Event('controllerchange'));}return {active:{scriptURL:url}};};
  const scope={isSecureContext:true,crossOriginIsolated:isolated,SharedArrayBuffer,WebAssembly,Worker:class{},AudioWorkletNode:class{},navigator:{serviceWorker},sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},location:{protocol:'https:',origin:'https://static.example',pathname:'/music/index.html',search:'?private=do-not-store',hash:'#do-not-store',reload(...args){assert.deepEqual(args,[]);calls.reload++;}}};
  scope.top=scope.self=scope;
  return {scope,calls,storage,serviceWorker,options:{scope,moduleURL:MODULE,timeoutMs:30,loadApp:async()=>{calls.app++;}}};
}
test('an already isolated site loads the app without service-worker registration or reload',async()=>{
  const f=fixture({isolated:true}),status=await bootstrap(f.options);
  assert.equal(status.ready,true);assert.equal(f.calls.app,1);assert.equal(f.calls.register.length,0);assert.equal(f.calls.reload,0);
});
test('first static visit waits for its controller and reloads once before loading app; subdirectory state never includes query/hash',async()=>{
  const f=fixture(),status=await bootstrap({...f.options,moduleURL:MODULE+'?ignored=secret#ignored'});
  assert.equal(status.code,'RELOADING');assert.equal(f.calls.app,0);assert.equal(f.calls.reload,1);
  assert.deepEqual(f.calls.register,[{url:'https://static.example/music/coi-serviceworker.js',options:{scope:'https://static.example/music/',updateViaCache:'none'}}]);
  assert.deepEqual([...f.storage],[['nbs-static-isolation-1:/music/','1']]);
  const again=await bootstrap(f.options);assert.equal(again.code,'ISOLATION_RELOAD_FAILED');assert.equal(f.calls.reload,1);assert.equal(f.calls.register.length,1);
  f.scope.crossOriginIsolated=true;
  const ready=await bootstrap(f.options);assert.equal(ready.ready,true);assert.equal(f.calls.app,1);assert.equal(f.storage.size,0);
});
test('delayed controllerchange is awaited and timeout never starts the app or reloads',async()=>{
  const delayed=fixture({claim:false});
  const pending=prepareStaticIsolation(delayed.options);
  setTimeout(()=>{delayed.serviceWorker.controller={scriptURL:'https://static.example/music/coi-serviceworker.js'};delayed.serviceWorker.dispatchEvent(new Event('controllerchange'));},2);
  assert.equal((await pending).code,'RELOADING');assert.equal(delayed.calls.reload,1);
  const timeout=fixture({claim:false});const status=await bootstrap({...timeout.options,timeoutMs:3});
  assert.equal(status.code,'SERVICE_WORKER_TIMEOUT');assert.equal(timeout.calls.reload,0);assert.equal(timeout.calls.app,0);assert.equal(timeout.storage.size,0);
});
test('blocked or ineffective storage cannot cause an automatic reload loop',async()=>{
  for(const blocked of [true,false]){
    const f=fixture();f.scope.sessionStorage={getItem:()=>null,setItem(){if(blocked)throw new Error('blocked');},removeItem(){}};
    const result=await bootstrap(f.options);assert.equal(result.code,'SESSION_STORAGE_UNAVAILABLE');assert.equal(f.calls.register.length,0);assert.equal(f.calls.reload,0);
  }
});
test('foreign active controllers and registrations are preserved without replacement or unregistering',async()=>{
  for(const controller of [true,false]){
    const f=fixture(),other={scriptURL:'https://static.example/other-worker.js'};
    if(controller)f.serviceWorker.controller=other;else f.serviceWorker.getRegistration=async()=>({active:other});
    assert.equal((await bootstrap(f.options)).code,'SERVICE_WORKER_CONFLICT');assert.equal(f.calls.register.length,0);assert.equal(f.calls.reload,0);
  }
  for(const state of ['waiting','installing']){
    const f=fixture();f.serviceWorker.getRegistration=async()=>({active:{scriptURL:'https://static.example/music/coi-serviceworker.js'},[state]:{scriptURL:'https://static.example/pending-other.js'}});
    assert.equal((await prepareStaticIsolation(f.options)).code,'SERVICE_WORKER_CONFLICT');assert.equal(f.calls.register.length,0);
  }
});
test('file, insecure, embedded, missing service-worker and misplaced entry points have specific diagnostics',async()=>{
  const cases=[['FILE_PROTOCOL',s=>{s.location.protocol='file:';}],['INSECURE_CONTEXT',s=>{s.isSecureContext=false;}],['EMBEDDED_PAGE',s=>{s.top={};}],['SERVICE_WORKER_UNAVAILABLE',s=>{s.navigator={};}],['BOOTSTRAP_SCOPE_INVALID',s=>{s.location.pathname='/different/index.html';}],['ISOLATION_POLICY_DENIED',s=>{s.document={permissionsPolicy:{allowsFeature:()=>false}};}]];
  for(const [code,mutate]of cases){const f=fixture();mutate(f.scope);assert.equal((await prepareStaticIsolation(f.options)).code,code);assert.equal(f.calls.register.length,0);assert.equal(f.calls.reload,0);}
  const failed=fixture();failed.serviceWorker.register=async()=>{throw new DOMException('Script MIME rejected','SecurityError');};assert.equal((await bootstrap(failed.options)).code,'SERVICE_WORKER_FAILED');assert.equal(failed.calls.app,0);
});
test('Rust guard distinguishes isolation, shared-memory, WASM, worker and AudioWorklet failures',()=>{
  const f=fixture({isolated:true}),context={audioWorklet:{}};
  assert.equal(isolationEnvironment(f.scope).ready,true);assert.doesNotThrow(()=>assertRealtimeEnvironment(context,f.scope));
  for(const [key,value,code]of [['isSecureContext',false,'INSECURE_CONTEXT'],['crossOriginIsolated',false,'NOT_CROSS_ORIGIN_ISOLATED'],['SharedArrayBuffer',undefined,'SHARED_MEMORY_UNAVAILABLE'],['WebAssembly',{},'WEBASSEMBLY_UNAVAILABLE'],['Worker',undefined,'WORKERS_UNAVAILABLE'],['AudioWorkletNode',undefined,'AUDIO_WORKLET_UNAVAILABLE']])assert.throws(()=>assertRealtimeEnvironment(context,{...f.scope,[key]:value}),error=>error.code===code);
});
test('a failed app import reports static file diagnostics without retry or downgrade',async()=>{
  const f=fixture({isolated:true});let imports=0;
  const status=await bootstrap({...f.options,loadApp:async()=>{imports++;throw new Error('missing module');}});
  assert.equal(status.code,'APP_LOAD_FAILED');assert.equal(f.scope.__NBS_BOOTSTRAP__,status);assert.equal(imports,1);assert.equal(f.calls.reload,0);
});

const workerSource=await readFile(new URL('../coi-serviceworker.js',import.meta.url),'utf8');
function workerFixture(fetchImpl){
  const handlers=new Map(),calls={skipWaiting:0,claim:0};
  const self={registration:{scope:'https://static.example/music/'},addEventListener:(name,fn)=>handlers.set(name,fn),skipWaiting:async()=>{calls.skipWaiting++;},clients:{claim:async()=>{calls.claim++;}}};
  vm.runInNewContext(workerSource,{self,URL,Headers,Response,fetch:fetchImpl});
  return {handlers,calls,dispatch(request){let response;handlers.get('fetch')({request,respondWith:value=>{response=value;}});return response;}};
}
const request=(url='https://static.example/music/index.html',options={})=>({url,method:'GET',headers:new Headers(),mode:'navigate',cache:'default',...options});
test('isolation worker activates immediately and claims clients without opening any cache',async()=>{
  const f=workerFixture(()=>{throw new Error('not fetched');}),promises=[];
  for(const name of ['install','activate'])f.handlers.get(name)({waitUntil:p=>promises.push(p)});
  await Promise.all(promises);assert.equal(f.calls.skipWaiting,1);assert.equal(f.calls.claim,1);
});
test('network navigation and worker/WASM responses retain content and MIME while gaining exact isolation headers',async()=>{
  const calls=[],f=workerFixture(async(req,options)=>{calls.push({req,options});return new Response('actual-network-body',{headers:{'Content-Type':req.mode==='navigate'?'text/html':'application/wasm','X-Custom':'preserved'}});});
  for(const mode of ['navigate','same-origin']){
    const req=request(undefined,{mode}),result=await f.dispatch(req);
    assert.equal(await result.text(),'actual-network-body');assert.equal(result.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.equal(result.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');assert.equal(result.headers.get('Cross-Origin-Resource-Policy'),'same-origin');assert.equal(result.headers.get('X-Custom'),'preserved');assert.equal(result.headers.get('Content-Type'),mode==='navigate'?'text/html':'application/wasm');
    assert.equal(calls.at(-1).req,req);assert.equal(calls.at(-1).options?.cache,mode==='navigate'?'no-store':undefined);
  }
});
test('POST, API, external, sibling, range and invalid only-if-cached requests are untouched',()=>{
  let fetched=0;const f=workerFixture(async()=>{fetched++;throw new Error('must not fetch');});
  for(const req of [request(undefined,{method:'POST'}),request('https://static.example/music/api/transcode'),request('https://remote.example/music/song.nbs'),request('https://static.example/musical/index.html'),request(undefined,{headers:new Headers({Range:'bytes=0-100'})}),request(undefined,{cache:'only-if-cached',mode:'cors'})])assert.equal(f.dispatch(req),undefined);
  assert.equal(fetched,0);
});
test('opaque, redirects, partial/not-modified and out-of-scope redirect responses are not rewrapped',async()=>{
  for(const response of [{type:'opaque',status:0},{type:'opaqueredirect',status:0},new Response('partial',{status:206}),new Response(null,{status:304}),new Response(null,{status:302})]){const f=workerFixture(async()=>response);assert.equal(await f.dispatch(request()),response);}
  const redirected=new Response('external');Object.defineProperty(redirected,'url',{value:'https://remote.example/private'});assert.equal(await workerFixture(async()=>redirected).dispatch(request()),redirected);
  const followed=new Response('redirected same-origin module');Object.defineProperties(followed,{redirected:{value:true},url:{value:'https://static.example/music/other/module.js'}});assert.equal(await workerFixture(async()=>followed).dispatch(request()),followed);
});
test('worker does not override restrictive policies or turn network failures into cached user data',async()=>{
  const f=workerFixture(async()=>new Response('body',{headers:{'Cross-Origin-Resource-Policy':'same-site','Permissions-Policy':'cross-origin-isolated=()'}}));
  const response=await f.dispatch(request());assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-site');assert.equal(response.headers.get('Permissions-Policy'),'cross-origin-isolated=()');
  const offline=workerFixture(async()=>{throw new Error('network unavailable');});await assert.rejects(offline.dispatch(request()),/network unavailable/);
  assert.doesNotMatch(workerSource,/\bcaches\s*\.|\bindexedDB\s*\.|\.searchParams\b/);
});
