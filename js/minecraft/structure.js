import {byte,short,int,double,bytes,string,list,compound,gzipNBT,readNBT} from './nbt.js';
import {modernState,INSTRUMENTS,SUPPORT_NAMES,SUPPORT_IDS,posKey} from './blocks.js';
import {soundEvent,decimal} from './sound.js';
import {normalizeSong,createBlankSong,MAX_NOTES,MAX_LAYERS} from '../model.js';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const stateTag=s=>({Name:string(s.Name),...(s.Properties?{Properties:compound(Object.fromEntries(Object.entries(s.Properties).map(([k,v])=>[k,string(v)])))}:{})});
function blockNBT(b,model,options,legacy=false){
  const [x,y,z]=b.pos,p={x:int(x),y:int(y),z:int(z)};
  if(b.note){if(options.commandBlocks){const sound=soundEvent(model.song,b.note,{namespace:options.customNamespace||'minecraft'}),layer=model.song.layers[b.note.layer];return{...p,id:string('minecraft:command_block'),Command:string(`playsound ${sound.event} block @a ~ ~ ~ ${decimal(3*layer.volume*b.note.velocity/10000)} ${decimal(sound.pitch)}`),TrackOutput:byte(0),powered:byte(0),auto:byte(0),conditionMet:byte(1),UpdateLastExecution:byte(1)};}
    if(legacy)return{...p,id:string(options.legacyVersion==='pre1.11'?'Music':'minecraft:noteblock'),note:byte(b.note.key-33),powered:byte(0)};return null;}
  if(b.sign)return{...p,id:string(legacy&&options.legacyVersion==='pre1.11'?'Sign':'minecraft:sign'),...Object.fromEntries(b.sign.map((text,i)=>[`Text${i+1}`,string(legacy&&options.legacyVersion==='pre1.11'?text:JSON.stringify({text}))]))};
  if(b.chest)return{...p,id:string(legacy&&options.legacyVersion==='pre1.11'?'Chest':'minecraft:chest'),Items:list(10,Array.from({length:27},(_,slot)=>({Slot:byte(slot),Count:byte(1),id:string(legacy&&options.legacyVersion==='pre1.11'?'328':'minecraft:minecart')})))};return null;
}
export async function serializeStructure(model,options={}){
  const legacy=options.format==='schematic'||options.format==='branch',metadata=bytes(enc.encode(JSON.stringify({version:1,song:model.song,kind:model.kind}))),entities=(model.entities||[]).map(e=>({pos:list(6,e.pos),blockPos:list(3,e.pos.map(Math.floor)),nbt:compound({id:string(e.id||'minecraft:minecart')})}));
  if(legacy){const [w,h,l]=model.size;if(w>32767||h>32767||l>32767||w*h*l>16000000)throw new Error('Schematic 尺寸过大。');const blockData=new Uint8Array(w*h*l),data=new Uint8Array(blockData.length),tile=[];
    for(const b of model.blocks){if(!Number.isInteger(b.id)||b.id<0||b.id>255)throw new Error(`旧版 Schematic 不支持方块 ${b.name}；请导出结构 NBT。`);const [x,y,z]=b.pos;if(x<0||y<0||z<0||x>=w||y>=h||z>=l)throw new Error('方块坐标超出 Schematic。');const index=(y*l+z)*w+x;blockData[index]=b.id;data[index]=b.data||0;const nbt=blockNBT(b,model,options,true);if(nbt)tile.push(nbt);}
    const oldEntities=(model.entities||[]).map(e=>({id:string(options.legacyVersion==='pre1.11'?'Minecart':e.id||'minecraft:minecart'),Pos:list(6,e.pos),Motion:list(6,[0,0,0]),Rotation:list(5,[0,0]),Type:int(0)}));
    return gzipNBT(compound({Width:short(w),Height:short(h),Length:short(l),Materials:string('Alpha'),Blocks:bytes(blockData),Data:bytes(data),Entities:list(10,oldEntities),TileEntities:list(10,tile),NBSWebScore:metadata,Version:compound({Name:string(options.legacyVersion==='pre1.11'?'1.8':'1.11.2'),Snapshot:byte(0)})}),'Schematic');
  }
  const palette=[],indices=new Map(),blocks=[];for(const b of model.blocks){const state=b.state||modernState(b),key=JSON.stringify(state);if(!indices.has(key)){indices.set(key,palette.length);palette.push(stateTag(state));}const nbt=blockNBT(b,model,options);blocks.push({pos:list(3,b.pos),state:int(indices.get(key)),...(nbt?{nbt:compound(nbt)}:{})});}
  return gzipNBT(compound({DataVersion:int(Number(options.dataVersion)||1519),size:list(3,model.size),palette:list(10,palette),blocks:list(10,blocks),entities:list(10,entities),NBSWebScore:metadata}));
}
export async function parseStructure(input){
  const {name,value}=await readNBT(input),warnings=[];let size,blocks=[];
  if(name==='Schematic'||value.Blocks){const {Width:w,Height:h,Length:l,Blocks:ids,Data:data}=value;if(![w,h,l].every(n=>Number.isInteger(n)&&n>0&&n<=32767)||w*h*l>16000000||!(ids instanceof Uint8Array)||ids.length!==w*h*l||!data||data.length!==ids.length)throw new Error('Alpha Schematic 尺寸或方块数组无效。');if(value.AddBlocks?.some(n=>n))throw new Error('不支持扩展方块 ID 的 Schematic。');size=[w,h,l];const tes=new Map((value.TileEntities||[]).map(te=>[posKey(te.x,te.y,te.z),te]));for(let y=0;y<h;y++)for(let z=0;z<l;z++)for(let x=0;x<w;x++){const i=(y*l+z)*w+x;if(ids[i]){const b={pos:[x,y,z],id:ids[i],data:data[i],nbt:tes.get(posKey(x,y,z))};if(b.id===25)b.note={key:33+Number(b.nbt?.note||0)};blocks.push(b);}}
  }else if(Array.isArray(value.size)&&Array.isArray(value.palette)&&Array.isArray(value.blocks)){size=value.size;if(size.length!==3||!size.every(n=>Number.isInteger(n)&&n>0&&n<=32767)||value.blocks.length>2000000)throw new Error('结构尺寸无效或过大。');const seen=new Set();for(const item of value.blocks){const state=value.palette[item.state],pos=item.pos;if(!state||typeof state.Name!=='string'||!Array.isArray(pos)||pos.length!==3||!pos.every((n,i)=>Number.isInteger(n)&&n>=0&&n<size[i]))throw new Error('结构方块调色板或坐标无效。');const k=posKey(...pos);if(seen.has(k))throw new Error('结构包含重叠坐标。');seen.add(k);if(state.Name==='minecraft:air'||state.Name==='minecraft:structure_void')continue;const name=state.Name.replace(/^minecraft:/,'');let id=name==='note_block'?25:name==='repeater'?93:name==='redstone_wire'?55:name.includes('redstone')&&name.includes('torch')?76:name.endsWith('_button')?77:name==='lever'?69:name==='command_block'?137:1;const b={pos,state,id,nbt:item.nbt};if(id===25)b.note={key:33+Number(state.Properties?.note||0),instrument:Math.max(0,INSTRUMENTS.indexOf(state.Properties?.instrument))};if(id===93){const p=state.Properties;b.data=({south:0,west:1,north:2,east:3})[p?.facing]??0;b.data+=4*(Math.max(1,Math.min(4,Number(p?.delay)||1))-1);}blocks.push(b);}
  }else throw new Error('文件不是 Alpha Schematic 或 Java 结构 NBT。');
  let embedded=null;if(value.NBSWebScore instanceof Uint8Array){try{const data=JSON.parse(dec.decode(value.NBSWebScore));if(data.version===1)embedded=normalizeSong(data.song);}catch{warnings.push('内嵌乐谱无效，将从红石电路重建。');}}
  return{size,blocks,embedded,warnings};
}
const directions=[[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]];
const add=(p,d)=>p.map((n,i)=>n+d[i]);
function supportInstrument(b){let ins=SUPPORT_IDS.indexOf(b?.id);if(ins>=0)return ins;const id=b?.id;if([5,17,25,47,53,54,58,64,85,96,107,125,126,134,135,136,162,163,164].includes(id))return 1;if([1,4,7,14,15,16,21,22,24,43,44,48,49,56,57,61,62,67,73,74,87,98,108,109,112,114,121,128,129,139,145,152,153,155,156,159,168,172,179,180,181,182,201].includes(id))return 2;if(id===13)return 3;if(id===95||id===102||id===160)return 4;const name=b?.state?.Name?.replace(/^minecraft:/,'')||'';ins=SUPPORT_NAMES.indexOf(name);if(ins>=0)return ins;if(name.endsWith('_wool'))return 5;if(/(?:planks|log|wood|bookshelf)$/.test(name))return 1;if(/(?:glass|glass_pane)$/.test(name))return 4;if(/(?:stone|ore|brick|terracotta|obsidian|quartz|basalt)$/.test(name))return 2;if(name==='gravel'||name==='red_sand')return 3;return 0;}
function noteFromBlock(b,map){if(b.note){const instrument=b.note.instrument??supportInstrument(map.get(posKey(b.pos[0],b.pos[1]-1,b.pos[2])));return{key:Math.max(0,Math.min(87,b.note.key)),instrument,velocity:100,pan:0,pitch:0};}
  if(b.id===137&&typeof b.nbt?.Command==='string'){const m=b.nbt.Command.match(/playsound\s+([^\s]+)\s+[^\s]+\s+[^\s]+\s+(?:[^\s]+\s+){3}([\d.]+)\s+([\d.]+)/);if(m){const event=m[1],extended=event.endsWith('_-1')?-24:event.endsWith('_1')?24:0,name=event.split('.').pop().replace(/_[-]?1$/,'');return{key:Math.round(45+12*Math.log2(Number(m[3]))+extended),instrument:Math.max(0,INSTRUMENTS.indexOf(name)),velocity:Math.min(100,Number(m[2])*100),pan:0,pitch:0};}}return null;
}
/** Trace rising pulses in imported circuits, respecting repeater direction/delay.
 * Redstone wire climbs one block where unobstructed. Torch inversions add one tick.
 * Cycles are visited at their first arrival; repeated loops are represented once.
 */
export function importCircuit(model,options={}){
  if(model.embedded&&options.preferEmbedded!==false)return{song:model.embedded,warnings:[...model.warnings],summary:{source:'embedded',notes:model.embedded.notes.length}};
  const map=new Map(model.blocks.map(b=>[posKey(...b.pos),b])),inputs=model.blocks.filter(b=>b.id===77||b.id===69),noteBlocks=model.blocks.filter(b=>noteFromBlock(b,map)),arrivals=new Map(),warnings=[...model.warnings];
  if(noteBlocks.length>MAX_NOTES)throw new Error(`结构音符超过项目上限 ${MAX_NOTES}。`);
  const queue=[],best=new Map();const push=(b,t,from)=>{if(!b)return;const k=posKey(...b.pos);if(best.has(k)&&best.get(k)<=t)return;best.set(k,t);const item={b,t,from};queue.push(item);let i=queue.length-1;while(i>0){const p=(i-1)>>1;if(queue[p].t<=t)break;queue[i]=queue[p];i=p;}queue[i]=item;};
  const pop=()=>{const item=queue[0],end=queue.pop();if(queue.length){let i=0;while(i*2+1<queue.length){let child=i*2+1;if(child+1<queue.length&&queue[child+1].t<queue[child].t)child++;if(queue[child].t>=end.t)break;queue[i]=queue[child];i=child;}queue[i]=end;}return item;};
  for(const b of inputs)push(b,0,null);let visits=0;
  while(queue.length){if(++visits>8000000)throw new Error('红石电路过于复杂。');const {b,t}=pop(),k=posKey(...b.pos);if(t!==best.get(k))continue;const n=noteFromBlock(b,map);if(n)arrivals.set(k,t);
    const rep=b.id===93||b.id===94,torch=b.id===75||b.id===76,wire=b.id===55,input=b.id===77||b.id===69;
    if(rep){const d=directions[(b.data||0)%4],out=map.get(posKey(...add(b.pos,d)));push(out,t+1+((b.data||0)>>2&3),b);continue;}
    for(const d of directions){for(const dy of wire?[0,1,-1]:[0]){const p=add(b.pos,d);p[1]+=dy;const next=map.get(posKey(...p));if(!next)continue;if(next.id===93||next.id===94){const out=directions[(next.data||0)%4],inputPos=add(next.pos,out.map(v=>-v));if(posKey(...inputPos)!==k)continue;}
        const conductive=[25,55,69,75,76,77,93,94,137].includes(next.id);if(!conductive&&!input&&!rep&&!torch)continue;if(!wire&&!input&&!torch&&next.id===1)continue;push(next,t+Number(torch),b);}}
    if(input||wire||torch){const below=map.get(posKey(b.pos[0],b.pos[1]-1,b.pos[2]));if(below&&!noteFromBlock(below,map))push(below,t+Number(torch),b);}
    if(!wire&& !input){for(const dy of [-1,1]){const next=map.get(posKey(b.pos[0],b.pos[1]+dy,b.pos[2]));if(next&&(next.id===75||next.id===76||next.id===25))push(next,t+Number(torch),b);}}
  }
  let first=Infinity;for(const time of arrivals.values())first=Math.min(first,time);
  if(!Number.isFinite(first)){warnings.push('未能从按钮或拉杆追踪到音符；按所选方向的方块位置导入时间。');first=0;const direction=options.direction||'north',axis=direction==='east'||direction==='west'?0:2,sign=direction==='south'||direction==='east'?1:-1,coords=noteBlocks.map(b=>sign*b.pos[axis]);let min=Infinity;for(const coordinate of coords)min=Math.min(min,coordinate);for(let i=0;i<noteBlocks.length;i++)arrivals.set(posKey(...noteBlocks[i].pos),Math.round((coords[i]-min)/2));}
  const byTick=new Map(),notes=[],tempo=Number(options.tempo)||10;let maxLayer=0,maxTick=0;for(const b of noteBlocks){const time=arrivals.get(posKey(...b.pos));if(time===undefined)continue;const tick=Math.max(0,Math.round((time-first)*tempo/10)),layer=byTick.get(tick)||0;if(!Number.isSafeInteger(tick)||tick>=1000000||layer>=MAX_LAYERS)throw new Error('结构时间或同时发声图层超过项目范围。');byTick.set(tick,layer+1);notes.push({...noteFromBlock(b,map),tick,layer});maxLayer=Math.max(maxLayer,layer);maxTick=Math.max(maxTick,tick);}
  if(!notes.length)throw new Error('结构中没有可识别的音符盒或 playsound 命令方块。');if(notes.length<noteBlocks.length)warnings.push(`${noteBlocks.length-notes.length} 个音符未连接到可追踪的输入，已跳过。`);
  warnings.push('外部电路按首次脉冲重建；复杂锁存器、活塞和重复回路需在游戏内核对。');const song=normalizeSong({...createBlankSong(),title:options.title||'导入的 Minecraft 电路',tempo:Number(options.tempo)||10,layers:Array.from({length:maxLayer+1},(_,id)=>({id,name:`声部 ${id+1}`,volume:100})),notes,length:maxTick+1});return{song,warnings,summary:{source:'redstone',notes:notes.length}};
}
