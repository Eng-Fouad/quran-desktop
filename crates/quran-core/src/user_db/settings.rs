//! Settings persisted per top-level field, keyed by the snake_case Rust field name from the explicit `SETTING_FIELDS`
//! table (§3.2, §0.2). Owner: WP2b.
//!
//! - One `setting` row per top-level `Settings` field; `value` is the serde_json of that field (nested structs are one
//!   JSON object, camelCase inside like over IPC). Keys never depend on the camelCase serde rename of the field.
//! - **Sparse storage.** A missing row means "the default". A save writes a key only when its value differs from the
//!   effective stored value (the row, or the default when there is no row), so fields the user never touched follow
//!   future default changes, and an unchanged save writes nothing.
//! - **Tolerant load.** Unknown keys are ignored; a missing key, or one that fails to deserialise, falls back to the
//!   `Settings::default()` value of that field (invalid rows are logged at warn; missing ones are normal). The loaded value
//!   is `validated()`, so a value stored under older limits is clamped on the way in.

use std::collections::HashMap;

use quran_types::Settings;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::UserDb;
use crate::Result;

/// One top-level `Settings` field: its user.db key (the snake_case Rust name) and its (de)serialiser pair.
#[derive(Clone, Copy)]
pub struct SettingField {
    /// The `setting.key` (the Rust field name).
    pub key: &'static str,
    /// The field as JSON.
    pub get: fn(&Settings) -> serde_json::Result<Value>,
    /// Replaces the field from JSON; on error the field is left unchanged.
    pub set: fn(&mut Settings, Value) -> serde_json::Result<()>,
}

impl std::fmt::Debug for SettingField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingField")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

/// Builds [`SETTING_FIELDS`] and, for the tests, an exhaustive destructuring of `Settings` from the same list, so a
/// field added to `Settings` without a row here fails to compile.
macro_rules! setting_fields {
    ($($field:ident),+ $(,)?) => {
        /// Every top-level `Settings` field exactly once, in declaration order (§3.2).
        pub const SETTING_FIELDS: &[SettingField] = &[$(
            SettingField {
                key: stringify!($field),
                get: |s| serde_json::to_value(&s.$field),
                set: |s, v| {
                    s.$field = serde_json::from_value(v)?;
                    Ok(())
                },
            }
        ),+];

        #[cfg(test)]
        #[allow(dead_code)]
        fn exhaustive(s: Settings) {
            let Settings { $($field: _),+ } = s;
        }
    };
}

setting_fields![
    theme,
    light_variant,
    dark_variant,
    accent,
    ui_language,
    digits,
    ui_scale_pct,
    motion,
    ink_brightness_pct,
    chrome_effect,
    mushaf_style,
    page_mode,
    zoom_pct,
    tajweed_colors,
    show_page_frame,
    show_running_heads,
    show_margin_markers,
    highlight_bookmarks,
    hover_highlight,
    ayah_action_bar,
    page_turn_animation,
    wbw_pack_id,
    wbw_tooltip,
    wbw_show_transliteration,
    reading_mode,
    translations,
    tafsir_pack_id,
    translation_font_pct,
    translation_arabic,
    footnotes_inline,
    side_pane,
    sidebar,
    reciter_id,
    speed_pct,
    volume_pct,
    follow_along,
    word_highlight,
    ayah_repeat,
    range_repeat,
    gap,
    stop_at,
    stream_cache_cap_mib,
    memo_hide_style,
    memo_reveal_on_hover,
    copy,
    announce_recitation,
    close_to_tray,
    close_to_tray_asked,
    show_tray_icon,
    network_allowed,
    onboarding_done,
    hints_seen,
];

/// Keys that `settings_reset` keeps: they record the user's language and what the app has already shown or asked
/// (onboarding, one-time hints, the close-to-tray question), not preferences. Resetting them would re-run onboarding,
/// replay every hint and switch the UI language under the user.
pub const RESET_PRESERVED_KEYS: &[&str] = &[
    "ui_language",
    "onboarding_done",
    "hints_seen",
    "close_to_tray_asked",
];

/// The `setting` table as `key → raw JSON text`.
fn stored_rows(c: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = c.prepare_cached("SELECT key, value FROM setting")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(rows)
}

/// The effective settings for a set of stored rows (defaults for missing or invalid keys), validated.
fn settings_from_rows(rows: &HashMap<String, String>) -> Settings {
    let mut settings = Settings::default();
    let mut missing = 0_usize;
    for field in SETTING_FIELDS {
        let Some(text) = rows.get(field.key) else {
            missing += 1;
            continue;
        };
        if let Err(e) =
            serde_json::from_str::<Value>(text).and_then(|v| (field.set)(&mut settings, v))
        {
            log::warn!("setting {}: {e}; using the default", field.key);
        }
    }
    if missing > 0 {
        log::trace!(
            "settings: {missing} of {} keys at their defaults",
            SETTING_FIELDS.len()
        );
    }
    settings.validated()
}

/// Writes every field of `next` whose JSON differs from the effective stored value; returns the number of rows written.
fn write_changed(
    c: &Connection,
    rows: &HashMap<String, String>,
    next: &Settings,
    now_ms: i64,
) -> Result<u32> {
    let defaults = Settings::default();
    let mut upsert = c.prepare_cached(
        "INSERT INTO setting (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )?;
    let mut written = 0;
    for field in SETTING_FIELDS {
        let value = (field.get)(next)?;
        let unchanged = match rows.get(field.key) {
            // Compare parsed JSON, so formatting never counts as a change; an unparsable row is always rewritten.
            Some(text) => serde_json::from_str::<Value>(text).is_ok_and(|stored| stored == value),
            None => (field.get)(&defaults)? == value,
        };
        if !unchanged {
            upsert.execute(params![field.key, value.to_string(), now_ms])?;
            written += 1;
        }
    }
    Ok(written)
}

impl UserDb {
    /// Missing or invalid keys fall back to the `Settings::default()` value of that field (logged at warn).
    pub fn settings_load(&self) -> Result<Settings> {
        self.with(|c| Ok(settings_from_rows(&stored_rows(c)?)))
    }

    /// Validates `next` (`Settings::validated`) and writes the changed keys only; returns what was stored.
    pub fn settings_save(&self, next: &Settings) -> Result<Settings> {
        self.settings_replace(next).map(|(_, stored)| stored)
    }

    /// [`Self::settings_save`] that also returns the settings in effect before the write: `(previous, stored)`, read and
    /// written in one transaction, so the side-effect hooks of `settings_set` always see a consistent pair.
    pub fn settings_replace(&self, next: &Settings) -> Result<(Settings, Settings)> {
        let next = next.clone().validated();
        let now = self.now_ms();
        self.with_tx(|tx| {
            let rows = stored_rows(tx)?;
            let previous = settings_from_rows(&rows);
            let written = write_changed(tx, &rows, &next, now)?;
            if written > 0 {
                log::debug!("settings: {written} key(s) written");
            }
            Ok((previous, next))
        })
    }

    /// A read-modify-write in one transaction: `edit` changes a copy of the stored settings, which is then validated
    /// and written like [`Self::settings_replace`] (changed keys only). Returns `(previous, stored)`. Use it when a
    /// writer changes a few fields: a full `Settings` read earlier and written later would undo any write in between.
    pub fn settings_edit(&self, edit: impl FnOnce(&mut Settings)) -> Result<(Settings, Settings)> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let rows = stored_rows(tx)?;
            let previous = settings_from_rows(&rows);
            let mut next = previous.clone();
            edit(&mut next);
            let next = next.validated();
            let written = write_changed(tx, &rows, &next, now)?;
            if written > 0 {
                log::debug!("settings: {written} key(s) written");
            }
            Ok((previous, next))
        })
    }

    /// Resets every preference to its default, keeping [`RESET_PRESERVED_KEYS`]. Returns `(previous, current)`.
    /// Deletes the other rows (sparse storage: no row = default), so the reset fields follow future default changes.
    pub fn settings_reset(&self) -> Result<(Settings, Settings)> {
        self.with_tx(|tx| {
            let rows = stored_rows(tx)?;
            let previous = settings_from_rows(&rows);
            let mut delete = tx.prepare_cached("DELETE FROM setting WHERE key = ?1")?;
            for key in rows.keys() {
                if !RESET_PRESERVED_KEYS.contains(&key.as_str()) {
                    delete.execute([key])?;
                }
            }
            let kept: HashMap<String, String> = rows
                .into_iter()
                .filter(|(k, _)| RESET_PRESERVED_KEYS.contains(&k.as_str()))
                .collect();
            Ok((previous, settings_from_rows(&kept)))
        })
    }

    /// True until `onboarding_done` is set (a missing or unreadable row counts as not done).
    pub fn first_run(&self) -> Result<bool> {
        let stored: Option<String> = self.with(|c| {
            Ok(
                c.prepare_cached("SELECT value FROM setting WHERE key = 'onboarding_done'")?
                    .query_row([], |r| r.get(0))
                    .optional()?,
            )
        })?;
        let done = stored.is_some_and(|text| serde_json::from_str::<bool>(&text).unwrap_or(false));
        Ok(!done)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::collections::HashSet;

    use quran_types::{
        Accent, ChromeEffect, CopySettings, DarkVariant, DigitStyle, GapSetting, LightVariant,
        MemoHideStyle, MotionPref, MushafStyle, PageMode, ReadingMode, ReferenceStyle,
        SidePaneFollow, SidePaneSettings, SidePaneTab, SidebarSettings, SidebarTab, StopAt,
        ThemeMode, UiLanguage,
    };

    use super::*;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        (dir, db)
    }

    fn snake_to_camel(key: &str) -> String {
        let mut out = String::new();
        let mut upper = false;
        for ch in key.chars() {
            if ch == '_' {
                upper = true;
            } else if upper {
                out.extend(ch.to_uppercase());
                upper = false;
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// Every field differs from its default.
    fn all_changed() -> Settings {
        Settings {
            theme: ThemeMode::Sepia,
            light_variant: LightVariant::Sepia,
            dark_variant: DarkVariant::Black,
            accent: Accent::Rose,
            ui_language: UiLanguage::Ar,
            digits: DigitStyle::Latin,
            ui_scale_pct: 120,
            motion: MotionPref::Reduce,
            ink_brightness_pct: 70,
            chrome_effect: ChromeEffect::Off,
            mushaf_style: MushafStyle::QcfV4,
            page_mode: PageMode::Spread,
            zoom_pct: 150,
            tajweed_colors: false,
            show_page_frame: false,
            show_running_heads: false,
            show_margin_markers: false,
            highlight_bookmarks: false,
            hover_highlight: false,
            ayah_action_bar: false,
            page_turn_animation: false,
            wbw_pack_id: Some("wbw.en".into()),
            wbw_tooltip: false,
            wbw_show_transliteration: false,
            reading_mode: ReadingMode::Translation,
            translations: vec!["tr.en.saheeh".into(), "tr.ur.junagarhi".into()],
            tafsir_pack_id: Some("tafsir.ar.muyassar".into()),
            translation_font_pct: 130,
            translation_arabic: false,
            footnotes_inline: true,
            side_pane: SidePaneSettings {
                open: true,
                width_px: 500,
                tab: SidePaneTab::Tafsir,
                follow: SidePaneFollow::Pinned,
                auto_collapse_sidebar: false,
            },
            sidebar: SidebarSettings {
                open: false,
                width_px: 360,
                tab: SidebarTab::Memorize,
            },
            reciter_id: 5,
            speed_pct: 125,
            volume_pct: 40,
            follow_along: false,
            word_highlight: false,
            ayah_repeat: 3,
            range_repeat: 0,
            gap: GapSetting::Multiplier { pct: 150 },
            stop_at: StopAt::EndOfJuz,
            stream_cache_cap_mib: 4096,
            memo_hide_style: MemoHideStyle::Blank,
            memo_reveal_on_hover: false,
            copy: CopySettings {
                include_reference: false,
                reference_style: ReferenceStyle::Short,
                ayah_numbers: false,
                translation_pack_id: Some("tr.en.saheeh".into()),
            },
            announce_recitation: true,
            close_to_tray: true,
            close_to_tray_asked: true,
            show_tray_icon: false,
            network_allowed: false,
            onboarding_done: true,
            hints_seen: vec!["page_turn".into(), "action_bar".into()],
        }
    }

    fn row_count(db: &UserDb) -> i64 {
        db.with(|c| Ok(c.query_row("SELECT count(*) FROM setting", [], |r| r.get(0))?))
            .unwrap()
    }

    #[test]
    fn the_table_covers_every_field_exactly_once() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(
            SETTING_FIELDS.len(),
            object.len(),
            "one SETTING_FIELDS row per Settings field"
        );
        let keys: HashSet<&str> = SETTING_FIELDS.iter().map(|f| f.key).collect();
        assert_eq!(keys.len(), SETTING_FIELDS.len(), "keys are unique");
        for field in SETTING_FIELDS {
            assert!(
                field
                    .key
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_'),
                "{} is snake_case",
                field.key
            );
            let camel = snake_to_camel(field.key);
            assert_eq!(
                Some(&(field.get)(&Settings::default()).unwrap()),
                object.get(&camel),
                "{} reads the field serialised as {camel}",
                field.key
            );
        }
        for key in RESET_PRESERVED_KEYS {
            assert!(keys.contains(key), "{key} is a settings key");
        }
    }

    #[test]
    fn every_field_round_trips_through_its_row() {
        let changed = all_changed();
        assert_eq!(
            changed.clone().validated(),
            changed,
            "the fixture is already valid"
        );
        for field in SETTING_FIELDS {
            let value = (field.get)(&changed).unwrap();
            assert_ne!(
                value,
                (field.get)(&Settings::default()).unwrap(),
                "{} differs from its default",
                field.key
            );
            let mut s = Settings::default();
            (field.set)(&mut s, value.clone()).unwrap();
            assert_eq!((field.get)(&s).unwrap(), value, "{}", field.key);
        }
    }

    #[test]
    fn a_fresh_db_loads_the_defaults_and_is_first_run() {
        let (_dir, db) = temp_db();
        assert_eq!(db.settings_load().unwrap(), Settings::default());
        assert!(db.first_run().unwrap());
        assert_eq!(row_count(&db), 0);
    }

    #[test]
    fn saving_writes_only_changed_keys_and_round_trips() {
        let (_dir, db) = temp_db();
        // Saving the defaults writes nothing (sparse storage).
        assert_eq!(
            db.settings_save(&Settings::default()).unwrap(),
            Settings::default()
        );
        assert_eq!(row_count(&db), 0);

        let mut next = Settings {
            theme: ThemeMode::Night,
            ..Settings::default()
        };
        next.side_pane.width_px = 480;
        db.set_test_clock(Some(5_000));
        let (prev, stored) = db.settings_replace(&next).unwrap();
        assert_eq!(prev, Settings::default());
        assert_eq!(stored, next);
        assert_eq!(row_count(&db), 2);
        let rows: Vec<(String, String, i64)> = db
            .with(|c| {
                Ok(
                    c.prepare("SELECT key, value, updated_at FROM setting ORDER BY key")?
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                        .collect::<rusqlite::Result<_>>()?,
                )
            })
            .unwrap();
        assert_eq!(rows[0].0, "side_pane", "keys are the snake_case Rust names");
        assert!(
            rows[0].1.contains("\"widthPx\":480"),
            "nested values keep the IPC casing: {}",
            rows[0].1
        );
        assert_eq!(rows[1], ("theme".into(), "\"night\"".into(), 5_000));

        // An unchanged save keeps updated_at.
        db.set_test_clock(Some(9_000));
        db.settings_save(&next).unwrap();
        let theme_at: i64 = db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT updated_at FROM setting WHERE key = 'theme'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(theme_at, 5_000);

        // Back to the default value: the row stays (an explicit choice), with the default value.
        next.theme = ThemeMode::System;
        db.settings_save(&next).unwrap();
        assert_eq!(db.settings_load().unwrap(), next);

        let everything = all_changed();
        assert_eq!(db.settings_save(&everything).unwrap(), everything);
        assert_eq!(db.settings_load().unwrap(), everything);
        assert_eq!(row_count(&db), i64::try_from(SETTING_FIELDS.len()).unwrap());
        assert!(!db.first_run().unwrap());
    }

    #[test]
    fn saving_validates_first() {
        let (_dir, db) = temp_db();
        let next = Settings {
            ui_scale_pct: 1_000,
            speed_pct: 123,
            translations: vec!["a".into(), "a".into(), " ".into(), "b".into()],
            ..Settings::default()
        };
        let stored = db.settings_save(&next).unwrap();
        assert_eq!(stored.ui_scale_pct, 200);
        assert_eq!(stored.speed_pct, 125);
        assert_eq!(stored.translations, ["a", "b"]);
        assert_eq!(db.settings_load().unwrap(), stored);
    }

    #[test]
    fn edit_changes_fields_of_the_stored_settings_and_validates() {
        let (_dir, db) = temp_db();
        let night = Settings {
            theme: ThemeMode::Night,
            ..Settings::default()
        };
        db.settings_save(&night).unwrap();
        // A writer that read the defaults earlier and only edits two fields keeps the night theme written meanwhile.
        let (prev, stored) = db
            .settings_edit(|s| {
                s.close_to_tray = true;
                s.ui_scale_pct = 1_000;
            })
            .unwrap();
        assert_eq!(prev, night);
        assert_eq!(stored.theme, ThemeMode::Night);
        assert!(stored.close_to_tray);
        assert_eq!(stored.ui_scale_pct, 200, "validated before it is written");
        assert_eq!(db.settings_load().unwrap(), stored);
        assert_eq!(row_count(&db), 3, "only the changed keys are rows");
        let (prev, unchanged) = db.settings_edit(|_| {}).unwrap();
        assert_eq!((prev, unchanged), (stored.clone(), stored));
    }

    #[test]
    fn invalid_unknown_and_out_of_range_rows_fall_back_per_key() {
        let (_dir, db) = temp_db();
        db.with(|c| {
            c.execute_batch(
                r#"INSERT INTO setting (key, value, updated_at) VALUES
                     ('theme', '"midnight"', 0),
                     ('accent', '"rose"', 0),
                     ('zoom_pct', '9000', 0),
                     ('side_pane', '{"open":true}', 0),
                     ('retired_setting', '1', 0),
                     ('onboarding_done', '"yes"', 0);"#,
            )?;
            Ok(())
        })
        .unwrap();
        let s = db.settings_load().unwrap();
        assert_eq!(s.theme, ThemeMode::System, "unknown enum value → default");
        assert_eq!(s.accent, Accent::Rose);
        assert_eq!(s.zoom_pct, 300, "clamped by validated()");
        assert_eq!(
            s.side_pane,
            Settings::default().side_pane,
            "incomplete object → default"
        );
        assert!(!s.onboarding_done);
        assert!(
            db.first_run().unwrap(),
            "an unreadable onboarding_done counts as not done"
        );

        // Saving the effective value repairs the invalid rows and leaves unknown keys alone.
        db.settings_save(&s).unwrap();
        let theme: String = db
            .with(|c| {
                Ok(
                    c.query_row("SELECT value FROM setting WHERE key = 'theme'", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(theme, "\"system\"");
        let unknown: i64 = db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM setting WHERE key = 'retired_setting'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(unknown, 1);
        assert_eq!(db.settings_load().unwrap(), s);
    }

    #[test]
    fn reset_keeps_language_onboarding_and_hints() {
        let (_dir, db) = temp_db();
        let everything = all_changed();
        db.settings_save(&everything).unwrap();
        let (prev, now) = db.settings_reset().unwrap();
        assert_eq!(prev, everything);
        let expected = Settings {
            ui_language: everything.ui_language,
            onboarding_done: true,
            hints_seen: everything.hints_seen.clone(),
            close_to_tray_asked: true,
            ..Settings::default()
        };
        assert_eq!(now, expected);
        assert_eq!(db.settings_load().unwrap(), expected);
        assert_eq!(
            row_count(&db),
            i64::try_from(RESET_PRESERVED_KEYS.len()).unwrap()
        );
        assert!(!db.first_run().unwrap());
        // Resetting again changes nothing.
        assert_eq!(db.settings_reset().unwrap(), (expected.clone(), expected));
    }
}
