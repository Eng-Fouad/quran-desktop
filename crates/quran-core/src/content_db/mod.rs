//! `ContentDb`: QF-sourced runtime content with per-row `pinned` flags (docs/ARCHITECTURE.md §2.2.7, §3.3, D20).
//! Owner: WP1c.
//!
//! content.db holds QDC timings (`timing_file` + `timing_ayah`), Quran.com tafsir (`tafsir_entry`) and word-by-word
//! rows (`wbw`) with their per-chapter revalidation stamps (`content_chapter`), plus a disposable JSON cache (`kv`).
//!
//! Not disposable as a whole: rows with `pinned = 1` back installed packs and pinned audio and survive "Clear cache"
//! ([`ContentDb::clear_unpinned`]); stream-only rows and `kv` are disposable. A corrupt or unreadable file is
//! quarantined and recreated ([`ContentDb::open_or_recover`]); installed packs then re-sync to `partial` (§2.5.5). A
//! file written by a newer version of the app is refused ([`CoreError::NewerSchema`]) and left untouched, so a
//! downgrade never costs pinned timings and chapters.
//!
//! One connection behind a `Mutex` (single writer, no `SQLITE_BUSY`); every multi-row write is one transaction. The
//! methods are spread over `timings.rs`, `wbw.rs`, `tafsir.rs`, `kv.rs` and `clear.rs`; chapter → id-range mapping
//! lives in [`geometry`].

mod clear;
pub mod geometry;
mod kv;
mod tafsir;
mod timings;
mod wbw;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, ErrorCode, params};
use rusqlite_migration::{M, Migrations};

pub use self::timings::TimingStamp;
use crate::{CoreError, Result};

/// Single-writer handle on content.db. `Clone + Send + Sync`; call it from `spawn_blocking`.
#[derive(Clone)]
pub struct ContentDb {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

/// Presence and revalidation stamp of one WBW/tafsir chapter (`content_chapter`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChapterStamp {
    pub surah: u32,
    pub fetched_at_ms: i64,
    /// sha256 of the upstream payload (revalidation compares it).
    pub sha256: String,
    /// The pack is installed with scope `All`.
    pub pinned: bool,
}

/// What [`ContentDb::clear_unpinned`] removed, so `PackManager` can re-sync `installed_pack` (§2.5.5).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClearReport {
    /// `(reciter_id, surah)` of every removed timing file.
    pub timings: Vec<(u32, u32)>,
    /// `(pack_id, surah)` of every removed chapter.
    pub chapters: Vec<(String, u32)>,
    /// Payload of the removed rows: TEXT/BLOB octets plus 8 bytes per INTEGER value (file pages are not counted).
    pub bytes: u64,
}

/// One `tafsir_entry` row: an ayah range and its sanitised HTML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TafsirRow {
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub html: String,
}

/// An item due for revalidation (§2.5.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleItem {
    pub kind: StaleKind,
    /// The pack id (`audio.qdc.{reciter}` for timings).
    pub pack_id: String,
    pub surah: u32,
    /// Set for [`StaleKind::Timings`].
    pub reciter_id: Option<u32>,
}

/// What a [`StaleItem`] refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StaleKind {
    Timings,
    Tafsir,
    Wbw,
}

/// The content.db migrations, oldest first: `schema/content.sql` is migration 1 (D20). Append-only.
const MIGRATIONS: [&str; 1] = [crate::CONTENT_SQL];

/// [`MIGRATIONS`] for rusqlite_migration.
fn migrations() -> Migrations<'static> {
    Migrations::new(MIGRATIONS.iter().map(|sql| M::up(sql)).collect())
}

impl ContentDb {
    /// Opens (creating it and its directory if needed) content.db: `journal_mode=WAL`, `synchronous=NORMAL`,
    /// `busy_timeout=5000`, `temp_store=MEMORY`, then the migrations to the latest version and
    /// `PRAGMA optimize=0x10002`.
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_checked(path, false)
    }

    /// [`ContentDb::open`], with a `quick_check` before anything (`optimize`) can write to an existing file.
    fn open_checked(path: &Path, check: bool) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        // Reads the header only: a file that is not a database fails here (corruption), and one from a newer version of
        // the app is refused before journal_mode, the migrations or optimize can write to it.
        crate::migrate::refuse_newer(&conn, MIGRATIONS.len())?;
        let mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            log::warn!("content.db: journal_mode is {mode}, not wal");
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        crate::migrate::to_latest(&mut conn, &migrations(), MIGRATIONS.len())?;
        if check {
            quick_check(&conn)?;
        }
        conn.execute_batch("PRAGMA optimize = 0x10002;")?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// [`ContentDb::open`]; when the file is corrupt (`SQLITE_CORRUPT`/`SQLITE_NOTADB`, a failed `quick_check`) or its
    /// schema cannot be migrated (a foreign schema), the file and its `-wal`/`-shm`/`-journal` sidecars are renamed to
    /// `content.db.corrupt-{unix_ms}` (sidecars keep their suffix, so the quarantined copy stays openable) and a fresh
    /// database is opened. Returns the quarantined path, if any. Never fatal for corruption: only environmental
    /// failures (permissions, disk full, a locked file), a file from a newer version of the app
    /// ([`CoreError::NewerSchema`], left untouched) and failing to create the fresh database are errors. No banner is
    /// shown for content.db; installed packs re-sync to `partial` (§2.5.5).
    pub fn open_or_recover(path: &Path) -> Result<(Self, Option<PathBuf>)> {
        match Self::open_checked(path, true) {
            Ok(db) => Ok((db, None)),
            Err(e) if needs_quarantine(&e) => {
                let quarantined = quarantine(path)?;
                log::warn!(
                    "content.db was unusable ({e}); quarantined as {} and recreated",
                    file_name(&quarantined)
                );
                let db = Self::open(path)?;
                Ok((db, Some(quarantined)))
            }
            Err(e) => Err(e),
        }
    }

    /// WBW/tafsir presence + `fetched_at` + `pinned` for every chapter of `pack_id`, by surah.
    pub fn chapters(&self, pack_id: &str) -> Result<Vec<ChapterStamp>> {
        self.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT surah, fetched_at, sha256, pinned FROM content_chapter WHERE pack_id = ?1 ORDER BY surah",
            )?;
            let rows = stmt
                .query_map([pack_id], |r| {
                    Ok(ChapterStamp {
                        surah: r.get(0)?,
                        fetched_at_ms: r.get(1)?,
                        sha256: r.get(2)?,
                        pinned: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Pack installed with scope `All` ⇒ pinned (every chapter of `pack_id`, present now). Chapters stored later carry
    /// their own stamp's `pinned`.
    pub fn chapters_set_pinned(&self, pack_id: &str, pinned: bool) -> Result<()> {
        self.with(|c| {
            c.prepare_cached("UPDATE content_chapter SET pinned = ?2 WHERE pack_id = ?1")?
                .execute(params![pack_id, pinned])?;
            Ok(())
        })
    }

    /// Every pack id that has at least one WBW/tafsir chapter, sorted (the content.db side of the re-sync, §2.5.5).
    pub fn chapter_pack_ids(&self) -> Result<Vec<String>> {
        self.with(|c| {
            let mut stmt =
                c.prepare_cached("SELECT DISTINCT pack_id FROM content_chapter ORDER BY pack_id")?;
            let ids = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(ids)
        })
    }

    /// Revalidator input (§2.5.7): every timing file and WBW/tafsir chapter fetched before `older_than_ms` (Unix ms),
    /// oldest first. Chapters are classified by pack id (`wbw.*` → [`StaleKind::Wbw`], `tafsir.*` →
    /// [`StaleKind::Tafsir`], §2.5.3); timings carry `audio.{source}.{reciter}` (`audio.qdc.7`).
    pub fn stale(&self, older_than_ms: i64) -> Result<Vec<StaleItem>> {
        self.with(|c| {
            let mut items: Vec<(i64, StaleItem)> = Vec::new();
            let mut stmt = c.prepare_cached(
                "SELECT reciter_id, surah, source, fetched_at FROM timing_file WHERE fetched_at < ?1",
            )?;
            let timings = stmt.query_map([older_than_ms], |r| {
                let reciter: u32 = r.get(0)?;
                let source: String = r.get(2)?;
                Ok((
                    r.get::<_, i64>(3)?,
                    StaleItem {
                        kind: StaleKind::Timings,
                        pack_id: format!("audio.{source}.{reciter}"),
                        surah: r.get(1)?,
                        reciter_id: Some(reciter),
                    },
                ))
            })?;
            for t in timings {
                items.push(t?);
            }
            let mut stmt = c.prepare_cached(
                "SELECT pack_id, surah, fetched_at FROM content_chapter WHERE fetched_at < ?1",
            )?;
            let chapters = stmt.query_map([older_than_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in chapters {
                let (pack_id, surah, fetched_at) = row?;
                let Some(kind) = chapter_kind(&pack_id) else {
                    log::warn!("content.db: chapter {surah} of unknown pack kind {pack_id:?} skipped");
                    continue;
                };
                items.push((
                    fetched_at,
                    StaleItem {
                        kind,
                        pack_id,
                        surah,
                        reciter_id: None,
                    },
                ));
            }
            items.sort_by(|(ta, a), (tb, b)| {
                ta.cmp(tb)
                    .then_with(|| a.pack_id.cmp(&b.pack_id))
                    .then_with(|| a.surah.cmp(&b.surah))
            });
            Ok(items.into_iter().map(|(_, item)| item).collect())
        })
    }

    /// Removes everything content.db holds for a pack, pinned or not, in one transaction: its WBW rows, tafsir
    /// entries and chapter stamps; for a recitation pack (`audio.{source}.{reciter}`, e.g. `audio.qdc.7`) every timing
    /// of that reciter from that source.
    pub fn delete_pack(&self, pack_id: &str) -> Result<()> {
        self.with_tx(|tx| {
            tx.execute("DELETE FROM wbw WHERE pack_id = ?1", [pack_id])?;
            tx.execute("DELETE FROM tafsir_entry WHERE pack_id = ?1", [pack_id])?;
            tx.execute("DELETE FROM content_chapter WHERE pack_id = ?1", [pack_id])?;
            if let Some((source, reciter)) = recitation_pack(pack_id) {
                tx.execute(
                    "DELETE FROM timing_ayah WHERE (reciter_id, surah) IN
                       (SELECT reciter_id, surah FROM timing_file WHERE reciter_id = ?1 AND source = ?2)",
                    params![reciter, source],
                )?;
                tx.execute(
                    "DELETE FROM timing_file WHERE reciter_id = ?1 AND source = ?2",
                    params![reciter, source],
                )?;
            }
            Ok(())
        })
    }

    /// Removes one chapter of a `wbw.*` or `tafsir.*` pack, pinned or not, in one transaction: its WBW rows (the
    /// surah's word ids) or tafsir entries (starting in the surah), and its `content_chapter` stamp. The pack's other
    /// chapters are untouched. Returns whether the chapter was stored (a stamp existed); deleting a missing chapter is a
    /// no-op.
    pub fn delete_chapter(&self, pack_id: &str, surah: u32) -> Result<bool> {
        let (Some(words), Some(ayahs)) = (
            geometry::surah_word_ids(surah),
            geometry::surah_ayah_ids(surah),
        ) else {
            return Err(CoreError::InvalidArgument(format!(
                "surah {surah} is outside 1..=114"
            )));
        };
        self.with_tx(|tx| {
            tx.prepare_cached("DELETE FROM wbw WHERE pack_id = ?1 AND word_id BETWEEN ?2 AND ?3")?
                .execute(params![pack_id, words.start(), words.end()])?;
            tx.prepare_cached(
                "DELETE FROM tafsir_entry WHERE pack_id = ?1 AND from_ayah_id BETWEEN ?2 AND ?3",
            )?
            .execute(params![pack_id, ayahs.start(), ayahs.end()])?;
            let stamps = tx
                .prepare_cached("DELETE FROM content_chapter WHERE pack_id = ?1 AND surah = ?2")?
                .execute(params![pack_id, surah])?;
            Ok(stamps > 0)
        })
    }

    /// Runs `f` on the connection (lock held for the duration).
    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.lock();
        f(&conn)
    }

    /// Runs `f` inside one `IMMEDIATE` transaction; commits on `Ok`, rolls back on `Err`.
    fn with_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// A panic while the lock was held cannot leave SQLite half-written (every write is a transaction), so a poisoned
    /// lock is recovered instead of propagated.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `wbw.*` and `tafsir.*` chapter packs (§2.5.3 ids).
fn chapter_kind(pack_id: &str) -> Option<StaleKind> {
    if pack_id.starts_with("wbw.") {
        Some(StaleKind::Wbw)
    } else if pack_id.starts_with("tafsir.") {
        Some(StaleKind::Tafsir)
    } else {
        None
    }
}

/// `audio.{source}.{reciter}` → `(source, reciter)`.
fn recitation_pack(pack_id: &str) -> Option<(&str, u32)> {
    let rest = pack_id.strip_prefix("audio.")?;
    let (source, reciter) = rest.split_once('.')?;
    if source.is_empty() {
        return None;
    }
    Some((source, reciter.parse().ok()?))
}

/// Unix time in milliseconds (0 before 1970, saturating far in the future).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `PRAGMA quick_check`: `Corrupt` unless SQLite reports `ok`.
fn quick_check(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let problems = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    match problems.as_slice() {
        [ok] if ok == "ok" => Ok(()),
        _ => Err(CoreError::Corrupt(format!(
            "content.db quick_check: {}",
            problems.join("; ")
        ))),
    }
}

/// Whether `open`/`quick_check` failed because of the file itself (corrupt, not a database, a foreign schema this
/// build cannot migrate), as opposed to the environment (permissions, disk, locks), which a rename would not fix, or a
/// newer version of the app (`NewerSchema`), whose file must survive a downgrade untouched.
fn needs_quarantine(e: &CoreError) -> bool {
    if e.is_corruption() {
        return true;
    }
    match e {
        CoreError::Migration(rusqlite_migration::Error::RusqliteError { err, .. }) => {
            !is_environmental(err)
        }
        CoreError::Migration(_) if crate::migrate::is_too_far_ahead(e) => false,
        CoreError::Migration(_) => true,
        _ => false,
    }
}

/// SQLite failures caused by the environment rather than the file's content.
fn is_environmental(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(
            ErrorCode::CannotOpen
                | ErrorCode::ReadOnly
                | ErrorCode::DiskFull
                | ErrorCode::SystemIoFailure
                | ErrorCode::PermissionDenied
                | ErrorCode::DatabaseBusy
                | ErrorCode::DatabaseLocked
                | ErrorCode::OutOfMemory
                | ErrorCode::FileLockingProtocolFailed
                | ErrorCode::OperationInterrupted
        )
    )
}

/// Renames `path` and its sidecars out of the way; returns the quarantined main path.
fn quarantine(path: &Path) -> Result<PathBuf> {
    let name = file_name(path);
    let dir = path.parent().unwrap_or_else(|| Path::new(""));
    let stamp = now_ms();
    let mut target = dir.join(format!("{name}.corrupt-{stamp}"));
    let mut n = 1u32;
    while target.exists() {
        target = dir.join(format!("{name}.corrupt-{stamp}-{n}"));
        n = n.saturating_add(1);
    }
    if path.exists() {
        std::fs::rename(path, &target)?;
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let side = sidecar(path, suffix);
        if side.exists() {
            std::fs::rename(&side, sidecar(&target, suffix))?;
        }
    }
    Ok(target)
}

/// `content.db` + `-wal` → `content.db-wal`.
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// The file name only (logs never carry the user's home path).
fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || "content.db".to_owned(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/// Upserts a chapter stamp; `pinned` only ever goes up here (a refetch never unpins an installed pack's chapter).
fn upsert_chapter(
    tx: &rusqlite::Transaction<'_>,
    pack_id: &str,
    stamp: &ChapterStamp,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO content_chapter (pack_id, surah, fetched_at, sha256, pinned) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (pack_id, surah) DO UPDATE SET fetched_at = excluded.fetched_at, sha256 = excluded.sha256,
           pinned = max(content_chapter.pinned, excluded.pinned)",
    )?
    .execute(params![pack_id, stamp.surah, stamp.fetched_at_ms, stamp.sha256, stamp.pinned])?;
    Ok(())
}

/// Shared argument checks of the chapter writers.
fn check_chapter(pack_id: &str, surah: u32, stamp: &ChapterStamp) -> Result<()> {
    if pack_id.trim().is_empty() {
        return Err(CoreError::InvalidArgument("empty pack id".into()));
    }
    if geometry::surah_ayah_ids(surah).is_none() {
        return Err(CoreError::InvalidArgument(format!(
            "surah {surah} is outside 1..=114"
        )));
    }
    if stamp.surah != surah {
        return Err(CoreError::InvalidArgument(format!(
            "chapter stamp is for surah {}, rows are for surah {surah}",
            stamp.surah
        )));
    }
    Ok(())
}

/// Maps a primary-key violation of a bulk insert to `InvalidArgument` with `what`, other errors unchanged.
fn duplicate(e: rusqlite::Error, what: impl FnOnce() -> String) -> CoreError {
    if e.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
        CoreError::InvalidArgument(what())
    } else {
        CoreError::Sqlite(e)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use super::*;

    #[test]
    fn pack_id_parsing() {
        assert_eq!(chapter_kind("wbw.en"), Some(StaleKind::Wbw));
        assert_eq!(
            chapter_kind("tafsir.en.ibn_kathir"),
            Some(StaleKind::Tafsir)
        );
        assert_eq!(chapter_kind("tr.en.saheeh"), None);
        assert_eq!(recitation_pack("audio.qdc.7"), Some(("qdc", 7)));
        assert_eq!(recitation_pack("audio.qdc.x"), None);
        assert_eq!(recitation_pack("audio..7"), None);
        assert_eq!(recitation_pack("wbw.en"), None);
    }

    #[test]
    fn sidecars_keep_their_suffix() {
        let p = Path::new("dir").join("content.db.corrupt-5");
        assert_eq!(
            sidecar(&p, "-wal"),
            Path::new("dir").join("content.db.corrupt-5-wal")
        );
        assert_eq!(file_name(&p), "content.db.corrupt-5");
    }

    #[test]
    fn environmental_failures_are_not_quarantined() {
        let sqlite = |code| rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None);
        let mig = |code| {
            CoreError::Migration(rusqlite_migration::Error::RusqliteError {
                query: String::new(),
                err: sqlite(code),
            })
        };
        assert!(needs_quarantine(&CoreError::Sqlite(sqlite(
            rusqlite::ffi::SQLITE_NOTADB
        ))));
        assert!(needs_quarantine(&CoreError::Corrupt("quick_check".into())));
        assert!(needs_quarantine(&mig(rusqlite::ffi::SQLITE_ERROR)));
        assert!(!needs_quarantine(&mig(rusqlite::ffi::SQLITE_FULL)));
        assert!(!needs_quarantine(&mig(rusqlite::ffi::SQLITE_READONLY)));
        assert!(!needs_quarantine(&CoreError::Sqlite(sqlite(
            rusqlite::ffi::SQLITE_CANTOPEN
        ))));
        assert!(!needs_quarantine(&CoreError::Io(std::io::Error::other(
            "x"
        ))));
        // A newer version's file is intact: never quarantined, in either form.
        assert!(!needs_quarantine(&CoreError::NewerSchema {
            found: 2,
            supported: 1
        }));
        assert!(!needs_quarantine(&CoreError::Migration(
            rusqlite_migration::Error::MigrationDefinition(
                rusqlite_migration::MigrationDefinitionError::DatabaseTooFarAhead
            )
        )));
        assert!(needs_quarantine(&CoreError::Migration(
            rusqlite_migration::Error::MigrationDefinition(
                rusqlite_migration::MigrationDefinitionError::NoMigrationsDefined
            )
        )));
    }

    #[test]
    fn quarantine_moves_the_file_and_its_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("content.db");
        std::fs::write(&path, "main").unwrap();
        std::fs::write(sidecar(&path, "-wal"), "wal").unwrap();
        std::fs::write(sidecar(&path, "-journal"), "journal").unwrap();
        let q = quarantine(&path).unwrap();
        assert!(
            !path.exists()
                && !sidecar(&path, "-wal").exists()
                && !sidecar(&path, "-journal").exists()
        );
        assert!(file_name(&q).starts_with("content.db.corrupt-"));
        assert_eq!(std::fs::read_to_string(&q).unwrap(), "main");
        assert_eq!(std::fs::read_to_string(sidecar(&q, "-wal")).unwrap(), "wal");
        assert_eq!(
            std::fs::read_to_string(sidecar(&q, "-journal")).unwrap(),
            "journal"
        );
        assert!(!sidecar(&q, "-shm").exists());
        // Quarantining again (possibly within the same millisecond) never overwrites the first copy.
        std::fs::write(&path, "again").unwrap();
        let q2 = quarantine(&path).unwrap();
        assert_ne!(q, q2);
        assert_eq!(std::fs::read_to_string(&q).unwrap(), "main");
        assert_eq!(std::fs::read_to_string(&q2).unwrap(), "again");
    }

    #[test]
    fn open_is_idempotent_and_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("content.db");
        drop(ContentDb::open(&path).unwrap());
        let db = ContentDb::open(&path).unwrap();
        let (version, mode): (i64, String) = db
            .with(|c| {
                Ok((
                    c.query_row("PRAGMA user_version", [], |r| r.get(0))?,
                    c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!(version, 1);
        assert_eq!(mode, "wal");
        db.with(quick_check).unwrap();
    }
}
