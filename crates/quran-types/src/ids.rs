//! Ids, references, layouts and styles (§0.2, §5.3).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Ayah id in canonical Hafs order, `1..=6236`.
pub type AyahId = u32;
/// Our own sequential word id in (surah, ayah, position) order, end markers included, `1..=83665`.
pub type WordId = u32;
/// Unix time in seconds (every `*_at` field over IPC).
pub type UnixSecs = u32;

/// Number of ayahs in the Quran (largest [`AyahId`]).
pub const AYAH_COUNT: u32 = 6236;
/// Number of words including end markers (largest [`WordId`]).
pub const WORD_COUNT: u32 = 83_665;
/// Number of surahs.
pub const SURAH_COUNT: u32 = 114;
/// Number of pages in every supported layout.
pub const PAGE_COUNT: u32 = 604;
/// Number of juz.
pub const JUZ_COUNT: u32 = 30;

/// A `(surah, ayah)` pair. `ayah = 0` means the basmala before `surah` (audio only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahRef {
    pub surah: u32,
    pub ayah: u32,
}

/// Page and line geometry. DB `mushaf_id` 1 (`v2`), 2 (`v1`) and 19 (`v4`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MushafLayout {
    V2,
    V1,
    V4,
}

impl MushafLayout {
    /// Every layout, in `QuranIndex.layouts` order.
    pub const ALL: [Self; 3] = [Self::V2, Self::V1, Self::V4];

    /// The core.db `mushaf_id` of this layout.
    #[must_use]
    pub const fn db_id(self) -> u32 {
        match self {
            Self::V2 => 1,
            Self::V1 => 2,
            Self::V4 => 19,
        }
    }

    /// Inverse of [`Self::db_id`].
    #[must_use]
    pub const fn from_db_id(id: u32) -> Option<Self> {
        match id {
            1 => Some(Self::V2),
            2 => Some(Self::V1),
            19 => Some(Self::V4),
            _ => None,
        }
    }
}

/// A glyph source plus a layout: hafs→v2, qcf_v2→v2, qcf_v1→v1, qcf_v4→v4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MushafStyle {
    Hafs,
    QcfV2,
    QcfV1,
    QcfV4,
}

impl MushafStyle {
    /// Every style.
    pub const ALL: [Self; 4] = [Self::Hafs, Self::QcfV2, Self::QcfV1, Self::QcfV4];

    /// The layout every page and line query for this style is keyed by (FACT C1, C4).
    #[must_use]
    pub const fn layout(self) -> MushafLayout {
        match self {
            Self::Hafs | Self::QcfV2 => MushafLayout::V2,
            Self::QcfV1 => MushafLayout::V1,
            Self::QcfV4 => MushafLayout::V4,
        }
    }

    /// Which glyph column the page query selects: 0 = `text_hafs`, 1 = `code_v1`, 2 = `code_v2` (V2 and V4 share codes).
    #[must_use]
    pub const fn glyph_selector(self) -> u8 {
        match self {
            Self::Hafs => 0,
            Self::QcfV1 => 1,
            Self::QcfV2 | Self::QcfV4 => 2,
        }
    }
}

/// A string in both UI languages.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct L10nText {
    pub en: String,
    pub ar: String,
}

/// Text direction of a content pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TextDir {
    Ltr,
    Rtl,
}
