import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.nbs': 'application/octet-stream',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Local static files, plus optional same-origin services created by the launcher. */
export function createLocalServer(root = projectRoot, {services} = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cache-Control', 'no-cache');
    const fail = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    if (services) {
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host || '')) return fail(403, 'Local requests only');
      try { if (await services.handle(request,response)) return; }
      catch (error) { if (!response.headersSent) return fail(500,'Local service failed'); response.destroy(error); return; }
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return fail(405, 'Method not allowed');
    }
    // Reject non-local Host values, including DNS rebinding requests.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host || '')) {
      return fail(403, 'Local requests only');
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(segment => segment.startsWith('.'))) {
        return fail(403, 'Forbidden path');
      }
      const pathname = decoded === '/' ? '/index.html' : decoded;
      const rootPath = await realpath(root);
      const target = path.resolve(rootPath, `.${pathname}`);
      if (!inside(rootPath, target)) return fail(403, 'Forbidden path');
      const file = await realpath(target);
      if (!inside(rootPath, file)) return fail(403, 'Forbidden path');
      const info = await stat(file);
      if (!info.isFile()) return fail(404, 'Not found');
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size
      });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (error instanceof URIError || error.code === 'ERR_INVALID_URL') return fail(400, 'Bad request');
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return fail(404, 'Not found');
      if (error.code === 'EACCES') return fail(403, 'Forbidden');
      fail(500, 'Unable to read file');
    }
  });
}

export function browserLaunches(url, {platform=process.platform, env=process.env}={}) {
  const candidates=[];
  // BROWSER is an executable path, never shell code or a command template.
  if(env.BROWSER)candidates.push({command:env.BROWSER,args:[url]});
  if(platform==='win32')candidates.push({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-Command','Start-Process -FilePath $env:NBS_BROWSER_URL']});
  else if(platform==='darwin')candidates.push({command:'open',args:[url]});
  else candidates.push({command:'xdg-open',args:[url]},{command:'gio',args:['open',url]});
  return candidates;
}

export function openBrowser(url, {platform=process.platform,env=process.env,spawnImpl=spawn,log=console.log}={}) {
  const candidates=browserLaunches(url,{platform,env});
  const next=index=>{
    if(index>=candidates.length){log(`Please open ${url} in your browser.`);return;}
    const {command,args}=candidates[index];let failed=false;
    const fallback=()=>{if(!failed){failed=true;next(index+1);}};
    try{
      const child=spawnImpl(command,args,{detached:true,windowsHide:true,stdio:'ignore',shell:false,env:{...env,NBS_BROWSER_URL:url}});
      child.once('error',fallback);child.once('exit',code=>{if(code!==0)fallback();});child.unref();
    }catch{fallback();}
  };
  next(0);
}

export function parseLaunchOptions(args,env=process.env){
  const options={port:Number(env.PORT||8765),open:false,player:false,launchFile:undefined,launchURL:undefined,help:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i],value=()=>{if(!args[i+1])throw new Error(`Missing value for ${arg}`);return args[++i];};
    if(arg==='--open')options.open=true;
    else if(arg==='--no-open')options.open=false;
    else if(arg==='--player'||arg==='-player')options.player=true;
    else if(arg==='--help'||arg==='-h')options.help=true;
    else if(arg==='--port')options.port=Number(value());
    else if(arg.startsWith('--port='))options.port=Number(arg.slice(7));
    else if(arg==='--open-file')options.launchFile=value();
    else if(arg==='--url'||arg==='--protocol-launcher')options.launchURL=value();
    else if(!arg.startsWith('-')&&!options.launchFile&&!options.launchURL){if(/^nbs:\/\//i.test(arg)||/^https?:\/\//i.test(arg))options.launchURL=arg;else options.launchFile=arg;}
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if(options.launchFile?.startsWith('file:'))options.launchFile=fileURLToPath(options.launchFile);
  if(options.launchFile&&options.launchURL)throw new Error('Choose a launch file or a URL, not both.');
  if(!Number.isInteger(options.port)||options.port<1||options.port>65535)throw new Error('Port must be an integer between 1 and 65535.');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {port,open,player,launchFile,launchURL,help}=parseLaunchOptions(process.argv.slice(2));
    if(help){console.log('Usage: node server.mjs [--port PORT] [--open|--no-open] [--player] [--open-file PATH|--url URL]\nOnly listens on 127.0.0.1. PORT environment variable is supported.');}
    else {
    const {createNativeServices}=await import('./native-services.mjs');
    const services=await createNativeServices({launchFile,launchURL,projectRoot});
    const server = createLocalServer(projectRoot,{services});
    const stop=()=>{void services.close();server.close();server.closeIdleConnections?.();};
    server.once('close',()=>{void services.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);});
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the previous local server, or run: node server.mjs --port 8766`
        : `Unable to start local server: ${error.message}`);
      process.exitCode = 1;
      void services.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}${player?'/?player=1':''}`;
      console.log(`\nNote Block Studio Web\n${url}\nLocal computer only. Press Ctrl+C to stop.\n`);
      if (open) openBrowser(url);
    });
    }
  } catch(error) {
    console.error(error.message);process.exitCode=1;
  }
}
