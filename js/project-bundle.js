import {writeZip,readZip} from './archive.js';
import {normalizeSong} from './model.js';

/** IEEE float WAVE keeps every decoded channel and float sample in a portable project. */
export function encodeProjectSample(buffer){
  const channels=buffer.numberOfChannels,frames=buffer.length,out=new Uint8Array(44+channels*frames*4),view=new DataView(out.buffer),text=(at,value)=>{for(let i=0;i<value.length;i++)out[at+i]=value.charCodeAt(i);};
  text(0,'RIFF');view.setUint32(4,out.length-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,3,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*4,true);view.setUint16(32,channels*4,true);view.setUint16(34,32,true);text(36,'data');view.setUint32(40,out.length-44,true);
  const data=Array.from({length:channels},(_,ch)=>buffer.getChannelData(ch));let at=44;
  for(let frame=0;frame<frames;frame++)for(let ch=0;ch<channels;ch++,at+=4)view.setFloat32(at,data[ch][frame],true);
  return out;
}

export async function writeProjectBundle(project,samples=new Map()) {
  const manifest={format:'ONBS Web Project',version:1,project:'project.json',samples:[]};
  const entries=[{name:'project.json',data:JSON.stringify(project)}];
  for(const [index,buffer] of samples){
    if(!Number.isInteger(index)||index<0||index>=project.customInstruments.length)continue;
    const path=`samples/${index}.wav`;manifest.samples.push({index,path});
    entries.push({name:path,data:encodeProjectSample(buffer)});
  }
  entries.unshift({name:'manifest.json',data:JSON.stringify(manifest)});
  return writeZip(entries);
}
export async function readProjectBundle(bytes){
  const entries=await readZip(bytes),decode=path=>{
    const data=entries.get(path);if(!data)throw new Error(`工程包缺少 ${path}`);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  };
  const manifest=decode('manifest.json');
  if(manifest.format!=='ONBS Web Project'||manifest.version!==1||manifest.project!=='project.json'||!Array.isArray(manifest.samples))throw new Error('不是受支持的完整工程包。');
  const project=normalizeSong(decode('project.json')),samples=[],seen=new Set();
  for(const sample of manifest.samples){
    if(!Number.isInteger(sample.index)||sample.index<0||sample.index>=project.customInstruments.length||seen.has(sample.index)||sample.path!==`samples/${sample.index}.wav`)throw new Error('工程采样清单无效。');
    const data=entries.get(sample.path);if(!data||data.byteLength>128*1024*1024)throw new Error('工程包采样缺失或超过 128 MB。');
    seen.add(sample.index);samples.push({index:sample.index,bytes:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)});
  }
  return {project,samples};
}

/** Only copy PCM when the sample bank changes, preserving the engine's own buffers. */
export function snapshotSampleBank(bank,previous=new Map()){
  if(bank.size===previous.size&&[...bank].every(([index,buffer])=>previous.get(index)===buffer))return null;
  return {identity:new Map(bank),samples:[...bank].map(([index,buffer])=>({index,sampleRate:buffer.sampleRate,channels:Array.from({length:buffer.numberOfChannels},(_,ch)=>buffer.getChannelData(ch).slice())}))};
}
export function restoreSampleBank(samples,{AudioBufferClass=globalThis.AudioBuffer,maxIndex=240}={}){
  const bank=new Map();
  for(const sample of samples||[]){
    if(!Number.isInteger(sample.index)||sample.index<0||sample.index>=maxIndex||!Array.isArray(sample.channels)||!sample.channels.length||sample.channels.length>32)throw new Error('保存的采样数据无效。');
    const length=sample.channels[0].length;
    if(sample.channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==length)||length*sample.channels.length>32*1024*1024||!Number.isFinite(sample.sampleRate)||sample.sampleRate<8000||sample.sampleRate>384000)throw new Error('保存的 PCM 数据超出限制。');
    const buffer=new AudioBufferClass({length,numberOfChannels:sample.channels.length,sampleRate:sample.sampleRate});
    sample.channels.forEach((channel,ch)=>buffer.getChannelData(ch).set(channel));bank.set(sample.index,buffer);
  }
  return bank;
}
