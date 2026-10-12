//! `PackDb` reads: entries, tafsir range lookup, footnotes and search (§3.4). Owner: WP1c.
//!
//! Search support for `SearchEngine::search_pack` (§2.2.5 steps 4 and 7): FTS5 hits with raw `snippet()` text,
//! `LIKE` hits for `like_fallback` packs and short queries, both optionally limited to an ayah-id range and with a
//! matching count, plus the `plain` text of hits for snippets built in Rust.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use quran_types::{AYAH_COUNT, Footnote};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use super::pool::{Closer, Manager, OpenConns};
use super::{PACK_FORMAT, PackDb, PackEntry, PackMeta, PackTokenizer, parse_dir, parse_kind};
use crate::{CoreError, Result};

/// Connections per pack (§2.2.7).
const POOL_SIZE: u32 = 2;

/// U+E000 / U+E001 delimit FTS matches in raw snippets; `SearchEngine` escapes and replaces them with `<mark>`.
const SNIPPET_SQL: &str = "snippet(entry_fts, 0, char(57344), char(57345), '…', 16)";

impl PackDb {
    /// `READ_ONLY | URI` (NOT immutable: a pack may be replaced while the app runs), pool 2; requires `meta.format = 1`.
    ///
    /// A missing file is `NotFound`; a file without a `meta` table (or a 0-byte file) or with another format is
    /// `SchemaMismatch { expected: 1, found }`; a meta table without a required key is `Corrupt`.
    pub fn open(path: &Path) -> Result<Self> {
        if !path.is_file() {
            return Err(CoreError::NotFound(format!("pack db {}", short(path))));
        }
        let uri = file_uri(path)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        // One direct connection first, so a foreign file fails fast with its own error (r2d2 would retry until its
        // connection timeout).
        let meta = read_meta(&Connection::open_with_flags(&uri, flags)?, path)?;
        let manager = SqliteConnectionManager::file(&uri)
            .with_flags(flags)
            .with_init(|c| c.execute_batch("PRAGMA query_only = 1; PRAGMA temp_store = MEMORY;"));
        let open = Arc::new(OpenConns::default());
        let pool = r2d2::Pool::builder()
            .max_size(POOL_SIZE)
            .min_idle(Some(0))
            .connection_timeout(Duration::from_secs(10))
            .build(Manager::new(manager, Arc::clone(&open)))?;
        Ok(Self {
            pool,
            meta: Arc::new(meta),
            path: path.to_path_buf(),
            _closer: Arc::new(Closer(open)),
        })
    }

    #[must_use]
    pub fn meta(&self) -> &PackMeta {
        &self.meta
    }

    /// The file this handle reads.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the pack has an `entry_fts` index (every tokenizer but `like_fallback`).
    #[must_use]
    pub fn has_fts(&self) -> bool {
        self.meta.tokenizer.fts_tokenize().is_some()
    }

    /// Translations: one entry per ayah in `from..=to` (entries starting in that range, by ayah id).
    pub fn entries(&self, from: u32, to: u32) -> Result<Vec<PackEntry>> {
        check_range(from, to)?;
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT ayah_id, to_ayah_id, html FROM entry WHERE ayah_id BETWEEN ?1 AND ?2 ORDER BY ayah_id",
        )?;
        let rows = stmt
            .query_map(params![from, to], entry_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Tafsir range lookup: the entry whose `ayah_id..=to_ayah_id` contains `ayah_id`.
    pub fn entry_for(&self, ayah_id: u32) -> Result<Option<PackEntry>> {
        check_range(ayah_id, ayah_id)?;
        let conn = self.conn()?;
        let row = conn
            .prepare_cached(
                "SELECT ayah_id, to_ayah_id, html FROM entry WHERE ayah_id <= ?1 ORDER BY ayah_id DESC LIMIT 1",
            )?
            .query_row([ayah_id], entry_row)
            .optional()?;
        Ok(row.filter(|e| e.to_ayah_id >= ayah_id))
    }

    /// The footnotes of `ayah_ids`, in the order the ayahs are given (duplicates ignored), each ayah's footnotes by
    /// marker number ([`marker_number`]: the digits of any script, so a Bengali `১০` follows `২`), then marker text,
    /// then id. A marker without digits (the empty marker of a general note) counts as 0 and comes first. Footnote ids
    /// are `"{s}:{a}:{n}"` for QuranEnc packs.
    pub fn footnotes_for(&self, ayah_ids: &[u32]) -> Result<Vec<Footnote>> {
        let conn = self.conn()?;
        let mut stmt =
            conn.prepare_cached("SELECT id, marker, html FROM footnote WHERE ayah_id = ?1")?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for &ayah_id in ayah_ids {
            if !seen.insert(ayah_id) {
                continue;
            }
            let mut notes = stmt
                .query_map([ayah_id], |r| {
                    Ok(Footnote {
                        id: r.get(0)?,
                        marker: r.get(1)?,
                        html: r.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            notes.sort_by(|a, b| {
                marker_number(&a.marker)
                    .cmp(&marker_number(&b.marker))
                    .then_with(|| a.marker.cmp(&b.marker))
                    .then_with(|| a.id.cmp(&b.id))
            });
            out.extend(notes);
        }
        Ok(out)
    }

    /// `(ayah_id, raw snippet)` for an FTS5 `MATCH` expression, in mushaf order. The snippet is FTS5 `snippet()` of
    /// `fold` with matches between U+E000 and U+E001 (`…` ellipses, 16 tokens).
    pub fn fts_search(&self, fts: &str, limit: u32) -> Result<Vec<(u32, String)>> {
        self.fts_search_in(fts, 1, AYAH_COUNT, limit)
    }

    /// [`PackDb::fts_search`] limited to entries starting in `from..=to` (a surah or juz filter, §2.2.5 step 4).
    pub fn fts_search_in(
        &self,
        fts: &str,
        from: u32,
        to: u32,
        limit: u32,
    ) -> Result<Vec<(u32, String)>> {
        self.require_fts()?;
        check_range(from, to)?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT rowid, {SNIPPET_SQL} FROM entry_fts
             WHERE entry_fts MATCH ?1 AND rowid BETWEEN ?3 AND ?4 ORDER BY rowid LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(params![fts, limit, from, to], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// How many entries starting in `from..=to` match `fts` (the `total` of a truncated result).
    pub fn fts_count(&self, fts: &str, from: u32, to: u32) -> Result<u32> {
        self.require_fts()?;
        check_range(from, to)?;
        let conn = self.conn()?;
        let n = conn
            .prepare_cached(
                "SELECT count(*) FROM entry_fts WHERE entry_fts MATCH ?1 AND rowid BETWEEN ?2 AND ?3",
            )?
            .query_row(params![fts, from, to], |r| r.get(0))?;
        Ok(n)
    }

    /// `(ayah_id, plain)` of entries whose `fold` contains `needle` (`LIKE '%needle%'`, with `%`, `_` and `\` in the
    /// needle escaped), in mushaf order: `like_fallback` packs and queries under 3 characters. The needle must already
    /// be folded like the pack's `fold` column ([`PackTokenizer::fold`]); an empty needle matches nothing.
    pub fn like_search(&self, needle: &str, limit: u32) -> Result<Vec<(u32, String)>> {
        self.like_search_in(needle, 1, AYAH_COUNT, limit)
    }

    /// [`PackDb::like_search`] limited to entries starting in `from..=to`.
    pub fn like_search_in(
        &self,
        needle: &str,
        from: u32,
        to: u32,
        limit: u32,
    ) -> Result<Vec<(u32, String)>> {
        check_range(from, to)?;
        if needle.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT ayah_id, plain FROM entry
             WHERE fold LIKE '%' || ?1 || '%' ESCAPE '\\' AND ayah_id BETWEEN ?3 AND ?4
             ORDER BY ayah_id LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![escape_like(needle), limit, from, to], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// How many entries starting in `from..=to` [`PackDb::like_search`] would match without a limit.
    pub fn like_count(&self, needle: &str, from: u32, to: u32) -> Result<u32> {
        check_range(from, to)?;
        if needle.is_empty() {
            return Ok(0);
        }
        let conn = self.conn()?;
        let n = conn
            .prepare_cached(
                "SELECT count(*) FROM entry
                 WHERE fold LIKE '%' || ?1 || '%' ESCAPE '\\' AND ayah_id BETWEEN ?2 AND ?3",
            )?
            .query_row(params![escape_like(needle), from, to], |r| r.get(0))?;
        Ok(n)
    }

    /// `(ayah_id, plain)` of the entries starting in `from..=to`, by ayah id: the stored plain text (tags stripped,
    /// footnote markers removed, §3.4), e.g. a translation appended to copied ayahs (§5.5) without re-deriving it
    /// from `html`.
    pub fn plain_range(&self, from: u32, to: u32) -> Result<Vec<(u32, String)>> {
        check_range(from, to)?;
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT ayah_id, plain FROM entry WHERE ayah_id BETWEEN ?1 AND ?2 ORDER BY ayah_id",
        )?;
        let rows = stmt
            .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `(ayah_id, plain)` of the entries starting at `ayah_ids`, in the given order (missing ids skipped,
    /// duplicates ignored): the text Rust-built snippets are cut from (§2.2.5 step 7).
    pub fn plain_texts(&self, ayah_ids: &[u32]) -> Result<Vec<(u32, String)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare_cached("SELECT plain FROM entry WHERE ayah_id = ?1")?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for &ayah_id in ayah_ids {
            if !seen.insert(ayah_id) {
                continue;
            }
            if let Some(plain) = stmt.query_row([ayah_id], |r| r.get(0)).optional()? {
                out.push((ayah_id, plain));
            }
        }
        Ok(out)
    }

    fn conn(&self) -> Result<r2d2::PooledConnection<Manager>> {
        Ok(self.pool.get()?)
    }

    fn require_fts(&self) -> Result<()> {
        if self.has_fts() {
            Ok(())
        } else {
            Err(CoreError::InvalidArgument(format!(
                "pack {} has no full-text index (tokenizer {})",
                self.meta.pack_id,
                self.meta.tokenizer.as_str()
            )))
        }
    }
}

fn entry_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PackEntry> {
    Ok(PackEntry {
        ayah_id: r.get(0)?,
        to_ayah_id: r.get(1)?,
        html: r.get(2)?,
    })
}

/// `1 ≤ from ≤ to ≤ 6236`.
/// The leading number of a footnote marker in any script's decimal digits, like SQLite's `CAST(marker AS INTEGER)`
/// but not limited to ASCII: QuranEnc packs number their notes in the translation's script (Bengali `১০`, Arabic-Indic
/// `١٠`, Devanagari `१०`, …). Leading whitespace is skipped; no digit gives 0; the value saturates.
fn marker_number(marker: &str) -> u64 {
    marker
        .trim_start()
        .chars()
        .map_while(decimal_digit)
        .fold(0u64, |n, d| {
            n.saturating_mul(10).saturating_add(u64::from(d))
        })
}

/// The value of a decimal digit (Unicode `Nd`) of the scripts translations use: each block is ten consecutive code
/// points from its zero.
fn decimal_digit(c: char) -> Option<u32> {
    /// The zero of each decimal digit block: ASCII, Arabic-Indic, Extended Arabic-Indic (Persian/Urdu), NKo,
    /// Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao, Tibetan,
    /// Myanmar, Khmer, Mongolian, fullwidth.
    const ZEROS: [u32; 21] = [
        0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66,
        0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x17E0, 0x1810, 0xFF10,
    ];
    let cp = u32::from(c);
    ZEROS
        .iter()
        .find_map(|&zero| cp.checked_sub(zero).filter(|d| *d < 10))
}

fn check_range(from: u32, to: u32) -> Result<()> {
    if from == 0 || from > to || to > AYAH_COUNT {
        return Err(CoreError::InvalidArgument(format!(
            "ayah range {from}..={to} is not within 1..={AYAH_COUNT}"
        )));
    }
    Ok(())
}

/// Escapes the `LIKE` wildcards (`ESCAPE '\'`).
fn escape_like(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len());
    for ch in needle.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `file:///…/pack.db?mode=ro` for an absolute (or made absolute) path.
fn file_uri(path: &Path) -> Result<String> {
    let abs = std::path::absolute(path)?;
    let mut url = url::Url::from_file_path(&abs).map_err(|()| {
        CoreError::InvalidArgument(format!("pack db path {} has no file URL", short(path)))
    })?;
    url.set_query(Some("mode=ro"));
    Ok(url.into())
}

/// The last three path components (`{id}/{version}/pack.db`): messages never carry the user's home path.
fn short(path: &Path) -> String {
    let parts: Vec<_> = path.components().rev().take(3).collect();
    parts
        .into_iter()
        .rev()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Reads and validates the `meta` table (§3.4).
fn read_meta(conn: &Connection, path: &Path) -> Result<PackMeta> {
    let has_meta: bool = conn.query_row(
        "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Err(CoreError::SchemaMismatch {
            expected: PACK_FORMAT,
            found: 0,
        });
    }
    let mut stmt = conn.prepare("SELECT key, value FROM meta")?;
    let map = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    let name = short(path);
    let format = match map.get("format") {
        None => 0,
        Some(v) => v
            .trim()
            .parse()
            .map_err(|_| CoreError::Corrupt(format!("pack meta of {name}: format {v:?}")))?,
    };
    if format != PACK_FORMAT {
        return Err(CoreError::SchemaMismatch {
            expected: PACK_FORMAT,
            found: format,
        });
    }
    let get = |key: &str| -> Result<String> {
        map.get(key)
            .cloned()
            .ok_or_else(|| CoreError::Corrupt(format!("pack meta of {name}: missing {key}")))
    };
    let bad = |key: &str, value: &str| {
        CoreError::Corrupt(format!("pack meta of {name}: {key} {value:?}"))
    };
    let kind_text = get("kind")?;
    let kind = parse_kind(&kind_text).ok_or_else(|| bad("kind", &kind_text))?;
    let dir_text = get("dir")?;
    let dir = parse_dir(&dir_text).ok_or_else(|| bad("dir", &dir_text))?;
    let tokenizer_text = get("tokenizer")?;
    let tokenizer =
        PackTokenizer::parse(&tokenizer_text).ok_or_else(|| bad("tokenizer", &tokenizer_text))?;
    let normalizer_text = get("normalizer_version")?;
    let normalizer_version = normalizer_text
        .trim()
        .parse()
        .map_err(|_| bad("normalizer_version", &normalizer_text))?;
    Ok(PackMeta {
        pack_id: get("pack_id")?,
        kind,
        lang: get("lang")?,
        dir,
        name: get("name")?,
        author: get("author")?,
        source: get("source")?,
        source_version: get("source_version")?,
        licence: get("licence")?,
        attribution: get("attribution")?,
        tokenizer,
        normalizer_version,
        format,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn marker_numbers_read_the_digits_of_any_script() {
        for (marker, n) in [
            ("", 0),
            ("  ", 0),
            ("*", 0),
            ("1", 1),
            (" 12", 12),
            ("10a", 10),
            ("২", 2),     // Bengali
            ("১০", 10),   // Bengali
            ("١٢", 12),   // Arabic-Indic
            ("۱۵", 15),   // Extended Arabic-Indic (Urdu, Persian)
            ("१००", 100), // Devanagari
            ("௧௦", 10),   // Tamil
            ("１２", 12), // fullwidth
            ("99999999999999999999999", u64::MAX),
        ] {
            assert_eq!(marker_number(marker), n, "{marker:?}");
        }
        assert!(marker_number("১০") > marker_number("২"));
    }

    #[test]
    fn like_wildcards_are_escaped() {
        assert_eq!(escape_like("mercy"), "mercy");
        assert_eq!(escape_like("100%_a\\b"), "100\\%\\_a\\\\b");
    }

    #[test]
    fn ranges_are_checked() {
        assert!(check_range(1, AYAH_COUNT).is_ok());
        assert!(check_range(7, 7).is_ok());
        assert!(check_range(0, 7).is_err());
        assert!(check_range(8, 7).is_err());
        assert!(check_range(1, AYAH_COUNT + 1).is_err());
    }

    #[test]
    fn uris_are_absolute_and_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let uri = file_uri(&dir.path().join("my packs").join("pack#1.db")).unwrap();
        assert!(uri.starts_with("file:///"), "{uri}");
        assert!(uri.ends_with("/my%20packs/pack%231.db?mode=ro"), "{uri}");
        let relative = file_uri(Path::new("pack.db")).unwrap();
        assert!(relative.starts_with("file:///") && relative.ends_with("/pack.db?mode=ro"));
    }

    #[test]
    fn short_paths_hide_the_home_directory() {
        let p = Path::new("home")
            .join("user")
            .join("packs")
            .join("tr.en.saheeh")
            .join("1.1.2")
            .join("pack.db");
        assert_eq!(short(&p), "tr.en.saheeh/1.1.2/pack.db");
    }

    /// The last handle's drop returns once the file is closed, so the pack can be deleted right after (Windows refuses
    /// to delete an open file). r2d2 opens connections on its worker thread, which frees the pool, idle connections
    /// included, when it lets go of it a moment later: a few rounds give that race its chance.
    #[test]
    fn dropping_the_last_handle_closes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pack.db");
        let meta = PackMeta {
            pack_id: "tr.en.test".into(),
            kind: quran_types::PackKind::Translation,
            lang: "en".into(),
            dir: quran_types::TextDir::Ltr,
            name: "Test".into(),
            author: String::new(),
            source: "quranenc".into(),
            source_version: "1".into(),
            licence: String::new(),
            attribution: String::new(),
            tokenizer: PackTokenizer::PorterUnicode61,
            normalizer_version: crate::NORMALIZER_VERSION,
            format: PACK_FORMAT,
        };
        for round in 0..20 {
            let mut w = crate::PackDbWriter::create(&path, &meta).unwrap();
            w.entry(&crate::PackEntryInput {
                ayah_id: 1,
                to_ayah_id: 1,
                html: "<p>a</p>".into(),
                plain: "a".into(),
            })
            .unwrap();
            w.finish().unwrap();
            let db = PackDb::open(&path).unwrap();
            let other = db.clone();
            std::thread::scope(|s| {
                s.spawn(|| other.entries(1, 1).unwrap());
                db.entries(1, 1).unwrap();
            });
            let open = Arc::clone(&db._closer.0);
            drop(other);
            assert!(!open.wait_closed(Duration::ZERO), "a clone keeps the pool");
            drop(db);
            assert!(
                open.wait_closed(Duration::ZERO),
                "round {round}: a connection outlived the last handle"
            );
            std::fs::remove_file(&path).unwrap();
        }
    }
}
