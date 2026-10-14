//! macOS backend: `MPNowPlayingInfoCenter` (Now Playing in Control Center and the menu bar, the lock screen, media
//! keys) and `MPRemoteCommandCenter`, every call marshalled to the main thread through the [`MainThreadDispatch`]
//! (`AppHandle::run_on_main_thread`).
//!
//! - `nowPlayingInfo`: title, artist, album, duration, elapsed time, `MPNowPlayingInfoPropertyPlaybackRate` (the real
//!   speed while playing, 0 while paused), the default rate 1.0, the media type (audio) and the artwork (the app
//!   icon file, loaded once into an `MPMediaItemArtwork`).
//! - **`playbackState` is set on every state update** (Playing, Paused or Stopped): an app that does not play through
//!   AVFoundation shows the wrong play/pause state, and media keys do not toggle reliably, with `nowPlayingInfo` alone.
//! - Remote commands: play, pause, toggle, stop, next, previous, `changePlaybackPosition` and `changePlaybackRate`
//!   (supported rates 0.5…2.0). They are enabled only while a recitation is loaded; next/previous/position follow the
//!   state's capabilities.
//! - [`Status::Stopped`] (nothing loaded), `shutdown` and drop set `playbackState = Stopped`, clear `nowPlayingInfo`
//!   and disable every command, so macOS hands Now Playing and the media keys to another app.
//! - Updates are coalesced: a burst of `set_metadata`/`set_state` calls schedules **one** main-thread job, which
//!   applies the latest metadata and state.
//!
//! The Objective-C objects (command targets, artwork) live in a main-thread-local [`Center`]; the handle itself only
//! holds plain data and is `Send + Sync`. When the session is created on the main thread (tauri's `setup`), the
//! command handlers are registered at once; otherwise the registration is the first dispatched job.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::{Allocated, Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{AnyThread, DowncastTarget, MainThreadMarker, msg_send};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSSize, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPChangePlaybackRateCommandEvent, MPMediaItemArtwork,
    MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork,
    MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingInfoMediaType, MPNowPlayingInfoPropertyDefaultPlaybackRate,
    MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyMediaType,
    MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommand,
    MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};

use crate::model::rate_command;
use crate::{
    Backend, CommandHandler, MainThreadDispatch, MediaCommand, MediaSessionError, Metadata,
    PlaybackState, SessionConfig, Status,
};

/// The rates `changePlaybackRate` offers (0.5…2.0; the app rounds any request to 5 %).
const SUPPORTED_RATES: [f32; 7] = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
/// How long `shutdown` waits for the main thread to clear Now Playing when called from another thread.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(1);

/// Session ids: the newest live session owns the process-wide Now Playing state.
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// Handle on the Now Playing state. Every Objective-C call runs on the main thread.
pub(crate) struct MacBackend {
    shared: Arc<Shared>,
    dispatch: MainThreadDispatch,
}

/// What the handle and its main-thread jobs share.
struct Shared {
    session: u64,
    on_command: CommandHandler,
    pending: Mutex<Pending>,
}

impl Shared {
    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The latest inputs, and whether a main-thread flush is already scheduled.
#[derive(Debug, Default)]
struct Pending {
    metadata: Option<Metadata>,
    state: PlaybackState,
    scheduled: bool,
    closed: bool,
}

impl MacBackend {
    /// Registers the remote-command handlers on the main thread (right away when called there) and returns. Fails
    /// only without a dispatcher.
    pub(crate) fn start(
        _cfg: &SessionConfig,
        dispatch: Option<MainThreadDispatch>,
        on_command: CommandHandler,
    ) -> Result<Self, MediaSessionError> {
        let dispatch = dispatch.ok_or_else(|| {
            MediaSessionError::Platform(
                "Now Playing needs the main-thread dispatcher (AppHandle::run_on_main_thread)"
                    .to_owned(),
            )
        })?;
        let backend = Self {
            shared: Arc::new(Shared {
                session: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
                on_command,
                pending: Mutex::default(),
            }),
            dispatch,
        };
        let shared = Arc::clone(&backend.shared);
        backend.on_main(move || {
            if !shared.pending().closed {
                with_center(&shared, |_| {});
            }
        });
        Ok(backend)
    }

    /// Runs `job` on the main thread: now when already there, else through the dispatcher.
    fn on_main(&self, job: impl FnOnce() + Send + 'static) {
        if MainThreadMarker::new().is_some() {
            run_on_main(job);
        } else {
            (self.dispatch)(Box::new(move || run_on_main(job)));
        }
    }

    /// Records an update and schedules one flush per burst.
    fn update(&self, change: impl FnOnce(&mut Pending)) {
        let schedule = {
            let mut pending = self.shared.pending();
            if pending.closed {
                return;
            }
            change(&mut pending);
            !std::mem::replace(&mut pending.scheduled, true)
        };
        if schedule {
            let shared = Arc::clone(&self.shared);
            self.on_main(move || flush(&shared));
        }
    }

    /// Marks the session closed; `true` the first time.
    fn close(&self) -> bool {
        !std::mem::replace(&mut self.shared.pending().closed, true)
    }
}

impl Backend for MacBackend {
    fn set_metadata(&self, m: Metadata) {
        self.update(|pending| pending.metadata = Some(m));
    }

    fn set_state(&self, s: PlaybackState) {
        self.update(|pending| pending.state = s);
    }

    fn shutdown(self: Box<Self>) {
        if !self.close() {
            return;
        }
        let session = self.shared.session;
        if MainThreadMarker::new().is_some() {
            run_on_main(move || detach(session));
            log::debug!("media session: stopped");
            return;
        }
        let (done_tx, done_rx) = mpsc::channel::<()>();
        (self.dispatch)(Box::new(move || {
            run_on_main(move || detach(session));
            let _ = done_tx.send(());
        }));
        match done_rx.recv_timeout(SHUTDOWN_WAIT) {
            Ok(()) => log::debug!("media session: stopped"),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                log::warn!(
                    "media session: the main thread did not clear Now Playing within {SHUTDOWN_WAIT:?}"
                );
            }
        }
    }
}

impl Drop for MacBackend {
    /// Dropped without `shutdown`: clear Now Playing without waiting.
    fn drop(&mut self) {
        if self.close() {
            let session = self.shared.session;
            self.on_main(move || detach(session));
        }
    }
}

/// Runs a job that must be on the main thread inside an autorelease pool; refuses (logged) anywhere else.
fn run_on_main(job: impl FnOnce()) {
    if MainThreadMarker::new().is_none() {
        log::warn!("media session: a Now Playing job ran off the main thread and was skipped");
        return;
    }
    autoreleasepool(|_| job());
}

/// The scheduled main-thread job: show the latest metadata and state.
fn flush(shared: &Shared) {
    if let Some((metadata, state)) = take_pending(shared) {
        let display = display(metadata.as_ref(), &state);
        with_center(shared, |center| center.show(&display));
    }
}

/// Re-arms scheduling (the next update schedules a new flush) and returns the latest inputs; `None` once closed.
fn take_pending(shared: &Shared) -> Option<(Option<Metadata>, PlaybackState)> {
    let mut pending = shared.pending();
    pending.scheduled = false;
    (!pending.closed).then(|| (pending.metadata.clone(), pending.state))
}

// ---- What Now Playing shows (pure; unit-tested) ----

/// A remote command the backend handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Remote {
    Play,
    Pause,
    Toggle,
    Stop,
    Next,
    Previous,
    Position,
    Rate,
}

impl Remote {
    const ALL: [Self; 8] = [
        Self::Play,
        Self::Pause,
        Self::Toggle,
        Self::Stop,
        Self::Next,
        Self::Previous,
        Self::Position,
        Self::Rate,
    ];

    /// The command of a remote command without a payload (`Position` and `Rate` read their event).
    fn fixed(self) -> Option<MediaCommand> {
        match self {
            Self::Play => Some(MediaCommand::Play),
            Self::Pause => Some(MediaCommand::Pause),
            Self::Toggle => Some(MediaCommand::Toggle),
            Self::Stop => Some(MediaCommand::Stop),
            Self::Next => Some(MediaCommand::Next),
            Self::Previous => Some(MediaCommand::Previous),
            Self::Position | Self::Rate => None,
        }
    }
}

/// Which remote commands are enabled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Enabled {
    transport: bool,
    next: bool,
    previous: bool,
    position: bool,
}

impl Enabled {
    fn get(self, remote: Remote) -> bool {
        match remote {
            Remote::Play | Remote::Pause | Remote::Toggle | Remote::Stop | Remote::Rate => {
                self.transport
            }
            Remote::Next => self.next,
            Remote::Previous => self.previous,
            Remote::Position => self.position,
        }
    }
}

/// The `nowPlayingInfo` entries.
#[derive(Debug, Clone, PartialEq)]
struct Info {
    title: String,
    artist: String,
    album: String,
    /// Seconds; `None` when unknown.
    duration: Option<f64>,
    /// Seconds into the surah file.
    elapsed: f64,
    /// The real speed while playing, 0 while paused (macOS extrapolates `elapsed` with it).
    rate: f64,
    artwork: Option<PathBuf>,
}

/// Everything Now Playing shows for a metadata and a state.
#[derive(Debug, Clone, PartialEq)]
struct Display {
    status: Status,
    /// `None` clears `nowPlayingInfo`.
    info: Option<Info>,
    enabled: Enabled,
}

fn display(metadata: Option<&Metadata>, state: &PlaybackState) -> Display {
    if !state.is_active() {
        return Display {
            status: Status::Stopped,
            info: None,
            enabled: Enabled::default(),
        };
    }
    let fallback = Metadata::default();
    let m = metadata.unwrap_or(&fallback);
    let duration = m.duration.filter(|d| !d.is_zero());
    let elapsed = duration.map_or(state.position, |d| state.position.min(d));
    Display {
        status: state.status,
        info: Some(Info {
            title: m.title.clone(),
            artist: m.artist.clone(),
            album: m.album.clone(),
            duration: duration.map(|d| d.as_secs_f64()),
            elapsed: elapsed.as_secs_f64(),
            rate: if state.status == Status::Playing {
                state.effective_rate()
            } else {
                0.0
            },
            artwork: m.artwork_path.clone(),
        }),
        enabled: Enabled {
            transport: true,
            next: state.can_next,
            previous: state.can_previous,
            position: state.can_seek && duration.is_some(),
        },
    }
}

/// What a session's main-thread job does with the process-wide Now Playing state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Claim {
    /// The session owns it already.
    Owned,
    /// A newer session owns it: the job is skipped (an older session never takes Now Playing back).
    Yield,
    /// Nobody, or an older session, owns it: the session takes it over.
    Take,
}

/// The newest live session owns Now Playing (`owner` is the session that holds it now, if any).
fn claim(owner: Option<u64>, session: u64) -> Claim {
    match owner {
        Some(owner) if owner == session => Claim::Owned,
        Some(owner) if owner > session => Claim::Yield,
        _ => Claim::Take,
    }
}

/// `changePlaybackPosition` → `SeekTo`; `None` for a NaN, negative or overflowing time.
fn seek_command(seconds: f64) -> Option<MediaCommand> {
    Duration::try_from_secs_f64(seconds)
        .ok()
        .map(MediaCommand::SeekTo)
}

/// `changePlaybackRate` → `SetRate`; `None` for a rate no player can honour.
fn rate_request(rate: f32) -> Option<MediaCommand> {
    rate_command(f64::from(rate))
}

// ---- The main-thread side ----

thread_local! {
    /// The Objective-C side of the live session. Only the main thread ever fills it.
    static CENTER: RefCell<Option<Center>> = const { RefCell::new(None) };
}

/// Runs `f` on the live session's [`Center`], registering it first (a newer session replaces an older one; an older
/// session never takes over from a newer one).
fn with_center(shared: &Shared, f: impl FnOnce(&mut Center)) {
    let visited = CENTER.try_with(|cell| {
        let Ok(mut slot) = cell.try_borrow_mut() else {
            log::debug!("media session: Now Playing is busy; update skipped");
            return;
        };
        match claim(slot.as_ref().map(|center| center.session), shared.session) {
            Claim::Owned => {}
            Claim::Yield => {
                log::debug!("media session: a newer session owns Now Playing; update skipped");
                return;
            }
            Claim::Take => {
                if let Some(old) = slot.take() {
                    old.detach();
                }
                *slot = Some(Center::attach(shared.session, &shared.on_command));
            }
        }
        if let Some(center) = slot.as_mut() {
            f(center);
        }
    });
    if visited.is_err() {
        log::debug!("media session: Now Playing state is gone (main thread exiting)");
    }
}

/// Clears Now Playing and unregisters the handlers when `session` owns them.
fn detach(session: u64) {
    let _ = CENTER.try_with(|cell| {
        let Ok(mut slot) = cell.try_borrow_mut() else {
            return;
        };
        if slot
            .as_ref()
            .is_some_and(|center| center.session == session)
            && let Some(center) = slot.take()
        {
            center.detach();
        }
    });
}

/// A registered command handler.
struct Target {
    remote: Remote,
    command: Retained<MPRemoteCommand>,
    /// The opaque target `addTargetWithHandler` returned (needed to remove it).
    token: Retained<AnyObject>,
}

/// The artwork for one file (`None` when it could not be loaded: not retried for the same path).
struct Artwork {
    path: PathBuf,
    artwork: Option<Retained<MPMediaItemArtwork>>,
}

/// The Objective-C side of a session: the registered handlers, what was last applied, the artwork.
struct Center {
    session: u64,
    targets: Vec<Target>,
    enabled: Enabled,
    artwork: Option<Artwork>,
}

impl Center {
    /// Registers a handler for every [`Remote`] (all disabled) and starts from a cleared Now Playing.
    fn attach(session: u64, on_command: &CommandHandler) -> Self {
        // SAFETY: the shared command center is a process-wide singleton, valid for the process lifetime.
        let commands = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };
        let targets = Remote::ALL
            .into_iter()
            .map(|remote| {
                let command = remote_command(&commands, remote);
                let handler = on_command.clone();
                let block = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
                    handle(remote, &handler, event)
                });
                // SAFETY: `command` is a live command of the shared center; the block is retained by the command
                // (through the returned target) until `removeTarget:`.
                let token = unsafe {
                    command.setEnabled(false);
                    command.addTargetWithHandler(&block)
                };
                Target {
                    remote,
                    command,
                    token,
                }
            })
            .collect();
        let rates: Vec<Retained<NSNumber>> =
            SUPPORTED_RATES.into_iter().map(NSNumber::new_f32).collect();
        // SAFETY: an array of NSNumber floats, as `supportedPlaybackRates` documents; the setter copies it.
        unsafe {
            commands
                .changePlaybackRateCommand()
                .setSupportedPlaybackRates(&NSArray::from_retained_slice(&rates));
        }
        clear_now_playing();
        log::debug!("media session: Now Playing commands registered");
        Self {
            session,
            targets,
            enabled: Enabled::default(),
            artwork: None,
        }
    }

    /// Applies a [`Display`]: command enablement, `nowPlayingInfo` and `playbackState` (on every update).
    fn show(&mut self, display: &Display) {
        self.set_enabled(display.enabled);
        let Some(info) = &display.info else {
            clear_now_playing();
            return;
        };
        let dictionary = self.dictionary(info);
        // SAFETY: the default center is a process-wide singleton; the dictionary maps NSString keys to the value
        // types the MediaPlayer keys document (NSString, NSNumber, MPMediaItemArtwork) and is copied by the setter.
        unsafe {
            let center = MPNowPlayingInfoCenter::defaultCenter();
            center.setNowPlayingInfo(Some(&dictionary));
            center.setPlaybackState(playback_state(display.status));
        }
    }

    fn set_enabled(&mut self, enabled: Enabled) {
        for target in &self.targets {
            let on = enabled.get(target.remote);
            if on != self.enabled.get(target.remote) {
                // SAFETY: a live command of the shared center.
                unsafe { target.command.setEnabled(on) };
            }
        }
        self.enabled = enabled;
    }

    /// The `nowPlayingInfo` dictionary for `info` (empty strings and unknown values are left out).
    fn dictionary(&mut self, info: &Info) -> Retained<NSDictionary<NSString, AnyObject>> {
        let title = NSString::from_str(&info.title);
        let artist = NSString::from_str(&info.artist);
        let album = NSString::from_str(&info.album);
        let duration = info.duration.map(NSNumber::new_f64);
        let elapsed = NSNumber::new_f64(info.elapsed);
        let rate = NSNumber::new_f64(info.rate);
        let default_rate = NSNumber::new_f64(1.0);
        let media_type = NSNumber::new_usize(MPNowPlayingInfoMediaType::Audio.0);
        let artwork = info.artwork.as_deref().and_then(|path| self.artwork(path));

        let mut entries: Vec<(&NSString, &AnyObject)> = Vec::with_capacity(9);
        // SAFETY: the keys are immutable framework constants (extern statics of MediaPlayer, macOS 10.12.2+).
        unsafe {
            entries.push(entry(MPNowPlayingInfoPropertyElapsedPlaybackTime, &elapsed));
            entries.push(entry(MPNowPlayingInfoPropertyPlaybackRate, &rate));
            entries.push(entry(
                MPNowPlayingInfoPropertyDefaultPlaybackRate,
                &default_rate,
            ));
            entries.push(entry(MPNowPlayingInfoPropertyMediaType, &media_type));
            if !info.title.is_empty() {
                entries.push(entry(MPMediaItemPropertyTitle, &title));
            }
            if !info.artist.is_empty() {
                entries.push(entry(MPMediaItemPropertyArtist, &artist));
            }
            if !info.album.is_empty() {
                entries.push(entry(MPMediaItemPropertyAlbumTitle, &album));
            }
            if let Some(duration) = &duration {
                entries.push(entry(MPMediaItemPropertyPlaybackDuration, duration));
            }
            if let Some(artwork) = &artwork {
                entries.push(entry(MPMediaItemPropertyArtwork, artwork));
            }
        }
        // Built in pairs, so the two slices always have the same length.
        let (keys, values): (Vec<&NSString>, Vec<&AnyObject>) = entries.into_iter().unzip();
        NSDictionary::from_slices(&keys, &values)
    }

    /// The artwork for `path`, loaded once per path.
    fn artwork(&mut self, path: &Path) -> Option<Retained<MPMediaItemArtwork>> {
        if self.artwork.as_ref().is_none_or(|a| a.path != path) {
            let artwork = load_artwork(path);
            if artwork.is_none() {
                let name = path.file_name().map(Path::new).unwrap_or(path);
                log::warn!("media session: artwork `{}` not used", name.display());
            }
            self.artwork = Some(Artwork {
                path: path.to_owned(),
                artwork,
            });
        }
        self.artwork.as_ref().and_then(|a| a.artwork.clone())
    }

    /// Clears Now Playing and removes every handler, leaving the commands disabled.
    fn detach(self) {
        clear_now_playing();
        for target in self.targets {
            // SAFETY: `token` is the target this session added to this command.
            unsafe {
                target.command.removeTarget(Some(&target.token));
                target.command.setEnabled(false);
            }
        }
        log::debug!("media session: Now Playing cleared");
    }
}

/// A `nowPlayingInfo` entry (the value coerces to `AnyObject`).
fn entry<'a>(key: &'a NSString, value: &'a AnyObject) -> (&'a NSString, &'a AnyObject) {
    (key, value)
}

/// `playbackState = Stopped` and an empty `nowPlayingInfo`: macOS stops showing the app as Now Playing.
fn clear_now_playing() {
    // SAFETY: the default center is a process-wide singleton; `nil` clears the info.
    unsafe {
        let center = MPNowPlayingInfoCenter::defaultCenter();
        center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
        center.setNowPlayingInfo(None);
    }
}

fn playback_state(status: Status) -> MPNowPlayingPlaybackState {
    match status {
        Status::Playing => MPNowPlayingPlaybackState::Playing,
        Status::Paused => MPNowPlayingPlaybackState::Paused,
        Status::Stopped => MPNowPlayingPlaybackState::Stopped,
    }
}

/// The shared center's command for a [`Remote`].
fn remote_command(commands: &MPRemoteCommandCenter, remote: Remote) -> Retained<MPRemoteCommand> {
    // SAFETY: getters of the shared command center; each returns a live command object.
    unsafe {
        match remote {
            Remote::Play => commands.playCommand(),
            Remote::Pause => commands.pauseCommand(),
            Remote::Toggle => commands.togglePlayPauseCommand(),
            Remote::Stop => commands.stopCommand(),
            Remote::Next => commands.nextTrackCommand(),
            Remote::Previous => commands.previousTrackCommand(),
            Remote::Position => commands.changePlaybackPositionCommand().into_super(),
            Remote::Rate => commands.changePlaybackRateCommand().into_super(),
        }
    }
}

/// A remote-command handler (main thread): forwards the command, or reports a malformed event as failed.
fn handle(
    remote: Remote,
    on_command: &CommandHandler,
    event: NonNull<MPRemoteCommandEvent>,
) -> MPRemoteCommandHandlerStatus {
    // SAFETY: the command center passes a valid event that outlives the handler call.
    let event: &MPRemoteCommandEvent = unsafe { event.as_ref() };
    let command = match remote {
        Remote::Position => event
            .downcast_ref::<MPChangePlaybackPositionCommandEvent>()
            // SAFETY: a plain getter of the (checked) event class.
            .and_then(|e| seek_command(unsafe { e.positionTime() })),
        Remote::Rate => event
            .downcast_ref::<MPChangePlaybackRateCommandEvent>()
            // SAFETY: a plain getter of the (checked) event class.
            .and_then(|e| rate_request(unsafe { e.playbackRate() })),
        fixed => fixed.fixed(),
    };
    match command {
        Some(command) => {
            on_command(command);
            MPRemoteCommandHandlerStatus::Success
        }
        None => MPRemoteCommandHandlerStatus::CommandFailed,
    }
}

/// Loads an image file into an `MPMediaItemArtwork`. `None` without AppKit (no `NSImage` class), for an unreadable
/// or empty image, or a non-UTF-8 path.
fn load_artwork(path: &Path) -> Option<Retained<MPMediaItemArtwork>> {
    let path = NSString::from_str(path.to_str()?);
    // AppKit is loaded in every GUI app (tao links it); a bare test binary may not have it.
    let class = AnyClass::get(c"NSImage")?;
    // SAFETY: `+[NSImage alloc]` then `-[NSImage initWithContentsOfFile:]` (NSString * → instancetype, nil when the
    // file cannot be read or decoded).
    let image: Option<Retained<AnyObject>> = unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        msg_send![allocated, initWithContentsOfFile: &*path]
    };
    let image = image?;
    // SAFETY: `-[NSImage size]` returns an NSSize.
    let size: NSSize = unsafe { msg_send![&*image, size] };
    if !(size.width > 0.0 && size.height > 0.0) {
        return None;
    }
    artwork_with_image(
        MPMediaItemArtwork::initWithBoundsSize_requestHandler,
        image,
        size,
    )
}

/// The signature of `MPMediaItemArtwork::initWithBoundsSize_requestHandler`, generic over the image class.
type ArtworkInit<I> = unsafe fn(
    Allocated<MPMediaItemArtwork>,
    NSSize,
    &DynBlock<dyn Fn(NSSize) -> NonNull<I>>,
) -> Retained<MPMediaItemArtwork>;

/// `-[MPMediaItemArtwork initWithBoundsSize:requestHandler:]` with a handler that returns `image`. The image class
/// (`NSImage`) is taken from the initialiser's signature, so no AppKit binding is needed here; `image` is checked to
/// be of that class.
fn artwork_with_image<I: DowncastTarget>(
    init: ArtworkInit<I>,
    image: Retained<AnyObject>,
    size: NSSize,
) -> Option<Retained<MPMediaItemArtwork>> {
    let image = image.downcast::<I>().ok()?;
    let handler = RcBlock::new(move |_size: NSSize| NonNull::from(&*image));
    // SAFETY: the handler returns a pointer to the image it owns, which lives as long as the block, and the artwork
    // retains the block.
    Some(unsafe { init(MPMediaItemArtwork::alloc(), size, &handler) })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn metadata() -> Metadata {
        Metadata {
            title: "Al-Baqarah 2:255".into(),
            artist: "Mishari Rashid al-Afasy".into(),
            album: "The Holy Quran".into(),
            duration: Some(Duration::from_secs(240)),
            artwork_path: Some(PathBuf::from(
                "/Users/user/Library/Application Support/media-artwork.png",
            )),
        }
    }

    fn state(status: Status, position_ms: u64) -> PlaybackState {
        PlaybackState {
            status,
            position: Duration::from_millis(position_ms),
            rate: 1.25,
            can_next: true,
            can_previous: true,
            can_seek: true,
        }
    }

    #[test]
    fn nothing_loaded_clears_now_playing() {
        let hidden = display(Some(&metadata()), &PlaybackState::STOPPED);
        assert_eq!(hidden.status, Status::Stopped);
        assert_eq!(hidden.info, None);
        assert_eq!(hidden.enabled, Enabled::default());
        for remote in Remote::ALL {
            assert!(!hidden.enabled.get(remote), "{remote:?}");
        }
    }

    #[test]
    fn playing_shows_the_real_rate_and_paused_shows_zero() {
        let playing = display(Some(&metadata()), &state(Status::Playing, 61_500));
        assert_eq!(playing.status, Status::Playing);
        let info = playing.info.unwrap();
        assert_eq!(info.title, "Al-Baqarah 2:255");
        assert_eq!(info.artist, "Mishari Rashid al-Afasy");
        assert_eq!(info.album, "The Holy Quran");
        assert_eq!(info.duration, Some(240.0));
        assert!((info.elapsed - 61.5).abs() < 1e-9);
        assert!((info.rate - 1.25).abs() < 1e-9);
        assert_eq!(info.artwork, metadata().artwork_path);
        for remote in Remote::ALL {
            assert!(playing.enabled.get(remote), "{remote:?}");
        }

        let paused = display(Some(&metadata()), &state(Status::Paused, 61_500));
        assert_eq!(paused.status, Status::Paused);
        assert!(paused.info.unwrap().rate.abs() < f64::EPSILON);

        let garbage_rate = PlaybackState {
            rate: f64::NAN,
            ..state(Status::Playing, 0)
        };
        assert!((display(None, &garbage_rate).info.unwrap().rate - 1.0).abs() < 1e-9);
    }

    #[test]
    fn capabilities_follow_the_state() {
        let edges = display(
            Some(&metadata()),
            &PlaybackState {
                can_next: false,
                can_previous: false,
                can_seek: false,
                ..state(Status::Playing, 0)
            },
        );
        assert!(edges.enabled.get(Remote::Play) && edges.enabled.get(Remote::Rate));
        assert!(!edges.enabled.get(Remote::Next));
        assert!(!edges.enabled.get(Remote::Previous));
        assert!(!edges.enabled.get(Remote::Position));
        // No known duration: no scrubbing, no duration entry, an unclamped position.
        let streaming = display(
            Some(&Metadata {
                duration: None,
                ..metadata()
            }),
            &state(Status::Playing, 5_000),
        );
        assert!(!streaming.enabled.get(Remote::Position));
        let info = streaming.info.unwrap();
        assert_eq!(info.duration, None);
        assert!((info.elapsed - 5.0).abs() < 1e-9);
        // A position past the end is clamped to the duration.
        let past = display(Some(&metadata()), &state(Status::Paused, 999_000));
        assert_eq!(past.info.unwrap().elapsed, 240.0);
    }

    #[test]
    fn remote_commands_map_to_media_commands() {
        assert_eq!(Remote::Play.fixed(), Some(MediaCommand::Play));
        assert_eq!(Remote::Pause.fixed(), Some(MediaCommand::Pause));
        assert_eq!(Remote::Toggle.fixed(), Some(MediaCommand::Toggle));
        assert_eq!(Remote::Stop.fixed(), Some(MediaCommand::Stop));
        assert_eq!(Remote::Next.fixed(), Some(MediaCommand::Next));
        assert_eq!(Remote::Previous.fixed(), Some(MediaCommand::Previous));
        assert_eq!(Remote::Position.fixed(), None);
        assert_eq!(Remote::Rate.fixed(), None);
        assert_eq!(
            seek_command(12.5),
            Some(MediaCommand::SeekTo(Duration::from_millis(12_500)))
        );
        for bad in [-1.0, f64::NAN, f64::INFINITY, f64::MAX] {
            assert_eq!(seek_command(bad), None, "{bad}");
        }
        assert_eq!(rate_request(1.5), Some(MediaCommand::SetRate(1.5)));
        for bad in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            assert_eq!(rate_request(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_newest_session_owns_now_playing() {
        // Nobody owns it: the first job of any session takes it.
        assert_eq!(claim(None, 1), Claim::Take);
        assert_eq!(claim(None, 7), Claim::Take);
        // The owner keeps it.
        assert_eq!(claim(Some(3), 3), Claim::Owned);
        // A newer session replaces an older one (e.g. a re-initialised session while the old one is torn down).
        assert_eq!(claim(Some(3), 4), Claim::Take);
        // An older session never takes it back from a newer one.
        assert_eq!(claim(Some(4), 3), Claim::Yield);
    }

    // ---- The handle (dispatch, coalescing, teardown) and the Objective-C side ----

    type Jobs = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;

    /// A dispatcher that queues jobs (the test thread is not the main thread, so nothing runs them).
    fn queueing_dispatch() -> (Jobs, MainThreadDispatch) {
        let jobs: Jobs = Arc::default();
        let queue = Arc::clone(&jobs);
        (jobs, Arc::new(move |job| queue.lock().unwrap().push(job)))
    }

    fn config() -> SessionConfig {
        SessionConfig {
            app_id: "com.quran.labs.desktop".into(),
            desktop_entry: "Quran".into(),
            display_name: "Quran".into(),
            dbus_name: "quran_desktop".into(),
            hwnd: None,
        }
    }

    #[test]
    fn a_burst_schedules_one_main_thread_job() {
        let (jobs, dispatch) = queueing_dispatch();
        let backend = MacBackend::start(&config(), Some(dispatch), Arc::new(|_| {})).unwrap();
        // The registration job.
        assert_eq!(jobs.lock().unwrap().len(), 1);
        backend.set_metadata(metadata());
        backend.set_state(state(Status::Playing, 1_000));
        backend.set_state(state(Status::Paused, 2_000));
        assert_eq!(jobs.lock().unwrap().len(), 2);
        {
            let pending = backend.shared.pending();
            assert!(pending.scheduled);
            assert_eq!(pending.state.status, Status::Paused);
            assert_eq!(
                pending.metadata.as_ref().map(|m| m.title.as_str()),
                Some("Al-Baqarah 2:255")
            );
        }
        // Off the main thread the queued jobs refuse to touch Now Playing (logged).
        for job in std::mem::take(&mut *jobs.lock().unwrap()) {
            job();
        }
        // A flush takes the latest inputs and re-arms scheduling.
        let (taken, taken_state) = take_pending(&backend.shared).unwrap();
        assert_eq!(taken.map(|m| m.title), Some("Al-Baqarah 2:255".to_owned()));
        assert_eq!(taken_state.position, Duration::from_millis(2_000));
        backend.set_state(state(Status::Playing, 3_000));
        assert_eq!(jobs.lock().unwrap().len(), 1);
        // Shutdown dispatches the teardown once (it times out waiting, as nothing runs the queue); later updates
        // are dropped.
        let shared = Arc::clone(&backend.shared);
        Box::new(backend).shutdown();
        assert!(shared.pending().closed);
        assert_eq!(jobs.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_missing_dispatcher_is_an_error() {
        assert!(matches!(
            MacBackend::start(&config(), None, Arc::new(|_| {})),
            Err(MediaSessionError::Platform(_))
        ));
    }

    #[test]
    fn dropping_without_shutdown_still_clears_once() {
        let (jobs, dispatch) = queueing_dispatch();
        let backend = MacBackend::start(&config(), Some(dispatch), Arc::new(|_| {})).unwrap();
        drop(backend);
        // Registration + teardown.
        assert_eq!(jobs.lock().unwrap().len(), 2);
    }

    /// The Objective-C side, applied directly on the test thread (the MediaPlayer classes are not main-thread-only;
    /// the backend marshals to the main thread for ordering with the app's event loop).
    #[test]
    fn now_playing_and_commands_follow_the_display() {
        let shared = Shared {
            session: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
            on_command: Arc::new(|_| {}),
            pending: Mutex::default(),
        };
        let mut center = Center::attach(shared.session, &shared.on_command);
        // SAFETY (test): singletons and getters.
        let (info_center, commands) = unsafe {
            (
                MPNowPlayingInfoCenter::defaultCenter(),
                MPRemoteCommandCenter::sharedCommandCenter(),
            )
        };
        let enabled = |remote| unsafe { remote_command(&commands, remote).isEnabled() };
        for remote in Remote::ALL {
            assert!(!enabled(remote), "{remote:?} starts disabled");
        }

        center.show(&display(Some(&metadata()), &state(Status::Playing, 61_500)));
        let info = unsafe { info_center.nowPlayingInfo() }.expect("nowPlayingInfo is set");
        let title = unsafe { info.objectForKey_unchecked(MPMediaItemPropertyTitle) }
            .and_then(|v| v.downcast_ref::<NSString>())
            .map(|s| s.to_string());
        assert_eq!(title.as_deref(), Some("Al-Baqarah 2:255"));
        let rate = unsafe { info.objectForKey_unchecked(MPNowPlayingInfoPropertyPlaybackRate) }
            .and_then(|v| v.downcast_ref::<NSNumber>())
            .map(|n| n.as_f64());
        assert_eq!(rate, Some(1.25));
        assert_eq!(
            unsafe { info_center.playbackState() },
            MPNowPlayingPlaybackState::Playing
        );
        for remote in Remote::ALL {
            assert!(enabled(remote), "{remote:?} enabled while playing");
        }

        center.show(&display(Some(&metadata()), &state(Status::Paused, 61_500)));
        assert_eq!(
            unsafe { info_center.playbackState() },
            MPNowPlayingPlaybackState::Paused
        );

        center.show(&display(Some(&metadata()), &PlaybackState::STOPPED));
        assert!(unsafe { info_center.nowPlayingInfo() }.is_none());
        assert_eq!(
            unsafe { info_center.playbackState() },
            MPNowPlayingPlaybackState::Stopped
        );
        for remote in Remote::ALL {
            assert!(!enabled(remote), "{remote:?} disabled when stopped");
        }

        center.show(&display(Some(&metadata()), &state(Status::Playing, 0)));
        center.detach();
        assert!(unsafe { info_center.nowPlayingInfo() }.is_none());
        assert_eq!(
            unsafe { info_center.playbackState() },
            MPNowPlayingPlaybackState::Stopped
        );
        for remote in Remote::ALL {
            assert!(!enabled(remote), "{remote:?} disabled after detach");
        }
    }
}
