/** Local-file decoding for transcription. Native Web Audio is preferred; the
 * fallback owns a separate, short-lived FFmpeg WASM Worker, never the exporter.
 */
const MiB=1024*1024,DEFAULT_DECODE_RATE=48000,HEADER_SCAN_BYTES=MiB;
const ASSETS=Object.freeze({module:new URL('../vendor/ffmpeg/esm/index.js',import.meta.url).href,
  classWorkerURL:new URL('../vendor/ffmpeg/esm/worker.js',import.meta.url).href,
  coreURL:new URL('../vendor/ffmpeg/core/ffmpeg-core.js',import.meta.url).href,
  wasmURL:new URL('../vendor/ffmpeg/core/ffmpeg-core.wasm',import.meta.url).href});
const fail=(code,message)=>Object.assign(new Error(message),{code});
const aborted=()=>Object.assign(new Error('音频读取已取消。'),{name:'AbortError',code:'ABORTED'});
const notify=(callback,event)=>{try{callback?.(event);}catch{/* Progress views cannot change a decoding job. */}};
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
const int=(value,fallback,min,max)=>{const n=value===undefined?fallback:value;if(!Number.isSafeInteger(n)||n<min||n>max)throw new RangeError('音频解码容量或时间上限无效。');return n;};
const validRate=rate=>Number.isInteger(rate)&&rate>=8000&&rate<=384000;
const now=()=>globalThis.performance?.now?.()??Date.now();
const tag=(bytes,offset,text)=>offset>=0&&offset+text.length<=bytes.length&&[...text].every((char,index)=>bytes[offset+index]===char.charCodeAt(0));

/** Read only bounded container headers. A rate hint never overrides decoder validation. */
export function probeTranscriptionAudioHeader(source){
  const bytes=source instanceof Uint8Array?source:source instanceof ArrayBuffer?new Uint8Array(source):null;
  if(!bytes||bytes.length<4)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),scanEnd=Math.min(bytes.length,HEADER_SCAN_BYTES);
  const riff=tag(bytes,0,'RIFF')||tag(bytes,0,'RF64'),big=tag(bytes,0,'RIFX');
  if((riff||big)&&tag(bytes,8,'WAVE')){
    let info=null;const little=!big;
    for(let offset=12,steps=0;offset+8<=scanEnd&&steps++<4096;){
      const size=view.getUint32(offset+4,little),start=offset+8;
      if(size>bytes.length-start)return null;
      if(tag(bytes,offset,'fmt ')){
        if(size<16)return null;const code=view.getUint16(start,little),channels=view.getUint16(start+2,little),sampleRate=view.getUint32(start+4,little),align=view.getUint16(start+12,little),bits=view.getUint16(start+14,little);
        if(!validRate(sampleRate)||channels<1||channels>32)return null;
        info={format:'wav',sampleRate,channels};
        if([1,3].includes(code)&&[8,16,24,32,64].includes(bits)&&align===channels*bits/8)info.blockAlign=align;
      }else if(tag(bytes,offset,'data')&&info){if(info.blockAlign&&size%info.blockAlign===0)info.frames=size/info.blockAlign;delete info.blockAlign;return info;}
      offset=start+size+(size&1);
    }
    if(info){delete info.blockAlign;return info;}return null;
  }
  let start=0;
  if(tag(bytes,0,'ID3')){
    if(bytes.length<10||bytes[3]<2||bytes[3]>4||bytes[4]===255||[6,7,8,9].some(index=>bytes[index]&128))return null;
    const size=((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9])+10+(bytes[3]===4&&(bytes[5]&16)?10:0);
    if(size>bytes.length)return null;start=size;
  }
  if(tag(bytes,start,'fLaC')){
    const offset=start+4;if(offset+38>bytes.length||(bytes[offset]&127)!==0||((bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3])!==34)return null;
    const data=offset+4,sampleRate=(bytes[data+10]<<12)|(bytes[data+11]<<4)|(bytes[data+12]>>4),channels=((bytes[data+12]>>1)&7)+1;
    if(!validRate(sampleRate))return null;const frames=(bytes[data+13]&15)*2**32+view.getUint32(data+14,false);
    return {format:'flac',sampleRate,channels,...(frames?{frames}:{})};
  }
  const mp3Header=offset=>{
    if(offset+4>bytes.length||bytes[offset]!==255||(bytes[offset+1]&224)!==224)return null;
    const version=(bytes[offset+1]>>3)&3,layer=(bytes[offset+1]>>1)&3,bitrateIndex=bytes[offset+2]>>4,rateIndex=(bytes[offset+2]>>2)&3;
    if(version===1||layer===0||bitrateIndex===0||bitrateIndex===15||rateIndex===3)return null;
    const sampleRate=[44100,48000,32000][rateIndex]/(version===3?1:version===2?2:4),padding=(bytes[offset+2]>>1)&1;
    const rates=version===3?(layer===3?[0,32,64,96,128,160,192,224,256,288,320,352,384,416,448]:layer===2?[0,32,48,56,64,80,96,112,128,160,192,224,256,320,384]:[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]):layer===3?[0,32,48,56,64,80,96,112,128,144,160,176,192,224,256]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const bitrate=rates[bitrateIndex]*1000,frameBytes=layer===3?Math.floor(12*bitrate/sampleRate+padding)*4:Math.floor((layer===1&&version!==3?72:144)*bitrate/sampleRate)+padding;
    return validRate(sampleRate)?{format:'mp3',sampleRate,channels:(bytes[offset+3]>>6)===3?1:2,frameBytes,version,layer}:null;
  };
  for(let offset=start;offset+8<=Math.min(bytes.length,start+HEADER_SCAN_BYTES);offset++){
    const first=mp3Header(offset);if(!first)continue;const second=mp3Header(offset+first.frameBytes);
    if(second&&first.version===second.version&&first.layer===second.layer&&first.sampleRate===second.sampleRate)return {format:'mp3',sampleRate:first.sampleRate,channels:first.channels};
  }
  return null;
}
function limits(options={}){
  const maxSeconds=options.maxSeconds??600;
  if(typeof maxSeconds!=='number'||!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>3600)throw new RangeError('单次转录音频时长上限必须在 0–3600 秒之间。');
  return {maxSeconds,maxInputBytes:int(options.maxInputBytes,128*MiB,1,512*MiB),maxOutputBytes:int(options.maxOutputBytes,128*MiB,4,256*MiB)};
}
function fileSize(file){return file instanceof Blob?file.size:file instanceof ArrayBuffer||file instanceof Uint8Array?file.byteLength:-1;}
function durationBound(frames,rate,bounds){
  if(frames*4>bounds.maxOutputBytes)throw fail('OUTPUT_TOO_LARGE',`解码后的单声道音频超过 ${bounds.maxOutputBytes/MiB} MiB 上限。`);
  if(frames/rate>bounds.maxSeconds+1e-8)throw fail('INPUT_TOO_LONG',`音频超过本次 ${bounds.maxSeconds} 秒上限，请先截取片段。`);
}

/** Constant local names and protocols; the uploaded filename never becomes code.
 * A one-frame sentinel detects a long input instead of silently truncating it.
 */
export function transcriptionDecodeArguments(options={}){
  const bounds=limits(options),sampleRate=options.sampleRate??DEFAULT_DECODE_RATE,channels=options.channels;
  if(!validRate(sampleRate)||channels!==undefined&&(!Number.isInteger(channels)||channels<1||channels>32))throw new RangeError('音频解码采样率或声道数无效。');
  const frames=Math.floor(bounds.maxSeconds*sampleRate),bytes=Math.min(bounds.maxOutputBytes,frames*4);
  const mix=channels>1?['-af',`pan=mono|c0=${Array.from({length:channels},(_,index)=>`${1/channels}*c${index}`).join('+')}`]:[];
  return ['-hide_banner','-v','error','-max_alloc','268435456','-protocol_whitelist','file,pipe','-threads','1','-i','input.audio',
    '-map','0:a:0','-map_metadata','-1','-vn','-sn','-dn','-t',String((frames+1)/sampleRate),...mix,'-ar',String(sampleRate),'-ac','1',
    '-c:a','pcm_f32le','-threads','1','-fs',String(bytes+4),'-f','f32le','output.f32'];
}

/** mixNativeAudio is exported for real PCM tests and can run without a browser. */
export async function mixTranscriptionAudio(buffer,{signal,...options}={}){
  const bounds=limits(options);
  if(signal?.aborted)throw aborted();
  if(!buffer||!Number.isSafeInteger(buffer.length)||buffer.length<1||!Number.isInteger(buffer.numberOfChannels)||buffer.numberOfChannels<1||buffer.numberOfChannels>32||typeof buffer.getChannelData!=='function'||!Number.isFinite(buffer.sampleRate)||buffer.sampleRate<8000||buffer.sampleRate>384000)throw fail('INVALID_AUDIO','浏览器解码出的音频参数无效。');
  const {length,numberOfChannels,sampleRate}=buffer;durationBound(length,sampleRate,bounds);
  if(length*numberOfChannels*4>bounds.maxOutputBytes)throw fail('OUTPUT_TOO_LARGE',`原生解码声道数据超过 ${bounds.maxOutputBytes/MiB} MiB 上限，请截取较短片段。`);
  const pcm=new Float32Array(length);
  for(let channel=0;channel<numberOfChannels;channel++){
    const source=buffer.getChannelData(channel);
    if(!(source instanceof Float32Array)||source.length!==length)throw fail('INVALID_AUDIO','音频声道数据长度无效。');
    for(let start=0;start<length;start+=65536){
      if(signal?.aborted)throw aborted();const end=Math.min(length,start+65536);
      for(let index=start;index<end;index++){const value=source[index];if(!Number.isFinite(value))throw fail('INVALID_PCM','音频包含非有限样本，请检查源文件。');pcm[index]+=value/numberOfChannels;}
      if(end<length)await yieldTask();
    }
  }
  return {pcm,sampleRate,duration:length/sampleRate,method:'native'};
}

/** Small bounded queue; every fallback job releases its Worker and MEMFS. */
export class TranscriptionAudioDecoder{
  constructor({nativeDecoder,contextFactory,ffmpegFactory,maxTasks,maxQueuedBytes,loadTimeoutMs,decodeTimeoutMs}={}){
    this.nativeDecoder=nativeDecoder;this.contextFactory=contextFactory;this.ffmpegFactory=ffmpegFactory;
    this.limits=Object.freeze({maxTasks:int(maxTasks,2,1,8),maxQueuedBytes:int(maxQueuedBytes,256*MiB,1,512*MiB),
      loadTimeoutMs:int(loadTimeoutMs,120000,10,600000),decodeTimeoutMs:int(decodeTimeoutMs,180000,10,1800000)});
    this.queue=[];this.active=null;this.queuedBytes=0;this.ffmpeg=null;this.generation=0;
  }
  decode(file,options={}){
    try{
      const bounds=limits(options),size=fileSize(file);
      if(size<=0)throw fail('EMPTY_INPUT','请选择非空音频文件。');
      if(size>bounds.maxInputBytes)throw fail('INPUT_TOO_LARGE',`单次转录文件不能超过 ${bounds.maxInputBytes/MiB} MiB。`);
      if(options.signal?.aborted)throw aborted();
      if(this.queue.length+(this.active?1:0)>=this.limits.maxTasks||this.queuedBytes+size>this.limits.maxQueuedBytes)throw fail('QUEUE_FULL','音频解码队列已满，请先完成或取消当前任务。');
      return new Promise((resolve,reject)=>{
        const task={file,size,bounds,onProgress:options.onProgress,signal:options.signal,resolve,reject,controller:new AbortController()};
        task.abort=()=>{
          if(this.active===task){task.controller.abort();return;}
          const index=this.queue.indexOf(task);if(index!==-1){this.queue.splice(index,1);this.queuedBytes-=size;task.signal?.removeEventListener('abort',task.abort);reject(aborted());}
        };
        task.signal?.addEventListener('abort',task.abort,{once:true});this.queue.push(task);this.queuedBytes+=size;void this._pump();
      });
    }catch(error){return Promise.reject(error);}
  }
  getState(){return {active:!!this.active,queued:this.queue.length,queuedBytes:this.queuedBytes};}
  terminate(){
    this._discard();this.active?.controller.abort();
    for(const task of this.queue.splice(0)){task.signal?.removeEventListener('abort',task.abort);this.queuedBytes-=task.size;task.reject(aborted());}
  }
  _discard(){this.generation++;try{this.ffmpeg?.terminate();}catch{/* Worker may already be gone. */}this.ffmpeg=null;}
  _check(task){if(task.controller.signal.aborted)throw aborted();}
  _guard(task,operation,timeoutMs){
    const signal=task.controller.signal;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(callback,value)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);callback(value);};
      const cancel=()=>{this._discard();finish(reject,task.timeoutError||aborted());};
      const timer=setTimeout(()=>{task.timeoutError=fail('DECODE_TIMEOUT','本地音频解码超时，已释放解码器，请截取片段后重试。');this._discard();task.controller.abort();finish(reject,task.timeoutError);},timeoutMs);
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cancel();return;}
      Promise.resolve().then(operation).then(value=>finish(resolve,value),error=>finish(reject,error));
    });
  }
  async _pump(){
    if(this.active)return;const task=this.queue.shift();if(!task)return;this.active=task;
    try{task.resolve(await this._guard(task,()=>this._run(task),this.limits.loadTimeoutMs+this.limits.decodeTimeoutMs));}
    catch(error){this._discard();task.reject(error instanceof Error?error:fail('DECODE_FAILED',String(error)));}
    finally{task.signal?.removeEventListener('abort',task.abort);this.queuedBytes-=task.size;this.active=null;void this._pump();}
  }
  async _native(bytes,task){
    this._check(task);notify(task.onProgress,{stage:'native',progress:0});
    let buffer,context;
    try{
      const input=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
      const sampleRate=task.decodeRate,sourceInfo=task.sourceInfo;
      if(sourceInfo?.frames){durationBound(sourceInfo.frames,sampleRate,task.bounds);if(sourceInfo.frames*sourceInfo.channels*4>task.bounds.maxOutputBytes)throw fail('NATIVE_DECODE_CAPACITY','源文件原生多声道数据过大，改用有界单声道解码。');}
      if(this.nativeDecoder!==undefined){if(typeof this.nativeDecoder!=='function')throw fail('NATIVE_UNAVAILABLE','浏览器原生解码器不可用。');buffer=await this.nativeDecoder(input,{signal:task.controller.signal,sampleRate,sourceInfo});}
      else{
        const factory=this.contextFactory??(({sampleRate:rate})=>{const Context=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;if(!Context)throw fail('NATIVE_UNAVAILABLE','浏览器原生解码器不可用。');return new Context(1,1,rate);});
        context=await factory({sampleRate,sourceInfo,signal:task.controller.signal});this._check(task);buffer=await context.decodeAudioData(input);
      }
      this._check(task);return await mixTranscriptionAudio(buffer,{...task.bounds,signal:task.controller.signal});
    }finally{try{const closing=context?.close?.();closing?.catch?.(()=>{});}catch{/* Offline contexts may not expose close. */}}
  }
  async _fallback(bytes,task){
    this._check(task);const generation=this.generation;let ffmpeg;
    notify(task.onProgress,{stage:'load',progress:0});
    if(this.ffmpegFactory)ffmpeg=await this.ffmpegFactory();
    else{
      if(typeof Worker==='undefined'||!['http:','https:'].includes(globalThis.location?.protocol))throw fail('BROWSER_REQUIRED','请通过 HTTPS 或 localhost 打开网页，音频解码需要浏览器 Worker。');
      const {FFmpeg}=await import(ASSETS.module);ffmpeg=new FFmpeg();
    }
    if(task.controller.signal.aborted||generation!==this.generation){ffmpeg.terminate();throw aborted();}
    this.ffmpeg=ffmpeg;const logs=[];
    const log=event=>{if(event?.message){logs.push(String(event.message).slice(0,200));if(logs.length>4)logs.shift();}};
    const progress=event=>notify(task.onProgress,{stage:'decode',progress:Math.max(0,Math.min(1,Number(event.progress)||0)),time:Math.max(0,Number(event.time)||0)/1e6});
    ffmpeg.on?.('log',log);ffmpeg.on?.('progress',progress);
    try{
      await this._guard(task,()=>ffmpeg.load({classWorkerURL:ASSETS.classWorkerURL,coreURL:ASSETS.coreURL,wasmURL:ASSETS.wasmURL}),this.limits.loadTimeoutMs);
      this._check(task);notify(task.onProgress,{stage:'load',progress:1});
      await ffmpeg.writeFile('input.audio',bytes);this._check(task);
      const sampleRate=task.decodeRate,status=await this._guard(task,()=>ffmpeg.exec(transcriptionDecodeArguments({...task.bounds,sampleRate,channels:task.sourceInfo?.channels}),this.limits.decodeTimeoutMs),this.limits.decodeTimeoutMs);
      this._check(task);if(status!==0)throw fail('DECODE_FAILED',`音频格式无法解码（${status}）。${logs.join(' ').slice(-500)}`);
      const data=await ffmpeg.readFile('output.f32');this._check(task);
      if(!(data instanceof Uint8Array)||!data.byteLength||data.byteLength%4)throw fail('INVALID_PCM','解码器没有输出完整的单声道浮点音频。');
      if(data.byteLength>=task.bounds.maxOutputBytes)throw fail('OUTPUT_TOO_LARGE','解码输出达到容量上限，请先截取较短片段，避免静默截断。');
      const frames=data.byteLength/4;durationBound(frames,sampleRate,task.bounds);
      const view=new DataView(data.buffer,data.byteOffset,data.byteLength),pcm=new Float32Array(frames);
      for(let start=0;start<frames;start+=65536){
        this._check(task);const end=Math.min(frames,start+65536);
        for(let index=start;index<end;index++){const value=view.getFloat32(index*4,true);if(!Number.isFinite(value))throw fail('INVALID_PCM','解码音频包含非有限样本。');pcm[index]=value;}
        if(end<frames)await yieldTask();
      }
      return {pcm,sampleRate,duration:frames/sampleRate,method:'ffmpeg'};
    }finally{
      ffmpeg.off?.('log',log);ffmpeg.off?.('progress',progress);
      if(this.ffmpeg===ffmpeg&&generation===this.generation&&!task.controller.signal.aborted){await Promise.allSettled([ffmpeg.deleteFile('input.audio'),ffmpeg.deleteFile('output.f32')]);}
      if(this.ffmpeg===ffmpeg)this._discard();else try{ffmpeg.terminate();}catch{/* Already cancelled. */}
    }
  }
  async _run(task){
    const started=now();this._check(task);notify(task.onProgress,{stage:'read',progress:0});
    const bytes=task.file instanceof Blob?new Uint8Array(await task.file.arrayBuffer()):task.file instanceof ArrayBuffer?new Uint8Array(task.file.slice(0)):task.file.slice();
    this._check(task);if(bytes.byteLength!==task.size)throw fail('INPUT_CHANGED','读取到的音频文件长度发生变化。');
    const readMs=now()-started;task.sourceInfo=probeTranscriptionAudioHeader(bytes);task.decodeRate=task.sourceInfo?.sampleRate||DEFAULT_DECODE_RATE;
    notify(task.onProgress,{stage:'read',progress:1});notify(task.onProgress,{stage:'header',sourceInfo:task.sourceInfo,decodeSampleRate:task.decodeRate});let result;const decodeStarted=now();
    try{result=await this._native(bytes,task);}
    catch(error){
      this._check(task);
      if(['INPUT_TOO_LONG','OUTPUT_TOO_LARGE','INVALID_AUDIO','INVALID_PCM','DECODE_TIMEOUT'].includes(error?.code)||error?.name==='AbortError')throw error;
      notify(task.onProgress,{stage:'fallback',progress:0});result=await this._fallback(bytes,task);
    }
    this._check(task);result.preprocessing={sourceFormat:task.sourceInfo?.format||'unknown',sourceSampleRate:task.sourceInfo?.sampleRate??null,sourceChannels:task.sourceInfo?.channels??null,decoderRequestedRate:task.decodeRate,decoderOutputRate:result.sampleRate,decoderMayResample:!task.sourceInfo||task.sourceInfo.sampleRate!==result.sampleRate,modelResampler:'julius-in-worker',channelMix:result.method==='native'||task.sourceInfo?.channels?'uniform-mean':'ffmpeg-default-mono',inputBytes:task.size,outputBytes:result.pcm.byteLength,readMs,decodeAndMixMs:now()-decodeStarted,totalMs:now()-started};
    notify(task.onProgress,{stage:'done',progress:1,duration:result.duration,sampleRate:result.sampleRate,preprocessing:result.preprocessing});return result;
  }
}

const transcriptionAudioDecoder=new TranscriptionAudioDecoder();
export const decodeTranscriptionAudio=(file,options)=>transcriptionAudioDecoder.decode(file,options);
export const terminateTranscriptionAudioDecoder=()=>transcriptionAudioDecoder.terminate();
