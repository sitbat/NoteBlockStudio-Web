import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackVisuals,pressesPiano} from '../js/playback-visuals.js';
import {transportConfig,EventTimeline} from '../js/dsp-protocol.js';

const layer=extra=>({volume:100,muted:false,solo:false,...extra});
const note=(tick,key=45,extra={})=>({id:`${tick}/${key}`,tick,key,layer:0,instrument:0,velocity:100,...extra});
const song=(notes,extra={})=>({tempo:10,length:8,loop:false,loopStart:0,loopCount:0,layers:[layer()],customInstruments:[],notes,...extra});
const sample=(visual,song,frame,options={})=>visual.sample({playing:true,frame,sampleRate:1000,transport:transportConfig(song,options,1000)});

test('sample returns reusable 88-key ages from the sample clock, never from future notes',()=>{
  const first=note(0),later=note(2,46),s=song([first,later]),visual=new PlaybackVisuals(s);
  const ages=sample(visual,s,0);assert.ok(ages instanceof Float64Array);assert.equal(ages.length,88);assert.equal(ages[45],0);assert.equal(ages[46],Infinity);assert.equal(visual.noteAge(later),Infinity);
  assert.equal(sample(visual,s,199),ages);assert.equal(ages[45],199);assert.equal(ages[46],Infinity);
  sample(visual,s,200);assert.equal(ages[46],0);assert.equal(visual.noteAge(later),0);assert.equal(visual.noteAge(first),200);
  sample(visual,s,1500);assert.equal(visual.noteAge(later),1300,'caller chooses its 300ms or 1s animation horizon');
});
test('fromTick excludes prior triggers and a startFrame re-anchor cannot reuse pre-seek highlights',()=>{
  const skipped=note(2),next=note(6,46),s=song([skipped,next]),visual=new PlaybackVisuals(s);
  sample(visual,s,250);assert.equal(visual.noteAge(skipped),50);
  sample(visual,s,1000,{fromTick:5,startFrame:1000});assert.equal(visual.noteAge(skipped),Infinity);assert.equal(visual.keyAges[45],Infinity);assert.equal(visual.noteAge(next),Infinity);
  sample(visual,s,1099,{fromTick:5,startFrame:1000});assert.equal(visual.noteAge(next),Infinity);
  sample(visual,s,1100,{fromTick:5,startFrame:1000});assert.equal(visual.noteAge(next),0);
});
test('loop wrap preserves the final notes glow while loopStart triggers on the new cycle',()=>{
  const before=note(1,43),start=note(4,44),tail=note(7,45),s=song([before,start,tail],{loop:true,loopStart:4}),visual=new PlaybackVisuals(s);
  sample(visual,s,800);assert.equal(visual.keyAges[45],100);assert.equal(visual.noteAge(tail),100);assert.equal(visual.keyAges[44],0);assert.equal(visual.noteAge(before),700);
  sample(visual,s,1100);assert.equal(visual.noteAge(tail),0);
  sample(visual,s,1200);assert.equal(visual.noteAge(tail),100);assert.equal(visual.noteAge(start),0);assert.equal(visual.noteAge(before),1100);
});
test('finite loops stop producing new onsets after exactly loopCount repetitions',()=>{
  const tail=note(7),s=song([tail],{loop:true,loopStart:4,loopCount:2}),visual=new PlaybackVisuals(s);
  const transport=transportConfig(s,{fromTick:6},1000);
  for(const [frame,age]of [[100,0],[200,100],[499,399],[500,0],[900,0],[1000,100],[1300,400]]){
    visual.sample({playing:true,frame,sampleRate:1000,transport});assert.equal(visual.noteAge(tail),age,`frame=${frame}`);assert.equal(visual.keyAges[45],age);
  }
});
test('an onset skipped by fromTick can first occur in a later loop',()=>{
  const middle=note(4),early=note(1,46),s=song([middle,early],{loop:true,loopStart:4,loopCount:1}),visual=new PlaybackVisuals(s);
  sample(visual,s,0,{fromTick:6});assert.equal(visual.noteAge(middle),Infinity);assert.equal(visual.noteAge(early),Infinity);
  sample(visual,s,200,{fromTick:6});assert.equal(visual.noteAge(middle),0);assert.equal(visual.noteAge(early),Infinity);
});
test('muted, zero-volume, nonsolo and zero-velocity notes never enter either visual index',()=>{
  const notes=Array.from({length:6},(_,id)=>note(0,40+id,{layer:id,velocity:id===4?0:100}));
  const s=song(notes,{layers:[layer({muted:true,solo:true}),layer({volume:0,solo:true}),layer(),layer({solo:true,locked:true}),layer({solo:true}),layer({solo:true})]});
  const visual=new PlaybackVisuals(s);sample(visual,s,0);
  for(const id of [0,1,2,4]){assert.equal(visual.noteAge(notes[id]),Infinity);assert.equal(visual.keyAges[40+id],Infinity);}
  for(const id of [3,5]){assert.equal(visual.noteAge(notes[id]),0);assert.equal(visual.keyAges[40+id],0);}
});
test('the original piano press table and custom flags have an explicit playerMode override',()=>{
  const s=song([],{customInstruments:[{pressKey:false},{pressKey:true}]});
  for(let instrument=0;instrument<16;instrument++)assert.equal(pressesPiano({instrument},s),![2,3,4].includes(instrument),`native ${instrument}`);
  assert.equal(pressesPiano({instrument:16},s),false);assert.equal(pressesPiano({instrument:17},s),true);
  assert.equal(pressesPiano({instrument:18},s),false);
  for(const instrument of [2,3,4,16,17])assert.equal(pressesPiano({instrument},s,{playerMode:true}),true);
});
test('drums and unpressed custom instruments animate their notes while their piano keys remain untouched',()=>{
  const drum=note(0,44,{instrument:2}),custom=note(0,45,{instrument:16}),s=song([drum,custom],{customInstruments:[{pressKey:false}]}),visual=new PlaybackVisuals(s);
  sample(visual,s,50);assert.equal(visual.noteAge(drum),50);assert.equal(visual.noteAge(custom),50);assert.equal(visual.keyAges[44],Infinity);assert.equal(visual.keyAges[45],Infinity);
  visual.rebuild(s,{playerMode:true});sample(visual,s,50);assert.equal(visual.keyAges[44],50);assert.equal(visual.keyAges[45],50);
});
test('pause, stop, clear, invalid snapshots and rebuild remove the previous playback view',()=>{
  const old=note(0),s=song([old]),visual=new PlaybackVisuals(s);
  for(const operation of [()=>visual.sample({playing:false,frame:10,sampleRate:1000,transport:transportConfig(s,{},1000)}),()=>visual.clear(),()=>visual.sample({playing:true,frame:NaN,sampleRate:1000,transport:{}}),()=>visual.sample({playing:true,frame:10,sampleRate:0,transport:{}})]){
    sample(visual,s,10);assert.equal(visual.noteAge(old),10);operation();assert.ok(visual.keyAges.every(age=>age===Infinity));assert.equal(visual.noteAge(old),Infinity);
  }
  const replacement=note(1,46),fresh=song([replacement]);visual.rebuild(fresh);assert.equal(visual.noteAge(old),Infinity);sample(visual,fresh,100);assert.equal(visual.keyAges[45],Infinity);assert.equal(visual.noteAge(old),Infinity);assert.equal(visual.noteAge(replacement),0);assert.equal(visual.noteAge({...replacement}),Infinity);
});
test('10,000 same-key same-tick notes deduplicate, and frame/note queries never reread layers or notes',()=>{
  let reads=0,blocked=false;
  const guarded=value=>new Proxy(value,{get(target,key,receiver){if(blocked)throw new Error(`unexpected per-frame song access: ${String(key)}`);reads++;return Reflect.get(target,key,receiver);}});
  const notes=Array.from({length:10000},(_,layer)=>guarded(note(4,45,{layer}))),s=song(guarded(notes),{layers:guarded(Array.from({length:10000},()=>guarded(layer())))});
  const visual=new PlaybackVisuals(s),transport=transportConfig({tempo:10,length:8,loop:false,notes:[]},{},1000),builtReads=reads;
  assert.equal(visual.keyTicks[45].length,1);assert.equal(visual.keyTicks.reduce((sum,ticks)=>sum+ticks.length,0),1);
  blocked=true;
  for(let frame=400;frame<500;frame++){visual.sample({playing:true,frame,sampleRate:1000,transport});assert.equal(visual.keyAges[45],frame-400);assert.equal(visual.noteAge(notes[9999]),frame-400);}
  assert.equal(reads,builtReads);
});
test('a frame searches each of the 88 key groups logarithmically rather than visiting its ticks',()=>{
  const notes=[];for(let key=0;key<88;key++)for(let tick=0;tick<100;tick++)notes.push(note(tick,key));
  const s=song(notes,{length:100}),visual=new PlaybackVisuals(s);let lookups=0;
  visual.keyTicks=visual.keyTicks.map(ticks=>new Proxy(ticks,{get(target,key){if(/^\d+$/.test(String(key)))lookups++;return Reflect.get(target,key,target);}}));
  sample(visual,s,5050);assert.ok(visual.keyAges.every(age=>age===50));
  assert.ok(lookups<=88*(Math.ceil(Math.log2(101))+2),`only one binary search plus two candidate reads per key: ${lookups}`);
});
test('fractional frames and repeated cycles agree with the actual EventTimeline dispatch oracle',()=>{
  for(const options of [{tempo:123.45,fromTick:2.5,startFrame:47.25,loopStart:3,loopCount:7},{tempo:333.33,fromTick:0,startFrame:13,loopStart:7,loopCount:17},{tempo:30,fromTick:6,startFrame:0,loopStart:4,loopCount:2}]){
    const notes=Array.from({length:8},(_,tick)=>note(tick,40+tick%3)),s=song(notes,{tempo:options.tempo,loop:true,loopStart:options.loopStart,loopCount:options.loopCount}),transport=transportConfig(s,options,1000),timeline=new EventTimeline(notes,transport),onsets=[];
    for(let frame=0;frame<transport.endFrame+128;frame+=128)timeline.dispatch(frame,128,(n,offset)=>onsets.push({note:n,frame:frame+offset}));
    const visual=new PlaybackVisuals(s);
    for(let frame=0;frame<transport.endFrame+100;frame++){
      const ages=visual.sample({playing:true,frame,sampleRate:1000,transport});
      for(const n of notes){const frames=onsets.filter(onset=>onset.note===n&&onset.frame<=frame).map(onset=>onset.frame),expected=frames.length?frame-Math.max(...frames):Infinity;assert.equal(visual.noteAge(n),expected,`note ${n.tick}, frame ${frame}, tempo ${options.tempo}`);}
      for(let key=40;key<=42;key++){const frames=onsets.filter(onset=>onset.note.key===key&&onset.frame<=frame).map(onset=>onset.frame),expected=frames.length?frame-Math.max(...frames):Infinity;assert.equal(ages[key],expected,`key ${key}, frame ${frame}`);}
    }
  }
});
test('an hour-long jump in a one-tick infinite loop uses bounded work and locates the current remainder',()=>{
  const n=note(0),s=song([n],{tempo:655.35,length:1,loop:true}),visual=new PlaybackVisuals(s),sampleRate=48000,transport=transportConfig(s,{},sampleRate);
  let current=visual._cycle,reads=0;
  Object.defineProperty(visual,'_cycle',{get(){assert.ok(++reads<20000,'cycle catch-up must be bounded, not proportional to background hours');return current;},set(value){current=value;},configurable:true});
  const hour=sampleRate*3600,frame=hour+17,period=transport.framesPerTick,index=Math.ceil((frame+.5-period)/period),trigger=Math.round(index*period);
  visual.sample({playing:true,frame,sampleRate,transport});
  assert.ok(index>2000000);assert.equal(visual._cycle.index,index);assert.equal(visual._previous.index,index-1);assert.equal(visual.noteAge(n),(frame-trigger)/sampleRate*1000);assert.equal(visual.keyAges[45],visual.noteAge(n));
  assert.ok(reads<10000);
  const next=Math.round((index+1)*period);
  visual.sample({playing:true,frame:next-1,sampleRate,transport});assert.equal(visual.noteAge(n),(next-1-trigger)/sampleRate*1000);
  visual.sample({playing:true,frame:next,sampleRate,transport});assert.equal(visual.noteAge(n),0);
});
test('large-jump arithmetic honors a seek anchor, loopStart and the glow from the completed cycle',()=>{
  const tail=note(7),start=note(4,46),s=song([start,tail],{tempo:123.45,loop:true,loopStart:4}),visual=new PlaybackVisuals(s),sampleRate=48000,transport=transportConfig(s,{fromTick:6,startFrame:137},sampleRate);
  const period=4*transport.framesPerTick,initialEnd=137+2*transport.framesPerTick,index=30000,begin=initialEnd+(index-1)*period,frame=Math.round(begin)+7;
  visual.sample({playing:true,frame,sampleRate,transport});
  const previousTail=Math.round(initialEnd+(index-2)*period+3*transport.framesPerTick);
  assert.equal(visual._cycle.index,index);assert.equal(visual.noteAge(start),(frame-Math.round(begin))/sampleRate*1000);assert.equal(visual.noteAge(tail),(frame-previousTail)/sampleRate*1000);
});
test('a huge jump beyond finite loops preserves the final trigger without inventing repetitions',()=>{
  const tail=note(0),s=song([tail],{tempo:655.35,length:1,loop:true,loopCount:255}),visual=new PlaybackVisuals(s),sampleRate=48000,transport=transportConfig(s,{},sampleRate),frame=sampleRate*3600;
  const timeline=new EventTimeline(s.notes,transport),onsets=[];
  for(let start=0;start<transport.endFrame+128;start+=128)timeline.dispatch(start,128,(_note,offset)=>onsets.push(start+offset));
  visual.sample({playing:true,frame,sampleRate,transport});
  assert.equal(onsets.length,256);assert.equal(visual._cycle.index,255);assert.equal(visual.noteAge(tail),(frame-onsets.at(-1))/sampleRate*1000);
  // The direct path must also honor its cap if a caller supplies a longer finite timeline.
  const extended={...transport,loopCount:50000};visual.sample({playing:true,frame,sampleRate,transport:extended});
  assert.equal(visual._cycle.index,50000);assert.equal(visual._previous.index,49999);assert.equal(visual.noteAge(tail),(frame-Math.round(50000*transport.framesPerTick))/sampleRate*1000);
});
