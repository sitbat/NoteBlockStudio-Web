/** Opt-in local integrations. No original archive executable or DLL is loaded. */
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {createConnection} from 'node:net';
import {readFile,writeFile,stat,realpath,mkdtemp,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MIB=1024*1024, MAX_WAV=512*MIB, MAX_SONG=128*MIB;
const APP_ID='848873736702132246';
const FORMAT={mp3:{mime:'audio/mpeg',codec:['-c:a','libmp3lame']},flac:{mime:'audio/flac',codec:['-c:a','flac','-compression_level','5']},aiff:{mime:'audio/aiff',codec:['-c:a','pcm_s16be']},ogg:{mime:'audio/ogg',codec:['-c:a','libvorbis','-q:a','6']},wav:{mime:'audio/wav',codec:['-c:a','pcm_s16le']}};
class ServiceError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const fail=(status,code,message)=>{throw new ServiceError(status,code,message);};
const json=(response,status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(data));};
const safeName=name=>path.basename(String(name).replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'_').slice(0,240)||'song.nbs';
const secretEqual=(a,b)=>{const left=Buffer.from(String(a||'')),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

async function readBody(request,limit,timeoutMs=20000){
  const declared=Number(request.headers['content-length']);
  if(Number.isFinite(declared)&&declared>limit)fail(413,'BODY_TOO_LARGE',`Body exceeds ${Math.floor(limit/MIB)} MiB.`);
  return new Promise((resolve,reject)=>{
    const chunks=[];let length=0,done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('error',errorEvent);request.off('aborted',aborted);if(error){request.resume();reject(error);}else resolve(Buffer.concat(chunks,length));};
    const data=chunk=>{length+=chunk.length;if(length>limit)finish(new ServiceError(413,'BODY_TOO_LARGE','Request body exceeds the local limit.'));else chunks.push(chunk);};
    const end=()=>finish();const errorEvent=error=>finish(error);const aborted=()=>finish(new ServiceError(400,'REQUEST_ABORTED','Request was aborted.'));
    const timer=setTimeout(()=>finish(new ServiceError(408,'BODY_TIMEOUT','Request body timed out.')),timeoutMs);timer.unref();
    request.on('data',data);request.once('end',end);request.once('error',errorEvent);request.once('aborted',aborted);
  });
}
async function readJSON(request){
  if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))fail(415,'JSON_REQUIRED','Use Content-Type: application/json.');
  try{return JSON.parse((await readBody(request,16*1024)).toString('utf8'));}catch(error){if(error instanceof ServiceError)throw error;fail(400,'INVALID_JSON','Invalid JSON body.');}
}

export function discordPacket(opcode,payload){const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));const result=Buffer.allocUnsafe(8+body.length);result.writeUInt32LE(opcode,0);result.writeUInt32LE(body.length,4);body.copy(result,8);return result;}
async function socketCandidates(env){
  if(env.NBS_DISCORD_IPC)return [env.NBS_DISCORD_IPC];
  if(process.platform==='win32')return Array.from({length:10},(_,i)=>`\\\\?\\pipe\\discord-ipc-${i}`);
  const prefixes=[...new Set([env.XDG_RUNTIME_DIR,env.TMPDIR,env.TMP,env.TEMP,'/tmp'].filter(Boolean))],result=[];
  for(const prefix of prefixes)for(let i=0;i<10;i++){const candidate=path.join(prefix,`discord-ipc-${i}`);try{const info=await lstat(candidate);if(info.isSocket()&&(typeof process.getuid!=='function'||info.uid===process.getuid()))result.push(candidate);}catch{}}
  return result;
}

/** IPC framing follows Discord's official hard-mode and RPC documentation. */
export class DiscordPresence{
  constructor({env=process.env,paths,timeoutMs=3000}={}){this.env=env;this.paths=paths;this.timeoutMs=timeoutMs;this.enabled=false;this.session=null;this.lastError=null;this.queue=Promise.resolve();this.started=Math.floor(Date.now()/1000);}
  status(){return {enabled:this.enabled,connected:Boolean(this.session?.ready&&!this.session.socket.destroyed),applicationId:APP_ID,transport:'local-ipc',lastError:this.lastError};}
  async connect(){
    if(this.session?.ready&&!this.session.socket.destroyed)return this.session;
    for(const endpoint of this.paths||await socketCandidates(this.env)){
      const socket=createConnection(endpoint),session={socket,ready:false,pending:new Map(),buffer:Buffer.alloc(0)};
      try{
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Discord IPC handshake timed out.')),this.timeoutMs);timer.unref();
          const disconnected=error=>{clearTimeout(timer);reject(error||new Error('Discord IPC disconnected.'));for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.reject(error||new Error('Discord IPC disconnected.'));}session.pending.clear();if(this.session===session){session.ready=false;this.lastError=error?.message||'Discord IPC disconnected.';}};
          socket.on('error',disconnected);socket.on('close',()=>disconnected());
          socket.once('connect',()=>socket.write(discordPacket(0,{v:1,client_id:APP_ID})));
          socket.on('data',chunk=>{
            try{
              if(session.buffer.length+chunk.length>1024*1024+8)throw new Error('Discord IPC frame exceeds the local limit.');
              session.buffer=Buffer.concat([session.buffer,chunk]);
              while(session.buffer.length>=8){
                const opcode=session.buffer.readUInt32LE(0),length=session.buffer.readUInt32LE(4);
                if(length>1024*1024)throw new Error('Discord IPC frame is too large.');
                if(session.buffer.length<8+length)break;
                const body=session.buffer.subarray(8,8+length);session.buffer=session.buffer.subarray(8+length);
                if(opcode===3){socket.write(discordPacket(4,body));continue;}
                if(opcode===2)throw new Error('Discord closed the IPC session.');
                if(opcode!==1)continue;
                const payload=JSON.parse(body.toString('utf8'));
                if(payload.evt==='READY'){clearTimeout(timer);session.ready=true;resolve();}
                if(payload.nonce&&session.pending.has(payload.nonce)){const pending=session.pending.get(payload.nonce);session.pending.delete(payload.nonce);clearTimeout(pending.timer);if(payload.evt==='ERROR')pending.reject(new Error(payload.data?.message||'Discord rejected the activity.'));else pending.resolve(payload);}
              }
            }catch(error){disconnected(error);socket.destroy();}
          });
        });
        this.session=session;this.lastError=null;return session;
      }catch(error){socket.destroy();this.lastError=error.message;}
    }
    throw new ServiceError(503,'DISCORD_UNAVAILABLE',this.lastError||'Discord IPC was not found. Open the Discord desktop client, then enable presence again.');
  }
  async command(activity){
    const session=await this.connect(),nonce=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{session.pending.delete(nonce);reject(new Error('Discord activity acknowledgement timed out.'));},this.timeoutMs);timer.unref();
      session.pending.set(nonce,{resolve,reject,timer});
      session.socket.write(discordPacket(1,{cmd:'SET_ACTIVITY',args:{pid:process.pid,activity},nonce}));
    });
  }
  update({enabled,details='',state=''}){
    const task=async()=>{
      if(!enabled){this.enabled=false;if(this.session?.ready){try{await this.command(null);}catch{}this.session.socket.destroy();this.session=null;}this.lastError=null;return this.status();}
      this.enabled=true;
      const clean=value=>Array.from(String(value)).slice(0,128).join('').replace(/[\x00-\x1f\x7f]/g,' ');
      try{await this.command({details:clean(details),state:clean(state),timestamps:{start:this.started}});this.lastError=null;return this.status();}catch(error){this.lastError=error.message;throw error;}
    };
    this.queue=this.queue.catch(()=>{}).then(task);return this.queue;
  }
  async close(){await this.update({enabled:false});}
}

async function probeCommand(command){
  return new Promise(resolve=>{
    let output='',settled=false;
    let child;try{child=spawn(command,['-version'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{return resolve(null);}
    const done=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child.kill();done(null);},3000);timer.unref();
    const data=chunk=>{if(output.length<65536)output+=chunk.toString('utf8').slice(0,65536-output.length);};
    child.stdout.on('data',data);child.stderr.on('data',data);child.once('error',()=>done(null));child.once('close',code=>done(code===0&&/^ffmpeg version /m.test(output)?{available:true,path:command,version:output.split(/\r?\n/)[0]}:null));
  });
}
async function findFFmpeg(root,env){
  const executable=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
  const candidates=[env.NBS_FFMPEG,path.join(root,'runtime',`${process.platform}-${process.arch}`,executable),'ffmpeg'].filter(Boolean);
  for(const command of [...new Set(candidates)]){const result=await probeCommand(command);if(result)return result;}
  return {available:false,version:null};
}

function remoteURL(input){
  let result;try{result=new URL(String(input));}catch{fail(400,'INVALID_URL','A valid HTTP(S) URL is required.');}
  if(!['http:','https:'].includes(result.protocol)||result.username||result.password)fail(400,'INVALID_URL','Only HTTP(S) URLs without credentials are allowed.');
  return result;
}
async function fetchSong(input){
  let url=remoteURL(input);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);timer.unref();
  try{
    for(let redirects=0;redirects<=5;redirects++){
      const response=await fetch(url,{redirect:'manual',signal:controller.signal,headers:{'Accept':'application/octet-stream,audio/midi,application/json,*/*;q=0.1'}});
      if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();if(redirects===5)fail(502,'REDIRECT_LIMIT','Remote song exceeded five redirects.');const location=response.headers.get('location');if(!location)fail(502,'INVALID_REDIRECT','Remote redirect has no Location.');url=remoteURL(new URL(location,url).href);continue;}
      if(!response.ok){await response.body?.cancel();fail(502,'REMOTE_HTTP_ERROR',`Remote server returned HTTP ${response.status}.`);}
      if(Number(response.headers.get('content-length'))>MAX_SONG){await response.body?.cancel();fail(413,'SONG_TOO_LARGE','Remote song exceeds 128 MiB.');}
      const chunks=[];let length=0;
      if(!response.body)fail(502,'EMPTY_SONG','Remote song has no body.');
      for await(const chunk of response.body){length+=chunk.length;if(length>MAX_SONG){controller.abort();fail(413,'SONG_TOO_LARGE','Remote song exceeds 128 MiB.');}chunks.push(Buffer.from(chunk));}
      const disposition=response.headers.get('content-disposition')||'';
      let name=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]||disposition.match(/filename="([^"]+)"/i)?.[1]||path.posix.basename(url.pathname)||'song.nbs';
      try{name=decodeURIComponent(name);}catch{}
      return {data:Buffer.concat(chunks,length),name:safeName(name),mime:response.headers.get('content-type')||'application/octet-stream'};
    }
  }catch(error){if(controller.signal.aborted&&!(error instanceof ServiceError))fail(504,'FETCH_TIMEOUT','Remote song download timed out.');if(error instanceof ServiceError)throw error;fail(502,'FETCH_FAILED','Remote song could not be downloaded.');}
  finally{clearTimeout(timer);}
}

/** Returned handler is inactive until explicitly mounted by the loopback CLI. */
export async function createNativeServices({launchFile,launchURL,projectRoot,env=process.env,discordPaths,ffmpegTimeoutMs=120000}={}){
  const token=randomBytes(32).toString('hex'),ffmpeg=await findFFmpeg(projectRoot||process.cwd(),env);
  const presence=new DiscordPresence({env,paths:discordPaths});let busy=false,fetching=false,closed=false,child=null,launch=null,grantedFile=null;
  if(launchFile){grantedFile=await realpath(path.resolve(launchFile));const info=await stat(grantedFile);if(!info.isFile()||info.size>MAX_SONG||!['.nbs','.nbp','.nbpz','.zip','.mid','.midi','.json'].includes(path.extname(grantedFile).toLowerCase()))throw new Error('Launch file must be an NBS song, NBP pattern, NBPZ/ZIP project, MIDI or JSON file no larger than 128 MiB.');launch={kind:'file',name:path.basename(grantedFile)};}
  else if(launchURL){let url=String(launchURL);if(/^nbs:\/\//i.test(url)){url=url.slice(6).replace(/^https\/\//i,'https://').replace(/^http\/\//i,'http://');if(!/^https?:\/\//i.test(url)){try{url=decodeURIComponent(url);}catch{}}}launch={kind:'url',url:remoteURL(url).href};}
  const headers=(response,mime,name,length)=>response.writeHead(200,{'Content-Type':mime,'Content-Length':length,'Content-Disposition':`attachment; filename="${encodeURIComponent(name)}"`,'X-NBS-Filename':encodeURIComponent(name),'Cache-Control':'no-store'});
  async function transcode(request,response,url){
    if(busy)fail(409,'TRANSCODE_BUSY','Another audio export is already running.');
    const format=url.searchParams.get('format')||'mp3',rate=Number(url.searchParams.get('rate')||48000),channels=Number(url.searchParams.get('channels')||2),bitrate=Number(url.searchParams.get('bitrate')||320);
    if(!Object.hasOwn(FORMAT,format)||![8000,11025,16000,22050,24000,32000,44100,48000,88200,96000,176400,192000,352800,384000].includes(rate)||![1,2].includes(channels)||!Number.isInteger(bitrate)||bitrate<32||bitrate>320)fail(400,'INVALID_CODEC_OPTIONS','Invalid audio format, sample rate, channels or bitrate.');
    for(const key of url.searchParams.keys())if(!['format','rate','channels','bitrate'].includes(key))fail(400,'INVALID_CODEC_OPTIONS',`Unknown codec option: ${key}`);
    if(!ffmpeg.available)fail(503,'FFMPEG_UNAVAILABLE','FFmpeg is not available. Set NBS_FFMPEG or provide the local runtime executable.');
    busy=true;let folder;
    try{
      let body=await readBody(request,MAX_WAV);
      if(body.length<44||body.toString('ascii',0,4)!=='RIFF'||body.toString('ascii',8,12)!=='WAVE')fail(415,'WAV_REQUIRED','The codec endpoint accepts a RIFF/WAVE body only.');
      folder=await mkdtemp(path.join(os.tmpdir(),'nbs-codec-'));const input=path.join(folder,'input.wav'),output=path.join(folder,`audio.${format}`);
      await writeFile(input,body);body=null;
      const args=['-hide_banner','-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-f','wav','-i',input,'-map','0:a:0','-vn','-ar',String(rate),'-ac',String(channels),...FORMAT[format].codec];
      if(format==='mp3')args.push('-b:a',`${bitrate}k`);
      args.push('-threads','1','-fs',String(MAX_WAV+1),'-f',format,output);
      await new Promise((resolve,reject)=>{
        child=spawn(ffmpeg.path,args,{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='',ended=false,stopped=null;
        const finish=error=>{if(ended)return;ended=true;clearTimeout(timer);response.off('close',cancel);child=null;error?reject(error):resolve();};
        const stop=error=>{if(stopped)return;stopped=error;child?.kill();};
        const cancel=()=>{if(!response.writableEnded)stop(new ServiceError(499,'CANCELLED','Audio export was cancelled.'));};
        const timer=setTimeout(()=>stop(new ServiceError(504,'CODEC_TIMEOUT','FFmpeg exceeded its time budget.')),Math.min(Math.max(1,ffmpegTimeoutMs),120000));timer.unref();
        response.once('close',cancel);child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk.toString('utf8').slice(0,65536-stderr.length);});
        child.once('error',error=>finish(new ServiceError(502,'CODEC_START_FAILED',error.message)));child.once('close',code=>finish(stopped||(code===0?null:new ServiceError(502,'CODEC_FAILED',stderr.trim().slice(0,2048)||`FFmpeg exited with code ${code}.`))));
      });
      const info=await stat(output);if(info.size>MAX_WAV)fail(413,'OUTPUT_TOO_LARGE','Encoded audio exceeds 512 MiB.');if(!info.size)fail(502,'EMPTY_AUDIO','FFmpeg produced no audio.');
      const data=await readFile(output);headers(response,FORMAT[format].mime,`NoteBlockStudio.${format}`,data.length);response.end(data);
    }finally{busy=false;if(folder&&path.dirname(folder)===path.resolve(os.tmpdir())&&path.basename(folder).startsWith('nbs-codec-'))await rm(folder,{recursive:true,force:true});}
  }
  async function handle(request,response){
    const url=new URL(request.url,'http://localhost');if(!url.pathname.startsWith('/api/'))return false;
    try{
      if(closed)fail(503,'SERVICE_CLOSED','Local services are stopped.');
      const origin=`http://${request.headers.host}`;
      if(request.headers.origin&&request.headers.origin!==origin)fail(403,'ORIGIN_DENIED','Cross-origin local service requests are denied.');
      if(request.method!=='GET'&&(request.headers.origin!==origin||!secretEqual(request.headers['x-nbs-token'],token)))fail(403,'TOKEN_REQUIRED','An exact same-origin request and X-NBS-Token are required.');
      if(url.pathname==='/api/capabilities'&&request.method==='GET'){json(response,200,{version:1,token,ffmpeg,launch,discord:presence.status()});return true;}
      if(url.pathname==='/api/launch-file'&&request.method==='GET'){
        if(!grantedFile)fail(404,'NO_LAUNCH_FILE','No file was explicitly granted at launch.');
        if([...url.searchParams].length)fail(400,'PATH_NOT_ALLOWED','The launch-file endpoint does not accept a file path.');
        const info=await stat(grantedFile);if(!info.isFile()||info.size>MAX_SONG)fail(413,'LAUNCH_FILE_TOO_LARGE','Granted launch file is no longer a supported size.');
        const data=await readFile(grantedFile);headers(response,'application/octet-stream',launch.name,data.length);response.end(data);return true;
      }
      if(url.pathname==='/api/transcode'&&request.method==='POST'){await transcode(request,response,url);return true;}
      if(url.pathname==='/api/presence'&&request.method==='POST'){
        const data=await readJSON(request);if(!data||typeof data.enabled!=='boolean')fail(400,'INVALID_PRESENCE','enabled must be a boolean.');json(response,200,await presence.update(data));return true;
      }
      if(url.pathname==='/api/fetch-song'&&request.method==='POST'){
        if(fetching)fail(409,'FETCH_BUSY','Another song download is already running.');fetching=true;
        try{const data=await readJSON(request);const song=await fetchSong(data?.url);headers(response,song.mime,song.name,song.data.length);response.end(song.data);}finally{fetching=false;}return true;
      }
      fail(404,'UNKNOWN_API','Unknown local API route or method.');
    }catch(error){if(!response.headersSent&&!response.destroyed)json(response,error.status||500,{error:error.message||'Local service failed.',code:error.code||'SERVICE_ERROR'});else if(!response.writableEnded)response.destroy();return true;}
  }
  return {handle,async close(){if(closed)return;closed=true;child?.kill();await presence.close();}};
}
