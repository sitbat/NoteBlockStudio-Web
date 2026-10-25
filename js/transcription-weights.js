/** Restricted tensor layout adaptation in the model Worker; no executable package code. */
const bad=message=>Object.assign(new Error(message),{code:'MODEL_WEIGHT_LAYOUT'});
const safeInt=value=>Number.isSafeInteger(value)&&value>=0;
const elements=shape=>{
  if(!Array.isArray(shape)||shape.length>8||shape.some(n=>!Number.isSafeInteger(n)||n<1))throw bad('模型张量形状无效。');
  const count=shape.reduce((a,b)=>a*b,1);if(!Number.isSafeInteger(count)||count>450*1024*1024)throw bad('模型张量过大。');return count;
};
const sameShape=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const checkAbort=signal=>{if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');};
export async function readSafetensorsHeader(blob){
  if(!(blob instanceof Blob)||blob.size<10)throw bad('权重文件无效。');
  const prefix=new DataView(await blob.slice(0,8).arrayBuffer()),length=Number(prefix.getBigUint64(0,true));
  if(!Number.isSafeInteger(length)||length<2||length>1024*1024||length+8>blob.size)throw bad('safetensors 文件头过大或不完整。');
  let tensors;try{tensors=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await blob.slice(8,8+length).arrayBuffer()));}catch{throw bad('safetensors 文件头无法解析。');}
  if(!tensors||typeof tensors!=='object'||Array.isArray(tensors))throw bad('权重索引无效。');
  const intervals=[];
  for(const [key,tensor]of Object.entries(tensors)){
    if(key==='__metadata__')continue;
    const count=elements(tensor.shape),offset=tensor.data_offsets;
    if(tensor.dtype!=='F32'||!Array.isArray(offset)||offset.length!==2||!offset.every(safeInt)||offset[1]-offset[0]!==count*4||offset[1]+length+8>blob.size)throw bad(`权重张量格式不匹配：${key}。`);
    intervals.push(offset);
  }
  intervals.sort((a,b)=>a[0]-b[0]);let end=0;
  for(const [first,last]of intervals){if(first!==end)throw bad('权重文件包含重叠或缺失的数据区。');end=last;}
  if(end+length+8!==blob.size)throw bad('权重文件长度与索引不一致。');
  return {tensors,dataOffset:length+8};
}

export async function adaptTranscriptionWeights(blob,map,{signal,onProgress=()=>{},yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0))}={}){
  checkAbort(signal);
  if(map?.kind!=='nbs-muscriptor-weight-map'||map.version!==1||map.target?.path!=='weights.bin'||!safeInt(map.target.bytes)||map.target.bytes<1||map.target.bytes>1800*1024*1024||!map.source?.tensors||!Array.isArray(map.segments)||map.segments.length<1||map.segments.length>10000)throw bad('权重映射协议不兼容。');
  const {tensors,dataOffset}=await readSafetensorsHeader(blob),sources=new Map(),chunks=[];
  for(const [key,spec]of Object.entries(map.source.tensors)){
    if(spec.dtype!=='F32'||!Array.isArray(spec.aliases||[])||(spec.aliases||[]).some(alias=>typeof alias!=='string'))throw bad('模型权重类型或别名无效。');
    elements(spec.shape);const found=[key,...spec.aliases||[]].filter(name=>Object.hasOwn(tensors,name));
    if(found.length!==1||!sameShape(tensors[found[0]].shape,spec.shape))throw bad(`权重版本或张量尺寸不匹配：${key}。`);
    sources.set(key,tensors[found[0]]);
  }
  let completed=0;onProgress({stage:'convert',loaded:0,total:map.target.bytes});
  for(const segment of map.segments){
    checkAbort(signal);const spec=sources.get(segment.sourceKey),shape=segment.sourceShape;
    if(!spec||segment.offset!==completed||!safeInt(segment.bytes)||segment.bytes<1||segment.offset+segment.bytes>map.target.bytes||segment.sourceDtype!=='F32'||segment.targetDtype!=='F32'||!sameShape(shape,spec.shape)||elements(segment.shape)*4!==segment.bytes)throw bad('权重映射超出目标或源张量范围。');
    const first=dataOffset+spec.data_offsets[0],last=dataOffset+spec.data_offsets[1];let output;
    if(segment.op==='copy'){
      if(segment.bytes!==last-first||!sameShape(segment.shape,shape))throw bad('直接映射的张量尺寸不匹配。');output=blob.slice(first,last);
    }else if(segment.op==='slice'){
      const {start,count}=segment.slice||{};
      if(!safeInt(start)||!safeInt(count)||count<1||count*4!==segment.bytes||(start+count)*4>last-first)throw bad('权重切片超出源张量。');output=blob.slice(first+start*4,first+(start+count)*4);
    }else if(segment.op==='transpose2d'){
      if(shape.length!==2||!sameShape(segment.shape,[shape[1],shape[0]]))throw bad('只支持二维张量转置。');
      const source=new Uint32Array(await blob.slice(first,last).arrayBuffer()),target=new Uint32Array(source.length),[rows,columns]=shape;
      for(let row=0;row<rows;row++){
        for(let column=0;column<columns;column++)target[column*rows+row]=source[row*columns+column];
        if(row%128===127){checkAbort(signal);await yieldTask();}
      }
      output=new Blob([target]);
    }else throw bad('模型要求未支持的权重变换。');
    chunks.push(output);completed+=segment.bytes;onProgress({stage:'convert',loaded:completed,total:map.target.bytes});await yieldTask();
  }
  if(completed!==map.target.bytes)throw bad('权重映射没有覆盖完整目标文件。');
  checkAbort(signal);return new Blob(chunks,{type:'application/octet-stream'});
}
