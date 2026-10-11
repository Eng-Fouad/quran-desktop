//! `cargo xtask verify-core`: the G1–G16 gates of docs/ARCHITECTURE.md §4.5 (G5b and G11b included) on a built
//! core.db, and the JSON report (`--report`). Owner: WP3b.
//!
//! `build-core` runs [`verify_db`] on `<out>.tmp` before the rename, so a database that fails a gate never replaces
//! core.db. `verify-core` runs the same gates on any file.
//!
//! How it works:
//! - The database is opened read-only and read once into a [`Snapshot`] (every row of every table except the FTS
//!   index). Most gates are pure functions of the snapshot, so they are independent of each other and unit-testable;
//!   G12, G14 and G15 also query SQLite itself (FTS, pragmas, the page query's plan and timing).
//! - Inputs besides the database: Tanzil `quran-data.xml` (G1, G10, G11), found by its sha256 in
//!   `meta.tanzil_sha256` ([`find_tanzil_in`]); `xtask/data/division_exceptions.toml` (G11); and
//!   `xtask/data/qcf_surah_header_cmap.json` (G16).
//! - Every gate runs, even after an earlier one failed. Each records named checks, facts (counts and lists for the
//!   report) and warnings. The run fails when any check of any gate fails.
//! - The spec's expected values are restated here, independently of the build's own constants: counts, the V2 centred
//!   lines, the 25 V1/V2 page-start differences, the obligatory sajdas and the header code points. A wrong constant in
//!   the build therefore cannot hide behind the same constant in its gate.
//!
//! Source facts the gates accept, verified on the QDC build and recorded in docs/deviations/WP3b.md:
//! - **G4:** a glyph code may hold one inner U+0020 in a word that opens with the printed rub sign `"۞ "`, and in the
//!   [`CODE_SPACE_WORDS`] (8:6:4, 36:52:6, 37:130:3).
//! - **G5b:** inside a word's `text_hafs`, U+0020 may precede ۩; it may end the printed rub sign `"۞ "`; and it may
//!   join the two halves of the [`COMPOUND_WORDS`] (2:181:3, 8:6:4, 13:37:8, 37:130:3).
//! - **G8:** in a two-line header, the `surah_name` may be the last line of the previous page, while the basmallah
//!   opens the page of the first ayah (V2 18 surahs, V1 21, V4 none).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, ensure};
use quran_core::core_db::PAGE_SQL;
use quran_core::{CORE_SCHEMA_VERSION, CORE_SQL, Level, NORMALIZER_VERSION, normalize_ar};
use quran_types::MushafStyle;
use rusqlite::types::FromSql;
use rusqlite::{Connection, OpenFlags, Params, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::build::derive::{DivisionExceptions, HeaderMap, RubException};
use crate::build::model::AyahKey;
use crate::build::tanzil::{SajdaKind, Tanzil};
use crate::cli::VerifyCoreArgs;

// ---- the spec's expected values (§3.1, §4.4, §4.5, FACT) ----------------------------------------------------------

const SURAHS: u32 = 114;
const AYAHS: u32 = 6_236;
const WORDS: u32 = 83_665;
/// Words that are not end markers.
const PLAIN_WORDS: usize = 77_429;
const PAGES: u32 = 604;
/// Lines on pages 1–2 (§4.4 rule 2) and on every other page.
const OPENING_PAGE_LINES: u32 = 8;
const LINES_PER_PAGE: u32 = 15;
/// `line.kind`.
const KIND_AYAH: u32 = 0;
const KIND_SURAH_NAME: u32 = 1;
const KIND_BASMALLAH: u32 = 2;
/// `(mushaf_id, code, glyph_column)` of the three layouts (§3.1.1; v4 uses the V2 codes, FACT C4).
const MUSHAFS: [(u32, &str, &str); 3] = [
    (1, "v2", "code_v2"),
    (2, "v1", "code_v1"),
    (19, "v4", "code_v2"),
];
const V2: u32 = 1;
const V1: u32 = 2;
const V4: u32 = 19;

/// QCF glyph codes are 1–4 chars (FACT C5, G4).
const MAX_GLYPH_CHARS: usize = 4;
/// FACT C5: words whose `code_v1` / `code_v2` has more than one char (G4 reports, warns when different).
const FACT_C5_MULTI_CHAR: (usize, usize) = (4_580, 4_517);
/// D5: the canonical V1 grouping of 38:24:32–33.
const D5_CODE_V1: [(u32, &str); 2] = [(32, "\u{FBE9}\u{FBEA}"), (33, "\u{FBEB}")];
/// Words whose glyph codes hold one inner U+0020 without being rub-start words (verified in the QDC build: the code
/// keeps the printed space between two glyph groups).
const CODE_SPACE_WORDS: [(u32, u32, u32); 3] = [(8, 6, 4), (36, 52, 6), (37, 130, 3)];
/// Words whose `text_hafs` joins two parts with a U+0020 (`بَعۡدَ مَا`, `إِلۡ يَاسِينَ`; verified in the QDC build).
const COMPOUND_WORDS: [(u32, u32, u32); 4] = [(2, 181, 3), (8, 6, 4), (13, 37, 8), (37, 130, 3)];
/// G5b: the 9 sajda words whose ۩ follows a space in the QDC QPC text (§4.5; report only, other sources may differ).
const SAJDA_SPACE_WORDS: [&str; 9] = [
    "17:109:5", "19:58:29", "22:18:37", "22:77:11", "25:60:13", "32:15:15", "38:24:32", "41:38:12",
    "84:21:6",
];
/// G9: V2 ayah lines centred besides pages 1–2 (FACT §2.3).
const V2_CENTRED: [(u32, &[u32]); 11] = [
    (255, &[2]),
    (528, &[9]),
    (534, &[6]),
    (545, &[6]),
    (586, &[1]),
    (593, &[2]),
    (594, &[5]),
    (600, &[10]),
    (602, &[5, 15]),
    (603, &[10, 15]),
    (604, &[4, 9, 14, 15]),
];
/// G10: the pages where the V1 and V2 first words differ (FACT C2).
const V1_V2_DIFFERENT_STARTS: [u32; 25] = [
    121, 122, 123, 145, 532, 533, 534, 565, 568, 570, 576, 584, 586, 588, 589, 590, 592, 593, 594,
    595, 596, 597, 598, 599, 600,
];
/// G11: the division tables and their row counts.
const DIVISION_COUNTS: [(&str, usize); 6] = [
    ("juz", 30),
    ("hizb", 60),
    ("rub", 240),
    ("manzil", 7),
    ("ruku", 556),
    ("sajda", 15),
];
/// G11: the obligatory sajdas.
const OBLIGATORY_SAJDAS: [(u32, u32); 4] = [(32, 15), (41, 38), (53, 62), (96, 19)];
/// G12: `vocab_loose` row count.
const VOCAB_TERMS: std::ops::RangeInclusive<usize> = 14_000..=15_500;
/// G14: the shipped file stays below 16 MiB.
const MAX_DB_BYTES: u64 = 16 * 1024 * 1024;
/// G14: `PRAGMA page_size` of core.sql.
const PAGE_SIZE: u32 = 4_096;
/// G14: `meta` keys (§3.1.1).
const META_KEYS: [&str; 10] = [
    "ayah_count",
    "builder",
    "built_at",
    "licence_note",
    "normalizer_version",
    "schema_version",
    "source",
    "source_manifest_sha256",
    "tanzil_sha256",
    "word_count",
];
/// G15: the required plan of the page query (§3.1.4), in order. SQLite 3.53 appends ` LEFT-JOIN` to the detail of
/// the two outer-joined steps; [`normalise_plan`] removes it.
const PAGE_PLAN: [&str; 3] = [
    "SEARCH l USING PRIMARY KEY (mushaf_id=? AND page=?)",
    "SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)",
    "SEARCH a USING INTEGER PRIMARY KEY (rowid=?)",
];
/// G15: the page the plan is explained for.
const PLAN_PAGE: u32 = 262;
/// G15: p99 budget of one page query (§3.5).
const PAGE_QUERY_P99: Duration = Duration::from_millis(5);
/// G16: `surah.header_cp` of surahs 1 and 114 (§3.1.2).
const HEADER_CP: [(u32, u32); 2] = [(1, 0xFC45), (114, 0xFBEB)];

/// U+06DD ARABIC END OF AYAH.
const END_OF_AYAH: char = '\u{06DD}';
/// U+06E9 ARABIC PLACE OF SAJDAH (۩).
const SAJDA_SIGN: char = '\u{06E9}';
/// U+06DE ARABIC START OF RUB EL HIZB (۞).
const RUB_SIGN: char = '\u{06DE}';
/// The inline rub sign as printed before a rub-start word.
const RUB_PREFIX: &str = "\u{06DE} ";
/// `ayah.flags` (§3.1.2).
const FLAG_RUB_START: u32 = 1;
const FLAG_HIZB_START: u32 = 2;
const FLAG_JUZ_START: u32 = 4;
const FLAG_SURAH_START: u32 = 8;

/// Examples kept per failing check.
const MAX_SAMPLES: usize = 8;

/// `xtask/data/` file names.
const EXCEPTIONS_FILE: &str = "division_exceptions.toml";
const HEADER_MAP_FILE: &str = "qcf_surah_header_cmap.json";

// ---- entry points -------------------------------------------------------------------------------------------------

pub fn run(args: &VerifyCoreArgs) -> anyhow::Result<()> {
    verify_db(&args.db(), args.report.as_deref())
}

/// Runs every gate on `db` and writes the JSON report when `report` is given; any failing gate is an error. Tanzil is
/// found by `meta.tanzil_sha256` among the known locations ([`tanzil_candidates`]).
pub fn verify_db(db: &Path, report: Option<&Path>) -> anyhow::Result<()> {
    verify_db_with(db, report, None)
}

/// [`verify_db`] with the Tanzil file the build used. `build-core` knows that file, so a build with its own `--cache`
/// is checked against the right file; with `None` the file is looked up. Either way its sha256 must equal
/// `meta.tanzil_sha256`.
pub fn verify_db_with(
    db: &Path,
    report: Option<&Path>,
    tanzil: Option<&Path>,
) -> anyhow::Result<()> {
    let outcome = verify(db, tanzil)?;
    print_outcome(&outcome);
    if let Some(path) = report {
        write_report(path, &outcome)?;
        eprintln!("verify-core: report written to {}", path.display());
    }
    let failed = outcome.failed_gates();
    ensure!(
        failed.is_empty(),
        "{} of {} verify-core gates failed on {}: {}{}",
        failed.len(),
        outcome.gates.len(),
        db.display(),
        failed.join(", "),
        if outcome.bytes == 0 {
            " (a 0-byte file is the build.rs placeholder: run `pnpm core:qdc`)"
        } else {
            ""
        }
    );
    Ok(())
}

/// Opens `db` read-only, loads the inputs and runs every gate. Fails only when the file cannot be opened at all.
fn verify(db: &Path, tanzil: Option<&Path>) -> anyhow::Result<Outcome> {
    let started = Instant::now();
    let metadata = std::fs::metadata(db).with_context(|| {
        format!(
            "{} cannot be read (build it with `pnpm core:qdc`)",
            db.display()
        )
    })?;
    ensure!(metadata.is_file(), "{} is not a file", db.display());
    let bytes = metadata.len();
    let sha256 = hex::encode(Sha256::digest(
        std::fs::read(db).with_context(|| format!("read {}", db.display()))?,
    ));
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {} read-only", db.display()))?;

    let meta = read_meta(&conn).unwrap_or_default();
    let snapshot = Snapshot::load(&conn).map_err(|e| format!("{e:#}"));
    let tanzil = match meta.get("tanzil_sha256") {
        None => Err(
            "meta.tanzil_sha256 is missing, so the Tanzil file the build used is unknown"
                .to_owned(),
        ),
        Some(sha) => match tanzil {
            Some(path) => find_tanzil_in(&[path.to_path_buf()], sha),
            None => find_tanzil_in(&tanzil_candidates(), sha),
        },
    };
    let data = crate::build::data_dir();
    let exceptions_path = data.join(EXCEPTIONS_FILE);
    let header_map_path = data.join(HEADER_MAP_FILE);
    let exceptions = DivisionExceptions::load(&exceptions_path).map_err(|e| format!("{e:#}"));
    let headers = HeaderMap::load(&header_map_path).map_err(|e| format!("{e:#}"));

    let inputs = InputsReport {
        tanzil: match &tanzil {
            Ok((path, t)) => InputReport::ok(path, Value::String(t.sha256.clone())),
            Err(e) => InputReport::error(e),
        },
        division_exceptions: match &exceptions {
            Ok(x) => InputReport::ok(
                &exceptions_path,
                Value::from(
                    x.rub
                        .iter()
                        .map(|r| format!("rub {}: source {} / tanzil {}", r.id, r.source, r.tanzil))
                        .collect::<Vec<_>>(),
                ),
            ),
            Err(e) => InputReport::error(e),
        },
        header_map: match &headers {
            Ok(Some(_)) => InputReport::ok(&header_map_path, Value::from("present")),
            Ok(None) => InputReport::ok(&header_map_path, Value::from("absent")),
            Err(e) => InputReport::error(e),
        },
    };
    let ctx = Ctx {
        conn: &conn,
        bytes,
        snapshot,
        tanzil: tanzil.map(|(_, t)| t),
        exceptions,
        headers,
    };
    let gates = run_gates(&ctx);
    Ok(Outcome {
        db: db.to_path_buf(),
        bytes,
        sha256,
        meta,
        inputs,
        gates,
        duration: started.elapsed(),
    })
}

// ---- inputs -------------------------------------------------------------------------------------------------------

/// Where a Tanzil `quran-data.xml` may be, in lookup order: the qdc cache (§4.2), the file the QUL manifest names
/// (§4.3), then `data/sources/{qul,tanzil}/quran-data.xml`.
fn tanzil_candidates() -> Vec<PathBuf> {
    let root = crate::cli::workspace_root();
    let qul = root.join("data").join("sources").join("qul");
    let mut candidates = vec![
        root.join("data")
            .join("cache")
            .join("tanzil")
            .join("quran-data.xml"),
    ];
    if let Some(file) = qul_manifest_tanzil_file(&qul.join("manifest.toml")) {
        candidates.push(qul.join(file));
    }
    candidates.push(qul.join("quran-data.xml"));
    candidates.push(
        root.join("data")
            .join("sources")
            .join("tanzil")
            .join("quran-data.xml"),
    );
    let mut seen = BTreeSet::new();
    candidates.retain(|p| seen.insert(p.clone()));
    candidates
}

#[derive(Deserialize)]
struct QulManifest {
    tanzil: Option<ManifestEntry>,
}

#[derive(Deserialize)]
struct ManifestEntry {
    file: String,
}

/// The `tanzil.file` of `data/sources/qul/manifest.toml` when the manifest exists, parses and names a plain file.
fn qul_manifest_tanzil_file(manifest: &Path) -> Option<String> {
    let text = std::fs::read_to_string(manifest).ok()?;
    let file = toml::from_str::<QulManifest>(&text).ok()?.tanzil?.file;
    // A plain file name inside data/sources/qul/, never a path elsewhere.
    (Path::new(&file).file_name().and_then(|n| n.to_str()) == Some(file.as_str())).then_some(file)
}

/// The first candidate whose sha256 is `expected_sha256`, parsed and validated.
fn find_tanzil_in(
    candidates: &[PathBuf],
    expected_sha256: &str,
) -> Result<(PathBuf, Tanzil), String> {
    let mut tried = Vec::new();
    for path in candidates {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tried.push(format!("{} (absent)", path.display()));
                continue;
            }
            Err(e) => {
                tried.push(format!("{} ({e})", path.display()));
                continue;
            }
        };
        let sha = hex::encode(Sha256::digest(&bytes));
        if !sha.eq_ignore_ascii_case(expected_sha256) {
            tried.push(format!("{} (sha256 {sha})", path.display()));
            continue;
        }
        return Tanzil::parse(&bytes)
            .map(|t| (path.clone(), t))
            .map_err(|e| format!("{}: {e:#}", path.display()));
    }
    Err(format!(
        "no Tanzil quran-data.xml with sha256 {expected_sha256} (meta.tanzil_sha256); tried {}",
        tried.join(", ")
    ))
}

fn read_meta(conn: &Connection) -> anyhow::Result<BTreeMap<String, String>> {
    Ok(
        rows(conn, "SELECT key, value FROM meta ORDER BY key", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .into_iter()
        .collect(),
    )
}

/// Every row of a query.
fn rows<T, P: Params>(
    conn: &Connection,
    sql: &str,
    params: P,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> anyhow::Result<Vec<T>> {
    let mut stmt = conn.prepare(sql).with_context(|| sql.to_owned())?;
    let out = stmt
        .query_map(params, map)
        .and_then(Iterator::collect::<rusqlite::Result<Vec<T>>>)
        .with_context(|| sql.to_owned())?;
    Ok(out)
}

/// The first column of every row.
fn column<T: FromSql, P: Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> anyhow::Result<Vec<T>> {
    rows(conn, sql, params, |r| r.get(0))
}

// ---- the snapshot -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct MushafRow {
    id: u32,
    code: String,
    name: String,
    pages: u32,
    lines_per_page: u32,
    glyph_column: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SurahRow {
    id: u32,
    name_en: String,
    ayah_count: u32,
    first_ayah_id: u32,
    rukus: u32,
    bismillah_pre: u32,
    header_cp: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AyahRow {
    id: u32,
    surah: u32,
    ayah: u32,
    juz: u32,
    hizb: u32,
    rub: u32,
    manzil: u32,
    ruku: u32,
    sajda: u32,
    flags: u32,
    first_word_id: u32,
    last_word_id: u32,
    text_hafs: String,
    text_imlaei: String,
    norm_loose: String,
    norm_strict: String,
}

impl AyahRow {
    const fn key(&self) -> AyahKey {
        AyahKey::new(self.surah, self.ayah)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WordRow {
    id: u32,
    ayah_id: u32,
    surah: u32,
    ayah: u32,
    position: u32,
    is_end: bool,
    text_hafs: String,
    text_imlaei: Option<String>,
    norm_loose: Option<String>,
    code_v1: String,
    code_v2: String,
}

impl WordRow {
    fn location(&self) -> String {
        format!("{}:{}:{}", self.surah, self.ayah, self.position)
    }

    const fn triple(&self) -> (u32, u32, u32) {
        (self.surah, self.ayah, self.position)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PageRow {
    mushaf_id: u32,
    page: u32,
    first_word_id: u32,
    last_word_id: u32,
    first_ayah_id: u32,
    last_ayah_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LineRow {
    mushaf_id: u32,
    page: u32,
    line: u32,
    kind: u32,
    centered: bool,
    surah_id: Option<u32>,
    first_word_id: Option<u32>,
    last_word_id: Option<u32>,
}

impl LineRow {
    fn at(&self) -> String {
        format!("{}:{}", self.page, self.line)
    }
}

/// A row of `juz`, `hizb`, `rub`, `manzil` or `ruku` (`surah` only for ruku).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RangeRow {
    id: u32,
    surah: Option<u32>,
    first_ayah_id: u32,
    last_ayah_id: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SajdaRow {
    id: u32,
    ayah_id: u32,
    kind: String,
}

/// Every row of core.db except the FTS index, in primary-key order.
#[derive(Clone, Debug, Default)]
struct Snapshot {
    meta: BTreeMap<String, String>,
    mushafs: Vec<MushafRow>,
    surahs: Vec<SurahRow>,
    ayahs: Vec<AyahRow>,
    words: Vec<WordRow>,
    /// `(mushaf_id, page)` order.
    pages: Vec<PageRow>,
    /// `(mushaf_id, page, line)` order: reading order within a layout.
    lines: Vec<LineRow>,
    juz: Vec<RangeRow>,
    hizb: Vec<RangeRow>,
    rub: Vec<RangeRow>,
    manzil: Vec<RangeRow>,
    ruku: Vec<RangeRow>,
    sajda: Vec<SajdaRow>,
    /// `(surah, ayah)` → ayah id.
    ayah_ids: BTreeMap<(u32, u32), u32>,
}

impl Snapshot {
    fn load(conn: &Connection) -> anyhow::Result<Self> {
        let ranges = |table: &str| -> anyhow::Result<Vec<RangeRow>> {
            rows(
                conn,
                &format!("SELECT id, first_ayah_id, last_ayah_id FROM {table} ORDER BY id"),
                [],
                |r| {
                    Ok(RangeRow {
                        id: r.get(0)?,
                        surah: None,
                        first_ayah_id: r.get(1)?,
                        last_ayah_id: r.get(2)?,
                    })
                },
            )
        };
        let mut snapshot = Self {
            meta: read_meta(conn)?,
            mushafs: rows(
                conn,
                "SELECT id, code, name, pages, lines_per_page, glyph_column FROM mushaf ORDER BY id",
                [],
                |r| {
                    Ok(MushafRow {
                        id: r.get(0)?,
                        code: r.get(1)?,
                        name: r.get(2)?,
                        pages: r.get(3)?,
                        lines_per_page: r.get(4)?,
                        glyph_column: r.get(5)?,
                    })
                },
            )?,
            surahs: rows(
                conn,
                "SELECT id, name_en, ayah_count, first_ayah_id, rukus, bismillah_pre, header_cp FROM surah ORDER BY id",
                [],
                |r| {
                    Ok(SurahRow {
                        id: r.get(0)?,
                        name_en: r.get(1)?,
                        ayah_count: r.get(2)?,
                        first_ayah_id: r.get(3)?,
                        rukus: r.get(4)?,
                        bismillah_pre: r.get(5)?,
                        header_cp: r.get(6)?,
                    })
                },
            )?,
            ayahs: rows(
                conn,
                "SELECT id, surah, ayah, juz, hizb, rub, manzil, ruku, sajda, flags, first_word_id, last_word_id,
                        text_hafs, text_imlaei, norm_loose, norm_strict
                 FROM ayah ORDER BY id",
                [],
                |r| {
                    Ok(AyahRow {
                        id: r.get(0)?,
                        surah: r.get(1)?,
                        ayah: r.get(2)?,
                        juz: r.get(3)?,
                        hizb: r.get(4)?,
                        rub: r.get(5)?,
                        manzil: r.get(6)?,
                        ruku: r.get(7)?,
                        sajda: r.get(8)?,
                        flags: r.get(9)?,
                        first_word_id: r.get(10)?,
                        last_word_id: r.get(11)?,
                        text_hafs: r.get(12)?,
                        text_imlaei: r.get(13)?,
                        norm_loose: r.get(14)?,
                        norm_strict: r.get(15)?,
                    })
                },
            )?,
            words: rows(
                conn,
                "SELECT id, ayah_id, surah, ayah, position, is_end, text_hafs, text_imlaei, norm_loose, code_v1, code_v2
                 FROM word ORDER BY id",
                [],
                |r| {
                    Ok(WordRow {
                        id: r.get(0)?,
                        ayah_id: r.get(1)?,
                        surah: r.get(2)?,
                        ayah: r.get(3)?,
                        position: r.get(4)?,
                        is_end: r.get::<_, u32>(5)? == 1,
                        text_hafs: r.get(6)?,
                        text_imlaei: r.get(7)?,
                        norm_loose: r.get(8)?,
                        code_v1: r.get(9)?,
                        code_v2: r.get(10)?,
                    })
                },
            )?,
            pages: rows(
                conn,
                "SELECT mushaf_id, page, first_word_id, last_word_id, first_ayah_id, last_ayah_id FROM page
                 ORDER BY mushaf_id, page",
                [],
                |r| {
                    Ok(PageRow {
                        mushaf_id: r.get(0)?,
                        page: r.get(1)?,
                        first_word_id: r.get(2)?,
                        last_word_id: r.get(3)?,
                        first_ayah_id: r.get(4)?,
                        last_ayah_id: r.get(5)?,
                    })
                },
            )?,
            lines: rows(
                conn,
                "SELECT mushaf_id, page, line, kind, centered, surah_id, first_word_id, last_word_id FROM line
                 ORDER BY mushaf_id, page, line",
                [],
                |r| {
                    Ok(LineRow {
                        mushaf_id: r.get(0)?,
                        page: r.get(1)?,
                        line: r.get(2)?,
                        kind: r.get(3)?,
                        centered: r.get::<_, u32>(4)? == 1,
                        surah_id: r.get(5)?,
                        first_word_id: r.get(6)?,
                        last_word_id: r.get(7)?,
                    })
                },
            )?,
            juz: ranges("juz")?,
            hizb: ranges("hizb")?,
            rub: ranges("rub")?,
            manzil: ranges("manzil")?,
            ruku: rows(
                conn,
                "SELECT id, surah, first_ayah_id, last_ayah_id FROM ruku ORDER BY id",
                [],
                |r| {
                    Ok(RangeRow {
                        id: r.get(0)?,
                        surah: Some(r.get(1)?),
                        first_ayah_id: r.get(2)?,
                        last_ayah_id: r.get(3)?,
                    })
                },
            )?,
            sajda: rows(conn, "SELECT id, ayah_id, kind FROM sajda ORDER BY id", [], |r| {
                Ok(SajdaRow {
                    id: r.get(0)?,
                    ayah_id: r.get(1)?,
                    kind: r.get(2)?,
                })
            })?,
            ayah_ids: BTreeMap::new(),
        };
        snapshot.ayah_ids = snapshot
            .ayahs
            .iter()
            .map(|a| ((a.surah, a.ayah), a.id))
            .collect();
        Ok(snapshot)
    }

    fn word(&self, id: u32) -> Option<&WordRow> {
        let index = self.words.binary_search_by_key(&id, |w| w.id).ok()?;
        self.words.get(index)
    }

    fn ayah(&self, id: u32) -> Option<&AyahRow> {
        let index = self.ayahs.binary_search_by_key(&id, |a| a.id).ok()?;
        self.ayahs.get(index)
    }

    fn ayah_at(&self, surah: u32, ayah: u32) -> Option<&AyahRow> {
        self.ayah(*self.ayah_ids.get(&(surah, ayah))?)
    }

    fn word_at(&self, surah: u32, ayah: u32, position: u32) -> Option<&WordRow> {
        let first = self.ayah_at(surah, ayah)?.first_word_id;
        let word = self.word(first.checked_add(position.checked_sub(1)?)?)?;
        (word.triple() == (surah, ayah, position)).then_some(word)
    }

    /// `s:a` of an ayah id, or `#id` when there is no such ayah.
    fn key_of(&self, ayah_id: u32) -> String {
        self.ayah(ayah_id)
            .map_or_else(|| format!("#{ayah_id}"), |a| a.key().to_string())
    }

    fn lines_of(&self, mushaf: u32) -> Vec<&LineRow> {
        self.lines
            .iter()
            .filter(|l| l.mushaf_id == mushaf)
            .collect()
    }

    fn pages_of(&self, mushaf: u32) -> Vec<&PageRow> {
        self.pages
            .iter()
            .filter(|p| p.mushaf_id == mushaf)
            .collect()
    }

    /// Consecutive words of one ayah id.
    fn words_by_ayah(&self) -> impl Iterator<Item = &[WordRow]> {
        self.words.chunk_by(|a, b| a.ayah_id == b.ayah_id)
    }

    fn source(&self) -> Option<&str> {
        self.meta.get("source").map(String::as_str)
    }
}

// ---- gate plumbing ------------------------------------------------------------------------------------------------

/// What every gate can read.
struct Ctx<'a> {
    conn: &'a Connection,
    bytes: u64,
    snapshot: Result<Snapshot, String>,
    tanzil: Result<Tanzil, String>,
    exceptions: Result<DivisionExceptions, String>,
    headers: Result<Option<HeaderMap>, String>,
}

impl Ctx<'_> {
    fn snapshot(&self) -> anyhow::Result<&Snapshot> {
        self.snapshot
            .as_ref()
            .map_err(|e| anyhow!("core.db could not be read: {e}"))
    }
}

/// A list of problems found by one check: the count and the first [`MAX_SAMPLES`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Violations {
    count: usize,
    samples: Vec<String>,
}

impl Violations {
    fn push(&mut self, describe: impl FnOnce() -> String) {
        self.count += 1;
        if self.samples.len() < MAX_SAMPLES {
            self.samples.push(describe());
        }
    }

    fn is_empty(&self) -> bool {
        self.count == 0
    }

    fn extend(&mut self, other: Self) {
        self.count += other.count;
        let room = MAX_SAMPLES.saturating_sub(self.samples.len());
        self.samples.extend(other.samples.into_iter().take(room));
    }

    fn describe(&self) -> String {
        if self.is_empty() {
            return "none".to_owned();
        }
        let mut out = format!("{} violation(s): {}", self.count, self.samples.join("; "));
        if self.count > self.samples.len() {
            out.push_str("; …");
        }
        out
    }
}

/// One named check of a gate.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckReport {
    name: String,
    passed: bool,
    detail: String,
}

/// Collects one gate's checks, warnings and facts.
#[derive(Debug, Default)]
struct Recorder {
    checks: Vec<CheckReport>,
    warnings: Vec<String>,
    facts: BTreeMap<String, Value>,
}

impl Recorder {
    fn check(&mut self, name: impl Into<String>, passed: bool, detail: impl Into<String>) {
        self.checks.push(CheckReport {
            name: name.into(),
            passed,
            detail: detail.into(),
        });
    }

    /// Passes when `actual == expected`.
    fn equal<T: PartialEq + std::fmt::Debug>(
        &mut self,
        name: impl Into<String>,
        actual: T,
        expected: T,
    ) {
        let passed = actual == expected;
        let detail = if passed {
            format!("{actual:?}")
        } else {
            format!("found {actual:?}, expected {expected:?}")
        };
        self.check(name, passed, detail);
    }

    /// Passes when `found` is empty.
    fn none(&mut self, name: impl Into<String>, found: &Violations) {
        self.check(name, found.is_empty(), found.describe());
    }

    /// A check that could not run because an input is missing (it fails).
    fn unavailable(&mut self, name: impl Into<String>, why: &str) {
        self.check(name, false, format!("not checked: {why}"));
    }

    fn warn(&mut self, message: impl Into<String>) {
        self.warnings.push(message.into());
    }

    fn fact(&mut self, key: &str, value: impl Serialize) {
        if let Ok(value) = serde_json::to_value(value) {
            self.facts.insert(key.to_owned(), value);
        }
    }
}

type GateFn = fn(&Ctx<'_>, &mut Recorder) -> anyhow::Result<()>;

struct GateDef {
    id: &'static str,
    title: &'static str,
    invariant: &'static str,
    run: GateFn,
}

/// The gates in §4.5 order.
const GATES: [GateDef; 18] = [
    GateDef {
        id: "G1",
        title: "counts",
        invariant: "surah = 114, ayah = 6,236, word = 83,665 (77,429 is_end=0 + 6,236 is_end=1); per-surah ayah counts == Tanzil",
        run: g1_counts,
    },
    GateDef {
        id: "G2",
        title: "word order",
        invariant: "ids contiguous 1..83,665 and strictly increasing in (surah, ayah, position); each ayah has positions 1..n contiguous, exactly one is_end and it is the last",
        run: g2_word_order,
    },
    GateDef {
        id: "G3",
        title: "ayah ranges",
        invariant: "ayah.first_word_id/last_word_id match the word table; ayah ids contiguous in (surah, ayah) order; surah.first_ayah_id consistent",
        run: g3_ayah_ranges,
    },
    GateDef {
        id: "G4",
        title: "glyph codes",
        invariant: "code_v1, code_v2 have 1–4 chars, no whitespace (one inner U+0020 accepted after the printed ۞ and in the listed words); multi-char counts reported against FACT C5; D5 grouping of 38:24:32–33",
        run: g4_glyph_codes,
    },
    GateDef {
        id: "G5",
        title: "Hafs text",
        invariant: "end words = U+06DD + the Arabic-Indic digits of the ayah; U+06DD nowhere else; no empty text_hafs; ayah.text_hafs = word texts joined by U+0020",
        run: g5_hafs_text,
    },
    GateDef {
        id: "G5b",
        title: "word spaces",
        invariant: "every U+0020 inside a non-end word.text_hafs precedes ۩, ends the printed \"۞ \" rub sign, or joins a listed compound word; the lists are reported",
        run: g5b_word_spaces,
    },
    GateDef {
        id: "G6",
        title: "page shape",
        invariant: "for each mushaf (1, 2, 19): 604 pages; pages 1–2 have exactly lines 1..8; pages 3..604 have exactly lines 1..15",
        run: g6_page_shape,
    },
    GateDef {
        id: "G7",
        title: "coverage",
        invariant: "per mushaf, every word id is covered by exactly one kind-0 line; ranges are contiguous across lines and pages; page rows agree with lines",
        run: g7_coverage,
    },
    GateDef {
        id: "G8",
        title: "header lines",
        invariant: "per mushaf, 114 surah_name and 112 basmallah lines (none for 1 or 9); C15 geometry for all 114 surahs in reading order (the basmallah on the first ayah's page, a surah_name possibly on the previous page's last line)",
        run: g8_header_lines,
    },
    GateDef {
        id: "G9",
        title: "centring",
        invariant: "pages 1–2 fully centred; every header line centred; v2 ayah lines centred exactly on the FACT §2.3 list; v1/v4: the §4.2 approximation (qdc) or as provided (qul)",
        run: g9_centring,
    },
    GateDef {
        id: "G10",
        title: "page starts",
        invariant: "every page's first word has position 1; v1 page starts == Tanzil 604/604; v1 and v2 differ on exactly the 25 known pages; v4 page starts == v2",
        run: g10_page_starts,
    },
    GateDef {
        id: "G11",
        title: "divisions",
        invariant: "juz 30, hizb 60, rub 240, manzil 7, ruku 556, sajda 15 (obligatory 32:15, 41:38, 53:62, 96:19); boundaries == Tanzil except division_exceptions.toml (a stale entry fails); per-ayah columns and flags consistent",
        run: g11_divisions,
    },
    GateDef {
        id: "G11b",
        title: "sajda glyphs",
        invariant: "the ayahs with a word whose text_hafs contains U+06E9 == the sajda table (15 ayahs, exactly one such word each)",
        run: g11b_sajda_glyphs,
    },
    GateDef {
        id: "G12",
        title: "search",
        invariant: "ayah_fts has 6,236 rows; the §4.5 loose, prefix and strict queries hit their ayahs; vocab_loose has 14,000–15,500 terms and equals the index vocabulary; the index holds exactly the norm_* tokens",
        run: g12_search,
    },
    GateDef {
        id: "G13",
        title: "normaliser",
        invariant: "meta.normalizer_version == NORMALIZER_VERSION; norm_* == normalize_ar(text_imlaei) for every ayah and word; no step-1 char survives",
        run: g13_normaliser,
    },
    GateDef {
        id: "G14",
        title: "SQLite",
        invariant: "integrity_check = ok; foreign_key_check empty; journal_mode = delete; file < 16 MiB; the schema is core.sql; meta complete",
        run: g14_sqlite,
    },
    GateDef {
        id: "G15",
        title: "performance",
        invariant: "the §3.1.4 page query plan matches; every page query (604 pages × 4 styles) runs in < 5 ms at p99",
        run: g15_performance,
    },
    GateDef {
        id: "G16",
        title: "header map",
        invariant: "header_cp non-null for 114 surahs and equal to the map when the map file is present; surah 1 = 0xFC45, 114 = 0xFBEB",
        run: g16_header_map,
    },
];

/// One gate's result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GateReport {
    id: &'static str,
    title: &'static str,
    invariant: &'static str,
    passed: bool,
    duration_ms: f64,
    /// Why the gate could not run to the end (its checks so far are kept).
    error: Option<String>,
    checks: Vec<CheckReport>,
    warnings: Vec<String>,
    facts: BTreeMap<String, Value>,
}

fn run_gates(ctx: &Ctx<'_>) -> Vec<GateReport> {
    GATES
        .iter()
        .map(|gate| {
            let started = Instant::now();
            let mut recorder = Recorder::default();
            let mut error = (gate.run)(ctx, &mut recorder)
                .err()
                .map(|e| format!("{e:#}"));
            if error.is_none() && recorder.checks.is_empty() {
                error = Some("the gate recorded no check".to_owned());
            }
            GateReport {
                id: gate.id,
                title: gate.title,
                invariant: gate.invariant,
                passed: error.is_none() && recorder.checks.iter().all(|c| c.passed),
                duration_ms: millis(started.elapsed()),
                error,
                checks: recorder.checks,
                warnings: recorder.warnings,
                facts: recorder.facts,
            }
        })
        .collect()
}

/// Milliseconds with two decimals.
fn millis(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 100_000.0).round() / 100.0
}

/// `n` in Arabic-Indic digits.
fn arabic_indic(n: u32) -> String {
    n.to_string()
        .chars()
        .map(|d| {
            d.to_digit(10)
                .and_then(|v| char::from_u32(0x0660 + v))
                .unwrap_or(d)
        })
        .collect()
}

/// `U+FBE9 U+FBEA`.
fn code_points(text: &str) -> String {
    text.chars()
        .map(|c| format!("U+{:04X}", u32::from(c)))
        .collect::<Vec<_>>()
        .join(" ")
}

const fn lines_on_page(page: u32) -> u32 {
    if page <= 2 {
        OPENING_PAGE_LINES
    } else {
        LINES_PER_PAGE
    }
}

const fn kind_name(kind: u32) -> &'static str {
    match kind {
        KIND_AYAH => "ayah line",
        KIND_SURAH_NAME => "surah_name",
        KIND_BASMALLAH => "basmallah",
        _ => "unknown kind",
    }
}

// ---- G1–G3: counts and order --------------------------------------------------------------------------------------

fn g1_counts(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let markers = s.words.iter().filter(|w| w.is_end).count();
    gate.equal("surah rows", s.surahs.len(), SURAHS as usize);
    gate.equal("ayah rows", s.ayahs.len(), AYAHS as usize);
    gate.equal("word rows", s.words.len(), WORDS as usize);
    gate.equal(
        "words with is_end = 0",
        s.words.len() - markers,
        PLAIN_WORDS,
    );
    gate.equal(
        "words with is_end = 1 (end markers)",
        markers,
        AYAHS as usize,
    );
    gate.equal(
        "meta.ayah_count / meta.word_count",
        (
            s.meta.get("ayah_count").map(String::as_str),
            s.meta.get("word_count").map(String::as_str),
        ),
        (Some("6236"), Some("83665")),
    );
    let name = "per-surah ayah counts == Tanzil (ayah rows and surah.ayah_count)";
    match &ctx.tanzil {
        Ok(tanzil) => {
            let mut rows_per_surah: BTreeMap<u32, u32> = BTreeMap::new();
            for a in &s.ayahs {
                *rows_per_surah.entry(a.surah).or_default() += 1;
            }
            let mut found = Violations::default();
            for t in &tanzil.suras {
                let rows = rows_per_surah.remove(&t.index).unwrap_or(0);
                let declared = s
                    .surahs
                    .iter()
                    .find(|r| r.id == t.index)
                    .map(|r| r.ayah_count);
                if rows != t.ayas || declared != Some(t.ayas) {
                    found.push(|| {
                        format!(
                            "surah {}: {rows} ayah rows, surah.ayah_count {declared:?}, Tanzil {}",
                            t.index, t.ayas
                        )
                    });
                }
            }
            for (surah, rows) in rows_per_surah {
                found.push(|| {
                    format!("{rows} ayah rows of surah {surah}, which Tanzil does not have")
                });
            }
            gate.none(name, &found);
        }
        Err(e) => gate.unavailable(name, e),
    }
    gate.fact("surahs", s.surahs.len());
    gate.fact("ayahs", s.ayahs.len());
    gate.fact("words", s.words.len());
    gate.fact("endMarkers", markers);
    Ok(())
}

fn g2_word_order(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let mut ids = Violations::default();
    for (expected, w) in (1_u32..).zip(&s.words) {
        if w.id != expected {
            ids.push(|| format!("row {expected} has id {}", w.id));
        }
    }
    gate.none("word ids are 1, 2, 3, … without gaps", &ids);
    gate.equal("largest word id", s.words.last().map(|w| w.id), Some(WORDS));

    let mut order = Violations::default();
    for pair in s.words.windows(2) {
        if let [a, b] = pair
            && a.triple() >= b.triple()
        {
            order.push(|| {
                format!(
                    "word {} ({}) is followed by word {} ({})",
                    a.id,
                    a.location(),
                    b.id,
                    b.location()
                )
            });
        }
    }
    gate.none(
        "(surah, ayah, position) strictly increases with the id",
        &order,
    );

    let (mut positions, mut ends, mut bare) = (
        Violations::default(),
        Violations::default(),
        Violations::default(),
    );
    for group in s
        .words
        .chunk_by(|a, b| (a.surah, a.ayah) == (b.surah, b.ayah))
    {
        let (Some(first), Some(last)) = (group.first(), group.last()) else {
            continue;
        };
        let key = format!("{}:{}", first.surah, first.ayah);
        let count = u32::try_from(group.len()).unwrap_or(u32::MAX);
        if !group.iter().map(|w| w.position).eq(1..=count) {
            positions.push(|| {
                format!(
                    "{key}: positions {:?}",
                    group.iter().map(|w| w.position).collect::<Vec<_>>()
                )
            });
        }
        let markers = group.iter().filter(|w| w.is_end).count();
        if markers != 1 || !last.is_end {
            ends.push(|| {
                format!(
                    "{key}: {markers} end marker(s), the last word is_end = {}",
                    last.is_end
                )
            });
        }
        if group.len() < 2 {
            bare.push(|| format!("{key} has {} word(s)", group.len()));
        }
    }
    gate.none("each ayah's positions are 1..n", &positions);
    gate.none(
        "each ayah has exactly one end marker, and it is the last word",
        &ends,
    );
    gate.none(
        "each ayah has at least one word before its end marker",
        &bare,
    );
    Ok(())
}

fn g3_ayah_ranges(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let mut ids = Violations::default();
    for (expected, a) in (1_u32..).zip(&s.ayahs) {
        if a.id != expected {
            ids.push(|| format!("row {expected} has id {} ({})", a.id, a.key()));
        }
    }
    gate.none("ayah ids are 1, 2, 3, … without gaps", &ids);

    let mut order = Violations::default();
    if let Some(first) = s.ayahs.first()
        && first.key() != AyahKey::new(1, 1)
    {
        order.push(|| format!("ayah id {} is {}, not 1:1", first.id, first.key()));
    }
    for pair in s.ayahs.windows(2) {
        if let [a, b] = pair {
            let next_in_surah = b.surah == a.surah && b.ayah == a.ayah + 1;
            let next_surah = b.surah == a.surah + 1 && b.ayah == 1;
            if !(next_in_surah || next_surah) {
                order.push(|| {
                    format!(
                        "ayah {} ({}) is followed by ayah {} ({})",
                        a.id,
                        a.key(),
                        b.id,
                        b.key()
                    )
                });
            }
        }
    }
    gate.none(
        "ayah ids follow (surah, ayah) order, every surah numbered 1..n",
        &order,
    );

    // Words per ayah id: (min id, max id, count).
    let mut spans: BTreeMap<u32, (u32, u32, u32)> = BTreeMap::new();
    let mut owners = Violations::default();
    for w in &s.words {
        let span = spans.entry(w.ayah_id).or_insert((w.id, w.id, 0));
        span.0 = span.0.min(w.id);
        span.1 = span.1.max(w.id);
        span.2 += 1;
        match s.ayah(w.ayah_id) {
            Some(a) if (a.surah, a.ayah) == (w.surah, w.ayah) => {}
            Some(a) => owners.push(|| {
                format!(
                    "word {} ({}) has ayah_id {} ({})",
                    w.id,
                    w.location(),
                    a.id,
                    a.key()
                )
            }),
            None => owners.push(|| {
                format!(
                    "word {} ({}) has ayah_id {}, no such ayah",
                    w.id,
                    w.location(),
                    w.ayah_id
                )
            }),
        }
    }
    gate.none(
        "word.ayah_id names the ayah of the word's (surah, ayah)",
        &owners,
    );

    let mut ranges = Violations::default();
    for a in &s.ayahs {
        match spans.get(&a.id) {
            Some(&(min, max, count))
                if min == a.first_word_id
                    && max == a.last_word_id
                    && a.last_word_id.checked_sub(a.first_word_id).map(|d| d + 1)
                        == Some(count) => {}
            Some(&(min, max, count)) => ranges.push(|| {
                format!(
                    "{}: first/last_word_id {}..={}, its words are {min}..={max} ({count})",
                    a.key(),
                    a.first_word_id,
                    a.last_word_id
                )
            }),
            None => ranges.push(|| format!("{} has no words", a.key())),
        }
    }
    gate.none(
        "ayah.first_word_id/last_word_id are the ayah's first and last words",
        &ranges,
    );

    let mut chain = Violations::default();
    if s.ayahs.first().map(|a| a.first_word_id) != Some(1) {
        chain.push(|| "the first ayah does not start at word 1".to_owned());
    }
    for pair in s.ayahs.windows(2) {
        if let [a, b] = pair
            && b.first_word_id != a.last_word_id + 1
        {
            chain.push(|| {
                format!(
                    "{} ends at word {}, {} starts at {}",
                    a.key(),
                    a.last_word_id,
                    b.key(),
                    b.first_word_id
                )
            });
        }
    }
    if s.ayahs.last().map(|a| a.last_word_id) != s.words.last().map(|w| w.id) {
        chain.push(|| "the last ayah does not end at the last word".to_owned());
    }
    gate.none("consecutive ayahs cover consecutive word ranges", &chain);

    let mut surahs = Violations::default();
    for (expected, surah) in (1_u32..).zip(&s.surahs) {
        let first = s.ayah_at(expected, 1).map(|a| a.id);
        if surah.id != expected || Some(surah.first_ayah_id) != first {
            surahs.push(|| {
                format!(
                    "surah row {expected}: id {}, first_ayah_id {}, ayah {expected}:1 has id {first:?}",
                    surah.id, surah.first_ayah_id
                )
            });
        }
    }
    gate.none(
        "surah ids are 1..=114 and surah.first_ayah_id is the id of ayah s:1",
        &surahs,
    );
    Ok(())
}

// ---- G4–G5b: text and glyph codes ---------------------------------------------------------------------------------

/// Why a glyph code breaks G4, if it does. `space_allowed`: the word may carry one inner U+0020.
fn glyph_code_problem(code: &str, space_allowed: bool) -> Option<String> {
    let chars: Vec<char> = code.chars().collect();
    if !(1..=MAX_GLYPH_CHARS).contains(&chars.len()) {
        return Some(format!(
            "{} chars, expected 1–{MAX_GLYPH_CHARS}",
            chars.len()
        ));
    }
    let blanks: Vec<(usize, char)> = chars
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, c)| c.is_whitespace() || c.is_control())
        .collect();
    match blanks.as_slice() {
        [] => None,
        [(i, ' ')] if space_allowed && *i > 0 && *i + 1 < chars.len() => None,
        [(_, ' ')] if space_allowed => Some("a U+0020 at the start or the end".to_owned()),
        [(_, ' ')] => {
            Some("a U+0020 in a word that neither opens with \"۞ \" nor is listed".to_owned())
        }
        more => Some(format!(
            "whitespace or control chars at {:?}",
            more.iter()
                .map(|(i, c)| format!("{i}:U+{:04X}", u32::from(*c)))
                .collect::<Vec<_>>()
        )),
    }
}

fn g4_glyph_codes(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let mut bad = Violations::default();
    let (mut multi_v1, mut multi_v2, mut space_v1, mut space_v2) =
        (0_usize, 0_usize, 0_usize, 0_usize);
    let mut listed_with_space: Vec<String> = Vec::new();
    for w in &s.words {
        let listed = CODE_SPACE_WORDS.contains(&w.triple());
        let space_allowed = listed || w.text_hafs.starts_with(RUB_PREFIX);
        for (column, code) in [("code_v1", &w.code_v1), ("code_v2", &w.code_v2)] {
            if let Some(problem) = glyph_code_problem(code, space_allowed) {
                bad.push(|| {
                    format!(
                        "{} {column} [{}]: {problem}",
                        w.location(),
                        code_points(code)
                    )
                });
            }
        }
        if listed && (w.code_v1.contains(' ') || w.code_v2.contains(' ')) {
            listed_with_space.push(w.location());
        }
        multi_v1 += usize::from(w.code_v1.chars().count() > 1);
        multi_v2 += usize::from(w.code_v2.chars().count() > 1);
        space_v1 += usize::from(w.code_v1.contains(' '));
        space_v2 += usize::from(w.code_v2.contains(' '));
    }
    gate.none(
        "code_v1/code_v2 have 1–4 chars and no whitespace, except one inner U+0020 after the printed ۞ or in a listed word",
        &bad,
    );
    if (multi_v1, multi_v2) != FACT_C5_MULTI_CHAR {
        gate.warn(format!(
            "multi-char codes: {multi_v1} V1 / {multi_v2} V2 words, FACT C5 says {} / {}",
            FACT_C5_MULTI_CHAR.0, FACT_C5_MULTI_CHAR.1
        ));
    }
    gate.fact("multiCharCodeV1", multi_v1);
    gate.fact("multiCharCodeV2", multi_v2);
    gate.fact(
        "factC5MultiChar",
        [FACT_C5_MULTI_CHAR.0, FACT_C5_MULTI_CHAR.1],
    );
    gate.fact("codesWithSpaceV1", space_v1);
    gate.fact("codesWithSpaceV2", space_v2);
    gate.fact("listedWordsWithSpace", &listed_with_space);

    let d5: Vec<Option<String>> = D5_CODE_V1
        .iter()
        .map(|(position, _)| {
            s.word_at(38, 24, *position)
                .map(|w| code_points(&w.code_v1))
        })
        .collect();
    let expected: Vec<Option<String>> = D5_CODE_V1
        .iter()
        .map(|(_, code)| Some(code_points(code)))
        .collect();
    gate.equal("D5: code_v1 of 38:24:32 / 38:24:33", d5, expected);
    Ok(())
}

fn g5_hafs_text(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let (mut markers, mut stray, mut empty, mut shape) = (
        Violations::default(),
        Violations::default(),
        Violations::default(),
        Violations::default(),
    );
    for w in &s.words {
        if w.text_hafs.trim().is_empty() {
            empty.push(|| format!("{} has an empty text_hafs", w.location()));
        }
        if w.is_end {
            let expected = format!("{END_OF_AYAH}{}", arabic_indic(w.ayah));
            if w.text_hafs != expected {
                markers.push(|| {
                    format!(
                        "{}: [{}], expected [{}]",
                        w.location(),
                        code_points(&w.text_hafs),
                        code_points(&expected)
                    )
                });
            }
            continue;
        }
        if w.text_hafs.contains(END_OF_AYAH) {
            stray.push(|| format!("{}: {}", w.location(), w.text_hafs));
        }
        let well_formed = w.text_hafs.trim() == w.text_hafs
            && !w.text_hafs.contains("  ")
            && w.text_hafs
                .chars()
                .all(|c| c == ' ' || !(c.is_whitespace() || c.is_control()));
        if !well_formed {
            shape.push(|| format!("{}: [{}]", w.location(), code_points(&w.text_hafs)));
        }
    }
    gate.none(
        "end markers are U+06DD + the Arabic-Indic ayah number",
        &markers,
    );
    gate.none("U+06DD appears in no other word", &stray);
    gate.none("no empty text_hafs", &empty);
    gate.none(
        "word texts have no leading, trailing, double or non-U+0020 whitespace",
        &shape,
    );

    let mut joined = Violations::default();
    for group in s.words_by_ayah() {
        let Some(first) = group.first() else {
            continue;
        };
        let expected = group
            .iter()
            .map(|w| w.text_hafs.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        match s.ayah(first.ayah_id) {
            Some(a) if a.text_hafs == expected => {}
            Some(a) => joined.push(|| {
                format!(
                    "{}: ayah.text_hafs differs from its words joined by U+0020",
                    a.key()
                )
            }),
            None => joined.push(|| format!("words of ayah id {} have no ayah row", first.ayah_id)),
        }
    }
    gate.none(
        "ayah.text_hafs is its words' text_hafs joined by U+0020",
        &joined,
    );
    Ok(())
}

/// The U+0020s of one word's `text_hafs`, by kind (G5b).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SpaceKinds {
    /// Spaces right before ۩.
    before_sajda: usize,
    /// The word opens with the printed rub sign `"۞ "`.
    rub_prefix: bool,
    /// Any other space.
    other: usize,
}

fn classify_spaces(text: &str) -> SpaceKinds {
    let chars: Vec<char> = text.chars().collect();
    let mut kinds = SpaceKinds::default();
    for (i, c) in chars.iter().enumerate() {
        if *c != ' ' {
            continue;
        }
        if chars.get(i + 1) == Some(&SAJDA_SIGN) {
            kinds.before_sajda += 1;
        } else if i == 1 && chars.first() == Some(&RUB_SIGN) {
            kinds.rub_prefix = true;
        } else {
            kinds.other += 1;
        }
    }
    kinds
}

fn g5b_word_spaces(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let mut bad = Violations::default();
    let (mut sajda_words, mut compounds) = (Vec::new(), Vec::new());
    let mut rub_prefixed = 0_usize;
    for w in s
        .words
        .iter()
        .filter(|w| !w.is_end && w.text_hafs.contains(' '))
    {
        let kinds = classify_spaces(&w.text_hafs);
        if kinds.before_sajda > 0 {
            sajda_words.push(w.location());
        }
        rub_prefixed += usize::from(kinds.rub_prefix);
        if kinds.other > 0 {
            if COMPOUND_WORDS.contains(&w.triple()) && kinds.other == 1 {
                compounds.push(w.location());
            } else {
                bad.push(|| {
                    format!(
                        "{}: {} ({} unexplained space(s))",
                        w.location(),
                        w.text_hafs,
                        kinds.other
                    )
                });
            }
        }
    }
    gate.none(
        "every U+0020 inside a non-end word precedes ۩, ends the printed \"۞ \", or joins a listed compound word",
        &bad,
    );
    if sajda_words != SAJDA_SPACE_WORDS {
        gate.warn(format!(
            "the words with \"space + ۩\" are [{}]; §4.5 lists the 9 QDC words [{}]",
            sajda_words.join(", "),
            SAJDA_SPACE_WORDS.join(", ")
        ));
    }
    gate.fact("sajdaSpaceWords", &sajda_words);
    gate.fact("rubSignWords", rub_prefixed);
    gate.fact("compoundWords", &compounds);
    Ok(())
}

// ---- G6–G10: layouts ----------------------------------------------------------------------------------------------

fn g6_page_shape(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let actual: Vec<(u32, &str, &str, u32, u32)> = s
        .mushafs
        .iter()
        .map(|m| {
            (
                m.id,
                m.code.as_str(),
                m.glyph_column.as_str(),
                m.pages,
                m.lines_per_page,
            )
        })
        .collect();
    let expected: Vec<(u32, &str, &str, u32, u32)> = MUSHAFS
        .iter()
        .map(|(id, code, column)| (*id, *code, *column, PAGES, LINES_PER_PAGE))
        .collect();
    gate.equal(
        "mushaf rows (id, code, glyph_column, pages, lines_per_page)",
        actual,
        expected,
    );
    gate.check(
        "mushaf names are set",
        s.mushafs.iter().all(|m| !m.name.trim().is_empty()),
        s.mushafs
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>()
            .join(" | "),
    );

    let known: BTreeSet<u32> = MUSHAFS.iter().map(|(id, _, _)| *id).collect();
    let mut foreign = Violations::default();
    for id in s
        .pages
        .iter()
        .map(|p| p.mushaf_id)
        .chain(s.lines.iter().map(|l| l.mushaf_id))
        .collect::<BTreeSet<_>>()
    {
        if !known.contains(&id) {
            foreign.push(|| format!("rows for mushaf_id {id}"));
        }
    }
    gate.none(
        "page and line rows exist only for mushafs 1, 2 and 19",
        &foreign,
    );

    for (id, code, _) in MUSHAFS {
        let pages: Vec<u32> = s.pages_of(id).iter().map(|p| p.page).collect();
        gate.check(
            format!("{code}: page rows are pages 1..=604"),
            pages.iter().copied().eq(1..=PAGES),
            format!("{} page rows", pages.len()),
        );
        let mut by_page: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for l in s.lines_of(id) {
            by_page.entry(l.page).or_default().push(l.line);
        }
        let mut shape = Violations::default();
        if !by_page.keys().copied().eq(1..=PAGES) {
            shape.push(|| {
                format!(
                    "line rows exist for {} pages, expected 1..=604",
                    by_page.len()
                )
            });
        }
        for (page, lines) in &by_page {
            if !lines.iter().copied().eq(1..=lines_on_page(*page)) {
                shape.push(|| format!("page {page} has lines {lines:?}"));
            }
        }
        gate.none(
            format!("{code}: pages 1–2 have lines 1..8, pages 3..604 lines 1..15"),
            &shape,
        );
        gate.fact(
            &format!("{code}Lines"),
            by_page.values().map(Vec::len).sum::<usize>(),
        );
    }
    Ok(())
}

fn g7_coverage(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let word_count = u32::try_from(s.words.len()).unwrap_or(u32::MAX);
    for (id, code, _) in MUSHAFS {
        let lines = s.lines_of(id);
        let (mut shape, mut gaps) = (Violations::default(), Violations::default());
        let mut next = 1_u32;
        let mut per_page: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
        for l in &lines {
            match (l.kind, l.first_word_id, l.last_word_id, l.surah_id) {
                (KIND_AYAH, Some(first), Some(last), None) => {
                    if first != next || last < first {
                        gaps.push(|| {
                            format!(
                                "line {} holds words {first}..={last}, expected to start at {next}",
                                l.at()
                            )
                        });
                    }
                    next = last.max(first).saturating_add(1);
                    let span = per_page.entry(l.page).or_insert((first, last));
                    span.0 = span.0.min(first);
                    span.1 = span.1.max(last);
                }
                (KIND_SURAH_NAME | KIND_BASMALLAH, None, None, Some(_)) => {}
                _ => shape.push(|| {
                    format!(
                        "line {}: kind {}, words {:?}..{:?}, surah {:?}",
                        l.at(),
                        l.kind,
                        l.first_word_id,
                        l.last_word_id,
                        l.surah_id
                    )
                }),
            }
        }
        if next != word_count.saturating_add(1) {
            gaps.push(|| {
                format!(
                    "the ayah lines end at word {}, expected {word_count}",
                    next.saturating_sub(1)
                )
            });
        }
        gate.none(
            format!(
                "{code}: ayah lines have words and no surah, header lines a surah and no words"
            ),
            &shape,
        );
        gate.none(
            format!("{code}: ayah lines cover words 1..={word_count} once, contiguously across lines and pages"),
            &gaps,
        );

        let mut pages = Violations::default();
        for p in s.pages_of(id) {
            let Some(&(first, last)) = per_page.get(&p.page) else {
                pages.push(|| format!("page {} has no ayah line", p.page));
                continue;
            };
            let first_ayah = s.word(first).map(|w| w.ayah_id);
            let last_ayah = s.word(last).map(|w| w.ayah_id);
            if (p.first_word_id, p.last_word_id) != (first, last)
                || Some(p.first_ayah_id) != first_ayah
                || Some(p.last_ayah_id) != last_ayah
            {
                pages.push(|| {
                    format!(
                        "page {}: row words {}..={} ayahs {}..={}; lines words {first}..={last} ayahs {first_ayah:?}..={last_ayah:?}",
                        p.page, p.first_word_id, p.last_word_id, p.first_ayah_id, p.last_ayah_id
                    )
                });
            }
        }
        gate.none(format!("{code}: page rows agree with their lines"), &pages);
    }
    Ok(())
}

/// G8's C15 geometry on one layout's lines (reading order). `starts`: each surah and the id of its first word. Returns
/// the violations and the surahs whose `surah_name` is the last line of the previous page.
fn header_geometry(lines: &[&LineRow], starts: &[(u32, Option<u32>)]) -> (Violations, Vec<u32>) {
    let mut found = Violations::default();
    let mut on_previous_page = Vec::new();
    for &(surah, first_word) in starts {
        let Some(word) = first_word else {
            found.push(|| format!("surah {surah} has no ayah 1"));
            continue;
        };
        let Some((at, first_line)) = lines
            .iter()
            .enumerate()
            .find(|(_, l)| l.kind == KIND_AYAH && l.first_word_id == Some(word))
        else {
            found.push(|| {
                format!("surah {surah}: no ayah line starts with its first word ({word})")
            });
            continue;
        };
        // Upwards from the first ayah line: the basmallah (the surah_name for 1 and 9), then the surah_name.
        let needed: &[u32] = if matches!(surah, 1 | 9) {
            &[KIND_SURAH_NAME]
        } else {
            &[KIND_BASMALLAH, KIND_SURAH_NAME]
        };
        for (step, kind) in (1..).zip(needed) {
            let above = at.checked_sub(step).and_then(|i| lines.get(i));
            match above {
                Some(l) if l.kind == *kind && l.surah_id == Some(surah) => {
                    if l.page == first_line.page {
                        continue;
                    }
                    let last_line_of_previous_page =
                        l.page + 1 == first_line.page && l.line == lines_on_page(l.page);
                    if step == needed.len() && step > 1 && last_line_of_previous_page {
                        on_previous_page.push(surah);
                    } else {
                        found.push(|| {
                            format!(
                                "surah {surah}: its {} is line {}, not on the page of its first ayah line {}",
                                kind_name(*kind),
                                l.at(),
                                first_line.at()
                            )
                        });
                    }
                }
                Some(l) => found.push(|| {
                    format!(
                        "surah {surah}: line {} above its first ayah line {} is a {} (surah {:?}), expected its {}",
                        l.at(),
                        first_line.at(),
                        kind_name(l.kind),
                        l.surah_id,
                        kind_name(*kind)
                    )
                }),
                None => found.push(|| {
                    format!("surah {surah}: no line above its first ayah line {} for its {}", first_line.at(), kind_name(*kind))
                }),
            }
        }
    }
    (found, on_previous_page)
}

fn g8_header_lines(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let starts: Vec<(u32, Option<u32>)> = (1..=SURAHS)
        .map(|surah| (surah, s.ayah_at(surah, 1).map(|a| a.first_word_id)))
        .collect();
    let with_basmallah: Vec<u32> = (1..=SURAHS).filter(|s| !matches!(s, 1 | 9)).collect();
    for (id, code, _) in MUSHAFS {
        let lines = s.lines_of(id);
        let headers = |kind: u32| -> Vec<u32> {
            let mut surahs: Vec<u32> = lines
                .iter()
                .filter(|l| l.kind == kind)
                .map(|l| l.surah_id.unwrap_or(0))
                .collect();
            surahs.sort_unstable();
            surahs
        };
        let names = headers(KIND_SURAH_NAME);
        let basmallahs = headers(KIND_BASMALLAH);
        gate.equal(
            format!("{code}: surah_name / basmallah lines"),
            (names.len(), basmallahs.len()),
            (114, 112),
        );
        gate.check(
            format!("{code}: one surah_name per surah 1..=114"),
            names.iter().copied().eq(1..=SURAHS),
            format!("{} lines", names.len()),
        );
        gate.check(
            format!("{code}: one basmallah per surah except 1 and 9"),
            basmallahs == with_basmallah,
            format!("{} lines", basmallahs.len()),
        );
        let (found, on_previous_page) = header_geometry(&lines, &starts);
        gate.none(
            format!("{code}: C15 geometry for every surah (header slots right above the first ayah line)"),
            &found,
        );
        gate.fact(&format!("{code}SurahNameOnPreviousPage"), &on_previous_page);
    }
    let mut bismillah = Violations::default();
    for surah in &s.surahs {
        let expected = u32::from(!matches!(surah.id, 1 | 9));
        if surah.bismillah_pre != expected {
            bismillah.push(|| format!("surah {}: bismillah_pre {}", surah.id, surah.bismillah_pre));
        }
    }
    gate.none(
        "surah.bismillah_pre is 0 exactly for surahs 1 and 9",
        &bismillah,
    );
    Ok(())
}

fn g9_centring(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let centred_ayah_lines = |mushaf: u32| -> BTreeSet<(u32, u32)> {
        s.lines_of(mushaf)
            .iter()
            .filter(|l| l.kind == KIND_AYAH && l.page > 2 && l.centered)
            .map(|l| (l.page, l.line))
            .collect()
    };
    for (id, code, _) in MUSHAFS {
        let mut found = Violations::default();
        for l in s.lines_of(id) {
            if (l.page <= 2 || l.kind != KIND_AYAH) && !l.centered {
                found.push(|| format!("line {} ({}) is not centred", l.at(), kind_name(l.kind)));
            }
        }
        gate.none(
            format!("{code}: pages 1–2 and every header line are centred"),
            &found,
        );
        gate.fact(
            &format!("{code}CentredAyahLines"),
            centred_ayah_lines(id).len(),
        );
    }

    let expected: BTreeSet<(u32, u32)> = V2_CENTRED
        .iter()
        .flat_map(|(page, lines)| lines.iter().map(move |line| (*page, *line)))
        .collect();
    let actual = centred_ayah_lines(V2);
    let describe = |set: &BTreeSet<(u32, u32)>| {
        set.iter()
            .map(|(p, l)| format!("{p}:{l}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    gate.check(
        "v2: the centred ayah lines (pages 3..604) are exactly FACT §2.3's",
        actual == expected,
        if actual == expected {
            format!("{} lines", actual.len())
        } else {
            format!(
                "extra [{}], missing [{}]",
                describe(&actual.difference(&expected).copied().collect()),
                describe(&expected.difference(&actual).copied().collect())
            )
        },
    );

    let v2_ranges: BTreeSet<(Option<u32>, Option<u32>)> = s
        .lines_of(V2)
        .iter()
        .filter(|l| l.kind == KIND_AYAH && l.centered)
        .map(|l| (l.first_word_id, l.last_word_id))
        .collect();
    for (id, code) in [(V1, "v1"), (V4, "v4")] {
        let name = format!("{code}: centred ayah lines follow the source");
        match s.source() {
            Some("qdc") => {
                // §4.2: pages 1–2, plus ayah lines whose words are exactly a centred v2 line's.
                let like_v2: BTreeSet<(u32, u32)> = s
                    .lines_of(id)
                    .iter()
                    .filter(|l| l.kind == KIND_AYAH && l.page > 2)
                    .filter(|l| v2_ranges.contains(&(l.first_word_id, l.last_word_id)))
                    .map(|l| (l.page, l.line))
                    .collect();
                let actual = centred_ayah_lines(id);
                gate.check(
                    format!(
                        "{name} (qdc: exactly the lines whose words equal a centred v2 line, §4.2)"
                    ),
                    actual == like_v2,
                    if actual == like_v2 {
                        format!("{} lines", actual.len())
                    } else {
                        format!(
                            "extra [{}], missing [{}]",
                            describe(&actual.difference(&like_v2).copied().collect()),
                            describe(&like_v2.difference(&actual).copied().collect())
                        )
                    },
                );
            }
            Some("qul") => gate.check(
                format!("{name} (qul: as provided)"),
                true,
                format!(
                    "{} centred ayah lines on pages 3..604",
                    centred_ayah_lines(id).len()
                ),
            ),
            other => gate.check(
                name,
                false,
                format!("meta.source is {other:?}, expected qdc or qul"),
            ),
        }
    }
    Ok(())
}

fn g10_page_starts(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    for (id, code, _) in MUSHAFS {
        let mut found = Violations::default();
        for p in s.pages_of(id) {
            match s.word(p.first_word_id) {
                Some(w) if w.position == 1 => {}
                Some(w) => found.push(|| format!("page {} starts with {}", p.page, w.location())),
                None => found.push(|| {
                    format!(
                        "page {} starts with word {}, no such word",
                        p.page, p.first_word_id
                    )
                }),
            }
        }
        gate.none(
            format!("{code}: every page starts with the first word of an ayah"),
            &found,
        );
    }

    let starts = |mushaf: u32| -> BTreeMap<u32, u32> {
        s.pages_of(mushaf)
            .iter()
            .map(|p| (p.page, p.first_word_id))
            .collect()
    };
    let (v2, v1, v4) = (starts(V2), starts(V1), starts(V4));
    let name = "v1: the first ayah of every page == Tanzil's page start (604/604)";
    match &ctx.tanzil {
        Ok(tanzil) => {
            let mut found = Violations::default();
            let mut matched = 0_usize;
            let v1_pages = s.pages_of(V1);
            for (p, key) in v1_pages.iter().zip(&tanzil.page_starts) {
                let ours = s.ayah(p.first_ayah_id).map(AyahRow::key);
                if ours == Some(*key) {
                    matched += 1;
                } else {
                    found.push(|| {
                        format!(
                            "page {}: {}, Tanzil {key}",
                            p.page,
                            s.key_of(p.first_ayah_id)
                        )
                    });
                }
            }
            if v1_pages.len() != tanzil.page_starts.len() {
                found.push(|| {
                    format!(
                        "{} v1 pages, Tanzil has {}",
                        v1_pages.len(),
                        tanzil.page_starts.len()
                    )
                });
            }
            gate.none(name, &found);
            gate.fact("v1TanzilPageStartsMatched", matched);
        }
        Err(e) => gate.unavailable(name, e),
    }

    let differing: Vec<u32> = v2
        .iter()
        .filter(|(page, word)| v1.get(page) != Some(word))
        .map(|(page, _)| *page)
        .collect();
    gate.equal(
        "the pages where the v1 and v2 first words differ (FACT C2)",
        differing.clone(),
        V1_V2_DIFFERENT_STARTS.to_vec(),
    );
    gate.fact("v1V2DifferentPageStarts", &differing);
    let same = v2
        .iter()
        .filter(|(page, word)| v4.get(page) == Some(word))
        .count();
    gate.check(
        "v4 page starts == v2 page starts (604/604)",
        same == PAGES as usize && v4.len() == PAGES as usize && v2.len() == PAGES as usize,
        format!("{same}/{} equal", v2.len()),
    );
    Ok(())
}

// ---- G11, G11b: divisions -----------------------------------------------------------------------------------------

/// A division table's coverage of ayah ids 1..=`ayahs`: ids 1..n, contiguous non-empty ranges from 1 to `ayahs`.
fn range_problems(rows: &[RangeRow], ayahs: u32) -> Violations {
    let mut found = Violations::default();
    let mut next = 1_u32;
    for (expected_id, r) in (1_u32..).zip(rows) {
        if r.id != expected_id {
            found.push(|| format!("row {expected_id} has id {}", r.id));
        }
        if r.first_ayah_id != next || r.last_ayah_id < r.first_ayah_id {
            found.push(|| {
                format!(
                    "{} covers ayahs {}..={}, expected to start at {next}",
                    r.id, r.first_ayah_id, r.last_ayah_id
                )
            });
        }
        next = r.last_ayah_id.max(r.first_ayah_id).saturating_add(1);
    }
    if next != ayahs.saturating_add(1) {
        found.push(|| {
            format!(
                "the ranges end at ayah {}, expected {ayahs}",
                next.saturating_sub(1)
            )
        });
    }
    found
}

/// The table number of every ayah id 1..=`ayahs` (index `id − 1`) by its ranges.
fn per_ayah(rows: &[RangeRow], ayahs: usize) -> Vec<Option<u32>> {
    let mut out = vec![None; ayahs];
    for r in rows {
        for id in r.first_ayah_id..=r.last_ayah_id {
            if let Some(slot) = usize::try_from(id)
                .ok()
                .and_then(|i| i.checked_sub(1))
                .and_then(|i| out.get_mut(i))
            {
                *slot = Some(r.id);
            }
        }
    }
    out
}

/// G11: the rub starts that differ from Tanzil (`id → (ours, tanzil)`) against the allowlist. Every difference must be
/// listed with the same two keys, and every listed entry must still differ.
fn judge_rub_differences(
    differences: &BTreeMap<u32, (AyahKey, AyahKey)>,
    allowlist: &[RubException],
) -> Violations {
    let mut found = Violations::default();
    for (id, (ours, theirs)) in differences {
        match allowlist.iter().find(|e| e.id == *id) {
            Some(e) if (e.source, e.tanzil) == (*ours, *theirs) => {}
            Some(e) => found.push(|| {
                format!(
                    "rub {id}: core.db {ours} / Tanzil {theirs}, but the allowlist says {} / {}",
                    e.source, e.tanzil
                )
            }),
            None => found
                .push(|| format!("rub {id}: core.db {ours} / Tanzil {theirs} is not allowlisted")),
        }
    }
    for e in allowlist {
        if !differences.contains_key(&e.id) {
            found.push(|| {
                format!(
                    "stale allowlist entry: rub {} ({} / {}) no longer differs from Tanzil",
                    e.id, e.source, e.tanzil
                )
            });
        }
    }
    found
}

/// Reads one division column of an ayah row.
type AyahField = fn(&AyahRow) -> u32;

fn g11_divisions(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let tables: [(&str, &[RangeRow], AyahField); 5] = [
        ("juz", &s.juz, |a| a.juz),
        ("hizb", &s.hizb, |a| a.hizb),
        ("rub", &s.rub, |a| a.rub),
        ("manzil", &s.manzil, |a| a.manzil),
        ("ruku", &s.ruku, |a| a.ruku),
    ];
    let counts: Vec<(&str, usize)> = tables
        .iter()
        .map(|(name, rows, _)| (*name, rows.len()))
        .chain([("sajda", s.sajda.len())])
        .collect();
    gate.equal("row counts", counts, DIVISION_COUNTS.to_vec());
    let ayah_count = u32::try_from(s.ayahs.len()).unwrap_or(u32::MAX);
    for (name, rows, field) in &tables {
        gate.none(
            format!("{name}: ids 1..n, contiguous ranges over every ayah"),
            &range_problems(rows, ayah_count),
        );
        let numbers = per_ayah(rows, s.ayahs.len());
        let mut found = Violations::default();
        for (a, expected) in s.ayahs.iter().zip(&numbers) {
            if Some(field(a)) != *expected {
                found.push(|| {
                    format!(
                        "{}: ayah.{name} {}, its range says {expected:?}",
                        a.key(),
                        field(a)
                    )
                });
            }
        }
        gate.none(
            format!("ayah.{name} is the {name} whose range holds the ayah"),
            &found,
        );
    }

    let mut rukus = Violations::default();
    for r in &s.ruku {
        let (first, last) = (s.ayah(r.first_ayah_id), s.ayah(r.last_ayah_id));
        if first.map(|a| a.surah) != r.surah || last.map(|a| a.surah) != r.surah {
            rukus.push(|| {
                format!(
                    "ruku {} (surah {:?}) runs {}..={}",
                    r.id,
                    r.surah,
                    s.key_of(r.first_ayah_id),
                    s.key_of(r.last_ayah_id)
                )
            });
        }
    }
    for surah in &s.surahs {
        let count = s.ruku.iter().filter(|r| r.surah == Some(surah.id)).count();
        if usize::try_from(surah.rukus).ok() != Some(count) {
            rukus.push(|| {
                format!(
                    "surah {}: surah.rukus {}, {count} ruku rows",
                    surah.id, surah.rukus
                )
            });
        }
    }
    gate.none(
        "every ruku lies in its surah; surah.rukus counts them",
        &rukus,
    );

    let mut nesting = Violations::default();
    for a in &s.ayahs {
        let rub_hizb = a.rub.checked_sub(1).map(|r| r / 4 + 1);
        let hizb_juz = a.hizb.checked_sub(1).map(|h| h / 2 + 1);
        if rub_hizb != Some(a.hizb) || hizb_juz != Some(a.juz) {
            nesting.push(|| {
                format!(
                    "{}: rub {} / hizb {} / juz {}",
                    a.key(),
                    a.rub,
                    a.hizb,
                    a.juz
                )
            });
        }
    }
    gate.none("rub ⊂ hizb ⊂ juz for every ayah", &nesting);

    // Boundaries against Tanzil.
    let ours = |rows: &[RangeRow]| -> Vec<Option<AyahKey>> {
        rows.iter()
            .map(|r| s.ayah(r.first_ayah_id).map(AyahRow::key))
            .collect()
    };
    match &ctx.tanzil {
        Ok(tanzil) => {
            for (name, rows, starts) in [
                ("juz", &s.juz, tanzil.juz_starts.clone()),
                ("hizb", &s.hizb, tanzil.hizb_starts()),
                ("manzil", &s.manzil, tanzil.manzil_starts.clone()),
                ("ruku", &s.ruku, tanzil.ruku_starts.clone()),
            ] {
                let theirs: Vec<Option<AyahKey>> = starts.into_iter().map(Some).collect();
                let mut found = Violations::default();
                for (id, (a, b)) in (1_u32..).zip(ours(rows).iter().zip(&theirs)) {
                    if a != b {
                        found.push(|| format!("{name} {id}: core.db {a:?}, Tanzil {b:?}"));
                    }
                }
                if rows.len() != theirs.len() {
                    found.push(|| format!("{} rows, Tanzil has {}", rows.len(), theirs.len()));
                }
                gate.none(format!("{name} boundaries == Tanzil"), &found);
            }

            let name =
                "rub boundaries == Tanzil except division_exceptions.toml (a stale entry fails)";
            match &ctx.exceptions {
                Ok(exceptions) => {
                    let mut differences = BTreeMap::new();
                    let mut unmapped = Violations::default();
                    for (r, theirs) in s.rub.iter().zip(&tanzil.quarter_starts) {
                        match s.ayah(r.first_ayah_id) {
                            Some(a) if a.key() != *theirs => {
                                differences.insert(r.id, (a.key(), *theirs));
                            }
                            Some(_) => {}
                            None => unmapped.push(|| {
                                format!("rub {} starts at ayah id {}", r.id, r.first_ayah_id)
                            }),
                        }
                    }
                    let mut found = judge_rub_differences(&differences, &exceptions.rub);
                    found.extend(unmapped);
                    gate.none(name, &found);
                    gate.fact(
                        "rubDifferencesFromTanzil",
                        differences
                            .iter()
                            .map(|(id, (a, b))| format!("rub {id}: {a} / {b}"))
                            .collect::<Vec<_>>(),
                    );
                }
                Err(e) => gate.unavailable(name, e),
            }

            let sajdas: Vec<(String, String)> = s
                .sajda
                .iter()
                .map(|r| (s.key_of(r.ayah_id), r.kind.clone()))
                .collect();
            let expected: Vec<(String, String)> = tanzil
                .sajdas
                .iter()
                .map(|t| (t.key.to_string(), t.kind.as_str().to_owned()))
                .collect();
            gate.equal(
                "sajda ayahs and kinds == Tanzil, in order",
                sajdas,
                expected,
            );

            let mut meta = Violations::default();
            for (row, t) in s.surahs.iter().zip(&tanzil.suras) {
                if row.name_en != t.ename || row.rukus != t.rukus {
                    meta.push(|| {
                        format!(
                            "surah {}: name_en {:?} / rukus {}, Tanzil {:?} / {}",
                            row.id, row.name_en, row.rukus, t.ename, t.rukus
                        )
                    });
                }
            }
            gate.none("surah.name_en and surah.rukus == Tanzil (D6)", &meta);
        }
        Err(e) => {
            for name in [
                "juz/hizb/manzil/ruku/rub boundaries == Tanzil",
                "sajda == Tanzil",
                "surah metadata == Tanzil",
            ] {
                gate.unavailable(name, e);
            }
        }
    }

    let obligatory: Vec<String> = s
        .sajda
        .iter()
        .filter(|r| r.kind == SajdaKind::Obligatory.as_str())
        .map(|r| s.key_of(r.ayah_id))
        .collect();
    gate.equal(
        "obligatory sajdas",
        obligatory,
        OBLIGATORY_SAJDAS
            .iter()
            .map(|(s, a)| format!("{s}:{a}"))
            .collect(),
    );
    let mut sajda_values = Violations::default();
    for a in &s.ayahs {
        let expected = match s
            .sajda
            .iter()
            .find(|r| r.ayah_id == a.id)
            .map(|r| r.kind.as_str())
        {
            Some("recommended") => SajdaKind::Recommended.ayah_value(),
            Some("obligatory") => SajdaKind::Obligatory.ayah_value(),
            Some(_) | None => 0,
        };
        if a.sajda != expected {
            sajda_values
                .push(|| format!("{}: ayah.sajda {}, expected {expected}", a.key(), a.sajda));
        }
    }
    gate.none(
        "ayah.sajda follows the sajda table (0 none, 1 recommended, 2 obligatory)",
        &sajda_values,
    );

    // §3.1.2 flags.
    let mut flags = Violations::default();
    let mut previous: Option<&AyahRow> = None;
    for a in &s.ayahs {
        let rub_start = previous.is_none_or(|p| p.rub != a.rub);
        let mut expected = 0;
        if rub_start {
            expected |= FLAG_RUB_START;
            if a.rub.checked_sub(1).is_some_and(|r| r % 4 == 0) {
                expected |= FLAG_HIZB_START;
            }
        }
        if previous.is_none_or(|p| p.juz != a.juz) {
            expected |= FLAG_JUZ_START;
        }
        if a.ayah == 1 {
            expected |= FLAG_SURAH_START;
        }
        if a.flags != expected {
            flags.push(|| {
                format!(
                    "{}: flags {:#06b}, expected {expected:#06b}",
                    a.key(),
                    a.flags
                )
            });
        }
        previous = Some(a);
    }
    gate.none(
        "ayah.flags bits 0–3 follow §3.1.2 and no other bit is set",
        &flags,
    );

    // The inline ۞ (kept as printed, docs/deviations/WP3a.md) must sit where the mushaf-source rub starts.
    let mut inline = Violations::default();
    let mut signs = 0_usize;
    for w in s.words.iter().filter(|w| w.text_hafs.contains(RUB_SIGN)) {
        signs += 1;
        let rub_start = s
            .ayah(w.ayah_id)
            .is_some_and(|a| a.flags & FLAG_RUB_START != 0);
        if !(w.position == 1
            && rub_start
            && w.text_hafs.starts_with(RUB_PREFIX)
            && w.text_hafs.matches(RUB_SIGN).count() == 1)
        {
            inline.push(|| format!("{}: {}", w.location(), w.text_hafs));
        }
    }
    gate.none(
        "the inline ۞ only opens the first word of a rub-start ayah, as \"۞ \"",
        &inline,
    );
    let rub_starts_after_ayah_1 = s
        .ayahs
        .iter()
        .filter(|a| a.flags & FLAG_RUB_START != 0 && a.ayah != 1)
        .count();
    gate.fact("inlineRubSigns", signs);
    gate.fact("rubStartsNotAtAyah1", rub_starts_after_ayah_1);
    Ok(())
}

fn g11b_sajda_glyphs(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let mut per_ayah: BTreeMap<u32, Vec<&WordRow>> = BTreeMap::new();
    for w in s.words.iter().filter(|w| w.text_hafs.contains(SAJDA_SIGN)) {
        per_ayah.entry(w.ayah_id).or_default().push(w);
    }
    let glyph_ayahs: BTreeSet<u32> = per_ayah.keys().copied().collect();
    let table: BTreeSet<u32> = s.sajda.iter().map(|r| r.ayah_id).collect();
    let keys = |set: &BTreeSet<u32>| set.iter().map(|id| s.key_of(*id)).collect::<Vec<_>>();
    gate.equal(
        "the ayahs with a ۩ word == the sajda table",
        keys(&glyph_ayahs),
        keys(&table),
    );
    gate.equal(
        "the sajda table has 15 ayahs",
        table.len(),
        DIVISION_COUNTS[5].1,
    );
    let mut found = Violations::default();
    for (ayah, words) in &per_ayah {
        if words.len() != 1 {
            found.push(|| format!("{}: {} words carry ۩", s.key_of(*ayah), words.len()));
        }
        for w in words {
            if w.is_end || w.text_hafs.matches(SAJDA_SIGN).count() != 1 {
                found.push(|| format!("{}: {} (is_end {})", w.location(), w.text_hafs, w.is_end));
            }
        }
    }
    gate.none(
        "exactly one word per sajda ayah carries ۩, once, and it is not an end marker",
        &found,
    );
    gate.fact(
        "sajdaWords",
        per_ayah
            .values()
            .flatten()
            .map(|w| w.location())
            .collect::<Vec<_>>(),
    );
    Ok(())
}

// ---- G12, G13: search and normaliser ------------------------------------------------------------------------------

/// One §4.5 search probe.
struct Probe {
    column: &'static str,
    term: &'static str,
    prefix: bool,
    /// Ayahs the hits must include.
    must_hit: &'static [(u32, u32)],
}

const PROBES: [Probe; 5] = [
    Probe {
        column: "loose",
        term: "الرحمن",
        prefix: false,
        must_hit: &[(1, 1), (1, 3)],
    },
    Probe {
        column: "loose",
        term: "العالمين",
        prefix: false,
        must_hit: &[(1, 2)],
    },
    Probe {
        column: "loose",
        term: "الصلاه",
        prefix: false,
        must_hit: &[(2, 3)],
    },
    Probe {
        column: "loose",
        term: "الرح",
        prefix: true,
        must_hit: &[],
    },
    Probe {
        column: "strict",
        term: "الصلاة",
        prefix: false,
        must_hit: &[(2, 3)],
    },
];

/// `{column} : ("{term}")`, or `("{term}"*)` for a prefix, with `term` normalised for the column (§2.2.5).
fn match_expression(column: &str, term: &str, prefix: bool) -> String {
    let level = if column == "strict" {
        Level::Strict
    } else {
        Level::Loose
    };
    let normalised = normalize_ar(term, level).replace('"', "");
    format!(
        "{column} : (\"{normalised}\"{})",
        if prefix { "*" } else { "" }
    )
}

fn g12_search(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let conn = ctx.conn;
    let (fts_rows, min, max): (u32, Option<u32>, Option<u32>) = conn
        .query_row(
            "SELECT count(*), min(id), max(id) FROM ayah_fts_docsize",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .context("count the ayah_fts rows")?;
    gate.equal(
        "ayah_fts rows (count, first rowid, last rowid)",
        (fts_rows, min, max),
        (AYAHS, Some(1), Some(AYAHS)),
    );

    let mut hits_report = BTreeMap::new();
    for probe in &PROBES {
        let expression = match_expression(probe.column, probe.term, probe.prefix);
        let hits: Vec<u32> = column(
            conn,
            "SELECT rowid FROM ayah_fts WHERE ayah_fts MATCH ?1 ORDER BY rowid",
            params![expression],
        )?;
        let keys: BTreeSet<AyahKey> = hits
            .iter()
            .filter_map(|id| s.ayah(*id).map(AyahRow::key))
            .collect();
        let missing: Vec<String> = probe
            .must_hit
            .iter()
            .map(|(su, a)| AyahKey::new(*su, *a))
            .filter(|k| !keys.contains(k))
            .map(|k| k.to_string())
            .collect();
        let wanted = if probe.must_hit.is_empty() {
            "≥ 1 hit".to_owned()
        } else {
            probe
                .must_hit
                .iter()
                .map(|(su, a)| format!("{su}:{a}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        gate.check(
            format!("{expression} hits {wanted}"),
            missing.is_empty() && !hits.is_empty(),
            if missing.is_empty() {
                format!("{} hits", hits.len())
            } else {
                format!("{} hits, missing {}", hits.len(), missing.join(", "))
            },
        );
        hits_report.insert(expression, hits.len());
    }
    gate.fact("hits", &hits_report);

    let vocab: Vec<(String, u32)> = rows_of(
        conn,
        "SELECT term, doc_count FROM vocab_loose ORDER BY term",
    )?;
    gate.check(
        "vocab_loose has 14,000–15,500 terms",
        VOCAB_TERMS.contains(&vocab.len()),
        format!("{} terms", vocab.len()),
    );
    gate.fact("vocabLooseTerms", vocab.len());

    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.verify_vocab_col USING fts5vocab(main, ayah_fts, col);
         CREATE VIRTUAL TABLE IF NOT EXISTS temp.verify_vocab_instance USING fts5vocab(main, ayah_fts, instance);",
    )
    .context("create the fts5vocab tables")?;
    let index_vocab: Vec<(String, u32)> = rows_of(
        conn,
        "SELECT term, doc FROM temp.verify_vocab_col WHERE col = 'loose' ORDER BY term",
    )?;
    let mut differ = Violations::default();
    let ours: BTreeMap<&str, u32> = vocab.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    let theirs: BTreeMap<&str, u32> = index_vocab.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    for (term, n) in &ours {
        if theirs.get(term) != Some(n) {
            differ.push(|| format!("{term}: vocab_loose {n}, index {:?}", theirs.get(term)));
        }
    }
    for (term, n) in &theirs {
        if !ours.contains_key(term) {
            differ.push(|| format!("{term}: missing from vocab_loose (index: {n} ayahs)"));
        }
    }
    gate.none(
        "vocab_loose == the index's loose vocabulary (term, ayah count)",
        &differ,
    );

    // The index holds exactly the tokens of norm_loose / norm_strict, in order, for every ayah.
    let mut index: BTreeMap<(u32, String), Vec<(u32, String)>> = BTreeMap::new();
    let instances: Vec<(u32, String, u32, String)> = rows(
        conn,
        "SELECT doc, col, \"offset\", term FROM temp.verify_vocab_instance",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    for (doc, col, offset, term) in instances {
        index.entry((doc, col)).or_default().push((offset, term));
    }
    let mut mismatched = Violations::default();
    for a in &s.ayahs {
        for (col, text) in [("loose", &a.norm_loose), ("strict", &a.norm_strict)] {
            let mut actual = index.remove(&(a.id, col.to_owned())).unwrap_or_default();
            actual.sort_unstable();
            let expected: Vec<(u32, String)> = (0_u32..)
                .zip(quran_core::tokens(text).map(str::to_owned))
                .collect();
            if actual != expected {
                mismatched.push(|| {
                    format!(
                        "{} {col}: index [{}], norm_{col} [{}]",
                        a.key(),
                        actual
                            .iter()
                            .map(|(_, t)| t.as_str())
                            .collect::<Vec<_>>()
                            .join(" "),
                        text
                    )
                });
            }
        }
    }
    for (doc, col) in index.keys() {
        mismatched.push(|| format!("the index has {col} tokens for rowid {doc}, which is no ayah"));
    }
    gate.none(
        "the FTS index holds exactly the norm_loose / norm_strict tokens of every ayah",
        &mismatched,
    );
    Ok(())
}

/// Two-column rows `(String, u32)`.
fn rows_of(conn: &Connection, sql: &str) -> anyhow::Result<Vec<(String, u32)>> {
    rows(conn, sql, [], |r| Ok((r.get(0)?, r.get(1)?)))
}

fn g13_normaliser(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    gate.equal(
        "meta.normalizer_version == quran_core::NORMALIZER_VERSION",
        s.meta.get("normalizer_version").cloned(),
        Some(NORMALIZER_VERSION.to_string()),
    );
    gate.fact("normalizerVersion", NORMALIZER_VERSION);

    let (mut ayahs, mut stripped) = (Violations::default(), Violations::default());
    for a in &s.ayahs {
        if a.norm_loose != normalize_ar(&a.text_imlaei, Level::Loose)
            || a.norm_strict != normalize_ar(&a.text_imlaei, Level::Strict)
        {
            ayahs.push(|| format!("{}: norm_* differ from normalize_ar(text_imlaei)", a.key()));
        }
        for (column, text) in [
            ("norm_loose", &a.norm_loose),
            ("norm_strict", &a.norm_strict),
        ] {
            if let Some(c) = text
                .chars()
                .find(|c| quran_core::normalize::is_stripped(*c))
            {
                stripped.push(|| format!("{} {column} keeps U+{:04X}", a.key(), u32::from(c)));
            }
        }
    }
    gate.none(
        "ayah.norm_loose / norm_strict == normalize_ar(text_imlaei, Loose / Strict)",
        &ayahs,
    );

    let (mut words, mut nulls) = (Violations::default(), Violations::default());
    for w in &s.words {
        match (w.is_end, &w.text_imlaei, &w.norm_loose) {
            (true, None, None) => {}
            (false, Some(imlaei), Some(norm)) if !imlaei.trim().is_empty() => {
                if *norm != normalize_ar(imlaei, Level::Loose) || norm.is_empty() {
                    words.push(|| format!("{}: norm_loose {norm:?} for {imlaei:?}", w.location()));
                }
                if let Some(c) = norm
                    .chars()
                    .find(|c| quran_core::normalize::is_stripped(*c))
                {
                    stripped.push(|| {
                        format!("{} norm_loose keeps U+{:04X}", w.location(), u32::from(c))
                    });
                }
            }
            _ => nulls.push(|| {
                format!(
                    "{} (is_end {}): text_imlaei {:?}, norm_loose {:?}",
                    w.location(),
                    w.is_end,
                    w.text_imlaei,
                    w.norm_loose
                )
            }),
        }
    }
    gate.none(
        "end markers have no Imla'i text; every other word has a non-empty one",
        &nulls,
    );
    gate.none(
        "word.norm_loose == normalize_ar(text_imlaei, Loose), never empty",
        &words,
    );
    gate.none(
        "no char of the step-1 deletion set survives in norm_loose / norm_strict",
        &stripped,
    );

    let mut joined = Violations::default();
    for group in s.words_by_ayah() {
        let Some(first) = group.first() else {
            continue;
        };
        let expected = group
            .iter()
            .filter_map(|w| w.text_imlaei.as_deref())
            .collect::<Vec<_>>()
            .join(" ");
        if s.ayah(first.ayah_id)
            .is_some_and(|a| a.text_imlaei != expected)
        {
            joined.push(|| {
                format!(
                    "{}: ayah.text_imlaei differs from its words joined by U+0020",
                    s.key_of(first.ayah_id)
                )
            });
        }
    }
    gate.none(
        "ayah.text_imlaei is its words' text_imlaei joined by U+0020",
        &joined,
    );
    Ok(())
}

// ---- G14, G15: SQLite and performance -----------------------------------------------------------------------------

/// `(type, name, tbl_name, sql with whitespace collapsed)` of every schema object except ANALYZE's statistics.
fn schema_objects(conn: &Connection) -> anyhow::Result<BTreeSet<(String, String, String, String)>> {
    let objects: Vec<(String, String, String, Option<String>)> = rows(
        conn,
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok(objects
        .into_iter()
        .map(|(kind, name, table, sql)| {
            let sql = sql
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (kind, name, table, sql)
        })
        .collect())
}

/// The schema objects that differ from a fresh database built from `quran_core::CORE_SQL`.
fn schema_differences(conn: &Connection) -> anyhow::Result<Violations> {
    let fresh = Connection::open_in_memory().context("open an in-memory database")?;
    fresh.execute_batch(CORE_SQL).context("apply core.sql")?;
    let (expected, actual) = (schema_objects(&fresh)?, schema_objects(conn)?);
    let mut found = Violations::default();
    for (kind, name, _, _) in expected.difference(&actual) {
        found.push(|| format!("{kind} {name} is missing or differs from core.sql"));
    }
    for (kind, name, _, _) in actual.difference(&expected) {
        found.push(|| format!("{kind} {name} is not in core.sql (or differs from it)"));
    }
    Ok(found)
}

fn g14_sqlite(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let conn = ctx.conn;
    let integrity: Vec<String> = column(conn, "PRAGMA integrity_check(20)", [])?;
    gate.equal("PRAGMA integrity_check", integrity, vec!["ok".to_owned()]);
    let foreign: Vec<(String, Option<i64>, String, i64)> =
        rows(conn, "PRAGMA foreign_key_check", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
    let mut dangling = Violations::default();
    for (table, rowid, parent, _) in &foreign {
        dangling.push(|| format!("{table} rowid {rowid:?} → {parent}"));
    }
    gate.none("PRAGMA foreign_key_check is empty", &dangling);
    let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    gate.equal(
        "PRAGMA journal_mode",
        journal.to_ascii_lowercase(),
        "delete".to_owned(),
    );
    gate.check(
        "file < 16 MiB",
        ctx.bytes < MAX_DB_BYTES,
        format!("{} bytes ({} KiB)", ctx.bytes, ctx.bytes / 1024),
    );
    let page_size: u32 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    gate.equal("PRAGMA page_size", page_size, PAGE_SIZE);
    gate.none(
        "the schema is exactly core.sql's",
        &schema_differences(conn)?,
    );

    let freelist: u32 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
    if freelist > 0 {
        gate.warn(format!(
            "{freelist} free page(s): the §3.1.1 VACUUM did not run last"
        ));
    }
    let stats: u32 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
            [],
            |r| r.get(0),
        )
        .context("look for sqlite_stat1")?;
    if stats == 0 {
        gate.warn("no sqlite_stat1: the §3.1.1 ANALYZE did not run");
    }
    gate.fact("bytes", ctx.bytes);
    gate.fact("pageSize", page_size);
    gate.fact("freelistPages", freelist);

    match ctx.snapshot() {
        Ok(s) => check_meta(&s.meta, gate),
        Err(e) => gate.unavailable("meta", &e.to_string()),
    }
    Ok(())
}

fn check_meta(meta: &BTreeMap<String, String>, gate: &mut Recorder) {
    let keys: Vec<&str> = meta.keys().map(String::as_str).collect();
    gate.equal("meta keys (§3.1.1)", keys, META_KEYS.to_vec());
    let get = |key: &str| meta.get(key).map(String::as_str);
    gate.equal(
        "meta.schema_version == CORE_SCHEMA_VERSION",
        get("schema_version").map(str::to_owned),
        Some(CORE_SCHEMA_VERSION.to_string()),
    );
    gate.check(
        "meta.source is qdc or qul",
        matches!(get("source"), Some("qdc" | "qul")),
        format!("{:?}", get("source")),
    );
    let built_at = get("built_at").unwrap_or_default();
    let utc = OffsetDateTime::parse(built_at, &Rfc3339).is_ok_and(|t| t.offset().is_utc());
    gate.check("meta.built_at is RFC 3339 UTC", utc, built_at);
    let builder = get("builder").unwrap_or_default();
    gate.check(
        "meta.builder is the xtask that built it",
        builder.starts_with("xtask "),
        builder,
    );
    for key in ["source_manifest_sha256", "tanzil_sha256"] {
        let value = get(key).unwrap_or_default();
        gate.check(
            format!("meta.{key} is a sha256"),
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            value,
        );
    }
    let licence = get("licence_note").unwrap_or_default();
    gate.check(
        "meta.licence_note is set",
        !licence.trim().is_empty(),
        format!("{} chars", licence.chars().count()),
    );
    if get("source") == Some("qdc") && !licence.contains("NEVER DISTRIBUTE") {
        gate.warn("a qdc build's licence_note should say NEVER DISTRIBUTE (QF Developer Terms)");
    }
}

/// `EXPLAIN QUERY PLAN` details without SQLite 3.53's ` LEFT-JOIN` suffix.
fn normalise_plan(details: &[String]) -> Vec<String> {
    details
        .iter()
        .map(|d| d.strip_suffix(" LEFT-JOIN").unwrap_or(d).to_owned())
        .collect()
}

/// Nearest-rank percentile of sorted samples.
fn percentile(sorted: &[Duration], p: f64) -> Option<Duration> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (p / 100.0 * sorted.len() as f64).ceil();
    let index = usize::try_from(rank as u64).ok()?.saturating_sub(1);
    sorted.get(index.min(sorted.len() - 1)).copied()
}

/// Runs [`PAGE_SQL`] once and reads every column of every row, as `CoreDb` does. Returns the row count.
fn run_page_query(
    stmt: &mut rusqlite::CachedStatement<'_>,
    mushaf: u32,
    page: u32,
    selector: u8,
) -> rusqlite::Result<usize> {
    let mut rows = stmt.query(params![mushaf, page, selector])?;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        // Integers: line, kind, centered, surah_id, the word fields and the ayah fields; text: glyph, text_hafs.
        for index in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16] {
            std::hint::black_box(row.get::<_, Option<i64>>(index)?);
        }
        for index in [10, 11] {
            std::hint::black_box(row.get::<_, Option<String>>(index)?);
        }
        count += 1;
    }
    Ok(count)
}

const fn style_name(style: MushafStyle) -> &'static str {
    match style {
        MushafStyle::Hafs => "hafs",
        MushafStyle::QcfV2 => "qcf_v2",
        MushafStyle::QcfV1 => "qcf_v1",
        MushafStyle::QcfV4 => "qcf_v4",
    }
}

fn g15_performance(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let conn = ctx.conn;
    let mut plans = BTreeMap::new();
    for (mushaf, code, _) in MUSHAFS {
        let selector = if mushaf == V1 { 1 } else { 2 };
        let details: Vec<String> = rows(
            conn,
            &format!("EXPLAIN QUERY PLAN {PAGE_SQL}"),
            params![mushaf, PLAN_PAGE, selector],
            |r| r.get(3),
        )?;
        let plan = normalise_plan(&details);
        gate.check(
            format!("{code}: the page query plan is exactly the §3.1.4 one (no other step)"),
            plan == PAGE_PLAN,
            details.join(" | "),
        );
        plans.insert(code, details);
    }
    gate.fact("plan", &plans);

    let s = ctx.snapshot()?;
    // Rows the page query must return: one per header line, one per word of every ayah line.
    let mut expected_rows: BTreeMap<(u32, u32), usize> = BTreeMap::new();
    for l in &s.lines {
        let rows = match (l.kind, l.first_word_id, l.last_word_id) {
            (KIND_AYAH, Some(first), Some(last)) => last.saturating_sub(first) as usize + 1,
            _ => 1,
        };
        *expected_rows.entry((l.mushaf_id, l.page)).or_default() += rows;
    }

    let mut stmt = conn
        .prepare_cached(PAGE_SQL)
        .context("prepare the page query")?;
    let mut samples = Vec::with_capacity(MushafStyle::ALL.len() * PAGES as usize);
    let mut per_style = BTreeMap::new();
    let mut wrong_rows = Violations::default();
    for style in MushafStyle::ALL {
        let mushaf = style.layout().db_id();
        let selector = style.glyph_selector();
        for page in 1..=PAGES {
            run_page_query(&mut stmt, mushaf, page, selector)?; // warm the page cache first
        }
        let mut times = Vec::with_capacity(PAGES as usize);
        for page in 1..=PAGES {
            let started = Instant::now();
            let count = run_page_query(&mut stmt, mushaf, page, selector)?;
            times.push(started.elapsed());
            let expected = expected_rows.get(&(mushaf, page)).copied().unwrap_or(0);
            if count != expected || count == 0 {
                wrong_rows.push(|| {
                    format!(
                        "{} page {page}: {count} rows, the lines hold {expected}",
                        style_name(style)
                    )
                });
            }
        }
        samples.extend_from_slice(&times);
        times.sort_unstable();
        let stats = [50.0, 99.0, 100.0].map(|p| percentile(&times, p).map_or(0.0, millis));
        per_style.insert(
            style_name(style),
            serde_json::json!({ "p50Ms": stats[0], "p99Ms": stats[1], "maxMs": stats[2] }),
        );
        gate.check(
            format!("{}: p99 of the 604 page queries < 5 ms", style_name(style)),
            percentile(&times, 99.0).is_some_and(|p| p < PAGE_QUERY_P99),
            format!(
                "p50 {:.3} ms, p99 {:.3} ms, max {:.3} ms",
                stats[0], stats[1], stats[2]
            ),
        );
    }
    gate.none(
        "every page query returns one row per header line and per word of the page",
        &wrong_rows,
    );
    samples.sort_unstable();
    let p99 = percentile(&samples, 99.0);
    gate.check(
        "all page queries: p99 < 5 ms",
        p99.is_some_and(|p| p < PAGE_QUERY_P99),
        format!(
            "{} queries, p99 {:.3} ms",
            samples.len(),
            p99.map_or(0.0, millis)
        ),
    );
    gate.fact("queries", samples.len());
    gate.fact("p99Ms", p99.map_or(0.0, millis));
    gate.fact("perStyle", &per_style);
    Ok(())
}

// ---- G16 ----------------------------------------------------------------------------------------------------------

fn g16_header_map(ctx: &Ctx<'_>, gate: &mut Recorder) -> anyhow::Result<()> {
    let s = ctx.snapshot()?;
    let cp = |surah: u32| {
        s.surahs
            .iter()
            .find(|r| r.id == surah)
            .and_then(|r| r.header_cp)
    };
    match &ctx.headers {
        Ok(Some(map)) => {
            gate.equal(
                "header_cp is set for 114 surahs",
                s.surahs.iter().filter(|r| r.header_cp.is_some()).count(),
                114,
            );
            let mut found = Violations::default();
            for surah in 1..=SURAHS {
                if cp(surah) != map.get(surah) {
                    found.push(|| {
                        format!(
                            "surah {surah}: header_cp {:?}, the map says {:?}",
                            cp(surah),
                            map.get(surah)
                        )
                    });
                }
            }
            gate.none(
                "header_cp == xtask/data/qcf_surah_header_cmap.json for every surah",
                &found,
            );
            for (surah, expected) in HEADER_CP {
                gate.equal(
                    format!("header_cp of surah {surah}"),
                    cp(surah).map(|c| format!("U+{c:04X}")),
                    Some(format!("U+{expected:04X}")),
                );
            }
            gate.fact("headerMap", "present");
        }
        Ok(None) => {
            gate.warn(format!(
                "xtask/data/{HEADER_MAP_FILE} is absent: header_cp must be NULL"
            ));
            gate.equal(
                "header_cp is NULL for every surah (no map)",
                s.surahs.iter().filter(|r| r.header_cp.is_some()).count(),
                0,
            );
            gate.fact("headerMap", "absent");
        }
        Err(e) => gate.unavailable("header_cp == the header map", e),
    }
    Ok(())
}

// ---- outcome, console and report ----------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputReport {
    path: Option<String>,
    value: Option<Value>,
    error: Option<String>,
}

impl InputReport {
    fn ok(path: &Path, value: Value) -> Self {
        Self {
            path: Some(path.display().to_string()),
            value: Some(value),
            error: None,
        }
    }

    fn error(message: &str) -> Self {
        Self {
            path: None,
            value: None,
            error: Some(message.to_owned()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputsReport {
    tanzil: InputReport,
    division_exceptions: InputReport,
    header_map: InputReport,
}

/// Everything one run found.
struct Outcome {
    db: PathBuf,
    bytes: u64,
    sha256: String,
    meta: BTreeMap<String, String>,
    inputs: InputsReport,
    gates: Vec<GateReport>,
    duration: Duration,
}

impl Outcome {
    fn failed_gates(&self) -> Vec<&'static str> {
        self.gates
            .iter()
            .filter(|g| !g.passed)
            .map(|g| g.id)
            .collect()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    tool: String,
    spec: &'static str,
    db: String,
    bytes: u64,
    sha256: &'a str,
    meta: &'a BTreeMap<String, String>,
    inputs: &'a InputsReport,
    passed: bool,
    summary: Summary,
    duration_ms: f64,
    gates: &'a [GateReport],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    gates: usize,
    passed: usize,
    failed: Vec<&'static str>,
    checks: usize,
    failed_checks: usize,
    warnings: usize,
}

fn summary(outcome: &Outcome) -> Summary {
    let failed = outcome.failed_gates();
    Summary {
        gates: outcome.gates.len(),
        passed: outcome.gates.len() - failed.len(),
        failed,
        checks: outcome.gates.iter().map(|g| g.checks.len()).sum(),
        failed_checks: outcome
            .gates
            .iter()
            .flat_map(|g| &g.checks)
            .filter(|c| !c.passed)
            .count(),
        warnings: outcome.gates.iter().map(|g| g.warnings.len()).sum(),
    }
}

fn write_report(path: &Path, outcome: &Outcome) -> anyhow::Result<()> {
    let summary = summary(outcome);
    let report = Report {
        tool: concat!("xtask verify-core ", env!("CARGO_PKG_VERSION")).to_owned(),
        spec: "docs/ARCHITECTURE.md §4.5 (G1–G16, G5b, G11b); accepted source facts: docs/deviations/WP3b.md",
        db: outcome.db.display().to_string(),
        bytes: outcome.bytes,
        sha256: &outcome.sha256,
        meta: &outcome.meta,
        inputs: &outcome.inputs,
        passed: summary.failed.is_empty(),
        summary,
        duration_ms: millis(outcome.duration),
        gates: &outcome.gates,
    };
    let mut json = serde_json::to_string_pretty(&report).context("serialise the report")?;
    json.push('\n');
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    std::fs::write(path, json).with_context(|| format!("write {}", path.display()))
}

fn print_outcome(outcome: &Outcome) {
    let get = |key: &str| outcome.meta.get(key).map_or("?", String::as_str);
    eprintln!(
        "verify-core: {} ({} KiB, sha256 {}…; source {}, built_at {}, {})",
        outcome.db.display(),
        outcome.bytes / 1024,
        outcome.sha256.get(..12).unwrap_or_default(),
        get("source"),
        get("built_at"),
        get("builder")
    );
    match (&outcome.inputs.tanzil.path, &outcome.inputs.tanzil.error) {
        (Some(path), _) => eprintln!("verify-core: Tanzil {path} (sha256 = meta.tanzil_sha256)"),
        (None, Some(e)) => eprintln!("verify-core: Tanzil unavailable: {e}"),
        (None, None) => {}
    }
    for gate in &outcome.gates {
        let failed = gate.checks.iter().filter(|c| !c.passed).count();
        let mut line = format!(
            "verify-core:   {:<4} {:<5} {:<13} {:>2} checks",
            if gate.passed { "ok" } else { "FAIL" },
            gate.id,
            gate.title,
            gate.checks.len()
        );
        if failed > 0 {
            let _ = write!(line, ", {failed} failed");
        }
        let _ = write!(line, "  [{:.0} ms]", gate.duration_ms);
        eprintln!("{line}");
        for check in gate.checks.iter().filter(|c| !c.passed) {
            eprintln!("verify-core:          x {}: {}", check.name, check.detail);
        }
        if let Some(error) = &gate.error {
            eprintln!("verify-core:          x error: {error}");
        }
        for warning in &gate.warnings {
            eprintln!("verify-core:          ! warning: {warning}");
        }
    }
    let summary = summary(outcome);
    eprintln!(
        "verify-core: {}/{} gates passed ({} checks, {} failed, {} warning(s)) in {:.1} s",
        summary.passed,
        summary.gates,
        summary.checks,
        summary.failed_checks,
        summary.warnings,
        outcome.duration.as_secs_f64()
    );
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn line(
        page: u32,
        line: u32,
        kind: u32,
        surah: Option<u32>,
        words: Option<(u32, u32)>,
    ) -> LineRow {
        LineRow {
            mushaf_id: 1,
            page,
            line,
            kind,
            centered: kind != KIND_AYAH,
            surah_id: surah,
            first_word_id: words.map(|w| w.0),
            last_word_id: words.map(|w| w.1),
        }
    }

    #[test]
    fn spaces_are_classified() {
        assert_eq!(
            classify_spaces("وَأَنَابَ ۩"),
            SpaceKinds {
                before_sajda: 1,
                rub_prefix: false,
                other: 0
            }
        );
        assert_eq!(
            classify_spaces("۞ إِنَّ"),
            SpaceKinds {
                before_sajda: 0,
                rub_prefix: true,
                other: 0
            }
        );
        assert_eq!(
            classify_spaces("بَعۡدَ مَا"),
            SpaceKinds {
                before_sajda: 0,
                rub_prefix: false,
                other: 1
            }
        );
        assert_eq!(classify_spaces("يَسۡجُدُونَۤ۩"), SpaceKinds::default());
        // A ۞ later in the word is not the printed prefix.
        assert_eq!(classify_spaces("إِنَّ ۞ ا").other, 2);
    }

    #[test]
    fn glyph_codes_allow_one_inner_space_only_where_allowed() {
        assert_eq!(glyph_code_problem("\u{FC45}", false), None);
        assert_eq!(glyph_code_problem("\u{FBE9}\u{FBEA}", false), None);
        assert_eq!(glyph_code_problem("\u{FC68} \u{FC69}", true), None);
        assert!(glyph_code_problem("\u{FC68} \u{FC69}", false).is_some());
        assert!(
            glyph_code_problem(" \u{FC69}", true).is_some(),
            "leading space"
        );
        assert!(
            glyph_code_problem("\u{FC69} ", true).is_some(),
            "trailing space"
        );
        assert!(
            glyph_code_problem("\u{FC68}  \u{FC69}", true).is_some(),
            "two spaces"
        );
        assert!(
            glyph_code_problem("\u{FC68}\u{00A0}\u{FC69}", true).is_some(),
            "NBSP"
        );
        assert!(glyph_code_problem("\u{FC68}\n", true).is_some(), "newline");
        assert!(glyph_code_problem("", false).is_some(), "empty");
        assert!(glyph_code_problem("abcde", false).is_some(), "5 chars");
        assert_eq!(
            glyph_code_problem("\u{FC68}\t\u{FC69}", true).map(|p| p.contains("whitespace")),
            Some(true)
        );
    }

    #[test]
    fn header_geometry_follows_c15_in_reading_order() {
        // Page 1: surah 1 (one-line header). Page 2: surah 2 (two lines). Page 3 ends with surah 3's surah_name, page
        // 4 opens with its basmallah (the An-Nisa shape).
        let mut lines = vec![
            line(1, 1, KIND_SURAH_NAME, Some(1), None),
            line(1, 2, KIND_AYAH, None, Some((1, 5))),
            line(2, 1, KIND_SURAH_NAME, Some(2), None),
            line(2, 2, KIND_BASMALLAH, Some(2), None),
            line(2, 3, KIND_AYAH, None, Some((6, 9))),
        ];
        for l in 1..=14 {
            lines.push(line(3, l, KIND_AYAH, None, Some((10 + l, 10 + l))));
        }
        lines.push(line(3, 15, KIND_SURAH_NAME, Some(3), None));
        lines.push(line(4, 1, KIND_BASMALLAH, Some(3), None));
        lines.push(line(4, 2, KIND_AYAH, None, Some((30, 31))));
        let refs: Vec<&LineRow> = lines.iter().collect();
        let starts = [(1, Some(1)), (2, Some(6)), (3, Some(30))];
        let (found, previous) = header_geometry(&refs, &starts);
        assert!(found.is_empty(), "{found:?}");
        assert_eq!(previous, [3]);

        // The basmallah may never be on the previous page (here both header lines end page 3 and the surah's first
        // ayah line opens page 4).
        let mut moved: Vec<LineRow> = (1..=13)
            .map(|l| line(3, l, KIND_AYAH, None, Some((10 + l, 10 + l))))
            .collect();
        moved.push(line(3, 14, KIND_SURAH_NAME, Some(3), None));
        moved.push(line(3, 15, KIND_BASMALLAH, Some(3), None));
        moved.push(line(4, 1, KIND_AYAH, None, Some((30, 31))));
        let refs: Vec<&LineRow> = moved.iter().collect();
        let (found, previous) = header_geometry(&refs, &[(3, Some(30))]);
        assert!(
            found
                .samples
                .iter()
                .any(|s| s.contains("its basmallah is line 3:15")),
            "{found:?}"
        );
        assert!(previous.is_empty());

        // A header of the wrong surah, or a missing header line.
        let mut wrong = lines.clone();
        if let Some(l) = wrong.iter_mut().find(|l| l.page == 2 && l.line == 2) {
            l.surah_id = Some(3);
        }
        let refs: Vec<&LineRow> = wrong.iter().collect();
        assert_eq!(header_geometry(&refs, &starts).0.count, 1);
        let refs: Vec<&LineRow> = lines
            .iter()
            .filter(|l| !(l.page == 1 && l.line == 1))
            .collect();
        assert_eq!(
            header_geometry(&refs, &starts).0.count,
            1,
            "nothing above surah 1"
        );
        // A surah that does not start a line.
        let (found, _) = header_geometry(&lines.iter().collect::<Vec<_>>(), &[(2, Some(7))]);
        assert_eq!(found.count, 1);
    }

    #[test]
    fn a_cross_page_surah_name_must_be_the_last_line_of_the_previous_page() {
        // surah_name on page 3 line 14 with an ayah line between it and the basmallah would not be adjacent; here
        // the previous page is only 14 lines long (a shape G6 rejects), so it is not its last line.
        let mut lines: Vec<LineRow> = (1..=13)
            .map(|l| line(3, l, KIND_AYAH, None, Some((l, l))))
            .collect();
        lines.push(line(3, 14, KIND_SURAH_NAME, Some(3), None));
        lines.push(line(4, 1, KIND_BASMALLAH, Some(3), None));
        lines.push(line(4, 2, KIND_AYAH, None, Some((14, 20))));
        let refs: Vec<&LineRow> = lines.iter().collect();
        let (found, previous) = header_geometry(&refs, &[(3, Some(14))]);
        assert_eq!(found.count, 1, "{found:?}");
        assert!(previous.is_empty());
    }

    #[test]
    fn rub_differences_must_match_the_allowlist_exactly() {
        let key = |s, a| AyahKey::new(s, a);
        let allow = [RubException {
            id: 106,
            source: key(15, 49),
            tanzil: key(15, 50),
        }];
        let diff = |entries: &[(u32, AyahKey, AyahKey)]| -> BTreeMap<u32, (AyahKey, AyahKey)> {
            entries.iter().map(|(id, a, b)| (*id, (*a, *b))).collect()
        };
        assert!(
            judge_rub_differences(&diff(&[(106, key(15, 49), key(15, 50))]), &allow).is_empty()
        );
        // Stale: the entry no longer differs.
        let stale = judge_rub_differences(&diff(&[]), &allow);
        assert_eq!(stale.count, 1);
        assert!(stale.samples[0].contains("stale"), "{stale:?}");
        // Listed with other keys.
        assert_eq!(
            judge_rub_differences(&diff(&[(106, key(15, 48), key(15, 50))]), &allow).count,
            1
        );
        // Not listed at all (plus the stale 106).
        assert_eq!(
            judge_rub_differences(&diff(&[(7, key(2, 60), key(2, 61))]), &allow).count,
            2
        );
    }

    #[test]
    fn range_tables_must_tile_the_ayahs() {
        let r = |id, first, last| RangeRow {
            id,
            surah: None,
            first_ayah_id: first,
            last_ayah_id: last,
        };
        assert!(range_problems(&[r(1, 1, 4), r(2, 5, 10)], 10).is_empty());
        assert_eq!(
            range_problems(&[r(1, 1, 4), r(2, 6, 10)], 10).count,
            1,
            "gap"
        );
        assert_eq!(
            range_problems(&[r(1, 1, 4), r(3, 5, 10)], 10).count,
            1,
            "id"
        );
        assert_eq!(
            range_problems(&[r(1, 1, 4), r(2, 5, 9)], 10).count,
            1,
            "short"
        );
        assert_eq!(
            per_ayah(&[r(1, 1, 2), r(2, 3, 3)], 4),
            [Some(1), Some(1), Some(2), None]
        );
    }

    #[test]
    fn plans_percentiles_and_digits() {
        let plan = vec![
            PAGE_PLAN[0].to_owned(),
            format!("{} LEFT-JOIN", PAGE_PLAN[1]),
            format!("{} LEFT-JOIN", PAGE_PLAN[2]),
        ];
        assert_eq!(normalise_plan(&plan), PAGE_PLAN);
        let ms = |n: u64| Duration::from_millis(n);
        let samples: Vec<Duration> = (1..=200).map(ms).collect();
        assert_eq!(percentile(&samples, 99.0), Some(ms(198)));
        assert_eq!(percentile(&samples, 50.0), Some(ms(100)));
        assert_eq!(percentile(&samples, 100.0), Some(ms(200)));
        assert_eq!(percentile(&[ms(7)], 99.0), Some(ms(7)));
        assert_eq!(percentile(&[], 99.0), None);
        assert_eq!(arabic_indic(181), "١٨١");
        assert_eq!(arabic_indic(7), "٧");
        assert_eq!(code_points("\u{FBE9}\u{FBEA}"), "U+FBE9 U+FBEA");
        assert_eq!(
            match_expression("loose", "الرح", true),
            "loose : (\"الرح\"*)"
        );
        assert_eq!(
            match_expression("strict", "الصَّلَاة", false),
            "strict : (\"الصلاة\")"
        );
        assert_eq!(
            match_expression("loose", "الصلاة", false),
            "loose : (\"الصلاه\")"
        );
    }

    #[test]
    fn violations_keep_a_bounded_sample() {
        let mut v = Violations::default();
        assert_eq!(v.describe(), "none");
        for i in 0..20 {
            v.push(|| format!("v{i}"));
        }
        assert_eq!(v.count, 20);
        assert_eq!(v.samples.len(), MAX_SAMPLES);
        assert!(v.describe().starts_with("20 violation(s): v0; v1"));
        assert!(v.describe().ends_with('…'));
    }

    #[test]
    fn tanzil_is_found_by_its_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let xml = crate::build::tanzil::tests::synthetic_xml();
        let sha = hex::encode(Sha256::digest(xml.as_bytes()));
        let (absent, other, right) = (
            dir.path().join("absent.xml"),
            dir.path().join("other.xml"),
            dir.path().join("right.xml"),
        );
        std::fs::write(&other, "<quran/>").unwrap();
        std::fs::write(&right, &xml).unwrap();
        let (path, tanzil) =
            find_tanzil_in(&[absent.clone(), other.clone(), right.clone()], &sha).unwrap();
        assert_eq!(path, right);
        assert_eq!(tanzil.sha256, sha);
        let err = find_tanzil_in(&[absent, other], &sha).unwrap_err();
        assert!(err.contains("absent") && err.contains("sha256"), "{err}");
        // The right sha256 but not a valid metadata file.
        let bad = dir.path().join("bad.xml");
        std::fs::write(&bad, "<quran/>").unwrap();
        let bad_sha = hex::encode(Sha256::digest(b"<quran/>"));
        assert!(find_tanzil_in(&[bad], &bad_sha).is_err());
    }

    #[test]
    fn the_qul_manifest_names_the_tanzil_file() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("manifest.toml");
        std::fs::write(
            &manifest,
            "layout.v2 = { file = \"layout-10.sqlite\", resource = 10, sha256 = \"…\" }\n\
             tanzil    = { file = \"quran-data.xml\", sha256 = \"…\" }\n",
        )
        .unwrap();
        assert_eq!(
            qul_manifest_tanzil_file(&manifest).as_deref(),
            Some("quran-data.xml")
        );
        std::fs::write(&manifest, "tanzil = { file = \"../../secret.xml\" }\n").unwrap();
        assert_eq!(
            qul_manifest_tanzil_file(&manifest),
            None,
            "never a path outside data/sources/qul"
        );
        assert_eq!(
            qul_manifest_tanzil_file(&dir.path().join("missing.toml")),
            None
        );
        assert!(
            tanzil_candidates()
                .first()
                .is_some_and(|p| p.ends_with("data/cache/tanzil/quran-data.xml"))
        );
    }

    /// A database with the core.sql schema and a handful of rows (no real data). It has no ANALYZE statistics, so SQLite
    /// plans the page query as for the large tables of a real core.db (with statistics for 2 words it would scan).
    fn tiny_core(dir: &Path) -> PathBuf {
        let path = dir.join("tiny.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(CORE_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO mushaf VALUES (1, 'v2', 'Madani', 604, 15, 'code_v2');
             INSERT INTO surah VALUES (1, 'الفاتحة', 'Al-Fatihah', 'Al-Fātiĥah', 'The Opening', 'makkah', 5, 1, 1, 1, 0, 64581);
             INSERT INTO ayah VALUES (1, 1, 1, 1, 1, 1, 1, 1, 0, 15, 1, 2, 'بِسۡمِ ۝١', 'بِسْمِ', 'بسم', 'بسم');
             INSERT INTO word VALUES (1, 1, 1, 1, 1, 0, 'بِسۡمِ', 'بِسْمِ', 'بسم', 'a', 'b'), (2, 1, 1, 1, 2, 1, '۝١', NULL, NULL, 'c', 'd');
             INSERT INTO page VALUES (1, 1, 1, 2, 1, 1);
             INSERT INTO line VALUES (1, 1, 1, 1, 1, 1, NULL, NULL), (1, 1, 2, 0, 1, NULL, 1, 2);
             INSERT INTO ayah_fts(rowid, loose, strict) VALUES (1, 'بسم', 'بسم');",
        )
        .unwrap();
        path
    }

    #[test]
    fn a_core_sql_database_has_the_required_schema_and_plan() {
        let dir = tempfile::tempdir().unwrap();
        let conn =
            Connection::open_with_flags(tiny_core(dir.path()), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert!(schema_differences(&conn).unwrap().is_empty());
        let details: Vec<String> = rows(
            &conn,
            &format!("EXPLAIN QUERY PLAN {PAGE_SQL}"),
            params![1, 1, 2],
            |r| r.get(3),
        )
        .unwrap();
        assert_eq!(normalise_plan(&details), PAGE_PLAN, "{details:?}");
        let mut stmt = conn.prepare_cached(PAGE_SQL).unwrap();
        assert_eq!(
            run_page_query(&mut stmt, 1, 1, 2).unwrap(),
            3,
            "1 header line + 2 words"
        );
        drop(stmt);
        // An extra index is a schema difference.
        let writable = Connection::open(dir.path().join("tiny.db")).unwrap();
        writable
            .execute_batch("CREATE INDEX word_text ON word (text_hafs);")
            .unwrap();
        assert_eq!(schema_differences(&writable).unwrap().count, 1);
    }

    #[test]
    fn every_gate_runs_and_fails_cleanly_on_a_database_without_real_data() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = verify(
            &tiny_core(dir.path()),
            Some(&dir.path().join("no-tanzil.xml")),
        )
        .unwrap();
        assert_eq!(outcome.gates.len(), GATES.len());
        assert_eq!(
            outcome.gates.iter().map(|g| g.id).collect::<Vec<_>>(),
            [
                "G1", "G2", "G3", "G4", "G5", "G5b", "G6", "G7", "G8", "G9", "G10", "G11", "G11b",
                "G12", "G13", "G14", "G15", "G16"
            ]
        );
        let failed = outcome.failed_gates();
        for id in [
            "G1", "G2", "G6", "G7", "G8", "G10", "G11", "G11b", "G12", "G14", "G16",
        ] {
            assert!(
                failed.contains(&id),
                "{id} must fail on a 1-ayah database: {failed:?}"
            );
        }
        assert!(outcome.inputs.tanzil.error.is_some());
        // The report is written even though gates fail.
        let report = dir.path().join("out").join("report.json");
        write_report(&report, &outcome).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
        assert_eq!(json["passed"], Value::Bool(false));
        assert_eq!(json["gates"].as_array().map(Vec::len), Some(18));
        assert!(verify_db(&dir.path().join("tiny.db"), None).is_err());
    }

    #[test]
    fn an_empty_file_fails_every_gate_and_a_missing_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("core.db");
        std::fs::write(&empty, b"").unwrap();
        let outcome = verify(&empty, None).unwrap();
        assert_eq!(outcome.failed_gates().len(), GATES.len());
        let err = verify_db(&empty, None).unwrap_err().to_string();
        assert!(
            err.contains("18 of 18") && err.contains("placeholder"),
            "{err}"
        );
        let err = verify_db(&dir.path().join("absent.db"), None).unwrap_err();
        assert!(format!("{err:#}").contains("pnpm core:qdc"), "{err:#}");
    }
}
