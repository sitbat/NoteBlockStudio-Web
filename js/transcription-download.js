/** Bounded, cancellable browser downloads. Call only after the user confirms. */
const failure=(message,code)=>Object.assign(new Error(message),{code});
const aborted=()=>new DOMException('模型下载已取消。','AbortError');
export async function downloadTranscriptionBlob(url,{bytes,signal,onProgress=()=>{},fetchImpl=globalThis.fetch,rangeBytes=8*1024*1024,maxAttempts=3,idleTimeoutMs=45000}={}){
  const target=new URL(url,globalThis.location?.href);
  if(target.protocol!=='https:'&&!(target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname))||target.username||target.password)throw failure('模型下载地址必须使用 HTTPS。','MODEL_URL');
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>1800*1024*1024)throw failure('模型下载大小无效。','MODEL_TOO_LARGE');
  if(!Number.isSafeInteger(rangeBytes)||rangeBytes<1||rangeBytes>16*1024*1024||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5||!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<0)throw failure('模型下载分段配置无效。','MODEL_DOWNLOAD_OPTIONS');
  if(signal?.aborted)throw aborted();
  const chunks=[];let loaded=0;const ranged=bytes>rangeBytes;
  onProgress({stage:'download',loaded,total:bytes});
  while(loaded<bytes){
    const end=Math.min(bytes,loaded+rangeBytes);let complete=false;
    for(let attempt=1;attempt<=maxAttempts&&!complete;attempt++){
      if(signal?.aborted)throw aborted();
      const from=loaded,abort=new AbortController();let timer,reader,timedOut=false;
      const cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});
      const arm=()=>{clearTimeout(timer);if(idleTimeoutMs>0)timer=setTimeout(()=>{timedOut=true;abort.abort();},idleTimeoutMs);};
      arm();
      try{
        const response=await fetchImpl(target.href,{mode:'cors',credentials:'omit',redirect:'follow',signal:abort.signal,cache:'no-store',...(ranged?{headers:{Range:`bytes=${from}-${end-1}`}}:{})});
        if(signal?.aborted)throw aborted();
        if(response.status!==(ranged?206:200)||response.type==='opaque'){
          await response.body?.cancel?.().catch(()=>{});
          throw Object.assign(failure(`模型源返回 HTTP ${response.status}${ranged&&response.status===200?'，未提供分段下载':''}，未安装模型。`,'MODEL_DOWNLOAD'),{retryable:response.status===408||response.status===429||response.status>=500});
        }
        const advertised=Number(response.headers.get('content-length'));
        if(advertised>0&&advertised!==end-from){await response.body?.cancel?.().catch(()=>{});throw failure('模型源返回的片段大小已经变化，请更新模型目录或重试。','MODEL_SIZE_MISMATCH');}
        reader=response.body?.getReader();if(!reader)throw failure('浏览器没有提供流式下载接口。','MODEL_STREAM_UNAVAILABLE');
        arm();
        for(;;){
          if(signal?.aborted)throw aborted();
          const {value,done}=await reader.read();if(done)break;
          if(!(value instanceof Uint8Array)||loaded+value.byteLength>end)throw failure('模型源返回的数据超出声明大小，下载已停止。','MODEL_SIZE_MISMATCH');
          chunks.push(value);loaded+=value.byteLength;arm();onProgress({stage:'download',loaded,total:bytes,attempt});
        }
        if(signal?.aborted)throw aborted();
        if(loaded!==end)throw failure('模型下载未完成；未安装不完整的数据。',ranged?'MODEL_NETWORK':'MODEL_SIZE_MISMATCH');
        complete=true;
      }catch(cause){
        await reader?.cancel?.().catch(()=>{});
        if(signal?.aborted)throw aborted();
        if(!cause?.code||cause.name==='AbortError')cause=failure(timedOut?'模型源长时间没有响应，请检查网络后重试。':'模型下载连接中断，请检查网络或跨来源访问限制；也可使用兼容的本地模型包。','MODEL_NETWORK');
        if(!ranged||attempt===maxAttempts||!['MODEL_NETWORK','MODEL_DOWNLOAD'].includes(cause.code)||cause.retryable===false)throw cause;
        // Completed bytes stay in memory; only the missing suffix is requested again.
        if(loaded===end){complete=true;break;}
        onProgress({stage:'download',loaded,total:bytes,attempt:attempt+1,retrying:true});
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reader?.releaseLock();}
    }
  }
  if(signal?.aborted)throw aborted();return new Blob(chunks,{type:'application/octet-stream'});
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
