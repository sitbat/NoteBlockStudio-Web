import test from 'node:test';
import assert from 'node:assert/strict';
import {resampleMono} from '../js/audio-resample.js';
import {encodeWav} from '../js/audio.js';

const pcm=(channels,sampleRate=48000)=>({length:channels[0].length,numberOfChannels:channels.length,sampleRate,getChannelData:i=>channels[i]});
const tone=(frames,frequency,sampleRate=48000)=>Float32Array.from({length:frames},(_,i)=>Math.sin(2*Math.PI*frequency*i/sampleRate)*.5);
const rms=(data,start=0,end=data.length)=>Math.sqrt(data.subarray(start,end).reduce((sum,v)=>sum+v*v,0)/(end-start));
function magnitude(data,frequency,sampleRate,start=0,end=data.length){let re=0,im=0;for(let i=start;i<end;i++){const phase=2*Math.PI*frequency*i/sampleRate;re+=data[i]*Math.cos(phase);im-=data[i]*Math.sin(phase);}return 2*Math.hypot(re,im)/(end-start);}

test('identity resampling preserves finite PCM exactly and downmixes stereo without mutating the source',async()=>{
  const left=new Float32Array([.25,.5,NaN,Infinity,-.5]),right=new Float32Array([.75,-.5,.5,-.5,.5]);
  const result=await resampleMono(pcm([left,right]));
  assert.equal(result.sampleRate,48000);assert.equal(result.numberOfChannels,1);assert.deepEqual([...result.getChannelData(0)],[.5,0,.25,-.25,0]);
  assert.equal(left[0],.25);assert.ok(Number.isNaN(left[2]));assert.throws(()=>result.getChannelData(1),RangeError);
});
test('PCM itself changes pitch and duration while the WAV header remains a real 48kHz',async()=>{
  const source=tone(4800,500),result=await resampleMono(pcm([source]),{playbackRate:2});
  assert.equal(result.length,2400);assert.equal(result.duration,.05);
  assert.ok(magnitude(result.getChannelData(0),1000,48000,96,2304)>.48);
  assert.ok(magnitude(result.getChannelData(0),500,48000,96,2304)<.02);
  const wav=new DataView(await encodeWav(result).arrayBuffer());
  assert.equal(wav.getUint32(24,true),48000);assert.equal(wav.getUint32(40,true),4800);assert.equal(wav.getUint16(22,true),1);
});
test('changing only the output sample rate preserves pitch and seconds',async()=>{
  const result=await resampleMono(pcm([tone(9600,1000,96000)],96000),{sampleRate:48000});
  assert.equal(result.length,4800);assert.equal(result.duration,.1);
  assert.ok(magnitude(result.getChannelData(0),1000,48000,96,4704)>.48);
});
test('downsampling filters frequencies above output Nyquist instead of folding them into an audible alias',async()=>{
  const high=await resampleMono(pcm([tone(4800,10000)]),{playbackRate:4});
  const low=await resampleMono(pcm([tone(4800,1000)]),{playbackRate:4});
  assert.ok(rms(high.getChannelData(0),64,1136)<.001,'40kHz content must not alias into 8kHz');
  assert.ok(magnitude(low.getChannelData(0),4000,48000,64,1136)>.48,'in-band content survives the same resampler');
});
test('all three resource-pack octave variants at both extreme legal roots have bounded true-rate WAV payloads',async()=>{
  const source=pcm([new Float32Array(96).fill(.25)]);
  for(const key of [0,45,87])for(const variant of [.25,1,4]){
    const playbackRate=2**((key-45)/12)*variant,result=await resampleMono(source,{playbackRate});
    assert.equal(result.length,Math.ceil(source.length/playbackRate),`root=${key}, octave=${variant}`);
    assert.ok(result.getChannelData(0).every(value=>Math.abs(value-.25)<1e-6));
    const header=new DataView(await encodeWav(result).arrayBuffer());assert.equal(header.getUint32(24,true),48000);assert.equal(header.getUint32(28,true),96000);assert.equal(header.getUint32(40,true),result.length*2);
  }
});
test('invalid rates, malformed channels and expanded-size limits fail before reading or allocating source PCM',async()=>{
  let reads=0;const source={length:48000,numberOfChannels:1,sampleRate:48000,getChannelData(){reads++;throw new Error('unexpected PCM read');}};
  for(const options of [{playbackRate:0},{playbackRate:NaN},{sampleRate:7999},{sampleRate:384001},{playbackRate:.01,maxFrames:1000},{playbackRate:1e300},{maxFrames:2**31}])await assert.rejects(resampleMono(source,options),/无效|过大|范围/);
  assert.equal(reads,0);
  await assert.rejects(resampleMono(pcm([new Float32Array(3),new Float32Array(2)])),/声道长度/);
  await assert.rejects(resampleMono({...source,length:16*1024*1024+1}),/过大/);assert.equal(reads,0);
});
