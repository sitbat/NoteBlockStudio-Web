import {MidiInputController} from './midi-input.js';
import {EDITOR_TOOLS,applyEditorTool,selectNotes,CHORDS,insertChord} from './editor-tools.js';
import {parseNBP,writeNBP,patternFromSelection,insertPattern,decodeSelectionCode,writeSelectionCode} from './patterns.js';
import {writeProjectBundle,readProjectBundle,snapshotSampleBank,restoreSampleBank} from './project-bundle.js';
import {MAX_LAYERS,MAX_NOTES,uniqueId} from './model.js';
import {INSTRUMENTS,encodeWav,bundledCustomFile} from './audio.js';
import {MIDI_PROGRAM_DEFAULTS,MIDI_PERCUSSION_DEFAULTS} from './formats.js';
import {applyLayerOperation} from './layer-tools.js';
import {fetchSongInBrowser} from './browser-files.js';
import {encodeAudio,loadBrowserCodecs,getBrowserCodecState,codecArguments} from './browser-codecs.js';
import {resampleMono} from './audio-resample.js';
import {normalizePreferences} from './editor-preferences.js';
import {createInstrumentManager} from './instrument-ui.js';

const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function loadEditorPreferences(){
  try{return normalizePreferences(JSON.parse(localStorage.getItem('nbs-web-preferences-v3')||'{}'));}catch{return normalizePreferences();}
}
export const MIDI_IMPORT_STORAGE_KEY='nbs-midi-import-options-v1';
const browserStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
const MIDI_IMPORT_DEFAULTS=Object.freeze({targetTempo:0,gridSubdivision:1,octaveOffset:0,maxLayers:65535,namingMode:'track',keepVelocity:true,keepPan:true,trackNames:true,removeSilent:true,keepWithinOctaveRange:false});
const instrumentIdentity=definition=>JSON.stringify([String(definition?.file||'').replace(/\\/g,'/'),definition?.key,...(definition?.file?[]:[definition?.name])]);
function normalizedMidiImportSettings(value,definitions,sourceDefinitions=definitions){
  if(!value||typeof value!=='object'||Array.isArray(value))value={};
  const result={...MIDI_IMPORT_DEFAULTS};
  for(const key of ['keepVelocity','keepPan','trackNames','removeSilent','keepWithinOctaveRange'])if(typeof value[key]==='boolean')result[key]=value[key];
  for(const [key,min,max]of [['targetTempo',0,655.35],['octaveOffset',-8,8],['maxLayers',1,65535]])if(Number.isFinite(value[key])&&value[key]>=min&&value[key]<=max&&(key==='targetTempo'||Number.isInteger(value[key])))result[key]=value[key];
  if([1,2,4,8,16].includes(value.gridSubdivision))result.gridSubdivision=value.gridSubdivision;
  if(['track','patch','channel'].includes(value.namingMode))result.namingMode=value.namingMode;
  for(const [name,maxId,drum]of [['programMap',127,false],['channelMap',15,false],['percussionMap',127,true]]){
    result[name]={};const source=value[name];if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).length>maxId+1)continue;
    for(const [index,item]of Object.entries(source)){
      if(!/^(0|[1-9]\d*)$/.test(index)||Number(index)>maxId)continue;
      const record=typeof item==='number'?{instrument:item}:item;if(!record||typeof record!=='object'||Array.isArray(record)||!Number.isInteger(record.instrument)||record.instrument< -1||record.instrument>270)continue;
      let instrument=record.instrument;
      if(instrument>=16){
        const original=sourceDefinitions[instrument-16];if(!original)continue;
        if(sourceDefinitions!==definitions){const identity=instrumentIdentity(original),matches=definitions.flatMap((definition,index)=>instrumentIdentity(definition)===identity?[index]:[]);if(matches.length!==1)continue;instrument=16+matches[0];}
        else if(!definitions[instrument-16])continue;
      }
      const converted={instrument};
      if(drum&&record.key!==undefined){if(!Number.isInteger(record.key)||record.key<0||record.key>87)continue;converted.key=record.key;}
      if(!drum&&record.octave!==undefined){if(!Number.isInteger(record.octave)||record.octave< -8||record.octave>8)continue;converted.octave=record.octave;}
      result[name][index]=typeof item==='number'?instrument:converted;
    }
  }
  return result;
}
export const resolveMidiImportOptions=(value,definitions=[])=>({...normalizedMidiImportSettings(value,definitions,Array.isArray(value?.customInstruments)?value.customInstruments:definitions),customInstruments:definitions});
export function loadMidiImportPreferences(storage,definitions=[]){
  const fallback={options:normalizedMidiImportSettings({},definitions),remember:false};
  try{const saved=JSON.parse(storage.getItem(MIDI_IMPORT_STORAGE_KEY)||'null');if(saved?.version!==1||saved.remember!==true)return fallback;const source=Array.isArray(saved.customInstruments)&&saved.customInstruments.length<=255?saved.customInstruments:[];return{options:normalizedMidiImportSettings(saved.options,definitions,source),remember:true};}catch{return fallback;}
}
export function saveMidiImportPreferences(storage,options,definitions=[],remember=false){
  try{const saved=remember?{version:1,remember:true,options:normalizedMidiImportSettings(options,definitions),customInstruments:definitions.map(definition=>({name:String(definition.name||'').slice(0,1024),file:String(definition.file||'').slice(0,4096),key:definition.key}))}:{version:1,remember:false};storage.setItem(MIDI_IMPORT_STORAGE_KEY,JSON.stringify(saved));return true;}catch{return false;}
}
/** Keep explicit hardware mappings and pending note-off recordings consistent with a bank reorder. */
export function remapMidiDeviceInstruments(controller,instrumentMap,{fallback=0}={}){
  if(!(instrumentMap instanceof Map))throw new Error('MIDI 音色重映射必须为 Map。');
  let changed=0;
  for(const [device,config]of controller.devices){if(config.instrument<0||!instrumentMap.has(config.instrument))continue;const mapped=instrumentMap.get(config.instrument),instrument=mapped>=0?mapped:-1;if(instrument!==config.instrument){controller.configure(device,{instrument});changed++;}}
  const record=controller.recording;if(record&&instrumentMap.has(record.instrument)){const mapped=instrumentMap.get(record.instrument);record.instrument=mapped>=0?mapped:fallback;}
  for(const note of controller.held.values()){if(!instrumentMap.has(note.instrument))continue;const mapped=instrumentMap.get(note.instrument);note.instrument=mapped>=0?mapped:fallback;if(mapped<0)note.recording=null;}
  return changed;
}
export function installFeatureUI(h){
  const engine=h.getEngine(),prefs=h.preferences,run=fn=>async(...args)=>{try{return await fn(...args);}catch(error){h.error(error);}},name=()=>String(h.getSong().title||'project').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  let sampleIdentity=new Map(),midiSession=false,midiDevices=[];
  const notify=message=>h.toast(message),close=()=>$('modal').close();
  const instrumentManager=createInstrumentManager({...h,engine,addCustomSample:h.addCustomSample,onInstrumentMap:map=>{remapMidiDeviceInstruments(midi,map,{fallback:h.getState().instrument});midiDevices=midiDevices.map(device=>({...device,...midi.devices.get(device.id)}));if($('midiDevices'))renderMidiDevices();h.onInstrumentMap?.(map);}});
  function applyPrefs(){
    document.body.classList.toggle('theme-dark',prefs.theme==='dark'||prefs.theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);
    for(const theme of ['classic','aqua','classic-dark'])document.body.classList.toggle(`theme-${theme}`,prefs.theme===theme);
    if(prefs.theme==='classic-dark')document.body.classList.add('theme-dark');
    document.body.classList.toggle('blackout',prefs.blackout);h.applyPlaybackPreferences?.();
    document.body.classList.toggle('hide-layer-pane',!prefs.showLayers);document.body.classList.toggle('hide-piano',!prefs.showPiano);
    document.documentElement.style.setProperty('--accent',prefs.accent||'#0078d4');
    document.documentElement.style.setProperty('--editor-font-scale',`${Math.min(150,Math.max(75,Number(prefs.scale)||100))/100}`);
    h.resize();h.scheduleDraw();
  }
  function commit(operation){if(h.isBusy())throw new Error('请先停止性能测试或等待当前操作结束。');h.checkpoint();const result=operation(h.getSong());if(result?.selectedIds)h.setSelected(result.selectedIds);else if(Array.isArray(result))h.setSelected(result);h.refresh({save:true});return result;}
  function chooseFile(accept,callback){const input=document.createElement('input');input.type='file';input.accept=accept;input.onchange=run(async()=>{const file=input.files[0];if(file)await callback(file);});input.click();}
  const selected=()=>[...h.getSelected()];
  async function projectSamples(){await engine.init();const bank=new Map(engine.customSamples);h.getSong().customInstruments.forEach((definition,index)=>{const buffer=engine.bundledCustomSamples.get(bundledCustomFile(definition.file));if(!bank.has(index)&&buffer)bank.set(index,buffer);});return bank;}

  function showMacros(initial){
    h.modal('宏与音乐编辑',`<p>对已选择的音符执行原版编辑算法；音轨锁定仍生效。</p><label>操作<select id="macroType">${EDITOR_TOOLS.map(t=>`<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select></label><div id="macroFields"></div><p>已选择 ${selected().length.toLocaleString()} 个音符。</p>`,`<button class="secondary-button" data-close>取消</button><button class="primary-button" id="applyMacro">应用</button>`);
    const fields=()=>{const tool=EDITOR_TOOLS.find(t=>t.id===$('macroType').value);$('macroFields').innerHTML=tool.options.map(o=>`<label class="${o.type==='boolean'?'inline-label':''}">${esc(o.label)}<input data-option="${o.name}" type="${o.type==='boolean'?'checkbox':o.type==='number'?'number':'text'}" ${o.type==='boolean'?(o.default?'checked':''):`value="${esc(o.default)}"`} ${o.min===undefined?'':`min="${o.min}" max="${o.max}"`}></label>`).join('');};if(EDITOR_TOOLS.some(tool=>tool.id===initial))$('macroType').value=initial;fields();$('macroType').onchange=fields;
    $('applyMacro').onclick=run(()=>{const tool=EDITOR_TOOLS.find(t=>t.id===$('macroType').value),options={};for(const o of tool.options){const input=$('macroFields').querySelector(`[data-option="${o.name}"]`);options[o.name]=o.type==='boolean'?input.checked:o.type==='number'?Number(input.value):input.value;}const result=commit(song=>applyEditorTool(song,selected(),tool.id,options));if(!result.changed)throw new Error('没有可修改的音符，请先选择未锁定的音符。');close();notify(`已应用 ${tool.label}`);});
  }
  function showPatterns(){
    h.modal('图案与分段代码',`<p>兼容原版 .nbp 图案和分段代码。图案从当前播放位置及选中音轨插入。</p><div class="feature-actions"><button id="patternOpen">打开 NBP…</button><button id="patternSave">选区保存 NBP</button><button id="patternDrum">原版鼓组示例</button></div><label>分段代码<textarea id="patternCode" rows="5" spellcheck="false"></textarea></label><div class="feature-actions"><button id="selectionCodeCopy">选区生成代码</button><button id="selectionCodePaste">插入代码</button></div>`);
    const insert=pattern=>{const cursor=h.getState();commit(song=>insertPattern(song,pattern,{tick:Math.floor(cursor.tick),layer:cursor.layer}));close();notify('图案已插入');};
    $('patternOpen').onclick=()=>chooseFile('.nbp',async file=>insert(parseNBP(await file.arrayBuffer(),{customInstrumentCount:h.getSong().customInstruments.length})));
    $('patternSave').onclick=run(()=>h.download(writeNBP(patternFromSelection(h.getSong(),selected())),`${name()}.nbp`));
    $('patternDrum').onclick=run(async()=>insert(parseNBP(await (await fetch('assets/patterns/Drum Example.nbp')).arrayBuffer())));
    $('selectionCodeCopy').onclick=run(()=>{$('patternCode').value=writeSelectionCode(patternFromSelection(h.getSong(),selected()).notes);});
    $('selectionCodePaste').onclick=run(async()=>insert(await decodeSelectionCode($('patternCode').value,{customInstrumentCount:h.getSong().customInstruments.length})));
  }
  function showChord(){h.modal('插入和弦',`<label>和弦<select id="chordType">${Object.keys(CHORDS).map(id=>`<option>${id}</option>`).join('')}</select></label><label class="inline-label">音符间隔（0 为同时发声）<input id="chordSpacing" type="number" min="0" max="9999" value="0"></label>`,`<button class="primary-button" id="chordApply">插入</button>`);$('chordApply').onclick=run(()=>{commit(song=>insertChord(song,{...h.getState(),tick:Math.floor(h.getState().tick),chord:$('chordType').value,spacing:Number($('chordSpacing').value)}));close();});}
  function showSelection(){h.modal('选择音符',`<label>选择方式<select id="selectionMode"><option value="all">全部</option><option value="none">取消选择</option><option value="invert">反选</option><option value="instrument">仅当前乐器</option><option value="except-instrument">除当前乐器以外</option></select></label>`,`<button id="selectionApply" class="primary-button">应用</button>`);$('selectionApply').onclick=()=>{h.setSelected(selectNotes(h.getSong(),selected(),{mode:$('selectionMode').value,instrument:h.getState().instrument}));h.refresh();close();};}
  function showPreferences(initial='appearance'){
    const groups={appearance:['显示',{colors:'使用原版音符颜色',shapes:'每种音色使用独立形状',icons:'显示音色图标',numbers:'显示音符属性数字',octaves:'显示音符八度',incompatible:'标示与原版 Minecraft 不兼容的音符',showLayers:'显示图层面板',showPiano:'显示钢琴',fade:'按力度淡化音符',flat:'使用降号名称',removeEffect:'删除时扩散淡出',rainbow:'彩虹强调色',blackout:'播放器黑底模式'}],playback:['播放',{follow:'播放时跟随光标',sectionStart:'从活动区间开始播放',sectionEnd:'在活动区间结束后停止',returnMarker:'播放结束后回到起点',mono:'单声道播放',bpm:'速度以 BPM 输入'}],piano:['钢琴',{keyNames:'显示所有琴键音名',keyNumbers:'显示音符盒数字',keyBindings:'显示电脑键位',outOfRange:'标示超出音符盒音域的琴键',noteChart:'悬停琴键显示五线谱',selectLastKey:'选择最后弹奏的音高'}],input:['输入',{keyboardInput:'电脑键盘弹奏',wheelProperties:'滚轮悬停音符时修改当前属性'}],storage:['保存',{autoBackup:'保留自动备份'}]};
    const boxes=entries=>Object.entries(entries).map(([key,label])=>`<label class="inline-label">${label}<input data-pref="${key}" type="checkbox" ${prefs[key]?'checked':''}></label>`).join('');
    h.modal('偏好设置',`<div class="preference-tabs" role="tablist">${Object.entries(groups).map(([id,[label]])=>`<button role="tab" data-preference-tab="${id}">${label}</button>`).join('')}</div>${Object.entries(groups).map(([id,[,entries]])=>`<section data-preference-page="${id}" ${id!==initial?'hidden':''}>${id==='appearance'?'<label>主题<select id="prefTheme"><option value="light">Fluent 浅色</option><option value="dark">Fluent 深色</option><option value="system">跟随系统</option><option value="classic">经典</option><option value="aqua">Aqua</option><option value="classic-dark">经典深色</option></select></label>':''}<div class="preferences-grid">${boxes(entries)}</div>${id==='appearance'?`<label class="inline-label">界面字号比例（%）<input id="prefScale" type="number" min="75" max="150" value="${prefs.scale}"></label><label class="inline-label">强调色<input id="prefAccent" type="color" value="${prefs.accent}"></label>`:id==='playback'?'<label>光标跟随方式<select id="prefFollow"><option value="page">按页翻动</option><option value="tick">逐刻跟随</option><option value="frame">逐帧平滑跟随</option></select></label>':id==='piano'?`<label class="inline-label">可见白键数<input id="prefKeys" type="number" min="7" max="52" value="${prefs.keysmax}"></label><p>右键琴键后按一个字符，可重新分配电脑键位；Delete 清除绑定，Escape 取消。</p><button id="resetPianoBindings">恢复默认键位</button>`:id==='input'?'<label>滚轮默认操作<select id="prefWheel"><option value="scroll">滚动曲谱</option><option value="instrument">切换音色</option><option value="key">改变选定音高</option></select></label>':`<label class="inline-label">自动备份间隔（分钟）<input id="prefBackup" type="number" min="1" max="60" value="${prefs.backupMinutes}"></label><p>编辑会持续保存当前工程。自动备份另保留最近 20 个曲谱快照；最近歌曲保存可再次打开的浏览器副本。完整工程包可携带音频。</p>`}</section>`).join('')}`,`<button class="primary-button" id="prefApply">保存</button>`);
    $('prefTheme').value=prefs.theme;$('prefFollow').value=prefs.followMode;$('prefWheel').value=prefs.wheelMode;
    const tab=id=>{document.querySelectorAll('[data-preference-page]').forEach(page=>page.hidden=page.dataset.preferencePage!==id);document.querySelectorAll('[data-preference-tab]').forEach(button=>{const active=button.dataset.preferenceTab===id;button.setAttribute('aria-selected',String(active));button.classList.toggle('active',active);});};
    document.querySelectorAll('[data-preference-tab]').forEach(button=>button.onclick=()=>tab(button.dataset.preferenceTab));tab(initial);
    $('resetPianoBindings').onclick=()=>h.resetPianoBindings?.();
    $('prefApply').onclick=run(()=>{const next={...prefs,theme:$('prefTheme').value,followMode:$('prefFollow').value,wheelMode:$('prefWheel').value,keysmax:Number($('prefKeys').value),scale:Number($('prefScale').value),backupMinutes:Number($('prefBackup').value),accent:$('prefAccent').value};for(const [,entries]of Object.values(groups))for(const key of Object.keys(entries))next[key]=document.querySelector(`[data-pref="${key}"]`).checked;Object.assign(prefs,normalizePreferences(next));localStorage.setItem('nbs-web-preferences-v3',JSON.stringify(prefs));applyPrefs();h.refresh();close();});
  }
  async function showBackups(){
    const list=(await h.store.history()).reverse();h.modal('备份与恢复',`<p>自动保存每 5 分钟保留一个曲谱快照，最多 20 个。完整工程包可同时保存本次加载的自定义采样。</p><div class="feature-actions"><button id="backupNow">立即备份</button><button id="bundleSave">保存完整工程包</button><button id="bundleOpen">打开工程包…</button></div><div class="backup-list">${list.map(b=>`<button data-restore="${esc(b.key)}"><strong>${esc(b.title)}</strong><small>${esc(b.label)} · ${esc(new Date(b.createdAt).toLocaleString())} · ${b.notes} notes</small></button>`).join('')||'<p>暂无备份。</p>'}</div>`);
    $('backupNow').onclick=run(async()=>{await h.store.backup(h.getSong());await showBackups();notify('已创建备份');});
    $('bundleSave').onclick=run(async()=>{h.download(await writeProjectBundle(h.getSong(),await projectSamples()),`${name()}.nbpz`,'application/zip');notify('完整工程包已导出');});
    $('bundleOpen').onclick=()=>chooseFile('.nbpz,.zip',importBundle);
    document.querySelectorAll('[data-restore]').forEach(button=>button.onclick=run(async()=>{const song=await h.store.restore(button.dataset.restore),oldDefinitions=h.getSong().customInstruments,oldBank=new Map(engine.customSamples);close();h.confirmReplace(()=>{h.replaceSong(song);const bank=new Map();song.customInstruments.forEach((definition,index)=>{const old=oldDefinitions.findIndex(d=>d.file===definition.file);if(old>=0&&oldBank.has(old))bank.set(index,oldBank.get(old));});engine.customSamples=bank;h.persist();});}));
  }
  async function importBundle(file){
    if(file.size>256*1024*1024)throw new Error('完整工程包超过 256 MB。');
    const parsed=await readProjectBundle(await file.arrayBuffer()),samples=new Map();
    if(parsed.samples.length){const decoder=engine.context||new OfflineAudioContext(1,1,48000);for(const sample of parsed.samples)samples.set(sample.index,await decoder.decodeAudioData(sample.bytes.slice(0)));}
    h.confirmReplace(()=>{h.replaceSong(parsed.project);engine.customSamples=samples;h.persist();notify(`已打开完整工程包 ${file.name}`);});
  }
  function showOpenURL(initial=''){
    h.modal('从链接打开',`<label>曲谱或音频链接<input id="songURL" type="url" value="${esc(initial)}" placeholder="https://…/song.nbs 或 audio.flac"></label><p>支持 NBS、MIDI、JSON 工程，以及 WAV、FLAC、MP3、M4A、OGG 等音频。音频进入本机音符识别，不会替换当前曲谱。浏览器直接读取 HTTP(S) 链接，来源网站须允许跨域访问（CORS）；失败时可先下载文件，再用打开或拖放导入。支持 nbs:// 包装的曲谱链接。</p>`,`<button class="primary-button" id="urlApply">读取文件</button>`);
    $('urlApply').onclick=run(async()=>{const button=$('urlApply');button.disabled=true;try{const result=await fetchSongInBrowser($('songURL').value);close();await h.loadFile(new File([result.bytes],result.filename,{type:result.mime}));}finally{if(button.isConnected)button.disabled=false;}});
  }
  function importMidi(file,{settingsOnly=false,onApply,initialOptions}={}){
    if(file.size>128*1024*1024)throw new Error('MIDI 文件超过 128 MB。');
    const original=h.getSong(),definitions=original.customInstruments,saved=loadMidiImportPreferences(browserStorage(),definitions),{programMap,percussionMap,channelMap}=saved.options;
    if(settingsOnly&&initialOptions){saved.options=resolveMidiImportOptions(initialOptions,definitions);for(const [name,map]of [['programMap',programMap],['percussionMap',percussionMap],['channelMap',channelMap]]){for(const key of Object.keys(map))delete map[key];Object.assign(map,saved.options[name]);}}
    const targets=`<option value="-2">默认映射</option><option value="-1">忽略</option>${[...INSTRUMENTS,...definitions.map((i,id)=>({id:16+id,name:i.name}))].map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')}`;
    h.modal('MIDI 导入设置',`<p>${esc(file.name)}：按真实时间转换速度变化，再放入可编辑的音符盒网格。</p><label class="inline-label">目标速度 ticks/s（0 为自动）<input id="midiImportTempo" type="number" min="0" max="655.35" step="0.01" value="0"></label><label>图层命名<select id="midiImportNaming"><option value="track">MIDI 轨道名称</option><option value="patch">GM 音色名称</option><option value="channel">Channel 通道编号</option></select></label><label>网格精度<select id="midiImportGrid">${[1,2,4,8,16].map(n=>`<option value="${n}">${n} 倍</option>`).join('')}</select></label><label class="inline-label">八度偏移<input id="midiImportOctave" type="number" min="-8" max="8" value="0"></label><label class="inline-label">最大图层数<input id="midiImportLayers" type="number" min="1" max="65535" value="65535"></label>${[['Velocity','保留力度'],['Pan','保留声像'],['Names','使用 MIDI 轨道名'],['Silent','移除开头空白']].map(([id,label])=>`<label class="inline-label">${label}<input type="checkbox" id="midiImport${id}"></label>`).join('')}<label class="inline-label">折叠到音符盒音域<input id="midiImportFold" type="checkbox"></label><details><summary>乐器与打击乐映射</summary><label>类别<select id="midiMappingKind"><option value="program">GM 音色 Program</option><option value="drum">打击乐 MIDI 音高</option></select></label><label class="inline-label">编号（0–127）<input id="midiMappingNumber" type="number" min="0" max="127" value="0"></label><label>转换为<select id="midiMappingTarget">${targets}</select></label><label class="inline-label">该音色八度偏移<input id="midiMappingOctave" type="number" min="-8" max="8" value="0"></label><label class="inline-label">打击乐目标音高<input id="midiMappingKey" type="number" min="0" max="87" value="45"></label><div class="feature-actions"><button id="midiMappingSave">保存这条映射</button><button id="midiNativeMapping">使用原版 GM 预设</button><button id="midiResetMapping">重置映射</button></div><p id="midiMappingStatus"></p></details><details><summary>每通道音色与八度覆盖（0–15）</summary><p>默认沿用上面的音色映射。设置后，该通道的音色和八度优先；通道 9（MIDI 通道 10）保留每鼓目标音高，再叠加这里的八度。</p>${Array.from({length:16},(_,channel)=>`<div class="feature-actions"><label>通道 ${channel}（MIDI ${channel+1}）<select data-midi-import-channel="${channel}">${targets}</select></label><label class="inline-label">八度<input data-midi-import-channel-octave="${channel}" type="number" min="-8" max="8" value="0"></label></div>`).join('')}</details><label class="inline-label">记住导入设置<input id="midiImportRemember" type="checkbox" ${saved.remember?'checked':''}></label><p>记忆内容只保存在本浏览器；自定义音色按文件与根音匹配，当前工程缺少的音色会恢复默认映射。</p><p id="midiImportStatus"></p>`,`<button id="midiImportApply" class="primary-button">导入</button>`);
    for(const [id,key]of [['Tempo','targetTempo'],['Naming','namingMode'],['Grid','gridSubdivision'],['Octave','octaveOffset'],['Layers','maxLayers']])$('midiImport'+id).value=saved.options[key];
    for(const [id,key]of [['Velocity','keepVelocity'],['Pan','keepPan'],['Names','trackNames'],['Silent','removeSilent'],['Fold','keepWithinOctaveRange']])$('midiImport'+id).checked=saved.options[key];
    const status=()=>{$('midiMappingStatus').textContent=`已设置 ${Object.keys(programMap).length} 条音色映射、${Object.keys(percussionMap).length} 条打击乐映射、${Object.keys(channelMap).length} 条通道覆盖`;};
    const loadMapping=()=>{const drum=$('midiMappingKind').value==='drum',item=(drum?percussionMap:programMap)[$('midiMappingNumber').value],record=typeof item==='number'?{instrument:item}:item;$('midiMappingTarget').value=record?.instrument??-2;$('midiMappingOctave').value=record?.octave??0;$('midiMappingKey').value=record?.key??45;$('midiMappingOctave').disabled=drum;$('midiMappingKey').disabled=!drum;};
    const clear=map=>{for(const key of Object.keys(map))delete map[key];};
    const channelRows=()=>{for(const select of document.querySelectorAll('[data-midi-import-channel]')){const channel=select.dataset.midiImportChannel,item=channelMap[channel],record=typeof item==='number'?{instrument:item}:item,octave=document.querySelector(`[data-midi-import-channel-octave="${channel}"]`);select.value=record?.instrument??-2;octave.value=record?.octave??0;octave.disabled=Number(select.value)<0;}};
    const currentChannels=()=>{const result={};for(const select of document.querySelectorAll('[data-midi-import-channel]')){const channel=select.dataset.midiImportChannel,instrument=Number(select.value),shift=Number(document.querySelector(`[data-midi-import-channel-octave="${channel}"]`).value);if(!Number.isInteger(instrument)||instrument< -2||instrument>15+definitions.length)throw new Error('通道音色引用无效。');if(instrument===-2)continue;if(instrument===-1){result[channel]=-1;continue;}if(!Number.isInteger(shift)||shift< -8||shift>8)throw new Error('通道八度偏移必须为 -8–8 的整数。');result[channel]={instrument,octave:shift};}return result;};
    for(const select of document.querySelectorAll('[data-midi-import-channel]')){const channel=select.dataset.midiImportChannel,octave=document.querySelector(`[data-midi-import-channel-octave="${channel}"]`),update=run(()=>{octave.disabled=Number(select.value)<0;const next=currentChannels();clear(channelMap);Object.assign(channelMap,next);status();});select.onchange=update;octave.onchange=update;}
    $('midiMappingKind').onchange=loadMapping;$('midiMappingNumber').onchange=loadMapping;
    $('midiMappingSave').onclick=run(()=>{const index=Number($('midiMappingNumber').value),target=Number($('midiMappingTarget').value),drum=$('midiMappingKind').value==='drum',map=drum?percussionMap:programMap,shift=Number($('midiMappingOctave').value),key=Number($('midiMappingKey').value);if(!Number.isInteger(index)||index<0||index>127)throw new Error('映射编号必须是 0–127。');if(drum&&(!Number.isInteger(key)||key<0||key>87)||!drum&&(!Number.isInteger(shift)||shift< -8||shift>8))throw new Error(drum?'打击乐目标音高必须为 0–87 的整数。':'音色八度偏移必须为 -8–8 的整数。');if(target===-2)delete map[index];else map[index]=target===-1?-1:{instrument:target,...(drum?{key}:{octave:shift})};status();});
    $('midiNativeMapping').onclick=()=>{clear(programMap);clear(percussionMap);clear(channelMap);Object.assign(programMap,structuredClone(MIDI_PROGRAM_DEFAULTS));Object.assign(percussionMap,structuredClone(MIDI_PERCUSSION_DEFAULTS));loadMapping();channelRows();status();};
    $('midiResetMapping').onclick=()=>{clear(programMap);clear(percussionMap);clear(channelMap);loadMapping();channelRows();status();};
    channelRows();loadMapping();status();
    if(settingsOnly){const heading=document.querySelector('.modal-heading h2');if(heading)heading.textContent='音频转录音色映射';$('midiImportApply').textContent='保存映射';$('midiImportTempo').disabled=true;$('midiImportGrid').disabled=true;$('midiImportTempo').value=0;$('midiImportGrid').value=1;$('midiImportStatus').textContent='转录结果追加到当前工程，保留当前速度并按现有整数 tick 网格量化。';}
    $('midiImportApply').onclick=run(async()=>{
      const button=$('midiImportApply');button.disabled=true;
      try{if(h.getSong()!==original)throw new Error('当前工程已改变，请重新打开 MIDI 导入窗口。');const options={gridSubdivision:Number($('midiImportGrid').value),octaveOffset:Number($('midiImportOctave').value),maxLayers:Number($('midiImportLayers').value),namingMode:$('midiImportNaming').value,keepVelocity:$('midiImportVelocity').checked,keepPan:$('midiImportPan').checked,trackNames:$('midiImportNames').checked,removeSilent:$('midiImportSilent').checked,keepWithinOctaveRange:$('midiImportFold').checked,programMap:structuredClone(programMap),channelMap:currentChannels(),percussionMap:structuredClone(percussionMap),customInstruments:definitions},tempo=Number($('midiImportTempo').value),remember=$('midiImportRemember').checked;if(!Number.isFinite(tempo)||tempo<0||tempo>655.35)throw new Error('目标速度必须在 0–655.35 之间。');if(tempo>0)options.targetTempo=tempo;if(settingsOnly){onApply?.(structuredClone(options));saveMidiImportPreferences(browserStorage(),options,definitions,remember);close();notify('转录音色映射已更新');return;}const song=await h.store.parse(file,message=>{if($('midiImportStatus'))$('midiImportStatus').textContent=message;},options);if(h.getSong()!==original)throw new Error('当前工程已改变，本次 MIDI 未替换工程。');const bank=new Map(engine.customSamples);close();h.confirmReplace(()=>{h.replaceSong(song);engine.customSamples=bank;h.persist();const remembered=saveMidiImportPreferences(browserStorage(),options,definitions,remember);notify(`MIDI 已导入 · ${song.notes.length} 个音符${!remembered&&remember?'；浏览器未允许记忆导入设置':''}`);});}finally{if(button.isConnected)button.disabled=false;}
    });
  }
  function codecProgress(id,prefix=''){
    return update=>{const target=$(id);if(target)target.textContent=`${prefix}${update.stage==='load'?'正在加载浏览器编码器':'浏览器正在编码'}${Number.isFinite(update.progress)?` · ${Math.round(Math.min(1,Math.max(0,update.progress))*100)}%`:''}…`;};
  }
  function showAudioExport(){
    h.modal('音频导出',`<label>格式<select id="audioFormat"><option value="wav">WAV</option><option value="mp3">MP3</option><option value="flac">FLAC</option><option value="aiff">AIFF</option><option value="ogg">OGG Vorbis</option></select></label><label>采样率<select id="audioRate">${[8000,11025,16000,22050,44100,48000,88200,96000,176400,192000,352800,384000].map(rate=>`<option ${rate===(engine.context?.sampleRate||48000)?'selected':''}>${rate}</option>`).join('')}</select></label><label>通道<select id="audioChannels"><option value="2">立体声</option><option value="1">单声道</option></select></label><label class="inline-label">包括锁定音轨<input id="audioLocked" type="checkbox" checked></label><label class="inline-label">MP3 码率（kbps）<input id="audioBitrate" type="number" min="32" max="320" value="320"></label><p>音频在当前浏览器中渲染和编码，不上传到服务器。原采样率立体声 WAV 直接生成；其他格式首次使用时会加载网站自带的编码器。</p><p id="audioProgress">准备就绪</p>`,`<button class="primary-button" id="audioRender">导出</button>`);
    $('audioRender').onclick=run(async()=>{const button=$('audioRender');button.disabled=true;try{const format=$('audioFormat').value,rate=Number($('audioRate').value),channels=Number($('audioChannels').value),bitrate=Number($('audioBitrate').value),original=h.getSong(),song=$('audioLocked').checked?original:{...original,layers:original.layers.map(layer=>({...layer,muted:layer.muted||layer.locked}))};codecArguments({format,rate,channels,bitrate});await engine.init();const transcode=format!=='wav'||channels!==2||rate!==engine.context.sampleRate;if(transcode)await loadBrowserCodecs({onProgress:codecProgress('audioProgress')});$('audioProgress').textContent='浏览器 Rust 正在渲染…';let output=await engine.exportWav(song,{masterVolume:Number($('masterVolume').value)/100});if(transcode)output=await encodeAudio(output,{format,rate,channels,bitrate,onProgress:codecProgress('audioProgress')});h.download(output,`${name()}.${format}`);if($('audioProgress'))$('audioProgress').textContent=`导出完成 · ${(output.size/1048576).toFixed(2)} MB`;}finally{if(button.isConnected)button.disabled=false;}});
  }
  const midi=new MidiInputController({
    onNote:note=>{const cursor=h.getState(),config=midi.devices.get(note.device);const played={...note,instrument:config?.instrument>=0?config.instrument:cursor.instrument};const recorded=h.recordLiveNote?.(played);h.selectLiveKey?.(note.key);h.holdPiano?.(`midi:${JSON.stringify([note.device,note.channel,note.key])}`,note.key);if(!recorded)engine.triggerLive(played,{channel:note.channel,layer:h.getSong().layers[cursor.layer]}).catch(h.error);},
    onRelease:note=>h.releasePiano?.(`midi:${JSON.stringify([note.device,note.channel,note.key])}`),
    onDevices:list=>{midiDevices=list;if($('midiDevices'))renderMidiDevices();},onError:h.error,
    onStep:tick=>{h.getState().tick=tick;h.scheduleDraw();},
    onRecord:note=>{
      if(!Number.isFinite(note.tick)||note.tick<0||Math.round(note.tick)>999999){h.error(new Error('录制超过可编辑时间线范围，已忽略该音符。'));return;}
      if(h.isBusy())return;const song=h.getSong();if(song.notes.length>=MAX_NOTES){h.error(new Error('音符数量已达上限。'));return;}
      if(!midiSession){h.checkpoint();midiSession=true;}
      const occupied=new Set(song.notes.filter(n=>n.tick===note.tick).map(n=>n.layer));let layer=note.layer;
      while(layer<MAX_LAYERS&&(occupied.has(layer)||song.layers[layer]?.locked))layer++;
      if(layer>=MAX_LAYERS){h.error(new Error('没有可录制的音轨。'));return;}
      while(song.layers.length<=layer){const id=song.layers.length;song.layers.push({id,name:`MIDI ${id+1}`,volume:100,pan:0,reverb:0,muted:false,solo:false,locked:false});}
      song.notes.push({id:uniqueId(),tick:Math.min(999999,Math.round(note.tick)),layer,key:note.key,instrument:note.instrument,velocity:note.velocity,pan:note.pan,pitch:note.pitch,duration:note.duration});h.refresh({save:true});
    }
  });
  function renderMidiDevices(){
    $('midiDevices').innerHTML=midiDevices.length?midiDevices.map(device=>`<div class="midi-device" data-device="${esc(device.id)}"><strong>${esc(device.name)}</strong><small>${esc(device.state)}</small><label>音色<select data-midi-instrument><option value="-1">当前选择的音色</option><option value="-2">不接收音符</option>${[...INSTRUMENTS,...h.getSong().customInstruments.map((i,id)=>({id:16+id,name:i.name}))].map(i=>`<option value="${i.id}" ${i.id===device.instrument?'selected':''}>${esc(i.name)}</option>`).join('')}</select></label><label>通道<select data-midi-channel><option value="-1">全部</option>${Array.from({length:16},(_,ch)=>`<option value="${ch}" ${device.channel===ch?'selected':''}>${ch+1}</option>`).join('')}</select></label><label class="inline-label">启用<input data-midi-enable type="checkbox" ${device.enabled?'checked':''}></label></div>`).join(''):'<p>尚未连接设备。点击下方按钮请求 MIDI 设备权限。</p>';
    document.querySelectorAll('[data-device]').forEach(row=>row.onchange=()=>midi.configure(row.dataset.device,{instrument:Number(row.querySelector('[data-midi-instrument]').value),channel:Number(row.querySelector('[data-midi-channel]').value),enabled:row.querySelector('[data-midi-enable]').checked}));
  }
  function toggleMidiRecord(){
    if(midi.recording){midi.stopRecording();midiSession=false;$('recordMidiBtn')?.classList.remove('active');notify('MIDI 录制已停止');return;}
    if(!midi.access){showMidi();return;}
    if(h.isBusy())throw new Error('请先停止性能测试。');const cursor=h.getState();midiSession=false;
    midi.startRecording({mode:$('midiMode')?.value||'realtime',tick:Math.floor(cursor.tick),tempo:h.getSong().tempo,snap:cursor.snap,instrument:cursor.instrument,layer:cursor.layer,clockTick:engine.playing?()=>engine.getTick():undefined});
    $('recordMidiBtn')?.classList.add('active');notify('MIDI 录制已开始；再次点击录制按钮停止');
  }
  function showMidi(){
    h.modal('MIDI 设备与录制',`<p>可同时接收多个输入设备。支持力度、通道音量、声像、弯音和延音踏板；音符盒试听按采样自然长度播放。</p><div id="midiDevices"></div><label>录制方式<select id="midiMode"><option value="realtime">实时录制，按网格量化</option><option value="step">步进录制，松开和弦后前进一步</option></select></label><div class="feature-actions"><button id="midiConnect">授权并刷新设备</button><button id="midiDisconnect">断开 MIDI</button><button id="midiRecord">${midi.recording?'停止录制':'开始录制'}</button></div><p>浏览器权限只在你点击授权后申请。录制按钮也位于播放工具栏。</p>`);renderMidiDevices();
    $('midiConnect').onclick=run(async()=>{await engine.init();await midi.connect();notify('MIDI 设备已刷新');});
    $('midiDisconnect').onclick=run(async()=>{await midi.disconnect();engine.stopLive();$('recordMidiBtn')?.classList.remove('active');});
    $('midiRecord').onclick=run(()=>{toggleMidiRecord();if(midi.recording)close();else $('midiRecord').textContent='开始录制';});
  }
  function showCustomInstruments(){return instrumentManager.open();}
  function showLayerTools(){
    h.modal('图层管理',`<label>操作<select id="layerOperation"><option value="up">当前图层上移</option><option value="down">当前图层下移</option><option value="insert">在当前图层前插入</option><option value="duplicate">复制当前图层及音符</option><option value="remove-empty">删除空图层</option></select></label>`,`<button id="layerOperationApply" class="primary-button">应用</button>`);
    $('layerOperationApply').onclick=run(()=>{const operation=$('layerOperation').value;commit(song=>{const result=applyLayerOperation(song,{operation,index:h.getState().layer});h.getState().layer=result.layer;return result;});close();});
  }
  function showSystem(){
    const state=getBrowserCodecState(),labels={idle:'首次导出时加载',loading:'正在加载',ready:'已就绪',encoding:'正在编码',error:'上次编码失败，可重新尝试'};
    h.modal('浏览器运行信息',`<p>Web 版 4.3.0 · 纯静态网站</p><p>编辑、Rust/WASM 多核播放、每轨混响、音频编码和自动保存都在当前浏览器中运行。工程和音频不会上传到服务器。</p><p>浏览器编码器：${esc(labels[state.state]||state.state||'按需加载')}。支持 MP3、FLAC、AIFF、OGG 和 WAV。</p><p>MIDI 设备在您主动授权后连接。浏览器不直接安装系统文件关联、连接 Discord 桌面活动、读取命令行指定路径或替换本机程序文件。</p><p>重要作品请下载包含自定义采样的完整工程包。</p>`,`<button class="primary-button" id="systemClose">关闭</button>`);$('systemClose').onclick=close;
  }


  async function rememberProject(project=h.getSong()){
    project.metadata ||= {};project.metadata.browserProjectId ||= uniqueId();
    const snapshot=snapshotSampleBank(engine.customSamples);
    return h.store.remember(project,snapshot?.samples||[]);
  }
  async function showRecent(){
    await rememberProject();const rows=await h.store.recent();
    h.modal('最近歌曲',`<p>保存在当前浏览器中的最近 11 首歌曲，包含当时加载的自定义采样。</p><div class="backup-list">${rows.map(row=>`<button data-recent="${esc(row.key)}"><strong>${esc(row.title)}</strong><small>${new Date(row.createdAt).toLocaleString()} · ${row.notes} notes</small></button>`).join('')||'<p>暂无最近歌曲。</p>'}</div>`,`<button class="secondary-button" id="clearRecent">清除最近列表</button>`);
    document.querySelectorAll('[data-recent]').forEach(button=>button.onclick=run(async()=>{const row=await h.store.loadRecent(button.dataset.recent),bank=restoreSampleBank(row.samples,{maxIndex:row.project.customInstruments.length});close();h.confirmReplace(()=>{h.replaceSong(row.project);engine.customSamples=bank;h.persist();notify('已打开最近歌曲');});}));
    $('clearRecent').onclick=run(async()=>{await h.store.clearRecent();close();notify('最近列表已清除，当前工程仍保留');});
  }
  function showAbout(){h.modal('关于 Note Block Studio Web',`<p>Web 版 4.3.0，基于 Open Note Block Studio v3.11.0 的源码与素材移植。原项目与本项目使用 MIT 许可；随包 FFmpeg 核心遵循其独立 GPL 许可。</p><p>纯静态网站；Rust/WASM 多核音频和逐轨混响均在浏览器运行。</p><p><a href="https://github.com/OpenNBS/OpenNoteBlockStudio" target="_blank" rel="noopener">原项目源码</a> · <a href="https://github.com/sitbat/NoteBlockStudio-Web" target="_blank" rel="noopener">Web 项目源码</a></p><p>非官方 Minecraft 项目，与 Mojang / Microsoft 没有关联。</p>`);}
  function showChangelog(){h.modal('更新历史',`<p><strong>4.2</strong>：补齐原版属性编辑、图层行内控制、区间播放、节拍器、变速控制、播放器下落模式和显示偏好；修复导入导出兼容性。</p><p><strong>4.1</strong>：还原琴键与音符播放动画。</p><p><strong>4.0</strong>：纯静态部署，编码与实时音频全部在浏览器完成。</p>`);}
  function selectMode(mode){h.setSelected(selectNotes(h.getSong(),selected(),{mode,instrument:h.getState().instrument}));h.refresh();}
  function editorOperation(id){commit(song=>applyEditorTool(song,selected(),id));}

  const actions={macros:run(showMacros),patterns:run(showPatterns),chords:run(showChord),selectionTools:run(showSelection),preferences:run(showPreferences),backups:run(showBackups),saveProject:run(async()=>h.download(await writeProjectBundle(h.getSong(),await projectSamples()),`${name()}.nbpz`,'application/zip')),openURL:run(()=>showOpenURL()),audioExport:run(showAudioExport),midi:run(showMidi),layerTools:run(showLayerTools),instruments:run(showCustomInstruments),statistics:run(()=>h.showStatistics()),tempoTap:run(()=>h.showTempoTap()),system:run(showSystem),minecraft:run(async()=>showMinecraft()),recent:run(showRecent),saveOptions:run(()=>h.showSaveOptions()),saveAs:h.downloadNBS,importPattern:()=>chooseFile('.nbp',file=>api.importPattern(file)),exportPattern:()=>{const pattern=patternFromSelection(h.getSong(),selected());h.download(writeNBP(pattern),`${name()}.nbp`);},importMidiFile:()=>chooseFile('.mid,.midi',importMidi),importSchematic:run(()=>showMinecraft()),minecraftSchematic:run(()=>showMinecraft('schematic')),minecraftTrack:run(()=>showMinecraft('track')),minecraftBranch:run(()=>showMinecraft('branch')),minecraftDatapack:run(()=>showMinecraft('datapack')),importMinecraftSounds:run(instrumentManager.importSounds),invertSelection:()=>selectMode('invert'),selectInstrument:()=>selectMode('instrument'),selectOtherInstruments:()=>selectMode('except-instrument'),expandSelection:()=>editorOperation('expand'),compressSelection:()=>editorOperation('compress'),foldOctave:()=>editorOperation('fold-octave'),macro:run(showMacros),about:showAbout,changelog:showChangelog,tutorials:part=>window.open(`https://www.bilibili.com/video/BV1Mx411a76p${Number.isInteger(part)&&part>=1&&part<=4?`?p=${part}`:''}`,'_blank','noopener'),website:()=>window.open('https://opennbs.org/','_blank','noopener'),sourceWebsite:()=>window.open('https://github.com/OpenNBS/OpenNoteBlockStudio','_blank','noopener'),reportBug:()=>window.open('https://github.com/sitbat/NoteBlockStudio-Web/issues','_blank','noopener')};
  async function showMinecraft(initialFormat){
    h.modal('Minecraft 导出与导入',`<label>格式<select id="mcFormat"><option value="schematic">传统 .schematic</option><option value="structure">结构方块 .nbt</option><option value="branch">分支音序结构</option><option value="track">轨道结构</option><option value="datapack">数据包 .zip</option></select></label><label>布局<select id="mcLayout"><option value="circular">循环形</option><option value="simple">直线</option><option value="classic">经典</option></select></label><label>方向<select id="mcDirection"><option>N</option><option>E</option><option>S</option><option>W</option></select></label><label>红石速度<select id="mcTempo"><option>10</option><option>5</option><option>2.5</option></select></label><label class="inline-label">每行中继器<input id="mcRows" type="number" min="5" max="100" value="16"></label><label class="inline-label">包含锁定图层<input id="mcLocked" type="checkbox" checked></label><label class="inline-label">命令方块<input id="mcCommand" type="checkbox"></label><label class="inline-label">循环<input id="mcLoop" type="checkbox"></label><label>命名空间<input id="mcNamespace" value="nbs_song" pattern="[a-z0-9_]+"></label><label>Minecraft 版本<select id="mcVersion"><option value="1.21">1.21</option><option value="1.20">1.20</option><option value="1.13">1.13</option></select></label><label>数据包可视化<select id="mcVisualizer"><option value="none">关闭</option>${Array.from({length:7},(_,i)=>`<option value="${i}">可视化 ${i+1}</option>`).join('')}</select></label><details><summary>更多原版导出选项</summary><div id="mcAdvancedFields"></div></details><p id="mcResult"></p><button id="mcImport">从 .schematic / .nbt / 数据包导入…</button>`,`<button class="primary-button" id="mcExport">导出</button>`);
    if(['schematic','track','branch','datapack','structure'].includes(initialFormat))$('mcFormat').value=initialFormat;
    import('./minecraft.js').then(({MINECRAFT_OPTIONS})=>{if(!$('mcAdvancedFields'))return;const basic=new Set(['format','layout','direction','tempo','repeatersPerRow','includeLocked','commandBlocks','loop','namespace','mcVersion','visualizer']);$('mcAdvancedFields').innerHTML=Object.entries(MINECRAFT_OPTIONS).filter(([key])=>!basic.has(key)).map(([key,o])=>{const value=o.default??'',attributes=`data-mc-option="${key}"`;if(o.values)return `<label>${esc(o.label)}<select ${attributes}>${o.values.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;if(typeof value==='boolean')return `<label class="inline-label">${esc(o.label)}<input ${attributes} type="checkbox" ${value?'checked':''}></label>`;if(o.example)return `<label>${esc(o.label)}（JSON）<textarea ${attributes} data-json="true" placeholder="${esc(JSON.stringify(o.example))}"></textarea></label>`;return `<label class="inline-label">${esc(o.label)}<input ${attributes} type="${typeof value==='number'||o.default===undefined?'number':'text'}" value="${value}" ${o.min===undefined?'':`min="${o.min}"`} ${o.max===undefined?'':`max="${o.max}"`}></label>`;}).join('');const nameField=document.querySelector('[data-mc-option="name"]');if(nameField)nameField.value=h.getSong().title.toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'')||'song';}).catch(h.error);
    $('mcExport').onclick=run(async()=>{const {exportMinecraft}=await import('./minecraft.js'),advanced={};for(const field of document.querySelectorAll('[data-mc-option]')){if(field.type==='number'&&field.value==='')continue;let value=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value;if(field.dataset.json==='true'){if(!value.trim())continue;value=JSON.parse(value);}advanced[field.dataset.mcOption]=value;}const result=await exportMinecraft(h.getSong(),{...advanced,format:$('mcFormat').value,layout:$('mcLayout').value,direction:({N:'north',E:'east',S:'south',W:'west'})[$('mcDirection').value],tempo:Number($('mcTempo').value),repeatersPerRow:Number($('mcRows').value),includeLocked:$('mcLocked').checked,commandBlocks:$('mcCommand').checked,loop:$('mcLoop').checked,namespace:$('mcNamespace').value,version:$('mcVersion').value,visualizer:$('mcVisualizer').value});h.download(result.bytes,result.filename,result.mime);if($('mcResult'))$('mcResult').textContent=[JSON.stringify(result.summary||{}),...(result.warnings||[])].join('\n');});
    $('mcImport').onclick=()=>chooseFile('.schematic,.nbt,.zip',async file=>{if(file.size>128*1024*1024)throw new Error('Minecraft 文件超过 128 MB。');const {importMinecraft}=await import('./minecraft.js'),result=await importMinecraft(new Uint8Array(await file.arrayBuffer()),{filename:file.name,tempo:Number($('mcTempo').value),direction:({N:'north',E:'east',S:'south',W:'west'})[$('mcDirection').value]});close();h.confirmReplace(()=>{h.replaceSong(result.song);notify((result.warnings||[]).join('；')||'Minecraft 文件已导入');});});
    $('mcResult').insertAdjacentHTML('beforebegin','<div class="feature-actions"><button id="mcExtendedPack">扩展音域资源包</button><button id="mcTexturePack">可视化材质资源包</button><button id="mcCustomPack">自定义采样资源包</button></div>');
    $('mcResult').insertAdjacentHTML('beforebegin','<p>结构、数据包和资源包都在当前浏览器中生成。自定义采样会在浏览器编码为 OGG，不上传到服务器。</p>');
    const savePack=async kind=>{const {buildBundledResourcePack}=await import('./minecraft.js'),result=await buildBundledResourcePack(kind,{mcVersion:$('mcVersion').value});h.download(result.bytes,result.filename,'application/zip');};
    $('mcExtendedPack').onclick=run(()=>savePack('extended'));$('mcTexturePack').onclick=run(()=>savePack('textures'));
    $('mcCustomPack').onclick=run(async()=>{
      await loadBrowserCodecs({onProgress:codecProgress('mcResult')});
      const song=h.getSong(),samples=new Map(),{buildCustomResourcePack}=await import('./minecraft.js');
      for(const [index,buffer] of await projectSamples()){
        const definition=song.customInstruments[index];if(!definition)continue;
        const baseRate=2**(((definition.key??45)-45)/12),variants={};
        for(const [key,rate] of [['bytes',1],['lower',.25],['upper',4]]){
          const progress=`正在转换 ${definition.name} 的 Minecraft OGG 采样（${{bytes:'原音域',lower:'低音域',upper:'高音域'}[key]}）`;
          if($('mcResult'))$('mcResult').textContent=`${progress}，浏览器重采样…`;
          const wav=encodeWav(await resampleMono(buffer,{playbackRate:baseRate*rate,sampleRate:48000}));
          const output=await encodeAudio(wav,{format:'ogg',rate:48000,channels:1,onProgress:codecProgress('mcResult',`${progress}；`)});
          variants[key]=new Uint8Array(await output.arrayBuffer());
        }samples.set(index,variants);
      }
      const result=await buildCustomResourcePack(song,samples,{namespace:document.querySelector('[data-mc-option="customNamespace"]')?.value||'minecraft',mcVersion:$('mcVersion').value});h.download(result.bytes,result.filename,'application/zip');if($('mcResult'))$('mcResult').textContent=[`已导出 ${result.summary.sounds} 个自定义音色，含扩展八度。`,...(result.warnings||[])].join('\n');
    });
  }
  const api={actions,midi,rememberProject,preferences:prefs,applyPrefs,toggleMidiRecord:run(toggleMidiRecord),importBundle,importMidi,configureMidiImport:(onApply,initialOptions)=>importMidi({name:'音频转录映射',size:0},{settingsOnly:true,onApply,initialOptions}),
    async importPattern(file){const pattern=parseNBP(await file.arrayBuffer(),{customInstrumentCount:h.getSong().customInstruments.length}),cursor=h.getState();commit(song=>insertPattern(song,pattern,{tick:Math.floor(cursor.tick),layer:cursor.layer}));notify('NBP 图案已插入');},
    async sampleDataForSave(){const snapshot=snapshotSampleBank(engine.customSamples,sampleIdentity);return snapshot;},
    samplesSaved(snapshot){if(snapshot)sampleIdentity=snapshot.identity;},
    async restoreSamples(){const saved=await h.store.loadSamples();engine.customSamples=restoreSampleBank(saved,{maxIndex:h.getSong().customInstruments.length});sampleIdentity=new Map(engine.customSamples);},
    async startup(){applyPrefs();},
    destroy(){midi.disconnect();engine.stopLive?.();}

  };return api;
}
