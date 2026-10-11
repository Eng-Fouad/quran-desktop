//! Study data through the public API (§2.2.6, §5.10): reading positions, history, search history, the memorisation
//! schedule and self-tests, and loop presets, including persistence across a restart.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use quran_core::CoreError;
use quran_core::user_db::{MemoSchedule, schedule_review};
use quran_types::{
    GapSetting, HistoryInput, HistoryMode, LoopPresetInput, MemoReviewInput, MemoStatus,
    MemoTestResult, MushafLayout, PositionContext, ReadingPosition, SearchScope,
};
use support::user::{DAY_MS, T0, TempUserDb, preset_input};

const T0_SECS: u32 = 1_760_000_000;

#[test]
fn positions_are_one_per_context_and_survive_a_restart() {
    let t = TempUserDb::at(T0);
    let mushaf = ReadingPosition {
        context: PositionContext::Mushaf,
        layout: Some(MushafLayout::V2),
        page: Some(604),
        ayah_id: 6236,
        scroll_px: None,
        updated_at: 0,
    };
    let audio = ReadingPosition {
        context: PositionContext::Audio,
        layout: None,
        page: None,
        ayah_id: 262,
        scroll_px: None,
        updated_at: 0,
    };
    t.db.position_set(&mushaf).unwrap();
    t.db.position_set(&audio).unwrap();
    t.db.position_set(&ReadingPosition {
        page: Some(50),
        ayah_id: 300,
        ..mushaf
    })
    .unwrap();
    let positions = t.reopen().positions().unwrap();
    assert_eq!(positions.len(), 2);
    assert_eq!(
        positions[0],
        ReadingPosition {
            page: Some(50),
            ayah_id: 300,
            updated_at: T0_SECS,
            ..mushaf
        }
    );
    assert_eq!(
        positions[1],
        ReadingPosition {
            updated_at: T0_SECS,
            ..audio
        }
    );
}

#[test]
fn history_dedupes_pages_and_pages_backwards() {
    let t = TempUserDb::at(T0);
    let read = |page: u32, dwell_s: u32| HistoryInput {
        mode: HistoryMode::Read,
        layout: Some(MushafLayout::V2),
        page: Some(page),
        ayah_id: page * 10,
        dwell_s,
    };
    // A reading session: 1 → 2 → 1 → 3, a minute apart; page 1 is merged.
    for (i, (page, dwell)) in [(1, 30), (2, 40), (1, 15), (3, 50)].into_iter().enumerate() {
        t.db.set_test_clock(Some(T0 + i64::try_from(i).unwrap() * 60_000));
        t.db.history_record(&read(page, dwell)).unwrap();
    }
    // The audio glue records listening on the same pages: a separate mode, so separate entries.
    t.db.history_record(&HistoryInput {
        mode: HistoryMode::Listen,
        ..read(3, 0)
    })
    .unwrap();
    let all = t.db.history_list(50, None).unwrap();
    assert_eq!(
        all.iter()
            .map(|e| (e.mode, e.page.unwrap(), e.dwell_s))
            .collect::<Vec<_>>(),
        [
            (HistoryMode::Listen, 3, 0),
            (HistoryMode::Read, 3, 50),
            (HistoryMode::Read, 1, 45),
            (HistoryMode::Read, 2, 40),
        ]
    );
    let page1 = t.db.history_list(2, None).unwrap();
    let page2 = t.db.history_list(2, Some(page1[1].id)).unwrap();
    assert_eq!(
        page1.iter().chain(&page2).map(|e| e.id).collect::<Vec<_>>(),
        all.iter().map(|e| e.id).collect::<Vec<_>>()
    );
    assert!(t.db.history_list(2, Some(page2[1].id)).unwrap().is_empty());
    t.db.history_clear().unwrap();
    assert!(t.reopen().history_list(50, None).unwrap().is_empty());
}

#[test]
fn search_history_keeps_scopes_apart_and_counts_uses() {
    let t = TempUserDb::at(T0);
    let saheeh = SearchScope::Translation {
        pack_id: "tr.en.saheeh".into(),
    };
    t.db.search_history_add("رحمة", &SearchScope::Quran)
        .unwrap();
    t.db.set_test_clock(Some(T0 + 1_000));
    t.db.search_history_add("mercy", &saheeh).unwrap();
    t.db.set_test_clock(Some(T0 + 2_000));
    t.db.search_history_add(" رحمة ", &SearchScope::Quran)
        .unwrap();
    let list = t.reopen().search_history_list(10).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(
        (
            list[0].query.as_str(),
            &list[0].scope,
            list[0].use_count,
            list[0].last_used_at
        ),
        ("رحمة", &SearchScope::Quran, 2, T0_SECS + 2)
    );
    assert_eq!((list[1].query.as_str(), &list[1].scope), ("mercy", &saheeh));
    t.db.search_history_clear().unwrap();
    assert!(t.db.search_history_list(10).unwrap().is_empty());
}

#[test]
fn memorising_a_surah_follows_the_schedule() {
    let t = TempUserDb::at(T0);
    // Al-Fatiha (1..=7): learn it over four "good" sessions, each on its due date.
    let mut now = T0;
    for expected_days in [1, 2, 4, 8] {
        t.db.set_test_clock(Some(now));
        let out =
            t.db.memo_review(&MemoReviewInput {
                from_ayah_id: 1,
                to_ayah_id: 7,
                rating: 3,
                mistakes: 0,
            })
            .unwrap();
        assert_eq!(out.len(), 7);
        let due = i64::from(out[0].due_at.unwrap()) * 1000;
        assert_eq!((due - now) / DAY_MS, expected_days);
        now = due;
    }
    t.db.set_test_clock(Some(now - 1));
    let progress = t.db.memo_progress(1, 7).unwrap();
    assert!(
        progress
            .iter()
            .all(|p| p.status == MemoStatus::Memorized && p.strength == 4 && p.reviews == 4)
    );
    // Past the due date the ayahs read as "review"; a lapse sends them back to learning.
    t.db.set_test_clock(Some(now + 1));
    assert!(
        t.db.memo_progress(1, 7)
            .unwrap()
            .iter()
            .all(|p| p.status == MemoStatus::Review)
    );
    let lapsed =
        t.db.memo_review(&MemoReviewInput {
            from_ayah_id: 3,
            to_ayah_id: 3,
            rating: 1,
            mistakes: 4,
        })
        .unwrap();
    assert_eq!(
        (lapsed[0].status, lapsed[0].strength, lapsed[0].lapses),
        (MemoStatus::Learning, 2, 1)
    );
    // The stored rows agree with the pure schedule.
    let mut s = MemoSchedule::NEW;
    let mut at = T0;
    for _ in 0..4 {
        s = schedule_review(s, 3, at).unwrap();
        at = s.due_at.unwrap();
    }
    assert_eq!(s.due_at, Some(now));
    // The whole Quran can be marked at once (e.g. a hafiz importing progress).
    assert_eq!(
        t.db.memo_set_status(1, 6236, MemoStatus::Memorized)
            .unwrap()
            .len(),
        6236
    );
    assert_eq!(
        t.db.memo_set_status(1, 6236, MemoStatus::New)
            .unwrap()
            .len(),
        6236
    );
    assert!(t.reopen().memo_progress(1, 6236).unwrap().is_empty());
}

#[test]
fn self_tests_are_recorded_once() {
    let t = TempUserDb::at(T0);
    let test = t.db.memo_test_start(8, 293, 100).unwrap();
    assert_eq!((test.started_at, test.finished_at), (T0_SECS, None));
    t.db.set_test_clock(Some(T0 + 300_000));
    let done =
        t.db.memo_test_finish(&MemoTestResult {
            id: test.id,
            reveals: 4,
            mistakes: 2,
            rating: 2,
        })
        .unwrap();
    assert_eq!(done.finished_at, Some(T0_SECS + 300));
    assert!(matches!(
        t.db.memo_test_finish(&MemoTestResult {
            id: test.id,
            reveals: 0,
            mistakes: 0,
            rating: 4
        }),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn presets_round_trip_and_validate() {
    let t = TempUserDb::at(T0);
    let kursi =
        t.db.loop_preset_upsert(&preset_input("Ayat al-Kursi"))
            .unwrap();
    let mulk =
        t.db.loop_preset_upsert(&LoopPresetInput {
            from_ayah_id: 5242,
            to_ayah_id: 5271,
            gap: GapSetting::None,
            speed_pct: 85,
            ..preset_input("al-Mulk")
        })
        .unwrap();
    assert_eq!(mulk.speed_pct, 85);
    let presets = t.reopen().loop_presets().unwrap();
    // Case-insensitive name order: "al-Mulk" before "Ayat al-Kursi".
    assert_eq!(presets, [mulk.clone(), kursi.clone()]);
    assert_eq!(presets[1].gap, GapSetting::Multiplier { pct: 100 });
    let renamed =
        t.db.loop_preset_upsert(&LoopPresetInput {
            id: Some(mulk.id),
            ..preset_input("Al-Mulk (evening)")
        })
        .unwrap();
    assert_eq!(renamed.id, mulk.id);
    t.db.loop_preset_delete(kursi.id).unwrap();
    assert_eq!(t.db.loop_presets().unwrap(), [renamed]);
    assert!(matches!(
        t.db.loop_preset_upsert(&LoopPresetInput {
            from_ayah_id: 0,
            ..preset_input("x")
        }),
        Err(CoreError::InvalidArgument(_))
    ));
}
