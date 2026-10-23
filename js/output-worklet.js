import {GLOBAL, HEADER, RUNNING} from './dsp-protocol.js';

/** Only mixes already computed shard PCM; never waits for a worker. */
export class NBSOutputProcessor extends (globalThis.AudioWorkletProcessor || class {}) {
  constructor(options = {}) {
    super();
    const {global, rings, blockFrames} = options.processorOptions;
    this.control = new Int32Array(global);
    this.blockFrames = blockFrames;
    this.rings = rings.map(ring => ({header: new Int32Array(ring.header), stamps: new Int32Array(ring.stamps), pcm: new Float32Array(ring.pcm), slots: ring.slots}));
    this.ready = new Uint8Array(rings.length);
    this.sequence = 0; this.offset = 0; this.epoch = -1; this.limiterGain = 1;
    const rate = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.release = 1 - Math.exp(-1 / (rate * .05));
  }
  process(_inputs, outputs) {
    const left = outputs[0]?.[0], right = outputs[0]?.[1];
    if (!left) return true;
    left.fill(0); right?.fill(0);
    if (Atomics.load(this.control, GLOBAL.MODE) !== RUNNING) {
      Atomics.store(this.control, GLOBAL.OUTPUT_PEAK, 0); Atomics.store(this.control, GLOBAL.OUTPUT_RMS, 0); return true;
    }
    const epoch = Atomics.load(this.control, GLOBAL.EPOCH);
    const mono = Atomics.load(this.control, GLOBAL.MONO) !== 0;
    if (epoch !== this.epoch) { this.epoch = epoch; this.sequence = 0; this.offset = 0; this.limiterGain = 1; }
    let out = 0, peakOutput = 0, energy = 0;
    while (out < left.length) {
      if (this.offset === 0) {
        let missing = false;
        for (let i = 0; i < this.rings.length; i++) {
          const ring = this.rings[i];
          this.ready[i] = Atomics.load(ring.stamps, this.sequence % ring.slots) === this.sequence + 1 ? 1 : 0;
          if (!this.ready[i]) { missing = true; Atomics.add(ring.header, HEADER.UNDERRUNS, 1); }
        }
        if (missing) Atomics.add(this.control, GLOBAL.UNDERRUNS, 1);
      }
      const count = Math.min(left.length - out, this.blockFrames - this.offset);
      for (let i = 0; i < this.rings.length; i++) {
        if (!this.ready[i]) continue;
        const ring = this.rings[i], base = this.sequence % ring.slots * this.blockFrames * 2 + this.offset;
        for (let frame = 0; frame < count; frame++) {
          left[out + frame] += ring.pcm[base + frame];
          if (right) right[out + frame] += ring.pcm[base + this.blockFrames + frame];
        }
      }
      for (let frame = out; frame < out + count; frame++) {
        let l = left[frame], r = right ? right[frame] : l;
        if (!Number.isFinite(l)) l = 0; if (!Number.isFinite(r)) r = 0;
        if (mono) l = r = (l + r) * .5;
        const peak = Math.max(Math.abs(l), Math.abs(r));
        const target = Math.min(1, .98 / Math.max(peak, .000001));
        this.limiterGain = target < this.limiterGain ? target : this.limiterGain + (1 - this.limiterGain) * this.release;
        left[frame] = Math.max(-1, Math.min(1, l * this.limiterGain));
        if (right) right[frame] = Math.max(-1, Math.min(1, r * this.limiterGain));
        peakOutput = Math.max(peakOutput, Math.abs(left[frame]), Math.abs(right ? right[frame] : left[frame]));
        energy += left[frame] * left[frame] + (right ? right[frame] * right[frame] : left[frame] * left[frame]);
      }
      out += count; this.offset += count;
      if (this.offset === this.blockFrames) {
        this.offset = 0; this.sequence++;
        Atomics.store(this.control, GLOBAL.READ, this.sequence);
        for (const ring of this.rings) { Atomics.add(ring.header, HEADER.WAKE, 1); Atomics.notify(ring.header, HEADER.WAKE, 1); }
      }
    }
    Atomics.store(this.control, GLOBAL.OFFSET, this.offset);
    Atomics.add(this.control, GLOBAL.QUANTA, 1);
    Atomics.store(this.control, GLOBAL.OUTPUT_PEAK, Math.round(peakOutput * 1000000));
    Atomics.store(this.control, GLOBAL.OUTPUT_RMS, Math.round(Math.sqrt(energy / (left.length * 2)) * 1000000));
    return true;
  }
}
if (typeof registerProcessor === 'function') registerProcessor('nbs-wasm-output', NBSOutputProcessor);
