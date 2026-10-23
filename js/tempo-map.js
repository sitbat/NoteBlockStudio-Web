// Original special instruments are controls, not missing audio samples.
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export function controlType(note, song) {
  const instrument = Number(note?.instrument);
  if (!Number.isInteger(instrument) || instrument < 16) return null;
  const name = song?.customInstruments?.[instrument - 16]?.name;
  return name === 'Tempo Changer' ? 'tempo' : name === 'Toggle Rainbow' ? 'rainbow' : null;
}

/** Compile only when a song changes. Playback queries never traverse layers or notes. */
export function compileSongControls(song = {}) {
  const layers = song.layers || [], solo = layers.some(layer => layer.solo), controls = [];
  for (let order = 0; order < (song.notes?.length || 0); order++) {
    const note = song.notes[order];
    if (!note) continue;
    const type = controlType(note, song), layer = layers[note.layer] || {};
    if (!type || layer.muted || solo && !layer.solo) continue;
    const tick = Number(note.tick);
    if (!Number.isFinite(tick) || tick < 0) continue;
    controls.push({type, tick, layer: Number(note.layer) || 0, order,
      ...(type === 'tempo' ? {tempo: Math.max(.25, Math.min(32768, Math.floor(Math.abs(finite(note.pitch, 0)))) / 15)} : {})});
  }
  controls.sort((a,b) => a.tick - b.tick || a.layer - b.layer || a.order - b.order);
  return controls;
}

/** Canonical piecewise tick/second map; same-tick controls apply in layer order. */
export function createTempoMap(song = {}, controls = compileSongControls(song)) {
  const base = Math.min(655.35, Math.max(.01, finite(song.tempo, 10)));
  const points = [{tick: 0, seconds: 0, tempo: base}];
  for (const control of controls) {
    if (control.type !== 'tempo') continue;
    const previous = points[points.length - 1];
    if (previous.tick === control.tick) previous.tempo = control.tempo;
    else points.push({tick: control.tick, seconds: previous.seconds + (control.tick - previous.tick) / previous.tempo, tempo: control.tempo});
  }
  if (points.length === 1 && points[0].tempo === base) return null;
  return Object.freeze({signature: points.map(point => `${point.tick}:${point.tempo}`).join(';'),
    points: Object.freeze(points.map(point => Object.freeze(point)))});
}

function pointAt(value, map, field) {
  const points = map.points;
  let low = 0, high = points.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (points[middle][field] <= value) low = middle; else high = middle - 1; }
  return points[low];
}
export function secondsAtTick(tick, map, tempo = 10) {
  if (!map) return tick / tempo;
  const point = pointAt(tick, map, 'tick');
  return point.seconds + (tick - point.tick) / point.tempo;
}
export function tickAtSeconds(seconds, map, tempo = 10) {
  if (!map) return seconds * tempo;
  const point = pointAt(seconds, map, 'seconds');
  return point.tick + (seconds - point.seconds) * point.tempo;
}
export function tempoAtTick(tick, map, tempo = 10) { return map ? pointAt(tick, map, 'tick').tempo : tempo; }
