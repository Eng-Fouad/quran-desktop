//! `src-tauri/resources/catalog.schema.json` (draft 2020-12) mirrors the serde model, accepts the shipped catalog and
//! rejects what the model and the rules reject.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;
use std::path::PathBuf;

use quran_core::PackTokenizer;
use quran_packs::adapters::{
    ContentKind, FontVariant, QcfFontPagesConfig, QdcAudioConfig, QuranEncSqliteConfig,
    QurancomTafsirConfig, QurancomWbwConfig, StaticFile, StaticFilesConfig, VersionSource,
};
use quran_packs::catalog::schema::{DRAFT_2020_12, validate};
use quran_packs::{Adapter, Catalog};
use quran_types::{InstallMode, L10nText, PackKind, TextDir};
use serde_json::{Value, json};

fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources")
}

fn schema() -> Value {
    serde_json::from_str(&std::fs::read_to_string(resources().join("catalog.schema.json")).unwrap())
        .unwrap()
}

fn catalog_json() -> Value {
    serde_json::from_str(&std::fs::read_to_string(resources().join("catalog.json")).unwrap())
        .unwrap()
}

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

fn enum_of(v: &Value) -> BTreeSet<String> {
    v["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

fn serialised<T: serde::Serialize>(items: &[T]) -> BTreeSet<String> {
    items
        .iter()
        .map(|i| {
            serde_json::to_value(i)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn pack_mut<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
    v["packs"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|p| p["id"] == id)
        .unwrap()
}

#[test]
fn the_schema_is_draft_2020_12() {
    let s = schema();
    assert_eq!(s["$schema"], DRAFT_2020_12);
    assert_eq!(s["properties"]["catalogVersion"]["const"], 1);
    assert_eq!(
        catalog_json()["$schema"],
        "./catalog.schema.json",
        "editors find the schema next to the file"
    );
}

#[test]
fn the_shipped_catalog_matches_the_schema() {
    assert_eq!(validate(&schema(), &catalog_json()), Vec::<String>::new());
}

#[test]
fn the_schema_mirrors_the_serde_model() {
    let s = schema();
    let defs = &s["$defs"];
    let mut catalog = Catalog::from_json(&catalog_json().to_string()).unwrap();
    assert_eq!(
        keys(&s["properties"]),
        keys(&serde_json::to_value(&catalog).unwrap())
    );

    // A pack with every optional field set.
    let mut full = catalog.get("wbw.en").unwrap().clone();
    full.requires = vec!["decor".into()];
    full.recommended = true;
    let pack = serde_json::to_value(&full).unwrap();
    assert_eq!(keys(&defs["pack"]["properties"]), keys(&pack));
    assert_eq!(
        keys(&defs["attribution"]["properties"]),
        keys(&pack["attribution"])
    );
    assert_eq!(keys(&defs["l10n"]["properties"]), keys(&pack["title"]));

    let l10n = L10nText {
        en: "x".into(),
        ar: "س".into(),
    };
    let sources = [
        (
            "qcfFontPages",
            Adapter::QcfFontPages(QcfFontPagesConfig {
                variant: FontVariant::V2,
                url_templates: vec![],
            }),
        ),
        (
            "staticFiles",
            Adapter::StaticFiles(StaticFilesConfig {
                files: vec![StaticFile {
                    path: "x".into(),
                    urls: vec![],
                    bytes: 1,
                    sha256: Some("0".into()),
                }],
            }),
        ),
        (
            "quranEncSqlite",
            Adapter::QuranEncSqlite(QuranEncSqliteConfig {
                key: "k".into(),
                version: "1".into(),
                sha256: Some("0".into()),
                version_source: VersionSource::List,
                tokenizer: PackTokenizer::PorterUnicode61,
                content_kind: ContentKind::Translation,
            }),
        ),
        (
            "qurancomTafsir",
            Adapter::QurancomTafsir(QurancomTafsirConfig { resource_id: 1 }),
        ),
        (
            "qurancomWbw",
            Adapter::QurancomWbw(QurancomWbwConfig {
                language: "en".into(),
            }),
        ),
        (
            "qdcAudio",
            Adapter::QdcAudio(QdcAudioConfig {
                reciter_id: 1,
                name: l10n.clone(),
                style: Some(l10n),
                basmala_in_file: false,
                hosts: vec![],
                word_level: true,
            }),
        ),
    ];
    let alternatives: Vec<&str> = defs["source"]["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["$ref"].as_str().unwrap().trim_start_matches("#/$defs/"))
        .collect();
    assert_eq!(
        alternatives,
        sources.iter().map(|(d, _)| *d).collect::<Vec<_>>(),
        "one alternative per adapter"
    );
    for (def, adapter) in &sources {
        let value = serde_json::to_value(adapter).unwrap();
        assert_eq!(keys(&defs[def]["properties"]), keys(&value), "{def}");
        assert_eq!(
            defs[def]["properties"]["adapter"]["const"],
            adapter.name(),
            "{def}"
        );
        if *def == "staticFiles" {
            assert_eq!(
                keys(&defs[def]["properties"]["files"]["items"]["properties"]),
                keys(&value["files"][0])
            );
        }
    }

    let props = &defs["pack"]["properties"];
    use PackKind::*;
    assert_eq!(
        enum_of(&props["kind"]),
        serialised(&[MushafFonts, Decor, Translation, Tafsir, Recitation, Wbw])
    );
    assert_eq!(
        enum_of(&props["installMode"]),
        serialised(&[InstallMode::Whole, InstallMode::OnDemand])
    );
    assert_eq!(
        enum_of(&props["direction"]),
        serialised(&[TextDir::Ltr, TextDir::Rtl])
    );
    assert_eq!(
        enum_of(&defs["quranEncSqlite"]["properties"]["tokenizer"]),
        serialised(&PackTokenizer::ALL)
    );
    assert_eq!(
        enum_of(&defs["quranEncSqlite"]["properties"]["versionSource"]),
        serialised(&[VersionSource::List, VersionSource::HttpValidators])
    );
    assert_eq!(
        enum_of(&defs["quranEncSqlite"]["properties"]["contentKind"]),
        serialised(&[ContentKind::Translation, ContentKind::Tafsir])
    );
    assert_eq!(
        enum_of(&defs["qcfFontPages"]["properties"]["variant"]),
        serialised(&[FontVariant::V1, FontVariant::V2, FontVariant::V4])
    );
    assert_eq!(
        enum_of(&defs["staticFiles"]["properties"]["files"]["items"]["properties"]["path"]),
        quran_packs::catalog::DECOR_FILES
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    );
    assert_eq!(
        enum_of(&defs["qurancomWbw"]["properties"]["language"]),
        quran_packs::catalog::QURANCOM_WBW_LANGUAGES
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    );

    // The model accepts a catalog without the optional editor hint, and so does the schema.
    catalog.schema = None;
    let plain = serde_json::to_value(&catalog).unwrap();
    assert_eq!(validate(&s, &plain), Vec::<String>::new());
}

/// Rejected by the schema, and by the strict model or the rules.
#[test]
fn schema_and_rules_reject_the_same_mistakes() {
    type Mutation = fn(&mut Value);
    let cases: &[(&str, Mutation)] = &[
        ("unknown top-level field", |v| v["extra"] = json!(1)),
        ("catalogVersion 2", |v| v["catalogVersion"] = json!(2)),
        ("bad date", |v| v["generatedAt"] = json!("2026-13-01")),
        ("unknown pack field", |v| {
            pack_mut(v, "decor")["itemsCount"] = json!(3)
        }),
        ("unknown source field", |v| {
            pack_mut(v, "wbw.en")["source"]["lang"] = json!("en")
        }),
        ("unknown adapter", |v| {
            pack_mut(v, "wbw.en")["source"] = json!({ "adapter": "everyayah", "folder": "x" })
        }),
        ("bad id", |v| pack_mut(v, "wbw.ur")["id"] = json!("WBW.ur")),
        ("kind/adapter mismatch", |v| {
            pack_mut(v, "tafsir.en.maarif")["kind"] = json!("wbw")
        }),
        ("translation without language", |v| {
            let p = pack_mut(v, "tr.fr.rashid").as_object_mut().unwrap();
            p.remove("language");
            p.remove("direction");
        }),
        ("http url", |v| {
            pack_mut(v, "decor")["source"]["files"][0]["urls"] = json!(["http://x.org/a.woff2"])
        }),
        ("bad sha256", |v| {
            pack_mut(v, "decor")["source"]["files"][1]["sha256"] = json!("XYZ")
        }),
        ("unknown decor file", |v| {
            pack_mut(v, "decor")["source"]["files"][2]["path"] = json!("names.woff2")
        }),
        ("template without page", |v| {
            pack_mut(v, "mushaf.v1")["source"]["urlTemplates"] = json!(["https://a.org/p1.woff2"]);
        }),
        ("mushaf without decor", |v| {
            pack_mut(v, "mushaf.v4")["requires"] = json!([])
        }),
        ("mushaf item count", |v| {
            pack_mut(v, "mushaf.v4")["itemCount"] = json!(600)
        }),
        ("whole QF pack", |v| {
            pack_mut(v, "tafsir.ar.saadi")["installMode"] = json!("whole")
        }),
        ("QF without revalidation", |v| {
            pack_mut(v, "audio.qdc.10")
                .as_object_mut()
                .unwrap()
                .remove("revalidateDays");
        }),
        ("revalidation over 7 days", |v| {
            pack_mut(v, "wbw.ta")["revalidateDays"] = json!(8)
        }),
        ("revalidated QuranEnc pack", |v| {
            pack_mut(v, "tr.hi.omari")["revalidateDays"] = json!(7)
        }),
        ("unsupported WBW language", |v| {
            let p = pack_mut(v, "wbw.ta");
            p["id"] = json!("wbw.ar");
            p["language"] = json!("ar");
            p["direction"] = json!("rtl");
            p["source"]["language"] = json!("ar");
        }),
        ("Arabic text without Arabic", |v| {
            pack_mut(v, "tr.es.garcia")["title"]["ar"] = json!("Isa Garcia")
        }),
        ("padded text", |v| {
            pack_mut(v, "tr.es.garcia")["title"]["en"] = json!(" Isa Garcia")
        }),
        ("host with scheme", |v| {
            pack_mut(v, "audio.qdc.5")["source"]["hosts"] = json!(["https://a.org"])
        }),
        ("zero size", |v| {
            pack_mut(v, "tr.de.bubenheim")["sizeBytes"] = json!(0)
        }),
        ("direction without language", |v| {
            pack_mut(v, "decor")["direction"] = json!("ltr")
        }),
    ];
    let s = schema();
    for (name, mutate) in cases {
        let mut v = catalog_json();
        mutate(&mut v);
        assert!(!validate(&s, &v).is_empty(), "the schema accepts: {name}");
        let rust_rejects = match Catalog::from_json(&v.to_string()) {
            Err(_) => true,
            Ok(c) => !c.issues().is_empty(),
        };
        assert!(rust_rejects, "the model and rules accept: {name}");
    }
}

#[test]
fn the_validator_reports_paths_and_unknown_keywords() {
    let s = json!({
        "type": "object", "required": ["a"], "additionalProperties": false,
        "properties": { "a": { "$ref": "#/$defs/n" }, "b": { "oneOf": [{ "const": 1 }, { "type": "integer" }] } },
        "$defs": { "n": { "type": "integer", "minimum": 2 } }
    });
    assert_eq!(validate(&s, &json!({ "a": 3 })), Vec::<String>::new());
    assert_eq!(
        validate(&s, &json!({ "a": 1 })),
        ["$.a: 1 violates minimum 2"]
    );
    assert_eq!(
        validate(&s, &json!({})),
        ["$: missing required property \"a\""]
    );
    assert_eq!(
        validate(&s, &json!({ "a": 2, "c": 0 })),
        ["$: unknown property \"c\""]
    );
    assert_eq!(
        validate(&s, &json!({ "a": 2, "b": 1 })),
        ["$.b: matches 2 oneOf alternatives, expected exactly one"]
    );
    assert!(
        validate(&json!({ "frobnicate": true }), &json!(1))[0]
            .contains("unsupported schema keyword")
    );
    assert!(
        validate(&json!({ "$ref": "#/$defs/missing" }), &json!(1))[0].contains("unresolvable $ref")
    );
    assert!(validate(&json!({ "pattern": "(" }), &json!("x"))[0].contains("invalid pattern"));
    let cyclic = json!({ "$defs": { "a": { "$ref": "#/$defs/a" } }, "$ref": "#/$defs/a" });
    assert!(validate(&cyclic, &json!(1))[0].contains("too deep"));
}
