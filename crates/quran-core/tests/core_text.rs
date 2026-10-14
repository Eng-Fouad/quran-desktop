//! Ayah rows, copy text (`tests/data/copy_vectors.json`), page-of-ayah and word lookups on the mini core and on a real
//! core.db.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::collections::BTreeMap;

use quran_core::{CoreDb, CoreError};
use quran_types::{CopyOptions, MushafLayout, MushafStyle, PageWord, ReferenceStyle};
use serde::Deserialize;
use support::mini_core;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vectors {
    description: String,
    surahs: BTreeMap<String, VectorSurah>,
    cases: Vec<VectorCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VectorSurah {
    name_simple: String,
    name_ar: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VectorCase {
    name: String,
    from_ayah_id: u32,
    to_ayah_id: u32,
    options: CopyOptions,
    words: Vec<PageWord>,
    reference: String,
    expected: String,
}

fn options(numbers: bool, reference: Option<ReferenceStyle>) -> CopyOptions {
    CopyOptions {
        include_reference: reference.is_some(),
        reference_style: reference.unwrap_or(ReferenceStyle::Short),
        ayah_numbers: numbers,
        translation_pack_id: None,
    }
}

#[test]
fn copy_and_lookups_on_the_mini_core() {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let core = CoreDb::open(&mini.path).unwrap();
    // 2:20 holds "وَأَنَابَ ۩" (space + ۩ inside one word): copied whole, the space kept once.
    let text = core
        .copy_text(26, 27, &options(true, Some(ReferenceStyle::Long)))
        .unwrap();
    assert!(
        text.contains("وَأَنَابَ ۩ ﴿٢٠﴾\n— Al-Baqarah 2:19–20"),
        "{text}"
    );
    assert!(!text.contains("  "));
    // 3:6 has ۩ attached; the arabic reference uses Arabic-Indic digits.
    let text = core
        .copy_text(38, 38, &options(false, Some(ReferenceStyle::Arabic)))
        .unwrap();
    assert!(text.ends_with("يَسۡجُدُونَ۩\n[آل عمران: ٦]"), "{text}");
    // Word ids by location round-trip for every word, in every order.
    let mut locs: Vec<(u32, u32, u32)> = mini
        .words
        .iter()
        .map(|w| (w.surah, w.ayah, w.position))
        .collect();
    locs.reverse();
    let ids = core.word_ids_by_location(&locs).unwrap();
    assert!(
        ids.iter()
            .rev()
            .enumerate()
            .all(|(i, id)| *id == Some(u32::try_from(i).unwrap() + 1))
    );
    assert!(matches!(
        core.word_range_of_ayah(39),
        Err(CoreError::NotFound(_))
    ));
}

#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn copy_vectors_hold_on_the_real_core() {
    let core = CoreDb::open(&support::real_core_db()).unwrap();
    let vectors: Vectors = support::golden("copy_vectors.json");
    assert!(!vectors.description.is_empty());
    let index = core.index().unwrap();
    for (id, names) in &vectors.surahs {
        let surah = &index.surahs[id.parse::<usize>().unwrap() - 1];
        assert_eq!(
            (&surah.name_simple, &surah.name_ar),
            (&names.name_simple, &names.name_ar),
            "surah {id}"
        );
    }
    for case in &vectors.cases {
        // The Arabic part as the command produces it (translations are not part of the vectors).
        let text = core
            .copy_text(case.from_ayah_id, case.to_ayah_id, &case.options)
            .unwrap();
        assert_eq!(text, case.expected, "{}", case.name);
        if case.options.include_reference {
            assert!(
                text.ends_with(&format!("\n{}", case.reference)),
                "{}",
                case.name
            );
        }
        // The vector's words are exactly the hafs-style page words of the range.
        let (first, _) = core.word_range_of_ayah(case.from_ayah_id).unwrap();
        let (_, last) = core.word_range_of_ayah(case.to_ayah_id).unwrap();
        let pages: Vec<u32> = (case.from_ayah_id..=case.to_ayah_id)
            .map(|a| core.page_of_ayah(MushafLayout::V2, a).unwrap())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let words: Vec<PageWord> = pages
            .chunks(8)
            .flat_map(|chunk| core.pages(MushafStyle::Hafs, chunk).unwrap())
            .flat_map(|p| p.lines.into_iter().flat_map(|l| l.words))
            .filter(|w| (first..=last).contains(&w.id))
            .collect();
        assert_eq!(words, case.words, "{}", case.name);
    }
}

#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn ayah_rows_and_lookups_on_the_real_core() {
    let core = CoreDb::open(&support::real_core_db()).unwrap();
    let index = core.index().unwrap();
    for layout in MushafLayout::ALL {
        let info = index.layouts.iter().find(|l| l.layout == layout).unwrap();
        let mut count = 0;
        for i in 0..21 {
            let from = i * 300 + 1;
            let to = (from + 299).min(6236);
            for row in core.ayahs(layout, from, to).unwrap() {
                count += 1;
                // The page is the last page that starts at or before the ayah's first word.
                let first_word = index.ayah_first_word[usize::try_from(row.id - 1).unwrap()];
                let page = info
                    .page_first_word
                    .iter()
                    .rposition(|&w| w <= first_word)
                    .unwrap()
                    + 1;
                assert_eq!(
                    usize::try_from(row.page).unwrap(),
                    page,
                    "{layout:?} ayah {}",
                    row.id
                );
                assert!(
                    row.text_hafs
                        .ends_with(&format!("\u{06DD}{}", arabic(row.ayah))),
                    "ayah {}",
                    row.id
                );
                if layout == MushafLayout::V2 && row.id % 97 == 0 {
                    assert_eq!(core.page_of_ayah(layout, row.id).unwrap(), row.page);
                }
            }
        }
        assert_eq!(count, 6236);
    }
    // 38:24 (id 3994) keeps "وَأَنَابَ ۩" as one word inside text_hafs.
    let row = &core.ayahs(MushafLayout::V2, 3994, 3994).unwrap()[0];
    assert_eq!((row.surah, row.ayah), (38, 24));
    assert!(
        row.text_hafs.contains("وَأَنَابَ ۩ \u{06DD}٢٤"),
        "{}",
        row.text_hafs
    );
    // Word ranges agree with the index; locations map back to ids.
    let mut locs = Vec::new();
    let mut expected = Vec::new();
    for ayah in [1, 7, 8, 262, 2672, 3994, 6236] {
        let (first, last) = core.word_range_of_ayah(ayah).unwrap();
        assert_eq!(
            first,
            index.ayah_first_word[usize::try_from(ayah - 1).unwrap()]
        );
        let page = core
            .pages(
                MushafStyle::Hafs,
                &[core.page_of_ayah(MushafLayout::V2, ayah).unwrap()],
            )
            .unwrap();
        for w in page[0]
            .lines
            .iter()
            .flat_map(|l| &l.words)
            .filter(|w| (first..=last).contains(&w.id))
        {
            locs.push((w.surah, w.ayah, w.position));
            expected.push(Some(w.id));
        }
    }
    locs.push((114, 6, 99));
    expected.push(None);
    locs.push((115, 1, 1));
    expected.push(None);
    assert_eq!(core.word_ids_by_location(&locs).unwrap(), expected);
    // The whole Quran copies in one call (at most 6236 ayahs).
    let all = core
        .copy_text(1, 6236, &options(false, Some(ReferenceStyle::Short)))
        .unwrap();
    assert!(all.ends_with("\n(1:1–114:6)"));
    assert!(!all.contains('\u{06DD}') && !all.contains("  "));
}

fn arabic(n: u32) -> String {
    n.to_string()
        .chars()
        .map(|c| char::from_u32(0x0660 + c.to_digit(10).unwrap()).unwrap())
        .collect()
}
