//! Deterministic test signals for the DSP tests (unit tests and `tests/dsp_*.rs`). Compiled only with `cfg(test)` or
//! the `testing` feature.
//!
//! Every generator is a pure function of its constructor arguments and the number of frames generated so far, so a
//! signal can be produced in chunks of any size and still be bit-identical.

/// A 64-bit linear congruential generator (Knuth's MMIX constants): reproducible noise without a dependency.
#[derive(Clone, Debug)]
pub struct Lcg(u64);

impl Lcg {
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// Uniform in `[-1, 1)`.
    pub fn next_f32(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        // Top 24 bits → [0, 2) − 1.
        ((self.0 >> 40) as f32 / (1u64 << 23) as f32) - 1.0
    }
}

/// A sine at a fixed frequency and amplitude, written to every channel.
#[derive(Clone, Debug)]
pub struct SineGen {
    rate: f64,
    freq: f64,
    amp: f32,
    /// Frames generated so far (the phase is computed from it, so chunking never accumulates rounding).
    n: u64,
}

impl SineGen {
    #[must_use]
    pub fn new(rate: u32, freq: f64, amp: f32) -> Self {
        Self {
            rate: f64::from(rate.max(1)),
            freq,
            amp,
            n: 0,
        }
    }

    /// Appends `frames` interleaved frames of `channels` channels.
    pub fn fill(&mut self, out: &mut Vec<f32>, frames: usize, channels: usize) {
        out.reserve(frames * channels);
        for _ in 0..frames {
            // Wrap the phase argument in f64 so long signals keep full precision.
            let cycles = (self.n as f64 * self.freq / self.rate).fract();
            let v = (std::f64::consts::TAU * cycles).sin() as f32 * self.amp;
            out.extend(std::iter::repeat_n(v, channels));
            self.n += 1;
        }
    }
}

/// A recitation-like voice: a harmonic source (10 partials, 1/h tilt) whose pitch glides between ≈ 107 and 213 Hz
/// with 5.5 Hz vibrato, a ≈ 4 Hz syllabic envelope, a 350 ms pause every 3.7 s, and a short fricative noise burst
/// every 1.3 s. Peak level ≈ 0.6. Mostly voiced, like Quran recitation.
#[derive(Clone, Debug)]
pub struct VoiceGen {
    rate: f64,
    n: u64,
    phase: f64,
    noise: Lcg,
}

impl VoiceGen {
    const PARTIALS: usize = 10;

    #[must_use]
    pub fn new(rate: u32) -> Self {
        Self {
            rate: f64::from(rate.max(1)),
            n: 0,
            phase: 0.0,
            noise: Lcg::new(0x5EED_CAFE_F00D_0001),
        }
    }

    /// Fundamental frequency at time `t` (seconds).
    #[must_use]
    pub fn f0(t: f64) -> f64 {
        use std::f64::consts::TAU;
        160.0
            + 35.0 * (TAU * 0.23 * t).sin()
            + 15.0 * (TAU * 0.071 * t + 1.0).sin()
            + 3.0 * (TAU * 5.5 * t).sin()
    }

    /// Whether the voice is steadily voiced around `t` (seconds): outside the phrase pauses and the fricative bursts,
    /// with `margin` seconds of clearance on both sides (a WSOLA frame plus its search window reach ±25 ms).
    #[must_use]
    pub fn is_voiced_at(t: f64, margin: f64) -> bool {
        let phrase = t.rem_euclid(3.7);
        let in_pause = phrase >= 3.35 - margin || phrase < margin;
        let fricative = t.rem_euclid(1.3);
        let in_fricative = fricative < 0.05 + margin || fricative > 1.3 - margin;
        !in_pause && !in_fricative
    }

    /// Appends `frames` interleaved frames of `channels` channels (the same voice on every channel).
    pub fn fill(&mut self, out: &mut Vec<f32>, frames: usize, channels: usize) {
        use std::f64::consts::TAU;
        out.reserve(frames * channels);
        for _ in 0..frames {
            let t = self.n as f64 / self.rate;
            self.phase = (self.phase + TAU * Self::f0(t) / self.rate) % TAU;
            // sin(hφ) for h = 1..=PARTIALS by the Chebyshev recurrence sin((h+1)φ) = 2cosφ·sin(hφ) − sin((h−1)φ).
            let (s1, c1) = self.phase.sin_cos();
            let (mut prev, mut cur) = (0.0_f64, s1);
            let mut voiced = 0.0;
            for h in 1..=Self::PARTIALS {
                voiced += cur / h as f64;
                let next = 2.0 * c1 * cur - prev;
                prev = cur;
                cur = next;
            }
            // Syllables (≈ 4 Hz, slightly irregular), squared for sharper onsets.
            let syl = 0.5 + 0.5 * (TAU * 4.1 * t + 0.7 * (TAU * 0.37 * t).sin()).sin();
            let mut env = 0.15 + 0.85 * syl * syl;
            // A 350 ms pause every 3.7 s, with 20 ms raised-cosine edges.
            let in_phrase = t % 3.7;
            let pause = 3.7 - 0.35;
            if in_phrase >= pause {
                let into = in_phrase - pause;
                let edge = 0.02;
                env *= if into < edge {
                    0.5 + 0.5 * (std::f64::consts::PI * into / edge).cos()
                } else if into > 0.35 - edge {
                    0.5 - 0.5 * (std::f64::consts::PI * (into - (0.35 - edge)) / edge).cos()
                } else {
                    0.0
                };
            }
            let mut v = 0.33 * env * voiced;
            // A 50 ms fricative every 1.3 s.
            let noise = f64::from(self.noise.next_f32());
            if t % 1.3 < 0.05 {
                v += 0.12 * noise;
            }
            let v = v as f32;
            out.extend(std::iter::repeat_n(v, channels));
            self.n += 1;
        }
    }
}

/// White noise (uniform in `[-amp, amp)`), the same on every channel: a non-periodic signal for alignment tests.
#[must_use]
pub fn noise(seed: u64, frames: usize, channels: usize, amp: f32) -> Vec<f32> {
    let mut g = Lcg::new(seed);
    let mut out = Vec::with_capacity(frames * channels);
    for _ in 0..frames {
        let v = g.next_f32() * amp;
        out.extend(std::iter::repeat_n(v, channels));
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn generators_are_chunk_invariant_and_bounded() {
        let mut a = Vec::new();
        VoiceGen::new(44_100).fill(&mut a, 10_000, 2);
        let mut b = Vec::new();
        let mut g = VoiceGen::new(44_100);
        g.fill(&mut b, 3_333, 2);
        g.fill(&mut b, 6_667, 2);
        assert_eq!(a, b);
        assert!(a.iter().all(|x| x.abs() < 1.0));
        assert!(a.iter().any(|x| x.abs() > 0.2));

        let mut s = Vec::new();
        SineGen::new(48_000, 440.0, 0.5).fill(&mut s, 480, 1);
        assert!(s[0].abs() < 1e-9 && s.iter().all(|x| x.abs() <= 0.5));

        let n = noise(7, 1000, 1, 0.5);
        assert!(n.iter().all(|x| x.abs() <= 0.5));
        assert_eq!(n, noise(7, 1000, 1, 0.5));
    }

    #[test]
    fn voiced_schedule() {
        assert!(VoiceGen::is_voiced_at(1.0, 0.03));
        assert!(!VoiceGen::is_voiced_at(3.5, 0.03), "phrase pause");
        assert!(!VoiceGen::is_voiced_at(3.33, 0.03), "pause edge");
        assert!(!VoiceGen::is_voiced_at(2.62, 0.03), "fricative at 2.6 s");
        assert!(!VoiceGen::is_voiced_at(3.71, 0.03), "just after a pause");
    }
}
