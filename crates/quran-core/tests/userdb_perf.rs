//! Bench-style budgets for the user.db calls on hot paths: what `app_bootstrap` reads (settings, first run,
//! positions), what the reader writes while paging (position, history) and the memorisation range calls. Budgets are
//! p99 over repeated runs on a populated database; debug builds (quran-core itself unoptimised) get 4× headroom.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::{Duration, Instant};

use quran_types::{
    HistoryInput, HistoryMode, MemoReviewInput, MemoStatus, MushafLayout, PositionContext,
    ReadingPosition, SearchScope,
};
use support::user::{TempUserDb, every_setting_changed, preset_input};

const RUNS: usize = 200;

fn budget(release_ms: u64) -> Duration {
    let factor = if cfg!(debug_assertions) { 4 } else { 1 };
    Duration::from_millis(release_ms * factor)
}

/// p99 of `RUNS` timed calls of `f(i)`.
fn p99(mut f: impl FnMut(usize)) -> Duration {
    let mut samples: Vec<Duration> = (0..RUNS)
        .map(|i| {
            let start = Instant::now();
            f(i);
            start.elapsed()
        })
        .collect();
    samples.sort();
    samples[RUNS * 99 / 100 - 1]
}

fn check(name: &str, took: Duration, release_ms: u64) {
    let limit = budget(release_ms);
    eprintln!("{name}: p99 {took:?} (budget {limit:?})");
    assert!(took <= limit, "{name}: p99 {took:?} exceeds {limit:?}");
}

/// A database the size of a long-time user's: every setting stored, 2,000 history entries, 200 searches, every ayah
/// with memorisation progress, 50 presets.
fn populated() -> TempUserDb {
    let t = TempUserDb::new();
    t.db.settings_save(&every_setting_changed()).unwrap();
    for page in 0..2_000_u32 {
        t.db.with(|c| {
            c.execute(
                "INSERT INTO history_entry (at, mode, mushaf_id, page, ayah_id, dwell_s) VALUES (?1, 'read', 1, ?2, 1, 30)",
                [i64::from(page), i64::from(page % 604 + 1)],
            )?;
            Ok(())
        })
        .unwrap();
    }
    for i in 0..200 {
        t.db.search_history_add(&format!("query {i}"), &SearchScope::Quran)
            .unwrap();
    }
    t.db.memo_set_status(1, 6236, MemoStatus::Learning).unwrap();
    for i in 0..50 {
        t.db.loop_preset_upsert(&preset_input(&format!("preset {i}")))
            .unwrap();
    }
    for context in [
        PositionContext::Mushaf,
        PositionContext::Translation,
        PositionContext::Audio,
    ] {
        t.db.position_set(&ReadingPosition {
            context,
            layout: Some(MushafLayout::V2),
            page: Some(1),
            ayah_id: 1,
            scroll_px: None,
            updated_at: 0,
        })
        .unwrap();
    }
    t
}

#[test]
fn bootstrap_reads_fit_the_budget() {
    let t = populated();
    check(
        "settings_load + first_run + positions",
        p99(|_| {
            t.db.settings_load().unwrap();
            t.db.first_run().unwrap();
            t.db.positions().unwrap();
        }),
        2,
    );
}

#[test]
fn paging_writes_fit_the_budget() {
    let t = populated();
    check(
        "position_set",
        p99(|i| {
            t.db.position_set(&ReadingPosition {
                context: PositionContext::Mushaf,
                layout: Some(MushafLayout::V2),
                page: Some(u32::try_from(i % 604).unwrap() + 1),
                ayah_id: 1,
                scroll_px: None,
                updated_at: 0,
            })
            .unwrap();
        }),
        2,
    );
    check(
        "history_record",
        p99(|i| {
            t.db.history_record(&HistoryInput {
                mode: HistoryMode::Read,
                layout: Some(MushafLayout::V2),
                page: Some(u32::try_from(i % 604).unwrap() + 1),
                ayah_id: 1,
                dwell_s: 5,
            })
            .unwrap();
        }),
        3,
    );
    check(
        "history_list(50)",
        p99(|_| {
            assert_eq!(t.db.history_list(50, None).unwrap().len(), 50);
        }),
        2,
    );
}

#[test]
fn memorisation_ranges_fit_the_budget() {
    let t = populated();
    // Al-Baqarah: 286 ayahs (8..=293).
    check(
        "memo_review(al-Baqarah)",
        p99(|_| {
            t.db.memo_review(&MemoReviewInput {
                from_ayah_id: 8,
                to_ayah_id: 293,
                rating: 3,
                mistakes: 0,
            })
            .unwrap();
        }),
        25,
    );
    check(
        "memo_progress(whole Quran)",
        p99(|_| {
            assert_eq!(t.db.memo_progress(1, 6236).unwrap().len(), 6236);
        }),
        25,
    );
}
