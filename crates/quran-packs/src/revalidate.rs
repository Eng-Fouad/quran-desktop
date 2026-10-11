//! The 7-day revalidator for QF-sourced content and the pack update checks (docs/ARCHITECTURE.md §2.5.7). Owner: WP5d.
//!
//! **Scope.** Every item of a pack with `revalidateDays` (§2.5.4): Quran.com tafsir and WBW chapters in content.db
//! ([`StaleKind::Tafsir`], [`StaleKind::Wbw`]) and QDC timings ([`StaleKind::Timings`]).
//!
//! **When.** [`Revalidator::start`] runs a pass [`FIRST_PASS_DELAY`] after startup and then every [`PASS_INTERVAL`],
//! but only while the network is allowed and reachable; a pass that finds the network offline is retried every
//! [`OFFLINE_RETRY`] instead of waiting 6 h. [`Revalidator::wake`] runs one now.
//!
//! **What.** Items fetched more than `revalidateDays` (at most [`MAX_AGE`], the QF cache rule) ago are refetched,
//! [`CONCURRENCY`] at a time, on the background lane (the HTTP layer keeps capacity for interactive work):
//! - the same payload sha256 → only `fetched_at` moves;
//! - a new payload → the chapter or the timings are replaced (pins never go down);
//! - QDC timings whose file changed (a new `audio_url` or HEAD `Content-Length`):
//!   - **unpinned** (stream-cached) file: the cached mp3 and its `pack_item` row are deleted, the new timings stored,
//!     `PacksChanged` emitted;
//!   - **pinned** file: never deleted first. The new file is downloaded beside it (`{sss}.mp3.next`), and only when it
//!     is complete are file and timings swapped in one step (rename + `timings_put`, writer claim held) and
//!     `PacksChanged` emitted. Until then the old pair stays in use and stays stale, so a failed swap is retried by
//!     the next pass.
//!
//! **Offline.** Content is never deleted for being old: lookups keep using the stored copy and report it as stale
//! (`ensure_*` in the QF adapters).
//!
//! **Updates.** [`Revalidator::check_updates`] asks every installed pack's adapter: QuranEnc packs compare the list
//! version or the zip's HTTP validators (WP5c), recitation packs compare their pinned files with upstream
//! ([`qdc_audio::pinned_changes`]); found recitation changes are applied in the background at once. Each pass also
//! re-checks QuranEnc packs whose last check is older than [`UPDATE_CHECK_INTERVAL`] (QuranEnc's terms require
//! staying on the latest version), and records `installed_pack.last_checked_at`.
//!
//! **Upstream roots.** [`QURAN_COM_API`] and [`QDC_API`] are the API roots of the QF adapters; they can be pointed at a
//! mirror (and at a local server by the integration tests).
//!
//! Nothing here panics; every task ends when the last [`Revalidator`] handle is dropped or [`Revalidator::shutdown`]
//! is called.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError, RwLock, Weak};
use std::time::Duration;

use futures_util::StreamExt;
use parking_lot::Mutex;
use quran_core::{
    ChapterStamp, ContentDb, CoreDb, InstalledPackRow, InstalledStatus, StaleItem, StaleKind,
    UserDb,
};
use quran_types::{PackKind, PackUpdate};
use tokio::sync::Notify;

use crate::PackError;
use crate::adapters::{Adapter, AdapterCtx, qdc_audio, qurancom_tafsir, qurancom_wbw};
use crate::catalog::{Catalog, CatalogPack, QF_MAX_REVALIDATE_DAYS};
use crate::http::Http;
use crate::install;
use crate::jobs::JobHandle;
use crate::writers::Writers;

// ---------------------------------------------------------------------------------------------------------------
// QF policy shared with the adapters
// ---------------------------------------------------------------------------------------------------------------

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// The QF cache rule: QF content is refetched after at most 7 days (BRIEF §4).
pub const MAX_AGE: Duration = Duration::from_secs(QF_MAX_REVALIDATE_DAYS as u64 * 24 * 60 * 60);
/// Delay of the first pass after [`Revalidator::start`] (startup + 60 s).
pub const FIRST_PASS_DELAY: Duration = Duration::from_secs(60);
/// Spacing of the regular passes.
pub const PASS_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Re-check spacing while a due pass waits for the network.
pub const OFFLINE_RETRY: Duration = Duration::from_secs(60);
/// Items revalidated at once.
pub const CONCURRENCY: usize = 2;
/// How often a pass re-checks a QuranEnc pack for a new upstream version.
pub const UPDATE_CHECK_INTERVAL: Duration = DAY;

/// An upstream API root that can be pointed elsewhere (a mirror, or a local server in integration tests).
#[derive(Debug)]
pub struct ApiRoot {
    default: &'static str,
    current: RwLock<Option<String>>,
}

impl ApiRoot {
    #[must_use]
    pub const fn new(default: &'static str) -> Self {
        Self {
            default,
            current: RwLock::new(None),
        }
    }

    /// The root without a trailing `/`.
    #[must_use]
    pub fn get(&self) -> String {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .unwrap_or_else(|| self.default.to_owned())
    }

    /// Points the adapters at `root` (`None` restores the production root). Takes effect for the next request.
    pub fn set(&self, root: Option<&str>) {
        *self.current.write().unwrap_or_else(PoisonError::into_inner) =
            root.map(|r| r.trim_end_matches('/').to_owned());
    }

    /// The production root.
    #[must_use]
    pub const fn default_root(&self) -> &'static str {
        self.default
    }
}

/// Quran.com API v4: tafsir by chapter and word-by-word verses (§2.5.6).
pub static QURAN_COM_API: ApiRoot = ApiRoot::new("https://api.quran.com/api/v4");
/// QDC: recitation files and their timings (§2.5.6).
pub static QDC_API: ApiRoot = ApiRoot::new("https://api.qurancdn.com/api/qdc");

/// How long content of `pack` stays fresh: its `revalidateDays` (clamped to 1..=7), else [`MAX_AGE`].
#[must_use]
pub fn max_age(pack: &CatalogPack) -> Duration {
    pack.revalidate_days.map_or(MAX_AGE, |days| {
        DAY.saturating_mul(days.clamp(1, QF_MAX_REVALIDATE_DAYS))
    })
}

/// Whether content fetched at `fetched_at_ms` is still fresh at `now_ms` (Unix ms). A fetch time in the future
/// (the clock went back) counts as stale, so it is refetched and re-stamped.
#[must_use]
pub fn is_fresh(fetched_at_ms: i64, now_ms: i64, max_age: Duration) -> bool {
    let age = now_ms.saturating_sub(fetched_at_ms);
    let max = i64::try_from(max_age.as_millis()).unwrap_or(i64::MAX);
    (0..max).contains(&age)
}

/// What storing a refetched Quran.com chapter (tafsir or WBW) did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChapterChange {
    /// The chapter was not stored before.
    New,
    /// The same payload: only `fetched_at` moved.
    Unchanged,
    /// A new payload replaced the stored rows.
    Replaced,
}

/// A chapter available in content.db after an `ensure_chapter` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChapterState {
    /// When the stored copy was fetched (Unix ms).
    pub fetched_at_ms: i64,
    /// Older than its revalidation period and could not be refetched (offline, network off, upstream failing): the
    /// stored copy is served with the UI's "saved N days ago" footer (§9.8).
    pub stale: bool,
    /// Set when this call refetched the chapter.
    pub change: Option<ChapterChange>,
}

/// Pages of a paginated Quran.com v4 endpoint stop after this many (`per_page=300` fits any surah in one page; the
/// default `per_page` of 10 would need 29 for al-Baqarah).
pub const MAX_PAGES: u32 = 64;

/// A paginated Quran.com response fetched to its last page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Paged<T> {
    /// The parsed pages, in order.
    pub pages: Vec<T>,
    /// Lowercase hex sha256 over every page body in order: the payload hash revalidation compares.
    pub sha256: String,
    /// Body bytes received.
    pub received: u64,
}

#[derive(serde::Deserialize)]
struct Envelope<T> {
    #[serde(flatten)]
    data: T,
    #[serde(default)]
    pagination: Option<Pagination>,
}

#[derive(serde::Deserialize)]
struct Pagination {
    #[serde(default)]
    next_page: Option<u32>,
}

/// `GET url_for(1)`, `url_for(2)`, … until `pagination.next_page` is `null` (or absent), on the context's lane. A
/// `next_page` that does not move forward, or more than [`MAX_PAGES`] pages, is an integrity failure of the upstream.
pub(crate) async fn fetch_pages<T: serde::de::DeserializeOwned>(
    ctx: &AdapterCtx,
    url_for: impl Fn(u32) -> String,
) -> Result<Paged<T>, PackError> {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    let mut out = Paged {
        pages: Vec::new(),
        sha256: String::new(),
        received: 0,
    };
    let mut page = 1u32;
    loop {
        let urls = [url_for(page)];
        let body = ctx
            .http
            .get(crate::http::Request::for_ctx(ctx, &urls))
            .await?;
        hasher.update(&body.bytes);
        out.received = out
            .received
            .saturating_add(u64::try_from(body.bytes.len()).unwrap_or(u64::MAX));
        let envelope: Envelope<T> = body.json()?;
        out.pages.push(envelope.data);
        match envelope.pagination.and_then(|p| p.next_page) {
            None => break,
            Some(next) if next > page && next <= MAX_PAGES => page = next,
            Some(next) => {
                return Err(PackError::Integrity(format!(
                    "{}: next_page {next} after page {page}",
                    body.url
                )));
            }
        }
    }
    out.sha256 = hex::encode(hasher.finalize());
    Ok(out)
}

/// The `content_chapter` stamp of one chapter, if stored.
pub(crate) async fn chapter_stamp(
    content: &ContentDb,
    pack_id: &str,
    surah: u32,
) -> Result<Option<ChapterStamp>, PackError> {
    let (content, pack_id) = (content.clone(), pack_id.to_owned());
    blocking(move || {
        Ok(content
            .chapters(&pack_id)?
            .into_iter()
            .find(|s| s.surah == surah))
    })
    .await
}

/// Runs blocking work (SQLite, file system) off the async workers.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, PackError> + Send + 'static,
) -> Result<T, PackError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("blocking task failed: {e}"))))?
}

/// `1..=114`, as `InvalidArgument` otherwise.
pub(crate) fn check_surah(surah: u32) -> Result<(), PackError> {
    if (1..=quran_types::SURAH_COUNT).contains(&surah) {
        Ok(())
    } else {
        Err(invalid_surah(surah))
    }
}

/// The `InvalidArgument` of a surah outside `1..=114`.
pub(crate) fn invalid_surah(surah: u32) -> PackError {
    PackError::Core(quran_core::CoreError::InvalidArgument(format!(
        "surah {surah} is outside 1..={}",
        quran_types::SURAH_COUNT
    )))
}

// ---------------------------------------------------------------------------------------------------------------
// Revalidator
// ---------------------------------------------------------------------------------------------------------------

/// Tunables; [`RevalidatorConfig::default`] gives the §2.5.7 values (tests shorten them).
#[derive(Debug, Clone)]
pub struct RevalidatorConfig {
    pub first_delay: Duration,
    pub interval: Duration,
    pub offline_retry: Duration,
    pub concurrency: usize,
    pub update_check_interval: Duration,
}

impl Default for RevalidatorConfig {
    fn default() -> Self {
        Self {
            first_delay: FIRST_PASS_DELAY,
            interval: PASS_INTERVAL,
            offline_retry: OFFLINE_RETRY,
            concurrency: CONCURRENCY,
            update_check_interval: UPDATE_CHECK_INTERVAL,
        }
    }
}

/// Everything the revalidator works on (the pack manager's shared handles).
#[derive(Clone)]
pub struct RevalidateEnv {
    /// `<app_local_data_dir>/packs`.
    pub packs_root: PathBuf,
    pub http: Http,
    pub core: CoreDb,
    pub user: UserDb,
    pub content: ContentDb,
    pub writers: Writers,
    pub catalog: Arc<Catalog>,
}

/// Called with the ids of packs whose registry state changed (`PackEvents::packs_changed`).
pub type ChangeListener = Arc<dyn Fn(Vec<String>) + Send + Sync>;

/// What happened to one revalidated item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemResult {
    /// Same payload: only `fetched_at` moved.
    Unchanged,
    /// New payload stored (or the item was missing and is now stored).
    Replaced,
    /// Unpinned audio changed upstream: the cached file was dropped and the new timings stored.
    FileDropped,
    /// Pinned audio changed upstream: the new file and timings were swapped in.
    FileSwapped,
}

/// The outcome of one pass ([`Revalidator::run_pass`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PassReport {
    /// Stale items found.
    pub due: u32,
    pub unchanged: u32,
    pub replaced: u32,
    pub files_dropped: u32,
    pub files_swapped: u32,
    /// Items whose refetch failed (they stay stale and are retried by the next pass).
    pub failed: u32,
    /// Items not attempted: unknown pack, or the pass stopped (network gone, shutdown).
    pub skipped: u32,
    /// QuranEnc packs whose update check ran in this pass.
    pub updates_checked: u32,
    /// Packs reported through the change listener.
    pub changed_packs: Vec<String>,
}

/// Packs whose files changed in a batch of items, and packs with an item that could not be revalidated.
#[derive(Debug, Default)]
struct Outcome {
    changed: BTreeSet<String>,
    unfinished: BTreeSet<String>,
}

/// The revalidator. Cheap to clone; its background task ends with the last handle.
#[derive(Clone)]
pub struct Revalidator {
    inner: Arc<Inner>,
}

struct Inner {
    env: RevalidateEnv,
    cfg: RevalidatorConfig,
    on_change: ChangeListener,
    /// Wakes the scheduler (a pass now, or shutdown). Shared with the scheduler task, which only holds a `Weak<Inner>`.
    wake: Arc<Notify>,
    started: AtomicBool,
    /// One pass at a time.
    pass_lock: tokio::sync::Mutex<()>,
    /// Background lane, cancel on shutdown: every request of the revalidator runs under this handle.
    lane: JobHandle,
    /// Updates found by the last checks, by pack id; each is valid for the installed version it names.
    updates: Mutex<HashMap<String, PackUpdate>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.lane.request_cancel();
        // The scheduler finds no revalidator any more and ends.
        self.wake.notify_one();
    }
}

impl Revalidator {
    /// No IO until [`Self::start`] or a pass.
    #[must_use]
    pub fn new(
        env: RevalidateEnv,
        cfg: RevalidatorConfig,
        on_change: impl Fn(Vec<String>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                env,
                cfg,
                on_change: Arc::new(on_change),
                wake: Arc::new(Notify::new()),
                started: AtomicBool::new(false),
                pass_lock: tokio::sync::Mutex::new(()),
                lane: JobHandle::detached(0, "revalidator"),
                updates: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Starts the scheduler once (idempotent): a pass after `first_delay`, then every `interval`.
    pub fn start(&self, rt: &tokio::runtime::Handle) {
        if self.inner.started.swap(true, Ordering::SeqCst) {
            return;
        }
        rt.spawn(schedule(
            Arc::downgrade(&self.inner),
            Arc::clone(&self.inner.wake),
        ));
    }

    /// Runs a pass now (e.g. the network came back), without waiting for the schedule. Needs [`Self::start`].
    pub fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// Stops the scheduler and every request of the revalidator at its next chunk.
    pub fn shutdown(&self) {
        self.inner.lane.request_cancel();
        self.inner.wake.notify_one();
    }

    fn stopped(&self) -> bool {
        self.inner.lane.is_cancelled()
    }

    /// An adapter context on the background lane (no pin: revalidation never changes pins).
    fn ctx(&self, pack: &CatalogPack) -> AdapterCtx {
        let env = &self.inner.env;
        AdapterCtx {
            pack_id: pack.id.clone(),
            kind: pack.kind,
            packs_root: env.packs_root.clone(),
            http: env.http.clone(),
            core: env.core.clone(),
            user: env.user.clone(),
            content: env.content.clone(),
            writers: env.writers.clone(),
            job: Some(self.inner.lane.clone()),
            pin: false,
        }
    }

    fn network_ok(&self) -> bool {
        let http = &self.inner.env.http;
        http.network_allowed() && http.online()
    }

    /// One pass now: every due item, then the QuranEnc update checks that are due. `Err(Offline)` when the network
    /// is not allowed or not reachable (nothing is attempted).
    pub async fn run_pass(&self) -> Result<PassReport, PackError> {
        let _one = self.inner.pass_lock.lock().await;
        if !self.network_ok() {
            return Err(PackError::Offline);
        }
        let env = &self.inner.env;
        let now = env.user.now_ms();
        let mut report = PassReport::default();
        let due = self.due_items(now).await?;
        report.due = u32::try_from(due.len()).unwrap_or(u32::MAX);
        let outcome = self.revalidate_items(due, &mut report).await;
        self.sweep_next_files(now).await;
        if !self.stopped() && self.network_ok() {
            report.updates_checked = self.check_quranenc_due(now).await;
        }
        self.report_changes(outcome, &mut report);
        if report != PassReport::default() {
            log::info!("revalidation pass: {report:?}");
        }
        Ok(report)
    }

    /// Revalidates one pack's stale items now ("Update" of a recitation pack whose pinned files changed upstream).
    pub async fn revalidate_pack(&self, pack_id: &str) -> Result<PassReport, PackError> {
        let _one = self.inner.pass_lock.lock().await;
        if !self.network_ok() {
            return Err(PackError::Offline);
        }
        let now = self.inner.env.user.now_ms();
        let due: Vec<(StaleItem, Arc<CatalogPack>)> = self
            .due_items(now)
            .await?
            .into_iter()
            .filter(|(item, _)| item.pack_id == pack_id)
            .collect();
        let mut report = PassReport {
            due: u32::try_from(due.len()).unwrap_or(u32::MAX),
            ..PassReport::default()
        };
        let outcome = self.revalidate_items(due, &mut report).await;
        if !outcome.unfinished.contains(pack_id) {
            self.settle_audio_update(pack_id);
        }
        self.report_changes(outcome, &mut report);
        Ok(report)
    }

    /// A recitation pack whose stale items all went through has no pending file change any more.
    fn settle_audio_update(&self, pack_id: &str) {
        if self
            .inner
            .env
            .catalog
            .get(pack_id)
            .is_some_and(|p| p.kind == PackKind::Recitation)
        {
            self.inner.updates.lock().remove(pack_id);
        }
    }

    fn report_changes(&self, outcome: Outcome, report: &mut PassReport) {
        for id in &outcome.changed {
            if !outcome.unfinished.contains(id) {
                self.settle_audio_update(id);
            }
        }
        if outcome.changed.is_empty() {
            return;
        }
        let ids: Vec<String> = outcome.changed.into_iter().collect();
        report.changed_packs.clone_from(&ids);
        (self.inner.on_change)(ids);
    }

    /// Every stale item of a catalog pack, by the pack's own revalidation period (oldest first within a period).
    /// Items of packs that are not in the catalog are left alone.
    async fn due_items(&self, now: i64) -> Result<Vec<(StaleItem, Arc<CatalogPack>)>, PackError> {
        let env = &self.inner.env;
        let mut by_age: HashMap<Duration, Vec<Arc<CatalogPack>>> = HashMap::new();
        for pack in env.catalog.packs.iter().filter(|p| p.is_qf_sourced()) {
            by_age
                .entry(max_age(pack))
                .or_default()
                .push(Arc::new(pack.clone()));
        }
        let mut out = Vec::new();
        for (age, packs) in by_age {
            // `stale()` returns `fetched_at < older_than`; an item exactly `age` old is due (see `is_fresh`).
            let older_than = now
                .saturating_sub(i64::try_from(age.as_millis()).unwrap_or(i64::MAX))
                .saturating_add(1);
            let content = env.content.clone();
            let items = blocking(move || Ok(content.stale(older_than)?)).await?;
            for item in items {
                if let Some(pack) = packs.iter().find(|p| p.id == item.pack_id) {
                    out.push((item, Arc::clone(pack)));
                }
            }
        }
        Ok(out)
    }

    async fn revalidate_items(
        &self,
        items: Vec<(StaleItem, Arc<CatalogPack>)>,
        report: &mut PassReport,
    ) -> Outcome {
        let halt = AtomicBool::new(false);
        let results: Vec<(StaleItem, Option<Result<ItemResult, PackError>>)> =
            futures_util::stream::iter(items)
                .map(|(item, pack)| {
                    let halt = &halt;
                    async move {
                        // The network went away or the revalidator stopped: leave the rest for the next pass.
                        if halt.load(Ordering::SeqCst) || self.stopped() || !self.network_ok() {
                            return (item, None);
                        }
                        let result = self.revalidate_item(&item, &pack).await;
                        if matches!(result, Err(PackError::Offline | PackError::Cancelled)) {
                            halt.store(true, Ordering::SeqCst);
                        }
                        (item, Some(result))
                    }
                })
                .buffer_unordered(self.inner.cfg.concurrency.max(1))
                .collect()
                .await;
        let mut outcome = Outcome::default();
        for (item, result) in results {
            let pack_id = item.pack_id;
            match result {
                None | Some(Err(PackError::Offline | PackError::Cancelled)) => {
                    report.skipped = report.skipped.saturating_add(1);
                    outcome.unfinished.insert(pack_id);
                }
                Some(Err(e)) => {
                    log::warn!(
                        "revalidation of {pack_id} {} {} failed: {e}",
                        stale_kind_name(item.kind),
                        item.surah
                    );
                    report.failed = report.failed.saturating_add(1);
                    outcome.unfinished.insert(pack_id);
                }
                Some(Ok(ItemResult::Unchanged)) => {
                    report.unchanged = report.unchanged.saturating_add(1);
                }
                Some(Ok(ItemResult::Replaced)) => {
                    report.replaced = report.replaced.saturating_add(1);
                }
                Some(Ok(ItemResult::FileDropped)) => {
                    report.files_dropped = report.files_dropped.saturating_add(1);
                    outcome.changed.insert(pack_id);
                }
                Some(Ok(ItemResult::FileSwapped)) => {
                    report.files_swapped = report.files_swapped.saturating_add(1);
                    outcome.changed.insert(pack_id);
                }
            }
        }
        outcome
    }

    /// Refetches one stale item and applies the §2.5.7 policy.
    pub async fn revalidate_item(
        &self,
        item: &StaleItem,
        pack: &CatalogPack,
    ) -> Result<ItemResult, PackError> {
        let ctx = self.ctx(pack);
        match (&pack.source, item.kind) {
            (Adapter::QurancomTafsir(cfg), StaleKind::Tafsir) => Ok(chapter_result(
                qurancom_tafsir::revalidate_chapter(&ctx, cfg, item.surah).await?,
            )),
            (Adapter::QurancomWbw(cfg), StaleKind::Wbw) => Ok(chapter_result(
                qurancom_wbw::revalidate_chapter(&ctx, cfg, item.surah).await?,
            )),
            (Adapter::QdcAudio(cfg), StaleKind::Timings) => {
                let refresh = qdc_audio::revalidate_surah(&ctx, cfg, item.surah).await?;
                Ok(match refresh.change {
                    qdc_audio::TimingsChange::Unchanged => ItemResult::Unchanged,
                    qdc_audio::TimingsChange::New
                    | qdc_audio::TimingsChange::Updated
                    | qdc_audio::TimingsChange::PinnedFileChanged => ItemResult::Replaced,
                    qdc_audio::TimingsChange::FileReplaced { .. } => ItemResult::FileDropped,
                    qdc_audio::TimingsChange::PinnedFileSwapped => ItemResult::FileSwapped,
                })
            }
            (source, kind) => Err(PackError::Unsupported(format!(
                "{}: {} items cannot be revalidated by {}",
                pack.id,
                stale_kind_name(kind),
                source.name()
            ))),
        }
    }

    /// Deletes `{sss}.mp3.next` files no swap is waiting for: their surah's timings are fresh (the pair was verified
    /// since) or gone.
    async fn sweep_next_files(&self, now: i64) {
        let env = &self.inner.env;
        let (root, content) = (env.packs_root.clone(), env.content.clone());
        let ages: HashMap<u32, Duration> = env
            .catalog
            .packs
            .iter()
            .filter_map(|p| p.reciter().map(|r| (r.reciter_id, max_age(p))))
            .collect();
        let swept = blocking(move || Ok(sweep_next_blocking(&root, &content, &ages, now))).await;
        match swept {
            Ok(0) => {}
            Ok(n) => log::info!("revalidation: removed {n} obsolete .mp3.next files"),
            Err(e) => log::warn!("revalidation: cannot sweep .mp3.next files: {e}"),
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Update checks
    // -----------------------------------------------------------------------------------------------------------

    /// Checks every installed (or partially installed) pack for an upstream update now (`packs_check_updates`).
    /// QuranEnc packs: a new list version or new zip validators. Recitation packs: pinned files that changed upstream,
    /// which the scheduler (once [`Self::start`] ran) then brings up to date at once; [`Self::revalidate_pack`] does it
    /// in the caller's task. Packs whose check fails are logged and left out; when every check failed because the
    /// network is unavailable, the result is `Err(Offline)`.
    pub async fn check_updates(&self) -> Result<Vec<PackUpdate>, PackError> {
        let env = &self.inner.env;
        if !env.http.network_allowed() {
            return Err(PackError::Offline);
        }
        let user = env.user.clone();
        let rows = blocking(move || Ok(user.packs_installed()?)).await?;
        let mut found = Vec::new();
        let (mut checked, mut offline) = (0u32, 0u32);
        let mut audio_changed = false;
        for row in rows.iter().filter(|r| checkable(r)) {
            let Some(pack) = env.catalog.get(&row.pack_id) else {
                continue;
            };
            if !matches!(
                pack.source,
                Adapter::QuranEncSqlite(_) | Adapter::QdcAudio(_)
            ) {
                continue;
            }
            checked = checked.saturating_add(1);
            match self.check_pack(pack, row).await {
                Ok(Some(update)) => {
                    audio_changed |= pack.kind == PackKind::Recitation;
                    found.push(update);
                }
                Ok(None) => {}
                Err(PackError::Offline) => offline = offline.saturating_add(1),
                Err(e) => log::warn!("update check of {} failed: {e}", row.pack_id),
            }
        }
        if checked > 0 && offline == checked {
            return Err(PackError::Offline);
        }
        if audio_changed {
            self.wake();
        }
        found.sort_by(|a, b| a.pack_id.cmp(&b.pack_id));
        Ok(found)
    }

    /// One pack's check; records `last_checked_at` and the known-update cache.
    async fn check_pack(
        &self,
        pack: &CatalogPack,
        row: &InstalledPackRow,
    ) -> Result<Option<PackUpdate>, PackError> {
        let ctx = self.ctx(pack);
        let update = match &pack.source {
            Adapter::QdcAudio(cfg) => {
                let changes = qdc_audio::pinned_changes(&ctx, cfg).await?;
                (!changes.is_empty()).then(|| PackUpdate {
                    pack_id: pack.id.clone(),
                    installed: row.version.clone(),
                    latest: qdc_audio::changes_label(&changes, ctx.user.now_ms()),
                    size_kib: kib(changes.iter().filter_map(|c| c.new_len).sum()),
                })
            }
            source => source
                .check_update(&ctx, row)
                .await?
                .map(|latest| PackUpdate {
                    pack_id: pack.id.clone(),
                    installed: row.version.clone(),
                    latest,
                    size_kib: pack.size_kib(),
                }),
        };
        self.record_check(&row.pack_id).await;
        let mut updates = self.inner.updates.lock();
        match &update {
            Some(u) => {
                updates.insert(u.pack_id.clone(), u.clone());
            }
            None => {
                updates.remove(&pack.id);
            }
        }
        Ok(update)
    }

    /// QuranEnc packs not checked within `update_check_interval`; returns how many were checked.
    async fn check_quranenc_due(&self, now: i64) -> u32 {
        let env = &self.inner.env;
        let user = env.user.clone();
        let rows = match blocking(move || Ok(user.packs_installed()?)).await {
            Ok(rows) => rows,
            Err(e) => {
                log::warn!("update checks: cannot read the registry: {e}");
                return 0;
            }
        };
        let interval =
            i64::try_from(self.inner.cfg.update_check_interval.as_millis()).unwrap_or(i64::MAX);
        let mut checked = 0u32;
        for row in rows.iter().filter(|r| checkable(r)) {
            let Some(pack) = env.catalog.get(&row.pack_id) else {
                continue;
            };
            if !matches!(pack.source, Adapter::QuranEncSqlite(_))
                || !update_check_due(row.last_checked_at, now, interval)
            {
                continue;
            }
            if self.stopped() || !self.network_ok() {
                break;
            }
            checked = checked.saturating_add(1);
            match self.check_pack(pack, row).await {
                Ok(Some(u)) => log::info!(
                    "update available for {}: {} → {}",
                    u.pack_id,
                    u.installed,
                    u.latest
                ),
                Ok(None) => {}
                Err(e) => log::warn!("update check of {} failed: {e}", row.pack_id),
            }
        }
        checked
    }

    /// Stamps `installed_pack.last_checked_at` without touching anything else of the row.
    async fn record_check(&self, pack_id: &str) {
        let user = self.inner.env.user.clone();
        let pack_id = pack_id.to_owned();
        // One-column update: a job finishing meanwhile rewrites the rest of the row, and its columns must survive.
        let result = blocking(move || {
            user.pack_set_checked(&pack_id, user.now_ms())?;
            Ok(())
        })
        .await;
        if let Err(e) = result {
            log::warn!("update check: cannot record the check time: {e}");
        }
    }

    /// Every update found by the last checks.
    #[must_use]
    pub fn known_updates(&self) -> Vec<PackUpdate> {
        let mut out: Vec<PackUpdate> = self.inner.updates.lock().values().cloned().collect();
        out.sort_by(|a, b| a.pack_id.cmp(&b.pack_id));
        out
    }

    /// The known update of an installed pack, valid only while the installed version is the one that was checked
    /// (an installed update, or a reinstall, makes it obsolete) — the input of `PackState::UpdateAvailable`.
    #[must_use]
    pub fn update_for(&self, row: &InstalledPackRow) -> Option<PackUpdate> {
        self.inner
            .updates
            .lock()
            .get(&row.pack_id)
            .filter(|u| u.installed == row.version)
            .cloned()
    }

    /// Drops a known update (its pack was updated or removed).
    pub fn forget_update(&self, pack_id: &str) {
        self.inner.updates.lock().remove(pack_id);
    }
}

/// The scheduler task: a pass after `first_delay`, then every `interval`; while the network is unavailable a due pass
/// waits in `offline_retry` steps. Ends when the revalidator is dropped or shut down.
async fn schedule(weak: Weak<Inner>, wake: Arc<Notify>) {
    let Some(mut wait) = weak.upgrade().map(|i| i.cfg.first_delay) else {
        return;
    };
    loop {
        // `notify_one` keeps a permit: a wake that arrives during a pass runs the next one at once.
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = wake.notified() => {}
        }
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let revalidator = Revalidator { inner };
        if revalidator.stopped() {
            return;
        }
        wait = match revalidator.run_pass().await {
            // The network went away during the pass: finish it as soon as the network is back.
            Ok(report) if report.skipped > 0 => revalidator.inner.cfg.offline_retry,
            Ok(_) => revalidator.inner.cfg.interval,
            Err(PackError::Offline) => {
                log::debug!("revalidation: network unavailable, retrying later");
                revalidator.inner.cfg.offline_retry
            }
            Err(e) => {
                log::warn!("revalidation pass failed: {e}");
                revalidator.inner.cfg.interval
            }
        };
    }
}

const fn chapter_result(change: ChapterChange) -> ItemResult {
    match change {
        ChapterChange::Unchanged => ItemResult::Unchanged,
        ChapterChange::New | ChapterChange::Replaced => ItemResult::Replaced,
    }
}

const fn stale_kind_name(kind: StaleKind) -> &'static str {
    match kind {
        StaleKind::Timings => "timings",
        StaleKind::Tafsir => "tafsir",
        StaleKind::Wbw => "wbw",
    }
}

/// A pack never checked, checked `interval_ms` or more ago, or "checked" in the future (the clock went back) is due.
fn update_check_due(last_checked_at: Option<i64>, now: i64, interval_ms: i64) -> bool {
    last_checked_at.is_none_or(|at| at > now || now.saturating_sub(at) >= interval_ms)
}

/// Packs worth an update check: installed or partly installed (not paused, failed or being removed).
fn checkable(row: &InstalledPackRow) -> bool {
    matches!(
        row.status,
        InstalledStatus::Installed | InstalledStatus::Partial
    )
}

fn kib(bytes: u64) -> u32 {
    u32::try_from(bytes.div_ceil(1024)).unwrap_or(u32::MAX)
}

/// [`Revalidator::sweep_next_files`] on a blocking thread; returns the files removed.
fn sweep_next_blocking(
    root: &Path,
    content: &ContentDb,
    ages: &HashMap<u32, Duration>,
    now: i64,
) -> u32 {
    let mut removed = 0u32;
    let Ok(dirs) = std::fs::read_dir(root.join("audio")) else {
        return 0;
    };
    for dir in dirs.flatten() {
        let Some(reciter) = dir.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        let stamps = content.timing_stamps(Some(reciter)).unwrap_or_default();
        let age = ages.get(&reciter).copied().unwrap_or(MAX_AGE);
        for f in files.flatten() {
            let name = f.file_name();
            // The swap's file and its resumable temps: `{sss}.mp3.next`, `{sss}.mp3.dl.part`, `{sss}.mp3.dl.part.json`.
            let Some(surah) = name
                .to_str()
                .and_then(|n| {
                    [qdc_audio::NEXT_SUFFIX, ".mp3.dl.part", ".mp3.dl.part.json"]
                        .iter()
                        .find_map(|suffix| n.strip_suffix(suffix))
                })
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            let waiting = stamps
                .iter()
                .any(|s| s.surah == surah && !is_fresh(s.fetched_at_ms, now, age));
            if !waiting && install::remove_file_blocking(&f.path()).is_ok() {
                removed = removed.saturating_add(1);
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn freshness_window() {
        let now = 1_000_000_000_000;
        let day = 86_400_000;
        assert!(is_fresh(now, now, MAX_AGE));
        assert!(is_fresh(now - 7 * day + 1, now, MAX_AGE));
        assert!(
            !is_fresh(now - 7 * day, now, MAX_AGE),
            "exactly 7 days old is due"
        );
        assert!(
            !is_fresh(now + 1, now, MAX_AGE),
            "a fetch time in the future is re-stamped"
        );
        assert!(!is_fresh(0, now, MAX_AGE));
        assert!(!is_fresh(i64::MIN, i64::MAX, MAX_AGE));
    }

    #[test]
    fn quranenc_checks_are_daily() {
        let day = 86_400_000;
        let now = 10 * day;
        assert!(update_check_due(None, now, day));
        assert!(!update_check_due(Some(now - day + 1), now, day));
        assert!(update_check_due(Some(now - day), now, day));
        assert!(
            update_check_due(Some(now + 1), now, day),
            "a check time in the future"
        );
    }

    #[test]
    fn api_roots_can_be_redirected() {
        let root = ApiRoot::new("https://example.invalid/api");
        assert_eq!(root.get(), "https://example.invalid/api");
        root.set(Some("http://127.0.0.1:9/x/"));
        assert_eq!(root.get(), "http://127.0.0.1:9/x");
        root.set(None);
        assert_eq!(root.get(), root.default_root());
    }

    #[test]
    fn pack_periods_are_clamped_to_the_qf_rule() {
        let mut pack: CatalogPack = serde_json::from_value(serde_json::json!({
            "id": "wbw.en", "kind": "wbw", "title": { "en": "a", "ar": "ب" },
            "description": { "en": "a", "ar": "ب" }, "version": "2026.10", "installMode": "on_demand",
            "sizeBytes": 1, "itemCount": 114, "revalidateDays": 3,
            "attribution": { "text": { "en": "a", "ar": "ب" }, "url": "https://quran.com", "licence": "x" },
            "source": { "adapter": "qurancom_v4_wbw", "language": "en" }
        }))
        .unwrap();
        assert_eq!(max_age(&pack), DAY * 3);
        pack.revalidate_days = Some(30);
        assert_eq!(max_age(&pack), MAX_AGE);
        pack.revalidate_days = Some(0);
        assert_eq!(max_age(&pack), DAY);
        pack.revalidate_days = None;
        assert_eq!(max_age(&pack), MAX_AGE);
    }
}
