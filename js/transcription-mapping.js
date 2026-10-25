/** Browser transcription -> immutable preview -> one atomic, undoable NBS append.
 * Input times are seconds relative to the recording/file. No existing tempo or
 * layer is changed; conversion uses the destination song's real tempo map.
 */
import {MAX_LAYERS,MAX_NOTES,uniqueId} from './model.js';
import {MIDI_PERCUSSION_DEFAULTS,MIDI_PROGRAM_NAMES} from './formats.js';
import {createTempoMap,secondsAtTick,tickAtSeconds,controlType} from './tempo-map.js';

const MAX_TICKS=1000000;
const preparedContexts=new WeakMap();
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const finite=(value,name,min,max)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${name} 必须为 ${min}–${max} 范围内的有限数值。`);return value;};
const integer=(value,name,min,max)=>{finite(value,name,min,max);if(!Number.isInteger(value))throw new Error(`${name} 必须是整数。`);return value;};
const bool=(value,fallback,name)=>{if(value===undefined)return fallback;if(typeof value!=='boolean')throw new Error(`${name} 必须是布尔值。`);return value;};
const defaultLayer=(id,name)=>({id,name,volume:100,pan:0,reverb:0,muted:false,solo:false,locked:false});
const customSignature=song=>JSON.stringify((song.customInstruments||[]).map(item=>[item.name,item.file,item.key,!!item.pressKey]));
const tempoSignature=(song,map)=>`${song.tempo}|${map?.signature||''}`;

// Matches formats.js automatic General MIDI mapping. Explicit native/user maps
// supplied by the existing MIDI preferences override this compatibility path.
function programInstrument(program){
  const exact=[0,32,116,117,115,27,73,9,112,13,11,113,109,80,105,1].indexOf(program);
  if(exact>=0)return exact;
  if(program>=32&&program<=39)return 1;if(program>=24&&program<=31)return 5;
  if(program>=72&&program<=79)return 6;if(program>=8&&program<=15)return 7;
  if(program>=80&&program<=103)return 13;return 0;
}
function validateSong(song){
  if(!object(song)||!Array.isArray(song.layers)||!Array.isArray(song.notes))throw new Error('当前转录目标工程无效。');
  if(song.layers.length<1||song.layers.length>MAX_LAYERS||song.notes.length>MAX_NOTES)throw new Error('当前工程超过音轨或音符上限。');
  finite(song.tempo,'当前工程速度',.05,655.35);
  if(song.length!==undefined)integer(song.length,'当前工程长度',1,MAX_TICKS);
  if(song.customInstruments!==undefined&&!Array.isArray(song.customInstruments))throw new Error('当前自定义音色列表无效。');
}
function normalizeOptions(options,song){
  if(!object(options))throw new Error('转录映射选项必须是对象。');
  const maxInstrument=15+(song.customInstruments?.length||0);
  const map=(name,maxIndex,percussion=false)=>{
    const source=options[name]??{};
    if(!object(source)||Object.keys(source).length>maxIndex+1)throw new Error(`${name} 映射无效。`);
    const result={};
    for(const [index,value]of Object.entries(source)){
      if(!/^(0|[1-9]\d*)$/.test(index)||Number(index)>maxIndex)throw new Error(`${name} 映射编号无效。`);
      const entry=typeof value==='number'?{instrument:value}:value;
      if(!object(entry))throw new Error(`${name} 映射值无效。`);
      const instrument=integer(entry.instrument,`${name} 音色`,-1,maxInstrument),mapped={instrument};
      if(instrument>=0&&controlType({instrument},song))throw new Error('转录音符不能映射到 Tempo Changer 或 Toggle Rainbow 控制音色。');
      if(percussion&&entry.key!==undefined)mapped.key=integer(entry.key,`${name} 音高`,0,87);
      if(!percussion&&entry.octave!==undefined)mapped.octave=integer(entry.octave,`${name} 八度`,-8,8);
      result[index]=Object.freeze(mapped);
    }
    return Object.freeze(result);
  };
  const namingMode=options.namingMode??'patch';if(!['patch','track','channel'].includes(namingMode))throw new Error('转录轨道命名模式无效。');
  const gridSubdivision=integer(options.gridSubdivision??1,'网格精度',1,16);
  return Object.freeze({programMap:map('programMap',127),percussionMap:map('percussionMap',127,true),channelMap:map('channelMap',15),
    octaveOffset:integer(options.octaveOffset??0,'整体八度偏移',-8,8),
    maxLayers:integer(options.maxLayers??MAX_LAYERS,'新增音轨上限',1,MAX_LAYERS),namingMode,
    keepVelocity:bool(options.keepVelocity,true,'保留力度'),keepPan:bool(options.keepPan,true,'保留声像'),
    keepWithinOctaveRange:bool(options.keepWithinOctaveRange,false,'折叠音域'),removeSilent:bool(options.removeSilent,false,'移除开头空白'),
    trackNames:bool(options.trackNames,true,'保留轨道名称'),gridSubdivision});
}

/**
 * rawNotes: {startSeconds,endSeconds?,midiKey,program?,isDrum?,channel?,track?,velocity?,pan?}[]
 * velocity is MIDI 0..127; omission means full velocity (100% in the editor).
 * gridSubdivision is retained from MIDI preferences, but never changes an open
 * project's tempo: this editor has integer ticks, so sub-tick results are rounded.
 */
export function prepareTranscription(rawNotes,{song,insertTick=0,options={},sourceName='音频转录'}={}){
  validateSong(song);if(!Array.isArray(rawNotes)||rawNotes.length>MAX_NOTES)throw new Error(`转录最多支持 ${MAX_NOTES} 个音符。`);
  integer(insertTick,'插入位置',0,MAX_TICKS-1);
  const settings=normalizeOptions(options,song),map=createTempoMap(song),origin=secondsAtTick(insertTick,map,song.tempo);
  const counts={input:rawNotes.length,notes:0,layers:0,skippedOutOfRange:0,skippedMapped:0,percussionFallbacks:0,openNotes:0,rawExactDuplicates:0,mappedCollisions:0,duplicateTargetsRemoved:0};
  const input=rawNotes.map((raw,order)=>{
    if(!object(raw))throw new Error(`第 ${order+1} 个转录音符无效。`);
    const startSeconds=finite(raw.startSeconds,'音符起始时间',0,Number.MAX_SAFE_INTEGER);
    let endSeconds=raw.endSeconds===undefined?undefined:finite(raw.endSeconds,'音符结束时间',startSeconds,Number.MAX_SAFE_INTEGER);
    const program=integer(raw.program??0,'MIDI 音色编号',0,127),midiKey=integer(raw.midiKey,'MIDI 音高',0,127);
    const channel=integer(raw.channel??(raw.isDrum?9:0),'MIDI 通道',0,15),isDrum=bool(raw.isDrum,false,'打击乐标记')||channel===9;
    if(isDrum&&endSeconds===undefined)endSeconds=startSeconds;
    const track=raw.track===undefined?undefined:integer(raw.track,'来源轨道',0,MAX_LAYERS-1);
    return {startSeconds,endSeconds,program,midiKey,channel,isDrum,track,order,
      velocity:finite(raw.velocity??127,'MIDI 力度',0,127),pan:finite(raw.pan??0,'音符声像',-100,100),
      pitch:finite(raw.pitch??0,'音符微调',-32768,32767),
      trackName:typeof raw.trackName==='string'?raw.trackName.slice(0,1024):null};
  }).sort((a,b)=>a.startSeconds-b.startSeconds||(a.track??0)-(b.track??0)||a.order-b.order);
  const rawSeen=new Set();
  for(const note of input){
    // IDs and display names do not change an onset's musical identity. Keep the
    // source array intact; these normalized records belong only to this preview.
    note.rawSignature=JSON.stringify([note.program,note.isDrum,note.midiKey,note.pitch,note.startSeconds,note.endSeconds,note.channel,note.track,note.velocity,note.pan]);
    if(rawSeen.has(note.rawSignature))counts.rawExactDuplicates++;else rawSeen.add(note.rawSignature);
  }
  const mapped=[];
  for(const note of input){
    let instrument=programInstrument(note.program),key=note.midiKey-21,octave=0;
    if(note.isDrum){
      const native=MIDI_PERCUSSION_DEFAULTS[note.midiKey],explicit=settings.percussionMap[note.midiKey];
      if(!native&&!explicit)counts.percussionFallbacks++;
      const selection=explicit??native??{instrument:4,key:45};instrument=selection.instrument;key=selection.key??native?.key??45;
    }else{
      const selection=settings.programMap[note.program];if(selection){instrument=selection.instrument;octave=selection.octave||0;}
    }
    const channel=settings.channelMap[note.channel];if(channel){instrument=channel.instrument;octave=channel.octave||0;}
    if(instrument===-1){counts.skippedMapped++;continue;}
    key+=(settings.octaveOffset+octave)*12;
    if(settings.keepWithinOctaveRange){while(key<33)key+=12;while(key>57)key-=12;}
    if(key<0||key>87){counts.skippedOutOfRange++;continue;}
    mapped.push({...note,key,instrument});
  }
  const leadingSilence=settings.removeSilent&&mapped.length?mapped[0].startSeconds:0,notes=[],layers=[],groups=new Map();
  const prefix=String(sourceName||'音频转录').slice(0,200);
  const targets=new Map();
  for(const note of mapped){
    const start=origin+note.startSeconds-leadingSilence,position=tickAtSeconds(start,map,song.tempo),tick=Math.round(position);
    if(!Number.isSafeInteger(tick)||tick<0||tick>=MAX_TICKS)throw new Error('转录后的时间轴超过 1,000,000 tick；请选择更早的插入位置或缩短音频。');
    let duration=1;
    if(note.endSeconds!==undefined){
      const end=tickAtSeconds(origin+note.endSeconds-leadingSilence,map,song.tempo);
      if(!Number.isFinite(end)||end>MAX_TICKS)throw new Error('转录音符结束时间超过工程时间轴上限。');
      duration=Math.max(1,Math.round(end-position));
    }
    // Repeated model hits and distinct source times that map onto the same NBS
    // onset must not become thousands of artificial chord lanes. Program,
    // drum/melodic identity, mapped instrument/key and fine pitch stay distinct.
    const key=JSON.stringify([note.program,note.isDrum,note.instrument,note.key,note.pitch,tick]),target=targets.get(key);
    if(target){
      counts.duplicateTargetsRemoved++;
      if(!target.rawSignatures.has(note.rawSignature))counts.mappedCollisions++;
      target.rawSignatures.add(note.rawSignature);target.note={...note,tick,duration};
    }else targets.set(key,{note:{...note,tick,duration},rawSignatures:new Set([note.rawSignature])});
  }
  for(const {note}of targets.values()){
    const {tick,duration}=note;
    // Generated MIDI has one track per program/drum group. Explicit track/channel
    // input preserves the same grouping as parseMIDI; same-tick chords get lanes.
    const groupKey=note.track===undefined?`${note.isDrum?'drum':'program'}:${note.program}/${note.channel}`:`track:${note.track}/${note.channel}`;
    let group=groups.get(groupKey);if(!group){group={lanes:[],tick:-1,next:0};groups.set(groupKey,group);}
    if(group.tick!==tick){group.tick=tick;group.next=0;}
    let lane=group.lanes[group.next++];
    if(lane===undefined){
      lane=layers.length;if(lane>=settings.maxLayers||song.layers.length+lane>=MAX_LAYERS)throw new Error('转录需要的新增音轨超过工程或导入设置上限；没有丢弃任何和弦。');
      group.lanes.push(lane);
      const label=!settings.trackNames?'音轨':settings.namingMode==='channel'?`Channel ${note.channel+1}`:settings.namingMode==='track'&&note.trackName?note.trackName:note.isDrum?'Percussion':MIDI_PROGRAM_NAMES[note.program];
      layers.push(Object.freeze(defaultLayer(lane,`${prefix} · ${label}${group.lanes.length>1?` · ${group.lanes.length}`:''}`.slice(0,1024))));
    }
    if(note.endSeconds===undefined)counts.openNotes++;
    notes.push(Object.freeze({tick,layer:lane,key:note.key,instrument:note.instrument,velocity:settings.keepVelocity?Math.round(note.velocity/127*100):100,pan:settings.keepPan?note.pan:0,pitch:note.pitch,duration}));
  }
  if(song.notes.length+notes.length>MAX_NOTES)throw new Error(`追加转录后将超过 ${MAX_NOTES} 个音符上限。`);
  counts.notes=notes.length;counts.layers=layers.length;
  const warnings=[];
  if(counts.skippedOutOfRange)warnings.push(`${counts.skippedOutOfRange} 个音符超出音符盒支持的音域，已跳过。`);
  if(counts.skippedMapped)warnings.push(`${counts.skippedMapped} 个音符按导入映射忽略。`);
  if(counts.percussionFallbacks)warnings.push(`${counts.percussionFallbacks} 个打击乐音高使用默认击棒映射。`);
  if(counts.openNotes)warnings.push(`${counts.openNotes} 个音符尚未结束，预览暂用 1 tick 时值。`);
  if(counts.duplicateTargetsRemoved)warnings.push(`检测到模型重复/量化重合，原始 ${counts.input} → 落谱 ${counts.notes} 个音符，避免新增重复音轨（原始完全重复 ${counts.rawExactDuplicates}，映射/量化重合 ${counts.mappedCollisions}）。原始识别与评分未修改。`);
  if(settings.gridSubdivision!==1)warnings.push('追加时保留当前工程速度，音符按现有整数 tick 网格量化。');
  const diagnostics=Object.freeze({rawInputNotes:rawNotes.length,mappedInputNotes:mapped.length,outputNotes:notes.length,rawExactDuplicates:counts.rawExactDuplicates,mappedCollisions:counts.mappedCollisions,duplicateTargetsRemoved:counts.duplicateTargetsRemoved,retentionPolicy:'last mapped occurrence',rawRecognitionUnchanged:true});
  const prepared=Object.freeze({insertTick,sourceName:prefix,notes:Object.freeze(notes),layers:Object.freeze(layers),counts:Object.freeze(counts),warnings:Object.freeze(warnings),diagnostics,leadingSilenceSecondsRemoved:leadingSilence});
  preparedContexts.set(prepared,{song,tempo:tempoSignature(song,map),custom:customSignature(song),consumed:false});
  return prepared;
}

/** Existing edits are preserved. New layers are attached below the live last row. */
export function appendTranscription(song,prepared,beforeChange=()=>{}){
  const context=preparedContexts.get(prepared);
  if(!context||context.song!==song)throw new Error('转录目标工程已改变，请重新选择当前工程中的插入位置。');
  if(context.consumed)throw new Error('这份转录结果已经插入，请勿重复提交。');
  validateSong(song);
  if(context.tempo!==tempoSignature(song,createTempoMap(song)))throw new Error('当前工程的速度或变速控制已改变，请重新生成落谱预览。');
  if(context.custom!==customSignature(song))throw new Error('当前自定义音色列表已改变，请重新确认转录音色映射。');
  if(song.layers.length+prepared.layers.length>MAX_LAYERS||song.notes.length+prepared.notes.length>MAX_NOTES)throw new Error('编辑后的工程已没有足够容量追加这份转录。');
  if(typeof beforeChange!=='function')throw new TypeError('beforeChange 必须是函数。');
  if(!prepared.notes.length)return {changed:false,selectedIds:[],layer:song.layers.length-1,counts:prepared.counts,warnings:prepared.warnings,diagnostics:prepared.diagnostics};
  const base=song.layers.length,used=new Set(song.notes.map(note=>note.id)),newLayers=prepared.layers.map((layer,index)=>({...layer,id:base+index}));
  const added=prepared.notes.map(note=>{let id;do{id=uniqueId();}while(used.has(id));used.add(id);return {...note,id,layer:base+note.layer};});
  const layers=song.layers.concat(newLayers),notes=song.notes.concat(added),length=Math.max(1,song.length||1),selectedIds=added.map(note=>note.id);
  let nextLength=length;for(const note of added)nextLength=Math.max(nextLength,note.tick+1);
  // No allocation or validation that can fail is left after the history callback.
  beforeChange();song.layers=layers;song.notes=notes;song.length=nextLength;context.consumed=true;
  return {changed:true,selectedIds,layer:base,counts:prepared.counts,warnings:prepared.warnings,diagnostics:prepared.diagnostics};
}

/** Incremental decoder sink. Same-pitch re-entry closes the prior voice, matching
 * MuScriptor's one active note per program/pitch representation. */
export function createTranscriptionNoteAccumulator({maxNotes=MAX_NOTES}={}){
  integer(maxNotes,'转录音符容量',1,MAX_NOTES);
  const notes=[],active=new Map();let nextId=0,lastTime=0;
  const keyOf=(program,pitch,drum)=>`${drum?'d':'m'}:${program}:${pitch}`;
  function push(event){
    if(!object(event))throw new Error('转录音符事件无效。');
    const type=event.type;
    if(type==='progress'||type==='chunk'||type==='boundary')return null;
    const program=integer(event.program??0,'事件 MIDI 音色',0,127),pitch=integer(event.pitch??event.midiKey,'事件 MIDI 音高',0,127),drum=!!(event.isDrum??event.is_drum);
    const time=finite(event.time??event.startSeconds,'事件时间',0,Number.MAX_SAFE_INTEGER);
    const key=keyOf(program,pitch,drum);
    if(type==='note_end'||type==='noteEnd'||type==='note_off'){
      const note=active.get(key);if(!note)return null;
      if(time<note.startSeconds)throw new Error('转录音符结束事件早于开始时间。');note.endSeconds=time;active.delete(key);lastTime=Math.max(lastTime,time);return {...note};
    }
    if(!['note_start','noteStart','note_on','note'].includes(type))throw new Error('未知转录音符事件。');
    if(notes.length>=maxNotes)throw new Error(`转录音符达到 ${maxNotes} 个上限，请停止或缩短录音。`);
    const endSeconds=event.endSeconds===undefined?undefined:finite(event.endSeconds,'事件结束时间',time,Number.MAX_SAFE_INTEGER);
    const note={id:`transcribed-${++nextId}`,startSeconds:time,program,midiKey:pitch,isDrum:drum};
    if(event.velocity!==undefined)note.velocity=finite(event.velocity,'事件 MIDI 力度',0,127);
    if(event.channel!==undefined)note.channel=integer(event.channel,'事件通道',0,15);
    if(event.pan!==undefined)note.pan=finite(event.pan,'事件声像',-100,100);
    const previous=active.get(key);if(previous&&time<previous.startSeconds)throw new Error('同音高转录事件的时间倒退。');
    if(endSeconds!==undefined)note.endSeconds=endSeconds;else if(drum)note.endSeconds=time;
    if(previous){previous.endSeconds=time;active.delete(key);}if(note.endSeconds===undefined)active.set(key,note);
    notes.push(note);lastTime=Math.max(lastTime,time);return {...note};
  }
  return {push,get size(){return notes.length;},get openCount(){return active.size;},
    snapshot({endSeconds=lastTime,closeOpen=false}={}){finite(endSeconds,'预览结束时间',0,Number.MAX_SAFE_INTEGER);return notes.map(note=>({...note,...(closeOpen&&note.endSeconds===undefined?{endSeconds:Math.max(note.startSeconds,endSeconds)}:{})}));},
    clear(){notes.length=0;active.clear();nextId=0;lastTime=0;}};
}
