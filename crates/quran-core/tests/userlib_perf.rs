//! Bench-style budgets for the library calls on hot paths (§3.5): `user_marks` (< 3 ms, called for every visible page
//! set) and the edits and lists the panels make, on a library far larger than a real one. Budgets are p99 over repeated
//! runs; debug builds (quran-core itself unoptimised) get 4× headroom.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::{Duration, Instant};

use quran_core::UserDb;
use quran_types::{
    AYAH_COUNT, BookmarkFilter, HighlightColor, HighlightInput, MushafLayout, NoteFilter,
};
use rusqlite::params;
use support::user::{T0, TempUserDb};

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

const COLORS: [&str; 5] = ["yellow", "green", "blue", "red", "purple"];

/// A heavy library, written directly in one transaction: an ayah bookmark on every second ayah (3,118), a page
/// bookmark on every page of every layout (1,812), a two-ayah highlight every three ayahs (2,078, non-overlapping),
/// 3,000 notes, 40 collections and 60 tags with ~6,000 links, plus tombstoned rows of each kind.
fn populated() -> TempUserDb {
    let t = TempUserDb::at(T0);
    t.db.with_tx(|tx| {
        let mut bookmark = tx.prepare(
            "INSERT INTO bookmark (id, kind, ayah_id, mushaf_id, page, label, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
        )?;
        for a in (1..=AYAH_COUNT).step_by(2) {
            let deleted = (a % 10 == 1).then_some(T0);
            bookmark.execute(params![format!("ba{a}"), "ayah", a, None::<u32>, None::<u32>, Some(format!("label {a}")), T0 + i64::from(a), deleted])?;
        }
        for layout in MushafLayout::ALL {
            for p in 1..=604_u32 {
                let a = (p * 10).min(AYAH_COUNT);
                bookmark.execute(params![format!("bp{}-{p}", layout.db_id()), "page", a, layout.db_id(), p, None::<String>, T0, None::<i64>])?;
            }
        }
        let mut highlight = tx.prepare(
            "INSERT INTO highlight (id, from_ayah_id, to_ayah_id, color, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        )?;
        for (i, a) in (1..AYAH_COUNT).step_by(3).enumerate() {
            highlight.execute(params![format!("h{a}"), a, a + 1, COLORS[i % 5], T0, None::<i64>])?;
            // A tombstone under every tenth one.
            if i % 10 == 0 {
                highlight.execute(params![format!("hd{a}"), a, a + 1, "red", T0, Some(T0)])?;
            }
        }
        let mut note = tx.prepare(
            "INSERT INTO note (id, from_ayah_id, to_ayah_id, title, body, body_search, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?4, ?5, ?5, ?6)",
        )?;
        for i in 0..3_000_u32 {
            let from = 1 + (i * 37) % AYAH_COUNT;
            let to = (from + i % 12).min(AYAH_COUNT);
            let deleted = (i % 15 == 0).then_some(T0);
            note.execute(params![format!("n{i}"), from, to, format!("note body {i}"), T0 + i64::from(i), deleted])?;
        }
        for c in 0..40_u32 {
            tx.execute(
                "INSERT INTO collection (id, name, sort_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                params![format!("c{c}"), format!("Collection {c}"), c, T0],
            )?;
        }
        for g in 0..60_u32 {
            tx.execute(
                "INSERT INTO tag (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![format!("t{g}"), format!("tag {g}"), T0],
            )?;
        }
        let mut member = tx.prepare(
            "INSERT INTO collection_item (collection_id, bookmark_id, sort_key, added_at) VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut link = tx.prepare("INSERT INTO item_tag (tag_id, item_kind, item_id) VALUES (?1, ?2, ?3)")?;
        for (i, a) in (1..=AYAH_COUNT).step_by(2).enumerate() {
            let i = u32::try_from(i).unwrap();
            member.execute(params![format!("c{}", i % 40), format!("ba{a}"), i, T0])?;
            link.execute(params![format!("t{}", i % 60), "bookmark", format!("ba{a}")])?;
        }
        for i in 0..3_000_u32 {
            link.execute(params![format!("t{}", i % 60), "note", format!("n{i}")])?;
        }
        tx.execute(
            "INSERT INTO reading_bookmark (id, ayah_id, mushaf_id, page, updated_at) VALUES (1, 262, 1, 42, ?1)",
            [T0],
        )?;
        Ok(())
    })
    .unwrap();
    // No ANALYZE: the planner must pick the partial indexes without statistics (a fresh user.db has none).
    t
}

#[test]
fn user_marks_fits_the_budget() {
    let t = populated();
    let db: &UserDb = &t.db;
    // A two-page spread (about 15 ayahs) walked across the whole Quran, every layout.
    let m = db.marks(MushafLayout::V2, 255, 270, &[42, 43]).unwrap();
    assert!(!m.bookmarks.is_empty() && !m.highlights.is_empty() && !m.notes.is_empty());
    assert_eq!((m.page_bookmarks.len(), m.reading_ayah_id), (2, Some(262)));
    check(
        "marks(spread)",
        p99(|i| {
            let first = 1 + u32::try_from(i * 31).unwrap() % (AYAH_COUNT - 20);
            let page = 1 + u32::try_from(i).unwrap() % 603;
            let layout = MushafLayout::ALL[i % 3];
            db.marks(layout, first, first + 15, &[page, page + 1])
                .unwrap();
        }),
        3,
    );
    // A long surah on one call (al-Baqarah, ayah ids 8..=293) stays within budget too.
    check(
        "marks(al-Baqarah)",
        p99(|_| {
            db.marks(MushafLayout::V2, 8, 293, &[2, 3]).unwrap();
        }),
        3,
    );
}

#[test]
fn panel_lists_fit_the_budget() {
    let t = populated();
    let db = &t.db;
    let all = BookmarkFilter {
        kind: None,
        collection_id: None,
        tag_id: None,
        surah: None,
        limit: 200,
    };
    assert_eq!(db.bookmarks_list(&all).unwrap().len(), 200);
    check(
        "bookmarks_list(200)",
        p99(|_| drop(db.bookmarks_list(&all).unwrap())),
        10,
    );
    let in_collection = BookmarkFilter {
        collection_id: Some("c7".into()),
        ..all.clone()
    };
    check(
        "bookmarks_list(collection)",
        p99(|_| drop(db.bookmarks_list(&in_collection).unwrap())),
        10,
    );
    let notes = NoteFilter {
        from_ayah_id: Some(262),
        to_ayah_id: Some(262),
        tag_id: None,
        limit: 50,
    };
    check(
        "notes_list(ayah)",
        p99(|_| drop(db.notes_list(&notes).unwrap())),
        5,
    );
    check(
        "highlights_list(red)",
        p99(|_| drop(db.highlights_list(Some(HighlightColor::Red)).unwrap())),
        15,
    );
    check("tags_list", p99(|_| drop(db.tags_list().unwrap())), 15);
    check(
        "collections_list",
        p99(|_| drop(db.collections_list().unwrap())),
        10,
    );
}

#[test]
fn edits_fit_the_budget() {
    let t = populated();
    let db = &t.db;
    check(
        "highlight_set(split/merge)",
        p99(|i| {
            let from = 1 + u32::try_from(i * 29).unwrap() % (AYAH_COUNT - 10);
            db.highlight_set(&HighlightInput {
                from_ayah_id: from,
                to_ayah_id: from + 4,
                color: [HighlightColor::Yellow, HighlightColor::Blue][i % 2],
            })
            .unwrap();
        }),
        5,
    );
    check(
        "bookmark_toggle_ayah",
        p99(|i| {
            db.bookmark_toggle_ayah(1 + u32::try_from(i * 13).unwrap() % AYAH_COUNT)
                .unwrap();
        }),
        3,
    );
    check(
        "highlight_clear_range",
        p99(|i| {
            let from = 1 + u32::try_from(i * 17).unwrap() % (AYAH_COUNT - 10);
            db.highlight_clear_range(from, from + 6).unwrap();
        }),
        5,
    );
}
