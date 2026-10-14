//! DSP CPU budget: WSOLA uses under 3 % of one core at 48 kHz stereo, α = 1.5 (release build). Its own test binary, so
//! no other test competes for the core while it is timed.
//!
//! The cost is measured as processing time per second of produced audio (the real-time load the decode thread
//! carries during playback), as the best of several runs, which filters out scheduler noise on a busy machine. In a
//! debug build the numbers are printed but only a loose bound is enforced; the acceptance run is
//! `cargo test -p quran-audio --release --test 'dsp_*'`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::cast_precision_loss)]

use std::time::{Duration, Instant};

use quran_audio::dsp::signals::VoiceGen;
use quran_audio::dsp::{DspChain, StreamFormat, Wsola};

/// Real-time budget of the release build.
const BUDGET_PCT: f64 = 3.0;
/// Debug builds of the test binary still run the DSP at opt-level 3 (workspace profile), but stay loose.
const DEBUG_BUDGET_PCT: f64 = 15.0;
const RUNS: usize = 5;
/// Decoder packet size of MP3 (frames).
const PACKET: usize = 1_152;

fn budget() -> f64 {
    if cfg!(debug_assertions) {
        DEBUG_BUDGET_PCT
    } else {
        BUDGET_PCT
    }
}

/// Best-of-`RUNS` time of `run`, which returns the produced frame count.
fn best_of(mut run: impl FnMut() -> usize) -> (Duration, usize) {
    let mut best = Duration::MAX;
    let mut frames = 0;
    for _ in 0..RUNS {
        let t = Instant::now();
        frames = std::hint::black_box(run());
        best = best.min(t.elapsed());
    }
    (best, frames)
}

fn load_pct(elapsed: Duration, frames: usize, rate: u32) -> f64 {
    let audio_s = frames as f64 / f64::from(rate);
    100.0 * elapsed.as_secs_f64() / audio_s
}

#[test]
fn wsola_uses_under_3_percent_of_a_core_at_48k_stereo_1_5x() {
    let mut input = Vec::new();
    VoiceGen::new(48_000).fill(&mut input, 48_000 * 30, 2);
    let mut w = Wsola::new(48_000, 2);
    w.set_speed(150);
    let mut out = Vec::with_capacity(16_384);
    let (elapsed, frames) = best_of(|| {
        w.reset();
        let mut produced = 0;
        for p in input.chunks(PACKET * 2) {
            w.push(p);
            produced += w.pull(&mut out);
            out.clear();
        }
        produced + w.drain(&mut out)
    });
    // 30 s of input at 1.5× is 20 s of playback.
    assert!(frames >= 48_000 * 20);
    let load = load_pct(elapsed, frames, 48_000);
    println!(
        "WSOLA 48 kHz stereo 1.5×: {load:.3} % of one core ({:.1} ms for {:.1} s of output)",
        elapsed.as_secs_f64() * 1e3,
        frames as f64 / 48_000.0
    );
    assert!(load < budget(), "WSOLA load {load:.3} % ≥ {} %", budget());
}

#[test]
fn full_chain_stays_within_the_same_budget() {
    // The real playback path: a 44.1 kHz stereo MP3 at every speed extreme, resampled to a 48 kHz stereo device.
    let mut input = Vec::new();
    VoiceGen::new(44_100).fill(&mut input, 44_100 * 30, 2);
    let fmt = StreamFormat {
        src_rate: 44_100,
        src_channels: 2,
        out_rate: 48_000,
        out_channels: 2,
    };
    for pct in [50_u32, 100, 150, 200] {
        let mut chain = DspChain::new(fmt, pct).unwrap();
        let mut out = Vec::with_capacity(16_384);
        let (elapsed, frames) = best_of(|| {
            chain.reset();
            let mut produced = 0;
            for p in input.chunks(PACKET * 2) {
                chain.push(p);
                produced += chain.pull(&mut out);
                out.clear();
            }
            produced + chain.drain(&mut out, true)
        });
        let load = load_pct(elapsed, frames, 48_000);
        println!("chain 44.1 → 48 kHz stereo at {pct:>3} %: {load:.3} % of one core");
        assert!(load < budget(), "chain at {pct} %: {load:.3} %");
    }
}
