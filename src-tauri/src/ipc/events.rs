//! Typed, low-frequency events (§5.14). Names are tauri-specta's default kebab-case of the type name
//! (`AudioStateChanged` → `"audio-state-changed"`); TS: `events.audioStateChanged.listen(e => …)`. Streams go through
//! `Channel`s instead (`audio_subscribe`, `packs_subscribe`).

use quran_types::{AudioSnapshot, AyahChange, NavTarget, Settings, UserDataKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// `"audio-state-changed"`: status, ayah, repeat, speed, volume, A-B or error changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct AudioStateChanged(pub AudioSnapshot);

/// `"audio-ayah-changed"`: the exact marker edge of a new ayah (or the basmala, `ayah = 0`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct AudioAyahChanged(pub AyahChange);

/// `"packs-changed"`: installed state of these packs changed (install, remove, update, clear cache).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PacksChanged {
    pub pack_ids: Vec<String>,
}

/// `"settings-changed"`: the validated settings after `settings_set`/`settings_reset`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct SettingsChanged(pub Settings);

/// `"user-data-changed"`: emitted by every mutating library/study command except `position_set`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UserDataChanged {
    pub kinds: Vec<UserDataKind>,
}

/// `"navigate-requested"`: tray, single-instance argv, deep link (stretch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct NavigateRequested(pub NavTarget);

/// `"network-changed"`: reachability or `networkAllowed` changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct NetworkChanged {
    pub online: bool,
}

/// `"quit-requested"`: the user quit (the window's close button, the tray's Quit, the close question's Quit, a close
/// from the taskbar). The window is already hidden; the page saves what it still holds (its debounced writes) and calls
/// `app_quit`. If it does not within 1.5 s, the app exits anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct QuitRequested;
