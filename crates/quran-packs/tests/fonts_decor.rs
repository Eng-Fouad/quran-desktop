//! Decor fonts (`Fonts::{decor_status, ensure_decor}`, docs/ARCHITECTURE.md §2.5.2, §5.4): status from disk, the
//! interactive install with the catalog's length and pinned hash, the `decor` registry rows (pinned items, the pack
//! `installed`/`partial`), shared concurrent installs, offline and integrity failures. Owner: WP5c.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod fonts_support;
mod support;

use std::time::Duration;

use fonts_support::{
    BASE, catalog, decor_files, decor_pack, fonts, names, serve_decor, ttf, woff2,
};
use quran_core::InstalledStatus;
use quran_packs::PackError;
use quran_types::DecorStatus;
use support::http::{Action, Gate, Route, TestServer};
use support::{TestEnv, sha256_hex};

fn url(name: &str, body: &[u8]) -> Option<String> {
    Some(format!("{BASE}decor/{name}?v={}", &sha256_hex(body)[..8]))
}

fn installed_status(files: &[(String, Vec<u8>)]) -> DecorStatus {
    DecorStatus {
        installed: true,
        surah_header_url: url(&files[0].0, &files[0].1),
        quran_common_url: url(&files[1].0, &files[1].1),
        sura_names_url: url(&files[2].0, &files[2].1),
    }
}

const NOTHING: DecorStatus = DecorStatus {
    installed: false,
    surah_header_url: None,
    quran_common_url: None,
    sura_names_url: None,
};

#[tokio::test]
async fn ensure_decor_installs_and_registers_the_pack() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let env = TestEnv::new();
    let (f, heard) = fonts(&env, &catalog(vec![decor_pack(&decor_files(&s, &files))]));
    assert_eq!(f.decor_status(), NOTHING);

    let status = f.ensure_decor().await.unwrap();
    assert_eq!(status, installed_status(&files));
    assert_eq!(f.decor_status(), status);
    for (name, body) in &files {
        assert_eq!(
            &std::fs::read(env.root.join("decor").join(name)).unwrap(),
            body
        );
        let row = env
            .user
            .pack_item("decor", &format!("file:{name}"))
            .unwrap()
            .unwrap();
        assert!(row.pinned, "{name}");
        assert_eq!(row.sha256, sha256_hex(body));
    }
    assert_eq!(
        names(&env.root.join("decor")),
        [
            "qcf-surah-header.woff2",
            "quran-common.ttf",
            "sura-names.woff2"
        ],
        "no temps are left"
    );
    let row = env.user.pack_installed("decor").unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    assert_eq!((row.items_present, row.items_total), (3, 3));
    assert_eq!(row.bytes, 15_000);
    assert_eq!(row.version, "2026.10");
    assert_eq!(heard.lock().unwrap().clone(), [vec!["decor".to_owned()]]);

    // Installed: no further requests.
    let before = s.requests().len();
    assert_eq!(f.ensure_decor().await.unwrap(), status);
    assert_eq!(s.requests().len(), before);
}

#[tokio::test]
async fn decor_files_on_disk_count_without_the_network() {
    let s = TestServer::start();
    let env = TestEnv::new();
    env.http.set_network_allowed(false);
    let dir = env.root.join("decor");
    std::fs::create_dir_all(&dir).unwrap();
    let files = vec![
        ("qcf-surah-header.woff2".to_owned(), woff2(100, 1)),
        ("quran-common.ttf".to_owned(), ttf(200, 2)),
        ("sura-names.woff2".to_owned(), woff2(300, 3)),
    ];
    // Two of three: URLs for those, not installed.
    std::fs::write(dir.join(&files[0].0), &files[0].1).unwrap();
    std::fs::write(dir.join(&files[2].0), &files[2].1).unwrap();
    let (f, _) = fonts(&env, &catalog(vec![]));
    let partial = f.decor_status();
    assert!(!partial.installed);
    assert_eq!(partial.surah_header_url, url(&files[0].0, &files[0].1));
    assert_eq!(partial.quran_common_url, None);
    assert_eq!(partial.sura_names_url, url(&files[2].0, &files[2].1));
    std::fs::write(dir.join(&files[1].0), &files[1].1).unwrap();
    assert_eq!(f.decor_status(), installed_status(&files));
    assert_eq!(f.ensure_decor().await.unwrap(), installed_status(&files));
    // A file that is not a font is deleted, so it is fetched again.
    std::fs::write(dir.join(&files[1].0), b"<html>").unwrap();
    assert!(!f.decor_status().installed);
    assert!(!dir.join(&files[1].0).exists());
    assert!(s.requests().is_empty());
}

#[tokio::test]
async fn ensure_decor_is_offline_when_the_network_is_off() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let env = TestEnv::new();
    env.http.set_network_allowed(false);
    let (f, _) = fonts(&env, &catalog(vec![decor_pack(&decor_files(&s, &files))]));
    let err = f.ensure_decor().await.unwrap_err();
    assert!(matches!(err, PackError::Offline), "{err:?}");
    assert_eq!(quran_types::AppError::from(err).kind(), "offline");
    assert!(s.requests().is_empty());
    assert!(env.user.pack_installed("decor").unwrap().is_none());
}

#[tokio::test]
async fn a_failed_file_leaves_a_partial_pack() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    s.route(
        "/decor/quran-common.ttf",
        Route::bytes(vec![]).then(Action::Status(404)),
    );
    let env = TestEnv::new();
    let (f, heard) = fonts(&env, &catalog(vec![decor_pack(&decor_files(&s, &files))]));
    let err = f.ensure_decor().await.unwrap_err();
    assert_eq!(quran_types::AppError::from(err).kind(), "not_found");
    let status = f.decor_status();
    assert!(!status.installed);
    assert!(status.surah_header_url.is_some() && status.sura_names_url.is_some());
    assert_eq!(status.quran_common_url, None);
    let row = env.user.pack_installed("decor").unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Partial);
    assert_eq!((row.items_present, row.items_total), (2, 3));
    assert_eq!(heard.lock().unwrap().len(), 1);
    // Retry fetches only what is missing.
    s.route("/decor/quran-common.ttf", Route::bytes(files[1].1.clone()));
    s.clear_log();
    assert_eq!(f.ensure_decor().await.unwrap(), installed_status(&files));
    assert_eq!(s.requests().len(), 1);
    assert_eq!(
        env.user.pack_installed("decor").unwrap().unwrap().status,
        InstalledStatus::Installed
    );
}

#[tokio::test]
async fn the_catalog_hash_and_length_are_enforced() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let mut entries = decor_files(&s, &files);
    entries[0].3 = Some("00".repeat(32));
    entries[2].2 += 1;
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &catalog(vec![decor_pack(&entries)]));
    let err = f.ensure_decor().await.unwrap_err();
    assert_eq!(quran_types::AppError::from(err).kind(), "integrity");
    let status = f.decor_status();
    assert_eq!(
        (
            status.surah_header_url.is_some(),
            status.quran_common_url.is_some(),
            status.sura_names_url.is_some()
        ),
        (false, true, false)
    );
    assert_eq!(names(&env.root.join("decor")), ["quran-common.ttf"]);
}

#[tokio::test]
async fn concurrent_installs_share_one_download_per_file() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let gate = Gate::new();
    s.route(
        "/decor/sura-names.woff2",
        Route::bytes(files[2].1.clone()).gated(&gate),
    );
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &catalog(vec![decor_pack(&decor_files(&s, &files))]));
    let (a, b) = (f.clone(), f.clone());
    let ta = tokio::spawn(async move { a.ensure_decor().await });
    let tb = tokio::spawn(async move { b.ensure_decor().await });
    assert!(support::eventually(Duration::from_secs(5), || gate.waiting() == 1).await);
    gate.open();
    let (ra, rb) = (ta.await.unwrap().unwrap(), tb.await.unwrap().unwrap());
    assert_eq!(ra, installed_status(&files));
    assert_eq!(rb, ra);
    for (name, _) in &files {
        assert_eq!(s.hits(&format!("/decor/{name}")), 1, "{name}");
    }
}

#[tokio::test]
async fn without_a_decor_pack_ensure_decor_is_not_found() {
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &catalog(vec![]));
    let err = f.ensure_decor().await.unwrap_err();
    assert!(matches!(err, PackError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn files_already_on_disk_join_the_install() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let env = TestEnv::new();
    let dir = env.root.join("decor");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&files[0].0), &files[0].1).unwrap();
    std::fs::write(dir.join(&files[1].0), &files[1].1).unwrap();
    let (f, _) = fonts(&env, &catalog(vec![decor_pack(&decor_files(&s, &files))]));
    assert_eq!(f.ensure_decor().await.unwrap(), installed_status(&files));
    assert_eq!(s.requests().len(), 1, "only the missing file is fetched");
    for (name, body) in &files {
        let row = env
            .user
            .pack_item("decor", &format!("file:{name}"))
            .unwrap()
            .unwrap();
        assert!(row.pinned && row.sha256 == sha256_hex(body), "{name}");
    }
    let row = env.user.pack_installed("decor").unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    assert_eq!((row.items_present, row.items_total), (3, 3));
}
