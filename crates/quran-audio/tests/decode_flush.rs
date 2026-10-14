//! Flush generations: jumps, seeks, speed changes, a rebuilt output, an A-B loop set behind the decoder and stop all
//! bump the generation; the callback discards every stale frame up to the first marker of the new generation, and
//! playback continues from the position the listener is at (the consumed ring frame), with repeats, passes and gaps
//! restored. In-band settings (repeat, gap) apply from the next boundary.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use std::sync::Arc;
use std::sync::atomic::Ordering;

use quran_audio::decode::{DecodeState, frame_to_us, ms_to_frame, silence_frames, us_to_frame};
use quran_audio::fake_out::fixtures::{FixtureSources, FixtureTimings, ramp_frame};
use quran_audio::fake_out::{Applied, FakeOut, Rig};
use quran_audio::shared::{CtlMsg, DecodeCmd, DecodeParams, MarkerKind, MediaRate};
use quran_audio::{Segment, plan};
use quran_types::{AbLoop, AyahRef, GapSetting, MushafLayout, PlayRequest};

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

fn setup(
    src_rate: u32,
    out_rate: u32,
    r: &PlayRequest,
    params: DecodeParams,
) -> (Vec<Segment>, Rig) {
    let timings = FixtureTimings::new(7);
    let sources = Arc::new(FixtureSources::new(timings.layout(), src_rate, 1));
    let mut rig = Rig::new(out_rate, 2, 750).with_sources(sources);
    rig.out.set_recording(true);
    let queue = plan(r, &timings).unwrap();
    rig.load(queue.clone(), 0, None, params).unwrap();
    (queue, rig)
}

fn steps(rig: &mut Rig, n: usize) {
    for _ in 0..n {
        assert!(rig.step());
    }
}

fn src_at(rig: &Rig, ring: u64) -> u64 {
    ramp_frame(rig.out.played_ring_frame(ring).expect("played")[0])
}

/// Applied markers of generation `generation`, Sync excluded.
fn events_of(rig: &Rig, generation: u32) -> Vec<Applied> {
    rig.events()
        .into_iter()
        .filter(|a| a.marker.generation == generation)
        .collect()
}

/// What the listener hears next: the fake device's marker extrapolated to its read frame.
fn consumed_us(rig: &Rig) -> u64 {
    rig.out.current().position_at(rig.out.read_frame())
}

#[test]
fn jump_discards_stale_frames_and_restarts_exactly() {
    let (queue, mut rig) = setup(
        48_000,
        48_000,
        &req((1, 1), (1, 7)),
        DecodeParams::default(),
    );
    steps(&mut rig, 25);
    let generation = rig.shared.generation.load(Ordering::Acquire);
    let read = rig.out.read_frame();
    let written = rig.decoder.written_frames();
    assert!(
        written > read + 30_000,
        "decode runs ahead: {written} vs {read}"
    );

    rig.cmd(DecodeCmd::Jump { index: 4 });
    let new_gen = rig.shared.generation.load(Ordering::Acquire);
    assert_eq!(new_gen, generation + 1);
    assert_eq!(rig.decoder.generation(), new_gen);
    steps(&mut rig, 1);
    assert_eq!(
        rig.out.discarded(),
        written - read,
        "every stale frame dropped"
    );
    let first = events_of(&rig, new_gen)[0];
    assert_eq!(
        (first.marker.kind, first.marker.seg_index),
        (MarkerKind::Segment, 4)
    );
    assert_eq!(first.marker.ring_frame, written);
    let s4 = ms_to_frame(queue[4].start_ms, 48_000);
    assert_eq!(first.marker.file_pos_us, frame_to_us(s4, 48_000));

    assert!(rig.run_to_end(30));
    let events = events_of(&rig, new_gen);
    let segs: Vec<u32> = events.iter().map(|a| a.marker.seg_index).collect();
    assert_eq!(segs, [4, 5, 6, 6]);
    let mut ring = written;
    for a in &events[..3] {
        let seg = &queue[a.marker.seg_index as usize];
        let (s, e) = (
            ms_to_frame(seg.start_ms, 48_000),
            ms_to_frame(seg.end_ms, 48_000),
        );
        assert_eq!(a.marker.ring_frame, ring);
        ring += e - s;
    }
    assert_eq!(events[3].marker.kind, MarkerKind::End);
    assert_eq!(events[3].marker.ring_frame, ring);
    // After the fade-in the audio is the jump target, exactly.
    assert_eq!(src_at(&rig, written + 192), s4 + 192);
    assert_eq!(src_at(&rig, written + 5_000), s4 + 5_000);
}

#[test]
fn seek_lands_on_the_exact_frame_in_the_right_segment() {
    // Repeat mode: ayahs end at `to`, so there are breaths between segments.
    let mut r = req((1, 1), (1, 7));
    r.ayah_repeat = 2;
    let params = DecodeParams {
        ayah_repeat: 2,
        ..DecodeParams::default()
    };
    let (queue, mut rig) = setup(48_000, 48_000, &r, params);
    steps(&mut rig, 10);

    // Inside ayah 3.
    let ms = queue[2].start_ms + 123;
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::Seek { file_ms: ms });
    let generation = rig.decoder.generation();
    steps(&mut rig, 30);
    let first = events_of(&rig, generation)[0];
    assert_eq!(
        (first.marker.seg_index, first.marker.ring_frame),
        (2, written)
    );
    let f = ms_to_frame(ms, 48_000);
    assert_eq!(first.marker.file_pos_us, frame_to_us(f, 48_000));
    assert_eq!(src_at(&rig, written + 192), f + 192);

    // In the breath after ayah 4: playback runs into ayah 5, which becomes current.
    let breath = queue[3].end_ms + 40;
    assert!(breath < queue[4].start_ms);
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::Seek { file_ms: breath });
    let generation = rig.decoder.generation();
    steps(&mut rig, 30);
    let first = events_of(&rig, generation)[0];
    assert_eq!(
        (first.marker.seg_index, first.marker.ring_frame),
        (4, written)
    );
    assert_eq!(
        src_at(&rig, written + 192),
        ms_to_frame(breath, 48_000) + 192
    );
    // The play counter of a newly entered segment restarts: ayah 5 still plays twice.
    assert!(rig.run_until(48_000 * 5, |r| events_of(r, generation).len() >= 2));
    assert_eq!(events_of(&rig, generation)[1].marker.seg_index, 4);

    // Past the end of the file: the last segment ends at once, the queue ends.
    rig.cmd(DecodeCmd::Seek { file_ms: 3_600_000 });
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(5));
    let tail = events_of(&rig, generation);
    assert_eq!(tail.last().unwrap().marker.kind, MarkerKind::End);
}

/// A seek outside the queued run of the file is bounded to it (the OS scrubber dragged to 0, a nudge back at the
/// first ayah): the file's earlier ayahs never play under the first ayah's label, and a file that also backs a basmala
/// elsewhere in the queue (the surah-1 file) never jumps there.
#[test]
fn seeks_stay_in_the_queued_run_of_the_file() {
    // 1:6, 1:7, the basmala of surah 2 (the surah-1 file's 1:1), 2:1, 2:2.
    let (queue, mut rig) = setup(
        48_000,
        48_000,
        &req((1, 6), (2, 2)),
        DecodeParams::default(),
    );
    assert_eq!(queue[2].kind, quran_audio::SegmentKind::Basmala);
    assert!(queue[2].start_ms < queue[0].start_ms);
    steps(&mut rig, 10);
    let start_of = |i: usize| ms_to_frame(queue[i].start_ms, 48_000);

    // Before the range: its first ayah, from its start.
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::Seek { file_ms: 0 });
    let generation = rig.decoder.generation();
    steps(&mut rig, 30);
    let first = events_of(&rig, generation)[0];
    assert_eq!(
        (first.marker.seg_index, first.marker.ring_frame),
        (0, written)
    );
    assert_eq!(first.marker.file_pos_us, frame_to_us(start_of(0), 48_000));
    assert_eq!(src_at(&rig, written + 192), start_of(0) + 192);

    // The same from 1:7, where the basmala (the 1:1 audio, before the range in the file) is nearer in the queue.
    rig.cmd(DecodeCmd::Jump { index: 1 });
    let jumped = rig.decoder.generation();
    assert!(rig.run_until(48_000 * 5, |r| {
        let m = r.out.current();
        m.generation == jumped && m.seg_index == 1
    }));
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::Seek { file_ms: 0 });
    let generation = rig.decoder.generation();
    steps(&mut rig, 30);
    let first = events_of(&rig, generation)[0];
    assert_eq!(
        (first.marker.seg_index, first.marker.ring_frame),
        (0, written)
    );
    assert_eq!(src_at(&rig, written + 192), start_of(0) + 192);

    // Past the run's end: its last segment ends at once, and the queue goes on (the basmala, then surah 2).
    rig.cmd(DecodeCmd::Seek { file_ms: 3_600_000 });
    let generation = rig.decoder.generation();
    assert!(rig.run_until(48_000 * 10, |r| {
        events_of(r, generation)
            .iter()
            .any(|a| a.marker.seg_index == 3)
    }));
    let segs: Vec<u32> = events_of(&rig, generation)
        .iter()
        .map(|a| a.marker.seg_index)
        .collect();
    assert_eq!(segs[..3], [1, 2, 3]);
}

/// Next at the last segment while range repeats remain (control decides that they do) starts the next pass at the
/// first segment: the markers count the pass, and the queue ends after the last one. A load can start in a later pass
/// (a failed play retried where it stopped).
#[test]
fn next_pass_and_a_load_in_a_later_pass_count_the_passes() {
    let params = DecodeParams {
        range_repeat: 2,
        ..DecodeParams::default()
    };
    let (queue, mut rig) = setup(48_000, 48_000, &req((1, 6), (1, 7)), params);
    steps(&mut rig, 10);
    rig.cmd(DecodeCmd::NextPass);
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let marks = |rig: &Rig, generation: u32| -> Vec<(u32, u32, MarkerKind)> {
        events_of(rig, generation)
            .iter()
            .map(|a| (a.marker.seg_index, a.marker.passes, a.marker.kind))
            .collect()
    };
    assert_eq!(
        marks(&rig, generation),
        [
            (0, 2, MarkerKind::Segment),
            (1, 2, MarkerKind::Segment),
            (1, 2, MarkerKind::End)
        ]
    );

    rig.load_in_pass(queue, 1, None, 2, params).unwrap();
    let generation = rig.decoder.generation();
    assert!(rig.run_until(48_000 * 30, |r| {
        events_of(r, generation)
            .iter()
            .any(|a| a.marker.kind == MarkerKind::End)
    }));
    assert_eq!(
        marks(&rig, generation),
        [(1, 2, MarkerKind::Segment), (1, 2, MarkerKind::End)],
        "the second pass of two: no third"
    );
}

#[test]
fn speed_change_flushes_and_continues_where_the_listener_is() {
    let (queue, mut rig) = setup(
        44_100,
        48_000,
        &req((1, 1), (1, 7)),
        DecodeParams::default(),
    );
    steps(&mut rig, 40);
    let heard = consumed_us(&rig);
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::SetSpeed { speed_pct: 150 });
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let events = events_of(&rig, generation);
    let first = events[0].marker;
    assert_eq!(first.ring_frame, written);
    assert_eq!(first.rate, MediaRate::new(150, 48_000));
    // Resumes at the consumed position (rounded up to the next source frame).
    let origin = us_to_frame(heard, 44_100);
    assert_eq!(first.file_pos_us, frame_to_us(origin, 44_100));
    assert!(first.file_pos_us >= heard && first.file_pos_us - heard < 23);
    // Later boundaries follow the new rate from the new origin.
    for a in &events[1..events.len() - 1] {
        let s = ms_to_frame(queue[a.marker.seg_index as usize].start_ms, 44_100);
        let u = (u128::from(s - origin) * 100 * 48_000).div_ceil(150 * 44_100) as u64;
        assert_eq!(a.marker.ring_frame, written + u);
    }
    assert_eq!(rig.decoder.params().speed_pct, 150);
    // Same speed again: no flush.
    rig.cmd(DecodeCmd::SetSpeed { speed_pct: 150 });
    assert_eq!(rig.decoder.generation(), generation);
}

#[test]
fn speed_change_during_a_gap_keeps_the_rest_of_the_gap() {
    let mut r = req((1, 1), (1, 2));
    r.gap = GapSetting::Fixed { ms: 2_000 };
    let params = DecodeParams {
        gap: r.gap,
        ..DecodeParams::default()
    };
    let (queue, mut rig) = setup(48_000, 48_000, &r, params);
    assert!(rig.run_until(48_000 * 10, |r| {
        r.events().iter().any(|a| a.marker.kind == MarkerKind::Gap)
    }));
    steps(&mut rig, 50);
    let gap = rig
        .events()
        .into_iter()
        .find(|a| a.marker.kind == MarkerKind::Gap)
        .unwrap();
    let read = rig.out.read_frame();
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::SetSpeed { speed_pct: 80 });
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let events = events_of(&rig, generation);
    let left = silence_frames(2_000, 48_000) - (read - gap.marker.ring_frame);
    assert_eq!(
        (events[0].marker.kind, events[0].marker.seg_index),
        (MarkerKind::Gap, 0)
    );
    assert_eq!(events[0].marker.ring_frame, written);
    assert_eq!(events[0].marker.file_pos_us, gap.marker.file_pos_us);
    assert_eq!(
        (events[1].marker.kind, events[1].marker.seg_index),
        (MarkerKind::Segment, 1)
    );
    assert_eq!(events[1].marker.ring_frame, written + left);
    assert_eq!(events[1].marker.rate, MediaRate::new(80, 48_000));
    assert_eq!(
        events[1].marker.file_pos_us,
        frame_to_us(ms_to_frame(queue[1].start_ms, 48_000), 48_000)
    );
}

#[test]
fn a_rebuilt_output_resumes_at_the_given_position_on_the_new_format() {
    let (queue, mut rig) = setup(
        44_100,
        48_000,
        &req((1, 1), (1, 7)),
        DecodeParams::default(),
    );
    steps(&mut rig, 120);
    let heard = consumed_us(&rig);
    let seg = rig.out.current().seg_index;
    // The output thread rebuilt the stream on a 44.1 kHz device.
    let (mut out, cmd) = FakeOut::with_resume(Arc::clone(&rig.shared), 44_100, 2, 750, Some(heard));
    out.set_recording(true);
    rig.out = out;
    rig.cmd(cmd);
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let events = events_of(&rig, generation);
    let first = events[0].marker;
    let origin = us_to_frame(heard, 44_100);
    assert_eq!((first.ring_frame, first.seg_index), (0, seg));
    assert_eq!(first.file_pos_us, frame_to_us(origin, 44_100));
    assert_eq!(first.rate, MediaRate::new(100, 44_100));
    // Bit-exact again (equal rates now): after the fade, ring frame k is source frame origin + k.
    assert_eq!(src_at(&rig, 176), origin + 176);
    assert_eq!(src_at(&rig, 10_000), origin + 10_000);
    for a in &events[1..events.len() - 1] {
        let s = ms_to_frame(queue[a.marker.seg_index as usize].start_ms, 44_100);
        assert_eq!(a.marker.ring_frame, s - origin);
    }
}

#[test]
fn ab_loop_set_behind_the_decoder_wraps_exactly_at_b() {
    let (queue, mut rig) = setup(
        48_000,
        48_000,
        &req((1, 1), (1, 7)),
        DecodeParams::default(),
    );
    // Listener in ayah 3, decoder ~750 ms ahead.
    assert!(
        rig.run_until(48_000 * 10, |r| r.out.current().seg_index == 2
            && r.events().len() >= 3)
    );
    steps(&mut rig, 20);
    let heard = consumed_us(&rig);
    let (_, decoded_us) = rig.decoder.position().unwrap();
    let b_ms = u32::try_from(heard / 1_000).unwrap() + 300;
    assert!(
        u64::from(b_ms) * 1_000 < decoded_us,
        "decode is already past B"
    );
    let a_ms = queue[1].start_ms + 50;
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::SetAbLoop(Some(AbLoop { a_ms, b_ms })));
    let generation = rig.decoder.generation();
    assert!(rig.run_until(48_000 * 10, |r| events_of(r, generation).len() >= 4));
    let events = events_of(&rig, generation);
    // Resume where the listener is, then wrap to A exactly at B.
    let origin = us_to_frame(heard, 48_000);
    let b = ms_to_frame(b_ms, 48_000);
    assert_eq!(events[0].marker.ring_frame, written);
    assert_eq!(events[0].marker.file_pos_us, frame_to_us(origin, 48_000));
    let wrap = events.iter().find(|a| a.marker.seg_index == 1).unwrap();
    assert_eq!(wrap.marker.ring_frame, written + (b - origin));
    assert_eq!(
        wrap.marker.file_pos_us,
        frame_to_us(ms_to_frame(a_ms, 48_000), 48_000)
    );
    assert_eq!(src_at(&rig, wrap.marker.ring_frame - 193), b - 193);
    assert_eq!(rig.decoder.params().ab_loop, Some(AbLoop { a_ms, b_ms }));
}

#[test]
fn ab_loop_set_after_b_was_heard_wraps_now() {
    let (queue, mut rig) = setup(
        48_000,
        48_000,
        &req((1, 1), (1, 7)),
        DecodeParams::default(),
    );
    assert!(rig.run_until(48_000 * 10, |r| r.out.current().seg_index == 4));
    let a_ms = queue[1].start_ms;
    let b_ms = queue[2].start_ms + 300;
    let written = rig.decoder.written_frames();
    rig.cmd(DecodeCmd::SetAbLoop(Some(AbLoop { a_ms, b_ms })));
    let generation = rig.decoder.generation();
    steps(&mut rig, 2);
    let first = events_of(&rig, generation)[0];
    assert_eq!(
        (first.marker.seg_index, first.marker.ring_frame),
        (1, written)
    );
    assert_eq!(
        first.marker.file_pos_us,
        frame_to_us(ms_to_frame(a_ms, 48_000), 48_000)
    );
    // An inverted loop is ignored (and clears the loop).
    rig.cmd(DecodeCmd::SetAbLoop(Some(AbLoop {
        a_ms: 900,
        b_ms: 900,
    })));
    assert_eq!(rig.decoder.params().ab_loop, None);
}

#[test]
fn stop_silences_at_once_and_a_new_load_plays() {
    let (queue, mut rig) = setup(
        48_000,
        48_000,
        &req((1, 1), (1, 7)),
        DecodeParams::default(),
    );
    steps(&mut rig, 30);
    let applied = rig.out.applied().len();
    rig.cmd(DecodeCmd::Stop);
    steps(&mut rig, 10);
    assert_eq!(rig.decoder.state(), DecodeState::Idle);
    assert_eq!(rig.out.applied().len(), applied, "no marker after stop");
    let silent_from = rig.out.audio().len() - 10 * 480 * 2;
    assert!(rig.out.audio()[silent_from..].iter().all(|&s| s == 0.0));
    assert!(!rig.messages.iter().any(|m| matches!(m, CtlMsg::QueueEnded)));
    // A new play starts cleanly.
    rig.load(queue, 2, None, DecodeParams::default()).unwrap();
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let segs: Vec<u32> = events_of(&rig, generation)
        .iter()
        .map(|a| a.marker.seg_index)
        .collect();
    assert_eq!(segs, [2, 3, 4, 5, 6, 6]);
}

#[test]
fn repeat_and_gap_changes_apply_in_band_from_the_next_boundary() {
    let mut r = req((1, 1), (1, 3));
    r.ayah_repeat = 2;
    let params = DecodeParams {
        ayah_repeat: 2,
        ..DecodeParams::default()
    };
    let (_, mut rig) = setup(48_000, 48_000, &r, params);
    steps(&mut rig, 1);
    let generation = rig.decoder.generation();
    rig.cmd(DecodeCmd::SetRepeat {
        ayah_repeat: 3,
        range_repeat: 1,
    });
    rig.cmd(DecodeCmd::SetGap(GapSetting::Fixed { ms: 250 }));
    assert_eq!(rig.decoder.generation(), generation, "no flush");
    assert!(rig.run_to_end(60));
    let kinds: Vec<(MarkerKind, u32)> = rig
        .events()
        .iter()
        .map(|a| (a.marker.kind, a.marker.seg_index))
        .collect();
    use MarkerKind::{End, Gap, Segment as Seg};
    assert_eq!(
        kinds,
        [
            (Seg, 0),
            (Gap, 0),
            (Seg, 0),
            (Gap, 0),
            (Seg, 0),
            (Gap, 0),
            (Seg, 1),
            (Gap, 1),
            (Seg, 1),
            (Gap, 1),
            (Seg, 1),
            (Gap, 1),
            (Seg, 2),
            (Gap, 2),
            (Seg, 2),
            (Gap, 2),
            (Seg, 2),
            (End, 2),
        ]
    );
    assert_eq!(rig.decoder.params().ayah_repeat, 3);
}

#[test]
fn a_rebuild_during_a_gap_keeps_the_rest_of_it_at_the_new_rate() {
    let mut r = req((1, 1), (1, 2));
    r.gap = GapSetting::Fixed { ms: 2_000 };
    let params = DecodeParams {
        gap: r.gap,
        ..DecodeParams::default()
    };
    let (queue, mut rig) = setup(44_100, 48_000, &r, params);
    assert!(rig.run_until(48_000 * 10, |r| {
        r.events().iter().any(|a| a.marker.kind == MarkerKind::Gap)
    }));
    steps(&mut rig, 30);
    let gap = rig
        .events()
        .into_iter()
        .find(|a| a.marker.kind == MarkerKind::Gap)
        .unwrap();
    let left_48k = silence_frames(2_000, 48_000) - (rig.out.read_frame() - gap.marker.ring_frame);
    let (out, cmd) = FakeOut::with_resume(
        Arc::clone(&rig.shared),
        44_100,
        2,
        750,
        Some(gap.marker.file_pos_us),
    );
    rig.out = out;
    rig.cmd(cmd);
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let events = events_of(&rig, generation);
    assert_eq!(
        (events[0].marker.kind, events[0].marker.ring_frame),
        (MarkerKind::Gap, 0)
    );
    let left = left_48k * 44_100 / 48_000;
    assert_eq!(
        (events[1].marker.seg_index, events[1].marker.ring_frame),
        (1, left)
    );
    let s1 = ms_to_frame(queue[1].start_ms, 44_100);
    assert_eq!(events[1].marker.file_pos_us, frame_to_us(s1, 44_100));
}

#[test]
fn a_rebuild_resuming_in_the_previous_segment_finishes_it_once() {
    let mut r = req((1, 1), (1, 4));
    r.ayah_repeat = 2;
    let params = DecodeParams {
        ayah_repeat: 2,
        ..DecodeParams::default()
    };
    let (queue, mut rig) = setup(48_000, 48_000, &r, params);
    // Just after the first play of ayah 2 became audible...
    assert!(rig.run_until(48_000 * 20, |r| {
        r.events().iter().any(|a| a.marker.seg_index == 1)
    }));
    assert_eq!(rig.out.current().seg_index, 1);
    // ...the device reports an audible position 30 ms earlier: the tail of ayah 1's second (last) play.
    let audible = frame_to_us(ms_to_frame(queue[0].end_ms, 48_000), 48_000) - 30_000;
    let (out, cmd) = FakeOut::with_resume(Arc::clone(&rig.shared), 48_000, 2, 750, Some(audible));
    rig.out = out;
    rig.cmd(cmd);
    let generation = rig.decoder.generation();
    assert!(rig.run_to_end(30));
    let events = events_of(&rig, generation);
    let segs: Vec<u32> = events.iter().map(|a| a.marker.seg_index).collect();
    // Ayah 1's tail plays as its last play (no third play), then ayahs 2, 3 and 4 twice each, then End.
    assert_eq!(segs, [0, 1, 1, 2, 2, 3, 3, 3]);
    assert_eq!(
        events[0].marker.file_pos_us,
        frame_to_us(us_to_frame(audible, 48_000), 48_000)
    );
    assert_eq!(events[7].marker.kind, MarkerKind::End);
}
