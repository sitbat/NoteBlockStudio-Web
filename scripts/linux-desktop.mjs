import {readFile,writeFile,mkdir,rename,unlink,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ENTRY='noteblockstudio-web-local.desktop';
const MARKER='X-NoteBlockStudioWeb-Managed=true';
const MIME_FILE='noteblockstudio-web-local.xml';
const MIME_MARKER='<!-- NoteBlockStudioWeb-Managed -->';
const MIME_XML=`<?xml version="1.0" encoding="UTF-8"?>
${MIME_MARKER}
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-noteblockstudio-song"><comment>Note Block Studio song</comment><glob pattern="*.nbs"/></mime-type>
  <mime-type type="application/x-noteblockstudio-pattern"><comment>Note Block Studio pattern</comment><glob pattern="*.nbp"/></mime-type>
  <mime-type type="application/x-noteblockstudio-web-project"><comment>Note Block Studio Web complete project</comment><glob pattern="*.nbpz"/></mime-type>
</mime-info>
`;
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const clean=value=>{const text=String(value);if(/[\x00-\x1f\x7f]/.test(text))throw new Error('Desktop paths must not contain control characters.');return text;};
const stringValue=value=>clean(value).replace(/\\/g,'\\\\');
export function quoteExec(value){return stringValue('"'+clean(value).replace(/%/g,'%%').replace(/[\\`"$]/g,'\\$&')+'"');}

export function desktopEntry({root,node,port}){
  if(clean(node).includes('='))throw new Error('Desktop executable paths cannot contain an equals sign.');
  const args=[node,path.join(root,'server.mjs'),'--open'];
  if(port!==undefined){if(!Number.isInteger(Number(port))||Number(port)<1||Number(port)>65535)throw new Error('Port must be between 1 and 65535.');args.push('--port',String(port));}
  return ['[Desktop Entry]','Type=Application','Version=1.5','Name=Note Block Studio Web','Name[zh_CN]=音符盒工作室 Web','Comment=Local Rust/WASM music editor','Categories=AudioVideo;Audio;','MimeType=application/x-noteblockstudio-song;application/x-noteblockstudio-pattern;application/x-noteblockstudio-web-project;x-scheme-handler/nbs;','Terminal=true','StartupNotify=false',`Exec=${args.map(quoteExec).join(' ')} %u`,`TryExec=${stringValue(node)}`,`Path=${stringValue(root)}`,MARKER,`X-NoteBlockStudioWeb-Project=${stringValue(root)}`,''].join('\n');
}

async function targetFor(dataHome){
  const data=dataHome??process.env.XDG_DATA_HOME??path.join(os.homedir(),'.local','share');
  if(!path.isAbsolute(data))throw new Error('XDG_DATA_HOME must be an absolute path.');
  return path.join(data,'applications',ENTRY);
}
async function existingManaged(target,marker=MARKER){
  try{const entry=await lstat(target);if(entry.isSymbolicLink()||!entry.isFile())throw new Error(`Refusing to change a non-regular desktop entry: ${target}`);const content=await readFile(target,'utf8');if(!content.split(/\r?\n/).includes(marker))throw new Error(`Refusing to overwrite an unrelated desktop entry: ${target}`);return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
async function atomicWrite(target,contents){
  await mkdir(path.dirname(target),{recursive:true});
  const temp=path.join(path.dirname(target),`.nbs-desktop-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  try{await writeFile(temp,contents,{encoding:'utf8',flag:'wx',mode:0o644});await rename(temp,target);}
  finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function refreshCaches(target,spawnImpl=spawn){
  const data=path.dirname(path.dirname(target));
  for(const [command,args] of [['update-mime-database',[path.join(data,'mime')]],['update-desktop-database',[path.dirname(target)]]])await new Promise(resolve=>{let child;try{child=spawnImpl(command,args,{stdio:'ignore',shell:false,windowsHide:true});}catch{return resolve();}const timer=setTimeout(()=>{child.kill();resolve();},5000);timer.unref();const done=()=>{clearTimeout(timer);resolve();};child.once('error',done);child.once('close',done);});
}
export async function installDesktop({dataHome,port,root=projectRoot,node=process.execPath,refresh=process.platform==='linux'}={}){
  const target=await targetFor(dataHome),mime=path.join(path.dirname(path.dirname(target)),'mime','packages',MIME_FILE);await existingManaged(target);await existingManaged(mime,MIME_MARKER);
  const contents=desktopEntry({root:await realpath(root),node:await realpath(node),port});
  await atomicWrite(mime,MIME_XML);await atomicWrite(target,contents);
  if(refresh)await refreshCaches(target);
  return target;
}
export async function uninstallDesktop({dataHome,refresh=process.platform==='linux'}={}){const target=await targetFor(dataHome),mime=path.join(path.dirname(path.dirname(target)),'mime','packages',MIME_FILE),hasEntry=await existingManaged(target),hasMime=await existingManaged(mime,MIME_MARKER);if(hasEntry)await unlink(target);if(hasMime)await unlink(mime);if(refresh&&(hasEntry||hasMime))await refreshCaches(target);return target;}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [action,...args]=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i++){if(args[i]==='--data-home'&&args[i+1])options.dataHome=path.resolve(args[++i]);else if(args[i]==='--port'&&args[i+1])options.port=Number(args[++i]);else throw new Error(`Unknown or incomplete option: ${args[i]}`);}
    if(action==='install')console.log(`Installed user-local desktop entry: ${await installDesktop(options)}\nThe app stays in its current folder. User-local NBS/NBP/NBPZ MIME definitions and an nbs:// handler are advertised; existing default associations are preserved. No packages or services were installed.`);
    else if(action==='uninstall')console.log(`Removed managed desktop entry, if present: ${await uninstallDesktop(options)}\nProject files and browser data are unchanged.`);
    else throw new Error('Use install or uninstall [--data-home PATH] [--port PORT].');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
