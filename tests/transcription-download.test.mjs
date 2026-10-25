import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {downloadTranscriptionBlob,sha256Blob} from '../js/transcription-download.js';

// Node 18 exposes Web Crypto through node:crypto; browsers provide the global.
const originalCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto');
before(()=>{if(globalThis.crypto===undefined)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});});
after(()=>{if(originalCrypto)Object.defineProperty(globalThis,'crypto',originalCrypto);else delete globalThis.crypto;});

function response(parts,{status=200,length,readHook}={}){
  return new Response(new ReadableStream({pull(controller){readHook?.();const next=parts.shift();if(next)controller.enqueue(Uint8Array.from(next));else controller.close();}}),{status,headers:length===undefined?{}:{'content-length':String(length)}});
}
test('download starts only on explicit call, streams with truthful progress and no credentials',async()=>{
  const progress=[];let requested;
  const blob=await downloadTranscriptionBlob('https://www.modelscope.cn/model.safetensors',{bytes:5,onProgress:p=>progress.push(p),fetchImpl:async(url,options)=>{requested={url,options};return response([[1,2],[3,4,5]],{length:5});}});
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[1,2,3,4,5]);
  assert.equal(requested.options.credentials,'omit');assert.equal(requested.options.mode,'cors');assert.equal(requested.options.cache,'no-store');
  assert.deepEqual(progress.map(p=>p.loaded),[0,2,5]);assert(progress.every(p=>p.total===5&&p.stage==='download'));
  assert.equal(await sha256Blob(blob),createHash('sha256').update(Uint8Array.of(1,2,3,4,5)).digest('hex'));
});
test('a partial, changed, oversized, or failed response is never returned for installation',async()=>{
  for(const result of [response([[1,2]],{length:4}),response([[1,2]]),response([[1,2,3,4]]),response([[1]],{status:403}),response([[1]],{status:206})]){
    await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:3,fetchImpl:async()=>result}),error=>['MODEL_SIZE_MISMATCH','MODEL_DOWNLOAD'].includes(error.code));
  }
});
test('cancellation before download never opens the network and cancellation during streaming stops installation',async()=>{
  const pre=new AbortController();pre.abort();let calls=0;
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:2,signal:pre.signal,fetchImpl:()=>calls++}),{name:'AbortError'});assert.equal(calls,0);
  const during=new AbortController();
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:2,signal:during.signal,fetchImpl:async()=>response([[1],[2]]),onProgress:p=>{if(p.loaded===1)during.abort();}}),{name:'AbortError'});
});
test('unsafe URLs and huge sizes fail before contacting any server',async()=>{
  const fetchImpl=()=>{throw new Error('must not fetch');};
  for(const url of ['http://example.test/model','file:///model','https://user:secret@example.test/model'])await assert.rejects(downloadTranscriptionBlob(url,{bytes:1,fetchImpl}),{code:'MODEL_URL'});
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:2**31,fetchImpl}),{code:'MODEL_TOO_LARGE'});
});
test('network/CORS failures give a useful local import fallback',async()=>{
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:1,fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),error=>error.code==='MODEL_NETWORK'&&error.message.includes('本地模型包'));
});

test('large weights use sequential CORS-safe byte ranges and verify the complete concatenated bytes',async()=>{
  const requests=[],source=Uint8Array.from({length:13},(_,i)=>i),progress=[];
  const result=await downloadTranscriptionBlob('https://example.test/model',{bytes:13,rangeBytes:5,concurrency:1,onProgress:p=>progress.push(p),fetchImpl:async(url,options)=>{
    requests.push(options.headers.Range);const [,first,last]=options.headers.Range.match(/bytes=(\d+)-(\d+)/),data=source.slice(+first,+last+1);
    return response([[...data]],{status:206,length:data.length});
  }});
  assert.deepEqual(requests,['bytes=0-4','bytes=5-9','bytes=10-12']);assert.deepEqual(new Uint8Array(await result.arrayBuffer()),source);
  assert.deepEqual(progress.map(p=>p.loaded),[0,5,10,13]);
});

test('an interrupted range retains received bytes and retries only its missing suffix',async()=>{
  const requests=[],progress=[];let reads=0;
  const result=await downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:4,concurrency:1,onProgress:p=>progress.push(p),fetchImpl:async(url,options)=>{
    requests.push(options.headers.Range);
    if(requests.length===1)return new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(Uint8Array.of(0,1));else controller.error(new TypeError('network error'));}}),{status:206});
    if(requests.length===2)return response([[2,3]],{status:206,length:2});
    return response([[4,5,6]],{status:206,length:3});
  }});
  assert.deepEqual(requests,['bytes=0-3','bytes=2-3','bytes=4-6']);assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[0,1,2,3,4,5,6]);
  assert(progress.some(p=>p.retrying));assert(progress.every((p,i)=>i===0||p.loaded>=progress[i-1].loaded));
});

test('range retries are bounded and an ignored Range cannot turn into an unbounded full response',async()=>{
  let calls=0;
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,concurrency:1,maxAttempts:3,fetchImpl:async()=>{calls++;throw new TypeError('network error');}}),{code:'MODEL_NETWORK'});assert.equal(calls,3);
  calls=0;await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,concurrency:1,fetchImpl:async()=>{calls++;return response([[1,2,3,4,5,6,7]],{status:200,length:7});}}),{code:'MODEL_DOWNLOAD'});assert.equal(calls,1);
});

test('a byte range that returns too little or too much is never silently accepted',async()=>{
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,concurrency:1,maxAttempts:1,fetchImpl:async()=>response([[1,2]],{status:206,length:3})}),{code:'MODEL_NETWORK'});
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,concurrency:1,fetchImpl:async()=>response([[1,2,3,4]],{status:206})}),{code:'MODEL_SIZE_MISMATCH'});
});

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await turn();}assert.fail('controlled download did not reach the expected state');}
const interval=options=>{const match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);assert(match);return {start:Number(match[1]),end:Number(match[2])+1};};
function heldResponse(data,signal,onStop=()=>{}){
  let controller,finished=false;
  const stop=()=>{if(finished)return;finished=true;signal.removeEventListener('abort',cancel);onStop();};
  const cancel=()=>{if(finished)return;controller.error(new DOMException('aborted','AbortError'));stop();};
  const stream=new ReadableStream({start(value){controller=value;},cancel(){stop();}});
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  return {response:new Response(stream,{status:206,headers:{'content-length':String(data.length)}}),get finished(){return finished;},push(value){assert(!finished);controller.enqueue(Uint8Array.from(value));},send(){assert(!finished);controller.enqueue(data);controller.close();stop();}};
}

test('defaults schedule two 40-MiB ranges without allocating or downloading large bodies',async()=>{
  const size=40*1024*1024,abort=new AbortController(),requests=[];
  const pending=downloadTranscriptionBlob('https://example.test/model',{bytes:size+5,signal:abort.signal,fetchImpl:(_url,options)=>{requests.push(options);return new Promise(()=>{});}});
  await until(()=>requests.length===2);
  assert.deepEqual(requests.map(options=>options.headers.Range),[`bytes=0-${size-1}`,`bytes=${size}-${size+4}`]);
  abort.abort();await assert.rejects(pending,{name:'AbortError'});assert(requests.every(options=>options.signal.aborted));assert.equal(requests.length,2);
});

test('concurrency is a strict integer 1 through 4 and invalid configurations open no requests',async()=>{
  let calls=0;const fetchImpl=()=>{calls++;throw new Error('must not fetch');};
  for(const concurrency of [0,5,1.5,'2',null,NaN])await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,concurrency,fetchImpl}),{code:'MODEL_DOWNLOAD_OPTIONS'});
  for(const rangeBytes of [0,40*1024*1024+1,1.5])await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes,fetchImpl}),{code:'MODEL_DOWNLOAD_OPTIONS'});
  assert.equal(calls,0);
});

for(const concurrency of [1,2,3,4])test(`the range pool never exceeds concurrency ${concurrency} while draining all queued ranges`,async()=>{
  const source=Uint8Array.from({length:19},(_,i)=>i),jobs=[],requests=[];let active=0,peak=0;
  const pending=downloadTranscriptionBlob('https://example.test/model',{bytes:source.length,rangeBytes:3,concurrency,fetchImpl:async(_url,options)=>{
    const {start,end}=interval(options);requests.push(options.headers.Range);active++;peak=Math.max(peak,active);
    const job=heldResponse(source.slice(start,end),options.signal,()=>active--);jobs.push(job);return job.response;
  }});
  await until(()=>jobs.length===concurrency);assert.equal(active,concurrency);
  let released=0;
  while(released<7){await until(()=>jobs.some(job=>!job.finished));jobs.find(job=>!job.finished).send();released++;await turn();}
  const result=await pending;assert.equal(peak,concurrency);assert.equal(active,0);assert.equal(requests.length,7);assert.deepEqual(new Uint8Array(await result.arrayBuffer()),source);
});

test('out-of-order ranges merge by byte offset with monotonic progress and the unchanged full-file SHA interface',async()=>{
  const source=Uint8Array.from([10,11,12,13,14,15]),jobs=[],progress=[];
  const pending=downloadTranscriptionBlob('https://example.test/model',{bytes:6,rangeBytes:2,concurrency:3,onProgress:value=>progress.push(value),fetchImpl:async(_url,options)=>{
    const {start,end}=interval(options),job=heldResponse(source.slice(start,end),options.signal);jobs[start/2]=job;return job.response;
  }});
  await until(()=>jobs.filter(Boolean).length===3);
  jobs[2].send();await until(()=>progress.some(value=>value.loaded===2));jobs[1].send();await until(()=>progress.some(value=>value.loaded===4));jobs[0].send();
  const blob=await pending;assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),source);assert.deepEqual(progress.map(value=>value.loaded),[0,2,4,6]);
  assert(progress.every(value=>value.loaded<=value.total));assert.equal(await sha256Blob(blob),createHash('sha256').update(source).digest('hex'));
});

test('one failing parallel segment resumes only its own suffix without repeating or double-counting another range',async()=>{
  const requests=[],progress=[],retried=deferred();let firstReads=0,other;
  const pending=downloadTranscriptionBlob('https://example.test/model',{bytes:8,rangeBytes:4,concurrency:2,onProgress:value=>progress.push(value),fetchImpl:async(_url,options)=>{
    requests.push(options.headers.Range);
    if(options.headers.Range==='bytes=0-3')return new Response(new ReadableStream({pull(controller){if(firstReads++===0)controller.enqueue(Uint8Array.of(0,1));else controller.error(new TypeError('range interrupted'));}}),{status:206});
    if(options.headers.Range==='bytes=2-3'){retried.resolve();return response([[2,3]],{status:206,length:2});}
    assert.equal(options.headers.Range,'bytes=4-7');other=heldResponse(Uint8Array.of(4,5,6,7),options.signal);return other.response;
  }});
  await retried.promise;other.send();const result=await pending;
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[0,1,2,3,4,5,6,7]);assert.deepEqual(requests,['bytes=0-3','bytes=4-7','bytes=2-3']);
  assert.equal(progress.at(-1).loaded,8);assert(progress.some(value=>value.retrying&&value.rangeIndex===0));assert(progress.every((value,i)=>i===0||value.loaded>=progress[i-1].loaded));
});

test('cancelling parallel stream reads aborts every request, closes streams and starts no queued range',async()=>{
  const abort=new AbortController(),jobs=[],requests=[],progress=[];let stopped=0;
  const pending=downloadTranscriptionBlob('https://example.test/model',{bytes:12,rangeBytes:3,concurrency:2,signal:abort.signal,onProgress:value=>progress.push(value),fetchImpl:async(_url,options)=>{
    requests.push(options);const job=heldResponse(Uint8Array.of(1,2,3),options.signal,()=>stopped++);jobs.push(job);return job.response;
  }});
  await until(()=>jobs.length===2);jobs[0].push([1]);await until(()=>progress.some(value=>value.loaded===1));abort.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(requests.length,2);assert(requests.every(options=>options.signal.aborted));assert.equal(stopped,2);assert.equal(progress.at(-1).loaded,1);
});

test('one terminal range error aborts all in-flight fetches and preserves that original error',async()=>{
  const requests=[];
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:12,rangeBytes:3,concurrency:2,fetchImpl:async(_url,options)=>{
    requests.push(options);if(options.headers.Range==='bytes=0-2')return response([],{status:403});return new Promise(()=>{});
  }}),error=>error.code==='MODEL_DOWNLOAD'&&error.message.includes('403'));
  assert.equal(requests.length,2);assert(requests.every(options=>options.signal.aborted));
});

test('a stalled fetch observes bounded idle retries and cancels its signals',async()=>{
  const requests=[];
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:4,concurrency:1,maxAttempts:2,idleTimeoutMs:5,fetchImpl:(_url,options)=>{requests.push(options);return new Promise(()=>{});}}),error=>error.code==='MODEL_NETWORK'&&error.message.includes('长时间'));
  assert.equal(requests.length,2);assert(requests.every(options=>options.signal.aborted));assert(requests.every(options=>options.headers.Range==='bytes=0-3'));
});

test('an exposed wrong Content-Range is rejected even when its byte count looks correct',async()=>{
  let calls=0;
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,concurrency:1,fetchImpl:async()=>{calls++;return new Response(Uint8Array.of(0,1,2),{status:206,headers:{'content-length':'3','content-range':'bytes 1-3/7'}});}}),{code:'MODEL_SIZE_MISMATCH'});
  assert.equal(calls,1);
});

for(const [size,expected]of [[6,['bytes=0-2','bytes=3-5']],[7,['bytes=0-2','bytes=3-5','bytes=6-6']]])test(`range boundaries handle ${size===6?'an exact multiple':'a one-byte final segment'}`,async()=>{
  const source=Uint8Array.from({length:size},(_,i)=>i),requests=[];
  const blob=await downloadTranscriptionBlob('https://example.test/model',{bytes:size,rangeBytes:3,concurrency:4,fetchImpl:async(_url,options)=>{requests.push(options.headers.Range);const {start,end}=interval(options);return response([[...source.slice(start,end)]],{status:206,length:end-start});}});
  assert.deepEqual(requests,expected);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),source);
});

test('a progress callback failure also shuts down the whole pool instead of retrying downloaded data',async()=>{
  const requests=[],other=deferred();let stopped=0;
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:6,rangeBytes:3,concurrency:2,onProgress:value=>{if(value.loaded)throw new Error('view removed');},fetchImpl:async(_url,options)=>{
    requests.push(options);if(options.headers.Range==='bytes=0-2'){await other.promise;return response([[0,1,2]],{status:206,length:3});}
    const job=heldResponse(Uint8Array.of(3,4,5),options.signal,()=>stopped++);other.resolve();return job.response;
  }}),{code:'MODEL_PROGRESS'});
  assert.equal(requests.length,2);assert(requests.every(options=>options.signal.aborted));assert.equal(stopped,1);
});
