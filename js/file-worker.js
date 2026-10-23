import {parseNBS,parseMIDI} from './formats.js';
import {normalizeSong} from './model.js';

let dbPromise;
const openDB=()=>dbPromise ||= new Promise((resolve,reject)=>{
  const request=indexedDB.open('NoteBlockStudioRustWeb',3);
  request.onupgradeneeded=()=>{for(const name of ['projects','samples','history','snapshots','recents'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name);};
  request.onblocked=()=>reject(new Error('请关闭此地址的旧版标签页，再重新打开以升级本地项目存储。'));
  request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
});
const dbRequest=async(mode,run,store='projects')=>{const db=await openDB();return new Promise((resolve,reject)=>{const transaction=db.transaction(store,mode),request=run(transaction.objectStore(store));let result;request.onsuccess=()=>result=request.result;request.onerror=()=>reject(request.error);transaction.oncomplete=()=>resolve(result);transaction.onabort=()=>reject(transaction.error||new Error('本地存储事务失败'));});};
let saveQueue=Promise.resolve(),lastAutoBackup=0,backupSequence=0;
async function snapshot(project,label){
  const db=await openDB(),key=`${Date.now()}-${String(++backupSequence).padStart(6,'0')}`;
  return new Promise((resolve,reject)=>{const tx=db.transaction(['history','snapshots'],'readwrite'),meta=tx.objectStore('history'),content=tx.objectStore('snapshots');
    meta.put({key,title:project.title,label,createdAt:Date.now(),notes:project.notes?.length||0},key);content.put(project,key);
    const keys=meta.getAllKeys();keys.onsuccess=()=>{for(const old of keys.result.slice(0,Math.max(0,keys.result.length-20))){meta.delete(old);content.delete(old);}};
    tx.oncomplete=()=>resolve(key);tx.onabort=()=>reject(tx.error||new Error('备份失败'));
  });
}
async function saveProject(project,samples,options={}){
  const db=await openDB();await new Promise((resolve,reject)=>{const tx=db.transaction(samples===undefined?['projects']:['projects','samples'],'readwrite');tx.objectStore('projects').put(project,'current');if(samples!==undefined)tx.objectStore('samples').put(samples,'current');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('保存失败'));});
  const minutes=Math.max(1,Math.min(60,Number(options.backupMinutes)||5));
  if(options.autoBackup!==false&&Date.now()-lastAutoBackup>=minutes*60000){await snapshot(project,'自动备份');lastAutoBackup=Date.now();}
}
async function rememberProject(project,samples){
  const key=String(project.metadata?.browserProjectId||project.title||'untitled'),db=await openDB();
  return new Promise((resolve,reject)=>{const tx=db.transaction('recents','readwrite'),store=tx.objectStore('recents');store.put({key,project,samples:samples||[],title:project.title,createdAt:Date.now(),notes:project.notes.length},key);const request=store.getAll();request.onsuccess=()=>{for(const old of request.result.sort((a,b)=>b.createdAt-a.createdAt).slice(11))store.delete(old.key);};tx.oncomplete=()=>resolve(key);tx.onabort=()=>reject(tx.error||new Error('最近歌曲保存失败'));});
}
self.onmessage=async({data})=>{
  const {id,type}=data;
  try{
    if(type==='parse'){
      self.postMessage({id,progress:'正在后台解析和索引曲谱…'});
      const filename=data.filename.toLowerCase();let song;
      if(filename.endsWith('.nbs'))song=parseNBS(data.bytes);
      else if(/\.midi?$/.test(filename))song=parseMIDI(data.bytes,data.options);
      else if(filename.endsWith('.json'))song=JSON.parse(new TextDecoder().decode(data.bytes));
      else throw new Error('请打开 NBS、MIDI 或项目 JSON。');
      if(!song.title)song.title=data.filename.replace(/\.[^.]+$/,'');
      self.postMessage({id,result:normalizeSong(song)});
    }else if(type==='save'){
      const project=data.project;
      saveQueue=saveQueue.catch(()=>{}).then(()=>saveProject(project,data.samples,data.options));
      await saveQueue;self.postMessage({id,result:true});
    }else if(type==='load'){
      const raw=await dbRequest('readonly',store=>store.get('current'));
      self.postMessage({id,result:raw?normalizeSong(raw):null});
    }else if(type==='loadSamples'){
      self.postMessage({id,result:await dbRequest('readonly',store=>store.get('current'),'samples')||[]});
    }else if(type==='backup'){
      await saveQueue.catch(()=>{});self.postMessage({id,result:await snapshot(data.project,String(data.label||'手动备份').slice(0,100))});
    }else if(type==='history'){
      self.postMessage({id,result:await dbRequest('readonly',store=>store.getAll(),'history')});
    }else if(type==='restore'){
      const raw=await dbRequest('readonly',store=>store.get(String(data.key)),'snapshots');if(!raw)throw new Error('备份已不存在。');self.postMessage({id,result:normalizeSong(raw)});
    }else if(type==='remember'){
      self.postMessage({id,result:await rememberProject(data.project,data.samples)});
    }else if(type==='recent'){
      const rows=await dbRequest('readonly',store=>store.getAll(),'recents');self.postMessage({id,result:rows.sort((a,b)=>b.createdAt-a.createdAt).map(({key,title,createdAt,notes})=>({key,title,createdAt,notes}))});
    }else if(type==='loadRecent'){
      const row=await dbRequest('readonly',store=>store.get(String(data.key)),'recents');if(!row)throw new Error('最近歌曲已不存在。');self.postMessage({id,result:{...row,project:normalizeSong(row.project)}});
    }else if(type==='clearRecent'){
      await dbRequest('readwrite',store=>store.clear(),'recents');self.postMessage({id,result:true});
    }else throw new Error('未知后台文件任务');
  }catch(error){self.postMessage({id,error:error?.message||String(error)});}
};
