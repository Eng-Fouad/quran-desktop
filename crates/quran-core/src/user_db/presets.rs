//! Loop presets (range, repeats, gap, speed) (§2.2.6, §3.2). Owner: WP2b.
//!
//! - The name is trimmed and must be 1..=[`PRESET_NAME_MAX_CHARS`] characters; the range must be a valid ayah range.
//!   Those are rejected with `InvalidArgument`.
//! - Numbers are normalised exactly like the matching settings (`Settings::validated`): repeats clamped to 0..=99
//!   (0 = ∞), speed clamped to 50..=200 and rounded to a 5 % step, the gap clamped. A preset therefore always replays
//!   with values the engine accepts.
//! - `id: None` creates, `Some(id)` updates (an unknown id is `NotFound`). Presets are hard-deleted (no tombstone column).
//! - The list is ordered by name (case-insensitive), then id.

use quran_types::limits::{REPEAT, SPEED_PCT};
use quran_types::{GapSetting, LoopPreset, LoopPresetInput};
use rusqlite::{OptionalExtension, Row, params};

use super::{UserDb, check_ayah_range, col_u32, ms_to_secs, opt_col_u32};
use crate::{CoreError, Result};

/// Longest preset name, in characters.
pub const PRESET_NAME_MAX_CHARS: usize = 100;

const COLUMNS: &str = "id, name, reciter_id, from_ayah_id, to_ayah_id, ayah_repeat, range_repeat, gap_json, speed_pct, \
                       created_at, updated_at";

type RawPreset = (
    i64,
    String,
    Option<i64>,
    i64,
    i64,
    i64,
    i64,
    String,
    i64,
    i64,
    i64,
);

fn raw_preset(r: &Row<'_>) -> rusqlite::Result<RawPreset> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
        r.get(10)?,
    ))
}

fn preset_from_raw(raw: RawPreset) -> Result<LoopPreset> {
    let (
        id,
        name,
        reciter_id,
        from,
        to,
        ayah_repeat,
        range_repeat,
        gap_json,
        speed_pct,
        created_at,
        updated_at,
    ) = raw;
    let gap = serde_json::from_str::<GapSetting>(&gap_json).unwrap_or_else(|e| {
        log::warn!("loop preset {id}: gap {gap_json} is unreadable ({e}); using none");
        GapSetting::None
    });
    Ok(LoopPreset {
        id: col_u32(id, "loop_preset.id")?,
        name,
        reciter_id: opt_col_u32(reciter_id, "loop_preset.reciter_id")?,
        from_ayah_id: col_u32(from, "loop_preset.from_ayah_id")?,
        to_ayah_id: col_u32(to, "loop_preset.to_ayah_id")?,
        ayah_repeat: col_u32(ayah_repeat, "loop_preset.ayah_repeat")?,
        range_repeat: col_u32(range_repeat, "loop_preset.range_repeat")?,
        gap,
        speed_pct: col_u32(speed_pct, "loop_preset.speed_pct")?,
        created_at: ms_to_secs(created_at),
        updated_at: ms_to_secs(updated_at),
    })
}

fn load(c: &rusqlite::Connection, id: u32) -> Result<Option<LoopPreset>> {
    c.prepare_cached(&format!("SELECT {COLUMNS} FROM loop_preset WHERE id = ?1"))?
        .query_row([id], raw_preset)
        .optional()?
        .map(preset_from_raw)
        .transpose()
}

impl UserDb {
    /// Every preset, by name (case-insensitive), then id.
    pub fn loop_presets(&self) -> Result<Vec<LoopPreset>> {
        let raws = self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {COLUMNS} FROM loop_preset ORDER BY name COLLATE NOCASE, id"
            ))?;
            let rows = stmt
                .query_map([], raw_preset)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        raws.into_iter().map(preset_from_raw).collect()
    }

    /// Creates (`id: None`) or updates a preset; returns the stored row.
    pub fn loop_preset_upsert(&self, input: &LoopPresetInput) -> Result<LoopPreset> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(CoreError::InvalidArgument("preset name is empty".into()));
        }
        if name.chars().count() > PRESET_NAME_MAX_CHARS {
            return Err(CoreError::InvalidArgument(format!(
                "preset name is longer than {PRESET_NAME_MAX_CHARS} characters"
            )));
        }
        check_ayah_range(input.from_ayah_id, input.to_ayah_id)?;
        let gap_json = serde_json::to_string(&input.gap.clamped())?;
        let ayah_repeat = REPEAT.apply(input.ayah_repeat);
        let range_repeat = REPEAT.apply(input.range_repeat);
        let speed_pct = SPEED_PCT.apply(input.speed_pct);
        let now = self.now_ms();
        self.with_tx(|tx| {
            let id = match input.id {
                None => {
                    tx.prepare_cached(
                        "INSERT INTO loop_preset (name, reciter_id, from_ayah_id, to_ayah_id, ayah_repeat, range_repeat,
                           gap_json, speed_pct, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    )?
                    .execute(params![
                        name,
                        input.reciter_id,
                        input.from_ayah_id,
                        input.to_ayah_id,
                        ayah_repeat,
                        range_repeat,
                        gap_json,
                        speed_pct,
                        now,
                    ])?;
                    col_u32(tx.last_insert_rowid(), "loop_preset.id")?
                }
                Some(id) => {
                    let changed = tx
                        .prepare_cached(
                            "UPDATE loop_preset SET name = ?2, reciter_id = ?3, from_ayah_id = ?4, to_ayah_id = ?5,
                               ayah_repeat = ?6, range_repeat = ?7, gap_json = ?8, speed_pct = ?9, updated_at = ?10
                             WHERE id = ?1",
                        )?
                        .execute(params![
                            id,
                            name,
                            input.reciter_id,
                            input.from_ayah_id,
                            input.to_ayah_id,
                            ayah_repeat,
                            range_repeat,
                            gap_json,
                            speed_pct,
                            now,
                        ])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound(format!("loop preset {id}")));
                    }
                    id
                }
            };
            load(tx, id)?.ok_or_else(|| CoreError::NotFound(format!("loop preset {id}")))
        })
    }

    /// Deletes a preset; an unknown id is `NotFound`.
    pub fn loop_preset_delete(&self, id: u32) -> Result<()> {
        let changed = self.with(|c| {
            Ok(c.prepare_cached("DELETE FROM loop_preset WHERE id = ?1")?
                .execute([id])?)
        })?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("loop preset {id}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn input(name: &str) -> LoopPresetInput {
        LoopPresetInput {
            id: None,
            name: name.into(),
            reciter_id: Some(7),
            from_ayah_id: 255,
            to_ayah_id: 257,
            ayah_repeat: 3,
            range_repeat: 2,
            gap: GapSetting::Fixed { ms: 1_500 },
            speed_pct: 90,
        }
    }

    #[test]
    fn create_update_list_delete() {
        let (_dir, db) = temp_db();
        assert!(db.loop_presets().unwrap().is_empty());
        let kursi = db.loop_preset_upsert(&input("  Ayat al-Kursi ")).unwrap();
        assert_eq!(kursi.name, "Ayat al-Kursi");
        assert_eq!(
            (kursi.created_at, kursi.updated_at),
            (1_700_000_000, 1_700_000_000)
        );
        assert_eq!(kursi.gap, GapSetting::Fixed { ms: 1_500 });
        let baqarah = db.loop_preset_upsert(&input("al-Baqarah end")).unwrap();
        assert_eq!(
            db.loop_presets()
                .unwrap()
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["al-Baqarah end", "Ayat al-Kursi"],
            "case-insensitive name order"
        );

        db.set_test_clock(Some(T0 + 5_000));
        let updated = db
            .loop_preset_upsert(&LoopPresetInput {
                id: Some(kursi.id),
                reciter_id: None,
                gap: GapSetting::Multiplier { pct: 100 },
                ..input("Kursi")
            })
            .unwrap();
        assert_eq!(updated.id, kursi.id);
        assert_eq!(
            (updated.created_at, updated.updated_at),
            (1_700_000_000, 1_700_000_005)
        );
        assert_eq!(
            (updated.reciter_id, updated.gap),
            (None, GapSetting::Multiplier { pct: 100 })
        );

        db.loop_preset_delete(baqarah.id).unwrap();
        assert!(matches!(
            db.loop_preset_delete(baqarah.id),
            Err(CoreError::NotFound(_))
        ));
        assert_eq!(db.loop_presets().unwrap(), [updated]);
    }

    #[test]
    fn numbers_are_normalised_like_settings() {
        let (_dir, db) = temp_db();
        let p = db
            .loop_preset_upsert(&LoopPresetInput {
                ayah_repeat: 500,
                range_repeat: 0,
                speed_pct: 123,
                gap: GapSetting::Fixed { ms: 999_999 },
                ..input("x")
            })
            .unwrap();
        assert_eq!((p.ayah_repeat, p.range_repeat, p.speed_pct), (99, 0, 125));
        assert_eq!(p.gap, GapSetting::Fixed { ms: 30_000 });
        assert_eq!(
            db.loop_preset_upsert(&LoopPresetInput {
                speed_pct: 10,
                ..input("y")
            })
            .unwrap()
            .speed_pct,
            50
        );
    }

    #[test]
    fn invalid_presets_are_rejected() {
        let (_dir, db) = temp_db();
        for bad in [
            input("   "),
            input(&"n".repeat(PRESET_NAME_MAX_CHARS + 1)),
            LoopPresetInput {
                from_ayah_id: 10,
                to_ayah_id: 9,
                ..input("x")
            },
            LoopPresetInput {
                to_ayah_id: 6237,
                ..input("x")
            },
        ] {
            assert!(
                matches!(
                    db.loop_preset_upsert(&bad),
                    Err(CoreError::InvalidArgument(_))
                ),
                "{bad:?}"
            );
        }
        let missing = db.loop_preset_upsert(&LoopPresetInput {
            id: Some(42),
            ..input("x")
        });
        assert!(matches!(missing, Err(CoreError::NotFound(_))));
        assert!(db.loop_presets().unwrap().is_empty());
    }

    #[test]
    fn an_unreadable_gap_reads_as_none() {
        let (_dir, db) = temp_db();
        let p = db.loop_preset_upsert(&input("x")).unwrap();
        db.with(|c| {
            c.execute(
                r#"UPDATE loop_preset SET gap_json = '{"type":"random"}' WHERE id = ?1"#,
                [p.id],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(db.loop_presets().unwrap()[0].gap, GapSetting::None);
    }
}
