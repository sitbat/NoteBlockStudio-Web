/** Stage complete layer edits before assigning either layers or notes. */
import {MAX_LAYERS,MAX_NOTES,uniqueId} from './model.js';
export function applyLayerOperation(song,{operation,index}={}){
  if(!song||!Array.isArray(song.layers)||!Array.isArray(song.notes)||!Number.isInteger(index)||index<0||index>=song.layers.length)throw new Error('当前图层无效。');
  if(!['up','down','insert','duplicate','remove-empty'].includes(operation))throw new Error('未知图层操作。');
  if(song.notes.length>MAX_NOTES||song.layers.length>MAX_LAYERS)throw new Error('项目已超过音符或图层上限。');
  for(const note of song.notes)if(!Number.isInteger(note.layer)||note.layer<0||note.layer>=song.layers.length)throw new Error('项目包含无效图层引用。');
  let layers=song.layers.slice(),notes=song.notes,selected=index;
  if(operation==='up'||operation==='down'){
    const target=index+(operation==='up'?-1:1);if(target<0||target>=layers.length)return{changed:false,layer:index};
    if(layers[index].locked||layers[target].locked)throw new Error('请先解锁需要移动的图层。');
    [layers[index],layers[target]]=[layers[target],layers[index]];
    notes=song.notes.map(note=>note.layer===index?{...note,layer:target}:note.layer===target?{...note,layer:index}:note);selected=target;
  }else if(operation==='remove-empty'){
    const used=new Set(song.notes.map(note=>note.layer)),mapping=new Map();
    layers=[];for(let previous=0;previous<song.layers.length;previous++){const layer=song.layers[previous];if(used.has(previous)||layer.locked||previous===index){mapping.set(previous,layers.length);layers.push(layer);}}
    if(layers.length===song.layers.length)return{changed:false,layer:index};
    notes=song.notes.map(note=>({...note,layer:mapping.get(note.layer)}));selected=mapping.get(index);
  }else{
    if(layers.length>=MAX_LAYERS)throw new Error('已达到图层上限。');
    const duplicate=operation==='duplicate',at=duplicate?index+1:index;
    const source=duplicate?song.notes.filter(note=>note.layer===index):[];
    if(song.notes.length+source.length>MAX_NOTES)throw new Error('复制后音符数量超出上限。');
    const inserted=duplicate?{...layers[index],name:`${layers[index].name} 副本`}:{name:'新图层',volume:100,pan:0,reverb:0,muted:false,solo:false,locked:false};
    layers.splice(at,0,inserted);notes=song.notes.map(note=>note.layer>=at?{...note,layer:note.layer+1}:note);
    // No argument spread: a legal one-layer selection may contain a million notes.
    for(const note of source)notes.push({...note,id:uniqueId(),layer:at});selected=at;
  }
  layers=layers.map((layer,id)=>({...layer,id}));
  notes=notes.slice().sort((a,b)=>a.tick-b.tick||a.layer-b.layer);
  // No project mutation occurs before all allocations, checks and ID creation succeed.
  song.layers=layers;song.notes=notes;
  return{changed:true,layer:selected};
}
