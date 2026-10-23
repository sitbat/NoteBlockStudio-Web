// Node adapter exercises the exact browser worker module against the shipped Wasm.
import {parentPort} from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.postMessage = value => parentPort.postMessage(value);
globalThis.close = () => process.exit(0);
await import('../js/dsp-worker.js');
parentPort.on('message', data => globalThis.onmessage({data}));
