//! Background jobs (docs/ARCHITECTURE.md §2.5.5). Owner: WP5b.
//!
//! - **Queue.** FIFO, one job per pack, at most [`MAX_RUNNING`] (3) running; within a job up to [`ITEM_CONCURRENCY`]
//!   items download at once (the HTTP layer's limits still apply). Interactive work never waits for the queue.
//! - **Handle.** Each job has `Arc<AtomicBool>`-style cancel and pause flags plus a `Notify`, checked by the HTTP layer
//!   between 64 KiB chunks and while it waits (permits, backoff, a live stream). Adapters see the job through
//!   [`JobHandle`] (`AdapterCtx::job`).
//! - **Progress.** Bytes are aggregated per job (resumed bytes count as progress but not as rate);
//!   `DownloadEvent::Progress` is emitted at most every 100 ms with `rate_kib_s` as an EWMA over 3 s and an ETA.
//!   Totals start from the catalog estimate and are corrected per item as soon as its real length is known.
//! - **Per-item packs** (fonts, decor, recitations, Quran.com chapters): items already recorded in `pack_item` (pinned,
//!   for a pinning job) are skipped, so a resumed job continues where it stopped. 3 failed items (or every item of a
//!   smaller job) fail the job; completed items are kept.
//! - **Whole packs** (QuranEnc): the adapter builds `pack.db` in `packs/.staging/{packId}/`, then the atomic flip of
//!   [`install::flip_whole`] installs it.
//! - **Pause** keeps the staging directory and `.dl.part` temps and sets `installed_pack.status = 'paused'`; **cancel**
//!   deletes them; **resume** (also "Retry" after a failure) enqueues the same scope again.
//! - **Journal.** An unfinished job is recorded in `packs/.staging/{packId}/job.json` ([`JobJournal`]) from enqueue to
//!   completion, so [`JobQueue::restore`] resumes interrupted jobs after a restart and keeps paused/failed ones (with
//!   their error) resumable.
//!
//! **Registry policy** (what the runner writes; `PackManager` derives `PackState` from it):
//! - per-item packs: each item → `pack_item` (`pinned` = the job's `pin`; an item an adapter reports `Present` keeps an
//!   existing pin). At the end, `installed_pack` = `installed` when every catalog item is present and pinned, else
//!   `partial` (`items_present`/`bytes` count pinned items); `paused`/`failed` while the job is paused/failed; no row
//!   when nothing is pinned after a cancel;
//! - whole packs: the flip writes `installed`. A paused or failed job sets `paused`/`failed` only when no version is
//!   installed (an update that stops leaves the installed version untouched); a cancel deletes such a row.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::FuturesUnordered;
use parking_lot::Mutex;
use quran_core::{ContentDb, CoreDb, InstalledPackRow, InstalledStatus, PackItemRow, UserDb};
use quran_types::{AppError, DownloadEvent, InstallScope, JobPhase, JobSnapshot, PackKind};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::PackError;
use crate::adapters::{Adapter, AdapterCtx, ItemKey, ItemOutcome, StagedPack};
use crate::catalog::{Catalog, CatalogPack};
use crate::http::Http;
use crate::install::{self, Staging};
use crate::writers::Writers;

/// Jobs running at once.
pub const MAX_RUNNING: usize = 3;
/// Items of one job downloading at once.
pub const ITEM_CONCURRENCY: usize = 4;
/// Failed items that fail a job.
pub const MAX_FAILED_ITEMS: u32 = 3;
/// Minimum spacing of `DownloadEvent::Progress` per job.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Time constant of the rate EWMA.
pub const RATE_WINDOW: Duration = Duration::from_secs(3);
/// Terminal outcomes remembered for [`JobQueue::wait`].
const OUTCOMES_KEPT: usize = 256;

// ---------------------------------------------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------------------------------------------

/// What an adapter (and the HTTP layer) sees of the job it works for. Cheap to clone. An item-scoped handle
/// ([`Self::for_item`]) also corrects the job's byte total once the item's real length is known.
#[derive(Clone)]
pub struct JobHandle {
    shared: Arc<JobShared>,
    item: Option<Arc<ItemProgress>>,
}

struct JobShared {
    job_id: u32,
    pack_id: String,
    cancel: AtomicBool,
    pause: AtomicBool,
    /// Internal: the job already failed, in-flight items stop (not a user action).
    abort: AtomicBool,
    wake: Notify,
    received: AtomicU64,
    /// Bytes counted in `received` that came from disk (resume), excluded from the rate.
    resumed: AtomicU64,
    total: AtomicU64,
    items_done: AtomicU32,
    items_total: AtomicU32,
    status: Mutex<Status>,
    observer: Option<Arc<dyn JobObserver>>,
}

struct Status {
    phase: JobPhase,
    error: Option<AppError>,
    rate_kib_s: u32,
    eta_s: Option<u32>,
}

struct ItemProgress {
    estimate: u64,
    received: AtomicU64,
    /// The real length once known (`set_expected_len`).
    expected: Mutex<Option<u64>>,
}

impl JobHandle {
    fn new(job_id: u32, pack_id: &str, observer: Option<Arc<dyn JobObserver>>) -> Self {
        Self {
            shared: Arc::new(JobShared {
                job_id,
                pack_id: pack_id.to_owned(),
                cancel: AtomicBool::new(false),
                pause: AtomicBool::new(false),
                abort: AtomicBool::new(false),
                wake: Notify::new(),
                received: AtomicU64::new(0),
                resumed: AtomicU64::new(0),
                total: AtomicU64::new(0),
                items_done: AtomicU32::new(0),
                items_total: AtomicU32::new(0),
                status: Mutex::new(Status {
                    phase: JobPhase::Queued,
                    error: None,
                    rate_kib_s: 0,
                    eta_s: None,
                }),
                observer,
            }),
            item: None,
        }
    }

    /// A handle outside any queue (tests, one-off adapter runs): tracks progress and stop requests, emits nothing.
    #[must_use]
    pub fn detached(job_id: u32, pack_id: &str) -> Self {
        let h = Self::new(job_id, pack_id, None);
        h.shared.status.lock().phase = JobPhase::Downloading;
        h
    }

    /// A handle for one item of this job: its byte total starts at `estimate` and is replaced by the real length the
    /// first time [`Self::set_expected_len`] is called through it.
    #[must_use]
    pub fn for_item(&self, estimate: u64) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            item: Some(Arc::new(ItemProgress {
                estimate,
                received: AtomicU64::new(0),
                expected: Mutex::new(None),
            })),
        }
    }

    #[must_use]
    pub fn job_id(&self) -> u32 {
        self.shared.job_id
    }

    #[must_use]
    pub fn pack_id(&self) -> &str {
        &self.shared.pack_id
    }

    /// Asks the job to stop and discard its temps.
    pub fn request_cancel(&self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
        self.shared.wake.notify_waiters();
    }

    /// Asks the job to stop and keep its temps for a resume.
    pub fn request_pause(&self) {
        self.shared.pause.store(true, Ordering::SeqCst);
        self.shared.wake.notify_waiters();
    }

    fn abort_items(&self) {
        self.shared.abort.store(true, Ordering::SeqCst);
        self.shared.wake.notify_waiters();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.shared.cancel.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.shared.pause.load(Ordering::SeqCst)
    }

    /// Cancel or pause was requested (or the job already failed): stop at the next chunk.
    #[must_use]
    pub fn should_stop(&self) -> bool {
        self.is_cancelled() || self.is_paused() || self.shared.abort.load(Ordering::SeqCst)
    }

    /// `Err(PackError::Cancelled)` once the job should stop (pause and cancel alike; the runner tells them apart).
    pub fn check(&self) -> Result<(), PackError> {
        if self.should_stop() {
            Err(PackError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Resolves once the job should stop.
    pub async fn stopped(&self) {
        loop {
            let notified = self.shared.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.should_stop() {
                return;
            }
            notified.await;
        }
    }

    /// Sleeps unless the job stops first (`Err(Cancelled)`).
    pub async fn sleep(&self, d: Duration) -> Result<(), PackError> {
        self.check()?;
        tokio::select! {
            biased;
            () = self.stopped() => Err(PackError::Cancelled),
            () = tokio::time::sleep(d) => Ok(()),
        }
    }

    /// Bytes received from the network.
    pub fn add_received(&self, n: u64) {
        self.shared.received.fetch_add(n, Ordering::Relaxed);
        if let Some(item) = &self.item {
            item.received.fetch_add(n, Ordering::Relaxed);
        }
    }

    /// Bytes reused from an interrupted download: progress, but not rate.
    pub fn add_resumed(&self, n: u64) {
        self.add_received(n);
        self.shared.resumed.fetch_add(n, Ordering::Relaxed);
    }

    /// Takes back bytes of a failed attempt.
    pub fn rewind(&self, n: u64) {
        sub(&self.shared.received, n);
        if let Some(item) = &self.item {
            sub(&item.received, n);
        }
    }

    /// The item's download restarts from byte 0.
    pub fn restart_item(&self) {
        if let Some(item) = &self.item {
            let n = item.received.swap(0, Ordering::Relaxed);
            sub(&self.shared.received, n);
        }
    }

    /// The item's real length: replaces its estimate in the job total (once per item).
    pub fn set_expected_len(&self, len: u64) {
        let Some(item) = &self.item else {
            return;
        };
        let mut expected = item.expected.lock();
        let before = expected.unwrap_or(item.estimate);
        *expected = Some(len);
        adjust(&self.shared.total, before, len);
    }

    /// Reports a phase change (`Verifying`, `Installing`); emits the matching event once.
    pub fn set_phase(&self, phase: JobPhase) {
        let changed = {
            let mut st = self.shared.status.lock();
            let changed = st.phase != phase;
            st.phase = phase;
            changed
        };
        if !changed {
            return;
        }
        let (job_id, pack_id) = (self.job_id(), self.pack_id().to_owned());
        let event = match phase {
            JobPhase::Verifying => DownloadEvent::Verifying { job_id, pack_id },
            JobPhase::Installing => DownloadEvent::Installing { job_id, pack_id },
            _ => return,
        };
        self.emit(event);
    }

    #[must_use]
    pub fn phase(&self) -> JobPhase {
        self.shared.status.lock().phase
    }

    /// The IPC view of the job.
    #[must_use]
    pub fn snapshot(&self) -> JobSnapshot {
        let s = &self.shared;
        let received = s.received.load(Ordering::Relaxed);
        let total = s.total.load(Ordering::Relaxed).max(received);
        let st = s.status.lock();
        JobSnapshot {
            job_id: s.job_id,
            pack_id: s.pack_id.clone(),
            phase: st.phase,
            received_kib: kib_floor(received),
            total_kib: kib_ceil(total),
            items_done: s.items_done.load(Ordering::Relaxed),
            items_total: s.items_total.load(Ordering::Relaxed),
            rate_kib_s: st.rate_kib_s,
            eta_s: st.eta_s,
            error: st.error.clone(),
        }
    }

    fn emit(&self, e: DownloadEvent) {
        if let Some(o) = &self.shared.observer {
            o.download(e);
        }
    }

    fn init_progress(&self, items_total: usize, items_done: usize, received: u64, total: u64) {
        let s = &self.shared;
        s.items_total.store(
            u32::try_from(items_total).unwrap_or(u32::MAX),
            Ordering::Relaxed,
        );
        s.items_done.store(
            u32::try_from(items_done).unwrap_or(u32::MAX),
            Ordering::Relaxed,
        );
        s.received.store(received, Ordering::Relaxed);
        s.resumed.store(received, Ordering::Relaxed);
        s.total.store(total, Ordering::Relaxed);
    }

    fn item_done(&self) {
        self.shared.items_done.fetch_add(1, Ordering::Relaxed);
    }

    /// The item finished: its share of the total becomes what it actually transferred (`local` bytes found on disk
    /// count as transferred).
    fn settle_ok(&self, local: u64) {
        let Some(item) = &self.item else {
            return;
        };
        if local > 0 {
            self.add_resumed(local);
        }
        let got = item.received.load(Ordering::Relaxed);
        let share = item.expected.lock().unwrap_or(item.estimate);
        adjust(&self.shared.total, share, got);
    }

    /// The item stopped because the job was paused or cancelled: its bytes so far and its share stay in the totals,
    /// because its temps are kept for the resume, which continues from them. A paused job's progress is therefore what
    /// is on disk ("Paused · 29.9 of 111.6 MB"), not only its finished items'.
    fn settle_stopped(&self) {
        if let Some(item) = &self.item {
            log::trace!(
                "{}: item stopped with {} bytes kept",
                self.shared.pack_id,
                item.received.load(Ordering::Relaxed)
            );
        }
    }

    /// The item failed: it leaves the totals.
    fn settle_failed(&self) {
        let Some(item) = &self.item else {
            return;
        };
        let got = item.received.swap(0, Ordering::Relaxed);
        sub(&self.shared.received, got);
        let share = item.expected.lock().unwrap_or(item.estimate);
        sub(&self.shared.total, share);
    }

    fn set_rate(&self, rate_kib_s: u32, eta_s: Option<u32>) {
        let mut st = self.shared.status.lock();
        st.rate_kib_s = rate_kib_s;
        st.eta_s = eta_s;
    }

    fn set_final(&self, phase: JobPhase, error: Option<AppError>) {
        let mut st = self.shared.status.lock();
        st.phase = phase;
        st.error = error;
        st.rate_kib_s = 0;
        st.eta_s = None;
    }
}

impl std::fmt::Debug for JobHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobHandle")
            .field("job_id", &self.shared.job_id)
            .field("pack_id", &self.shared.pack_id)
            .field("phase", &self.phase())
            .finish_non_exhaustive()
    }
}

/// Applies `f` atomically (a CAS loop; it never fails).
fn update(a: &AtomicU64, f: impl Fn(u64) -> u64) {
    let mut current = a.load(Ordering::Relaxed);
    loop {
        match a.compare_exchange_weak(current, f(current), Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return,
            Err(actual) => current = actual,
        }
    }
}

/// `a -= n`, saturating at 0.
fn sub(a: &AtomicU64, n: u64) {
    update(a, |v| v.saturating_sub(n));
}

/// `a += to - from`, saturating at 0.
fn adjust(a: &AtomicU64, from: u64, to: u64) {
    update(a, |v| v.saturating_add(to).saturating_sub(from));
}

fn kib_floor(bytes: u64) -> u32 {
    u32::try_from(bytes / 1024).unwrap_or(u32::MAX)
}

fn kib_ceil(bytes: u64) -> u32 {
    u32::try_from(bytes.div_ceil(1024)).unwrap_or(u32::MAX)
}

// ---------------------------------------------------------------------------------------------------------------
// What a job runs, and for whom
// ---------------------------------------------------------------------------------------------------------------

/// Receives what jobs report (`PackManager` forwards to `PackEvents` and its `PackDb` cache).
pub trait JobObserver: Send + Sync + 'static {
    /// Every job event (`Progress` at most every 100 ms per job).
    fn download(&self, e: DownloadEvent);
    /// A pack's registry rows changed (job finished, paused, failed or cancelled).
    fn packs_changed(&self, pack_ids: Vec<String>);
    /// Before a whole pack's previous version is deleted: drop cached handles on its files.
    fn release_pack(&self, _pack_id: &str) {}
}

/// The work of one pack. Production uses [`Adapter`] (the catalog source); tests can plug in their own.
pub trait PackWork: Send + Sync + 'static {
    /// The items an install of `scope` covers (§2.5.3).
    fn items(&self, scope: &InstallScope) -> Result<Vec<ItemKey>, PackError>;
    /// Installed whole (staging + atomic flip) rather than per item.
    fn whole(&self) -> bool;
    fn fetch_item<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>>;
    fn install_whole<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>>;
    /// Job temps of an item, deleted on cancel.
    fn temp_paths(&self, packs_root: &Path, item: &ItemKey) -> Vec<PathBuf>;
}

impl PackWork for Adapter {
    fn items(&self, scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        Self::items(self, scope)
    }

    fn whole(&self) -> bool {
        matches!(self, Self::QuranEncSqlite(_))
    }

    fn fetch_item<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>> {
        Box::pin(Self::fetch_item(self, ctx, item))
    }

    fn install_whole<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>> {
        Box::pin(Self::install_whole(self, ctx, staging))
    }

    fn temp_paths(&self, packs_root: &Path, item: &ItemKey) -> Vec<PathBuf> {
        install::item_files(self, packs_root, item)
            .map(|f| f.temps)
            .unwrap_or_default()
    }
}

/// One job request.
#[derive(Clone)]
pub struct JobSpec {
    pub pack_id: String,
    pub kind: PackKind,
    /// Catalog version (the `installed_pack.version` of per-item packs).
    pub version: String,
    /// Catalog `itemCount` (all items present and pinned = `installed`).
    pub item_count: u32,
    /// Catalog `sizeBytes` (progress estimate).
    pub size_bytes: u64,
    pub scope: InstallScope,
    /// Explicit download: items are pinned (survive "Clear cache").
    pub pin: bool,
    pub work: Arc<dyn PackWork>,
}

impl JobSpec {
    /// A job for a catalog pack, run by its adapter.
    #[must_use]
    pub fn from_catalog(pack: &CatalogPack, scope: InstallScope, pin: bool) -> Self {
        Self {
            pack_id: pack.id.clone(),
            kind: pack.kind,
            version: pack.version.clone(),
            item_count: pack.item_count,
            size_bytes: pack.size_bytes,
            scope,
            pin,
            work: Arc::new(pack.source.clone()),
        }
    }

    fn per_item_estimate(&self) -> u64 {
        if self.work.whole() {
            self.size_bytes
        } else {
            self.size_bytes.div_ceil(u64::from(self.item_count.max(1)))
        }
    }
}

impl std::fmt::Debug for JobSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobSpec")
            .field("pack_id", &self.pack_id)
            .field("kind", &self.kind)
            .field("version", &self.version)
            .field("scope", &self.scope)
            .field("pin", &self.pin)
            .finish_non_exhaustive()
    }
}

/// Rebuilds a [`JobSpec`] from a pack id (resume after a restart, cancel of a paused job).
pub type SpecSource = Arc<dyn Fn(&str, InstallScope, bool) -> Option<JobSpec> + Send + Sync>;

/// The production [`SpecSource`]: catalog packs run by their adapters.
#[must_use]
pub fn catalog_specs(catalog: Arc<Catalog>) -> SpecSource {
    Arc::new(move |pack_id: &str, scope: InstallScope, pin: bool| {
        catalog
            .get(pack_id)
            .map(|pack| JobSpec::from_catalog(pack, scope, pin))
    })
}

/// Everything jobs run against.
#[derive(Clone)]
pub struct JobEnv {
    /// `<app_local_data_dir>/packs`.
    pub packs_root: PathBuf,
    pub http: Http,
    pub core: CoreDb,
    pub user: UserDb,
    pub content: ContentDb,
    pub writers: Writers,
    /// Where job tasks run.
    pub runtime: tokio::runtime::Handle,
    pub observer: Arc<dyn JobObserver>,
}

// ---------------------------------------------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------------------------------------------

/// `packs/.staging/{packId}/job.json`: an unfinished job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobJournal {
    pub pack_id: String,
    pub scope: InstallScope,
    pub pin: bool,
    pub state: JournalState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    /// Unix ms.
    pub created_at: i64,
    pub updated_at: i64,
}

/// Where an unfinished job stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalState {
    /// Queued or running when the app stopped: resumed automatically.
    Active,
    Paused,
    Failed,
}

/// The journal of a pack's unfinished job, if any.
pub async fn read_journal(packs_root: &Path, pack_id: &str) -> Option<JobJournal> {
    let path = Staging::locate(packs_root, pack_id).ok()?.journal_path();
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice::<JobJournal>(&bytes)
        .ok()
        .filter(|j| j.pack_id == pack_id)
}

/// Every readable journal under `packs/.staging/`, sorted by creation.
pub async fn read_journals(packs_root: &Path) -> Vec<JobJournal> {
    let mut out = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(install::staging_root(packs_root)).await else {
        return out;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(j) = read_journal(packs_root, &name).await {
            out.push(j);
        }
    }
    out.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then(a.pack_id.cmp(&b.pack_id))
    });
    out
}

async fn write_journal(packs_root: &Path, journal: &JobJournal) -> Result<(), PackError> {
    let staging = Staging::open(packs_root, &journal.pack_id).await?;
    let json =
        serde_json::to_vec_pretty(journal).map_err(|e| PackError::Io(io::Error::other(e)))?;
    install::write_atomic(&staging.journal_path(), json).await
}

// ---------------------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------------------

/// The background job queue. Cheap to clone.
#[derive(Clone)]
pub struct JobQueue {
    inner: Arc<QueueInner>,
}

struct QueueInner {
    env: JobEnv,
    specs: SpecSource,
    max_running: usize,
    item_concurrency: usize,
    next_id: AtomicU32,
    state: Mutex<QueueState>,
    changed: Notify,
}

#[derive(Default)]
struct QueueState {
    /// FIFO by enqueue time: pending/queued/running jobs and the last paused/failed job of a pack.
    entries: Vec<Entry>,
    /// Recent terminal outcomes `(job_id, phase)`.
    outcomes: VecDeque<(u32, JobPhase)>,
}

struct Entry {
    handle: JobHandle,
    spec: JobSpec,
    items: Vec<ItemKey>,
    state: EntryState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryState {
    /// Accepted; its journal is being written.
    Pending,
    Queued,
    Running,
    Finished(JobPhase),
}

impl EntryState {
    const fn active(self) -> bool {
        matches!(self, Self::Pending | Self::Queued | Self::Running)
    }
}

impl JobQueue {
    /// A queue with the §2.5.5 limits.
    #[must_use]
    pub fn new(env: JobEnv, specs: SpecSource) -> Self {
        Self::with_limits(env, specs, MAX_RUNNING, ITEM_CONCURRENCY)
    }

    /// A queue with explicit limits (tests).
    #[must_use]
    pub fn with_limits(
        env: JobEnv,
        specs: SpecSource,
        max_running: usize,
        item_concurrency: usize,
    ) -> Self {
        Self {
            inner: Arc::new(QueueInner {
                env,
                specs,
                max_running: max_running.max(1),
                item_concurrency: item_concurrency.max(1),
                next_id: AtomicU32::new(1),
                state: Mutex::new(QueueState::default()),
                changed: Notify::new(),
            }),
        }
    }

    #[must_use]
    pub fn env(&self) -> &JobEnv {
        &self.inner.env
    }

    /// Queues a job; returns its id. `Conflict` while another job for the pack is queued or running; a paused or
    /// failed job of the pack is replaced (its temps are reused).
    pub async fn enqueue(&self, spec: JobSpec) -> Result<u32, PackError> {
        let root = self.inner.env.packs_root.clone();
        install::staging_dir(&root, &spec.pack_id)?;
        let items = spec.work.items(&spec.scope)?;
        let handle = {
            let mut st = self.inner.state.lock();
            if st
                .entries
                .iter()
                .any(|e| e.spec.pack_id == spec.pack_id && e.state.active())
            {
                return Err(PackError::Conflict(format!(
                    "a job is already queued or running for {}",
                    spec.pack_id
                )));
            }
            st.entries.retain(|e| e.spec.pack_id != spec.pack_id);
            let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            let handle = JobHandle::new(
                id,
                &spec.pack_id,
                Some(Arc::clone(&self.inner.env.observer)),
            );
            st.entries.push(Entry {
                handle: handle.clone(),
                spec: spec.clone(),
                items,
                state: EntryState::Pending,
            });
            handle
        };
        let now = self.inner.env.user.now_ms();
        let created_at = read_journal(&root, &spec.pack_id)
            .await
            .map_or(now, |j| j.created_at);
        let journal = JobJournal {
            pack_id: spec.pack_id.clone(),
            scope: spec.scope.clone(),
            pin: spec.pin,
            state: JournalState::Active,
            error: None,
            created_at,
            updated_at: now,
        };
        if let Err(e) = write_journal(&root, &journal).await {
            self.inner
                .state
                .lock()
                .entries
                .retain(|en| en.handle.job_id() != handle.job_id());
            return Err(e);
        }
        // A pause or cancel that arrived while the journal was written takes effect now.
        let next = {
            let mut st = self.inner.state.lock();
            match st
                .entries
                .iter_mut()
                .find(|e| e.handle.job_id() == handle.job_id())
            {
                Some(e) if e.state == EntryState::Pending => {
                    let next = if handle.is_cancelled() {
                        EntryState::Finished(JobPhase::Cancelled)
                    } else if handle.is_paused() {
                        EntryState::Finished(JobPhase::Paused)
                    } else {
                        EntryState::Queued
                    };
                    e.state = next;
                    Some((next, e.items.clone()))
                }
                _ => None,
            }
        };
        if let Some((next, items)) = next {
            handle.emit(DownloadEvent::Queued {
                job_id: handle.job_id(),
                pack_id: spec.pack_id.clone(),
            });
            match next {
                EntryState::Finished(phase) => {
                    self.finish(&handle, &spec, &items, phase, None).await
                }
                _ => self.pump(),
            }
        }
        Ok(handle.job_id())
    }

    /// Pauses the pack's job: a running job stops at its next chunk (temps kept); a queued one never starts.
    /// Idempotent on a paused or failed job; `NotFound` without one.
    pub async fn pause(&self, pack_id: &str) -> Result<(), PackError> {
        let taken = {
            let mut st = self.inner.state.lock();
            let Some(e) = st.entries.iter_mut().find(|e| e.spec.pack_id == pack_id) else {
                return Err(PackError::NotFound(format!("no job for {pack_id}")));
            };
            match e.state {
                EntryState::Running | EntryState::Pending => {
                    e.handle.request_pause();
                    return Ok(());
                }
                EntryState::Queued => {
                    e.state = EntryState::Finished(JobPhase::Paused);
                    (e.handle.clone(), e.spec.clone(), e.items.clone())
                }
                EntryState::Finished(_) => return Ok(()),
            }
        };
        self.finish(&taken.0, &taken.1, &taken.2, JobPhase::Paused, None)
            .await;
        Ok(())
    }

    /// Cancels the pack's job and deletes its temps: a running job stops at its next chunk; a queued, paused or failed
    /// one (also one only journaled on disk after a restart) is cleaned up now. `NotFound` without any.
    pub async fn cancel(&self, pack_id: &str) -> Result<(), PackError> {
        let taken = {
            let mut st = self.inner.state.lock();
            match st.entries.iter_mut().find(|e| e.spec.pack_id == pack_id) {
                Some(e) if matches!(e.state, EntryState::Running | EntryState::Pending) => {
                    e.handle.request_cancel();
                    return Ok(());
                }
                Some(e) => {
                    e.handle.request_cancel();
                    e.state = EntryState::Finished(JobPhase::Cancelled);
                    Some((e.handle.clone(), e.spec.clone(), e.items.clone()))
                }
                None => None,
            }
        };
        if let Some((handle, spec, items)) = taken {
            self.finish(&handle, &spec, &items, JobPhase::Cancelled, None)
                .await;
            return Ok(());
        }
        let root = &self.inner.env.packs_root;
        let Some(journal) = read_journal(root, pack_id).await else {
            return Err(PackError::NotFound(format!("no job for {pack_id}")));
        };
        match (self.inner.specs)(pack_id, journal.scope, journal.pin) {
            Some(spec) => {
                let items = spec.work.items(&spec.scope).unwrap_or_default();
                let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
                let handle =
                    JobHandle::new(id, pack_id, Some(Arc::clone(&self.inner.env.observer)));
                self.finish(&handle, &spec, &items, JobPhase::Cancelled, None)
                    .await;
            }
            None => {
                if let Ok(staging) = Staging::locate(root, pack_id) {
                    staging.remove().await?;
                }
            }
        }
        Ok(())
    }

    /// Resumes (or retries) the pack's paused or failed job with its scope; returns the new job id. A queued or running
    /// job's id is returned as is. `NotFound` when there is nothing to resume.
    pub async fn resume(&self, pack_id: &str) -> Result<u32, PackError> {
        let spec = {
            let st = self.inner.state.lock();
            match st.entries.iter().find(|e| e.spec.pack_id == pack_id) {
                Some(e) if e.state.active() => return Ok(e.handle.job_id()),
                Some(e) => Some(e.spec.clone()),
                None => None,
            }
        };
        let spec = match spec {
            Some(spec) => spec,
            None => {
                let journal = read_journal(&self.inner.env.packs_root, pack_id)
                    .await
                    .ok_or_else(|| {
                        PackError::NotFound(format!("nothing to resume for {pack_id}"))
                    })?;
                (self.inner.specs)(pack_id, journal.scope, journal.pin).ok_or_else(|| {
                    PackError::NotFound(format!("{pack_id} is no longer in the catalog"))
                })?
            }
        };
        self.enqueue(spec).await
    }

    /// Startup: re-queues jobs that were queued or running when the app stopped, and lists paused/failed ones (with
    /// their error) so they can be resumed, cancelled and shown. Journals of packs no longer in the catalog are
    /// removed. Run after [`install::sweep`]. Returns the ids of the re-queued jobs.
    pub async fn restore(&self) -> Result<Vec<u32>, PackError> {
        let root = self.inner.env.packs_root.clone();
        let mut ids = Vec::new();
        for journal in read_journals(&root).await {
            let pack_id = journal.pack_id.clone();
            let Some(spec) = (self.inner.specs)(&pack_id, journal.scope.clone(), journal.pin)
            else {
                log::warn!("dropping the job journal of {pack_id}: not in the catalog");
                if let Ok(staging) = Staging::locate(&root, &pack_id) {
                    staging.remove().await?;
                }
                continue;
            };
            match journal.state {
                JournalState::Active => match self.enqueue(spec).await {
                    Ok(id) => ids.push(id),
                    Err(e) => log::warn!("cannot resume the job of {pack_id}: {e}"),
                },
                JournalState::Paused | JournalState::Failed => {
                    let phase = if journal.state == JournalState::Paused {
                        JobPhase::Paused
                    } else {
                        JobPhase::Failed
                    };
                    let items = spec.work.items(&spec.scope).unwrap_or_default();
                    let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
                    let handle =
                        JobHandle::new(id, &pack_id, Some(Arc::clone(&self.inner.env.observer)));
                    handle.shared.items_total.store(
                        u32::try_from(items.len()).unwrap_or(u32::MAX),
                        Ordering::Relaxed,
                    );
                    handle.set_final(phase, journal.error.clone());
                    let mut st = self.inner.state.lock();
                    if !st.entries.iter().any(|e| e.spec.pack_id == pack_id) {
                        st.entries.push(Entry {
                            handle,
                            spec,
                            items,
                            state: EntryState::Finished(phase),
                        });
                    }
                }
            }
        }
        Ok(ids)
    }

    /// Snapshots of queued, running, paused and failed jobs, in queue order.
    #[must_use]
    pub fn jobs(&self) -> Vec<JobSnapshot> {
        self.inner
            .state
            .lock()
            .entries
            .iter()
            .map(|e| e.handle.snapshot())
            .collect()
    }

    /// The pack's job (queued, running, paused or failed).
    #[must_use]
    pub fn snapshot(&self, pack_id: &str) -> Option<JobSnapshot> {
        self.inner
            .state
            .lock()
            .entries
            .iter()
            .find(|e| e.spec.pack_id == pack_id)
            .map(|e| e.handle.snapshot())
    }

    /// A job for the pack is queued or running.
    #[must_use]
    pub fn is_active(&self, pack_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .entries
            .iter()
            .any(|e| e.spec.pack_id == pack_id && e.state.active())
    }

    /// The items of the pack's queued, running or paused job (`PackItemState.queued` for those not yet present).
    #[must_use]
    pub fn job_items(&self, pack_id: &str) -> Option<Vec<ItemKey>> {
        self.inner
            .state
            .lock()
            .entries
            .iter()
            .find(|e| {
                e.spec.pack_id == pack_id
                    && (e.state.active() || e.state == EntryState::Finished(JobPhase::Paused))
            })
            .map(|e| e.items.clone())
    }

    /// The handle of the pack's queued or running job.
    #[must_use]
    pub fn handle(&self, pack_id: &str) -> Option<JobHandle> {
        self.inner
            .state
            .lock()
            .entries
            .iter()
            .find(|e| e.spec.pack_id == pack_id && e.state.active())
            .map(|e| e.handle.clone())
    }

    /// Waits until job `job_id` stops (completed, failed, cancelled or paused); `None` for an unknown id.
    pub async fn wait(&self, job_id: u32) -> Option<JobPhase> {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let st = self.inner.state.lock();
                if let Some(e) = st.entries.iter().find(|e| e.handle.job_id() == job_id) {
                    if let EntryState::Finished(phase) = e.state {
                        return Some(phase);
                    }
                } else {
                    return st
                        .outcomes
                        .iter()
                        .rev()
                        .find(|(id, _)| *id == job_id)
                        .map(|(_, p)| *p);
                }
            }
            notified.await;
        }
    }

    /// Starts queued jobs while fewer than `max_running` run (FIFO).
    fn pump(&self) {
        let mut start = Vec::new();
        {
            let mut st = self.inner.state.lock();
            let running = st
                .entries
                .iter()
                .filter(|e| e.state == EntryState::Running)
                .count();
            let free = self.inner.max_running.saturating_sub(running);
            for e in st
                .entries
                .iter_mut()
                .filter(|e| e.state == EntryState::Queued)
                .take(free)
            {
                e.state = EntryState::Running;
                start.push((e.handle.clone(), e.spec.clone(), e.items.clone()));
            }
        }
        for (handle, spec, items) in start {
            let queue = self.clone();
            self.inner.env.runtime.spawn(async move {
                queue.run(handle, spec, items).await;
            });
        }
    }

    async fn run(&self, handle: JobHandle, spec: JobSpec, items: Vec<ItemKey>) {
        handle.set_phase(JobPhase::Downloading);
        let outcome = self.execute(&handle, &spec, &items).await;
        let (phase, error) = match outcome {
            Ok(()) => (JobPhase::Completed, None),
            Err(_) if handle.is_cancelled() => (JobPhase::Cancelled, None),
            Err(_) if handle.is_paused() => (JobPhase::Paused, None),
            Err(e) => {
                log::warn!("job {} ({}) failed: {e}", handle.job_id(), spec.pack_id);
                (JobPhase::Failed, Some(AppError::from(e)))
            }
        };
        self.finish(&handle, &spec, &items, phase, error).await;
    }

    /// Runs the job's work with the progress ticker alongside.
    async fn execute(
        &self,
        handle: &JobHandle,
        spec: &JobSpec,
        items: &[ItemKey],
    ) -> Result<(), PackError> {
        let work = async {
            if spec.work.whole() {
                self.execute_whole(handle, spec).await
            } else {
                self.execute_items(handle, spec, items).await
            }
        };
        tokio::pin!(work);
        let mut ticker = Ticker::new(handle.clone());
        let mut interval = tokio::time::interval(PROGRESS_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        let result = loop {
            tokio::select! {
                r = &mut work => break r,
                _ = interval.tick() => ticker.tick(),
            }
        };
        ticker.tick();
        result
    }

    fn started(handle: &JobHandle) {
        let snap = handle.snapshot();
        handle.emit(DownloadEvent::Started {
            job_id: snap.job_id,
            pack_id: snap.pack_id,
            total_kib: snap.total_kib,
            items_total: snap.items_total,
        });
    }

    fn ctx(&self, spec: &JobSpec, job: JobHandle) -> AdapterCtx {
        let env = &self.inner.env;
        AdapterCtx {
            pack_id: spec.pack_id.clone(),
            kind: spec.kind,
            packs_root: env.packs_root.clone(),
            http: env.http.clone(),
            core: env.core.clone(),
            user: env.user.clone(),
            content: env.content.clone(),
            writers: env.writers.clone(),
            job: Some(job),
            pin: spec.pin,
        }
    }

    async fn execute_items(
        &self,
        handle: &JobHandle,
        spec: &JobSpec,
        items: &[ItemKey],
    ) -> Result<(), PackError> {
        let user = self.inner.env.user.clone();
        let pack_id = spec.pack_id.clone();
        let rows: HashMap<String, PackItemRow> = db(move || user.pack_items(&pack_id))
            .await?
            .into_iter()
            .map(|r| (r.item.clone(), r))
            .collect();
        let mut todo = Vec::new();
        let (mut done, mut done_bytes) = (0usize, 0u64);
        for item in items {
            match rows.get(&item.db_key()) {
                Some(row) if row.pinned || !spec.pin => {
                    done += 1;
                    done_bytes = done_bytes.saturating_add(row.bytes);
                }
                _ => todo.push(item.clone()),
            }
        }
        let estimate = spec.per_item_estimate();
        let todo_bytes = estimate.saturating_mul(u64::try_from(todo.len()).unwrap_or(u64::MAX));
        handle.init_progress(
            items.len(),
            done,
            done_bytes,
            done_bytes.saturating_add(todo_bytes),
        );
        Self::started(handle);

        let threshold = MAX_FAILED_ITEMS
            .min(u32::try_from(todo.len()).unwrap_or(u32::MAX))
            .max(1);
        let mut failed = 0u32;
        let mut last_error: Option<PackError> = None;
        let mut pending = todo.into_iter();
        let mut running = FuturesUnordered::new();
        loop {
            while running.len() < self.inner.item_concurrency
                && !handle.should_stop()
                && failed < threshold
            {
                let Some(item) = pending.next() else {
                    break;
                };
                let item_handle = handle.for_item(estimate);
                let ctx = self.ctx(spec, item_handle.clone());
                let work = Arc::clone(&spec.work);
                running.push(async move {
                    let result = work.fetch_item(&ctx, &item).await;
                    (item, item_handle, result)
                });
            }
            let Some((item, item_handle, result)) = running.next().await else {
                break;
            };
            match result {
                Ok(outcome) => {
                    let local = match &outcome {
                        ItemOutcome::Present { bytes } => *bytes,
                        ItemOutcome::Stored { .. } => 0,
                    };
                    if let Err(e) = self.record_item(spec, &item, outcome).await {
                        // The registry is unusable: stop the job.
                        item_handle.settle_failed();
                        handle.abort_items();
                        failed = threshold;
                        last_error = Some(e);
                        continue;
                    }
                    item_handle.settle_ok(local);
                    handle.item_done();
                }
                Err(e) => {
                    // A pause or cancel is not an item failure: the item keeps its progress (its temps are kept for
                    // the resume). The abort after the job failed, and a real failure, take it out of the totals.
                    if handle.is_cancelled() || handle.is_paused() {
                        item_handle.settle_stopped();
                        continue;
                    }
                    item_handle.settle_failed();
                    if handle.should_stop() && matches!(e, PackError::Cancelled) {
                        continue;
                    }
                    failed = failed.saturating_add(1);
                    log::warn!(
                        "{}: item {item} failed ({failed}/{threshold}): {e}",
                        spec.pack_id
                    );
                    last_error = Some(e);
                    if failed >= threshold {
                        handle.abort_items();
                    }
                }
            }
        }
        if handle.is_cancelled() || handle.is_paused() {
            return Err(PackError::Cancelled);
        }
        match last_error {
            Some(e) if failed >= threshold => Err(e),
            _ => Ok(()),
        }
    }

    /// Records one finished item in `pack_item`.
    async fn record_item(
        &self,
        spec: &JobSpec,
        item: &ItemKey,
        outcome: ItemOutcome,
    ) -> Result<(), PackError> {
        let user = self.inner.env.user.clone();
        let pack_id = spec.pack_id.clone();
        let key = item.db_key();
        let pin = spec.pin;
        db(move || {
            let now = user.now_ms();
            let row = match outcome {
                ItemOutcome::Stored { bytes, sha256 } => PackItemRow {
                    pack_id,
                    item: key,
                    bytes,
                    sha256,
                    pinned: pin,
                    fetched_at: now,
                    last_used_at: now,
                },
                ItemOutcome::Present { bytes } => match user.pack_item(&pack_id, &key)? {
                    Some(prev) => PackItemRow {
                        bytes,
                        pinned: prev.pinned || pin,
                        last_used_at: now,
                        ..prev
                    },
                    None => PackItemRow {
                        pack_id,
                        item: key,
                        bytes,
                        sha256: String::new(),
                        pinned: pin,
                        fetched_at: now,
                        last_used_at: now,
                    },
                },
            };
            user.pack_item_upsert(&row)
        })
        .await
    }

    async fn execute_whole(&self, handle: &JobHandle, spec: &JobSpec) -> Result<(), PackError> {
        let env = &self.inner.env;
        let staging = Staging::open(&env.packs_root, &spec.pack_id).await?;
        staging.clear_build().await?;
        handle.init_progress(1, 0, 0, spec.size_bytes);
        Self::started(handle);
        let item_handle = handle.for_item(spec.size_bytes);
        let ctx = self.ctx(spec, item_handle.clone());
        let staged = spec.work.install_whole(&ctx, staging.path()).await?;
        if handle.is_cancelled() {
            return Err(PackError::Cancelled);
        }
        if !staged.db_path.starts_with(staging.path()) {
            return Err(PackError::Integrity(format!(
                "{}: the build is outside its staging directory",
                spec.pack_id
            )));
        }
        handle.set_phase(JobPhase::Verifying);
        handle.set_phase(JobPhase::Installing);
        let observer = Arc::clone(&env.observer);
        let pack_id = spec.pack_id.clone();
        let flipped = install::flip_whole(
            &env.packs_root,
            &env.user,
            &spec.pack_id,
            spec.kind,
            &staged,
            move || observer.release_pack(&pack_id),
        )
        .await?;
        log::info!(
            "{}: installed version {} ({} bytes{})",
            spec.pack_id,
            flipped.row.version,
            flipped.row.bytes,
            if flipped.old_dir_removed {
                ", previous version removed"
            } else {
                ""
            }
        );
        item_handle.settle_ok(0);
        handle.item_done();
        Ok(())
    }

    /// Ends a job: registry rows, journal and temps per the module policy, the terminal event, `packs_changed`, then
    /// the next queued job.
    async fn finish(
        &self,
        handle: &JobHandle,
        spec: &JobSpec,
        items: &[ItemKey],
        phase: JobPhase,
        error: Option<AppError>,
    ) {
        handle.set_final(phase, error.clone());
        if let Err(e) = self
            .settle_registry(spec, items, phase, error.as_ref())
            .await
        {
            log::warn!(
                "{}: cannot record the end of job {}: {e}",
                spec.pack_id,
                handle.job_id()
            );
        }
        let (job_id, pack_id) = (handle.job_id(), spec.pack_id.clone());
        // The queue reflects the outcome before anyone hears of it.
        {
            let mut st = self.inner.state.lock();
            if let Some(e) = st.entries.iter_mut().find(|e| e.handle.job_id() == job_id) {
                e.state = EntryState::Finished(phase);
            }
            if matches!(phase, JobPhase::Completed | JobPhase::Cancelled) {
                st.entries.retain(|e| e.handle.job_id() != job_id);
            }
            st.outcomes.push_back((job_id, phase));
            while st.outcomes.len() > OUTCOMES_KEPT {
                st.outcomes.pop_front();
            }
        }
        handle.emit(match phase {
            JobPhase::Completed => DownloadEvent::Completed { job_id, pack_id },
            JobPhase::Cancelled => DownloadEvent::Cancelled { job_id, pack_id },
            JobPhase::Paused => DownloadEvent::Paused { job_id, pack_id },
            _ => DownloadEvent::Failed {
                job_id,
                pack_id,
                error: error.unwrap_or_else(|| AppError::Internal("job failed".into())),
            },
        });
        self.inner
            .env
            .observer
            .packs_changed(vec![spec.pack_id.clone()]);
        self.inner.changed.notify_waiters();
        self.pump();
    }

    async fn settle_registry(
        &self,
        spec: &JobSpec,
        items: &[ItemKey],
        phase: JobPhase,
        error: Option<&AppError>,
    ) -> Result<(), PackError> {
        let env = &self.inner.env;
        let root = &env.packs_root;
        let staging = Staging::locate(root, &spec.pack_id)?;
        match phase {
            JobPhase::Completed => {
                if !spec.work.whole() {
                    self.sync_item_row(spec, None).await?;
                }
                staging.remove().await?;
            }
            JobPhase::Cancelled => {
                let mut freed = 0u64;
                for item in items {
                    for path in spec.work.temp_paths(root, item) {
                        freed = freed.saturating_add(install::remove_file(&path).await?);
                    }
                }
                freed = freed.saturating_add(staging.remove().await?);
                log::debug!("{}: cancel freed {freed} bytes of temps", spec.pack_id);
                if spec.work.whole() {
                    self.whole_row(spec, None).await?;
                } else {
                    self.sync_item_row(spec, None).await?;
                }
            }
            JobPhase::Paused | JobPhase::Failed => {
                let (state, status) = if phase == JobPhase::Paused {
                    (JournalState::Paused, InstalledStatus::Paused)
                } else {
                    (JournalState::Failed, InstalledStatus::Failed)
                };
                let now = env.user.now_ms();
                let created_at = read_journal(root, &spec.pack_id)
                    .await
                    .map_or(now, |j| j.created_at);
                write_journal(
                    root,
                    &JobJournal {
                        pack_id: spec.pack_id.clone(),
                        scope: spec.scope.clone(),
                        pin: spec.pin,
                        state,
                        error: error.cloned(),
                        created_at,
                        updated_at: now,
                    },
                )
                .await?;
                if spec.work.whole() {
                    self.whole_row(spec, Some(status)).await?;
                } else {
                    self.sync_item_row(spec, Some(status)).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Recomputes a per-item pack's `installed_pack` row from its pinned items; `status` overrides the derived one.
    async fn sync_item_row(
        &self,
        spec: &JobSpec,
        status: Option<InstalledStatus>,
    ) -> Result<(), PackError> {
        let user = self.inner.env.user.clone();
        let spec = spec.clone();
        db(move || {
            let pinned: Vec<PackItemRow> = user
                .pack_items(&spec.pack_id)?
                .into_iter()
                .filter(|r| r.pinned)
                .collect();
            let present = u32::try_from(pinned.len()).unwrap_or(u32::MAX);
            let bytes = pinned
                .iter()
                .map(|r| r.bytes)
                .fold(0u64, u64::saturating_add);
            let prev = user.pack_installed(&spec.pack_id)?;
            let status = match status {
                Some(s) => s,
                None if present == 0 => return user.pack_delete(&spec.pack_id),
                None if spec.item_count > 0 && present >= spec.item_count => {
                    InstalledStatus::Installed
                }
                None => InstalledStatus::Partial,
            };
            let now = user.now_ms();
            user.pack_upsert(&InstalledPackRow {
                pack_id: spec.pack_id.clone(),
                kind: spec.kind,
                version: spec.version.clone(),
                path: None,
                status,
                bytes,
                items_total: spec.item_count,
                items_present: present,
                sha256: None,
                source_version: prev.as_ref().and_then(|p| p.source_version.clone()),
                installed_at: prev.as_ref().map_or(now, |p| p.installed_at),
                updated_at: now,
                last_checked_at: prev.as_ref().and_then(|p| p.last_checked_at),
            })
        })
        .await
    }

    /// A whole pack's row when its job stops: `status` (paused/failed) or none (cancelled), unless a version is
    /// installed, which is left untouched.
    async fn whole_row(
        &self,
        spec: &JobSpec,
        status: Option<InstalledStatus>,
    ) -> Result<(), PackError> {
        let user = self.inner.env.user.clone();
        let spec = spec.clone();
        db(move || {
            let prev = user.pack_installed(&spec.pack_id)?;
            if prev
                .as_ref()
                .is_some_and(|p| p.status == InstalledStatus::Installed && p.path.is_some())
            {
                return Ok(());
            }
            let Some(status) = status else {
                return user.pack_delete(&spec.pack_id);
            };
            let now = user.now_ms();
            user.pack_upsert(&InstalledPackRow {
                pack_id: spec.pack_id.clone(),
                kind: spec.kind,
                version: spec.version.clone(),
                path: None,
                status,
                bytes: 0,
                items_total: 1,
                items_present: 0,
                sha256: None,
                source_version: None,
                installed_at: prev.as_ref().map_or(now, |p| p.installed_at),
                updated_at: now,
                last_checked_at: None,
            })
        })
        .await
    }
}

async fn db<T: Send + 'static>(
    f: impl FnOnce() -> quran_core::Result<T> + Send + 'static,
) -> Result<T, PackError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("blocking task failed: {e}"))))?
        .map_err(PackError::from)
}

/// Emits `Progress` at most once per tick, only when something changed; keeps the rate EWMA.
struct Ticker {
    handle: JobHandle,
    last: Option<(u32, u32, u32, u32, Option<u32>)>,
    rate: f64,
    at: Instant,
    net: u64,
}

impl Ticker {
    fn new(handle: JobHandle) -> Self {
        let net = Self::network_bytes(&handle);
        Self {
            handle,
            last: None,
            rate: 0.0,
            at: Instant::now(),
            net,
        }
    }

    fn network_bytes(handle: &JobHandle) -> u64 {
        let s = &handle.shared;
        s.received
            .load(Ordering::Relaxed)
            .saturating_sub(s.resumed.load(Ordering::Relaxed))
    }

    fn tick(&mut self) {
        let now = Instant::now();
        let dt = now.saturating_duration_since(self.at).as_secs_f64();
        let net = Self::network_bytes(&self.handle);
        if dt > 0.0 {
            #[allow(clippy::cast_precision_loss)]
            let inst = net.saturating_sub(self.net) as f64 / dt;
            let alpha = 1.0 - (-dt / RATE_WINDOW.as_secs_f64()).exp();
            self.rate += alpha * (inst - self.rate);
            self.at = now;
            self.net = net;
        }
        let snap = self.handle.snapshot();
        let rate_kib = (self.rate / 1024.0).round();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let rate_kib_s = if rate_kib.is_finite() && rate_kib > 0.0 {
            rate_kib.min(f64::from(u32::MAX)) as u32
        } else {
            0
        };
        let left_kib = f64::from(snap.total_kib.saturating_sub(snap.received_kib));
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let eta_s = (rate_kib_s > 0).then(|| {
            (left_kib / (self.rate / 1024.0))
                .ceil()
                .clamp(0.0, f64::from(u32::MAX)) as u32
        });
        self.handle.set_rate(rate_kib_s, eta_s);
        let key = (
            snap.received_kib,
            snap.total_kib,
            snap.items_done,
            rate_kib_s,
            eta_s,
        );
        if self.last != Some(key) {
            self.last = Some(key);
            self.handle.emit(DownloadEvent::Progress {
                job_id: snap.job_id,
                pack_id: snap.pack_id,
                received_kib: snap.received_kib,
                total_kib: snap.total_kib,
                items_done: snap.items_done,
                items_total: snap.items_total,
                rate_kib_s,
                eta_s,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn item_accounting_corrects_totals() {
        let job = JobHandle::detached(1, "audio.qdc.7");
        job.init_progress(2, 0, 0, 200);
        let a = job.for_item(100);
        let b = job.for_item(100);
        a.set_expected_len(150);
        a.set_expected_len(150);
        assert_eq!(
            job.shared.total.load(Ordering::Relaxed),
            250,
            "once per item"
        );
        a.add_received(150);
        a.settle_ok(0);
        b.add_received(40);
        b.settle_failed();
        assert_eq!(job.shared.received.load(Ordering::Relaxed), 150);
        assert_eq!(job.shared.total.load(Ordering::Relaxed), 150);
        let c = job.for_item(10);
        c.add_resumed(10);
        c.restart_item();
        assert_eq!(job.shared.received.load(Ordering::Relaxed), 150);
        c.settle_ok(10);
        let snap = job.snapshot();
        assert_eq!(snap.received_kib, 0);
        assert_eq!(snap.total_kib, 1);
    }

    /// A paused (or cancelled) item keeps its bytes and its share: its temp is kept, and the resume continues from it.
    /// A failed one leaves the totals.
    #[test]
    fn a_stopped_item_keeps_its_progress_and_a_failed_one_leaves() {
        let job = JobHandle::detached(1, "audio.qdc.7");
        job.init_progress(3, 1, 1_000, 1_000 + 2 * 100);
        let partial = job.for_item(100);
        partial.set_expected_len(4_096);
        partial.add_received(2_048);
        let broken = job.for_item(100);
        broken.add_received(10);
        job.request_pause();
        partial.settle_stopped();
        broken.settle_failed();
        assert_eq!(job.shared.received.load(Ordering::Relaxed), 1_000 + 2_048);
        assert_eq!(job.shared.total.load(Ordering::Relaxed), 1_000 + 4_096);
    }

    #[tokio::test]
    async fn stop_requests_wake_waiters() {
        let job = JobHandle::detached(1, "x.y");
        assert!(job.check().is_ok());
        let waiter = {
            let job = job.clone();
            tokio::spawn(async move { job.stopped().await })
        };
        tokio::task::yield_now().await;
        job.request_pause();
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .unwrap()
            .unwrap();
        assert!(job.is_paused() && !job.is_cancelled());
        assert!(matches!(job.check(), Err(PackError::Cancelled)));
        assert!(job.sleep(Duration::from_secs(60)).await.is_err());
    }

    #[test]
    fn journal_json_shape() {
        let j = JobJournal {
            pack_id: "audio.qdc.7".into(),
            scope: InstallScope::Items { items: vec![1, 18] },
            pin: true,
            state: JournalState::Failed,
            error: Some(AppError::Offline("offline".into())),
            created_at: 1,
            updated_at: 2,
        };
        let v = serde_json::to_value(&j).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "packId": "audio.qdc.7",
                "scope": { "type": "items", "data": { "items": [1, 18] } },
                "pin": true,
                "state": "failed",
                "error": { "kind": "offline", "message": "offline" },
                "createdAt": 1,
                "updatedAt": 2
            })
        );
        assert_eq!(serde_json::from_value::<JobJournal>(v).unwrap(), j);
    }
}
