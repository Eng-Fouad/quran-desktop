//! `AudioService`: the recitation engine wired into the app (docs/ARCHITECTURE.md §2.8.4). Owner: WP4d.
//!
//! - **Requests** ([`AudioService::play`]): validated and `to` resolved (§5.8) from the cached Quran index (end of surah,
//!   page in the request's layout, juz, or the Quran), then handed to `qd-audio-ctl`; never blocks.
//! - **Timings** (`TimingsStore`): content.db first; when missing, `PackManager::surah_timings` (fetch → sanitise →
//!   store). A stored copy older than the QF revalidation period is used at once (stale-while-revalidate): playback
//!   never waits for the network when timings are on disk (a downloaded surah plays offline-fast on a slow link), and
//!   the copy is refreshed in the background (`audio_get_timings` waits up to `REVALIDATE_GRACE` for the refresh
//!   first). The engine's [`TimingsSource`] runs this on `qd-audio-ctl` with `Handle::block_on` (the only place, §0.2),
//!   giving up as soon as the play is cancelled ([`CancelToken`]); `audio_get_timings` awaits it directly. Overlapping
//!   fetches of one surah share a single request, and each play prefetches the surahs its planner loads one by one, a
//!   few at a time.
//! - **Sources** (`GlueSources`): [`CachingHttpSource`] over `packs/audio` (streams register with the pack manager's
//!   single-writer registry through [`StreamRegistry`]); when its file no longer matches the timings (§2.3.7 rule 7,
//!   [`AudioError::FileMismatch`]) the timings are refetched once through `PackManager::refresh_surah_timings`, which
//!   replaces the pair in one step, and the engine plans the play again with them.
//! - **Events** ([`EventSink`]): `AudioStateChanged` / `AudioAyahChanged`, ticks to the `audio_subscribe` channel
//!   (filtered: every tick that changes what the UI shows, and one per [`TICK_RESYNC`] to re-anchor the position the
//!   player interpolates; [`TickFilter`]), the UI sink (tray label and OS media session, LEAD item 3) on state and ayah
//!   edges only, and **listen history**: an
//!   ayah heard for 3 s records its page once per visit (`HistoryInput { mode: listen }`), followed by
//!   `UserDataChanged { kinds: [history] }`. The UI sink and history writes run on the `qd-audio-glue` thread, so the
//!   engine threads never wait on the UI or on SQLite.
//! - **OS media commands** ([`AudioService::handle_media_command`], §2.4 mapping; Play with nothing loaded replays the
//!   last recitation).
//!
//! `start` is generic over the tauri `Runtime` so `setup::build_state` stays testable with `tauri::test::mock_app()`;
//! in the app (Wry) it also registers the UI sink.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use media_session::MediaCommand;
use quran_audio::{
    AudioEngine, AudioError, AyahSpan, CachingHttpSource, CancelToken, EngineConfig, EventSink,
    FileKey, LocalFileSource, OnlineFn, OpenedSource, OutputKind, ReciterFlags, SourceProvider,
    StreamRegistry, SurahTimingSet, TimingsSource,
};
use quran_core::content_db::geometry;
use quran_core::{ContentDb, CoreDb, StoredTimings, UserDb};
use quran_packs::manager::REVALIDATE_GRACE;
use quran_packs::{PackError, PackManager};
use quran_types::limits::{GAP_FIXED_MS, GAP_MULTIPLIER_PCT, REPEAT, SPEED_PCT};
use quran_types::{
    AYAH_COUNT, AppError, AudioSnapshot, AudioTick, AyahChange, AyahRef, Division, GapSetting,
    HistoryInput, HistoryMode, MushafLayout, PackKind, PlayRequest, PlaybackStatus, QuranIndex,
    ReciterInfo, SURAH_COUNT, SeekTarget, Settings, SkipDirection, StopAt, SurahTimings,
    UiLanguage, UserDataKind,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_specta::Event;

use crate::ipc::events::{AudioAyahChanged, AudioStateChanged, UserDataChanged};

/// An ayah heard this long records its page in the listen history (§2.8.4).
pub const LISTEN_MIN_AYAH: Duration = Duration::from_secs(3);
/// A visit to one page that lasts longer is checkpointed this often (user.db merges records of the same page within
/// 10 minutes, so a visit stays one entry).
const LISTEN_CHECKPOINT_S: u32 = 5 * 60;
/// The time between two ticks counts at most this much (a stalled tick thread or a suspended machine is not listening).
const LISTEN_MAX_TICK_GAP: Duration = Duration::from_millis(500);
/// How long [`AudioService::shutdown`] waits for the `qd-audio-glue` thread.
const WORKER_STOP_WAIT: Duration = Duration::from_millis(500);
/// While playing, a tick that changes nothing the UI shows at once still reaches the webview this often, so the position
/// the player interpolates between ticks stays anchored to the audible one ([`TickFilter`]).
pub const TICK_RESYNC: Duration = Duration::from_millis(250);
/// A tick whose position differs by more than this from where the webview's interpolation puts it (a repeat, an A-B
/// wrap, a stall) is a jump, and goes through at once ([`TickFilter`]).
pub const TICK_DRIFT_MS: u64 = 40;

/// The UI sink (LEAD item 3): called with the snapshot on every playback-state or ayah edge, never per tick, on the
/// `qd-audio-glue` thread. `setup::AudioUiSink::into_sink` builds the app's (tray label and OS media session).
pub type UiSinkFn = Arc<dyn Fn(&AudioSnapshot) + Send + Sync>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}

// ---------------------------------------------------------------------------------------------------------------------
// The service.

/// The app's recitation service (managed in `AppState::audio`). `Send + Sync`; every method is cheap and non-blocking
/// except [`AudioService::shutdown`] (joins threads) and the first [`AudioService::play`] before the index is warm
/// (see `audio_play`, which warms it on the blocking pool).
pub struct AudioService {
    engine: AudioEngine,
    shared: Arc<GlueShared>,
    store: Arc<TimingsStore>,
    packs: PackManager,
    core: CoreDb,
    /// `settings.stop_at`: the end of a request without `to` and `stop_at`.
    default_stop: Mutex<StopAt>,
    /// The last request played (resolved), which an OS "play" replays once the recitation ended or was stopped.
    last_request: Mutex<Option<PlayRequest>>,
}

/// Everything [`AudioService::start_with`] needs; `start` fills it for the app.
pub(crate) struct GlueParts {
    pub emitter: Arc<dyn EventEmitter>,
    pub core: CoreDb,
    pub content: ContentDb,
    pub user: UserDb,
    pub packs: PackManager,
    pub settings: Settings,
    /// Where timings come from when content.db has none (the pack manager in the app).
    pub fetcher: Arc<dyn TimingsFetcher>,
    /// `packs/audio`.
    pub audio_root: PathBuf,
    /// The streaming client; `None` plays cached files only.
    pub client: Option<reqwest::Client>,
    pub rt: tokio::runtime::Handle,
    pub output: OutputKind,
    /// [`LISTEN_MIN_AYAH`] in the app.
    pub listen_min_ayah: Duration,
    /// Network availability; `None` is the pack manager's (`PackManager::online`).
    pub online: Option<OnlineFn>,
}

impl AudioService {
    /// Starts the engine on the system output (in debug builds, the `QD_AUDIO_SINK` sink, D24). Having no output device
    /// is not an error: the engine reports it in its status and retries. In the app (the Wry runtime) the UI sink is
    /// registered here too (see [`AudioService::register_app_ui_sink`]).
    ///
    /// # Errors
    /// `AppError::Audio` when an engine or glue thread cannot be started.
    pub fn start<R: Runtime>(
        app: &AppHandle<R>,
        core: CoreDb,
        content: ContentDb,
        user: UserDb,
        packs: PackManager,
        settings: &Settings,
    ) -> Result<Self, AppError> {
        // LEAD item 2: streams share the pack layer's file client (its User-Agent, system proxies and timeouts, no
        // decompression, so `Content-Length` is the file's length the timings are bound to).
        let service = Self::start_with(GlueParts {
            emitter: Arc::new(app.clone()),
            fetcher: Arc::new(packs.clone()),
            audio_root: packs.audio_root(),
            client: Some(packs.http_client()),
            rt: tauri::async_runtime::handle().inner().clone(),
            output: OutputKind::from_env(),
            listen_min_ayah: LISTEN_MIN_AYAH,
            online: None,
            core,
            content,
            user,
            packs,
            settings: settings.clone(),
        })?;
        service.register_app_ui_sink(app, settings.ui_language);
        Ok(service)
    }

    /// LEAD item 3: the app's UI sink (`setup::AudioUiSink`: the OS media session and the tray's "Now: {ref}" label on
    /// every state or ayah edge). It needs the concrete Wry handle, which `start` has whenever it runs in the app, so
    /// it is registered from here rather than depending on a later call; the planned registration in
    /// `setup::after_manage` stays valid and would simply replace it. Its first delivery, before `AppState` is
    /// managed, is a no-op (the hooks look the state up). Other runtimes (`tauri::test`) get no sink.
    fn register_app_ui_sink<R: Runtime>(&self, app: &AppHandle<R>, lang: UiLanguage) {
        let app: &dyn Any = app;
        match app.downcast_ref::<AppHandle<tauri::Wry>>() {
            Some(app) => {
                self.set_ui_sink(crate::setup::AudioUiSink::new(app, lang).into_sink());
                log::debug!("audio: UI sink registered (OS media session and tray)");
            }
            None => log::debug!("audio: no UI sink on this runtime"),
        }
    }

    /// [`AudioService::start`] from explicit parts (tests choose the output, the fetcher, the network switch and the
    /// listen-history threshold).
    pub(crate) fn start_with(parts: GlueParts) -> Result<Self, AppError> {
        let GlueParts {
            emitter,
            core,
            content,
            user,
            packs,
            settings,
            fetcher,
            audio_root,
            client,
            rt,
            output,
            listen_min_ayah,
            online,
        } = parts;
        let online: OnlineFn = online.unwrap_or_else(|| {
            let packs = packs.clone();
            Arc::new(move || packs.online())
        });
        let store = Arc::new(TimingsStore::new(
            content,
            fetcher,
            Arc::clone(&online),
            rt.clone(),
        ));
        let inner: Box<dyn SourceProvider> = match client {
            Some(client) => Box::new(CachingHttpSource::new(
                audio_root,
                rt.clone(),
                client,
                Arc::new(GlueRegistry {
                    packs: packs.clone(),
                }),
                online,
            )),
            None => Box::new(LocalFileSource::new(audio_root)),
        };
        let sources = Arc::new(GlueSources {
            inner,
            store: Arc::clone(&store),
            on_open: {
                let packs = packs.clone();
                Box::new(move |key: &FileKey| {
                    packs.audio_used(key.reciter_id, u32::from(key.surah));
                })
            },
        });
        let timings = Arc::new(GlueTimings {
            store: Arc::clone(&store),
            packs: packs.clone(),
        });
        let shared = Arc::new(GlueShared::new(emitter, user, listen_min_ayah)?);
        let engine = match AudioEngine::start_with_output(
            EngineConfig::default(),
            timings,
            sources,
            Arc::new(GlueEvents(Arc::clone(&shared))),
            output,
        ) {
            Ok(engine) => engine,
            Err(e) => {
                shared.worker.stop(WORKER_STOP_WAIT);
                return Err(e.into());
            }
        };
        engine.set_volume(settings.volume_pct);
        engine.set_speed(settings.speed_pct);
        Ok(Self {
            engine,
            shared,
            store,
            packs,
            core,
            default_stop: Mutex::new(settings.stop_at),
            last_request: Mutex::new(None),
        })
    }

    /// Cheap: validates, resolves `to` (§5.8) from the cached index, sends to `qd-audio-ctl`; never blocks once the
    /// index is warm ([`AudioService::index_ready`]). Returns the snapshot, already `loading`.
    ///
    /// # Errors
    /// `InvalidArgument` for a bad range, repeat or gap; `NotFound` for a reciter the catalog does not list, or for a
    /// page/juz end without core.db (debug builds).
    pub fn play(&self, req: PlayRequest) -> Result<AudioSnapshot, AppError> {
        self.check_reciter(req.reciter_id)?;
        let default_stop = *lock(&self.default_stop);
        let index = self.play_index();
        let index = match index {
            Ok(index) => Some(index),
            Err(e) if needs_index(&req, default_stop) => return Err(e),
            Err(_) => None,
        };
        let req = resolve_request(req, index.as_deref(), default_stop)?;
        self.shared.begin_play(req.layout, req.record);
        // A preview (`record: false`) is no part of the listening: "play with nothing loaded" keeps replaying the
        // recitation before it.
        if req.record {
            *lock(&self.last_request) = Some(PlayRequest {
                start_paused: false,
                ..req.clone()
            });
        }
        if let (Some(to), Some(stop)) = (req.to, req.stop_at) {
            log::info!(
                "audio: play reciter {} {}:{}..={}:{} ({stop:?})",
                req.reciter_id,
                req.from.surah,
                req.from.ayah,
                to.surah,
                to.ayah
            );
        }
        self.prefetch_timings(&req);
        self.engine.play(req);
        Ok(self.engine.snapshot())
    }

    /// Starts fetching, a few at a time, the timings the planner will ask for one by one for `req` (resolved), so a
    /// play across many surahs of an uncached reciter does not wait for one round trip per surah. Supersedes the
    /// previous play's prefetch. See [`TimingsStore::prefetch`].
    fn prefetch_timings(&self, req: &PlayRequest) {
        let basmala_in_file = self
            .packs
            .reciter_meta(req.reciter_id)
            .is_some_and(|(_, in_file)| in_file);
        self.store
            .prefetch(req.reciter_id, planned_surahs(req, basmala_in_file));
    }

    /// Whether [`AudioService::play`] can resolve page and juz ends without touching SQLite.
    #[must_use]
    pub fn index_ready(&self) -> bool {
        self.shared.index.get().is_some()
    }

    /// The play index, derived once from `CoreDb::index()` (itself built once, by `app_bootstrap` or `audio_play`).
    fn play_index(&self) -> Result<Arc<PlayIndex>, AppError> {
        if let Some(index) = self.shared.index.get() {
            return Ok(Arc::clone(index));
        }
        let built = Arc::new(PlayIndex::from_index(&self.core.index()?)?);
        Ok(Arc::clone(self.shared.index.get_or_init(|| built)))
    }

    /// `NotFound` for a reciter the catalog does not list (no check while the catalog lists no reciter at all).
    fn check_reciter(&self, reciter_id: u32) -> Result<(), AppError> {
        let catalog = self.packs.catalog();
        if catalog.reciter(reciter_id).is_none()
            && catalog.of_kind(PackKind::Recitation).next().is_some()
        {
            return Err(AppError::NotFound(format!(
                "reciter {reciter_id} is not in the catalog"
            )));
        }
        Ok(())
    }

    #[must_use]
    pub fn engine(&self) -> &AudioEngine {
        &self.engine
    }

    /// Replaces the previous channel (`audio_subscribe`).
    pub fn set_tick_channel(&self, ch: Channel<AudioTick>) {
        self.shared.tick.set(ch);
    }

    /// Registers the UI sink (LEAD item 3; replaces a previous one) and hands it the current state at once.
    pub fn set_ui_sink(&self, sink: UiSinkFn) {
        self.shared.worker.set_ui_sink(sink);
        self.shared.worker.post_ui(self.engine.snapshot());
    }

    #[must_use]
    pub fn snapshot(&self) -> AudioSnapshot {
        self.engine.snapshot()
    }

    /// ASYNC: awaits the pack manager directly (§0.2: no `block_on` in async code); content.db is read on the blocking
    /// pool. Only the `TimingsSource` impl, which runs on `qd-audio-ctl`, uses `Handle::block_on`.
    ///
    /// # Errors
    /// `InvalidArgument` for a surah outside 1..=114, `NotFound` for an unknown reciter, `Offline` when the timings are
    /// not stored and cannot be fetched, else the pack manager's error.
    pub async fn timings(&self, reciter_id: u32, surah: u32) -> Result<SurahTimings, AppError> {
        check_surah(surah)?;
        self.check_reciter(reciter_id)?;
        let stored = self.store.get(reciter_id, surah).await?;
        Ok(stored.to_dto())
    }

    #[must_use]
    pub fn reciters(&self) -> Vec<ReciterInfo> {
        self.packs.reciters()
    }

    /// Volume and speed apply live (the engine keeps speed across plays); `stop_at` is the default end of the next play.
    /// Repeats and gap travel in each `PlayRequest`.
    pub fn apply_settings(&self, prev: &Settings, next: &Settings) {
        if prev.volume_pct != next.volume_pct {
            self.engine.set_volume(next.volume_pct);
        }
        if prev.speed_pct != next.speed_pct {
            self.engine.set_speed(next.speed_pct);
        }
        if prev.stop_at != next.stop_at {
            *lock(&self.default_stop) = next.stop_at;
        }
    }

    /// OS media controls and the tray (§2.4 mapping): Next/Previous are the next/previous ayah; SetRate is rounded to
    /// 5 %. Play (and Play/Pause) with nothing loaded replays the last recitation, as media keys do in players; after a
    /// recitation failed mid-way (still loaded, shown paused), the engine's resume starts it again where it stopped.
    /// `Raise` is a window action, handled by the caller.
    pub fn handle_media_command(&self, cmd: MediaCommand) {
        let engine = &self.engine;
        match cmd {
            MediaCommand::Play => {
                if !self.replay_if_unloaded() {
                    engine.resume();
                }
            }
            MediaCommand::Pause => engine.pause(),
            MediaCommand::Toggle => {
                if !self.replay_if_unloaded() {
                    engine.toggle();
                }
            }
            MediaCommand::Stop => engine.stop(),
            MediaCommand::Next => engine.skip(SkipDirection::Next),
            MediaCommand::Previous => engine.skip(SkipDirection::Previous),
            MediaCommand::SeekTo(position) => engine.seek(SeekTarget::FileMs {
                ms: duration_ms(position),
            }),
            MediaCommand::SeekBy(delta_us) => engine.seek(SeekTarget::RelativeMs {
                delta_ms: delta_ms(delta_us),
            }),
            MediaCommand::SetRate(rate) => engine.set_speed(speed_pct_from_rate(rate)),
            MediaCommand::Raise => {}
        }
    }

    /// Replays the last request when nothing is loaded (ended, stopped, or failed before it started). Returns whether
    /// it did. A recitation that failed mid-way is still loaded (`current`): the engine's resume continues it.
    fn replay_if_unloaded(&self) -> bool {
        let snapshot = self.engine.snapshot();
        let unloaded = snapshot.current.is_none()
            && matches!(
                snapshot.status,
                PlaybackStatus::Idle | PlaybackStatus::Error
            );
        if !unloaded {
            return false;
        }
        let Some(req) = lock(&self.last_request).clone() else {
            return false;
        };
        match self.play(req) {
            Ok(_) => true,
            Err(e) => {
                log::warn!("audio: the last recitation cannot be replayed: {e}");
                false
            }
        }
    }

    /// Idempotent and blocking (≤ 0.5 s for the engine, ≤ 0.5 s for the glue thread): stops the engine, records the
    /// page being listened to, and stops the `qd-audio-glue` thread.
    pub fn shutdown(&self) {
        self.engine.shutdown();
        let pending = lock(&self.shared.listen).close();
        for entry in pending {
            self.shared.worker.record_now(&entry);
        }
        self.shared.worker.stop(WORKER_STOP_WAIT);
    }
}

impl std::fmt::Debug for AudioService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioService")
            .field("engine", &self.engine)
            .field("index_ready", &self.index_ready())
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Request resolution (§5.8).

/// What `to` resolution and listen history need from the Quran index: ayah first words, page first words per layout,
/// juz ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlayIndex {
    /// Index = ayah id − 1.
    ayah_first_word: Vec<u32>,
    /// Index = page − 1, per layout.
    page_first_word: Vec<(MushafLayout, Vec<u32>)>,
    juz: Vec<Division>,
}

impl PlayIndex {
    pub(crate) fn from_index(index: &QuranIndex) -> Result<Self, AppError> {
        if index.ayah_first_word.len() != AYAH_COUNT as usize || index.layouts.is_empty() {
            return Err(AppError::Database(format!(
                "the Quran index has {} ayahs and {} layouts",
                index.ayah_first_word.len(),
                index.layouts.len()
            )));
        }
        Ok(Self {
            ayah_first_word: index.ayah_first_word.clone(),
            page_first_word: index
                .layouts
                .iter()
                .map(|l| (l.layout, l.page_first_word.clone()))
                .collect(),
            juz: index.juz.clone(),
        })
    }

    fn pages(&self, layout: MushafLayout) -> Option<&[u32]> {
        self.page_first_word
            .iter()
            .find(|(l, _)| *l == layout)
            .map(|(_, pages)| pages.as_slice())
    }

    fn first_word(&self, ayah_id: u32) -> Option<u32> {
        let i = usize::try_from(ayah_id.checked_sub(1)?).ok()?;
        self.ayah_first_word.get(i).copied()
    }

    /// The page of `layout` that holds the ayah's first word.
    pub(crate) fn page_of(&self, layout: MushafLayout, ayah_id: u32) -> Option<u32> {
        let word = self.first_word(ayah_id)?;
        let pages = self.pages(layout)?;
        let page = pages.partition_point(|&first| first <= word);
        u32::try_from(page).ok().filter(|&p| p >= 1)
    }

    /// The last ayah whose first word is on the page of `ayah_id` (§5.8 `EndOfPage`).
    pub(crate) fn end_of_page(&self, layout: MushafLayout, ayah_id: u32) -> Option<u32> {
        let page = self.page_of(layout, ayah_id)?;
        let pages = self.pages(layout)?;
        let next_page_first = usize::try_from(page).ok().and_then(|i| pages.get(i));
        let last = match next_page_first {
            Some(&next_first) => {
                let n = self.ayah_first_word.partition_point(|&w| w < next_first);
                u32::try_from(n).ok()?
            }
            None => AYAH_COUNT,
        };
        (last >= ayah_id).then_some(last)
    }

    /// The last ayah of the juz that holds `ayah_id` (§5.8 `EndOfJuz`).
    pub(crate) fn end_of_juz(&self, ayah_id: u32) -> Option<u32> {
        self.juz
            .iter()
            .find(|d| d.first_ayah_id <= ayah_id && ayah_id <= d.last_ayah_id)
            .map(|d| d.last_ayah_id)
    }
}

/// The canonical id of `r`, if it is an ayah (ayah ≥ 1).
pub(crate) fn ayah_id_of(r: AyahRef) -> Option<u32> {
    let ids = geometry::surah_ayah_ids(r.surah)?;
    let id = ids.start().checked_add(r.ayah.checked_sub(1)?)?;
    ids.contains(&id).then_some(id)
}

fn ayah_ref_of(ayah_id: u32) -> Option<AyahRef> {
    geometry::ayah_ref(ayah_id).map(|(surah, ayah)| AyahRef { surah, ayah })
}

fn check_surah(surah: u32) -> Result<(), AppError> {
    if (1..=SURAH_COUNT).contains(&surah) {
        Ok(())
    } else {
        Err(invalid(format!(
            "surah {surah} is not in 1..={SURAH_COUNT}"
        )))
    }
}

/// Repeats: 0..=99 (0 = ∞).
pub(crate) fn check_repeat(what: &str, n: u32) -> Result<(), AppError> {
    if REPEAT.contains(n) {
        Ok(())
    } else {
        Err(invalid(format!("{what} {n} is not in 0..=99")))
    }
}

/// Gap: fixed 0..=30000 ms, multiplier 0..=300 %.
pub(crate) fn check_gap(gap: GapSetting) -> Result<(), AppError> {
    match gap {
        GapSetting::Fixed { ms } if !GAP_FIXED_MS.contains(ms) => {
            Err(invalid(format!("gap {ms} ms is not in 0..=30000")))
        }
        GapSetting::Multiplier { pct } if !GAP_MULTIPLIER_PCT.contains(pct) => {
            Err(invalid(format!("gap multiplier {pct} % is not in 0..=300")))
        }
        _ => Ok(()),
    }
}

/// Speed: 50..=200 in steps of 5.
pub(crate) fn check_speed(pct: u32) -> Result<(), AppError> {
    if SPEED_PCT.contains(pct) {
        Ok(())
    } else {
        Err(invalid(format!(
            "speed {pct} % is not in 50..=200 in steps of 5"
        )))
    }
}

/// Whether resolving `req` needs the Quran index (a page or juz end).
fn needs_index(req: &PlayRequest, default_stop: StopAt) -> bool {
    req.to.is_none()
        && matches!(
            req.stop_at.unwrap_or(default_stop),
            StopAt::EndOfPage | StopAt::EndOfJuz
        )
}

/// The surahs whose timings the planner loads for `req` (resolved), in its order (§2.3.3): every surah of the range,
/// and the reciter's surah 1 right after the first surah that opens with a basmala taken from it (a surah other than
/// 1 and 9 planned from ayah 1, when the reciter's files do not carry the basmala).
pub(crate) fn planned_surahs(req: &PlayRequest, basmala_in_file: bool) -> Vec<u32> {
    let Some(to) = req.to else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for surah in req.from.surah..=to.surah {
        out.push(surah);
        let first_ayah = if surah == req.from.surah {
            req.from.ayah
        } else {
            1
        };
        if !basmala_in_file
            && first_ayah == 1
            && !matches!(surah, 1 | 9)
            && !out.contains(&BASMALA_SURAH)
        {
            out.push(BASMALA_SURAH);
        }
    }
    out
}

/// The surah whose first ayah is the basmala of reciters without one in their files (§2.3.3, FACT C8).
const BASMALA_SURAH: u32 = 1;

/// Validates `req` and fills `to` (and `stop_at`) (§5.8):
/// - `EndOfSurah` → the last ayah of `from.surah`; `EndOfPage` → the last ayah whose first word is on `from`'s page in
///   `req.layout`; `EndOfJuz` → the juz's last ayah; `EndOfQuran` → 114:6; `stop_at = None` takes `default_stop`
///   (`settings.stop_at`);
/// - `from ≤ to`, both real ayahs (the range is then at most 6,236 ayahs), repeats 0..=99, gap within its bounds.
pub(crate) fn resolve_request(
    mut req: PlayRequest,
    index: Option<&PlayIndex>,
    default_stop: StopAt,
) -> Result<PlayRequest, AppError> {
    let from_id = ayah_id_of(req.from).ok_or_else(|| {
        invalid(format!(
            "from {}:{} is not an ayah",
            req.from.surah, req.from.ayah
        ))
    })?;
    check_repeat("ayah repeat", req.ayah_repeat)?;
    check_repeat("range repeat", req.range_repeat)?;
    check_gap(req.gap)?;
    let to_id = match req.to {
        Some(to) => ayah_id_of(to)
            .ok_or_else(|| invalid(format!("to {}:{} is not an ayah", to.surah, to.ayah)))?,
        None => {
            let stop = req.stop_at.unwrap_or(default_stop);
            req.stop_at = Some(stop);
            let no_index = || {
                AppError::NotFound(format!(
                    "{stop:?} needs the Quran index ({})",
                    quran_core::core_db::UNAVAILABLE_MESSAGE
                ))
            };
            let resolved = match stop {
                StopAt::EndOfSurah => {
                    geometry::surah_ayah_ids(req.from.surah).map(|ids| *ids.end())
                }
                StopAt::EndOfPage => index.ok_or_else(no_index)?.end_of_page(req.layout, from_id),
                StopAt::EndOfJuz => index.ok_or_else(no_index)?.end_of_juz(from_id),
                StopAt::EndOfQuran => Some(AYAH_COUNT),
            };
            resolved.ok_or_else(|| {
                AppError::Internal(format!(
                    "cannot resolve {stop:?} from ayah {from_id} in {:?}",
                    req.layout
                ))
            })?
        }
    };
    if to_id < from_id {
        return Err(invalid(format!(
            "play range {}:{}..={} is reversed",
            req.from.surah, req.from.ayah, to_id
        )));
    }
    req.to = Some(ayah_ref_of(to_id).ok_or_else(|| invalid(format!("ayah {to_id}")))?);
    Ok(req)
}

// ---------------------------------------------------------------------------------------------------------------------
// Timings.

/// A boxed, `Send` future (no `async fn` in a `dyn` trait).
pub(crate) type FetchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<StoredTimings, PackError>> + Send + 'a>>;

/// Where timings come from when content.db has none or they are stale: the pack manager (QDC fetch → sanitise →
/// store, §2.5.6) in the app, fixtures in tests.
pub(crate) trait TimingsFetcher: Send + Sync + 'static {
    /// The timings for playback: stored and fresh, else refreshed (`PackManager::surah_timings`).
    fn fetch(&self, reciter_id: u32, surah: u32) -> FetchFuture<'_>;
    /// Refetched now, whatever their age, replacing the stored pair in one step (`PackManager::refresh_surah_timings`,
    /// §2.3.7 rule 7): an unpinned file that changed upstream is dropped with its old timings; a pinned pair is kept
    /// until the revalidator, woken by the refresh, swaps file and timings together (§2.5.7).
    fn refresh(&self, reciter_id: u32, surah: u32) -> FetchFuture<'_>;
}

impl TimingsFetcher for PackManager {
    fn fetch(&self, reciter_id: u32, surah: u32) -> FetchFuture<'_> {
        Box::pin(self.surah_timings(reciter_id, surah))
    }

    fn refresh(&self, reciter_id: u32, surah: u32) -> FetchFuture<'_> {
        Box::pin(self.refresh_surah_timings(reciter_id, surah))
    }
}

/// How many timing fetches a play's prefetch keeps in flight (QDC serves one surah's timings per request).
pub(crate) const PREFETCH_CONCURRENCY: usize = 4;

/// One fetch of a `(reciter, surah)`: every caller that overlaps it shares its request and its outcome.
type Flight = tokio::sync::OnceCell<Result<StoredTimings, FetchFailure>>;

/// A failed fetch, in the two forms its callers need: the planner's error and the command's.
#[derive(Debug, Clone)]
struct FetchFailure {
    planner: AudioError,
    app: AppError,
}

impl FetchFailure {
    fn new(reciter_id: u32, surah: u32, e: PackError) -> Self {
        Self {
            planner: timings_error(reciter_id, surah, &e),
            app: AppError::from(e),
        }
    }
}

/// The timings policy shared by the engine's `TimingsSource` (blocking, `qd-audio-ctl`) and `audio_get_timings`
/// (async): stored and fresh → stored; else fetch when online; a failed or impossible fetch falls back to the stored
/// copy (§2.5.7 "Offline: keep using the stored copy"). Overlapping fetches of one surah share a single request, and a
/// play prefetches the surahs its planner will load one by one ([`TimingsStore::prefetch`]).
pub(crate) struct TimingsStore {
    content: ContentDb,
    fetcher: Arc<dyn TimingsFetcher>,
    online: OnlineFn,
    rt: tokio::runtime::Handle,
    max_age: Duration,
    /// Files whose mismatch already caused a refetch (§2.3.7 rule 7: once).
    refetched: Mutex<HashSet<FileKey>>,
    /// The fetches in flight, by `(reciter, surah)`.
    flights: Mutex<HashMap<(u32, u32), Arc<Flight>>>,
    /// Bumped by every prefetch (every play): an older prefetch starts no further fetch.
    prefetch_generation: AtomicU64,
}

/// What the stored copy allows.
enum Plan {
    Use(StoredTimings),
    Fetch { stale: Option<StoredTimings> },
}

impl TimingsStore {
    fn new(
        content: ContentDb,
        fetcher: Arc<dyn TimingsFetcher>,
        online: OnlineFn,
        rt: tokio::runtime::Handle,
    ) -> Self {
        Self {
            content,
            fetcher,
            online,
            rt,
            max_age: quran_packs::revalidate::MAX_AGE,
            refetched: Mutex::new(HashSet::new()),
            flights: Mutex::new(HashMap::new()),
            prefetch_generation: AtomicU64::new(0),
        }
    }

    fn is_fresh(&self, fetched_at_ms: i64, now_ms: i64) -> bool {
        quran_packs::revalidate::is_fresh(fetched_at_ms, now_ms, self.max_age)
    }

    fn plan(&self, stored: Option<StoredTimings>) -> Plan {
        match stored {
            Some(t) if self.is_fresh(t.file.fetched_at_ms, now_ms()) => Plan::Use(t),
            stale => Plan::Fetch { stale },
        }
    }

    fn read_local(content: &ContentDb, reciter_id: u32, surah: u32) -> Option<StoredTimings> {
        match content.timings_get(reciter_id, surah) {
            Ok(t) => t,
            Err(e) => {
                log::warn!(
                    "audio: stored timings of reciter {reciter_id} surah {surah} unreadable: {e}"
                );
                None
            }
        }
    }

    fn conclude(
        reciter_id: u32,
        surah: u32,
        fetched: Result<StoredTimings, FetchFailure>,
        stale: Option<StoredTimings>,
    ) -> Result<StoredTimings, FetchFailure> {
        match (fetched, stale) {
            (Ok(t), _) => Ok(t),
            (Err(e), Some(stale)) => {
                log::info!(
                    "audio: timings of reciter {reciter_id} surah {surah} could not be refreshed ({}); using the stored copy",
                    e.app
                );
                Ok(stale)
            }
            (Err(e), None) => Err(e),
        }
    }

    /// One request per `(reciter, surah)` at a time: a caller that arrives while a fetch runs waits for it and shares
    /// its outcome, success or failure (the planner, a play's prefetch and `audio_get_timings` often want the same
    /// surah at once). The pack manager stores what it fetches, so a later caller finds it in content.db. If the
    /// caller running the fetch is dropped, a waiting caller runs it instead.
    async fn fetch_shared(
        &self,
        reciter_id: u32,
        surah: u32,
    ) -> Result<StoredTimings, FetchFailure> {
        let key = (reciter_id, surah);
        let flight = Arc::clone(lock(&self.flights).entry(key).or_default());
        let outcome = flight
            .get_or_init(|| async {
                self.fetcher
                    .fetch(reciter_id, surah)
                    .await
                    .map_err(|e| FetchFailure::new(reciter_id, surah, e))
            })
            .await
            .clone();
        // A finished flight leaves the table: the next miss (after a failure, or once the copy is stale) fetches anew.
        let mut flights = lock(&self.flights);
        if flights.get(&key).is_some_and(|f| Arc::ptr_eq(f, &flight)) {
            flights.remove(&key);
        }
        outcome
    }

    /// The fetch of `(reciter, surah)` ([`Self::fetch_shared`]) as a task of its own: it completes and stores what it
    /// fetched whether or not its caller still waits.
    fn spawn_fetch(
        self: &Arc<Self>,
        reciter_id: u32,
        surah: u32,
    ) -> tokio::task::JoinHandle<Result<StoredTimings, FetchFailure>> {
        let store = Arc::clone(self);
        self.rt
            .spawn(async move { store.fetch_shared(reciter_id, surah).await })
    }

    /// A finished fetch task's outcome (a task that panicked or was dropped by the runtime is an internal failure).
    fn joined(
        reciter_id: u32,
        surah: u32,
        joined: Result<Result<StoredTimings, FetchFailure>, tokio::task::JoinError>,
    ) -> Result<StoredTimings, FetchFailure> {
        joined.unwrap_or_else(|e| {
            Err(FetchFailure::new(
                reciter_id,
                surah,
                PackError::Io(std::io::Error::other(format!("timings fetch task: {e}"))),
            ))
        })
    }

    /// Blocking: `qd-audio-ctl` only (`block_on` on the pack manager). Stored and fresh → them; stored but stale → them
    /// at once, refreshed in the background (stale-while-revalidate: a play never waits for the network when its
    /// timings are on disk); missing → fetched, unless `cancel` (the play's) is cancelled first. The error is the
    /// planner's ([`timings_error`]); a cancelled play is [`AudioError::Cancelled`] (the fetch carries on and stores).
    fn get_blocking(
        self: &Arc<Self>,
        reciter_id: u32,
        surah: u32,
        cancel: &CancelToken,
    ) -> Result<StoredTimings, AudioError> {
        let stale = match self.plan(Self::read_local(&self.content, reciter_id, surah)) {
            Plan::Use(t) => return Ok(t),
            Plan::Fetch { stale } => stale,
        };
        if !(self.online)() {
            return stale.ok_or_else(|| timings_error(reciter_id, surah, &PackError::Offline));
        }
        if let Some(stale) = stale {
            log::debug!(
                "audio: timings of reciter {reciter_id} surah {surah} are stale; playing them while they are refreshed"
            );
            drop(self.spawn_fetch(reciter_id, surah));
            return Ok(stale);
        }
        let mut fetch = self.spawn_fetch(reciter_id, surah);
        let fetched = self.rt.block_on(async {
            tokio::select! {
                joined = &mut fetch => Some(joined),
                () = cancel.cancelled() => None,
            }
        });
        match fetched {
            Some(joined) => Self::conclude(
                reciter_id,
                surah,
                Self::joined(reciter_id, surah, joined),
                None,
            )
            .map_err(|f| f.planner),
            None => {
                log::debug!(
                    "audio: the play waiting for the timings of reciter {reciter_id} surah {surah} was superseded"
                );
                Err(AudioError::Cancelled)
            }
        }
    }

    /// Async: content.db on the blocking pool, the pack manager awaited. A stale copy is refreshed, but the caller
    /// waits at most [`REVALIDATE_GRACE`] for that before it gets the stored copy (the refresh carries on).
    async fn get(self: &Arc<Self>, reciter_id: u32, surah: u32) -> Result<StoredTimings, AppError> {
        let content = self.content.clone();
        let stored = self
            .rt
            .spawn_blocking(move || Self::read_local(&content, reciter_id, surah))
            .await
            .map_err(crate::util::internal)?;
        let stale = match self.plan(stored) {
            Plan::Use(t) => return Ok(t),
            Plan::Fetch { stale } => stale,
        };
        if !(self.online)() {
            return stale.ok_or_else(|| {
                AppError::Offline(format!(
                    "timings of reciter {reciter_id} surah {surah} are not stored and the network is unavailable"
                ))
            });
        }
        let mut fetch = self.spawn_fetch(reciter_id, surah);
        let joined = match stale {
            None => (&mut fetch).await,
            Some(stale) => match tokio::time::timeout(REVALIDATE_GRACE, &mut fetch).await {
                Ok(joined) => {
                    let fetched = Self::joined(reciter_id, surah, joined);
                    return Self::conclude(reciter_id, surah, fetched, Some(stale))
                        .map_err(|f| f.app);
                }
                Err(_) => {
                    log::debug!(
                        "audio: timings of reciter {reciter_id} surah {surah}: the stored copy while they are refreshed"
                    );
                    return Ok(stale);
                }
            },
        };
        Self::conclude(
            reciter_id,
            surah,
            Self::joined(reciter_id, surah, joined),
            None,
        )
        .map_err(|f| f.app)
    }

    /// A play's timings prefetch. The planner loads the timings of every surah of the range, one after the other,
    /// before the first sound (WP4b); for an uncached reciter each is a QDC round trip, so a play to the end of juz 30
    /// would wait for 38 of them. This fetches the missing or stale ones among `surahs` (in the planner's order, see
    /// [`planned_surahs`]) [`PREFETCH_CONCURRENCY`] at a time on the runtime, and the planner's own requests find them
    /// stored or join them in flight ([`TimingsStore::fetch_shared`]).
    ///
    /// Each call supersedes the previous one, which starts no further fetch. Nothing happens offline, for fewer than
    /// two surahs to fetch (the planner's own request is as fast), or after a failed fetch (the planner reports it).
    fn prefetch(self: &Arc<Self>, reciter_id: u32, surahs: Vec<u32>) {
        let generation = self
            .prefetch_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        if surahs.len() < 2 || !(self.online)() {
            return;
        }
        let store = Arc::clone(self);
        // Detached: it ends by itself, early once superseded.
        drop(
            self.rt
                .spawn(store.run_prefetch(generation, reciter_id, surahs)),
        );
    }

    async fn run_prefetch(self: Arc<Self>, generation: u64, reciter_id: u32, surahs: Vec<u32>) {
        let content = self.content.clone();
        let stamps = match self
            .rt
            .spawn_blocking(move || content.timing_stamps(Some(reciter_id)))
            .await
        {
            Ok(Ok(stamps)) => stamps,
            Ok(Err(e)) => {
                log::debug!("audio: no timings prefetch for reciter {reciter_id}: {e}");
                return;
            }
            Err(e) => {
                log::debug!("audio: no timings prefetch for reciter {reciter_id}: {e}");
                return;
            }
        };
        let now = now_ms();
        let fresh: HashSet<u32> = stamps
            .iter()
            .filter(|s| self.is_fresh(s.fetched_at_ms, now))
            .map(|s| s.surah)
            .collect();
        let needed: Vec<u32> = surahs
            .into_iter()
            .filter(|surah| !fresh.contains(surah))
            .collect();
        if needed.len() < 2 {
            return;
        }
        log::debug!(
            "audio: prefetching the timings of {} surahs of reciter {reciter_id}",
            needed.len()
        );
        let slots = Arc::new(tokio::sync::Semaphore::new(PREFETCH_CONCURRENCY));
        let failed = Arc::new(AtomicBool::new(false));
        for surah in needed {
            let Ok(slot) = Arc::clone(&slots).acquire_owned().await else {
                return;
            };
            if self.prefetch_generation.load(Ordering::Acquire) != generation
                || failed.load(Ordering::Acquire)
                || !(self.online)()
            {
                return;
            }
            let store = Arc::clone(&self);
            let failed = Arc::clone(&failed);
            drop(self.rt.spawn(async move {
                if let Err(e) = store.get(reciter_id, surah).await {
                    log::debug!(
                        "audio: timings prefetch of reciter {reciter_id} surah {surah} failed: {e}"
                    );
                    failed.store(true, Ordering::Release);
                }
                drop(slot);
            }));
        }
    }

    /// §2.3.7 rule 7: the server's file is not the one the timings were recorded against. Refetches the timings once
    /// per file through the pack manager ([`TimingsFetcher::refresh`]), which replaces the stored pair in one step, so
    /// the engine plans the play again against the server's file and its own timings; a pinned pair (an explicit
    /// download) is kept until the revalidator swaps file and timings together. Offline, nothing is attempted and a
    /// later mismatch tries again; a failed refresh may also be retried by a later play; a cancelled play stops
    /// waiting for it (the refresh carries on). Blocking: `qd-audio-ctl` only.
    fn on_file_mismatch(&self, key: &FileKey, cancel: &CancelToken) {
        let (reciter_id, surah) = (key.reciter_id, u32::from(key.surah));
        if !(self.online)() {
            log::info!(
                "audio: reciter {reciter_id} surah {surah}: the file differs from its timings; they are refetched once online"
            );
            return;
        }
        if !lock(&self.refetched).insert(key.clone()) {
            log::warn!(
                "audio: reciter {reciter_id} surah {surah}: the file still differs from its timings after a refetch"
            );
            return;
        }
        let refreshed = self.rt.block_on(async {
            tokio::select! {
                refreshed = self.fetcher.refresh(reciter_id, surah) => Some(refreshed),
                () = cancel.cancelled() => None,
            }
        });
        let Some(refreshed) = refreshed else {
            lock(&self.refetched).remove(key);
            log::debug!(
                "audio: reciter {reciter_id} surah {surah}: the play ended during the refetch"
            );
            return;
        };
        match refreshed {
            Ok(t) => log::info!(
                "audio: reciter {reciter_id} surah {surah}: timings refetched for the server's file ({:?} bytes)",
                t.file.content_length
            ),
            Err(e) => {
                lock(&self.refetched).remove(key);
                log::warn!(
                    "audio: reciter {reciter_id} surah {surah}: timings refetch failed: {}",
                    AppError::from(e)
                );
            }
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A timings failure for the planner: unreachable is `Offline` (so an uncached basmala is skipped, §2.3.3), a failed
/// download is `Source` (`network` over IPC), anything else `Timings`.
fn timings_error(reciter_id: u32, surah: u32, e: &PackError) -> AudioError {
    let what = format!("timings of reciter {reciter_id} surah {surah}");
    match e {
        PackError::Offline => AudioError::Offline(format!(
            "{what} are not stored and the network is unavailable"
        )),
        PackError::Network(err) if err.is_connect() || err.is_timeout() => {
            AudioError::Offline(format!("{what}: {e}"))
        }
        // The interactive budget ran out on a link that does not answer: unreachable, like a connect timeout.
        PackError::Timeout(_) => AudioError::Offline(format!("{what}: {e}")),
        PackError::Network(_) | PackError::Http { .. } => {
            AudioError::Source(format!("{what}: {e}"))
        }
        _ => AudioError::Timings(format!("{what}: {e}")),
    }
}

/// content.db's timings as the planner's [`SurahTimingSet`], bound to the exact file (`audio_url` + `Content-Length`).
fn timing_set(t: &StoredTimings) -> Result<SurahTimingSet, AudioError> {
    let surah = u16::try_from(t.file.surah)
        .map_err(|_| AudioError::Timings(format!("surah {} out of range", t.file.surah)))?;
    let ayahs = t
        .ayahs
        .iter()
        .map(|a| {
            Ok(AyahSpan {
                ayah: u16::try_from(a.ayah)
                    .map_err(|_| AudioError::Timings(format!("ayah {} out of range", a.ayah)))?,
                from_ms: a.from_ms,
                to_ms: a.to_ms,
                words: a
                    .words
                    .iter()
                    .map(|w| (w.pos, w.start_ms, w.end_ms))
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, AudioError>>()?;
    let last_to = t.ayahs.iter().map(|a| a.to_ms).max().unwrap_or(0);
    Ok(SurahTimingSet {
        reciter_id: t.file.reciter_id,
        surah,
        file: FileKey {
            reciter_id: t.file.reciter_id,
            surah,
            url: t.file.audio_url.clone(),
            expected_len: t.file.content_length,
        },
        duration_ms: t.file.duration_ms.unwrap_or(0).max(last_to),
        ayahs,
        word_level: t.word_level,
    })
}

/// `TimingsSource` over [`TimingsStore`] and the catalog. Runs on `qd-audio-ctl` only (§0.2).
struct GlueTimings {
    store: Arc<TimingsStore>,
    packs: PackManager,
}

impl TimingsSource for GlueTimings {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        self.surah_timings_for(reciter_id, surah, &CancelToken::new())
    }

    fn surah_timings_for(
        &self,
        reciter_id: u32,
        surah: u16,
        cancel: &CancelToken,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        debug_assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "TimingsSource runs on qd-audio-ctl only (§0.2)"
        );
        // Release builds: `block_on` inside a runtime would panic, and a panic aborts.
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(AudioError::Timings(
                "timings requested from async code (control thread only)".to_owned(),
            ));
        }
        let surah32 = u32::from(surah);
        if check_surah(surah32).is_err() {
            return Err(AudioError::Invalid(format!("surah {surah}")));
        }
        let stored = self.store.get_blocking(reciter_id, surah32, cancel)?;
        timing_set(&stored).map(Arc::new)
    }

    fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags {
        ReciterFlags {
            basmala_in_file: self
                .packs
                .reciter_meta(reciter_id)
                .is_some_and(|(_, in_file)| in_file),
        }
    }

    fn surah_ayah_count(&self, surah: u16) -> u16 {
        geometry::surah_ayah_count(u32::from(surah))
            .and_then(|n| u16::try_from(n).ok())
            .unwrap_or(0)
    }

    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        ayah_id_of(AyahRef {
            surah: u32::from(surah),
            ayah: u32::from(ayah),
        })
        .unwrap_or(0)
    }
}

/// `SourceProvider`: the caching HTTP source (or cached files only), plus the timings/file mismatch rule and the
/// stream cache's recency (`on_open`: `PackManager::audio_used`, so the cache evicts what was played longest ago).
struct GlueSources {
    inner: Box<dyn SourceProvider>,
    store: Arc<TimingsStore>,
    on_open: Box<dyn Fn(&FileKey) + Send + Sync>,
}

impl SourceProvider for GlueSources {
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError> {
        self.open_for(key, &CancelToken::new())
    }

    fn open_for(&self, key: &FileKey, cancel: &CancelToken) -> Result<OpenedSource, AudioError> {
        debug_assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "SourceProvider runs on qd-audio-ctl only (§0.2)"
        );
        let opened = self.inner.open_for(key, cancel);
        match &opened {
            Ok(_) => (self.on_open)(key),
            Err(AudioError::FileMismatch(_)) => self.store.on_file_mismatch(key, cancel),
            Err(_) => {}
        }
        opened
    }
}

/// `StreamRegistry` over the pack manager's single-writer registry (§2.5.5): a promoted stream is registered as a
/// cached (unpinned) file there.
struct GlueRegistry {
    packs: PackManager,
}

impl StreamRegistry for GlueRegistry {
    fn begin(&self, key: &FileKey) {
        self.packs
            .audio_stream_begin(key.reciter_id, u32::from(key.surah));
    }

    fn end(&self, key: &FileKey, promoted_bytes: Option<u64>) {
        self.packs
            .audio_stream_end(key.reciter_id, u32::from(key.surah), promoted_bytes);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Events, the UI sink and listen history.

/// State shared by the service and the engine's event sink.
struct GlueShared {
    emitter: Arc<dyn EventEmitter>,
    tick: TickSlot,
    worker: Worker,
    listen: Mutex<ListenTracker>,
    /// The layout of the current play (listen history pages).
    layout: Mutex<Option<MushafLayout>>,
    index: OnceLock<Arc<PlayIndex>>,
}

impl GlueShared {
    fn new(
        emitter: Arc<dyn EventEmitter>,
        user: UserDb,
        listen_min_ayah: Duration,
    ) -> Result<Self, AppError> {
        Ok(Self {
            worker: Worker::spawn(user, Arc::clone(&emitter))?,
            emitter,
            tick: TickSlot::default(),
            listen: Mutex::new(ListenTracker::new(listen_min_ayah)),
            layout: Mutex::new(None),
            index: OnceLock::new(),
        })
    }

    /// A new play: the page being listened to is recorded, pages are looked up in the new layout, and the new play is
    /// listen history unless it is a preview (`record: false`).
    fn begin_play(&self, layout: MushafLayout, record: bool) {
        let pending = lock(&self.listen).begin(record);
        self.worker.history(pending);
        *lock(&self.layout) = Some(layout);
    }

    fn page_of(&self, ayah_id: u32) -> Option<(MushafLayout, u32)> {
        let layout = (*lock(&self.layout))?;
        let page = self.index.get()?.page_of(layout, ayah_id)?;
        Some((layout, page))
    }
}

/// The engine's `EventSink`. Never blocks: events go to tauri's emitter, ticks to the channel, the UI sink and history
/// writes to the `qd-audio-glue` thread.
struct GlueEvents(Arc<GlueShared>);

impl EventSink for GlueEvents {
    fn tick(&self, t: &AudioTick) {
        let shared = &self.0;
        shared.tick.send(t);
        let heard = t.status == PlaybackStatus::Playing && !t.in_gap;
        let pending =
            lock(&shared.listen).on_tick(Instant::now(), heard, t.ayah_id, |id| shared.page_of(id));
        shared.worker.history(pending);
    }

    fn state(&self, s: &AudioSnapshot) {
        let shared = &self.0;
        emit(shared.emitter.as_ref(), &AudioStateChanged(s.clone()));
        shared.worker.post_ui(s.clone());
        if matches!(s.status, PlaybackStatus::Idle | PlaybackStatus::Error) {
            let pending = lock(&shared.listen).close();
            shared.worker.history(pending);
        }
    }

    fn ayah_changed(&self, c: &AyahChange) {
        emit(self.0.emitter.as_ref(), &AudioAyahChanged(*c));
    }

    fn error(&self, e: &AudioError) {
        log::warn!("audio engine: {e}");
    }
}

/// The `audio_subscribe` channel and its [`TickFilter`]; dropped when a send fails (the webview reloaded, §5.14).
#[derive(Default)]
struct TickSlot(Mutex<Option<(Channel<AudioTick>, TickFilter)>>);

impl TickSlot {
    fn set(&self, ch: Channel<AudioTick>) {
        *lock(&self.0) = Some((ch, TickFilter::default()));
    }

    fn send(&self, tick: &AudioTick) {
        let mut slot = lock(&self.0);
        if let Some((channel, filter)) = slot.as_mut()
            && filter.admit(tick, Instant::now())
            && let Err(e) = channel.send(tick.clone())
        {
            log::debug!("tick channel closed ({e}); dropping it until the next audio_subscribe");
            *slot = None;
        }
    }
}

/// Which of the engine's ticks (30 Hz while playing) reach the webview (§13.6 playback CPU: each one is an IPC message
/// and a turn of the page's event loop, and the UI needs far fewer). While playing, a tick goes through when it changes
/// something the UI shows at once (status, generation, surah, ayah, word, speed, gap), when its position is not where
/// the player's interpolation (§7.3: the last tick's position plus the wall time × speed; frozen in a gap) puts it within
/// [`TICK_DRIFT_MS`] (a repeat, an A-B wrap, a stall), and otherwise every [`TICK_RESYNC`]. Not playing, the engine
/// sends a tick per change only, and every one goes through. The first tick on a new channel always does.
#[derive(Debug, Default)]
pub(crate) struct TickFilter {
    last: Option<(AudioTick, Instant)>,
}

impl TickFilter {
    /// Whether `tick`, arriving at `now`, reaches the webview (and becomes the reference for the next ones).
    pub(crate) fn admit(&mut self, tick: &AudioTick, now: Instant) -> bool {
        let pass = match &self.last {
            None => true,
            Some((prev, at)) => {
                tick.status != PlaybackStatus::Playing
                    || prev.status != tick.status
                    || prev.generation != tick.generation
                    || prev.surah != tick.surah
                    || prev.ayah != tick.ayah
                    || prev.ayah_id != tick.ayah_id
                    || prev.word_pos != tick.word_pos
                    || prev.speed_pct != tick.speed_pct
                    || prev.in_gap != tick.in_gap
                    || now.saturating_duration_since(*at) >= TICK_RESYNC
                    || interpolation_error(prev, *at, tick, now) > TICK_DRIFT_MS
            }
        };
        if pass {
            self.last = Some((tick.clone(), now));
        }
        pass
    }
}

/// How far `tick` is (ms) from where the webview interpolates the position at `now`, from `prev` received at `at`.
fn interpolation_error(prev: &AudioTick, at: Instant, tick: &AudioTick, now: Instant) -> u64 {
    let expected = if prev.in_gap {
        u64::from(prev.file_ms)
    } else {
        let elapsed =
            u64::try_from(now.saturating_duration_since(at).as_millis()).unwrap_or(u64::MAX);
        u64::from(prev.file_ms)
            .saturating_add(elapsed.saturating_mul(u64::from(prev.speed_pct)) / 100)
    };
    u64::from(tick.file_ms).abs_diff(expected)
}

enum Job {
    /// Hand the latest posted snapshot to the UI sink.
    Ui,
    History(HistoryInput),
    Stop,
}

/// What the `qd-audio-glue` thread works with.
struct WorkerCtx {
    user: UserDb,
    emitter: Arc<dyn EventEmitter>,
    ui_sink: RwLock<Option<UiSinkFn>>,
    /// The newest snapshot not yet handed to the UI sink (snapshots coalesce: the UI only needs the latest).
    pending_ui: Mutex<Option<AudioSnapshot>>,
}

impl WorkerCtx {
    fn record(&self, entry: &HistoryInput) {
        match self.user.history_record(entry) {
            Ok(()) => {
                log::debug!(
                    "audio: listened to page {:?} ({:?}) for {} s",
                    entry.page,
                    entry.layout,
                    entry.dwell_s
                );
                emit(
                    self.emitter.as_ref(),
                    &UserDataChanged {
                        kinds: vec![UserDataKind::History],
                    },
                );
            }
            Err(e) => log::warn!("audio: listen history not recorded: {e}"),
        }
    }

    fn deliver_ui(&self) {
        let Some(snapshot) = lock(&self.pending_ui).take() else {
            return;
        };
        let sink = self
            .ui_sink
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(sink) = sink {
            sink(&snapshot);
        }
    }
}

/// The `qd-audio-glue` thread.
struct Worker {
    ctx: Arc<WorkerCtx>,
    tx: Mutex<Option<Sender<Job>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Worker {
    fn spawn(user: UserDb, emitter: Arc<dyn EventEmitter>) -> Result<Self, AppError> {
        let ctx = Arc::new(WorkerCtx {
            user,
            emitter,
            ui_sink: RwLock::new(None),
            pending_ui: Mutex::new(None),
        });
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("qd-audio-glue".to_owned())
            .spawn({
                let ctx = Arc::clone(&ctx);
                move || run_worker(&ctx, &rx)
            })
            .map_err(|e| AppError::Audio(format!("the audio glue thread cannot start: {e}")))?;
        Ok(Self {
            ctx,
            tx: Mutex::new(Some(tx)),
            thread: Mutex::new(Some(thread)),
        })
    }

    fn send(&self, job: Job) {
        if let Some(tx) = lock(&self.tx).as_ref()
            && tx.send(job).is_err()
        {
            log::debug!("audio glue thread is gone");
        }
    }

    fn set_ui_sink(&self, sink: UiSinkFn) {
        *self
            .ctx
            .ui_sink
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(sink);
    }

    /// Posts `snapshot` for the UI sink; a burst of edges delivers only the newest one.
    fn post_ui(&self, snapshot: AudioSnapshot) {
        let was_empty = lock(&self.ctx.pending_ui).replace(snapshot).is_none();
        if was_empty {
            self.send(Job::Ui);
        }
    }

    fn history(&self, entries: Vec<HistoryInput>) {
        for entry in entries {
            self.send(Job::History(entry));
        }
    }

    /// On the caller's thread (shutdown, after the engine stopped).
    fn record_now(&self, entry: &HistoryInput) {
        self.ctx.record(entry);
    }

    /// Stops the thread after the jobs already queued; waits at most `wait` (a sink blocked on the main thread while
    /// the main thread shuts down must not hang the exit). Idempotent.
    fn stop(&self, wait: Duration) {
        let Some(tx) = lock(&self.tx).take() else {
            return;
        };
        let _ = tx.send(Job::Stop);
        drop(tx);
        let Some(handle) = lock(&self.thread).take() else {
            return;
        };
        let deadline = Instant::now() + wait;
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        if handle.is_finished() {
            if handle.join().is_err() {
                log::error!("audio glue thread panicked");
            }
        } else {
            log::warn!("audio glue thread did not stop within {wait:?}; detached");
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Never joins here: dropping must not block.
        if let Some(tx) = lock(&self.tx).take() {
            let _ = tx.send(Job::Stop);
        }
    }
}

fn run_worker(ctx: &WorkerCtx, rx: &Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        match job {
            Job::Ui => ctx.deliver_ui(),
            Job::History(entry) => ctx.record(&entry),
            Job::Stop => break,
        }
    }
}

/// Listen history (§2.8.4): ticks while the recitation is heard accumulate per ayah and per page; the first ayah heard
/// for `min_ayah` records its page, then the rest of the visit is added when the page changes, the play ends or the
/// app quits (user.db merges records of the same page within 10 minutes, so a visit is one entry with its full dwell).
#[derive(Debug)]
pub(crate) struct ListenTracker {
    min_ayah: Duration,
    /// The current play is part of the listening (`PlayRequest::record`); a preview's ticks count for nothing.
    recording: bool,
    last_tick: Option<Instant>,
    /// The ayah being heard and how long.
    ayah: Option<(u32, Duration)>,
    visit: Option<PageVisit>,
}

#[derive(Debug, Clone, Copy)]
struct PageVisit {
    layout: MushafLayout,
    page: u32,
    ayah_id: u32,
    heard: Duration,
    qualified: bool,
    /// Seconds of `heard` already written.
    recorded_s: u32,
}

impl PageVisit {
    fn entry(&self, dwell_s: u32) -> HistoryInput {
        HistoryInput {
            mode: HistoryMode::Listen,
            layout: Some(self.layout),
            page: Some(self.page),
            ayah_id: self.ayah_id,
            dwell_s,
        }
    }
}

fn whole_secs(d: Duration) -> u32 {
    u32::try_from(d.as_secs()).unwrap_or(u32::MAX)
}

impl ListenTracker {
    pub(crate) fn new(min_ayah: Duration) -> Self {
        Self {
            min_ayah,
            recording: true,
            last_tick: None,
            ayah: None,
            visit: None,
        }
    }

    /// A new play: [`close`](Self::close)s the previous one's visit (its entries are returned) and counts the new
    /// play's ticks only when it is `record`ed.
    pub(crate) fn begin(&mut self, record: bool) -> Vec<HistoryInput> {
        let pending = self.close();
        self.recording = record;
        pending
    }

    /// One tick. `heard`: the recitation is audible (playing, not in a gap); `ayah_id` 0 is the basmala. Returns the
    /// entries to record.
    pub(crate) fn on_tick(
        &mut self,
        now: Instant,
        heard: bool,
        ayah_id: u32,
        page_of: impl FnOnce(u32) -> Option<(MushafLayout, u32)>,
    ) -> Vec<HistoryInput> {
        let elapsed = match (heard, self.last_tick) {
            (true, Some(prev)) => now.saturating_duration_since(prev).min(LISTEN_MAX_TICK_GAP),
            _ => Duration::ZERO,
        };
        self.last_tick = heard.then_some(now);
        let mut out = Vec::new();
        if !self.recording || !heard || ayah_id == 0 {
            return out;
        }
        let Some((layout, page)) = page_of(ayah_id) else {
            return out;
        };
        if self
            .visit
            .is_none_or(|v| v.layout != layout || v.page != page)
        {
            out.extend(self.close_visit());
            self.visit = Some(PageVisit {
                layout,
                page,
                ayah_id,
                heard: Duration::ZERO,
                qualified: false,
                recorded_s: 0,
            });
        }
        let ayah_heard = match &mut self.ayah {
            Some((id, heard)) if *id == ayah_id => {
                *heard += elapsed;
                *heard
            }
            slot => {
                *slot = Some((ayah_id, elapsed));
                elapsed
            }
        };
        if let Some(visit) = self.visit.as_mut() {
            visit.heard += elapsed;
            visit.ayah_id = ayah_id;
            let heard_s = whole_secs(visit.heard);
            if !visit.qualified {
                if ayah_heard >= self.min_ayah {
                    visit.qualified = true;
                    visit.recorded_s = heard_s;
                    out.push(visit.entry(heard_s));
                }
            } else if heard_s.saturating_sub(visit.recorded_s) >= LISTEN_CHECKPOINT_S {
                out.push(visit.entry(heard_s - visit.recorded_s));
                visit.recorded_s = heard_s;
            }
        }
        out
    }

    /// The play ended, stopped or was replaced: the rest of the visit, if any.
    pub(crate) fn close(&mut self) -> Vec<HistoryInput> {
        self.last_tick = None;
        self.ayah = None;
        self.close_visit().into_iter().collect()
    }

    fn close_visit(&mut self) -> Option<HistoryInput> {
        let visit = self.visit.take()?;
        let heard_s = whole_secs(visit.heard);
        (visit.qualified && heard_s > visit.recorded_s)
            .then(|| visit.entry(heard_s - visit.recorded_s))
    }
}

/// The app's event emitter, type-erased so the glue works with any tauri runtime (and a recorder in tests).
pub(crate) trait EventEmitter: Send + Sync {
    fn emit_value(&self, name: &str, payload: serde_json::Value);
}

impl<R: Runtime> EventEmitter for AppHandle<R> {
    fn emit_value(&self, name: &str, payload: serde_json::Value) {
        if let Err(e) = Emitter::emit(self, name, payload) {
            log::warn!("emit {name}: {e}");
        }
    }
}

/// Emits a typed event under tauri-specta's name for app events (`E::NAME`), without `Event::emit`'s registry lookup,
/// which panics when the registry is not mounted (and a panic aborts the release build, §0.2).
fn emit<E: Event + Serialize>(emitter: &dyn EventEmitter, event: &E) {
    match serde_json::to_value(event) {
        Ok(payload) => emitter.emit_value(E::NAME, payload),
        Err(e) => log::error!("serialise {}: {e}", E::NAME),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// OS media command conversions.

/// `Duration` → `u32` ms on the file timeline (saturating).
fn duration_ms(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX)
}

/// MPRIS `Seek` µs → `i32` ms (saturating).
fn delta_ms(delta_us: i64) -> i32 {
    let ms = delta_us / 1_000;
    i32::try_from(ms).unwrap_or(if ms < 0 { i32::MIN } else { i32::MAX })
}

/// An OS playback rate (1.0 = normal) → speed percent rounded to 5 % and clamped to 50..=200; NaN ⇒ 100.
fn speed_pct_from_rate(rate: f64) -> u32 {
    if !rate.is_finite() {
        return 100;
    }
    let steps = (rate * 20.0).round().clamp(0.0, 1_000.0);
    // `steps` is a finite integer in 0..=1000, so the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pct = steps as u32 * 5;
    SPEED_PCT.apply(pct)
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]
    // The engine tests run on the debug null sink only (never the audio device, LEAD item 9); their helpers are unused
    // in release test builds.
    #![cfg_attr(not(debug_assertions), allow(dead_code, unused_imports))]

    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use quran_core::{TimedAyah, TimingFile, WordSeg};
    use quran_packs::{PackEvents, PackManagerConfig};
    use quran_types::{DownloadEvent, HistoryEntry};
    use tempfile::TempDir;

    use super::*;

    // ---- fixtures ---------------------------------------------------------------------------------------------------

    /// A silent CBR MPEG-1 Layer III stream (44.1 kHz stereo, 128 kbit/s): `frames` frames of 1,152 samples, each 417
    /// bytes with zero side info, so it decodes to exact silence.
    pub(crate) fn silent_mp3(frames: usize) -> Vec<u8> {
        const FRAME_BYTES: usize = 417;
        let mut out = Vec::with_capacity(frames * FRAME_BYTES);
        for _ in 0..frames {
            out.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            out.resize(out.len() + FRAME_BYTES - 4, 0);
        }
        out
    }

    /// 115 frames ≈ 3,004 ms: room for seven 400 ms ayahs.
    pub(crate) const MP3_FRAMES: usize = 115;
    pub(crate) const AYAH_MS: u32 = 400;

    /// Timings of `surah` (every ayah 400 ms, two words) bound to a file of `len` bytes, fetched `age` ago.
    pub(crate) fn stored(reciter_id: u32, surah: u32, len: u64, age: Duration) -> StoredTimings {
        let count = geometry::surah_ayah_count(surah).unwrap();
        let fetched_at_ms = now_ms() - i64::try_from(age.as_millis()).unwrap();
        StoredTimings {
            file: TimingFile {
                reciter_id,
                surah,
                audio_url: format!("https://download.quranicaudio.com/test/{surah:03}.mp3"),
                content_length: Some(len),
                duration_ms: Some(count * AYAH_MS / 1000 * 1000),
                source: "qdc".into(),
                fetched_at_ms,
                etag: None,
                payload_sha256: "0".repeat(64),
            },
            ayahs: (1..=count)
                .map(|a| {
                    let from_ms = (a - 1) * AYAH_MS;
                    TimedAyah {
                        ayah: a,
                        from_ms,
                        to_ms: from_ms + AYAH_MS,
                        words: vec![
                            WordSeg {
                                pos: 1,
                                start_ms: from_ms,
                                end_ms: from_ms + AYAH_MS / 2,
                            },
                            WordSeg {
                                pos: 2,
                                start_ms: from_ms + AYAH_MS / 2,
                                end_ms: from_ms + AYAH_MS,
                            },
                        ],
                    }
                })
                .collect(),
            word_level: true,
        }
    }

    /// A `TimingsFetcher` like the pack manager's: stores what it fetches in content.db; can fail, and can take time
    /// like a round trip (`with_delay`), recording how many fetches overlapped.
    pub(crate) struct FixtureFetcher {
        content: ContentDb,
        len: u64,
        delay: Duration,
        calls: Mutex<Vec<(u32, u32)>>,
        refreshes: Mutex<Vec<(u32, u32)>>,
        fail: AtomicBool,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
    }

    impl FixtureFetcher {
        pub(crate) fn new(content: ContentDb, len: u64) -> Self {
            Self {
                content,
                len,
                delay: Duration::ZERO,
                calls: Mutex::new(Vec::new()),
                refreshes: Mutex::new(Vec::new()),
                fail: AtomicBool::new(false),
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
            }
        }

        /// Every fetch takes `delay` (a tokio sleep).
        pub(crate) fn with_delay(mut self, delay: Duration) -> Self {
            self.delay = delay;
            self
        }

        pub(crate) fn calls(&self) -> Vec<(u32, u32)> {
            lock(&self.calls).clone()
        }

        /// The `refresh` calls (rule 7), apart from the `fetch` calls.
        pub(crate) fn refreshes(&self) -> Vec<(u32, u32)> {
            lock(&self.refreshes).clone()
        }

        /// How many of the calls asked for `surah`.
        pub(crate) fn calls_of(&self, surah: u32) -> usize {
            lock(&self.calls)
                .iter()
                .filter(|(_, s)| *s == surah)
                .count()
        }

        pub(crate) fn in_flight(&self) -> usize {
            self.in_flight.load(Ordering::Acquire)
        }

        /// The most fetches that ran at once.
        pub(crate) fn max_in_flight(&self) -> usize {
            self.max_in_flight.load(Ordering::Acquire)
        }
    }

    impl TimingsFetcher for FixtureFetcher {
        fn fetch(&self, reciter_id: u32, surah: u32) -> FetchFuture<'_> {
            lock(&self.calls).push((reciter_id, surah));
            let running = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
            self.max_in_flight.fetch_max(running, Ordering::AcqRel);
            Box::pin(async move {
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                let result = if self.fail.load(Ordering::Acquire) {
                    Err(PackError::Http {
                        status: 503,
                        url: "https://api.qurancdn.com/test".into(),
                    })
                } else {
                    let t = stored(reciter_id, surah, self.len, Duration::ZERO);
                    self.content
                        .timings_put(&t, false)
                        .map(|()| t)
                        .map_err(PackError::from)
                };
                self.in_flight.fetch_sub(1, Ordering::AcqRel);
                result
            })
        }

        /// Like the pack manager's refresh of an unpinned pair: the stored timings are replaced by the server's.
        fn refresh(&self, reciter_id: u32, surah: u32) -> FetchFuture<'_> {
            lock(&self.refreshes).push((reciter_id, surah));
            Box::pin(async move {
                if self.fail.load(Ordering::Acquire) {
                    return Err(PackError::Offline);
                }
                let t = stored(reciter_id, surah, self.len, Duration::ZERO);
                self.content
                    .timings_put(&t, false)
                    .map(|()| t)
                    .map_err(PackError::from)
            })
        }
    }

    #[derive(Default)]
    pub(crate) struct Recorder {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl Recorder {
        pub(crate) fn named(&self, name: &str) -> Vec<serde_json::Value> {
            lock(&self.events)
                .iter()
                .filter(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .collect()
        }
    }

    impl EventEmitter for Recorder {
        fn emit_value(&self, name: &str, payload: serde_json::Value) {
            lock(&self.events).push((name.to_owned(), payload));
        }
    }

    struct NoPackEvents;

    impl PackEvents for NoPackEvents {
        fn download(&self, _e: DownloadEvent) {}
        fn packs_changed(&self, _pack_ids: Vec<String>) {}
        fn network(&self, _online: bool) {}
    }

    /// A synthetic index: every ayah 10 words; v2 pages start at the ayah starts of a fixed list, then every 150 words.
    pub(crate) fn synthetic_index() -> PlayIndex {
        let ayah_first_word: Vec<u32> = (0..AYAH_COUNT).map(|i| i * 10 + 1).collect();
        // Page 1 = 1:1–1:7 (words 1..=70), page 2 starts at 2:1 (word 71), then pages start mid-ayah.
        let mut pages = vec![1, 71];
        while pages.len() < 604 {
            pages.push(pages.last().unwrap() + 103);
        }
        PlayIndex {
            ayah_first_word,
            page_first_word: vec![(MushafLayout::V2, pages)],
            juz: (0..30)
                .map(|j| Division {
                    id: j + 1,
                    first_ayah_id: j * 208 + 1,
                    last_ayah_id: if j == 29 { AYAH_COUNT } else { (j + 1) * 208 },
                })
                .collect(),
        }
    }

    fn r(surah: u32, ayah: u32) -> AyahRef {
        AyahRef { surah, ayah }
    }

    pub(crate) fn request(
        from: AyahRef,
        to: Option<AyahRef>,
        stop_at: Option<StopAt>,
    ) -> PlayRequest {
        PlayRequest {
            reciter_id: 7,
            from,
            to,
            stop_at,
            layout: MushafLayout::V2,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            start_paused: false,
            record: true,
        }
    }

    fn wait_for(timeout: Duration, what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        while !cond() {
            assert!(
                Instant::now() < deadline,
                "timed out after {timeout:?}: {what}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    // ---- request resolution -----------------------------------------------------------------------------------------

    #[test]
    fn to_resolves_from_stop_at_and_the_settings_default() {
        let ix = synthetic_index();
        let resolve = |from, stop| {
            resolve_request(request(from, None, stop), Some(&ix), StopAt::EndOfSurah).unwrap()
        };

        let q = resolve(r(2, 255), Some(StopAt::EndOfSurah));
        assert_eq!(
            (q.to, q.stop_at),
            (Some(r(2, 286)), Some(StopAt::EndOfSurah))
        );
        assert_eq!(
            resolve(r(1, 1), None).to,
            Some(r(1, 7)),
            "None takes settings.stop_at"
        );
        assert_eq!(resolve(r(114, 1), None).to, Some(r(114, 6)));
        assert_eq!(
            resolve(r(1, 3), Some(StopAt::EndOfQuran)).to,
            Some(r(114, 6))
        );
        // Page 1 is 1:1–1:7; page 2 starts at 2:1 (word 71) and page 3 at word 174 = inside 2:11 (words 171..=180):
        // 2:11 starts on page 2, so page 2 ends with it.
        assert_eq!(resolve(r(1, 4), Some(StopAt::EndOfPage)).to, Some(r(1, 7)));
        assert_eq!(resolve(r(2, 1), Some(StopAt::EndOfPage)).to, Some(r(2, 11)));
        assert_eq!(
            resolve(r(2, 12), Some(StopAt::EndOfPage)).to,
            Some(r(2, 21))
        );
        // Juz 1 = ayahs 1..=208 in the synthetic index (2:201), the last juz ends the Quran.
        assert_eq!(resolve(r(1, 1), Some(StopAt::EndOfJuz)).to, Some(r(2, 201)));
        assert_eq!(
            resolve(r(114, 2), Some(StopAt::EndOfJuz)).to,
            Some(r(114, 6))
        );
        // The last page ends the Quran.
        assert_eq!(
            resolve(r(114, 6), Some(StopAt::EndOfPage)).to,
            Some(r(114, 6))
        );
        // An explicit `to` wins and keeps the request's stop_at.
        let q = resolve_request(
            request(r(2, 1), Some(r(3, 5)), None),
            Some(&ix),
            StopAt::EndOfJuz,
        )
        .unwrap();
        assert_eq!((q.to, q.stop_at), (Some(r(3, 5)), None));
    }

    #[test]
    fn page_ends_agree_with_a_brute_force_scan() {
        let ix = synthetic_index();
        let pages = ix.pages(MushafLayout::V2).unwrap().to_vec();
        // Index = ayah id − 1.
        let page_by_ayah: Vec<u32> = (1..=AYAH_COUNT)
            .map(|id| {
                let w = ix.first_word(id).unwrap();
                pages.iter().filter(|&&f| f <= w).count() as u32
            })
            .collect();
        for id in 1..=AYAH_COUNT {
            let page = page_by_ayah[(id - 1) as usize];
            assert_eq!(ix.page_of(MushafLayout::V2, id), Some(page), "ayah {id}");
            let mut end = id;
            while end < AYAH_COUNT && page_by_ayah[end as usize] == page {
                end += 1;
            }
            assert_eq!(ix.end_of_page(MushafLayout::V2, id), Some(end), "ayah {id}");
        }
        assert_eq!(
            ix.page_of(MushafLayout::V1, 1),
            None,
            "a layout the index lacks"
        );
        assert_eq!(ix.page_of(MushafLayout::V2, 0), None);
        assert_eq!(ix.page_of(MushafLayout::V2, AYAH_COUNT + 1), None);
    }

    #[test]
    fn bad_requests_are_invalid_arguments() {
        let ix = synthetic_index();
        let bad =
            |req: PlayRequest| resolve_request(req, Some(&ix), StopAt::EndOfSurah).unwrap_err();
        for (req, what) in [
            (request(r(1, 0), None, None), "ayah 0"),
            (request(r(1, 8), None, None), "1:8"),
            (request(r(0, 1), None, None), "surah 0"),
            (request(r(115, 1), None, None), "surah 115"),
            (request(r(2, 5), Some(r(2, 4)), None), "reversed"),
            (request(r(2, 5), Some(r(2, 287)), None), "to past the surah"),
            (
                PlayRequest {
                    ayah_repeat: 100,
                    ..request(r(1, 1), None, None)
                },
                "ayah repeat",
            ),
            (
                PlayRequest {
                    range_repeat: 1_000,
                    ..request(r(1, 1), None, None)
                },
                "range repeat",
            ),
            (
                PlayRequest {
                    gap: GapSetting::Fixed { ms: 30_001 },
                    ..request(r(1, 1), None, None)
                },
                "gap",
            ),
            (
                PlayRequest {
                    gap: GapSetting::Multiplier { pct: 301 },
                    ..request(r(1, 1), None, None)
                },
                "multiplier",
            ),
        ] {
            assert!(matches!(bad(req), AppError::InvalidArgument(_)), "{what}");
        }
        // Bounds are inclusive; 0 = infinite.
        let ok = PlayRequest {
            ayah_repeat: 0,
            range_repeat: 99,
            gap: GapSetting::Multiplier { pct: 300 },
            ..request(r(1, 1), Some(r(114, 6)), None)
        };
        assert!(resolve_request(ok, Some(&ix), StopAt::EndOfSurah).is_ok());
        // Page and juz ends need the index; surah and Quran ends do not.
        let page = resolve_request(
            request(r(1, 1), None, Some(StopAt::EndOfPage)),
            None,
            StopAt::EndOfSurah,
        );
        assert!(matches!(page, Err(AppError::NotFound(_))), "{page:?}");
        assert!(needs_index(&request(r(1, 1), None, None), StopAt::EndOfJuz));
        assert!(!needs_index(
            &request(r(1, 1), Some(r(1, 2)), None),
            StopAt::EndOfJuz
        ));
        let surah =
            resolve_request(request(r(9, 3), None, None), None, StopAt::EndOfSurah).unwrap();
        assert_eq!(surah.to, Some(r(9, 129)));
    }

    #[test]
    fn ayah_ids_and_counts_follow_the_canonical_geometry() {
        assert_eq!(ayah_id_of(r(1, 1)), Some(1));
        assert_eq!(ayah_id_of(r(2, 1)), Some(8));
        assert_eq!(ayah_id_of(r(2, 286)), Some(293));
        assert_eq!(ayah_id_of(r(114, 6)), Some(AYAH_COUNT));
        assert_eq!(ayah_id_of(r(2, 287)), None);
        assert_eq!(ayah_id_of(r(1, 0)), None);
        assert_eq!(ayah_ref_of(293), Some(r(2, 286)));
        assert!(check_speed(125).is_ok() && check_speed(127).is_err() && check_speed(45).is_err());
        assert!(check_speed(50).is_ok() && check_speed(200).is_ok() && check_speed(205).is_err());
    }

    /// Cross-checks the index-based page arithmetic against core.db's own SQL (skipped without a built core.db).
    #[test]
    fn page_and_juz_ends_match_the_real_core() {
        let Some(path) = crate::setup::tests::real_core_db() else {
            return;
        };
        let core = CoreDb::open(&path).unwrap();
        let ix = PlayIndex::from_index(&core.index().unwrap()).unwrap();
        let id = |s, a| ayah_id_of(r(s, a)).unwrap();
        assert_eq!(
            ix.end_of_page(MushafLayout::V2, 1),
            Some(7),
            "page 1 is al-Fatihah"
        );
        assert_eq!(
            ix.end_of_page(MushafLayout::V2, id(2, 1)),
            Some(id(2, 5)),
            "page 2 is 2:1–2:5"
        );
        assert_eq!(ix.page_of(MushafLayout::V2, AYAH_COUNT), Some(604));
        assert_eq!(
            ix.end_of_page(MushafLayout::V2, AYAH_COUNT),
            Some(AYAH_COUNT)
        );
        assert_eq!(ix.end_of_juz(1), Some(id(2, 141)), "juz 1 ends at 2:141");
        assert_eq!(ix.end_of_juz(id(78, 1)), Some(AYAH_COUNT), "juz 30");
        for layout in MushafLayout::ALL {
            for ayah_id in (1..=AYAH_COUNT).step_by(53).chain([AYAH_COUNT]) {
                let page = ix.page_of(layout, ayah_id).unwrap();
                assert_eq!(
                    page,
                    core.page_of_ayah(layout, ayah_id).unwrap(),
                    "{layout:?} ayah {ayah_id}"
                );
                let end = ix.end_of_page(layout, ayah_id).unwrap();
                assert!(end >= ayah_id);
                assert_eq!(
                    core.page_of_ayah(layout, end).unwrap(),
                    page,
                    "{layout:?} end {end}"
                );
                if end < AYAH_COUNT {
                    assert!(
                        core.page_of_ayah(layout, end + 1).unwrap() > page,
                        "{layout:?} after {end}"
                    );
                }
            }
        }
    }

    // ---- listen history ---------------------------------------------------------------------------------------------

    fn page_of(id: u32) -> Option<(MushafLayout, u32)> {
        synthetic_index()
            .page_of(MushafLayout::V2, id)
            .map(|p| (MushafLayout::V2, p))
    }

    /// Feeds `ticks` ticks of `ayah_id`, 100 ms apart, after `*t`.
    fn listen(
        tr: &mut ListenTracker,
        t: &mut Instant,
        ayah_id: u32,
        heard: bool,
        ticks: u32,
    ) -> Vec<HistoryInput> {
        let mut out = Vec::new();
        for _ in 0..ticks {
            *t += Duration::from_millis(100);
            out.extend(tr.on_tick(*t, heard, ayah_id, page_of));
        }
        out
    }

    #[test]
    fn an_ayah_heard_for_three_seconds_records_its_page_once_per_visit() {
        let mut tr = ListenTracker::new(LISTEN_MIN_AYAH);
        let mut t = Instant::now();
        // The basmala (ayah 0) and a short ayah do not count.
        assert!(listen(&mut tr, &mut t, 0, true, 50).is_empty());
        assert!(
            listen(&mut tr, &mut t, 1, true, 25).is_empty(),
            "1:1 heard 2.5 s"
        );
        // 1:2 reaches 3 s: page 1 is recorded with the time heard on it so far (2.5 + 3.0 s).
        let first = listen(&mut tr, &mut t, 2, true, 30);
        assert_eq!(first.len(), 1, "{first:?}");
        assert_eq!(
            (
                first[0].mode,
                first[0].layout,
                first[0].page,
                first[0].ayah_id,
                first[0].dwell_s
            ),
            (HistoryMode::Listen, Some(MushafLayout::V2), Some(1), 2, 5)
        );
        // More ayahs on the same page: nothing new until the visit ends (9.5 s heard on page 1).
        assert!(listen(&mut tr, &mut t, 3, true, 40).is_empty());
        // 2:1 is on page 2: the rest of page 1's visit (9 − 5 s) is added; page 2 is not qualified yet.
        let turn = listen(&mut tr, &mut t, 8, true, 10);
        assert_eq!(turn.len(), 1, "{turn:?}");
        assert_eq!(
            (turn[0].page, turn[0].ayah_id, turn[0].dwell_s),
            (Some(1), 3, 4)
        );
        // Paused time does not count; 2:1 then reaches 3 s (1 + 2 s) and qualifies page 2.
        assert!(listen(&mut tr, &mut t, 8, false, 100).is_empty());
        let p2 = listen(&mut tr, &mut t, 8, true, 21);
        assert_eq!(p2.len(), 1, "{p2:?}");
        assert_eq!((p2[0].page, p2[0].ayah_id, p2[0].dwell_s), (Some(2), 8, 3));
        // The play ends after 1.5 s of 2:2: the rest of page 2's visit (4 − 3 s).
        assert!(listen(&mut tr, &mut t, 9, true, 15).is_empty());
        let end = tr.close();
        assert_eq!(end.len(), 1, "{end:?}");
        assert_eq!(
            (end[0].page, end[0].ayah_id, end[0].dwell_s),
            (Some(2), 9, 1)
        );
        assert!(tr.close().is_empty(), "closing twice records nothing");
    }

    #[test]
    fn short_visits_gaps_and_stalls_are_not_listening() {
        let mut tr = ListenTracker::new(LISTEN_MIN_AYAH);
        let mut t = Instant::now();
        // Ayahs of 1 s each never qualify their page.
        for id in 1..=7 {
            assert!(listen(&mut tr, &mut t, id, true, 10).is_empty());
        }
        assert!(tr.close().is_empty());
        // A 10 s hole between two ticks counts as 0.5 s at most.
        let mut tr = ListenTracker::new(LISTEN_MIN_AYAH);
        assert!(tr.on_tick(t, true, 1, page_of).is_empty());
        t += Duration::from_secs(10);
        assert!(
            tr.on_tick(t, true, 1, page_of).is_empty(),
            "a stall is not 10 s of listening"
        );
        // An ayah without a page (no index) is ignored.
        let mut tr = ListenTracker::new(Duration::ZERO);
        assert!(tr.on_tick(t, true, 5, |_| None).is_empty());
    }

    #[test]
    fn a_preview_is_not_listening_and_the_next_play_is() {
        let mut tr = ListenTracker::new(LISTEN_MIN_AYAH);
        let mut t = Instant::now();
        // A play heard for 4 s qualifies page 1; the preview that replaces it adds the rest of that visit only.
        assert_eq!(listen(&mut tr, &mut t, 1, true, 40).len(), 1);
        listen(&mut tr, &mut t, 1, true, 20);
        let rest = tr.begin(false);
        assert_eq!(
            rest.iter().map(|e| (e.page, e.dwell_s)).collect::<Vec<_>>(),
            vec![(Some(1), 2)]
        );
        // The preview: 1:1 heard for 10 s records nothing, not even when it ends.
        assert!(listen(&mut tr, &mut t, 1, true, 100).is_empty());
        assert!(tr.begin(true).is_empty(), "the preview left no visit");
        // The next play counts again.
        let next = listen(&mut tr, &mut t, 8, true, 31);
        assert_eq!(
            next.iter().map(|e| (e.page, e.dwell_s)).collect::<Vec<_>>(),
            vec![(Some(2), 3)]
        );
    }

    #[test]
    fn a_long_visit_is_checkpointed() {
        let mut tr = ListenTracker::new(LISTEN_MIN_AYAH);
        let mut t = Instant::now();
        // One ayah on repeat for 11 minutes (6,601 ticks: the first counts 0 s): recorded at 3 s, then every
        // 5 minutes (user.db merges them into one entry).
        let entries = listen(&mut tr, &mut t, 1, true, 6_601);
        let dwell: Vec<u32> = entries.iter().map(|e| e.dwell_s).collect();
        assert_eq!(dwell, vec![3, 300, 300], "{dwell:?}");
        let rest: Vec<u32> = tr.close().iter().map(|e| e.dwell_s).collect();
        assert_eq!(rest, vec![660 - 603]);
    }

    // ---- timings ----------------------------------------------------------------------------------------------------

    struct Store {
        _dir: TempDir,
        content: ContentDb,
        fetcher: Arc<FixtureFetcher>,
        online: Arc<AtomicBool>,
        store: Arc<TimingsStore>,
    }

    impl TimingsStore {
        /// [`TimingsStore::get_blocking`] for a play that is never cancelled.
        fn get_blocking_now(
            self: &Arc<Self>,
            reciter_id: u32,
            surah: u32,
        ) -> Result<StoredTimings, AudioError> {
            self.get_blocking(reciter_id, surah, &CancelToken::new())
        }
    }

    fn store() -> Store {
        store_with_delay(Duration::ZERO)
    }

    /// A store whose fetches each take `delay`.
    fn store_with_delay(delay: Duration) -> Store {
        let dir = TempDir::new().unwrap();
        let content = ContentDb::open(&dir.path().join("content.db")).unwrap();
        let fetcher = Arc::new(FixtureFetcher::new(content.clone(), 50_000).with_delay(delay));
        let online = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&online);
        let store = Arc::new(TimingsStore::new(
            content.clone(),
            Arc::clone(&fetcher) as Arc<dyn TimingsFetcher>,
            Arc::new(move || flag.load(Ordering::Acquire)),
            tauri::async_runtime::handle().inner().clone(),
        ));
        Store {
            _dir: dir,
            content,
            fetcher,
            online,
            store,
        }
    }

    #[test]
    fn fresh_stored_timings_are_used_without_a_fetch() {
        let s = store();
        s.content
            .timings_put(&stored(7, 2, 9, Duration::from_secs(3_600)), false)
            .unwrap();
        let t = s.store.get_blocking_now(7, 2).unwrap();
        assert_eq!(t.file.content_length, Some(9));
        assert!(s.fetcher.calls().is_empty());
        let dto = tauri::async_runtime::block_on(s.store.get(7, 2))
            .unwrap()
            .to_dto();
        assert_eq!((dto.surah, dto.ayahs.len()), (2, 286));
        assert!(s.fetcher.calls().is_empty());
    }

    #[test]
    fn missing_timings_are_fetched_and_stale_ones_refreshed() {
        let s = store();
        let t = s.store.get_blocking_now(7, 1).unwrap();
        assert_eq!(t.file.content_length, Some(50_000));
        assert_eq!(s.fetcher.calls(), vec![(7, 1)]);
        // The fetch stored them: the next lookup is local.
        s.store.get_blocking_now(7, 1).unwrap();
        assert_eq!(s.fetcher.calls().len(), 1);
        // Eight days old: played at once (stale-while-revalidate), refreshed in the background.
        s.content
            .timings_put(&stored(7, 3, 7, Duration::from_secs(8 * 86_400)), false)
            .unwrap();
        assert_eq!(
            s.store.get_blocking_now(7, 3).unwrap().file.content_length,
            Some(7)
        );
        wait_for(Duration::from_secs(5), "the background refresh", || {
            s.content
                .timings_get(7, 3)
                .unwrap()
                .is_some_and(|t| t.file.content_length == Some(50_000))
        });
        assert_eq!(s.fetcher.calls().last(), Some(&(7, 3)));
        assert_eq!(
            s.store.get_blocking_now(7, 3).unwrap().file.content_length,
            Some(50_000)
        );
    }

    /// A play never waits for the network when its timings are on disk, however slow the link: stale timings come at
    /// once. `audio_get_timings` waits a moment for the refresh (`REVALIDATE_GRACE`), then takes the stored copy.
    #[test]
    fn stale_timings_never_wait_for_a_slow_refresh() {
        let s = store_with_delay(REVALIDATE_GRACE + Duration::from_secs(2));
        s.content
            .timings_put(&stored(7, 10, 12, Duration::from_secs(9 * 86_400)), false)
            .unwrap();
        let t = Instant::now();
        assert_eq!(
            s.store.get_blocking_now(7, 10).unwrap().file.content_length,
            Some(12)
        );
        assert!(
            t.elapsed() < Duration::from_millis(500),
            "{:?}",
            t.elapsed()
        );
        let t = Instant::now();
        let got = tauri::async_runtime::block_on(s.store.get(7, 10)).unwrap();
        assert_eq!(got.file.content_length, Some(12));
        let waited = t.elapsed();
        assert!(
            waited >= REVALIDATE_GRACE && waited < REVALIDATE_GRACE + Duration::from_secs(1),
            "{waited:?}"
        );
        assert_eq!(s.fetcher.calls_of(10), 1, "one refresh, shared");
        wait_for(Duration::from_secs(10), "the refresh stored", || {
            s.content
                .timings_get(7, 10)
                .unwrap()
                .is_some_and(|t| t.file.content_length == Some(50_000))
        });
        // A quick refresh is waited for by the command.
        let s = store_with_delay(Duration::from_millis(50));
        s.content
            .timings_put(&stored(7, 11, 13, Duration::from_secs(9 * 86_400)), false)
            .unwrap();
        let got = tauri::async_runtime::block_on(s.store.get(7, 11)).unwrap();
        assert_eq!(got.file.content_length, Some(50_000));
    }

    /// The planner waiting for timings that are not stored gives up as soon as its play is cancelled (a newer play, a
    /// stop); the fetch carries on and stores them for the next attempt.
    #[test]
    fn a_cancelled_play_stops_waiting_for_its_timings() {
        let s = store_with_delay(Duration::from_secs(2));
        let token = CancelToken::new();
        let waiting = {
            let (store, token) = (Arc::clone(&s.store), token.clone());
            std::thread::spawn(move || {
                let t = Instant::now();
                (store.get_blocking(7, 12, &token), t.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(150));
        token.cancel();
        let (result, waited) = waiting.join().unwrap();
        assert_eq!(result.unwrap_err(), AudioError::Cancelled);
        assert!(waited < Duration::from_millis(700), "{waited:?}");
        wait_for(
            Duration::from_secs(10),
            "the fetch stored them anyway",
            || s.content.timings_get(7, 12).unwrap().is_some(),
        );
        assert_eq!(s.fetcher.calls_of(12), 1);
    }

    #[test]
    fn stale_timings_are_kept_when_a_refresh_fails_or_the_network_is_off() {
        let s = store();
        s.content
            .timings_put(&stored(7, 4, 11, Duration::from_secs(30 * 86_400)), false)
            .unwrap();
        s.fetcher.fail.store(true, Ordering::Release);
        assert_eq!(
            s.store.get_blocking_now(7, 4).unwrap().file.content_length,
            Some(11)
        );
        wait_for(
            Duration::from_secs(5),
            "the background refresh attempt",
            || s.fetcher.calls().len() == 1 && s.fetcher.in_flight() == 0,
        );
        s.online.store(false, Ordering::Release);
        assert_eq!(
            s.store.get_blocking_now(7, 4).unwrap().file.content_length,
            Some(11)
        );
        assert_eq!(s.fetcher.calls().len(), 1, "offline: no fetch attempt");
        let async_stale = tauri::async_runtime::block_on(s.store.get(7, 4)).unwrap();
        assert_eq!(async_stale.file.content_length, Some(11));
    }

    #[test]
    fn missing_timings_offline_are_offline_errors() {
        let s = store();
        s.online.store(false, Ordering::Release);
        let e = s.store.get_blocking_now(7, 5).unwrap_err();
        assert!(matches!(e, AudioError::Offline(_)), "{e:?}");
        let app = tauri::async_runtime::block_on(s.store.get(7, 5)).unwrap_err();
        assert!(matches!(app, AppError::Offline(_)), "{app:?}");
        assert!(s.fetcher.calls().is_empty());
        // Online but failing, with nothing stored: the fetch error.
        s.online.store(true, Ordering::Release);
        s.fetcher.fail.store(true, Ordering::Release);
        let e = s.store.get_blocking_now(7, 5).unwrap_err();
        assert!(matches!(e, AudioError::Source(_)), "{e:?}");
        let app = tauri::async_runtime::block_on(s.store.get(7, 5)).unwrap_err();
        assert!(matches!(app, AppError::Network(_)), "{app:?}");
    }

    #[test]
    fn timing_errors_map_for_the_planner() {
        assert!(matches!(
            timings_error(7, 1, &PackError::Offline),
            AudioError::Offline(_)
        ));
        // A link that never answered within the interactive budget is unreachable (an uncached basmala is skipped).
        assert!(matches!(
            timings_error(7, 1, &PackError::Timeout("no response".into())),
            AudioError::Offline(_)
        ));
        assert!(matches!(
            timings_error(
                7,
                1,
                &PackError::Http {
                    status: 500,
                    url: "u".into()
                }
            ),
            AudioError::Source(_)
        ));
        for e in [
            PackError::Unsupported("no timings source for this reciter".into()),
            PackError::NotFound("reciter 99".into()),
            PackError::Integrity("bad".into()),
            PackError::Cancelled,
        ] {
            assert!(
                matches!(timings_error(7, 1, &e), AudioError::Timings(_)),
                "{e:?}"
            );
        }
        // A shared failure carries both forms.
        let f = FetchFailure::new(
            7,
            1,
            PackError::Http {
                status: 404,
                url: "u".into(),
            },
        );
        assert!(matches!(f.planner, AudioError::Source(_)), "{f:?}");
        assert!(matches!(f.app, AppError::NotFound(_)), "{f:?}");
    }

    #[test]
    fn overlapping_fetches_of_a_surah_share_one_request_and_its_outcome() {
        let s = store_with_delay(Duration::from_millis(300));
        // The planner (a plain thread), two command calls and a prefetch-like task all want surah 3 at once.
        let rt = tauri::async_runtime::handle().inner().clone();
        let tasks: Vec<_> = (0..3)
            .map(|_| {
                let store = Arc::clone(&s.store);
                rt.spawn(async move { store.get(7, 3).await })
            })
            .collect();
        let planner = {
            let store = Arc::clone(&s.store);
            std::thread::spawn(move || store.get_blocking_now(7, 3))
        };
        for task in tasks {
            let t = tauri::async_runtime::block_on(task).unwrap().unwrap();
            assert_eq!(t.file.surah, 3);
        }
        assert_eq!(planner.join().unwrap().unwrap().file.surah, 3);
        assert_eq!(s.fetcher.calls(), vec![(7, 3)], "one request");
        // Done: the next lookup is local, and a later miss fetches anew.
        s.store.get_blocking_now(7, 3).unwrap();
        assert_eq!(s.fetcher.calls().len(), 1);
        assert!(lock(&s.store.flights).is_empty(), "finished flights leave");

        // A failure is shared too: one request, every caller gets it.
        s.fetcher.fail.store(true, Ordering::Release);
        let tasks: Vec<_> = (0..3)
            .map(|_| {
                let store = Arc::clone(&s.store);
                rt.spawn(async move { store.get(7, 4).await })
            })
            .collect();
        for task in tasks {
            let e = tauri::async_runtime::block_on(task).unwrap().unwrap_err();
            assert!(matches!(e, AppError::Network(_)), "{e:?}");
        }
        assert_eq!(s.fetcher.calls_of(4), 1);
        // The failure is not cached: the next request tries again.
        assert!(matches!(
            s.store.get_blocking_now(7, 4),
            Err(AudioError::Source(_))
        ));
        assert_eq!(s.fetcher.calls_of(4), 2);
    }

    #[test]
    fn planned_surahs_follow_the_planner() {
        let plan = |from: AyahRef, to: AyahRef, in_file: bool| {
            planned_surahs(&request(from, Some(to), None), in_file)
        };
        // Mid-surah: no basmala.
        assert_eq!(plan(r(2, 255), r(2, 286), false), vec![2]);
        // From ayah 1: the basmala comes from surah 1, loaded right after the first surah.
        assert_eq!(plan(r(112, 1), r(114, 6), false), vec![112, 1, 113, 114]);
        assert_eq!(plan(r(112, 2), r(114, 6), false), vec![112, 113, 1, 114]);
        // Al-Fatihah is surah 1 itself; at-Tawbah has no basmala.
        assert_eq!(plan(r(1, 1), r(2, 5), false), vec![1, 2]);
        assert_eq!(plan(r(8, 70), r(9, 5), false), vec![8, 9]);
        assert_eq!(plan(r(9, 1), r(10, 3), false), vec![9, 10, 1]);
        // Files that carry their basmala need no surah 1.
        assert_eq!(plan(r(112, 1), r(114, 6), true), vec![112, 113, 114]);
        // Juz 30 from 78:1: 37 surahs and surah 1.
        let juz30 = plan(r(78, 1), r(114, 6), false);
        assert_eq!(juz30.len(), 38);
        assert_eq!(&juz30[..3], &[78, 1, 79]);
        assert!(planned_surahs(&request(r(1, 1), None, None), false).is_empty());
    }

    /// Waits until the fetcher has been idle for a moment (no fetch running, none started).
    fn settle(fetcher: &FixtureFetcher) {
        let mut seen = usize::MAX;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let calls = fetcher.calls().len();
            if calls == seen && fetcher.in_flight() == 0 {
                return;
            }
            seen = calls;
            assert!(Instant::now() < deadline, "the fetcher never settled");
            std::thread::sleep(Duration::from_millis(400));
        }
    }

    #[test]
    fn a_prefetch_fetches_what_the_planner_will_load_a_few_at_a_time() {
        let s = store_with_delay(Duration::from_millis(400));
        // 79 is stored and fresh, 80 is stale.
        s.content
            .timings_put(&stored(7, 79, 1, Duration::ZERO), false)
            .unwrap();
        s.content
            .timings_put(&stored(7, 80, 1, Duration::from_secs(8 * 86_400)), false)
            .unwrap();
        let wanted = vec![78, 1, 79, 80, 81, 82, 83, 84, 85, 86];
        s.store.prefetch(7, wanted);
        wait_for(Duration::from_secs(20), "the prefetch", || {
            s.fetcher.calls().len() == 9 && s.fetcher.in_flight() == 0
        });
        settle(&s.fetcher);
        let mut fetched: Vec<u32> = s.fetcher.calls().iter().map(|(_, surah)| *surah).collect();
        // In the planner's order: the first four needed go first (79 is fresh).
        let mut first: Vec<u32> = fetched[..PREFETCH_CONCURRENCY].to_vec();
        first.sort_unstable();
        assert_eq!(first, vec![1, 78, 80, 81], "{fetched:?}");
        fetched.sort_unstable();
        assert_eq!(fetched, vec![1, 78, 80, 81, 82, 83, 84, 85, 86]);
        assert_eq!(
            s.fetcher.max_in_flight(),
            PREFETCH_CONCURRENCY,
            "a few at a time"
        );
        // The planner now finds every surah stored.
        for surah in [78, 1, 79, 80, 86] {
            s.store.get_blocking_now(7, surah).unwrap();
        }
        assert_eq!(s.fetcher.calls().len(), 9);
    }

    #[test]
    fn the_planner_joins_a_prefetch_in_flight() {
        // Each round trip takes 500 ms: one after the other they would take at least 1 s.
        let s = store_with_delay(Duration::from_millis(500));
        let started = Instant::now();
        s.store.prefetch(7, vec![20, 1]);
        // Like qd-audio-ctl right after the play: surah 20, then the basmala's surah 1.
        assert_eq!(s.store.get_blocking_now(7, 20).unwrap().file.surah, 20);
        assert_eq!(s.store.get_blocking_now(7, 1).unwrap().file.surah, 1);
        let elapsed = started.elapsed();
        settle(&s.fetcher);
        assert_eq!((s.fetcher.calls_of(20), s.fetcher.calls_of(1)), (1, 1));
        assert!(
            elapsed < Duration::from_millis(950),
            "the two round trips overlapped: {elapsed:?}"
        );
    }

    #[test]
    fn a_prefetch_stops_for_a_newer_play_offline_after_a_failure_and_for_one_surah() {
        let s = store_with_delay(Duration::from_millis(200));
        // A newer play supersedes it before it starts.
        s.store.prefetch(7, (10..=40).collect());
        s.store.prefetch(7, vec![50, 51]);
        wait_for(Duration::from_secs(10), "the newer prefetch", || {
            s.fetcher.calls_of(50) + s.fetcher.calls_of(51) == 2
        });
        settle(&s.fetcher);
        let old = (10..=40)
            .map(|surah| s.fetcher.calls_of(surah))
            .sum::<usize>();
        assert!(
            old <= PREFETCH_CONCURRENCY,
            "{old} fetches for a superseded play"
        );
        assert_eq!((s.fetcher.calls_of(50), s.fetcher.calls_of(51)), (1, 1));

        // One surah to fetch: the planner's own request is as fast.
        s.store.prefetch(7, vec![60]);
        // Offline: nothing.
        s.online.store(false, Ordering::Release);
        s.store.prefetch(7, vec![61, 62, 63]);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            (60..=63)
                .map(|surah| s.fetcher.calls_of(surah))
                .sum::<usize>(),
            0
        );

        // A failed fetch ends it: the planner reports the error.
        s.online.store(true, Ordering::Release);
        s.fetcher.fail.store(true, Ordering::Release);
        s.store.prefetch(7, (90..=110).collect());
        let failed = || {
            (90..=110)
                .map(|surah| s.fetcher.calls_of(surah))
                .sum::<usize>()
        };
        wait_for(Duration::from_secs(10), "the failing prefetch", || {
            failed() >= 1
        });
        settle(&s.fetcher);
        let failed = failed();
        assert!(
            (1..=PREFETCH_CONCURRENCY).contains(&failed),
            "{failed} fetches after a failure"
        );
    }

    #[test]
    fn stored_timings_become_the_planners_set() {
        let mut t = stored(7, 1, 1_234, Duration::ZERO);
        t.file.duration_ms = Some(2_000); // shorter than the last ayah's end (QDC rounds durations)
        let set = timing_set(&t).unwrap();
        assert_eq!(set.file.expected_len, Some(1_234));
        assert_eq!(set.file.url, t.file.audio_url);
        assert_eq!((set.reciter_id, set.surah, set.duration_ms), (7, 1, 2_800));
        assert_eq!(set.ayahs.len(), 7);
        assert_eq!(
            set.ayahs[6].words,
            vec![(1, 2_400, 2_600), (2, 2_600, 2_800)]
        );
        assert!(set.word_level);
    }

    /// Rule 7 goes through the pack manager's refresh (which replaces the pair in one step and keeps pinned pairs for
    /// the revalidator): once per file, never offline, and again after a failed attempt.
    #[test]
    fn a_file_mismatch_refreshes_the_timings_once_per_file() {
        let s = store();
        s.content
            .timings_put(&stored(7, 6, 10, Duration::ZERO), false)
            .unwrap();
        let key = FileKey {
            reciter_id: 7,
            surah: 6,
            url: "https://download.quranicaudio.com/test/006.mp3".into(),
            expected_len: Some(10),
        };

        // Offline: nothing is attempted, and the stored pair stays until the network is back.
        s.online.store(false, Ordering::Release);
        s.store.on_file_mismatch(&key, &CancelToken::new());
        assert!(s.fetcher.refreshes().is_empty());
        assert_eq!(
            s.content
                .timings_get(7, 6)
                .unwrap()
                .unwrap()
                .file
                .content_length,
            Some(10)
        );
        s.online.store(true, Ordering::Release);

        // A failed refresh does not use up the one attempt.
        s.fetcher.fail.store(true, Ordering::Release);
        s.store.on_file_mismatch(&key, &CancelToken::new());
        assert_eq!(s.fetcher.refreshes(), vec![(7, 6)]);
        s.fetcher.fail.store(false, Ordering::Release);

        s.store.on_file_mismatch(&key, &CancelToken::new());
        assert_eq!(s.fetcher.refreshes(), vec![(7, 6), (7, 6)]);
        assert_eq!(
            s.content
                .timings_get(7, 6)
                .unwrap()
                .unwrap()
                .file
                .content_length,
            Some(50_000),
            "the server's pair replaced the stored one"
        );
        s.store.on_file_mismatch(&key, &CancelToken::new());
        assert_eq!(s.fetcher.refreshes().len(), 2, "once per file");
        assert!(
            s.fetcher.calls().is_empty(),
            "a refresh, never the age-based fetch"
        );

        // The new pair is another file: its own mismatch would be refreshed once too.
        let next = FileKey {
            expected_len: Some(50_000),
            ..key
        };
        s.store.on_file_mismatch(&next, &CancelToken::new());
        assert_eq!(s.fetcher.refreshes().len(), 3);
    }

    /// The sources wrapper applies the mismatch rule and passes everything else through.
    #[test]
    fn the_source_wrapper_reacts_to_a_mismatch_only() {
        struct Fails(AudioError);
        impl SourceProvider for Fails {
            fn open(&self, _key: &FileKey) -> Result<OpenedSource, AudioError> {
                Err(self.0.clone())
            }
        }
        let s = store();
        s.content
            .timings_put(&stored(7, 8, 10, Duration::ZERO), false)
            .unwrap();
        let key = FileKey {
            reciter_id: 7,
            surah: 8,
            url: "u".into(),
            expected_len: Some(10),
        };
        let open = |error: AudioError| {
            let sources = GlueSources {
                inner: Box::new(Fails(error)),
                store: Arc::clone(&s.store),
                on_open: Box::new(|_| panic!("a failed open is no use")),
            };
            sources.open(&key).unwrap_err()
        };
        assert!(matches!(
            open(AudioError::Offline("x".into())),
            AudioError::Offline(_)
        ));
        assert!(s.fetcher.refreshes().is_empty());
        let e = open(AudioError::FileMismatch("another length".into()));
        assert_eq!(e, AudioError::FileMismatch("another length".into()));
        assert_eq!(s.fetcher.refreshes(), vec![(7, 8)]);
    }

    /// Every successful open is reported (the pack manager marks the surah as played, for the stream cache's LRU).
    #[test]
    fn a_successful_open_is_reported_as_a_use() {
        struct Opens;
        impl SourceProvider for Opens {
            fn open(&self, _key: &FileKey) -> Result<OpenedSource, AudioError> {
                Ok(OpenedSource::complete(Box::new(std::io::Cursor::new(
                    vec![0_u8; 8],
                ))))
            }
        }
        let s = store();
        let used = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&used);
        let sources = GlueSources {
            inner: Box::new(Opens),
            store: Arc::clone(&s.store),
            on_open: Box::new(move |key: &FileKey| {
                lock(&seen).push((key.reciter_id, key.surah));
            }),
        };
        let key = FileKey {
            reciter_id: 7,
            surah: 112,
            url: "u".into(),
            expected_len: Some(8),
        };
        assert!(sources.open(&key).is_ok());
        assert_eq!(*lock(&used), [(7, 112)]);
        assert!(s.fetcher.refreshes().is_empty());
    }

    // ---- the whole service on the null sink -------------------------------------------------------------------------

    pub(crate) struct Harness {
        pub dir: TempDir,
        pub service: AudioService,
        pub recorder: Arc<Recorder>,
        pub fetcher: Arc<FixtureFetcher>,
        pub user: UserDb,
        pub content: ContentDb,
    }

    /// An `AudioService` on temp databases, a pack manager, the fixture fetcher, cached files only (surah 1) and the
    /// null sink.
    #[cfg(debug_assertions)]
    pub(crate) fn harness(min_ayah: Duration) -> Harness {
        harness_with(min_ayah, &[1], Duration::ZERO)
    }

    /// [`harness`] with the silent file cached for each of `cached` and fetches that take `fetch_delay`.
    #[cfg(debug_assertions)]
    pub(crate) fn harness_with(
        min_ayah: Duration,
        cached: &[u16],
        fetch_delay: Duration,
    ) -> Harness {
        let dir = TempDir::new().unwrap();
        let user = UserDb::open(&dir.path().join("user.db")).unwrap();
        let content = ContentDb::open(&dir.path().join("content.db")).unwrap();
        let core = CoreDb::unavailable("audio glue test".into());
        let rt = tauri::async_runtime::handle().inner().clone();
        let packs = PackManager::new(
            PackManagerConfig {
                packs_root: dir.path().join("packs"),
                catalog_path: Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/catalog.json"),
                core: core.clone(),
                user: user.clone(),
                content: content.clone(),
                runtime: rt.clone(),
                user_agent: "QuranForDesktop/test".into(),
                network_allowed: true,
                stream_cache_cap_bytes: 1 << 30,
            },
            Arc::new(NoPackEvents),
        )
        .unwrap();
        let mp3 = silent_mp3(MP3_FRAMES);
        let fetcher = Arc::new(
            FixtureFetcher::new(content.clone(), mp3.len() as u64).with_delay(fetch_delay),
        );
        let audio_root = dir.path().join("packs").join("audio");
        for &surah in cached {
            let file = quran_audio::cached_file_path(&audio_root, 7, surah);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, &mp3).unwrap();
        }
        let recorder = Arc::new(Recorder::default());
        let service = AudioService::start_with(GlueParts {
            emitter: Arc::clone(&recorder) as Arc<dyn EventEmitter>,
            core,
            content: content.clone(),
            user: user.clone(),
            packs,
            settings: Settings::default(),
            fetcher: Arc::clone(&fetcher) as Arc<dyn TimingsFetcher>,
            audio_root,
            client: None,
            rt,
            output: OutputKind::Sink(quran_audio::sink::SinkKind::Null),
            listen_min_ayah: min_ayah,
            // Whatever the pack manager thinks: the fixture fetcher and cached files never use the network.
            online: Some(Arc::new(|| true)),
        })
        .unwrap();
        // The synthetic index stands in for core.db (page 1 = 1:1–1:7).
        assert!(
            service
                .shared
                .index
                .set(Arc::new(synthetic_index()))
                .is_ok()
        );
        Harness {
            dir,
            service,
            recorder,
            fetcher,
            user,
            content,
        }
    }

    /// A tick of 1:2 while playing, at `file_ms`, word 1, 1×.
    fn playing_tick(file_ms: u32) -> AudioTick {
        AudioTick {
            seq: 0,
            generation: 1,
            status: PlaybackStatus::Playing,
            surah: 1,
            ayah: 2,
            ayah_id: 2,
            file_ms,
            word_pos: 1,
            speed_pct: 100,
            in_gap: false,
            buffered_pct: 100,
        }
    }

    #[test]
    fn the_webview_gets_the_ticks_that_change_what_it_shows_and_a_resync_four_times_a_second() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);

        // 2 s of steady playback at 30 Hz, a word every 500 ms (offset from the resyncs): the first tick, the three word
        // changes and a resync each 250 ms reach the webview: 9 of 60.
        let mut f = TickFilter::default();
        let mut admitted = Vec::new();
        for i in 0..60u32 {
            let ms = u64::from(i) * 100 / 3;
            let mut t = playing_tick(1_000 + u32::try_from(ms).unwrap());
            t.seq = i;
            t.word_pos = 1 + u32::try_from((ms + 100) / 500).unwrap();
            if f.admit(&t, at(ms)) {
                admitted.push((ms, t.word_pos));
            }
        }
        assert!((9..=13).contains(&admitted.len()), "{admitted:?}");
        for word in 2..=4 {
            let first = admitted.iter().find(|(_, w)| *w == word).map(|(ms, _)| *ms);
            let tick_ms = (word - 1) * 500 - 100;
            assert!(
                first.is_some_and(|ms| ms.abs_diff(u64::from(tick_ms)) <= 34),
                "word {word} reached the webview with its first tick: {admitted:?}"
            );
        }
        // Between two of them, never more than the resync period.
        for pair in admitted.windows(2) {
            assert!(pair[1].0 - pair[0].0 <= 250 + 34, "{admitted:?}");
        }

        // Changes go through at once, steady ticks wait for the resync.
        let mut f = TickFilter::default();
        let mut t = playing_tick(5_000);
        assert!(f.admit(&t, at(0)), "the first tick on a channel");
        t.file_ms = 5_033;
        assert!(!f.admit(&t, at(33)), "on the interpolated path");
        t.file_ms = 5_100;
        assert!(
            !f.admit(&t, at(66)),
            "34 ms ahead of the interpolation: within the drift"
        );
        t.file_ms = 4_000;
        assert!(f.admit(&t, at(100)), "a repeat jumps back");
        t.file_ms = 4_033;
        t.generation = 2;
        assert!(f.admit(&t, at(133)), "a seek's new generation");
        t.file_ms = 4_066;
        t.speed_pct = 150;
        assert!(f.admit(&t, at(166)), "a new speed");
        t.file_ms = 4_116;
        t.in_gap = true;
        assert!(f.admit(&t, at(199)), "a gap starts");
        assert!(
            !f.admit(&t, at(232)),
            "in a gap the position stands still, as the interpolation does"
        );
        assert!(f.admit(&t, at(199 + 250)), "the resync");
        t.in_gap = false;
        t.ayah = 3;
        t.ayah_id = 3;
        assert!(f.admit(&t, at(480)), "the next ayah");
        t.status = PlaybackStatus::Paused;
        assert!(f.admit(&t, at(500)), "a pause");
        assert!(
            f.admit(&t, at(510)),
            "not playing, every tick (one per change) goes through"
        );
        t.status = PlaybackStatus::Playing;
        assert!(f.admit(&t, at(520)), "playing again");
        t.surah = 2;
        assert!(f.admit(&t, at(530)), "another surah");
        t.word_pos = 2;
        assert!(f.admit(&t, at(540)), "another word");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_play_streams_events_ticks_ui_edges_and_listen_history() {
        let h = harness(Duration::from_millis(300));
        let ui_calls = Arc::new(AtomicUsize::new(0));
        let ui = Arc::clone(&ui_calls);
        h.service.set_ui_sink(Arc::new(move |_s: &AudioSnapshot| {
            ui.fetch_add(1, Ordering::AcqRel);
        }));
        wait_for(
            Duration::from_secs(2),
            "the UI sink gets the current state at once",
            || ui_calls.load(Ordering::Acquire) >= 1,
        );
        let ticks = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&ticks);
        h.service.set_tick_channel(Channel::new(move |_body| {
            counted.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }));

        let snapshot = h.service.play(request(r(1, 1), None, None)).unwrap();
        assert_eq!(snapshot.status, PlaybackStatus::Loading);
        assert_eq!(
            snapshot.range.map(|range| (range.from, range.to)),
            Some((r(1, 1), r(1, 7))),
            "settings.stop_at (end of surah) resolved `to`"
        );
        wait_for(Duration::from_secs(10), "playing", || {
            h.service.snapshot().status == PlaybackStatus::Playing
        });
        let started = Instant::now();
        wait_for(Duration::from_secs(10), "the end", || {
            h.service.snapshot().status == PlaybackStatus::Idle
                && h.service.snapshot().current.is_none()
        });
        let played = started.elapsed();
        assert_eq!(
            h.fetcher.calls(),
            vec![(7, 1)],
            "timings fetched once, through the store"
        );

        let ayahs: Vec<u32> = h
            .recorder
            .named("audio-ayah-changed")
            .iter()
            .map(|v| v["ayah"].as_u64().unwrap() as u32)
            .collect();
        assert_eq!(ayahs, (1..=7).collect::<Vec<_>>());
        let states = h.recorder.named("audio-state-changed");
        assert!(
            states.iter().any(|s| s["status"] == "playing"),
            "{states:?}"
        );
        let ui = ui_calls.load(Ordering::Acquire);
        let ticked = ticks.load(Ordering::Acquire);
        // The engine ticks at 30 Hz; the webview gets every ayah (and word) change and a resync each 250 ms.
        let engine_ticks = usize::try_from(played.as_millis() * 30 / 1000).unwrap();
        let resyncs = usize::try_from(played.as_millis() / TICK_RESYNC.as_millis()).unwrap();
        assert!(
            ticked >= 7 + resyncs / 2 && ticked < engine_ticks,
            "{ticked} ticks reached the channel in {played:?} ({engine_ticks} at 30 Hz)"
        );
        assert!(
            ui >= 2 && ui < engine_ticks / 2,
            "UI edges only: {ui} sink calls for {engine_ticks} engine ticks"
        );

        // Every ayah was heard for 300 ms: page 1 is recorded once (merged), and the History panel is told.
        wait_for(Duration::from_secs(5), "listen history", || {
            h.user
                .history_list(10, None)
                .unwrap()
                .iter()
                .map(|e| e.dwell_s)
                .sum::<u32>()
                >= 2
        });
        let history: Vec<HistoryEntry> = h.user.history_list(10, None).unwrap();
        assert_eq!(history.len(), 1, "{history:?}");
        let e = history[0];
        assert_eq!(
            (e.mode, e.layout, e.page, e.ayah_id),
            (HistoryMode::Listen, Some(MushafLayout::V2), Some(1), 7)
        );
        assert!((2..=3).contains(&e.dwell_s), "{e:?}");
        assert!(!h.recorder.named("user-data-changed").is_empty());

        // Settings apply live; the second play is served by content.db (no second fetch).
        let prev = Settings::default();
        let next = Settings {
            speed_pct: 150,
            volume_pct: 40,
            stop_at: StopAt::EndOfQuran,
            ..Settings::default()
        };
        h.service.apply_settings(&prev, &next);
        wait_for(Duration::from_secs(2), "speed and volume", || {
            let s = h.service.snapshot();
            (s.speed_pct, s.volume_pct) == (150, 40)
        });
        let q = h
            .service
            .play(request(r(1, 6), Some(r(1, 7)), None))
            .unwrap();
        assert_eq!(q.range.map(|range| range.to), Some(r(1, 7)));
        wait_for(Duration::from_secs(10), "the second play ends", || {
            h.service.snapshot().status == PlaybackStatus::Idle
                && h.service.snapshot().current.is_none()
        });
        assert_eq!(h.fetcher.calls().len(), 1);
        assert!(h.service.index_ready());

        h.service.shutdown();
        h.service.shutdown(); // idempotent
        assert!(h.dir.path().exists());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn an_os_play_with_nothing_loaded_replays_the_last_recitation() {
        let h = harness(LISTEN_MIN_AYAH);
        // Nothing played yet: Play and Play/Pause do nothing.
        h.service.handle_media_command(MediaCommand::Toggle);
        h.service.handle_media_command(MediaCommand::Play);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(h.service.snapshot().status, PlaybackStatus::Idle);
        assert!(h.fetcher.calls().is_empty());

        h.service
            .play(PlayRequest {
                start_paused: true,
                ..request(r(1, 6), Some(r(1, 7)), None)
            })
            .unwrap();
        wait_for(Duration::from_secs(10), "paused at 1:6", || {
            h.service.snapshot().status == PlaybackStatus::Paused
        });
        // Loaded: Play resumes (no replay).
        h.service.handle_media_command(MediaCommand::Play);
        wait_for(Duration::from_secs(10), "the end", || {
            let s = h.service.snapshot();
            s.status == PlaybackStatus::Idle && s.current.is_none() && s.range.is_some()
        });
        // Ended: Play/Pause replays 1:6–1:7 (playing, not paused).
        h.service.handle_media_command(MediaCommand::Toggle);
        wait_for(Duration::from_secs(10), "replaying", || {
            h.service
                .snapshot()
                .current
                .is_some_and(|c| c.surah == 1 && c.ayah >= 6)
        });
        h.service.handle_media_command(MediaCommand::Stop);
        wait_for(Duration::from_secs(5), "stopped", || {
            h.service.snapshot().status == PlaybackStatus::Idle
        });
        h.service.shutdown();
    }

    /// A recitation that failed mid-way (the next surah is not downloaded and cannot be streamed) is still loaded, and
    /// the OS media session and the tray show it paused with Play. Their Play continues it where it stopped once the
    /// file is there (here: downloaded meanwhile), instead of doing nothing.
    #[cfg(debug_assertions)]
    #[test]
    fn an_os_play_after_a_failure_mid_way_continues_the_recitation() {
        // Surah 1 is cached, surah 2 is not, and this service plays cached files only (no streaming client).
        let h = harness(LISTEN_MIN_AYAH);
        h.service
            .play(request(r(1, 6), Some(r(2, 2)), None))
            .unwrap();
        wait_for(Duration::from_secs(10), "the failure at surah 2", || {
            let s = h.service.snapshot();
            s.status == PlaybackStatus::Error && s.current.is_some()
        });
        let failed = h.service.snapshot();
        assert_eq!(
            failed.error.as_ref().map(AppError::kind),
            Some("offline"),
            "{failed:?}"
        );
        assert_eq!(
            failed.range.map(|g| (g.from, g.to)),
            Some((r(1, 6), r(2, 2)))
        );

        // Surah 2 arrives (a download, or the network back), and the media key's Play goes on from where it stopped.
        let file = quran_audio::cached_file_path(&h.dir.path().join("packs").join("audio"), 7, 2);
        std::fs::write(&file, silent_mp3(MP3_FRAMES)).unwrap();
        h.service.handle_media_command(MediaCommand::Play);
        wait_for(Duration::from_secs(10), "2:1 plays", || {
            let s = h.service.snapshot();
            s.current == Some(r(2, 1)) && s.status == PlaybackStatus::Playing
        });
        let s = h.service.snapshot();
        assert_eq!(s.error, None);
        assert_eq!(
            s.range.map(|g| (g.from, g.to)),
            Some((r(1, 6), r(2, 2))),
            "the same recitation"
        );
        let heard: Vec<(u64, u64)> = h
            .recorder
            .named("audio-ayah-changed")
            .iter()
            .map(|v| (v["surah"].as_u64().unwrap(), v["ayah"].as_u64().unwrap()))
            .collect();
        assert_eq!(
            heard.iter().filter(|&&a| a == (1, 6)).count(),
            1,
            "not replayed from its start: {heard:?}"
        );
        wait_for(Duration::from_secs(10), "the end", || {
            let s = h.service.snapshot();
            s.status == PlaybackStatus::Idle && s.current.is_none()
        });
        h.service.shutdown();
    }

    /// The onboarding's reciter preview (`record: false`, §9.7) is no part of the listening: it records no listen
    /// history, and "play with nothing loaded" replays the recitation before it, never the preview.
    #[cfg(debug_assertions)]
    #[test]
    fn a_preview_records_no_history_and_is_never_replayed() {
        let h = harness(Duration::from_millis(300));
        let preview = || PlayRequest {
            record: false,
            ..request(r(1, 1), Some(r(1, 2)), None)
        };
        let ended = |h: &Harness| {
            let s = h.service.snapshot();
            s.status == PlaybackStatus::Idle && s.current.is_none() && s.range.is_some()
        };

        // A preview heard to its end (each ayah ≥ 300 ms, which would qualify page 1).
        h.service.play(preview()).unwrap();
        wait_for(Duration::from_secs(10), "the preview plays", || {
            h.service.snapshot().status == PlaybackStatus::Playing
        });
        wait_for(Duration::from_secs(10), "the preview ends", || ended(&h));
        // Nothing to replay: Play/Pause does nothing.
        h.service.handle_media_command(MediaCommand::Toggle);
        std::thread::sleep(Duration::from_millis(500));
        assert!(ended(&h), "{:?}", h.service.snapshot());
        assert!(h.user.history_list(10, None).unwrap().is_empty());

        // The same ayahs as the user's play are listen history.
        h.service
            .play(request(r(1, 1), Some(r(1, 2)), None))
            .unwrap();
        wait_for(Duration::from_secs(10), "the play ends", || {
            ended(&h) && !h.user.history_list(10, None).unwrap().is_empty()
        });
        let recorded = h.user.history_list(10, None).unwrap();

        // A preview after it: the media key replays the user's play (1:1–1:2), and the preview adds no history.
        h.service
            .play(PlayRequest {
                record: false,
                ..request(r(1, 5), Some(r(1, 6)), None)
            })
            .unwrap();
        wait_for(Duration::from_secs(10), "the second preview ends", || {
            ended(&h)
                && h.service
                    .snapshot()
                    .range
                    .is_some_and(|g| g.from == r(1, 5))
        });
        h.service.handle_media_command(MediaCommand::Toggle);
        wait_for(
            Duration::from_secs(10),
            "the user's play is replayed",
            || {
                h.service
                    .snapshot()
                    .range
                    .is_some_and(|g| g.from == r(1, 1))
                    && h.service.snapshot().current.is_some()
            },
        );
        h.service.handle_media_command(MediaCommand::Stop);
        wait_for(Duration::from_secs(5), "stopped", || {
            h.service.snapshot().status == PlaybackStatus::Idle
        });
        h.service.shutdown();
        let after: Vec<u32> = h
            .user
            .history_list(10, None)
            .unwrap()
            .iter()
            .map(|e| e.ayah_id)
            .collect();
        assert!(
            !after.contains(&5) && !after.contains(&6),
            "the preview of 1:5–1:6 is not in the history: {after:?} (before it: {recorded:?})"
        );
    }

    /// A play across surahs of an uncached reciter: the timings the planner loads one by one (112, the basmala's
    /// surah 1, 113, 114) are fetched a few at a time, each once.
    #[cfg(debug_assertions)]
    #[test]
    fn a_play_across_surahs_prefetches_its_timings() {
        let h = harness_with(
            LISTEN_MIN_AYAH,
            &[1, 112, 113, 114],
            Duration::from_millis(300),
        );
        h.service
            .play(request(r(112, 1), None, Some(StopAt::EndOfQuran)))
            .unwrap();
        wait_for(Duration::from_secs(15), "playing", || {
            h.service.snapshot().status == PlaybackStatus::Playing
        });
        let mut fetched: Vec<u32> = h.fetcher.calls().iter().map(|(_, s)| *s).collect();
        fetched.sort_unstable();
        assert_eq!(fetched, vec![1, 112, 113, 114], "each surah once");
        assert!(
            h.fetcher.max_in_flight() >= 2,
            "the round trips overlapped (at most {} at once)",
            h.fetcher.max_in_flight()
        );
        assert!(!h.service.snapshot().basmala_skipped);
        h.service.engine().stop();
        h.service.shutdown();
    }

    /// The app's UI sink needs the Wry runtime: other runtimes (here `tauri::test`) get none, and nothing fails.
    #[cfg(debug_assertions)]
    #[test]
    fn only_the_app_runtime_gets_the_app_ui_sink() {
        let h = harness(LISTEN_MIN_AYAH);
        let app = tauri::test::mock_app();
        h.service.register_app_ui_sink(app.handle(), UiLanguage::Ar);
        assert!(
            h.service
                .shared
                .worker
                .ctx
                .ui_sink
                .read()
                .unwrap()
                .is_none()
        );
        h.service.shutdown();
    }

    /// The registration WP6a hands over in `setup::after_manage` (LEAD item 3) type-checks against this API.
    #[allow(dead_code)]
    fn setup_registers_the_ui_sink(
        app: &AppHandle,
        state: &crate::state::AppState,
        settings: &Settings,
    ) {
        state
            .audio
            .set_ui_sink(crate::setup::AudioUiSink::new(app, settings.ui_language).into_sink());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn async_timings_and_validation() {
        let h = harness(LISTEN_MIN_AYAH);
        let t = tauri::async_runtime::block_on(h.service.timings(7, 1)).unwrap();
        assert_eq!(
            (t.reciter_id, t.surah, t.ayahs.len(), t.word_level),
            (7, 1, 7, true)
        );
        assert_eq!(t.ayahs[0].words.len(), 2);
        assert!(matches!(
            tauri::async_runtime::block_on(h.service.timings(7, 0)),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            tauri::async_runtime::block_on(h.service.timings(7, 115)),
            Err(AppError::InvalidArgument(_))
        ));
        // A bad request never reaches the engine.
        assert!(matches!(
            h.service.play(request(r(1, 9), None, None)),
            Err(AppError::InvalidArgument(_))
        ));
        assert_eq!(h.service.snapshot().status, PlaybackStatus::Idle);
        assert!(h.content.timings_get(7, 1).unwrap().is_some());
        h.service.shutdown();
    }
}
