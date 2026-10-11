//! Settings persistence per top-level key (§3.2, §5.11): the `SETTING_FIELDS` contract, sparse rows, validation on the
//! way in and out, tolerant loading, reset, and first-run detection.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::BTreeMap;

use quran_core::user_db::{RESET_PRESERVED_KEYS, SETTING_FIELDS};
use quran_types::{Settings, UiLanguage};
use support::user::{T0, TempUserDb, count, every_setting_changed};

/// `key → value` of the `setting` table.
fn rows(t: &TempUserDb) -> BTreeMap<String, serde_json::Value> {
    t.db.with(|c| {
        let mut stmt = c.prepare("SELECT key, value FROM setting")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(|(k, v)| (k, serde_json::from_str(&v).unwrap()))
            .collect())
    })
    .unwrap()
}

fn camel(snake: &str) -> String {
    let mut out = String::new();
    let mut parts = snake.split('_');
    out.push_str(parts.next().unwrap());
    for p in parts {
        let mut chars = p.chars();
        out.extend(chars.next().map(|c| c.to_ascii_uppercase()));
        out.push_str(chars.as_str());
    }
    out
}

#[test]
fn every_ipc_field_has_exactly_one_snake_case_key() {
    let ipc = serde_json::to_value(Settings::default()).unwrap();
    let ipc_keys: Vec<&String> = ipc.as_object().unwrap().keys().collect();
    let mut table_keys: Vec<String> = SETTING_FIELDS.iter().map(|f| camel(f.key)).collect();
    table_keys.sort();
    let mut ipc_sorted: Vec<String> = ipc_keys.into_iter().cloned().collect();
    ipc_sorted.sort();
    assert_eq!(table_keys, ipc_sorted);
}

#[test]
fn rows_are_the_ipc_json_of_each_field_under_its_rust_name() {
    let t = TempUserDb::at(T0);
    let s = every_setting_changed();
    assert_eq!(t.db.settings_save(&s).unwrap(), s);
    let stored = rows(&t);
    let ipc = serde_json::to_value(&s).unwrap();
    assert_eq!(stored.len(), SETTING_FIELDS.len());
    for field in SETTING_FIELDS {
        assert_eq!(
            Some(&stored[field.key]),
            ipc.get(camel(field.key)),
            "{}",
            field.key
        );
    }
    assert_eq!(
        stored["side_pane"]["autoCollapseSidebar"],
        serde_json::json!(false)
    );
    assert_eq!(
        stored["gap"],
        serde_json::json!({"type": "fixed", "data": {"ms": 2500}})
    );
    let updated: Vec<i64> =
        t.db.with(|c| {
            Ok(c.prepare("SELECT DISTINCT updated_at FROM setting")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .unwrap();
    assert_eq!(updated, [T0]);
}

#[test]
fn settings_survive_a_restart() {
    let t = TempUserDb::new();
    let s = every_setting_changed();
    t.db.settings_save(&s).unwrap();
    let reopened = t.reopen();
    assert_eq!(reopened.settings_load().unwrap(), s);
    assert!(!reopened.first_run().unwrap());
}

#[test]
fn only_changed_keys_are_written() {
    let t = TempUserDb::at(T0);
    let mut s = Settings::default();
    t.db.settings_save(&s).unwrap();
    assert_eq!(count(&t.db, "setting"), 0, "defaults are not stored");
    s.volume_pct = 55;
    s.sidebar.open = false;
    t.db.set_test_clock(Some(T0 + 1));
    let (prev, stored) = t.db.settings_replace(&s).unwrap();
    assert_eq!(prev, Settings::default());
    assert_eq!(stored, s);
    assert_eq!(
        rows(&t).keys().cloned().collect::<Vec<_>>(),
        ["sidebar", "volume_pct"]
    );
    s.volume_pct = 60;
    t.db.set_test_clock(Some(T0 + 2));
    let (prev, _) = t.db.settings_replace(&s).unwrap();
    assert_eq!(prev.volume_pct, 55);
    let stamps: BTreeMap<String, i64> =
        t.db.with(|c| {
            Ok(c.prepare("SELECT key, updated_at FROM setting")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .unwrap();
    assert_eq!(stamps["sidebar"], T0 + 1, "untouched keys keep their stamp");
    assert_eq!(stamps["volume_pct"], T0 + 2);
}

#[test]
fn values_are_validated_on_save_and_on_load() {
    let t = TempUserDb::new();
    let stored =
        t.db.settings_save(&Settings {
            zoom_pct: 999,
            volume_pct: 101,
            stream_cache_cap_mib: 1,
            ..Settings::default()
        })
        .unwrap();
    assert_eq!(
        (
            stored.zoom_pct,
            stored.volume_pct,
            stored.stream_cache_cap_mib
        ),
        (300, 100, 256)
    );
    // A row written under other limits (or by hand) is clamped when read.
    t.db.with(|c| {
        c.execute("UPDATE setting SET value = '7' WHERE key = 'zoom_pct'", [])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(t.db.settings_load().unwrap().zoom_pct, 50);
}

#[test]
fn a_broken_row_falls_back_for_that_key_only() {
    let t = TempUserDb::new();
    let s = every_setting_changed();
    t.db.settings_save(&s).unwrap();
    t.db.with(|c| {
        c.execute_batch(
            r#"UPDATE setting SET value = '{"type":"fixed"}' WHERE key = 'gap';
               UPDATE setting SET value = '"klingon"' WHERE key = 'ui_language';
               INSERT INTO setting (key, value, updated_at) VALUES ('from_the_future', '[1,2,3]', 0);"#,
        )?;
        Ok(())
    })
    .unwrap();
    let loaded = t.db.settings_load().unwrap();
    assert_eq!(loaded.gap, Settings::default().gap);
    assert_eq!(loaded.ui_language, UiLanguage::En);
    assert_eq!(
        Settings {
            gap: s.gap,
            ui_language: s.ui_language,
            ..loaded
        },
        s,
        "every other key kept its value"
    );
}

#[test]
fn reset_restores_defaults_but_keeps_what_the_user_has_seen() {
    let t = TempUserDb::new();
    let s = every_setting_changed();
    t.db.settings_save(&s).unwrap();
    let (prev, now) = t.db.settings_reset().unwrap();
    assert_eq!(prev, s);
    assert_eq!(now.ui_language, UiLanguage::Ar);
    assert!(now.onboarding_done);
    assert_eq!(now.hints_seen, s.hints_seen);
    assert!(now.close_to_tray_asked);
    assert_eq!(
        Settings {
            ui_language: UiLanguage::En,
            onboarding_done: false,
            hints_seen: Vec::new(),
            close_to_tray_asked: false,
            ..now.clone()
        },
        Settings::default()
    );
    let mut kept: Vec<String> = rows(&t).into_keys().collect();
    kept.sort();
    let mut expected: Vec<String> = RESET_PRESERVED_KEYS
        .iter()
        .map(|k| (*k).to_owned())
        .collect();
    expected.sort();
    assert_eq!(kept, expected);
    assert_eq!(t.reopen().settings_load().unwrap(), now);
}

#[test]
fn first_run_ends_when_onboarding_is_done() {
    let t = TempUserDb::new();
    assert!(t.db.first_run().unwrap());
    t.db.settings_save(&Settings {
        ui_language: UiLanguage::Ar,
        ..Settings::default()
    })
    .unwrap();
    assert!(
        t.db.first_run().unwrap(),
        "other settings do not end the first run"
    );
    t.db.settings_save(&Settings {
        onboarding_done: true,
        ..Settings::default()
    })
    .unwrap();
    assert!(!t.db.first_run().unwrap());
}
