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
import {tickAtFrame} from './dsp-protocol.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const STORAGE_KEY = 'noteblock-studio-web-project-v1';
const ROW = 32, TICKS_PER_BEAT = 4;
let song = createDemoSong(), restored = false;
try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) { song = normalizeSong(JSON.parse(saved)); restored = true; } } catch { /* A corrupt cache never prevents a fresh session. */ }
const editorPreferences=loadEditorPreferences();
const playerMode=new URLSearchParams(location.search).get('player')==='1';
const engine = new AudioEngine({masterVolume: .75});
try { const settings=JSON.parse(localStorage.getItem('nbs-rust-audio-settings')); if(settings)engine.configure(settings); } catch { /* Invalid settings use the measured default. */ }
const projectStore = new ProjectStore();
const history = new History(70);
const sampleUndo = [], sampleRedo = [];
const state = {tool:'draw', instrument:0, key:45, velocity:100, pan:0, pitch:0, layer:0, tick:0, cell:32, snap:1, selected:new Set(), clipboard:null, gesture:null, pianoStart:36, busy:false};
let cellIndex = new Map(), noteRows = new Map(), saveTimer, toastTimer, frame, dragDepth = 0;
const playbackVisuals = new PlaybackVisuals(song, {playerMode});
const heldPiano = new Map(), heldKeys = new Uint32Array(88);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let pianoKeys = [], playbackKeyAges = new Float64Array(88).fill(Infinity), hasSolo = false;
let visualSong = song, removalEffects = [];
let canvasWidth = 1, canvasHeight = 1, rulerWidth = 1, dirty = false;
let saveRevision = 0, liveReverbHistory = false, sampleLoadToken = 0;
let saveQueue=Promise.resolve();
const g = $('grid').getContext('2d'), ruler = $('ruler').getContext('2d'), overview = $('overviewCanvas').getContext('2d');
const overviewCache = document.createElement('canvas');
let overviewDirty = true;
const noteFiles = ['harp','double-bass','bass-drum','snare-drum','click','guitar','flute','bell','chime','xylophone','iron-xylophone','cow-bell','didgeridoo','bit','banjo','pling',...Array.from({length:18},(_,i)=>`custom-${i+1}`)];
const noteImages=noteFiles.map((name,i)=>{const image=new Image();image.onload=scheduleDraw;image.src=`assets/original/note-blocks/${String(i).padStart(2,'0')}-${name}.png`;return image;});
const transportIcon=name=>`<img src="assets/original/toolbar-light/${name==='pause'?'05-pause':'04-play'}.png" alt="">`;
const instruments = () => [...INSTRUMENTS, ...song.customInstruments.map((i,n) => ({id:16+n,name:i.name || `自定义 ${n+1}`,englishName:i.file || 'Custom',color:'#b6e878',symbol:'♫'}))];
const inst = id => instruments().find(i=>i.id===id) || {id,name:`音色 ${id}`,englishName:'Custom',color:'#b6e878',symbol:'♫'};
const selectedNotes = () => song.notes.filter(n=>state.selected.has(n.id));
const editableNotes = () => selectedNotes().filter(n=>!song.layers[n.layer]?.locked);
const beatsPerBar = () => song.timeSignature*TICKS_PER_BEAT;
const totalTicks = () => Math.max(128, Math.ceil(song.length/16)*16+32);

function toast(message, error=false) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.toggle('error',error); $('toast').hidden=false;
  $('statusText').textContent=message; toastTimer=setTimeout(()=>$('toast').hidden=true,error?7000:3500);
}
function errorMessage(error) { console.error(error); toast(error?.message || String(error),true); }
function persist() {
  clearTimeout(saveTimer); dirty=true; $('saveState').textContent='正在自动保存…';
  saveRevision++; saveTimer=setTimeout(flushSave,800);
}
function flushSave(){clearTimeout(saveTimer);saveQueue=saveQueue.then(async()=>{const revision=saveRevision,project=song;const snapshot=await features.sampleDataForSave();await projectStore.save(project,snapshot?.samples);features.samplesSaved(snapshot);if(revision===saveRevision){dirty=false;$('saveState').textContent='已保存在此浏览器';}}).catch(error=>{$('saveState').textContent='自动保存失败，请导出完整工程包';console.warn(error);});return saveQueue;}
function checkpoint(samples = engine.customSamples) {
  history.setLimit(clamp(Math.floor(1000000/Math.max(1,song.notes.length)),2,70));
  history.push(song); sampleUndo.push(new Map(samples));
  sampleUndo.splice(0,Math.max(0,sampleUndo.length-history.undoDepth)); sampleRedo.length=0;
}
function refresh({layers=true, inspector=true, save=false}={}) {
  const ids=new Set(song.notes.map(n=>n.id));
  if(visualSong!==song){removalEffects=[];visualSong=song;}
  else if(!reducedMotion.matches){
    const scroll=$('gridScroll'),now=performance.now();
    removalEffects=removalEffects.filter(effect=>now-effect.started<278);
    removals:for(const row of noteRows.values())for(const note of row)if(!ids.has(note.id)&&note.tick*state.cell>=scroll.scrollLeft-state.cell&&note.tick*state.cell<scroll.scrollLeft+canvasWidth&&note.layer*ROW>=scroll.scrollTop-ROW&&note.layer*ROW<scroll.scrollTop+canvasHeight){if(removalEffects.length>=512)break removals;removalEffects.push({tick:note.tick,layer:note.layer,started:now});}
  }
  cellIndex=new Map(song.notes.map(n=>[`${n.tick}:${n.layer}`,n]));
  noteRows=new Map();for(const note of song.notes){if(!noteRows.has(note.layer))noteRows.set(note.layer,[]);noteRows.get(note.layer).push(note);}overviewDirty=true;
  state.selected=new Set([...state.selected].filter(id=>ids.has(id)));
  song.length=Math.max(1,song.length,song.notes.length?bounds(song.notes).maxTick+1:1);
  hasSolo=song.layers.some(layer=>layer.solo);playbackVisuals.rebuild(song,{playerMode});
  state.layer=clamp(state.layer,0,song.layers.length-1);
  $('projectTitle').textContent=song.title||'未命名曲谱'; document.title=`${song.title||'未命名曲谱'} · Note Block Studio`;
  $('projectCaption').textContent=`${song.layers.length} 条音轨 · ${song.notes.length.toLocaleString()} 个音符`;
  $('layerCount').textContent=String(song.layers.length).padStart(2,'0');
  $('songStats').textContent=`${song.notes.length.toLocaleString()} notes · ${song.layers.length} layers · ${(song.length/song.tempo).toFixed(1)}s`;
  $('tempoInput').value=editorPreferences.bpm?song.tempo*15:song.tempo;$('tempoInput').setAttribute('aria-label',editorPreferences.bpm?'速度 BPM':'速度 ticks 每秒');$('tempoInput').min=editorPreferences.bpm?.75:.05;$('tempoInput').max=editorPreferences.bpm?9830.25:655.35;$('tempoInput').parentElement.querySelector('small').textContent=editorPreferences.bpm?'BPM':'t/s'; $('signatureInput').value=song.timeSignature;
  $('loopBtn').classList.toggle('active',song.loop); $('loopBtn').setAttribute('aria-pressed',String(song.loop));
  $('undoBtn').disabled=!history.canUndo; $('redoBtn').disabled=!history.canRedo;
  $('gridSpacer').style.width=`${Math.min(30000000,totalTicks()*state.cell)}px`;
  $('gridSpacer').style.height=`${song.layers.length*ROW}px`;
  if(layers) renderLayers(); if(inspector) renderInspector(); scheduleDraw(); if(save){persist();restartIfPlaying();}
}
function renderRack() {
  const list=instruments();
  $('instrumentRack').innerHTML=list.map(i=>`<button class="instrument-card ${state.instrument===i.id?'active':''}" data-instrument="${i.id}" style="--inst-color:${i.color}" title="${esc(i.name)} · ${esc(i.englishName)}${i.id>=16?'（双击重新加载音色）':''}" aria-label="${esc(i.name)}" aria-pressed="${state.instrument===i.id}"><span class="inst-symbol">${i.symbol}</span><span>${esc(i.name)}</span></button>`).join('');
  $('noteInstrument').innerHTML=list.map(i=>`<option value="${i.id}">${esc(i.name)} · ${esc(i.englishName)}</option>`).join('');
  $('noteInstrument').value=state.instrument;
  $('activeInstrumentLabel').textContent=`${inst(state.instrument).name} · ${inst(state.instrument).englishName}`;
}
function chooseInstrument(id, preview=true) {
  state.instrument=id;
  document.querySelectorAll('[data-instrument]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.instrument)===id);b.setAttribute('aria-pressed',String(Number(b.dataset.instrument)===id));});
  $('noteInstrument').value=id; $('activeInstrumentLabel').textContent=`${inst(id).name} · ${inst(id).englishName}`;
  if(preview) audition();
}
function renderLayers() {
  const scroll=$('gridScroll'), start=Math.max(0,Math.floor(scroll.scrollTop/ROW)-1), end=Math.min(song.layers.length,start+Math.ceil(scroll.clientHeight/ROW)+3);
  $('layerStack').style.transform=`translateY(${-scroll.scrollTop}px)`;
  $('layerStack').style.height=`${song.layers.length*ROW}px`;
  const counts=new Map(); for(let layer=start;layer<end;layer++)counts.set(layer,noteRows.get(layer)?.length||0);
  $('layerStack').innerHTML=song.layers.slice(start,end).map((l,j)=>{const n=start+j;return `<div class="layer-row ${n===state.layer?'selected':''}" data-layer="${n}" style="position:absolute;top:${n*ROW}px;left:0;right:0" title="双击编辑音轨"><span class="layer-index">${String(n+1).padStart(2,'0')}</span><div class="layer-body"><span class="layer-name">${l.locked?'♙ ':''}${esc(l.name||`音轨 ${n+1}`)}</span><span class="layer-meta">${counts.get(n)||0} notes · ${l.volume}%${l.pan?` · ${l.pan<0?'L':'R'}${Math.abs(l.pan)}`:''}</span></div><button class="layer-reverb" data-action="reverb" title="本轨混响（实时）" aria-label="音轨 ${n+1} 混响">${Math.round(l.reverb||0)}%</button><div class="layer-controls"><button class="mute ${l.muted?'active':''}" data-action="mute" aria-label="${esc(l.name)} 静音" aria-pressed="${!!l.muted}" title="静音">M</button><button class="solo ${l.solo?'active':''}" data-action="solo" aria-label="${esc(l.name)} 独奏" aria-pressed="${!!l.solo}" title="独奏">S</button></div></div>`;}).join('');
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
  const start=state.pianoStart, whites=[],whiteCount=clamp(Math.floor((document.documentElement.clientWidth-32)/39),3,Number(editorPreferences.keysmax)||30);let end=start;
  while(end<109&&whites.length<whiteCount){if(![1,3,6,8,10].includes(end%12))whites.push(end);end++;}
  const whiteWidth=100/whites.length;
  let html=whites.map(m=>`<button class="piano-white ${m-21===state.key?'active':''}" data-key="${m-21}" title="${noteName(m-21)}" aria-label="${noteName(m-21)}"><span class="piano-key-face" aria-hidden="true"></span><span class="piano-key-label">${editorPreferences.keyNames&&m%12===0?'C'+(Math.floor(m/12)-1):''}</span></button>`).join('');
  for(let m=start;m<end;m++)if([1,3,6,8,10].includes(m%12)){const before=whites.filter(w=>w<m).length;html+=`<button class="piano-black ${m-21===state.key?'active':''}" data-key="${m-21}" style="left:${before*whiteWidth-whiteWidth*.3}%;width:${whiteWidth*.6}%" title="${noteName(m-21)}" aria-label="${noteName(m-21)}"><span class="piano-key-face" aria-hidden="true"></span></button>`;}
  $('piano').innerHTML=`<div class="piano-inner">${html}</div>`;
  pianoKeys=Array.from($('piano').querySelectorAll('[data-key]'),element=>({element,key:Number(element.dataset.key),last:''}));
  updatePianoFeedback();
  $('octaveLabel').textContent=`${noteName(start-21)} — ${noteName(end-22)}`;
}
function retina(canvas,ctx,w,h) { const dpr=Math.min(devicePixelRatio||1,2); const pw=Math.round(w*dpr),ph=Math.round(h*dpr); if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;}ctx.setTransform(dpr,0,0,dpr,0,0); }
function resize() {
  canvasWidth=$('gridScroll').clientWidth; canvasHeight=$('gridScroll').clientHeight; rulerWidth=$('ruler').parentElement.clientWidth;
  retina($('grid'),g,canvasWidth,canvasHeight); retina($('ruler'),ruler,rulerWidth,32); retina($('overviewCanvas'),overview,$('overview').clientWidth,29);
  overviewDirty=true;
  renderLayers();renderPiano();scheduleDraw();
}
function holdPiano(source,key){
  releasePiano(source);if(!Number.isInteger(key)||key<0||key>87)return;
  heldPiano.set(source,key);heldKeys[key]++;updatePianoFeedback();scheduleDraw();
}
function releasePiano(source){const key=heldPiano.get(source);if(key===undefined)return;heldPiano.delete(source);heldKeys[key]--;updatePianoFeedback();scheduleDraw();}
function clearPianoInput(){for(const source of [...heldPiano.keys()])if(!source.startsWith('midi:'))releasePiano(source);}
function updatePianoFeedback(){
  const hex=/^#[0-9a-f]{6}$/i.test(editorPreferences.accent||'')?editorPreferences.accent:'#0078d4';
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
  if(position.playing){state.tick=tickAtFrame(position.frame,position.transport);const x=state.tick*state.cell,scroll=$('gridScroll');if(editorPreferences.follow&&(x>scroll.scrollLeft+canvasWidth-40||x<scroll.scrollLeft))scroll.scrollLeft=Math.max(0,x-40);}
  updatePianoFeedback();draw();if(position.playing||removalEffects.length)scheduleDraw();
});}
function draw() {
  const scroll=$('gridScroll'), sx=scroll.scrollLeft, sy=scroll.scrollTop, cw=state.cell, w=canvasWidth,h=canvasHeight,bar=beatsPerBar();
  g.clearRect(0,0,w,h); const dark=document.body.classList.contains('theme-dark');g.fillStyle=dark?'#202020':'#f9f9f9';g.fillRect(0,0,w,h);
  const firstRow=Math.floor(sy/ROW),lastRow=Math.min(song.layers.length,Math.ceil((sy+h)/ROW));
  for(let l=firstRow;l<lastRow;l++){const y=l*ROW-sy;g.fillStyle=dark?(l===state.layer?'#26394b':'#202020'):(l===state.layer?'#eef5fb':'#f9f9f9');g.fillRect(0,y,w,ROW);g.strokeStyle=dark?'#383838':'#e4e4e4';g.beginPath();g.moveTo(0,y+ROW-.5);g.lineTo(w,y+ROW-.5);g.stroke();}
  const firstTick=Math.floor(sx/cw),lastTick=Math.ceil((sx+w)/cw);
  for(let tick=firstTick;tick<=lastTick;tick++){const x=Math.round(tick*cw-sx)+.5;if(cw<7&&tick%4)continue;g.strokeStyle=dark?(tick%bar===0?'#777':tick%4===0?'#555':'#363636'):(tick%bar===0?'#b5b5b5':tick%4===0?'#c5c5c5':'#e2e2e2');g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke();}
  const solo=hasSolo;
  g.font='10px "Segoe UI",sans-serif';g.textBaseline='middle';
  for(let row=firstRow;row<lastRow;row++)for(const n of noteRows.get(row)||[]){
    if(n.tick<firstTick-1||n.tick>lastTick)continue;
    const x=n.tick*cw-sx,y=n.layer*ROW-sy,layer=song.layers[n.layer],selected=state.selected.has(n.id);
    const tile=noteImages[n.instrument<16?n.instrument:16+(n.instrument-16)%18];
    const hit=layer?.locked?0:Math.max(0,1-playbackVisuals.noteAge(n)/1000);
    g.globalAlpha=layer?.muted||(solo&&!layer?.solo) ? .2 : Math.min(1,(editorPreferences.fade ? .25+n.velocity*.005 : 1)+hit*.5);
    if(editorPreferences.colors&&!editorPreferences.shapes&&tile?.complete&&tile.naturalWidth){g.imageSmoothingEnabled=false;g.drawImage(tile,x,y,cw,ROW);}
    else{g.fillStyle=editorPreferences.colors?(INSTRUMENTS[n.instrument]?.color||'#afcde1'):(dark?'#9cb0c1':'#c6d4e1');if(editorPreferences.shapes){g.beginPath();const radius=Math.max(2,Math.min(cw,ROW)/2-3);g.arc(x+cw/2,y+ROW/2,radius,0,Math.PI*2);g.fill();}else g.fillRect(x+1,y+1,cw-2,ROW-2);}
    g.globalAlpha=1;
    if(cw>=22){g.textAlign='center';g.font='8px "Segoe UI",sans-serif';g.fillStyle='#ffff69';g.fillText((editorPreferences.flat?noteName(n.key).replace('C♯','D♭').replace('D♯','E♭').replace('F♯','G♭').replace('G♯','A♭').replace('A♯','B♭'):noteName(n.key)).replace(editorPreferences.octaves?/$^/:/-?\d+$/,''),x+cw/2,y+8,cw-3);g.font='11px "Segoe UI",sans-serif';g.fillStyle='#151515';if(editorPreferences.numbers)g.fillText(n.key<33?'◀':n.key>57?'▶':String(n.key-33),x+cw/2,y+22,cw-3);}
    if(selected){g.strokeStyle='#0078d4';g.lineWidth=2;g.strokeRect(x+1,y+1,cw-2,ROW-2);g.lineWidth=1;}
  }
  const now=performance.now();removalEffects=removalEffects.filter(effect=>now-effect.started<278);
  if(!reducedMotion.matches)for(const effect of removalEffects){const age=(now-effect.started)/278,expand=10*age,x=effect.tick*cw-sx,y=effect.layer*ROW-sy;g.globalAlpha=.5*(1-age);g.strokeStyle=editorPreferences.accent||'#0078d4';g.strokeRect(x-expand,y-expand,cw+expand*1.9,ROW+expand*2);}
  g.globalAlpha=1;
  const gesture=state.gesture;
  if(gesture?.type==='select'){const x=Math.min(gesture.startX,gesture.x)-sx,y=Math.min(gesture.startY,gesture.y)-sy;g.fillStyle='#0078d418';g.strokeStyle='#0078d4';g.fillRect(x,y,Math.abs(gesture.x-gesture.startX),Math.abs(gesture.y-gesture.startY));g.strokeRect(x+.5,y+.5,Math.abs(gesture.x-gesture.startX),Math.abs(gesture.y-gesture.startY));}
  const playX=state.tick*cw-sx;if(playX>=0&&playX<w){g.fillStyle='#0078d4';g.fillRect(Math.round(playX),0,1,h);}
  if(song.loopStart){const x=song.loopStart*cw-sx;g.strokeStyle='#0078d488';g.setLineDash([3,4]);g.beginPath();g.moveTo(x,0);g.lineTo(x,h);g.stroke();g.setLineDash([]);}
  const endX=song.length*cw-sx;if(endX<w){g.fillStyle='#00000009';g.fillRect(Math.max(0,endX),0,w-Math.max(0,endX),h);g.fillStyle='#a6a6a6';g.fillRect(endX,0,1,h);}
  ruler.clearRect(0,0,rulerWidth,32);ruler.fillStyle=dark?'#2a2a2a':'#f3f3f3';ruler.fillRect(0,0,rulerWidth,32);ruler.font='9px "Segoe UI",sans-serif';ruler.textBaseline='middle';
  const labelStep=cw*4<38?4*Math.ceil(38/(cw*4)):4;
  for(let tick=Math.max(0,Math.floor(sx/(cw*labelStep))*labelStep);tick<=lastTick;tick+=labelStep){const x=tick*cw-sx;ruler.strokeStyle=tick%bar===0?'#888':'#bbb';ruler.beginPath();ruler.moveTo(x+.5,17);ruler.lineTo(x+.5,32);ruler.stroke();ruler.fillStyle=dark?'#ddd':'#333';ruler.fillText(String(tick),x+4,26);ruler.fillStyle='#777';ruler.fillText(`${(tick/song.tempo).toFixed(1)}s`,x+4,9);}

  if(playX>=0&&playX<rulerWidth){ruler.fillStyle='#0078d4';ruler.beginPath();ruler.moveTo(playX-5,0);ruler.lineTo(playX+5,0);ruler.lineTo(playX+5,5);ruler.lineTo(playX,10);ruler.lineTo(playX-5,5);ruler.fill();}
  drawOverview(); updatePosition();
}
function drawOverview() {
  const width=$('overview').clientWidth,height=29,duration=totalTicks();if(!width)return;
  if(overviewDirty){const cache=overviewCache.getContext('2d');retina(overviewCache,cache,width,height);cache.clearRect(0,0,width,height);cache.fillStyle='#161c20';cache.fillRect(0,0,width,height);cache.globalAlpha=.6;for(const n of song.notes){cache.fillStyle=INSTRUMENTS[n.instrument]?.color||'#b6e878';cache.fillRect(n.tick/duration*width,n.layer/Math.max(6,song.layers.length)*(height-5)+2,Math.max(1,width/duration),Math.max(1,(height-5)/Math.max(6,song.layers.length)-1));}cache.globalAlpha=1;overviewDirty=false;}
  overview.clearRect(0,0,width,height);overview.drawImage(overviewCache,0,0,width,height);const x=$('gridScroll').scrollLeft/(duration*state.cell)*width,vw=Math.min(width,canvasWidth/(duration*state.cell)*width);overview.fillStyle='#c8e5b013';overview.fillRect(x,0,vw,height);overview.strokeStyle='#a6bf8455';overview.strokeRect(x+.5,.5,vw-1,height-1);overview.fillStyle='#b6e878';overview.fillRect(state.tick/duration*width,0,1,height);
}
function updatePosition() {
  const tick=Math.floor(state.tick),bar=beatsPerBar(),beat=Math.floor((tick%bar)/TICKS_PER_BEAT)+1;
  $('positionDisplay').innerHTML=`${String(Math.floor(tick/bar)+1).padStart(3,'0')} <em>: ${String(beat).padStart(2,'0')}</em>`;
  const sec=state.tick/song.tempo;$('timeDisplay').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${(sec%60).toFixed(2).padStart(5,'0')}`;
}
async function audition(note) {
  engine.customInstruments=song.customInstruments;
  try {await engine.preview(note||{key:state.key,instrument:state.instrument,velocity:state.velocity,pan:state.pan,pitch:state.pitch},note?song.layers[note.layer]:{volume:100,pan:0});if(engine.warnings.length)toast(engine.warnings.at(-1));}catch(error){errorMessage(error);}
}
function applyProperty(property,value,{preview=false}={}) {
  const notes=editableNotes(); if(notes.length){checkpoint();notes.forEach(n=>n[property]=value);refresh({layers:false,save:true});}
  else {state[property]=value;renderInspector();}
  if(property==='key')updatePianoFeedback();if(preview)audition();
}
function setTool(tool){state.tool=tool;document.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('gridScroll').style.cursor=tool==='select'?'default':tool==='erase'?'cell':'crosshair';}
function setTick(tick,follow=false) {state.tick=clamp(tick,0,song.length);if(follow){const x=state.tick*state.cell;if(x<$('gridScroll').scrollLeft||x>$('gridScroll').scrollLeft+canvasWidth-25)$('gridScroll').scrollLeft=Math.max(0,x-40);}scheduleDraw();}
function setZoom(value) {const center=($('gridScroll').scrollLeft+canvasWidth/2)/state.cell;state.cell=clamp(value,1,80);$('zoomLabel').textContent=`${Math.round(state.cell/32*100)}%`;refresh({layers:false,inspector:false});$('gridScroll').scrollLeft=Math.max(0,center*state.cell-canvasWidth/2);}
function clearPlaybackFeedback(){playbackVisuals.clear();playbackKeyAges.fill(Infinity);updatePianoFeedback();scheduleDraw();}
function stopPlayback(reset=true) {engine.stop();clearPlaybackFeedback();$('playBtn').innerHTML=transportIcon('play');$('playBtn').setAttribute('aria-label','播放');if(reset)setTick(0);}
async function togglePlayback() {
  if(state.busy)return;
  if(engine.playing){state.tick=engine.pause();clearPlaybackFeedback();$('playBtn').innerHTML=transportIcon('play');$('playBtn').setAttribute('aria-label','播放');return;}
  try {state.busy=true;$('statusText').textContent='正在准备音色…';await engine.play(song,{fromTick:state.tick>=song.length?0:state.tick,loop:song.loop,masterVolume:Number($('masterVolume').value)/100,onError:error=>{stopPlayback(false);errorMessage(error);},onEnded:()=>{clearPlaybackFeedback();$('playBtn').innerHTML=transportIcon('play');$('playBtn').setAttribute('aria-label','播放');setTick(0);$('statusText').textContent='播放结束';}});if(!engine.playing)return;$('playBtn').innerHTML=transportIcon('pause');$('playBtn').setAttribute('aria-label','暂停');$('statusText').textContent='正在播放';
    scheduleDraw();if(engine.warnings.length)toast(engine.warnings.at(-1));
  }catch(error){errorMessage(error);}finally{state.busy=false;}
}
function restartIfPlaying(){if(!engine.playing)return;try{if(engine.updateSong(song)===false){state.tick=engine.pause();clearPlaybackFeedback();togglePlayback();}}catch(error){errorMessage(error);}}
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
  if(event.button!==0&&event.button!==2)return;
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
  const gesture=state.gesture;if(!gesture)return;const p=point(event);
  if(gesture.type==='paint'){const added=addNote(p);if(added){gesture.changed=true;state.selected=new Set([added.id]);refresh();}}
  if(gesture.type==='erase'){if(eraseNote(p)){gesture.changed=true;refresh();}}
  if(gesture.type==='select'){gesture.x=p.x;gesture.y=p.y;const minX=Math.min(gesture.startX,p.x),maxX=Math.max(gesture.startX,p.x),minY=Math.min(gesture.startY,p.y),maxY=Math.max(gesture.startY,p.y);state.selected=new Set([...gesture.previous,...song.notes.filter(n=>n.tick*state.cell+state.cell>minX&&n.tick*state.cell<maxX&&n.layer*ROW+ROW>minY&&n.layer*ROW<maxY).map(n=>n.id)]);renderInspector();scheduleDraw();}
  if(gesture.type==='move'&&gesture.originals.length){let dt=Math.round((p.tick-gesture.startTick)/state.snap)*state.snap,dl=p.layer-gesture.startLayer;const original=gesture.originals,area=bounds(original);dt=clamp(dt,-area.minTick,999999-area.maxTick);dl=clamp(dl,-area.minLayer,song.layers.length-1-area.maxLayer);if(original.some(n=>song.layers[n.layer+dl].locked))return;if(!gesture.changed&&(dt||dl)){checkpoint();gesture.changed=true;}if(gesture.changed){const origins=new Map(original.map(n=>[n.id,n]));song.notes.forEach(n=>{const o=origins.get(n.id);if(o){n.tick=o.tick+dt;n.layer=o.layer+dl;}});refresh({layers:false,inspector:false});}}
});
$('gridScroll').addEventListener('pointerup',endGesture);$('gridScroll').addEventListener('pointercancel',endGesture);
$('gridScroll').addEventListener('contextmenu',e=>e.preventDefault());
$('gridScroll').addEventListener('scroll',()=>{renderLayers();scheduleDraw();},{passive:true});
$('gridScroll').addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();setZoom(state.cell*(e.deltaY>0?.9:1.1));}},{passive:false});
$('layerPane').addEventListener('wheel',e=>{$('gridScroll').scrollTop+=e.deltaY;e.preventDefault();},{passive:false});
$('ruler').addEventListener('pointerdown',event=>{const rect=$('ruler').getBoundingClientRect(),tick=Math.floor((event.clientX-rect.left+$('gridScroll').scrollLeft)/state.cell);if(engine.playing)stopPlayback(false);setTick(tick);});
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
function replaceSong(next,{clearHistory=true,normalized=false}={}){stopPlayback();if(clearHistory){history.clear();sampleUndo.length=0;sampleRedo.length=0;}song=normalized?next:normalizeSong(next);state.selected.clear();state.layer=0;state.tick=0;state.instrument=0;engine.customSamples.clear();engine.customInstruments=song.customInstruments;engine.warnings=[];$('gridScroll').scrollLeft=0;$('gridScroll').scrollTop=0;renderRack();renderPiano();refresh({save:true});resize();if(song.notes.some(n=>n.instrument>=16))toast('此曲使用自定义音色；请添加对应音频文件，未加载时以竖琴试听。');}
function modal(title,content,footer=''){$('modalContent').innerHTML=`<div class="modal-heading"><h2>${title}</h2><button data-close aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${content}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}`;$('modalContent').querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('modal').close());$('modal').showModal();}
function confirmReplace(action){if(!song.notes.length){action();return;}modal('替换当前曲谱？','<p>当前曲谱的浏览器自动保存也会被替换。需要保留曲谱和自定义采样时，请先保存完整工程包。</p>',`<button class="secondary-button" id="saveBeforeReplace">先保存完整工程包</button><button class="primary-button" id="confirmReplace">继续</button>`);$('saveBeforeReplace').onclick=()=>features.actions.saveProject();$('confirmReplace').onclick=()=>{$('modal').close();action();};}
async function loadFile(file){try{if(/\.midi?$/i.test(file.name)){features.importMidi(file);return;}if(/\.(nbpz|zip)$/i.test(file.name)){await features.importBundle(file);return;}if(/\.nbp$/i.test(file.name)){await features.importPattern(file);return;}if(file.size>128*1024*1024)throw new Error('文件过大，支持最大 128 MB。');$('statusText').textContent='正在预读本地文件…';const next=await projectStore.parse(file,message=>$('statusText').textContent=message);confirmReplace(()=>{replaceSong(next,{normalized:true});toast(`已打开 ${file.name} · ${song.notes.length.toLocaleString()} 个音符`);});}catch(error){errorMessage(error);}}

function download(data,name,type='application/octet-stream'){const blob=data instanceof Blob?data:new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
const filename=()=> (song.title||'未命名曲谱').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
function downloadNBS(){try{download(writeNBS(song),`${filename()}.nbs`);toast('已导出 NBS 曲谱');}catch(error){errorMessage(error);}}
function showExport(){modal('导出曲谱',`<p>文件将保存到浏览器的下载目录。</p><button class="export-choice" id="exportNbs">${icon('music')}<span><strong>NBS 曲谱</strong><small>版本 5 · 附带本地混响扩展；原版忽略混响</small></span></button><button class="export-choice" id="exportMidi">${icon('keyboard')}<span><strong>MIDI 文件</strong><small>在其他音乐软件中使用 · 使用 GM 乐器映射</small></span></button><button class="export-choice" id="exportWav">${icon('volume')}<span><strong>WAV 音频</strong><small>48 kHz · 立体声 · 16-bit PCM · 独立混响</small></span></button><button class="export-choice" id="exportJson">${icon('save')}<span><strong>完整项目 JSON</strong><small>保留每轨混响、编辑属性 · 不包含自定义音频</small></span></button><button class="export-choice" id="exportAudioFormats"><span><strong>MP3 / FLAC / AIFF / OGG 与音频设置</strong><small>浏览器 Rust 渲染 · WASM 编码</small></span></button><button class="export-choice" id="exportMinecraft"><span><strong>Minecraft 结构与数据包</strong><small>Schematic / NBT / Branch / Track / Datapack</small></span></button><button class="export-choice" id="exportBundle"><span><strong>完整工程包</strong><small>包含自定义音频与全部工程状态</small></span></button><div id="exportProgress" class="audio-progress" role="status"></div>`);
  $('exportAudioFormats').onclick=features.actions.audioExport;$('exportMinecraft').onclick=features.actions.minecraft;$('exportBundle').onclick=features.actions.saveProject;
  $('exportNbs').onclick=()=>downloadNBS();$('exportMidi').onclick=()=>{try{download(writeMIDI(song),`${filename()}.mid`,'audio/midi');toast('已导出 MIDI；音色使用 GM 映射');}catch(error){errorMessage(error);}};
  $('exportJson').onclick=()=>{download(JSON.stringify(song,null,2),`${filename()}.json`,'application/json');toast('已导出完整项目 JSON');};
  $('exportWav').onclick=async()=>{const button=$('exportWav');button.disabled=true;$('exportProgress').textContent='正在渲染本地音频，请稍候…';try{const blob=await engine.exportWav(song,{masterVolume:Number($('masterVolume').value)/100});download(blob,`${filename()}.wav`);if($('exportProgress'))$('exportProgress').textContent=`已导出 ${(blob.size/1024/1024).toFixed(1)} MB WAV 音频`;toast('WAV 导出完成');}catch(error){if($('exportProgress'))$('exportProgress').textContent='导出失败';errorMessage(error);}finally{if(button.isConnected)button.disabled=false;}};
}
function showSongInfo(){modal('曲谱设置',`<label>曲名<input id="infoTitle" maxlength="200" value="${esc(song.title)}"></label><label>作者<input id="infoAuthor" maxlength="200" value="${esc(song.author)}"></label><label>原作者<input id="infoOriginal" maxlength="200" value="${esc(song.originalAuthor)}"></label><label>描述<textarea id="infoDescription" maxlength="10000">${esc(song.description)}</textarea></label><label class="inline-label">曲谱长度（ticks）<input id="infoLength" type="number" min="1" max="65535" value="${song.length}"></label><label class="inline-label">循环起点（tick）<input id="infoLoop" type="number" min="0" max="65534" value="${song.loopStart||0}"></label><label class="inline-label">循环次数（0 = 无限）<input id="infoLoopCount" type="number" min="0" max="255" value="${song.loopCount||0}"></label>`,`<button class="secondary-button" data-close>取消</button><button class="primary-button" id="applySongInfo">保存设置</button>`);$('applySongInfo').onclick=()=>{checkpoint();song.title=$('infoTitle').value.trim()||'未命名曲谱';song.author=$('infoAuthor').value;song.originalAuthor=$('infoOriginal').value;song.description=$('infoDescription').value;const last=song.notes.reduce((v,n)=>Math.max(v,n.tick+1),1);song.length=Math.max(last,clamp(Number($('infoLength').value)||64,1,1000000));song.loopStart=clamp(Number($('infoLoop').value)||0,0,song.length-1);song.loopCount=clamp(Number($('infoLoopCount').value)||0,0,255);$('modal').close();refresh({save:true});};}
function showLayer(index){
  const layer=song.layers[index];let reverbCheckpoint=false;
  modal('音轨设置',`<label>名称<input id="layerName" maxlength="200" value="${esc(layer.name)}"></label><label class="inline-label">音量（%）<input id="layerVolume" type="number" min="0" max="100" value="${layer.volume}"></label><label class="inline-label">声像（-100 左 / +100 右）<input id="layerPan" type="number" min="-100" max="100" value="${layer.pan}"></label><label>混响 <output id="layerReverbValue">${Math.round(layer.reverb||0)}%</output><input id="layerReverb" type="range" min="0" max="100" value="${layer.reverb||0}" aria-label="本轨混响百分比"></label><p class="layer-context-note">混响调节即时生效。每条轨道使用独立的混响状态。</p><label class="inline-label">锁定音轨<input id="layerLock" type="checkbox" ${layer.locked?'checked':''}></label>`,`<button id="removeLayer" class="secondary-button" ${song.layers.length===1?'disabled':''}>删除此音轨</button><button class="primary-button" id="applyLayer">保存设置</button>`);
  $('layerReverb').oninput=()=>{if(!reverbCheckpoint){checkpoint();reverbCheckpoint=true;}$('undoBtn').disabled=false;layer.reverb=Number($('layerReverb').value);$('layerReverbValue').textContent=`${layer.reverb}%`;if(engine.playing)engine.updateTrackParams(song);renderLayers();persist();};
  $('applyLayer').onclick=()=>{checkpoint();layer.name=$('layerName').value.trim()||`音轨 ${index+1}`;layer.volume=clamp(Number($('layerVolume').value),0,100);layer.pan=clamp(Number($('layerPan').value),-100,100);layer.locked=$('layerLock').checked;$('modal').close();refresh({save:true});};
  $('removeLayer').onclick=()=>{checkpoint();song.layers.splice(index,1);song.layers.forEach((l,i)=>l.id=i);song.notes=song.notes.filter(n=>n.layer!==index);song.notes.forEach(n=>{if(n.layer>index)n.layer--;});$('modal').close();refresh({save:true});};
}
function showHelp(){modal('在浏览器里，写下你的旋律',`<p>原项目的本地 Web 移植。所有音符、文件解析和音频渲染均在本机完成。</p><div class="help-grid">${[['画笔 / 选择 / 橡皮','B / V / E'],['播放 / 暂停','Space'],['停止 / 取消选择','Esc'],['回到开头','Home'],['撤销 / 重做','Ctrl Z / Shift Z'],['复制 / 剪切 / 粘贴','Ctrl C / X / V'],['重复 / 全选','Ctrl D / A'],['删除音符','Delete'],['移动音符','↑ ↓ ← →'],['音高升降','Shift ↑ / ↓'],['升降八度','Alt ↑ / ↓'],['循环播放','L'],['打开 / 保存 NBS','Ctrl O / S'],['缩放网格','Ctrl + 滚轮']].map(([a,b])=>`<div><span>${a}</span><kbd>${b}</kbd></div>`).join('')}</div><p>点击网格添加音符，右键删除。按 V 后拖动框选，拖动所选音符移动。点击标尺定位，粘贴从播放光标和当前音轨开始。</p><p>双击音轨可调整音量、声像、锁定和名称。M 为静音，S 为独奏。琴键可选择音高并试听。</p><p>自定义采样与曲谱会自动保存在当前浏览器。使用“完整工程包”可将曲谱和采样一起保存到文件；NBS / JSON 仅包含采样引用。文件菜单提供备份、音频及 Minecraft 导出；编辑菜单提供宏、图案、和弦和分段代码。</p><p>移植范围与限制见项目内 README.md 和 docs/MIGRATION.md。</p>`);}
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

$('instrumentRack').onclick=event=>{const button=event.target.closest('[data-instrument]');if(button){state.selected.clear();chooseInstrument(Number(button.dataset.instrument));renderInspector();scheduleDraw();}};
$('instrumentRack').ondblclick=event=>{const button=event.target.closest('[data-instrument]');if(button&&Number(button.dataset.instrument)>=16)addCustomSample(Number(button.dataset.instrument)-16);};
$('customInstrumentBtn').onclick=()=>addCustomSample();
$('layerStack').onclick=event=>{const row=event.target.closest('[data-layer]');if(!row)return;state.layer=Number(row.dataset.layer);const action=event.target.closest('[data-action]')?.dataset.action;if(action==='reverb'){showLayer(state.layer);return;}if(action){checkpoint();song.layers[state.layer][action==='mute'?'muted':'solo']=!song.layers[state.layer][action==='mute'?'muted':'solo'];refresh({inspector:false,save:true});}else{document.querySelectorAll('.layer-row').forEach(item=>item.classList.toggle('selected',Number(item.dataset.layer)===state.layer));scheduleDraw();}};
$('layerStack').ondblclick=event=>{const row=event.target.closest('[data-layer]');if(row&&!event.target.closest('[data-action]'))showLayer(Number(row.dataset.layer));};
$('addLayerBtn').onclick=()=>{if(song.layers.length>=MAX_LAYERS){toast(`最多支持 ${MAX_LAYERS} 条音轨`,true);return;}checkpoint();song.layers.push({id:song.layers.length,name:`音轨 ${song.layers.length+1}`,volume:100,pan:0,reverb:0,muted:false,solo:false,locked:false});state.layer=song.layers.length-1;refresh({save:true});$('gridScroll').scrollTop=state.layer*ROW;};
function playPointerKey(event){
  const element=document.elementFromPoint(event.clientX,event.clientY)?.closest('#piano [data-key]'),source=`pointer:${event.pointerId}`;
  if(!element){releasePiano(source);return;}const key=Number(element.dataset.key);
  if(heldPiano.get(source)===key)return;holdPiano(source,key);applyProperty('key',key,{preview:true});
}
$('piano').addEventListener('pointerdown',event=>{if(event.button!==0||!event.target.closest('[data-key]'))return;event.preventDefault();$('piano').setPointerCapture(event.pointerId);playPointerKey(event);});
$('piano').addEventListener('pointermove',event=>{if($('piano').hasPointerCapture(event.pointerId))playPointerKey(event);});
for(const name of ['pointerup','pointercancel','lostpointercapture'])$('piano').addEventListener(name,event=>releasePiano(`pointer:${event.pointerId}`));
$('piano').addEventListener('keydown',event=>{if((event.code==='Space'||event.code==='Enter')&&event.target.closest('[data-key]')){event.preventDefault();event.stopPropagation();if(!event.repeat){const key=Number(event.target.closest('[data-key]').dataset.key);holdPiano(`button:${event.code}`,key);applyProperty('key',key,{preview:true});}}});
$('octaveDownBtn').onclick=()=>{state.pianoStart=Math.max(24,state.pianoStart-12);renderPiano();};$('octaveUpBtn').onclick=()=>{state.pianoStart=Math.min(72,state.pianoStart+12);renderPiano();};
$('noteInstrument').onchange=()=>{const id=Number($('noteInstrument').value);applyProperty('instrument',id);chooseInstrument(id);};
$('keyInput').onchange=()=>applyProperty('key',clamp(Math.round(Number($('keyInput').value)||0),0,87),{preview:true});
$('pitchDownBtn').onclick=()=>applyProperty('key',Math.max(0,state.key-1),{preview:true});$('pitchUpBtn').onclick=()=>applyProperty('key',Math.min(87,state.key+1),{preview:true});
$('velocityInput').oninput=()=>{$('velocityValue').textContent=`${$('velocityInput').value}%`;};$('velocityInput').onchange=()=>applyProperty('velocity',Number($('velocityInput').value));
$('panInput').oninput=()=>{const value=Number($('panInput').value);$('panValue').textContent=value?`${value<0?'左':'右'} ${Math.abs(value)}%`:'居中';};$('panInput').onchange=()=>applyProperty('pan',Number($('panInput').value));
$('finePitchInput').onchange=()=>applyProperty('pitch',clamp(Number($('finePitchInput').value)||0,-1200,1200),{preview:true});
$('previewNoteBtn').onclick=()=>audition();$('duplicateBtn').onclick=()=>pasteSelection({duplicate:true});$('deleteBtn').onclick=deleteSelection;
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
$('undoBtn').onclick=()=>undo();$('redoBtn').onclick=()=>undo(true);$('zoomOutBtn').onclick=()=>setZoom(state.cell/1.3);$('zoomInBtn').onclick=()=>setZoom(state.cell*1.3);$('fitBtn').onclick=()=>{setZoom(canvasWidth/Math.max(16,song.length+4));$('gridScroll').scrollLeft=0;};
$('snapSelect').onchange=()=>state.snap=Number($('snapSelect').value);
$('playBtn').onclick=togglePlayback;$('stopBtn').onclick=()=>stopPlayback();$('startBtn').onclick=()=>{stopPlayback();};
$('loopBtn').onclick=()=>{checkpoint();song.loop=!song.loop;refresh({layers:false,inspector:false,save:true});};
$('tempoInput').onchange=()=>{checkpoint();song.tempo=clamp((Number($('tempoInput').value)||10)/(editorPreferences.bpm?15:1),.05,655.35);refresh({layers:false,inspector:false,save:true});};
$('signatureInput').onchange=()=>{checkpoint();song.timeSignature=clamp(Math.round(Number($('signatureInput').value)||4),1,16);refresh({layers:false,inspector:false,save:true});};
$('masterVolume').oninput=()=>{const value=Number($('masterVolume').value);$('volumeLabel').textContent=`${value}%`;engine.setVolume(value/100);};
$('newBtn').onclick=()=>confirmReplace(()=>replaceSong(createBlankSong()));$('openBtn').onclick=()=>$('fileInput').click();$('fileInput').onchange=()=>{const file=$('fileInput').files[0];$('fileInput').value='';if(file)loadFile(file);};
$('saveBtn').onclick=downloadNBS;$('exportBtn').onclick=showExport;$('songInfoBtn').onclick=showSongInfo;$('helpBtn').onclick=showHelp;
$('demoSelect').onchange=()=>{const value=$('demoSelect').value;$('demoSelect').value='';if(!value)return;confirmReplace(async()=>{try{if(value==='welcome')replaceSong(createDemoSong());else{const response=await fetch(`assets/songs/${encodeURIComponent(value)}`);if(!response.ok)throw new Error('无法打开本地示例曲');replaceSong(await projectStore.parse(new File([await response.blob()],value)),{normalized:true});}toast('已载入示例曲');}catch(error){errorMessage(error);}});};
$('modal').addEventListener('click',event=>{if(event.target===$('modal')){const rect=$('modal').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('modal').close();}});
document.addEventListener('keydown',event=>{
  if(event.target.closest('input,textarea,select')||$('modal').open)return;
  const key=event.key.toLowerCase(),ctrl=event.ctrlKey||event.metaKey;
  if(playerMode&&ctrl&&!['o','s','c'].includes(key)){if(['z','y','a','x','v','d'].includes(key))event.preventDefault();return;}
  if(ctrl){if(['s','o','z','y','a','c','x','v','d'].includes(key))event.preventDefault();if(key==='s')downloadNBS();else if(key==='o')$('fileInput').click();else if(key==='z')undo(event.shiftKey);else if(key==='y')undo(true);else if(key==='a'){state.selected=new Set(song.notes.map(n=>n.id));renderInspector();scheduleDraw();}else if(key==='c')copySelection();else if(key==='x')copySelection(true);else if(key==='v')pasteSelection();else if(key==='d')pasteSelection({duplicate:true});return;}
  const pianoMap={z:48,s:49,x:50,d:51,c:52,v:53,g:54,b:55,h:56,n:57,j:58,m:59,q:60,'2':61,w:62,'3':63,e:64,r:65,'5':66,t:67,'6':68,y:69,'7':70,u:71};
  if(editorPreferences.keyboardInput&&pianoMap[key]!==undefined&&!event.altKey){event.preventDefault();if(!event.repeat){holdPiano(`keyboard:${event.code}`,pianoMap[key]-21);engine.triggerLive({key:pianoMap[key]-21,instrument:state.instrument,velocity:state.velocity,pan:state.pan,pitch:state.pitch},{channel:0,layer:song.layers[state.layer]}).catch(errorMessage);}return;}
  if(playerMode&&!['space','escape','home','l'].includes(event.code==='Space'?'space':key))return;
  if(event.code==='Space'){event.preventDefault();togglePlayback();}else if(key==='escape'){stopPlayback(false);state.selected.clear();renderInspector();scheduleDraw();}else if(key==='home'){event.preventDefault();stopPlayback();$('gridScroll').scrollLeft=0;}else if(key==='b')setTool('draw');else if(key==='v')setTool('select');else if(key==='e')setTool('erase');else if(key==='l')$('loopBtn').click();else if(key==='m'||key==='s'){checkpoint();const property=key==='m'?'muted':'solo';song.layers[state.layer][property]=!song.layers[state.layer][property];refresh({inspector:false,save:true});}else if(key==='?'||key==='f1'){event.preventDefault();showHelp();}else if(key==='delete'||key==='backspace'){event.preventDefault();deleteSelection();}else if(key.startsWith('arrow')){event.preventDefault();if(event.shiftKey||event.altKey){if(key==='arrowup'||key==='arrowdown')moveSelection(0,0,(key==='arrowup'?1:-1)*(event.altKey?12:1));}else moveSelection(key==='arrowleft'?-state.snap:key==='arrowright'?state.snap:0,key==='arrowup'?-1:key==='arrowdown'?1:0);}
});
document.addEventListener('keyup',event=>{releasePiano(`keyboard:${event.code}`);releasePiano(`button:${event.code}`);});
window.addEventListener('blur',clearPianoInput);
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
const features=installFeatureUI({getSong:()=>song,getState:()=>state,getEngine:()=>engine,getSelected:()=>state.selected,setSelected:ids=>state.selected=new Set(ids),checkpoint,refresh,persist,stopPlayback,replaceSong,confirmReplace,loadFile,download,modal,toast,error:errorMessage,store:projectStore,preferences:editorPreferences,resize,renderRack,scheduleDraw,holdPiano,releasePiano,isBusy:()=>state.busy||playerMode});
$('recordMidiBtn').onclick=features.toggleMidiRecord;
createNativeMenus({...features.actions,new:()=>$('newBtn').click(),open:()=>$('openBtn').click(),save:downloadNBS,export:showExport,info:showSongInfo,undo:()=>undo(),redo:()=>undo(true),copy:()=>copySelection(),cut:()=>copySelection(true),paste:()=>pasteSelection(),delete:deleteSelection,selectAll:()=>{state.selected=new Set(song.notes.map(n=>n.id));renderInspector();scheduleDraw();},deselect:()=>{state.selected.clear();renderInspector();scheduleDraw();},properties:toggleProperties,engineSettings:showEngineSettings,performance:showPerformance,help:showHelp});
async function boot(){try{const cached=await projectStore.load();if(cached){song=cached;restored=true;}await features.restoreSamples();}catch(error){console.warn('IndexedDB restoration unavailable',error);}hydrateIcons();$('app').hidden=false;$('boot').hidden=true;renderRack();renderPiano();refresh();resize();setTool('draw');$('statusText').textContent=restored?'已恢复上次在此浏览器中的曲谱':'准备就绪';await features.startup();}
boot().catch(errorMessage);
setInterval(updateEngineDisplay,250);

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
    if(benchmarkTask)return;const button=$('runBenchmarkBtn');button.disabled=true;state.busy=true;stopPlayback(false);
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

if(playerMode){
  document.body.classList.add('player-mode');
  for(const id of ['songInfoBtn','tempoInput','signatureInput'])$(id).disabled=true;
  $('statusText').textContent='播放器模式 · 可播放、打开和导出曲谱';
}
