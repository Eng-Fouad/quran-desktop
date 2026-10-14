//! WSOLA and DSP-chain acceptance criteria:
//! - output length within ±1 hop of `len/α` over 10 minutes, every 5 % step 0.50–2.00, at 44.1 and 48 kHz;
//! - Sync-marker positions within ±5 ms of the true source position after 5 minutes at 44.1 kHz, every 5 % step;
//! - no sample-to-sample jump > 0.25 on a 440 Hz sine at α ∈ {0.5, 0.75, 1.25, 1.5, 2.0};
//! - a 440 Hz sine at 1.5× keeps its frequency within ±1 % (zero-crossing count).
//!
//! The CPU criterion lives in `dsp_cpu.rs` (its own binary, so nothing runs beside it). Run these in release:
//! `cargo test -p quran-audio --release --test 'dsp_*'`. Every signal is deterministic; the long runs are spread over
//! the available cores.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use quran_audio::dsp::signals::{SineGen, VoiceGen};
use quran_audio::dsp::{DspChain, StreamFormat, Wsola};
use quran_audio::shared::{Marker, MarkerKind, SYNC_INTERVAL_MS};

/// Every speed step the engine allows (50..=200, step 5).
fn speeds() -> impl Iterator<Item = u32> {
    (50..=200).step_by(5)
}

/// Runs `job` over `items` on all cores; results come back in input order.
fn par_map<T: Sync, R: Send>(items: &[T], job: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let workers = std::thread::available_parallelism()
        .map_or(4, std::num::NonZero::get)
        .min(items.len().max(1));
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = job(item);
                    results.lock().unwrap()[i] = Some(r);
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect()
}

#[test]
fn length_is_within_one_hop_of_len_over_alpha_over_ten_minutes() {
    const MINUTES: u64 = 10;
    let configs: Vec<(u32, u32)> = [44_100, 48_000]
        .into_iter()
        .flat_map(|rate| speeds().map(move |pct| (rate, pct)))
        .collect();
    // 10 s of voice per rate, looped: realistic content without generating 10 minutes per configuration.
    let loops: Vec<(u32, Vec<f32>)> = [44_100_u32, 48_000]
        .into_iter()
        .map(|rate| {
            let mut v = Vec::new();
            VoiceGen::new(rate).fill(&mut v, rate as usize * 10, 1);
            (rate, v)
        })
        .collect();
    let results = par_map(&configs, |&(rate, pct)| {
        let source = &loops.iter().find(|(r, _)| *r == rate).unwrap().1;
        let total = u64::from(rate) * 60 * MINUTES;
        let mut w = Wsola::new(rate, 1);
        w.set_speed(pct);
        let hop = w.hop_frames() as u64;
        let latency = w.latency_frames() as u64;
        let mut out = Vec::with_capacity(16_384);
        let mut produced = 0_u64;
        let mut fed = 0_u64;
        while fed < total {
            for packet in source.chunks(1_152) {
                let n = (packet.len() as u64).min(total - fed);
                w.push(&packet[..n as usize]);
                fed += n;
                produced += w.pull(&mut out) as u64;
                out.clear();
                if fed == total {
                    break;
                }
            }
        }
        produced += w.drain(&mut out) as u64;
        let ideal = total as f64 * 100.0 / f64::from(pct);
        let stretched = produced - latency;
        let error_hops = (stretched as f64 - ideal) / hop as f64;
        // Exact by construction: ⌈len·100/pct⌉ after the latency.
        assert_eq!(
            stretched,
            (total * 100).div_ceil(u64::from(pct)),
            "{rate} Hz, {pct} %"
        );
        (rate, pct, produced, error_hops)
    });
    for (rate, pct, produced, error_hops) in &results {
        assert!(
            error_hops.abs() <= 1.0,
            "{rate} Hz {pct} %: {produced} frames, {error_hops:+.4} hops off len/α"
        );
    }
    let worst = results.iter().map(|r| r.3.abs()).fold(0.0, f64::max);
    println!(
        "length over {MINUTES} min: {} configurations, worst |error| = {worst:.5} hop (latency excluded)",
        results.len()
    );
}

/// Position statistics of one speed through the decode chain (44.1 kHz mono → 48 kHz stereo).
#[derive(Debug, Default)]
struct PositionStats {
    probes: usize,
    /// Max |derived − ideal| (µs): drift of the marker timeline against the exact stretched timeline.
    max_drift_us: u64,
    /// Max |derived − ideal| (µs) over the last 10 s of the 5-minute run.
    max_drift_tail_us: u64,
    /// Max |derived − audible| (µs): WSOLA's alignment offset, bounded by Δ.
    max_offset_us: u64,
    /// Means of (derived − audible) per 10 s window (µs).
    window_means_us: Vec<f64>,
    /// Probes on steadily voiced content, and how many of them are within ±5 ms of the audible content.
    voiced: usize,
    voiced_within_5ms: usize,
}

/// Simulates decode and the callback: a Segment marker at the flush (frame 0, file position 0), a Sync marker from
/// [`DspChain::sync_point`] every ~100 ms of output, and the callback's `Marker::position_at` extrapolation. At every
/// hop boundary released, the derived position is compared with
/// - the ideal position of the stretched timeline, `u·α/out_rate`, computed independently in f64 (drift), and
/// - the source frame actually audible there (`SyncPoint::actual_src_us`, WSOLA's frame centre).
fn position_run(pct: u32, source: &[f32]) -> PositionStats {
    let fmt = StreamFormat {
        src_rate: 44_100,
        src_channels: 1,
        out_rate: 48_000,
        out_channels: 2,
    };
    let mut chain = DspChain::new(fmt, pct).unwrap();
    let sync_every = u64::from(SYNC_INTERVAL_MS) * u64::from(fmt.out_rate) / 1_000;
    let mut marker = Marker {
        generation: 1,
        ring_frame: 0,
        kind: MarkerKind::Segment,
        seg_index: 0,
        file_pos_us: 0,
        rate: chain.media_rate(),
        plays: 1,
        passes: 1,
    };
    let end_us = source.len() as f64 * 1e6 / 44_100.0;
    let alpha = f64::from(pct) / 100.0;
    let mut stats = PositionStats::default();
    let (mut window_sum, mut window_n, mut window_end) = (0.0, 0_usize, 10e6);
    let mut out = Vec::with_capacity(16_384);
    let mut last_probe = None;
    for packet in source.chunks(1_152) {
        chain.push(packet);
        chain.pull(&mut out);
        out.clear();
        let sp = chain.sync_point();
        if last_probe == Some(sp.out_frame) {
            continue;
        }
        last_probe = Some(sp.out_frame);
        stats.probes += 1;
        // What the callback would publish at this frame.
        let derived = marker.position_at(sp.out_frame) as f64;
        let ideal = sp.out_frame as f64 * alpha * 1e6 / f64::from(fmt.out_rate);
        let drift = (derived - ideal).abs() as u64;
        stats.max_drift_us = stats.max_drift_us.max(drift);
        if ideal + 10e6 >= end_us {
            stats.max_drift_tail_us = stats.max_drift_tail_us.max(drift);
        }
        let offset = derived - sp.actual_src_us as f64;
        stats.max_offset_us = stats.max_offset_us.max(offset.abs() as u64);
        if VoiceGen::is_voiced_at(sp.actual_src_us as f64 / 1e6, 0.03) {
            stats.voiced += 1;
            if offset.abs() <= 5_000.0 {
                stats.voiced_within_5ms += 1;
            }
        }
        if ideal >= window_end {
            stats
                .window_means_us
                .push(window_sum / window_n.max(1) as f64);
            (window_sum, window_n) = (0.0, 0);
            window_end += 10e6;
        }
        window_sum += offset;
        window_n += 1;
        // Decode pushes a Sync marker every ~100 ms of output, at a WSOLA hop boundary.
        if sp.out_frame >= marker.ring_frame + sync_every {
            marker = Marker {
                kind: MarkerKind::Sync,
                ring_frame: sp.out_frame,
                file_pos_us: sp.src_us,
                ..marker
            };
        }
    }
    stats
}

#[test]
fn sync_positions_stay_within_5_ms_after_5_minutes_at_44k1() {
    let mut source = Vec::new();
    VoiceGen::new(44_100).fill(&mut source, 44_100 * 300, 1);
    let configs: Vec<u32> = speeds().collect();
    let results = par_map(&configs, |&pct| (pct, position_run(pct, &source)));
    for (pct, s) in &results {
        let worst_window = s
            .window_means_us
            .iter()
            .fold(0.0_f64, |m, v| m.max(v.abs()));
        let voiced_pct = 100.0 * s.voiced_within_5ms as f64 / s.voiced.max(1) as f64;
        println!(
            "{pct:>3} %: {} probes | drift max {} µs (last 10 s {} µs) | audible offset max {:.2} ms, worst 10 s mean {:.3} ms, voiced within ±5 ms {voiced_pct:.2} %",
            s.probes,
            s.max_drift_us,
            s.max_drift_tail_us,
            s.max_offset_us as f64 / 1e3,
            worst_window / 1e3,
        );
        assert!(
            s.probes > 5_000 && s.window_means_us.len() >= 29,
            "{pct} %: too few probes"
        );
        // The criterion: after 5 minutes the marker-derived position is within ±5 ms of the true position
        // (it is in fact exact to a few µs at every probe of the run: no drift).
        assert!(
            s.max_drift_tail_us <= 5_000,
            "{pct} %: {} µs off after 5 min",
            s.max_drift_tail_us
        );
        assert!(
            s.max_drift_us <= 50,
            "{pct} %: drift {} µs during the run",
            s.max_drift_us
        );
        // The audible content tracks it: never more than Δ (10 ms) + a frame away, no bias in any 10 s window, and
        // on steadily voiced content within ±5 ms.
        assert!(
            s.max_offset_us <= 10_050,
            "{pct} %: audible offset {} µs",
            s.max_offset_us
        );
        assert!(
            worst_window <= 1_000.0,
            "{pct} %: a 10 s window is biased by {worst_window} µs"
        );
        assert!(
            voiced_pct >= 99.0,
            "{pct} %: only {voiced_pct:.2} % of voiced probes within ±5 ms"
        );
    }
}

/// Largest |x[i+1] − x[i]| of a mono signal, skipping `skip` frames at each end.
fn max_step(x: &[f32], skip: usize) -> f32 {
    x.get(skip..x.len().saturating_sub(skip))
        .unwrap_or_default()
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0, f32::max)
}

#[test]
fn sine_has_no_jump_above_0_25_at_the_listed_speeds() {
    let speeds = [50_u32, 75, 125, 150, 200];
    for rate in [44_100_u32, 48_000] {
        // Full-scale sine: its own largest step is 2π·440/rate ≈ 0.063.
        let mut sine = Vec::new();
        SineGen::new(rate, 440.0, 1.0).fill(&mut sine, rate as usize * 20, 1);
        for pct in speeds {
            let mut w = Wsola::new(rate, 1);
            w.set_speed(pct);
            let mut out = Vec::new();
            for p in sine.chunks(1_152) {
                w.push(p);
                w.pull(&mut out);
            }
            w.drain(&mut out);
            // The latency is silence and the sine starts at phase 0, so the whole output counts.
            let jump = max_step(&out, 0);
            println!("{rate} Hz {pct:>3} %: max step {jump:.4}");
            assert!(jump <= 0.25, "{rate} Hz {pct} %: jump {jump}");
            // Same through the whole chain (44.1/48 kHz → 48 kHz stereo, fades included).
            let fmt = StreamFormat {
                src_rate: rate,
                src_channels: 1,
                out_rate: 48_000,
                out_channels: 2,
            };
            let mut chain = DspChain::new(fmt, pct).unwrap();
            let mut out = Vec::new();
            for p in sine.chunks(1_152) {
                chain.push(p);
                chain.pull(&mut out);
            }
            chain.drain(&mut out, true);
            let left: Vec<f32> = out.as_chunks::<2>().0.iter().map(|f| f[0]).collect();
            let jump = max_step(&left, 0);
            assert!(jump <= 0.25, "chain {rate} Hz {pct} %: jump {jump}");
        }
    }
}

/// Frequency of a mono signal from its zero crossings (rising and falling) between `skip` and `len − skip`.
fn zero_crossing_hz(x: &[f32], rate: u32, skip: usize) -> f64 {
    let body = x.get(skip..x.len() - skip).unwrap();
    let crossings = body
        .windows(2)
        .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
        .count();
    crossings as f64 / 2.0 / (body.len() as f64 / f64::from(rate))
}

#[test]
fn sine_keeps_its_pitch_at_1_5x() {
    for rate in [44_100_u32, 48_000] {
        let mut sine = Vec::new();
        SineGen::new(rate, 440.0, 0.8).fill(&mut sine, rate as usize * 10, 1);
        for pct in [150_u32, 50, 75, 125, 200] {
            let mut w = Wsola::new(rate, 1);
            w.set_speed(pct);
            let mut out = Vec::new();
            for p in sine.chunks(1_152) {
                w.push(p);
                w.pull(&mut out);
            }
            w.drain(&mut out);
            let hz = zero_crossing_hz(&out, rate, 2 * w.frame_frames());
            let err = (hz / 440.0 - 1.0) * 100.0;
            println!("{rate} Hz {pct:>3} %: {hz:.2} Hz ({err:+.3} %)");
            assert!(err.abs() <= 1.0, "{rate} Hz {pct} %: {hz} Hz");
        }
    }
    // Through the chain at 1.5×, measured at the device rate.
    let mut sine = Vec::new();
    SineGen::new(44_100, 440.0, 0.8).fill(&mut sine, 441_000, 1);
    let fmt = StreamFormat {
        src_rate: 44_100,
        src_channels: 1,
        out_rate: 48_000,
        out_channels: 1,
    };
    let mut chain = DspChain::new(fmt, 150).unwrap();
    let mut out = Vec::new();
    for p in sine.chunks(1_152) {
        chain.push(p);
        chain.pull(&mut out);
    }
    chain.drain(&mut out, false);
    let hz = zero_crossing_hz(&out, 48_000, 4_800);
    assert!((hz / 440.0 - 1.0).abs() <= 0.01, "chain at 1.5×: {hz} Hz");
}
