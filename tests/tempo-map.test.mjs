import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSongControls, createTempoMap, controlType, secondsAtTick, tickAtSeconds, tempoAtTick} from '../js/tempo-map.js';
import {transportConfig, tickAtFrame, tickFrameOffset, completedLoopsAtFrame, rainbowAtFrame, EventTimeline, MetronomeTimeline} from '../js/dsp-protocol.js';
import {WasmAudioEngine} from '../js/wasm-audio.js';

const layer = extra => ({volume:100, muted:false, solo:false, ...extra});
const song = extra => ({tempo:10,length:12,layers:[layer(),layer(),layer()],customInstruments:[{name:'Tempo Changer',file:''},{name:'Toggle Rainbow',file:''}],
  notes:[{tick:4,layer:0,instrument:16,pitch:300},{tick:8,layer:0,instrument:16,pitch:75}],...extra});
const close = (actual, expected) => assert(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('Tempo Changer maps abs(pitch)/15 to continuous song seconds without changing editing tempo',()=>{
  const s=song(),map=createTempoMap(s);
  assert.equal(s.tempo,10);assert.deepEqual(map.points,[{tick:0,seconds:0,tempo:10},{tick:4,seconds:.4,tempo:20},{tick:8,seconds:.6000000000000001,tempo:5}]);
  for(const [tick,seconds]of [[0,0],[2,.2],[4,.4],[6,.5],[8,.6],[10,1],[12,1.4]]){close(secondsAtTick(tick,map),seconds);close(tickAtSeconds(seconds,map),tick);}
  assert.equal(tempoAtTick(4,map),20);assert.equal(tempoAtTick(8,map),5);assert(Object.isFrozen(map.points[0]));
  assert.equal(createTempoMap(song({notes:[]})),null,'ordinary 10k-track songs use the constant-time fast path');
});

test('same-tick controls follow original layer order and mute/solo filtering; zero gain remains a control',()=>{
  const s=song({layers:[layer({volume:0}),layer(),layer({muted:true})],notes:[
    {tick:0,layer:1,instrument:16,pitch:-150,velocity:0},{tick:0,layer:0,instrument:16,pitch:450},
    {tick:0,layer:2,instrument:16,pitch:900},{tick:4,layer:0,instrument:16,pitch:0}]});
  const map=createTempoMap(s);assert.equal(tempoAtTick(0,map),10);assert.equal(tempoAtTick(4,map),.25);
  s.layers[0].solo=true;assert.equal(tempoAtTick(0,createTempoMap(s)),30);
  assert.equal(controlType({instrument:16},s),'tempo');assert.equal(controlType({instrument:17},s),'rainbow');assert.equal(controlType({instrument:0},s),null);
});

test('rainbow toggle events are retained independently of tempo and retain same-column multiplicity',()=>{
  const s=song({notes:[{tick:2,layer:1,instrument:17},{tick:2,layer:0,instrument:17},{tick:5,layer:0,instrument:17}]});
  assert.deepEqual(compileSongControls(s).map(c=>[c.type,c.tick,c.layer]),[['rainbow',2,0],['rainbow',2,1],['rainbow',5,0]]);
  assert.deepEqual(transportConfig(s,{},1000).rainbowEvents,[2,2,5]);
});

test('variable-tempo seeking, bounded sections and finite loops share exact event frames',()=>{
  const s=song(),c=transportConfig(s,{fromTick:6,endTick:10,loop:true,loopStart:4,loopCount:2,startFrame:100},1000);
  assert.equal(c.length,10);assert.equal(c.fullLength,12);assert.equal(c.endFrame,1800);
  close(tickAtFrame(200,c),8);close(tickAtFrame(600,c),4);close(tickAtFrame(1200,c),4);assert.equal(tickAtFrame(1800,c),10);
  const timeline=new EventTimeline([3,4,6,8,10,11].map(tick=>({tick})),c),seen=[];
  for(let frame=0;frame<2000;frame+=128)timeline.dispatch(frame,128,(event,offset)=>seen.push([event.tick,frame+offset]));
  assert.deepEqual(seen,[[6,100],[8,200],[4,600],[6,700],[8,800],[4,1200],[6,1300],[8,1400]]);
});

test('metronome generates sparse four-tick beats through tempo changes, seek and section loops',()=>{
  const c=transportConfig(song(),{fromTick:2,endTick:10,loop:true,loopStart:2,loopCount:1},1000),metro=new MetronomeTimeline(c),seen=[];
  for(let frame=0;frame<c.endFrame+128;frame+=128)metro.dispatch(frame,128,(tick,offset)=>seen.push([tick,frame+offset]));
  assert.deepEqual(seen,[[4,200],[8,400],[4,1000],[8,1200]]);
  const resumed=new MetronomeTimeline(c,350),later=[];resumed.dispatch(350,200,(tick,offset)=>later.push([tick,350+offset]));assert.deepEqual(later,[[8,400]]);
});

test('control instruments never load a fallback sample or enter Rust voice lists',()=>{
  const audio=new WasmAudioEngine(),s=song({notes:[...song().notes,{tick:2,layer:1,instrument:17},{tick:0,layer:0,instrument:0,key:45}]}),buffer={length:1,numberOfChannels:1,sampleRate:48000,getChannelData:()=>new Float32Array([.2])};
  for(let i=0;i<16;i++)audio.buffers.set(i,buffer);
  assert.equal(audio._sample({instrument:16},s).buffer,null);assert.equal(audio._sample({instrument:17},s).buffer,null);assert.equal(audio.warnings.length,0);
  assert.equal(audio._samplesFor(s).samples.length,16);
  const events=audio._eventsFor(s,{tracks:3,ranges:[{start:0,end:3}]});assert.equal(events[0].length,1);assert.equal(events[0][0].sample,0);
});

test('rainbow parity matches the dispatched event oracle across variable tempo, seeks, duplicate toggles and finite loops',()=>{
  for(const options of [{},{fromTick:3,endTick:10},{fromTick:3,endTick:10,loop:true,loopStart:4,loopCount:3},{fromTick:6,endTick:10,loop:true,loopStart:2,loopCount:2}]){
    const s=song({notes:[...song().notes,...[1,3,4,4,7,9,10,11].map(tick=>({tick,layer:0,instrument:17}))]}),c=transportConfig(s,options,1000),events=c.rainbowEvents.map(tick=>({tick})),timeline=new EventTimeline(events,c),onsets=[];
    for(let frame=0;frame<c.endFrame+128;frame+=128)timeline.dispatch(frame,128,(event,offset)=>onsets.push(frame+offset));
    for(let frame=0;frame<c.endFrame+100;frame+=11)assert.equal(rainbowAtFrame(frame,c),onsets.filter(onset=>onset<=frame).length%2===1,JSON.stringify({options,frame}));
  }
});

test('rainbow snapshots use bounded logarithmic work after huge loop jumps and reset when stopped',()=>{
  const c=transportConfig(song({tempo:10,length:100000,notes:[]}),{loop:true},1000);let reads=0;
  c.rainbowEvents=new Proxy(Array.from({length:100000},(_,i)=>i),{get(target,key){if(/^\d+$/.test(String(key)))reads++;return Reflect.get(target,key);}});
  assert.equal(rainbowAtFrame(1e12,c),true);assert(reads<300,`bounded index lookups: ${reads}`);
  const engine=new WasmAudioEngine({context:{sampleRate:1000}});engine._transport=c;engine._playedFrames=()=>1e12;engine.playing=true;
  assert.equal(engine.getPlaybackPosition().rainbowActive,true);engine.playing=false;assert.equal(engine.getPlaybackPosition().rainbowActive,false);
});

test('a runtime re-anchor retains consumed loop budget and prior rainbow parity',()=>{
  const s=song({loop:true,loopStart:4,loopCount:2,notes:[...song().notes,{tick:4,layer:0,instrument:17},{tick:9,layer:0,instrument:17}]}),old=transportConfig(s,{},1000),frame=1700;
  assert.equal(completedLoopsAtFrame(frame,old),1);
  const next=transportConfig(s,{fromTick:tickAtFrame(frame,old),startFrame:frame,completedLoops:completedLoopsAtFrame(frame,old),rainbowBaseParity:rainbowAtFrame(frame-1,old)},1000);
  close(next.endFrame,old.endFrame);assert.equal(rainbowAtFrame(frame,next),rainbowAtFrame(frame,old));
  const events=next.rainbowEvents.map(tick=>({tick})),timeline=new EventTimeline(events,next),seen=[];
  for(let start=frame;start<old.endFrame+128;start+=128)timeline.dispatch(start,128,(event,offset)=>seen.push(start+offset));
  for(let current=frame;current<old.endFrame+100;current+=17)assert.equal(rainbowAtFrame(current,next),rainbowAtFrame(frame-1,old)!==(seen.filter(onset=>onset<=current).length%2===1));
});
