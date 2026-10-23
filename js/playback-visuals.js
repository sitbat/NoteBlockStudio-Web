const KEY_COUNT = 88;
const EXACT_CYCLE_LIMIT = 1024;
const NON_PIANO_INSTRUMENTS = new Set([2, 3, 4]);

/** The original keyboard press flag affects the piano, never the note's own animation. */
export function pressesPiano(note, song, {playerMode = false} = {}) {
  if (!note) return false;
  if (playerMode) return true;
  const instrument = Number(note.instrument ?? 0);
  return instrument < 16 ? !NON_PIANO_INSTRUMENTS.has(instrument) : !!song?.customInstruments?.[instrument - 16]?.pressKey;
}

function lastAtFrame(ticks, origin, framesPerTick, frame) {
  let low = 0, high = ticks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Math.round(origin + ticks[middle] * framesPerTick) <= frame) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** Rebuild is the only operation that reads song layers/notes; sample performs at most 88 searches. */
export class PlaybackVisuals {
  constructor(song, options = {}) {
    this.keyAges = new Float64Array(KEY_COUNT);
    this.rebuild(song, options);
  }

  rebuild(song = {}, {playerMode = false} = {}) {
    this.playerMode = !!playerMode;
    this._noteTicks = new WeakMap();
    const sets = Array.from({length: KEY_COUNT}, () => new Set()), layers = song.layers || [];
    const solo = layers.some(layer => layer.solo);
    const audible = layers.map(layer => !layer.muted && (!solo || layer.solo) && Number(layer.volume ?? 100) > 0);
    for (const note of song.notes || []) {
      if (!note || !audible[note.layer] || !(Number(note.velocity ?? 100) > 0)) continue;
      const tick = Number(note.tick), key = Number(note.key);
      if (!Number.isFinite(tick) || tick < 0 || !Number.isInteger(key) || key < 0 || key >= KEY_COUNT) continue;
      this._noteTicks.set(note, tick);
      if (pressesPiano(note, song, {playerMode: this.playerMode})) sets[key].add(tick);
    }
    this.keyTicks = sets.map(ticks => Float64Array.from([...ticks].sort((a, b) => a - b)));
    this.clear();
    return this;
  }

  clear() {
    this.keyAges.fill(Infinity);
    this._config = null; this._cycle = null; this._previous = null; this._initial = null; this._snapshot = null;
    return this;
  }

  _resetCycles(config) {
    this._config = config;
    this._initial = {index: 0, origin: config.startFrame - config.fromTick * config.framesPerTick,
      end: config.startFrame + (config.length - config.fromTick) * config.framesPerTick, minimum: config.fromTick};
    this._cycle = this._initial; this._previous = null;
  }

  _trigger(tick, cycle) {
    const c = this._config, frame = this._snapshot.frame;
    if (!cycle || tick < cycle.minimum || tick >= c.length) return -Infinity;
    const trigger = Math.round(cycle.origin + tick * c.framesPerTick);
    return trigger <= frame && trigger < Math.round(cycle.end) ? trigger : -Infinity;
  }

  _completedTrigger(tick) {
    return Math.max(this._trigger(tick, this._previous), this._trigger(tick, this._initial));
  }

  _fastForward(frame) {
    const c = this._config, period = (c.length - c.loopStart) * c.framesPerTick;
    if (!Number.isFinite(period) || period <= 0) return false;
    // round(onset) <= frame iff onset < floor(frame) + 0.5. ceil preserves
    // the strict half-frame boundary without subtracting a floating epsilon.
    let index = Math.max(0, Math.ceil((Math.floor(frame) + 0.5 - this._initial.end) / period));
    if (c.loopCount) index = Math.min(index, c.loopCount);
    if (!Number.isSafeInteger(index)) return false;
    const cycleAt = count => {
      if (count === 0) return this._initial;
      const origin = this._initial.end + (count - 1) * period - c.loopStart * c.framesPerTick;
      return {index: count, origin, end: origin + c.length * c.framesPerTick, minimum: c.loopStart};
    };
    this._cycle = cycleAt(index);
    this._previous = index > 0 ? cycleAt(index - 1) : null;
    return Number.isFinite(this._cycle.origin) && Number.isFinite(this._cycle.end);
  }

  sample({playing, frame, sampleRate, transport} = {}) {
    if (!playing || !Number.isFinite(frame) || frame < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !transport) { this.clear(); return this.keyAges; }
    const next = {startFrame: Number(transport.startFrame ?? 0), framesPerTick: Number(transport.framesPerTick), fromTick: Number(transport.fromTick),
      length: Number(transport.length), loopStart: Number(transport.loopStart), loop: !!transport.loop, loopCount: Number(transport.loopCount) || 0};
    if (![next.startFrame, next.framesPerTick, next.fromTick, next.length, next.loopStart, next.loopCount].every(Number.isFinite) || next.framesPerTick <= 0 || next.length <= 0 || next.fromTick < 0 || next.fromTick >= next.length || next.loopStart < 0 || next.loopStart >= next.length || next.loopCount < 0) { this.clear(); return this.keyAges; }
    const changed = !this._config || Object.keys(next).some(key => next[key] !== this._config[key]);
    if (changed || frame < (this._snapshot?.frame ?? 0)) this._resetCycles(next);
    this._snapshot = {frame, sampleRate};
    // Ordinary frames keep EventTimeline's exact floating-point recurrence.
    // After a very long background gap, skip arithmetically instead of allocating
    // millions of cycles. This visual-only shortcut can differ by a sample at
    // a rounding boundary from the worker's accumulated floating-point values.
    const shouldAdvance = () => next.loop && (!next.loopCount || this._cycle.index < next.loopCount) && Math.round(this._cycle.end) <= frame;
    let advanced = 0;
    while (advanced < EXACT_CYCLE_LIMIT && shouldAdvance()) {
      this._previous = this._cycle;
      const origin = this._cycle.end - next.loopStart * next.framesPerTick;
      this._cycle = {index: this._cycle.index + 1, origin, end: origin + next.length * next.framesPerTick, minimum: next.loopStart};
      advanced++;
    }
    if (shouldAdvance() && !this._fastForward(frame)) { this.clear(); return this.keyAges; }
    const cycle = this._cycle, fence = Math.min(frame, Math.round(cycle.end) - 1);
    for (let key = 0; key < KEY_COUNT; key++) {
      const ticks = this.keyTicks[key];
      if (!ticks.length) { this.keyAges[key] = Infinity; continue; }
      const index = lastAtFrame(ticks, cycle.origin, next.framesPerTick, fence);
      const current = index < 0 ? -Infinity : this._trigger(ticks[index], cycle);
      const trigger = Math.max(current, this._completedTrigger(ticks[ticks.length - 1]));
      this.keyAges[key] = trigger === -Infinity ? Infinity : (frame - trigger) / sampleRate * 1000;
    }
    return this.keyAges;
  }

  /** Query the original note object without touching its properties or searching the song. */
  noteAge(note) {
    if (!this._snapshot || !note || !this._noteTicks.has(note)) return Infinity;
    const tick = this._noteTicks.get(note), trigger = Math.max(this._trigger(tick, this._cycle), this._completedTrigger(tick));
    return trigger === -Infinity ? Infinity : (this._snapshot.frame - trigger) / this._snapshot.sampleRate * 1000;
  }
}
