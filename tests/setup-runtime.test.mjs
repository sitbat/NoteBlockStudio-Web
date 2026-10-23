import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RUNTIMES,parseArgs,verifyArchive,downloadVerified,setupRuntime,sha256File} from '../scripts/setup-runtime.mjs';
import {deflateRawSync} from 'node:zlib';

const script=fileURLToPath(new URL('../scripts/setup-runtime.mjs',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function temp(t){const folder=await mkdtemp(path.join(os.tmpdir(),'nbs-runtime-test-'));t.after(()=>rm(folder,{recursive:true,force:true}));return folder;}
function specFor(bytes,overrides={}){return {id:'test-runtime',version:'1',format:'tar.xz',url:'https://official.invalid/test.zip',archiveBytes:bytes.length,archiveSha256:digest(bytes),executable:'runtime/test/bin/tool',executableSha256:digest(Buffer.from('test executable')),members:[{source:'pkg/bin/tool',target:'runtime/test/bin/tool',maxBytes:100000,executable:true},{source:'pkg/LICENSE',target:'runtime/test/LICENSE',maxBytes:10000}],...overrides};}
async function server(t,handler){const server=http.createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));return `http://127.0.0.1:${server.address().port}`;}

test('runtime CLI defaults, explicit selection, offline help/list and validation',()=>{
  assert.deepEqual(parseArgs([],{platform:'win32',arch:'x64'}).ids,['ffmpeg-win32-x64']);assert.deepEqual(parseArgs([],{platform:'linux',arch:'x64'}).ids,['node-linux-x64']);
  assert.equal(parseArgs(['--all'],{platform:'darwin',arch:'arm64'}).ids.length,2);
  assert.equal(parseArgs(['--runtime','node-linux-x64','--connections','3','--timeout','60','--force']).force,true);
  assert.equal(parseArgs(['--help'],{platform:'darwin',arch:'arm64'}).help,true);
  for(const args of [['--runtime','unknown'],['--all','--runtime','node-linux-x64'],['--all','--archive','x'],['--connections','0'],['--connections','17'],['--timeout','3'],['--runtime'],['--url','http://evil.invalid'],['--target','elsewhere']])assert.throws(()=>parseArgs(args));
  assert.throws(()=>parseArgs([],{platform:'darwin',arch:'arm64'}),/No default/);
  for(const flag of ['--help','--list']){const child=spawnSync(process.execPath,[script,flag],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,flag==='--help'?/Usage:/:/SHA256/);}
  for(const runtime of Object.values(RUNTIMES)){assert.match(runtime.url,/^https:\/\//);assert.match(runtime.archiveSha256,/^[a-f0-9]{64}$/);assert.match(runtime.executableSha256,/^[a-f0-9]{64}$/);}
});

test('archive verification rejects size and SHA mismatches before extraction',async t=>{
  const folder=await temp(t),bytes=Buffer.from('trusted archive'),spec=specFor(bytes),archive=path.join(folder,'archive');await writeFile(archive,bytes);assert.equal(await verifyArchive(archive,spec),digest(bytes));
  await writeFile(archive,Buffer.from('changed archive'));await assert.rejects(verifyArchive(archive,spec),/SHA256 mismatch/);
  await writeFile(archive,'short');await assert.rejects(verifyArchive(archive,spec),/size/);
});

test('controlled HTTP download verifies bytes and follows redirects without external access',async t=>{
  const folder=await temp(t),bytes=Buffer.from('small verified local download');let requests=0;
  const url=await server(t,(req,res)=>{requests++;if(req.url==='/redirect')res.writeHead(302,{Location:'/archive'}).end();else res.writeHead(200,{'Content-Length':bytes.length}).end(bytes);});
  const spec=specFor(bytes,{url:url+'/redirect'}),file=path.join(folder,'archive');
  await downloadVerified(spec,file,{allowHTTP:true,timeoutMs:1000});assert.deepEqual(await readFile(file),bytes);assert.equal(requests,2);
  await assert.rejects(downloadVerified({...spec,url},path.join(folder,'https-only'),{timeoutMs:1000}),/HTTPS/);
  await assert.rejects(downloadVerified({...spec,url:url.replace('http://','http://user:secret@')},path.join(folder,'credentials'),{allowHTTP:true,timeoutMs:1000}),/HTTPS/);
});

test('parallel ranges assemble the exact archive and detect an incorrect range response',async t=>{
  const folder=await temp(t),bytes=Buffer.alloc(140000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;let ranges=0;
  const url=await server(t,(req,res)=>{if(req.url==='/bad'){res.writeHead(206,{'Content-Range':'bytes 1-2/3','Content-Length':2}).end('xx');return;}const m=req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);assert.ok(m);ranges++;const start=Number(m[1]),end=Number(m[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));});
  const spec=specFor(bytes,{url}),file=path.join(folder,'range.zip');await downloadVerified(spec,file,{allowHTTP:true,connections:4,timeoutMs:2000});assert.equal(await sha256File(file),digest(bytes));assert.equal(ranges,5);
  await assert.rejects(downloadVerified({...spec,url:url+'/bad'},path.join(folder,'bad.zip'),{allowHTTP:true,connections:4,timeoutMs:2000}),/Range response/);
  assert.ok(!(await readdir(folder)).some(name=>name.startsWith('.runtime-parts-')));
});

test('a server ignoring Range falls back to its single full response; timeout and SHA failures reject',async t=>{
  const folder=await temp(t),bytes=Buffer.alloc(70000,3);let count=0;
  const url=await server(t,(req,res)=>{count++;if(req.url==='/wait')return;const output=req.url==='/wrong'?Buffer.alloc(bytes.length,4):bytes;res.writeHead(200,{'Content-Length':output.length}).end(output);});
  const spec=specFor(bytes,{url});await downloadVerified(spec,path.join(folder,'full'),{allowHTTP:true,timeoutMs:1000,connections:4});assert.equal(count,1);
  await assert.rejects(downloadVerified({...spec,url:url+'/wrong'},path.join(folder,'wrong'),{allowHTTP:true,timeoutMs:1000}),/SHA256 mismatch/);
  await assert.rejects(downloadVerified({...spec,url:url+'/wait'},path.join(folder,'wait'),{allowHTTP:true,timeoutMs:40}));
});

test('unverified archive never reaches extractor and never changes an existing runtime',async t=>{
  const root=await temp(t),bytes=Buffer.from('archive'),archive=path.join(root,'archive');await writeFile(archive,'changed');let extracted=false;
  await assert.rejects(setupRuntime(specFor(bytes),{root,archive,runImpl:async()=>{extracted=true;}}),/SHA256/);assert.equal(extracted,false);assert.deepEqual(await readdir(path.join(root,'runtime')),[]);
});

test('verified member hashes, reuse and explicit force replacement retain a backup',async t=>{
  const root=await temp(t),bytes=Buffer.from('verified small archive'),archive=path.join(root,'archive');await writeFile(archive,bytes);const spec=specFor(bytes);let extracts=0;
  const extractor=async(command,args)=>{extracts++;assert.equal(command,'tar');const dest=args[args.indexOf('-C')+1];await mkdir(path.join(dest,'pkg','bin'),{recursive:true});await writeFile(path.join(dest,'pkg','bin','tool'),'test executable');await writeFile(path.join(dest,'pkg','LICENSE'),'license');};
  let result=await setupRuntime(spec,{root,archive,runImpl:extractor});assert.equal(result.status,'installed');assert.equal(await readFile(result.path,'utf8'),'test executable');
  result=await setupRuntime(spec,{root,fetchImpl:()=>{throw Error('No network expected');},runImpl:extractor});assert.equal(result.status,'already-present');assert.equal(extracts,1);
  await writeFile(result.path,'previous custom executable');await assert.rejects(setupRuntime(spec,{root,archive,runImpl:extractor}),/different SHA256/);assert.equal(extracts,1);
  result=await setupRuntime(spec,{root,archive,force:true,runImpl:extractor});assert.equal(await readFile(path.join(result.backup,'test','bin','tool'),'utf8'),'previous custom executable');assert.equal(await readFile(result.path,'utf8'),'test executable');
  assert.ok(!(await readdir(path.join(root,'runtime'))).some(name=>name.startsWith('.setup-')));
  if(process.platform!=='win32')assert.ok((await stat(result.path)).mode&0o100);
});

test('an extracted executable with wrong hash is rejected and unsafe destinations are refused',async t=>{
  const root=await temp(t),bytes=Buffer.from('verified archive'),archive=path.join(root,'archive');await writeFile(archive,bytes);const spec=specFor(bytes);
  const badExtractor=async(command,args)=>{const dest=args[args.indexOf('-C')+1];await mkdir(path.join(dest,'pkg','bin'),{recursive:true});await writeFile(path.join(dest,'pkg','bin','tool'),'different executable');await writeFile(path.join(dest,'pkg','LICENSE'),'license');};
  await assert.rejects(setupRuntime(spec,{root,archive,runImpl:badExtractor}),/executable SHA256/);await assert.rejects(readFile(path.join(root,'runtime','test','bin','tool')),{code:'ENOENT'});
  for(const unsafe of ['../outside','/absolute','runtime/../outside','runtime\\test'])await assert.rejects(setupRuntime({...spec,executable:unsafe},{root,archive}),/Unsafe/);
  const outside=await temp(t);await symlink(outside,path.join(root,'runtime','test'),process.platform==='win32'?'junction':'dir');await assert.rejects(setupRuntime(spec,{root,archive}),/non-regular/);
});

test('system tar extracts only selected members from a real small fixture archive',async t=>{
  const root=await temp(t),source=path.join(root,'source');await mkdir(path.join(source,'pkg','bin'),{recursive:true});await writeFile(path.join(source,'pkg','bin','tool'),'test executable');await writeFile(path.join(source,'pkg','LICENSE'),'license');await writeFile(path.join(source,'pkg','unselected'),'not requested');
  const archive=path.join(root,'fixture.tar');const make=spawnSync('tar',['-cf',archive,'-C',source,'pkg'],{encoding:'utf8',windowsHide:true,timeout:10000});if(make.error?.code==='ENOENT'){t.skip('System tar is unavailable.');return;}assert.equal(make.status,0,make.stderr);
  const bytes=await readFile(archive),spec=specFor(bytes,{format:'tar.xz'});const result=await setupRuntime(spec,{root,archive});assert.equal(result.status,'installed');assert.equal(await readFile(result.path,'utf8'),'test executable');await assert.rejects(readFile(path.join(root,'runtime','test','unselected')),{code:'ENOENT'});
});

test('ZIP extraction uses Node only and rejects symlink members before installation',async t=>{
  const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return (n^0xffffffff)>>>0;};
  const zip=symlinkEntry=>{const entries=[['pkg/bin/tool','test executable',8],['pkg/LICENSE','license',0],['../unselected','ignored',0]],locals=[],centrals=[];let offset=0;
    for(const [name,text,method] of entries){const filename=Buffer.from(name),bytes=Buffer.from(text),compressed=method===8?deflateRawSync(bytes):bytes,local=Buffer.alloc(30),central=Buffer.alloc(46);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);local.writeUInt32LE(crc(bytes),14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt16LE(method,10);central.writeUInt32LE(crc(bytes),16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(symlinkEntry&&name==='pkg/bin/tool'?0xa0000000:0,38);central.writeUInt32LE(offset,42);locals.push(local,filename,compressed);centrals.push(central,filename);offset+=local.length+filename.length+compressed.length;}
    const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);};
  const root=await temp(t),archive=path.join(root,'fixture.zip'),bytes=zip(false);await writeFile(archive,bytes);const spec=specFor(bytes,{format:'zip'});const result=await setupRuntime(spec,{root,archive,runImpl:()=>{throw Error('ZIP must not need tar/PowerShell');}});assert.equal(await readFile(result.path,'utf8'),'test executable');await assert.rejects(readFile(path.join(root,'unselected')),{code:'ENOENT'});
  const other=await temp(t),bad=zip(true),badArchive=path.join(other,'fixture.zip');await writeFile(badArchive,bad);await assert.rejects(setupRuntime(specFor(bad,{format:'zip'}),{root:other,archive:badArchive}),/unsafe selected ZIP/);
});
