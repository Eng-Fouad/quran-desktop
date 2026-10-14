//! `SearchEngine::search_notes` over a real user.db (`note_fts` kept by the user.db triggers) with the mini core.db's
//! geometry. Notes are written with plain SQL and `body_search` as the user.db schema defines it, so these tests do not
//! depend on the note editor's API.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use quran_core::{CoreDb, CoreError, Level, SearchEngine, UserDb, fold_latin, normalize_ar};
use quran_types::{MushafLayout, SearchHit, SearchMode, SearchRequest, SearchResults, SearchScope};
use rusqlite::params;
use support::mini_core::{self, MiniCore};
use support::user::TempUserDb;

struct Fixture {
    mini: MiniCore,
    engine: SearchEngine,
    user: TempUserDb,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let engine = SearchEngine::new(CoreDb::open(&mini.path).unwrap());
    Fixture {
        mini,
        engine,
        user: TempUserDb::new(),
        _dir: dir,
    }
}

/// Inserts a live note; returns its id.
fn note(db: &UserDb, id: &str, from: u32, to: u32, title: Option<&str>, body: &str) -> String {
    let search = fold_latin(&normalize_ar(
        &format!("{} {body}", title.unwrap_or_default()),
        Level::Loose,
    ));
    db.with(|c| {
        c.execute(
            "INSERT INTO note (id, from_ayah_id, to_ayah_id, title, body, body_search, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)",
            params![id, from, to, title, body, search],
        )?;
        Ok(())
    })
    .unwrap();
    id.to_owned()
}

fn delete(db: &UserDb, id: &str) {
    db.with(|c| {
        c.execute("UPDATE note SET deleted_at = 1 WHERE id = ?1", [id])?;
        Ok(())
    })
    .unwrap();
}

fn request(query: &str, mode: SearchMode) -> SearchRequest {
    SearchRequest {
        query: query.into(),
        scope: SearchScope::Notes,
        mode,
        surah: None,
        juz: None,
        limit: 500,
        layout: MushafLayout::V1,
    }
}

fn hits(r: &SearchResults) -> Vec<&SearchHit> {
    r.groups.iter().flat_map(|g| &g.hits).collect()
}

fn ids(r: &SearchResults) -> Vec<&str> {
    hits(r)
        .iter()
        .map(|h| h.note_id.as_deref().unwrap())
        .collect()
}

fn seed(f: &Fixture) {
    let db = &f.user.db;
    note(
        db,
        "n-fatiha",
        1,
        7,
        Some("Al-Fatihah"),
        "**Mercy** is mentioned twice: _the Most Merciful_.",
    );
    note(
        db,
        "n-salah",
        10,
        12,
        None,
        "> On الصَّلَاةَ\n- establish it\n- [x] reflect on [prayer](https://example.org)",
    );
    note(
        db,
        "n-light",
        21,
        23,
        Some("Light"),
        "Nothing else in the body.",
    );
    note(
        db,
        "n-span",
        5,
        9,
        None,
        "Café notes on mercy across two surahs.",
    );
    note(db, "n-gone", 2, 2, None, "Deleted mercy note.");
    delete(db, "n-gone");
}

#[test]
fn notes_match_folded_text_in_mushaf_order() {
    let f = fixture();
    seed(&f);
    let r = f
        .engine
        .search_notes(&f.user.db, &request("merc", SearchMode::Smart))
        .unwrap();
    // Smart mode: prefix on the last token (Mercy and Merciful); the deleted note never shows; order by first ayah.
    assert_eq!(ids(&r), ["n-fatiha", "n-span"]);
    assert_eq!(r.total, 2);
    assert_eq!(r.normalized, "merc");
    let h = hits(&r);
    assert_eq!(
        h[0].snippet.as_deref(),
        Some("<mark>Mercy</mark> is mentioned twice: the Most <mark>Merciful</mark>.")
    );
    assert_eq!(
        h[1].snippet.as_deref(),
        Some("Café notes on <mark>mercy</mark> across two surahs.")
    );
    for hit in &h {
        let a = f.mini.ayah_by_id(hit.ayah_id);
        assert_eq!(
            (hit.surah, hit.ayah, hit.first_word_id),
            (a.surah, a.ayah, a.first_word_id)
        );
        assert_eq!(
            hit.page,
            f.mini.page_of_word(2, a.first_word_id),
            "layout v1"
        );
        assert!(hit.words.is_empty() && hit.matched_word_ids.is_empty());
    }
    // Exact mode: whole tokens only.
    let r = f
        .engine
        .search_notes(&f.user.db, &request("mercy", SearchMode::Exact))
        .unwrap();
    assert_eq!(ids(&r), ["n-fatiha", "n-span"]);
    assert_eq!(
        hits(&r)[0].snippet.as_deref(),
        Some("<mark>Mercy</mark> is mentioned twice: the Most Merciful.")
    );
    let r = f
        .engine
        .search_notes(&f.user.db, &request("merc", SearchMode::Exact))
        .unwrap();
    assert_eq!(r.total, 0);
}

#[test]
fn arabic_and_latin_are_folded_like_body_search() {
    let f = fixture();
    seed(&f);
    // Loose Arabic: ة→ه and harakat; the mark lands on the vocalised word; Markdown is reduced to text.
    let r = f
        .engine
        .search_notes(&f.user.db, &request("الصلاة", SearchMode::Smart))
        .unwrap();
    assert_eq!(ids(&r), ["n-salah"]);
    assert_eq!(
        hits(&r)[0].snippet.as_deref(),
        Some("On <mark>الصَّلَاةَ</mark> establish it reflect on prayer")
    );
    // Latin diacritics and case.
    let r = f
        .engine
        .search_notes(&f.user.db, &request("CAFE", SearchMode::Exact))
        .unwrap();
    assert_eq!(ids(&r), ["n-span"]);
    assert_eq!(
        hits(&r)[0].snippet.as_deref(),
        Some("<mark>Café</mark> notes on mercy across two surahs.")
    );
    // A link's text is searchable, its target is not shown.
    let r = f
        .engine
        .search_notes(&f.user.db, &request("prayer", SearchMode::Smart))
        .unwrap();
    assert_eq!(ids(&r), ["n-salah"]);
}

#[test]
fn a_title_only_match_snips_the_title() {
    let f = fixture();
    seed(&f);
    let r = f
        .engine
        .search_notes(&f.user.db, &request("light", SearchMode::Smart))
        .unwrap();
    assert_eq!(ids(&r), ["n-light"]);
    assert_eq!(hits(&r)[0].snippet.as_deref(), Some("<mark>Light</mark>"));
}

#[test]
fn substring_mode_scans_body_search() {
    let f = fixture();
    seed(&f);
    let r = f
        .engine
        .search_notes(&f.user.db, &request("ercif", SearchMode::Substring))
        .unwrap();
    assert_eq!(ids(&r), ["n-fatiha"]);
    assert_eq!(
        hits(&r)[0].snippet.as_deref(),
        Some("Mercy is mentioned twice: the Most M<mark>ercif</mark>ul.")
    );
    let r = f
        .engine
        .search_notes(&f.user.db, &request("%", SearchMode::Substring))
        .unwrap();
    assert_eq!(r.total, 0, "wildcards are literal");
}

#[test]
fn filters_take_notes_that_overlap_the_range() {
    let f = fixture();
    seed(&f);
    // n-span covers 5..=9 (1:5–2:2): with a surah 2 filter it is a hit at 2:1, the first of its ayahs in range.
    let mut req = request("mercy", SearchMode::Smart);
    req.surah = Some(2);
    let r = f.engine.search_notes(&f.user.db, &req).unwrap();
    assert_eq!(ids(&r), ["n-span"]);
    let h = hits(&r)[0];
    assert_eq!((h.ayah_id, h.surah, h.ayah), (8, 2, 1));
    assert_eq!(r.groups[0].surah, 2);
    // Without the filter it is grouped under its first ayah, 1:5.
    let r = f
        .engine
        .search_notes(&f.user.db, &request("mercy", SearchMode::Smart))
        .unwrap();
    assert_eq!(r.groups.len(), 1);
    assert_eq!(r.groups[0].count, 2);
    // A juz that no note overlaps.
    let mut req = request("mercy", SearchMode::Smart);
    req.juz = Some(2);
    assert_eq!(f.engine.search_notes(&f.user.db, &req).unwrap().total, 0);
}

#[test]
fn truncation_keeps_full_group_counts() {
    let f = fixture();
    for i in 0..12u32 {
        let from = 1 + i * 3;
        note(
            &f.user.db,
            &format!("n{i:02}"),
            from,
            from,
            None,
            &format!("note {i} about patience"),
        );
    }
    let surah_of = |i: u32| f.mini.ayah_by_id(1 + i * 3).surah;
    let full =
        |surah: u32| u32::try_from((0..12).filter(|&i| surah_of(i) == surah).count()).unwrap();
    for limit in [1, 2, 3, 5, 11, 12] {
        let mut req = request("patience", SearchMode::Smart);
        req.limit = limit;
        let r = f.engine.search_notes(&f.user.db, &req).unwrap();
        assert_eq!(r.total, 12);
        assert_eq!(r.truncated, limit < 12);
        assert_eq!(hits(&r).len(), limit as usize);
        for g in &r.groups {
            assert_eq!(g.count, full(g.surah), "limit {limit}, surah {}", g.surah);
        }
    }
}

#[test]
fn empty_queries_and_contract_checks() {
    let f = fixture();
    seed(&f);
    for q in ["", " ", "\"\"", "*", "؟"] {
        for mode in [SearchMode::Smart, SearchMode::Exact, SearchMode::Substring] {
            let r = f
                .engine
                .search_notes(&f.user.db, &request(q, mode))
                .unwrap();
            assert_eq!(r.total, 0, "{q:?} {mode:?}");
        }
    }
    for q in [
        "AND",
        "OR mercy",
        "NEAR(mercy)",
        "body_search:mercy",
        "mercy*",
        "-mercy",
        "\"mercy",
    ] {
        f.engine
            .search_notes(&f.user.db, &request(q, SearchMode::Smart))
            .unwrap_or_else(|e| panic!("{q}: {e}"));
    }
    let mut wrong = request("mercy", SearchMode::Smart);
    wrong.scope = SearchScope::Quran;
    assert!(matches!(
        f.engine.search_notes(&f.user.db, &wrong),
        Err(CoreError::InvalidArgument(_))
    ));
    // An empty library answers an empty result.
    let empty = TempUserDb::new();
    let r = f
        .engine
        .search_notes(&empty.db, &request("mercy", SearchMode::Smart))
        .unwrap();
    assert_eq!((r.total, r.groups.len()), (0, 0));
}
