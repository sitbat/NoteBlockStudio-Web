#!/usr/bin/env node
/** Restore pinned optional runtimes without npm packages or system installation. */
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {inflateRaw} from 'node:zlib';
import {promisify} from 'node:util';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MiB=1024*1024;
export const RUNTIMES=Object.freeze({
  'ffmpeg-win32-x64':{
    id:'ffmpeg-win32-x64',version:'9.0.2',platform:'win32',arch:'x64',format:'zip',
    url:'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip',
    archiveBytes:114768076,archiveSha256:'60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
    executable:'runtime/win32-x64/ffmpeg.exe',executableSha256:'3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec',
    members:[
      {source:'ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe',target:'runtime/win32-x64/ffmpeg.exe',maxBytes:105423872,executable:true},
      {source:'ffmpeg-9.0.2-essentials_build/LICENSE',target:'runtime/win32-x64/LICENSE',maxBytes:MiB},
      {source:'ffmpeg-9.0.2-essentials_build/README.txt',target:'runtime/win32-x64/README.txt',maxBytes:MiB}
    ]
  },
  'node-linux-x64':{
    id:'node-linux-x64',version:'24.11.0',platform:'linux',arch:'x64',format:'tar.xz',
    url:'https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz',
    archiveBytes:32077964,archiveSha256:'46da9a098973ab7ba4fca76945581ecb2eaf468de347173897044382f10e0a0a',
    executable:'runtime/linux-x64/bin/node',executableSha256:'d918479037f14dc30c8d21df3767a010fe710685373baec7edf680ca8c3edbee',
    members:[
      {source:'node-v24.11.0-linux-x64/bin/node',target:'runtime/linux-x64/bin/node',maxBytes:129491488,executable:true},
      {source:'node-v24.11.0-linux-x64/LICENSE',target:'runtime/linux-x64/LICENSE',maxBytes:MiB},
      {source:'node-v24.11.0-linux-x64/README.md',target:'runtime/linux-x64/README.md',maxBytes:MiB}
    ]
  }
});

export const HELP=`Usage: node scripts/setup-runtime.mjs [options]

  --runtime ID       ffmpeg-win32-x64 or node-linux-x64; repeat to select both
  --all              Restore both known runtimes
  --archive PATH     Use an existing archive; exactly one runtime must be selected
  --connections N    HTTP Range connections, 1..16 (default16)
  --timeout SECONDS  Overall download timeout, 10..3600 (default600)
  --force            Replace a different executable, retaining a local backup
  --list             Show pinned versions, URLs and SHA256 without downloading
  --help, -h         Show this help without downloading

Default: Windowsx64 -> FFmpeg9.0.2; Linuxx64 -> portable Node24.11.0.
Other platforms need an explicit supported --runtime or their own system runtime.
Node18+ is required. ZIP uses Node's standard library; tar.xz also needs system tar.
No downloaded program is executed, and no OS package/PATH setting changes.
Existing matching runtimes are reused. All archives and executables must match
the pinned SHA256 values. Temporary files and backups stay under this project.
`;

export function parseArgs(args,{platform=process.platform,arch=process.arch}={}){
  const options={ids:[],all:false,archive:null,connections:16,timeout:600,force:false,list:false,help:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i],value=()=>{if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value for ${arg}.`);return args[++i];};
    if(arg==='--help'||arg==='-h')options.help=true;
    else if(arg==='--list')options.list=true;
    else if(arg==='--all')options.all=true;
    else if(arg==='--force')options.force=true;
    else if(arg==='--runtime')options.ids.push(value());
    else if(arg==='--archive')options.archive=path.resolve(value());
    else if(arg==='--connections')options.connections=Number(value());
    else if(arg==='--timeout')options.timeout=Number(value());
    else throw new Error(`Unknown argument: ${arg}. Use --help.`);
  }
  if(!Number.isInteger(options.connections)||options.connections<1||options.connections>16)throw new Error('--connections must be an integer from1 to16.');
  if(!Number.isInteger(options.timeout)||options.timeout<10||options.timeout>3600)throw new Error('--timeout must be an integer from10 to3600 seconds.');
  if(options.all&&options.ids.length)throw new Error('Choose --all or --runtime, not both.');
  if(options.all)options.ids=Object.keys(RUNTIMES);
  for(const id of options.ids)if(!Object.hasOwn(RUNTIMES,id))throw new Error(`Unknown runtime: ${id}. Use --list.`);
  options.ids=[...new Set(options.ids)];
  if(!options.ids.length&&!options.help&&!options.list){const id=platform==='win32'&&arch==='x64'?'ffmpeg-win32-x64':platform==='linux'&&arch==='x64'?'node-linux-x64':null;if(!id)throw new Error(`No default runtime for ${platform}-${arch}. Use --list or provide a system runtime.`);options.ids=[id];}
  if(options.archive&&options.ids.length!==1)throw new Error('--archive requires exactly one selected runtime.');
  return options;
}

export async function sha256File(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function verifyArchive(file,spec){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==spec.archiveBytes)throw new Error(`Archive size/type mismatch for ${spec.id}.`);const hash=await sha256File(file);if(hash!==spec.archiveSha256)throw new Error(`Archive SHA256 mismatch for ${spec.id}: ${hash}. Nothing was extracted.`);return hash;}
const inside=(root,file)=>{const rel=path.relative(root,file);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
function relativePath(value){if(typeof value!=='string'||!value||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||/^[a-z]:/i.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe runtime member path.');return value;}
async function safePath(root,relative,{directory=false,create=false}={}){
  const parts=relativePath(relative).split('/');let current=root;
  for(let i=0;i<parts.length;i++){
    current=path.join(current,parts[i]);const shouldBeDirectory=i<parts.length-1||directory;
    try{const info=await lstat(current);if(info.isSymbolicLink()||shouldBeDirectory&&!info.isDirectory()||!shouldBeDirectory&&!info.isFile())throw new Error(`Refusing non-regular runtime path: ${current}`);}
    catch(error){if(error.code!=='ENOENT')throw error;if(create&&shouldBeDirectory)await mkdir(current);}
  }
  if(!inside(root,current))throw new Error('Runtime path escaped project.');return current;
}
function validateSpec(spec){
  if(!spec||!/^[a-z0-9-]+$/.test(spec.id)||!Number.isSafeInteger(spec.archiveBytes)||spec.archiveBytes<=0||spec.archiveBytes>256*MiB||!['zip','tar.xz'].includes(spec.format))throw new Error('Invalid runtime specification.');
  for(const hash of [spec.archiveSha256,spec.executableSha256])if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid pinned SHA256.');
  relativePath(spec.executable);if(!spec.executable.startsWith('runtime/'))throw new Error('Runtime destination must stay under runtime/.');
  if(!spec.members?.length||!spec.members.some(member=>member.target===spec.executable))throw new Error('Runtime executable member is missing.');
  for(const member of spec.members){relativePath(member.source);relativePath(member.target);if(!member.target.startsWith('runtime/')||!Number.isSafeInteger(member.maxBytes)||member.maxBytes<=0||member.maxBytes>256*MiB)throw new Error('Invalid runtime member.');}
}

async function fetchFollowing(url,{fetchImpl,signal,headers,allowHTTP}){
  for(let i=0;i<=5;i++){
    const parsed=new URL(url);if(parsed.username||parsed.password||parsed.protocol!=='https:'&&!(allowHTTP&&parsed.protocol==='http:'))throw new Error('Runtime download requires HTTPS without credentials.');
    const response=await fetchImpl(parsed,{signal,headers,redirect:'manual'});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();const location=response.headers.get('location');if(i===5||!location)throw new Error('Runtime redirect limit or invalid Location.');url=new URL(location,parsed).href;continue;}
    return response;
  }
}
async function responseFile(response,file,expected,{signal,onBytes}){
  if(!response.body)throw new Error('Runtime response has no body.');
  if(response.headers.has('content-length')&&Number(response.headers.get('content-length'))!==expected){await response.body.cancel();throw new Error('Runtime Content-Length mismatch.');}
  let bytes=0;
  await pipeline(Readable.fromWeb(response.body),async function*(source){for await(const chunk of source){bytes+=chunk.length;if(bytes>expected)throw new Error('Runtime response exceeded its fixed size.');onBytes?.(chunk.length);yield chunk;}},createWriteStream(file,{flags:'wx',mode:0o600}),{signal});
  if(bytes!==expected)throw new Error('Runtime response ended before its fixed size.');
}

/** allowHTTP is a test-only injection, never a CLI option. */
export async function downloadVerified(spec,destination,{connections=16,timeoutMs=600000,fetchImpl=globalThis.fetch,signal,onProgress,allowHTTP=false}={}){
  validateSpec(spec);if(!Number.isInteger(connections)||connections<1||connections>16)throw new Error('Invalid connection count.');
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(new Error('Runtime download timed out.')),timeoutMs);timer.unref();
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const temp=await mkdtemp(path.join(path.dirname(destination),'.runtime-parts-'));let downloaded=0;
  const request=(headers={})=>fetchFollowing(spec.url,{fetchImpl,signal:controller.signal,allowHTTP,headers:{'Accept-Encoding':'identity',...headers}});
  const opts={signal:controller.signal,onBytes:bytes=>{downloaded+=bytes;onProgress?.(downloaded,spec.archiveBytes);}};
  try{
    if(connections===1||spec.archiveBytes<=65536){const response=await request();if(response.status!==200){await response.body?.cancel();throw new Error(`Runtime HTTP${response.status}.`);}await responseFile(response,destination,spec.archiveBytes,opts);}
    else{
      const end=65535,probe=await request({Range:`bytes=0-${end}`});
      if(probe.status===200)await responseFile(probe,destination,spec.archiveBytes,opts);
      else{
        if(probe.status!==206||probe.headers.get('content-range')!==`bytes 0-${end}/${spec.archiveBytes}`){await probe.body?.cancel();throw new Error('Invalid runtime HTTP Range response.');}
        const prefix=path.join(temp,'prefix');await responseFile(probe,prefix,65536,opts);
        const remaining=spec.archiveBytes-65536,chunk=Math.ceil(remaining/connections),parts=[];
        const jobs=Array.from({length:connections},async(_,i)=>{
          const start=65536+i*chunk,last=Math.min(spec.archiveBytes-1,start+chunk-1);if(start>last)return;
          const file=path.join(temp,String(i));parts[i]=file;const response=await request({Range:`bytes=${start}-${last}`});
          if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${last}/${spec.archiveBytes}`){await response.body?.cancel();throw new Error('Invalid runtime range chunk.');}
          await responseFile(response,file,last-start+1,opts);
        });
        try{await Promise.all(jobs);}catch(error){controller.abort(error);await Promise.allSettled(jobs);throw error;}
        await pipeline(Readable.from((async function*(){for(const file of [prefix,...parts.filter(Boolean)])for await(const bytes of createReadStream(file))yield bytes;})()),createWriteStream(destination,{flags:'wx',mode:0o600}),{signal:controller.signal});
      }
    }
    await verifyArchive(destination,spec);return destination;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();await rm(temp,{recursive:true,force:true});}
}

function run(command,args,{env=process.env,signal}={}){
  return new Promise((resolve,reject)=>{
    let child;try{child=spawn(command,args,{env,signal,windowsHide:true,shell:false,stdio:['ignore','ignore','pipe']});}catch(error){reject(error);return;}
    let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<16000)stderr+=chunk.toString('utf8').slice(0,16000-stderr.length);});
    const timer=setTimeout(()=>child.kill(),120000);timer.unref();child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`${command} extraction failed: ${stderr.trim()||code}`));});
  });
}
const inflate=promisify(inflateRaw);
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;}
/** Only ZIP32 stored/deflated regular files are needed by the pinned Gyan build. */
async function extractZipSelected(archive,destination,spec,{signal}={}){
  const bytes=await readFile(archive);let eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){eocd=i;break;}
  if(eocd<0)throw new Error('ZIP central directory was not found.');
  const count=bytes.readUInt16LE(eocd+10),centralSize=bytes.readUInt32LE(eocd+12),centralStart=bytes.readUInt32LE(eocd+16);
  if(bytes.readUInt16LE(eocd+4)||bytes.readUInt16LE(eocd+6)||bytes.readUInt16LE(eocd+8)!==count||count===65535||centralStart===0xffffffff||centralSize===0xffffffff||centralStart+centralSize!==eocd)throw new Error('Unsupported split/ZIP64 or invalid ZIP directory.');
  const selected=new Map(spec.members.map(member=>[member.source,{member,entry:null}]));let cursor=centralStart;
  for(let i=0;i<count;i++){
    if(cursor+46>eocd||bytes.readUInt32LE(cursor)!==0x02014b50)throw new Error('Invalid ZIP central entry.');
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),next=cursor+46+nameLength+extraLength+commentLength;
    if(next>eocd)throw new Error('ZIP central entry exceeds its directory.');
    const flags=bytes.readUInt16LE(cursor+8),name=bytes.toString(flags&0x800?'utf8':'latin1',cursor+46,cursor+46+nameLength),wanted=selected.get(name);
    if(wanted){
      if(wanted.entry)throw new Error('Duplicate selected ZIP member.');
      const entry={flags,method:bytes.readUInt16LE(cursor+10),crc:bytes.readUInt32LE(cursor+16),compressed:bytes.readUInt32LE(cursor+20),length:bytes.readUInt32LE(cursor+24),attributes:bytes.readUInt32LE(cursor+38),offset:bytes.readUInt32LE(cursor+42)};
      const kind=(entry.attributes>>>16)&0xf000;
      if(bytes.readUInt16LE(cursor+34)||entry.flags&1||![0,8].includes(entry.method)||entry.compressed===0xffffffff||entry.offset===0xffffffff||entry.length<=0||entry.length>wanted.member.maxBytes||kind&&kind!==0x8000||entry.attributes&16)throw new Error('Unsupported or unsafe selected ZIP member.');
      wanted.entry=entry;
    }
    cursor=next;
  }
  if(cursor!==centralStart+centralSize)throw new Error('ZIP central directory size mismatch.');
  for(const {member,entry} of selected.values()){
    if(signal?.aborted)throw signal.reason||new Error('Runtime setup cancelled.');
    if(!entry)throw new Error('Missing selected ZIP member.');
    const offset=entry.offset;if(offset+30>centralStart||bytes.readUInt32LE(offset)!==0x04034b50)throw new Error('Invalid ZIP local header.');
    const nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28),start=offset+30+nameLength+extraLength;
    if(start+entry.compressed>centralStart||bytes.readUInt16LE(offset+6)!==entry.flags||bytes.readUInt16LE(offset+8)!==entry.method||bytes.toString(entry.flags&0x800?'utf8':'latin1',offset+30,offset+30+nameLength)!==member.source)throw new Error('ZIP local header does not match its directory.');
    const compressed=bytes.subarray(start,start+entry.compressed),output=entry.method===0?compressed:await inflate(compressed,{maxOutputLength:member.maxBytes});
    if(output.length!==entry.length||crc32(output)!==entry.crc)throw new Error('ZIP member size/CRC mismatch.');
    await safePath(destination,path.posix.dirname(member.source),{directory:true,create:true});
    const target=await safePath(destination,member.source);await writeFile(target,output,{flag:'wx',mode:0o600});
  }
}
async function extractSelected(archive,destination,spec,{signal,runImpl=run}={}){
  if(spec.format==='zip')return extractZipSelected(archive,destination,spec,{signal});
  await runImpl('tar',['-xf',archive,'-C',destination,...spec.members.map(member=>member.source)],{signal});
}

export async function setupRuntime(spec,{root=projectRoot,force=false,archive,connections=16,timeoutMs=600000,signal,onProgress,fetchImpl,allowHTTP=false,runImpl}={}){
  validateSpec(spec);root=await realpath(root);await safePath(root,'runtime',{directory:true,create:true});
  const executable=await safePath(root,spec.executable);let exists=false,matching=false;
  try{await stat(executable);exists=true;matching=await sha256File(executable)===spec.executableSha256;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists&&!matching&&!force)throw new Error(`Existing ${spec.executable} has a different SHA256. Preserve it or use --force to keep a backup and replace it.`);
  if(matching&&!force){let complete=true;for(const member of spec.members){const file=await safePath(root,member.target);try{await stat(file);}catch(error){if(error.code==='ENOENT')complete=false;else throw error;}}if(complete){if(process.platform!=='win32')await chmod(executable,0o755);return {id:spec.id,status:'already-present',path:executable};}}
  const stage=await mkdtemp(path.join(root,'runtime','.setup-')),download=path.join(stage,'archive'),extracted=path.join(stage,'extract');await mkdir(extracted);
  let backup=null;const installed=[];
  try{
    if(archive){archive=await realpath(archive);await verifyArchive(archive,spec);}else archive=await downloadVerified(spec,download,{connections,timeoutMs,signal,onProgress,fetchImpl,allowHTTP});
    // The system extractor sees only an archive that passed the pinned hash.
    await extractSelected(archive,extracted,spec,{signal,runImpl});
    const files=[];
    for(const member of spec.members){const source=await safePath(extracted,member.source),info=await lstat(source);if(!info.isFile()||info.size<=0||info.size>member.maxBytes)throw new Error('Extracted runtime member has invalid type/size.');const hash=await sha256File(source);if(member.target===spec.executable&&hash!==spec.executableSha256)throw new Error('Extracted executable SHA256 mismatch. Nothing was installed.');const target=await safePath(root,member.target);files.push({member,source,target,hash});}
    // Validate all destination paths before changing any component.
    for(const file of files){await safePath(root,path.posix.dirname(file.member.target),{directory:true,create:true});try{file.previousHash=await sha256File(file.target);}catch(error){if(error.code!=='ENOENT')throw error;}}
    for(const file of files){
      if(file.previousHash===file.hash){if(file.member.executable&&process.platform!=='win32')await chmod(file.target,0o755);continue;}
      if(file.previousHash){if(!backup){const relative=`runtime/.runtime-backups/${spec.id}-${Date.now()}-${randomUUID()}`;backup=await safePath(root,relative,{directory:true,create:true});}file.saved=path.join(backup,...file.member.target.split('/').slice(1));await mkdir(path.dirname(file.saved),{recursive:true});await copyFile(file.target,file.saved);}
      const temporary=file.target+'.setup-'+randomUUID();
      try{await copyFile(file.source,temporary);if(process.platform!=='win32')await chmod(temporary,file.member.executable?0o755:0o644);await rename(temporary,file.target);installed.push(file);}
      finally{await rm(temporary,{force:true});}
    }
    return {id:spec.id,status:'installed',path:executable,backup};
  }catch(error){
    for(const file of installed.reverse()){if(file.saved)await copyFile(file.saved,file.target);else await rm(file.target,{force:true});}
    throw error;
  }finally{if(path.dirname(stage)===path.join(root,'runtime')&&path.basename(stage).startsWith('.setup-'))await rm(stage,{recursive:true,force:true});}
}

export async function main(args=process.argv.slice(2)){
  const options=parseArgs(args);
  if(options.help){console.log(HELP);return;}
  if(options.list){for(const spec of Object.values(RUNTIMES))console.log(`${spec.id} v${spec.version}\n  ${spec.url}\n  archive SHA256 ${spec.archiveSha256}\n  executable SHA256 ${spec.executableSha256}`);return;}
  const controller=new AbortController(),interrupt=()=>controller.abort(new Error('Runtime setup cancelled.'));process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);let lastProgress=0;
  try{for(const id of options.ids){console.log(`Checking ${id}...`);const result=await setupRuntime(RUNTIMES[id],{force:options.force,archive:options.archive,connections:options.connections,timeoutMs:options.timeout*1000,signal:controller.signal,onProgress:(done,total)=>{if(Date.now()-lastProgress>2000||done===total){lastProgress=Date.now();console.log(`Downloaded ${(done/MiB).toFixed(1)}/${(total/MiB).toFixed(1)} MiB`);}}});console.log(`${result.status}: ${result.path}`);if(result.backup)console.log(`Previous files retained in ${result.backup}`);}}
  finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(`Runtime setup failed: ${error.message}`);process.exitCode=1;});
}
