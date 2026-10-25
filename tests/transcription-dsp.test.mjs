import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {TranscriptionResampler,MuscriptorLogMel,MuscriptorTokenDecoder,MT3,CHUNK_SAMPLES} from '../js/transcription-dsp.js';

const join=chunks=>{const out=new Float32Array(chunks.reduce((total,chunk)=>total+chunk.length,0));let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}return out;};
const signal=(rate,seconds=.2,hz=440)=>Float32Array.from({length:Math.round(rate*seconds)},(_,index)=>Math.sin(2*Math.PI*hz*index/rate)*.6);
const rms=pcm=>Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length);
const maxError=(a,b)=>{assert.equal(a.length,b.length);let max=0,squares=0;for(let i=0;i<a.length;i++){const error=Math.abs(a[i]-b[i]);max=Math.max(max,error);squares+=error*error;}return {max,rms:Math.sqrt(squares/a.length)};};
const f32File=file=>{const bytes=readFileSync(file),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);assert.equal(bytes.length%4,0);return Float32Array.from({length:bytes.length/4},(_,index)=>view.getFloat32(index*4,true));};

test('polyphase output is independent of packet boundaries at common recording rates',()=>{
  for(const rate of [8000,11025,16000,22050,44100,48000,96000]){
    const input=signal(rate),whole=new TranscriptionResampler(rate).push(input,{final:true}),stream=new TranscriptionResampler(rate),parts=[];let at=0,index=0;
    for(const size of [1,0,7,31,128,17,513,64,1024]){parts.push(stream.push(input.slice(at,at+size)));at+=size;}
    while(at<input.length){const size=[3,81,256,137][index++%4];parts.push(stream.push(input.slice(at,at+size)));at+=size;}
    parts.push(stream.push(new Float32Array(),{final:true}));const actual=join(parts);
    assert.equal(actual.length,Math.floor(input.length*16000/rate),`output length ${rate}`);
    assert.deepEqual(actual,whole,`split invariance ${rate}`);
  }
});

test('constant PCM retains DC gain, does not mutate input and keeps only a bounded FIR tail',()=>{
  for(const rate of [8000,22050,44100,48000,192000]){
    const stream=new TranscriptionResampler(rate),input=new Float32Array(4096).fill(.25),before=input.slice(),parts=[];
    for(let index=0;index<6;index++){
      parts.push(stream.push(input));
      assert(stream.buffer.length<=2*stream.width+stream.old+2,`bounded tail ${rate}: ${stream.buffer.length}`);
    }
    parts.push(stream.push(new Float32Array(),{final:true}));const actual=join(parts);
    assert.deepEqual(input,before);assert(actual.every(value=>Math.abs(value-.25)<2e-6),`DC gain ${rate}`);
  }
});

test('downsampling attenuates above-Nyquist audio while retaining the passband',()=>{
  const pass=new TranscriptionResampler(48000).push(signal(48000,1,2000),{final:true}).subarray(100,15900);
  const rejected=new TranscriptionResampler(48000).push(signal(48000,1,12000),{final:true}).subarray(100,15900);
  assert(Math.abs(rms(pass)-.6/Math.sqrt(2))<.002,'passband amplitude');
  assert(rms(rejected)<.0005,`12kHz alias RMS ${rms(rejected)}`);
});

test('identity resampling clones PCM, finalizes once and rejects invalid samples/rates',()=>{
  const input=Float32Array.from([.1,-.2,.4]),stream=new TranscriptionResampler(16000),out=stream.push(input,{final:true});
  assert.deepEqual(out,input);assert.notEqual(out,input);out[0]=9;assert.equal(input[0],Math.fround(.1));
  assert.throws(()=>stream.push(input),/结束/);
  for(const rate of [0,7999,48000.1,Infinity,384001])assert.throws(()=>new TranscriptionResampler(rate),RangeError);
  assert.throws(()=>new TranscriptionResampler(16000,22050),RangeError);
  assert.throws(()=>new TranscriptionResampler(48000).push(Float32Array.from([NaN])),TypeError);
});

test('silence has finite constant log-mel floor and every frame uses the canonical shape',()=>{
  const mel=new MuscriptorLogMel(),output=mel.compute(new Float32Array(CHUNK_SAMPLES)),expected=Math.fround(Math.log(1e-6));
  assert.equal(output.length,501*512);assert(output.every(value=>value===expected));
  assert.throws(()=>mel.compute(new Float32Array(CHUNK_SAMPLES-1)),RangeError);
  assert.throws(()=>new MuscriptorLogMel({window:new Float32Array(1)}));
  assert.throws(()=>new MuscriptorLogMel({melFilter:new Float32Array(1)}));
});

const fixture=process.env.NBS_TRANSCRIPTION_FIXTURE;
const fixtureMel=root=>new MuscriptorLogMel({window:f32File(path.join(root,'window.f32')),melFilter:f32File(path.join(root,'mel-filter.f32'))});
function assertMelParity(t,actual,expected){
  const logError=maxError(actual,expected);let amplitudeMax=0,normalizedMax=0;
  for(let index=0;index<actual.length;index++){
    assert(Number.isFinite(actual[index]),`finite feature ${index}`);
    const reference=Math.exp(expected[index]),error=Math.abs(Math.exp(actual[index])-reference);
    amplitudeMax=Math.max(amplitudeMax,error);normalizedMax=Math.max(normalizedMax,error/(1.5e-5+reference*2e-5));
  }
  // PyTorch uses float32 FFT arithmetic; this implementation uses Float64 FFT
  // intermediates. Near the 1e-6 floor, tiny amplitude differences become large
  // relative log differences. Test EVERY amplitude bin, plus whole-feature log
  // RMS, instead of masking this with a loose maximum log-error threshold.
  assert(normalizedMax<=1,`amplitude error exceeds atol 1.5e-5 + rtol 2e-5: ratio ${normalizedMax}, max ${amplitudeMax}`);
  assert(logError.rms<=.003,`PyTorch/browser log-mel RMS ${logError.rms}`);
  t.diagnostic(`amplitude max ${amplitudeMax}, normalized max ${normalizedMax}; log max ${logError.max}, RMS ${logError.rms}; preprocessing parity only`);
}

test('actual PyTorch tone preprocessing agrees in amplitude at every bin and bounded log RMS',{skip:!fixture},t=>{
  const root=path.resolve(fixture),audio=f32File(path.join(root,'validation/audio-16000.f32')),expected=f32File(path.join(root,'validation/log-mel.f32'));
  assert.equal(audio.length,CHUNK_SAMPLES);assert.equal(expected.length,501*512);assertMelParity(t,fixtureMel(root).compute(audio),expected);
});

test('actual PyTorch silence reference is exact through exported window and filter assets',{skip:!fixture},()=>{
  const root=path.resolve(fixture),reference=JSON.parse(readFileSync(path.join(root,'validation/preprocessing.json'),'utf8'));
  assert.deepEqual(reference.logMelShape,[1,501,512]);
  const actual=fixtureMel(root).compute(new Float32Array(CHUNK_SAMPLES));assert.equal(actual.length,501*512);
  assert(actual.every(value=>value===Math.fround(reference.quietLogMel)));
});

test('actual PyTorch short noise reference agrees after the same right-zero padding',{skip:!fixture},t=>{
  const root=path.resolve(fixture),reference=JSON.parse(readFileSync(path.join(root,'validation/preprocessing.json'),'utf8')).noise;
  const input=f32File(path.join(root,'validation',reference.waveform)),padded=new Float32Array(reference.padRightTo);padded.set(input);
  assert.equal(input.length,reference.samples);assert.equal(padded.length,CHUNK_SAMPLES);
  assertMelParity(t,fixtureMel(root).compute(padded),f32File(path.join(root,'validation',reference.logMel)));
});

test('streaming resampler matches the official Julius reference at 44.1 to 16 kHz',{skip:!fixture},t=>{
  const root=path.resolve(fixture),reference=JSON.parse(readFileSync(path.join(root,'validation/preprocessing.json'),'utf8')).resample;
  const input=f32File(path.join(root,'validation',reference.input)),expected=f32File(path.join(root,'validation',reference.output));
  assert.equal(input.length,reference.inputSamples);assert.equal(expected.length,reference.outputSamples);
  const stream=new TranscriptionResampler(reference.inputRate),actual=join([stream.push(input.subarray(0,17)),stream.push(input.subarray(17,1024)),stream.push(input.subarray(1024),{final:true})]),error=maxError(actual,expected);
  assert.equal(reference.outputRate,16000);assert(error.max<=3e-7,`Julius max PCM error ${error.max}`);assert(error.rms<=1e-7,`Julius RMS PCM error ${error.rms}`);
  t.diagnostic(`official Julius PCM max ${error.max}, RMS ${error.rms}`);
});

const P=program=>MT3.program+program,K=pitch=>MT3.pitch+pitch,V=value=>MT3.velocity+value,S=centiseconds=>MT3.shift+centiseconds,D=pitch=>MT3.drum+pitch;
const feed=(decoder,tokens)=>tokens.forEach(token=>decoder.push(token));
const simple=decoder=>decoder.snapshot().map(({program,midiKey,isDrum,startSeconds,endSeconds})=>({program,midiKey,isDrum,startSeconds,endSeconds}));

// These note traces follow upstream events.py OpenNoteTracker/decode_model_tokens
// at 8a1ef88672cc23c26619adaff37ec48d82c0b906. The final fallback is deliberately
// 10 ms, not a guessed sustain until the end of the audio chunk.
test('MT3 ranges decode retriggers, binary velocity and drum onsets in temporal order',()=>{
  assert.deepEqual([MT3.shift,MT3.pitch,MT3.velocity,MT3.tie,MT3.program,MT3.drum,MT3.size],[3,1004,1132,1134,1135,1265,1393]);
  const decoder=new MuscriptorTokenDecoder();decoder.begin(0,5);
  feed(decoder,[MT3.tie,P(0),V(1),K(60),S(50),K(60),S(100),V(0),K(60),D(36)]);decoder.finish(5);
  assert.deepEqual(simple(decoder),[
    {program:0,midiKey:60,isDrum:false,startSeconds:0,endSeconds:.5},
    {program:0,midiKey:60,isDrum:false,startSeconds:.5,endSeconds:1},
    {program:0,midiKey:36,isDrum:true,startSeconds:1,endSeconds:1.01},
  ]);
});

test('cross-chunk ties retain declared notes and close absent instruments at the boundary',()=>{
  const decoder=new MuscriptorTokenDecoder();decoder.begin(0,5);feed(decoder,[MT3.tie,P(73),V(1),K(72),P(0),K(60)]);
  assert.deepEqual(decoder.promptTokens(1393,{force:true}),[1393,P(0),K(60),P(73),K(72),MT3.tie]);
  decoder.begin(5,10);feed(decoder,[P(0),K(60),MT3.tie,P(0),V(0),S(100),K(60)]);decoder.finish(10);
  assert.deepEqual(simple(decoder),[
    {program:73,midiKey:72,isDrum:false,startSeconds:0,endSeconds:5},
    {program:0,midiKey:60,isDrum:false,startSeconds:0,endSeconds:6},
  ]);
});

test('malformed missing-tie chunks close held notes and discard the remainder',()=>{
  const decoder=new MuscriptorTokenDecoder();decoder.begin(0,5);feed(decoder,[MT3.tie,P(0),V(1),K(60)]);
  decoder.begin(5,10);feed(decoder,[S(0),MT3.tie,P(0),V(1),K(64),D(36)]);decoder.finish(10);
  assert.equal(decoder.warnings,1);assert.deepEqual(simple(decoder),[{program:0,midiKey:60,isDrum:false,startSeconds:0,endSeconds:5}]);
});

test('incomplete prologues and final open notes follow upstream closing rules',()=>{
  const decoder=new MuscriptorTokenDecoder();decoder.begin(0,5);feed(decoder,[MT3.tie,P(0),V(1),K(60)]);
  decoder.begin(5,10);feed(decoder,[P(0),K(60)]);decoder.finish(10);
  assert.equal(simple(decoder)[0].endSeconds,5);
  const minimum=new MuscriptorTokenDecoder();minimum.begin(0,5);feed(minimum,[MT3.tie,P(0),V(1),S(100),K(60)]);minimum.finish(5);
  assert.equal(simple(minimum)[0].endSeconds,1.01);
});

test('shift tokens are absolute within a chunk and out-of-window events are ignored',()=>{
  const decoder=new MuscriptorTokenDecoder();decoder.begin(5,10);
  feed(decoder,[MT3.tie,P(0),V(1),S(100),K(60),S(200),K(64),S(500),K(67),D(36)]);decoder.finish(10);
  assert.deepEqual(simple(decoder).map(note=>[note.midiKey,note.startSeconds]),[[60,6],[64,7]]);
  const snapshot=decoder.snapshot();snapshot[0].startSeconds=99;assert.equal(decoder.snapshot()[0].startSeconds,6);
});

test('invalid token IDs cannot escape the vocabulary or allocate notes beyond capacity',()=>{
  const decoder=new MuscriptorTokenDecoder({maxNotes:1});decoder.begin(0,5);
  feed(decoder,[-1,1393,Infinity,NaN,1.5,undefined,MT3.pad,MT3.unk,MT3.eos,MT3.tie,P(0),V(1),K(60)]);
  assert.equal(decoder.snapshot().length,1);assert.throws(()=>decoder.push(D(36)),/上限/);
});
