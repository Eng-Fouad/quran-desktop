//! Backups with `VACUUM INTO` (§2.2.6). Owner: WP2b.
//!
//! `backup_to(dest)` writes a compact, consistent copy while the app keeps running:
//! 0. refuse a `dest` that is the live database or one of its `-wal`/`-shm`/`-journal` companions (step 3 would
//!    replace the open file and delete its WAL and shared-memory index while the connection still uses them; on
//!    macOS and Linux both succeed, and every later write goes to an unlinked file);
//! 1. `VACUUM INTO` a temporary sibling `{dest}.tmp-{unix_ms}` (VACUUM INTO refuses to overwrite, and a half-written
//!    file must never replace a good backup);
//! 2. open the copy read-only and verify it (`PRAGMA quick_check`, the schema version);
//! 3. delete stale `{dest}-wal`/`{dest}-shm` companions of a previous backup, then rename the copy over `dest` (an
//!    existing file is replaced; on Windows `MoveFileExW(REPLACE_EXISTING)`).
//!
//! The temporary file is removed on any failure. The copy is a regular SQLite file in rollback-journal mode (VACUUM
//! INTO does not carry WAL mode over), so it is a single self-contained file.
//!
//! `restore_from(src)` is the inverse, in place: the source is verified read-only first (`quick_check`, a user.db
//! schema version this build can migrate), then SQLite's online backup API copies it into the live database in one
//! step under the writer lock (every clone of the handle sees the restored library at once; WAL mode stays), and the
//! migrations bring an older schema up to date. A source that fails verification changes nothing.
//!
//! Another program can hold a lock on user.db (a database browser's open write transaction, a sync tool) or on the
//! source. Such a step stops with `SQLITE_BUSY`/`SQLITE_LOCKED` having committed nothing, so the restore retries. An
//! attempt never waits for a lock while it holds the writer lock (both connections' busy handlers are off for the
//! copy, instead of the library's usual 5 s): the waiting happens between attempts, [`RESTORE_RETRY_PAUSE`] at a
//! time, with the writer lock released, so every other library call keeps working meanwhile. After
//! [`RESTORE_BUSY_BUDGET`] the restore gives up with `SQLITE_BUSY` (`AppError::Database`), the library unchanged.

use std::ffi::OsString;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, ErrorCode, OpenFlags};

use super::{BUSY_TIMEOUT, UserDb, migrations, run_quick_check, system_now_ms};
use crate::{CoreError, Result};

/// How long [`UserDb::restore_from`] keeps trying while another program holds a lock on the library or the backup.
const RESTORE_BUSY_BUDGET: Duration = Duration::from_secs(10);

/// The pause between two restore attempts, with the writer lock released so that other library calls run.
const RESTORE_RETRY_PAUSE: Duration = Duration::from_millis(20);

/// Removes the temporary file unless disarmed.
struct TempGuard(Option<PathBuf>);

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take()
            && path.exists()
            && let Err(e) = std::fs::remove_file(&path)
        {
            log::warn!("backup: could not remove the temporary copy: {e}");
        }
    }
}

/// Opens the copy read-only and checks it is a complete user.db.
fn verify_copy(path: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    run_quick_check(&conn)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let expected = i64::try_from(crate::USER_MIGRATIONS.len()).unwrap_or(i64::MAX);
    if version != expected {
        return Err(CoreError::Corrupt(format!(
            "backup copy has schema version {version}, expected {expected}"
        )));
    }
    Ok(())
}

/// Checks that `src` is a readable user.db this build can migrate.
fn verify_restore_source(src: &Path, source: &Connection) -> Result<()> {
    let not_a_library = || {
        CoreError::InvalidArgument(format!(
            "{} is not a Quran for Desktop library",
            src.display()
        ))
    };
    run_quick_check(source).map_err(|_| not_a_library())?;
    let version: i64 = source.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let ours = i64::try_from(crate::USER_MIGRATIONS.len()).unwrap_or(i64::MAX);
    if version > ours {
        return Err(CoreError::InvalidArgument(format!(
            "{} was written by a newer version of the app (schema {version}; this build reads up to {ours})",
            src.display()
        )));
    }
    let tables: i64 = source.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('setting', 'bookmark', 'memo_ayah')",
        [],
        |r| r.get(0),
    )?;
    if version < 1 || tables != 3 {
        return Err(not_a_library());
    }
    Ok(())
}

/// The suffixes of the files SQLite keeps for a database: the main file, then its companions.
const LIVE_SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];

/// `InvalidArgument` when `dest` names the database `conn` has open, or one of its companions ([`LIVE_SUFFIXES`]).
fn refuse_live_files(conn: &Connection, dest: &Path) -> Result<()> {
    // `sqlite3_db_filename`: the absolute path SQLite opened; empty for an in-memory or temporary database.
    let Some(main) = conn.path().filter(|p| !p.is_empty()).map(PathBuf::from) else {
        return Ok(());
    };
    let Some(main_name) = main.file_name() else {
        return Ok(());
    };
    for suffix in LIVE_SUFFIXES {
        let mut name = OsString::from(main_name);
        name.push(suffix);
        if same_location(dest, &main.with_file_name(&name)) {
            return Err(CoreError::InvalidArgument(format!(
                "{} is the open library{}; choose another file for the backup",
                dest.display(),
                if suffix.is_empty() {
                    String::new()
                } else {
                    format!("'s {suffix} file")
                }
            )));
        }
    }
    Ok(())
}

/// Whether `a` and `b` name the same file. Two existing paths are compared by identity ([`same_file`]); a path that
/// does not exist (`-journal` in WAL mode) matches when its directory is the same directory and its name is the same
/// name (ASCII case-insensitively on Windows and macOS, whose file systems ignore case by default).
fn same_location(a: &Path, b: &Path) -> bool {
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) => same_file(a, &ma, b, &mb),
        // One exists and the other does not: two different paths (the same path would exist for both).
        (Ok(_), Err(_)) | (Err(_), Ok(_)) => false,
        (Err(_), Err(_)) => {
            let dir = |p: &Path| {
                let parent = p.parent().filter(|d| !d.as_os_str().is_empty());
                std::fs::canonicalize(parent.unwrap_or_else(|| Path::new("."))).ok()
            };
            let (Some(name_a), Some(name_b)) = (a.file_name(), b.file_name()) else {
                return false;
            };
            let same_name = if cfg!(any(windows, target_os = "macos")) {
                name_a.eq_ignore_ascii_case(name_b)
            } else {
                name_a == name_b
            };
            same_name && matches!((dir(a), dir(b)), (Some(x), Some(y)) if x == y)
        }
    }
}

/// Two existing paths are the same file: same device and inode (symlinks, `..`, letter case and hard links included).
#[cfg(unix)]
fn same_file(_: &Path, a: &Metadata, _: &Path, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// Two existing paths are the same file: the same final path (`GetFinalPathNameByHandleW` resolves symlinks,
/// junctions, `..`, 8.3 names and letter case).
#[cfg(not(unix))]
fn same_file(a: &Path, _: &Metadata, b: &Path, _: &Metadata) -> bool {
    matches!(
        (std::fs::canonicalize(a), std::fs::canonicalize(b)),
        (Ok(x), Ok(y)) if x == y
    )
}

fn open_restore_source(src: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        src,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

/// The library's connection with its busy handler off (a lock held elsewhere fails at once); dropping it puts the
/// usual [`BUSY_TIMEOUT`] back, also after an error or a panic.
struct NoBusyWait<'c>(&'c mut Connection);

impl<'c> NoBusyWait<'c> {
    fn new(conn: &'c mut Connection) -> Result<Self> {
        conn.busy_timeout(Duration::ZERO)?;
        Ok(Self(conn))
    }
}

impl Drop for NoBusyWait<'_> {
    fn drop(&mut self) {
        if let Err(e) = self.0.busy_timeout(BUSY_TIMEOUT) {
            log::warn!("restore: could not put the library's busy timeout back: {e}");
        }
    }
}

/// One attempt at copying every page of `source` (whose busy handler is off too) over the library (`conn`), without
/// waiting for any lock. `Ok(false)` when another connection's lock on either database stopped it (`SQLITE_BUSY`,
/// `SQLITE_LOCKED`, extended codes included): such a step has committed nothing, and dropping the backup
/// (`sqlite3_backup_finish`) rolls back whatever it began.
fn copy_all_pages(source: &Connection, conn: &mut Connection) -> Result<bool> {
    let dest = NoBusyWait::new(conn)?;
    let backup = Backup::new(source, &mut *dest.0)?;
    loop {
        match backup.step(-1) {
            Ok(StepResult::Done) => return Ok(true),
            // -1 copies every remaining page in one step; should one stop early, the next continues.
            Ok(StepResult::More) => {}
            Ok(other) => {
                log::trace!("restore: backup step {other:?}");
                return Ok(false);
            }
            Err(e)
                if matches!(
                    e.sqlite_error_code(),
                    Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                ) =>
            {
                log::trace!("restore: backup step: {e}");
                return Ok(false);
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// `SQLITE_BUSY` (`AppError::Database`) for a restore that another program's lock kept out for the whole budget.
fn library_in_use(src: &Path) -> CoreError {
    CoreError::Sqlite(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
        Some(format!(
            "the library is in use by another program, which holds a lock on user.db (or on {}); close that program \
             and try again. Nothing was restored",
            src.display()
        )),
    ))
}

impl UserDb {
    /// Checks, read-only and without touching any open library, that `src` is a backup [`UserDb::restore_from`] accepts
    /// (a readable user.db of this build's schema or an older one), so a caller can verify before it changes anything.
    ///
    /// # Errors
    /// `InvalidArgument` when `src` is not a library or comes from a newer version of the app; `Database` when it
    /// cannot be opened.
    pub fn check_backup(src: &Path) -> Result<()> {
        verify_restore_source(src, &open_restore_source(src)?)
    }

    /// `VACUUM INTO dest` (a consistent copy while the app keeps running), verified, then moved over `dest`.
    ///
    /// # Errors
    /// `InvalidArgument` when `dest` is a directory, has no file name, is not valid UTF-8, or is the live database or
    /// one of its `-wal`/`-shm`/`-journal` files; `Io`/`Database` when the copy cannot be written or does not verify.
    /// On any error nothing is left behind and the live database is unchanged.
    pub fn backup_to(&self, dest: &Path) -> Result<()> {
        if dest.is_dir() {
            return Err(CoreError::InvalidArgument(format!(
                "{} is a directory",
                dest.display()
            )));
        }
        let file_name = dest.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
            CoreError::InvalidArgument(format!("{} is not a file path", dest.display()))
        })?;
        let tmp = dest.with_file_name(format!("{file_name}.tmp-{}", system_now_ms()));
        let tmp_str = tmp
            .to_str()
            .ok_or_else(|| {
                CoreError::InvalidArgument(format!("{} is not valid UTF-8", dest.display()))
            })?
            .to_owned();
        let mut guard = TempGuard(Some(tmp.clone()));
        self.with(|c| {
            refuse_live_files(c, dest)?;
            c.execute("VACUUM INTO ?1", [&tmp_str])?;
            Ok(())
        })?;
        verify_copy(&tmp)?;
        // A previous backup that was opened in WAL mode may have left companions behind; SQLite would apply a stale
        // `-wal` to the new file the next time it is opened, so they go first.
        for suffix in ["-wal", "-shm"] {
            let companion = dest.with_file_name(format!("{file_name}{suffix}"));
            if companion.exists() {
                std::fs::remove_file(&companion)?;
            }
        }
        std::fs::rename(&tmp, dest)?;
        guard.0 = None;
        Ok(())
    }

    /// Replaces the whole library with the user.db at `src` (a [`Self::backup_to`] file, or any user.db of this or an
    /// older schema), in place. See the module docs.
    ///
    /// # Errors
    /// `InvalidArgument` when `src` is not a user.db this build can read (corrupt, another kind of SQLite file, a newer
    /// schema); `Database` when it cannot be opened or copied, or when another program's lock on the library or on
    /// `src` outlasts [`RESTORE_BUSY_BUDGET`] (`SQLITE_BUSY`, "the library is in use by another program"). On any error
    /// the live library is unchanged.
    pub fn restore_from(&self, src: &Path) -> Result<()> {
        self.restore_within(src, RESTORE_BUSY_BUDGET)
    }

    /// [`Self::restore_from`], giving up on a lock held elsewhere once `budget` has passed (see the module docs).
    fn restore_within(&self, src: &Path, budget: Duration) -> Result<()> {
        let source = open_restore_source(src)?;
        verify_restore_source(src, &source)?;
        source.busy_timeout(Duration::ZERO)?;
        let started = Instant::now();
        let mut attempts: u32 = 0;
        loop {
            attempts = attempts.saturating_add(1);
            let mut conn = self.lock();
            if copy_all_pages(&source, &mut conn)? {
                // Still under the writer lock: no other call sees the restored library before it is up to date.
                crate::migrate::to_latest(
                    &mut conn,
                    &migrations::migrations(),
                    crate::USER_MIGRATIONS.len(),
                )?;
                log::info!("user.db restored from a backup");
                return Ok(());
            }
            drop(conn);
            if attempts == 1 {
                log::debug!(
                    "restore: another program holds a lock on the library or the backup; waiting up to {budget:?}"
                );
            }
            if started.elapsed() >= budget {
                log::warn!(
                    "restore: another program kept a lock on the library or the backup for {:.1?} ({attempts} \
                     attempts); nothing was restored",
                    started.elapsed()
                );
                return Err(library_in_use(src));
            }
            std::thread::sleep(RESTORE_RETRY_PAUSE);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{MemoStatus, Settings, ThemeMode};

    use super::*;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        (dir, db)
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_backup_is_a_complete_openable_copy_and_replaces_an_old_one() {
        let (dir, db) = temp_db();
        let settings = Settings {
            theme: ThemeMode::Black,
            ..Settings::default()
        };
        db.settings_save(&settings).unwrap();
        db.memo_set_status(1, 7, MemoStatus::Memorized).unwrap();
        let out = dir.path().join("backups");
        std::fs::create_dir(&out).unwrap();
        let dest = out.join("user-backup.qdb");
        std::fs::write(&dest, b"an older backup").unwrap();

        db.backup_to(&dest).unwrap();
        assert_eq!(
            files_in(&out),
            ["user-backup.qdb"],
            "no temporary file is left behind"
        );

        // The copy opens as a user.db with the same data, and the source keeps working.
        let copy = UserDb::open(&dest).unwrap();
        assert_eq!(copy.settings_load().unwrap(), settings);
        assert_eq!(copy.memo_progress(1, 7).unwrap().len(), 7);
        db.memo_set_status(8, 8, MemoStatus::Learning).unwrap();
        assert_eq!(copy.memo_progress(8, 8).unwrap().len(), 0);
    }

    #[test]
    fn restore_replaces_the_library_in_place_for_every_clone() {
        let (dir, db) = temp_db();
        let clone = db.clone();
        let saved = Settings {
            theme: ThemeMode::Sepia,
            ..Settings::default()
        };
        db.settings_save(&saved).unwrap();
        db.memo_set_status(1, 7, MemoStatus::Memorized).unwrap();
        let backup = dir.path().join("b.qdb");
        db.backup_to(&backup).unwrap();
        // Diverge after the backup, then restore.
        db.settings_save(&Settings::default()).unwrap();
        db.memo_set_status(1, 286, MemoStatus::Learning).unwrap();
        db.restore_from(&backup).unwrap();
        assert_eq!(clone.settings_load().unwrap(), saved);
        let progress = clone.memo_progress(1, 286).unwrap();
        assert_eq!(progress.len(), 7);
        assert!(progress.iter().all(|p| p.status == MemoStatus::Memorized));
        clone
            .with(|c| {
                let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
                assert_eq!(mode, "wal", "the live database stays in WAL mode");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            busy_timeout_ms(&clone),
            5000,
            "the usual busy timeout is back"
        );
        // The library keeps working after the restore.
        clone.memo_set_status(8, 8, MemoStatus::Learning).unwrap();
        assert_eq!(
            UserDb::open(&dir.path().join("user.db"))
                .unwrap()
                .memo_progress(1, 8)
                .unwrap()
                .len(),
            8
        );
    }

    /// The library's `PRAGMA busy_timeout`, in milliseconds.
    fn busy_timeout_ms(db: &UserDb) -> i64 {
        db.with(|c| Ok(c.query_row("PRAGMA busy_timeout", [], |r| r.get(0))?))
            .unwrap()
    }

    #[test]
    fn a_lock_held_by_another_program_fails_the_restore_promptly_and_never_freezes_the_library() {
        let (dir, db) = temp_db();
        db.memo_set_status(1, 3, MemoStatus::Learning).unwrap();
        let backup = dir.path().join("b.qdb");
        db.backup_to(&backup).unwrap();
        // The library moves on after the backup, so a restore would show.
        db.memo_set_status(4, 7, MemoStatus::Memorized).unwrap();
        let statuses = |db: &UserDb| -> Vec<MemoStatus> {
            db.memo_progress(1, 7)
                .unwrap()
                .iter()
                .map(|p| p.status)
                .collect()
        };
        let before = statuses(&db);
        assert_eq!(before.len(), 7);

        // Another program (a database browser, a sync tool) holds a write transaction on the live library.
        let other = Connection::open(dir.path().join("user.db")).unwrap();
        other.execute_batch("BEGIN IMMEDIATE;").unwrap();

        let budget = Duration::from_millis(1500);
        let started = Instant::now();
        let restore = {
            let (db, src) = (db.clone(), backup.clone());
            std::thread::spawn(move || (db.restore_within(&src, budget), started.elapsed()))
        };
        // Meanwhile every other library call runs: an attempt never waits for the lock while it holds the writer lock.
        let (mut probes, mut slowest) = (0_u32, Duration::ZERO);
        while !restore.is_finished() && started.elapsed() < budget + Duration::from_secs(5) {
            let (tx, rx) = std::sync::mpsc::channel();
            let probe = db.clone();
            let asked = Instant::now();
            std::thread::spawn(move || tx.send(probe.memo_progress(1, 7).map(|p| p.len())));
            let read = rx
                .recv_timeout(Duration::from_secs(2))
                .expect("a library read is stuck behind the restore");
            assert_eq!(read.unwrap(), 7);
            slowest = slowest.max(asked.elapsed());
            probes += 1;
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            restore.is_finished(),
            "the restore still runs after {:?}",
            started.elapsed()
        );
        assert!(
            probes >= 3 && slowest < Duration::from_millis(500),
            "{probes} reads during the restore, the slowest took {slowest:?}"
        );

        let (out, took) = restore.join().unwrap();
        let err = out.unwrap_err();
        assert!(
            matches!(&err, CoreError::Sqlite(e) if e.sqlite_error_code() == Some(ErrorCode::DatabaseBusy)),
            "{err}"
        );
        assert!(
            took >= budget && took < budget + Duration::from_secs(2),
            "gave up after {took:?}"
        );
        match quran_types::AppError::from(err) {
            quran_types::AppError::Database(m) => {
                assert!(m.contains("in use by another program"), "{m}");
            }
            other => panic!("{other:?}"),
        }
        // Nothing changed, and the library keeps its usual busy timeout.
        assert_eq!(statuses(&db), before);
        assert_eq!(busy_timeout_ms(&db), 5000);

        // Once the other program lets go, the same restore goes through at once.
        other.execute_batch("ROLLBACK;").unwrap();
        let started = Instant::now();
        db.restore_from(&backup).unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(statuses(&db), [MemoStatus::Learning; 3]);
        assert_eq!(busy_timeout_ms(&db), 5000);
        db.memo_set_status(8, 8, MemoStatus::Learning).unwrap();
    }

    #[test]
    fn restore_refuses_what_is_not_a_library_and_changes_nothing() {
        let (dir, db) = temp_db();
        db.memo_set_status(1, 3, MemoStatus::Learning).unwrap();
        let garbage = dir.path().join("garbage.qdb");
        std::fs::write(&garbage, b"not a database at all".repeat(64)).unwrap();
        let other = dir.path().join("other.sqlite");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE t (x); PRAGMA user_version = 1;")
            .unwrap();
        let newer = dir.path().join("newer.qdb");
        db.backup_to(&newer).unwrap();
        Connection::open(&newer)
            .unwrap()
            .pragma_update(None, "user_version", 99_i64)
            .unwrap();
        for src in [&garbage, &other, &newer] {
            let checked = UserDb::check_backup(src).unwrap_err();
            assert!(
                matches!(checked, CoreError::InvalidArgument(_)),
                "check {}: {checked}",
                src.display()
            );
            let err = db.restore_from(src).unwrap_err();
            assert!(
                matches!(err, CoreError::InvalidArgument(_)),
                "{}: {err}",
                src.display()
            );
        }
        assert!(db.restore_from(&dir.path().join("missing.qdb")).is_err());
        assert!(UserDb::check_backup(&dir.path().join("missing.qdb")).is_err());
        assert_eq!(db.memo_progress(1, 7).unwrap().len(), 3, "nothing changed");
        let good = dir.path().join("good.qdb");
        db.backup_to(&good).unwrap();
        UserDb::check_backup(&good).unwrap();
    }

    #[test]
    fn the_live_database_and_its_companions_are_never_a_destination() {
        let (dir, db) = temp_db();
        db.memo_set_status(1, 3, MemoStatus::Learning).unwrap();
        let live = dir.path().join("user.db");
        let library_files = |dir: &Path| {
            let mut names = files_in(dir);
            names.retain(|n| n.starts_with("user.db"));
            names
        };
        let before = library_files(dir.path());
        assert!(
            before.contains(&"user.db-wal".to_owned())
                && before.contains(&"user.db-shm".to_owned()),
            "the live database is in WAL mode: {before:?}"
        );
        let mut refused = vec![
            live.clone(),
            dir.path().join("user.db-wal"),
            dir.path().join("user.db-shm"),
            // Absent in WAL mode, yet a rollback journal there would be applied to the library at the next open.
            dir.path().join("user.db-journal"),
            // Another spelling of the same file.
            dir.path().join("backups").join("..").join("user.db"),
        ];
        std::fs::create_dir(dir.path().join("backups")).unwrap();
        if cfg!(any(windows, target_os = "macos")) {
            refused.push(dir.path().join("USER.DB"));
            refused.push(dir.path().join("User.db-Journal"));
        }
        for dest in &refused {
            let err = db.backup_to(dest).unwrap_err();
            assert!(
                matches!(&err, CoreError::InvalidArgument(m) if m.contains("open library")),
                "{}: {err}",
                dest.display()
            );
        }
        // Nothing was replaced, deleted or left behind, and later writes still reach the file the next open reads.
        assert_eq!(library_files(dir.path()), before);
        db.memo_set_status(4, 5, MemoStatus::Learning).unwrap();
        drop(db);
        assert_eq!(
            UserDb::open(&live)
                .unwrap()
                .memo_progress(1, 7)
                .unwrap()
                .len(),
            5
        );
        // A sibling whose name only starts like the library's is an ordinary destination.
        let (dir, db) = temp_db();
        for name in ["user.db.qdb", "user.db-backup", "user.dbx"] {
            db.backup_to(&dir.path().join(name)).unwrap();
        }
    }

    #[test]
    fn invalid_destinations_are_rejected_and_leave_nothing() {
        let (dir, db) = temp_db();
        assert!(matches!(
            db.backup_to(dir.path()),
            Err(CoreError::InvalidArgument(_))
        ));
        let missing_parent = dir.path().join("no-such-dir").join("b.qdb");
        assert!(db.backup_to(&missing_parent).is_err());
        assert!(!dir.path().join("no-such-dir").exists());
        assert!(
            files_in(dir.path())
                .iter()
                .all(|n| n.starts_with("user.db")),
            "{:?}",
            files_in(dir.path())
        );
    }
}
