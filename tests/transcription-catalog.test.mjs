import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {getTranscriptionDownloadInfo} from '../js/transcription-catalog.js';
import {validateTranscriptionManifest} from '../js/transcription-model-store.js';

test('both downloadable models have complete small graph packages and no hosted large weights',async()=>{
  for(const [variant,bytes]of [['small',411888600],['medium',1228144472]]){
    const info=getTranscriptionDownloadInfo(variant);assert.equal(info.available,true);assert.equal(info.bytes,bytes);
    const url=new URL(info.url);assert.equal(url.origin,'https://www.modelscope.cn');assert.equal(url.pathname,`/models/MuScriptor/muscriptor-${variant}/resolve/master/model.safetensors`);assert.match(info.sha256,/^[a-f0-9]{64}$/);
    const manifest=JSON.parse(await readFile(new URL(info.packageURL),'utf8')),template=manifest.runtimeTemplate,derived=manifest.derivedAssets[0];
    assert.equal(manifest.kind,'nbs-muscriptor-source-onnx');assert.equal(template.variant,variant);assert.equal(template.testOnly,false);
    validateTranscriptionManifest({...template,files:[...template.files,{...derived,sha256:'0'.repeat(64)}]});
    const files=await readdir(new URL('./',info.packageURL));assert.deepEqual(files.sort(),['model.json',...template.files.map(file=>file.path),...(template.preprocessingRevision===2?['window.f32','mel-filter.f32']:[])].sort());
    let size=0;
    for(const file of template.files){
      assert.doesNotMatch(file.path,/\.(?:bin|safetensors)$/);const payload=await readFile(new URL(file.path,info.packageURL));
      assert.equal(payload.length,file.bytes);assert.equal(createHash('sha256').update(payload).digest('hex'),file.sha256);size+=file.bytes;
    }
    assert(size<4*1024*1024,'public graph metadata remains small');
    const map=JSON.parse(await readFile(new URL(manifest.mapping,info.packageURL),'utf8'));let covered=0;
    for(const segment of map.segments){assert.equal(segment.offset,covered);assert.ok(map.source.tensors[segment.sourceKey]);covered+=segment.bytes;}
    assert.equal(covered,derived.bytes);assert.equal(covered,map.target.bytes);
  }
});
test('external-only or unknown models cannot silently start a built-in download',()=>{
  for(const variant of ['large','unknown','__proto__','toString'])assert.equal(getTranscriptionDownloadInfo(variant).available,false);
});
