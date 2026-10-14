//! `CoreDb`: the bundled, read-only core.db.
//!
//! - [`CoreDb::open`] opens `file:///…/core.db?mode=ro&immutable=1` behind an r2d2 pool. `immutable=1` skips locking
//!   and change detection and creates no `-journal`/`-wal`/`-shm` files, so the database works from a read-only
//!   install location (Program Files, a signed `.app`, an AppImage mount).
//! - Pages are assembled from ONE query per page (`page.rs`, [`PAGE_SQL`]); the [`QuranIndex`] is built once and then
//!   cloned (`index.rs`); ayah rows, copy text and word lookups live in `text.rs`.
//! - Every method validates its arguments ([`CoreError::InvalidArgument`]), never panics, and maps data that breaks the
//!   verify-core invariants to [`CoreError::Corrupt`] instead of guessing.
//!
//! `CoreDb` is `Clone + Send + Sync`; its methods block on SQLite, so call them from `spawn_blocking`.

mod index;
mod page;
mod text;

#[cfg(test)]
#[path = "../../tests/support/mini_core.rs"]
pub(crate) mod mini_core;

pub use page::PAGE_SQL;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use quran_types::{
    AYAH_COUNT, AyahText, CopyOptions, MushafLayout, MushafStyle, PAGE_COUNT, PageData, QuranIndex,
    SajdaKind,
};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OpenFlags};

use crate::{CORE_SCHEMA_VERSION, CoreError, NORMALIZER_VERSION, Result};

/// Most pages one [`CoreDb::pages`] call (and `mushaf_get_pages`) accepts.
pub const MAX_PAGES_PER_CALL: usize = 8;
/// [`CoreDb::ayahs`] (and `quran_get_ayahs`) accepts `to − from < MAX_AYAHS_PER_CALL`.
pub const MAX_AYAHS_PER_CALL: u32 = 300;
/// The error message of every query on an [`CoreDb::unavailable`] handle.
pub const UNAVAILABLE_MESSAGE: &str = "core.db missing — run pnpm core:qdc";

/// How long a query waits for a free pooled connection before failing with [`CoreError::Pool`].
const POOL_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-connection setup: read-only, 256 MiB of memory-mapped I/O, an 8 MiB page cache, temp data in memory.
const CONNECTION_PRAGMAS: &str = "PRAGMA query_only = 1;
PRAGMA mmap_size = 268435456;
PRAGMA cache_size = -8192;
PRAGMA temp_store = MEMORY;";

type Pool = r2d2::Pool<SqliteConnectionManager>;

/// A pooled read-only connection to core.db.
pub type CoreConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Read-only handle on core.db. `Clone + Send + Sync`; call it from `spawn_blocking`.
#[derive(Clone)]
pub struct CoreDb {
    /// `None` = [`CoreDb::unavailable`] (debug degrade path).
    pool: Option<Pool>,
    meta: Arc<CoreMeta>,
    /// Built once by [`CoreDb::index`], then cloned.
    index: Arc<OnceLock<QuranIndex>>,
}

impl std::fmt::Debug for CoreDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreDb")
            .field("available", &self.is_available())
            .field("meta", &self.meta)
            .field("index_cached", &self.index.get().is_some())
            .finish()
    }
}

/// The `meta` table of core.db.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreMeta {
    pub schema_version: u32,
    pub normalizer_version: u32,
    /// `"qdc"` or `"qul"`; `"unavailable"` for a handle without a database.
    pub source: String,
    /// RFC 3339 UTC.
    pub built_at: String,
    pub word_count: u32,
}

impl CoreMeta {
    fn unavailable() -> Self {
        Self {
            schema_version: 0,
            normalizer_version: 0,
            source: "unavailable".to_owned(),
            built_at: String::new(),
            word_count: 0,
        }
    }
}

impl CoreDb {
    /// Opens `file:///…/core.db?mode=ro&immutable=1` (`url::Url::from_file_path` + query) with
    /// `SQLITE_OPEN_READ_ONLY | URI | NO_MUTEX`. Pool size `available_parallelism().clamp(2, 4)`.
    /// `with_init`: `PRAGMA query_only=1; mmap_size=268435456; cache_size=-8192; temp_store=MEMORY;` and registers
    /// `ar_norm(text)` ([`crate::normalize::register_ar_norm`]).
    /// Errors with `SchemaMismatch` if `meta.schema_version != CORE_SCHEMA_VERSION`; a 0-byte file (the build.rs
    /// placeholder) or a missing `meta` table maps to `SchemaMismatch { expected: CORE_SCHEMA_VERSION, found: 0 }`.
    ///
    /// A missing file fails immediately with SQLite's "unable to open database file"; a file that is not a database
    /// fails with SQLite's "file is not a database". The pool itself connects lazily.
    pub fn open(path: &Path) -> Result<Self> {
        let uri = immutable_uri(path)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        // A probe connection reports open errors at once (r2d2 would retry until its timeout) and reads `meta`.
        let probe = Connection::open_with_flags(&uri, flags)?;
        init_connection(&probe)?;
        let meta = read_meta(&probe)?;
        drop(probe);
        if meta.normalizer_version != NORMALIZER_VERSION {
            // Search goes stale, pages do not: keep the app usable and say what to rebuild (G13 makes this a build
            // error for every shipped core.db).
            log::warn!(
                "core.db normalizer_version {} differs from this build's {NORMALIZER_VERSION}: rebuild core.db \
                 (pnpm core:qdc) for exact search results",
                meta.normalizer_version
            );
        }
        let manager = SqliteConnectionManager::file(&uri)
            .with_flags(flags)
            .with_init(|conn| init_connection(conn));
        let pool = r2d2::Pool::builder()
            .max_size(pool_size())
            .min_idle(Some(0))
            .connection_timeout(POOL_TIMEOUT)
            .build_unchecked(manager);
        log::info!(
            "core.db opened: source {}, built {}, schema {}, {} words",
            meta.source,
            meta.built_at,
            meta.schema_version,
            meta.word_count
        );
        Ok(Self {
            pool: Some(pool),
            meta: Arc::new(meta),
            index: Arc::new(OnceLock::new()),
        })
    }

    /// Debug builds only (setup degrade path): a handle whose every method returns
    /// `CoreError::NotFound("core.db missing — run pnpm core:qdc")`. Never constructed in release.
    #[must_use]
    pub fn unavailable(reason: String) -> Self {
        log::warn!("core.db unavailable: {reason}");
        Self {
            pool: None,
            meta: Arc::new(CoreMeta::unavailable()),
            index: Arc::new(OnceLock::new()),
        }
    }

    /// False for [`CoreDb::unavailable`] handles.
    #[must_use]
    pub fn is_available(&self) -> bool {
        self.pool.is_some()
    }

    #[must_use]
    pub fn meta(&self) -> &CoreMeta {
        &self.meta
    }

    /// A pooled read-only connection (waits up to 10 s for a free one).
    pub fn conn(&self) -> Result<CoreConn> {
        let pool = self
            .pool
            .as_ref()
            .ok_or_else(|| CoreError::NotFound(UNAVAILABLE_MESSAGE.to_owned()))?;
        Ok(pool.get()?)
    }

    /// Built once (the bootstrap arrays), cloned afterwards. Budget: < 30 ms first call.
    pub fn index(&self) -> Result<QuranIndex> {
        if let Some(index) = self.index.get() {
            return Ok(index.clone());
        }
        let built = index::build(&*self.conn()?)?;
        // A concurrent first call may have won the race; both built the same value.
        Ok(self.index.get_or_init(|| built).clone())
    }

    /// 1..=8 pages; one SQL query per page. Pages come back in request order.
    pub fn pages(&self, style: MushafStyle, pages: &[u32]) -> Result<Vec<PageData>> {
        check_pages(pages)?;
        let conn = self.conn()?;
        pages.iter().map(|&p| page::load(&conn, style, p)).collect()
    }

    /// `to − from < 300`. Each row carries its page in `layout`.
    pub fn ayahs(&self, layout: MushafLayout, from: u32, to: u32) -> Result<Vec<AyahText>> {
        check_ayah_range(from, to)?;
        if to - from >= MAX_AYAHS_PER_CALL {
            return Err(CoreError::InvalidArgument(format!(
                "ayahs {from}..={to}: at most {MAX_AYAHS_PER_CALL} ayahs per call"
            )));
        }
        text::ayahs(&*self.conn()?, layout, from, to)
    }

    /// The Arabic part of a copy only: the words, the optional ` ﴿N﴾` markers and the optional `\n{reference}`.
    /// The caller appends the translation (`translation_pack_id` is ignored here: packs live outside core.db).
    pub fn copy_text(&self, from: u32, to: u32, opts: &CopyOptions) -> Result<String> {
        check_ayah_range(from, to)?;
        text::copy_text(&*self.conn()?, from, to, opts)
    }

    /// The page of `layout` that holds the ayah's first word (page numbers are layout-specific).
    pub fn page_of_ayah(&self, layout: MushafLayout, ayah_id: u32) -> Result<u32> {
        check_ayah(ayah_id)?;
        text::page_of_ayah(&*self.conn()?, layout, ayah_id)
    }

    /// `(first_word_id, last_word_id)`; the last word is the end marker.
    pub fn word_range_of_ayah(&self, ayah_id: u32) -> Result<(u32, u32)> {
        check_ayah(ayah_id)?;
        text::word_range_of_ayah(&*self.conn()?, ayah_id)
    }

    /// `(surah, ayah, position)` → word id, for WBW and timings mapping. `None` for a location that does not exist
    /// (including position 0 and a position past the end marker).
    pub fn word_ids_by_location(&self, locs: &[(u32, u32, u32)]) -> Result<Vec<Option<u32>>> {
        if locs.is_empty() {
            return Ok(Vec::new());
        }
        text::word_ids_by_location(&*self.conn()?, locs)
    }
}

/// `available_parallelism().clamp(2, 4)`.
fn pool_size() -> u32 {
    let cores = std::thread::available_parallelism().map_or(2, std::num::NonZeroUsize::get);
    u32::try_from(cores.clamp(2, 4)).unwrap_or(2)
}

fn init_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(CONNECTION_PRAGMAS)?;
    crate::normalize::register_ar_norm(conn)
}

/// `file:///C:/…/core.db?mode=ro&immutable=1`. Relative paths resolve against the current directory. A UNC path
/// (`\\server\share\…`) becomes `file:////server/share/…`: SQLite rejects a URI authority other than `localhost`.
fn immutable_uri(path: &Path) -> Result<String> {
    let absolute = std::path::absolute(path)?;
    let url = url::Url::from_file_path(&absolute).map_err(|()| {
        CoreError::InvalidArgument(format!(
            "core.db path {} cannot be expressed as a file URI",
            absolute.display()
        ))
    })?;
    let query = "mode=ro&immutable=1";
    Ok(match url.host_str() {
        Some(host) if !host.is_empty() && host != "localhost" => {
            format!("file:////{host}{}?{query}", url.path())
        }
        _ => format!("file://{}?{query}", url.path()),
    })
}

/// Reads and checks `meta`. A database without a `meta` table (a 0-byte file is an empty database) or without
/// `schema_version` is schema version 0.
fn read_meta(conn: &Connection) -> Result<CoreMeta> {
    let mismatch = |found| CoreError::SchemaMismatch {
        expected: CORE_SCHEMA_VERSION,
        found,
    };
    let has_meta: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta')",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Err(mismatch(0));
    }
    let mut values: HashMap<String, String> = {
        let mut stmt = conn.prepare("SELECT key, value FROM meta")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let number = |values: &HashMap<String, String>, key: &str| -> Result<u32> {
        values.get(key).map_or(Ok(0), |v| {
            v.trim().parse().map_err(|_| {
                CoreError::Corrupt(format!("core.db meta.{key} = {v:?} is not a number"))
            })
        })
    };
    let schema_version = number(&values, "schema_version")?;
    if schema_version != CORE_SCHEMA_VERSION {
        return Err(mismatch(schema_version));
    }
    Ok(CoreMeta {
        schema_version,
        normalizer_version: number(&values, "normalizer_version")?,
        word_count: number(&values, "word_count")?,
        source: values.remove("source").unwrap_or_default(),
        built_at: values.remove("built_at").unwrap_or_default(),
    })
}

fn check_ayah(ayah_id: u32) -> Result<()> {
    if (1..=AYAH_COUNT).contains(&ayah_id) {
        Ok(())
    } else {
        Err(CoreError::InvalidArgument(format!(
            "ayah id {ayah_id} is outside 1..={AYAH_COUNT}"
        )))
    }
}

fn check_ayah_range(from: u32, to: u32) -> Result<()> {
    check_ayah(from)?;
    check_ayah(to)?;
    if from > to {
        return Err(CoreError::InvalidArgument(format!(
            "ayah range {from}..={to} is reversed"
        )));
    }
    Ok(())
}

fn check_pages(pages: &[u32]) -> Result<()> {
    if pages.is_empty() || pages.len() > MAX_PAGES_PER_CALL {
        return Err(CoreError::InvalidArgument(format!(
            "expected 1..={MAX_PAGES_PER_CALL} pages, got {}",
            pages.len()
        )));
    }
    match pages.iter().find(|p| !(1..=PAGE_COUNT).contains(*p)) {
        Some(p) => Err(CoreError::InvalidArgument(format!(
            "page {p} is outside 1..={PAGE_COUNT}"
        ))),
        None => Ok(()),
    }
}

/// `ayah.sajda` (0 none, 1 recommended, 2 obligatory).
fn sajda_kind(value: i64, ayah_id: u32) -> Result<Option<SajdaKind>> {
    match value {
        0 => Ok(None),
        1 => Ok(Some(SajdaKind::Recommended)),
        2 => Ok(Some(SajdaKind::Obligatory)),
        other => Err(CoreError::Corrupt(format!(
            "ayah {ayah_id} has sajda = {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::ReferenceStyle;

    use super::*;

    fn copy_opts() -> CopyOptions {
        CopyOptions {
            include_reference: true,
            reference_style: ReferenceStyle::Short,
            ayah_numbers: true,
            translation_pack_id: None,
        }
    }

    #[test]
    fn uri_is_an_immutable_read_only_file_uri() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a dir with spaces").join("core #1.db");
        let uri = immutable_uri(&path).unwrap();
        assert!(uri.starts_with("file:///"), "{uri}");
        assert!(uri.ends_with("?mode=ro&immutable=1"), "{uri}");
        assert!(
            uri.contains("a%20dir%20with%20spaces/core%20%231.db"),
            "{uri}"
        );
        assert!(!uri.contains('\\'), "{uri}");
    }

    #[cfg(windows)]
    #[test]
    fn uri_handles_drive_verbatim_and_unc_paths() {
        assert_eq!(
            immutable_uri(Path::new(r"C:\Program Files\Quran\data\core.db")).unwrap(),
            "file:///C:/Program%20Files/Quran/data/core.db?mode=ro&immutable=1"
        );
        assert_eq!(
            immutable_uri(Path::new(r"\\?\C:\data\core.db")).unwrap(),
            "file:///C:/data/core.db?mode=ro&immutable=1"
        );
        assert_eq!(
            immutable_uri(Path::new(r"\\server\share\core.db")).unwrap(),
            "file:////server/share/core.db?mode=ro&immutable=1"
        );
    }

    #[test]
    fn a_zero_byte_file_is_schema_version_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.db");
        std::fs::write(&path, b"").unwrap();
        let err = CoreDb::open(&path).unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::SchemaMismatch {
                    expected: 1,
                    found: 0
                }
            ),
            "{err:?}"
        );
        // immutable=1 must not create sidecar files next to the placeholder.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("core.db")]);
    }

    #[test]
    fn a_database_without_meta_is_schema_version_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE t (x INTEGER);")
            .unwrap();
        assert!(matches!(
            CoreDb::open(&path),
            Err(CoreError::SchemaMismatch { found: 0, .. })
        ));
    }

    #[test]
    fn meta_versions_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
             INSERT INTO meta VALUES ('normalizer_version', '1');",
        )
        .unwrap();
        assert!(matches!(
            CoreDb::open(&path),
            Err(CoreError::SchemaMismatch { found: 0, .. })
        ));
        conn.execute("INSERT INTO meta VALUES ('schema_version', '2')", [])
            .unwrap();
        assert!(matches!(
            CoreDb::open(&path),
            Err(CoreError::SchemaMismatch {
                expected: 1,
                found: 2
            })
        ));
        conn.execute(
            "UPDATE meta SET value = 'one' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        assert!(matches!(CoreDb::open(&path), Err(CoreError::Corrupt(_))));
        conn.execute(
            "UPDATE meta SET value = ' 1 ' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        let core = CoreDb::open(&path).unwrap();
        assert_eq!(
            core.meta(),
            &CoreMeta {
                schema_version: 1,
                normalizer_version: 1,
                source: String::new(),
                built_at: String::new(),
                word_count: 0,
            }
        );
    }

    #[test]
    fn missing_and_foreign_files_fail_fast() {
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let missing = CoreDb::open(&dir.path().join("nope.db")).unwrap_err();
        assert!(matches!(missing, CoreError::Sqlite(_)), "{missing:?}");
        let garbage = dir.path().join("garbage.db");
        std::fs::write(&garbage, vec![0x5a_u8; 8192]).unwrap();
        let err = CoreDb::open(&garbage).unwrap_err();
        assert!(err.is_corruption(), "{err:?}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "no pool retry loop"
        );
    }

    #[test]
    fn unavailable_handles_answer_not_found_everywhere() {
        let core = CoreDb::unavailable("test".into());
        assert!(!core.is_available());
        assert_eq!(core.meta().source, "unavailable");
        let not_found = |r: Result<()>| match r {
            Err(CoreError::NotFound(m)) => assert_eq!(m, UNAVAILABLE_MESSAGE),
            other => panic!("{other:?}"),
        };
        not_found(core.conn().map(drop));
        not_found(core.index().map(drop));
        not_found(core.pages(MushafStyle::Hafs, &[1]).map(drop));
        not_found(core.ayahs(MushafLayout::V2, 1, 7).map(drop));
        not_found(core.copy_text(1, 7, &copy_opts()).map(drop));
        not_found(core.page_of_ayah(MushafLayout::V1, 1).map(drop));
        not_found(core.word_range_of_ayah(1).map(drop));
        not_found(core.word_ids_by_location(&[(1, 1, 1)]).map(drop));
        // An empty lookup needs no database.
        assert_eq!(core.word_ids_by_location(&[]).unwrap(), Vec::new());
    }

    #[test]
    fn arguments_are_validated_before_any_io() {
        let core = CoreDb::unavailable("test".into());
        let invalid =
            |r: Result<()>| assert!(matches!(r, Err(CoreError::InvalidArgument(_))), "{r:?}");
        invalid(core.pages(MushafStyle::Hafs, &[]).map(drop));
        invalid(core.pages(MushafStyle::Hafs, &[1; 9]).map(drop));
        invalid(core.pages(MushafStyle::QcfV1, &[0]).map(drop));
        invalid(core.pages(MushafStyle::QcfV4, &[3, 605]).map(drop));
        invalid(core.ayahs(MushafLayout::V2, 0, 7).map(drop));
        invalid(core.ayahs(MushafLayout::V2, 8, 7).map(drop));
        invalid(core.ayahs(MushafLayout::V2, 1, 6237).map(drop));
        invalid(core.ayahs(MushafLayout::V2, 1, 301).map(drop));
        invalid(core.copy_text(0, 1, &copy_opts()).map(drop));
        invalid(core.copy_text(7, 1, &copy_opts()).map(drop));
        invalid(core.page_of_ayah(MushafLayout::V2, 6237).map(drop));
        invalid(core.word_range_of_ayah(0).map(drop));
        // The largest window is accepted (and then needs the database).
        assert!(matches!(
            core.ayahs(MushafLayout::V2, 1, 300),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            core.pages(MushafStyle::Hafs, &[1, 2, 3, 4, 5, 6, 7, 604]),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn sajda_values_decode() {
        assert_eq!(sajda_kind(0, 1).unwrap(), None);
        assert_eq!(sajda_kind(1, 1).unwrap(), Some(SajdaKind::Recommended));
        assert_eq!(sajda_kind(2, 1).unwrap(), Some(SajdaKind::Obligatory));
        assert!(matches!(sajda_kind(3, 1), Err(CoreError::Corrupt(_))));
    }

    #[test]
    fn handles_are_send_sync_and_debug() {
        fn check<T: Send + Sync + Clone + std::fmt::Debug>() {}
        check::<CoreDb>();
        let text = format!("{:?}", CoreDb::unavailable("x".into()));
        assert!(text.contains("available: false"), "{text}");
    }

    #[test]
    fn opens_the_mini_core_and_caches_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let core = CoreDb::open(&mini.path).unwrap();
        assert!(core.is_available());
        assert_eq!(
            core.meta(),
            &CoreMeta {
                schema_version: 1,
                normalizer_version: NORMALIZER_VERSION,
                source: mini_core::SOURCE.to_owned(),
                built_at: mini_core::BUILT_AT.to_owned(),
                word_count: mini.word_count(),
            }
        );
        let first = core.index().unwrap();
        assert!(core.index.get().is_some());
        let clone = core.clone();
        assert_eq!(clone.index().unwrap(), first, "clones share the cache");
        // The connection is read-only.
        let conn = core.conn().unwrap();
        assert!(conn.execute("DELETE FROM meta", []).is_err());
        let norm: String = conn
            .query_row("SELECT ar_norm('الصَّلَاةَ')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(norm, "الصلاه", "ar_norm is registered on pooled connections");
    }

    #[test]
    fn concurrent_readers_share_the_pool() {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let core = CoreDb::open(&mini.path).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let core = core.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        let style = MushafStyle::ALL[i % 4];
                        let pages = core.pages(style, &[1, 2, 3, 4]).unwrap();
                        assert_eq!(pages.len(), 4);
                        assert_eq!(core.index().unwrap().surahs.len(), 3);
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
    }
}
