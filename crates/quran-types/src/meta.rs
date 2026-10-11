//! App metadata, the Quran index and the bootstrap payload (§5.3).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    AudioSnapshot, DecorStatus, MushafLayout, PackSummary, ReadingBookmark, ReadingPosition,
    ReciterInfo, Settings,
};

/// Desktop platform the app runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    /// The platform this binary was compiled for (other Unix desktops report `linux`).
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RevelationPlace {
    Makkah,
    Madinah,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SajdaKind {
    Recommended,
    Obligatory,
}

/// How QCF page and decor fonts reach `FontFace` (D30, §8.5): by `quran://` URL or by raw bytes (`font_bytes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FontTransport {
    Url,
    Bytes,
}

/// `meta` table of the bundled core.db.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoreDbInfo {
    pub schema_version: u32,
    pub normalizer_version: u32,
    /// `"qdc"` (dev builds) or `"qul"` (release builds).
    pub source: String,
    pub built_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// `"Quran"`: the bundle's `productName` (window title, taskbar, installer, tray, media flyout).
    pub name: String,
    /// `CARGO_PKG_VERSION`.
    pub version: String,
    /// `"com.quran.labs.desktop"`: the bundle identifier, also the Windows AUMID and the data directory's name.
    pub identifier: String,
    pub platform: Platform,
    /// `std::env::consts::ARCH`.
    pub arch: String,
    /// `tauri_plugin_os::version()` (D22).
    pub os_version: String,
    /// `tauri_plugin_os::locale()`; drives the first-run UI-language guess.
    pub os_locale: Option<String>,
    /// `tauri::webview_version()` or `"unknown"`.
    pub webview_version: String,
    /// App data root, dunce-simplified.
    pub data_dir: String,
    pub log_dir: String,
    /// `"http://quran.localhost/"` on Windows, `"quran://localhost/"` elsewhere. Never build pack URLs by hand.
    pub protocol_base: String,
    pub font_transport: FontTransport,
    pub debug: bool,
    /// Debug builds started with `QD_TEST=1` (D24); installs `window.__QD_TEST__`.
    pub test_mode: bool,
    pub core: CoreDbInfo,
}

/// One-time notices produced during startup and returned by `app_bootstrap`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StartupNotice {
    /// user.db was corrupt and was quarantined; a fresh one was created (§9.8 banner with "Restore from backup…").
    UserDbRecovered { quarantined_file: String },
    /// content.db was recreated; it re-syncs silently and packs may show `partial`.
    ContentDbRecovered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SurahInfo {
    pub id: u32,
    pub name_ar: String,
    pub name_simple: String,
    pub name_complex: String,
    pub name_en: String,
    pub revelation_place: RevelationPlace,
    pub revelation_order: u32,
    pub ayah_count: u32,
    pub first_ayah_id: u32,
    pub bismillah_pre: bool,
    /// Code point of the surah's glyph in the QCF surah-header font.
    pub header_cp: Option<u32>,
}

/// A juz, hizb, rub or manzil as an inclusive ayah-id range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Division {
    pub id: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SajdaInfo {
    pub id: u32,
    pub ayah_id: u32,
    pub kind: SajdaKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    pub layout: MushafLayout,
    pub pages: u32,
    pub lines_per_page: u32,
    /// Length 604; index = page − 1.
    pub page_first_ayah: Vec<u32>,
    /// Length 604; index = page − 1.
    pub page_first_word: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuranIndex {
    /// 114 entries.
    pub surahs: Vec<SurahInfo>,
    pub juz: Vec<Division>,
    pub hizb: Vec<Division>,
    pub rub: Vec<Division>,
    pub manzil: Vec<Division>,
    pub sajdas: Vec<SajdaInfo>,
    /// `v2`, `v1`, `v4`.
    pub layouts: Vec<LayoutInfo>,
    /// Length 6236; index = ayah id − 1.
    pub ayah_first_word: Vec<u32>,
}

/// Everything the frontend needs before its first paint (`app_bootstrap`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub app: AppInfo,
    pub index: QuranIndex,
    pub settings: Settings,
    pub first_run: bool,
    pub positions: Vec<ReadingPosition>,
    pub reading_bookmark: Option<ReadingBookmark>,
    pub packs: Vec<PackSummary>,
    pub reciters: Vec<ReciterInfo>,
    pub decor: DecorStatus,
    pub audio: AudioSnapshot,
    pub online: bool,
    pub notices: Vec<StartupNotice>,
}
