import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTranscription,appendTranscription,createTranscriptionNoteAccumulator} from '../js/transcription-mapping.js';
import {MIDI_PROGRAM_DEFAULTS,MIDI_PERCUSSION_DEFAULTS,parseMIDI} from '../js/formats.js';
import {createBlankSong,History,MAX_LAYERS,MAX_NOTES} from '../js/model.js';

const fixture=()=>({...createBlankSong(),tempo:8,layers:[{id:0,name:'Keep',reverb:75,muted:false,solo:false,locked:true}],notes:[{id:'old',tick:2,layer:0,key:50,instrument:0,velocity:88,pan:-20,pitch:0}]});
const raw=(midiKey=60,startSeconds=0,extra={})=>({midiKey,startSeconds,endSeconds:startSeconds+.5,...extra});
const projectShape=song=>structuredClone(song);
const previewShape=preview=>preview.notes.map(({tick,layer,key,instrument,velocity,pan,duration})=>({tick,layer,key,instrument,velocity,pan,duration}));

function midiFromRows(rows){
  const vlq=value=>{const result=[value&127];while((value>>>=7))result.unshift((value&127)|128);return result;};
  const word=value=>[value>>>8&255,value&255],dword=value=>[value>>>24&255,value>>>16&255,value>>>8&255,value&255];
  const groups=new Map();for(const note of rows){const group=note.track??0;if(!groups.has(group))groups.set(group,[]);groups.get(group).push(note);}
  const tracks=[...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([index,notes])=>{
    const events=[{tick:0,order:-3,bytes:[255,81,3,7,161,32]}];
    for(const [order,note]of notes.entries()){
      const channel=note.channel??(note.isDrum?9:0),start=Math.round(note.startSeconds*960),end=Math.round(note.endSeconds*960);
      events.push({tick:start,order:order*3-2,bytes:[192|channel,note.program??0]},{tick:start,order:order*3,bytes:[144|channel,note.midiKey,note.velocity??127]},{tick:end,order:order*3-1,bytes:[128|channel,note.midiKey,0]});
    }
    events.sort((a,b)=>a.tick-b.tick||a.order-b.order);let previous=0;const bytes=[];
    for(const event of events){bytes.push(...vlq(event.tick-previous),...event.bytes);previous=event.tick;}bytes.push(0,255,47,0);
    return [77,84,114,107,...dword(bytes.length),...bytes];
  });
  return Uint8Array.from([77,84,104,100,0,0,0,6,...word(tracks.length>1?1:0),...word(tracks.length),1,224,...tracks.flat()]);
}

test('preview has no side effects and appends below the live final track in one undo step',()=>{
  const song=fixture(),original=projectShape(song),history=new History(),p=prepareTranscription([raw()],{song,insertTick:12});
  assert.deepEqual(song,original);assert(Object.isFrozen(p)&&Object.isFrozen(p.notes)&&Object.isFrozen(p.notes[0]));
  song.layers.push({id:1,name:'Concurrent edit',volume:40});song.notes.push({id:'concurrent',tick:99,layer:1,key:45,instrument:1});
  const beforeAppend=projectShape(song);let checkpoints=0;
  const result=appendTranscription(song,p,()=>{checkpoints++;history.push(song);});
  assert.equal(checkpoints,1);assert.equal(result.changed,true);assert.equal(result.layer,2);assert.equal(song.tempo,8);
  assert.equal(song.layers[0].reverb,75);assert.equal(song.notes[0].id,'old');assert.equal(song.notes[1].id,'concurrent');
  assert.equal(song.notes[2].layer,2);assert.equal(song.notes[2].tick,12);assert.equal(result.selectedIds[0],song.notes[2].id);
  assert.notEqual(song.notes[2].id,'old');assert.deepEqual(history.undo(song),beforeAppend);
  assert.throws(()=>appendTranscription(song,p),/已经插入/);
});

test('same-tick chords allocate distinct lanes and reuse them at later onsets',()=>{
  const song=fixture(),p=prepareTranscription([raw(64,0),raw(60,0),raw(67,.01),raw(62,1),raw(66,1)],{song});
  assert.deepEqual(p.notes.map(n=>[n.tick,n.layer]),[[0,0],[0,1],[0,2],[8,0],[8,1]]);
  assert.equal(p.layers.length,3);assert.equal(new Set(p.notes.map(n=>`${n.tick}:${n.layer}`)).size,p.notes.length);
  assert(p.layers.every(layer=>layer.reverb===0&&!layer.locked&&!layer.muted&&!layer.solo));
});

test('mapping matches real MIDI import for melodic programs, drums, chords and durations',()=>{
  const song=fixture(),rows=[raw(60,0,{track:0,program:0,velocity:80}),raw(64,0,{track:0,program:0}),raw(67,1,{track:0,program:0}),raw(48,0,{track:1,program:32}),raw(72,1,{track:2,program:73}),raw(36,.5,{track:3,isDrum:true})];
  const options={targetTempo:8,removeSilent:false,programMap:MIDI_PROGRAM_DEFAULTS,percussionMap:{38:{instrument:14,key:30}}};
  const expected=parseMIDI(midiFromRows(rows),options),p=prepareTranscription(rows,{song,options});
  assert.deepEqual(previewShape(p),previewShape(expected));
});

test('automatic melodic fallback remains identical to existing MIDI importer',()=>{
  const song=fixture(),rows=[0,1,7,8,13,24,27,32,39,40,73,79,80,105,116,127].map((program,index)=>raw(60,index*.5,{program,track:index}));
  const p=prepareTranscription(rows,{song}),expected=parseMIDI(midiFromRows(rows),{targetTempo:8});
  assert.deepEqual(previewShape(p),previewShape(expected));
});

test('source arrays are not reordered and explicit tracks follow MIDI lane ordering',()=>{
  const song=fixture(),rows=[raw(72,1,{track:2}),raw(60,0,{track:1}),raw(64,0,{track:0})],copy=structuredClone(rows);
  const p=prepareTranscription(rows,{song});assert.deepEqual(rows,copy);assert.deepEqual(p.notes.map(n=>n.key),[43,39,51]);
});

test('native drum keys, channel overrides and octave offsets match MIDI mapping rules',()=>{
  const song=fixture(),p=prepareTranscription([raw(36,0,{isDrum:true}),raw(38,.5,{isDrum:true}),raw(60,1,{program:32,channel:2})],{song,options:{octaveOffset:1,channelMap:{9:{instrument:7,octave:-1},2:{instrument:15,octave:-2}},programMap:{32:{instrument:1,octave:3}},percussionMap:{38:{instrument:3,key:45}}}});
  assert.deepEqual(p.notes.map(n=>[n.instrument,n.key]),[[7,MIDI_PERCUSSION_DEFAULTS[36].key],[7,45],[15,27]]);
});

test('skipped mappings, out-of-range pitches and percussion fallback are reported, never clamped silently',()=>{
  const song=fixture(),p=prepareTranscription([raw(0),raw(127,.5),raw(60,1,{program:73}),raw(1,1.5,{isDrum:true})],{song,options:{programMap:{73:-1}}});
  assert.deepEqual(p.counts,{input:4,notes:1,layers:1,skippedOutOfRange:2,skippedMapped:1,percussionFallbacks:1,openNotes:0,rawExactDuplicates:0,mappedCollisions:0,duplicateTargetsRemoved:0});
  assert.equal(p.notes[0].instrument,4);assert.equal(p.notes[0].key,45);assert.equal(p.warnings.length,3);
  const folded=prepareTranscription([raw(0),raw(127,.5)],{song,options:{keepWithinOctaveRange:true}});assert.equal(folded.notes.length,2);assert(folded.notes.every(n=>n.key>=33&&n.key<=57));
});

test('current tempo controls determine insertion and duration without modifying project speed',()=>{
  const song=fixture();song.tempo=10;song.customInstruments=[{name:'Tempo Changer',file:'',key:45}];
  song.layers[0].locked=false;song.notes=[{id:'tempo',tick:10,layer:0,instrument:16,pitch:300}];
  const p=prepareTranscription([raw(60,0,{endSeconds:.5}),raw(62,1,{endSeconds:1.5})],{song,insertTick:5});
  assert.deepEqual(p.notes.map(n=>[n.tick,n.duration]),[[5,5],[20,10]]);assert.equal(song.tempo,10);
  appendTranscription(song,p);assert.equal(song.tempo,10);assert.equal(song.notes[0].pitch,300);
});

test('leading silence uses first retained note and integer quantization never changes tempo',()=>{
  const song=fixture(),p=prepareTranscription([raw(0,0),raw(60,2),raw(62,2.2)],{song,insertTick:7,options:{removeSilent:true,gridSubdivision:4}});
  assert.equal(p.leadingSilenceSecondsRemoved,2);assert.deepEqual(p.notes.map(n=>n.tick),[7,9]);assert(p.warnings.some(w=>w.includes('整数 tick')));
  appendTranscription(song,p);assert.equal(song.tempo,8);
});

test('stale project, changed tempo controls and changed custom-bank identity reject before history',()=>{
  let checkpoints=0;const song=fixture(),p=prepareTranscription([raw()],{song});
  assert.throws(()=>appendTranscription(structuredClone(song),p,()=>checkpoints++),/工程已改变/);
  song.tempo=9;assert.throws(()=>appendTranscription(song,p,()=>checkpoints++),/速度/);song.tempo=8;
  song.customInstruments.push({name:'changed',file:'new.wav',key:45});assert.throws(()=>appendTranscription(song,p,()=>checkpoints++),/自定义音色/);
  assert.equal(checkpoints,0);assert.equal(song.notes.length,1);
});

test('changing active Tempo Changer state invalidates a prepared position',()=>{
  const song=fixture();song.customInstruments=[{name:'Tempo Changer',file:'',key:45}];song.notes.push({tick:8,layer:0,instrument:16,pitch:300});
  const p=prepareTranscription([raw()],{song,insertTick:10});song.layers[0].muted=true;
  assert.throws(()=>appendTranscription(song,p),/速度/);
});

test('capacity failures and aborted history leave the live song untouched',()=>{
  const song=fixture(),p=prepareTranscription([raw()],{song}),original=projectShape(song);let count=0;
  song.layers=new Array(MAX_LAYERS).fill(song.layers[0]);assert.throws(()=>appendTranscription(song,p,()=>count++),/容量/);song.layers=structuredClone(original.layers);
  song.notes=new Array(MAX_NOTES).fill(song.notes[0]);assert.throws(()=>appendTranscription(song,p,()=>count++),/容量/);song.notes=structuredClone(original.notes);
  assert.throws(()=>appendTranscription(song,p,()=>{throw new Error('history aborted');}),/history aborted/);assert.deepEqual(song,original);assert.equal(count,0);
  assert.equal(appendTranscription(song,p).changed,true);
});

test('empty or fully ignored transcription creates no track and no undo step',()=>{
  const song=fixture(),p=prepareTranscription([raw(60,0,{program:0})],{song,options:{programMap:{0:-1}}}),original=projectShape(song);let count=0;
  const result=appendTranscription(song,p,()=>count++);assert.equal(result.changed,false);assert.equal(count,0);assert.deepEqual(song,original);
});

test('new notes have globally unique IDs and never replace a pre-existing occupied cell',()=>{
  const song=fixture(),p=prepareTranscription([raw(60,.25),raw(64,.25)],{song});const old=song.notes[0];
  appendTranscription(song,p);assert.equal(song.notes[0],old);assert.equal(song.notes[0].tick,2);
  assert.deepEqual(song.notes.slice(1).map(n=>n.layer),[1,2]);assert.equal(new Set(song.notes.map(n=>n.id)).size,3);
});

test('invalid input, mappings and control instruments reject atomically',()=>{
  const song=fixture(),original=projectShape(song);
  for(const rows of [[raw(128)],[raw(60,-1)],[raw(60,1,{endSeconds:.5})],[raw(60,0,{velocity:128})],[raw(60,0,{program:128})]])assert.throws(()=>prepareTranscription(rows,{song}));
  for(const options of [{programMap:{0:16}},{programMap:{128:0}},{channelMap:{16:0}},{percussionMap:{36:{instrument:0,key:88}}},{keepVelocity:1},{gridSubdivision:0}])assert.throws(()=>prepareTranscription([raw()],{song,options}));
  song.customInstruments=[{name:'Tempo Changer',file:'',key:45}];assert.throws(()=>prepareTranscription([raw()],{song,options:{programMap:{0:16}}}),/控制音色/);song.customInstruments=[];
  assert.deepEqual(song,original);
});

test('project timeline and layer ceilings do not truncate the transcription',()=>{
  const song=fixture();assert.throws(()=>prepareTranscription([raw(60,1000000)],{song}),/时间轴/);
  assert.throws(()=>prepareTranscription([raw(60,0),raw(64,0)],{song,options:{maxLayers:1}}),/音轨/);
  assert.throws(()=>prepareTranscription([raw(60,0,{endSeconds:200000})],{song}),/结束时间/);
  assert.throws(()=>prepareTranscription([raw()],{song,insertTick:1000000}),/插入位置/);
});

test('incremental events preserve held notes and close re-entry without duplicating drum note-offs',()=>{
  const sink=createTranscriptionNoteAccumulator();
  sink.push({type:'note_start',program:0,pitch:60,time:0});sink.push({type:'note_start',program:0,pitch:64,time:.1});
  sink.push({type:'note_start',program:0,pitch:60,time:.5});sink.push({type:'note_end',program:0,pitch:64,time:.75});
  sink.push({type:'note_start',program:0,pitch:36,time:1,isDrum:true});
  assert.equal(sink.push({type:'note_end',program:0,pitch:36,time:1.1,isDrum:true}),null);
  const rows=sink.snapshot();assert.equal(sink.size,4);assert.equal(sink.openCount,1);
  assert.equal(rows[0].endSeconds,.5);assert.equal(rows[1].endSeconds,.75);assert.equal(rows[2].endSeconds,undefined);assert.equal(rows[3].endSeconds,1);
  const closed=sink.snapshot({endSeconds:2,closeOpen:true});assert.equal(closed[2].endSeconds,2);assert.equal(sink.openCount,1,'preview closing is not a mutation');
  closed[0].startSeconds=99;assert.equal(sink.snapshot()[0].startSeconds,0);
});

test('incremental full notes, progress and cancellation reset are bounded and safe',()=>{
  const sink=createTranscriptionNoteAccumulator({maxNotes:2});assert.equal(sink.push({type:'progress',completed:1}),null);
  sink.push({type:'note',program:73,midiKey:72,startSeconds:0,endSeconds:1,velocity:80});sink.push({type:'note_on',program:73,pitch:74,time:1});
  const previous=sink.snapshot();assert.throws(()=>sink.push({type:'note_on',program:73,pitch:76,time:2}),/上限/);assert.deepEqual(sink.snapshot(),previous);
  assert.throws(()=>sink.push({type:'note_off',program:73,pitch:74,time:.5}),/早于/);assert.deepEqual(sink.snapshot(),previous);
  assert.throws(()=>sink.push({type:'unknown',program:73,pitch:74,time:2}),/未知/);
  sink.clear();assert.equal(sink.size,0);assert.equal(sink.openCount,0);assert.deepEqual(sink.snapshot(),[]);
});

test('incomplete and drum previews use one tick while omitted velocity is full strength',()=>{
  const song=fixture(),p=prepareTranscription([{midiKey:60,startSeconds:0},{midiKey:36,startSeconds:.5,isDrum:true}],{song});
  assert.equal(p.counts.openNotes,1);assert.deepEqual(p.notes.map(n=>[n.velocity,n.duration]),[[100,1],[100,1]]);
});

test('thousands of identical generated drum hits produce one mapped onset and one new lane without changing raw recognition',()=>{
  const song=fixture(),rows=Array.from({length:1700},(_,index)=>raw(44,.82,{id:`model-${index}`,isDrum:true,endSeconds:.83})),original=structuredClone(rows);
  const p=prepareTranscription(rows,{song,options:{maxLayers:1}});
  assert.deepEqual(rows,original);assert.equal(p.notes.length,1);assert.equal(p.layers.length,1);
  assert.equal(p.counts.rawExactDuplicates,1699);assert.equal(p.counts.mappedCollisions,0);assert.equal(p.counts.duplicateTargetsRemoved,1699);
  assert(p.warnings.some(value=>value.includes('模型重复/量化重合')&&value.includes('原始 1700 → 落谱 1')&&value.includes('避免新增重复音轨')&&value.includes('评分未修改')));
  assert(Object.isFrozen(p.diagnostics));assert.equal(p.diagnostics.rawRecognitionUnchanged,true);assert.equal(p.diagnostics.retentionPolicy,'last mapped occurrence');
  let history=0;const result=appendTranscription(song,p,()=>history++);assert.equal(history,1);assert.equal(song.layers.length,2);assert.equal(result.diagnostics,p.diagnostics);assert.deepEqual(rows,original);
});

test('different times or raw drum pitches mapping onto one target report additional collisions and retain the last occurrence',()=>{
  const song=fixture(),rows=[raw(60,.01,{velocity:127}),raw(60,.02,{velocity:64}),raw(36,1,{isDrum:true}),raw(38,1,{isDrum:true})];
  const p=prepareTranscription(rows,{song,options:{percussionMap:{36:{instrument:2,key:45},38:{instrument:2,key:45}}}});
  assert.equal(p.notes.length,2);assert.equal(p.layers.length,2);assert.equal(p.notes[0].velocity,50);
  assert.equal(p.counts.rawExactDuplicates,0);assert.equal(p.counts.mappedCollisions,2);assert.equal(p.counts.duplicateTargetsRemoved,2);
});

test('deduplication preserves distinct programs, NBS instruments, musical pitches and fine pitches',()=>{
  const song=fixture(),rows=[raw(60,0,{program:0}),raw(60,0,{program:2}),raw(64,0,{program:0}),raw(60,0,{program:0,pitch:25}),raw(60,0,{program:0,channel:1}),raw(36,0,{isDrum:true}),raw(38,0,{isDrum:true})];
  const p=prepareTranscription(rows,{song,options:{channelMap:{1:{instrument:15}},percussionMap:{36:{instrument:2,key:45},38:{instrument:3,key:45}}}});
  assert.equal(p.notes.length,rows.length);assert.equal(p.counts.duplicateTargetsRemoved,0);assert.equal(p.counts.mappedCollisions,0);
  assert(p.notes.some(note=>note.pitch===25));assert.equal(p.notes.filter(note=>note.key===39&&note.instrument===0&&note.pitch===0).length,2,'different GM programs remain separate despite the same NBS mapping');
  assert.equal(new Set(p.notes.map(note=>`${note.tick}/${note.layer}`)).size,rows.length);
});

test('raw-exact duplicates and distinct quantized collisions are counted separately within the same target',()=>{
  const song=fixture(),a=raw(60,.01),b=raw(60,.02),rows=[a,{...a},b,{...b}];
  const p=prepareTranscription(rows,{song});assert.equal(p.notes.length,1);assert.equal(p.counts.rawExactDuplicates,2);assert.equal(p.counts.mappedCollisions,1);assert.equal(p.counts.duplicateTargetsRemoved,3);
  assert.equal(p.diagnostics.rawInputNotes,4);assert.equal(p.diagnostics.mappedInputNotes,4);assert.equal(p.diagnostics.outputNotes,1);
  assert.throws(()=>prepareTranscription([raw(60,0,{pitch:Infinity})],{song}),/微调/);
});
