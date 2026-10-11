//! Per-item jobs (docs/ARCHITECTURE.md §2.5.5): registry rows, the 3-failed-items rule with completed items kept,
//! resume that skips recorded items and continues `.dl.part` temps, pause/cancel semantics, and restart recovery from
//! the job journal. Owner: WP5b.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use quran_core::InstalledStatus;
use quran_packs::install;
use quran_packs::jobs::{JobJournal, JobQueue, JournalState, PackWork, read_journal};
use quran_types::{InstallScope, JobPhase, PackKind};
use support::http::{Route, TestServer};
use support::work::{ItemsWork, spec, spec_source};
use support::{TestEnv, bytes, eventually, sha256_hex};

const PACK: &str = "audio.qdc.7";

fn queue(env: &TestEnv, work: &Arc<ItemsWork>, count: u32, concurrency: usize) -> JobQueue {
    let w: Arc<dyn PackWork> = Arc::clone(work) as Arc<dyn PackWork>;
    env.queue(
        spec_source(vec![(
            PACK,
            PackKind::Recitation,
            w,
            count,
            u64::from(count) * 10_000,
        )]),
        3,
        concurrency,
    )
}

fn job_spec(work: &Arc<ItemsWork>, scope: InstallScope, count: u32) -> quran_packs::jobs::JobSpec {
    spec(
        PACK,
        PackKind::Recitation,
        Arc::clone(work) as Arc<dyn PackWork>,
        scope,
        count,
        u64::from(count) * 10_000,
    )
}

fn serve_items(s: &TestServer, from: u32, to: u32) {
    for n in from..=to {
        s.route(
            &format!("/i/{n}"),
            Route::bytes(bytes(10_000, n as u8)).etag("\"e\""),
        );
    }
}

#[tokio::test]
async fn a_completed_job_records_every_item_and_installs_the_pack() {
    let s = TestServer::start();
    serve_items(&s, 1, 4);
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/i"), 4));
    let q = queue(&env, &work, 4, 4);
    let id = q
        .enqueue(job_spec(&work, InstallScope::All, 4))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));

    let items = env.user.pack_items(PACK).unwrap();
    assert_eq!(
        items.iter().map(|i| i.item.as_str()).collect::<Vec<_>>(),
        ["p1", "p2", "p3", "p4"]
    );
    assert!(items.iter().all(|i| i.pinned && i.bytes == 10_000));
    assert_eq!(items[0].sha256, sha256_hex(&bytes(10_000, 1)));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    assert_eq!(
        (row.items_present, row.items_total, row.bytes),
        (4, 4, 40_000)
    );
    assert_eq!(row.version, "2026.10");
    assert_eq!(row.path, None);
    assert!(
        !install::staging_dir(&env.root, PACK).unwrap().exists(),
        "the journal is gone"
    );
}

#[tokio::test]
async fn a_partial_scope_installs_as_partial() {
    let s = TestServer::start();
    serve_items(&s, 1, 4);
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/i"), 4));
    let q = queue(&env, &work, 4, 4);
    let id = q
        .enqueue(job_spec(
            &work,
            InstallScope::Items { items: vec![3, 1] },
            4,
        ))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Partial);
    assert_eq!((row.items_present, row.items_total), (2, 4));
    assert_eq!(s.hits("/i/2") + s.hits("/i/4"), 0);
}

#[tokio::test]
async fn three_failed_items_fail_the_job_and_completed_items_are_kept() {
    let s = TestServer::start();
    serve_items(&s, 1, 1);
    serve_items(&s, 5, 10);
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/i"), 10));
    let q = queue(&env, &work, 10, 1);
    let id = q
        .enqueue(job_spec(&work, InstallScope::All, 10))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Failed));
    assert_eq!(
        work.calls.load(Ordering::SeqCst),
        4,
        "stopped at the third failure"
    );
    let snap = q.snapshot(PACK).unwrap();
    assert_eq!(snap.phase, JobPhase::Failed);
    assert_eq!(snap.error.as_ref().unwrap().kind(), "not_found");
    assert_eq!((snap.items_done, snap.items_total), (1, 10));
    assert_eq!(env.recorder.lifecycle(id), ["queued", "started", "failed"]);

    assert_eq!(
        env.user.pack_items(PACK).unwrap().len(),
        1,
        "item 1 is kept"
    );
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Failed);
    assert_eq!(row.items_present, 1);
    let journal = read_journal(&env.root, PACK).await.unwrap();
    assert_eq!(journal.state, JournalState::Failed);
    assert_eq!(journal.error.unwrap().kind(), "not_found");

    // Retry once the upstream is fixed: item 1 is skipped.
    serve_items(&s, 2, 4);
    s.clear_log();
    let id = q.resume(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(s.hits("/i/1"), 0);
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    assert!(read_journal(&env.root, PACK).await.is_none());
}

#[tokio::test]
async fn fewer_failures_complete_the_job_as_partial() {
    let s = TestServer::start();
    serve_items(&s, 1, 2);
    serve_items(&s, 4, 5);
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/i"), 5));
    let q = queue(&env, &work, 5, 2);
    let id = q
        .enqueue(job_spec(&work, InstallScope::All, 5))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Partial);
    assert_eq!(row.items_present, 4);
}

#[tokio::test]
async fn a_small_job_fails_when_all_its_items_fail() {
    let s = TestServer::start();
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/i"), 5));
    let q = queue(&env, &work, 5, 2);
    let id = q
        .enqueue(job_spec(&work, InstallScope::Items { items: vec![2] }, 5))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Failed));
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Failed);
}

#[tokio::test]
async fn items_already_pinned_are_skipped_and_unpinned_ones_get_pinned() {
    let s = TestServer::start();
    serve_items(&s, 1, 3);
    let env = TestEnv::new();
    // Item 1 was pinned before; item 2 is stream-cached (unpinned) and on disk.
    env.user
        .pack_item_upsert(&quran_core::PackItemRow {
            pack_id: PACK.into(),
            item: "p1".into(),
            bytes: 10_000,
            sha256: "aa".into(),
            pinned: true,
            fetched_at: 1,
            last_used_at: 1,
        })
        .unwrap();
    env.user
        .pack_item_upsert(&quran_core::PackItemRow {
            pack_id: PACK.into(),
            item: "p2".into(),
            bytes: 10_000,
            sha256: "bb".into(),
            pinned: false,
            fetched_at: 1,
            last_used_at: 1,
        })
        .unwrap();
    let dest2 = ItemsWork::dest(&env.root, PACK, 2);
    std::fs::create_dir_all(dest2.parent().unwrap()).unwrap();
    std::fs::write(&dest2, bytes(10_000, 2)).unwrap();

    let work = Arc::new(ItemsWork::new(s.url("/i"), 3));
    let q = queue(&env, &work, 3, 2);
    let id = q
        .enqueue(job_spec(&work, InstallScope::All, 3))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(work.calls.load(Ordering::SeqCst), 2, "p1 skipped");
    assert_eq!(s.hits("/i/1") + s.hits("/i/2"), 0);
    let items = env.user.pack_items(PACK).unwrap();
    assert!(items.iter().all(|i| i.pinned));
    assert_eq!(items[1].sha256, "bb", "a present item keeps its hash");
    assert_eq!(
        env.user.pack_installed(PACK).unwrap().unwrap().status,
        InstalledStatus::Installed
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_keeps_temps_and_resume_continues_them() {
    let s = TestServer::start();
    s.route("/r/1", Route::bytes(bytes(50_000, 1)).etag("\"1\""));
    s.route(
        "/r/2",
        Route::bytes(bytes(2 * 1024 * 1024, 2))
            .etag("\"2\"")
            .throttle(32 * 1024, Duration::from_millis(10)),
    );
    s.route("/r/3", Route::bytes(bytes(50_000, 3)).etag("\"3\""));
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/r"), 3).resumable());
    let q = queue(&env, &work, 3, 1);
    let id = q
        .enqueue(job_spec(&work, InstallScope::All, 3))
        .await
        .unwrap();
    let dest2 = ItemsWork::dest(&env.root, PACK, 2);
    let sidecar = install::dl_sidecar_path(&dest2);
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
    assert_eq!(env.recorder.lifecycle(id), ["queued", "started", "paused"]);
    assert!(install::dl_part_path(&dest2).exists() && sidecar.exists());
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Paused);
    assert_eq!((row.items_present, row.items_total), (1, 3));
    assert_eq!(
        read_journal(&env.root, PACK).await.unwrap().state,
        JournalState::Paused
    );
    // The paused progress is what is on disk: item 1 and the part of item 2 that the resume continues from, out of
    // item 1, item 2's real length and item 3's estimate (it used to drop item 2: "Paused · 59 of 59 KiB").
    let paused = q.snapshot(PACK).unwrap();
    assert_eq!(paused.phase, JobPhase::Paused);
    let kib = |bytes: u64| u32::try_from(bytes / 1024).unwrap();
    assert!(
        paused.received_kib >= kib(50_000 + 1024 * 1024),
        "{paused:?}"
    );
    assert_eq!(
        paused.total_kib,
        kib(50_000 + 2 * 1024 * 1024 + 10_000 + 1023),
        "{paused:?}"
    );
    assert!(paused.received_kib < paused.total_kib, "{paused:?}");
    assert!(
        q.job_items(PACK).is_some(),
        "a paused job still lists its items"
    );
    q.pause(PACK).await.unwrap();

    s.clear_log();
    let id = q.resume(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(s.hits("/r/1"), 0, "a recorded item is not fetched again");
    let r2 = s.requests_to("/r/2");
    assert_eq!(r2.len(), 1);
    assert!(r2[0].header("range").is_some_and(|r| r != "bytes=0-"));
    assert_eq!(
        sha256_hex(&std::fs::read(&dest2).unwrap()),
        sha256_hex(&bytes(2 * 1024 * 1024, 2))
    );
    assert_eq!(
        env.user.pack_installed(PACK).unwrap().unwrap().status,
        InstalledStatus::Installed
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_deletes_temps_and_drops_an_empty_pack() {
    let s = TestServer::start();
    s.route(
        "/r/1",
        Route::bytes(bytes(2 * 1024 * 1024, 1))
            .etag("\"1\"")
            .throttle(32 * 1024, Duration::from_millis(10)),
    );
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/r"), 2).resumable());
    let q = queue(&env, &work, 2, 1);
    let id = q
        .enqueue(job_spec(&work, InstallScope::Items { items: vec![1] }, 2))
        .await
        .unwrap();
    let dest = ItemsWork::dest(&env.root, PACK, 1);
    assert!(
        eventually(Duration::from_secs(20), || install::dl_sidecar_path(&dest)
            .exists())
        .await
    );
    q.cancel(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Cancelled));
    assert_eq!(
        env.recorder.lifecycle(id),
        ["queued", "started", "cancelled"]
    );
    assert!(!install::dl_part_path(&dest).exists());
    assert!(!install::dl_sidecar_path(&dest).exists());
    assert!(!install::staging_dir(&env.root, PACK).unwrap().exists());
    assert!(env.user.pack_installed(PACK).unwrap().is_none());
    assert!(q.snapshot(PACK).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queued_job_can_be_paused_before_it_starts() {
    let s = TestServer::start();
    let gate = support::http::Gate::new();
    s.route("/g/1", Route::bytes(bytes(100, 1)).gated(&gate));
    serve_items(&s, 1, 1);
    let env = TestEnv::new();
    let blocker: Arc<dyn PackWork> = Arc::new(ItemsWork::new(s.url("/g"), 1));
    let work = Arc::new(ItemsWork::new(s.url("/i"), 1));
    let source = spec_source(vec![
        (
            "p.blocker",
            PackKind::MushafFonts,
            Arc::clone(&blocker),
            1,
            100,
        ),
        (
            PACK,
            PackKind::Recitation,
            Arc::clone(&work) as Arc<dyn PackWork>,
            1,
            10_000,
        ),
    ]);
    let q = env.queue(source, 1, 1);
    let first = q
        .enqueue(spec(
            "p.blocker",
            PackKind::MushafFonts,
            blocker,
            InstallScope::All,
            1,
            100,
        ))
        .await
        .unwrap();
    let second = q
        .enqueue(job_spec(&work, InstallScope::All, 1))
        .await
        .unwrap();
    q.pause(PACK).await.unwrap();
    assert_eq!(q.wait(second).await, Some(JobPhase::Paused));
    assert_eq!(env.recorder.lifecycle(second), ["queued", "paused"]);
    gate.open();
    assert_eq!(q.wait(first).await, Some(JobPhase::Completed));
    assert_eq!(work.calls.load(Ordering::SeqCst), 0, "never started");
    let id = q.resume(PACK).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
}

#[tokio::test]
async fn restore_resumes_interrupted_jobs_and_keeps_paused_ones() {
    let s = TestServer::start();
    serve_items(&s, 1, 2);
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new(s.url("/i"), 2));
    let other = Arc::new(ItemsWork::new(s.url("/i"), 2));
    let source = spec_source(vec![
        (
            PACK,
            PackKind::Recitation,
            Arc::clone(&work) as Arc<dyn PackWork>,
            2,
            20_000,
        ),
        (
            "mushaf.v2",
            PackKind::MushafFonts,
            Arc::clone(&other) as Arc<dyn PackWork>,
            2,
            20_000,
        ),
    ]);
    // Journals left by a previous run: one interrupted, one paused, one for a pack that left the catalog.
    let write = |pack: &str, state: JournalState| {
        let dir = install::staging_dir(&env.root, pack).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let j = JobJournal {
            pack_id: pack.into(),
            scope: InstallScope::All,
            pin: true,
            state,
            error: None,
            created_at: 1,
            updated_at: 1,
        };
        std::fs::write(dir.join("job.json"), serde_json::to_vec(&j).unwrap()).unwrap();
    };
    write(PACK, JournalState::Active);
    write("mushaf.v2", JournalState::Paused);
    write("tr.xx.gone", JournalState::Active);

    let q = env.queue(source, 3, 2);
    let ids = q.restore().await.unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(q.wait(ids[0]).await, Some(JobPhase::Completed));
    assert_eq!(
        env.user.pack_installed(PACK).unwrap().unwrap().status,
        InstalledStatus::Installed
    );
    assert!(
        !install::staging_dir(&env.root, "tr.xx.gone")
            .unwrap()
            .exists()
    );
    let paused = q.snapshot("mushaf.v2").unwrap();
    assert_eq!(paused.phase, JobPhase::Paused);
    assert_eq!(other.calls.load(Ordering::SeqCst), 0);

    // A restored paused job resumes on request.
    let id = q.resume("mushaf.v2").await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
}

#[tokio::test]
async fn cancelling_a_job_known_only_from_its_journal_cleans_up() {
    let env = TestEnv::new();
    let work = Arc::new(ItemsWork::new("http://127.0.0.1:9/i".into(), 2));
    let q = queue(&env, &work, 2, 1);
    let dir = install::staging_dir(&env.root, PACK).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let j = JobJournal {
        pack_id: PACK.into(),
        scope: InstallScope::Items { items: vec![1] },
        pin: true,
        state: JournalState::Paused,
        error: None,
        created_at: 1,
        updated_at: 1,
    };
    std::fs::write(dir.join("job.json"), serde_json::to_vec(&j).unwrap()).unwrap();
    let dest = ItemsWork::dest(&env.root, PACK, 1);
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(install::dl_part_path(&dest), b"partial").unwrap();
    std::fs::write(install::dl_sidecar_path(&dest), b"{}").unwrap();

    q.cancel(PACK).await.unwrap();
    assert!(!dir.exists());
    assert!(!install::dl_part_path(&dest).exists());
    assert!(!install::dl_sidecar_path(&dest).exists());
    assert_eq!(env.recorder.events().len(), 1, "one cancelled event");
    assert!(matches!(
        q.cancel(PACK).await,
        Err(quran_packs::PackError::NotFound(_))
    ));
}
