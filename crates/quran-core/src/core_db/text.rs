//! Ayah rows for translation mode, copy text, page-of-ayah and word lookups (§3.1.4, §5.5). Owner: WP1a.
//!
//! **Copy text format** (§5.5; the TS port `src/lib/mushaf/copy.ts` passes the same golden file,
//! `tests/data/copy_vectors.json`):
//! - the non-end words' `text_hafs` joined by U+0020 (a word is copied whole, so the space inside `"وَأَنَابَ ۩"` is kept
//!   and never doubled);
//! - each end marker becomes ` ﴿N﴾` (U+FD3F, Arabic-Indic digits, U+FD3E) when `ayah_numbers`, otherwise it is dropped;
//! - then `\n{reference}` when `include_reference`:
//!
//!   | style | one ayah | range in one surah | range across surahs |
//!   |---|---|---|---|
//!   | `short` | `(2:255)` | `(2:255–257)` | `(1:7–2:2)` |
//!   | `long` | `— Al-Baqarah 2:255` | `— Al-Baqarah 2:255–257` | `— Al-Fatihah 1:7 – Al-Baqarah 2:2` |
//!   | `arabic` | `[البقرة: ٢٥٥]` | `[البقرة: ٢٥٥–٢٥٧]` | `[الفاتحة: ٧ – البقرة: ٢]` |
//!
//!   (`–` is U+2013, `—` U+2014; `long` uses `surah.name_simple`, `arabic` uses `surah.name_ar`.)
//! - The translation part (`\n\n{plain text}`) is appended by the `quran_copy_text` command, which owns pack access.

use quran_types::{AyahText, CopyOptions, MushafLayout, ReferenceStyle};
use rusqlite::{Connection, OptionalExtension};

use super::sajda_kind;
use crate::{CoreError, Result};

const AYAHS_SQL: &str =
    "SELECT a.id, a.surah, a.ayah, a.juz, a.hizb, a.rub, a.sajda, a.flags, a.text_hafs,
       (SELECT p.page FROM page p WHERE p.mushaf_id = ?1 AND p.first_word_id <= a.first_word_id
        ORDER BY p.first_word_id DESC LIMIT 1) AS page
FROM ayah a WHERE a.id BETWEEN ?2 AND ?3 ORDER BY a.id";

/// Ornate parentheses around an ayah number in copied text, exactly as §5.5 spells ` ﴿N﴾`.
const AYAH_NUMBER_OPEN: char = '\u{FD3F}';
const AYAH_NUMBER_CLOSE: char = '\u{FD3E}';

pub(super) fn ayahs(
    conn: &Connection,
    layout: MushafLayout,
    from: u32,
    to: u32,
) -> Result<Vec<AyahText>> {
    let mut stmt = conn.prepare_cached(AYAHS_SQL)?;
    let rows = stmt
        .query_map((layout.db_id(), from, to), |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, u32>(2)?,
                r.get::<_, u32>(3)?,
                r.get::<_, u32>(4)?,
                r.get::<_, u32>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, u32>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<u32>>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(id, surah, ayah, juz, hizb, rub, sajda, flags, text_hafs, page)| {
                let page = page.ok_or_else(|| {
                    CoreError::Corrupt(format!("ayah {id} lies on no page of {layout:?}"))
                })?;
                Ok(AyahText {
                    id,
                    surah,
                    ayah,
                    juz,
                    hizb,
                    rub,
                    sajda: sajda_kind(sajda, id)?,
                    flags,
                    page,
                    text_hafs,
                })
            },
        )
        .collect()
}

pub(super) fn word_range_of_ayah(conn: &Connection, ayah_id: u32) -> Result<(u32, u32)> {
    conn.prepare_cached("SELECT first_word_id, last_word_id FROM ayah WHERE id = ?1")?
        .query_row([ayah_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("ayah {ayah_id}")))
}

pub(super) fn page_of_ayah(conn: &Connection, layout: MushafLayout, ayah_id: u32) -> Result<u32> {
    let (first_word, _) = word_range_of_ayah(conn, ayah_id)?;
    conn.prepare_cached(
        "SELECT page FROM page WHERE mushaf_id = ?1 AND first_word_id <= ?2 ORDER BY first_word_id DESC LIMIT 1",
    )?
    .query_row((layout.db_id(), first_word), |r| r.get(0))
    .optional()?
    .ok_or_else(|| CoreError::Corrupt(format!("ayah {ayah_id} lies on no page of {layout:?}")))
}

/// Maps locations through `ayah`'s `UNIQUE(surah, ayah)` index: word ids are contiguous per ayah with positions
/// `1..=n` (G2), so `id = first_word_id + position − 1` when `position ≤ n`. Consecutive locations of one ayah reuse
/// the lookup.
pub(super) fn word_ids_by_location(
    conn: &Connection,
    locs: &[(u32, u32, u32)],
) -> Result<Vec<Option<u32>>> {
    let mut stmt = conn.prepare_cached(
        "SELECT first_word_id, last_word_id FROM ayah WHERE surah = ?1 AND ayah = ?2",
    )?;
    // The last `(surah, ayah)` looked up and its `(first_word_id, last_word_id)`, if it exists.
    type Lookup = ((u32, u32), Option<(u32, u32)>);
    let mut cached: Option<Lookup> = None;
    let mut out = Vec::with_capacity(locs.len());
    for &(surah, ayah, position) in locs {
        let range = match cached {
            Some((key, range)) if key == (surah, ayah) => range,
            _ => {
                let range = stmt
                    .query_row((surah, ayah), |r| {
                        Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?))
                    })
                    .optional()?;
                cached = Some(((surah, ayah), range));
                range
            }
        };
        out.push(range.and_then(|(first, last)| {
            let id = first.checked_add(position.checked_sub(1)?)?;
            (id <= last).then_some(id)
        }));
    }
    Ok(out)
}

/// One end of a copy range, for the reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RefPoint {
    pub surah: u32,
    pub ayah: u32,
    pub name_simple: String,
    pub name_ar: String,
}

fn ref_point(conn: &Connection, ayah_id: u32) -> Result<RefPoint> {
    conn.prepare_cached(
        "SELECT a.surah, a.ayah, s.name_simple, s.name_ar FROM ayah a JOIN surah s ON s.id = a.surah WHERE a.id = ?1",
    )?
    .query_row([ayah_id], |r| {
        Ok(RefPoint {
            surah: r.get(0)?,
            ayah: r.get(1)?,
            name_simple: r.get(2)?,
            name_ar: r.get(3)?,
        })
    })
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("ayah {ayah_id}")))
}

pub(super) fn copy_text(
    conn: &Connection,
    from: u32,
    to: u32,
    opts: &CopyOptions,
) -> Result<String> {
    let (first_word, _) = word_range_of_ayah(conn, from)?;
    let (_, last_word) = word_range_of_ayah(conn, to)?;
    let mut copy = CopyText::new(opts.ayah_numbers);
    {
        let mut stmt = conn.prepare_cached(
            "SELECT ayah, is_end, text_hafs FROM word WHERE id BETWEEN ?1 AND ?2 ORDER BY id",
        )?;
        let mut rows = stmt.query((first_word, last_word))?;
        while let Some(row) = rows.next()? {
            let ayah: u32 = row.get(0)?;
            if row.get::<_, bool>(1)? {
                copy.end_marker(ayah);
            } else {
                let text = row.get_ref(2)?.as_str().map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                copy.word(text);
            }
        }
    }
    let mut text = copy.finish();
    if opts.include_reference {
        let reference = reference(
            opts.reference_style,
            &ref_point(conn, from)?,
            &ref_point(conn, to)?,
        );
        text.push('\n');
        text.push_str(&reference);
    }
    Ok(text)
}

/// Builds the Arabic part of a copy, token by token (§5.5).
#[derive(Debug, Default)]
pub(crate) struct CopyText {
    out: String,
    ayah_numbers: bool,
}

impl CopyText {
    pub(crate) fn new(ayah_numbers: bool) -> Self {
        Self {
            out: String::new(),
            ayah_numbers,
        }
    }

    fn separate(&mut self) {
        if !self.out.is_empty() {
            self.out.push(' ');
        }
    }

    /// A non-end word, copied whole.
    pub(crate) fn word(&mut self, text_hafs: &str) {
        self.separate();
        self.out.push_str(text_hafs);
    }

    /// The end marker of ayah number `ayah`: ` ﴿N﴾` or nothing.
    pub(crate) fn end_marker(&mut self, ayah: u32) {
        if self.ayah_numbers {
            self.separate();
            self.out.push(AYAH_NUMBER_OPEN);
            self.out.push_str(&arabic_indic(ayah));
            self.out.push(AYAH_NUMBER_CLOSE);
        }
    }

    pub(crate) fn finish(self) -> String {
        self.out
    }
}

/// `n` in Arabic-Indic digits (U+0660–U+0669): Mushaf furniture always uses them (§11.2).
pub(crate) fn arabic_indic(n: u32) -> String {
    n.to_string()
        .chars()
        .map(
            |c| match c.to_digit(10).and_then(|d| char::from_u32(0x0660 + d)) {
                Some(digit) => digit,
                None => c,
            },
        )
        .collect()
}

/// The reference line of a copy (§5.5; table in the module docs).
pub(crate) fn reference(style: ReferenceStyle, from: &RefPoint, to: &RefPoint) -> String {
    let same_surah = from.surah == to.surah;
    let single = same_surah && from.ayah == to.ayah;
    match style {
        ReferenceStyle::Short => {
            if single {
                format!("({}:{})", from.surah, from.ayah)
            } else if same_surah {
                format!("({}:{}–{})", from.surah, from.ayah, to.ayah)
            } else {
                format!("({}:{}–{}:{})", from.surah, from.ayah, to.surah, to.ayah)
            }
        }
        ReferenceStyle::Long => {
            if single {
                format!("— {} {}:{}", from.name_simple, from.surah, from.ayah)
            } else if same_surah {
                format!(
                    "— {} {}:{}–{}",
                    from.name_simple, from.surah, from.ayah, to.ayah
                )
            } else {
                format!(
                    "— {} {}:{} – {} {}:{}",
                    from.name_simple, from.surah, from.ayah, to.name_simple, to.surah, to.ayah
                )
            }
        }
        ReferenceStyle::Arabic => {
            let (a, b) = (arabic_indic(from.ayah), arabic_indic(to.ayah));
            if single {
                format!("[{}: {a}]", from.name_ar)
            } else if same_surah {
                format!("[{}: {a}–{b}]", from.name_ar)
            } else {
                format!("[{}: {a} – {}: {b}]", from.name_ar, to.name_ar)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{MushafLayout, SajdaKind};
    use serde::Deserialize;

    use super::super::mini_core;
    use super::*;
    use crate::CoreDb;

    fn point(surah: u32, ayah: u32, simple: &str, ar: &str) -> RefPoint {
        RefPoint {
            surah,
            ayah,
            name_simple: simple.to_owned(),
            name_ar: ar.to_owned(),
        }
    }

    #[test]
    fn references_follow_the_spec_examples() {
        let b255 = point(2, 255, "Al-Baqarah", "البقرة");
        let b257 = point(2, 257, "Al-Baqarah", "البقرة");
        let f7 = point(1, 7, "Al-Fatihah", "الفاتحة");
        let b2 = point(2, 2, "Al-Baqarah", "البقرة");
        use ReferenceStyle::{Arabic, Long, Short};
        assert_eq!(reference(Short, &b255, &b255), "(2:255)");
        assert_eq!(reference(Long, &b255, &b255), "— Al-Baqarah 2:255");
        assert_eq!(reference(Arabic, &b255, &b255), "[البقرة: ٢٥٥]");
        assert_eq!(reference(Short, &b255, &b257), "(2:255–257)");
        assert_eq!(reference(Long, &b255, &b257), "— Al-Baqarah 2:255–257");
        assert_eq!(reference(Arabic, &b255, &b257), "[البقرة: ٢٥٥–٢٥٧]");
        assert_eq!(reference(Short, &f7, &b2), "(1:7–2:2)");
        assert_eq!(
            reference(Long, &f7, &b2),
            "— Al-Fatihah 1:7 – Al-Baqarah 2:2"
        );
        assert_eq!(reference(Arabic, &f7, &b2), "[الفاتحة: ٧ – البقرة: ٢]");
    }

    #[test]
    fn digits_are_arabic_indic() {
        assert_eq!(arabic_indic(0), "٠");
        assert_eq!(arabic_indic(255), "٢٥٥");
        assert_eq!(arabic_indic(6236), "٦٢٣٦");
    }

    #[test]
    fn copy_tokens_join_with_single_spaces() {
        let mut with = CopyText::new(true);
        let mut without = CopyText::new(false);
        for copy in [&mut with, &mut without] {
            copy.word("وَأَنَابَ ۩");
            copy.end_marker(24);
            copy.word("فَغَفَرۡنَا");
            copy.end_marker(25);
        }
        assert_eq!(with.finish(), "وَأَنَابَ ۩ ﴿٢٤﴾ فَغَفَرۡنَا ﴿٢٥﴾");
        assert_eq!(without.finish(), "وَأَنَابَ ۩ فَغَفَرۡنَا");
        assert_eq!(CopyText::new(true).finish(), "");
    }

    /// `tests/data/copy_vectors.json` (§12.3), shared with vitest.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(crate) struct Vectors {
        pub description: String,
        pub surahs: std::collections::BTreeMap<String, VectorSurah>,
        pub cases: Vec<VectorCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(crate) struct VectorSurah {
        pub name_simple: String,
        pub name_ar: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(crate) struct VectorCase {
        pub name: String,
        pub from_ayah_id: u32,
        pub to_ayah_id: u32,
        pub options: CopyOptions,
        pub words: Vec<quran_types::PageWord>,
        pub reference: String,
        pub expected: String,
    }

    pub(crate) fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../../tests/data/copy_vectors.json")).unwrap()
    }

    /// The golden file is consistent with this formatter (the real-DB test, `tests/core_text.rs`, proves the words and
    /// the expected text against core.db).
    #[test]
    fn copy_vectors_are_reproduced_from_their_words() {
        let vectors = vectors();
        assert!(!vectors.description.is_empty());
        assert!(vectors.cases.len() >= 6);
        for case in &vectors.cases {
            let mut copy = CopyText::new(case.options.ayah_numbers);
            for w in &case.words {
                if w.is_end {
                    copy.end_marker(w.ayah);
                } else {
                    copy.word(&w.text);
                }
            }
            let mut text = copy.finish();
            let first = case.words.first().unwrap();
            let last = case.words.last().unwrap();
            assert_eq!(
                (first.ayah_id, last.ayah_id),
                (case.from_ayah_id, case.to_ayah_id),
                "{}",
                case.name
            );
            assert!(
                first.position == 1 && last.is_end,
                "{}: whole ayahs",
                case.name
            );
            let name = |s: u32| &vectors.surahs[&s.to_string()];
            let point = |w: &quran_types::PageWord| {
                point(
                    w.surah,
                    w.ayah,
                    &name(w.surah).name_simple,
                    &name(w.surah).name_ar,
                )
            };
            let label = reference(case.options.reference_style, &point(first), &point(last));
            if case.options.include_reference {
                assert_eq!(label, case.reference, "{}", case.name);
                text.push('\n');
                text.push_str(&label);
            }
            assert_eq!(text, case.expected, "{}", case.name);
            for w in &case.words {
                assert_eq!(w.glyph, w.text, "{}: hafs-style words", case.name);
            }
        }
        // §5.5: the two sajda words with "space + ۩" are covered, and their space survives exactly once.
        for (surah, ayah) in [(38, 24), (22, 77)] {
            let case = vectors
                .cases
                .iter()
                .find(|c| c.words.iter().any(|w| (w.surah, w.ayah) == (surah, ayah)))
                .unwrap_or_else(|| panic!("no vector covers {surah}:{ayah}"));
            let sajda = case
                .words
                .iter()
                .find(|w| (w.surah, w.ayah) == (surah, ayah) && w.text.contains(" \u{06E9}"))
                .unwrap();
            assert!(case.expected.contains(&sajda.text));
            assert!(!case.expected.contains("  "));
        }
    }

    fn mini() -> (tempfile::TempDir, mini_core::MiniCore, CoreDb) {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let core = CoreDb::open(&mini.path).unwrap();
        (dir, mini, core)
    }

    #[test]
    fn ayah_rows_carry_layout_pages() {
        let (_dir, mini, core) = mini();
        for layout in MushafLayout::ALL {
            let rows = core.ayahs(layout, 1, 38).unwrap();
            assert_eq!(rows.len(), 38);
            for row in &rows {
                let m = mini.ayah_by_id(row.id);
                assert_eq!((row.surah, row.ayah, row.flags), (m.surah, m.ayah, m.flags));
                assert_eq!(row.text_hafs, m.text_hafs);
                assert_eq!(row.page, mini.page_of_word(layout.db_id(), m.first_word_id));
            }
        }
        let v1 = core.ayahs(MushafLayout::V1, 12, 12).unwrap();
        let v2 = core.ayahs(MushafLayout::V2, 12, 12).unwrap();
        assert_eq!(
            (v1[0].page, v2[0].page),
            (3, 2),
            "2:5 is on page 3 in v1, page 2 in v2"
        );
        let sajda = core.ayahs(MushafLayout::V2, 27, 27).unwrap();
        assert_eq!(sajda[0].sajda, Some(SajdaKind::Recommended));
        assert!(sajda[0].text_hafs.contains("وَأَنَابَ ۩ \u{06DD}٢٠"));
        // Ids past the end of the (mini) data simply yield no rows.
        assert!(core.ayahs(MushafLayout::V2, 39, 40).unwrap().is_empty());
    }

    #[test]
    fn page_and_word_lookups() {
        let (_dir, mini, core) = mini();
        for a in &mini.ayahs {
            assert_eq!(
                core.word_range_of_ayah(a.id).unwrap(),
                (a.first_word_id, a.last_word_id)
            );
            for layout in MushafLayout::ALL {
                assert_eq!(
                    core.page_of_ayah(layout, a.id).unwrap(),
                    mini.page_of_word(layout.db_id(), a.first_word_id)
                );
            }
        }
        assert!(matches!(
            core.word_range_of_ayah(39),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            core.page_of_ayah(MushafLayout::V4, 39),
            Err(CoreError::NotFound(_))
        ));
        let locs: Vec<(u32, u32, u32)> = mini
            .words
            .iter()
            .map(|w| (w.surah, w.ayah, w.position))
            .collect();
        let ids = core.word_ids_by_location(&locs).unwrap();
        let expected: Vec<Option<u32>> = mini.words.iter().map(|w| Some(w.id)).collect();
        assert_eq!(ids, expected);
        let end_of_1_1 = mini.ayah(1, 1).last_word_id;
        assert_eq!(
            core.word_ids_by_location(&[
                (1, 1, 0),
                (1, 1, 5),
                (1, 1, 6),
                (1, 8, 1),
                (4, 1, 1),
                (1, 1, u32::MAX)
            ])
            .unwrap(),
            vec![None, Some(end_of_1_1), None, None, None, None]
        );
    }

    #[test]
    fn copy_text_on_the_mini_core() {
        let (_dir, mini, core) = mini();
        let opts = |numbers, reference: Option<ReferenceStyle>| CopyOptions {
            include_reference: reference.is_some(),
            reference_style: reference.unwrap_or(ReferenceStyle::Short),
            ayah_numbers: numbers,
            translation_pack_id: Some("ignored.here".into()),
        };
        assert_eq!(
            core.copy_text(1, 1, &opts(true, Some(ReferenceStyle::Short)))
                .unwrap(),
            "بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ ﴿١﴾\n(1:1)"
        );
        assert_eq!(
            core.copy_text(1, 1, &opts(false, None)).unwrap(),
            "بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ"
        );
        // 2:20 holds the spaced sajda word; copying it keeps exactly one space before ۩.
        let sajda = core
            .copy_text(27, 27, &opts(true, Some(ReferenceStyle::Arabic)))
            .unwrap();
        assert!(sajda.ends_with("وَأَنَابَ ۩ ﴿٢٠﴾\n[البقرة: ٢٠]"), "{sajda}");
        // Across surahs: whole range, markers in order, long reference.
        let cross = core
            .copy_text(7, 9, &opts(true, Some(ReferenceStyle::Long)))
            .unwrap();
        let (arabic, reference) = cross.split_once('\n').unwrap();
        assert_eq!(reference, "— Al-Fatihah 1:7 – Al-Baqarah 2:2");
        let markers: Vec<&str> = arabic
            .split(' ')
            .filter(|t| t.starts_with('\u{FD3F}'))
            .collect();
        assert_eq!(markers, vec!["﴿٧﴾", "﴿١﴾", "﴿٢﴾"]);
        let non_end_words: u32 = (7..=9)
            .map(|id| {
                let a = mini.ayah_by_id(id);
                a.last_word_id - a.first_word_id
            })
            .sum();
        let tokens = u32::try_from(arabic.split(' ').count()).unwrap();
        assert_eq!(tokens, non_end_words + 3);
        // The whole mini Quran in one call.
        let all = core.copy_text(1, 38, &opts(false, None)).unwrap();
        assert!(!all.contains("  ") && !all.contains('\u{06DD}'));
    }
}
