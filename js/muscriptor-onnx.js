import {MuscriptorLogMel,MuscriptorTokenDecoder,CHUNK_SAMPLES,MT3} from './transcription-dsp.js';
const wasmRuntimeSettings=new WeakMap();
const runtimeURL=new URL('../vendor/onnxruntime/ort.all.min.mjs',import.meta.url).href;
const fail=(message,code)=>Object.assign(new Error(message),{code});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const dispose=value=>{try{value?.dispose?.();}catch{/* The runtime can already have released a failed device. */}};
export function greedyMuscriptorToken(values){
  if(!values||values.length<MT3.size)throw fail('模型输出词表不完整。','MODEL_OUTPUT');
  let best=-Infinity,index=-1;for(let i=0;i<MT3.size;i++){const value=Number(values[i]);if(Number.isFinite(value)&&value>best){best=value;index=i;}}
  if(index<0)throw fail('模型输出包含非有限值，已停止识别。','MODEL_NUMERIC');return index;
}
export async function chooseTranscriptionBackend(requested='auto',manifest={},navigator=globalThis.navigator){
  const eligible=manifest.eligibleBackends||['webgpu','webnn','wasm'];
  if(requested!=='auto'&&!eligible.includes(requested))throw fail(`此 ${manifest.precision} 模型未声明兼容 ${requested}；请选择兼容模型。`,'BACKEND_MODEL_UNSUPPORTED');
  if(requested==='wasm')return 'wasm';
  if(requested==='webnn'){if(!navigator?.ml?.createContext)throw fail('当前浏览器未提供 WebNN。启用说明不能替代真实设备支持，请使用其他可用后端。','WEBNN_UNAVAILABLE');return 'webnn';}
  let gpu=false;if(navigator?.gpu?.requestAdapter){try{gpu=!!await navigator.gpu.requestAdapter({powerPreference:'high-performance'});}catch{/* Choose another available provider only in auto mode. */}}
  if(requested==='webgpu'&&!gpu)throw fail('当前浏览器没有可用 WebGPU 设备。请检查浏览器与显卡驱动，或选择 WASM 模型。','WEBGPU_UNAVAILABLE');
  if(requested!=='auto')return requested;
  if(gpu&&eligible.includes('webgpu'))return 'webgpu';
  if(eligible.includes('wasm'))return 'wasm';
  if(navigator?.ml?.createContext&&eligible.includes('webnn'))return 'webnn';
  throw fail('此模型没有当前设备可以使用的浏览器后端。','BACKEND_UNAVAILABLE');
}

/** Split prefill/one-token graphs retain KV state on the selected device. */
export class MuscriptorONNX {
  constructor(manifest,{readAsset,readDecodeAsset,readUnrollAsset,ort,now=()=>performance.now(),onProgress=()=>{}}={}){
    this.manifest=manifest;this.readAsset=readAsset;this.readDecodeAsset=readDecodeAsset;this.readUnrollAsset=readUnrollAsset;this.unrollSteps=1;this.tokenBatchSize=1;this.optimization={requestedBatchSize:1,activeBatchSize:1,fallbackReason:null};this.ort=ort;this.now=now;this.onProgress=onProgress;this.loaded=false;this.closed=false;this.decoder=new MuscriptorTokenDecoder();this.chunks=0;this.lastMetrics=null;this._activeWork=null;this._completeWork=null;this._releasePromise=null;this._closeSignal=new Promise(resolve=>{this._notifyClose=resolve;});
  }
  async load({backend='auto',cpuThreads=2,gpuTokenBatchSize=1,gpuUnrollSteps=1,navigator=globalThis.navigator}={}){
    const m=this.manifest;this.preprocessingInfo={preprocessingRevision:m.preprocessingRevision??m.preprocessingVersion??1,preprocessing:Object.fromEntries(['window','melFilter'].map(role=>{const path=m.preprocessing?.[role];return [role,{path,sha256:m.files?.find(file=>file.path===path)?.sha256}];}))};this.backend=await chooseTranscriptionBackend(backend,m,navigator);
    const unroll=gpuUnrollSteps===8&&this.backend==='webgpu'&&m.precision==='fp32',batch=unroll?1:Math.max(1,Math.min(8,Math.trunc(gpuTokenBatchSize)||1));this.optimization={requestedBatchSize:batch,activeBatchSize:1,requestedUnrollSteps:gpuUnrollSteps===8?8:1,activeUnrollSteps:1,fallbackReason:gpuUnrollSteps===8&&!unroll?'GPU step8 requires the WebGPU backend and the compatible FP32 graph layout.':batch>1&&this.backend!=='webgpu'?'GPU token batching requires the WebGPU backend.':null};
    const ort=this.ort||await import(runtimeURL);this.ort=ort;
    ort.env.wasm.wasmPaths=new URL('../vendor/onnxruntime/',import.meta.url).href;
    const requestedCPUThreads=this.backend==='wasm'?Math.max(1,Math.min(4,Math.trunc(cpuThreads)||1)):1,bootSettings=wasmRuntimeSettings.get(ort);
    // ORT initializes its global pool once per Worker; assigning env afterwards
    // cannot resize it. Preserve the initialized value and report a fresh-Worker
    // requirement instead of labelling the new requested count as actual.
    ort.env.wasm.numThreads=bootSettings?.numThreads??requestedCPUThreads;
    // This class already runs in a Worker. ORT's proxy cannot transfer GPU buffers.
    ort.env.wasm.proxy=false;ort.env.logLevel='warning';
    if(batch>1&&this.backend==='webgpu'){
      try{
        this.onProgress({stage:'compile',graph:'decoder-argmax'});
        let bytes;if(this.readDecodeAsset)bytes=await this.readDecodeAsset();else{const response=await fetch(new URL('../assets/transcription/common/decoder-argmax.onnx',import.meta.url));if(!response.ok)throw fail(`GPU token decoder fetch failed: ${response.status}`,'GPU_DECODER_UNAVAILABLE');bytes=new Uint8Array(await response.arrayBuffer());}
        this.tokenDecoder=await ort.InferenceSession.create(bytes,{executionProviders:['webgpu'],graphOptimizationLevel:'all',preferredOutputLocation:{token:'gpu-buffer',history_out:'gpu-buffer'}});
        // Check both the legal-vocabulary mask and actual device-resident outputs.
        const data=new Float32Array(m.card);data[74]=1;if(m.card>1393)data[1393]=100;const logits=new ort.Tensor('float32',data,[1,m.card]),history=new ort.Tensor('float32',Float32Array.of(0,1),[1,2]);let result;
        try{result=await this.tokenDecoder.run({logits,history_in:history});if(result.token.location!=='gpu-buffer'||result.history_out.location!=='gpu-buffer')throw fail('GPU decoder outputs are not device resident.','GPU_DECODER_UNAVAILABLE');const token=await result.token.getData();if(Number(token[0])!==74)throw fail('GPU token decoder self-test failed.','GPU_DECODER_NUMERIC');}finally{dispose(logits);dispose(history);for(const value of Object.values(result||{}))dispose(value);}
        this.tokenBatchSize=batch;this.optimization.activeBatchSize=batch;
      }catch(error){this.optimization.fallbackReason=error.message||String(error);await this.tokenDecoder?.release?.();this.tokenDecoder=null;this.tokenBatchSize=1;}
    }
    const externalData=[];for(const path of m.externalData||[])externalData.push({path,data:await this.readAsset(path)});
    const preferredOutputLocation={};if(this.backend==='webgpu')for(let i=0;i<m.layers;i++){preferredOutputLocation[`present_key_${i}`]='gpu-buffer';preferredOutputLocation[`present_value_${i}`]='gpu-buffer';}
    if(this.tokenBatchSize>1)preferredOutputLocation.logits='gpu-buffer';
    const options={executionProviders:this.backend==='webnn'?[{name:'webnn',deviceType:'gpu'},'wasm']:[this.backend],externalData,graphOptimizationLevel:'all',...(this.backend==='webgpu'?{preferredOutputLocation}:{} )};
    this.onProgress({stage:'compile',graph:'prefill'});
    try{
      this.prefill=await ort.InferenceSession.create(await this.readAsset(m.graphs.prefill),options);
      if(!wasmRuntimeSettings.has(ort))wasmRuntimeSettings.set(ort,{numThreads:ort.env.wasm.numThreads,proxy:ort.env.wasm.proxy});
      this.onProgress({stage:'compile',graph:'step'});
      this.step=await ort.InferenceSession.create(await this.readAsset(m.graphs.step),options);
      if(unroll){
        try{
          this.onProgress({stage:'compile',graph:'step8'});let bytes,metadata;
          if(this.readUnrollAsset){({bytes,metadata}=await this.readUnrollAsset());}else{
            const base=new URL(`../assets/transcription/gpu/${m.variant}/`,import.meta.url),response=await fetch(new URL('step8.json',base));if(!response.ok)throw fail(`GPU step8 metadata fetch failed: ${response.status}`,'GPU_UNROLL_UNAVAILABLE');metadata=await response.json();
            const graph=await fetch(new URL('step8.onnx',base));if(!graph.ok)throw fail(`GPU step8 graph fetch failed: ${graph.status}`,'GPU_UNROLL_UNAVAILABLE');bytes=new Uint8Array(await graph.arrayBuffer());
          }
          const original=m.files?.find(file=>file.path===m.graphs.step);
          if(metadata?.kind!=='nbs-muscriptor-step-unroll'||metadata.version!==1||metadata.steps!==8||metadata.sourceGraphSHA256!==original?.sha256||metadata.bytes!==bytes?.byteLength)throw fail('GPU step8 graph does not match the cached model graph and weight layout.','GPU_UNROLL_INCOMPATIBLE');
          const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');if(actual!==metadata.sha256)throw fail('GPU step8 graph checksum mismatch.','GPU_UNROLL_INCOMPATIBLE');
          const locations={...preferredOutputLocation,logits:'gpu-buffer',first_logits:'gpu-buffer',first_record:'gpu-buffer',token_history:'gpu-buffer'};for(let i=0;i<8;i++){locations[`token_${i}`]='gpu-buffer';locations[`valid_${i}`]='gpu-buffer';}
          this.unrollSession=await ort.InferenceSession.create(bytes,{...options,graphOptimizationLevel:'all',preferredOutputLocation:locations});this.unrollSteps=8;this.optimization.activeUnrollSteps=8;
        }catch(error){this.optimization.fallbackReason=`GPU step8 unavailable; using single-step greedy: ${error.message||error}`;this.unrollSteps=1;await this.unrollSession?.release?.();this.unrollSession=null;}
      }
      const floats=async path=>{if(!path)return undefined;const bytes=await this.readAsset(path);if(bytes.byteLength%4)throw fail('数值预处理参数大小无效。','MODEL_INVALID');return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));};
      this.mel=new MuscriptorLogMel({window:await floats(m.preprocessing?.window),melFilter:await floats(m.preprocessing?.melFilter)});
      this.loaded=true;return {backend:this.backend,actualBackend:this.backend==='webnn'?'webnn（不支持的算子回退 WASM）':this.backend,testOnly:!!m.testOnly,...this.preprocessingInfo,actualCPUThreads:wasmRuntimeSettings.get(ort).numThreads,actualWasmProxy:wasmRuntimeSettings.get(ort).proxy,requestedCPUThreads,threadsRequireNewWorker:requestedCPUThreads!==wasmRuntimeSettings.get(ort).numThreads,optimization:{...this.optimization}};
    }catch(error){await this.release();throw error;}
  }
  reset(){this.decoder=new MuscriptorTokenDecoder();this.chunks=0;this.lastMetrics=null;}
  _beginWork(){if(this._activeWork)throw fail('此模型已有推理步骤正在执行，请等待当前操作退出。','MODEL_BUSY');this._activeWork=new Promise(resolve=>{this._completeWork=resolve;});}
  _endWork(){const complete=this._completeWork;this._completeWork=null;this._activeWork=null;complete?.();}
  async probe(){
    if(!this.loaded||this.closed)throw fail('模型尚未加载。','MODEL_NOT_READY');
    this._beginWork();
    const m=this.manifest,ort=this.ort,started=this.now();let mel;try{mel=this.mel.compute(new Float32Array(CHUNK_SAMPLES));}catch(error){this._endWork();throw error;}
    let a,b,first,second,token,position;
    try{a=new ort.Tensor('float32',mel,[1,501,512]);b=new ort.Tensor('int64',BigInt64Array.of(BigInt(m.bos)),[1,1]);first=await this.prefill.run({log_mel:a,tokens:b});if(this.closed)throw new DOMException('转录已取消。','AbortError');const values=first.logits.getData?await first.logits.getData():first.logits.data,index=greedyMuscriptorToken(values);
      token=new ort.Tensor('int64',BigInt64Array.of(BigInt(index)),[1,1]);position=new ort.Tensor('int64',BigInt64Array.of(BigInt(m.prefixLength+1)),[1]);const feeds={token,position};for(let i=0;i<m.layers;i++)for(const type of ['key','value'])feeds[`past_${type}_${i}`]=first[`present_${type}_${i}`];
      second=await this.step.run(feeds);if(this.closed)throw new DOMException('转录已取消。','AbortError');const next=second.logits.getData?await second.logits.getData():second.logits.data;greedyMuscriptorToken(next);
      return {backend:this.backend,modelId:m.id,testOnly:!!m.testOnly,...this.preprocessingInfo,milliseconds:this.now()-started,prefillToken:index,stepToken:greedyMuscriptorToken(next),layers:m.layers,cacheLocations:[...new Set(Object.entries(second).filter(([name])=>name.startsWith('present_')).map(([,tensor])=>tensor.location||'unknown'))],passed:true};
    }finally{for(const value of [a,b,token,position,...Object.values(first||{}),...Object.values(second||{})])dispose(value);this._endWork();}
  }
  async inferChunk(pcm,{startSeconds=0,validSamples=CHUNK_SAMPLES,wait=async()=>{},isPaused=()=>false,onPartial=()=>{},cancelled=()=>false,maxTokens=this.manifest.maxTokens}={}){
    if(!this.loaded||this.closed)throw fail('模型尚未加载。','MODEL_NOT_READY');
    if(!(pcm instanceof Float32Array)||pcm.length!==CHUNK_SAMPLES||!Number.isInteger(validSamples)||validSamples<1||validSamples>CHUNK_SAMPLES||!Number.isFinite(startSeconds)||startSeconds<0)throw fail('转录块大小或开始时间无效。','AUDIO_INVALID');
    for(const sample of pcm)if(!Number.isFinite(sample))throw fail('转录音频包含无效数值。','AUDIO_INVALID');
    if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>this.manifest.maxTokens)throw fail('生成令牌上限无效。','GENERATION_OPTIONS');
    if(this.unrollSteps===8&&this.unrollSession)return this._inferChunkUnrolled(pcm,{startSeconds,validSamples,wait,isPaused,onPartial,cancelled,maxTokens});
    this._beginWork();
    const {ort,manifest:m,decoder}=this,started=this.now(),initialNotes=decoder.notes.length;
    let outputs=null,caches=new Map(),position,inputMel,inputTokens,history,deviceToken,pending=0,ended=false,reportedFirstNote=false;
    let batched=this.tokenBatchSize>1&&!!this.tokenDecoder;
    const metrics={backend:this.backend,modelId:m.id,startSeconds,seconds:validSamples/16000,promptTokens:0,tokens:0,firstTokens:[],prefillToken:null,steps:0,melMs:0,prefillMs:0,decodeMs:0,logitReadMs:0,argmaxMs:0,tokenReadMs:0,tokenReadBatches:0,discardedTokens:0,pausedMs:0,yieldMs:0,firstNoteMs:null,peakLogicalKVBytes:0,concatOutputBytesEstimate:0,cacheLocations:[],decodingStrategy:batched?'gpu-token-batch':'cpu-greedy',gpuTokenBatchSize:batched?this.tokenBatchSize:1,fallbackReason:this.optimization.fallbackReason,status:'running'};
    const locations=new Set(),logicalBytes=tensors=>[...tensors].reduce((sum,tensor)=>sum+(Array.isArray(tensor?.dims)?tensor.dims.reduce((a,b)=>a*b,1)*4:0),0);
    const check=()=>{if(cancelled()||this.closed)throw new DOMException('转录已取消。','AbortError');};
    const ready=async()=>{const paused=!!isPaused(),before=this.now();await Promise.race([wait(),this._closeSignal]);if(paused)metrics.pausedMs+=Math.max(0,this.now()-before);check();};
    const kernel=async(session,feeds,role)=>{const before=this.now();try{return await session.run(feeds);}finally{metrics[role]+=Math.max(0,this.now()-before);}};
    const commit=token=>{metrics.tokens++;if(metrics.tokens===1)metrics.prefillToken=token;if(metrics.firstTokens.length<20)metrics.firstTokens.push(token);if(token===MT3.eos){ended=true;return;}decoder.push(token);};
    const notify=async(force=false)=>{const firstNote=!reportedFirstNote&&decoder.notes.length>initialNotes;if(firstNote){reportedFirstNote=true;metrics.firstNoteMs=Math.max(0,this.now()-started-metrics.pausedMs);}if(force||firstNote||metrics.tokens%8===1){onPartial({tokens:metrics.tokens,notes:decoder.notes.length});const before=this.now();await tick();metrics.yieldMs+=Math.max(0,this.now()-before);check();}};
    const flush=async()=>{
      if(!pending)return;
      const before=this.now(),values=history.getData?await history.getData():history.data;metrics.tokenReadMs+=Math.max(0,this.now()-before);metrics.tokenReadBatches++;
      if(values.length!==2+pending*2)throw fail('GPU token history has an invalid shape.','MODEL_OUTPUT');
      for(let i=0;i<pending;i++){
        const token=Number(values[2+i*2]),valid=Number(values[3+i*2]);
        if(valid!==1||!Number.isInteger(token)||token<0||token>=MT3.size)throw fail('模型输出包含非有限值，已停止识别。','MODEL_NUMERIC');
        commit(token);if(ended){metrics.discardedTokens+=pending-i-1;break;}
      }
      pending=0;dispose(history);history=null;await notify(true);
    };
    const fallback=message=>{batched=false;this.tokenBatchSize=1;this.optimization.activeBatchSize=1;this.optimization.fallbackReason=message;metrics.decodingStrategy='gpu-token-batch-fallback-greedy';metrics.fallbackReason=message;};
    try{
      await ready();
      const prompt=decoder.promptTokens(m.bos,{force:this.chunks>0}),budget=maxTokens-(prompt.length-1);metrics.promptTokens=prompt.length;
      if(budget<1)throw fail('上一块的持续音提示已经超过模型生成上限，已停止而未截断音符状态。','PROMPT_LIMIT');
      const melStarted=this.now(),logMel=this.mel.compute(pcm);metrics.melMs=Math.max(0,this.now()-melStarted);
      decoder.begin(startSeconds,startSeconds+validSamples/16000);for(const token of prompt.slice(1))decoder.push(token);
      inputMel=new ort.Tensor('float32',logMel,[1,m.melFrames,m.melBins]);inputTokens=new ort.Tensor('int64',BigInt64Array.from(prompt,BigInt),[1,prompt.length]);
      outputs=await kernel(this.prefill,{log_mel:inputMel,tokens:inputTokens},'prefillMs');check();position=m.prefixLength+prompt.length;
      for(let count=0;count<budget;count++){
        let token;
        if(batched){
          if(!history)history=new ort.Tensor('float32',Float32Array.of(0,1),[1,2]);let result;
          try{
            result=await kernel(this.tokenDecoder,{logits:outputs.logits,history_in:history},'argmaxMs');check();
            if(!result.token||result.token.type!=='int64'||!result.history_out||result.history_out.type!=='float32')throw fail('GPU token decoder returned invalid outputs.','MODEL_OUTPUT');
            deviceToken=result.token;dispose(history);history=result.history_out;result=null;pending++;
          }catch(error){
            for(const value of Object.values(result||{}))dispose(value);check();
            // Earlier pending predictions remain valid; publish them before
            // reading this position with the original CPU greedy decoder.
            await flush();fallback(`GPU token decoder failed; using CPU greedy: ${error.message||error}`);if(ended)break;
          }
        }
        if(!batched){const readStarted=this.now(),values=outputs.logits.getData?await outputs.logits.getData():outputs.logits.data;metrics.logitReadMs+=Math.max(0,this.now()-readStarted);token=greedyMuscriptorToken(values);}
        dispose(outputs.logits);
        const nextCaches=new Map();
        for(let i=0;i<m.layers;i++)for(const type of ['key','value']){
          const name=`${type}_${i}`,next=outputs[`present_${name}`];
          if(!next||next.type!=='float32'||!Array.isArray(next.dims)||next.dims.length!==4||next.dims[0]!==1||next.dims[1]!==m.heads||next.dims[2]!==position||next.dims[3]!==m.headDim)throw fail('模型没有输出匹配的完整 KV 缓存。','MODEL_OUTPUT');
          nextCaches.set(name,next);locations.add(next.location||'unknown');
        }
        metrics.peakLogicalKVBytes=Math.max(metrics.peakLogicalKVBytes,logicalBytes(caches.values())+logicalBytes(nextCaches.values()));
        for(const value of caches.values())dispose(value);caches=nextCaches;outputs=null;await ready();
        if(batched){if(pending>=this.tokenBatchSize||count+1===budget)await flush();}
        else{commit(token);if(!ended)await notify();}
        if(ended)break;
        if(count+1===budget)break;
        const currentToken=deviceToken||new ort.Tensor('int64',BigInt64Array.of(BigInt(token)),[1,1]),currentPosition=new ort.Tensor('int64',BigInt64Array.of(BigInt(position)),[1]);
        deviceToken=null;const feeds={token:currentToken,position:currentPosition};for(const [name,tensor]of caches)feeds[`past_${name}`]=tensor;
        try{
          try{outputs=await kernel(this.step,feeds,'decodeMs');}
          catch(error){
            check();if(!batched)throw error;await flush();if(ended)break;
            fallback(`GPU token input failed; retrying CPU greedy: ${error.message||error}`);
            const values=currentToken.getData?await currentToken.getData():currentToken.data;
            const retry=new ort.Tensor('int64',BigInt64Array.of(BigInt(values[0])),[1,1]);
            try{outputs=await kernel(this.step,{...feeds,token:retry},'decodeMs');}finally{dispose(retry);}
          }
          metrics.steps++;metrics.concatOutputBytesEstimate+=2*m.layers*m.heads*m.headDim*(position+1)*4;
        }finally{dispose(currentToken);dispose(currentPosition);}position++;check();
      }
      if(!ended)throw fail(`这一音频块未在 ${maxTokens} 个令牌的总生成预算内结束，未将截断结果视为完整转录。`,'GENERATION_LIMIT');
      this.chunks++;metrics.status='completed';
    }catch(error){metrics.status=error.name==='AbortError'?'cancelled':'failed';metrics.errorCode=error.code||error.name;throw error;}
    finally{
      dispose(inputMel);dispose(inputTokens);dispose(history);dispose(deviceToken);for(const value of caches.values())dispose(value);if(outputs)for(const value of Object.values(outputs))dispose(value);
      metrics.wallMs=Math.max(0,this.now()-started);metrics.processingMs=Math.max(0,metrics.wallMs-metrics.pausedMs);metrics.cacheLocations=[...locations];this.lastMetrics=Object.freeze(metrics);this._endWork();
    }
    return {seconds:validSamples/16000,milliseconds:this.lastMetrics.processingMs,wallMilliseconds:this.lastMetrics.wallMs,pausedMilliseconds:this.lastMetrics.pausedMs,noteCount:decoder.notes.length,metrics:this.lastMetrics};
  }
  async _inferChunkUnrolled(pcm,{startSeconds,validSamples,wait,isPaused,onPartial,cancelled,maxTokens}){
    this._beginWork();const {ort,manifest:m,decoder}=this,started=this.now(),initialNotes=decoder.notes.length;
    let outputs,inputMel,inputTokens,caches=new Map(),position,lastToken,ended=false,reported=false,useUnroll=true;
    const metrics={backend:this.backend,modelId:m.id,startSeconds,seconds:validSamples/16000,promptTokens:0,tokens:0,firstTokens:[],prefillToken:null,steps:0,graphRuns:0,melMs:0,prefillMs:0,decodeMs:0,logitReadMs:0,argmaxMs:0,tokenReadMs:0,tokenReadBatches:0,discardedTokens:0,pausedMs:0,yieldMs:0,firstNoteMs:null,peakLogicalKVBytes:0,concatOutputBytesEstimate:0,cacheLocations:[],decodingStrategy:'gpu-step8',gpuTokenBatchSize:8,unrollSteps:8,fallbackReason:null,status:'running'};
    const locations=new Set(),bytes=values=>[...values].reduce((sum,tensor)=>sum+tensor.dims.reduce((a,b)=>a*b,1)*4,0);
    const check=()=>{if(cancelled()||this.closed)throw new DOMException('转录已取消。','AbortError');};
    const ready=async()=>{const paused=!!isPaused(),before=this.now();await Promise.race([wait(),this._closeSignal]);if(paused)metrics.pausedMs+=Math.max(0,this.now()-before);check();};
    const run=async(session,feeds,role)=>{const before=this.now();try{return await session.run(feeds);}finally{metrics[role]+=Math.max(0,this.now()-before);metrics.graphRuns++;}};
    const commit=token=>{lastToken=token;metrics.tokens++;if(metrics.tokens===1)metrics.prefillToken=token;if(metrics.firstTokens.length<20)metrics.firstTokens.push(token);if(token===MT3.eos)ended=true;else decoder.push(token);};
    const notify=async()=>{if(!reported&&decoder.notes.length>initialNotes){reported=true;metrics.firstNoteMs=Math.max(0,this.now()-started-metrics.pausedMs);}onPartial({tokens:metrics.tokens,notes:decoder.notes.length});const before=this.now();await tick();metrics.yieldMs+=Math.max(0,this.now()-before);check();};
    const adopt=()=>{
      const next=new Map();
      for(let i=0;i<m.layers;i++)for(const type of ['key','value']){const key=`${type}_${i}`,value=outputs[`present_${key}`];if(!value||value.type!=='float32'||value.dims.length!==4||value.dims[0]!==1||value.dims[1]!==m.heads||value.dims[2]!==position||value.dims[3]!==m.headDim)throw fail('模型没有输出匹配的完整 KV 缓存。','MODEL_OUTPUT');next.set(key,value);locations.add(value.location||'unknown');}
      metrics.peakLogicalKVBytes=Math.max(metrics.peakLogicalKVBytes,bytes(caches.values())+bytes(next.values()));for(const value of caches.values())dispose(value);caches=next;
      for(const [name,value]of Object.entries(outputs))if(!name.startsWith('present_'))dispose(value);outputs=null;
    };
    try{
      await ready();const prompt=decoder.promptTokens(m.bos,{force:this.chunks>0}),budget=maxTokens-(prompt.length-1);metrics.promptTokens=prompt.length;
      if(budget<1)throw fail('上一块的持续音提示已经超过模型生成上限。','PROMPT_LIMIT');
      const before=this.now(),mel=this.mel.compute(pcm);metrics.melMs=Math.max(0,this.now()-before);decoder.begin(startSeconds,startSeconds+validSamples/16000);for(const value of prompt.slice(1))decoder.push(value);
      inputMel=new ort.Tensor('float32',mel,[1,m.melFrames,m.melBins]);inputTokens=new ort.Tensor('int64',BigInt64Array.from(prompt,BigInt),[1,prompt.length]);
      outputs=await run(this.prefill,{log_mel:inputMel,tokens:inputTokens},'prefillMs');check();position=m.prefixLength+prompt.length;
      const read=this.now(),logits=outputs.logits.getData?await outputs.logits.getData():outputs.logits.data;metrics.logitReadMs+=Math.max(0,this.now()-read);commit(greedyMuscriptorToken(logits));adopt();await ready();if(!ended)await notify();
      while(!ended&&metrics.tokens<budget){
        const count=useUnroll&&budget-metrics.tokens>=8?8:1,token=new ort.Tensor('int64',BigInt64Array.of(BigInt(lastToken)),[1,1]),at=new ort.Tensor('int64',BigInt64Array.of(BigInt(position)),[1]);
        const feeds={token,position:at};for(const [name,value]of caches)feeds[`past_${name}`]=value;
        try{
          try{outputs=await run(count===8?this.unrollSession:this.step,feeds,'decodeMs');}
          catch(error){check();if(count!==8)throw error;useUnroll=false;this.unrollSteps=1;this.optimization.activeUnrollSteps=1;this.optimization.fallbackReason=`GPU step8 failed; retrying single-step greedy: ${error.message||error}`;metrics.fallbackReason=this.optimization.fallbackReason;metrics.decodingStrategy='gpu-step8-fallback-greedy';continue;}
        }finally{dispose(token);dispose(at);}
        check();metrics.steps+=count;metrics.concatOutputBytesEstimate+=2*m.layers*m.heads*m.headDim*4*(count*position+count*(count+1)/2);position+=count;
        if(count===8){
          const before=this.now();let values;
          if(outputs.token_0){
            values=new Float32Array(16);const raw=await Promise.all(Array.from({length:8},async(_,i)=>{const token=outputs[`token_${i}`],valid=outputs[`valid_${i}`];if(token?.type!=='int64'||valid?.type!=='float32')throw fail('GPU step8 raw token output types are invalid.','MODEL_OUTPUT');const [t,v]=await Promise.all([token.getData?token.getData():token.data,valid.getData?valid.getData():valid.data]);return [Number(t[0]),Number(v[0])];}));for(let i=0;i<8;i++)values.set(raw[i],i*2);metrics.tokenReadSource='raw-int64-outputs';
          }else{values=outputs.token_history.getData?await outputs.token_history.getData():outputs.token_history.data;metrics.tokenReadSource='packed-float32-history';}
          metrics.tokenReadMs+=Math.max(0,this.now()-before);metrics.tokenReadBatches++;
          if(values.length!==16)throw fail('GPU step8 token history has an invalid shape.','MODEL_OUTPUT');
          if(metrics.tokenReadBatches===1){
            metrics.firstTokenHistory=Array.from(values,Number);
            if(outputs.token_0&&outputs.token_history){const packed=outputs.token_history.getData?await outputs.token_history.getData():outputs.token_history.data;metrics.diagnosticPackedHistory=Array.from(packed,Number);}
            for(const [name,key]of [['logits','diagnosticLastLogitToken'],['first_logits','diagnosticFirstLogitToken']])if(outputs[name]){try{const data=outputs[name].getData?await outputs[name].getData():outputs[name].data;metrics[key]=greedyMuscriptorToken(data);}catch(error){metrics[key+'Error']=error.message;}}
            if(outputs.first_record){const record=outputs.first_record.getData?await outputs.first_record.getData():outputs.first_record.data;metrics.diagnosticFirstRecord=Array.from(record,Number);}
          }
          for(let i=0;i<8;i++){
            const value=Number(values[i*2]),valid=Number(values[i*2+1]);
            if(valid!==1||!Number.isInteger(value)||value<0||value>=MT3.size){
              metrics.invalidTokenHistory=Array.from(values,Number);metrics.invalidTokenIndex=i;
              try{const last=outputs.logits.getData?await outputs.logits.getData():outputs.logits.data;metrics.diagnosticLastLogitToken=greedyMuscriptorToken(last);metrics.diagnosticLastLogitFinite=Array.from(last).filter(Number.isFinite).length;}catch(error){metrics.diagnosticLastLogitError=error.message;}
              throw fail(`GPU step8 非法输出 index=${i}, history=${JSON.stringify(Array.from(values,value=>String(value)))}, lastLogitToken=${metrics.diagnosticLastLogitToken??'invalid'}, finiteLogits=${metrics.diagnosticLastLogitFinite??'unknown'}。`,'MODEL_NUMERIC');
            }
            commit(value);if(ended){metrics.discardedTokens=7-i;break;}
          }
        }else{const before=this.now(),values=outputs.logits.getData?await outputs.logits.getData():outputs.logits.data;metrics.logitReadMs+=Math.max(0,this.now()-before);commit(greedyMuscriptorToken(values));}
        adopt();await ready();if(!ended)await notify();
      }
      if(!ended)throw fail(`这一音频块未在 ${maxTokens} 个令牌的总生成预算内结束。`,'GENERATION_LIMIT');this.chunks++;metrics.status='completed';
    }catch(error){metrics.status=error.name==='AbortError'?'cancelled':'failed';metrics.errorCode=error.code||error.name;throw error;}
    finally{dispose(inputMel);dispose(inputTokens);for(const value of caches.values())dispose(value);for(const value of Object.values(outputs||{}))dispose(value);metrics.wallMs=Math.max(0,this.now()-started);metrics.processingMs=Math.max(0,metrics.wallMs-metrics.pausedMs);metrics.cacheLocations=[...locations];this.lastMetrics=Object.freeze(metrics);this._endWork();}
    return {seconds:validSamples/16000,milliseconds:this.lastMetrics.processingMs,wallMilliseconds:this.lastMetrics.wallMs,pausedMilliseconds:this.lastMetrics.pausedMs,noteCount:decoder.notes.length,metrics:this.lastMetrics};
  }
  finish(seconds){this.decoder.finish(seconds);return this.decoder.snapshot();}
  async release(){if(this._releasePromise)return this._releasePromise;this.closed=true;this.loaded=false;this._notifyClose?.();const active=this._activeWork;this._releasePromise=(async()=>{if(active)await active;await Promise.allSettled([this.prefill?.release?.(),this.step?.release?.(),this.tokenDecoder?.release?.(),this.unrollSession?.release?.()]);this.prefill=null;this.step=null;this.tokenDecoder=null;this.unrollSession=null;})();return this._releasePromise;}
}
