//! `QuranIndex` assembly: surahs, divisions, sajdas and the per-layout bootstrap arrays.
//!
//! The frontend indexes every array by `id − 1` (`surahs[s − 1]`, `ayahFirstWord[a − 1]`, `pageFirstAyah[p − 1]`), so
//! the build checks that ids are contiguous from 1 and that each layout has exactly `mushaf.pages` pages; anything else
//! is [`CoreError::Corrupt`]. Budget: < 30 ms for the first call, cached by `CoreDb` afterwards.

use quran_types::{
    Division, LayoutInfo, MushafLayout, QuranIndex, RevelationPlace, SajdaInfo, SajdaKind,
    SurahInfo,
};
use rusqlite::{Connection, OptionalExtension};

use crate::{CoreError, Result};

pub(super) fn build(conn: &Connection) -> Result<QuranIndex> {
    Ok(QuranIndex {
        surahs: surahs(conn)?,
        juz: divisions(conn, Table::Juz)?,
        hizb: divisions(conn, Table::Hizb)?,
        rub: divisions(conn, Table::Rub)?,
        manzil: divisions(conn, Table::Manzil)?,
        sajdas: sajdas(conn)?,
        layouts: MushafLayout::ALL
            .into_iter()
            .map(|layout| layout_info(conn, layout))
            .collect::<Result<_>>()?,
        ayah_first_word: ayah_first_word(conn)?,
    })
}

/// Fails unless the ids are `1, 2, …, n` in order.
fn check_contiguous(what: &str, ids: impl IntoIterator<Item = u32>) -> Result<()> {
    for (expected, id) in (1u32..).zip(ids) {
        if id != expected {
            return Err(CoreError::Corrupt(format!(
                "{what} ids are not contiguous: found {id} where {expected} was expected"
            )));
        }
    }
    Ok(())
}

fn revelation_place(value: &str, surah: u32) -> Result<RevelationPlace> {
    match value {
        "makkah" => Ok(RevelationPlace::Makkah),
        "madinah" => Ok(RevelationPlace::Madinah),
        other => Err(CoreError::Corrupt(format!(
            "surah {surah} has revelation_place {other:?}"
        ))),
    }
}

fn surahs(conn: &Connection) -> Result<Vec<SurahInfo>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, name_ar, name_simple, name_complex, name_en, revelation_place, revelation_order, ayah_count,
                first_ayah_id, bismillah_pre, header_cp
         FROM surah ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, u32>(6)?,
                r.get::<_, u32>(7)?,
                r.get::<_, u32>(8)?,
                r.get::<_, bool>(9)?,
                r.get::<_, Option<u32>>(10)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let surahs = rows
        .into_iter()
        .map(
            |(
                id,
                name_ar,
                name_simple,
                name_complex,
                name_en,
                place,
                revelation_order,
                ayah_count,
                first_ayah_id,
                bismillah_pre,
                header_cp,
            )| {
                Ok(SurahInfo {
                    id,
                    name_ar,
                    name_simple,
                    name_complex,
                    name_en,
                    revelation_place: revelation_place(&place, id)?,
                    revelation_order,
                    ayah_count,
                    first_ayah_id,
                    bismillah_pre,
                    header_cp,
                })
            },
        )
        .collect::<Result<Vec<_>>>()?;
    check_contiguous("surah", surahs.iter().map(|s| s.id))?;
    Ok(surahs)
}

/// The four division tables with the `(id, first_ayah_id, last_ayah_id)` shape.
#[derive(Debug, Clone, Copy)]
enum Table {
    Juz,
    Hizb,
    Rub,
    Manzil,
}

impl Table {
    const fn sql(self) -> &'static str {
        match self {
            Self::Juz => "SELECT id, first_ayah_id, last_ayah_id FROM juz ORDER BY id",
            Self::Hizb => "SELECT id, first_ayah_id, last_ayah_id FROM hizb ORDER BY id",
            Self::Rub => "SELECT id, first_ayah_id, last_ayah_id FROM rub ORDER BY id",
            Self::Manzil => "SELECT id, first_ayah_id, last_ayah_id FROM manzil ORDER BY id",
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Juz => "juz",
            Self::Hizb => "hizb",
            Self::Rub => "rub",
            Self::Manzil => "manzil",
        }
    }
}

fn divisions(conn: &Connection, table: Table) -> Result<Vec<Division>> {
    let mut stmt = conn.prepare_cached(table.sql())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Division {
                id: r.get(0)?,
                first_ayah_id: r.get(1)?,
                last_ayah_id: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    check_contiguous(table.name(), rows.iter().map(|d| d.id))?;
    if let Some(bad) = rows.iter().find(|d| d.first_ayah_id > d.last_ayah_id) {
        return Err(CoreError::Corrupt(format!(
            "{} {} is reversed ({}..={})",
            table.name(),
            bad.id,
            bad.first_ayah_id,
            bad.last_ayah_id
        )));
    }
    Ok(rows)
}

fn sajdas(conn: &Connection) -> Result<Vec<SajdaInfo>> {
    let mut stmt = conn.prepare_cached("SELECT id, ayah_id, kind FROM sajda ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, ayah_id, kind)| {
            let kind = match kind.as_str() {
                "recommended" => SajdaKind::Recommended,
                "obligatory" => SajdaKind::Obligatory,
                other => {
                    return Err(CoreError::Corrupt(format!("sajda {id} has kind {other:?}")));
                }
            };
            Ok(SajdaInfo { id, ayah_id, kind })
        })
        .collect()
}

fn layout_info(conn: &Connection, layout: MushafLayout) -> Result<LayoutInfo> {
    let (pages, lines_per_page) = conn
        .prepare_cached("SELECT pages, lines_per_page FROM mushaf WHERE id = ?1")?
        .query_row([layout.db_id()], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?))
        })
        .optional()?
        .ok_or_else(|| {
            CoreError::Corrupt(format!(
                "core.db has no mushaf row {} ({layout:?})",
                layout.db_id()
            ))
        })?;
    let mut stmt = conn.prepare_cached(
        "SELECT page, first_ayah_id, first_word_id FROM page WHERE mushaf_id = ?1 ORDER BY page",
    )?;
    let rows = stmt
        .query_map([layout.db_id()], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, u32>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    check_contiguous(&format!("{layout:?} page"), rows.iter().map(|r| r.0))?;
    if usize::try_from(pages).ok() != Some(rows.len()) {
        return Err(CoreError::Corrupt(format!(
            "{layout:?} has {} page rows, mushaf.pages = {pages}",
            rows.len()
        )));
    }
    Ok(LayoutInfo {
        layout,
        pages,
        lines_per_page,
        page_first_ayah: rows.iter().map(|r| r.1).collect(),
        page_first_word: rows.iter().map(|r| r.2).collect(),
    })
}

fn ayah_first_word(conn: &Connection) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare_cached("SELECT id, first_word_id FROM ayah ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    check_contiguous("ayah", rows.iter().map(|r| r.0))?;
    Ok(rows.into_iter().map(|r| r.1).collect())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::super::mini_core;
    use super::*;
    use crate::CoreDb;

    #[test]
    fn the_mini_index_matches_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let index = CoreDb::open(&mini.path).unwrap().index().unwrap();
        assert_eq!(index.surahs.len(), 3);
        let fatihah = &index.surahs[0];
        assert_eq!(
            (
                fatihah.name_simple.as_str(),
                fatihah.name_ar.as_str(),
                fatihah.revelation_place
            ),
            ("Al-Fatihah", "الفاتحة", RevelationPlace::Makkah)
        );
        assert!(!fatihah.bismillah_pre);
        assert_eq!(fatihah.header_cp, Some(0xFC45));
        assert_eq!(index.surahs[2].header_cp, None);
        assert_eq!(index.surahs[1].revelation_place, RevelationPlace::Madinah);
        for (info, model) in index.surahs.iter().zip(&mini.surahs) {
            assert_eq!(
                (
                    info.id,
                    info.ayah_count,
                    info.first_ayah_id,
                    info.revelation_order
                ),
                (
                    model.id,
                    model.ayah_count(),
                    model.first_ayah_id,
                    model.revelation_order
                )
            );
        }
        let ranges = |d: &[Division]| {
            d.iter()
                .map(|d| (d.first_ayah_id, d.last_ayah_id))
                .collect::<Vec<_>>()
        };
        let model_ranges = |d: &[mini_core::Division]| {
            d.iter()
                .map(|d| (d.first_ayah_id, d.last_ayah_id))
                .collect::<Vec<_>>()
        };
        assert_eq!(ranges(&index.juz), model_ranges(&mini.juz));
        assert_eq!(ranges(&index.hizb), model_ranges(&mini.hizb));
        assert_eq!(ranges(&index.rub), model_ranges(&mini.rub));
        assert_eq!(ranges(&index.manzil), model_ranges(&mini.manzil));
        assert_eq!(
            index.sajdas,
            vec![
                SajdaInfo {
                    id: 1,
                    ayah_id: 27,
                    kind: SajdaKind::Recommended
                },
                SajdaInfo {
                    id: 2,
                    ayah_id: 38,
                    kind: SajdaKind::Obligatory
                },
            ]
        );
        let layouts: Vec<_> = index.layouts.iter().map(|l| l.layout).collect();
        assert_eq!(layouts, MushafLayout::ALL.to_vec());
        for info in &index.layouts {
            let model = mini.layout(info.layout.db_id());
            assert_eq!((info.pages, info.lines_per_page), (mini_core::PAGES, 15));
            let first_ayahs: Vec<u32> = model.pages.iter().map(|p| p.first_ayah_id).collect();
            let first_words: Vec<u32> = model.pages.iter().map(|p| p.first_word_id).collect();
            assert_eq!(info.page_first_ayah, first_ayahs);
            assert_eq!(info.page_first_word, first_words);
        }
        assert_ne!(
            index.layouts[0].page_first_ayah, index.layouts[1].page_first_ayah,
            "v1 breaks pages differently"
        );
        assert_eq!(
            index.layouts[0].page_first_ayah, index.layouts[2].page_first_ayah,
            "G10: v4 == v2"
        );
        let firsts: Vec<u32> = mini.ayahs.iter().map(|a| a.first_word_id).collect();
        assert_eq!(index.ayah_first_word, firsts);
    }

    fn mini_conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.db");
        mini_core::write(&mini_core::model(), &path);
        let conn = Connection::open(&path).unwrap();
        (dir, conn)
    }

    #[test]
    fn broken_tables_are_reported_as_corrupt() {
        let cases = [
            "DELETE FROM surah WHERE id = 2",
            "UPDATE surah SET revelation_place = 'mecca' WHERE id = 1",
            "DELETE FROM juz WHERE id = 1",
            "UPDATE rub SET first_ayah_id = 40 WHERE id = 3",
            "UPDATE sajda SET kind = 'optional' WHERE id = 1",
            "DELETE FROM mushaf WHERE id = 19",
            "DELETE FROM page WHERE mushaf_id = 2 AND page = 3",
            "UPDATE mushaf SET pages = 5 WHERE id = 1",
            "DELETE FROM ayah WHERE id = 12",
        ];
        for sql in cases {
            let (_dir, conn) = mini_conn();
            // These edits break foreign keys (enforced by default in the bundled SQLite) and CHECKs on purpose.
            conn.execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;")
                .unwrap();
            conn.execute(sql, []).unwrap();
            let err = build(&conn).unwrap_err();
            assert!(matches!(err, CoreError::Corrupt(_)), "{sql}: {err:?}");
        }
        let (_dir, conn) = mini_conn();
        assert!(build(&conn).is_ok());
    }

    #[test]
    fn contiguity_is_checked_from_one() {
        assert!(check_contiguous("x", [1, 2, 3]).is_ok());
        assert!(check_contiguous("x", []).is_ok());
        assert!(check_contiguous("x", [2, 3]).is_err());
        assert!(check_contiguous("x", [1, 3]).is_err());
    }
}
