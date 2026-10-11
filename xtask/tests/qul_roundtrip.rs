//! The QUL adapter end to end at full scale (WP3d; docs/ARCHITECTURE.md §4.3).
//!
//! The real QUL files need a login, so this test writes QUL-format exports of the M1 database
//! (`src-tauri/resources/core.db`) in the shapes QUL's exporter and help pages document:
//! - three layout DBs with `''` placeholders; V4 carries its own `words` table in another id space;
//! - four scripts in both column variants plus the exporter's JSON. They use QUL's `word_index` numbering with the 3
//!   extra slots of FACT C7, before 3:1:1, 8:7:1 and 14:1:1 (max id 83,668). End markers are bare digits.
//!   V1 uses the combined exporter's 38:24:32–33 grouping;
//! - surah names and rub/juz/hizb/manzil metadata as keyed JSON, a JSON array and SQLite;
//! - the Tanzil file and a manifest with the real hashes.
//!
//! It then requires `qul::read` + the shared `derive` to reproduce every row of the M1 database exactly (surahs,
//! divisions, ayahs, words, pages, lines), with the D5 regrouping applied and juz/hizb/manzil cross-checked against
//! QUL's files. The shared writer turns the rows into a `source = qul` core.db whose search vocabulary equals M1's, and
//! the real `xtask verify-core` binary must pass every gate on it. Then it adds the 3 extra word rows QUL may carry and
//! requires the build to stop and name them.
//!
//! The M1 database and the Tanzil cache are gitignored local files (`pnpm core:qdc`). When they are missing, the test
//! reports that it was skipped and passes.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod build {
    #[path = "../../src/build/derive.rs"]
    pub mod derive;
    #[path = "../../src/build/model.rs"]
    pub mod model;
    #[path = "../../src/build/qul.rs"]
    pub mod qul;
    #[path = "../../src/build/tanzil.rs"]
    pub mod tanzil;
    #[path = "../../src/build/write.rs"]
    pub mod write;
}

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, ensure};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use build::derive::{CoreData, DivisionExceptions, END_OF_AYAH, HeaderMap, arabic_indic};
use build::model::Location;
use build::qul::{self, Input};
use build::tanzil::Tanzil;
use build::write::{self, BuildMeta};

/// FACT C7: QUL's `word_index` runs one further ahead from each of these words (3:1:1 → 6440, 8:7:1 → 23790, 14:1:1 →
/// 34412; 114:6:4 → 83,668).
const EXTRA_SLOTS: [Location; 3] = [
    Location::new(3, 1, 1),
    Location::new(8, 7, 1),
    Location::new(14, 1, 1),
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from(".."), Path::to_path_buf)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// One `word` row of the M1 database.
#[derive(Clone, Debug)]
struct Word {
    id: u32,
    surah: u32,
    ayah: u32,
    position: u32,
    is_end: bool,
    text_hafs: String,
    text_imlaei: Option<String>,
    code_v1: String,
    code_v2: String,
}

impl Word {
    fn location(&self) -> String {
        format!("{}:{}:{}", self.surah, self.ayah, self.position)
    }
}

/// The M1 database, copied (so a concurrent `build-core` can still rename over the original).
struct M1 {
    _dir: tempfile::TempDir,
    db: Connection,
    tanzil: PathBuf,
    words: Vec<Word>,
    /// Canonical word id → QUL `word_index` (FACT C7 numbering).
    qul_ids: Vec<u32>,
}

impl M1 {
    fn open() -> anyhow::Result<Option<Self>> {
        let core = root().join("src-tauri/resources/core.db");
        let tanzil = root().join("data/cache/tanzil/quran-data.xml");
        let size = std::fs::metadata(&core).map(|m| m.len()).unwrap_or(0);
        if size < 1_000_000 || !tanzil.is_file() {
            eprintln!(
                "qul_roundtrip: SKIPPED: needs the M1 core.db ({} bytes found) and {} (run `pnpm core:qdc`)",
                size,
                tanzil.display()
            );
            return Ok(None);
        }
        let dir = tempfile::tempdir()?;
        let copy = dir.path().join("core.db");
        std::fs::copy(&core, &copy).with_context(|| format!("copy {}", core.display()))?;
        let db = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let recorded: String = db.query_row(
            "SELECT value FROM meta WHERE key = 'tanzil_sha256'",
            [],
            |r| r.get(0),
        )?;
        if recorded != sha256(&std::fs::read(&tanzil)?) {
            eprintln!(
                "qul_roundtrip: SKIPPED: core.db was built from another Tanzil file than {}",
                tanzil.display()
            );
            return Ok(None);
        }
        let words = {
            let mut stmt = db.prepare(
                "SELECT id, surah, ayah, position, is_end, text_hafs, text_imlaei, code_v1, code_v2 FROM word ORDER BY id",
            )?;
            stmt.query_map([], |r| {
                Ok(Word {
                    id: r.get(0)?,
                    surah: r.get(1)?,
                    ayah: r.get(2)?,
                    position: r.get(3)?,
                    is_end: r.get(4)?,
                    text_hafs: r.get(5)?,
                    text_imlaei: r.get(6)?,
                    code_v1: r.get(7)?,
                    code_v2: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        ensure!(words.len() == 83_665, "{} words", words.len());
        let slot_ids: Vec<u32> = EXTRA_SLOTS
            .iter()
            .map(|slot| {
                words
                    .iter()
                    .find(|w| w.location() == slot.to_string())
                    .map(|w| w.id)
                    .context("slot word")
            })
            .collect::<anyhow::Result<_>>()?;
        let qul_ids = words
            .iter()
            .map(|w| w.id + u32::try_from(slot_ids.iter().filter(|s| **s <= w.id).count()).unwrap())
            .collect();
        Ok(Some(Self {
            _dir: dir,
            db,
            tanzil,
            words,
            qul_ids,
        }))
    }

    fn qul_id(&self, canonical: u32) -> u32 {
        self.qul_ids[usize::try_from(canonical - 1).unwrap()]
    }

    /// `"s:a"` of an ayah id.
    fn ayah_keys(&self) -> anyhow::Result<BTreeMap<u32, String>> {
        let mut stmt = self.db.prepare("SELECT id, surah, ayah FROM ayah")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, u32>(0)?,
                    format!("{}:{}", r.get::<_, u32>(1)?, r.get::<_, u32>(2)?),
                ))
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }
}

/// Writes the QUL-format inputs and their manifest into `dir`.
fn export(m1: &M1, dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let words = &m1.words;

    // Scripts. 61 and 312: the exporter's columns; 57: the help page's columns (no `word`), with the combined
    // exporter's 38:24:32–33 grouping; 54: the exporter's JSON, numbers as strings.
    let code_v1 = |w: &Word| -> String {
        match (w.surah, w.ayah, w.position) {
            (38, 24, 32) => {
                assert_eq!(
                    w.code_v1, "\u{FBE9}\u{FBEA}",
                    "the M1 grouping is canonical (D5)"
                );
                "\u{FBE9}".to_owned()
            }
            (38, 24, 33) => "\u{FBEA}\u{FBEB}".to_owned(),
            _ => w.code_v1.clone(),
        }
    };
    let hafs = |w: &Word| -> String {
        if w.is_end {
            w.text_hafs.trim_start_matches(END_OF_AYAH).to_owned()
        } else {
            w.text_hafs.clone()
        }
    };
    script_sqlite(
        &dir.join("script-61.sqlite"),
        true,
        words
            .iter()
            .map(|w| (m1.qul_id(w.id), w, w.code_v2.clone())),
    )?;
    script_sqlite(
        &dir.join("script-57.sqlite"),
        false,
        words.iter().map(|w| (m1.qul_id(w.id), w, code_v1(w))),
    )?;
    script_sqlite(
        &dir.join("script-312.sqlite"),
        true,
        words.iter().map(|w| (m1.qul_id(w.id), w, hafs(w))),
    )?;
    let imlaei: serde_json::Map<String, Value> = words
        .iter()
        .map(|w| {
            let text = w.text_imlaei.clone().unwrap_or_else(|| arabic_indic(w.ayah));
            (
                w.location(),
                json!({"id": m1.qul_id(w.id), "surah": w.surah.to_string(), "ayah": w.ayah.to_string(),
                       "word": w.position.to_string(), "location": w.location(), "text": text}),
            )
        })
        .collect();
    std::fs::write(dir.join("script-54.json"), serde_json::to_vec(&imlaei)?)?;

    // Layouts: V2 and V1 in QUL word_index numbering (through script 61); V4 with its own words table in another id
    // space.
    for (mushaf, file, own_ids) in [
        (1_u32, "layout-10.sqlite", false),
        (2, "layout-15.sqlite", false),
        (19, "layout-19.sqlite", true),
    ] {
        let id_of = |canonical: u32| {
            if own_ids {
                canonical * 2 + 7
            } else {
                m1.qul_id(canonical)
            }
        };
        let path = dir.join(file);
        let mut out = Connection::open(&path)?;
        let tx = out.transaction()?;
        tx.execute_batch(
            "CREATE TABLE pages (page_number INTEGER, line_number INTEGER, line_type TEXT, is_centered INTEGER,
                                 first_word_id INTEGER, last_word_id INTEGER, surah_number INTEGER);
             CREATE TABLE info (name TEXT, number_of_pages INTEGER, lines_per_page INTEGER, font_name TEXT);",
        )?;
        let (name, font): (String, String) = m1.db.query_row(
            "SELECT name, code FROM mushaf WHERE id = ?1",
            [mushaf],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.execute(
            "INSERT INTO info VALUES (?1, 604, 15, ?2)",
            params![name, font],
        )?;
        {
            let mut select = m1.db.prepare(
                "SELECT page, line, kind, centered, surah_id, first_word_id, last_word_id FROM line
                 WHERE mushaf_id = ?1 ORDER BY page, line",
            )?;
            let mut insert = tx.prepare("INSERT INTO pages VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?;
            let mut rows = select.query([mushaf])?;
            while let Some(row) = rows.next()? {
                let (page, line, kind, centered): (u32, u32, u32, u32) =
                    (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?);
                let surah: Option<u32> = row.get(4)?;
                let first: Option<u32> = row.get(5)?;
                let last: Option<u32> = row.get(6)?;
                // QUL writes '' for the columns that don't apply, and no surah on basmallah lines.
                let blank = || rusqlite::types::Value::Text(String::new());
                let int = |v: u32| rusqlite::types::Value::Integer(i64::from(v));
                let (line_type, first, last, surah) = match kind {
                    0 => (
                        "ayah",
                        int(id_of(first.unwrap())),
                        int(id_of(last.unwrap())),
                        blank(),
                    ),
                    1 => ("surah_name", blank(), blank(), int(surah.unwrap())),
                    _ => ("basmallah", blank(), blank(), blank()),
                };
                insert.execute(params![page, line, line_type, centered, first, last, surah])?;
            }
        }
        if own_ids {
            tx.execute_batch("CREATE TABLE words (word_index INTEGER, word_key TEXT, text TEXT);")?;
            let mut insert = tx.prepare("INSERT INTO words VALUES (?1, ?2, ?3)")?;
            for w in words {
                insert.execute(params![id_of(w.id), w.location(), w.code_v2])?;
            }
        }
        tx.commit()?;
    }

    // Metadata. Surah names: QUL 70's keyed JSON (`name` = the transliteration with diacritics).
    let surahs: serde_json::Map<String, Value> = {
        let mut stmt = m1.db.prepare(
            "SELECT id, name_complex, name_simple, name_ar, revelation_order, revelation_place, ayah_count, bismillah_pre
             FROM surah ORDER BY id",
        )?;
        stmt.query_map([], |r| {
            let id: u32 = r.get(0)?;
            Ok((
                id.to_string(),
                json!({"id": id, "name": r.get::<_, String>(1)?, "name_simple": r.get::<_, String>(2)?,
                       "name_arabic": r.get::<_, String>(3)?, "revelation_order": r.get::<_, u32>(4)?,
                       "revelation_place": r.get::<_, String>(5)?, "verses_count": r.get::<_, u32>(6)?,
                       "bismillah_pre": r.get::<_, bool>(7)?}),
            ))
        })?
        .collect::<Result<_, _>>()?
    };
    std::fs::write(dir.join("surah-names.json"), serde_json::to_vec(&surahs)?)?;

    // Divisions: rub (keyed JSON), juz (SQLite, verse_mapping as JSON text), hizb (JSON array), manzil (keyed JSON).
    let keys = m1.ayah_keys()?;
    let records = |table: &str, field: &str| -> anyhow::Result<Vec<Value>> {
        let mut stmt = m1.db.prepare(&format!(
            "SELECT id, first_ayah_id, last_ayah_id FROM {table} ORDER BY id"
        ))?;
        let rows: Vec<(u32, u32, u32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(id, first, last)| {
                let mut mapping: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
                for ayah in first..=last {
                    let (s, a) = keys[&ayah].split_once(':').unwrap();
                    let (s, a): (u32, u32) = (s.parse().unwrap(), a.parse().unwrap());
                    mapping.entry(s).and_modify(|r| r.1 = a).or_insert((a, a));
                }
                let mapping: serde_json::Map<String, Value> = mapping
                    .into_iter()
                    .map(|(s, (from, to))| (s.to_string(), Value::from(format!("{from}-{to}"))))
                    .collect();
                json!({field: id, "verses_count": last - first + 1, "first_verse_key": keys[&first],
                       "last_verse_key": keys[&last], "verse_mapping": mapping})
            })
            .collect())
    };
    let keyed = |values: Vec<Value>, field: &str| -> Value {
        Value::Object(
            values
                .into_iter()
                .map(|v| (v[field].to_string(), v))
                .collect(),
        )
    };
    std::fs::write(
        dir.join("rub-el-hizb.json"),
        serde_json::to_vec(&keyed(records("rub", "rub_number")?, "rub_number"))?,
    )?;
    std::fs::write(
        dir.join("hizb.json"),
        serde_json::to_vec(&Value::from(records("hizb", "hizb_number")?))?,
    )?;
    std::fs::write(
        dir.join("manzil.json"),
        serde_json::to_vec(&keyed(records("manzil", "manzil_number")?, "manzil_number"))?,
    )?;
    {
        let out = Connection::open(dir.join("juz.sqlite"))?;
        out.execute_batch(
            "CREATE TABLE juz (juz_number INTEGER PRIMARY KEY, verses_count INTEGER, first_verse_key TEXT,
                               last_verse_key TEXT, verse_mapping TEXT);",
        )?;
        for juz in records("juz", "juz_number")? {
            out.execute(
                "INSERT INTO juz VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    juz["juz_number"].as_i64(),
                    juz["verses_count"].as_i64(),
                    juz["first_verse_key"].as_str(),
                    juz["last_verse_key"].as_str(),
                    juz["verse_mapping"].to_string()
                ],
            )?;
        }
    }
    std::fs::copy(&m1.tanzil, dir.join("quran-data.xml"))?;
    write_manifest(dir)
}

/// `words` rows `(QUL id, word, text)`: the exporter's columns (`id, location, surah, ayah, word, text`) or the help
/// page's (`word_index, word_key, surah, ayah, text`).
fn script_sqlite<'a>(
    path: &Path,
    exporter_columns: bool,
    rows: impl Iterator<Item = (u32, &'a Word, String)>,
) -> anyhow::Result<()> {
    let mut out = Connection::open(path)?;
    let tx = out.transaction()?;
    if exporter_columns {
        tx.execute_batch(
            "CREATE TABLE words (id INTEGER, location TEXT, surah INTEGER, ayah INTEGER, word INTEGER, text TEXT);",
        )?;
        let mut insert = tx.prepare("INSERT INTO words VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        for (id, w, text) in rows {
            insert.execute(params![id, w.location(), w.surah, w.ayah, w.position, text])?;
        }
    } else {
        tx.execute_batch(
            "CREATE TABLE words (word_index INTEGER, word_key TEXT, surah INTEGER, ayah INTEGER, text TEXT);",
        )?;
        let mut insert = tx.prepare("INSERT INTO words VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for (id, w, text) in rows {
            insert.execute(params![id, w.location(), w.surah, w.ayah, text])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The manifest for the files in `dir`, with their real hashes (one in upper case: hex is case-insensitive).
fn write_manifest(dir: &Path) -> anyhow::Result<()> {
    let files = [
        (Input::LayoutV2, "layout-10.sqlite"),
        (Input::LayoutV1, "layout-15.sqlite"),
        (Input::LayoutV4, "layout-19.sqlite"),
        (Input::CodeV2, "script-61.sqlite"),
        (Input::CodeV1, "script-57.sqlite"),
        (Input::TextHafs, "script-312.sqlite"),
        (Input::Imlaei, "script-54.json"),
        (Input::Surahs, "surah-names.json"),
        (Input::Rub, "rub-el-hizb.json"),
        (Input::Juz, "juz.sqlite"),
        (Input::Hizb, "hizb.json"),
        (Input::Manzil, "manzil.json"),
        (Input::Tanzil, "quran-data.xml"),
    ];
    let mut text = String::from("# Synthetic QUL inputs (qul_roundtrip.rs)\n");
    for (input, file) in files {
        let mut hash = sha256(&std::fs::read(dir.join(file))?);
        if input == Input::Surahs {
            hash = hash.to_uppercase();
        }
        let resource = input
            .resource()
            .map_or_else(String::new, |r| format!("resource = {r}, "));
        writeln!(
            text,
            "{} = {{ file = \"{file}\", {resource}sha256 = \"{hash}\" }}",
            input.key()
        )?;
    }
    std::fs::write(dir.join("manifest.toml"), text)?;
    Ok(())
}

/// Every row of `sql` as `a|b|c` (NULL as `NULL`).
fn rows_of(db: &Connection, sql: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt = db.prepare(sql)?;
    let columns = stmt.column_count();
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let cells = (0..columns)
            .map(|i| {
                Ok(match row.get_ref(i)? {
                    ValueRef::Null => "NULL".to_owned(),
                    ValueRef::Integer(n) => n.to_string(),
                    ValueRef::Text(t) => String::from_utf8(t.to_vec())?,
                    other => anyhow::bail!("unexpected {other:?}"),
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        out.push(cells.join("|"));
    }
    Ok(out)
}

fn opt<T: ToString>(value: Option<T>) -> String {
    value.map_or_else(|| "NULL".to_owned(), |v| v.to_string())
}

fn same_rows(table: &str, expected: &[String], actual: &[String]) {
    if let Some((index, (e, a))) = expected
        .iter()
        .zip(actual)
        .enumerate()
        .find(|(_, (e, a))| e != a)
    {
        panic!("{table} row {index} differs:\n  M1:  {e}\n  qul: {a}");
    }
    assert_eq!(expected.len(), actual.len(), "{table} row count");
}

/// Every table `derive` produces equals the M1 database's.
fn compare(db: &Connection, data: &CoreData) -> anyhow::Result<()> {
    let surahs: Vec<String> = data
        .surahs
        .iter()
        .map(|s| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                s.id,
                s.name_ar,
                s.name_simple,
                s.name_complex,
                s.name_en,
                s.revelation_place.as_str(),
                s.revelation_order,
                s.ayah_count,
                s.first_ayah_id,
                s.rukus,
                u8::from(s.bismillah_pre),
                opt(s.header_cp)
            )
        })
        .collect();
    same_rows(
        "surah",
        &rows_of(
            db,
            "SELECT id, name_ar, name_simple, name_complex, name_en, revelation_place, revelation_order, ayah_count,
                    first_ayah_id, rukus, bismillah_pre, header_cp FROM surah ORDER BY id",
        )?,
        &surahs,
    );
    for (table, rows) in [
        ("juz", &data.juzs),
        ("hizb", &data.hizbs),
        ("rub", &data.rubs),
        ("manzil", &data.manzils),
    ] {
        let actual: Vec<String> = rows
            .iter()
            .map(|r| format!("{}|{}|{}", r.id, r.first_ayah_id, r.last_ayah_id))
            .collect();
        same_rows(
            table,
            &rows_of(
                db,
                &format!("SELECT id, first_ayah_id, last_ayah_id FROM {table} ORDER BY id"),
            )?,
            &actual,
        );
    }
    let rukus: Vec<String> = data
        .rukus
        .iter()
        .map(|r| {
            format!(
                "{}|{}|{}|{}",
                r.id, r.surah, r.first_ayah_id, r.last_ayah_id
            )
        })
        .collect();
    same_rows(
        "ruku",
        &rows_of(
            db,
            "SELECT id, surah, first_ayah_id, last_ayah_id FROM ruku ORDER BY id",
        )?,
        &rukus,
    );
    let sajdas: Vec<String> = data
        .sajdas
        .iter()
        .map(|s| format!("{}|{}|{}", s.id, s.ayah_id, s.kind.as_str()))
        .collect();
    same_rows(
        "sajda",
        &rows_of(db, "SELECT id, ayah_id, kind FROM sajda ORDER BY id")?,
        &sajdas,
    );
    let ayahs: Vec<String> = data
        .ayahs
        .iter()
        .map(|a| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                a.id,
                a.surah,
                a.ayah,
                a.juz,
                a.hizb,
                a.rub,
                a.manzil,
                a.ruku,
                a.sajda,
                a.flags,
                a.first_word_id,
                a.last_word_id,
                a.text_hafs,
                a.text_imlaei,
                a.norm_loose,
                a.norm_strict
            )
        })
        .collect();
    same_rows(
        "ayah",
        &rows_of(
            db,
            "SELECT id, surah, ayah, juz, hizb, rub, manzil, ruku, sajda, flags, first_word_id, last_word_id,
                    text_hafs, text_imlaei, norm_loose, norm_strict FROM ayah ORDER BY id",
        )?,
        &ayahs,
    );
    let words: Vec<String> = data
        .words
        .iter()
        .map(|w| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                w.id,
                w.ayah_id,
                w.surah,
                w.ayah,
                w.position,
                u8::from(w.is_end),
                w.text_hafs,
                opt(w.text_imlaei.as_deref()),
                opt(w.norm_loose.as_deref()),
                w.code_v1,
                w.code_v2
            )
        })
        .collect();
    same_rows(
        "word",
        &rows_of(
            db,
            "SELECT id, ayah_id, surah, ayah, position, is_end, text_hafs, text_imlaei, norm_loose, code_v1, code_v2
             FROM word ORDER BY id",
        )?,
        &words,
    );
    let pages: Vec<String> = data
        .pages
        .iter()
        .map(|p| {
            format!(
                "{}|{}|{}|{}|{}|{}",
                p.mushaf_id,
                p.page,
                p.first_word_id,
                p.last_word_id,
                p.first_ayah_id,
                p.last_ayah_id
            )
        })
        .collect();
    same_rows(
        "page",
        &rows_of(
            db,
            "SELECT mushaf_id, page, first_word_id, last_word_id, first_ayah_id, last_ayah_id FROM page
             ORDER BY mushaf_id, page",
        )?,
        &pages,
    );
    let lines: Vec<String> = data
        .lines
        .iter()
        .map(|l| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}",
                l.mushaf_id,
                l.page,
                l.line,
                l.kind.db_value(),
                u8::from(l.centered),
                opt(l.surah_id),
                opt(l.words.map(|w| w.0)),
                opt(l.words.map(|w| w.1))
            )
        })
        .collect();
    same_rows(
        "line",
        &rows_of(
            db,
            "SELECT mushaf_id, page, line, kind, centered, surah_id, first_word_id, last_word_id FROM line
             ORDER BY mushaf_id, page, line",
        )?,
        &lines,
    );
    Ok(())
}

#[test]
fn qul_exports_of_the_m1_database_rebuild_it_exactly() -> anyhow::Result<()> {
    let Some(m1) = M1::open()? else {
        return Ok(());
    };
    let work = tempfile::tempdir()?;
    let qul_dir = work.path().join("qul");
    let started = Instant::now();
    export(&m1, &qul_dir)?;
    eprintln!(
        "qul_roundtrip: wrote the QUL-format inputs [{:.1} s]",
        started.elapsed().as_secs_f64()
    );

    let started = Instant::now();
    let loaded = qul::read(&qul_dir)?;
    eprintln!(
        "qul_roundtrip: qul::read [{:.1} s]",
        started.elapsed().as_secs_f64()
    );
    for line in loaded.report.lines() {
        eprintln!("qul_roundtrip: {line}");
    }

    // What the adapter saw.
    let report = &loaded.report;
    assert_eq!(report.words, 83_665);
    assert_eq!(
        report.word_index_max,
        Some(83_668),
        "FACT C7: 114:6:4 = 83668"
    );
    assert_eq!(
        report.unused_word_indexes,
        [6439, 23789, 34411],
        "the slots before 3:1:1 (6440), 8:7:1 (23790) and 14:1:1 (34412)"
    );
    assert_eq!(
        report.id_disagreements,
        [(Input::CodeV1, 0), (Input::TextHafs, 0), (Input::Imlaei, 0)]
    );
    assert_eq!(
        report
            .layouts
            .iter()
            .map(|l| l.own_word_ids)
            .collect::<Vec<_>>(),
        [false, false, true]
    );
    assert_eq!(
        report
            .layouts
            .iter()
            .map(|l| (l.surah_name_lines, l.basmallah_lines))
            .collect::<Vec<_>>(),
        [(114, 112); 3]
    );
    assert_eq!(
        report.cross_checks,
        [Input::Juz, Input::Hizb, Input::Manzil]
    );
    assert!(report.inputs.iter().any(|l| l.starts_with(
        "script.code_v1 = script-57.sqlite (QUL 57 \"QPC V1 Glyphs - Word by Word\", SQLite words(word_index, word_key)"
    )));
    assert!(report.inputs.iter().any(
        |l| l.starts_with("layout.v4 = layout-19.sqlite") && l.contains("SQLite pages + words")
    ));
    assert!(
        report
            .inputs
            .iter()
            .any(|l| l.starts_with("script.imlaei = script-54.json")
                && l.contains("JSON keyed by location"))
    );

    let source = &loaded.source;
    assert_eq!(source.info.source, "qul");
    assert_eq!(source.info.manifest_sha256, report.manifest_sha256);
    assert!(
        source.info.licence_note.contains("mushaf layouts 10, 15, 19, word scripts 61, 57, 312, 54 and metadata 70, 63, 68, 67, 66")
            && source.info.licence_note.contains("CC BY 3.0"),
        "{}",
        source.info.licence_note
    );
    assert_eq!(loaded.tanzil, qul_dir.join("quran-data.xml"));

    // The shared pipeline turns it into exactly the M1 rows.
    let started = Instant::now();
    let data_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("data");
    let tanzil = Tanzil::load(&loaded.tanzil)?;
    let headers = HeaderMap::load(&data_dir.join("qcf_surah_header_cmap.json"))?;
    let exceptions = DivisionExceptions::load(&data_dir.join("division_exceptions.toml"))?;
    let data = build::derive::derive(source, &tanzil, headers.as_ref(), &exceptions)?;
    eprintln!(
        "qul_roundtrip: derive [{:.1} s]",
        started.elapsed().as_secs_f64()
    );
    assert!(
        data.report.v1_regrouped,
        "D5: the combined grouping was regrouped"
    );
    assert!(
        data.report.end_markers_relabelled.is_empty(),
        "QUL's end markers are the last word of every ayah"
    );
    for division in ["juz", "hizb", "manzil"] {
        let expected = format!(
            "{division}: Tanzil, 6236 ayahs cross-checked against the source, 0 differences"
        );
        assert!(
            data.report.division_checks.contains(&expected),
            "{expected}: {:?}",
            data.report.division_checks
        );
    }
    assert!(
        data.report
            .division_checks
            .iter()
            .any(|c| c.contains("rub: the mushaf source, 1 start(s) differ from Tanzil, all allowlisted (rub 106: 15:49 / 15:50)")),
        "{:?}",
        data.report.division_checks
    );
    compare(&m1.db, &data)?;

    // Written by the shared writer, the qul database passes every verify-core gate (the real binary: G1–G16, with
    // G9's "v1/v4 as provided" rule for source qul).
    let out = work.path().join("core.db");
    let meta = BuildMeta {
        source: source.info.source.to_owned(),
        source_manifest_sha256: source.info.manifest_sha256.clone(),
        tanzil_sha256: tanzil.sha256.clone(),
        built_at: "2026-10-10T00:00:00Z".to_owned(),
        builder: concat!("xtask ", env!("CARGO_PKG_VERSION")).to_owned(),
        licence_note: source.info.licence_note.clone(),
    };
    let stats = write::write(&out, &data, &meta)?;
    assert_eq!(stats.fts_rows, 6236);
    let written = Connection::open_with_flags(&out, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    for (table, sql) in [
        (
            "meta",
            "SELECT key, value FROM meta WHERE key IN ('source', 'source_manifest_sha256', 'licence_note') ORDER BY key",
        ),
        (
            "vocab_loose",
            "SELECT term, doc_count FROM vocab_loose ORDER BY term",
        ),
    ] {
        let rows = rows_of(&written, sql)?;
        if table == "meta" {
            assert_eq!(
                rows,
                [
                    format!("licence_note|{}", meta.licence_note),
                    "source|qul".to_owned(),
                    format!("source_manifest_sha256|{}", meta.source_manifest_sha256),
                ]
            );
        } else {
            same_rows(table, &rows_of(&m1.db, sql)?, &rows);
        }
    }
    drop(written);
    let report_path = work.path().join("verify-core.json");
    let verify = std::process::Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["verify-core", "--db"])
        .arg(&out)
        .arg("--report")
        .arg(&report_path)
        .output()?;
    let log = String::from_utf8_lossy(&verify.stderr);
    for line in log.lines() {
        eprintln!("qul_roundtrip: {line}");
    }
    assert!(
        verify.status.success(),
        "verify-core failed on the qul build:\n{log}"
    );

    // `load` (the build-core entry point) reads the same.
    let (loaded_again, tanzil_again) = qul::load(&qul_dir)?;
    assert_eq!(loaded_again.words, source.words);
    assert_eq!(tanzil_again, loaded.tanzil);

    // QUL may carry rows for its 3 extra word_index slots (FACT C7). The build must stop and name them.
    let extras: Vec<(u32, Location)> = [
        (6439, Location::new(2, 286, 51)),
        (23789, Location::new(8, 6, 13)),
        (34411, Location::new(13, 43, 17)),
    ]
    .into();
    for file in ["script-61.sqlite", "script-57.sqlite", "script-312.sqlite"] {
        let db = Connection::open(qul_dir.join(file))?;
        let exporter = file != "script-57.sqlite";
        for (id, location) in &extras {
            if exporter {
                db.execute(
                    "INSERT INTO words VALUES (?1, ?2, ?3, ?4, ?5, 'زائد')",
                    params![
                        id,
                        location.to_string(),
                        location.surah,
                        location.ayah,
                        location.word
                    ],
                )?;
            } else {
                db.execute(
                    "INSERT INTO words VALUES (?1, ?2, ?3, ?4, 'زائد')",
                    params![id, location.to_string(), location.surah, location.ayah],
                )?;
            }
        }
    }
    let path = qul_dir.join("script-54.json");
    let mut imlaei: serde_json::Map<String, Value> =
        serde_json::from_slice(&std::fs::read(&path)?)?;
    for (id, location) in &extras {
        imlaei.insert(
            location.to_string(),
            json!({"id": id, "location": location.to_string(), "text": "زائد"}),
        );
    }
    std::fs::write(&path, serde_json::to_vec(&imlaei)?)?;
    write_manifest(&qul_dir)?;
    let message = match qul::read(&qul_dir) {
        Ok(_) => panic!("83,668 word rows must stop the build"),
        Err(e) => format!("{e:#}"),
    };
    for needle in [
        "the word scripts have 83668 word locations, expected exactly 83665",
        "FACT C7",
        "locations after their ayah's end marker (script.text_hafs): 2:286:51, 8:6:13, 13:43:17",
    ] {
        assert!(message.contains(needle), "{needle}\n{message}");
    }
    Ok(())
}
