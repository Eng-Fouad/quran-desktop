//! Channel map (mono duplicated, stereo to the first `out_ch` channels, extra device channels silent), 4 ms fades and
//! the gain ramp (docs/ARCHITECTURE.md §2.3.4). Owner: WP4a.
//!
//! [`map_channels`] and [`Fade`] run on the decode thread. [`GainRamp`] and [`volume_gain`] are for the cpal callback
//! (WP4c): they never allocate, lock, log or panic, and touch only the buffer they are given.

use crate::shared::FADE_MS;

/// Frames in `ms` milliseconds at `rate` Hz, rounded to the nearest frame.
#[must_use]
pub const fn ms_to_frames(ms: u32, rate: u32) -> usize {
    ((ms as u64 * rate as u64 + 500) / 1000) as usize
}

/// Appends `src` (interleaved, `src_ch` channels) to `out` as `out_ch` interleaved channels:
/// - equal counts: copied;
/// - mono → `out_ch ≥ 2`: duplicated to the first two channels (left and right), the others silent;
/// - `src_ch ≥ 2` → mono device: the average of the first two channels;
/// - otherwise the first `min(src_ch, out_ch)` channels are copied and extra device channels are silent.
///
/// A trailing partial source frame is ignored; a zero channel count appends nothing.
pub fn map_channels(src: &[f32], src_ch: usize, out_ch: usize, out: &mut Vec<f32>) {
    if src_ch == 0 || out_ch == 0 {
        return;
    }
    let frames = src.len() / src_ch;
    out.reserve(frames * out_ch);
    if src_ch == out_ch {
        out.extend_from_slice(src.get(..frames * src_ch).unwrap_or_default());
        return;
    }
    for frame in src.chunks_exact(src_ch) {
        match (frame, out_ch) {
            ([m], _) => {
                out.push(*m);
                if out_ch >= 2 {
                    out.push(*m);
                }
                out.extend(std::iter::repeat_n(0.0, out_ch.saturating_sub(2)));
            }
            ([l, r, ..], 1) => out.push(0.5 * (l + r)),
            _ => {
                let copied = src_ch.min(out_ch);
                out.extend(frame.iter().take(copied));
                out.extend(std::iter::repeat_n(0.0, out_ch - copied));
            }
        }
    }
}

/// A raised-cosine fade of [`FADE_MS`] (or any length): `gain(i) = ½ − ½·cos(π·(i + ½)/n)` rising, mirrored falling.
/// Smoother than a linear ramp (no slope discontinuity at either end), so splices and starts never click.
#[derive(Clone, Debug)]
pub struct Fade {
    /// Rising gains, `frames()` entries in (0, 1).
    gains: Vec<f32>,
}

impl Fade {
    /// A [`FADE_MS`] (4 ms) fade at `rate` Hz.
    #[must_use]
    pub fn new(rate: u32) -> Self {
        Self::with_frames(ms_to_frames(FADE_MS, rate))
    }

    /// A fade of `frames` frames (0 = no fade).
    #[must_use]
    pub fn with_frames(frames: usize) -> Self {
        let n = frames as f64;
        let gains = (0..frames)
            .map(|i| (0.5 - 0.5 * (std::f64::consts::PI * (i as f64 + 0.5) / n).cos()) as f32)
            .collect();
        Self { gains }
    }

    /// Length in frames.
    #[must_use]
    pub fn frames(&self) -> usize {
        self.gains.len()
    }

    /// Applies the fade-in to `buf` (interleaved, `channels`), whose first frame is frame `pos` of the fade. Frames at
    /// or past the end of the fade are left untouched. Returns the fade position after `buf` (saturating at
    /// [`Self::frames`]), so a fade can span several buffers.
    pub fn apply_in(&self, buf: &mut [f32], channels: usize, pos: usize) -> usize {
        if channels == 0 {
            return pos;
        }
        let gains = self.gains.get(pos..).unwrap_or_default();
        for (frame, g) in buf.chunks_exact_mut(channels).zip(gains) {
            frame.iter_mut().for_each(|s| *s *= g);
        }
        pos.saturating_add(buf.len() / channels).min(self.frames())
    }

    /// Fades out the last [`Self::frames`] frames of `buf` so its final frame is near silence. A shorter buffer gets
    /// the end of the fade-out curve (it still ends near silence).
    pub fn apply_out_tail(&self, buf: &mut [f32], channels: usize) {
        if channels == 0 {
            return;
        }
        let frames = buf.len() / channels;
        let n = frames.min(self.frames());
        let start = (frames - n) * channels;
        let Some(tail) = buf.get_mut(start..frames * channels) else {
            return;
        };
        // Falling gains for the last n frames: gains[n−1], …, gains[0].
        for (frame, g) in tail
            .chunks_exact_mut(channels)
            .zip(self.gains.iter().take(n).rev())
        {
            frame.iter_mut().for_each(|s| *s *= g);
        }
    }
}

/// The output gain of the cpal callback (§2.3.4 step 3). Real-time safe: no allocation, locking, logging or panics.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GainRamp {
    gain: f32,
}

impl GainRamp {
    /// Starts at `gain` (clamped to 0..=1; NaN ⇒ 0).
    #[must_use]
    pub fn new(gain: f32) -> Self {
        Self {
            gain: sanitize(gain),
        }
    }

    /// The gain applied to the last frame processed.
    #[must_use]
    pub fn gain(&self) -> f32 {
        self.gain
    }

    /// Jumps to `gain` without a ramp (e.g. 0 when output resumes after a pause ramp completed).
    pub fn set(&mut self, gain: f32) {
        self.gain = sanitize(gain);
    }

    /// Volume changes: multiplies `buf` by a gain moving linearly from the current gain to `target` across the whole
    /// buffer (reaching `target` exactly on the last frame). An empty buffer leaves the gain unchanged.
    pub fn apply_linear(&mut self, buf: &mut [f32], channels: usize, target: f32) {
        let target = sanitize(target);
        if channels == 0 {
            return;
        }
        let frames = buf.len() / channels;
        if frames == 0 {
            return;
        }
        let start = self.gain;
        if start == target {
            if target != 1.0 {
                buf.iter_mut().for_each(|s| *s *= target);
            }
            return;
        }
        let step = (target - start) / frames as f32;
        for (i, frame) in buf.chunks_exact_mut(channels).enumerate() {
            let g = start + step * (i + 1) as f32;
            frame.iter_mut().for_each(|s| *s *= g);
        }
        self.gain = target;
    }

    /// Pause/resume ramps: moves towards `target` at a fixed slope of full scale per `ramp_frames` frames (e.g. 8 ms to
    /// silence, [`crate::shared::PAUSE_RAMP_MS`]), holding `target` once reached. Returns how many frames of `buf` were
    /// processed up to and including the first frame at `target` (0 if the gain was already there, `buf`'s frame
    /// count if it never got there); every later frame has exactly `target` applied. `ramp_frames` 0 jumps.
    pub fn apply_slew(
        &mut self,
        buf: &mut [f32],
        channels: usize,
        target: f32,
        ramp_frames: usize,
    ) -> usize {
        let target = sanitize(target);
        if channels == 0 {
            return 0;
        }
        let step = if ramp_frames == 0 {
            f32::INFINITY
        } else {
            1.0 / ramp_frames as f32
        };
        let mut g = self.gain;
        let mut settled = (g == target).then_some(0);
        for (i, frame) in buf.chunks_exact_mut(channels).enumerate() {
            if g != target {
                let diff = target - g;
                // Snap within a hair of one step so float accumulation never adds an extra frame.
                g = if diff.abs() <= step * 1.000_1 {
                    target
                } else {
                    g + step.copysign(diff)
                };
                if g == target {
                    settled = Some(i + 1);
                }
            }
            if g != 1.0 {
                frame.iter_mut().for_each(|s| *s *= g);
            }
        }
        self.gain = g;
        settled.unwrap_or(buf.len() / channels)
    }

    /// Frames [`Self::apply_slew`] needs to reach `target` from the current gain.
    #[must_use]
    pub fn frames_to_reach(&self, target: f32, ramp_frames: usize) -> usize {
        let distance = (sanitize(target) - self.gain).abs();
        // Same snapping as `apply_slew`.
        ((distance * ramp_frames as f32) - 1e-4).ceil().max(0.0) as usize
    }
}

impl Default for GainRamp {
    fn default() -> Self {
        Self::new(1.0)
    }
}

/// Volume slider percent (0..=100) → linear gain, with a perceptual square law: 100 % = 0 dB, 50 % ≈ −12 dB,
/// 10 % = −40 dB, 0 % = silence. Values above 100 count as 100.
#[must_use]
pub fn volume_gain(pct: u32) -> f32 {
    let v = pct.min(100) as f32 / 100.0;
    v * v
}

fn sanitize(g: f32) -> f32 {
    if g.is_nan() { 0.0 } else { g.clamp(0.0, 1.0) }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::float_cmp)]
mod tests {
    use super::*;

    #[test]
    fn frames_from_ms() {
        assert_eq!(ms_to_frames(4, 48_000), 192);
        assert_eq!(ms_to_frames(4, 44_100), 176);
        assert_eq!(ms_to_frames(8, 44_100), 353);
        assert_eq!(ms_to_frames(0, 48_000), 0);
    }

    #[test]
    fn channel_maps() {
        let mut out = Vec::new();
        map_channels(&[0.1, 0.2], 1, 2, &mut out);
        assert_eq!(out, [0.1, 0.1, 0.2, 0.2]);
        out.clear();
        map_channels(&[0.1], 1, 6, &mut out);
        assert_eq!(out, [0.1, 0.1, 0.0, 0.0, 0.0, 0.0]);
        out.clear();
        map_channels(&[0.2, 0.4, 0.6, 0.8], 2, 1, &mut out);
        assert!((out[0] - 0.3).abs() < 1e-7 && (out[1] - 0.7).abs() < 1e-7);
        out.clear();
        map_channels(&[0.1, 0.2], 2, 4, &mut out);
        assert_eq!(out, [0.1, 0.2, 0.0, 0.0]);
        out.clear();
        map_channels(&[0.1, 0.2, 0.3, 0.4, 0.5], 2, 2, &mut out);
        assert_eq!(out, [0.1, 0.2, 0.3, 0.4], "partial frame dropped");
        out.clear();
        map_channels(&[0.5], 1, 1, &mut out);
        assert_eq!(out, [0.5]);
        map_channels(&[0.5], 0, 2, &mut out);
        map_channels(&[0.5], 1, 0, &mut out);
        assert_eq!(out, [0.5]);
        out.clear();
        map_channels(&[0.1, 0.2, 0.3], 3, 2, &mut out);
        assert_eq!(out, [0.1, 0.2]);
    }

    #[test]
    fn fades_rise_and_fall_smoothly() {
        let f = Fade::new(48_000);
        assert_eq!(f.frames(), 192);
        let mut buf = vec![1.0_f32; 2 * 300];
        // A fade-in spanning two buffers equals a single application.
        let (a, b) = buf.split_at_mut(2 * 100);
        let pos = f.apply_in(a, 2, 0);
        assert_eq!(pos, 100);
        assert_eq!(f.apply_in(b, 2, pos), 192);
        let mut one = vec![1.0_f32; 2 * 300];
        f.apply_in(&mut one, 2, 0);
        assert_eq!(buf, one);
        assert!(buf[0] > 0.0 && buf[0] < 1e-4, "starts near silence");
        assert!(buf.windows(2).all(|w| w[1] >= w[0]), "monotonic");
        assert!(
            buf[2 * 192..].iter().all(|&x| x == 1.0),
            "untouched after the fade"
        );
        // Fade-out mirrors it on the tail.
        let mut out = vec![1.0_f32; 2 * 300];
        f.apply_out_tail(&mut out, 2);
        assert!(out[..2 * 108].iter().all(|&x| x == 1.0));
        assert!(out.windows(2).all(|w| w[1] <= w[0]));
        assert!(*out.last().unwrap() < 1e-4);
        // A short tail still ends near silence.
        let mut short = vec![1.0_f32; 10];
        f.apply_out_tail(&mut short, 1);
        assert!(short[9] < 1e-4 && short[0] < 0.1);
        // A finished fade-in is a no-op.
        let mut done = vec![0.7_f32; 8];
        assert_eq!(f.apply_in(&mut done, 2, 192), 192);
        assert!(done.iter().all(|&x| x == 0.7));
        assert_eq!(Fade::with_frames(0).apply_in(&mut done, 2, 0), 0);
    }

    #[test]
    fn linear_gain_ramp() {
        let mut r = GainRamp::new(1.0);
        let mut buf = vec![1.0_f32; 2 * 4];
        r.apply_linear(&mut buf, 2, 0.0);
        assert_eq!(buf, [0.75, 0.75, 0.5, 0.5, 0.25, 0.25, 0.0, 0.0]);
        assert_eq!(r.gain(), 0.0);
        let mut buf = vec![1.0_f32; 4];
        r.apply_linear(&mut buf, 2, 0.0);
        assert_eq!(buf, [0.0; 4], "settled gain applied");
        r.apply_linear(&mut [], 2, 1.0);
        assert_eq!(r.gain(), 0.0, "empty buffer keeps the gain");
        r.set(f32::NAN);
        assert_eq!(r.gain(), 0.0);
        assert_eq!(GainRamp::new(3.0).gain(), 1.0);
        assert_eq!(GainRamp::default().gain(), 1.0);
    }

    #[test]
    fn slew_ramp_for_pause() {
        // 8 ms at 48 kHz = 384 frames from full scale to silence.
        let mut r = GainRamp::new(1.0);
        assert_eq!(r.frames_to_reach(0.0, 384), 384);
        let mut buf = vec![1.0_f32; 2 * 256];
        assert_eq!(r.apply_slew(&mut buf, 2, 0.0, 384), 256, "not yet settled");
        assert!((r.gain() - (1.0 - 256.0 / 384.0)).abs() < 1e-4);
        let mut buf = vec![1.0_f32; 2 * 256];
        let settled = r.apply_slew(&mut buf, 2, 0.0, 384);
        assert!((127..=129).contains(&settled), "settled after {settled}");
        assert!(buf[2 * settled..].iter().all(|&x| x == 0.0));
        assert_eq!(r.gain(), 0.0);
        // Already at the target: settled at frame 0.
        let mut buf = vec![1.0_f32; 4];
        assert_eq!(r.apply_slew(&mut buf, 2, 0.0, 384), 0);
        // Resume ramps up; ramp 0 jumps.
        let mut buf = vec![1.0_f32; 2];
        assert_eq!(r.apply_slew(&mut buf, 1, 1.0, 0), 1);
        assert_eq!(r.gain(), 1.0);
        assert_eq!(r.apply_slew(&mut [], 0, 1.0, 10), 0);
    }

    #[test]
    fn volume_curve() {
        assert_eq!(volume_gain(100), 1.0);
        assert_eq!(volume_gain(0), 0.0);
        assert_eq!(volume_gain(50), 0.25);
        assert_eq!(volume_gain(150), 1.0);
        assert!((volume_gain(10) - 0.01).abs() < 1e-7);
    }
}
