/** Fixed shared-memory wire layout. All counters publish with Atomics. */
export const GLOBAL = Object.freeze({MODE: 0, EPOCH: 1, READ: 2, OFFSET: 3, UNDERRUNS: 4, QUANTA: 5, OUTPUT_PEAK: 6, OUTPUT_RMS: 7});
export const HEADER = Object.freeze({WRITE: 0, WAKE: 1, PARAM_REV: 2, ACTIVE: 3, DROPPED: 4, MAX_US: 5, TOTAL_US: 6, BLOCKS: 7, TIMING_COUNT: 8, PEAK_MILLI: 9, UNDERRUNS: 10, RENDER_SEQ: 11, APPLIED_REV: 12, APPLIED_SEQ: 13});
export const STOPPED = 0, PREROLL = 1, RUNNING = 2;
export const PARAM_STRIDE = 4;
export const TIMING_SLOTS = 256;
export const RING_SLOTS = 32;

/** Refill a backlog in one bounded task instead of yielding for every audio block. */
export function refillRing(getRead, getNext, lead, render, {now = () => performance.now(), budgetMs = 3, maxBlocks = 16} = {}) {
  const started = now(); let count = 0;
  while (count < maxBlocks) {
    const read = getRead(), next = getNext();
    if (next - read >= lead) break;
    render(next >= read); count++;
    if (now() - started >= budgetMs) break;
  }
  return count;
}

export function shardRanges(tracks, requestedWorkers) {
  tracks = Math.max(1, Math.trunc(tracks));
  const groups = Math.ceil(tracks / 4);
  const count = Math.min(groups, Math.max(1, Math.trunc(requestedWorkers)));
  const base = Math.floor(groups / count), extra = groups % count;
  let start = 0;
  return Array.from({length: count}, (_, index) => {
    const end = Math.min(tracks, start + (base + (index < extra ? 1 : 0)) * 4);
    const range = {start, end, tracks: end - start}; start = end; return range;
  });
}

export function createRing(tracks, blockFrames, slots = RING_SLOTS) {
  return {
    header: new SharedArrayBuffer(16 * 4), stamps: new SharedArrayBuffer(slots * 4),
    pcm: new SharedArrayBuffer(slots * blockFrames * 2 * 4),
    params: new SharedArrayBuffer(tracks * PARAM_STRIDE * 4),
    timings: new SharedArrayBuffer(TIMING_SLOTS * 4), slots,
  };
}

export function songLength(song) {
  return (song.notes || []).reduce((max, note) => Math.max(max, Number(note.tick) + 1 || 1), Math.max(1, Number(song.length) || 1));
}

export function transportConfig(song, options, sampleRate) {
  const tempo = Math.min(655.35, Math.max(0.01, Number(song.tempo) || 10));
  const length = songLength(song), loopStart = Math.min(length - 1, Math.max(0, Number(song.loopStart) || 0));
  let fromTick = Math.min(length, Math.max(0, Number(options.fromTick) || 0));
  if (fromTick >= length) fromTick = 0;
  const loop = options.loop === undefined ? !!song.loop : !!options.loop;
  const loopCount = Math.min(255, Math.max(0, Math.trunc(Number(options.loopCount ?? song.loopCount) || 0)));
  const framesPerTick = sampleRate / tempo;
  const startFrame = Math.max(0, Number(options.startFrame) || 0);
  const endFrame = loop && !loopCount ? Infinity : startFrame + Math.round((length - fromTick + (loop ? loopCount * (length - loopStart) : 0)) * framesPerTick);
  return {tempo, length, loopStart, fromTick, loop, loopCount, framesPerTick, startFrame, endFrame};
}

export function tickAtFrame(frame, transport) {
  const {fromTick, framesPerTick, length, loop, loopStart, endFrame, startFrame = 0} = transport;
  if (frame >= endFrame) return length;
  const tick = fromTick + Math.max(0, frame - startFrame) / framesPerTick;
  return loop && tick >= length ? loopStart + (tick - length) % (length - loopStart) : Math.min(length, tick);
}

export function lowerBoundTick(events, tick) {
  let low = 0, high = events.length;
  while (low < high) { const mid = (low + high) >>> 1; if (events[mid].tick < tick) low = mid + 1; else high = mid; }
  return low;
}

/** Stateful timeline shared by real-time and offline workers. */
export class EventTimeline {
  constructor(events, config) { this.config = config; this.events = events; this.cycleOrigin = (config.startFrame || 0) - config.fromTick * config.framesPerTick; this.cycleEnd = (config.startFrame || 0) + (config.length - config.fromTick) * config.framesPerTick; this.repeats = 0; this.cursor = lowerBoundTick(events, config.fromTick); }
  replace(events, frame) {
    this.events = events;
    const tick = (frame - this.cycleOrigin) / this.config.framesPerTick;
    this.cursor = lowerBoundTick(events, tick - 1e-9);
  }
  dispatch(startFrame, frames, callback) {
    const end = startFrame + frames, c = this.config;
    for (let guard = 0; guard < 1024; guard++) {
      while (this.cursor < this.events.length) {
        const event = this.events[this.cursor];
        const frame = Math.round(this.cycleOrigin + event.tick * c.framesPerTick);
        if (event.tick >= c.length || frame >= end || frame >= Math.round(this.cycleEnd)) break;
        this.cursor++;
        if (frame >= startFrame) callback(event, frame - startFrame);
      }
      if (this.cycleEnd >= end || !c.loop || c.loopCount > 0 && this.repeats >= c.loopCount) break;
      this.repeats++;
      this.cycleOrigin = this.cycleEnd - c.loopStart * c.framesPerTick;
      this.cycleEnd = this.cycleOrigin + c.length * c.framesPerTick;
      this.cursor = lowerBoundTick(this.events, c.loopStart);
    }
  }
}
