//! The decode state machine driven by `fake_out` (docs/ARCHITECTURE.md §2.3.4, §12.1): marker frames exact to ±0 for
//! continuous play, cross-surah files with basmalas, repeat ×N, range ×N, gaps (fixed and multiplier), A-B wraps and
//! End; Sync markers every ~100 ms whose positions follow the exact rational rate; speed and resampling.
//!
//! The fixtures are ramp WAVs: every sample holds its own source frame index, so at 100 % with equal rates the output
//! is bit-transparent (apart from the 4 ms fades at non-contiguous entries and ends) and a test reads the exact source
//! frame back from any played ring frame.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss
)]

use std::sync::Arc;
use std::sync::atomic::Ordering;

use quran_audio::decode::{DecodeState, frame_to_us, ms_to_frame, silence_frames};
use quran_audio::fake_out::fixtures::{FixtureSources, FixtureTimings, Layout, ramp_frame};
use quran_audio::fake_out::{Applied, Rig};
use quran_audio::shared::{CtlMsg, DecodeCmd, DecodeParams, MarkerKind, MediaRate};
use quran_audio::{Segment, SegmentKind, plan};
use quran_types::{AbLoop, AyahRef, GapSetting, MushafLayout, PlayRequest};

/// Frames of the 4 ms fade at 48 kHz (and 176 at 44.1 kHz).
const FADE_48K: u64 = 192;

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

/// A rig on a `rate` Hz stereo device fed by ramp WAVs at `src_rate` (mono).
fn rig(src_rate: u32, rate: u32) -> (FixtureTimings, Rig) {
    let timings = FixtureTimings::new(7);
    let sources = Arc::new(FixtureSources::new(timings.layout(), src_rate, 1));
    let mut rig = Rig::new(rate, 2, 750).with_sources(sources);
    rig.out.set_recording(true);
    (timings, rig)
}

fn frames(seg: &Segment, rate: u32) -> (u64, u64) {
    (
        ms_to_frame(seg.start_ms, rate),
        ms_to_frame(seg.end_ms, rate),
    )
}

/// The source frame a played ring frame carried (mono ramp on a stereo device: both channels equal).
fn src_at(rig: &Rig, ring: u64) -> u64 {
    let f = rig
        .out
        .played_ring_frame(ring)
        .expect("ring frame was played");
    assert_eq!(f[0], f[1]);
    ramp_frame(f[0])
}

fn assert_applied_on_their_frames(applied: &[Applied]) {
    for a in applied {
        if a.marker.kind != MarkerKind::Sync {
            assert_eq!(a.read_frame, a.marker.ring_frame, "{a:?}");
        }
    }
    for w in applied.windows(2) {
        assert!(
            w[0].marker.ring_frame <= w[1].marker.ring_frame,
            "ordered: {w:?}"
        );
    }
}

/// Checks a non-contiguous entry (after a flush or drain): the frame right after the 4 ms fade-in is exact.
fn assert_entry(rig: &Rig, ring: u64, src: u64) {
    assert_eq!(
        src_at(rig, ring + FADE_48K),
        src + FADE_48K,
        "entry at ring {ring}"
    );
}

/// Checks a seamless boundary: the marker's frame is `src`, the frame before it `src − 1`.
fn assert_seamless(rig: &Rig, ring: u64, src: u64) {
    assert_eq!(src_at(rig, ring), src, "boundary at ring {ring}");
    assert_eq!(src_at(rig, ring - 1), src - 1, "boundary at ring {ring}");
}

#[test]
fn cross_surah_play_switches_files_and_reuses_the_basmala_file() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let queue = plan(&req((112, 1), (114, 6)), &timings).unwrap();
    assert_eq!(queue.len(), 4 + 1 + 5 + 1 + 6 + 1);
    rig.load(queue.clone(), 0, None, DecodeParams::default())
        .unwrap();
    assert!(rig.run_to_end(60));
    let applied = rig.out.applied().to_vec();
    assert_applied_on_their_frames(&applied);
    let events = rig.events();
    assert_eq!(events.len(), queue.len() + 1);

    // At 100 % with equal rates each segment adds exactly its source frames, contiguous or drained.
    let mut ring = 0;
    for (i, (a, seg)) in events.iter().zip(&queue).enumerate() {
        let (s, e) = frames(seg, 48_000);
        assert_eq!(a.marker.kind, MarkerKind::Segment);
        assert_eq!(a.marker.seg_index, i as u32);
        assert_eq!(
            a.marker.ring_frame,
            ring,
            "segment {i} {:?}",
            (seg.surah, seg.ayah)
        );
        assert_eq!(a.marker.file_pos_us, frame_to_us(s, 48_000));
        let contiguous =
            i > 0 && queue[i - 1].file == seg.file && queue[i - 1].end_ms == seg.start_ms;
        if contiguous {
            assert_seamless(&rig, ring, s);
        } else {
            assert_entry(&rig, ring, s);
        }
        ring += e - s;
    }
    assert_eq!(events.last().unwrap().marker.kind, MarkerKind::End);
    assert_eq!(events.last().unwrap().marker.ring_frame, ring);

    // Files: surah 1 (basmala) opened once and parked for the second basmala; 112..114 asked for by prefetch.
    let needs: Vec<u16> = rig
        .messages
        .iter()
        .filter_map(|m| match m {
            CtlMsg::NeedSource(k) => Some(k.surah),
            _ => None,
        })
        .collect();
    assert_eq!(needs, [112, 113, 114], "{:?}", rig.messages);
    assert!(matches!(rig.messages.last(), Some(CtlMsg::QueueEnded)));
    assert!(rig.out.underruns() <= 1, "only the final drain-out");
}

#[test]
fn speed_and_resampling_place_markers_by_the_exact_mapping() {
    for pct in [50_u32, 75, 125, 150, 200] {
        let (timings, mut rig) = rig(44_100, 48_000);
        let queue = plan(&req((1, 1), (1, 7)), &timings).unwrap();
        let params = DecodeParams {
            speed_pct: pct,
            ..DecodeParams::default()
        };
        rig.load(queue.clone(), 0, None, params).unwrap();
        assert!(rig.run_to_end(60), "pct {pct}");
        let applied = rig.out.applied().to_vec();
        assert_applied_on_their_frames(&applied);
        let events = rig.events();
        assert_eq!(events.len(), 8);
        let origin = ms_to_frame(queue[0].start_ms, 44_100);
        let rate = MediaRate::new(pct, 48_000);
        for (a, seg) in events.iter().zip(&queue) {
            let s = ms_to_frame(seg.start_ms, 44_100);
            // ⌈(S − origin)·100·out / (pct·src)⌉, computed independently of the chain.
            let expected =
                (u128::from(s - origin) * 100 * 48_000).div_ceil(u128::from(pct) * 44_100) as u64;
            assert_eq!(a.marker.ring_frame, expected, "pct {pct} ayah {}", seg.ayah);
            assert_eq!(a.marker.rate, rate);
            // The position at the marker frame is the boundary's source position (within one output frame).
            let src_us = frame_to_us(s, 44_100);
            assert!(
                a.marker.file_pos_us + 1 >= src_us && a.marker.file_pos_us <= src_us + 43,
                "pct {pct}"
            );
        }
        // End: the whole stretched + resampled length, ⌈⌈L·100/pct⌉·48000/44100⌉.
        let len = ms_to_frame(queue[6].end_ms, 44_100) - origin;
        let stretched = (len * 100).div_ceil(u64::from(pct));
        let total = (u128::from(stretched) * 48_000).div_ceil(44_100) as u64;
        assert_eq!(events[7].marker.kind, MarkerKind::End);
        assert_eq!(events[7].marker.ring_frame, total, "pct {pct}");
    }
}

#[test]
fn sync_markers_every_100_ms_follow_the_rational_rate() {
    for (src_rate, pct) in [
        (48_000, 100),
        (44_100, 100),
        (44_100, 50),
        (44_100, 135),
        (48_000, 200),
    ] {
        let layout = Layout {
            ayah_ms: 9_000,
            ..Layout::default()
        };
        let timings = FixtureTimings::new(7).with_layout(layout);
        let sources = Arc::new(FixtureSources::new(layout, src_rate, 2));
        let mut rig = Rig::new(48_000, 2, 750).with_sources(sources);
        let queue = plan(&req((112, 1), (112, 4)), &timings).unwrap();
        let params = DecodeParams {
            speed_pct: pct,
            ..DecodeParams::default()
        };
        rig.load(queue.clone(), 0, None, params).unwrap();
        assert!(rig.run_to_end(120));
        let applied = rig.out.applied().to_vec();
        assert_applied_on_their_frames(&applied);
        let syncs = applied
            .iter()
            .filter(|a| a.marker.kind == MarkerKind::Sync)
            .count();
        let total_frames = applied.last().unwrap().marker.ring_frame;
        // ~one per 100 ms of output.
        let expected = total_frames as f64 / 4_800.0;
        assert!(
            (syncs as f64) > expected * 0.75 && (syncs as f64) < expected * 1.05,
            "{src_rate} Hz {pct} %: {syncs} syncs over {total_frames} frames"
        );
        // Each Sync refreshes the position: it agrees with the exact rational extrapolation from the segment's anchor
        // (its entry or seamless boundary marker) to within half a source frame, and lands ~100 ms after the previous
        // marker.
        let mut anchor = applied[0].marker;
        let mut last = applied[0].marker;
        let mut sync_gaps = Vec::new();
        for a in &applied[1..] {
            let m = a.marker;
            match m.kind {
                MarkerKind::Sync => {
                    let gap_ms = (m.ring_frame - last.ring_frame) as f64 / 48.0;
                    // Never closer than 100 ms; at most one resampler block plus one WSOLA hop later.
                    assert!(
                        (100.0..=150.0).contains(&gap_ms),
                        "{src_rate} Hz {pct} %: {gap_ms} ms between markers"
                    );
                    sync_gaps.push(gap_ms);
                    assert_eq!((m.seg_index, m.rate), (anchor.seg_index, anchor.rate));
                    // Half a source frame (p_k vs the linear mapping) plus the floors of both sides.
                    let tolerance = 500_000_u64.div_ceil(u64::from(src_rate)) + 2;
                    let exact = anchor.position_at(m.ring_frame);
                    assert!(
                        m.file_pos_us.abs_diff(exact) <= tolerance,
                        "{src_rate} Hz {pct} %: sync {} vs {exact}",
                        m.file_pos_us
                    );
                }
                MarkerKind::Segment => anchor = m,
                _ => {}
            }
            last = m;
        }
        let mean = sync_gaps.iter().sum::<f64>() / sync_gaps.len() as f64;
        assert!(
            mean < 125.0,
            "{src_rate} Hz {pct} %: mean Sync spacing {mean} ms"
        );
    }
}

#[test]
fn ayah_repeat_plays_each_ayah_n_times_with_counters() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let mut r = req((1, 2), (1, 4));
    r.ayah_repeat = 3;
    let queue = plan(&r, &timings).unwrap();
    let params = DecodeParams {
        ayah_repeat: 3,
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();
    // Sample the published counter right after every audible segment edge.
    let mut left_at_edges = Vec::new();
    let mut edges = 0;
    while !rig
        .out
        .applied()
        .iter()
        .any(|a| a.marker.kind == MarkerKind::End)
    {
        assert!(rig.step());
        assert!(rig.out.device_frames() < 48_000 * 60);
        let n = rig.events().len();
        if n != edges {
            edges = n;
            left_at_edges.push(rig.shared.ayah_repeat_left.load(Ordering::Relaxed));
        }
    }
    assert_eq!(left_at_edges[..9], [2, 1, 0, 2, 1, 0, 2, 1, 0]);
    let events = rig.events();
    let segs: Vec<u32> = events
        .iter()
        .filter(|a| a.marker.kind == MarkerKind::Segment)
        .map(|a| a.marker.seg_index)
        .collect();
    assert_eq!(segs, [0, 0, 0, 1, 1, 1, 2, 2, 2]);
    let mut ring = 0;
    for (a, &i) in events.iter().zip(&segs) {
        let (s, e) = frames(&queue[i as usize], 48_000);
        assert_eq!(a.marker.ring_frame, ring);
        assert_entry(&rig, ring, s);
        ring += e - s;
    }
    assert_eq!(events.last().unwrap().marker.ring_frame, ring);
    assert_applied_on_their_frames(rig.out.applied());
}

#[test]
fn range_repeat_replays_the_queue_including_its_basmala() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let mut r = req((113, 1), (113, 2));
    r.range_repeat = 3;
    let queue = plan(&r, &timings).unwrap();
    assert_eq!(queue[0].kind, SegmentKind::Basmala);
    let params = DecodeParams {
        range_repeat: 3,
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();
    let mut passes_seen = Vec::new();
    while !rig
        .out
        .applied()
        .iter()
        .any(|a| a.marker.kind == MarkerKind::End)
    {
        assert!(rig.step());
        let left = rig.shared.range_repeat_left.load(Ordering::Relaxed);
        if passes_seen.last() != Some(&left) {
            passes_seen.push(left);
        }
        assert!(rig.out.device_frames() < 48_000 * 60);
    }
    let segs: Vec<u32> = rig
        .events()
        .iter()
        .filter(|a| a.marker.kind == MarkerKind::Segment)
        .map(|a| a.marker.seg_index)
        .collect();
    assert_eq!(segs, [0, 1, 2, 0, 1, 2, 0, 1, 2]);
    assert_eq!(passes_seen, [2, 1, 0]);
    let mut ring = 0;
    for (a, &i) in rig.events().iter().zip(&segs) {
        assert_eq!(a.marker.ring_frame, ring);
        let (s, e) = frames(&queue[i as usize], 48_000);
        ring += e - s;
    }
    assert_applied_on_their_frames(rig.out.applied());
}

#[test]
fn fixed_gap_after_every_ayah_play_but_not_at_the_end() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let mut r = req((1, 1), (1, 3));
    r.gap = GapSetting::Fixed { ms: 500 };
    r.ayah_repeat = 2;
    let queue = plan(&r, &timings).unwrap();
    let params = DecodeParams {
        ayah_repeat: 2,
        gap: r.gap,
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();
    assert!(rig.run_to_end(60));
    let events = rig.events();
    let kinds: Vec<(MarkerKind, u32)> = events
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
            (Seg, 1),
            (Gap, 1),
            (Seg, 1),
            (Gap, 1),
            (Seg, 2),
            (Gap, 2),
            (Seg, 2),
            (End, 2),
        ]
    );
    let gap = silence_frames(500, 48_000);
    let mut ring = 0;
    for a in &events {
        assert_eq!(a.marker.ring_frame, ring, "{a:?}");
        let seg = &queue[a.marker.seg_index as usize];
        let (s, e) = frames(seg, 48_000);
        match a.marker.kind {
            Seg => ring += e - s,
            Gap => {
                // Position frozen at the end of the finished ayah; the gap is silence.
                assert_eq!(a.marker.rate, MediaRate::FROZEN);
                assert_eq!(a.marker.file_pos_us, frame_to_us(e, 48_000));
                for f in [ring, ring + gap / 2, ring + gap - 1] {
                    assert_eq!(rig.out.played_ring_frame(f).unwrap(), [0.0, 0.0]);
                }
                ring += gap;
            }
            _ => {}
        }
    }
}

#[test]
fn multiplier_gap_is_a_share_of_the_ayah() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let mut r = req((1, 4), (1, 5));
    r.gap = GapSetting::Multiplier { pct: 150 };
    let queue = plan(&r, &timings).unwrap();
    let params = DecodeParams {
        gap: r.gap,
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();
    assert!(rig.run_to_end(60));
    let events = rig.events();
    assert_eq!(events.len(), 4, "{events:#?}");
    let (s0, e0) = frames(&queue[0], 48_000);
    assert_eq!(events[1].marker.kind, MarkerKind::Gap);
    assert_eq!(events[1].marker.ring_frame, e0 - s0);
    let gap = silence_frames(queue[0].duration_ms() * 150 / 100, 48_000);
    assert_eq!(events[2].marker.ring_frame, e0 - s0 + gap);
    assert_eq!(events[2].marker.seg_index, 1);
    assert_eq!(events[3].marker.kind, MarkerKind::End);
}

#[test]
fn ab_loop_wraps_from_b_to_a_and_marks_segments_inside() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let queue = plan(&req((1, 1), (1, 7)), &timings).unwrap();
    // A in the middle of ayah 2, B in the middle of ayah 4.
    let a_ms = queue[1].start_ms + 300;
    let b_ms = queue[3].start_ms + 400;
    let params = DecodeParams {
        ab_loop: Some(AbLoop { a_ms, b_ms }),
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();
    // Four wraps (the first three are checked with the audio that follows them).
    let a_us = frame_to_us(ms_to_frame(a_ms, 48_000), 48_000);
    assert!(rig.run_until(48_000 * 30, |r| {
        r.events()
            .iter()
            .filter(|a| a.marker.file_pos_us == a_us)
            .count()
            >= 4
    }));
    let origin = ms_to_frame(queue[0].start_ms, 48_000);
    let (a, b) = (ms_to_frame(a_ms, 48_000), ms_to_frame(b_ms, 48_000));
    let s = |i: usize| ms_to_frame(queue[i].start_ms, 48_000);
    // Linear to B with seamless markers at ayahs 2, 3, 4; then wraps to A in ayah 2, marks 3 and 4 again.
    let expected_first: Vec<(u32, u64)> = vec![
        (0, 0),
        (1, s(1) - origin),
        (2, s(2) - origin),
        (3, s(3) - origin),
    ];
    let events = rig.events();
    let got: Vec<(u32, u64)> = events
        .iter()
        .map(|e| (e.marker.seg_index, e.marker.ring_frame))
        .collect();
    assert_eq!(got[..4], expected_first[..]);
    let mut ring = b - origin;
    for k in 0..3 {
        let w = &events[4 + 3 * k];
        assert_eq!(
            (w.marker.seg_index, w.marker.ring_frame),
            (1, ring),
            "wrap {k}"
        );
        assert_eq!(w.marker.file_pos_us, frame_to_us(a, 48_000));
        assert_entry(&rig, ring, a);
        // The frames just before the wrap are the end of the loop, faded out towards B.
        assert_eq!(src_at(&rig, ring - FADE_48K - 1), b - FADE_48K - 1);
        assert_eq!(events[5 + 3 * k].marker.ring_frame, ring + s(2) - a);
        assert_seamless(&rig, ring + s(2) - a, s(2));
        assert_eq!(events[6 + 3 * k].marker.ring_frame, ring + s(3) - a);
        ring += b - a;
    }
    // Clearing the loop lets the queue run to its end.
    rig.cmd(DecodeCmd::SetAbLoop(None));
    assert!(rig.run_to_end(60));
    let last = rig.events();
    assert_eq!(last.last().unwrap().marker.kind, MarkerKind::End);
    assert_eq!(last[last.len() - 2].marker.seg_index, 6);
    assert_applied_on_their_frames(rig.out.applied());
}

#[test]
fn infinite_repeat_keeps_going_and_zero_length_segments_do_not_spin() {
    let (timings, mut rig) = rig(48_000, 48_000);
    let mut r = req((1, 1), (1, 1));
    r.ayah_repeat = 0;
    let queue = plan(&r, &timings).unwrap();
    let params = DecodeParams {
        ayah_repeat: 0,
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();
    assert!(rig.run_until(48_000 * 20, |r| r.events().len() >= 12));
    assert!(
        rig.events()
            .iter()
            .all(|a| a.marker.kind == MarkerKind::Segment && a.marker.seg_index == 0)
    );
    assert_eq!(
        rig.shared.ayah_repeat_left.load(Ordering::Relaxed),
        0,
        "∞ reads as 0"
    );
    rig.cmd(DecodeCmd::Stop);
    assert!(rig.pump());
    assert_eq!(rig.decoder.state(), DecodeState::Idle);

    // A zero-length ayah with infinite repeat and infinite range repeat must still finish.
    let (_, mut rig) = self::rig(48_000, 48_000);
    let mut empty = queue[0].clone();
    empty.end_ms = empty.start_ms;
    let params = DecodeParams {
        ayah_repeat: 0,
        range_repeat: 0,
        ..DecodeParams::default()
    };
    rig.load(vec![empty], 0, None, params).unwrap();
    assert!(rig.run_to_end(5));
    let events = rig.events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].marker.ring_frame, 0);
}
