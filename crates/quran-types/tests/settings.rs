//! `Settings::default()` snapshot and `Settings::validated()` rules.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use quran_types::limits::{self, Bounds};
use quran_types::{
    CopySettings, GapSetting, OnByDefault, Settings, SidePaneSettings, SidebarSettings, UiLanguage,
};
use serde_json::Value;

fn snapshot_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/settings_default.json")
}

/// The committed snapshot pins every camelCase IPC name and every default. To accept an intentional change, run with
/// `QD_UPDATE_SNAPSHOTS=1` and commit the rewritten file together with the regenerated bindings.
#[test]
fn default_matches_committed_snapshot() {
    let actual = serde_json::to_value(Settings::default()).unwrap();
    if std::env::var("QD_UPDATE_SNAPSHOTS").as_deref() == Ok("1") {
        let mut text = serde_json::to_string_pretty(&actual).unwrap();
        text.push('\n');
        std::fs::write(snapshot_path(), text).unwrap();
    }
    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(snapshot_path()).expect("read settings_default.json"),
    )
    .unwrap();
    assert_eq!(
        actual, committed,
        "Settings::default() drifted from tests/data/settings_default.json"
    );
}

#[test]
fn snapshot_deserializes_to_default() {
    let text = std::fs::read_to_string(snapshot_path()).unwrap();
    let parsed: Settings = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed, Settings::default());
}

/// `ornateHeaders` came in a later version: an older frontend's `settings_set` sends a whole
/// `Settings` without it, which still deserialises, with the ornaments on.
#[test]
fn settings_without_ornate_headers_deserialize_with_them_on() {
    let mut json = serde_json::to_value(Settings {
        ornate_headers: OnByDefault(false),
        ..Settings::default()
    })
    .unwrap();
    json.as_object_mut()
        .unwrap()
        .remove("ornateHeaders")
        .unwrap();
    let parsed: Settings = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(parsed.ornate_headers, OnByDefault(true));
    assert_eq!(parsed, Settings::default());
    // On the wire it is a plain boolean, both ways.
    json["ornateHeaders"] = Value::Bool(false);
    let off: Settings = serde_json::from_value(json).unwrap();
    assert_eq!(off.ornate_headers, OnByDefault(false));
    assert_eq!(
        serde_json::to_value(&off).unwrap()["ornateHeaders"],
        Value::Bool(false)
    );
}

#[test]
fn default_is_already_valid() {
    assert_eq!(Settings::default().validated(), Settings::default());
}

#[test]
fn validated_clamps_and_rounds_every_range() {
    let low = Settings {
        ui_scale_pct: 10,
        ink_brightness_pct: 5,
        zoom_pct: 1000,
        translation_font_pct: 79,
        side_pane: SidePaneSettings {
            width_px: 10_000,
            ..Settings::default().side_pane
        },
        sidebar: SidebarSettings {
            width_px: 0,
            ..Settings::default().sidebar
        },
        speed_pct: 0,
        volume_pct: 101,
        ayah_repeat: 100,
        range_repeat: u32::MAX,
        stream_cache_cap_mib: 1,
        ..Settings::default()
    }
    .validated();
    assert_eq!(low.ui_scale_pct, 80);
    assert_eq!(low.ink_brightness_pct, 65);
    assert_eq!(low.zoom_pct, 300);
    assert_eq!(low.translation_font_pct, 80);
    assert_eq!(low.side_pane.width_px, 640);
    assert_eq!(low.sidebar.width_px, 240);
    assert_eq!(low.speed_pct, 50);
    assert_eq!(low.volume_pct, 100);
    assert_eq!(low.ayah_repeat, 99);
    assert_eq!(low.range_repeat, 99);
    assert_eq!(low.stream_cache_cap_mib, 256);

    let high = Settings {
        ui_scale_pct: 250,
        ink_brightness_pct: 101,
        stream_cache_cap_mib: u32::MAX,
        ..Settings::default()
    }
    .validated();
    assert_eq!(high.ui_scale_pct, 200);
    assert_eq!(high.ink_brightness_pct, 100);
    assert_eq!(high.stream_cache_cap_mib, 20_480);
}

#[test]
fn validated_rounds_steps() {
    let cases = [
        (124, 120),
        (125, 130),
        (126, 130),
        (199, 200),
        (81, 80),
        (85, 90),
    ];
    for (input, expected) in cases {
        let s = Settings {
            ui_scale_pct: input,
            ..Settings::default()
        };
        assert_eq!(s.validated().ui_scale_pct, expected, "ui_scale_pct {input}");
    }
    let down = Settings {
        speed_pct: 122,
        zoom_pct: 104,
        ..Settings::default()
    }
    .validated();
    assert_eq!((down.speed_pct, down.zoom_pct), (120, 100));
    let up = Settings {
        speed_pct: 123,
        zoom_pct: 296,
        ..Settings::default()
    }
    .validated();
    assert_eq!((up.speed_pct, up.zoom_pct), (125, 300));
}

#[test]
fn validated_dedupes_and_truncates_lists() {
    let v = Settings {
        translations: ["a", "b", "a", "", "c", "  ", "d", "b", "e", "f", "g"]
            .map(String::from)
            .to_vec(),
        hints_seen: ["page_turn", "action_bar", "page_turn", ""]
            .map(String::from)
            .to_vec(),
        ..Settings::default()
    }
    .validated();
    assert_eq!(v.translations, ["a", "b", "c", "d", "e"]);
    assert_eq!(v.hints_seen, ["page_turn", "action_bar"]);
}

#[test]
fn validated_normalises_blank_pack_ids_and_gap() {
    let s = Settings {
        wbw_pack_id: Some(String::new()),
        tafsir_pack_id: Some(" ".into()),
        copy: CopySettings {
            translation_pack_id: Some("tr.en.saheeh".into()),
            ..Settings::default().copy
        },
        gap: GapSetting::Fixed { ms: 99_999 },
        ..Settings::default()
    };
    let v = s.clone().validated();
    assert_eq!(v.wbw_pack_id, None);
    assert_eq!(v.tafsir_pack_id, None);
    assert_eq!(v.copy.translation_pack_id.as_deref(), Some("tr.en.saheeh"));
    assert_eq!(v.gap, GapSetting::Fixed { ms: 30_000 });

    let s = Settings {
        gap: GapSetting::Multiplier { pct: 301 },
        ..s
    };
    assert_eq!(s.validated().gap, GapSetting::Multiplier { pct: 300 });
}

#[test]
fn validated_is_idempotent() {
    let once = Settings {
        ui_scale_pct: 137,
        speed_pct: 3,
        translations: vec!["x".into(), "x".into(), "y".into()],
        ..Settings::default()
    }
    .validated();
    assert_eq!(once.clone().validated(), once);
}

#[test]
fn bounds_apply_and_contains() {
    let b = Bounds::new(50, 200, 5);
    assert_eq!(b.apply(0), 50);
    assert_eq!(b.apply(u32::MAX), 200);
    assert_eq!(b.apply(52), 50);
    assert_eq!(b.apply(53), 55);
    assert!(b.contains(55));
    assert!(!b.contains(56));
    assert!(!b.contains(205));
    let any = Bounds::new(0, 100, 1);
    assert_eq!(any.apply(37), 37);
    assert!(any.contains(0) && any.contains(100));
    // a step that does not divide the range never rounds past max
    assert_eq!(Bounds::new(0, 25, 10).apply(24), 20);
    assert_eq!(Bounds::new(0, 25, 10).apply(25), 25);
    assert_eq!(limits::MAX_TRANSLATIONS, 5);
}

#[test]
fn ui_language_from_os_locale() {
    for (locale, expected) in [
        (Some("ar"), UiLanguage::Ar),
        (Some("ar-SA"), UiLanguage::Ar),
        (Some("AR_eg"), UiLanguage::Ar),
        (Some("arn-CL"), UiLanguage::En),
        (Some("en-US"), UiLanguage::En),
        (Some("fr"), UiLanguage::En),
        (Some(""), UiLanguage::En),
        (None, UiLanguage::En),
    ] {
        assert_eq!(UiLanguage::from_os_locale(locale), expected, "{locale:?}");
    }
}
