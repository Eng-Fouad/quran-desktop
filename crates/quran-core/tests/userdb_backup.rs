//! `UserDb::backup_to`: a verified `VACUUM INTO` copy that opens as a user.db, taken while other threads keep
//! writing, into paths with non-ASCII names, replacing an older backup atomically.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use quran_core::UserDb;
use quran_types::{HistoryInput, HistoryMode, MemoStatus, MushafLayout};
use support::user::{TempUserDb, count, every_setting_changed, preset_input};

fn populate(db: &UserDb) {
    db.settings_save(&every_setting_changed()).unwrap();
    db.memo_set_status(1, 286, MemoStatus::Learning).unwrap();
    db.loop_preset_upsert(&preset_input("Ayat al-Kursi"))
        .unwrap();
    db.with(|c| {
        c.execute(
            "INSERT INTO note (id, from_ayah_id, to_ayah_id, title, body, body_search, created_at, updated_at)
             VALUES ('n1', 1, 7, 'الفاتحة', 'Notes on the opening', 'notes on the opening', 0, 0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn the_backup_opens_as_a_complete_library() {
    let t = TempUserDb::new();
    populate(&t.db);
    // An Arabic folder name: SQLite receives the path as UTF-8 and must still find it on Windows.
    let folder = t.dir().join("نسخ احتياطية");
    std::fs::create_dir(&folder).unwrap();
    let dest = folder.join("user-2026-10-10.qdb");
    t.db.backup_to(&dest).unwrap();

    let copy = UserDb::open(&dest).unwrap();
    assert_eq!(copy.settings_load().unwrap(), every_setting_changed());
    assert_eq!(copy.memo_progress(1, 286).unwrap().len(), 286);
    assert_eq!(copy.loop_presets().unwrap().len(), 1);
    // The note FTS index is part of the copy.
    let hits: i64 = copy
        .with(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM note_fts WHERE note_fts MATCH 'opening'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(hits, 1);
    // Only the backup file is left in the folder (no temporary copy, no -wal/-shm before it is opened).
    drop(copy);
    let names: Vec<String> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| !n.ends_with("-wal") && !n.ends_with("-shm"))
        .collect();
    assert_eq!(names, ["user-2026-10-10.qdb"]);
}

#[test]
fn a_backup_taken_during_writes_is_consistent_and_replaces_the_previous_one() {
    let t = TempUserDb::new();
    populate(&t.db);
    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let db = t.db.clone();
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut n = 0_u32;
            while !stop.load(Ordering::Relaxed) {
                n += 1;
                db.history_record(&HistoryInput {
                    mode: HistoryMode::Read,
                    layout: Some(MushafLayout::V2),
                    page: Some(n % 604 + 1),
                    ayah_id: 1,
                    dwell_s: 1,
                })
                .unwrap();
            }
            n
        })
    };
    let dest = t.dir().join("backup.qdb");
    for _ in 0..5 {
        t.db.backup_to(&dest).unwrap();
        let copy = UserDb::open(&dest).unwrap();
        assert_eq!(count(&copy, "memo_ayah"), 286);
        let integrity: String = copy
            .with(|c| Ok(c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(integrity, "ok");
    }
    stop.store(true, Ordering::Relaxed);
    assert!(writer.join().unwrap() > 0);
}
