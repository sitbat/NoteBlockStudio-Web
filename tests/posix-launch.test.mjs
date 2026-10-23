import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm,symlink,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
// Windows can opt in with an existing POSIX shell; it is not Linux-kernel QA.
const shell=process.env.NBS_TEST_SHELL||(process.platform==='win32'?null:'/bin/sh');
test('POSIX launchers handle spaces, directory links, arbitrary cwd, environment and arguments', {skip:!shell&&'Set NBS_TEST_SHELL to an existing POSIX shell on Windows.'},async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'nbs-shell-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const project=path.join(folder,'project with spaces'),elsewhere=path.join(folder,'different cwd');await mkdir(path.join(project,'scripts'),{recursive:true});await mkdir(elsewhere);
  for(const name of ['start.sh','install-linux.sh','uninstall-linux.sh','scripts/linux-desktop.mjs'])await copyFile(path.join(root,name),path.join(project,name));
  await writeFile(path.join(project,'server.mjs'),'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),file:import.meta.url}));\n');
  const link=path.join(folder,'linked project');await symlink(project,link,process.platform==='win32'?'junction':'dir');
  const toolDir=path.join(folder,'node tools');await symlink(path.dirname(process.execPath),toolDir,process.platform==='win32'?'junction':'dir');
  const node=path.join(toolDir,path.basename(process.execPath));
  const env={...process.env,NODE_BINARY:node,NBS_NO_OPEN:'1'};
  const run=(script,args=[],overrides={})=>spawnSync(shell,[path.join(link,script),...args],{cwd:elsewhere,env:{...env,...overrides},encoding:'utf8',timeout:15000,windowsHide:true});
  let result=run('start.sh',['--port','8877','file with spaces.nbpz']);assert.equal(result.status,0,result.stderr);let data=JSON.parse(result.stdout);assert.deepEqual(data.args,['--port','8877','file with spaces.nbpz']);assert.equal(data.cwd,elsewhere);assert.equal(fileURLToPath(data.file),path.join(await realpath(project),'server.mjs'));
  result=run('start.sh',['--no-open','--player'],{NBS_NO_OPEN:'0'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout).args,['--open','--no-open','--player']);
  result=run('start.sh',[],{NODE_BINARY:path.join(folder,'missing-node')});assert.equal(result.status,1);assert.match(result.stderr,/Node.js/);
  const dataHome=path.join(folder,'user data');
  result=run('install-linux.sh',['--data-home',dataHome,'--port','8878']);assert.equal(result.status,0,result.stderr);const entry=path.join(dataHome,'applications','noteblockstudio-web-local.desktop');assert.match(await readFile(entry,'utf8'),/8878/);assert.match(await readFile(path.join(dataHome,'mime','packages','noteblockstudio-web-local.xml'),'utf8'),/\*\.nbpz/);
  result=run('start.sh',['--uninstall-desktop','--data-home',dataHome]);assert.equal(result.status,0,result.stderr);await assert.rejects(readFile(entry),{code:'ENOENT'});
});
