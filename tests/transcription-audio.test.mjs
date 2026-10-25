import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TranscriptionAudioDecoder,transcriptionDecodeArguments,mixTranscriptionAudio,probeTranscriptionAudioHeader} from '../js/transcription-audio.js';
import {TranscriptionResampler} from '../js/transcription-dsp.js';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const native=(channels=[[.25,-.5]],rate=16000)=>({length:channels[0].length,numberOfChannels:channels.length,sampleRate:rate,getChannelData:index=>Float32Array.from(channels[index])});
const noNative=()=>{throw Object.assign(new Error('unsupported media codec'),{name:'EncodingError'});};
const input=()=>Uint8Array.from([1,2,3,4,5,6,7,8]);
function f32(values){const data=new Uint8Array(values.length*4),view=new DataView(data.buffer);values.forEach((value,index)=>view.setFloat32(index*4,value,true));return data;}
function wave({rate=44100,channels=2,frames=8,values}={}){const bytes=new Uint8Array(44+frames*channels*4),view=new DataView(bytes.buffer),tag=(offset,text)=>[...text].forEach((char,index)=>bytes[offset+index]=char.charCodeAt(0));tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,3,true);view.setUint16(22,channels,true);view.setUint32(24,rate,true);view.setUint32(28,rate*channels*4,true);view.setUint16(32,channels*4,true);view.setUint16(34,32,true);tag(36,'data');view.setUint32(40,frames*channels*4,true);for(let i=0;i<frames*channels;i++)view.setFloat32(44+i*4,values?.[i]??.25,true);return bytes;}
function flac({rate=48000,channels=2,frames=96000}={}){const bytes=new Uint8Array(42),view=new DataView(bytes.buffer);bytes.set([102,76,97,67,128,0,0,34]);bytes[18]=rate>>12;bytes[19]=(rate>>4)&255;bytes[20]=((rate&15)<<4)|((channels-1)<<1);bytes[21]=0xf0|(Math.floor(frames/2**32)&15);view.setUint32(22,frames%2**32,false);return bytes;}
function mp3({id3=0,version=3,mono=false}={}){const rate=version===3?48000:version===2?24000:12000,bitrate=version===3?128000:80000,frame=Math.floor((version===3?144:72)*bitrate/rate),prefix=id3?10+id3:0,bytes=new Uint8Array(prefix+frame*2),header=[255,0xe3|(version<<3),0x94,mono?192:0];if(id3){bytes.set([73,68,51,4,0,0,0,0,0,id3]);}bytes.set(header,prefix);bytes.set(header,prefix+frame);return bytes;}

// Adapter stub: lifecycle/queue/protocol tests do not claim to execute FFmpeg.
class DecoderFFmpeg{
  constructor({hold,cleanupHold,loadHold,status=0,output=f32([.5,-.25,0])}={}){Object.assign(this,{hold,cleanupHold,loadHold,status,output});this.files=new Map();this.events=new Map();this.calls=[];this.terminated=false;}
  on(name,callback){this.events.set(name,callback);}
  off(name){this.events.delete(name);}
  async load(config){this.calls.push(['load',config]);if(this.loadHold)await this.loadHold.promise;return true;}
  async writeFile(path,bytes){this.calls.push(['write',path]);this.files.set(path,structuredClone(bytes,{transfer:[bytes.buffer]}));}
  async exec(args,timeout){this.calls.push(['exec',args,timeout]);this.events.get('progress')?.({progress:.5,time:500000});if(this.hold)await this.hold.promise;return this.status;}
  async readFile(path){this.calls.push(['read',path]);return this.output;}
  async deleteFile(path){this.calls.push(['delete',path]);if(this.cleanupHold)await this.cleanupHold.promise;this.files.delete(path);}
  terminate(){this.calls.push(['terminate']);this.terminated=true;this.hold?.resolve();this.cleanupHold?.resolve();this.loadHold?.resolve();this.files.clear();}
}

test('fallback arguments preserve a known rate or use 48k for Worker Julius, with bounded sentinel and uniform known-channel mix',()=>{
  const args=transcriptionDecodeArguments({maxSeconds:12,maxOutputBytes:3000000});
  assert.equal(args[args.indexOf('-i')+1],'input.audio');assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file,pipe');
  assert.equal(args[args.indexOf('-ar')+1],'48000');assert.equal(args[args.indexOf('-ac')+1],'1');assert.equal(args.at(-1),'output.f32');
  assert.equal(args[args.indexOf('-fs')+1],String(12*48000*4+4));assert(Number(args[args.indexOf('-t')+1])>12);
  assert.equal(args.filter(value=>value==='1').length,3,'one input thread, one output thread, one channel');
  for(const options of [{maxSeconds:0},{maxSeconds:Infinity},{maxSeconds:3601},{maxInputBytes:0},{maxOutputBytes:3}])assert.throws(()=>transcriptionDecodeArguments(options));
  const source=transcriptionDecodeArguments({sampleRate:44100,channels:2});assert.equal(source[source.indexOf('-ar')+1],'44100');assert.equal(source[source.indexOf('-af')+1],'pan=mono|c0=0.5*c0+0.5*c1');
  for(const options of [{sampleRate:7999},{sampleRate:384001},{sampleRate:44100.5},{channels:0},{channels:33}])assert.throws(()=>transcriptionDecodeArguments(options));
});

test('bounded WAV, FLAC and consecutive MP3 headers reveal source rate/channels without decoding or trusting names',()=>{
  assert.deepEqual(probeTranscriptionAudioHeader(wave()),{format:'wav',sampleRate:44100,channels:2,frames:8});assert.deepEqual(probeTranscriptionAudioHeader(flac()),{format:'flac',sampleRate:48000,channels:2,frames:96000});
  assert.deepEqual(probeTranscriptionAudioHeader(mp3({id3:7})),{format:'mp3',sampleRate:48000,channels:2});assert.deepEqual(probeTranscriptionAudioHeader(mp3({version:2,mono:true})),{format:'mp3',sampleRate:24000,channels:1});assert.deepEqual(probeTranscriptionAudioHeader(mp3({version:0})),{format:'mp3',sampleRate:12000,channels:2});
  const all=new Uint8Array(16+42);all.set(flac(),16);assert.equal(probeTranscriptionAudioHeader(all.subarray(16)).sampleRate,48000);assert.equal(probeTranscriptionAudioHeader(wave({rate:64000})).sampleRate,64000);
});

test('truncated chunks, invalid rates, hostile ID3 lengths and random headers never read outside their bounds',()=>{
  const malformed=[new Uint8Array(),wave().subarray(0,20),flac().subarray(0,30),flac({rate:0}),flac({rate:384001}),wave({rate:7999}),mp3().subarray(0,100),Uint8Array.from([73,68,51,4,0,0,127,127,127,127]),Uint8Array.from([73,68,51,4,0,0,128,0,0,0])];
  const huge=wave();new DataView(huge.buffer).setUint32(16,0xffffffff,true);malformed.push(huge);for(const bytes of malformed)assert.equal(probeTranscriptionAudioHeader(bytes),null);
  const beyond=new Uint8Array(1024*1024+mp3().length);beyond.set(mp3(),1024*1024);assert.equal(probeTranscriptionAudioHeader(beyond),null);
  let seed=7;for(let run=0;run<600;run++){const bytes=new Uint8Array(run%177);for(let i=0;i<bytes.length;i++){seed=Math.imul(seed,1664525)+1013904223;bytes[i]=seed>>>24;}assert.doesNotThrow(()=>probeTranscriptionAudioHeader(bytes));}
});

test('native decoder requests the header source rate, defaults unknown containers to 48k, and reports SRC/cost separately',async()=>{
  const requested=[],decoder=new TranscriptionAudioDecoder({contextFactory:({sampleRate})=>{requested.push(sampleRate);return {decodeAudioData:async()=>native([[.2,.4]],sampleRate)};}});
  const known=await decoder.decode(wave({rate:64000})),unknown=await decoder.decode(input());assert.deepEqual(requested,[64000,48000]);assert.equal(known.sampleRate,64000);assert.equal(known.preprocessing.sourceSampleRate,64000);assert.equal(known.preprocessing.decoderMayResample,false);assert.equal(known.preprocessing.modelResampler,'julius-in-worker');assert.equal(unknown.preprocessing.sourceSampleRate,null);assert.equal(unknown.preprocessing.decoderMayResample,true);assert.ok(known.preprocessing.totalMs>=known.preprocessing.readMs);assert.equal(unknown.preprocessing.outputBytes,8);
});

test('real PCM channels are averaged without changing native sample rate or mutating source',async()=>{
  const channels=[Float32Array.from([1,0,-.5,.25]),Float32Array.from([-1,.5,.5,.75])],before=channels.map(channel=>channel.slice());
  const decoded=await mixTranscriptionAudio({length:4,numberOfChannels:2,sampleRate:48000,getChannelData:index=>channels[index]});
  assert.deepEqual(decoded.pcm,Float32Array.from([0,.25,0,.5]));assert.equal(decoded.sampleRate,48000);assert.equal(decoded.duration,4/48000);assert.equal(decoded.method,'native');assert.deepEqual(channels,before);
});

test('PCM length, duration, channels and non-finite sample failures reject without truncation',async()=>{
  await assert.rejects(mixTranscriptionAudio(native([[1,2,3,4]]),{maxOutputBytes:12}),{code:'OUTPUT_TOO_LARGE'});
  await assert.rejects(mixTranscriptionAudio(native([[1,2,3,4]]),{maxSeconds:1/16000}),{code:'INPUT_TOO_LONG'});
  await assert.rejects(mixTranscriptionAudio(native([[NaN]])),{code:'INVALID_PCM'});
  await assert.rejects(mixTranscriptionAudio({...native(),numberOfChannels:33}),{code:'INVALID_AUDIO'});
  await assert.rejects(mixTranscriptionAudio({...native(),getChannelData:()=>new Float32Array(1)}),{code:'INVALID_AUDIO'});
});

test('native path keeps caller bytes attached even when decoder consumes its input',async()=>{
  const source=input(),original=source.slice(),events=[];let decodedBytes;
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:bytes=>{decodedBytes=new Uint8Array(structuredClone(bytes,{transfer:[bytes]}));return native();},ffmpegFactory:()=>{throw Error('must not load');}});
  const result=await decoder.decode(source,{onProgress:event=>events.push(event)});
  assert.equal(result.method,'native');assert.deepEqual(source,original);assert.deepEqual(decodedBytes,original);assert.equal(decoder.getState().queuedBytes,0);assert(events.some(event=>event.stage==='done'));
});

test('native context is private and closes after decoding',async()=>{
  let closed=0;const context={async decodeAudioData(bytes){assert.equal(bytes.byteLength,8);return native([[.2,.4]],22050);},close(){closed++;return Promise.resolve();}};
  const decoder=new TranscriptionAudioDecoder({contextFactory:()=>context});const result=await decoder.decode(new Blob([input()]));
  assert.equal(result.sampleRate,22050);assert.equal(closed,1);
});

test('native codec failure uses separate local FFmpeg, copies PCM and releases all files/worker',async()=>{
  const ff=new DecoderFFmpeg(),events=[],source=input(),original=source.slice(),decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>ff});
  const media=new Blob([source]);Object.defineProperty(media,'name',{value:'https://outside.invalid/track.m4a; remote command'});
  const result=await decoder.decode(media,{onProgress:event=>events.push(event)});
  assert.equal(result.method,'ffmpeg');assert.equal(result.sampleRate,48000);assert.deepEqual(result.pcm,Float32Array.from([.5,-.25,0]));
  assert.deepEqual(source,original);assert.equal(ff.files.size,0);assert(ff.terminated);
  assert.deepEqual(ff.calls.filter(call=>call[0]==='delete').map(call=>call[1]).sort(),['input.audio','output.f32']);
  for(const value of Object.values(ff.calls.find(call=>call[0]==='load')[1]))assert.match(value,/\/vendor\/ffmpeg\//);
  const args=ff.calls.find(call=>call[0]==='exec')[1];assert(!args.some(value=>value.includes('outside.invalid')));
  assert(events.some(event=>event.stage==='fallback'));assert(events.some(event=>event.stage==='decode'&&event.progress===.5&&event.time===.5));
});

test('hard native capacity errors do not allocate a second decoder',async()=>{
  let fallbacks=0;const decoder=new TranscriptionAudioDecoder({nativeDecoder:()=>native([[1,2,3,4]]),ffmpegFactory:()=>{fallbacks++;return new DecoderFFmpeg();}});
  await assert.rejects(decoder.decode(input(),{maxOutputBytes:12}),{code:'OUTPUT_TOO_LARGE'});assert.equal(fallbacks,0);
});

test('native PCM budgets include every channel and known oversized multichannel headers bypass native allocation',async()=>{
  let reads=0;await assert.rejects(mixTranscriptionAudio({length:48000*600,numberOfChannels:32,sampleRate:48000,getChannelData(){reads++;throw Error('must not read');}}),{code:'OUTPUT_TOO_LARGE'});assert.equal(reads,0);
  let natives=0;const ff=new DecoderFFmpeg(),decoder=new TranscriptionAudioDecoder({nativeDecoder:()=>{natives++;throw Error('must not allocate');},ffmpegFactory:()=>ff});const result=await decoder.decode(flac({channels:8,frames:48000*600}));assert.equal(natives,0);assert.equal(result.sampleRate,48000);assert.equal(result.preprocessing.channelMix,'uniform-mean');assert.ok(ff.calls.find(call=>call[0]==='exec')[1].includes('pan=mono|c0=0.125*c0+0.125*c1+0.125*c2+0.125*c3+0.125*c4+0.125*c5+0.125*c6+0.125*c7'));
  await assert.rejects(decoder.decode(flac({frames:48000*601})),{code:'INPUT_TOO_LONG'});
});

test('bounds are checked before file reading or allocating native/FFmpeg decoders',async()=>{
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:()=>{throw Error('must not decode');}});
  await assert.rejects(decoder.decode(new Uint8Array()),{code:'EMPTY_INPUT'});
  await assert.rejects(decoder.decode(input(),{maxInputBytes:7}),{code:'INPUT_TOO_LARGE'});
  await assert.rejects(decoder.decode(input(),{maxSeconds:-1}),RangeError);
  await assert.rejects(decoder.decode('https://outside.invalid/audio.wav'),{code:'EMPTY_INPUT'});
});

test('native mixing yields and supports abort during long channel conversion',async()=>{
  const signal=new AbortController(),data=new Float32Array(300000).fill(.25);
  const work=mixTranscriptionAudio({length:data.length,numberOfChannels:1,sampleRate:16000,getChannelData:()=>data},{signal:signal.signal});
  const rejected=assert.rejects(work,{name:'AbortError'});setTimeout(()=>signal.abort(),0);await rejected;
});

test('queued jobs wait for cleanup, enforce queue size and never share a fallback Worker',async()=>{
  const cleanupHold=gate(),first=new DecoderFFmpeg({cleanupHold}),second=new DecoderFFmpeg(),instances=[first,second];
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>instances.shift(),maxTasks:2});
  const a=decoder.decode(input()),b=decoder.decode(input());await assert.rejects(decoder.decode(input()),{code:'QUEUE_FULL'});
  while(!first.calls.some(call=>call[0]==='delete'))await tick();assert.equal(second.calls.length,0);
  cleanupHold.resolve();await Promise.all([a,b]);assert(first.terminated&&second.terminated);assert.deepEqual(decoder.getState(),{active:false,queued:0,queuedBytes:0});
});

test('queued cancellation leaves active decode running; active cancellation permits a new job',async()=>{
  const hold=gate(),first=new DecoderFFmpeg({hold}),second=new DecoderFFmpeg(),instances=[first,second],active=new AbortController(),queued=new AbortController();
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>instances.shift()});
  const a=decoder.decode(input(),{signal:active.signal}),b=decoder.decode(input(),{signal:queued.signal});
  const ar=assert.rejects(a,{name:'AbortError'}),br=assert.rejects(b,{name:'AbortError'});queued.abort();await br;assert.equal(first.terminated,false);
  while(!first.calls.some(call=>call[0]==='exec'))await tick();active.abort();await ar;assert(first.terminated);
  assert.equal((await decoder.decode(input())).method,'ffmpeg');assert(second.terminated);
});

test('aborting non-cancellable native decode ignores late success and never launches fallback',async()=>{
  const hold=gate(),controller=new AbortController();let fallback=0;
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:async()=>{await hold.promise;return native();},ffmpegFactory:()=>{fallback++;return new DecoderFFmpeg();}});
  const work=decoder.decode(input(),{signal:controller.signal});const rejected=assert.rejects(work,{name:'AbortError'});await tick();controller.abort();await rejected;
  hold.resolve();await tick();assert.equal(fallback,0);assert.deepEqual(decoder.getState(),{active:false,queued:0,queuedBytes:0});
});

test('late FFmpeg creation after cancellation is terminated without poisoning the next job',async()=>{
  const hold=gate(),late=new DecoderFFmpeg(),current=new DecoderFFmpeg(),controller=new AbortController();let count=0;
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:async()=>{if(count++===0){await hold.promise;return late;}return current;}});
  const work=decoder.decode(input(),{signal:controller.signal});const rejected=assert.rejects(work,{name:'AbortError'});await tick();controller.abort();await rejected;
  const next=decoder.decode(input());hold.resolve();await next;await tick();assert(late.terminated&&current.terminated);
});

test('decoder rejects invalid, oversized and non-finite FFmpeg output and always releases worker',async()=>{
  for(const [output,options,code]of [[new Uint8Array(0),{},'INVALID_PCM'],[new Uint8Array(3),{},'INVALID_PCM'],[f32([NaN]),{},'INVALID_PCM'],[f32([.5,.5]),{maxOutputBytes:8},'OUTPUT_TOO_LARGE'],[f32([.5,.5]),{maxSeconds:1/48000},'INPUT_TOO_LONG']]){
    const ff=new DecoderFFmpeg({output}),decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>ff});
    await assert.rejects(decoder.decode(input(),options),{code});assert(ff.terminated);
  }
});

test('decode errors and bounded load/exec timeouts recover for later jobs',async()=>{
  const bad=new DecoderFFmpeg({status:1}),good=new DecoderFFmpeg(),instances=[bad,good],decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>instances.shift()});
  await assert.rejects(decoder.decode(input()),{code:'DECODE_FAILED'});assert(bad.terminated);assert.equal((await decoder.decode(input())).method,'ffmpeg');
  for(const property of ['loadHold','hold']){
    const pending=new DecoderFFmpeg({[property]:gate()}),slow=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>pending,loadTimeoutMs:20,decodeTimeoutMs:20});
    await assert.rejects(slow.decode(input()),{code:'DECODE_TIMEOUT'});assert(pending.terminated);slow.terminate();
  }
});

test('terminate rejects active/queued jobs, and progress callback failure cannot break decoding',async()=>{
  const hold=gate(),ff=new DecoderFFmpeg({hold}),decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>ff});
  const works=Promise.allSettled([decoder.decode(input()),decoder.decode(input())]);decoder.terminate();
  assert((await works).every(result=>result.status==='rejected'&&result.reason.name==='AbortError'));await tick();assert.equal(decoder.getState().queuedBytes,0);
  const good=new TranscriptionAudioDecoder({nativeDecoder:()=>native()});assert.equal((await good.decode(input(),{onProgress(){throw Error('broken view');}})).method,'native');
});

test('real vendored FFmpeg preserves known 44.1k source PCM and uniform stereo mean before the Worker Julius stage',async t=>{
  const coreURL=new URL('../vendor/ffmpeg/core/ffmpeg-core.js',import.meta.url),wasm=new Uint8Array(await readFile(new URL('../vendor/ffmpeg/core/ffmpeg-core.wasm',import.meta.url))),originalSelf=Object.getOwnPropertyDescriptor(globalThis,'self'),originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  globalThis.self=globalThis;globalThis.location={href:coreURL.href};t.after(()=>{if(originalSelf)Object.defineProperty(globalThis,'self',originalSelf);else delete globalThis.self;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;});
  const {default:createCore}=await import(coreURL.href),core=await createCore({wasmBinary:wasm}),events=new Map();core.setLogger(event=>events.get('log')?.(event));core.setProgress(event=>events.get('progress')?.(event));
  let terminated=false;const adapter={async load(){},on:(name,fn)=>events.set(name,fn),off:name=>events.delete(name),async writeFile(path,bytes){core.FS.writeFile(path,bytes);},async exec(args){const code=core.exec(...args);core.reset();return code;},async readFile(path){return core.FS.readFile(path);},async deleteFile(path){core.FS.unlink(path);},terminate(){terminated=true;}};
  const frames=4410,expected=new Float32Array(frames),values=new Float32Array(frames*2);for(let i=0;i<frames;i++){const wave=Math.sin(i*2*Math.PI*440/44100);values[2*i]=wave*.4;values[2*i+1]=wave*-.2;expected[i]=(values[2*i]+values[2*i+1])*.5;}
  const decoder=new TranscriptionAudioDecoder({nativeDecoder:noNative,ffmpegFactory:()=>adapter}),decoded=await decoder.decode(wave({rate:44100,frames,values}));assert.equal(decoded.sampleRate,44100);assert.equal(decoded.pcm.length,frames);assert.equal(decoded.preprocessing.decoderMayResample,false);assert.equal(decoded.preprocessing.channelMix,'uniform-mean');let difference=0;for(let i=0;i<frames;i++)difference=Math.max(difference,Math.abs(decoded.pcm[i]-expected[i]));assert.ok(difference<2e-7,`PCM max difference ${difference}`);assert.equal(terminated,true);
  const actual16=new TranscriptionResampler(44100).push(decoded.pcm,{final:true}),expected16=new TranscriptionResampler(44100).push(expected,{final:true});assert.equal(actual16.length,1600);let resampledDifference=0;for(let i=0;i<actual16.length;i++)resampledDifference=Math.max(resampledDifference,Math.abs(actual16[i]-expected16[i]));assert.ok(resampledDifference<3e-7,`Julius max difference ${resampledDifference}`);
});
