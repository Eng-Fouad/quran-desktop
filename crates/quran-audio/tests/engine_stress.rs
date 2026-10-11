//! The engine under a storm of commands on real threads (control, decode, output, ticker), on the WAV sink: random
//! seeks, jumps, skips, speed and repeat changes, pauses, A-B loops and injected device rebuilds over a cross-surah
//! queue. The marker log must stay coherent: every Segment/Gap/End marker applied on its exact ring frame, ring frames
//! ordered within a stream, flush generations only increasing, every segment index inside the queue; no error, no
//! stall, and the engine still answers and ends cleanly. `QD_ENGINE_STRESS_SEEDS=<n>` runs more seeds.
#![cfg(debug_assertions)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

#[path = "engine_common.rs"]
mod common;

use std::time::{Duration, Instant};

use common::{Rig, read_log, read_wav, request, u};
use quran_audio::dsp::signals::Lcg;
use quran_audio::fake_out::fixtures::{FixtureTimings, ayah_id};
use quran_audio::shared::OutCmd;
use quran_audio::sink::SinkKind;
use quran_audio::{OutputKind, plan};
use quran_types::{AbLoop, GapSetting, PlaybackStatus, SeekTarget, SkipDirection};

/// A uniform integer in `0..n`.
fn pick(rng: &mut Lcg, n: u32) -> u32 {
    let x = (rng.next_f32() + 1.0) / 2.0;
    ((x * n as f32) as u32).min(n.saturating_sub(1))
}

fn storm(seed: u64) {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("stress.wav");
    let rig = Rig::new(OutputKind::Sink(SinkKind::Wav(wav.clone())));
    let mut req = request((112, 1), (114, 6));
    req.ayah_repeat = 2;
    req.gap = GapSetting::Multiplier { pct: 20 };
    let queue_len = plan(&req, &FixtureTimings::new(7)).unwrap().len() as u64;
    rig.engine.play(req);
    rig.wait_status(PlaybackStatus::Playing, Duration::from_secs(5));

    let mut rng = Lcg::new(seed);
    let until = Instant::now() + Duration::from_secs(6);
    let mut commands = 0;
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(u64::from(20 + pick(&mut rng, 130))));
        let e = &rig.engine;
        match pick(&mut rng, 12) {
            0 => e.seek(SeekTarget::FileMs {
                ms: pick(&mut rng, 6_000),
            }),
            1 => e.seek(SeekTarget::RelativeMs {
                delta_ms: i32::try_from(pick(&mut rng, 4_000)).unwrap() - 2_000,
            }),
            2 => e.seek(SeekTarget::Ayah {
                ayah_id: ayah_id(112 + pick(&mut rng, 3) as u16, 1 + pick(&mut rng, 4) as u16),
            }),
            3 => e.skip(if pick(&mut rng, 2) == 0 {
                SkipDirection::Next
            } else {
                SkipDirection::Previous
            }),
            4 => e.set_speed(50 + 5 * pick(&mut rng, 31)),
            5 => {
                e.pause();
                std::thread::sleep(Duration::from_millis(u64::from(pick(&mut rng, 120))));
                e.resume();
            }
            6 => e.set_repeat(pick(&mut rng, 4), 1 + pick(&mut rng, 2)),
            7 => e.set_gap(match pick(&mut rng, 3) {
                0 => GapSetting::None,
                1 => GapSetting::Fixed {
                    ms: pick(&mut rng, 400),
                },
                _ => GapSetting::Multiplier {
                    pct: pick(&mut rng, 50),
                },
            }),
            8 => {
                let a = pick(&mut rng, 4_000);
                e.set_ab_loop(Some(AbLoop {
                    a_ms: a,
                    b_ms: a + 300 + pick(&mut rng, 900),
                }));
            }
            9 => e.set_ab_loop(None),
            10 => e.inject_output_command(OutCmd::Rebuild {
                generation: e.diagnostics().output_generation,
            }),
            _ => e.toggle(),
        }
        commands += 1;
        // The handle always answers; the only error a storm may cause is the rebuild back-off (a device that keeps
        // failing), which the next successful stream clears.
        let s = rig.engine.snapshot();
        assert!(
            s.error.is_none()
                || s.error
                    .as_ref()
                    .is_some_and(|e| e.message().contains("keeps failing")),
            "seed {seed}: {s:#?}"
        );
    }
    assert!(commands > 30);
    // Still alive: resume, take the loop off, and let it play.
    rig.engine.set_ab_loop(None);
    rig.engine.resume();
    let s = rig.wait(Duration::from_secs(4), "playing after the storm", |s| {
        matches!(s.status, PlaybackStatus::Playing | PlaybackStatus::Idle)
    });
    assert!(s.error.is_none());
    rig.engine.stop();
    rig.wait_status(PlaybackStatus::Idle, Duration::from_secs(2));
    rig.engine.shutdown();
    assert!(
        rig.events.errors.lock().unwrap().iter().all(
            |e| matches!(e, quran_audio::AudioError::Device(m) if m.contains("keeps failing"))
        ),
        "seed {seed}: {:?}",
        rig.events.errors.lock().unwrap()
    );

    // --- the marker log --------------------------------------------------------------------------------------------
    let log = read_log(&SinkKind::log_path(&wav));
    let mut last_ring: Option<(u64, u64)> = None; // (output generation, ring frame)
    let mut last_generation = 0;
    let mut applied = 0;
    for m in log.iter().filter(|l| l["event"] == "marker") {
        applied += 1;
        let (out_gen, ring, read) = (
            u(&m["outputGeneration"]),
            u(&m["ringFrame"]),
            u(&m["readFrame"]),
        );
        if m["kind"] == "sync" {
            assert!(
                ring <= read,
                "seed {seed}: a Sync ahead of the read position: {m}"
            );
        } else {
            assert_eq!(ring, read, "seed {seed}: applied off its frame: {m}");
        }
        assert!(u(&m["segIndex"]) < queue_len, "seed {seed}: {m}");
        let generation = u(&m["generation"]);
        assert!(
            generation >= last_generation,
            "seed {seed}: generations go back: {m}"
        );
        last_generation = generation;
        if let Some((g, r)) = last_ring
            && g == out_gen
            && m["kind"] != "sync"
        {
            assert!(ring >= r, "seed {seed}: ring frames go back: {m}");
        }
        if m["kind"] != "sync" {
            last_ring = Some((out_gen, ring));
        }
    }
    // Flushes discard most markers before they are heard; what matters is that some audio flowed between them.
    assert!(applied > 10, "seed {seed}: {applied} markers");
    let rebuilds = log
        .iter()
        .filter(|l| l["event"] == "output" && l["reason"] == "rebuild")
        .count();
    assert!(
        rebuilds <= 3 * 2 + 1,
        "debounced and rate-limited: {rebuilds}"
    );
    // The audio stays in range: no NaN, nothing louder than the source (fades and ramps only attenuate).
    let samples = read_wav(&wav);
    assert!(samples.len() > 48_000 * 2 * 2);
    assert!(
        samples
            .iter()
            .all(|s| s.is_finite() && (-1.0..=1.0).contains(s))
    );
}

#[test]
fn the_engine_survives_a_command_storm() {
    let seeds: u64 = std::env::var("QD_ENGINE_STRESS_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);
    let handles: Vec<_> = (0..seeds)
        .map(|seed| {
            std::thread::Builder::new()
                .name(format!("storm-{seed}"))
                .spawn(move || storm(0x5EED_0000 + seed))
                .unwrap()
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}
