//! user.db fixtures for the `userdb_*`/`userlib_*` integration tests (§12.1). Owner: WP2b.
//!
//! - [`TempUserDb`]: a fresh user.db in its own temp dir (removed on drop), optionally on a pinned clock ([`T0`]).
//! - [`every_setting_changed`]: a valid `Settings` in which every field differs from its default.
//! - Row builders for presets and the pack registry, and small SQL helpers ([`count`]).

use std::path::{Path, PathBuf};

use quran_core::{InstalledPackRow, InstalledStatus, PackItemRow, UserDb};
use quran_types::{
    Accent, ChromeEffect, CopySettings, DarkVariant, DigitStyle, GapSetting, LightVariant,
    LoopPresetInput, MemoHideStyle, MotionPref, MushafStyle, OnByDefault, PackKind, PageMode,
    ReadingMode, ReferenceStyle, Settings, SidePaneFollow, SidePaneSettings, SidePaneTab,
    SidebarSettings, SidebarTab, StopAt, ThemeMode, UiLanguage,
};

/// A fixed "now" for clock-pinned tests: 2025-10-09T08:53:20Z, in Unix milliseconds.
pub const T0: i64 = 1_760_000_000_000;
/// One day in milliseconds.
pub const DAY_MS: i64 = 86_400_000;

/// A user.db in its own temp dir. Field order matters: the handle is dropped before the directory.
pub struct TempUserDb {
    pub db: UserDb,
    pub path: PathBuf,
    pub dir: tempfile::TempDir,
}

impl TempUserDb {
    /// A fresh database on the system clock.
    #[must_use]
    pub fn new() -> Self {
        let dir = super::tempdir();
        let path = dir.path().join("user.db");
        let db = UserDb::open(&path).expect("open a fresh user.db");
        Self { db, path, dir }
    }

    /// A fresh database whose clock is pinned to `now_ms`.
    #[must_use]
    pub fn at(now_ms: i64) -> Self {
        let t = Self::new();
        t.db.set_test_clock(Some(now_ms));
        t
    }

    /// Opens the same file again as a new handle (the old one stays usable: SQLite handles the two connections).
    #[must_use]
    pub fn reopen(&self) -> UserDb {
        UserDb::open(&self.path).expect("reopen user.db")
    }

    /// The temp directory.
    #[must_use]
    pub fn dir(&self) -> &Path {
        self.dir.path()
    }
}

impl Default for TempUserDb {
    fn default() -> Self {
        Self::new()
    }
}

/// `SELECT count(*) FROM {table}`.
#[must_use]
pub fn count(db: &UserDb, table: &str) -> i64 {
    db.with(|c| Ok(c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?))
        .expect("count rows")
}

/// A valid `Settings` (`validated()` is the identity on it) in which every field differs from `Settings::default()`.
#[must_use]
pub fn every_setting_changed() -> Settings {
    Settings {
        theme: ThemeMode::HighContrast,
        light_variant: LightVariant::Sepia,
        dark_variant: DarkVariant::Black,
        accent: Accent::Indigo,
        ui_language: UiLanguage::Ar,
        digits: DigitStyle::ArabicIndic,
        ui_scale_pct: 150,
        motion: MotionPref::Full,
        ink_brightness_pct: 95,
        chrome_effect: ChromeEffect::Off,
        mushaf_style: MushafStyle::QcfV2,
        page_mode: PageMode::Single,
        zoom_pct: 200,
        tajweed_colors: false,
        ornate_headers: OnByDefault(false),
        show_page_frame: false,
        show_running_heads: false,
        show_margin_markers: false,
        highlight_bookmarks: false,
        hover_highlight: false,
        ayah_action_bar: false,
        page_turn_animation: false,
        wbw_pack_id: Some("wbw.ur".into()),
        wbw_tooltip: false,
        wbw_show_transliteration: false,
        reading_mode: ReadingMode::Translation,
        translations: vec![
            "tr.ur.junagarhi".into(),
            "tr.en.saheeh".into(),
            "tr.fr.rashid".into(),
        ],
        tafsir_pack_id: Some("tafsir.en.ibn_kathir".into()),
        translation_font_pct: 175,
        translation_arabic: false,
        footnotes_inline: true,
        side_pane: SidePaneSettings {
            open: true,
            width_px: 640,
            tab: SidePaneTab::Words,
            follow: SidePaneFollow::Selection,
            auto_collapse_sidebar: false,
        },
        sidebar: SidebarSettings {
            open: false,
            width_px: 240,
            tab: SidebarTab::History,
        },
        reciter_id: 97,
        speed_pct: 75,
        volume_pct: 0,
        follow_along: false,
        word_highlight: false,
        ayah_repeat: 99,
        range_repeat: 5,
        gap: GapSetting::Fixed { ms: 2_500 },
        stop_at: StopAt::EndOfQuran,
        stream_cache_cap_mib: 20_480,
        memo_hide_style: MemoHideStyle::Blank,
        memo_reveal_on_hover: false,
        copy: CopySettings {
            include_reference: false,
            reference_style: ReferenceStyle::Arabic,
            ayah_numbers: false,
            translation_pack_id: Some("tr.ur.junagarhi".into()),
        },
        announce_recitation: true,
        close_to_tray: true,
        close_to_tray_asked: true,
        show_tray_icon: false,
        network_allowed: false,
        onboarding_done: true,
        hints_seen: vec!["page_turn".into(), "action_bar".into(), "wbw".into()],
    }
}

/// A loop preset over Ayat al-Kursi (2:255 = ayah 262) and the next two ayahs.
#[must_use]
pub fn preset_input(name: &str) -> LoopPresetInput {
    LoopPresetInput {
        id: None,
        name: name.into(),
        reciter_id: Some(7),
        from_ayah_id: 262,
        to_ayah_id: 264,
        ayah_repeat: 3,
        range_repeat: 2,
        gap: GapSetting::Multiplier { pct: 100 },
        speed_pct: 100,
    }
}

/// An `installed_pack` row as the pack manager writes it after a whole-pack install.
#[must_use]
pub fn installed_row(pack_id: &str, kind: PackKind, status: InstalledStatus) -> InstalledPackRow {
    InstalledPackRow {
        pack_id: pack_id.into(),
        kind,
        version: "1.1.2".into(),
        path: (kind == PackKind::Translation)
            .then(|| format!("translation/{pack_id}/1.1.2/pack.db")),
        status,
        bytes: 518_866,
        items_total: 1,
        items_present: u32::from(status == InstalledStatus::Installed),
        sha256: Some("0f".repeat(32)),
        source_version: Some(
            r#"{"etag":"\"abc\"","lastModified":null,"contentLength":518866}"#.into(),
        ),
        installed_at: T0,
        updated_at: T0,
        last_checked_at: None,
    }
}

/// A `pack_item` row.
#[must_use]
pub fn item_row(pack_id: &str, item: &str, pinned: bool, last_used_at: i64) -> PackItemRow {
    PackItemRow {
        pack_id: pack_id.into(),
        item: item.into(),
        bytes: 4_200_000,
        sha256: "aa".repeat(32),
        pinned,
        fetched_at: T0,
        last_used_at,
    }
}
