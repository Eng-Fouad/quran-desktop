//! `CoreDb::index` (the `QuranIndex` behind `app_bootstrap`) on the mini core and on a real core.db.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use quran_core::CoreDb;
use quran_types::{Division, MushafLayout, QuranIndex, RevelationPlace, SajdaKind};
use support::mini_core;

/// The divisions partition `1..=last` in order, without gaps or overlaps.
fn assert_partition(name: &str, divisions: &[Division], count: usize, last: u32) {
    assert_eq!(divisions.len(), count, "{name}");
    let mut next = 1;
    for (i, d) in divisions.iter().enumerate() {
        assert_eq!(d.id, u32::try_from(i).unwrap() + 1, "{name}");
        assert_eq!(d.first_ayah_id, next, "{name} {}", d.id);
        assert!(d.last_ayah_id >= d.first_ayah_id, "{name} {}", d.id);
        next = d.last_ayah_id + 1;
    }
    assert_eq!(next, last + 1, "{name} ends at the last ayah");
}

#[test]
fn the_mini_index_is_consistent_and_camel_case() {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let index = CoreDb::open(&mini.path).unwrap().index().unwrap();
    assert_partition("juz", &index.juz, 2, 38);
    assert_partition("hizb", &index.hizb, 4, 38);
    assert_partition("rub", &index.rub, 16, 38);
    assert_partition("manzil", &index.manzil, 1, 38);
    assert_eq!(index.ayah_first_word.len(), 38);
    let json = serde_json::to_value(&index).unwrap();
    for key in [
        "surahs",
        "juz",
        "hizb",
        "rub",
        "manzil",
        "sajdas",
        "layouts",
        "ayahFirstWord",
    ] {
        assert!(json.get(key).is_some(), "{key}");
    }
    let layout = &json["layouts"][0];
    assert_eq!(layout["layout"], "v2");
    assert!(layout.get("pageFirstAyah").is_some() && layout.get("pageFirstWord").is_some());
    assert_eq!(json["surahs"][0]["headerCp"], 0xFC45);
    assert_eq!(json["surahs"][2]["headerCp"], serde_json::Value::Null);
    assert_eq!(json["sajdas"][1]["kind"], "obligatory");
    let back: QuranIndex = serde_json::from_value(json).unwrap();
    assert_eq!(back, index);
}

#[test]
#[ignore = "needs a real core.db: QD_CORE_DB=src-tauri/resources/core.db"]
fn the_real_index() {
    let core = CoreDb::open(&support::real_core_db()).unwrap();
    assert_eq!(core.meta().schema_version, quran_core::CORE_SCHEMA_VERSION);
    assert_eq!(
        core.meta().normalizer_version,
        quran_core::NORMALIZER_VERSION
    );
    assert!(
        ["qdc", "qul"].contains(&core.meta().source.as_str()),
        "{}",
        core.meta().source
    );
    assert_eq!(core.meta().word_count, 83_665);
    let index = core.index().unwrap();

    // Surahs.
    assert_eq!(index.surahs.len(), 114);
    let mut first_ayah = 1;
    for (i, s) in index.surahs.iter().enumerate() {
        assert_eq!(s.id, u32::try_from(i).unwrap() + 1);
        assert_eq!(s.first_ayah_id, first_ayah, "surah {}", s.id);
        first_ayah += s.ayah_count;
        assert_eq!(s.bismillah_pre, s.id != 1 && s.id != 9, "surah {}", s.id);
        assert!(s.header_cp.is_some(), "G16: surah {}", s.id);
        assert!(!s.name_ar.is_empty() && !s.name_simple.is_empty() && !s.name_en.is_empty());
    }
    assert_eq!(first_ayah, 6237);
    let fatihah = &index.surahs[0];
    assert_eq!(
        (
            fatihah.name_simple.as_str(),
            fatihah.name_ar.as_str(),
            fatihah.ayah_count,
            fatihah.revelation_place
        ),
        ("Al-Fatihah", "الفاتحة", 7, RevelationPlace::Makkah)
    );
    assert_eq!(fatihah.header_cp, Some(0xFC45));
    assert_eq!(index.surahs[113].header_cp, Some(0xFBEB));
    let baqarah = &index.surahs[1];
    assert_eq!(
        (
            baqarah.name_simple.as_str(),
            baqarah.name_ar.as_str(),
            baqarah.ayah_count,
            baqarah.revelation_place
        ),
        ("Al-Baqarah", "البقرة", 286, RevelationPlace::Madinah)
    );

    // Divisions (G11).
    assert_partition("juz", &index.juz, 30, 6236);
    assert_partition("hizb", &index.hizb, 60, 6236);
    assert_partition("rub", &index.rub, 240, 6236);
    assert_partition("manzil", &index.manzil, 7, 6236);
    assert_eq!(
        index.rub[105].first_ayah_id, 1851,
        "rub 106 starts at 15:49 in the mushaf source"
    );
    for (h, hizb) in index.hizb.iter().enumerate() {
        assert_eq!(
            hizb.first_ayah_id,
            index.rub[h * 4].first_ayah_id,
            "hizb {} = rub {}",
            hizb.id,
            h * 4 + 1
        );
    }
    for (j, juz) in index.juz.iter().enumerate() {
        assert_eq!(
            juz.first_ayah_id,
            index.hizb[j * 2].first_ayah_id,
            "juz {}",
            juz.id
        );
    }
    assert_eq!(index.sajdas.len(), 15);
    let obligatory: Vec<u32> = index
        .sajdas
        .iter()
        .filter(|s| s.kind == SajdaKind::Obligatory)
        .map(|s| s.ayah_id)
        .collect();
    assert_eq!(
        obligatory,
        vec![3518, 4256, 4846, 6125],
        "32:15, 41:38, 53:62, 96:19"
    );
    for ayah in [2672, 3994] {
        assert!(
            index.sajdas.iter().any(|s| s.ayah_id == ayah),
            "22:77 and 38:24 are sajdas"
        );
    }

    // Layouts (G6, G10).
    let order: Vec<MushafLayout> = index.layouts.iter().map(|l| l.layout).collect();
    assert_eq!(order, MushafLayout::ALL.to_vec());
    for l in &index.layouts {
        assert_eq!((l.pages, l.lines_per_page), (604, 15), "{:?}", l.layout);
        assert_eq!(
            (l.page_first_ayah.len(), l.page_first_word.len()),
            (604, 604)
        );
        assert_eq!((l.page_first_ayah[0], l.page_first_word[0]), (1, 1));
        assert_eq!(
            l.page_first_ayah[1], 8,
            "{:?}: page 2 starts at 2:1",
            l.layout
        );
        assert!(l.page_first_word.windows(2).all(|w| w[0] < w[1]));
        assert!(l.page_first_ayah.windows(2).all(|w| w[0] < w[1]));
        for (p, &ayah) in l.page_first_ayah.iter().enumerate() {
            assert_eq!(
                index.ayah_first_word[usize::try_from(ayah - 1).unwrap()],
                l.page_first_word[p],
                "G10"
            );
        }
    }
    let (v2, v1, v4) = (&index.layouts[0], &index.layouts[1], &index.layouts[2]);
    let differing: Vec<u32> = (1..=604u32)
        .filter(|&p| {
            v1.page_first_word[usize::try_from(p - 1).unwrap()]
                != v2.page_first_word[usize::try_from(p - 1).unwrap()]
        })
        .collect();
    let mut expected = vec![
        121, 122, 123, 145, 532, 533, 534, 565, 568, 570, 576, 584, 586, 588, 589, 590,
    ];
    expected.extend(592..=600);
    assert_eq!(
        differing, expected,
        "G10: v1/v2 page starts differ on exactly 25 pages"
    );
    assert_eq!(
        v4.page_first_word, v2.page_first_word,
        "G10: v4 page starts == v2"
    );

    // Ayah → first word.
    assert_eq!(index.ayah_first_word.len(), 6236);
    assert_eq!(index.ayah_first_word[0], 1);
    assert!(index.ayah_first_word.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(core.word_range_of_ayah(6236).unwrap().1, 83_665);
}
