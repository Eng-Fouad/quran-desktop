//! The job-lane font adapters (`qcf_font_pages`, `static_files`) run by the job queue from catalog specs: pinned pages,
//! pages fetched on demand earlier becoming pinned without a request, mirrors, integrity, and a page fetched by the
//! reader while a job writes it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod fonts_support;
mod support;

use std::sync::Arc;
use std::time::Duration;

use fonts_support::{
    catalog, decor_files, decor_pack, fonts, mushaf_pack, names, serve_decor, woff2,
};
use quran_core::InstalledStatus;
use quran_packs::adapters::{Adapter, FontVariant, ItemKey, ItemOutcome};
use quran_packs::install;
use quran_packs::jobs::{JobHandle, JobSpec, catalog_specs};
use quran_packs::{Catalog, PackError};
use quran_types::{FetchPriority, FontAvailability, InstallScope, JobPhase, MushafStyle, PackKind};
use support::http::{Action, Gate, Route, TestServer};
use support::{TestEnv, sha256_hex};

fn full_catalog(s: &TestServer, files: &[(String, Vec<u8>)]) -> Catalog {
    catalog(vec![
        mushaf_pack(
            "v2",
            &[s.url("/a/p{page}.woff2"), s.url("/b/p{page}.woff2")],
        ),
        decor_pack(&decor_files(s, files)),
    ])
}

async fn run(env: &TestEnv, catalog: &Arc<Catalog>, pack_id: &str, scope: InstallScope) -> u32 {
    let q = env.queue(catalog_specs(Arc::clone(catalog)), 3, 4);
    let id = q
        .enqueue(JobSpec::from_catalog(
            catalog.require(pack_id).unwrap(),
            scope,
            true,
        ))
        .await
        .unwrap();
    assert_eq!(
        q.wait(id).await,
        Some(JobPhase::Completed),
        "{:?}",
        env.recorder.events_for(id)
    );
    id
}

#[tokio::test]
async fn a_page_job_pins_pages_and_reuses_pages_already_on_disk() {
    let s = TestServer::start();
    for p in 1..=4 {
        s.route(
            &format!("/a/p{p}.woff2"),
            Route::bytes(woff2(2_000 + p as usize, 1)),
        );
    }
    let files = serve_decor(&s);
    let catalog = Arc::new(full_catalog(&s, &files));
    let env = TestEnv::new();
    // The reader fetched page 4 on demand.
    let (f, _) = fonts(&env, &catalog);
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[4], FetchPriority::Interactive)
        .await
        .unwrap();
    assert_eq!(got[0].availability, FontAvailability::Ready);
    assert!(
        !env.user
            .pack_item("mushaf.v2", "p4")
            .unwrap()
            .unwrap()
            .pinned
    );
    s.clear_log();

    run(
        &env,
        &catalog,
        "mushaf.v2",
        InstallScope::Items {
            items: vec![1, 2, 3, 4],
        },
    )
    .await;
    for p in 1..=4u32 {
        let row = env
            .user
            .pack_item("mushaf.v2", &format!("p{p}"))
            .unwrap()
            .unwrap();
        assert!(row.pinned, "p{p}");
        assert!(install::font_page_path(&env.root, FontVariant::V2, p).is_file());
    }
    assert_eq!(s.hits("/a/p4.woff2"), 0, "a page on disk is only pinned");
    assert_eq!(s.requests().len(), 3);
    assert_eq!(
        names(&env.root.join("mushaf").join("v2")),
        ["p1.woff2", "p2.woff2", "p3.woff2", "p4.woff2"]
    );
    let row = env.user.pack_installed("mushaf.v2").unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Partial);
    assert_eq!((row.items_present, row.items_total), (4, 604));
}

#[tokio::test]
async fn the_decor_job_installs_the_same_files_as_ensure_decor() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let catalog = Arc::new(full_catalog(&s, &files));
    let env = TestEnv::new();
    run(&env, &catalog, "decor", InstallScope::All).await;
    for (name, body) in &files {
        let row = env
            .user
            .pack_item("decor", &format!("file:{name}"))
            .unwrap()
            .unwrap();
        assert!(row.pinned);
        assert_eq!(row.sha256, sha256_hex(body));
    }
    let row = env.user.pack_installed("decor").unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    let (f, _) = fonts(&env, &catalog);
    assert!(f.decor_status().installed);
    // Present files are not downloaded again.
    s.clear_log();
    let adapter = &catalog.require("decor").unwrap().source;
    let ctx = env.ctx(
        "decor",
        PackKind::Decor,
        Some(JobHandle::detached(9, "decor")),
        true,
    );
    let out = adapter
        .fetch_item(&ctx, &ItemKey::File("quran-common.ttf".into()))
        .await
        .unwrap();
    assert_eq!(out, ItemOutcome::Present { bytes: 6_000 });
    assert!(s.requests().is_empty());
}

#[tokio::test]
async fn static_files_must_match_the_catalog() {
    let s = TestServer::start();
    let files = serve_decor(&s);
    let mut entries = decor_files(&s, &files);
    entries[0].3 = Some("ab".repeat(32));
    let catalog = catalog(vec![decor_pack(&entries)]);
    let adapter = &catalog.require("decor").unwrap().source;
    let env = TestEnv::new();
    let ctx = env.ctx(
        "decor",
        PackKind::Decor,
        Some(JobHandle::detached(1, "decor")),
        true,
    );
    let err = adapter
        .fetch_item(&ctx, &ItemKey::File("qcf-surah-header.woff2".into()))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    assert!(names(&env.root.join("decor")).is_empty());
    // A wrong file on disk (an older decor version) is replaced.
    std::fs::create_dir_all(env.root.join("decor")).unwrap();
    std::fs::write(
        env.root.join("decor").join("sura-names.woff2"),
        woff2(4_000, 99),
    )
    .unwrap();
    let out = adapter
        .fetch_item(&ctx, &ItemKey::File("sura-names.woff2".into()))
        .await
        .unwrap();
    assert_eq!(
        out,
        ItemOutcome::Stored {
            bytes: 4_000,
            sha256: sha256_hex(&files[2].1)
        }
    );
    let err = adapter
        .fetch_item(&ctx, &ItemKey::File("unknown.woff2".into()))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::NotFound(_)));
}

#[tokio::test]
async fn page_adapter_mirrors_and_integrity() {
    let s = TestServer::start();
    let body = woff2(3_000, 3);
    s.route(
        "/a/p20.woff2",
        Route::bytes(vec![]).then(Action::Status(404)),
    );
    s.route("/b/p20.woff2", Route::bytes(body.clone()));
    s.route("/a/p21.woff2", Route::bytes(b"<html>no</html>".to_vec()));
    s.route("/b/p21.woff2", Route::bytes(b"wOFFnotwoff2".to_vec()));
    let files = serve_decor(&s);
    let catalog = full_catalog(&s, &files);
    let adapter: &Adapter = &catalog.require("mushaf.v2").unwrap().source;
    let env = TestEnv::new();
    let ctx = env.ctx(
        "mushaf.v2",
        PackKind::MushafFonts,
        Some(JobHandle::detached(1, "mushaf.v2")),
        true,
    );
    assert_eq!(
        adapter.fetch_item(&ctx, &ItemKey::Page(20)).await.unwrap(),
        ItemOutcome::Stored {
            bytes: 3_000,
            sha256: sha256_hex(&body)
        }
    );
    let err = adapter
        .fetch_item(&ctx, &ItemKey::Page(21))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    assert!(!install::font_page_path(&env.root, FontVariant::V2, 21).exists());
    let err = adapter
        .fetch_item(&ctx, &ItemKey::Page(605))
        .await
        .unwrap_err();
    assert_eq!(quran_types::AppError::from(err).kind(), "invalid_argument");
}

#[tokio::test]
async fn the_reader_and_a_job_can_fetch_the_same_page_at_once() {
    let s = TestServer::start();
    let body = woff2(50_000, 5);
    let gate = Gate::new();
    s.route("/a/p30.woff2", Route::bytes(body.clone()).gated(&gate));
    let files = serve_decor(&s);
    let catalog = Arc::new(full_catalog(&s, &files));
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &catalog);
    let adapter = catalog.require("mushaf.v2").unwrap().source.clone();
    let ctx = env.ctx(
        "mushaf.v2",
        PackKind::MushafFonts,
        Some(JobHandle::detached(1, "mushaf.v2")),
        true,
    );
    let job = tokio::spawn(async move { adapter.fetch_item(&ctx, &ItemKey::Page(30)).await });
    let reader = {
        let f = f.clone();
        tokio::spawn(async move {
            f.ensure_page_fonts(MushafStyle::QcfV2, &[30], FetchPriority::Interactive)
                .await
        })
    };
    assert!(support::eventually(Duration::from_secs(5), || gate.waiting() == 2).await);
    gate.open();
    assert!(matches!(
        job.await.unwrap().unwrap(),
        ItemOutcome::Stored { bytes: 50_000, .. }
    ));
    let st = reader.await.unwrap().unwrap();
    assert_eq!(st[0].availability, FontAvailability::Ready);
    assert_eq!(
        std::fs::read(install::font_page_path(&env.root, FontVariant::V2, 30)).unwrap(),
        body
    );
    assert_eq!(
        names(&env.root.join("mushaf").join("v2")),
        ["p30.woff2"],
        "no temp is left"
    );
}
