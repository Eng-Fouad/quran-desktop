//! Reading positions per context (`mushaf`, `translation`, `audio`) (§2.2.6, §3.2). Owner: WP2b.
//!
//! One row per context; `position_set` replaces it and stamps `updated_at` (the input's `updated_at` is ignored). It is
//! written often (page turns, scrolling), so it emits no event (§5.13) and is a single small upsert.

use quran_types::{PositionContext, ReadingPosition};
use rusqlite::params;

use super::{UserDb, check_ayah, check_page, col_u32, layout_from_db, ms_to_secs, opt_col_u32};
use crate::Result;

pub(crate) const fn context_str(c: PositionContext) -> &'static str {
    match c {
        PositionContext::Mushaf => "mushaf",
        PositionContext::Translation => "translation",
        PositionContext::Audio => "audio",
    }
}

fn parse_context(s: &str) -> Option<PositionContext> {
    Some(match s {
        "mushaf" => PositionContext::Mushaf,
        "translation" => PositionContext::Translation,
        "audio" => PositionContext::Audio,
        _ => return None,
    })
}

impl UserDb {
    /// Every stored position, in context order (`mushaf`, `translation`, `audio`).
    pub fn positions(&self) -> Result<Vec<ReadingPosition>> {
        type Raw = (String, Option<i64>, Option<i64>, i64, Option<i64>, i64);
        let raws: Vec<Raw> = self.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT context, mushaf_id, page, ayah_id, scroll_px, updated_at FROM reading_position",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
                .collect::<rusqlite::Result<Vec<Raw>>>()?;
            Ok(rows)
        })?;
        let mut out = Vec::with_capacity(raws.len());
        for (context, mushaf_id, page, ayah_id, scroll_px, updated_at) in raws {
            let Some(context) = parse_context(&context) else {
                continue; // the CHECK constraint makes this unreachable for rows written by SQLite
            };
            out.push(ReadingPosition {
                context,
                layout: layout_from_db(mushaf_id),
                page: opt_col_u32(page, "reading_position.page")?,
                ayah_id: col_u32(ayah_id, "reading_position.ayah_id")?,
                scroll_px: opt_col_u32(scroll_px, "reading_position.scroll_px")?,
                updated_at: ms_to_secs(updated_at),
            });
        }
        out.sort_by_key(|p| p.context as u8);
        Ok(out)
    }

    /// Replaces the position of `p.context`. Validates the ayah id and page; `updated_at` is set to now.
    pub fn position_set(&self, p: &ReadingPosition) -> Result<()> {
        check_ayah(p.ayah_id, "ayah")?;
        check_page(p.page)?;
        let now = self.now_ms();
        self.with(|c| {
            c.prepare_cached(
                "INSERT INTO reading_position (context, mushaf_id, page, ayah_id, scroll_px, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (context) DO UPDATE SET mushaf_id = excluded.mushaf_id, page = excluded.page,
                   ayah_id = excluded.ayah_id, scroll_px = excluded.scroll_px, updated_at = excluded.updated_at",
            )?
            .execute(params![
                context_str(p.context),
                p.layout.map(|l| l.db_id()),
                p.page,
                p.ayah_id,
                p.scroll_px,
                now,
            ])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::MushafLayout;

    use super::*;
    use crate::CoreError;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        (dir, db)
    }

    fn pos(context: PositionContext, ayah_id: u32) -> ReadingPosition {
        ReadingPosition {
            context,
            layout: Some(MushafLayout::V2),
            page: Some(262),
            ayah_id,
            scroll_px: None,
            updated_at: 999,
        }
    }

    #[test]
    fn one_row_per_context_in_context_order() {
        let (_dir, db) = temp_db();
        assert!(db.positions().unwrap().is_empty());
        db.set_test_clock(Some(1_700_000_000_000));
        db.position_set(&pos(PositionContext::Audio, 10)).unwrap();
        db.position_set(&ReadingPosition {
            layout: None,
            page: None,
            scroll_px: Some(1_234),
            ..pos(PositionContext::Translation, 20)
        })
        .unwrap();
        db.position_set(&pos(PositionContext::Mushaf, 30)).unwrap();
        db.position_set(&ReadingPosition {
            layout: Some(MushafLayout::V4),
            ..pos(PositionContext::Mushaf, 31)
        })
        .unwrap();
        let all = db.positions().unwrap();
        assert_eq!(
            all.iter()
                .map(|p| (p.context, p.ayah_id))
                .collect::<Vec<_>>(),
            [
                (PositionContext::Mushaf, 31),
                (PositionContext::Translation, 20),
                (PositionContext::Audio, 10)
            ]
        );
        assert_eq!(all[0].layout, Some(MushafLayout::V4));
        assert_eq!(
            all[0].updated_at, 1_700_000_000,
            "stamped now, input ignored"
        );
        assert_eq!(all[1].layout, None);
        assert_eq!(all[1].page, None);
        assert_eq!(all[1].scroll_px, Some(1_234));
    }

    #[test]
    fn invalid_positions_are_rejected() {
        let (_dir, db) = temp_db();
        assert!(matches!(
            db.position_set(&pos(PositionContext::Mushaf, 0)),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(matches!(
            db.position_set(&ReadingPosition {
                page: Some(605),
                ..pos(PositionContext::Mushaf, 1)
            }),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(db.positions().unwrap().is_empty());
    }
}
