//! Search against a real core.db (§12.2): the G12 golden set, the "يا ايها" two-token words, filtered searches, the
//! sajda words with "space + ۩", typo fallback, suggestions and the §3.5 budgets. Ignored by default; run with
//! `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core --test 'search_*' -- --ignored`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::{Duration, Instant};

use quran_core::{Column, CoreDb, SearchEngine, build_match};
use quran_types::{MushafLayout, SearchHit, SearchMode, SearchRequest, SearchResults, SearchScope};

fn engine() -> (CoreDb, SearchEngine) {
    let core = CoreDb::open(&support::real_core_db()).unwrap();
    (core.clone(), SearchEngine::new(core))
}

fn request(query: &str, mode: SearchMode) -> SearchRequest {
    SearchRequest {
        query: query.into(),
        scope: SearchScope::Quran,
        mode,
        surah: None,
        juz: None,
        limit: 500,
        layout: MushafLayout::V2,
    }
}

fn hits(r: &SearchResults) -> Vec<&SearchHit> {
    r.groups.iter().flat_map(|g| &g.hits).collect()
}

fn refs(r: &SearchResults) -> Vec<(u32, u32)> {
    hits(r).iter().map(|h| (h.surah, h.ayah)).collect()
}

fn hit(r: &SearchResults, surah: u32, ayah: u32) -> &SearchHit {
    hits(r)
        .into_iter()
        .find(|h| (h.surah, h.ayah) == (surah, ayah))
        .unwrap_or_else(|| panic!("{}: no hit {surah}:{ayah} in {:?}", r.query, refs(r)))
}

/// The matched words' Hafs text.
fn matched_text(h: &SearchHit) -> Vec<&str> {
    h.matched_word_ids
        .iter()
        .map(|id| h.words[usize::try_from(id - h.first_word_id).unwrap()].as_str())
        .collect()
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn g12_golden_set() {
    let (core, engine) = engine();
    let conn = core.conn().unwrap();
    let rows: u32 = conn
        .query_row("SELECT count(*) FROM ayah_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 6236);
    let vocab: u32 = conn
        .query_row("SELECT count(*) FROM vocab_loose", [], |r| r.get(0))
        .unwrap();
    assert!(
        (14_000..=15_500).contains(&vocab),
        "vocab_loose has {vocab} terms"
    );

    let exact = |q: &str| engine.search_quran(&request(q, SearchMode::Exact)).unwrap();
    let smart = |q: &str| engine.search_quran(&request(q, SearchMode::Smart)).unwrap();
    let r = smart("الرحمن");
    for (s, a) in [(1, 1), (1, 3)] {
        assert!(refs(&r).contains(&(s, a)), "الرحمن ⊇ {s}:{a}");
    }
    assert!(refs(&smart("العالمين")).contains(&(1, 2)));
    assert!(refs(&smart("الصلاه")).contains(&(2, 3)));
    assert!(
        refs(&smart("الصَّلَاةِ")).contains(&(2, 3)),
        "a vocalised query folds the same way"
    );
    let prefix = smart("الرح");
    assert!(prefix.total >= 1);
    assert!(
        prefix.total >= smart("الرحمن").total,
        "a prefix finds at least the whole word"
    );
    assert!(refs(&exact("الصلاة")).contains(&(2, 3)));
    assert!(!refs(&exact("الصلاه")).contains(&(2, 3)), "strict keeps ة");

    // The words of a hit are the ayah's words, end marker last, and the matched ones are the query's.
    // 1:1 = بسم الله الرحمن الرحيم + end marker: the third word is الرحمن, the fourth الرحيم.
    let h = hit(&r, 1, 1);
    assert_eq!(h.words.len(), 5);
    assert!(h.words[4].starts_with('\u{06DD}'));
    assert_eq!(h.matched_word_ids, [h.first_word_id + 2]);
    assert_eq!(h.page, 1);
    let both = smart("الرحمن الرحيم");
    let h = hit(&both, 1, 1);
    assert_eq!(
        h.matched_word_ids,
        [h.first_word_id + 2, h.first_word_id + 3]
    );
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn ya_ayyuha_is_one_word_with_two_tokens() {
    let (_, engine) = engine();
    for query in ["يا ايها", "\"يا ايها\"", "يَا أَيُّهَا"] {
        let r = engine
            .search_quran(&request(query, SearchMode::Smart))
            .unwrap();
        // 2:21 "يَٰٓأَيُّهَا ٱلنَّاسُ ٱعۡبُدُواْ رَبَّكُمُ …": the vocative is ONE word in QPC.
        let h = hit(&r, 2, 21);
        assert_eq!(
            h.matched_word_ids.len(),
            1,
            "{query}: {:?}",
            matched_text(h)
        );
        assert_eq!(h.matched_word_ids[0], h.first_word_id);
        assert!(r.total > 100, "{query}: {} hits", r.total);
        for h in hits(&r) {
            assert!(
                !h.matched_word_ids.is_empty(),
                "{query}: {}:{} has a matched word",
                h.surah,
                h.ayah
            );
        }
    }
    let phrase = build_match("\"يا ايها\"", Column::Loose, true).unwrap();
    assert_eq!(phrase.fts, "loose : (\"يا ايها\")");
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn sajda_words_with_a_space_are_one_matched_word() {
    let (_, engine) = engine();
    for (query, surah, ayah) in [("واناب", 38, 24), ("تفلحون", 22, 77)] {
        let r = engine
            .search_quran(&request(query, SearchMode::Smart))
            .unwrap();
        let h = hit(&r, surah, ayah);
        let text = matched_text(h);
        assert!(
            text.iter().any(|t| t.contains(" \u{06E9}")),
            "{query}: the matched word keeps its space before ۩: {text:?}"
        );
        // words[] never splits a word: the ayah has exactly its word rows, one end marker, last.
        assert_eq!(
            h.words.iter().filter(|w| w.starts_with('\u{06DD}')).count(),
            1
        );
        assert!(h.words.last().unwrap().starts_with('\u{06DD}'));
    }
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn filters_and_truncation() {
    let (core, engine) = engine();
    let index = core.index().unwrap();
    let surah2 = &index.surahs[1];
    let juz30 = index.juz[29];
    let base = request("الله", SearchMode::Smart);
    let all = engine.search_quran(&base).unwrap();
    assert!(
        all.truncated && all.total > 1500,
        "الله* is everywhere: {}",
        all.total
    );
    assert_eq!(hits(&all).len(), 500);
    let mut sum = 0;
    for g in &all.groups {
        assert!(g.count as usize >= g.hits.len());
        sum += g.count;
    }
    assert!(sum <= all.total);

    let mut req = base.clone();
    req.surah = Some(2);
    let r = engine.search_quran(&req).unwrap();
    assert!(r.total > 0 && r.groups.iter().all(|g| g.surah == 2));
    assert!(hits(&r).iter().all(|h| {
        (surah2.first_ayah_id..surah2.first_ayah_id + surah2.ayah_count).contains(&h.ayah_id)
    }));
    assert_eq!(r.groups[0].count, r.total);

    let mut req = base.clone();
    req.juz = Some(30);
    let r = engine.search_quran(&req).unwrap();
    assert!(r.total > 0);
    assert!(
        hits(&r)
            .iter()
            .all(|h| (juz30.first_ayah_id..=juz30.last_ayah_id).contains(&h.ayah_id))
    );
    assert_eq!(r.groups.iter().map(|g| g.count).sum::<u32>(), r.total);

    let mut req = base.clone();
    req.surah = Some(112);
    req.juz = Some(30);
    let both = engine.search_quran(&req).unwrap();
    assert!(both.total > 0 && both.groups.iter().all(|g| g.surah == 112));

    req.surah = Some(1);
    let none = engine.search_quran(&req).unwrap();
    assert_eq!(none.total, 0, "al-Fatihah is not in juz 30");

    // Page numbers follow the layout: 2:255 is on page 42 of the 1421H mushaf.
    let mut req = request("الحي القيوم", SearchMode::Exact);
    for layout in [MushafLayout::V2, MushafLayout::V1, MushafLayout::V4] {
        req.layout = layout;
        let r = engine.search_quran(&req).unwrap();
        let h = hit(&r, 2, 255);
        assert_eq!(
            h.page,
            core.page_of_ayah(layout, h.ayah_id).unwrap(),
            "{layout:?}"
        );
    }
    req.layout = MushafLayout::V2;
    assert_eq!(hit(&engine.search_quran(&req).unwrap(), 2, 255).page, 42);
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn substring_typos_and_suggestions() {
    let (_, engine) = engine();
    let r = engine
        .search_quran(&request("رحمن الرح", SearchMode::Substring))
        .unwrap();
    let h = hit(&r, 1, 1);
    assert_eq!(
        h.matched_word_ids,
        [h.first_word_id + 2, h.first_word_id + 3],
        "a needle across two words marks both"
    );

    let r = engine
        .search_quran(&request("الرحمان", SearchMode::Smart))
        .unwrap();
    assert!(
        r.suggestions.iter().any(|s| s == "الرحمن"),
        "{:?}",
        r.suggestions
    );
    assert!(refs(&r).contains(&(1, 1)));
    let r = engine
        .search_quran(&request("الحمد لله العلمين", SearchMode::Smart))
        .unwrap();
    assert_eq!(r.suggestions.first().map(String::as_str), Some("العالمين"));
    assert!(refs(&r).contains(&(1, 2)));

    let s = engine.suggest("الرح", 10).unwrap();
    assert!(s.len() >= 2);
    assert!(s.iter().all(|t| t.term.starts_with("الرح")));
    assert!(
        s.windows(2).all(|w| w[0].count >= w[1].count),
        "most frequent first"
    );
    assert!(s.iter().any(|t| t.term == "الرحمن") && s.iter().any(|t| t.term == "الرحيم"));
}

const RUNS: usize = 60;

fn budget(release_ms: u64) -> Duration {
    // Debug builds run quran-core unoptimised (SQLite itself is optimised in every profile): 4× headroom.
    Duration::from_millis(release_ms * if cfg!(debug_assertions) { 4 } else { 1 })
}

fn p99(mut f: impl FnMut()) -> Duration {
    f(); // warm the caches (geometry, vocabulary, statement cache, page cache)
    let mut samples: Vec<Duration> = (0..RUNS)
        .map(|_| {
            let start = Instant::now();
            f();
            start.elapsed()
        })
        .collect();
    samples.sort();
    samples[(RUNS * 99).div_ceil(100) - 1]
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn budgets_of_section_3_5() {
    let (_, engine) = engine();
    // Smart, 1–3 tokens, up to 500 hits including word mapping: < 25 ms.
    for query in [
        "الله",
        "من",
        "الرحمن الرحيم",
        "قال يا قوم",
        "الذين امنوا",
        "ال",
        "يا ايها الذين",
    ] {
        let req = request(query, SearchMode::Smart);
        let mut total = 0;
        let took = p99(|| total = engine.search_quran(&req).unwrap().total);
        eprintln!("smart {query}: {total} hits, p99 {took:?}");
        assert!(took < budget(25), "smart {query}: p99 {took:?}");
    }
    // Typo fallback: < 60 ms.
    for query in [
        "الرحمان",
        "العلمين",
        "الحمد لله العلمين",
        "المستقيين",
        "يومنوت بالغيب",
    ] {
        let req = request(query, SearchMode::Smart);
        let mut used = Vec::new();
        let took = p99(|| used = engine.search_quran(&req).unwrap().suggestions);
        eprintln!("typo {query}: {used:?}, p99 {took:?}");
        assert!(!used.is_empty(), "{query} is corrected");
        assert!(took < budget(60), "typo {query}: p99 {took:?}");
    }
    // Substring scans and suggestions stay well inside the smart budget too.
    let req = request("رحم", SearchMode::Substring);
    let took = p99(|| {
        engine.search_quran(&req).unwrap();
    });
    eprintln!("substring رحم: p99 {took:?}");
    assert!(took < budget(25));
    let took = p99(|| {
        engine.suggest("ال", 10).unwrap();
    });
    eprintln!("suggest ال: p99 {took:?}");
    assert!(took < budget(5));
}
