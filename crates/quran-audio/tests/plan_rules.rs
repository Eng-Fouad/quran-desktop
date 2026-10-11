//! Planner rules through the public API (docs/ARCHITECTURE.md §2.3.3, §12.1): basmala for 2..=114 except 9 and none for
//! 1, `basmala_in_file`, the offline basmala skip with its flag, cross-surah ranges, continuous `end = next.from`,
//! repeat/gap ends, and invalid ranges.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use std::sync::Arc;

use quran_audio::fake_out::fixtures::{FixtureTimings, SURAH_AYAHS, ayah_count, ayah_id};
use quran_audio::{
    AudioError, AyahSpan, PlannedQueue, ReciterFlags, Segment, SegmentKind, SurahTimingSet,
    TimingsSource, plan, plan_queue,
};
use quran_types::{AyahRef, GapSetting, MushafLayout, PlayRequest, StopAt};

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

fn kinds(q: &[Segment]) -> Vec<(SegmentKind, u16, u16)> {
    q.iter().map(|s| (s.kind, s.surah, s.ayah)).collect()
}

#[test]
fn fixture_structure_is_the_real_quran() {
    assert_eq!(
        SURAH_AYAHS.iter().map(|&n| u32::from(n)).sum::<u32>(),
        6_236
    );
    assert_eq!(ayah_id(1, 1), 1);
    assert_eq!(ayah_id(2, 1), 8);
    assert_eq!(ayah_id(114, 6), 6_236);
    assert_eq!(ayah_count(9), 129);
}

#[test]
fn basmala_before_every_surah_but_1_and_9() {
    let src = FixtureTimings::new(7);
    let t1 = src.timings(1);
    for surah in 1..=114_u32 {
        let q = plan(&req((surah, 1), (surah, 1)), &src).unwrap();
        let expect_basmala = surah != 1 && surah != 9;
        assert_eq!(q.len(), 1 + usize::from(expect_basmala), "surah {surah}");
        if expect_basmala {
            let b = &q[0];
            assert_eq!(b.kind, SegmentKind::Basmala);
            assert_eq!((u32::from(b.surah), b.ayah, b.ayah_id), (surah, 0, 0));
            // Every QDC reciter: the surah-1 file's 1:1 range (FACT C8).
            assert_eq!(b.file, t1.file);
            assert_eq!(
                (b.start_ms, b.end_ms),
                (t1.ayahs[0].from_ms, t1.ayahs[0].to_ms)
            );
            assert_eq!(b.words.len(), t1.ayahs[0].words.len());
            assert_eq!(b.ayah_ref(), AyahRef { surah, ayah: 0 });
        }
        let a = q.last().unwrap();
        assert_eq!(
            (a.kind, u32::from(a.surah), a.ayah),
            (SegmentKind::Ayah, surah, 1)
        );
    }
}

#[test]
fn no_basmala_when_starting_mid_surah() {
    let src = FixtureTimings::new(7);
    let q = plan(&req((2, 255), (3, 2)), &src).unwrap();
    assert_eq!(
        kinds(&q),
        (255..=286)
            .map(|a| (SegmentKind::Ayah, 2, a))
            .chain([
                (SegmentKind::Basmala, 3, 0),
                (SegmentKind::Ayah, 3, 1),
                (SegmentKind::Ayah, 3, 2)
            ])
            .collect::<Vec<_>>()
    );
}

#[test]
fn cross_surah_range_is_in_mushaf_order_with_ids_and_files() {
    let src = FixtureTimings::new(7);
    let q = plan(&req((112, 3), (114, 2)), &src).unwrap();
    assert_eq!(
        kinds(&q),
        [
            (SegmentKind::Ayah, 112, 3),
            (SegmentKind::Ayah, 112, 4),
            (SegmentKind::Basmala, 113, 0),
            (SegmentKind::Ayah, 113, 1),
            (SegmentKind::Ayah, 113, 2),
            (SegmentKind::Ayah, 113, 3),
            (SegmentKind::Ayah, 113, 4),
            (SegmentKind::Ayah, 113, 5),
            (SegmentKind::Basmala, 114, 0),
            (SegmentKind::Ayah, 114, 1),
            (SegmentKind::Ayah, 114, 2),
        ]
    );
    for s in q.iter().filter(|s| s.kind == SegmentKind::Ayah) {
        assert_eq!(s.ayah_id, ayah_id(s.surah, s.ayah));
        assert_eq!(s.file, src.timings(s.surah).file);
        let span = &src.timings(s.surah).ayahs[usize::from(s.ayah) - 1];
        assert_eq!(s.start_ms, span.from_ms);
        assert_eq!(s.words.len(), span.words.len());
        assert!(
            s.words.windows(2).all(|w| w[0].1 <= w[1].1),
            "sorted by start"
        );
    }
    // Surah 1 timings were loaded once for both basmalas.
    assert_eq!(src.calls().iter().filter(|&&s| s == 1).count(), 1);
}

#[test]
fn continuous_mode_ends_at_the_next_ayah_inside_a_file_only() {
    let src = FixtureTimings::new(7);
    let q = plan(&req((112, 1), (113, 2)), &src).unwrap();
    let t112 = src.timings(112);
    let t113 = src.timings(113);
    // 112:1..3 end at the next ayah's start (the breath plays, boundaries are seamless).
    for a in 1..=3 {
        let seg = q.iter().find(|s| s.surah == 112 && s.ayah == a).unwrap();
        assert_eq!(seg.end_ms, t112.ayahs[usize::from(a)].from_ms);
    }
    // The last ayah of a file ends at its own `to`, and so does the last planned ayah.
    let last112 = q.iter().find(|s| s.surah == 112 && s.ayah == 4).unwrap();
    assert_eq!(last112.end_ms, t112.ayahs[3].to_ms);
    let last = q.last().unwrap();
    assert_eq!(
        (last.surah, last.ayah, last.end_ms),
        (113, 2, t113.ayahs[1].to_ms)
    );
    // So consecutive ayahs of one file are contiguous.
    for w in q.windows(2) {
        if w[0].kind == SegmentKind::Ayah
            && w[1].kind == SegmentKind::Ayah
            && w[0].file == w[1].file
        {
            assert_eq!(w[0].end_ms, w[1].start_ms);
        }
    }
}

#[test]
fn repeat_and_gap_modes_end_every_ayah_at_to_ms() {
    let src = FixtureTimings::new(7);
    let t = src.timings(1);
    for (ayah_repeat, gap) in [
        (2, GapSetting::None),
        (0, GapSetting::None),
        (1, GapSetting::Fixed { ms: 300 }),
        (1, GapSetting::Multiplier { pct: 100 }),
    ] {
        let mut r = req((1, 1), (1, 7));
        r.ayah_repeat = ayah_repeat;
        r.gap = gap;
        let q = plan(&r, &src).unwrap();
        for (s, span) in q.iter().zip(&t.ayahs) {
            assert_eq!(
                (s.start_ms, s.end_ms),
                (span.from_ms, span.to_ms),
                "{ayah_repeat} {gap:?}"
            );
        }
    }
    // Range repeat alone keeps continuous mode.
    let mut r = req((1, 1), (1, 7));
    r.range_repeat = 5;
    assert_eq!(plan(&r, &src).unwrap()[0].end_ms, t.ayahs[1].from_ms);
}

#[test]
fn basmala_in_file_is_the_lead_in_of_the_same_file() {
    let src = FixtureTimings::new(9).with_basmala_in_file(2_500);
    let mut r = req((113, 1), (114, 6));
    r.reciter_id = 9;
    let q = plan(&r, &src).unwrap();
    let b = q
        .iter()
        .filter(|s| s.kind == SegmentKind::Basmala)
        .collect::<Vec<_>>();
    assert_eq!(b.len(), 2);
    for basmala in b {
        let t = src.timings(basmala.surah);
        assert_eq!(basmala.file, t.file);
        assert_eq!((basmala.start_ms, basmala.end_ms), (0, 2_500));
        assert!(basmala.words.is_empty());
    }
    // Surah 1 timings are never needed.
    assert!(!src.calls().contains(&1));
}

#[test]
fn offline_basmala_is_skipped_not_the_play() {
    let src = FixtureTimings::new(7).with_offline(1);
    let q = plan_queue(&req((112, 1), (114, 6)), &src).unwrap();
    assert!(q.basmala_skipped);
    assert_eq!(q.segments.len(), 4 + 5 + 6);
    assert!(q.segments.iter().all(|s| s.kind == SegmentKind::Ayah));
    // Not offline: no flag.
    let src = FixtureTimings::new(7);
    assert!(
        !plan_queue(&req((112, 1), (114, 6)), &src)
            .unwrap()
            .basmala_skipped
    );
    // An uncached basmala *file* (found when control opens it) is dropped the same way.
    let mut q: PlannedQueue = plan_queue(&req((112, 1), (113, 5)), &src).unwrap();
    let s1 = src.timings(1).file;
    assert_eq!(q.skip_basmalas_in(&s1), 2);
    assert!(q.basmala_skipped);
    assert_eq!(q.segments.len(), 9);
}

#[test]
fn other_basmala_errors_fail_the_play() {
    let src = FixtureTimings::new(7).with_failing(1, AudioError::Timings("bad row".into()));
    assert_eq!(
        plan(&req((112, 1), (112, 4)), &src),
        Err(AudioError::Timings("bad row".into()))
    );
    // Starting mid-surah never asks for the basmala.
    assert!(plan(&req((112, 2), (112, 4)), &src).is_ok());
}

#[test]
fn offline_planned_surah_fails_the_play() {
    let src = FixtureTimings::new(7).with_offline(113);
    assert!(matches!(
        plan(&req((112, 1), (113, 1)), &src),
        Err(AudioError::Offline(_))
    ));
}

#[test]
fn invalid_ranges_are_rejected() {
    let src = FixtureTimings::new(7);
    for (from, to) in [
        ((1, 2), (1, 1)),
        ((2, 1), (1, 7)),
        ((0, 1), (1, 1)),
        ((1, 0), (1, 3)),
        ((1, 8), (1, 8)),
        ((114, 1), (114, 7)),
        ((115, 1), (115, 2)),
        ((70_000, 1), (70_000, 1)),
        ((1, 70_000), (1, 70_000)),
    ] {
        assert!(
            matches!(plan(&req(from, to), &src), Err(AudioError::Invalid(_))),
            "{from:?}..={to:?}"
        );
    }
}

#[test]
fn the_whole_quran_is_one_queue() {
    let src = FixtureTimings::new(7);
    let mut r = req((1, 1), (114, 6));
    r.stop_at = Some(StopAt::EndOfQuran);
    let q = plan(&r, &src).unwrap();
    let ayahs: Vec<u32> = q
        .iter()
        .filter(|s| s.kind == SegmentKind::Ayah)
        .map(|s| s.ayah_id)
        .collect();
    assert_eq!(ayahs, (1..=6_236).collect::<Vec<_>>());
    assert_eq!(
        q.iter().filter(|s| s.kind == SegmentKind::Basmala).count(),
        112
    );
    // `to` unresolved by the glue: EndOfQuran reaches 114:6.
    r.to = None;
    assert_eq!(plan(&r, &src).unwrap().len(), q.len());
}

/// A source with one surah whose ayah 2 has no timing, and one that answers for the wrong surah.
struct BrokenTimings;

impl TimingsSource for BrokenTimings {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        let src = FixtureTimings::new(reciter_id);
        let mut t = src.timings(surah);
        if surah == 112 {
            t.ayahs.retain(|a: &AyahSpan| a.ayah != 2);
        }
        if surah == 113 {
            t.surah = 114;
        }
        Ok(Arc::new(t))
    }

    fn reciter_flags(&self, _reciter_id: u32) -> ReciterFlags {
        ReciterFlags::default()
    }

    fn surah_ayah_count(&self, surah: u16) -> u16 {
        ayah_count(surah)
    }

    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        ayah_id(surah, ayah)
    }
}

#[test]
fn bad_timings_are_timing_errors() {
    assert!(matches!(
        plan(&req((112, 1), (112, 4)), &BrokenTimings),
        Err(AudioError::Timings(_))
    ));
    assert!(plan(&req((112, 3), (112, 4)), &BrokenTimings).is_ok());
    assert!(matches!(
        plan(&req((113, 2), (113, 3)), &BrokenTimings),
        Err(AudioError::Timings(_))
    ));
}
