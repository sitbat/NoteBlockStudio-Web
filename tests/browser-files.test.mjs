import test from 'node:test';
import assert from 'node:assert/strict';
import {songURL,fetchSongInBrowser} from '../js/browser-files.js';

test('URL validation handles native wrappers and rejects unsafe schemes and credentials before fetching',async()=>{
  assert.equal(songURL('nbs://https//example.com/my%20song.mid?x=%2F').href,'https://example.com/my%20song.mid?x=%2F');
  assert.equal(songURL('nbs://https://example.com/a.nbs').href,'https://example.com/a.nbs');
  let requests=0;
  for(const url of ['file:///tmp/song.nbs','data:application/json,{}','javascript:alert(1)','ftp://example.com/a.nbs','https://user:secret@example.com/a','/relative.nbs','https://a.test/\nthing'])await assert.rejects(fetchSongInBrowser(url,{fetchImpl:async()=>{requests++;}}),/HTTP/);
  assert.equal(requests,0);
});
test('explicit browser import uses CORS GET without credentials and returns actual downloaded bytes',async()=>{
  let request;
  const result=await fetchSongInBrowser('https://source.example/score%20one.mid',{fetchImpl:async(url,options)=>{request={url,options};return new Response(new Uint8Array([77,84,104,100]),{headers:{'Content-Type':'audio/midi','Content-Length':'4'}});}});
  assert.equal(request.url,'https://source.example/score%20one.mid');
  assert.equal(request.options.method,'GET');assert.equal(request.options.mode,'cors');assert.equal(request.options.credentials,'omit');assert.equal(request.options.referrerPolicy,'no-referrer');
  assert.ok(request.options.signal instanceof AbortSignal);assert.equal(result.filename,'score one.mid');assert.equal(result.mime,'audio/midi');assert.deepEqual([...result.bytes],[77,84,104,100]);
});
test('browser import uses safe exposed filenames and MIME fallback after a redirect',async()=>{
  const response=new Response('{}',{headers:{'Content-Type':'application/json','Content-Disposition':"attachment; filename*=UTF-8''..%2F%E4%B8%AD%E6%96%87.json"}});
  Object.defineProperty(response,'url',{value:'https://cdn.example/download'});
  const result=await fetchSongInBrowser('https://source.example/redirect',{fetchImpl:async()=>response});
  assert.equal(result.filename,'中文.json');assert.equal(result.url,'https://cdn.example/download');
  const unnamed=await fetchSongInBrowser('https://source.example/download',{fetchImpl:async()=>new Response('MThd',{headers:{'Content-Type':'audio/midi'}})});
  assert.equal(unnamed.filename,'download.mid');
});
test('CORS/network, HTTP and opaque failures never pretend import succeeded and provide a download fallback',async()=>{
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),/CORS.*先在浏览器下载/);
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{fetchImpl:async()=>new Response('forbidden',{status:403})}),/HTTP 403.*打开文件/);
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{fetchImpl:async()=>({ok:true,type:'opaque'})}),/CORS.*打开文件/);
});
test('declared and streamed size limits cancel the body before any file is returned',async()=>{
  let cancelled=0;
  const body=()=>new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5));controller.enqueue(new Uint8Array(5));},cancel(){cancelled++;}});
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{maxBytes:8,fetchImpl:async()=>new Response(body(),{headers:{'Content-Length':'10'}})}),/下载限制/);
  assert.equal(cancelled,1);
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{maxBytes:8,fetchImpl:async()=>new Response(body())}),/下载限制/);assert.equal(cancelled,2);
});
test('download timeout aborts the browser request and reports a local-file fallback',async()=>{
  let aborted=false;
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{timeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'));},{once:true}))}),/超时.*打开文件/);
  assert.equal(aborted,true);
});
test('a broken streaming body rejects with a file-import fallback rather than partial success',async()=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));controller.error(new Error('connection interrupted'));}});
  await assert.rejects(fetchSongInBrowser('https://source.example/a.nbs',{fetchImpl:async()=>new Response(stream)}),/connection interrupted.*打开文件/);
});
