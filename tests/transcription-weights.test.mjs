import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {readSafetensorsHeader,adaptTranscriptionWeights} from '../js/transcription-weights.js';

const words=values=>new Uint32Array(values);
const bytes=async blob=>new Uint8Array(await blob.arrayBuffer());
function container(header,data=new Uint8Array()){
  const raw=new TextEncoder().encode(typeof header==='string'?header:JSON.stringify(header));
  const prefix=new Uint8Array(8);new DataView(prefix.buffer).setBigUint64(0,BigInt(raw.length),true);
  return new Blob([prefix,raw,data]);
}
function safetensors(entries){
  const header={__metadata__:{format:'pt'}},chunks=[];let offset=0;
  for(const [key,shape,data]of entries){header[key]={dtype:'F32',shape,data_offsets:[offset,offset+data.byteLength]};chunks.push(data);offset+=data.byteLength;}
  return container(header,new Blob(chunks));
}
const source=(shape,aliases=[])=>({shape,dtype:'F32',aliases});
const segment=(sourceKey,sourceShape,op,shape,offset=0,extra={})=>({sourceKey,sourceShape,sourceDtype:'F32',targetDtype:'F32',op,shape,offset,bytes:shape.reduce((a,b)=>a*b,1)*4,...extra});
const mapping=(tensors,segments,targetBytes=segments.reduce((sum,item)=>sum+item.bytes,0))=>({kind:'nbs-muscriptor-weight-map',version:1,source:{tensors},target:{path:'weights.bin',bytes:targetBytes},segments});
const invalid=error=>error?.code==='MODEL_WEIGHT_LAYOUT';
const immediate={yieldTask:async()=>{}};

test('safetensors parser reads only the index and validates the complete packed data extent',async()=>{
  const file=safetensors([['a',[2,2],words([1,2,3,4])],['b',[1],words([5])]]);
  const parsed=await readSafetensorsHeader(file);
  assert.deepEqual(parsed.tensors.a,{dtype:'F32',shape:[2,2],data_offsets:[0,16]});
  assert.deepEqual(parsed.tensors.b.data_offsets,[16,20]);assert.equal(parsed.dataOffset+20,file.size);
  assert.deepEqual(await bytes(file.slice(parsed.dataOffset)),new Uint8Array(words([1,2,3,4,5]).buffer));
});

test('copy, flattened slice and 2D transpose produce exact destination bytes in map order',async()=>{
  // Include negative zero, infinity and a NaN payload: adaptation must preserve bits.
  const raw=words([0x80000000,0x7f800000,0x7fc01234,0x3f800000,0x40000000,0xbf800000]);
  const file=safetensors([['emb.0.weight',[2,3],raw],['out_norm.bias',[2],words([0x12345678,0x87654321])]]);
  const map=mapping({'emb.weight':source([2,3],['emb.0.weight']),'out_norm.bias':source([2])},[
    segment('out_norm.bias',[2],'copy',[2]),
    segment('emb.weight',[2,3],'slice',[3],8,{slice:{start:1,count:3}}),
    segment('emb.weight',[2,3],'transpose2d',[3,2],20),
  ]);
  const progress=[],before=await bytes(file),out=await adaptTranscriptionWeights(file,map,{...immediate,onProgress:value=>progress.push(value)});
  const actual=new Uint32Array(await out.arrayBuffer());
  assert.deepEqual(actual,words([0x12345678,0x87654321,raw[1],raw[2],raw[3],raw[0],raw[3],raw[1],raw[4],raw[2],raw[5]]));
  assert.equal(out.size,44);assert.equal(out.type,'application/octet-stream');assert.deepEqual(await bytes(file),before);
  assert.deepEqual(progress.map(item=>item.loaded),[0,8,20,44]);assert(progress.every(item=>item.total===44&&item.stage==='convert'));
});

test('canonical tensor keys and one recognized alias have identical binary semantics',async()=>{
  const map=mapping({'linear.weight':source([2],['linears.0.weight'])},[segment('linear.weight',[2],'copy',[2])]);
  for(const key of ['linear.weight','linears.0.weight']){
    const output=await adaptTranscriptionWeights(safetensors([[key,[2],words([1,0xffffffff])]]),map,immediate);
    assert.deepEqual(new Uint32Array(await output.arrayBuffer()),words([1,0xffffffff]));
  }
  await assert.rejects(adaptTranscriptionWeights(safetensors([['linear.weight',[2],words([1,2])],['linears.0.weight',[2],words([3,4])]]),map,immediate),invalid);
  await assert.rejects(adaptTranscriptionWeights(safetensors([['unrelated',[2],words([1,2])]]),map,immediate),invalid);
});

test('shape and dtype must agree between indexed source, source map and every output segment',async()=>{
  const file=safetensors([['a',[2,2],words([1,2,3,4])]]),valid=mapping({a:source([2,2])},[segment('a',[2,2],'copy',[2,2])]);
  for(const mutate of [map=>map.source.tensors.a.shape=[4],map=>map.source.tensors.a.dtype='F16',map=>map.source.tensors.a.aliases=[5],map=>map.segments[0].sourceShape=[4],map=>map.segments[0].sourceDtype='F16',map=>map.segments[0].targetDtype='F16',map=>map.segments[0].shape=[4]]){
    const map=structuredClone(valid);mutate(map);await assert.rejects(adaptTranscriptionWeights(file,map,immediate),invalid);
  }
});

test('invalid safetensors dtype, shape, intervals, gaps and trailing bytes are rejected',async()=>{
  const base={dtype:'F32',shape:[2],data_offsets:[0,8]},data=new Uint8Array(16);
  for(const header of [
    {a:{...base,dtype:'F16'}},
    {a:{...base,shape:[0]}},
    {a:{...base,shape:[1.5]}},
    {a:{...base,shape:[Number.MAX_SAFE_INTEGER,2]}},
    {a:{...base,data_offsets:[0,7]}},
    {a:{...base,data_offsets:[-1,7]}},
    {a:{...base,data_offsets:[0,20]}},
    {a:base,b:{...base,data_offsets:[4,12]}},
    {a:base,b:{...base,data_offsets:[12,20]}},
  ])await assert.rejects(readSafetensorsHeader(container(header,data)),invalid);
  await assert.rejects(readSafetensorsHeader(container({a:base},data)),invalid,'unindexed trailing data');
});

test('truncated, excessive, malformed UTF-8 and non-object header JSON are rejected',async()=>{
  const excessive=new Uint8Array(10);new DataView(excessive.buffer).setBigUint64(0,1024n*1024n+1n,true);
  for(const value of [new Blob(),new Blob([excessive]),container('{bad'),container('null'),container('[]'),container('1')])await assert.rejects(readSafetensorsHeader(value),invalid);
  const prefix=new Uint8Array(8);new DataView(prefix.buffer).setBigUint64(0,2n,true);
  await assert.rejects(readSafetensorsHeader(new Blob([prefix,Uint8Array.of(0xc0,0xaf)])),invalid);
  const truncated=new Uint8Array(10);new DataView(truncated.buffer).setBigUint64(0,20n,true);
  await assert.rejects(readSafetensorsHeader(new Blob([truncated])),invalid);
});

test('destination offsets must be contiguous and cover exactly the declared output',async()=>{
  const file=safetensors([['a',[2],words([1,2])]]),valid=mapping({a:source([2])},[segment('a',[2],'copy',[2])]);
  for(const mutate of [map=>map.segments[0].offset=1,map=>map.segments[0].bytes=4,map=>map.target.bytes=12,map=>map.target.bytes=4,map=>map.target.path='../weights.bin',map=>map.target.bytes=1800*1024*1024+1,map=>map.version=2,map=>map.segments=[]]){
    const map=structuredClone(valid);mutate(map);await assert.rejects(adaptTranscriptionWeights(file,map,immediate),invalid);
  }
  const overlapping=mapping({a:source([2])},[segment('a',[2],'copy',[2]),segment('a',[2],'copy',[2])]);
  await assert.rejects(adaptTranscriptionWeights(file,overlapping,immediate),invalid);
});

test('slice cannot read outside the source or misrepresent the output element count',async()=>{
  const file=safetensors([['a',[4],words([1,2,3,4])]]);
  for(const range of [{start:-1,count:2},{start:3,count:2},{start:.5,count:2},{start:0,count:0},{start:0,count:1}]){
    const map=mapping({a:source([4])},[segment('a',[4],'slice',[2],0,{slice:range})]);
    await assert.rejects(adaptTranscriptionWeights(file,map,immediate),invalid);
  }
});

test('unsupported operation and non-2D or incorrectly shaped transpose cannot execute',async()=>{
  const file=safetensors([['a',[2,2],words([1,2,3,4])]]);
  for(const op of ['eval','reshape','transpose3d',''])await assert.rejects(adaptTranscriptionWeights(file,mapping({a:source([2,2])},[segment('a',[2,2],op,[2,2])]),immediate),invalid);
  await assert.rejects(adaptTranscriptionWeights(file,mapping({a:source([2,2])},[segment('a',[2,2],'transpose2d',[4])]),immediate),invalid);
  await assert.rejects(adaptTranscriptionWeights(safetensors([['a',[4],words([1,2,3,4])]]),mapping({a:source([4])},[segment('a',[4],'transpose2d',[4])]),immediate),invalid);
});

test('pre-cancellation reads no source bytes and mid-conversion cancellation returns no partial blob',async()=>{
  const before=new AbortController();before.abort();let slices=0;
  class ObservedBlob extends Blob{slice(...args){slices++;return super.slice(...args);}}
  await assert.rejects(adaptTranscriptionWeights(new ObservedBlob(['not even a model']),{}, {signal:before.signal}),{name:'AbortError'});assert.equal(slices,0);
  const during=new AbortController(),progress=[],file=safetensors([['a',[2],words([1,2])]]);
  const map=mapping({a:source([2])},[segment('a',[2],'copy',[2]),segment('a',[2],'copy',[2],8)]);
  await assert.rejects(adaptTranscriptionWeights(file,map,{signal:during.signal,onProgress:value=>progress.push(value.loaded),yieldTask:async()=>during.abort()}),{name:'AbortError'});
  assert.deepEqual(progress,[0,8]);
});

test('large row transposes yield to cancellation and preserve integer bit patterns',async()=>{
  const input=Uint32Array.from({length:512},(_,index)=>index),file=safetensors([['a',[256,2],input]]),map=mapping({a:source([256,2])},[segment('a',[256,2],'transpose2d',[2,256])]);
  const controller=new AbortController();let yields=0;
  await assert.rejects(adaptTranscriptionWeights(file,map,{signal:controller.signal,yieldTask:async()=>{yields++;controller.abort();}}),{name:'AbortError'});assert.equal(yields,1);
  const out=new Uint32Array(await(await adaptTranscriptionWeights(file,map,immediate)).arrayBuffer());
  for(let row=0;row<256;row++){assert.equal(out[row],row*2);assert.equal(out[row+256],row*2+1);}
});

const sourceFixture=process.env.NBS_TRANSCRIPTION_SOURCE_FIXTURE;
test('exporter-generated untrained safetensors rebuilds every ONNX external-weight byte exactly',{skip:!sourceFixture},async t=>{
  const root=path.resolve(sourceFixture),source=new Blob([readFileSync(path.join(root,'source.safetensors'))]),map=JSON.parse(readFileSync(path.join(root,'template/source-map.json'),'utf8'));
  const expected=readFileSync(path.join(root,'source.weights.bin')),pythonRebuild=readFileSync(path.join(root,'source.rebuilt.bin'));
  assert.deepEqual(pythonRebuild,expected,'independent Python reconstruction agrees with ONNX exporter data');
  const actual=await bytes(await adaptTranscriptionWeights(source,map,immediate));
  assert.equal(actual.length,expected.length);assert.deepEqual(actual,new Uint8Array(expected));
  const sha256=createHash('sha256').update(actual).digest('hex');assert.equal(sha256,createHash('sha256').update(expected).digest('hex'));
  t.diagnostic(`${actual.length} bytes, SHA-256 ${sha256}; this validates layout adaptation, not musical recognition`);
});
