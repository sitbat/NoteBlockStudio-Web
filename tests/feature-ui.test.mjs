import test from 'node:test';
import assert from 'node:assert/strict';
import {installFeatureUI,loadMidiImportPreferences,saveMidiImportPreferences,remapMidiDeviceInstruments,MIDI_IMPORT_STORAGE_KEY,resolveMidiImportOptions} from '../js/feature-ui.js';
import {MidiInputController} from '../js/midi-input.js';
import {parseMIDI} from '../js/formats.js';
import {createBlankSong} from '../js/model.js';
import {normalizePreferences} from '../js/editor-preferences.js';

const definitions=()=>[{name:'A',file:'Custom/a.ogg',key:45,pressKey:true},{name:'B',file:'Custom/b.ogg',key:57,pressKey:false}];
const storage=()=>{const items=new Map();return{getItem:key=>items.get(key)??null,setItem:(key,value)=>items.set(key,String(value)),removeItem:key=>items.delete(key)};};

test('remembered MIDI settings retain all mapping types and resolve custom instruments against the current bank identity',()=>{
  const store=storage(),custom=definitions(),options={targetTempo:12.5,gridSubdivision:4,octaveOffset:-1,maxLayers:99,namingMode:'channel',keepVelocity:false,keepPan:false,trackNames:false,removeSilent:false,keepWithinOctaveRange:true,programMap:{0:{instrument:17,octave:1},1:-1},channelMap:{9:{instrument:16,octave:-1}},percussionMap:{36:{instrument:16,key:53}}};
  assert.equal(saveMidiImportPreferences(store,options,custom,true),true);
  const loaded=loadMidiImportPreferences(store,[custom[1],{...custom[0],file:'Custom\\a.ogg'}]);
  assert.equal(loaded.remember,true);assert.equal(loaded.options.targetTempo,12.5);assert.equal(loaded.options.namingMode,'channel');assert.equal(loaded.options.keepVelocity,false);assert.equal(loaded.options.removeSilent,false);
  assert.deepEqual(loaded.options.programMap,{0:{instrument:16,octave:1},1:-1});assert.deepEqual(loaded.options.channelMap,{9:{instrument:17,octave:-1}});assert.deepEqual(loaded.options.percussionMap,{36:{instrument:17,key:53}});
  const missing=loadMidiImportPreferences(store,[]);assert.deepEqual(missing.options.programMap,{1:-1});assert.deepEqual(missing.options.channelMap,{});assert.deepEqual(missing.options.percussionMap,{});
  assert.equal(saveMidiImportPreferences(store,options,custom,false),true);assert.deepEqual(JSON.parse(store.getItem(MIDI_IMPORT_STORAGE_KEY)),{version:1,remember:false});assert.equal(loadMidiImportPreferences(store,custom).options.targetTempo,0);
});

test('corrupt, blocked, out-of-range and ambiguous remembered MIDI settings safely use defaults instead of stale sound IDs',()=>{
  const store=storage();store.setItem(MIDI_IMPORT_STORAGE_KEY,'bad JSON');assert.equal(loadMidiImportPreferences(store).remember,false);
  assert.equal(loadMidiImportPreferences({getItem(){throw Error('blocked');}}).options.maxLayers,65535);assert.equal(saveMidiImportPreferences({setItem(){throw Error('quota');}},{},[],true),false);
  store.setItem(MIDI_IMPORT_STORAGE_KEY,JSON.stringify({version:1,remember:true,customInstruments:definitions(),options:{targetTempo:-4,maxLayers:65536,gridSubdivision:3,namingMode:'bad',programMap:{0:{instrument:7,octave:9},1:5},channelMap:{16:0,1:{instrument:16,octave:0}},percussionMap:{36:{instrument:2,key:88}}}}));
  const loaded=loadMidiImportPreferences(store,[...definitions(),definitions()[0]]);assert.equal(loaded.options.targetTempo,0);assert.equal(loaded.options.maxLayers,65535);assert.equal(loaded.options.gridSubdivision,1);assert.deepEqual(loaded.options.programMap,{1:5});assert.deepEqual(loaded.options.channelMap,{});assert.deepEqual(loaded.options.percussionMap,{});
});

test('MIDI bank remapping preserves explicit hardware choices, skips special modes and prevents a deleted held voice from recording an obsolete ID',()=>{
  const recorded=[],controller=new MidiInputController({now:()=>0,onRecord:note=>recorded.push(note)});
  for(const [id,instrument]of [['a',16],['b',17],['selected',-1],['disabled',-2],['native',5]])controller.configure(id,{instrument,channel:-1,enabled:true});
  controller.startRecording({mode:'step',instrument:17,snap:1});controller.receive('a',[0x90,60,100]);controller.receive('b',[0x90,64,100]);
  const changed=remapMidiDeviceInstruments(controller,new Map([[5,5],[16,17],[17,-1]]),{fallback:5});
  assert.equal(changed,2);assert.equal(controller.devices.get('a').instrument,17);assert.equal(controller.devices.get('b').instrument,-1);assert.equal(controller.devices.get('selected').instrument,-1);assert.equal(controller.devices.get('disabled').instrument,-2);assert.equal(controller.devices.get('native').instrument,5);assert.equal(controller.recording.instrument,5);
  controller.receive('a',[0x80,60,0]);controller.receive('b',[0x80,64,0]);assert.deepEqual(recorded.map(note=>note.instrument),[17]);
});

// This adapter only models modal form values/handlers. It does not emulate a
// browser renderer or load app.js, audio workers, permissions or dependencies.
function formEnvironment(t){
  const originals=new Map(['document','localStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),store=storage();
  let nodes=[],byId=new Map(),html='',closed=0;
  const classes=()=>({toggle(){},add(){},remove(){}});
  const camel=name=>name.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
  function attributes(text){return Object.fromEntries([...text.matchAll(/([a-z][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi)].map(match=>[match[1],match[2]??match[3]??match[4]??'']));}
  function parse(source){for(const match of source.matchAll(/<(input|select|button|div|section|label|p)\b([^>]*)>/gi)){const attrs=attributes(match[2]),element={attrs,dataset:Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[camel(key.slice(5)),value])),checked:'checked'in attrs,disabled:'disabled'in attrs,hidden:'hidden'in attrs,isConnected:true,classList:classes(),setAttribute(key,value){this.attrs[key]=String(value);},close(){closed++;}};let value=attrs.value??'';Object.defineProperty(element,'value',{get:()=>value,set:next=>{value=String(next);},configurable:true});Object.defineProperty(element,'innerHTML',{get:()=>element.contents||'',set:next=>{element.contents=String(next);parse(String(next));}});if(match[1]==='select'){const section=source.slice(match.index+match[0].length).split('</select>')[0],options=[...section.matchAll(/<option\b([^>]*)>([^<]*)/g)].map(option=>({attrs:attributes(option[1]),text:option[2]})),option=options.find(option=>'selected'in option.attrs)||options[0];if(option)value=option.attrs.value??option.text;}nodes.push(element);if(attrs.id)byId.set(attrs.id,element);}}
  const matches=(node,selector)=>{const match=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);return match&&Object.hasOwn(node.attrs,match[1])&&(match[2]===undefined||node.attrs[match[1]]===match[2]);};
  const modal={close(){closed++;}},doc={getElementById:id=>id==='modal'?modal:byId.get(id)??null,querySelectorAll:selector=>nodes.filter(node=>matches(node,selector)),querySelector:selector=>nodes.find(node=>matches(node,selector))??null,body:{classList:classes()},documentElement:{style:{setProperty(){}}}};
  Object.defineProperty(globalThis,'document',{value:doc,configurable:true});Object.defineProperty(globalThis,'localStorage',{value:store,configurable:true});t.after(()=>{for(const [key,descriptor]of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  return{doc,store,get html(){return html;},get closed(){return closed;},render(_title,body='',footer=''){for(const node of nodes)node.isConnected=false;nodes=[];byId=new Map();html=body+footer;parse(html);}};
}
function host(env){
  let song=createBlankSong();song.customInstruments=definitions();song.notes=[{id:'a',tick:0,layer:0,key:39,instrument:16,velocity:100,pan:0,pitch:0}];
  const state={instrument:16,tick:0,layer:0,selected:new Set(),busy:false},engine={customSamples:new Map([[0,{id:'a'}],[1,{id:'b'}]]),bundledCustomSamples:new Map(),stopLive(){}},errors=[],toasts=[],prefs=normalizePreferences();
  const h={getEngine:()=>engine,getSong:()=>song,getState:()=>state,preferences:prefs,modal:env.render,error:error=>errors.push(error),toast:text=>toasts.push(text),isBusy:()=>false,checkpoint(){},refresh(){},persist(){},renderRack(){},stopPlayback(){},resize(){},scheduleDraw(){},getSelected:()=>new Set(),setSelected(){},confirmReplace:callback=>callback(),replaceSong:next=>{song=next;engine.customSamples=new Map();},store:{parse:async(file,_progress,options)=>parseMIDI(await file.arrayBuffer(),options)}};
  return{h,engine,state,prefs,errors,toasts,get song(){return song;}};
}
function twoChannelMidi(){const data=[0,0xc0,0,0,0xc1,0,0,0x90,60,100,0,0x91,60,100,0x83,0x60,0xff,0x2f,0],bytes=new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,data.length,...data]);return{name:'channels.mid',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer};}

test('MIDI import dialog sends 16 channel overrides to the real parser and remembers the successfully accepted settings',async t=>{
  const env=formEnvironment(t),fixture=host(env),api=installFeatureUI(fixture.h),file=twoChannelMidi(),oldBank=new Map(fixture.engine.customSamples),get=id=>env.doc.getElementById(id),channel=index=>env.doc.querySelector(`[data-midi-import-channel="${index}"]`),octave=index=>env.doc.querySelector(`[data-midi-import-channel-octave="${index}"]`);
  api.importMidi(file);assert.equal(env.doc.querySelectorAll('[data-midi-import-channel]').length,16);assert.equal(channel(15).value,'-2');
  get('midiMappingTarget').value=7;get('midiMappingOctave').value=2;await get('midiMappingSave').onclick();
  channel(0).value=5;octave(0).value=-1;await channel(0).onchange();channel(1).value=16;octave(1).value=1;await channel(1).onchange();get('midiImportTempo').value=12;get('midiImportGrid').value=2;get('midiImportNaming').value='channel';get('midiImportRemember').checked=true;
  await get('midiImportApply').onclick();assert.deepEqual(fixture.errors,[]);assert.deepEqual(fixture.song.notes.map(note=>[note.instrument,note.key]),[[5,27],[16,51]]);assert.equal(fixture.song.tempo,24);assert.deepEqual(fixture.engine.customSamples,oldBank);assert.equal(env.closed,1);
  const remembered=loadMidiImportPreferences(env.store,fixture.song.customInstruments);assert.equal(remembered.remember,true);assert.deepEqual(remembered.options.channelMap,{0:{instrument:5,octave:-1},1:{instrument:16,octave:1}});assert.deepEqual(remembered.options.programMap,{0:{instrument:7,octave:2}});
  api.importMidi(file);assert.equal(get('midiImportTempo').value,'12');assert.equal(get('midiImportGrid').value,'2');assert.equal(get('midiImportNaming').value,'channel');assert.equal(channel(1).value,'16');assert.equal(octave(1).value,'1');assert.equal(get('midiImportRemember').checked,true);
});

test('transcription reuses the existing MIDI mapping dialog with its current settings and remaps custom sound identities',async t=>{
  const env=formEnvironment(t),fixture=host(env),api=installFeatureUI(fixture.h),before=fixture.song,bank=new Map(fixture.engine.customSamples);let applied,parses=0;fixture.h.store.parse=async()=>{parses++;throw Error('settings must not parse');};
  const initial={customInstruments:[definitions()[1],definitions()[0]],channelMap:{0:{instrument:16,octave:1}},programMap:{1:{instrument:17,octave:-1}},keepVelocity:false,octaveOffset:2};
  api.configureMidiImport(options=>{applied=options;},initial);
  assert.equal(env.doc.querySelector('[data-midi-import-channel="0"]').value,'17');assert.equal(env.doc.getElementById('midiImportOctave').value,'2');assert.equal(env.doc.getElementById('midiImportVelocity').checked,false);assert.equal(env.doc.getElementById('midiImportTempo').disabled,true);assert.equal(env.doc.getElementById('midiImportGrid').disabled,true);
  await env.doc.getElementById('midiImportApply').onclick();assert.deepEqual(fixture.errors,[]);assert.equal(parses,0);assert.equal(fixture.song,before);assert.deepEqual(fixture.engine.customSamples,bank);assert.deepEqual(applied.channelMap,{0:{instrument:17,octave:1}});assert.deepEqual(applied.programMap,{1:{instrument:16,octave:-1}});
  const reordered=resolveMidiImportOptions(applied,[definitions()[1],definitions()[0]]);assert.deepEqual(reordered.channelMap,{0:{instrument:16,octave:1}});assert.deepEqual(reordered.programMap,{1:{instrument:17,octave:-1}});
});

test('URL import passes the downloaded audio File and MIME to the shared open route without replacing the score',async t=>{
  const env=formEnvironment(t),fixture=host(env),before=fixture.song,received=[],originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/flac'}});t.after(()=>{globalThis.fetch=originalFetch;});fixture.h.loadFile=async file=>received.push(file);
  const api=installFeatureUI(fixture.h);await api.actions.openURL();env.doc.getElementById('songURL').value='https://source.example/audio';await env.doc.getElementById('urlApply').onclick();assert.deepEqual(fixture.errors,[]);assert.equal(received.length,1);assert.equal(received[0].name,'audio.flac');assert.equal(received[0].type,'audio/flac');assert.deepEqual([...new Uint8Array(await received[0].arrayBuffer())],[1,2,3]);assert.equal(fixture.song,before);
});

test('invalid channel octave never parses or commits a MIDI project, and cancellation never stores preferences',async t=>{
  const env=formEnvironment(t),fixture=host(env),api=installFeatureUI(fixture.h),before=fixture.song,get=id=>env.doc.getElementById(id);let parsed=0;const parse=fixture.h.store.parse;fixture.h.store.parse=(...args)=>{parsed++;return parse(...args);};
  api.importMidi(twoChannelMidi());env.doc.querySelector('[data-midi-import-channel="0"]').value=5;env.doc.querySelector('[data-midi-import-channel-octave="0"]').value=1.5;await get('midiImportApply').onclick();assert.equal(parsed,0);assert.equal(fixture.song,before);assert.match(fixture.errors[0].message,/通道八度/);assert.equal(get('midiImportApply').disabled,false);
  api.importMidi(twoChannelMidi());get('midiImportRemember').checked=true;fixture.h.confirmReplace=()=>{};await get('midiImportApply').onclick();assert.equal(parsed,1);assert.equal(fixture.song,before);assert.equal(env.store.getItem(MIDI_IMPORT_STORAGE_KEY),null);
});

test('denied access to the localStorage property cannot prevent a normal MIDI import',async t=>{
  const env=formEnvironment(t),fixture=host(env),api=installFeatureUI(fixture.h);Object.defineProperty(globalThis,'localStorage',{get(){throw new DOMException('blocked','SecurityError');},configurable:true});
  api.importMidi(twoChannelMidi());await env.doc.getElementById('midiImportApply').onclick();assert.equal(fixture.song.notes.length,2);assert.deepEqual(fixture.errors,[]);
});

test('feature actions delegate NBS save options and persist the playback mono checkbox through the real preference callback',async t=>{
  const env=formEnvironment(t),fixture=host(env);let saves=0,mono=null;fixture.h.showSaveOptions=()=>saves++;fixture.h.applyPlaybackPreferences=()=>{mono=fixture.prefs.mono;};const api=installFeatureUI(fixture.h);
  await api.actions.saveOptions();assert.equal(saves,1);assert.equal(env.html,'');await api.actions.preferences('playback');const field=env.doc.querySelector('[data-pref="mono"]');assert.ok(field);assert.equal(field.checked,false);field.checked=true;await env.doc.getElementById('prefApply').onclick();assert.deepEqual(fixture.errors,[]);assert.equal(fixture.prefs.mono,true);assert.equal(mono,true);assert.equal(JSON.parse(env.store.getItem('nbs-web-preferences-v3')).mono,true);
});

test('instrument-manager commits invoke the wired MIDI device remapper for both reorder and deletion',async t=>{
  const env=formEnvironment(t),fixture=host(env),api=installFeatureUI(fixture.h);api.midi.configure('hardware',{instrument:16,channel:-1,enabled:true});
  await api.actions.instruments();await env.doc.getElementById('instrumentManagerDown').onclick();assert.equal(api.midi.devices.get('hardware').instrument,17);assert.equal(fixture.song.notes[0].instrument,17);assert.equal(fixture.state.instrument,17);
  await env.doc.getElementById('instrumentManagerRemove').onclick();assert.equal(api.midi.devices.get('hardware').instrument,-1);assert.equal(fixture.song.notes.length,0);assert.equal(fixture.state.instrument,0);assert.deepEqual(fixture.errors,[]);
});

test('MIDI recording reads getTick in song ticks while transport runs, without confusing seconds or an absent currentTick property',async t=>{
  const env=formEnvironment(t),fixture=host(env);fixture.engine.playing=true;fixture.engine.getTick=()=>6.25;fixture.engine.triggerLive=async()=>{};fixture.state.snap=1;
  const api=installFeatureUI(fixture.h);api.midi.access={inputs:new Map()};api.midi.configure('hardware',{instrument:5,channel:-1,enabled:true});
  await api.toggleMidiRecord();api.midi.receive('hardware',[0x90,60,100]);api.midi.receive('hardware',[0x80,60,0]);
  assert.equal(fixture.song.notes.length,2);assert.equal(fixture.song.notes.at(-1).tick,6);assert.equal(fixture.song.notes.at(-1).instrument,5);assert.deepEqual(fixture.errors,[]);
});

test('tutorial menu opens the four native video parts and preserves the collection link when no part is supplied',t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),opened=[];Object.defineProperty(globalThis,'window',{value:{open:(...args)=>opened.push(args)},configurable:true});t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
  const api=installFeatureUI({getEngine:()=>({}),preferences:normalizePreferences(),error:error=>{throw error;}});
  for(const part of [1,2,3,4,undefined,0,5])api.actions.tutorials(part);
  assert.deepEqual(opened.map(args=>args[0]),[1,2,3,4].map(part=>`https://www.bilibili.com/video/BV1Mx411a76p?p=${part}`).concat(Array(3).fill('https://www.bilibili.com/video/BV1Mx411a76p')));assert.ok(opened.every(args=>args[1]==='_blank'&&args[2]==='noopener'));
});
