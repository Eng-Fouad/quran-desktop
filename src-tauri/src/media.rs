//! OS media-session glue.
//!
//! - [`init`] starts the session for the main window (Windows: SMTC on the `qd-media` thread; macOS/Linux: the
//!   `media-session` backends) and returns `None`, logged, when the platform has none or it cannot start: the app then
//!   runs without OS media controls.
//! - [`on_audio_state`] maps an [`AudioSnapshot`] to the session's [`Metadata`] and [`PlaybackState`]. It is called on
//!   ayah and state edges only (never per tick) and itself sends only what changed: metadata on an ayah, reciter,
//!   language or duration change; the state on a status, rate or capability change, on every metadata change, and on
//!   a seek (a position more than 1 s (`SEEK_TOLERANCE`) away from where the previous update said it would be).
//! - [`now_playing`] builds the localised labels, title `"{surah name} {s}:{a}"` (English UI: `name_simple`, Arabic
//!   UI: `name_ar` with Arabic-Indic digits) and the reciter name in the UI language, for the media session and the
//!   tray's "Now: {ref}" label alike.
//! - [`on_ui_language_changed`] re-sends the current metadata in the new language.
//!
//! Position and duration are on the surah-file timeline. OS commands go to the `on_command` router of `setup.rs`
//! (Next/Previous = next/previous ayah; SetRate → `set_speed`, rounded to 5 %).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use media_session::{
    BackendKind, MediaCommand, MediaSession, Metadata, PlaybackState, SessionConfig, Status,
};
use quran_types::{AudioSnapshot, AyahRef, PlaybackStatus, UiLanguage};
use tauri::{AppHandle, Manager, Runtime};

use crate::i18n::{self, RustText};
use crate::state::AppState;

/// MPRIS `DesktopEntry`: the basename of the installed .desktop file, from which GNOME and KDE take the player's name
/// and icon. The tauri bundler (CLI 2.12.1) installs `usr/share/applications/{productName}.desktop` in the .deb and
/// links the same file at the AppImage's root, so this is `productName` from `tauri.conf.json`, spaces included:
/// `Quran.desktop`. A unit test keeps the two equal.
const DESKTOP_ENTRY: &str = "Quran";
/// MPRIS bus name suffix: `org.mpris.MediaPlayer2.quran_desktop`. It follows the binary name (`mainBinaryName`
/// `quran-desktop`, also the desktop file's `Exec`, `Icon` and `StartupWMClass`), not the product name: a bare
/// `org.mpris.MediaPlayer2.quran` would be too generic a well-known name.
const DBUS_NAME: &str = "quran_desktop";
/// The artwork: the brand's media artwork, 512 px, square and opaque (the media flyouts crop or round it themselves;
/// the app icon's transparent corners would show as a frame there).
const ARTWORK_PNG: &[u8] = include_bytes!("../icons/media/artwork.png");
/// Where the artwork is materialised under the data root (SMTC, Now Playing and MPRIS all take a file).
const ARTWORK_FILE: &str = "media-artwork.png";
/// A position this far from the extrapolated one is a seek, which the OS timeline must hear about.
const SEEK_TOLERANCE: Duration = Duration::from_millis(1_000);

/// Windows: sets the process AppUserModelID (`app_id`, the bundle identifier) so SMTC, the taskbar and toasts attribute
/// the process to the installed app. Must run before any window exists, i.e. as the FIRST statement of
/// `quran_desktop_lib::run()`. Failures are reported, never fatal.
#[cfg(windows)]
pub fn set_app_user_model_id(app_id: &str) -> Result<(), String> {
    media_session::set_process_app_user_model_id(app_id).map_err(|e| e.to_string())
}

/// Starts the OS media session for the main window. `None` (logged) when the platform backend cannot start or the
/// platform has none: the app then runs without OS media controls.
pub fn init<R: Runtime>(
    app: &AppHandle<R>,
    on_command: Arc<dyn Fn(MediaCommand) + Send + Sync>,
) -> Option<MediaSession> {
    app.manage(MediaGlue::default());
    let cfg = SessionConfig {
        app_id: app.config().identifier.clone(),
        desktop_entry: DESKTOP_ENTRY.to_owned(),
        display_name: app.package_info().name.clone(),
        dbus_name: DBUS_NAME.to_owned(),
        hwnd: main_hwnd(app),
    };
    match MediaSession::new(cfg, main_thread_dispatch(app), on_command) {
        Ok(session) if session.kind() == BackendKind::Noop => {
            // The crate logged why; a no-op session would only cost mapping work.
            session.shutdown();
            None
        }
        Ok(session) => Some(session),
        Err(e) => {
            log::warn!("media session unavailable, running without OS media controls: {e}");
            None
        }
    }
}

/// Maps an audio snapshot to the session's metadata and state (`set_metadata`/`set_state`); called on ayah or state
/// edges only, never per tick, and sends only what changed (see the module docs).
///
/// `title` and `reciter` are the labels of [`now_playing`] for this snapshot when the caller already built them (the
/// tray needs the same title); an empty string makes this function derive that label itself.
pub fn on_audio_state<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &AudioSnapshot,
    title: &str,
    reciter: &str,
) {
    let (Some(state), Some(glue)) = (app.try_state::<AppState>(), app.try_state::<MediaGlue>())
    else {
        return;
    };
    let Some(session) = state.media.get() else {
        return;
    };
    glue.lock()
        .refresh(&state, session, snapshot, title, reciter);
}

/// The localised now-playing labels of a snapshot, or `None` when nothing is loaded. Shared by the media session and
/// the tray's "Now: {ref}" label (`RustText::TrayNowPlaying` with `{ref}` = `title`).
pub fn now_playing<R: Runtime>(app: &AppHandle<R>, snapshot: &AudioSnapshot) -> Option<NowPlaying> {
    let state = app.try_state::<AppState>()?;
    match app.try_state::<MediaGlue>() {
        Some(glue) => glue.lock().labels(&state, snapshot),
        // Before `init` (or without a session): a one-off lookup.
        None => Glue::default().labels(&state, snapshot),
    }
}

/// A `ui_language` change (called by `window::apply_settings`): re-sends the current metadata in `lang`.
pub fn on_ui_language_changed<R: Runtime>(app: &AppHandle<R>, lang: UiLanguage) {
    let Some(glue) = app.try_state::<MediaGlue>() else {
        return;
    };
    let mut glue = glue.lock();
    if glue.lang == Some(lang) {
        return;
    }
    glue.lang = Some(lang);
    let (Some(state), Some(snapshot)) = (app.try_state::<AppState>(), glue.memo.snapshot.clone())
    else {
        return;
    };
    let Some(session) = state.media.get() else {
        return;
    };
    glue.refresh(&state, session, &snapshot, "", "");
}

/// Localised labels of what is playing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NowPlaying {
    /// `"Al-Baqarah 2:255"` / `"البقرة ٢:٢٥٥"`; during the basmala only the surah name.
    pub title: String,
    /// Reciter name in the UI language (empty when unknown).
    pub reciter: String,
}

fn pick(given: &str, derived: Option<&str>) -> String {
    if given.is_empty() {
        derived.unwrap_or_default().to_owned()
    } else {
        given.to_owned()
    }
}

/// Managed by [`init`]: the language, the lookups and what was last sent.
#[derive(Default)]
struct MediaGlue(Mutex<Glue>);

impl MediaGlue {
    fn lock(&self) -> MutexGuard<'_, Glue> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One surah's names.
struct SurahName {
    simple: String,
    arabic: String,
}

#[derive(Default)]
struct Glue {
    /// `settings.ui_language`, read once, then kept current by [`on_ui_language_changed`].
    lang: Option<UiLanguage>,
    /// 114 entries once the core index was read; empty when it cannot be (degraded debug build).
    surahs: Option<Arc<[SurahName]>>,
    /// The artwork file, once materialised (`Some(None)`: it could not be written).
    artwork: Option<Option<PathBuf>>,
    memo: Memo,
}

impl Glue {
    /// Resolves what the snapshot needs (labels, album and artwork, only while a recitation is loaded) and sends the
    /// edges. `title`/`reciter`: the caller's labels, an empty one is derived here.
    fn refresh(
        &mut self,
        state: &AppState,
        session: &MediaSession,
        snapshot: &AudioSnapshot,
        title: &str,
        reciter: &str,
    ) {
        let (labels, extras) = if playback_state(snapshot).is_active() {
            let derived = (title.is_empty() || reciter.is_empty())
                .then(|| self.labels(state, snapshot))
                .flatten();
            let labels = NowPlaying {
                title: pick(title, derived.as_ref().map(|l| l.title.as_str())),
                reciter: pick(reciter, derived.as_ref().map(|l| l.reciter.as_str())),
            };
            (labels, self.extras(state))
        } else {
            (NowPlaying::default(), Extras::default())
        };
        self.memo
            .update(snapshot, labels, &extras, Instant::now())
            .send(session);
    }

    fn lang(&mut self, state: &AppState) -> UiLanguage {
        *self
            .lang
            .get_or_insert_with(|| match state.user.settings_load() {
                Ok(settings) => settings.ui_language,
                Err(e) => {
                    log::debug!("media session: settings unavailable ({e}); using the OS locale");
                    UiLanguage::from_os_locale(state.app_info.os_locale.as_deref())
                }
            })
    }

    fn labels(&mut self, state: &AppState, snapshot: &AudioSnapshot) -> Option<NowPlaying> {
        let current = snapshot.current?;
        let lang = self.lang(state);
        let surahs = self.surahs(state);
        let name = usize::try_from(current.surah)
            .ok()
            .and_then(|s| s.checked_sub(1))
            .and_then(|i| surahs.get(i))
            .map(|n| match lang {
                UiLanguage::En => n.simple.as_str(),
                UiLanguage::Ar => n.arabic.as_str(),
            });
        let reciter = snapshot
            .reciter_id
            .and_then(|id| state.packs.reciter_meta(id))
            .map(|(name, _)| localised(lang, &name.en, &name.ar))
            .unwrap_or_default();
        Some(NowPlaying {
            title: track_title(lang, name, current),
            reciter,
        })
    }

    fn surahs(&mut self, state: &AppState) -> Arc<[SurahName]> {
        let surahs = self.surahs.get_or_insert_with(|| match state.core.index() {
            Ok(index) => index
                .surahs
                .into_iter()
                .map(|s| SurahName {
                    simple: s.name_simple,
                    arabic: s.name_ar,
                })
                .collect(),
            Err(e) => {
                log::debug!("media session: no surah names ({e}); titles show the reference only");
                Arc::from(Vec::new())
            }
        });
        Arc::clone(surahs)
    }

    fn extras(&mut self, state: &AppState) -> Extras {
        let lang = self.lang(state);
        let artwork = self
            .artwork
            .get_or_insert_with(|| match materialise_artwork(&state.paths.data) {
                Ok(path) => Some(path),
                Err(e) => {
                    log::warn!(
                        "media session: artwork not written ({e}); the OS shows its default"
                    );
                    None
                }
            })
            .clone();
        Extras {
            album: i18n::text(lang, RustText::MediaAlbum).to_owned(),
            artwork,
        }
    }
}

/// The parts of the metadata that do not come from the snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Extras {
    album: String,
    artwork: Option<PathBuf>,
}

/// What was last sent, and the decision of what to send next (pure, so it is unit-tested).
#[derive(Default)]
struct Memo {
    /// The last snapshot seen (re-localised on a language change).
    snapshot: Option<AudioSnapshot>,
    metadata: Option<Metadata>,
    state: Option<(PlaybackState, Instant)>,
}

/// The calls one snapshot leads to.
#[derive(Debug, Default, PartialEq)]
struct Update {
    metadata: Option<Metadata>,
    state: Option<PlaybackState>,
}

impl Update {
    fn send(self, session: &MediaSession) {
        if let Some(m) = self.metadata {
            session.set_metadata(m);
        }
        if let Some(s) = self.state {
            session.set_state(s);
        }
    }
}

impl Memo {
    fn update(
        &mut self,
        snapshot: &AudioSnapshot,
        labels: NowPlaying,
        extras: &Extras,
        now: Instant,
    ) -> Update {
        self.snapshot = Some(snapshot.clone());
        let next = playback_state(snapshot);
        if !next.is_active() {
            // Nothing loaded: hide the session once; the next play re-sends its metadata.
            self.metadata = None;
            let was_active = self.state.as_ref().is_some_and(|(s, _)| s.is_active());
            if !was_active {
                return Update::default();
            }
            self.state = Some((next, now));
            return Update {
                metadata: None,
                state: Some(next),
            };
        }
        let metadata = Metadata {
            title: labels.title,
            artist: labels.reciter,
            album: extras.album.clone(),
            duration: (snapshot.file_duration_ms > 0).then(|| ms(snapshot.file_duration_ms)),
            artwork_path: extras.artwork.clone(),
        };
        let mut update = Update::default();
        if self.metadata.as_ref() != Some(&metadata) {
            self.metadata = Some(metadata.clone());
            update.metadata = Some(metadata);
        }
        let state_due = update.metadata.is_some()
            || self
                .state
                .as_ref()
                .is_none_or(|(prev, at)| state_changed(prev, *at, &next, now));
        if state_due {
            self.state = Some((next, now));
            update.state = Some(next);
        }
        update
    }
}

/// Whether `next` differs from what the OS shows since `prev` was sent at `at`: transport, rate or capabilities, or a
/// position jump of more than [`SEEK_TOLERANCE`] from the extrapolated one (while playing the OS advances the
/// position itself at the given rate).
fn state_changed(prev: &PlaybackState, at: Instant, next: &PlaybackState, now: Instant) -> bool {
    if prev.status != next.status
        || prev.can_next != next.can_next
        || prev.can_previous != next.can_previous
        || prev.can_seek != next.can_seek
        || (prev.effective_rate() - next.effective_rate()).abs() > 1e-6
    {
        return true;
    }
    let expected = if prev.status == Status::Playing {
        let elapsed = now.saturating_duration_since(at).as_secs_f64() * prev.effective_rate();
        Duration::try_from_secs_f64(elapsed)
            .ok()
            .and_then(|d| prev.position.checked_add(d))
            .unwrap_or(Duration::MAX)
    } else {
        prev.position
    };
    expected.abs_diff(next.position) > SEEK_TOLERANCE
}

/// Engine status → OS transport. Loading and buffering count as playing (the user asked to play); an error with an
/// ayah still loaded (a play that failed mid-way) shows as paused, and Play starts it again where it stopped (the
/// engine's resume); idle, or nothing loaded, hides the session.
fn playback_state(s: &AudioSnapshot) -> PlaybackState {
    let Some(current) = s.current else {
        return PlaybackState::STOPPED;
    };
    let status = match s.status {
        PlaybackStatus::Playing | PlaybackStatus::Loading | PlaybackStatus::Buffering => {
            Status::Playing
        }
        PlaybackStatus::Paused | PlaybackStatus::Error => Status::Paused,
        PlaybackStatus::Idle => return PlaybackState::STOPPED,
    };
    let more_in_range = s.range.is_some_and(|r| order(current) < order(r.to));
    // A failed play offers Play and Stop only: the engine skips and seeks within a running play.
    let running = s.status != PlaybackStatus::Error;
    PlaybackState {
        status,
        position: ms(s.file_ms),
        rate: f64::from(s.speed_pct) / 100.0,
        // Next at the last ayah starts the next pass while range repeats remain (0 = infinite), as the engine does;
        // Previous always works (restart or previous ayah).
        can_next: running && (more_in_range || s.range_repeat == 0 || s.range_repeat_left > 0),
        can_previous: running,
        can_seek: running && s.file_duration_ms > 0,
    }
}

fn order(r: AyahRef) -> (u32, u32) {
    (r.surah, r.ayah)
}

fn ms(ms: u32) -> Duration {
    Duration::from_millis(u64::from(ms))
}

/// `"{name} {s}:{a}"`; during the basmala (`a = 0`) the surah name alone. Without a name (no core data) the
/// reference alone. Arabic uses Arabic-Indic digits.
fn track_title(lang: UiLanguage, name: Option<&str>, at: AyahRef) -> String {
    let reference = if at.ayah == 0 {
        number(lang, at.surah)
    } else {
        format!("{}:{}", number(lang, at.surah), number(lang, at.ayah))
    };
    match name.filter(|n| !n.trim().is_empty()) {
        Some(name) if at.ayah == 0 => name.to_owned(),
        Some(name) => format!("{name} {reference}"),
        None => reference,
    }
}

/// A number in the UI language's digits: ASCII in English, Arabic-Indic (U+0660..U+0669) in Arabic.
fn number(lang: UiLanguage, n: u32) -> String {
    let ascii = n.to_string();
    match lang {
        UiLanguage::En => ascii,
        UiLanguage::Ar => ascii
            .chars()
            .map(|c| {
                c.to_digit(10)
                    .and_then(|d| char::from_u32(0x0660 + d))
                    .unwrap_or(c)
            })
            .collect(),
    }
}

/// The UI-language variant, falling back to the other one when it is empty.
fn localised(lang: UiLanguage, en: &str, ar: &str) -> String {
    let (first, second) = match lang {
        UiLanguage::En => (en, ar),
        UiLanguage::Ar => (ar, en),
    };
    if first.trim().is_empty() {
        second
    } else {
        first
    }
    .to_owned()
}

/// Writes the app icon to `<dir>/media-artwork.png` unless it is already there with the same bytes (temp file +
/// rename, so a reader never sees half a file).
fn materialise_artwork(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join(ARTWORK_FILE);
    if std::fs::read(&path).is_ok_and(|bytes| bytes == ARTWORK_PNG) {
        return Ok(path);
    }
    let tmp = dir.join(format!("{ARTWORK_FILE}.tmp"));
    std::fs::write(&tmp, ARTWORK_PNG)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Windows: the raw HWND of the main window (hidden, never destroyed, on close-to-tray).
#[cfg(windows)]
fn main_hwnd<R: Runtime>(app: &AppHandle<R>) -> Option<isize> {
    let window = app.get_webview_window(crate::MAIN_WINDOW)?;
    match window.hwnd() {
        Ok(hwnd) => Some(hwnd.0 as isize),
        Err(e) => {
            log::warn!("media session: no HWND for the main window: {e}");
            None
        }
    }
}

#[cfg(not(windows))]
fn main_hwnd<R: Runtime>(_app: &AppHandle<R>) -> Option<isize> {
    None
}

/// macOS: every Now Playing call runs on the main thread (`AppHandle::run_on_main_thread`).
#[cfg(target_os = "macos")]
fn main_thread_dispatch<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<media_session::MainThreadDispatch> {
    let app = app.clone();
    Some(Arc::new(move |job: Box<dyn FnOnce() + Send>| {
        if let Err(e) = app.run_on_main_thread(job) {
            log::warn!("media session: run_on_main_thread: {e}");
        }
    }))
}

#[cfg(not(target_os = "macos"))]
fn main_thread_dispatch<R: Runtime>(
    _app: &AppHandle<R>,
) -> Option<media_session::MainThreadDispatch> {
    None
}

#[cfg(test)]
mod tests {
    use quran_audio::shared::idle_snapshot;
    use quran_types::AyahRange;

    use super::*;

    fn at(surah: u32, ayah: u32) -> AyahRef {
        AyahRef { surah, ayah }
    }

    /// Al-Baqarah 2:255..=257 at 100 %, 4 minutes of surah file.
    fn playing(ayah: u32, file_ms: u32) -> AudioSnapshot {
        AudioSnapshot {
            status: PlaybackStatus::Playing,
            reciter_id: Some(7),
            current: Some(at(2, ayah)),
            current_ayah_id: Some(262 + ayah),
            range: Some(AyahRange {
                from: at(2, 255),
                to: at(2, 257),
            }),
            file_ms,
            file_duration_ms: 240_000,
            ..idle_snapshot()
        }
    }

    fn labels(title: &str) -> NowPlaying {
        NowPlaying {
            title: title.to_owned(),
            reciter: "Mishari Rashid al-Afasy".to_owned(),
        }
    }

    fn extras() -> Extras {
        Extras {
            album: "The Holy Quran".to_owned(),
            artwork: Some(PathBuf::from("media-artwork.png")),
        }
    }

    /// The bundler names the Linux desktop file after `productName`, so a rename there must move `DESKTOP_ENTRY` too.
    #[test]
    fn the_desktop_entry_is_the_product_name() -> Result<(), Box<dyn std::error::Error>> {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
        assert_eq!(conf["productName"], DESKTOP_ENTRY);
        SessionConfig {
            app_id: crate::APP_ID.to_owned(),
            desktop_entry: DESKTOP_ENTRY.to_owned(),
            display_name: DESKTOP_ENTRY.to_owned(),
            dbus_name: DBUS_NAME.to_owned(),
            hwnd: None,
        }
        .validate()?;
        Ok(())
    }

    #[test]
    fn titles_follow_the_ui_language() {
        assert_eq!(
            track_title(UiLanguage::En, Some("Al-Baqarah"), at(2, 255)),
            "Al-Baqarah 2:255"
        );
        assert_eq!(
            track_title(UiLanguage::Ar, Some("البقرة"), at(2, 255)),
            "البقرة ٢:٢٥٥"
        );
        assert_eq!(
            track_title(UiLanguage::Ar, Some("الفاتحة"), at(1, 7)),
            "الفاتحة ١:٧"
        );
        assert_eq!(track_title(UiLanguage::En, None, at(114, 6)), "114:6");
        assert_eq!(track_title(UiLanguage::Ar, Some(" "), at(110, 3)), "١١٠:٣");
    }

    #[test]
    fn the_basmala_shows_the_surah_name() {
        assert_eq!(
            track_title(UiLanguage::En, Some("Al-Kahf"), at(18, 0)),
            "Al-Kahf"
        );
        assert_eq!(
            track_title(UiLanguage::Ar, Some("الكهف"), at(18, 0)),
            "الكهف"
        );
        assert_eq!(track_title(UiLanguage::Ar, None, at(18, 0)), "١٨");
    }

    #[test]
    fn digits_and_fallback_names() {
        assert_eq!(number(UiLanguage::Ar, 6_236), "٦٢٣٦");
        assert_eq!(number(UiLanguage::Ar, 0), "٠");
        assert_eq!(number(UiLanguage::En, 6_236), "6236");
        assert_eq!(localised(UiLanguage::Ar, "Alafasy", "العفاسي"), "العفاسي");
        assert_eq!(localised(UiLanguage::Ar, "Alafasy", ""), "Alafasy");
        assert_eq!(localised(UiLanguage::En, " ", "العفاسي"), "العفاسي");
    }

    #[test]
    fn engine_statuses_map_to_transport_states() {
        let with = |status| AudioSnapshot {
            status,
            ..playing(255, 1_000)
        };
        assert_eq!(
            playback_state(&with(PlaybackStatus::Playing)).status,
            Status::Playing
        );
        assert_eq!(
            playback_state(&with(PlaybackStatus::Loading)).status,
            Status::Playing
        );
        assert_eq!(
            playback_state(&with(PlaybackStatus::Buffering)).status,
            Status::Playing
        );
        assert_eq!(
            playback_state(&with(PlaybackStatus::Paused)).status,
            Status::Paused
        );
        assert_eq!(
            playback_state(&with(PlaybackStatus::Error)).status,
            Status::Paused
        );
        assert_eq!(
            playback_state(&with(PlaybackStatus::Idle)),
            PlaybackState::STOPPED
        );
        assert_eq!(playback_state(&idle_snapshot()), PlaybackState::STOPPED);
        let nothing_loaded = AudioSnapshot {
            current: None,
            ..playing(255, 0)
        };
        assert_eq!(playback_state(&nothing_loaded), PlaybackState::STOPPED);
    }

    #[test]
    fn the_state_carries_position_rate_and_capabilities() {
        let s = playback_state(&AudioSnapshot {
            speed_pct: 125,
            ..playing(255, 61_500)
        });
        assert_eq!(s.position, Duration::from_millis(61_500));
        assert!((s.rate - 1.25).abs() < 1e-9);
        assert!(s.can_next && s.can_previous && s.can_seek);
        // Last ayah of the range, no repeats left: no next (the engine's Next would end the recitation).
        assert!(!playback_state(&playing(257, 0)).can_next);
        // ... unless the range repeats (passes left, or infinitely): the engine's Next starts the next pass.
        let repeating = AudioSnapshot {
            range_repeat: 3,
            range_repeat_left: 2,
            ..playing(257, 0)
        };
        assert!(playback_state(&repeating).can_next);
        let forever = AudioSnapshot {
            range_repeat: 0,
            ..playing(257, 0)
        };
        assert!(playback_state(&forever).can_next);
        // The last pass of a repeated range: no next.
        let last_pass = AudioSnapshot {
            range_repeat: 3,
            range_repeat_left: 0,
            ..playing(257, 0)
        };
        assert!(!playback_state(&last_pass).can_next);
        // A play that failed mid-way: paused, with Play (it starts again where it stopped), and no skips or seeks,
        // which the engine serves within a running play only.
        let failed = playback_state(&AudioSnapshot {
            status: PlaybackStatus::Error,
            ..playing(255, 61_500)
        });
        assert_eq!(failed.status, Status::Paused);
        assert_eq!(failed.position, Duration::from_millis(61_500));
        assert!(!failed.can_next && !failed.can_previous && !failed.can_seek);
        // Unknown duration: no seeking.
        let streaming = AudioSnapshot {
            file_duration_ms: 0,
            ..playing(255, 0)
        };
        assert!(!playback_state(&streaming).can_seek);
    }

    #[test]
    fn only_edges_reach_the_os() {
        let mut memo = Memo::default();
        let t0 = Instant::now();
        let e = extras();

        // Idle before anything played: nothing to hide.
        assert_eq!(
            memo.update(&idle_snapshot(), NowPlaying::default(), &e, t0),
            Update::default()
        );

        // First ayah: metadata and state.
        let first = memo.update(&playing(255, 10_000), labels("Al-Baqarah 2:255"), &e, t0);
        let metadata = first.metadata.clone().unwrap_or_default();
        assert_eq!(metadata.title, "Al-Baqarah 2:255");
        assert_eq!(metadata.artist, "Mishari Rashid al-Afasy");
        assert_eq!(metadata.album, "The Holy Quran");
        assert_eq!(metadata.duration, Some(Duration::from_secs(240)));
        assert_eq!(
            metadata.artwork_path,
            Some(PathBuf::from("media-artwork.png"))
        );
        assert_eq!(first.state.map(|s| s.status), Some(Status::Playing));

        // The same snapshot again, and a position where the OS already extrapolates it: nothing.
        let t1 = t0 + Duration::from_secs(2);
        assert_eq!(
            memo.update(&playing(255, 12_000), labels("Al-Baqarah 2:255"), &e, t1),
            Update::default()
        );

        // A seek within the ayah: state only.
        let seek = memo.update(&playing(255, 30_000), labels("Al-Baqarah 2:255"), &e, t1);
        assert!(seek.metadata.is_none());
        assert_eq!(
            seek.state.map(|s| s.position),
            Some(Duration::from_secs(30))
        );

        // Next ayah: metadata and a fresh position.
        let next = memo.update(&playing(256, 45_000), labels("Al-Baqarah 2:256"), &e, t1);
        assert_eq!(
            next.metadata.map(|m| m.title).as_deref(),
            Some("Al-Baqarah 2:256")
        );
        assert!(next.state.is_some());

        // Pause: state only. A paused position does not move.
        let paused = AudioSnapshot {
            status: PlaybackStatus::Paused,
            ..playing(256, 45_000)
        };
        let pause = memo.update(&paused, labels("Al-Baqarah 2:256"), &e, t1);
        assert!(pause.metadata.is_none());
        assert_eq!(pause.state.map(|s| s.status), Some(Status::Paused));
        let later = t1 + Duration::from_secs(30);
        assert_eq!(
            memo.update(&paused, labels("Al-Baqarah 2:256"), &e, later),
            Update::default()
        );

        // A speed change: state only.
        let faster = AudioSnapshot {
            speed_pct: 150,
            ..paused.clone()
        };
        let rate = memo.update(&faster, labels("Al-Baqarah 2:256"), &e, later);
        assert!(rate.metadata.is_none());
        assert!(rate.state.is_some_and(|s| (s.rate - 1.5).abs() < 1e-9));

        // Stop: hide once, then nothing; the next play re-sends the same metadata.
        let stop = memo.update(&idle_snapshot(), NowPlaying::default(), &e, later);
        assert_eq!(stop.state, Some(PlaybackState::STOPPED));
        assert!(stop.metadata.is_none());
        assert_eq!(
            memo.update(&idle_snapshot(), NowPlaying::default(), &e, later),
            Update::default()
        );
        let again = memo.update(&playing(256, 45_000), labels("Al-Baqarah 2:256"), &e, later);
        assert!(again.metadata.is_some() && again.state.is_some());
    }

    #[test]
    fn a_language_change_resends_the_metadata() {
        let mut memo = Memo::default();
        let t0 = Instant::now();
        let english = memo.update(&playing(255, 0), labels("Al-Baqarah 2:255"), &extras(), t0);
        assert!(english.metadata.is_some());
        let arabic_extras = Extras {
            album: "القرآن الكريم".to_owned(),
            ..extras()
        };
        let arabic = memo.update(&playing(255, 0), labels("البقرة ٢:٢٥٥"), &arabic_extras, t0);
        let metadata = arabic.metadata.unwrap_or_default();
        assert_eq!(metadata.title, "البقرة ٢:٢٥٥");
        assert_eq!(metadata.album, "القرآن الكريم");
        assert!(memo.snapshot.is_some());
    }

    #[test]
    fn playing_positions_are_extrapolated_at_the_rate() {
        let t0 = Instant::now();
        let prev = PlaybackState {
            status: Status::Playing,
            position: Duration::from_secs(10),
            rate: 2.0,
            can_next: true,
            can_previous: true,
            can_seek: true,
        };
        let at = |secs| PlaybackState {
            position: Duration::from_secs(secs),
            ..prev
        };
        // 5 s later at 2× the OS shows 20 s.
        let now = t0 + Duration::from_secs(5);
        assert!(!state_changed(&prev, t0, &at(20), now));
        assert!(state_changed(&prev, t0, &at(15), now));
        assert!(state_changed(&prev, t0, &at(40), now));
        // Garbage rates never panic.
        let nan = PlaybackState {
            rate: f64::NAN,
            ..prev
        };
        assert!(!state_changed(
            &nan,
            t0,
            &PlaybackState {
                rate: f64::NAN,
                ..at(15)
            },
            now
        ));
    }

    #[test]
    fn the_artwork_is_written_once_and_kept() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let path = materialise_artwork(dir.path()).unwrap_or_else(|e| panic!("write: {e}"));
        assert_eq!(std::fs::read(&path).ok().as_deref(), Some(ARTWORK_PNG));
        assert!(ARTWORK_PNG.starts_with(b"\x89PNG\r\n\x1a\n"));
        // A stale file is replaced; an identical one is left alone.
        std::fs::write(&path, b"stale").unwrap_or_else(|e| panic!("stale: {e}"));
        let again = materialise_artwork(dir.path()).unwrap_or_else(|e| panic!("rewrite: {e}"));
        assert_eq!(again, path);
        assert_eq!(std::fs::read(&path).ok().as_deref(), Some(ARTWORK_PNG));
        assert!(!dir.path().join(format!("{ARTWORK_FILE}.tmp")).exists());
    }
}
