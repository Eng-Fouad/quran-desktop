//! Ayah-range highlights; overlapping ranges are split or trimmed in one transaction.
//!
//! **Invariant.** Live highlights never overlap, and two live highlights of the same colour never overlap or touch. The
//! live rows are therefore exactly the maximal same-colour runs of the per-ayah colouring the user sees, and every
//! write below keeps it that way in one transaction:
//! - [`UserDb::highlight_set`] paints `[from, to]`. Other colours that overlap it are trimmed, split in two (the left
//!   piece keeps the id, the right piece is a new row with the same colour, `created_at` and tags) or tombstoned when
//!   fully covered. Same-colour rows that overlap or touch it are merged into one row: the one that starts first keeps
//!   its id, `created_at` and tags, and absorbs the others' tags (they are tombstoned). Painting inside an existing
//!   same-colour row changes nothing. Returns the stored row that covers `[from, to]`, which may be larger.
//! - [`UserDb::highlight_clear_range`] removes `[from, to]` from every overlapping row (trim, split or tombstone) and
//!   returns those rows **as they were** (full range, colour, tags), so re-setting them undoes the clear.
//! - [`UserDb::highlight_delete`] tombstones one row and returns it as it was; [`UserDb::highlight_restore`] re-applies a
//!   tombstoned row on top of whatever is there now, keeping its id (it wins over newer rows in its range and merges
//!   same-colour neighbours into itself). Restoring a live row returns it unchanged.
//!
//! The library store's undo snapshots the rows overlapping `[from, to]` before `highlight_set`, and undoes it with
//! `highlight_clear_range(from, to)` plus re-setting the snapshot; trimming and merging above make that exact.
//! Lists are in mushaf order (`from_ayah_id`).

use std::sync::LazyLock;

use quran_types::{Highlight, HighlightColor, HighlightInput, TaggableKind};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::tags::{copy_item_tags, ids_from_json, tags_json_sql};
use super::{UserDb, check_ayah_range, col_u32, ms_to_secs, new_id};
use crate::{CoreError, Result};

static SELECT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT h.id, h.from_ayah_id, h.to_ayah_id, h.color, h.created_at, h.updated_at, h.deleted_at, {tags} \
         FROM highlight h",
        tags = tags_json_sql(TaggableKind::Highlight, "h.id")
    )
});

static LIST: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} WHERE h.deleted_at IS NULL AND (?1 IS NULL OR h.color = ?1) ORDER BY h.from_ayah_id, h.id",
        *SELECT
    )
});

static BY_ID: LazyLock<String> = LazyLock::new(|| format!("{} WHERE h.id = ?1", *SELECT));

/// The stored colour name (`highlight.color`).
pub(super) const fn color_str(color: HighlightColor) -> &'static str {
    match color {
        HighlightColor::Yellow => "yellow",
        HighlightColor::Green => "green",
        HighlightColor::Blue => "blue",
        HighlightColor::Red => "red",
        HighlightColor::Purple => "purple",
    }
}

/// Inverse of [`color_str`]; anything else was not written by this crate.
pub(super) fn parse_color(s: &str) -> Result<HighlightColor> {
    Ok(match s {
        "yellow" => HighlightColor::Yellow,
        "green" => HighlightColor::Green,
        "blue" => HighlightColor::Blue,
        "red" => HighlightColor::Red,
        "purple" => HighlightColor::Purple,
        other => {
            return Err(CoreError::Corrupt(format!(
                "highlight colour {other:?} is unknown"
            )));
        }
    })
}

/// One `highlight` row as read by [`SELECT`].
struct RawHighlight {
    id: String,
    from: i64,
    to: i64,
    color: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    tags: Option<String>,
}

impl RawHighlight {
    fn read(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            from: r.get(1)?,
            to: r.get(2)?,
            color: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
            deleted_at: r.get(6)?,
            tags: r.get(7)?,
        })
    }

    /// The DTO and whether the row is tombstoned.
    fn into_dto(self) -> Result<(Highlight, bool)> {
        let highlight = Highlight {
            from_ayah_id: col_u32(self.from, "highlight.from_ayah_id")?,
            to_ayah_id: col_u32(self.to, "highlight.to_ayah_id")?,
            color: parse_color(&self.color)?,
            tag_ids: ids_from_json(self.tags, "highlight tags")?,
            created_at: ms_to_secs(self.created_at),
            updated_at: ms_to_secs(self.updated_at),
            id: self.id,
        };
        Ok((highlight, self.deleted_at.is_some()))
    }
}

fn load_any(c: &Connection, id: &str) -> Result<Option<(Highlight, bool)>> {
    c.prepare_cached(&BY_ID)?
        .query_row([id], RawHighlight::read)
        .optional()?
        .map(RawHighlight::into_dto)
        .transpose()
}

fn load_live(c: &Connection, id: &str) -> Result<Highlight> {
    match load_any(c, id)? {
        Some((highlight, false)) => Ok(highlight),
        _ => Err(CoreError::NotFound(format!("highlight {id}"))),
    }
}

/// The range and colour of one live row.
#[derive(Debug, Clone)]
struct Span {
    id: String,
    from: u32,
    to: u32,
    color: HighlightColor,
}

impl Span {
    const fn overlaps(&self, from: u32, to: u32) -> bool {
        self.from <= to && self.to >= from
    }
}

/// Live rows that overlap or touch `[from, to]`, in mushaf order.
fn spans_near(c: &Connection, from: u32, to: u32) -> Result<Vec<Span>> {
    let mut stmt = c.prepare_cached(
        "SELECT id, from_ayah_id, to_ayah_id, color FROM highlight
         WHERE deleted_at IS NULL AND from_ayah_id <= ?2 AND to_ayah_id >= ?1
         ORDER BY from_ayah_id, id",
    )?;
    let raws = stmt
        .query_map(params![from.saturating_sub(1), to.saturating_add(1)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    raws.into_iter()
        .map(|(id, from, to, color)| {
            Ok(Span {
                from: col_u32(from, "highlight.from_ayah_id")?,
                to: col_u32(to, "highlight.to_ayah_id")?,
                color: parse_color(&color)?,
                id,
            })
        })
        .collect()
}

fn set_range(c: &Connection, id: &str, from: u32, to: u32, now: i64) -> Result<()> {
    c.prepare_cached(
        "UPDATE highlight SET from_ayah_id = ?2, to_ayah_id = ?3, updated_at = ?4 WHERE id = ?1",
    )?
    .execute(params![id, from, to, now])?;
    Ok(())
}

fn set_deleted(c: &Connection, id: &str, deleted_at: Option<i64>, now: i64) -> Result<()> {
    c.prepare_cached("UPDATE highlight SET deleted_at = ?2, updated_at = ?3 WHERE id = ?1")?
        .execute(params![id, deleted_at, now])?;
    Ok(())
}

/// Removes `[from, to]` from every span in `spans` that overlaps it: trims it, splits it in two (the right piece is a
/// new row with the same colour, `created_at` and tags) or tombstones it. Returns the affected rows as they were.
fn cut(c: &Connection, spans: &[Span], from: u32, to: u32, now: i64) -> Result<Vec<Highlight>> {
    let mut before = Vec::new();
    for s in spans.iter().filter(|s| s.overlaps(from, to)) {
        before.push(load_live(c, &s.id)?);
        match (s.from < from, s.to > to) {
            (false, false) => set_deleted(c, &s.id, Some(now), now)?,
            (true, false) => set_range(c, &s.id, s.from, from - 1, now)?,
            (false, true) => set_range(c, &s.id, to + 1, s.to, now)?,
            (true, true) => {
                let right = new_id();
                c.prepare_cached(
                    "INSERT INTO highlight (id, from_ayah_id, to_ayah_id, color, created_at, updated_at)
                     SELECT ?2, ?3, ?4, color, created_at, ?5 FROM highlight WHERE id = ?1",
                )?
                .execute(params![s.id, right, to + 1, s.to, now])?;
                copy_item_tags(c, TaggableKind::Highlight, &s.id, &right)?;
                set_range(c, &s.id, s.from, from - 1, now)?;
            }
        }
    }
    Ok(before)
}

/// Paints `[from, to]` with `color` (see the module docs) and returns the id of the row that now covers it: `keep`
/// when given (a restored row), else the first same-colour neighbour, else a new row.
fn apply(
    c: &Connection,
    from: u32,
    to: u32,
    color: HighlightColor,
    now: i64,
    keep: Option<&str>,
) -> Result<String> {
    let near = spans_near(c, from, to)?;
    let (same, other): (Vec<Span>, Vec<Span>) = near
        .into_iter()
        .filter(|s| keep != Some(s.id.as_str()))
        .partition(|s| s.color == color);
    let cut_rows = cut(c, &other, from, to, now)?;
    let lo = same.iter().map(|s| s.from).fold(from, u32::min);
    let hi = same.iter().map(|s| s.to).fold(to, u32::max);
    let survivor = match (keep, same.first()) {
        (Some(id), _) => id.to_owned(),
        (None, Some(first)) => {
            if same.len() == 1 && cut_rows.is_empty() && (first.from, first.to) == (lo, hi) {
                // Painting inside a same-colour row: nothing changes.
                return Ok(first.id.clone());
            }
            first.id.clone()
        }
        (None, None) => {
            let id = new_id();
            c.prepare_cached(
                "INSERT INTO highlight (id, from_ayah_id, to_ayah_id, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            )?
            .execute(params![id, lo, hi, color_str(color), now])?;
            return Ok(id);
        }
    };
    for absorbed in same.iter().filter(|s| s.id != survivor) {
        copy_item_tags(c, TaggableKind::Highlight, &absorbed.id, &survivor)?;
        set_deleted(c, &absorbed.id, Some(now), now)?;
    }
    c.prepare_cached(
        "UPDATE highlight SET from_ayah_id = ?2, to_ayah_id = ?3, color = ?4, deleted_at = NULL, updated_at = ?5
         WHERE id = ?1",
    )?
    .execute(params![survivor, lo, hi, color_str(color), now])?;
    Ok(survivor)
}

impl UserDb {
    /// Live highlights (optionally of one colour) in mushaf order.
    pub fn highlights_list(&self, color: Option<HighlightColor>) -> Result<Vec<Highlight>> {
        let raws = self.with(|c| {
            let mut stmt = c.prepare_cached(&LIST)?;
            let rows = stmt
                .query_map([color.map(color_str)], RawHighlight::read)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        raws.into_iter()
            .map(|raw| raw.into_dto().map(|(highlight, _)| highlight))
            .collect()
    }

    /// Paints the range; overlapping ranges are split/replaced, so ranges never overlap (see the module docs).
    /// Returns the stored highlight that covers the range.
    pub fn highlight_set(&self, input: &HighlightInput) -> Result<Highlight> {
        check_ayah_range(input.from_ayah_id, input.to_ayah_id)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            let id = apply(
                tx,
                input.from_ayah_id,
                input.to_ayah_id,
                input.color,
                now,
                None,
            )?;
            load_live(tx, &id)
        })
    }

    /// Removes the range from every highlight; returns the highlights that overlapped it, as they were (for undo).
    pub fn highlight_clear_range(&self, from: u32, to: u32) -> Result<Vec<Highlight>> {
        check_ayah_range(from, to)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            let near = spans_near(tx, from, to)?;
            cut(tx, &near, from, to, now)
        })
    }

    /// Tombstones a live highlight and returns it as it was (missing or already deleted: `NotFound`).
    pub fn highlight_delete(&self, id: &str) -> Result<Highlight> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let highlight = load_live(tx, id)?;
            set_deleted(tx, id, Some(now), now)?;
            Ok(highlight)
        })
    }

    /// Re-applies a tombstoned highlight on top of the current ones, keeping its id (a live one is returned unchanged;
    /// missing: `NotFound`).
    pub fn highlight_restore(&self, id: &str) -> Result<Highlight> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let (highlight, deleted) =
                load_any(tx, id)?.ok_or_else(|| CoreError::NotFound(format!("highlight {id}")))?;
            if !deleted {
                return Ok(highlight);
            }
            apply(
                tx,
                highlight.from_ayah_id,
                highlight.to_ayah_id,
                highlight.color,
                now,
                Some(id),
            )?;
            load_live(tx, id)
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::TagInput;

    use super::*;

    use HighlightColor::{Blue, Green, Red, Yellow};

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn set(db: &UserDb, from: u32, to: u32, color: HighlightColor) -> Highlight {
        db.highlight_set(&HighlightInput {
            from_ayah_id: from,
            to_ayah_id: to,
            color,
        })
        .unwrap()
    }

    /// Live rows as `(from, to, colour)`.
    fn state(db: &UserDb) -> Vec<(u32, u32, HighlightColor)> {
        db.highlights_list(None)
            .unwrap()
            .into_iter()
            .map(|h| (h.from_ayah_id, h.to_ayah_id, h.color))
            .collect()
    }

    #[test]
    fn colours_round_trip() {
        for c in [Yellow, Green, Blue, Red, HighlightColor::Purple] {
            assert_eq!(parse_color(color_str(c)).unwrap(), c);
        }
        assert!(matches!(parse_color("pink"), Err(CoreError::Corrupt(_))));
    }

    #[test]
    fn a_new_colour_trims_splits_and_covers() {
        let (_dir, db) = temp_db();
        let left = set(&db, 1, 10, Green);
        let inner = set(&db, 20, 22, Blue);
        set(&db, 30, 40, Red);
        let painted = set(&db, 5, 35, Yellow);
        assert_eq!((painted.from_ayah_id, painted.to_ayah_id), (5, 35));
        assert_eq!(state(&db), [(1, 4, Green), (5, 35, Yellow), (36, 40, Red)]);
        let rows = db.highlights_list(None).unwrap();
        assert_eq!(rows[0].id, left.id, "a trimmed row keeps its id");
        assert!(
            matches!(db.highlight_delete(&inner.id), Err(CoreError::NotFound(_))),
            "covered rows are tombstoned"
        );
        // Splitting: the left piece keeps the id, the right piece is new but keeps created_at.
        db.set_test_clock(Some(T0 + 9_000));
        set(&db, 10, 12, Blue);
        let rows = db.highlights_list(None).unwrap();
        assert_eq!(
            state(&db),
            [
                (1, 4, Green),
                (5, 9, Yellow),
                (10, 12, Blue),
                (13, 35, Yellow),
                (36, 40, Red)
            ]
        );
        assert_eq!(rows[1].id, painted.id);
        assert_ne!(rows[3].id, painted.id);
        assert_eq!(rows[3].created_at, painted.created_at);
        assert_eq!(rows[3].updated_at, 1_700_000_009);
    }

    #[test]
    fn same_colour_rows_merge_and_painting_inside_changes_nothing() {
        let (_dir, db) = temp_db();
        let first = set(&db, 10, 12, Green);
        let second = set(&db, 20, 25, Green);
        set(&db, 13, 13, Blue);
        // Touching (13 is blue, so 10..12 does not touch 14..19): the gap closes into one green row.
        let merged = set(&db, 14, 19, Green);
        assert_eq!(
            state(&db),
            [(10, 12, Green), (13, 13, Blue), (14, 25, Green)]
        );
        assert_eq!(
            merged.id, second.id,
            "the first same-colour neighbour survives"
        );
        // Painting across the blue ayah merges everything green into the first row.
        let all = set(&db, 12, 14, Green);
        assert_eq!(all.id, first.id);
        assert_eq!(state(&db), [(10, 25, Green)]);
        assert!(matches!(
            db.highlight_delete(&second.id),
            Err(CoreError::NotFound(_))
        ));
        // Inside an existing row: no write, same row back.
        db.set_test_clock(Some(T0 + 5_000));
        let inside = set(&db, 15, 16, Green);
        assert_eq!(inside, db.highlights_list(None).unwrap()[0]);
        assert_eq!(inside.updated_at, all.updated_at, "nothing was written");
        // Adjacent different colours stay separate.
        set(&db, 26, 30, Yellow);
        assert_eq!(state(&db), [(10, 25, Green), (26, 30, Yellow)]);
    }

    #[test]
    fn merged_rows_pool_their_tags_and_split_rows_copy_them() {
        let (_dir, db) = temp_db();
        let tag = |name: &str| {
            db.tag_upsert(&TagInput {
                id: None,
                name: name.into(),
                color: None,
            })
            .unwrap()
            .id
        };
        let (a, b) = (tag("a"), tag("b"));
        let x = set(&db, 1, 5, Red);
        let y = set(&db, 10, 12, Red);
        db.item_tags_set(TaggableKind::Highlight, &x.id, std::slice::from_ref(&a))
            .unwrap();
        db.item_tags_set(TaggableKind::Highlight, &y.id, std::slice::from_ref(&b))
            .unwrap();
        let merged = set(&db, 6, 9, Red);
        assert_eq!(merged.id, x.id);
        assert_eq!(merged.tag_ids, [a.clone(), b.clone()]);
        set(&db, 7, 7, Blue);
        let rows = db.highlights_list(None).unwrap();
        assert_eq!(state(&db), [(1, 6, Red), (7, 7, Blue), (8, 12, Red)]);
        assert_eq!(
            rows[2].tag_ids,
            [a, b],
            "the right piece of a split keeps the tags"
        );
    }

    #[test]
    fn clear_range_returns_rows_as_they_were_and_resetting_them_undoes_it() {
        let (_dir, db) = temp_db();
        set(&db, 1, 10, Green);
        set(&db, 11, 11, Blue);
        set(&db, 12, 20, Yellow);
        let before = state(&db);
        let removed = db.highlight_clear_range(5, 15).unwrap();
        assert_eq!(
            removed
                .iter()
                .map(|h| (h.from_ayah_id, h.to_ayah_id, h.color))
                .collect::<Vec<_>>(),
            before
        );
        assert_eq!(state(&db), [(1, 4, Green), (16, 20, Yellow)]);
        for h in &removed {
            set(&db, h.from_ayah_id, h.to_ayah_id, h.color);
        }
        assert_eq!(state(&db), before);
        assert_eq!(
            db.highlights_list(None).unwrap()[0].id,
            removed[0].id,
            "the trimmed row got its range back"
        );
        // Clearing inside one row splits it; clearing nothing returns nothing.
        db.highlight_clear_range(3, 3).unwrap();
        assert_eq!(
            state(&db),
            [
                (1, 2, Green),
                (4, 10, Green),
                (11, 11, Blue),
                (12, 20, Yellow)
            ]
        );
        assert!(db.highlight_clear_range(100, 200).unwrap().is_empty());
        assert!(matches!(
            db.highlight_clear_range(5, 4),
            Err(CoreError::InvalidArgument(_))
        ));
    }

    #[test]
    fn the_store_undo_protocol_restores_the_previous_state() {
        // Undo: snapshot the rows overlapping [from, to], set, then undo = clear_range + re-set the snapshot.
        let (_dir, db) = temp_db();
        set(&db, 1, 5, Green);
        set(&db, 8, 9, Yellow);
        set(&db, 10, 14, Blue);
        let before = state(&db);
        let (from, to) = (4, 11);
        let snapshot: Vec<Highlight> = db
            .highlights_list(None)
            .unwrap()
            .into_iter()
            .filter(|h| h.from_ayah_id <= to && h.to_ayah_id >= from)
            .collect();
        set(&db, from, to, Yellow);
        assert_eq!(state(&db), [(1, 3, Green), (4, 11, Yellow), (12, 14, Blue)]);
        db.highlight_clear_range(from, to).unwrap();
        for h in &snapshot {
            set(&db, h.from_ayah_id, h.to_ayah_id, h.color);
        }
        assert_eq!(state(&db), before);
    }

    #[test]
    fn delete_and_restore_wins_over_newer_rows() {
        let (_dir, db) = temp_db();
        let h = set(&db, 10, 20, Green);
        db.set_test_clock(Some(T0 + 1_000));
        assert_eq!(db.highlight_delete(&h.id).unwrap(), h);
        assert!(matches!(
            db.highlight_delete(&h.id),
            Err(CoreError::NotFound(_))
        ));
        assert!(state(&db).is_empty());
        set(&db, 15, 25, Blue);
        set(&db, 21, 22, Green);
        db.set_test_clock(Some(T0 + 2_000));
        let back = db.highlight_restore(&h.id).unwrap();
        assert_eq!(back.id, h.id);
        assert_eq!(
            (back.from_ayah_id, back.to_ayah_id, back.updated_at),
            (10, 22, 1_700_000_002),
            "merged with 21..22"
        );
        assert_eq!(state(&db), [(10, 22, Green), (23, 25, Blue)]);
        assert_eq!(
            db.highlight_restore(&h.id).unwrap(),
            back,
            "restoring a live row is a no-op"
        );
        assert!(matches!(
            db.highlight_restore("missing"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn list_filters_by_colour_and_rejects_bad_ranges() {
        let (_dir, db) = temp_db();
        set(&db, 100, 101, Red);
        set(&db, 1, 2, Yellow);
        set(&db, 50, 50, Red);
        let reds: Vec<u32> = db
            .highlights_list(Some(Red))
            .unwrap()
            .iter()
            .map(|h| h.from_ayah_id)
            .collect();
        assert_eq!(reds, [50, 100]);
        assert_eq!(state(&db)[0], (1, 2, Yellow));
        for (from, to) in [(0, 1), (2, 1), (6236, 6237)] {
            let r = db.highlight_set(&HighlightInput {
                from_ayah_id: from,
                to_ayah_id: to,
                color: Red,
            });
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{from}..{to}"
            );
        }
        // The edges of the Quran are fine.
        set(&db, 6236, 6236, Blue);
        set(&db, 1, 1, Blue);
        assert_eq!(db.highlight_clear_range(1, 6236).unwrap().len(), 5);
        assert!(state(&db).is_empty());
    }
}
