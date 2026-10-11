//! Deterministic core.db writer: `quran_core::CORE_SQL`, rows in id order, the §3.1.1 finalisation (FTS optimize,
//! `vocab_loose`, `ANALYZE`, `journal_mode = DELETE`, `VACUUM`, `integrity_check`), `built_at` from
//! `SOURCE_DATE_EPOCH` (docs/ARCHITECTURE.md §4.1, §3.1.1). Owner: WP3a.
//!
//! Determinism: the same [`CoreData`] and [`BuildMeta`] always give a byte-identical file. Every table is filled in one
//! transaction, in primary-key order, by the bundled SQLite (same version for every build of a lockfile); nothing
//! depends on hash-map order, the clock (unless `built_at` does) or the file name; `VACUUM` rewrites the file compactly
//! at the end. The page size is the schema's (`PRAGMA page_size = 4096`).

use std::path::Path;

use anyhow::{Context, bail, ensure};
use rusqlite::{Connection, params};

use super::derive::CoreData;
use super::model::mushaf_spec;

/// The `meta` rows besides the counts (§3.1.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildMeta {
    /// `qdc` | `qul`.
    pub source: String,
    pub source_manifest_sha256: String,
    pub tanzil_sha256: String,
    /// RFC 3339 UTC (`2026-10-10T00:00:00Z`).
    pub built_at: String,
    /// `xtask <version>`.
    pub builder: String,
    pub licence_note: String,
}

/// What [`write`] produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteStats {
    pub fts_rows: u32,
    pub vocab_terms: u32,
    pub bytes: u64,
}

/// Writes a complete core.db to `path`, which must not exist yet.
pub fn write(path: &Path, data: &CoreData, meta: &BuildMeta) -> anyhow::Result<WriteStats> {
    ensure!(!path.exists(), "{} already exists", path.display());
    let mut conn = Connection::open(path).with_context(|| format!("create {}", path.display()))?;
    // Build-time settings only: no rollback journal while filling a scratch file; the finalisation sets DELETE.
    conn.execute_batch("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")
        .context("build pragmas")?;
    conn.execute_batch(quran_core::CORE_SQL)
        .context("apply core.sql")?;
    let tx = conn.transaction()?;
    insert_rows(&tx, data, meta)?;
    tx.commit().context("commit the rows")?;
    let (fts_rows, vocab_terms) = finalise(&conn)?;
    conn.close().map_err(|(_, e)| e).context("close core.db")?;
    let bytes = std::fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .len();
    Ok(WriteStats {
        fts_rows,
        vocab_terms,
        bytes,
    })
}

fn insert_rows(
    tx: &rusqlite::Transaction<'_>,
    data: &CoreData,
    meta: &BuildMeta,
) -> anyhow::Result<()> {
    let ayah_count = data.ayahs.len().to_string();
    let word_count = data.words.len().to_string();
    let schema_version = quran_core::CORE_SCHEMA_VERSION.to_string();
    let normalizer_version = quran_core::NORMALIZER_VERSION.to_string();
    let mut rows: Vec<(&str, &str)> = vec![
        ("schema_version", &schema_version),
        ("normalizer_version", &normalizer_version),
        ("source", &meta.source),
        ("source_manifest_sha256", &meta.source_manifest_sha256),
        ("tanzil_sha256", &meta.tanzil_sha256),
        ("built_at", &meta.built_at),
        ("builder", &meta.builder),
        ("ayah_count", &ayah_count),
        ("word_count", &word_count),
        ("licence_note", &meta.licence_note),
    ];
    rows.sort_unstable();
    {
        let mut stmt = tx.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)")?;
        for (key, value) in rows {
            stmt.execute(params![key, value])
                .with_context(|| format!("meta {key}"))?;
        }
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO mushaf (id, code, name, pages, lines_per_page, glyph_column) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        let mut ids: Vec<u32> = data.pages.iter().map(|p| p.mushaf_id).collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let Some(layout) = quran_types::MushafLayout::from_db_id(id) else {
                bail!("unknown mushaf id {id}");
            };
            let spec = mushaf_spec(layout);
            let pages = u32::try_from(data.pages.iter().filter(|p| p.mushaf_id == id).count())?;
            let lines_per_page = data
                .lines
                .iter()
                .filter(|l| l.mushaf_id == id)
                .map(|l| l.line)
                .max()
                .unwrap_or(0);
            stmt.execute(params![
                id,
                spec.code,
                spec.name,
                pages,
                lines_per_page,
                spec.glyph_column
            ])
            .with_context(|| format!("mushaf {id}"))?;
        }
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO surah (id, name_ar, name_simple, name_complex, name_en, revelation_place, revelation_order,
                                ayah_count, first_ayah_id, rukus, bismillah_pre, header_cp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        for s in &data.surahs {
            stmt.execute(params![
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
                s.bismillah_pre,
                s.header_cp
            ])
            .with_context(|| format!("surah {}", s.id))?;
        }
    }

    for (table, rows) in [
        ("juz", &data.juzs),
        ("hizb", &data.hizbs),
        ("rub", &data.rubs),
        ("manzil", &data.manzils),
    ] {
        let mut stmt = tx.prepare(&format!(
            "INSERT INTO {table} (id, first_ayah_id, last_ayah_id) VALUES (?1, ?2, ?3)"
        ))?;
        for r in rows {
            stmt.execute(params![r.id, r.first_ayah_id, r.last_ayah_id])
                .with_context(|| format!("{table} {}", r.id))?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO ruku (id, surah, first_ayah_id, last_ayah_id) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for r in &data.rukus {
            stmt.execute(params![r.id, r.surah, r.first_ayah_id, r.last_ayah_id])
                .with_context(|| format!("ruku {}", r.id))?;
        }
    }
    {
        let mut stmt = tx.prepare("INSERT INTO sajda (id, ayah_id, kind) VALUES (?1, ?2, ?3)")?;
        for s in &data.sajdas {
            stmt.execute(params![s.id, s.ayah_id, s.kind.as_str()])
                .with_context(|| format!("sajda {}", s.id))?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO ayah (id, surah, ayah, juz, hizb, rub, manzil, ruku, sajda, flags, first_word_id, last_word_id,
                               text_hafs, text_imlaei, norm_loose, norm_strict)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )?;
        for a in &data.ayahs {
            stmt.execute(params![
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
            ])
            .with_context(|| format!("ayah {}", a.id))?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO word (id, ayah_id, surah, ayah, position, is_end, text_hafs, text_imlaei, norm_loose, code_v1,
                               code_v2)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for w in &data.words {
            stmt.execute(params![
                w.id,
                w.ayah_id,
                w.surah,
                w.ayah,
                w.position,
                w.is_end,
                w.text_hafs,
                w.text_imlaei,
                w.norm_loose,
                w.code_v1,
                w.code_v2
            ])
            .with_context(|| format!("word {}", w.id))?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO page (mushaf_id, page, first_word_id, last_word_id, first_ayah_id, last_ayah_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for p in &data.pages {
            stmt.execute(params![
                p.mushaf_id,
                p.page,
                p.first_word_id,
                p.last_word_id,
                p.first_ayah_id,
                p.last_ayah_id
            ])
            .with_context(|| format!("page {}:{}", p.mushaf_id, p.page))?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO line (mushaf_id, page, line, kind, centered, surah_id, first_word_id, last_word_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for l in &data.lines {
            stmt.execute(params![
                l.mushaf_id,
                l.page,
                l.line,
                l.kind.db_value(),
                l.centered,
                l.surah_id,
                l.words.map(|(first, _)| first),
                l.words.map(|(_, last)| last)
            ])
            .with_context(|| format!("line {}:{}:{}", l.mushaf_id, l.page, l.line))?;
        }
    }
    Ok(())
}

/// The §3.1.1 finalisation, in that order, plus the foreign-key check of G14. Returns (FTS rows, vocab terms).
fn finalise(conn: &Connection) -> anyhow::Result<(u32, u32)> {
    conn.execute_batch(
        "INSERT INTO ayah_fts(rowid, loose, strict) SELECT id, norm_loose, norm_strict FROM ayah;
         INSERT INTO ayah_fts(ayah_fts) VALUES('optimize');
         CREATE VIRTUAL TABLE temp.v USING fts5vocab(main, ayah_fts, 'col');
         INSERT INTO vocab_loose(term, doc_count) SELECT term, doc FROM temp.v WHERE col = 'loose';
         DROP TABLE temp.v;
         ANALYZE;",
    )
    .context("FTS index, vocabulary and ANALYZE")?;
    let journal: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
        .context("journal_mode = DELETE")?;
    ensure!(
        journal.eq_ignore_ascii_case("delete"),
        "journal_mode is {journal}, expected delete"
    );
    conn.execute_batch("VACUUM;").context("VACUUM")?;

    let integrity: Vec<String> = conn
        .prepare("PRAGMA integrity_check")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ensure!(
        integrity == ["ok"],
        "integrity_check: {}",
        integrity.join("; ")
    );
    let violations: u32 = conn
        .prepare("PRAGMA foreign_key_check")?
        .query_map([], |_| Ok(()))?
        .try_fold(0_u32, |n, r| r.map(|()| n + 1))?;
    ensure!(
        violations == 0,
        "foreign_key_check: {violations} violation(s)"
    );

    // `ayah_fts` is contentless, so count its rows through the docsize shadow table.
    let fts_rows: u32 =
        conn.query_row("SELECT count(*) FROM ayah_fts_docsize", [], |r| r.get(0))?;
    let vocab_terms: u32 = conn.query_row("SELECT count(*) FROM vocab_loose", [], |r| r.get(0))?;
    Ok((fts_rows, vocab_terms))
}
