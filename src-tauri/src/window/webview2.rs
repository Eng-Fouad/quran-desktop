//! WebView2 recovery (Windows). The page lives in WebView2's renderer process; when that process dies or hangs, the
//! window would otherwise show a dead page for good while a recitation plays on in Rust with no UI.
//!
//! `ICoreWebView2::ProcessFailed` ([`attach`]) decides by [`classify`]:
//! - **the page's process exited or hangs** (`RENDER_PROCESS_EXITED`, `RENDER_PROCESS_UNRESPONSIVE`): logged at warn and
//!   the page reloaded. The frontend and the Rust state are built to survive a reload (`app_bootstrap` again, the
//!   audio and pack channels subscribed again, the window and its zoom kept). At most [`RELOADS_PER_MINUTE`] reloads per
//!   minute ([`ReloadBudget`]); past that a page that keeps crashing is not reloaded in a loop: a native dialog says so
//!   and offers Reload or Quit;
//! - **the browser process exited** (`BROWSER_PROCESS_EXITED`): the whole web engine is gone and this webview cannot be
//!   brought back (its controller is dead). Recreating the window would also orphan what is bound to its handle (the
//!   OS media session's `GetForWindow`, the Snap Layouts target), so a native dialog offers Restart (an orderly exit,
//!   then a new process: `AppHandle::request_restart`) or Quit;
//! - anything else (the GPU process, which WebView2 restarts by itself, utility and helper processes) is logged only.
//!
//! The same hook turns off dropping files and links into the webview (`SetAllowExternalDrop(false)`): the app accepts
//! no drop, and wry does this only when a drop handler is installed (`dragDropEnabled: false` installs none).
//!
//! [`set_visible`] tells WebView2 whether the page is seen (the window hidden to the tray or minimised).
//!
//! WKWebView and WebKitGTK expose no such event through wry, so macOS and Linux have no automatic recovery (the
//! macOS/Linux smoke checklist covers a crashed page by hand).

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_REASON, ICoreWebView2, ICoreWebView2Controller4,
    ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
};
use webview2_com::ProcessFailedEventHandler;
use windows::core::Interface;

use crate::MAIN_WINDOW;
use crate::i18n::{self, RustText};
use crate::state::AppState;

/// Automatic reloads allowed within [`RELOAD_PERIOD`] before the user is asked.
pub const RELOADS_PER_MINUTE: usize = 3;
/// The period of [`RELOADS_PER_MINUTE`].
pub const RELOAD_PERIOD: Duration = Duration::from_secs(60);

/// What a failed WebView2 process means for the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// The page's renderer exited or hangs: reload the page.
    Reload,
    /// The browser process exited: the webview is gone; only a restart helps.
    Restart,
    /// A helper process (GPU, utility, sandbox, plugin, a frame's renderer): WebView2 copes by itself.
    Ignore,
}

/// [`Recovery`] for a `COREWEBVIEW2_PROCESS_FAILED_KIND` value.
#[must_use]
pub const fn classify(kind: i32) -> Recovery {
    match kind {
        // RENDER_PROCESS_EXITED, RENDER_PROCESS_UNRESPONSIVE
        1 | 2 => Recovery::Reload,
        // BROWSER_PROCESS_EXITED
        0 => Recovery::Restart,
        // FRAME_RENDER_PROCESS_EXITED (3), UTILITY (4), SANDBOX_HELPER (5), GPU (6), PPAPI (7, 8), UNKNOWN (9)
        _ => Recovery::Ignore,
    }
}

/// The name of a `COREWEBVIEW2_PROCESS_FAILED_KIND` value, for the log.
#[must_use]
pub const fn kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "the browser process exited",
        1 => "the page's renderer process exited",
        2 => "the page's renderer process is unresponsive",
        3 => "a frame's renderer process exited",
        4 => "a utility process exited",
        5 => "the sandbox helper process exited",
        6 => "the GPU process exited",
        7 | 8 => "a plugin process exited",
        _ => "a WebView2 process exited",
    }
}

/// At most `max` automatic reloads within `period`.
#[derive(Debug)]
pub struct ReloadBudget {
    max: usize,
    period: Duration,
    recent: VecDeque<Instant>,
}

impl ReloadBudget {
    #[must_use]
    pub const fn new(max: usize, period: Duration) -> Self {
        Self {
            max,
            period,
            recent: VecDeque::new(),
        }
    }

    /// Whether one more reload at `now` stays within the budget; if so, it is counted.
    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|&at| now.saturating_duration_since(at) >= self.period)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= self.max {
            return false;
        }
        self.recent.push_back(now);
        true
    }

    /// The user asked for a reload: the count starts again.
    pub fn reset(&mut self) {
        self.recent.clear();
    }
}

/// Shared by the event handler and the dialogs.
struct Recovering {
    app: AppHandle<Wry>,
    budget: Mutex<ReloadBudget>,
    /// A recovery dialog is on screen.
    asking: AtomicBool,
}

/// Hooks `ProcessFailed` on the main window's webview and turns off external drops. Runs the hook on the main thread
/// (`with_webview`); failures are logged, never fatal.
pub fn attach(window: &WebviewWindow<Wry>) {
    let recovering = Arc::new(Recovering {
        app: window.app_handle().clone(),
        budget: Mutex::new(ReloadBudget::new(RELOADS_PER_MINUTE, RELOAD_PERIOD)),
        asking: AtomicBool::new(false),
    });
    let hooked = window.with_webview(move |webview| {
        let controller = webview.controller();
        // SAFETY: WebView2 COM calls on the thread that owns the controller (`with_webview` runs this on the main
        // thread); every interface is reference-counted by windows-rs.
        unsafe {
            if let Err(e) = controller
                .cast::<ICoreWebView2Controller4>()
                .and_then(|c| c.SetAllowExternalDrop(false))
            {
                log::warn!("webview: external drops stay enabled: {e}");
            }
            let core = match controller.CoreWebView2() {
                Ok(core) => core,
                Err(e) => {
                    log::warn!("webview: no crash recovery (no CoreWebView2: {e})");
                    return;
                }
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                on_process_failed(&recovering, sender, args);
                Ok(())
            }));
            let mut token = 0_i64;
            match core.add_ProcessFailed(&handler, &mut token) {
                Ok(()) => log::debug!("webview: crash recovery armed"),
                Err(e) => log::warn!("webview: no crash recovery ({e})"),
            }
        }
    });
    if let Err(e) = hooked {
        log::warn!("webview: no crash recovery ({e})");
    }
}

/// Shows or hides the page to WebView2 (`ICoreWebView2Controller::put_IsVisible`, see `window::sync_webview_visibility`):
/// hidden, the page gets `visibilitychange` (`document.hidden`), requestAnimationFrame stops and timers are throttled;
/// audio is Rust's and plays on. Shown again into the focused window, the keyboard focus goes back into the page (wry
/// moves it there on `WM_SETFOCUS`, which may have come while the controller was still hidden). Runs on the main
/// thread (`with_webview`); failures are logged.
pub fn set_visible(window: &WebviewWindow<Wry>, visible: bool) {
    let focused = visible && window.is_focused().unwrap_or(false);
    let applied = window.with_webview(move |webview| {
        let controller = webview.controller();
        // SAFETY: WebView2 COM calls on the thread that owns the controller (`with_webview` runs this on the main
        // thread); the interface is reference-counted by windows-rs.
        unsafe {
            if let Err(e) = controller.SetIsVisible(visible) {
                log::warn!("webview: visibility not set to {visible}: {e}");
                return;
            }
            if focused
                && let Err(e) = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
            {
                log::debug!("webview: focus not moved into the page: {e}");
            }
        }
        log::debug!(
            "webview: the page is {}",
            if visible { "visible" } else { "hidden" }
        );
    });
    if let Err(e) = applied {
        log::warn!("webview: visibility not set to {visible}: {e}");
    }
}

/// The `ProcessFailed` handler (the main thread).
fn on_process_failed(
    recovering: &Arc<Recovering>,
    sender: Option<ICoreWebView2>,
    args: Option<ICoreWebView2ProcessFailedEventArgs>,
) {
    let Some(args) = args else {
        return;
    };
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    // SAFETY: a getter on the event's own arguments, on the event's thread.
    if let Err(e) = unsafe { args.ProcessFailedKind(&mut kind) } {
        log::warn!("webview: a process failed, of unknown kind ({e})");
        return;
    }
    let what = kind_name(kind.0);
    let detail = details(&args);
    if recovering
        .app
        .try_state::<AppState>()
        .is_some_and(|s| s.is_shut_down())
    {
        log::info!("webview: {what} ({detail}) while quitting");
        return;
    }
    match classify(kind.0) {
        Recovery::Ignore => log::info!("webview: {what} ({detail}); WebView2 recovers by itself"),
        Recovery::Reload => {
            if recovering.budget.lock().allow(Instant::now()) {
                log::warn!("webview: {what} ({detail}); reloading the page");
                let reloaded = match &sender {
                    // SAFETY: the sender is the failed webview's own interface, on its thread.
                    Some(core) => unsafe { core.Reload() }.map_err(|e| e.to_string()),
                    None => reload_main(&recovering.app),
                };
                if let Err(e) = reloaded {
                    log::error!("webview: the page cannot be reloaded: {e}");
                }
            } else {
                log::error!(
                    "webview: {what} ({detail}) again: {RELOADS_PER_MINUTE} reloads within {} s; asking the user",
                    RELOAD_PERIOD.as_secs()
                );
                ask(recovering, Recovery::Reload);
            }
        }
        Recovery::Restart => {
            log::error!("webview: {what} ({detail}); the window cannot recover, asking to restart");
            ask(recovering, Recovery::Restart);
        }
    }
}

/// The failure's reason and exit code, when WebView2 reports them (`ICoreWebView2ProcessFailedEventArgs2`).
fn details(args: &ICoreWebView2ProcessFailedEventArgs) -> String {
    let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() else {
        return "no details".to_owned();
    };
    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
    let mut exit_code = 0_i32;
    // SAFETY: getters on the event's own arguments, on the event's thread.
    let (reason, exit_code) = unsafe {
        (
            args2.Reason(&mut reason).map(|()| reason.0),
            args2.ExitCode(&mut exit_code).map(|()| exit_code),
        )
    };
    let reason = match reason {
        Ok(0) => "unexpected".to_owned(),
        Ok(1) => "unresponsive".to_owned(),
        Ok(2) => "terminated".to_owned(),
        Ok(3) => "crashed".to_owned(),
        Ok(4) => "failed to launch".to_owned(),
        Ok(5) => "out of memory".to_owned(),
        Ok(6) => "profile deleted".to_owned(),
        Ok(other) => format!("reason {other}"),
        Err(_) => "no reason".to_owned(),
    };
    match exit_code {
        Ok(code) => format!("{reason}, exit code {code:#x}"),
        Err(_) => reason,
    }
}

fn reload_main(app: &AppHandle<Wry>) -> Result<(), String> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("no `{MAIN_WINDOW}` window"))?
        .reload()
        .map_err(|e| e.to_string())
}

/// The recovery dialog: Reload (or Restart) / Quit / Cancel. Cancel, Esc and × leave things as they are (the tray's
/// Quit still works). One dialog at a time.
fn ask(recovering: &Arc<Recovering>, recovery: Recovery) {
    if recovering.asking.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = &recovering.app;
    // The window layer's cached preferences (read from user.db once per run at most).
    let lang = super::current_prefs(app).ui_language;
    let (body, act) = match recovery {
        Recovery::Restart => (RustText::WindowEngineGoneBody, RustText::WindowRestart),
        _ => (RustText::WindowCrashLoopBody, RustText::WindowReload),
    };
    let act = i18n::text(lang, act).to_owned();
    let quit = i18n::text(lang, RustText::TrayQuit).to_owned();
    let cancel = i18n::text(lang, RustText::CloseToTrayCancel).to_owned();
    // Windows shows the title in the caption: the app's name there, the question first in the text (as the
    // close-to-tray dialog does).
    let title = i18n::text(lang, RustText::AppName);
    let message = format!(
        "{}\n\n{}",
        i18n::text(lang, RustText::WindowFailedTitle),
        i18n::text(lang, body)
    );
    let shared = Arc::clone(recovering);
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            act.clone(),
            quit.clone(),
            cancel,
        ))
        .show_with_result(move |result| {
            shared.asking.store(false, Ordering::Release);
            let chosen =
                |label: &str| matches!(&result, MessageDialogResult::Custom(l) if l == label);
            if chosen(&act) || matches!(result, MessageDialogResult::Yes) {
                match recovery {
                    Recovery::Restart => {
                        log::info!("webview: restarting the app");
                        shared.app.request_restart();
                    }
                    _ => {
                        log::info!("webview: reloading the page (asked)");
                        shared.budget.lock().reset();
                        if let Err(e) = reload_main(&shared.app) {
                            log::error!("webview: the page cannot be reloaded: {e}");
                        }
                    }
                }
            } else if chosen(&quit) || matches!(result, MessageDialogResult::No) {
                // The page failed: nobody would answer `quit-requested`.
                crate::window::exit_now(&shared.app);
            } else {
                log::info!("webview: the recovery dialog was dismissed");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_failures_reload_and_an_engine_failure_restarts() {
        assert_eq!(classify(1), Recovery::Reload);
        assert_eq!(classify(2), Recovery::Reload);
        assert_eq!(classify(0), Recovery::Restart);
        for helper in 3..=9 {
            assert_eq!(classify(helper), Recovery::Ignore, "{helper}");
        }
        assert_eq!(classify(42), Recovery::Ignore);
        assert_eq!(kind_name(6), "the GPU process exited");
    }

    #[test]
    fn reloads_are_limited_per_minute() {
        let start = Instant::now();
        let mut budget = ReloadBudget::new(3, Duration::from_secs(60));
        assert!(budget.allow(start));
        assert!(budget.allow(start + Duration::from_secs(1)));
        assert!(budget.allow(start + Duration::from_secs(2)));
        // A fourth crash within the minute: the user decides.
        assert!(!budget.allow(start + Duration::from_secs(3)));
        assert!(!budget.allow(start + Duration::from_secs(59)));
        // The first reload is a minute old: one more is allowed.
        assert!(budget.allow(start + Duration::from_secs(60)));
        assert!(!budget.allow(start + Duration::from_secs(60)));
        // The user's Reload starts the count again.
        budget.reset();
        assert!(budget.allow(start + Duration::from_secs(61)));
    }
}
