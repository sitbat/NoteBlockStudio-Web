//! Dependency-free sample mixer and four-delay feedback network per track.
//! Four independent tracks occupy SIMD lanes; there is no inter-track feedback.
//! All buffers and the voice pool are allocated before `engine_render` runs.

const LANES: usize = 4;
const MAX_TRACKS: usize = 10_000;
const MAX_VOICES: usize = 1_000_000;
const MAX_SAMPLE_FRAMES: usize = 16_777_216;
const DELAY_MS: [usize; 4] = [13, 17, 19, 23];
const FEEDBACK: f32 = 0.82;
const DAMPING: f32 = 0.45;
const GAIN_RAMP: usize = 32;

fn bounded(value: f32, min: f32, max: f32) -> f32 {
    if value.is_finite() { value.clamp(min, max) } else { min }
}

fn zeros<T: Clone + Default>(length: usize) -> Option<Vec<T>> {
    let mut result = Vec::new();
    result.try_reserve_exact(length).ok()?;
    result.resize(length, T::default());
    Some(result)
}

#[derive(Clone)]
struct Track {
    gain: f32,
    target_gain: f32,
    ramp: usize,
    pan: f32,
    dry: f32,
    wet: f32,
    enabled: bool,
    configured: bool,
}

impl Default for Track {
    fn default() -> Self {
        Self { gain: 1.0, target_gain: 1.0, ramp: 0, pan: 0.0, dry: 1.0, wet: 0.0, enabled: true, configured: false }
    }
}

impl Track {
    #[inline]
    fn gain_at(&self, frame: usize) -> f32 {
        if self.ramp == 0 || frame >= self.ramp { self.target_gain }
        else { self.gain + (self.target_gain - self.gain) * ((frame + 1) as f32 / self.ramp as f32) }
    }
    fn finish_block(&mut self, frames: usize) {
        self.gain = self.gain_at(frames.saturating_sub(1));
        self.ramp = self.ramp.saturating_sub(frames);
    }
}

#[derive(Clone, Default)]
struct Voice {
    track: usize,
    sample: usize,
    position: f64,
    rate: f64,
    gain: f32,
    pan: f32,
    delay: usize,
    looping: bool,
}

#[derive(Default)]
struct Sample { data: Vec<f32>, sanitized: bool }

struct Engine {
    sample_rate: usize,
    frames: usize,
    groups: usize,
    tracks: Vec<Track>,
    samples: Vec<Sample>,
    voices: Vec<Voice>,
    active: Vec<usize>,
    free: Vec<usize>,
    inputs: Vec<f32>,
    output: Vec<f32>,
    delay_lengths: [usize; 4],
    delays: [Vec<f32>; 4],
    positions: [usize; 4],
    filters: Vec<f32>,
    dropped: u32,
    peak: f32,
}

impl Engine {
    fn new(tracks: usize, sample_rate: usize, frames: usize, max_voices: usize) -> Option<Self> {
        if tracks == 0 || tracks > MAX_TRACKS || !(8_000..=96_000).contains(&sample_rate) || frames == 0 || frames > 4096 { return None; }
        let max_voices = if max_voices == 0 { tracks.checked_mul(4)? } else { max_voices };
        if max_voices == 0 || max_voices > MAX_VOICES { return None; }
        let groups = (tracks + LANES - 1) / LANES;
        let delay_lengths = DELAY_MS.map(|ms| (sample_rate * ms / 1000).max(1));
        let estimated = groups * LANES * (delay_lengths.iter().sum::<usize>() + frames) * 4 + max_voices * std::mem::size_of::<Voice>();
        if estimated > 512 * 1024 * 1024 { return None; }
        let delays = [zeros(groups * delay_lengths[0] * LANES)?, zeros(groups * delay_lengths[1] * LANES)?, zeros(groups * delay_lengths[2] * LANES)?, zeros(groups * delay_lengths[3] * LANES)?];
        let mut active = Vec::new(); active.try_reserve_exact(max_voices).ok()?;
        let mut free = Vec::new(); free.try_reserve_exact(max_voices).ok()?;
        free.extend((0..max_voices).rev());
        Some(Self {
            sample_rate, frames, groups, tracks: zeros(tracks)?, samples: Vec::new(), voices: zeros(max_voices)?, active, free,
            inputs: zeros(groups * frames * LANES)?, output: zeros(frames * 2)?,
            delay_lengths, delays, positions: [0; 4], filters: zeros(groups * 4 * LANES)?, dropped: 0, peak: 0.0,
        })
    }

    fn track(&mut self, index: usize, gain: f32, pan: f32, reverb: f32, enabled: bool) -> bool {
        let Some(track) = self.tracks.get_mut(index) else { return false; };
        let reverb = bounded(reverb, 0.0, 1.0);
        let target = if enabled { bounded(gain, 0.0, 4.0) } else { 0.0 };
        if track.target_gain != target {
            track.target_gain = target;
            track.ramp = if track.configured { GAIN_RAMP } else { 0 };
        }
        if !track.configured { track.gain = target; }
        track.pan = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
        track.dry = (1.0 - reverb).sqrt(); track.wet = reverb.sqrt();
        track.enabled = enabled; track.configured = true;
        true
    }

    fn sample_alloc(&mut self, id: usize, length: usize) -> *mut f32 {
        if id >= 512 || length == 0 || length > MAX_SAMPLE_FRAMES { return std::ptr::null_mut(); }
        let Some(data) = zeros(length) else { return std::ptr::null_mut(); };
        if self.samples.len() <= id {
            if self.samples.try_reserve(id + 1 - self.samples.len()).is_err() { return std::ptr::null_mut(); }
            self.samples.resize_with(id + 1, Sample::default);
        }
        self.samples[id] = Sample { data, sanitized: false };
        self.samples[id].data.as_mut_ptr()
    }

    fn voice(&mut self, track: usize, sample: usize, rate: f32, gain: f32, pan: f32, delay: usize, looping: bool) -> bool {
        let valid_sample = self.samples.get(sample).map(|sample| !sample.data.is_empty()).unwrap_or(false);
        if track >= self.tracks.len() || !valid_sample || !rate.is_finite() || rate <= 0.0 || !gain.is_finite() || !pan.is_finite() || delay > self.frames || self.free.is_empty() {
            self.dropped = self.dropped.saturating_add(1); return false;
        }
        // PCM is uploaded outside render. Sanitize it once before the first voice.
        let sample_data = &mut self.samples[sample];
        if !sample_data.sanitized {
            for value in &mut sample_data.data { *value = if value.is_finite() { value.clamp(-8.0, 8.0) } else { 0.0 }; }
            sample_data.sanitized = true;
        }
        let slot = self.free.pop().unwrap();
        self.voices[slot] = Voice { track, sample, position: 0.0, rate: rate.clamp(0.001, 256.0) as f64, gain: gain.clamp(0.0, 4.0), pan: pan.clamp(-1.0, 1.0), delay, looping };
        self.active.push(slot);
        true
    }

    fn render_voices(&mut self) {
        let mut active_index = 0;
        while active_index < self.active.len() {
            let slot = self.active[active_index];
            let voice = &mut self.voices[slot];
            let track = &self.tracks[voice.track];
            let sample = &self.samples[voice.sample].data;
            let length = sample.len();
            // Native NBS keeps note pan on centred layers and averages otherwise.
            let pan = if track.pan == 0.0 { voice.pan } else { (track.pan + voice.pan) * 0.5 };
            let left = ((1.0 - pan) * 0.5).sqrt() * track.dry * voice.gain;
            let right = ((1.0 + pan) * 0.5).sqrt() * track.dry * voice.gain;
            let group_offset = (voice.track / LANES) * self.frames * LANES + voice.track % LANES;
            let start = voice.delay.min(self.frames);
            voice.delay = voice.delay.saturating_sub(self.frames);
            let mut ended = false;
            for frame in start..self.frames {
                if voice.position >= length as f64 {
                    if voice.looping { voice.position %= length as f64; }
                    else { ended = true; break; }
                }
                let index = voice.position as usize;
                let fraction = (voice.position - index as f64) as f32;
                let next = if index + 1 < length { sample[index + 1] } else if voice.looping { sample[0] } else { 0.0 };
                let value = sample[index] + (next - sample[index]) * fraction;
                let gain = track.gain_at(frame);
                self.output[frame] += value * left * gain;
                self.output[self.frames + frame] += value * right * gain;
                if track.enabled { self.inputs[group_offset + frame * LANES] += value * voice.gain; }
                voice.position += voice.rate;
            }
            if !voice.looping && voice.position >= length as f64 { ended = true; }
            if ended { self.active.swap_remove(active_index); self.free.push(slot); }
            else { active_index += 1; }
        }
    }

    #[cfg(any(not(target_arch = "wasm32"), feature = "scalar"))]
    fn render_reverb(&mut self) {
        for group in 0..self.groups {
            let mut positions = self.positions;
            let input_start = group * self.frames * LANES;
            for frame in 0..self.frames {
                for lane in 0..LANES {
                    let track_index = group * LANES + lane;
                    let filter_start = group * 16 + lane;
                    let mut damped = [0.0; 4];
                    for tap in 0..4 {
                        let index = (group * self.delay_lengths[tap] + positions[tap]) * LANES + lane;
                        let raw = self.delays[tap][index];
                        damped[tap] = raw + (self.filters[filter_start + tap * LANES] - raw) * DAMPING;
                        self.filters[filter_start + tap * LANES] = damped[tap];
                    }
                    let [a, b, c, d] = damped;
                    let feedback = [(a + b + c + d) * 0.5, (a - b + c - d) * 0.5, (a + b - c - d) * 0.5, (a - b - c + d) * 0.5];
                    let input = self.inputs[input_start + frame * LANES + lane] * 0.5;
                    for tap in 0..4 {
                        let index = (group * self.delay_lengths[tap] + positions[tap]) * LANES + lane;
                        self.delays[tap][index] = input + feedback[tap] * FEEDBACK;
                    }
                    if let Some(track) = self.tracks.get(track_index) {
                        let gain = track.gain_at(frame) * track.wet * 0.5;
                        self.output[frame] += (a + c) * gain * ((1.0 - track.pan) * 0.5).sqrt();
                        self.output[self.frames + frame] += (b + d) * gain * ((1.0 + track.pan) * 0.5).sqrt();
                    }
                }
                for tap in 0..4 { positions[tap] += 1; if positions[tap] == self.delay_lengths[tap] { positions[tap] = 0; } }
            }
        }
    }

    #[cfg(all(target_arch = "wasm32", not(feature = "scalar")))]
    #[target_feature(enable = "simd128")]
    unsafe fn render_reverb(&mut self) {
        use core::arch::wasm32::*;
        let half = f32x4_splat(0.5);
        let damping = f32x4_splat(DAMPING);
        let feedback = f32x4_splat(FEEDBACK);
        let lengths = self.delay_lengths;
        let delay_pointers = [self.delays[0].as_mut_ptr(), self.delays[1].as_mut_ptr(), self.delays[2].as_mut_ptr(), self.delays[3].as_mut_ptr()];
        for group in 0..self.groups {
            let mut positions = self.positions;
            let bases = [group * lengths[0] * 4, group * lengths[1] * 4, group * lengths[2] * 4, group * lengths[3] * 4];
            let filter = self.filters.as_mut_ptr().add(group * 16);
            let mut a = v128_load(filter as *const v128);
            let mut b = v128_load(filter.add(4) as *const v128);
            let mut c = v128_load(filter.add(8) as *const v128);
            let mut d = v128_load(filter.add(12) as *const v128);
            let mut wet_left = [0.0f32; 4]; let mut wet_right = [0.0f32; 4];
            let mut gains = [0.0f32; 4]; let mut targets = [0.0f32; 4]; let mut steps = [0.0f32; 4]; let mut ramps = [0.0f32; 4];
            for lane in 0..4 {
                if let Some(track) = self.tracks.get(group * 4 + lane) {
                    wet_left[lane] = track.wet * ((1.0 - track.pan) * 0.5).sqrt() * 0.5;
                    wet_right[lane] = track.wet * ((1.0 + track.pan) * 0.5).sqrt() * 0.5;
                    gains[lane] = track.gain; targets[lane] = track.target_gain; ramps[lane] = track.ramp as f32;
                    if track.ramp > 0 { steps[lane] = (track.target_gain - track.gain) / track.ramp as f32; }
                }
            }
            let left_mix = v128_load(wet_left.as_ptr() as *const v128);
            let right_mix = v128_load(wet_right.as_ptr() as *const v128);
            let target_gain = v128_load(targets.as_ptr() as *const v128);
            let start_gain = v128_load(gains.as_ptr() as *const v128);
            let gain_step = v128_load(steps.as_ptr() as *const v128);
            let ramp_lengths = v128_load(ramps.as_ptr() as *const v128);
            let max_ramp = ramps.iter().copied().fold(0.0f32, f32::max) as usize;
            let input_ptr = self.inputs.as_ptr().add(group * self.frames * 4);
            for frame in 0..self.frames {
                let p0 = delay_pointers[0].add(bases[0] + positions[0] * 4);
                let p1 = delay_pointers[1].add(bases[1] + positions[1] * 4);
                let p2 = delay_pointers[2].add(bases[2] + positions[2] * 4);
                let p3 = delay_pointers[3].add(bases[3] + positions[3] * 4);
                let r0 = v128_load(p0 as *const v128); let r1 = v128_load(p1 as *const v128);
                let r2 = v128_load(p2 as *const v128); let r3 = v128_load(p3 as *const v128);
                a = f32x4_add(r0, f32x4_mul(f32x4_sub(a, r0), damping));
                b = f32x4_add(r1, f32x4_mul(f32x4_sub(b, r1), damping));
                c = f32x4_add(r2, f32x4_mul(f32x4_sub(c, r2), damping));
                d = f32x4_add(r3, f32x4_mul(f32x4_sub(d, r3), damping));
                let input = f32x4_mul(v128_load(input_ptr.add(frame * 4) as *const v128), half);
                let h0 = f32x4_mul(f32x4_add(f32x4_add(f32x4_add(a, b), c), d), half);
                let h1 = f32x4_mul(f32x4_sub(f32x4_add(f32x4_sub(a, b), c), d), half);
                let h2 = f32x4_mul(f32x4_sub(f32x4_sub(f32x4_add(a, b), c), d), half);
                let h3 = f32x4_mul(f32x4_add(f32x4_sub(f32x4_sub(a, b), c), d), half);
                v128_store(p0 as *mut v128, f32x4_add(input, f32x4_mul(h0, feedback)));
                v128_store(p1 as *mut v128, f32x4_add(input, f32x4_mul(h1, feedback)));
                v128_store(p2 as *mut v128, f32x4_add(input, f32x4_mul(h2, feedback)));
                v128_store(p3 as *mut v128, f32x4_add(input, f32x4_mul(h3, feedback)));
                let gain = if frame >= max_ramp { target_gain } else { f32x4_add(start_gain, f32x4_mul(gain_step, f32x4_min(f32x4_splat((frame + 1) as f32), ramp_lengths))) };
                let left = f32x4_mul(f32x4_mul(f32x4_add(a, c), left_mix), gain);
                let right = f32x4_mul(f32x4_mul(f32x4_add(b, d), right_mix), gain);
                *self.output.get_unchecked_mut(frame) += f32x4_extract_lane::<0>(left) + f32x4_extract_lane::<1>(left) + f32x4_extract_lane::<2>(left) + f32x4_extract_lane::<3>(left);
                *self.output.get_unchecked_mut(self.frames + frame) += f32x4_extract_lane::<0>(right) + f32x4_extract_lane::<1>(right) + f32x4_extract_lane::<2>(right) + f32x4_extract_lane::<3>(right);
                for tap in 0..4 { positions[tap] += 1; if positions[tap] == lengths[tap] { positions[tap] = 0; } }
            }
            v128_store(filter as *mut v128, a); v128_store(filter.add(4) as *mut v128, b);
            v128_store(filter.add(8) as *mut v128, c); v128_store(filter.add(12) as *mut v128, d);
        }
    }

    fn render(&mut self) -> *const f32 {
        self.inputs.fill(0.0); self.output.fill(0.0);
        self.render_voices();
        #[cfg(all(target_arch = "wasm32", not(feature = "scalar")))]
        unsafe { self.render_reverb(); }
        #[cfg(any(not(target_arch = "wasm32"), feature = "scalar"))]
        self.render_reverb();
        for tap in 0..4 { self.positions[tap] = (self.positions[tap] + self.frames) % self.delay_lengths[tap]; }
        for track in &mut self.tracks { track.finish_block(self.frames); }
        self.peak = 0.0;
        for value in &mut self.output {
            if !value.is_finite() { *value = 0.0; }
            self.peak = self.peak.max(value.abs());
        }
        self.output.as_ptr()
    }

    fn reset(&mut self) {
        self.active.clear(); self.free.clear();
        self.free.extend((0..self.voices.len()).rev());
        self.inputs.fill(0.0); self.output.fill(0.0); self.filters.fill(0.0);
        for delay in &mut self.delays { delay.fill(0.0); }
        self.positions = [0; 4]; self.peak = 0.0; self.dropped = 0;
        for track in &mut self.tracks { track.gain = track.target_gain; track.ramp = 0; }
    }
}

unsafe fn engine_mut(handle: usize) -> Option<&'static mut Engine> { (handle as *mut Engine).as_mut() }

#[no_mangle]
pub extern "C" fn engine_create(tracks: u32, sample_rate: u32, block_frames: u32, max_voices: u32) -> usize {
    Engine::new(tracks as usize, sample_rate as usize, block_frames as usize, max_voices as usize).map(|engine| Box::into_raw(Box::new(engine)) as usize).unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn engine_destroy(handle: usize) { if handle != 0 { unsafe { drop(Box::from_raw(handle as *mut Engine)); } } }
#[no_mangle]
pub extern "C" fn engine_sample_alloc(handle: usize, id: u32, length: u32) -> *mut f32 { unsafe { engine_mut(handle).map(|engine| engine.sample_alloc(id as usize, length as usize)).unwrap_or(std::ptr::null_mut()) } }
#[no_mangle]
pub extern "C" fn engine_track(handle: usize, track: u32, gain: f32, pan: f32, reverb: f32, enabled: u32) -> u32 { unsafe { engine_mut(handle).map(|engine| engine.track(track as usize, gain, pan, reverb, enabled != 0) as u32).unwrap_or(0) } }
#[no_mangle]
pub extern "C" fn engine_voice(handle: usize, track: u32, sample: u32, rate: f32, gain: f32, pan: f32, offset_frames: u32, loop_sample: u32) -> u32 { unsafe { engine_mut(handle).map(|engine| engine.voice(track as usize, sample as usize, rate, gain, pan, offset_frames as usize, loop_sample != 0) as u32).unwrap_or(0) } }
#[no_mangle]
pub extern "C" fn engine_render(handle: usize) -> *const f32 { unsafe { engine_mut(handle).map(Engine::render).unwrap_or(std::ptr::null()) } }
#[no_mangle]
pub extern "C" fn engine_reset(handle: usize) { unsafe { if let Some(engine) = engine_mut(handle) { engine.reset(); } } }
#[no_mangle]
pub extern "C" fn engine_active_voices(handle: usize) -> u32 { unsafe { engine_mut(handle).map(|engine| engine.active.len() as u32).unwrap_or(0) } }
#[no_mangle]
pub extern "C" fn engine_dropped_voices(handle: usize) -> u32 { unsafe { engine_mut(handle).map(|engine| engine.dropped).unwrap_or(0) } }
#[no_mangle]
pub extern "C" fn engine_peak(handle: usize) -> f32 { unsafe { engine_mut(handle).map(|engine| engine.peak).unwrap_or(0.0) } }
#[no_mangle]
pub extern "C" fn engine_wasm_simd() -> u32 { cfg!(all(target_arch = "wasm32", not(feature = "scalar"))) as u32 }
#[no_mangle]
pub extern "C" fn engine_sample_rate(handle: usize) -> u32 { unsafe { engine_mut(handle).map(|engine| engine.sample_rate as u32).unwrap_or(0) } }
#[no_mangle]
pub extern "C" fn engine_reverb_bytes(handle: usize) -> u32 { unsafe { engine_mut(handle).map(|engine| (engine.delays.iter().map(Vec::len).sum::<usize>() * 4) as u32).unwrap_or(0) } }

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(tracks: usize, frames: usize) -> Engine { Engine::new(tracks, 48_000, frames, tracks * 4).unwrap() }
    fn sample(engine: &mut Engine, data: &[f32]) { let pointer = engine.sample_alloc(0, data.len()); unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), pointer, data.len()); } }
    fn output(engine: &mut Engine) -> Vec<f32> { engine.render(); engine.output.clone() }
    fn near(a: f32, b: f32) { assert!((a - b).abs() < 1e-5, "{a} != {b}"); }

    #[test]
    fn dry_pan_gain_and_onset_are_exact() {
        let mut engine = setup(1, 8); sample(&mut engine, &[1.0, 0.5, 0.0]);
        engine.track(0, 0.5, -1.0, 0.0, true);
        assert!(engine.voice(0, 0, 1.0, 0.5, -1.0, 2, false));
        let out = output(&mut engine);
        assert_eq!(&out[0..5], &[0.0, 0.0, 0.25, 0.125, 0.0]);
        assert!(out[8..].iter().all(|value| *value == 0.0));
        assert_eq!(engine.active.len(), 0);
    }

    #[test]
    fn pitch_uses_linear_interpolation() {
        let mut engine = setup(1, 8); sample(&mut engine, &[0.0, 1.0, 0.0]);
        engine.track(0, 1.0, -1.0, 0.0, true);
        engine.voice(0, 0, 0.5, 1.0, -1.0, 0, false);
        assert_eq!(&output(&mut engine)[0..8], &[0.0, 0.5, 1.0, 0.5, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn mute_and_nonfinite_parameters_cannot_leak_invalid_audio() {
        let mut engine = setup(1, 64); sample(&mut engine, &[f32::NAN, f32::INFINITY, 1.0]);
        engine.track(0, 1.0, 0.0, 0.8, false);
        assert!(engine.voice(0, 0, 1.0, 1.0, 0.0, 0, true));
        assert!(output(&mut engine).iter().all(|value| *value == 0.0));
        assert!(!engine.voice(0, 0, f32::NAN, 1.0, 0.0, 0, true));
        engine.track(0, f32::NAN, f32::NAN, f32::NAN, true);
        assert!(output(&mut engine).iter().all(|value| value.is_finite()));
    }

    #[test]
    fn pool_limit_is_observable_and_reset_reuses_slots() {
        let mut engine = Engine::new(1, 48_000, 16, 2).unwrap(); sample(&mut engine, &[1.0]);
        assert!(engine.voice(0, 0, 1.0, 1.0, 0.0, 0, true));
        assert!(engine.voice(0, 0, 1.0, 1.0, 0.0, 0, true));
        assert!(!engine.voice(0, 0, 1.0, 1.0, 0.0, 0, true));
        assert_eq!(engine.active.len(), 2); assert_eq!(engine.dropped, 1);
        engine.reset(); assert_eq!(engine.active.len(), 0); assert_eq!(engine.dropped, 0);
        assert!(engine.voice(0, 0, 1.0, 1.0, 0.0, 0, false));
    }

    #[test]
    fn reverb_lanes_are_independent_and_reset_removes_tails() {
        let mut engine = setup(4, 128); sample(&mut engine, &[1.0]);
        for track in 0..4 { engine.track(track, 1.0, 0.0, 1.0, true); }
        engine.voice(0, 0, 1.0, 1.0, 0.0, 0, false); engine.render();
        engine.track(0, 1.0, 0.0, 1.0, false);
        for _ in 0..30 { assert!(output(&mut engine).iter().all(|value| value.abs() < 1e-10)); }
        assert!(engine.delays.iter().flat_map(|delay| delay.iter()).any(|value| value.abs() > 1e-8));
        engine.reset();
        assert!(engine.delays.iter().all(|delay| delay.iter().all(|value| *value == 0.0)));
        assert!(output(&mut engine).iter().all(|value| *value == 0.0));
    }

    #[test]
    fn wet_has_delayed_stereo_tail_and_zero_percent_is_dry() {
        let mut wet = setup(1, 128); sample(&mut wet, &[1.0]); wet.track(0, 1.0, 0.0, 1.0, true);
        wet.voice(0, 0, 1.0, 1.0, 0.0, 0, false);
        let mut energy = 0.0;
        for block in 0..20 { let out = output(&mut wet); if block < 4 { assert!(out.iter().all(|value| *value == 0.0)); } energy += out.iter().map(|value| value.abs()).sum::<f32>(); }
        assert!(energy > 0.1);
        let mut dry = setup(1, 128); sample(&mut dry, &[1.0]); dry.track(0, 1.0, 0.0, 0.0, true);
        dry.voice(0, 0, 1.0, 1.0, 0.0, 0, false);
        let out = output(&mut dry); near(out[0], std::f32::consts::FRAC_1_SQRT_2);
        for _ in 0..20 { assert!(output(&mut dry).iter().all(|value| *value == 0.0)); }
    }

    #[test]
    fn gain_transitions_finish_within_32_samples() {
        let mut engine = setup(1, 64); sample(&mut engine, &[1.0]); engine.track(0, 1.0, -1.0, 0.0, true);
        engine.voice(0, 0, 1.0, 1.0, -1.0, 0, true); engine.render(); engine.track(0, 0.0, -1.0, 0.0, true);
        let out = output(&mut engine); near(out[0], 31.0 / 32.0); assert!(out[31..64].iter().all(|value| *value == 0.0));
    }
}
