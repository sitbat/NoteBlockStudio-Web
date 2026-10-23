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

const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function loadEditorPreferences(){
  const defaults={theme:'light',colors:true,shapes:false,numbers:true,octaves:false,showLayers:true,showPiano:true,keyNames:true,keyboardInput:false,keysmax:30,follow:true,fade:true,flat:false,bpm:false,scale:100};
  try{return {...defaults,...JSON.parse(localStorage.getItem('nbs-web-preferences-v3')||'{}')};}catch{return defaults;}
}
export function installFeatureUI(h){
  const engine=h.getEngine(),prefs=h.preferences,run=fn=>async(...args)=>{try{return await fn(...args);}catch(error){h.error(error);}},name=()=>String(h.getSong().title||'project').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  let sampleIdentity=new Map(),midiSession=false,midiDevices=[],taps=[];
  const notify=message=>h.toast(message),close=()=>$('modal').close();
  function applyPrefs(){
    document.body.classList.toggle('theme-dark',prefs.theme==='dark'||prefs.theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);
    document.body.classList.toggle('hide-layer-pane',!prefs.showLayers);document.body.classList.toggle('hide-piano',!prefs.showPiano);
    document.documentElement.style.setProperty('--accent',prefs.accent||'#0078d4');
    document.documentElement.style.setProperty('--editor-font-scale',`${Math.min(150,Math.max(75,Number(prefs.scale)||100))/100}`);
    h.resize();h.scheduleDraw();
  }
  function commit(operation){if(h.isBusy())throw new Error('请先停止性能测试或等待当前操作结束。');h.checkpoint();const result=operation(h.getSong());if(result?.selectedIds)h.setSelected(result.selectedIds);else if(Array.isArray(result))h.setSelected(result);h.refresh({save:true});return result;}
  function chooseFile(accept,callback){const input=document.createElement('input');input.type='file';input.accept=accept;input.onchange=run(async()=>{const file=input.files[0];if(file)await callback(file);});input.click();}
  const selected=()=>[...h.getSelected()];
  async function projectSamples(){await engine.init();const bank=new Map(engine.customSamples);h.getSong().customInstruments.forEach((definition,index)=>{const buffer=engine.bundledCustomSamples.get(bundledCustomFile(definition.file));if(!bank.has(index)&&buffer)bank.set(index,buffer);});return bank;}

  function showMacros(){
    h.modal('宏与音乐编辑',`<p>对已选择的音符执行原版编辑算法；音轨锁定仍生效。</p><label>操作<select id="macroType">${EDITOR_TOOLS.map(t=>`<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select></label><div id="macroFields"></div><p>已选择 ${selected().length.toLocaleString()} 个音符。</p>`,`<button class="secondary-button" data-close>取消</button><button class="primary-button" id="applyMacro">应用</button>`);
    const fields=()=>{const tool=EDITOR_TOOLS.find(t=>t.id===$('macroType').value);$('macroFields').innerHTML=tool.options.map(o=>`<label class="${o.type==='boolean'?'inline-label':''}">${esc(o.label)}<input data-option="${o.name}" type="${o.type==='boolean'?'checkbox':o.type==='number'?'number':'text'}" ${o.type==='boolean'?(o.default?'checked':''):`value="${esc(o.default)}"`} ${o.min===undefined?'':`min="${o.min}" max="${o.max}"`}></label>`).join('');};fields();$('macroType').onchange=fields;
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
  function showPreferences(){
    const checks={colors:'使用原版音符颜色',shapes:'形状显示',numbers:'音符盒数字',octaves:'音符八度',showLayers:'显示图层面板',showPiano:'显示钢琴',keyNames:'显示琴键名称',keyboardInput:'电脑键盘弹奏（Z–M / Q–U）',follow:'播放时跟随光标',fade:'按力度淡化音符',flat:'使用降号名称',bpm:'速度以 BPM 输入'};
    h.modal('偏好设置',`<label>主题<select id="prefTheme"><option value="light">Fluent 浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><div class="preferences-grid">${Object.entries(checks).map(([key,label])=>`<label class="inline-label">${label}<input data-pref="${key}" type="checkbox" ${prefs[key]?'checked':''}></label>`).join('')}</div><label class="inline-label">可见白键数<input id="prefKeys" type="number" min="7" max="52" value="${prefs.keysmax}"></label><label class="inline-label">强调色<input id="prefAccent" type="color" value="${prefs.accent||'#0078d4'}"></label>`,`<button class="primary-button" id="prefApply">保存</button>`);$('prefTheme').value=prefs.theme;
    $('prefApply').onclick=run(()=>{prefs.theme=$('prefTheme').value;for(const key of Object.keys(checks))prefs[key]=document.querySelector(`[data-pref="${key}"]`).checked;prefs.keysmax=Math.min(52,Math.max(7,Number($('prefKeys').value)||30));prefs.accent=$('prefAccent').value;localStorage.setItem('nbs-web-preferences-v3',JSON.stringify(prefs));applyPrefs();h.refresh();close();});
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
    h.modal('从链接打开曲谱',`<label>NBS / MIDI / JSON 链接<input id="songURL" type="url" value="${esc(initial)}" placeholder="https://…/song.nbs"></label><p>点击读取后，浏览器直接读取 HTTP(S) 链接，来源网站须允许跨域访问（CORS）。读取失败时，可先下载曲谱，再用文件选择器或拖放导入。支持解析 nbs:// 包装的曲谱链接。</p>`,`<button class="primary-button" id="urlApply">读取曲谱</button>`);
    $('urlApply').onclick=run(async()=>{const button=$('urlApply');button.disabled=true;try{const result=await fetchSongInBrowser($('songURL').value);close();await h.loadFile(new File([result.bytes],result.filename,{type:result.mime}));}finally{if(button.isConnected)button.disabled=false;}});
  }
  function importMidi(file){
    if(file.size>128*1024*1024)throw new Error('MIDI 文件超过 128 MB。');const programMap={},percussionMap={},definitions=h.getSong().customInstruments;
    h.modal('MIDI 导入设置',`<p>${esc(file.name)}：按真实时间转换速度变化，再放入可编辑的音符盒网格。</p><label class="inline-label">目标速度 ticks/s（0 为自动）<input id="midiImportTempo" type="number" min="0" max="655.35" step="0.01" value="0"></label><label>网格精度<select id="midiImportGrid">${[1,2,4,8,16].map(n=>`<option value="${n}">${n} 倍</option>`).join('')}</select></label><label class="inline-label">八度偏移<input id="midiImportOctave" type="number" min="-8" max="8" value="0"></label><label class="inline-label">最大图层数<input id="midiImportLayers" type="number" min="1" max="65535" value="65535"></label>${[['Velocity','保留力度'],['Pan','保留声像'],['Names','使用 MIDI 轨道名'],['Silent','移除开头空白']].map(([id,label])=>`<label class="inline-label">${label}<input type="checkbox" id="midiImport${id}" checked></label>`).join('')}<label class="inline-label">折叠到音符盒音域<input id="midiImportFold" type="checkbox"></label><details><summary>乐器与打击乐映射</summary><label>类别<select id="midiMappingKind"><option value="program">GM 音色 Program</option><option value="drum">打击乐 MIDI 音高</option></select></label><label class="inline-label">编号（0–127）<input id="midiMappingNumber" type="number" min="0" max="127" value="0"></label><label>转换为<select id="midiMappingTarget"><option value="-2">默认映射</option><option value="-1">忽略</option>${[...INSTRUMENTS,...definitions.map((i,id)=>({id:16+id,name:i.name}))].map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></label><label class="inline-label">该音色八度偏移<input id="midiMappingOctave" type="number" min="-8" max="8" value="0"></label><label class="inline-label">打击乐目标音高<input id="midiMappingKey" type="number" min="0" max="87" value="45"></label><div class="feature-actions"><button id="midiMappingSave">保存这条映射</button><button id="midiNativeMapping">使用原版 GM 预设</button><button id="midiResetMapping">重置映射</button></div><p id="midiMappingStatus"></p></details><p id="midiImportStatus"></p>`,`<button id="midiImportApply" class="primary-button">导入</button>`);
    $('midiMappingSave').onclick=()=>{const index=Number($('midiMappingNumber').value),target=Number($('midiMappingTarget').value),kind=$('midiMappingKind').value,map=kind==='program'?programMap:percussionMap;if(!Number.isInteger(index)||index<0||index>127){h.error(new Error('映射编号必须是 0–127。'));return;}if(target===-2)delete map[index];else map[index]=target===-1?-1:{instrument:target,...(kind==='program'?{octave:Number($('midiMappingOctave').value)}:{key:Number($('midiMappingKey').value)})};$('midiMappingStatus').textContent=`已保存 ${Object.keys(programMap).length} 条音色映射、${Object.keys(percussionMap).length} 条打击乐映射`;};
    $('midiNativeMapping').onclick=()=>{for(const key of Object.keys(programMap))delete programMap[key];for(const key of Object.keys(percussionMap))delete percussionMap[key];Object.assign(programMap,structuredClone(MIDI_PROGRAM_DEFAULTS));Object.assign(percussionMap,structuredClone(MIDI_PERCUSSION_DEFAULTS));$('midiMappingStatus').textContent='已载入原版 128 种 GM 音色和 64 个鼓音映射，包含八度补偿';};
    $('midiResetMapping').onclick=()=>{for(const key of Object.keys(programMap))delete programMap[key];for(const key of Object.keys(percussionMap))delete percussionMap[key];$('midiMappingStatus').textContent='已恢复自动映射';};
    $('midiImportApply').onclick=run(async()=>{const options={gridSubdivision:Number($('midiImportGrid').value),octaveOffset:Number($('midiImportOctave').value),maxLayers:Number($('midiImportLayers').value),keepVelocity:$('midiImportVelocity').checked,keepPan:$('midiImportPan').checked,trackNames:$('midiImportNames').checked,removeSilent:$('midiImportSilent').checked,keepWithinOctaveRange:$('midiImportFold').checked,programMap,percussionMap,customInstruments:definitions};const tempo=Number($('midiImportTempo').value);if(tempo>0)options.targetTempo=tempo;const song=await h.store.parse(file,message=>{if($('midiImportStatus'))$('midiImportStatus').textContent=message;},options),bank=new Map(engine.customSamples);close();h.confirmReplace(()=>{h.replaceSong(song);engine.customSamples=bank;h.persist();notify(`MIDI 已导入 · ${song.notes.length} 个音符`);});});
  }
  function codecProgress(id,prefix=''){
    return update=>{const target=$(id);if(target)target.textContent=`${prefix}${update.stage==='load'?'正在加载浏览器编码器':'浏览器正在编码'}${Number.isFinite(update.progress)?` · ${Math.round(Math.min(1,Math.max(0,update.progress))*100)}%`:''}…`;};
  }
  function showAudioExport(){
    h.modal('音频导出',`<label>格式<select id="audioFormat"><option value="wav">WAV</option><option value="mp3">MP3</option><option value="flac">FLAC</option><option value="aiff">AIFF</option><option value="ogg">OGG Vorbis</option></select></label><label>采样率<select id="audioRate">${[8000,11025,16000,22050,44100,48000,88200,96000,176400,192000,352800,384000].map(rate=>`<option ${rate===(engine.context?.sampleRate||48000)?'selected':''}>${rate}</option>`).join('')}</select></label><label>通道<select id="audioChannels"><option value="2">立体声</option><option value="1">单声道</option></select></label><label class="inline-label">包括锁定音轨<input id="audioLocked" type="checkbox" checked></label><label class="inline-label">MP3 码率（kbps）<input id="audioBitrate" type="number" min="32" max="320" value="320"></label><p>音频在当前浏览器中渲染和编码，不上传到服务器。原采样率立体声 WAV 直接生成；其他格式首次使用时会加载网站自带的编码器。</p><p id="audioProgress">准备就绪</p>`,`<button class="primary-button" id="audioRender">导出</button>`);
    $('audioRender').onclick=run(async()=>{const button=$('audioRender');button.disabled=true;try{const format=$('audioFormat').value,rate=Number($('audioRate').value),channels=Number($('audioChannels').value),bitrate=Number($('audioBitrate').value),original=h.getSong(),song=$('audioLocked').checked?original:{...original,layers:original.layers.map(layer=>({...layer,muted:layer.muted||layer.locked}))};codecArguments({format,rate,channels,bitrate});await engine.init();const transcode=format!=='wav'||channels!==2||rate!==engine.context.sampleRate;if(transcode)await loadBrowserCodecs({onProgress:codecProgress('audioProgress')});$('audioProgress').textContent='浏览器 Rust 正在渲染…';let output=await engine.exportWav(song,{masterVolume:Number($('masterVolume').value)/100});if(transcode)output=await encodeAudio(output,{format,rate,channels,bitrate,onProgress:codecProgress('audioProgress')});h.download(output,`${name()}.${format}`);if($('audioProgress'))$('audioProgress').textContent=`导出完成 · ${(output.size/1048576).toFixed(2)} MB`;}finally{if(button.isConnected)button.disabled=false;}});
  }
  const midi=new MidiInputController({
    onNote:note=>{const cursor=h.getState(),config=midi.devices.get(note.device);engine.triggerLive({...note,instrument:config?.instrument>=0?config.instrument:cursor.instrument},{channel:note.channel,layer:h.getSong().layers[cursor.layer]}).catch(h.error);},
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
    midi.startRecording({mode:$('midiMode')?.value||'realtime',tick:Math.floor(cursor.tick),tempo:h.getSong().tempo,snap:cursor.snap,instrument:cursor.instrument,layer:cursor.layer,clockTick:engine.playing?()=>engine.currentTick:undefined});
    $('recordMidiBtn')?.classList.add('active');notify('MIDI 录制已开始；再次点击录制按钮停止');
  }
  function showMidi(){
    h.modal('MIDI 设备与录制',`<p>可同时接收多个输入设备。支持力度、通道音量、声像、弯音和延音踏板；音符盒试听按采样自然长度播放。</p><div id="midiDevices"></div><label>录制方式<select id="midiMode"><option value="realtime">实时录制，按网格量化</option><option value="step">步进录制，松开和弦后前进一步</option></select></label><div class="feature-actions"><button id="midiConnect">授权并刷新设备</button><button id="midiDisconnect">断开 MIDI</button><button id="midiRecord">${midi.recording?'停止录制':'开始录制'}</button></div><p>浏览器权限只在你点击授权后申请。录制按钮也位于播放工具栏。</p>`);renderMidiDevices();
    $('midiConnect').onclick=run(async()=>{await engine.init();await midi.connect();notify('MIDI 设备已刷新');});
    $('midiDisconnect').onclick=run(async()=>{await midi.disconnect();engine.stopLive();$('recordMidiBtn')?.classList.remove('active');});
    $('midiRecord').onclick=run(()=>{toggleMidiRecord();if(midi.recording)close();else $('midiRecord').textContent='开始录制';});
  }
  function showCustomInstruments(){
    const song=h.getSong();h.modal('自定义乐器管理',`<label>乐器<select id="customEditIndex">${song.customInstruments.map((i,id)=>`<option value="${id}">${id+16}: ${esc(i.name)}</option>`).join('')}</select></label><div id="customEditFields"></div><p>添加或重新加载音频仍可使用工具栏的自定义乐器按钮。完整工程包包含音频，本地自动保存也会保存已加载的 PCM。</p>`,`<button class="primary-button" id="customEditApply">保存</button>`);
    const fields=()=>{const i=song.customInstruments[Number($('customEditIndex').value)];$('customEditFields').innerHTML=i?`<label>名称<input id="customName" value="${esc(i.name)}"></label><label>文件引用<input id="customFile" value="${esc(i.file)}"></label><label class="inline-label">基准音高<input id="customKey" type="number" min="0" max="87" value="${i.key??45}"></label><label class="inline-label">按键音效<input id="customPress" type="checkbox" ${i.pressKey?'checked':''}></label>`:'<p>请先添加一个自定义音色。</p>';$('customEditApply').disabled=!i;};fields();$('customEditIndex').onchange=fields;
    $('customEditApply').onclick=run(()=>{const index=Number($('customEditIndex').value);commit(current=>{Object.assign(current.customInstruments[index],{name:$('customName').value.slice(0,1024),file:$('customFile').value.slice(0,4096),key:Math.max(0,Math.min(87,Number($('customKey').value)||0)),pressKey:$('customPress').checked});});engine.customInstruments=h.getSong().customInstruments;h.renderRack();close();});
  }
  function showLayerTools(){
    h.modal('图层管理',`<label>操作<select id="layerOperation"><option value="up">当前图层上移</option><option value="down">当前图层下移</option><option value="insert">在当前图层前插入</option><option value="duplicate">复制当前图层及音符</option><option value="remove-empty">删除空图层</option></select></label>`,`<button id="layerOperationApply" class="primary-button">应用</button>`);
    $('layerOperationApply').onclick=run(()=>{const operation=$('layerOperation').value;commit(song=>{const result=applyLayerOperation(song,{operation,index:h.getState().layer});h.getState().layer=result.layer;return result;});close();});
  }
  function showStatistics(){const song=h.getSong(),counts=new Map();for(const note of song.notes)counts.set(note.instrument,(counts.get(note.instrument)||0)+1);h.modal('曲谱统计',`<p>${song.layers.length.toLocaleString()} 条图层 · ${song.notes.length.toLocaleString()} 个音符 · ${(song.length/song.tempo).toFixed(2)} 秒</p><p>已开启混响：${song.layers.filter(l=>l.reverb>0).length} 轨；静音：${song.layers.filter(l=>l.muted).length} 轨；锁定：${song.layers.filter(l=>l.locked).length} 轨。</p><table><thead><tr><th>音色</th><th>音符数</th></tr></thead><tbody>${[...counts].map(([id,count])=>`<tr><td>${esc(INSTRUMENTS[id]?.name||song.customInstruments[id-16]?.name||id)}</td><td>${count}</td></tr>`).join('')}</tbody></table>`);}
  function showTempoTap(){taps=[];h.modal('敲击测速',`<p>连续点击或按空格，计算相邻敲击的中位间隔。</p><button class="primary-button" id="tempoTap">敲击</button><p id="tempoTapResult">至少敲击两次。</p>`,`<button class="primary-button" id="tempoTapApply" disabled>应用速度</button>`);let tempo=10;const tap=()=>{const now=performance.now();if(taps.length&&now-taps.at(-1)>3000)taps=[];taps.push(now);if(taps.length>12)taps.shift();if(taps.length>1){const intervals=taps.slice(1).map((x,i)=>x-taps[i]).sort((a,b)=>a-b),ms=intervals[Math.floor(intervals.length/2)];tempo=Math.min(655.35,Math.max(.05,4000/ms));$('tempoTapResult').textContent=`${(60000/ms).toFixed(1)} BPM · ${tempo.toFixed(2)} ticks/s`;$('tempoTapApply').disabled=false;}};$('tempoTap').onclick=tap;$('tempoTap').onkeydown=e=>{if(e.code==='Space'){e.preventDefault();tap();}};$('tempoTapApply').onclick=()=>{commit(song=>song.tempo=tempo);close();};}
  function showSystem(){
    const state=getBrowserCodecState(),labels={idle:'首次导出时加载',loading:'正在加载',ready:'已就绪',encoding:'正在编码',error:'上次编码失败，可重新尝试'};
    h.modal('浏览器运行信息',`<p>Web 版 4.0.0 · 纯静态网站</p><p>编辑、Rust/WASM 多核播放、每轨混响、音频编码和自动保存都在当前浏览器中运行。工程和音频不会上传到服务器。</p><p>浏览器编码器：${esc(labels[state.state]||state.state||'按需加载')}。支持 MP3、FLAC、AIFF、OGG 和 WAV。</p><p>MIDI 设备在您主动授权后连接。浏览器不直接安装系统文件关联、连接 Discord 桌面活动、读取命令行指定路径或替换本机程序文件。</p><p>重要作品请下载包含自定义采样的完整工程包。</p>`,`<button class="primary-button" id="systemClose">关闭</button>`);$('systemClose').onclick=close;
  }

  const actions={macros:run(showMacros),patterns:run(showPatterns),chords:run(showChord),selectionTools:run(showSelection),preferences:run(showPreferences),backups:run(showBackups),saveProject:run(async()=>h.download(await writeProjectBundle(h.getSong(),await projectSamples()),`${name()}.nbpz`,'application/zip')),openURL:run(()=>showOpenURL()),audioExport:run(showAudioExport),midi:run(showMidi),layerTools:run(showLayerTools),instruments:run(showCustomInstruments),statistics:run(showStatistics),tempoTap:run(showTempoTap),system:run(showSystem),minecraft:run(async()=>showMinecraft())};
  async function showMinecraft(){
    h.modal('Minecraft 导出与导入',`<label>格式<select id="mcFormat"><option value="schematic">传统 .schematic</option><option value="structure">结构方块 .nbt</option><option value="branch">分支音序结构</option><option value="track">轨道结构</option><option value="datapack">数据包 .zip</option></select></label><label>布局<select id="mcLayout"><option value="circular">循环形</option><option value="simple">直线</option><option value="classic">经典</option></select></label><label>方向<select id="mcDirection"><option>N</option><option>E</option><option>S</option><option>W</option></select></label><label>红石速度<select id="mcTempo"><option>10</option><option>5</option><option>2.5</option></select></label><label class="inline-label">每行中继器<input id="mcRows" type="number" min="5" max="100" value="16"></label><label class="inline-label">包含锁定图层<input id="mcLocked" type="checkbox" checked></label><label class="inline-label">命令方块<input id="mcCommand" type="checkbox"></label><label class="inline-label">循环<input id="mcLoop" type="checkbox"></label><label>命名空间<input id="mcNamespace" value="nbs_song" pattern="[a-z0-9_]+"></label><label>Minecraft 版本<select id="mcVersion"><option value="1.21">1.21</option><option value="1.20">1.20</option><option value="1.13">1.13</option></select></label><label>数据包可视化<select id="mcVisualizer"><option value="none">关闭</option>${Array.from({length:7},(_,i)=>`<option value="${i}">可视化 ${i+1}</option>`).join('')}</select></label><details><summary>更多原版导出选项</summary><div id="mcAdvancedFields"></div></details><p id="mcResult"></p><button id="mcImport">从 .schematic / .nbt / 数据包导入…</button>`,`<button class="primary-button" id="mcExport">导出</button>`);
    import('./minecraft.js').then(({MINECRAFT_OPTIONS})=>{if(!$('mcAdvancedFields'))return;const basic=new Set(['format','layout','direction','tempo','repeatersPerRow','includeLocked','commandBlocks','loop','namespace','mcVersion','visualizer']);$('mcAdvancedFields').innerHTML=Object.entries(MINECRAFT_OPTIONS).filter(([key])=>!basic.has(key)).map(([key,o])=>{const value=o.default??'',attributes=`data-mc-option="${key}"`;if(o.values)return `<label>${esc(o.label)}<select ${attributes}>${o.values.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;if(typeof value==='boolean')return `<label class="inline-label">${esc(o.label)}<input ${attributes} type="checkbox" ${value?'checked':''}></label>`;if(o.example)return `<label>${esc(o.label)}（JSON）<textarea ${attributes} data-json="true" placeholder="${esc(JSON.stringify(o.example))}"></textarea></label>`;return `<label class="inline-label">${esc(o.label)}<input ${attributes} type="${typeof value==='number'||o.default===undefined?'number':'text'}" value="${value}" ${o.min===undefined?'':`min="${o.min}"`} ${o.max===undefined?'':`max="${o.max}"`}></label>`;}).join('');}).catch(h.error);
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
  return {actions,midi,preferences:prefs,applyPrefs,toggleMidiRecord:run(toggleMidiRecord),importBundle,importMidi,
    async importPattern(file){const pattern=parseNBP(await file.arrayBuffer(),{customInstrumentCount:h.getSong().customInstruments.length}),cursor=h.getState();commit(song=>insertPattern(song,pattern,{tick:Math.floor(cursor.tick),layer:cursor.layer}));notify('NBP 图案已插入');},
    async sampleDataForSave(){const snapshot=snapshotSampleBank(engine.customSamples,sampleIdentity);return snapshot;},
    samplesSaved(snapshot){if(snapshot)sampleIdentity=snapshot.identity;},
    async restoreSamples(){const saved=await h.store.loadSamples();engine.customSamples=restoreSampleBank(saved,{maxIndex:h.getSong().customInstruments.length});sampleIdentity=new Map(engine.customSamples);},
    async startup(){applyPrefs();},
    destroy(){midi.disconnect();engine.stopLive?.();}

  };
}
