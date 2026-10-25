/** Browser-local RPC boundary. Audio and model data are sent only to a dedicated same-origin Worker. */
const ACTIVE=new Set(['starting','running','processing','recording','paused','draining']);
const MODELS=new Set(['small','medium','large']),BACKENDS=new Set(['auto','webgpu','webnn','wasm']);
const abortError=()=>Object.assign(new Error('转录已取消'),{name:'AbortError',code:'TRANSCRIPTION_CANCELLED'});
const errorFrom=(value,fallback='转录任务失败')=>{
  if(value instanceof Error)return value;
  const error=new Error(typeof value==='string'?value:value?.message||fallback);
  if(value?.name)error.name=String(value.name);if(value?.code)error.code=String(value.code);return error;
};
const isSnapshot=value=>value&&typeof value==='object'&&!Array.isArray(value)&&('state'in value||'status'in value||'modelReady'in value||'notes'in value);
const resultSnapshot=value=>isSnapshot(value?.snapshot)?value.snapshot:isSnapshot(value)?value:null;

export function detectTranscriptionCapabilities(scope=globalThis) {
  return Object.freeze({secure:scope.isSecureContext!==false,webgpu:typeof scope.navigator?.gpu?.requestAdapter==='function',webnn:typeof scope.navigator?.ml?.createContext==='function',wasm:typeof scope.WebAssembly?.instantiate==='function',worker:typeof scope.Worker==='function'});
}

export class TranscriptionController {
  constructor({workerFactory,scope=globalThis,maxPendingAudio=8,requestTimeoutMs=120000,loadTimeoutMs=900000,onObserverError=error=>console.warn('转录状态监听失败',error)}={}) {
    if(!Number.isInteger(maxPendingAudio)||maxPendingAudio<1||maxPendingAudio>64)throw new RangeError('音频交接队列上限必须为 1–64。');
    for(const value of [requestTimeoutMs,loadTimeoutMs])if(!Number.isFinite(value)||value<0)throw new RangeError('转录请求超时无效。');
    this._scope=scope;this._factory=workerFactory||(()=>new scope.Worker(new URL('./transcription-worker.js',import.meta.url),{type:'module',name:'NBS local transcription'}));
    this._maxPendingAudio=maxPendingAudio;this._requestTimeout=requestTimeoutMs;this._loadTimeout=loadTimeoutMs;this._onObserverError=onObserverError;
    this._worker=null;this._ready=null;this._generation=0;this._lifetime=0;this._lastDropError=null;this._sequence=0;this._jobSequence=0;this._jobId=null;this._destroyed=false;
    this._pending=new Map();this._audio=new Set();this._listeners=new Set();this._fullNotes=null;
    this._config={model:'small',backend:'auto',cpuThreads:2,allowSlow:false};
    this._snapshot=Object.freeze({state:'idle',status:'idle',model:'small',backend:'auto',actualBackend:null,modelId:null,modelReady:false,testOnly:false,notes:Object.freeze([]),noteCount:0,receivedSeconds:0,processedSeconds:0,queuedSeconds:0,firstNoteLatencyMs:null,realTimeFactor:null,error:null,warnings:Object.freeze([]),backpressure:false,capabilities:detectTranscriptionCapabilities(scope)});
  }
  getSnapshot(){return this._snapshot;}
  subscribe(listener){if(typeof listener!=='function')throw new TypeError('转录监听器必须是函数。');this._listeners.add(listener);return()=>this._listeners.delete(listener);}
  _assertLive(){if(this._destroyed)throw Object.assign(new Error('转录控制器已经释放'),{code:'TRANSCRIPTION_DESTROYED'});}
  _assertIdle(){this._assertLive();if(ACTIVE.has(this._snapshot.state)||this._snapshot.state==='loading')throw new Error('请先完成或取消当前转录，再修改模型或开始新的任务。');}
  _publish(patch) {
    const next={...this._snapshot,...patch};
    next.state=String(patch.state||patch.status||next.state||'idle');next.status=next.state;
    if(Array.isArray(next.notes)&&!Object.isFrozen(next.notes))next.notes=Object.freeze(next.notes.slice());
    if(!Array.isArray(next.notes))next.notes=Object.freeze([]);
    if(Array.isArray(next.warnings)&&!Object.isFrozen(next.warnings))next.warnings=Object.freeze(next.warnings.slice());
    if(!Array.isArray(next.warnings))next.warnings=Object.freeze([]);
    this._snapshot=Object.freeze(next);
    for(const listener of [...this._listeners])try{listener(this._snapshot);}catch(error){try{this._onObserverError(error);}catch{}}
    return this._snapshot;
  }
  _apply(snapshot,{final=false,event=false}={}) {
    if(!snapshot)return this._snapshot;
    if(snapshot.jobId!=null&&this._jobId!=null&&snapshot.jobId!==this._jobId)return this._snapshot;
    let next={...snapshot};
    if(final&&Array.isArray(snapshot.notes)){this._fullNotes=Object.freeze(snapshot.notes.slice());next.notes=this._fullNotes;}
    else if(this._fullNotes){next.notes=this._fullNotes;next.noteCount=Math.max(Number(next.noteCount)||0,this._fullNotes.length);if(event&&ACTIVE.has(next.state||next.status)){next.state=this._snapshot.state;next.status=this._snapshot.state;}}
    if(next.modelReady&&typeof next.modelId==='string'&&next.modelId){this._config.modelId=next.modelId;if(MODELS.has(next.model))this._config.model=next.model;}
    return this._publish(next);
  }
  _drop(error) {
    const worker=this._worker;this._worker=null;this._ready=null;this._lifetime++;this._lastDropError=error;
    if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;try{worker.terminate();}catch{}}
    for(const pending of this._pending.values()){clearTimeout(pending.timer);pending.reject(error);}this._pending.clear();this._audio.clear();
  }
  _fatal(value,extra={}) {
    const error=errorFrom(value);this._drop(error);
    this._publish({state:'error',modelReady:false,actualBackend:null,error:{name:error.name,message:error.message,code:error.code||'TRANSCRIPTION_ERROR'},...extra});return error;
  }
  _raw(worker,type,data={},transfer=[],timeout=this._requestTimeout) {
    if(worker!==this._worker)return Promise.reject(abortError());
    const id=++this._sequence;
    return new Promise((resolve,reject)=>{
      let timer;
      if(timeout>0)timer=setTimeout(()=>{if(!this._pending.has(id))return;this._fatal(Object.assign(new Error(`转录任务 ${type} 超时，已释放识别线程；可重新加载模型后重试。`),{code:'TRANSCRIPTION_TIMEOUT'}));},timeout);
      this._pending.set(id,{resolve,reject,timer,type,worker});
      try{worker.postMessage({id,type,...data},transfer);}catch(error){clearTimeout(timer);this._pending.delete(id);reject(errorFrom(error));}
    });
  }
  _ensureWorker() {
    this._assertLive();if(this._worker)return this._ready||Promise.resolve(this._worker);
    let worker;
    try{worker=this._factory();if(!worker||typeof worker.postMessage!=='function'||typeof worker.terminate!=='function')throw new Error('无法创建浏览器转录线程。');}
    catch(error){return Promise.reject(this._fatal(error));}
    this._worker=worker;const generation=++this._generation;
    const current=()=>!this._destroyed&&this._worker===worker&&this._generation===generation;
    worker.onmessage=({data})=>{
      if(!current()||!data||typeof data!=='object')return;
      if(data.type==='state'&&data.snapshot){this._apply(data.snapshot,{event:true});return;}
      const id=data.replyTo??data.id,pending=this._pending.get(id);if(!pending||pending.worker!==worker)return;
      clearTimeout(pending.timer);this._pending.delete(id);
      if(data.ok===false){
        const incoming=errorFrom(data.error),preserve=incoming.code==='NO_ACTIVE_JOB'&&!!this._snapshot.error,error=preserve?errorFrom(this._snapshot.error):incoming;
        pending.reject(error);
        if(!preserve&&error.name!=='AbortError'&&pending.type!=='listModels'&&pending.type!=='clearCache')this._publish({state:'error',error:{message:error.message,code:error.code||'TRANSCRIPTION_ERROR',name:error.name}});
      }
      else pending.resolve(data.result);
    };
    worker.onerror=event=>{if(!current())return;event.preventDefault?.();this._fatal(Object.assign(new Error(event.message||'浏览器转录线程异常停止。'),{code:'TRANSCRIPTION_WORKER_FAILED'}));};
    worker.onmessageerror=()=>{if(current())this._fatal(Object.assign(new Error('无法读取转录线程消息。'),{code:'TRANSCRIPTION_MESSAGE_FAILED'}));};
    this._ready=this._raw(worker,'configure',{config:{...this._config}}).then(result=>{
      if(!current())throw abortError();let initial=resultSnapshot(result);
      if(initial&&['loading','starting'].includes(this._snapshot.state)&&['idle','ready'].includes(initial.state||initial.status))initial={...initial,state:this._snapshot.state,status:this._snapshot.state,notes:this._snapshot.notes,jobId:this._jobId};
      this._apply(initial);return worker;
    }).catch(error=>{if(current()&&error.name!=='AbortError')this._fatal(error);throw error;});
    return this._ready;
  }
  async _request(type,data={},transfer=[],timeout) {
    this._assertLive();const lifetime=this._lifetime,worker=await this._ensureWorker();
    if(lifetime!==this._lifetime||worker!==this._worker)throw this._lastDropError||abortError();
    const result=await this._raw(worker,type,data,transfer,timeout);
    if(lifetime!==this._lifetime||worker!==this._worker)throw this._lastDropError||abortError();
    return result;
  }
  async configure(options={}) {
    this._assertIdle();const next={...this._config,...options};
    if(!MODELS.has(next.model)||!BACKENDS.has(next.backend))throw new Error('不支持的转录模型或计算方式。');
    if(!Number.isInteger(next.cpuThreads)||next.cpuThreads<1||next.cpuThreads>4)throw new RangeError('WASM 请求线程数必须是 1–4 的整数。');
    if(options.model&&options.model!==this._config.model&&!Object.hasOwn(options,'modelId'))delete next.modelId;
    // ORT 1.30's module-scoped initWasm cache retains the first WASM pool and
    // _OrtInit setup. Updating env alone cannot apply a different pool later.
    const replaceWorker=!!this._worker&&(next.backend!==this._config.backend||next.cpuThreads!==this._config.cpuThreads);
    this._config={...next,allowSlow:!!next.allowSlow};
    if(replaceWorker){this._drop(abortError());this._publish({state:'idle',model:next.model,backend:next.backend,modelId:next.modelId??null,modelReady:false,actualBackend:null,error:null,backpressure:false,modelProgress:null});}
    const result=await this._request('configure',{config:{...this._config}});this._apply(resultSnapshot(result));return this._snapshot;
  }
  async loadPackage(source) {
    this._assertIdle();
    if(source instanceof URL)source=source.href;
    if(typeof source==='string'){
      const url=new URL(source,this._scope.location?.href||import.meta.url);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('模型地址必须是不含账号密码的 HTTP(S) 地址。');source=url.href;
    }else if(!source||typeof source.name!=='string'||typeof source.arrayBuffer!=='function')throw new Error('请选择本地浏览器模型包，或填写模型包地址。');
    this._publish({state:'loading',modelReady:false,actualBackend:null,error:null,backpressure:false,modelProgress:null});
    try{const result=await this._request('loadPackage',{source},[],this._loadTimeout);const ready=resultSnapshot(result);if(ready?.modelReady!==true)throw new Error('模型包未完成浏览器加载，不能用于识别。');this._apply(ready);return this._snapshot;}
    catch(error){if(error.name!=='AbortError')this._publish({state:'error',error:{message:error.message,code:error.code||'MODEL_LOAD_FAILED'}});throw error;}
  }
  async listModels(){this._assertLive();return this._request('listModels');}
  async downloadModel(variant){
    this._assertIdle();if(!['small','medium'].includes(variant))throw new Error('内置下载目前只提供 small 和 medium，其他档位请导入兼容模型包。');
    this._publish({state:'loading',modelReady:false,actualBackend:null,error:null,backpressure:false,modelProgress:{stage:'download',variant,loaded:0,total:0}});
    try{const result=await this._request('downloadModel',{variant},[],0);const ready=resultSnapshot(result);if(ready?.modelReady!==true)throw new Error('模型下载后未完成浏览器加载，不能用于识别。');this._apply(ready);return this._snapshot;}
    catch(error){if(error.name!=='AbortError')this._publish({state:'error',error:{message:error.message,code:error.code||'MODEL_DOWNLOAD_FAILED'}});throw error;}
  }
  async loadModel(modelId){
    this._assertIdle();if(typeof modelId!=='string'||!modelId.trim())throw new Error('请选择已缓存的模型。');
    this._publish({state:'loading',modelReady:false,actualBackend:null,error:null,backpressure:false,modelProgress:null});
    try{const result=await this._request('loadModel',{modelId},[],this._loadTimeout);const ready=resultSnapshot(result);if(ready?.modelReady!==true)throw new Error('缓存模型未完成浏览器加载，请重新加载有效模型。');this._apply(ready);return this._snapshot;}
    catch(error){if(error.name!=='AbortError')this._publish({state:'error',error:{message:error.message,code:error.code||'MODEL_LOAD_FAILED'}});throw error;}
  }
  async diagnose(){
    this._assertIdle();if(!this._snapshot.modelReady)throw new Error('请先加载浏览器模型包。');
    this._publish({state:'loading',diagnostic:null,error:null});
    try{const result=await this._request('diagnose',{},[],this._loadTimeout);this._apply(resultSnapshot(result));this._publish({state:'ready',diagnostic:result,actualBackend:result?.backend||this._snapshot.actualBackend});return result;}
    catch(error){if(error.name!=='AbortError')this._publish({state:'error',error:{message:error.message,code:error.code||'MODEL_PROBE_FAILED'}});throw error;}
  }
  async clearCache(modelId){this._assertIdle();if(typeof modelId!=='string'||!modelId.trim())throw new Error('模型缓存标识无效。');const result=await this._request('clearCache',{modelId});if(modelId===this._config.modelId){delete this._config.modelId;this._publish({modelReady:false,modelId:null});}this._apply(resultSnapshot(result));return result;}
  async start(options={}) {
    this._assertIdle();const sampleRate=Number(options.sampleRate??16000);
    if(this._snapshot.testOnly)throw Object.assign(new Error('此模型使用随机权重，只能进行推理链自检，不能用于音乐识别。'),{code:'TRANSCRIPTION_TEST_ONLY'});
    if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>384000)throw new RangeError('音频采样率无效。');
    this._fullNotes=null;this._jobId=`${this._generation}:${++this._jobSequence}`;
    this._publish({state:'starting',jobId:this._jobId,notes:Object.freeze([]),noteCount:0,receivedSeconds:0,processedSeconds:0,queuedSeconds:0,firstNoteLatencyMs:null,realTimeFactor:null,error:null,backpressure:false});
    try{const result=await this._request('start',{options:{...options,sampleRate,jobId:this._jobId}},[],this._loadTimeout);this._apply(resultSnapshot(result));return this._snapshot;}
    catch(error){if(error.name!=='AbortError')this._publish({state:'error',error:{message:error.message,code:error.code||'TRANSCRIPTION_START_FAILED'}});throw error;}
  }
  appendAudio({pcm,sampleRate,final=false,transfer=false}={}) {
    try{
      this._assertLive();if(!['running','processing','recording','paused','draining'].includes(this._snapshot.state))throw new Error('请先开始音频转录。');
      if(!(pcm instanceof Float32Array)||(!pcm.length&&!final)||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>384000)throw new Error('转录音频块无效。');
      if(pcm.length>sampleRate*10)throw new RangeError('单次音频块不能超过 10 秒，请分块追加。');
      if(this._audio.size>=this._maxPendingAudio)throw this._fatal(Object.assign(new Error('音频交接队列已满，已停止识别，防止音频继续积压。'),{code:'TRANSCRIPTION_BACKPRESSURE'}),{backpressure:true});
      const owned=transfer&&pcm.buffer instanceof ArrayBuffer&&pcm.byteOffset===0&&pcm.byteLength===pcm.buffer.byteLength;
      const samples=owned?pcm:new Float32Array(pcm),token={};this._audio.add(token);
      return this._request('appendAudio',{pcm:samples,sampleRate,final:!!final},[samples.buffer]).then(result=>{this._apply(resultSnapshot(result));return result;}).finally(()=>this._audio.delete(token));
    }catch(error){return Promise.reject(error);}
  }
  async pause(){this._assertLive();if(!ACTIVE.has(this._snapshot.state))return this._snapshot;const result=await this._request('pause');this._apply(resultSnapshot(result));return this._snapshot;}
  async resume(){this._assertLive();if(this._snapshot.state!=='paused')return this._snapshot;const result=await this._request('resume');this._apply(resultSnapshot(result));return this._snapshot;}
  async finish(){this._assertLive();if(this._snapshot.state==='completed')return this._snapshot;if(!ACTIVE.has(this._snapshot.state))throw new Error('没有可以结束的转录任务。');const result=await this._request('finish',{},[],0);this._apply(resultSnapshot(result),{final:true});return this._snapshot;}
  cancel(){
    this._assertLive();this._drop(abortError());this._fullNotes=null;this._jobId=null;
    return this._publish({state:'cancelled',modelReady:false,actualBackend:null,notes:Object.freeze([]),noteCount:0,queuedSeconds:0,error:null,backpressure:false,jobId:null,modelProgress:null});
  }
  destroy(){if(this._destroyed)return;this._drop(abortError());this._destroyed=true;this._listeners.clear();this._fullNotes=null;}
}

export const createTranscriptionController=options=>new TranscriptionController(options);
