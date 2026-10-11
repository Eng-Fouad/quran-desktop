//! Window and run-loop hooks (§2.8.4): show-after-ready, close-to-tray and its first-close question, UI zoom, settings
//! side effects (tray, labels, media language), run events, single-instance focus and deep links, and the Windows 11
//! Snap Layouts hit target of the custom maximise button. Owner: WP6b.
//!
//! None of these hooks may panic: they run inside the event loop, and release builds abort on a panic.
//!
//! NOT the chrome effect: the frontend is its single owner through `window_set_chrome`, because only it knows what the
//! `system` theme resolved to (§9.6).
//!
//! Closing the main window (§9.6), decided by [`close_action`]:
//! - while a recitation plays (or loads), `close_to_tray` on and a tray icon present: the window hides and the
//!   recitation goes on; the very first hide shows a one-time tray notification, remembered in `settings.hints_seen` as
//!   [`TRAY_HINT`]. With nothing playing, × closes as usual: the setting ("Keep reciting after closing the window") and
//!   the question are about a recitation, so an idle app never disappears into the tray.
//! - otherwise, while a recitation plays, a tray icon is present and the question was never answered: a native dialog
//!   asks "Keep reciting in the tray?" with the buttons "Keep playing in tray", "Quit" and "Cancel". The answer sets
//!   `close_to_tray` and `close_to_tray_asked` (through the settings write path, so the frontend hears
//!   `settings-changed`) and is never asked again. Cancel (also Esc and ×) keeps the window open and asks again next
//!   time.
//! - otherwise the app quits ([`quit`]).
//!
//! Hidden to the tray or minimised, the page is told it is not seen ([`sync_webview_visibility`]): WebView2 would
//! otherwise keep it `visible` and its animation frames running at the display rate behind a hidden window.
//!
//! Quitting (the close above, the tray's Quit, the dialog's Quit, a close from the taskbar) lets the page finish first:
//! [`quit`] hides the window at once and emits `quit-requested`; the page saves what it still holds (the reading and
//! recitation positions it writes 1 s after they settle, the history dwell, a note draft), waits for those writes, and
//! calls `app_quit`. WebView2 tears the page down without `pagehide` or `visibilitychange`, so before this a page turn
//! in the last second before × was lost. A page that does not answer within [`QUIT_GRACE`] (hung, crashed, still
//! booting) delays nothing the user sees, and before the first `window_ready`, or after the webview failed, the app
//! exits at once ([`exit_now`]).
//!
//! Every exit path (the above, `app_quit`, Cmd+Q, logoff) ends in `RunEvent::Exit`, where [`on_run_event`] stops audio
//! and the media session, checkpoints user.db (`AppState::shutdown`, idempotent) and removes the tray icon.
//!
//! The main window itself is built by [`create_main`] (every config says `create: false`): the navigation guard
//! ([`guard`]), its placement ([`placement`]), the WebView2 crash recovery (`webview2`, Windows) and, in isolated debug
//! runs, its own webview profile.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use quran_types::limits::UI_SCALE_PCT;
use quran_types::{
    AppError, AppView, NavTarget, PAGE_COUNT, SURAH_COUNT, Settings, SurahInfo, UiLanguage,
};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::MAIN_WINDOW;
use crate::i18n::{self, RustText};
use crate::state::AppState;
use crate::tray;

pub mod guard;
pub mod placement;
#[cfg(windows)]
mod webview2;

/// Builds the main window from its config entry (`create: false` in every `tauri.*.conf.json`, so tauri does not):
/// - top-level navigations and new windows go through [`guard`]: the webview never leaves the app;
/// - in a debug run with `QD_DATA_DIR` the webview keeps its profile (`localStorage` included) under it
///   (`setup::dev_webview_dir`, D24);
/// - the saved size and position are restored and fitted to a work area ([`placement`]);
/// - on Windows, WebView2 crash recovery and no external drops (`webview2`).
///
/// Called once by the setup hook, before `setup::init`. Never fails: a window that cannot be built is logged, and the
/// fatal path then shows its dialog without one.
pub fn create_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
    else {
        log::error!("the config has no `{MAIN_WINDOW}` window");
        return;
    };
    // `tauri dev` loads the dev server; every other build serves the embedded frontend.
    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| {
        let builder = builder
            .on_navigation(move |url| guard::on_navigation(url, dev_url.as_ref()))
            .on_new_window(|url, _features| guard::on_new_window(&url));
        match crate::setup::dev_webview_dir() {
            Some(dir) => builder.data_directory(dir),
            None => builder,
        }
        .build()
    });
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            log::error!("the main window cannot be created: {e}");
            return;
        }
    };
    placement::restore(&window, placement::saved_file(app).as_deref());
    attach_recovery(&window);
    #[cfg(target_os = "macos")]
    install_app_menu(app);
}

/// The macOS app menu's Quit ([`install_app_menu`]).
pub const QUIT_MENU_ID: &str = "qd-menu.quit";
/// The macOS app menu's "Settings…" ([`install_app_menu`]).
pub const SETTINGS_MENU_ID: &str = "qd-menu.settings";

/// macOS: tauri's default menu bar (the app menu, Edit for Cmd+C/V/A in text fields, View, Window) with two changes to
/// its app menu:
/// - "Settings…" (⌘,) after About, where macOS apps keep it: it shows the window and asks the page for the Settings
///   dialog ([`request_settings`]), which applies `Mod+,`'s rule, never over another layer. WKWebView offers ⌘, to the
///   page first and hands it to this item only when the page left it unhandled, which `Mod+,` does only where it
///   declines: a key press never acts twice.
/// - Its Quit replaced by one that goes through [`quit`], so Cmd+Q lets the page save first like the tray's Quit. The
///   default item calls `terminate:`, which ends the app without `quit-requested` and lost a turn of the last second
///   (LEAD 23). The Dock's Quit and logout still terminate directly.
///
/// A menu that cannot be built leaves the default one. Compiled on every OS, so the Windows and Linux builds check it
/// too; installed on macOS only, the one OS whose default menu starts with the app menu.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn install_app_menu<R: Runtime>(app: &AppHandle<R>) {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};

    let build = || -> tauri::Result<Menu<R>> {
        let menu = Menu::default(app)?;
        // The default menu's first submenu is the app menu: About, a separator, Services, a separator, Hide, Hide
        // Others, a separator, and the predefined Quit last.
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
            let last = app_menu.items()?.len().saturating_sub(1);
            app_menu.remove_at(last)?;
            let label = format!("Quit {}", app.package_info().name);
            app_menu.append(&MenuItem::with_id(
                app,
                QUIT_MENU_ID,
                label,
                true,
                Some("CmdOrCtrl+Q"),
            )?)?;
            // After About and its separator, with a separator of its own before Services.
            let settings = MenuItem::with_id(
                app,
                SETTINGS_MENU_ID,
                "Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            app_menu.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
        }
        Ok(menu)
    };
    if let Err(e) = build().and_then(|menu| app.set_menu(menu)) {
        log::warn!("app menu: {e}; keeping the default menu");
        return;
    }
    // A global listener: it also hears the tray's items (and the tray's listener hears these).
    app.on_menu_event(|app, event| match event.id().as_ref() {
        QUIT_MENU_ID => quit(app),
        SETTINGS_MENU_ID => request_settings(app),
        _ => {}
    });
}

/// The app menu's "Settings…": shows the main window (it may be hidden in the tray, still reciting) and emits
/// `settings-requested`; the page decides, as for `Mod+,`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn request_settings<R: Runtime>(app: &AppHandle<R>) {
    show_main(app);
    if let Err(e) = app.emit(
        <crate::ipc::events::SettingsRequested as tauri_specta::Event>::NAME,
        crate::ipc::events::SettingsRequested,
    ) {
        log::warn!("settings-requested: {e}");
    }
}

/// WebView2 crash recovery for the real (Wry) window; nothing on other platforms or runtimes (tests).
fn attach_recovery<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    {
        let any: &dyn std::any::Any = window;
        if let Some(window) = any.downcast_ref::<WebviewWindow<tauri::Wry>>() {
            webview2::attach(window);
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// The `settings.hints_seen` entry recording that the one-time "still running in the tray" notice was shown.
pub const TRAY_HINT: &str = "tray_background";

/// Applies the side effects of a settings change that belong to the window layer: close-to-tray preferences, UI zoom,
/// tray visibility and labels, the media metadata language. Called by `settings_set`/`settings_reset` (§5.13) after
/// the write, on an async task.
pub fn apply_settings<R: Runtime>(app: &AppHandle<R>, prev: &Settings, next: &Settings) {
    *window_state(app).prefs.lock() = Some(WindowPrefs::of(next));
    if prev.ui_scale_pct != next.ui_scale_pct {
        set_ui_zoom(app, next.ui_scale_pct);
    } else if prev.ui_language != next.ui_language {
        // The caption buttons move to the other side with the UI direction.
        caption::relayout(app);
    }
    let relocalise = prev.ui_language != next.ui_language;
    if relocalise {
        // First: the tray's "Now: {ref}" label re-uses the media glue's surah-name language.
        crate::media::on_ui_language_changed(app, next.ui_language);
    }
    match (prev.show_tray_icon, next.show_tray_icon) {
        (false, true) => {
            if let Err(e) = tray::build(app, next.ui_language) {
                log::warn!("tray: {e}");
            }
        }
        (true, false) => tray::remove(app),
        _ if relocalise => tray::relabel(app, next.ui_language),
        _ => {}
    }
}

/// The frontend shows or hides its caption buttons (`window_set_caption`): zen mode and full-window overlays hide the
/// title bar, and the Windows 11 Snap Layouts target over the maximise button must not stay behind, dead to the page
/// and maximising the window on a click. Visible again, the target returns where the button is. Idempotent.
pub fn set_caption_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let was_hidden = window_state(app)
        .caption_hidden
        .swap(!visible, Ordering::AcqRel);
    if was_hidden == visible {
        log::debug!(
            "caption buttons {}",
            if visible { "shown" } else { "hidden" }
        );
        caption::relayout(app);
    }
}

/// UI scale = webview zoom (D27), clamped to 80–200 %. Also lays out the Snap Layouts hit target, whose size follows
/// the zoom (setup calls this once the state is managed).
pub fn set_ui_zoom<R: Runtime>(app: &AppHandle<R>, ui_scale_pct: u32) {
    let pct = UI_SCALE_PCT.apply(ui_scale_pct);
    window_state(app).zoom_pct.store(pct, Ordering::Release);
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let factor = f64::from(pct) / 100.0;
    if let Err(e) = window.set_zoom(factor) {
        log::warn!("set_zoom({factor}): {e}");
    }
    caption::relayout(app);
}

/// `CloseRequested` on the main window: hide to the tray, ask the close-to-tray question, or close (see the module
/// docs). A size or DPI change re-lays out the Snap Layouts target and re-picks the tray icon.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let prefs = current_prefs(app);
            let action = close_action(
                &prefs,
                is_reciting(app),
                tray::exists(app),
                window_state(app).asking.load(Ordering::Acquire),
            );
            log::debug!("close requested: {action:?}");
            match action {
                CloseAction::Close => {
                    // The window stays until the page has saved what it holds (`quit` hides it at once).
                    api.prevent_close();
                    log::info!("main window closed; quitting");
                    quit(app);
                }
                CloseAction::KeepOpen => api.prevent_close(),
                CloseAction::HideToTray => {
                    api.prevent_close();
                    hide_to_tray(app, &prefs);
                }
                CloseAction::Ask => {
                    api.prevent_close();
                    ask_close_to_tray(window, &prefs);
                }
            }
        }
        WindowEvent::Resized(_) => {
            caption::relayout(app);
            // Minimised or restored (tao reports both as a resize): tell the page whether it is seen.
            let minimized = window.is_minimized().unwrap_or(false);
            if window_state(app)
                .minimized
                .swap(minimized, Ordering::AcqRel)
                != minimized
            {
                sync_webview_visibility(app);
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            caption::relayout(app);
            tray::refresh_icon(app);
        }
        WindowEvent::Destroyed => log::debug!("window `{}` destroyed", window.label()),
        _ => {}
    }
}

/// `Exit` → the orderly shutdown (audio, media session, user.db checkpoint) and the tray icon's removal; macOS Dock
/// `Reopen` with no visible window → [`show_main`] (the window may be hidden in the tray).
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, ev: &RunEvent) {
    match ev {
        RunEvent::Exit => {
            log::info!("exit");
            if let Some(state) = app.try_state::<AppState>() {
                state.shutdown();
            }
            tray::remove(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main(app),
        _ => {}
    }
}

/// A second launch focuses the running instance, and a `quran-desktop:` link among its arguments (BRIEF deep links,
/// e.g. `quran-desktop://2:255`) becomes a `navigate-requested` event (§5.14).
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>) {
    log::info!(
        "second instance started ({} args); focusing the main window",
        argv.len()
    );
    show_main(app);
    if let Some(link) = DeepLink::among(argv.iter().map(String::as_str)) {
        navigate(app, link);
    }
}

/// The first launch's `quran-desktop:` link, if the app was started with one (later launches arrive through
/// [`on_second_instance`]): a `navigate-requested` event, like a second instance's. Called once, by `window_ready`,
/// because the frontend's listener exists only after its first paint. Arguments that are not valid Unicode are skipped.
pub fn open_launch_link<R: Runtime>(app: &AppHandle<R>) {
    let args: Vec<String> = std::env::args_os()
        .filter_map(|a| a.into_string().ok())
        .collect();
    if let Some(link) = DeepLink::among(args.iter().map(String::as_str)) {
        log::info!("the app was started with a deep link");
        navigate(app, link);
    }
}

/// Unminimises, shows and focuses the main window (the page is told it is seen before the focus moves into it).
/// Failures are logged, never fatal.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("show_main: no `{MAIN_WINDOW}` window");
        return;
    };
    for (step, result) in [("unminimize", window.unminimize()), ("show", window.show())] {
        if let Err(e) = result {
            log::warn!("show_main: {step}: {e}");
        }
    }
    sync_webview_visibility(app);
    if let Err(e) = window.set_focus() {
        log::warn!("show_main: set_focus: {e}");
    }
}

/// Tells the page whether anyone can see the main window (§7.3: the player store stops its animation loop, the word
/// glide and the warm-ups on `visibilitychange`). tao only hides or minimises the window, and WebView2 then keeps the
/// page `visible`, with requestAnimationFrame running at the display rate: a recitation left playing in the tray cost
/// as much CPU as one on screen. As WebView2 recommends, its controller is made invisible while the window is hidden
/// (in the tray) or minimised, and visible again once it is shown or restored. WKWebView and WebKitGTK follow their
/// window's visibility themselves (the macOS/Linux smoke checklist covers it).
pub fn sync_webview_visibility<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
    #[cfg(windows)]
    {
        let any: &dyn std::any::Any = &window;
        if let Some(window) = any.downcast_ref::<WebviewWindow<tauri::Wry>>() {
            webview2::set_visible(window, visible);
        }
    }
    #[cfg(not(windows))]
    log::trace!(
        "the main window is {}",
        if visible { "seen" } else { "not seen" }
    );
}

// --- quitting --------------------------------------------------------------------------------------------------------

/// How long a quit waits for the page to call `app_quit` before the app exits anyway. The page answers within
/// milliseconds (one `position_set` at most, then `app_quit`); the frontend caps its own wait at 800 ms.
pub const QUIT_GRACE: Duration = Duration::from_millis(1500);

/// How a quit proceeds ([`quit_path`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPath {
    /// Hide the window and ask the page (`quit-requested`); it saves what it holds and calls `app_quit`.
    AskPage,
    /// Exit now: no page listens yet (before the first `window_ready`), or a quit is already under way.
    Now,
}

/// The quit decision: ask the page once it listens (`page_ready`), unless a quit is already under way (a second
/// request exits at once).
#[must_use]
pub const fn quit_path(page_ready: bool, already_quitting: bool) -> QuitPath {
    if page_ready && !already_quitting {
        QuitPath::AskPage
    } else {
        QuitPath::Now
    }
}

/// The page painted and listens for `quit-requested` (`window_ready`: the frontend subscribes before it asks to be
/// shown, and again after a WebView2 reload).
pub fn page_ready<R: Runtime>(app: &AppHandle<R>) {
    window_state(app).page_ready.store(true, Ordering::Release);
}

/// Quits the app (the window's close, the tray's Quit, the close question's Quit; see the module docs): the window goes
/// at once, the page saves what it holds and calls `app_quit`, and after [`QUIT_GRACE`] without it the app exits anyway.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    if begin_quit(app) == QuitPath::Now {
        exit_now(app);
        return;
    }
    let handle = app.clone();
    let grace = std::thread::Builder::new()
        .name("quit-grace".to_owned())
        .spawn(move || {
            std::thread::sleep(QUIT_GRACE);
            log::warn!(
                "the page did not quit within {} ms; exiting",
                QUIT_GRACE.as_millis()
            );
            handle.exit(0);
        });
    if let Err(e) = grace {
        log::warn!("quit: no grace timer ({e}); exiting now");
        exit_now(app);
    }
}

/// The first half of [`quit`]: decides, and on [`QuitPath::AskPage`] hides the window (the page is told it is not
/// seen) and emits `quit-requested`. Never exits, so it is testable on the mock runtime.
fn begin_quit<R: Runtime>(app: &AppHandle<R>) -> QuitPath {
    let state = window_state(app);
    let path = quit_path(
        state.page_ready.load(Ordering::Acquire),
        state.quitting.swap(true, Ordering::AcqRel),
    );
    if path == QuitPath::Now {
        return path;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(e) = window.hide()
    {
        log::debug!("quit: hide: {e}");
    }
    sync_webview_visibility(app);
    match app.emit(
        <crate::ipc::events::QuitRequested as tauri_specta::Event>::NAME,
        crate::ipc::events::QuitRequested,
    ) {
        Ok(()) => {
            log::info!("quitting: the page saves what it holds first");
            QuitPath::AskPage
        }
        Err(e) => {
            log::warn!("quit-requested: {e}");
            QuitPath::Now
        }
    }
}

/// Exits at once; `RunEvent::Exit` runs the orderly shutdown. For a quit the page cannot answer (the webview failed)
/// or must not wait for.
pub fn exit_now<R: Runtime>(app: &AppHandle<R>) {
    log::info!("quitting");
    app.exit(0);
}

// --- close to tray ---------------------------------------------------------------------------------------------------

/// The settings the window layer acts on, cached so that a close request never waits for user.db.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowPrefs {
    pub close_to_tray: bool,
    pub close_to_tray_asked: bool,
    pub ui_language: UiLanguage,
    /// [`TRAY_HINT`] is in `hints_seen`.
    pub tray_hint_seen: bool,
}

impl WindowPrefs {
    #[must_use]
    pub fn of(settings: &Settings) -> Self {
        Self {
            close_to_tray: settings.close_to_tray,
            close_to_tray_asked: settings.close_to_tray_asked,
            ui_language: settings.ui_language,
            tray_hint_seen: settings.hints_seen.iter().any(|h| h == TRAY_HINT),
        }
    }
}

/// What a close request on the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Close the window; the app exits.
    Close,
    /// Hide the window; the app keeps running in the tray.
    HideToTray,
    /// Ask the close-to-tray question first.
    Ask,
    /// The question is already open: keep the window and let the dialog decide.
    KeepOpen,
}

/// The close decision (§9.6). `reciting`: a recitation is playing (or loading); `tray`: the tray icon exists (hiding
/// without one would leave no way back but a relaunch); `asking`: the question is on screen. Only a recitation is
/// kept in the tray: with nothing playing, × closes whatever `close_to_tray` says.
#[must_use]
pub const fn close_action(
    prefs: &WindowPrefs,
    reciting: bool,
    tray: bool,
    asking: bool,
) -> CloseAction {
    if asking {
        CloseAction::KeepOpen
    } else if !reciting || !tray {
        CloseAction::Close
    } else if prefs.close_to_tray {
        CloseAction::HideToTray
    } else if !prefs.close_to_tray_asked {
        CloseAction::Ask
    } else {
        CloseAction::Close
    }
}

/// The question's dialog title and text. macOS shows the title in bold above the text, so it carries the question;
/// Windows and Linux show the title in the window's caption, so it is the app's name and the text starts with the
/// question.
#[must_use]
pub fn close_question(lang: UiLanguage, macos: bool) -> (String, String) {
    let question = i18n::text(lang, RustText::CloseToTrayTitle);
    let body = i18n::text(lang, RustText::CloseToTrayBody);
    if macos {
        (question.to_owned(), body.to_owned())
    } else {
        let app_name = i18n::text(lang, RustText::AppName);
        (app_name.to_owned(), format!("{question}\n\n{body}"))
    }
}

/// The answer to the close-to-tray question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAnswer {
    Keep,
    Quit,
}

impl CloseAnswer {
    /// Maps the result of the three-button dialog (keep, quit, cancel): `None` for Cancel, which is also what
    /// Esc and × report (tauri-plugin-dialog 2.8.1 turns a dismissal into the third button's label), so dismissing
    /// never quits.
    #[must_use]
    pub fn from_result(result: &MessageDialogResult, keep: &str, quit: &str) -> Option<Self> {
        match result {
            MessageDialogResult::Custom(label) if label == keep => Some(Self::Keep),
            MessageDialogResult::Custom(label) if label == quit => Some(Self::Quit),
            // Backends that report the buttons generically.
            MessageDialogResult::Yes => Some(Self::Keep),
            MessageDialogResult::No => Some(Self::Quit),
            _ => None,
        }
    }
}

/// Applies an answer to the settings: what the frontend and the next close see.
pub fn record_answer(settings: &mut Settings, answer: CloseAnswer) {
    settings.close_to_tray = answer == CloseAnswer::Keep;
    settings.close_to_tray_asked = true;
}

/// Marks the one-time tray notice as shown.
pub fn record_tray_hint(settings: &mut Settings) {
    if !settings.hints_seen.iter().any(|h| h == TRAY_HINT) {
        settings.hints_seen.push(TRAY_HINT.to_owned());
    }
}

fn hide_to_tray<R: Runtime>(app: &AppHandle<R>, prefs: &WindowPrefs) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(e) = window.hide()
    {
        log::warn!("hide to tray: {e}");
    }
    sync_webview_visibility(app);
    log::info!("main window hidden to the tray");
    let state = window_state(app);
    if prefs.tray_hint_seen || state.hint_shown.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    tray::notify_still_running(app, prefs.ui_language, is_reciting(app), move || {
        update_prefs(&handle, |p| p.tray_hint_seen = true);
        persist(&handle, "tray notice", record_tray_hint);
    });
}

fn ask_close_to_tray<R: Runtime>(window: &Window<R>, prefs: &WindowPrefs) {
    let app = window.app_handle().clone();
    if window_state(&app).asking.swap(true, Ordering::AcqRel) {
        return;
    }
    // A close from the taskbar can come while the window is minimised: the question must be seen.
    if window.is_minimized().unwrap_or(false)
        && let Err(e) = window.unminimize()
    {
        log::debug!("close question: unminimize: {e}");
    }
    let lang = prefs.ui_language;
    let keep = i18n::text(lang, RustText::CloseToTrayKeep).to_owned();
    let quit_label = i18n::text(lang, RustText::CloseToTrayQuit).to_owned();
    let cancel = i18n::text(lang, RustText::CloseToTrayCancel).to_owned();
    let (title, message) = close_question(lang, cfg!(target_os = "macos"));
    log::info!("asking whether to keep reciting in the tray");
    // Three buttons, not two: the dialog plugin reports Esc/× as the last button, which must not be Quit.
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            keep.clone(),
            quit_label.clone(),
            cancel,
        ))
        .parent(window)
        .show_with_result(move |result| {
            window_state(&app).asking.store(false, Ordering::Release);
            let Some(answer) = CloseAnswer::from_result(&result, &keep, &quit_label) else {
                log::info!("close question dismissed; the window stays open");
                return;
            };
            log::info!("close question answered: {answer:?}");
            update_prefs(&app, |p| {
                p.close_to_tray = answer == CloseAnswer::Keep;
                p.close_to_tray_asked = true;
            });
            match answer {
                CloseAnswer::Keep => {
                    persist(&app, "close-to-tray answer", move |s| {
                        record_answer(s, answer)
                    });
                    hide_to_tray(&app, &current_prefs(&app));
                }
                CloseAnswer::Quit => {
                    // Quit only once the answer is stored, so it is never asked again.
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) =
                            write_settings(&handle, move |s| record_answer(s, answer)).await
                        {
                            log::warn!("close-to-tray answer not stored: {e}");
                        }
                        quit(&handle);
                    });
                }
            }
        });
}

/// Whether a recitation is playing or about to (loading, buffering).
fn is_reciting<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .is_some_and(|state| reciting(&state.audio.snapshot()))
}

/// A recitation is playing or about to: loading (nothing heard yet), or playing or buffering what is loaded.
#[must_use]
pub fn reciting(snapshot: &quran_types::AudioSnapshot) -> bool {
    match snapshot.status {
        quran_types::PlaybackStatus::Loading => true,
        status => snapshot.current.is_some() && tray::is_playing(status),
    }
}

/// Stores a settings edit in the background (logged on failure).
fn persist<R: Runtime>(
    app: &AppHandle<R>,
    what: &'static str,
    edit: impl FnOnce(&mut Settings) + Send + 'static,
) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = write_settings(&handle, edit).await {
            log::warn!("{what} not stored: {e}");
        }
    });
}

/// Edits the settings through the same path as `settings_set` (validation, hooks, `settings-changed`), so the
/// frontend's settings store follows. The edit runs on the settings as stored at that moment, inside the settings
/// writers' gate, so it never undoes a concurrent `settings_set`. A no-op when the edit changes nothing.
async fn write_settings<R: Runtime>(
    app: &AppHandle<R>,
    edit: impl FnOnce(&mut Settings) + Send + 'static,
) -> Result<(), AppError> {
    use crate::commands::settings::{apply_hooks, ops};

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| AppError::Internal("the app state is not ready".to_owned()))?;
    ops::edit(app, state.user.clone(), edit, apply_hooks(app, &state))
        .await
        .map(drop)
}

/// Lazily managed window-layer state.
struct WindowState {
    /// `None` until first needed (then read from user.db) or set by [`apply_settings`].
    prefs: Mutex<Option<WindowPrefs>>,
    /// The close-to-tray question is on screen.
    asking: AtomicBool,
    /// The one-time tray notice was attempted in this session.
    hint_shown: AtomicBool,
    /// The webview zoom last applied, in percent (the caption layout scales with it).
    zoom_pct: AtomicU32,
    /// The frontend hid its caption buttons (zen, a full-window overlay): no Snap Layouts target (`window_set_caption`).
    caption_hidden: AtomicBool,
    /// The main window was minimised at its last resize (the page's visibility follows a change).
    minimized: AtomicBool,
    /// The page listens for `quit-requested` ([`page_ready`]).
    page_ready: AtomicBool,
    /// A quit is under way ([`quit`]): a second request exits at once.
    quitting: AtomicBool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            prefs: Mutex::new(None),
            asking: AtomicBool::new(false),
            hint_shown: AtomicBool::new(false),
            zoom_pct: AtomicU32::new(100),
            caption_hidden: AtomicBool::new(false),
            minimized: AtomicBool::new(false),
            page_ready: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }
}

fn window_state<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, WindowState> {
    if app.try_state::<WindowState>().is_none() {
        app.manage(WindowState::default());
    }
    app.state::<WindowState>()
}

/// The cached preferences, read from user.db on first use (one small read; later updates come from
/// [`apply_settings`]). Without the managed app state (setup failed) the defaults apply.
fn current_prefs<R: Runtime>(app: &AppHandle<R>) -> WindowPrefs {
    let state = window_state(app);
    let mut cached = state.prefs.lock();
    if let Some(prefs) = *cached {
        return prefs;
    }
    let Some(app_state) = app.try_state::<AppState>() else {
        return WindowPrefs::of(&Settings::default());
    };
    match app_state.user.settings_load() {
        Ok(settings) => *cached.insert(WindowPrefs::of(&settings)),
        Err(e) => {
            log::warn!("window: settings unavailable ({e}); using the defaults");
            WindowPrefs::of(&Settings::default())
        }
    }
}

fn update_prefs<R: Runtime>(app: &AppHandle<R>, edit: impl FnOnce(&mut WindowPrefs)) {
    let current = current_prefs(app);
    let mut next = current;
    edit(&mut next);
    *window_state(app).prefs.lock() = Some(next);
}

// --- deep links ------------------------------------------------------------------------------------------------------

/// A `quran-desktop:` link (BRIEF stretch goal), parsed before the core index validates it.
///
/// Accepted forms (scheme case-insensitive, `//` optional, a trailing `/` ignored):
/// - an ayah: `2:255` · `2/255` · `ayah/2:255` · `ayah/2/255`;
/// - a surah: `2` · `surah/2`;
/// - a page: `page/50`;
/// - a search: `search?q=…` · `search/…` (percent-decoded; `+` is a space in the query form);
/// - a view: `view/{reader|downloads|settings|about}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Ayah { surah: u32, ayah: u32 },
    Surah(u32),
    Page(u32),
    Search(String),
    View(AppView),
}

impl DeepLink {
    pub const SCHEME: &'static str = "quran-desktop";
    /// Longest accepted search query, in characters.
    pub const MAX_QUERY_CHARS: usize = 256;

    /// The first link among a command line's arguments; `argv[0]` (the executable) is skipped.
    #[must_use]
    pub fn among<'a>(mut argv: impl Iterator<Item = &'a str>) -> Option<Self> {
        argv.next()?;
        argv.find_map(Self::parse)
    }

    /// Parses one command-line argument; `None` for anything else.
    #[must_use]
    pub fn parse(arg: &str) -> Option<Self> {
        let arg = arg.trim();
        let (scheme, rest) = arg.split_once(':')?;
        if !scheme.eq_ignore_ascii_case(Self::SCHEME) {
            return None;
        }
        let rest = rest.trim_start_matches('/');
        let (path, query) = match rest.split_once('?') {
            Some((path, query)) => (path, Some(query)),
            None => (rest, None),
        };
        let path = path.trim_end_matches('/');
        let (head, tail) = match path.split_once('/') {
            Some((head, tail)) => (head, Some(tail)),
            None => (path, None),
        };
        match head.to_ascii_lowercase().as_str() {
            "ayah" | "verse" => Self::reference(tail?).filter(|l| matches!(l, Self::Ayah { .. })),
            "surah" | "chapter" => number(tail?)
                .filter(|s| (1..=SURAH_COUNT).contains(s))
                .map(Self::Surah),
            "page" => number(tail?)
                .filter(|p| (1..=PAGE_COUNT).contains(p))
                .map(Self::Page),
            "search" => {
                let raw = match (tail, query) {
                    (Some(tail), _) => decode(tail, false)?,
                    (None, Some(query)) => query
                        .split('&')
                        .find_map(|pair| pair.strip_prefix("q="))
                        .and_then(|q| decode(q, true))?,
                    (None, None) => return None,
                };
                let query = raw.trim();
                (!query.is_empty() && query.chars().count() <= Self::MAX_QUERY_CHARS)
                    .then(|| Self::Search(query.to_owned()))
            }
            "view" => match tail?.to_ascii_lowercase().as_str() {
                "reader" => Some(Self::View(AppView::Reader)),
                "downloads" => Some(Self::View(AppView::Downloads)),
                "settings" => Some(Self::View(AppView::Settings)),
                "about" => Some(Self::View(AppView::About)),
                _ => None,
            },
            _ if tail.is_none() || head.chars().all(|c| c.is_ascii_digit()) => {
                Self::reference(path)
            }
            _ => None,
        }
    }

    /// `2:255`, `2/255` or `2`.
    fn reference(s: &str) -> Option<Self> {
        let (surah, ayah) = match s.split_once([':', '/']) {
            Some((surah, ayah)) => (number(surah)?, Some(number(ayah)?)),
            None => (number(s)?, None),
        };
        if !(1..=SURAH_COUNT).contains(&surah) {
            return None;
        }
        match ayah {
            Some(0) => None,
            Some(ayah) => Some(Self::Ayah { surah, ayah }),
            None => Some(Self::Surah(surah)),
        }
    }

    /// The navigation target, checking an ayah against its surah's length (`surahs`: the core index's 114 entries).
    #[must_use]
    pub fn resolve(&self, surahs: &[SurahInfo]) -> Option<NavTarget> {
        match self {
            Self::Ayah { surah, ayah } => {
                let info = surahs.iter().find(|s| s.id == *surah)?;
                (*ayah <= info.ayah_count).then(|| NavTarget::Ayah {
                    ayah_id: info.first_ayah_id + ayah - 1,
                })
            }
            Self::Surah(surah) => Some(NavTarget::Surah { surah: *surah }),
            Self::Page(page) => Some(NavTarget::Page { page: *page }),
            Self::Search(query) => Some(NavTarget::Search {
                query: query.clone(),
            }),
            Self::View(view) => Some(NavTarget::View { view: *view }),
        }
    }
}

fn number(s: &str) -> Option<u32> {
    let s = s.trim();
    (!s.is_empty() && s.len() <= 4 && s.chars().all(|c| c.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn decode(s: &str, plus_is_space: bool) -> Option<String> {
    let s = if plus_is_space {
        s.replace('+', " ")
    } else {
        s.to_owned()
    };
    percent_encoding::percent_decode_str(&s)
        .decode_utf8()
        .ok()
        .map(|c| c.into_owned())
}

/// Resolves the link against the core index (off the main thread) and emits `navigate-requested`.
fn navigate<R: Runtime>(app: &AppHandle<R>, link: DeepLink) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = handle.try_state::<AppState>() else {
            return;
        };
        let surahs = match state.core.index() {
            Ok(index) => index.surahs,
            Err(e) => {
                log::warn!("deep link ignored: no core index ({e})");
                return;
            }
        };
        let Some(target) = link.resolve(&surahs) else {
            log::info!("deep link ignored: {link:?} is not in the Quran");
            return;
        };
        log::info!("deep link → {target:?}");
        let event = crate::ipc::events::NavigateRequested(target);
        if let Err(e) = handle.emit(
            <crate::ipc::events::NavigateRequested as tauri_specta::Event>::NAME,
            &event,
        ) {
            log::warn!("navigate-requested: {e}");
        }
    });
}

// --- Snap Layouts ----------------------------------------------------------------------------------------------------

/// The Windows 11 Snap Layouts flyout for the custom maximise button (§9.6).
///
/// Windows shows the flyout when the window under the pointer answers `WM_NCHITTEST` with `HTMAXBUTTON`. The webview's
/// windows belong to the WebView2 browser process, so neither they nor a subclass of the app window can answer for the
/// HTML button. Instead, as Windows Terminal does for its XAML caption buttons, a small transparent child window of
/// our own sits above the webview exactly over the maximise button and answers `HTMAXBUTTON`: the system shows the
/// flyout on hover, and a click toggles maximise. With `noRedirectionBitmap` the child paints nothing, so the HTML
/// button stays visible under it; its hover and pressed looks are forwarded to the page as a DOM event,
/// `qd:caption-button` with `detail = { button: 'maximize', state: 'hover' | 'pressed' | 'none' }`, which the
/// `WindowControls` component (WP7c) reflects. Keyboard and screen-reader access stay on the HTML button.
///
/// The target is 46 × 40 CSS px (the §9.6 caption button) scaled by the DPI and the UI zoom, second from the
/// inline-end edge of the title bar (the right edge, or the left one in the Arabic UI), below the top resize strip
/// unless maximised. It exists only on Windows 11 with the custom title bar, and is hidden in full screen.
pub mod caption {
    use quran_types::UiLanguage;
    use tauri::{AppHandle, Runtime};

    /// The §9.6 caption button in CSS px.
    pub const BUTTON_W: u32 = 46;
    pub const BUTTON_H: u32 = 40;

    /// The pointer state of the maximise target, as forwarded to the page.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ButtonState {
        None,
        Hover,
        Pressed,
    }

    impl ButtonState {
        #[must_use]
        pub const fn as_str(self) -> &'static str {
            match self {
                Self::None => "none",
                Self::Hover => "hover",
                Self::Pressed => "pressed",
            }
        }

        /// The script that tells the page.
        #[must_use]
        pub fn script(self) -> String {
            format!(
                "window.dispatchEvent(new CustomEvent('qd:caption-button',{{detail:{{button:'maximize',state:'{}'}}}}))",
                self.as_str()
            )
        }
    }

    /// A rectangle in client pixels.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Rect {
        pub x: i32,
        pub y: i32,
        pub w: i32,
        pub h: i32,
    }

    /// Where the maximise target goes in a client area `client_w` px wide: `scale` = DPI scale × UI zoom,
    /// `top_inset` = the resize strip kept above it (0 when maximised). `None` when the window is too narrow to show
    /// three caption buttons.
    #[must_use]
    pub fn maximize_rect(client_w: i32, scale: f64, rtl: bool, top_inset: i32) -> Option<Rect> {
        if !(scale.is_finite() && scale > 0.0) {
            return None;
        }
        let w = px(f64::from(BUTTON_W) * scale)?;
        let h = px(f64::from(BUTTON_H) * scale)?;
        if w <= 0 || h <= top_inset || client_w < w.checked_mul(3)? {
            return None;
        }
        let x = if rtl {
            w
        } else {
            client_w.checked_sub(w.checked_mul(2)?)?
        };
        Some(Rect {
            x,
            y: top_inset,
            w,
            h: h - top_inset,
        })
    }

    fn px(v: f64) -> Option<i32> {
        let v = v.round();
        // Checked to be a small whole number, so the conversion is exact.
        #[allow(clippy::cast_possible_truncation)]
        (v.is_finite() && (0.0..=1_000_000.0).contains(&v)).then_some(v as i32)
    }

    /// Windows 11 starts at build 22000 (`AppInfo.os_version` is `"10.0.<build>"`); Snap Layouts exist only there.
    #[must_use]
    pub fn has_snap_layouts(os_version: &str) -> bool {
        os_version
            .split('.')
            .nth(2)
            .and_then(|build| build.trim().parse::<u32>().ok())
            .is_some_and(|build| build >= 22_000)
    }

    /// The caption buttons sit at the inline end: on the left in the right-to-left (Arabic) UI.
    #[must_use]
    pub const fn rtl(lang: UiLanguage) -> bool {
        matches!(lang, UiLanguage::Ar)
    }

    /// Creates, moves or hides the target for the main window's current size, DPI, zoom, UI direction and state (on
    /// the main thread; it never waits). A no-op off Windows.
    pub fn relayout<R: Runtime>(app: &AppHandle<R>) {
        #[cfg(windows)]
        super::snap::relayout(app);
        #[cfg(not(windows))]
        let _ = app;
    }
}

#[cfg(windows)]
mod snap {
    //! The Win32 side of [`super::caption`].

    use std::sync::atomic::Ordering;

    use tauri::{AppHandle, Manager, Runtime};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows::Win32::UI::WindowsAndMessaging::{
        CREATESTRUCTW, CreateWindowExW, DefWindowProcW, FindWindowExW, GWLP_HINSTANCE,
        GWLP_USERDATA, GetClientRect, GetCursorPos, GetWindowLongPtrW, GetWindowRect, HTMAXBUTTON,
        HWND_TOP, IsZoomed, KillTimer, RegisterClassExW, SM_CYFRAME, SW_HIDE, SWP_NOACTIVATE,
        SWP_NOOWNERZORDER, SWP_SHOWWINDOW, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
        WINDOW_EX_STYLE, WM_NCCREATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSEMOVE, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP,
        WM_TIMER, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
    };
    use windows::core::{PCWSTR, w};

    use super::caption::{self, ButtonState};
    use crate::MAIN_WINDOW;
    use crate::state::AppState;

    const CLASS: PCWSTR = w!("QuranSnapTarget");
    /// While hovered, the pointer is polled at this interval to notice it leaving (no `TrackMouseEvent` here).
    const LEAVE_POLL_MS: u32 = 60;
    const LEAVE_TIMER: usize = 1;

    /// Per-target state, owned by the target window (`GWLP_USERDATA`), freed on `WM_NCDESTROY`.
    struct Target {
        hover: bool,
        pressed: bool,
        on_state: Box<dyn Fn(ButtonState)>,
        on_click: Box<dyn Fn()>,
    }

    pub fn relayout<R: Runtime>(app: &AppHandle<R>) {
        let handle = app.clone();
        if let Err(e) = app.run_on_main_thread(move || relayout_now(&handle)) {
            log::debug!("snap target: relayout not scheduled: {e}");
        }
    }

    /// Main thread only (the target must belong to the thread that pumps the app window's messages).
    fn relayout_now<R: Runtime>(app: &AppHandle<R>) {
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let Ok(parent) = window.hwnd() else {
            return;
        };
        let os_version = app
            .try_state::<AppState>()
            .map(|s| s.app_info.os_version.clone())
            .unwrap_or_else(|| tauri_plugin_os::version().to_string());
        let wanted = caption::has_snap_layouts(&os_version)
            && !window.is_decorated().unwrap_or(true)
            && !window.is_fullscreen().unwrap_or(false)
            && !super::window_state(app)
                .caption_hidden
                .load(Ordering::Acquire);
        // SAFETY: `parent` is the live main window, on its own thread; the class name is a static NUL-terminated
        // string.
        let existing = unsafe { FindWindowExW(Some(parent), None, CLASS, PCWSTR::null()) }.ok();
        if !wanted {
            if let Some(target) = existing {
                // SAFETY: our own child window.
                let _ = unsafe { ShowWindow(target, SW_HIDE) };
            }
            return;
        }
        let Some(target) = existing.or_else(|| create(app, parent)) else {
            return;
        };
        let zoom_pct = super::window_state(app).zoom_pct.load(Ordering::Acquire);
        let rtl = caption::rtl(super::current_prefs(app).ui_language);
        place(parent, target, zoom_pct, rtl);
    }

    fn place(parent: HWND, target: HWND, zoom_pct: u32, rtl: bool) {
        let mut client = RECT::default();
        // SAFETY: plain queries on our own windows.
        let (dpi, maximized) = unsafe {
            if GetClientRect(parent, &mut client).is_err() {
                return;
            }
            (GetDpiForWindow(parent).max(96), IsZoomed(parent).as_bool())
        };
        let top_inset = if maximized {
            0
        } else {
            // SAFETY: a metrics query.
            unsafe { GetSystemMetricsForDpi(SM_CYFRAME, dpi) }
        };
        let scale = f64::from(dpi) / 96.0 * f64::from(zoom_pct) / 100.0;
        let rect = caption::maximize_rect(client.right - client.left, scale, rtl, top_inset);
        // SAFETY: positions our own child window above its siblings (the webview container).
        unsafe {
            match rect {
                Some(r) => {
                    let _ = SetWindowPos(
                        target,
                        Some(HWND_TOP),
                        r.x,
                        r.y,
                        r.w,
                        r.h,
                        SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
                    );
                }
                None => {
                    let _ = ShowWindow(target, SW_HIDE);
                }
            }
        }
    }

    fn create<R: Runtime>(app: &AppHandle<R>, parent: HWND) -> Option<HWND> {
        let state_app = app.clone();
        let click_app = app.clone();
        let target = Box::new(Target {
            hover: false,
            pressed: false,
            on_state: Box::new(move |state: ButtonState| {
                if let Some(window) = state_app.get_webview_window(MAIN_WINDOW)
                    && let Err(e) = window.eval(state.script())
                {
                    log::debug!("snap target: state not forwarded: {e}");
                }
            }),
            on_click: Box::new(move || {
                let Some(window) = click_app.get_webview_window(MAIN_WINDOW) else {
                    return;
                };
                let toggled = if window.is_maximized().unwrap_or(false) {
                    window.unmaximize()
                } else {
                    window.maximize()
                };
                if let Err(e) = toggled {
                    log::warn!("snap target: maximise toggle failed: {e}");
                }
            }),
        });
        // SAFETY: registers a class whose window procedure is `target_proc` (re-registering fails harmlessly), then
        // creates a child of the live main window on its own thread; ownership of `target` passes to the window
        // (`WM_NCCREATE`) and comes back on `WM_NCDESTROY`, or right here when creation fails.
        unsafe {
            let instance =
                windows::Win32::Foundation::HINSTANCE(
                    GetWindowLongPtrW(parent, GWLP_HINSTANCE) as *mut core::ffi::c_void
                );
            let class = WNDCLASSEXW {
                cbSize: u32::try_from(size_of::<WNDCLASSEXW>()).unwrap_or(u32::MAX),
                lpfnWndProc: Some(target_proc),
                hInstance: instance,
                lpszClassName: CLASS,
                ..WNDCLASSEXW::default()
            };
            let _ = RegisterClassExW(&class);
            let raw = Box::into_raw(target);
            match CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS,
                PCWSTR::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                Some(parent),
                None,
                Some(instance),
                Some(raw.cast::<core::ffi::c_void>()),
            ) {
                Ok(hwnd) => {
                    log::debug!("snap target created");
                    Some(hwnd)
                }
                Err(e) => {
                    drop(Box::from_raw(raw));
                    log::warn!(
                        "snap target not created ({e}); the maximise button has no Snap Layouts flyout"
                    );
                    None
                }
            }
        }
    }

    /// # Safety
    /// Called by Windows for windows of [`CLASS`] only, whose `GWLP_USERDATA` is null or the `Target` stored on
    /// `WM_NCCREATE`.
    unsafe extern "system" fn target_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // SAFETY: see the function contract; every pointer read here was written by this procedure.
        unsafe {
            if msg == WM_NCCREATE {
                let create = lparam.0 as *const CREATESTRUCTW;
                if let Some(create) = create.as_ref() {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                }
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Target;
            if msg == WM_NCDESTROY {
                if !data.is_null() {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    drop(Box::from_raw(data));
                }
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let Some(target) = data.as_mut() else {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            };
            match msg {
                WM_NCHITTEST => LRESULT(HTMAXBUTTON as isize),
                WM_NCMOUSEMOVE => {
                    if !target.hover {
                        target.hover = true;
                        (target.on_state)(ButtonState::Hover);
                        SetTimer(Some(hwnd), LEAVE_TIMER, LEAVE_POLL_MS, None);
                    }
                    LRESULT(0)
                }
                WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                    target.pressed = true;
                    target.hover = true;
                    (target.on_state)(ButtonState::Pressed);
                    SetTimer(Some(hwnd), LEAVE_TIMER, LEAVE_POLL_MS, None);
                    LRESULT(0)
                }
                WM_NCLBUTTONUP => {
                    if target.pressed {
                        target.pressed = false;
                        (target.on_state)(ButtonState::Hover);
                        (target.on_click)();
                    }
                    LRESULT(0)
                }
                // A native caption button ignores the right button; the default would open a system menu.
                WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => LRESULT(0),
                WM_TIMER if wparam.0 == LEAVE_TIMER => {
                    if !pointer_inside(hwnd) {
                        let _ = KillTimer(Some(hwnd), LEAVE_TIMER);
                        target.hover = false;
                        target.pressed = false;
                        (target.on_state)(ButtonState::None);
                    }
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    fn pointer_inside(hwnd: HWND) -> bool {
        let mut cursor = POINT::default();
        let mut rect = RECT::default();
        // SAFETY: plain queries.
        unsafe {
            GetCursorPos(&mut cursor).is_ok()
                && GetWindowRect(hwnd, &mut rect).is_ok()
                && cursor.x >= rect.left
                && cursor.x < rect.right
                && cursor.y >= rect.top
                && cursor.y < rect.bottom
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use quran_types::{RevelationPlace, ThemeMode};
    use tauri::test::mock_app;

    use super::caption::{self, ButtonState, Rect};
    use super::*;

    fn prefs(close_to_tray: bool, asked: bool) -> WindowPrefs {
        WindowPrefs {
            close_to_tray,
            close_to_tray_asked: asked,
            ui_language: UiLanguage::En,
            tray_hint_seen: false,
        }
    }

    #[test]
    fn the_close_decision_follows_the_spec() {
        use CloseAction::*;
        // (close_to_tray, asked, reciting, tray, asking) → action
        for (ctt, asked, reciting, tray, asking, action) in [
            // Not reciting, no preference: close.
            (false, false, false, true, false, Close),
            // Reciting, never asked, tray present: ask.
            (false, false, true, true, false, Ask),
            // Reciting but already asked (answered Quit): close.
            (false, true, true, true, false, Close),
            // Close to tray on: a recitation goes on in the tray...
            (true, true, true, true, false, HideToTray),
            // ...but with nothing playing, × closes (the setting is about keeping a recitation playing).
            (true, true, false, true, false, Close),
            (true, false, false, true, false, Close),
            // No tray icon: never hide, never ask (there would be no way back).
            (true, true, true, false, false, Close),
            (false, false, true, false, false, Close),
            // The question is open: keep the window.
            (false, false, true, true, true, KeepOpen),
            (true, true, true, true, true, KeepOpen),
        ] {
            assert_eq!(
                close_action(&prefs(ctt, asked), reciting, tray, asking),
                action,
                "ctt {ctt} asked {asked} reciting {reciting} tray {tray} asking {asking}"
            );
        }
    }

    #[test]
    fn reciting_means_playing_or_about_to() {
        use quran_types::{AudioSnapshot, AyahRef, PlaybackStatus};
        let at = |status, loaded: bool| AudioSnapshot {
            status,
            current: loaded.then_some(AyahRef {
                surah: 2,
                ayah: 255,
            }),
            ..quran_audio::shared::idle_snapshot()
        };
        for (status, loaded, expected) in [
            (PlaybackStatus::Playing, true, true),
            (PlaybackStatus::Buffering, true, true),
            // A play loading has nothing heard yet.
            (PlaybackStatus::Loading, false, true),
            (PlaybackStatus::Paused, true, false),
            (PlaybackStatus::Error, true, false),
            (PlaybackStatus::Idle, false, false),
            (PlaybackStatus::Playing, false, false),
        ] {
            assert_eq!(
                reciting(&at(status, loaded)),
                expected,
                "{status:?} loaded {loaded}"
            );
        }
    }

    #[test]
    fn answers_map_from_the_dialog_result() {
        let (keep, quit) = ("Keep playing in tray", "Quit");
        let answer = |r: MessageDialogResult| CloseAnswer::from_result(&r, keep, quit);
        assert_eq!(
            answer(MessageDialogResult::Custom(keep.into())),
            Some(CloseAnswer::Keep)
        );
        assert_eq!(
            answer(MessageDialogResult::Custom(quit.into())),
            Some(CloseAnswer::Quit)
        );
        assert_eq!(answer(MessageDialogResult::Yes), Some(CloseAnswer::Keep));
        assert_eq!(answer(MessageDialogResult::No), Some(CloseAnswer::Quit));
        // Cancel, Esc and × (reported as the Cancel label or as Cancel) and unknown labels are a dismissal, never a
        // quit.
        assert_eq!(answer(MessageDialogResult::Custom("Cancel".into())), None);
        assert_eq!(answer(MessageDialogResult::Cancel), None);
        assert_eq!(answer(MessageDialogResult::Ok), None);
    }

    #[test]
    fn answers_and_the_hint_are_recorded_in_the_settings() {
        let mut s = Settings::default();
        record_answer(&mut s, CloseAnswer::Keep);
        assert!(s.close_to_tray && s.close_to_tray_asked);
        record_answer(&mut s, CloseAnswer::Quit);
        assert!(!s.close_to_tray && s.close_to_tray_asked);
        record_tray_hint(&mut s);
        record_tray_hint(&mut s);
        assert_eq!(s.hints_seen, vec![TRAY_HINT.to_owned()]);
        let p = WindowPrefs::of(&s);
        assert!(p.tray_hint_seen && p.close_to_tray_asked && !p.close_to_tray);
        // The stored shape survives validation unchanged (what `settings_set` stores).
        assert_eq!(s.clone().validated(), s);
    }

    #[test]
    fn the_question_reads_well_on_each_platform() {
        let (title, text) = close_question(UiLanguage::En, false);
        assert_eq!(title, "Quran");
        assert!(text.starts_with("Keep reciting in the tray?\n\n"));
        let (title, text) = close_question(UiLanguage::Ar, true);
        assert_eq!(title, "هل تريد متابعة التلاوة في علبة النظام؟");
        assert!(text.contains("علبة النظام"));
        // The caption names the app in the UI language (docs/deviations/LEAD.md item 16).
        let (title, text) = close_question(UiLanguage::Ar, false);
        assert_eq!(title, "قرآن");
        assert!(text.starts_with("هل تريد متابعة التلاوة في علبة النظام؟\n\n"));
    }

    #[test]
    fn deep_links_parse() {
        use DeepLink as L;
        for (arg, link) in [
            (
                "quran-desktop://2:255",
                Some(L::Ayah {
                    surah: 2,
                    ayah: 255,
                }),
            ),
            (
                "QURAN-DESKTOP://2:255/",
                Some(L::Ayah {
                    surah: 2,
                    ayah: 255,
                }),
            ),
            (
                "quran-desktop:2/255",
                Some(L::Ayah {
                    surah: 2,
                    ayah: 255,
                }),
            ),
            (
                "quran-desktop://ayah/18:10",
                Some(L::Ayah {
                    surah: 18,
                    ayah: 10,
                }),
            ),
            (
                "quran-desktop://verse/18/10",
                Some(L::Ayah {
                    surah: 18,
                    ayah: 10,
                }),
            ),
            ("quran-desktop://36", Some(L::Surah(36))),
            ("quran-desktop://surah/114", Some(L::Surah(114))),
            ("quran-desktop://page/604", Some(L::Page(604))),
            (
                "quran-desktop://search?q=%D8%A7%D9%84%D8%B1%D8%AD%D9%85%D9%86",
                Some(L::Search("الرحمن".into())),
            ),
            (
                "quran-desktop://search?lang=en&q=mercy+of+god",
                Some(L::Search("mercy of god".into())),
            ),
            (
                "quran-desktop://search/light%20upon%20light",
                Some(L::Search("light upon light".into())),
            ),
            (
                "quran-desktop://view/Settings",
                Some(L::View(AppView::Settings)),
            ),
            (
                "  quran-desktop://view/about  ",
                Some(L::View(AppView::About)),
            ),
            // Rejected.
            (
                "C:\\Users\\u\\AppData\\Local\\Quran\\quran-desktop.exe",
                None,
            ),
            ("--flag", None),
            ("https://quran.com/2/255", None),
            ("quran-desktop://0:1", None),
            ("quran-desktop://115", None),
            ("quran-desktop://2:0", None),
            ("quran-desktop://page/0", None),
            ("quran-desktop://page/605", None),
            ("quran-desktop://page/", None),
            ("quran-desktop://ayah/2", None),
            ("quran-desktop://surah/1:1", None),
            ("quran-desktop://search?q=", None),
            ("quran-desktop://search?q=%FF", None),
            ("quran-desktop://search", None),
            ("quran-desktop://view/editor", None),
            ("quran-desktop://2:99999", None),
            ("quran-desktop://-2:1", None),
            ("quran-desktop://bookmark/1", None),
        ] {
            assert_eq!(DeepLink::parse(arg), link, "{arg:?}");
        }
        let long = format!(
            "quran-desktop://search?q={}",
            "a".repeat(DeepLink::MAX_QUERY_CHARS + 1)
        );
        assert_eq!(DeepLink::parse(&long), None);
    }

    #[test]
    fn the_first_link_of_a_command_line_counts_and_argv0_never_does() {
        let among = |argv: &[&str]| DeepLink::among(argv.iter().copied());
        assert_eq!(among(&[]), None);
        assert_eq!(among(&["quran-desktop:2:255"]), None, "argv[0] is the exe");
        assert_eq!(
            among(&[
                "C:\\Quran\\quran-desktop.exe",
                "--flag",
                "quran-desktop://page/50",
                "quran-desktop://2:255",
            ]),
            Some(DeepLink::Page(50))
        );
        assert_eq!(
            among(&[
                "quran-desktop.exe",
                "quran-desktop://0:1",
                "quran-desktop://2"
            ]),
            Some(DeepLink::Surah(2)),
            "an invalid link is skipped"
        );
        assert_eq!(among(&["quran-desktop.exe", "--minimized"]), None);
    }

    fn surah(id: u32, ayah_count: u32, first_ayah_id: u32) -> SurahInfo {
        SurahInfo {
            id,
            name_ar: String::new(),
            name_simple: String::new(),
            name_complex: String::new(),
            name_en: String::new(),
            revelation_place: RevelationPlace::Makkah,
            revelation_order: id,
            ayah_count,
            first_ayah_id,
            bismillah_pre: true,
            header_cp: None,
        }
    }

    #[test]
    fn deep_links_resolve_against_the_index() {
        let surahs = [surah(1, 7, 1), surah(2, 286, 8)];
        let ayah = |s, a| DeepLink::Ayah { surah: s, ayah: a }.resolve(&surahs);
        assert_eq!(ayah(1, 1), Some(NavTarget::Ayah { ayah_id: 1 }));
        assert_eq!(ayah(2, 255), Some(NavTarget::Ayah { ayah_id: 262 }));
        assert_eq!(ayah(2, 286), Some(NavTarget::Ayah { ayah_id: 293 }));
        assert_eq!(ayah(2, 287), None);
        assert_eq!(ayah(3, 1), None, "not in this index");
        assert_eq!(
            DeepLink::Page(3).resolve(&[]),
            Some(NavTarget::Page { page: 3 })
        );
        assert_eq!(
            DeepLink::Surah(9).resolve(&[]),
            Some(NavTarget::Surah { surah: 9 })
        );
        assert_eq!(
            DeepLink::Search("نور".into()).resolve(&[]),
            Some(NavTarget::Search {
                query: "نور".into()
            })
        );
        assert_eq!(
            DeepLink::View(AppView::Downloads).resolve(&[]),
            Some(NavTarget::View {
                view: AppView::Downloads
            })
        );
    }

    #[test]
    fn the_snap_target_follows_the_caption_buttons() {
        // 100 %, LTR, 1440 px client: second from the right, below the 4 px resize strip.
        assert_eq!(
            caption::maximize_rect(1440, 1.0, false, 4),
            Some(Rect {
                x: 1348,
                y: 4,
                w: 46,
                h: 36
            })
        );
        // Maximised: from the very top.
        assert_eq!(
            caption::maximize_rect(1440, 1.0, false, 0),
            Some(Rect {
                x: 1348,
                y: 0,
                w: 46,
                h: 40
            })
        );
        // 150 % DPI × 130 % zoom, RTL: second from the left.
        assert_eq!(
            caption::maximize_rect(2000, 1.5 * 1.3, true, 6),
            Some(Rect {
                x: 90,
                y: 6,
                w: 90,
                h: 72
            })
        );
        // Too narrow for three buttons, or a broken scale: no target.
        assert_eq!(caption::maximize_rect(100, 1.0, false, 4), None);
        assert_eq!(caption::maximize_rect(1440, 0.0, false, 4), None);
        assert_eq!(caption::maximize_rect(1440, f64::NAN, false, 4), None);
        assert_eq!(caption::maximize_rect(1440, 1.0, false, 40), None);
    }

    #[test]
    fn snap_layouts_need_windows_11() {
        for (version, snap) in [
            ("10.0.22000", true),
            ("10.0.26200", true),
            ("10.0.21999", false),
            ("10.0.19045", false),
            ("6.3.9600", false),
            ("", false),
            ("unknown", false),
        ] {
            assert_eq!(caption::has_snap_layouts(version), snap, "{version:?}");
        }
        assert!(caption::rtl(UiLanguage::Ar));
        assert!(!caption::rtl(UiLanguage::En));
    }

    #[test]
    fn the_page_hears_the_button_state() {
        assert_eq!(
            ButtonState::Hover.script(),
            "window.dispatchEvent(new CustomEvent('qd:caption-button',{detail:{button:'maximize',state:'hover'}}))"
        );
        assert!(ButtonState::Pressed.script().contains("state:'pressed'"));
        assert!(ButtonState::None.script().contains("state:'none'"));
    }

    /// RFC 7396 JSON Merge Patch, as the tauri CLI and `tauri-build` apply `tauri.<platform>.conf.json`.
    fn merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
        use serde_json::Value;
        let Value::Object(patch) = patch else {
            *target = patch.clone();
            return;
        };
        if !target.is_object() {
            *target = Value::Object(serde_json::Map::new());
        }
        if let Value::Object(target) = target {
            for (key, value) in patch {
                if value.is_null() {
                    target.remove(key);
                } else {
                    merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
    }

    fn config(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    /// The per-OS files (§13.5) merged onto the base parse as tauri's own `Config` (unknown keys and bad values are
    /// rejected), repeat every base window key they do not deliberately change (arrays are replaced whole), and carry
    /// the §9.6/§13.5 chrome and bundle settings. Checked on every OS, so the macOS and Linux files are validated on a
    /// Windows machine too.
    #[test]
    fn per_os_configs_merge_onto_the_base_and_parse() {
        use tauri::utils::WindowEffect;
        use tauri::utils::config::{BundleTarget, BundleType, Config};

        let base = config("tauri.conf.json");
        let base_window = base["app"]["windows"][0].as_object().unwrap().clone();
        for (file, changed) in [
            ("tauri.windows.conf.json", &["decorations"][..]),
            ("tauri.macos.conf.json", &[][..]),
            ("tauri.linux.conf.json", &[][..]),
        ] {
            let patch = config(file);
            let mut merged = base.clone();
            merge_patch(&mut merged, &patch);
            let window = merged["app"]["windows"][0].as_object().unwrap();
            assert_eq!(
                merged["app"]["windows"].as_array().unwrap().len(),
                1,
                "{file}"
            );
            for (key, value) in &base_window {
                if !changed.contains(&key.as_str()) {
                    assert_eq!(
                        window.get(key),
                        Some(value),
                        "{file}: base window key `{key}` not repeated"
                    );
                }
            }
            for key in changed {
                assert_ne!(
                    window.get(*key),
                    base_window.get(*key),
                    "{file}: `{key}` should change"
                );
            }
            let parsed: Config = serde_json::from_value(merged.clone())
                .unwrap_or_else(|e| panic!("{file} does not parse as a tauri config: {e}"));
            let w = &parsed.app.windows[0];
            assert_eq!(w.label, MAIN_WINDOW, "{file}");
            assert!(!w.visible, "{file}: show-after-ready needs a hidden window");
            assert!(
                !w.create,
                "{file}: `create_main` builds the window (navigation guard, placement, recovery)"
            );
            // Every bundle: a support link, and bundling refuses a QF-derived core.db.
            assert_eq!(parsed.bundle.homepage.as_deref(), Some("https://quran.com"));
            assert_eq!(
                merged["build"]["beforeBundleCommand"],
                "node src-tauri/scripts/check-release-core.mjs"
            );
            let targets = match &parsed.bundle.targets {
                BundleTarget::List(list) => list.clone(),
                other => panic!("{file}: explicit targets expected, got {other:?}"),
            };
            let icons = &parsed.bundle.icon;
            match file {
                "tauri.windows.conf.json" => {
                    assert!(!w.decorations && w.transparent && w.shadow, "{file}");
                    assert!(
                        w.no_redirection_bitmap,
                        "{file}: no white flash, invisible snap target"
                    );
                    assert_eq!(
                        w.window_effects.as_ref().unwrap().effects,
                        vec![WindowEffect::Mica]
                    );
                    assert_eq!(targets, vec![BundleType::Nsis]);
                    assert_eq!(
                        icons[0], "icons/windows/icon.ico",
                        "the tuned ICO is the exe resource"
                    );
                    // The installer speaks the app's two UI languages (picked from the OS language), and the setup
                    // and uninstall executables carry the app icon, not NSIS's generic one.
                    assert_eq!(
                        patch["bundle"]["windows"]["nsis"],
                        serde_json::json!({
                            "installMode": "currentUser",
                            "compression": "lzma",
                            "languages": ["English", "Arabic"],
                            "installerIcon": "icons/windows/icon.ico",
                            "uninstallerIcon": "icons/windows/icon.ico"
                        })
                    );
                    // An MSI (not a release target) keeps one upgrade identity forever: UUIDv5(DNS, the identifier)
                    // instead of tauri's default, derived from the generic product name "Quran".
                    assert_eq!(
                        patch["bundle"]["windows"]["wix"]["upgradeCode"],
                        "aac524f6-dd12-56b5-9a7a-14fe4e2a7d28"
                    );
                    assert_eq!(
                        patch["bundle"]["windows"]["webviewInstallMode"],
                        serde_json::json!({ "type": "downloadBootstrapper" })
                    );
                    assert_eq!(
                        patch["app"]["windows"][0]["scrollBarStyle"],
                        "fluentOverlay"
                    );
                }
                "tauri.macos.conf.json" => {
                    assert!(w.decorations && w.transparent && w.hidden_title, "{file}");
                    assert_eq!(patch["app"]["windows"][0]["titleBarStyle"], "Overlay");
                    assert_eq!(
                        patch["app"]["windows"][0]["trafficLightPosition"],
                        serde_json::json!({ "x": 16, "y": 20 })
                    );
                    let effects = w.window_effects.as_ref().unwrap();
                    assert_eq!(effects.effects, vec![WindowEffect::Sidebar]);
                    assert_eq!(targets, vec![BundleType::App, BundleType::Dmg]);
                    assert_eq!(icons[0], "icons/macos/icon.icns", "the Apple-grid ICNS");
                    assert_eq!(
                        parsed.bundle.macos.minimum_system_version.as_deref(),
                        Some("13.3")
                    );
                    assert!(parsed.bundle.macos.hardened_runtime);
                }
                _ => {
                    assert!(w.decorations && !w.transparent, "{file}");
                    assert!(w.window_effects.is_none(), "{file}: Linux has no effects");
                    assert_eq!(targets, vec![BundleType::Deb, BundleType::AppImage]);
                    assert_eq!(
                        parsed.bundle.linux.deb.depends,
                        Some(vec!["libasound2 | libasound2t64".to_owned()])
                    );
                    assert!(
                        !parsed.bundle.linux.appimage.bundle_media_framework,
                        "native audio: no GStreamer in the AppImage (FACT C10)"
                    );
                    // tauri-codegen makes the first PNG the window icon, and the deb bundler installs one hicolor
                    // icon per size (the first PNG of each size wins): the tuned 32 px comes first, and no size
                    // repeats (assets/brand/README.md).
                    assert_eq!(
                        icons[0], "icons/tray/tray-32.png",
                        "the tuned 32 px is the window icon"
                    );
                    let mut sizes = std::collections::BTreeSet::new();
                    for icon in icons {
                        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(icon);
                        let png = std::fs::read(&path).unwrap();
                        assert_eq!(png[..8], *b"\x89PNG\r\n\x1a\n", "{icon}");
                        let side =
                            |at: usize| u32::from_be_bytes(png[at..at + 4].try_into().unwrap());
                        let size = (side(16), side(20), icon.ends_with("@2x.png"));
                        assert!(sizes.insert(size), "{file}: {icon} repeats size {size:?}");
                    }
                    assert_eq!(sizes.len(), 7, "16, 24, 32, 64, 128, 128@2 and 512 px");
                }
            }
            // Every icon the platform file names exists.
            for icon in icons {
                let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(icon);
                assert!(path.is_file(), "{file}: missing {icon}");
            }
        }
    }

    /// The webview gets what the frontend uses and nothing more: `@tauri-apps/api/core` (`invoke`, `Channel`, always
    /// allowed), the events tauri-specta listens through, `@tauri-apps/api/window` (minimise, toggle maximise, close,
    /// `isMaximized`, `onResized`, full screen, and the drag region's start-dragging and double-click toggle), and the
    /// dialog plugin's open/save. A compromised page must not create trays or menus, read image files from disk
    /// (`image.from_path`), resolve paths, open devtools or log as the app: no `core:default`, which grants all of that.
    #[test]
    fn the_capability_grants_exactly_what_the_frontend_uses() {
        let cap = config("capabilities/default.json");
        assert_eq!(cap["identifier"], "default");
        assert_eq!(cap["windows"], serde_json::json!([MAIN_WINDOW]));
        let mut permissions: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        permissions.sort_unstable();
        let mut expected = vec![
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-close",
            "core:window:allow-internal-toggle-maximize",
            "core:window:allow-is-fullscreen",
            "core:window:allow-is-maximized",
            "core:window:allow-minimize",
            "core:window:allow-set-fullscreen",
            "core:window:allow-start-dragging",
            "core:window:allow-toggle-maximize",
            "dialog:allow-open",
            "dialog:allow-save",
        ];
        expected.sort_unstable();
        assert_eq!(permissions, expected);
        // No default set (each grants more than it names), and none of what the review found reachable.
        for absent in [":default", "always-on-top", "allow-emit"] {
            assert!(
                !permissions.iter().any(|p| p.contains(absent)),
                "{absent} must not be granted"
            );
        }
        for absent in [
            "core:tray",
            "core:menu",
            "core:image",
            "core:path",
            "core:webview",
            "core:app",
            "core:resources",
            "log:",
            "os:",
            "opener:",
        ] {
            assert!(
                !permissions.iter().any(|p| p.starts_with(absent)),
                "{absent} must not be granted"
            );
        }
    }

    #[test]
    fn a_quit_asks_the_page_once_it_listens_and_exits_at_once_otherwise() {
        use QuitPath::*;
        assert_eq!(quit_path(true, false), AskPage);
        // Before the first `window_ready` nobody answers; a second request (the page did not answer yet) exits.
        assert_eq!(quit_path(false, false), Now);
        assert_eq!(quit_path(true, true), Now);
        assert_eq!(quit_path(false, true), Now);
        // Rust's fallback outlasts the frontend's own cap on its writes (800 ms, `QUIT_FLUSH_MS` in app.svelte.ts).
        assert!(QUIT_GRACE >= Duration::from_millis(1000));
    }

    #[test]
    fn begin_quit_emits_quit_requested_once_the_page_is_ready() {
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;
        use tauri::Listener;

        let app = mock_app();
        let handle = app.handle();
        let heard = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&heard);
        handle.listen("quit-requested", move |event| {
            assert_eq!(event.payload(), "null");
            counter.fetch_add(1, Ordering::SeqCst);
        });
        // No page yet: exit at once, nothing emitted (and the quit is under way from here on).
        assert_eq!(super::begin_quit(handle), QuitPath::Now);
        assert_eq!(heard.load(Ordering::SeqCst), 0);

        let app = mock_app();
        let handle = app.handle();
        let counter = Arc::clone(&heard);
        handle.listen("quit-requested", move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        page_ready(handle);
        assert_eq!(super::begin_quit(handle), QuitPath::AskPage);
        assert_eq!(heard.load(Ordering::SeqCst), 1);
        // Asked again before the page answered (the tray's Quit twice): exit at once.
        assert_eq!(super::begin_quit(handle), QuitPath::Now);
        assert_eq!(heard.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn settings_hooks_update_the_cached_prefs_without_a_window() {
        let app = mock_app();
        let handle = app.handle();
        // No AppState: the defaults.
        assert_eq!(
            super::current_prefs(handle),
            WindowPrefs::of(&Settings::default())
        );
        let prev = Settings::default();
        let next = Settings {
            close_to_tray: true,
            close_to_tray_asked: true,
            ui_language: UiLanguage::Ar,
            ui_scale_pct: 130,
            theme: ThemeMode::Night,
            ..Settings::default()
        };
        apply_settings(handle, &prev, &next);
        assert_eq!(super::current_prefs(handle), WindowPrefs::of(&next));
        assert_eq!(window_state(handle).zoom_pct.load(Ordering::Acquire), 130);
        // Out-of-range zoom is clamped (D27: 80–200 %).
        set_ui_zoom(handle, 500);
        assert_eq!(window_state(handle).zoom_pct.load(Ordering::Acquire), 200);
        update_prefs(handle, |p| p.tray_hint_seen = true);
        assert!(super::current_prefs(handle).tray_hint_seen);
        // Hooks without a window, a tray or a state never fail.
        show_main(handle);
        on_second_instance(
            handle,
            vec!["quran-desktop.exe".into(), "quran-desktop://2:255".into()],
        );
        on_run_event(handle, &RunEvent::Exit);
    }
}
