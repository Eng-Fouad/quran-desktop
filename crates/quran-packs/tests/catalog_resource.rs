//! The shipped `src-tauri/resources/catalog.json` (docs/ARCHITECTURE.md §2.5.4): strict parse, every validation rule,
//! and the exact v1 seed content. Owner: WP5a.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;
use std::path::PathBuf;

use quran_core::PackTokenizer;
use quran_packs::adapters::{ContentKind, FontVariant, VersionSource};
use quran_packs::catalog::{SCHEMA_REF, language_direction, tokenizer_for_language};
use quran_packs::{Adapter, Catalog, CatalogPack};
use quran_types::{InstallMode, PackInfo, PackKind, PackState};

fn catalog_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/catalog.json")
}

fn catalog() -> Catalog {
    Catalog::load(&catalog_path()).unwrap()
}

fn pack<'a>(c: &'a Catalog, id: &str) -> &'a CatalogPack {
    c.get(id)
        .unwrap_or_else(|| panic!("{id} is in the catalog"))
}

fn ids_of(c: &Catalog, kind: PackKind) -> BTreeSet<String> {
    c.of_kind(kind).map(|p| p.id.clone()).collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn mib(bytes: u64) -> f64 {
    (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

#[test]
fn ships_a_valid_release_catalog() {
    let c = catalog();
    let issues: Vec<String> = c
        .issues()
        .into_iter()
        .chain(c.starter_issues())
        .map(|i| i.to_string())
        .collect();
    assert_eq!(issues, Vec::<String>::new());
    c.validate_release().unwrap();
    assert_eq!(c.catalog_version, 1);
    assert_eq!(c.schema.as_deref(), Some(SCHEMA_REF));
    assert_eq!(Catalog::load_validated(&catalog_path()).unwrap(), c);
}

#[test]
fn the_pack_set_is_exactly_the_v1_seed() {
    let c = catalog();
    assert_eq!(
        ids_of(&c, PackKind::MushafFonts),
        set(&["mushaf.v1", "mushaf.v2", "mushaf.v4"])
    );
    assert_eq!(
        ids_of(&c, PackKind::Decor),
        set(&["decor", "decor.nastaliq"])
    );
    assert_eq!(
        ids_of(&c, PackKind::Translation),
        set(&[
            "tr.en.saheeh",
            "tr.en.rwwad",
            "tr.en.hilali_khan",
            "tr.ur.junagarhi",
            "tr.id.affairs",
            "tr.tr.rwwad",
            "tr.fr.rashid",
            "tr.es.garcia",
            "tr.de.bubenheim",
            "tr.bn.zakaria",
            "tr.ru.rwwad",
            "tr.fa.ih",
            "tr.hi.omari",
        ])
    );
    assert_eq!(
        ids_of(&c, PackKind::Tafsir),
        set(&[
            "tafsir.ar.muyassar",
            "tafsir.en.ibn_kathir",
            "tafsir.en.maarif",
            "tafsir.ar.saadi"
        ])
    );
    let reciters: BTreeSet<String> = [97, 2, 3, 4, 5, 6, 10, 161, 1, 7, 9, 12, 168, 173]
        .iter()
        .map(|r| format!("audio.qdc.{r}"))
        .collect();
    assert_eq!(ids_of(&c, PackKind::Recitation), reciters);
    assert_eq!(
        ids_of(&c, PackKind::Wbw),
        set(&[
            "wbw.en", "wbw.ur", "wbw.id", "wbw.bn", "wbw.tr", "wbw.fa", "wbw.hi", "wbw.ta"
        ])
    );
    assert_eq!(c.packs.len(), 3 + 2 + 13 + 4 + 14 + 8);
    let recommended: BTreeSet<String> = c
        .packs
        .iter()
        .filter(|p| p.recommended)
        .map(|p| p.id.clone())
        .collect();
    assert_eq!(
        recommended,
        set(&[
            "mushaf.v2",
            "decor",
            "tr.en.saheeh",
            "tafsir.ar.muyassar",
            "audio.qdc.7",
            "wbw.en"
        ])
    );
}

#[test]
fn mushaf_fonts_use_the_verified_templates_and_sizes() {
    let c = catalog();
    for (id, variant, v, mirror, bytes, label) in [
        ("mushaf.v2", FontVariant::V2, "v2", "v2", 97_748_500, 93.2),
        ("mushaf.v1", FontVariant::V1, "v1", "v1", 47_952_076, 45.7),
        (
            "mushaf.v4",
            FontVariant::V4,
            "v4/colrv1",
            "v4-tajweed",
            50_877_636,
            48.5,
        ),
    ] {
        let p = pack(&c, id);
        let Adapter::QcfFontPages(cfg) = &p.source else {
            panic!("{id}: qcf_font_pages")
        };
        assert_eq!(cfg.variant, variant);
        assert_eq!(
            cfg.url_templates,
            [
                format!(
                    "https://verses.quran.foundation/fonts/quran/hafs/{v}/woff2/p{{page}}.woff2"
                ),
                format!(
                    "https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/{mirror}/woff2/p{{page}}.woff2"
                ),
            ],
            "{id}"
        );
        assert_eq!(
            p.size_bytes, bytes,
            "{id}: sum of the 604 woff2 files (FACT §4.1)"
        );
        assert_eq!(
            mib(p.size_bytes),
            label,
            "{id}: the size shown in onboarding"
        );
        assert_eq!((p.install_mode, p.item_count), (InstallMode::OnDemand, 604));
        assert_eq!(p.requires, ["decor"]);
        assert_eq!(
            p.revalidate_days, None,
            "fonts are not QF content to revalidate"
        );
    }
}

#[test]
fn decor_files_are_pinned() {
    let c = catalog();
    let decor = pack(&c, "decor");
    let Adapter::StaticFiles(cfg) = &decor.source else {
        panic!("static_files")
    };
    let files: Vec<(&str, u64)> = cfg
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.bytes))
        .collect();
    assert_eq!(
        files,
        [
            ("qcf-surah-header.woff2", 118_552),
            ("quran-common.ttf", 125_444),
            ("sura-names.woff2", 88_560)
        ],
        "FACT §4.2"
    );
    assert_eq!(decor.size_bytes, 332_556);
    assert_eq!(mib(decor.size_bytes), 0.3, "≈ 0.3 MB in the starter set");
    assert!(
        cfg.files
            .iter()
            .all(|f| f.sha256.is_some() && !f.urls.is_empty())
    );

    let nastaliq = pack(&c, "decor.nastaliq");
    let Adapter::StaticFiles(cfg) = &nastaliq.source else {
        panic!("static_files")
    };
    assert_eq!(cfg.files.len(), 1);
    let file = &cfg.files[0];
    assert_eq!(file.path, "noto-nastaliq-urdu.woff2");
    assert_eq!(file.bytes, 159_368);
    assert_eq!(
        file.sha256.as_deref(),
        Some("fecd45d69436d911d79ff10fc39ca7f7022cbe05214bc07f931820b7c7a7d15c")
    );
    assert!(
        file.urls
            .iter()
            .all(|u| u.contains("@fontsource/noto-nastaliq-urdu@5.3.0/")),
        "an immutable release"
    );
    assert_eq!(
        nastaliq.language.as_deref(),
        Some("ur"),
        "offered with Urdu packs"
    );
    assert_eq!(nastaliq.attribution.licence, "SIL Open Font License 1.1");
    assert!(!nastaliq.recommended);
}

#[test]
fn translations_come_from_quranenc() {
    let c = catalog();
    let saheeh = pack(&c, "tr.en.saheeh");
    let Adapter::QuranEncSqlite(cfg) = &saheeh.source else {
        panic!("quranenc_sqlite")
    };
    assert_eq!(
        (cfg.key.as_str(), cfg.version.as_str()),
        ("english_saheeh", "1.1.2")
    );
    assert_eq!(saheeh.size_bytes, 518_866);
    assert!(saheeh.recommended);

    let unlisted = [
        ("tr.bn.zakaria", "bengali_zakaria", 4_178_560),
        ("tr.ru.rwwad", "russian_rwwad", 576_373),
        ("tafsir.ar.muyassar", "arabic_moyassar", 812_274),
    ];
    for p in c
        .packs
        .iter()
        .filter(|p| matches!(p.source, Adapter::QuranEncSqlite(_)))
    {
        let Adapter::QuranEncSqlite(cfg) = &p.source else {
            unreachable!()
        };
        let language = p.language.as_deref().unwrap();
        assert_eq!(cfg.tokenizer, tokenizer_for_language(language), "{}", p.id);
        assert_eq!(p.direction, Some(language_direction(language)), "{}", p.id);
        assert_eq!(p.version, cfg.version, "{}", p.id);
        assert!(
            p.attribution.url.ends_with(&format!("/{}", cfg.key)),
            "{}: credits its QuranEnc page",
            p.id
        );
        match unlisted.iter().find(|(id, ..)| *id == p.id) {
            Some((_, key, bytes)) => {
                assert_eq!(
                    cfg.version_source,
                    VersionSource::HttpValidators,
                    "{} is not in the list API",
                    p.id
                );
                assert_eq!((cfg.key.as_str(), p.size_bytes), (*key, *bytes));
                assert!(
                    p.version.len() == 7 && p.version.as_bytes()[4] == b'.',
                    "YYYY.MM from the zip's ETag"
                );
            }
            None => assert_eq!(cfg.version_source, VersionSource::List, "{}", p.id),
        }
    }
    assert!(c.of_kind(PackKind::Translation).all(|p| matches!(&p.source,
        Adapter::QuranEncSqlite(cfg) if cfg.content_kind == ContentKind::Translation)));
    let urdu = pack(&c, "tr.ur.junagarhi");
    let Adapter::QuranEncSqlite(cfg) = &urdu.source else {
        panic!("quranenc_sqlite")
    };
    assert_eq!(cfg.tokenizer, PackTokenizer::ArabicNormalized);
}

#[test]
fn tafsir_sources() {
    let c = catalog();
    let muyassar = pack(&c, "tafsir.ar.muyassar");
    assert!(muyassar.recommended, "recommended when the UI is Arabic");
    assert!(
        matches!(&muyassar.source, Adapter::QuranEncSqlite(cfg) if cfg.content_kind == ContentKind::Tafsir)
    );
    for (id, resource, language) in [
        ("tafsir.en.ibn_kathir", 169, "en"),
        ("tafsir.en.maarif", 168, "en"),
        ("tafsir.ar.saadi", 91, "ar"),
    ] {
        let p = pack(&c, id);
        assert!(
            matches!(&p.source, Adapter::QurancomTafsir(cfg) if cfg.resource_id == resource),
            "{id} is Quran.com tafsir {resource}"
        );
        assert_eq!(p.language.as_deref(), Some(language));
        assert_eq!(
            (p.install_mode, p.item_count, p.revalidate_days),
            (InstallMode::OnDemand, 114, Some(7))
        );
    }
}

#[test]
fn recitations_are_the_fourteen_qdc_reciters() {
    let c = catalog();
    let reciters = c.reciters();
    assert_eq!(reciters.len(), 14);
    for r in &reciters {
        let p = pack(&c, &r.pack_id);
        let cfg = p.reciter().unwrap();
        assert_eq!(r.pack_id, format!("audio.qdc.{}", r.id));
        assert_eq!(
            cfg.hosts,
            ["download.quranicaudio.com", "download.quranicaudio.org"]
        );
        assert!(
            !cfg.basmala_in_file,
            "QDC chapter files have no basmala (FACT C8)"
        );
        assert!(
            r.word_level,
            "the 2026-10-10 probe found word segments for every reciter"
        );
        assert!(r.style.is_some());
        assert_eq!((r.downloaded_surahs, r.cached_surahs), (0, 0));
        assert_eq!(r.size_kib, p.size_kib());
        assert!(
            p.size_bytes > 500_000_000,
            "{}: whole-Quran audio is hundreds of MB",
            p.id
        );
        assert_eq!(
            (p.install_mode, p.item_count, p.revalidate_days),
            (InstallMode::OnDemand, 114, Some(7))
        );
        assert_eq!(p.language.as_deref(), Some("ar"));
    }
    assert_eq!(reciters[0].id, 7, "the recommended reciter comes first");
    let (name, basmala_in_file) = c.reciter_meta(7).unwrap();
    assert_eq!(
        (name.en.as_str(), basmala_in_file),
        ("Mishary Rashid Alafasy", false)
    );
    assert_eq!(
        mib(pack(&c, "audio.qdc.7").size_bytes),
        1602.9,
        "Content-Length sum of the 114 files"
    );
}

#[test]
fn word_by_word_languages() {
    let c = catalog();
    for p in c.of_kind(PackKind::Wbw) {
        let Adapter::QurancomWbw(cfg) = &p.source else {
            panic!("{}: qurancom_v4_wbw", p.id)
        };
        assert_eq!(p.id, format!("wbw.{}", cfg.language));
        assert_eq!(p.language.as_deref(), Some(cfg.language.as_str()));
        assert_eq!(p.direction, Some(language_direction(&cfg.language)));
        assert_eq!(p.revalidate_days, Some(7));
    }
    assert!(pack(&c, "wbw.en").recommended);
    assert!(c.wbw_pack("ar").is_none(), "Quran.com has no Arabic gloss");
}

#[test]
fn never_lists_the_clear_quran() {
    let c = catalog();
    for p in &c.packs {
        let text = format!(
            "{} {} {} {:?}",
            p.id, p.title.en, p.description.en, p.source
        )
        .to_lowercase();
        assert!(
            !text.contains("clear quran") && !text.contains("khattab"),
            "{}",
            p.id
        );
    }
}

#[test]
fn every_text_has_both_languages_and_unique_titles() {
    let c = catalog();
    for p in &c.packs {
        for text in [&p.title, &p.description, &p.attribution.text] {
            assert!(!text.en.is_empty() && !text.ar.is_empty(), "{}", p.id);
            assert!(
                text.ar
                    .chars()
                    .any(|ch| ('\u{0621}'..='\u{064A}').contains(&ch)),
                "{}: {}",
                p.id,
                text.ar
            );
        }
    }
}

#[test]
fn pack_infos_are_the_ipc_dto() {
    let c = catalog();
    let infos = c.infos();
    assert_eq!(infos.len(), c.packs.len());
    let json = serde_json::to_string(&infos).unwrap();
    let back: Vec<PackInfo> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, infos);
    for (info, p) in infos.iter().zip(&c.packs) {
        assert_eq!(info.id, p.id);
        assert_eq!(info.state, PackState::NotInstalled);
        assert_eq!((info.installed_kib, info.job.as_ref()), (0, None));
        assert_eq!(u64::from(info.size_kib), p.size_bytes.div_ceil(1024));
    }
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        value[0]["state"],
        serde_json::json!({ "type": "not_installed" })
    );
    assert_eq!(value[0]["installMode"], "on_demand");
}
