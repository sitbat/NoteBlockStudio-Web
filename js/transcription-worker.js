import {TranscriptionResampler,CHUNK_SAMPLES} from './transcription-dsp.js';
import {MuscriptorONNX} from './muscriptor-onnx.js';
import {installTranscriptionModel,installTranscriptionSource,listTranscriptionModels,getTranscriptionModel,readTranscriptionAsset,clearTranscriptionModel} from './transcription-model-store.js';
import {getTranscriptionDownloadInfo} from './transcription-catalog.js';
const delay=()=>new Promise(resolve=>setTimeout(resolve,0));
const failure=(message,code)=>Object.assign(new Error(message),{code});
const activeStates=new Set(['running','processing','paused','draining']);
export function createTranscriptionWorkerHost(scope,{Runtime=MuscriptorONNX,store={install:installTranscriptionModel,download:installTranscriptionSource,list:listTranscriptionModels,get:getTranscriptionModel,read:readTranscriptionAsset,clear:clearTranscriptionModel},catalog=getTranscriptionDownloadInfo,now=()=>performance.now()}={}){
  let config={model:'small',backend:'auto',cpuThreads:2},runtime=null,manifest=null,job=null,pumping=false,lastPublish=0;
  let modelAbort=null;
  const checkModel=signal=>{if(signal?.aborted)throw new DOMException('模型准备已取消。','AbortError');};
  const modelOperation=async action=>{const abort=new AbortController();modelAbort=abort;view.state='loading';publish(true);try{return await action(abort.signal);}finally{if(modelAbort===abort)modelAbort=null;}};
  let view={state:'idle',model:'small',backend:'auto',modelReady:false,notes:[],noteCount:0,receivedSeconds:0,processedSeconds:0,queuedSeconds:0,warnings:[],error:null};
  const snapshot=(full=false)=>({...view,...(job?{jobId:job.id,receivedSeconds:job.received/16000,processedSeconds:job.processed/16000,queuedSeconds:Math.max(0,(job.received-job.processed)/16000),realTimeFactor:job.processed?job.processingMs/(job.processed/16):0,firstNoteLatencyMs:job.firstNoteMs,chunkMetrics:[...job.chunkMetrics],noteCount:runtime?.decoder.notes.length||0,notes:runtime?(full?runtime.decoder.snapshot():runtime.decoder.notes.slice(-5000).map(n=>({...n}))):[]}:{}),warnings:[...view.warnings]});
  const publish=(force=false)=>{if(!force&&now()-lastPublish<80)return;lastPublish=now();scope.postMessage({type:'state',snapshot:snapshot()});};
  function failJob(error){view={...view,state:'error',error:{message:error.message||String(error),code:error.code||'TRANSCRIPTION_FAILED'},backpressure:error.code==='BACKPRESSURE'};if(job){job.cancelled=true;for(const resume of job.resumeWaiters.splice(0))resume();for(const waiter of job.waiters.splice(0))waiter.reject(error);}publish(true);}
  async function unload(){const old=runtime;runtime=null;manifest=null;view.modelReady=false;if(old)await old.release();}
  async function ensureModel(signal){
    checkModel(signal);
    if(runtime?.loaded)return;
    view={...view,state:'loading',error:null,backpressure:false,modelProgress:{stage:'cache'}};publish(true);
    const cached=await store.list();checkModel(signal);let selected=config.modelId?cached.find(m=>m.id===config.modelId):cached.find(m=>m.variant===config.model&&!m.testOnly)||cached.find(m=>m.variant===config.model);
    if(!selected)throw failure('尚未安装此档模型。请导入转换后的 ZIP 模型包，或填写模型清单地址。','MODEL_NOT_INSTALLED');
    const selectedManifest=await store.get(selected.id,{signal,onProgress:progress=>{if(!signal?.aborted){view.modelProgress=progress;publish(true);}}});checkModel(signal);if(!selectedManifest)throw failure('模型缓存已不存在，请重新导入。','MODEL_NOT_INSTALLED');manifest=selectedManifest;
    const candidate=new Runtime(selectedManifest,{readAsset:path=>store.read(selectedManifest.id,path),onProgress:progress=>{if(!signal?.aborted){view.modelProgress=progress;publish(true);}}});
    try{const actual=await candidate.load({backend:config.backend,cpuThreads:config.cpuThreads,gpuTokenBatchSize:config.gpuTokenBatchSize,gpuUnrollSteps:config.gpuUnrollSteps});checkModel(signal);runtime=candidate;runtime.reset();config.modelId=selectedManifest.id;config.model=selectedManifest.variant;
      view={...view,...actual,model:selectedManifest.variant,modelId:selectedManifest.id,modelReady:true,state:'ready',error:null,modelProgress:null,warnings:selectedManifest.testOnly?['这是随机权重的链路测试模型，不能识别音乐；数值自检通过不代表真实模型或实时性能达标。']:[]};publish(true);
    }catch(error){await candidate.release();throw error;}
  }
  const busy=()=>job&&!job.cancelled&&activeStates.has(view.state);
  const idleOnly=()=>{if(busy()||view.state==='loading')throw failure('请先结束或取消当前转录，再更换模型。','TRANSCRIPTION_BUSY');};
  function take(samples){const out=new Float32Array(CHUNK_SAMPLES);let at=0;while(at<samples){const part=job.queue[0],count=Math.min(samples-at,part.length-job.offset);out.set(part.subarray(job.offset,job.offset+count),at);at+=count;job.offset+=count;if(job.offset===part.length){job.queue.shift();job.offset=0;}}job.queued-=samples;return out;}
  async function waitProcessing(current){while(current.paused&&!current.cancelled)await new Promise(resolve=>current.resumeWaiters.push(resolve));if(current.cancelled||current!==job)throw new DOMException('转录已取消。','AbortError');}
  async function pump(){
    if(pumping||!job)return;pumping=true;const current=job;
    try{
      while(current===job&&!current.cancelled){
        await waitProcessing(current);
        if(current.queued<CHUNK_SAMPLES&&!current.eof)break;
        if(!current.queued){if(current.eof){runtime.finish(current.received/16000);view.state='completed';view.error=null;publish(true);const result=snapshot(true);for(const waiter of current.waiters.splice(0))waiter.resolve(result);}break;}
        const count=Math.min(current.queued,CHUNK_SAMPLES),start=current.processed/16000,pcm=take(count);view.state=current.eof?'draining':'processing';publish(true);
        const result=await runtime.inferChunk(pcm,{startSeconds:start,validSamples:count,wait:()=>waitProcessing(current),isPaused:()=>current.paused,cancelled:()=>current.cancelled||job!==current,onPartial:()=>{if(!current.firstNoteMs&&runtime.decoder.notes.length)current.firstNoteMs=now()-current.started;publish();}});
        current.processed+=count;current.processingMs+=result.milliseconds;if(!current.firstNoteMs&&result.noteCount)current.firstNoteMs=now()-current.started;
        if(result.metrics){current.chunkMetrics.push({...result.metrics});if(current.chunkMetrics.length>120)current.chunkMetrics.shift();}
        if(runtime.decoder.warnings&&!view.warnings.some(s=>s.includes('异常令牌')))view.warnings.push('模型输出包含保留音色或异常令牌，部分事件未能解码；本轮结果需要人工核对。');
        if(current.processingMs>current.processed/16&&!view.warnings.some(s=>s.includes('追不上'))){view.warnings.push('当前推理速度追不上录音输入，尚未达到实时转录标准；请观察积压，或更换模型/后端。');}
        view.state=current.eof?'draining':'running';publish(true);await delay();
      }
    }catch(error){if(!current.cancelled&&current===job)failJob(error);}
    finally{pumping=false;if(job&&!job.cancelled&&!job.paused&&(job.queued>=CHUNK_SAMPLES||job.eof&&view.state!=='completed'&&view.state!=='error'))void pump();}
  }
  async function execute(data){
    switch(data.type){
      case 'configure':{
        idleOnly();const next=data.config||data;if(next.model&&!['small','medium','large'].includes(next.model)||next.backend&&!['auto','webgpu','webnn','wasm'].includes(next.backend)||next.gpuTokenBatchSize!==undefined&&![1,2,4,8].includes(next.gpuTokenBatchSize)||next.gpuUnrollSteps!==undefined&&![1,8].includes(next.gpuUnrollSteps))throw failure('模型档位或计算后端无效。','INVALID_OPTIONS');
        const changed=next.backend&&next.backend!==config.backend||next.model&&next.model!==config.model||next.modelId&&next.modelId!==config.modelId||next.gpuTokenBatchSize!==undefined&&next.gpuTokenBatchSize!==config.gpuTokenBatchSize||next.gpuUnrollSteps!==undefined&&next.gpuUnrollSteps!==config.gpuUnrollSteps;
        if(changed)await unload();if(next.model&&next.model!==config.model)delete config.modelId;config={...config,...next};view={...view,model:config.model,backend:config.backend,state:runtime?.loaded?'ready':'idle',error:null};publish(true);return snapshot();
      }
      case 'listModels':return store.list();
      case 'downloadModel':{
        idleOnly();const info=catalog(data.variant);if(!info?.available)throw failure(info?.unavailableReason||'此档模型尚未提供浏览器推理图。','MODEL_SOURCE_UNAVAILABLE');
        return modelOperation(async signal=>{
          const cached=(await store.list()).find(item=>item.variant===data.variant&&!item.testOnly);checkModel(signal);
          if(cached){await unload();checkModel(signal);job=null;config.modelId=cached.id;await ensureModel(signal);return snapshot();}
          await unload();checkModel(signal);job=null;view={...view,state:'loading',error:null,warnings:[],modelProgress:{stage:'download',variant:data.variant,loaded:0,total:info.bytes}};publish(true);
          const installed=await store.download(info,{signal,onProgress:progress=>{if(!signal.aborted){view.modelProgress=progress;publish();}}});checkModel(signal);config.modelId=installed.id;config.model=installed.variant;await ensureModel(signal);return snapshot();
        });
      }
      case 'loadModel':idleOnly();return modelOperation(async signal=>{await unload();checkModel(signal);job=null;config.modelId=data.modelId;await ensureModel(signal);return snapshot();});
      case 'clearCache':idleOnly();if(!data.modelId||data.modelId===manifest?.id)await unload();await store.clear(data.modelId);publish(true);return store.list();
      case 'loadPackage':{
        idleOnly();return modelOperation(async signal=>{await unload();checkModel(signal);job=null;view={...view,state:'loading',notes:[],noteCount:0,error:null,warnings:[]};publish(true);
          const installed=await store.install(data.source,{signal,onProgress:progress=>{if(!signal.aborted){view.modelProgress=progress;publish();}}});checkModel(signal);config.modelId=installed.id;config.model=installed.variant;await ensureModel(signal);return snapshot();});
      }
      case 'diagnose':idleOnly();return modelOperation(async signal=>{await ensureModel(signal);const result=await runtime.probe();checkModel(signal);view.state='ready';publish(true);return result;});
      case 'start':{
        if(busy()||view.state==='loading')throw failure('已有转录任务正在运行或模型仍在加载。','TRANSCRIPTION_BUSY');return modelOperation(async signal=>{job=null;await ensureModel(signal);checkModel(signal);if(manifest.testOnly)throw failure('随机权重模型仅供链路自检，不能用于音乐转录；请导入真实模型。','TEST_MODEL_ONLY');const options=data.options||data,rate=options.sampleRate||16000;runtime.reset();
        job={id:options.jobId||String(Date.now()),live:!!options.live,resampler:new TranscriptionResampler(rate),sampleRate:rate,queue:[],offset:0,queued:0,received:0,processed:0,processingMs:0,started:now(),firstNoteMs:null,chunkMetrics:[],paused:false,cancelled:false,eof:false,waiters:[],resumeWaiters:[]};
        view={...view,state:'running',error:null,backpressure:false,notes:[],warnings:manifest.testOnly?['随机权重测试模型不能识别音乐。请导入已获授权的真实模型后再测试识别效果。']:[]};publish(true);return snapshot();});
      }
      case 'appendAudio':{
        if(!job||job.cancelled||job.eof||!activeStates.has(view.state))throw failure('没有可以接收音频的转录任务。','NO_ACTIVE_JOB');
        if(data.sampleRate!==job.sampleRate)throw failure('同一次转录不能改变输入采样率。','AUDIO_RATE_CHANGED');
        if(!(data.pcm instanceof Float32Array)||data.pcm.length>job.sampleRate*10)throw failure('单次转录输入不得超过 10 秒，请分块传入。','AUDIO_TOO_LARGE');
        const converted=job.resampler.push(data.pcm,{final:!!data.final});
        if((job.received+converted.length)/16000>600)throw failure('本次连续转录达到 10 分钟上限，请停止后另开一段。','AUDIO_TOO_LONG');
        if(job.queued+converted.length>120*16000)throw failure('待识别音频积压达到 120 秒，已停止接收以避免内存持续增长；已有播放不受此队列阻塞。','BACKPRESSURE');
        job.received+=converted.length;if(converted.length){job.queue.push(converted);job.queued+=converted.length;}if(data.final)job.eof=true;publish(!!data.final);void pump();return {accepted:true,receivedSeconds:job.received/16000,queuedSeconds:(job.received-job.processed)/16000};
      }
      case 'pause':if(busy()){job.paused=true;view.state='paused';publish(true);}return snapshot();
      case 'resume':if(job&&!job.cancelled&&job.paused){job.paused=false;for(const resume of job.resumeWaiters.splice(0))resume();view.state=job.eof?'draining':'running';publish(true);void pump();}return snapshot();
      case 'finish':{
        if(!job||job.cancelled)throw failure('没有可以结束的转录任务。','NO_ACTIVE_JOB');if(view.state==='completed')return snapshot(true);if(view.state==='error')throw failure(view.error?.message||'转录已失败。',view.error?.code);
        if(!job.eof){const tail=job.resampler.push(new Float32Array(),{final:true});if(tail.length){job.queue.push(tail);job.queued+=tail.length;job.received+=tail.length;}job.eof=true;}
        const result=new Promise((resolve,reject)=>job.waiters.push({resolve,reject}));if(!job.paused)view.state='draining';publish(true);void pump();return result;
      }
      case 'cancel':modelAbort?.abort();if(job){job.cancelled=true;job.queue=[];for(const resume of job.resumeWaiters.splice(0))resume();for(const waiter of job.waiters.splice(0))waiter.reject(new DOMException('转录已取消。','AbortError'));}job=null;view={...view,state:'cancelled',notes:[],noteCount:0,modelProgress:null};publish(true);return snapshot();
      default:throw failure('未知转录命令。','UNKNOWN_COMMAND');
    }
  }
  const onMessage=async event=>{const data=event.data||{};try{const result=await execute(data);scope.postMessage({replyTo:data.id,ok:true,result});}catch(error){if(error.name!=='AbortError'&&!['TRANSCRIPTION_BUSY','INVALID_OPTIONS','UNKNOWN_COMMAND','NO_ACTIVE_JOB'].includes(error.code))failJob(error);scope.postMessage({replyTo:data.id,ok:false,error:{message:error.message||String(error),code:error.code||'TRANSCRIPTION_FAILED',name:error.name}});}};
  scope.addEventListener('message',onMessage);return {execute,snapshot,dispose:async()=>{scope.removeEventListener('message',onMessage);modelAbort?.abort();if(job){job.cancelled=true;for(const resume of job.resumeWaiters.splice(0))resume();}await unload();}};
}
if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope)createTranscriptionWorkerHost(globalThis);
