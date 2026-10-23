/** Local ZIP32 archives. Stored writing; stored/DEFLATE reading with CRC checks. */
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;};
const bytesOf=input=>typeof input==='string'?encoder.encode(input):input instanceof Uint8Array?input:input instanceof ArrayBuffer?new Uint8Array(input):ArrayBuffer.isView(input)?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):null;
function safeName(name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').some(part=>part==='..'||part==='.')||name.split('/').slice(0,-1).some(part=>!part))throw new Error('ZIP 包含不安全路径。');
  return name;
}
const limits=options=>({maxEntries:65534,maxEntryBytes:128*1024*1024,maxTotalBytes:256*1024*1024,...options});
export async function writeZip(entries,options={}){
  const limit=limits(options);if(!Array.isArray(entries)||entries.length>limit.maxEntries)throw new Error('ZIP 文件条目过多。');
  const seen=new Set(),prepared=[];let total=0,localSize=0,centralSize=0;
  for(const entry of entries){const name=safeName(entry.name);if(seen.has(name))throw new Error(`ZIP 路径重复：${name}`);seen.add(name);
    const filename=encoder.encode(name),data=bytesOf(entry.data);if(!data)throw new TypeError('ZIP 内容必须是字符串或二进制数据。');
    if(filename.length>65535||data.length>limit.maxEntryBytes||(total+=data.length)>limit.maxTotalBytes)throw new Error('ZIP 超过本地大小限制。');
    prepared.push({filename,data,crc:crc32(data),offset:localSize});localSize+=30+filename.length+data.length;centralSize+=46+filename.length;
  }
  if(localSize+centralSize+22>0xffffffff)throw new Error('不支持 ZIP64。');
  if(localSize+centralSize+22>limit.maxTotalBytes+16*1024*1024)throw new Error('ZIP 文件头超过大小限制。');
  const out=new Uint8Array(localSize+centralSize+22),view=new DataView(out.buffer);let at=0;
  for(const e of prepared){view.setUint32(at,0x04034b50,true);view.setUint16(at+4,20,true);view.setUint16(at+6,0x800,true);view.setUint32(at+14,e.crc,true);view.setUint32(at+18,e.data.length,true);view.setUint32(at+22,e.data.length,true);view.setUint16(at+26,e.filename.length,true);out.set(e.filename,at+30);out.set(e.data,at+30+e.filename.length);at+=30+e.filename.length+e.data.length;}
  const centralAt=at;
  for(const e of prepared){view.setUint32(at,0x02014b50,true);view.setUint16(at+4,20,true);view.setUint16(at+6,20,true);view.setUint16(at+8,0x800,true);view.setUint32(at+16,e.crc,true);view.setUint32(at+20,e.data.length,true);view.setUint32(at+24,e.data.length,true);view.setUint16(at+28,e.filename.length,true);view.setUint32(at+42,e.offset,true);out.set(e.filename,at+46);at+=46+e.filename.length;}
  view.setUint32(at,0x06054b50,true);view.setUint16(at+8,prepared.length,true);view.setUint16(at+10,prepared.length,true);view.setUint32(at+12,at-centralAt,true);view.setUint32(at+16,centralAt,true);return out;
}
export async function decompress(bytes,format='gzip',maxBytes=256*1024*1024){
  let transform;try{if(typeof DecompressionStream!=='function')throw new Error('unavailable');transform=new DecompressionStream(format);}catch(error){
    // Node18 exposes web compression streams but may lack deflate-raw. This
    // branch is never imported by a browser and retains the same output bound.
    if(globalThis.process?.versions?.node){const zlib=await import('node:zlib'),fn=format==='deflate-raw'?zlib.inflateRawSync:format==='gzip'?zlib.gunzipSync:format==='deflate'?zlib.inflateSync:null;if(!fn)throw new Error('不支持的压缩方式。');const result=new Uint8Array(fn(bytes,{maxOutputLength:Math.max(1,maxBytes)}));if(result.length>maxBytes)throw new Error('解压后的文件超过大小限制。');return result;}
    throw new Error('浏览器不支持本地解压，请使用新版 Chrome、Edge 或 Firefox。');
  }
  const reader=new Blob([bytes]).stream().pipeThrough(transform).getReader(),chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new Error('解压后的文件超过大小限制。');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}return out;
}
export async function compress(bytes,format='gzip'){
  let transform;try{if(typeof CompressionStream!=='function')throw new Error('unavailable');transform=new CompressionStream(format);}catch(error){if(globalThis.process?.versions?.node){const zlib=await import('node:zlib'),fn=format==='deflate-raw'?zlib.deflateRawSync:format==='gzip'?zlib.gzipSync:format==='deflate'?zlib.deflateSync:null;if(fn)return new Uint8Array(fn(bytes));}throw new Error('浏览器不支持本地压缩。');}
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());
}
export async function readZip(input,options={}){
  const bytes=bytesOf(input),limit=limits(options);if(!bytes||bytes.length<22||bytes.length>limit.maxTotalBytes+16*1024*1024)throw new Error('ZIP 文件大小无效。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),need=(at,n)=>{if(at<0||n<0||at+n>bytes.length)throw new Error('ZIP 文件截断。');};
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
  if(end<0)throw new Error('ZIP 缺少中央目录。');
  const count=view.getUint16(end+10,true),centralSize=view.getUint32(end+12,true),centralAt=view.getUint32(end+16,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count===65535||centralAt===0xffffffff||centralSize===0xffffffff)throw new Error('不支持分卷或 ZIP64。');
  if(count>limit.maxEntries||centralAt+centralSize>end)throw new Error('ZIP 中央目录无效。');
  let at=centralAt,total=0;const names=new Set(),result=new Map();
  for(let i=0;i<count;i++){
    need(at,46);if(view.getUint32(at,true)!==0x02014b50)throw new Error('ZIP 中央条目无效。');
    const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),crc=view.getUint32(at+16,true),packed=view.getUint32(at+20,true),expanded=view.getUint32(at+24,true),nameLength=view.getUint16(at+28,true),extraLength=view.getUint16(at+30,true),commentLength=view.getUint16(at+32,true),localAt=view.getUint32(at+42,true);
    need(at+46,nameLength+extraLength+commentLength);const name=safeName(decoder.decode(bytes.subarray(at+46,at+46+nameLength)));
    if(names.has(name))throw new Error(`ZIP 路径重复：${name}`);names.add(name);
    if(flags&1||![0,8].includes(method)||view.getUint16(at+34,true))throw new Error('ZIP 包含加密、分卷或不支持的压缩方式。');
    if(expanded>limit.maxEntryBytes||(total+=expanded)>limit.maxTotalBytes)throw new Error('ZIP 解压内容超过大小限制。');
    need(localAt,30);if(view.getUint32(localAt,true)!==0x04034b50)throw new Error('ZIP 本地条目无效。');
    const localNameLength=view.getUint16(localAt+26,true),localExtra=view.getUint16(localAt+28,true);need(localAt+30,localNameLength+localExtra);
    if(decoder.decode(bytes.subarray(localAt+30,localAt+30+localNameLength))!==name||view.getUint16(localAt+8,true)!==method||(view.getUint16(localAt+6,true)&1))throw new Error('ZIP 本地条目与中央目录不一致。');
    const start=localAt+30+localNameLength+localExtra;need(start,packed);if(start+packed>centralAt)throw new Error('ZIP 数据与中央目录重叠。');
    const data=method===0?bytes.slice(start,start+packed):await decompress(bytes.subarray(start,start+packed),'deflate-raw',Math.min(expanded,limit.maxEntryBytes));
    if(data.length!==expanded||crc32(data)!==crc)throw new Error(`ZIP 文件校验失败：${name}`);
    if(!name.endsWith('/'))result.set(name,data);at+=46+nameLength+extraLength+commentLength;
  }
  if(at!==centralAt+centralSize)throw new Error('ZIP 中央目录长度不一致。');return result;
}
