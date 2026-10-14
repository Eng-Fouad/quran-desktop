//! Whole-pack jobs: staging, Verifying → Installing, the atomic flip, updates that release handles before deleting the
//! old version, failures that leave the installed version intact, and pause/resume/cancel of the download in staging.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use quran_core::InstalledStatus;
use quran_packs::install;
use quran_packs::jobs::{JobQueue, JournalState, PackWork, read_journal};
use quran_types::{InstallScope, JobPhase, PackKind};
use support::http::{Route, TestServer};
use support::work::{WholeWork, spec, spec_source};
use support::{TestEnv, bytes, eventually, sha256_hex};

const PACK: &str = "tr.en.saheeh";

fn queue_for(env: &TestEnv, work: &Arc<WholeWork>) -> JobQueue {
    let w: Arc<dyn PackWork> = Arc::clone(work) as Arc<dyn PackWork>;
    env.queue(
        spec_source(vec![(PACK, PackKind::Translation, w, 1, 518_866)]),
        3,
        4,
    )
}

async fn install(env: &TestEnv, q: &JobQueue, work: &Arc<WholeWork>) -> (u32, Option<JobPhase>) {
    let id = q
        .enqueue(spec(
            PACK,
            PackKind::Translation,
            Arc::clone(work) as Arc<dyn PackWork>,
            InstallScope::All,
            1,
            518_866,
        ))
        .await
        .unwrap();
    let _ = env;
    (id, q.wait(id).await)
}

#[tokio::test]
async fn a_whole_pack_installs_atomically() {
    let s = TestServer::start();
    let zip = bytes(300_000, 1);
    s.route(
        "/english_saheeh.zip",
        Route::bytes(zip.clone()).etag("\"z1\""),
    );
    let env = TestEnv::new();
    let work = Arc::new(WholeWork::new(s.url("/english_saheeh.zip"), "1.1.2"));
    let q = queue_for(&env, &work);
    let (id, phase) = install(&env, &q, &work).await;
    assert_eq!(phase, Some(JobPhase::Completed));
    assert_eq!(
        env.recorder.lifecycle(id),
        ["queued", "started", "verifying", "installing", "completed"]
    );
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    assert_eq!(row.version, "1.1.2");
    assert_eq!(
        row.path.as_deref(),
        Some("translation/tr.en.saheeh/1.1.2/pack.db")
    );
    assert_eq!(row.sha256.as_deref(), Some(sha256_hex(&zip).as_str()));
    assert!(row.source_version.unwrap().contains("\\\"z1\\\""));
    assert_eq!((row.items_present, row.items_total), (1, 1));
    assert!(
        install::resolve(&env.root, row.path.as_deref().unwrap())
            .unwrap()
            .is_file()
    );
    assert!(!install::staging_dir(&env.root, PACK).unwrap().exists());
    assert_eq!(env.recorder.released(), [PACK]);
    let last_progress = env
        .recorder
        .events_for(id)
        .into_iter()
        .rev()
        .find_map(|e| match e {
            quran_types::DownloadEvent::Progress {
                received_kib,
                total_kib,
                items_done,
                ..
            } => Some((received_kib, total_kib, items_done)),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        last_progress,
        (292, 293, 1),
        "the zip's real length replaced the catalog estimate"
    );
}

#[tokio::test]
async fn an_update_replaces_the_old_version_after_releasing_it() {
    let s = TestServer::start();
    s.route("/v1.zip", Route::bytes(bytes(10_000, 1)));
    s.route("/v2.zip", Route::bytes(bytes(12_000, 2)));
    let env = TestEnv::new();
    let v1 = Arc::new(WholeWork::new(s.url("/v1.zip"), "1.1.2"));
    let q = queue_for(&env, &v1);
    assert_eq!(install(&env, &q, &v1).await.1, Some(JobPhase::Completed));
    let old = env.user.pack_installed(PACK).unwrap().unwrap();
    let old_dir = install::resolve(&env.root, old.path.as_deref().unwrap())
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();

    let v2 = Arc::new(WholeWork::new(s.url("/v2.zip"), "1.2.0"));
    assert_eq!(install(&env, &q, &v2).await.1, Some(JobPhase::Completed));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.version, "1.2.0");
    assert_eq!(
        row.path.as_deref(),
        Some("translation/tr.en.saheeh/1.2.0/pack.db")
    );
    assert_eq!(
        row.installed_at, old.installed_at,
        "first install time kept"
    );
    assert!(!old_dir.exists(), "the old version is deleted");
    assert_eq!(env.recorder.released(), [PACK, PACK]);

    // Reinstalling the same version goes to a fresh directory, never over the live one.
    let again = Arc::new(WholeWork::new(s.url("/v2.zip"), "1.2.0"));
    assert_eq!(install(&env, &q, &again).await.1, Some(JobPhase::Completed));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(
        row.path.as_deref(),
        Some("translation/tr.en.saheeh/1.2.0~2/pack.db")
    );
    assert!(!env.path("translation/tr.en.saheeh/1.2.0").exists());
}

#[tokio::test]
async fn a_failed_update_leaves_the_installed_version_intact() {
    let s = TestServer::start();
    s.route("/v1.zip", Route::bytes(bytes(10_000, 1)));
    s.route("/v2.zip", Route::bytes(bytes(12_000, 2)));
    let env = TestEnv::new();
    let v1 = Arc::new(WholeWork::new(s.url("/v1.zip"), "1.1.2"));
    let q = queue_for(&env, &v1);
    install(&env, &q, &v1).await;
    let before = env.user.pack_installed(PACK).unwrap().unwrap();
    let db = install::resolve(&env.root, before.path.as_deref().unwrap()).unwrap();
    let content = std::fs::read(&db).unwrap();

    let v2 = Arc::new(WholeWork::new(s.url("/v2.zip"), "1.2.0").failing(1));
    let (id, phase) = install(&env, &q, &v2).await;
    assert_eq!(phase, Some(JobPhase::Failed));
    assert_eq!(
        env.recorder.lifecycle(id),
        ["queued", "started", "verifying", "failed"]
    );
    assert_eq!(env.user.pack_installed(PACK).unwrap().unwrap(), before);
    assert_eq!(std::fs::read(&db).unwrap(), content);
    assert!(!env.path("translation/tr.en.saheeh/1.2.0").exists());
    let journal = read_journal(&env.root, PACK).await.unwrap();
    assert_eq!(journal.state, JournalState::Failed);
    assert_eq!(journal.error.unwrap().kind(), "integrity");
    assert!(
        !install::staging_dir(&env.root, PACK)
            .unwrap()
            .join("pack.db")
            .exists()
    );
}

#[tokio::test]
async fn a_failed_first_install_is_marked_failed_and_retried() {
    let s = TestServer::start();
    s.route("/v1.zip", Route::bytes(bytes(10_000, 1)));
    let env = TestEnv::new();
    let work = Arc::new(WholeWork::new(s.url("/v1.zip"), "1.1.2").failing(1));
    let q = queue_for(&env, &work);
    let (_, phase) = install(&env, &q, &work).await;
    assert_eq!(phase, Some(JobPhase::Failed));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Failed);
    assert_eq!((row.items_present, row.path), (0, None));
    let id = q.resume(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(
        env.user.pack_installed(PACK).unwrap().unwrap().status,
        InstalledStatus::Installed
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_resume_and_cancel_of_a_whole_pack_download() {
    let s = TestServer::start();
    let zip = bytes(3 * 1024 * 1024, 3);
    s.route(
        "/big.zip",
        Route::bytes(zip.clone())
            .etag("\"big\"")
            .throttle(32 * 1024, Duration::from_millis(10)),
    );
    let env = TestEnv::new();
    let work = Arc::new(WholeWork::new(s.url("/big.zip"), "2025.03"));
    let q = queue_for(&env, &work);
    let id = q
        .enqueue(spec(
            PACK,
            PackKind::Translation,
            Arc::clone(&work) as Arc<dyn PackWork>,
            InstallScope::All,
            1,
            3 * 1024 * 1024,
        ))
        .await
        .unwrap();
    let staging = install::staging_dir(&env.root, PACK).unwrap();
    let sidecar = install::dl_sidecar_path(&staging.join("pack.zip"));
    assert!(
        eventually(Duration::from_secs(20), || {
            std::fs::read(&sidecar)
                .ok()
                .and_then(|b| serde_json::from_slice::<quran_packs::http::Sidecar>(&b).ok())
                .is_some_and(|s| s.received >= 1024 * 1024)
        })
        .await
    );
    q.pause(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Paused));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Paused);
    assert!(sidecar.exists(), "pause keeps the download");

    s.clear_log();
    let id = q.resume(PACK).await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || !s
            .requests_to("/big.zip")
            .is_empty())
        .await
    );
    assert!(
        s.requests_to("/big.zip")[0]
            .header("range")
            .is_some_and(|r| r != "bytes=0-"),
        "the download resumed"
    );
    q.cancel(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Cancelled));
    assert!(!staging.exists(), "cancel deletes staging and the download");
    assert!(env.user.pack_installed(PACK).unwrap().is_none());
}
