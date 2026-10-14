//! Bookmarks and the single movable reading bookmark.
//!
//! **Bookmarks** mark an ayah (`kind = ayah`) or a page of one layout (`kind = page`; `ayah_id` is the first ayah on
//! that page). There is at most one live bookmark per ayah and per (layout, page), so every "upsert" is keyed by that
//! target:
//! - `id: None` creates, or updates the live bookmark that already marks the same target (input wins: label,
//!   collections, tags). `id: Some` updates that live bookmark; moving it onto a target another live bookmark holds is
//!   `InvalidArgument`. An ayah bookmark ignores `layout`/`page` (stored as NULL).
//! - Labels are one line (whitespace collapsed), at most [`LABEL_MAX_CHARS`] characters; blank means none.
//!   `collection_ids`/`tag_ids` are applied exactly (see `collections.rs`, `tags.rs`); unknown ids are `NotFound` and
//!   nothing is written.
//! - **Tombstones and undo.** Delete sets `deleted_at` and returns the bookmark as it was; restore clears it (and bumps
//!   `updated_at`, so the change is newer than the delete). Restoring onto a target that another live bookmark took in
//!   the meantime is `InvalidArgument`. Restoring a live bookmark returns it unchanged.
//! - **Toggle** ([`UserDb::bookmark_toggle_ayah`]): a live ayah bookmark is tombstoned (`active = false`, undo =
//!   restore). Otherwise the most recently deleted bookmark of that ayah is revived with its label, collections and
//!   tags, or a new one is created (`active = true`, undo = delete).
//! - **List order:** most recently updated first (then id). `limit = 0` returns nothing. `surah` filters on `ayah_id`
//!   (a page bookmark belongs to the surah of its first ayah).
//!
//! **The reading bookmark** is one row (`id = 1`). [`UserDb::reading_bookmark_set`] returns the previous position too
//! (the undo of a move is setting it back); [`UserDb::reading_bookmark_clear`] removes it and returns it (the undo of a
//! first set). An unreadable row (never written by this crate) reads as no reading bookmark.

use std::sync::LazyLock;

use quran_types::{
    AYAH_COUNT, Bookmark, BookmarkFilter, BookmarkInput, BookmarkKind, BookmarkToggle,
    MushafLayout, PAGE_COUNT, ReadingBookmark, ReadingBookmarkInput, ReadingBookmarkMove,
    TaggableKind,
};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::collections::{require_live_collections, set_bookmark_collections};
use super::tags::{
    LABEL_MAX_CHARS, dedupe_ids, ids_from_json, opt_single_line, replace_item_tags,
    require_live_tags, tags_json_sql,
};
use super::{UserDb, check_ayah, check_page, col_u32, layout_from_db, ms_to_secs, new_id};
use crate::content_db::geometry::{ayah_ref, surah_ayah_ids};
use crate::{CoreError, Result};

/// The live collections of bookmark `b` as a JSON array, in collection order.
const COLLECTIONS_JSON: &str = "(SELECT json_group_array(c.id ORDER BY c.sort_key, c.name COLLATE NOCASE, c.id) \
    FROM collection_item ci JOIN collection c ON c.id = ci.collection_id AND c.deleted_at IS NULL \
    WHERE ci.bookmark_id = b.id)";

/// Every bookmark column plus its collections and tags; callers append `WHERE …`.
static SELECT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT b.id, b.kind, b.ayah_id, b.mushaf_id, b.page, b.label, b.created_at, b.updated_at, b.deleted_at, \
         {COLLECTIONS_JSON}, {tags} FROM bookmark b",
        tags = tags_json_sql(TaggableKind::Bookmark, "b.id")
    )
});

/// The filtered page of ids is chosen first (materialised), so the collection and tag subqueries run only for the
/// rows returned, not for every candidate of the sort.
static LIST: LazyLock<String> = LazyLock::new(|| {
    format!(
        "WITH hit AS MATERIALIZED (
           SELECT x.id, x.updated_at FROM bookmark x
           WHERE x.deleted_at IS NULL
             AND (?1 IS NULL OR x.kind = ?1)
             AND (?2 IS NULL OR EXISTS (SELECT 1 FROM collection_item ci
                   JOIN collection c ON c.id = ci.collection_id AND c.deleted_at IS NULL
                   WHERE ci.bookmark_id = x.id AND ci.collection_id = ?2))
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM item_tag it
                   JOIN tag t ON t.id = it.tag_id AND t.deleted_at IS NULL
                   WHERE it.item_kind = 'bookmark' AND it.item_id = x.id AND it.tag_id = ?3))
             AND x.ayah_id BETWEEN ?4 AND ?5
           ORDER BY x.updated_at DESC, x.id DESC
           LIMIT ?6)
         {select} JOIN hit ON hit.id = b.id
         ORDER BY hit.updated_at DESC, hit.id DESC",
        select = *SELECT
    )
});

static BY_ID: LazyLock<String> = LazyLock::new(|| format!("{} WHERE b.id = ?1", *SELECT));

const fn kind_str(kind: BookmarkKind) -> &'static str {
    match kind {
        BookmarkKind::Ayah => "ayah",
        BookmarkKind::Page => "page",
    }
}

/// What a bookmark marks; at most one live bookmark per target (the `bookmark_*_u` indexes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Ayah(u32),
    Page(MushafLayout, u32),
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ayah(ayah) => write!(f, "ayah {ayah}"),
            Self::Page(layout, page) => write!(f, "page {page} of layout {layout:?}"),
        }
    }
}

/// One `bookmark` row as read by [`SELECT`].
struct RawBookmark {
    id: String,
    kind: String,
    ayah_id: i64,
    mushaf_id: Option<i64>,
    page: Option<i64>,
    label: Option<String>,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    collections: Option<String>,
    tags: Option<String>,
}

impl RawBookmark {
    fn read(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            kind: r.get(1)?,
            ayah_id: r.get(2)?,
            mushaf_id: r.get(3)?,
            page: r.get(4)?,
            label: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
            deleted_at: r.get(8)?,
            collections: r.get(9)?,
            tags: r.get(10)?,
        })
    }

    /// The DTO and whether the row is tombstoned.
    fn into_dto(self) -> Result<(Bookmark, bool)> {
        let kind = match self.kind.as_str() {
            "ayah" => BookmarkKind::Ayah,
            "page" => BookmarkKind::Page,
            other => {
                return Err(CoreError::Corrupt(format!(
                    "bookmark {}: unknown kind {other:?}",
                    self.id
                )));
            }
        };
        let ayah_id = col_u32(self.ayah_id, "bookmark.ayah_id")?;
        let (surah, ayah) = ayah_ref(ayah_id).ok_or_else(|| {
            CoreError::Corrupt(format!("bookmark {}: ayah {ayah_id} out of range", self.id))
        })?;
        let page = match kind {
            BookmarkKind::Ayah => None,
            BookmarkKind::Page => super::opt_col_u32(self.page, "bookmark.page")?,
        };
        let layout = match kind {
            BookmarkKind::Ayah => None,
            BookmarkKind::Page => layout_from_db(self.mushaf_id),
        };
        let bookmark = Bookmark {
            kind,
            ayah_id,
            surah,
            ayah,
            layout,
            page,
            label: self.label,
            collection_ids: ids_from_json(self.collections, "bookmark collections")?,
            tag_ids: ids_from_json(self.tags, "bookmark tags")?,
            created_at: ms_to_secs(self.created_at),
            updated_at: ms_to_secs(self.updated_at),
            id: self.id,
        };
        Ok((bookmark, self.deleted_at.is_some()))
    }
}

/// The bookmark `id` and whether it is tombstoned, or `None`.
fn load_any(c: &Connection, id: &str) -> Result<Option<(Bookmark, bool)>> {
    c.prepare_cached(&BY_ID)?
        .query_row([id], RawBookmark::read)
        .optional()?
        .map(RawBookmark::into_dto)
        .transpose()
}

/// The live bookmark `id`; `NotFound` when it is missing or tombstoned.
pub(super) fn load_live_bookmark(c: &Connection, id: &str) -> Result<Bookmark> {
    match load_any(c, id)? {
        Some((bookmark, false)) => Ok(bookmark),
        _ => Err(CoreError::NotFound(format!("bookmark {id}"))),
    }
}

/// The live bookmark on `target`, if any.
fn live_on_target(c: &Connection, target: Target) -> Result<Option<String>> {
    let id = match target {
        Target::Ayah(ayah_id) => c
            .prepare_cached(
                "SELECT id FROM bookmark WHERE kind = 'ayah' AND deleted_at IS NULL AND ayah_id = ?1",
            )?
            .query_row([ayah_id], |r| r.get(0))
            .optional()?,
        Target::Page(layout, page) => c
            .prepare_cached(
                "SELECT id FROM bookmark WHERE kind = 'page' AND deleted_at IS NULL AND mushaf_id = ?1 AND page = ?2",
            )?
            .query_row([layout.db_id(), page], |r| r.get(0))
            .optional()?,
    };
    Ok(id)
}

/// What a stored bookmark marks.
fn target_of(b: &Bookmark) -> Result<Target> {
    match (b.kind, b.layout, b.page) {
        (BookmarkKind::Ayah, _, _) => Ok(Target::Ayah(b.ayah_id)),
        (BookmarkKind::Page, Some(layout), Some(page)) => Ok(Target::Page(layout, page)),
        (BookmarkKind::Page, _, _) => Err(CoreError::Corrupt(format!(
            "page bookmark {} has no readable layout or page",
            b.id
        ))),
    }
}

fn set_deleted(c: &Connection, id: &str, deleted_at: Option<i64>, now: i64) -> Result<()> {
    c.prepare_cached("UPDATE bookmark SET deleted_at = ?2, updated_at = ?3 WHERE id = ?1")?
        .execute(params![id, deleted_at, now])?;
    Ok(())
}

/// A validated [`BookmarkInput`].
struct Valid {
    kind: BookmarkKind,
    ayah_id: u32,
    target: Target,
    label: Option<String>,
    collection_ids: Vec<String>,
    tag_ids: Vec<String>,
}

impl Valid {
    fn new(input: &BookmarkInput) -> Result<Self> {
        check_ayah(input.ayah_id, "bookmark ayah")?;
        let target = match input.kind {
            BookmarkKind::Ayah => Target::Ayah(input.ayah_id),
            BookmarkKind::Page => {
                let (Some(layout), Some(page)) = (input.layout, input.page) else {
                    return Err(CoreError::InvalidArgument(
                        "a page bookmark needs a layout and a page".into(),
                    ));
                };
                check_page(Some(page))?;
                Target::Page(layout, page)
            }
        };
        Ok(Self {
            kind: input.kind,
            ayah_id: input.ayah_id,
            target,
            label: opt_single_line(input.label.as_deref(), LABEL_MAX_CHARS, "bookmark label")?,
            collection_ids: dedupe_ids(&input.collection_ids, "collections")?,
            tag_ids: dedupe_ids(&input.tag_ids, "tags")?,
        })
    }

    /// `(mushaf_id, page)` columns.
    fn page_columns(&self) -> (Option<u32>, Option<u32>) {
        match self.target {
            Target::Ayah(_) => (None, None),
            Target::Page(layout, page) => (Some(layout.db_id()), Some(page)),
        }
    }
}

fn insert(c: &Connection, id: &str, v: &Valid, now: i64) -> Result<()> {
    let (mushaf_id, page) = v.page_columns();
    c.prepare_cached(
        "INSERT INTO bookmark (id, kind, ayah_id, mushaf_id, page, label, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )?
    .execute(params![
        id,
        kind_str(v.kind),
        v.ayah_id,
        mushaf_id,
        page,
        v.label,
        now
    ])?;
    Ok(())
}

fn update(c: &Connection, id: &str, v: &Valid, now: i64) -> Result<()> {
    let (mushaf_id, page) = v.page_columns();
    let changed = c
        .prepare_cached(
            "UPDATE bookmark SET kind = ?2, ayah_id = ?3, mushaf_id = ?4, page = ?5, label = ?6, updated_at = ?7
             WHERE id = ?1 AND deleted_at IS NULL",
        )?
        .execute(params![id, kind_str(v.kind), v.ayah_id, mushaf_id, page, v.label, now])?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("bookmark {id}")));
    }
    Ok(())
}

/// The reading bookmark row, if present and readable.
fn read_ribbon(c: &Connection) -> Result<Option<ReadingBookmark>> {
    let row: Option<(i64, i64, i64, i64)> = c
        .prepare_cached(
            "SELECT ayah_id, mushaf_id, page, updated_at FROM reading_bookmark WHERE id = 1",
        )?
        .query_row([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?;
    let Some((ayah_id, mushaf_id, page, updated_at)) = row else {
        return Ok(None);
    };
    let ayah_id = u32::try_from(ayah_id)
        .ok()
        .filter(|a| (1..=AYAH_COUNT).contains(a));
    let page = u32::try_from(page)
        .ok()
        .filter(|p| (1..=PAGE_COUNT).contains(p));
    match (ayah_id, layout_from_db(Some(mushaf_id)), page) {
        (Some(ayah_id), Some(layout), Some(page)) => Ok(Some(ReadingBookmark {
            ayah_id,
            layout,
            page,
            updated_at: ms_to_secs(updated_at),
        })),
        _ => {
            log::warn!("user.db: the reading bookmark row is unreadable; ignoring it");
            Ok(None)
        }
    }
}

impl UserDb {
    /// Live bookmarks matching the filter, most recently updated first (see the module docs).
    pub fn bookmarks_list(&self, f: &BookmarkFilter) -> Result<Vec<Bookmark>> {
        let (first, last) = match f.surah {
            None => (1, AYAH_COUNT),
            Some(surah) => surah_ayah_ids(surah)
                .map(|r| (*r.start(), *r.end()))
                .ok_or_else(|| {
                    CoreError::InvalidArgument(format!("surah {surah} is out of range (1..=114)"))
                })?,
        };
        let raws = self.with(|c| {
            let mut stmt = c.prepare_cached(&LIST)?;
            let rows = stmt
                .query_map(
                    params![
                        f.kind.map(kind_str),
                        f.collection_id,
                        f.tag_id,
                        first,
                        last,
                        f.limit
                    ],
                    RawBookmark::read,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        raws.into_iter()
            .map(|raw| raw.into_dto().map(|(bookmark, _)| bookmark))
            .collect()
    }

    /// The live bookmark `id` (missing or deleted: `NotFound`).
    pub fn bookmark_get(&self, id: &str) -> Result<Bookmark> {
        self.with(|c| load_live_bookmark(c, id))
    }

    /// Creates or updates a bookmark keyed by its target (see the module docs); returns the stored row.
    pub fn bookmark_upsert(&self, input: &BookmarkInput) -> Result<Bookmark> {
        let v = Valid::new(input)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            require_live_collections(tx, &v.collection_ids)?;
            require_live_tags(tx, &v.tag_ids)?;
            let holder = live_on_target(tx, v.target)?;
            let id = match &input.id {
                None => match holder {
                    Some(existing) => {
                        update(tx, &existing, &v, now)?;
                        existing
                    }
                    None => {
                        let id = new_id();
                        insert(tx, &id, &v, now)?;
                        id
                    }
                },
                Some(id) => {
                    // A missing or deleted id is NotFound even when its new target is taken.
                    load_live_bookmark(tx, id)?;
                    if holder.as_ref().is_some_and(|other| other != id) {
                        return Err(CoreError::InvalidArgument(format!(
                            "{} already has another bookmark",
                            v.target
                        )));
                    }
                    update(tx, id, &v, now)?;
                    id.clone()
                }
            };
            set_bookmark_collections(tx, &id, &v.collection_ids, now)?;
            replace_item_tags(tx, TaggableKind::Bookmark, &id, &v.tag_ids)?;
            load_live_bookmark(tx, &id)
        })
    }

    /// Tombstones the live bookmark of `ayah_id`, or revives/creates one (see the module docs).
    pub fn bookmark_toggle_ayah(&self, ayah_id: u32) -> Result<BookmarkToggle> {
        check_ayah(ayah_id, "ayah")?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            if let Some(id) = live_on_target(tx, Target::Ayah(ayah_id))? {
                let bookmark = load_live_bookmark(tx, &id)?;
                set_deleted(tx, &id, Some(now), now)?;
                return Ok(BookmarkToggle {
                    bookmark,
                    active: false,
                });
            }
            let revived: Option<String> = tx
                .prepare_cached(
                    "SELECT id FROM bookmark WHERE kind = 'ayah' AND ayah_id = ?1 AND deleted_at IS NOT NULL
                     ORDER BY deleted_at DESC, id DESC LIMIT 1",
                )?
                .query_row([ayah_id], |r| r.get(0))
                .optional()?;
            let id = match revived {
                Some(id) => {
                    set_deleted(tx, &id, None, now)?;
                    id
                }
                None => {
                    let id = new_id();
                    tx.prepare_cached(
                        "INSERT INTO bookmark (id, kind, ayah_id, created_at, updated_at) VALUES (?1, 'ayah', ?2, ?3, ?3)",
                    )?
                    .execute(params![id, ayah_id, now])?;
                    id
                }
            };
            Ok(BookmarkToggle {
                bookmark: load_live_bookmark(tx, &id)?,
                active: true,
            })
        })
    }

    /// Tombstones a live bookmark and returns it as it was (missing or already deleted: `NotFound`).
    pub fn bookmark_delete(&self, id: &str) -> Result<Bookmark> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let bookmark = load_live_bookmark(tx, id)?;
            set_deleted(tx, id, Some(now), now)?;
            Ok(bookmark)
        })
    }

    /// Clears the tombstone of a bookmark (a live one is returned unchanged; missing: `NotFound`; its target taken by
    /// another live bookmark: `InvalidArgument`).
    pub fn bookmark_restore(&self, id: &str) -> Result<Bookmark> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let (bookmark, deleted) =
                load_any(tx, id)?.ok_or_else(|| CoreError::NotFound(format!("bookmark {id}")))?;
            if !deleted {
                return Ok(bookmark);
            }
            let target = target_of(&bookmark)?;
            if live_on_target(tx, target)?.is_some() {
                return Err(CoreError::InvalidArgument(format!(
                    "{target} already has another bookmark"
                )));
            }
            set_deleted(tx, id, None, now)?;
            load_live_bookmark(tx, id)
        })
    }

    /// The reading bookmark, if set.
    pub fn reading_bookmark_get(&self) -> Result<Option<ReadingBookmark>> {
        self.with(read_ribbon)
    }

    /// Moves (or first sets) the reading bookmark; returns where it was and where it is now.
    pub fn reading_bookmark_set(
        &self,
        input: &ReadingBookmarkInput,
    ) -> Result<ReadingBookmarkMove> {
        check_ayah(input.ayah_id, "reading bookmark ayah")?;
        check_page(Some(input.page))?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            let previous = read_ribbon(tx)?;
            tx.prepare_cached(
                "INSERT INTO reading_bookmark (id, ayah_id, mushaf_id, page, updated_at) VALUES (1, ?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET ayah_id = excluded.ayah_id, mushaf_id = excluded.mushaf_id,
                   page = excluded.page, updated_at = excluded.updated_at",
            )?
            .execute(params![input.ayah_id, input.layout.db_id(), input.page, now])?;
            Ok(ReadingBookmarkMove {
                previous,
                current: ReadingBookmark {
                    ayah_id: input.ayah_id,
                    layout: input.layout,
                    page: input.page,
                    updated_at: ms_to_secs(now),
                },
            })
        })
    }

    /// Removes the reading bookmark and returns it (the undo of a first set); `None` when there was none.
    pub fn reading_bookmark_clear(&self) -> Result<Option<ReadingBookmark>> {
        self.with_tx(|tx| {
            let previous = read_ribbon(tx)?;
            tx.prepare_cached("DELETE FROM reading_bookmark WHERE id = 1")?
                .execute([])?;
            Ok(previous)
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{CollectionInput, TagInput};

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn ayah(ayah_id: u32) -> BookmarkInput {
        BookmarkInput {
            id: None,
            kind: BookmarkKind::Ayah,
            ayah_id,
            layout: None,
            page: None,
            label: None,
            collection_ids: Vec::new(),
            tag_ids: Vec::new(),
        }
    }

    fn page(layout: MushafLayout, page: u32, first_ayah: u32) -> BookmarkInput {
        BookmarkInput {
            kind: BookmarkKind::Page,
            layout: Some(layout),
            page: Some(page),
            ..ayah(first_ayah)
        }
    }

    fn all() -> BookmarkFilter {
        BookmarkFilter {
            kind: None,
            collection_id: None,
            tag_id: None,
            surah: None,
            limit: 1_000,
        }
    }

    fn at(db: &UserDb, secs: i64) {
        db.set_test_clock(Some(T0 + secs * 1_000));
    }

    #[test]
    fn create_reads_back_with_its_reference() {
        let (_dir, db) = temp_db();
        let kursi = db
            .bookmark_upsert(&BookmarkInput {
                label: Some("  Ayat\nal-Kursi ".into()),
                layout: Some(MushafLayout::V2),
                page: Some(42),
                ..ayah(262)
            })
            .unwrap();
        assert_eq!(
            uuid::Uuid::parse_str(&kursi.id).unwrap().get_version_num(),
            7
        );
        assert_eq!(
            (kursi.kind, kursi.ayah_id, kursi.surah, kursi.ayah),
            (BookmarkKind::Ayah, 262, 2, 255)
        );
        assert_eq!(
            (kursi.layout, kursi.page),
            (None, None),
            "ayah bookmarks ignore layout/page"
        );
        assert_eq!(kursi.label.as_deref(), Some("Ayat al-Kursi"));
        assert_eq!(
            (kursi.created_at, kursi.updated_at),
            (1_700_000_000, 1_700_000_000)
        );
        let p = db
            .bookmark_upsert(&page(MushafLayout::V4, 50, 300))
            .unwrap();
        assert_eq!(
            (p.layout, p.page, p.surah, p.ayah),
            (Some(MushafLayout::V4), Some(50), 3, 7)
        );
        assert_eq!(db.bookmark_get(&p.id).unwrap(), p);
    }

    #[test]
    fn upsert_is_keyed_by_target() {
        let (_dir, db) = temp_db();
        let first = db.bookmark_upsert(&ayah(10)).unwrap();
        at(&db, 5);
        // Creating on the same ayah updates the existing bookmark (input wins).
        let again = db
            .bookmark_upsert(&BookmarkInput {
                label: Some("note".into()),
                ..ayah(10)
            })
            .unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(
            (again.label.as_deref(), again.updated_at),
            (Some("note"), 1_700_000_005)
        );
        assert_eq!(again.created_at, first.created_at);
        // The same page in another layout is another target.
        let v2 = db.bookmark_upsert(&page(MushafLayout::V2, 3, 10)).unwrap();
        let v1 = db.bookmark_upsert(&page(MushafLayout::V1, 3, 10)).unwrap();
        assert_ne!(v2.id, v1.id);
        assert_eq!(db.bookmarks_list(&all()).unwrap().len(), 3);
        // Moving a bookmark onto a target held by another is rejected.
        let clash = db.bookmark_upsert(&BookmarkInput {
            id: Some(v1.id.clone()),
            ..page(MushafLayout::V2, 3, 10)
        });
        assert!(
            matches!(clash, Err(CoreError::InvalidArgument(_))),
            "{clash:?}"
        );
        // Converting a bookmark to another kind is an update of the same row.
        let moved = db
            .bookmark_upsert(&BookmarkInput {
                id: Some(v1.id.clone()),
                ..ayah(11)
            })
            .unwrap();
        assert_eq!(
            (moved.id.as_str(), moved.kind, moved.page),
            (v1.id.as_str(), BookmarkKind::Ayah, None)
        );
    }

    #[test]
    fn invalid_input_writes_nothing() {
        let (_dir, db) = temp_db();
        for bad in [
            ayah(0),
            ayah(6237),
            BookmarkInput {
                kind: BookmarkKind::Page,
                ..ayah(1)
            },
            page(MushafLayout::V2, 605, 1),
            page(MushafLayout::V2, 0, 1),
            BookmarkInput {
                label: Some("x".repeat(LABEL_MAX_CHARS + 1)),
                ..ayah(1)
            },
            BookmarkInput {
                tag_ids: vec![" ".into()],
                ..ayah(1)
            },
        ] {
            let r = db.bookmark_upsert(&bad);
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{bad:?}: {r:?}"
            );
        }
        for bad in [
            BookmarkInput {
                collection_ids: vec!["missing".into()],
                ..ayah(1)
            },
            BookmarkInput {
                tag_ids: vec!["missing".into()],
                ..ayah(1)
            },
            BookmarkInput {
                id: Some("missing".into()),
                ..ayah(1)
            },
        ] {
            let r = db.bookmark_upsert(&bad);
            assert!(matches!(r, Err(CoreError::NotFound(_))), "{bad:?}: {r:?}");
        }
        assert!(db.bookmarks_list(&all()).unwrap().is_empty());
    }

    #[test]
    fn delete_restore_and_conflicts() {
        let (_dir, db) = temp_db();
        let b = db.bookmark_upsert(&ayah(5)).unwrap();
        at(&db, 1);
        let deleted = db.bookmark_delete(&b.id).unwrap();
        assert_eq!(deleted, b, "returned as it was");
        assert!(matches!(
            db.bookmark_delete(&b.id),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            db.bookmark_get(&b.id),
            Err(CoreError::NotFound(_))
        ));
        assert!(db.bookmarks_list(&all()).unwrap().is_empty());
        at(&db, 2);
        let restored = db.bookmark_restore(&b.id).unwrap();
        assert_eq!(
            (restored.id.as_str(), restored.updated_at),
            (b.id.as_str(), 1_700_000_002)
        );
        assert_eq!(
            db.bookmark_restore(&b.id).unwrap(),
            restored,
            "restoring a live bookmark is a no-op"
        );
        assert!(matches!(
            db.bookmark_restore("missing"),
            Err(CoreError::NotFound(_))
        ));
        // Another bookmark took the ayah in the meantime.
        db.bookmark_delete(&b.id).unwrap();
        let other = db.bookmark_upsert(&ayah(5)).unwrap();
        assert_ne!(other.id, b.id);
        let clash = db.bookmark_restore(&b.id);
        assert!(
            matches!(clash, Err(CoreError::InvalidArgument(_))),
            "{clash:?}"
        );
        // Editing the deleted one is NotFound, whatever its target.
        let stale = db.bookmark_upsert(&BookmarkInput {
            id: Some(b.id.clone()),
            ..ayah(5)
        });
        assert!(matches!(stale, Err(CoreError::NotFound(_))), "{stale:?}");
    }

    #[test]
    fn toggle_tombstones_revives_and_creates() {
        let (_dir, db) = temp_db();
        let tag = db
            .tag_upsert(&TagInput {
                id: None,
                name: "t".into(),
                color: None,
            })
            .unwrap();
        let on = db.bookmark_toggle_ayah(262).unwrap();
        assert!(on.active);
        db.bookmark_upsert(&BookmarkInput {
            label: Some("Kursi".into()),
            tag_ids: vec![tag.id.clone()],
            ..ayah(262)
        })
        .unwrap();
        at(&db, 1);
        let off = db.bookmark_toggle_ayah(262).unwrap();
        assert!(!off.active);
        assert_eq!(
            (off.bookmark.id.as_str(), off.bookmark.label.as_deref()),
            (on.bookmark.id.as_str(), Some("Kursi"))
        );
        assert!(db.bookmarks_list(&all()).unwrap().is_empty());
        at(&db, 2);
        let revived = db.bookmark_toggle_ayah(262).unwrap();
        assert!(revived.active);
        assert_eq!(
            revived.bookmark.id, on.bookmark.id,
            "the deleted bookmark comes back"
        );
        assert_eq!(revived.bookmark.label.as_deref(), Some("Kursi"));
        assert_eq!(revived.bookmark.tag_ids, [tag.id]);
        assert_eq!(revived.bookmark.updated_at, 1_700_000_002);
        // Undo of a toggle-on is a delete; undo of a toggle-off is a restore.
        db.bookmark_delete(&revived.bookmark.id).unwrap();
        db.bookmark_restore(&revived.bookmark.id).unwrap();
        assert_eq!(db.bookmarks_list(&all()).unwrap().len(), 1);
        assert!(matches!(
            db.bookmark_toggle_ayah(0),
            Err(CoreError::InvalidArgument(_))
        ));
    }

    #[test]
    fn list_filters_order_and_limit() {
        let (_dir, db) = temp_db();
        let duas = db
            .collection_upsert(&CollectionInput {
                id: None,
                name: "Duas".into(),
                color: None,
                sort_key: 0,
            })
            .unwrap();
        let tag = db
            .tag_upsert(&TagInput {
                id: None,
                name: "tag".into(),
                color: None,
            })
            .unwrap();
        let fatiha = db.bookmark_upsert(&ayah(1)).unwrap();
        at(&db, 1);
        let kursi = db
            .bookmark_upsert(&BookmarkInput {
                collection_ids: vec![duas.id.clone()],
                ..ayah(262)
            })
            .unwrap();
        at(&db, 2);
        let p = db
            .bookmark_upsert(&BookmarkInput {
                tag_ids: vec![tag.id.clone()],
                ..page(MushafLayout::V2, 2, 8)
            })
            .unwrap();
        let ids = |f: BookmarkFilter| -> Vec<String> {
            db.bookmarks_list(&f)
                .unwrap()
                .into_iter()
                .map(|b| b.id)
                .collect()
        };
        assert_eq!(
            ids(all()),
            [p.id.clone(), kursi.id.clone(), fatiha.id.clone()]
        );
        assert_eq!(
            ids(BookmarkFilter { limit: 2, ..all() }),
            [p.id.clone(), kursi.id.clone()]
        );
        assert!(ids(BookmarkFilter { limit: 0, ..all() }).is_empty());
        assert_eq!(
            ids(BookmarkFilter {
                kind: Some(BookmarkKind::Ayah),
                ..all()
            }),
            [kursi.id.clone(), fatiha.id.clone()]
        );
        assert_eq!(
            ids(BookmarkFilter {
                surah: Some(2),
                ..all()
            }),
            [p.id.clone(), kursi.id.clone()]
        );
        assert_eq!(
            ids(BookmarkFilter {
                surah: Some(1),
                ..all()
            }),
            [fatiha.id.as_str()]
        );
        assert_eq!(
            ids(BookmarkFilter {
                collection_id: Some(duas.id.clone()),
                ..all()
            }),
            [kursi.id.as_str()]
        );
        assert_eq!(
            ids(BookmarkFilter {
                tag_id: Some(tag.id.clone()),
                ..all()
            }),
            [p.id.as_str()]
        );
        assert!(
            ids(BookmarkFilter {
                tag_id: Some("missing".into()),
                ..all()
            })
            .is_empty()
        );
        // A deleted collection or tag filters to nothing.
        db.collection_delete(&duas.id).unwrap();
        assert!(
            ids(BookmarkFilter {
                collection_id: Some(duas.id),
                ..all()
            })
            .is_empty()
        );
        for surah in [0, 115] {
            let r = db.bookmarks_list(&BookmarkFilter {
                surah: Some(surah),
                ..all()
            });
            assert!(matches!(r, Err(CoreError::InvalidArgument(_))), "{surah}");
        }
    }

    #[test]
    fn reading_bookmark_moves_and_clears() {
        let (_dir, db) = temp_db();
        assert_eq!(db.reading_bookmark_get().unwrap(), None);
        assert_eq!(db.reading_bookmark_clear().unwrap(), None);
        let first = db
            .reading_bookmark_set(&ReadingBookmarkInput {
                ayah_id: 262,
                layout: MushafLayout::V2,
                page: 42,
            })
            .unwrap();
        assert_eq!(first.previous, None);
        assert_eq!(
            first.current,
            ReadingBookmark {
                ayah_id: 262,
                layout: MushafLayout::V2,
                page: 42,
                updated_at: 1_700_000_000
            }
        );
        at(&db, 60);
        let moved = db
            .reading_bookmark_set(&ReadingBookmarkInput {
                ayah_id: 300,
                layout: MushafLayout::V1,
                page: 50,
            })
            .unwrap();
        assert_eq!(moved.previous, Some(first.current));
        assert_eq!(db.reading_bookmark_get().unwrap(), Some(moved.current));
        assert_eq!(db.reading_bookmark_clear().unwrap(), Some(moved.current));
        assert_eq!(db.reading_bookmark_get().unwrap(), None);
        for (ayah_id, page) in [(0, 1), (6237, 1), (1, 0), (1, 605)] {
            let r = db.reading_bookmark_set(&ReadingBookmarkInput {
                ayah_id,
                layout: MushafLayout::V2,
                page,
            });
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{ayah_id} {page}"
            );
        }
    }

    #[test]
    fn an_unreadable_reading_bookmark_reads_as_none() {
        let (_dir, db) = temp_db();
        db.with(|c| {
            c.execute(
                "INSERT INTO reading_bookmark (id, ayah_id, mushaf_id, page, updated_at) VALUES (1, 5, 3, 1, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(db.reading_bookmark_get().unwrap(), None);
        // Setting it again repairs the row and reports no previous position.
        let m = db
            .reading_bookmark_set(&ReadingBookmarkInput {
                ayah_id: 5,
                layout: MushafLayout::V2,
                page: 1,
            })
            .unwrap();
        assert_eq!(m.previous, None);
        assert_eq!(db.reading_bookmark_get().unwrap(), Some(m.current));
    }
}
