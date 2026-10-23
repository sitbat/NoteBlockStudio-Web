import test from 'node:test';
import assert from 'node:assert/strict';
import {removeInstrument,swapInstruments,moveInstrument,importInstrumentDefinitions,exportInstrumentBundle} from '../js/instrument-tools.js';
import {createBlankSong} from '../js/model.js';
import {readProjectBundle} from '../js/project-bundle.js';
import {readZip} from '../js/archive.js';

const definition=(name,file=`${name}.ogg`)=>({name,file,key:45,pressKey:true,metadata:{source:name}});
function fixture(){const song=createBlankSong();song.customInstruments=[definition('A'),definition('B'),definition('C')];song.notes=[0,16,17,18].map((instrument,id)=>({id:`n${id}`,tick:id,layer:0,instrument,key:45,velocity:100,pan:0,pitch:0}));const buffers=Array.from({length:3},(_,id)=>({id})),samples=new Map(buffers.map((buffer,index)=>[index,buffer]));return{song,samples,buffers};}
test('remove deletes only that instrument notes and remaps later definitions and PCM without mutating the bank',()=>{
  const {song,samples,buffers}=fixture();song.layers[0].locked=true;
  const result=removeInstrument(song,1,samples);
  assert.deepEqual(song.customInstruments.map(i=>i.name),['A','C']);assert.deepEqual(song.notes.map(n=>n.instrument),[0,16,17]);assert.deepEqual(song.notes.map(n=>n.id),['n0','n1','n3']);
  assert.deepEqual(result.removedNoteIds,['n2']);assert.equal(result.instrumentMap.get(17),-1);assert.equal(result.instrumentMap.get(18),17);assert.equal(result.instrumentMap.get(0),0);
  assert.equal(result.samples.get(0),buffers[0]);assert.equal(result.samples.get(1),buffers[2]);assert.equal(result.samples.size,2);assert.equal(samples.get(1),buffers[1]);assert.equal(samples.size,3);
});
test('swap and adjacent moves preserve every note sound, PCM identity and definition metadata',()=>{
  const {song,samples,buffers}=fixture(),swapped=swapInstruments(song,0,2,samples);
  assert.deepEqual(song.customInstruments.map(i=>i.name),['C','B','A']);assert.deepEqual(song.notes.map(n=>n.instrument),[0,18,17,16]);assert.equal(swapped.samples.get(0),buffers[2]);assert.equal(swapped.samples.get(2),buffers[0]);assert.equal(swapped.instrumentMap.get(16),18);
  const moved=moveInstrument(song,2,'up',swapped.samples);assert.deepEqual(song.customInstruments.map(i=>i.name),['C','A','B']);assert.deepEqual(song.notes.map(n=>n.instrument),[0,17,18,16]);assert.equal(moved.samples.get(1),buffers[0]);assert.equal(song.customInstruments[1].metadata.source,'A');
  const previous=JSON.stringify(song),edge=moveInstrument(song,0,'up',moved.samples);assert.equal(edge.changed,false);assert.equal(JSON.stringify(song),previous);assert.equal(edge.instrumentMap.get(16),16);
});
test('import appends cloned definitions, reuses full slash-normalized filenames and honors explicit source PCM',()=>{
  const {song,samples,buffers}=fixture();song.customInstruments[0].file='Custom/A.ogg';
  const supplied={id:'source'},imported={customInstruments:[definition('Reused','Custom\\A.ogg'),definition('Source','new.wav'),definition('Unloaded','other/A.ogg')],notes:[{instrument:16}]};
  const result=importInstrumentDefinitions(song,imported,{samples,sourceSamples:new Map([[1,supplied]])});
  assert.deepEqual(result.addedIndices,[3,4,5]);assert.equal(result.sourceInstrumentMap.get(16),19);assert.equal(result.sourceInstrumentMap.get(18),21);assert.equal(result.sourceInstrumentMap.get(0),0);
  assert.equal(result.samples.get(3),buffers[0]);assert.equal(result.samples.get(4),supplied);assert.equal(result.samples.has(5),false,'basename alone must not alias different folders');assert.equal(samples.size,3);assert.equal(song.notes.length,4,'only definitions are imported');
  song.customInstruments[3].metadata.source='changed';assert.equal(imported.customInstruments[0].metadata.source,'Reused');
});
test('decoded source samples override an existing matching filename and are reused by later incoming matches',()=>{
  const {song,samples}=fixture(),replacement={id:'replacement'},incoming={customInstruments:[definition('first','A.ogg'),definition('second','new.ogg'),definition('third','new.ogg'),definition('fourth','A.ogg')]},next={id:'new'};
  const result=importInstrumentDefinitions(song,incoming,{samples,sourceSamples:new Map([[0,replacement],[1,next]])});assert.equal(result.samples.get(3),replacement);assert.equal(result.samples.get(4),next);assert.equal(result.samples.get(5),next);assert.equal(result.samples.get(6),replacement);
});
test('invalid requests, undefined references and the 240-instrument limit fail atomically',()=>{
  for(const action of [f=>removeInstrument(f.song,-1,f.samples),f=>swapInstruments(f.song,0,3,f.samples),f=>moveInstrument(f.song,0,'sideways',f.samples),f=>removeInstrument(f.song,0,new Map([[99,{}]])),f=>importInstrumentDefinitions(f.song,{customInstruments:[{...definition('bad'),key:88}]},{samples:f.samples}),f=>importInstrumentDefinitions(f.song,{customInstruments:[definition('D')]},{samples:f.samples,sourceSamples:new Map([[3,{}]])})]){
    const f=fixture(),before=JSON.stringify(f.song),bank=[...f.samples];assert.throws(()=>action(f));assert.equal(JSON.stringify(f.song),before);assert.deepEqual([...f.samples],bank);
  }
  const f=fixture();f.song.customInstruments=Array.from({length:240},(_,i)=>definition(`I${i}`));const before=JSON.stringify(f.song);assert.throws(()=>importInstrumentDefinitions(f.song,{customInstruments:[definition('overflow')]},{samples:f.samples}),/240/);assert.equal(JSON.stringify(f.song),before);
});
test('instrument NBPZ exports definitions plus lossless float PCM, no song notes or arbitrary referenced paths',async()=>{
  const {song}=fixture(),left=new Float32Array([-.25,.125,.5]),right=new Float32Array([.75,-.5,0]),buffer={length:3,numberOfChannels:2,sampleRate:48000,getChannelData:index=>[left,right][index]};
  song.customInstruments[0].file='../../private/secret.wav';const before=JSON.stringify(song),bytes=await exportInstrumentBundle(song,new Map([[0,buffer]])),entries=await readZip(bytes),parsed=await readProjectBundle(bytes);
  assert.deepEqual([...entries.keys()].sort(),['manifest.json','project.json','samples/0.wav']);assert.equal(parsed.project.notes.length,0);assert.equal(parsed.project.customInstruments.length,3);assert.equal(parsed.project.customInstruments[0].file,'../../private/secret.wav');assert.equal(parsed.samples.length,1);
  const wav=new DataView(parsed.samples[0].bytes);assert.equal(wav.getUint16(20,true),3);assert.equal(wav.getUint16(22,true),2);assert.equal(wav.getUint32(24,true),48000);assert.equal(wav.getFloat32(44,true),left[0]);assert.equal(wav.getFloat32(48,true),right[0]);assert.equal(JSON.stringify(song),before);
  const destination=createBlankSong(),imported=importInstrumentDefinitions(destination,parsed.project,{sourceSamples:new Map([[0,buffer]])});assert.equal(imported.samples.get(0),buffer);assert.deepEqual(destination.customInstruments,parsed.project.customInstruments);
});
