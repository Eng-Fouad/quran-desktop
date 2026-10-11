//! The output thread's device-event policy end to end (§2.3.6, D19), on the WAV sink: an injected `OutCmd::Rebuild`
//! replaces the stream and playback resumes within 2 s at the audible position; a second `Rebuild` for the replaced
//! generation is ignored; `DeviceChanged` relabels without a rebuild; the output is opened lazily and released after
//! the idle linger.
#![cfg(debug_assertions)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

#[path = "engine_common.rs"]
mod common;

use std::time::{Duration, Instant};

use common::{Rig, markers, read_log, request, u};
use quran_audio::output::IDLE_LINGER;
use quran_audio::shared::OutCmd;
use quran_audio::sink::SinkKind;
use quran_audio::{AudioEngine, EngineConfig, NullEventSink, OutputKind};
use quran_types::PlaybackStatus;

#[test]
fn an_injected_rebuild_resumes_within_2_s_and_a_second_one_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("rebuild.wav");
    let rig = Rig::new(OutputKind::Sink(SinkKind::Wav(wav.clone())));
    rig.engine.play(request((1, 1), (1, 7)));
    rig.wait_ayah(1, 2, Duration::from_secs(5));
    let before = rig.engine.diagnostics();
    assert!(before.output_open);
    assert_eq!(before.rebuilds, 0);
    let g = before.output_generation;
    let at_rebuild = rig.engine.snapshot().file_ms;

    rig.engine
        .inject_output_command(OutCmd::Rebuild { generation: g });
    let t0 = Instant::now();
    // Resumed: a new stream, and the position moves on from where it was.
    let resumed = rig.wait(Duration::from_secs(2), "resume after the rebuild", |s| {
        s.status == PlaybackStatus::Playing && s.file_ms > at_rebuild + 300
    });
    let took = t0.elapsed();
    assert!(took < Duration::from_secs(2), "resumed after {took:?}");
    let after = rig.engine.diagnostics();
    assert_eq!(after.output_generation, g + 1);
    assert_eq!(after.rebuilds, 1);
    assert!(resumed.error.is_none());

    // The same generation again (a poll and an error callback reporting one change): dropped.
    rig.engine
        .inject_output_command(OutCmd::Rebuild { generation: g });
    std::thread::sleep(Duration::from_millis(300));
    let again = rig.engine.diagnostics();
    assert_eq!(again.output_generation, g + 1, "second rebuild ignored");
    assert_eq!(again.rebuilds, 1);

    // DeviceChanged: relabel only — a state change, no new stream, no flush.
    let generation = again.decode_generation;
    let states = rig.events.states.lock().unwrap().len();
    rig.engine.inject_output_command(OutCmd::DeviceChanged);
    std::thread::sleep(Duration::from_millis(200));
    let relabelled = rig.engine.diagnostics();
    assert_eq!(relabelled.output_generation, g + 1);
    assert_eq!(relabelled.rebuilds, 1);
    assert_eq!(relabelled.decode_generation, generation, "no flush");
    assert!(
        rig.events.states.lock().unwrap().len() > states,
        "a state event"
    );
    assert_eq!(rig.engine.snapshot().status, PlaybackStatus::Playing);

    rig.wait_status(PlaybackStatus::Idle, Duration::from_secs(20));
    rig.engine.shutdown();

    // The log shows the rebuilt stream resuming exactly where the old one was heard.
    let log = read_log(&SinkKind::log_path(&wav));
    let outputs: Vec<_> = log.iter().filter(|l| l["event"] == "output").collect();
    assert_eq!(outputs.len(), 2, "{outputs:#?}");
    assert_eq!(outputs[0]["reason"], "open");
    assert_eq!(outputs[1]["reason"], "rebuild");
    let resume_us = u(&outputs[1]["resumeAtUs"]);
    assert!(
        resume_us.abs_diff(u64::from(at_rebuild) * 1_000) < 200_000,
        "resumed at {resume_us} µs, heard {at_rebuild} ms"
    );
    let applied = markers(&log);
    let rebuilt = applied
        .iter()
        .find(|m| u(&m["outputGeneration"]) == u64::from(g + 1))
        .expect("a marker on the rebuilt stream");
    assert_eq!(rebuilt["kind"], "segment");
    assert_eq!(u(&rebuilt["ringFrame"]), 0, "a fresh ring");
    assert!(
        u(&rebuilt["filePosUs"]).abs_diff(resume_us) <= 21,
        "flush marker at {} vs resume {resume_us}",
        rebuilt["filePosUs"]
    );
    // Every ayah was still reported once, in order, across the rebuild.
    assert_eq!(
        rig.events.ayah_refs(),
        (1..=7).map(|a| (1, a)).collect::<Vec<_>>()
    );
}

#[test]
fn the_output_opens_on_play_and_is_released_when_idle() {
    let rig = Rig::new(OutputKind::Sink(SinkKind::Null));
    // The startup probe labels the device without opening it.
    let idle = rig.wait(Duration::from_secs(2), "the device label", |s| {
        s.device.is_some()
    });
    assert_eq!(idle.status, PlaybackStatus::Idle);
    assert!(idle.device.unwrap().contains("Null sink"));
    let d = rig.engine.diagnostics();
    assert!(!d.output_open);
    assert_eq!(d.output_generation, 0);

    rig.engine.play(request((112, 1), (112, 1)));
    rig.wait_status(PlaybackStatus::Playing, Duration::from_secs(5));
    let d = rig.engine.diagnostics();
    assert!(d.output_open && d.output_generation == 1);
    assert_eq!((d.sample_rate, d.channels), (48_000, 2));
    rig.wait_status(PlaybackStatus::Idle, Duration::from_secs(10));
    assert!(
        rig.engine.diagnostics().output_open,
        "kept for a quick replay"
    );
    let released = Instant::now() + IDLE_LINGER + Duration::from_secs(2);
    while rig.engine.diagnostics().output_open {
        assert!(
            Instant::now() < released,
            "the idle stream was not released"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // A new play reopens it.
    rig.engine.play(request((112, 2), (112, 2)));
    rig.wait_ayah(112, 2, Duration::from_secs(5));
    let d = rig.engine.diagnostics();
    assert!(d.output_open && d.output_generation == 2 && d.rebuilds == 0);
}

#[test]
fn a_rebuild_while_paused_keeps_the_position_and_stays_paused() {
    let rig = Rig::new(OutputKind::Sink(SinkKind::Null));
    rig.engine.play(request((113, 1), (113, 5)));
    rig.wait_ayah(113, 2, Duration::from_secs(5));
    rig.engine.pause();
    let paused = rig.wait_status(PlaybackStatus::Paused, Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(100));
    let at = rig.engine.snapshot().file_ms;
    assert!(at.abs_diff(paused.file_ms) <= 50, "paused position settles");
    let g = rig.engine.diagnostics().output_generation;
    rig.engine
        .inject_output_command(OutCmd::Rebuild { generation: g });
    rig.wait(Duration::from_secs(2), "the rebuilt stream", |_| {
        rig.engine.diagnostics().output_generation == g + 1
    });
    std::thread::sleep(Duration::from_millis(300));
    let s = rig.engine.snapshot();
    assert_eq!(s.status, PlaybackStatus::Paused);
    assert!(s.file_ms.abs_diff(at) <= 1, "{} vs {at}", s.file_ms);
    rig.engine.resume();
    rig.wait(Duration::from_secs(3), "playing on", |s| {
        s.status == PlaybackStatus::Playing && s.file_ms > at + 200
    });
}

/// The real device path, without ever opening a stream (LEAD item 9): an idle engine only probes for a device.
#[test]
fn an_idle_engine_never_opens_the_audio_device() {
    let timings = std::sync::Arc::new(quran_audio::fake_out::fixtures::FixtureTimings::new(7));
    let sources = std::sync::Arc::new(quran_audio::fake_out::fixtures::FixtureSources::new(
        common::layout(),
        48_000,
        2,
    ));
    let engine = AudioEngine::start_with_output(
        EngineConfig::default(),
        timings,
        sources,
        std::sync::Arc::new(NullEventSink),
        OutputKind::Device,
    )
    .unwrap();
    // The probe answers either way: a device label (idle), or no device (error, retried every 2 s).
    let deadline = Instant::now() + Duration::from_secs(5);
    let s = loop {
        let s = engine.snapshot();
        if s.device.is_some() || s.status == PlaybackStatus::Error {
            break s;
        }
        assert!(Instant::now() < deadline, "no probe result: {s:#?}");
        std::thread::sleep(Duration::from_millis(10));
    };
    match s.status {
        PlaybackStatus::Idle => assert!(s.device.is_some_and(|d| !d.is_empty())),
        PlaybackStatus::Error => assert_eq!(s.error.map(|e| e.kind()), Some("audio")),
        other => panic!("unexpected status {other:?}"),
    }
    std::thread::sleep(Duration::from_millis(200));
    let d = engine.diagnostics();
    assert!(!d.output_open, "no stream while idle");
    assert_eq!(d.output_generation, 0);
    let t0 = Instant::now();
    engine.shutdown();
    engine.shutdown();
    assert!(t0.elapsed() < Duration::from_millis(600));
}
