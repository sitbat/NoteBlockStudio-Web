import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNativeMenuModel} from '../js/native-menus.js';
const flatten=menus=>menus.flatMap(menu=>menu.items||[]).filter(Boolean).flatMap(item=>[item,...(item.children?flatten([{items:item.children}]):[])]);
const find=(model,id)=>flatten(model).find(item=>item.action===id);

test('empty selection, history and clipboard state disable destructive actions without disabling open/help',()=>{
  const model=buildNativeMenuModel({selectedCount:0,noteCount:0,canUndo:false,canRedo:false,clipboard:null});
  for(const action of ['undo','redo','copy','cut','paste','delete','exportPattern','increaseFine','minecraftDatapack'])assert.equal(find(model,action).disabled,true,action);
  assert.notEqual(find(model,'open').disabled,true);assert.notEqual(find(model,'help').disabled,true);
  const player=buildNativeMenuModel({playerMode:true,selectedCount:12,noteCount:50});assert.equal(player.find(menu=>menu.name==='edit').disabled,true);assert.equal(find(player,'new').disabled,true);assert.notEqual(find(player,'open').disabled,true);
});

test('mode actions carry native coarse/fine units and set/reset only for non-key properties',()=>{
  const key=buildNativeMenuModel({selectedCount:1,editMode:'key'});assert.match(find(key,'increaseCoarse').label,/八度/);assert.match(find(key,'increaseFine').label,/半音/);assert.equal(find(key,'setModeProperty'),undefined);
  const velocity=buildNativeMenuModel({selectedCount:1,editMode:1});assert.match(find(velocity,'increaseCoarse').label,/10 力度/);assert.match(find(velocity,'increaseFine').label,/1 力度/);assert.equal(find(velocity,'setModeProperty').disabled,false);
  const pitch=buildNativeMenuModel({selectedCount:0,editMode:'pitch'});assert.match(find(pitch,'decreaseCoarse').label,/10 音分/);assert.equal(find(pitch,'resetModeProperty').disabled,true);
});

test('large custom instrument menus retain every instrument once per action and only mark the selected choice',()=>{
  const instruments=Array.from({length:256},(_,id)=>({id,name:id<16?`原生${id}`:`自定义${id}`}));
  const model=buildNativeMenuModel({selectedCount:10,noteCount:12,instrument:250},instruments);
  const settings=model.find(menu=>menu.name==='settings'),choose=find([settings],'chooseInstrument');
  const choices=flatten([{items:choose.children}]).filter(item=>item.kind==='instrument');assert.equal(choices.length,256);assert.equal(new Set(choices.map(item=>item.value)).size,256);assert.deepEqual(choices.filter(item=>item.checked).map(item=>item.value),[250]);
  const change=find(model,'changeInstrument'),changes=flatten([{items:change.children}]).filter(item=>item.kind==='instrument');assert.equal(changes.length,256);assert.ok(changes.every(item=>item.applyToSelection&&!Object.hasOwn(item,'checked')));
  assert.equal(flatten(model).filter(item=>item.kind==='macro').length,15);
});

test('instrument shortcut labels follow live GML handlers instead of the inconsistent translated menu strings',()=>{
  const model=buildNativeMenuModel({selectedCount:1},Array.from({length:16},(_,id)=>({id,name:String(id)})));
  const choose=find(model,'chooseInstrument'),choices=flatten([{items:choose.children}]).filter(item=>item.kind==='instrument');
  assert.deepEqual(choices.map(item=>item.shortcut),[...Array.from({length:9},(_,i)=>`Ctrl+${i+1}`),...Array.from({length:7},(_,i)=>`Ctrl+Shift+${i+1}`)]);
  assert.equal(find(model,'macro:tremolo').shortcut,'Ctrl+Shift+A');assert.equal(find(model,'macro:reset-properties').shortcut,'Ctrl+Shift+U');
  assert.equal(find(model,'patterns').shortcut,'Ctrl+Shift+P');assert.equal(find(model,'tempoTap').shortcut,'Ctrl+Shift+I');
});
