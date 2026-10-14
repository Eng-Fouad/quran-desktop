//! The engine end to end on the WAV sink: a 1:1–1:7 synthetic play runs through control, the planner, decode, the
//! output thread's renderer and the ticker in real time, and the sink's marker log equals the plan to the frame (±1);
//! the WAV carries the planned source frames at every boundary.
#![cfg(debug_assertions)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

#[path = "engine_common.rs"]
mod common;

use std::time::{Duration, Instant};

use common::{RATE, RECITER, Rig, markers, read_log, read_wav, request, u};
use quran_audio::decode::ms_to_frame;
use quran_audio::fake_out::fixtures::{FixtureTimings, ramp_frame};
use quran_audio::sink::SinkKind;
use quran_audio::{EngineConfig, OutputKind, SegmentKind, plan};
use quran_types::{AyahRef, PlaybackStatus};

#[test]
fn a_1_1_to_1_7_play_matches_its_plan_in_the_marker_log() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("fatiha.wav");
    let rig = Rig::new(OutputKind::Sink(SinkKind::Wav(wav.clone())));
    let req = request((1, 1), (1, 7));
    let plan = plan(&req, &FixtureTimings::new(RECITER)).unwrap();
    assert_eq!(plan.len(), 7);
    assert!(plan.iter().all(|s| s.kind == SegmentKind::Ayah));

    let started = Instant::now();
    rig.engine.play(req);
    // `audio_play` returns this: loading, with the request's range.
    let s = rig.engine.snapshot();
    assert_eq!(s.status, PlaybackStatus::Loading);
    assert_eq!(s.reciter_id, Some(RECITER));
    rig.wait_status(PlaybackStatus::Playing, Duration::from_secs(5));
    let s = rig.wait_ayah(1, 1, Duration::from_secs(5));
    assert_eq!(s.current_ayah_id, Some(1));
    assert_eq!(
        s.range.map(|r| (r.from, r.to)),
        Some((AyahRef { surah: 1, ayah: 1 }, AyahRef { surah: 1, ayah: 7 }))
    );
    assert!(s.device.as_deref().is_some_and(|d| d.contains("WAV sink")));
    // The whole play, then idle once the End marker is heard.
    let end = rig.wait(Duration::from_secs(20), "the end", |s| {
        s.status == PlaybackStatus::Idle
    });
    assert!(end.error.is_none() && end.current.is_none());
    rig.engine.shutdown();
    let elapsed = started.elapsed();

    // --- marker log --------------------------------------------------------------------------------------------------
    let log = read_log(&SinkKind::log_path(&wav));
    let applied = markers(&log);
    let segments: Vec<_> = applied.iter().filter(|m| m["kind"] == "segment").collect();
    assert_eq!(
        segments.len(),
        7,
        "one Segment marker per ayah: {applied:#?}"
    );
    let generation = &segments[0]["generation"];
    assert!(
        applied.iter().all(|m| &m["generation"] == generation),
        "no flush during the play"
    );
    let r0 = u(&segments[0]["ringFrame"]);
    let d0 = u(&segments[0]["deviceFrame"]);
    let mut expected = r0;
    for (k, (m, seg)) in segments.iter().zip(&plan).enumerate() {
        assert_eq!(u(&m["segIndex"]), k as u64);
        let ring = u(&m["ringFrame"]);
        assert!(
            ring.abs_diff(expected) <= 1,
            "segment {k}: ring frame {ring}, planned {expected}"
        );
        // Applied on its exact frame, and heard in real time without a gap.
        assert_eq!(u(&m["readFrame"]), ring, "segment {k} applied late");
        assert!(u(&m["deviceFrame"]).abs_diff(d0 + (ring - r0)) <= 1);
        // The marker's position is the segment start on the file timeline.
        let start_us = ms_to_frame(seg.start_ms, RATE) * 1_000_000 / u64::from(RATE);
        assert!(
            u(&m["filePosUs"]).abs_diff(start_us) <= 1_000_000 / u64::from(RATE),
            "segment {k} position {} vs {start_us}",
            m["filePosUs"]
        );
        expected += ms_to_frame(seg.end_ms, RATE) - ms_to_frame(seg.start_ms, RATE);
    }
    let end_marker = applied
        .iter()
        .find(|m| m["kind"] == "end")
        .expect("an End marker");
    assert!(
        u(&end_marker["ringFrame"]).abs_diff(expected) <= 1,
        "End at {}, planned {expected}",
        end_marker["ringFrame"]
    );
    assert!(
        !applied.iter().any(|m| m["kind"] == "gap"),
        "continuous play: no gaps"
    );

    // --- audio ---------------------------------------------------------------------------------------------------------
    // Every contiguous boundary is seamless: the device frame where segment k starts plays exactly its first source
    // frame (the ramp fixture encodes each sample's own frame index; 100 % at equal rates is bit-transparent).
    let samples = read_wav(&wav);
    for (k, (m, seg)) in segments.iter().zip(&plan).enumerate().skip(1) {
        let device = usize::try_from(u(&m["deviceFrame"])).unwrap();
        let sample = samples[device * 2];
        assert_eq!(
            ramp_frame(sample),
            ms_to_frame(seg.start_ms, RATE),
            "segment {k}: wrong audio at its marker"
        );
        // The frame before it is the previous source frame: nothing skipped, nothing repeated.
        assert_eq!(
            ramp_frame(samples[(device - 1) * 2]) + 1,
            ms_to_frame(seg.start_ms, RATE)
        );
    }

    // --- ticks and events --------------------------------------------------------------------------------------------
    let ticks: Vec<_> = log
        .iter()
        .filter(|l| l["event"] == "tick")
        .map(|l| &l["tick"])
        .collect();
    let ayahs: Vec<u64> = ticks
        .iter()
        .filter(|t| t["status"] == "playing" && t["surah"] == 1)
        .map(|t| u(&t["ayah"]))
        .collect();
    assert!(ayahs.windows(2).all(|w| w[1] >= w[0]), "ayahs in order");
    assert_eq!(ayahs.first(), Some(&1));
    assert_eq!(ayahs.last(), Some(&7));
    // The rate. The ticker asks for `tick_hz` (30), but when its thread wakes is the OS's call: GitHub's macOS runners
    // run the job throttled and the kernel coalesces its timers by tens of milliseconds (as `taskpolicy -b` does here),
    // which leaves 10–14 Hz. What the player needs is ticks all through the play, often enough that the position it
    // interpolates from the last one (up to 250 ms past the ayah's end, `AYAH_END_SLACK_MS`) does not stall: every ayah
    // ticks while it plays, at 5 Hz or more on average (a tick per 200 ms). A ticker that stopped ticking while playing
    // (ticks only at control wake-ups) fails that; one that ticked faster than `tick_hz` fails the cap: ticks fall on
    // distinct slots of one grid (`ticker::next_slot`), one per slot of the run plus one per restart of the grid at a
    // wake-up while parked.
    let plan_ms: u64 = plan.iter().map(|s| u64::from(s.duration_ms())).sum();
    for a in 1..=7 {
        assert!(ayahs.contains(&a), "no tick while 1:{a} played");
    }
    assert!(
        ayahs.len() as u64 * 200 >= plan_ms,
        "{} ticks while playing {plan_ms} ms",
        ayahs.len()
    );
    let tick_hz = EngineConfig::default().tick_hz;
    let slots = elapsed.as_micros() * u128::from(tick_hz) / 1_000_000;
    assert!(
        ticks.len() as u128 <= slots + 5,
        "{} ticks in {elapsed:?}: above {tick_hz} Hz",
        ticks.len()
    );
    // Every tick's word is the planned active word at its position.
    for t in ticks
        .iter()
        .filter(|t| t["status"] == "playing" && t["ayah"] != 0)
    {
        let seg = &plan[usize::try_from(u(&t["ayah"]) - 1).unwrap()];
        let ms = u32::try_from(u(&t["fileMs"])).unwrap();
        assert_eq!(
            u(&t["wordPos"]),
            seg.word_at(ms).map_or(0, u64::from),
            "tick {t}"
        );
    }
    let seqs: Vec<u64> = ticks.iter().map(|t| u(&t["seq"])).collect();
    assert!(
        seqs.windows(2).all(|w| w[1] == w[0] + 1),
        "sequence numbers"
    );
    assert_eq!(
        rig.events.ayah_refs(),
        (1..=7).map(|a| (1, a)).collect::<Vec<_>>()
    );
    assert_eq!(
        rig.events.statuses(),
        [
            PlaybackStatus::Idle,
            PlaybackStatus::Loading,
            PlaybackStatus::Playing,
            PlaybackStatus::Idle
        ]
    );
    assert!(rig.events.errors.lock().unwrap().is_empty());
}
