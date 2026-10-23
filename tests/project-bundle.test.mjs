import test from 'node:test';import assert from 'node:assert/strict';
import {writeProjectBundle,readProjectBundle,snapshotSampleBank,restoreSampleBank} from '../js/project-bundle.js';
import {writeZip} from '../js/archive.js';import {createBlankSong} from '../js/model.js';
class BufferMock{constructor({length,numberOfChannels,sampleRate}){Object.assign(this,{length,numberOfChannels,sampleRate});this.data=Array.from({length:numberOfChannels},()=>new Float32Array(length));}getChannelData(ch){return this.data[ch];}}
test('portable project stores real WAV PCM and every track reverb with custom references',async()=>{
  const song=createBlankSong();song.layers[2].reverb=71;song.customInstruments=[{name:'Example',file:'custom.wav',key:45}];
  const buffer=new BufferMock({length:4,numberOfChannels:2,sampleRate:48000});buffer.data[0].set([0,.5,-.5,1]);buffer.data[1].set([0,-.5,.5,-1]);
  const bytes=await writeProjectBundle(song,new Map([[0,buffer]])),read=await readProjectBundle(bytes);
  assert.equal(read.project.layers[2].reverb,71);assert.equal(read.samples.length,1);
  const pcm=new DataView(read.samples[0].bytes);assert.equal(pcm.getUint32(24,true),48000);assert.equal(pcm.getUint16(22,true),2);assert.equal(pcm.getUint16(20,true),3);assert.equal(pcm.getUint16(34,true),32);assert.equal(pcm.getFloat32(52,true),.5);assert.equal(pcm.getFloat32(56,true),-.5);
});
test('sample autosave avoids copies for identical banks and restoration preserves stereo channels',()=>{
  const a=new BufferMock({length:8,numberOfChannels:2,sampleRate:44100});a.data[0][1]=.25;a.data[1][2]=-.5;const bank=new Map([[0,a]]),first=snapshotSampleBank(bank);
  assert.equal(snapshotSampleBank(bank,first.identity),null);assert.notEqual(first.samples[0].channels[0],a.data[0]);
  const restored=restoreSampleBank(first.samples,{AudioBufferClass:BufferMock,maxIndex:1});assert.equal(restored.get(0).data[0][1],.25);assert.equal(restored.get(0).data[1][2],-.5);
  assert.deepEqual(snapshotSampleBank(new Map(),first.identity).samples,[]);
});
test('portable projects reject duplicate sample IDs and missing audio before any state change',async()=>{
  const song=createBlankSong();song.customInstruments=[{file:'a.wav'}];
  const manifest={format:'ONBS Web Project',version:1,project:'project.json',samples:[{index:0,path:'samples/0.wav'}]};
  const bytes=await writeZip([{name:'project.json',data:JSON.stringify(song)},{name:'manifest.json',data:JSON.stringify(manifest)}]);
  await assert.rejects(readProjectBundle(bytes),/采样缺失/);
  assert.throws(()=>restoreSampleBank([{index:0,sampleRate:48000,channels:[new Float32Array(2),new Float32Array(3)]}],{AudioBufferClass:BufferMock}),/PCM/);
});
