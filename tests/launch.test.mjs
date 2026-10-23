import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {browserLaunches,openBrowser,parseLaunchOptions} from '../server.mjs';
import {quoteExec,desktopEntry,installDesktop,uninstallDesktop} from '../scripts/linux-desktop.mjs';

const project=fileURLToPath(new URL('..',import.meta.url));
test('launch options honor env, explicit port, no-open and paths with spaces without shell parsing',()=>{
  assert.deepEqual(parseLaunchOptions(['--open','--port','8877','--open-file','song with spaces.nbs','--no-open'],{PORT:'1234'}),{port:8877,open:false,player:false,launchFile:'song with spaces.nbs',launchURL:undefined,help:false});
  assert.equal(parseLaunchOptions([],{PORT:'8876'}).port,8876);
  assert.equal(parseLaunchOptions(['--port=8766','--open'],{}).port,8766);
  assert.equal(parseLaunchOptions(['nbs://https//example.com/song.nbs'],{}).launchURL,'nbs://https//example.com/song.nbs');
  assert.equal(parseLaunchOptions(['relative song.nbs'],{}).launchFile,'relative song.nbs');
  assert.equal(parseLaunchOptions(['--player'],{}).player,true);
  assert.equal(parseLaunchOptions([new URL('file:///C:/songs/my%20song.nbpz').href],{}).launchFile,process.platform==='win32'?'C:\\songs\\my song.nbpz':'/C:/songs/my song.nbpz');
  for(const args of [['--port','0'],['--port','3.3'],['--port','65536'],['--port'],['--unknown'],['a.nbs','b.nbs']])assert.throws(()=>parseLaunchOptions(args,{}));
});

test('browser commands use argument arrays and fall back between Linux desktop openers',()=>{
  const url='http://127.0.0.1:8765/?x=$HOME&y=\"';
  assert.deepEqual(browserLaunches(url,{platform:'linux',env:{}}),[{command:'xdg-open',args:[url]},{command:'gio',args:['open',url]}]);
  assert.equal(browserLaunches(url,{platform:'linux',env:{BROWSER:'/path with spaces/browser'}})[0].command,'/path with spaces/browser');
  const calls=[],logs=[];
  openBrowser(url,{platform:'linux',env:{},spawnImpl(command,args,options){const child=new EventEmitter();child.unref=()=>{};calls.push({command,args,options});queueMicrotask(()=>child.emit(command==='xdg-open'?'error':'exit',command==='xdg-open'?new Error('missing'):0));return child;},log:value=>logs.push(value)});
  return new Promise(resolve=>setImmediate(()=>{assert.equal(calls.length,2);assert.deepEqual(calls[1].args,['open',url]);assert.equal(calls[1].options.shell,false);assert.equal(calls[1].options.windowsHide,true);assert.deepEqual(logs,[]);resolve();}));
});

test('Windows browser launch puts untrusted URL in environment rather than PowerShell source',()=>{
  const url='http://127.0.0.1:8765/?x=$(&bad)';let captured;
  openBrowser(url,{platform:'win32',env:{},spawnImpl(command,args,options){captured={command,args,options};const child=new EventEmitter();child.unref=()=>{};return child;}});
  assert.equal(captured.options.env.NBS_BROWSER_URL,url);assert.equal(captured.args.at(-1),'Start-Process -FilePath $env:NBS_BROWSER_URL');assert.ok(!captured.args.join(' ').includes(url));
});

test('desktop Exec quoting escapes shell characters, percent field codes and desktop string backslashes',()=>{
  assert.equal(quoteExec('/tmp/A B%file'), '"/tmp/A B%%file"');
  const encoded=quoteExec('/tmp/a"$`\\b');
  assert.equal(encoded,'"/tmp/a\\\\"\\\\$\\\\`\\\\\\\\b"');
  assert.throws(()=>quoteExec('/tmp/a\nb'));
  const entry=desktopEntry({root:path.resolve('A $ folder'),node:path.resolve('node bin'),port:8877});
  assert.match(entry,/Terminal=true/);assert.match(entry,/--port/);assert.match(entry,/8877/);assert.match(entry,/X-NoteBlockStudioWeb-Managed=true/);assert.match(entry,/application\/x-noteblockstudio-web-project/);assert.match(entry,/ %u\n/);
  assert.throws(()=>desktopEntry({root:'/tmp/app',node:'/bad=node'}),/equals/);
});

test('desktop installer and uninstaller only change their own user-local entry',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'nbs-desktop-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const dataHome=path.join(folder,'data with spaces'),entry=await installDesktop({dataHome,root:project,port:8877});
  assert.equal(path.dirname(entry),path.join(dataHome,'applications'));assert.match(await readFile(entry,'utf8'),/8877/);
  await installDesktop({dataHome,root:project,port:8878});assert.match(await readFile(entry,'utf8'),/8878/);
  const sibling=path.join(path.dirname(entry),'unrelated.desktop');await writeFile(sibling,'unrelated');
  await uninstallDesktop({dataHome});await assert.rejects(readFile(entry),{code:'ENOENT'});assert.equal(await readFile(sibling,'utf8'),'unrelated');await uninstallDesktop({dataHome});
  await writeFile(entry,'[Desktop Entry]\nName=Other application\n');await assert.rejects(installDesktop({dataHome,root:project}),/unrelated/);await assert.rejects(uninstallDesktop({dataHome}),/unrelated/);
  await assert.rejects(installDesktop({dataHome:'relative',root:project}),/absolute/);
});
