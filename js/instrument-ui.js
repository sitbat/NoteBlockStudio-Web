/** Instrument dialogs and selected-file imports. No filesystem, installation lookup or network access. */
import {INSTRUMENTS,bundledCustomFile} from './audio.js';
import {parseNBS} from './formats.js';
import {readProjectBundle} from './project-bundle.js';
import {removeInstrument,moveInstrument,importInstrumentDefinitions,exportInstrumentBundle,MAX_CUSTOM_INSTRUMENTS} from './instrument-tools.js';

const MiB=1024*1024,esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const aliases=[['harp'],['dbass','bass'],['bdrum','basedrum','bd'],['sdrum','snare'],['click','hat'],['guitar'],['flute'],['bell'],['icechime','chime'],['xylobone','xylophone'],['iron_xylophone'],['cow_bell'],['didgeridoo'],['bit'],['banjo'],['pling']];
const builtinName=index=>`${INSTRUMENTS[index].englishName} · ${INSTRUMENTS[index].name}`;
export function builtinForSound(path){const name=String(path).replace(/\\/g,'/').split('/').at(-1).toLowerCase().replace(/\.ogg$/,'');return aliases.findIndex(names=>names.includes(name));}
function safeRelative(value){const path=String(value).replace(/\\/g,'/');if(!path||path.length>4096||path.startsWith('/')||/^[a-z]:/i.test(path)||/[\x00-\x1f\x7f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('所选文件包含无效的相对路径。');return path;}
const selectedPath=file=>safeRelative(file.webkitRelativePath||file.name);
const assertCurrent=isCurrent=>{if(isCurrent&&!isCurrent())throw new DOMException('音色导入已被新的项目或操作替代。','AbortError');};
function validPCM(buffer){if(!buffer||!Number.isSafeInteger(buffer.length)||buffer.length<1||!Number.isInteger(buffer.numberOfChannels)||buffer.numberOfChannels<1||buffer.numberOfChannels>32||!Number.isFinite(buffer.sampleRate)||buffer.sampleRate<8000||buffer.sampleRate>384000||buffer.length*buffer.numberOfChannels>32*MiB||typeof buffer.getChannelData!=='function')throw new Error('解码后的音色过大或 PCM 无效。');return buffer;}

/** GML sound_import.gml: indexes/*.json -> objects/<hash prefix>/<hash>; never fetch missing objects. */
export async function resolveSoundImport(input,{folder=false,assetIndexPath='',soundMode='noteblock'}={}){
  if(!['noteblock','all'].includes(soundMode))throw new Error('音效导入模式必须为 noteblock 或 all。');
  const files=Array.from(input||[]);if(files.length>100000)throw new Error('选择的文件过多；请只选择 Minecraft assets 或音效目录。');
  const paths=files.map(file=>({file,path:selectedPath(file)})),indexes=paths.filter(({path})=>/(?:^|\/)indexes\/[^/]+\.json$/i.test(path)).sort((a,b)=>b.path.localeCompare(a.path,undefined,{numeric:true}));
  const candidates=[],warnings=[];let missing=0;
  if(indexes.length){
    const selected=assetIndexPath?indexes.find(entry=>entry.path===assetIndexPath):indexes[0];if(!selected)throw new Error('所选资源索引不在本次授权的文件中。');
    if(selected.file.size>16*MiB)throw new Error('Minecraft 资源索引超过 16 MiB。');
    let index;try{index=JSON.parse(await selected.file.text());}catch{throw new Error('Minecraft 资源索引不是有效 JSON。');}
    if(!index?.objects||typeof index.objects!=='object'||Array.isArray(index.objects)||Object.keys(index.objects).length>100000)throw new Error('Minecraft 资源索引 objects 字段无效或过大。');
    const objects=new Map();for(const entry of paths){const hash=entry.path.split('/').at(-1).toLowerCase();if(/^[a-f0-9]{40}$/.test(hash)&&new RegExp(`(?:^|/)objects/${hash.slice(0,2)}/${hash}$`,'i').test(entry.path))objects.set(hash,entry.file);}
    for(const [path,value]of Object.entries(index.objects)){
      if(!path.startsWith('minecraft/sounds/')||/(?:^|\/)(?:music|records)\//.test(path)||!path.endsWith('.ogg'))continue;
      safeRelative(path);const builtin=builtinForSound(path);if(builtin<0&&soundMode!=='all')continue;
      if(!value||!/^([a-f0-9]{40})$/i.test(value.hash)||!Number.isSafeInteger(value.size)||value.size<1||value.size>32*MiB)throw new Error('Minecraft 音色索引包含无效的哈希或文件大小。');
      const file=objects.get(value.hash.toLowerCase());if(!file){missing++;continue;}if(file.size!==value.size)throw new Error(`Minecraft 音色对象大小不匹配：${path}`);
      candidates.push({file,path,name:builtin>=0?builtinName(builtin):path.slice('minecraft/sounds/'.length).replace(/\.ogg$/i,''),fileName:path.replace('minecraft/sounds/','minecraft/'),builtin,assetHash:value.hash.toLowerCase()});
    }
    if(soundMode==='all')candidates.sort((a,b)=>(a.builtin<0)-(b.builtin<0)||a.builtin-b.builtin||a.path.localeCompare(b.path));
    if(missing)warnings.push(`${missing} 个${soundMode==='all'?'游戏音效':'音符盒采样'}的哈希对象未包含在所选文件夹中，未读取这些采样。`);
    return{candidates,indexes:indexes.map(entry=>entry.path),assetIndexPath:selected.path,soundMode,warnings};
  }
  for(const {file,path}of paths){if(!/\.ogg$/i.test(path)||/(?:^|\/)(?:music|records)\//i.test(path))continue;const builtin=builtinForSound(path);if(folder&&builtin<0&&soundMode!=='all')continue;candidates.push({file,path,name:builtin>=0?builtinName(builtin):folder?path.replace(/\.ogg$/i,''):file.name.replace(/\.ogg$/i,''),fileName:folder?path:file.name,builtin});}
  if(folder&&soundMode==='noteblock')warnings.push('文件夹模式当前只列出 16 种音符盒采样；可切换“全部非音乐游戏音效”选择其它 OGG。');
  if(folder&&soundMode==='all')candidates.sort((a,b)=>(a.builtin<0)-(b.builtin<0)||a.builtin-b.builtin||a.path.localeCompare(b.path));
  return{candidates,indexes:[],assetIndexPath:'',soundMode,warnings};
}

/** Decode everything into a staged project. Nothing touches the caller's song or sample bank. */
export async function stageSoundImport(song,samples,candidates,{decode,convertNative=false,isCurrent,onProgress=()=>{}}={}){
  if(!Array.isArray(candidates)||!candidates.length)throw new Error('请至少选择一个音效。');
  const remaining=Math.max(0,MAX_CUSTOM_INSTRUMENTS-song.customInstruments.length);
  if(candidates.length>remaining)throw new Error(`已选 ${candidates.length} 个音效，只剩 ${remaining} 个音色位置（最多 240 个）；请减少选择，未导入任何音色。`);
  if(typeof decode!=='function')throw new Error('音色解码器不可用。');
  let encoded=0,decoded=0;const definitions=[],sourceSamples=new Map(),nativeMap=new Map();
  for(let index=0;index<candidates.length;index++){
    assertCurrent(isCurrent);const candidate=candidates[index],file=candidate.file;
    if(!file||typeof file.arrayBuffer!=='function'||!Number.isSafeInteger(file.size)||file.size<1||file.size>32*MiB||(encoded+=file.size)>256*MiB)throw new Error('每个音效最多 32 MiB，本批编码文件总计最多 256 MiB。');
    onProgress(`正在解码 ${index+1}/${candidates.length}：${candidate.name}`);const bytes=await file.arrayBuffer();assertCurrent(isCurrent);
    if(!(bytes instanceof ArrayBuffer)||bytes.byteLength!==file.size)throw new Error('音色文件读取长度不匹配。');
    if(candidate.assetHash){if(!globalThis.crypto?.subtle)throw new Error('浏览器无法校验 Minecraft 对象哈希。');const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');if(actual!==candidate.assetHash)throw new Error(`Minecraft 音色对象哈希不匹配：${candidate.path}`);assertCurrent(isCurrent);}
    const buffer=validPCM(await decode(bytes.slice(0)));assertCurrent(isCurrent);decoded+=buffer.length*buffer.numberOfChannels*4;if(decoded>256*MiB)throw new Error('本批解码后的音色总计超过 256 MiB，未导入任何音色。');
    sourceSamples.set(index,buffer);definitions.push({name:String(candidate.name).slice(0,1024),file:safeRelative(candidate.fileName),key:45,pressKey:candidate.builtin>=0?![2,3,4].includes(candidate.builtin):false});
    if(candidate.builtin>=0&&!nativeMap.has(candidate.builtin))nativeMap.set(candidate.builtin,16+song.customInstruments.length+index);
  }
  assertCurrent(isCurrent);const staged={...song,customInstruments:song.customInstruments.slice(),notes:song.notes},result=importInstrumentDefinitions(staged,{customInstruments:definitions},{samples,sourceSamples});
  let convertedNotes=0;if(convertNative)staged.notes=staged.notes.map(note=>{const instrument=nativeMap.get(note.instrument);if(instrument===undefined)return note;convertedNotes++;return{...note,instrument};});
  return{song:staged,...result,convertedNotes,nativeMap};
}

export function createInstrumentManager(h){
  const $=id=>document.getElementById(id),engine=h.engine,notify=message=>h.toast?.(message),run=fn=>async(...args)=>{try{return await fn(...args);}catch(error){if(error.name!=='AbortError')h.error(error);}};
  let operation=0;
  const busy=()=>{if(h.getState?.()?.busy)throw new Error('请先完成当前操作或停止性能测试。');};
  const pauseAudio=()=>{h.stopPlayback?.(false);engine.stopLive?.();};
  const bankFor=song=>{const bank=new Map(engine.customSamples);song.customInstruments.forEach((definition,index)=>{const buffer=engine.bundledCustomSamples?.get(bundledCustomFile(definition.file));if(!bank.has(index)&&buffer)bank.set(index,buffer);});return bank;};
  const sync=(song,staged,result,oldBank)=>{pauseAudio();h.checkpoint(oldBank);song.customInstruments=staged.customInstruments;song.notes=staged.notes;engine.customSamples=result.samples;engine.customInstruments=song.customInstruments;const state=h.getState?.();if(state&&result.instrumentMap){const mapped=result.instrumentMap.get(state.instrument);state.instrument=mapped>=0?mapped:0;}if(result.instrumentMap)h.onInstrumentMap?.(result.instrumentMap);if(state?.selected&&result.removedNoteIds?.length){const removed=new Set(result.removedNoteIds);state.selected=new Set([...state.selected].filter(id=>!removed.has(id)));}h.renderRack();h.refresh({save:true});};
  const guard=(song,token,bank)=>()=>h.getSong()===song&&operation===token&&engine.customSamples.size===bank.size&&[...bank].every(([index,buffer])=>engine.customSamples.get(index)===buffer);
  function pick(accept,callback,{multiple=false,directory=false}={}){const input=document.createElement('input');input.type='file';input.accept=accept;input.multiple=multiple;if(directory)input.webkitdirectory=true;input.onchange=run(()=>input.files?.length?callback(Array.from(input.files)):undefined);input.click();}
  function open({index:initialIndex=0}={}){
    operation++;busy();pauseAudio();const song=h.getSong();
    h.modal('自定义乐器管理',`<label>乐器<select id="instrumentManagerIndex">${song.customInstruments.map((i,index)=>`<option value="${index}">${16+index}: ${esc(i.name)}</option>`).join('')}</select></label><div id="instrumentManagerFields"></div><div class="feature-actions"><button id="instrumentManagerAdd">添加音频…</button><button id="instrumentManagerEmpty">添加空音色</button><button id="instrumentManagerReload">重新载入采样…</button><button id="instrumentManagerUp">上移</button><button id="instrumentManagerDown">下移</button><button id="instrumentManagerRemove">删除音色</button></div><div class="feature-actions"><button id="instrumentManagerImport">从 NBS / NBPZ 导入音色…</button><button id="instrumentManagerExport">导出音色 NBPZ</button><button id="instrumentManagerSounds">导入 Minecraft 音效…</button></div><p id="instrumentManagerStatus">所有采样保存在本浏览器中；NBPZ 音色包同时保存定义与已加载音频。</p>`,`<button class="primary-button" id="instrumentManagerSave">保存属性</button>`);
    $('instrumentManagerIndex').value=String(Math.max(0,Math.min(song.customInstruments.length-1,Number(initialIndex)||0)));
    const selected=()=>Number($('instrumentManagerIndex').value),fields=()=>{const index=selected(),definition=song.customInstruments[index],count=definition?song.notes.reduce((sum,n)=>sum+(n.instrument===16+index),0):0;$('instrumentManagerFields').innerHTML=definition?`<label>名称<input id="instrumentManagerName" value="${esc(definition.name)}" maxlength="1024"></label><label>文件引用<input id="instrumentManagerFile" value="${esc(definition.file)}" maxlength="4096"></label><label class="inline-label">基准音高<input id="instrumentManagerKey" type="number" min="0" max="87" step="1" value="${definition.key}"></label><label class="inline-label">播放时按下钢琴键<input id="instrumentManagerPress" type="checkbox" ${definition.pressKey?'checked':''}></label><p>目前有 ${count.toLocaleString()} 个音符使用此音色；删除会移除这些音符，可撤销。</p>`:'<p>当前没有自定义音色。</p>';for(const id of ['Save','Reload','Remove','Up','Down'])$('instrumentManager'+id).disabled=!definition||id==='Up'&&index===0||id==='Down'&&index===song.customInstruments.length-1;};fields();$('instrumentManagerIndex').onchange=fields;
    const edit=(callback,index=selected())=>{busy();if(h.getSong()!==song)throw new Error('工程已更换，请重新打开音色管理。');operation++;const oldBank=new Map(engine.customSamples),staged={...song,customInstruments:song.customInstruments.slice(),notes:song.notes},result=callback(staged,oldBank,index);if(result.changed){sync(song,staged,result,oldBank);const mapped=result.instrumentMap?.get(16+index);open({index:mapped>=16?mapped-16:result.addedIndices?.at(-1)??Math.min(index,staged.customInstruments.length-1)});}};
    $('instrumentManagerSave').onclick=run(()=>edit((staged,bank,index)=>{const key=Number($('instrumentManagerKey').value);if(!Number.isInteger(key)||key<0||key>87)throw new Error('基准音高必须为 0–87 的整数。');staged.customInstruments=staged.customInstruments.map((definition,i)=>i===index?{...definition,name:$('instrumentManagerName').value,file:$('instrumentManagerFile').value,key,pressKey:$('instrumentManagerPress').checked}:definition);return{changed:true,samples:bank};}));
    $('instrumentManagerUp').onclick=run(()=>edit((staged,bank,index)=>moveInstrument(staged,index,'up',bank)));
    $('instrumentManagerDown').onclick=run(()=>edit((staged,bank,index)=>moveInstrument(staged,index,'down',bank)));
    $('instrumentManagerRemove').onclick=run(()=>edit((staged,bank,index)=>removeInstrument(staged,index,bank)));
    $('instrumentManagerEmpty').onclick=run(()=>edit((staged,bank)=>importInstrumentDefinitions(staged,{customInstruments:[{name:`Custom instrument #${staged.customInstruments.length+1}`,file:'',key:45,pressKey:false}]},{samples:bank})));
    $('instrumentManagerAdd').onclick=()=>h.addCustomSample();$('instrumentManagerReload').onclick=()=>h.addCustomSample(selected());
    $('instrumentManagerImport').onclick=()=>pick('.nbs,.nbpz,.zip',async files=>{if(files[0])await importDefinitions(files[0]);});
    $('instrumentManagerExport').onclick=run(async()=>{await engine.init();const bank=bankFor(song),bytes=await exportInstrumentBundle(song,bank);h.download(bytes,`${String(song.title||'project').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}_instruments.nbpz`,'application/zip');notify(`已导出 ${song.customInstruments.length} 个音色定义和 ${bank.size} 个采样`);});
    $('instrumentManagerSounds').onclick=run(()=>importSounds());
  }
  async function importDefinitions(file){
    busy();const song=h.getSong(),token=++operation,oldBank=new Map(engine.customSamples),isCurrent=guard(song,token,oldBank),status=message=>{if($('instrumentManagerStatus'))$('instrumentManagerStatus').textContent=message;};
    if(file.size>256*MiB)throw new Error('音色工程包超过 256 MiB。');let imported,rawSamples=[];
    if(/\.(nbpz|zip)$/i.test(file.name)){const bundle=await readProjectBundle(await file.arrayBuffer());imported=bundle.project;rawSamples=bundle.samples;}else imported=h.store?.parse?await h.store.parse(file,status):parseNBS(await file.arrayBuffer());
    assertCurrent(isCurrent);if(!imported.customInstruments.length)throw new Error('此文件没有自定义音色。');if(song.customInstruments.length+imported.customInstruments.length>240)throw new Error('导入后自定义音色超过 240 个。');
    const sourceSamples=new Map();if(rawSamples.length){await engine.init();assertCurrent(isCurrent);for(const sample of rawSamples){status(`正在解码音色 ${sourceSamples.size+1}/${rawSamples.length}…`);sourceSamples.set(sample.index,validPCM(await engine.context.decodeAudioData(sample.bytes.slice(0))));assertCurrent(isCurrent);}}
    const staged={...song,customInstruments:song.customInstruments.slice(),notes:song.notes},result=importInstrumentDefinitions(staged,imported,{samples:bankFor(song),sourceSamples});assertCurrent(isCurrent);sync(song,staged,result,oldBank);open();notify(`已导入 ${result.addedIndices.length} 个音色定义`);
  }
  function importSounds(){
    operation++;busy();pauseAudio();let candidates=[],selectionGeneration=0,currentFiles=[],currentFolder=false,currentIndex='';
    const slots=()=>Math.max(0,MAX_CUSTOM_INSTRUMENTS-h.getSong().customInstruments.length);
    h.modal('导入 Minecraft 音效',`<p>选择你拥有的 OGG 音效，或选择 Minecraft 的 assets 文件夹。支持 indexes JSON 与 objects 哈希文件；只读取你选择的文件，不下载资源。</p><div class="feature-actions"><button id="instrumentSoundsFiles">选择音效文件…</button><button id="instrumentSoundsFolder">选择音效 / assets 文件夹…</button></div><label>文件夹导入范围<select id="instrumentSoundsMode"><option value="noteblock">16 种音符盒采样（推荐）</option><option value="all">全部非音乐游戏音效（最多 ${slots()} 个剩余位置）</option></select></label><label id="instrumentSoundsIndexLabel" hidden>资源版本索引<select id="instrumentSoundsIndex"></select></label><label class="inline-label">将对应的原生音符改用新采样<input id="instrumentSoundsConvert" type="checkbox" checked></label><p id="instrumentSoundsStatus">每个文件最多 32 MiB；勾选条目后一次导入，任一解码失败都不会修改工程。全部模式优先列出并勾选音符盒采样，其它音效由你选择。</p><div class="feature-actions"><button id="instrumentSoundsSelectAll" disabled>全选</button><button id="instrumentSoundsSelectNone" disabled>全部取消</button></div><div id="instrumentSoundsList"></div>`,`<button class="primary-button" id="instrumentSoundsApply" disabled>导入所选音色</button>`);
    const show=async(files,folder,assetIndexPath='')=>{
      const generation=++selectionGeneration;operation++;currentFiles=files;currentFolder=folder;
      candidates=[];$('instrumentSoundsList').innerHTML='';$('instrumentSoundsApply').disabled=true;$('instrumentSoundsSelectAll').disabled=true;$('instrumentSoundsSelectNone').disabled=true;$('instrumentSoundsStatus').textContent='正在读取所选资源索引与文件列表…';
      const soundMode=$('instrumentSoundsMode').value,result=await resolveSoundImport(files,{folder,assetIndexPath,soundMode});
      if(generation!==selectionGeneration||!$('instrumentSoundsList'))return;
      candidates=result.candidates;currentIndex=result.assetIndexPath;
      $('instrumentSoundsIndexLabel').hidden=!result.indexes.length;
      $('instrumentSoundsIndex').innerHTML=result.indexes.map(path=>`<option value="${esc(path)}" ${path===result.assetIndexPath?'selected':''}>${esc(path.split('/').at(-1))}</option>`).join('');
      $('instrumentSoundsIndex').onchange=run(()=>show(currentFiles,currentFolder,$('instrumentSoundsIndex').value));
      const checked=candidate=>!folder||soundMode!=='all'||candidate.builtin>=0;
      let selectedCount=candidates.reduce((count,candidate)=>count+Number(checked(candidate)),0);
      const status=()=>{const remaining=slots();$('instrumentSoundsApply').disabled=!selectedCount||selectedCount>remaining;$('instrumentSoundsStatus').textContent=[`找到 ${candidates.length} 个可导入音色，已选 ${selectedCount} 个，剩余 ${remaining} 个位置（最多 240 个）。`,selectedCount>remaining?'选择超过剩余位置，请减少勾选；不会自动截断或导入。':'',...result.warnings].filter(Boolean).join(' ');};
      $('instrumentSoundsList').innerHTML=candidates.map((candidate,index)=>`<label class="inline-label">${esc(candidate.name)} · ${esc(candidate.path)}<input data-import-sound="${index}" type="checkbox" ${checked(candidate)?'checked':''}></label>`).join('');
      $('instrumentSoundsList').onchange=event=>{if(event.target?.dataset?.importSound===undefined)return;selectedCount+=event.target.checked?1:-1;status();};
      for(const [id,value]of [['instrumentSoundsSelectAll',true],['instrumentSoundsSelectNone',false]]){$(id).disabled=!candidates.length;$(id).onclick=()=>{for(const input of document.querySelectorAll('[data-import-sound]'))input.checked=value;selectedCount=value?candidates.length:0;status();};}
      status();
    };
    $('instrumentSoundsMode').onchange=run(()=>show(currentFiles,currentFolder,currentIndex));
    $('instrumentSoundsFiles').onclick=()=>pick('.ogg',files=>show(files,false),{multiple:true});
    $('instrumentSoundsFolder').onclick=()=>pick('',files=>show(files,true),{multiple:true,directory:true});
    $('instrumentSoundsApply').onclick=run(async()=>{
      busy();const button=$('instrumentSoundsApply'),song=h.getSong(),token=++operation,oldBank=new Map(engine.customSamples),isCurrent=guard(song,token,oldBank),selected=[...document.querySelectorAll('[data-import-sound]:checked')].map(input=>candidates[Number(input.dataset.importSound)]),convertNative=$('instrumentSoundsConvert').checked;button.disabled=true;
      try{await engine.init();assertCurrent(isCurrent);const result=await stageSoundImport(song,bankFor(song),selected,{decode:bytes=>engine.context.decodeAudioData(bytes),convertNative,isCurrent,onProgress:message=>{if($('instrumentSoundsStatus'))$('instrumentSoundsStatus').textContent=message;}});assertCurrent(isCurrent);sync(song,result.song,result,oldBank);open();notify(`已导入 ${result.addedIndices.length} 个音色，转换 ${result.convertedNotes} 个原生音符`);}finally{if(button.isConnected)button.disabled=false;}
    });
  }
  return{open,importSounds};
}
