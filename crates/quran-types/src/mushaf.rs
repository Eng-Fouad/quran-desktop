//! Mushaf pages, page fonts and decor (§5.4).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{MushafLayout, MushafStyle, SajdaKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Ayah,
    SurahName,
    Basmallah,
}

/// Download lane for page fonts: `interactive` (visible pages) or `prefetch` (background).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FetchPriority {
    Interactive,
    Prefetch,
}

/// What `mushaf_ensure_page_fonts` resolves with. It resolves only when each page is final, so there is no
/// missing/downloading state: `ready` (file on disk), `failed` (download or integrity failure; retry possible),
/// `unavailable` (network not allowed or offline, and not on disk).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FontAvailability {
    Ready,
    Failed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageWord {
    pub id: u32,
    pub ayah_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub position: u32,
    pub is_end: bool,
    /// Style glyphs: `code_v1` | `code_v2` (1–4 chars) | `text_hafs` for hafs. Render the whole string in one span.
    pub glyph: String,
    /// QPC Hafs Unicode (end marker: U+06DD + Arabic-Indic digits): fallback, copy, accessibility.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageLine {
    /// 1..=15.
    pub line: u32,
    pub kind: LineKind,
    pub centered: bool,
    /// Set on `surah_name` and `basmallah` lines.
    pub surah: Option<u32>,
    /// Empty for header lines.
    pub words: Vec<PageWord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageAyah {
    pub id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub juz: u32,
    pub hizb: u32,
    pub rub: u32,
    pub sajda: Option<SajdaKind>,
    /// `ayah.flags` bits (§3.1.2).
    pub flags: u32,
    /// First word of this ayah on this page.
    pub first_word_id: u32,
    /// Last word of this ayah on this page.
    pub last_word_id: u32,
    pub starts_on_page: bool,
    pub ends_on_page: bool,
    /// Line of `first_word_id`.
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
    /// Juz of the first ayah on the page.
    pub juz: u32,
    /// Hizb of the first ayah on the page.
    pub hizb: u32,
    /// Surah of the first ayah on the page (running head).
    pub head_surah: u32,
    /// Surahs with content on the page, in order.
    pub surah_ids: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageData {
    pub layout: MushafLayout,
    pub style: MushafStyle,
    pub page: u32,
    /// Pages 1–2: 8 lines; every other page: 15.
    pub lines: Vec<PageLine>,
    pub ayahs: Vec<PageAyah>,
    pub info: PageInfo,
}

/// Style `hafs` has no page fonts: every page returns `ready` with family `"qd-hafs"`, no url/rel and 0 bytes, without IO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageFontStatus {
    pub style: MushafStyle,
    pub page: u32,
    pub availability: FontAvailability,
    /// `"qcf-v2-p262"` (`qcf-v1-…`, `qcf-v4-…`); `"qd-hafs"` for hafs.
    pub family: String,
    /// `"<protocolBase>mushaf/v2/p262.woff2?v=<sha8>"` when ready; `null` for hafs.
    pub url: Option<String>,
    /// `"mushaf/v2/p262.woff2"` when ready: the `font_bytes` argument when `fontTransport = bytes`.
    pub rel: Option<String>,
    pub bytes: u32,
}

/// Decorative fonts (surah headers, common ligatures, surah names); URLs are set once installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DecorStatus {
    pub installed: bool,
    /// `<base>decor/qcf-surah-header.woff2?v=…` (rel `decor/qcf-surah-header.woff2`).
    pub surah_header_url: Option<String>,
    /// `<base>decor/quran-common.ttf?v=…` (rel `decor/quran-common.ttf`).
    pub quran_common_url: Option<String>,
    /// `<base>decor/sura-names.woff2?v=…` (rel `decor/sura-names.woff2`).
    pub sura_names_url: Option<String>,
}
