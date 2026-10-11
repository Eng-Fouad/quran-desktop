//! Tags (case-insensitive unique names) and item tagging (§2.2.6, §3.2). Owner: WP2a.
//!
//! - **Names.** Trimmed, whitespace runs collapsed, 1..=[`NAME_MAX_CHARS`] characters. Names are unique among live tags
//!   without regard to ASCII case (the `tag_name_u` index). Creating a tag (`id: None`) whose name is already taken
//!   returns that tag unchanged (get-or-create, so a picker's "create" never fails or clobbers); renaming a tag onto
//!   another live tag's name is `InvalidArgument`.
//! - **Colours** are short opaque tokens (`"teal"`, `"#2a9d8f"`): ASCII letters, digits, `#`, `-` and `_`, at most
//!   [`COLOR_MAX_CHARS`]; blank means none. They are never interpreted here, and the character set keeps them safe to
//!   put into a style attribute.
//! - **Delete** tombstones the tag. Its links stay (they are invisible while the tag is deleted) and go with the tag
//!   when the tombstone is purged (`ON DELETE CASCADE`). A new tag may reuse the name at once.
//! - **`usage_count`** counts live items only. `tag_ids` of every item list live tags only, by name.
//! - **[`UserDb::item_tags_set`]** replaces the live tags of one live item and bumps the item's `updated_at`.
//!
//! The second half of this file holds the helpers that bookmarks, highlights, notes and collections share: tag links,
//! text and colour validation, and JSON id lists.

use quran_types::{Tag, TagInput, TaggableKind};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{UserDb, col_u32, new_id};
use crate::{CoreError, Result};

/// Longest tag or collection name, in characters.
pub const NAME_MAX_CHARS: usize = 100;
/// Longest bookmark label or note title, in characters.
pub const LABEL_MAX_CHARS: usize = 200;
/// Longest colour token, in characters.
pub const COLOR_MAX_CHARS: usize = 32;
/// Most tags on one item, and most collections one bookmark belongs to.
pub const MAX_LINKS: usize = 100;

/// Live tags of one item as a JSON array, ordered by name; `{kind}`/`{item}` are spliced in by [`tags_json_sql`].
const TAGS_JSON: &str = "(SELECT json_group_array(t.id ORDER BY t.name COLLATE NOCASE, t.id) FROM item_tag it \
                         JOIN tag t ON t.id = it.tag_id AND t.deleted_at IS NULL \
                         WHERE it.item_kind = '{kind}' AND it.item_id = {item})";

/// The scalar subquery that yields the live tag ids of `item_column` (e.g. `b.id`) as a JSON array.
pub(super) fn tags_json_sql(kind: TaggableKind, item_column: &str) -> String {
    TAGS_JSON
        .replace("{kind}", kind_str(kind))
        .replace("{item}", item_column)
}

const TAG_COLUMNS: &str = "t.id, t.name, t.color, \
    (SELECT count(*) FROM item_tag it WHERE it.tag_id = t.id AND CASE it.item_kind \
       WHEN 'bookmark' THEN EXISTS (SELECT 1 FROM bookmark x WHERE x.id = it.item_id AND x.deleted_at IS NULL) \
       WHEN 'note' THEN EXISTS (SELECT 1 FROM note x WHERE x.id = it.item_id AND x.deleted_at IS NULL) \
       WHEN 'highlight' THEN EXISTS (SELECT 1 FROM highlight x WHERE x.id = it.item_id AND x.deleted_at IS NULL) \
       ELSE 0 END)";

fn raw_tag(r: &Row<'_>) -> rusqlite::Result<(String, String, Option<String>, i64)> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
}

fn tag_from_raw(raw: (String, String, Option<String>, i64)) -> Result<Tag> {
    let (id, name, color, usage) = raw;
    Ok(Tag {
        id,
        name,
        color,
        usage_count: col_u32(usage, "tag usage count")?,
    })
}

/// The live tag `id`, or `None`.
fn load_tag(c: &Connection, id: &str) -> Result<Option<Tag>> {
    c.prepare_cached(&format!(
        "SELECT {TAG_COLUMNS} FROM tag t WHERE t.id = ?1 AND t.deleted_at IS NULL"
    ))?
    .query_row([id], raw_tag)
    .optional()?
    .map(tag_from_raw)
    .transpose()
}

/// The id of the live tag named `name` (ASCII case-insensitive, like the unique index).
fn live_tag_named(c: &Connection, name: &str) -> Result<Option<String>> {
    Ok(
        c.prepare_cached("SELECT id FROM tag WHERE name = ?1 AND deleted_at IS NULL")?
            .query_row([name], |r| r.get(0))
            .optional()?,
    )
}

impl UserDb {
    /// Every live tag by name (case-insensitive), with the number of live items carrying it.
    pub fn tags_list(&self) -> Result<Vec<Tag>> {
        let raws = self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {TAG_COLUMNS} FROM tag t WHERE t.deleted_at IS NULL ORDER BY t.name COLLATE NOCASE, t.id"
            ))?;
            let rows = stmt
                .query_map([], raw_tag)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        raws.into_iter().map(tag_from_raw).collect()
    }

    /// Creates (`id: None`; an existing live tag of the same name is returned unchanged) or renames/recolours a tag.
    pub fn tag_upsert(&self, input: &TagInput) -> Result<Tag> {
        let name = required_name(&input.name, NAME_MAX_CHARS, "tag name")?;
        let color = clean_color(input.color.as_deref())?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            let same_name = live_tag_named(tx, &name)?;
            let id = match &input.id {
                None => match same_name {
                    Some(existing) => existing,
                    None => {
                        let id = new_id();
                        tx.prepare_cached(
                            "INSERT INTO tag (id, name, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                        )?
                        .execute(params![id, name, color, now])?;
                        id
                    }
                },
                Some(id) => {
                    if same_name.as_ref().is_some_and(|other| other != id) {
                        return Err(CoreError::InvalidArgument(format!(
                            "another tag is already named {name:?}"
                        )));
                    }
                    let changed = tx
                        .prepare_cached(
                            "UPDATE tag SET name = ?2, color = ?3, updated_at = ?4 WHERE id = ?1 AND deleted_at IS NULL",
                        )?
                        .execute(params![id, name, color, now])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound(format!("tag {id}")));
                    }
                    id.clone()
                }
            };
            load_tag(tx, &id)?.ok_or_else(|| CoreError::NotFound(format!("tag {id}")))
        })
    }

    /// Tombstones a live tag (unknown or already deleted: `NotFound`). Items keep their other tags.
    pub fn tag_delete(&self, id: &str) -> Result<()> {
        let now = self.now_ms();
        let changed = self.with(|c| {
            Ok(c.prepare_cached(
                "UPDATE tag SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            )?
            .execute(params![id, now])?)
        })?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("tag {id}")));
        }
        Ok(())
    }

    /// Replaces the live tags of a live item with `tag_ids` (deduplicated, each a live tag) and bumps the item's
    /// `updated_at`. An unknown or deleted item or tag is `NotFound`; nothing is written then.
    pub fn item_tags_set(
        &self,
        kind: TaggableKind,
        item_id: &str,
        tag_ids: &[String],
    ) -> Result<()> {
        let tag_ids = dedupe_ids(tag_ids, "tags")?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            touch_live_item(tx, kind, item_id, now)?;
            replace_item_tags(tx, kind, item_id, &tag_ids)
        })
    }
}

// ---- shared library helpers (bookmarks, highlights, notes, collections)

/// `item_tag.item_kind` (also the item's table name).
pub(super) const fn kind_str(kind: TaggableKind) -> &'static str {
    match kind {
        TaggableKind::Bookmark => "bookmark",
        TaggableKind::Note => "note",
        TaggableKind::Highlight => "highlight",
    }
}

/// Bumps `updated_at` of a live item; `NotFound` when it is missing or tombstoned.
pub(super) fn touch_live_item(
    c: &Connection,
    kind: TaggableKind,
    id: &str,
    now: i64,
) -> Result<()> {
    let table = kind_str(kind);
    let changed = c
        .prepare_cached(&format!(
            "UPDATE {table} SET updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL"
        ))?
        .execute(params![id, now])?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("{table} {id}")));
    }
    Ok(())
}

/// Every id must name a live tag (`NotFound` otherwise).
pub(super) fn require_live_tags(c: &Connection, ids: &[String]) -> Result<()> {
    let mut stmt = c.prepare_cached("SELECT 1 FROM tag WHERE id = ?1 AND deleted_at IS NULL")?;
    for id in ids {
        if !stmt.exists([id])? {
            return Err(CoreError::NotFound(format!("tag {id}")));
        }
    }
    Ok(())
}

/// Makes the live tags of an item exactly `tag_ids` (validated: each must be a live tag). Links to tombstoned tags are
/// left alone: they are invisible and go with their tag.
pub(super) fn replace_item_tags(
    c: &Connection,
    kind: TaggableKind,
    item_id: &str,
    tag_ids: &[String],
) -> Result<()> {
    require_live_tags(c, tag_ids)?;
    let keep = serde_json::to_string(tag_ids)?;
    c.prepare_cached(
        "DELETE FROM item_tag WHERE item_kind = ?1 AND item_id = ?2
           AND tag_id NOT IN (SELECT value FROM json_each(?3))
           AND tag_id IN (SELECT id FROM tag WHERE deleted_at IS NULL)",
    )?
    .execute(params![kind_str(kind), item_id, keep])?;
    let mut insert = c.prepare_cached(
        "INSERT INTO item_tag (tag_id, item_kind, item_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (tag_id, item_kind, item_id) DO NOTHING",
    )?;
    for tag in tag_ids {
        insert.execute(params![tag, kind_str(kind), item_id])?;
    }
    Ok(())
}

/// Gives `to` every tag link of `from` (same kind), e.g. when a highlight is split or merged.
pub(super) fn copy_item_tags(
    c: &Connection,
    kind: TaggableKind,
    from: &str,
    to: &str,
) -> Result<()> {
    c.prepare_cached(
        "INSERT INTO item_tag (tag_id, item_kind, item_id)
         SELECT tag_id, item_kind, ?3 FROM item_tag WHERE item_kind = ?1 AND item_id = ?2
         ON CONFLICT (tag_id, item_kind, item_id) DO NOTHING",
    )?
    .execute(params![kind_str(kind), from, to])?;
    Ok(())
}

/// A JSON array of ids produced by `json_group_array` (an aggregate over no rows gives `[]`).
pub(super) fn ids_from_json(json: Option<String>, column: &str) -> Result<Vec<String>> {
    match json {
        None => Ok(Vec::new()),
        Some(text) => {
            serde_json::from_str(&text).map_err(|e| CoreError::Corrupt(format!("{column}: {e}")))
        }
    }
}

/// Ids in input order without duplicates, at most [`MAX_LINKS`]; blank ids are `InvalidArgument`.
pub(super) fn dedupe_ids(ids: &[String], what: &str) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if id.trim().is_empty() {
            return Err(CoreError::InvalidArgument(format!("blank id in {what}")));
        }
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    if out.len() > MAX_LINKS {
        return Err(CoreError::InvalidArgument(format!(
            "more than {MAX_LINKS} {what} on one item"
        )));
    }
    Ok(out)
}

/// One line of text: whitespace runs (newlines and tabs included) become one space, other control characters are
/// dropped, and the ends are trimmed.
pub(super) fn single_line(s: &str) -> String {
    s.split_whitespace()
        .map(|word| word.chars().filter(|c| !c.is_control()).collect::<String>())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// [`single_line`] for an optional field: blank means `None`; longer than `max` characters is `InvalidArgument`.
pub(super) fn opt_single_line(s: Option<&str>, max: usize, what: &str) -> Result<Option<String>> {
    let Some(s) = s else { return Ok(None) };
    let line = single_line(s);
    if line.is_empty() {
        return Ok(None);
    }
    check_len(&line, max, what)?;
    Ok(Some(line))
}

/// [`single_line`] for a required name: blank or longer than `max` characters is `InvalidArgument`.
pub(super) fn required_name(s: &str, max: usize, what: &str) -> Result<String> {
    let line = single_line(s);
    if line.is_empty() {
        return Err(CoreError::InvalidArgument(format!("{what} is empty")));
    }
    check_len(&line, max, what)?;
    Ok(line)
}

/// `s` has at most `max` characters.
pub(super) fn check_len(s: &str, max: usize, what: &str) -> Result<()> {
    if s.chars().count() > max {
        return Err(CoreError::InvalidArgument(format!(
            "{what} is longer than {max} characters"
        )));
    }
    Ok(())
}

/// An optional colour token: trimmed, blank means `None`; otherwise ASCII letters, digits, `#`, `-` and `_` only, at
/// most [`COLOR_MAX_CHARS`] characters.
pub(super) fn clean_color(color: Option<&str>) -> Result<Option<String>> {
    let Some(color) = color.map(str::trim).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let valid = color.len() <= COLOR_MAX_CHARS
        && color
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '#' | '-' | '_'));
    if !valid {
        return Err(CoreError::InvalidArgument(format!(
            "colour {color:?} is not a token of at most {COLOR_MAX_CHARS} letters, digits, '#', '-' or '_'"
        )));
    }
    Ok(Some(color.to_owned()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{BookmarkInput, BookmarkKind, HighlightColor, HighlightInput, NoteInput};

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn tag(db: &UserDb, name: &str) -> Tag {
        db.tag_upsert(&TagInput {
            id: None,
            name: name.into(),
            color: None,
        })
        .unwrap()
    }

    fn bookmark(db: &UserDb, ayah_id: u32, tag_ids: Vec<String>) -> String {
        db.bookmark_upsert(&BookmarkInput {
            id: None,
            kind: BookmarkKind::Ayah,
            ayah_id,
            layout: None,
            page: None,
            label: None,
            collection_ids: Vec::new(),
            tag_ids,
        })
        .unwrap()
        .id
    }

    #[test]
    fn names_are_unique_case_insensitively_and_create_is_get_or_create() {
        let (_dir, db) = temp_db();
        let dua = db
            .tag_upsert(&TagInput {
                id: None,
                name: "  Du'a \n of  the day ".into(),
                color: Some(" teal ".into()),
            })
            .unwrap();
        assert_eq!(dua.name, "Du'a of the day");
        assert_eq!(dua.color.as_deref(), Some("teal"));
        assert_eq!(dua.usage_count, 0);
        // Same name in another case: the existing tag, unchanged.
        let again = db
            .tag_upsert(&TagInput {
                id: None,
                name: "DU'A OF THE DAY".into(),
                color: None,
            })
            .unwrap();
        assert_eq!(again, dua);
        let other = tag(&db, "Patience");
        let clash = db.tag_upsert(&TagInput {
            id: Some(other.id.clone()),
            name: "du'a of the day".into(),
            color: None,
        });
        assert!(
            matches!(clash, Err(CoreError::InvalidArgument(_))),
            "{clash:?}"
        );
        // Renaming a tag onto its own name in another case is fine.
        let renamed = db
            .tag_upsert(&TagInput {
                id: Some(other.id.clone()),
                name: "patience".into(),
                color: Some("#2a9d8f".into()),
            })
            .unwrap();
        assert_eq!(
            (renamed.name.as_str(), renamed.color.as_deref()),
            ("patience", Some("#2a9d8f"))
        );
        let names: Vec<String> = db
            .tags_list()
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, ["Du'a of the day", "patience"]);
    }

    #[test]
    fn invalid_input_is_rejected() {
        let (_dir, db) = temp_db();
        for (name, color) in [
            (" \t ", None),
            (&*"x".repeat(NAME_MAX_CHARS + 1), None),
            ("ok", Some("red; background: url(x)")),
            ("ok", Some(&*"a".repeat(COLOR_MAX_CHARS + 1))),
        ] {
            let r = db.tag_upsert(&TagInput {
                id: None,
                name: name.into(),
                color: color.map(Into::into),
            });
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{name:?} {color:?}: {r:?}"
            );
        }
        let missing = db.tag_upsert(&TagInput {
            id: Some("nope".into()),
            name: "x".into(),
            color: None,
        });
        assert!(matches!(missing, Err(CoreError::NotFound(_))));
        assert!(db.tags_list().unwrap().is_empty());
    }

    #[test]
    fn delete_tombstones_frees_the_name_and_hides_links() {
        let (_dir, db) = temp_db();
        let t = tag(&db, "Mercy");
        let b = bookmark(&db, 262, vec![t.id.clone()]);
        assert_eq!(db.tags_list().unwrap()[0].usage_count, 1);
        db.tag_delete(&t.id).unwrap();
        assert!(matches!(db.tag_delete(&t.id), Err(CoreError::NotFound(_))));
        assert!(db.tags_list().unwrap().is_empty());
        assert!(db.bookmark_get(&b).unwrap().tag_ids.is_empty());
        // The name is free again; the old link stays in the table until the purge.
        let fresh = tag(&db, "mercy");
        assert_ne!(fresh.id, t.id);
        assert_eq!(fresh.usage_count, 0);
        let links: i64 = db
            .with(|c| Ok(c.query_row("SELECT count(*) FROM item_tag", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(links, 1);
        // Purged with the tag (cascade).
        db.set_test_clock(Some(T0 + 31 * super::super::DAY_MS));
        assert_eq!(db.purge_tombstones(30).unwrap(), 1);
        let links: i64 = db
            .with(|c| Ok(c.query_row("SELECT count(*) FROM item_tag", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(links, 0);
    }

    #[test]
    fn item_tags_set_replaces_tags_and_counts_live_items_only() {
        let (_dir, db) = temp_db();
        let a = tag(&db, "a");
        let b = tag(&db, "b");
        let note = db
            .note_upsert(&NoteInput {
                id: None,
                from_ayah_id: 1,
                to_ayah_id: 7,
                title: None,
                body: "al-Fatiha".into(),
                tag_ids: vec![a.id.clone()],
            })
            .unwrap();
        let hl = db
            .highlight_set(&HighlightInput {
                from_ayah_id: 8,
                to_ayah_id: 9,
                color: HighlightColor::Green,
            })
            .unwrap();
        db.set_test_clock(Some(T0 + 1_000));
        db.item_tags_set(
            TaggableKind::Note,
            &note.id,
            &[b.id.clone(), a.id.clone(), b.id.clone()],
        )
        .unwrap();
        let stored = db.note_get(&note.id).unwrap();
        assert_eq!(
            stored.tag_ids,
            [a.id.clone(), b.id.clone()],
            "by name, deduplicated"
        );
        assert_eq!(stored.updated_at, 1_700_000_001, "tagging bumps the item");
        db.item_tags_set(TaggableKind::Highlight, &hl.id, std::slice::from_ref(&b.id))
            .unwrap();
        let counts: Vec<u32> = db
            .tags_list()
            .unwrap()
            .iter()
            .map(|t| t.usage_count)
            .collect();
        assert_eq!(counts, [1, 2]);
        db.note_delete(&note.id).unwrap();
        let counts: Vec<u32> = db
            .tags_list()
            .unwrap()
            .iter()
            .map(|t| t.usage_count)
            .collect();
        assert_eq!(counts, [0, 1], "a deleted item no longer counts");
        db.item_tags_set(TaggableKind::Highlight, &hl.id, &[])
            .unwrap();
        assert!(db.highlights_list(None).unwrap()[0].tag_ids.is_empty());
    }

    #[test]
    fn item_tags_set_validates_everything_before_writing() {
        let (_dir, db) = temp_db();
        let a = tag(&db, "a");
        let b = bookmark(&db, 1, vec![a.id.clone()]);
        for (kind, item, tags) in [
            (
                TaggableKind::Bookmark,
                b.as_str(),
                vec!["missing".to_owned()],
            ),
            (TaggableKind::Note, b.as_str(), vec![a.id.clone()]),
            (TaggableKind::Bookmark, "missing", vec![a.id.clone()]),
        ] {
            let r = db.item_tags_set(kind, item, &tags);
            assert!(
                matches!(r, Err(CoreError::NotFound(_))),
                "{kind:?} {item}: {r:?}"
            );
        }
        let blank = db.item_tags_set(TaggableKind::Bookmark, &b, &[" ".into()]);
        assert!(matches!(blank, Err(CoreError::InvalidArgument(_))));
        let many: Vec<String> = (0..=MAX_LINKS).map(|i| format!("t{i}")).collect();
        let too_many = db.item_tags_set(TaggableKind::Bookmark, &b, &many);
        assert!(matches!(too_many, Err(CoreError::InvalidArgument(_))));
        assert_eq!(db.bookmark_get(&b).unwrap().tag_ids, [a.id]);
    }

    #[test]
    fn text_helpers() {
        assert_eq!(single_line("  a\t b\r\n\u{0}c  "), "a b c");
        assert_eq!(single_line("\u{7}"), "");
        assert_eq!(opt_single_line(Some("  "), 5, "x").unwrap(), None);
        assert_eq!(opt_single_line(None, 5, "x").unwrap(), None);
        assert_eq!(
            opt_single_line(Some(" آية  الكرسي "), 20, "x")
                .unwrap()
                .as_deref(),
            Some("آية الكرسي")
        );
        assert!(opt_single_line(Some("abcdef"), 5, "x").is_err());
        assert!(required_name("", 5, "x").is_err());
        assert_eq!(clean_color(Some("  ")).unwrap(), None);
        assert_eq!(
            clean_color(Some("accent-green_2")).unwrap().as_deref(),
            Some("accent-green_2")
        );
        assert!(clean_color(Some("rgb(1,2,3)")).is_err());
        assert_eq!(
            dedupe_ids(&["b".into(), "a".into(), "b".into()], "tags").unwrap(),
            ["b", "a"]
        );
        assert_eq!(ids_from_json(None, "x").unwrap(), Vec::<String>::new());
        assert_eq!(ids_from_json(Some("[\"a\"]".into()), "x").unwrap(), ["a"]);
        assert!(matches!(
            ids_from_json(Some("{".into()), "x"),
            Err(CoreError::Corrupt(_))
        ));
        assert_eq!(
            tags_json_sql(TaggableKind::Note, "n.id"),
            "(SELECT json_group_array(t.id ORDER BY t.name COLLATE NOCASE, t.id) FROM item_tag it \
             JOIN tag t ON t.id = it.tag_id AND t.deleted_at IS NULL \
             WHERE it.item_kind = 'note' AND it.item_id = n.id)"
        );
    }
}
