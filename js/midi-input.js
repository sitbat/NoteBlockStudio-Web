/** Web MIDI message decoding and recording; no device permission is requested on load. */
export function decodeMidiMessage(input) {
  const a = Array.from(input || []), status = a[0];
  if (!Number.isInteger(status) || status < 0x80 || status >= 0xf0) return null;
  const kind = status >> 4, channel = status & 15, needed = kind === 0xc || kind === 0xd ? 2 : 3;
  if (a.length < needed || a.slice(1, needed).some(x => !Number.isInteger(x) || x < 0 || x > 127)) return null;
  const base = {channel};
  if (kind === 8 || kind === 9) return {...base, type: kind === 8 || a[2] === 0 ? 'noteoff' : 'noteon', midiKey: a[1], key: a[1] - 21, velocity: a[2] / 127 * 100};
  if (kind === 0xb) return {...base, type: 'control', controller: a[1], value: a[2]};
  if (kind === 0xc) return {...base, type: 'program', program: a[1]};
  if (kind === 0xe) return {...base, type: 'bend', value: a[1] | a[2] << 7, pitch: ((a[1] | a[2] << 7) - 8192) / 8192 * 200};
  if (kind === 0xa || kind === 0xd) return {...base, type: 'pressure', value: a[needed - 1]};
  return null;
}

const PROGRAMS = [10, 32, 118, 115, 115, 24, 73, 14, 9, 13, 11, 112, 71, 81, 105, 8];
const freshChannels = () => Array.from({length: 16}, () => ({pitch: 0, volume: 100, pan: 0, sustain: false, program: 0}));
export function midiProgramInstrument(program) {
  const exact = PROGRAMS.indexOf(program);
  if (exact >= 0) return exact;
  if (program >= 24 && program < 32) return 5;
  if (program >= 32 && program < 40) return 1;
  if (program >= 72 && program < 80) return 6;
  if (program >= 80 && program <= 103) return 13;
  if (program >= 8 && program <= 15) return 7;
  return 0;
}

export class MidiInputController {
  constructor({requestAccess, onNote = () => {}, onRecord = () => {}, onDevices = () => {}, onControl = () => {}, onStep = () => {}, onError = () => {}, now = () => performance.now()} = {}) {
    this.requestAccess = requestAccess || (() => {
      if (!navigator.requestMIDIAccess) throw new Error('此浏览器没有 Web MIDI，请使用桌面版 Chrome / Edge。');
      return navigator.requestMIDIAccess({sysex: false});
    });
    Object.assign(this, {onNote, onRecord, onDevices, onControl, onStep, onError, now});
    this.devices = new Map(); this.held = new Map(); this.deviceChannels = new Map();
    // Compatibility view of the most recently addressed device; MIDI state itself is per input port.
    this.channels = freshChannels();
    this.recording = null;
  }
  async connect() {
    this.access ||= await this.requestAccess();
    this.access.onstatechange = () => this.refresh();
    return this.refresh();
  }
  refresh() {
    const list = [];
    for (const port of this.access?.inputs.values() || []) {
      if (!this.devices.has(port.id)) this.devices.set(port.id, {instrument: -1, channel: -1, enabled: true});
      port.onmidimessage = event => { try { this.receive(port.id, event.data); } catch (error) { this.onError(error); } };
      list.push({id: port.id, name: port.name || port.id, manufacturer: port.manufacturer, state: port.state, ...this.devices.get(port.id)});
    }
    const connected = new Set(list.filter(d => d.state !== 'disconnected').map(d => d.id));
    for (const [id, note] of this.held) if (!connected.has(note.device)) this.release(id);
    for (const device of this.deviceChannels.keys()) if (!connected.has(device)) this.deviceChannels.delete(device);
    this.onDevices(list); return list;
  }
  configure(device, options) {
    const config = {...this.devices.get(device), ...options};
    if (!Number.isInteger(config.instrument) || config.instrument < -2 || config.instrument > 270) throw new Error('MIDI 音色无效。');
    if (!Number.isInteger(config.channel) || config.channel < -1 || config.channel > 15) throw new Error('MIDI 通道无效。');
    this.devices.set(device, config);
    for (const [id, note] of this.held) if (note.device === device && (config.enabled === false || config.channel >= 0 && config.channel !== note.channel)) this.release(id);
  }
  startRecording({mode = 'realtime', tick = 0, tempo = 10, snap = 1, instrument = 0, layer = 0, clockTick} = {}) {
    if (!['realtime', 'step'].includes(mode)) throw new Error('录制模式无效。');
    this.stopRecording();
    this.recording = {mode, tick, tempo, snap: Math.max(.01, snap), instrument, layer, clockTick, started: this.now()};
  }
  stopRecording() {
    for (const id of [...this.held.keys()]) this.release(id);
    this.recording = null;
  }
  tick() {
    const r = this.recording;
    if (!r) return 0;
    return r.mode === 'step' ? r.tick : r.clockTick ? r.clockTick() : r.tick + (this.now() - r.started) / 1000 * r.tempo;
  }
  receive(device, bytes) {
    const event = decodeMidiMessage(bytes), config = this.devices.get(device) || {enabled: true, instrument: -1, channel: -1};
    if (!event || !config.enabled || config.channel >= 0 && config.channel !== event.channel) return;
    let bank = this.deviceChannels.get(device);
    if (!bank) { bank = freshChannels(); this.deviceChannels.set(device, bank); }
    this.channels = bank;
    const channel = bank[event.channel], id = `${device}/${event.channel}/${event.midiKey}`;
    if (event.type === 'bend') { channel.pitch = event.pitch; this.onControl({...event, device}); return; }
    if (event.type === 'program') { channel.program = event.program; this.onControl({...event, device}); return; }
    if (event.type === 'control') {
      const {controller: control, value} = event;
      if (control === 7) channel.volume = value / 127 * 100;
      if (control === 10) channel.pan = (value - 64) / (value < 64 ? 64 : 63) * 100;
      if (control === 64) {
        channel.sustain = value >= 64;
        if (!channel.sustain) for (const [key, note] of this.held) if (note.device === device && note.channel === event.channel && note.released) this.release(key);
      }
      if (control === 120 || control === 123) for (const [key, note] of this.held) if (note.device === device && note.channel === event.channel) this.release(key);
      if (control === 121) { Object.assign(channel, {pitch: 0, volume: 100, pan: 0, sustain: false}); for (const [key, note] of this.held) if (note.device === device && note.channel === event.channel && note.released) this.release(key); }
      this.onControl({...event, device}); return;
    }
    if (event.type === 'noteoff') {
      const note = this.held.get(id); if (!note) return;
      if (channel.sustain) note.released = true; else this.release(id);
      return;
    }
    if (event.type !== 'noteon' || event.key < 0 || event.key > 87 || config.instrument === -2) return;
    if (this.held.has(id)) this.release(id, false);
    const record = this.recording;
    const instrument = config.instrument >= 0 ? config.instrument : record?.instrument ?? 0;
    const note = {...event, device, instrument, pitch: Math.round(channel.pitch), pan: channel.pan, velocity: event.velocity * channel.volume / 100,
      tick: record ? Math.max(0, Math.round(this.tick() / record.snap) * record.snap) : 0, layer: record?.layer || 0, started: this.now(), recording: record};
    this.held.set(id, note); this.onNote(note);
  }
  release(id, advance = true) {
    const note = this.held.get(id); if (!note) return;
    this.held.delete(id);
    if (note.recording && note.recording === this.recording) {
      const r = this.recording, duration = r.mode === 'step' ? r.snap : Math.max(r.snap, Math.round((this.now() - note.started) / 1000 * r.tempo / r.snap) * r.snap);
      this.onRecord({...note, duration});
      if (advance && r.mode === 'step' && ![...this.held.values()].some(n => n.recording === r)) { r.tick += r.snap; this.onStep(r.tick); }
    }
  }
  async disconnect() {
    this.stopRecording();
    if (this.access) { this.access.onstatechange = null; for (const port of this.access.inputs.values()) { port.onmidimessage = null; await port.close?.(); } }
    this.access = null; this.deviceChannels.clear(); this.channels = freshChannels(); this.onDevices([]);
  }
}
