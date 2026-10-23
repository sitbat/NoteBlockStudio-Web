import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createNativeServices,discordPacket} from '../native-services.mjs';
import {createLocalServer} from '../server.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
async function fixture(t,options={}){
  const services=await createNativeServices({projectRoot:root,...options});
  const server=createLocalServer(root,{services}),url=await listen(server);
  t.after(async()=>{await services.close();await close(server);});
  const capabilities=await (await fetch(url+'/api/capabilities')).json();
  const post=(route,body,extra={})=>fetch(url+route,{method:'POST',headers:{Origin:url,'X-NBS-Token':capabilities.token,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  return {services,server,url,capabilities,post};
}
const code=async response=>({status:response.status,...await response.json()});
function pcmWav(samples=4800){const wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*12000),44+i*2);return wav;}

test('local services require exact same-origin and per-instance token before mutations',async t=>{
  const f=await fixture(t),other=await fixture(t);
  assert.match(f.capabilities.token,/^[0-9a-f]{64}$/);
  assert.notEqual(f.capabilities.token,other.capabilities.token);
  assert.equal(f.capabilities.discord.enabled,false);
  assert.equal(f.capabilities.discord.connected,false);
  assert.equal(f.capabilities.launch,null);
  for(const headers of [{},{Origin:f.url},{Origin:'https://evil.invalid','X-NBS-Token':f.capabilities.token},{Origin:f.url,'X-NBS-Token':other.capabilities.token}]){
    const r=await fetch(f.url+'/api/presence',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{"enabled":false}'});
    assert.equal(r.status,403);
  }
  assert.equal((await f.post('/api/presence',{enabled:false})).status,200);
  assert.equal((await fetch(f.url+'/api/capabilities',{headers:{Origin:'https://evil.invalid'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(f.url+'/api/capabilities',{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostStatus,403);
});

test('API validates JSON, methods, routes, codec options and declared body bounds',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await code(await f.post('/api/presence',{enabled:'yes'})),{status:400,error:'enabled must be a boolean.',code:'INVALID_PRESENCE'});
  assert.equal((await f.post('/api/presence',{}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await fetch(f.url+'/api/presence',{method:'POST',headers:{Origin:f.url,'X-NBS-Token':f.capabilities.token,'Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(f.url+'/api/presence')).status,404);
  assert.equal((await f.post('/api/no-such-route',{})).status,404);
  for(const suffix of ['format=exe','rate=123','channels=3','bitrate=1','format=mp3&path=anything']){
    const r=await f.post('/api/transcode?'+suffix,{});assert.equal(r.status,400);assert.equal((await r.json()).code,'INVALID_CODEC_OPTIONS');
  }
  const large=await new Promise((resolve,reject)=>{
    const req=http.request(f.url+'/api/presence',{method:'POST',headers:{Origin:f.url,'X-NBS-Token':f.capabilities.token,'Content-Type':'application/json','Content-Length':20000,Connection:'close'}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(body)}));});req.on('error',reject);req.end();
  });
  assert.equal(large.status,413);assert.equal(large.code,'BODY_TOO_LARGE');
});

test('only the explicit launch file is available and URL protocol repair preserves URL encoding',async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'nbs-launch-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const file=path.join(temp,'中文 song.nbs');await writeFile(file,Buffer.from([0,1,2,3]));
  const f=await fixture(t,{launchFile:file});assert.deepEqual(f.capabilities.launch,{kind:'file',name:'中文 song.nbs'});
  const result=await fetch(f.url+'/api/launch-file');assert.deepEqual(Buffer.from(await result.arrayBuffer()),Buffer.from([0,1,2,3]));assert.equal(decodeURIComponent(result.headers.get('x-nbs-filename')),'中文 song.nbs');
  assert.equal((await fetch(f.url+'/api/launch-file?path=elsewhere.nbs')).status,400);
  const none=await fixture(t);assert.equal((await fetch(none.url+'/api/launch-file')).status,404);
  const url=await fixture(t,{launchURL:'nbs://https//example.com/my%20song.nbs?x=%2F'});assert.deepEqual(url.capabilities.launch,{kind:'url',url:'https://example.com/my%20song.nbs?x=%2F'});
  await assert.rejects(createNativeServices({projectRoot:root,launchURL:'file:///etc/passwd'}),/HTTP/);
  await assert.rejects(createNativeServices({projectRoot:root,launchFile:path.join(temp,'missing.nbs')}),/ENOENT/);
});

test('explicit remote song fetch handles bounded redirects and rejects unsupported or credentialed URLs',async t=>{
  const remote=http.createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/song'}).end();}
    else if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'}).end();}
    else if(req.url==='/huge'){res.writeHead(200,{'Content-Length':128*1024*1024+1}).end();}
    else if(req.url==='/404')res.writeHead(404).end();
    else {res.writeHead(200,{'Content-Type':'audio/midi','Content-Disposition':"attachment; filename*=UTF-8''..%2Ftest%20song.mid"});res.end(Buffer.from([77,84,104,100]));}
  });const remoteURL=await listen(remote);t.after(()=>close(remote));
  const f=await fixture(t);
  for(const value of ['file:///etc/passwd','ftp://example.com/a.nbs','http://user:secret@127.0.0.1/test','not a URL'])assert.equal((await f.post('/api/fetch-song',{url:value})).status,400);
  const r=await f.post('/api/fetch-song',{url:remoteURL+'/redirect'});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'audio/midi');assert.equal(decodeURIComponent(r.headers.get('x-nbs-filename')),'test song.mid');assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from([77,84,104,100]));
  assert.equal((await f.post('/api/fetch-song',{url:remoteURL+'/loop'})).status,502);
  assert.equal((await f.post('/api/fetch-song',{url:remoteURL+'/huge'})).status,413);
  assert.equal((await f.post('/api/fetch-song',{url:remoteURL+'/404'})).status,502);
});

test('Discord IPC is opt-in and performs handshake, activity, ping/pong and clear over a real local socket',async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'nbs-discord-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\nbs-discord-${randomUUID()}`:path.join(temp,'discord-ipc-0');
  const frames=[],sockets=new Set();let connects=0,pong=false;
  const ipc=net.createServer(socket=>{
    connects++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=8){const op=buffer.readUInt32LE(0),len=buffer.readUInt32LE(4);if(buffer.length<8+len)break;const bytes=buffer.subarray(8,8+len);buffer=buffer.subarray(8+len);if(op===4){pong=bytes.toString()==='ping';continue;}const payload=JSON.parse(bytes);frames.push({op,payload});if(op===0){const ready=discordPacket(1,{evt:'READY',data:{user:{id:'test'}}});socket.write(ready.subarray(0,5));setTimeout(()=>{socket.write(ready.subarray(5));socket.write(discordPacket(3,Buffer.from('ping')));},5);}else if(op===1)socket.write(discordPacket(1,{cmd:payload.cmd,nonce:payload.nonce,data:{}}));}});
  });await new Promise((resolve,reject)=>{ipc.once('error',reject);ipc.listen(endpoint,resolve);});t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>ipc.close(resolve));});
  const f=await fixture(t,{discordPaths:[endpoint]});assert.equal(connects,0);
  const enabled=await f.post('/api/presence',{enabled:true,details:'Test\nSong',state:'Editing'});assert.equal(enabled.status,200);assert.equal((await enabled.json()).connected,true);
  assert.deepEqual(frames[0],{op:0,payload:{v:1,client_id:'848873736702132246'}});
  assert.equal(frames[1].payload.cmd,'SET_ACTIVITY');assert.equal(frames[1].payload.args.pid,process.pid);assert.equal(frames[1].payload.args.activity.details,'Test Song');assert.equal(typeof frames[1].payload.args.activity.timestamps.start,'number');
  const disabled=await f.post('/api/presence',{enabled:false});assert.equal(disabled.status,200);assert.equal((await disabled.json()).enabled,false);assert.equal(frames.at(-1).payload.args.activity,null);assert.equal(pong,true);assert.equal(connects,1);
});

test('missing Discord IPC reports an actionable error without enabling a background retry',async t=>{
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\nbs-missing-${randomUUID()}`:path.join(os.tmpdir(),`nbs-missing-${randomUUID()}`);
  const f=await fixture(t,{discordPaths:[endpoint]});const result=await code(await f.post('/api/presence',{enabled:true}));assert.equal(result.status,503);assert.equal(result.code,'DISCORD_UNAVAILABLE');assert.equal((await f.post('/api/presence',{enabled:false})).status,200);
});

test('available FFmpeg performs real codec conversion of a generated PCM WAV',async t=>{
  const f=await fixture(t);if(!f.capabilities.ffmpeg.available){t.skip('Optional real FFmpeg executable is not installed.');return;}
  const wav=pcmWav();
  for(const format of ['mp3','flac','aiff','ogg','wav']){
    const r=await fetch(f.url+`/api/transcode?format=${format}&rate=44100&channels=2&bitrate=192`,{method:'POST',headers:{Origin:f.url,'X-NBS-Token':f.capabilities.token,'Content-Type':'audio/wav'},body:wav});
    assert.equal(r.status,200,`${format}: ${r.status===200?'':await r.text()}`);const body=Buffer.from(await r.arrayBuffer());assert.ok(body.length>100);assert.equal(decodeURIComponent(r.headers.get('x-nbs-filename')),`NoteBlockStudio.${format}`);
    if(format==='flac')assert.equal(body.toString('ascii',0,4),'fLaC');if(format==='aiff')assert.equal(body.toString('ascii',0,4),'FORM');if(format==='ogg')assert.equal(body.toString('ascii',0,4),'OggS');if(format==='wav')assert.equal(body.toString('ascii',0,4),'RIFF');
  }
  const invalid=await fetch(f.url+'/api/transcode',{method:'POST',headers:{Origin:f.url,'X-NBS-Token':f.capabilities.token},body:'not a wav'});assert.equal(invalid.status,415);
});

test('FFmpeg permits one export at a time, releases failed uploads and enforces its process timeout',async t=>{
  const f=await fixture(t);if(!f.capabilities.ffmpeg.available){t.skip('Optional real FFmpeg executable is not installed.');return;}
  const wav=pcmWav(),headers={Origin:f.url,'X-NBS-Token':f.capabilities.token,'Content-Type':'audio/wav','Content-Length':wav.length};
  let first;const firstDone=new Promise((resolve,reject)=>{first=http.request(f.url+'/api/transcode?format=wav',{method:'POST',headers},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});first.on('error',reject);first.write(wav.subarray(0,16));});
  await new Promise(resolve=>setTimeout(resolve,30));
  const second=await fetch(f.url+'/api/transcode?format=wav',{method:'POST',headers:{Origin:f.url,'X-NBS-Token':f.capabilities.token},body:wav});assert.equal(second.status,409);assert.equal((await second.json()).code,'TRANSCODE_BUSY');
  first.end(wav.subarray(16));assert.equal(await firstDone,200);
  const limited=await fixture(t,{ffmpegTimeoutMs:1});
  const timeout=await fetch(limited.url+'/api/transcode?format=mp3',{method:'POST',headers:{Origin:limited.url,'X-NBS-Token':limited.capabilities.token},body:pcmWav(480000)});assert.equal(timeout.status,504);assert.equal((await timeout.json()).code,'CODEC_TIMEOUT');
  const next=await fetch(limited.url+'/api/transcode?format=wav',{method:'POST',headers:{Origin:limited.url,'X-NBS-Token':limited.capabilities.token},body:'bad'});assert.equal(next.status,415);
});
