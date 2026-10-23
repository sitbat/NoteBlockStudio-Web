/** File parsing, model normalization and IndexedDB writes stay off the UI thread. */
export class ProjectStore {
  constructor(){
    this.pending=new Map();this.sequence=0;this.failure=null;this.worker=null;
    try{
      this.worker=new Worker(new URL('./file-worker.js',import.meta.url),{type:'module',name:'NBS files and autosave'});
      this.worker.onmessage=({data})=>{
        if(!data||typeof data!=='object')return;
        const request=this.pending.get(data.id);if(!request)return;
        if(data.progress){request.onProgress?.(data.progress);return;}
        this.pending.delete(data.id);
        if(data.error)request.reject(new Error(data.error));else request.resolve(data.result);
      };
      this.worker.onerror=event=>{event.preventDefault?.();this.fail(new Error(event.message||'后台文件线程失败'));};
      this.worker.onmessageerror=()=>this.fail(new Error('后台文件线程消息无法解码，请重新打开页面。'));
    }catch(error){this.fail(error);}
  }
  fail(error){
    if(this.failure)return;
    this.failure=error instanceof Error?error:new Error(error?.message||'后台文件线程失败');
    for(const request of this.pending.values())request.reject(this.failure);
    this.pending.clear();
    try{this.worker?.terminate();}catch{/* Requests already have the original failure. */}
  }
  request(type,data={},transfer=[],onProgress){
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;this.pending.set(id,{resolve,reject,onProgress});
      try{this.worker.postMessage({id,type,...data},transfer);}
      catch(error){this.pending.delete(id);reject(error);}
    });
  }
  parse(file,onProgress,options){if(this.failure)return Promise.reject(this.failure);return file.arrayBuffer().then(bytes=>this.request('parse',{filename:file.name,bytes,options},[bytes],onProgress));}
  save(project,samples,options){return this.request('save',{project,samples,options});}
  load(){return this.request('load');}
  loadSamples(){return this.request('loadSamples');}
  backup(project,label='手动备份'){return this.request('backup',{project,label});}
  history(){return this.request('history');}
  restore(key){return this.request('restore',{key});}
  remember(project,samples){return this.request('remember',{project,samples});}
  recent(){return this.request('recent');}
  loadRecent(key){return this.request('loadRecent',{key});}
  clearRecent(){return this.request('clearRecent');}
}
