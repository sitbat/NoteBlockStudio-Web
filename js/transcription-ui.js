import {icon} from './icons.js';
import {getTranscriptionDownloadInfo} from './transcription-catalog.js';

const ACTIVE=new Set(['running','processing','recording','paused','draining','starting']);
const STATES={idle:'等待开始',loading:'正在加载模型',ready:'模型已就绪',starting:'正在准备识别',running:'正在识别',processing:'正在识别',recording:'正在识别',paused:'识别已暂停',draining:'正在处理剩余音频',completed:'识别完成',cancelled:'已取消',error:'识别失败'};
const validSeconds=value=>Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
const aborted=()=>Object.assign(new Error('录音已取消'),{name:'AbortError'});
const checkedConcurrency=value=>{if(!Number.isInteger(value)||value<1||value>4)throw new RangeError('模型下载并发数必须是 1–4 的整数。');return value;};

export function formatTranscriptionBytes(bytes) {
  if(!Number.isFinite(Number(bytes))||Number(bytes)<0)return '大小未知';
  const value=Number(bytes);return value>=1e9?`${(value/1e9).toFixed(2)} GB`:value>=1e6?`${(value/1e6).toFixed(1)} MB`:value>=1e3?`${(value/1e3).toFixed(1)} KB`:`${Math.round(value)} B`;
}

/** Consent is explicit and source-specific. Merely constructing or inspecting the gate never downloads weights. */
export function createTranscriptionDownloadGate({getInfo=getTranscriptionDownloadInfo,listModels=async()=>[],loadModel,downloadModel,cancelDownload=()=>{},onChange=()=>{},now=()=>performance.now()}={}) {
  let state=Object.freeze({phase:'idle',info:null,cached:null,progress:null,error:null,canRetry:false,concurrency:null}),generation=0,consent=null,startedAt=0,lastSample=null;
  const update=patch=>{state=Object.freeze({...state,...patch});onChange(state);return state;};
  const infoFor=variant=>{const raw=getInfo(variant)||{};return Object.freeze({...raw,variant,label:String(raw.label||variant),available:raw.available===true,bytes:Number.isFinite(Number(raw.bytes))?Math.max(0,Number(raw.bytes)):0});};
  const sameSource=(a,b)=>!!a&&!!b&&a.variant===b.variant&&a.url===b.url&&a.packageURL===b.packageURL&&a.bytes===b.bytes&&a.sha256===b.sha256;
  async function inspect(variant,{checkCache=true}={}) {
    const token=++generation,info=infoFor(variant);update({phase:'checking',info,cached:null,progress:null,error:null,canRetry:false,concurrency:null});
    try{
      const result=checkCache?await listModels():[],models=Array.isArray(result)?result:result?.models||[];
      if(token!==generation)throw aborted();
      const cached=models.find(model=>model&&model.variant===variant&&!model.testOnly&&model.usable!==false&&model.browserReady!==false);
      return update({phase:cached?'cached':info.available?'confirm':'unavailable',cached:cached||null,models});
    }catch(error){if(token!==generation)throw aborted();update({phase:'error',error,canRetry:false});throw error;}
  }
  function progress(value) {
    if(state.phase!=='downloading'||!value||value.variant&&value.variant!==state.info?.variant)return state;
    const stage=String(value.stage||'download'),loaded=Number.isFinite(Number(value.loaded))?Math.max(0,Number(value.loaded)):null,total=Number.isFinite(Number(value.total))&&Number(value.total)>0?Number(value.total):null,time=now();
    let bytesPerSecond=null;
    if(stage==='download'&&loaded!==null){
      if(lastSample&&lastSample.stage===stage&&lastSample.path===value.path&&loaded>=lastSample.loaded&&time>lastSample.time)bytesPerSecond=(loaded-lastSample.loaded)/((time-lastSample.time)/1000);
      else if(time>startedAt)bytesPerSecond=loaded/((time-startedAt)/1000);
      lastSample={stage,path:value.path,loaded,time};
    }else lastSample=null;
    const downloadedBytes=stage==='download'&&loaded!==null?Math.max(state.progress?.downloadedBytes||0,loaded):state.progress?.downloadedBytes||0;
    return update({progress:{stage,loaded,total,path:value.path||'',downloadedBytes,downloadTotal:state.info?.bytes||null,bytesPerSecond:Number.isFinite(bytesPerSecond)?Math.max(0,bytesPerSecond):null}});
  }
  async function useCached() {
    if(state.phase!=='cached'||!state.cached||typeof loadModel!=='function')throw new Error('没有可直接使用的已缓存模型。');
    const token=++generation,id=state.cached.id;update({phase:'loadingCache',error:null});
    try{const result=await loadModel(id,state.info.variant);if(token!==generation)throw aborted();if(result?.modelReady!==true||result?.testOnly)throw new Error('缓存中的模型尚不可用于音乐识别，请重新加载有效模型。');update({phase:'complete',error:null});return result;}
    catch(error){if(token!==generation)throw aborted();update({phase:'error',error,canRetry:false});throw error;}
  }
  async function confirmedDownload({concurrency=2}={}) {
    checkedConcurrency(concurrency);
    const info=infoFor(state.info?.variant);
    if(!sameSource(state.info,info))throw new Error('模型来源或大小已变化，请重新查看并确认下载。');
    if(!info.available)throw new Error(info.unavailableReason||'当前构建尚未提供此模型的浏览器转换图，下载暂未开放。');
    if(typeof downloadModel!=='function')throw new Error('当前构建未提供模型下载功能。');
    const token=++generation;consent=info;startedAt=now();lastSample=null;update({phase:'downloading',info,error:null,progress:{stage:'download',loaded:0,total:info.bytes||null,bytesPerSecond:null,path:''},canRetry:false,concurrency});
    try{const result=await downloadModel(info.variant,{concurrency});if(token!==generation)throw aborted();if(result?.modelReady!==true||result?.testOnly)throw new Error('模型下载后尚不可用于音乐识别，未将其标记为可用。');update({phase:'complete',error:null,canRetry:false,progress:{stage:'ready',loaded:info.bytes,total:info.bytes,downloadedBytes:info.bytes,downloadTotal:info.bytes,bytesPerSecond:null,path:''}});return result;}
    catch(error){if(token!==generation)throw aborted();update({phase:error.name==='AbortError'?'cancelled':'error',error:error.name==='AbortError'?null:error,canRetry:sameSource(consent,infoFor(info.variant))});throw error;}
  }
  async function confirm(options){if(state.phase!=='confirm')throw new Error('请先确认模型来源和下载体积。');return confirmedDownload(options);}
  async function retry(options){if(!state.canRetry||!sameSource(consent,infoFor(state.info?.variant)))throw new Error('模型来源已改变，请重新确认下载。');return confirmedDownload(options);}
  async function cancel(){generation++;const active=state.phase==='downloading'||state.phase==='loadingCache';update({phase:'cancelled',error:null,canRetry:sameSource(consent,state.info)});if(active)await cancelDownload();return state;}
  function reset(){generation++;consent=null;lastSample=null;return update({phase:'idle',info:null,cached:null,progress:null,error:null,canRetry:false,concurrency:null});}
  return {inspect,confirm,retry,useCached,cancel,reset,progress,getSnapshot:()=>state};
}

/** A truthful view of controller state; interface detection alone never marks a model as runnable. */
export function transcriptionViewState(snapshot={},recording=false) {
  const state=String(snapshot.state||snapshot.status||'idle'),notes=Array.isArray(snapshot.notes)?snapshot.notes:[];
  const busy=ACTIVE.has(state),failed=state==='error'||!!snapshot.error;
  return {state,label:STATES[state]||state,busy,failed,notes,
    canConfigure:!busy&&state!=='loading'&&!recording,
    canRecord:recording||(!snapshot.testOnly&&!busy&&state!=='loading'&&snapshot.modelReady===true),
    canImport:!snapshot.testOnly&&!busy&&!recording&&state!=='loading'&&snapshot.modelReady===true,
    canPause:busy&&state!=='starting',canCancel:busy||state==='loading'||recording,
    canInsert:!snapshot.testOnly&&notes.length>0&&!recording&&state==='completed'&&!failed,
    shouldStopMicrophone:recording&&(failed||!!snapshot.backpressure||state==='cancelled'),
    receivedSeconds:validSeconds(snapshot.receivedSeconds),processedSeconds:validSeconds(snapshot.processedSeconds),queuedSeconds:validSeconds(snapshot.queuedSeconds),
    firstNoteLatencyMs:Number.isFinite(snapshot.firstNoteLatencyMs)?Math.max(0,snapshot.firstNoteLatencyMs):null};
}

/** Capture-phase shortcuts must not start microphone prompts while another modal or text field owns input. */
export function transcriptionShortcutAction(event,{modalOpen=false}={}) {
  if(modalOpen||event.defaultPrevented||event.isComposing||event.repeat||!event.ctrlKey||!event.altKey||event.metaKey||event.shiftKey||event.target?.closest?.('input,textarea,select,[contenteditable=true],dialog[open],.native-menu'))return null;
  return {KeyA:'chooseAudio',KeyH:'toggleRecording',KeyT:'open'}[event.code]||null;
}

export function transcriptionCapabilities(scope=globalThis) {
  const navigator=scope.navigator||{};
  return {secure:scope.isSecureContext!==false,webgpu:typeof navigator.gpu?.requestAdapter==='function',webnn:typeof navigator.ml?.createContext==='function',wasm:typeof scope.WebAssembly?.instantiate==='function',microphone:typeof navigator.mediaDevices?.getUserMedia==='function'&&typeof scope.AudioWorkletNode==='function'};
}

/** Downmix only after validating duration, shape and allocation bounds. Native-rate PCM is resampled in the inference worker. */
export async function transcriptionMonoPCM(buffer,{maxSeconds=600,signal,yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0))}={}) {
  if(signal?.aborted)throw aborted();
  if(!buffer||!Number.isInteger(buffer.length)||buffer.length<1||!Number.isInteger(buffer.numberOfChannels)||buffer.numberOfChannels<1||buffer.numberOfChannels>32||!Number.isFinite(buffer.sampleRate)||buffer.sampleRate<8000||buffer.sampleRate>384000||typeof buffer.getChannelData!=='function')throw new Error('音频 PCM 无效。');
  if(!Number.isFinite(maxSeconds)||maxSeconds<=0||buffer.length/buffer.sampleRate>maxSeconds)throw new Error(`音频不能超过 ${maxSeconds} 秒，请先裁剪后再导入。`);
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
  if(channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==buffer.length))throw new Error('音频声道长度不一致。');
  const pcm=new Float32Array(buffer.length);
  for(let first=0;first<pcm.length;first+=65536) {
    if(signal?.aborted)throw aborted();
    const end=Math.min(pcm.length,first+65536);
    for(let i=first;i<end;i++){let value=0;for(const channel of channels)if(Number.isFinite(channel[i]))value+=channel[i]/channels.length;pcm[i]=Math.max(-1,Math.min(1,value));}
    if(end<pcm.length)await yieldTask();
  }
  return {pcm,sampleRate:buffer.sampleRate,duration:pcm.length/buffer.sampleRate};
}

/** The microphone is requested only by start(); stop/destroy always stop every acquired track. */
export function createMicrophoneCapture({scope=globalThis,onAudio=()=>{},onError=()=>{},onLimit=()=>{},beforeStart=()=>{},maxSeconds=600,echoCancellation=true,maxPendingChunks=8}={}) {
  let context=null,stream=null,source=null,node=null,phase='idle',generation=0,stopPromise=null,flushed=null,failure=null;
  const pending=new Set();
  const release=async()=>{
    try{source?.disconnect();}catch{}try{node?.disconnect();}catch{}
    for(const track of stream?.getTracks?.()||[])try{track.stop();}catch{}
    stream=null;source=null;if(node)node.port.onmessage=null;node=null;
    const previous=context;context=null;if(previous&&previous.state!=='closed')try{await previous.close();}catch{}
  };
  const stop=({flush=true}={})=>{
    if(stopPromise)return stopPromise;
    generation++;const previous=phase;phase='stopping';
    for(const track of stream?.getTracks?.()||[])try{track.stop();}catch{}
    stopPromise=(async()=>{
      if(node&&previous==='recording'){
        const ack=new Promise(resolve=>{flushed=resolve;});
        node.port.postMessage({type:'stop',flush});
        let timer;await Promise.race([ack,new Promise(resolve=>{timer=setTimeout(resolve,750);})]);clearTimeout(timer);flushed=null;
      }
      if(flush&&pending.size){let timer;await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);clearTimeout(timer);}
      await release();phase='stopped';
    })();
    return stopPromise;
  };
  const fail=error=>{if(failure)return;failure=error;stop({flush:false}).finally(()=>onError(error));};
  async function start() {
    if(phase!=='idle')throw new Error('此录音会话已经开始。');
    if(!transcriptionCapabilities(scope).secure)throw new Error('录音需要 HTTPS 或 localhost。');
    const Context=scope.AudioContext||scope.webkitAudioContext;
    if(!Context||!scope.navigator?.mediaDevices?.getUserMedia||!scope.AudioWorkletNode)throw new Error('此浏览器未提供麦克风或 AudioWorklet，请使用支持的浏览器。');
    if(!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>3600)throw new Error('录音时长上限无效。');
    phase='starting';const token=++generation;
    try {
      context=new Context({latencyHint:'interactive'});const resume=Promise.resolve(context.resume());resume.catch(()=>{});
      stream=await scope.navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation,noiseSuppression:false,autoGainControl:false},video:false});
      if(token!==generation)throw aborted();await resume;
      if(!context.audioWorklet?.addModule)throw new Error('此浏览器无法启动麦克风音频处理。');
      await context.audioWorklet.addModule(new URL('./transcription-capture-worklet.js',import.meta.url));
      if(token!==generation)throw aborted();
      await beforeStart({sampleRate:context.sampleRate});if(token!==generation)throw aborted();
      node=new scope.AudioWorkletNode(context,'nbs-transcription-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{chunkFrames:4096,maxFrames:Math.floor(context.sampleRate*maxSeconds)}});
      node.port.onmessage=({data})=>{
        if(data?.type==='stopped'){flushed?.();return;}
        if(data?.type==='limit'){onLimit({seconds:maxSeconds});return;}
        if(data?.type!=='audio'||!['recording','stopping'].includes(phase))return;
        if(pending.size>=maxPendingChunks){fail(new Error('录音数据来不及交给识别任务，已停止麦克风，避免继续积压。'));return;}
        try{
          const pcm=data.pcm instanceof Float32Array?data.pcm:new Float32Array(data.pcm);
          const promise=Promise.resolve(onAudio({pcm,sampleRate:data.sampleRate||context.sampleRate,peak:data.peak||0}));pending.add(promise);
          promise.catch(fail).finally(()=>pending.delete(promise));
        }catch(error){fail(error);}
      };
      source=context.createMediaStreamSource(stream);source.connect(node);node.connect(context.destination);phase='recording';
      return {sampleRate:context.sampleRate};
    }catch(error){await release();phase='stopped';throw error;}
  }
  return {start,stop,destroy:()=>stop({flush:false}),get active(){return phase==='recording';},get state(){return phase;}};
}

/** Non-modal browser-local transcription panel. The editor supplies its existing history/append pipeline. */
export function installTranscriptionUI(h) {
  // innerHTML below is limited to fixed templates and trusted built-in icons.
  // Model metadata, source URLs, errors and recognition output use textContent.
  const document=h.document||globalThis.document,scope=document.defaultView||globalThis,controller=h.controller;
  if(!controller||typeof controller.subscribe!=='function')throw new Error('音频转录控制器未初始化。');
  const toolbar=document.getElementById('appTools');if(!toolbar)throw new Error('找不到编辑器工具栏。');
  const group=document.createElement('div');group.className='toolbar-group transcription-tools';group.setAttribute('aria-label','音频转音符');
  group.innerHTML=`<button id="transcriptionProcessBtn" aria-label="音频转音符" title="音频转音符；处理中点击暂停／继续，右键打开控制面板" aria-controls="transcriptionPanel" aria-expanded="false">${icon('music')}</button><button id="transcriptionMicBtn" aria-label="录制哼唱" title="开始／停止哼唱录音" aria-pressed="false">●</button>`;
  toolbar.append(group);
  const panel=document.createElement('section');panel.id='transcriptionPanel';panel.className='transcription-panel';panel.hidden=true;panel.setAttribute('aria-label','音频转音符');
  panel.innerHTML=`<header class="transcription-heading"><strong>音频转音符</strong><small>本机处理</small><button data-action="close" aria-label="收起转录面板，任务继续" title="收起面板，任务继续">×</button></header>
    <div class="transcription-body"><p class="transcription-intro">录制哼唱或打开音频，识别结果先显示在预览中。选定位置并确认后，才会加入当前曲谱。持续录音先收集约 5 秒音频，再开始首块计算；文件批量处理用时不代表实时录音延迟。</p>
    <div class="transcription-actions"><button data-action="file">${icon('folder')}打开音频…</button><button data-action="record">● 录制哼唱</button><button data-action="process" disabled>暂停识别</button><button data-action="cancel" disabled>取消本次转录</button></div>
    <input data-input="audio" type="file" accept="audio/*,.m4a,.ogg,.wav,.flac,.mp3,.aac,.aiff,.aif,.opus,.webm" hidden>
    <fieldset class="transcription-model"><legend>识别模型</legend><div class="transcription-model-row"><label>模型<select data-setting="model"><option value="small">small · 小型</option><option value="medium">medium · 中型</option><option value="large">large · 大型（外部模型包）</option></select></label><label>计算方式<select data-setting="backend"><option value="auto">自动选择</option><option value="webgpu">WebGPU</option><option value="webnn">WebNN</option><option value="wasm">WASM · CPU</option></select></label></div>
    <div class="transcription-actions"><button data-action="download">下载识别模型…</button><button data-action="capabilities">检查浏览器能力</button><button data-action="package">打开模型包…</button><button data-action="diagnose" disabled>模型自检</button></div><input data-input="package" type="file" accept=".zip,.nbsmodel,.json" hidden>
    <label>模型下载并发<select data-setting="downloadConcurrency"><option value="1">1</option><option value="2">2（默认）</option><option value="3">3</option><option value="4">4</option></select></label><small>每段 40 MiB；下载开始后本次并发数固定。网络不稳定时可降低并发后重试。</small>
    <label>模型包地址<input data-setting="modelURL" type="url" placeholder="https://…/model.json" spellcheck="false" autocomplete="off"></label><button data-action="loadURL">从地址加载模型</button>
    <p data-output="capabilities" class="transcription-hint"></p><p data-output="model" class="transcription-hint">small 和 medium 首次下载后会在浏览器内自动准备并缓存，无需手动转换。</p>
    <label class="transcription-check"><input data-setting="allowSlow" type="checkbox">性能建议较低时仍尝试运行</label><small>不能绕过缺失的浏览器接口、模型不兼容或内存分配失败。</small>
    <div class="transcription-download-status" data-output="downloadArea" hidden><strong data-output="downloadStage"></strong><progress data-output="downloadProgress" max="1" value="0"></progress><p data-output="downloadStats"></p><p data-output="downloadError" class="transcription-error" hidden></p><div class="transcription-actions"><button data-action="cancelDownload">取消下载</button><button data-action="retryDownload" hidden>重试下载</button></div></div>
    <p data-output="diagnostic" class="transcription-hint"></p><details><summary>模型缓存</summary><div class="transcription-cache"><select data-setting="cache" aria-label="已缓存的模型"></select><button data-action="refreshCache">刷新</button><button data-action="loadCache">加载所选模型</button><button data-action="clearCache">清除此模型缓存</button></div><p data-output="cache" class="transcription-hint"></p></details></fieldset>
    <div class="transcription-status" role="status" aria-live="polite"><strong data-output="status">等待开始</strong><span data-output="source"></span><progress data-output="progress" max="1" value="0"></progress><p data-output="stats"></p><p data-output="error" class="transcription-error" hidden></p></div>
    <canvas data-output="preview" width="480" height="160" aria-label="识别音符临时预览"></canvas><p data-output="previewText" class="transcription-hint">尚无识别音符。</p><p data-output="insertionInfo" class="transcription-hint" hidden></p>
    <div class="transcription-actions transcription-insert"><button data-action="mapping">音色与网格映射…</button><button data-action="pick" disabled>点选落谱位置</button><button data-action="insert" class="primary-button" disabled>确认写入曲谱</button></div><p data-output="anchor" class="transcription-hint">录音结束后可在谱面点选位置，识别完成后一次性写入。整个写入可一次撤销。</p>
    <label class="transcription-check"><input data-setting="echo" type="checkbox" checked>录音时抑制扬声器回声</label>
    <p class="transcription-hint">录音只在主动点击后开启；最长 10 分钟。识别积压达到上限会停止录音。建议使用耳机，避免把正在播放的曲谱再次录入。</p></div>`;
  document.body.append(panel);
  const downloadDialog=document.createElement('dialog');downloadDialog.id='transcriptionDownloadDialog';downloadDialog.className='transcription-download-dialog';downloadDialog.setAttribute('aria-labelledby','transcriptionDownloadTitle');
  downloadDialog.innerHTML=`<div class="transcription-heading"><strong id="transcriptionDownloadTitle">首次使用需要下载较大的模型</strong><button data-download-action="close" aria-label="关闭模型下载确认">×</button></div><div class="transcription-body"><p>识别在当前浏览器中进行。模型会由浏览器直接从 <strong>ModelScope</strong> 下载并保存在本机缓存；本站服务器不托管这些大权重，录音和音频不会上传处理。</p><div class="transcription-download-sizes" data-download-output="sizes"></div><label>本次下载<select data-download-setting="variant"><option value="small">small</option><option value="medium">medium</option><option value="large">large · 外部模型包</option></select></label><p data-download-output="selected"></p><label>模型下载并发<select data-download-setting="concurrency"><option value="1">1</option><option value="2">2（默认）</option><option value="3">3</option><option value="4">4</option></select></label><p class="transcription-hint">每段 40 MiB；下载开始后本次并发数固定，设置会保存在此浏览器。</p><p class="transcription-hint">首次使用还需加载浏览器推理组件，约 29 MB。模型转换及缓存会额外占用本机存储和内存，建议使用稳定网络；已有可用缓存时可直接使用。</p><p data-download-output="source" class="transcription-download-source"></p><p data-download-output="unavailable" class="transcription-error" hidden></p><div class="transcription-actions"><button data-download-action="close">暂不下载</button><button data-download-action="confirm" class="primary-button">确认下载</button></div></div>`;
  document.body.append(downloadDialog);
  const $=name=>panel.querySelector(`[data-output="${name}"]`),setting=name=>panel.querySelector(`[data-setting="${name}"]`),action=name=>panel.querySelector(`[data-action="${name}"]`),input=name=>panel.querySelector(`[data-input="${name}"]`);
  const processButton=group.querySelector('#transcriptionProcessBtn'),micButton=group.querySelector('#transcriptionMicBtn');
  let snapshot=controller.getSnapshot?.()||{},recording=false,capture=null,sessionProject=null,session=0,sessionLive=false,startedSession=false,anchor=null,pickerCleanup=null,inserted=false,insertedIds=null,insertionReport=null,sourceLabel='',localError='',decodeBusy=false,decodeAbort=null,pendingAudio=null,destroyed=false,drawFrame=0,lastDraw=0,firstEntry=true,entryGeneration=0;
  const removers=[],listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);removers.push(()=>target.removeEventListener(type,fn,options));};
  const message=error=>error?.message||String(error||'');
  const report=error=>{if(error?.name==='AbortError')return;localError=message(error);render();h.error?.(error);};
  const run=fn=>(...args)=>Promise.resolve().then(()=>fn(...args)).catch(report);
  const project=()=>h.getProjectRef?.()||h.getSong?.();
  const currentView=()=>transcriptionViewState({...snapshot,notes:startedSession?snapshot.notes:[]},recording);
  const ensureProject=()=>{if(sessionProject&&project()!==sessionProject)throw new Error('当前工程已切换。为保留原工程，转录结果不会写入其他工程；请重新开始转录。');};
  const configure=()=>controller.configure({model:setting('model').value,backend:setting('backend').value,allowSlow:setting('allowSlow').checked});
  const open=()=>{panel.hidden=false;processButton.setAttribute('aria-expanded','true');render();};
  const downloadInfo=h.getDownloadInfo||getTranscriptionDownloadInfo;
  const downloadGate=createTranscriptionDownloadGate({getInfo:downloadInfo,
    listModels:async()=>{const models=await controller.listModels();fillCache(models);return models;},
    loadModel:async(id,variant)=>{setting('model').value=variant;await configure();return controller.loadModel(id);},
    downloadModel:async(variant,options)=>{setting('model').value=variant;await configure();const result=await controller.downloadModel(variant,options);await refreshCache();return result;},
    cancelDownload:()=>controller.cancel(),onChange:()=>render()});
  const dialogOutput=name=>downloadDialog.querySelector(`[data-download-output="${name}"]`),dialogVariant=downloadDialog.querySelector('[data-download-setting="variant"]'),dialogConcurrency=downloadDialog.querySelector('[data-download-setting="concurrency"]');
  const savedConcurrency=h.preferences?.transcriptionDownloadConcurrency;
  let selectedConcurrency=Number.isInteger(savedConcurrency)&&savedConcurrency>=1&&savedConcurrency<=4?savedConcurrency:2;
  const syncDownloadConcurrency=()=>{setting('downloadConcurrency').value=String(selectedConcurrency);dialogConcurrency.value=String(selectedConcurrency);};
  const changeDownloadConcurrency=value=>{if(['downloading','loadingCache'].includes(downloadGate.getSnapshot().phase)){syncDownloadConcurrency();return;}selectedConcurrency=checkedConcurrency(Number(value));syncDownloadConcurrency();if(h.preferences)h.preferences.transcriptionDownloadConcurrency=selectedConcurrency;h.onPreferencesChanged?.();};
  syncDownloadConcurrency();
  function hideDownloadDialog(){if(downloadDialog.open)downloadDialog.close();}
  function showDownloadDialog(info){
    dialogVariant.value=info.variant;dialogOutput('sizes').replaceChildren();
    syncDownloadConcurrency();
    for(const variant of ['small','medium']){const item=downloadInfo(variant),row=document.createElement('p');row.textContent=`${item.label||variant}：约 ${formatTranscriptionBytes(item.bytes)}`;dialogOutput('sizes').append(row);}
    dialogOutput('selected').textContent=`${info.label} · 权重下载约 ${formatTranscriptionBytes(info.bytes)}`;
    dialogOutput('source').textContent=info.url?`下载来源：${info.url}`:'此档位通过外部浏览器模型包加载。';
    dialogOutput('unavailable').hidden=info.available;dialogOutput('unavailable').textContent=info.available?'':info.unavailableReason||'当前构建尚未提供此模型的浏览器转换图，下载暂未开放。';
    downloadDialog.querySelector('[data-download-action="confirm"]').disabled=!info.available;
    if(!downloadDialog.open)downloadDialog.showModal();
  }
  async function requestDownload({checkCache=false}={}){
    open();const token=++entryGeneration,checked=await downloadGate.inspect(setting('model').value,{checkCache});
    if(destroyed||token!==entryGeneration||panel.hidden)return;
    if(checked.phase==='cached'){await downloadGate.useCached();await resumePendingAudio();render();return;}
    showDownloadDialog(checked.info);
  }
  async function enter(){
    open();if(!firstEntry)return;firstEntry=false;
    if(snapshot.modelReady&&!snapshot.testOnly){await refreshCache();return;}
    await requestDownload({checkCache:true});
  }
  function clearPicker(){try{pickerCleanup?.();}catch{}pickerCleanup=null;}
  function close(){entryGeneration++;panel.hidden=true;processButton.setAttribute('aria-expanded','false');clearPicker();}
  function freshSession(label,{live=false}={}){session++;sessionLive=live;startedSession=false;sessionProject=project();anchor=null;inserted=false;insertedIds=null;insertionReport=null;sourceLabel=label;localError='';clearPicker();return session;}
  async function resumePendingAudio(){const waiting=pendingAudio;if(!waiting||!currentView().canImport)return;if(waiting.project!==project()){pendingAudio=null;return;}pendingAudio=null;await importAudio(waiting.file);}
  async function toggleProcess(){const view=transcriptionViewState(snapshot,recording);if(view.state==='paused'){open();await controller.resume();}else if(view.canPause){open();await controller.pause();}else await enter();}
  async function stopRecording({finish=true}={}) {
    const previous=capture;capture=null;recording=false;render();
    if(previous)await previous.stop({flush:finish});
    if(finish){if(snapshot.state==='paused')await controller.resume();await controller.finish();}
  }
  async function toggleRecording() {
    open();if(recording||capture){await stopRecording();return;}
    if(!transcriptionViewState(snapshot).canRecord){await enter();if(!currentView().canRecord)return;}
    const token=freshSession('麦克风录音',{live:true});await configure();
    const microphone=createMicrophoneCapture({scope,maxSeconds:h.maxRecordingSeconds||600,echoCancellation:setting('echo').checked,
      beforeStart:async({sampleRate})=>{if(token!==session)throw aborted();await controller.start({sampleRate,live:true});if(token!==session)throw aborted();startedSession=true;},
      onAudio:audio=>{if(token!==session)return;return controller.appendAudio({...audio,transfer:true});},
      onLimit:()=>{localError='已达到录音时长上限，麦克风已停止，正在处理剩余音频。';run(()=>stopRecording())();},
      onError:error=>{if(token!==session)return;capture=null;recording=false;report(error);if(!transcriptionViewState(snapshot).failed)run(()=>controller.finish())();}});
    capture=microphone;render();
    try{await microphone.start();if(token!==session){await microphone.destroy();return;}recording=true;render();}
    catch(error){if(capture===microphone)capture=null;recording=false;if(token===session)report(error);}
  }
  async function decodeFile(file,signal) {
    const options={maxSeconds:h.maxRecordingSeconds||600,maxInputBytes:128*1024*1024,signal};
    if(signal?.aborted)throw aborted();
    if(file.size>options.maxInputBytes)throw new Error('音频文件不能超过 128 MiB。');
    if(h.decodeAudioFile)return h.decodeAudioFile(file,options);
    const Context=scope.OfflineAudioContext||scope.webkitOfflineAudioContext;if(!Context)throw new Error('此浏览器未提供音频文件解码。');
    const context=new Context(1,1,48000);
    let audio;try{audio=await context.decodeAudioData(await file.arrayBuffer());}catch(error){if(signal?.aborted||error.name==='AbortError')throw aborted();throw new Error('此音频编码无法由当前浏览器解码。请换用 WAV，或启用项目的浏览器格式解码器。');}
    if(signal?.aborted)throw aborted();
    return transcriptionMonoPCM(audio,options);
  }
  async function importAudio(file) {
    open();if(!file)return;
    if(decodeBusy||capture||currentView().busy)throw new Error('请先完成或取消当前转录，再打开另一段音频。');
    if(file.size>128*1024*1024)throw new Error('音频文件不能超过 128 MiB。');
    if(!transcriptionViewState(snapshot).canImport){const waiting={file,project:project()};pendingAudio=waiting;sourceLabel=`待识别：${file.name}`;await enter();if(pendingAudio!==waiting||!currentView().canImport)return;pendingAudio=null;}
    const token=freshSession(file.name),abortController=new AbortController();decodeAbort=abortController;decodeBusy=true;render();
    try{
      await configure();const decoded=await decodeFile(file,abortController.signal);if(token!==session||abortController.signal.aborted)return;
      const pcm=decoded.pcm||decoded.data,sampleRate=decoded.sampleRate;
      if(!(pcm instanceof Float32Array)||!Number.isFinite(sampleRate)||pcm.length/sampleRate>(h.maxRecordingSeconds||600))throw new Error('音频解码结果无效或超过时长上限。');
      ensureProject();await controller.start({sampleRate,live:false,source:file.name});if(token!==session)return;startedSession=true;
      const step=Math.max(128,Math.round(sampleRate));
      for(let offset=0;offset<pcm.length;offset+=step){
        if(token!==session)return;
        while(transcriptionViewState(snapshot).queuedSeconds>90||transcriptionViewState(snapshot).state==='paused'){
          if(token!==session)return;if(transcriptionViewState(snapshot).failed)throw new Error(message(snapshot.error));
          await new Promise(resolve=>setTimeout(resolve,80));
        }
        await controller.appendAudio({pcm:pcm.slice(offset,Math.min(pcm.length,offset+step)),sampleRate,transfer:true});
        if(offset% (step*8)===0)await new Promise(resolve=>setTimeout(resolve,0));
      }
      await controller.finish();
    }finally{if(decodeAbort===abortController)decodeAbort=null;if(token===session){decodeBusy=false;render();}}
  }
  async function cancel(){session++;entryGeneration++;startedSession=false;decodeAbort?.abort();decodeAbort=null;decodeBusy=false;pendingAudio=null;localError='';sourceLabel='';clearPicker();anchor=null;inserted=false;insertedIds=null;insertionReport=null;const previous=capture;capture=null;recording=false;const release=previous?.destroy();if(['downloading','loadingCache'].includes(downloadGate.getSnapshot().phase))await downloadGate.cancel();else{await controller.cancel();downloadGate.reset();}await release;render();}
  function projectChanged(){const active=decodeBusy||capture||currentView().busy||snapshot.state==='loading'||['downloading','loadingCache'].includes(downloadGate.getSnapshot().phase);pendingAudio=null;sourceLabel='';localError='';anchor=null;inserted=false;insertedIds=null;insertionReport=null;clearPicker();hideDownloadDialog();entryGeneration++;if(active)return cancel();session++;startedSession=false;sessionProject=null;downloadGate.reset();render();return Promise.resolve();}
  function syncHistory(notes){
    if(!insertedIds?.size||!Array.isArray(notes))return;
    const present=notes.some(note=>insertedIds.has(note?.id));
    if(present===inserted)return;inserted=present;anchor=null;clearPicker();render();
  }
  async function pick(){
    ensureProject();if(recording)throw new Error('请先停止麦克风录音。');if(inserted||!currentView().notes.length)return;
    if(typeof h.pickInsertion!=='function')throw new Error('此编辑器尚未连接点选落谱位置功能。');
    clearPicker();const token=session;close();
    const selected=value=>{if(token!==session||!value)return;try{ensureProject();anchor={...value};inserted=false;pickerCleanup=null;open();render();}catch(error){open();report(error);}};
    const result=h.pickInsertion(selected);if(typeof result==='function')pickerCleanup=result;else if(result?.then)await result.then(selected);else if(result&&Number.isFinite(result.tick))selected(result);
  }
  async function insert(){
    ensureProject();const view=currentView();if(!view.canInsert||!anchor||inserted)return;
    if(typeof h.commitNotes!=='function')throw new Error('此编辑器尚未连接转录落谱功能。');
    const token=session,options=h.getMappingOptions?.()||{};
    const result=await h.commitNotes(view.notes,options,{...anchor,project:sessionProject});
    if(token!==session)return;
    inserted=result?.changed!==false&&result?.addedNotes!==0;insertedIds=inserted&&Array.isArray(result?.selectedIds)?new Set(result.selectedIds):null;
    insertionReport={rawCount:view.notes.length,addedCount:result?.addedNotes??result?.counts?.notes??result?.noteCount??view.notes.length,changed:inserted,warnings:(Array.isArray(result?.warnings)?result.warnings:[]).map(message),diagnostics:result?.diagnostics||null};
    render();if(inserted)h.toast?.(`已写入 ${insertionReport.addedCount} 个落谱音符，可一次撤销。${insertionReport.warnings.length?'整理说明已保留在转录面板。':''}`);
  }
  async function loadPackage(value){open();localError='';await configure();await controller.loadPackage(value);if(['small','medium','large'].includes(snapshot.model))setting('model').value=snapshot.model;await refreshCache();await resumePendingAudio();render();}
  function fillCache(models){
    const select=setting('cache'),previous=select.value;select.replaceChildren();
    for(const model of Array.isArray(models)?models:models?.models||[]){const option=document.createElement('option');option.value=String(model.id||model.model||model.name||model);option.textContent=String(model.name||model.id||model.model||model);if(Number.isFinite(model.bytes))option.textContent+=` · ${formatTranscriptionBytes(model.bytes)}`;select.append(option);}
    if([...select.options].some(option=>option.value===previous))select.value=previous;
    $('cache').textContent=select.options.length?'缓存只保存在当前浏览器，加载所选模型无需重新下载。':'当前浏览器没有已缓存的模型。';
  }
  async function refreshCache(){if(typeof controller.listModels!=='function')return [];const models=await controller.listModels();fillCache(models);return models;}
  function capabilities(){
    const c=transcriptionCapabilities(scope),parts=[`WebGPU：${c.webgpu?'接口可用':'未提供'}`,`WebNN：${c.webnn?'接口可用':'未提供'}`,`WASM：${c.wasm?'可用':'未提供'}`];
    $('capabilities').textContent=`${parts.join('；')}。${!c.secure?'请通过 HTTPS 或 localhost 打开。':'接口可用不代表模型可运行或达到实时。small 资源占用较低，准确率仍需核对预览中的音高与时值；模型自检后仍需观察真实速度与积压。'}`;
    return c;
  }
  function schedulePreview(){if(drawFrame||panel.hidden)return;drawFrame=scope.requestAnimationFrame?.(drawPreview)||0;}
  function drawPreview(now=performance.now()){
    drawFrame=0;if(panel.hidden)return;if(now-lastDraw<150){drawFrame=scope.requestAnimationFrame?.(drawPreview)||0;return;}lastDraw=now;
    const canvas=$('preview'),ctx=canvas.getContext('2d');if(!ctx)return;
    const width=canvas.width,height=canvas.height,dark=document.body.classList.contains('theme-dark');
    ctx.fillStyle=dark?'#202020':'#fff';ctx.fillRect(0,0,width,height);
    const notes=currentView().notes.slice(-3000),end=Math.max(10,...notes.map(n=>Number(n.endSeconds??n.startSeconds)||0)),start=Math.max(0,end-20),span=Math.max(10,end-start);
    ctx.strokeStyle=dark?'#3b3b3b':'#e8e8e8';ctx.lineWidth=1;
    for(let i=0;i<=10;i++){const x=i*width/10;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
    for(let i=0;i<8;i++){const y=i*height/8;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}
    for(const note of notes){const time=Number(note.startSeconds),key=Number(note.midiKey);if(!Number.isFinite(time)||!Number.isFinite(key)||time<start||key<0||key>127)continue;const stop=Math.max(time+.04,Number(note.endSeconds)||time+.15);ctx.fillStyle=`hsl(${(Number(note.program)||0)*37%360} 60% 48%)`;ctx.fillRect((time-start)/span*width,(127-key)/128*(height-4),Math.max(2,(stop-time)/span*width),4);}
  }
  function render(){
    if(destroyed)return;const view=currentView(),paused=view.state==='paused',ready=view.canRecord;
    processButton.setAttribute('aria-expanded',String(!panel.hidden));processButton.setAttribute('aria-label',view.canPause?(paused?'继续音频识别':'暂停音频识别'):'音频转音符');processButton.classList.toggle('active',view.busy);
    micButton.classList.toggle('active',recording);micButton.setAttribute('aria-pressed',String(recording));micButton.setAttribute('aria-label',capture&&!recording?'正在准备录音':recording?'停止哼唱录音':'录制哼唱');micButton.disabled=!!capture&&!recording||decodeBusy||(!ready&&!recording);
    action('record').textContent=capture&&!recording?'正在准备录音…':recording?'■ 停止录音':'● 录制哼唱';action('record').disabled=micButton.disabled;
    action('process').textContent=paused?'继续识别':'暂停识别';action('process').disabled=!view.canPause;
    action('cancel').disabled=!view.canCancel&&!capture&&!decodeBusy&&!pendingAudio;action('file').disabled=!view.canImport||decodeBusy;
    for(const name of ['model','backend','allowSlow','modelURL'])setting(name).disabled=!view.canConfigure||decodeBusy;
    for(const name of ['package','loadURL','loadCache','clearCache','download'])action(name).disabled=!view.canConfigure||decodeBusy;
    if(!setting('cache').value){action('loadCache').disabled=true;action('clearCache').disabled=true;}
    action('diagnose').disabled=!view.canConfigure||decodeBusy||!snapshot.modelReady;
    action('mapping').disabled=typeof h.showMidiMapping!=='function';
    action('pick').disabled=inserted||!view.notes.length||recording||!!capture;action('insert').disabled=!view.canInsert||!anchor||inserted;
    const downloadPhase=downloadGate.getSnapshot().phase;
    setting('downloadConcurrency').disabled=['downloading','loadingCache'].includes(downloadPhase);dialogConcurrency.disabled=setting('downloadConcurrency').disabled;
    $('status').textContent=downloadPhase==='error'?'模型准备失败':downloadPhase==='downloading'?'正在准备识别模型':downloadPhase==='loadingCache'?'正在读取已缓存模型':decodeBusy&&!view.busy?'正在解码本地音频':view.label;$('source').textContent=sourceLabel;
    const stats=[`已接收 ${view.receivedSeconds.toFixed(1)} 秒`,`已处理 ${view.processedSeconds.toFixed(1)} 秒`,`待处理 ${view.queuedSeconds.toFixed(1)} 秒`,`${view.notes.length.toLocaleString()} 个音符`];
    if(startedSession&&view.firstNoteLatencyMs!==null)stats.push(sessionLive?`录音开始至首批结果 ${(view.firstNoteLatencyMs/1000).toFixed(2)} 秒（含音频收集与计算）`:`文件首批结果计算用时 ${(view.firstNoteLatencyMs/1000).toFixed(2)} 秒（批量处理，非实时录音延迟）`);
    $('stats').textContent=stats.join(' · ');
    const loading=snapshot.modelProgress;
    $('progress').value=view.state==='loading'&&loading&&Number(loading.total)>0?Math.min(1,Number(loading.loaded||0)/Number(loading.total)):view.receivedSeconds?Math.min(1,view.processedSeconds/view.receivedSeconds):0;
    if(view.state==='loading'&&loading){const loaded=Number(loading.loaded),total=Number(loading.total);$('stats').textContent=Number.isFinite(loaded)?`模型准备 ${formatTranscriptionBytes(loaded)}${total>0?` / ${formatTranscriptionBytes(total)}`:''}`:String(loading.stage||'正在准备浏览器模型');}
    const error=localError||message(snapshot.error);$('error').hidden=!error;$('error').textContent=error;
    $('model').textContent=snapshot.testOnly?'随机权重测试包：仅用于检查浏览器推理链，不能识别音乐。录音、音频识别和写入曲谱已禁用。':snapshot.modelReady?`模型 ${snapshot.model||setting('model').value} 已加载${snapshot.actualBackend||snapshot.backend?` · ${snapshot.actualBackend||snapshot.backend}`:''}。${(snapshot.warnings||[]).map(message).join(' ')}`:setting('model').value==='large'?'large 需要提供兼容的浏览器模型包；模型加载和识别均在本机进行。':'首次下载后会在浏览器内自动准备并缓存，无需手动转换；模型加载和识别均在本机进行。';
    $('model').classList.toggle('transcription-test-only',!!snapshot.testOnly);
    const diagnostic=snapshot.diagnostic;$('diagnostic').textContent=diagnostic?`${diagnostic.passed?'推理链自检通过':'推理链自检失败'}${Number.isFinite(diagnostic.milliseconds)?` · ${diagnostic.milliseconds.toFixed(1)} ms`:''}${diagnostic.backend?` · ${diagnostic.backend}`:''}。这项自检不代表音乐识别准确率或实时性能通过。`:'';
    $('previewText').textContent=view.notes.length?inserted?`原始识别 ${view.notes.length.toLocaleString()} 个音符；本次已写入工程 ${insertionReport?.addedCount??view.notes.length} 个落谱音符。`:view.failed?`未完成的临时预览：${view.notes.length.toLocaleString()} 个音符。本次识别失败，不能写入工程。`:`临时预览：原始识别 ${view.notes.length.toLocaleString()} 个音符，尚未写入工程。`:'尚无识别音符。';
    $('insertionInfo').hidden=!insertionReport;
    if(insertionReport){const report=insertionReport,details=[`上次落谱整理：原始 ${report.rawCount} → 落谱 ${report.addedCount} 个音符${!inserted&&report.changed?'（本次追加已撤销）':!report.changed?'（未写入）':''}。`,...report.warnings],d=report.diagnostics;if(d)details.push(`整理统计：原始完全重复 ${d.rawExactDuplicates??0}；映射/量化重合 ${d.mappedCollisions??0}；合并重复目标 ${d.duplicateTargetsRemoved??0}。原始识别与评分未修改。`);$('insertionInfo').textContent=details.join(' ');}else $('insertionInfo').textContent='';
    $('anchor').textContent=inserted?'本次结果已写入曲谱，可在编辑器中撤销。':view.failed?'本次识别失败，部分预览不能写入；请重新开始转录。':anchor?`已选定 tick ${Math.max(0,Math.trunc(anchor.tick))}；${view.canInsert?'可确认写入新音轨。':'等待识别完成后确认写入。'}`:'录音结束后可在谱面点选位置，识别完成后一次性写入。整个写入可一次撤销。';
    const download=downloadGate.getSnapshot(),progress=download.progress,stages={download:'正在下载模型权重',verify:'正在校验模型',convert:'正在转换浏览器权重',cache:'正在保存浏览器缓存',runtime:'正在加载浏览器推理组件',compile:'正在准备浏览器推理'};
    $('downloadArea').hidden=!['downloading','loadingCache','complete','error','cancelled'].includes(download.phase);
    $('downloadStage').textContent=download.phase==='downloading'?(stages[progress?.stage]||'正在准备模型'):download.phase==='loadingCache'?'正在读取已缓存模型':download.phase==='complete'?'模型已就绪，下次可直接使用本机缓存':download.phase==='cancelled'?'已取消模型下载':'模型准备失败';
    if(progress?.total&&progress.loaded!==null)$('downloadProgress').value=Math.min(1,progress.loaded/progress.total);else if(download.phase==='complete')$('downloadProgress').value=1;else $('downloadProgress').removeAttribute('value');
    const downloadStats=[];
    if(download.concurrency!==null)downloadStats.push(`每段 40 MiB · 本次 ${download.concurrency} 并发（已固定）`);
    if(progress?.stage==='download'&&progress.loaded!==null){downloadStats.push(`已下载 ${formatTranscriptionBytes(progress.loaded)}${progress.total?` / ${formatTranscriptionBytes(progress.total)}`:''}`);if(progress.bytesPerSecond!==null)downloadStats.push(`${formatTranscriptionBytes(progress.bytesPerSecond)}/s`);}
    else if(progress?.downloadedBytes)downloadStats.push(`模型权重已下载 ${formatTranscriptionBytes(progress.downloadedBytes)}${progress.downloadTotal?` / ${formatTranscriptionBytes(progress.downloadTotal)}`:''}`);
    if(progress?.stage!=='download'&&progress?.total&&progress.loaded!==null)downloadStats.push(`本阶段 ${Math.min(100,Math.round(progress.loaded/progress.total*100))}%`);
    if(download.phase==='loadingCache')downloadStats.push('读取本机缓存，不重新下载模型权重。');
    $('downloadStats').textContent=downloadStats.join(' · ');$('downloadError').hidden=!download.error;$('downloadError').textContent=message(download.error);
    action('cancelDownload').hidden=!['downloading','loadingCache'].includes(download.phase);action('retryDownload').hidden=!download.canRetry||!!snapshot.modelReady&&!snapshot.testOnly;
    schedulePreview();
  }
  listen(processButton,'click',run(toggleProcess));listen(processButton,'contextmenu',event=>{event.preventDefault();run(enter)();});listen(micButton,'click',run(toggleRecording));
    const actions={close,file:()=>input('audio').click(),record:toggleRecording,process:toggleProcess,cancel,download:()=>requestDownload(),retryDownload:async()=>{localError='';await downloadGate.retry({concurrency:selectedConcurrency});await resumePendingAudio();render();},cancelDownload:()=>downloadGate.cancel(),capabilities,package:()=>input('package').click(),loadURL:()=>{const value=setting('modelURL').value.trim();if(!value)throw new Error('请填写模型包地址。');return loadPackage(value);},diagnose:async()=>{localError='';await configure();await controller.diagnose();render();},refreshCache,loadCache:async()=>{localError='';await configure();await controller.loadModel(setting('cache').value);if(['small','medium','large'].includes(snapshot.model))setting('model').value=snapshot.model;await resumePendingAudio();render();},clearCache:async()=>{const id=setting('cache').value;if(id)await controller.clearCache(id);await refreshCache();},mapping:()=>h.showMidiMapping?.(),pick,insert};
  listen(panel,'click',run(event=>{const name=event.target.closest('[data-action]')?.dataset.action;if(name&&actions[name])return actions[name]();}));
  listen(input('audio'),'change',run(()=>{const file=input('audio').files?.[0];input('audio').value='';return importAudio(file);}));
  listen(input('package'),'change',run(()=>{const file=input('package').files?.[0];input('package').value='';if(file)return loadPackage(file);}));
  listen(panel,'keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();close();processButton.focus({preventScroll:true});}});
  listen(downloadDialog,'click',run(async event=>{const name=event.target.closest('[data-download-action]')?.dataset.downloadAction;if(name==='close'){hideDownloadDialog();return;}if(name==='confirm'){hideDownloadDialog();localError='';await downloadGate.confirm({concurrency:selectedConcurrency});await resumePendingAudio();render();}}));
  listen(dialogVariant,'change',run(async()=>{setting('model').value=dialogVariant.value;const state=await downloadGate.inspect(dialogVariant.value,{checkCache:false});showDownloadDialog(state.info);}));
  listen(setting('downloadConcurrency'),'change',run(()=>changeDownloadConcurrency(setting('downloadConcurrency').value)));
  listen(dialogConcurrency,'change',run(()=>changeDownloadConcurrency(dialogConcurrency.value)));
  listen(downloadDialog,'keydown',event=>event.stopPropagation());
  listen(scope,'pagehide',()=>{session++;decodeAbort?.abort();decodeAbort=null;pendingAudio=null;capture?.destroy();capture=null;recording=false;controller.cancel();});
  const unsubscribe=controller.subscribe(next=>{
    snapshot=next?.snapshot||next||controller.getSnapshot?.()||{};
    if(snapshot.modelProgress)downloadGate.progress(snapshot.modelProgress);
    if(transcriptionViewState(snapshot,recording).shouldStopMicrophone&&capture){const previous=capture;capture=null;recording=false;previous.destroy().catch(report);}
    render();
  });
  capabilities();render();
  return {open:run(enter),close,chooseAudio:run(async()=>{if(!currentView().canImport){await enter();if(!currentView().canImport)return;}open();input('audio').click();}),toggleProcessing:run(toggleProcess),toggleRecording:run(toggleRecording),cancel:run(cancel),importAudio:run(importAudio),projectChanged:run(projectChanged),syncHistory,get panel(){return panel;},destroy(){if(destroyed)return;destroyed=true;session++;entryGeneration++;decodeAbort?.abort();decodeAbort=null;pendingAudio=null;clearPicker();capture?.destroy();capture=null;recording=false;controller.cancel();unsubscribe?.();if(drawFrame)scope.cancelAnimationFrame?.(drawFrame);for(const remove of removers)remove();hideDownloadDialog();downloadDialog.remove();panel.remove();group.remove();}};
}
