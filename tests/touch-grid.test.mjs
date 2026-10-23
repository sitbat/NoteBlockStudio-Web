import test from 'node:test';
import assert from 'node:assert/strict';
import {createTouchGridController} from '../js/touch-grid.js';

const touch=(pointerId,clientX,clientY,extra={})=>({pointerId,pointerType:'touch',clientX,clientY,button:0,...extra});
function fixture(mode='edit',view={left:10,top:20,scrollLeft:200,scrollTop:300,cell:32}) {
  const calls=[],transforms=[];
  const controller=createTouchGridController({getMode:()=>mode,getViewport:()=>view,transform:next=>{transforms.push(next);Object.assign(view,next);},...Object.fromEntries(['beginEdit','moveEdit','endEdit','cancelEdit'].map(name=>[name,event=>calls.push([name,event.pointerId,event.clientX,event.clientY])]))});
  return {controller,calls,transforms,view};
}

test('a tap commits once on release, with its original grid position',()=>{
  const {controller,calls}=fixture();
  assert.equal(controller.down(touch(1,40,50)),true);assert.deepEqual(calls,[]);
  controller.move(touch(1,43,54));assert.deepEqual(calls,[]);
  controller.up(touch(1,43,54));
  assert.deepEqual(calls,[['beginEdit',1,40,50],['endEdit',1,43,54]]);
  assert.equal(controller.up(touch(1,43,54)),false);
});

test('a single-finger stroke begins at the initial cell after intent threshold',()=>{
  const {controller,calls}=fixture();controller.down(touch(3,40,50));
  controller.move(touch(3,60,50));controller.move(touch(3,80,50));controller.up(touch(3,80,50));
  assert.deepEqual(calls,[['beginEdit',3,40,50],['moveEdit',3,60,50],['moveEdit',3,80,50],['endEdit',3,80,50]]);
});

test('pending edit becomes two-finger navigation without ever creating a note',()=>{
  const {controller,calls,transforms}=fixture();
  controller.down(touch(1,50,60));controller.down(touch(2,150,60));controller.move(touch(2,170,60));
  controller.up(touch(2,170,60));controller.move(touch(1,70,60));controller.up(touch(1,70,60));
  assert.deepEqual(calls,[]);assert.equal(transforms.length,1);
  controller.down(touch(5,70,60));controller.up(touch(5,70,60));assert.equal(calls.length,2);
});

test('second touch cancels an active stroke once and never resumes editing on lift',()=>{
  const {controller,calls}=fixture();
  controller.down(touch(1,50,60));controller.move(touch(1,80,60));controller.down(touch(2,150,60));
  controller.up(touch(1,80,60));controller.move(touch(2,160,60));controller.up(touch(2,160,60));
  assert.deepEqual(calls.map(call=>call[0]),['beginEdit','moveEdit','cancelEdit']);
});

test('pan mode drags the viewport and creates no edit callbacks',()=>{
  const {controller,calls,transforms}=fixture('pan');
  controller.down(touch(1,100,100));controller.move(touch(1,70,80));controller.move(touch(1,60,60));controller.up(touch(1,60,60));
  assert.deepEqual(calls,[]);assert.deepEqual(transforms,[{cell:32,scrollLeft:230,scrollTop:320},{cell:32,scrollLeft:240,scrollTop:340}]);
});

test('pinch preserves its content anchor while its midpoint also pans',()=>{
  const {controller,view}=fixture();
  controller.down(touch(1,50,60));controller.down(touch(2,150,60));
  const anchor=(200+100-10)/32;
  controller.move(touch(1,30,80));controller.move(touch(2,230,80));
  assert.equal(view.cell,64);assert.equal(view.scrollLeft,anchor*64-130+10);assert.equal(view.scrollTop,280);
});

test('pinch zoom and scroll clamp to safe bounds',()=>{
  const {controller,view}=fixture('edit',{left:0,top:0,scrollLeft:0,scrollTop:0,cell:32});
  controller.down(touch(1,0,0));controller.down(touch(2,100,0));controller.move(touch(2,10000,10000));
  assert.equal(view.cell,80);assert.equal(view.scrollLeft,0);assert.equal(view.scrollTop,0);
  controller.move(touch(2,.01,0));assert.equal(view.cell,1);
});

test('pointer cancellation or reset never turns an uncommitted contact into an edit',()=>{
  const {controller,calls}=fixture();
  controller.down(touch(1,40,50));controller.cancel(touch(1,40,50));
  controller.down(touch(2,40,50));controller.reset();controller.up(touch(2,40,50));
  assert.deepEqual(calls,[]);
  controller.down(touch(3,40,50));controller.move(touch(3,70,50));controller.reset();controller.reset();
  assert.deepEqual(calls.map(call=>call[0]),['beginEdit','moveEdit','cancelEdit']);
});

test('three-finger transitions rebase pinch and do not cause jumps or edits',()=>{
  const {controller,calls,view}=fixture();
  controller.down(touch(1,50,60));controller.down(touch(2,150,60));controller.move(touch(2,170,60));
  const before={...view};controller.down(touch(3,300,300));controller.move(touch(3,1000,1000));assert.deepEqual(view,before);
  controller.up(touch(3,1000,1000));controller.move(touch(1,50,60));assert.deepEqual(view,before);
  controller.cancel(touch(2,170,60));controller.up(touch(1,50,60));assert.deepEqual(calls,[]);
});

test('mouse, pen, unknown pointer endings and duplicate contact downs are safe',()=>{
  const {controller,calls}=fixture();
  for(const pointerType of ['mouse','pen'])assert.equal(controller.down(touch(1,40,50,{pointerType})),false);
  assert.equal(controller.move(touch(9,20,20)),false);assert.equal(controller.cancel(touch(9,20,20)),false);
  controller.down(touch(1,40,50));controller.down(touch(1,400,500));controller.up(touch(1,40,50));
  assert.deepEqual(calls,[['beginEdit',1,40,50],['endEdit',1,40,50]]);
});
