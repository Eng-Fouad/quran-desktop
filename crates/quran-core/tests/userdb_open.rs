//! `UserDb::open` / `open_or_recover` against real files (§2.2.6, §9.8): pragmas, persistence, tombstone purge,
//! quarantine of unusable files, and transient failures and newer libraries that must never quarantine.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::path::Path;

use quran_core::{CoreError, UserDb};
use quran_types::{MemoStatus, Settings, ThemeMode};
use support::user::{DAY_MS, TempUserDb, count};

/// The files in `dir` whose name starts with `user.db`, sorted.
fn user_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("user.db"))
        .collect();
    names.sort();
    names
}

#[test]
fn open_creates_a_wal_database_that_persists() {
    let t = TempUserDb::new();
    assert!(t.path.exists());
    let settings = Settings {
        theme: ThemeMode::Paper,
        ..Settings::default()
    };
    t.db.settings_save(&settings).unwrap();
    t.db.memo_set_status(1, 7, MemoStatus::Learning).unwrap();
    let mode: String =
        t.db.with(|c| Ok(c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?))
            .unwrap();
    assert_eq!(mode, "wal");

    let again = t.reopen();
    assert_eq!(again.settings_load().unwrap(), settings);
    assert_eq!(again.memo_progress(1, 7).unwrap().len(), 7);
}

#[test]
fn opening_twice_and_from_many_threads_is_safe() {
    let t = TempUserDb::new();
    let handles: Vec<_> = (0..8_u32)
        .map(|i| {
            let db = t.db.clone();
            std::thread::spawn(move || {
                for k in 0..25_u32 {
                    let ayah = i * 25 + k + 1;
                    db.memo_set_status(ayah, ayah, MemoStatus::Learning)
                        .unwrap();
                    db.settings_save(&Settings {
                        reciter_id: ayah,
                        ..Settings::default()
                    })
                    .unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(count(&t.db, "memo_ayah"), 200);
    // A second connection on the same file (e.g. a backup reader) sees the committed data.
    assert_eq!(t.reopen().memo_progress(1, 6236).unwrap().len(), 200);
}

#[test]
fn old_tombstones_are_purged_at_open() {
    let t = TempUserDb::new();
    let now = t.db.now_ms();
    t.db.with(|c| {
        c.execute_batch(&format!(
            "INSERT INTO note (id, from_ayah_id, to_ayah_id, body, body_search, created_at, updated_at, deleted_at)
             VALUES ('old', 1, 1, 'b', 'b', 0, 0, {old}), ('recent', 1, 1, 'b', 'b', 0, 0, {recent}),
                    ('live', 1, 1, 'b', 'b', 0, 0, NULL);
             INSERT INTO highlight (id, from_ayah_id, to_ayah_id, color, created_at, updated_at, deleted_at)
             VALUES ('h', 1, 2, 'green', 0, 0, {old});",
            old = now - 45 * DAY_MS,
            recent = now - DAY_MS,
        ))?;
        Ok(())
    })
    .unwrap();
    let reopened = t.reopen();
    assert_eq!(count(&reopened, "note"), 2);
    assert_eq!(count(&reopened, "highlight"), 0);
    // The external-content FTS index followed the deletes (note_ad trigger).
    let fts: i64 = reopened
        .with(|c| Ok(c.query_row("SELECT count(*) FROM note_fts", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(fts, 2);
}

#[test]
fn a_healthy_file_is_not_quarantined() {
    let t = TempUserDb::new();
    t.db.memo_set_status(5, 5, MemoStatus::Memorized).unwrap();
    let (db, quarantined) = UserDb::open_or_recover(&t.path).unwrap();
    assert_eq!(quarantined, None);
    assert_eq!(db.memo_progress(5, 5).unwrap().len(), 1);
}

#[test]
fn a_file_that_is_not_a_database_is_quarantined_with_its_bytes() {
    let dir = support::tempdir();
    let path = dir.path().join("user.db");
    let garbage =
        b"this is certainly not an SQLite database, but it is the user's file".repeat(100);
    std::fs::write(&path, &garbage).unwrap();
    std::fs::write(dir.path().join("user.db-wal"), b"stale wal").unwrap();
    std::fs::write(dir.path().join("user.db-shm"), b"stale shm").unwrap();
    assert!(UserDb::open(&path).unwrap_err().is_corruption());

    let (db, quarantined) = UserDb::open_or_recover(&path).unwrap();
    let quarantined = quarantined.expect("the file is quarantined");
    let name = quarantined
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("user.db.corrupt-"), "{name}");
    assert_eq!(
        std::fs::read(&quarantined).unwrap(),
        garbage,
        "the user's bytes are kept"
    );
    // SQLite itself discards the -wal/-shm of a file that is not a database when the failed connection closes; either
    // way, nothing stale may reach the fresh database.
    for suffix in ["-wal", "-shm"] {
        let companion = dir.path().join(format!("user.db{suffix}"));
        assert!(
            !companion.exists() || std::fs::read(&companion).unwrap() != b"stale wal",
            "{suffix}"
        );
    }
    // The fresh database works and starts empty.
    assert_eq!(db.settings_load().unwrap(), Settings::default());
    assert!(db.first_run().unwrap());
    db.memo_set_status(1, 1, MemoStatus::Learning).unwrap();
    let files = user_files(dir.path());
    assert!(files.contains(&"user.db".to_owned()), "{files:?}");
    assert!(files.contains(&name), "{files:?}");
}

#[test]
fn a_damaged_database_is_quarantined() {
    let t = TempUserDb::new();
    for i in 0..400_u32 {
        t.db.search_history_add(
            &format!("query number {i} {}", "x".repeat(200)),
            &quran_types::SearchScope::Quran,
        )
        .unwrap();
    }
    let path = t.path.clone();
    let dir = t.dir.path().to_path_buf();
    // Checkpoint the WAL into the main file and close every connection.
    t.db.with(|c| {
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    })
    .unwrap();
    let TempUserDb {
        db, dir: tempdir, ..
    } = t;
    drop(db);
    // Overwrite the second half of the file (the b-tree pages) with garbage, keeping the valid header.
    let mut bytes = std::fs::read(&path).unwrap();
    let half = bytes.len() / 2;
    for (i, b) in bytes.iter_mut().enumerate().skip(half) {
        *b = u8::try_from(i % 251).unwrap();
    }
    std::fs::write(&path, &bytes).unwrap();

    let (db, quarantined) = UserDb::open_or_recover(&path).unwrap();
    assert!(quarantined.is_some(), "a failed quick_check quarantines");
    assert!(db.search_history_list(10).unwrap().is_empty());
    assert_eq!(
        user_files(&dir)
            .iter()
            .filter(|n| n.contains(".corrupt-"))
            .count(),
        1
    );
    drop(tempdir);
}

#[test]
fn a_database_from_a_newer_build_is_refused_and_left_in_place() {
    // A downgrade: the library was last opened by a build with more migrations. It is intact, so it is neither
    // quarantined nor replaced; startup reports `NewerSchema` and updating the app opens it again.
    let t = TempUserDb::new();
    t.db.memo_set_status(1, 3, MemoStatus::Learning).unwrap();
    t.db.with(|c| {
        c.pragma_update(None, "user_version", 99_i64)?;
        Ok(())
    })
    .unwrap();
    let TempUserDb { db, path, dir } = t;
    drop(db);
    let original = std::fs::read(&path).unwrap();

    let err = UserDb::open_or_recover(&path).unwrap_err();
    let latest = u32::try_from(quran_core::USER_MIGRATIONS.len()).unwrap();
    assert!(
        matches!(err, CoreError::NewerSchema { found: 99, supported } if supported == latest),
        "{err}"
    );
    assert!(!err.is_corruption());
    assert!(matches!(
        quran_types::AppError::from(err),
        quran_types::AppError::Database(_)
    ));
    let files = user_files(dir.path());
    assert!(
        !files.iter().any(|n| n.contains(".corrupt-")),
        "no quarantine: {files:?}"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        original,
        "no fresh library, not a byte changed"
    );
    let raw = rusqlite::Connection::open(&path).unwrap();
    let rows: i64 = raw
        .query_row("SELECT count(*) FROM memo_ayah", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 3);
    drop(raw);
    drop(dir);
}

#[test]
fn a_path_that_cannot_be_opened_is_an_error_not_a_quarantine() {
    let dir = support::tempdir();
    // A directory where the file should be: SQLITE_CANTOPEN, a condition of the environment, not of the file.
    let path = dir.path().join("user.db");
    std::fs::create_dir(&path).unwrap();
    let err = UserDb::open_or_recover(&path).unwrap_err();
    assert!(!err.is_corruption(), "{err}");
    assert!(matches!(err, CoreError::Sqlite(_)), "{err}");
    assert!(path.is_dir(), "nothing was renamed");
    assert_eq!(user_files(dir.path()), ["user.db"]);
}
