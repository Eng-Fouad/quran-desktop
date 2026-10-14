//! The synthetic mini core.db (`tests/support/mini_core.rs`) is a faithful stand-in: its normalised columns are
//! `normalize_ar` output, its FTS index answers like a real build, and it satisfies the structural verify-core gates
//! that page assembly relies on.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use quran_core::{CoreDb, Level, normalize_ar};
use rusqlite::Connection;
use support::mini_core;

#[test]
fn normalised_columns_are_normalize_ar_output() {
    let mini = mini_core::model();
    for w in mini.words.iter().filter(|w| !w.is_end) {
        let imlaei = w.text_imlaei.as_deref().unwrap();
        assert_eq!(
            w.norm_loose.as_deref(),
            Some(normalize_ar(imlaei, Level::Loose).as_str()),
            "word {}",
            w.id
        );
        assert_eq!(
            w.norm_strict.as_deref(),
            Some(normalize_ar(imlaei, Level::Strict).as_str()),
            "word {}",
            w.id
        );
    }
    for a in &mini.ayahs {
        assert_eq!(
            a.norm_loose,
            normalize_ar(&a.text_imlaei, Level::Loose),
            "ayah {}",
            a.id
        );
        assert_eq!(
            a.norm_strict,
            normalize_ar(&a.text_imlaei, Level::Strict),
            "ayah {}",
            a.id
        );
    }
}

#[test]
fn the_mini_build_is_searchable_like_a_real_one() {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let core = CoreDb::open(&mini.path).unwrap();
    let conn = core.conn().unwrap();
    let hits = |q: &str| -> Vec<u32> {
        let mut stmt = conn
            .prepare("SELECT rowid FROM ayah_fts WHERE ayah_fts MATCH ?1 ORDER BY rowid")
            .unwrap();
        stmt.query_map([q], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let expected = |pred: &dyn Fn(&mini_core::Ayah) -> bool| -> Vec<u32> {
        mini.ayahs
            .iter()
            .filter(|a| pred(a))
            .map(|a| a.id)
            .collect()
    };
    assert_eq!(
        hits("loose : (\"الرحمن\")"),
        expected(&|a| a.norm_loose.split(' ').any(|t| t == "الرحمن"))
    );
    assert_eq!(
        hits("loose : (\"الصلاه\")"),
        expected(&|a| a.norm_loose.contains("الصلاه"))
    );
    assert_eq!(
        hits("strict : (\"الصلاة\")"),
        expected(&|a| a.norm_strict.contains("الصلاة"))
    );
    assert!(!hits("loose : (\"الرح\"*)").is_empty());
    assert_eq!(
        hits("loose : (\"واناب\")"),
        vec![27],
        "the spaced sajda word is searchable"
    );
    let vocab: u32 = conn
        .query_row("SELECT count(*) FROM vocab_loose", [], |r| r.get(0))
        .unwrap();
    assert!(vocab >= 12, "{vocab}");
}

#[test]
fn the_mini_build_satisfies_the_structural_gates() {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let conn = Connection::open(&mini.path).unwrap();
    // G2: ids contiguous; each ayah has positions 1..n and exactly one end marker, last.
    for a in &mini.ayahs {
        let words: Vec<_> = (a.first_word_id..=a.last_word_id)
            .map(|id| mini.word(id))
            .collect();
        for (i, w) in words.iter().enumerate() {
            assert_eq!(w.position, u32::try_from(i).unwrap() + 1);
            assert_eq!(w.is_end, i + 1 == words.len());
        }
        // G5: markers are U+06DD + Arabic-Indic digits; G5b: a space only before ۩.
        assert_eq!(
            words.last().unwrap().text_hafs,
            format!("\u{06DD}{}", mini_core::arabic_digits(a.ayah))
        );
        for w in &words[..words.len() - 1] {
            for (i, _) in w.text_hafs.match_indices(' ') {
                assert!(
                    w.text_hafs[i + 1..].starts_with('\u{06E9}'),
                    "word {}",
                    w.id
                );
            }
        }
    }
    // G11b: the ayahs with a ۩ word are exactly the sajda table.
    let sajda_ayahs: Vec<u32> = mini
        .ayahs
        .iter()
        .filter(|a| a.text_hafs.contains('\u{06E9}'))
        .map(|a| a.id)
        .collect();
    assert_eq!(
        sajda_ayahs,
        mini.sajdas.iter().map(|s| s.ayah_id).collect::<Vec<_>>()
    );
    for layout in &mini.layouts {
        let mut next = 1;
        for page in &layout.pages {
            // G6: pages 1–2 have lines 1..8, the others 1..15.
            let n = if page.page <= 2 { 8 } else { 15 };
            let numbers: Vec<u32> = page.lines.iter().map(|l| l.line).collect();
            assert_eq!(numbers, (1..=n).collect::<Vec<_>>());
            // G7: kind-0 lines cover every word once, contiguously across lines and pages.
            for line in page.lines.iter().filter(|l| l.kind == 0) {
                assert_eq!(line.first_word_id, Some(next));
                next = line.last_word_id.unwrap() + 1;
            }
            // G8: header lines sit directly above the surah's first ayah line, on the same page.
            for (i, line) in page.lines.iter().enumerate().filter(|(_, l)| l.kind == 1) {
                let surah = mini.surah(line.surah_id.unwrap());
                let first_word = mini.ayah_by_id(surah.first_ayah_id).first_word_id;
                let offset = if surah.bismillah_pre { 2 } else { 1 };
                let ayah_line = &page.lines[i + offset];
                assert_eq!(
                    ayah_line.first_word_id,
                    Some(first_word),
                    "surah {}",
                    surah.id
                );
                if surah.bismillah_pre {
                    assert_eq!(
                        (page.lines[i + 1].kind, page.lines[i + 1].surah_id),
                        (2, Some(surah.id))
                    );
                }
            }
            // G10: every page starts at an ayah start.
            assert_eq!(mini.word(page.first_word_id).position, 1);
        }
        assert_eq!(next, mini.word_count() + 1);
    }
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal, "delete");
}
