#!/usr/bin/env node
/** Build a closed set of public files. This tool is never deployed to the website. */
import {cp,mkdir,readdir,readFile,realpath,rm,stat,lstat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ROOT_FILES=['index.html','styles.css','static-bootstrap.js','coi-serviceworker.js','LICENSE','THIRD_PARTY_NOTICES.md'];
const DIRECTORIES=['js','css','wasm','assets','vendor','licenses'];
const REQUIRED=['js/app.js','js/browser-codecs.js','js/browser-files.js','js/dsp-worker.js','js/file-worker.js','js/output-worklet.js','wasm/nbs_dsp.wasm','assets/sounds/harp.ogg','vendor/ffmpeg/esm/index.js','vendor/ffmpeg/core/ffmpeg-core.js','vendor/ffmpeg/core/ffmpeg-core.wasm'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function publicFiles(root,relative,files){
  const file=path.join(root,relative),info=await lstat(file);
  if(info.isSymbolicLink())throw new Error(`Symbolic links are not permitted in static payload: ${relative}`);
  if(info.isDirectory()){
    for(const child of (await readdir(file)).sort()){
      if(child.startsWith('.'))throw new Error(`Hidden file in static payload: ${relative}/${child}`);
      await publicFiles(root,path.posix.join(relative,child),files);
    }
  }else if(info.isFile()){
    if(relative.startsWith('assets/transcription/')&&(/\.(safetensors|bin)$/i.test(relative)||info.size>16*1024*1024))throw new Error(`Large model weights must not be hosted in the static website: ${relative}`);
    files.push(relative);
  }
  else throw new Error(`Unsupported static entry: ${relative}`);
}
export async function buildStatic(root=projectRoot){
  root=await realpath(root);const output=path.join(root,'dist'),files=[];
  for(const name of [...ROOT_FILES,...DIRECTORIES])await publicFiles(root,name,files);
  for(const name of REQUIRED)if(!files.includes(name))throw new Error(`Missing static runtime file: ${name}`);
  for(const name of ['wasm/nbs_dsp.wasm','vendor/ffmpeg/core/ffmpeg-core.wasm'])if(!WebAssembly.validate(await readFile(path.join(root,name))))throw new Error(`Invalid WebAssembly payload: ${name}`);
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const manifest={kind:'noteblockstudio-static',version:pkg.version,files:[]};
  for(const name of files.sort()){const bytes=await readFile(path.join(root,name));manifest.files.push({path:name,bytes:bytes.length,sha256:hash(bytes)});}
  // The only recursive replacement target is the checked projectRoot/dist.
  try{if((await lstat(output)).isSymbolicLink())throw new Error('Refusing to replace a linked dist directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
  await rm(output,{recursive:true,force:true});await mkdir(output);
  for(const item of manifest.files){const destination=path.join(output,item.path);await mkdir(path.dirname(destination),{recursive:true});await cp(path.join(root,item.path),destination,{errorOnExist:true,force:false});}
  await writeFile(path.join(output,'static-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {directory:output,files:manifest.files.length,bytes:manifest.files.reduce((total,file)=>total+file.bytes,0),version:manifest.version};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  buildStatic().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(`Static build failed: ${error.message}`);process.exitCode=1;});
}
