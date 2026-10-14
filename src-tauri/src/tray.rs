//! System tray: the mini-player menu, the "Now: {ref}" label, the tooltip and the one-time "still running in the tray"
//! notice.
//!
//! Menu, top to bottom: `Now: {ref}` (disabled, present only while a recitation is loaded) · separator · Play/Pause ·
//! Previous ayah · Next ayah · separator · Show Quran · separator · Quit. Transport items are disabled while
//! nothing is loaded; the play/pause label follows the playback state. Left click (Windows) or double click shows the
//! main window; on macOS a click opens the menu, as for every status item. Linux (AppIndicator) has no click events and
//! no tooltip, only the menu.
//!
//! Threading. `tray_icon::TrayIcon` is a reference-counted main-thread object, and tauri's menu setters block their
//! caller until the main thread has run them. The hooks are called from the audio thread (`set_now_playing`, on every
//! ayah edge), from async command tasks (`window::apply_settings`) and from dialog threads, while the main thread may
//! itself be joining the audio threads during shutdown, so a blocking call could deadlock and an off-thread drop would
//! leak the icon's window. Therefore every tray object is created, updated and dropped **on the main thread only**:
//! callers store the wanted [`TrayModel`] in the managed `TrayState` and queue one coalesced, non-blocking main-thread
//! job, which pushes only what changed (a [`TrayView`] diff). A job queued from the main thread runs at once.
//!
//! Icons: Windows gets the colour `tray-{16,20,24,32}.png` matching the taskbar's DPI; Linux the 32 px `tray.png`;
//! macOS the 36 px black template image (`icon_as_template`), drawn at the menu bar's 18 pt.
//!
//! Linux: `tray-icon` loads libayatana-appindicator (or libappindicator) on first use and **panics** when neither
//! exists, which is an abort under `panic = "abort"`. [`build`] therefore checks for the library first and returns an
//! error (logged by the caller) instead of crashing: the app then runs without a tray, and closing the window quits.
//! Installed packages should carry the library (a deb dependency, an AppImage library).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use media_session::MediaCommand;
use parking_lot::Mutex;
use quran_types::{AudioSnapshot, PlaybackStatus, UiLanguage};
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Listener, Manager, Runtime};

use crate::i18n::{self, RustText};
use crate::state::AppState;

/// The tray icon's id (`AppHandle::tray_by_id`).
pub const TRAY_ID: &str = "qd-tray";

/// Menu item ids. Tray menu events arrive through tauri's global menu listener, so they carry a unique prefix.
mod ids {
    pub const NOW: &str = "qd-tray.now";
    pub const PLAY_PAUSE: &str = "qd-tray.play-pause";
    pub const PREVIOUS: &str = "qd-tray.previous";
    pub const NEXT: &str = "qd-tray.next";
    pub const SHOW: &str = "qd-tray.show";
    pub const QUIT: &str = "qd-tray.quit";
}

/// Windows tooltips hold 127 UTF-16 units plus the terminator (`NOTIFYICONDATAW::szTip`).
const TOOLTIP_MAX_UTF16: usize = 127;

/// What the tray should show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayModel {
    pub lang: UiLanguage,
    /// The localised "Now: {ref}" label while a recitation is loaded (`None`: nothing is loaded).
    pub now: Option<String>,
    /// Playback is running or about to (playing, loading, buffering): the transport item offers "Pause".
    pub playing: bool,
    /// The recitation failed (`error` with an ayah loaded): "Play" starts it again where it stopped, and Previous and
    /// Next, which the engine serves within a running play only, are not offered.
    pub failed: bool,
}

impl TrayModel {
    /// The model for an audio snapshot; `title` is `media::NowPlaying::title` (absent when nothing is loaded).
    #[must_use]
    pub fn from_snapshot(lang: UiLanguage, snapshot: &AudioSnapshot, title: Option<&str>) -> Self {
        let now = snapshot
            .current
            .is_some()
            .then(|| i18n::now_playing(lang, title.unwrap_or_default()));
        Self::new(lang, now, snapshot.status)
    }

    /// The model for the "Now: {ref}" label `now` (`None`: nothing is loaded) and the engine's `status`.
    #[must_use]
    pub fn new(lang: UiLanguage, now: Option<String>, status: PlaybackStatus) -> Self {
        let loaded = now.is_some();
        Self {
            lang,
            now,
            playing: loaded && is_playing(status),
            failed: loaded && status == PlaybackStatus::Error,
        }
    }

    /// Nothing loaded.
    #[must_use]
    pub fn idle(lang: UiLanguage) -> Self {
        Self::new(lang, None, PlaybackStatus::Idle)
    }
}

/// Whether the tray offers "Pause" (playback is running or about to) rather than "Play".
#[must_use]
pub const fn is_playing(status: PlaybackStatus) -> bool {
    matches!(
        status,
        PlaybackStatus::Playing | PlaybackStatus::Loading | PlaybackStatus::Buffering
    )
}

/// One menu item's text and enabled state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemView {
    pub text: String,
    pub enabled: bool,
}

impl ItemView {
    fn new(text: impl Into<String>, enabled: bool) -> Self {
        Self {
            text: text.into(),
            enabled,
        }
    }
}

/// Everything the OS objects show for a [`TrayModel`]. Pure: unit-tested, and diffed so that an update pushes only
/// what changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    /// The disabled first item (and its separator), present only while a recitation is loaded.
    pub now: Option<String>,
    pub play_pause: ItemView,
    pub previous: ItemView,
    pub next: ItemView,
    pub show: ItemView,
    pub quit: ItemView,
    pub tooltip: String,
}

impl TrayView {
    /// The view of `model`; the app's name in the model's language heads the tooltip.
    #[must_use]
    pub fn of(model: &TrayModel) -> Self {
        let lang = model.lang;
        let app_name = i18n::text(lang, RustText::AppName);
        let loaded = model.now.is_some();
        let transport = if !loaded {
            RustText::TrayPlayPause
        } else if model.playing {
            RustText::TrayPause
        } else {
            RustText::TrayPlay
        };
        let tooltip = match &model.now {
            Some(now) => format!("{app_name}\n{now}"),
            None => app_name.to_owned(),
        };
        let skips = loaded && !model.failed;
        Self {
            now: model.now.as_deref().map(menu_text),
            play_pause: ItemView::new(i18n::text(lang, transport), loaded),
            previous: ItemView::new(i18n::text(lang, RustText::TrayPrevious), skips),
            next: ItemView::new(i18n::text(lang, RustText::TrayNext), skips),
            show: ItemView::new(i18n::text(lang, RustText::TrayShow), true),
            quit: ItemView::new(i18n::text(lang, RustText::TrayQuit), true),
            tooltip: truncate_utf16(&tooltip, TOOLTIP_MAX_UTF16),
        }
    }
}

/// Menu texts treat `&` as a mnemonic marker: a literal one is doubled.
#[must_use]
pub fn menu_text(label: &str) -> String {
    label.replace('&', "&&")
}

/// `s` cut to at most `max` UTF-16 units at a character boundary, with an ellipsis when cut.
#[must_use]
pub fn truncate_utf16(s: &str, max: usize) -> String {
    if s.encode_utf16().count() <= max {
        return s.to_owned();
    }
    let budget = max.saturating_sub(1); // room for '…' (one UTF-16 unit)
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > budget {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

/// Builds the tray (setup, when `settings.show_tray_icon`; `window::apply_settings` when it is switched on). A no-op
/// when the tray already exists. On the main thread (setup) the tray is built at once and its error, if any, returned;
/// from another thread the build is queued for the main thread, which logs a failure itself.
pub fn build<R: Runtime>(app: &AppHandle<R>, lang: UiLanguage) -> tauri::Result<()> {
    platform::ensure_supported()?;
    let slot = Arc::new(Mutex::new(BuildSlot::Waiting));
    let answer = Arc::clone(&slot);
    on_main(app, move |app| {
        let result = build_on_main(app, lang);
        let mut answer = answer.lock();
        match (&*answer, result) {
            (BuildSlot::Abandoned, Err(e)) => log::warn!("tray: {e}"),
            (BuildSlot::Abandoned, Ok(())) => {}
            (_, result) => *answer = BuildSlot::Done(result),
        }
    })?;
    let mut slot = slot.lock();
    match std::mem::replace(&mut *slot, BuildSlot::Abandoned) {
        BuildSlot::Done(result) => result,
        // Still queued: the main thread logs its own failure.
        BuildSlot::Waiting | BuildSlot::Abandoned => Ok(()),
    }
}

/// The hand-over between [`build`] and its main-thread job.
enum BuildSlot {
    Waiting,
    Abandoned,
    Done(tauri::Result<()>),
}

/// The build itself (main thread).
fn build_on_main<R: Runtime>(app: &AppHandle<R>, lang: UiLanguage) -> tauri::Result<()> {
    let state = tray_state(app);
    if state.exists.load(Ordering::Acquire) {
        return Ok(());
    }
    let model = current_model(app, lang);
    let view = TrayView::of(&model);
    let item =
        |id: &str, v: &ItemView| MenuItem::with_id(app, id, &v.text, v.enabled, None::<&str>);
    let items = LiveItems {
        now: MenuItem::with_id(
            app,
            ids::NOW,
            view.now.as_deref().unwrap_or_default(),
            false,
            None::<&str>,
        )?,
        now_separator: PredefinedMenuItem::separator(app)?,
        play_pause: item(ids::PLAY_PAUSE, &view.play_pause)?,
        previous: item(ids::PREVIOUS, &view.previous)?,
        next: item(ids::NEXT, &view.next)?,
        show: item(ids::SHOW, &view.show)?,
        quit: item(ids::QUIT, &view.quit)?,
    };
    let menu = Menu::with_items(
        app,
        &[
            &items.play_pause,
            &items.previous,
            &items.next,
            &PredefinedMenuItem::separator(app)?,
            &items.show,
            &PredefinedMenuItem::separator(app)?,
            &items.quit,
        ],
    )?;
    if view.now.is_some() {
        menu.prepend_items(&[&items.now, &items.now_separator])?;
    }
    let icon = TrayIconBuilder::with_id(TRAY_ID)
        .icon(platform::icon()?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(&view.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?;
    *state.live.lock() = Some(LiveTray {
        icon,
        menu,
        items,
        shown: view,
    });
    *state.wanted.lock() = model;
    state.exists.store(true, Ordering::Release);
    follow_audio_events(app, &state);
    log::debug!("tray built");
    Ok(())
}

/// Removes the tray (`show_tray_icon` switched off, and at exit so that no stale icon stays in the notification
/// area).
pub fn remove<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<TrayState<R>>() else {
        return;
    };
    if !state.exists.swap(false, Ordering::AcqRel) {
        return;
    }
    let removed = on_main(app, |app| {
        if let Some(state) = app.try_state::<TrayState<R>>() {
            drop(state.live.lock().take());
        }
        drop(app.remove_tray_by_id(TRAY_ID));
        log::debug!("tray removed");
    });
    if let Err(e) = removed {
        log::warn!("tray: cannot remove the icon: {e}");
    }
}

/// Re-labels the menu after a `ui_language` change, re-localising the "Now: {ref}" label from the current snapshot.
/// Call it after `media::on_ui_language_changed`, which switches the language of the surah names it uses.
pub fn relabel<R: Runtime>(app: &AppHandle<R>, lang: UiLanguage) {
    let Some(state) = app.try_state::<TrayState<R>>() else {
        return;
    };
    if !state.exists.load(Ordering::Acquire) {
        return;
    }
    *state.wanted.lock() = current_model(app, lang);
    schedule(app, &state);
}

/// Updates the "Now: {ref}" item, the play/pause label and the skips for the engine's `status` (`label`: the
/// localised "Now: {ref}" text, `None` when nothing is loaded). Cheap and non-blocking (safe on the audio thread); a
/// no-op without a tray.
pub fn set_now_playing<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<String>,
    status: PlaybackStatus,
) {
    let Some(state) = app.try_state::<TrayState<R>>() else {
        return;
    };
    if !state.exists.load(Ordering::Acquire) {
        return;
    }
    {
        let mut wanted = state.wanted.lock();
        let next = TrayModel::new(wanted.lang, label, status);
        if *wanted == next {
            return;
        }
        *wanted = next;
    }
    schedule(app, &state);
}

/// Shows the one-time "still playing / still running in the tray" notice as a notification from the tray icon (on the
/// main thread), then calls `on_shown`. Only Windows has tray notifications (macOS keeps its Dock icon and AppIndicator
/// has none), so elsewhere `on_shown` is never called.
pub fn notify_still_running<R: Runtime>(
    app: &AppHandle<R>,
    lang: UiLanguage,
    playing: bool,
    on_shown: impl FnOnce() + Send + 'static,
) {
    if !exists(app) {
        return;
    }
    let body = i18n::text(
        lang,
        if playing {
            RustText::TrayStillPlaying
        } else {
            RustText::TrayStillRunning
        },
    );
    let title = i18n::text(lang, RustText::AppName);
    let scheduled = on_main(app, move |app| {
        let Some(icon) = app.tray_by_id(TRAY_ID) else {
            return;
        };
        if platform::notify(&icon, title, body) {
            on_shown();
        }
    });
    if let Err(e) = scheduled {
        log::debug!("tray: notice not scheduled: {e}");
    }
}

/// Whether the tray icon exists.
#[must_use]
pub fn exists<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<TrayState<R>>()
        .is_some_and(|s| s.exists.load(Ordering::Acquire))
}

/// Re-picks the icon for the taskbar's current DPI (Windows; a no-op elsewhere). Called on a scale-factor change.
pub fn refresh_icon<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(windows) || !exists(app) {
        return;
    }
    let scheduled = on_main(app, |app| {
        let Some(icon) = app.tray_by_id(TRAY_ID) else {
            return;
        };
        let refreshed = platform::icon().and_then(|image| icon.set_icon(Some(image)));
        if let Err(e) = refreshed {
            log::debug!("tray: icon not refreshed: {e}");
        }
    });
    if let Err(e) = scheduled {
        log::debug!("tray: icon refresh not scheduled: {e}");
    }
}

/// Runs `job` on the main thread: at once when called there, else queued (it never waits).
fn on_main<R: Runtime>(
    app: &AppHandle<R>,
    job: impl FnOnce(&AppHandle<R>) + Send + 'static,
) -> tauri::Result<()> {
    let handle = app.clone();
    app.run_on_main_thread(move || job(&handle))
}

/// The model for the current audio snapshot.
fn current_model<R: Runtime>(app: &AppHandle<R>, lang: UiLanguage) -> TrayModel {
    let Some(state) = app.try_state::<AppState>() else {
        return TrayModel::idle(lang);
    };
    let snapshot = state.audio.snapshot();
    let title = crate::media::now_playing(app, &snapshot).map(|n| n.title);
    TrayModel::from_snapshot(lang, &snapshot, title.as_deref())
}

/// The tray follows `audio-state-changed` itself, so its labels are right whether or not the audio service's UI sink
/// also calls [`set_now_playing`] (both derive the same model; an unchanged model costs nothing). Registered once.
fn follow_audio_events<R: Runtime>(app: &AppHandle<R>, state: &TrayState<R>) {
    if state.listening.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    app.listen(
        <crate::ipc::events::AudioStateChanged as tauri_specta::Event>::NAME,
        move |event| match serde_json::from_str::<AudioSnapshot>(event.payload()) {
            Ok(snapshot) => on_audio_snapshot(&handle, &snapshot),
            Err(e) => log::debug!("tray: unreadable audio-state-changed payload: {e}"),
        },
    );
}

fn on_audio_snapshot<R: Runtime>(app: &AppHandle<R>, snapshot: &AudioSnapshot) {
    let Some(state) = app.try_state::<TrayState<R>>() else {
        return;
    };
    if !state.exists.load(Ordering::Acquire) {
        return;
    }
    let lang = state.wanted.lock().lang;
    let title = crate::media::now_playing(app, snapshot).map(|n| n.title);
    let next = TrayModel::from_snapshot(lang, snapshot, title.as_deref());
    set_now_playing(app, next.now, snapshot.status);
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        ids::SHOW => crate::window::show_main(app),
        ids::PLAY_PAUSE => media_command(app, MediaCommand::Toggle),
        ids::PREVIOUS => media_command(app, MediaCommand::Previous),
        ids::NEXT => media_command(app, MediaCommand::Next),
        ids::QUIT => crate::window::quit(app),
        _ => {} // another menu's item (the macOS app menu shares the global listener)
    }
}

fn on_tray_icon_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    // macOS opens the menu on a click (status-item convention); Linux emits no click events.
    if cfg!(target_os = "macos") {
        return;
    }
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
        | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => crate::window::show_main(tray.app_handle()),
        _ => {}
    }
}

fn media_command<R: Runtime>(app: &AppHandle<R>, cmd: MediaCommand) {
    if let Some(state) = app.try_state::<AppState>() {
        state.audio.handle_media_command(cmd);
    }
}

/// Managed lazily by the first tray call (one per runtime type).
struct TrayState<R: Runtime> {
    /// What the tray should show; written from any thread.
    wanted: Mutex<TrayModel>,
    /// The OS objects; created, updated and dropped on the main thread only (see the module docs).
    live: Mutex<Option<LiveTray<R>>>,
    /// Mirrors `live.is_some()` for callers off the main thread.
    exists: AtomicBool,
    /// A main-thread update is queued (coalescing).
    pending: AtomicBool,
    /// `audio-state-changed` is followed.
    listening: AtomicBool,
}

impl<R: Runtime> Default for TrayState<R> {
    fn default() -> Self {
        Self {
            wanted: Mutex::new(TrayModel::idle(UiLanguage::En)),
            live: Mutex::new(None),
            exists: AtomicBool::new(false),
            pending: AtomicBool::new(false),
            listening: AtomicBool::new(false),
        }
    }
}

fn tray_state<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, TrayState<R>> {
    if app.try_state::<TrayState<R>>().is_none() {
        app.manage(TrayState::<R>::default());
    }
    app.state::<TrayState<R>>()
}

/// Queues one main-thread job that applies the latest wanted model (coalesced: a burst of updates runs it once).
fn schedule<R: Runtime>(app: &AppHandle<R>, state: &TrayState<R>) {
    if state.pending.swap(true, Ordering::AcqRel) {
        return;
    }
    let scheduled = on_main(app, |app| {
        let Some(state) = app.try_state::<TrayState<R>>() else {
            return;
        };
        // Clear first: a model stored after this point queues a new job.
        state.pending.store(false, Ordering::Release);
        let model = state.wanted.lock().clone();
        if let Some(tray) = state.live.lock().as_mut() {
            tray.apply(TrayView::of(&model));
        }
    });
    if let Err(e) = scheduled {
        state.pending.store(false, Ordering::Release);
        log::debug!("tray: update not scheduled: {e}");
    }
}

struct LiveItems<R: Runtime> {
    now: MenuItem<R>,
    now_separator: PredefinedMenuItem<R>,
    play_pause: MenuItem<R>,
    previous: MenuItem<R>,
    next: MenuItem<R>,
    show: MenuItem<R>,
    quit: MenuItem<R>,
}

/// The OS tray objects and what they currently show.
struct LiveTray<R: Runtime> {
    icon: TrayIcon<R>,
    menu: Menu<R>,
    items: LiveItems<R>,
    shown: TrayView,
}

impl<R: Runtime> LiveTray<R> {
    /// Pushes the differences between what is shown and `next` (main thread only). Failures are logged; the view is
    /// remembered either way, so a failed item is retried on its next change.
    fn apply(&mut self, next: TrayView) {
        let shown = &self.shown;
        let items = &self.items;
        let mut failures = Vec::new();
        for (item, before, after) in [
            (&items.play_pause, &shown.play_pause, &next.play_pause),
            (&items.previous, &shown.previous, &next.previous),
            (&items.next, &shown.next, &next.next),
            (&items.show, &shown.show, &next.show),
            (&items.quit, &shown.quit, &next.quit),
        ] {
            if before.text != after.text
                && let Err(e) = item.set_text(&after.text)
            {
                failures.push(e);
            }
            if before.enabled != after.enabled
                && let Err(e) = item.set_enabled(after.enabled)
            {
                failures.push(e);
            }
        }
        match (&shown.now, &next.now) {
            (None, Some(text)) => {
                let inserted = items
                    .now
                    .set_text(text)
                    .and_then(|()| self.menu.prepend_items(&[&items.now, &items.now_separator]));
                if let Err(e) = inserted {
                    failures.push(e);
                }
            }
            (Some(_), None) => {
                let removed = [&items.now as &dyn IsMenuItem<R>, &items.now_separator]
                    .into_iter()
                    .try_for_each(|item| self.menu.remove(item));
                if let Err(e) = removed {
                    failures.push(e);
                }
            }
            (Some(before), Some(after)) if before != after => {
                if let Err(e) = items.now.set_text(after) {
                    failures.push(e);
                }
            }
            _ => {}
        }
        if shown.tooltip != next.tooltip
            && let Err(e) = self.icon.set_tooltip(Some(&next.tooltip))
        {
            failures.push(e);
        }
        for e in failures {
            log::debug!("tray: update failed: {e}");
        }
        self.shown = next;
    }
}

#[cfg(windows)]
mod platform {
    //! Windows: DPI-matched colour icons and the tray notification (`NIF_INFO`, shown as a toast on Windows 10/11).

    use tauri::Runtime;
    use tauri::image::Image;
    use tauri::tray::TrayIcon;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow};
    use windows::Win32::UI::Shell::{
        NIF_INFO, NIIF_NONE, NIIF_RESPECT_QUIET_TIME, NIM_MODIFY, NOTIFYICONDATAW,
        Shell_NotifyIconW,
    };
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use windows::core::{PCWSTR, w};

    pub(super) const TRAY_16: &[u8] = include_bytes!("../icons/tray/tray-16.png");
    pub(super) const TRAY_20: &[u8] = include_bytes!("../icons/tray/tray-20.png");
    pub(super) const TRAY_24: &[u8] = include_bytes!("../icons/tray/tray-24.png");
    pub(super) const TRAY_32: &[u8] = include_bytes!("../icons/tray/tray-32.png");

    /// `tray-icon` gives each icon its own hidden window and a small per-process id that it does not expose, so the
    /// notification probes ids on the icon's window; the shell rejects a wrong `(window, id)` pair harmlessly.
    const MAX_ICON_ID: u32 = 64;

    #[allow(clippy::unnecessary_wraps)] // one signature for every platform
    pub fn ensure_supported() -> tauri::Result<()> {
        Ok(())
    }

    pub fn icon() -> tauri::Result<Image<'static>> {
        Image::from_bytes(png_for_dpi(taskbar_dpi()))
    }

    /// The DPI of the primary taskbar (which holds the notification area), else the system DPI.
    fn taskbar_dpi() -> u32 {
        // SAFETY: plain Win32 queries with a constant, NUL-terminated class name; nothing is retained.
        unsafe {
            FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null())
                .ok()
                .map(|taskbar| GetDpiForWindow(taskbar))
                .filter(|dpi| *dpi > 0)
                .unwrap_or_else(|| GetDpiForSystem())
        }
    }

    /// The PNG for [`side_for_dpi`].
    pub fn png_for_dpi(dpi: u32) -> &'static [u8] {
        match side_for_dpi(dpi) {
            16 => TRAY_16,
            20 => TRAY_20,
            24 => TRAY_24,
            _ => TRAY_32,
        }
    }

    /// The smallest icon at least as large as the notification-area icon at `dpi` (16 px at 96 DPI), so the shell only
    /// ever scales down; 32 px beyond 200 %.
    pub fn side_for_dpi(dpi: u32) -> u32 {
        let wanted = (16 * dpi.max(96)).div_ceil(96);
        [16, 20, 24, 32]
            .into_iter()
            .find(|&side| side >= wanted)
            .unwrap_or(32)
    }

    pub fn notify<R: Runtime>(icon: &TrayIcon<R>, title: &str, body: &str) -> bool {
        let hwnd = match icon.with_inner_tray_icon(|inner| inner.window_handle() as isize) {
            Ok(hwnd) if hwnd != 0 => hwnd,
            Ok(_) => return false,
            Err(e) => {
                log::debug!("tray: no icon window for the notice: {e}");
                return false;
            }
        };
        let mut data = NOTIFYICONDATAW {
            cbSize: u32::try_from(size_of::<NOTIFYICONDATAW>()).unwrap_or(u32::MAX),
            hWnd: HWND(hwnd as *mut core::ffi::c_void),
            uFlags: NIF_INFO,
            dwInfoFlags: NIIF_NONE | NIIF_RESPECT_QUIET_TIME,
            ..NOTIFYICONDATAW::default()
        };
        copy_wide(&mut data.szInfoTitle, title);
        copy_wide(&mut data.szInfo, body);
        let shown = (0..=MAX_ICON_ID).any(|id| {
            data.uID = id;
            // SAFETY: `data` is a fully initialised NOTIFYICONDATAW carrying its true size; the shell copies it.
            unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) }.as_bool()
        });
        if !shown {
            log::debug!("tray: the shell did not accept the notification");
        }
        shown
    }

    /// Copies `s` into a fixed UTF-16 buffer, cut at a character boundary and always NUL-terminated.
    pub(super) fn copy_wide<const N: usize>(buf: &mut [u16; N], s: &str) {
        let mut at = 0;
        for c in s.chars() {
            let mut units = [0_u16; 2];
            let encoded = c.encode_utf16(&mut units);
            if at + encoded.len() >= N {
                break;
            }
            for unit in encoded.iter() {
                if let Some(slot) = buf.get_mut(at) {
                    *slot = *unit;
                }
                at += 1;
            }
        }
        if let Some(slot) = buf.get_mut(at) {
            *slot = 0;
        }
    }
}

// The macOS and Linux modules use only std and tauri, so they compile (and are unit-tested) on every OS; `platform` is
// the one of the running OS.
#[cfg(not(any(windows, target_os = "macos")))]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macos {
    //! macOS: the black template image, tinted by the menu bar; no tray notifications.

    use tauri::Runtime;
    use tauri::image::Image;
    use tauri::tray::TrayIcon;

    pub(super) const TEMPLATE: &[u8] = include_bytes!("../icons/tray/tray-template@2x.png");

    #[allow(clippy::unnecessary_wraps)] // one signature for every platform
    pub fn ensure_supported() -> tauri::Result<()> {
        Ok(())
    }

    pub fn icon() -> tauri::Result<Image<'static>> {
        Image::from_bytes(TEMPLATE)
    }

    pub fn notify<R: Runtime>(_icon: &TrayIcon<R>, _title: &str, _body: &str) -> bool {
        false
    }
}

#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
mod linux {
    //! Linux and the BSDs: AppIndicator (through `tray-icon`), the colour icon, no tray notifications.

    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    use tauri::Runtime;
    use tauri::image::Image;
    use tauri::tray::TrayIcon;

    pub(super) const TRAY: &[u8] = include_bytes!("../icons/tray/tray.png");

    /// The sonames `libappindicator-sys` loads, in its order.
    pub(super) const SONAMES: [&str; 2] =
        ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];

    /// `tray-icon` panics (an abort in release) when neither AppIndicator library loads, so the tray is only built
    /// when one of them is on the loader's search path.
    pub fn ensure_supported() -> tauri::Result<()> {
        let dirs = search_dirs(
            std::env::var_os("LD_LIBRARY_PATH"),
            std::env::var_os("APPDIR"),
            Path::new("/etc/ld.so.conf"),
        );
        check(&dirs)
    }

    pub(super) fn check(dirs: &[PathBuf]) -> tauri::Result<()> {
        match super::find_library(&SONAMES, dirs) {
            Some(path) => {
                log::debug!("tray: AppIndicator at {}", path.display());
                Ok(())
            }
            None => Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no AppIndicator library (libayatana-appindicator3 or libappindicator3); the tray needs one",
            ))),
        }
    }

    pub fn icon() -> tauri::Result<Image<'static>> {
        Image::from_bytes(TRAY)
    }

    pub fn notify<R: Runtime>(_icon: &TrayIcon<R>, _title: &str, _body: &str) -> bool {
        false
    }

    /// The dynamic loader's search path, approximately: `LD_LIBRARY_PATH`, the AppImage's own libraries (`APPDIR`),
    /// the directories of `ld.so.conf` (with its `include` files), then the standard ones.
    pub(super) fn search_dirs(
        ld_library_path: Option<OsString>,
        appdir: Option<OsString>,
        ld_so_conf: &Path,
    ) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Some(paths) = ld_library_path {
            dirs.extend(std::env::split_paths(&paths).filter(|p| !p.as_os_str().is_empty()));
        }
        if let Some(appdir) = appdir.filter(|a| !a.is_empty()) {
            let appdir = PathBuf::from(appdir);
            dirs.push(appdir.join("usr/lib"));
            dirs.push(appdir.join("usr/lib64"));
        }
        dirs.extend(super::ld_so_conf_dirs(ld_so_conf));
        dirs.extend(
            [
                "/usr/local/lib",
                "/usr/lib/x86_64-linux-gnu",
                "/usr/lib/aarch64-linux-gnu",
                "/lib/x86_64-linux-gnu",
                "/lib/aarch64-linux-gnu",
                "/usr/lib64",
                "/lib64",
                "/usr/lib",
                "/lib",
            ]
            .map(PathBuf::from),
        );
        dirs
    }
}

/// The first `dir/soname` that exists, trying every soname in each directory in order.
fn find_library(sonames: &[&str], dirs: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    dirs.iter()
        .flat_map(|dir| sonames.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
}

/// The library directories of an `ld.so.conf`-style file, following its `include` lines (a file, or a `dir/*suffix`
/// glob, the only form distributions use) one level deep.
fn ld_so_conf_dirs(conf: &std::path::Path) -> Vec<std::path::PathBuf> {
    use std::path::{Path, PathBuf};

    fn parse(text: &str, dirs: &mut Vec<PathBuf>, includes: &mut Vec<String>) {
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or_default().trim();
            if let Some(pattern) = line.strip_prefix("include") {
                includes.push(pattern.trim().to_owned());
            } else if line.starts_with('/') {
                dirs.push(PathBuf::from(line));
            }
        }
    }
    fn read(path: &Path, dirs: &mut Vec<PathBuf>) {
        if let Ok(text) = std::fs::read_to_string(path) {
            parse(&text, dirs, &mut Vec::new());
        }
    }

    let mut dirs = Vec::new();
    let mut includes = Vec::new();
    if let Ok(text) = std::fs::read_to_string(conf) {
        parse(&text, &mut dirs, &mut includes);
    }
    let base = conf.parent().unwrap_or_else(|| Path::new("/"));
    for pattern in includes {
        let pattern = base.join(pattern); // an absolute pattern replaces the base
        let (Some(dir), Some(name)) = (pattern.parent(), pattern.file_name()) else {
            continue;
        };
        let name = name.to_string_lossy();
        let Some(suffix) = name.strip_prefix('*') else {
            read(&pattern, &mut dirs);
            continue;
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().ends_with(suffix))
            .collect();
        files.sort();
        for file in files {
            read(&file, &mut dirs);
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use quran_audio::shared::idle_snapshot;
    use quran_types::AyahRef;
    use tauri::test::{MockRuntime, mock_app};

    use super::*;

    fn snapshot(status: PlaybackStatus, loaded: bool) -> AudioSnapshot {
        AudioSnapshot {
            status,
            current: loaded.then_some(AyahRef {
                surah: 2,
                ayah: 255,
            }),
            ..idle_snapshot()
        }
    }

    #[test]
    fn idle_view_disables_the_transport_and_has_no_now_item() {
        let model =
            TrayModel::from_snapshot(UiLanguage::En, &snapshot(PlaybackStatus::Idle, false), None);
        assert_eq!(model.now, None);
        assert!(!model.playing);
        let view = TrayView::of(&model);
        assert_eq!(view.now, None);
        assert_eq!(view.play_pause, ItemView::new("Play / Pause", false));
        assert!(!view.previous.enabled && !view.next.enabled);
        assert_eq!(view.show, ItemView::new("Show Quran", true));
        assert_eq!(view.quit, ItemView::new("Quit", true));
        assert_eq!(view.tooltip, "Quran");
    }

    #[test]
    fn playing_and_paused_views() {
        // A failed recitation (error with an ayah loaded) offers Play, which starts it again where it stopped, and no
        // skips (the engine serves them within a running play).
        for (status, label, playing, skips) in [
            (PlaybackStatus::Playing, "Pause", true, true),
            (PlaybackStatus::Loading, "Pause", true, true),
            (PlaybackStatus::Buffering, "Pause", true, true),
            (PlaybackStatus::Paused, "Play", false, true),
            (PlaybackStatus::Error, "Play", false, false),
        ] {
            let model = TrayModel::from_snapshot(
                UiLanguage::En,
                &snapshot(status, true),
                Some("Al-Baqarah 2:255"),
            );
            assert_eq!(model.playing, playing, "{status:?}");
            let view = TrayView::of(&model);
            assert_eq!(view.now.as_deref(), Some("Now: Al-Baqarah 2:255"));
            assert_eq!(view.play_pause, ItemView::new(label, true), "{status:?}");
            assert_eq!(
                (view.previous.enabled, view.next.enabled),
                (skips, skips),
                "{status:?}"
            );
            assert_eq!(view.tooltip, "Quran\nNow: Al-Baqarah 2:255");
        }
        // A status that claims playback with nothing loaded is not "playing".
        let odd = TrayModel::from_snapshot(
            UiLanguage::En,
            &snapshot(PlaybackStatus::Playing, false),
            None,
        );
        assert!(!odd.playing);
    }

    #[test]
    fn arabic_view() {
        let model = TrayModel::from_snapshot(
            UiLanguage::Ar,
            &snapshot(PlaybackStatus::Playing, true),
            Some("البقرة ٢:٢٥٥"),
        );
        let view = TrayView::of(&model);
        assert_eq!(view.now.as_deref(), Some("الآن: البقرة ٢:٢٥٥"));
        assert_eq!(view.play_pause.text, "إيقاف مؤقت");
        assert_eq!(view.next.text, "الآية التالية");
        assert_eq!(view.quit.text, "خروج");
        // The app's Arabic name heads the tooltip.
        assert_eq!(view.tooltip, "قرآن\nالآن: البقرة ٢:٢٥٥");
    }

    #[test]
    fn labels_escape_mnemonics_and_tooltips_fit_windows() {
        assert_eq!(menu_text("A & B"), "A && B");
        let model = TrayModel {
            lang: UiLanguage::En,
            now: Some(format!("Now: {}", "x".repeat(300))),
            playing: true,
            failed: false,
        };
        let tooltip = TrayView::of(&model).tooltip;
        assert_eq!(tooltip.encode_utf16().count(), TOOLTIP_MAX_UTF16);
        assert!(tooltip.ends_with('…'));
        assert_eq!(truncate_utf16("short", 10), "short");
        // A surrogate pair is never split.
        assert_eq!(truncate_utf16("ab\u{1F54C}cd", 4), "ab…");
        assert_eq!(truncate_utf16("ab\u{1F54C}cd", 5), "ab\u{1F54C}…");
    }

    #[test]
    fn hooks_are_no_ops_without_a_tray() {
        let app = mock_app();
        let handle = app.handle();
        set_now_playing(handle, Some("Now: x".to_owned()), PlaybackStatus::Playing);
        relabel(handle, UiLanguage::Ar);
        remove(handle);
        refresh_icon(handle);
        notify_still_running(handle, UiLanguage::En, true, || {
            panic!("no tray, no notice")
        });
        assert!(!exists(handle));
        // Only an empty state was managed.
        let state = tray_state::<MockRuntime>(handle);
        assert!(state.live.lock().is_none());
        assert!(!state.pending.load(Ordering::Acquire));
    }

    #[test]
    fn updates_coalesce_and_keep_the_language() {
        let app = mock_app();
        let handle = app.handle();
        let state = tray_state::<MockRuntime>(handle);
        // A tray without OS objects: the queued job finds `live` empty and only clears `pending`.
        state.exists.store(true, Ordering::Release);
        state.wanted.lock().lang = UiLanguage::Ar;
        set_now_playing(
            handle,
            Some("Now: Al-Fatihah 1:1".to_owned()),
            PlaybackStatus::Playing,
        );
        set_now_playing(
            handle,
            Some("Now: Al-Fatihah 1:2".to_owned()),
            PlaybackStatus::Playing,
        );
        let wanted = state.wanted.lock().clone();
        assert_eq!(wanted.now.as_deref(), Some("Now: Al-Fatihah 1:2"));
        assert!(wanted.playing);
        assert_eq!(wanted.lang, UiLanguage::Ar);
        assert!(!state.pending.load(Ordering::Acquire), "the job ran");
        // A failed recitation: Play, no skips.
        set_now_playing(
            handle,
            Some("Now: Al-Fatihah 1:2".to_owned()),
            PlaybackStatus::Error,
        );
        let wanted = state.wanted.lock().clone();
        assert!(wanted.failed && !wanted.playing);
        // `playing` without a label is not playing.
        set_now_playing(handle, None, PlaybackStatus::Playing);
        assert_eq!(*state.wanted.lock(), TrayModel::idle(UiLanguage::Ar));
        // Removing a tray without OS objects is clean too.
        remove(handle);
        assert!(!exists(handle));
    }

    #[test]
    fn library_lookup_follows_the_search_order() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let names = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];
        assert_eq!(find_library(&names, &[a.clone(), b.clone()]), None);
        std::fs::write(b.join("libappindicator3.so.1"), b"").unwrap();
        assert_eq!(
            find_library(&names, &[a.clone(), b.clone()]),
            Some(b.join("libappindicator3.so.1"))
        );
        std::fs::write(a.join("libayatana-appindicator3.so.1"), b"").unwrap();
        assert_eq!(
            find_library(&names, &[a.clone(), b]),
            Some(a.join("libayatana-appindicator3.so.1"))
        );
    }

    #[test]
    fn ld_so_conf_includes_are_followed() {
        let dir = tempfile::tempdir().unwrap();
        let conf_d = dir.path().join("ld.so.conf.d");
        std::fs::create_dir_all(&conf_d).unwrap();
        std::fs::write(
            dir.path().join("ld.so.conf"),
            "# comment\ninclude ld.so.conf.d/*.conf\n/opt/top/lib # trailing\ninclude extra.conf\n",
        )
        .unwrap();
        std::fs::write(conf_d.join("b.conf"), "/opt/b/lib\n").unwrap();
        std::fs::write(conf_d.join("a.conf"), "/opt/a/lib\n\n# x\n").unwrap();
        std::fs::write(conf_d.join("ignored.txt"), "/opt/ignored\n").unwrap();
        std::fs::write(dir.path().join("extra.conf"), "/opt/extra/lib\n").unwrap();
        let dirs: Vec<String> = ld_so_conf_dirs(&dir.path().join("ld.so.conf"))
            .iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(
            dirs,
            ["/opt/top/lib", "/opt/a/lib", "/opt/b/lib", "/opt/extra/lib"]
        );
        assert!(ld_so_conf_dirs(&dir.path().join("missing.conf")).is_empty());
    }

    #[test]
    fn macos_and_linux_icons_decode() {
        let template = tauri::image::Image::from_bytes(macos::TEMPLATE).unwrap();
        assert_eq!(
            (template.width(), template.height()),
            (36, 36),
            "18 pt at 2x"
        );
        // A template image is black: only its alpha carries the shape.
        let (pixels, _) = template.rgba().as_chunks::<4>();
        let opaque: Vec<&[u8; 4]> = pixels.iter().filter(|[.., a]| *a > 0).collect();
        assert!(!opaque.is_empty() && opaque.iter().all(|[r, g, b, _]| [*r, *g, *b] == [0, 0, 0]));
        let linux = tauri::image::Image::from_bytes(linux::TRAY).unwrap();
        assert_eq!((linux.width(), linux.height()), (32, 32));
        macos::icon().unwrap();
        linux::icon().unwrap();
        macos::ensure_supported().unwrap();
    }

    #[test]
    fn linux_search_path_and_support_check() {
        let dir = tempfile::tempdir().unwrap();
        let (env_dir, app_lib) = (dir.path().join("env"), dir.path().join("app/usr/lib"));
        std::fs::create_dir_all(&env_dir).unwrap();
        std::fs::create_dir_all(&app_lib).unwrap();
        let joined = std::env::join_paths([env_dir.clone(), std::path::PathBuf::new()]).unwrap();
        let dirs = linux::search_dirs(
            Some(joined),
            Some(dir.path().join("app").into_os_string()),
            &dir.path().join("no-ld.so.conf"),
        );
        assert_eq!(
            dirs[0], env_dir,
            "LD_LIBRARY_PATH first, empty entries dropped"
        );
        assert_eq!(dirs[1], app_lib, "then the AppImage's libraries");
        assert!(dirs.ends_with(&[
            std::path::PathBuf::from("/usr/lib"),
            std::path::PathBuf::from("/lib")
        ]));
        // No library: an error, never a panic.
        let missing = linux::check(&[env_dir.clone(), app_lib.clone()]).unwrap_err();
        assert!(missing.to_string().contains("AppIndicator"), "{missing}");
        std::fs::write(app_lib.join(linux::SONAMES[0]), b"").unwrap();
        linux::check(&[env_dir, app_lib]).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_icon_sides_cover_the_scale_factors() {
        for (dpi, side) in [
            (0, 16),
            (96, 16),
            (120, 20),
            (144, 24),
            (168, 32),
            (192, 32),
            (240, 32),
            (288, 32),
        ] {
            assert_eq!(platform::side_for_dpi(dpi), side, "dpi {dpi}");
        }
        assert_eq!(platform::png_for_dpi(144), platform::TRAY_24);
        for (bytes, side) in [
            (platform::TRAY_16, 16),
            (platform::TRAY_20, 20),
            (platform::TRAY_24, 24),
            (platform::TRAY_32, 32),
        ] {
            let image = tauri::image::Image::from_bytes(bytes).unwrap();
            assert_eq!((image.width(), image.height()), (side, side));
        }
        // The current machine's choice decodes too.
        platform::icon().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_notice_text_is_terminated_and_cut_at_characters() {
        let mut buf = [0xffff_u16; 8];
        platform::copy_wide(&mut buf, "abc");
        assert_eq!(&buf[..4], &[97, 98, 99, 0]);
        let mut small = [0xffff_u16; 4];
        platform::copy_wide(&mut small, "a\u{1F54C}b"); // 'a', a surrogate pair, 'b'
        assert_eq!(small, [97, 0xD83D, 0xDD4C, 0]);
        let mut tiny = [0xffff_u16; 2];
        platform::copy_wide(&mut tiny, "\u{1F54C}");
        assert_eq!(tiny[0], 0, "a pair that does not fit is dropped whole");
    }
}
