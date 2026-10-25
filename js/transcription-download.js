/** Bounded, cancellable browser downloads. Call only after the user confirms. */
const failure=(message,code)=>Object.assign(new Error(message),{code});
const aborted=()=>new DOMException('模型下载已取消。','AbortError');
const MAX_RANGE_BYTES=40*1024*1024;
// Native fetch respects AbortSignal. Racing the awaited operation also prevents
// a stalled reader or a custom fetch adapter from keeping cancellation pending.
const abortable=(operation,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted){Promise.resolve(operation).catch(()=>{});reject(aborted());return;}
  const stop=()=>{signal.removeEventListener('abort',stop);reject(aborted());};
  signal.addEventListener('abort',stop,{once:true});
  Promise.resolve(operation).then(value=>{signal.removeEventListener('abort',stop);resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
});

export async function downloadTranscriptionBlob(url,{bytes,signal,onProgress=()=>{},fetchImpl=globalThis.fetch,rangeBytes=MAX_RANGE_BYTES,concurrency=2,maxAttempts=3,idleTimeoutMs=45000}={}){
  const target=new URL(url,globalThis.location?.href);
  if(target.protocol!=='https:'&&!(target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname))||target.username||target.password)throw failure('模型下载地址必须使用 HTTPS。','MODEL_URL');
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>1800*1024*1024)throw failure('模型下载大小无效。','MODEL_TOO_LARGE');
  if(!Number.isSafeInteger(rangeBytes)||rangeBytes<1||rangeBytes>MAX_RANGE_BYTES||!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5||!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<0)throw failure('模型下载分段或并发配置无效。','MODEL_DOWNLOAD_OPTIONS');
  if(signal?.aborted)throw aborted();
  const ranged=bytes>rangeBytes,count=Math.ceil(bytes/rangeBytes),parts=new Array(count),pool=new AbortController();
  let loaded=0,next=0,terminalError=null;
  const terminate=error=>{if(!terminalError)terminalError=error;pool.abort();};
  const cancel=()=>terminate(aborted());
  const check=()=>{if(signal?.aborted)throw aborted();if(pool.signal.aborted)throw terminalError||aborted();};
  const progress=extra=>{try{onProgress({stage:'download',loaded,total:bytes,concurrency,...extra});}catch(cause){throw Object.assign(failure('模型下载进度处理失败。','MODEL_PROGRESS'),{cause});}};
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();

  async function segment(index){
    const start=index*rangeBytes,end=Math.min(bytes,start+rangeBytes),chunks=[];
    let position=start;
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      check();
      const from=position,request=new AbortController();let timer,reader,timedOut=false;
      const stop=()=>request.abort();pool.signal.addEventListener('abort',stop,{once:true});
      if(pool.signal.aborted)stop();
      const arm=()=>{clearTimeout(timer);if(idleTimeoutMs>0)timer=setTimeout(()=>{timedOut=true;request.abort();},idleTimeoutMs);};
      arm();
      try{
        const response=await abortable(fetchImpl(target.href,{mode:'cors',credentials:'omit',redirect:'follow',signal:request.signal,cache:'no-store',...(ranged?{headers:{Range:`bytes=${from}-${end-1}`}}:{})}),request.signal);
        check();
        if(response.status!==(ranged?206:200)||response.type==='opaque'){
          void response.body?.cancel?.().catch(()=>{});
          throw Object.assign(failure(`模型源返回 HTTP ${response.status}${ranged&&response.status===200?'，未提供分段下载':''}，未安装模型。`,'MODEL_DOWNLOAD'),{retryable:response.status===408||response.status===429||response.status>=500});
        }
        const advertised=Number(response.headers.get('content-length'));
        if(advertised>0&&advertised!==end-from){void response.body?.cancel?.().catch(()=>{});throw failure('模型源返回的片段大小已经变化，请更新模型目录或重试。','MODEL_SIZE_MISMATCH');}
        // Content-Range may be hidden by CORS. When exposed, verify that this
        // is the requested interval, not another same-sized fragment.
        const interval=response.headers.get('content-range');
        if(ranged&&interval){const match=/^bytes (\d+)-(\d+)\/(\d+)$/i.exec(interval);if(!match||Number(match[1])!==from||Number(match[2])!==end-1||Number(match[3])!==bytes){void response.body?.cancel?.().catch(()=>{});throw failure('模型源返回的字节区间与请求不一致。','MODEL_SIZE_MISMATCH');}}
        reader=response.body?.getReader();if(!reader)throw failure('浏览器没有提供流式下载接口。','MODEL_STREAM_UNAVAILABLE');
        arm();
        for(;;){
          check();
          const {value,done}=await abortable(reader.read(),request.signal);if(done)break;
          check();
          if(!(value instanceof Uint8Array)||position+value.byteLength>end)throw failure('模型源返回的数据超出声明大小，下载已停止。','MODEL_SIZE_MISMATCH');
          if(value.byteLength){chunks.push(value);position+=value.byteLength;loaded+=value.byteLength;arm();progress({rangeIndex:index,rangeCount:count,attempt});}
        }
        check();
        if(position!==end)throw failure('模型下载未完成；未安装不完整的数据。',ranged?'MODEL_NETWORK':'MODEL_SIZE_MISMATCH');
        return chunks;
      }catch(cause){
        request.abort();void reader?.cancel?.().catch(()=>{});
        check();
        if(!cause?.code||cause.name==='AbortError')cause=failure(timedOut?'模型源长时间没有响应，请检查网络后重试。':'模型下载连接中断，请检查网络或跨来源访问限制；也可使用兼容的本地模型包。','MODEL_NETWORK');
        if(!ranged||attempt===maxAttempts||!['MODEL_NETWORK','MODEL_DOWNLOAD'].includes(cause.code)||cause.retryable===false)throw cause;
        // This segment owns its cursor. Other ranges never affect its retry
        // start, and bytes already received remain counted exactly once.
        if(position===end)return chunks;
        progress({rangeIndex:index,rangeCount:count,attempt:attempt+1,retrying:true});
      }finally{clearTimeout(timer);pool.signal.removeEventListener('abort',stop);try{reader?.releaseLock();}catch{/* A failed/aborted reader can already be released. */}}
    }
    throw failure('模型下载重试次数已用尽。','MODEL_NETWORK');
  }
  async function consume(){
    try{for(;;){check();const index=next++;if(index>=count)return;parts[index]=await segment(index);}}
    catch(cause){terminate(cause);throw cause;}
  }
  try{
    check();progress({rangeCount:count});check();
    await Promise.allSettled(Array.from({length:Math.min(concurrency,count)},()=>consume()));
    check();
    if(loaded!==bytes||parts.some(part=>!part))throw failure('模型下载数据不完整。','MODEL_SIZE_MISMATCH');
    // Responses may finish in any order; the Blob always follows byte offsets.
    return new Blob(parts.flat(),{type:'application/octet-stream'});
  }finally{signal?.removeEventListener('abort',cancel);}
}

export async function sha256Blob(blob,{signal,onProgress=()=>{}}={}){
  if(signal?.aborted)throw aborted();
  if(!globalThis.crypto?.subtle)throw failure('模型校验需要 HTTPS 或 localhost。','MODEL_HASH_UNAVAILABLE');
  onProgress({stage:'verify',loaded:0,total:blob.size});
  const data=await blob.arrayBuffer();if(signal?.aborted)throw aborted();
  const result=await crypto.subtle.digest('SHA-256',data);if(signal?.aborted)throw aborted();
  onProgress({stage:'verify',loaded:blob.size,total:blob.size});
  return [...new Uint8Array(result)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
