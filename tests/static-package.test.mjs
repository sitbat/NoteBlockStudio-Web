import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {buildStatic} from '../scripts/build-static.mjs';
import {createStaticPreview} from '../scripts/preview-static.mjs';

const wasm=new Uint8Array([0,97,115,109,1,0,0,0]);
const publicEntries={
  'index.html':'<!doctype html><title>Static fixture</title>',
  'styles.css':'body{}','static-bootstrap.js':'export {};','coi-serviceworker.js':'self.addEventListener("fetch",()=>{});',
  'LICENSE':'MIT fixture','THIRD_PARTY_NOTICES.md':'Notices fixture',
  'js/app.js':'export {};','js/browser-codecs.js':'export {};','js/browser-files.js':'export {};','js/dsp-worker.js':'export {};','js/file-worker.js':'export {};','js/output-worklet.js':'export {};',
  'css/native-menus.css':'nav{}','wasm/nbs_dsp.wasm':wasm,'assets/sounds/harp.ogg':'OggS tiny fixture',
  'vendor/ffmpeg/esm/index.js':'export {};','vendor/ffmpeg/core/ffmpeg-core.js':'export {};','vendor/ffmpeg/core/ffmpeg-core.wasm':wasm,
  'licenses/fixture.txt':'Permitted runtime license',
};
const privateEntries={
  'package.json':JSON.stringify({name:'static-fixture',version:'3.2.1'}),'.env':'DO_NOT_PUBLISH_ENV',
  '.git/config':'DO_NOT_PUBLISH_GIT','runtime/node.exe':'DO_NOT_PUBLISH_RUNTIME','tests/private.test.mjs':'DO_NOT_PUBLISH_TESTS',
  'docs/private.md':'DO_NOT_PUBLISH_DOCS','scripts/backend.mjs':'DO_NOT_PUBLISH_SCRIPTS','server.mjs':'DO_NOT_PUBLISH_BACKEND',
  'hosted-services.mjs':'DO_NOT_PUBLISH_HOSTED','native-services.mjs':'DO_NOT_PUBLISH_NATIVE',
};
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'nbs-static-package-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,contents]of Object.entries({...publicEntries,...privateEntries})){const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,contents);}
  return root;
}
async function filesUnder(root,prefix=''){
  const names=[];for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){const name=path.posix.join(prefix,entry.name);if(entry.isDirectory())names.push(...await filesUnder(root,name));else names.push(name);}return names.sort();
}
async function preservedDist(root){const output=path.join(root,'dist');await mkdir(output,{recursive:true});await writeFile(path.join(output,'previous.txt'),'old deploy remains intact');return output;}
async function createLink(t,target,link){
  try{await symlink(target,link,process.platform==='win32'?'junction':'dir');return true;}
  catch(error){if(['EPERM','EACCES','ENOTSUP','UNKNOWN'].includes(error.code)){t.skip(`OS does not permit creating a directory link (${error.code})`);return false;}throw error;}
}
async function preview(t,root){
  const server=await createStaticPreview(root);t.after(async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  return (target,method='GET',extraHeaders={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:target,method,headers:{Host:`127.0.0.1:${port}`,...extraHeaders}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end();
  });
}

test('static build contains only the closed runtime payload and a byte-exact SHA256 manifest',async t=>{
  const root=await fixture(t),result=await buildStatic(root),manifest=JSON.parse(await readFile(path.join(result.directory,'static-manifest.json'),'utf8'));
  assert.equal(result.directory,path.join(root,'dist'));assert.equal(result.version,'3.2.1');assert.equal(result.files,Object.keys(publicEntries).length);
  assert.equal(manifest.kind,'noteblockstudio-static');assert.equal(manifest.version,'3.2.1');
  assert.deepEqual(manifest.files.map(file=>file.path),Object.keys(publicEntries).sort());
  assert.deepEqual(await filesUnder(result.directory),[...Object.keys(publicEntries),'static-manifest.json'].sort());
  let total=0;
  for(const file of manifest.files){const bytes=await readFile(path.join(result.directory,file.path));assert.equal(file.bytes,bytes.length);assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));total+=bytes.length;}
  assert.equal(result.bytes,total);
  assert.ok(manifest.files.every(file=>!/^\.|^(?:runtime|tests|docs|scripts)\/|(?:^|\/)(?:server|hosted-services|native-services)\.mjs$/.test(file.path)));
});
test('missing required runtime resources reject before replacing the old dist',async t=>{
  for(const missing of ['js/browser-codecs.js','assets/sounds/harp.ogg','vendor/ffmpeg/core/ffmpeg-core.wasm']){
    const root=await fixture(t),output=await preservedDist(root);await rm(path.join(root,missing));
    await assert.rejects(buildStatic(root),/Missing static runtime file/);assert.deepEqual(await filesUnder(output),['previous.txt']);assert.equal(await readFile(path.join(output,'previous.txt'),'utf8'),'old deploy remains intact');
  }
});
test('invalid DSP or codec WASM rejects before replacing the old dist',async t=>{
  for(const invalid of ['wasm/nbs_dsp.wasm','vendor/ffmpeg/core/ffmpeg-core.wasm']){
    const root=await fixture(t),output=await preservedDist(root);await writeFile(path.join(root,invalid),'<html>404 fallback</html>');
    await assert.rejects(buildStatic(root),/Invalid WebAssembly payload/);assert.deepEqual(await filesUnder(output),['previous.txt']);
  }
});
test('source directory links cannot add private files and preserve the prior build',async t=>{
  const root=await fixture(t),output=await preservedDist(root),target=path.join(root,'private-source');await mkdir(target);await writeFile(path.join(target,'secret.txt'),'PRIVATE');
  if(!await createLink(t,target,path.join(root,'assets','linked-private')))return;
  await assert.rejects(buildStatic(root),/Symbolic links are not permitted/);assert.equal(await readFile(path.join(output,'previous.txt'),'utf8'),'old deploy remains intact');assert.equal(await readFile(path.join(target,'secret.txt'),'utf8'),'PRIVATE');
});
test('a linked dist is refused without removing the link target',async t=>{
  const root=await fixture(t),target=path.join(root,'external-deploy');await mkdir(target);await writeFile(path.join(target,'keep.txt'),'PRESERVE');
  if(!await createLink(t,target,path.join(root,'dist')))return;
  await assert.rejects(buildStatic(root),/linked dist/);assert.equal(await readFile(path.join(target,'keep.txt'),'utf8'),'PRESERVE');
});
test('static preview has correct worker/WASM MIME, no isolation headers and no API or private-file surface',async t=>{
  const root=await fixture(t),{directory}=await buildStatic(root);await writeFile(path.join(directory,'.env'),'PRIVATE_IN_DIST');await writeFile(path.join(directory,'server.mjs'),'PRIVATE_IN_DIST');const request=await preview(t,directory);
  for(const [url,mime]of [['/','text/html'],['/static-bootstrap.js','text/javascript'],['/coi-serviceworker.js','text/javascript'],['/wasm/nbs_dsp.wasm','application/wasm'],['/vendor/ffmpeg/core/ffmpeg-core.wasm','application/wasm']]){
    const result=await request(url);assert.equal(result.status,200,url);assert.match(result.headers['content-type'],new RegExp('^'+mime));assert.equal(result.headers['cross-origin-opener-policy'],undefined);assert.equal(result.headers['cross-origin-embedder-policy'],undefined);assert.equal(result.headers['cache-control'],'no-store');
  }
  const head=await request('/wasm/nbs_dsp.wasm','HEAD');assert.equal(head.status,200);assert.equal(head.headers['content-length'],'8');assert.equal(head.body.length,0);
  for(const url of ['/api/capabilities','/api/transcode','/.env','/.git/config','/server.mjs','/runtime/node.exe','/tests/private.test.mjs','/docs/private.md','/hosted-services.mjs']){const result=await request(url);assert.equal(result.status,404,url);assert.doesNotMatch(result.body.toString(),/PRIVATE|DO_NOT_PUBLISH/);}
  for(const method of ['POST','PUT','DELETE','OPTIONS']){const result=await request('/index.html',method);assert.equal(result.status,405);assert.equal(result.headers.allow,'GET, HEAD');}
  assert.equal((await request('/index.html','GET',{Host:'example.com'})).status,403);
});
test('preview rejects raw and encoded traversal plus malformed encodings before selecting public files',async t=>{
  const root=await fixture(t),{directory}=await buildStatic(root),request=await preview(t,directory);
  for(const url of ['/../index.html','/js/../index.html','/%2e%2e/index.html','/js/%2E%2E/index.html','/%5c..%5cindex.html']){const result=await request(url);assert.ok([400,403,404].includes(result.status),`${url}: ${result.status}`);}
  assert.equal((await request('/%zz')).status,400);
});
