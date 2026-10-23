/** Browser-only Minecraft files. No remote service and no native DLL is involved. */
import {buildCircuit,prepareSong} from './minecraft/circuit.js';
import {serializeStructure,parseStructure,importCircuit} from './minecraft/structure.js';
import {buildDatapack,importDatapack,VISUALIZERS,buildBundledResourcePack,buildCustomResourcePack} from './minecraft/datapack.js';
import {resourceId} from './minecraft/sound.js';
export {buildCircuit,prepareSong,serializeStructure,parseStructure,importCircuit,buildDatapack,importDatapack,VISUALIZERS,buildBundledResourcePack,buildCustomResourcePack};
export const MINECRAFT_OPTIONS={
  format:{label:'格式',values:['schematic','structure','branch','track','datapack'],default:'structure'},
  layout:{label:'电路布局',values:['circular','simple','classic'],default:'simple'},direction:{label:'方向',values:['north','east','south','west'],default:'north'},
  tempo:{label:'红石速度 tick/s',values:[10,5,2.5],default:10},repeatersPerRow:{label:'每行中继器',min:5,max:100,default:20},
  includeLocked:{label:'包括锁定或静音图层',default:false},compressLayers:{label:'压缩空图层',default:true},commandBlocks:{label:'使用命令方块（结构）',default:false},
  minecart:{label:'矿车轨道（环形、简单）',default:false},chest:{label:'矿车箱',default:true},loop:{label:'循环（环形、数据包）',default:false},glassFloor:{label:'经典布局玻璃地板',default:true},
  instrumentBlocks:{label:'乐器支撑方块映射',example:{0:{id:3,name:'minecraft:dirt'},1:5}},walkwayBlock:{label:'过道方块',default:1},circuitBlock:{label:'电路方块',default:1},groundBlock:{label:'地面方块',default:1},
  legacyVersion:{label:'旧版方块实体名称',values:['pre1.11','1.11'],default:'1.11'},layers:{label:'分支选择的图层（从 0 开始）',example:[0,1,2]},rangeStart:{label:'起始 tick',default:0},rangeEnd:{label:'结束 tick（包含）'},
  stereo:{label:'分支声像筛选',values:['all','left','right','center'],default:'all'},velocity:{label:'分支音量距离',default:true},circuitry:{label:'分支包括电路',default:true},
  namespace:{label:'数据包命名空间',default:'noteblock'},mcVersion:{label:'数据包目标版本',values:['1.21','1.20'],default:'1.21'},source:{label:'声音通道',values:['master','music','record','weather','block','hostile','neutral','player','ambient','voice'],default:'record'},
  includeOutOfRange:{label:'包含扩展八度（需资源包）',default:false},radius:{label:'半径播放（所有附近玩家）',default:false},radiusValue:{label:'声音半径',min:1,max:10000,default:16},
  loopCount:{label:'循环次数（0 为无限）',min:0,max:255,default:0},visualizer:{label:'启用可视化',default:false},visualizerType:{label:'可视化类型',values:VISUALIZERS,default:'Arc'},glow:{label:'可视化发光',default:true},x:{label:'可视化 X',default:0},y:{label:'可视化 Y',default:100},z:{label:'可视化 Z',default:0},customNamespace:{label:'自定义声音事件命名空间',default:'minecraft'},
};
function resolveOptions(options){const resolved={...options};if(resolved.version&&!resolved.mcVersion)resolved.mcVersion=resolved.version;const vis=resolved.visualizer;if(vis==='none')resolved.visualizer=false;else if(typeof vis==='string'&&/^[0-6]$/.test(vis)){resolved.visualizer=true;resolved.visualizerType=VISUALIZERS[Number(vis)];}if(resolved.direction)resolved.direction=String(resolved.direction).toLowerCase();if(resolved.version==='1.8')resolved.legacyVersion='pre1.11';return resolved;}
export async function exportMinecraft(song,options={}){
  options=resolveOptions(options);const format=options.format||'structure',base=resourceId(song.title,'noteblock');
  if(format==='datapack'){const result=await buildDatapack(song,options);return{...result,filename:`${base}_datapack.zip`,mime:'application/zip'};}
  if(!['schematic','structure','branch','track'].includes(format))throw new Error('未知 Minecraft 导出格式。');if(options.commandBlocks&&(format==='schematic'||format==='branch'))throw new Error('命令方块只能使用结构 NBT 或直轨 NBT 导出。');
  const model=buildCircuit(song,{...options,format}),bytes=await serializeStructure(model,{...options,format});return{bytes,filename:`${base}${format==='branch'?'_branch':format==='track'?'_track':''}.${format==='schematic'||format==='branch'?'schematic':'nbt'}`,mime:'application/octet-stream',warnings:model.warnings,summary:model.summary};
}
export async function importMinecraft(bytes,options={}){const a=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);if(a[0]===0x50&&a[1]===0x4b)return importDatapack(a,options);return importCircuit(await parseStructure(a),options);}
