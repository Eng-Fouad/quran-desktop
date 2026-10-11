//! Page assembly from the single §3.1.4 page query (lines, words, `PageAyah` and `PageInfo`; §2.2.4). Owner: WP1a.
//!
//! Rows arrive in `(line, word id)` order. A new `line` value pushes a [`PageLine`]; a row with a word pushes a
//! [`PageWord`]. Ayahs are collected into [`PageAyah`] in order of first appearance: `starts_on_page` when the first
//! word seen has position 1, `ends_on_page` when its end marker is seen. [`PageInfo`] comes from the first and last
//! ayah and from the order in which surahs (header lines or words) appear.

use quran_types::{LineKind, MushafStyle, PageAyah, PageData, PageInfo, PageLine, PageWord};
use rusqlite::{Connection, Row};

use super::sajda_kind;
use crate::{CoreError, Result};

/// The page render query (§3.1.4): `?1` = mushaf_id (1|2|19), `?2` = page, `?3` = glyph selector (0 = `text_hafs`,
/// 1 = `code_v1`, 2 = `code_v2`; [`MushafStyle::glyph_selector`]). Public so that `verify-core` (G15) and the tests
/// assert the plan of the exact statement the app runs:
/// `SEARCH l USING PRIMARY KEY (mushaf_id=? AND page=?)`, `SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)`,
/// `SEARCH a USING INTEGER PRIMARY KEY (rowid=?)` (SQLite 3.53 appends ` LEFT-JOIN` to the detail of the two joined
/// steps; compare without it).
pub const PAGE_SQL: &str = "SELECT l.line, l.kind, l.centered, l.surah_id,
       w.id, w.ayah_id, w.surah, w.ayah, w.position, w.is_end,
       CASE ?3 WHEN 1 THEN w.code_v1 WHEN 2 THEN w.code_v2 ELSE w.text_hafs END AS glyph,
       w.text_hafs,
       a.juz, a.hizb, a.rub, a.sajda, a.flags
FROM line AS l
LEFT JOIN word AS w ON l.kind = 0 AND w.id BETWEEN l.first_word_id AND l.last_word_id
LEFT JOIN ayah AS a ON a.id = w.ayah_id
WHERE l.mushaf_id = ?1 AND l.page = ?2
ORDER BY l.line, w.id";

/// One row of [`PAGE_SQL`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PageRow {
    pub line: u32,
    pub kind: i64,
    pub centered: bool,
    pub surah_id: Option<u32>,
    /// `None` for header lines (the LEFT JOIN found no word).
    pub word: Option<WordRow>,
}

/// The word and ayah columns of a [`PageRow`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WordRow {
    pub id: u32,
    pub ayah_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub position: u32,
    pub is_end: bool,
    pub glyph: String,
    pub text: String,
    /// `None` when the word's ayah row is missing (corrupt data).
    pub ayah_row: Option<AyahCols>,
}

/// The `ayah` columns the page needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AyahCols {
    pub juz: u32,
    pub hizb: u32,
    pub rub: u32,
    pub sajda: i64,
    pub flags: u32,
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<PageRow> {
    let word = match row.get::<_, Option<u32>>(4)? {
        None => None,
        Some(id) => Some(WordRow {
            id,
            ayah_id: row.get(5)?,
            surah: row.get(6)?,
            ayah: row.get(7)?,
            position: row.get(8)?,
            is_end: row.get(9)?,
            glyph: row.get(10)?,
            text: row.get(11)?,
            ayah_row: match row.get::<_, Option<u32>>(12)? {
                None => None,
                Some(juz) => Some(AyahCols {
                    juz,
                    hizb: row.get(13)?,
                    rub: row.get(14)?,
                    sajda: row.get(15)?,
                    flags: row.get(16)?,
                }),
            },
        }),
    };
    Ok(PageRow {
        line: row.get(0)?,
        kind: row.get(1)?,
        centered: row.get(2)?,
        surah_id: row.get(3)?,
        word,
    })
}

/// Runs [`PAGE_SQL`] for one page of `style` and assembles it. `NotFound` when the layout has no such page.
pub(super) fn load(conn: &Connection, style: MushafStyle, page: u32) -> Result<PageData> {
    let layout = style.layout();
    let mut stmt = conn.prepare_cached(PAGE_SQL)?;
    let rows = stmt
        .query_map((layout.db_id(), page, style.glyph_selector()), read_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Err(CoreError::NotFound(format!(
            "page {page} of layout {layout:?}"
        )));
    }
    assemble(style, page, rows)
}

fn line_kind(kind: i64) -> Option<LineKind> {
    match kind {
        0 => Some(LineKind::Ayah),
        1 => Some(LineKind::SurahName),
        2 => Some(LineKind::Basmallah),
        _ => None,
    }
}

fn push_unique(ids: &mut Vec<u32>, id: u32) {
    if !ids.contains(&id) {
        ids.push(id);
    }
}

/// Builds the [`PageData`] from the query rows (in `(line, word id)` order), checking the §4.5 invariants the
/// renderer relies on: known line kinds, a surah on every header line, words only on ayah lines, at least one word on
/// every ayah line, strictly increasing word ids, and at least one ayah on the page.
pub(super) fn assemble(style: MushafStyle, page: u32, rows: Vec<PageRow>) -> Result<PageData> {
    let corrupt =
        |what: String| CoreError::Corrupt(format!("page {page} ({:?}): {what}", style.layout()));
    let mut lines: Vec<PageLine> = Vec::with_capacity(15);
    let mut ayahs: Vec<PageAyah> = Vec::with_capacity(16);
    let mut surah_ids: Vec<u32> = Vec::with_capacity(3);
    let mut last_word = 0u32;
    for row in rows {
        if lines.last().map(|l| l.line) != Some(row.line) {
            let kind = line_kind(row.kind)
                .ok_or_else(|| corrupt(format!("line {} has kind {}", row.line, row.kind)))?;
            let surah = match kind {
                LineKind::Ayah => None,
                LineKind::SurahName | LineKind::Basmallah => {
                    let surah = row
                        .surah_id
                        .ok_or_else(|| corrupt(format!("header line {} has no surah", row.line)))?;
                    push_unique(&mut surah_ids, surah);
                    Some(surah)
                }
            };
            lines.push(PageLine {
                line: row.line,
                kind,
                centered: row.centered,
                surah,
                words: Vec::new(),
            });
        }
        let Some(word) = row.word else {
            continue;
        };
        let Some(line) = lines.last_mut() else {
            continue;
        };
        if line.kind != LineKind::Ayah {
            return Err(corrupt(format!("header line {} has words", line.line)));
        }
        if word.id <= last_word {
            return Err(corrupt(format!(
                "word {} follows word {last_word}",
                word.id
            )));
        }
        last_word = word.id;
        let cols = word
            .ayah_row
            .ok_or_else(|| corrupt(format!("word {} has no ayah row {}", word.id, word.ayah_id)))?;
        push_unique(&mut surah_ids, word.surah);
        match ayahs.last_mut() {
            Some(current) if current.id == word.ayah_id => {
                current.last_word_id = word.id;
                current.ends_on_page |= word.is_end;
            }
            _ => {
                if ayahs.iter().any(|a| a.id == word.ayah_id) {
                    return Err(corrupt(format!("ayah {} is split", word.ayah_id)));
                }
                ayahs.push(PageAyah {
                    id: word.ayah_id,
                    surah: word.surah,
                    ayah: word.ayah,
                    juz: cols.juz,
                    hizb: cols.hizb,
                    rub: cols.rub,
                    sajda: sajda_kind(cols.sajda, word.ayah_id)?,
                    flags: cols.flags,
                    first_word_id: word.id,
                    last_word_id: word.id,
                    starts_on_page: word.position == 1,
                    ends_on_page: word.is_end,
                    line: line.line,
                });
            }
        }
        line.words.push(PageWord {
            id: word.id,
            ayah_id: word.ayah_id,
            surah: word.surah,
            ayah: word.ayah,
            position: word.position,
            is_end: word.is_end,
            glyph: word.glyph,
            text: word.text,
        });
    }
    if let Some(empty) = lines
        .iter()
        .find(|l| l.kind == LineKind::Ayah && l.words.is_empty())
    {
        return Err(corrupt(format!("ayah line {} has no words", empty.line)));
    }
    let (Some(first), Some(last)) = (ayahs.first(), ayahs.last()) else {
        return Err(corrupt("no ayah on the page".to_owned()));
    };
    let info = PageInfo {
        first_ayah_id: first.id,
        last_ayah_id: last.id,
        juz: first.juz,
        hizb: first.hizb,
        head_surah: first.surah,
        surah_ids,
    };
    Ok(PageData {
        layout: style.layout(),
        style,
        page,
        lines,
        ayahs,
        info,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{MushafLayout, SajdaKind};

    use super::super::mini_core;
    use super::*;
    use crate::CoreDb;

    fn header(line: u32, kind: i64, surah: u32) -> PageRow {
        PageRow {
            line,
            kind,
            centered: true,
            surah_id: Some(surah),
            word: None,
        }
    }

    fn word(line: u32, id: u32, ayah_id: u32, position: u32, is_end: bool) -> PageRow {
        PageRow {
            line,
            kind: 0,
            centered: false,
            surah_id: None,
            word: Some(WordRow {
                id,
                ayah_id,
                surah: if ayah_id <= 7 { 1 } else { 2 },
                ayah: if ayah_id <= 7 { ayah_id } else { ayah_id - 7 },
                position,
                is_end,
                glyph: format!("g{id}"),
                text: format!("t{id}"),
                ayah_row: Some(AyahCols {
                    juz: 1,
                    hizb: 1,
                    rub: if ayah_id <= 7 { 1 } else { 2 },
                    sajda: i64::from(ayah_id == 8),
                    flags: if ayah_id == 8 { 9 } else { 0 },
                }),
            }),
        }
    }

    /// Ayah 7 ends at the top of the page, surah 2 starts after its headers, ayah 9 continues on the next page.
    fn rows() -> Vec<PageRow> {
        vec![
            word(1, 10, 7, 3, false),
            word(1, 11, 7, 4, true),
            header(2, 1, 2),
            header(3, 2, 2),
            word(4, 12, 8, 1, false),
            word(4, 13, 8, 2, true),
            word(5, 14, 9, 1, false),
            word(5, 15, 9, 2, false),
        ]
    }

    #[test]
    fn assembles_lines_ayahs_and_info() {
        let page = assemble(MushafStyle::QcfV2, 7, rows()).unwrap();
        assert_eq!(page.layout, MushafLayout::V2);
        assert_eq!(page.style, MushafStyle::QcfV2);
        assert_eq!(page.page, 7);
        let shape: Vec<_> = page
            .lines
            .iter()
            .map(|l| (l.line, l.kind, l.surah, l.words.len()))
            .collect();
        assert_eq!(
            shape,
            vec![
                (1, LineKind::Ayah, None, 2),
                (2, LineKind::SurahName, Some(2), 0),
                (3, LineKind::Basmallah, Some(2), 0),
                (4, LineKind::Ayah, None, 2),
                (5, LineKind::Ayah, None, 2),
            ]
        );
        assert!(page.lines[1].centered && !page.lines[0].centered);
        assert_eq!(page.lines[0].words[0].glyph, "g10");
        assert_eq!(page.lines[0].words[0].text, "t10");
        let ayahs: Vec<_> = page
            .ayahs
            .iter()
            .map(|a| {
                (
                    a.id,
                    a.first_word_id,
                    a.last_word_id,
                    a.starts_on_page,
                    a.ends_on_page,
                    a.line,
                )
            })
            .collect();
        assert_eq!(
            ayahs,
            vec![
                (7, 10, 11, false, true, 1),
                (8, 12, 13, true, true, 4),
                (9, 14, 15, true, false, 5),
            ]
        );
        assert_eq!(page.ayahs[1].sajda, Some(SajdaKind::Recommended));
        assert_eq!(page.ayahs[1].flags, 9);
        assert_eq!(page.ayahs[1].rub, 2);
        assert_eq!(page.ayahs[0].sajda, None);
        assert_eq!(
            page.info,
            PageInfo {
                first_ayah_id: 7,
                last_ayah_id: 9,
                juz: 1,
                hizb: 1,
                head_surah: 1,
                surah_ids: vec![1, 2],
            }
        );
    }

    #[test]
    fn rejects_rows_that_break_the_invariants() {
        let corrupt = |rows: Vec<PageRow>| {
            let err = assemble(MushafStyle::Hafs, 9, rows).unwrap_err();
            assert!(matches!(err, CoreError::Corrupt(_)), "{err:?}");
            err.to_string()
        };
        let mut bad_kind = rows();
        bad_kind[2].kind = 5;
        assert!(corrupt(bad_kind).contains("kind 5"));
        let mut headless = rows();
        headless[2].surah_id = None;
        assert!(corrupt(headless).contains("no surah"));
        let mut backwards = rows();
        backwards.swap(0, 1);
        assert!(corrupt(backwards).contains("follows"));
        let mut orphan = rows();
        if let Some(w) = orphan[4].word.as_mut() {
            w.ayah_row = None;
        }
        assert!(corrupt(orphan).contains("no ayah row"));
        let mut split = rows();
        split.push(word(6, 16, 8, 3, false));
        assert!(corrupt(split).contains("split"));
        let mut wordy_header = rows();
        wordy_header.insert(
            3,
            PageRow {
                line: 2,
                ..word(2, 12, 8, 1, false)
            },
        );
        assert!(corrupt(wordy_header).contains("has words"));
        let empty_line = vec![
            PageRow {
                word: None,
                ..word(1, 1, 1, 1, false)
            },
            word(2, 2, 1, 1, false),
        ];
        assert!(corrupt(empty_line).contains("no words"));
        assert!(corrupt(vec![header(1, 1, 1)]).contains("no ayah"));
    }

    fn mini() -> (tempfile::TempDir, mini_core::MiniCore, CoreDb) {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let core = CoreDb::open(&mini.path).unwrap();
        (dir, mini, core)
    }

    #[test]
    fn every_mini_page_matches_the_model_in_every_style() {
        let (_dir, mini, core) = mini();
        for style in MushafStyle::ALL {
            let layout = mini.layout(style.layout().db_id());
            let pages = core.pages(style, &[1, 2, 3, 4]).unwrap();
            for (data, model) in pages.iter().zip(&layout.pages) {
                assert_eq!(data.page, model.page);
                assert_eq!(data.lines.len(), model.lines.len());
                for (line, m) in data.lines.iter().zip(&model.lines) {
                    assert_eq!(line.line, m.line);
                    assert_eq!(
                        line.centered, m.centered,
                        "page {} line {}",
                        model.page, m.line
                    );
                    assert_eq!(line.surah, m.surah_id);
                    let ids: Vec<u32> = line.words.iter().map(|w| w.id).collect();
                    let expected: Vec<u32> = match (m.first_word_id, m.last_word_id) {
                        (Some(a), Some(b)) => (a..=b).collect(),
                        _ => Vec::new(),
                    };
                    assert_eq!(ids, expected);
                    for w in &line.words {
                        let mw = mini.word(w.id);
                        let glyph = match style.glyph_selector() {
                            0 => &mw.text_hafs,
                            1 => &mw.code_v1,
                            _ => &mw.code_v2,
                        };
                        assert_eq!(&w.glyph, glyph);
                        assert_eq!(w.text, mw.text_hafs);
                        assert_eq!(
                            (w.ayah_id, w.position, w.is_end),
                            (mw.ayah_id, mw.position, mw.is_end)
                        );
                    }
                }
                assert_eq!(data.info.first_ayah_id, model.first_ayah_id);
                assert_eq!(data.info.last_ayah_id, model.last_ayah_id);
                let ayah_ids: Vec<u32> = data.ayahs.iter().map(|a| a.id).collect();
                let expected: Vec<u32> = (model.first_ayah_id..=model.last_ayah_id).collect();
                assert_eq!(ayah_ids, expected);
                for a in &data.ayahs {
                    let m = mini.ayah_by_id(a.id);
                    assert_eq!(
                        (a.juz, a.hizb, a.rub, a.flags),
                        (m.juz, m.hizb, m.rub, m.flags)
                    );
                    // Pages start at ayah starts (G10) and never split an ayah.
                    assert!(a.starts_on_page && a.ends_on_page);
                    assert_eq!(
                        (a.first_word_id, a.last_word_id),
                        (m.first_word_id, m.last_word_id)
                    );
                }
            }
        }
    }

    #[test]
    fn mini_page_four_has_two_surahs_and_a_sajda() {
        let (_dir, _mini, core) = mini();
        let page = &core.pages(MushafStyle::Hafs, &[4]).unwrap()[0];
        assert_eq!(page.info.surah_ids, vec![2, 3]);
        assert_eq!(page.info.head_surah, 2);
        assert_eq!(page.lines[7].kind, LineKind::SurahName);
        assert_eq!(page.lines[8].kind, LineKind::Basmallah);
        assert_eq!(page.lines[8].surah, Some(3));
        let last = page.ayahs.last().unwrap();
        assert_eq!(
            (last.surah, last.ayah, last.sajda),
            (3, 6, Some(SajdaKind::Obligatory))
        );
        let first_of_three = page.ayahs.iter().find(|a| a.surah == 3).unwrap();
        assert_eq!(first_of_three.line, 10);
        assert_eq!(first_of_three.flags & 8, 8, "surah start");
        assert!(page.lines[14].centered);
    }

    #[test]
    fn requested_order_and_duplicates_are_kept() {
        let (_dir, _mini, core) = mini();
        let pages = core.pages(MushafStyle::QcfV1, &[3, 1, 3]).unwrap();
        let numbers: Vec<u32> = pages.iter().map(|p| p.page).collect();
        assert_eq!(numbers, vec![3, 1, 3]);
        assert_eq!(pages[0], pages[2]);
        assert_eq!(pages[0].layout, MushafLayout::V1);
    }

    #[test]
    fn a_page_outside_the_layout_is_not_found() {
        let (_dir, _mini, core) = mini();
        let err = core.pages(MushafStyle::Hafs, &[1, 5]).unwrap_err();
        assert!(
            matches!(err, CoreError::NotFound(ref m) if m.contains("page 5")),
            "{err:?}"
        );
    }

    #[test]
    fn the_page_query_uses_the_required_plan() {
        let (_dir, _mini, core) = mini();
        let conn = core.conn().unwrap();
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {PAGE_SQL}"))
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map((1, 3, 2), |r| r.get(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for step in [
            "SEARCH l USING PRIMARY KEY (mushaf_id=? AND page=?)",
            "SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)",
            "SEARCH a USING INTEGER PRIMARY KEY (rowid=?)",
        ] {
            assert!(
                plan.iter()
                    .any(|p| p.strip_suffix(" LEFT-JOIN").unwrap_or(p) == step),
                "missing {step:?} in {plan:#?}"
            );
        }
    }
}
