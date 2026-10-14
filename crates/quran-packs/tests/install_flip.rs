//! The atomic flip, whole-pack removal and the per-item layout.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::Path;
use std::sync::{Arc, Mutex};

use quran_core::{InstalledStatus, PackItemRow};
use quran_packs::adapters::{Adapter, ItemKey, StagedPack};
use quran_packs::install::{self, Staging};
use quran_types::{AppError, PackKind};
use support::TestEnv;

const PACK: &str = "tafsir.ar.muyassar";

async fn stage(env: &TestEnv, version: &str, content: &[u8]) -> StagedPack {
    let staging = Staging::open(&env.root, PACK).await.unwrap();
    let db_path = staging.pack_db_path();
    std::fs::write(&db_path, content).unwrap();
    StagedPack {
        db_path,
        version: version.into(),
        source_version: r#"{"etag":"\"x\"","contentLength":812274}"#.into(),
        sha256: "ab".repeat(32),
        bytes: content.len() as u64,
    }
}

#[tokio::test]
async fn the_flip_moves_the_build_into_a_new_version_directory() {
    let env = TestEnv::new();
    let staged = stage(&env, "2025.03", b"db v1").await;
    let flipped = install::flip_whole(&env.root, &env.user, PACK, PackKind::Tafsir, &staged, || {})
        .await
        .unwrap();
    assert_eq!(flipped.previous, None);
    assert!(!flipped.old_dir_removed);
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row, flipped.row);
    assert_eq!(
        row.path.as_deref(),
        Some("tafsir/tafsir.ar.muyassar/2025.03/pack.db")
    );
    assert_eq!(row.status, InstalledStatus::Installed);
    assert_eq!(row.sha256.as_deref(), Some("ab".repeat(32).as_str()));
    assert!(row.source_version.as_deref().unwrap().contains("812274"));
    assert_eq!(row.last_checked_at, Some(row.updated_at));
    assert_eq!(
        std::fs::read(env.path("tafsir/tafsir.ar.muyassar/2025.03/pack.db")).unwrap(),
        b"db v1"
    );
    assert!(!staged.db_path.exists());
}

#[tokio::test]
async fn release_runs_after_the_registry_flip_and_before_the_old_version_goes() {
    let env = TestEnv::new();
    let v1 = stage(&env, "2025.03", b"db v1").await;
    install::flip_whole(&env.root, &env.user, PACK, PackKind::Tafsir, &v1, || {})
        .await
        .unwrap();
    let old_dir = env.path("tafsir/tafsir.ar.muyassar/2025.03");
    let v2 = stage(&env, "2026.03", b"db v2").await;
    let seen = Arc::new(Mutex::new(None));
    let release = {
        let (user, seen, old_dir) = (env.user.clone(), Arc::clone(&seen), old_dir.clone());
        move || {
            let row = user.pack_installed(PACK).unwrap().unwrap();
            *seen.lock().unwrap() = Some((row.version, old_dir.exists()));
        }
    };
    let flipped = install::flip_whole(&env.root, &env.user, PACK, PackKind::Tafsir, &v2, release)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        Some(("2026.03".to_owned(), true)),
        "the registry already points to v2 and v1 still exists when handles are released"
    );
    assert!(flipped.old_dir_removed);
    assert!(!old_dir.exists());
    assert_eq!(flipped.previous.unwrap().version, "2025.03");
}

#[tokio::test]
async fn a_missing_build_changes_nothing() {
    let env = TestEnv::new();
    let v1 = stage(&env, "2025.03", b"db v1").await;
    install::flip_whole(&env.root, &env.user, PACK, PackKind::Tafsir, &v1, || {})
        .await
        .unwrap();
    let before = env.user.pack_installed(PACK).unwrap();
    let mut ghost = stage(&env, "2026.03", b"x").await;
    std::fs::remove_file(&ghost.db_path).unwrap();
    ghost.db_path = ghost.db_path.with_file_name("pack.db");
    let err = install::flip_whole(&env.root, &env.user, PACK, PackKind::Tafsir, &ghost, || {
        panic!("never released")
    })
    .await
    .unwrap_err();
    assert_eq!(AppError::from(err).kind(), "integrity");
    assert_eq!(env.user.pack_installed(PACK).unwrap(), before);
    assert!(
        env.path("tafsir/tafsir.ar.muyassar/2025.03/pack.db")
            .exists()
    );
    assert!(!env.path("tafsir/tafsir.ar.muyassar/2026.03").exists());
}

#[tokio::test]
async fn only_text_packs_flip() {
    let env = TestEnv::new();
    let staged = stage(&env, "1", b"x").await;
    for kind in [
        PackKind::MushafFonts,
        PackKind::Recitation,
        PackKind::Wbw,
        PackKind::Decor,
    ] {
        assert!(
            install::flip_whole(&env.root, &env.user, PACK, kind, &staged, || {})
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn remove_whole_releases_then_deletes_every_version_and_the_rows() {
    let env = TestEnv::new();
    let v1 = stage(&env, "2025.03", &[1u8; 5000]).await;
    install::flip_whole(&env.root, &env.user, PACK, PackKind::Tafsir, &v1, || {})
        .await
        .unwrap();
    std::fs::create_dir_all(env.path("tafsir/tafsir.ar.muyassar/old")).unwrap();
    std::fs::write(
        env.path("tafsir/tafsir.ar.muyassar/old/pack.db"),
        [2u8; 1000],
    )
    .unwrap();
    env.user
        .pack_item_upsert(&PackItemRow {
            pack_id: PACK.into(),
            item: "pack".into(),
            bytes: 1,
            sha256: String::new(),
            pinned: true,
            fetched_at: 0,
            last_used_at: 0,
        })
        .unwrap();
    let status_at_release = Arc::new(Mutex::new(None));
    let release = {
        let (user, slot) = (env.user.clone(), Arc::clone(&status_at_release));
        move || *slot.lock().unwrap() = user.pack_installed(PACK).unwrap().map(|r| r.status)
    };
    let freed = install::remove_whole(&env.root, &env.user, PACK, PackKind::Tafsir, release)
        .await
        .unwrap();
    assert_eq!(freed, 6000);
    assert_eq!(
        *status_at_release.lock().unwrap(),
        Some(InstalledStatus::Removing)
    );
    assert!(!env.path("tafsir/tafsir.ar.muyassar").exists());
    assert!(env.user.pack_installed(PACK).unwrap().is_none());
    assert!(env.user.pack_items(PACK).unwrap().is_empty());
    // Idempotent.
    assert_eq!(
        install::remove_whole(&env.root, &env.user, PACK, PackKind::Tafsir, || {})
            .await
            .unwrap(),
        0
    );
}

#[test]
fn item_files_follow_the_layout() {
    let root = Path::new("/packs");
    let fonts: Adapter = serde_json::from_value(serde_json::json!({
        "adapter": "qcf_font_pages", "variant": "v2", "urlTemplates": ["https://x.test/p{page}.woff2"]
    }))
    .unwrap();
    let f = install::item_files(&fonts, root, &ItemKey::Page(262)).unwrap();
    assert_eq!(
        f.file.as_deref(),
        Some(root.join("mushaf/v2/p262.woff2").as_path())
    );
    assert_eq!(f.temps, [root.join("mushaf/v2/p262.woff2.part")]);

    let audio: Adapter = serde_json::from_value(serde_json::json!({
        "adapter": "qdc_audio", "reciterId": 7, "name": { "en": "a", "ar": "ب" },
        "basmalaInFile": false, "hosts": ["download.quranicaudio.com"], "wordLevel": true
    }))
    .unwrap();
    let f = install::item_files(&audio, root, &ItemKey::Surah(2)).unwrap();
    assert_eq!(
        f.file.as_deref(),
        Some(root.join("audio/7/002.mp3").as_path())
    );
    assert_eq!(
        f.temps,
        [
            root.join("audio/7/002.dl.part"),
            root.join("audio/7/002.dl.part.json")
        ]
    );

    let decor: Adapter = serde_json::from_value(serde_json::json!({
        "adapter": "static_files", "files": [{ "path": "quran-common.ttf", "urls": ["https://x.test/c.ttf"], "bytes": 1 }]
    }))
    .unwrap();
    let f = install::item_files(&decor, root, &ItemKey::File("quran-common.ttf".into())).unwrap();
    assert_eq!(
        f.file.as_deref(),
        Some(root.join("decor/quran-common.ttf").as_path())
    );
    assert!(install::item_files(&decor, root, &ItemKey::File("../evil".into())).is_err());

    let wbw: Adapter = serde_json::from_value(
        serde_json::json!({ "adapter": "qurancom_v4_wbw", "language": "en" }),
    )
    .unwrap();
    assert_eq!(
        install::item_files(&wbw, root, &ItemKey::Chapter(1)).unwrap(),
        install::ItemFiles::default(),
        "content.db items have no files"
    );
}

#[tokio::test]
async fn remove_item_files_frees_files_and_temps() {
    let env = TestEnv::new();
    let audio: Adapter = serde_json::from_value(serde_json::json!({
        "adapter": "qdc_audio", "reciterId": 7, "name": { "en": "a", "ar": "ب" },
        "basmalaInFile": false, "hosts": [], "wordLevel": true
    }))
    .unwrap();
    let mp3 = install::audio_path(&env.root, 7, 18);
    std::fs::create_dir_all(mp3.parent().unwrap()).unwrap();
    std::fs::write(&mp3, [0u8; 3000]).unwrap();
    std::fs::write(
        install::dl_part_path(&install::audio_path(&env.root, 7, 36)),
        [0u8; 200],
    )
    .unwrap();
    let freed = install::remove_item_files(
        &audio,
        &env.root,
        &[ItemKey::Surah(18), ItemKey::Surah(36), ItemKey::Surah(2)],
    )
    .await
    .unwrap();
    assert_eq!(freed, 3200);
    assert!(!mp3.exists());
}

#[tokio::test]
async fn commit_and_write_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a").join("b.bin");
    install::write_atomic(&dest, b"one".to_vec()).await.unwrap();
    install::write_atomic(&dest, b"two".to_vec()).await.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"two");
    let part = install::part_path(&dest);
    std::fs::write(&part, b"three").unwrap();
    install::commit(&part, &dest).await.unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"three");
    assert!(!part.exists());
    assert_eq!(install::remove_file(&dest).await.unwrap(), 5);
    assert_eq!(install::remove_file(&dest).await.unwrap(), 0);
    assert_eq!(
        std::fs::read_dir(dir.path().join("a")).unwrap().count(),
        0,
        "no temp left"
    );
}
