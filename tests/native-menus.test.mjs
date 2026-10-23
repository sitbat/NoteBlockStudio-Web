import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNativeMenuModel,createNativeMenus} from '../js/native-menus.js';
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

function menuFixture({width=390,coarse=false}={}){
  const document={activeElement:null},listeners=()=>new Map();
  const events=target=>{
    target.listeners=listeners();
    target.addEventListener=(type,fn)=>target.listeners.set(type,[...(target.listeners.get(type)||[]),fn]);
    target.removeEventListener=(type,fn)=>target.listeners.set(type,(target.listeners.get(type)||[]).filter(value=>value!==fn));
    target.fire=(type,fields={})=>{const event={target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...fields};for(const fn of target.listeners.get(type)||[])fn(event);return event;};return target;
  };
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.dataset={};this.style={};this.className='';this.textContent='';this.disabled=false;events(this);this.classList={contains:name=>this.className.split(' ').includes(name),add:name=>{if(!this.classList.contains(name))this.className+=` ${name}`;},remove:name=>this.className=this.className.split(' ').filter(value=>value!==name).join(' '),toggle:(name,force)=>{if(force??!this.classList.contains(name))this.classList.add(name);else this.classList.remove(name);}};}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    setAttribute(name,value){this.attrs[name]=String(value);}
    getAttribute(name){return this.attrs[name]??null;}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    focus(){document.activeElement=this;}
    scrollIntoView(){}
    getBoundingClientRect(){return {left:12,top:10,right:112,bottom:34,width:100,height:220};}
    querySelector(selector){return all(this).find(element=>selector[0]==='.'&&element.classList.contains(selector.slice(1)))||null;}
  }
  const all=element=>element.children.flatMap(child=>[child,...all(child)]);
  document.body=new Element('body');document.createElement=tag=>new Element(tag);document.getElementById=id=>all(document.body).find(element=>element.id===id)||null;events(document);
  const media=events({matches:coarse}),view=events({innerWidth:width,innerHeight:800,matchMedia:()=>media});document.defaultView=view;
  for(const id of ['fileMenuBtn','editMenuBtn','viewMenuBtn','helpMenuBtn']){const button=new Element('button');button.id=id;document.body.append(button);}
  const chosen=[],actions=new Proxy({},{get:(_,action)=>value=>chosen.push({action,value})});
  const menus=createNativeMenus(actions,{document,getState:()=>({selectedCount:1,noteCount:10}),getInstruments:()=>Array.from({length:51},(_,id)=>({id,name:`音色 ${id}`}))});
  return {document,view,media,menus,chosen,all:()=>all(document.body),panels:()=>all(document.body).filter(element=>element.getAttribute('role')==='menu'),action:name=>all(document.body).find(element=>element.dataset.action===name)};
}

test('compact menus use one visible sheet and explicit back/close without hover navigation',()=>{
  const f=menuFixture();f.menus.open('settings');const root=f.panels()[0],choose=f.action('chooseInstrument');
  assert.equal(root.classList.contains('native-menu-sheet'),true);choose.fire('pointerenter',{pointerType:'touch'});assert.equal(f.panels().length,1,'touch entry must wait for a tap');
  choose.fire('click');assert.equal(f.panels().length,2);assert.equal(root.hidden,true);assert.equal(f.panels().at(-1).hidden,false);
  f.action('instruments-more:25').fire('click');assert.equal(f.panels().length,3);assert.equal(f.panels().filter(panel=>!panel.hidden).length,1);
  const child=f.panels().at(-1);child.querySelector('.native-menu-sheet-back').fire('click');assert.equal(f.panels().length,2);assert.equal(f.document.activeElement,f.action('instruments-more:25'));
  f.panels().at(-1).querySelector('.native-menu-sheet-close').fire('click');assert.equal(f.menus.isOpen,false);assert.equal(f.panels().length,0);assert.equal(f.document.activeElement,f.document.getElementById('viewMenuBtn'));f.menus.destroy();
});

test('mobile menu keyboard back restores the parent and resizing preserves desktop cascading',()=>{
  const f=menuFixture({width:390});f.menus.open('settings');f.action('chooseInstrument').fire('click');
  f.document.fire('keydown',{key:'ArrowLeft'});assert.equal(f.panels().length,1);assert.equal(f.panels()[0].hidden,false);assert.equal(f.document.activeElement,f.action('chooseInstrument'));
  f.action('chooseInstrument').fire('click');f.view.innerWidth=1200;f.view.fire('resize');assert.equal(f.panels().length,2);assert.ok(f.panels().every(panel=>!panel.hidden&&!panel.classList.contains('native-menu-sheet')));
  f.document.fire('keydown',{key:'Escape'});assert.equal(f.panels().length,1);f.document.fire('keydown',{key:'Escape'});assert.equal(f.menus.isOpen,false);f.menus.destroy();
});

test('coarse pointer menus stay sheets on wide tablets and desktop touch does not open on entry',()=>{
  const tablet=menuFixture({width:1280,coarse:true});tablet.menus.open('settings');assert.equal(tablet.panels()[0].classList.contains('native-menu-sheet'),true);tablet.menus.destroy();
  const desktop=menuFixture({width:1280});desktop.menus.open('settings');desktop.action('chooseInstrument').fire('pointerenter',{pointerType:'touch'});assert.equal(desktop.panels().length,1);desktop.action('chooseInstrument').fire('pointerenter',{pointerType:'mouse'});assert.equal(desktop.panels().length,2);desktop.menus.destroy();
});

test('sheet Back and Close retain native Enter and Space activation without invoking a menu action',()=>{
  for(const key of ['Enter',' ']){
    const f=menuFixture();f.menus.open('settings');f.action('chooseInstrument').fire('click');
    const back=f.panels().at(-1).querySelector('.native-menu-sheet-back');back.focus();
    const backKey=f.document.fire('keydown',{key,target:back});assert.equal(backKey.defaultPrevented,false);assert.equal(f.panels().length,2);assert.deepEqual(f.chosen,[]);
    // The browser dispatches the button's native click after key activation.
    back.fire('click');assert.equal(f.panels().length,1);assert.equal(f.document.activeElement,f.action('chooseInstrument'));
    const close=f.panels()[0].querySelector('.native-menu-sheet-close');close.focus();
    const closeKey=f.document.fire('keydown',{key,target:close});assert.equal(closeKey.defaultPrevented,false);assert.deepEqual(f.chosen,[]);close.fire('click');assert.equal(f.menus.isOpen,false);f.menus.destroy();
  }
});
