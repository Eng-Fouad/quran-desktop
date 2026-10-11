//! Startup (§2.8.2): a testable core, [`build_state`], and the thin UI wrapper [`init`] that never fails. Owner: WP6a.
//!
//! **[`init`] never returns `Err` and never panics**: tauri 2.12 `panic!`s on an `Err` from the setup closure, which
//! aborts the process under `panic = "abort"`.
//!
//! Steps (§2.8.2):
//! 1. resolve the paths ([`StartupEnv::resolve`]; debug builds honour the D24 overrides) and create `data/`, `packs/`;
//! 2. open core.db: fatal in release, a degraded app with `CoreDb::unavailable` in debug builds;
//! 3. open (or recover) user.db and content.db; a quarantined database becomes a [`StartupNotice`];
//! 4. load the settings (on the very first launch, guess the UI language from the OS locale, D22), build the pack
//!    manager, the search engine and the audio service;
//!    - any failure in steps 1–4 is the **fatal path**: logged, a non-blocking native error dialog that exits with code 1,
//!      no managed state, the window stays hidden;
//! 5. manage the state, then (each logged and skipped on failure) UI zoom, tray, OS media session, pack background tasks;
//! 6. the window stays hidden until the frontend's `window_ready`, with a [`SHOW_FALLBACK`] safety timer.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use media_session::MediaCommand;
use quran_core::{ContentDb, CoreDb, CoreError, SearchEngine, UserDb};
use quran_packs::PackManagerConfig;
use quran_types::{
    AppError, AppInfo, AudioSnapshot, CoreDbInfo, FontTransport, Platform, Settings, StartupNotice,
    UiLanguage,
};
use tauri::{AppHandle, Listener, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::audio_glue::AudioService;
use crate::i18n::{self, RustText};
use crate::state::{AppPaths, AppState};
use crate::util::to_js_path;

/// How long the hidden main window waits for `window_ready` before it is shown anyway.
pub const SHOW_FALLBACK: Duration = Duration::from_secs(3);

/// The User-Agent of every app request (the pack layer's clients, which audio streaming shares; §2.5.5):
/// `QuranForDesktop/<version>` (docs/deviations/LEAD.md item 16).
pub const USER_AGENT: &str = concat!("QuranForDesktop/", env!("CARGO_PKG_VERSION"));

/// What a core.db that cannot be opened means: fatal in release, a degraded app in debug builds (§2.8.2 step 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorePolicy {
    Fatal,
    Degrade,
}

impl CorePolicy {
    /// `Degrade` in debug builds, `Fatal` in release builds.
    #[must_use]
    pub const fn for_build() -> Self {
        if cfg!(debug_assertions) {
            Self::Degrade
        } else {
            Self::Fatal
        }
    }
}

/// A startup failure that prevents the app from running (§2.8.2 "Fatal path").
#[derive(Debug, thiserror::Error)]
pub enum Fatal {
    #[error("cannot resolve the {what} path: {detail}")]
    Path { what: &'static str, detail: String },
    #[error("cannot create {}: {source}", path.display())]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// Release builds only (debug builds degrade).
    #[error("core.db cannot be opened: {0}")]
    Core(#[source] CoreError),
    /// Only a failure to open a **fresh** database is fatal; corruption is quarantined and recovered.
    #[error("{name} cannot be opened: {source}")]
    Database {
        name: &'static str,
        #[source]
        source: CoreError,
    },
    #[error("content packs cannot start: {0}")]
    Packs(#[source] AppError),
    #[error("the audio engine cannot start: {0}")]
    Audio(#[source] AppError),
}

/// How QCF page and decor fonts reach `FontFace` on `platform` (D30, §6.1; the WP6a spike, docs/deviations/WP6a.md):
/// - Windows (WebView2 154): `url`, verified in the real app (`FontFace` from `http://quran.localhost/…`);
/// - Linux (WebKitGTK 2.52.6): `url`, verified with wry's exact scheme registration (custom schemes registered as
///   secure only) from a `tauri://localhost` page;
/// - macOS (WKWebView, WebKit 22625 on macOS 27): `url`, verified in the real app (`FontFace` from
///   `quran://localhost/…`: every QCF V4 page and decor face, no retry as bytes).
///
/// Everywhere, a face that fails by URL is retried once as bytes (the frontend's `fonts` store).
#[must_use]
pub const fn platform_font_transport(platform: Platform) -> FontTransport {
    match platform {
        Platform::Windows | Platform::Linux | Platform::Macos => FontTransport::Url,
    }
}

/// What startup takes from its surroundings, resolved once by [`StartupEnv::resolve`] (tests construct it directly).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupEnv {
    pub paths: AppPaths,
    /// `tauri_plugin_os::locale()` (D22): `AppInfo.os_locale` and the first-launch UI language.
    pub os_locale: Option<String>,
    /// Debug builds started with `QD_TEST=1` (D24).
    pub test_mode: bool,
    pub font_transport: FontTransport,
}

impl StartupEnv {
    /// Step 1 plus the D24 developer overrides (`QD_DATA_DIR`, `QD_CORE_DB`, `QD_TEST`, `QD_FONT_TRANSPORT`), which only
    /// debug builds read.
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, Fatal> {
        Ok(Self {
            paths: resolve_paths(app)?,
            os_locale: tauri_plugin_os::locale(),
            test_mode: debug_env("QD_TEST").as_deref() == Some("1"),
            font_transport: font_transport_override()
                .unwrap_or(const { platform_font_transport(Platform::current()) }),
        })
    }
}

/// Builds the managed state (steps 1–4). Never panics; creates the data directories and opens the databases.
pub fn build_state<R: Runtime>(app: &AppHandle<R>, policy: CorePolicy) -> Result<AppState, Fatal> {
    let env = StartupEnv::resolve(app)?;
    build_state_with(app, policy, env, Instant::now()).map(|(state, _)| state)
}

/// [`build_state`] for a resolved environment; also returns the settings it loaded (step 5 needs them).
pub fn build_state_with<R: Runtime>(
    app: &AppHandle<R>,
    policy: CorePolicy,
    env: StartupEnv,
    started_at: Instant,
) -> Result<(AppState, Settings), Fatal> {
    let StartupEnv {
        paths,
        os_locale,
        test_mode,
        font_transport,
    } = env;
    let stores = open_stores(&paths, policy)?;

    // Step 4: settings, packs, search, audio.
    let settings = load_settings(&stores.user, stores.fresh_user_db, os_locale.as_deref());
    let (packs, pack_events) = crate::packs_glue::build(
        app,
        PackManagerConfig {
            packs_root: paths.packs.clone(),
            catalog_path: paths.catalog.clone(),
            core: stores.core.clone(),
            user: stores.user.clone(),
            content: stores.content.clone(),
            runtime: tauri::async_runtime::handle().inner().clone(),
            user_agent: USER_AGENT.to_owned(),
            network_allowed: settings.network_allowed,
            stream_cache_cap_bytes: u64::from(settings.stream_cache_cap_mib) * 1024 * 1024,
        },
    )
    .map_err(Fatal::Packs)?;
    let search = SearchEngine::new(stores.core.clone());
    let audio = AudioService::start(
        app,
        stores.core.clone(),
        stores.content.clone(),
        stores.user.clone(),
        packs.clone(),
        &settings,
    )
    .map_err(Fatal::Audio)?;

    let app_info = AppInfo {
        name: app.package_info().name.clone(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        identifier: app.config().identifier.clone(),
        platform: Platform::current(),
        arch: std::env::consts::ARCH.to_owned(),
        os_version: tauri_plugin_os::version().to_string(),
        os_locale,
        webview_version: tauri::webview_version().unwrap_or_else(|_| "unknown".to_owned()),
        data_dir: to_js_path(&paths.data),
        log_dir: to_js_path(&paths.logs),
        protocol_base: crate::protocol::PROTOCOL_BASE.to_owned(),
        font_transport,
        debug: cfg!(debug_assertions),
        test_mode,
        core: core_info(&stores.core),
    };
    let state = AppState::new(
        paths,
        stores.core,
        search,
        stores.user,
        stores.content,
        packs,
        pack_events,
        audio,
        app_info,
        stores.notices,
        started_at,
    );
    Ok((state, settings))
}

/// The databases of steps 1–3.
pub struct Stores {
    pub core: CoreDb,
    pub user: UserDb,
    pub content: ContentDb,
    pub notices: Vec<StartupNotice>,
    /// user.db did not exist (or was just quarantined and recreated): this is the very first launch on this data.
    pub fresh_user_db: bool,
}

/// Steps 1–3 on resolved paths: the data directories, core.db under `policy`, then user.db and content.db with
/// recovery. Starts no thread and touches no device, so it is the unit-tested heart of startup.
pub fn open_stores(paths: &AppPaths, policy: CorePolicy) -> Result<Stores, Fatal> {
    for dir in [&paths.data, &paths.packs] {
        std::fs::create_dir_all(dir).map_err(|source| Fatal::CreateDir {
            path: dir.clone(),
            source,
        })?;
    }
    // Paths contain the user name: debug level only (§0.2).
    log::debug!(
        "data dir {}, core.db {}",
        paths.data.display(),
        paths.core_db.display()
    );

    // Step 2: core.db (fatal in release; degraded in debug builds).
    let core = open_core(&paths.core_db, policy)?;

    // Step 3: user.db and content.db; corruption is quarantined, never fatal.
    let mut notices = Vec::new();
    let user_db = paths.user_db();
    let existed = user_db.try_exists().unwrap_or(true);
    let (user, quarantined) =
        UserDb::open_or_recover(&user_db).map_err(|source| Fatal::Database {
            name: "user.db",
            source,
        })?;
    let fresh_user_db = !existed || quarantined.is_some();
    if let Some(file) = quarantined {
        log::warn!("user.db was corrupt; quarantined and recreated");
        notices.push(StartupNotice::UserDbRecovered {
            quarantined_file: to_js_path(&file),
        });
    }
    let (content, quarantined) =
        ContentDb::open_or_recover(&paths.content_db()).map_err(|source| Fatal::Database {
            name: "content.db",
            source,
        })?;
    if quarantined.is_some() {
        log::warn!("content.db was corrupt; quarantined and recreated");
        notices.push(StartupNotice::ContentDbRecovered);
    }
    Ok(Stores {
        core,
        user,
        content,
        notices,
        fresh_user_db,
    })
}

/// The setup hook (§2.8.2). On success manages `AppState`, runs step 5 and arms the show-window fallback; on failure
/// logs, shows the non-blocking fatal dialog (which exits with code 1) and leaves the window hidden and the state
/// unmanaged.
pub fn init(app: &mut tauri::App) {
    let started_at = Instant::now();
    let handle = app.handle().clone();
    let built = StartupEnv::resolve(&handle)
        .and_then(|env| build_state_with(&handle, CorePolicy::for_build(), env, started_at));
    match built {
        Ok((state, settings)) => {
            log::info!(
                "Quran for Desktop {} ({:?} {}, {}; webview {}; debug: {}, test mode: {}; core: {} {}; fonts by {:?}) \
                 ready in {} ms",
                state.app_info.version,
                state.app_info.platform,
                state.app_info.os_version,
                state.app_info.arch,
                state.app_info.webview_version,
                state.app_info.debug,
                state.app_info.test_mode,
                state.app_info.core.source,
                state.app_info.core.built_at,
                state.app_info.font_transport,
                started_at.elapsed().as_millis()
            );
            if !app.manage(state) {
                log::warn!("AppState was already managed");
            }
            after_manage(&handle, &settings);
            arm_show_fallback(&handle);
        }
        Err(e) => fatal(&handle, &e),
    }
}

/// Step 5, each part logged and skipped on failure: UI zoom (D27), the tray, the OS media session, the pack manager's
/// background tasks. The window chrome effect is not applied here: the frontend owns it (`window_set_chrome`, §9.6).
fn after_manage(app: &AppHandle, settings: &Settings) {
    crate::window::set_ui_zoom(app, settings.ui_scale_pct);
    if settings.show_tray_icon
        && let Err(e) = crate::tray::build(app, settings.ui_language)
    {
        log::warn!("tray: {e}");
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let router = app.clone();
    let on_command = Arc::new(move |cmd: MediaCommand| match cmd {
        MediaCommand::Raise => crate::window::show_main(&router),
        other => {
            if let Some(state) = router.try_state::<AppState>() {
                state.audio.handle_media_command(other);
            }
        }
    });
    if let Some(session) = crate::media::init(app, on_command)
        && state.media.set(session).is_err()
    {
        log::warn!("media session was already set");
    }
    // LEAD item 3: the audio UI sink (`AudioUiSink`: tray "Now: {ref}" label and OS media session on ayah/state edges)
    // is already registered: `AudioService::start` installs it whenever it runs on the Wry runtime, before any play
    // can start. Its edges look the session set above up through the managed state.

    state.packs.start_background();
}

/// The `AudioService` UI sink (LEAD item 3): on every ayah or playback-state edge (never per tick) it updates the OS
/// media session (`media::on_audio_state`) and the tray's "Now: {ref}" item and play/pause label
/// (`tray::set_now_playing`). It runs on the audio service's thread and never touches user.db: the UI language is cached
/// here and kept current by the `settings-changed` event.
pub struct AudioUiSink {
    app: AppHandle,
    lang: Arc<AtomicU8>,
}

impl AudioUiSink {
    /// A sink in `lang` that follows later `ui_language` changes.
    #[must_use]
    pub fn new(app: &AppHandle, lang: UiLanguage) -> Self {
        let cached = Arc::new(AtomicU8::new(lang_code(lang)));
        let follow = Arc::clone(&cached);
        app.listen(
            <crate::ipc::events::SettingsChanged as tauri_specta::Event>::NAME,
            move |event| match serde_json::from_str::<Settings>(event.payload()) {
                Ok(next) => follow.store(lang_code(next.ui_language), Ordering::Relaxed),
                Err(e) => log::debug!("audio UI sink: unreadable settings-changed payload: {e}"),
            },
        );
        Self {
            app: app.clone(),
            lang: cached,
        }
    }

    /// The sink as the shared callback an event source stores.
    #[must_use]
    pub fn into_sink(self) -> Arc<dyn Fn(&AudioSnapshot) + Send + Sync> {
        Arc::new(move |snapshot| self.on_edge(snapshot))
    }

    /// One ayah or state edge.
    pub fn on_edge(&self, snapshot: &AudioSnapshot) {
        let now = crate::media::now_playing(&self.app, snapshot);
        let (title, reciter) = now
            .as_ref()
            .map_or(("", ""), |n| (n.title.as_str(), n.reciter.as_str()));
        crate::media::on_audio_state(&self.app, snapshot, title, reciter);
        let lang = lang_from_code(self.lang.load(Ordering::Relaxed));
        let label = now.map(|n| tray_now_playing(lang, &n.title));
        crate::tray::set_now_playing(&self.app, label, snapshot.status);
    }
}

/// The tray's "Now: {ref}" label.
#[must_use]
pub fn tray_now_playing(lang: UiLanguage, title: &str) -> String {
    i18n::text(lang, RustText::TrayNowPlaying).replace("{ref}", title)
}

const fn lang_code(lang: UiLanguage) -> u8 {
    match lang {
        UiLanguage::En => 0,
        UiLanguage::Ar => 1,
    }
}

const fn lang_from_code(code: u8) -> UiLanguage {
    if code == 1 {
        UiLanguage::Ar
    } else {
        UiLanguage::En
    }
}

/// Step 2. A 0-byte placeholder or wrong schema is `SchemaMismatch` (§5.15).
fn open_core(path: &Path, policy: CorePolicy) -> Result<CoreDb, Fatal> {
    match CoreDb::open(path) {
        Ok(core) => Ok(core),
        Err(e) => match policy {
            CorePolicy::Fatal => Err(Fatal::Core(e)),
            CorePolicy::Degrade => {
                log::error!(
                    "core.db: {e}; continuing without it (debug build: run `pnpm core:qdc`)"
                );
                Ok(CoreDb::unavailable(e.to_string()))
            }
        },
    }
}

/// The stored settings. On the very first launch on this data (a fresh or recreated user.db) the UI language is guessed
/// from the OS locale (`ar*` → Arabic, D22) and stored, so the tray, the media session and the first paint agree. A
/// failure to read (never expected: bad keys fall back per key) means defaults; a failure to store the guess is logged.
fn load_settings(user: &UserDb, fresh: bool, os_locale: Option<&str>) -> Settings {
    let settings = user.settings_load().unwrap_or_else(|e| {
        log::warn!("settings: {e}; using the defaults");
        Settings::default()
    });
    let guess = UiLanguage::from_os_locale(os_locale);
    if !fresh || settings.ui_language == guess {
        return settings;
    }
    let next = Settings {
        ui_language: guess,
        ..settings
    };
    match user.settings_save(&next) {
        Ok(stored) => {
            log::info!("first launch: UI language {guess:?} from the OS locale");
            stored
        }
        Err(e) => {
            log::warn!("first launch: cannot store the UI language: {e}");
            next
        }
    }
}

/// `AppInfo.core` from the open core (`schemaVersion 0`, source `"unavailable"` on the degrade path).
fn core_info(core: &CoreDb) -> CoreDbInfo {
    let meta = core.meta();
    CoreDbInfo {
        schema_version: meta.schema_version,
        normalizer_version: meta.normalizer_version,
        source: meta.source.clone(),
        built_at: meta.built_at.clone(),
    }
}

/// Step 6: the window stays hidden until the frontend's `window_ready`; after [`SHOW_FALLBACK`] it is shown anyway, so
/// a frontend that fails before its first paint never leaves an invisible running app.
fn arm_show_fallback(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_FALLBACK).await;
        let ready = app
            .try_state::<AppState>()
            .is_some_and(|s| s.ready.load(Ordering::Acquire));
        if !ready {
            log::warn!(
                "window_ready not received within {SHOW_FALLBACK:?}; showing the main window"
            );
            crate::window::show_main(&app);
        }
    });
}

/// The fatal path: error dialog in the OS language, then `exit(1)`. Non-blocking (`blocking_show` must not run on the
/// main thread, and setup runs inside the event loop).
fn fatal(app: &AppHandle, error: &Fatal) {
    log::error!("startup failed: {error}");
    let lang = UiLanguage::from_os_locale(tauri_plugin_os::locale().as_deref());
    let handle = app.clone();
    app.dialog()
        .message(fatal_body(lang, error))
        .title(i18n::text(lang, RustText::StartupErrorTitle))
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

/// The fatal dialog's text. A library saved by a newer version (user.db or content.db with a newer schema, which is
/// left untouched) says so and what to do; anything else names the error, with the generic advice.
fn fatal_body(lang: UiLanguage, error: &Fatal) -> String {
    match error {
        Fatal::Database {
            source: CoreError::NewerSchema { .. },
            ..
        } => i18n::text(lang, RustText::StartupNewerLibrary).to_owned(),
        other => i18n::startup_error(lang, other),
    }
}

fn path_err(what: &'static str) -> impl FnOnce(tauri::Error) -> Fatal {
    move |e| Fatal::Path {
        what,
        detail: e.to_string(),
    }
}

fn simplified(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

/// `QD_DATA_DIR` (debug builds only, D24): the root of one isolated run. Everything such a run writes lives under it, so
/// parallel QA runs share nothing with each other or with an installed app of the same identifier:
/// - the data root itself (user.db, content.db, packs, backups);
/// - the log folder, [`dev_logs_dir`];
/// - the window state, [`dev_window_state_file`];
/// - the WebView2 profile with its `localStorage`, [`dev_webview_dir`].
#[must_use]
pub fn dev_root() -> Option<PathBuf> {
    debug_env("QD_DATA_DIR").map(|dir| simplified(Path::new(&dir)))
}

/// `<QD_DATA_DIR>/logs` (see [`dev_root`]); `None` in release builds and without the variable (the OS log dir).
#[must_use]
pub fn dev_logs_dir() -> Option<PathBuf> {
    dev_root().map(|root| root.join("logs"))
}

/// `<QD_DATA_DIR>/window-state.json` (see [`dev_root`]); `None` uses the window-state plugin's file in the app config
/// dir.
#[must_use]
pub fn dev_window_state_file() -> Option<PathBuf> {
    dev_root().map(|root| root.join("window-state.json"))
}

/// `<QD_DATA_DIR>/webview`, the webview's data directory (see [`dev_root`]): the WebView2 user data folder on Windows,
/// the WebKitGTK data directory on Linux. `None` uses the default profile under the app's local data dir. macOS has no
/// per-webview data directory (WKWebView keeps one store per app).
#[must_use]
pub fn dev_webview_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        None
    } else {
        dev_root().map(|root| root.join("webview"))
    }
}

/// Step 1: every path, dunce-simplified. Debug builds honour `QD_DATA_DIR` and `QD_CORE_DB` (D24) and read core.db and
/// catalog.json from the source tree, so a rebuilt core.db is picked up without recompiling; with `QD_DATA_DIR` the
/// logs are under it too ([`dev_root`]). The data directory is also made long-path safe ([`long_path_safe`]).
fn resolve_paths<R: Runtime>(app: &AppHandle<R>) -> Result<AppPaths, Fatal> {
    let resolver = app.path();
    let data = match dev_root() {
        Some(dir) => dir,
        None => resolver
            .app_local_data_dir()
            .map_err(path_err("app data"))?,
    };
    let logs = match dev_logs_dir() {
        Some(dir) => dir,
        None => resolver.app_log_dir().map_err(path_err("log"))?,
    };
    let (core_db, catalog) = resource_paths(app)?;
    let data = long_path_safe(simplified(&data));
    Ok(AppPaths {
        packs: data.join("packs"),
        data,
        logs: simplified(&logs),
        core_db: simplified(&core_db),
        catalog: simplified(&catalog),
    })
}

#[cfg(debug_assertions)]
fn resource_paths<R: Runtime>(_app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), Fatal> {
    let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
    let core_db = debug_env("QD_CORE_DB").map_or_else(|| resources.join("core.db"), PathBuf::from);
    Ok((core_db, resources.join("catalog.json")))
}

#[cfg(not(debug_assertions))]
fn resource_paths<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), Fatal> {
    use tauri::path::BaseDirectory;
    let resolver = app.path();
    let core_db = resolver
        .resolve("data/core.db", BaseDirectory::Resource)
        .map_err(path_err("core.db resource"))?;
    let catalog = resolver
        .resolve("data/catalog.json", BaseDirectory::Resource)
        .map_err(path_err("catalog.json resource"))?;
    Ok((core_db, catalog))
}

/// Room kept below the data directory for the deepest file the app opens with SQLite: a pack database and its journal,
/// `packs\translation\{pack id}\{version dir ≤ 64 B}~{n}\pack.db-journal`, about 150 characters with a long pack id.
#[cfg(windows)]
const DATA_TREE_RESERVE: usize = 160;

/// The data directory in a form under which every database stays openable.
///
/// Windows: Rust's std reaches paths longer than `MAX_PATH` (260) by itself, SQLite's Win32 VFS does not (it fails with
/// "unable to open database file", which would make startup fatal). A directory deep enough for a pack database below it
/// to cross the limit is therefore used in its verbatim `\\?\` form (`verbatim_if_deep`), which every path built under
/// it component by component (`Path::join`, as the protocol and quran-packs do) inherits. Any shorter directory, the
/// default `%LOCALAPPDATA%` location among them, only becomes absolute. Other platforms have no such limit: the path is
/// returned as given.
fn long_path_safe(dir: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        verbatim_if_deep(dir, DATA_TREE_RESERVE)
    }
    #[cfg(not(windows))]
    {
        dir
    }
}

/// `dir` made absolute (separators and `.`/`..` normalised by `GetFullPathNameW`) and, when fewer than `reserve`
/// characters would remain below it within `MAX_PATH`, rewritten into its verbatim form: `C:\…` → `\\?\C:\…`,
/// `\\server\share\…` → `\\?\UNC\server\share\…`. Verbatim and device paths, and paths that cannot be made absolute, are
/// returned as they are.
#[cfg(windows)]
fn verbatim_if_deep(dir: PathBuf, reserve: usize) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};

    /// `MAX_PATH` without its terminating NUL, in UTF-16 units.
    const MAX_PATH_CHARS: usize = 259;

    let Ok(abs) = std::path::absolute(&dir) else {
        return dir;
    };
    let len = abs.as_os_str().encode_wide().count();
    if len.saturating_add(reserve) <= MAX_PATH_CHARS {
        return abs;
    }
    let mut components = abs.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return abs;
    };
    let mut root = OsString::from(r"\\?\");
    match prefix.kind() {
        Prefix::Disk(letter) => {
            root.push(format!("{}:\\", char::from(letter)));
        }
        Prefix::UNC(server, share) => {
            root.push(r"UNC\");
            root.push(server);
            root.push(r"\");
            root.push(share);
            root.push(r"\");
        }
        // Already verbatim (`\\?\…`), or a device path (`\\.\…`).
        _ => return abs,
    }
    let mut verbatim = PathBuf::from(root);
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => verbatim.push(name),
            // `absolute` leaves no `.`/`..` and no second prefix; keep the plain form if that ever changes.
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => return abs,
        }
    }
    log::info!(
        "the data directory is {len} characters long; using its verbatim (\\\\?\\) form so that every database \
         below it stays within reach"
    );
    verbatim
}

/// `QD_FONT_TRANSPORT=url|bytes` (debug builds only): try the other transport without rebuilding, e.g. to check `url`
/// on macOS or Linux. Any other value is ignored with a warning.
fn font_transport_override() -> Option<FontTransport> {
    let value = debug_env("QD_FONT_TRANSPORT")?;
    match parse_font_transport(&value) {
        Some(transport) => {
            log::info!("QD_FONT_TRANSPORT: fonts by {transport:?}");
            Some(transport)
        }
        None => {
            log::warn!("QD_FONT_TRANSPORT={value:?} ignored (expected `url` or `bytes`)");
            None
        }
    }
}

fn parse_font_transport(value: &str) -> Option<FontTransport> {
    match value.trim().to_ascii_lowercase().as_str() {
        "url" => Some(FontTransport::Url),
        "bytes" => Some(FontTransport::Bytes),
        _ => None,
    }
}

/// A D24 developer override: read only in debug builds, compiled out of release builds. Empty values count as unset.
fn debug_env(name: &str) -> Option<String> {
    #[cfg(debug_assertions)]
    {
        std::env::var(name).ok().filter(|v| !v.trim().is_empty())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = name;
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use std::sync::Once;

    use quran_core::core_db::UNAVAILABLE_MESSAGE;
    use tauri::test::{MockRuntime, mock_app};
    use tempfile::TempDir;

    use super::*;

    /// Tests that start the audio service never reach the speakers (LEAD item 9): the engine's debug-only null sink.
    pub(crate) fn null_audio_sink() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            // SAFETY: set once, before any test of this binary starts an audio engine; Rust's own environment access
            // is synchronised, and no test reads the variable through C code.
            unsafe { std::env::set_var("QD_AUDIO_SINK", "null") };
        });
    }

    /// Data and log dirs under a temp dir, the given core.db, and the checkout's catalog (build.rs guarantees one).
    pub(crate) fn temp_paths(dir: &Path, core_db: PathBuf) -> AppPaths {
        let data = dir.join("data");
        AppPaths {
            packs: data.join("packs"),
            data,
            logs: dir.join("logs"),
            core_db,
            catalog: Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/catalog.json"),
        }
    }

    /// The real core.db when this checkout has one (`QD_CORE_DB`, else `src-tauri/resources/core.db` when larger than
    /// the 0-byte placeholder); `None` with a note otherwise, so a fresh clone stays green.
    pub(crate) fn real_core_db() -> Option<PathBuf> {
        let path = std::env::var_os("QD_CORE_DB")
            .filter(|v| !v.is_empty())
            .map_or_else(
                || Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/core.db"),
                PathBuf::from,
            );
        let len = std::fs::metadata(&path).map_or(0, |m| m.len());
        if len > 1024 * 1024 {
            Some(path)
        } else {
            eprintln!(
                "note: {} is not a built core.db; real-core checks skipped",
                path.display()
            );
            None
        }
    }

    /// One RFC 9110 product token: `QuranForDesktop/<version>`, no comment, no whitespace.
    #[test]
    fn the_user_agent_is_the_product_token() {
        assert_eq!(
            USER_AGENT.split_once('/'),
            Some(("QuranForDesktop", env!("CARGO_PKG_VERSION")))
        );
        assert!(USER_AGENT.chars().all(|c| c.is_ascii_graphic()));
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn garbage() -> Vec<u8> {
        (0..64 * 1024).map(|i| (i * 7 % 256) as u8).collect()
    }

    fn env_at(dir: &Path, core_db: PathBuf) -> StartupEnv {
        StartupEnv {
            paths: temp_paths(dir, core_db),
            os_locale: Some("en-US".to_owned()),
            test_mode: false,
            font_transport: FontTransport::Url,
        }
    }

    /// A full `AppState` on a mock app (the inert/null audio path), as the setup closure builds it.
    pub(crate) fn build_mock(
        env: StartupEnv,
        policy: CorePolicy,
    ) -> (tauri::App<MockRuntime>, Result<(AppState, Settings), Fatal>) {
        null_audio_sink();
        let app = mock_app();
        let built = build_state_with(app.handle(), policy, env, Instant::now());
        (app, built)
    }

    #[test]
    fn a_placeholder_or_corrupt_core_is_fatal_under_the_fatal_policy() {
        for (name, bytes) in [("empty.db", Vec::new()), ("corrupt.db", garbage())] {
            let dir = TempDir::new().unwrap();
            let core = dir.path().join(name);
            write(&core, &bytes);
            match open_stores(&temp_paths(dir.path(), core), CorePolicy::Fatal) {
                Err(Fatal::Core(e)) => {
                    if bytes.is_empty() {
                        assert!(
                            matches!(e, CoreError::SchemaMismatch { found: 0, .. }),
                            "{name}: {e:?}"
                        );
                    }
                }
                Err(other) => panic!("{name}: unexpected {other:?}"),
                Ok(_) => panic!("{name}: opened"),
            }
        }
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("missing/core.db");
        assert!(matches!(
            open_stores(&temp_paths(dir.path(), missing), CorePolicy::Fatal),
            Err(Fatal::Core(_))
        ));
    }

    #[test]
    fn a_placeholder_or_corrupt_core_degrades_under_the_degrade_policy() {
        for bytes in [Vec::new(), garbage()] {
            let dir = TempDir::new().unwrap();
            let core = dir.path().join("core.db");
            write(&core, &bytes);
            let stores = open_stores(&temp_paths(dir.path(), core), CorePolicy::Degrade).unwrap();
            assert!(!stores.core.is_available());
            assert_eq!(stores.core.meta().source, "unavailable");
            assert!(stores.notices.is_empty());
            assert!(stores.fresh_user_db);
            assert!(dir.path().join("data/packs").is_dir());
            assert!(dir.path().join("data/user.db").is_file());
            assert!(dir.path().join("data/content.db").is_file());
        }
    }

    #[test]
    fn a_full_state_degrades_without_a_core_and_never_panics() {
        let dir = TempDir::new().unwrap();
        let core = dir.path().join("core.db");
        write(&core, b"");
        let (_app, built) = build_mock(env_at(dir.path(), core.clone()), CorePolicy::Degrade);
        let (state, settings) = built.unwrap();
        assert!(!state.core.is_available());
        assert_eq!(state.app_info.core.source, "unavailable");
        assert_eq!(state.app_info.core.schema_version, 0);
        assert_eq!(settings, Settings::default());
        assert_eq!(
            crate::commands::app::bootstrap(&state),
            Err(AppError::NotFound(UNAVAILABLE_MESSAGE.to_owned()))
        );

        let (_app, built) = build_mock(env_at(dir.path(), core), CorePolicy::Fatal);
        assert!(matches!(built, Err(Fatal::Core(_))));
    }

    #[test]
    fn a_corrupt_user_db_is_quarantined_with_a_notice_and_replaced() {
        let dir = TempDir::new().unwrap();
        let paths = temp_paths(dir.path(), dir.path().join("core.db"));
        write(&paths.user_db(), &garbage());
        let stores = open_stores(&paths, CorePolicy::Degrade).unwrap();
        assert!(stores.fresh_user_db);
        let [StartupNotice::UserDbRecovered { quarantined_file }] = stores.notices.as_slice()
        else {
            panic!("notices: {:?}", stores.notices);
        };
        let quarantined = PathBuf::from(quarantined_file);
        assert!(quarantined.is_file(), "{quarantined:?}");
        assert!(
            quarantined
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("user.db.corrupt-")
        );
        assert_eq!(std::fs::read(&quarantined).unwrap(), garbage());
        // The fresh database works.
        assert_eq!(stores.user.settings_load().unwrap(), Settings::default());
        assert!(stores.user.first_run().unwrap());
    }

    #[test]
    fn a_corrupt_content_db_is_recreated_with_a_notice() {
        let dir = TempDir::new().unwrap();
        let paths = temp_paths(dir.path(), dir.path().join("core.db"));
        write(&paths.content_db(), &garbage());
        let stores = open_stores(&paths, CorePolicy::Degrade).unwrap();
        assert_eq!(stores.notices, vec![StartupNotice::ContentDbRecovered]);
    }

    #[test]
    fn an_unusable_data_dir_is_fatal_not_a_panic() {
        let dir = TempDir::new().unwrap();
        let paths = temp_paths(dir.path(), dir.path().join("core.db"));
        // A file where the data directory should be.
        write(&paths.data, b"not a directory");
        assert!(matches!(
            open_stores(&paths, CorePolicy::Degrade),
            Err(Fatal::CreateDir { .. })
        ));
    }

    #[test]
    fn the_first_launch_guesses_the_ui_language_once() {
        let dir = TempDir::new().unwrap();
        let paths = temp_paths(dir.path(), dir.path().join("core.db"));
        let stores = open_stores(&paths, CorePolicy::Degrade).unwrap();
        assert!(stores.fresh_user_db);
        let first = load_settings(&stores.user, stores.fresh_user_db, Some("ar-EG"));
        assert_eq!(first.ui_language, UiLanguage::Ar);
        assert_eq!(
            stores.user.settings_load().unwrap().ui_language,
            UiLanguage::Ar
        );
        drop(stores);

        // Later launches keep what is stored, whatever the OS says now.
        let stores = open_stores(&paths, CorePolicy::Degrade).unwrap();
        assert!(!stores.fresh_user_db);
        let again = load_settings(&stores.user, stores.fresh_user_db, Some("en-GB"));
        assert_eq!(again.ui_language, UiLanguage::Ar);

        // An English (or unknown) locale keeps the default and writes nothing.
        let other = TempDir::new().unwrap();
        let paths = temp_paths(other.path(), other.path().join("core.db"));
        let stores = open_stores(&paths, CorePolicy::Degrade).unwrap();
        for locale in [Some("en-US"), Some("arn-CL"), None] {
            assert_eq!(
                load_settings(&stores.user, true, locale).ui_language,
                UiLanguage::En,
                "{locale:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn deep_data_dirs_take_the_verbatim_form() {
        let check = |input: &str, expected: &str| {
            assert_eq!(
                verbatim_if_deep(PathBuf::from(input), DATA_TREE_RESERVE),
                PathBuf::from(expected),
                "{input}"
            );
        };
        // The default location (and anything with room for the pack tree) stays as it is.
        let default = r"C:\Users\someone\AppData\Local\com.quran.labs.desktop";
        check(default, default);
        // A deep directory, written with `/` and a `..`, is normalised and made verbatim.
        let deep = format!(r"C:\{}", vec!["d".repeat(30); 4].join(r"\"));
        check(
            &format!("{}/x/..", deep.replace('\\', "/")),
            &format!(r"\\?\{deep}"),
        );
        // A deep UNC directory.
        let share = format!(r"server\share\{}", "u".repeat(120));
        check(&format!(r"\\{share}"), &format!(r"\\?\UNC\{share}"));
        // Verbatim stays verbatim; a short verbatim path from `QD_DATA_DIR` is plain again after `simplified`.
        check(&format!(r"\\?\{deep}"), &format!(r"\\?\{deep}"));
        assert_eq!(
            long_path_safe(simplified(Path::new(r"\\?\C:\qd\data"))),
            PathBuf::from(r"C:\qd\data")
        );
        // A relative directory becomes absolute.
        let relative = verbatim_if_deep(PathBuf::from("qd-data"), DATA_TREE_RESERVE);
        assert!(
            relative.is_absolute() && relative.ends_with("qd-data"),
            "{relative:?}"
        );
    }

    /// SQLite's Win32 VFS cannot open a plain path longer than `MAX_PATH`; the verbatim data directory keeps startup,
    /// recovery and pack-depth databases working (the real app failed here with "unable to open database file").
    #[cfg(windows)]
    #[test]
    fn a_data_dir_deeper_than_max_path_opens_and_recovers() {
        let dir = TempDir::new().unwrap();
        let deep = (0..6).fold(dir.path().to_path_buf(), |path, i| {
            path.join(format!("{i}-{}", "d".repeat(40)))
        });
        let mut paths = temp_paths(&deep, deep.join("core.db"));
        assert!(paths.user_db().as_os_str().len() > 260);
        paths.data = long_path_safe(paths.data);
        paths.packs = paths.data.join("packs");
        write(&paths.user_db(), &garbage());

        let stores = open_stores(&paths, CorePolicy::Degrade).unwrap();
        let [StartupNotice::UserDbRecovered { quarantined_file }] = stores.notices.as_slice()
        else {
            panic!("notices: {:?}", stores.notices);
        };
        assert_eq!(std::fs::read(quarantined_file).unwrap(), garbage());
        assert_eq!(stores.user.settings_load().unwrap(), Settings::default());
        assert!(paths.content_db().is_file());

        // A database as deep as the reserve allows for: a pack with a long id and a 64-byte version directory.
        let pack_dir = paths
            .packs
            .join("translation")
            .join(format!("tr.{}", "x".repeat(36)))
            .join("v".repeat(64));
        std::fs::create_dir_all(&pack_dir).unwrap();
        let (pack, quarantined) = ContentDb::open_or_recover(&pack_dir.join("pack.db")).unwrap();
        assert!(quarantined.is_none());
        drop((pack, stores));
    }

    #[test]
    fn font_transport_per_platform_and_override_values() {
        assert_eq!(
            platform_font_transport(Platform::Windows),
            FontTransport::Url
        );
        assert_eq!(platform_font_transport(Platform::Macos), FontTransport::Url);
        assert_eq!(platform_font_transport(Platform::Linux), FontTransport::Url);
        assert_eq!(parse_font_transport("url"), Some(FontTransport::Url));
        assert_eq!(parse_font_transport(" Bytes "), Some(FontTransport::Bytes));
        assert_eq!(parse_font_transport("raw"), None);
        assert_eq!(parse_font_transport(""), None);
    }

    #[test]
    fn audio_ui_sink_helpers() {
        use quran_types::PlaybackStatus;

        assert_eq!(
            tray_now_playing(UiLanguage::En, "Al-Fatihah 1:2"),
            "Now: Al-Fatihah 1:2"
        );
        assert_eq!(
            tray_now_playing(UiLanguage::Ar, "الفاتحة ١:٢"),
            "الآن: الفاتحة ١:٢"
        );
        for (status, playing) in [
            (PlaybackStatus::Idle, false),
            (PlaybackStatus::Loading, true),
            (PlaybackStatus::Buffering, true),
            (PlaybackStatus::Playing, true),
            (PlaybackStatus::Paused, false),
            (PlaybackStatus::Error, false),
        ] {
            assert_eq!(crate::tray::is_playing(status), playing, "{status:?}");
        }
        for lang in [UiLanguage::En, UiLanguage::Ar] {
            assert_eq!(lang_from_code(lang_code(lang)), lang);
        }
    }

    /// A library saved by a newer version gets its own text (nothing was changed; update the app), not the generic
    /// "reinstalling usually fixes this".
    #[test]
    fn a_newer_library_has_its_own_fatal_text() {
        let newer = Fatal::Database {
            name: "user.db",
            source: CoreError::NewerSchema {
                found: 3,
                supported: 2,
            },
        };
        for lang in [UiLanguage::En, UiLanguage::Ar] {
            assert_eq!(
                fatal_body(lang, &newer),
                i18n::text(lang, RustText::StartupNewerLibrary)
            );
        }
        let other = Fatal::Database {
            name: "content.db",
            source: CoreError::Corrupt("x".into()),
        };
        let body = fatal_body(UiLanguage::En, &other);
        assert!(
            body.contains("content.db") && body.contains("Reinstalling"),
            "{body}"
        );
    }

    #[test]
    fn the_build_policy_degrades_only_in_debug_builds() {
        assert_eq!(
            CorePolicy::for_build(),
            if cfg!(debug_assertions) {
                CorePolicy::Degrade
            } else {
                CorePolicy::Fatal
            }
        );
    }
}
