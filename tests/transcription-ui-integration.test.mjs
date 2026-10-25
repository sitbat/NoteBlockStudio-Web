import test from 'node:test';
import assert from 'node:assert/strict';
import {installTranscriptionUI} from '../js/transcription-ui.js';

// Event/form adapter for the real UI handlers. This does not emulate browser
// rendering, permissions, inference, Worker execution or performance.
function uiFixture({modelReady=false,models=[],decode,download,loadModel,microphone=false,preferences={}}={}){
  const log=[],errors=[],commits=[],listeners=new Set(),contexts=[],nodes=[],tracks=[];let project={},pickCallback=null,frames=0;
  function events(target){target.events=new Map();target.addEventListener=(type,fn)=>target.events.set(type,[...(target.events.get(type)||[]),fn]);target.removeEventListener=(type,fn)=>target.events.set(type,(target.events.get(type)||[]).filter(item=>item!==fn));target.fire=async(type,event={})=>{for(const fn of target.events.get(type)||[])await fn({target,preventDefault(){},stopPropagation(){},...event});};return target;}
  const attributes=source=>Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match=>[match[1],match[2]??'']));
  const camel=value=>value.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
  function matches(element,selector){if(selector[0]==='#')return element.id===selector.slice(1);if(selector[0]==='.')return element.classList.contains(selector.slice(1));const attr=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);return !!attr&&Object.hasOwn(element.attrs,attr[1])&&(attr[2]===undefined||element.attrs[attr[1]]===attr[2]);}
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.dataset={};this.className='';this.hidden=false;this.disabled=false;this.open=false;this.value='';this.files=[];events(this);this.classList={contains:name=>this.className.split(' ').includes(name),toggle:(name,on)=>{const current=this.className.split(' ').filter(Boolean).filter(item=>item!==name);if(on)current.push(name);this.className=current.join(' ');}};}
    setAttribute(name,value){this.attrs[name]=String(value);if(name==='id')this.id=String(value);if(name.startsWith('data-'))this.dataset[camel(name.slice(5))]=String(value);}
    removeAttribute(name){delete this.attrs[name];}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    replaceChildren(...children){this.children=[];this.append(...children);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    querySelector(selector){return this.children.find(child=>matches(child,selector))||this.children.map(child=>child.querySelector(selector)).find(Boolean)||null;}
    closest(selector){return matches(this,selector)?this:this.parent?.closest(selector)||null;}
    set innerHTML(source){this.children=[];for(const match of source.matchAll(/<(button|input|select|option|div|p|span|small|strong|progress|canvas|header|fieldset|details)\b([^>]*)>/g)){const node=new Element(match[1]),attrs=attributes(match[2]);for(const[key,value]of Object.entries(attrs))node.setAttribute(key,value);node.hidden='hidden'in attrs;node.disabled='disabled'in attrs;node.checked='checked'in attrs;node.value=attrs.value||'';node.className=attrs.class||'';if(match[1]==='select'){const block=source.slice(match.index+match[0].length).split('</select>')[0];node.children=[...block.matchAll(/<option\b([^>]*)>([^<]*)/g)].map(option=>{const item=new Element('option'),a=attributes(option[1]);item.value=a.value||option[2];item.textContent=option[2];return item;});node.value=node.children[0]?.value||'';}this.append(node);}}
    get options(){return this.children.filter(child=>child.tagName==='option');}
    click(){this.clicks=(this.clicks||0)+1;}
    focus(){}showModal(){this.open=true;}close(){this.open=false;}getContext(){return null;}
  }
  const scope=events({isSecureContext:true,WebAssembly,navigator:{},requestAnimationFrame:()=>++frames,cancelAnimationFrame(){}}),document={defaultView:scope,createElement:tag=>new Element(tag),body:new Element('body')};
  const toolbar=new Element('div');toolbar.id='appTools';document.body.append(toolbar);document.getElementById=id=>id==='appTools'?toolbar:document.body.querySelector(`#${id}`);
  let snapshot={state:modelReady?'ready':'idle',modelReady,model:'small',backend:'auto',notes:[],noteCount:0};
  const emit=patch=>{snapshot={...snapshot,...patch};for(const listener of listeners)listener(snapshot);return snapshot;};
  const controller={getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async configure(options){log.push('configure');return emit(options);},async listModels(){log.push('listModels');return models;},async loadModel(id){log.push(`loadModel:${id}`);return loadModel?loadModel(id,emit):emit({state:'ready',modelReady:true});},async loadPackage(){return emit({state:'ready',modelReady:true});},async downloadModel(variant){log.push(`download:${variant}`);return download?download(variant,emit):emit({state:'ready',modelReady:true,testOnly:false});},async start(){log.push('start');return emit({state:'running',notes:[]});},async appendAudio(audio){log.push('audio');return emit({receivedSeconds:(snapshot.receivedSeconds||0)+audio.pcm.length/audio.sampleRate});},async finish(){log.push('finish');return emit({state:'completed',notes:[{startSeconds:0,endSeconds:1,midiKey:60}],noteCount:1});},async pause(){log.push('pause');return emit({state:'paused'});},async resume(){log.push('resume');return emit({state:'running'});},cancel(){log.push('cancel');return emit({state:'cancelled',modelReady:false,actualBackend:null,notes:[]});},async clearCache(){return emit({state:'idle',modelReady:false});}};
  if(microphone){
    scope.AudioContext=class{constructor(){this.sampleRate=48000;this.state='suspended';this.destination={};this.audioWorklet={addModule:async()=>{}};contexts.push(this);}async resume(){this.state='running';}createMediaStreamSource(){return{connect(){},disconnect(){}};}async close(){this.state='closed';log.push('context-close');}};
    scope.AudioWorkletNode=class{constructor(){this.port={onmessage:null,postMessage:()=>queueMicrotask(()=>this.port.onmessage?.({data:{type:'stopped'}}))};nodes.push(this);}connect(){}disconnect(){}};
    scope.navigator.mediaDevices={getUserMedia:async()=>{log.push('permission');const track={stopped:false,stop(){this.stopped=true;log.push('track-stop');}};tracks.push(track);return{getTracks:()=>[track]};}};
  }
  const h={document,controller,getProjectRef:()=>project,getDownloadInfo:variant=>({variant,label:variant,bytes:412000000,url:`https://www.modelscope.cn/${variant}`,available:true}),error:error=>errors.push(error),decodeAudioFile:async(file,options)=>{log.push('decode');return decode?decode(file,options):{pcm:new Float32Array(160),sampleRate:16000};},pickInsertion(callback){pickCallback=callback;return()=>{pickCallback=null;log.push('picker-clean');};},commitNotes:async(notes,options,anchor)=>{commits.push({notes,options,anchor});return {addedNotes:notes.length,selectedIds:[`created:${commits.length}`]};},showMidiMapping(){log.push('mapping');}};
  h.preferences=preferences;h.onPreferencesChanged=()=>log.push('save-preferences');h.downloadOptions=[];
  const downloadModel=controller.downloadModel;controller.downloadModel=(variant,options)=>{h.downloadOptions.push({...options});return downloadModel(variant);};
  const ui=installTranscriptionUI(h),panel=ui.panel,action=name=>panel.querySelector(`[data-action="${name}"]`),input=name=>panel.querySelector(`[data-input="${name}"]`),dialog=()=>document.getElementById('transcriptionDownloadDialog');
  return{ui,controller,h,log,errors,commits,tracks,contexts,nodes,action,input,dialog,get snapshot(){return snapshot;},emit,setProject:()=>{project={};},async click(name){await panel.fire('click',{target:action(name)});},async confirmDownload(){await dialog().fire('click',{target:dialog().querySelector('[data-download-action="confirm"]')});},pick(anchor){const callback=pickCallback;pickCallback=null;callback?.(anchor);}};
}
const turn=()=>new Promise(resolve=>setTimeout(resolve,0)),file={name:'voice.flac',size:4};

test('download concurrency restores preferences, freezes the active request, and persists the next retry selection',async()=>{
  const defaults=uiFixture();assert.equal(defaults.ui.panel.querySelector('[data-setting="downloadConcurrency"]').value,'2');defaults.ui.destroy();
  let reject;let attempts=0;const preferences={transcriptionDownloadConcurrency:3},f=uiFixture({preferences,download:async(_variant,emit)=>{if(++attempts===1)await new Promise((_resolve,no)=>{reject=no;});return emit({state:'ready',modelReady:true,error:null});}});
  const select=f.ui.panel.querySelector('[data-setting="downloadConcurrency"]');assert.equal(select.value,'3');await f.ui.open();const dialogSelect=f.dialog().querySelector('[data-download-setting="concurrency"]');assert.equal(dialogSelect.value,'3');
  dialogSelect.value='4';await dialogSelect.fire('change');assert.equal(select.value,'4');assert.equal(preferences.transcriptionDownloadConcurrency,4);assert.ok(f.log.includes('save-preferences'));
  const pending=f.confirmDownload();await turn();assert.deepEqual(f.h.downloadOptions,[{concurrency:4}]);assert.equal(select.disabled,true);assert.equal(dialogSelect.disabled,true);assert.match(f.ui.panel.querySelector('[data-output="downloadStats"]').textContent,/40 MiB.*4 并发.*已固定/);
  select.value='1';await select.fire('change');assert.equal(select.value,'4');assert.equal(preferences.transcriptionDownloadConcurrency,4);reject(new Error('network stopped'));await pending;assert.equal(select.disabled,false);
  select.value='1';await select.fire('change');assert.equal(preferences.transcriptionDownloadConcurrency,1);await f.click('retryDownload');assert.deepEqual(f.h.downloadOptions,[{concurrency:4},{concurrency:1}]);f.ui.destroy();
  const restored=uiFixture({preferences:JSON.parse(JSON.stringify(preferences))});assert.equal(restored.ui.panel.querySelector('[data-setting="downloadConcurrency"]').value,'1');await restored.ui.open();assert.equal(restored.dialog().querySelector('[data-download-setting="concurrency"]').value,'1');restored.ui.destroy();
});

test('audio chosen before a model stays local and resumes after explicit model confirmation, then requires a picked insertion',async()=>{
  const f=uiFixture();await f.ui.importAudio(file);assert.equal(f.dialog().open,true);assert.ok(!f.log.includes('decode'));assert.equal(f.commits.length,0);
  await f.confirmDownload();assert.equal(f.log.filter(item=>item==='decode').length,1);assert.equal(f.snapshot.state,'completed');assert.equal(f.commits.length,0);
  await f.click('pick');f.pick({tick:12});assert.equal(f.action('insert').disabled,false);await f.click('insert');assert.equal(f.commits.length,1);assert.equal(f.commits[0].anchor.tick,12);assert.match(f.ui.panel.querySelector('[data-output="previewText"]').textContent,/已写入工程/);assert.doesNotMatch(f.ui.panel.querySelector('[data-output="previewText"]').textContent,/尚未/);f.ui.destroy();
});

test('undo removes inserted status and its anchor; redo detects note IDs across history snapshots and blocks duplicate insertion',async()=>{
  const f=uiFixture({modelReady:true});await f.ui.importAudio(file);await f.click('pick');f.pick({tick:12});await f.click('insert');assert.equal(f.action('insert').disabled,true);
  f.ui.syncHistory([{id:'unrelated-original-note'}]);assert.match(f.ui.panel.querySelector('[data-output="previewText"]').textContent,/尚未写入/);assert.equal(f.action('insert').disabled,true);assert.equal(f.action('pick').disabled,false);
  await f.click('pick');f.pick({tick:24});assert.equal(f.action('insert').disabled,false);f.ui.syncHistory([{id:'created:1'}]);assert.equal(f.action('insert').disabled,true);assert.match(f.ui.panel.querySelector('[data-output="previewText"]').textContent,/已写入工程/);await f.click('insert');assert.equal(f.commits.length,1);
  f.ui.syncHistory([]);await f.click('pick');f.pick({tick:36});await f.click('insert');assert.equal(f.commits.length,2);assert.equal(f.commits[1].anchor.tick,36);f.ui.destroy();
});

test('mapping warnings and duplicate diagnostics persist with separate raw and inserted counts across undo and redo',async()=>{
  const f=uiFixture({modelReady:true});await f.ui.importAudio(file);const raw=Array.from({length:8},(_,index)=>({startSeconds:index/10,midiKey:60}));f.emit({notes:raw});f.h.commitNotes=async()=>({changed:true,addedNotes:2,selectedIds:['one','two'],warnings:['6 个模型重复/量化重合已整理；原始识别未修改。'],diagnostics:{rawInputNotes:8,outputNotes:2,rawExactDuplicates:5,mappedCollisions:1,duplicateTargetsRemoved:6}});
  await f.click('pick');f.pick({tick:12});await f.click('insert');const preview=f.ui.panel.querySelector('[data-output="previewText"]'),details=f.ui.panel.querySelector('[data-output="insertionInfo"]');assert.match(preview.textContent,/原始识别 8.*已写入工程 2/);assert.equal(details.hidden,false);assert.match(details.textContent,/原始 8 → 落谱 2/);assert.match(details.textContent,/完全重复 5/);assert.match(details.textContent,/映射\/量化重合 1/);assert.doesNotMatch(details.className,/error/);assert.equal(f.snapshot.notes,raw);
  f.ui.syncHistory([]);assert.match(preview.textContent,/原始识别 8.*尚未写入/);assert.match(details.textContent,/已撤销/);assert.match(details.textContent,/6 个模型重复/);f.ui.syncHistory([{id:'one'},{id:'two'}]);assert.match(preview.textContent,/已写入工程 2/);assert.doesNotMatch(details.textContent,/已撤销/);assert.equal(f.action('insert').disabled,true);f.ui.destroy();
});

test('an existing real cache is loaded before the audio chooser and metadata alone never opens it',async()=>{
  const f=uiFixture({models:[{id:'cached-small',variant:'small',testOnly:false}]});assert.deepEqual(f.log,[]);await f.ui.chooseAudio();assert.ok(f.log.includes('loadModel:cached-small'));assert.equal(f.input('audio').clicks,1);assert.ok(!f.log.some(item=>item.startsWith('download:')));f.ui.destroy();
  const invalid=uiFixture({models:[{id:'broken-small',variant:'small'}],loadModel:async(_id,emit)=>emit({state:'ready',modelReady:false})});await invalid.ui.chooseAudio();assert.equal(invalid.input('audio').clicks,undefined);assert.equal(invalid.action('record').disabled,true);assert.match(invalid.errors[0].message,/尚不可/);invalid.ui.destroy();
});

test('download failure retains chosen audio for explicit retry and never performs inference with an unavailable model',async()=>{
  let attempts=0;const f=uiFixture({download:async(_variant,emit)=>{if(++attempts===1){emit({state:'error',modelReady:false,error:{message:'backend unavailable'}});throw new Error('backend unavailable');}return emit({state:'ready',modelReady:true,error:null});}});
  await f.ui.importAudio(file);await f.confirmDownload();assert.equal(f.log.includes('decode'),false);assert.equal(f.action('retryDownload').hidden,false);
  await f.click('retryDownload');assert.equal(attempts,2);assert.equal(f.snapshot.state,'completed');assert.equal(f.log.filter(item=>item==='decode').length,1);f.ui.destroy();
});

test('cancelling after model preparation failure clears the failed preparation view and releases the selected audio',async()=>{
  const f=uiFixture({download:async()=>{throw new Error('network failed');}});await f.ui.importAudio(file);await f.confirmDownload();assert.equal(f.action('retryDownload').hidden,false);await f.ui.cancel();assert.equal(f.ui.panel.querySelector('[data-output="downloadArea"]').hidden,true);assert.equal(f.ui.panel.querySelector('[data-output="error"]').hidden,true);assert.equal(f.action('cancel').disabled,true);assert.equal(f.log.includes('decode'),false);f.ui.destroy();
});

test('cancel aborts an active decoder and prevents its result from ever starting inference',async()=>{
  let signal;const f=uiFixture({modelReady:true,decode:(_file,options)=>new Promise((_resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true});})});
  const pending=f.ui.importAudio(file);await turn();assert.ok(signal);await f.ui.cancel();await pending;assert.equal(signal.aborted,true);assert.ok(!f.log.includes('start'));assert.equal(f.errors.length,0);assert.equal(f.snapshot.modelReady,false);f.ui.destroy();
});

test('changing project invalidates the old preview and insertion picker without discarding a ready idle model',async()=>{
  const f=uiFixture({modelReady:true});await f.ui.importAudio(file);await f.click('pick');f.setProject();await f.ui.projectChanged();f.pick({tick:100});assert.ok(f.log.includes('picker-clean'));assert.equal(f.action('insert').disabled,true);assert.equal(f.snapshot.modelReady,true);await f.click('insert');assert.equal(f.commits.length,0);f.ui.destroy();
});

test('opening a different project aborts active decoding and removes its queued audio and temporary result',async()=>{
  let signal;const f=uiFixture({modelReady:true,decode:(_file,options)=>new Promise((_resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true});})});
  const pending=f.ui.importAudio(file);await turn();f.setProject();await f.ui.projectChanged();await pending;assert.equal(signal.aborted,true);assert.equal(f.snapshot.state,'cancelled');assert.equal(f.log.includes('start'),false);assert.equal(f.action('insert').disabled,true);assert.equal(f.errors.length,0);f.ui.destroy();
});

test('stopping a paused recording releases every microphone resource and resumes the remaining work before finish',async()=>{
  const f=uiFixture({modelReady:true,microphone:true});assert.ok(!f.log.includes('permission'));await f.ui.toggleRecording();await f.controller.pause();await f.ui.toggleRecording();
  assert.ok(f.tracks.every(track=>track.stopped));assert.ok(f.contexts.every(context=>context.state==='closed'));assert.ok(f.log.indexOf('resume')<f.log.indexOf('finish'));assert.equal(f.snapshot.state,'completed');f.ui.destroy();assert.equal(f.snapshot.state,'cancelled');
});

test('first-result copy separates file batch computation from actual recording collection and computation delay',async()=>{
  const fileRun=uiFixture({modelReady:true});await fileRun.ui.importAudio(file);fileRun.emit({firstNoteLatencyMs:500});const fileStats=fileRun.ui.panel.querySelector('[data-output="stats"]').textContent;assert.match(fileStats,/文件首批结果计算用时 0.50 秒/);assert.match(fileStats,/非实时录音延迟/);fileRun.ui.destroy();
  const live=uiFixture({modelReady:true,microphone:true});await live.ui.toggleRecording();live.emit({firstNoteLatencyMs:5500,receivedSeconds:5});const liveStats=live.ui.panel.querySelector('[data-output="stats"]').textContent;assert.match(liveStats,/录音开始至首批结果 5.50 秒/);assert.match(liveStats,/含音频收集与计算/);await live.ui.cancel();live.ui.destroy();
});

test('GENERATION_LIMIT with partial notes never enables insertion or commits a truncated result',async()=>{
  const f=uiFixture({modelReady:true});await f.ui.importAudio(file);await f.click('pick');f.pick({tick:12});assert.equal(f.action('insert').disabled,false);
  f.emit({state:'error',error:{code:'GENERATION_LIMIT',message:'这一音频块未在 2000 个令牌的总生成预算内结束。'}});assert.equal(f.action('insert').disabled,true);assert.match(f.ui.panel.querySelector('[data-output="previewText"]').textContent,/未完成.*不能写入/);assert.match(f.ui.panel.querySelector('[data-output="error"]').textContent,/2000/);await f.click('insert');assert.equal(f.commits.length,0);f.ui.destroy();
});
