/** Fixed shared-memory wire layout. All counters publish with Atomics. */
import {compileSongControls, createTempoMap, secondsAtTick, tickAtSeconds, tempoAtTick} from './tempo-map.js';
export const GLOBAL = Object.freeze({MODE: 0, EPOCH: 1, READ: 2, OFFSET: 3, UNDERRUNS: 4, QUANTA: 5, OUTPUT_PEAK: 6, OUTPUT_RMS: 7, MONO: 8});
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
  const fullLength = songLength(song);
  const length = options.endTick === undefined ? fullLength : Math.min(fullLength, Math.max(1, Number(options.endTick) || fullLength));
  const loopStart = Math.min(length - 1, Math.max(0, Number(options.loopStart ?? song.loopStart) || 0));
  let fromTick = Math.min(length, Math.max(0, Number(options.fromTick) || 0));
  if (fromTick >= length) fromTick = 0;
  const loop = options.loop === undefined ? !!song.loop : !!options.loop;
  const loopCount = Math.min(255, Math.max(0, Math.trunc(Number(options.loopCount ?? song.loopCount) || 0)));
  const completedLoops = loopCount ? Math.min(loopCount, Math.max(0, Math.trunc(Number(options.completedLoops) || 0))) : 0;
  const framesPerTick = sampleRate / tempo;
  const startFrame = Math.max(0, Number(options.startFrame) || 0);
  const controls = compileSongControls(song), tempoMap = createTempoMap(song, controls);
  const rainbowEvents = Object.freeze(controls.filter(event => event.type === 'rainbow').map(event => event.tick));
  const config = {tempo, length, fullLength, loopStart, fromTick, loop, loopCount, completedLoops, framesPerTick, sampleRate, startFrame, tempoMap,
    rainbowEvents, rainbowSignature: rainbowEvents.join(','), rainbowBaseParity: !!options.rainbowBaseParity};
  const endFrame = loop && !loopCount ? Infinity : startFrame + Math.round(tickFrameOffset(length, config) - tickFrameOffset(fromTick, config) + (loop ? (loopCount - completedLoops) * (tickFrameOffset(length, config) - tickFrameOffset(loopStart, config)) : 0));
  return {...config, endFrame};
}

/** Absolute song-time offset, independent of the current seek/cycle. Constant tempo stays O(1). */
export function tickFrameOffset(tick, transport) {
  return transport.tempoMap ? secondsAtTick(tick, transport.tempoMap, transport.tempo) * transport.sampleRate : tick * transport.framesPerTick;
}
export function frameOffsetTick(frame, transport) {
  return transport.tempoMap ? tickAtSeconds(frame / transport.sampleRate, transport.tempoMap, transport.tempo) : frame / transport.framesPerTick;
}
export function transportTempoAtTick(tick, transport) { return tempoAtTick(tick, transport.tempoMap, transport.tempo); }

/** Repetition index since this transport's original start, without replaying old cycles. */
export function completedLoopsAtFrame(frame, c) {
  const completed = c.completedLoops || 0;
  if (!c.loop) return completed;
  const end = c.startFrame - tickFrameOffset(c.fromTick, c) + tickFrameOffset(c.length, c);
  const period = tickFrameOffset(c.length, c) - tickFrameOffset(c.loopStart, c);
  const count = completed + Math.max(0, Math.ceil((Math.floor(frame) + .5 - end) / period));
  return c.loopCount ? Math.min(c.loopCount, count) : count;
}

function lowerBoundNumber(values, tick) {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < tick) low = middle + 1; else high = middle; }
  return low;
}
function rainbowCountAtFrame(values, minimum, origin, end, frame, c) {
  const from = lowerBoundNumber(values, minimum), to = lowerBoundNumber(values, c.length), fence = Math.min(frame, Math.round(end) - 1);
  let low = from, high = to;
  while (low < high) { const middle = (low + high) >>> 1; if (Math.round(origin + tickFrameOffset(values[middle], c)) <= fence) low = middle + 1; else high = middle; }
  return low - from;
}

/** Song-only Toggle Rainbow parity, O(log events), including arbitrarily many loop passes. */
export function rainbowAtFrame(frame, c) {
  const values = c.rainbowEvents || [], base = !!c.rainbowBaseParity;
  if (!values.length || frame < c.startFrame) return base;
  const origin = c.startFrame - tickFrameOffset(c.fromTick, c), firstEnd = origin + tickFrameOffset(c.length, c);
  const repeat = Math.max(0, completedLoopsAtFrame(frame, c) - (c.completedLoops || 0));
  if (!repeat) return !!(Number(base) ^ (rainbowCountAtFrame(values, c.fromTick, origin, firstEnd, frame, c) & 1));
  const period = tickFrameOffset(c.length, c) - tickFrameOffset(c.loopStart, c);
  const repeatedOrigin = firstEnd + (repeat - 1) * period - tickFrameOffset(c.loopStart, c);
  const initialCount = rainbowCountAtFrame(values, c.fromTick, origin, firstEnd, firstEnd, c);
  const cycleCount = rainbowCountAtFrame(values, c.loopStart, repeatedOrigin, repeatedOrigin + tickFrameOffset(c.length, c), Infinity, c);
  const currentCount = rainbowCountAtFrame(values, c.loopStart, repeatedOrigin, repeatedOrigin + tickFrameOffset(c.length, c), frame, c);
  return !!(Number(base) ^ (initialCount & 1) ^ ((repeat - 1) % 2 && cycleCount & 1) ^ (currentCount & 1));
}

export function tickAtFrame(frame, transport) {
  const {fromTick, framesPerTick, length, loop, loopStart, endFrame, startFrame = 0} = transport;
  if (frame >= endFrame) return length;
  const offset = tickFrameOffset(fromTick, transport) + Math.max(0, frame - startFrame);
  const end = tickFrameOffset(length, transport), start = tickFrameOffset(loopStart, transport);
  return loop && offset >= end ? frameOffsetTick(start + (offset - end) % (end - start), transport) : Math.min(length, frameOffsetTick(offset, transport));
}

export function lowerBoundTick(events, tick) {
  let low = 0, high = events.length;
  while (low < high) { const mid = (low + high) >>> 1; if (events[mid].tick < tick) low = mid + 1; else high = mid; }
  return low;
}

/** Stateful timeline shared by real-time and offline workers. */
export class EventTimeline {
  constructor(events, config) { this.config = config; this.events = events; this.cycleOrigin = (config.startFrame || 0) - tickFrameOffset(config.fromTick, config); this.cycleEnd = this.cycleOrigin + tickFrameOffset(config.length, config); this.repeats = config.completedLoops || 0; this.cursor = lowerBoundTick(events, config.fromTick); }
  replace(events, frame) {
    this.events = events;
    const tick = frameOffsetTick(frame - this.cycleOrigin, this.config);
    this.cursor = lowerBoundTick(events, tick - 1e-9);
  }
  dispatch(startFrame, frames, callback) {
    const end = startFrame + frames, c = this.config;
    for (let guard = 0; guard < 1024; guard++) {
      while (this.cursor < this.events.length) {
        const event = this.events[this.cursor];
        const frame = Math.round(this.cycleOrigin + tickFrameOffset(event.tick, c));
        if (event.tick >= c.length || frame >= end || frame >= Math.round(this.cycleEnd)) break;
        this.cursor++;
        if (frame >= startFrame && frame >= (event.notBeforeFrame ?? 0)) callback(event, frame - startFrame);
      }
      if (this.cycleEnd >= end || !c.loop || c.loopCount > 0 && this.repeats >= c.loopCount) break;
      this.repeats++;
      this.cycleOrigin = this.cycleEnd - tickFrameOffset(c.loopStart, c);
      this.cycleEnd = this.cycleOrigin + tickFrameOffset(c.length, c);
      this.cursor = lowerBoundTick(this.events, c.loopStart);
    }
  }
}

/** Sparse click scheduler: no array of every beat, including long songs and loops. */
export class MetronomeTimeline {
  constructor(config, frame = config.startFrame || 0) {
    this.config = config;
    const tick = tickAtFrame(frame, config);
    this.cycleOrigin = frame - tickFrameOffset(tick, config);
    this.cycleEnd = this.cycleOrigin + tickFrameOffset(config.length, config);
    this.tick = Math.ceil((tick - 1e-9) / 4) * 4;
  }
  dispatch(startFrame, frames, callback) {
    const c = this.config, end = Math.min(startFrame + frames, c.endFrame);
    for (let guard = 0; guard < 1024 && startFrame < end; guard++) {
      while (this.tick < c.length) {
        const frame = Math.round(this.cycleOrigin + tickFrameOffset(this.tick, c));
        if (frame >= end || frame >= Math.round(this.cycleEnd)) break;
        const tick = this.tick; this.tick += 4;
        if (frame >= startFrame) callback(tick, frame - startFrame);
      }
      if (this.cycleEnd >= end || !c.loop) break;
      this.cycleOrigin = this.cycleEnd - tickFrameOffset(c.loopStart, c);
      this.cycleEnd = this.cycleOrigin + tickFrameOffset(c.length, c);
      this.tick = Math.ceil(c.loopStart / 4) * 4;
    }
  }
}
