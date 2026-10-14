//! WSOLA time-stretcher.
//!
//! Pitch-preserving speed change for interleaved `f32` frames at the source rate, used by the decode thread between
//! symphonia and the resampler. Parameters for sample rate `sr` and speed `α = pct / 100`:
//!
//! - frame `N = 2·round(0.0125·sr)` (≈ 25 ms: 1102 at 44.1 kHz, 1200 at 48 kHz), periodic Hann window (50 % overlap
//!   sums to exactly 1);
//! - synthesis hop `Hs = N/2`; **nominal analysis positions `p_k = round(k·Hs·α)`**, computed in integers as
//!   `(k·Hs·speed_pct + 50) / 100` and never accumulated, so the long-run speed is exactly `α` (no drift);
//! - tolerance `Δ = round(0.010·sr)`: frame `k` is read from `q_k = p_k + δ_k` with `δ_k ∈ [−Δ, Δ]` chosen to maximise
//!   the normalised cross-correlation with the natural continuation of frame `k−1` (a mono mix decimated ×4 searched
//!   in steps of 4, then refined at full rate ±3).
//!
//! # Timeline
//! The input is conceptually preceded by `Hs` frames of silence, so frame `k` is centred on source frame `q_k`. The
//! output frame at the hop boundary `K·Hs` is exactly the centre sample of frame `K−1` (window weight 1, the other
//! window's weight 0), hence:
//!
//! - output frame `t ≥ Hs` carries the nominal source position `α·(t − Hs)`: [`Wsola::latency_frames`] (`Hs`) frames
//!   of exact silence come first;
//! - after `K` hops, the next output frame is the hop boundary whose nominal source position is `p_{K−1}`
//!   ([`Wsola::nominal_input_pos`]) and whose audible source frame is `q_{K−1}` ([`Wsola::actual_input_pos`]);
//! - [`Wsola::drain`] emits exactly `Hs + ⌈L·100/pct⌉` frames in total for `L` pushed frames.
//!
//! # Similarity
//! The search weights the correlation with SoundTouch's centre preference `(ncc + 0.1)·(1 − 0.25·u²)`,
//! `u = δ/Δ`. Among near-equal pitch-period candidates it keeps the one closest to the nominal position, so the audible
//! position stays within about half a pitch period of `p_k` instead of drifting to the edge of the tolerance window. In
//! silence every candidate scores 0 and `δ = 0`.
//!
//! At exactly 100 % the stretcher is an identity delayed by `Hs` (no search); the decode chain bypasses it anyway.
//!
//! The decode thread is not real-time, but the steady state still does not allocate: every scratch buffer is sized in
//! [`Wsola::new`], and the input buffer is compacted in place. All slicing is checked (`get(..)`); nothing here panics.

use std::fmt;

/// Lowest speed the stretcher accepts; lower values are clamped (the engine's range is 50..=200 %, step 5).
pub const MIN_SPEED_PCT: u32 = 50;
/// Highest speed the stretcher accepts; higher values are clamped.
pub const MAX_SPEED_PCT: u32 = 200;
/// The identity speed: no search, output = input delayed by [`Wsola::latency_frames`]. The decode chain bypasses the
/// stretcher at this speed.
pub const UNITY_SPEED_PCT: u32 = 100;

/// Decimation of the coarse search (mono mix summed in groups of 4, candidates every 4 frames).
const DECIMATION: usize = 4;
/// Full-rate refinement radius around the best coarse candidate.
const REFINE_RADIUS: u64 = 3;
/// Hops whose actual read position is remembered for [`Wsola::hop_positions`] (≈ 0.8 s at 44.1 kHz).
const HISTORY: usize = 64;
/// Floors that keep degenerate sample rates (≤ 1.3 kHz) usable instead of producing empty frames.
const MIN_HOP: usize = 16;
const MIN_TOLERANCE: usize = 4;
/// SoundTouch's centre preference: `score = (ncc + CENTRE_BIAS)·(1 − CENTRE_WEIGHT·u²)`, `u = δ/Δ ∈ [−1, 1]`.
const CENTRE_BIAS: f64 = 0.1;
const CENTRE_WEIGHT: f64 = 0.25;
/// Below this energy product a candidate counts as silence (correlation 0).
const SILENCE: f64 = 1e-24;

/// Pitch-preserving time-stretcher for interleaved `f32` frames at the source rate.
///
/// Positions (`p_k`, `q_k`, pushed frames) count source frames since the last [`Wsola::reset`].
#[derive(Clone)]
pub struct Wsola {
    sample_rate: u32,
    channels: usize,
    /// `N`.
    frame: usize,
    /// `Hs = N/2`.
    hop: usize,
    /// `Δ`.
    tolerance: usize,
    speed_pct: u32,
    /// Periodic Hann, `N` points.
    window: Vec<f32>,
    /// Interleaved padded input: frame `i` of this buffer is padded frame `base + i`. The padded timeline is the source
    /// preceded by `Hs` frames of silence, so padded frame `j` is source frame `j − Hs`, and a frame read from padded
    /// start `q` is centred on source frame `q`.
    input: Vec<f32>,
    base: u64,
    /// Source frames pushed since the last reset (the zero padding added by `drain` is not counted).
    pushed: u64,
    /// Hops emitted since the last reset (= `k` of the next frame).
    hops: u64,
    /// `q_{k−1}` (padded start of the previous frame).
    prev_q: u64,
    /// Output frames emitted since the last reset.
    emitted: u64,
    /// Second half of the previous windowed frame, `Hs` interleaved frames.
    overlap: Vec<f32>,
    /// `q_k` of the last [`HISTORY`] hops, indexed by `k % HISTORY`.
    history: [u64; HISTORY],
    // Search scratch, sized in `new` (never reallocated).
    mono_cont: Vec<f32>,
    mono_region: Vec<f32>,
    dec_cont: Vec<f32>,
    dec_region: Vec<f32>,
    dec_energy: Vec<f64>,
}

impl Wsola {
    /// A stretcher for `channels` interleaved channels at `sample_rate` Hz, at 100 % speed. `channels` 0 counts as 1.
    #[must_use]
    pub fn new(sample_rate: u32, channels: usize) -> Self {
        let sr = sample_rate as usize;
        // N = 2·round(sr/80): 1102 at 44.1 kHz (Hs = 551), 1200 at 48 kHz (Hs = 600). Δ = round(sr/100).
        let hop = ((sr + 40) / 80).max(MIN_HOP);
        let frame = 2 * hop;
        let tolerance = ((sr + 50) / 100).max(MIN_TOLERANCE);
        let channels = channels.max(1);
        let region = frame + 2 * tolerance + 1;
        let mut wsola = Self {
            sample_rate,
            channels,
            frame,
            hop,
            tolerance,
            speed_pct: UNITY_SPEED_PCT,
            window: periodic_hann(frame),
            // Steady state holds ≈ N + 2Δ + Hs frames plus one pushed packet; start with room for twice that.
            input: Vec::with_capacity(2 * (region + hop + 4096) * channels),
            base: 0,
            pushed: 0,
            hops: 0,
            prev_q: 0,
            emitted: 0,
            overlap: vec![0.0; hop * channels],
            history: [0; HISTORY],
            mono_cont: Vec::with_capacity(frame),
            mono_region: Vec::with_capacity(region),
            dec_cont: Vec::with_capacity(frame / DECIMATION + 1),
            dec_region: Vec::with_capacity(region / DECIMATION + 1),
            dec_energy: Vec::with_capacity(region / DECIMATION + 2),
        };
        wsola.reset();
        wsola
    }

    /// Sets the speed (clamped to [`MIN_SPEED_PCT`]..=[`MAX_SPEED_PCT`]) and resets: the decode thread calls it only
    /// right after a flush, and a mid-stream change would otherwise make `p_k` jump.
    pub fn set_speed(&mut self, speed_pct: u32) {
        self.speed_pct = speed_pct.clamp(MIN_SPEED_PCT, MAX_SPEED_PCT);
        self.reset();
    }

    /// Input frames at the source rate. A trailing partial frame (length not a multiple of the channel count) is
    /// ignored.
    pub fn push(&mut self, interleaved: &[f32]) {
        let frames = interleaved.len() / self.channels;
        let whole = interleaved
            .get(..frames * self.channels)
            .unwrap_or_default();
        self.input.extend_from_slice(whole);
        self.pushed += frames as u64;
    }

    /// Appends every hop the buffered input allows to `out`; returns the frame count (a multiple of `Hs`).
    pub fn pull(&mut self, out: &mut Vec<f32>) -> usize {
        let mut frames = 0;
        while self.avail_end() >= self.need_end(self.hops) {
            frames += self.emit_hop(out, self.hop);
        }
        frames
    }

    /// Zero-pads the input and flushes the tail: after it, exactly `Hs + ⌈L·100/pct⌉` frames have been emitted since
    /// the last reset for `L` pushed frames (0 if nothing was pushed). Then resets (the speed is kept), so the next
    /// push starts a new stream at nominal position 0. Returns the frames appended by this call.
    pub fn drain(&mut self, out: &mut Vec<f32>) -> usize {
        let target = self.output_frames_for(self.pushed);
        let mut frames = 0;
        while self.emitted < target {
            let need = self.need_end(self.hops);
            self.pad_to(need);
            let take = usize::try_from(target - self.emitted)
                .unwrap_or(usize::MAX)
                .min(self.hop);
            frames += self.emit_hop(out, take);
        }
        self.reset();
        frames
    }

    /// Drops all buffered input and output state; positions restart at 0. The speed is kept.
    pub fn reset(&mut self) {
        self.input.clear();
        // The `Hs` frames of silence that precede the source on the padded timeline.
        self.input.resize(self.hop * self.channels, 0.0);
        self.base = 0;
        self.pushed = 0;
        self.hops = 0;
        self.prev_q = 0;
        self.emitted = 0;
        self.overlap.fill(0.0);
    }

    /// `N/2` frames: output frame `t` carries the nominal source position `α·(t − latency)`, and the first `latency`
    /// output frames after a reset are silence.
    #[must_use]
    pub fn latency_frames(&self) -> usize {
        self.hop
    }

    /// `p_k` of the last emitted hop, relative to the last reset (source frames): the nominal source position of the
    /// hop boundary at [`Self::output_frames_emitted`], i.e. of the next output frame (0 before the first hop). For the
    /// Sync markers.
    #[must_use]
    pub fn nominal_input_pos(&self) -> u64 {
        self.hops.checked_sub(1).map_or(0, |k| self.nominal(k))
    }

    /// `q_k = p_k + δ_k` of the last emitted hop (source frames since the last reset): the source frame that is
    /// actually audible at the hop boundary at [`Self::output_frames_emitted`] (0 before the first hop). Diagnostics:
    /// `actual − nominal` is the alignment offset `δ`, bounded by `±Δ`.
    #[must_use]
    pub fn actual_input_pos(&self) -> u64 {
        if self.hops == 0 { 0 } else { self.prev_q }
    }

    /// `(p_k, q_k)` of hop `k` (source frames since the last reset) while it is among the last 64 emitted hops.
    #[must_use]
    pub fn hop_positions(&self, k: u64) -> Option<(u64, u64)> {
        if k >= self.hops || self.hops - k > HISTORY as u64 {
            return None;
        }
        let slot = usize::try_from(k % HISTORY as u64).ok()?;
        self.history.get(slot).map(|&q| (self.nominal(k), q))
    }

    /// `p_k = round(k·Hs·α)` for any hop `k`, in integers: `(k·Hs·speed_pct + 50) / 100`.
    #[must_use]
    pub fn nominal_pos_of_hop(&self, k: u64) -> u64 {
        self.nominal(k)
    }

    /// Total output frames (latency included) that `input_frames` source frames produce once drained:
    /// `Hs + ⌈input·100/pct⌉`, or 0 for no input.
    #[must_use]
    pub fn output_frames_for(&self, input_frames: u64) -> u64 {
        if input_frames == 0 {
            return 0;
        }
        let pct = u128::from(self.speed_pct);
        let stretched = (u128::from(input_frames) * 100).div_ceil(pct);
        u64::try_from(stretched)
            .unwrap_or(u64::MAX)
            .saturating_add(self.hop as u64)
    }

    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[must_use]
    pub fn channels(&self) -> usize {
        self.channels
    }

    #[must_use]
    pub fn speed_pct(&self) -> u32 {
        self.speed_pct
    }

    /// `N`.
    #[must_use]
    pub fn frame_frames(&self) -> usize {
        self.frame
    }

    /// `Hs`.
    #[must_use]
    pub fn hop_frames(&self) -> usize {
        self.hop
    }

    /// `Δ`.
    #[must_use]
    pub fn tolerance_frames(&self) -> usize {
        self.tolerance
    }

    /// Source frames pushed since the last reset.
    #[must_use]
    pub fn input_frames_pushed(&self) -> u64 {
        self.pushed
    }

    /// Output frames emitted since the last reset (latency included).
    #[must_use]
    pub fn output_frames_emitted(&self) -> u64 {
        self.emitted
    }

    /// Hops emitted since the last reset.
    #[must_use]
    pub fn hops_emitted(&self) -> u64 {
        self.hops
    }

    // ---- internals ------------------------------------------------------------------------------------------------

    fn searching(&self) -> bool {
        self.speed_pct != UNITY_SPEED_PCT
    }

    fn nominal(&self, k: u64) -> u64 {
        let v = (u128::from(k) * self.hop as u128 * u128::from(self.speed_pct) + 50) / 100;
        u64::try_from(v).unwrap_or(u64::MAX)
    }

    /// One past the last padded frame held.
    fn avail_end(&self) -> u64 {
        self.base + (self.input.len() / self.channels) as u64
    }

    /// Allowed padded start positions `[lo, hi]` of frame `k`.
    fn bounds(&self, k: u64) -> (u64, u64) {
        if k == 0 {
            // Frame 0 is centred on source frame 0: half silence, half signal; no previous frame to match.
            return (0, 0);
        }
        let p = self.nominal(k);
        if !self.searching() {
            return (p, p);
        }
        let hi = p.saturating_add(self.tolerance as u64);
        // Frames after the first never read the leading silence (q ≥ Hs ⇔ source ≥ 0 at the window start).
        let lo = p
            .saturating_sub(self.tolerance as u64)
            .max(self.hop as u64)
            .min(hi);
        (lo, hi)
    }

    /// Padded end of the input that frame `k` needs (candidates and, when searching, the continuation).
    fn need_end(&self, k: u64) -> u64 {
        let (_, hi) = self.bounds(k);
        let mut end = hi.saturating_add(self.frame as u64);
        if k > 0 && self.searching() {
            end = end.max(self.prev_q.saturating_add((self.hop + self.frame) as u64));
        }
        end
    }

    fn pad_to(&mut self, end: u64) {
        let avail = self.avail_end();
        if end > avail {
            let extra = usize::try_from(end - avail).unwrap_or(0) * self.channels;
            self.input.resize(self.input.len() + extra, 0.0);
        }
    }

    /// Drops input before padded frame `keep_from`, amortised (only once at least a hop is dead).
    fn discard_before(&mut self, keep_from: u64) {
        if keep_from < self.base.saturating_add(self.hop as u64) {
            return;
        }
        let dead_frames = usize::try_from(keep_from - self.base).unwrap_or(usize::MAX);
        let dead = dead_frames
            .saturating_mul(self.channels)
            .min(self.input.len());
        self.input.drain(..dead);
        self.base += (dead / self.channels) as u64;
    }

    /// Synthesises frame `k = hops` and appends the first `take` (≤ Hs) frames of the hop to `out`.
    fn emit_hop(&mut self, out: &mut Vec<f32>, take: usize) -> usize {
        let k = self.hops;
        let q = self.choose_start(k);
        let take = take.min(self.hop);
        let ch = self.channels;
        out.reserve(take * ch);
        let segment = frames_at(&self.input, self.base, ch, q, self.frame)
            .and_then(|s| s.split_at_checked(self.hop * ch));
        match segment {
            Some((first, second)) => {
                let (rising, falling) = self
                    .window
                    .split_at_checked(self.hop)
                    .unwrap_or((&self.window, &[]));
                // Emit overlap + w·x[q .. q+Hs].
                for ((o, x), w) in self
                    .overlap
                    .chunks_exact(ch)
                    .zip(first.chunks_exact(ch))
                    .zip(rising)
                    .take(take)
                {
                    out.extend(o.iter().zip(x).map(|(o, x)| o + w * x));
                }
                // Keep w·x[q+Hs .. q+N] as the next overlap.
                for ((o, x), w) in self
                    .overlap
                    .chunks_exact_mut(ch)
                    .zip(second.chunks_exact(ch))
                    .zip(falling)
                {
                    for (o, x) in o.iter_mut().zip(x) {
                        *o = w * x;
                    }
                }
            }
            None => {
                // Unreachable by construction (`need_end` gates every hop); degrade to the fading overlap rather
                // than panic on the decode thread.
                out.extend(self.overlap.iter().take(take * ch));
                self.overlap.fill(0.0);
            }
        }
        if let Some(slot) = usize::try_from(k % HISTORY as u64)
            .ok()
            .and_then(|i| self.history.get_mut(i))
        {
            *slot = q;
        }
        self.prev_q = q;
        self.hops += 1;
        self.emitted += take as u64;
        let (next_lo, _) = self.bounds(self.hops);
        self.discard_before(next_lo.min(q.saturating_add(self.hop as u64)));
        take
    }

    /// `q_k`: the nominal position, or the best-aligned candidate around it.
    fn choose_start(&mut self, k: u64) -> u64 {
        let (lo, hi) = self.bounds(k);
        if lo >= hi {
            return lo;
        }
        self.search(k, lo, hi)
    }

    /// The search: maximise the (centre-weighted) normalised cross-correlation of the natural continuation of frame
    /// `k−1` with the candidates in `[lo, hi]`: coarse on a ×4-decimated mono mix, then ±3 at full rate.
    fn search(&mut self, k: u64, lo: u64, hi: u64) -> u64 {
        let p = self.nominal(k);
        let fallback = p.clamp(lo, hi);
        let n = self.frame;
        let span = usize::try_from(hi - lo).unwrap_or(0);
        let cont_start = self.prev_q.saturating_add(self.hop as u64);
        let ch = self.channels;
        {
            let (Some(cont), Some(region)) = (
                frames_at(&self.input, self.base, ch, cont_start, n),
                frames_at(&self.input, self.base, ch, lo, span + n),
            ) else {
                return fallback;
            };
            mono_into(cont, ch, &mut self.mono_cont);
            mono_into(region, ch, &mut self.mono_region);
        }
        decimate_into(&self.mono_cont, &mut self.dec_cont);
        decimate_into(&self.mono_region, &mut self.dec_region);
        self.dec_energy.clear();
        self.dec_energy.push(0.0);
        let mut acc = 0.0_f64;
        for &x in &self.dec_region {
            acc += f64::from(x) * f64::from(x);
            self.dec_energy.push(acc);
        }

        // Coarse: candidates every DECIMATION frames from `lo`.
        let nd = self.dec_cont.len();
        let ref_energy = energy(&self.dec_cont);
        let mut best = fallback;
        let mut best_score = f64::NEG_INFINITY;
        for m in 0..=span / DECIMATION {
            let (Some(cand), Some(e0), Some(e1)) = (
                self.dec_region.get(m..m + nd),
                self.dec_energy.get(m),
                self.dec_energy.get(m + nd),
            ) else {
                break;
            };
            let q = lo + (m * DECIMATION) as u64;
            let s = self.score(
                f64::from(dot(&self.dec_cont, cand)),
                e1 - e0,
                ref_energy,
                q,
                p,
            );
            if s > best_score {
                best_score = s;
                best = q;
            }
        }

        // Refine at full rate around the coarse winner.
        let ref_energy = energy(&self.mono_cont);
        let r_lo = best.saturating_sub(REFINE_RADIUS).max(lo);
        let r_hi = best.saturating_add(REFINE_RADIUS).min(hi);
        let mut refined = best;
        let mut refined_score = f64::NEG_INFINITY;
        for q in r_lo..=r_hi {
            let off = usize::try_from(q - lo).unwrap_or(usize::MAX);
            let Some(cand) = self.mono_region.get(off..off.saturating_add(n)) else {
                break;
            };
            let s = self.score(
                f64::from(dot(&self.mono_cont, cand)),
                energy(cand),
                ref_energy,
                q,
                p,
            );
            if s > refined_score {
                refined_score = s;
                refined = q;
            }
        }
        refined
    }

    fn score(&self, corr: f64, cand_energy: f64, ref_energy: f64, q: u64, p: u64) -> f64 {
        let denom = cand_energy * ref_energy;
        let ncc = if denom > SILENCE {
            corr / denom.sqrt()
        } else {
            0.0
        };
        let u = (q as f64 - p as f64) / self.tolerance as f64;
        (ncc + CENTRE_BIAS) * (1.0 - CENTRE_WEIGHT * u * u)
    }
}

impl fmt::Debug for Wsola {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Wsola")
            .field("sample_rate", &self.sample_rate)
            .field("channels", &self.channels)
            .field("frame", &self.frame)
            .field("hop", &self.hop)
            .field("tolerance", &self.tolerance)
            .field("speed_pct", &self.speed_pct)
            .field("pushed", &self.pushed)
            .field("hops", &self.hops)
            .field("emitted", &self.emitted)
            .finish_non_exhaustive()
    }
}

/// `len` interleaved frames of `input` (whose first frame is padded frame `base`) from padded frame `start`.
fn frames_at(input: &[f32], base: u64, channels: usize, start: u64, len: usize) -> Option<&[f32]> {
    let off = usize::try_from(start.checked_sub(base)?)
        .ok()?
        .checked_mul(channels)?;
    input.get(off..off.checked_add(len.checked_mul(channels)?)?)
}

/// Periodic Hann window of `n` points: `w[i] = 0.5 − 0.5·cos(2πi/n)`, so `w[i] + w[i + n/2] = 1`.
fn periodic_hann(n: usize) -> Vec<f32> {
    let step = std::f64::consts::TAU / n.max(1) as f64;
    (0..n)
        .map(|i| (0.5 - 0.5 * (step * i as f64).cos()) as f32)
        .collect()
}

/// `dst = Σ_channels src` per frame (a mono mix; the scale does not matter for a normalised correlation).
fn mono_into(src: &[f32], channels: usize, dst: &mut Vec<f32>) {
    dst.clear();
    if channels == 1 {
        dst.extend_from_slice(src);
    } else {
        dst.extend(src.chunks_exact(channels).map(|f| f.iter().sum::<f32>()));
    }
}

/// Sums groups of [`DECIMATION`] samples (a box low-pass plus ×4 decimation).
fn decimate_into(src: &[f32], dst: &mut Vec<f32>) {
    dst.clear();
    let (groups, _) = src.as_chunks::<DECIMATION>();
    dst.extend(groups.iter().map(|g| g.iter().sum::<f32>()));
}

fn energy(x: &[f32]) -> f64 {
    f64::from(dot(x, x))
}

/// Dot product over the common length, in 8 independent lanes (vectorises; ≈ 1e-6 relative error over a frame).
fn dot(a: &[f32], b: &[f32]) -> f32 {
    const LANES: usize = 8;
    let len = a.len().min(b.len());
    let (a, b) = (
        a.get(..len).unwrap_or_default(),
        b.get(..len).unwrap_or_default(),
    );
    let ((ca, ra), (cb, rb)) = (a.as_chunks::<LANES>(), b.as_chunks::<LANES>());
    let tail: f32 = ra.iter().zip(rb).map(|(x, y)| x * y).sum();
    let mut acc = [0.0_f32; LANES];
    for (xa, xb) in ca.iter().zip(cb) {
        for ((s, x), y) in acc.iter_mut().zip(xa).zip(xb) {
            *s += x * y;
        }
    }
    acc.iter().sum::<f32>() + tail
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::cast_precision_loss)]
mod tests {
    use super::*;
    use crate::dsp::signals::{SineGen, VoiceGen};

    fn run(w: &mut Wsola, input: &[f32], chunk_frames: usize) -> Vec<f32> {
        let ch = w.channels();
        let mut out = Vec::new();
        for c in input.chunks(chunk_frames * ch) {
            w.push(c);
            w.pull(&mut out);
        }
        w.drain(&mut out);
        out
    }

    #[test]
    fn parameters_follow_the_spec() {
        let w = Wsola::new(44_100, 2);
        assert_eq!(
            (w.frame_frames(), w.hop_frames(), w.tolerance_frames()),
            (1102, 551, 441)
        );
        assert_eq!(w.latency_frames(), 551);
        let w = Wsola::new(48_000, 1);
        assert_eq!(
            (w.frame_frames(), w.hop_frames(), w.tolerance_frames()),
            (1200, 600, 480)
        );
        // Degenerate inputs never yield empty frames.
        let w = Wsola::new(0, 0);
        assert_eq!(w.channels(), 1);
        assert!(w.hop_frames() >= MIN_HOP && w.tolerance_frames() >= MIN_TOLERANCE);
    }

    #[test]
    fn hann_halves_sum_to_one() {
        for n in [1102_usize, 1200, 32] {
            let w = periodic_hann(n);
            let (a, b) = w.split_at(n / 2);
            for (x, y) in a.iter().zip(b) {
                assert!((x + y - 1.0).abs() < 1e-6);
            }
            assert!(w[0].abs() < 1e-9 && (w[n / 2] - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn unity_speed_is_a_delayed_identity() {
        let mut w = Wsola::new(44_100, 2);
        let mut g = VoiceGen::new(44_100);
        let mut input = Vec::new();
        g.fill(&mut input, 30_000, 2);
        let out = run(&mut w, &input, 1_152);
        let lat = 551 * 2;
        assert_eq!(out.len(), lat + input.len());
        assert!(
            out[..lat].iter().all(|&x| x == 0.0),
            "latency frames are silence"
        );
        let max_err = out[lat..]
            .iter()
            .zip(&input)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(max_err < 1e-6, "max error {max_err}");
    }

    #[test]
    fn drained_length_is_exact_for_every_speed() {
        for pct in (50..=200).step_by(5) {
            for len in [0_usize, 1, 550, 551, 4_410, 44_101] {
                let mut w = Wsola::new(44_100, 1);
                w.set_speed(pct);
                let mut input = Vec::new();
                SineGen::new(44_100, 440.0, 0.5).fill(&mut input, len, 1);
                let out = run(&mut w, &input, 1_000);
                let expected = if len == 0 {
                    0
                } else {
                    551 + (len as u64 * 100).div_ceil(u64::from(pct))
                };
                assert_eq!(out.len() as u64, expected, "pct {pct}, len {len}");
                assert_eq!(w.output_frames_emitted(), 0, "drain resets");
            }
        }
    }

    #[test]
    fn nominal_positions_are_absolute_and_exact() {
        let mut w = Wsola::new(44_100, 1);
        w.set_speed(75);
        let mut g = VoiceGen::new(44_100);
        let mut input = Vec::new();
        let mut out = Vec::new();
        for _ in 0..200 {
            input.clear();
            g.fill(&mut input, 1_152, 1);
            w.push(&input);
            w.pull(&mut out);
            let k = w.hops_emitted();
            if k > 0 {
                // p_{k−1} = round((k−1)·Hs·0.75), never an accumulated rounded hop.
                let exact = ((k - 1) as f64 * 551.0 * 0.75).round() as u64;
                assert_eq!(w.nominal_input_pos(), exact);
                assert_eq!(w.output_frames_emitted(), k * 551);
                let delta = w.actual_input_pos() as i64 - w.nominal_input_pos() as i64;
                assert!(delta.unsigned_abs() <= 441, "δ {delta} within ±Δ");
                assert_eq!(
                    w.hop_positions(k - 1),
                    Some((w.nominal_input_pos(), w.actual_input_pos()))
                );
            }
        }
        assert_eq!(w.hop_positions(w.hops_emitted()), None);
        assert_eq!(w.hop_positions(0), None, "beyond the history");
    }

    #[test]
    fn output_is_independent_of_push_granularity() {
        let mut input = Vec::new();
        VoiceGen::new(48_000).fill(&mut input, 50_000, 2);
        for pct in [55, 130, 200] {
            let mut a = Wsola::new(48_000, 2);
            a.set_speed(pct);
            let mut b = a.clone();
            assert_eq!(
                run(&mut a, &input, 97),
                run(&mut b, &input, 4_096),
                "pct {pct}"
            );
        }
    }

    #[test]
    fn silence_stays_on_the_nominal_grid() {
        let mut w = Wsola::new(44_100, 1);
        w.set_speed(150);
        let mut out = Vec::new();
        w.push(&vec![0.0; 44_100]);
        w.pull(&mut out);
        assert!(w.hops_emitted() > 10);
        assert_eq!(w.actual_input_pos(), w.nominal_input_pos());
        assert!(out.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn channels_share_one_alignment() {
        let mut mono = Vec::new();
        VoiceGen::new(44_100).fill(&mut mono, 20_000, 1);
        let stereo: Vec<f32> = mono.iter().flat_map(|&x| [x, -0.5 * x]).collect();
        let mut w = Wsola::new(44_100, 2);
        w.set_speed(140);
        let out = run(&mut w, &stereo, 1_152);
        for f in out.as_chunks::<2>().0 {
            assert!((f[1] + 0.5 * f[0]).abs() < 1e-6);
        }
    }

    #[test]
    fn set_speed_clamps_and_resets() {
        let mut w = Wsola::new(44_100, 1);
        w.push(&[0.1; 5_000]);
        w.set_speed(10);
        assert_eq!(w.speed_pct(), MIN_SPEED_PCT);
        assert_eq!(w.input_frames_pushed(), 0);
        w.set_speed(1_000);
        assert_eq!(w.speed_pct(), MAX_SPEED_PCT);
        // A trailing partial frame is ignored.
        let mut w = Wsola::new(44_100, 2);
        w.push(&[0.0; 5]);
        assert_eq!(w.input_frames_pushed(), 2);
    }

    #[test]
    fn sine_alignment_keeps_phase() {
        // A 1 kHz sine at 1.5×: every splice is phase-aligned, so the output stays a clean sine (no step > the sine's
        // own maximum slope plus a small margin).
        let mut input = Vec::new();
        SineGen::new(44_100, 1_000.0, 0.8).fill(&mut input, 44_100, 1);
        let mut w = Wsola::new(44_100, 1);
        w.set_speed(150);
        let out = run(&mut w, &input, 1_152);
        let slope = 0.8 * std::f32::consts::TAU * 1_000.0 / 44_100.0;
        let max_step = out
            .windows(2)
            .skip(2 * 551)
            .map(|p| (p[1] - p[0]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_step < slope * 1.05,
            "max step {max_step} vs slope {slope}"
        );
    }
}
