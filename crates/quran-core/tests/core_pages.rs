//! Page assembly against a real core.db (§12.2): golden structure for pages 1, 2, 3, 187, 262, 600 and 604 in all three
//! layouts, well-formedness of every page in every style, the required `EXPLAIN QUERY PLAN`, and the §3.5 budget.
//! Run with `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core --test 'core_*' -- --ignored`.
//! Owner: WP1a.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use quran_core::CoreDb;
use quran_core::core_db::PAGE_SQL;
use quran_types::{AyahText, LineKind, MushafLayout, MushafStyle, PageData};

/// One golden page, derived independently of xtask from the raw QDC page responses (D4 line fix on pages 1–2, C15
/// header lines, the G9 v2 centring list).
struct GoldenPage {
    mushaf: u32,
    page: u32,
    /// `(surah, ayah)` of the first and last ayah on the page.
    first: (u32, u32),
    last: (u32, u32),
    /// `(line, kind 0 ayah | 1 surah_name | 2 basmallah, header surah or 0, words on the line, centred)`.
    lines: &'static [(u32, u8, u32, u32, bool)],
}

#[rustfmt::skip]
const GOLDEN_PAGES: &[GoldenPage] = &[
    GoldenPage { mushaf: 1, page: 1, first: (1, 1), last: (1, 7),
        lines: &[(1, 1, 1, 0, true), (2, 0, 0, 5, true), (3, 0, 0, 5, true), (4, 0, 0, 7, true), (5, 0, 0, 6, true), (6, 0, 0, 6, true), (7, 0, 0, 4, true), (8, 0, 0, 3, true)] },
    GoldenPage { mushaf: 1, page: 2, first: (2, 1), last: (2, 5),
        lines: &[(1, 1, 2, 0, true), (2, 2, 2, 0, true), (3, 0, 0, 8, true), (4, 0, 0, 7, true), (5, 0, 0, 8, true), (6, 0, 0, 9, true), (7, 0, 0, 6, true), (8, 0, 0, 3, true)] },
    GoldenPage { mushaf: 1, page: 3, first: (2, 6), last: (2, 16),
        lines: &[(1, 0, 0, 9, false), (2, 0, 0, 10, false), (3, 0, 0, 8, false), (4, 0, 0, 10, false), (5, 0, 0, 8, false), (6, 0, 0, 9, false), (7, 0, 0, 10, false), (8, 0, 0, 11, false), (9, 0, 0, 9, false), (10, 0, 0, 9, false), (11, 0, 0, 10, false), (12, 0, 0, 10, false), (13, 0, 0, 9, false), (14, 0, 0, 8, false), (15, 0, 0, 8, false)] },
    GoldenPage { mushaf: 1, page: 187, first: (9, 1), last: (9, 6),
        lines: &[(1, 1, 9, 0, true), (2, 0, 0, 10, false), (3, 0, 0, 9, false), (4, 0, 0, 10, false), (5, 0, 0, 10, false), (6, 0, 0, 9, false), (7, 0, 0, 9, false), (8, 0, 0, 10, false), (9, 0, 0, 9, false), (10, 0, 0, 9, false), (11, 0, 0, 6, false), (12, 0, 0, 9, false), (13, 0, 0, 10, false), (14, 0, 0, 7, false), (15, 0, 0, 10, false)] },
    GoldenPage { mushaf: 1, page: 262, first: (15, 1), last: (15, 15),
        lines: &[(1, 1, 15, 0, true), (2, 2, 15, 0, true), (3, 0, 0, 9, false), (4, 0, 0, 8, false), (5, 0, 0, 8, false), (6, 0, 0, 11, false), (7, 0, 0, 9, false), (8, 0, 0, 10, false), (9, 0, 0, 10, false), (10, 0, 0, 11, false), (11, 0, 0, 10, false), (12, 0, 0, 9, false), (13, 0, 0, 11, false), (14, 0, 0, 11, false), (15, 0, 0, 9, false)] },
    GoldenPage { mushaf: 1, page: 600, first: (100, 6), last: (102, 8),
        lines: &[(1, 0, 0, 12, false), (2, 0, 0, 11, false), (3, 0, 0, 11, false), (4, 1, 101, 0, true), (5, 2, 101, 0, true), (6, 0, 0, 11, false), (7, 0, 0, 7, false), (8, 0, 0, 10, false), (9, 0, 0, 10, false), (10, 0, 0, 9, true), (11, 1, 102, 0, true), (12, 2, 102, 0, true), (13, 0, 0, 12, false), (14, 0, 0, 13, false), (15, 0, 0, 11, false)] },
    GoldenPage { mushaf: 1, page: 604, first: (112, 1), last: (114, 6),
        lines: &[(1, 1, 112, 0, true), (2, 2, 112, 0, true), (3, 0, 0, 13, false), (4, 0, 0, 6, true), (5, 1, 113, 0, true), (6, 2, 113, 0, true), (7, 0, 0, 12, false), (8, 0, 0, 10, false), (9, 0, 0, 6, true), (10, 1, 114, 0, true), (11, 2, 114, 0, true), (12, 0, 0, 9, false), (13, 0, 0, 8, false), (14, 0, 0, 5, true), (15, 0, 0, 4, true)] },
    GoldenPage { mushaf: 2, page: 1, first: (1, 1), last: (1, 7),
        lines: &[(1, 1, 1, 0, true), (2, 0, 0, 5, true), (3, 0, 0, 5, true), (4, 0, 0, 7, true), (5, 0, 0, 6, true), (6, 0, 0, 6, true), (7, 0, 0, 4, true), (8, 0, 0, 3, true)] },
    GoldenPage { mushaf: 2, page: 2, first: (2, 1), last: (2, 5),
        lines: &[(1, 1, 2, 0, true), (2, 2, 2, 0, true), (3, 0, 0, 8, true), (4, 0, 0, 7, true), (5, 0, 0, 8, true), (6, 0, 0, 9, true), (7, 0, 0, 6, true), (8, 0, 0, 3, true)] },
    GoldenPage { mushaf: 2, page: 3, first: (2, 6), last: (2, 16),
        lines: &[(1, 0, 0, 9, false), (2, 0, 0, 10, false), (3, 0, 0, 8, false), (4, 0, 0, 10, false), (5, 0, 0, 8, false), (6, 0, 0, 9, false), (7, 0, 0, 10, false), (8, 0, 0, 9, false), (9, 0, 0, 10, false), (10, 0, 0, 10, false), (11, 0, 0, 10, false), (12, 0, 0, 10, false), (13, 0, 0, 9, false), (14, 0, 0, 8, false), (15, 0, 0, 8, false)] },
    GoldenPage { mushaf: 2, page: 187, first: (9, 1), last: (9, 6),
        lines: &[(1, 1, 9, 0, true), (2, 0, 0, 10, false), (3, 0, 0, 9, false), (4, 0, 0, 10, false), (5, 0, 0, 10, false), (6, 0, 0, 9, false), (7, 0, 0, 9, false), (8, 0, 0, 9, false), (9, 0, 0, 9, false), (10, 0, 0, 10, false), (11, 0, 0, 6, false), (12, 0, 0, 8, false), (13, 0, 0, 9, false), (14, 0, 0, 8, false), (15, 0, 0, 11, false)] },
    GoldenPage { mushaf: 2, page: 262, first: (15, 1), last: (15, 15),
        lines: &[(1, 1, 15, 0, true), (2, 2, 15, 0, true), (3, 0, 0, 9, false), (4, 0, 0, 8, false), (5, 0, 0, 8, false), (6, 0, 0, 11, false), (7, 0, 0, 9, false), (8, 0, 0, 10, false), (9, 0, 0, 10, false), (10, 0, 0, 11, false), (11, 0, 0, 11, false), (12, 0, 0, 9, false), (13, 0, 0, 10, false), (14, 0, 0, 10, false), (15, 0, 0, 10, false)] },
    GoldenPage { mushaf: 2, page: 600, first: (100, 10), last: (102, 8),
        lines: &[(1, 0, 0, 11, false), (2, 1, 101, 0, true), (3, 2, 101, 0, true), (4, 0, 0, 9, false), (5, 0, 0, 7, false), (6, 0, 0, 6, false), (7, 0, 0, 8, false), (8, 0, 0, 8, false), (9, 0, 0, 9, true), (10, 1, 102, 0, true), (11, 2, 102, 0, true), (12, 0, 0, 9, false), (13, 0, 0, 10, false), (14, 0, 0, 8, false), (15, 0, 0, 9, false)] },
    GoldenPage { mushaf: 2, page: 604, first: (112, 1), last: (114, 6),
        lines: &[(1, 1, 112, 0, true), (2, 2, 112, 0, true), (3, 0, 0, 10, false), (4, 0, 0, 9, false), (5, 1, 113, 0, true), (6, 2, 113, 0, true), (7, 0, 0, 11, false), (8, 0, 0, 9, false), (9, 0, 0, 8, false), (10, 1, 114, 0, true), (11, 2, 114, 0, true), (12, 0, 0, 9, false), (13, 0, 0, 8, false), (14, 0, 0, 5, true), (15, 0, 0, 4, true)] },
    GoldenPage { mushaf: 19, page: 1, first: (1, 1), last: (1, 7),
        lines: &[(1, 1, 1, 0, true), (2, 0, 0, 5, true), (3, 0, 0, 5, true), (4, 0, 0, 7, true), (5, 0, 0, 6, true), (6, 0, 0, 6, true), (7, 0, 0, 4, true), (8, 0, 0, 3, true)] },
    GoldenPage { mushaf: 19, page: 2, first: (2, 1), last: (2, 5),
        lines: &[(1, 1, 2, 0, true), (2, 2, 2, 0, true), (3, 0, 0, 8, true), (4, 0, 0, 7, true), (5, 0, 0, 8, true), (6, 0, 0, 9, true), (7, 0, 0, 6, true), (8, 0, 0, 3, true)] },
    GoldenPage { mushaf: 19, page: 3, first: (2, 6), last: (2, 16),
        lines: &[(1, 0, 0, 9, false), (2, 0, 0, 10, false), (3, 0, 0, 8, false), (4, 0, 0, 10, false), (5, 0, 0, 8, false), (6, 0, 0, 9, false), (7, 0, 0, 10, false), (8, 0, 0, 11, false), (9, 0, 0, 9, false), (10, 0, 0, 9, false), (11, 0, 0, 10, false), (12, 0, 0, 10, false), (13, 0, 0, 9, false), (14, 0, 0, 8, false), (15, 0, 0, 8, false)] },
    GoldenPage { mushaf: 19, page: 187, first: (9, 1), last: (9, 6),
        lines: &[(1, 1, 9, 0, true), (2, 0, 0, 10, false), (3, 0, 0, 9, false), (4, 0, 0, 10, false), (5, 0, 0, 10, false), (6, 0, 0, 9, false), (7, 0, 0, 10, false), (8, 0, 0, 9, false), (9, 0, 0, 9, false), (10, 0, 0, 9, false), (11, 0, 0, 6, false), (12, 0, 0, 9, false), (13, 0, 0, 10, false), (14, 0, 0, 7, false), (15, 0, 0, 10, false)] },
    GoldenPage { mushaf: 19, page: 262, first: (15, 1), last: (15, 15),
        lines: &[(1, 1, 15, 0, true), (2, 2, 15, 0, true), (3, 0, 0, 9, false), (4, 0, 0, 8, false), (5, 0, 0, 8, false), (6, 0, 0, 11, false), (7, 0, 0, 9, false), (8, 0, 0, 10, false), (9, 0, 0, 10, false), (10, 0, 0, 11, false), (11, 0, 0, 10, false), (12, 0, 0, 9, false), (13, 0, 0, 12, false), (14, 0, 0, 10, false), (15, 0, 0, 9, false)] },
    GoldenPage { mushaf: 19, page: 600, first: (100, 6), last: (102, 8),
        lines: &[(1, 0, 0, 12, false), (2, 0, 0, 11, false), (3, 0, 0, 11, false), (4, 1, 101, 0, true), (5, 2, 101, 0, true), (6, 0, 0, 11, false), (7, 0, 0, 8, false), (8, 0, 0, 10, false), (9, 0, 0, 10, false), (10, 0, 0, 8, false), (11, 1, 102, 0, true), (12, 2, 102, 0, true), (13, 0, 0, 12, false), (14, 0, 0, 13, false), (15, 0, 0, 11, false)] },
    GoldenPage { mushaf: 19, page: 604, first: (112, 1), last: (114, 6),
        lines: &[(1, 1, 112, 0, true), (2, 2, 112, 0, true), (3, 0, 0, 13, false), (4, 0, 0, 6, true), (5, 1, 113, 0, true), (6, 2, 113, 0, true), (7, 0, 0, 12, false), (8, 0, 0, 10, false), (9, 0, 0, 6, true), (10, 1, 114, 0, true), (11, 2, 114, 0, true), (12, 0, 0, 9, false), (13, 0, 0, 8, false), (14, 0, 0, 5, true), (15, 0, 0, 4, true)] },
];

fn real() -> CoreDb {
    CoreDb::open(&support::real_core_db()).unwrap()
}

fn style_of(layout: MushafLayout) -> MushafStyle {
    match layout {
        MushafLayout::V2 => MushafStyle::QcfV2,
        MushafLayout::V1 => MushafStyle::QcfV1,
        MushafLayout::V4 => MushafStyle::QcfV4,
    }
}

fn kind_code(kind: LineKind) -> u8 {
    match kind {
        LineKind::Ayah => 0,
        LineKind::SurahName => 1,
        LineKind::Basmallah => 2,
    }
}

/// The `centered` column of a page's lines, read straight from the `line` table.
fn centred_column(core: &CoreDb, mushaf: u32, page: u32) -> Vec<bool> {
    let conn = core.conn().unwrap();
    let mut stmt = conn
        .prepare("SELECT centered FROM line WHERE mushaf_id = ?1 AND page = ?2 ORDER BY line")
        .unwrap();
    stmt.query_map((mushaf, page), |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn golden_page_structure() {
    let core = real();
    assert_eq!(GOLDEN_PAGES.len(), 21, "7 pages x 3 layouts (§12.2)");
    for golden in GOLDEN_PAGES {
        let layout = MushafLayout::from_db_id(golden.mushaf).unwrap();
        let page = &core.pages(style_of(layout), &[golden.page]).unwrap()[0];
        let at = format!("{layout:?} page {}", golden.page);
        assert_eq!((page.layout, page.page), (layout, golden.page), "{at}");
        let shape: Vec<(u32, u8, u32, u32)> = page
            .lines
            .iter()
            .map(|l| {
                let words = u32::try_from(l.words.len()).unwrap();
                (l.line, kind_code(l.kind), l.surah.unwrap_or(0), words)
            })
            .collect();
        let expected: Vec<(u32, u8, u32, u32)> = golden
            .lines
            .iter()
            .map(|&(line, kind, surah, words, _)| (line, kind, surah, words))
            .collect();
        assert_eq!(shape, expected, "{at}: lines (number, kind, surah, words)");
        // Centring: the DTO mirrors the line table; v2 must also equal the G9 list, every header and pages 1–2.
        let centred: Vec<bool> = page.lines.iter().map(|l| l.centered).collect();
        assert_eq!(
            centred,
            centred_column(&core, golden.mushaf, golden.page),
            "{at}: centred flags"
        );
        for (line, &(n, kind, _, _, centred)) in page.lines.iter().zip(golden.lines) {
            if layout == MushafLayout::V2 || kind != 0 || golden.page <= 2 {
                assert_eq!(line.centered, centred, "{at} line {n}: centred");
            }
        }
        let first = page.ayahs.first().unwrap();
        let last = page.ayahs.last().unwrap();
        assert_eq!(
            ((first.surah, first.ayah), (last.surah, last.ayah)),
            (golden.first, golden.last),
            "{at}"
        );
        assert_eq!(
            (page.info.first_ayah_id, page.info.last_ayah_id),
            (first.id, last.id),
            "{at}"
        );
        assert_eq!(page.info.head_surah, golden.first.0, "{at}");
        let mut surahs: Vec<u32> = Vec::new();
        for l in &page.lines {
            for s in l.surah.into_iter().chain(l.words.iter().map(|w| w.surah)) {
                if !surahs.contains(&s) {
                    surahs.push(s);
                }
            }
        }
        assert_eq!(page.info.surah_ids, surahs, "{at}");
    }
    // Spot facts beyond the table.
    let p187 = &core.pages(MushafStyle::Hafs, &[187]).unwrap()[0];
    assert!(
        p187.lines.iter().all(|l| l.kind != LineKind::Basmallah),
        "surah 9 has no basmala line"
    );
    let p604 = &core.pages(MushafStyle::Hafs, &[604]).unwrap()[0];
    assert_eq!(p604.info.surah_ids, vec![112, 113, 114]);
    assert_eq!(p604.info.last_ayah_id, 6236);
}

/// `(code_v1, code_v2, text_hafs)` of every word, by id − 1, read straight from the `word` table.
fn word_columns(core: &CoreDb) -> Vec<(String, String, String)> {
    let conn = core.conn().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, code_v1, code_v2, text_hafs FROM word ORDER BY id")
        .unwrap();
    let rows: Vec<(u32, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(rows.iter().zip(1..).all(|(r, id)| r.0 == id));
    rows.into_iter()
        .map(|(_, v1, v2, hafs)| (v1, v2, hafs))
        .collect()
}

/// Every page of every style: the §5.4 shape, word coverage, glyph selection and marker rules, and agreement with the
/// index and with `CoreDb::ayahs`. (The glyph-code shape itself, G4, is verify-core's gate.)
#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn every_page_of_every_style_is_well_formed() {
    let core = real();
    let index = core.index().unwrap();
    let columns = word_columns(&core);
    assert_eq!(columns.len(), 83_665);
    for style in MushafStyle::ALL {
        let layout = style.layout();
        let info = index.layouts.iter().find(|l| l.layout == layout).unwrap();
        let ayah_rows: HashMap<u32, AyahText> = (0..21)
            .flat_map(|i| {
                let from = i * 300 + 1;
                core.ayahs(layout, from, (from + 299).min(6236)).unwrap()
            })
            .map(|a| (a.id, a))
            .collect();
        assert_eq!(ayah_rows.len(), 6236);
        let mut next_word = 1;
        let mut next_ayah = 1;
        for chunk in (1..=604).collect::<Vec<u32>>().chunks(8) {
            for page in core.pages(style, chunk).unwrap() {
                check_page(
                    &page,
                    style,
                    &mut next_word,
                    &mut next_ayah,
                    &ayah_rows,
                    &columns,
                );
                let p = usize::try_from(page.page - 1).unwrap();
                assert_eq!(
                    page.lines.iter().find_map(|l| l.words.first()).unwrap().id,
                    info.page_first_word[p]
                );
                assert_eq!(page.info.first_ayah_id, info.page_first_ayah[p]);
            }
        }
        assert_eq!(
            (next_word, next_ayah),
            (83_666, 6237),
            "{style:?} covers every word and ayah once"
        );
    }
}

fn check_page(
    page: &PageData,
    style: MushafStyle,
    next_word: &mut u32,
    next_ayah: &mut u32,
    ayah_rows: &HashMap<u32, AyahText>,
    columns: &[(String, String, String)],
) {
    let at = format!("{style:?} page {}", page.page);
    let n = if page.page <= 2 { 8 } else { 15 };
    assert_eq!(
        page.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
        (1..=n).collect::<Vec<_>>(),
        "{at}"
    );
    for line in &page.lines {
        match line.kind {
            LineKind::Ayah => assert!(
                !line.words.is_empty() && line.surah.is_none(),
                "{at} line {}",
                line.line
            ),
            LineKind::SurahName | LineKind::Basmallah => {
                assert!(
                    line.words.is_empty() && line.surah.is_some() && line.centered,
                    "{at} line {}",
                    line.line
                );
            }
        }
        for w in &line.words {
            assert_eq!(
                w.id, *next_word,
                "{at}: words are contiguous across lines and pages"
            );
            *next_word += 1;
            let (code_v1, code_v2, text_hafs) = &columns[usize::try_from(w.id - 1).unwrap()];
            let expected = match style {
                MushafStyle::Hafs => text_hafs,
                MushafStyle::QcfV1 => code_v1,
                MushafStyle::QcfV2 | MushafStyle::QcfV4 => code_v2,
            };
            assert_eq!(&w.glyph, expected, "{at} word {}: glyph column", w.id);
            assert_eq!(&w.text, text_hafs, "{at} word {}", w.id);
            assert!(!w.glyph.is_empty(), "{at} word {}", w.id);
            if w.is_end {
                let digits: String = w
                    .ayah
                    .to_string()
                    .chars()
                    .map(|c| char::from_u32(0x0660 + c.to_digit(10).unwrap()).unwrap())
                    .collect();
                assert_eq!(w.text, format!("\u{06DD}{digits}"), "{at} word {}", w.id);
            } else {
                assert!(
                    !w.text.is_empty() && !w.text.contains('\u{06DD}'),
                    "{at} word {}",
                    w.id
                );
            }
        }
    }
    for a in &page.ayahs {
        assert_eq!(a.id, *next_ayah, "{at}: ayahs are contiguous");
        *next_ayah += 1;
        let row = &ayah_rows[&a.id];
        assert_eq!(
            (a.surah, a.ayah, a.juz, a.hizb, a.rub, a.sajda, a.flags),
            (
                row.surah, row.ayah, row.juz, row.hizb, row.rub, row.sajda, row.flags
            ),
            "{at} ayah {}",
            a.id
        );
        assert_eq!(
            row.page, page.page,
            "{at}: quran_get_ayahs agrees on the page of ayah {}",
            a.id
        );
        // G10: every page starts at an ayah start, so no ayah crosses a page.
        assert!(a.starts_on_page && a.ends_on_page, "{at} ayah {}", a.id);
        let line = page
            .lines
            .iter()
            .find(|l| l.words.iter().any(|w| w.id == a.first_word_id))
            .unwrap();
        assert_eq!(a.line, line.line, "{at} ayah {}", a.id);
    }
    let first = &page.ayahs[0];
    assert_eq!(
        (page.info.juz, page.info.hizb, page.info.head_surah),
        (first.juz, first.hizb, first.surah),
        "{at}"
    );
}

#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn the_page_query_uses_the_required_plan() {
    let core = real();
    let conn = core.conn().unwrap();
    for (mushaf, page, selector) in [(1, 262, 2), (2, 1, 1), (19, 604, 0)] {
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {PAGE_SQL}"))
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map((mushaf, page, selector), |r| r.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for step in [
            "SEARCH l USING PRIMARY KEY (mushaf_id=? AND page=?)",
            "SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)",
            "SEARCH a USING INTEGER PRIMARY KEY (rowid=?)",
        ] {
            // SQLite 3.53 appends " LEFT-JOIN" to the detail of the joined steps.
            assert!(
                plan.iter()
                    .any(|p| p.strip_suffix(" LEFT-JOIN").unwrap_or(p) == step),
                "missing {step:?} in {plan:#?}"
            );
        }
        assert!(
            !plan.iter().any(|p| p.contains("SCAN")),
            "no table scan: {plan:#?}"
        );
    }
}

fn p99(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[(samples.len() * 99).div_ceil(100) - 1]
}

/// §3.5: `CoreDb::pages` (1 page) p99 < 5 ms over all 3 × 604 pages; `CoreDb::index` first call < 30 ms. Release
/// builds are faster still; the bound holds in the debug test profile because SQLite is built at opt-level 2.
#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn page_and_index_budgets() {
    let path = support::real_core_db();
    let core = CoreDb::open(&path).unwrap();
    core.pages(MushafStyle::Hafs, &[1]).unwrap(); // connect + warm the page cache once
    let mut samples = Vec::with_capacity(3 * 604);
    for style in [MushafStyle::QcfV2, MushafStyle::QcfV1, MushafStyle::QcfV4] {
        for page in 1..=604 {
            let started = Instant::now();
            let data = core.pages(style, &[page]).unwrap();
            samples.push(started.elapsed());
            assert_eq!(data.len(), 1);
        }
    }
    let page_p99 = p99(samples.clone());
    let median = {
        samples.sort();
        samples[samples.len() / 2]
    };
    eprintln!(
        "CoreDb::pages: median {median:?}, p99 {page_p99:?} over {} pages",
        samples.len()
    );
    assert!(page_p99 < Duration::from_millis(5), "p99 {page_p99:?}");

    let mut firsts = Vec::new();
    for _ in 0..5 {
        let fresh = CoreDb::open(&path).unwrap();
        let started = Instant::now();
        let index = fresh.index().unwrap();
        firsts.push(started.elapsed());
        assert_eq!(index.ayah_first_word.len(), 6236);
        let started = Instant::now();
        fresh.index().unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(5),
            "cached index clone"
        );
    }
    firsts.sort();
    eprintln!("CoreDb::index first call: {firsts:?}");
    assert!(
        firsts[2] < Duration::from_millis(30),
        "median first index build {:?}",
        firsts[2]
    );
}
