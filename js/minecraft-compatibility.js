import {controlType} from './tempo-map.js';

/** Original control_draw.gml status rule; this is an editor hint, not an export/game simulation. */
export function analyzeMinecraftCompatibility(song){
  let custom=false,outside=false,pitched=false;
  const controls=new Set();
  for(const note of song?.notes||[]){
    const control=controlType(note,song);
    // These definitions compile into transport/visual controls, never audio
    // resources. Classify conservatively by name even when their current map
    // happens to leave the base tempo unchanged or a control layer is muted.
    if(control){controls.add(control==='tempo'?'Tempo Changer':'Toggle Rainbow');continue;}
    if(Number(note.instrument)>=16)custom=true;
    if(Number(note.key)<33||Number(note.key)>57)outside=true;
    if(Number(note.pitch||0)!==0)pitched=true;
  }
  const tempo=Number(song?.tempo),standardTempo=[10,5,2.5].includes(tempo),reasons=[];
  if(custom)reasons.push('包含自定义采样音色');
  if(outside)reasons.push('音高超出原版音符盒 33–57 音域');
  if(!standardTempo)reasons.push('速度不是原版电路支持的 10、5 或 2.5 tick/秒');
  if(pitched)reasons.push('包含微调音高');
  if(controls.size)reasons.push(`包含 ${[...controls].join(' / ')} 控制音色（不是音频资源），需核对导出控制与时序`);
  if(custom||outside)return{level:'resourcepack',label:'需要资源包',reason:reasons.join('；'),frames:[1,2]};
  if(!standardTempo||pitched||controls.size)return{level:'datapack',label:'需要数据包或命令方块',reason:reasons.join('；'),frames:[1,0]};
  return{level:'full',label:'兼容原版音符盒',reason:'音色和音域属于原版音符盒，速度为 10、5 或 2.5 tick/秒，且没有微调音高。',frames:[0,0]};
}
