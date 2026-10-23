import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceCapabilities,audioServiceDescription,songURL,fetchSongInBrowser,requestService,retryResourceEncoding} from '../js/service-capabilities.js';

test('legacy local capabilities retain desktop routes while hosted mode cannot impersonate them',()=>{
  const local=serviceCapabilities({version:1,token:'local',ffmpeg:{available:true},discord:{enabled:false},launch:{kind:'file',name:'a.nbs'}});
  assert.equal(local.mode,'local');assert.deepEqual(local.features,{transcode:true,presence:true,launchFile:true,fetchSong:true});
  const hosted=serviceCapabilities({version:1,mode:'hosted',token:'server',ffmpeg:{available:true},features:{transcode:true,presence:true,launchFile:true,fetchSong:true},launch:null});
  assert.deepEqual(hosted.features,{transcode:true,presence:false,launchFile:false,fetchSong:false});assert.equal(hosted.token,'server');
  assert.equal(serviceCapabilities({mode:'local',features:{transcode:false,presence:false,launchFile:false,fetchSong:false}}).features.fetchSong,false);
  for(const invalid of [null,undefined,'hosted',[],{mode:'other'}])assert.deepEqual(serviceCapabilities(invalid).features,{transcode:false,presence:false,launchFile:false,fetchSong:false});
});
test('encoding descriptions identify browser-only WAV and hosted WAV transfer accurately',()=>{
  const hosted=audioServiceDescription({mode:'hosted',features:{transcode:true}});
  assert.match(hosted,/浏览器/);assert.match(hosted,/点击导出后/);assert.match(hosted,/WAV 发送到网站服务器/);assert.doesNotMatch(hosted,/本地 FFmpeg/);
  assert.match(audioServiceDescription({version:1}),/您电脑上的本地 FFmpeg/);
  assert.match(audioServiceDescription(null),/无法确认/);
});
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

const hosted=token=>serviceCapabilities({mode:'hosted',token,features:{transcode:true}});
const denied=(code,status=403)=>Response.json({code,error:`Denied: ${code}`},{status});
test('an expired hosted session refreshes once and retries the same WAV with the new token and cookie credentials',async()=>{
  const old=hosted('old'),fresh=hosted('fresh'),wav=new Blob([new Uint8Array([82,73,70,70])],{type:'audio/wav'}),requests=[];
  let refreshed=0;
  const result=await requestService('/api/transcode?format=mp3',wav,{binary:true,getCapabilities:async()=>old,refreshCapabilities:async stale=>{assert.equal(stale,old);refreshed++;return fresh;},fetchImpl:async(path,options)=>{requests.push({path,options});return requests.length===1?denied('SESSION_REQUIRED'):new Response('encoded');}});
  assert.equal(await result.text(),'encoded');assert.equal(refreshed,1);assert.equal(requests.length,2);
  assert.deepEqual(requests.map(r=>r.options.headers['X-NBS-Token']),['old','fresh']);
  for(const request of requests){assert.equal(request.path,'/api/transcode?format=mp3');assert.equal(request.options.body,wav);assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.method,'POST');assert.equal(request.options.headers['Content-Type'],'audio/wav');}
});
test('a second session rejection is final and cannot create a capability-refresh loop',async()=>{
  let posts=0,refreshes=0;
  await assert.rejects(requestService('/api/transcode',{}, {getCapabilities:async()=>hosted('old'),refreshCapabilities:async()=>{refreshes++;return hosted('fresh');},fetchImpl:async()=>{posts++;return denied('SESSION_REQUIRED');}}),/Denied: SESSION_REQUIRED/);
  assert.equal(posts,2);assert.equal(refreshes,1);
});
test('Origin denials, rate limits, unknown errors and local token failures never refresh a session',async()=>{
  for(const [info,code,status] of [[hosted('a'),'ORIGIN_DENIED',403],[hosted('a'),'TOKEN_REQUIRED',403],[hosted('a'),'SESSION_REQUIRED',429],[hosted('a'),'OTHER_ERROR',403],[serviceCapabilities({token:'local'}),'SESSION_REQUIRED',403]]){
    let posts=0,refreshes=0;
    await assert.rejects(requestService('/api/transcode',{}, {getCapabilities:async()=>info,refreshCapabilities:async()=>{refreshes++;return hosted('fresh');},fetchImpl:async()=>{posts++;return denied(code,status);}}),new RegExp(code));
    assert.equal(posts,1,`${info.mode} ${status} ${code}`);assert.equal(refreshes,0);
  }
});
test('failed refreshes or capabilities revoked on refresh do not resend an export',async()=>{
  for(const failRefresh of [true,false]){
    let posts=0,refreshes=0;
    await assert.rejects(requestService('/api/transcode',{}, {getCapabilities:async()=>hosted('old'),refreshCapabilities:async()=>{refreshes++;if(failRefresh)throw new Error('refresh offline');return serviceCapabilities({mode:'hosted',features:{transcode:false}});},fetchImpl:async()=>{posts++;return denied('SESSION_REQUIRED');}}),failRefresh?/refresh offline/:/不提供/);
    assert.equal(posts,1);assert.equal(refreshes,1);
  }
});
test('local service requests preserve JSON and reject unavailable or unknown actions before POST',async()=>{
  const local=serviceCapabilities({token:'desktop'}),body={url:'https://example.com/song.nbs'};let posts=0;
  await requestService('/api/fetch-song',body,{getCapabilities:async()=>local,fetchImpl:async(_path,options)=>{posts++;assert.equal(options.body,JSON.stringify(body));assert.equal(options.headers['Content-Type'],'application/json');return new Response('song');}});
  await assert.rejects(requestService('/api/presence',{}, {getCapabilities:async()=>hosted('a'),fetchImpl:async()=>{posts++;}}),/不提供/);
  await assert.rejects(requestService('https://other.example/api/transcode',{}, {getCapabilities:async()=>{throw new Error('should not read token');}}),/未知/);
  assert.equal(posts,1);
});

test('ordinary exports expose Retry-After metadata but never automatically retry a 429',async()=>{
  let requests=0;
  await assert.rejects(requestService('/api/transcode',{}, {getCapabilities:async()=>hosted('a'),fetchImpl:async()=>{requests++;return Response.json({code:'RATE_LIMIT',error:'limited'},{status:429,headers:{'Retry-After':'60'}});}}),error=>error.status===429&&error.code==='RATE_LIMIT'&&error.retryAfterMs===60000);
  assert.equal(requests,1);
});
test('resource batches wait the full Retry-After with countdown and retry only the failed request',async()=>{
  let requests=0;const sleeps=[],countdown=[],body=new Blob(['WAV']);
  const result=await retryResourceEncoding(()=>requestService('/api/transcode',body,{binary:true,getCapabilities:async()=>hosted('a'),fetchImpl:async(_path,options)=>{assert.equal(options.body,body);requests++;return requests===1?Response.json({code:'RATE_LIMIT'},{status:429,headers:{'Retry-After':'3'}}):new Response('OGG');}}),{sleep:async ms=>sleeps.push(ms),onWait:info=>countdown.push(info)});
  assert.equal(await result.text(),'OGG');assert.equal(requests,2);assert.deepEqual(sleeps,[1000,1000,1000]);assert.deepEqual(countdown.map(x=>x.remainingSeconds),[3,2,1]);assert.ok(countdown.every(x=>x.retry===1&&x.status===429));
});
test('a 240-instrument batch can span the default 30/minute budget without repeating successful variants',async()=>{
  let successful=0,calls=0,budget=30,elapsed=0;
  for(let variant=0;variant<240*3;variant++){
    const result=await retryResourceEncoding(async()=>{calls++;if(!budget){const error=new Error('rate limited');Object.assign(error,{status:429,retryAfterMs:60000});throw error;}budget--;return variant;},{sleep:async ms=>{elapsed+=ms;if(elapsed%60000===0)budget=30;}});
    assert.equal(result,variant);successful++;
  }
  assert.equal(successful,720);assert.equal(calls,743);assert.equal(elapsed,23*60000);
});
test('busy retry and repeated rate limits have fixed attempt and total-wait bounds',async()=>{
  let attempts=0,waited=0;
  await assert.rejects(retryResourceEncoding(async()=>{attempts++;throw Object.assign(new Error('busy'),{status:409,code:'TRANSCODE_BUSY'});},{sleep:async ms=>{waited+=ms;},maxRetries:2}),/其他访客.*上限/);
  assert.equal(attempts,3);assert.equal(waited,6000);
  attempts=0;waited=0;
  await assert.rejects(retryResourceEncoding(async()=>{attempts++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:60000});},{sleep:async ms=>{waited+=ms;},maxWaitMs:65000}),/请求较多.*上限/);
  assert.equal(attempts,2);assert.equal(waited,60000);
});
test('non-capacity failures are final and oversized Retry-After values are never slept or retried',async()=>{
  let sleeps=0,calls=0;
  for(const error of [Object.assign(new Error('forbidden'),{status:403}),Object.assign(new Error('conflict'),{status:409,code:'OTHER'}),Object.assign(new Error('bad WAV'),{status:415})])await assert.rejects(retryResourceEncoding(async()=>{calls++;throw error;},{sleep:async()=>sleeps++}),actual=>actual===error);
  await assert.rejects(retryResourceEncoding(async()=>{calls++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:3600000});},{sleep:async()=>sleeps++}),/上限/);
  assert.equal(calls,4);assert.equal(sleeps,0);
});
