import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHostedServices,hostedLimits,ClientRateLimiter} from '../hosted-services.mjs';
import {encodeWav} from '../js/audio.js';

const publicOrigin='https://music.example',root=fileURLToPath(new URL('..',import.meta.url));
function wav(samples=64){const bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(i*.1)*1000),44+i*2);return bytes;}
function fakeCodec({mode='success',wait,bytes=Buffer.from('encoded audio')}={}){
  const calls=[];let kills=0;
  return {calls,get kills(){return kills;},spawn(command,args,options){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let closed=false;const finish=code=>{if(closed)return;closed=true;child.emit('close',code);};child.kill=()=>{kills++;queueMicrotask(()=>finish(null));return true;};calls.push({command,args,options});
    setImmediate(async()=>{
      if(args[0]==='-version'){child.stdout.end('ffmpeg version 9.0.2-hosted Copyright fake /private/server/path\n');finish(0);return;}
      if(mode==='hang')return;if(wait)await wait;if(closed)return;
      if(mode==='fail'){child.stderr.write('ERROR reading /private/server/song.wav with secret path');finish(1);return;}
      try{await writeFile(args.at(-1),bytes);finish(0);}catch(error){child.emit('error',error);finish(1);}
    });return child;
  }};
}
async function fixture(t,options={}){
  const fake=options.fake===null?null:options.fake||fakeCodec(),services=await createHostedServices({publicOrigin,projectRoot:root,env:{},...(fake?{ffmpegPath:'fake-codec',spawnImpl:fake.spawn}:{}),...options});
  const server=http.createServer(async(req,res)=>{if(!await services.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections?.();await services.close();await new Promise(resolve=>server.close(resolve));});
  const response=await fetch(url+'/api/capabilities'),cap=await response.json(),cookie=response.headers.get('set-cookie')?.split(';')[0];
  const headers={Origin:publicOrigin,'X-NBS-Token':cap.token,Cookie:cookie,'Content-Type':'audio/wav'};
  return {services,server,url,cap,cookie,headers,fake,post:(body=wav(),extra={},query='format=mp3')=>fetch(url+'/api/transcode?'+query,{method:'POST',headers:{...headers,...extra},body})};
}
const result=async response=>({status:response.status,...await response.json()});
function rawRequest(url,{headers={},body,end=true}={}){let req;const done=new Promise((resolve,reject)=>{req=http.request(url,{method:'POST',headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,...JSON.parse(Buffer.concat(chunks))});}catch(error){reject(error);}});});req.on('error',reject);if(body)req.write(body);if(end)req.end();});return {req,done};}

test('hosted origin and environment configuration reject ambiguous or excessive values',async()=>{
  assert.equal(hostedLimits({}).maxInputBytes,128*1024*1024);assert.equal(hostedLimits({HOSTED_MAX_INPUT_MIB:'512'}).maxInputBytes,512*1024*1024);
  for(const env of [{HOSTED_MAX_INPUT_MIB:'513'},{HOSTED_PROCESS_TIMEOUT_MS:'120001'},{HOSTED_RATE_CLIENTS:'0'},{HOSTED_BODY_TIMEOUT_MS:'not-a-number'}])assert.throws(()=>hostedLimits(env));
  for(const value of [undefined,'file:///tmp','https://music.example/','https://user:pass@music.example','https://music.example/path','https://music.example?x=1'])await assert.rejects(createHostedServices({publicOrigin:value,env:{HOSTED_ENABLE_TRANSCODE:'0'}}),/PUBLIC_ORIGIN/);
});

test('capabilities issue signed client-scoped cookies/tokens without machine paths or local features',async t=>{
  const f=await fixture(t);assert.equal(f.cap.mode,'hosted');assert.deepEqual(f.cap.features,{transcode:true,presence:false,launchFile:false,fetchSong:false});assert.equal(f.cap.launch,null);assert.deepEqual(f.cap.ffmpeg,{available:true,version:'ffmpeg version 9.0.2-hosted'});assert.ok(!JSON.stringify(f.cap).includes('/private'));
  const fresh=await fetch(f.url+'/api/capabilities'),data=await fresh.json();assert.notEqual(data.token,f.cap.token);assert.match(fresh.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Max-Age=900; Secure/);assert.match(fresh.headers.get('set-cookie'),/^__Host-/);
  const reused=await fetch(f.url+'/api/capabilities',{headers:{Cookie:f.cookie}});assert.equal((await reused.json()).token,f.cap.token);assert.equal(reused.headers.get('set-cookie'),null);
});

test('POST requires exact configured Origin plus the matching signed session and CSRF token',async t=>{
  const f=await fixture(t),other=await fetch(f.url+'/api/capabilities'),otherCookie=other.headers.get('set-cookie').split(';')[0];
  for(const change of [{Origin:''},{Origin:'https://evil.invalid'},{Origin:'https://music.example:443'},{'X-NBS-Token':''},{Cookie:''},{Cookie:otherCookie},{Cookie:f.cookie.slice(0,-1)+'!'}])assert.equal((await f.post(wav(),change)).status,403);
  assert.equal((await f.post()).status,200);assert.equal(f.fake.calls.filter(call=>call.args[0]!=='-version').length,1);
});

test('session expiry and process restart invalidate tokens without a growing session map',async t=>{
  let clock=Date.now();const f=await fixture(t,{now:()=>clock,limits:{sessionTtlSeconds:2}});clock+=3000;const expired=await result(await f.post());assert.equal(expired.status,403);assert.equal(expired.code,'SESSION_REQUIRED');
  const replacement=await fixture(t);assert.equal((await replacement.post(wav(),{Cookie:f.cookie,'X-NBS-Token':f.cap.token})).status,403);
});

test('local integration/URL routes are unavailable and cross-site requests are rejected',async t=>{
  const f=await fixture(t);
  for(const endpoint of ['/api/presence','/api/fetch-song','/api/launch-file']){
    assert.equal((await fetch(f.url+endpoint)).status,404);assert.equal((await fetch(f.url+endpoint,{method:'POST',headers:f.headers,body:'{}'})).status,404);
  }
  assert.equal((await fetch(f.url+'/api/capabilities',{headers:{Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await fetch(f.url+'/api/capabilities',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal(f.fake.calls.length,1);
});

test('codec input/options are bounded and child arguments cannot enable a shell or network protocol',async t=>{
  const f=await fixture(t);
  for(const query of ['format=exe','rate=123','channels=9','format=mp3&format=wav','format=mp3&path=/private'])assert.equal((await f.post(wav(),{},query)).status,400);
  assert.equal((await f.post(wav(),{'Content-Type':'application/json'})).status,415);
  assert.equal((await f.post(Buffer.from('not a wav'))).status,415);
  const bad=wav();bad.writeUInt16LE(65535,22);assert.equal((await f.post(bad)).status,415);
  const response=await f.post();assert.equal(response.status,200);assert.equal(await response.text(),'encoded audio');assert.equal(response.headers.get('x-nbs-filename'),'NoteBlockStudio.mp3');
  const call=f.fake.calls.at(-1);assert.equal(call.options.shell,false);assert.equal(call.args[call.args.indexOf('-protocol_whitelist')+1],'file,pipe');assert.equal(call.args[call.args.indexOf('-threads')+1],'1');assert.equal(call.args[call.args.indexOf('-f')+1],'wav');assert.ok(call.args.includes('-max_alloc'));
});

test('declared/streamed upload limits and body timeout return bounded errors and release the slot',async t=>{
  const f=await fixture(t,{limits:{maxInputBytes:100,bodyTimeoutMs:40}});
  let r=rawRequest(f.url+'/api/transcode',{headers:{...f.headers,'Content-Length':'101'}});assert.equal((await r.done).status,413);
  r=rawRequest(f.url+'/api/transcode',{headers:f.headers,body:Buffer.alloc(101)});assert.equal((await r.done).status,413);
  r=rawRequest(f.url+'/api/transcode',{headers:{...f.headers,'Content-Length':'80'},body:Buffer.alloc(16),end:false});assert.equal((await r.done).status,408);r.req.destroy();assert.equal(f.services.getStats().active,false);
  assert.equal((await f.post(wav(8))).status,200);
});

test('there is exactly one active upload/encode/delivery slot across clients',async t=>{
  let release;const wait=new Promise(resolve=>release=resolve),fake=fakeCodec({wait}),f=await fixture(t,{fake});const first=f.post();
  for(let i=0;i<100&&fake.calls.length<2;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.services.getStats().active,true);
  assert.equal((await f.post()).status,409);release();const response=await first;assert.equal(response.status,200);await response.arrayBuffer();for(let i=0;i<100&&f.services.getStats().active;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.services.getStats().active,false);
});

test('encoder failure, oversized output and process timeout do not leak paths and recover',async t=>{
  const failed=await fixture(t,{fake:fakeCodec({mode:'fail'})}),failure=await result(await failed.post());assert.equal(failure.status,502);assert.ok(!JSON.stringify(failure).includes('/private'));assert.equal(failed.services.getStats().active,false);
  const oversized=await fixture(t,{fake:fakeCodec({bytes:Buffer.alloc(101)}),limits:{maxOutputBytes:100}});assert.equal((await oversized.post()).status,413);
  const slow=await fixture(t,{fake:fakeCodec({mode:'hang'}),limits:{processTimeoutMs:20}});const timeout=await result(await slow.post());assert.equal(timeout.status,504);assert.equal(timeout.code,'CODEC_TIMEOUT');assert.equal(slow.fake.kills,1);assert.equal(slow.services.getStats().active,false);
});

test('hosted encoding can be disabled without probing/launching FFmpeg',async t=>{
  const f=await fixture(t,{env:{HOSTED_ENABLE_TRANSCODE:'0'}});assert.equal(f.cap.features.transcode,false);assert.equal(f.cap.ffmpeg.available,false);assert.equal(f.fake.calls.length,0);assert.equal((await f.post()).status,503);
});

test('rate state has a fixed capacity, rejects new addresses when full and expires old entries',()=>{
  let clock=1000;const limiter=new ClientRateLimiter({capacity:2,windowMs:100,capabilities:2,transcodes:1,now:()=>clock});assert.equal(limiter.take('a','capabilities').ok,true);assert.equal(limiter.take('b','capabilities').ok,true);assert.equal(limiter.take('c','capabilities').code,'CLIENT_LIMIT');assert.equal(limiter.size,2);assert.equal(limiter.take('a','transcodes').ok,true);assert.equal(limiter.take('a','transcodes').code,'RATE_LIMIT');clock+=101;assert.equal(limiter.take('c','capabilities').ok,true);assert.equal(limiter.size,1);
});

test('health consumes no rate budget and default address handling ignores forged forwarding headers',async t=>{
  const f=await fixture(t,{limits:{capabilityRate:1,rateClients:1}});
  for(let i=0;i<3;i++){assert.equal((await fetch(f.url+'/api/health')).status,200);const head=await fetch(f.url+'/api/health',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');}
  const limited=await fetch(f.url+'/api/capabilities',{headers:{'X-Forwarded-For':'203.0.113.44','X-NBS-Client-IP':'203.0.113.45'}});assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));assert.equal(f.services.getStats().rateClients,1);
  await f.services.close();assert.equal((await fetch(f.url+'/api/health')).status,503);
});

test('available real FFmpeg encodes a generated WAV through the hosted path',async t=>{
  const f=await fixture(t,{fake:null});if(!f.cap.ffmpeg.available){t.skip('Optional real FFmpeg is unavailable.');return;}
  for(const [format,signature] of [['mp3',null],['flac','fLaC'],['aiff','FORM'],['ogg','OggS'],['wav','RIFF']]){const response=await f.post(wav(4800),{},`format=${format}&rate=44100&channels=2&bitrate=192`);assert.equal(response.status,200,format+': '+(response.status===200?'':await response.text()));const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>100);if(signature)assert.equal(bytes.toString('ascii',0,4),signature);}
});

test('strict hosted WAV sample-rate boundaries stay at8kHz through384kHz',async t=>{
  const f=await fixture(t),samples=new Float32Array(64);
  for(const rate of [8000,384000,7999,384001,892,2172232]){
    const body=Buffer.from(await encodeWav({length:samples.length,numberOfChannels:1,sampleRate:rate,getChannelData:()=>samples}).arrayBuffer());
    const response=await f.post(body);assert.equal(response.status,[8000,384000].includes(rate)?200:415,`sampleRate=${rate}`);await response.arrayBuffer();
  }
});

let extremeVariants;
async function resourcePackExtremes(){
  if(!extremeVariants)extremeVariants=(async()=>{
    const {resampleMono}=await import('../js/audio-resample.js'),samples=Float32Array.from({length:4800},(_,i)=>Math.sin(i*2*Math.PI*220/48000)*.5);
    const source={length:samples.length,numberOfChannels:1,sampleRate:48000,getChannelData:()=>samples},variants=[];
    for(const [key,multiplier] of [[0,.25],[87,4]]){
      const rate=2**((key-45)/12)*multiplier,buffer=await resampleMono(source,{playbackRate:rate,sampleRate:48000}),blob=encodeWav(buffer),bytes=Buffer.from(await blob.arrayBuffer());
      assert.equal(buffer.sampleRate,48000);assert.equal(buffer.numberOfChannels,1);assert.ok(Math.abs(buffer.length-source.length/rate)<=1);assert.ok(buffer.length<=16*1024*1024);assert.ok(buffer.length/buffer.sampleRate<3600);assert.ok(bytes.length<=hostedLimits({}).maxInputBytes);
      assert.equal(bytes.readUInt32LE(24),48000);assert.equal(bytes.readUInt32LE(28),96000);assert.equal(bytes.readUInt32LE(4),bytes.length-8);variants.push({key,multiplier,bytes});
    }
    return variants;
  })();return extremeVariants;
}

test('lowest lower-octave and highest upper-octave resource samples pass the unchanged strict WAV decoder',async t=>{
  const f=await fixture(t);
  for(const {key,multiplier,bytes} of await resourcePackExtremes()){
    const response=await f.post(bytes,{},'format=ogg&rate=48000&channels=1');assert.equal(response.status,200,`key=${key}, multiplier=${multiplier}: ${response.status===200?'':await response.text()}`);await response.arrayBuffer();
  }
});

test('available real FFmpeg converts both resampled resource-pack extremes to OGG',async t=>{
  const f=await fixture(t,{fake:null});if(!f.cap.ffmpeg.available){t.skip('Optional real FFmpeg is unavailable.');return;}
  for(const {key,multiplier,bytes} of await resourcePackExtremes()){
    const response=await f.post(bytes,{},'format=ogg&rate=48000&channels=1');assert.equal(response.status,200,`key=${key}, multiplier=${multiplier}: ${response.status===200?'':await response.text()}`);const encoded=Buffer.from(await response.arrayBuffer());assert.equal(encoded.toString('ascii',0,4),'OggS');
  }
});
