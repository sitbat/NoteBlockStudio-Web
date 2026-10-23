import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {ProjectStore} from '../js/project-store.js';

let originalWorker;
const workers=[];
class FakeWorker{
  constructor(){this.messages=[];this.terminations=0;workers.push(this);}
  postMessage(message,transfer){
    this.messages.push({message,transfer});
    if(this.nextError){const error=this.nextError;this.nextError=null;throw error;}
  }
  terminate(){this.terminations++;}
  reply(id,result){this.onmessage({data:{id,result}});}
}
beforeEach(()=>{originalWorker=globalThis.Worker;globalThis.Worker=FakeWorker;workers.length=0;});
afterEach(()=>{if(originalWorker===undefined)delete globalThis.Worker;else globalThis.Worker=originalWorker;});

test('fatal Worker errors reject outstanding and all subsequent requests without posting again',{timeout:1000},async()=>{
  const store=new ProjectStore(),worker=workers[0];
  const load=assert.rejects(store.load(),/file worker crashed/);
  const save=assert.rejects(store.save({title:'Current project'}),/file worker crashed/);
  worker.onerror({message:'file worker crashed',preventDefault(){}});
  await Promise.all([load,save]);
  await assert.rejects(store.load(),/file worker crashed/);
  await assert.rejects(store.save({title:'Next project'}),/file worker crashed/);
  assert.equal(worker.messages.length,2);
  assert.equal(worker.terminations,1);
  // Late browser events must not resurrect requests or replace the first error.
  worker.reply(1,{title:'late result'});
  worker.onerror({message:'second error',preventDefault(){}});
  await assert.rejects(store.load(),/file worker crashed/);
  assert.equal(worker.terminations,1);
});

test('message decoding failure rejects pending work and does not read future files',{timeout:1000},async()=>{
  const store=new ProjectStore(),worker=workers[0];
  const pending=assert.rejects(store.load(),/消息无法解码/);
  worker.onmessageerror({});await pending;
  let fileRead=false;
  await assert.rejects(store.parse({name:'example.nbs',arrayBuffer(){fileRead=true;return Promise.resolve(new ArrayBuffer(0));}}),/消息无法解码/);
  assert.equal(fileRead,false);
  assert.equal(worker.messages.length,1);
  assert.equal(worker.terminations,1);
});

test('Worker construction failure becomes a bounded request rejection',{timeout:1000},async()=>{
  globalThis.Worker=class{constructor(){throw new Error('Workers disabled');}};
  let store;
  assert.doesNotThrow(()=>{store=new ProjectStore();});
  await assert.rejects(store.load(),/Workers disabled/);
  await assert.rejects(store.save({title:'Unsaved'}),/Workers disabled/);
});

test('a synchronous postMessage failure rejects that request while later requests still work',{timeout:1000},async()=>{
  const store=new ProjectStore(),worker=workers[0];
  worker.nextError=Object.assign(new Error('Uncloneable project'),{name:'DataCloneError'});
  await assert.rejects(store.save({title:'Invalid'}),/Uncloneable project/);
  assert.equal(store.pending.size,0);
  const load=store.load();
  worker.reply(worker.messages.at(-1).message.id,{title:'Still available'});
  assert.deepEqual(await load,{title:'Still available'});
  assert.equal(worker.terminations,0);
});

test('ordinary file/storage errors stay request-specific and progress leaves the request open',{timeout:1000},async()=>{
  const store=new ProjectStore(),worker=workers[0],progress=[];
  const parse=store.request('parse',{},[],message=>progress.push(message));
  const parseId=worker.messages.at(-1).message.id;
  worker.onmessage({data:{id:parseId,progress:'Reading notes'}});
  assert.deepEqual(progress,['Reading notes']);
  worker.reply(parseId,{title:'Parsed'});
  assert.deepEqual(await parse,{title:'Parsed'});
  const failedSave=assert.rejects(store.save({title:'Quota'}),/Quota exceeded/);
  worker.onmessage({data:{id:worker.messages.at(-1).message.id,error:'Quota exceeded'}});
  await failedSave;
  const load=store.load();worker.reply(worker.messages.at(-1).message.id,null);
  assert.equal(await load,null);
  assert.equal(worker.terminations,0);
});
