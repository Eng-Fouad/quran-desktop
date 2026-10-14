//! The platform-neutral media model.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::MediaSessionError;

/// Identity of the session per platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionConfig {
    /// `"com.quran.labs.desktop"` (Windows AUMID only).
    pub app_id: String,
    /// MPRIS `DesktopEntry`: the basename (no `.desktop`) of the desktop file the deb/AppImage bundler actually installs.
    /// It is read from the built .deb and pinned in `src-tauri/src/media.rs`; GNOME/KDE use it for the player's name
    /// and icon.
    pub desktop_entry: String,
    /// `"Quran"` (the bundle's `productName`): MPRIS `Identity` and the macOS/Linux display name.
    pub display_name: String,
    /// `"quran_desktop"` → `org.mpris.MediaPlayer2.quran_desktop`.
    pub dbus_name: String,
    /// Windows: raw HWND of the main window (hidden, never destroyed, on close-to-tray).
    pub hwnd: Option<isize>,
}

/// The well-known bus-name prefix of every MPRIS player.
const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
/// D-Bus limit for a whole bus name.
const DBUS_NAME_MAX: usize = 255;

impl SessionConfig {
    /// Checks what every backend relies on, before any OS call: non-empty `app_id`, `display_name` and
    /// `desktop_entry`, and a `dbus_name` that makes a valid well-known bus name after `org.mpris.MediaPlayer2.`
    /// (dot-separated elements of `[A-Za-z0-9_-]`, none empty or starting with a digit, 255 bytes at most).
    /// `hwnd` is not checked here: a missing window makes the Windows backend fall back to no-op.
    pub fn validate(&self) -> Result<(), MediaSessionError> {
        let invalid = |what: &str| Err(MediaSessionError::InvalidConfig(what.to_owned()));
        if self.app_id.trim().is_empty() {
            return invalid("empty app_id");
        }
        if self.display_name.trim().is_empty() {
            return invalid("empty display_name");
        }
        if self.desktop_entry.trim().is_empty() || self.desktop_entry.ends_with(".desktop") {
            return invalid("desktop_entry must be a non-empty basename without `.desktop`");
        }
        let element_ok = |e: &str| {
            !e.is_empty()
                && !e.starts_with(|c: char| c.is_ascii_digit())
                && e.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        };
        if !self.dbus_name.split('.').all(element_ok)
            || MPRIS_PREFIX.len() + self.dbus_name.len() > DBUS_NAME_MAX
        {
            return invalid("dbus_name is not a valid D-Bus bus-name suffix");
        }
        Ok(())
    }
}

/// macOS: runs a closure on the main thread (`AppHandle::run_on_main_thread`).
pub type MainThreadDispatch = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// A request from the OS (media keys, flyout, Now Playing, MPRIS clients).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MediaCommand {
    Play,
    Pause,
    Toggle,
    Stop,
    /// Next ayah.
    Next,
    /// Previous ayah.
    Previous,
    /// Absolute position on the surah-file timeline.
    SeekTo(Duration),
    /// Relative seek in microseconds (MPRIS `Seek`).
    SeekBy(i64),
    /// Playback rate (1.0 = normal); the app rounds it to 5 % and clamps to 0.5..=2.0. Backends only emit finite,
    /// positive rates (see [`rate_command`]).
    SetRate(f64),
    /// Bring the window to the front.
    Raise,
}

/// A rate request from the OS → [`MediaCommand::SetRate`], or `None` for a rate no player can honour (NaN, ±∞,
/// zero or negative). Every backend filters through this.
#[must_use]
pub(crate) fn rate_command(rate: f64) -> Option<MediaCommand> {
    (rate.is_finite() && rate > 0.0).then_some(MediaCommand::SetRate(rate))
}

/// What is playing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
    /// `"{surah name} {s}:{a}"` in the UI language.
    pub title: String,
    /// Reciter name in the UI language.
    pub artist: String,
    /// From the Rust string table (`src-tauri/src/i18n.rs`).
    pub album: String,
    /// Surah-file duration.
    pub duration: Option<Duration>,
    /// Falls back to the app icon.
    pub artwork_path: Option<PathBuf>,
}

/// Transport state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum Status {
    Playing,
    Paused,
    /// Nothing loaded: backends hide the session (Windows `IsEnabled = false`, macOS empty `nowPlayingInfo`, MPRIS
    /// `Stopped`).
    #[default]
    Stopped,
}

/// Transport state, position (surah-file timeline) and capabilities.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybackState {
    pub status: Status,
    pub position: Duration,
    /// The real speed while playing (1.0 = normal).
    pub rate: f64,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_seek: bool,
}

impl PlaybackState {
    /// Nothing loaded.
    pub const STOPPED: Self = Self {
        status: Status::Stopped,
        position: Duration::ZERO,
        rate: 1.0,
        can_next: false,
        can_previous: false,
        can_seek: false,
    };

    /// Playing or paused, i.e. a recitation is loaded and the OS should show the session.
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.status != Status::Stopped
    }

    /// `rate` when it is finite and positive, else 1.0 (a backend never hands the OS a NaN or a zero rate).
    #[must_use]
    pub fn effective_rate(&self) -> f64 {
        if self.rate.is_finite() && self.rate > 0.0 {
            self.rate
        } else {
            1.0
        }
    }
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self::STOPPED
    }
}

/// The backend a [`crate::MediaSession`] runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendKind {
    /// Windows `SystemMediaTransportControls` (media flyout, media keys, lock screen).
    Smtc,
    /// macOS `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`.
    NowPlaying,
    /// Linux MPRIS over D-Bus.
    Mpris,
    /// No OS integration: an unsupported platform, or the platform backend failed to start (logged).
    Noop,
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

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
    fn the_app_config_is_valid() {
        config().validate().unwrap();
        let instance = SessionConfig {
            dbus_name: "quran_desktop.instance1234".into(),
            ..config()
        };
        instance.validate().unwrap();
    }

    #[test]
    fn unusable_configs_are_rejected_before_any_os_call() {
        let cases = [
            SessionConfig {
                app_id: " ".into(),
                ..config()
            },
            SessionConfig {
                display_name: String::new(),
                ..config()
            },
            SessionConfig {
                desktop_entry: String::new(),
                ..config()
            },
            SessionConfig {
                desktop_entry: "quran-desktop.desktop".into(),
                ..config()
            },
            SessionConfig {
                dbus_name: String::new(),
                ..config()
            },
            SessionConfig {
                dbus_name: "quran desktop".into(),
                ..config()
            },
            SessionConfig {
                dbus_name: "1quran".into(),
                ..config()
            },
            SessionConfig {
                dbus_name: "quran..desktop".into(),
                ..config()
            },
            SessionConfig {
                dbus_name: "قرآن".into(),
                ..config()
            },
            SessionConfig {
                dbus_name: "a".repeat(DBUS_NAME_MAX),
                ..config()
            },
        ];
        for cfg in cases {
            assert!(
                matches!(cfg.validate(), Err(MediaSessionError::InvalidConfig(_))),
                "{cfg:?}"
            );
        }
    }

    #[test]
    fn rate_requests_are_filtered() {
        assert_eq!(rate_command(1.25), Some(MediaCommand::SetRate(1.25)));
        assert_eq!(rate_command(0.5), Some(MediaCommand::SetRate(0.5)));
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(rate_command(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_effective_rate_is_always_usable() {
        let state = |rate| PlaybackState {
            rate,
            ..PlaybackState::STOPPED
        };
        assert!((state(1.5).effective_rate() - 1.5).abs() < f64::EPSILON);
        for bad in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            assert!((state(bad).effective_rate() - 1.0).abs() < f64::EPSILON);
        }
    }

    #[test]
    fn only_playing_and_paused_are_active() {
        let state = |status| PlaybackState {
            status,
            ..PlaybackState::STOPPED
        };
        assert!(state(Status::Playing).is_active());
        assert!(state(Status::Paused).is_active());
        assert!(!state(Status::Stopped).is_active());
        assert!(!PlaybackState::default().is_active());
    }
}
