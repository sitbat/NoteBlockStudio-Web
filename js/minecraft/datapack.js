import {writeZip,readZip} from '../archive.js';
import {prepareSong} from './circuit.js';
import {SUPPORT_NAMES,blockSpec} from './blocks.js';
import {playSoundCommand,soundEvent,resourceId,decimal} from './sound.js';
import {normalizeSong,createBlankSong,MAX_NOTES,MAX_LAYERS} from '../model.js';
export const VISUALIZERS=['Arc','Fall','Rise','Bounce','Piano Roll','Fountain','Rittai Onkyou'];
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true}),json=value=>JSON.stringify(value,null,2)+'\n';
function packMetadata(files,label){
  if(!files.has('pack.mcmeta'))throw new Error(`${label}缺少根目录 pack.mcmeta。`);
  let metadata;try{metadata=JSON.parse(dec.decode(files.get('pack.mcmeta')));}catch{throw new Error(`${label} pack.mcmeta 不是有效的 UTF-8 JSON。`);}
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!object(metadata)||!object(metadata.pack))throw new Error(`${label} pack.mcmeta 必须包含对象类型的 pack 字段。`);
  if(!Number.isSafeInteger(metadata.pack.pack_format)||metadata.pack.pack_format<1)throw new Error(`${label} pack_format 必须是有效的正整数。`);
  return metadata;
}
const hash=value=>{let h=2166136261;for(const c of value)h=Math.imul(h^c.charCodeAt(0),16777619);return(h>>>0).toString(16).padStart(8,'0');};
function functionLocation(options,song){
  const rawPath=options.functionPath??'';
  if(typeof rawPath!=='string'||rawPath.length>240||rawPath&&(!/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/.test(rawPath)||rawPath.split('/').some(part=>part==='.'||part==='..')))throw new Error('数据包函数子目录必须为小写相对路径，不能包含空段、反斜线或 ..。');
  const named=options.name!==undefined||!!rawPath;
  if(!named)return{name:'',functionPath:''};
  if(options.name!==undefined&&(typeof options.name!=='string'||options.name.length>1024))throw new Error('数据包曲目名称无效。');
  const rawName=options.name||song.title||'song',normalized=resourceId(rawName,'song');
  // Retain distinct Unicode/space-containing names after converting to resource IDs.
  const name=normalized+(normalized!==rawName.toLowerCase()?`_${hash(rawName)}`:'');
  return{name,functionPath:[rawPath,name].filter(Boolean).join('/')};
}
export function visualizerCommands(song,n,options={},tag='nbs_visual'){
  const type=options.visualizerType||'Arc';if(!VISUALIZERS.includes(type))throw new Error('未知可视化类型。');const key=n.key+n.pitch/100,ins=n.instrument,layer=song.layers[n.layer],volume=layer.volume*n.velocity/10000,pan=-(layer.pan+n.pan)/200;
  const x=Number(options.x)||0,y=Number(options.y??100),z=Number(options.z)||0;if(![x,y,z].every(Number.isFinite))throw new Error('可视化坐标必须是有限数值。');const support=options.instrumentBlocks?.[ins]?blockSpec(options.instrumentBlocks[ins]).name:`minecraft:${SUPPORT_NAMES[ins]||'stone'}`,team=`${tag}_${ins%16}`,glow=options.glow!==false;
  const summon=(name,xx,yy,zz,motion,time=-80,noGravity=false)=>`summon minecraft:falling_block ${decimal(xx)} ${decimal(yy)} ${decimal(zz)} {BlockState:{Name:${JSON.stringify(name)}},Tags:[${JSON.stringify(tag)},${JSON.stringify(team)}],Time:${time},DropItem:0b,HurtEntities:0b,${glow?'Glowing:1b,':''}${noGravity?'NoGravity:1b,':''}Motion:[${motion.map(n=>`${decimal(n)}d`).join(',')}]}`;
  let commands;
  switch(type){case 'Arc':commands=[summon(support,-(key-45)+x,y,ins*2+z,[0,1,1],-120)];break;
    case 'Fall':commands=[summon(support,key-45+x,y,ins*2+z,[0,-1.3,0])];break;
    case 'Rise':commands=[summon(support,key-45+x,y,ins*2+z,[0,1,0],-50,true)];break;
    case 'Bounce':commands=[summon(support,ins+1+x,y,ins*2+z,[0,1.3,0])];break;
    case 'Piano Roll':commands=[summon(support,-(key-45)+x,y,z,[0,0,2.5],-50,true)];break;
    case 'Fountain':commands=[summon(support,ins+1+x,y,ins*2+z,[key>45?.5:-.5,1.5,0])];break;
    case 'Rittai Onkyou':{const xx=pan*48+x,yy=y-10,zz=volume*48+z;commands=[summon(support,xx,yy,zz,[0,-1.3,0]),summon('minecraft:note_block',xx,yy,zz-1,[0,-1.3,0]),`particle minecraft:note ${decimal(xx)} ${decimal(yy)} ${decimal(zz-2)} 0 0 0 1 1 force @p`];break;}}
  if(glow)commands.push(`team join ${team} @e[tag=${team}]`);return commands;
}
export async function buildDatapack(raw,options={}){
  const {song,warnings}=prepareSong(raw,options,'datapack'),namespace=resourceId(options.namespace||song.title,'noteblock'),location=functionLocation(options,song),functionPrefix=`${namespace}:${location.functionPath?location.functionPath+'/':''}`,id=hash(location.functionPath?functionPrefix:namespace),clock=`nbs_${id}`,last=`nbl_${id}`,repeat=`nbr_${id}`,playing=`nbs_${id}_playing`,visual=`nbv_${id}`;
  const modern=String(options.mcVersion??'1.21')!=='1.20',folder=modern?'function':'functions',format=modern?48:41,path=`data/${namespace}/${folder}/${location.functionPath?location.functionPath+'/':''}`,files=new Map(),put=(name,data)=>files.set(name,typeof data==='string'?enc.encode(data):data),fn=(name,lines)=>put(`${path}${name}.mcfunction`,Array.isArray(lines)?lines.join('\n')+'\n':lines+'\n');
  const speed=Math.max(1,Math.min(120,Math.round(song.tempo*4)));if(speed/4!==song.tempo)warnings.push(`数据包速度为 ${speed/4} tick/s（原曲 ${song.tempo}）；按原版 20 Hz 游戏时钟调度。`);
  const byTick=new Map();for(const n of song.notes){if(!byTick.has(n.tick))byTick.set(n.tick,[]);byTick.get(n.tick).push(n);}const ticks=[...byTick.keys()].sort((a,b)=>a-b);
  if(ticks.length>20000)throw new Error('数据包包含过多独立时间点（最多 20000）；请分段导出。');
  const range=(start,end)=>start===end?String(start):`${start}..${end}`;
  function tree(lo,hi){const start=ticks[lo],end=ticks[hi],name=`tree/${start}_${end}`;if(lo===hi){fn(name,[`execute if score @s ${clock} matches ${start*80}.. if score @s ${last} matches ..${start-1} run function ${functionPrefix}notes/${start}`]);return name;}
    const mid=(lo+hi)>>1,children=[[lo,mid],[mid+1,hi]],lines=[];for(const [a,b]of children){const child=tree(a,b);lines.push(`execute if score @s ${clock} matches ${ticks[a]*80}.. if score @s ${last} matches ..${ticks[b]-1} run function ${functionPrefix}${child}`);}fn(name,lines);return name;}
  for(const tick of ticks){const lines=[];for(const n of byTick.get(tick)){lines.push(playSoundCommand(song,n,{...options,namespace:options.customNamespace||'minecraft'}));if(options.visualizer)lines.push(...visualizerCommands(song,n,options,visual));}lines.push(`scoreboard players set @s ${last} ${tick}`);fn(`notes/${tick}`,lines);}
  const root=tree(0,ticks.length-1),finishAt=song.length*80;
  fn('load',[`scoreboard objectives add ${clock} dummy`,`scoreboard objectives add ${last} dummy`,`scoreboard objectives add ${repeat} dummy`,`scoreboard players set #speed ${clock} ${speed}`,...(options.visualizer&&options.glow!==false?Array.from({length:16},(_,i)=>[`team add ${visual}_${i}`,`team modify ${visual}_${i} color ${['green','dark_green','dark_gray','yellow','gray','red','gold','gold','dark_aqua','aqua','gray','dark_gray','dark_red','light_purple','yellow','dark_purple'][i]}`]).flat():[])]);
  fn('tick',[`execute as @a[tag=${playing}] at @s run function ${functionPrefix}player_tick`]);
  fn('player_tick',[`scoreboard players operation @s ${clock} += #speed ${clock}`,`function ${functionPrefix}${root}`,`execute if score @s ${clock} matches ${finishAt}.. run function ${functionPrefix}finish`]);
  const loop=options.loop??song.loop,loopStart=Math.max(0,Math.min(song.length-1,song.loopStart)),loopCount=Number(options.loopCount??song.loopCount)||0;
  fn('finish',loop?[`scoreboard players add @s ${repeat} 1`,...(loopCount?[`execute if score @s ${repeat} matches ${loopCount+1}.. run function ${functionPrefix}stop`,`execute if score @s ${repeat} matches ..${loopCount} run function ${functionPrefix}loop`]:[`function ${functionPrefix}loop`])]:[`function ${functionPrefix}stop`]);
  fn('loop',[`scoreboard players set @s ${clock} ${loopStart*80}`,`scoreboard players set @s ${last} ${loopStart-1}`]);
  fn('play',[`execute unless score @s ${clock} matches 0.. run scoreboard players set @s ${clock} 0`,`execute unless score @s ${last} matches -1.. run scoreboard players set @s ${last} -1`,`execute unless score @s ${repeat} matches 0.. run scoreboard players set @s ${repeat} 0`,`tag @s add ${playing}`,`function ${functionPrefix}${root}`]);
  fn('pause',[`tag @s remove ${playing}`]);fn('stop',[`tag @s remove ${playing}`,`scoreboard players reset @s ${clock}`,`scoreboard players reset @s ${last}`,`scoreboard players reset @s ${repeat}`]);
  fn('restart',[`function ${functionPrefix}stop`,`function ${functionPrefix}play`]);fn('cleanup',[`kill @e[tag=${visual}]`]);
  fn('uninstall',[`tag @a remove ${playing}`,`scoreboard objectives remove ${clock}`,`scoreboard objectives remove ${last}`,`scoreboard objectives remove ${repeat}`,`function ${functionPrefix}cleanup`,...(options.visualizer&&options.glow!==false?Array.from({length:16},(_,i)=>`team remove ${visual}_${i}`):[])]);
  put('pack.mcmeta',json({pack:{pack_format:format,description:`${song.title}${song.author?` — ${song.author}`:''}`}}));
  put(`data/minecraft/tags/${folder}/load.json`,json({values:[`${functionPrefix}load`]}));put(`data/minecraft/tags/${folder}/tick.json`,json({values:[`${functionPrefix}tick`]}));
  put('nbs-web-project.json',json({version:1,namespace,song,options:{...options,speed}}));
  put('README.txt',`Note Block Studio 本地导出的 Java Edition 数据包\n目标：${modern?'1.21':'1.20.5–1.20.6'}\n\n将 ZIP 放入世界 datapacks 目录，运行 /reload。\n以玩家执行：\n/function ${functionPrefix}play\n/function ${functionPrefix}pause\n/function ${functionPrefix}stop\n/function ${functionPrefix}restart\n/function ${functionPrefix}cleanup\n卸载前：/function ${functionPrefix}uninstall\n\n支持多位玩家独立播放。速度为 ${speed/4} tick/s。\n扩展八度及自定义音色需要在客户端另装对应资源包。\n可视化使用真实 falling_block 实体；cleanup 清理本曲仍存在的实体。\n`);
  const extended=song.notes.some(n=>soundEvent(song,n).extended),custom=song.notes.some(n=>n.instrument>=16);if(extended)warnings.push('超出原版两八度的音符需要“扩展音域资源包”。');if(custom)warnings.push('自定义音色需要安装包含相应声音事件的资源包；可使用“自定义音色资源包”导出 OGG 文件。');
  return{files,bytes:await writeZip([...files].map(([name,data])=>({name,data}))),namespace,name:location.name,functionPath:location.functionPath,warnings,summary:{notes:song.notes.length,files:files.size,tempo:speed/4,mcVersion:modern?'1.21':'1.20.5',name:location.name,functionPath:location.functionPath,visualizer:options.visualizer?options.visualizerType||'Arc':null},commands:{play:`/function ${functionPrefix}play`,pause:`/function ${functionPrefix}pause`,stop:`/function ${functionPrefix}stop`}};
}
export async function importDatapack(input,options={}){
  const files=input instanceof Map?input:await readZip(input);if(!files.size)throw new Error('数据包为空或缺少根目录 pack.mcmeta。');packMetadata(files,'数据包');
  const own=files.get('nbs-web-project.json');if(own){const data=JSON.parse(dec.decode(own));if(data.version===1)return{song:normalizeSong(data.song),warnings:[],summary:{source:'datapack-project'}};}
  const notes=[];let maxLayer=0,maxTick=0;for(const [name,data]of files){const m=name.match(/\/(?:functions|function)\/notes\/(\d+)\.mcfunction$/);if(!m)continue;const tick=Number(m[1]);if(!Number.isSafeInteger(tick)||tick>=1000000)throw new Error('数据包时间点超过项目 tick 范围。');let layer=0;for(const line of dec.decode(data).split(/\r?\n/)){const p=line.match(/playsound\s+(\S+)\s+\S+\s+\S+\s+\^(\S*)\s+\^\s+\^\s+([\d.]+)\s+([\d.]+)/);if(!p)continue;if(notes.length>=MAX_NOTES||layer>=MAX_LAYERS)throw new Error('数据包音符或同时发声图层超过项目限制。');const event=p[1],name=event.replace(/_[-]?1$/,'').split('.').pop(),ins=['harp','bass','basedrum','snare','hat','guitar','flute','bell','chime','xylophone','iron_xylophone','cow_bell','didgeridoo','bit','banjo','pling'].indexOf(name),offset=event.endsWith('_-1')?-24:event.endsWith('_1')?24:0;notes.push({tick,layer:layer++,instrument:Math.max(0,ins),key:Math.round(45+12*Math.log2(Number(p[4]))+offset),velocity:Math.min(100,Number(p[3])*100),pan:Math.max(-100,Math.min(100,-Number(p[2]||0)*100)),pitch:0});maxLayer=Math.max(maxLayer,layer);maxTick=Math.max(maxTick,tick);}}
  if(!notes.length)throw new Error('数据包没有可导入的 Note Block Studio notes/*.mcfunction。');return{song:normalizeSong({...createBlankSong(),title:options.title||'导入的数据包',tempo:options.tempo||10,notes,layers:Array.from({length:maxLayer},(_,id)=>({id,name:`声部 ${id+1}`,volume:100})),length:maxTick+1}),warnings:['外部数据包仅解析 Note Block Studio 的 notes/<tick>.mcfunction；控制逻辑与动态命令未执行。'],summary:{source:'datapack-commands',notes:notes.length}};
}
/** Copies the original octave/texture assets, updating only the declared target format. */
export async function buildBundledResourcePack(kind='extended',options={}){
  const filename=kind==='textures'?'instrumenttextures.zip':kind==='extended'?'extranotes.zip':null;if(!filename)throw new Error('资源包类型必须为 extended 或 textures。');
  let bytes=options.sourceBytes;if(!bytes){const response=await fetch(new URL(`../../assets/minecraft/${filename}`,import.meta.url));if(!response.ok)throw new Error('无法读取本地资源包。');bytes=new Uint8Array(await response.arrayBuffer());}
  const files=await readZip(bytes),metadata=packMetadata(files,'资源包');metadata.pack.pack_format=String(options.mcVersion??'1.21')==='1.20'?32:34;files.set('pack.mcmeta',enc.encode(json(metadata)));return{bytes:await writeZip([...files].map(([name,data])=>({name,data}))),filename,warnings:[],summary:{files:files.size}};
}
/** Minecraft Java loads OGG/Vorbis. Unsupported source codecs are reported, never renamed. */
export async function buildCustomResourcePack(song,samples,options={}){
  const files=new Map(),sounds={},warnings=[],namespace=resourceId(options.namespace||'minecraft'),get=key=>samples instanceof Map?samples.get(key):samples?.[key];let count=0;
  const binary=async source=>{let bytes=source instanceof Blob?new Uint8Array(await source.arrayBuffer()):source?.bytes||source?.data||source;if(bytes instanceof ArrayBuffer)bytes=new Uint8Array(bytes);return bytes;};
  const vorbis=bytes=>{if(!(bytes instanceof Uint8Array)||bytes.length<35||String.fromCharCode(...bytes.subarray(0,4))!=='OggS'||bytes[4]!==0)return false;const start=27+bytes[26];return start+7<=bytes.length&&bytes[start]===1&&String.fromCharCode(...bytes.subarray(start+1,start+7))==='vorbis';};
  const needed=new Map();for(const note of song.notes){if(note.instrument<16)continue;const key=note.key+note.pitch/100;if(key<33||key>57){if(!needed.has(note.instrument-16))needed.set(note.instrument-16,new Set());needed.get(note.instrument-16).add(key<33?'lower':'upper');}}
  for(let i=0;i<song.customInstruments.length;i++){const instrument=song.customInstruments[i],source=get(instrument.file)??get(i+(options.sampleIndexBase===16?16:0));if(!source){warnings.push(`未载入 ${instrument.name} 的音频。`);continue;}const base=await binary(source);if(!vorbis(base)){warnings.push(`${instrument.name} 不是 OGG/Vorbis 文件；不能直接使用 WAV、MP3 或 OGG/Opus。`);continue;}const name=resourceId(instrument.name,`custom_${i}`);if(Object.hasOwn(sounds,name))throw new Error('自定义乐器名称转换后重复，请重命名乐器。');files.set(`assets/${namespace}/sounds/nbs/${name}.ogg`,base);sounds[name]={sounds:[{name:`${namespace}:nbs/${name}`,stream:false}]};count++;
    for(const [key,suffix]of [['lower','_-1'],['upper','_1']]){if(source[key]){const variant=await binary(source[key]);if(!vorbis(variant))throw new Error(`${instrument.name} 的扩展八度不是有效 OGG/Vorbis。`);files.set(`assets/${namespace}/sounds/nbs/${name}${suffix}.ogg`,variant);sounds[name+suffix]={sounds:[{name:`${namespace}:nbs/${name}${suffix}`,stream:false}]};}else if(needed.get(i)?.has(key))warnings.push(`${instrument.name} 缺少${key==='lower'?'低':'高'}八度预调音频（事件 ${name}${suffix}）。`);}
  }
  if(!count)throw new Error('没有可导出的 OGG 自定义音色。');files.set(`assets/${namespace}/sounds.json`,enc.encode(json(sounds)));files.set('pack.mcmeta',enc.encode(json({pack:{pack_format:String(options.mcVersion??'1.21')==='1.20'?32:34,description:`${song.title} — 自定义音色`}})));return{bytes:await writeZip([...files].map(([name,data])=>({name,data}))),filename:`${resourceId(song.title)}_sounds.zip`,warnings,summary:{sounds:count,namespace}};
}
