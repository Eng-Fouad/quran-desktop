//! End to end: `cargo xtask build-core --source qdc --offline` on the real raw-response cache (`data/cache/`, WP3a).
//!
//! Two builds run in parallel with the same `SOURCE_DATE_EPOCH` and must be byte-identical; the database is then
//! checked against the invariants of docs/ARCHITECTURE.md §3.1 and §4.4 (an independent re-statement of the G1–G16
//! properties `build-core` is meant to produce; `verify-core` itself is WP3b's), plus the source facts this package
//! documents in docs/deviations/WP3a.md.
//!
//! The cache is gitignored QF content (never in CI): when it is absent or older than 7 days the test reports that it
//! was skipped and passes. Refresh it with `pnpm core:qdc`.

#![allow(dead_code)]

// The modules' directory: a `#[path]` on each would resolve through `tests/build/`, which does not exist (only
// Windows normalises `..` before opening the file).
#[path = "../src/build"]
mod build {
    pub mod derive;
    pub mod model;
    pub mod tanzil;
}

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, anyhow, bail, ensure};
use quran_core::{Level, normalize_ar};
use rusqlite::{Connection, OpenFlags, params};
use sha2::{Digest, Sha256};

use build::derive::{V2_CENTRED_LINES, arabic_indic};
use build::tanzil::Tanzil;

/// 2026-10-10T00:00:00Z.
const EPOCH: &str = "1791590400";

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from(".."), Path::to_path_buf)
}

fn build_core(cache: &Path, out: &Path) -> std::io::Result<std::process::Child> {
    Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["build-core", "--source", "qdc", "--offline", "--cache"])
        .arg(cache)
        .arg("--out")
        .arg(out)
        .env("SOURCE_DATE_EPOCH", EPOCH)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn the_qdc_build_is_deterministic_and_sound() -> anyhow::Result<()> {
    let cache = workspace_root().join("data").join("cache");
    let dir = tempfile::tempdir()?;
    let (a, b) = (
        dir.path().join("a").join("core.db"),
        dir.path().join("b").join("core.db"),
    );
    let (first, second) = (build_core(&cache, &a)?, build_core(&cache, &b)?);
    let (first, second) = (first.wait_with_output()?, second.wait_with_output()?);
    if !first.status.success() {
        let log = stderr(&first);
        if log.contains("--offline:") && log.contains("need fetching") {
            eprintln!(
                "SKIPPED: the QDC cache under {} is incomplete or stale: {log}",
                cache.display()
            );
            return Ok(());
        }
        bail!("build-core failed:\n{log}");
    }
    ensure!(
        second.status.success(),
        "the second build failed:\n{}",
        stderr(&second)
    );

    let log = stderr(&first);
    for expected in [
        "relabelled: 2:181:14",
        "rub 106: 15:49 / 15:50",
        "juz: Tanzil, 6236 ayahs cross-checked against the source, 0 differences",
        "page starts equal Tanzil's on 604/604 pages",
    ] {
        ensure!(
            log.contains(expected),
            "the build log lacks {expected:?}:\n{log}"
        );
    }

    let (bytes_a, bytes_b) = (std::fs::read(&a)?, std::fs::read(&b)?);
    ensure!(
        Sha256::digest(&bytes_a) == Sha256::digest(&bytes_b),
        "two builds with SOURCE_DATE_EPOCH={EPOCH} differ"
    );
    ensure!(
        !a.with_extension("db.tmp").exists(),
        "<out>.tmp is renamed away"
    );
    ensure!(
        bytes_a.len() < 16 * 1024 * 1024,
        "G14: {} bytes ≥ 16 MB",
        bytes_a.len()
    );

    let tanzil = Tanzil::load(&cache.join("tanzil").join("quran-data.xml"))?;
    let db = Db::open(&a)?;
    check_meta(&db, &tanzil)?;
    check_text(&db)?;
    check_layouts(&db, &tanzil)?;
    check_divisions(&db, &tanzil)?;
    check_search(&db)?;
    check_sqlite(&db)?;
    Ok(())
}

struct Db(Connection);

impl Db {
    fn open(path: &Path) -> anyhow::Result<Self> {
        Ok(Self(Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?))
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str) -> anyhow::Result<T> {
        self.0
            .query_row(sql, [], |r| r.get(0))
            .with_context(|| sql.to_owned())
    }

    fn zero(&self, what: &str, sql: &str) -> anyhow::Result<()> {
        let n: i64 = self.one(sql)?;
        ensure!(n == 0, "{what}: {n} violation(s)");
        Ok(())
    }

    fn column<T: rusqlite::types::FromSql>(&self, sql: &str) -> anyhow::Result<Vec<T>> {
        let mut stmt = self.0.prepare(sql)?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<T>>>()?;
        Ok(rows)
    }

    fn fts(&self, expr: &str) -> anyhow::Result<Vec<u32>> {
        let mut stmt = self
            .0
            .prepare("SELECT rowid FROM ayah_fts WHERE ayah_fts MATCH ?1 ORDER BY rowid")?;
        let rows = stmt
            .query_map(params![expr], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<u32>>>()?;
        Ok(rows)
    }

    fn ayah_id(&self, surah: u32, ayah: u32) -> anyhow::Result<u32> {
        Ok(self.0.query_row(
            "SELECT id FROM ayah WHERE surah = ?1 AND ayah = ?2",
            params![surah, ayah],
            |r| r.get(0),
        )?)
    }
}

fn check_meta(db: &Db, tanzil: &Tanzil) -> anyhow::Result<()> {
    let meta: BTreeMap<String, String> =
        db.0.prepare("SELECT key, value FROM meta")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
    let get = |key: &str| {
        meta.get(key)
            .map(String::as_str)
            .ok_or_else(|| anyhow!("meta.{key} is missing"))
    };
    ensure!(
        meta.len() == 10,
        "meta keys: {:?}",
        meta.keys().collect::<Vec<_>>()
    );
    ensure!(get("schema_version")? == quran_core::CORE_SCHEMA_VERSION.to_string());
    ensure!(
        get("normalizer_version")? == quran_core::NORMALIZER_VERSION.to_string(),
        "G13"
    );
    ensure!(get("source")? == "qdc");
    ensure!(
        get("built_at")? == "2026-10-10T00:00:00Z",
        "built_at = SOURCE_DATE_EPOCH"
    );
    ensure!(get("builder")? == concat!("xtask ", env!("CARGO_PKG_VERSION")));
    ensure!(get("ayah_count")? == "6236" && get("word_count")? == "83665");
    ensure!(get("tanzil_sha256")? == tanzil.sha256);
    ensure!(get("source_manifest_sha256")?.len() == 64);
    ensure!(
        get("licence_note")?.contains("NEVER DISTRIBUTE")
            && get("licence_note")?.contains("CC BY 3.0")
    );
    Ok(())
}

fn check_text(db: &Db) -> anyhow::Result<()> {
    // G1
    ensure!(db.one::<u32>("SELECT count(*) FROM surah")? == 114);
    ensure!(db.one::<u32>("SELECT count(*) FROM ayah")? == 6236);
    ensure!(db.one::<u32>("SELECT count(*) FROM word")? == 83_665);
    ensure!(db.one::<u32>("SELECT sum(is_end) FROM word")? == 6236);
    db.zero(
        "G1 per-surah ayah counts",
        "SELECT count(*) FROM surah s WHERE s.ayah_count != (SELECT count(*) FROM ayah a WHERE a.surah = s.id)",
    )?;
    // G2, G3
    db.zero(
        "G2 canonical word order",
        "SELECT count(*) FROM word w JOIN word p ON p.id = w.id - 1
         WHERE (w.surah, w.ayah, w.position) <= (p.surah, p.ayah, p.position)",
    )?;
    db.zero(
        "G2 positions 1..n",
        "SELECT count(*) FROM word w JOIN ayah a ON a.id = w.ayah_id
         WHERE w.position != w.id - a.first_word_id + 1 OR w.surah != a.surah OR w.ayah != a.ayah
            OR w.id NOT BETWEEN a.first_word_id AND a.last_word_id",
    )?;
    db.zero(
        "G2 one end marker per ayah, last",
        "SELECT count(*) FROM ayah a
         WHERE (SELECT sum(is_end) FROM word WHERE id BETWEEN a.first_word_id AND a.last_word_id) != 1
            OR (SELECT is_end FROM word WHERE id = a.last_word_id) != 1",
    )?;
    db.zero(
        "G3 contiguous ayahs",
        "SELECT count(*) FROM ayah a JOIN ayah p ON p.id = a.id - 1
         WHERE a.first_word_id != p.last_word_id + 1 OR (a.surah, a.ayah) <= (p.surah, p.ayah)",
    )?;
    db.zero(
        "G3 surah.first_ayah_id",
        "SELECT count(*) FROM surah s WHERE s.first_ayah_id != (SELECT min(id) FROM ayah WHERE surah = s.id)",
    )?;
    // G4 and D5
    db.zero(
        "G4 glyph code lengths",
        "SELECT count(*) FROM word WHERE length(code_v1) NOT BETWEEN 1 AND 4 OR length(code_v2) NOT BETWEEN 1 AND 4",
    )?;
    ensure!(
        db.one::<u32>("SELECT count(*) FROM word WHERE length(code_v1) > 1")? == 4580,
        "FACT C5 V1"
    );
    ensure!(
        db.one::<u32>("SELECT count(*) FROM word WHERE length(code_v2) > 1")? == 4517,
        "FACT C5 V2"
    );
    let d5: Vec<String> =
        db.column("SELECT code_v1 FROM word WHERE surah = 38 AND ayah = 24 AND position IN (32, 33) ORDER BY id")?;
    ensure!(d5 == ["\u{FBE9}\u{FBEA}", "\u{FBEB}"], "D5: {d5:?}");
    // G5: end markers are U+06DD + the ayah number; U+06DD appears nowhere else; no empty text.
    let ends: Vec<(u32, String)> =
        db.0.prepare("SELECT ayah, text_hafs FROM word WHERE is_end = 1")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
    for (ayah, text) in &ends {
        ensure!(
            *text == format!("\u{06DD}{}", arabic_indic(*ayah)),
            "G5 end marker {text:?} for ayah {ayah}"
        );
    }
    db.zero(
        "G5 U+06DD inside a word",
        "SELECT count(*) FROM word WHERE is_end = 0 AND (instr(text_hafs, char(1757)) > 0 OR text_hafs = '')",
    )?;
    db.zero(
        "markers have no Imla'i text",
        "SELECT count(*) FROM word WHERE is_end = 1 AND (text_imlaei IS NOT NULL OR norm_loose IS NOT NULL)",
    )?;
    ensure!(
        db.one::<i64>("SELECT is_end FROM word WHERE surah = 2 AND ayah = 181 AND position = 14")?
            == 1,
        "2:181:14 is the end marker of 2:181"
    );
    // G5b as found in the QDC text (docs/deviations/WP3a.md): ۩ preceded by a space in exactly these 9 words.
    let sajda_spaces: Vec<String> = db.column(
        "SELECT surah || ':' || ayah || ':' || position FROM word
         WHERE instr(text_hafs, ' ' || char(1769)) > 0 ORDER BY id",
    )?;
    ensure!(
        sajda_spaces
            == [
                "17:109:5", "19:58:29", "22:18:37", "22:77:11", "25:60:13", "32:15:15", "38:24:32",
                "41:38:12", "84:21:6"
            ],
        "G5b: {sajda_spaces:?}"
    );
    // G13: every normalised column is normalize_ar of its Imla'i text.
    let ayahs: Vec<(String, String, String)> =
        db.0.prepare("SELECT text_imlaei, norm_loose, norm_strict FROM ayah")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
    for (imlaei, loose, strict) in &ayahs {
        ensure!(
            *loose == normalize_ar(imlaei, Level::Loose),
            "G13 ayah {imlaei}"
        );
        ensure!(
            *strict == normalize_ar(imlaei, Level::Strict),
            "G13 ayah {imlaei}"
        );
        ensure!(
            !loose.chars().any(quran_core::normalize::is_stripped),
            "G13 stripped char in {loose}"
        );
    }
    let words: Vec<(String, String)> =
        db.0.prepare("SELECT text_imlaei, norm_loose FROM word WHERE is_end = 0")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
    for (imlaei, loose) in &words {
        ensure!(
            *loose == normalize_ar(imlaei, Level::Loose) && !loose.is_empty(),
            "word {imlaei}"
        );
    }
    // G16
    ensure!(db.one::<u32>("SELECT count(header_cp) FROM surah")? == 114);
    ensure!(db.one::<u32>("SELECT header_cp FROM surah WHERE id = 1")? == 0xFC45);
    ensure!(db.one::<u32>("SELECT header_cp FROM surah WHERE id = 114")? == 0xFBEB);
    db.zero(
        "bismillah_pre",
        "SELECT count(*) FROM surah WHERE bismillah_pre != (id NOT IN (1, 9))",
    )?;
    ensure!(
        db.one::<String>("SELECT name_en FROM surah WHERE id = 1")? == "The Opening",
        "name_en from Tanzil"
    );
    Ok(())
}

/// One line row.
#[derive(Clone, Copy, Debug)]
struct Line {
    page: u32,
    line: u32,
    kind: u32,
    centered: bool,
    surah: Option<u32>,
    first: Option<u32>,
    last: Option<u32>,
}

fn lines_of(db: &Db, mushaf: u32) -> anyhow::Result<Vec<Line>> {
    let rows =
        db.0.prepare(
            "SELECT page, line, kind, centered, surah_id, first_word_id, last_word_id FROM line
             WHERE mushaf_id = ?1 ORDER BY page, line",
        )?
        .query_map(params![mushaf], |r| {
            Ok(Line {
                page: r.get(0)?,
                line: r.get(1)?,
                kind: r.get(2)?,
                centered: r.get(3)?,
                surah: r.get(4)?,
                first: r.get(5)?,
                last: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn check_layouts(db: &Db, tanzil: &Tanzil) -> anyhow::Result<()> {
    let surah_starts: Vec<u32> =
        db.column("SELECT first_word_id FROM ayah WHERE ayah = 1 ORDER BY surah")?;
    let mut page_starts = BTreeMap::new();
    for mushaf in [1_u32, 2, 19] {
        let lines = lines_of(db, mushaf)?;
        // G6: 604 pages; pages 1–2 lines 1..8, the rest 1..15.
        let mut by_page: BTreeMap<u32, Vec<Line>> = BTreeMap::new();
        for l in &lines {
            by_page.entry(l.page).or_default().push(*l);
        }
        ensure!(
            by_page.len() == 604,
            "G6 mushaf {mushaf}: {} pages",
            by_page.len()
        );
        for (page, page_lines) in &by_page {
            let expected = if *page <= 2 { 8 } else { 15 };
            ensure!(
                page_lines.iter().map(|l| l.line).eq(1..=expected),
                "G6 mushaf {mushaf} page {page}"
            );
        }
        // G7: kind-0 lines cover 1..=83,665 contiguously; page rows agree.
        let mut next = 1;
        for l in lines.iter().filter(|l| l.kind == 0) {
            let (Some(first), Some(last)) = (l.first, l.last) else {
                bail!("G7 mushaf {mushaf} {}:{} has no words", l.page, l.line);
            };
            ensure!(
                first == next && last >= first,
                "G7 mushaf {mushaf} {}:{}",
                l.page,
                l.line
            );
            next = last + 1;
        }
        ensure!(next == 83_666, "G7 mushaf {mushaf} ends at {}", next - 1);
        db.zero(
            "G7 page rows",
            &format!(
                "SELECT count(*) FROM page p WHERE p.mushaf_id = {mushaf} AND (
                   p.first_word_id != (SELECT min(first_word_id) FROM line WHERE mushaf_id = {mushaf} AND page = p.page)
                OR p.last_word_id != (SELECT max(last_word_id) FROM line WHERE mushaf_id = {mushaf} AND page = p.page)
                OR p.first_ayah_id != (SELECT ayah_id FROM word WHERE id = p.first_word_id)
                OR p.last_ayah_id != (SELECT ayah_id FROM word WHERE id = p.last_word_id))"
            ),
        )?;
        // G8 (in reading order, docs/deviations/WP3a.md): the line before each surah's first ayah line is its
        // basmallah (surah_name for 1 and 9) on the same page; the one before that its surah_name.
        ensure!(
            lines.iter().filter(|l| l.kind == 1).count() == 114,
            "G8 surah_name lines"
        );
        ensure!(
            lines.iter().filter(|l| l.kind == 2).count() == 112,
            "G8 basmallah lines"
        );
        for (surah, start) in (1_u32..).zip(&surah_starts) {
            let at = lines
                .iter()
                .position(|l| l.kind == 0 && l.first == Some(*start))
                .ok_or_else(|| {
                    anyhow!("G8 mushaf {mushaf}: surah {surah} does not start a line")
                })?;
            let above = |n: usize| at.checked_sub(n).and_then(|i| lines.get(i));
            let first_line = lines.get(at).ok_or_else(|| anyhow!("line {at}"))?;
            let kinds: &[u32] = if matches!(surah, 1 | 9) {
                &[1]
            } else {
                &[2, 1]
            };
            for (n, kind) in (1..).zip(kinds) {
                let line = above(n)
                    .ok_or_else(|| anyhow!("G8 mushaf {mushaf} surah {surah}: nothing above"))?;
                ensure!(
                    line.kind == *kind && line.surah == Some(surah) && line.centered,
                    "G8 mushaf {mushaf} surah {surah}: {line:?}"
                );
                ensure!(
                    n > 1 || line.page == first_line.page,
                    "G8 mushaf {mushaf} surah {surah}: the line above the first ayah line is on another page"
                );
            }
        }
        // G9 (pages 1–2 and header lines always centred).
        ensure!(
            lines
                .iter()
                .filter(|l| l.page <= 2 || l.kind != 0)
                .all(|l| l.centered),
            "G9 mushaf {mushaf}"
        );
        if mushaf == 1 {
            let centred: BTreeSet<(u32, u32)> = lines
                .iter()
                .filter(|l| l.kind == 0 && l.page > 2 && l.centered)
                .map(|l| (l.page, l.line))
                .collect();
            let expected: BTreeSet<(u32, u32)> = V2_CENTRED_LINES
                .iter()
                .flat_map(|(page, lines)| lines.iter().map(move |line| (*page, *line)))
                .collect();
            ensure!(centred == expected, "G9 v2 centred lines: {centred:?}");
        }
        // G10: every page starts an ayah.
        db.zero(
            "G10 page starts",
            &format!(
                "SELECT count(*) FROM page p JOIN word w ON w.id = p.first_word_id
                 WHERE p.mushaf_id = {mushaf} AND w.position != 1"
            ),
        )?;
        let starts: Vec<u32> = db.column(&format!(
            "SELECT first_word_id FROM page WHERE mushaf_id = {mushaf} ORDER BY page"
        ))?;
        page_starts.insert(mushaf, starts);
    }
    // G10: V1 = Tanzil; V2 differs from V1 on exactly the 25 known pages; V4 = V2.
    let v1_ayahs: Vec<u32> =
        db.column("SELECT first_ayah_id FROM page WHERE mushaf_id = 2 ORDER BY page")?;
    let tanzil_ayahs = tanzil
        .page_starts
        .iter()
        .map(|k| tanzil.ayah_id(*k))
        .collect::<anyhow::Result<Vec<_>>>()?;
    ensure!(v1_ayahs == tanzil_ayahs, "G10 V1 page starts == Tanzil");
    let (v2, v1, v4) = (
        page_starts.get(&1).cloned().unwrap_or_default(),
        page_starts.get(&2).cloned().unwrap_or_default(),
        page_starts.get(&19).cloned().unwrap_or_default(),
    );
    let differing: Vec<u32> = (1..=604)
        .zip(v2.iter().zip(&v1))
        .filter(|(_, (a, b))| a != b)
        .map(|(p, _)| p)
        .collect();
    let mut expected = vec![
        121, 122, 123, 145, 532, 533, 534, 565, 568, 570, 576, 584, 586, 588, 589, 590,
    ];
    expected.extend(592..=600);
    ensure!(
        differing == expected,
        "G10 V1/V2 differing pages: {differing:?}"
    );
    ensure!(v4 == v2, "G10 V4 page starts == V2");

    // D4 and the An-Nisa shape.
    let p1: Vec<(u32, u32)> = lines_of(db, 1)?
        .iter()
        .filter(|l| l.page <= 2)
        .map(|l| (l.page * 100 + l.line, l.kind))
        .collect();
    ensure!(
        p1 == [
            (101, 1),
            (102, 0),
            (103, 0),
            (104, 0),
            (105, 0),
            (106, 0),
            (107, 0),
            (108, 0),
            (201, 1),
            (202, 2),
            (203, 0),
            (204, 0),
            (205, 0),
            (206, 0),
            (207, 0),
            (208, 0)
        ],
        "D4 pages 1–2: {p1:?}"
    );
    let nisa: Vec<(u32, u32, u32, Option<u32>)> = lines_of(db, 1)?
        .iter()
        .filter(|l| (l.page == 76 && l.line == 15) || (l.page == 77 && l.line <= 2))
        .map(|l| (l.page, l.line, l.kind, l.surah))
        .collect();
    ensure!(
        nisa == [(76, 15, 1, Some(4)), (77, 1, 2, Some(4)), (77, 2, 0, None)],
        "An-Nisa header: {nisa:?}"
    );
    let mushafs: Vec<String> = db.column(
        "SELECT id || code || pages || lines_per_page || glyph_column FROM mushaf ORDER BY id",
    )?;
    ensure!(
        mushafs == ["1v260415code_v2", "2v160415code_v1", "19v460415code_v2"],
        "{mushafs:?}"
    );
    Ok(())
}

fn check_divisions(db: &Db, tanzil: &Tanzil) -> anyhow::Result<()> {
    // G11 counts.
    for (table, count) in [
        ("juz", 30),
        ("hizb", 60),
        ("rub", 240),
        ("manzil", 7),
        ("ruku", 556),
        ("sajda", 15),
    ] {
        ensure!(
            db.one::<u32>(&format!("SELECT count(*) FROM {table}"))? == count,
            "G11 {table}"
        );
        if table != "sajda" {
            db.zero(
                &format!("{table} ranges"),
                &format!(
                    "SELECT count(*) FROM {table} t JOIN {table} p ON p.id = t.id - 1
                     WHERE t.first_ayah_id != p.last_ayah_id + 1 OR t.last_ayah_id < t.first_ayah_id"
                ),
            )?;
            db.zero(
                &format!("ayah.{table}"),
                &format!(
                    "SELECT count(*) FROM ayah a JOIN {table} t ON a.id BETWEEN t.first_ayah_id AND t.last_ayah_id
                     WHERE a.{table} != t.id"
                ),
            )?;
        }
    }
    let obligatory: Vec<String> = db.column(
        "SELECT a.surah || ':' || a.ayah FROM sajda s JOIN ayah a ON a.id = s.ayah_id WHERE s.kind = 'obligatory'
         ORDER BY a.id",
    )?;
    ensure!(
        obligatory == ["32:15", "41:38", "53:62", "96:19"],
        "G11 obligatory sajdas: {obligatory:?}"
    );
    db.zero(
        "ayah.sajda",
        "SELECT count(*) FROM ayah a LEFT JOIN sajda s ON s.ayah_id = a.id
         WHERE a.sajda != CASE s.kind WHEN 'recommended' THEN 1 WHEN 'obligatory' THEN 2 ELSE 0 END",
    )?;
    // G11 boundaries == Tanzil, except the allowlisted rub 106 (15:49 in the source, 15:50 in Tanzil).
    for (table, starts) in [
        ("juz", tanzil.juz_starts.clone()),
        ("hizb", tanzil.hizb_starts()),
        ("manzil", tanzil.manzil_starts.clone()),
        ("ruku", tanzil.ruku_starts.clone()),
        ("rub", tanzil.quarter_starts.clone()),
    ] {
        let ours: Vec<u32> =
            db.column(&format!("SELECT first_ayah_id FROM {table} ORDER BY id"))?;
        let theirs = starts
            .iter()
            .map(|k| tanzil.ayah_id(*k))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let differences: Vec<(u32, u32, u32)> = (1..)
            .zip(ours.iter().zip(&theirs))
            .filter(|(_, (a, b))| a != b)
            .map(|(id, (a, b))| (id, *a, *b))
            .collect();
        let expected = if table == "rub" {
            vec![(106, db.ayah_id(15, 49)?, db.ayah_id(15, 50)?)]
        } else {
            Vec::new()
        };
        ensure!(differences == expected, "G11 {table}: {differences:?}");
    }
    // G11b: the ayahs with a ۩ word are exactly the sajda table, one such word each.
    let glyph: Vec<u32> = db.column(
        "SELECT ayah_id FROM word WHERE instr(text_hafs, char(1769)) > 0 GROUP BY ayah_id HAVING count(*) = 1
         ORDER BY ayah_id",
    )?;
    let table: Vec<u32> = db.column("SELECT ayah_id FROM sajda ORDER BY ayah_id")?;
    ensure!(glyph == table, "G11b: {glyph:?} vs {table:?}");
    // The inline ۞ (kept as printed, docs/deviations/WP3a.md): exactly the rub starts that are not ayah 1.
    let inline: Vec<u32> = db.column(
        "SELECT ayah_id FROM word WHERE instr(text_hafs, char(1758)) > 0 ORDER BY ayah_id",
    )?;
    let rub_starts: Vec<u32> =
        db.column("SELECT id FROM ayah WHERE flags & 1 AND ayah != 1 ORDER BY id")?;
    ensure!(
        inline.len() == 199 && inline == rub_starts,
        "inline ۞: {} words",
        inline.len()
    );
    // §3.1.2 flags.
    let flags = |s, a| -> anyhow::Result<u32> {
        Ok(db.0.query_row(
            "SELECT flags FROM ayah WHERE surah = ?1 AND ayah = ?2",
            params![s, a],
            |r| r.get(0),
        )?)
    };
    ensure!(
        flags(1, 1)? == 0b1111,
        "1:1 starts a rub, hizb, juz and surah"
    );
    ensure!(flags(2, 1)? == 0b1000, "2:1 only starts a surah");
    ensure!(flags(2, 26)? == 0b0001, "2:26 starts rub 2");
    ensure!(flags(2, 142)? == 0b0111, "2:142 starts juz 2 / hizb 3");
    ensure!(
        flags(15, 49)? & 1 == 1 && flags(15, 50)? & 1 == 0,
        "rub 106 (۞) at 15:49 (D6)"
    );
    db.zero(
        "flag bits 0/2/3",
        "SELECT count(*) FROM ayah a LEFT JOIN ayah p ON p.id = a.id - 1
         WHERE (a.flags & 1 != 0) != (p.id IS NULL OR p.rub != a.rub)
            OR (a.flags & 2 != 0) != ((p.id IS NULL OR p.rub != a.rub) AND (a.rub - 1) % 4 = 0)
            OR (a.flags & 4 != 0) != (p.id IS NULL OR p.juz != a.juz)
            OR (a.flags & 8 != 0) != (a.ayah = 1)",
    )?;
    Ok(())
}

fn check_search(db: &Db) -> anyhow::Result<()> {
    let contains = |expr: &str, ayahs: &[(u32, u32)]| -> anyhow::Result<()> {
        let hits = db.fts(expr)?;
        for (s, a) in ayahs {
            ensure!(
                hits.contains(&db.ayah_id(*s, *a)?),
                "G12 {expr} lacks {s}:{a}"
            );
        }
        Ok(())
    };
    ensure!(
        db.one::<u32>("SELECT count(*) FROM ayah_fts_docsize")? == 6236,
        "G12 FTS rows"
    );
    contains("loose : (\"الرحمن\")", &[(1, 1), (1, 3)])?;
    contains("loose : (\"العالمين\")", &[(1, 2)])?;
    contains("loose : (\"الصلاه\")", &[(2, 3)])?;
    contains("strict : (\"الصلاة\")", &[(2, 3)])?;
    ensure!(!db.fts("loose : (\"الرح\"*)")?.is_empty(), "G12 prefix");
    // The everyday spellings the diacritised Imla'i seed makes searchable (docs/deviations/WP3a.md).
    contains("loose : (\"ذلك\" \"الكتاب\")", &[(2, 2)])?;
    contains("strict : (\"يؤمنون\")", &[(2, 3)])?;
    contains("loose : (\"اوليك\")", &[(2, 5)])?;
    contains("loose : (\"هذا\")", &[(2, 25)])?;
    contains("loose : (\"يا ايها\")", &[(2, 21)])?;
    let vocab: u32 = db.one("SELECT count(*) FROM vocab_loose")?;
    ensure!(
        (14_000..=15_500).contains(&vocab),
        "G12 vocab_loose has {vocab} terms"
    );
    Ok(())
}

fn check_sqlite(db: &Db) -> anyhow::Result<()> {
    ensure!(
        db.one::<String>("PRAGMA integrity_check")? == "ok",
        "G14 integrity"
    );
    ensure!(
        db.one::<String>("PRAGMA journal_mode")? == "delete",
        "G14 journal mode"
    );
    ensure!(db.one::<u32>("PRAGMA page_size")? == 4096);
    ensure!(
        db.column::<String>("PRAGMA foreign_key_check")?.is_empty(),
        "G14 foreign keys"
    );
    // G15: the §3.1.4 page query plan.
    let plan: Vec<String> = db
        .0
        .prepare(
            "EXPLAIN QUERY PLAN
             SELECT l.line, l.kind, l.centered, l.surah_id,
                    w.id, w.ayah_id, w.surah, w.ayah, w.position, w.is_end,
                    CASE ?3 WHEN 1 THEN w.code_v1 WHEN 2 THEN w.code_v2 ELSE w.text_hafs END AS glyph,
                    w.text_hafs, a.juz, a.hizb, a.rub, a.sajda, a.flags
             FROM line AS l
             LEFT JOIN word AS w ON l.kind = 0 AND w.id BETWEEN l.first_word_id AND l.last_word_id
             LEFT JOIN ayah AS a ON a.id = w.ayah_id
             WHERE l.mushaf_id = ?1 AND l.page = ?2
             ORDER BY l.line, w.id",
        )?
        .query_map(params![1, 262, 2], |r| r.get(3))?
        .collect::<rusqlite::Result<_>>()?;
    // SQLite 3.53 appends " LEFT-JOIN" to the detail of the two outer-joined tables.
    for expected in [
        "SEARCH l USING PRIMARY KEY (mushaf_id=? AND page=?)",
        "SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)",
        "SEARCH a USING INTEGER PRIMARY KEY (rowid=?)",
    ] {
        ensure!(
            plan.iter().any(|p| p.starts_with(expected)),
            "G15 plan lacks {expected:?}: {plan:?}"
        );
    }
    ensure!(
        plan.len() == 3,
        "G15: no other step (no temp B-tree for ORDER BY): {plan:?}"
    );
    Ok(())
}
