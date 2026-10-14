//! End-to-end check of the Windows SMTC backend, shared by `examples/smtc_check.rs` (acceptance: prints `SMTC ok`)
//! and `tests/windows_smtc.rs`.
//!
//! It mirrors the app: the calling thread is STA (tao's `OleInitialize`) and owns a **hidden** top-level window (the
//! main window stays hidden until the frontend's first paint), and `MediaSession::new` runs on that thread while it is
//! blocked (tauri's setup closure). The session is then verified from the outside, through the system's
//! `GlobalSystemMediaTransportControlsSessionManager` (what the Windows media flyout and lock screen read): metadata,
//! thumbnail, status, rate, buttons and timeline; commands sent to the session must arrive at `on_command` (while
//! Paused, then while Playing); `Stopped` must remove it. Nothing is ever played: Paused/Playing are status flags shown
//! to the OS, there is no audio at all, and the commands reach only this process's handler.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use media_session::{
    BackendKind, MediaCommand, MediaSession, Metadata, PlaybackState, SessionConfig, Status,
};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as SystemSession,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as SystemStatus,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    COINIT, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, MSG, PM_REMOVE, PeekMessageW,
    TranslateMessage, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
};
use windows::core::w;

/// The app's AUMID (`tauri.conf.json` identifier).
pub const APP_ID: &str = "com.quran.labs.desktop";

/// A 16×16 PNG (deep green with a gold frame), used as artwork.
const ARTWORK: [u8; 88] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x91, 0x68,
    0x36, 0x00, 0x00, 0x00, 0x1f, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xd8, 0xd0, 0x1b, 0x4e,
    0x12, 0x62, 0xd8, 0xd0, 0x1b, 0x2e, 0xef, 0xeb, 0x42, 0x24, 0x1a, 0xd5, 0x30, 0xaa, 0x61, 0xa0,
    0x35, 0x90, 0x84, 0x00, 0x63, 0xa9, 0xe5, 0x71, 0x70, 0xaf, 0x96, 0x61, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];
const ARTIST: &str = "Mishari Rashid al-Afasy";
const ALBUM: &str = "The Holy Quran";
const DURATION: Duration = Duration::from_secs(47);
const POSITION: Duration = Duration::from_millis(12_300);
const RATE: f64 = 1.25;
/// How long the system may take to reflect an update or deliver a command (it is usually well under 100 ms).
const SYSTEM_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound for the whole observation.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

/// One verified property of the session.
pub struct Step {
    pub name: &'static str,
    /// What was observed (`Ok`), or what went wrong (`Err`).
    pub result: Result<String, String>,
}

/// Every step, in order. The check stops at the first step that makes the rest meaningless.
#[derive(Default)]
pub struct Report {
    pub steps: Vec<Step>,
    /// The backend `MediaSession::new` chose (`None` if it was never created).
    pub backend: Option<BackendKind>,
}

impl Report {
    #[must_use]
    pub fn passed(&self) -> bool {
        !self.steps.is_empty() && self.steps.iter().all(|s| s.result.is_ok())
    }

    fn push(&mut self, name: &'static str, result: Result<String, String>) -> bool {
        let ok = result.is_ok();
        self.steps.push(Step { name, result });
        ok
    }
}

/// Runs the whole check on the calling thread (which becomes STA and pumps its messages while the system is
/// observed from an MTA thread).
#[must_use]
pub fn run() -> Report {
    let mut report = Report::default();
    let _apartment = match Apartment::init(COINIT_APARTMENTTHREADED) {
        Ok(apartment) => apartment,
        Err(e) => {
            report.push("STA main thread", Err(e));
            return report;
        }
    };
    let aumid = media_session::set_process_app_user_model_id(APP_ID)
        .map(|()| APP_ID.to_owned())
        .map_err(|e| e.to_string());
    if !report.push("process AppUserModelID", aumid) {
        return report;
    }
    let window = match HiddenWindow::create() {
        Ok(window) => window,
        Err(e) => {
            report.push("hidden main window", Err(e));
            return report;
        }
    };
    let artwork = match TempFile::write("png", &ARTWORK) {
        Ok(file) => file,
        Err(e) => {
            report.push("artwork file", Err(e));
            return report;
        }
    };

    // `MediaSession::new` on this thread while it is blocked, exactly as in tauri's setup closure.
    let (command_tx, command_rx) = mpsc::channel::<MediaCommand>();
    let started = Instant::now();
    let session = MediaSession::new(
        config(window.raw()),
        None,
        Arc::new(move |cmd| {
            let _ = command_tx.send(cmd);
        }),
    );
    let session = match session {
        Ok(session) => session,
        Err(e) => {
            report.push("MediaSession::new", Err(e.to_string()));
            return report;
        }
    };
    let elapsed = started.elapsed();
    report.backend = Some(session.kind());
    let started_ok = if session.kind() == BackendKind::Smtc {
        Ok(format!(
            "SMTC obtained on the MTA backend thread in {elapsed:.1?} while the STA owner thread was blocked"
        ))
    } else {
        Err(format!(
            "fell back to the {:?} backend (see the log)",
            session.kind()
        ))
    };
    if !report.push("MediaSession::new on a blocked STA thread", started_ok) {
        session.shutdown();
        return report;
    }

    let title = format!("SMTC check {}", std::process::id());
    session.set_metadata(Metadata {
        title: title.clone(),
        artist: ARTIST.to_owned(),
        album: ALBUM.to_owned(),
        duration: Some(DURATION),
        artwork_path: Some(artwork.path.clone()),
    });
    session.set_state(state(Status::Paused));

    // Observe from an MTA thread while this thread pumps messages like the app's event loop and applies the state
    // changes the observer asks for (as the app does when its engine reacts to a command).
    let (state_tx, state_rx) = mpsc::channel::<PlaybackState>();
    let (done_tx, done_rx) = mpsc::channel::<Vec<Step>>();
    let observer = std::thread::Builder::new()
        .name("smtc-check-observer".to_owned())
        .spawn(move || {
            let steps = observe(&title, &command_rx, &state_tx);
            let _ = done_tx.send(steps);
        });
    if let Err(e) = observer {
        report.push("observer thread", Err(e.to_string()));
        session.shutdown();
        return report;
    }
    let deadline = Instant::now() + CHECK_TIMEOUT;
    let steps = loop {
        pump_messages();
        while let Ok(next) = state_rx.try_recv() {
            session.set_state(next);
        }
        if let Ok(steps) = done_rx.try_recv() {
            break steps;
        }
        if Instant::now() > deadline {
            break vec![Step {
                name: "observation",
                result: Err(format!("no result within {CHECK_TIMEOUT:?}")),
            }];
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    report.steps.extend(steps);

    let started = Instant::now();
    session.shutdown();
    report.push("shutdown", Ok(format!("{:.1?}", started.elapsed())));
    report
}

fn config(hwnd: isize) -> SessionConfig {
    SessionConfig {
        app_id: APP_ID.to_owned(),
        desktop_entry: "Quran".to_owned(),
        display_name: "Quran".to_owned(),
        dbus_name: "quran_desktop".to_owned(),
        hwnd: Some(hwnd),
    }
}

/// The check's transport state (a status flag for the OS only: nothing is ever played).
fn state(status: Status) -> PlaybackState {
    PlaybackState {
        status,
        position: POSITION,
        rate: RATE,
        can_next: true,
        can_previous: true,
        can_seek: true,
    }
}

/// The observer (MTA thread): finds the session through the system's session manager and verifies it. `set_state`
/// asks the owner thread to apply a state, as the app's engine does when it reacts to a command.
fn observe(
    title: &str,
    commands: &Receiver<MediaCommand>,
    set_state: &Sender<PlaybackState>,
) -> Vec<Step> {
    let mut report = Report::default();
    let _apartment = match Apartment::init(COINIT_MULTITHREADED) {
        Ok(apartment) => apartment,
        Err(e) => {
            report.push("MTA observer thread", Err(e));
            return report.steps;
        }
    };
    let manager = SessionManager::RequestAsync()
        .and_then(|op| op.join())
        .map_err(|e| format!("RequestAsync: {e}"));
    let manager = match manager {
        Ok(manager) => manager,
        Err(e) => {
            report.push("system session manager", Err(e));
            return report.steps;
        }
    };
    let found = poll(|| find_session(&manager, title));
    let session = match found {
        Ok(session) => session,
        Err(e) => {
            report.push("session visible to the system", Err(e));
            return report.steps;
        }
    };
    let source = session
        .SourceAppUserModelId()
        .map(|s| s.to_string())
        .unwrap_or_default();
    report.push(
        "session visible to the system",
        Ok(format!("source app `{source}`, title `{title}`")),
    );
    report.push(
        "metadata and thumbnail",
        poll(|| check_metadata(&session, title)),
    );
    report.push(
        "paused: status, rate and controls",
        poll(|| check_playback(&session, Status::Paused)),
    );
    report.push("timeline", poll(|| check_timeline(&session)));
    let seek_to = Duration::from_secs(20);
    report.push(
        "paused: commands reach on_command",
        check_commands(
            &session,
            commands,
            &[
                (Request::Play, MediaCommand::Play),
                (Request::Toggle, MediaCommand::Play),
                (Request::Stop, MediaCommand::Stop),
                (Request::Next, MediaCommand::Next),
                (Request::Previous, MediaCommand::Previous),
                (Request::Rate(1.5), MediaCommand::SetRate(1.5)),
                (Request::Seek(seek_to), MediaCommand::SeekTo(seek_to)),
            ],
        ),
    );

    // The engine would now be playing: only the status flag changes (no audio exists in this check).
    let _ = set_state.send(state(Status::Playing));
    report.push(
        "playing: status, rate and controls",
        poll(|| check_playback(&session, Status::Playing)),
    );
    report.push(
        "playing: commands reach on_command",
        check_commands(
            &session,
            commands,
            &[
                (Request::Pause, MediaCommand::Pause),
                (Request::Toggle, MediaCommand::Pause),
            ],
        ),
    );

    let _ = set_state.send(PlaybackState::STOPPED);
    let gone = poll(|| match find_session(&manager, title) {
        Ok(Some(_)) => Ok(None),
        Ok(None) => Ok(Some("removed from the system's session list".to_owned())),
        Err(e) => Err(e),
    });
    report.push("Stopped hides the session", gone);
    report.steps
}

fn find_session(manager: &SessionManager, title: &str) -> Result<Option<SystemSession>, String> {
    let sessions = manager
        .GetSessions()
        .map_err(|e| format!("GetSessions: {e}"))?;
    let count = sessions.Size().map_err(|e| e.to_string())?;
    for i in 0..count {
        let Ok(session) = sessions.GetAt(i) else {
            continue;
        };
        let Ok(props) = session
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.join())
        else {
            continue;
        };
        if props.Title().is_ok_and(|t| t == title) {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

fn check_metadata(session: &SystemSession, title: &str) -> Result<Option<String>, String> {
    let props = session
        .TryGetMediaPropertiesAsync()
        .and_then(|op| op.join())
        .map_err(|e| format!("TryGetMediaPropertiesAsync: {e}"))?;
    let got = (
        props.Title().map_err(|e| e.to_string())?.to_string(),
        props.Artist().map_err(|e| e.to_string())?.to_string(),
        props.AlbumTitle().map_err(|e| e.to_string())?.to_string(),
    );
    if got != (title.to_owned(), ARTIST.to_owned(), ALBUM.to_owned()) {
        return Err(format!("title/artist/album {got:?}"));
    }
    let thumbnail = props
        .Thumbnail()
        .and_then(|t| t.OpenReadAsync())
        .and_then(|op| op.join())
        .and_then(|stream| stream.Size())
        .map_err(|e| format!("thumbnail: {e}"))?;
    let expected = u64::try_from(ARTWORK.len()).unwrap_or(u64::MAX);
    if thumbnail != expected {
        return Err(format!(
            "thumbnail has {thumbnail} B, expected {expected} B"
        ));
    }
    Ok(Some(format!(
        "`{}` by `{}` on `{}`, {thumbnail} B thumbnail",
        got.0, got.1, got.2
    )))
}

/// Status, rate and controls as the flyout sees them. The system offers Play while paused and Pause while playing
/// (whatever the app enables), so only the transport button that fits the status is expected.
fn check_playback(session: &SystemSession, status: Status) -> Result<Option<String>, String> {
    let info = session.GetPlaybackInfo().map_err(|e| e.to_string())?;
    let got = info.PlaybackStatus().map_err(|e| e.to_string())?;
    let rate = info
        .PlaybackRate()
        .and_then(|r| r.Value())
        .map_err(|e| format!("rate: {e}"))?;
    let want = match status {
        Status::Playing => SystemStatus::Playing,
        Status::Paused => SystemStatus::Paused,
        Status::Stopped => SystemStatus::Stopped,
    };
    if got != want || (rate - RATE).abs() > 1e-9 {
        return Err(format!("status {got:?} (want {want:?}), rate {rate}"));
    }
    let c = info.Controls().map_err(|e| e.to_string())?;
    let flag = |r: windows::core::Result<bool>| r.unwrap_or(false);
    let (transport, transport_on) = if status == Status::Playing {
        ("pause", flag(c.IsPauseEnabled()))
    } else {
        ("play", flag(c.IsPlayEnabled()))
    };
    let required = [
        (transport, transport_on),
        ("stop", flag(c.IsStopEnabled())),
        ("next", flag(c.IsNextEnabled())),
        ("previous", flag(c.IsPreviousEnabled())),
        ("seek", flag(c.IsPlaybackPositionEnabled())),
        ("rate", flag(c.IsPlaybackRateEnabled())),
    ];
    if let Some((name, _)) = required.iter().find(|(_, on)| !on) {
        return Err(format!("the {name} control is disabled"));
    }
    if flag(c.IsFastForwardEnabled()) || flag(c.IsRewindEnabled()) || flag(c.IsRecordEnabled()) {
        return Err("fast-forward, rewind or record is enabled".to_owned());
    }
    Ok(Some(format!(
        "{status:?} at rate {rate}; {transport}, stop, next, previous, seek and rate enabled; \
         fast-forward, rewind and record disabled"
    )))
}

fn check_timeline(session: &SystemSession) -> Result<Option<String>, String> {
    let t = session.GetTimelineProperties().map_err(|e| e.to_string())?;
    let read = |r: windows::core::Result<windows::Foundation::TimeSpan>| {
        r.map(|ts| from_ticks(ts.Duration))
            .map_err(|e| e.to_string())
    };
    let (end, max_seek, position) = (
        read(t.EndTime())?,
        read(t.MaxSeekTime())?,
        read(t.Position())?,
    );
    if (end, max_seek, position) != (DURATION, DURATION, POSITION) {
        return Err(format!(
            "end {end:?}, max seek {max_seek:?}, position {position:?}"
        ));
    }
    Ok(Some(format!(
        "position {position:?} of {end:?}, seekable to {max_seek:?}"
    )))
}

/// A request the system's session object sends to the app.
#[derive(Debug, Clone, Copy)]
enum Request {
    Play,
    Pause,
    Toggle,
    Stop,
    Next,
    Previous,
    Rate(f64),
    Seek(Duration),
}

impl Request {
    /// Issues the request now (each one only after the previous one was answered) and waits for the system's answer.
    fn issue(self, session: &SystemSession) -> windows::core::Result<bool> {
        let op = match self {
            Self::Play => session.TryPlayAsync(),
            Self::Pause => session.TryPauseAsync(),
            Self::Toggle => session.TryTogglePlayPauseAsync(),
            Self::Stop => session.TryStopAsync(),
            Self::Next => session.TrySkipNextAsync(),
            Self::Previous => session.TrySkipPreviousAsync(),
            Self::Rate(rate) => session.TryChangePlaybackRateAsync(rate),
            Self::Seek(to) => session.TryChangePlaybackPositionAsync(
                i64::try_from(to.as_nanos() / 100).unwrap_or(i64::MAX),
            ),
        }?;
        op.join()
    }
}

/// Sends each request through the system, one at a time, and expects exactly its command at `on_command`.
fn check_commands(
    session: &SystemSession,
    commands: &Receiver<MediaCommand>,
    cases: &[(Request, MediaCommand)],
) -> Result<String, String> {
    let mut received = Vec::new();
    for &(request, expected) in cases {
        let accepted = request
            .issue(session)
            .map_err(|e| format!("{request:?}: {e}"))?;
        if !accepted {
            return Err(format!("{request:?}: the system rejected the request"));
        }
        let got = commands
            .recv_timeout(SYSTEM_TIMEOUT)
            .map_err(|_| format!("{request:?}: nothing reached on_command"))?;
        if got != expected {
            return Err(format!(
                "{request:?}: on_command got {got:?}, expected {expected:?}"
            ));
        }
        received.push(format!("{request:?} -> {got:?}"));
    }
    Ok(received.join(", "))
}

/// Retries `f` every 50 ms until it yields a value or [`SYSTEM_TIMEOUT`] passes (then the last error, if any).
fn poll<T>(mut f: impl FnMut() -> Result<Option<T>, String>) -> Result<T, String> {
    let deadline = Instant::now() + SYSTEM_TIMEOUT;
    let mut last = None;
    loop {
        match f() {
            Ok(Some(value)) => return Ok(value),
            Ok(None) => {}
            Err(e) => last = Some(e),
        }
        if Instant::now() >= deadline {
            return Err(last.unwrap_or_else(|| format!("not observed within {SYSTEM_TIMEOUT:?}")));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn from_ticks(ticks: i64) -> Duration {
    u64::try_from(ticks).map_or(Duration::ZERO, |t| {
        Duration::from_nanos(t.saturating_mul(100))
    })
}

fn pump_messages() {
    let mut msg = MSG::default();
    // SAFETY: standard message pump for windows owned by this thread; `msg` outlives every call.
    while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// COM initialised on the current thread for the check's lifetime.
struct Apartment;

impl Apartment {
    fn init(model: COINIT) -> Result<Self, String> {
        // SAFETY: balanced by `CoUninitialize` in `Drop` on the same thread.
        unsafe { CoInitializeEx(None, model) }
            .ok()
            .map(|()| Self)
            .map_err(|e| format!("CoInitializeEx: {e}"))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: balances the successful `CoInitializeEx` in `init`.
        unsafe { CoUninitialize() };
    }
}

/// A top-level window owned by the calling thread and never shown (like the app's main window before
/// `window_ready`). The system `STATIC` class needs no registration.
struct HiddenWindow(HWND);

impl HiddenWindow {
    fn create() -> Result<Self, String> {
        // SAFETY: creates a window of a system class on this thread; destroyed in `Drop` on the same thread.
        unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("Quran SMTC check"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                320,
                200,
                None,
                None,
                None,
                None,
            )
        }
        .map(Self)
        .map_err(|e| format!("CreateWindowExW: {e}"))
    }

    fn raw(&self) -> isize {
        self.0.0 as isize
    }
}

impl Drop for HiddenWindow {
    fn drop(&mut self) {
        // SAFETY: the window was created by this thread and is destroyed once.
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

/// A file in the temp directory, removed on drop.
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn write(extension: &str, bytes: &[u8]) -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("qd-smtc-check-{}.{extension}", std::process::id()));
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", display(&path)))?;
        Ok(Self { path })
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn display(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}
