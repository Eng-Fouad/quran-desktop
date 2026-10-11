//! Notes with the external-content FTS index over `body_search` (§2.2.6, §3.2). Owner: WP2a.
//!
//! - **Text.** The title is one line (whitespace collapsed), at most [`LABEL_MAX_CHARS`] characters; blank means none.
//!   The body (Markdown subset, §7.5) keeps its lines: line endings become `\n`, control characters other than `\n` and
//!   `\t` are dropped, the ends are trimmed, and it may be at most [`BODY_MAX_CHARS`] characters. A note needs a title or
//!   a body (`InvalidArgument` otherwise).
//! - **Search.** `body_search = fold_latin(normalize_ar(title + ' ' + body, Loose))` (§3.2), kept in `note_fts` by the
//!   schema triggers. Tombstoned notes stay indexed until purged, so a search joins `note` and keeps
//!   `deleted_at IS NULL`.
//! - **Upsert.** `id: None` creates; `id: Some` updates a live note (missing or deleted: `NotFound`). `tag_ids` are
//!   applied exactly. The ayah range must be valid.
//! - **Tombstones.** Delete returns the note as it was; restore clears the tombstone and bumps `updated_at`; restoring a
//!   live note returns it unchanged. `note_get` sees live notes only.
//! - **List:** live notes overlapping `[from_ayah_id, to_ayah_id]` (either bound optional), optionally with a tag, most
//!   recently updated first. `limit = 0` returns nothing.

use std::sync::LazyLock;

use quran_types::{AYAH_COUNT, Note, NoteFilter, NoteInput, TaggableKind};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::tags::{
    LABEL_MAX_CHARS, check_len, dedupe_ids, ids_from_json, opt_single_line, replace_item_tags,
    tags_json_sql,
};
use super::{UserDb, check_ayah, check_ayah_range, col_u32, ms_to_secs, new_id};
use crate::normalize::{Level, fold_latin, normalize_ar};
use crate::{CoreError, Result};

/// Longest note body, in characters.
pub const BODY_MAX_CHARS: usize = 100_000;

static SELECT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT n.id, n.from_ayah_id, n.to_ayah_id, n.title, n.body, n.created_at, n.updated_at, n.deleted_at, {tags} \
         FROM note n",
        tags = tags_json_sql(TaggableKind::Note, "n.id")
    )
});

/// The filtered page of ids is chosen first (materialised), so the tag subquery runs only for the rows returned.
static LIST: LazyLock<String> = LazyLock::new(|| {
    format!(
        "WITH hit AS MATERIALIZED (
           SELECT x.id, x.updated_at FROM note x
           WHERE x.deleted_at IS NULL AND x.from_ayah_id <= ?2 AND x.to_ayah_id >= ?1
             AND (?3 IS NULL OR EXISTS (SELECT 1 FROM item_tag it
                   JOIN tag t ON t.id = it.tag_id AND t.deleted_at IS NULL
                   WHERE it.item_kind = 'note' AND it.item_id = x.id AND it.tag_id = ?3))
           ORDER BY x.updated_at DESC, x.id DESC
           LIMIT ?4)
         {select} JOIN hit ON hit.id = n.id
         ORDER BY hit.updated_at DESC, hit.id DESC",
        select = *SELECT
    )
});

static BY_ID: LazyLock<String> = LazyLock::new(|| format!("{} WHERE n.id = ?1", *SELECT));

/// One `note` row as read by [`SELECT`].
struct RawNote {
    id: String,
    from: i64,
    to: i64,
    title: Option<String>,
    body: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    tags: Option<String>,
}

impl RawNote {
    fn read(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            from: r.get(1)?,
            to: r.get(2)?,
            title: r.get(3)?,
            body: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            deleted_at: r.get(7)?,
            tags: r.get(8)?,
        })
    }

    /// The DTO and whether the row is tombstoned.
    fn into_dto(self) -> Result<(Note, bool)> {
        let note = Note {
            from_ayah_id: col_u32(self.from, "note.from_ayah_id")?,
            to_ayah_id: col_u32(self.to, "note.to_ayah_id")?,
            title: self.title,
            body: self.body,
            tag_ids: ids_from_json(self.tags, "note tags")?,
            created_at: ms_to_secs(self.created_at),
            updated_at: ms_to_secs(self.updated_at),
            id: self.id,
        };
        Ok((note, self.deleted_at.is_some()))
    }
}

fn load_any(c: &Connection, id: &str) -> Result<Option<(Note, bool)>> {
    c.prepare_cached(&BY_ID)?
        .query_row([id], RawNote::read)
        .optional()?
        .map(RawNote::into_dto)
        .transpose()
}

fn load_live(c: &Connection, id: &str) -> Result<Note> {
    match load_any(c, id)? {
        Some((note, false)) => Ok(note),
        _ => Err(CoreError::NotFound(format!("note {id}"))),
    }
}

fn set_deleted(c: &Connection, id: &str, deleted_at: Option<i64>, now: i64) -> Result<()> {
    c.prepare_cached("UPDATE note SET deleted_at = ?2, updated_at = ?3 WHERE id = ?1")?
        .execute(params![id, deleted_at, now])?;
    Ok(())
}

/// The stored form of a note body: `\r\n`/`\r` → `\n`, control characters other than `\n`/`\t` dropped, ends trimmed.
fn clean_body(body: &str) -> String {
    body.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The FTS text of a note (§3.2): `fold_latin(normalize_ar(title + ' ' + body, Loose))`.
#[must_use]
pub fn note_body_search(title: Option<&str>, body: &str) -> String {
    fold_latin(&normalize_ar(
        &format!("{} {body}", title.unwrap_or_default()),
        Level::Loose,
    ))
}

impl UserDb {
    /// Live notes matching the filter, most recently updated first (see the module docs).
    pub fn notes_list(&self, f: &NoteFilter) -> Result<Vec<Note>> {
        if let Some(from) = f.from_ayah_id {
            check_ayah(from, "from ayah")?;
        }
        if let Some(to) = f.to_ayah_id {
            check_ayah(to, "to ayah")?;
        }
        let from = f.from_ayah_id.unwrap_or(1);
        let to = f.to_ayah_id.unwrap_or(AYAH_COUNT);
        check_ayah_range(from, to)?;
        let raws = self.with(|c| {
            let mut stmt = c.prepare_cached(&LIST)?;
            let rows = stmt
                .query_map(params![from, to, f.tag_id, f.limit], RawNote::read)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        raws.into_iter()
            .map(|raw| raw.into_dto().map(|(note, _)| note))
            .collect()
    }

    /// The live note `id` (missing or deleted: `NotFound`).
    pub fn note_get(&self, id: &str) -> Result<Note> {
        self.with(|c| load_live(c, id))
    }

    /// Creates (`id: None`) or updates a live note; computes `body_search`; returns the stored row.
    pub fn note_upsert(&self, input: &NoteInput) -> Result<Note> {
        check_ayah_range(input.from_ayah_id, input.to_ayah_id)?;
        let title = opt_single_line(input.title.as_deref(), LABEL_MAX_CHARS, "note title")?;
        let body = clean_body(&input.body);
        check_len(&body, BODY_MAX_CHARS, "note body")?;
        if title.is_none() && body.is_empty() {
            return Err(CoreError::InvalidArgument(
                "a note needs a title or a body".into(),
            ));
        }
        let tag_ids = dedupe_ids(&input.tag_ids, "tags")?;
        let body_search = note_body_search(title.as_deref(), &body);
        let now = self.now_ms();
        self.with_tx(|tx| {
            let id = match &input.id {
                None => {
                    let id = new_id();
                    tx.prepare_cached(
                        "INSERT INTO note (id, from_ayah_id, to_ayah_id, title, body, body_search, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    )?
                    .execute(params![
                        id,
                        input.from_ayah_id,
                        input.to_ayah_id,
                        title,
                        body,
                        body_search,
                        now
                    ])?;
                    id
                }
                Some(id) => {
                    let changed = tx
                        .prepare_cached(
                            "UPDATE note SET from_ayah_id = ?2, to_ayah_id = ?3, title = ?4, body = ?5, body_search = ?6,
                               updated_at = ?7
                             WHERE id = ?1 AND deleted_at IS NULL",
                        )?
                        .execute(params![
                            id,
                            input.from_ayah_id,
                            input.to_ayah_id,
                            title,
                            body,
                            body_search,
                            now
                        ])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound(format!("note {id}")));
                    }
                    id.clone()
                }
            };
            replace_item_tags(tx, TaggableKind::Note, &id, &tag_ids)?;
            load_live(tx, &id)
        })
    }

    /// Tombstones a live note and returns it as it was (missing or already deleted: `NotFound`).
    pub fn note_delete(&self, id: &str) -> Result<Note> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let note = load_live(tx, id)?;
            set_deleted(tx, id, Some(now), now)?;
            Ok(note)
        })
    }

    /// Clears the tombstone of a note (a live one is returned unchanged; missing: `NotFound`).
    pub fn note_restore(&self, id: &str) -> Result<Note> {
        let now = self.now_ms();
        self.with_tx(|tx| {
            let (note, deleted) =
                load_any(tx, id)?.ok_or_else(|| CoreError::NotFound(format!("note {id}")))?;
            if !deleted {
                return Ok(note);
            }
            set_deleted(tx, id, None, now)?;
            load_live(tx, id)
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::TagInput;

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn input(from: u32, to: u32, body: &str) -> NoteInput {
        NoteInput {
            id: None,
            from_ayah_id: from,
            to_ayah_id: to,
            title: None,
            body: body.into(),
            tag_ids: Vec::new(),
        }
    }

    fn fts_hits(db: &UserDb, query: &str) -> Vec<String> {
        db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT n.id FROM note_fts JOIN note n ON n.rid = note_fts.rowid
                 WHERE note_fts MATCH ?1 AND n.deleted_at IS NULL ORDER BY n.id",
            )?;
            let rows = stmt
                .query_map([query], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        })
        .unwrap()
    }

    #[test]
    fn create_and_update_keep_the_fts_index_in_sync() {
        let (_dir, db) = temp_db();
        let n = db
            .note_upsert(&NoteInput {
                title: Some("  Opening\tprayer ".into()),
                ..input(1, 7, "  الْحَمْدُ لِلَّهِ — Café notes\r\n\r\n- point\u{0}  ")
            })
            .unwrap();
        assert_eq!(n.title.as_deref(), Some("Opening prayer"));
        assert_eq!(n.body, "الْحَمْدُ لِلَّهِ — Café notes\n\n- point");
        assert_eq!((n.created_at, n.updated_at), (1_700_000_000, 1_700_000_000));
        let stored: String = db
            .with(|c| {
                Ok(
                    c.query_row("SELECT body_search FROM note WHERE id = ?1", [&n.id], |r| {
                        r.get(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(stored, note_body_search(n.title.as_deref(), &n.body));
        // Diacritics, case and Arabic letter variants are folded (Loose + fold_latin).
        assert_eq!(fts_hits(&db, "الحمد"), [n.id.as_str()]);
        assert_eq!(fts_hits(&db, "cafe"), [n.id.as_str()]);
        assert_eq!(fts_hits(&db, "PRAYER"), [n.id.as_str()]);

        db.set_test_clock(Some(T0 + 3_000));
        let edited = db
            .note_upsert(&NoteInput {
                id: Some(n.id.clone()),
                title: None,
                ..input(2, 3, "patience")
            })
            .unwrap();
        assert_eq!(
            (
                edited.from_ayah_id,
                edited.to_ayah_id,
                edited.title.as_deref()
            ),
            (2, 3, None)
        );
        assert_eq!(
            (edited.created_at, edited.updated_at),
            (1_700_000_000, 1_700_000_003)
        );
        assert!(
            fts_hits(&db, "cafe").is_empty(),
            "the old text left the index"
        );
        assert_eq!(fts_hits(&db, "patience"), [n.id.as_str()]);
        assert_eq!(db.note_get(&n.id).unwrap(), edited);
    }

    #[test]
    fn invalid_notes_are_rejected() {
        let (_dir, db) = temp_db();
        for bad in [
            input(0, 1, "x"),
            input(5, 4, "x"),
            input(1, 6237, "x"),
            input(1, 1, " \r\n\t "),
            NoteInput {
                title: Some("t".repeat(LABEL_MAX_CHARS + 1)),
                ..input(1, 1, "x")
            },
            input(1, 1, &"b".repeat(BODY_MAX_CHARS + 1)),
        ] {
            let r = db.note_upsert(&bad);
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{:?}",
                r.map(|n| n.id)
            );
        }
        // A title alone is a note.
        let titled = db
            .note_upsert(&NoteInput {
                title: Some("Revisit".into()),
                ..input(1, 1, "")
            })
            .unwrap();
        assert_eq!(titled.body, "");
        for bad in [
            NoteInput {
                id: Some("missing".into()),
                ..input(1, 1, "x")
            },
            NoteInput {
                tag_ids: vec!["missing".into()],
                ..input(1, 1, "x")
            },
        ] {
            assert!(matches!(db.note_upsert(&bad), Err(CoreError::NotFound(_))));
        }
        assert_eq!(
            db.notes_list(&NoteFilter {
                from_ayah_id: None,
                to_ayah_id: None,
                tag_id: None,
                limit: 10
            })
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn delete_and_restore() {
        let (_dir, db) = temp_db();
        let n = db.note_upsert(&input(10, 12, "mercy")).unwrap();
        db.set_test_clock(Some(T0 + 1_000));
        assert_eq!(db.note_delete(&n.id).unwrap(), n);
        assert!(matches!(db.note_delete(&n.id), Err(CoreError::NotFound(_))));
        assert!(matches!(db.note_get(&n.id), Err(CoreError::NotFound(_))));
        let edit = db.note_upsert(&NoteInput {
            id: Some(n.id.clone()),
            ..input(10, 12, "x")
        });
        assert!(
            matches!(edit, Err(CoreError::NotFound(_))),
            "deleted notes are not editable"
        );
        db.set_test_clock(Some(T0 + 2_000));
        let back = db.note_restore(&n.id).unwrap();
        assert_eq!(
            (back.body.as_str(), back.updated_at),
            ("mercy", 1_700_000_002)
        );
        assert_eq!(db.note_restore(&n.id).unwrap(), back);
        assert!(matches!(
            db.note_restore("missing"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn list_filters_by_overlap_and_tag() {
        let (_dir, db) = temp_db();
        let tag = db
            .tag_upsert(&TagInput {
                id: None,
                name: "t".into(),
                color: None,
            })
            .unwrap();
        let a = db.note_upsert(&input(1, 7, "a")).unwrap();
        db.set_test_clock(Some(T0 + 1_000));
        let b = db
            .note_upsert(&NoteInput {
                tag_ids: vec![tag.id.clone()],
                ..input(7, 10, "b")
            })
            .unwrap();
        db.set_test_clock(Some(T0 + 2_000));
        let c = db.note_upsert(&input(300, 300, "c")).unwrap();
        let ids = |from: Option<u32>,
                   to: Option<u32>,
                   tag_id: Option<String>,
                   limit: u32|
         -> Vec<String> {
            db.notes_list(&NoteFilter {
                from_ayah_id: from,
                to_ayah_id: to,
                tag_id,
                limit,
            })
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect()
        };
        assert_eq!(
            ids(None, None, None, 10),
            [c.id.clone(), b.id.clone(), a.id.clone()]
        );
        assert_eq!(ids(None, None, None, 1), [c.id.as_str()]);
        assert!(ids(None, None, None, 0).is_empty());
        assert_eq!(
            ids(Some(7), Some(7), None, 10),
            [b.id.clone(), a.id.clone()]
        );
        assert_eq!(ids(Some(8), None, None, 10), [c.id.clone(), b.id.clone()]);
        assert_eq!(ids(None, Some(6), None, 10), [a.id.as_str()]);
        assert_eq!(ids(None, None, Some(tag.id.clone()), 10), [b.id.as_str()]);
        db.note_delete(&b.id).unwrap();
        assert_eq!(ids(Some(7), Some(7), None, 10), [a.id.as_str()]);
        for (from, to) in [(Some(0), None), (None, Some(6237)), (Some(9), Some(8))] {
            let r = db.notes_list(&NoteFilter {
                from_ayah_id: from,
                to_ayah_id: to,
                tag_id: None,
                limit: 10,
            });
            assert!(
                matches!(r, Err(CoreError::InvalidArgument(_))),
                "{from:?} {to:?}"
            );
        }
    }

    #[test]
    fn body_search_folds_arabic_and_latin() {
        assert_eq!(
            note_body_search(Some("Al-Fātiḥa"), "الصَّلَاةَ إِبْرَاهِيمَ"),
            "al fatiha الصلاه ابراهيم",
            "punctuation splits words, Latin diacritics and harakat are folded"
        );
        assert_eq!(note_body_search(None, "Body"), "body");
    }
}
