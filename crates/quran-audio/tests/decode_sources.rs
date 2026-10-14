//! Sources as decode sees them: next-file prefetch (`NeedSource` before the file is needed), a late source (decode
//! writes nothing, the ring drains, position stays exact), failed sources (offline basmala skipped, anything else fails
//! the queue), MP3 timing through the whole path, the real `qd-audio-decode` thread, and a queue loaded before the
//! first output exists.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crossbeam_channel::unbounded;
use quran_audio::decode::{
    DecodeConfig, DecodeState, Decoder, Pump, frame_to_us, ms_to_frame, spawn,
};
use quran_audio::fake_out::fixtures::{
    FixtureSources, FixtureTimings, Layout, file_key, silent_mp3,
};
use quran_audio::fake_out::{FakeOut, Rig};
use quran_audio::shared::{CtlMsg, DecodeCmd, DecodeParams, MarkerKind, Shared};
use quran_audio::{AudioError, FileKey, OpenedSource, Segment, SegmentKind, SourceProvider, plan};
use quran_types::{AyahRef, GapSetting, MushafLayout, PlayRequest};

fn req(from: (u32, u32), to: (u32, u32)) -> PlayRequest {
    PlayRequest {
        reciter_id: 7,
        from: AyahRef {
            surah: from.0,
            ayah: from.1,
        },
        to: Some(AyahRef {
            surah: to.0,
            ayah: to.1,
        }),
        stop_at: None,
        layout: MushafLayout::V2,
        ayah_repeat: 1,
        range_repeat: 1,
        gap: GapSetting::None,
        start_paused: false,
        record: true,
    }
}

fn need_sources(rig: &Rig) -> Vec<u16> {
    rig.messages
        .iter()
        .filter_map(|m| match m {
            CtlMsg::NeedSource(k) => Some(k.surah),
            _ => None,
        })
        .collect()
}

fn segs(rig: &Rig) -> Vec<u32> {
    rig.events()
        .iter()
        .filter(|a| a.marker.kind == MarkerKind::Segment)
        .map(|a| a.marker.seg_index)
        .collect()
}

#[test]
fn prefetch_asks_for_the_next_file_within_the_window() {
    // Ayahs longer than the window, so the request must come in the middle of the file's last ayah.
    let layout = Layout {
        ayah_ms: 6_000,
        ..Layout::default()
    };
    let timings = FixtureTimings::new(7).with_layout(layout);
    let sources = Arc::new(FixtureSources::new(layout, 48_000, 1));
    let cfg = DecodeConfig {
        prefetch_next_file_ms: 2_500,
    };
    let mut rig = Rig::with_config(cfg, 48_000, 2, 750).with_sources(sources.clone());
    rig.answer_need_source = false;
    let queue = plan(&req((112, 2), (113, 1)), &timings).unwrap();
    assert_eq!(queue[3].kind, SegmentKind::Basmala);
    let last_of_file = queue[2].end_ms;
    rig.load(queue.clone(), 0, None, DecodeParams::default())
        .unwrap();
    let window_us = u64::from(last_of_file - 2_500) * 1_000;
    let mut before = (0, 0);
    while need_sources(&rig).is_empty() {
        before = rig.decoder.position().unwrap();
        assert!(rig.step());
        assert!(rig.out.device_frames() < 48_000 * 30);
    }
    // Sent while the file's last segment plays, on the first step inside the window, not earlier.
    let (seg, at) = rig.decoder.position().unwrap();
    assert_eq!(seg, 2);
    assert!(at >= window_us);
    assert_eq!(before.0, 2);
    assert!(before.1 < window_us, "{before:?} vs {window_us}");
    assert!(at - before.1 < 50_000, "promptly: {at} after {}", before.1);
    assert_eq!(need_sources(&rig), [1]);
    // Control answers in time: no wait, no underrun, seamless markers.
    let key = queue[3].file.clone();
    let source = sources.open(&key).unwrap();
    rig.cmd(DecodeCmd::SourceReady { key, source });
    rig.answer_need_source = true;
    assert!(rig.run_to_end(60));
    assert_eq!(segs(&rig), [0, 1, 2, 3, 4]);
    assert!(rig.out.underruns() <= 1);
    assert_eq!(need_sources(&rig), [1, 113]);
}

#[test]
fn a_late_source_drains_the_ring_and_keeps_positions_exact() {
    let timings = FixtureTimings::new(7);
    let sources = Arc::new(FixtureSources::new(timings.layout(), 48_000, 1));
    let mut rig = Rig::new(48_000, 2, 750).with_sources(sources.clone());
    rig.answer_need_source = false;
    let queue = plan(&req((112, 4), (113, 1)), &timings).unwrap();
    rig.load(queue.clone(), 0, None, DecodeParams::default())
        .unwrap();
    let basmala_file = queue[1].file.clone();
    assert!(rig.run_until(48_000 * 10, |r| r.out.underruns() >= 5));
    assert_eq!(
        rig.decoder.state(),
        DecodeState::WaitingForSource(basmala_file.clone())
    );
    let (s, e) = (
        ms_to_frame(queue[0].start_ms, 48_000),
        ms_to_frame(queue[0].end_ms, 48_000),
    );
    assert_eq!(
        rig.decoder.written_frames(),
        e - s,
        "nothing written while waiting"
    );
    assert_eq!(rig.out.read_frame(), e - s, "the ring drained");
    // The source arrives late: playback continues with the basmala at the next ring frame.
    let source = sources.open(&basmala_file).unwrap();
    rig.cmd(DecodeCmd::SourceReady {
        key: basmala_file,
        source,
    });
    rig.answer_need_source = true;
    assert!(rig.run_to_end(30));
    let events = rig.events();
    assert_eq!(segs(&rig), [0, 1, 2]);
    assert_eq!(events[1].marker.ring_frame, e - s);
    let b0 = ms_to_frame(queue[1].start_ms, 48_000);
    assert_eq!(events[1].marker.file_pos_us, frame_to_us(b0, 48_000));
}

#[test]
fn an_offline_basmala_file_is_skipped_but_an_offline_ayah_file_fails() {
    let timings = FixtureTimings::new(7);
    let sources = Arc::new(FixtureSources::new(timings.layout(), 48_000, 1));
    sources.set_offline(1, true);
    let mut rig = Rig::new(48_000, 2, 750).with_sources(sources.clone());
    let queue = plan(&req((112, 4), (113, 2)), &timings).unwrap();
    assert_eq!(queue[1].kind, SegmentKind::Basmala);
    rig.load(queue.clone(), 0, None, DecodeParams::default())
        .unwrap();
    assert!(rig.run_to_end(30));
    assert_eq!(segs(&rig), [0, 2, 3]);
    assert!(
        !rig.messages
            .iter()
            .any(|m| matches!(m, CtlMsg::DecodeFailed(_)))
    );
    // Seamless timeline: 113:1 starts right after 112:4's drained frames.
    let (s, e) = (
        ms_to_frame(queue[0].start_ms, 48_000),
        ms_to_frame(queue[0].end_ms, 48_000),
    );
    assert_eq!(rig.events()[1].marker.ring_frame, e - s);

    sources.set_offline(1, false);
    sources.set_offline(113, true);
    let mut rig = Rig::new(48_000, 2, 750).with_sources(sources);
    rig.load(queue, 0, None, DecodeParams::default()).unwrap();
    assert!(rig.run_until(48_000 * 10, |r| {
        r.messages
            .iter()
            .any(|m| matches!(m, CtlMsg::DecodeFailed(_)))
    }));
    assert!(
        rig.messages
            .iter()
            .any(|m| matches!(m, CtlMsg::DecodeFailed(AudioError::Offline(_))))
    );
    assert!(rig.pump());
    assert_eq!(rig.decoder.state(), DecodeState::Idle);
}

/// Segments of a silent MP3 (44.1 kHz stereo).
fn mp3_queue() -> (FileKey, Vec<Segment>) {
    let key = FileKey {
        url: "https://download.example.invalid/qdc/7/112.mp3".into(),
        ..file_key(7, 112)
    };
    let seg = |ayah: u16, start_ms, end_ms| Segment {
        kind: SegmentKind::Ayah,
        surah: 112,
        ayah,
        ayah_id: 6_221 + u32::from(ayah),
        file: key.clone(),
        start_ms,
        end_ms,
        words: Arc::from(Vec::new()),
    };
    // Two contiguous ayahs, then one after a breath.
    (
        key.clone(),
        vec![
            seg(1, 1_000, 3_000),
            seg(2, 3_000, 5_500),
            seg(3, 6_000, 7_000),
        ],
    )
}

#[test]
fn mp3_timing_is_exact_through_the_whole_path() {
    for out_rate in [44_100_u32, 48_000] {
        let (key, queue) = mp3_queue();
        let sources = Arc::new(FixtureSources::new(Default::default(), 44_100, 2));
        sources.insert(key, silent_mp3(400, true));
        let mut rig = Rig::new(out_rate, 2, 750).with_sources(sources);
        rig.load(queue.clone(), 0, None, DecodeParams::default())
            .unwrap();
        assert!(rig.run_to_end(30));
        let events = rig.events();
        assert_eq!(segs(&rig), [0, 1, 2]);
        let at = |src_frames: u64| {
            (u128::from(src_frames) * u128::from(out_rate)).div_ceil(44_100) as u64
        };
        let f = |ms: u32| ms_to_frame(ms, 44_100);
        // Contiguous boundary at ⌈(S₂ − S₁)·out/src⌉, the drained first chain, then the third ayah.
        assert_eq!(events[1].marker.ring_frame, at(f(3_000) - f(1_000)));
        let first_chain = at(f(5_500) - f(1_000));
        assert_eq!(events[2].marker.ring_frame, first_chain);
        assert_eq!(events[3].marker.kind, MarkerKind::End);
        assert_eq!(
            events[3].marker.ring_frame,
            first_chain + at(f(7_000) - f(6_000))
        );
        if out_rate == 44_100 {
            assert_eq!(events[1].marker.ring_frame, 88_200);
            assert_eq!(events[2].marker.ring_frame, 198_450);
            assert_eq!(events[3].marker.ring_frame, 242_550);
        }
    }
}

#[test]
fn a_garbage_file_fails_the_queue_without_panicking() {
    let (key, queue) = mp3_queue();
    let sources = Arc::new(FixtureSources::new(Default::default(), 44_100, 2));
    sources.insert(key, vec![0x5A; 10_000]);
    let mut rig = Rig::new(48_000, 2, 750).with_sources(sources);
    rig.load(queue, 0, None, DecodeParams::default()).unwrap();
    assert!(rig.pump());
    assert!(rig.messages.iter().any(|m| matches!(
        m,
        CtlMsg::DecodeFailed(AudioError::Decode(_) | AudioError::Source(_))
    )));
    assert_eq!(rig.decoder.state(), DecodeState::Idle);
    // Commands on an idle decoder are harmless.
    rig.cmd(DecodeCmd::Jump { index: 3 });
    rig.cmd(DecodeCmd::Seek { file_ms: 10 });
    rig.cmd(DecodeCmd::SetSpeed { speed_pct: 150 });
    assert!(rig.step());
}

#[test]
fn a_queue_loaded_before_the_output_starts_with_it() {
    let timings = FixtureTimings::new(7);
    let sources = FixtureSources::new(timings.layout(), 48_000, 1);
    let shared = Arc::new(Shared::new());
    shared.playing.store(true, Ordering::Relaxed);
    let (ctl_tx, _ctl_rx) = unbounded();
    let mut decoder = Decoder::new(DecodeConfig::default(), ctl_tx, Arc::clone(&shared));
    let queue: Arc<[Segment]> = Arc::from(plan(&req((1, 1), (1, 2)), &timings).unwrap());
    let source = sources.open(&queue[0].file).unwrap();
    decoder.handle(DecodeCmd::Load {
        queue: Arc::clone(&queue),
        start: 1,
        start_ms: None,
        passes: 1,
        source,
        params: DecodeParams::default(),
    });
    assert_eq!(decoder.state(), DecodeState::WaitingForOutput);
    assert_eq!(decoder.pump(), Pump::Idle);
    let (mut out, cmd) = FakeOut::new(Arc::clone(&shared), 48_000, 2, 750);
    decoder.handle(cmd);
    assert_eq!(decoder.state(), DecodeState::Playing { index: 1 });
    while decoder.pump() == Pump::Progress {}
    out.render(480);
    let first = out.applied()[0].marker;
    assert_eq!(
        (first.seg_index, first.ring_frame, first.kind),
        (1, 0, MarkerKind::Segment)
    );
    assert_eq!(first.generation, shared.generation.load(Ordering::Acquire));
}

#[test]
fn the_decode_thread_plays_a_queue_and_shuts_down() {
    let timings = FixtureTimings::new(7);
    let sources = FixtureSources::new(timings.layout(), 48_000, 1);
    let shared = Arc::new(Shared::new());
    shared.playing.store(true, Ordering::Relaxed);
    let (cmd_tx, cmd_rx) = unbounded();
    let (ctl_tx, ctl_rx) = unbounded();
    let handle = spawn(DecodeConfig::default(), cmd_rx, ctl_tx, Arc::clone(&shared)).unwrap();
    let (mut out, new_output) = FakeOut::new(Arc::clone(&shared), 48_000, 2, 750);
    cmd_tx.send(new_output).unwrap();
    let queue: Arc<[Segment]> = Arc::from(plan(&req((112, 1), (112, 4)), &timings).unwrap());
    let source = sources.open(&queue[0].file).unwrap();
    cmd_tx
        .send(DecodeCmd::Load {
            queue: Arc::clone(&queue),
            start: 0,
            start_ms: None,
            passes: 1,
            source,
            params: DecodeParams::default(),
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut ended = false;
    let mut messages = Vec::new();
    while Instant::now() < deadline && !ended {
        // Answer control messages like qd-audio-ctl.
        while let Ok(msg) = ctl_rx.try_recv() {
            if let CtlMsg::NeedSource(key) = &msg {
                let source = sources.open(key).unwrap();
                cmd_tx
                    .send(DecodeCmd::SourceReady {
                        key: key.clone(),
                        source,
                    })
                    .unwrap();
            }
            ended |= matches!(msg, CtlMsg::QueueEnded);
            messages.push(msg);
        }
        out.render(4_800);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(ended, "QueueEnded within the deadline: {messages:?}");
    // Drain what is left in the ring and check the markers.
    out.render_frames(48_000, 4_800);
    let events: Vec<_> = out
        .applied()
        .iter()
        .filter(|a| a.marker.kind != MarkerKind::Sync)
        .copied()
        .collect();
    assert_eq!(events.len(), queue.len() + 1);
    let mut ring = 0;
    for (a, seg) in events.iter().zip(queue.iter()) {
        assert_eq!(a.marker.ring_frame, ring);
        assert_eq!(a.read_frame, ring);
        ring += ms_to_frame(seg.end_ms, 48_000) - ms_to_frame(seg.start_ms, 48_000);
    }
    assert_eq!(events.last().unwrap().marker.kind, MarkerKind::End);
    assert_eq!(events.last().unwrap().marker.ring_frame, ring);
    cmd_tx.send(DecodeCmd::Shutdown).unwrap();
    handle.join().unwrap();
}

#[test]
fn the_decode_thread_exits_when_its_channel_closes() {
    let shared = Arc::new(Shared::new());
    let (cmd_tx, cmd_rx) = unbounded::<DecodeCmd>();
    let (ctl_tx, _ctl_rx) = unbounded();
    let handle = spawn(DecodeConfig::default(), cmd_rx, ctl_tx, shared).unwrap();
    drop(cmd_tx);
    handle.join().unwrap();
}

#[test]
fn unexpected_sources_are_dropped_and_bad_jumps_ignored() {
    let timings = FixtureTimings::new(7);
    let sources = Arc::new(FixtureSources::new(timings.layout(), 48_000, 1));
    let mut rig = Rig::new(48_000, 2, 750).with_sources(sources.clone());
    let queue = plan(&req((1, 1), (1, 3)), &timings).unwrap();
    rig.load(queue, 0, None, DecodeParams::default()).unwrap();
    assert!(rig.step());
    let generation = rig.decoder.generation();
    let stray = file_key(7, 50);
    let source = OpenedSource::complete(Box::new(Cursor::new(vec![0_u8; 8])));
    rig.cmd(DecodeCmd::SourceReady {
        key: stray.clone(),
        source,
    });
    rig.cmd(DecodeCmd::SourceFailed {
        key: stray,
        error: AudioError::Offline("x".into()),
    });
    rig.cmd(DecodeCmd::Jump { index: 99 });
    assert_eq!(rig.decoder.generation(), generation);
    assert!(rig.run_to_end(30));
    assert_eq!(segs(&rig), [0, 1, 2]);
}
