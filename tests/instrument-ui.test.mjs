import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {builtinForSound,resolveSoundImport,stageSoundImport,createInstrumentManager} from '../js/instrument-ui.js';
import {INSTRUMENTS} from '../js/audio.js';
import {createBlankSong} from '../js/model.js';

function file(path,data='OggS-fixture'){const bytes=typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data);return{name:path.split('/').at(-1),webkitRelativePath:path.includes('/')?path:'',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer,text:async()=>new TextDecoder().decode(bytes)};}
const hash=bytes=>createHash('sha1').update(bytes).digest('hex');
const pcm=id=>({id,length:2,numberOfChannels:1,sampleRate:48000,getChannelData:()=>new Float32Array([.25,-.5])});
function project(){const song=createBlankSong();song.customInstruments=[{name:'Existing',file:'old.ogg',key:45,pressKey:false}];song.notes=[0,2,1,16].map((instrument,index)=>({id:`n${index}`,tick:0,layer:index,key:45,instrument,velocity:100,pan:0,pitch:0}));return song;}
function assets(){const bytes=new TextEncoder().encode('OggS-user-selected-object'),sha=hash(bytes),object=file(`.minecraft/assets/objects/${sha.slice(0,2)}/${sha}`,bytes),index=path=>file(path,JSON.stringify({objects:{'minecraft/sounds/note/harp.ogg':{hash:sha,size:bytes.length},'minecraft/sounds/music/harp.ogg':{hash:sha,size:bytes.length},'minecraft/sounds/records/harp.ogg':{hash:sha,size:bytes.length},'minecraft/sounds/note/bass.ogg':{hash:'a'.repeat(40),size:12}}}));return{bytes,sha,object,index};}

test('all 16 native sample filenames and Minecraft aliases map to the right builtin; UI construction needs no permissions',()=>{
  INSTRUMENTS.forEach(instrument=>assert.equal(builtinForSound(`note/${instrument.file}`),instrument.id));
  for(const [name,id]of [['bass',1],['bd',2],['basedrum',2],['snare',3],['hat',4],['chime',8],['xylophone',9]])assert.equal(builtinForSound(`folder/${name}.ogg`),id);
  assert.equal(builtinForSound('voice.ogg'),-1);assert.equal(builtinForSound('harp.mp3'),-1);
  const manager=createInstrumentManager({engine:{customSamples:new Map()}});assert.equal(typeof manager.open,'function');assert.equal(typeof manager.importSounds,'function');
});
test('both dialogs stop the main transport and destroy live monitoring before exposing mutable instrument order',()=>{
  const calls=[],sentinel=new Error('modal boundary'),manager=createInstrumentManager({getState:()=>({busy:false}),getSong:()=>project(),engine:{stopLive:()=>calls.push('live')},stopPlayback:reset=>{assert.equal(reset,false);calls.push('main');},modal:()=>{calls.push('modal');throw sentinel;}});
  for(const open of [manager.open,manager.importSounds]){calls.length=0;assert.throws(()=>open(),error=>error===sentinel);assert.deepEqual(calls,['main','live','modal']);}
});
test('explicit OGG selection includes other custom sounds while folder matching skips unrelated files, music and records',async()=>{
  const files=[file('sounds/harp.ogg'),file('sounds/bass.ogg'),file('sounds/voice.ogg'),file('sounds/music/harp.ogg'),file('sounds/records/harp.ogg'),file('sounds/readme.txt')];
  const direct=await resolveSoundImport(files);assert.deepEqual(direct.candidates.map(c=>c.builtin),[0,1,-1]);assert.equal(direct.candidates[2].name,'voice');
  const folder=await resolveSoundImport(files,{folder:true});assert.deepEqual(folder.candidates.map(c=>c.builtin),[0,1]);assert.match(folder.warnings[0],/文件夹模式/);
  await assert.rejects(resolveSoundImport([file('../harp.ogg')]),/相对路径/);
});
test('Minecraft indexes resolve only granted hash objects, select a version and report missing objects',async()=>{
  const a=assets(),old=a.index('.minecraft/assets/indexes/1.12.json'),newer=a.index('.minecraft/assets/indexes/26.json'),input=[old,newer,a.object];
  const result=await resolveSoundImport(input,{folder:true});assert.equal(result.indexes.length,2);assert.equal(result.assetIndexPath,newer.webkitRelativePath);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].file,a.object);assert.equal(result.candidates[0].fileName,'minecraft/note/harp.ogg');assert.equal(result.candidates[0].assetHash,a.sha);assert.match(result.warnings[0],/1 个.*未包含/);
  const selected=await resolveSoundImport(input,{folder:true,assetIndexPath:old.webkitRelativePath});assert.equal(selected.assetIndexPath,old.webkitRelativePath);
  await assert.rejects(resolveSoundImport(input,{assetIndexPath:'not-selected/indexes/other.json'}),/授权/);
});

test('all-game-sounds mode lists every authorized non-music OGG with note-block samples first and preserves paths',async()=>{
  const a=assets(),entries=['entity/cow/hurt.ogg','note/harp.ogg','ambient/cave/cave1.ogg','music/game/calm.ogg','records/13.ogg'],index=file('.minecraft/assets/indexes/26.json',JSON.stringify({objects:Object.fromEntries(entries.map(path=>[`minecraft/sounds/${path}`,{hash:a.sha,size:a.bytes.length}]))}));
  const result=await resolveSoundImport([index,a.object],{folder:true,soundMode:'all'});
  assert.equal(result.soundMode,'all');assert.equal(result.candidates.length,3);
  assert.deepEqual(result.candidates.map(c=>c.builtin),[0,-1,-1]);
  assert.deepEqual(result.candidates.map(c=>c.fileName),['minecraft/note/harp.ogg','minecraft/ambient/cave/cave1.ogg','minecraft/entity/cow/hurt.ogg']);
  assert.equal(result.candidates[2].name,'entity/cow/hurt');assert.ok(result.candidates.every(c=>c.assetHash===a.sha));
  assert.equal((await resolveSoundImport([index,a.object],{folder:true})).candidates.length,1,'recommended default still restricts folder imports to note-block samples');
  const folder=await resolveSoundImport([file('sounds/entity/cow/hurt.ogg'),file('sounds/note/harp.ogg'),file('sounds/music/game/calm.ogg'),file('sounds/records/13.ogg')],{folder:true,soundMode:'all'});
  assert.deepEqual(folder.candidates.map(c=>c.fileName),['sounds/note/harp.ogg','sounds/entity/cow/hurt.ogg']);
  await assert.rejects(resolveSoundImport([],{soundMode:'unknown'}),/导入模式/);
});

test('all-mode discovery never truncates to 240; excess checked selections reject before any decode and a chosen subset imports atomically',async()=>{
  const a=assets(),index=file('.minecraft/assets/indexes/26.json',JSON.stringify({objects:Object.fromEntries(Array.from({length:301},(_,i)=>[`minecraft/sounds/entity/mob/sound${i}.ogg`,{hash:a.sha,size:a.bytes.length}]))}));
  const {candidates}=await resolveSoundImport([index,a.object],{folder:true,soundMode:'all'}),song=project(),before=JSON.stringify(song);let decodes=0;
  assert.equal(candidates.length,301);
  await assert.rejects(stageSoundImport(song,new Map(),candidates,{decode:async()=>{decodes++;return pcm('unused');}}),/已选 301.*只剩 239.*减少选择/);
  assert.equal(decodes,0);assert.equal(JSON.stringify(song),before);
  const result=await stageSoundImport(song,new Map(),[candidates[7],candidates[300]],{decode:async()=>{decodes++;return pcm(decodes);}});
  assert.equal(decodes,2);assert.equal(result.addedIndices.length,2);assert.equal(result.song.customInstruments[1].file,candidates[7].fileName);assert.equal(result.song.customInstruments[2].file,candidates[300].fileName);assert.equal(JSON.stringify(song),before);
});
test('malformed index paths, hashes, JSON and object sizes fail without following paths or downloading',async()=>{
  const a=assets(),path='.minecraft/assets/indexes/26.json';
  await assert.rejects(resolveSoundImport([file(path,'not JSON')],{folder:true}),/JSON/);
  for(const [key,value]of [['minecraft/sounds/note/../harp.ogg',{hash:a.sha,size:a.bytes.length}],['minecraft/sounds/note/harp.ogg',{hash:'not-hash',size:a.bytes.length}],['minecraft/sounds/note/harp.ogg',{hash:a.sha,size:a.bytes.length+1}]])await assert.rejects(resolveSoundImport([file(path,JSON.stringify({objects:{[key]:value}})),a.object],{folder:true}),/路径|哈希|大小/);
});
test('staging decodes every selected file before returning an atomic project and native-note conversion',async()=>{
  const song=project(),old=pcm('old'),samples=new Map([[0,old]]),before=JSON.stringify(song),resolved=await resolveSoundImport([file('harp.ogg'),file('voice.ogg')]),decoded=[],progress=[];
  const result=await stageSoundImport(song,samples,resolved.candidates,{convertNative:true,decode:async bytes=>{assert.ok(bytes instanceof ArrayBuffer);const buffer=pcm(decoded.length);decoded.push(buffer);return buffer;},onProgress:message=>progress.push(message)});
  assert.equal(decoded.length,2);assert.equal(progress.length,2);assert.equal(result.convertedNotes,1);assert.equal(result.nativeMap.get(0),17);assert.deepEqual(result.song.notes.map(n=>n.instrument),[17,2,1,16]);assert.deepEqual(result.song.customInstruments.map(i=>i.pressKey),[false,true,false]);assert.equal(result.samples.get(1),decoded[0]);assert.equal(result.samples.get(2),decoded[1]);assert.equal(result.samples.get(0),old);assert.equal(samples.size,1);assert.equal(JSON.stringify(song),before);
});
test('decode failure and stale project cancellation cannot leave definitions or PCM partially imported',async()=>{
  const song=project(),samples=new Map([[0,pcm('old')]]),before=JSON.stringify(song),{candidates}=await resolveSoundImport([file('harp.ogg'),file('snare.ogg')]);let calls=0;
  await assert.rejects(stageSoundImport(song,samples,candidates,{decode:async()=>{if(calls++)throw new Error('unsupported OGG');return pcm('first');}}),/unsupported OGG/);
  assert.equal(calls,2);assert.equal(JSON.stringify(song),before);assert.equal(samples.size,1);
  let current=true;await assert.rejects(stageSoundImport(song,samples,candidates,{isCurrent:()=>current,decode:async()=>{current=false;return pcm('stale');}}),error=>error.name==='AbortError');assert.equal(JSON.stringify(song),before);assert.equal(samples.size,1);
});
test('indexed sound bytes are SHA1 verified before audio decoding and preserve the source files',async()=>{
  const a=assets(),resolved=await resolveSoundImport([a.index('.minecraft/assets/indexes/26.json'),a.object],{folder:true}),song=project();let decodes=0;
  const result=await stageSoundImport(song,new Map(),resolved.candidates,{decode:async()=>{decodes++;return pcm('verified');}});assert.equal(result.addedIndices.length,1);assert.equal(decodes,1);assert.equal(result.song.customInstruments[1].file,'minecraft/note/harp.ogg');
  const tampered={...resolved.candidates[0],file:{...a.object,arrayBuffer:async()=>new Uint8Array(a.bytes.length).buffer}};await assert.rejects(stageSoundImport(song,new Map(),[tampered],{decode:async()=>{decodes++;return pcm('wrong');}}),/哈希不匹配/);assert.equal(decodes,1);assert.deepEqual(new Uint8Array(await a.object.arrayBuffer()),a.bytes);
});
test('encoded/decoded size and 240-definition bounds fail before committing any song change',async()=>{
  const song=project(),before=JSON.stringify(song),{candidates}=await resolveSoundImport([file('harp.ogg')]);
  const huge={...candidates[0],file:{...candidates[0].file,size:32*1024*1024+1,arrayBuffer:async()=>{throw new Error('must not read');}}};await assert.rejects(stageSoundImport(song,new Map(),[huge],{decode:async()=>pcm(0)}),/32 MiB/);
  await assert.rejects(stageSoundImport(song,new Map(),candidates,{decode:async()=>({...pcm(0),length:32*1024*1024+1})}),/PCM/);assert.equal(JSON.stringify(song),before);
  const full={...song,customInstruments:Array.from({length:240},()=>song.customInstruments[0])};await assert.rejects(stageSoundImport(full,new Map(),candidates,{decode:async()=>{throw new Error('must not decode');}}),/240/);
});
