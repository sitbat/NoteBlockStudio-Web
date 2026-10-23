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
