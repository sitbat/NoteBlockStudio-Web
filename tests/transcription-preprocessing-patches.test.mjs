import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {TRANSCRIPTION_PREPROCESSING_PATCHES} from '../js/transcription-preprocessing-patches.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const checkpoint={window:{bytes:8192,sha256:'0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b'},melFilter:{bytes:2099200,sha256:'a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb'}};
test('both official variants use exact saved checkpoint coefficients and retain narrow legacy fingerprints',async()=>{
  assert.equal(TRANSCRIPTION_PREPROCESSING_PATCHES.length,2);
  for(const patch of TRANSCRIPTION_PREPROCESSING_PATCHES){
    assert.equal(patch.version,2);assert.equal(patch.modelId,`muscriptor-${patch.variant}-fp32-source`);assert.match(patch.source.sha256,/^[a-f0-9]{64}$/);
    const base=new URL(`../assets/transcription/${patch.variant}/`,import.meta.url),source=JSON.parse(await readFile(new URL('model.json',base),'utf8')),model=source.runtimeTemplate;
    assert.equal(model.preprocessingRevision,2);assert.equal(model.preprocessingVersion,2);assert.deepEqual(model.preprocessing,patch.preprocessing);
    assert.deepEqual((await readdir(base)).sort(),['model.json',...source.files.map(file=>file.path),...Object.values(patch.expected.preprocessing).map(file=>file.path)].sort(),'only the two checksum-checked legacy coefficients remain outside fresh install files');
    for(const role of ['window','melFilter']){
      const file=patch.files.find(file=>file.path===patch.preprocessing[role]),raw=await readFile(new URL(file.url)),expected=checkpoint[role];
      assert.equal(raw.length,expected.bytes);assert.equal(file.bytes,expected.bytes);assert.equal(sha(raw),expected.sha256);assert.equal(file.sha256,expected.sha256);
      assert.equal(model.files.find(entry=>entry.path===file.path).sha256,file.sha256);assert(!model.files.some(entry=>entry.path===patch.expected.preprocessing[role].path),'fresh installs never download unused legacy coefficients');
      const old=patch.expected.preprocessing[role],oldBytes=await readFile(new URL(old.path,base));assert.equal(sha(oldBytes),old.sha256);assert.notEqual(old.sha256,file.sha256,'the migration must not silently reuse regenerated math coefficients');
    }
    for(const [role,file]of Object.entries(patch.expected.graphs)){assert.equal(model.graphs[role],file.path);assert.equal(sha(await readFile(new URL(file.path,base))),file.sha256);}
    assert.equal(sha(await readFile(new URL(patch.expected.mapping.path,base))),patch.expected.mapping.sha256);
  }
});
