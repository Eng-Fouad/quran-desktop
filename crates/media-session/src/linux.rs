//! Linux backend: an MPRIS 2 player, `org.mpris.MediaPlayer2.{dbus_name}` on the D-Bus session bus
//! (docs/ARCHITECTURE.md §2.4). Owner: WP6d.
//!
//! - A dedicated thread (`qd-media`) owns the mpris-server [`Server`] and drives one future with
//!   `futures_lite::future::block_on`. Updates arrive over an `async-channel` and are coalesced per burst (the latest
//!   metadata and the latest state). Each burst is published as **one** `PropertiesChanged` signal holding only what
//!   changed, plus `Seeked` when the position jumps within the same track.
//! - D-Bus calls (media keys through gnome-settings-daemon or KDE, the GNOME Shell and Plasma media widgets,
//!   `playerctl`) are served on zbus's executor thread by [`Mpris`]. It reads the published [`View`] under a mutex,
//!   applies the MPRIS rules (a disabled capability "has no effect", a stale track id is ignored, `Rate = 0` means
//!   pause) and forwards the request to the [`CommandHandler`].
//! - The player is visible only while a recitation is loaded. [`Status::Stopped`] publishes `PlaybackStatus =
//!   Stopped`, an empty `Metadata`, and turns off `CanPlay`, `CanPause`, `CanSeek`, `CanGoNext` and `CanGoPrevious`
//!   (GNOME Shell hides such a player; media keys then go to another player).
//! - `mpris:trackid` = `/com/quran/labs/desktop/track/{surah}_{ayah}`, taken from the reference at the end of the title
//!   (`"Al-Baqarah 2:255"`, `"البقرة ٢:٢٥٥"`). A title without one (the basmala shows the surah name alone) gets a
//!   per-track sequence id (`…/track/t{n}`). `mpris:length` is the surah-file duration and `Position` the
//!   surah-file position, extrapolated at `Rate` while playing. `MinimumRate` 0.5, `MaximumRate` 2.0.
//! - The bus name is `org.mpris.MediaPlayer2.{dbus_name}`. When another connection owns it (a second copy of the
//!   app, a stale process), the backend registers `org.mpris.MediaPlayer2.{dbus_name}.instance{pid}` (the MPRIS
//!   convention for further instances); when both are owned it fails and the session falls back to no-op.
//!
//! The mpris-server `Server` (with a `Send + Sync` implementation) is used rather than its `Player`/`LocalServer`:
//! that gives one batched `PropertiesChanged` per update, and no channel hop whose `unwrap`s could abort the process
//! if a D-Bus call races the shutdown (docs/deviations/WP6d.md).

use std::fmt::Write as _;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use mpris_server::zbus::{self, fdo};
use mpris_server::{
    LoopStatus, PlaybackRate, PlaybackStatus, PlayerInterface, Property, RootInterface, Server,
    Signal, Time, TrackId, Volume,
};

use crate::model::rate_command;
use crate::{
    Backend, CommandHandler, MediaCommand, MediaSessionError, Metadata, PlaybackState,
    SessionConfig, Status,
};

/// The backend thread's name (§1.1).
const THREAD_NAME: &str = "qd-media";
/// How long [`LinuxBackend::start`] waits for the player to be on the bus (a local session bus answers in
/// milliseconds; no bus at all fails at once).
const INIT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `shutdown` waits for the thread to hide the player, release the name and exit.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(1);
/// At most this many queued updates are coalesced per wake-up.
const MAX_BATCH: usize = 64;
/// `MinimumRate` (§2.4).
const MIN_RATE: PlaybackRate = 0.5;
/// `MaximumRate` (§2.4).
const MAX_RATE: PlaybackRate = 2.0;
/// The well-known bus-name prefix of every MPRIS player.
const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
/// Track ids live under this object path (MPRIS forbids `/org/mpris` for them).
const TRACK_PATH: &str = "/com/quran/labs/desktop/track";
/// A position this far from the extrapolated one is a seek, which clients hear about through `Seeked`.
const SEEK_TOLERANCE: Duration = Duration::from_millis(1_000);

/// A message to the backend thread.
enum Msg {
    Metadata(Metadata),
    State(PlaybackState),
    Shutdown,
}

/// Handle on the `qd-media` thread, which owns the MPRIS player.
pub(crate) struct LinuxBackend {
    tx: async_channel::Sender<Msg>,
    /// Disconnects when the thread has exited (its sender is dropped last).
    exited: Mutex<Receiver<()>>,
}

impl LinuxBackend {
    /// Spawns `qd-media`, which connects to the session bus and registers the player, and waits up to
    /// [`INIT_TIMEOUT`] for the result. Fails without a session bus (headless sessions, CI).
    pub(crate) fn start(
        cfg: &SessionConfig,
        on_command: CommandHandler,
    ) -> Result<Self, MediaSessionError> {
        let identity = Identity {
            name: cfg.display_name.clone(),
            desktop_entry: cfg.desktop_entry.clone(),
            dbus_name: cfg.dbus_name.clone(),
        };
        let (tx, rx) = async_channel::unbounded();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name(THREAD_NAME.to_owned())
            .spawn(move || {
                let _exit = exit_tx;
                futures_lite::future::block_on(run(identity, on_command, rx, ready_tx));
            })
            .map_err(|e| MediaSessionError::platform("spawn qd-media", e))?;
        match ready_rx.recv_timeout(INIT_TIMEOUT) {
            Ok(Ok(bus_name)) => {
                log::info!("media session: MPRIS player `{bus_name}`");
                Ok(Self {
                    tx,
                    exited: Mutex::new(exit_rx),
                })
            }
            Ok(Err(e)) => Err(e),
            // Dropping `tx` makes the thread release the name and exit as soon as it gets past registration.
            Err(RecvTimeoutError::Timeout) => Err(MediaSessionError::Platform(format!(
                "the D-Bus session bus did not answer within {} s",
                INIT_TIMEOUT.as_secs()
            ))),
            Err(RecvTimeoutError::Disconnected) => Err(MediaSessionError::Platform(
                "the media thread exited while starting".to_owned(),
            )),
        }
    }

    fn send(&self, msg: Msg) {
        if self.tx.try_send(msg).is_err() {
            log::debug!("media session: the media thread has exited; update dropped");
        }
    }
}

impl Backend for LinuxBackend {
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

/// Who the player says it is.
#[derive(Debug, Clone)]
struct Identity {
    /// `Identity` ("Quran", the bundle's `productName`).
    name: String,
    /// `DesktopEntry`: the installed .desktop file's basename (GNOME and KDE take the name and icon from it).
    desktop_entry: String,
    /// The bus-name suffix after `org.mpris.MediaPlayer2.`.
    dbus_name: String,
}

/// The `qd-media` thread: register the player, then publish updates until `Shutdown` or until every sender is gone;
/// finally hide the player and release the bus name.
async fn run(
    identity: Identity,
    on_command: CommandHandler,
    rx: async_channel::Receiver<Msg>,
    ready: SyncSender<Result<String, MediaSessionError>>,
) {
    let server = match serve(&identity, &on_command).await {
        Ok(server) => server,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut reporter = Reporter::default();
    if ready.send(Ok(server.bus_name().to_string())).is_ok() {
        let mut publisher = Publisher::new(Instant::now());
        while let Ok(first) = rx.recv().await {
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
            let update = publisher.apply(batch.metadata, batch.state, Instant::now());
            publish(&server, update, &mut reporter).await;
        }
        publish(&server, publisher.hide(Instant::now()), &mut reporter).await;
    }
    if let Err(e) = server.release_bus_name().await {
        log::debug!("media session: release the MPRIS bus name: {e}");
    }
}

/// Registers the player as `org.mpris.MediaPlayer2.{dbus_name}`, or `….{dbus_name}.instance{pid}` when another
/// connection owns that name; fails when both are owned.
///
/// Ownership is checked first because zbus 5.19's connection builder requests names without `DoNotQueue` (contrary
/// to its documentation): a taken name would silently queue the player instead of failing with `NameTaken`.
async fn serve(
    identity: &Identity,
    on_command: &CommandHandler,
) -> Result<Server<Mpris>, MediaSessionError> {
    let bus = zbus::Connection::session()
        .await
        .map_err(|e| MediaSessionError::platform("connect to the D-Bus session bus", e))?;
    let dbus = fdo::DBusProxy::new(&bus)
        .await
        .map_err(|e| MediaSessionError::platform("org.freedesktop.DBus", e))?;
    let primary = identity.dbus_name.clone();
    let instance = format!("{primary}.instance{}", std::process::id());
    for suffix in [primary.as_str(), instance.as_str()] {
        let name = format!("{MPRIS_PREFIX}{suffix}");
        let owned = match zbus::names::BusName::try_from(name.as_str()) {
            Ok(bus_name) => dbus
                .name_has_owner(bus_name)
                .await
                .map_err(|e| MediaSessionError::platform("NameHasOwner", e))?,
            Err(e) => return Err(MediaSessionError::platform("MPRIS bus name", e)),
        };
        if owned {
            log::info!("media session: {name} is taken");
            continue;
        }
        match Server::new(suffix, Mpris::new(identity, on_command.clone())).await {
            Ok(server) => return Ok(server),
            // Taken between the check and the request (or a zbus that honours `DoNotQueue`).
            Err(zbus::Error::NameTaken) => log::info!("media session: {name} is taken"),
            Err(e) => {
                return Err(MediaSessionError::platform(
                    "MPRIS on the D-Bus session bus",
                    e,
                ));
            }
        }
    }
    Err(MediaSessionError::Platform(format!(
        "{MPRIS_PREFIX}{primary} and its instance name are taken"
    )))
}

/// Makes `update` visible: the getters see the new view first, then one `PropertiesChanged` announces what changed,
/// then `Seeked` (if any).
async fn publish(server: &Server<Mpris>, update: Update, reporter: &mut Reporter) {
    *server.imp().view() = update.view;
    if !update.changed.is_empty() {
        let result = server.properties_changed(update.changed).await;
        reporter.report("PropertiesChanged", result);
    }
    if let Some(position) = update.seeked {
        let result = server
            .emit(Signal::Seeked {
                position: time(position),
            })
            .await;
        reporter.report("Seeked", result);
    }
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

/// Logs a failed signal at warn level once per distinct error, repeats at debug level.
#[derive(Default)]
struct Reporter {
    last_error: Option<String>,
}

impl Reporter {
    fn report(&mut self, what: &str, result: zbus::Result<()>) {
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

/// Everything the player publishes that can change, plus the position anchor (what `Position` is computed from).
#[derive(Debug, Clone, PartialEq)]
struct View {
    status: PlaybackStatus,
    metadata: mpris_server::Metadata,
    /// `mpris:trackid` of the current track (`NoTrack` while stopped).
    track: TrackId,
    /// `mpris:length` (the surah-file duration), when known.
    length: Option<Duration>,
    rate: PlaybackRate,
    can_go_next: bool,
    can_go_previous: bool,
    can_play: bool,
    can_pause: bool,
    can_seek: bool,
    /// The position at `at`; it advances at `rate` while playing.
    position: Duration,
    at: Instant,
}

impl View {
    /// Nothing loaded: stopped, no metadata, no capabilities.
    fn hidden(rate: PlaybackRate, at: Instant) -> Self {
        Self {
            status: PlaybackStatus::Stopped,
            metadata: mpris_server::Metadata::new(),
            track: TrackId::NO_TRACK,
            length: None,
            rate,
            can_go_next: false,
            can_go_previous: false,
            can_play: false,
            can_pause: false,
            can_seek: false,
            position: Duration::ZERO,
            at,
        }
    }

    /// `Position` at `now`: frozen while paused, advancing at `rate` while playing (clamped to the length), zero while
    /// stopped.
    fn position_at(&self, now: Instant) -> Duration {
        match self.status {
            PlaybackStatus::Stopped => Duration::ZERO,
            PlaybackStatus::Paused => self.position,
            PlaybackStatus::Playing => {
                let elapsed = now.saturating_duration_since(self.at).as_secs_f64() * self.rate;
                let position = Duration::try_from_secs_f64(elapsed)
                    .ok()
                    .and_then(|d| self.position.checked_add(d))
                    .unwrap_or(Duration::MAX);
                self.length.map_or(position, |length| position.min(length))
            }
        }
    }
}

/// What one burst of updates changes on the bus.
#[derive(Debug)]
struct Update {
    view: View,
    changed: Vec<Property>,
    /// `Seeked(position)`: the position jumped within the same track.
    seeked: Option<Duration>,
}

/// The backend's latest inputs and the view they publish (pure; unit-tested).
struct Publisher {
    metadata: Option<Metadata>,
    state: PlaybackState,
    track: TrackId,
    /// Sequence for the ids of tracks whose title names no ayah.
    tracks: u64,
    view: View,
}

impl Publisher {
    fn new(now: Instant) -> Self {
        let state = PlaybackState::STOPPED;
        Self {
            metadata: None,
            state,
            track: TrackId::NO_TRACK,
            tracks: 0,
            view: View::hidden(published_rate(&state), now),
        }
    }

    /// Applies a burst. A new title starts a new track; a state re-anchors the position (a metadata-only burst, e.g.
    /// a language change, keeps the running position).
    fn apply(
        &mut self,
        metadata: Option<Metadata>,
        state: Option<PlaybackState>,
        now: Instant,
    ) -> Update {
        if let Some(m) = metadata {
            if self
                .metadata
                .as_ref()
                .is_none_or(|prev| prev.title != m.title)
            {
                self.track = self.track_id(&m.title);
            }
            self.metadata = Some(m);
        }
        let anchor = match state {
            Some(s) => {
                self.state = s;
                (s.position, now)
            }
            None => (self.view.position, self.view.at),
        };
        let view = view(self.metadata.as_ref(), &self.track, &self.state, anchor);
        let seeked = state.and_then(|_| seeked(&self.view, &view, now));
        let changed = changes(&self.view, &view);
        self.view = view.clone();
        Update {
            view,
            changed,
            seeked,
        }
    }

    /// Hides the player (shutdown).
    fn hide(&mut self, now: Instant) -> Update {
        let stopped = PlaybackState {
            status: Status::Stopped,
            ..self.state
        };
        self.apply(None, Some(stopped), now)
    }

    /// `/com/quran/labs/desktop/track/{surah}_{ayah}` from the title's reference, else `/com/quran/labs/desktop/track/t{n}`.
    fn track_id(&mut self, title: &str) -> TrackId {
        let path = match ayah_reference(title) {
            Some((surah, ayah)) => format!("{TRACK_PATH}/{surah}_{ayah}"),
            None => {
                self.tracks += 1;
                format!("{TRACK_PATH}/t{}", self.tracks)
            }
        };
        TrackId::try_from(path).unwrap_or(TrackId::NO_TRACK)
    }
}

/// The view of the latest metadata and state, with the position anchored at `(position, at)`.
fn view(
    metadata: Option<&Metadata>,
    track: &TrackId,
    state: &PlaybackState,
    (position, at): (Duration, Instant),
) -> View {
    let rate = published_rate(state);
    if !state.is_active() {
        return View::hidden(rate, at);
    }
    let length = metadata.and_then(|m| m.duration).filter(|d| !d.is_zero());
    View {
        status: match state.status {
            Status::Playing => PlaybackStatus::Playing,
            Status::Paused => PlaybackStatus::Paused,
            Status::Stopped => PlaybackStatus::Stopped,
        },
        metadata: track_metadata(metadata, track, length),
        track: track.clone(),
        length,
        rate,
        can_go_next: state.can_next,
        can_go_previous: state.can_previous,
        can_play: true,
        can_pause: true,
        can_seek: state.can_seek && length.is_some(),
        position: length.map_or(position, |l| position.min(l)),
        at,
    }
}

/// The real speed, within `MinimumRate..=MaximumRate` (MPRIS forbids anything else, and 0).
fn published_rate(state: &PlaybackState) -> PlaybackRate {
    state.effective_rate().clamp(MIN_RATE, MAX_RATE)
}

/// `Metadata_Map` of the current track: trackid, title, artist, album, length and the artwork as a `file://` URL.
fn track_metadata(
    metadata: Option<&Metadata>,
    track: &TrackId,
    length: Option<Duration>,
) -> mpris_server::Metadata {
    let mut out = mpris_server::Metadata::new();
    out.set_trackid(Some(track.clone()));
    if let Some(m) = metadata {
        if !m.title.is_empty() {
            out.set_title(Some(m.title.as_str()));
        }
        if !m.artist.is_empty() {
            out.set_artist(Some([m.artist.as_str()]));
        }
        if !m.album.is_empty() {
            out.set_album(Some(m.album.as_str()));
        }
        if let Some(url) = m.artwork_path.as_deref().and_then(file_url) {
            out.set_art_url(Some(url));
        }
    }
    if let Some(length) = length {
        out.set_length(Some(time(length)));
    }
    out
}

/// The properties whose values differ between `prev` and `next` (`Position` never: clients extrapolate it).
fn changes(prev: &View, next: &View) -> Vec<Property> {
    let mut changed = Vec::new();
    if prev.status != next.status {
        changed.push(Property::PlaybackStatus(next.status));
    }
    if prev.metadata != next.metadata {
        changed.push(Property::Metadata(next.metadata.clone()));
    }
    if prev.rate.to_bits() != next.rate.to_bits() {
        changed.push(Property::Rate(next.rate));
    }
    let flags = [
        (
            prev.can_go_next,
            next.can_go_next,
            Property::CanGoNext as fn(bool) -> Property,
        ),
        (
            prev.can_go_previous,
            next.can_go_previous,
            Property::CanGoPrevious,
        ),
        (prev.can_play, next.can_play, Property::CanPlay),
        (prev.can_pause, next.can_pause, Property::CanPause),
        (prev.can_seek, next.can_seek, Property::CanSeek),
    ];
    changed.extend(
        flags
            .into_iter()
            .filter(|(old, new, _)| old != new)
            .map(|(_, new, property)| property(new)),
    );
    changed
}

/// `Some(position)` when `next` jumped more than [`SEEK_TOLERANCE`] from where `prev` extrapolates to at `now`,
/// within the same track. Starting playback and changing tracks need no `Seeked` (MPRIS).
fn seeked(prev: &View, next: &View, now: Instant) -> Option<Duration> {
    if prev.status == PlaybackStatus::Stopped
        || next.status == PlaybackStatus::Stopped
        || prev.track != next.track
    {
        return None;
    }
    (prev.position_at(now).abs_diff(next.position) > SEEK_TOLERANCE).then_some(next.position)
}

/// A request from a D-Bus client.
#[derive(Debug, Clone, PartialEq)]
enum Call {
    Next,
    Previous,
    Pause,
    PlayPause,
    Stop,
    Play,
    Seek(Time),
    SetPosition(TrackId, Time),
    SetRate(PlaybackRate),
    Raise,
}

/// The command a client request maps to under the published view, or `None` when MPRIS says the request has no
/// effect: a disabled capability, a stale track id, a position outside the track, `Stop` while stopped.
fn command(view: &View, call: Call) -> Option<MediaCommand> {
    let active = view.status != PlaybackStatus::Stopped;
    match call {
        Call::Next => view.can_go_next.then_some(MediaCommand::Next),
        Call::Previous => view.can_go_previous.then_some(MediaCommand::Previous),
        Call::Pause => view.can_pause.then_some(MediaCommand::Pause),
        Call::PlayPause => view.can_pause.then_some(MediaCommand::Toggle),
        Call::Play => view.can_play.then_some(MediaCommand::Play),
        Call::Stop => active.then_some(MediaCommand::Stop),
        Call::Seek(offset) => view
            .can_seek
            .then(|| MediaCommand::SeekBy(offset.as_micros())),
        Call::SetPosition(track, position) => {
            let micros = u64::try_from(position.as_micros()).ok()?;
            let target = Duration::from_micros(micros);
            let in_track = view.length.is_none_or(|length| target <= length);
            (view.can_seek && track == view.track && in_track)
                .then_some(MediaCommand::SeekTo(target))
        }
        // "A value of 0.0 should not be set by the client. If it is, the media player should act as though Pause
        // was called."
        Call::SetRate(0.0) => view.can_pause.then_some(MediaCommand::Pause),
        Call::SetRate(rate) => active.then(|| rate_command(rate)).flatten(),
        Call::Raise => Some(MediaCommand::Raise),
    }
}

/// The MPRIS object (`org.mpris.MediaPlayer2` and `org.mpris.MediaPlayer2.Player`), served on zbus's executor
/// thread. It never blocks: getters copy from the view, requests call the [`CommandHandler`].
struct Mpris {
    identity: String,
    desktop_entry: String,
    on_command: CommandHandler,
    view: Mutex<View>,
}

impl Mpris {
    fn new(identity: &Identity, on_command: CommandHandler) -> Self {
        Self {
            identity: identity.name.clone(),
            desktop_entry: identity.desktop_entry.clone(),
            on_command,
            view: Mutex::new(View::hidden(1.0, Instant::now())),
        }
    }

    fn view(&self) -> MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Maps `call` under the current view and forwards the command (the lock is released first). `false` when the
    /// request has no effect.
    fn request(&self, call: Call) -> bool {
        let cmd = command(&self.view(), call);
        match cmd {
            Some(cmd) => {
                (self.on_command)(cmd);
                true
            }
            None => false,
        }
    }
}

/// Rejection for writable properties the player does not support (shuffle, loop, volume).
fn unsupported(what: &str) -> zbus::Error {
    zbus::Error::FDO(Box::new(fdo::Error::NotSupported(format!(
        "{what} is not supported"
    ))))
}

impl RootInterface for Mpris {
    async fn raise(&self) -> fdo::Result<()> {
        self.request(Call::Raise);
        Ok(())
    }

    /// `CanQuit` is false: the app quits from its window or tray, never from a media widget.
    async fn quit(&self) -> fdo::Result<()> {
        Ok(())
    }

    async fn can_quit(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn fullscreen(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    /// `CanSetFullscreen` is false: no effect.
    async fn set_fullscreen(&self, _fullscreen: bool) -> zbus::Result<()> {
        Ok(())
    }

    async fn can_set_fullscreen(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn can_raise(&self) -> fdo::Result<bool> {
        Ok(true)
    }

    async fn has_track_list(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn identity(&self) -> fdo::Result<String> {
        Ok(self.identity.clone())
    }

    async fn desktop_entry(&self) -> fdo::Result<String> {
        Ok(self.desktop_entry.clone())
    }

    async fn supported_uri_schemes(&self) -> fdo::Result<Vec<String>> {
        Ok(Vec::new())
    }

    async fn supported_mime_types(&self) -> fdo::Result<Vec<String>> {
        Ok(Vec::new())
    }
}

impl PlayerInterface for Mpris {
    async fn next(&self) -> fdo::Result<()> {
        self.request(Call::Next);
        Ok(())
    }

    async fn previous(&self) -> fdo::Result<()> {
        self.request(Call::Previous);
        Ok(())
    }

    async fn pause(&self) -> fdo::Result<()> {
        self.request(Call::Pause);
        Ok(())
    }

    /// "If CanPause is false, attempting to call this method should have no effect and raise an error."
    async fn play_pause(&self) -> fdo::Result<()> {
        if self.request(Call::PlayPause) {
            Ok(())
        } else {
            Err(fdo::Error::NotSupported(
                "nothing is loaded to play or pause".to_owned(),
            ))
        }
    }

    async fn stop(&self) -> fdo::Result<()> {
        self.request(Call::Stop);
        Ok(())
    }

    async fn play(&self) -> fdo::Result<()> {
        self.request(Call::Play);
        Ok(())
    }

    async fn seek(&self, offset: Time) -> fdo::Result<()> {
        self.request(Call::Seek(offset));
        Ok(())
    }

    async fn set_position(&self, track_id: TrackId, position: Time) -> fdo::Result<()> {
        self.request(Call::SetPosition(track_id, position));
        Ok(())
    }

    async fn open_uri(&self, _uri: String) -> fdo::Result<()> {
        Err(fdo::Error::NotSupported(
            "This player does not open URIs".to_owned(),
        ))
    }

    async fn playback_status(&self) -> fdo::Result<PlaybackStatus> {
        Ok(self.view().status)
    }

    async fn loop_status(&self) -> fdo::Result<LoopStatus> {
        Ok(LoopStatus::None)
    }

    async fn set_loop_status(&self, _loop_status: LoopStatus) -> zbus::Result<()> {
        Err(unsupported("LoopStatus"))
    }

    async fn rate(&self) -> fdo::Result<PlaybackRate> {
        Ok(self.view().rate)
    }

    async fn set_rate(&self, rate: PlaybackRate) -> zbus::Result<()> {
        self.request(Call::SetRate(rate));
        Ok(())
    }

    async fn shuffle(&self) -> fdo::Result<bool> {
        Ok(false)
    }

    async fn set_shuffle(&self, _shuffle: bool) -> zbus::Result<()> {
        Err(unsupported("Shuffle"))
    }

    async fn metadata(&self) -> fdo::Result<mpris_server::Metadata> {
        Ok(self.view().metadata.clone())
    }

    async fn volume(&self) -> fdo::Result<Volume> {
        Ok(1.0)
    }

    async fn set_volume(&self, _volume: Volume) -> zbus::Result<()> {
        Err(unsupported("Volume"))
    }

    async fn position(&self) -> fdo::Result<Time> {
        Ok(time(self.view().position_at(Instant::now())))
    }

    async fn minimum_rate(&self) -> fdo::Result<PlaybackRate> {
        Ok(MIN_RATE)
    }

    async fn maximum_rate(&self) -> fdo::Result<PlaybackRate> {
        Ok(MAX_RATE)
    }

    async fn can_go_next(&self) -> fdo::Result<bool> {
        Ok(self.view().can_go_next)
    }

    async fn can_go_previous(&self) -> fdo::Result<bool> {
        Ok(self.view().can_go_previous)
    }

    async fn can_play(&self) -> fdo::Result<bool> {
        Ok(self.view().can_play)
    }

    async fn can_pause(&self) -> fdo::Result<bool> {
        Ok(self.view().can_pause)
    }

    async fn can_seek(&self) -> fdo::Result<bool> {
        Ok(self.view().can_seek)
    }

    async fn can_control(&self) -> fdo::Result<bool> {
        Ok(true)
    }
}

/// `Duration` → MPRIS `Time` (microseconds), saturating.
fn time(d: Duration) -> Time {
    Time::from_micros(i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

/// `(surah, ayah)` from the reference that ends a title (`"Al-Baqarah 2:255"`, `"البقرة ٢:٢٥٥"`, `"2:255"`), in
/// ASCII or Arabic-Indic digits; `None` for a title without one (the basmala) or an impossible reference.
fn ayah_reference(title: &str) -> Option<(u32, u32)> {
    let last = title.split_whitespace().next_back()?;
    let reference = last.trim_matches(|c| {
        matches!(
            c,
            '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{2066}'..='\u{2069}'
        )
    });
    let (surah, ayah) = reference.split_once(':')?;
    let (surah, ayah) = (number(surah)?, number(ayah)?);
    ((1..=114).contains(&surah) && ayah <= 286).then_some((surah, ayah))
}

/// A short decimal number in ASCII, Arabic-Indic (U+0660..) or Extended Arabic-Indic (U+06F0..) digits.
fn number(text: &str) -> Option<u32> {
    if text.is_empty() || text.chars().count() > 3 {
        return None;
    }
    text.chars().try_fold(0_u32, |n, c| {
        let digit = match c {
            '0'..='9' => c.to_digit(10),
            '\u{0660}'..='\u{0669}' => Some(u32::from(c) - 0x0660),
            '\u{06F0}'..='\u{06F9}' => Some(u32::from(c) - 0x06F0),
            _ => None,
        }?;
        n.checked_mul(10)?.checked_add(digit)
    })
}

/// `file://` URL of an absolute path, percent-encoding every byte outside the unreserved set (RFC 8089 / RFC 3986).
fn file_url(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let mut url = String::from("file://");
    for &byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'.' | b'_' | b'~') {
            url.push(char::from(byte));
        } else {
            let _ = write!(url, "%{byte:02X}");
        }
    }
    Some(url)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use mpris_server::zbus::blocking;
    use mpris_server::zbus::zvariant::{ObjectPath, OwnedValue};

    use super::*;

    fn metadata(title: &str) -> Metadata {
        Metadata {
            title: title.to_owned(),
            artist: "Mishari Rashid al-Afasy".to_owned(),
            album: "The Holy Quran".to_owned(),
            duration: Some(Duration::from_secs(240)),
            artwork_path: Some(PathBuf::from(
                "/home/user/.local/share/com.quran.labs.desktop/media-artwork.png",
            )),
        }
    }

    fn state(status: Status, position_ms: u64) -> PlaybackState {
        PlaybackState {
            status,
            position: Duration::from_millis(position_ms),
            rate: 1.0,
            can_next: true,
            can_previous: true,
            can_seek: true,
        }
    }

    fn track(path: &str) -> TrackId {
        TrackId::try_from(path).unwrap()
    }

    #[test]
    fn ayah_references_are_read_from_titles() {
        assert_eq!(ayah_reference("Al-Baqarah 2:255"), Some((2, 255)));
        assert_eq!(ayah_reference("البقرة ٢:٢٥٥"), Some((2, 255)));
        assert_eq!(ayah_reference("الفاتحة ١:٧"), Some((1, 7)));
        assert_eq!(ayah_reference("114:6"), Some((114, 6)));
        assert_eq!(ayah_reference("سورة ۱۸:۱۰"), Some((18, 10)));
        assert_eq!(ayah_reference("Al-Kahf 18:0"), Some((18, 0)));
        assert_eq!(ayah_reference("Ali 'Imran 3:200\u{200F}"), Some((3, 200)));
        // The basmala title is the surah name alone; garbage never panics.
        for none in [
            "",
            " ",
            "Al-Kahf",
            "الكهف",
            "2:",
            ":5",
            "2:255:1",
            "115:1",
            "0:1",
            "2:287",
            "a:b",
            "9999999999:1",
            "2-255",
        ] {
            assert_eq!(ayah_reference(none), None, "{none:?}");
        }
    }

    #[test]
    fn track_ids_name_the_ayah_or_count_tracks() {
        let t0 = Instant::now();
        let mut publisher = Publisher::new(t0);
        let first = publisher.apply(
            Some(metadata("Al-Baqarah 2:255")),
            Some(state(Status::Playing, 0)),
            t0,
        );
        assert_eq!(
            first.view.track,
            track("/com/quran/labs/desktop/track/2_255")
        );
        // A language change re-sends the same ayah: same track.
        let arabic = publisher.apply(Some(metadata("البقرة ٢:٢٥٥")), None, t0);
        assert_eq!(
            arabic.view.track,
            track("/com/quran/labs/desktop/track/2_255")
        );
        // The basmala names no ayah: a sequence id, a new one per distinct title.
        let basmala = publisher.apply(Some(metadata("Al-Kahf")), None, t0);
        assert_eq!(
            basmala.view.track,
            track("/com/quran/labs/desktop/track/t1")
        );
        let same = publisher.apply(Some(metadata("Al-Kahf")), None, t0);
        assert_eq!(same.view.track, track("/com/quran/labs/desktop/track/t1"));
        let arabic_basmala = publisher.apply(Some(metadata("الكهف")), None, t0);
        assert_eq!(
            arabic_basmala.view.track,
            track("/com/quran/labs/desktop/track/t2")
        );
    }

    #[test]
    fn nothing_loaded_hides_the_player() {
        let t0 = Instant::now();
        let mut publisher = Publisher::new(t0);
        // The initial view is what the getters serve before the first update.
        assert_eq!(publisher.view, View::hidden(1.0, t0));
        // A stopped state before anything played changes nothing.
        let idle = publisher.apply(None, Some(PlaybackState::STOPPED), t0);
        assert!(idle.changed.is_empty() && idle.seeked.is_none());

        publisher.apply(
            Some(metadata("Al-Baqarah 2:255")),
            Some(state(Status::Paused, 5_000)),
            t0,
        );
        let stop = publisher.apply(None, Some(PlaybackState::STOPPED), t0);
        let v = &stop.view;
        assert_eq!(v.status, PlaybackStatus::Stopped);
        assert_eq!(v.metadata, mpris_server::Metadata::new());
        assert_eq!(v.track, TrackId::NO_TRACK);
        assert!(!(v.can_play || v.can_pause || v.can_seek || v.can_go_next || v.can_go_previous));
        assert_eq!(v.position_at(t0 + Duration::from_secs(9)), Duration::ZERO);
        assert!(
            stop.changed
                .contains(&Property::PlaybackStatus(PlaybackStatus::Stopped))
        );
        assert!(stop.changed.contains(&Property::CanPlay(false)));
        assert!(stop.seeked.is_none());
    }

    #[test]
    fn an_active_state_publishes_the_track_and_capabilities() {
        let t0 = Instant::now();
        let mut publisher = Publisher::new(t0);
        let update = publisher.apply(
            Some(metadata("Al-Baqarah 2:255")),
            Some(PlaybackState {
                rate: 1.25,
                can_next: false,
                ..state(Status::Playing, 61_500)
            }),
            t0,
        );
        let v = &update.view;
        assert_eq!(v.status, PlaybackStatus::Playing);
        assert!((v.rate - 1.25).abs() < 1e-9);
        assert!(v.can_play && v.can_pause && v.can_seek && v.can_go_previous && !v.can_go_next);
        assert_eq!(v.length, Some(Duration::from_secs(240)));
        let m = &v.metadata;
        assert_eq!(
            m.trackid(),
            Some(track("/com/quran/labs/desktop/track/2_255"))
        );
        assert_eq!(m.title(), Some("Al-Baqarah 2:255"));
        assert_eq!(m.artist(), Some(vec!["Mishari Rashid al-Afasy".to_owned()]));
        assert_eq!(m.album(), Some("The Holy Quran"));
        assert_eq!(m.length(), Some(Time::from_secs(240)));
        assert_eq!(
            m.art_url().as_deref(),
            Some("file:///home/user/.local/share/com.quran.labs.desktop/media-artwork.png")
        );
        // Everything changed from the hidden view (the rate too), in one signal.
        assert_eq!(update.changed.len(), 7, "{:?}", update.changed);
        assert!(update.seeked.is_none());

        // Rates outside 0.5..=2.0 (and garbage) are clamped; an unknown duration means no seeking.
        let fast = view(
            Some(&Metadata {
                duration: None,
                ..metadata("2:255")
            }),
            &track("/com/quran/labs/desktop/track/2_255"),
            &PlaybackState {
                rate: 3.0,
                ..state(Status::Paused, 0)
            },
            (Duration::ZERO, t0),
        );
        assert!((fast.rate - MAX_RATE).abs() < 1e-9);
        assert!(!fast.can_seek && fast.length.is_none() && fast.metadata.length().is_none());
        let nan = PlaybackState {
            rate: f64::NAN,
            ..state(Status::Playing, 0)
        };
        assert!((published_rate(&nan) - 1.0).abs() < 1e-9);
        let slow = PlaybackState {
            rate: 0.25,
            ..state(Status::Playing, 0)
        };
        assert!((published_rate(&slow) - MIN_RATE).abs() < 1e-9);
    }

    #[test]
    fn only_changed_properties_are_signalled() {
        let t0 = Instant::now();
        let mut publisher = Publisher::new(t0);
        publisher.apply(
            Some(metadata("Al-Baqarah 2:255")),
            Some(state(Status::Playing, 0)),
            t0,
        );
        // The same state again, where the clients already extrapolate it: nothing.
        let t1 = t0 + Duration::from_secs(2);
        let steady = publisher.apply(None, Some(state(Status::Playing, 2_000)), t1);
        assert!(
            steady.changed.is_empty() && steady.seeked.is_none(),
            "{steady:?}"
        );
        // Pause: the status alone.
        let pause = publisher.apply(None, Some(state(Status::Paused, 2_000)), t1);
        assert_eq!(
            pause.changed,
            vec![Property::PlaybackStatus(PlaybackStatus::Paused)]
        );
        // A speed change: the rate alone.
        let faster = publisher.apply(
            None,
            Some(PlaybackState {
                rate: 1.5,
                ..state(Status::Paused, 2_000)
            }),
            t1,
        );
        assert_eq!(faster.changed, vec![Property::Rate(1.5)]);
        // The last ayah of the range: CanGoNext alone.
        let last = publisher.apply(
            None,
            Some(PlaybackState {
                rate: 1.5,
                can_next: false,
                ..state(Status::Paused, 2_000)
            }),
            t1,
        );
        assert_eq!(last.changed, vec![Property::CanGoNext(false)]);
        // The next ayah: metadata alone (its position continues).
        let next = publisher.apply(Some(metadata("Al-Baqarah 2:256")), None, t1);
        assert_eq!(next.changed.len(), 1);
        assert!(
            matches!(&next.changed[0], Property::Metadata(m) if m.title() == Some("Al-Baqarah 2:256"))
        );
    }

    #[test]
    fn jumps_within_a_track_are_seeks() {
        let t0 = Instant::now();
        let mut publisher = Publisher::new(t0);
        // Starting playback is no seek, even mid-file.
        let start = publisher.apply(
            Some(metadata("Al-Baqarah 2:255")),
            Some(state(Status::Playing, 30_000)),
            t0,
        );
        assert!(start.seeked.is_none());
        // 5 s later at 1x the clients show 35 s: 35.4 s is no seek, 50 s is.
        let t1 = t0 + Duration::from_secs(5);
        assert!(
            publisher
                .apply(None, Some(state(Status::Playing, 35_400)), t1)
                .seeked
                .is_none()
        );
        let jump = publisher.apply(None, Some(state(Status::Playing, 50_000)), t1);
        assert_eq!(jump.seeked, Some(Duration::from_secs(50)));
        assert!(jump.changed.is_empty());
        // Backwards too, and while paused.
        publisher.apply(None, Some(state(Status::Paused, 50_000)), t1);
        let back = publisher.apply(
            None,
            Some(state(Status::Paused, 10_000)),
            t1 + Duration::from_secs(60),
        );
        assert_eq!(back.seeked, Some(Duration::from_secs(10)));
        // A new track at a new position is no seek.
        let other = publisher.apply(
            Some(metadata("Al-Imran 3:1")),
            Some(state(Status::Paused, 0)),
            t1,
        );
        assert!(other.seeked.is_none());
        // A metadata-only burst never seeks and keeps the running position.
        let relabel = publisher.apply(
            Some(metadata("آل عمران ٣:١")),
            None,
            t1 + Duration::from_secs(30),
        );
        assert!(relabel.seeked.is_none());
        assert_eq!(relabel.view.position, Duration::ZERO);
        assert_eq!(relabel.view.at, t1);
    }

    #[test]
    fn positions_are_extrapolated_at_the_rate_and_clamped() {
        let t0 = Instant::now();
        let v = view(
            Some(&metadata("Al-Baqarah 2:255")),
            &track("/com/quran/labs/desktop/track/2_255"),
            &PlaybackState {
                rate: 2.0,
                ..state(Status::Playing, 10_000)
            },
            (Duration::from_secs(10), t0),
        );
        assert_eq!(v.position_at(t0), Duration::from_secs(10));
        assert_eq!(
            v.position_at(t0 + Duration::from_secs(5)),
            Duration::from_secs(20)
        );
        // Never past the end of the file, never before the anchor.
        assert_eq!(
            v.position_at(t0 + Duration::from_secs(3_600)),
            Duration::from_secs(240)
        );
        assert_eq!(
            v.position_at(t0.checked_sub(Duration::from_secs(1)).unwrap_or(t0)),
            Duration::from_secs(10)
        );
        // A position past the end is clamped when published.
        let past = view(
            Some(&metadata("Al-Baqarah 2:255")),
            &track("/com/quran/labs/desktop/track/2_255"),
            &state(Status::Paused, 0),
            (Duration::from_secs(900), t0),
        );
        assert_eq!(past.position, Duration::from_secs(240));
        assert_eq!(time(Duration::MAX), Time::MAX);
        assert_eq!(
            time(Duration::from_millis(1_500)),
            Time::from_micros(1_500_000)
        );
    }

    #[test]
    fn requests_follow_the_published_capabilities() {
        let t0 = Instant::now();
        let id = track("/com/quran/labs/desktop/track/2_255");
        let playing = view(
            Some(&metadata("Al-Baqarah 2:255")),
            &id,
            &state(Status::Playing, 0),
            (Duration::ZERO, t0),
        );
        let cases = [
            (Call::Next, Some(MediaCommand::Next)),
            (Call::Previous, Some(MediaCommand::Previous)),
            (Call::Pause, Some(MediaCommand::Pause)),
            (Call::PlayPause, Some(MediaCommand::Toggle)),
            (Call::Play, Some(MediaCommand::Play)),
            (Call::Stop, Some(MediaCommand::Stop)),
            (Call::Raise, Some(MediaCommand::Raise)),
            (
                Call::Seek(Time::from_secs(-5)),
                Some(MediaCommand::SeekBy(-5_000_000)),
            ),
            (
                Call::SetPosition(id.clone(), Time::from_secs(12)),
                Some(MediaCommand::SeekTo(Duration::from_secs(12))),
            ),
            (
                Call::SetPosition(id.clone(), Time::from_secs(240)),
                Some(MediaCommand::SeekTo(Duration::from_secs(240))),
            ),
            // Stale track, negative or past the end: no effect.
            (
                Call::SetPosition(
                    track("/com/quran/labs/desktop/track/2_254"),
                    Time::from_secs(12),
                ),
                None,
            ),
            (Call::SetPosition(id.clone(), Time::from_secs(-1)), None),
            (Call::SetPosition(id.clone(), Time::from_secs(241)), None),
            (Call::SetRate(1.5), Some(MediaCommand::SetRate(1.5))),
            (Call::SetRate(0.0), Some(MediaCommand::Pause)),
            (Call::SetRate(-1.0), None),
            (Call::SetRate(f64::NAN), None),
            (Call::SetRate(f64::INFINITY), None),
        ];
        for (call, expected) in cases {
            assert_eq!(command(&playing, call.clone()), expected, "{call:?}");
        }
        // Nothing loaded: only Raise does something.
        let hidden = View::hidden(1.0, t0);
        for call in [
            Call::Next,
            Call::Previous,
            Call::Pause,
            Call::PlayPause,
            Call::Play,
            Call::Stop,
            Call::Seek(Time::from_secs(5)),
            Call::SetPosition(TrackId::NO_TRACK, Time::ZERO),
            Call::SetRate(1.5),
            Call::SetRate(0.0),
        ] {
            assert_eq!(command(&hidden, call.clone()), None, "{call:?}");
        }
        assert_eq!(command(&hidden, Call::Raise), Some(MediaCommand::Raise));
        // The first and last ayah of a range: no previous/next.
        let edges = View {
            can_go_next: false,
            can_go_previous: false,
            ..playing
        };
        assert_eq!(command(&edges, Call::Next), None);
        assert_eq!(command(&edges, Call::Previous), None);
    }

    #[test]
    fn artwork_paths_become_file_urls() {
        assert_eq!(
            file_url(Path::new(
                "/home/user/.local/share/com.quran.labs.desktop/media-artwork.png"
            ))
            .as_deref(),
            Some("file:///home/user/.local/share/com.quran.labs.desktop/media-artwork.png")
        );
        assert_eq!(
            file_url(Path::new("/home/فؤاد/My Files/art#1%.png")).as_deref(),
            Some("file:///home/%D9%81%D8%A4%D8%A7%D8%AF/My%20Files/art%231%25.png")
        );
        assert_eq!(file_url(Path::new("relative/art.png")), None);
    }

    #[test]
    fn a_burst_keeps_the_latest_of_each_kind() {
        let mut batch = Batch::default();
        batch.push(Msg::State(state(Status::Playing, 1)));
        batch.push(Msg::Metadata(metadata("a")));
        batch.push(Msg::Metadata(metadata("b")));
        batch.push(Msg::State(state(Status::Paused, 2)));
        assert_eq!(batch.len, 4);
        assert_eq!(batch.metadata.as_ref().map(|m| m.title.as_str()), Some("b"));
        assert_eq!(batch.state.unwrap().status, Status::Paused);
        assert!(!batch.shutdown);
        batch.push(Msg::Shutdown);
        assert!(batch.shutdown);
    }

    // ---- End to end, over the real session bus (skipped where there is none, e.g. a headless CI runner without
    // `dbus-run-session`) ----

    const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
    const ROOT: &str = "org.mpris.MediaPlayer2";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
    /// How long a published update may take to become visible to a client.
    const PROPAGATION: Duration = Duration::from_secs(3);

    fn session_bus() -> Option<blocking::Connection> {
        match blocking::Connection::session() {
            Ok(conn) => Some(conn),
            Err(e) => {
                eprintln!("skipped: no D-Bus session bus ({e})");
                None
            }
        }
    }

    /// A bus-name suffix no other test (or running app) uses.
    fn unique_dbus_name() -> String {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        format!(
            "qd_test_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn config(dbus_name: &str) -> SessionConfig {
        SessionConfig {
            app_id: "com.quran.labs.desktop".into(),
            desktop_entry: "Quran".into(),
            display_name: "Quran".into(),
            dbus_name: dbus_name.into(),
            hwnd: None,
        }
    }

    type Recorded = Arc<Mutex<Vec<MediaCommand>>>;

    fn recorder() -> (Recorded, CommandHandler) {
        let calls: Recorded = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&calls);
        (calls, Arc::new(move |cmd| sink.lock().unwrap().push(cmd)))
    }

    fn take(calls: &Recorded) -> Vec<MediaCommand> {
        std::mem::take(&mut *calls.lock().unwrap())
    }

    fn get(conn: &blocking::Connection, dest: &str, iface: &str, name: &str) -> OwnedValue {
        conn.call_method(
            Some(dest),
            OBJECT_PATH,
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &(iface, name),
        )
        .unwrap_or_else(|e| panic!("Get {iface}.{name}: {e}"))
        .body()
        .deserialize::<OwnedValue>()
        .unwrap()
    }

    fn get_string(conn: &blocking::Connection, dest: &str, iface: &str, name: &str) -> String {
        String::try_from(get(conn, dest, iface, name)).unwrap()
    }

    fn get_bool(conn: &blocking::Connection, dest: &str, name: &str) -> bool {
        bool::try_from(get(conn, dest, PLAYER, name)).unwrap()
    }

    fn get_f64(conn: &blocking::Connection, dest: &str, name: &str) -> f64 {
        f64::try_from(get(conn, dest, PLAYER, name)).unwrap()
    }

    fn get_metadata(conn: &blocking::Connection, dest: &str) -> HashMap<String, OwnedValue> {
        HashMap::try_from(get(conn, dest, PLAYER, "Metadata")).unwrap()
    }

    fn call(
        conn: &blocking::Connection,
        dest: &str,
        method: &str,
        body: &(impl zbus::export::serde::Serialize + zbus::zvariant::DynamicType),
    ) -> zbus::Result<()> {
        conn.call_method(Some(dest), OBJECT_PATH, Some(PLAYER), method, body)
            .map(|_| ())
    }

    fn set(
        conn: &blocking::Connection,
        dest: &str,
        name: &str,
        value: zbus::zvariant::Value<'_>,
    ) -> zbus::Result<()> {
        conn.call_method(
            Some(dest),
            OBJECT_PATH,
            Some("org.freedesktop.DBus.Properties"),
            "Set",
            &(PLAYER, name, value),
        )
        .map(|_| ())
    }

    /// Polls until the player reports `status` (updates are asynchronous).
    fn wait_for_status(conn: &blocking::Connection, dest: &str, status: &str) {
        let deadline = Instant::now() + PROPAGATION;
        loop {
            let now = get_string(conn, dest, PLAYER, "PlaybackStatus");
            if now == status {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "PlaybackStatus stayed {now}, expected {status}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn name_has_owner(conn: &blocking::Connection, name: &str) -> bool {
        let dbus = blocking::fdo::DBusProxy::new(conn).unwrap();
        dbus.name_has_owner(name.try_into().unwrap()).unwrap()
    }

    fn start(dbus_name: &str) -> (Box<dyn Backend>, Recorded) {
        let (calls, on_command) = recorder();
        let backend = LinuxBackend::start(&config(dbus_name), on_command)
            .unwrap_or_else(|e| panic!("MPRIS player did not start: {e}"));
        (Box::new(backend), calls)
    }

    #[test]
    fn the_player_is_driven_end_to_end_over_the_session_bus() {
        let Some(conn) = session_bus() else {
            return;
        };
        let suffix = unique_dbus_name();
        let dest = format!("org.mpris.MediaPlayer2.{suffix}");
        let (backend, calls) = start(&suffix);
        assert!(name_has_owner(&conn, &dest));

        // Identity and the hidden initial state.
        assert_eq!(get_string(&conn, &dest, ROOT, "Identity"), "Quran");
        assert_eq!(get_string(&conn, &dest, ROOT, "DesktopEntry"), "Quran");
        assert!(bool::try_from(get(&conn, &dest, ROOT, "CanRaise")).unwrap());
        assert!(!bool::try_from(get(&conn, &dest, ROOT, "CanQuit")).unwrap());
        assert_eq!(
            get_string(&conn, &dest, PLAYER, "PlaybackStatus"),
            "Stopped"
        );
        assert!(!get_bool(&conn, &dest, "CanPlay") && !get_bool(&conn, &dest, "CanPause"));
        assert!(get_bool(&conn, &dest, "CanControl"));
        assert!((get_f64(&conn, &dest, "MinimumRate") - 0.5).abs() < 1e-9);
        assert!((get_f64(&conn, &dest, "MaximumRate") - 2.0).abs() < 1e-9);
        assert!(get_metadata(&conn, &dest).is_empty());
        // Nothing loaded: requests have no effect (PlayPause raises an error); Raise always works.
        call(&conn, &dest, "Next", &()).unwrap();
        call(&conn, &dest, "Play", &()).unwrap();
        assert!(call(&conn, &dest, "PlayPause", &()).is_err());
        conn.call_method(Some(dest.as_str()), OBJECT_PATH, Some(ROOT), "Raise", &())
            .unwrap();
        assert_eq!(take(&calls), vec![MediaCommand::Raise]);

        // A recitation starts.
        let signals = seeked_signals(&conn, &dest);
        backend.set_metadata(metadata("Al-Baqarah 2:255"));
        backend.set_state(PlaybackState {
            rate: 1.25,
            ..state(Status::Playing, 61_500)
        });
        wait_for_status(&conn, &dest, "Playing");
        let m = get_metadata(&conn, &dest);
        let text = |key: &str| String::try_from(m[key].try_clone().unwrap()).unwrap();
        assert_eq!(text("xesam:title"), "Al-Baqarah 2:255");
        assert_eq!(text("xesam:album"), "The Holy Quran");
        assert_eq!(
            Vec::<String>::try_from(m["xesam:artist"].try_clone().unwrap()).unwrap(),
            vec!["Mishari Rashid al-Afasy".to_owned()]
        );
        assert_eq!(
            i64::try_from(m["mpris:length"].try_clone().unwrap()).unwrap(),
            240_000_000
        );
        assert_eq!(
            text("mpris:artUrl"),
            "file:///home/user/.local/share/com.quran.labs.desktop/media-artwork.png"
        );
        let trackid = ObjectPath::try_from(m["mpris:trackid"].try_clone().unwrap()).unwrap();
        assert_eq!(trackid.as_str(), "/com/quran/labs/desktop/track/2_255");
        assert!((get_f64(&conn, &dest, "Rate") - 1.25).abs() < 1e-9);
        assert!(get_bool(&conn, &dest, "CanPlay") && get_bool(&conn, &dest, "CanPause"));
        assert!(get_bool(&conn, &dest, "CanSeek") && get_bool(&conn, &dest, "CanGoNext"));
        // 61.5 s, advancing at 1.25x for at most the propagation time.
        let position = i64::try_from(get(&conn, &dest, PLAYER, "Position")).unwrap();
        assert!((61_500_000..=65_250_000).contains(&position), "{position}");

        // Every request reaches the handler exactly once.
        for method in ["PlayPause", "Next", "Previous", "Pause", "Play", "Stop"] {
            call(&conn, &dest, method, &()).unwrap();
        }
        call(&conn, &dest, "Seek", &(-5_000_000_i64)).unwrap();
        call(
            &conn,
            &dest,
            "SetPosition",
            &(trackid.clone(), 12_000_000_i64),
        )
        .unwrap();
        let stale = ObjectPath::try_from("/com/quran/labs/desktop/track/2_254").unwrap();
        call(&conn, &dest, "SetPosition", &(stale, 12_000_000_i64)).unwrap();
        set(&conn, &dest, "Rate", 1.5_f64.into()).unwrap();
        set(&conn, &dest, "Rate", 0.0_f64.into()).unwrap();
        assert!(set(&conn, &dest, "Shuffle", true.into()).is_err());
        assert!(call(&conn, &dest, "OpenUri", &("file:///tmp/x.mp3",)).is_err());
        assert_eq!(
            take(&calls),
            vec![
                MediaCommand::Toggle,
                MediaCommand::Next,
                MediaCommand::Previous,
                MediaCommand::Pause,
                MediaCommand::Play,
                MediaCommand::Stop,
                MediaCommand::SeekBy(-5_000_000),
                MediaCommand::SeekTo(Duration::from_secs(12)),
                MediaCommand::SetRate(1.5),
                MediaCommand::Pause,
            ]
        );

        // A jump within the ayah is announced with Seeked.
        backend.set_state(PlaybackState {
            rate: 1.25,
            ..state(Status::Paused, 150_000)
        });
        wait_for_status(&conn, &dest, "Paused");
        assert_eq!(signals.recv_timeout(PROPAGATION).ok(), Some(150_000_000));
        let paused_at = i64::try_from(get(&conn, &dest, PLAYER, "Position")).unwrap();
        assert_eq!(paused_at, 150_000_000);

        // Stop hides the player.
        backend.set_state(PlaybackState::STOPPED);
        wait_for_status(&conn, &dest, "Stopped");
        assert!(get_metadata(&conn, &dest).is_empty());
        assert!(!get_bool(&conn, &dest, "CanPlay") && !get_bool(&conn, &dest, "CanSeek"));

        // Shutdown releases the name.
        backend.shutdown();
        assert!(!name_has_owner(&conn, &dest));
        assert!(take(&calls).is_empty());
    }

    #[test]
    fn a_taken_name_falls_back_to_an_instance_name() {
        let Some(conn) = session_bus() else {
            return;
        };
        let suffix = unique_dbus_name();
        let (first, _) = start(&suffix);
        let (second, _) = start(&suffix);
        let instance = format!(
            "org.mpris.MediaPlayer2.{suffix}.instance{}",
            std::process::id()
        );
        assert!(name_has_owner(
            &conn,
            &format!("org.mpris.MediaPlayer2.{suffix}")
        ));
        assert!(name_has_owner(&conn, &instance));
        assert_eq!(get_string(&conn, &instance, ROOT, "Identity"), "Quran");
        // A third one finds both taken and fails (the session then falls back to no-op).
        let (_, on_command) = recorder();
        assert!(matches!(
            LinuxBackend::start(&config(&suffix), on_command),
            Err(MediaSessionError::Platform(_))
        ));
        second.shutdown();
        assert!(!name_has_owner(&conn, &instance));
        // Dropping without shutdown still releases the name (asynchronously).
        drop(first);
        let deadline = Instant::now() + PROPAGATION;
        while name_has_owner(&conn, &format!("org.mpris.MediaPlayer2.{suffix}")) {
            assert!(
                Instant::now() < deadline,
                "the name outlived the dropped backend"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Positions announced by `Seeked`, collected on a helper thread (the blocking signal iterator has no timeout; the
    /// thread ends with the test process).
    fn seeked_signals(conn: &blocking::Connection, dest: &str) -> mpsc::Receiver<i64> {
        let proxy = blocking::Proxy::new(conn, dest.to_owned(), OBJECT_PATH, PLAYER).unwrap();
        let signals = proxy.receive_signal("Seeked").unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("seeked-listener".to_owned())
            .spawn(move || {
                let _proxy = proxy;
                for msg in signals {
                    let Ok(position) = msg.body().deserialize::<i64>() else {
                        continue;
                    };
                    if tx.send(position).is_err() {
                        break;
                    }
                }
            })
            .unwrap();
        rx
    }
}
