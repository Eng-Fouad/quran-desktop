//! Marks for rendering: one call per visible page set, five small queries (§3.2 "Marks query"). Owner: WP2a.
//!
//! - `bookmarks`: live ayah bookmarks in `[from, to]`, by ayah.
//! - `page_bookmarks`: live page bookmarks of `layout` on the given pages, by page.
//! - `highlights` / `notes`: live rows overlapping `[from, to]` (full ranges, so a pill can be clipped to the page), in
//!   mushaf order.
//! - `reading_ayah_id`: the reading bookmark's ayah when it lies in `[from, to]` (the ribbon hangs on a visible page).
//!
//! The range must be a valid ayah range and every page 1..=604 (duplicates are fine). Budget: < 3 ms (§3.5); every
//! query is an index range scan (`bookmark_ayah_u`, `bookmark_page_u`, `highlight_range`, `note_range`).

use quran_types::{AyahMark, HighlightMark, MushafLayout, NoteMark, PageMark, UserMarks};
use rusqlite::{Connection, OptionalExtension};

use super::highlights::parse_color;
use super::{UserDb, check_ayah_range, check_page, col_u32};
use crate::Result;

fn ayah_marks(c: &Connection, from: u32, to: u32) -> Result<Vec<AyahMark>> {
    let mut stmt = c.prepare_cached(
        "SELECT ayah_id, id FROM bookmark
         WHERE kind = 'ayah' AND deleted_at IS NULL AND ayah_id BETWEEN ?1 AND ?2 ORDER BY ayah_id",
    )?;
    let rows = stmt
        .query_map([from, to], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(ayah, id)| {
            Ok(AyahMark {
                ayah_id: col_u32(ayah, "bookmark.ayah_id")?,
                bookmark_id: id,
            })
        })
        .collect()
}

fn page_marks(c: &Connection, layout: MushafLayout, pages_json: &str) -> Result<Vec<PageMark>> {
    let mut stmt = c.prepare_cached(
        "SELECT page, id FROM bookmark
         WHERE kind = 'page' AND deleted_at IS NULL AND mushaf_id = ?1 AND page IN (SELECT value FROM json_each(?2))
         ORDER BY page",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![layout.db_id(), pages_json], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(page, id)| {
            Ok(PageMark {
                page: col_u32(page, "bookmark.page")?,
                bookmark_id: id,
            })
        })
        .collect()
}

fn highlight_marks(c: &Connection, from: u32, to: u32) -> Result<Vec<HighlightMark>> {
    let mut stmt = c.prepare_cached(
        "SELECT id, from_ayah_id, to_ayah_id, color FROM highlight
         WHERE deleted_at IS NULL AND from_ayah_id <= ?2 AND to_ayah_id >= ?1 ORDER BY from_ayah_id, id",
    )?;
    let rows = stmt
        .query_map([from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, from, to, color)| {
            Ok(HighlightMark {
                id,
                from_ayah_id: col_u32(from, "highlight.from_ayah_id")?,
                to_ayah_id: col_u32(to, "highlight.to_ayah_id")?,
                color: parse_color(&color)?,
            })
        })
        .collect()
}

fn note_marks(c: &Connection, from: u32, to: u32) -> Result<Vec<NoteMark>> {
    let mut stmt = c.prepare_cached(
        "SELECT id, from_ayah_id, to_ayah_id FROM note
         WHERE deleted_at IS NULL AND from_ayah_id <= ?2 AND to_ayah_id >= ?1 ORDER BY from_ayah_id, id",
    )?;
    let rows = stmt
        .query_map([from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, from, to)| {
            Ok(NoteMark {
                id,
                from_ayah_id: col_u32(from, "note.from_ayah_id")?,
                to_ayah_id: col_u32(to, "note.to_ayah_id")?,
            })
        })
        .collect()
}

fn reading_ayah(c: &Connection, from: u32, to: u32) -> Result<Option<u32>> {
    let ayah: Option<i64> = c
        .prepare_cached(
            "SELECT ayah_id FROM reading_bookmark WHERE id = 1 AND ayah_id BETWEEN ?1 AND ?2",
        )?
        .query_row([from, to], |r| r.get(0))
        .optional()?;
    ayah.map(|a| col_u32(a, "reading_bookmark.ayah_id"))
        .transpose()
}

impl UserDb {
    /// Bookmark, highlight, note and reading-ribbon marks for the visible ayah range and pages. Budget: < 3 ms (§3.5).
    pub fn marks(
        &self,
        layout: MushafLayout,
        from_ayah: u32,
        to_ayah: u32,
        pages: &[u32],
    ) -> Result<UserMarks> {
        check_ayah_range(from_ayah, to_ayah)?;
        for &page in pages {
            check_page(Some(page))?;
        }
        let pages_json = serde_json::to_string(pages)?;
        self.with(|c| {
            Ok(UserMarks {
                bookmarks: ayah_marks(c, from_ayah, to_ayah)?,
                page_bookmarks: page_marks(c, layout, &pages_json)?,
                highlights: highlight_marks(c, from_ayah, to_ayah)?,
                notes: note_marks(c, from_ayah, to_ayah)?,
                reading_ayah_id: reading_ayah(c, from_ayah, to_ayah)?,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{
        BookmarkInput, BookmarkKind, HighlightColor, HighlightInput, NoteInput,
        ReadingBookmarkInput,
    };

    use super::*;
    use crate::CoreError;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        (dir, db)
    }

    fn bookmark(
        db: &UserDb,
        kind: BookmarkKind,
        ayah_id: u32,
        page: Option<(MushafLayout, u32)>,
    ) -> String {
        db.bookmark_upsert(&BookmarkInput {
            id: None,
            kind,
            ayah_id,
            layout: page.map(|p| p.0),
            page: page.map(|p| p.1),
            label: None,
            collection_ids: Vec::new(),
            tag_ids: Vec::new(),
        })
        .unwrap()
        .id
    }

    fn note(db: &UserDb, from: u32, to: u32) -> String {
        db.note_upsert(&NoteInput {
            id: None,
            from_ayah_id: from,
            to_ayah_id: to,
            title: None,
            body: "n".into(),
            tag_ids: Vec::new(),
        })
        .unwrap()
        .id
    }

    #[test]
    fn marks_cover_the_visible_range_and_pages_only() {
        let (_dir, db) = temp_db();
        // Page 2 (V2) of al-Baqarah holds ayahs 8..=12; page 3 holds 13..=23.
        let in_range = bookmark(&db, BookmarkKind::Ayah, 10, None);
        bookmark(&db, BookmarkKind::Ayah, 30, None);
        let deleted = bookmark(&db, BookmarkKind::Ayah, 11, None);
        db.bookmark_delete(&deleted).unwrap();
        let p2 = bookmark(&db, BookmarkKind::Page, 8, Some((MushafLayout::V2, 2)));
        bookmark(&db, BookmarkKind::Page, 8, Some((MushafLayout::V1, 2)));
        bookmark(&db, BookmarkKind::Page, 24, Some((MushafLayout::V2, 4)));
        let hl = db
            .highlight_set(&HighlightInput {
                from_ayah_id: 5,
                to_ayah_id: 9,
                color: HighlightColor::Purple,
            })
            .unwrap();
        db.highlight_set(&HighlightInput {
            from_ayah_id: 24,
            to_ayah_id: 30,
            color: HighlightColor::Red,
        })
        .unwrap();
        let spanning = note(&db, 1, 300);
        let inside = note(&db, 20, 21);
        note(&db, 24, 24);
        db.reading_bookmark_set(&ReadingBookmarkInput {
            ayah_id: 15,
            layout: MushafLayout::V2,
            page: 3,
        })
        .unwrap();

        let m = db.marks(MushafLayout::V2, 8, 23, &[3, 2, 2]).unwrap();
        assert_eq!(
            m.bookmarks,
            [AyahMark {
                ayah_id: 10,
                bookmark_id: in_range
            }]
        );
        assert_eq!(
            m.page_bookmarks,
            [PageMark {
                page: 2,
                bookmark_id: p2
            }]
        );
        assert_eq!(
            m.highlights,
            [HighlightMark {
                id: hl.id,
                from_ayah_id: 5,
                to_ayah_id: 9,
                color: HighlightColor::Purple
            }]
        );
        assert_eq!(
            m.notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            [spanning.as_str(), inside.as_str()]
        );
        assert_eq!(m.reading_ayah_id, Some(15));

        let elsewhere = db.marks(MushafLayout::V2, 100, 110, &[]).unwrap();
        assert!(elsewhere.bookmarks.is_empty() && elsewhere.page_bookmarks.is_empty());
        assert!(elsewhere.highlights.is_empty());
        assert_eq!(elsewhere.notes.len(), 1, "the 1..300 note spans it");
        assert_eq!(
            elsewhere.reading_ayah_id, None,
            "the ribbon is not on these pages"
        );
    }

    #[test]
    fn marks_validate_their_input() {
        let (_dir, db) = temp_db();
        for (from, to, pages) in [
            (0, 1, vec![]),
            (5, 4, vec![]),
            (1, 6237, vec![]),
            (1, 1, vec![605]),
            (1, 1, vec![0]),
        ] {
            let r = db.marks(MushafLayout::V4, from, to, &pages);
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{from}..{to} {pages:?}"
            );
        }
        let empty = db.marks(MushafLayout::V4, 1, 6236, &[1, 604]).unwrap();
        assert_eq!(
            empty,
            UserMarks {
                bookmarks: Vec::new(),
                page_bookmarks: Vec::new(),
                highlights: Vec::new(),
                notes: Vec::new(),
                reading_ayah_id: None
            }
        );
    }
}
