//! `UserDb`: the read-write user.db (docs/ARCHITECTURE.md §2.2.6, §3.2). Owner: WP2b (this file and
//! migrations/positions/history/search_history/memo/presets/settings/packs/backup); WP2a owns bookmarks, highlights,
//! notes, collections, tags and marks. Methods live in `impl UserDb` blocks spread over those files, so the two packages
//! never share a file.
//!
//! - **One writer.** A single `rusqlite::Connection` behind a `Mutex`, so there is no `SQLITE_BUSY` between our own
//!   writers. Every write is its own transaction; multi-row writes use [`UserDb::with_tx`].
//! - **Timestamps.** Stored as Unix **milliseconds** (`INTEGER`), sent over IPC as `u32` Unix **seconds** (§0.2, §3).
//!   The helpers below ([`UserDb::now_ms`], [`ms_to_secs`], …) are shared with WP2a's files.
//! - **Recovery.** [`UserDb::open_or_recover`] quarantines a corrupt file and starts fresh; it is never fatal for
//!   corruption (§2.2.6, §9.8). A library written by a newer version of the app is not corrupt: it is refused with
//!   [`CoreError::NewerSchema`] and left exactly as it is (docs/deviations/INTEGRATION.md).

mod backup;
mod bookmarks;
mod collections;
mod highlights;
mod history;
mod marks;
mod memo;
mod migrations;
mod notes;
mod packs;
mod positions;
mod presets;
mod search_history;
mod settings;
mod tags;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use quran_types::{AYAH_COUNT, MushafLayout, PAGE_COUNT};
use rusqlite::{Connection, ErrorCode, OpenFlags};

pub use memo::{MAX_STRENGTH, MEMORIZED_STRENGTH, MemoSchedule, schedule_review};
pub use packs::{InstalledPackRow, InstalledStatus, PackItemRow};
pub use settings::{RESET_PRESERVED_KEYS, SETTING_FIELDS, SettingField};

use crate::{CoreError, Result};

/// Tombstones older than this many days are purged once at open (§3.2).
pub const TOMBSTONE_RETENTION_DAYS: u32 = 30;

/// One day in milliseconds.
pub(crate) const DAY_MS: i64 = 86_400_000;

/// Prepared statements kept per connection: more than the distinct `prepare_cached` statements of the user_db modules.
const STATEMENT_CACHE_CAPACITY: usize = 128;

/// How long a statement waits for a lock another process holds on user.db (`busy_timeout`) before `SQLITE_BUSY`.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// Sentinel of [`Clock`]: follow the system clock.
const SYSTEM_TIME: i64 = i64::MIN;

/// The time source of a [`UserDb`] (shared by its clones). Production always reads the system clock; tests may pin it
/// with [`UserDb::set_test_clock`] so that schedules and dedupe windows are exact.
#[derive(Debug)]
struct Clock(AtomicI64);

impl Clock {
    fn now_ms(&self) -> i64 {
        match self.0.load(Ordering::Relaxed) {
            SYSTEM_TIME => system_now_ms(),
            fixed => fixed,
        }
    }
}

/// The system clock in Unix milliseconds; 0 for a clock set before 1970.
fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The single writer on user.db behind a `Mutex` (no `SQLITE_BUSY`). `Clone + Send + Sync`; call it from
/// `spawn_blocking`. Every write is its own transaction; multi-row writes use [`UserDb::with_tx`].
#[derive(Clone)]
pub struct UserDb {
    conn: Arc<Mutex<Connection>>,
    clock: Arc<Clock>,
}

impl std::fmt::Debug for UserDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserDb").finish_non_exhaustive()
    }
}

impl UserDb {
    /// `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `MIGRATIONS.to_latest`,
    /// `PRAGMA optimize=0x10002`, registers `ar_norm()`. Runs `purge_tombstones(30)` once at open.
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_checked(path, false)
    }

    /// `open()`; on `SQLITE_CORRUPT`/`NOTADB`, a failed `quick_check`, or a failed migration: close, rename the file (and
    /// `-wal`/`-shm`) to `user.db.corrupt-{unix_ms}`, open a fresh DB, and return the quarantined path so the UI shows a
    /// recovery banner (§9.8). Never fatal for corruption; only failing to open the fresh DB is an error.
    ///
    /// Transient failures (locked or busy file, permissions, disk full, I/O errors) are returned as errors and never
    /// quarantine a healthy file. Neither is a library from a newer version of the app (a downgrade): that is
    /// [`CoreError::NewerSchema`], returned before anything wrote to the file, so updating the app opens it again.
    pub fn open_or_recover(path: &Path) -> Result<(Self, Option<PathBuf>)> {
        match Self::open_checked(path, true) {
            Ok(db) => Ok((db, None)),
            Err(e) if needs_quarantine(&e) => {
                log::error!(
                    "user.db is unusable ({e}); quarantining it and starting a fresh library"
                );
                let quarantined = quarantine(path)?;
                let db = Self::open_checked(path, false)?;
                Ok((db, Some(quarantined)))
            }
            Err(e) => Err(e),
        }
    }

    /// Opens (creating if needed) and prepares the database. `quick_check` additionally runs `PRAGMA quick_check`
    /// before the migrations (the recovery path).
    fn open_checked(path: &Path, quick_check: bool) -> Result<Self> {
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // The first statement reads the header: a file that is not a database fails here (corruption), and a library
        // from a newer version of the app is refused before journal_mode, the migrations or optimize can write to it.
        crate::migrate::refuse_newer(&conn, crate::USER_MIGRATIONS.len())?;
        let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            log::warn!("user.db: journal_mode is {mode}, not wal");
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        if quick_check {
            run_quick_check(&conn)?;
        }
        crate::migrate::to_latest(
            &mut conn,
            &migrations::migrations(),
            crate::USER_MIGRATIONS.len(),
        )?;
        conn.execute_batch("PRAGMA optimize=0x10002;")?;
        crate::normalize::register_ar_norm(&conn)?;
        // The user_db modules hold about 90 distinct `prepare_cached` statements; rusqlite's default LRU of 16 would
        // re-prepare hot paths (e.g. the 5 statements of `user_marks`) after unrelated calls evicted them.
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            clock: Arc::new(Clock(AtomicI64::new(SYSTEM_TIME))),
        };
        let purged = db.purge_tombstones(TOMBSTONE_RETENTION_DAYS)?;
        if purged > 0 {
            log::info!(
                "user.db: purged {purged} tombstones older than {TOMBSTONE_RETENTION_DAYS} days"
            );
        }
        Ok(db)
    }

    /// Runs `f` on the connection (lock held for the duration).
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.lock();
        f(&conn)
    }

    /// Runs `f` inside one transaction; commits on `Ok`, rolls back on `Err`.
    pub fn with_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Hard-deletes tombstoned library rows (bookmarks, highlights, notes, collections, tags) whose `deleted_at` is
    /// older than `older_than_days`, plus the tag links of purged items (`collection_item` rows cascade). Returns the
    /// number of library rows removed. Runs once at open with [`TOMBSTONE_RETENTION_DAYS`].
    pub fn purge_tombstones(&self, older_than_days: u32) -> Result<u32> {
        let cutoff = self
            .now_ms()
            .saturating_sub(i64::from(older_than_days).saturating_mul(DAY_MS));
        self.with_tx(|tx| {
            let mut removed: usize = 0;
            for table in ["bookmark", "highlight", "note", "collection", "tag"] {
                removed += tx.execute(
                    &format!("DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?1"),
                    [cutoff],
                )?;
            }
            if removed > 0 {
                // item_tag has no foreign key to the tagged item (it is polymorphic): drop links to purged items.
                tx.execute_batch(
                    "DELETE FROM item_tag WHERE item_kind = 'bookmark' AND item_id NOT IN (SELECT id FROM bookmark);
                     DELETE FROM item_tag WHERE item_kind = 'note' AND item_id NOT IN (SELECT id FROM note);
                     DELETE FROM item_tag WHERE item_kind = 'highlight' AND item_id NOT IN (SELECT id FROM highlight);",
                )?;
            }
            Ok(u32::try_from(removed).unwrap_or(u32::MAX))
        })
    }

    /// The current time in Unix milliseconds (the stored timestamp unit). Shared by every `user_db` file.
    #[must_use]
    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    /// Test hook: pins this handle's clock (and every clone's) to `unix_ms`, or back to the system clock with `None`.
    /// Production code never calls it.
    #[doc(hidden)]
    pub fn set_test_clock(&self, unix_ms: Option<i64>) {
        // `i64::MIN` is the "system time" sentinel; a pinned clock can never need it.
        let value = unix_ms.map_or(SYSTEM_TIME, |ms| ms.max(SYSTEM_TIME + 1));
        self.clock.0.store(value, Ordering::Relaxed);
    }

    /// A panic while the lock was held cannot leave SQLite half-written (every write is a transaction), so a poisoned
    /// lock is recovered instead of propagated.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// ---- shared helpers (also used by WP2a's files)

/// Stored milliseconds → IPC seconds (§0.2). Negative values (a clock before 1970) become 0; far-future values saturate.
#[must_use]
pub(crate) fn ms_to_secs(ms: i64) -> u32 {
    u32::try_from(ms.max(0) / 1000).unwrap_or(u32::MAX)
}

/// [`ms_to_secs`] for nullable columns.
#[must_use]
pub(crate) fn opt_ms_to_secs(ms: Option<i64>) -> Option<u32> {
    ms.map(ms_to_secs)
}

/// A new UUIDv7 id for a user entity (§3.2, sync-ready).
#[must_use]
#[allow(
    dead_code,
    reason = "the id generator of WP2a's library files (bookmarks, highlights, notes, collections, tags)"
)]
pub(crate) fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// A stored integer column as `u32`; anything else means the row was not written by this crate.
pub(crate) fn col_u32(value: i64, column: &str) -> Result<u32> {
    u32::try_from(value)
        .map_err(|_| CoreError::Corrupt(format!("{column} = {value} is out of range")))
}

/// Nullable variant of [`col_u32`].
pub(crate) fn opt_col_u32(value: Option<i64>, column: &str) -> Result<Option<u32>> {
    value.map(|v| col_u32(v, column)).transpose()
}

/// A stored `mushaf_id` as a layout; an unknown id (never written by this crate) reads as `None`.
#[must_use]
pub(crate) fn layout_from_db(mushaf_id: Option<i64>) -> Option<MushafLayout> {
    let id = u32::try_from(mushaf_id?).ok()?;
    let layout = MushafLayout::from_db_id(id);
    if layout.is_none() {
        log::warn!("user.db: unknown mushaf_id {id}; reading it as no layout");
    }
    layout
}

/// `ayah_id` must be 1..=6236.
pub(crate) fn check_ayah(ayah_id: u32, what: &str) -> Result<()> {
    if (1..=AYAH_COUNT).contains(&ayah_id) {
        Ok(())
    } else {
        Err(CoreError::InvalidArgument(format!(
            "{what} {ayah_id} is not an ayah id (1..={AYAH_COUNT})"
        )))
    }
}

/// `from..=to` must be a non-empty ayah range inside 1..=6236.
pub(crate) fn check_ayah_range(from: u32, to: u32) -> Result<()> {
    check_ayah(from, "from ayah")?;
    check_ayah(to, "to ayah")?;
    if from > to {
        return Err(CoreError::InvalidArgument(format!(
            "ayah range {from}..={to} is reversed"
        )));
    }
    Ok(())
}

/// `page` must be 1..=604 when present.
pub(crate) fn check_page(page: Option<u32>) -> Result<()> {
    match page {
        Some(p) if !(1..=PAGE_COUNT).contains(&p) => Err(CoreError::InvalidArgument(format!(
            "page {p} is out of range (1..={PAGE_COUNT})"
        ))),
        _ => Ok(()),
    }
}

// ---- recovery

/// Whether an open failure means the file itself is unusable (quarantine) rather than a transient condition or a
/// library from a newer version of the app (`NewerSchema`, which must survive a downgrade untouched).
fn needs_quarantine(e: &CoreError) -> bool {
    if e.is_corruption() {
        return true;
    }
    match e {
        // A failed migration means the schema cannot be brought up to date: quarantine, unless SQLite reported a
        // transient condition while running it.
        CoreError::Migration(rusqlite_migration::Error::RusqliteError { err, .. }) => {
            !is_transient(err)
        }
        // `open_checked` maps this to `NewerSchema`; should the raw form ever surface, it still means "newer", not
        // "broken".
        CoreError::Migration(_) if crate::migrate::is_too_far_ahead(e) => false,
        CoreError::Migration(_) => true,
        _ => false,
    }
}

/// SQLite failures that say nothing about the file's contents (retrying later may succeed).
fn is_transient(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(
            ErrorCode::DatabaseBusy
                | ErrorCode::DatabaseLocked
                | ErrorCode::CannotOpen
                | ErrorCode::ReadOnly
                | ErrorCode::PermissionDenied
                | ErrorCode::DiskFull
                | ErrorCode::SystemIoFailure
                | ErrorCode::OutOfMemory
                | ErrorCode::OperationInterrupted
                | ErrorCode::FileLockingProtocolFailed
        )
    )
}

/// `PRAGMA quick_check`; anything but a single `ok` row is corruption.
fn run_quick_check(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let problems = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    match problems.as_slice() {
        [ok] if ok == "ok" => Ok(()),
        _ => Err(CoreError::Corrupt(format!(
            "quick_check: {}",
            problems.into_iter().take(5).collect::<Vec<_>>().join("; ")
        ))),
    }
}

/// Renames `path` (and its `-wal`/`-shm` companions, so the copy stays readable) to `{name}.corrupt-{unix_ms}` and
/// returns the new path. The connection must already be closed.
fn quarantine(path: &Path) -> Result<PathBuf> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| {
            CoreError::InvalidArgument(format!("{} has no file name", path.display()))
        })?;
    let stamp = system_now_ms();
    let mut target = path.with_file_name(format!("{file_name}.corrupt-{stamp}"));
    let mut n = 1;
    while target.exists() {
        n += 1;
        target = path.with_file_name(format!("{file_name}.corrupt-{stamp}-{n}"));
    }
    std::fs::rename(path, &target)?;
    for suffix in ["-wal", "-shm"] {
        let companion = path.with_file_name(format!("{file_name}{suffix}"));
        if companion.exists() {
            let dest = target.with_file_name(format!(
                "{}{suffix}",
                target
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ));
            if let Err(e) = std::fs::rename(&companion, &dest) {
                // A stale -shm/-wal must not be applied to the fresh database: delete it if it cannot be moved.
                log::warn!("user.db: could not move {suffix} aside ({e}); deleting it");
                std::fs::remove_file(&companion)?;
            }
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn open_sets_the_pragmas_and_migrates() {
        let (_dir, db) = temp_db();
        db.with(|c| {
            let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
            assert_eq!(mode, "wal");
            let fk: i64 = c.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
            assert_eq!(fk, 1);
            let sync: i64 = c.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
            assert_eq!(sync, 1, "NORMAL");
            let busy: i64 = c.query_row("PRAGMA busy_timeout", [], |r| r.get(0))?;
            assert_eq!(busy, 5000);
            let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            assert_eq!(
                version,
                i64::try_from(crate::USER_MIGRATIONS.len()).unwrap()
            );
            let norm: String =
                c.query_row("SELECT ar_norm('الصَّلَاةَ')", [], |r| r.get(0))?;
            assert_eq!(norm, "الصلاه");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn helpers_convert_and_validate() {
        assert_eq!(ms_to_secs(-5), 0);
        assert_eq!(ms_to_secs(1_999), 1);
        assert_eq!(ms_to_secs(i64::MAX), u32::MAX);
        assert_eq!(opt_ms_to_secs(None), None);
        assert!(check_ayah(1, "a").is_ok() && check_ayah(6236, "a").is_ok());
        assert!(matches!(
            check_ayah(0, "a"),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(matches!(
            check_ayah(6237, "a"),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(check_ayah_range(5, 5).is_ok());
        assert!(matches!(
            check_ayah_range(6, 5),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(check_page(None).is_ok() && check_page(Some(604)).is_ok());
        assert!(matches!(
            check_page(Some(605)),
            Err(CoreError::InvalidArgument(_))
        ));
        assert_eq!(layout_from_db(Some(19)), Some(MushafLayout::V4));
        assert_eq!(layout_from_db(Some(3)), None);
        assert!(matches!(col_u32(-1, "x"), Err(CoreError::Corrupt(_))));
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert_eq!(uuid::Uuid::parse_str(&a).unwrap().get_version_num(), 7);
    }

    #[test]
    fn the_test_clock_is_shared_by_clones() {
        let (_dir, db) = temp_db();
        let clone = db.clone();
        db.set_test_clock(Some(1_000));
        assert_eq!(clone.now_ms(), 1_000);
        db.set_test_clock(None);
        assert!(clone.now_ms() > 1_700_000_000_000);
    }

    #[test]
    fn purge_removes_only_old_tombstones_and_their_tag_links() {
        let (_dir, db) = temp_db();
        let now = 100 * DAY_MS;
        db.set_test_clock(Some(now));
        db.with(|c| {
            c.execute_batch(&format!(
                "INSERT INTO bookmark (id, kind, ayah_id, created_at, updated_at, deleted_at) VALUES
                   ('old', 'ayah', 1, 0, 0, {old}), ('new', 'ayah', 2, 0, 0, {new}), ('live', 'ayah', 3, 0, 0, NULL);
                 INSERT INTO tag (id, name, created_at, updated_at) VALUES ('t', 'tag', 0, 0);
                 INSERT INTO item_tag (tag_id, item_kind, item_id) VALUES ('t', 'bookmark', 'old'), ('t', 'bookmark', 'new');",
                old = now - 31 * DAY_MS,
                new = now - 29 * DAY_MS,
            ))?;
            Ok(())
        })
        .unwrap();
        assert_eq!(db.purge_tombstones(30).unwrap(), 1);
        db.with(|c| {
            let ids: Vec<String> = c
                .prepare("SELECT id FROM bookmark ORDER BY id")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            assert_eq!(ids, ["live", "new"]);
            let links: i64 = c.query_row("SELECT count(*) FROM item_tag", [], |r| r.get(0))?;
            assert_eq!(links, 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(db.purge_tombstones(30).unwrap(), 0);
    }

    #[test]
    fn transient_errors_never_quarantine() {
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        );
        assert!(!needs_quarantine(&CoreError::Sqlite(busy)));
        let locked = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_LOCKED),
            None,
        );
        assert!(!needs_quarantine(&CoreError::Migration(
            rusqlite_migration::Error::RusqliteError {
                query: String::new(),
                err: locked
            }
        )));
        let notadb = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            None,
        );
        assert!(needs_quarantine(&CoreError::Sqlite(notadb)));
        assert!(needs_quarantine(&CoreError::Corrupt("quick_check".into())));
        assert!(needs_quarantine(&CoreError::Migration(
            rusqlite_migration::Error::MigrationDefinition(
                rusqlite_migration::MigrationDefinitionError::NoMigrationsDefined
            )
        )));
        // A library from a newer version of the app is intact: never quarantined, in either form.
        assert!(!needs_quarantine(&CoreError::NewerSchema {
            found: 2,
            supported: 1
        }));
        assert!(!needs_quarantine(&CoreError::Migration(
            rusqlite_migration::Error::MigrationDefinition(
                rusqlite_migration::MigrationDefinitionError::DatabaseTooFarAhead
            )
        )));
        assert!(!needs_quarantine(&CoreError::Io(std::io::Error::other(
            "disk"
        ))));
    }

    #[test]
    fn a_library_from_a_newer_version_is_refused_and_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("user.db");
        let latest = crate::USER_MIGRATIONS.len();
        let newer = i64::try_from(latest).unwrap() + 1;
        {
            let db = UserDb::open(&path).unwrap();
            db.memo_set_status(1, 7, quran_types::MemoStatus::Memorized)
                .unwrap();
            // What a future build's migration 000{latest + 1} would leave behind.
            db.with(|c| {
                c.execute_batch("CREATE TABLE from_the_future (x);")?;
                c.pragma_update(None, "user_version", newer)?;
                Ok(())
            })
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let expected = |e: &CoreError| {
            matches!(e, CoreError::NewerSchema { found, supported }
                if i64::from(*found) == newer && usize::try_from(*supported).unwrap() == latest)
        };
        let err = UserDb::open_or_recover(&path).unwrap_err();
        assert!(expected(&err), "{err}");
        assert!(
            err.to_string()
                .contains("newer version of Quran for Desktop"),
            "{err}"
        );
        let err = UserDb::open(&path).unwrap_err();
        assert!(expected(&err), "{err}");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "no fresh library, not a byte changed"
        );
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(!name.contains(".corrupt-"), "no quarantine: {name}");
        }

        // Every row is intact: standing in for the newer build, a version this build knows opens it unchanged.
        let conn = rusqlite::Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, newer);
        conn.pragma_update(None, "user_version", i64::try_from(latest).unwrap())
            .unwrap();
        drop(conn);
        let (db, quarantined) = UserDb::open_or_recover(&path).unwrap();
        assert!(quarantined.is_none());
        assert_eq!(db.memo_progress(1, 7).unwrap().len(), 7);
    }

    #[test]
    fn quarantine_moves_the_companions_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("user.db");
        for (name, bytes) in [
            ("user.db", &b"main"[..]),
            ("user.db-wal", b"wal"),
            ("user.db-shm", b"shm"),
        ] {
            std::fs::write(dir.path().join(name), bytes).unwrap();
        }
        let first = quarantine(&path).unwrap();
        let name = first.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("user.db.corrupt-"), "{name}");
        assert_eq!(std::fs::read(&first).unwrap(), b"main");
        assert_eq!(
            std::fs::read(dir.path().join(format!("{name}-wal"))).unwrap(),
            b"wal"
        );
        assert_eq!(
            std::fs::read(dir.path().join(format!("{name}-shm"))).unwrap(),
            b"shm"
        );
        assert!(!path.exists() && !dir.path().join("user.db-wal").exists());
        // A second quarantine within the same millisecond gets its own name.
        std::fs::write(&path, b"again").unwrap();
        let second = quarantine(&path).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"main");
        assert_eq!(std::fs::read(&second).unwrap(), b"again");
    }
}
