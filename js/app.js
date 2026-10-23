import { INSTRUMENTS } from './audio.js';
import { WasmAudioEngine as AudioEngine } from './wasm-audio.js';
import { parseNBS, writeNBS, parseMIDI, writeMIDI } from './formats.js';
import { createDemoSong, createBlankSong, normalizeSong, noteName, uniqueId, History, MAX_LAYERS, MAX_NOTES } from './model.js';
import { hydrateIcons, icon } from './icons.js';
import { bounds, moveNotes, pasteNotes } from './edit.js';
import { ProjectStore } from './project-store.js';
import { createNativeMenus } from './native-menus.js';
import {loadEditorPreferences,installFeatureUI} from './feature-ui.js';
import {PlaybackVisuals} from './playback-visuals.js';
import {tickAtFrame,transportTempoAtTick} from './dsp-protocol.js';
import {createTempoMap,secondsAtTick,controlType} from './tempo-map.js';
import {loadPianoBindings,PIANO_BINDINGS} from './editor-preferences.js';
import {createNativeNoteRenderer} from './native-note-renderer.js';
import {drawNativeGrid} from './native-grid-renderer.js';
import {createNativeLayerUI} from './native-layer-ui.js';
import {createNativePlayerUI} from './native-player-ui.js';
import {createNativeDialogs} from './native-dialogs.js';
import {analyzeMinecraftCompatibility} from './minecraft-compatibility.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const STORAGE_KEY = 'noteblock-studio-web-project-v1';
const ROW = 32, TICKS_PER_BEAT = 4;
let song = createDemoSong(), restored = false;
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) { song = normalizeSong(JSON.parse(saved)); restored = true; } } catch { /* A corrupt cache never prevents a fresh session. */ }
const editorPreferences=loadEditorPreferences();
let playerMode=new URLSearchParams(location.search).get('player')==='1';
const engine = new AudioEngine({masterVolume: .75});
try { const settings=JSON.parse(localStorage.getItem('nbs-rust-audio-settings')); if(settings)engine.configure(settings); } catch { /* Invalid settings use the measured default. */ }
const projectStore = new ProjectStore();
const history = new History(70);
const sampleUndo = [], sampleRedo = [];
const state = {editMode:'key',section:null,dropMode:false,player:playerMode,hover:null,tool:'draw', instrument:0, key:39, velocity:100, pan:0, pitch:0, layer:0, tick:0, cell:32, snap:1, selected:new Set(), clipboard:null, gesture:null, pianoStart:41, busy:false};
let cellIndex = new Map(), noteRows = new Map(), saveTimer, toastTimer, frame, dragDepth = 0;
const playbackVisuals = new PlaybackVisuals(song, {playerMode});
const heldPiano = new Map(), heldKeys = new Uint32Array(88);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let pianoKeys = [], playbackKeyAges = new Float64Array(88).fill(Infinity), hasSolo = false;
let visualSong = song, removalEffects = [], columns=new Map(), dropNotes=[], keyPositions=[], tempoMap=null;
let pianoWindowCount=0,activeAccent=editorPreferences.accent,resumeTransport=false,pianoEdge=null,pianoEdgeFrame=0,statSong=null;
const chartClefs=['treble-clef','bass-clef'].map(name=>{const image=new Image();image.src=`assets/original/${name}/00.png`;return image;});
let pianoBindings=loadPianoBindings(localStorage),pendingBinding=null,recordArmed=false,recordingStarted=false,metronome=false,seekGesture=null;
const drawNote=createNativeNoteRenderer(scheduleDraw);
let canvasWidth = 1, canvasHeight = 1, rulerWidth = 1, dirty = false;
let saveRevision = 0, liveReverbHistory = false, sampleLoadToken = 0;
let saveQueue=Promise.resolve();
const g = $('grid').getContext('2d'), ruler = $('ruler').getContext('2d'), overview = $('overviewCanvas').getContext('2d');
const overviewCache = document.createElement('canvas');
let overviewDirty = true;
const transportIcon=name=>`<img src="assets/original/toolbar-light/${name==='pause'?'05-pause':'04-play'}.png" alt="">`;
const instruments = () => [...INSTRUMENTS, ...song.customInstruments.map((i,n) => ({id:16+n,name:i.name || `自定义 ${n+1}`,englishName:i.file || 'Custom',color:'#b6e878',symbol:'♫'}))];
const inst = id => instruments().find(i=>i.id===id) || {id,name:`音色 ${id}`,englishName:'Custom',color:'#b6e878',symbol:'♫'};
const selectedNotes = () => song.notes.filter(n=>state.selected.has(n.id));
const editableNotes = () => selectedNotes().filter(n=>!song.layers[n.layer]?.locked);
const beatsPerBar = () => song.timeSignature*TICKS_PER_BEAT;
const totalTicks = () => Math.max(128, Math.ceil(song.length/16)*16+32);
const formatTime=seconds=>`${String(Math.floor(seconds/60)).padStart(2,'0')}:${(seconds%60).toFixed(2).padStart(5,'0')}`;
const exportOptions=(()=>{try{const saved=JSON.parse(localStorage.getItem('nbs-export-options')||'{}');return{version:Number.isInteger(saved.version)&&saved.version>=0&&saved.version<=5?saved.version:5,webExtensions:saved.webExtensions!==false};}catch{return{version:5,webExtensions:true};}})();
function pianoLabel(key){
  const labels=[];let name=noteName(key);if(editorPreferences.flat)name=name.replace('C♯','D♭').replace('D♯','E♭').replace('F♯','G♭').replace('G♯','A♭').replace('A♯','B♭');
  if(editorPreferences.keyNames)labels.push(`<span>${name}</span>`);
  if(editorPreferences.keyNumbers&&key>=33&&key<=57)labels.push(`<small>${key-33}</small>`);
  if(editorPreferences.keyBindings){const binding=Object.entries(pianoBindings).find(([,midi])=>midi===key+21)?.[0];if(binding)labels.push(`<small>${esc(binding.toUpperCase())}</small>`);}
  return `<span class="piano-key-label">${labels.join('')}</span>`;
}
function selectLiveKey(key){if(!editorPreferences.selectLastKey)return;state.key=key;$('pitchName').textContent=noteName(key);$('keyInput').value=key;for(const item of pianoKeys)item.element.classList.toggle('active',item.key===key);updatePianoFeedback();updateCursorStatus();}
function updateCursorStatus(note=null){$('cursorStatus').textContent=note?`Tick ${note.tick} · 轨 ${note.layer+1} · ${noteName(note.key)} · ${inst(note.instrument).name} · ${note.velocity}%`:`${inst(state.instrument).name} · ${noteName(state.key)}${state.velocity!==100?` · 力度 ${state.velocity}%`:''}${state.pan?` · ${state.pan<0?'L':'R'}${Math.abs(state.pan)}`:''}${state.pitch?` · ${state.pitch>0?'+':''}${state.pitch} cents`:''}`;}
function setEditMode(mode){if(!['key','velocity','pan','pitch'].includes(mode))return;state.editMode=mode;document.querySelectorAll('[data-edit-mode]').forEach(button=>{const active=button.dataset.editMode===mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});scheduleDraw();}
function adjustMode(direction,coarse=false,notes=editableNotes()){
  if(playerMode||state.busy)return;const property=state.editMode,step=property==='key'?(coarse?12:1):(coarse?10:1),range=property==='key'?[0,87]:property==='velocity'?[0,100]:property==='pan'?[-100,100]:[-32768,32767];
  if(notes.length){const editable=notes.filter(note=>!song.layers[note.layer]?.locked);if(!editable.length)return;checkpoint();for(const note of editable){const limit=property==='pitch'&&controlType(note,song)!=='tempo'?[-1200,1200]:range;note[property]=clamp((Number(note[property])||0)+direction*step,...limit);}refresh({layers:false,save:true});if(editable.length===1)audition(editable[0]);}
  else{state[property]=clamp(state[property]+direction*step,...range);renderInspector();updateCursorStatus();}
}
function setModeProperty(){const property=state.editMode;modal('设置所选音符属性',`<label>${{key:'音高（0–87）',velocity:'力度（0–100）',pan:'声像（−100–100）',pitch:'微调音高（cents）'}[property]}<input id="modePropertyValue" type="number" value="${state[property]}"></label>`,`<button class="primary-button" id="modePropertyApply">应用</button>`);$('modePropertyApply').onclick=()=>{const value=Number($('modePropertyValue').value),ranges={key:[0,87],velocity:[0,100],pan:[-100,100],pitch:[-32768,32767]};if(!Number.isFinite(value))return;applyProperty(property,clamp(value,...ranges[property]),{preview:true});$('modal').close();};}
function resetModeProperty(){applyProperty(state.editMode,state.editMode==='velocity'?100:state.editMode==='key'?45:0);}
function showSaveOptions(){
  modal('NBS 保存选项',`<label>NBS 格式版本<select id="nbsSaveVersion">${[0,1,2,3,4,5].map(version=>`<option value="${version}">${version===0?'经典版（0）':`版本 ${version}`}</option>`).join('')}</select></label><label class="inline-label">保存 Web 独立混响及锁定扩展<input id="nbsWebExtensions" type="checkbox" ${exportOptions.webExtensions?'checked':''}></label><p id="nbsSaveWarnings"></p><p>自定义采样引用保存在 NBS 中；音频文件需使用“完整工程包”一同保存。</p>`,`<button class="secondary-button" id="saveOptionsOnly">保存设置</button><button class="primary-button" id="saveOptionsExport">设置并导出</button>`);
  $('nbsSaveVersion').value=exportOptions.version;
  const warnings=()=>{const version=Number($('nbsSaveVersion').value),messages=[];if(version<4)messages.push('此版本不保存逐音符力度、声像、微调音高、图层锁定和循环设置。');if(version<2)messages.push('此版本不保存图层声像。');if(version===0)messages.push('经典版只支持前 10 种内置音色；使用新增音色的歌曲会拒绝导出。');if(!$('nbsWebExtensions').checked)messages.push('关闭扩展后，不保存每轨混响和独立静音/编辑锁定状态。');$('nbsSaveWarnings').textContent=messages.join(' ')||'保存全部标准 NBS v5 字段及选择的 Web 扩展。';};
  $('nbsSaveVersion').onchange=warnings;$('nbsWebExtensions').onchange=warnings;warnings();
  const save=()=>{exportOptions.version=Number($('nbsSaveVersion').value);exportOptions.webExtensions=$('nbsWebExtensions').checked;localStorage.setItem('nbs-export-options',JSON.stringify(exportOptions));$('modal').close();};$('saveOptionsOnly').onclick=save;$('saveOptionsExport').onclick=()=>{save();downloadNBS();};
}
function applyPlaybackPreferences(){engine.setMono?.(editorPreferences.mono);renderCompatibility();renderPiano();updateCursorStatus();scheduleDraw();}
function resetPianoBindings(){pianoBindings={...PIANO_BINDINGS};localStorage.removeItem('nbs-piano-bindings');renderPiano();toast('已恢复原版默认琴键绑定');}
function setPlayerMode(enabled){
  playerMode=!!enabled;state.player=playerMode;if(!playerMode)state.dropMode=false;
  document.body.classList.toggle('player-mode',playerMode);document.body.classList.toggle('drop-view',state.dropMode);$('playerViewBtn').setAttribute('aria-pressed',String(playerMode));$('dropModeBtn').setAttribute('aria-pressed',String(state.dropMode));
  for(const id of ['songInfoBtn','tempoInput','signatureInput'])$(id).disabled=playerMode;playbackVisuals.rebuild(song,{playerMode});resize();
}
function toggleWorkspace(){const expanded=document.body.classList.toggle('expanded-workspace');$('workspaceBtn').setAttribute('aria-pressed',String(expanded));resize();}
function seekTo(tick,{preview=false,resume=engine.playing}={}){
  stopPlayback(false);setTick(clamp(tick,0,song.length),true);if(preview&&!resume)engine.previewNotes(columns.get(Math.floor(state.tick))||[],song.layers,Number($('masterVolume').value)/100).catch(errorMessage);if(resume)togglePlayback({resume:true});
}
function seekHold(direction,event){
  if(state.busy)return;event?.preventDefault();if(event?.pointerId!==undefined)event.currentTarget?.setPointerCapture?.(event.pointerId);
  const resume=engine.playing;stopPlayback(false);seekGesture={direction,resume,last:performance.now(),frame:0};
  const move=()=>{if(!seekGesture)return;setTick(state.tick+direction*4,true);engine.previewNotes(columns.get(Math.floor(state.tick))||[],song.layers,Number($('masterVolume').value)/100).catch(errorMessage);};move();
  const advance=now=>{if(!seekGesture)return;if(now-seekGesture.last>=100){seekGesture.last=now;move();}seekGesture.frame=requestAnimationFrame(advance);};seekGesture.frame=requestAnimationFrame(advance);
}
function seekRelease(){if(!seekGesture)return;const resume=seekGesture.resume;cancelAnimationFrame(seekGesture.frame);seekGesture=null;if(resume)togglePlayback({resume:true});}
function showSectionMenu(event){
  event.preventDefault();const popup=$('contextPopup'),section=state.section,entries=[['clear','移除区间',!section],['start','跳到区间开始',!section],['end','跳到区间结束',!section],['select','选择区间内音符',!section],['from',`${editorPreferences.sectionStart?'✓ ':''}从区间开始播放`,false],['until',`${editorPreferences.sectionEnd?'✓ ':''}在区间后停止`,false]];
  popup.innerHTML=entries.map(([id,label,disabled])=>`<button data-section="${id}" ${disabled?'disabled':''}>${label}</button>`).join('');popup.style.left=`${clamp(event.clientX,0,innerWidth-230)}px`;popup.style.top=`${clamp(event.clientY,0,innerHeight-210)}px`;popup.showPopover();
  popup.onclick=e=>{const action=e.target.closest('[data-section]')?.dataset.section;if(!action)return;popup.hidePopover();if(action==='clear')state.section=null;else if(action==='start')seekTo(section.start);else if(action==='end')seekTo(section.end);else if(action==='select')state.selected=new Set(song.notes.filter(note=>note.tick>=section.start&&note.tick<section.end).map(note=>note.id));else{const key=action==='from'?'sectionStart':'sectionEnd';editorPreferences[key]=!editorPreferences[key];localStorage.setItem('nbs-web-preferences-v3',JSON.stringify(editorPreferences));}renderInspector();scheduleDraw();};
}
function toggleRecordArm(){
  if(playerMode||state.busy)return;if(recordArmed){recordArmed=false;recordingStarted=false;toast('琴键录制已停止');}else{stopPlayback(false);features.midi.stopRecording();recordArmed=true;recordingStarted=false;toast('等待第一个琴键或 MIDI 音符开始录制');}
  $('recordMidiBtn').classList.toggle('active',recordArmed);$('recordMidiBtn').setAttribute('aria-pressed',String(recordArmed));
}
function recordLiveNote(note){
  if(!recordArmed||playerMode)return false;if(song.notes.length>=MAX_NOTES){toast('音符已达上限',true);return true;}
  const first=!recordingStarted;if(first){checkpoint();recordingStarted=true;toast('正在录制琴键');}engine.customInstruments=song.customInstruments;
  if(first&&state.section&&editorPreferences.sectionStart)setTick(state.section.start);
  const tick=Math.max(0,Math.ceil(engine.playing?engine.getTick():state.tick)),occupied=new Set((columns.get(tick)||[]).map(n=>n.layer));let layer=state.layer;
  while(layer<MAX_LAYERS&&(occupied.has(layer)||song.layers[layer]?.locked))layer++;
  if(layer>=MAX_LAYERS){toast('没有可录制的音轨',true);return true;}
  while(song.layers.length<=layer)song.layers.push({id:song.layers.length,name:`录制 ${song.layers.length+1}`,volume:100,pan:0,reverb:0,muted:false,solo:false,locked:false});
  const recorded={id:uniqueId(),tick,layer,key:note.key,instrument:note.instrument??state.instrument,velocity:note.velocity??state.velocity,pan:note.pan??state.pan,pitch:note.pitch??state.pitch};song.notes.push(recorded);song.length=Math.max(song.length,tick+1);engine.monitorRecordedNote(recorded,{layer:song.layers[layer],id:recorded.id}).catch(errorMessage);refresh({save:true});if(first&&!engine.playing)togglePlayback({resume:true});return true;
}

function toast(message, error=false) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.toggle('error',error); $('toast').hidden=false;
  $('statusText').textContent=message; toastTimer=setTimeout(()=>$('toast').hidden=true,error?7000:3500);
}
function errorMessage(error) { console.error(error); toast(error?.message || String(error),true); }
function persist() {
  clearTimeout(saveTimer); dirty=true; $('saveState').textContent='正在自动保存…';
  saveRevision++; saveTimer=setTimeout(flushSave,800);
}
function flushSave(){clearTimeout(saveTimer);saveQueue=saveQueue.then(async()=>{const revision=saveRevision,project=song;const snapshot=await features.sampleDataForSave();await projectStore.save(project,snapshot?.samples,{autoBackup:editorPreferences.autoBackup,backupMinutes:editorPreferences.backupMinutes});features.samplesSaved(snapshot);if(revision===saveRevision){dirty=false;$('saveState').textContent='已保存在此浏览器';}}).catch(error=>{$('saveState').textContent='自动保存失败，请导出完整工程包';console.warn(error);});return saveQueue;}
function checkpoint(samples = engine.customSamples) {
  history.setLimit(clamp(Math.floor(1000000/Math.max(1,song.notes.length)),2,70));
  history.push(song); sampleUndo.push(new Map(samples));
  sampleUndo.splice(0,Math.max(0,sampleUndo.length-history.undoDepth)); sampleRedo.length=0;
}
function refresh({layers=true, inspector=true, save=false}={}) {
  const ids=new Set(song.notes.map(n=>n.id));
  if(statSong===song){song.metadata||={};const previous=new Set([...noteRows.values()].flatMap(row=>row.map(n=>n.id)));const added=song.notes.reduce((n,note)=>n+!previous.has(note.id),0),removed=[...previous].reduce((n,id)=>n+!ids.has(id),0);for(const [key,count]of [['blocksAdded',added],['blocksRemoved',removed]])song.metadata[key]=Math.min(0xffffffff,(Number(song.metadata[key])||0)+count);}statSong=song;
  if(visualSong!==song){removalEffects=[];visualSong=song;}
  else if(editorPreferences.removeEffect&&!reducedMotion.matches){
    const scroll=$('gridScroll'),now=performance.now();
    removalEffects=removalEffects.filter(effect=>now-effect.started<278);
    removals:for(const row of noteRows.values())for(const note of row)if(!ids.has(note.id)&&note.tick*state.cell>=scroll.scrollLeft-state.cell&&note.tick*state.cell<scroll.scrollLeft+canvasWidth&&note.layer*ROW>=scroll.scrollTop-ROW&&note.layer*ROW<scroll.scrollTop+canvasHeight){if(removalEffects.length>=512)break removals;removalEffects.push({tick:note.tick,layer:note.layer,started:now});}
  }
  cellIndex=new Map(song.notes.map(n=>[`${n.tick}:${n.layer}`,n]));
  noteRows=new Map();for(const note of song.notes){if(!noteRows.has(note.layer))noteRows.set(note.layer,[]);noteRows.get(note.layer).push(note);}overviewDirty=true;
  state.selected=new Set([...state.selected].filter(id=>ids.has(id)));
  song.length=Math.max(1,song.length,song.notes.length?bounds(song.notes).maxTick+1:1);
  hasSolo=song.layers.some(layer=>layer.solo);playbackVisuals.rebuild(song,{playerMode});tempoMap=createTempoMap(song);
  columns=new Map();const falling=new Map();for(const notes of noteRows.values()){notes.sort((a,b)=>a.tick-b.tick);for(const note of notes){if(!columns.has(note.tick))columns.set(note.tick,[]);columns.get(note.tick).push(note);if(!song.layers[note.layer]?.muted&&(!hasSolo||song.layers[note.layer]?.solo)){const id=`${note.tick}:${note.key}:${note.instrument}:${note.pitch}`,old=falling.get(id);if(!old||note.velocity>old.velocity)falling.set(id,note);}}}dropNotes=[...falling.values()].sort((a,b)=>a.tick-b.tick);
  $('durationDisplay').textContent=formatTime(secondsAtTick(song.length,tempoMap,song.tempo));$('selectionStatus').textContent=state.selected.size?`已选择 ${state.selected.size.toLocaleString()} 个音符`:'';
  state.layer=clamp(state.layer,0,song.layers.length-1);
  $('projectTitle').textContent=song.title||'未命名曲谱'; document.title=`${song.title||'未命名曲谱'} · Note Block Studio`;
  $('projectCaption').textContent=`${song.layers.length} 条音轨 · ${song.notes.length.toLocaleString()} 个音符`;
  $('layerCount').textContent=String(song.layers.length).padStart(2,'0');
  $('songStats').textContent=`${song.notes.length.toLocaleString()} notes · ${song.layers.length} layers · ${secondsAtTick(song.length,tempoMap,song.tempo).toFixed(1)}s`;
  $('tempoInput').value=editorPreferences.bpm?song.tempo*15:song.tempo;$('tempoInput').setAttribute('aria-label',editorPreferences.bpm?'速度 BPM':'速度 ticks 每秒');$('tempoInput').min=editorPreferences.bpm?.75:.05;$('tempoInput').max=editorPreferences.bpm?9830.25:655.35;$('tempoInput').parentElement.querySelector('small').textContent=editorPreferences.bpm?'BPM':'t/s'; $('signatureInput').value=song.timeSignature;
  $('loopBtn').querySelector('img').src=`assets/original/toolbar-light/${song.loop?'50-loop':'49-loop-inactive'}.png`;$('loopBtn').classList.toggle('active',song.loop); $('loopBtn').setAttribute('aria-pressed',String(song.loop));
  $('undoBtn').disabled=!history.canUndo; $('redoBtn').disabled=!history.canRedo;
  $('gridSpacer').style.width=`${Math.min(30000000,totalTicks()*state.cell)}px`;
  $('gridSpacer').style.height=`${song.layers.length*ROW}px`;
  renderCompatibility();if(layers) renderLayers(); if(inspector) renderInspector(); scheduleDraw(); if(save){persist();restartIfPlaying();}
}
function renderCompatibility(){const result=analyzeMinecraftCompatibility(song),button=$('compatibilityBtn'),dark=document.body.classList.contains('theme-dark');button.dataset.level=result.level;button.querySelector('span').textContent=result.label;button.title=`${result.label}：${result.reason}（点击查看）`;button.querySelectorAll('img').forEach((image,index)=>{const frame=result.frames[index]+(dark?3:0),path=`assets/original/compatibility/${String(frame).padStart(2,'0')}.png`;if(image.getAttribute('src')!==path)image.src=path;});}
$('compatibilityBtn').onclick=()=>{const result=analyzeMinecraftCompatibility(song);modal('Minecraft 兼容性',`<h3>${esc(result.label)}</h3><p>${esc(result.reason)}</p><p>这是原版音色、音域和速度范围提示。所需游戏版本、命令与资源设置以具体导出选项为准。</p>`,`<button class="primary-button" id="compatibilityExport">Minecraft 导入与导出…</button>`);$('compatibilityExport').onclick=features.actions.minecraft;};
function renderRack() {
  const list=instruments();
  $('instrumentRack').innerHTML=list.map(i=>`<button class="instrument-card ${state.instrument===i.id?'active':''}" data-instrument="${i.id}" style="--inst-color:${i.color}" title="${esc(i.name)} · ${esc(i.englishName)}${i.id>=16?'（双击重新加载音色）':''}" aria-label="${esc(i.name)}" aria-pressed="${state.instrument===i.id}"><span class="inst-symbol">${i.symbol}</span><span>${esc(i.name)}</span></button>`).join('');
  const visible=Math.min(list.length,Math.max(5,Math.ceil((document.documentElement.clientWidth-1040)/25)));Array.from($('instrumentRack').children).forEach((button,index)=>button.hidden=index>=visible);
  $('instrumentPopup').innerHTML=$('instrumentRack').innerHTML;Array.from($('instrumentPopup').children).forEach(button=>button.hidden=false);$('instrumentExpandBtn').hidden=list.length<=visible;
  $('noteInstrument').innerHTML=list.map(i=>`<option value="${i.id}">${esc(i.name)} · ${esc(i.englishName)}</option>`).join('');
  $('noteInstrument').value=state.instrument;
  $('activeInstrumentLabel').textContent=`${inst(state.instrument).name} · ${inst(state.instrument).englishName}`;
}
function chooseInstrument(id, preview=true) {
  state.instrument=id;if(preview&&!state.selected.size)Object.assign(state,{velocity:100,pan:0,pitch:0});
  document.querySelectorAll('[data-instrument]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.instrument)===id);b.setAttribute('aria-pressed',String(Number(b.dataset.instrument)===id));});
  $('noteInstrument').value=id; $('activeInstrumentLabel').textContent=`${inst(id).name} · ${inst(id).englishName}`;
  if(preview) audition();
}
function renderLayers(){
  const scroll=$('gridScroll'),start=Math.max(0,Math.floor(scroll.scrollTop/ROW)-1),end=Math.min(song.layers.length,start+Math.ceil(scroll.clientHeight/ROW)+3),counts=new Map();
  for(let layer=start;layer<end;layer++)counts.set(layer,noteRows.get(layer)?.length||0);
  layerUI.render({start,end,scrollTop:scroll.scrollTop,counts});
}
function renderInspector() {
  const chosen=selectedNotes();
  if(chosen.length) { const n=chosen[0]; for(const p of ['key','velocity','pan','pitch'])state[p]=n[p]??(p==='velocity'?100:0); chooseInstrument(n.instrument,false); }
  $('selectionBadge').textContent=chosen.length;
  $('selectionHint').textContent=chosen.length?`已选择 ${chosen.length} 个音符${chosen.some(n=>song.layers[n.layer]?.locked)?' · 包含锁定音轨':''}`:'设置下一颗音符，或选择网格中的音符。';
  $('pitchName').textContent=noteName(state.key); $('keyInput').value=state.key;
  $('velocityInput').value=state.velocity; $('velocityValue').textContent=`${state.velocity}%`;
  $('panInput').value=state.pan; $('panValue').textContent=state.pan===0?'居中':`${state.pan<0?'左':'右'} ${Math.abs(state.pan)}%`;
  $('finePitchInput').value=state.pitch; $('noteInstrument').value=state.instrument;
  $('duplicateBtn').disabled=!editableNotes().length; $('deleteBtn').disabled=!editableNotes().length;
  document.querySelectorAll('[data-key]').forEach(b=>b.classList.toggle('active',Number(b.dataset.key)===state.key));
  updatePianoFeedback();
}
function renderPiano() {
  const whites=[],whiteCount=state.dropMode?52:clamp(Math.floor((document.documentElement.clientWidth-32)/39),3,Number(editorPreferences.keysmax)||30);
  const allWhites=Array.from({length:88},(_,i)=>i+21).filter(m=>![1,3,6,8,10].includes(m%12));if(whiteCount!==pianoWindowCount&&!state.dropMode)state.pianoStart=allWhites[clamp(27-Math.floor(whiteCount/2),0,52-whiteCount)];pianoWindowCount=whiteCount;
  const start=state.dropMode?21:clamp(state.pianoStart,21,allWhites[52-whiteCount]);let end=start;
  while(end<109&&whites.length<whiteCount){if(![1,3,6,8,10].includes(end%12))whites.push(end);end++;}
  const whiteWidth=100/whites.length;
  let html=whites.map(m=>`<button class="piano-white ${m-21===state.key?'active':''}" data-key="${m-21}" title="${noteName(m-21)}" aria-label="${noteName(m-21)}"><span class="piano-key-face" aria-hidden="true"></span>${pianoLabel(m-21)}</button>`).join('');
  for(let m=start;m<end;m++)if([1,3,6,8,10].includes(m%12)){const before=whites.filter(w=>w<m).length;html+=`<button class="piano-black ${m-21===state.key?'active':''}" data-key="${m-21}" style="left:${before*whiteWidth-whiteWidth*.3}%;width:${whiteWidth*.6}%" title="${noteName(m-21)}" aria-label="${noteName(m-21)}"><span class="piano-key-face" aria-hidden="true"></span>${pianoLabel(m-21)}</button>`;}
  $('piano').innerHTML=`<div class="piano-inner">${html}</div>`;
  pianoKeys=Array.from($('piano').querySelectorAll('[data-key]'),element=>({element,key:Number(element.dataset.key),last:''}));
  const origin=$('grid').getBoundingClientRect().left;keyPositions=[];for(const {key,element}of pianoKeys){const rect=element.getBoundingClientRect();keyPositions[key]={x:rect.left+rect.width/2-origin,width:rect.width};}
  updatePianoFeedback();
  $('octaveLabel').textContent=`${noteName(start-21)} — ${noteName(end-22)}`;
}
function retina(canvas,ctx,w,h) { const dpr=Math.min(devicePixelRatio||1,2); const pw=Math.round(w*dpr),ph=Math.round(h*dpr); if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;}ctx.setTransform(dpr,0,0,dpr,0,0); }
function resize() {
  canvasWidth=$('gridScroll').clientWidth; canvasHeight=$('gridScroll').clientHeight; rulerWidth=$('ruler').parentElement.clientWidth;
  retina($('grid'),g,canvasWidth,canvasHeight); retina($('ruler'),ruler,rulerWidth,32); retina($('overviewCanvas'),overview,$('overview').clientWidth,29);
  overviewDirty=true;
  renderLayers();renderPiano();renderRack();scheduleDraw();
}
function holdPiano(source,key){
  releasePiano(source);if(!Number.isInteger(key)||key<0||key>87)return;
  heldPiano.set(source,key);heldKeys[key]++;updatePianoFeedback();scheduleDraw();
}
function releasePiano(source){const key=heldPiano.get(source);if(key===undefined)return;heldPiano.delete(source);heldKeys[key]--;updatePianoFeedback();scheduleDraw();}
function clearPianoInput(){for(const source of [...heldPiano.keys()])if(!source.startsWith('midi:'))releasePiano(source);}
function updatePianoFeedback(){
  const hex=/^#[0-9a-f]{6}$/i.test(activeAccent||'')?activeAccent:'#0078d4';
  const accent=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)),high=Math.max(...accent),selection=accent.map(channel=>Math.floor((channel+high)/2));
  for(const entry of pianoKeys){
    const {element,key}=entry,age=playbackKeyAges[key],flash=Math.max(0,1-age/300),held=heldKeys[key]>0;
    const triangle=age>=0&&age<300?1-Math.abs(age/150-1):0;
    const depth=reducedMotion.matches?0:held?5:Math.floor(7*Math.floor(triangle*3)/3);
    const base=!playerMode&&key===state.key&&!engine.playing?selection:!playerMode&&editorPreferences.outOfRange&&(key<33||key>57)?[255,125,125]:[255,255,255];
    const tint=base.map((channel,i)=>Math.round(channel+((i===2?0:255)-channel)*flash)).join(' ');
    const signature=`${depth}:${tint}:${held}:${flash>0}`;if(signature===entry.last)continue;entry.last=signature;
    element.style.setProperty('--key-depth',`${depth}px`);element.style.setProperty('--key-tint',`rgb(${tint})`);
    element.classList.toggle('is-sounding',flash>0);element.classList.toggle('is-held',held);
  }
}
function scheduleDraw(){if(!frame)frame=requestAnimationFrame(()=>{
  frame=null;const position=engine.getPlaybackPosition();if(position.benchmarking)position.playing=false;playbackKeyAges=playbackVisuals.sample(position);
  if(position.playing){state.tick=tickAtFrame(position.frame,position.transport);const x=state.tick*state.cell,scroll=$('gridScroll');if(editorPreferences.follow&&!state.dropMode){if(editorPreferences.followMode==='page'){if(x>scroll.scrollLeft+canvasWidth-2*state.cell||x<scroll.scrollLeft)scroll.scrollLeft=Math.max(0,x-state.cell);}else scroll.scrollLeft=Math.max(0,(editorPreferences.followMode==='tick'?Math.floor(state.tick)*state.cell:x)-canvasWidth/2);}if(document.activeElement!==$('tempoInput'))$('tempoInput').value=(transportTempoAtTick(state.tick,position.transport)*(editorPreferences.bpm?15:1)).toFixed(2);}
  const rainbow=!!editorPreferences.rainbow!==!!position.rainbowActive;activeAccent=rainbow&&!reducedMotion.matches?rainbowColor(performance.now()*.12%360):editorPreferences.accent;document.documentElement.style.setProperty('--accent',activeAccent);
  const metroFrame=metronome?(Math.floor(state.tick/4)%2?'53-metronome-2':'52-metronome-1'):'51-metronome-inactive';const metroImage=$('metronomeBtn').querySelector('img');if(metroImage.dataset.frame!==metroFrame){metroImage.dataset.frame=metroFrame;metroImage.src=`assets/original/toolbar-light/${metroFrame}.png`;}
  updatePianoFeedback();draw();if(position.playing||removalEffects.length||rainbow&&!reducedMotion.matches)scheduleDraw();
});}
function draw(){
  const scroll=$('gridScroll'),now=performance.now();removalEffects=removalEffects.filter(effect=>now-effect.started<278);
  if(!playerMode||state.dropMode)drawNativeGrid({ctx:g,ruler,song,state,prefs:{...editorPreferences,accent:activeAccent},width:canvasWidth,height:canvasHeight,rulerWidth,scrollX:scroll.scrollLeft,scrollY:scroll.scrollTop,rows:noteRows,drawNote,visuals:playbackVisuals,solo:hasSolo,dark:document.body.classList.contains('theme-dark'),removalEffects:reducedMotion.matches?[]:removalEffects,dropNotes,keyPositions,secondsAtTick:tick=>secondsAtTick(tick,tempoMap,song.tempo)});
  if(!playerMode)drawOverview();updatePosition();
}
function drawOverview() {
  const width=$('overview').clientWidth,height=29,duration=totalTicks();if(!width)return;
  if(overviewDirty){const cache=overviewCache.getContext('2d');retina(overviewCache,cache,width,height);cache.clearRect(0,0,width,height);cache.fillStyle='#161c20';cache.fillRect(0,0,width,height);cache.globalAlpha=.6;for(const n of song.notes){cache.fillStyle=INSTRUMENTS[n.instrument]?.color||'#b6e878';cache.fillRect(n.tick/duration*width,n.layer/Math.max(6,song.layers.length)*(height-5)+2,Math.max(1,width/duration),Math.max(1,(height-5)/Math.max(6,song.layers.length)-1));}cache.globalAlpha=1;overviewDirty=false;}
  overview.clearRect(0,0,width,height);overview.drawImage(overviewCache,0,0,width,height);const x=$('gridScroll').scrollLeft/(duration*state.cell)*width,vw=Math.min(width,canvasWidth/(duration*state.cell)*width);overview.fillStyle='#c8e5b013';overview.fillRect(x,0,vw,height);overview.strokeStyle='#a6bf8455';overview.strokeRect(x+.5,.5,vw-1,height-1);overview.fillStyle='#b6e878';overview.fillRect(state.tick/duration*width,0,1,height);
}
function updatePosition() {
  const tick=Math.floor(state.tick),bar=beatsPerBar(),beat=Math.floor((tick%bar)/TICKS_PER_BEAT)+1;
  $('positionDisplay').innerHTML=`${String(Math.floor(tick/bar)+1).padStart(3,'0')} <em>: ${String(beat).padStart(2,'0')}</em>`;
  playerUI.update({player:playerMode,dropMode:state.dropMode,tick:state.tick,playing:engine.playing,loop:song.loop});
  const sec=secondsAtTick(state.tick,tempoMap,song.tempo);$('timeDisplay').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${(sec%60).toFixed(2).padStart(5,'0')}`;
}
async function audition(note) {
  engine.customInstruments=song.customInstruments;
  try {await engine.preview(note||{key:state.key,instrument:state.instrument,velocity:state.velocity,pan:state.pan,pitch:state.pitch},note?song.layers[note.layer]:{volume:100,pan:0});if(engine.warnings.length)toast(engine.warnings.at(-1));}catch(error){errorMessage(error);}
}
function applyProperty(property,value,{preview=false}={}) {
  const notes=editableNotes(); if(notes.length){checkpoint();notes.forEach(n=>n[property]=property==='pitch'&&controlType(n,song)!=='tempo'?clamp(value,-1200,1200):value);refresh({layers:false,save:true});}
  else {state[property]=value;renderInspector();}
  if(property==='key')updatePianoFeedback();if(preview)audition();
}
function setTool(tool){state.tool=tool;document.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('gridScroll').style.cursor=tool==='select'?'default':tool==='erase'?'cell':'crosshair';}
function setTick(tick,follow=false) {state.tick=clamp(tick,0,song.length);if(follow){const x=state.tick*state.cell;if(x<$('gridScroll').scrollLeft||x>$('gridScroll').scrollLeft+canvasWidth-25)$('gridScroll').scrollLeft=Math.max(0,x-40);}scheduleDraw();}
function setZoom(value) {const center=($('gridScroll').scrollLeft+canvasWidth/2)/state.cell;state.cell=clamp(value,1,80);$('zoomLabel').textContent=`${Math.round(state.cell/32*100)}%`;refresh({layers:false,inspector:false});$('gridScroll').scrollLeft=Math.max(0,center*state.cell-canvasWidth/2);}
function clearPlaybackFeedback(){playbackVisuals.clear();playbackKeyAges.fill(Infinity);updatePianoFeedback();scheduleDraw();}
function stopPlayback(reset=true,{tails=false}={}) {resumeTransport=false;engine.stop({tails});recordArmed=false;recordingStarted=false;$('recordMidiBtn').classList.remove('active');$('recordMidiBtn').setAttribute('aria-pressed','false');clearPlaybackFeedback();$('playBtn').innerHTML=transportIcon('play');$('playBtn').setAttribute('aria-label','播放');$('tempoInput').value=song.tempo*(editorPreferences.bpm?15:1);if(reset)setTick(0);}
async function togglePlayback({resume=false}={}) {
  if(state.busy)return;
  if(engine.playing){state.tick=engine.pause({tails:true});recordArmed=false;recordingStarted=false;$('recordMidiBtn').classList.remove('active');$('recordMidiBtn').setAttribute('aria-pressed','false');resumeTransport=true;clearPlaybackFeedback();$('playBtn').innerHTML=transportIcon('play');$('playBtn').setAttribute('aria-label','播放');return;}
  try {state.busy=true;$('statusText').textContent='正在准备音色…';const section=state.section,endTick=section&&editorPreferences.sectionEnd?section.end:undefined,fromTick=section&&editorPreferences.sectionStart&&!resume&&!resumeTransport?section.start:state.tick>=(endTick||song.length)?section?.start||0:state.tick;await engine.play(song,{fromTick,endTick,loopStart:endTick?section.start:song.loopStart,loop:song.loop,metronome,masterVolume:Number($('masterVolume').value)/100,onError:error=>{stopPlayback(false);errorMessage(error);},onEnded:()=>{resumeTransport=false;recordArmed=false;recordingStarted=false;$('recordMidiBtn').classList.remove('active');$('recordMidiBtn').setAttribute('aria-pressed','false');clearPlaybackFeedback();$('playBtn').innerHTML=transportIcon('play');$('playBtn').setAttribute('aria-label','播放');setTick(editorPreferences.returnMarker?0:endTick||song.length);$('statusText').textContent='播放结束';}});if(!engine.playing)return;$('playBtn').innerHTML=transportIcon('pause');$('playBtn').setAttribute('aria-label','暂停');$('statusText').textContent='正在播放';resumeTransport=false;
    scheduleDraw();if(engine.warnings.length)toast(engine.warnings.at(-1));
  }catch(error){errorMessage(error);}finally{state.busy=false;}
}
function restartIfPlaying(){if(!engine.playing)return;try{if(engine.updateSong(song)===false){state.tick=engine.pause();resumeTransport=true;clearPlaybackFeedback();togglePlayback();}}catch(error){errorMessage(error);}}
function point(event){const rect=$('gridScroll').getBoundingClientRect(),x=event.clientX-rect.left+$('gridScroll').scrollLeft,y=event.clientY-rect.top+$('gridScroll').scrollTop;return{x,y,tick:Math.max(0,Math.floor(x/state.cell)),layer:Math.floor(y/ROW),snap:Math.max(0,Math.floor(x/state.cell/state.snap)*state.snap)};}
function addNote(p) {
  if(p.layer<0||p.layer>=song.layers.length||song.layers[p.layer].locked||p.snap>999999)return null;
  const k=`${p.snap}:${p.layer}`;if(cellIndex.has(k))return null;
  if(song.notes.length>=MAX_NOTES){toast(`曲谱已达到 ${MAX_NOTES.toLocaleString()} 个音符上限`,true);return null;}
  const n={id:uniqueId(),tick:p.snap,layer:p.layer,key:state.key,instrument:state.instrument,velocity:state.velocity,pan:state.pan,pitch:state.pitch};song.notes.push(n);cellIndex.set(k,n);song.length=Math.max(song.length,n.tick+1);return n;
}
function eraseNote(p){const n=cellIndex.get(`${p.tick}:${p.layer}`);if(n&&!song.layers[n.layer].locked){song.notes=song.notes.filter(a=>a.id!==n.id);cellIndex.delete(`${p.tick}:${p.layer}`);return true;}return false;}
function endGesture() {
  if(!state.gesture)return;const gesture=state.gesture;state.gesture=null;
  if(gesture.changed){if(gesture.type==='move'){const chosen=new Set(gesture.originals.map(n=>n.id)),occupied=new Set(song.notes.filter(n=>chosen.has(n.id)).map(n=>`${n.tick}:${n.layer}`));song.notes=song.notes.filter(n=>chosen.has(n.id)||!occupied.has(`${n.tick}:${n.layer}`));}refresh({save:true});}
  else refresh({layers:false});
}
$('gridScroll').addEventListener('pointerdown',event=>{
  if(playerMode||state.busy)return;
  if(event.button===1){event.preventDefault();const p=point(event),note=cellIndex.get(`${p.tick}:${p.layer}`);if(note){state.selected.clear();Object.assign(state,{instrument:note.instrument,key:note.key,velocity:note.velocity,pan:note.pan,pitch:note.pitch});chooseInstrument(note.instrument,false);renderInspector();updateCursorStatus(note);audition(note);}return;}
  if(event.button!==0&&event.button!==2)return;
  song.metadata||={};const clickKey=event.button===2?'rightClicks':'leftClicks';song.metadata[clickKey]=Math.min(0xffffffff,(Number(song.metadata[clickKey])||0)+1);
  const rect=$('gridScroll').getBoundingClientRect();if(event.clientX-rect.left>=canvasWidth||event.clientY-rect.top>=canvasHeight)return;
  const p=point(event);if(p.layer>=song.layers.length)return;event.preventDefault();$('gridScroll').focus();$('gridScroll').setPointerCapture(event.pointerId);
  state.layer=p.layer;const n=cellIndex.get(`${p.tick}:${p.layer}`);
  if(event.button===2||state.tool==='erase'){if(song.layers[p.layer].locked){toast('此音轨已锁定，双击音轨名称可解锁');return;}checkpoint();const changed=eraseNote(p);state.gesture={type:'erase',changed};refresh();return;}
  if(n){if(event.ctrlKey||event.metaKey){if(state.selected.has(n.id))state.selected.delete(n.id);else state.selected.add(n.id);}else if(!state.selected.has(n.id))state.selected=new Set([n.id]);
    state.gesture={type:'move',startTick:p.tick,startLayer:p.layer,originals:editableNotes().map(n=>({...n})),changed:false};audition(n);refresh();
  }else if(state.tool==='select'){const previous=event.ctrlKey||event.metaKey?new Set(state.selected):new Set();state.selected=previous;state.gesture={type:'select',startX:p.x,startY:p.y,x:p.x,y:p.y,previous:new Set(previous),changed:false};refresh();
  }else{if(song.layers[p.layer].locked){toast('此音轨已锁定，双击音轨名称可解锁');return;}checkpoint();const added=addNote(p);state.selected=new Set(added?[added.id]:[]);state.gesture={type:'paint',changed:!!added};if(added)audition(added);refresh();}
});
$('gridScroll').addEventListener('pointermove',event=>{
  const p=point(event),hover=cellIndex.get(`${p.tick}:${p.layer}`);state.hover=hover||null;updateCursorStatus(hover);
  const gesture=state.gesture;if(!gesture)return;
  if(gesture.type==='paint'){const added=addNote(p);if(added){gesture.changed=true;state.selected=new Set([added.id]);audition(added);refresh();}}
  if(gesture.type==='erase'){if(eraseNote(p)){gesture.changed=true;refresh();}}
  if(gesture.type==='select'){gesture.x=p.x;gesture.y=p.y;const minX=Math.min(gesture.startX,p.x),maxX=Math.max(gesture.startX,p.x),minY=Math.min(gesture.startY,p.y),maxY=Math.max(gesture.startY,p.y);state.selected=new Set([...gesture.previous,...song.notes.filter(n=>n.tick*state.cell+state.cell>minX&&n.tick*state.cell<maxX&&n.layer*ROW+ROW>minY&&n.layer*ROW<maxY).map(n=>n.id)]);renderInspector();scheduleDraw();}
  if(gesture.type==='move'&&gesture.originals.length){let dt=Math.round((p.tick-gesture.startTick)/state.snap)*state.snap,dl=p.layer-gesture.startLayer;const original=gesture.originals,area=bounds(original);dt=clamp(dt,-area.minTick,999999-area.maxTick);dl=clamp(dl,-area.minLayer,song.layers.length-1-area.maxLayer);if(original.some(n=>song.layers[n.layer+dl].locked))return;if(!gesture.changed&&(dt||dl)){checkpoint();gesture.changed=true;}if(gesture.changed){const origins=new Map(original.map(n=>[n.id,n]));song.notes.forEach(n=>{const o=origins.get(n.id);if(o){n.tick=o.tick+dt;n.layer=o.layer+dl;}});refresh({layers:false,inspector:false});}}
});
$('gridScroll').addEventListener('pointerleave',()=>{state.hover=null;updateCursorStatus();});
$('gridScroll').addEventListener('pointerup',endGesture);$('gridScroll').addEventListener('pointercancel',endGesture);
$('gridScroll').addEventListener('contextmenu',e=>e.preventDefault());
$('gridScroll').addEventListener('scroll',()=>{renderLayers();scheduleDraw();},{passive:true});
$('gridScroll').addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();setZoom(state.cell*(e.deltaY>0?.9:1.1));return;}if(playerMode||state.busy)return;const p=point(e),note=cellIndex.get(`${p.tick}:${p.layer}`),direction=e.deltaY<0?1:-1;if(editorPreferences.wheelProperties&&note&&!song.layers[note.layer]?.locked){e.preventDefault();adjustMode(direction,state.editMode==='key'?e.shiftKey:!e.shiftKey,[note]);}else if(editorPreferences.wheelMode==='instrument'){e.preventDefault();state.selected.clear();chooseInstrument((state.instrument+direction+instruments().length)%instruments().length);renderInspector();}else if(editorPreferences.wheelMode==='key'){e.preventDefault();state.key=clamp(state.key+direction,0,87);renderInspector();audition();}else if(e.shiftKey){e.preventDefault();$('gridScroll').scrollLeft+=e.deltaY;}},{passive:false});
$('layerPane').addEventListener('wheel',e=>{$('gridScroll').scrollTop+=e.deltaY;e.preventDefault();},{passive:false});
let rulerGesture=null;
const rulerTick=event=>clamp(Math.round((event.clientX-$('ruler').getBoundingClientRect().left+$('gridScroll').scrollLeft)/state.cell),0,song.length);
$('ruler').addEventListener('pointerdown',event=>{if(event.button!==0||state.busy)return;event.preventDefault();$('ruler').setPointerCapture(event.pointerId);const tick=rulerTick(event),resume=engine.playing;stopPlayback(false);const start=state.section?.start,end=state.section?.end,mode=start!==undefined&&Math.abs(event.clientX-$('ruler').getBoundingClientRect().left+$('gridScroll').scrollLeft-start*state.cell)<8?'start':end!==undefined&&Math.abs(event.clientX-$('ruler').getBoundingClientRect().left+$('gridScroll').scrollLeft-end*state.cell)<8?'end':'new';rulerGesture={anchor:tick,mode,resume,moved:false};setTick(tick);engine.previewNotes(columns.get(Math.floor(tick))||[],song.layers,Number($('masterVolume').value)/100).catch(errorMessage);});
$('ruler').addEventListener('pointermove',event=>{if(!rulerGesture)return;const tick=rulerTick(event),gesture=rulerGesture;if(tick!==gesture.anchor)gesture.moved=true;if(gesture.mode==='start')state.section={start:tick,end:state.section.end};else if(gesture.mode==='end')state.section={start:state.section.start,end:tick};else if(gesture.moved)state.section={start:gesture.anchor,end:tick};setTick(tick);if(!gesture.moved)engine.previewNotes(columns.get(tick)||[],song.layers,Number($('masterVolume').value)/100).catch(errorMessage);});
const endRulerGesture=()=>{if(!rulerGesture)return;const resume=rulerGesture.resume;rulerGesture=null;if(state.section){const{start,end}=state.section;state.section=start===end?null:{start:Math.min(start,end),end:Math.max(start,end)};}scheduleDraw();if(resume)togglePlayback({resume:true});};
$('ruler').addEventListener('pointerup',endRulerGesture);$('ruler').addEventListener('pointercancel',endRulerGesture);$('ruler').addEventListener('contextmenu',showSectionMenu);

$('overview').addEventListener('pointerdown',event=>{const rect=$('overview').getBoundingClientRect();$('gridScroll').scrollLeft=(event.clientX-rect.left)/rect.width*totalTicks()*state.cell-canvasWidth/2;});

function deleteSelection(){const ids=new Set(editableNotes().map(n=>n.id));if(!ids.size)return;checkpoint();song.notes=song.notes.filter(n=>!ids.has(n.id));state.selected.clear();refresh({save:true});}
function copySelection(cut=false){const notes=selectedNotes();if(!notes.length)return;const {minTick,minLayer}=bounds(notes);state.clipboard=notes.map(n=>({...n,tick:n.tick-minTick,layer:n.layer-minLayer}));if(cut)deleteSelection();toast(`已${cut?'剪切':'复制'} ${notes.length} 个音符`);}
function pasteSelection({duplicate=false}={}) {
  let notes=state.clipboard,tick=Math.floor(state.tick/state.snap)*state.snap,layer=state.layer;
  if(duplicate){const chosen=selectedNotes();if(!chosen.length)return;const {minTick,minLayer,maxTick}=bounds(chosen);notes=chosen.map(n=>({...n,tick:n.tick-minTick,layer:n.layer-minLayer}));tick=maxTick+state.snap;layer=minLayer;}
  if(!notes?.length)return;
  try{const staged={...song,layers:song.layers.slice(),notes:song.notes.slice()},ids=pasteNotes(staged,notes,{tick,layer});if(!ids.length)return;checkpoint();song.layers=staged.layers;song.notes=staged.notes;song.length=staged.length;state.selected=new Set(ids);refresh({save:true});setTick(tick,true);}catch(error){errorMessage(error);}
}
function moveSelection(dt,dl,dk=0){if(!editableNotes().length)return;checkpoint();if(moveNotes(song,state.selected,{dt,dl,dk}))refresh({save:true});}
function undo(redo=false){const next=redo?history.redo(song):history.undo(song);if(next){stopPlayback(false);const from=redo?sampleRedo:sampleUndo,to=redo?sampleUndo:sampleRedo;to.push(new Map(engine.customSamples));engine.customSamples=new Map(from.pop()||[]);sampleUndo.splice(0,Math.max(0,sampleUndo.length-history.undoDepth));sampleRedo.splice(0,Math.max(0,sampleRedo.length-history.redoDepth));song=next;engine.customInstruments=song.customInstruments;engine.warnings=[];state.instrument=clamp(state.instrument,0,15+song.customInstruments.length);renderRack();refresh({save:true});toast(redo?'已重做':'已撤销');}}
function replaceSong(next,{clearHistory=true,normalized=false}={}){features.rememberProject(song).catch(console.warn);stopPlayback();state.section=null;if(clearHistory){history.clear();sampleUndo.length=0;sampleRedo.length=0;}song=normalized?next:normalizeSong(next);state.selected.clear();state.layer=0;state.tick=0;state.instrument=0;engine.customSamples.clear();engine.customInstruments=song.customInstruments;engine.warnings=[];$('gridScroll').scrollLeft=0;$('gridScroll').scrollTop=0;renderRack();renderPiano();refresh({save:true});resize();if(song.notes.some(n=>n.instrument>=16))toast('此曲使用自定义音色；请添加对应音频文件，未加载时以竖琴试听。');}
function modal(title,content,footer=''){$('modalContent').innerHTML=`<div class="modal-heading"><h2>${title}</h2><button data-close aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${content}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}`;$('modalContent').querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('modal').close());$('modal').showModal();}
function confirmReplace(action){if(!song.notes.length){action();return;}modal('替换当前曲谱？','<p>当前曲谱的浏览器自动保存也会被替换。需要保留曲谱和自定义采样时，请先保存完整工程包。</p>',`<button class="secondary-button" id="saveBeforeReplace">先保存完整工程包</button><button class="primary-button" id="confirmReplace">继续</button>`);$('saveBeforeReplace').onclick=()=>features.actions.saveProject();$('confirmReplace').onclick=()=>{$('modal').close();action();};}
async function loadFile(file){try{if(/\.midi?$/i.test(file.name)){features.importMidi(file);return;}if(/\.(nbpz|zip)$/i.test(file.name)){await features.importBundle(file);return;}if(/\.nbp$/i.test(file.name)){await features.importPattern(file);return;}if(file.size>128*1024*1024)throw new Error('文件过大，支持最大 128 MB。');$('statusText').textContent='正在预读本地文件…';const next=await projectStore.parse(file,message=>$('statusText').textContent=message);confirmReplace(()=>{replaceSong(next,{normalized:true});toast(`已打开 ${file.name} · ${song.notes.length.toLocaleString()} 个音符`);});}catch(error){errorMessage(error);}}

function download(data,name,type='application/octet-stream'){const blob=data instanceof Blob?data:new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
const filename=()=> (song.title||'未命名曲谱').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
function downloadNBS(){try{download(writeNBS(song,exportOptions),`${filename()}.nbs`);toast('已导出 NBS 曲谱');}catch(error){errorMessage(error);}}
function showExport(){modal('导出曲谱',`<p>文件将保存到浏览器的下载目录。</p><button class="export-choice" id="exportNbs">${icon('music')}<span><strong>NBS 曲谱</strong><small>版本 5 · 附带本地混响扩展；原版忽略混响</small></span></button><button class="export-choice" id="exportMidi">${icon('keyboard')}<span><strong>MIDI 文件</strong><small>在其他音乐软件中使用 · 使用 GM 乐器映射</small></span></button><button class="export-choice" id="exportWav">${icon('volume')}<span><strong>WAV 音频</strong><small>48 kHz · 立体声 · 16-bit PCM · 独立混响</small></span></button><button class="export-choice" id="exportJson">${icon('save')}<span><strong>完整项目 JSON</strong><small>保留每轨混响、编辑属性 · 不包含自定义音频</small></span></button><button class="export-choice" id="exportAudioFormats"><span><strong>MP3 / FLAC / AIFF / OGG 与音频设置</strong><small>浏览器 Rust 渲染 · WASM 编码</small></span></button><button class="export-choice" id="exportMinecraft"><span><strong>Minecraft 结构与数据包</strong><small>Schematic / NBT / Branch / Track / Datapack</small></span></button><button class="export-choice" id="exportBundle"><span><strong>完整工程包</strong><small>包含自定义音频与全部工程状态</small></span></button><div id="exportProgress" class="audio-progress" role="status"></div>`);
  $('exportAudioFormats').onclick=features.actions.audioExport;$('exportMinecraft').onclick=features.actions.minecraft;$('exportBundle').onclick=features.actions.saveProject;
  $('exportNbs').onclick=()=>downloadNBS();$('exportMidi').onclick=()=>{try{download(writeMIDI(song),`${filename()}.mid`,'audio/midi');toast('已导出 MIDI；音色使用 GM 映射');}catch(error){errorMessage(error);}};
  $('exportJson').onclick=()=>{download(JSON.stringify(song,null,2),`${filename()}.json`,'application/json');toast('已导出完整项目 JSON');};
  $('exportWav').onclick=async()=>{const button=$('exportWav');button.disabled=true;$('exportProgress').textContent='正在渲染本地音频，请稍候…';try{const blob=await engine.exportWav(song,{masterVolume:Number($('masterVolume').value)/100});download(blob,`${filename()}.wav`);if($('exportProgress'))$('exportProgress').textContent=`已导出 ${(blob.size/1024/1024).toFixed(1)} MB WAV 音频`;toast('WAV 导出完成');}catch(error){if($('exportProgress'))$('exportProgress').textContent='导出失败';errorMessage(error);}finally{if(button.isConnected)button.disabled=false;}};
}
function showSongInfo(){nativeDialogs.showInfo();}
function showSongProperties(){modal('曲谱设置',`<label>曲名<input id="infoTitle" maxlength="200" value="${esc(song.title)}"></label><label>作者<input id="infoAuthor" maxlength="200" value="${esc(song.author)}"></label><label>原作者<input id="infoOriginal" maxlength="200" value="${esc(song.originalAuthor)}"></label><label>描述<textarea id="infoDescription" maxlength="10000">${esc(song.description)}</textarea></label><label class="inline-label">曲谱长度（ticks）<input id="infoLength" type="number" min="1" max="65535" value="${song.length}"></label><label class="inline-label">循环起点（tick）<input id="infoLoop" type="number" min="0" max="65534" value="${song.loopStart||0}"></label><label class="inline-label">循环次数（0 = 无限）<input id="infoLoopCount" type="number" min="0" max="255" value="${song.loopCount||0}"></label>`,`<button class="secondary-button" data-close>取消</button><button class="primary-button" id="applySongInfo">保存设置</button>`);$('applySongInfo').onclick=()=>{checkpoint();song.title=$('infoTitle').value.trim()||'未命名曲谱';song.author=$('infoAuthor').value;song.originalAuthor=$('infoOriginal').value;song.description=$('infoDescription').value;const last=song.notes.reduce((v,n)=>Math.max(v,n.tick+1),1);song.length=Math.max(last,clamp(Number($('infoLength').value)||64,1,1000000));song.loopStart=clamp(Number($('infoLoop').value)||0,0,song.length-1);song.loopCount=clamp(Number($('infoLoopCount').value)||0,0,255);$('modal').close();refresh({save:true});};}
function showLayer(index){
  const layer=song.layers[index];let reverbCheckpoint=false;
  modal('音轨设置',`<label>名称<input id="layerName" maxlength="200" value="${esc(layer.name)}"></label><label class="inline-label">音量（%）<input id="layerVolume" type="number" min="0" max="100" value="${layer.volume}"></label><label class="inline-label">声像（-100 左 / +100 右）<input id="layerPan" type="number" min="-100" max="100" value="${layer.pan}"></label><label>混响 <output id="layerReverbValue">${Math.round(layer.reverb||0)}%</output><input id="layerReverb" type="range" min="0" max="100" value="${layer.reverb||0}" aria-label="本轨混响百分比"></label><p class="layer-context-note">混响调节即时生效。每条轨道使用独立的混响状态。</p><label class="inline-label">锁定音轨<input id="layerLock" type="checkbox" ${layer.locked?'checked':''}></label>`,`<button id="removeLayer" class="secondary-button" ${song.layers.length===1?'disabled':''}>删除此音轨</button><button class="primary-button" id="applyLayer">保存设置</button>`);
  $('layerReverb').oninput=()=>{if(!reverbCheckpoint){checkpoint();reverbCheckpoint=true;}$('undoBtn').disabled=false;layer.reverb=Number($('layerReverb').value);$('layerReverbValue').textContent=`${layer.reverb}%`;if(engine.playing)engine.updateTrackParams(song);renderLayers();persist();};
  $('applyLayer').onclick=()=>{checkpoint();layer.name=$('layerName').value.trim()||`音轨 ${index+1}`;layer.volume=clamp(Number($('layerVolume').value),0,100);layer.pan=clamp(Number($('layerPan').value),-100,100);layer.locked=$('layerLock').checked;$('modal').close();refresh({save:true});};
  $('removeLayer').onclick=()=>{checkpoint();song.layers.splice(index,1);song.layers.forEach((l,i)=>l.id=i);song.notes=song.notes.filter(n=>n.layer!==index);song.notes.forEach(n=>{if(n.layer>index)n.layer--;});$('modal').close();refresh({save:true});};
}
function showHelp(){modal('使用说明',`<p>文件解析、编辑、Rust 音频渲染和所有导出均在浏览器本机完成。</p><div class="help-grid">${[['播放 / 暂停','Space'],['停止并回到开头','Enter'],['撤销 / 重做','Ctrl Z / Ctrl Shift Z'],['复制 / 剪切 / 粘贴','Ctrl C / X / V'],['全选 / 反选','Ctrl A / I'],['删除音符','Delete'],['当前属性增减（粗调）','Ctrl E / D'],['当前属性增减（微调）','Ctrl R / F'],['设置 / 重置属性','Ctrl T / G'],['宏 / 图案 / 测速器','编辑菜单'],['切换内置音色','Ctrl 1–9 / Ctrl Shift 1–7'],['扩展 / 返回工作区','F11 / Esc'],['循环播放','L'],['打开 / 保存 NBS','Ctrl O / S'],['缩放网格','Ctrl + 滚轮']].map(([a,b])=>`<div><span>${a}</span><kbd>${b}</kbd></div>`).join('')}</div><p>点击网格添加音符，右键擦除，中键吸取音符属性。使用工具栏选择工具框选、拖动音符；Shift / Alt + ↑↓ 调整音高或八度。音符上滚轮编辑当前模式属性，Shift 切换粗调/微调。</p><p>拖动时间标尺建立区间，右键可设置区间播放。快进和倒带按钮可按住连续定位。图层名称可直接编辑；音量、声像可拖动或打开滑条，另有锁定、独奏、插入、删除及上下移动。</p><p>默认启用原版电脑琴键映射（1 Q 2 W…），右键琴键后可重绑。启用电脑琴键时，重叠的单字母工具快捷键优先演奏。点击录制按钮后，第一个琴键或 MIDI 音符开始录制；右键按钮打开 MIDI 设备。</p><p>自定义音色与曲谱自动保存在此浏览器。完整工程包保存所有音频；NBS/JSON 只保存引用。建议下载工程包备份。</p>`);}
function addCustomSample(targetIndex=null){$('sampleInput').dataset.target=targetIndex??'';$('sampleInput').click();}
$('sampleInput').onchange=async()=>{
  const file=$('sampleInput').files[0],target=$('sampleInput').dataset.target;$('sampleInput').value='';if(!file)return;
  const capturedSong=song,token=++sampleLoadToken,isCurrent=()=>song===capturedSong&&token===sampleLoadToken;
  try{
    if(file.size>32*1024*1024)throw new Error('单个自定义音色不能超过 32 MB。');
    let index=target!==''?Number(target):song.customInstruments.findIndex(i=>i.file===file.name);const isNew=index<0||!Number.isInteger(index);
    if(isNew){if(song.customInstruments.length>=240)throw new Error('NBS 最多支持 240 个自定义音色。');index=song.customInstruments.length;}
    const previousSamples=new Map(engine.customSamples),data=await file.arrayBuffer();if(!isCurrent())return;
    await engine.setCustomSample(16+index,data,{isCurrent});if(!isCurrent())return;
    checkpoint(previousSamples);if(isNew)song.customInstruments.push({name:file.name.replace(/\.[^.]+$/,''),file:file.name,key:45,pressKey:false});else song.customInstruments[index].file=file.name;
    engine.customInstruments=song.customInstruments;state.instrument=16+index;state.selected.clear();renderRack();refresh({save:true});toast(`已加载本地音色 ${file.name}`);audition();
  }catch(error){if(error.name!=='AbortError')errorMessage(error);}
};

function instrumentClick(event){const button=event.target.closest('[data-instrument]');if(!button)return;state.selected.clear();chooseInstrument(Number(button.dataset.instrument));renderInspector();updateCursorStatus();scheduleDraw();$('instrumentPopup').hidePopover();}
$('instrumentRack').onclick=instrumentClick;$('instrumentPopup').onclick=instrumentClick;
$('instrumentExpandBtn').onclick=()=>{const popup=$('instrumentPopup'),rect=$('instrumentExpandBtn').getBoundingClientRect();popup.style.left=`${clamp(rect.left-150,0,innerWidth-220)}px`;popup.style.top=`${rect.bottom+2}px`;popup.togglePopover();};
$('instrumentPopup').addEventListener('toggle',event=>$('instrumentExpandBtn').setAttribute('aria-expanded',String(event.newState==='open')));
$('instrumentRack').ondblclick=event=>{const button=event.target.closest('[data-instrument]');if(button&&Number(button.dataset.instrument)>=16)addCustomSample(Number(button.dataset.instrument)-16);};
$('customInstrumentBtn').onclick=()=>addCustomSample();
$('addLayerBtn').onclick=()=>{if(song.layers.length>=MAX_LAYERS){toast(`最多支持 ${MAX_LAYERS} 条音轨`,true);return;}checkpoint();song.layers.push({id:song.layers.length,name:`音轨 ${song.layers.length+1}`,volume:100,pan:0,reverb:0,muted:false,solo:false,locked:false});state.layer=song.layers.length-1;refresh({save:true});$('gridScroll').scrollTop=state.layer*ROW;};
function playPointerKey(event){
  const element=document.elementFromPoint(event.clientX,event.clientY)?.closest('#piano [data-key]'),source=`pointer:${event.pointerId}`;
  if(!element){releasePiano(source);return;}const key=Number(element.dataset.key);
  if(heldPiano.get(source)===key)return;holdPiano(source,key);selectLiveKey(key);if(!recordLiveNote({key,instrument:state.instrument,velocity:100,pan:0,pitch:0}))audition({key,instrument:state.instrument,velocity:100,pan:0,pitch:0,layer:state.layer});
}
$('piano').addEventListener('pointerdown',event=>{if(event.button!==0||!event.target.closest('[data-key]'))return;event.preventDefault();$('piano').setPointerCapture(event.pointerId);playPointerKey(event);});
$('piano').addEventListener('pointermove',event=>{if($('piano').hasPointerCapture(event.pointerId))playPointerKey(event);});
for(const name of ['pointerup','pointercancel','lostpointercapture'])$('piano').addEventListener(name,event=>releasePiano(`pointer:${event.pointerId}`));
$('piano').addEventListener('keydown',event=>{if((event.code==='Space'||event.code==='Enter')&&event.target.closest('[data-key]')){event.preventDefault();event.stopPropagation();if(!event.repeat){const key=Number(event.target.closest('[data-key]').dataset.key);holdPiano(`button:${event.code}`,key);selectLiveKey(key);if(!recordLiveNote({key,instrument:state.instrument,velocity:100}))audition({key,instrument:state.instrument,velocity:100,pan:0,pitch:0,layer:state.layer});}}});

function rainbowColor(hue){const l=.46,a=.8*Math.min(l,1-l),channel=n=>{const k=(n+hue/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};return `#${channel(0)}${channel(8)}${channel(4)}`;}
function stopPianoEdge(){pianoEdge=null;cancelAnimationFrame(pianoEdgeFrame);pianoEdgeFrame=0;}
function setPianoEdge(direction){if(playerMode||!direction){stopPianoEdge();return;}if(pianoEdge?.direction===direction)return;stopPianoEdge();pianoEdge={direction,last:performance.now()+250};const step=now=>{if(!pianoEdge)return;if(now-pianoEdge.last>=100){pianoEdge.last=now;const whites=Array.from({length:88},(_,i)=>i+21).filter(m=>![1,3,6,8,10].includes(m%12)),index=whites.findIndex(m=>m>=state.pianoStart);state.pianoStart=whites[clamp(index+direction,0,52-pianoWindowCount)];renderPiano();}pianoEdgeFrame=requestAnimationFrame(step);};pianoEdgeFrame=requestAnimationFrame(step);}
function showNoteChart(key,event){const chart=$('noteChart');if(!editorPreferences.noteChart||playerMode||engine.playing){chart.hidden=true;return;}const midi=key+21;if(midi<28||midi>96){chart.hidden=true;return;}chart.hidden=false;chart.style.left=`${clamp(event.clientX-140,4,innerWidth-296)}px`;chart.style.top=`${Math.max(6,$('piano').getBoundingClientRect().top-244)}px`;const c=chart.querySelector('canvas').getContext('2d');c.clearRect(0,0,280,230);c.fillStyle='#fff';c.fillRect(0,0,280,230);c.strokeStyle='#999';for(let i=0;i<11;i++)if(i!==5){c.beginPath();c.moveTo(20,48+i*12);c.lineTo(260,48+i*12);c.stroke();}c.strokeStyle='#555';for(const y of [48,120]){c.beginPath();c.moveTo(20,y);c.lineTo(20,y+48);c.stroke();}for(const [i,image]of chartClefs.entries())if(image.complete&&image.naturalWidth)c.drawImage(image,31,i?123:40,28,i?28:59);const natural=[0,2,4,5,7,9,11],pitch=midi%12,accidental=!natural.includes(pitch),diatonic=Math.floor(midi/12)*7+natural.findIndex(n=>n>=pitch),y=108-(diatonic-35)*6;c.strokeStyle='#777';for(let line=108;line>=y-1;line-=12)if(line===108||line<48){c.beginPath();c.moveTo(126,line);c.lineTo(157,line);c.stroke();}for(let line=180;line<=y+1;line+=12){c.beginPath();c.moveTo(126,line);c.lineTo(157,line);c.stroke();}c.fillStyle='#111';c.beginPath();c.ellipse(141,y,7,4,-.3,0,Math.PI*2);c.fill();c.fillRect(147,y-28,1.5,28);if(accidental){c.font='20px serif';c.fillText(editorPreferences.flat?'♭':'♯',119,y+5);}c.font='12px Segoe UI';c.fillText(noteName(key),126,219);}
$('piano').addEventListener('contextmenu',event=>{const key=event.target.closest('[data-key]');if(!key||!editorPreferences.keyBindings||playerMode)return;event.preventDefault();pendingBinding=Number(key.dataset.key);toast(`为 ${noteName(pendingBinding)} 按一个新键；Delete 清除，Esc 取消`);});
$('piano').addEventListener('pointermove',event=>{const element=document.elementFromPoint(event.clientX,event.clientY)?.closest('#piano [data-key]');if(!element){setPianoEdge(0);$('noteChart').hidden=true;return;}const key=Number(element.dataset.key),whiteKeys=pianoKeys.filter(k=>k.element.classList.contains('piano-white'));setPianoEdge(key===whiteKeys[0]?.key?-1:key===whiteKeys.at(-1)?.key?1:0);showNoteChart(key,event);});
$('piano').addEventListener('pointerleave',()=>{stopPianoEdge();$('noteChart').hidden=true;});
$('octaveDownBtn').onclick=()=>{state.pianoStart=Math.max(21,state.pianoStart-12);renderPiano();};$('octaveUpBtn').onclick=()=>{state.pianoStart=Math.min(72,state.pianoStart+12);renderPiano();};
$('noteInstrument').onchange=()=>{const id=Number($('noteInstrument').value);applyProperty('instrument',id);chooseInstrument(id);};
$('keyInput').onchange=()=>applyProperty('key',clamp(Math.round(Number($('keyInput').value)||0),0,87),{preview:true});
$('pitchDownBtn').onclick=()=>applyProperty('key',Math.max(0,state.key-1),{preview:true});$('pitchUpBtn').onclick=()=>applyProperty('key',Math.min(87,state.key+1),{preview:true});
$('velocityInput').oninput=()=>{$('velocityValue').textContent=`${$('velocityInput').value}%`;};$('velocityInput').onchange=()=>applyProperty('velocity',Number($('velocityInput').value));
$('panInput').oninput=()=>{const value=Number($('panInput').value);$('panValue').textContent=value?`${value<0?'左':'右'} ${Math.abs(value)}%`:'居中';};$('panInput').onchange=()=>applyProperty('pan',Number($('panInput').value));
$('finePitchInput').onchange=()=>applyProperty('pitch',clamp(Number($('finePitchInput').value)||0,-32768,32767),{preview:true});
$('previewNoteBtn').onclick=()=>audition();$('duplicateBtn').onclick=()=>pasteSelection({duplicate:true});$('deleteBtn').onclick=deleteSelection;
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
$('undoBtn').onclick=()=>undo();$('redoBtn').onclick=()=>undo(true);$('zoomOutBtn').onclick=()=>setZoom(state.cell/1.3);$('zoomInBtn').onclick=()=>setZoom(state.cell*1.3);$('fitBtn').onclick=()=>{setZoom(canvasWidth/Math.max(16,song.length+4));$('gridScroll').scrollLeft=0;};
$('snapSelect').onchange=()=>state.snap=Number($('snapSelect').value);
$('playBtn').onclick=togglePlayback;$('stopBtn').onclick=()=>stopPlayback(true,{tails:true});
document.querySelectorAll('[data-edit-mode]').forEach(button=>button.onclick=()=>setEditMode(button.dataset.editMode));
$('metronomeBtn').onclick=async()=>{const next=!metronome;try{await engine.setMetronome(next);metronome=next;$('metronomeBtn').setAttribute('aria-pressed',String(next));scheduleDraw();}catch(error){errorMessage(error);}};
$('workspaceBtn').onclick=toggleWorkspace;$('expandGridBtn').onclick=toggleWorkspace;
$('playerViewBtn').onclick=()=>setPlayerMode(!playerMode);
$('dropModeBtn').onclick=()=>{state.dropMode=!state.dropMode;setPlayerMode(state.dropMode||playerMode);};
for(const [id,direction]of [['startBtn',-1],['forwardBtn',1]]){const button=$(id);button.onpointerdown=event=>{if(event.button===0)seekHold(direction,event);};button.onkeydown=event=>{if(['Space','Enter'].includes(event.code)){event.preventDefault();event.stopPropagation();if(!event.repeat)seekHold(direction,event);}};button.onkeyup=event=>{if(['Space','Enter'].includes(event.code)){event.stopPropagation();seekRelease();}};}
for(const eventName of ['pointerup','pointercancel'])document.addEventListener(eventName,seekRelease);

$('loopBtn').onclick=()=>{checkpoint();song.loop=!song.loop;refresh({layers:false,inspector:false,save:true});};
$('tempoInput').onchange=()=>{checkpoint();song.tempo=clamp((Number($('tempoInput').value)||10)/(editorPreferences.bpm?15:1),.05,655.35);refresh({layers:false,inspector:false,save:true});};
$('signatureInput').onchange=()=>{checkpoint();song.timeSignature=clamp(Math.round(Number($('signatureInput').value)||4),1,16);refresh({layers:false,inspector:false,save:true});};
$('masterVolume').oninput=()=>{const value=Number($('masterVolume').value);$('volumeLabel').textContent=`${value}%`;engine.setVolume(value/100);};
$('newBtn').onclick=()=>confirmReplace(()=>replaceSong(createBlankSong()));$('openBtn').onclick=()=>$('fileInput').click();$('fileInput').onchange=()=>{const file=$('fileInput').files[0];$('fileInput').value='';if(file)loadFile(file);};
$('saveBtn').onclick=downloadNBS;$('exportBtn').onclick=showExport;$('songInfoBtn').onclick=showSongInfo;$('helpBtn').onclick=showHelp;
$('demoSelect').onchange=()=>{const value=$('demoSelect').value;$('demoSelect').value='';if(!value)return;confirmReplace(async()=>{try{if(value==='welcome')replaceSong(createDemoSong());else{const response=await fetch(`assets/songs/${encodeURIComponent(value)}`);if(!response.ok)throw new Error('无法打开本地示例曲');replaceSong(await projectStore.parse(new File([await response.blob()],value)),{normalized:true});}toast('已载入示例曲');}catch(error){errorMessage(error);}});};
$('modal').addEventListener('click',event=>{if(event.target===$('modal')){const rect=$('modal').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('modal').close();}});
document.addEventListener('keydown',event=>{
  if(pendingBinding!==null){event.preventDefault();if(event.key==='Escape'){pendingBinding=null;toast('已取消键位绑定');return;}if(event.key==='Delete'||event.key==='Backspace'||event.key.length===1){for(const[key,midi]of Object.entries(pianoBindings))if(midi===pendingBinding+21)delete pianoBindings[key];if(event.key.length===1)pianoBindings[event.key.toLowerCase()]=pendingBinding+21;localStorage.setItem('nbs-piano-bindings',JSON.stringify(pianoBindings));pendingBinding=null;renderPiano();toast('琴键绑定已更新');}return;}
  if(event.target.closest('input,textarea,select')||$('modal').open)return;
  const key=event.key.toLowerCase(),ctrl=event.ctrlKey||event.metaKey;
  if(ctrl&&event.shiftKey){const macroKeys=['a','s','d','f','g','h','j','k','q','w','e','r','t','y','u'],macroIds=['tremolo','stereo','arpeggio','portamento','vibrato','stagger','chorus','volume-lfo','fade-in','fade-out','replace-key','set-velocity','set-panning','set-pitch','reset-properties'];if(!playerMode&&macroKeys.includes(key)){event.preventDefault();features.actions.macro(macroIds[macroKeys.indexOf(key)]);return;}if(key==='p'){event.preventDefault();features.actions.patterns();return;}if(key==='i'){event.preventDefault();features.actions.tempoTap();return;}}
  if(ctrl){
    const digit=/^Digit([0-9])$/.exec(event.code)?.[1]||key;
    const instrument=/^[1-9]$/.test(digit)&&!event.shiftKey?Number(digit)-1:/^[1-7]$/.test(digit)&&event.shiftKey?Number(digit)+8:null;
    if(instrument!==null&&!playerMode){event.preventDefault();state.selected.clear();chooseInstrument(instrument);renderInspector();return;}
    if(key==='0'){event.preventDefault();editorPreferences.scale=100;features.applyPrefs();return;}
    const callbacks={n:()=>!playerMode&&$('newBtn').click(),o:()=>$('fileInput').click(),s:downloadNBS,z:()=>!playerMode&&undo(event.shiftKey),y:()=>!playerMode&&undo(true),a:()=>{if(!playerMode){state.selected=new Set(song.notes.map(n=>n.id));renderInspector();scheduleDraw();}},c:()=>copySelection(),x:()=>!playerMode&&copySelection(true),v:()=>!playerMode&&pasteSelection(),i:()=>!playerMode&&features.actions.invertSelection(),e:()=>adjustMode(1,true),d:()=>adjustMode(-1,true),r:()=>adjustMode(1),f:()=>adjustMode(-1),t:setModeProperty,g:resetModeProperty,p:()=>features.actions.preferences()};
    if(callbacks[key]){event.preventDefault();callbacks[key]();}return;
  }
  if((editorPreferences.keyboardInput||recordArmed)&&pianoBindings[key]!==undefined&&!event.altKey){event.preventDefault();if(!event.repeat){const note={key:pianoBindings[key]-21,instrument:state.instrument,velocity:state.velocity,pan:state.pan,pitch:state.pitch};holdPiano(`keyboard:${event.code}`,note.key);selectLiveKey(note.key);if(!recordLiveNote(note))engine.triggerLive(note,{channel:0,layer:song.layers[state.layer]}).catch(errorMessage);}return;}
  if(event.code==='Space'){event.preventDefault();togglePlayback();}
  else if(key==='enter'){event.preventDefault();stopPlayback(true,{tails:true});}
  else if(key==='escape'){if(document.body.classList.contains('expanded-workspace'))toggleWorkspace();else{stopPlayback(false);state.selected.clear();renderInspector();scheduleDraw();}}
  else if(key==='home'){event.preventDefault();seekTo(0);$('gridScroll').scrollLeft=0;}
  else if(key==='end'){event.preventDefault();$('gridScroll').scrollLeft=Math.max(0,song.length*state.cell-canvasWidth);}
  else if(key==='pageup'||key==='pagedown'){event.preventDefault();$('gridScroll').scrollLeft+=(key==='pageup'?-1:1)*canvasWidth;}
  else if(key==='f11'){event.preventDefault();toggleWorkspace();}
  else if(key==='l')$('loopBtn').click();
  else if(key==='?'||key==='f1'){event.preventDefault();showHelp();}
  else if(!playerMode){if(key==='b')setTool('draw');else if(key==='v')setTool('select');else if(key==='e')setTool('erase');else if(key==='delete'||key==='backspace'){event.preventDefault();deleteSelection();}else if(key.startsWith('arrow')){event.preventDefault();if(!state.selected.size&&(key==='arrowleft'||key==='arrowright'))seekTo(state.tick+(key==='arrowleft'?-4:4),{preview:true});else if(event.shiftKey||event.altKey){if(key==='arrowup'||key==='arrowdown')moveSelection(0,0,(key==='arrowup'?1:-1)*(event.altKey?12:1));}else moveSelection(key==='arrowleft'?-state.snap:key==='arrowright'?state.snap:0,key==='arrowup'?-1:key==='arrowdown'?1:0);}}
});
document.addEventListener('keyup',event=>{releasePiano(`keyboard:${event.code}`);releasePiano(`button:${event.code}`);});
window.addEventListener('blur',()=>{clearPianoInput();seekRelease();stopPianoEdge();$('noteChart').hidden=true;});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearPianoInput();else scheduleDraw();});
reducedMotion.addEventListener('change',()=>{updatePianoFeedback();scheduleDraw();});
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();dragDepth++;$('dropOverlay').hidden=false;}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('dropOverlay').hidden=true;}});
document.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('dropOverlay').hidden=true;const file=event.dataTransfer?.files[0];if(file)loadFile(file);});
window.addEventListener('pagehide',()=>{if(dirty)flushSave();});
window.addEventListener('beforeunload',event=>{if(dirty){flushSave();event.preventDefault();event.returnValue='';}});
new ResizeObserver(resize).observe($('gridScroll'));
function toggleProperties(){const panel=$('propertiesPanel'),hidden=panel.classList.toggle('is-hidden');$('propertiesBtn').setAttribute('aria-expanded',String(!hidden));}
$('propertiesBtn').onclick=toggleProperties;$('closePropertiesBtn').onclick=()=>{$('propertiesPanel').classList.add('is-hidden');$('propertiesBtn').setAttribute('aria-expanded','false');};
$('engineSettingsBtn').onclick=showEngineSettings;$('performanceBtn').onclick=showPerformance;
const layerUI=createNativeLayerUI({getSong:()=>song,getState:()=>state,checkpoint,refresh,persist,scheduleDraw,engine,showLayer,toast,error:errorMessage,isBusy:()=>state.busy||playerMode||!!benchmarkTask});
const nativeDialogs=createNativeDialogs({getSong:()=>song,checkpoint,refresh,modal,toast,error:errorMessage,showProperties:showSongProperties,engine,isBusy:()=>state.busy||!!benchmarkTask});
const features=installFeatureUI({getSong:()=>song,getState:()=>state,getEngine:()=>engine,getSelected:()=>state.selected,setSelected:ids=>state.selected=new Set(ids),checkpoint,refresh,persist,stopPlayback,replaceSong,confirmReplace,loadFile,download,downloadNBS,showSaveOptions,showStatistics:()=>nativeDialogs.showStatistics(),showTempoTap:()=>nativeDialogs.showTempoTap(),modal,toast,error:errorMessage,store:projectStore,preferences:editorPreferences,resize,renderRack,scheduleDraw,holdPiano,releasePiano,selectLiveKey,recordLiveNote,applyPlaybackPreferences,resetPianoBindings,addCustomSample,isBusy:()=>state.busy||playerMode||!!benchmarkTask});
const playerUI=createNativePlayerUI({getSong:()=>song,togglePlayback,stopPlayback:(reset=true)=>stopPlayback(reset,{tails:reset}),seekTo,seekHold,seekRelease,toggleLoop:()=>$('loopBtn').click(),secondsAtTick:tick=>secondsAtTick(tick,tempoMap,song.tempo),formatTime,isReducedMotion:()=>reducedMotion.matches});
$('recordMidiBtn').onclick=toggleRecordArm;$('recordMidiBtn').oncontextmenu=event=>{event.preventDefault();features.actions.midi();};
const nativeMenus=createNativeMenus({...features.actions,new:()=>$('newBtn').click(),open:()=>$('openBtn').click(),save:downloadNBS,saveOptions:showSaveOptions,export:showExport,info:showSongInfo,songProperties:showSongProperties,undo:()=>undo(),redo:()=>undo(true),copy:()=>copySelection(),cut:()=>copySelection(true),paste:()=>pasteSelection(),delete:deleteSelection,selectAll:()=>{state.selected=new Set(song.notes.map(n=>n.id));renderInspector();scheduleDraw();},deselect:()=>{state.selected.clear();renderInspector();scheduleDraw();},increaseCoarse:()=>adjustMode(1,true),decreaseCoarse:()=>adjustMode(-1,true),increaseFine:()=>adjustMode(1),decreaseFine:()=>adjustMode(-1),setModeProperty,resetModeProperty,resetScale:()=>{editorPreferences.scale=100;features.applyPrefs();},properties:toggleProperties,engineSettings:showEngineSettings,performance:showPerformance,help:showHelp},{getState:()=>({canUndo:history.canUndo,canRedo:history.canRedo,selectedCount:state.selected.size,noteCount:song.notes.length,clipboard:!!state.clipboard,playerMode,busy:state.busy,editMode:state.editMode,instrument:state.instrument,selectedInstrumentCount:song.notes.reduce((sum,n)=>sum+(n.instrument===state.instrument?1:0),0),customInstrumentCount:song.customInstruments.length}),getInstruments:instruments,onChooseInstrument:(id,{applyToSelection}={})=>{if(applyToSelection)applyProperty('instrument',id);else state.selected.clear();chooseInstrument(id);renderInspector();scheduleDraw();}});
async function boot(){try{const cached=await projectStore.load();if(cached){song=cached;restored=true;}await features.restoreSamples();}catch(error){console.warn('IndexedDB restoration unavailable',error);}hydrateIcons();$('app').hidden=false;$('boot').hidden=true;renderRack();renderPiano();refresh();resize();setTool('draw');$('statusText').textContent=restored?'已恢复上次在此浏览器中的曲谱':'准备就绪';await features.startup();}
boot().catch(errorMessage);
setInterval(updateEngineDisplay,250);
setInterval(()=>{if(!document.hidden&&!playerMode){song.metadata||={};song.metadata.minutesSpent=Math.min(0xffffffff,(Number(song.metadata.minutesSpent)||0)+1);persist();}},60000);

let benchmarkReport=null, benchmarkTask=null;
const metricNumber=value=>Number.isFinite(Number(value))?Number(value).toFixed(2):'—';
function performanceMetrics(stats){return `<div class="performance-grid">${[
  ['正在发声',`${stats.activeVoices||0} / ${stats.tracks||0}`],['独立混响轨道',stats.reverbTracks||0],
  ['工作线程',stats.workers||0],['音频块',`${stats.blockFrames||engine.config.blockFrames} 帧`],
  ['预读音频',`${metricNumber(stats.renderAheadMs??stats.leadFrames/(engine.context?.sampleRate||48000)*1000)} ms`],
  ['声卡基础 / 输出',`${metricNumber(stats.baseLatencyMs)} / ${metricNumber(stats.outputLatencyMs)} ms`],
  ['混响控制排队',`${metricNumber(stats.controlPipelineMs)} ms`],['控制确认耗时',`${metricNumber(stats.controlAckMs)} ms`],
  ['线程 P95 / 最大',`${metricNumber(stats.p95WorkerMs)} / ${metricNumber(stats.maxWorkerMs)} ms`],
  ['欠载音频块',stats.underruns||0],['丢弃声部',stats.droppedVoices||0],['输出 RMS',Number(stats.outputRms||0).toFixed(6)],
].map(([label,value])=>`<div><small>${label}</small><strong>${esc(value)}</strong></div>`).join('')}</div>`;}
function updateEngineDisplay(){const stats=engine.getStats();$('engineStats').textContent=stats.workers?`${stats.workers} 线程 · ${stats.activeVoices.toLocaleString()} 声部 · 欠载 ${stats.underruns}`:'本地音频';if($('liveMetrics'))$('liveMetrics').innerHTML=performanceMetrics(stats);}
function showEngineSettings(){const cfg=engine.config;modal('音频设置',`<p>采用本地多核处理，预读仅缓冲短音频块。混响和编辑仍实时计算。</p><label class="inline-label">工作线程<input id="engineWorkers" type="number" min="1" max="32" value="${cfg.workers}"></label><label class="inline-label">每块采样帧<select id="engineFrames"><option>128</option><option>256</option><option>512</option></select></label><label class="inline-label">预读块数<input id="engineLead" type="number" min="1" max="16" value="${cfg.leadBlocks}"></label><p>较小的缓冲会降低延迟，也更容易受到系统调度抖动影响。可通过万轨测试检查实际欠载。</p><p class="layer-context-note">每轨仅显示混响百分比；干湿比与阻尼由固定混响预设处理。</p>`,`<button class="secondary-button" data-close>取消</button><button id="applyEngineSettings" class="primary-button">应用</button>`);$('engineFrames').value=cfg.blockFrames;$('applyEngineSettings').onclick=()=>{try{stopPlayback(false);engine.configure({workers:Number($('engineWorkers').value),blockFrames:Number($('engineFrames').value),leadBlocks:Number($('engineLead').value)});try{localStorage.setItem('nbs-rust-audio-settings',JSON.stringify(engine.config));}catch{}$('modal').close();toast('音频设置已更新');}catch(error){errorMessage(error);}};}
function showPerformance(){
  modal('播放性能',`<div id="liveMetrics">${performanceMetrics(engine.getStats())}</div><p>测试会实时运行 10,000 条持续发声轨道，每轨开启独立混响。当前曲谱不会被替换。</p><label class="inline-label">测试时间（秒）<input id="benchmarkSeconds" type="number" min="5" max="600" value="60"></label><div class="benchmark-actions"><button id="runBenchmarkBtn" class="primary-button" ${benchmarkTask?'disabled':''}>运行万轨测试</button><button id="cancelBenchmarkBtn" class="secondary-button">停止测试</button><button id="saveBenchmarkBtn" class="secondary-button" ${benchmarkReport?'':'disabled'}>保存报告</button></div><label class="inline-label">测试音轨<input id="benchmarkTrack" type="number" min="1" max="10000" value="1"></label><label>测试音轨混响 <output id="benchmarkReverbValue">50%</output><input id="benchmarkReverb" type="range" min="0" max="100" value="50" aria-label="测试音轨混响"></label><p id="benchmarkStatus" role="status">测试结果会区分实际同时发声、欠载和丢声。关闭窗口会停止测试。</p><p class="layer-context-note">声卡延迟使用浏览器提供的估计值；控制确认时间包含线程消息调度，不等于声学测量。</p>`);
  $('benchmarkReverb').oninput=()=>{const reverb=Number($('benchmarkReverb').value);$('benchmarkReverbValue').textContent=`${reverb}%`;if(benchmarkTask)engine.updateBenchmarkTrack(Number($('benchmarkTrack').value)-1,{reverb});};
  $('runBenchmarkBtn').onclick=async()=>{
    if(benchmarkTask)return;const button=$('runBenchmarkBtn');button.disabled=true;$('saveBenchmarkBtn').disabled=true;state.busy=true;stopPlayback(false);
    const seconds=clamp(Number($('benchmarkSeconds').value)||60,5,600);
    benchmarkTask=engine.runBenchmark({tracks:10000,durationSeconds:seconds,reverb:50,onProgress:stats=>{if($('benchmarkStatus'))$('benchmarkStatus').textContent=`测试中 ${stats.elapsedSeconds.toFixed(1)} / ${seconds} 秒 · ${stats.activeVoices} 声部 · 欠载 ${stats.underruns} · 丢声 ${stats.droppedVoices}`;}});
    try{
      benchmarkReport=await benchmarkTask;benchmarkReport.realtimeVerified=benchmarkReport.simultaneousTracksVerified&&benchmarkReport.underruns===0&&benchmarkReport.nonSilentOutputVerified;
      if($('benchmarkStatus'))$('benchmarkStatus').textContent=benchmarkReport.realtimeVerified?'通过：10,000 声部持续实时播放，零欠载、零丢声。':`测试完成：最低 ${benchmarkReport.minimumActiveVoices} 声部，欠载 ${benchmarkReport.underruns}，丢声 ${benchmarkReport.maximumDroppedVoices}。`;
      if($('saveBenchmarkBtn'))$('saveBenchmarkBtn').disabled=false;
    }catch(error){if($('benchmarkStatus'))$('benchmarkStatus').textContent=error.message;errorMessage(error);}
    finally{benchmarkTask=null;state.busy=false;if(button.isConnected)button.disabled=false;if($('runBenchmarkBtn'))$('runBenchmarkBtn').disabled=false;updateEngineDisplay();}
  };
  $('cancelBenchmarkBtn').onclick=()=>engine.stop();$('saveBenchmarkBtn').onclick=()=>{if(benchmarkReport)download(JSON.stringify(benchmarkReport,null,2),'NoteBlockStudio-realtime-benchmark.json','application/json');};
}
$('modal').addEventListener('close',()=>{if(benchmarkTask)engine.stop();});

setPlayerMode(playerMode);
