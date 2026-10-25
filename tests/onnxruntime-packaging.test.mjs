import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const folder=new URL('../vendor/onnxruntime/',import.meta.url);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('ORT browser modules use JavaScript MIME-compatible .js URLs including worker defaults',async()=>{
  const files=await readdir(folder),metadata=JSON.parse(await readFile(new URL('VERSION.json',folder),'utf8'));
  assert.equal(metadata.version,'1.30.0');assert.equal(metadata.localPackaging.runtimeMathChanged,false);
  assert(!files.some(file=>file.endsWith('.mjs')),'no published runtime module depends on .mjs MIME support');
  assert(files.includes('ort.all.min.js'));assert(files.includes('ort-wasm-simd-threaded.jsep.js'));
  for(const file of metadata.files){const bytes=await readFile(new URL(file.path,folder));assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);}
  const main=await readFile(new URL('ort.all.min.js',folder),'utf8');
  assert(main.includes('"ort.all.min.js"'));assert(main.includes('"ort-wasm-simd-threaded.jsep.js"'));
  assert.doesNotMatch(main,/["']ort\.all\.min\.mjs["']|["']ort-wasm-simd-threaded\.jsep\.mjs["']/);
  let upstream=main;
  for(const [oldName,newName]of Object.entries(metadata.localPackaging.loaderStringReplacements))upstream=upstream.replace('"'+newName+'"','"'+oldName+'"');
  assert.equal(sha(upstream),metadata.files.find(file=>file.path==='ort.all.min.js').upstreamSHA256,'only the two loader filename literals differ from the pinned upstream main bundle');
  const helper=await readFile(new URL('ort-wasm-simd-threaded.jsep.js',folder));
  assert.equal(sha(helper),metadata.files.find(file=>file.path==='ort-wasm-simd-threaded.jsep.js').upstreamSHA256,'pthread helper bytes remain unmodified');
  assert(helper.toString().includes('new Worker(new URL(import.meta.url)'),'pthread workers use the renamed helper URL itself');
  const runtime=await readFile(new URL('../js/muscriptor-onnx.js',import.meta.url),'utf8');
  assert.match(runtime,/wasmPaths=\{mjs:new URL\('\.\.\/vendor\/onnxruntime\/ort-wasm-simd-threaded\.jsep\.js'/);
  assert.match(runtime,/wasm:new URL\('\.\.\/vendor\/onnxruntime\/ort-wasm-simd-threaded\.jsep\.wasm'/);
});

// The pinned browser bundle's cross-origin preloader does not support Node
// file:// fetch for multithread mode. Test the actual Emscripten pthread helper
// directly here; its initialization waits for the spawned renamed .js worker.
test('renamed upstream helper starts a real two-thread WASM runtime', {timeout:30000},async t=>{
  const {default:createModule}=await import('../vendor/onnxruntime/ort-wasm-simd-threaded.jsep.js');
  const module=await createModule({numThreads:2,locateFile:()=>new URL('ort-wasm-simd-threaded.jsep.wasm',folder).href});
  assert.equal(module.numThreads,2);assert.equal(module._OrtInit(2,2),0);
  t.diagnostic('Actual renamed .js Emscripten helper and its self-URL pthread worker initialized; native OrtInit(2) returned success.');
});
