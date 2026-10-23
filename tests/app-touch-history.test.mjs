import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {History,MAX_NOTES,uniqueId} from '../js/model.js';
import {bounds} from '../js/edit.js';
import {createTouchGridController} from '../js/touch-grid.js';

// Run the editor's actual input and history functions with a small view adapter.
// This checks the app/controller contract without starting audio or IndexedDB.
const source=readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`editor boundary: ${start}`);return source.slice(a,b);}
const code=section('function checkpoint(', 'function refresh(')+section('function point(event)',"$('gridScroll').addEventListener('pointerdown'")+ '\nglobalThis.input=touchGrid;';
const touch=(pointerId,clientX,clientY)=>({pointerId,pointerType:'touch',button:0,clientX,clientY,preventDefault(){}});
function fixture(tool='draw') {
  const song={title:'Original',length:16,customInstruments:[],metadata:{leftClicks:2},layers:[{id:0,name:'A',locked:false,reverb:10},{id:1,name:'B',locked:false,reverb:80}],notes:[{id:'original',tick:4,layer:0,key:45,instrument:0},{id:'other',tick:8,layer:1,key:50,instrument:0}]};
  const state={tool,selected:new Set(['other']),layer:1,cell:32,snap:1,key:39,instrument:0,velocity:100,pan:0,pitch:0,busy:false,gesture:null};
  const scroll={scrollLeft:0,scrollTop:0,getBoundingClientRect:()=>({left:0,top:0}),focus(){}},elements={gridScroll:scroll,zoomLabel:{},gridSpacer:{style:{}}};
  const context={song,state,history:new History(70),sampleUndo:[],sampleRedo:[],engine:{customSamples:new Map([[16,{id:'sample'}]])},touchTransaction:null,touchPan:false,playerMode:false,cellIndex:new Map(),canvasWidth:800,canvasHeight:400,ROW:32,MAX_NOTES,uniqueId,bounds,createTouchGridController,structuredClone,Map,Set,clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),$:id=>elements[id],totalTicks:()=>128,toast(){},audition(){},chooseInstrument(){},renderInspector(){},updateCursorStatus(){},renderLayers(){},scheduleDraw(){}};
  context.editableNotes=()=>context.song.notes.filter(note=>state.selected.has(note.id)&&!context.song.layers[note.layer]?.locked);
  const saves=[];context.refresh=options=>{context.cellIndex=new Map(context.song.notes.map(note=>[`${note.tick}:${note.layer}`,note]));if(options?.save)saves.push(structuredClone(context.song));};context.refresh();
  vm.runInNewContext(code,context,{filename:'app-touch-input'});
  return {context,state,scroll,saves,input:context.input,original:structuredClone(song)};
}

test('cancelled drawing restores notes, selection and metadata while preserving redo and sample history',()=>{
  const f=fixture(),c=f.context;c.history.push(c.song);c.song=c.history.undo({...c.song,title:'Redo target'});const redoSamples=new Map([[16,{id:'redo sample'}]]);c.sampleRedo.push(redoSamples);c.refresh();
  f.input.down(touch(1,33,12));f.input.move(touch(1,70,12));f.input.move(touch(1,101,12));assert.equal(c.song.notes.length,5);assert.equal(c.history.undoDepth,0);
  f.input.down(touch(2,180,60));assert.deepEqual(c.song,f.original);assert.deepEqual([...f.state.selected],['other']);assert.equal(f.state.layer,1);
  assert.equal(c.history.redoDepth,1);assert.equal(c.sampleRedo[0],redoSamples);assert.equal(c.sampleUndo.length,0);assert.equal(c.touchTransaction,null);assert.equal(f.state.gesture,null);
  f.input.up(touch(2,180,60));f.input.up(touch(1,101,12));assert.equal(c.history.redo(c.song).title,'Redo target');
});

test('a completed continuous touch drawing stroke records one original snapshot and one sample snapshot',()=>{
  const f=fixture(),c=f.context;f.input.down(touch(1,33,12));f.input.move(touch(1,70,12));f.input.move(touch(1,101,12));f.input.up(touch(1,101,12));f.input.cancel(touch(1,101,12));
  assert.equal(c.song.notes.length,5);assert.equal(c.history.undoDepth,1);assert.equal(c.sampleUndo.length,1);assert.equal(c.sampleUndo[0].get(16),c.engine.customSamples.get(16));assert.equal(c.touchTransaction,null);assert.equal(f.state.gesture,null);
  assert.deepEqual(c.history.undo(c.song),f.original);assert.equal(f.saves.length,1);
});

test('a touch tap commits on release and no-op erase leaves redo available',()=>{
  const draw=fixture();draw.input.down(touch(1,33,12));assert.equal(draw.context.song.notes.length,2);draw.input.up(touch(1,33,12));assert.equal(draw.context.song.notes.length,3);assert.equal(draw.context.history.undoDepth,1);
  const erase=fixture('erase'),c=erase.context;c.history.push(c.song);c.song=c.history.undo({...c.song,title:'Redo retained'});c.refresh();erase.input.down(touch(1,33,12));erase.input.up(touch(1,33,12));
  assert.equal(c.history.undoDepth,0);assert.equal(c.history.redoDepth,1);assert.equal(c.sampleUndo.length,0);assert.equal(c.touchTransaction,null);
});

test('canceling a note move restores occupied destination and the prior selection',()=>{
  const f=fixture(),c=f.context;f.input.down(touch(1,129,12));f.input.move(touch(1,257,44));
  assert.equal(c.song.notes.find(note=>note.id==='original').layer,1);assert.equal(c.song.notes.find(note=>note.id==='original').tick,8);
  f.input.cancel(touch(1,257,44));assert.deepEqual(c.song,f.original);assert.deepEqual([...f.state.selected],['other']);assert.equal(c.history.undoDepth,0);assert.equal(c.sampleUndo.length,0);
});

test('committed movement resolves destination collisions once and undo recovers both notes',()=>{
  const f=fixture(),c=f.context;f.input.down(touch(1,129,12));f.input.move(touch(1,257,44));f.input.up(touch(1,257,44));
  assert.equal(c.song.notes.length,1);assert.equal(c.song.notes[0].id,'original');assert.equal(c.history.undoDepth,1);assert.deepEqual(c.history.undo(c.song),f.original);
});

test('cancelled selection-only gesture restores selection without adding project history',()=>{
  const f=fixture('select'),c=f.context;f.input.down(touch(1,20,8));f.input.move(touch(1,180,30));assert.ok(f.state.selected.has('original'));
  f.input.reset();assert.deepEqual([...f.state.selected],['other']);assert.deepEqual(c.song,f.original);assert.equal(c.history.undoDepth,0);assert.equal(c.touchTransaction,null);
});

test('pan and pending pinch never start a transaction, checkpoint or persist tentative notes',()=>{
  const f=fixture(),c=f.context;c.touchPan=true;f.input.down(touch(1,100,100));f.input.move(touch(1,60,50));f.input.up(touch(1,60,50));
  c.touchPan=false;f.input.down(touch(2,100,100));f.input.down(touch(3,200,100));f.input.move(touch(3,220,100));f.input.reset();
  assert.equal(c.touchTransaction,null);assert.equal(c.history.undoDepth,0);assert.deepEqual(c.song,f.original);assert.equal(f.saves.length,0);
});
