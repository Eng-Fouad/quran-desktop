//! rubato `Fft` resampler wrapper: `FixedSync::Input`, 1024-frame chunks, exact frame ratio and delay
//! (docs/ARCHITECTURE.md §2.3.4 "Resampling"; rubato 5.0.1 `examples/process_raw.rs`). Owner: WP4a.
//!
//! The wrapper accepts any number of interleaved frames, feeds rubato whole 1024-frame chunks, and **trims rubato's
//! startup delay** (`output_delay()` frames, half the output FFT block), so its output is aligned with its input:
//! output frame `u` is input position `u·src_rate/out_rate` (exact up to the sub-frame rounding of rubato's integer
//! delay). The synchronous FFT resampler converts in blocks of `fft_in` → `fft_out` frames with
//! `fft_out/fft_in = out_rate/src_rate` exactly, so the long-run ratio is exact too; [`Resampler::drain`] then emits
//! exactly `⌈in·out_rate/src_rate⌉` frames in total for `in` pushed frames.
//!
//! Equal rates make it a passthrough (no rubato instance, no delay). Steady-state processing does not allocate.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler as _};

use crate::AudioError;

/// rubato input chunk (frames), as in §2.3.4.
pub const CHUNK_FRAMES: usize = 1024;

/// Converts interleaved `f32` frames from `src_rate` to `out_rate`, keeping the channel count.
pub struct Resampler {
    src_rate: u32,
    out_rate: u32,
    channels: usize,
    /// `out_rate / gcd`, `src_rate / gcd`.
    num: u64,
    den: u64,
    /// `None` when the rates are equal (passthrough).
    fft: Option<Fft<f32>>,
    /// rubato's output delay (frames at `out_rate`), trimmed after every reset.
    delay: usize,
    /// Input frames not yet given to rubato (fewer than one chunk after `pull`).
    pending: Vec<f32>,
    /// rubato's output block, `output_frames_max · channels`.
    scratch: Vec<f32>,
    /// Input frames pushed since the last reset.
    pushed: u64,
    /// Output frames released (after trimming) since the last reset.
    released: u64,
    /// Delay frames still to discard.
    to_trim: usize,
}

impl Resampler {
    /// A resampler from `src_rate` to `out_rate` Hz for `channels` interleaved channels.
    ///
    /// # Errors
    /// [`AudioError::Invalid`] for a zero rate or channel count; [`AudioError::Decode`] if rubato rejects the pair.
    pub fn new(src_rate: u32, out_rate: u32, channels: usize) -> Result<Self, AudioError> {
        if src_rate == 0 || out_rate == 0 || channels == 0 {
            return Err(AudioError::Invalid(format!(
                "resampler format {src_rate} Hz → {out_rate} Hz × {channels} ch"
            )));
        }
        let g = gcd(u64::from(src_rate), u64::from(out_rate));
        let (num, den) = (u64::from(out_rate) / g, u64::from(src_rate) / g);
        let fft = if src_rate == out_rate {
            None
        } else {
            Some(
                Fft::<f32>::new(
                    src_rate as usize,
                    out_rate as usize,
                    CHUNK_FRAMES,
                    channels,
                    FixedSync::Input,
                )
                .map_err(|e| {
                    AudioError::Decode(format!("resampler {src_rate} Hz → {out_rate} Hz: {e}"))
                })?,
            )
        };
        let (delay, scratch_frames) = fft
            .as_ref()
            .map_or((0, 0), |f| (f.output_delay(), f.output_frames_max()));
        Ok(Self {
            src_rate,
            out_rate,
            channels,
            num,
            den,
            fft,
            delay,
            pending: Vec::with_capacity(2 * CHUNK_FRAMES * channels),
            scratch: vec![0.0; scratch_frames * channels],
            pushed: 0,
            released: 0,
            to_trim: delay,
        })
    }

    #[must_use]
    pub fn src_rate(&self) -> u32 {
        self.src_rate
    }

    #[must_use]
    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    #[must_use]
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Equal rates: input is copied through unchanged.
    #[must_use]
    pub fn is_passthrough(&self) -> bool {
        self.fft.is_none()
    }

    /// The exact ratio `out_rate / src_rate` in lowest terms, as `(numerator, denominator)`.
    #[must_use]
    pub fn ratio(&self) -> (u64, u64) {
        (self.num, self.den)
    }

    /// rubato's output delay in output frames (`fft_out / 2`); trimmed internally, so it never shows in the output.
    #[must_use]
    pub fn delay_frames(&self) -> usize {
        self.delay
    }

    /// Upper bound of the output frames the resampler holds back at any time (delay plus one chunk and one FFT block).
    #[must_use]
    pub fn latency_frames(&self) -> usize {
        self.fft.as_ref().map_or(0, |f| {
            let held_in = (CHUNK_FRAMES + f.fft_size_in()) as u64;
            self.delay + usize::try_from(self.out_frames_for(held_in)).unwrap_or(usize::MAX)
        })
    }

    /// Output frames that `input_frames` input frames become once drained: `⌈input·out_rate/src_rate⌉`.
    #[must_use]
    pub fn out_frames_for(&self, input_frames: u64) -> u64 {
        let v = (u128::from(input_frames) * u128::from(self.num)).div_ceil(u128::from(self.den));
        u64::try_from(v).unwrap_or(u64::MAX)
    }

    /// Input position (whole frames, rounded down) of output frame `output_frame`: `⌊output·src_rate/out_rate⌋`.
    #[must_use]
    pub fn in_frames_for(&self, output_frame: u64) -> u64 {
        let v = u128::from(output_frame) * u128::from(self.den) / u128::from(self.num);
        u64::try_from(v).unwrap_or(u64::MAX)
    }

    /// Input frames pushed since the last reset.
    #[must_use]
    pub fn input_frames_pushed(&self) -> u64 {
        self.pushed
    }

    /// Output frames released since the last reset.
    #[must_use]
    pub fn output_frames_released(&self) -> u64 {
        self.released
    }

    /// Appends input frames. A trailing partial frame is ignored.
    pub fn push(&mut self, interleaved: &[f32]) {
        let frames = interleaved.len() / self.channels;
        self.pending.extend_from_slice(
            interleaved
                .get(..frames * self.channels)
                .unwrap_or_default(),
        );
        self.pushed += frames as u64;
    }

    /// Converts every whole chunk buffered and appends the aligned output to `out`; returns the frame count.
    pub fn pull(&mut self, out: &mut Vec<f32>) -> usize {
        if self.fft.is_none() {
            let frames = self.pending.len() / self.channels;
            out.append(&mut self.pending);
            self.released += frames as u64;
            return frames;
        }
        let pending_frames = self.pending.len() / self.channels;
        let mut offset = 0;
        let mut produced = 0;
        while pending_frames - offset >= CHUNK_FRAMES {
            let (used, made) = self.process(offset, None);
            produced += self.release(made, u64::MAX, out);
            offset += used.max(1);
        }
        let consumed = (offset * self.channels).min(self.pending.len());
        self.pending.drain(..consumed);
        produced
    }

    /// Converts the rest (zero-padding the last chunk), flushes rubato's delay line, and appends the remaining output
    /// so that exactly `⌈pushed·out_rate/src_rate⌉` frames have been released since the last reset. Then resets.
    /// Returns the frames appended by this call.
    pub fn drain(&mut self, out: &mut Vec<f32>) -> usize {
        let mut produced = self.pull(out);
        if let Some(fft_in) = self.fft.as_ref().map(|f| f.fft_size_in()) {
            let target = self.out_frames_for(self.pushed);
            let partial = self.pending.len() / self.channels;
            if partial > 0 {
                let (_, made) = self.process(0, Some(partial));
                produced += self.release(made, target, out);
                self.pending.clear();
            }
            // Pump silence until the delay line has delivered every real frame. Each call emits at least
            // `fft_out` frames whenever a whole FFT block is buffered, so this bound is generous.
            let max_pumps = 8 + 2 * (self.delay + 2 * fft_in) / CHUNK_FRAMES;
            let mut pumps = 0;
            while self.released < target && pumps < max_pumps {
                let (_, made) = self.process(0, Some(0));
                produced += self.release(made, target, out);
                pumps += 1;
            }
            if self.released < target {
                // Defensive: never reached with a valid rubato instance; keep the frame count exact.
                let missing = usize::try_from(target - self.released).unwrap_or(0);
                out.resize(out.len() + missing * self.channels, 0.0);
                self.released = target;
                produced += missing;
                log::error!("resampler drain fell {missing} frames short; padded with silence");
            }
        }
        self.reset();
        produced
    }

    /// Drops all buffered input and the delay line; positions restart at 0.
    pub fn reset(&mut self) {
        if let Some(fft) = self.fft.as_mut() {
            fft.reset();
        }
        self.pending.clear();
        self.pushed = 0;
        self.released = 0;
        self.to_trim = self.delay;
    }

    /// One rubato call on `pending[offset..]` (`partial`: fewer valid frames than a chunk; zero-padded).
    /// Returns `(input frames consumed, output frames written to scratch)`.
    fn process(&mut self, offset: usize, partial: Option<usize>) -> (usize, usize) {
        let ch = self.channels;
        let Some(fft) = self.fft.as_mut() else {
            return (0, 0);
        };
        let in_frames = self.pending.len() / ch;
        let out_frames = self.scratch.len() / ch;
        let result = InterleavedSlice::new(self.pending.as_slice(), ch, in_frames)
            .map_err(|e| e.to_string())
            .and_then(|input| {
                let mut output =
                    InterleavedSlice::new_mut(self.scratch.as_mut_slice(), ch, out_frames)
                        .map_err(|e| e.to_string())?;
                let indexing = Indexing {
                    input_offset: offset,
                    output_offset: 0,
                    partial_len: partial,
                    active_channels_mask: None,
                };
                fft.process_into_buffer(&input, &mut output, Some(&indexing))
                    .map_err(|e| e.to_string())
            });
        match result {
            Ok(v) => v,
            Err(e) => {
                // Unreachable with the buffer sizes fixed in `new`; stay silent but exact in time.
                log::error!("resampler: {e}");
                let made = fft.output_frames_next();
                self.scratch.fill(0.0);
                (partial.unwrap_or(CHUNK_FRAMES), made.min(out_frames))
            }
        }
    }

    /// Moves `made` frames of scratch to `out`, skipping the remaining delay and stopping at `limit` released frames.
    fn release(&mut self, made: usize, limit: u64, out: &mut Vec<f32>) -> usize {
        let skip = self.to_trim.min(made);
        self.to_trim -= skip;
        let room = usize::try_from(limit.saturating_sub(self.released)).unwrap_or(usize::MAX);
        let take = (made - skip).min(room);
        let from = skip * self.channels;
        let to = from + take * self.channels;
        if let Some(block) = self.scratch.get(from..to) {
            out.extend_from_slice(block);
            self.released += take as u64;
            take
        } else {
            0
        }
    }
}

impl std::fmt::Debug for Resampler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Resampler")
            .field("src_rate", &self.src_rate)
            .field("out_rate", &self.out_rate)
            .field("channels", &self.channels)
            .field("delay", &self.delay)
            .field("pushed", &self.pushed)
            .field("released", &self.released)
            .finish_non_exhaustive()
    }
}

const fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    if a == 0 { 1 } else { a }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::cast_precision_loss)]
mod tests {
    use super::*;
    use crate::dsp::signals::SineGen;

    fn convert(r: &mut Resampler, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for c in input.chunks(chunk * r.channels()) {
            r.push(c);
            r.pull(&mut out);
        }
        r.drain(&mut out);
        out
    }

    #[test]
    fn rejects_bad_formats_and_passes_equal_rates_through() {
        assert!(matches!(
            Resampler::new(0, 48_000, 2),
            Err(AudioError::Invalid(_))
        ));
        assert!(matches!(
            Resampler::new(44_100, 48_000, 0),
            Err(AudioError::Invalid(_))
        ));
        let mut r = Resampler::new(48_000, 48_000, 2).unwrap();
        assert!(r.is_passthrough());
        assert_eq!(
            (r.delay_frames(), r.latency_frames(), r.ratio()),
            (0, 0, (1, 1))
        );
        let input: Vec<f32> = (0..2_000).map(|i| i as f32).collect();
        assert_eq!(convert(&mut r, &input, 333), input);
    }

    #[test]
    fn ratio_and_delay_for_44k1_to_48k() {
        let r = Resampler::new(44_100, 48_000, 2).unwrap();
        assert_eq!(r.ratio(), (160, 147));
        // fft_in 294 → fft_out 320 (two 147/160 blocks per sub-chunk): delay = 160 output frames.
        assert_eq!(r.delay_frames(), 160);
        assert_eq!(r.out_frames_for(44_100), 48_000);
        assert_eq!(r.out_frames_for(1), 2);
        assert_eq!(r.in_frames_for(48_000), 44_100);
    }

    #[test]
    fn drained_length_is_exact() {
        for (src, dst) in [
            (44_100, 48_000),
            (48_000, 44_100),
            (22_050, 48_000),
            (44_100, 32_000),
        ] {
            for len in [0_usize, 1, 1_023, 1_024, 1_025, 10_000, 44_100] {
                let mut r = Resampler::new(src, dst, 1).unwrap();
                let input = vec![0.25_f32; len];
                let out = convert(&mut r, &input, 700);
                assert_eq!(
                    out.len() as u64,
                    (len as u64 * u64::from(dst)).div_ceil(u64::from(src)),
                    "{src} → {dst}, {len} frames"
                );
            }
        }
    }

    #[test]
    fn output_is_aligned_with_input() {
        // An impulse at input frame 10_000 must peak at output frame 10_000·48/44.1 once the delay is trimmed.
        let mut r = Resampler::new(44_100, 48_000, 1).unwrap();
        let mut input = vec![0.0_f32; 20_000];
        input[10_000] = 1.0;
        let out = convert(&mut r, &input, 1_152);
        let (peak, _) =
            out.iter().enumerate().fold(
                (0, 0.0_f32),
                |(bi, bv), (i, &v)| if v > bv { (i, v) } else { (bi, bv) },
            );
        let expected = 10_000.0 * 48_000.0 / 44_100.0;
        assert!(
            (peak as f64 - expected).abs() <= 1.0,
            "peak {peak}, expected {expected:.2}"
        );
    }

    #[test]
    fn sine_keeps_frequency_and_level() {
        let mut input = Vec::new();
        SineGen::new(44_100, 1_000.0, 0.5).fill(&mut input, 44_100, 2);
        let mut r = Resampler::new(44_100, 48_000, 2).unwrap();
        let out = convert(&mut r, &input, 1_152);
        assert_eq!(out.len(), 48_000 * 2);
        // Compare the steady state with an ideal 1 kHz sine at 48 kHz (same phase: aligned output).
        let max_err = out
            .as_chunks::<2>()
            .0
            .iter()
            .enumerate()
            .skip(2_000)
            .take(40_000)
            .map(|(i, f)| {
                let ideal = 0.5 * (std::f64::consts::TAU * 1_000.0 * i as f64 / 48_000.0).sin();
                (f64::from(f[0]) - ideal)
                    .abs()
                    .max((f64::from(f[1]) - ideal).abs())
            })
            .fold(0.0, f64::max);
        assert!(max_err < 2e-3, "max deviation {max_err}");
    }

    #[test]
    fn reset_restarts_cleanly() {
        let mut input = Vec::new();
        SineGen::new(44_100, 300.0, 0.5).fill(&mut input, 5_000, 1);
        let mut r = Resampler::new(44_100, 48_000, 1).unwrap();
        let a = convert(&mut r, &input, 512);
        r.push(&input[..3_000]);
        let mut junk = Vec::new();
        r.pull(&mut junk);
        r.reset();
        assert_eq!(
            (r.input_frames_pushed(), r.output_frames_released()),
            (0, 0)
        );
        let b = convert(&mut r, &input, 512);
        assert_eq!(a, b);
    }
}
