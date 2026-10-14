//! Typed settings. Every field is camelCase over IPC (`pageTurnAnimation`, `sidePane.autoCollapseSidebar`);
//! user.db keys are the snake_case Rust names from `SETTING_FIELDS` (quran-core).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{GapSetting, MushafStyle, ReferenceStyle, StopAt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    System,
    Paper,
    Sepia,
    Night,
    Black,
    HighContrast,
}

/// What `system` resolves to when the OS is dark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DarkVariant {
    Night,
    Black,
}

/// What `system` resolves to when the OS is light.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LightVariant {
    Paper,
    Sepia,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Accent {
    Teal,
    Emerald,
    Blue,
    Indigo,
    Rose,
    Amber,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UiLanguage {
    En,
    Ar,
}

impl UiLanguage {
    /// First-run guess from `AppInfo.osLocale`: `ar` when the locale's primary language subtag is `ar`
    /// (`ar`, `ar-SA`, `ar_EG`, …), otherwise `en`.
    #[must_use]
    pub fn from_os_locale(locale: Option<&str>) -> Self {
        let primary = locale
            .and_then(|l| l.split(['-', '_']).next())
            .unwrap_or_default();
        if primary.eq_ignore_ascii_case("ar") {
            Self::Ar
        } else {
            Self::En
        }
    }
}

/// `auto` = Arabic-Indic digits when the UI language is Arabic, Latin otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DigitStyle {
    Auto,
    Latin,
    ArabicIndic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MotionPref {
    System,
    Reduce,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChromeEffect {
    Auto,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PageMode {
    Auto,
    Single,
    Spread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReadingMode {
    Mushaf,
    Translation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SidePaneTab {
    Translation,
    Tafsir,
    Notes,
    Words,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SidePaneFollow {
    Selection,
    SelectionOrAudio,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SidebarTab {
    Index,
    Search,
    Bookmarks,
    Highlights,
    Notes,
    History,
    Memorize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MemoHideStyle {
    Blur,
    Blank,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SidePaneSettings {
    pub open: bool,
    /// 320..=640.
    pub width_px: u32,
    pub tab: SidePaneTab,
    pub follow: SidePaneFollow,
    /// Collapse the sidebar while the pane is open if that lets the pane dock.
    pub auto_collapse_sidebar: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSettings {
    pub open: bool,
    /// 240..=420.
    pub width_px: u32,
    pub tab: SidebarTab,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CopySettings {
    pub include_reference: bool,
    pub reference_style: ReferenceStyle,
    pub ayah_numbers: bool,
    pub translation_pack_id: Option<String>,
}

/// A `bool` setting added in a later version that reads as `true` when a `Settings` leaves it
/// out (an older frontend's `settings_set`). `#[serde(default)]` would do the same, but specta-serde exports a
/// defaulted field as optional (`ornateHeaders?: boolean`); with this type and `#[specta(type = bool)]` on the field,
/// `bindings.ts` keeps it a required `boolean` like every other setting. A missing field reaches `deserialize_option`
/// (serde's missing-field path) and reads as `None`, as `null` does; both mean `true`. On the wire it is a plain bool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct OnByDefault(pub bool);

impl<'de> Deserialize<'de> for OnByDefault {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<bool>::deserialize(deserializer).map(|on| Self(on.unwrap_or(true)))
    }
}

/// All user preferences. `Settings::default()` holds the defaults below; `Settings::validated()` clamps every range,
/// rounds stepped values, and dedupes/truncates the lists. The ranges live in [`limits`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    // ---- appearance
    /// Default `system`.
    pub theme: ThemeMode,
    /// Default `paper`.
    pub light_variant: LightVariant,
    /// Default `night`.
    pub dark_variant: DarkVariant,
    /// Default `teal`.
    pub accent: Accent,
    /// Default `en`; first run guesses from the OS locale.
    pub ui_language: UiLanguage,
    /// Default `auto`.
    pub digits: DigitStyle,
    /// 100 (80..=200, step 10): webview zoom applied from Rust.
    pub ui_scale_pct: u32,
    /// Default `system`.
    pub motion: MotionPref,
    /// 88 (65..=100; night/black only).
    pub ink_brightness_pct: u32,
    /// Default `auto`.
    pub chrome_effect: ChromeEffect,
    // ---- mushaf
    /// Default `hafs` (a first-run onboarding preselects `qcf_v2`; offline, or never finished, it stays `hafs`).
    pub mushaf_style: MushafStyle,
    /// Default `auto`.
    pub page_mode: PageMode,
    /// 100 (50..=300, step 10; 100 = fit to height).
    pub zoom_pct: u32,
    /// Default true (qcf_v4: palettes 0–2 vs 3–5).
    pub tajweed_colors: bool,
    /// Default true: the surah headers, the basmala and the juz and hizb signs are drawn in the `decor` calligraphy once
    /// it is installed, in every style; off draws the plain cartouche, and a QCF style no longer fetches `decor` by
    /// itself. Added in a later version: absent in an older frontend's `settings_set` ⇒ true ([`OnByDefault`]).
    #[specta(type = bool)]
    pub ornate_headers: OnByDefault,
    pub show_page_frame: bool,
    pub show_running_heads: bool,
    pub show_margin_markers: bool,
    /// Show bookmark, note and reading-bookmark marks in the margin.
    pub highlight_bookmarks: bool,
    pub hover_highlight: bool,
    /// Default true (false = click only selects).
    pub ayah_action_bar: bool,
    pub page_turn_animation: bool,
    pub wbw_pack_id: Option<String>,
    pub wbw_tooltip: bool,
    pub wbw_show_transliteration: bool,
    // ---- reading mode, translations, side pane, sidebar
    /// Default `mushaf`.
    pub reading_mode: ReadingMode,
    /// Ordered pack ids, at most 5.
    pub translations: Vec<String>,
    pub tafsir_pack_id: Option<String>,
    /// 100 (80..=200).
    pub translation_font_pct: u32,
    pub translation_arabic: bool,
    pub footnotes_inline: bool,
    pub side_pane: SidePaneSettings,
    pub sidebar: SidebarSettings,
    // ---- audio
    /// Default 7 (Mishary Alafasy).
    pub reciter_id: u32,
    /// 100 (50..=200, step 5).
    pub speed_pct: u32,
    /// 100 (0..=100).
    pub volume_pct: u32,
    pub follow_along: bool,
    pub word_highlight: bool,
    /// 1 (0..=99, 0 = ∞).
    pub ayah_repeat: u32,
    /// 1 (0..=99, 0 = ∞).
    pub range_repeat: u32,
    /// Default `none`.
    pub gap: GapSetting,
    /// Default `end_of_surah`.
    pub stop_at: StopAt,
    /// 2048 (256..=20480).
    pub stream_cache_cap_mib: u32,
    // ---- memorisation
    /// Default `blur`.
    pub memo_hide_style: MemoHideStyle,
    pub memo_reveal_on_hover: bool,
    // ---- copy
    pub copy: CopySettings,
    // ---- system
    /// Screen-reader live announcements on ayah change. Default false.
    pub announce_recitation: bool,
    /// Default false.
    pub close_to_tray: bool,
    /// Set by the first-close-during-playback dialog; never asked again. Default false.
    pub close_to_tray_asked: bool,
    pub show_tray_icon: bool,
    /// Default true (onboarding offers "work offline").
    pub network_allowed: bool,
    /// Default false.
    pub onboarding_done: bool,
    /// One-time hint chips already shown: `"page_turn"`, `"action_bar"`, …
    pub hints_seen: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            light_variant: LightVariant::Paper,
            dark_variant: DarkVariant::Night,
            accent: Accent::Teal,
            ui_language: UiLanguage::En,
            digits: DigitStyle::Auto,
            ui_scale_pct: 100,
            motion: MotionPref::System,
            ink_brightness_pct: 88,
            chrome_effect: ChromeEffect::Auto,
            mushaf_style: MushafStyle::Hafs,
            page_mode: PageMode::Auto,
            zoom_pct: 100,
            tajweed_colors: true,
            ornate_headers: OnByDefault(true),
            show_page_frame: true,
            show_running_heads: true,
            show_margin_markers: true,
            highlight_bookmarks: true,
            hover_highlight: true,
            ayah_action_bar: true,
            page_turn_animation: true,
            wbw_pack_id: None,
            wbw_tooltip: true,
            wbw_show_transliteration: true,
            reading_mode: ReadingMode::Mushaf,
            translations: Vec::new(),
            tafsir_pack_id: None,
            translation_font_pct: 100,
            translation_arabic: true,
            footnotes_inline: false,
            side_pane: SidePaneSettings {
                open: false,
                width_px: 400,
                tab: SidePaneTab::Translation,
                follow: SidePaneFollow::SelectionOrAudio,
                auto_collapse_sidebar: true,
            },
            sidebar: SidebarSettings {
                open: true,
                width_px: 300,
                tab: SidebarTab::Index,
            },
            reciter_id: 7,
            speed_pct: 100,
            volume_pct: 100,
            follow_along: true,
            word_highlight: true,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            stop_at: StopAt::EndOfSurah,
            stream_cache_cap_mib: 2048,
            memo_hide_style: MemoHideStyle::Blur,
            memo_reveal_on_hover: true,
            copy: CopySettings {
                include_reference: true,
                reference_style: ReferenceStyle::Long,
                ayah_numbers: true,
                translation_pack_id: None,
            },
            announce_recitation: false,
            close_to_tray: false,
            close_to_tray_asked: false,
            show_tray_icon: true,
            network_allowed: true,
            onboarding_done: false,
            hints_seen: Vec::new(),
        }
    }
}

impl Settings {
    /// Returns the settings with every value made valid: ranges clamped, stepped values rounded to the nearest step,
    /// `translations` deduped (first occurrence wins) and truncated to [`limits::MAX_TRANSLATIONS`], `hints_seen`
    /// deduped, the gap clamped, and empty pack ids turned into `None`/dropped. Idempotent.
    #[must_use]
    pub fn validated(mut self) -> Self {
        use limits::*;
        self.ui_scale_pct = UI_SCALE_PCT.apply(self.ui_scale_pct);
        self.ink_brightness_pct = INK_BRIGHTNESS_PCT.apply(self.ink_brightness_pct);
        self.zoom_pct = ZOOM_PCT.apply(self.zoom_pct);
        self.translation_font_pct = TRANSLATION_FONT_PCT.apply(self.translation_font_pct);
        self.side_pane.width_px = SIDE_PANE_WIDTH_PX.apply(self.side_pane.width_px);
        self.sidebar.width_px = SIDEBAR_WIDTH_PX.apply(self.sidebar.width_px);
        self.speed_pct = SPEED_PCT.apply(self.speed_pct);
        self.volume_pct = VOLUME_PCT.apply(self.volume_pct);
        self.ayah_repeat = REPEAT.apply(self.ayah_repeat);
        self.range_repeat = REPEAT.apply(self.range_repeat);
        self.gap = self.gap.clamped();
        self.stream_cache_cap_mib = STREAM_CACHE_CAP_MIB.apply(self.stream_cache_cap_mib);
        self.translations = dedupe_non_empty(self.translations, MAX_TRANSLATIONS);
        self.hints_seen = dedupe_non_empty(self.hints_seen, usize::MAX);
        self.wbw_pack_id = non_empty(self.wbw_pack_id);
        self.tafsir_pack_id = non_empty(self.tafsir_pack_id);
        self.copy.translation_pack_id = non_empty(self.copy.translation_pack_id);
        self
    }
}

/// Keeps the first occurrence of each non-blank string, in order, up to `max` items.
fn dedupe_non_empty(items: Vec<String>, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(items.len().min(max));
    for item in items {
        if out.len() >= max {
            break;
        }
        if !item.trim().is_empty() && !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn non_empty(id: Option<String>) -> Option<String> {
    id.filter(|s| !s.trim().is_empty())
}

/// Valid ranges of the numeric settings (and of the commands that take the same values, e.g. `audio_set_speed`).
pub mod limits {
    /// An inclusive integer range with a step.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct Bounds {
        pub min: u32,
        pub max: u32,
        /// 1 = any integer.
        pub step: u32,
    }

    impl Bounds {
        #[must_use]
        pub const fn new(min: u32, max: u32, step: u32) -> Self {
            Self { min, max, step }
        }

        /// Clamps `v` into `min..=max`, then rounds it to the nearest `min + k·step` (ties round up), never past `max`.
        #[must_use]
        pub const fn apply(self, v: u32) -> u32 {
            let v = if v < self.min {
                self.min
            } else if v > self.max {
                self.max
            } else {
                v
            };
            if self.step <= 1 {
                return v;
            }
            // v ≥ min here, and every operand is ≤ max, so nothing overflows.
            let offset = v - self.min;
            let rounded = self.min + (offset + self.step / 2) / self.step * self.step;
            if rounded > self.max {
                self.max
            } else {
                rounded
            }
        }

        #[must_use]
        pub const fn contains(self, v: u32) -> bool {
            v >= self.min
                && v <= self.max
                && (self.step <= 1 || (v - self.min).is_multiple_of(self.step))
        }
    }

    /// `uiScalePct`: 80..=200, step 10 (webview zoom).
    pub const UI_SCALE_PCT: Bounds = Bounds::new(80, 200, 10);
    /// `inkBrightnessPct`: 65..=100.
    pub const INK_BRIGHTNESS_PCT: Bounds = Bounds::new(65, 100, 1);
    /// `zoomPct`: 50..=300, step 10.
    pub const ZOOM_PCT: Bounds = Bounds::new(50, 300, 10);
    /// `translationFontPct`: 80..=200.
    pub const TRANSLATION_FONT_PCT: Bounds = Bounds::new(80, 200, 1);
    /// `sidePane.widthPx`: 320..=640.
    pub const SIDE_PANE_WIDTH_PX: Bounds = Bounds::new(320, 640, 1);
    /// `sidebar.widthPx`: 240..=420.
    pub const SIDEBAR_WIDTH_PX: Bounds = Bounds::new(240, 420, 1);
    /// `speedPct`: 50..=200, step 5.
    pub const SPEED_PCT: Bounds = Bounds::new(50, 200, 5);
    /// `volumePct`: 0..=100.
    pub const VOLUME_PCT: Bounds = Bounds::new(0, 100, 1);
    /// `ayahRepeat` / `rangeRepeat`: 0..=99, 0 = ∞.
    pub const REPEAT: Bounds = Bounds::new(0, 99, 1);
    /// `gap` fixed: 0..=30000 ms.
    pub const GAP_FIXED_MS: Bounds = Bounds::new(0, 30_000, 1);
    /// `gap` multiplier: 0..=300 % of the ayah's duration.
    pub const GAP_MULTIPLIER_PCT: Bounds = Bounds::new(0, 300, 1);
    /// `streamCacheCapMib`: 256..=20480.
    pub const STREAM_CACHE_CAP_MIB: Bounds = Bounds::new(256, 20_480, 1);
    /// Maximum number of translations shown side by side.
    pub const MAX_TRANSLATIONS: usize = 5;
}
