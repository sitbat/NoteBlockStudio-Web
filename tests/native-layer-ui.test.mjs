import test from 'node:test';
import assert from 'node:assert/strict';
import {applyNativeLayerEdit,nativeLayerRange,createNativeLayerBrush} from '../js/native-layer-ui.js';
import {MAX_LAYERS,History} from '../js/model.js';
const fixture=()=>({layers:[{id:0,name:'A',volume:100,pan:0,reverb:15},{id:1,name:'B',volume:60,pan:-20},{id:2,name:'C'}],notes:[{id:'a',tick:0,layer:0,key:45},{id:'b',tick:0,layer:1,key:50},{id:'c',tick:2,layer:2,key:51}]});

test('10000-layer virtual windows clamp both boundaries and request only visible rows',()=>{
  assert.deepEqual(nativeLayerRange(10000,9990,10030),{start:9990,end:10000});
  assert.deepEqual(nativeLayerRange(10000,-10,22),{start:0,end:22});
  assert.deepEqual(nativeLayerRange(10000,300,200),{start:300,end:300});
  assert.deepEqual(nativeLayerRange(0,0,20),{start:0,end:0});
  assert.deepEqual(nativeLayerRange(10000,99999,100000),{start:10000,end:10000});
});

test('deleting a middle layer removes only its notes, remaps later rows and is undoable',()=>{
  const song=fixture(),history=new History(2),oldNotes=song.notes,oldLayers=song.layers;
  const result=applyNativeLayerEdit(song,{index:1,operation:'delete'},()=>history.push(song));
  assert.deepEqual(result,{changed:true,layer:1});assert.deepEqual(song.layers.map(l=>[l.id,l.name]),[[0,'A'],[1,'C']]);
  assert.deepEqual(song.notes.map(n=>[n.id,n.layer]),[['a',0],['c',1]]);assert.equal(oldNotes[2].layer,2);assert.equal(oldLayers.length,3);
  assert.deepEqual(history.undo(song),{...fixture()});
});

test('10000th row delete and insert keep the active index and valid references',()=>{
  const song={layers:Array.from({length:10000},(_,id)=>({id,name:String(id)})),notes:[{id:'end',tick:0,layer:9999}]};
  assert.deepEqual(applyNativeLayerEdit(song,{index:9999,operation:'delete'}),{changed:true,layer:9998});assert.equal(song.layers.length,9999);assert.equal(song.notes.length,0);
  const result=applyNativeLayerEdit(song,{index:9998,operation:'insert'});assert.equal(result.layer,9998);assert.equal(song.layers.length,10000);assert.equal(song.layers[9999].name,'9998');
});

test('locked, final-row, capacity and invalid-reference failures are atomic and create no history',()=>{
  let checkpoints=0;const before=()=>checkpoints++;
  const song=fixture();song.layers[1].locked=true;const snapshot=structuredClone(song),layers=song.layers,notes=song.notes;
  assert.throws(()=>applyNativeLayerEdit(song,{index:1,operation:'delete'},before),/解锁/);
  assert.throws(()=>applyNativeLayerEdit(song,{index:0,operation:'down'},before),/解锁/);assert.deepEqual(song,snapshot);assert.equal(song.layers,layers);assert.equal(song.notes,notes);
  const single={layers:[{name:'only'}],notes:[]};assert.throws(()=>applyNativeLayerEdit(single,{index:0,operation:'delete'},before),/至少/);
  const full={layers:Array.from({length:MAX_LAYERS},(_,id)=>({id})),notes:[]};assert.throws(()=>applyNativeLayerEdit(full,{index:0,operation:'insert'},before),/上限/);
  song.layers[1].locked=false;song.notes[1].layer=123;assert.throws(()=>applyNativeLayerEdit(song,{index:1,operation:'delete'},before),/引用/);assert.equal(checkpoints,0);
});

test('live field updates validate and clamp before one caller-owned gesture checkpoint',()=>{
  const song=fixture();let checkpoints=0,started=false;const before=()=>{if(!started){checkpoints++;started=true;}};
  for(const value of [70,60,40,30])applyNativeLayerEdit(song,{index:0,operation:'volume',value},before);
  assert.equal(song.layers[0].volume,30);assert.equal(checkpoints,1);assert.equal(song.layers[0].reverb,15);
  applyNativeLayerEdit(song,{index:0,operation:'pan',value:-500});assert.equal(song.layers[0].pan,-100);
  applyNativeLayerEdit(song,{index:0,operation:'reverb',value:222});assert.equal(song.layers[0].reverb,100);
  assert.throws(()=>applyNativeLayerEdit(song,{index:0,operation:'volume',value:NaN},()=>{throw Error('should not checkpoint');}),/有限/);
  assert.deepEqual(applyNativeLayerEdit(song,{index:0,operation:'volume',value:30},()=>{throw Error('no-op history');}),{changed:false,layer:0});
});

test('inline names keep literal markup as data, and edit-lock remains separate from mute/solo',()=>{
  const song=fixture();for(const operation of ['locked','muted','solo'])applyNativeLayerEdit(song,{index:0,operation,value:true});
  applyNativeLayerEdit(song,{index:0,operation:'name',value:'<img src=x onerror=alert(1)>'});
  assert.equal(song.layers[0].name,'<img src=x onerror=alert(1)>');assert.equal(song.layers[0].locked,true);assert.equal(song.layers[0].muted,true);assert.equal(song.layers[0].solo,true);
  applyNativeLayerEdit(song,{index:0,operation:'locked',value:false});assert.equal(song.layers[0].muted,true);assert.equal(song.layers[0].solo,true);
});

test('boundary movement is a no-op without history while moving settings follows note ownership',()=>{
  const song=fixture();assert.deepEqual(applyNativeLayerEdit(song,{index:0,operation:'up'},()=>{throw Error('boundary history');}),{changed:false,layer:0});
  let checkpoints=0;applyNativeLayerEdit(song,{index:0,operation:'down'},()=>checkpoints++);
  assert.equal(checkpoints,1);assert.equal(song.layers[1].name,'A');assert.equal(song.layers[1].reverb,15);assert.equal(song.notes.find(n=>n.id==='a').layer,1);
});

function brushFixture(operation,index=0,song=fixture(),selected=[]){
  let current=song;const history=new History(2),state={layer:index,selected:new Set(selected)};let checkpoints=0;
  const brush=createNativeLayerBrush({getSong:()=>current,getState:()=>state,checkpoint:()=>{checkpoints++;history.push(song);}},{operation,index});
  return {song,state,history,brush,get checkpoints(){return checkpoints;},replace:()=>current=fixture()};
}
test('a 10000-layer brush paints one lock target with one undo checkpoint and never retoggles re-entered rows',()=>{
  const song={layers:Array.from({length:10000},(_,id)=>({id,locked:id%2===1})),notes:[]},f=brushFixture('locked',0,song);
  for(let index=0;index<10000;index++)f.brush.visit(index);
  for(const index of [0,9999,100,500])assert.equal(f.brush.visit(index).changed,false);
  assert.ok(song.layers.every(layer=>layer.locked));assert.equal(f.checkpoints,1);assert.equal(f.brush.savesProject,true);
  assert.equal(f.history.undo(song).layers[2].locked,false);
});
test('solo removal uses the first layer target on mixed rows instead of toggling each row independently',()=>{
  const f=brushFixture('solo');f.song.layers[0].solo=true;
  // The target is captured when the gesture begins, before any row changes.
  const g=brushFixture('solo',0,f.song);for(const index of [0,1,2,1])g.brush.visit(index);
  assert.ok(g.song.layers.every(layer=>!layer.solo));assert.equal(g.checkpoints,1);
});
test('selection brushes add or remove consistently while leaving project history untouched',()=>{
  const add=brushFixture('select',0,fixture(),['b']);for(const index of [0,1,2,0])add.brush.visit(index);
  assert.deepEqual([...add.state.selected].sort(),['a','b','c']);assert.equal(add.checkpoints,0);assert.equal(add.brush.savesProject,false);
  const remove=brushFixture('select',0,fixture(),['a','c']);for(const index of [0,1,2])remove.brush.visit(index);
  assert.equal(remove.state.selected.size,0);assert.equal(remove.checkpoints,0);
});
test('insert brush remembers original and inserted identities after atomic row cloning',()=>{
  const f=brushFixture('insert',1);f.brush.visit(1);assert.equal(f.song.layers.length,4);assert.deepEqual([f.song.layers[0].name,f.song.layers[2].name,f.song.layers[3].name],['A','B','C']);
  assert.equal(f.brush.visit(1).changed,false,'the new row must not recursively insert');assert.equal(f.brush.visit(2).changed,false,'the original B row already received its insertion');
  assert.equal(f.brush.visit(3).changed,true);assert.equal(f.song.layers.length,5);assert.equal(f.checkpoints,1);
  assert.deepEqual(f.history.undo(f.song),fixture());
});
test('move and delete brushes follow layer ownership, retain final-row boundaries and stop on project replacement',()=>{
  const up=brushFixture('up',1);assert.equal(up.brush.visit(1).changed,true);assert.equal(up.brush.visit(0).changed,false,'B moved upward and cannot be processed twice');assert.equal(up.brush.visit(2).changed,true);assert.deepEqual(up.song.layers.map(layer=>layer.name),['B','C','A']);assert.equal(up.checkpoints,1);
  const del=brushFixture('delete',0);del.brush.visit(0);assert.equal(del.brush.visit(1).changed,true);assert.deepEqual(del.song.layers.map(layer=>layer.name),['B']);assert.equal(del.brush.visit(0).changed,false);assert.equal(del.checkpoints,1);assert.deepEqual(del.history.undo(del.song),fixture());
  const changed=brushFixture('locked');changed.replace();assert.equal(changed.brush.visit(0).changed,false);assert.equal(changed.checkpoints,0);
});
test('brush structure actions respect locked rows and edge boundaries without empty history',()=>{
  const song=fixture();song.layers[1].locked=true;
  const up=brushFixture('up',0,song);assert.equal(up.brush.visit(0).changed,false);assert.equal(up.brush.visit(1).changed,false);assert.equal(up.brush.visit(2).changed,false);assert.equal(up.checkpoints,0);
  const del=brushFixture('delete',1,song);assert.equal(del.brush.visit(1).changed,false);assert.equal(del.checkpoints,0);
});
