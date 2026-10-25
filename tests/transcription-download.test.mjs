import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloadTranscriptionBlob,sha256Blob} from '../js/transcription-download.js';

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
  const result=await downloadTranscriptionBlob('https://example.test/model',{bytes:13,rangeBytes:5,onProgress:p=>progress.push(p),fetchImpl:async(url,options)=>{
    requests.push(options.headers.Range);const [,first,last]=options.headers.Range.match(/bytes=(\d+)-(\d+)/),data=source.slice(+first,+last+1);
    return response([[...data]],{status:206,length:data.length});
  }});
  assert.deepEqual(requests,['bytes=0-4','bytes=5-9','bytes=10-12']);assert.deepEqual(new Uint8Array(await result.arrayBuffer()),source);
  assert.deepEqual(progress.map(p=>p.loaded),[0,5,10,13]);
});

test('an interrupted range retains received bytes and retries only its missing suffix',async()=>{
  const requests=[],progress=[];let reads=0;
  const result=await downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:4,onProgress:p=>progress.push(p),fetchImpl:async(url,options)=>{
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
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,maxAttempts:3,fetchImpl:async()=>{calls++;throw new TypeError('network error');}}),{code:'MODEL_NETWORK'});assert.equal(calls,3);
  calls=0;await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,fetchImpl:async()=>{calls++;return response([[1,2,3,4,5,6,7]],{status:200,length:7});}}),{code:'MODEL_DOWNLOAD'});assert.equal(calls,1);
});

test('a byte range that returns too little or too much is never silently accepted',async()=>{
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,maxAttempts:1,fetchImpl:async()=>response([[1,2]],{status:206,length:3})}),{code:'MODEL_NETWORK'});
  await assert.rejects(downloadTranscriptionBlob('https://example.test/model',{bytes:7,rangeBytes:3,fetchImpl:async()=>response([[1,2,3,4]],{status:206})}),{code:'MODEL_SIZE_MISMATCH'});
});
