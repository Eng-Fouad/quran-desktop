//! `PackDbWriter`: builds a pack DB in a staging directory (§3.4, §2.5.5 atomic install). Owner: WP1c.
//!
//! The writer owns the only connection to a fresh file. Rows go in through one transaction with the journal in memory
//! and `synchronous=OFF` (a failed build is simply discarded with its staging directory); [`PackDbWriter::finish`]
//! builds and optimises the FTS index, checks that ranges do not overlap, then switches to `journal_mode=DELETE`,
//! `VACUUM`s with `synchronous=FULL` (the file is durable before the installer renames it into place) and runs
//! `integrity_check`. Dropping a writer without `finish` rolls everything back.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use quran_types::{AYAH_COUNT, PackKind};
use rusqlite::{Connection, ErrorCode, OptionalExtension, params};

use super::{
    FootnoteInput, PACK_FORMAT, PackEntryInput, PackMeta, PackStats, PackTokenizer, dir_text,
    kind_text,
};
use crate::{CoreError, NORMALIZER_VERSION, Result};

/// Writes one pack DB. Not `Clone`; owned by the install job that builds the pack.
pub struct PackDbWriter {
    conn: rusqlite::Connection,
    path: PathBuf,
    kind: PackKind,
    tokenizer: PackTokenizer,
}

impl PackDbWriter {
    /// Creates the file (replacing a leftover file of the same name and its journals, creating the directory) and
    /// applies `schema/pack.sql` for `meta.tokenizer` ([`super::PackTokenizer::pack_sql`]), then writes every §3.4
    /// `meta` key: `created_at` is the Unix time in seconds and `source_sha256` is empty until
    /// [`PackDbWriter::set_source_sha256`].
    ///
    /// `meta.kind` must be `Translation` or `Tafsir`, `meta.format` 1, and `meta.normalizer_version` the current
    /// [`NORMALIZER_VERSION`] (the `fold` column is built with it); `pack_id` and `lang` must not be empty.
    pub fn create(path: &Path, meta: &PackMeta) -> Result<Self> {
        let kind = check_meta(meta)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        remove_db_files(path)?;
        let conn = Connection::open(path)?;
        conn.pragma_update_and_check(None, "journal_mode", "MEMORY", |r| r.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "OFF")?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        conn.execute_batch(&meta.tokenizer.pack_sql())?;
        conn.execute_batch("BEGIN")?;
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let rows: [(&str, String); 15] = [
            ("format", PACK_FORMAT.to_string()),
            ("pack_id", meta.pack_id.clone()),
            ("kind", kind.to_owned()),
            ("lang", meta.lang.clone()),
            ("dir", dir_text(meta.dir).to_owned()),
            ("name", meta.name.clone()),
            ("author", meta.author.clone()),
            ("source", meta.source.clone()),
            ("source_version", meta.source_version.clone()),
            ("licence", meta.licence.clone()),
            ("attribution", meta.attribution.clone()),
            ("tokenizer", meta.tokenizer.as_str().to_owned()),
            ("normalizer_version", meta.normalizer_version.to_string()),
            ("created_at", created_at.to_string()),
            ("source_sha256", String::new()),
        ];
        {
            let mut insert = conn.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)")?;
            for (key, value) in &rows {
                insert.execute(params![key, value])?;
            }
        }
        Ok(Self {
            conn,
            path: path.to_path_buf(),
            kind: meta.kind,
            tokenizer: meta.tokenizer,
        })
    }

    /// Records the sha256 of the upstream file the pack was built from (`meta.source_sha256`, §2.5.5 integrity).
    pub fn set_source_sha256(&mut self, sha256: &str) -> Result<()> {
        self.conn
            .prepare_cached("UPDATE meta SET value = ?1 WHERE key = 'source_sha256'")?
            .execute([sha256])?;
        Ok(())
    }

    /// Adds one entry; `fold` is derived from `plain` with the pack's tokenizer. A translation entry covers exactly
    /// one ayah (`to_ayah_id == ayah_id`); a tafsir entry a range. Ayah ids are 1..=6236, each entry starts at a
    /// different ayah (ranges are checked for overlap by [`PackDbWriter::finish`]).
    pub fn entry(&mut self, e: &PackEntryInput) -> Result<()> {
        if e.ayah_id == 0 || e.to_ayah_id < e.ayah_id || e.to_ayah_id > AYAH_COUNT {
            return Err(CoreError::InvalidArgument(format!(
                "pack entry {}..={} is not within 1..={AYAH_COUNT}",
                e.ayah_id, e.to_ayah_id
            )));
        }
        if self.kind == PackKind::Translation && e.to_ayah_id != e.ayah_id {
            return Err(CoreError::InvalidArgument(format!(
                "translation entry {}..={} covers more than one ayah",
                e.ayah_id, e.to_ayah_id
            )));
        }
        let fold = self.tokenizer.fold(&e.plain);
        self.conn
            .prepare_cached(
                "INSERT INTO entry (ayah_id, to_ayah_id, html, plain, fold) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![e.ayah_id, e.to_ayah_id, e.html, e.plain, fold])
            .map_err(|err| {
                constraint(err, || format!("two pack entries start at ayah {}", e.ayah_id))
            })?;
        Ok(())
    }

    /// Adds one footnote (ids are unique; the ayah id is 1..=6236).
    pub fn footnote(&mut self, f: &FootnoteInput) -> Result<()> {
        if f.id.is_empty() || f.ayah_id == 0 || f.ayah_id > AYAH_COUNT {
            return Err(CoreError::InvalidArgument(format!(
                "footnote {:?} of ayah {} is invalid",
                f.id, f.ayah_id
            )));
        }
        self.conn
            .prepare_cached(
                "INSERT INTO footnote (id, ayah_id, marker, html) VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![f.id, f.ayah_id, f.marker, f.html])
            .map_err(|err| constraint(err, || format!("footnote {:?} is written twice", f.id)))?;
        Ok(())
    }

    /// FTS `'rebuild'` + `'optimize'`, `ANALYZE`, `journal_mode=DELETE`, `VACUUM`, `integrity_check`; returns counts.
    ///
    /// Fails (and leaves an unusable file for the caller to discard with its staging directory) when the pack has no
    /// entries, when two entries' ranges overlap, or when the integrity check does not pass.
    pub fn finish(self) -> Result<PackStats> {
        let Self {
            conn,
            path,
            tokenizer,
            ..
        } = self;
        let entries: u32 = conn.query_row("SELECT count(*) FROM entry", [], |r| r.get(0))?;
        if entries == 0 {
            return Err(CoreError::InvalidArgument("pack has no entries".into()));
        }
        let footnotes: u32 = conn.query_row("SELECT count(*) FROM footnote", [], |r| r.get(0))?;
        let overlap = conn
            .query_row(
                "SELECT ayah_id, to_ayah_id, nxt FROM (
                   SELECT ayah_id, to_ayah_id, lead(ayah_id) OVER (ORDER BY ayah_id) AS nxt FROM entry)
                 WHERE nxt <= to_ayah_id LIMIT 1",
                [],
                |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?, r.get::<_, u32>(2)?)),
            )
            .optional()?;
        if let Some((from, to, next)) = overlap {
            return Err(CoreError::InvalidArgument(format!(
                "pack entry {from}..={to} overlaps the entry starting at {next}"
            )));
        }
        if tokenizer.fts_tokenize().is_some() {
            conn.execute_batch(
                "INSERT INTO entry_fts (entry_fts) VALUES ('rebuild');
                 INSERT INTO entry_fts (entry_fts) VALUES ('optimize');",
            )?;
        }
        conn.execute_batch("COMMIT; ANALYZE;")?;
        conn.pragma_update_and_check(None, "journal_mode", "DELETE", |r| r.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch("VACUUM")?;
        let problems = {
            let mut stmt = conn.prepare("PRAGMA integrity_check")?;
            stmt.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if !matches!(problems.as_slice(), [ok] if ok == "ok") {
            return Err(CoreError::Corrupt(format!(
                "pack integrity_check: {}",
                problems.join("; ")
            )));
        }
        conn.close().map_err(|(_, e)| CoreError::Sqlite(e))?;
        let bytes = std::fs::metadata(&path)?.len();
        Ok(PackStats {
            entries,
            footnotes,
            bytes,
        })
    }
}

/// The pre-write checks of [`PackDbWriter::create`]; returns the `meta.kind` text.
fn check_meta(meta: &PackMeta) -> Result<&'static str> {
    let kind = kind_text(meta.kind).ok_or_else(|| {
        CoreError::InvalidArgument(format!("a {:?} pack has no pack db", meta.kind))
    })?;
    if meta.format != PACK_FORMAT {
        return Err(CoreError::InvalidArgument(format!(
            "pack format {} (this build writes {PACK_FORMAT})",
            meta.format
        )));
    }
    if meta.normalizer_version != NORMALIZER_VERSION {
        return Err(CoreError::InvalidArgument(format!(
            "pack normalizer_version {} (this build folds with {NORMALIZER_VERSION})",
            meta.normalizer_version
        )));
    }
    if meta.pack_id.trim().is_empty() || meta.lang.trim().is_empty() {
        return Err(CoreError::InvalidArgument(
            "pack meta needs a pack_id and a lang".into(),
        ));
    }
    Ok(kind)
}

/// Removes a leftover database file and its journals (a retried build in the same staging directory).
fn remove_db_files(path: &Path) -> Result<()> {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        match std::fs::remove_file(PathBuf::from(p)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// A uniqueness violation becomes `InvalidArgument` with `what`; other errors stay SQLite errors.
fn constraint(e: rusqlite::Error, what: impl FnOnce() -> String) -> CoreError {
    if e.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
        CoreError::InvalidArgument(what())
    } else {
        CoreError::Sqlite(e)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use quran_types::TextDir;

    use super::*;

    fn meta(kind: PackKind) -> PackMeta {
        PackMeta {
            pack_id: "tr.en.test".into(),
            kind,
            lang: "en".into(),
            dir: TextDir::Ltr,
            name: "Test".into(),
            author: String::new(),
            source: "quranenc".into(),
            source_version: "1".into(),
            licence: String::new(),
            attribution: String::new(),
            tokenizer: PackTokenizer::PorterUnicode61,
            normalizer_version: NORMALIZER_VERSION,
            format: PACK_FORMAT,
        }
    }

    #[test]
    fn only_translation_and_tafsir_packs_have_a_db() {
        assert_eq!(
            check_meta(&meta(PackKind::Translation)).unwrap(),
            "translation"
        );
        assert_eq!(check_meta(&meta(PackKind::Tafsir)).unwrap(), "tafsir");
        for kind in [
            PackKind::MushafFonts,
            PackKind::Decor,
            PackKind::Recitation,
            PackKind::Wbw,
        ] {
            assert!(matches!(
                check_meta(&meta(kind)),
                Err(CoreError::InvalidArgument(_))
            ));
        }
        let stale_fold = PackMeta {
            normalizer_version: 0,
            ..meta(PackKind::Translation)
        };
        assert!(matches!(
            check_meta(&stale_fold),
            Err(CoreError::InvalidArgument(_))
        ));
    }

    #[test]
    fn leftovers_are_removed_and_missing_files_are_fine() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pack.db");
        remove_db_files(&path).unwrap();
        std::fs::write(&path, "x").unwrap();
        std::fs::write(dir.path().join("pack.db-journal"), "j").unwrap();
        remove_db_files(&path).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_minimal_pack_builds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("pack.db");
        let mut w = PackDbWriter::create(&path, &meta(PackKind::Translation)).unwrap();
        w.entry(&PackEntryInput {
            ayah_id: 1,
            to_ayah_id: 1,
            html: "<p>x</p>".into(),
            plain: "x".into(),
        })
        .unwrap();
        let stats = w.finish().unwrap();
        assert_eq!((stats.entries, stats.footnotes), (1, 0));
        assert!(stats.bytes > 0);
    }
}
