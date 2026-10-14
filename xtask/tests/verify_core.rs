//! End to end: `cargo xtask verify-core` on the real core.db, and on copies that each carry one targeted corruption.
//!
//! - Every gate must pass on the real build, and the JSON report must have its expected shape.
//! - Each corruption must fail exactly the gate(s) that own the broken invariant, with a check that names the damage.
//!   This shows that each gate catches its own failure and stays quiet about the others'.
//!
//! The database is `QD_CORE_DB` (relative to the workspace root), else `src-tauri/resources/core.db`. It and the Tanzil
//! cache are gitignored QF/Tanzil content, never in CI. Without them, each real-data test reports that it was skipped
//! and passes; build them with `pnpm core:qdc`. The CLI tests at the end need no data.
//!
//! G15 measures time. Under heavy machine load a timing check can fail for reasons a corruption has nothing to do with,
//! so the corruption tests leave G15 out of their exact-set comparison; the real-build test retries once on a G15-only
//! failure. Every test verifies a private copy, so the shared core.db is never held open for long.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rusqlite::Connection;
use serde_json::Value;

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from(".."), Path::to_path_buf)
}

/// The real core.db, or `None` (with the reason printed) when there is none to test.
fn real_db() -> Option<PathBuf> {
    let root = workspace_root();
    let db = std::env::var_os("QD_CORE_DB").map_or_else(
        || root.join("src-tauri").join("resources").join("core.db"),
        |value| root.join(value),
    );
    let tanzil = [
        root.join("data")
            .join("cache")
            .join("tanzil")
            .join("quran-data.xml"),
        root.join("data")
            .join("sources")
            .join("qul")
            .join("quran-data.xml"),
        root.join("data")
            .join("sources")
            .join("tanzil")
            .join("quran-data.xml"),
    ];
    match std::fs::metadata(&db) {
        Ok(m) if m.len() > 0 && tanzil.iter().any(|p| p.is_file()) => Some(db),
        Ok(m) if m.len() > 0 => {
            eprintln!("SKIPPED: no Tanzil quran-data.xml under data/ (run `pnpm core:qdc`)");
            None
        }
        _ => {
            eprintln!(
                "SKIPPED: {} is missing or the 0-byte build.rs placeholder (run `pnpm core:qdc`)",
                db.display()
            );
            None
        }
    }
}

/// `xtask verify-core --db <db> --report <report>`.
fn verify_core(db: &Path, report: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("verify-core")
        .arg("--db")
        .arg(db)
        .arg("--report")
        .arg(report)
        .output()
        .expect("run xtask verify-core")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn read_report(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("the report {} was not written: {e}", path.display()));
    serde_json::from_str(&text).expect("the report is JSON")
}

fn failed_gates(report: &Value) -> BTreeSet<String> {
    report["gates"]
        .as_array()
        .expect("gates")
        .iter()
        .filter(|g| g["passed"] != Value::Bool(true))
        .map(|g| g["id"].as_str().expect("id").to_owned())
        .collect()
}

/// `"{check name}: {detail}"` of every failed check of `gate`.
fn failed_checks(report: &Value, gate: &str) -> Vec<String> {
    report["gates"]
        .as_array()
        .expect("gates")
        .iter()
        .filter(|g| g["id"] == gate)
        .flat_map(|g| g["checks"].as_array().cloned().unwrap_or_default())
        .filter(|c| c["passed"] != Value::Bool(true))
        .map(|c| {
            format!(
                "{}: {}",
                c["name"].as_str().unwrap_or_default(),
                c["detail"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

#[test]
fn the_real_core_db_passes_every_gate() {
    let Some(source) = real_db() else { return };
    // A private copy: the shared core.db is held open only for the copy, never while another package's build-core
    // renames a new one over it.
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    std::fs::copy(&source, &db).unwrap();
    let report_path = dir.path().join("nested").join("verify-core.json");
    let mut output = verify_core(&db, &report_path);
    let mut report = read_report(&report_path);
    if !output.status.success() && failed_gates(&report) == BTreeSet::from(["G15".to_owned()]) {
        eprintln!(
            "G15 alone failed (machine load?), retrying once:\n{}",
            stderr(&output)
        );
        output = verify_core(&db, &report_path);
        report = read_report(&report_path);
    }
    assert!(output.status.success(), "{}", stderr(&output));
    let log = stderr(&output);
    assert!(log.contains("18/18 gates passed"), "{log}");

    // The report's shape.
    assert_eq!(report["passed"], Value::Bool(true));
    assert_eq!(report["summary"]["gates"], 18);
    assert_eq!(report["summary"]["passed"], 18);
    assert_eq!(report["summary"]["failed"], Value::Array(Vec::new()));
    assert_eq!(report["meta"]["schema_version"], "1");
    assert_eq!(report["meta"]["ayah_count"], "6236");
    assert!(report["sha256"].as_str().is_some_and(|s| s.len() == 64));
    assert!(report["inputs"]["tanzil"]["path"].is_string());
    let gates = report["gates"].as_array().unwrap();
    let ids: Vec<&str> = gates.iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "G1", "G2", "G3", "G4", "G5", "G5b", "G6", "G7", "G8", "G9", "G10", "G11", "G11b",
            "G12", "G13", "G14", "G15", "G16"
        ]
    );
    for gate in gates {
        assert!(
            gate["checks"].as_array().is_some_and(|c| !c.is_empty()),
            "{gate}"
        );
        assert!(gate["invariant"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(gate["durationMs"].is_number());
        assert!(gate["error"].is_null(), "{gate}");
    }

    // The facts the gates report about the QDC build.
    if report["meta"]["source"] == "qdc" {
        let fact = |gate: &str, key: &str| -> Value {
            gates
                .iter()
                .find(|g| g["id"] == gate)
                .map(|g| g["facts"][key].clone())
                .unwrap_or(Value::Null)
        };
        assert_eq!(fact("G1", "endMarkers"), 6236);
        assert_eq!(fact("G4", "multiCharCodeV1"), 4580);
        assert_eq!(fact("G4", "multiCharCodeV2"), 4517);
        assert_eq!(fact("G4", "codesWithSpaceV1"), 198);
        assert_eq!(fact("G5b", "rubSignWords"), 199);
        assert_eq!(
            fact("G5b", "compoundWords"),
            serde_json::json!(["2:181:3", "8:6:4", "13:37:8", "37:130:3"])
        );
        assert_eq!(
            fact("G5b", "sajdaSpaceWords").as_array().map(Vec::len),
            Some(9)
        );
        assert_eq!(
            fact("G8", "v2SurahNameOnPreviousPage")
                .as_array()
                .map(Vec::len),
            Some(18)
        );
        assert_eq!(
            fact("G8", "v1SurahNameOnPreviousPage")
                .as_array()
                .map(Vec::len),
            Some(21)
        );
        assert_eq!(
            fact("G8", "v4SurahNameOnPreviousPage"),
            serde_json::json!([])
        );
        assert_eq!(fact("G9", "v2CentredAyahLines"), 16);
        assert_eq!(fact("G10", "v1TanzilPageStartsMatched"), 604);
        assert_eq!(
            fact("G11", "rubDifferencesFromTanzil"),
            serde_json::json!(["rub 106: 15:49 / 15:50"])
        );
        assert_eq!(fact("G11", "inlineRubSigns"), 199);
        assert_eq!(
            fact("G11b", "sajdaWords").as_array().map(Vec::len),
            Some(15)
        );
        assert_eq!(fact("G15", "queries"), 2416);
    }
}

/// Copies the real core.db, applies `sql`, runs verify-core and checks that exactly `expected` failed (G15 aside),
/// with a failed check of `expected[0]` that contains `needle`.
fn assert_corruption_fails(sql: &str, expected: &[&str], needle: &str) {
    let Some(db) = real_db() else { return };
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("core.db");
    std::fs::copy(&db, &copy).unwrap();
    {
        let conn = Connection::open(&copy).unwrap();
        conn.execute_batch(sql)
            .unwrap_or_else(|e| panic!("apply {sql}: {e}"));
    }
    let report_path = dir.path().join("report.json");
    let output = verify_core(&copy, &report_path);
    let log = stderr(&output);
    assert!(!output.status.success(), "the corruption passed:\n{log}");
    let report = read_report(&report_path);
    assert_eq!(report["passed"], Value::Bool(false));
    let mut failed = failed_gates(&report);
    failed.remove("G15");
    let expected_set: BTreeSet<String> = expected.iter().map(|s| (*s).to_owned()).collect();
    assert_eq!(failed, expected_set, "{log}");
    let first = expected.first().copied().unwrap_or_default();
    let checks = failed_checks(&report, first);
    assert!(
        checks.iter().any(|c| c.contains(needle)),
        "no failed {first} check mentions {needle:?}: {checks:#?}"
    );
    assert!(
        log.contains(&format!("FAIL {first:<5}")),
        "the console names the failed gate:\n{log}"
    );
}

macro_rules! corruption {
    ($($name:ident: $sql:expr => [$($gate:literal),+], $needle:literal;)+) => {
        $(
            #[test]
            fn $name() {
                assert_corruption_fails($sql, &[$($gate),+], $needle);
            }
        )+
    };
}

/// Recomputes `ayah.text_hafs` of ayah 1 from its words (keeps G5's join invariant while a word text changes).
const REJOIN_1_1: &str = "UPDATE ayah SET text_hafs = (SELECT group_concat(w.text_hafs, ' ' ORDER BY w.id) FROM word w \
                          WHERE w.ayah_id = ayah.id) WHERE id = 1;";

corruption! {
    g1_a_surah_ayah_count_that_differs_from_tanzil:
        "UPDATE surah SET ayah_count = 8 WHERE id = 1;" => ["G1"], "surah 1: 7 ayah rows";
    g1_meta_counts:
        "UPDATE meta SET value = '6235' WHERE key = 'ayah_count';" => ["G1"], "meta.ayah_count";
    g2_a_gap_in_the_positions_of_an_ayah:
        "UPDATE word SET position = 6 WHERE id = 5;" => ["G2"], "1:1: positions [1, 2, 3, 4, 6]";
    g3_an_ayah_range_that_misses_its_end_marker:
        "UPDATE ayah SET last_word_id = 4 WHERE id = 1;" => ["G3"], "1:1: first/last_word_id 1..=4";
    g4_a_space_inside_a_plain_glyph_code:
        "UPDATE word SET code_v2 = code_v2 || ' ' || code_v2 WHERE id = 1;" => ["G4"], "1:1:1 code_v2";
    g4_the_combined_exporter_grouping_of_38_24_32:
        "UPDATE word SET code_v1 = char(64489) WHERE surah = 38 AND ayah = 24 AND position = 32;"
            => ["G4"], "canonical V1 grouping";
    g5_an_end_marker_with_the_wrong_number:
        "UPDATE word SET text_hafs = char(1757) || '٢' WHERE id = 5;" => ["G5"], "1:1:5";
    g5b_an_unexplained_space_inside_a_word:
        &format!("UPDATE word SET text_hafs = substr(text_hafs, 1, 2) || ' ' || substr(text_hafs, 3) WHERE id = 1; {REJOIN_1_1}")
            => ["G5b"], "1:1:1";
    g6_a_mushaf_row_with_16_lines:
        "UPDATE mushaf SET lines_per_page = 16 WHERE id = 19;" => ["G6"], "mushaf rows";
    g7_a_page_row_that_disagrees_with_its_lines:
        "UPDATE page SET last_ayah_id = last_ayah_id + 1 WHERE mushaf_id = 1 AND page = 100;" => ["G7"], "page 100";
    g8_a_basmallah_typed_as_a_surah_name:
        "UPDATE line SET kind = 1 WHERE mushaf_id = 1 AND kind = 2 AND surah_id = 3;" => ["G8"], "v2: surah_name / basmallah lines";
    g9_a_listed_v2_line_that_is_not_centred:
        "UPDATE line SET centered = 0 WHERE mushaf_id = 1 AND page = 255 AND line = 2;" => ["G9"], "missing [255:2]";
    g10_a_v4_page_that_starts_inside_an_ayah:
        "UPDATE line SET last_word_id = last_word_id - 1 WHERE mushaf_id = 19 AND page = 10 AND line = 15;
         UPDATE line SET first_word_id = first_word_id - 1 WHERE mushaf_id = 19 AND page = 11 AND line = 1;
         UPDATE page SET last_word_id = last_word_id - 1,
                         last_ayah_id = (SELECT ayah_id FROM word WHERE id = page.last_word_id - 1)
          WHERE mushaf_id = 19 AND page = 10;
         UPDATE page SET first_word_id = first_word_id - 1,
                         first_ayah_id = (SELECT ayah_id FROM word WHERE id = page.first_word_id - 1)
          WHERE mushaf_id = 19 AND page = 11;" => ["G10"], "page 11 starts with";
    g11_an_ayah_in_the_wrong_juz:
        "UPDATE ayah SET juz = 2 WHERE id = 148;" => ["G11"], "ayah.juz";
    g11_a_recommended_sajda_marked_obligatory:
        "UPDATE sajda SET kind = 'obligatory' WHERE id = 1;
         UPDATE ayah SET sajda = 2 WHERE id = (SELECT ayah_id FROM sajda WHERE id = 1);" => ["G11"], "obligatory sajdas";
    g11b_a_sajda_sign_outside_the_sajda_table:
        &format!("UPDATE word SET text_hafs = text_hafs || char(1769) WHERE id = 1; {REJOIN_1_1}") => ["G11b"], "1:1";
    g12_vocab_loose_that_lost_terms:
        "DELETE FROM vocab_loose WHERE term IN (SELECT term FROM vocab_loose ORDER BY term LIMIT 10);" => ["G12"], "missing from vocab_loose";
    g13_a_stale_normalizer_version:
        "UPDATE meta SET value = '2' WHERE key = 'normalizer_version';" => ["G13"], "normalizer_version";
    g13_a_word_norm_that_is_not_normalize_ar:
        "UPDATE word SET norm_loose = 'x' WHERE id = 1;" => ["G13"], "1:1:1";
    g14_an_index_that_core_sql_does_not_have:
        "CREATE INDEX extra_word_text ON word (text_hafs);" => ["G14"], "extra_word_text";
    g16_a_header_code_point_that_differs_from_the_map:
        "UPDATE surah SET header_cp = 64000 WHERE id = 50;" => ["G16"], "surah 50";
}

#[test]
fn rejoining_ayah_1_on_its_own_changes_nothing() {
    // The helper of the G5b and G11b corruptions: without a word change, ayah 1 stays byte-identical, so those tests
    // only break the invariant they target.
    let Some(db) = real_db() else { return };
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("core.db");
    std::fs::copy(&db, &copy).unwrap();
    let conn = Connection::open(&copy).unwrap();
    let before: String = conn
        .query_row("SELECT text_hafs FROM ayah WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    conn.execute_batch(REJOIN_1_1).unwrap();
    let after: String = conn
        .query_row("SELECT text_hafs FROM ayah WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}

// ---- CLI behaviour without real data --------------------------------------------------------------------------------

#[test]
fn a_missing_database_is_an_error_without_a_report() {
    let dir = tempfile::tempdir().unwrap();
    let report = dir.path().join("report.json");
    let output = verify_core(&dir.path().join("absent.db"), &report);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("pnpm core:qdc"),
        "{}",
        stderr(&output)
    );
    assert!(!report.exists());
}

#[test]
fn the_build_rs_placeholder_fails_every_gate_and_still_writes_the_report() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    std::fs::write(&db, b"").unwrap();
    let report_path = dir.path().join("report.json");
    let output = verify_core(&db, &report_path);
    assert!(!output.status.success());
    let log = stderr(&output);
    assert!(
        log.contains("18 of 18 verify-core gates failed") && log.contains("placeholder"),
        "{log}"
    );
    let report = read_report(&report_path);
    assert_eq!(report["passed"], Value::Bool(false));
    assert_eq!(failed_gates(&report).len(), 18);
    assert_eq!(report["bytes"], 0);
    // The file was opened read-only: verify-core never writes to the database.
    assert_eq!(std::fs::metadata(&db).unwrap().len(), 0);
}
