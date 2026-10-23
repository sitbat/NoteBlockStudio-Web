import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNBS,writeNBS} from '../js/formats.js';
import {createBlankSong} from '../js/model.js';
import {encodeProjectEffects,decodeProjectEffects} from '../js/project-effects.js';

test('NBS extension restores independent track reverb and editing state without discarding foreign bytes',()=>{
  const song=createBlankSong();
  song.layers[0].reverb=45; song.layers[1].reverb=100;
  Object.assign(song.layers[2],{muted:true,volume:73,solo:true,locked:true});
  song.metadata.trailingBytes=[192,255,238];
  const roundtrip=parseNBS(writeNBS(song));
  assert.equal(roundtrip.layers[0].reverb,45); assert.equal(roundtrip.layers[1].reverb,100);
  assert.equal(roundtrip.layers[2].muted,true); assert.equal(roundtrip.layers[2].volume,73);
  assert.equal(roundtrip.layers[2].solo,true); assert.equal(roundtrip.layers[2].locked,true);
  assert.deepEqual(roundtrip.metadata.trailingBytes,[192,255,238]);
  assert.deepEqual(parseNBS(writeNBS(roundtrip)).layers,roundtrip.layers);
});

test('standard-only NBS export omits the effect extension and retains native mute behavior',()=>{
  const song=createBlankSong();song.layers[0].reverb=50;song.layers[0].muted=true;
  const parsed=parseNBS(writeNBS(song,{webExtensions:false}));
  assert.equal(parsed.layers[0].reverb,undefined);assert.equal(parsed.layers[0].volume,0);
  assert.equal(parsed.metadata.webEffectsVersion,undefined);
});

test('corrupted or unsupported extension is preserved untouched and never partially applies controls',()=>{
  const bytes=encodeProjectEffects([{reverb:50}]);
  const layers=[{reverb:12}];
  bytes[0]=0xff;
  const result=decodeProjectEffects(bytes,layers);
  assert.equal(result.restored,false);assert.deepEqual(result.remaining,Array.from(bytes));assert.equal(layers[0].reverb,12);
  const truncated=bytes.slice(4);assert.equal(decodeProjectEffects(truncated,layers).restored,false);
});

test('ten thousand tracks and per-track effects survive an NBS file roundtrip',()=>{
  const song=createBlankSong();song.length=2;
  song.layers=Array.from({length:10000},(_,id)=>({id,name:`轨 ${id}`,volume:100,pan:0,reverb:id%101}));
  song.notes=Array.from({length:10000},(_,layer)=>({id:`n${layer}`,layer,tick:0,key:45,instrument:0,velocity:100,pan:0,pitch:0}));
  const parsed=parseNBS(writeNBS(song));
  assert.equal(parsed.layers.length,10000);assert.equal(parsed.notes.length,10000);
  assert.equal(parsed.layers[9999].reverb,9999%101);assert.equal(parsed.notes[9999].layer,9999);
});

test('native lock=1 mutes while solo=2 stays audible, and a Web edit-lock remains independent',()=>{
  const song=createBlankSong();song.layers[0].locked=true;song.layers[1].solo=true;
  const native=parseNBS(writeNBS(song,{webExtensions:false}));
  assert.equal(native.layers[0].locked,true);assert.equal(native.layers[0].muted,true);assert.equal(native.layers[1].solo,true);assert.equal(native.layers[1].muted,false);
  const web=parseNBS(writeNBS(song));assert.equal(web.metadata.webEffectsVersion,1);assert.equal(web.layers[0].locked,true);assert.equal(web.layers[0].muted,false);
  for(const version of [0,1,2,3,4,5]){const restored=parseNBS(writeNBS(song,{version}));assert.equal(restored.layers[0].locked,true);assert.equal(restored.layers[0].muted,false);}
});
test('a valid older Web footer keeps unlisted lock flags as edit-lock; a corrupt footer never unmutes native tracks',()=>{
  const song=createBlankSong();song.layers[0].locked=true;
  const native=writeNBS(song,{webExtensions:false});
  const olderFooter=encodeProjectEffects([{locked:false,reverb:0},{reverb:20,volume:100,muted:false,solo:false,locked:false}]);
  const bytes=new Uint8Array(native.length+olderFooter.length);bytes.set(native);bytes.set(olderFooter,native.length);
  const restored=parseNBS(bytes);assert.equal(restored.layers[0].locked,true);assert.equal(restored.layers[0].muted,false);assert.equal(restored.layers[1].reverb,20);
  bytes[native.length]=255;const corrupted=parseNBS(bytes);assert.equal(corrupted.metadata.webEffectsVersion,undefined);assert.equal(corrupted.layers[0].muted,true);assert.equal(corrupted.layers[1].muted,false);
});
