//! QUL adapter tests on synthetic SQLite/JSON inputs. The real QUL files need a login and are gitignored, so every
//! reader is exercised here on files written in QUL's documented shapes: the committed manifest, input verification,
//! both script column variants and both JSON shapes, canonical words and their diagnosis, QUL word ids, layouts
//! (with QUL's `''` placeholders), surah names and division metadata. `qul_roundtrip.rs` runs the whole adapter at
//! full scale.
//!
//! `xtask` is a binary crate, so the build modules are compiled in by path (as in `build_pipeline.rs`); their own unit
//! tests run here too.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

// The modules' directory: a `#[path]` on each would resolve through `tests/build/`, which does not exist (only
// Windows normalises `..` before opening the file).
#[path = "../src/build"]
mod build {
    pub mod derive;
    pub mod model;
    pub mod qul;
    pub mod tanzil;
}

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Context;
use quran_types::MushafLayout;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use build::model::{
    AyahKey, LineKind, Location, RawLine, RevelationPlace, SourceSurah, SourceWord, WordKind,
};
use build::qul::{
    Division, Input, LayoutFile, LayoutInfo, LayoutRow, Manifest, Script, ScriptRow, WordIds,
    assemble_layout, canonical_words, division_numbers, parse_surahs, read_layout_file,
    read_records, read_script, verify_inputs,
};

/// The Tanzil `quran-data.xml` verified on 2026-10-10 (77,234 B; `meta.tanzil_sha256` of the M1 core.db).
const TANZIL_SHA256: &str = "8867c1d88191472adec9db694b3cd9f135b1a2ef580574d32cf888dcb22c5c7a";

/// An example manifest: placeholder hashes, and two wrong resource ids (60 for the Imla'i seed, 67 for the rub).
const SPEC_SNIPPET: &str = r#"# Valid TOML: inline tables, one entry per line (a table header cannot share a line with key/value pairs).
layout.v2        = { file = "layout-10.sqlite",  resource = 10,  sha256 = "…" }
layout.v1        = { file = "layout-15.sqlite",  resource = 15,  sha256 = "…" }
layout.v4        = { file = "layout-19.sqlite",  resource = 19,  sha256 = "…" }
script.code_v2   = { file = "script-61.sqlite",  resource = 61,  sha256 = "…" }
script.code_v1   = { file = "script-57.sqlite",  resource = 57,  sha256 = "…" }
script.text_hafs = { file = "script-312.sqlite", resource = 312, sha256 = "…" }
script.imlaei    = { file = "script-60.sqlite",  resource = 60,  sha256 = "…" }
meta.surah       = { file = "surah-names.json",  resource = 70,  sha256 = "…" }
meta.rub         = { file = "rub-el-hizb.json",  resource = 67,  sha256 = "…" }   # rub boundaries
tanzil           = { file = "quran-data.xml",                     sha256 = "…" }
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from(".."), Path::to_path_buf)
}

fn sqlite(path: &Path, sql: &str) -> anyhow::Result<()> {
    let conn = Connection::open(path)?;
    conn.execute_batch(sql)
        .with_context(|| format!("{}: {sql}", path.display()))?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn error_text<T>(result: anyhow::Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => format!("{e:#}"),
    }
}

// ---- the manifest -----------------------------------------------------------------------------------------------------

#[test]
fn the_example_manifest_parses_with_the_toml_crate() -> anyhow::Result<()> {
    // Plain TOML: the dotted keys build nested tables of inline tables.
    let table: toml::Table = toml::from_str(SPEC_SNIPPET)?;
    let mut top: Vec<&str> = table.keys().map(String::as_str).collect();
    top.sort_unstable();
    assert_eq!(top, ["layout", "meta", "script", "tanzil"]);
    assert_eq!(table["layout"]["v2"]["resource"].as_integer(), Some(10));
    assert_eq!(
        table["script"]["text_hafs"]["file"].as_str(),
        Some("script-312.sqlite")
    );
    assert_eq!(table["meta"]["rub"]["sha256"].as_str(), Some("…"));
    assert!(table["tanzil"].get("resource").is_none());

    // The adapter's manifest type reads it too: ten entries, in manifest order.
    let manifest = Manifest::parse(SPEC_SNIPPET)?;
    let keys: Vec<&str> = manifest.entries().iter().map(|e| e.input.key()).collect();
    assert_eq!(
        keys,
        [
            "layout.v2",
            "layout.v1",
            "layout.v4",
            "script.code_v2",
            "script.code_v1",
            "script.text_hafs",
            "script.imlaei",
            "meta.surah",
            "meta.rub",
            "tanzil"
        ]
    );
    assert_eq!(
        manifest
            .get(Input::TextHafs)
            .map(|e| (e.file.as_str(), e.resource)),
        Some(("script-312.sqlite", Some(312)))
    );

    // Its values are placeholders, and two resource ids are wrong (60 and 67).
    let problems = manifest.problems();
    assert_eq!(
        problems
            .iter()
            .filter(|p| p.contains("is neither 64 hex digits nor empty"))
            .count(),
        10,
        "{problems:#?}"
    );
    assert!(
        problems
            .iter()
            .any(|p| p.starts_with("script.imlaei: resource 60, expected 54")
                && p.contains("Imlaei simple")),
        "{problems:#?}"
    );
    assert!(
        problems
            .iter()
            .any(|p| p.starts_with("meta.rub: resource 67, expected 63") && p.contains("Hizb")),
        "{problems:#?}"
    );
    assert_eq!(problems.len(), 12, "{problems:#?}");
    Ok(())
}

#[test]
fn the_committed_manifest_is_valid() -> anyhow::Result<()> {
    let text = std::fs::read_to_string(root().join("data/sources/qul/manifest.toml"))?;
    let manifest = Manifest::parse(&text)?;
    assert_eq!(manifest.problems(), Vec::<String>::new());
    assert_eq!(
        manifest
            .entries()
            .iter()
            .map(|e| e.input)
            .collect::<Vec<_>>(),
        Input::ALL,
        "every input, the optional cross-checks included"
    );
    for entry in manifest.entries() {
        assert_eq!(
            entry.resource,
            entry.input.resource(),
            "{}",
            entry.input.key()
        );
        if entry.input != Input::Tanzil {
            assert!(
                entry.sha256.is_empty(),
                "QUL hashes are recorded by a person"
            );
        }
    }
    assert_eq!(
        manifest.get(Input::Tanzil).map(|e| e.sha256.as_str()),
        Some(TANZIL_SHA256),
        "Tanzil is pinned to the verified file"
    );
    let cached = root().join("data/cache/tanzil/quran-data.xml");
    if let Ok(bytes) = std::fs::read(&cached) {
        assert_eq!(bytes.len(), 77_234);
        assert_eq!(sha256(&bytes), TANZIL_SHA256, "{}", cached.display());
    }
    Ok(())
}

#[test]
fn manifests_with_unknown_or_missing_keys_are_rejected() {
    let good = std::fs::read_to_string(root().join("data/sources/qul/manifest.toml")).unwrap();
    assert!(Manifest::parse(&good).is_ok());
    for (change, why) in [
        (good.replace("layout.v4 ", "layout.v5 "), "unknown layout"),
        (
            good.replace("script.imlaei ", "script.imlaei_simple "),
            "unknown script",
        ),
        (
            good.replace("meta.surah ", "meta.surahs "),
            "missing meta.surah",
        ),
        (
            good.replace("resource = 10, ", "resource = 10, note = \"x\", "),
            "unknown field",
        ),
        (
            good.replace("resource = 10, ", "resource = -10, "),
            "negative resource",
        ),
        (good.replace("file = \"layout-10.sqlite\",", ""), "no file"),
        (format!("{good}\nextra = 1\n"), "unknown top-level key"),
        ("layout.v2 = { file = ".to_owned(), "not TOML"),
    ] {
        assert!(Manifest::parse(&change).is_err(), "{why}");
    }
    let optional_removed: String = good
        .lines()
        .filter(|l| !l.starts_with("meta.juz") && !l.starts_with("meta.manzil"))
        .map(|l| format!("{l}\n"))
        .collect();
    let manifest = Manifest::parse(&optional_removed).unwrap();
    assert!(manifest.get(Input::Juz).is_none() && manifest.get(Input::Hizb).is_some());
    assert!(manifest.problems().is_empty());
}

#[test]
fn manifest_values_are_checked() {
    let text = manifest_text(&Input::ALL.map(|input| Entry {
        input,
        file: default_file(input),
        resource: input.resource(),
        sha256: String::new(),
    }));
    assert!(Manifest::parse(&text).unwrap().problems().is_empty());

    let bad = manifest_text(&Input::ALL.map(|input| {
        let mut entry = Entry {
            input,
            file: default_file(input),
            resource: input.resource(),
            sha256: String::new(),
        };
        match input {
            Input::LayoutV1 => entry.file = "../layout-15.sqlite".into(),
            Input::LayoutV4 => entry.file = default_file(Input::LayoutV2).to_uppercase(),
            Input::CodeV1 => entry.resource = None,
            Input::Hizb => entry.resource = Some(63),
            Input::Tanzil => entry.resource = Some(1),
            Input::Surahs => entry.sha256 = "abc".into(),
            _ => {}
        }
        entry
    }));
    let problems = Manifest::parse(&bad).unwrap().problems();
    let expect = [
        "layout.v1: file \"../layout-15.sqlite\" must be a relative path",
        "layout.v4: file \"LAYOUT-V2.BIN\" is also layout.v2's",
        "script.code_v1: no resource id, expected 57",
        "meta.hizb: resource 63, expected 67",
        "tanzil: resource 1, but this input is not a QUL resource",
        "meta.surah: sha256 \"abc\" is neither 64 hex digits nor empty",
    ];
    for prefix in expect {
        assert!(
            problems.iter().any(|p| p.starts_with(prefix)),
            "{prefix}\n{problems:#?}"
        );
    }
    assert_eq!(problems.len(), expect.len(), "{problems:#?}");
}

/// One manifest line.
struct Entry {
    input: Input,
    file: String,
    resource: Option<u32>,
    sha256: String,
}

fn default_file(input: Input) -> String {
    format!("{}.bin", input.key().replace('.', "-"))
}

fn manifest_text(entries: &[Entry]) -> String {
    let mut text = String::from("# synthetic\n");
    for e in entries {
        let resource = e
            .resource
            .map_or_else(String::new, |r| format!("resource = {r}, "));
        writeln!(
            text,
            "{} = {{ file = {:?}, {resource}sha256 = {:?} }}",
            e.input.key(),
            e.file,
            e.sha256
        )
        .unwrap();
    }
    text
}

#[test]
fn inputs_are_verified_before_anything_is_read() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let content = |input: Input| format!("synthetic {}", input.key()).into_bytes();
    for input in Input::ALL {
        if input != Input::LayoutV1 {
            std::fs::write(dir.path().join(default_file(input)), content(input))?;
        }
    }
    let entries = Input::ALL.map(|input| {
        let actual = sha256(&content(input));
        let (file, resource, sha) = match input {
            Input::LayoutV2 => (default_file(input), input.resource(), actual.to_uppercase()),
            Input::CodeV2 => (default_file(input), input.resource(), String::new()),
            Input::CodeV1 => (default_file(input), input.resource(), sha256(b"other")),
            Input::Rub => (default_file(input), Some(67), actual),
            Input::Juz => ("../juz.json".to_owned(), input.resource(), actual),
            _ => (default_file(input), input.resource(), actual),
        };
        Entry {
            input,
            file,
            resource,
            sha256: sha,
        }
    });
    std::fs::write(dir.path().join("manifest.toml"), manifest_text(&entries))?;
    let manifest = Manifest::parse(&manifest_text(&entries))?;
    let message = error_text(verify_inputs(dir.path(), &manifest));
    assert!(message.contains("5 problem(s)"), "{message}");
    for needle in [
        "layout.v1: ".to_owned(),
        "layout-v1.bin is missing: download \"KFGQPC V1 layout (1405H print)\" (SQLite) from \
         https://qul.tarteel.ai/resources/mushaf-layout/15"
            .to_owned(),
        format!(
            "script.code_v2: sha256 not recorded yet; script-code_v2.bin has sha256 {}",
            sha256(&content(Input::CodeV2))
        ),
        format!(
            "script.code_v1: script-code_v1.bin has sha256 {}, but the manifest records {}",
            sha256(&content(Input::CodeV1)),
            sha256(b"other")
        ),
        "meta.rub: resource 67, expected 63".to_owned(),
        "meta.juz: file \"../juz.json\" must be a relative path".to_owned(),
    ] {
        assert!(message.contains(&needle), "{needle}\n{message}");
    }
    assert!(
        !message.contains("layout.v2:"),
        "upper-case hex is accepted: {message}"
    );

    // Once every problem is fixed the inputs verify, and the provenance hash ignores the manifest's formatting.
    std::fs::write(
        dir.path().join(default_file(Input::LayoutV1)),
        content(Input::LayoutV1),
    )?;
    let fixed = Input::ALL.map(|input| Entry {
        input,
        file: default_file(input),
        resource: input.resource(),
        sha256: sha256(&content(input)),
    });
    let text = manifest_text(&fixed);
    let inputs = verify_inputs(dir.path(), &Manifest::parse(&text)?)?;
    let expected: String = Input::ALL
        .iter()
        .map(|i| {
            format!(
                "{}  {}  {}\n",
                sha256(&content(*i)),
                i.key(),
                default_file(*i)
            )
        })
        .collect();
    assert_eq!(inputs.manifest_sha256(), sha256(expected.as_bytes()));
    let reformatted = format!("# another comment\r\n{}", text.replace('\n', "\r\n"));
    let again = verify_inputs(dir.path(), &Manifest::parse(&reformatted)?)?;
    assert_eq!(again.manifest_sha256(), inputs.manifest_sha256());
    assert_eq!(
        inputs.get(Input::Rub)?.bytes,
        content(Input::Rub),
        "the verified bytes are kept"
    );
    assert!(inputs.optional(Input::Manzil).is_some());
    Ok(())
}

// ---- word scripts ---------------------------------------------------------------------------------------------------

/// (id, location, text) rows of a tiny "Quran": 1:1 has 2 words + marker, 1:2 has 1 word + marker, 2:1 has 2 words +
/// marker. QUL-like ids with one unused slot (5).
const WORDS: [(u32, &str, &str); 9] = [
    (1, "1:1:1", "بِسۡمِ"),
    (2, "1:1:2", "ٱللَّهِ"),
    (3, "1:1:3", "١"),
    (4, "1:2:1", "ٱلۡحَمۡدُ"),
    (6, "1:2:2", "٢"),
    (7, "2:1:1", "الٓمٓ"),
    (8, "2:1:2", "ذَٰلِكَ"),
    (9, "2:1:3", "١"),
    // A row the canonical tests remove or reuse.
    (10, "2:2:1", "هُدٗى"),
];

fn tiny_surahs() -> Vec<SourceSurah> {
    let surah = |id: u32, ayah_count: u32| SourceSurah {
        id,
        name_ar: "س".into(),
        name_simple: format!("S{id}"),
        name_complex: format!("S{id}"),
        revelation_place: RevelationPlace::Makkah,
        revelation_order: id,
        ayah_count,
        bismillah_pre: id != 1,
    };
    vec![surah(1, 2), surah(2, 1)]
}

fn rows(words: &[(u32, &str, &str)]) -> Vec<ScriptRow> {
    words
        .iter()
        .map(|(id, location, text)| ScriptRow {
            id: Some(*id),
            location: location
                .parse::<Location>()
                .map_err(|_| (*location).to_owned()),
            text: Some((*text).to_owned()),
        })
        .collect()
}

fn script(input: Input, words: &[(u32, &str, &str)]) -> Script {
    Script {
        input,
        format: "test".into(),
        rows: rows(words),
    }
}

fn texts(script: &Script) -> Vec<(Option<u32>, String, Option<String>)> {
    script
        .rows
        .iter()
        .map(|r| {
            (
                r.id,
                r.location
                    .as_ref()
                    .map_or_else(Clone::clone, ToString::to_string),
                r.text.clone(),
            )
        })
        .collect()
}

#[test]
fn scripts_accept_both_column_variants_and_both_json_shapes() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let words = &WORDS[..8];
    let values = |f: &dyn Fn(&(u32, &str, &str)) -> String| {
        words.iter().map(f).collect::<Vec<_>>().join(", ")
    };
    // The exporter's columns.
    let exporter = dir.path().join("exporter.sqlite");
    sqlite(
        &exporter,
        &format!(
            "CREATE TABLE words (id INTEGER, location TEXT, surah INTEGER, ayah INTEGER, word INTEGER, text TEXT);
             INSERT INTO words VALUES {};",
            values(&|(id, loc, text)| {
                let [s, a, w]: [&str; 3] = loc.split(':').collect::<Vec<_>>().try_into().unwrap();
                format!("({id}, '{loc}', {s}, {a}, {w}, '{text}')")
            })
        ),
    )?;
    // The Help page's columns (no `word`), rows in reverse order.
    let help = dir.path().join("help.sqlite");
    sqlite(
        &help,
        &format!(
            "CREATE TABLE words (word_index INTEGER, word_key TEXT, surah INTEGER, ayah INTEGER, text TEXT);
             INSERT INTO words VALUES {};",
            words
                .iter()
                .rev()
                .map(|(id, loc, text)| {
                    let mut parts = loc.split(':');
                    let (s, a) = (parts.next().unwrap(), parts.next().unwrap());
                    format!("({id}, '{loc}', {s}, {a}, '{text}')")
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )?;
    // `word_key` as "s:a", completed by `word`.
    let short_key = dir.path().join("short.sqlite");
    sqlite(
        &short_key,
        &format!(
            "CREATE TABLE words (word_index INTEGER, word_key TEXT, word INTEGER, text TEXT);
             INSERT INTO words VALUES {};",
            values(&|(id, loc, text)| {
                let (key, w) = loc.rsplit_once(':').unwrap();
                format!("({id}, '{key}', {w}, '{text}')")
            })
        ),
    )?;
    // The exporter's JSON: keyed by location, numbers as strings.
    let json: serde_json::Map<String, serde_json::Value> = words
        .iter()
        .map(|(id, loc, text)| {
            let parts: Vec<&str> = loc.split(':').collect();
            (
                (*loc).to_owned(),
                serde_json::json!({"id": id, "surah": parts[0], "ayah": parts[1], "word": parts[2],
                                   "location": loc, "text": text}),
            )
        })
        .collect();
    let json_bytes = serde_json::to_vec(&json)?;
    // The resource pages' JSON: keyed by ayah, with a words array (no ids).
    let mut by_ayah: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
    for (_, loc, text) in words {
        let (key, w) = loc.rsplit_once(':').unwrap();
        by_ayah.entry(key.to_owned()).or_default().push(
            serde_json::json!({"position": w.parse::<u32>()?, "text": text, "location": loc}),
        );
    }
    let ayah_json: serde_json::Map<String, serde_json::Value> = by_ayah
        .into_iter()
        .map(|(key, words)| {
            let value = serde_json::json!({"verse_key": key, "text": "…", "script_type": "code_v2",
                                           "words": words, "page_number": 1});
            (key, value)
        })
        .collect();
    let ayah_bytes = serde_json::to_vec(&ayah_json)?;

    let read = |path: &Path| -> anyhow::Result<Script> {
        read_script(Input::CodeV2, path, &std::fs::read(path)?)
    };
    let exporter = read(&exporter)?;
    assert_eq!(exporter.format, "SQLite words(id, location, word)");
    let mut expected = texts(&exporter);
    expected.sort();
    assert_eq!(expected.len(), 8);
    assert_eq!(expected[0], (Some(1), "1:1:1".into(), Some("بِسۡمِ".into())));

    let help = read(&help)?;
    assert_eq!(help.format, "SQLite words(word_index, word_key)");
    let short = read(&short_key)?;
    let json = read_script(Input::CodeV2, Path::new("unused.json"), &json_bytes)?;
    assert_eq!(json.format, "JSON keyed by location");
    for other in [&help, &short, &json] {
        let mut got = texts(other);
        got.sort();
        assert_eq!(got, expected, "{}", other.format);
    }
    let ayah = read_script(Input::CodeV2, Path::new("unused.json"), &ayah_bytes)?;
    assert_eq!(ayah.format, "JSON keyed by ayah (words[])");
    let mut got: Vec<_> = texts(&ayah).into_iter().map(|(_, l, t)| (l, t)).collect();
    got.sort();
    let without_ids: Vec<_> = expected.into_iter().map(|(_, l, t)| (l, t)).collect();
    assert_eq!(got, without_ids);
    assert!(ayah.rows.iter().all(|r| r.id.is_none()));
    Ok(())
}

#[test]
fn script_files_in_other_shapes_are_rejected() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let cases = [
        (
            "CREATE TABLE verses (id INTEGER, text TEXT);",
            "no table words (it has: verses)",
        ),
        (
            "CREATE TABLE words (id INTEGER, text TEXT);",
            "neither a location nor a word_key column",
        ),
        (
            "CREATE TABLE words (id INTEGER, location TEXT);",
            "has no text column",
        ),
        (
            "CREATE TABLE words (id INTEGER, location TEXT, surah INTEGER, text TEXT);
             INSERT INTO words VALUES (1, '1:1:1', 2, 'x');",
            "location 1:1:1, but surah = 2",
        ),
        (
            "CREATE TABLE words (id INTEGER, location TEXT, text TEXT);
             INSERT INTO words VALUES (-1, '1:1:1', 'x');",
            "-1 is not a non-negative 32-bit integer",
        ),
        (
            "CREATE TABLE words (id INTEGER, location TEXT, text TEXT);
             INSERT INTO words VALUES (1, NULL, 'x');",
            "location is NULL",
        ),
        (
            "CREATE TABLE words (id INTEGER, location TEXT, text TEXT);",
            "the script has no words",
        ),
    ];
    for (index, (sql, needle)) in cases.into_iter().enumerate() {
        let path = dir.path().join(format!("case-{index}.sqlite"));
        sqlite(&path, sql)?;
        let message = error_text(read_script(Input::CodeV1, &path, &std::fs::read(&path)?));
        assert!(message.contains(needle), "{needle}\n{message}");
    }
    for (json, needle) in [
        ("[1, 2]", "item 0 is not an object"),
        (
            "{\"1:1:1\": {\"id\": 1, \"text\": true}}",
            "text: true is not a string",
        ),
        ("\"words\"", "expected a JSON object or array"),
        (
            "{\"1:1\": {\"verse_key\": \"1:1\", \"words\": [{\"text\": \"x\"}]}}",
            "neither location nor position",
        ),
        ("not json", "parse JSON"),
    ] {
        let message = error_text(read_script(
            Input::CodeV1,
            Path::new("x.json"),
            json.as_bytes(),
        ));
        assert!(message.contains(needle), "{needle}\n{message}");
    }
    Ok(())
}

#[test]
fn canonical_words_join_the_scripts_on_location() -> anyhow::Result<()> {
    let base = &WORDS[..8];
    // Each script in its own row order and id space: ids are never compared, locations are.
    let mut reversed = base.to_vec();
    reversed.reverse();
    let shifted: Vec<(u32, &str, &str)> =
        base.iter().map(|(id, l, t)| (id + 1000, *l, *t)).collect();
    let scripts = [
        script(
            Input::CodeV2,
            &base
                .iter()
                .map(|(i, l, _)| (*i, *l, "v2"))
                .collect::<Vec<_>>(),
        ),
        script(
            Input::CodeV1,
            &reversed
                .iter()
                .map(|(i, l, _)| (*i, *l, "v1"))
                .collect::<Vec<_>>(),
        ),
        script(Input::TextHafs, base),
        script(
            Input::Imlaei,
            &shifted
                .iter()
                .map(|(i, l, _)| (*i, *l, "imla"))
                .collect::<Vec<_>>(),
        ),
    ];
    let words = canonical_words(&scripts, &tiny_surahs(), 8)?;
    assert_eq!(words.len(), 8);
    let kinds: Vec<(String, WordKind)> =
        words.iter().map(|(l, w)| (l.to_string(), w.kind)).collect();
    assert_eq!(
        kinds,
        [
            ("1:1:1".into(), WordKind::Word),
            ("1:1:2".into(), WordKind::Word),
            ("1:1:3".into(), WordKind::End),
            ("1:2:1".into(), WordKind::Word),
            ("1:2:2".into(), WordKind::End),
            ("2:1:1".into(), WordKind::Word),
            ("2:1:2".into(), WordKind::Word),
            ("2:1:3".into(), WordKind::End),
        ]
    );
    let first = &words[&Location::new(1, 1, 1)];
    assert_eq!(
        (
            first.code_v2.as_str(),
            first.code_v1.as_str(),
            first.text_hafs.as_str()
        ),
        ("v2", "v1", "بِسۡمِ")
    );
    assert_eq!(first.text_imlaei.as_deref(), Some("imla"));
    let marker = &words[&Location::new(2, 1, 3)];
    assert_eq!(marker.text_hafs, "١");
    assert_eq!(marker.text_imlaei, None, "end markers have no Imla'i text");
    Ok(())
}

#[test]
fn scripts_must_list_the_same_locations() {
    let base = &WORDS[..8];
    let all = |imlaei: &[(u32, &str, &str)]| {
        [
            script(Input::CodeV2, base),
            script(Input::CodeV1, base),
            script(Input::TextHafs, base),
            script(Input::Imlaei, imlaei),
        ]
    };
    // One location missing.
    let missing: Vec<_> = base.iter().filter(|w| w.1 != "1:2:1").copied().collect();
    let message = error_text(canonical_words(&all(&missing), &tiny_surahs(), 8));
    assert!(
        message.contains(
            "script.imlaei differs from script.code_v2: lacks 1 of its location(s): 1:2:1"
        ),
        "{message}"
    );
    let mut extra = base.to_vec();
    extra.push((10, "2:2:1", "x"));
    let message = error_text(canonical_words(&all(&extra), &tiny_surahs(), 8));
    assert!(
        message.contains(
            "script.imlaei differs from script.code_v2: has 1 location(s) it lacks: 2:2:1"
        ),
        "{message}"
    );
    // Only the end markers missing: the JSON export without them.
    let no_markers: Vec<_> = base
        .iter()
        .filter(|w| !["1:1:3", "1:2:2", "2:1:3"].contains(&w.1))
        .copied()
        .collect();
    let message = error_text(canonical_words(&all(&no_markers), &tiny_surahs(), 8));
    assert!(
        message.contains("every missing location is an ayah's end marker"),
        "{message}"
    );
    // A location listed twice.
    let mut twice = base.to_vec();
    twice.push((99, "1:1:1", "again"));
    let message = error_text(canonical_words(&all(&twice), &tiny_surahs(), 8));
    assert!(
        message.contains("script.imlaei lists 1 location(s) twice: 1:1:1"),
        "{message}"
    );
    // A script with no text for a word.
    let mut scripts = all(base);
    scripts[2].rows[0].text = None;
    let message = error_text(canonical_words(&scripts, &tiny_surahs(), 8));
    assert!(
        message.contains("script.text_hafs: word 1:1:1 has no text"),
        "{message}"
    );
}

#[test]
fn extra_locations_stop_the_build_with_candidates_for_a_human() {
    // QUL may have more rows than the 83,665 words. Here: 8 words expected, 4 extra rows of 4 kinds.
    let mut words = WORDS[..8].to_vec();
    words.push((5, "1:2:3", "زائد")); // after 1:2's end marker
    words.push((11, "2:4:1", "x")); // surah 2 has 1 ayah
    words.push((12, "1:0:1", "x")); // not a location
    words.push((13, "2:1:5", "x")); // a gap at 2:1:4
    let scripts =
        [Input::CodeV2, Input::CodeV1, Input::TextHafs, Input::Imlaei].map(|i| script(i, &words));
    let message = error_text(canonical_words(&scripts, &tiny_surahs(), 8));
    for needle in [
        "the word scripts have 11 word locations (plus 1 unparsable), expected exactly 8",
        "QUL's word_index has 3 extra slots",
        "locations that are not s:a:w: \"1:0:1\" (word_index 12)",
        "locations outside their surah's ayahs: 2:4:1",
        "ayahs whose positions are not 1..n: 2:1 (positions 1, 2, 3, 5)",
        "locations after their ayah's end marker (script.text_hafs): 1:2:3, 2:1:5",
        "ayahs without an end marker: 2:4",
    ] {
        assert!(message.contains(needle), "{needle}\n{message}");
    }
    // Too few: an ayah without words.
    let fewer: Vec<_> = WORDS[..8]
        .iter()
        .filter(|w| !w.1.starts_with("1:2:"))
        .copied()
        .collect();
    let scripts =
        [Input::CodeV2, Input::CodeV1, Input::TextHafs, Input::Imlaei].map(|i| script(i, &fewer));
    let message = error_text(canonical_words(&scripts, &tiny_surahs(), 8));
    assert!(message.contains("ayahs without words: 1:2"), "{message}");
    // Nothing structural to point at: the count alone.
    let scripts = [Input::CodeV2, Input::CodeV1, Input::TextHafs, Input::Imlaei]
        .map(|i| script(i, &WORDS[..8]));
    let message = error_text(canonical_words(&scripts, &tiny_surahs(), 9));
    assert!(
        message.contains("No location stands out structurally"),
        "{message}"
    );
}

fn words_map(locations: &[&str]) -> BTreeMap<Location, SourceWord> {
    locations
        .iter()
        .map(|l| {
            (
                l.parse().unwrap(),
                SourceWord {
                    kind: WordKind::Word,
                    text_hafs: "x".into(),
                    text_imlaei: Some("x".into()),
                    code_v1: "x".into(),
                    code_v2: "x".into(),
                },
            )
        })
        .collect()
}

#[test]
fn qul_word_ids_map_line_ranges_and_skip_unused_slots() -> anyhow::Result<()> {
    let base = &WORDS[..8];
    let words = words_map(&base.iter().map(|w| w.1).collect::<Vec<_>>());
    let ids = WordIds::new(&rows(base), &words)?;
    assert_eq!(ids.max(), 9);
    assert_eq!(ids.unused().collect::<Vec<_>>(), [5], "QUL's extra slot");
    assert_eq!(
        ids.line(4, 7)?
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["1:2:1", "1:2:2", "2:1:1"],
        "id 5 names no word and is skipped"
    );
    assert!(error_text(ids.line(5, 7)).contains("word id 5 names no word"));
    assert!(error_text(ids.line(7, 4)).contains("first_word_id 7 is after last_word_id 4"));
    assert!(error_text(ids.line(1, 99)).contains("word id 99 names no word"));
    let mut other = rows(base);
    other[0].id = Some(2);
    other[1].id = Some(1);
    assert_eq!(ids.disagreements(&other), 2);

    let mut swapped = base.to_vec();
    swapped[0].0 = 3;
    swapped[2].0 = 1;
    let message = error_text(WordIds::new(&rows(&swapped), &words));
    assert!(
        message.contains("word_index order and location order disagree"),
        "{message}"
    );
    let mut duplicate = base.to_vec();
    duplicate[1].0 = 1;
    assert!(error_text(WordIds::new(&rows(&duplicate), &words)).contains("word_index 1 is both"));
    let mut no_id = rows(base);
    no_id[3].id = None;
    assert!(error_text(WordIds::new(&no_id, &words)).contains("1:2:1 has no word_index"));
    assert!(error_text(WordIds::new(&rows(&base[..7]), &words)).contains("for 7 of the 8 words"));
    let foreign = words_map(&["1:1:1"]);
    assert!(error_text(WordIds::new(&rows(base), &foreign)).contains("not a word of the scripts"));
    Ok(())
}

// ---- layouts --------------------------------------------------------------------------------------------------------

/// A 3-page layout in QUL's export shape: 8 + 8 + 15 lines, `''` for columns that don't apply, surah 3's `surah_name`
/// on the last line of page 2 and its basmallah opening page 3 (the An-Nisa shape), QUL word id 15 unused.
fn tiny_layout_sql() -> String {
    let mut rows: Vec<String> = Vec::new();
    let ayah = |page: u32, line: u32, centred: &str, first: u32, last: u32| {
        format!("({page}, {line}, 'ayah', {centred}, {first}, {last}, '')")
    };
    let header = |page: u32, line: u32, kind: &str, surah: &str| {
        format!("({page}, {line}, '{kind}', 1, '', '', {surah})")
    };
    rows.push(header(1, 1, "surah_name", "1"));
    rows.extend((2..=8).map(|line| ayah(1, line, "1", line - 1, line - 1)));
    rows.push(header(2, 1, "surah_name", "2"));
    rows.push(header(2, 2, "basmallah", "''"));
    rows.extend((3..=7).map(|line| ayah(2, line, "1", line + 5, line + 5)));
    rows.push(header(2, 8, "surah_name", "3"));
    rows.push(header(3, 1, "basmallah", "''"));
    rows.push(ayah(3, 2, "0", 14, 17));
    rows.extend((3..=14).map(|line| ayah(3, line, "0", line + 15, line + 15)));
    rows.push(ayah(3, 15, "''", 30, 30));
    format!(
        "CREATE TABLE pages (page_number INTEGER, line_number INTEGER, line_type TEXT, is_centered INTEGER,
                             first_word_id INTEGER, last_word_id INTEGER, surah_number INTEGER);
         INSERT INTO pages VALUES {};
         CREATE TABLE info (name TEXT, number_of_pages INTEGER, lines_per_page INTEGER, font_name TEXT);
         INSERT INTO info VALUES ('Synthetic layout', 3, 15, 'v2');",
        rows.join(", ")
    )
}

/// The words of [`tiny_layout_sql`]: ids 1–12 and 14, 16–30 (13 and 15 unused).
fn tiny_layout_words() -> Vec<(u32, String)> {
    let mut words: Vec<(u32, String)> = (1..=7).map(|w| (w, format!("1:1:{w}"))).collect();
    words.extend((1..=5).map(|w| (w + 7, format!("2:1:{w}"))));
    words.push((14, "3:1:1".into()));
    words.extend((2..=16).map(|w| (w + 14, format!("3:1:{w}"))));
    words
}

fn tiny_ids() -> anyhow::Result<WordIds> {
    let words = tiny_layout_words();
    let map = words_map(&words.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>());
    let rows: Vec<ScriptRow> = words
        .iter()
        .map(|(id, l)| ScriptRow {
            id: Some(*id),
            location: Ok(l.parse().unwrap()),
            text: Some("x".into()),
        })
        .collect();
    WordIds::new(&rows, &map)
}

fn tiny_layout_file() -> anyhow::Result<LayoutFile> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("layout.sqlite");
    sqlite(&path, &tiny_layout_sql())?;
    read_layout_file(&path, &std::fs::read(&path)?)
}

fn line_summary(
    line: &RawLine,
) -> (
    u32,
    Option<LineKind>,
    Option<bool>,
    Option<u32>,
    Vec<String>,
) {
    (
        line.line,
        line.kind,
        line.centered,
        line.surah,
        line.words.iter().map(ToString::to_string).collect(),
    )
}

#[test]
fn layouts_are_read_in_qul_conventions() -> anyhow::Result<()> {
    let file = tiny_layout_file()?;
    assert_eq!(file.rows.len(), 31);
    assert_eq!(
        file.rows[1],
        LayoutRow {
            page: 1,
            line: 2,
            line_type: "ayah".into(),
            centered: Some(true),
            first_word_id: Some(1),
            last_word_id: Some(1),
            surah: None,
        },
        "'' is NULL"
    );
    assert_eq!(
        file.info,
        Some(LayoutInfo {
            name: Some("Synthetic layout".into()),
            pages: Some(3),
            lines_per_page: Some(15),
            font: Some("v2".into()),
        })
    );
    assert!(file.words.is_none());

    let ids = tiny_ids()?;
    assert_eq!(ids.unused().collect::<Vec<_>>(), [13, 15]);
    let layout = assemble_layout(MushafLayout::V1, &file, &ids, 3)?;
    assert_eq!(layout.layout, MushafLayout::V1);
    assert_eq!(
        layout.pages.iter().map(|p| p.number).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(
        layout
            .pages
            .iter()
            .map(|p| p.lines.len())
            .collect::<Vec<_>>(),
        [8, 8, 15]
    );
    let p1 = &layout.pages[0].lines;
    assert_eq!(
        line_summary(&p1[0]),
        (1, Some(LineKind::SurahName), Some(true), Some(1), vec![])
    );
    assert_eq!(
        line_summary(&p1[1]),
        (
            2,
            Some(LineKind::Ayah),
            Some(true),
            None,
            vec!["1:1:1".to_owned()]
        )
    );
    let p2 = &layout.pages[1].lines;
    assert_eq!(
        line_summary(&p2[1]),
        (2, Some(LineKind::Basmallah), Some(true), Some(2), vec![]),
        "the basmallah takes the surah of the next ayah line"
    );
    assert_eq!(
        line_summary(&p2[7]),
        (8, Some(LineKind::SurahName), Some(true), Some(3), vec![]),
        "a surah_name on the page before its surah"
    );
    let p3 = &layout.pages[2].lines;
    assert_eq!(
        line_summary(&p3[0]),
        (1, Some(LineKind::Basmallah), Some(true), Some(3), vec![]),
    );
    assert_eq!(
        line_summary(&p3[1]),
        (
            2,
            Some(LineKind::Ayah),
            Some(false),
            None,
            vec!["3:1:1".to_owned(), "3:1:2".to_owned(), "3:1:3".to_owned()]
        ),
        "ids 14..=17 hold three words: 15 is an unused QUL slot"
    );
    assert_eq!(
        line_summary(&p3[14]),
        (
            15,
            Some(LineKind::Ayah),
            None,
            None,
            vec!["3:1:16".to_owned()]
        ),
        "is_centered '' is left to derive.rs"
    );
    Ok(())
}

#[test]
fn a_layout_with_its_own_words_table_maps_through_it() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("layout.sqlite");
    let words: Vec<String> = tiny_layout_words()
        .iter()
        .map(|(id, l)| format!("({id}, '{l}', 'x')"))
        .collect();
    sqlite(
        &path,
        &format!(
            "{} CREATE TABLE words (word_index INTEGER, word_key TEXT, text TEXT); INSERT INTO words VALUES {};",
            tiny_layout_sql(),
            words.join(", ")
        ),
    )?;
    let file = read_layout_file(&path, &std::fs::read(&path)?)?;
    let own = file.words.as_ref().context("the words table")?;
    assert_eq!(own.len(), 28);
    let map = words_map(
        &tiny_layout_words()
            .iter()
            .map(|(_, l)| l.as_str())
            .collect::<Vec<_>>(),
    );
    let ids = WordIds::new(own, &map)?;
    assert_eq!(ids, tiny_ids()?);
    Ok(())
}

#[test]
fn layout_errors_name_the_page_and_line() -> anyhow::Result<()> {
    let file = tiny_layout_file()?;
    let ids = tiny_ids()?;
    let check = |change: &dyn Fn(&mut LayoutFile), needle: &str| {
        let mut changed = file.clone();
        change(&mut changed);
        let message = error_text(assemble_layout(MushafLayout::V2, &changed, &ids, 3));
        assert!(message.contains(needle), "{needle}\n{message}");
    };
    let row = |f: &mut LayoutFile, page: u32, line: u32| -> usize {
        f.rows
            .iter()
            .position(|r| r.page == page && r.line == line)
            .unwrap()
    };
    check(
        &|f| {
            let i = row(f, 3, 7);
            f.rows.remove(i);
        },
        "page 3 has no line(s) 7",
    );
    check(
        &|f| {
            let r = f.rows[0].clone();
            f.rows.push(r);
        },
        "page 1 line 1 is listed twice",
    );
    check(&|f| f.rows[0].line = 9, "page 1 line 9 is outside 1..=8");
    check(&|f| f.rows.retain(|r| r.page != 2), "pages 2 have no lines");
    check(&|f| f.rows[0].page = 4, "page 4 is outside 1..=3");
    check(
        &|f| {
            let i = row(f, 2, 2);
            f.rows[i].line_type = "bismillah".into();
        },
        "page 2 line 2: line_type \"bismillah\"",
    );
    check(
        &|f| {
            let i = row(f, 1, 3);
            f.rows[i].last_word_id = None;
        },
        "page 1 line 3: an ayah line without first_word_id",
    );
    check(
        &|f| {
            let i = row(f, 1, 3);
            f.rows[i].surah = Some(1);
        },
        "page 1 line 3: an ayah line with surah_number 1",
    );
    check(
        &|f| {
            let i = row(f, 2, 1);
            f.rows[i].first_word_id = Some(1);
        },
        "page 2 line 1: a surah_name line with word ids",
    );
    check(
        &|f| {
            let i = row(f, 3, 2);
            f.rows[i].first_word_id = Some(15);
        },
        "page 3 line 2: word id 15 names no word",
    );
    check(
        &|f| {
            let i = row(f, 3, 1);
            f.rows[i].surah = Some(4);
        },
        "page 3 line 1: basmallah of surah 4, but the next ayah line is in surah 3",
    );
    check(
        &|f| {
            for r in f.rows.iter_mut().filter(|r| r.page == 3 && r.line > 1) {
                r.line_type = "surah_name".into();
                r.first_word_id = None;
                r.last_word_id = None;
            }
        },
        "page 3 line 1: a basmallah line with no ayah line after it",
    );
    check(
        &|f| {
            f.info = Some(LayoutInfo {
                pages: Some(604),
                ..LayoutInfo::default()
            })
        },
        "info.number_of_pages = 604, expected 3",
    );
    check(
        &|f| {
            f.info = Some(LayoutInfo {
                lines_per_page: Some(16),
                ..LayoutInfo::default()
            })
        },
        "info.lines_per_page = 16, expected 15",
    );

    let dir = tempfile::tempdir()?;
    for (index, (sql, needle)) in [
        (
            tiny_layout_sql().replace("1, '', '', 1)", "2, '', '', 1)"),
            "is_centered = 2, expected 0 or 1",
        ),
        (
            tiny_layout_sql().replace("surah_number INTEGER", "surah INTEGER"),
            "no surah_number column",
        ),
        (
            tiny_layout_sql().replace(" pages ", " lines "),
            "no table pages",
        ),
        (
            tiny_layout_sql().replace("(1, 1, 'surah_name'", "(1, 1, NULL"),
            "line_type is NULL",
        ),
        (
            format!(
                "{} INSERT INTO info VALUES ('x', 3, 15, 'v2');",
                tiny_layout_sql()
            ),
            "table info has 2 rows",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let path = dir.path().join(format!("bad-{index}.sqlite"));
        sqlite(&path, &sql)?;
        let message = error_text(read_layout_file(&path, &std::fs::read(&path)?));
        assert!(message.contains(needle), "{needle}\n{message}");
    }
    let message = error_text(read_layout_file(Path::new("x.json"), b"{}"));
    assert!(
        message.contains("download the layout in SQLite format"),
        "{message}"
    );
    Ok(())
}

// ---- metadata -------------------------------------------------------------------------------------------------------

fn surah_json(id: u32) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": format!("Al-Sūrah {id}"),
        "name_simple": format!("Al-Surah {id}"),
        "name_arabic": "سورة",
        "revelation_order": 115 - id,
        "revelation_place": if id.is_multiple_of(2) { "madinah" } else { "makkah" },
        "verses_count": id + 2,
        "bismillah_pre": !matches!(id, 1 | 9),
    })
}

fn records_from_json(value: &serde_json::Value) -> anyhow::Result<Vec<build::qul::Record>> {
    read_records(
        Path::new("x.json"),
        &serde_json::to_vec(value)?,
        &["unused"],
    )
}

#[test]
fn surah_names_read_from_json_and_sqlite() -> anyhow::Result<()> {
    let keyed: serde_json::Map<String, serde_json::Value> = (1..=114)
        .map(|id| (id.to_string(), surah_json(id)))
        .collect();
    let surahs = parse_surahs(
        &records_from_json(&serde_json::Value::Object(keyed.clone()))?,
        114,
    )?;
    assert_eq!(surahs.len(), 114);
    assert_eq!(
        surahs[0],
        SourceSurah {
            id: 1,
            name_ar: "سورة".into(),
            name_simple: "Al-Surah 1".into(),
            name_complex: "Al-Sūrah 1".into(),
            revelation_place: RevelationPlace::Makkah,
            revelation_order: 114,
            ayah_count: 3,
            bismillah_pre: false,
        },
        "name_complex is QUL's `name`"
    );
    assert!(surahs[1].bismillah_pre && !surahs[8].bismillah_pre);

    // QUL's SQLite export: table `chapters`, bismillah_pre as 0/1.
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("surahs.sqlite");
    let values: Vec<String> = (1..=114)
        .map(|id: u32| {
            let place = if id.is_multiple_of(2) {
                "madinah"
            } else {
                "makkah"
            };
            let bismillah = u8::from(!matches!(id, 1 | 9));
            format!(
                "({id}, 'Al-Sūrah {id}', 'Al-Surah {id}', 'سورة', {}, '{place}', {}, {bismillah})",
                115 - id,
                id + 2
            )
        })
        .collect();
    sqlite(
        &path,
        &format!(
            "CREATE TABLE chapters (id INTEGER PRIMARY KEY, name TEXT, name_simple TEXT, name_arabic TEXT,
                                    revelation_order INTEGER, revelation_place TEXT, verses_count INTEGER,
                                    bismillah_pre INTEGER);
             INSERT INTO chapters VALUES {};",
            values.join(", ")
        ),
    )?;
    let from_sqlite = parse_surahs(
        &read_records(&path, &std::fs::read(&path)?, &["chapters"])?,
        114,
    )?;
    assert_eq!(from_sqlite, surahs);

    // An array with numbers as strings reads the same.
    let array: Vec<serde_json::Value> = (1..=114)
        .map(|id| {
            let mut s = surah_json(id);
            s["verses_count"] = serde_json::Value::from((id + 2).to_string());
            s
        })
        .collect();
    assert_eq!(
        parse_surahs(&records_from_json(&serde_json::Value::from(array))?, 114)?,
        surahs
    );

    let mut cases: Vec<(serde_json::Value, &str)> = Vec::new();
    let mut short = keyed.clone();
    short.remove("114");
    cases.push((short.into(), "expected 1..=114"));
    let mut wrong_key = keyed.clone();
    wrong_key.insert("2".into(), surah_json(3));
    cases.push((wrong_key.into(), "id 3 is listed under key 2"));
    for (field, value, needle) in [
        (
            "revelation_place",
            serde_json::json!("Mecca"),
            "\"mecca\" is neither",
        ),
        (
            "bismillah_pre",
            serde_json::json!("maybe"),
            "bismillah_pre: \"maybe\" is not a boolean",
        ),
        ("name_arabic", serde_json::json!(""), "empty name_arabic"),
        (
            "verses_count",
            serde_json::json!(0),
            "surah 5 has no verses",
        ),
        (
            "revelation_order",
            serde_json::Value::Null,
            "no revelation_order",
        ),
    ] {
        let mut changed = keyed.clone();
        changed["5"][field] = value;
        cases.push((changed.into(), needle));
    }
    for (value, needle) in cases {
        let message = error_text(records_from_json(&value).and_then(|r| parse_surahs(&r, 114)));
        assert!(message.contains(needle), "{needle}\n{message}");
    }
    Ok(())
}

/// 12 ayahs: surah 1 (7) and surah 2 (5).
fn tiny_ayahs() -> Vec<AyahKey> {
    (1..=7)
        .map(|a| AyahKey::new(1, a))
        .chain((1..=5).map(|a| AyahKey::new(2, a)))
        .collect()
}

/// Three rub records over [`tiny_ayahs`] in QUL's JSON shape: 1:1–1:7, 2:1–2:3, 2:4–2:5.
fn rub_json() -> serde_json::Map<String, serde_json::Value> {
    [
        (1, "1:1", "1:7", 7, serde_json::json!({"1": "1-7"})),
        (2, "2:1", "2:3", 3, serde_json::json!({"2": "1-3"})),
        (3, "2:4", "2:5", 2, serde_json::json!({"2": "4-5"})),
    ]
    .into_iter()
    .map(|(n, first, last, count, mapping)| {
        (
            n.to_string(),
            serde_json::json!({"rub_number": n, "verses_count": count, "first_verse_key": first,
                               "last_verse_key": last, "verse_mapping": mapping}),
        )
    })
    .collect()
}

#[test]
fn divisions_read_from_json_and_sqlite() -> anyhow::Result<()> {
    let ayahs = tiny_ayahs();
    let expected = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3];
    let records = records_from_json(&rub_json().into())?;
    assert_eq!(
        division_numbers(Division::Rub, &records, &ayahs, 3)?,
        expected
    );

    // SQLite: QUL's `rub` table, verse_mapping as JSON text, rows in any order, no verses_count needed.
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("rub.sqlite");
    sqlite(
        &path,
        "CREATE TABLE rub (rub_number INTEGER PRIMARY KEY, verses_count INTEGER, first_verse_key TEXT,
                           last_verse_key TEXT, verse_mapping TEXT);
         INSERT INTO rub VALUES (3, NULL, '2:4', '2:5', '{\"2\":\"4-5\"}'), (1, 7, '1:1', '1:7', '{\"1\":\"1-7\"}'),
                                (2, 3, '2:1', '2:3', '');",
    )?;
    let records = read_records(&path, &std::fs::read(&path)?, &["rub", "rubs"])?;
    assert_eq!(
        division_numbers(Division::Rub, &records, &ayahs, 3)?,
        expected
    );

    // An array with the database column name, a mapping split over two surahs, single-ayah ranges.
    let array = serde_json::json!([
        {"rub_el_hizb_number": 1, "first_verse_key": "1:1", "last_verse_key": "2:1",
         "verse_mapping": {"1": "1-7", "2": "1"}},
        {"rub_el_hizb_number": 2, "first_verse_key": "2:2", "last_verse_key": "2:5", "verses_count": 4},
    ]);
    assert_eq!(
        division_numbers(Division::Rub, &records_from_json(&array)?, &ayahs, 2)?,
        [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2]
    );
    // Juz, hizb and manzil read the same shape with their own number field.
    let juz = serde_json::json!({"1": {"juz_number": 1, "first_verse_key": "1:1", "last_verse_key": "2:5"}});
    assert_eq!(
        division_numbers(Division::Juz, &records_from_json(&juz)?, &ayahs, 1)?,
        [1; 12]
    );
    Ok(())
}

#[test]
fn division_errors_explain_the_range() -> anyhow::Result<()> {
    let ayahs = tiny_ayahs();
    let check = |change: &dyn Fn(&mut serde_json::Map<String, serde_json::Value>), needle: &str| {
        let mut json = rub_json();
        change(&mut json);
        let message = error_text(
            records_from_json(&json.into())
                .and_then(|r| division_numbers(Division::Rub, &r, &ayahs, 3)),
        );
        assert!(message.contains(needle), "{needle}\n{message}");
    };
    check(
        &|j| {
            j["2"]["first_verse_key"] = "2:2".into();
            j["2"]["verses_count"] = 2.into();
            j["2"]["verse_mapping"] = serde_json::Value::Null;
        },
        "rub 2 starts at 2:2, expected 2:1 (a gap or an overlap with rub 1)",
    );
    check(
        &|j| {
            j["3"]["first_verse_key"] = "2:3".into();
        },
        "rub 3 starts at 2:3, expected 2:4",
    );
    check(
        &|j| {
            j["3"]["last_verse_key"] = "2:4".into();
            j["3"]["verses_count"] = 1.into();
            j["3"]["verse_mapping"] = serde_json::Value::Null;
        },
        "the last rub ends at 2:4, before the last ayah 2:5",
    );
    check(
        &|j| {
            j["1"]["verses_count"] = 6.into();
        },
        "rub 1: verses_count 6, but 1:1–1:7 holds 7 ayahs",
    );
    check(
        &|j| {
            j["2"]["verse_mapping"] = serde_json::json!({"2": "1-2"});
        },
        "rub 2: verse_mapping covers 2 ayah(s)",
    );
    check(
        &|j| {
            j["2"]["last_verse_key"] = "3:1".into();
        },
        "rub 2: last_verse_key 3:1 is not an ayah",
    );
    check(
        &|j| {
            j["3"]["rub_number"] = 4.into();
        },
        "rub_number 4 is listed under key 3",
    );
    check(
        &|j| {
            let r = j["3"].clone();
            j.insert("4".into(), r);
            j["4"]["rub_number"] = 4.into();
        },
        "rub 4 is outside 1..=3",
    );
    check(
        &|j| {
            j.remove("3");
        },
        "2 rub records, expected 3",
    );
    check(
        &|j| {
            j["1"]["first_verse_key"] = "one".into();
        },
        "first_verse_key",
    );
    check(
        &|j| {
            j["1"]["verse_mapping"] = serde_json::json!({"1": "x"});
        },
        "\"x\" is not an ayah range",
    );

    // QUL's hizb file in the rub slot: named, with its resource id.
    let hizb = serde_json::json!({
        "1": {"hizb_number": 1, "first_verse_key": "1:1", "last_verse_key": "1:7"},
        "2": {"hizb_number": 2, "first_verse_key": "2:1", "last_verse_key": "2:5"},
    });
    let message = error_text(
        records_from_json(&hizb).and_then(|r| division_numbers(Division::Rub, &r, &ayahs, 3)),
    );
    assert!(
        message.contains("2 rub records, expected 3 (its records carry hizb_number: this looks like QUL's \"Hizb\" \
                          metadata, resource 67, not \"Rub\", resource 63)"),
        "{message}"
    );
    let array =
        serde_json::json!([{"juz_number": 1, "first_verse_key": "1:1", "last_verse_key": "2:5"}]);
    let message = error_text(
        records_from_json(&array).and_then(|r| division_numbers(Division::Manzil, &r, &ayahs, 1)),
    );
    assert!(
        message.contains("no manzil_number field") && message.contains("\"Juz\""),
        "{message}"
    );
    Ok(())
}
