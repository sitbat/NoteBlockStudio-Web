#!/usr/bin/env node
/** Developer preview only: deliberately sends no COOP/COEP, to exercise static bootstrap. */
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildStatic,projectRoot} from './build-static.mjs';

const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.ogg':'audio/ogg','.wav':'audio/wav','.woff2':'font/woff2','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};
export async function createStaticPreview(root){
  const base=await realpath(root),manifest=JSON.parse(await readFile(path.join(base,'static-manifest.json'),'utf8')),allowed=new Set([...manifest.files.map(file=>file.path),'static-manifest.json']);
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const fail=(code,message)=>{res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});res.end(message);};
    if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host||''))return fail(403,'Developer preview accepts loopback hosts only.');
    if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return fail(405,'Static files only.');}
    try{
      if(!req.url?.startsWith('/')||req.url.startsWith('//'))return fail(400,'Invalid static request target.');
      const decoded=decodeURIComponent(req.url.split('?')[0]),relative=decoded==='/'?'index.html':decoded.slice(1);
      if(relative.includes('\\')||relative.includes('\0')||relative.split('/').some(part=>!part||part.startsWith('.'))||!allowed.has(relative))return fail(404,'Not a public static file.');
      const file=path.join(base,relative);if(await realpath(file)!==file)return fail(403,'Linked static files are not served.');const info=await stat(file);
      res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Content-Length':info.size});
      if(req.method==='HEAD')return res.end();const stream=createReadStream(file);stream.once('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
    }catch(error){return fail(error instanceof URIError?400:404,'Unable to read static file.');}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--port'))throw new Error('Usage: npm start -- [--port 8792]');
    const port=Number(args[1]||process.env.NBS_PREVIEW_PORT||8792);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid preview port.');
    await buildStatic();const server=await createStaticPreview(path.join(projectRoot,'dist'));
    const stop=()=>{server.close();server.closeAllConnections?.();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    server.once('error',error=>{console.error(error.code||error.message);process.exitCode=1;});
    server.listen(port,'127.0.0.1',()=>console.log(`Static developer preview: http://127.0.0.1:${port}/\nNo isolation headers or application backend; Service Worker supplies browser isolation.`));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
