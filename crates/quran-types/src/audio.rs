//! Recitation playback (§5.8). Positions are `u32` milliseconds on the surah-file timeline; speed and volume are
//! integer percent.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{AppError, AyahRef, L10nText, MushafLayout, limits};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStatus {
    Idle,
    Loading,
    Buffering,
    Playing,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SkipDirection {
    Next,
    Previous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StopAt {
    EndOfSurah,
    EndOfPage,
    EndOfJuz,
    EndOfQuran,
}

/// Silence between repeated ayahs: none, a fixed `ms` (0..=30000), or `pct` (0..=300) of the ayah's own duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GapSetting {
    None,
    Fixed { ms: u32 },
    Multiplier { pct: u32 },
}

impl GapSetting {
    /// Clamps `fixed.ms` to [`limits::GAP_FIXED_MS`] and `multiplier.pct` to [`limits::GAP_MULTIPLIER_PCT`].
    #[must_use]
    pub const fn clamped(self) -> Self {
        match self {
            Self::None => Self::None,
            Self::Fixed { ms } => Self::Fixed {
                ms: limits::GAP_FIXED_MS.apply(ms),
            },
            Self::Multiplier { pct } => Self::Multiplier {
                pct: limits::GAP_MULTIPLIER_PCT.apply(pct),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SeekTarget {
    Ayah { ayah_id: u32 },
    FileMs { ms: u32 },
    RelativeMs { delta_ms: i32 },
}

/// Inclusive ayah range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahRange {
    pub from: AyahRef,
    pub to: AyahRef,
}

/// A-B loop on the file timeline; `b − a ≥ 300`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AbLoop {
    pub a_ms: u32,
    pub b_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    pub reciter_id: u32,
    /// `ayah ≥ 1`.
    pub from: AyahRef,
    /// `null` ⇒ resolved from `stopAt` (or `settings.stopAt`).
    pub to: Option<AyahRef>,
    pub stop_at: Option<StopAt>,
    /// For `end_of_page` resolution.
    pub layout: MushafLayout,
    /// 1..=99, 0 = ∞.
    pub ayah_repeat: u32,
    /// 1..=99, 0 = ∞.
    pub range_repeat: u32,
    pub gap: GapSetting,
    pub start_paused: bool,
    /// Whether the play is part of the user's listening (absent ⇒ `true`). `false` for a reciter preview (the
    /// onboarding's ▶ 1:1, §9.7): it records no listen history (§2.8.4) and is never the recitation that "play with
    /// nothing loaded" (a media key, the tray) replays.
    #[serde(default = "PlayRequest::recorded")]
    #[specta(optional)]
    pub record: bool,
}

impl PlayRequest {
    /// The `record` default: a play is part of the user's listening unless it says otherwise.
    #[must_use]
    pub const fn recorded() -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioSnapshot {
    pub status: PlaybackStatus,
    pub reciter_id: Option<u32>,
    /// `ayah = 0` during the basmala.
    pub current: Option<AyahRef>,
    pub current_ayah_id: Option<u32>,
    pub range: Option<AyahRange>,
    pub ayah_repeat: u32,
    pub ayah_repeat_left: u32,
    pub range_repeat: u32,
    pub range_repeat_left: u32,
    pub gap: GapSetting,
    pub ab_loop: Option<AbLoop>,
    pub speed_pct: u32,
    pub volume_pct: u32,
    pub file_ms: u32,
    pub file_duration_ms: u32,
    pub ayah_from_ms: u32,
    pub ayah_to_ms: u32,
    pub buffered_pct: u32,
    /// Description of the current output device.
    pub device: Option<String>,
    /// This play skipped the basmala because it was offline and not cached (§2.3.3).
    pub basmala_skipped: bool,
    pub error: Option<AppError>,
}

/// Channel payload, at most 30 Hz.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioTick {
    pub seq: u32,
    pub generation: u32,
    pub status: PlaybackStatus,
    /// `ayah`/`ayahId` are 0 during the basmala.
    pub surah: u32,
    pub ayah: u32,
    pub ayah_id: u32,
    /// Audible, latency-compensated position.
    pub file_ms: u32,
    /// 0 = none.
    pub word_pos: u32,
    pub speed_pct: u32,
    pub in_gap: bool,
    pub buffered_pct: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahChange {
    pub reciter_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub ayah_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    pub pos: u32,
    pub start_ms: u32,
    pub end_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahTiming {
    pub ayah: u32,
    pub from_ms: u32,
    pub to_ms: u32,
    pub words: Vec<WordTiming>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SurahTimings {
    pub reciter_id: u32,
    pub surah: u32,
    pub duration_ms: u32,
    pub word_level: bool,
    pub ayahs: Vec<AyahTiming>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReciterInfo {
    pub id: u32,
    pub pack_id: String,
    pub name: L10nText,
    pub style: Option<L10nText>,
    /// Catalog `wordLevel` until real timings for this reciter override it.
    pub word_level: bool,
    pub size_kib: u32,
    pub downloaded_surahs: u32,
    pub cached_surahs: u32,
}
