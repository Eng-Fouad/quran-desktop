//! The chapter geometry content.db relies on (`content_db::geometry`) against a built core.db (§12.2). Owner: WP1c.
//!
//! Ignored by default: `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core --test content_geometry -- --ignored`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use quran_core::content_db::geometry::{ayah_ref, surah_ayah_ids, surah_word_ids};
use rusqlite::{Connection, OpenFlags};

/// `QD_CORE_DB`, relative to the workspace root when relative.
fn core_db() -> PathBuf {
    let value = std::env::var_os("QD_CORE_DB")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            panic!("set QD_CORE_DB to a built core.db (e.g. src-tauri/resources/core.db)")
        });
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path)
    };
    let len = std::fs::metadata(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .len();
    assert!(
        len > 1_000_000,
        "{} is a placeholder, not a built core.db",
        path.display()
    );
    path
}

#[test]
#[ignore = "needs QD_CORE_DB (a built core.db)"]
fn geometry_matches_core_db() {
    let conn = Connection::open_with_flags(core_db(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT surah, min(id), max(id), min(ayah_id), max(ayah_id) FROM word GROUP BY surah ORDER BY surah",
        )
        .unwrap();
    let rows: Vec<(u32, u32, u32, u32, u32)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows.len(), 114);
    for (surah, first_word, last_word, first_ayah, last_ayah) in rows {
        assert_eq!(
            surah_word_ids(surah),
            Some(first_word..=last_word),
            "words of surah {surah}"
        );
        assert_eq!(
            surah_ayah_ids(surah),
            Some(first_ayah..=last_ayah),
            "ayahs of surah {surah}"
        );
    }
    let mut stmt = conn
        .prepare("SELECT id, surah, ayah FROM ayah ORDER BY id")
        .unwrap();
    let ayahs = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, u32>(2)?,
            ))
        })
        .unwrap();
    for row in ayahs {
        let (id, surah, ayah) = row.unwrap();
        assert_eq!(ayah_ref(id), Some((surah, ayah)));
    }
}
