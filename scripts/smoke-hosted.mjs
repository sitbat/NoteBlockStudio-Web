#!/usr/bin/env node
/** Verify a website using synthetic audio only; no personal file is read. */
import assert from 'node:assert/strict';
import {normalizePublicOrigin} from '../hosted-server.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

function wave(){const frames=4800,channels=2,bytes=Buffer.alloc(44+frames*channels*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(48000*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);for(let i=0;i<frames;i++)for(let ch=0;ch<channels;ch++)bytes.writeInt16LE(Math.round(Math.sin(i*Math.PI*2*440/48000)*8000),44+(i*channels+ch)*2);return bytes;}
const isolation=response=>{assert.equal(response.headers.get('cross-origin-opener-policy'),'same-origin');assert.equal(response.headers.get('cross-origin-embedder-policy'),'require-corp');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');};
export async function smokeHosted(input,{allFormats=false,transcode=true,fetchImpl=fetch}={}){
  const origin=normalizePublicOrigin(input),get=async(route,options={})=>fetchImpl(origin+route,{redirect:'error',signal:AbortSignal.timeout(150000),...options});
  const result={origin,assets:[],encoded:[],localIntegrationsDisabled:false};
  for(const route of ['/','/js/app.js','/js/file-worker.js','/js/output-worklet.js','/wasm/nbs_dsp.wasm','/assets/sounds/harp.ogg']){
    const response=await get(route,{method:'HEAD'});assert.equal(response.status,200,`Public asset ${route}`);isolation(response);assert.ok(Number(response.headers.get('content-length'))>0);result.assets.push(route);
  }
  const wasm=await get('/wasm/nbs_dsp.wasm');assert.match(wasm.headers.get('content-type'),/^application\/wasm/);assert.ok(WebAssembly.validate(await wasm.arrayBuffer()));
  for(const route of ['/.git/config','/.env','/package.json','/hosted-services.mjs','/runtime/linux-x64/LICENSE','/docs/VERIFICATION.md']){const response=await get(route);assert.ok([403,404].includes(response.status),`Private path must not be served: ${route}`);await response.arrayBuffer();}
  const health=await get('/api/health');assert.equal(health.status,200);assert.equal((await health.json()).mode,'hosted');
  const response=await get('/api/capabilities'),caps=await response.json();assert.equal(response.status,200);assert.equal(caps.mode,'hosted');assert.equal(caps.features.presence,false);assert.equal(caps.features.launchFile,false);assert.equal(caps.features.fetchSong,false);assert.equal(caps.ffmpeg.path,undefined);result.localIntegrationsDisabled=true;
  for(const route of ['/api/launch-file','/api/presence','/api/fetch-song']){const denied=await get(route);assert.equal(denied.status,404);await denied.arrayBuffer();}
  const unsigned=await get('/api/transcode?format=mp3',{method:'POST',headers:{Origin:origin,'Content-Type':'audio/wav'},body:wave()});assert.equal(unsigned.status,403);assert.equal((await unsigned.json()).code,'SESSION_REQUIRED');
  if(allFormats&&transcode)assert.equal(caps.features.transcode,true,'--all-formats requires an available server encoder; use --no-transcode when encoding is intentionally disabled.');
  if(transcode&&caps.features.transcode){
    const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie,'Capability response must issue a session cookie.');
    for(const format of allFormats?['mp3','flac','aiff','ogg','wav']:['mp3']){
      const encoded=await get(`/api/transcode?format=${format}&rate=44100&channels=1&bitrate=128`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'X-NBS-Token':caps.token,'Content-Type':'audio/wav'},body:wave()});assert.equal(encoded.status,200,`Server encoder ${format}`);const bytes=Buffer.from(await encoded.arrayBuffer());assert.ok(bytes.length>32);
      if(format==='mp3')assert.ok(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224);
      if(format==='flac')assert.equal(bytes.subarray(0,4).toString(),'fLaC');
      if(format==='aiff'){assert.equal(bytes.subarray(0,4).toString(),'FORM');assert.ok(['AIFF','AIFC'].includes(bytes.subarray(8,12).toString()));}
      if(format==='ogg'){assert.equal(bytes.subarray(0,4).toString(),'OggS');assert.ok(bytes.includes(Buffer.from('vorbis')));}
      if(format==='wav'){assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.subarray(8,12).toString(),'WAVE');}
      result.encoded.push({format,bytes:bytes.length});
    }
  }
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.includes('--help')||!args.length)console.log('Usage: node scripts/smoke-hosted.mjs https://nbs.example.com [--all-formats] [--no-transcode]\nChecks public assets/isolation, private paths, hosted capabilities and optional encoding of a generated0.1second tone.');
  else if(args.slice(1).some(value=>!['--all-formats','--no-transcode'].includes(value))){console.error('Unknown smoke-test option.');process.exitCode=1;}
  else smokeHosted(args[0],{allFormats:args.includes('--all-formats'),transcode:!args.includes('--no-transcode')}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(`Website smoke test failed: ${error.message}`);process.exitCode=1;});
}
