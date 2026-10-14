//! `SearchEngine::search_quran` and `suggest` on the mini synthetic core.db. Expectations come from the
//! mini core's own model (its ayah and word texts), never from the code under test: an independent oracle evaluates
//! each query over the model's normalised texts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::BTreeMap;

use quran_core::core_db::UNAVAILABLE_MESSAGE;
use quran_core::search::{MAX_LIMIT, MAX_SUGGEST_LIMIT};
use quran_core::{CoreDb, CoreError, SearchEngine};
use quran_types::{MushafLayout, SearchHit, SearchMode, SearchRequest, SearchResults, SearchScope};
use support::mini_core::{self, MiniCore};

struct Fixture {
    mini: MiniCore,
    engine: SearchEngine,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let engine = SearchEngine::new(CoreDb::open(&mini.path).unwrap());
    Fixture {
        mini,
        engine,
        _dir: dir,
    }
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

fn smart(query: &str) -> SearchRequest {
    request(query, SearchMode::Smart)
}

fn hits(r: &SearchResults) -> Vec<&SearchHit> {
    r.groups.iter().flat_map(|g| &g.hits).collect()
}

fn hit_ids(r: &SearchResults) -> Vec<u32> {
    hits(r).iter().map(|h| h.ayah_id).collect()
}

/// One query term for the oracle: tokens, and whether the last token is a prefix.
struct OracleTerm {
    tokens: Vec<&'static str>,
    prefix: bool,
}

fn word(t: &'static str) -> OracleTerm {
    OracleTerm {
        tokens: vec![t],
        prefix: false,
    }
}

fn prefix(t: &'static str) -> OracleTerm {
    OracleTerm {
        tokens: vec![t],
        prefix: true,
    }
}

fn phrase(tokens: &[&'static str]) -> OracleTerm {
    OracleTerm {
        tokens: tokens.to_vec(),
        prefix: false,
    }
}

/// Whether `ayah_tokens` contain the term (a phrase as consecutive tokens; the last one may be a prefix).
fn contains(ayah_tokens: &[&str], term: &OracleTerm) -> bool {
    let n = term.tokens.len();
    ayah_tokens.windows(n).any(|w| {
        w.iter()
            .zip(&term.tokens)
            .enumerate()
            .all(|(i, (have, want))| {
                if term.prefix && i + 1 == n {
                    have.starts_with(want)
                } else {
                    have == want
                }
            })
    })
}

/// The ayah ids (within `from..=to`) whose loose (or strict) text has every term.
fn oracle(mini: &MiniCore, terms: &[OracleTerm], strict: bool, (from, to): (u32, u32)) -> Vec<u32> {
    mini.ayahs
        .iter()
        .filter(|a| (from..=to).contains(&a.id))
        .filter(|a| {
            let text = if strict {
                &a.norm_strict
            } else {
                &a.norm_loose
            };
            let tokens: Vec<&str> = text.split(' ').collect();
            terms.iter().all(|t| contains(&tokens, t))
        })
        .map(|a| a.id)
        .collect()
}

/// The words of an ayah whose own loose tokens match a term token (prefix rule for the last token of a prefix term).
fn oracle_words(mini: &MiniCore, ayah_id: u32, terms: &[OracleTerm]) -> Vec<u32> {
    mini.words
        .iter()
        .filter(|w| w.ayah_id == ayah_id && !w.is_end)
        .filter(|w| {
            let parts: Vec<&str> = w.norm_loose.as_deref().unwrap().split(' ').collect();
            parts.iter().any(|p| {
                terms.iter().any(|t| {
                    t.tokens.iter().enumerate().any(|(i, tok)| {
                        if t.prefix && i + 1 == t.tokens.len() {
                            p.starts_with(tok)
                        } else {
                            p == tok
                        }
                    })
                })
            })
        })
        .map(|w| w.id)
        .collect()
}

fn surah_counts(mini: &MiniCore, ids: &[u32]) -> BTreeMap<u32, u32> {
    let mut counts = BTreeMap::new();
    for &id in ids {
        *counts.entry(mini.ayah_by_id(id).surah).or_insert(0) += 1;
    }
    counts
}

/// Every structural promise of a Quran result: mushaf order, groups by surah with full counts, hit fields from the
/// model (reference, page in the layout, words with the end marker last, first word id), totals.
fn check_shape(f: &Fixture, req: &SearchRequest, r: &SearchResults, expected: &[u32]) {
    let ids = hit_ids(r);
    let limit = usize::try_from(req.limit).unwrap();
    assert_eq!(ids, expected[..expected.len().min(limit)], "{}", req.query);
    assert_eq!(r.total as usize, expected.len(), "{}", req.query);
    assert_eq!(r.truncated, expected.len() > limit, "{}", req.query);
    let full = surah_counts(&f.mini, expected);
    let mut previous = 0;
    for group in &r.groups {
        assert!(group.surah > previous, "groups in mushaf order");
        previous = group.surah;
        assert!(!group.hits.is_empty());
        assert_eq!(
            group.count, full[&group.surah],
            "full count of surah {}",
            group.surah
        );
        for hit in &group.hits {
            assert_eq!(hit.surah, group.surah);
        }
    }
    let layout_id = match req.layout {
        MushafLayout::V2 => 1,
        MushafLayout::V1 => 2,
        MushafLayout::V4 => 19,
    };
    for hit in hits(r) {
        let a = f.mini.ayah_by_id(hit.ayah_id);
        assert_eq!((hit.surah, hit.ayah), (a.surah, a.ayah));
        assert_eq!(hit.first_word_id, a.first_word_id);
        assert_eq!(hit.page, f.mini.page_of_word(layout_id, a.first_word_id));
        let words: Vec<&str> = (a.first_word_id..=a.last_word_id)
            .map(|w| f.mini.word(w).text_hafs.as_str())
            .collect();
        assert_eq!(hit.words, words);
        assert!(f.mini.word(a.last_word_id).is_end);
        assert!(hit.snippet.is_none() && hit.note_id.is_none());
        for id in &hit.matched_word_ids {
            assert!(
                (a.first_word_id..a.last_word_id).contains(id),
                "never the end marker"
            );
        }
    }
}

#[test]
fn smart_search_matches_the_oracle() {
    let f = fixture();
    let all = (1, f.mini.ayah_count());
    let cases: Vec<(&str, Vec<OracleTerm>)> = vec![
        ("الرحمن", vec![prefix("الرحمن")]),
        ("الرحمن الرحيم", vec![word("الرحمن"), prefix("الرحيم")]),
        ("الرح", vec![prefix("الرح")]),
        ("ال", vec![prefix("ال")]),
        ("الصَّلَاةَ", vec![prefix("الصلاه")]),
        ("يا ايها", vec![word("يا"), prefix("ايها")]),
        ("\"يا ايها\"", vec![phrase(&["يا", "ايها"])]),
        (
            "\"بسم الله\" الرحيم",
            vec![phrase(&["بسم", "الله"]), prefix("الرحيم")],
        ),
        ("واناب", vec![prefix("واناب")]),
        ("يسجدون", vec![prefix("يسجدون")]),
        ("الله رب", vec![word("الله"), prefix("رب")]),
    ];
    for (query, terms) in cases {
        let req = smart(query);
        let r = f.engine.search_quran(&req).unwrap();
        let expected = oracle(&f.mini, &terms, false, all);
        assert!(!expected.is_empty(), "{query}: the mini core has matches");
        check_shape(&f, &req, &r, &expected);
        assert!(r.suggestions.is_empty(), "{query}");
        for hit in hits(&r) {
            assert_eq!(
                hit.matched_word_ids,
                oracle_words(&f.mini, hit.ayah_id, &terms),
                "{query}: words of ayah {}",
                hit.ayah_id
            );
            assert!(
                !hit.matched_word_ids.is_empty(),
                "{query}: ayah {}",
                hit.ayah_id
            );
        }
    }
}

#[test]
fn the_two_token_word_is_one_matched_word() {
    let f = fixture();
    let r = f.engine.search_quran(&smart("يا ايها")).unwrap();
    let spaced: Vec<u32> = f
        .mini
        .words
        .iter()
        .filter(|w| w.norm_loose.as_deref() == Some("يا ايها"))
        .map(|w| w.id)
        .collect();
    assert!(!spaced.is_empty());
    for hit in hits(&r) {
        let in_ayah: Vec<u32> = spaced
            .iter()
            .copied()
            .filter(|&w| f.mini.word(w).ayah_id == hit.ayah_id)
            .collect();
        for w in &in_ayah {
            assert_eq!(
                hit.matched_word_ids.iter().filter(|m| *m == w).count(),
                1,
                "word {w} once"
            );
        }
        // The UI wraps words[id − firstWordId]: every matched id indexes a word.
        for id in &hit.matched_word_ids {
            let i = usize::try_from(id - hit.first_word_id).unwrap();
            assert!(i < hit.words.len());
        }
    }
    assert_eq!(r.normalized, "يا ايها");
}

#[test]
fn the_sajda_word_with_a_space_is_copied_whole_into_words() {
    let f = fixture();
    let r = f.engine.search_quran(&smart("واناب")).unwrap();
    let hit = hits(&r)[0];
    let matched = hit.matched_word_ids[0];
    let text = &hit.words[usize::try_from(matched - hit.first_word_id).unwrap()];
    assert_eq!(
        text,
        mini_core::SAJDA_SPACED.hafs,
        "one word, its inner space kept"
    );
}

#[test]
fn exact_mode_uses_the_strict_column_without_prefix_or_typos() {
    let f = fixture();
    let all = (1, f.mini.ayah_count());
    let req = request("الصلاة", SearchMode::Exact);
    let r = f.engine.search_quran(&req).unwrap();
    let expected = oracle(&f.mini, &[word("الصلاة")], true, all);
    assert!(!expected.is_empty());
    check_shape(&f, &req, &r, &expected);
    assert_eq!(r.normalized, "الصلاة");
    // ة is kept in strict, so the loose spelling finds nothing, and exact mode never expands typos.
    let r = f
        .engine
        .search_quran(&request("الصلاه", SearchMode::Exact))
        .unwrap();
    assert_eq!((r.total, r.suggestions.len()), (0, 0));
    // No prefix in exact mode.
    let r = f
        .engine
        .search_quran(&request("الرح", SearchMode::Exact))
        .unwrap();
    assert_eq!(r.total, 0);
    // Matched words compare the strict form of their Imla'i text.
    let r = f
        .engine
        .search_quran(&request("يؤمنون", SearchMode::Exact))
        .unwrap();
    for hit in hits(&r) {
        for id in &hit.matched_word_ids {
            assert_eq!(f.mini.word(*id).norm_strict.as_deref(), Some("يؤمنون"));
        }
        assert!(!hit.matched_word_ids.is_empty());
    }
}

#[test]
fn substring_mode_scans_the_loose_text() {
    let f = fixture();
    for needle in ["رحم", "ن الر", "لله", "ايها"] {
        let req = request(needle, SearchMode::Substring);
        let r = f.engine.search_quran(&req).unwrap();
        let expected: Vec<u32> = f
            .mini
            .ayahs
            .iter()
            .filter(|a| a.norm_loose.contains(needle))
            .map(|a| a.id)
            .collect();
        assert!(!expected.is_empty(), "{needle}");
        check_shape(&f, &req, &r, &expected);
        assert_eq!(r.normalized, needle);
        for hit in hits(&r) {
            assert!(
                !hit.matched_word_ids.is_empty(),
                "{needle}: ayah {}",
                hit.ayah_id
            );
            for id in &hit.matched_word_ids {
                let loose = f.mini.word(*id).norm_loose.clone().unwrap();
                let a = f.mini.ayah_by_id(hit.ayah_id);
                assert!(
                    needle.contains(loose.as_str())
                        || loose.contains(needle)
                        || needle.split(' ').any(|part| loose.contains(part)),
                    "{needle}: word {loose} of {}",
                    a.norm_loose
                );
            }
        }
    }
    // A needle spanning two words marks both.
    let r = f
        .engine
        .search_quran(&request("الرحمن الرحيم", SearchMode::Substring))
        .unwrap();
    let hit = hits(&r)[0];
    assert_eq!(hit.matched_word_ids.len(), 2);
    // LIKE wildcards in the needle are literal.
    for needle in ["%", "_", "\\", "ا%ل"] {
        let r = f
            .engine
            .search_quran(&request(needle, SearchMode::Substring))
            .unwrap();
        assert_eq!(r.total, 0, "{needle}");
    }
}

#[test]
fn filters_are_one_ayah_range_in_sql() {
    let f = fixture();
    let terms = [prefix("ال")];
    let cases = [
        (Some(2), None, Some((8, 32))),
        (None, Some(2), Some((21, 38))),
        (Some(2), Some(2), Some((21, 32))),
        (Some(3), Some(1), None),
        (Some(1), Some(2), None),
    ];
    for (surah, juz, range) in cases {
        let mut req = smart("ال");
        req.surah = surah;
        req.juz = juz;
        let r = f.engine.search_quran(&req).unwrap();
        match range {
            Some(range) => {
                let expected = oracle(&f.mini, &terms, false, range);
                assert!(!expected.is_empty());
                check_shape(&f, &req, &r, &expected);
            }
            None => {
                assert_eq!(r.total, 0, "{surah:?}/{juz:?}: empty intersection");
                assert!(r.groups.is_empty() && !r.truncated);
            }
        }
    }
    for (surah, juz) in [
        (Some(0), None),
        (Some(4), None),
        (None, Some(0)),
        (None, Some(3)),
    ] {
        let mut req = smart("ال");
        req.surah = surah;
        req.juz = juz;
        assert!(
            matches!(
                f.engine.search_quran(&req),
                Err(CoreError::InvalidArgument(_))
            ),
            "{surah:?}/{juz:?}"
        );
    }
}

#[test]
fn truncated_results_keep_full_group_counts() {
    let f = fixture();
    let terms = [prefix("ال")];
    let expected = oracle(&f.mini, &terms, false, (1, f.mini.ayah_count()));
    let counts = surah_counts(&f.mini, &expected);
    assert!(counts.len() >= 2 && expected.len() > 8);
    for limit in [1, 3, 7, 8, 9, 20] {
        let mut req = smart("ال");
        req.limit = limit;
        let r = f.engine.search_quran(&req).unwrap();
        check_shape(&f, &req, &r, &expected);
        assert!(r.truncated || usize::try_from(limit).unwrap() >= expected.len());
    }
    // Truncation inside a filter counts only that filter.
    let mut req = smart("ال");
    req.limit = 2;
    req.juz = Some(2);
    let r = f.engine.search_quran(&req).unwrap();
    let in_juz = oracle(&f.mini, &terms, false, (21, 38));
    check_shape(&f, &req, &r, &in_juz);
}

#[test]
fn page_numbers_follow_the_requested_layout() {
    let f = fixture();
    for layout in [MushafLayout::V2, MushafLayout::V1, MushafLayout::V4] {
        let mut req = smart("ال");
        req.layout = layout;
        let r = f.engine.search_quran(&req).unwrap();
        let expected = oracle(&f.mini, &[prefix("ال")], false, (1, f.mini.ayah_count()));
        check_shape(&f, &req, &r, &expected);
    }
}

#[test]
fn typos_fall_back_to_the_nearest_vocabulary_terms() {
    let f = fixture();
    let all = (1, f.mini.ayah_count());
    // Missing letter, extra letter, wrong letter; the loose fold applies first.
    for (typo, fixed) in [
        ("الرحمان", "الرحمن"),
        ("العلمين", "العالمين"),
        ("الحمدد", "الحمد"),
        ("يومنوت", "يومنون"),
    ] {
        let r = f.engine.search_quran(&smart(typo)).unwrap();
        assert_eq!(r.suggestions, [fixed], "{typo}");
        let expected = oracle(&f.mini, &[word(fixed)], false, all);
        check_shape(&f, &smart(typo), &r, &expected);
        for hit in hits(&r) {
            assert_eq!(
                hit.matched_word_ids,
                oracle_words(&f.mini, hit.ayah_id, &[word(fixed)])
            );
        }
        assert_eq!(r.normalized, typo, "normalized is what was typed");
    }
    // A correct word next to a typo stays as typed.
    let r = f.engine.search_quran(&smart("الله الرحمان")).unwrap();
    assert_eq!(r.suggestions, ["الرحمن"]);
    let expected = oracle(&f.mini, &[word("الله"), word("الرحمن")], false, all);
    check_shape(&f, &smart("الله الرحمان"), &r, &expected);
    // Two terms at the nearest distance are OR-ed next to a correct word (an explicit AND in FTS5).
    let r = f.engine.search_quran(&smart("الله الرحيمن")).unwrap();
    let mut fixes = r.suggestions.clone();
    fixes.sort();
    assert_eq!(fixes, ["الرحمن", "الرحيم"]);
    let mut expected = oracle(&f.mini, &[word("الله"), word("الرحمن")], false, all);
    expected.extend(oracle(&f.mini, &[word("الله"), word("الرحيم")], false, all));
    expected.sort_unstable();
    expected.dedup();
    assert!(!expected.is_empty());
    check_shape(&f, &smart("الله الرحيمن"), &r, &expected);
    // Short tokens, phrases and unfixable words never expand.
    for q in ["زب", "\"الرحمان\"", "زززززز", "يا الرحمان"] {
        let r = f.engine.search_quran(&smart(q)).unwrap();
        assert_eq!((r.total, r.suggestions.len()), (0, 0), "{q}");
    }
}

#[test]
fn empty_and_inert_queries() {
    let f = fixture();
    for q in ["", "   ", "؟", "ــ", "\u{064E}", "\"\"", "«»"] {
        for mode in [SearchMode::Smart, SearchMode::Exact, SearchMode::Substring] {
            let r = f.engine.search_quran(&request(q, mode)).unwrap();
            assert_eq!(r.total, 0, "{q:?} {mode:?}");
            assert!(r.groups.is_empty() && r.suggestions.is_empty());
            assert_eq!(r.query, q);
        }
    }
    // FTS5 syntax typed by the user is searched as text, never parsed.
    for q in [
        "AND",
        "OR الله",
        "NOT الله",
        "NEAR(الله رب)",
        "loose:الله",
        "strict : الله",
        "-الله",
        "^الله",
        "الله*",
        "(الله",
        "{loose strict}: الله",
        "\"الله",
        "الله\"\"رب",
        "*",
        "**",
        "+",
        "'",
        "\\",
    ] {
        for mode in [SearchMode::Smart, SearchMode::Exact, SearchMode::Substring] {
            f.engine
                .search_quran(&request(q, mode))
                .unwrap_or_else(|e| panic!("{q:?} {mode:?}: {e}"));
        }
    }
}

#[test]
fn requests_outside_the_contract_are_rejected_before_any_io() {
    let engine = SearchEngine::new(CoreDb::unavailable("test".into()));
    let mut req = smart("الله");
    req.limit = 0;
    assert!(matches!(
        engine.search_quran(&req),
        Err(CoreError::InvalidArgument(_))
    ));
    req.limit = MAX_LIMIT + 1;
    assert!(matches!(
        engine.search_quran(&req),
        Err(CoreError::InvalidArgument(_))
    ));
    let mut wrong = smart("الله");
    wrong.scope = SearchScope::Notes;
    assert!(matches!(
        engine.search_quran(&wrong),
        Err(CoreError::InvalidArgument(_))
    ));
    // A valid request on an unavailable core reports the degrade message.
    match engine.search_quran(&smart("الله")) {
        Err(CoreError::NotFound(m)) => assert_eq!(m, UNAVAILABLE_MESSAGE),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        engine.suggest("ال", 5),
        Err(CoreError::NotFound(_))
    ));
    assert!(matches!(
        engine.suggest("ال", 0),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn suggestions_complete_the_word_being_typed() {
    let f = fixture();
    let mut docs: BTreeMap<&str, u32> = BTreeMap::new();
    for a in &f.mini.ayahs {
        let mut seen = std::collections::BTreeSet::new();
        for t in a.norm_loose.split(' ') {
            if seen.insert(t) {
                *docs.entry(t).or_insert(0) += 1;
            }
        }
    }
    let expect = |prefix: &str, limit: usize| -> Vec<(String, u32)> {
        let mut v: Vec<(String, u32)> = docs
            .iter()
            .filter(|(t, _)| t.starts_with(prefix))
            .map(|(t, n)| ((*t).to_owned(), *n))
            .collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(limit);
        v
    };
    for (typed, prefix) in [
        ("ال", "ال"),
        ("الر", "الر"),
        ("بسم الل", "الل"),
        ("ٱلرَّ", "الر"),
        ("ي", "ي"),
    ] {
        let got: Vec<(String, u32)> = f
            .engine
            .suggest(typed, 10)
            .unwrap()
            .into_iter()
            .map(|s| (s.term, s.count))
            .collect();
        assert_eq!(got, expect(prefix, 10), "{typed}");
        assert!(!got.is_empty());
    }
    assert_eq!(f.engine.suggest("ال", 2).unwrap().len(), 2);
    for typed in ["", " ", "بسم ", "الله،", "\"", "ززز"] {
        assert!(f.engine.suggest(typed, 10).unwrap().is_empty(), "{typed:?}");
    }
    assert!(f.engine.suggest("ال", MAX_SUGGEST_LIMIT).is_ok());
    assert!(matches!(
        f.engine.suggest("ال", MAX_SUGGEST_LIMIT + 1),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn the_engine_is_shareable_across_threads() {
    let f = fixture();
    let engine = f.engine.clone();
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let engine = engine.clone();
            std::thread::spawn(move || {
                let q = ["الرحمن", "الله", "الرحمان", "يا ايها"][i];
                engine.search_quran(&smart(q)).unwrap().total
            })
        })
        .collect();
    for h in handles {
        assert!(h.join().unwrap() > 0);
    }
    assert!(format!("{engine:?}").contains("SearchEngine"));
}
