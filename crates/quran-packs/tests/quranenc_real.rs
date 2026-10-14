//! Real QuranEnc exports through the whole transform (manual; nothing is downloaded here). Put `{key}.zip` files from
//! `https://quranenc.com/downloads/sqlite/{key}.zip` in a directory and run
//! `QD_QURANENC_DIR=<dir> cargo test -p quran-packs --test quranenc_real -- --ignored --nocapture` (with
//! `QD_QURANENC_OUT=<dir>` the built pack DBs are kept there for inspection).
//! Each export must build into a pack DB of 6,236 entries; the report shows footnotes, footnote markers without a note
//! (upstream gaps, kept as published) and markers left as text.
//!
//! `QD_NET_TESTS=1 cargo test -p quran-packs --test quranenc_real -- --ignored` also installs `tr.en.saheeh` (list
//! version) and `tafsir.ar.muyassar` (ETag version) from quranenc.com through the production adapter and checks that
//! an update check right after the install finds nothing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod quranenc_support;
mod support;

use std::collections::HashSet;

use quran_core::pack_db::PACK_FORMAT;
use quran_core::{InstalledPackRow, InstalledStatus, NORMALIZER_VERSION, PackDb, PackMeta};
use quran_packs::adapters::quranenc_sqlite::{
    MAX_SQLITE_BYTES, SourceVersion, check_update, extract_single_sqlite, install,
};
use quran_packs::catalog::{language_direction, tokenizer_for_language};
use quran_packs::http::HttpConfig;
use quran_packs::jobs::JobHandle;
use quran_packs::transform::translation::build_pack_db;
use quran_types::PackKind;

/// The ISO code of a QuranEnc key's language (`english_saheeh` → `en`).
fn language(key: &str) -> &'static str {
    match key.split('_').next().unwrap_or_default() {
        "arabic" => "ar",
        "bengali" => "bn",
        "english" => "en",
        "french" => "fr",
        "german" => "de",
        "hindi" => "hi",
        "indonesian" => "id",
        "persian" => "fa",
        "russian" => "ru",
        "spanish" => "es",
        "turkish" => "tr",
        "urdu" => "ur",
        other => panic!("add a language for {other}"),
    }
}

#[test]
#[ignore = "manual: needs QuranEnc zips in QD_QURANENC_DIR"]
fn real_exports_build() {
    let Ok(dir) = std::env::var("QD_QURANENC_DIR") else {
        eprintln!("QD_QURANENC_DIR is not set; nothing to check");
        return;
    };
    let mut zips: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "zip"))
        .collect();
    zips.sort();
    assert!(!zips.is_empty(), "no zips in {dir}");
    let temp = tempfile::tempdir().unwrap();
    let work = std::env::var_os("QD_QURANENC_OUT")
        .map_or_else(|| temp.path().to_path_buf(), std::path::PathBuf::from);
    std::fs::create_dir_all(&work).unwrap();
    for zip in zips {
        let key = zip.file_stem().unwrap().to_string_lossy().into_owned();
        let lang = language(&key);
        let kind = if key == "arabic_moyassar" {
            PackKind::Tafsir
        } else {
            PackKind::Translation
        };
        let sqlite = temp.path().join(format!("{key}.sqlite"));
        extract_single_sqlite(&zip, &sqlite, MAX_SQLITE_BYTES).unwrap();
        let dest = work.join(format!("{key}.db"));
        let meta = PackMeta {
            pack_id: format!("tr.{lang}.{key}"),
            kind,
            lang: lang.into(),
            dir: language_direction(lang),
            name: key.clone(),
            author: String::new(),
            source: zip.display().to_string(),
            source_version: "real".into(),
            licence: String::new(),
            attribution: String::new(),
            tokenizer: tokenizer_for_language(lang),
            normalizer_version: NORMALIZER_VERSION,
            format: PACK_FORMAT,
        };
        let started = std::time::Instant::now();
        let stats = build_pack_db(&sqlite, &dest, &meta, "real", &|| Ok(())).unwrap();
        let took = started.elapsed();
        assert_eq!(stats.entries, 6236, "{key}");
        let db = PackDb::open(&dest).unwrap();
        let entries = db.entries(1, 6236).unwrap();
        let ids: Vec<u32> = (1..=6236).collect();
        let notes: HashSet<String> = db
            .footnotes_for(&ids)
            .unwrap()
            .into_iter()
            .map(|f| f.id)
            .collect();
        let (mut markers, mut dangling, mut literal) = (0usize, 0usize, 0usize);
        for e in &entries {
            for part in e.html.split("data-fn=\"").skip(1) {
                markers += 1;
                let id = part.split('"').next().unwrap();
                if !notes.contains(id) {
                    dangling += 1;
                }
            }
            let plain = e.html.replace("<sup", "\u{1}");
            literal += plain
                .split('[')
                .skip(1)
                .filter(|s| {
                    s.split(']')
                        .next()
                        .is_some_and(|n| !n.is_empty() && n.chars().all(char::is_numeric))
                })
                .count();
        }
        eprintln!(
            "{key:>22}: {:>5} footnotes, {markers:>5} markers, {dangling:>3} without a note, {literal} [n] left, {:>8} bytes, {} ms",
            stats.footnotes,
            stats.bytes,
            took.as_millis()
        );
        assert_eq!(
            literal, 0,
            "{key}: every [n] marker becomes a footnote reference"
        );
    }
}

#[tokio::test]
#[ignore = "network: set QD_NET_TESTS=1"]
async fn live_quranenc_installs_and_is_up_to_date() {
    if std::env::var("QD_NET_TESTS").as_deref() != Ok("1") {
        eprintln!("QD_NET_TESTS is not 1; nothing to check");
        return;
    }
    let env = support::TestEnv::with_http(HttpConfig::new("QuranForDesktop/test"));
    for (pack_id, kind, cfg) in [
        (
            "tr.en.saheeh",
            PackKind::Translation,
            quranenc_support::saheeh("1.1.2"),
        ),
        (
            "tafsir.ar.muyassar",
            PackKind::Tafsir,
            quranenc_support::muyassar("2025.03"),
        ),
    ] {
        let staging = quran_packs::install::staging_dir(&env.root, pack_id).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        let ctx = env.ctx(pack_id, kind, Some(JobHandle::detached(1, pack_id)), true);
        let staged = install(&ctx, &cfg, &staging).await.unwrap();
        let db = PackDb::open(&staged.db_path).unwrap();
        assert_eq!(db.entries(1, 6236).unwrap().len(), 6236, "{pack_id}");
        let sv = SourceVersion::parse(&staged.source_version).unwrap();
        eprintln!(
            "{pack_id}: version {}, {} bytes zip, etag {:?}, pack {} bytes",
            staged.version,
            sv.content_length.unwrap_or_default(),
            sv.etag,
            staged.bytes
        );
        drop(db);
        let row = InstalledPackRow {
            pack_id: pack_id.into(),
            kind,
            version: staged.version.clone(),
            path: Some("x/pack.db".into()),
            status: InstalledStatus::Installed,
            bytes: staged.bytes,
            items_total: 1,
            items_present: 1,
            sha256: Some(staged.sha256.clone()),
            source_version: Some(staged.source_version.clone()),
            installed_at: 0,
            updated_at: 0,
            last_checked_at: None,
        };
        let plain = env.ctx(pack_id, kind, None, false);
        assert_eq!(
            check_update(&plain, &cfg, &row).await.unwrap(),
            None,
            "{pack_id}"
        );
    }
}
