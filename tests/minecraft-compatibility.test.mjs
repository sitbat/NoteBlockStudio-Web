import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMinecraftCompatibility} from '../js/minecraft-compatibility.js';
import {createTempoMap} from '../js/tempo-map.js';

const note=extra=>({id:'note',tick:0,layer:0,instrument:0,key:45,pitch:0,velocity:100,pan:0,...extra});
const song=extra=>({tempo:10,length:16,layers:[{id:0,volume:100,pan:0,muted:false,solo:false,locked:false}],customInstruments:[],notes:[note()],...extra});

test('the original three tempos and inclusive piano range are fully compatible; other tempo or any pitch requires commands',()=>{
  for(const tempo of [10,5,2.5]){
    const compatible=analyzeMinecraftCompatibility(song({tempo,notes:[note({key:33}),note({key:57,instrument:15})]}));
    assert.equal(compatible.level,'full');assert.deepEqual(compatible.frames,[0,0]);assert.ok(compatible.label);assert.ok(compatible.reason);
  }
  const tempo=analyzeMinecraftCompatibility(song({tempo:8}));assert.equal(tempo.level,'datapack');assert.deepEqual(tempo.frames,[1,0]);assert.match(tempo.reason,/速度/);
  for(const pitch of [-100,1]){const result=analyzeMinecraftCompatibility(song({notes:[note({pitch})]}));assert.equal(result.level,'datapack');assert.match(result.reason,/微调音高/);}
});

test('used custom audio and either out-of-range boundary take resource-pack precedence, including muted layers',()=>{
  const s=song({tempo:8,layers:[{muted:true}],customInstruments:[{name:'Sample',file:'sample.ogg',key:45}],notes:[note({instrument:16}),note({key:32}),note({key:58,pitch:1})]}),before=JSON.stringify(s),result=analyzeMinecraftCompatibility(s);
  assert.equal(result.level,'resourcepack');assert.deepEqual(result.frames,[1,2]);assert.match(result.reason,/自定义采样/);assert.match(result.reason,/33–57/);assert.equal(JSON.stringify(s),before);
  assert.equal(analyzeMinecraftCompatibility(song({customInstruments:s.customInstruments})).level,'full','unused definitions do not create an audio requirement');
  for(const key of [32,58])assert.equal(analyzeMinecraftCompatibility(song({notes:[note({key})]})).level,'resourcepack');
});

test('Tempo Changer and Toggle Rainbow remain named controls rather than missing custom audio, even with a compiled tempo map',()=>{
  const s=song({customInstruments:[{name:'Tempo Changer',file:''},{name:'Toggle Rainbow',file:''},{name:'Bell',file:'bell.ogg'}],notes:[note({instrument:16,key:0,pitch:300,tick:4}),note({instrument:17,key:87,pitch:-200,tick:8})]});
  assert.ok(createTempoMap(s));const result=analyzeMinecraftCompatibility(s);assert.equal(result.level,'datapack');assert.deepEqual(result.frames,[1,0]);assert.match(result.reason,/Tempo Changer/);assert.match(result.reason,/Toggle Rainbow/);assert.match(result.reason,/不是音频资源/);assert.doesNotMatch(result.reason,/自定义采样|33–57/);
  assert.equal(analyzeMinecraftCompatibility({...s,notes:[...s.notes,note({instrument:18})]}).level,'resourcepack');
  assert.equal(analyzeMinecraftCompatibility({...s,customInstruments:[{name:'tempo changer',file:''}],notes:[note({instrument:16})]}).level,'resourcepack','special-name matching agrees exactly with playback controlType');
});
