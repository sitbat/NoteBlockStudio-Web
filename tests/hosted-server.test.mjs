import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {normalizePublicOrigin,parseHostedOptions,hostedClientAddress,createHostedServer} from '../hosted-server.mjs';

const publicOrigin='https://music.example.test',publicHost='music.example.test';
let base,root,server,port,symlinksAvailable=true;
const hookCalls=[];
const files=new Map([
  ['index.html','<!doctype html><title>Browser editor</title>'],
  ['styles.css','body{color:#123}'],['favicon.ico',Buffer.from([0,0,1,0])],
  ['js/app.js','export const browserApp=true;'],['js/nested/worker.mjs','export const worker=true;'],
  ['css/native-menus.css','.menu{display:block}'],['wasm/dsp.wasm',Buffer.from([0,97,115,109,1,0,0,0])],
  ['assets/note.png',Buffer.from([137,80,78,71])],['assets/harp.ogg',Buffer.from('OggS')],
  ['assets/demo song.nbs',Buffer.from([0,0,5,16])],['assets/drum.nbp',Buffer.from([1,0,1,0])],
  ['assets/resource.zip',Buffer.from('PK')],['assets/instruments.json','{"public":true}'],
  ['server.mjs','TOP_SECRET_SERVER_SOURCE'],['package.json','{"private":"TOP_SECRET_PACKAGE"}'],
  ['docs/private.md','TOP_SECRET_DOC'],['benchmarks/local.json','{"path":"TOP_SECRET_BENCHMARK"}'],
  ['runtime/private.png','TOP_SECRET_RUNTIME'],['runtime/private.mjs','TOP_SECRET_RUNTIME_MODULE'],
  ['rust/src/lib.rs','TOP_SECRET_RUST'],['.git/config','TOP_SECRET_GIT'],['.env','TOP_SECRET_ENV'],
  ['assets/not-a-public-page.html','TOP_SECRET_ASSET_HTML'],['assets/not-a-public-script.js','TOP_SECRET_ASSET_SCRIPT'],
  ['js/private.json','TOP_SECRET_JS_JSON'],['assets/.private.json','TOP_SECRET_HIDDEN_ASSET'],
]);

before(async()=>{
  base=await mkdtemp(path.join(os.tmpdir(),'nbs-hosted-review-'));root=path.join(base,'public');
  await mkdir(root);for(const [name,data]of files){const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data);}
  await mkdir(path.join(base,'outside'));await writeFile(path.join(base,'outside','private.js'),'TOP_SECRET_OUTSIDE');
  try{
    await symlink(path.join(root,'runtime','private.png'),path.join(root,'assets','runtime-link.png'),'file');
    await symlink(path.join(root,'js','private.json'),path.join(root,'assets','js-link.json'),'file');
    await symlink(path.join(root,'runtime','private.mjs'),path.join(root,'js','runtime-link.mjs'),'file');
    await symlink(path.join(base,'outside','private.js'),path.join(root,'js','outside-link.js'),'file');
    await symlink(path.join(root,'runtime'),path.join(root,'assets','linked-directory'),process.platform==='win32'?'junction':'dir');
  }catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code))symlinksAvailable=false;else throw error;}
  server=createHostedServer(root,{publicOrigin,services:{async handle(request,response){
    hookCalls.push({method:request.method,url:request.url,host:request.headers.host,origin:request.headers.origin});
    if(request.url==='/api/throw')throw new Error(`TOP_SECRET service failure ${base}`);
    if(request.url!=='/api/probe')return false;
    response.writeHead(202,{'Content-Type':'application/json'});response.end(JSON.stringify({method:request.method,origin:request.headers.origin}));return true;
  }}});
  server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;
});
after(async()=>{
  if(server?.listening){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
  if(base){const resolved=path.resolve(base),temporary=path.resolve(os.tmpdir());if(path.dirname(resolved)!==temporary||!path.basename(resolved).startsWith('nbs-hosted-review-'))throw new Error('Refusing unexpected fixture cleanup target.');await rm(resolved,{recursive:true,force:true});}
});
function request(target,{method='GET',headers={},body,setHost=true}={}){
  return new Promise((resolve,reject)=>{
    const client=http.request({hostname:'127.0.0.1',port,path:target,method,headers:{...(setHost?{Host:publicHost}:{}),...headers},setHost,agent:false},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.once('error',reject);response.once('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });client.once('error',reject);client.setTimeout(5000,()=>client.destroy(new Error('Fixture request timed out.')));client.end(body);
  });
}
function isolation(response){assert.equal(response.headers['cross-origin-opener-policy'],'same-origin');assert.equal(response.headers['cross-origin-embedder-policy'],'require-corp');assert.equal(response.headers['cross-origin-resource-policy'],'same-origin');assert.equal(response.headers['x-content-type-options'],'nosniff');assert.match(response.headers['cache-control']||'',/\bno-cache\b/);}
function denied(response){assert.ok([403,404].includes(response.status),`Expected denied path, received ${response.status}: ${response.body}`);assert.ok(!response.body.toString().includes('TOP_SECRET'));assert.ok(!response.body.toString().includes(base));isolation(response);}

test('PUBLIC_ORIGIN canonicalizes HTTPS and explicit loopback development origins',()=>{
  for(const [value,expected]of [['https://MUSIC.example.test:443/','https://music.example.test'],['https://music.example.test:8443','https://music.example.test:8443'],['http://localhost:8765/','http://localhost:8765'],['http://127.0.0.1:8765','http://127.0.0.1:8765'],['http://[::1]:8765','http://[::1]:8765']])assert.equal(normalizePublicOrigin(value),expected);
});
test('PUBLIC_ORIGIN rejects remote HTTP, credentials, non-root paths and URL adornments',()=>{
  for(const value of ['',undefined,'music.example.test','ftp://music.example.test','http://music.example.test','http://localhost.evil.test','https://user:password@music.example.test','https://music.example.test/editor','https://music.example.test/?token=secret','https://music.example.test/#fragment'])assert.throws(()=>normalizePublicOrigin(value),undefined,`must reject ${value}`);
});
test('PUBLIC_ORIGIN does not erase a configured subpath by normalizing dot segments',()=>{
  for(const value of ['https://music.example.test/editor/..','https://music.example.test/./','https://music.example.test/%2e'])assert.throws(()=>normalizePublicOrigin(value),undefined,`must reject non-root input path ${value}`);
});
test('hosted CLI defaults stay loopback and flags override only their corresponding environment options',()=>{
  const defaults=parseHostedOptions([],{PUBLIC_ORIGIN:publicOrigin});assert.deepEqual(defaults,{publicOrigin,host:'127.0.0.1',port:8765,trustProxyHeaders:false,help:false});
  const configured=parseHostedOptions(['--host','127.0.0.1','--port','9876','--public-origin','https://Other.example.test/','--trust-proxy-headers'],{HOST:'0.0.0.0',PORT:'9999',PUBLIC_ORIGIN:publicOrigin});assert.deepEqual(configured,{publicOrigin:'https://other.example.test',host:'127.0.0.1',port:9876,trustProxyHeaders:true,help:false});
  assert.equal(parseHostedOptions([],{PUBLIC_ORIGIN:publicOrigin,TRUST_PROXY_HEADERS:'1'}).trustProxyHeaders,true);assert.equal(parseHostedOptions([],{PUBLIC_ORIGIN:publicOrigin,TRUST_PROXY_HEADERS:'true'}).trustProxyHeaders,false);assert.equal(parseHostedOptions(['--help'],{}).help,true);
});
test('hosted CLI rejects missing, unknown or invalid configuration instead of exposing a fallback listener',()=>{
  for(const args of [['--port','0'],['--port','65536'],['--port','12.5'],['--port','NaN'],['--host'],['--port'],['--public-origin'],['--unexpected']])assert.throws(()=>parseHostedOptions(args,{PUBLIC_ORIGIN:publicOrigin}));
  assert.throws(()=>parseHostedOptions([],{}));assert.throws(()=>parseHostedOptions([],{PUBLIC_ORIGIN:'http://public.example.test'}));
});
test('client identity ignores forwarded input unless the dedicated trusted-proxy flag is enabled',()=>{
  const req={socket:{remoteAddress:'::ffff:127.0.0.1'},headers:{'x-nbs-client-ip':'203.0.113.7','x-forwarded-for':'198.51.100.10'}};
  assert.equal(hostedClientAddress(req),'::ffff:127.0.0.1');assert.equal(hostedClientAddress(req,{trustProxyHeaders:true}),'203.0.113.7');
  for(const value of ['203.0.113.7, 198.51.100.10','client.example.test','[::1]','999.1.1.1',['203.0.113.7']])assert.equal(hostedClientAddress({...req,headers:{...req.headers,'x-nbs-client-ip':value}},{trustProxyHeaders:true}),'::ffff:127.0.0.1');
  assert.equal(hostedClientAddress({...req,headers:{'x-forwarded-for':'198.51.100.10'}},{trustProxyHeaders:true}),'::ffff:127.0.0.1');assert.equal(hostedClientAddress({...req,headers:{'x-nbs-client-ip':'2001:db8::7'}},{trustProxyHeaders:true}),'2001:db8::7');
});
test('HTTPS public Host reaches an HTTP backend with browser payload MIME and isolation headers',async()=>{
  for(const [target,mime]of [['/','text/html'],['/index.html','text/html'],['/styles.css','text/css'],['/js/app.js','javascript'],['/js/nested/worker.mjs','javascript'],['/css/native-menus.css','text/css'],['/wasm/dsp.wasm','application/wasm'],['/assets/harp.ogg','audio/ogg'],['/assets/demo%20song.nbs','application/octet-stream'],['/assets/drum.nbp','application/octet-stream'],['/assets/resource.zip','application/zip'],['/assets/instruments.json','application/json'],['/favicon.ico','image/']]){const response=await request(target);assert.equal(response.status,200,target);assert.ok(response.headers['content-type'].includes(mime),`${target}: ${response.headers['content-type']}`);isolation(response);}
});
test('HEAD reports the same payload size without streaming a body; ordinary query parameters do not change the file',async()=>{
  for(const target of ['/index.html','/js/app.js','/wasm/dsp.wasm','/assets/demo%20song.nbs']){const get=await request(target),head=await request(target,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),get.body.length);isolation(head);}
  assert.deepEqual((await request('/js/app.js?version=3')).body,(await request('/js/app.js')).body);
});
test('Host validation accepts case variants but rejects aliases, wrong ports, missing Host and forged forwarding headers',async()=>{
  assert.equal((await request('/',{headers:{Host:'MUSIC.EXAMPLE.TEST'}})).status,200);
  const before=hookCalls.length;
  for(const host of ['attacker.example','music.example.test.evil','music.example.test:8443','localhost','music.example.test.']){const response=await request('/api/probe',{method:'POST',headers:{Host:host,Origin:publicOrigin,'X-Forwarded-Host':publicHost,'X-Forwarded-Proto':'https',Forwarded:`host=${publicHost};proto=https`}});assert.equal(response.status,403);isolation(response);}
  assert.equal(hookCalls.length,before,'denied Host must never reach the service hook');const noHost=await request('/',{setHost:false});assert.ok([400,403].includes(noHost.status));
});
test('checkout files and executable/source-like files remain private even when present under the public root',async()=>{
  for(const target of ['/server.mjs','/package.json','/docs/private.md','/benchmarks/local.json','/runtime/private.png','/rust/src/lib.rs','/.git/config','/.env','/assets/not-a-public-page.html','/assets/not-a-public-script.js','/js/private.json','/assets/.private.json'])denied(await request(target));
});
test('encoded traversal, hidden segments, backslashes and malformed URL encoding cannot expose private files',async()=>{
  for(const target of ['/assets/%2e%2e/runtime/private.png','/assets/..%2fruntime/private.png','/assets/%2e%2e%2fruntime/private.png','/assets/%5c..%5cruntime%5cprivate.png','/assets/%252e%252e/runtime/private.png','/%2egit/config','/assets/%00.png'])denied(await request(target));
  const malformed=await request('/assets/%E0%A4%A');assert.equal(malformed.status,400);isolation(malformed);
});
test('public-directory symlinks cannot expose another category of the checkout or a file outside it',async t=>{
  if(!symlinksAvailable){t.skip('Creating filesystem symlinks is not permitted on this host.');return;}
  for(const target of ['/assets/runtime-link.png','/assets/js-link.json','/js/runtime-link.mjs','/js/outside-link.js','/assets/linked-directory/private.png'])denied(await request(target));
});
test('a public directory itself cannot be redirected to a private directory',async t=>{
  const alternate=path.join(base,'alternate');await mkdir(alternate);await writeFile(path.join(alternate,'index.html'),'public');
  try{await symlink(path.join(root,'runtime'),path.join(alternate,'assets'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Creating filesystem symlinks is not permitted on this host.');return;}throw error;}
  const other=createHostedServer(alternate,{publicOrigin});other.listen(0,'127.0.0.1');await once(other,'listening');const otherPort=other.address().port;
  try{const response=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:otherPort,path:'/assets/private.png',headers:{Host:publicHost},agent:false},r=>{const parts=[];r.on('data',c=>parts.push(c));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(parts)}));}).once('error',reject);});denied(response);}finally{other.closeAllConnections?.();await new Promise(resolve=>other.close(resolve));}
});
test('static methods are restricted before any file is streamed and failures retain headers',async()=>{
  for(const method of ['POST','PUT','DELETE','OPTIONS','TRACE']){const response=await request('/js/app.js',{method});assert.equal(response.status,405);assert.match(response.headers.allow||'',/GET.*HEAD/);isolation(response);assert.ok(!response.body.toString().includes('browserApp'));}
  const missing=await request('/assets/missing.png',{method:'HEAD'});assert.equal(missing.status,404);assert.equal(missing.body.length,0);isolation(missing);
});
test('service hook receives only API routes after public Host validation, with HTTPS Origin preserved',async()=>{
  const before=hookCalls.length;const response=await request('/api/probe',{method:'POST',headers:{Origin:publicOrigin,'X-Forwarded-Proto':'http'}});assert.equal(response.status,202);assert.deepEqual(JSON.parse(response.body),{method:'POST',origin:publicOrigin});isolation(response);assert.equal(hookCalls.length,before+1);
  await request('/js/app.js');assert.equal(hookCalls.length,before+1,'static files must not reach service hook');denied(await request('/api/unknown'));
});
test('service failures do not leak internal errors or poison later static requests',async()=>{
  const response=await request('/api/throw');assert.equal(response.status,500);assert.ok(!response.body.toString().includes('TOP_SECRET'));assert.ok(!response.body.toString().includes(base));isolation(response);assert.equal((await request('/')).status,200);
});
test('absolute-form and authority-form request targets are not accepted as alternate route authorities',async()=>{
  for(const target of ['https://attacker.example/index.html','//attacker.example/index.html']){const response=await request(target);assert.ok([400,403].includes(response.status));isolation(response);}
});
