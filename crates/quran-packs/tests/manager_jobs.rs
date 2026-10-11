//! The pack manager's jobs (docs/ARCHITECTURE.md §2.5.2, §2.5.5): installs, requirements, pause/resume/cancel, removal,
//! whole packs and their cached database handles, and the registry states the UI sees. Owner: WP5e.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod manager_support;
mod qf_support;
mod support;

use std::time::Duration;

use manager_support::{
    Fixture, decor_pack, install_pack_db, mushaf_pack, quranenc_pack, serve_pages, woff2,
};
use quran_packs::PackError;
use quran_packs::install;
use quran_types::{
    FetchPriority, FontAvailability, InstallScope, JobPhase, MushafStyle, PackItemState, PackKind,
    PackState,
};
use support::eventually;
use support::http::{Gate, Route, TestServer};

fn items(pages: &[u32]) -> InstallScope {
    InstallScope::Items {
        items: pages.to_vec(),
    }
}

fn page_path(f: &Fixture, variant: &str, page: u32) -> std::path::PathBuf {
    f.env.path(&format!("mushaf/{variant}/p{page}.woff2"))
}

#[tokio::test]
async fn pages_install_as_a_job_and_show_in_the_registry() {
    let server = TestServer::start();
    serve_pages(&server, "v2", 1..=4, 900);
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v2")]);
    assert_eq!(f.state("mushaf.v2"), PackState::NotInstalled);

    let job = f
        .manager
        .install("mushaf.v2", items(&[3, 1, 2]))
        .await
        .unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Completed);
    assert_eq!(
        f.events.lifecycle(job),
        ["queued", "started", "completed"],
        "an item install never pulls the requirements in"
    );
    assert!(f.events.changed().contains("mushaf.v2"));
    for page in 1..=3 {
        assert!(page_path(&f, "v2", page).is_file(), "p{page}");
    }
    let info = f.info("mushaf.v2");
    assert_eq!(
        info.state,
        PackState::Partial {
            items_present: 3,
            items_total: 604
        }
    );
    assert_eq!(info.installed_kib, 3, "3 × 900 B, rounded up");
    assert!(info.job.is_none(), "a completed job leaves the list");
    assert_eq!(f.state("decor"), PackState::NotInstalled);
    let listed = f.manager.items("mushaf.v2").unwrap();
    assert_eq!(
        listed,
        (1..=3)
            .map(|item| PackItemState {
                item,
                pinned: true,
                queued: false,
                kib: 1
            })
            .collect::<Vec<_>>()
    );

    // A page read on demand is cached (unpinned) and does not change the pack's state.
    let fonts = f
        .manager
        .ensure_page_fonts(MushafStyle::QcfV2, &[1, 4], FetchPriority::Interactive)
        .await
        .unwrap();
    assert!(
        fonts
            .iter()
            .all(|p| p.availability == FontAvailability::Ready)
    );
    assert_eq!(server.hits("/v2/p1.woff2"), 1, "page 1 came from disk");
    let listed = f.manager.items("mushaf.v2").unwrap();
    assert_eq!(listed.len(), 4);
    assert!(!listed[3].pinned && listed[3].item == 4);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 3,
            items_total: 604
        }
    );
    // Summaries agree with the list.
    let summary = f
        .manager
        .summaries()
        .unwrap()
        .into_iter()
        .find(|s| s.id == "mushaf.v2")
        .unwrap();
    assert_eq!(summary.state, f.state("mushaf.v2"));
}

#[tokio::test]
async fn a_full_install_brings_what_the_pack_requires() {
    let server = TestServer::start();
    // No page is served: the Mushaf job fails on its first three pages, the decor job is independent.
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v1")]);
    let job = f
        .manager
        .install("mushaf.v1", InstallScope::All)
        .await
        .unwrap();
    let jobs = f.manager.jobs();
    let decor = jobs
        .iter()
        .find(|j| j.pack_id == "decor")
        .expect("decor queued with the Mushaf")
        .job_id;
    assert_ne!(decor, job);
    assert_eq!(f.wait_job(decor).await, JobPhase::Completed);
    assert_eq!(
        f.state("decor"),
        PackState::Installed {
            version: "2026.10".into()
        }
    );
    assert!(f.manager.decor_status().installed);
    assert_eq!(f.wait_job(job).await, JobPhase::Failed);
    assert!(matches!(f.state("mushaf.v1"), PackState::Failed { .. }));

    // Installed requirements are not queued again; a failed job is retried by `resume`.
    let retry = f.manager.resume("mushaf.v1").await.unwrap();
    assert!(f.manager.jobs().iter().all(|j| j.pack_id != "decor"));
    assert_eq!(f.wait_job(retry).await, JobPhase::Failed);
    f.manager.cancel("mushaf.v1").await.unwrap();
    assert_eq!(f.state("mushaf.v1"), PackState::NotInstalled);
    assert!(f.manager.jobs().is_empty());
}

#[tokio::test]
async fn pause_resume_and_cancel_follow_the_job() {
    let server = TestServer::start();
    let gate = Gate::new();
    for page in 1..=6 {
        server.route(
            &format!("/v2/p{page}.woff2"),
            Route::bytes(woff2(700, u8::try_from(page).unwrap())).gated(&gate),
        );
    }
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v2")]);
    let job = f
        .manager
        .install("mushaf.v2", items(&[1, 2, 3, 4]))
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || gate.waiting() > 0).await,
        "the job reached the server"
    );
    assert!(matches!(
        f.manager.install("mushaf.v2", items(&[5])).await,
        Err(PackError::Conflict(_))
    ));
    f.manager.pause("mushaf.v2").await.unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Paused);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Paused {
            items_present: 0,
            items_total: 604
        }
    );
    let paused = f.manager.items("mushaf.v2").unwrap();
    assert_eq!(paused.len(), 4);
    assert!(paused.iter().all(|i| i.queued && !i.pinned && i.kib == 0));
    // Pausing again is a no-op.
    f.manager.pause("mushaf.v2").await.unwrap();

    let resumed = f.manager.resume("mushaf.v2").await.unwrap();
    assert_ne!(resumed, job);
    gate.open();
    assert_eq!(f.wait_job(resumed).await, JobPhase::Completed);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 4,
            items_total: 604
        }
    );

    // A cancelled job keeps the pages it completed and deletes its temps.
    let gate2 = Gate::new();
    for page in 5..=6 {
        server.route(
            &format!("/v2/p{page}.woff2"),
            Route::bytes(woff2(700, 9)).gated(&gate2),
        );
    }
    let job = f
        .manager
        .install("mushaf.v2", items(&[5, 6]))
        .await
        .unwrap();
    assert!(eventually(Duration::from_secs(10), || gate2.waiting() > 0).await);
    f.manager.cancel("mushaf.v2").await.unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Cancelled);
    gate2.open();
    let after = f.manager.items("mushaf.v2").unwrap();
    assert_eq!(
        after.iter().map(|i| i.item).collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    assert!(!install::part_path(&page_path(&f, "v2", 5)).exists());
    assert!(matches!(
        f.manager.cancel("mushaf.v2").await,
        Err(PackError::NotFound(_))
    ));
}

/// A retried failed job and a resumed paused one are downloading again: while they run, the pack reads as what it
/// holds (as before its first stop), never as the failure or the pause the row keeps until the job ends.
#[tokio::test]
async fn a_resumed_job_reads_as_downloading_not_as_its_last_stop() {
    let server = TestServer::start();
    // No page is served yet: the job fails on its first three pages.
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v2")]);
    let job = f
        .manager
        .install("mushaf.v2", items(&[1, 2, 3]))
        .await
        .unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Failed);
    assert!(matches!(f.state("mushaf.v2"), PackState::Failed { .. }));

    // Back online: the retry waits on the server, and meanwhile nothing is held yet.
    let gate = Gate::new();
    for page in 1..=4 {
        server.route(
            &format!("/v2/p{page}.woff2"),
            Route::bytes(woff2(700, u8::try_from(page).unwrap())).gated(&gate),
        );
    }
    let retry = f.manager.resume("mushaf.v2").await.unwrap();
    assert!(eventually(Duration::from_secs(10), || gate.waiting() > 0).await);
    assert_eq!(f.state("mushaf.v2"), PackState::NotInstalled);
    gate.open();
    assert_eq!(f.wait_job(retry).await, JobPhase::Completed);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 3,
            items_total: 604
        }
    );

    // A pause, then a resume: while it runs, the pack holds its three pages.
    let gate = Gate::new();
    server.route("/v2/p4.woff2", Route::bytes(woff2(700, 4)).gated(&gate));
    let job = f.manager.install("mushaf.v2", items(&[4])).await.unwrap();
    assert!(eventually(Duration::from_secs(10), || gate.waiting() > 0).await);
    f.manager.pause("mushaf.v2").await.unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Paused);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Paused {
            items_present: 3,
            items_total: 604
        }
    );
    let resumed = f.manager.resume("mushaf.v2").await.unwrap();
    assert!(eventually(Duration::from_secs(10), || gate.waiting() > 0).await);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 3,
            items_total: 604
        }
    );
    gate.open();
    assert_eq!(f.wait_job(resumed).await, JobPhase::Completed);
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 4,
            items_total: 604
        }
    );
}

#[tokio::test]
async fn remove_cancels_the_job_and_deletes_files_and_rows() {
    let server = TestServer::start();
    serve_pages(&server, "v4", 1..=2, 800);
    let gate = Gate::new();
    server.route("/v4/p3.woff2", Route::bytes(woff2(800, 3)).gated(&gate));
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v4")]);
    let job = f
        .manager
        .install("mushaf.v4", items(&[1, 2]))
        .await
        .unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Completed);
    let running = f.manager.install("mushaf.v4", items(&[3])).await.unwrap();
    assert!(eventually(Duration::from_secs(10), || gate.waiting() > 0).await);

    f.events.clear();
    f.manager.remove("mushaf.v4").await.unwrap();
    assert_eq!(
        f.events.outcome(running),
        Some(JobPhase::Cancelled),
        "the job was cancelled and waited for first"
    );
    gate.open();
    assert!(!f.env.path("mushaf/v4").exists());
    assert_eq!(manager_support::rows(&f.env.user, "mushaf.v4"), (false, 0));
    assert_eq!(f.state("mushaf.v4"), PackState::NotInstalled);
    assert!(f.events.changed().contains("mushaf.v4"));
    // Removing again is harmless.
    f.manager.remove("mushaf.v4").await.unwrap();
}

#[tokio::test]
async fn whole_packs_open_once_follow_updates_and_remove() {
    let saheeh = quranenc_pack("tr.en.saheeh", PackKind::Translation);
    let muyassar = quranenc_pack("tafsir.ar.muyassar", PackKind::Tafsir);
    let f = Fixture::new(vec![saheeh.clone(), muyassar.clone()]);
    assert!(matches!(
        f.manager.translation_db("tr.en.saheeh"),
        Err(PackError::NotFound(_))
    ));
    assert!(matches!(
        f.manager.translation_db("unknown.pack"),
        Err(PackError::NotFound(_))
    ));

    install_pack_db(&f.env, &saheeh, "1.1.2", &[1, 2, 3]).await;
    let db = f.manager.translation_db("tr.en.saheeh").unwrap();
    assert_eq!(db.entries(1, 3).unwrap().len(), 3);
    let again = f.manager.translation_db("tr.en.saheeh").unwrap();
    assert_eq!(again.path(), db.path(), "the cached handle");
    let info = f.info("tr.en.saheeh");
    assert_eq!(
        info.state,
        PackState::Installed {
            version: "1.1.2".into()
        }
    );
    assert!(info.installed_kib > 0);
    assert!(f.manager.items("tr.en.saheeh").unwrap().is_empty());

    // A new version lives in a new directory: the next lookup opens it.
    install_pack_db(&f.env, &saheeh, "1.1.3", &[1, 2, 3]).await;
    let updated = f.manager.translation_db("tr.en.saheeh").unwrap();
    assert_ne!(updated.path(), db.path());
    assert!(updated.entries(2, 2).unwrap()[0].html.contains("v1.1.3"));
    drop((db, again, updated));

    // A QuranEnc tafsir answers from its pack DB, without a fetch stamp.
    install_pack_db(&f.env, &muyassar, "2026.10", &[8, 9, 10]).await;
    let entry = f
        .manager
        .tafsir_entry("tafsir.ar.muyassar", 9)
        .await
        .unwrap();
    assert_eq!((entry.from_ayah_id, entry.to_ayah_id), (8, 10));
    assert_eq!(
        (entry.lang.as_str(), entry.fetched_at, entry.stale),
        ("ar", None, false)
    );
    assert!(matches!(
        f.manager.tafsir_entry("tafsir.ar.muyassar", 11).await,
        Err(PackError::NotFound(_))
    ));
    assert!(matches!(
        f.manager.tafsir_entry("tr.en.saheeh", 1).await,
        Err(PackError::NotFound(_))
    ));
    assert!(matches!(
        f.manager.tafsir_entry("tafsir.ar.muyassar", 0).await,
        Err(PackError::Core(quran_core::CoreError::InvalidArgument(_)))
    ));

    f.manager.remove("tr.en.saheeh").await.unwrap();
    assert!(!f.env.path("translation/tr.en.saheeh").exists());
    assert_eq!(f.state("tr.en.saheeh"), PackState::NotInstalled);
    assert!(matches!(
        f.manager.translation_db("tr.en.saheeh"),
        Err(PackError::NotFound(_))
    ));
    assert_eq!(
        f.manager.items("tafsir.ar.muyassar").unwrap(),
        Vec::new(),
        "whole packs have no numbered items"
    );
}

#[tokio::test]
async fn scopes_and_ids_are_checked_before_anything_runs() {
    let server = TestServer::start();
    let f = Fixture::new(vec![
        decor_pack(&server),
        mushaf_pack(&server, "v2"),
        quranenc_pack("tr.en.saheeh", PackKind::Translation),
    ]);
    let invalid = |r: Result<u32, PackError>| {
        matches!(
            r,
            Err(PackError::Core(quran_core::CoreError::InvalidArgument(_)))
        )
    };
    assert!(invalid(f.manager.install("mushaf.v2", items(&[605])).await));
    assert!(invalid(f.manager.install("mushaf.v2", items(&[])).await));
    assert!(matches!(
        f.manager.install("tr.en.saheeh", items(&[1])).await,
        Err(PackError::Unsupported(_))
    ));
    assert!(matches!(
        f.manager.install("decor", items(&[1])).await,
        Err(PackError::Unsupported(_))
    ));
    assert!(matches!(
        f.manager.install("nope", InstallScope::All).await,
        Err(PackError::NotFound(_))
    ));
    assert!(matches!(
        f.manager.pause("mushaf.v2").await,
        Err(PackError::NotFound(_))
    ));
    assert!(matches!(
        f.manager.resume("mushaf.v2").await,
        Err(PackError::NotFound(_))
    ));
    assert!(matches!(
        f.manager.remove_items("tr.en.saheeh", &[1]).await,
        Err(PackError::Unsupported(_))
    ));
    assert!(matches!(
        f.manager.remove_items("mushaf.v2", &[0]).await,
        Err(PackError::Core(quran_core::CoreError::InvalidArgument(_)))
    ));
    assert_eq!(f.manager.remove_items("mushaf.v2", &[]).await.unwrap(), 0);
    assert!(f.manager.jobs().is_empty());
}
