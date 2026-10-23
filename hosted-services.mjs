/** Anonymous hosted codec service. Local-machine integrations are never mounted here. */
import {spawn} from 'node:child_process';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {open,mkdtemp,rm,stat} from 'node:fs/promises';
import {isIP} from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';

const MiB=1024*1024;
const FORMATS={mp3:{mime:'audio/mpeg',codec:['-c:a','libmp3lame']},flac:{mime:'audio/flac',codec:['-c:a','flac','-compression_level','5']},aiff:{mime:'audio/aiff',codec:['-c:a','pcm_s16be']},ogg:{mime:'audio/ogg',codec:['-c:a','libvorbis','-q:a','6']},wav:{mime:'audio/wav',codec:['-c:a','pcm_s16le']}};
class HostedError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const fail=(status,code,message)=>{throw new HostedError(status,code,message);};
const json=(res,status,data,head=false)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(head?undefined:JSON.stringify(data));};
const equal=(a,b)=>{const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
function integer(value,fallback,min,max,label){const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid ${label}; expected ${min}..${max}.`);return n;}

export function hostedLimits(env=process.env){return {
  maxInputBytes:integer(env.HOSTED_MAX_INPUT_MIB,128,1,512,'HOSTED_MAX_INPUT_MIB')*MiB,
  maxOutputBytes:integer(env.HOSTED_MAX_OUTPUT_MIB,128,1,512,'HOSTED_MAX_OUTPUT_MIB')*MiB,
  bodyTimeoutMs:integer(env.HOSTED_BODY_TIMEOUT_MS,20000,1000,60000,'HOSTED_BODY_TIMEOUT_MS'),
  processTimeoutMs:integer(env.HOSTED_PROCESS_TIMEOUT_MS,120000,1000,120000,'HOSTED_PROCESS_TIMEOUT_MS'),
  rateWindowMs:integer(env.HOSTED_RATE_WINDOW_MS,60000,1000,3600000,'HOSTED_RATE_WINDOW_MS'),
  transcodeRate:integer(env.HOSTED_TRANSCODE_RATE,30,1,120,'HOSTED_TRANSCODE_RATE'),
  capabilityRate:integer(env.HOSTED_CAPABILITY_RATE,60,1,600,'HOSTED_CAPABILITY_RATE'),
  rateClients:integer(env.HOSTED_RATE_CLIENTS,4096,1,65536,'HOSTED_RATE_CLIENTS'),
  sessionTtlSeconds:integer(env.HOSTED_SESSION_TTL_SECONDS,900,60,3600,'HOSTED_SESSION_TTL_SECONDS')
};}

export class ClientRateLimiter{
  constructor({capacity=4096,windowMs=60000,capabilities=60,transcodes=30,now=Date.now}={}){this.capacity=capacity;this.windowMs=windowMs;this.capabilities=capabilities;this.transcodes=transcodes;this.now=now;this.clients=new Map();}
  prune(){const now=this.now();for(const [key,value] of this.clients)if(value.until<=now)this.clients.delete(key);}
  take(address,kind){
    const now=this.now();let entry=this.clients.get(address);
    if(entry?.until<=now){this.clients.delete(address);entry=null;}
    if(!entry){if(this.clients.size>=this.capacity)this.prune();if(this.clients.size>=this.capacity)return {ok:false,code:'CLIENT_LIMIT',retryAfter:Math.ceil(this.windowMs/1000)};entry={until:now+this.windowMs,capabilities:0,transcodes:0};this.clients.set(address,entry);}
    const key=kind==='capabilities'?'capabilities':'transcodes',limit=key==='capabilities'?this.capabilities:this.transcodes;
    if(entry[key]>=limit)return {ok:false,code:'RATE_LIMIT',retryAfter:Math.max(1,Math.ceil((entry.until-now)/1000))};entry[key]++;return {ok:true};
  }
  get size(){return this.clients.size;}
  clear(){this.clients.clear();}
}

async function probe(command,spawnImpl){
  return new Promise(resolve=>{
    let child;try{child=spawnImpl(command,['-version'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{return resolve(null);}
    let text='',settled=false;const done=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');done(null);},3000);timer.unref();
    const data=bytes=>{if(text.length<16000)text+=bytes.toString('utf8').slice(0,16000-text.length);};child.stdout.on('data',data);child.stderr.on('data',data);
    child.once('error',()=>done(null));child.once('close',code=>{const version=text.match(/^ffmpeg version ([A-Za-z0-9._+-]+)/m)?.[1];done(code===0&&version?{command,version:'ffmpeg version '+version.slice(0,100)}:null);});
  });
}
async function findFFmpeg({ffmpegPath,projectRoot,env,spawnImpl}){
  const executable=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
  for(const command of [...new Set([ffmpegPath,env.NBS_FFMPEG,projectRoot&&path.join(projectRoot,'runtime',`${process.platform}-${process.arch}`,executable),'ffmpeg'].filter(Boolean))]){const info=await probe(command,spawnImpl);if(info)return info;}
  return null;
}

/** Stream one bounded upload to private temporary storage, without buffering the entire body. */
async function receiveWav(req,file,{limit,timeoutMs,signal}){
  const declared=req.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>limit))fail(413,'BODY_TOO_LARGE','Audio upload exceeds the configured limit.');
  return new Promise((resolve,reject)=>{
    const output=createWriteStream(file,{flags:'wx',mode:0o600});let bytes=0,error=null,done=false,ended=false;
    const clean=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',bad);req.off('aborted',aborted);signal.removeEventListener('abort',cancel);};
    const stop=value=>{if(done||error)return;error=value;clean();req.resume();output.destroy();};
    const data=chunk=>{bytes+=chunk.length;if(bytes>limit){stop(new HostedError(413,'BODY_TOO_LARGE','Audio upload exceeds the configured limit.'));return;}if(!output.write(chunk))req.pause();};
    const end=()=>{ended=true;output.end();},bad=()=>stop(new HostedError(400,'UPLOAD_FAILED','Audio upload could not be read.')),aborted=()=>stop(new HostedError(499,'CANCELLED','Audio upload was cancelled.'));
    const cancel=()=>stop(new HostedError(499,'CANCELLED','Audio request was cancelled.'));
    const timer=setTimeout(()=>stop(new HostedError(408,'BODY_TIMEOUT','Audio upload timed out.')),timeoutMs);timer.unref();
    output.on('drain',()=>{if(!error)req.resume();});output.once('error',()=>stop(new HostedError(503,'STORAGE_UNAVAILABLE','Temporary audio storage is unavailable.')));
    output.once('close',()=>{if(done)return;done=true;clean();if(error)reject(error);else if(!ended)reject(new HostedError(400,'UPLOAD_FAILED','Audio upload did not finish.'));else resolve(bytes);});
    req.on('data',data);req.once('end',end);req.once('error',bad);req.once('aborted',aborted);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
}

/** Restrict the public decoder input to finite-sized PCM/float RIFF WAVE files. */
async function validateWav(file,size){
  if(size<44)fail(415,'WAV_REQUIRED','Use an uncompressed PCM/float RIFF/WAVE upload.');
  const input=await open(file,'r');
  try{
    const head=Buffer.alloc(12);await input.read(head,0,12,0);if(head.toString('ascii',0,4)!=='RIFF'||head.toString('ascii',8,12)!=='WAVE'||head.readUInt32LE(4)!==size-8)fail(415,'WAV_REQUIRED','Use an uncompressed PCM/float RIFF/WAVE upload.');
    let position=12,format=null,dataLength=null;
    for(let chunks=0;position+8<=size&&chunks<1024;chunks++){
      const chunk=Buffer.alloc(8);await input.read(chunk,0,8,position);const length=chunk.readUInt32LE(4),name=chunk.toString('ascii',0,4);if(position+8+length>size)fail(415,'INVALID_WAV','WAV chunk exceeds the upload.');
      if(name==='fmt '){if(format||length<16||length>64)fail(415,'INVALID_WAV','Unsupported WAV format header.');const fmt=Buffer.alloc(16);await input.read(fmt,0,16,position+8);const code=fmt.readUInt16LE(0),channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4),bits=fmt.readUInt16LE(14),align=fmt.readUInt16LE(12);if(![1,3].includes(code)||![1,2].includes(channels)||rate<8000||rate>384000||!([8,16,24,32].includes(bits))||code===3&&bits!==32||align!==channels*bits/8||fmt.readUInt32LE(8)!==rate*align)fail(415,'INVALID_WAV','Unsupported PCM/float WAV layout.');format={channels,rate,align};}
      if(name==='data'){if(dataLength!==null)fail(415,'INVALID_WAV','Only one WAV data chunk is supported.');dataLength=length;}
      position+=8+length+(length&1);
    }
    if(position!==size||!format||!dataLength||dataLength%format.align)fail(415,'INVALID_WAV','WAV data is incomplete or invalid.');
    const duration=dataLength/(format.rate*format.align);if(duration>3600)fail(413,'AUDIO_TOO_LONG','Audio longer than one hour is not accepted.');return {...format,duration};
  }finally{await input.close();}
}

function codecOptions(url){
  const keys=['format','rate','channels','bitrate'];for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)fail(400,'INVALID_CODEC_OPTIONS','Invalid audio encoding options.');
  const format=url.searchParams.get('format')||'mp3',rate=Number(url.searchParams.get('rate')||48000),channels=Number(url.searchParams.get('channels')||2),bitrate=Number(url.searchParams.get('bitrate')||320);
  if(!Object.hasOwn(FORMATS,format)||![8000,11025,16000,22050,24000,32000,44100,48000,88200,96000,176400,192000,352800,384000].includes(rate)||![1,2].includes(channels)||!Number.isInteger(bitrate)||bitrate<32||bitrate>320)fail(400,'INVALID_CODEC_OPTIONS','Invalid audio encoding options.');return {format,rate,channels,bitrate};
}

/** Caller must first enforce the configured Host; this module never trusts proxy headers. */
export async function createHostedServices({publicOrigin,projectRoot=path.dirname(fileURLToPath(import.meta.url)),ffmpegPath,env=process.env,clientAddress=req=>req.socket.remoteAddress,limits:overrides={},spawnImpl=spawn,pipelineImpl=pipeline,now=Date.now}={}){
  let origin;try{origin=new URL(publicOrigin);}catch{throw new Error('PUBLIC_ORIGIN must be an absolute HTTP(S) origin.');}
  if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.origin!==publicOrigin)throw new Error('PUBLIC_ORIGIN must be an exact HTTP(S) origin without a path or trailing slash.');
  const limits={...hostedLimits(env),...overrides};for(const [name,value] of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1)throw new Error(`Invalid hosted limit: ${name}.`);
  if(limits.maxInputBytes>512*MiB||limits.maxOutputBytes>512*MiB||limits.processTimeoutMs>120000||limits.rateClients>65536||limits.sessionTtlSeconds>3600)throw new Error('Hosted resource limit exceeds its hard ceiling.');
  if(env.HOSTED_ENABLE_TRANSCODE!==undefined&&!['0','1','false','true'].includes(String(env.HOSTED_ENABLE_TRANSCODE)))throw new Error('HOSTED_ENABLE_TRANSCODE must be0/1/false/true.');
  const enabled=!['0','false'].includes(String(env.HOSTED_ENABLE_TRANSCODE??'1'));
  const ffmpeg=enabled?await findFFmpeg({ffmpegPath,projectRoot,env,spawnImpl}):null;
  const secret=randomBytes(32),cookieName=origin.protocol==='https:'?'__Host-nbs_hosted_session':'nbs_hosted_session';
  const mac=value=>createHmac('sha256',secret).update(value).digest('base64url');
  const cookieSignature=value=>mac('session\n'+publicOrigin+'\n'+value),csrf=value=>mac('csrf\n'+publicOrigin+'\n'+value);
  const cookie=req=>{const values=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));if(values.length!==1)return null;const value=values[0].slice(cookieName.length+1);if(!/^[A-Za-z0-9_-]{43}\.\d{10,12}\.[A-Za-z0-9_-]{43}$/.test(value))return null;const [id,expires,signature]=value.split('.'),seconds=Math.floor(now()/1000);if(Number(expires)<=seconds||Number(expires)>seconds+limits.sessionTtlSeconds||!equal(signature,cookieSignature(id+'.'+expires)))return null;return value;};
  const limiter=new ClientRateLimiter({capacity:limits.rateClients,windowMs:limits.rateWindowMs,capabilities:limits.capabilityRate,transcodes:limits.transcodeRate,now});
  const sweep=setInterval(()=>limiter.prune(),Math.min(limits.rateWindowMs,60000));sweep.unref();let closed=false,job=null,cleanup=Promise.resolve();
  function rate(req,res,kind){let address;try{address=clientAddress(req);}catch{}if(typeof address!=='string'||!isIP(address))address='unknown';const result=limiter.take(address,kind);if(!result.ok){res.setHeader('Retry-After',result.retryAfter);fail(429,result.code,'Audio service request limit reached. Try again later.');}}
  async function encode(input,output,options,signal){
    const args=['-hide_banner','-nostdin','-v','error','-y','-max_alloc',String(64*MiB),'-protocol_whitelist','file,pipe','-f','wav','-i',input,'-map','0:a:0','-map_metadata','-1','-vn','-ar',String(options.rate),'-ac',String(options.channels),...FORMATS[options.format].codec];
    if(options.format==='mp3')args.push('-b:a',options.bitrate+'k');args.push('-threads','1','-fs',String(limits.maxOutputBytes+1),'-f',options.format,output);
    await new Promise((resolve,reject)=>{
      let child;try{child=spawnImpl(ffmpeg.command,args,{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});}catch{reject(new HostedError(503,'CODEC_UNAVAILABLE','Audio encoder is unavailable.'));return;}
      let ended=false,stopped=null;job.child=child;
      const stop=error=>{if(!stopped){stopped=error;child.kill('SIGKILL');}};
      const cancel=()=>stop(new HostedError(499,'CANCELLED','Audio encoding was cancelled.'));
      const timer=setTimeout(()=>stop(new HostedError(504,'CODEC_TIMEOUT','Audio encoding exceeded its time budget.')),limits.processTimeoutMs);timer.unref();
      const finish=error=>{if(ended)return;ended=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);job.child=null;error?reject(error):resolve();};
      child.stderr.on('data',()=>{});child.once('error',()=>finish(new HostedError(503,'CODEC_UNAVAILABLE','Audio encoder is unavailable.')));child.once('close',code=>finish(stopped||(code===0?null:new HostedError(502,'CODEC_FAILED','Audio could not be encoded with the selected settings.'))));
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    });
  }
  async function transcode(req,res,url){
    const session=cookie(req);if(!session||!equal(req.headers['x-nbs-token'],csrf(session)))fail(403,'SESSION_REQUIRED','Refresh the page before requesting server audio encoding.');
    if(!enabled||!ffmpeg)fail(503,'TRANSCODE_UNAVAILABLE','Server audio encoding is unavailable. Browser WAV export remains available.');
    const options=codecOptions(url);if(!/^audio\/(?:wav|wave|x-wav)(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'WAV_REQUIRED','Use Content-Type: audio/wav.');
    rate(req,res,'transcodes');
    // A client can receive the complete response before pipeline() settles.
    // Wait only for an already-finished response; active transfers stay busy.
    const previous=job;if(previous?.response.writableFinished)await previous.done;
    if(closed)fail(503,'SERVICE_CLOSED','Hosted audio services are stopped.');
    if(res.destroyed||req.aborted)fail(499,'CANCELLED','Audio request was cancelled.');
    // All waiters recheck after the await. Only one can reserve the next slot.
    if(job)fail(409,'TRANSCODE_BUSY','Another server audio export is running. Try again later.');
    let release;const done=new Promise(resolve=>release=resolve),controller=new AbortController(),current={controller,done,child:null,response:res};job=current;
    const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);let folder;
    try{
      // Reserve the next slot while the preceding request removes its files.
      // No second upload/encoder starts until that cleanup has finished.
      await cleanup;if(controller.signal.aborted)fail(499,'CANCELLED','Audio request was cancelled.');
      folder=await mkdtemp(path.join(os.tmpdir(),'nbs-hosted-codec-'));const input=path.join(folder,'input.wav'),output=path.join(folder,'output.'+options.format);
      const bytes=await receiveWav(req,input,{limit:limits.maxInputBytes,timeoutMs:limits.bodyTimeoutMs,signal:controller.signal});const wav=await validateWav(input,bytes);
      if(['wav','aiff'].includes(options.format)&&wav.duration*options.rate*options.channels*2+8192>limits.maxOutputBytes)fail(413,'OUTPUT_TOO_LARGE','Requested uncompressed audio exceeds the configured output limit.');
      if(controller.signal.aborted)fail(499,'CANCELLED','Audio request was cancelled.');await encode(input,output,options,controller.signal);
      const info=await stat(output);if(!info.isFile()||!info.size)fail(502,'EMPTY_AUDIO','Audio encoder produced no usable output.');if(info.size>limits.maxOutputBytes)fail(413,'OUTPUT_TOO_LARGE','Encoded audio exceeds the configured output limit.');
      const filename='NoteBlockStudio.'+options.format;res.writeHead(200,{'Content-Type':FORMATS[options.format].mime,'Content-Length':info.size,'Content-Disposition':`attachment; filename="${filename}"`,'X-NBS-Filename':filename,'Cache-Control':'no-store'});
      const delivery=setTimeout(()=>controller.abort(),limits.processTimeoutMs);delivery.unref();try{await pipelineImpl(createReadStream(output),res,{signal:controller.signal});}finally{clearTimeout(delivery);}
    }finally{
      res.off('close',cancel);if(job===current)job=null;
      try{if(folder&&path.dirname(folder)===path.resolve(os.tmpdir())&&path.basename(folder).startsWith('nbs-hosted-codec-'))cleanup=rm(folder,{recursive:true,force:true});await cleanup;}finally{release();}
    }
  }
  async function handle(req,res){
    let url;try{url=new URL(req.url,'http://hosted.invalid');}catch{json(res,400,{error:'Invalid request URL.',code:'BAD_REQUEST'});return true;}
    if(!url.pathname.startsWith('/api/'))return false;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      if(url.pathname==='/api/health'&&['GET','HEAD'].includes(req.method)){json(res,closed?503:200,{ok:!closed,mode:'hosted'},req.method==='HEAD');return true;}
      if(closed)fail(503,'SERVICE_CLOSED','Hosted audio services are stopped.');
      if(req.headers.origin&&req.headers.origin!==publicOrigin||req.headers['sec-fetch-site']==='cross-site')fail(403,'ORIGIN_DENIED','Cross-origin audio service requests are denied.');
      if(url.pathname==='/api/capabilities'&&req.method==='GET'){
        rate(req,res,'capabilities');let value=cookie(req);if(!value){const unsigned=randomBytes(32).toString('base64url')+'.'+(Math.floor(now()/1000)+limits.sessionTtlSeconds);value=unsigned+'.'+cookieSignature(unsigned);res.setHeader('Set-Cookie',`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${limits.sessionTtlSeconds}${origin.protocol==='https:'?'; Secure':''}`);}
        json(res,200,{version:1,mode:'hosted',token:csrf(value),ffmpeg:{available:Boolean(ffmpeg),version:ffmpeg?.version||null},launch:null,features:{transcode:enabled&&Boolean(ffmpeg),presence:false,launchFile:false,fetchSong:false}});return true;
      }
      if(url.pathname==='/api/transcode'&&req.method==='POST'){
        if(req.headers.origin!==publicOrigin)fail(403,'ORIGIN_DENIED','An exact configured Origin is required.');await transcode(req,res,url);return true;
      }
      fail(404,'UNKNOWN_API','This API route is unavailable in hosted mode.');
    }catch(error){
      if(!res.headersSent&&!res.destroyed){if(!req.complete){res.setHeader('Connection','close');req.resume();}json(res,error instanceof HostedError?error.status:500,{error:error instanceof HostedError?error.message:'Hosted audio request failed.',code:error instanceof HostedError?error.code:'SERVICE_ERROR'});}else if(!res.writableEnded)res.destroy();return true;
    }
  }
  return {handle,getStats:()=>({active:Boolean(job),rateClients:limiter.size}),async close(){if(closed)return;closed=true;clearInterval(sweep);limiter.clear();const active=job;if(active){active.controller.abort();await active.done;}await cleanup.catch(()=>{});}};
}
