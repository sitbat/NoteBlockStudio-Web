import {readZip} from './archive.js';
import {downloadTranscriptionBlob,sha256Blob} from './transcription-download.js';
import {adaptTranscriptionWeights} from './transcription-weights.js';
import {TRANSCRIPTION_PREPROCESSING_PATCHES} from './transcription-preprocessing-patches.js';
const MAX_FILE=1800*1024*1024,MAX_TOTAL=2*1024*1024*1024,MAX_MANIFEST=256*1024;
const safePath=value=>typeof value==='string'&&value.length<240&&!/[\\%?#\x00-\x20\x7f]/.test(value)&&!value.startsWith('/')&&!/^[a-z]:/i.test(value)&&value.split('/').every(part=>part&&!part.startsWith('.')&&!part.includes(':'));
const error=(message,code='MODEL_INVALID')=>Object.assign(new Error(message),{code});
export function validateTranscriptionManifest(input){
  if(!input||input.kind!=='nbs-muscriptor-onnx'||input.version!==1)throw error('请选择由本项目导出器生成的 MuScriptor 浏览器模型包。');
  const manifest=structuredClone(input);
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(manifest.id)||!['small','medium','large'].includes(manifest.variant)||!['fp32','fp16','int8','int4'].includes(manifest.precision))throw error('模型标识、档位或精度无效。');
  for(const [name,expected]of Object.entries({sampleRate:16000,chunkSamples:80000,melFrames:501,melBins:512,prefixLength:503,headDim:64,validTokenUpperExclusive:1393}))if(manifest[name]!==expected)throw error(`模型协议字段不匹配：${name}。`);
  if(!Number.isInteger(manifest.layers)||manifest.layers<1||manifest.layers>48||!Number.isInteger(manifest.heads)||manifest.heads<1||manifest.heads>24||![1393,1395].includes(manifest.card)||manifest.bos!==manifest.card||!Number.isInteger(manifest.maxTokens)||manifest.maxTokens<1||manifest.maxTokens>2000)throw error('模型网络结构或生成上限无效。');
  if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>64)throw error('模型文件清单无效。');
  const names=new Set();let total=0;
  for(const file of manifest.files){if(!safePath(file.path)||names.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>MAX_FILE||!/^[a-f0-9]{64}$/.test(file.sha256))throw error('模型文件路径、大小或校验和无效。');names.add(file.path);total+=file.bytes;}
  if(total>MAX_TOTAL)throw error('模型包超过当前浏览器加载上限 2 GiB。量化后重新导出，或选择较小模型。','MODEL_TOO_LARGE');
  for(const role of ['prefill','step'])if(!names.has(manifest.graphs?.[role])||!manifest.graphs[role].endsWith('.onnx'))throw error(`缺少 ${role} 推理图。`);
  if(manifest.externalData!==undefined&&(!Array.isArray(manifest.externalData)||new Set(manifest.externalData).size!==manifest.externalData.length))throw error('ONNX 外部权重清单无效。');
  for(const name of manifest.externalData||[])if(!names.has(name))throw error('缺少 ONNX 外部权重文件。');
  for(const role of ['window','melFilter'])if(manifest.preprocessing?.[role]&&!names.has(manifest.preprocessing[role]))throw error('缺少数值预处理参数。');
  for(const [role,bytes]of [['window',8192],['melFilter',2099200]])if(manifest.preprocessing?.[role]&&manifest.files.find(file=>file.path===manifest.preprocessing[role])?.bytes!==bytes)throw error('数值预处理参数尺寸不匹配。');
  manifest.totalBytes=total;const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};return freeze(manifest);
}
const requestResult=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||error('模型缓存读取失败。','CACHE_FAILED'));});
const completed=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||error('模型缓存写入失败，可能已超出浏览器存储配额。','CACHE_FAILED'));});
async function openDatabase(){
  if(!globalThis.indexedDB)throw error('浏览器未提供 IndexedDB，无法保存模型；请允许本站使用本地存储。','CACHE_UNAVAILABLE');
  const request=indexedDB.open('nbs-muscriptor-models-v1',1);
  request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('models',{keyPath:'id'});db.createObjectStore('assets',{keyPath:'key'});};
  return requestResult(request);
}
export async function listTranscriptionModels(){const db=await openDatabase();try{const models=await requestResult(db.transaction('models').objectStore('models').getAll());return models.map(({manifest,installedAt})=>({id:manifest.id,variant:manifest.variant,precision:manifest.precision,testOnly:!!manifest.testOnly,bytes:manifest.totalBytes,installedAt}));}finally{db.close();}}
async function readModelRecord(id){const db=await openDatabase();try{return await requestResult(db.transaction('models').objectStore('models').get(id));}finally{db.close();}}
/** Known built-in sources repair only their two checkpoint-derived coefficients. */
export async function getTranscriptionModel(id,options={}){const model=await readModelRecord(id);return model?.manifest?repairPreprocessing(model,options):null;}
export async function ensureTranscriptionModelPreprocessing(id,options={}){return getTranscriptionModel(id,options);}
export async function readTranscriptionAsset(id,path){const db=await openDatabase();try{const asset=await requestResult(db.transaction('assets').objectStore('assets').get(`${id}/${path}`));if(!asset?.data)throw error(`本地模型缺少文件 ${path}，请重新导入完整模型包。`);return new Uint8Array(await asset.data.arrayBuffer());}finally{db.close();}}
export async function clearTranscriptionModel(id){
  const db=await openDatabase();try{const models=await requestResult(db.transaction('models').objectStore('models').getAll()),selected=id?models.filter(m=>m.id===id):models;
    const tx=db.transaction(['models','assets'],'readwrite'),done=completed(tx);for(const model of selected){tx.objectStore('models').delete(model.id);for(const file of model.manifest.files)tx.objectStore('assets').delete(`${model.id}/${file.path}`);}await done;
  }finally{db.close();}
}
async function digest(bytes){if(!globalThis.crypto?.subtle)throw error('模型校验需要 HTTPS 或 localhost 安全上下文。');return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
const sameFile=(manifest,file)=>{const actual=manifest.files.find(item=>item.path===file?.path);return !!actual&&actual.bytes===file.bytes&&actual.sha256===file.sha256;};
const coefficientRoles=['window','melFilter'];
function patchBaseMatches(manifest,patch){
  return manifest.id===patch.modelId&&manifest.variant===patch.variant&&manifest.precision==='fp32'&&!manifest.testOnly&&manifest.source?.sha256===patch.source?.sha256&&manifest.source?.bytes===patch.source?.bytes
    &&['prefill','step'].every(role=>manifest.graphs?.[role]===patch.expected?.graphs?.[role]?.path&&sameFile(manifest,patch.expected.graphs[role]))&&sameFile(manifest,patch.expected?.mapping);
}
function patchApplied(manifest,patch){return patchBaseMatches(manifest,patch)&&coefficientRoles.every(role=>manifest.preprocessing?.[role]===patch.preprocessing[role]&&sameFile(manifest,patch.files.find(file=>file.path===patch.preprocessing[role])));}
function validateCoefficientPatch(patch){
  const validFile=file=>file&&safePath(file.path)&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&/^[a-f0-9]{64}$/.test(file.sha256||'');
  if(patch.version!==2||!['small','medium'].includes(patch.variant)||patch.modelId!==`muscriptor-${patch.variant}-fp32-source`||!/^[a-f0-9]{64}$/.test(patch.source?.sha256||'')||!Number.isSafeInteger(patch.source?.bytes)||patch.source.bytes<1||!Array.isArray(patch.files)||patch.files.length!==2||new Set(patch.files.map(file=>file.path)).size!==2)throw error('内置预处理修复清单无效。','MODEL_PATCH_INVALID');
  for(const role of ['prefill','step'])if(!validFile(patch.expected?.graphs?.[role]))throw error('内置预处理修复缺少推理图指纹。','MODEL_PATCH_INVALID');
  if(!validFile(patch.expected?.mapping))throw error('内置预处理修复缺少权重映射指纹。','MODEL_PATCH_INVALID');
  for(const [role,size]of [['window',8192],['melFilter',2099200]]){
    const previous=patch.expected?.preprocessing?.[role],next=patch.files.find(file=>file.path===patch.preprocessing?.[role]);
    if(!validFile(previous)||previous.bytes!==size||!validFile(next)||next.bytes!==size||previous.path===next.path||typeof next.url!=='string')throw error('内置预处理修复的参数尺寸或版本路径无效。','MODEL_PATCH_INVALID');
    const url=new URL(next.url,import.meta.url);if(url.origin!==new URL(import.meta.url).origin||url.username||url.password)throw error('内置预处理参数必须来自本站静态文件。','MODEL_PATCH_INVALID');
  }
  return patch;
}
async function repairPreprocessing(record,{signal,onProgress=()=>{},fetchImpl=globalThis.fetch,patches=TRANSCRIPTION_PREPROCESSING_PATCHES}={}){
  if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');
  const manifest=validateTranscriptionManifest(record.manifest),candidate=patches.find(patch=>patch.modelId===manifest.id);
  // Custom/test packages, source revisions and graph layouts are never guessed.
  if(!candidate||manifest.testOnly||manifest.variant!==candidate.variant||manifest.source?.sha256!==candidate.source?.sha256||manifest.source?.bytes!==candidate.source?.bytes)return manifest;
  const patch=validateCoefficientPatch(candidate);if(!patchBaseMatches(manifest,patch))return manifest;
  if(patchApplied(manifest,patch))return manifest;
  if(!coefficientRoles.every(role=>manifest.preprocessing?.[role]===patch.expected.preprocessing[role].path&&sameFile(manifest,patch.expected.preprocessing[role])))return manifest;
  for(const file of patch.files)if(manifest.files.some(item=>item.path===file.path)&&!sameFile(manifest,file))throw error('缓存中已存在不同的版本化预处理文件，未修改模型。','MODEL_PATCH_CONFLICT');
  const total=patch.files.reduce((sum,file)=>sum+file.bytes,0),assets=[];
  const progress=value=>onProgress({stage:'preprocessing',message:'更新前处理系数（2.1 MB），不重新下载权重。',total,variant:manifest.variant,revision:2,...value});
  progress({loaded:0});
  for(const file of patch.files){
    if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');
    const bytes=await fetchBounded(new URL(file.url,import.meta.url),file.bytes,{signal,fetchImpl});
    if(bytes.length!==file.bytes||await digest(bytes)!==file.sha256)throw error(`预处理修复参数校验失败：${file.path}。原模型缓存未修改。`,'MODEL_HASH_MISMATCH');
    assets.push({key:`${manifest.id}/${file.path}`,data:new Blob([bytes])});
    progress({path:file.path,loaded:assets.reduce((sum,asset)=>sum+asset.data.size,0)});
  }
  const binding={version:patch.version,modelId:patch.modelId,source:patch.source,expected:patch.expected,preprocessing:patch.preprocessing,files:patch.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))};
  const fingerprintSHA256=await digest(new TextEncoder().encode(JSON.stringify(binding))),files=manifest.files.map(file=>({...file}));
  for(const {path,bytes,sha256}of patch.files)if(!files.some(file=>file.path===path))files.push({path,bytes,sha256});
  const updated=validateTranscriptionManifest({...manifest,files,preprocessing:{...manifest.preprocessing,...patch.preprocessing},preprocessingVersion:2,preprocessingRevision:2,preprocessingPatch:{version:2,sourceSHA256:patch.source.sha256,fingerprintSHA256,previousPreprocessing:{...manifest.preprocessing},coefficients:Object.fromEntries(patch.files.map(file=>[file.path,file.sha256]))}});
  if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');
  const expected=JSON.stringify(record.manifest),db=await openDatabase();let abortWrite;
  try{
    if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');
    const tx=db.transaction(['models','assets'],'readwrite'),done=completed(tx);let problem=null,result=updated;
    abortWrite=()=>{try{tx.abort();}catch{/* Already committed or aborted. */}};signal?.addEventListener('abort',abortWrite,{once:true});
    const request=tx.objectStore('models').get(manifest.id);
    request.onerror=()=>{problem=request.error||error('模型缓存复核失败。','CACHE_FAILED');abortWrite();};
    request.onsuccess=()=>{
      try{
        if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');
        const current=request.result;
        if(current?.manifest&&patchApplied(validateTranscriptionManifest(current.manifest),patch)){result=validateTranscriptionManifest(current.manifest);return;}
        if(!current?.manifest||JSON.stringify(current.manifest)!==expected)throw error('模型缓存已被另一操作修改，本次预处理修复没有覆盖它。','MODEL_CACHE_CHANGED');
        // No async work in this transaction. In particular, never read/rewrite
        // the large weights Blob; old coefficients remain for explicit rollback.
        for(const asset of assets)tx.objectStore('assets').put(asset);
        tx.objectStore('models').put({...current,manifest:updated,preprocessingUpdatedAt:Date.now()});
      }catch(cause){problem=cause;abortWrite();}
    };
    try{await done;}catch(cause){if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');throw problem||cause;}
    progress({loaded:total,complete:true});return result;
  }finally{if(abortWrite)signal?.removeEventListener('abort',abortWrite);db.close();}
}
async function commitModel(manifest,blobs,{signal,onProgress=()=>{}}={}){
  if(signal?.aborted)throw new DOMException('模型导入已取消。','AbortError');
  onProgress({stage:'cache',loaded:0,total:manifest.totalBytes});
  const db=await openDatabase();let abortWrite;
  try{
    if(signal?.aborted)throw new DOMException('模型导入已取消。','AbortError');
    const tx=db.transaction(['models','assets'],'readwrite'),done=completed(tx);
    abortWrite=()=>{try{tx.abort();}catch{/* A completed transaction needs no rollback. */}};signal?.addEventListener('abort',abortWrite,{once:true});
    try{for(const blob of blobs)tx.objectStore('assets').put(blob);tx.objectStore('models').put({id:manifest.id,manifest,installedAt:Date.now()});await done;}
    catch(cause){abortWrite();await done.catch(()=>{});if(signal?.aborted)throw new DOMException('模型导入已取消。','AbortError');throw cause;}
  }finally{if(abortWrite)signal?.removeEventListener('abort',abortWrite);db.close();}
  onProgress({stage:'cache',loaded:manifest.totalBytes,total:manifest.totalBytes});return manifest;
}
async function fetchBounded(url,maximum,{signal,onProgress,fetchImpl=globalThis.fetch}={}){
  const response=await fetchImpl(url,{mode:'cors',credentials:'omit',signal,redirect:'follow'});if(!response.ok)throw error(`模型下载失败：HTTP ${response.status}。远程文件还必须允许浏览器跨来源读取。`,'MODEL_DOWNLOAD');
  const advertised=Number(response.headers.get('content-length'));if(Number.isFinite(advertised)&&advertised>maximum)throw error('模型下载超过声明大小。');
  const reader=response.body?.getReader();if(!reader){const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>maximum)throw error('模型下载超出上限。');return bytes;}
  const parts=[];let length=0;try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maximum)throw error('模型下载超出上限。');parts.push(value);onProgress?.(length);}}catch(cause){await reader.cancel().catch(()=>{});throw cause;}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
export async function installTranscriptionModel(source,{signal,onProgress=()=>{}}={}){
  let manifest,entries,base;
  if(source instanceof Blob){
    if(source.size>MAX_TOTAL+16*1024*1024)throw error('本地模型包超过 2 GiB。','MODEL_TOO_LARGE');
    if(/\.json$/i.test(source.name||''))throw error('单独的 model.json 不包含权重。请选择完整 ZIP 模型包，或填写 model.json 的网址。');
    entries=await readZip(await source.arrayBuffer(),{maxEntries:65,maxEntryBytes:MAX_FILE,maxTotalBytes:MAX_TOTAL+MAX_MANIFEST});
    const raw=entries.get('model.json');if(!raw||raw.length>MAX_MANIFEST)throw error('模型包根目录缺少 model.json。');manifest=validateTranscriptionManifest(JSON.parse(new TextDecoder().decode(raw)));
    const allowed=new Set(['model.json',...manifest.files.map(file=>file.path)]);for(const name of entries.keys())if(!allowed.has(name))throw error(`模型包存在清单之外的文件：${name}。`);
  }else{
    const url=new URL(String(source),globalThis.location?.href);if(url.username||url.password||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw error('远程模型地址必须使用 HTTPS；本机预览可使用 localhost。');
    const raw=await fetchBounded(url,MAX_MANIFEST,{signal});manifest=validateTranscriptionManifest(JSON.parse(new TextDecoder().decode(raw)));base=url;entries=new Map();
  }
  let downloaded=0;const blobs=[];
  for(const file of manifest.files){
    if(signal?.aborted)throw new DOMException('模型导入已取消。','AbortError');
    if(!base&&!entries.has(file.path))throw error(`模型包缺少声明的文件：${file.path}。`);
    const bytes=entries.get(file.path)||await fetchBounded(new URL(file.path,base),file.bytes,{signal,onProgress:current=>onProgress({stage:'download',path:file.path,loaded:downloaded+current,total:manifest.totalBytes})});
    if(bytes.length!==file.bytes||await digest(bytes)!==file.sha256)throw error(`模型校验失败：${file.path}。`,'MODEL_HASH_MISMATCH');
    blobs.push({key:`${manifest.id}/${file.path}`,data:new Blob([bytes])});entries.delete(file.path);downloaded+=bytes.length;onProgress({stage:'verify',path:file.path,loaded:downloaded,total:manifest.totalBytes});
  }
  if(signal?.aborted)throw new DOMException('模型导入已取消。','AbortError');
  return commitModel(manifest,blobs,{signal,onProgress});
}

/** The website hosts small graphs only. Large original weights come directly from the model host. */
export async function installTranscriptionSource(info,{signal,concurrency=2,onProgress=()=>{},fetchImpl=globalThis.fetch,estimate=()=>globalThis.navigator?.storage?.estimate?.()}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw error('模型下载并发数必须是 1–4 的整数。','INVALID_OPTIONS');
  if(!info?.available||!['small','medium'].includes(info.variant)||!Number.isSafeInteger(info.bytes)||!/^[a-f0-9]{64}$/.test(info.sha256||''))throw error(info?.unavailableReason||'此模型尚未配置可用的浏览器推理图。','MODEL_SOURCE_UNAVAILABLE');
  const packageURL=new URL(info.packageURL,globalThis.location?.href);
  const manifestRaw=await fetchBounded(packageURL,MAX_MANIFEST,{signal,fetchImpl});let source;
  try{source=JSON.parse(new TextDecoder().decode(manifestRaw));}catch{throw error('浏览器模型图清单无法解析。');}
  if(source?.kind!=='nbs-muscriptor-source-onnx'||source.version!==1||source.runtimeTemplate?.variant!==info.variant||!Array.isArray(source.derivedAssets)||source.derivedAssets.length!==1||source.derivedAssets[0].path!=='weights.bin')throw error('浏览器模型图与所选权重不匹配。');
  const derived=source.derivedAssets[0],template=source.runtimeTemplate;
  if(!safePath(source.mapping)||!Array.isArray(template.files)||template.files.some(file=>file.path==='weights.bin')||!template.files.some(file=>file.path===source.mapping))throw error('浏览器权重映射清单无效。');
  const provisional=validateTranscriptionManifest({...template,files:[...template.files,{path:derived.path,bytes:derived.bytes,sha256:'0'.repeat(64)}]});
  if(provisional.testOnly)throw error('内置下载不能安装随机测试权重。');
  // Fail before spending bandwidth if the cache has clearly insufficient space.
  let quota;try{quota=await estimate();}catch{/* The estimate API is optional. */}
  if(Number.isFinite(quota?.quota)&&Number.isFinite(quota?.usage)&&quota.quota-quota.usage<provisional.totalBytes*1.05)throw error('浏览器可用存储空间不足，请清理模型缓存或选择 small 后重试。','CACHE_QUOTA');
  const assets=new Map();let staticBytes=0;
  for(const file of template.files){
    // A malformed template must never turn this into a second large-file download.
    if(file.bytes>16*1024*1024||(staticBytes+=file.bytes)>32*1024*1024)throw error('浏览器模型图包包含过大的静态文件。');
    const bytes=await fetchBounded(new URL(file.path,packageURL),file.bytes,{signal,fetchImpl});
    if(bytes.length!==file.bytes||await digest(bytes)!==file.sha256)throw error(`浏览器模型图校验失败：${file.path}。`,'MODEL_HASH_MISMATCH');
    assets.set(file.path,new Blob([bytes]));
  }
  let map;try{map=JSON.parse(await assets.get(source.mapping).text());}catch{throw error('浏览器权重映射无法解析。');}
  if(map.target?.bytes!==derived.bytes||map.target.path!==derived.path)throw error('派生权重大小不匹配。');
  const progress=p=>onProgress({...p,variant:info.variant});
  let original=await downloadTranscriptionBlob(info.url,{bytes:info.bytes,signal,concurrency,onProgress:progress,fetchImpl});
  if(await sha256Blob(original,{signal,onProgress:progress})!==info.sha256)throw error('模型权重 SHA-256 校验失败，未安装；请重试或检查模型源。','MODEL_HASH_MISMATCH');
  const weights=await adaptTranscriptionWeights(original,map,{signal,onProgress:progress});original=null;
  const sha256=await sha256Blob(weights,{signal,onProgress:progress});
  if(derived.sha256&&sha256!==derived.sha256)throw error('转换后权重校验失败。','MODEL_HASH_MISMATCH');
  const manifest=validateTranscriptionManifest({...template,files:[...template.files,{path:derived.path,bytes:weights.size,sha256}],source:{url:info.url,sha256:info.sha256,bytes:info.bytes}});
  const blobs=[...assets].map(([path,data])=>({key:`${manifest.id}/${path}`,data}));blobs.push({key:`${manifest.id}/${derived.path}`,data:weights});
  return commitModel(manifest,blobs,{signal,onProgress:progress});
}
