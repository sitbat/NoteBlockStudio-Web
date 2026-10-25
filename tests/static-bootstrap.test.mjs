import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {bootstrap,prepareStaticIsolation} from '../static-bootstrap.js';
import {isolationEnvironment,assertRealtimeEnvironment} from '../js/browser-environment.js';

const MODULE='https://static.example/music/static-bootstrap.js';
const OWN_WORKER='https://static.example/music/coi-serviceworker.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
class WorkerFixture extends EventTarget {
  constructor({scriptURL=OWN_WORKER,state='activated',onMessage=()=>{}}={}){super();this.scriptURL=scriptURL;this.state=state;this.messages=[];this.onMessage=onMessage;this.stateListeners=new Set();}
  addEventListener(type,listener,...options){if(type==='statechange')this.stateListeners.add(listener);super.addEventListener(type,listener,...options);}
  removeEventListener(type,listener,...options){if(type==='statechange')this.stateListeners.delete(listener);super.removeEventListener(type,listener,...options);}
  postMessage(message){this.messages.push(message);this.onMessage(message);}
  transition(state){this.state=state;this.dispatchEvent(new Event('statechange'));}
}
function fixture({isolated=false,storage=new Map(),claim=true,existing=false,workerState='activated',claimOnMessage=true}={}){
  const calls={register:[],get:0,update:0,unregister:0,reload:0,app:0},serviceWorker=new EventTarget();let registered=existing;
  const control=worker=>{serviceWorker.controller=worker;serviceWorker.dispatchEvent(new Event('controllerchange'));};
  const worker=new WorkerFixture({state:workerState,onMessage:message=>{if(claimOnMessage&&message.type==='NBS_STATIC_CLAIM')control(worker);}});
  const registration={active:workerState==='activated'?worker:null,installing:workerState==='activated'?null:worker,waiting:null,update:async()=>{calls.update++;},unregister:async()=>{calls.unregister++;}};
  serviceWorker.getRegistration=async()=>{calls.get++;return registered?registration:undefined;};
  serviceWorker.register=async(url,options)=>{calls.register.push({url,options});registered=true;if(claim&&registration.active)control(registration.active);return registration;};
  const scope={isSecureContext:true,crossOriginIsolated:isolated,SharedArrayBuffer,WebAssembly,Worker:class{},AudioWorkletNode:class{},navigator:{serviceWorker},sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},location:{protocol:'https:',origin:'https://static.example',pathname:'/music/index.html',search:'?private=do-not-store',hash:'#do-not-store',reload(...args){assert.deepEqual(args,[]);calls.reload++;}}};
  scope.top=scope.self=scope;
  const activate=(next=worker)=>{registration.installing=null;registration.waiting=null;registration.active=next;next.transition('activated');};
  return {scope,calls,storage,serviceWorker,worker,registration,control,activate,options:{scope,moduleURL:MODULE,timeoutMs:100,loadApp:async()=>{calls.app++;}}};
}
test('native isolation headers with no own registration load the app without adding a service worker',async()=>{
  const f=fixture({isolated:true}),status=await bootstrap(f.options);
  assert.equal(status.ready,true);assert.equal(f.calls.app,1);assert.equal(f.calls.register.length,0);assert.equal(f.calls.reload,0);
});
test('first static visit uses its activated worker and reloads once; subdirectory state never includes query/hash',async()=>{
  const f=fixture(),status=await bootstrap({...f.options,moduleURL:MODULE+'?ignored=secret#ignored'});
  assert.equal(status.code,'RELOADING');assert.equal(f.calls.app,0);assert.equal(f.calls.reload,1);
  assert.deepEqual(f.calls.register,[{url:'https://static.example/music/coi-serviceworker.js',options:{scope:'https://static.example/music/',updateViaCache:'none'}}]);
  assert.equal(f.serviceWorker.controller,f.registration.active);
  assert.deepEqual([...f.storage],[['nbs-static-isolation-2:/music/','2']]);
  const again=await bootstrap(f.options);assert.equal(again.code,'ISOLATION_RELOAD_FAILED');assert.equal(f.calls.reload,1);assert.equal(f.calls.register.length,1);
  f.scope.crossOriginIsolated=true;
  const ready=await bootstrap(f.options);assert.equal(ready.ready,true);assert.equal(f.calls.app,1);assert.equal(f.storage.size,0);
});
test('an installing worker must activate before reload and a genuine activation timeout stays finite',async()=>{
  const delayed=fixture({claim:false,workerState:'installing'}),pending=prepareStaticIsolation(delayed.options);await turn();
  assert.equal(delayed.calls.reload,0);assert.equal(delayed.worker.stateListeners.size,1);delayed.activate();
  assert.equal((await pending).code,'RELOADING');assert.equal(delayed.calls.reload,1);assert.equal(delayed.serviceWorker.controller,undefined);assert.equal(delayed.worker.stateListeners.size,0);
  const timeout=fixture({claim:false,workerState:'installing'}),status=await bootstrap({...timeout.options,timeoutMs:3});
  assert.equal(status.code,'SERVICE_WORKER_TIMEOUT');assert.equal(timeout.calls.reload,0);assert.equal(timeout.calls.app,0);assert.equal(timeout.storage.size,0);assert.equal(timeout.worker.stateListeners.size,0);
});

test('hard refresh with an activated legacy worker and null controller performs one ordinary reload without claim support',async()=>{
  const f=fixture({existing:true,claim:false,claimOnMessage:false});
  assert.equal((await bootstrap(f.options)).code,'RELOADING');assert.equal(f.calls.reload,1);assert.equal(f.calls.app,0);assert.equal(f.calls.update,1);assert.equal(f.worker.messages.length,0);assert.equal(f.serviceWorker.controller,undefined);
});

test('concurrent preparations share one registration and one ordinary reload',async()=>{
  const f=fixture({existing:true,claim:false}),first=prepareStaticIsolation(f.options),second=prepareStaticIsolation(f.options);assert.equal(first,second);
  assert((await Promise.all([first,second])).every(status=>status.code==='RELOADING'));assert.equal(f.calls.register.length,1);assert.equal(f.calls.update,1);assert.equal(f.calls.reload,1);
});

test('an already isolated own registration checks updates before app load without reloading',async()=>{
  const f=fixture({isolated:true,existing:true});f.control(f.worker);let finishUpdate;
  f.registration.update=()=>{f.calls.update++;return new Promise(resolve=>{finishUpdate=resolve;});};
  const pending=bootstrap(f.options);await turn();assert.equal(f.calls.update,1);assert.equal(f.calls.app,0);assert.equal(f.calls.reload,0);finishUpdate();
  assert.equal((await pending).ready,true);assert.equal(f.calls.app,1);assert.equal(f.worker.messages.length,0);assert.equal(f.calls.register[0].options.updateViaCache,'none');
});

test('an isolated page waits for the new active object even when the old controller has the same script URL',async()=>{
  const f=fixture({isolated:true,existing:true,claim:false,claimOnMessage:false}),old=f.worker,next=new WorkerFixture();f.control(old);
  f.registration.update=async()=>{f.calls.update++;f.registration.installing=next;};
  const pending=bootstrap(f.options);await turn();assert.equal(f.calls.app,0);f.activate(next);await turn();
  assert.deepEqual(next.messages,[{type:'NBS_STATIC_CLAIM'}]);assert.equal(f.calls.app,0);f.control(old);await turn();assert.equal(f.calls.app,0);f.control(next);
  assert.equal((await pending).ready,true);assert.equal(f.calls.app,1);assert.equal(f.calls.reload,0);
});

test('ready pages preserve foreign controllers and registrations without updating or unregistering them',async()=>{
  for(const kind of ['controller','active','waiting','installing']){
    const f=fixture({isolated:true,existing:true}),other=new WorkerFixture({scriptURL:'https://static.example/other-worker.js'});
    if(kind==='controller')f.serviceWorker.controller=other;else f.registration[kind]=other;
    assert.equal((await bootstrap(f.options)).ready,true);assert.equal(f.calls.app,1);assert.equal(f.calls.register.length,0);assert.equal(f.calls.update,0);assert.equal(f.calls.unregister,0);assert.equal(f.calls.reload,0);
  }
});

test('a foreign worker appearing in registration or update is rejected without reload',async()=>{
  for(const phase of ['register','update']){
    const f=fixture({existing:phase==='update'}),other=new WorkerFixture({scriptURL:'https://static.example/foreign.js'});
    if(phase==='register')f.serviceWorker.register=async()=>({active:other});else f.registration.update=async()=>{f.calls.update++;f.registration.installing=other;};
    assert.equal((await bootstrap(f.options)).code,'SERVICE_WORKER_CONFLICT');assert.equal(f.calls.reload,0);assert.equal(f.calls.app,0);assert.equal(f.calls.unregister,0);
  }
});

test('a redundant installing worker fails without reload and removes its state listener',async()=>{
  const f=fixture({claim:false,workerState:'installing'}),pending=bootstrap(f.options);await turn();f.worker.transition('redundant');
  assert.equal((await pending).code,'SERVICE_WORKER_FAILED');assert.equal(f.calls.reload,0);assert.equal(f.worker.stateListeners.size,0);
});

test('index module entry is versioned from package.json rather than a random cache-bust token',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const modules=[...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/g)].map(match=>match[1]);
  assert(modules.includes(`static-bootstrap.js?v=${pkg.version}`));assert.equal(modules.filter(src=>src.startsWith('static-bootstrap.js')).length,1);
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

test('explicit claim messages accept only the protocol and same-origin clients inside this registration scope',async()=>{
  const f=workerFixture(()=>{throw new Error('claim messages must not fetch');}),promises=[];
  for(const event of [
    {data:{type:'OTHER'},source:{url:'https://static.example/music/index.html'}},
    {data:{type:'NBS_STATIC_CLAIM'},source:null},
    {data:{type:'NBS_STATIC_CLAIM'},source:{url:'https://remote.example/music/index.html'}},
    {data:{type:'NBS_STATIC_CLAIM'},source:{url:'https://static.example/musical/index.html'}},
    {data:{type:'NBS_STATIC_CLAIM'},source:{url:'https://static.example/other/index.html'}},
  ])f.handlers.get('message')({...event,waitUntil:promise=>promises.push(promise)});
  assert.equal(f.calls.claim,0);assert.equal(promises.length,0);
  f.handlers.get('message')({data:{type:'NBS_STATIC_CLAIM'},source:{url:'https://static.example/music/index.html?unchanged#unchanged'},waitUntil:promise=>promises.push(promise)});
  await Promise.all(promises);assert.equal(f.calls.claim,1);assert.equal(promises.length,1);
});

test('code, workers, WASM and model metadata revalidate default/force-cache reads without changing their body or MIME',async()=>{
  const calls=[],f=workerFixture(async(req,options)=>{calls.push({req,options});return new Response(Uint8Array.of(1,2,3),{headers:{'Content-Type':req.url.endsWith('.wasm')?'application/wasm':'text/javascript','X-Keep':'yes'}});});
  for(const relative of ['js/app.js','js/transcription-worker.js','vendor/runtime.mjs','styles.css','wasm/nbs_dsp.wasm','static-manifest.json','assets/transcription/small/model.json','assets/transcription/small/window-v2.f32']){
    for(const cache of ['default','force-cache']){
      const req=request(`https://static.example/music/${relative}`,{mode:'same-origin',cache}),response=await f.dispatch(req);
      assert.equal(calls.at(-1).req,req);assert.equal(calls.at(-1).options.cache,'no-cache',`${relative} ${cache}`);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),Uint8Array.of(1,2,3));
      assert.equal(response.headers.get('Content-Type'),relative.endsWith('.wasm')?'application/wasm':'text/javascript');assert.equal(response.headers.get('X-Keep'),'yes');
    }
  }
});

test('explicit caller cache policy is preserved for code and navigation always uses no-store',async()=>{
  const calls=[],f=workerFixture(async(req,options)=>{calls.push({req,options});return new Response('body');});
  for(const cache of ['no-store','no-cache','reload','only-if-cached']){
    const req=request('https://static.example/music/js/dsp-worker.js',{mode:'same-origin',cache});await f.dispatch(req);
    assert.equal(calls.at(-1).req,req);assert.equal(calls.at(-1).options,undefined);assert.equal(req.cache,cache);
  }
  for(const cache of ['default','force-cache','no-cache']){
    await f.dispatch(request('https://static.example/music/index.html',{mode:'navigate',cache}));assert.equal(calls.at(-1).options.cache,'no-store');
  }
});

test('audio retains its own cache behavior and cross-origin weights/range/API requests are not intercepted',async()=>{
  const calls=[],f=workerFixture(async(req,options)=>{calls.push({req,options});return new Response('audio',{headers:{'Content-Type':'audio/ogg'}});});
  for(const relative of ['assets/sounds/harp.ogg','songs/user.wav','songs/source.mp3']){
    const req=request(`https://static.example/music/${relative}`,{mode:'same-origin',cache:'force-cache'}),response=await f.dispatch(req);
    assert.equal(calls.at(-1).req,req);assert.equal(calls.at(-1).options,undefined);assert.equal(await response.text(),'audio');assert.equal(response.headers.get('Content-Type'),'audio/ogg');
  }
  const count=calls.length;
  for(const req of [request('https://www.modelscope.cn/models/MuScriptor/muscriptor-small/resolve/master/model.safetensors',{mode:'cors'}),request('https://remote.example/model.json',{mode:'cors'}),request('https://static.example/music/assets/sounds/harp.ogg',{headers:new Headers({Range:'bytes=0-7'})}),request('https://static.example/music/api/status')])assert.equal(f.dispatch(req),undefined);
  assert.equal(calls.length,count);
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
