#!/usr/bin/env node
/** Actual Rust/WASM CPU throughput measurement; not browser real-time acceptance. */
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {readFile, stat, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {cpus, platform, release, arch, availableParallelism, totalmem} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const SAMPLE_RATE = 48000;
const DEFAULT_WORKERS = Math.max(1, Math.min(14, availableParallelism() - 2));

function optionsFrom(args) {
  const options = {workers: DEFAULT_WORKERS, tracks: 10000, frames: 256, seconds: 30, warmupSeconds: 1, output: null};
  const numeric = new Map([['--workers','workers'],['--tracks','tracks'],['--frames','frames'],['--seconds','seconds'],['--warmup-seconds','warmupSeconds']]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return null;
    if (flag === '--output') { if (!args[++i]) throw new Error('--output requires a file path'); options.output = resolve(args[i]); }
    else if (numeric.has(flag)) { if (!args[++i]) throw new Error(`${flag} requires a value`); options[numeric.get(flag)] = Number(args[i]); }
    else throw new Error(`Unknown option: ${flag}`);
  }
  const ranges = [['workers',1,64,true],['tracks',1,10000,true],['frames',1,4096,true],['seconds',0.01,3600,false],['warmupSeconds',0,60,false]];
  for (const [key,min,max,integer] of ranges) if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max || (integer && !Number.isInteger(options[key]))) throw new Error(`${key} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
  if (options.workers > options.tracks) throw new Error('workers cannot exceed tracks');
  return options;
}

function nextMessage(worker) {
  return new Promise((resolveMessage,reject) => {
    const clean = () => { worker.off('message',message);worker.off('error',error);worker.off('exit',exit); };
    const message = value => { clean();resolveMessage(value); };
    const error = value => { clean();reject(value); };
    const exit = code => { clean();reject(new Error(`Worker exited before completing (code ${code})`)); };
    worker.once('message',message);worker.once('error',error);worker.once('exit',exit);
  });
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (!options) {
    console.log('Usage: node scripts/benchmark-dsp.mjs [--workers 14] [--tracks 10000] [--frames 256] [--seconds 30] [--warmup-seconds 1] [--output benchmarks/result.json]\nMeasures offline Rust/WASM throughput with every track active and independent nonzero reverb. This does not measure browser AudioWorklet deadlines or underruns.');
    return;
  }
  const startedAt = new Date().toISOString();
  const wasmURL = new URL('../wasm/nbs_dsp.wasm', import.meta.url);
  const [bytes,info] = await Promise.all([readFile(wasmURL),stat(wasmURL)]);
  const compileStart = performance.now();
  const wasm = await WebAssembly.compile(bytes);
  const compileMs = performance.now() - compileStart;
  const tasks = [];
  let trackStart = 0;
  const prepareStart = performance.now();
  try {
    for (let index = 0; index < options.workers; index++) {
      const tracks = Math.floor(options.tracks / options.workers) + (index < options.tracks % options.workers ? 1 : 0);
      const worker = new Worker(new URL(import.meta.url), {workerData:{...options,wasm,index,tracks,trackStart}});
      tasks.push(worker); trackStart += tracks;
    }
    const ready = await Promise.all(tasks.map(nextMessage));
    if (ready.some(value => value.phase !== 'ready')) throw new Error('Invalid worker preparation response');
    const prepareAndWarmupMs = performance.now() - prepareStart;
    const completion = tasks.map(nextMessage);
    const cpuStart = process.cpuUsage();
    const renderStart = performance.now();
    tasks.forEach(worker=>worker.postMessage({command:'run'}));
    const results = await Promise.all(completion);
    const wallMs = performance.now() - renderStart;
    const cpu = process.cpuUsage(cpuStart);
    const renderedFrames = Math.ceil(options.seconds * SAMPLE_RATE / options.frames) * options.frames;
    const simulatedAudioSeconds = renderedFrames / SAMPLE_RATE;
    const activeVoices = results.reduce((sum,worker)=>sum+worker.activeVoices,0);
    const droppedVoices = results.reduce((sum,worker)=>sum+worker.droppedVoices,0);
    const simd = ready.every(worker=>worker.simd);
    const allShardsNonzero = results.every(worker=>worker.lastBlockEnergy>0 && worker.allFinite);
    const fixedRenderMemory = results.every(worker=>worker.memoryBytesBefore===worker.memoryBytesAfter);
    const passed = activeVoices===options.tracks && droppedVoices===0 && simd && allShardsNonzero && fixedRenderMemory;
    const hardware = cpus();
    const report = {
      schemaVersion: 1,
      classification: 'offline Rust/WASM DSP CPU throughput; not browser real-time acceptance',
      passed,
      limitations: ['Includes worker dispatch/completion but excludes browser scheduling, AudioWorklet ring-buffer transport, device I/O, and editor/UI work.','Throughput factor is a capacity measurement, not evidence of zero underruns or a real-time latency guarantee.','No tracks or reverb groups are skipped: every configured track has an active looping PCM voice and nonzero independent reverb.'],
      startedAt, finishedAt: new Date().toISOString(),
      environment: {platform:platform(),release:release(),arch:arch(),cpuModel:hardware[0]?.model||'unknown',logicalProcessors:hardware.length,availableParallelism:availableParallelism(),totalMemoryBytes:totalmem(),node:process.versions.node,v8:process.versions.v8,execArgv:process.execArgv},
      wasm: {path:fileURLToPath(wasmURL),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),modifiedAt:info.mtime.toISOString(),compileMs,simd},
      configuration: {workers:options.workers,tracks:options.tracks,sampleRate:SAMPLE_RATE,blockFrames:options.frames,blockDurationMs:options.frames/SAMPLE_RATE*1000,requestedAudioSeconds:options.seconds,simulatedAudioSeconds,warmupSeconds:options.warmupSeconds,maxVoicesPerTrack:4,reverbPercentRange:[20,90],delayMilliseconds:[13,17,19,23],feedback:0.82,damping:0.45},
      preparation: {prepareAndWarmupMs},
      measurement: {wallMs,throughputFactor:simulatedAudioSeconds*1000/wallMs,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,averageUtilizedLogicalProcessors:(cpu.user+cpu.system)/1000/wallMs,maxWorkerRenderMs:results.reduce((max,worker)=>Math.max(max,worker.renderMs),0),sumWorkerRenderMs:results.reduce((sum,worker)=>sum+worker.renderMs,0),activeVoices,droppedVoices,allShardsNonzero,fixedRenderMemory,totalReverbBytes:ready.reduce((sum,worker)=>sum+worker.reverbBytes,0),totalWasmMemoryBytes:results.reduce((sum,worker)=>sum+worker.memoryBytesAfter,0)},
      workerResults: results.map((result,index)=>({...ready[index],...result})),
      outputFile:options.output,
    };
    if (options.output) { await mkdir(dirname(options.output),{recursive:true});await writeFile(options.output,JSON.stringify(report,null,2)+'\n'); }
    console.log(JSON.stringify(report,null,2));
    if (!passed) process.exitCode=2;
  } finally { await Promise.all(tasks.map(worker=>worker.terminate())); }
}

async function runWorker() {
  const {wasm,tracks,trackStart,frames,seconds,warmupSeconds,index}=workerData;
  const e=new WebAssembly.Instance(wasm,{}).exports;
  const handle=e.engine_create(tracks,SAMPLE_RATE,frames,tracks*4);
  if(!handle)throw new Error(`engine_create failed in worker ${index}`);
  const pointer=e.engine_sample_alloc(handle,0,SAMPLE_RATE);
  if(!pointer)throw new Error('PCM sample allocation failed');
  const pcm=new Float32Array(e.memory.buffer,pointer,SAMPLE_RATE);
  for(let i=0;i<SAMPLE_RATE;i++)pcm[i]=0.2*Math.sin(i/SAMPLE_RATE*Math.PI*2*440)+0.05*Math.sin(i/SAMPLE_RATE*Math.PI*2*660);
  let configuredTracks=0,nonzeroReverbTracks=0;
  for(let track=0;track<tracks;track++){
    const global=trackStart+track;
    const reverb=0.2+(global%101)*0.007;
    if(!e.engine_track(handle,track,0.7+(global%11)*0.03,(global%17-8)/10,reverb,1))throw new Error(`Track ${global} configuration failed`);
    configuredTracks++;if(reverb>0)nonzeroReverbTracks++;
    if(!e.engine_voice(handle,track,0,2**((global%24-12)/12),0.0008+(global%7)*0.00005,(global%9-4)/20,(global*13)%frames,1))throw new Error(`Track ${global} voice allocation failed`);
  }
  const warmupBlocks=Math.ceil(warmupSeconds*SAMPLE_RATE/frames);
  for(let i=0;i<warmupBlocks;i++)e.engine_render(handle);
  const memoryBytesBefore=e.memory.buffer.byteLength;
  parentPort.postMessage({phase:'ready',index,tracks,trackStart,configuredTracks,nonzeroReverbTracks,warmupBlocks,reverbBytes:e.engine_reverb_bytes(handle),simd:Boolean(e.engine_wasm_simd()),memoryBytesBefore});
  parentPort.once('message',({command})=>{
    if(command!=='run')throw new Error('Invalid benchmark worker command');
    const blocks=Math.ceil(seconds*SAMPLE_RATE/frames);
    let pointer=0;
    const start=performance.now();
    for(let block=0;block<blocks;block++)pointer=e.engine_render(handle);
    const renderMs=performance.now()-start;
    const out=new Float32Array(e.memory.buffer,pointer,frames*2);
    let lastBlockEnergy=0,allFinite=true;
    for(const value of out){lastBlockEnergy+=value*value;if(!Number.isFinite(value))allFinite=false;}
    const result={phase:'done',index,tracks,renderedBlocks:blocks,renderMs,activeVoices:e.engine_active_voices(handle),droppedVoices:e.engine_dropped_voices(handle),peak:e.engine_peak(handle),lastBlockEnergy,allFinite,memoryBytesBefore,memoryBytesAfter:e.memory.buffer.byteLength};
    parentPort.postMessage(result);e.engine_destroy(handle);
  });
}

if(isMainThread) await main(); else await runWorker();
