//! `ContentDb`: timings, WBW, tafsir, kv, revalidation input, pack removal, "Clear cache" and corruption recovery.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};

use quran_core::content_db::geometry::surah_word_ids;
use quran_core::{
    ChapterStamp, ClearReport, ContentDb, CoreError, StaleItem, StaleKind, StoredTimings,
    TafsirRow, TimedAyah, TimingFile, WordSeg,
};
use quran_types::WbwEntry;
use rusqlite::Connection;

const DAY_MS: i64 = 86_400_000;
const NOW: i64 = 1_760_000_000_000;

fn open(dir: &tempfile::TempDir) -> ContentDb {
    ContentDb::open(&dir.path().join("content.db")).unwrap()
}

fn timings(reciter: u32, surah: u32, ayahs: u32, fetched_at_ms: i64) -> StoredTimings {
    StoredTimings {
        file: TimingFile {
            reciter_id: reciter,
            surah,
            audio_url: format!(
                "https://download.quranicaudio.com/qdc/r{reciter}/murattal/{surah}.mp3"
            ),
            content_length: Some(100_000 + u64::from(surah)),
            duration_ms: Some(ayahs * 1000),
            source: "qdc".into(),
            fetched_at_ms,
            etag: None,
            payload_sha256: format!("sha-{reciter}-{surah}"),
        },
        ayahs: (1..=ayahs)
            .map(|a| TimedAyah {
                ayah: a,
                from_ms: (a - 1) * 1000,
                to_ms: a * 1000,
                words: vec![
                    WordSeg {
                        pos: 1,
                        start_ms: (a - 1) * 1000,
                        end_ms: (a - 1) * 1000 + 500,
                    },
                    WordSeg {
                        pos: 2,
                        start_ms: (a - 1) * 1000 + 500,
                        end_ms: a * 1000,
                    },
                ],
            })
            .collect(),
        word_level: true,
    }
}

fn stamp(surah: u32, fetched_at_ms: i64, pinned: bool) -> ChapterStamp {
    ChapterStamp {
        surah,
        fetched_at_ms,
        sha256: format!("chapter-{surah}"),
        pinned,
    }
}

fn wbw(word_id: u32, gloss: &str) -> WbwEntry {
    WbwEntry {
        word_id,
        text: "ignored on write".into(),
        translation: Some(gloss.into()),
        transliteration: Some(format!("t{word_id}")),
    }
}

/// WBW rows for every non-end word of a surah (end markers are the last word of each ayah; here every 4th word).
fn wbw_chapter(surah: u32) -> Vec<WbwEntry> {
    surah_word_ids(surah)
        .unwrap()
        .filter(|id| id % 4 != 0)
        .map(|id| wbw(id, &format!("w{id}")))
        .collect()
}

fn tafsir(from: u32, to: u32) -> TafsirRow {
    TafsirRow {
        from_ayah_id: from,
        to_ayah_id: to,
        html: format!("<p>On {from}–{to}</p>"),
    }
}

#[test]
fn a_fresh_database_is_created_and_reopened() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data").join("content.db");
    let (db, quarantined) = ContentDb::open_or_recover(&path).unwrap();
    assert_eq!(quarantined, None);
    db.kv_put("k", "[1]", 5).unwrap();
    drop(db);
    let (db, quarantined) = ContentDb::open_or_recover(&path).unwrap();
    assert_eq!(quarantined, None);
    assert_eq!(db.kv_get("k").unwrap(), Some(("[1]".to_owned(), 5)));
}

#[test]
fn timings_round_trip_and_replace() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    assert_eq!(db.timings_get(7, 112).unwrap(), None);
    let t = timings(7, 112, 4, NOW);
    db.timings_put(&t, false).unwrap();
    assert_eq!(db.timings_get(7, 112).unwrap(), Some(t.clone()));
    assert_eq!(db.timings_get(7, 113).unwrap(), None);
    assert_eq!(db.timings_get(8, 112).unwrap(), None);

    // A refetch with fewer ayah rows and no word level replaces everything.
    let mut t2 = timings(7, 112, 2, NOW + 1);
    t2.word_level = false;
    t2.file.content_length = None;
    t2.file.etag = Some("\"v2\"".into());
    for a in &mut t2.ayahs {
        a.words.clear();
    }
    db.timings_put(&t2, false).unwrap();
    assert_eq!(db.timings_get(7, 112).unwrap(), Some(t2));
}

#[test]
fn timings_pins_only_go_up_on_put() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let t = timings(7, 1, 7, NOW);
    db.timings_put(&t, true).unwrap();
    // A revalidation refetch (pinned = false) keeps the pin.
    db.timings_put(&t, false).unwrap();
    let pinned = |db: &ContentDb| db.timing_stamps(Some(7)).unwrap()[0].pinned;
    assert!(pinned(&db));
    db.timings_set_pinned(7, 1, false).unwrap();
    assert!(!pinned(&db));
    db.timings_set_pinned(7, 1, true).unwrap();
    assert!(pinned(&db));
    // Pinning timings that do not exist is an error; unpinning them is a no-op.
    assert!(matches!(
        db.timings_set_pinned(7, 2, true),
        Err(CoreError::NotFound(_))
    ));
    db.timings_set_pinned(7, 2, false).unwrap();
    db.timings_delete(7, 1).unwrap();
    db.timings_delete(7, 1).unwrap();
    assert_eq!(db.timings_get(7, 1).unwrap(), None);
    let ayah_rows: i64 = Connection::open(dir.path().join("content.db"))
        .unwrap()
        .query_row("SELECT count(*) FROM timing_ayah", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ayah_rows, 0);
}

#[test]
fn timing_stamps_list_files_without_ayahs() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.timings_put(&timings(7, 2, 3, NOW), false).unwrap();
    db.timings_put(&timings(7, 1, 7, NOW - DAY_MS), true)
        .unwrap();
    db.timings_put(&timings(3, 114, 6, NOW), false).unwrap();
    let all = db.timing_stamps(None).unwrap();
    assert_eq!(
        all.iter()
            .map(|s| (s.reciter_id, s.surah))
            .collect::<Vec<_>>(),
        [(3, 114), (7, 1), (7, 2)]
    );
    let s = &db.timing_stamps(Some(7)).unwrap()[0];
    assert_eq!(
        (s.surah, s.pinned, s.word_level, s.fetched_at_ms),
        (1, true, true, NOW - DAY_MS)
    );
    assert_eq!(s.content_length, Some(100_001));
    assert_eq!(s.source, "qdc");
    assert!(s.audio_url.ends_with("/1.mp3"));
    assert!(db.timing_stamps(Some(99)).unwrap().is_empty());
}

#[test]
fn timings_put_validates_its_input() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let bad = |f: &dyn Fn(&mut StoredTimings)| {
        let mut t = timings(7, 112, 4, NOW);
        f(&mut t);
        assert!(matches!(
            db.timings_put(&t, false),
            Err(CoreError::InvalidArgument(_))
        ));
    };
    bad(&|t| t.file.surah = 0);
    bad(&|t| t.file.surah = 115);
    bad(&|t| t.ayahs[1].ayah = 1);
    bad(&|t| t.ayahs.swap(0, 1));
    bad(&|t| t.ayahs[3].ayah = 5);
    bad(&|t| t.ayahs[0].ayah = 0);
    bad(&|t| t.ayahs[2].to_ms = t.ayahs[2].from_ms - 1);
    bad(&|t| t.file.content_length = Some(u64::MAX));
    assert_eq!(db.timings_get(7, 112).unwrap(), None, "nothing was written");
}

#[test]
fn wbw_chapters_replace_by_word_range() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let fatiha = wbw_chapter(1);
    db.wbw_put_chapter("wbw.en", 1, &fatiha, &stamp(1, NOW, false))
        .unwrap();
    db.wbw_put_chapter("wbw.en", 2, &wbw_chapter(2), &stamp(2, NOW, false))
        .unwrap();
    db.wbw_put_chapter("wbw.ur", 1, &[wbw(1, "نام")], &stamp(1, NOW, false))
        .unwrap();

    let got = db.wbw_range("wbw.en", 1, 36).unwrap();
    assert_eq!(got.len(), fatiha.len());
    assert_eq!(
        got[0],
        WbwEntry {
            word_id: 1,
            text: String::new(),
            translation: Some("w1".into()),
            transliteration: Some("t1".into())
        }
    );
    assert!(got.windows(2).all(|w| w[0].word_id < w[1].word_id));
    // A range across two chapters, and an empty or reversed range.
    assert_eq!(
        db.wbw_range("wbw.en", 30, 40)
            .unwrap()
            .iter()
            .map(|e| e.word_id)
            .collect::<Vec<_>>(),
        [30, 31, 33, 34, 35, 37, 38, 39]
    );
    assert!(db.wbw_range("wbw.en", 40, 30).unwrap().is_empty());
    assert_eq!(db.wbw_range("wbw.ur", 1, 83_665).unwrap().len(), 1);

    // A refetch with fewer rows replaces the whole chapter, and only that chapter.
    db.wbw_put_chapter("wbw.en", 1, &[wbw(2, "new")], &stamp(1, NOW + 5, false))
        .unwrap();
    assert_eq!(db.wbw_range("wbw.en", 1, 36).unwrap().len(), 1);
    assert_eq!(
        db.wbw_range("wbw.en", 1, 36).unwrap()[0]
            .translation
            .as_deref(),
        Some("new")
    );
    assert_eq!(
        db.wbw_range("wbw.en", 37, 6438).unwrap().len(),
        wbw_chapter(2).len()
    );
    assert_eq!(db.chapters("wbw.en").unwrap()[0], stamp(1, NOW + 5, false));

    // Null glosses are stored as such.
    db.wbw_put_chapter(
        "wbw.en",
        114,
        &[WbwEntry {
            word_id: 83_640,
            text: String::new(),
            translation: None,
            transliteration: None,
        }],
        &stamp(114, NOW, false),
    )
    .unwrap();
    let last = &db.wbw_range("wbw.en", 83_640, 83_640).unwrap()[0];
    assert_eq!(
        (last.translation.as_deref(), last.transliteration.as_deref()),
        (None, None)
    );
}

#[test]
fn wbw_writes_are_checked_and_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.wbw_put_chapter("wbw.en", 1, &wbw_chapter(1), &stamp(1, NOW, false))
        .unwrap();
    let before = db.wbw_range("wbw.en", 1, 83_665).unwrap();
    let err = |r: quran_core::Result<()>| {
        assert!(matches!(r, Err(CoreError::InvalidArgument(_))), "{r:?}")
    };
    err(db.wbw_put_chapter(
        "wbw.en",
        1,
        &[wbw(37, "surah 2's word")],
        &stamp(1, NOW, false),
    ));
    err(db.wbw_put_chapter(
        "wbw.en",
        1,
        &[wbw(3, "a"), wbw(3, "b")],
        &stamp(1, NOW + 1, false),
    ));
    err(db.wbw_put_chapter("wbw.en", 1, &[], &stamp(2, NOW, false)));
    err(db.wbw_put_chapter("wbw.en", 0, &[], &stamp(0, NOW, false)));
    err(db.wbw_put_chapter("", 1, &[], &stamp(1, NOW, false)));
    assert_eq!(
        db.wbw_range("wbw.en", 1, 83_665).unwrap(),
        before,
        "a failed put changes nothing"
    );
    assert_eq!(db.chapters("wbw.en").unwrap(), [stamp(1, NOW, false)]);
}

#[test]
fn tafsir_ranges_and_lookups() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let rows = [
        tafsir(8, 8),
        tafsir(9, 12),
        tafsir(14, 20),
        tafsir(293, 293),
    ];
    db.tafsir_put_chapter("tafsir.en.ibn_kathir", 2, &rows, &stamp(2, NOW, false))
        .unwrap();
    let range = |a| {
        db.tafsir_get("tafsir.en.ibn_kathir", a)
            .unwrap()
            .map(|r| (r.from_ayah_id, r.to_ayah_id))
    };
    assert_eq!(range(7), None, "before the chapter");
    assert_eq!(range(8), Some((8, 8)));
    assert_eq!(range(9), Some((9, 12)));
    assert_eq!(range(12), Some((9, 12)));
    assert_eq!(range(13), None, "a gap");
    assert_eq!(range(20), Some((14, 20)));
    assert_eq!(range(292), None);
    assert_eq!(range(293), Some((293, 293)));
    assert_eq!(range(294), None);
    assert_eq!(
        db.tafsir_get("tafsir.en.ibn_kathir", 9).unwrap().unwrap(),
        tafsir(9, 12)
    );
    assert_eq!(db.tafsir_get("tafsir.ar.saadi", 9).unwrap(), None);

    // Replacement is per chapter.
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        1,
        &[tafsir(1, 7)],
        &stamp(1, NOW, true),
    )
    .unwrap();
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        2,
        &[tafsir(8, 293)],
        &stamp(2, NOW + 1, false),
    )
    .unwrap();
    assert_eq!(range(13), Some((8, 293)));
    assert_eq!(range(3), Some((1, 7)));
    assert_eq!(
        db.chapters("tafsir.en.ibn_kathir").unwrap(),
        [stamp(1, NOW, true), stamp(2, NOW + 1, false)]
    );
}

#[test]
fn tafsir_writes_are_checked() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let err = |rows: &[TafsirRow]| {
        let r = db.tafsir_put_chapter("tafsir.en.x", 2, rows, &stamp(2, NOW, false));
        assert!(matches!(r, Err(CoreError::InvalidArgument(_))), "{rows:?}");
    };
    err(&[tafsir(7, 8)]); // starts in surah 1
    err(&[tafsir(293, 294)]); // ends in surah 3
    err(&[tafsir(10, 9)]);
    err(&[tafsir(8, 10), tafsir(10, 12)]);
    err(&[tafsir(12, 14), tafsir(8, 12)]);
    err(&[tafsir(8, 8), tafsir(8, 8)]);
    // Unsorted, disjoint rows are fine.
    db.tafsir_put_chapter(
        "tafsir.en.x",
        2,
        &[tafsir(20, 30), tafsir(8, 19)],
        &stamp(2, NOW, false),
    )
    .unwrap();
    assert_eq!(
        db.tafsir_get("tafsir.en.x", 25).unwrap(),
        Some(tafsir(20, 30))
    );
    // A chapter without entries is still a fetched chapter.
    db.tafsir_put_chapter("tafsir.en.x", 3, &[], &stamp(3, NOW, false))
        .unwrap();
    assert_eq!(db.chapters("tafsir.en.x").unwrap().len(), 2);
}

#[test]
fn chapter_pins_and_pack_ids() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.wbw_put_chapter("wbw.en", 1, &wbw_chapter(1), &stamp(1, NOW, false))
        .unwrap();
    db.wbw_put_chapter("wbw.en", 112, &wbw_chapter(112), &stamp(112, NOW, false))
        .unwrap();
    db.tafsir_put_chapter("tafsir.ar.saadi", 1, &[tafsir(1, 7)], &stamp(1, NOW, false))
        .unwrap();
    assert_eq!(
        db.chapter_pack_ids().unwrap(),
        ["tafsir.ar.saadi", "wbw.en"]
    );

    db.chapters_set_pinned("wbw.en", true).unwrap();
    assert!(db.chapters("wbw.en").unwrap().iter().all(|c| c.pinned));
    assert!(!db.chapters("tafsir.ar.saadi").unwrap()[0].pinned);
    // A refetch of a pinned chapter keeps the pin; unpinning is explicit.
    db.wbw_put_chapter("wbw.en", 1, &wbw_chapter(1), &stamp(1, NOW + 1, false))
        .unwrap();
    assert!(db.chapters("wbw.en").unwrap()[0].pinned);
    db.chapters_set_pinned("wbw.en", false).unwrap();
    assert!(db.chapters("wbw.en").unwrap().iter().all(|c| !c.pinned));
    assert!(db.chapters("wbw.xx").unwrap().is_empty());
    db.chapters_set_pinned("wbw.xx", true).unwrap();
}

#[test]
fn stale_items_are_listed_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.timings_put(&timings(7, 2, 3, NOW - 10 * DAY_MS), false)
        .unwrap();
    db.timings_put(&timings(7, 1, 7, NOW - DAY_MS), true)
        .unwrap();
    db.wbw_put_chapter("wbw.en", 18, &[], &stamp(18, NOW - 8 * DAY_MS, true))
        .unwrap();
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        36,
        &[],
        &stamp(36, NOW - 30 * DAY_MS, false),
    )
    .unwrap();
    db.tafsir_put_chapter("tafsir.en.ibn_kathir", 67, &[], &stamp(67, NOW, false))
        .unwrap();
    // A chapter of a pack id that is neither wbw.* nor tafsir.* is skipped (and logged).
    db.tafsir_put_chapter("odd.pack", 1, &[], &stamp(1, 0, false))
        .unwrap();

    let stale = db.stale(NOW - 7 * DAY_MS).unwrap();
    assert_eq!(
        stale,
        [
            StaleItem {
                kind: StaleKind::Tafsir,
                pack_id: "tafsir.en.ibn_kathir".into(),
                surah: 36,
                reciter_id: None
            },
            StaleItem {
                kind: StaleKind::Timings,
                pack_id: "audio.qdc.7".into(),
                surah: 2,
                reciter_id: Some(7)
            },
            StaleItem {
                kind: StaleKind::Wbw,
                pack_id: "wbw.en".into(),
                surah: 18,
                reciter_id: None
            },
        ]
    );
    assert_eq!(db.stale(NOW + 1).unwrap().len(), 5);
    assert!(db.stale(i64::MIN).unwrap().is_empty());
}

#[test]
fn delete_pack_removes_pinned_content_of_that_pack_only() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.wbw_put_chapter("wbw.en", 1, &wbw_chapter(1), &stamp(1, NOW, true))
        .unwrap();
    db.wbw_put_chapter("wbw.ur", 1, &wbw_chapter(1), &stamp(1, NOW, true))
        .unwrap();
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        1,
        &[tafsir(1, 7)],
        &stamp(1, NOW, true),
    )
    .unwrap();
    db.timings_put(&timings(7, 1, 7, NOW), true).unwrap();
    db.timings_put(&timings(7, 2, 3, NOW), false).unwrap();
    db.timings_put(&timings(5, 1, 7, NOW), true).unwrap();

    db.delete_pack("wbw.en").unwrap();
    assert!(db.wbw_range("wbw.en", 1, 83_665).unwrap().is_empty());
    assert!(db.chapters("wbw.en").unwrap().is_empty());
    assert_eq!(
        db.wbw_range("wbw.ur", 1, 83_665).unwrap().len(),
        wbw_chapter(1).len()
    );

    db.delete_pack("tafsir.en.ibn_kathir").unwrap();
    assert_eq!(db.tafsir_get("tafsir.en.ibn_kathir", 3).unwrap(), None);

    db.delete_pack("audio.qdc.7").unwrap();
    assert_eq!(db.timings_get(7, 1).unwrap(), None);
    assert_eq!(db.timings_get(7, 2).unwrap(), None);
    assert!(
        db.timings_get(5, 1).unwrap().is_some(),
        "another reciter is untouched"
    );
    db.delete_pack("audio.qdc.7").unwrap();
    db.delete_pack("tr.en.saheeh").unwrap();
}

#[test]
fn delete_chapter_removes_one_chapter_and_keeps_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    for surah in [1, 2, 3] {
        db.wbw_put_chapter(
            "wbw.en",
            surah,
            &wbw_chapter(surah),
            &stamp(surah, NOW + i64::from(surah), surah == 2),
        )
        .unwrap();
    }
    db.wbw_put_chapter("wbw.ur", 2, &wbw_chapter(2), &stamp(2, NOW, false))
        .unwrap();
    // 2:1–5 and 2:6–7 are ayah ids 8..=12 and 13..=14; 1:1–7 is 1..=7.
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        2,
        &[tafsir(8, 12), tafsir(13, 14)],
        &stamp(2, NOW, true),
    )
    .unwrap();
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        1,
        &[tafsir(1, 7)],
        &stamp(1, NOW, false),
    )
    .unwrap();

    assert!(
        db.delete_chapter("wbw.en", 2).unwrap(),
        "a pinned chapter is deleted too"
    );
    let words = surah_word_ids(2).unwrap();
    assert!(
        db.wbw_range("wbw.en", *words.start(), *words.end())
            .unwrap()
            .is_empty()
    );
    let kept: Vec<ChapterStamp> = db.chapters("wbw.en").unwrap();
    assert_eq!(
        kept,
        [stamp(1, NOW + 1, false), stamp(3, NOW + 3, false)],
        "the other chapters keep their rows' stamps exactly"
    );
    for surah in [1, 3] {
        let words = surah_word_ids(surah).unwrap();
        assert_eq!(
            db.wbw_range("wbw.en", *words.start(), *words.end())
                .unwrap()
                .len(),
            wbw_chapter(surah).len()
        );
    }
    assert_eq!(
        db.wbw_range("wbw.ur", *words.start(), *words.end())
            .unwrap()
            .len(),
        wbw_chapter(2).len(),
        "another pack's chapter is untouched"
    );
    assert!(
        !db.delete_chapter("wbw.en", 2).unwrap(),
        "deleting it again is a no-op"
    );

    assert!(db.delete_chapter("tafsir.en.ibn_kathir", 2).unwrap());
    assert_eq!(db.tafsir_get("tafsir.en.ibn_kathir", 10).unwrap(), None);
    assert_eq!(db.tafsir_get("tafsir.en.ibn_kathir", 14).unwrap(), None);
    assert_eq!(
        db.tafsir_get("tafsir.en.ibn_kathir", 3).unwrap(),
        Some(tafsir(1, 7))
    );
    assert_eq!(
        db.chapters("tafsir.en.ibn_kathir").unwrap(),
        [stamp(1, NOW, false)]
    );

    assert!(matches!(
        db.delete_chapter("wbw.en", 115),
        Err(CoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        db.delete_chapter("wbw.en", 0),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn kv_is_a_small_json_cache() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    assert_eq!(db.kv_get("qdc.reciters").unwrap(), None);
    db.kv_put("qdc.reciters", r#"{"reciters":[7]}"#, NOW)
        .unwrap();
    db.kv_put("qdc.reciters", r#"{"reciters":[7,9]}"#, NOW + 1)
        .unwrap();
    assert_eq!(
        db.kv_get("qdc.reciters").unwrap(),
        Some((r#"{"reciters":[7,9]}"#.to_owned(), NOW + 1))
    );
    assert!(matches!(
        db.kv_put("x", "{not json", NOW),
        Err(CoreError::Json(_))
    ));
    assert!(matches!(
        db.kv_put("", "1", NOW),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn clear_unpinned_keeps_pinned_content() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    // Pinned: surah 1 timings (basmala source of a pinned download) and an installed wbw pack.
    db.timings_put(&timings(7, 1, 7, NOW), true).unwrap();
    db.wbw_put_chapter("wbw.en", 1, &wbw_chapter(1), &stamp(1, NOW, true))
        .unwrap();
    // Stream-only and on-demand content.
    db.timings_put(&timings(7, 2, 3, NOW), false).unwrap();
    db.timings_put(&timings(9, 114, 6, NOW), false).unwrap();
    db.wbw_put_chapter("wbw.en", 2, &wbw_chapter(2), &stamp(2, NOW, false))
        .unwrap();
    db.wbw_put_chapter("wbw.ur", 1, &wbw_chapter(1), &stamp(1, NOW, false))
        .unwrap();
    db.tafsir_put_chapter(
        "tafsir.en.ibn_kathir",
        2,
        &[tafsir(8, 10), tafsir(11, 293)],
        &stamp(2, NOW, false),
    )
    .unwrap();
    db.kv_put("a", "1", NOW).unwrap();
    db.kv_put("b", "[2]", NOW).unwrap();

    let report = db.clear_unpinned().unwrap();
    assert_eq!(report.timings, [(7, 2), (9, 114)]);
    assert_eq!(
        report.chapters,
        [
            ("tafsir.en.ibn_kathir".to_owned(), 2),
            ("wbw.en".to_owned(), 2),
            ("wbw.ur".to_owned(), 1)
        ]
    );
    assert!(report.bytes > 50_000, "{} bytes", report.bytes);

    // What stayed.
    assert!(db.timings_get(7, 1).unwrap().is_some());
    assert_eq!(
        db.wbw_range("wbw.en", 1, 36).unwrap().len(),
        wbw_chapter(1).len()
    );
    assert_eq!(db.chapters("wbw.en").unwrap(), [stamp(1, NOW, true)]);
    // What went.
    assert_eq!(db.timings_get(7, 2).unwrap(), None);
    assert_eq!(db.timings_get(9, 114).unwrap(), None);
    assert!(db.wbw_range("wbw.en", 37, 83_665).unwrap().is_empty());
    assert!(db.wbw_range("wbw.ur", 1, 83_665).unwrap().is_empty());
    assert_eq!(db.tafsir_get("tafsir.en.ibn_kathir", 100).unwrap(), None);
    assert_eq!(db.kv_get("a").unwrap(), None);
    assert!(db.chapters("wbw.ur").unwrap().is_empty());

    // Nothing left to clear.
    assert_eq!(db.clear_unpinned().unwrap(), ClearReport::default());
}

#[test]
fn clear_reports_exact_payload_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    db.kv_put("abc", "[1,2]", NOW).unwrap(); // 3 + 5 + 8
    let mut t = timings(7, 112, 1, NOW);
    t.ayahs[0].words.truncate(1); // one packed word: 10 bytes
    db.timings_put(&t, false).unwrap();
    let file_bytes = t.file.audio_url.len() + "qdc".len() + t.file.payload_sha256.len() + 7 * 8;
    let ayah_bytes = 10 + 5 * 8;
    db.tafsir_put_chapter(
        "tafsir.x",
        1,
        &[TafsirRow {
            from_ayah_id: 1,
            to_ayah_id: 7,
            html: "ab".into(),
        }],
        &stamp(1, NOW, false),
    )
    .unwrap();
    let tafsir_bytes = "tafsir.x".len() + 2 + 16;
    let chapter_bytes = "tafsir.x".len() + "chapter-1".len() + 3 * 8;
    let report = db.clear_unpinned().unwrap();
    assert_eq!(
        report.bytes,
        u64::try_from(16 + file_bytes + ayah_bytes + tafsir_bytes + chapter_bytes).unwrap()
    );
}

#[test]
fn clear_shrinks_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("content.db");
    let db = ContentDb::open(&path).unwrap();
    for s in 2..=40 {
        db.wbw_put_chapter("wbw.en", s, &wbw_chapter(s), &stamp(s, NOW, false))
            .unwrap();
    }
    let size = |p: &Path| {
        let mut wal = p.as_os_str().to_owned();
        wal.push("-wal");
        std::fs::metadata(p).unwrap().len()
            + std::fs::metadata(PathBuf::from(wal)).map_or(0, |m| m.len())
    };
    let before = size(&path);
    db.clear_unpinned().unwrap();
    let after = size(&path);
    assert!(after * 4 < before, "{before} → {after} bytes");
}

#[test]
fn handles_are_shared_across_threads() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(&dir);
    let threads: Vec<_> = (0..8u32)
        .map(|i| {
            let db = db.clone();
            std::thread::spawn(move || {
                for s in 1..=10u32 {
                    let surah = i * 10 + s;
                    db.timings_put(&timings(i, surah, 3, NOW), s % 2 == 0)
                        .unwrap();
                    assert_eq!(db.timings_get(i, surah).unwrap().unwrap().ayahs.len(), 3);
                    db.kv_put(&format!("k{i}"), "1", NOW).unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(db.timing_stamps(None).unwrap().len(), 80);
    assert_eq!(db.clear_unpinned().unwrap().timings.len(), 40);
}

// Recovery --------------------------------------------------------------------------------------------------------

fn sibling_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn assert_recovered(path: &Path, original: &[u8]) {
    let (db, quarantined) = ContentDb::open_or_recover(path).unwrap();
    let q = quarantined.expect("quarantined");
    let name = q.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("content.db.corrupt-"), "{name}");
    assert_eq!(
        std::fs::read(&q).unwrap(),
        original,
        "the quarantined file is the original"
    );
    // The fresh database works.
    db.kv_put("k", "true", 1).unwrap();
    assert!(db.chapters("wbw.en").unwrap().is_empty());
}

#[test]
fn a_file_that_is_not_a_database_is_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("content.db");
    let junk = vec![0x5a_u8; 8192];
    std::fs::write(&path, &junk).unwrap();
    // Junk sidecars must never be replayed into the fresh database.
    std::fs::write(dir.path().join("content.db-wal"), b"wal").unwrap();
    std::fs::write(dir.path().join("content.db-shm"), b"shm").unwrap();
    assert_recovered(&path, &junk);
    let names = sibling_names(dir.path());
    assert!(
        names.iter().any(|n| n.starts_with("content.db.corrupt-")),
        "{names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|n| n == "content.db-wal" || n == "content.db-shm"),
        "{names:?}"
    );
    let (db, quarantined) = ContentDb::open_or_recover(&path).unwrap();
    assert_eq!(quarantined, None, "the fresh database is healthy");
    assert_eq!(db.kv_get("k").unwrap(), Some(("true".to_owned(), 1)));
}

#[test]
fn a_damaged_database_is_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("content.db");
    {
        let db = ContentDb::open(&path).unwrap();
        for s in 1..=20 {
            db.wbw_put_chapter("wbw.en", s, &wbw_chapter(s), &stamp(s, NOW, true))
                .unwrap();
        }
    }
    // Checkpoint the WAL into the file, then overwrite pages in the middle of the B-trees.
    Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    assert!(bytes.len() > 64 * 1024);
    let mid = bytes.len() / 2;
    for b in &mut bytes[mid - 8192..mid + 8192] {
        *b = 0xA5;
    }
    std::fs::write(&path, &bytes).unwrap();
    assert_recovered(&path, &bytes);
}

#[test]
fn a_newer_schema_is_refused_and_left_in_place() {
    // A downgrade: content.db was last opened by a build with more migrations. Its pinned timings and chapters are
    // intact, so it is neither quarantined nor touched; updating the app opens it again.
    let dir = tempfile::tempdir().unwrap();
    let newer = dir.path().join("content.db");
    {
        let db = ContentDb::open(&newer).unwrap();
        db.timings_put(&timings(7, 1, 7, NOW), true).unwrap();
    }
    Connection::open(&newer)
        .unwrap()
        .execute_batch("PRAGMA user_version = 99")
        .unwrap();
    let original = std::fs::read(&newer).unwrap();
    for err in [
        ContentDb::open_or_recover(&newer).map(|_| ()).unwrap_err(),
        ContentDb::open(&newer).map(|_| ()).unwrap_err(),
    ] {
        assert!(
            matches!(
                err,
                CoreError::NewerSchema {
                    found: 99,
                    supported: 1
                }
            ),
            "{err}"
        );
    }
    // (The listing is checked for quarantined copies only: Windows may briefly show a transient `*.tmp` while SQLite
    // removes the -shm of the closed connection.)
    let names = sibling_names(dir.path());
    assert!(
        !names.iter().any(|n| n.contains(".corrupt-")),
        "no quarantine: {names:?}"
    );
    assert_eq!(
        std::fs::read(&newer).unwrap(),
        original,
        "not a byte changed"
    );
}

#[test]
fn a_foreign_schema_is_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    // A database whose tables collide with migration 1.
    let foreign = dir.path().join("b").join("content.db");
    std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
    Connection::open(&foreign)
        .unwrap()
        .execute_batch("CREATE TABLE kv (x)")
        .unwrap();
    let (db, q) = ContentDb::open_or_recover(&foreign).unwrap();
    assert!(q.is_some());
    db.kv_put("k", "1", 1).unwrap();
}

#[test]
fn environmental_failures_are_errors_not_quarantines() {
    let dir = tempfile::tempdir().unwrap();
    // The "file" is a directory: SQLite cannot open it, and renaming it would not help.
    let path = dir.path().join("content.db");
    std::fs::create_dir_all(&path).unwrap();
    assert!(ContentDb::open_or_recover(&path).is_err());
    assert_eq!(sibling_names(dir.path()), ["content.db"]);
}
