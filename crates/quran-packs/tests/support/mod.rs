//! Shared helpers for the quran-packs integration tests (`tests/*.rs` include them with `mod support;`).
//!
//! - [`http`]: the in-repo HTTP test server ([`http::TestServer`], [`http::Route`], [`http::Action`],
//!   [`http::Gate`], [`http::closed_port_url`]).
//! - [`TestEnv`]: a temp data dir with `packs/`, a real `UserDb` and `ContentDb`, an unavailable `CoreDb`, a fast
//!   [`Http`] and a [`Recorder`] that captures every job event; [`TestEnv::queue`] builds a `JobQueue` on it.
//! - [`work`]: a fake [`quran_packs::jobs::PackWork`] that downloads items from the test server through the real HTTP
//!   layer (per-item files and a whole pack), for job and manager tests.
//!
//! Every test crate compiles this module but uses only part of it, hence the `dead_code` allowance.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

pub mod http;
pub mod work;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use quran_core::{ContentDb, CoreDb, UserDb};
use quran_packs::AdapterCtx;
use quran_packs::http::{Http, HttpConfig};
use quran_packs::jobs::{JobEnv, JobHandle, JobObserver, JobQueue, SpecSource};
use quran_packs::writers::Writers;
use quran_types::{DownloadEvent, PackKind};

/// An HTTP config with test-sized waits: backoff 20/40/80 ms, probe every 100 ms, connect timeout 2 s, idle read 5 s.
pub fn fast_http_config() -> HttpConfig {
    let mut c = HttpConfig::new("QuranForDesktop/test");
    c.backoff = vec![
        Duration::from_millis(20),
        Duration::from_millis(40),
        Duration::from_millis(80),
    ];
    c.probe_interval = Duration::from_millis(100);
    c.connect_timeout = Duration::from_secs(2);
    c.read_timeout = Duration::from_secs(5);
    c
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Captures everything a job queue reports.
#[derive(Default)]
pub struct Recorder {
    events: Mutex<Vec<DownloadEvent>>,
    changed: Mutex<Vec<Vec<String>>>,
    released: Mutex<Vec<String>>,
}

impl Recorder {
    pub fn events(&self) -> Vec<DownloadEvent> {
        lock(&self.events).clone()
    }

    pub fn events_for(&self, job_id: u32) -> Vec<DownloadEvent> {
        self.events()
            .into_iter()
            .filter(|e| event_job(e) == job_id)
            .collect()
    }

    /// Event names of one job without `progress` (`["queued", "started", "completed"]`).
    pub fn lifecycle(&self, job_id: u32) -> Vec<&'static str> {
        self.events_for(job_id)
            .iter()
            .map(event_name)
            .filter(|n| *n != "progress")
            .collect()
    }

    pub fn changed(&self) -> Vec<Vec<String>> {
        lock(&self.changed).clone()
    }

    pub fn released(&self) -> Vec<String> {
        lock(&self.released).clone()
    }

    pub fn clear(&self) {
        lock(&self.events).clear();
        lock(&self.changed).clear();
        lock(&self.released).clear();
    }
}

impl JobObserver for Recorder {
    fn download(&self, e: DownloadEvent) {
        lock(&self.events).push(e);
    }

    fn packs_changed(&self, pack_ids: Vec<String>) {
        lock(&self.changed).push(pack_ids);
    }

    fn release_pack(&self, pack_id: &str) {
        lock(&self.released).push(pack_id.to_owned());
    }
}

pub fn event_job(e: &DownloadEvent) -> u32 {
    match e {
        DownloadEvent::Queued { job_id, .. }
        | DownloadEvent::Started { job_id, .. }
        | DownloadEvent::Progress { job_id, .. }
        | DownloadEvent::Verifying { job_id, .. }
        | DownloadEvent::Installing { job_id, .. }
        | DownloadEvent::Paused { job_id, .. }
        | DownloadEvent::Completed { job_id, .. }
        | DownloadEvent::Failed { job_id, .. }
        | DownloadEvent::Cancelled { job_id, .. } => *job_id,
    }
}

pub fn event_name(e: &DownloadEvent) -> &'static str {
    match e {
        DownloadEvent::Queued { .. } => "queued",
        DownloadEvent::Started { .. } => "started",
        DownloadEvent::Progress { .. } => "progress",
        DownloadEvent::Verifying { .. } => "verifying",
        DownloadEvent::Installing { .. } => "installing",
        DownloadEvent::Paused { .. } => "paused",
        DownloadEvent::Completed { .. } => "completed",
        DownloadEvent::Failed { .. } => "failed",
        DownloadEvent::Cancelled { .. } => "cancelled",
    }
}

/// A temp data dir with everything a job or adapter needs.
pub struct TestEnv {
    pub dir: tempfile::TempDir,
    /// `<dir>/packs`.
    pub root: PathBuf,
    pub user: UserDb,
    pub content: ContentDb,
    pub core: CoreDb,
    pub http: Http,
    pub writers: Writers,
    pub recorder: Arc<Recorder>,
}

impl TestEnv {
    pub fn new() -> Self {
        Self::with_http(fast_http_config())
    }

    pub fn with_http(cfg: HttpConfig) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("packs");
        std::fs::create_dir_all(&root).unwrap();
        let user = UserDb::open(&dir.path().join("user.db")).unwrap();
        let content = ContentDb::open(&dir.path().join("content.db")).unwrap();
        Self {
            root,
            user,
            content,
            core: CoreDb::unavailable("tests run without core.db".into()),
            http: Http::new(cfg).unwrap(),
            writers: Writers::new(),
            recorder: Arc::new(Recorder::default()),
            dir,
        }
    }

    /// The environment jobs run against, on the current tokio runtime.
    pub fn job_env(&self) -> JobEnv {
        JobEnv {
            packs_root: self.root.clone(),
            http: self.http.clone(),
            core: self.core.clone(),
            user: self.user.clone(),
            content: self.content.clone(),
            writers: self.writers.clone(),
            runtime: tokio::runtime::Handle::current(),
            observer: self.recorder.clone(),
        }
    }

    /// A queue with the given limits and spec source.
    pub fn queue(
        &self,
        specs: SpecSource,
        max_running: usize,
        item_concurrency: usize,
    ) -> JobQueue {
        JobQueue::with_limits(self.job_env(), specs, max_running, item_concurrency)
    }

    /// An adapter context on this environment.
    pub fn ctx(
        &self,
        pack_id: &str,
        kind: PackKind,
        job: Option<JobHandle>,
        pin: bool,
    ) -> AdapterCtx {
        AdapterCtx {
            pack_id: pack_id.to_owned(),
            kind,
            packs_root: self.root.clone(),
            http: self.http.clone(),
            core: self.core.clone(),
            user: self.user.clone(),
            content: self.content.clone(),
            writers: self.writers.clone(),
            job,
            pin,
        }
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        rel.split('/').fold(self.root.clone(), |p, seg| p.join(seg))
    }
}

/// Deterministic pseudo-random bytes (so a wrong offset changes the hash).
pub fn bytes(len: usize, seed: u8) -> Vec<u8> {
    let mut x: u32 = 0x9E37_79B9 ^ u32::from(seed);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x.to_le_bytes()[0]
        })
        .collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(data))
}

/// Polls `cond` every 10 ms until it holds or `timeout` passes.
pub async fn eventually(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub fn exists(p: &Path) -> bool {
    p.exists()
}
