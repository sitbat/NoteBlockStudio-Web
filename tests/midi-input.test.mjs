import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeMidiMessage, MidiInputController} from '../js/midi-input.js';

test('MIDI decoder handles channel, zero-velocity note off, pitch bend and rejects invalid packets',()=>{
  assert.equal(decodeMidiMessage([0x92,60,127]).channel,2);
  assert.equal(decodeMidiMessage([0x92,60,127]).key,39);
  assert.equal(decodeMidiMessage([0x92,60,0]).type,'noteoff');
  assert.equal(decodeMidiMessage([0xe0,0,64]).pitch,0);
  assert.equal(decodeMidiMessage([0xe0,0,0]).pitch,-200);
  assert.equal(decodeMidiMessage([0xf8]),null);
  assert.equal(decodeMidiMessage([0x90,60]),null);
  assert.equal(decodeMidiMessage([0x90,60,255]),null);
});
test('step recording keeps a chord at one tick and advances when all keys release',()=>{
  const notes=[],steps=[],heard=[];
  const midi=new MidiInputController({onNote:n=>heard.push(n),onRecord:n=>notes.push(n),onStep:t=>steps.push(t),now:()=>0});
  midi.startRecording({mode:'step',tick:8,snap:2,instrument:6,layer:3});
  midi.receive('a',[0x90,60,127]);midi.receive('a',[0x90,64,64]);
  midi.receive('a',[0x80,60,0]);assert.deepEqual(steps,[]);
  midi.receive('a',[0x90,64,0]);assert.deepEqual(steps,[10]);
  assert.deepEqual(notes.map(n=>[n.tick,n.duration,n.instrument,n.layer]),[[8,2,6,3],[8,2,6,3]]);
  assert.equal(heard.length,2);
});
test('sustain pedal extends recorded duration and bend/volume/pan are per channel',()=>{
  let now=0;const notes=[];const midi=new MidiInputController({now:()=>now,onRecord:n=>notes.push(n)});
  midi.startRecording({tick:0,tempo:10,snap:1});
  midi.receive('a',[0xb1,7,64]);midi.receive('a',[0xb1,10,127]);midi.receive('a',[0xe1,0,0]);
  midi.receive('a',[0x91,60,127]);midi.receive('a',[0xb1,64,127]);now=200;midi.receive('a',[0x81,60,0]);
  assert.equal(notes.length,0);now=800;midi.receive('a',[0xb1,64,0]);
  assert.equal(notes[0].duration,8);assert.equal(notes[0].pitch,-200);assert.equal(notes[0].pan,100);
  assert.ok(Math.abs(notes[0].velocity-64/127*100)<1e-9);assert.equal(midi.channels[0].pitch,0);
});
test('device filtering and disconnect close only attached ports and flush held recordings',async()=>{
  let closed=0;const records=[];const port={id:'p',name:'Keyboard',state:'connected',close:async()=>closed++};
  const access={inputs:new Map([['p',port]])};const midi=new MidiInputController({requestAccess:async()=>access,onRecord:n=>records.push(n),now:()=>0});
  assert.equal((await midi.connect()).length,1);midi.configure('p',{channel:1,instrument:5,enabled:true});
  midi.startRecording({mode:'step'});port.onmidimessage({data:[0x90,60,127]});assert.equal(midi.held.size,0);
  port.onmidimessage({data:[0x91,60,127]});assert.equal(midi.held.size,1);
  await midi.disconnect();assert.equal(records.length,1);assert.equal(closed,1);assert.equal(port.onmidimessage,null);
});
test('permission refusal never starts recording or attaches a device',async()=>{
  const midi=new MidiInputController({requestAccess:async()=>{throw new Error('denied');}});
  await assert.rejects(midi.connect(),/denied/);assert.equal(midi.access,undefined);assert.equal(midi.held.size,0);
});
test('access is requested only by explicit connect and never requests SysEx',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');let calls=0,options;
  const access={inputs:new Map()};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{requestMIDIAccess:async value=>{calls++;options=value;return access;}}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
  const midi=new MidiInputController();assert.equal(calls,0);assert.equal(midi.recording,null);
  await midi.connect();assert.equal(calls,1);assert.deepEqual(options,{sysex:false});
  await midi.connect();assert.equal(calls,1,'sequential refresh does not repeat the permission request');
  await midi.disconnect();assert.equal(access.onstatechange,null);
});
test('two keyboards using the same MIDI channel retain independent bend, gain, pan and sustain',()=>{
  const heard=[],records=[];const midi=new MidiInputController({onNote:n=>heard.push(n),onRecord:n=>records.push(n),now:()=>0});
  midi.startRecording({mode:'step'});
  midi.receive('keyboard-A',[0xe0,0,0]);midi.receive('keyboard-A',[0xb0,7,0]);midi.receive('keyboard-A',[0xb0,10,127]);midi.receive('keyboard-A',[0xb0,64,127]);
  midi.receive('keyboard-B',[0x90,60,127]);midi.receive('keyboard-B',[0x80,60,0]);
  assert.equal(heard[0].pitch,0);assert.equal(heard[0].pan,0);assert.equal(heard[0].velocity,100);
  assert.equal(records.length,1,'keyboard A pedal must not sustain keyboard B');assert.equal(midi.held.size,0);
  midi.receive('keyboard-A',[0x90,64,127]);midi.receive('keyboard-A',[0x80,64,0]);
  assert.equal(heard[1].pitch,-200);assert.equal(heard[1].velocity,0);assert.equal(heard[1].pan,100);assert.equal(midi.held.size,1);
  midi.receive('keyboard-B',[0xb0,64,0]);assert.equal(midi.held.size,1,'keyboard B pedal must not release keyboard A');
  midi.receive('keyboard-A',[0xb0,64,0]);assert.equal(midi.held.size,0);assert.equal(records.length,2);
});
test('changing channel filter flushes excluded held notes and leaves accepted chord notes active',()=>{
  const records=[],steps=[];const midi=new MidiInputController({onRecord:n=>records.push(n),onStep:tick=>steps.push(tick),now:()=>0});
  midi.configure('a',{instrument:-1,channel:-1,enabled:true});midi.startRecording({mode:'step',tick:2,snap:2});
  midi.receive('a',[0x90,60,100]);midi.receive('a',[0x91,64,100]);
  midi.configure('a',{channel:1});assert.equal(records.length,1);assert.equal(records[0].channel,0);assert.equal(midi.held.size,1);assert.deepEqual(steps,[]);
  midi.receive('a',[0x80,60,0]);assert.equal(records.length,1,'filtered old noteoff cannot duplicate the flushed note');
  midi.receive('a',[0x81,64,0]);assert.equal(records.length,2);assert.equal(midi.held.size,0);assert.deepEqual(steps,[4]);
});
test('sustain threshold, reset controllers and step chords advance once after the final physical key',()=>{
  const records=[],steps=[];const midi=new MidiInputController({onRecord:n=>records.push(n),onStep:tick=>steps.push(tick),now:()=>0});
  midi.startRecording({mode:'step'});
  midi.receive('a',[0xb0,64,63]);midi.receive('a',[0x90,60,100]);midi.receive('a',[0x80,60,0]);assert.deepEqual(steps,[1]);
  midi.receive('a',[0xb0,64,64]);midi.receive('a',[0x90,64,100]);midi.receive('a',[0x90,67,100]);midi.receive('a',[0x80,64,0]);
  assert.equal(records.length,1);midi.receive('a',[0xb0,121,0]);assert.equal(records.length,2);assert.equal(midi.held.size,1);assert.deepEqual(steps,[1]);
  midi.receive('a',[0x80,67,0]);assert.equal(records.length,3);assert.deepEqual(steps,[1,2]);assert.equal(midi.channels[0].sustain,false);
});
test('panic controllers and device disabling flush only the relevant device/channel',()=>{
  const records=[];const midi=new MidiInputController({onRecord:n=>records.push(n),now:()=>0});midi.startRecording({mode:'step'});
  midi.configure('a',{instrument:-1,channel:-1,enabled:true});midi.configure('b',{instrument:-1,channel:-1,enabled:true});
  midi.receive('a',[0x90,60,100]);midi.receive('a',[0x91,64,100]);midi.receive('b',[0x90,67,100]);
  midi.receive('a',[0xb0,120,0]);assert.equal(records.length,1);assert.equal(midi.held.size,2);
  midi.receive('a',[0xb1,123,0]);assert.equal(records.length,2);assert.equal(midi.held.size,1);
  midi.configure('b',{enabled:false});assert.equal(records.length,3);assert.equal(midi.held.size,0);
  midi.receive('b',[0x90,69,100]);assert.equal(midi.held.size,0);
});
test('pitch-bend endpoints and channel state are captured at each note onset',()=>{
  const heard=[],controls=[];const midi=new MidiInputController({onNote:n=>heard.push(n),onControl:e=>controls.push(e)});
  midi.receive('a',[0xe2,127,127]);midi.receive('a',[0x92,60,127]);
  midi.receive('a',[0xe2,0,64]);midi.receive('a',[0x92,64,127]);
  midi.receive('a',[0xc2,73]);midi.receive('a',[0xa2,60,80]);midi.receive('a',[0xd2,80]);
  assert.deepEqual(heard.map(n=>n.pitch),[200,0]);assert.equal(heard[0].pitch,200,'later bend does not rewrite earlier note-on snapshots');
  assert.deepEqual(controls.map(e=>e.type),['bend','bend','program']);assert.equal(midi.channels[2].program,73);
  assert.ok(decodeMidiMessage([0xe0,127,127]).pitch<200);assert.equal(decodeMidiMessage([0xd0,80]).value,80);assert.equal(decodeMidiMessage([0xa0,60,80]).value,80);
});
test('realtime recording uses supplied transport clock for onset and quantizes elapsed duration',()=>{
  let now=0,clock=24.6;const records=[];const midi=new MidiInputController({now:()=>now,onRecord:n=>records.push(n)});
  midi.startRecording({tick:5,tempo:10,snap:2,instrument:16,layer:65534,clockTick:()=>clock});
  midi.receive('a',[0x90,21,100]);now=220;clock=100;midi.receive('a',[0x80,21,0]);
  assert.equal(records[0].tick,24);assert.equal(records[0].duration,2);assert.equal(records[0].layer,65534);assert.equal(records[0].instrument,16);assert.equal(records[0].key,0);
  midi.receive('a',[0x90,108,100]);now=221;midi.receive('a',[0x80,108,0]);assert.equal(records[1].tick,100);assert.equal(records[1].duration,2);assert.equal(records[1].key,87);
});
test('step recording ignores elapsed transport time and repeated note-on does not prematurely advance',()=>{
  let now=0;const records=[],steps=[];const midi=new MidiInputController({now:()=>now,onRecord:n=>records.push(n),onStep:t=>steps.push(t)});
  midi.startRecording({mode:'step',tick:8,snap:4,clockTick:()=>900});
  midi.receive('a',[0x90,60,100]);now=5000;midi.receive('a',[0x90,60,80]);assert.equal(records.length,1);assert.deepEqual(steps,[]);
  midi.receive('a',[0x80,60,0]);assert.deepEqual(records.map(n=>[n.tick,n.duration]),[[8,4],[8,4]]);assert.deepEqual(steps,[12]);
});
test('hot unplug flushes held recordings and reconnect starts with clean channel controllers',async()=>{
  const port={id:'a',state:'connected'},access={inputs:new Map([['a',port]])},records=[],heard=[];
  const midi=new MidiInputController({requestAccess:async()=>access,onRecord:n=>records.push(n),onNote:n=>heard.push(n),now:()=>0});await midi.connect();midi.startRecording({mode:'step'});
  port.onmidimessage({data:[0xe0,0,0]});port.onmidimessage({data:[0x90,60,100]});port.state='disconnected';access.onstatechange();
  assert.equal(midi.held.size,0);assert.equal(records.length,1);assert.equal(midi.deviceChannels.has('a'),false);
  port.state='connected';access.onstatechange();port.onmidimessage({data:[0x90,64,100]});assert.equal(heard[1].pitch,0);
  await midi.disconnect();assert.equal(midi.deviceChannels.size,0);assert.equal(midi.channels[0].pitch,0);assert.equal(records.length,2);
});
test('invalid packets, unavailable piano keys and invalid device configuration cannot create recordings',()=>{
  const records=[],heard=[];const midi=new MidiInputController({onNote:n=>heard.push(n),onRecord:n=>records.push(n)});midi.startRecording();
  for(const bytes of [[0x90,20,127],[0x90,109,127],[0x90,60,-1],[0x90,60,128],[0x90,60],[0xf0,1,0xf7],[0x70,60,100],[0xff]])midi.receive('a',bytes);
  assert.equal(midi.held.size,0);assert.equal(heard.length,0);assert.equal(records.length,0);
  midi.configure('a',{instrument:5,channel:0,enabled:true});const saved={...midi.devices.get('a')};
  assert.throws(()=>midi.configure('a',{channel:16}),/通道/);assert.deepEqual(midi.devices.get('a'),saved);
  assert.throws(()=>midi.configure('a',{instrument:271}),/音色/);assert.deepEqual(midi.devices.get('a'),saved);
});
test('stop recording flushes once and later monitoring notes do not enter the old recording',()=>{
  const records=[];const midi=new MidiInputController({onRecord:n=>records.push(n),now:()=>0});midi.startRecording({mode:'step'});
  midi.receive('a',[0x90,60,100]);midi.receive('a',[0xb0,64,127]);midi.receive('a',[0x80,60,0]);midi.stopRecording();assert.equal(records.length,1);assert.equal(midi.recording,null);
  midi.receive('a',[0xb0,64,0]);midi.receive('a',[0x80,60,0]);midi.receive('a',[0x90,64,100]);midi.receive('a',[0x80,64,0]);assert.equal(records.length,1);
});

test('release callback uses the original onset snapshot and keeps identical keys on separate devices/channels independent',()=>{
  const heard=[],released=[],visual=new Map(),source=n=>JSON.stringify([n.device,n.channel,n.key]);
  const midi=new MidiInputController({onNote:n=>{heard.push(n);visual.set(source(n),n);},onRelease:n=>{
    assert.equal(midi.held.has(`${n.device}/${n.channel}/${n.midiKey}`),false,'remove held before notifying');
    released.push(n);visual.delete(source(n));
  }});
  midi.receive('a',[0xe0,0,0]);midi.receive('a',[0x90,60,100]);midi.receive('b',[0x90,60,80]);midi.receive('a',[0x91,60,60]);
  assert.equal(visual.size,3);midi.receive('a',[0x80,60,0]);
  assert.strictEqual(released[0],heard[0]);assert.equal(released[0].device,'a');assert.equal(released[0].channel,0);assert.equal(released[0].key,39);assert.equal(released[0].pitch,-200);
  assert.equal(visual.size,2);midi.receive('a',[0x80,60,0]);assert.equal(released.length,1,'duplicate noteoff does not release twice');
  midi.receive('b',[0x90,60,0]);assert.strictEqual(released[1],heard[1]);assert.equal(visual.size,1);
  midi.receive('a',[0x81,60,0]);assert.strictEqual(released[2],heard[2]);assert.equal(visual.size,0);
});

test('release callback follows sustain, controller reset and panic without releasing physically held keys too early',()=>{
  const released=[],midi=new MidiInputController({onRelease:n=>released.push(n.midiKey)});
  midi.receive('a',[0xb0,64,127]);midi.receive('a',[0x90,60,100]);midi.receive('a',[0x90,64,100]);
  midi.receive('a',[0x80,60,0]);assert.deepEqual(released,[]);assert.equal(midi.held.size,2);
  midi.receive('b',[0xb0,64,0]);assert.deepEqual(released,[],'another device pedal does not release this source');
  midi.receive('a',[0xb0,64,0]);assert.deepEqual(released,[60]);assert.equal(midi.held.size,1);
  midi.receive('a',[0xb0,64,127]);midi.receive('a',[0x80,64,0]);midi.receive('a',[0xb0,121,0]);assert.deepEqual(released,[60,64]);
  midi.receive('a',[0x90,67,100]);midi.receive('a',[0x91,69,100]);midi.receive('a',[0xb0,120,0]);assert.deepEqual(released,[60,64,67]);assert.equal(midi.held.size,1);
  midi.receive('a',[0xb1,123,0]);assert.deepEqual(released,[60,64,67,69]);assert.equal(midi.held.size,0);
});

test('repeated note-on releases the previous visual source before its replacement onset',()=>{
  const events=[],onsets=[],steps=[];
  const midi=new MidiInputController({onNote:n=>{onsets.push(n);events.push(['down',n]);},onRelease:n=>events.push(['up',n]),onStep:tick=>steps.push(tick),now:()=>0});
  midi.startRecording({mode:'step',tick:8,snap:2});
  midi.receive('a',[0x90,60,100]);midi.receive('a',[0xb0,64,127]);midi.receive('a',[0x80,60,0]);midi.receive('a',[0x90,60,80]);
  assert.deepEqual(events.map(([kind])=>kind),['down','up','down']);assert.strictEqual(events[1][1],onsets[0]);assert.notStrictEqual(onsets[0],onsets[1]);
  assert.equal(midi.held.size,1);assert.deepEqual(steps,[],'replacement note does not advance step recording');
  midi.receive('a',[0x80,60,0]);assert.equal(events.length,3,'replacement remains sustained');
  midi.receive('a',[0xb0,64,0]);assert.deepEqual(events.map(([kind])=>kind),['down','up','down','up']);assert.strictEqual(events[3][1],onsets[1]);assert.deepEqual(steps,[10]);
});

test('device filtering, disabling and ignore-instrument configuration release excluded visual sources exactly once',()=>{
  const released=[],midi=new MidiInputController({onRelease:n=>released.push([n.device,n.channel,n.midiKey])});
  midi.configure('a',{instrument:-1,channel:-1,enabled:true});midi.configure('b',{instrument:-1,channel:-1,enabled:true});
  midi.receive('a',[0x90,60,100]);midi.receive('a',[0x91,64,100]);midi.receive('b',[0x90,67,100]);
  midi.configure('a',{channel:1});assert.deepEqual(released,[['a',0,60]]);assert.equal(midi.held.size,2);
  midi.receive('a',[0x80,60,0]);assert.equal(released.length,1);
  midi.configure('a',{enabled:false});assert.deepEqual(released,[['a',0,60],['a',1,64]]);assert.equal(midi.held.size,1);
  midi.configure('b',{instrument:-2});assert.deepEqual(released,[['a',0,60],['a',1,64],['b',0,67]]);assert.equal(midi.held.size,0);
  midi.receive('b',[0x90,69,100]);midi.receive('b',[0x80,67,0]);assert.equal(midi.held.size,0);assert.equal(released.length,3);
});

test('re-enabling a device or channel cannot retain a pedal-up that was filtered out',()=>{
  for(const excluded of [{enabled:false},{channel:1},{instrument:-2}]){
    const released=[],midi=new MidiInputController({onRelease:n=>released.push(n)});
    midi.configure('a',{instrument:-1,channel:-1,enabled:true});
    midi.receive('a',[0xb0,64,127]);midi.receive('a',[0x90,60,100]);midi.receive('a',[0x80,60,0]);
    assert.equal(midi.held.size,1);midi.configure('a',excluded);assert.equal(midi.held.size,0);assert.equal(released.length,1);
    midi.receive('a',[0xb0,64,0]);midi.configure('a',{instrument:-1,channel:-1,enabled:true});
    midi.receive('a',[0x90,64,100]);midi.receive('a',[0x80,64,0]);
    assert.equal(midi.held.size,0);assert.equal(released.length,2,'new note releases without another pedal transition');
  }
});

test('stopRecording, hot unplug and disconnect flush monitoring and sustained visual sources without stuck keys',async()=>{
  const visual=new Set(),released=[],source=n=>JSON.stringify([n.device,n.channel,n.key]);
  const port={id:'a',state:'connected'},access={inputs:new Map([['a',port]])};
  const midi=new MidiInputController({requestAccess:async()=>access,onNote:n=>visual.add(source(n)),onRelease:n=>{released.push(n);visual.delete(source(n));},now:()=>0});
  await midi.connect();midi.startRecording({mode:'step'});midi.receive('a',[0x90,60,100]);midi.receive('a',[0xb0,64,127]);midi.receive('a',[0x80,60,0]);
  midi.stopRecording();assert.equal(visual.size,0);assert.equal(released.length,1);midi.stopRecording();assert.equal(released.length,1);
  midi.receive('a',[0x90,64,100]);port.state='disconnected';access.onstatechange();assert.equal(visual.size,0);assert.equal(released.length,2);
  port.state='connected';access.onstatechange();midi.receive('a',[0x90,67,100]);assert.equal(visual.size,1);
  await midi.disconnect();assert.equal(visual.size,0);assert.equal(midi.held.size,0);assert.equal(released.length,3);assert.equal(port.onmidimessage,null);
  await midi.disconnect();assert.equal(released.length,3,'repeated disconnect does not synthesize releases');
});
