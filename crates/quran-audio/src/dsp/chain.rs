//! The decode thread's DSP chain: [`Wsola`] (speed) → [`Resampler`] (rate) → channel map → fades, with an exact
//! output-frame ⇄ source-position mapping.
//!
//! # Position contract
//! After [`DspChain::reset`] (a flush, or the implicit reset at the end of [`DspChain::drain`]) both counters restart
//! at 0 and **output frame `u` carries source position `u·α` seconds of output time**, i.e.
//! `src_us = u · speed_pct · 1_000_000 / (100 · out_rate)`, which is exactly [`MediaRate::advance_us`] for the chain's
//! [`DspChain::media_rate`]. The chain makes this hold by construction:
//! - WSOLA's analysis positions are absolute (`p_k = round(k·Hs·α)`, never accumulated), so it has no long-run drift;
//!   its `Hs` frames of leading silence are dropped;
//! - rubato's synchronous FFT resampler has an exact `out_rate/src_rate` block ratio, and its startup delay is
//!   trimmed by [`Resampler`].
//!
//! So a Segment marker pushed at the flush frame with the seek position, extrapolated by the callback with
//! [`MediaRate`], is exact, and so is any Sync marker taken from [`DspChain::src_us_at`] or [`DspChain::sync_point`].
//! The audible content may sit up to `±Δ` (10 ms) from the nominal position inside a stretched frame (WSOLA's
//! alignment); [`SyncPoint::actual_src_us`] reports it.
//!
//! # Fades
//! The first 4 ms after every reset are faded in. The chain always holds back the last 4 ms of output, so
//! `drain(out, true)` can fade out the true end of a segment even when no DSP stage has latency (100 %, equal rates).

use super::mix::{self, Fade};
use super::resample::Resampler;
use super::wsola::{MAX_SPEED_PCT, MIN_SPEED_PCT, UNITY_SPEED_PCT, Wsola};
use crate::AudioError;
use crate::shared::MediaRate;

/// The source (decoder) and output (device) formats of a chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StreamFormat {
    /// Decoded file rate (Hz).
    pub src_rate: u32,
    /// Decoded channels (1 or 2 for MP3).
    pub src_channels: usize,
    /// Device rate (Hz).
    pub out_rate: u32,
    /// Device channels.
    pub out_channels: usize,
}

/// A position checkpoint for a Sync marker, at the latest WSOLA hop boundary already released.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SyncPoint {
    /// Chain output frame (since the last reset), at most [`DspChain::out_frames_pulled`].
    pub out_frame: u64,
    /// Exact nominal source position at `out_frame` (µs since the chain origin): the hop's `p_k` mapped through the
    /// resampler's exact ratio, plus the sub-frame remainder. Agrees with [`DspChain::src_us_at`] to within half a
    /// source frame.
    pub src_us: u64,
    /// Source position actually audible there (the WSOLA frame centre `q_k`, µs since the chain origin). Equals
    /// `src_us` when the stretcher is bypassed.
    pub actual_src_us: u64,
}

/// How [`DspChain::deliver`] releases the held-back tail.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Release {
    KeepTail,
    All,
    AllFadeOut,
}

/// WSOLA → rubato → channel map → fades for one source format and one output format.
pub struct DspChain {
    format: StreamFormat,
    speed_pct: u32,
    wsola: Wsola,
    /// WSOLA pre-roll frames still to drop after a reset.
    preroll: usize,
    resampler: Resampler,
    fade: Fade,
    /// Fade-in position (== `fade.frames()` once complete).
    fade_in_pos: usize,
    /// Output frames not yet released (the last `fade.frames()` are always held back by `pull`).
    tail: Vec<f32>,
    stretched: Vec<f32>,
    resampled: Vec<f32>,
    pushed: u64,
    released: u64,
}

impl DspChain {
    /// A chain at `speed_pct` (clamped to 50..=200). 100 bypasses WSOLA; equal rates bypass the resampler.
    ///
    /// # Errors
    /// [`AudioError::Invalid`] for a zero rate or channel count; [`AudioError::Decode`] if rubato rejects the rates.
    pub fn new(format: StreamFormat, speed_pct: u32) -> Result<Self, AudioError> {
        let StreamFormat {
            src_rate,
            src_channels,
            out_rate,
            out_channels,
        } = format;
        if src_rate == 0 || out_rate == 0 || src_channels == 0 || out_channels == 0 {
            return Err(AudioError::Invalid(format!("dsp chain format {format:?}")));
        }
        let speed_pct = speed_pct.clamp(MIN_SPEED_PCT, MAX_SPEED_PCT);
        let mut wsola = Wsola::new(src_rate, src_channels);
        wsola.set_speed(speed_pct);
        let mut chain = Self {
            format,
            speed_pct,
            wsola,
            preroll: 0,
            resampler: Resampler::new(src_rate, out_rate, src_channels)?,
            fade: Fade::new(out_rate),
            fade_in_pos: 0,
            tail: Vec::with_capacity(8192 * out_channels),
            stretched: Vec::with_capacity(8192 * src_channels),
            resampled: Vec::with_capacity(8192 * src_channels),
            pushed: 0,
            released: 0,
        };
        chain.reset();
        Ok(chain)
    }

    #[must_use]
    pub fn format(&self) -> StreamFormat {
        self.format
    }

    #[must_use]
    pub fn speed_pct(&self) -> u32 {
        self.speed_pct
    }

    /// Whether WSOLA is active (speed ≠ 100 %).
    #[must_use]
    pub fn is_stretching(&self) -> bool {
        self.speed_pct != UNITY_SPEED_PCT
    }

    /// The stretcher (diagnostics; it is idle while bypassed).
    #[must_use]
    pub fn stretcher(&self) -> &Wsola {
        &self.wsola
    }

    /// The resampler (passthrough for equal rates).
    #[must_use]
    pub fn resampler(&self) -> &Resampler {
        &self.resampler
    }

    /// File-timeline µs per output frame for markers: `MediaRate::new(speed_pct, out_rate)`.
    #[must_use]
    pub fn media_rate(&self) -> MediaRate {
        MediaRate::new(self.speed_pct, self.format.out_rate)
    }

    /// Flush: drops everything buffered; positions restart at 0 and the next 4 ms are faded in. The speed is kept.
    pub fn reset(&mut self) {
        self.wsola.reset();
        self.resampler.reset();
        self.preroll = if self.is_stretching() {
            self.wsola.latency_frames()
        } else {
            0
        };
        self.fade_in_pos = 0;
        self.tail.clear();
        self.pushed = 0;
        self.released = 0;
    }

    /// Flush with a new speed (clamped to 50..=200; speed changes always flush and re-seek).
    pub fn reset_with_speed(&mut self, speed_pct: u32) {
        self.speed_pct = speed_pct.clamp(MIN_SPEED_PCT, MAX_SPEED_PCT);
        self.wsola.set_speed(self.speed_pct);
        self.reset();
    }

    /// Source frames (interleaved, `src_channels`). A trailing partial frame is ignored.
    pub fn push(&mut self, src: &[f32]) {
        self.pushed += (src.len() / self.format.src_channels) as u64;
        if self.is_stretching() {
            self.wsola.push(src);
        } else {
            self.resampler.push(src);
        }
    }

    /// Appends every output frame (interleaved, `out_channels`) the input allows, except the last 4 ms, which stay
    /// held back for a possible fade-out. Returns the frame count.
    pub fn pull(&mut self, out: &mut Vec<f32>) -> usize {
        self.stretched.clear();
        if self.is_stretching() {
            self.wsola.pull(&mut self.stretched);
            self.feed_resampler();
        }
        self.resampled.clear();
        self.resampler.pull(&mut self.resampled);
        self.deliver(out, Release::KeepTail)
    }

    /// Flushes every stage (zero-padded) and appends the rest of the output; with `fade_out` the last 4 ms are faded
    /// to silence (non-contiguous segment ends, A-B wraps, the end of the queue). In total exactly
    /// [`Self::drained_frames_for`]`(pushed)` frames are released since the last reset. Then resets (fade-in armed).
    /// Returns the frames appended by this call.
    pub fn drain(&mut self, out: &mut Vec<f32>, fade_out: bool) -> usize {
        self.stretched.clear();
        if self.is_stretching() {
            self.wsola.drain(&mut self.stretched);
            self.feed_resampler();
        }
        self.resampled.clear();
        self.resampler.drain(&mut self.resampled);
        let frames = self.deliver(
            out,
            if fade_out {
                Release::AllFadeOut
            } else {
                Release::All
            },
        );
        self.reset();
        frames
    }

    /// Source frames pushed since the last reset.
    #[must_use]
    pub fn src_frames_pushed(&self) -> u64 {
        self.pushed
    }

    /// Output frames released since the last reset.
    #[must_use]
    pub fn out_frames_pulled(&self) -> u64 {
        self.released
    }

    /// Exact source position (µs since the chain origin) of output frame `out_frame` (since the last reset).
    #[must_use]
    pub fn src_us_at(&self, out_frame: u64) -> u64 {
        self.media_rate().advance_us(out_frame)
    }

    /// Source position of output frame `out_frame` in whole source frames (rounded down).
    #[must_use]
    pub fn src_frames_at(&self, out_frame: u64) -> u64 {
        let num =
            u128::from(out_frame) * u128::from(self.speed_pct) * u128::from(self.format.src_rate);
        let den = 100 * u128::from(self.format.out_rate);
        u64::try_from(num / den).unwrap_or(u64::MAX)
    }

    /// The first output frame (since the last reset) whose source position is at or after source frame `src_frame`:
    /// `⌈src·100·out_rate / (pct·src_rate)⌉`. Use it to place a marker at a source position, e.g. a contiguous segment
    /// boundary (the frame is `written_frames + latency`, exactly).
    #[must_use]
    pub fn out_frame_at_src(&self, src_frame: u64) -> u64 {
        let num = u128::from(src_frame) * 100 * u128::from(self.format.out_rate);
        let den = u128::from(self.speed_pct) * u128::from(self.format.src_rate);
        u64::try_from(num.div_ceil(den)).unwrap_or(u64::MAX)
    }

    /// Total output frames that `src_frames` pushed frames yield once drained: `⌈⌈src·100/pct⌉·out_rate/src_rate⌉`
    /// (at most one frame more than [`Self::out_frame_at_src`]).
    #[must_use]
    pub fn drained_frames_for(&self, src_frames: u64) -> u64 {
        let stretched = if self.is_stretching() {
            let v = (u128::from(src_frames) * 100).div_ceil(u128::from(self.speed_pct));
            u64::try_from(v).unwrap_or(u64::MAX)
        } else {
            src_frames
        };
        self.resampler.out_frames_for(stretched)
    }

    /// Output frames still owed for the input pushed so far (what `drain` would add now, plus what later pulls
    /// release): the chain's current processing latency, in output frames.
    #[must_use]
    pub fn pending_out_frames(&self) -> u64 {
        self.drained_frames_for(self.pushed)
            .saturating_sub(self.released)
    }

    /// Upper bound of [`Self::pending_out_frames`] in steady state: WSOLA's look-ahead (`N + Δ + Hs` source frames,
    /// stretched), the resampler's delay and chunking, and the 4 ms fade hold-back.
    #[must_use]
    pub fn latency_frames(&self) -> usize {
        let wsola = if self.is_stretching() {
            let w = &self.wsola;
            let src = (w.frame_frames() + w.tolerance_frames() + w.hop_frames()) as u64;
            (src * 100).div_ceil(u64::from(self.speed_pct)) + (w.hop_frames() as u64)
        } else {
            0
        };
        let resampled = usize::try_from(self.resampler.out_frames_for(wsola)).unwrap_or(usize::MAX);
        resampled
            .saturating_add(self.resampler.latency_frames())
            .saturating_add(self.fade.frames())
    }

    /// The latest WSOLA hop boundary already released, as a Sync-marker checkpoint (at a WSOLA hop boundary, position
    /// from `p_k` mapped through the resampler's exact ratio). In bypass it is the current release point. `out_frame ≤
    /// out_frames_pulled()`, so a marker for it never lies in the future.
    #[must_use]
    pub fn sync_point(&self) -> SyncPoint {
        let at = self.released;
        if !self.is_stretching() {
            let us = self.src_us_at(at);
            return SyncPoint {
                out_frame: at,
                src_us: us,
                actual_src_us: us,
            };
        }
        let src = u128::from(self.format.src_rate);
        let out = u128::from(self.format.out_rate);
        let hop = self.wsola.hop_frames().max(1) as u128;
        // Stretched (pre-roll trimmed) frames behind `at`, the last hop boundary at or before them, and the first
        // chain frame at or after that boundary (≤ at).
        let stretched = u128::from(at) * src / out;
        let j = stretched / hop;
        let boundary = j * hop;
        let out_frame = (boundary * out).div_ceil(src);
        // How far `out_frame` lies past the boundary, in units of 1/out stretched frames.
        let excess = out_frame * src - boundary * out;
        let j = u64::try_from(j).unwrap_or(u64::MAX);
        let (nominal, actual) = self.wsola.hop_positions(j).unwrap_or_else(|| {
            let p = self.wsola.nominal_pos_of_hop(j);
            (p, p)
        });
        let pct = u128::from(self.speed_pct);
        // Nominal: the source advances α stretched frames per stretched frame.
        let src_us =
            (u128::from(nominal) * 100 * out + pct * excess) * 1_000_000 / (100 * out * src);
        // Actual: inside one WSOLA frame the waveform is not stretched, so the content advances 1:1.
        let actual_us = (u128::from(actual) * out + excess) * 1_000_000 / (out * src);
        SyncPoint {
            out_frame: u64::try_from(out_frame).unwrap_or(u64::MAX),
            src_us: u64::try_from(src_us).unwrap_or(u64::MAX),
            actual_src_us: u64::try_from(actual_us).unwrap_or(u64::MAX),
        }
    }

    /// Moves WSOLA output to the resampler, dropping WSOLA's leading silence.
    fn feed_resampler(&mut self) {
        let ch = self.format.src_channels;
        let frames = self.stretched.len() / ch;
        let skip = self.preroll.min(frames);
        self.preroll -= skip;
        self.resampler
            .push(self.stretched.get(skip * ch..).unwrap_or_default());
    }

    /// Channel-maps the resampled block into the tail, applies the pending fade-in, and releases the tail (all of it,
    /// or all but the last 4 ms).
    fn deliver(&mut self, out: &mut Vec<f32>, release: Release) -> usize {
        let och = self.format.out_channels;
        let start = self.tail.len();
        mix::map_channels(
            &self.resampled,
            self.format.src_channels,
            och,
            &mut self.tail,
        );
        if self.fade_in_pos < self.fade.frames()
            && let Some(fresh) = self.tail.get_mut(start..)
        {
            self.fade_in_pos = self.fade.apply_in(fresh, och, self.fade_in_pos);
        }
        let held = self.tail.len() / och;
        let frames = match release {
            Release::KeepTail => held.saturating_sub(self.fade.frames()),
            Release::All => held,
            Release::AllFadeOut => {
                self.fade.apply_out_tail(&mut self.tail, och);
                held
            }
        };
        let n = (frames * och).min(self.tail.len());
        out.extend_from_slice(self.tail.get(..n).unwrap_or_default());
        self.tail.drain(..n);
        self.released += frames as u64;
        frames
    }
}

impl std::fmt::Debug for DspChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DspChain")
            .field("format", &self.format)
            .field("speed_pct", &self.speed_pct)
            .field("pushed", &self.pushed)
            .field("released", &self.released)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::cast_precision_loss)]
mod tests {
    use super::*;
    use crate::dsp::signals::{SineGen, VoiceGen};

    const CD_TO_48K: StreamFormat = StreamFormat {
        src_rate: 44_100,
        src_channels: 1,
        out_rate: 48_000,
        out_channels: 2,
    };

    fn process(chain: &mut DspChain, input: &[f32], chunk: usize, fade_out: bool) -> Vec<f32> {
        let mut out = Vec::new();
        for c in input.chunks(chunk * chain.format().src_channels) {
            chain.push(c);
            chain.pull(&mut out);
        }
        chain.drain(&mut out, fade_out);
        out
    }

    #[test]
    fn stages_move_to_the_decode_thread() {
        fn assert_send<T: Send + 'static>() {}
        assert_send::<DspChain>();
        assert_send::<Wsola>();
        assert_send::<Resampler>();
        assert_send::<Fade>();
    }

    #[test]
    fn rejects_bad_formats() {
        let bad = StreamFormat {
            src_channels: 0,
            ..CD_TO_48K
        };
        assert!(matches!(
            DspChain::new(bad, 100),
            Err(AudioError::Invalid(_))
        ));
        let bad = StreamFormat {
            out_rate: 0,
            ..CD_TO_48K
        };
        assert!(DspChain::new(bad, 100).is_err());
        assert_eq!(DspChain::new(CD_TO_48K, 10).unwrap().speed_pct(), 50);
    }

    #[test]
    fn drained_length_matches_the_mapping_at_every_speed() {
        let mut input = Vec::new();
        VoiceGen::new(44_100).fill(&mut input, 30_000, 1);
        for pct in (50..=200).step_by(5) {
            let mut chain = DspChain::new(CD_TO_48K, pct).unwrap();
            let expected = chain.drained_frames_for(30_000);
            let out = process(&mut chain, &input, 1_152, true);
            assert_eq!(out.len() as u64, expected * 2, "pct {pct}");
            // ≈ len/α at the device rate.
            let ideal = 30_000.0 * 48_000.0 / 44_100.0 * 100.0 / f64::from(pct);
            assert!(
                (expected as f64 - ideal).abs() <= 2.0,
                "pct {pct}: {expected} vs {ideal}"
            );
            assert_eq!(
                (chain.src_frames_pushed(), chain.out_frames_pulled()),
                (0, 0)
            );
        }
    }

    #[test]
    fn other_format_pairs_drain_exactly() {
        let mut input = Vec::new();
        VoiceGen::new(48_000).fill(&mut input, 20_000, 2);
        for (fmt, pct) in [
            // 48 kHz file on a 44.1 kHz stereo device.
            (
                StreamFormat {
                    src_rate: 48_000,
                    src_channels: 2,
                    out_rate: 44_100,
                    out_channels: 2,
                },
                150,
            ),
            // Stereo file on a mono device (downmix), equal rates.
            (
                StreamFormat {
                    src_rate: 48_000,
                    src_channels: 2,
                    out_rate: 48_000,
                    out_channels: 1,
                },
                85,
            ),
            // Surround device: L/R carry the signal, the other channels stay silent.
            (
                StreamFormat {
                    src_rate: 48_000,
                    src_channels: 2,
                    out_rate: 48_000,
                    out_channels: 6,
                },
                100,
            ),
        ] {
            let mut chain = DspChain::new(fmt, pct).unwrap();
            let expected = chain.drained_frames_for(20_000);
            let out = process(&mut chain, &input, 1_152, true);
            assert_eq!(
                out.len() as u64,
                expected * fmt.out_channels as u64,
                "{fmt:?}"
            );
            if fmt.out_channels == 6 {
                let (frames, _) = out.as_chunks::<6>();
                assert!(frames.iter().all(|f| f[2..].iter().all(|&x| x == 0.0)));
                assert!(frames.iter().any(|f| f[0] != 0.0 && f[1] != 0.0));
            }
        }
    }

    #[test]
    fn boundary_markers_never_lie_in_the_released_past() {
        // Decode pushes source up to a segment boundary and asks where it becomes audible: thanks to the DSP latency
        // and the 4 ms hold-back, that frame has never been released yet, so the marker can be pushed in order.
        let mut input = Vec::new();
        VoiceGen::new(44_100).fill(&mut input, 60_000, 1);
        for pct in [50, 100, 135, 200] {
            let mut chain = DspChain::new(CD_TO_48K, pct).unwrap();
            let mut out = Vec::new();
            for c in input.chunks(1_000) {
                chain.push(c);
                chain.pull(&mut out);
                let boundary = chain.out_frame_at_src(chain.src_frames_pushed());
                assert!(
                    boundary >= chain.out_frames_pulled() + 192,
                    "pct {pct}: boundary {boundary}, released {}",
                    chain.out_frames_pulled()
                );
            }
        }
    }

    #[test]
    fn bypass_is_transparent_apart_from_the_fades() {
        let fmt = StreamFormat {
            src_rate: 48_000,
            src_channels: 2,
            out_rate: 48_000,
            out_channels: 2,
        };
        let mut input = Vec::new();
        SineGen::new(48_000, 440.0, 0.5).fill(&mut input, 10_000, 2);
        let mut chain = DspChain::new(fmt, 100).unwrap();
        assert!(!chain.is_stretching() && chain.resampler().is_passthrough());
        let out = process(&mut chain, &input, 1_000, false);
        assert_eq!(out.len(), input.len());
        assert_eq!(
            out[2 * 192..],
            input[2 * 192..],
            "identical after the 4 ms fade-in"
        );
        assert!(out[0].abs() <= input[0].abs());
        let faded = process(&mut chain, &input, 1_000, true);
        assert_eq!(
            faded[2 * 192..2 * (10_000 - 192)],
            input[2 * 192..2 * (10_000 - 192)]
        );
        assert!(faded.last().unwrap().abs() < 1e-3, "faded out");
    }

    #[test]
    fn pull_holds_back_exactly_the_fade() {
        let fmt = StreamFormat {
            src_rate: 48_000,
            src_channels: 1,
            out_rate: 48_000,
            out_channels: 1,
        };
        let mut chain = DspChain::new(fmt, 100).unwrap();
        let mut out = Vec::new();
        chain.push(&[0.5; 1_000]);
        assert_eq!(chain.pull(&mut out), 1_000 - 192);
        assert_eq!(chain.pending_out_frames(), 192);
        assert_eq!(chain.drain(&mut out, false), 192);
        assert_eq!(out.len(), 1_000);
    }

    #[test]
    fn mapping_helpers_agree() {
        let chain = DspChain::new(CD_TO_48K, 150).unwrap();
        // 1 s of output at 1.5× is 1.5 s of source.
        assert_eq!(chain.src_us_at(48_000), 1_500_000);
        assert_eq!(chain.src_frames_at(48_000), 66_150);
        assert_eq!(chain.out_frame_at_src(66_150), 48_000);
        assert_eq!(chain.out_frame_at_src(66_151), 48_001);
        for s in [0_u64, 1, 551, 44_100, 1_234_567] {
            let u = chain.out_frame_at_src(s);
            assert!(chain.src_frames_at(u) >= s && (u == 0 || chain.src_frames_at(u - 1) < s));
            assert!(chain.drained_frames_for(s) - u <= 1);
        }
        assert_eq!(chain.media_rate(), MediaRate::new(150, 48_000));
        assert!(chain.latency_frames() > 0);
    }

    #[test]
    fn sync_points_follow_the_nominal_positions() {
        let mut input = Vec::new();
        VoiceGen::new(44_100).fill(&mut input, 120_000, 1);
        for pct in [50, 75, 125, 200] {
            let mut chain = DspChain::new(CD_TO_48K, pct).unwrap();
            let mut out = Vec::new();
            let mut last = 0;
            for c in input.chunks(1_152) {
                chain.push(c);
                chain.pull(&mut out);
                let sp = chain.sync_point();
                assert!(sp.out_frame <= chain.out_frames_pulled() && sp.out_frame >= last);
                last = sp.out_frame;
                // p_k mapped through the resampler agrees with the linear mapping within half a source frame.
                let linear = chain.src_us_at(sp.out_frame);
                assert!(
                    sp.src_us.abs_diff(linear) <= 12,
                    "pct {pct}: {} vs {linear}",
                    sp.src_us
                );
                // The audible content is within the WSOLA tolerance (10 ms) of it.
                assert!(sp.actual_src_us.abs_diff(sp.src_us) <= 10_000 + 23);
            }
            // 120 000 source frames are ≥ 65 000 output frames even at 2×.
            assert!(last > 60_000, "pct {pct}: last sync point {last}");
        }
        // Bypass: the release point itself.
        let mut chain = DspChain::new(CD_TO_48K, 100).unwrap();
        chain.push(&input[..10_000]);
        let mut out = Vec::new();
        chain.pull(&mut out);
        let sp = chain.sync_point();
        assert_eq!(sp.out_frame, chain.out_frames_pulled());
        assert_eq!(sp.src_us, chain.src_us_at(sp.out_frame));
        assert_eq!(sp.actual_src_us, sp.src_us);
    }

    #[test]
    fn reset_with_speed_restarts_and_fades_in() {
        let mut chain = DspChain::new(CD_TO_48K, 100).unwrap();
        let mut out = Vec::new();
        chain.push(&[0.3; 5_000]);
        chain.pull(&mut out);
        chain.reset_with_speed(125);
        assert!(chain.is_stretching());
        assert_eq!(
            (chain.src_frames_pushed(), chain.out_frames_pulled()),
            (0, 0)
        );
        assert_eq!(chain.speed_pct(), 125);
        let mut input = Vec::new();
        SineGen::new(44_100, 220.0, 0.5).fill(&mut input, 20_000, 1);
        let out = process(&mut chain, &input, 512, true);
        assert!(
            out[0].abs() < 1e-3 && out[1].abs() < 1e-3,
            "fade-in from silence"
        );
        assert!(out.iter().any(|x| x.abs() > 0.4));
    }
}
