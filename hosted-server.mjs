/** Public website entry point. Desktop/local integrations remain in server.mjs. */
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.ogg':'audio/ogg','.wav':'audio/wav','.mp3':'audio/mpeg','.flac':'audio/flac','.nbs':'application/octet-stream','.nbp':'application/octet-stream','.nbpz':'application/zip','.zip':'application/zip','.mid':'audio/midi','.midi':'audio/midi','.woff2':'font/woff2'};
const ASSETS=new Set(['.json','.png','.jpg','.jpeg','.gif','.webp','.svg','.ico','.ogg','.wav','.mp3','.flac','.nbs','.nbp','.nbpz','.zip','.mid','.midi','.woff2']);
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};

export function normalizePublicOrigin(value){
  if(typeof value!=='string'||/[\x00-\x20\x7f\\]/.test(value)||!/^https?:\/\/[^/?#]+\/?$/i.test(value))throw new Error('PUBLIC_ORIGIN must contain only a scheme and authority, without a path/query/fragment.');
  let url;try{url=new URL(value);}catch{throw new Error('PUBLIC_ORIGIN must be an absolute HTTPS origin.');}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!LOOPBACK.has(url.hostname))throw new Error('PUBLIC_ORIGIN requires HTTPS, no credentials/path/query/fragment; HTTP is only allowed on loopback for development.');
  return url.origin;
}

export function hostedClientAddress(request,{trustProxyHeaders=false}={}){
  const supplied=request.headers?.['x-nbs-client-ip'];
  if(trustProxyHeaders&&typeof supplied==='string'&&isIP(supplied))return supplied;
  return request.socket?.remoteAddress||'unknown';
}

export function parseHostedOptions(args=[],env=process.env){
  const options={host:env.HOST||'127.0.0.1',port:Number(env.PORT||8765),publicOrigin:env.PUBLIC_ORIGIN,trustProxyHeaders:env.TRUST_PROXY_HEADERS==='1',help:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i],take=()=>{if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value for ${arg}`);return args[++i];};
    if(arg==='--help'||arg==='-h')options.help=true;
    else if(arg==='--host')options.host=take();
    else if(arg==='--port')options.port=Number(take());
    else if(arg==='--public-origin')options.publicOrigin=take();
    else if(arg==='--trust-proxy-headers')options.trustProxyHeaders=true;
    else throw new Error(`Unknown hosted argument: ${arg}`);
  }
  if(options.help)return options;
  if(!Number.isInteger(options.port)||options.port<1||options.port>65535)throw new Error('PORT must be an integer between 1 and 65535.');
  if(options.host!=='localhost'&&!isIP(options.host))throw new Error('HOST must be an IP address or localhost.');
  options.publicOrigin=normalizePublicOrigin(options.publicOrigin);
  return options;
}

/** Only the browser payload is served; a checkout is never an unrestricted web root. */
export function createHostedServer(root=projectRoot,{publicOrigin,services,requestTimeoutMs=30000}={}){
  const origin=normalizePublicOrigin(publicOrigin),expectedHost=new URL(origin).host.toLowerCase();
  const server=http.createServer(async(request,response)=>{
    for(const [name,value]of Object.entries({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','X-Frame-Options':'DENY','Cache-Control':'no-cache'}))response.setHeader(name,value);
    const fail=(status,message)=>{response.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});response.end(request.method==='HEAD'?undefined:message);};
    if(typeof request.headers.host!=='string'||request.headers.host.toLowerCase()!==expectedHost)return fail(403,'Host is not the configured public origin.');
    try{
      if(!request.url?.startsWith('/')||request.url.startsWith('//'))return fail(400,'Invalid request target.');
      const url=new URL(request.url,origin),decoded=decodeURIComponent(url.pathname);
      if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').some(segment=>segment.startsWith('.')))return fail(403,'Forbidden path.');
      if(decoded.startsWith('/api/')){
        // Service routes perform their own exact Origin/session checks.
        if(services&&await services.handle(request,response))return;
        return fail(404,'Unknown website API.');
      }
      if(!['GET','HEAD'].includes(request.method)){response.setHeader('Allow','GET, HEAD');return fail(405,'Method not allowed.');}
      const pathname=decoded==='/'?'/index.html':decoded,parts=pathname.slice(1).split('/'),extension=path.posix.extname(pathname).toLowerCase();
      let allowedDirectory;
      if(pathname==='/index.html'||pathname==='/styles.css'||pathname==='/favicon.ico')allowedDirectory='';
      else if(parts[0]==='js'&&['.js','.mjs'].includes(extension))allowedDirectory='js';
      else if(parts[0]==='css'&&extension==='.css')allowedDirectory='css';
      else if(parts[0]==='wasm'&&extension==='.wasm')allowedDirectory='wasm';
      else if(parts[0]==='assets'&&ASSETS.has(extension))allowedDirectory='assets';
      else return fail(404,'Not a public website file.');
      const rootPath=await realpath(root),allowedPath=path.resolve(rootPath,allowedDirectory),target=path.resolve(rootPath,`.${pathname}`);
      if(!inside(allowedPath,target))return fail(403,'Forbidden path.');
      const actualAllowed=await realpath(allowedPath);
      // A public directory itself must not be a link to another part of the checkout.
      if(actualAllowed!==allowedPath)return fail(403,'Public directories may not be symbolic links.');
      const file=await realpath(target);
      if(!inside(actualAllowed,file)||file!==target)return fail(403,'Forbidden path.');
      const info=await stat(file);if(!info.isFile())return fail(404,'Not found.');
      response.writeHead(200,{'Content-Type':MIME[extension]||'application/octet-stream','Content-Length':info.size});
      if(request.method==='HEAD')return response.end();
      const stream=createReadStream(file);stream.once('error',()=>response.destroy());response.once('close',()=>stream.destroy());stream.pipe(response);
    }catch(error){
      if(response.headersSent){response.destroy();return;}
      if(error instanceof URIError||error.code==='ERR_INVALID_URL')return fail(400,'Bad request.');
      if(['ENOENT','ENOTDIR'].includes(error.code))return fail(404,'Not found.');
      if(['EACCES','EPERM','ELOOP'].includes(error.code))return fail(403,'Forbidden path.');
      return fail(500,'Unable to serve the website request.');
    }
  });
  server.requestTimeout=Math.max(30000,Math.min(300000,Number(requestTimeoutMs)||30000));server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=64;server.maxRequestsPerSocket=100;
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options=parseHostedOptions(process.argv.slice(2));
    if(options.help)console.log('Usage: node hosted-server.mjs --public-origin https://nbs.example.com [--host 127.0.0.1] [--port 8765] [--trust-proxy-headers]\nEnvironment: PUBLIC_ORIGIN, HOST, PORT, TRUST_PROXY_HEADERS. Public HTTPS and external access are configured separately; see docs/DEPLOYMENT.md.');
    else{
      const {createHostedServices}=await import('./hosted-services.mjs');
      const services=await createHostedServices({publicOrigin:options.publicOrigin,projectRoot,clientAddress:req=>hostedClientAddress(req,options)});
      const server=createHostedServer(projectRoot,{publicOrigin:options.publicOrigin,services,requestTimeoutMs:(Number(process.env.HOSTED_BODY_TIMEOUT_MS)||20000)+1000});
      let stopping=false,shutdownTimer;
      const stop=()=>{if(stopping)return;stopping=true;void services.close();server.close();server.closeIdleConnections?.();shutdownTimer=setTimeout(()=>{server.closeAllConnections?.();},5000);shutdownTimer.unref();};
      server.once('close',()=>{clearTimeout(shutdownTimer);void services.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);});
      server.once('error',error=>{console.error(`Website server failed: ${error.code||'START_FAILED'}`);process.exitCode=1;void services.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);});
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
      server.listen(options.port,options.host,()=>console.log(`Note Block Studio website backend: http://${options.host}:${options.port}\nPublic origin: ${options.publicOrigin}\nPublic HTTPS and external access are configured separately.`));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
