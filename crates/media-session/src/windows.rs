//! Windows backend: `SystemMediaTransportControls` via `ISystemMediaTransportControlsInterop::GetForWindow(hwnd)` on a
//! dedicated thread (`qd-media`) initialised with `CoInitializeEx(COINIT_MULTITHREADED)`.
//!
//! Runtime check (`examples/smtc_check.rs`): `GetForWindow` called on this MTA thread for a window owned by the STA
//! main thread succeeds while the main thread is blocked (the shape of `media::init` inside tauri's setup), so the
//! controls are obtained and owned here and the `run_on_main_thread` fallback is not needed.
//!
//! - The controls stay **disabled** (no entry in the media flyout) until a recitation is loaded, and are disabled
//!   again on [`Status::Stopped`].
//! - Handles `ButtonPressed` (play, pause, stop, next, previous), `PlaybackPositionChangeRequested` and
//!   `PlaybackRateChangeRequested`; the handlers run on WinRT thread-pool threads and only call the
//!   [`CommandHandler`].
//! - Sets `MusicProperties` (title, artist, album), the thumbnail (artwork file → in-memory stream, so the shell never
//!   needs file access), the playback status and rate, button enablement and the timeline.
//! - Updates arrive over a channel and are coalesced: a burst applies only the latest metadata and the latest state.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use ::windows::Foundation::{TimeSpan, TypedEventHandler};
use ::windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    PlaybackRateChangeRequestedEventArgs, SystemMediaTransportControls,
    SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsDisplayUpdater, SystemMediaTransportControlsTimelineProperties,
};
use ::windows::Storage::Streams::{
    DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference,
};
use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use ::windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
use ::windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use ::windows::core::{HSTRING, Ref};

use crate::model::rate_command;
use crate::{
    Backend, CommandHandler, MediaCommand, MediaSessionError, Metadata, PlaybackState,
    SessionConfig, Status,
};

/// The backend thread's name.
const THREAD_NAME: &str = "qd-media";
/// How long [`WindowsBackend::start`] waits for the thread to obtain the controls (measured: under 10 ms).
const INIT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `shutdown` waits for the thread to hide the session and exit.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(1);
/// Larger artwork is ignored (the app icon is about 50 KB).
const MAX_ARTWORK_BYTES: u64 = 4 * 1024 * 1024;
/// At most this many queued updates are coalesced per wake-up.
const MAX_BATCH: usize = 64;

/// `SetCurrentProcessExplicitAppUserModelID(app_id)`; see [`crate::set_process_app_user_model_id`].
pub(crate) fn set_process_app_user_model_id(app_id: &str) -> Result<(), MediaSessionError> {
    let id = HSTRING::from(app_id);
    // SAFETY: a plain Win32 call; `id` is a valid NUL-terminated UTF-16 string that outlives the call, which copies it.
    unsafe { SetCurrentProcessExplicitAppUserModelID(&id) }
        .map_err(|e| MediaSessionError::platform("SetCurrentProcessExplicitAppUserModelID", e))
}

/// A message to the backend thread.
enum Msg {
    Metadata(Metadata),
    State(PlaybackState),
    Shutdown,
}

/// Handle on the `qd-media` thread, which owns the controls.
pub(crate) struct WindowsBackend {
    tx: Sender<Msg>,
    /// Disconnects when the thread has exited (its sender is dropped last).
    exited: Mutex<Receiver<()>>,
}

impl WindowsBackend {
    /// Spawns `qd-media`, which obtains the controls for `cfg.hwnd`, and waits up to [`INIT_TIMEOUT`] for the result.
    pub(crate) fn start(
        cfg: &SessionConfig,
        on_command: CommandHandler,
    ) -> Result<Self, MediaSessionError> {
        let hwnd = cfg.hwnd.filter(|&h| h != 0).ok_or_else(|| {
            MediaSessionError::Platform("SMTC needs the main window's HWND".to_owned())
        })?;
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name(THREAD_NAME.to_owned())
            .spawn(move || {
                let _exit = exit_tx;
                run(hwnd, &on_command, &rx, &ready_tx);
            })
            .map_err(|e| MediaSessionError::platform("spawn qd-media", e))?;
        match ready_rx.recv_timeout(INIT_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                tx,
                exited: Mutex::new(exit_rx),
            }),
            Ok(Err(e)) => Err(e),
            // Dropping `tx` makes the thread clean up and exit as soon as it gets past initialisation.
            Err(RecvTimeoutError::Timeout) => Err(MediaSessionError::Platform(format!(
                "SMTC did not start within {} s",
                INIT_TIMEOUT.as_secs()
            ))),
            Err(RecvTimeoutError::Disconnected) => Err(MediaSessionError::Platform(
                "the media thread exited while starting".to_owned(),
            )),
        }
    }

    fn send(&self, msg: Msg) {
        if self.tx.send(msg).is_err() {
            log::debug!("media session: the media thread has exited; update dropped");
        }
    }
}

impl Backend for WindowsBackend {
    fn set_metadata(&self, m: Metadata) {
        self.send(Msg::Metadata(m));
    }

    fn set_state(&self, s: PlaybackState) {
        self.send(Msg::State(s));
    }

    fn shutdown(self: Box<Self>) {
        self.send(Msg::Shutdown);
        let exited = self.exited.lock().unwrap_or_else(PoisonError::into_inner);
        match exited.recv_timeout(SHUTDOWN_WAIT) {
            Err(RecvTimeoutError::Disconnected) => log::debug!("media session: stopped"),
            Ok(()) | Err(RecvTimeoutError::Timeout) => {
                log::warn!("media session: the media thread did not stop within {SHUTDOWN_WAIT:?}");
            }
        }
    }
}

/// The `qd-media` thread: COM (MTA) → controls → apply updates until `Shutdown` or until every sender is gone.
fn run(
    hwnd: isize,
    on_command: &CommandHandler,
    rx: &Receiver<Msg>,
    ready: &SyncSender<Result<(), MediaSessionError>>,
) {
    let com = match Com::init_mta() {
        Ok(com) => com,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut smtc = match Smtc::attach(hwnd, on_command) {
        Ok(smtc) => smtc,
        Err(e) => {
            let _ = ready.send(Err(MediaSessionError::platform("SMTC GetForWindow", e)));
            return;
        }
    };
    if ready.send(Ok(())).is_ok() {
        while let Ok(first) = rx.recv() {
            let mut batch = Batch::default();
            batch.push(first);
            while batch.len < MAX_BATCH {
                match rx.try_recv() {
                    Ok(next) => batch.push(next),
                    Err(_) => break,
                }
            }
            if batch.shutdown {
                break;
            }
            if let Some(m) = batch.metadata {
                smtc.apply_metadata(&m);
            }
            if let Some(s) = batch.state {
                smtc.apply_state(s);
            }
        }
    }
    smtc.detach();
    // The controls must be released before COM is uninitialised on this thread.
    drop(smtc);
    drop(com);
}

/// Coalesced updates: the latest metadata and the latest state of a burst.
#[derive(Default)]
struct Batch {
    metadata: Option<Metadata>,
    state: Option<PlaybackState>,
    shutdown: bool,
    len: usize,
}

impl Batch {
    fn push(&mut self, msg: Msg) {
        self.len += 1;
        match msg {
            Msg::Metadata(m) => self.metadata = Some(m),
            Msg::State(s) => self.state = Some(s),
            Msg::Shutdown => self.shutdown = true,
        }
    }
}

/// COM initialised as MTA on the current thread; uninitialised on drop.
struct Com;

impl Com {
    fn init_mta() -> Result<Self, MediaSessionError> {
        // SAFETY: initialises COM on the calling thread (`qd-media`, which never initialised it otherwise); every
        // success (including S_FALSE) is balanced by exactly one `CoUninitialize` in `Drop`.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map(|()| Self)
            .map_err(|e| MediaSessionError::platform("CoInitializeEx(MTA)", e))
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        // SAFETY: balances the successful `CoInitializeEx` of `init_mta` on this same thread.
        unsafe { CoUninitialize() };
    }
}

/// Event-handler registration tokens.
struct Tokens {
    button: i64,
    position: i64,
    rate: i64,
}

/// The artwork currently shown, by source path.
struct Artwork {
    path: PathBuf,
    // Kept alive while it is the thumbnail.
    _stream: RandomAccessStreamReference,
}

/// The controls of the main window and what was last applied to them.
struct Smtc {
    controls: SystemMediaTransportControls,
    updater: SystemMediaTransportControlsDisplayUpdater,
    timeline: SystemMediaTransportControlsTimelineProperties,
    tokens: Tokens,
    enabled: bool,
    /// Surah-file duration from the last metadata (zero = unknown).
    duration: Duration,
    /// The last applied state (the timeline needs it again when the duration changes).
    state: PlaybackState,
    artwork: Option<Artwork>,
    /// The last error logged at warn level (repeats go to debug).
    last_error: Option<String>,
}

impl Smtc {
    /// `GetForWindow(hwnd)`, initial button set (play/pause/stop; next/previous follow the state), Music display type,
    /// the three event handlers. The controls start disabled.
    fn attach(hwnd: isize, on_command: &CommandHandler) -> ::windows::core::Result<Self> {
        let interop = ::windows::core::factory::<
            SystemMediaTransportControls,
            ISystemMediaTransportControlsInterop,
        >()?;
        // SAFETY: `hwnd` is the app's main window, which lives as long as the process (hidden, never destroyed, on
        // close-to-tray); `GetForWindow` only associates the controls with it and returns an owned reference.
        let controls: SystemMediaTransportControls =
            unsafe { interop.GetForWindow(HWND(hwnd as *mut c_void)) }?;
        controls.SetIsEnabled(false)?;
        controls.SetIsPlayEnabled(false)?;
        controls.SetIsPauseEnabled(false)?;
        controls.SetIsStopEnabled(false)?;
        controls.SetIsNextEnabled(false)?;
        controls.SetIsPreviousEnabled(false)?;
        controls.SetIsFastForwardEnabled(false)?;
        controls.SetIsRewindEnabled(false)?;
        controls.SetIsRecordEnabled(false)?;
        controls.SetIsChannelUpEnabled(false)?;
        controls.SetIsChannelDownEnabled(false)?;
        let updater = controls.DisplayUpdater()?;
        updater.SetType(MediaPlaybackType::Music)?;
        let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
        let tokens = register_handlers(&controls, on_command)?;
        Ok(Self {
            controls,
            updater,
            timeline,
            tokens,
            enabled: false,
            duration: Duration::ZERO,
            state: PlaybackState::STOPPED,
            artwork: None,
            last_error: None,
        })
    }

    fn apply_metadata(&mut self, m: &Metadata) {
        let result = self.write_metadata(m);
        self.report("metadata", result);
        self.duration = m.duration.unwrap_or_default();
        let result = self.write_timeline();
        self.report("timeline", result);
    }

    fn apply_state(&mut self, s: PlaybackState) {
        self.state = s;
        let result = self.write_state();
        self.report("playback state", result);
    }

    fn write_metadata(&mut self, m: &Metadata) -> ::windows::core::Result<()> {
        self.updater.SetType(MediaPlaybackType::Music)?;
        let props = self.updater.MusicProperties()?;
        props.SetTitle(&HSTRING::from(m.title.as_str()))?;
        props.SetArtist(&HSTRING::from(m.artist.as_str()))?;
        props.SetAlbumTitle(&HSTRING::from(m.album.as_str()))?;
        self.sync_artwork(m.artwork_path.as_deref())?;
        self.updater.Update()
    }

    /// Loads the artwork once per path; a file that cannot be loaded leaves the previous thumbnail (logged).
    fn sync_artwork(&mut self, path: Option<&Path>) -> ::windows::core::Result<()> {
        let Some(path) = path else {
            if self.artwork.take().is_some() {
                self.updater.SetThumbnail(None)?;
            }
            return Ok(());
        };
        if self.artwork.as_ref().is_some_and(|a| a.path == path) {
            return Ok(());
        }
        match load_thumbnail(path) {
            Ok(stream) => {
                self.updater.SetThumbnail(&stream)?;
                self.artwork = Some(Artwork {
                    path: path.to_owned(),
                    _stream: stream,
                });
            }
            Err(e) => {
                let name = path.file_name().map(Path::new).unwrap_or(path);
                log::warn!("media session: artwork `{}` not used: {e}", name.display());
            }
        }
        Ok(())
    }

    fn write_state(&mut self) -> ::windows::core::Result<()> {
        let s = self.state;
        let active = s.is_active();
        let c = &self.controls;
        if active && !self.enabled {
            c.SetIsEnabled(true)?;
            self.enabled = true;
        }
        c.SetPlaybackStatus(match s.status {
            Status::Playing => MediaPlaybackStatus::Playing,
            Status::Paused => MediaPlaybackStatus::Paused,
            Status::Stopped => MediaPlaybackStatus::Stopped,
        })?;
        c.SetPlaybackRate(s.effective_rate())?;
        c.SetIsPlayEnabled(active)?;
        c.SetIsPauseEnabled(active)?;
        c.SetIsStopEnabled(active)?;
        c.SetIsNextEnabled(active && s.can_next)?;
        c.SetIsPreviousEnabled(active && s.can_previous)?;
        self.write_timeline()?;
        if !active && self.enabled {
            self.controls.SetIsEnabled(false)?;
            self.enabled = false;
        }
        Ok(())
    }

    /// Start 0, end = surah-file duration, seekable range `[0, end]` when `can_seek`, position clamped to the end.
    /// An unknown duration shows no timeline (all zero).
    fn write_timeline(&self) -> ::windows::core::Result<()> {
        let t = timeline(self.duration, &self.state);
        let tl = &self.timeline;
        tl.SetStartTime(ticks(Duration::ZERO))?;
        tl.SetEndTime(ticks(t.end))?;
        tl.SetMinSeekTime(ticks(Duration::ZERO))?;
        tl.SetMaxSeekTime(ticks(t.max_seek))?;
        tl.SetPosition(ticks(t.position))?;
        self.controls.UpdateTimelineProperties(tl)
    }

    /// Unregisters the handlers, hides the session and clears the display. Errors are logged at debug level (the
    /// window may already be gone at exit).
    fn detach(&mut self) {
        let c = &self.controls;
        let steps = [
            (
                "RemoveButtonPressed",
                c.RemoveButtonPressed(self.tokens.button),
            ),
            (
                "RemovePlaybackPositionChangeRequested",
                c.RemovePlaybackPositionChangeRequested(self.tokens.position),
            ),
            (
                "RemovePlaybackRateChangeRequested",
                c.RemovePlaybackRateChangeRequested(self.tokens.rate),
            ),
            ("SetIsEnabled(false)", c.SetIsEnabled(false)),
            ("ClearAll", self.updater.ClearAll()),
            ("Update", self.updater.Update()),
        ];
        for (step, result) in steps {
            if let Err(e) = result {
                log::debug!("media session: detach: {step}: {e}");
            }
        }
        self.enabled = false;
        self.artwork = None;
    }

    /// Logs a failed update at warn level once per distinct error, repeats at debug level.
    fn report(&mut self, what: &str, result: ::windows::core::Result<()>) {
        let Err(e) = result else {
            return;
        };
        let message = format!("{what}: {e}");
        if self.last_error.as_deref() == Some(message.as_str()) {
            log::debug!("media session: {message}");
        } else {
            log::warn!("media session: {message}");
            self.last_error = Some(message);
        }
    }
}

/// Registers the three handlers; on failure, removes the ones already registered.
fn register_handlers(
    controls: &SystemMediaTransportControls,
    on_command: &CommandHandler,
) -> ::windows::core::Result<Tokens> {
    let handler = on_command.clone();
    let button = controls.ButtonPressed(&TypedEventHandler::new(
        move |_, args: Ref<'_, SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(cmd) = button_command(args.ok()?.Button()?) {
                handler(cmd);
            }
            Ok(())
        },
    ))?;
    let handler = on_command.clone();
    let position = controls.PlaybackPositionChangeRequested(&TypedEventHandler::new(
        move |_, args: Ref<'_, PlaybackPositionChangeRequestedEventArgs>| {
            let requested = args.ok()?.RequestedPlaybackPosition()?;
            handler(MediaCommand::SeekTo(duration_from_ticks(
                requested.Duration,
            )));
            Ok(())
        },
    ));
    let position = match position {
        Ok(token) => token,
        Err(e) => {
            let _ = controls.RemoveButtonPressed(button);
            return Err(e);
        }
    };
    let handler = on_command.clone();
    let rate = controls.PlaybackRateChangeRequested(&TypedEventHandler::new(
        move |_, args: Ref<'_, PlaybackRateChangeRequestedEventArgs>| {
            if let Some(cmd) = rate_command(args.ok()?.RequestedPlaybackRate()?) {
                handler(cmd);
            }
            Ok(())
        },
    ));
    match rate {
        Ok(rate) => Ok(Tokens {
            button,
            position,
            rate,
        }),
        Err(e) => {
            let _ = controls.RemoveButtonPressed(button);
            let _ = controls.RemovePlaybackPositionChangeRequested(position);
            Err(e)
        }
    }
}

/// SMTC button → command. Fast-forward, rewind, record and channel buttons stay disabled and are ignored.
fn button_command(button: SystemMediaTransportControlsButton) -> Option<MediaCommand> {
    use SystemMediaTransportControlsButton as B;
    match button {
        B::Play => Some(MediaCommand::Play),
        B::Pause => Some(MediaCommand::Pause),
        B::Stop => Some(MediaCommand::Stop),
        B::Next => Some(MediaCommand::Next),
        B::Previous => Some(MediaCommand::Previous),
        _ => None,
    }
}

/// The timeline values SMTC gets for a duration and a state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Timeline {
    end: Duration,
    max_seek: Duration,
    position: Duration,
}

fn timeline(duration: Duration, s: &PlaybackState) -> Timeline {
    if duration.is_zero() || !s.is_active() {
        return Timeline {
            end: duration,
            max_seek: Duration::ZERO,
            position: Duration::ZERO,
        };
    }
    Timeline {
        end: duration,
        max_seek: if s.can_seek { duration } else { Duration::ZERO },
        position: s.position.min(duration),
    }
}

/// `Duration` → WinRT `TimeSpan` (100 ns ticks), saturating.
fn ticks(d: Duration) -> TimeSpan {
    TimeSpan {
        Duration: i64::try_from(d.as_nanos() / 100).unwrap_or(i64::MAX),
    }
}

/// WinRT ticks → `Duration`; negative requests clamp to zero (the windows crate's `From` would wrap or overflow).
fn duration_from_ticks(ticks: i64) -> Duration {
    u64::try_from(ticks).map_or(Duration::ZERO, |t| {
        Duration::from_nanos(t.saturating_mul(100))
    })
}

/// Reads the artwork into an in-memory stream (the shell reads the thumbnail through our process, so it never needs
/// access to the file, and an unpackaged app has no `ms-appdata:` URIs).
fn load_thumbnail(path: &Path) -> Result<RandomAccessStreamReference, String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len == 0 || len > MAX_ARTWORK_BYTES {
        return Err(format!("size {len} B is outside 1..={MAX_ARTWORK_BYTES} B"));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    in_memory_stream(&bytes).map_err(|e| e.to_string())
}

fn in_memory_stream(bytes: &[u8]) -> ::windows::core::Result<RandomAccessStreamReference> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(bytes)?;
    writer.StoreAsync()?.join()?;
    writer.FlushAsync()?.join()?;
    // Detach so that dropping the writer does not close the stream.
    writer.DetachStream()?;
    stream.Seek(0)?;
    RandomAccessStreamReference::CreateFromStream(&stream)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn state(status: Status, position_ms: u64, can_seek: bool) -> PlaybackState {
        PlaybackState {
            status,
            position: Duration::from_millis(position_ms),
            rate: 1.0,
            can_next: true,
            can_previous: true,
            can_seek,
        }
    }

    #[test]
    fn buttons_map_to_commands() {
        use SystemMediaTransportControlsButton as B;
        assert_eq!(button_command(B::Play), Some(MediaCommand::Play));
        assert_eq!(button_command(B::Pause), Some(MediaCommand::Pause));
        assert_eq!(button_command(B::Stop), Some(MediaCommand::Stop));
        assert_eq!(button_command(B::Next), Some(MediaCommand::Next));
        assert_eq!(button_command(B::Previous), Some(MediaCommand::Previous));
        for ignored in [
            B::FastForward,
            B::Rewind,
            B::Record,
            B::ChannelUp,
            B::ChannelDown,
        ] {
            assert_eq!(button_command(ignored), None, "{ignored:?}");
        }
    }

    #[test]
    fn ticks_round_trip_and_saturate() {
        assert_eq!(ticks(Duration::from_millis(1_500)).Duration, 15_000_000);
        assert_eq!(ticks(Duration::MAX).Duration, i64::MAX);
        assert_eq!(
            duration_from_ticks(15_000_000),
            Duration::from_millis(1_500)
        );
        assert_eq!(duration_from_ticks(-1), Duration::ZERO);
        assert_eq!(duration_from_ticks(i64::MIN), Duration::ZERO);
        assert_eq!(
            duration_from_ticks(i64::MAX),
            Duration::from_nanos(u64::MAX)
        );
    }

    #[test]
    fn the_timeline_clamps_and_hides() {
        let d = Duration::from_secs(60);
        assert_eq!(
            timeline(d, &state(Status::Playing, 12_000, true)),
            Timeline {
                end: d,
                max_seek: d,
                position: Duration::from_secs(12),
            }
        );
        // Not seekable: no seek range.
        assert_eq!(
            timeline(d, &state(Status::Paused, 12_000, false)).max_seek,
            Duration::ZERO
        );
        // Position past the end is clamped.
        assert_eq!(
            timeline(d, &state(Status::Playing, 90_000, true)).position,
            d
        );
        // Unknown duration or nothing loaded: no position.
        assert_eq!(
            timeline(Duration::ZERO, &state(Status::Playing, 5_000, true)).position,
            Duration::ZERO
        );
        assert_eq!(
            timeline(d, &state(Status::Stopped, 5_000, true)).position,
            Duration::ZERO
        );
    }

    #[test]
    fn a_burst_keeps_the_latest_of_each_kind() {
        let mut batch = Batch::default();
        batch.push(Msg::State(state(Status::Playing, 1, true)));
        batch.push(Msg::Metadata(Metadata {
            title: "a".into(),
            ..Metadata::default()
        }));
        batch.push(Msg::Metadata(Metadata {
            title: "b".into(),
            ..Metadata::default()
        }));
        batch.push(Msg::State(state(Status::Paused, 2, true)));
        assert_eq!(batch.len, 4);
        assert_eq!(batch.metadata.unwrap().title, "b");
        assert_eq!(batch.state.unwrap().status, Status::Paused);
        assert!(!batch.shutdown);
    }

    #[test]
    fn artwork_streams_hold_the_bytes() {
        let _com = Com::init_mta().unwrap();
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let reference = in_memory_stream(&png).unwrap();
        let stream = reference.OpenReadAsync().unwrap().join().unwrap();
        assert_eq!(stream.Size().unwrap(), png.len() as u64);
    }

    #[test]
    fn unusable_artwork_files_are_rejected() {
        let dir = std::env::temp_dir().join(format!("qd-media-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(load_thumbnail(&empty).is_err());
        assert!(load_thumbnail(&dir.join("missing.png")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn start_without_a_window_fails_fast() {
        let cfg = SessionConfig {
            app_id: "com.quran.labs.desktop".into(),
            desktop_entry: "Quran".into(),
            display_name: "Quran".into(),
            dbus_name: "quran_desktop".into(),
            hwnd: None,
        };
        let on_command: CommandHandler = std::sync::Arc::new(|_| {});
        assert!(matches!(
            WindowsBackend::start(&cfg, on_command.clone()),
            Err(MediaSessionError::Platform(_))
        ));
        let zero = SessionConfig {
            hwnd: Some(0),
            ..cfg
        };
        assert!(WindowsBackend::start(&zero, on_command).is_err());
    }

    #[test]
    fn a_handle_that_is_no_window_is_reported_by_the_os() {
        let cfg = SessionConfig {
            app_id: "com.quran.labs.desktop".into(),
            desktop_entry: "Quran".into(),
            display_name: "Quran".into(),
            dbus_name: "quran_desktop".into(),
            // Window handles are small even numbers in a 32-bit range; this one never names a window.
            hwnd: Some(0x7FFF_FFF1),
        };
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&calls);
        let on_command: CommandHandler = std::sync::Arc::new(move |_| {
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        match WindowsBackend::start(&cfg, on_command) {
            Err(MediaSessionError::Platform(message)) => {
                assert!(message.starts_with("SMTC GetForWindow"), "{message}");
            }
            Err(other) => panic!("unexpected error {other:?}"),
            Ok(_) => panic!("GetForWindow accepted a handle that is no window"),
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
