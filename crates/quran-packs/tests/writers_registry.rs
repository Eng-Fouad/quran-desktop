//! The single-writer registry for audio files (docs/ARCHITECTURE.md §2.5.5, §2.3.7): a job item waits for a live
//! stream (at most the stream wait) and then only pins a promoted file; a stream may start while a job writes; two jobs
//! never write one file; waiting is cancellable. Owner: WP5b.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use quran_core::InstalledStatus;
use quran_packs::PackError;
use quran_packs::adapters::{AdapterCtx, ItemKey, ItemOutcome, StagedPack};
use quran_packs::http::{Expect, Request};
use quran_packs::install;
use quran_packs::jobs::{JobHandle, PackWork};
use quran_packs::writers::{WriterInfo, Writers};
use quran_types::{InstallScope, JobPhase, PackKind};
use support::http::{Route, TestServer};
use support::work::{spec, spec_source};
use support::{TestEnv, bytes, eventually};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_waits_for_the_live_stream_and_learns_what_it_promoted() {
    let w = Writers::new();
    w.stream_begin(7, 2);
    assert!(w.is_streaming(7, 2));
    let claim = {
        let w = w.clone();
        tokio::spawn(async move { w.claim_job(7, 2, None).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!claim.is_finished(), "waits while the stream writes");
    w.stream_end(7, 2, Some(4_321));
    let claim = tokio::time::timeout(Duration::from_secs(5), claim)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(claim.waited_for_stream());
    assert_eq!(claim.promoted_bytes(), Some(4_321));
    assert!(!claim.stream_still_live());
    assert_eq!(
        w.info(7, 2),
        WriterInfo {
            streams: 0,
            job: true
        }
    );
    drop(claim);
    assert_eq!(w.info(7, 2), WriterInfo::default());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_abandoned_stream_promotes_nothing() {
    let w = Writers::new();
    w.stream_begin(7, 3);
    let claim = {
        let w = w.clone();
        tokio::spawn(async move { w.claim_job(7, 3, None).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    w.stream_end(7, 3, None);
    let claim = claim.await.unwrap().unwrap();
    assert!(claim.waited_for_stream());
    assert_eq!(claim.promoted_bytes(), None);
}

#[tokio::test]
async fn the_wait_for_a_stream_is_bounded() {
    let w = Writers::new();
    w.stream_begin(7, 4);
    let t = Instant::now();
    let claim = w
        .claim_job_within(7, 4, None, Duration::from_millis(150))
        .await
        .unwrap();
    assert!(t.elapsed() >= Duration::from_millis(150));
    assert!(claim.waited_for_stream());
    assert!(claim.stream_still_live(), "first complete wins from here");
    assert_eq!(
        w.info(7, 4),
        WriterInfo {
            streams: 1,
            job: true
        }
    );
}

#[tokio::test]
async fn a_stream_may_start_while_a_job_writes() {
    let w = Writers::new();
    let claim = w.claim_job(9, 1, None).await.unwrap();
    w.stream_begin(9, 1);
    assert_eq!(
        w.info(9, 1),
        WriterInfo {
            streams: 1,
            job: true
        }
    );
    assert_eq!(w.live_streams(), [(9, 1)]);
    w.stream_end(9, 1, Some(10));
    drop(claim);
    assert!(w.live_streams().is_empty());
    assert_eq!(w.info(9, 1), WriterInfo::default());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_jobs_never_write_one_file_at_once() {
    let w = Writers::new();
    let first = w.claim_job(7, 5, None).await.unwrap();
    let second = {
        let w = w.clone();
        tokio::spawn(async move {
            w.claim_job_within(7, 5, None, Duration::from_millis(10))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!second.is_finished(), "no time limit between jobs");
    drop(first);
    let second = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!second.waited_for_stream());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn waiting_is_cancellable() {
    let w = Writers::new();
    w.stream_begin(7, 6);
    let job = JobHandle::detached(1, "audio.qdc.7");
    let waiter = {
        let (w, job) = (w.clone(), job.clone());
        tokio::spawn(async move { w.claim_job(7, 6, Some(&job)).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    job.request_cancel();
    let err = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(matches!(err, PackError::Cancelled));
    w.stream_end(7, 6, None);
    assert_eq!(w.info(7, 6), WriterInfo::default());
}

/// An audio-like item: claim the writer, then only pin a promoted file of the expected length, else download.
struct StreamAwareAudio {
    url: String,
    expected: u64,
    downloads: Arc<AtomicU32>,
}

impl StreamAwareAudio {
    fn dest(root: &Path, surah: u32) -> PathBuf {
        install::audio_path(root, 7, surah)
    }
}

impl PackWork for StreamAwareAudio {
    fn items(&self, scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        match scope {
            InstallScope::Items { items } => Ok(items.iter().map(|&n| ItemKey::Surah(n)).collect()),
            InstallScope::All => Ok(vec![ItemKey::Surah(1)]),
        }
    }

    fn whole(&self) -> bool {
        false
    }

    fn fetch_item<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>> {
        Box::pin(async move {
            let ItemKey::Surah(surah) = item else {
                return Err(PackError::Unsupported(item.to_string()));
            };
            let claim = ctx
                .writers
                .claim_job_within(7, *surah, ctx.job.as_ref(), Duration::from_secs(10))
                .await?;
            let dest = Self::dest(&ctx.packs_root, *surah);
            if claim.promoted_bytes() == Some(self.expected)
                && install::file_len(&dest).await == Some(self.expected)
            {
                return Ok(ItemOutcome::Present {
                    bytes: self.expected,
                });
            }
            self.downloads.fetch_add(1, Ordering::SeqCst);
            let urls = vec![self.url.clone()];
            let done = ctx
                .http
                .download(
                    Request::for_ctx(ctx, &urls),
                    &dest,
                    &Expect::default().len(self.expected).keep_existing(),
                )
                .await?;
            drop(claim);
            Ok(ItemOutcome::Stored {
                bytes: done.bytes,
                sha256: done.sha256,
            })
        })
    }

    fn install_whole<'a>(
        &'a self,
        _ctx: &'a AdapterCtx,
        _staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>> {
        Box::pin(async { Err(PackError::Unsupported("per item".into())) })
    }

    fn temp_paths(&self, root: &Path, item: &ItemKey) -> Vec<PathBuf> {
        match item {
            ItemKey::Surah(n) => {
                let d = Self::dest(root, *n);
                vec![install::dl_part_path(&d), install::dl_sidecar_path(&d)]
            }
            _ => Vec::new(),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_job_item_only_pins_what_a_live_stream_promoted() {
    let s = TestServer::start();
    let file = bytes(80_000, 1);
    s.route("/002.mp3", Route::bytes(file.clone()));
    let env = TestEnv::new();
    let work = Arc::new(StreamAwareAudio {
        url: s.url("/002.mp3"),
        expected: 80_000,
        downloads: Arc::new(AtomicU32::new(0)),
    });
    let w: Arc<dyn PackWork> = Arc::clone(&work) as Arc<dyn PackWork>;
    let q = env.queue(
        spec_source(vec![(
            "audio.qdc.7",
            PackKind::Recitation,
            Arc::clone(&w),
            114,
            1_680_759_654,
        )]),
        3,
        2,
    );
    // The player streams surah 2 when the user asks to download it.
    env.writers.stream_begin(7, 2);
    let id = q
        .enqueue(spec(
            "audio.qdc.7",
            PackKind::Recitation,
            w,
            InstallScope::Items { items: vec![2] },
            114,
            1_680_759_654,
        ))
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(5), || q
            .snapshot("audio.qdc.7")
            .is_some_and(|s| s.phase == JobPhase::Downloading))
        .await
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(s.hits("/002.mp3"), 0, "the job waits for the stream");
    // The stream completes and promotes the file (its own `.stream.part` renamed into place).
    let dest = StreamAwareAudio::dest(&env.root, 2);
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(&dest, &file).unwrap();
    env.writers.stream_end(7, 2, Some(80_000));
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(
        work.downloads.load(Ordering::SeqCst),
        0,
        "nothing downloaded twice"
    );
    assert_eq!(s.hits("/002.mp3"), 0);
    let item = env.user.pack_item("audio.qdc.7", "002").unwrap().unwrap();
    assert!(item.pinned, "the promoted file is pinned");
    assert_eq!(item.bytes, 80_000);
    let row = env.user.pack_installed("audio.qdc.7").unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Partial);
    assert_eq!(env.writers.info(7, 2), WriterInfo::default());

    // Without a stream the job downloads it.
    let id = q
        .enqueue(spec(
            "audio.qdc.7",
            PackKind::Recitation,
            Arc::clone(&work) as Arc<dyn PackWork>,
            InstallScope::Items { items: vec![3] },
            114,
            1_680_759_654,
        ))
        .await
        .unwrap();
    s.route("/002.mp3", Route::bytes(file.clone()));
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(work.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read(StreamAwareAudio::dest(&env.root, 3)).unwrap(),
        file
    );
}
