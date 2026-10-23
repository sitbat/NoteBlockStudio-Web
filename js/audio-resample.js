// Band-limited interpolation of PCM, including a change of playback speed.
// A shared windowed-sinc table avoids allocating a filter for every output frame.
const RADIUS = 16, TABLE_STEPS = 2048, MAX_FRAMES = 16 * 1024 * 1024;
const kernel = Float64Array.from({length: RADIUS * TABLE_STEPS + 1}, (_, index) => {
  const x = index / TABLE_STEPS;
  return (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (0.42 + 0.5 * Math.cos(Math.PI * x / RADIUS) + 0.08 * Math.cos(2 * Math.PI * x / RADIUS));
});
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

/** Return mono PCM whose duration and pitch include playbackRate, at a valid WAV sample rate. */
export async function resampleMono(buffer, {playbackRate = 1, sampleRate = 48000, maxFrames = MAX_FRAMES} = {}) {
  if (!buffer || !Number.isSafeInteger(buffer.length) || buffer.length < 1 || buffer.length > MAX_FRAMES || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32 || typeof buffer.getChannelData !== 'function' || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate < 8000 || buffer.sampleRate > 384000) throw new Error('自定义采样 PCM 无效或过大。');
  if (!Number.isFinite(playbackRate) || playbackRate <= 0 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_FRAMES) throw new Error('采样变速或输出采样率无效。');
  const step = buffer.sampleRate * playbackRate / sampleRate, frames = Math.ceil(buffer.length / step);
  if (!Number.isFinite(step) || !Number.isSafeInteger(frames) || frames < 1 || frames > maxFrames) throw new Error('变速后的采样过大，请缩短自定义采样后再导出资源包。');
  // Limit filter work as well as output memory for malformed/unusable speed settings.
  const cutoff = Math.min(1, 1 / step), radius = RADIUS / cutoff;
  if (!Number.isFinite(radius) || radius > 16384) throw new Error('采样变速比例超出支持范围。');
  const mono = new Float32Array(buffer.length), output = new Float32Array(frames);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    if (!(data instanceof Float32Array) || data.length !== buffer.length) throw new Error('自定义采样声道长度无效。');
    for (let start = 0; start < data.length; start += 65536) {
      const end = Math.min(data.length, start + 65536);
      for (let i = start; i < end; i++) mono[i] += Number.isFinite(data[i]) ? data[i] / buffer.numberOfChannels : 0;
      if (end < data.length) await yieldTask();
    }
  }
  // Exact identity avoids changing samples or adding ringing when no resampling is needed.
  if (step === 1) output.set(mono);
  else {
    const chunkFrames = Math.max(32, Math.min(16384, Math.floor(524288 / (radius * 2))));
    for (let start = 0; start < frames; start += chunkFrames) {
      const end = Math.min(frames, start + chunkFrames);
      for (let frame = start; frame < end; frame++) {
        const position = frame * step, first = Math.max(0, Math.ceil(position - radius)), last = Math.min(mono.length - 1, Math.floor(position + radius));
        let value = 0, weight = 0;
        for (let source = first; source <= last; source++) {
          const index = Math.min(kernel.length - 1, Math.round(Math.abs(source - position) * cutoff * TABLE_STEPS)), coefficient = kernel[index];
          value += mono[source] * coefficient;
          weight += coefficient;
        }
        output[frame] = Math.abs(weight) > 1e-12 ? value / weight : 0;
      }
      if (end < frames) await yieldTask();
    }
  }
  return {length: frames, numberOfChannels: 1, sampleRate, duration: frames / sampleRate, getChannelData(channel) { if (channel !== 0) throw new RangeError('Mono channel index must be 0.'); return output; }};
}
