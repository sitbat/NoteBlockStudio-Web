#!/usr/bin/env node
/** Check a deployed static directory. No uploads, cookies, or application API are used. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function smokeStatic(input,{fetchImpl=fetch}={}){
  const base=new URL(input);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw new Error('Use the static website directory URL without credentials, query or fragment.');
  if(!base.pathname.endsWith('/'))throw new Error('The website directory URL must end with /.');
  const get=route=>fetchImpl(new URL(route,base),{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000)});
  const response=await get('static-manifest.json');assert.equal(response.status,200,'Static manifest');const manifest=await response.json();assert.equal(manifest.kind,'noteblockstudio-static');assert.ok(Array.isArray(manifest.files)&&manifest.files.length);
  const result={url:base.href,version:manifest.version,files:0,bytes:0,serverIsolationHeaders:false};
  for(const item of manifest.files){
    assert.ok(typeof item.path==='string'&&!item.path.startsWith('/')&&!item.path.includes('\\')&&!item.path.split('/').some(part=>!part||part.startsWith('.')),'Safe manifest path');
    const asset=await get(item.path);assert.equal(asset.status,200,item.path);const bytes=Buffer.from(await asset.arrayBuffer());assert.equal(bytes.length,item.bytes,item.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.path);
    if(item.path==='index.html')result.serverIsolationHeaders=asset.headers.get('cross-origin-opener-policy')==='same-origin'&&['require-corp','credentialless'].includes(asset.headers.get('cross-origin-embedder-policy'));
    if(item.path.endsWith('.wasm')){assert.match(asset.headers.get('content-type')||'',/^application\/wasm/);assert.ok(WebAssembly.validate(bytes),item.path);}
    result.files++;result.bytes+=bytes.length;
  }
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3){console.error('Usage: node scripts/smoke-static.mjs https://example.com/music/');process.exitCode=1;}
  else smokeStatic(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(`Static smoke failed: ${error.message}`);process.exitCode=1;});
}
