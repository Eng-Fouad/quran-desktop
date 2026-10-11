//! The exact onboarding starter set (docs/ARCHITECTURE.md §2.5.4, §9.7) over the shipped catalog. Owner: WP5a.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::PathBuf;

use quran_packs::Catalog;
use quran_packs::catalog::{StarterChoices, StarterFetch};
use quran_types::{InstallMode, MushafStyle, PackKind, UiLanguage};

fn catalog() -> Catalog {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/catalog.json");
    Catalog::load(&path).unwrap()
}

const DECOR: u64 = 332_556;
const SAHEEH: u64 = 518_866;
const MUYASSAR: u64 = 812_274;
const V2_ALL: u64 = 97_748_500;

fn shape(c: &Catalog, choices: &StarterChoices) -> Vec<(String, StarterFetch, u64)> {
    c.starter_set(choices)
        .unwrap()
        .items
        .into_iter()
        .map(|i| (i.pack_id, i.fetch, i.bytes_now))
        .collect()
}

fn item(id: &str, fetch: StarterFetch, bytes: u64) -> (String, StarterFetch, u64) {
    (id.to_owned(), fetch, bytes)
}

#[test]
fn english_defaults() {
    let c = catalog();
    let choices = StarterChoices::defaults(&c, UiLanguage::En);
    assert_eq!(choices.translation.as_deref(), Some("tr.en.saheeh"));
    assert_eq!(
        (
            choices.style,
            choices.reciter_id,
            choices.download_all_pages
        ),
        (MushafStyle::Hafs, 7, false)
    );
    assert_eq!(
        shape(&c, &choices),
        [
            item("decor", StarterFetch::Now, DECOR),
            item("tr.en.saheeh", StarterFetch::Now, SAHEEH),
            item("wbw.en", StarterFetch::OnDemand, 0),
            item("audio.qdc.7", StarterFetch::TimingsOnFirstPlay, 0),
        ]
    );
    let set = c.starter_set(&choices).unwrap();
    assert_eq!(
        set.download_now_bytes(),
        851_422,
        "decor + Saheeh: the exact total above “Download now”"
    );
    assert_eq!(set.download_now(), ["decor", "tr.en.saheeh"]);
}

#[test]
fn arabic_defaults() {
    let c = catalog();
    let choices = StarterChoices::defaults(&c, UiLanguage::Ar);
    assert_eq!(choices.translation.as_deref(), Some("tafsir.ar.muyassar"));
    assert_eq!(
        shape(&c, &choices),
        [
            item("decor", StarterFetch::Now, DECOR),
            item("tafsir.ar.muyassar", StarterFetch::Now, MUYASSAR),
            item("audio.qdc.7", StarterFetch::TimingsOnFirstPlay, 0),
        ],
        "no WBW: Quran.com has no Arabic gloss"
    );
    assert_eq!(
        c.starter_set(&choices).unwrap().download_now_bytes(),
        DECOR + MUYASSAR
    );
}

#[test]
fn qcf_styles_download_pages_on_demand_unless_all_are_requested() {
    let c = catalog();
    let base = StarterChoices::defaults(&c, UiLanguage::En);
    for (style, pack_id) in [
        (MushafStyle::QcfV2, "mushaf.v2"),
        (MushafStyle::QcfV1, "mushaf.v1"),
        (MushafStyle::QcfV4, "mushaf.v4"),
    ] {
        let on_demand = StarterChoices {
            style,
            ..base.clone()
        };
        let set = c.starter_set(&on_demand).unwrap();
        let fonts = set.get(pack_id).unwrap();
        assert_eq!(
            (fonts.fetch, fonts.bytes_now),
            (StarterFetch::OnDemand, 0),
            "{pack_id}"
        );
        assert_eq!(
            set.download_now_bytes(),
            DECOR + SAHEEH,
            "nothing up front for {pack_id}"
        );
        assert_eq!(set.items[2].pack_id, pack_id, "the style is the third item");

        let all = StarterChoices {
            download_all_pages: true,
            ..on_demand
        };
        let set = c.starter_set(&all).unwrap();
        let size = c.get(pack_id).unwrap().size_bytes;
        assert_eq!(set.get(pack_id).unwrap().fetch, StarterFetch::Now);
        assert_eq!(set.download_now_bytes(), DECOR + SAHEEH + size);
    }
    let all_v2 = StarterChoices {
        style: MushafStyle::QcfV2,
        download_all_pages: true,
        ..base.clone()
    };
    assert_eq!(
        c.starter_set(&all_v2).unwrap().download_now_bytes(),
        DECOR + SAHEEH + V2_ALL
    );
    let hafs_all = StarterChoices {
        download_all_pages: true,
        ..base
    };
    assert_eq!(
        c.starter_set(&hafs_all).unwrap().download_now_bytes(),
        DECOR + SAHEEH,
        "hafs is bundled: the checkbox has nothing to fetch"
    );
}

#[test]
fn every_translation_and_reciter_can_be_chosen() {
    let c = catalog();
    let base = StarterChoices::defaults(&c, UiLanguage::En);
    for p in c
        .packs
        .iter()
        .filter(|p| matches!(p.kind, PackKind::Translation | PackKind::Tafsir))
    {
        let choices = StarterChoices {
            translation: Some(p.id.clone()),
            ..base.clone()
        };
        let set = c.starter_set(&choices).unwrap();
        let (fetch, now) = match p.install_mode {
            InstallMode::Whole => (StarterFetch::Now, p.size_bytes),
            InstallMode::OnDemand => (StarterFetch::OnDemand, 0),
        };
        assert_eq!(set.get(&p.id).unwrap().fetch, fetch, "{}", p.id);
        assert_eq!(set.download_now_bytes(), DECOR + now, "{}", p.id);
    }
    for r in c.reciters() {
        let choices = StarterChoices {
            reciter_id: r.id,
            ..base.clone()
        };
        let set = c.starter_set(&choices).unwrap();
        let audio = set.get(&r.pack_id).unwrap();
        assert_eq!(
            (audio.fetch, audio.bytes_now),
            (StarterFetch::TimingsOnFirstPlay, 0),
            "never bulk audio"
        );
        assert_eq!(set.download_now_bytes(), DECOR + SAHEEH);
    }
    let none = StarterChoices {
        translation: None,
        ..base
    };
    assert_eq!(c.starter_set(&none).unwrap().download_now(), ["decor"]);
}
