//! `PackManager`: the public API of the crate, a registry view over the `installed_pack` and `pack_item` tables, cache
//! clearing and settings hooks.
//!
//! The manager wires the download machinery together and owns the policy that spans it:
//! - **Wiring.** One [`Http`] (limits, mirrors, online tracking; its listener reports `PackEvents::network`), one
//!   [`Writers`] registry, one [`JobQueue`] (its observer forwards download events, coalesced `packs_changed` and drops
//!   cached pack DBs before a flip), the font lane ([`Fonts`]) and the 7-day [`Revalidator`].
//! - **Registry view.** [`PackManager::list`] / [`PackManager::summaries`] derive each catalog pack's
//!   [`PackState`] from its `installed_pack` row, its job and the known updates (a paused or failed job that runs again
//!   reads as what the pack holds, not as its last stop, until the job ends); [`PackManager::items`] lists the items
//!   of on-demand packs (`pack_item` rows plus the not-yet-present items of a running or paused job).
//! - **Installs.** [`PackManager::install`] queues a job (pinning). A scope-`All` install also queues the packs it
//!   `requires` that are not installed (decor for a Mushaf), and the "Update" of a recitation pack whose pinned files
//!   changed upstream becomes a job that runs the revalidator's swap for that pack (module item "Recitation updates").
//! - **On-demand content.** [`PackManager::surah_timings`], [`PackManager::tafsir_entry`] and
//!   [`PackManager::wbw_range`] fetch on the interactive lane (in-flight requests shared per item) and record what they
//!   fetched as unpinned `pack_item` rows, so the Downloads screen and "Clear cache" see it.
//! - **Caches.** Stream-cached audio (`pinned = 0` rows of recitation packs) is evicted least recently used first above
//!   `settings.stream_cache_cap_mib`; "Clear stream cache" drops all of it; "Clear cache" also clears content.db's
//!   unpinned rows and re-syncs the registry. Pinned (explicitly downloaded) files and their timings always survive.
//! - **Re-sync** ([`PackManager::resync`]): at startup and after "Clear cache", every item row is checked against what
//!   backs it (its file, its content.db chapter, its timings). Rows whose data is gone are dropped, stored chapters
//!   without a row are recorded, and each pack's `installed_pack` row is recomputed with the job runner's policy
//!   (`installed` when every catalog item is present and pinned, else `partial`), so a pack is never "installed"
//!   without its data. A pinned recitation file whose timings were lost keeps its pin (it is never demoted to the
//!   evictable cache) but counts as missing until the timings are fetched again ([`StartupReport::timings_repaired`]).
//! - **Startup** ([`PackManager::start_background`]): the offline re-probe, the `packs/` sweep (finishing interrupted
//!   removals), the re-sync, the resume of interrupted jobs, the revalidator, the timings repair and the cache cap.
//!
//! **Recitation updates.** The revalidator applies a changed pinned file by downloading it beside the old one and
//! swapping both. The job runner skips pinned items, so the user's "Update" (`install(id, All)` on an
//! `update_available` recitation pack) is queued as a job with one pseudo item (`file:update`) whose work is
//! `Revalidator::revalidate_pack`, serialised with the scheduled passes. Such a job is the only recitation job that
//! does not pin (`JobSpec::pin == false`), which is how the spec source rebuilds it after a restart. Its pseudo row is
//! removed when the job ends.
//!
//! **Known updates** of whole packs (QuranEnc) survive restarts in content.db's `kv` cache: an update stays valid while
//! the installed version is the one it was found for and no later check (`installed_pack.last_checked_at`) has run.
//!
//! Nothing here panics; blocking SQLite and file-system work runs on the blocking pool.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use quran_core::content_db::geometry;
use quran_core::{
    ChapterStamp, ContentDb, CoreDb, CoreError, InstalledPackRow, InstalledStatus, PackDb,
    PackItemRow, StoredTimings, TafsirRow, UserDb,
};
use quran_types::{
    AYAH_COUNT, AppError, DecorStatus, DiskUsage, DownloadEvent, FetchPriority, InstallScope,
    JobPhase, JobSnapshot, L10nText, MushafStyle, PAGE_COUNT, PackInfo, PackItemState, PackKind,
    PackState, PackSummary, PackUpdate, PageFontStatus, ReciterInfo, SURAH_COUNT, Settings,
    TafsirEntry, TextDir, WORD_COUNT, WbwEntry,
};
use serde::{Deserialize, Serialize};

use crate::PackError;
use crate::adapters::{
    Adapter, AdapterCtx, ItemKey, ItemOutcome, QdcAudioConfig, StagedPack, qdc_audio,
    qurancom_tafsir, qurancom_wbw,
};
use crate::catalog::{Catalog, CatalogPack, language_direction};
use crate::fonts::{Fonts, FontsConfig, PROTOCOL_BASE};
use crate::http::{Http, HttpConfig, InFlight};
use crate::install::{self, SweepReport};
use crate::jobs::{
    ITEM_CONCURRENCY, JobEnv, JobHandle, JobObserver, JobQueue, JobSpec, MAX_RUNNING, PackWork,
    SpecSource,
};
use crate::revalidate::{self, ChapterState, RevalidateEnv, Revalidator, RevalidatorConfig};
use crate::writers::Writers;

/// `packs_changed` notifications that arrive within this window go out as one event (a prefetch or a reading session
/// records many on-demand items in a row).
pub const CHANGES_COALESCE: Duration = Duration::from_millis(150);
/// Chapters one [`PackManager::wbw_range`] call fetches at once (a range in juz 30 spans many short surahs).
pub const CHAPTER_CONCURRENCY: usize = 4;
/// How long a reader waits for a stale Quran.com chapter to be refetched before the stored copy is served
/// (stale-while-revalidate, `ensure_chapter`): long enough for a normal round trip, short enough not to be felt.
pub const REVALIDATE_GRACE: Duration = Duration::from_millis(1500);
/// The `kv` key of the persisted update findings of whole packs.
const UPDATES_KV_KEY: &str = "packs.known_updates";
/// The pseudo item of a recitation update job (`pack_item.item = "file:update"` while it runs).
const UPDATE_ITEM: &str = "update";
/// Upper bound on the cache rows read by one eviction pass.
const EVICTION_SCAN: u32 = 1_000_000;

/// Everything the manager needs, resolved by the app shell at startup.
pub struct PackManagerConfig {
    /// `<app_local_data_dir>/packs`.
    pub packs_root: PathBuf,
    /// Resource `data/catalog.json`.
    pub catalog_path: PathBuf,
    pub core: CoreDb,
    pub user: UserDb,
    pub content: ContentDb,
    pub runtime: tokio::runtime::Handle,
    /// `"QuranForDesktop/<version>"`.
    pub user_agent: String,
    /// From settings at startup.
    pub network_allowed: bool,
    /// From `settings.stream_cache_cap_mib` at startup.
    pub stream_cache_cap_bytes: u64,
}

/// Implemented by `src-tauri/src/packs_glue.rs`: forwards [`DownloadEvent`]s to the channel registered by
/// `packs_subscribe`, and emits `PacksChanged` / `NetworkChanged`.
pub trait PackEvents: Send + Sync + 'static {
    /// Throttled to ≤ 10/s per job.
    fn download(&self, e: DownloadEvent);
    fn packs_changed(&self, pack_ids: Vec<String>);
    fn network(&self, online: bool);
}

/// Tunables of a manager; [`ManagerOptions::default`] gives the default values (tests shorten the waits).
#[derive(Debug, Clone)]
pub struct ManagerOptions {
    /// The HTTP layer. `None`: the HTTP defaults with [`PackManagerConfig::user_agent`]. The network switch always
    /// comes from [`PackManagerConfig::network_allowed`].
    pub http: Option<HttpConfig>,
    pub revalidator: RevalidatorConfig,
    /// The `quran://` base of font URLs ([`PROTOCOL_BASE`] in the app).
    pub protocol_base: String,
    /// Jobs running at once.
    pub max_running: usize,
    /// Items of one job downloading at once.
    pub item_concurrency: usize,
    /// Coalescing window of `PackEvents::packs_changed`; zero sends every notification at once.
    pub changes_coalesce: Duration,
}

impl Default for ManagerOptions {
    fn default() -> Self {
        Self {
            http: None,
            revalidator: RevalidatorConfig::default(),
            protocol_base: PROTOCOL_BASE.to_owned(),
            max_running: MAX_RUNNING,
            item_concurrency: ITEM_CONCURRENCY,
            changes_coalesce: CHANGES_COALESCE,
        }
    }
}

/// What the startup tasks did ([`PackManager::startup`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartupReport {
    /// The `packs/` sweep (stale temps, orphan staging, unreferenced versions).
    pub swept: SweepReport,
    /// Per-item packs whose interrupted removal was finished.
    pub removals_finished: Vec<String>,
    /// The registry re-sync.
    pub resync: ResyncReport,
    /// Jobs that were queued or running when the app stopped, queued again.
    pub resumed_jobs: Vec<u32>,
    /// Pinned recitation surahs whose missing timings were fetched again.
    pub timings_repaired: u32,
    /// Stream cache evicted down to the cap.
    pub evicted_bytes: u64,
}

/// What a registry re-sync changed ([`PackManager::resync`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResyncReport {
    /// Packs whose `pack_item` or `installed_pack` rows changed, in catalog order.
    pub changed: Vec<String>,
    /// Item rows dropped: their file, chapter or pack DB is gone (or the row is not an item of its pack).
    pub rows_dropped: u32,
    /// Item rows recorded for chapters stored in content.db without one.
    pub rows_added: u32,
    /// Pinned recitation surahs whose timings are missing, `(pack id, surah)`: counted as not present.
    pub missing_timings: Vec<(String, u32)>,
}

/// Cheap-to-clone handle on the pack manager. `Send + Sync`.
#[derive(Clone)]
pub struct PackManager {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    /// `packs_root`'s parent: where `user.db` and `content.db` live (disk usage).
    data_dir: PathBuf,
    catalog: Arc<Catalog>,
    core: CoreDb,
    user: UserDb,
    content: ContentDb,
    rt: tokio::runtime::Handle,
    http: Http,
    writers: Writers,
    jobs: JobQueue,
    fonts: Fonts,
    revalidator: Revalidator,
    hub: Arc<Hub>,
    stream_cache_cap: AtomicU64,
    timing_flights: InFlight<(u32, u32), qdc_audio::EnsuredTimings>,
    chapter_flights: InFlight<(String, u32), ChapterState>,
    /// One eviction pass at a time.
    eviction: tokio::sync::Mutex<()>,
    /// [`PackManager::startup`] ran (or is running).
    started: AtomicBool,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.revalidator.shutdown();
    }
}

impl PackManager {
    /// Loads and validates the catalog (`Catalog::load_validated`; the onboarding starter-set rules are logged as
    /// warnings) and builds the manager. No other IO: nothing is read from the registry, the network or `packs/` until
    /// a call or [`PackManager::start_background`].
    pub fn new(cfg: PackManagerConfig, events: Arc<dyn PackEvents>) -> Result<Self, PackError> {
        let catalog = Catalog::load_validated(&cfg.catalog_path)?;
        for issue in catalog.starter_issues() {
            log::warn!("catalog: {issue}");
        }
        log::info!(
            "catalog: {} packs (generated {})",
            catalog.packs.len(),
            catalog.generated_at
        );
        Self::with_catalog(cfg, catalog, events, ManagerOptions::default())
    }

    /// A manager on an already loaded catalog (validated or not: tests point packs at a local server) with explicit
    /// tunables. `cfg.catalog_path` is not read. No IO.
    pub fn with_catalog(
        cfg: PackManagerConfig,
        catalog: Catalog,
        events: Arc<dyn PackEvents>,
        options: ManagerOptions,
    ) -> Result<Self, PackError> {
        let PackManagerConfig {
            packs_root,
            catalog_path: _,
            core,
            user,
            content,
            runtime,
            user_agent,
            network_allowed,
            stream_cache_cap_bytes,
        } = cfg;
        let catalog = Arc::new(catalog);
        let mut http_cfg = options.http.unwrap_or_else(|| HttpConfig::new(user_agent));
        http_cfg.network_allowed = network_allowed;
        let http = Http::new(http_cfg)?;
        let writers = Writers::new();
        let hub = Hub::new(
            Arc::clone(&events),
            runtime.clone(),
            user.clone(),
            content.clone(),
            Arc::clone(&catalog),
            options.changes_coalesce,
        );

        let revalidator = Revalidator::new(
            RevalidateEnv {
                packs_root: packs_root.clone(),
                http: http.clone(),
                core: core.clone(),
                user: user.clone(),
                content: content.clone(),
                writers: writers.clone(),
                catalog: Arc::clone(&catalog),
            },
            options.revalidator,
            hub.notifier(),
        );
        // `set` only fails when already set, which cannot happen on a hub built just above.
        let _ = hub.revalidator.set(revalidator.clone());

        {
            let hub = Arc::downgrade(&hub);
            http.set_listener(move |online| {
                if let Some(hub) = hub.upgrade() {
                    hub.network(online);
                }
            });
        }

        let fonts = Fonts::new(
            FontsConfig {
                packs_root: packs_root.clone(),
                http: http.clone(),
                user: user.clone(),
                protocol_base: options.protocol_base,
            },
            &catalog,
        );
        fonts.set_listener(hub.notifier());

        let jobs = JobQueue::with_limits(
            JobEnv {
                packs_root: packs_root.clone(),
                http: http.clone(),
                core: core.clone(),
                user: user.clone(),
                content: content.clone(),
                writers: writers.clone(),
                runtime: runtime.clone(),
                observer: hub.clone(),
            },
            spec_source(Arc::clone(&catalog), revalidator.clone()),
            options.max_running,
            options.item_concurrency,
        );

        let data_dir = packs_root
            .parent()
            .map_or_else(|| packs_root.clone(), Path::to_path_buf);
        Ok(Self {
            inner: Arc::new(Inner {
                root: packs_root,
                data_dir,
                catalog,
                core,
                user,
                content,
                rt: runtime,
                http,
                writers,
                jobs,
                fonts,
                revalidator,
                hub,
                stream_cache_cap: AtomicU64::new(stream_cache_cap_bytes),
                timing_flights: InFlight::new(),
                chapter_flights: InFlight::new(),
                eviction: tokio::sync::Mutex::new(()),
                started: AtomicBool::new(false),
            }),
        })
    }

    #[must_use]
    pub fn catalog(&self) -> &Catalog {
        &self.inner.catalog
    }

    /// The shared HTTP client for files (no decompression, the app's User-Agent and proxies): the audio streaming source
    /// uses it, so streams and downloads share one connection pool.
    #[must_use]
    pub fn http_client(&self) -> reqwest::Client {
        self.inner.http.client()
    }

    // -----------------------------------------------------------------------------------------------------------
    // Registry view
    // -----------------------------------------------------------------------------------------------------------

    /// Every catalog pack with its registry state, installed size and job. Blocking (user.db).
    pub fn list(&self) -> Result<Vec<PackInfo>, PackError> {
        let rows = self.installed_rows()?;
        Ok(self
            .inner
            .catalog
            .packs
            .iter()
            .map(|pack| {
                let row = rows.get(&pack.id);
                let job = self.inner.jobs.snapshot(&pack.id);
                let state = self.pack_state(pack, row, job.as_ref());
                pack.info(state, installed_kib(row), job)
            })
            .collect())
    }

    /// The short view of every catalog pack (`Bootstrap.packs`). Blocking (user.db).
    pub fn summaries(&self) -> Result<Vec<PackSummary>, PackError> {
        let rows = self.installed_rows()?;
        Ok(self
            .inner
            .catalog
            .packs
            .iter()
            .map(|pack| {
                let job = self.inner.jobs.snapshot(&pack.id);
                pack.summary(self.pack_state(pack, rows.get(&pack.id), job.as_ref()))
            })
            .collect())
    }

    /// Every reciter in catalog order. `word_level` is the catalog's until timings of the reciter are stored (then
    /// whether any stored surah has word segments); `downloaded_surahs` / `cached_surahs` count the pinned and the
    /// stream-cached surah files. Blocking (user.db, content.db); on a database error the catalog values are returned.
    #[must_use]
    pub fn reciters(&self) -> Vec<ReciterInfo> {
        let mut list = self.inner.catalog.reciters();
        if let Err(e) = self.fill_reciter_counts(&mut list) {
            log::warn!("reciters: cannot read the registry: {e}");
        }
        list
    }

    fn fill_reciter_counts(&self, list: &mut [ReciterInfo]) -> Result<(), PackError> {
        let stamps = self.inner.content.timing_stamps(None)?;
        let mut word_level: HashMap<u32, bool> = HashMap::new();
        for s in &stamps {
            *word_level.entry(s.reciter_id).or_default() |= s.word_level;
        }
        for r in list.iter_mut() {
            if let Some(&level) = word_level.get(&r.id) {
                r.word_level = level;
            }
            let (mut pinned, mut cached) = (0u32, 0u32);
            for row in self.inner.user.pack_items(&r.pack_id)? {
                if matches!(ItemKey::parse_db_key(&row.item), Some(ItemKey::Surah(_))) {
                    if row.pinned {
                        pinned = pinned.saturating_add(1);
                    } else {
                        cached = cached.saturating_add(1);
                    }
                }
            }
            r.downloaded_surahs = pinned;
            r.cached_surahs = cached;
        }
        Ok(())
    }

    /// `(name, basmala_in_file)` from the catalog.
    #[must_use]
    pub fn reciter_meta(&self, reciter_id: u32) -> Option<(L10nText, bool)> {
        self.inner.catalog.reciter_meta(reciter_id)
    }

    /// Per page/surah/chapter state of an on-demand pack: present items (pinned or fetched on demand) plus the
    /// not-yet-present items of its running or paused job (`queued`). Whole packs (translations, QuranEnc tafsir, decor)
    /// have no numbered items: an empty list. Blocking (user.db).
    pub fn items(&self, pack_id: &str) -> Result<Vec<PackItemState>, PackError> {
        let pack = self.inner.catalog.require(pack_id)?;
        if !has_numbered_items(&pack.source) {
            return Ok(Vec::new());
        }
        let mut out: BTreeMap<u32, PackItemState> = BTreeMap::new();
        for row in self.inner.user.pack_items(pack_id)? {
            let Some(n) = ItemKey::parse_db_key(&row.item)
                .filter(|k| is_item_of(&pack.source, k))
                .and_then(|k| k.number())
            else {
                continue;
            };
            out.insert(
                n,
                PackItemState {
                    item: n,
                    pinned: row.pinned,
                    queued: false,
                    kib: kib(row.bytes),
                },
            );
        }
        for key in self.inner.jobs.job_items(pack_id).unwrap_or_default() {
            let Some(n) = key.number() else {
                continue;
            };
            match out.get_mut(&n) {
                Some(present) if present.pinned => {}
                Some(present) => present.queued = true,
                None => {
                    out.insert(
                        n,
                        PackItemState {
                            item: n,
                            pinned: false,
                            queued: true,
                            kib: 0,
                        },
                    );
                }
            }
        }
        Ok(out.into_values().collect())
    }

    /// Queued, running, paused and failed jobs, in queue order.
    #[must_use]
    pub fn jobs(&self) -> Vec<JobSnapshot> {
        self.inner.jobs.jobs()
    }

    fn installed_rows(&self) -> Result<HashMap<String, InstalledPackRow>, PackError> {
        Ok(self
            .inner
            .user
            .packs_installed()?
            .into_iter()
            .map(|r| (r.pack_id.clone(), r))
            .collect())
    }

    /// The registry state of a catalog pack (module docs): its row, else its job; a known update of an installed or
    /// partly installed pack wins.
    fn pack_state(
        &self,
        pack: &CatalogPack,
        row: Option<&InstalledPackRow>,
        job: Option<&JobSnapshot>,
    ) -> PackState {
        let failure = || {
            job.and_then(|j| j.error.clone()).unwrap_or_else(|| {
                AppError::Internal(format!("the last download of {} did not finish", pack.id))
            })
        };
        let Some(row) = row else {
            return match job.map(|j| j.phase) {
                Some(JobPhase::Paused) => PackState::Paused {
                    items_present: 0,
                    items_total: items_total(pack),
                },
                Some(JobPhase::Failed) => PackState::Failed { error: failure() },
                _ => PackState::NotInstalled,
            };
        };
        // A paused or failed job that was resumed (or retried) is downloading again: the row keeps the stop until the
        // job ends and writes it anew, so meanwhile the pack is what it holds so far, as before its first stop. The live
        // job is what the Downloads screen shows over it.
        let live = job.is_some_and(|j| {
            matches!(
                j.phase,
                JobPhase::Queued
                    | JobPhase::Downloading
                    | JobPhase::Verifying
                    | JobPhase::Installing
            )
        });
        if live
            && matches!(
                row.status,
                InstalledStatus::Paused | InstalledStatus::Failed
            )
        {
            return if row.items_present > 0 {
                PackState::Partial {
                    items_present: row.items_present,
                    items_total: row.items_total,
                }
            } else {
                PackState::NotInstalled
            };
        }
        match row.status {
            InstalledStatus::Installed | InstalledStatus::Partial => {
                if let Some(update) = self.update_for(row) {
                    PackState::UpdateAvailable {
                        installed: update.installed,
                        latest: update.latest,
                    }
                } else if row.status == InstalledStatus::Installed {
                    PackState::Installed {
                        version: row.version.clone(),
                    }
                } else {
                    PackState::Partial {
                        items_present: row.items_present,
                        items_total: row.items_total,
                    }
                }
            }
            InstalledStatus::Paused => PackState::Paused {
                items_present: row.items_present,
                items_total: row.items_total,
            },
            InstalledStatus::Failed => PackState::Failed { error: failure() },
            InstalledStatus::Removing => PackState::NotInstalled,
        }
    }

    /// The update known for an installed row: the revalidator's (this session), else a persisted finding for a whole
    /// pack (module docs). Recitation updates are applied in the background, so only live findings count for them.
    fn update_for(&self, row: &InstalledPackRow) -> Option<PackUpdate> {
        if let Some(update) = self.inner.revalidator.update_for(row) {
            if is_whole_kind(row.kind) {
                self.inner.hub.remember_update(&update, row.last_checked_at);
            }
            return Some(update);
        }
        if is_whole_kind(row.kind) {
            self.inner.hub.persisted_update(row)
        } else {
            None
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Jobs
    // -----------------------------------------------------------------------------------------------------------

    /// Queues an explicit download (pinned items); returns the job id. `Conflict` while a job of the pack is queued or
    /// running. A scope-`All` install also queues the packs it requires that are not installed, and the "Update" of a
    /// recitation pack with a known update applies that update instead (module docs).
    pub async fn install(&self, pack_id: &str, scope: InstallScope) -> Result<u32, PackError> {
        let pack = self.inner.catalog.require(pack_id)?.clone();
        // Validates the scope (item ranges, whole packs) before anything is written.
        pack.source.items(&scope)?;
        let row = self.installed_row(pack_id).await?;
        if row
            .as_ref()
            .is_some_and(|r| r.status == InstalledStatus::Removing)
        {
            self.finish_removal(&pack).await?;
        }
        if pack.kind == PackKind::Recitation
            && scope == InstallScope::All
            && let Some(update) = row
                .as_ref()
                .and_then(|r| self.inner.revalidator.update_for(r))
        {
            return self.enqueue_recitation_update(&pack, &update).await;
        }
        if scope == InstallScope::All {
            self.install_requirements(&pack).await;
        }
        let job_id = self
            .inner
            .jobs
            .enqueue(JobSpec::from_catalog(&pack, scope, true))
            .await?;
        log::info!("{pack_id}: download queued as job {job_id}");
        Ok(job_id)
    }

    /// Queues `All` for every pack `pack` requires that is neither installed nor being downloaded. A failure there is
    /// logged: the pack itself still installs (decor is optional at runtime).
    async fn install_requirements(&self, pack: &CatalogPack) {
        for req_id in &pack.requires {
            let Some(req) = self.inner.catalog.get(req_id) else {
                continue;
            };
            if self.inner.jobs.is_active(req_id) {
                continue;
            }
            match self.installed_row(req_id).await {
                Ok(Some(row)) if row.status == InstalledStatus::Installed => continue,
                Ok(_) => {}
                Err(e) => {
                    log::warn!("{}: cannot read {req_id}'s registry row: {e}", pack.id);
                    continue;
                }
            }
            match self
                .inner
                .jobs
                .enqueue(JobSpec::from_catalog(req, InstallScope::All, true))
                .await
            {
                Ok(id) => log::info!("{}: queued its requirement {req_id} as job {id}", pack.id),
                Err(PackError::Conflict(_)) => {}
                Err(e) => log::warn!("{}: cannot queue its requirement {req_id}: {e}", pack.id),
            }
        }
    }

    async fn enqueue_recitation_update(
        &self,
        pack: &CatalogPack,
        update: &PackUpdate,
    ) -> Result<u32, PackError> {
        let (user, pack_id) = (self.inner.user.clone(), pack.id.clone());
        // A pseudo row left by an interrupted update would make the runner skip the work.
        blocking(move || Ok(user.pack_item_delete(&pack_id, &update_item_key())?)).await?;
        let mut spec = recitation_update_spec(pack, self.inner.revalidator.clone());
        spec.size_bytes = u64::from(update.size_kib).saturating_mul(1024);
        let job_id = self.inner.jobs.enqueue(spec).await?;
        log::info!(
            "{}: update {} → {} queued as job {job_id}",
            pack.id,
            update.installed,
            update.latest
        );
        Ok(job_id)
    }

    /// Pauses the pack's job: a running job stops at its next chunk and keeps its temps; a queued one never starts.
    /// Idempotent on a paused or failed job; `NotFound` without one.
    pub async fn pause(&self, pack_id: &str) -> Result<(), PackError> {
        self.inner.catalog.require(pack_id)?;
        self.inner.jobs.pause(pack_id).await
    }

    /// Resumes a paused job, or retries a failed one, with its scope; returns the job id (a queued or running job's id as
    /// is). `NotFound` when there is nothing to resume.
    pub async fn resume(&self, pack_id: &str) -> Result<u32, PackError> {
        self.inner.catalog.require(pack_id)?;
        self.inner.jobs.resume(pack_id).await
    }

    /// Cancels the pack's job and deletes its temps; items already completed are kept. `NotFound` without a job.
    pub async fn cancel(&self, pack_id: &str) -> Result<(), PackError> {
        self.inner.catalog.require(pack_id)?;
        self.inner.jobs.cancel(pack_id).await
    }

    /// Removes the pack from disk: its job is cancelled (and waited for) first, then its files, its content.db rows and
    /// its registry rows go. A file Windows still holds is deleted at the next start (the row stays `removing`, shown
    /// as not installed).
    pub async fn remove(&self, pack_id: &str) -> Result<(), PackError> {
        let pack = self.inner.catalog.require(pack_id)?.clone();
        self.stop_job(pack_id).await;
        self.inner.revalidator.forget_update(pack_id);
        self.inner.hub.forget_update(pack_id);
        let result = self.remove_pack(&pack).await;
        self.inner.hub.changed(vec![pack.id.clone()]);
        let freed = result?;
        log::info!("{pack_id}: removed ({freed} bytes freed)");
        Ok(())
    }

    /// Cancels the pack's job, if any, and waits until it has stopped.
    async fn stop_job(&self, pack_id: &str) {
        let running = self.inner.jobs.handle(pack_id);
        match self.inner.jobs.cancel(pack_id).await {
            Ok(()) | Err(PackError::NotFound(_)) => {}
            Err(e) => log::warn!("{pack_id}: cancelling its job failed: {e}"),
        }
        if let Some(handle) = running {
            self.inner.jobs.wait(handle.job_id()).await;
        }
    }

    async fn remove_pack(&self, pack: &CatalogPack) -> Result<u64, PackError> {
        if matches!(pack.source, Adapter::QuranEncSqlite(_)) {
            let hub = Arc::clone(&self.inner.hub);
            let id = pack.id.clone();
            return install::remove_whole(
                &self.inner.root,
                &self.inner.user,
                &pack.id,
                pack.kind,
                move || hub.release_pack_db(&id),
            )
            .await;
        }
        let env = self.sync_env();
        let pack = pack.clone();
        blocking(move || remove_per_item_blocking(&env, &pack)).await
    }

    /// Finishes an interrupted removal (`removing` row) before the pack is installed again; `Conflict` while a file is
    /// still held.
    async fn finish_removal(&self, pack: &CatalogPack) -> Result<(), PackError> {
        self.remove_pack(pack).await?;
        match self.installed_row(&pack.id).await? {
            Some(row) if row.status == InstalledStatus::Removing => Err(PackError::Conflict(
                format!("{} is still being removed: a file is in use", pack.id),
            )),
            _ => Ok(()),
        }
    }

    /// Removes items of an on-demand pack (pages, surahs, chapters); returns the bytes freed. A recitation's surah 1
    /// stays while another surah of the reciter stays pinned (every other surah plays its basmala from it). Pinned
    /// timings of a removed surah become cache. The pack's registry row is recomputed.
    pub async fn remove_items(&self, pack_id: &str, items: &[u32]) -> Result<u64, PackError> {
        let pack = self.inner.catalog.require(pack_id)?.clone();
        let keys = item_keys(&pack, items)?;
        if keys.is_empty() {
            return Ok(0);
        }
        let env = self.sync_env();
        let freed = {
            let pack = pack.clone();
            blocking(move || remove_items_blocking(&env, &pack, keys)).await?
        };
        if let Err(e) = self.resync(Some(std::slice::from_ref(&pack.id))).await {
            log::warn!("{pack_id}: cannot recompute its registry row: {e}");
        }
        self.inner.hub.changed(vec![pack.id.clone()]);
        log::info!("{pack_id}: removed items {items:?} ({freed} bytes freed)");
        Ok(freed)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Fonts
    // -----------------------------------------------------------------------------------------------------------

    /// Resolves when each page is `Ready`, `Failed` or `Unavailable`; `hafs` → `Ready` "qd-hafs" without IO.
    pub async fn ensure_page_fonts(
        &self,
        style: MushafStyle,
        pages: &[u32],
        prio: FetchPriority,
    ) -> Result<Vec<PageFontStatus>, PackError> {
        self.inner.fonts.ensure_page_fonts(style, pages, prio).await
    }

    /// Downloads the missing decor fonts (when the network is allowed and reachable) and returns their status.
    pub async fn ensure_decor(&self) -> Result<DecorStatus, PackError> {
        self.inner.fonts.ensure_decor().await
    }

    /// The decor fonts on disk now (reads at most three small files once; hashes are cached).
    #[must_use]
    pub fn decor_status(&self) -> DecorStatus {
        self.inner.fonts.decor_status()
    }

    // -----------------------------------------------------------------------------------------------------------
    // Content
    // -----------------------------------------------------------------------------------------------------------

    /// The open pack DB of an installed whole pack (a QuranEnc translation or tafsir), cached until the pack is updated
    /// or removed. `NotFound` when the pack is not installed or has no pack DB; `Core(NotFound)` when its file has gone.
    /// Blocking (opens SQLite).
    pub fn translation_db(&self, pack_id: &str) -> Result<PackDb, PackError> {
        let not_installed = || PackError::NotFound(format!("{pack_id} is not installed"));
        let row = self
            .inner
            .user
            .pack_installed(pack_id)?
            .filter(|r| {
                r.status == InstalledStatus::Installed
                    && matches!(r.kind, PackKind::Translation | PackKind::Tafsir)
            })
            .ok_or_else(not_installed)?;
        let rel = row
            .path
            .ok_or_else(|| PackError::NotFound(format!("{pack_id} has no pack database")))?;
        let path = install::resolve(&self.inner.root, &rel)?;
        if let Some(db) = self.inner.hub.cached_pack_db(pack_id, &path) {
            return Ok(db);
        }
        let db = PackDb::open(&path)?;
        self.inner.hub.cache_pack_db(pack_id, path, db.clone());
        Ok(db)
    }

    /// The tafsir entry covering `ayah_id`. A QuranEnc tafsir reads its pack DB (`NotFound` when not installed); a
    /// Quran.com tafsir fetches the ayah's chapter on demand (`Offline` when it is not stored and cannot be fetched) and
    /// reports when it was fetched and whether that copy is stale. `NotFound` when the pack has no entry for the ayah.
    pub async fn tafsir_entry(
        &self,
        pack_id: &str,
        ayah_id: u32,
    ) -> Result<TafsirEntry, PackError> {
        check_ayah(ayah_id)?;
        let pack = self.inner.catalog.require(pack_id)?.clone();
        if pack.kind != PackKind::Tafsir {
            return Err(PackError::NotFound(format!(
                "{pack_id} is not a tafsir pack"
            )));
        }
        match &pack.source {
            Adapter::QuranEncSqlite(_) => {
                let this = self.clone();
                let id = pack.id.clone();
                blocking(move || {
                    let db = this.translation_db(&id)?;
                    let entry = db
                        .entry_for(ayah_id)?
                        .ok_or_else(|| no_entry(&id, ayah_id))?;
                    let meta = db.meta();
                    Ok(TafsirEntry {
                        pack_id: id,
                        from_ayah_id: entry.ayah_id,
                        to_ayah_id: entry.to_ayah_id,
                        html: entry.html,
                        lang: meta.lang.clone(),
                        dir: meta.dir,
                        fetched_at: None,
                        stale: false,
                    })
                })
                .await
            }
            Adapter::QurancomTafsir(_) => {
                let (surah, _) =
                    geometry::ayah_ref(ayah_id).ok_or_else(|| invalid_ayah(ayah_id))?;
                let state = self.ensure_chapter(&pack, surah).await?;
                let (content, id) = (self.inner.content.clone(), pack.id.clone());
                let (row, chapter_empty) = blocking(move || {
                    let row = content.tafsir_get(&id, ayah_id)?;
                    // A chapter stored without entries: the tafsir has no commentary on this surah at all.
                    let empty =
                        row.is_none() && chapter_tafsir_rows(&content, &id, surah)?.is_empty();
                    Ok((row, empty))
                })
                .await?;
                let row = row.ok_or_else(|| {
                    if chapter_empty {
                        PackError::NotFound(format!(
                            "{} has no commentary on surah {surah}",
                            pack.id
                        ))
                    } else {
                        no_entry(&pack.id, ayah_id)
                    }
                })?;
                let (lang, dir) = pack_language(&pack);
                Ok(TafsirEntry {
                    pack_id: pack.id.clone(),
                    from_ayah_id: row.from_ayah_id,
                    to_ayah_id: row.to_ayah_id,
                    html: row.html,
                    lang,
                    dir,
                    fetched_at: Some(ms_to_secs(state.fetched_at_ms)),
                    stale: state.stale,
                })
            }
            other => Err(PackError::Unsupported(format!(
                "{pack_id}: {} has no tafsir entries",
                other.name()
            ))),
        }
    }

    /// Word-by-word entries for the words `from..=to` (end markers have none), in word order, each with its Hafs text
    /// from core.db. The chapters of the range are fetched on demand ([`CHAPTER_CONCURRENCY`] at a time).
    pub async fn wbw_range(
        &self,
        pack_id: &str,
        from: u32,
        to: u32,
    ) -> Result<Vec<WbwEntry>, PackError> {
        if from == 0 || to > WORD_COUNT || from > to {
            return Err(PackError::Core(CoreError::InvalidArgument(format!(
                "words {from}..={to} are not a range in 1..={WORD_COUNT}"
            ))));
        }
        let pack = self.inner.catalog.require(pack_id)?.clone();
        if !matches!(pack.source, Adapter::QurancomWbw(_)) {
            return Err(PackError::NotFound(format!(
                "{pack_id} is not a word-by-word pack"
            )));
        }
        let (Some(first), Some(last)) =
            (geometry::surah_of_word(from), geometry::surah_of_word(to))
        else {
            return Err(PackError::Core(CoreError::InvalidArgument(format!(
                "words {from}..={to} are outside the Quran"
            ))));
        };
        let results: Vec<Result<ChapterState, PackError>> =
            futures_util::stream::iter(first..=last)
                .map(|surah| self.ensure_chapter(&pack, surah))
                .buffer_unordered(CHAPTER_CONCURRENCY)
                .collect()
                .await;
        for result in results {
            result?;
        }
        let (content, core, id) = (
            self.inner.content.clone(),
            self.inner.core.clone(),
            pack.id.clone(),
        );
        blocking(move || {
            let mut rows = content.wbw_range(&id, from, to)?;
            let texts = word_texts(&core, from, to)?;
            for row in &mut rows {
                if let Some(text) = texts.get(&row.word_id) {
                    row.text.clone_from(text);
                }
            }
            Ok(rows)
        })
        .await
    }

    /// Makes a Quran.com chapter (tafsir or WBW) available in content.db for a reader who is waiting:
    /// - stored and fresh: at once, no request;
    /// - missing: fetched ([`Self::refresh_chapter`]), waited for;
    /// - stored but older than its revalidation period (stale-while-revalidate): refetched, but the reader waits at
    ///   most [`REVALIDATE_GRACE`] for it. Past that the stored copy is served at once, marked stale (the UI's "saved
    ///   N days ago" footer), and the refetch carries on in the background: it stores the new copy and reports the
    ///   pack changed. On a slow or captive link a stored chapter, pinned or not, never waits for the network.
    async fn ensure_chapter(
        &self,
        pack: &CatalogPack,
        surah: u32,
    ) -> Result<ChapterState, PackError> {
        revalidate::check_surah(surah)?;
        let stamp = revalidate::chapter_stamp(&self.inner.content, &pack.id, surah).await?;
        let age = revalidate::max_age(pack);
        let now = self.inner.user.now_ms();
        if let Some(s) = &stamp
            && revalidate::is_fresh(s.fetched_at_ms, now, age)
        {
            return Ok(ChapterState {
                fetched_at_ms: s.fetched_at_ms,
                stale: false,
                change: None,
            });
        }
        // Its own task, so it completes (and stores what it fetched) whether or not this reader still waits.
        let (this, owned) = (self.clone(), pack.clone());
        let mut refresh = self
            .inner
            .rt
            .spawn(async move { this.refresh_chapter(&owned, surah).await });
        let joined = match &stamp {
            None => (&mut refresh).await,
            Some(s) => match tokio::time::timeout(REVALIDATE_GRACE, &mut refresh).await {
                Ok(joined) => joined,
                Err(_) => {
                    log::info!(
                        "{} chapter {surah}: serving the stored copy while it is refreshed",
                        pack.id
                    );
                    return Ok(ChapterState {
                        fetched_at_ms: s.fetched_at_ms,
                        stale: true,
                        change: None,
                    });
                }
            },
        };
        joined
            .map_err(|e| PackError::Io(io::Error::other(format!("chapter refresh failed: {e}"))))?
    }

    /// Fetches a Quran.com chapter (tafsir or WBW) into content.db unless it is fresh (the adapters' `ensure_chapter`),
    /// sharing a fetch in flight. A chapter fetched now is recorded as an item of the pack (pinned when the pack is
    /// installed), so the Downloads screen and "Clear cache" see it, and the pack is reported changed.
    async fn refresh_chapter(
        &self,
        pack: &CatalogPack,
        surah: u32,
    ) -> Result<ChapterState, PackError> {
        let pin = matches!(
            self.installed_row(&pack.id).await?,
            Some(row) if row.status == InstalledStatus::Installed
        );
        let ctx = self.ctx(pack, None, pin);
        let age = revalidate::max_age(pack);
        let source = pack.source.clone();
        let (user, content, hub) = (
            self.inner.user.clone(),
            self.inner.content.clone(),
            Arc::clone(&self.inner.hub),
        );
        self.inner
            .chapter_flights
            .run((pack.id.clone(), surah), move || async move {
                let state = match &source {
                    Adapter::QurancomTafsir(cfg) => {
                        qurancom_tafsir::ensure_chapter(&ctx, cfg, surah, age).await?
                    }
                    Adapter::QurancomWbw(cfg) => {
                        qurancom_wbw::ensure_chapter(&ctx, cfg, surah, age).await?
                    }
                    other => {
                        return Err(PackError::Unsupported(format!(
                            "{}: {} has no chapters",
                            ctx.pack_id,
                            other.name()
                        )));
                    }
                };
                if state.change.is_some() {
                    let pack_id = ctx.pack_id.clone();
                    let wbw = matches!(source, Adapter::QurancomWbw(_));
                    let recorded = blocking(move || {
                        record_chapter_blocking(&user, &content, &pack_id, wbw, surah, pin)
                    })
                    .await;
                    match recorded {
                        Ok(true) => hub.changed(vec![ctx.pack_id.clone()]),
                        Ok(false) => {}
                        Err(e) => log::warn!(
                            "{}: chapter {surah} fetched but not recorded: {e}",
                            ctx.pack_id
                        ),
                    }
                }
                Ok(state)
            })
            .await
    }

    // -----------------------------------------------------------------------------------------------------------
    // Audio
    // -----------------------------------------------------------------------------------------------------------

    /// The timings of a surah for playback (`qdc_audio::ensure_timings`): stored and fresh → no request; else refreshed
    /// (never downloading audio); the stored copy when the refresh fails; `Offline` when none is stored and the network
    /// is unavailable. Calls for the same surah share one request. A cached file that no longer matches upstream is
    /// dropped (`PacksChanged`); a changed pinned file wakes the revalidator, which swaps it.
    pub async fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u32,
    ) -> Result<StoredTimings, PackError> {
        revalidate::check_surah(surah)?;
        let (pack, cfg) = self.reciter_source(reciter_id)?;
        let ctx = self.ctx(&pack, None, false);
        let age = revalidate::max_age(&pack);
        let ensured = self
            .inner
            .timing_flights
            .run((reciter_id, surah), move || async move {
                qdc_audio::ensure_timings(&ctx, &cfg, surah, age).await
            })
            .await?;
        self.after_timings(&pack.id, ensured.change);
        Ok(ensured.timings)
    }

    /// Refetches a surah's timings now, whatever their age (the server's file differs from the one the timings
    /// describe). An unpinned file that changed upstream is dropped with its timings replaced; a pinned pair is kept
    /// until the revalidator swaps it. Never downloads audio.
    pub async fn refresh_surah_timings(
        &self,
        reciter_id: u32,
        surah: u32,
    ) -> Result<StoredTimings, PackError> {
        revalidate::check_surah(surah)?;
        let (pack, cfg) = self.reciter_source(reciter_id)?;
        let ctx = self.ctx(&pack, None, false);
        let refreshed = qdc_audio::refresh_timings(&ctx, &cfg, surah).await?;
        self.after_timings(&pack.id, Some(refreshed.change));
        Ok(refreshed.timings)
    }

    fn after_timings(&self, pack_id: &str, change: Option<qdc_audio::TimingsChange>) {
        match change {
            Some(qdc_audio::TimingsChange::FileReplaced { freed }) => {
                log::info!(
                    "{pack_id}: a cached file changed upstream and was dropped ({freed} bytes)"
                );
                self.inner.hub.changed(vec![pack_id.to_owned()]);
            }
            Some(qdc_audio::TimingsChange::PinnedFileChanged) => self.inner.revalidator.wake(),
            _ => {}
        }
    }

    fn reciter_source(&self, reciter_id: u32) -> Result<(CatalogPack, QdcAudioConfig), PackError> {
        self.inner
            .catalog
            .reciter(reciter_id)
            .map(|(pack, cfg)| (pack.clone(), cfg.clone()))
            .ok_or_else(|| {
                PackError::NotFound(format!("reciter {reciter_id} is not in the catalog"))
            })
    }

    /// `packs/audio`.
    #[must_use]
    pub fn audio_root(&self) -> PathBuf {
        self.inner.root.join("audio")
    }

    /// `StreamRegistry::begin` (writers.rs): a stream started writing `{sss}.stream.part`.
    pub fn audio_stream_begin(&self, reciter_id: u32, surah: u32) {
        self.inner.writers.stream_begin(reciter_id, surah);
    }

    /// `StreamRegistry::end`: `Some(bytes)` = the stream promoted `{sss}.mp3`, which is recorded as stream cache
    /// (`pinned = 0`, unless the surah is already pinned) and counted against the cache cap.
    pub fn audio_stream_end(&self, reciter_id: u32, surah: u32, promoted_bytes: Option<u64>) {
        self.inner
            .writers
            .stream_end(reciter_id, surah, promoted_bytes);
        let Some(bytes) = promoted_bytes else {
            return;
        };
        let Some((pack, _)) = self.inner.catalog.reciter(reciter_id) else {
            log::debug!(
                "audio stream {reciter_id}/{surah:03}: reciter not in the catalog, not recorded"
            );
            return;
        };
        let pack_id = pack.id.clone();
        let this = self.clone();
        drop(self.inner.rt.spawn(async move {
            let (user, id) = (this.inner.user.clone(), pack_id.clone());
            match blocking(move || record_stream_item(&user, &id, surah, bytes)).await {
                Ok(()) => {
                    this.inner.hub.changed(vec![pack_id]);
                    let cap = this.inner.stream_cache_cap.load(Ordering::Relaxed);
                    if let Err(e) = this.enforce_stream_cache_cap(cap).await {
                        log::warn!("stream cache cap: {e}");
                    }
                }
                Err(e) => log::warn!("{pack_id}: streamed surah {surah} not recorded: {e}"),
            }
        }));
    }

    /// A surah's audio was opened for playback: its `pack_item` row (a cached or downloaded file) becomes the most
    /// recently used, so the stream cache evicts what was played longest ago, not what was streamed longest ago. A
    /// surah without a row (streaming, not promoted yet) is a no-op, as is a reciter outside the catalog. Never blocks:
    /// the write runs on the blocking pool.
    pub fn audio_used(&self, reciter_id: u32, surah: u32) {
        let Some((pack, _)) = self.inner.catalog.reciter(reciter_id) else {
            return;
        };
        let (user, pack_id) = (self.inner.user.clone(), pack.id.clone());
        let item = ItemKey::Surah(surah).db_key();
        drop(self.inner.rt.spawn_blocking(move || {
            if let Err(e) = user.pack_item_touch(&pack_id, &item) {
                log::debug!("{pack_id}: surah {surah} not marked as played: {e}");
            }
        }));
    }

    // -----------------------------------------------------------------------------------------------------------
    // Caches and disk usage
    // -----------------------------------------------------------------------------------------------------------

    /// Evicts stream-cached audio (`pinned = 0` rows of recitation packs), least recently used first, until the cache
    /// holds at most `cap_bytes`. Files being streamed, claimed by a job or part of an active job are skipped, as is a
    /// file Windows still holds. Returns the bytes freed.
    pub async fn enforce_stream_cache_cap(&self, cap_bytes: u64) -> Result<u64, PackError> {
        self.evict(cap_bytes, false).await
    }

    /// Deletes every stream-cached audio file (unpinned rows, and files no row accounts for); returns the bytes freed.
    /// Pinned files are never touched.
    pub async fn clear_stream_cache(&self) -> Result<u64, PackError> {
        self.evict(0, true).await
    }

    async fn evict(&self, cap_bytes: u64, orphans: bool) -> Result<u64, PackError> {
        let _one = self.inner.eviction.lock().await;
        let env = self.sync_env();
        let busy = self.busy_recitations();
        let (freed, changed) =
            blocking(move || evict_blocking(&env, cap_bytes, orphans, &busy)).await?;
        if !changed.is_empty() {
            log::info!("stream cache: {freed} bytes freed ({})", changed.join(", "));
            self.inner.hub.changed(changed);
        }
        Ok(freed)
    }

    /// Items of active (or paused) recitation jobs: never evicted from under a job.
    fn busy_recitations(&self) -> HashSet<(String, u32)> {
        let mut busy = HashSet::new();
        for pack in self.inner.catalog.of_kind(PackKind::Recitation) {
            if let Some(items) = self.inner.jobs.job_items(&pack.id) {
                for key in items {
                    if let ItemKey::Surah(n) = key {
                        busy.insert((pack.id.clone(), n));
                    }
                }
            }
            if self.inner.jobs.is_active(&pack.id) {
                // An active job may be between renaming a file into place and recording it.
                busy.insert((pack.id.clone(), 0));
            }
        }
        busy
    }

    /// "Clear cache": unpinned audio files + `ContentDb::clear_unpinned` (unpinned timings/chapters + kv), then re-sync
    /// `installed_pack` (packs whose rows vanished become Partial). Pinned files and the timings they need survive.
    pub async fn clear_cache(&self) -> Result<u64, PackError> {
        let mut freed = self.clear_stream_cache().await?;
        let (content, user) = (self.inner.content.clone(), self.inner.user.clone());
        let report = blocking(move || {
            let report = content.clear_unpinned()?;
            for (pack_id, surah) in &report.chapters {
                let key = ItemKey::Chapter(*surah).db_key();
                if user
                    .pack_item(pack_id, &key)?
                    .is_some_and(|row| !row.pinned)
                {
                    user.pack_item_delete(pack_id, &key)?;
                }
            }
            Ok(report)
        })
        .await?;
        freed = freed.saturating_add(report.bytes);
        // The persisted update findings lived in `kv`.
        self.inner.hub.updates.lock().clear();
        let resync = self.resync(None).await?;
        let mut changed: BTreeSet<String> = resync.changed.into_iter().collect();
        changed.extend(report.chapters.iter().map(|(id, _)| id.clone()));
        for (reciter, _) in &report.timings {
            if let Some((pack, _)) = self.inner.catalog.reciter(*reciter) {
                changed.insert(pack.id.clone());
            }
        }
        log::info!(
            "cache cleared: {freed} bytes ({} timings, {} chapters)",
            report.timings.len(),
            report.chapters.len()
        );
        if !changed.is_empty() {
            self.inner.hub.changed(changed.into_iter().collect());
        }
        Ok(freed)
    }

    /// What the data directory holds, by category (directory sizes, the stream cache by its rows' pin). `total_kib` also
    /// counts in-progress downloads (`packs/.staging`). Blocking (walks `packs/`).
    pub fn disk_usage(&self) -> Result<DiskUsage, PackError> {
        let root = &self.inner.root;
        let dir_kib = |name: &str| kib(install::dir_size(&root.join(name)));
        let (pinned, stream) = self.audio_usage()?;
        let db_kib = |name: &str| {
            let base = self.inner.data_dir.join(name);
            let bytes = ["", "-wal", "-shm"]
                .iter()
                .map(|suffix| {
                    let mut p = base.clone().into_os_string();
                    p.push(suffix);
                    std::fs::metadata(PathBuf::from(p)).map_or(0, |m| m.len())
                })
                .fold(0u64, u64::saturating_add);
            kib(bytes)
        };
        let mut usage = DiskUsage {
            total_kib: 0,
            mushaf_kib: dir_kib("mushaf"),
            decor_kib: dir_kib("decor"),
            translation_kib: dir_kib("translation"),
            tafsir_kib: dir_kib("tafsir"),
            audio_pinned_kib: kib(pinned),
            audio_stream_kib: kib(stream),
            content_db_kib: db_kib("content.db"),
            user_db_kib: db_kib("user.db"),
            data_dir: dunce::simplified(&self.inner.data_dir)
                .to_string_lossy()
                .into_owned(),
        };
        usage.total_kib = [
            usage.mushaf_kib,
            usage.decor_kib,
            usage.translation_kib,
            usage.tafsir_kib,
            usage.audio_pinned_kib,
            usage.audio_stream_kib,
            usage.content_db_kib,
            usage.user_db_kib,
            dir_kib(install::STAGING_DIR),
        ]
        .into_iter()
        .fold(0u32, u32::saturating_add);
        Ok(usage)
    }

    /// `(pinned, stream)` bytes under `packs/audio`: a surah's files count as pinned when its row is pinned (job temps
    /// and a pending swap's `.mp3.next` included), anything else (stream temps, cached files) as stream cache.
    fn audio_usage(&self) -> Result<(u64, u64), PackError> {
        let mut pinned_surahs: HashSet<(u32, u32)> = HashSet::new();
        for pack in self.inner.catalog.of_kind(PackKind::Recitation) {
            let Some(cfg) = pack.reciter() else {
                continue;
            };
            for row in self.inner.user.pack_items(&pack.id)? {
                if let Some(ItemKey::Surah(s)) = ItemKey::parse_db_key(&row.item)
                    && row.pinned
                {
                    pinned_surahs.insert((cfg.reciter_id, s));
                }
            }
        }
        let (mut pinned, mut stream) = (0u64, 0u64);
        for dir in read_dir(&self.audio_root()) {
            let Some(reciter) = dir.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            for file in read_dir(&dir.path()) {
                let Ok(meta) = file.metadata() else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let name = file.file_name();
                let name = name.to_string_lossy();
                let surah = name.get(..3).and_then(|s| s.parse::<u32>().ok());
                let is_stream_temp = name.ends_with(".stream.part");
                if !is_stream_temp && surah.is_some_and(|s| pinned_surahs.contains(&(reciter, s))) {
                    pinned = pinned.saturating_add(meta.len());
                } else {
                    stream = stream.saturating_add(meta.len());
                }
            }
        }
        Ok((pinned, stream))
    }

    /// Checks every installed (or partly installed) pack for an upstream update now: QuranEnc versions, changed pinned
    /// recitation files (which the revalidator then applies in the background). Whole-pack findings are remembered
    /// across restarts.
    pub async fn check_updates(&self) -> Result<Vec<PackUpdate>, PackError> {
        let found = self.inner.revalidator.check_updates().await?;
        let user = self.inner.user.clone();
        let rows = blocking(move || Ok(user.packs_installed()?)).await?;
        for update in &found {
            if let Some(row) = rows.iter().find(|r| r.pack_id == update.pack_id)
                && is_whole_kind(row.kind)
            {
                let hub = Arc::clone(&self.inner.hub);
                let (update, checked) = (update.clone(), row.last_checked_at);
                // kv lives in content.db: off the async workers.
                if let Err(e) = blocking(move || {
                    hub.remember_update(&update, checked);
                    Ok(())
                })
                .await
                {
                    log::warn!("update checks: {e}");
                }
            }
        }
        if !found.is_empty() {
            self.inner
                .hub
                .changed(found.iter().map(|u| u.pack_id.clone()).collect());
        }
        Ok(found)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Settings and network
    // -----------------------------------------------------------------------------------------------------------

    /// Called from `settings_set`: `set_network_allowed` on change; when `stream_cache_cap_mib` changes, store the new
    /// cap and spawn `enforce_stream_cache_cap`.
    pub fn apply_settings(&self, prev: &Settings, next: &Settings) {
        if prev.network_allowed != next.network_allowed {
            self.set_network_allowed(next.network_allowed);
        }
        if prev.stream_cache_cap_mib != next.stream_cache_cap_mib {
            let cap = u64::from(next.stream_cache_cap_mib).saturating_mul(1024 * 1024);
            self.inner.stream_cache_cap.store(cap, Ordering::Relaxed);
            let this = self.clone();
            drop(self.inner.rt.spawn(async move {
                match this.enforce_stream_cache_cap(cap).await {
                    Ok(0) => {}
                    Ok(freed) => log::info!("stream cache cap {cap} B: {freed} bytes evicted"),
                    Err(e) => log::warn!("stream cache cap {cap} B: {e}"),
                }
            }));
        }
    }

    /// `settings.network_allowed`: off fails every network operation with `Offline` (running transfers stop at their
    /// next chunk, keeping resumable temps); on re-probes at once when the network was last seen offline.
    pub fn set_network_allowed(&self, allowed: bool) {
        self.inner.http.set_network_allowed(allowed);
    }

    /// Reachability as tracked from request outcomes, and never `true` while the network is not allowed.
    #[must_use]
    pub fn online(&self) -> bool {
        self.inner.http.online()
    }

    /// The stream cache cap in force.
    #[must_use]
    pub fn stream_cache_cap_bytes(&self) -> u64 {
        self.inner.stream_cache_cap.load(Ordering::Relaxed)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Startup, re-sync, shutdown
    // -----------------------------------------------------------------------------------------------------------

    /// Revalidator, cache-cap enforcement, resume of interrupted jobs, stale temp cleanup: [`PackManager::startup`] on
    /// the runtime. Idempotent; returns at once.
    pub fn start_background(&self) {
        let this = self.clone();
        drop(self.inner.rt.spawn(async move {
            if let Some(report) = this.startup().await
                && report != StartupReport::default()
            {
                log::info!("packs startup: {report:?}");
            }
        }));
    }

    /// The startup tasks, in order: the offline re-probe; the `packs/` sweep (stale stream temps, orphan downloads and
    /// staging, unreferenced versions; interrupted removals finished); the registry re-sync; the resume of interrupted
    /// jobs; the revalidator; the repair of pinned recitations whose timings were lost; the stream-cache cap. Runs once:
    /// `None` when it already ran (or is running). Failures are logged and the remaining steps still run.
    pub async fn startup(&self) -> Option<StartupReport> {
        if self.inner.started.swap(true, Ordering::SeqCst) {
            return None;
        }
        let inner = &self.inner;
        let mut report = StartupReport::default();
        inner.http.start_probe(&inner.rt);
        self.load_known_updates().await;

        match install::sweep(&inner.root, &inner.user, &inner.writers).await {
            Ok(swept) => {
                for pack_id in &swept.pending_removals {
                    let Some(pack) = inner.catalog.get(pack_id) else {
                        continue;
                    };
                    match self.remove_pack(pack).await {
                        Ok(_) => report.removals_finished.push(pack_id.clone()),
                        Err(e) => log::warn!("{pack_id}: interrupted removal not finished: {e}"),
                    }
                }
                report.swept = swept;
            }
            Err(e) => log::warn!("packs sweep failed: {e}"),
        }

        match self.resync(None).await {
            Ok(resync) => report.resync = resync,
            Err(e) => log::warn!("registry re-sync failed: {e}"),
        }

        match inner.jobs.restore().await {
            Ok(ids) => report.resumed_jobs = ids,
            Err(e) => log::warn!("cannot resume interrupted jobs: {e}"),
        }

        inner.revalidator.start(&inner.rt);

        if !report.resync.missing_timings.is_empty() {
            report.timings_repaired = self
                .repair_timings(report.resync.missing_timings.clone())
                .await;
        }

        let cap = inner.stream_cache_cap.load(Ordering::Relaxed);
        match self.enforce_stream_cache_cap(cap).await {
            Ok(freed) => report.evicted_bytes = freed,
            Err(e) => log::warn!("stream cache cap: {e}"),
        }

        let mut changed: BTreeSet<String> = report.resync.changed.iter().cloned().collect();
        changed.extend(report.removals_finished.iter().cloned());
        if !changed.is_empty() {
            inner.hub.changed(changed.into_iter().collect());
        }
        Some(report)
    }

    /// Re-syncs the registry with what backs it (module docs): `pack_ids` (catalog packs only), or every catalog pack.
    pub async fn resync(&self, pack_ids: Option<&[String]>) -> Result<ResyncReport, PackError> {
        let packs: Vec<CatalogPack> = self
            .inner
            .catalog
            .packs
            .iter()
            .filter(|p| pack_ids.is_none_or(|ids| ids.contains(&p.id)))
            .cloned()
            .collect();
        let env = self.sync_env();
        blocking(move || resync_blocking(&env, &packs)).await
    }

    /// The registry was replaced as a whole (user.db restored from a backup): re-syncs every pack with what backs it,
    /// so no restored row claims data that is not on this machine, and reports every catalog pack as changed, since the
    /// restored rows may differ anywhere. Files no restored row references are left for the next startup's sweep.
    pub async fn registry_replaced(&self) -> Result<ResyncReport, PackError> {
        let report = self.resync(None).await;
        let all: Vec<String> = self
            .inner
            .catalog
            .packs
            .iter()
            .map(|p| p.id.clone())
            .collect();
        self.inner.hub.changed(all);
        report
    }

    /// Fetches the timings of pinned surahs that lost them (a recovered content.db), on the background lane; the
    /// adapter stores them pinned when the file on disk is the one they describe. Returns how many were stored.
    async fn repair_timings(&self, missing: Vec<(String, u32)>) -> u32 {
        let http = &self.inner.http;
        if !(http.network_allowed() && http.online()) {
            log::info!(
                "{} pinned recitations wait for their timings until the network is available",
                missing.len()
            );
            return 0;
        }
        let lane = JobHandle::detached(0, "timings-repair");
        let mut repaired = 0u32;
        let mut packs = BTreeSet::new();
        for (pack_id, surah) in missing {
            let Some(pack) = self.inner.catalog.get(&pack_id) else {
                continue;
            };
            let Some(cfg) = pack.reciter() else {
                continue;
            };
            let ctx = self.ctx(pack, Some(lane.clone()), false);
            match qdc_audio::refresh_timings(&ctx, cfg, surah).await {
                Ok(_) => {
                    repaired = repaired.saturating_add(1);
                    packs.insert(pack_id);
                }
                Err(PackError::Offline | PackError::Cancelled) => break,
                Err(e) => log::warn!("{pack_id}: timings of surah {surah} not repaired: {e}"),
            }
        }
        if !packs.is_empty() {
            let ids: Vec<String> = packs.into_iter().collect();
            match self.resync(Some(ids.as_slice())).await {
                Ok(r) if !r.changed.is_empty() => self.inner.hub.changed(r.changed),
                Ok(_) => {}
                Err(e) => log::warn!("timings repair: re-sync failed: {e}"),
            }
        }
        repaired
    }

    async fn load_known_updates(&self) {
        let hub = Arc::clone(&self.inner.hub);
        if let Err(e) = blocking(move || {
            hub.load_updates();
            Ok(())
        })
        .await
        {
            log::warn!("known updates: {e}");
        }
    }

    /// Stops the revalidator and its requests (the app is quitting). Jobs stop with the process; their journals resume
    /// them at the next start.
    pub fn shutdown(&self) {
        self.inner.revalidator.shutdown();
    }

    // -----------------------------------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------------------------------

    async fn installed_row(&self, pack_id: &str) -> Result<Option<InstalledPackRow>, PackError> {
        let (user, id) = (self.inner.user.clone(), pack_id.to_owned());
        blocking(move || Ok(user.pack_installed(&id)?)).await
    }

    /// An adapter context on the manager's handles: interactive without `job`.
    fn ctx(&self, pack: &CatalogPack, job: Option<JobHandle>, pin: bool) -> AdapterCtx {
        let inner = &self.inner;
        AdapterCtx {
            pack_id: pack.id.clone(),
            kind: pack.kind,
            packs_root: inner.root.clone(),
            http: inner.http.clone(),
            core: inner.core.clone(),
            user: inner.user.clone(),
            content: inner.content.clone(),
            writers: inner.writers.clone(),
            job,
            pin,
        }
    }

    fn sync_env(&self) -> SyncEnv {
        let inner = &self.inner;
        SyncEnv {
            root: inner.root.clone(),
            catalog: Arc::clone(&inner.catalog),
            user: inner.user.clone(),
            content: inner.content.clone(),
            writers: inner.writers.clone(),
            hub: Arc::clone(&inner.hub),
        }
    }
}

impl std::fmt::Debug for PackManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PackManager")
            .field("packs", &self.inner.catalog.packs.len())
            .field("online", &self.online())
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The event hub: job observer, coalesced change notifications, pack DB cache, known updates
// ---------------------------------------------------------------------------------------------------------------

/// What the manager shares with its job queue, revalidator, font lane and HTTP listener. They hold it weakly (except
/// the queue, which the hub does not own), so there is no reference cycle.
struct Hub {
    me: Weak<Hub>,
    events: Arc<dyn PackEvents>,
    rt: tokio::runtime::Handle,
    user: UserDb,
    content: ContentDb,
    catalog: Arc<Catalog>,
    delay: Duration,
    pending: Mutex<BTreeSet<String>>,
    flush_scheduled: AtomicBool,
    pack_dbs: Mutex<HashMap<String, (PathBuf, PackDb)>>,
    revalidator: OnceLock<Revalidator>,
    updates: Mutex<HashMap<String, KnownUpdate>>,
}

/// A whole pack's update finding, kept across restarts (module docs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownUpdate {
    update: PackUpdate,
    /// `installed_pack.last_checked_at` of the check that found it.
    checked_at: Option<i64>,
}

impl Hub {
    fn new(
        events: Arc<dyn PackEvents>,
        rt: tokio::runtime::Handle,
        user: UserDb,
        content: ContentDb,
        catalog: Arc<Catalog>,
        delay: Duration,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            events,
            rt,
            user,
            content,
            catalog,
            delay,
            pending: Mutex::new(BTreeSet::new()),
            flush_scheduled: AtomicBool::new(false),
            pack_dbs: Mutex::new(HashMap::new()),
            revalidator: OnceLock::new(),
            updates: Mutex::new(HashMap::new()),
        })
    }

    /// A change listener for the revalidator and the font lane (weak: no cycle).
    fn notifier(&self) -> impl Fn(Vec<String>) + Send + Sync + 'static {
        let me = self.me.clone();
        move |ids| {
            if let Some(hub) = me.upgrade() {
                hub.changed(ids);
            }
        }
    }

    /// `packs_changed`, coalesced over the hub's delay.
    fn changed(&self, pack_ids: Vec<String>) {
        if pack_ids.is_empty() {
            return;
        }
        if self.delay.is_zero() {
            self.events.packs_changed(dedup(pack_ids));
            return;
        }
        self.pending.lock().extend(pack_ids);
        if self.flush_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let me = self.me.clone();
        let delay = self.delay;
        drop(self.rt.spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(hub) = me.upgrade() {
                hub.flush();
            }
        }));
    }

    fn flush(&self) {
        // Cleared first: a change that arrives from here on schedules its own flush.
        self.flush_scheduled.store(false, Ordering::Release);
        let ids: Vec<String> = std::mem::take(&mut *self.pending.lock())
            .into_iter()
            .collect();
        if !ids.is_empty() {
            self.events.packs_changed(ids);
        }
    }

    fn network(&self, online: bool) {
        log::info!("network: {}", if online { "online" } else { "offline" });
        self.events.network(online);
        if online && let Some(revalidator) = self.revalidator.get() {
            revalidator.wake();
        }
    }

    fn cached_pack_db(&self, pack_id: &str, path: &Path) -> Option<PackDb> {
        self.pack_dbs
            .lock()
            .get(pack_id)
            .filter(|(p, _)| p == path)
            .map(|(_, db)| db.clone())
    }

    fn cache_pack_db(&self, pack_id: &str, path: PathBuf, db: PackDb) {
        self.pack_dbs.lock().insert(pack_id.to_owned(), (path, db));
    }

    /// Drops the cached handle (before a flip deletes the old version, or a removal deletes the pack).
    fn release_pack_db(&self, pack_id: &str) {
        if self.pack_dbs.lock().remove(pack_id).is_some() {
            log::debug!("{pack_id}: pack database handle released");
        }
    }

    // --- known updates (blocking: kv lives in content.db) ---

    fn load_updates(&self) {
        let stored = match self.content.kv_get(UPDATES_KV_KEY) {
            Ok(Some((json, _))) => json,
            Ok(None) => return,
            Err(e) => {
                log::warn!("known updates: cannot read them: {e}");
                return;
            }
        };
        match serde_json::from_str::<Vec<KnownUpdate>>(&stored) {
            Ok(list) => {
                let mut map = self.updates.lock();
                for k in list {
                    map.insert(k.update.pack_id.clone(), k);
                }
            }
            Err(e) => log::warn!("known updates: unreadable ({e}); ignored"),
        }
    }

    fn persisted_update(&self, row: &InstalledPackRow) -> Option<PackUpdate> {
        self.updates
            .lock()
            .get(&row.pack_id)
            .filter(|k| {
                k.update.installed == row.version
                    && match (row.last_checked_at, k.checked_at) {
                        (Some(row_at), Some(found_at)) => row_at <= found_at,
                        (Some(_), None) => false,
                        (None, _) => true,
                    }
            })
            .map(|k| k.update.clone())
    }

    fn remember_update(&self, update: &PackUpdate, checked_at: Option<i64>) {
        let known = KnownUpdate {
            update: update.clone(),
            checked_at,
        };
        let snapshot = {
            let mut map = self.updates.lock();
            if map.get(&update.pack_id) == Some(&known) {
                return;
            }
            map.insert(update.pack_id.clone(), known);
            map.values().cloned().collect::<Vec<_>>()
        };
        self.persist_updates(&snapshot);
    }

    fn forget_update(&self, pack_id: &str) {
        let snapshot = {
            let mut map = self.updates.lock();
            if map.remove(pack_id).is_none() {
                return;
            }
            map.values().cloned().collect::<Vec<_>>()
        };
        let me = self.me.clone();
        // Called from async code: the write goes to the blocking pool.
        drop(self.rt.spawn_blocking(move || {
            if let Some(hub) = me.upgrade() {
                hub.persist_updates(&snapshot);
            }
        }));
    }

    fn persist_updates(&self, list: &[KnownUpdate]) {
        let result = serde_json::to_string(list)
            .map_err(CoreError::from)
            .and_then(|json| {
                self.content
                    .kv_put(UPDATES_KV_KEY, &json, self.user.now_ms())
            });
        if let Err(e) = result {
            log::warn!("known updates: cannot store them: {e}");
        }
    }
}

impl JobObserver for Hub {
    fn download(&self, e: DownloadEvent) {
        if let DownloadEvent::Completed { pack_id, .. }
        | DownloadEvent::Cancelled { pack_id, .. }
        | DownloadEvent::Failed { pack_id, .. }
        | DownloadEvent::Paused { pack_id, .. } = &e
            && self
                .catalog
                .get(pack_id)
                .is_some_and(|p| p.kind == PackKind::Recitation)
        {
            // An update job's pseudo row (module docs) leaves with the job.
            let (user, id) = (self.user.clone(), pack_id.clone());
            drop(self.rt.spawn_blocking(move || {
                if let Err(e) = user.pack_item_delete(&id, &update_item_key()) {
                    log::warn!("{id}: cannot remove the update job's row: {e}");
                }
            }));
        }
        self.events.download(e);
    }

    fn packs_changed(&self, pack_ids: Vec<String>) {
        self.changed(pack_ids);
    }

    fn release_pack(&self, pack_id: &str) {
        self.release_pack_db(pack_id);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Job specs: catalog adapters, and the recitation update
// ---------------------------------------------------------------------------------------------------------------

/// Rebuilds job specs on resume, cancel and restore: catalog packs run by their adapters, and the non-pinning
/// recitation job is the update (module docs).
fn spec_source(catalog: Arc<Catalog>, revalidator: Revalidator) -> SpecSource {
    Arc::new(move |pack_id: &str, scope: InstallScope, pin: bool| {
        let pack = catalog.get(pack_id)?;
        if pack.kind == PackKind::Recitation && !pin {
            Some(recitation_update_spec(pack, revalidator.clone()))
        } else {
            Some(JobSpec::from_catalog(pack, scope, pin))
        }
    })
}

fn recitation_update_spec(pack: &CatalogPack, revalidator: Revalidator) -> JobSpec {
    JobSpec {
        pack_id: pack.id.clone(),
        kind: pack.kind,
        version: pack.version.clone(),
        item_count: pack.item_count,
        size_bytes: 0,
        scope: InstallScope::All,
        pin: false,
        work: Arc::new(RecitationUpdate {
            pack_id: pack.id.clone(),
            revalidator,
        }),
    }
}

fn update_item_key() -> String {
    ItemKey::File(UPDATE_ITEM.to_owned()).db_key()
}

/// The "Update" of a recitation pack: one pseudo item whose work is `Revalidator::revalidate_pack` (the swap of every
/// changed pinned file, serialised with the scheduled passes). A pause or cancel stops it between chunks of the swap
/// download; the `.mp3.next` temps stay, so a later update or pass resumes them.
struct RecitationUpdate {
    pack_id: String,
    revalidator: Revalidator,
}

impl PackWork for RecitationUpdate {
    fn items(&self, _scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        Ok(vec![ItemKey::File(UPDATE_ITEM.to_owned())])
    }

    fn whole(&self) -> bool {
        false
    }

    fn fetch_item<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        _item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>> {
        Box::pin(async move {
            let run = self.revalidator.revalidate_pack(&self.pack_id);
            let report = match &ctx.job {
                Some(job) => {
                    tokio::select! {
                        biased;
                        () = job.stopped() => return Err(PackError::Cancelled),
                        report = run => report?,
                    }
                }
                None => run.await?,
            };
            if report.skipped > 0 {
                return Err(PackError::Offline);
            }
            if report.failed > 0 {
                // The revalidator logged each failure; the old pairs stay in use and the next pass retries them.
                return Err(PackError::Http {
                    status: 0,
                    url: format!(
                        "{}: {} of {} changed recitations could not be updated",
                        self.pack_id, report.failed, report.due
                    ),
                });
            }
            log::info!(
                "{}: update applied ({} files swapped, {} dropped, {} timings refreshed)",
                self.pack_id,
                report.files_swapped,
                report.files_dropped,
                report.replaced.saturating_add(report.unchanged)
            );
            Ok(ItemOutcome::Present { bytes: 0 })
        })
    }

    fn install_whole<'a>(
        &'a self,
        _ctx: &'a AdapterCtx,
        _staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>> {
        Box::pin(async move {
            Err(PackError::Unsupported(format!(
                "{}: an update installs per item",
                self.pack_id
            )))
        })
    }

    fn temp_paths(&self, _packs_root: &Path, _item: &ItemKey) -> Vec<PathBuf> {
        Vec::new()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Blocking registry work
// ---------------------------------------------------------------------------------------------------------------

/// The handles blocking registry work needs (cheap clones, moved into `spawn_blocking`).
#[derive(Clone)]
struct SyncEnv {
    root: PathBuf,
    catalog: Arc<Catalog>,
    user: UserDb,
    content: ContentDb,
    writers: Writers,
    hub: Arc<Hub>,
}

fn resync_blocking(env: &SyncEnv, packs: &[CatalogPack]) -> Result<ResyncReport, PackError> {
    let installed: HashMap<String, InstalledPackRow> = env
        .user
        .packs_installed()?
        .into_iter()
        .map(|r| (r.pack_id.clone(), r))
        .collect();
    let mut report = ResyncReport::default();
    for pack in packs {
        let changed = match &pack.source {
            Adapter::QuranEncSqlite(_) => {
                resync_whole(env, pack, installed.get(&pack.id), &mut report)?
            }
            _ => resync_items(env, pack, installed.get(&pack.id), &mut report)?,
        };
        if changed {
            report.changed.push(pack.id.clone());
        }
    }
    if report.rows_dropped > 0 || report.rows_added > 0 || !report.missing_timings.is_empty() {
        log::info!(
            "registry re-sync: {} rows dropped, {} added, {} pinned recitations without timings; changed: {}",
            report.rows_dropped,
            report.rows_added,
            report.missing_timings.len(),
            report.changed.join(", ")
        );
    }
    Ok(report)
}

/// An installed whole pack whose `pack.db` has gone is no longer installed.
fn resync_whole(
    env: &SyncEnv,
    pack: &CatalogPack,
    row: Option<&InstalledPackRow>,
    report: &mut ResyncReport,
) -> Result<bool, PackError> {
    let Some(row) = row.filter(|r| r.status == InstalledStatus::Installed) else {
        return Ok(false);
    };
    let present = row
        .path
        .as_deref()
        .and_then(|rel| install::resolve(&env.root, rel).ok())
        .is_some_and(|p| p.is_file());
    if present {
        return Ok(false);
    }
    log::warn!(
        "{}: its pack database has gone; it is no longer installed",
        pack.id
    );
    env.hub.release_pack_db(&pack.id);
    report.rows_dropped = report
        .rows_dropped
        .saturating_add(env.user.pack_items_clear(&pack.id)?);
    env.user.pack_delete(&pack.id)?;
    Ok(true)
}

/// A per-item pack: rows against their data, then the `installed_pack` row (module docs).
fn resync_items(
    env: &SyncEnv,
    pack: &CatalogPack,
    installed: Option<&InstalledPackRow>,
    report: &mut ResyncReport,
) -> Result<bool, PackError> {
    if installed.is_some_and(|r| r.status == InstalledStatus::Removing) {
        return Ok(false);
    }
    let user = &env.user;
    let rows = user.pack_items(&pack.id)?;
    let mut changed = false;
    let mut kept: Vec<PackItemRow> = Vec::with_capacity(rows.len());

    // Chapters stored in content.db, by surah (chapter packs only).
    let mut stamps: BTreeMap<u32, ChapterStamp> = match pack.source {
        Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_) => env
            .content
            .chapters(&pack.id)?
            .into_iter()
            .map(|s| (s.surah, s))
            .collect(),
        _ => BTreeMap::new(),
    };
    for row in rows {
        let key = ItemKey::parse_db_key(&row.item).filter(|k| is_item_of(&pack.source, k));
        let backed = match &key {
            None => false,
            Some(ItemKey::Chapter(n)) => stamps.remove(n).is_some(),
            Some(key) => install::item_files(&pack.source, &env.root, key)
                .ok()
                .and_then(|f| f.file)
                .is_some_and(|f| f.is_file()),
        };
        if backed {
            kept.push(row);
        } else {
            user.pack_item_delete(&pack.id, &row.item)?;
            report.rows_dropped = report.rows_dropped.saturating_add(1);
            changed = true;
        }
    }
    // Stored chapters without a row (fetched on demand before rows were recorded, or by an older build).
    for (surah, stamp) in stamps {
        let wbw = matches!(pack.source, Adapter::QurancomWbw(_));
        let row = PackItemRow {
            pack_id: pack.id.clone(),
            item: ItemKey::Chapter(surah).db_key(),
            bytes: chapter_size(&env.content, &pack.id, wbw, surah)?,
            sha256: stamp.sha256,
            pinned: stamp.pinned,
            fetched_at: stamp.fetched_at_ms,
            last_used_at: stamp.fetched_at_ms,
        };
        user.pack_item_upsert(&row)?;
        kept.push(row);
        report.rows_added = report.rows_added.saturating_add(1);
        changed = true;
    }

    // Pinned recitations need their timings to play offline.
    let mut absent = 0u32;
    if let Adapter::QdcAudio(cfg) = &pack.source {
        let timed: HashSet<u32> = env
            .content
            .timing_stamps(Some(cfg.reciter_id))?
            .into_iter()
            .map(|s| s.surah)
            .collect();
        for row in kept.iter().filter(|r| r.pinned) {
            if let Some(ItemKey::Surah(s)) = ItemKey::parse_db_key(&row.item)
                && !timed.contains(&s)
            {
                absent = absent.saturating_add(1);
                report.missing_timings.push((pack.id.clone(), s));
            }
        }
    }

    let pinned: Vec<&PackItemRow> = kept.iter().filter(|r| r.pinned).collect();
    let present = u32::try_from(pinned.len())
        .unwrap_or(u32::MAX)
        .saturating_sub(absent);
    let bytes = pinned
        .iter()
        .map(|r| r.bytes)
        .fold(0u64, u64::saturating_add);
    changed |= write_item_row(user, pack, installed, present, !pinned.is_empty(), bytes)?;
    Ok(changed)
}

/// The `installed_pack` row of a per-item pack, with the job runner's policy: `installed` when every catalog item is
/// present and pinned, else `partial`; no row without a pinned item (`pinned_any`; a pinned item whose data is
/// incomplete keeps a `partial` row); a paused or failed job's status is kept. Returns whether the row changed.
fn write_item_row(
    user: &UserDb,
    pack: &CatalogPack,
    prev: Option<&InstalledPackRow>,
    present: u32,
    pinned_any: bool,
    bytes: u64,
) -> Result<bool, PackError> {
    let status = match prev.map(|p| p.status) {
        Some(InstalledStatus::Removing) => return Ok(false),
        Some(s @ (InstalledStatus::Paused | InstalledStatus::Failed)) => s,
        _ if !pinned_any => {
            if prev.is_some() {
                user.pack_delete(&pack.id)?;
                return Ok(true);
            }
            return Ok(false);
        }
        _ if pack.item_count > 0 && present >= pack.item_count => InstalledStatus::Installed,
        _ => InstalledStatus::Partial,
    };
    if let Some(p) = prev
        && p.status == status
        && p.items_present == present
        && p.items_total == pack.item_count
        && p.bytes == bytes
    {
        return Ok(false);
    }
    let now = user.now_ms();
    user.pack_upsert(&InstalledPackRow {
        pack_id: pack.id.clone(),
        kind: pack.kind,
        version: prev.map_or_else(|| pack.version.clone(), |p| p.version.clone()),
        path: None,
        status,
        bytes,
        items_total: pack.item_count,
        items_present: present,
        sha256: None,
        source_version: prev.and_then(|p| p.source_version.clone()),
        installed_at: prev.map_or(now, |p| p.installed_at),
        updated_at: now,
        last_checked_at: prev.and_then(|p| p.last_checked_at),
    })?;
    Ok(true)
}

/// Removes a per-item pack: files, content.db rows, item rows, then the pack row. Files that cannot be deleted (held
/// by another process on Windows) leave the row `removing`, so the next start finishes the job. Returns the bytes freed.
fn remove_per_item_blocking(env: &SyncEnv, pack: &CatalogPack) -> Result<u64, PackError> {
    let live = env.writers.live_streams();
    let (freed, leftovers) = delete_pack_files(&env.root, pack, &live);
    if matches!(
        pack.source,
        Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_) | Adapter::QdcAudio(_)
    ) {
        env.content.delete_pack(&pack.id)?;
    }
    env.user.pack_items_clear(&pack.id)?;
    if leftovers == 0 {
        env.user.pack_delete(&pack.id)?;
    } else {
        log::warn!(
            "{}: {leftovers} files are in use; the removal finishes at the next start",
            pack.id
        );
        let prev = env.user.pack_installed(&pack.id)?;
        let now = env.user.now_ms();
        env.user.pack_upsert(&InstalledPackRow {
            pack_id: pack.id.clone(),
            kind: pack.kind,
            version: prev
                .as_ref()
                .map_or_else(|| pack.version.clone(), |p| p.version.clone()),
            path: None,
            status: InstalledStatus::Removing,
            bytes: 0,
            items_total: pack.item_count,
            items_present: 0,
            sha256: None,
            source_version: None,
            installed_at: prev.as_ref().map_or(now, |p| p.installed_at),
            updated_at: now,
            last_checked_at: None,
        })?;
    }
    Ok(freed)
}

/// Deletes every file of a per-item pack: a Mushaf variant's directory, the decor pack's files, a reciter's directory
/// (except the temps of live streams). Returns `(bytes freed, files that could not be deleted)`.
fn delete_pack_files(root: &Path, pack: &CatalogPack, live: &[(u32, u32)]) -> (u64, u32) {
    let mut freed = 0u64;
    let mut leftovers = 0u32;
    let mut delete = |path: &Path| match install::remove_file_blocking(path) {
        Ok(n) => freed = freed.saturating_add(n),
        Err(e) => {
            log::warn!("{}: cannot delete {}: {e}", pack.id, path.display());
            leftovers = leftovers.saturating_add(1);
        }
    };
    match &pack.source {
        Adapter::QcfFontPages(c) => {
            let dir = install::font_dir(root, c.variant);
            for f in read_dir(&dir) {
                if f.path().is_file() {
                    delete(&f.path());
                }
            }
            let _ = std::fs::remove_dir(&dir);
        }
        Adapter::StaticFiles(c) => {
            for file in &c.files {
                if let Ok(path) = install::decor_path(root, &file.path) {
                    delete(&path);
                    delete(&install::part_path(&path));
                }
            }
        }
        Adapter::QdcAudio(c) => {
            let dir = install::audio_dir(root, c.reciter_id);
            for f in read_dir(&dir) {
                let path = f.path();
                if !path.is_file() {
                    continue;
                }
                let name = f.file_name().to_string_lossy().into_owned();
                if let Some(stem) = name.strip_suffix(".stream.part")
                    && stem
                        .parse::<u32>()
                        .is_ok_and(|s| live.contains(&(c.reciter_id, s)))
                {
                    continue;
                }
                delete(&path);
            }
            let _ = std::fs::remove_dir(&dir);
        }
        Adapter::QuranEncSqlite(_) | Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_) => {}
    }
    (freed, leftovers)
}

/// [`PackManager::remove_items`] on the blocking pool; returns the bytes freed.
fn remove_items_blocking(
    env: &SyncEnv,
    pack: &CatalogPack,
    mut keys: BTreeSet<ItemKey>,
) -> Result<u64, PackError> {
    let user = &env.user;
    let rows: HashMap<String, PackItemRow> = user
        .pack_items(&pack.id)?
        .into_iter()
        .map(|r| (r.item.clone(), r))
        .collect();
    if let Adapter::QdcAudio(_) = &pack.source {
        let keeps_another = rows.values().any(|r| {
            r.pinned
                && matches!(ItemKey::parse_db_key(&r.item), Some(ItemKey::Surah(s))
                    if s != 1 && !keys.contains(&ItemKey::Surah(s)))
        });
        if keeps_another && keys.remove(&ItemKey::Surah(1)) {
            log::info!(
                "{}: surah 1 stays (it plays the basmala of the other downloaded surahs)",
                pack.id
            );
        }
    }
    let mut freed = 0u64;
    let mut chapters = BTreeSet::new();
    let mut removed = 0usize;
    let mut held: Option<PackError> = None;
    let live = env.writers.live_streams();
    for key in &keys {
        let db_key = key.db_key();
        if let (Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_), ItemKey::Chapter(n)) =
            (&pack.source, key)
        {
            chapters.insert(*n);
            freed = freed.saturating_add(rows.get(&db_key).map_or(0, |r| r.bytes));
            user.pack_item_delete(&pack.id, &db_key)?;
            removed = removed.saturating_add(1);
            continue;
        }
        let files = install::item_files(&pack.source, &env.root, key)?;
        // Temps first, the file last: an item whose file cannot be deleted keeps its row (it is still there).
        let mut paths: Vec<PathBuf> = files.temps;
        if let (Adapter::QdcAudio(c), ItemKey::Surah(s)) = (&pack.source, key) {
            let next = qdc_audio::next_path(&env.root, c.reciter_id, *s);
            paths.push(install::dl_part_path(&next));
            paths.push(install::dl_sidecar_path(&next));
            paths.push(next);
            if !live.contains(&(c.reciter_id, *s)) {
                paths.push(install::stream_part_path(&env.root, c.reciter_id, *s));
            }
        }
        paths.extend(files.file);
        let mut deleted = true;
        for path in &paths {
            match install::remove_file_blocking(path) {
                Ok(n) => freed = freed.saturating_add(n),
                Err(e) => {
                    log::warn!(
                        "{}: {key} is kept, {} is in use: {e}",
                        pack.id,
                        path.display()
                    );
                    held.get_or_insert(e);
                    deleted = false;
                    break;
                }
            }
        }
        if !deleted {
            continue;
        }
        if let (Adapter::QdcAudio(c), ItemKey::Surah(s)) = (&pack.source, key) {
            // The timings stay as cache (a later stream reuses them); only their pin goes.
            env.content.timings_set_pinned(c.reciter_id, *s, false)?;
        }
        user.pack_item_delete(&pack.id, &db_key)?;
        removed = removed.saturating_add(1);
    }
    if !chapters.is_empty() {
        remove_chapters_blocking(&env.content, pack, &chapters)?;
    }
    match held {
        Some(e) if removed == 0 => Err(e),
        _ => Ok(freed),
    }
}

/// Deletes chapters of a Quran.com pack from content.db, each in one transaction (rows and stamp together); the
/// pack's other chapters are untouched.
fn remove_chapters_blocking(
    content: &ContentDb,
    pack: &CatalogPack,
    remove: &BTreeSet<u32>,
) -> Result<(), PackError> {
    for &surah in remove {
        content.delete_chapter(&pack.id, surah)?;
    }
    Ok(())
}

fn chapter_wbw_rows(
    content: &ContentDb,
    pack_id: &str,
    surah: u32,
) -> Result<Vec<WbwEntry>, PackError> {
    let Some(words) = geometry::surah_word_ids(surah) else {
        return Ok(Vec::new());
    };
    Ok(content.wbw_range(pack_id, *words.start(), *words.end())?)
}

fn chapter_tafsir_rows(
    content: &ContentDb,
    pack_id: &str,
    surah: u32,
) -> Result<Vec<TafsirRow>, PackError> {
    let Some(ayahs) = geometry::surah_ayah_ids(surah) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for id in ayahs {
        if let Some(row) = content.tafsir_get(pack_id, id)?
            && row.from_ayah_id == id
        {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// The stored size of a chapter, with the adapters' measure.
fn chapter_size(
    content: &ContentDb,
    pack_id: &str,
    wbw: bool,
    surah: u32,
) -> Result<u64, PackError> {
    Ok(if wbw {
        qurancom_wbw::stored_size(&chapter_wbw_rows(content, pack_id, surah)?)
    } else {
        qurancom_tafsir::stored_size(&chapter_tafsir_rows(content, pack_id, surah)?)
    })
}

/// Records a chapter fetched on demand as an item of its pack; returns whether the row is new.
fn record_chapter_blocking(
    user: &UserDb,
    content: &ContentDb,
    pack_id: &str,
    wbw: bool,
    surah: u32,
    pin: bool,
) -> Result<bool, PackError> {
    let Some(stamp) = content
        .chapters(pack_id)?
        .into_iter()
        .find(|s| s.surah == surah)
    else {
        return Ok(false);
    };
    let key = ItemKey::Chapter(surah).db_key();
    let prev = user.pack_item(pack_id, &key)?;
    let now = user.now_ms();
    user.pack_item_upsert(&PackItemRow {
        pack_id: pack_id.to_owned(),
        bytes: chapter_size(content, pack_id, wbw, surah)?,
        sha256: stamp.sha256,
        pinned: pin || stamp.pinned || prev.as_ref().is_some_and(|p| p.pinned),
        fetched_at: stamp.fetched_at_ms,
        last_used_at: now,
        item: key,
    })?;
    Ok(prev.is_none())
}

/// A file a stream promoted: stream cache, unless the surah is already pinned (then only its size and use time move).
fn record_stream_item(
    user: &UserDb,
    pack_id: &str,
    surah: u32,
    bytes: u64,
) -> Result<(), PackError> {
    let key = ItemKey::Surah(surah).db_key();
    let prev = user.pack_item(pack_id, &key)?;
    let now = user.now_ms();
    user.pack_item_upsert(&PackItemRow {
        pack_id: pack_id.to_owned(),
        item: key,
        bytes,
        sha256: prev.as_ref().map(|p| p.sha256.clone()).unwrap_or_default(),
        pinned: prev.as_ref().is_some_and(|p| p.pinned),
        fetched_at: prev.as_ref().map_or(now, |p| p.fetched_at),
        last_used_at: now,
    })?;
    Ok(())
}

/// One eviction pass (module docs). `busy`: `(pack id, surah)` of job items; surah 0 marks a pack with an active job,
/// whose files no row accounts for yet are never treated as orphans. Returns `(bytes freed, packs changed)`.
fn evict_blocking(
    env: &SyncEnv,
    cap_bytes: u64,
    orphans: bool,
    busy: &HashSet<(String, u32)>,
) -> Result<(u64, Vec<String>), PackError> {
    let reciters: HashMap<String, u32> = env
        .catalog
        .of_kind(PackKind::Recitation)
        .filter_map(|p| p.reciter().map(|c| (p.id.clone(), c.reciter_id)))
        .collect();
    let in_use = |reciter: u32, surah: u32| {
        let w = env.writers.info(reciter, surah);
        w.streams > 0 || w.job
    };
    let rows: Vec<(PackItemRow, u32, u32)> = env
        .user
        .pack_items_evictable(EVICTION_SCAN)?
        .into_iter()
        .filter_map(|row| {
            let reciter = *reciters.get(&row.pack_id)?;
            match ItemKey::parse_db_key(&row.item) {
                Some(ItemKey::Surah(s)) => Some((row, reciter, s)),
                _ => None,
            }
        })
        .collect();
    let mut total = rows
        .iter()
        .map(|(r, _, _)| r.bytes)
        .fold(0u64, u64::saturating_add);
    let mut freed = 0u64;
    let mut changed = BTreeSet::new();
    for (row, reciter, surah) in &rows {
        if total <= cap_bytes {
            break;
        }
        if busy.contains(&(row.pack_id.clone(), *surah)) || in_use(*reciter, *surah) {
            continue;
        }
        let path = install::audio_path(&env.root, *reciter, *surah);
        match install::remove_file_blocking(&path) {
            Ok(n) => {
                env.user.pack_item_delete(&row.pack_id, &row.item)?;
                total = total.saturating_sub(row.bytes);
                freed = freed.saturating_add(n);
                changed.insert(row.pack_id.clone());
            }
            Err(e) => log::debug!("stream cache: {} kept: {e}", path.display()),
        }
    }
    if orphans {
        for (pack_id, &reciter) in &reciters {
            if busy.contains(&(pack_id.clone(), 0)) {
                continue;
            }
            let rowed: HashSet<String> = env
                .user
                .pack_items(pack_id)?
                .into_iter()
                .map(|r| r.item)
                .collect();
            for f in read_dir(&install::audio_dir(&env.root, reciter)) {
                let name = f.file_name().to_string_lossy().into_owned();
                let Some(surah) = name
                    .strip_suffix(".mp3")
                    .and_then(ItemKey::parse_db_key)
                    .and_then(|k| match k {
                        ItemKey::Surah(s) => Some(s),
                        _ => None,
                    })
                else {
                    continue;
                };
                if rowed.contains(&ItemKey::Surah(surah).db_key()) || in_use(reciter, surah) {
                    continue;
                }
                if let Ok(n) = install::remove_file_blocking(&f.path()) {
                    freed = freed.saturating_add(n);
                    changed.insert(pack_id.clone());
                }
            }
        }
    }
    Ok((freed, changed.into_iter().collect()))
}

/// `word.text_hafs` of the words `from..=to`.
fn word_texts(core: &CoreDb, from: u32, to: u32) -> Result<HashMap<u32, String>, PackError> {
    let conn = core.conn()?;
    let mut stmt = conn
        .prepare_cached("SELECT id, text_hafs FROM word WHERE id BETWEEN ?1 AND ?2")
        .map_err(CoreError::from)?;
    let rows = stmt
        .query_map([from, to], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(CoreError::from)?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(CoreError::from)?;
    Ok(rows)
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, PackError> + Send + 'static,
) -> Result<T, PackError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("blocking task failed: {e}"))))?
}

/// The entries of a directory (empty when it does not exist or cannot be read).
fn read_dir(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir).map_or_else(|_| Vec::new(), |rd| rd.flatten().collect())
}

fn kib(bytes: u64) -> u32 {
    u32::try_from(bytes.div_ceil(1024)).unwrap_or(u32::MAX)
}

fn ms_to_secs(ms: i64) -> u32 {
    u32::try_from(ms.max(0) / 1000).unwrap_or(u32::MAX)
}

fn dedup(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

const fn is_whole_kind(kind: PackKind) -> bool {
    matches!(kind, PackKind::Translation | PackKind::Tafsir)
}

/// `items_total` of a pack without a row: its catalog items (1 for a whole pack).
fn items_total(pack: &CatalogPack) -> u32 {
    if matches!(pack.source, Adapter::QuranEncSqlite(_)) {
        1
    } else {
        pack.item_count
    }
}

/// `PackInfo.installed_kib`: what the row records as present (pinned) on disk.
fn installed_kib(row: Option<&InstalledPackRow>) -> u32 {
    row.filter(|r| r.status != InstalledStatus::Removing)
        .map_or(0, |r| kib(r.bytes))
}

/// Packs whose items have IPC numbers (pages, surahs, chapters).
const fn has_numbered_items(source: &Adapter) -> bool {
    matches!(
        source,
        Adapter::QcfFontPages(_)
            | Adapter::QdcAudio(_)
            | Adapter::QurancomTafsir(_)
            | Adapter::QurancomWbw(_)
    )
}

/// Whether `key` is an item of a pack with this source.
fn is_item_of(source: &Adapter, key: &ItemKey) -> bool {
    match (source, key) {
        (Adapter::QcfFontPages(_), ItemKey::Page(n)) => (1..=PAGE_COUNT).contains(n),
        (Adapter::QdcAudio(_), ItemKey::Surah(n))
        | (Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_), ItemKey::Chapter(n)) => {
            (1..=SURAH_COUNT).contains(n)
        }
        (Adapter::StaticFiles(c), ItemKey::File(path)) => c.files.iter().any(|f| f.path == *path),
        _ => false,
    }
}

/// The item keys of IPC item numbers for [`PackManager::remove_items`], validated.
fn item_keys(pack: &CatalogPack, items: &[u32]) -> Result<BTreeSet<ItemKey>, PackError> {
    let (max, make): (u32, fn(u32) -> ItemKey) = match pack.source {
        Adapter::QcfFontPages(_) => (PAGE_COUNT, ItemKey::Page),
        Adapter::QdcAudio(_) => (SURAH_COUNT, ItemKey::Surah),
        Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_) => (SURAH_COUNT, ItemKey::Chapter),
        Adapter::StaticFiles(_) | Adapter::QuranEncSqlite(_) => {
            return Err(PackError::Unsupported(format!(
                "{} has no per-item scope: remove the whole pack",
                pack.id
            )));
        }
    };
    items
        .iter()
        .map(|&n| {
            if (1..=max).contains(&n) {
                Ok(make(n))
            } else {
                Err(PackError::Core(CoreError::InvalidArgument(format!(
                    "item {n} of {} is outside 1..={max}",
                    pack.id
                ))))
            }
        })
        .collect()
}

fn check_ayah(ayah_id: u32) -> Result<(), PackError> {
    if (1..=AYAH_COUNT).contains(&ayah_id) {
        Ok(())
    } else {
        Err(invalid_ayah(ayah_id))
    }
}

fn invalid_ayah(ayah_id: u32) -> PackError {
    PackError::Core(CoreError::InvalidArgument(format!(
        "ayah {ayah_id} is outside 1..={AYAH_COUNT}"
    )))
}

fn no_entry(pack_id: &str, ayah_id: u32) -> PackError {
    PackError::NotFound(format!("{pack_id} has no entry for ayah {ayah_id}"))
}

/// A pack's content language and direction (catalog `language`/`direction`; English when absent).
fn pack_language(pack: &CatalogPack) -> (String, TextDir) {
    let lang = pack.language.clone().unwrap_or_else(|| "en".to_owned());
    let dir = pack.direction.unwrap_or_else(|| language_direction(&lang));
    (lang, dir)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(kib(0), 0);
        assert_eq!(kib(1), 1);
        assert_eq!(kib(1024), 1);
        assert_eq!(kib(1025), 2);
        assert_eq!(kib(u64::MAX), u32::MAX);
        assert_eq!(ms_to_secs(-5), 0);
        assert_eq!(ms_to_secs(1_999), 1);
        assert_eq!(dedup(vec!["b".into(), "a".into(), "b".into()]), ["a", "b"]);
        assert_eq!(update_item_key(), "file:update");
    }

    #[test]
    fn item_membership_follows_the_source() {
        let fonts: Adapter = serde_json::from_value(serde_json::json!({
            "adapter": "qcf_font_pages", "variant": "v2", "urlTemplates": [] }))
        .unwrap();
        assert!(is_item_of(&fonts, &ItemKey::Page(604)));
        assert!(!is_item_of(&fonts, &ItemKey::Page(605)));
        assert!(!is_item_of(&fonts, &ItemKey::Surah(2)));
        let audio: Adapter = serde_json::from_value(serde_json::json!({
            "adapter": "qdc_audio", "reciterId": 7, "name": { "en": "a", "ar": "ب" },
            "basmalaInFile": false, "hosts": [], "wordLevel": true }))
        .unwrap();
        assert!(is_item_of(&audio, &ItemKey::Surah(114)));
        assert!(!is_item_of(&audio, &ItemKey::File("update".into())));
        let decor: Adapter = serde_json::from_value(serde_json::json!({
            "adapter": "static_files", "files": [{ "path": "a.ttf", "urls": [], "bytes": 1 }] }))
        .unwrap();
        assert!(is_item_of(&decor, &ItemKey::File("a.ttf".into())));
        assert!(!is_item_of(&decor, &ItemKey::File("b.ttf".into())));
        assert!(!has_numbered_items(&decor));
    }

    #[test]
    fn known_updates_expire_with_a_later_check() {
        let k = KnownUpdate {
            update: PackUpdate {
                pack_id: "tr.en.saheeh".into(),
                installed: "1.1.2".into(),
                latest: "1.1.3".into(),
                size_kib: 507,
            },
            checked_at: Some(100),
        };
        let json = serde_json::to_value(&k).unwrap();
        assert_eq!(json["checkedAt"], 100);
        assert_eq!(serde_json::from_value::<KnownUpdate>(json).unwrap(), k);
    }
}
