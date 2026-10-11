//! The job queue (docs/ARCHITECTURE.md §2.5.5 "Lanes", "Progress"): FIFO with at most 3 running, one job per pack,
//! the event lifecycle, throttled progress with rate and ETA, snapshots and `wait`. Owner: WP5b.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use quran_packs::PackError;
use quran_packs::jobs::{JobQueue, PackWork};
use quran_types::{DownloadEvent, InstallScope, JobPhase, PackKind};
use support::http::{Gate, Route, TestServer};
use support::work::{ItemsWork, spec, spec_source};
use support::{TestEnv, bytes, event_name};

fn items_queue(
    env: &TestEnv,
    works: &[(&str, Arc<dyn PackWork>, u32)],
    max_running: usize,
) -> JobQueue {
    let source = spec_source(
        works
            .iter()
            .map(|(id, w, n)| {
                (
                    *id,
                    PackKind::MushafFonts,
                    Arc::clone(w),
                    *n,
                    u64::from(*n) * 1000,
                )
            })
            .collect(),
    );
    env.queue(source, max_running, 2)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_max_running_jobs_run_in_fifo_order() {
    let s = TestServer::start();
    let gate = Gate::new();
    s.route("/g/1", Route::bytes(bytes(1000, 1)).gated(&gate));
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(ItemsWork::new(s.url("/g"), 1));
    let ids = ["p.a", "p.b", "p.c", "p.d"];
    let q = items_queue(
        &env,
        &ids.iter()
            .map(|id| (*id, Arc::clone(&work), 1))
            .collect::<Vec<_>>(),
        3,
    );
    let mut jobs = Vec::new();
    for id in ids {
        jobs.push(
            q.enqueue(spec(
                id,
                PackKind::MushafFonts,
                Arc::clone(&work),
                InstallScope::All,
                1,
                1000,
            ))
            .await
            .unwrap(),
        );
    }
    assert!(support::eventually(Duration::from_secs(5), || gate.waiting() == 3).await);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(gate.waiting(), 3, "3 running");
    let snaps = q.jobs();
    assert_eq!(snaps.len(), 4);
    assert_eq!(snaps[3].pack_id, "p.d");
    assert_eq!(snaps[3].phase, JobPhase::Queued);
    assert!(snaps[..3].iter().all(|s| s.phase == JobPhase::Downloading));
    gate.open();
    for id in &jobs {
        assert_eq!(q.wait(*id).await, Some(JobPhase::Completed));
    }
    let started: Vec<u32> = env
        .recorder
        .events()
        .iter()
        .filter_map(|e| match e {
            DownloadEvent::Started { job_id, .. } => Some(*job_id),
            _ => None,
        })
        .collect();
    assert_eq!(started.len(), 4);
    assert_eq!(started[3], jobs[3], "the fourth starts last");
    assert!(q.jobs().is_empty(), "completed jobs leave the list");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_job_per_pack() {
    let s = TestServer::start();
    let gate = Gate::new();
    s.route("/g/1", Route::bytes(bytes(10, 1)).gated(&gate));
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(ItemsWork::new(s.url("/g"), 1));
    let q = items_queue(&env, &[("p.a", Arc::clone(&work), 1)], 3);
    let id = q
        .enqueue(spec(
            "p.a",
            PackKind::MushafFonts,
            Arc::clone(&work),
            InstallScope::All,
            1,
            10,
        ))
        .await
        .unwrap();
    assert!(q.is_active("p.a"));
    let err = q
        .enqueue(spec(
            "p.a",
            PackKind::MushafFonts,
            Arc::clone(&work),
            InstallScope::All,
            1,
            10,
        ))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Conflict(_)), "{err:?}");
    assert_eq!(
        q.resume("p.a").await.unwrap(),
        id,
        "resume of an active job is its id"
    );
    gate.open();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert!(!q.is_active("p.a"));
    assert_eq!(q.wait(9999).await, None);
}

#[tokio::test]
async fn a_job_reports_its_lifecycle() {
    let s = TestServer::start();
    for n in 1..=3 {
        s.route(&format!("/i/{n}"), Route::bytes(bytes(2048, n as u8)));
    }
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(ItemsWork::new(s.url("/i"), 3));
    let q = items_queue(&env, &[("p.a", Arc::clone(&work), 3)], 3);
    let id = q
        .enqueue(spec(
            "p.a",
            PackKind::MushafFonts,
            Arc::clone(&work),
            InstallScope::All,
            3,
            3000,
        ))
        .await
        .unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(
        env.recorder.lifecycle(id),
        ["queued", "started", "completed"]
    );
    let events = env.recorder.events_for(id);
    match &events[1] {
        DownloadEvent::Started {
            total_kib,
            items_total,
            pack_id,
            ..
        } => {
            assert_eq!(*items_total, 3);
            assert_eq!(*total_kib, 3, "the catalog estimate (3 × 1000 B)");
            assert_eq!(pack_id, "p.a");
        }
        e => panic!("{e:?}"),
    }
    let last_progress = events
        .iter()
        .rev()
        .find_map(|e| match e {
            DownloadEvent::Progress {
                received_kib,
                total_kib,
                items_done,
                items_total,
                ..
            } => Some((*received_kib, *total_kib, *items_done, *items_total)),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        last_progress,
        (6, 6, 3, 3),
        "the total follows the real sizes"
    );
    assert_eq!(env.recorder.changed(), [vec!["p.a".to_owned()]]);
    assert!(q.snapshot("p.a").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn progress_is_throttled_and_carries_rate_and_eta() {
    let s = TestServer::start();
    s.route(
        "/slow/1",
        Route::bytes(bytes(600 * 1024, 1)).throttle(8 * 1024, Duration::from_millis(10)),
    );
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(ItemsWork::new(s.url("/slow"), 1));
    let q = items_queue(&env, &[("p.a", Arc::clone(&work), 1)], 3);
    let t = Instant::now();
    let id = q
        .enqueue(spec(
            "p.a",
            PackKind::MushafFonts,
            Arc::clone(&work),
            InstallScope::All,
            1,
            600 * 1024,
        ))
        .await
        .unwrap();
    // A snapshot while it runs.
    assert!(
        support::eventually(Duration::from_secs(10), || q
            .snapshot("p.a")
            .is_some_and(|s| s.received_kib > 64 && s.rate_kib_s > 0))
        .await
    );
    let snap = q.snapshot("p.a").unwrap();
    assert_eq!(snap.phase, JobPhase::Downloading);
    assert!(snap.eta_s.is_some());
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    let elapsed = t.elapsed();
    let progress: Vec<DownloadEvent> = env
        .recorder
        .events_for(id)
        .into_iter()
        .filter(|e| event_name(e) == "progress")
        .collect();
    let max = (elapsed.as_millis() / 100) as usize + 2;
    assert!(
        progress.len() >= 3 && progress.len() <= max,
        "{} progress events in {elapsed:?}",
        progress.len()
    );
    assert!(progress.iter().any(|e| matches!(
        e,
        DownloadEvent::Progress {
            rate_kib_s,
            eta_s: Some(_),
            ..
        } if *rate_kib_s > 0
    )));
}

#[tokio::test]
async fn invalid_scopes_are_rejected_before_queueing() {
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(ItemsWork::new("http://127.0.0.1:9/x".into(), 3));
    let q = items_queue(&env, &[("p.a", Arc::clone(&work), 3)], 3);
    let err = q
        .enqueue(spec(
            "p.a",
            PackKind::MushafFonts,
            Arc::clone(&work),
            InstallScope::Items { items: vec![4] },
            3,
            3,
        ))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::NotFound(_)));
    let err = q
        .enqueue(spec(
            "../evil",
            PackKind::MushafFonts,
            work,
            InstallScope::All,
            3,
            3,
        ))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Catalog(_)));
    assert!(q.jobs().is_empty());
    assert!(env.recorder.events().is_empty());
}

#[tokio::test]
async fn pause_cancel_and_resume_need_a_job() {
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(ItemsWork::new("http://127.0.0.1:9/x".into(), 1));
    let q = items_queue(&env, &[("p.a", work, 1)], 3);
    assert!(matches!(q.pause("p.a").await, Err(PackError::NotFound(_))));
    assert!(matches!(q.cancel("p.a").await, Err(PackError::NotFound(_))));
    assert!(matches!(q.resume("p.a").await, Err(PackError::NotFound(_))));
}
