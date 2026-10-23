/** Optional trailing NBS extension; the standard score remains readable independently. */
const MAGIC = new TextEncoder().encode('ONBSWFX1');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const sameMagic = bytes => bytes.length >= 12 && MAGIC.every((n, i) => bytes[bytes.length - 8 + i] === n);

export function encodeProjectEffects(layers) {
  if (!layers.some(l => l.reverb || l.muted || l.locked)) return new Uint8Array();
  const tracks = [];
  layers.forEach((l, index) => {
    if (l.reverb || l.muted || l.locked) tracks.push({i: index, r: l.reverb || 0, m: !!l.muted, s: !!l.solo, k: !!l.locked, v: l.volume ?? 100});
  });
  const payload = encoder.encode(JSON.stringify({version: 1, tracks}));
  const bytes = new Uint8Array(payload.length + 12);
  bytes.set(payload); new DataView(bytes.buffer).setUint32(payload.length, payload.length, true); bytes.set(MAGIC, payload.length + 4);
  return bytes;
}

export function decodeProjectEffects(input, layers) {
  const bytes = Uint8Array.from(input);
  if (!sameMagic(bytes)) return {remaining: Array.from(bytes), restored: false};
  const len = new DataView(bytes.buffer).getUint32(bytes.length - 12, true), start = bytes.length - 12 - len;
  if (len > 16 * 1024 * 1024 || start < 0) return {remaining: Array.from(bytes), restored: false};
  let payload;
  try { payload = JSON.parse(decoder.decode(bytes.subarray(start, start + len))); } catch { return {remaining: Array.from(bytes), restored: false}; }
  if (payload?.version !== 1 || !Array.isArray(payload.tracks) || payload.tracks.length > layers.length) return {remaining: Array.from(bytes), restored: false};
  const seen = new Set();
  for (const t of payload.tracks) {
    if (!t || !Number.isInteger(t.i) || t.i < 0 || t.i >= layers.length || seen.has(t.i) || !Number.isFinite(t.r) || t.r < 0 || t.r > 100 || !Number.isFinite(t.v) || t.v < 0 || t.v > 100 || ['m','s','k'].some(k => typeof t[k] !== 'boolean')) return {remaining: Array.from(bytes), restored: false};
    seen.add(t.i);
  }
  for (const layer of layers) layer.reverb = 0;
  for (const t of payload.tracks) Object.assign(layers[t.i], {reverb: t.r, volume: t.v, muted: t.m, solo: t.s, locked: t.k});
  return {remaining: Array.from(bytes.subarray(0, start)), restored: true};
}
