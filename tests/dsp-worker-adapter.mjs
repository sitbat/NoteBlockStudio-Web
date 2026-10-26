// Node adapter exercises the exact browser worker module against the shipped Wasm.
import {parentPort} from 'node:worker_threads';
const NativeInstance = WebAssembly.Instance;
let memory;
// Test-only heap telemetry proves live PCM copies exercise memory-view rebinding.
WebAssembly.Instance = class extends NativeInstance {
  constructor(...args) { super(...args); memory = this.exports.memory; }
};
globalThis.self = globalThis;
globalThis.postMessage = value => parentPort.postMessage(['ready', 'sampleLoaded'].includes(value.type) ? {...value, testMemoryBytes: memory.buffer.byteLength} : value);
globalThis.close = () => process.exit(0);
await import('../js/dsp-worker.js');
parentPort.on('message', data => globalThis.onmessage({data}));
