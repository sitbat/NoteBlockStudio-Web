import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeLayerUI} from '../js/native-layer-ui.js';

function fixture() {
  const pane=new EventTarget(),view=new EventTarget(),document=new EventTarget(),captures=new Set();
  pane.setPointerCapture=id=>captures.add(id);pane.hasPointerCapture=id=>captures.has(id);
  const stack={},gridScroll={scrollTop:150},state={layer:0,busy:false,selected:new Set()},song={layers:[{name:'A',locked:false},{name:'B',locked:false}],notes:[]};
  document.defaultView=view;document.getElementById=id=>({layerPane:pane,layerStack:stack,gridScroll}[id]);document.activeElement=null;
  let checkpoints=0,refreshes=0;const errors=[];
  const ui=createNativeLayerUI({document,getSong:()=>song,getState:()=>state,checkpoint:()=>checkpoints++,refresh:()=>refreshes++,error:error=>errors.push(error)});
  const row={dataset:{layer:'0'}},button={dataset:{layerAction:'locked'},disabled:false};
  row.closest=selector=>selector==='.native-layer-row'?row:null;
  button.closest=selector=>selector==='.native-layer-row'?row:selector==='[data-layer-action]'?button:null;
  const emit=(type,{id=1,x=10,y=100,target=button,pointerType='touch'}={})=>{
    const event=new Event(type,{cancelable:true});
    Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:pointerType},clientX:{value:x},clientY:{value:y},button:{value:0},target:{value:target}});
    pane.dispatchEvent(event);return event;
  };
  return {pane,view,document,gridScroll,state,song,button,row,captures,emit,ui,errors,get checkpoints(){return checkpoints;},get refreshes(){return refreshes;}};
}

test('a touch down on a layer action never changes the song, and a tap clicks once',()=>{
  const f=fixture();f.emit('pointerdown');assert.equal(f.song.layers[0].locked,false);assert.equal(f.checkpoints,0);assert.equal(f.captures.size,0);
  f.emit('pointerup');f.emit('click');assert.equal(f.song.layers[0].locked,true);assert.equal(f.checkpoints,1);assert.equal(f.refreshes,1);assert.deepEqual(f.errors,[]);f.ui.destroy();
});

test('dragging across action buttons scrolls layers instead of painting lock changes',()=>{
  const f=fixture();f.emit('pointerdown');f.emit('pointermove',{y:96});assert.equal(f.gridScroll.scrollTop,150);assert.equal(f.captures.size,0);
  f.emit('pointermove',{y:65});assert.equal(f.gridScroll.scrollTop,185);assert.ok(f.captures.has(1));
  // The child loses implicit capture as the pane takes ownership; scrolling continues.
  f.emit('lostpointercapture');f.emit('pointermove',{y:20});assert.equal(f.gridScroll.scrollTop,230);
  f.emit('pointerup',{y:20});f.emit('click',{y:20});assert.equal(f.checkpoints,0);assert.ok(f.song.layers.every(layer=>!layer.locked));assert.deepEqual(f.errors,[]);f.ui.destroy();
});

test('cancelled touches suppress a later compatibility click without a project change',()=>{
  const f=fixture();f.emit('pointerdown');f.emit('pointercancel');f.emit('click');
  assert.equal(f.checkpoints,0);assert.equal(f.song.layers[0].locked,false);assert.deepEqual(f.errors,[]);f.ui.destroy();
});

test('two fingers block sidebar edits and never resume a stale one-finger drag',()=>{
  const f=fixture();f.emit('pointerdown');f.emit('pointerdown',{id:2,y:200});f.emit('pointermove',{y:20});
  f.emit('pointerup',{id:2,y:200});f.emit('pointermove',{y:0});f.emit('pointerup',{y:0});f.emit('click');
  assert.equal(f.gridScroll.scrollTop,150);assert.equal(f.checkpoints,0);assert.equal(f.song.layers[0].locked,false);assert.deepEqual(f.errors,[]);f.ui.destroy();
});

test('name taps defer keyboard focus until release while a name swipe only scrolls',()=>{
  const f=fixture();let focuses=0;const input={closest:selector=>selector==='input'?input:selector==='.native-layer-row'?f.row:null,focus:()=>focuses++};
  f.emit('pointerdown',{target:input});assert.equal(focuses,0);f.emit('pointerup',{target:input});assert.equal(focuses,1);
  f.emit('pointerdown',{target:input});f.emit('pointermove',{target:input,y:50});f.emit('pointerup',{target:input,y:50});assert.equal(focuses,1);assert.equal(f.gridScroll.scrollTop,200);assert.deepEqual(f.errors,[]);f.ui.destroy();
});

test('an already focused name retains native selection and window blur clears touch ownership',()=>{
  const f=fixture();const input={closest:selector=>selector==='input'?input:null};f.document.activeElement=input;
  assert.equal(f.emit('pointerdown',{target:input}).defaultPrevented,false);
  f.document.activeElement=null;f.emit('pointerdown');f.emit('pointermove',{y:50});f.view.dispatchEvent(new Event('blur'));f.emit('pointermove',{y:0});
  assert.equal(f.gridScroll.scrollTop,200);f.emit('click');assert.equal(f.checkpoints,0);assert.deepEqual(f.errors,[]);f.ui.destroy();
});

test('desktop brushes keep their original immediate and once-per-gesture behavior',()=>{
  const f=fixture();f.emit('pointerdown',{pointerType:'mouse'});assert.equal(f.song.layers[0].locked,true);assert.equal(f.checkpoints,1);
  f.emit('pointerup',{pointerType:'mouse'});f.emit('click',{pointerType:'mouse'});assert.equal(f.song.layers[0].locked,true);assert.equal(f.checkpoints,1);assert.deepEqual(f.errors,[]);f.ui.destroy();
});
