//! Bookmark collections (§2.2.6, §3.2). Owner: WP2a.
//!
//! - **Order.** `sort_key`, then name (case-insensitive), then id. `sort_key` is stored as given.
//! - **Names** are trimmed with whitespace runs collapsed, 1..=[`NAME_MAX_CHARS`] characters; duplicates are allowed (the
//!   schema has no unique name). Colours follow the tag rules ([`clean_color`]).
//! - **`item_count`** counts live bookmarks only.
//! - **Delete** tombstones the collection and leaves its bookmarks alone. Memberships stay (invisible while the collection
//!   is deleted) and cascade away when the tombstone is purged.
//! - **Membership** ([`UserDb::collection_set_membership`], and `collection_ids` of `bookmark_upsert`) makes a bookmark's
//!   live collections exactly the given set. A new member is appended to the collection (`sort_key` = last + 1, `added_at`
//!   = now); members that stay keep their place.

use quran_types::{Bookmark, Collection, CollectionInput, TaggableKind};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::bookmarks::load_live_bookmark;
use super::tags::{NAME_MAX_CHARS, clean_color, dedupe_ids, required_name, touch_live_item};
use super::{UserDb, col_u32, ms_to_secs, new_id};
use crate::{CoreError, Result};

const COLLECTION_COLUMNS: &str = "c.id, c.name, c.color, c.sort_key, c.created_at, c.updated_at, \
    (SELECT count(*) FROM collection_item ci JOIN bookmark b ON b.id = ci.bookmark_id AND b.deleted_at IS NULL \
     WHERE ci.collection_id = c.id)";

type RawCollection = (String, String, Option<String>, i64, i64, i64, i64);

fn raw_collection(r: &Row<'_>) -> rusqlite::Result<RawCollection> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
    ))
}

fn collection_from_raw(raw: RawCollection) -> Result<Collection> {
    let (id, name, color, sort_key, created_at, updated_at, items) = raw;
    Ok(Collection {
        sort_key: i32::try_from(sort_key).map_err(|_| {
            CoreError::Corrupt(format!("collection.sort_key = {sort_key} is out of range"))
        })?,
        item_count: col_u32(items, "collection item count")?,
        id,
        name,
        color,
        created_at: ms_to_secs(created_at),
        updated_at: ms_to_secs(updated_at),
    })
}

fn load_collection(c: &Connection, id: &str) -> Result<Option<Collection>> {
    c.prepare_cached(&format!(
        "SELECT {COLLECTION_COLUMNS} FROM collection c WHERE c.id = ?1 AND c.deleted_at IS NULL"
    ))?
    .query_row([id], raw_collection)
    .optional()?
    .map(collection_from_raw)
    .transpose()
}

impl UserDb {
    /// Every live collection by `sort_key`, name and id, with its number of live bookmarks.
    pub fn collections_list(&self) -> Result<Vec<Collection>> {
        let raws = self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {COLLECTION_COLUMNS} FROM collection c WHERE c.deleted_at IS NULL
                 ORDER BY c.sort_key, c.name COLLATE NOCASE, c.id"
            ))?;
            let rows = stmt
                .query_map([], raw_collection)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        raws.into_iter().map(collection_from_raw).collect()
    }

    /// Creates (`id: None`) or updates a live collection (unknown or deleted id: `NotFound`).
    pub fn collection_upsert(&self, input: &CollectionInput) -> Result<Collection> {
        let name = required_name(&input.name, NAME_MAX_CHARS, "collection name")?;
        let color = clean_color(input.color.as_deref())?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            let id = match &input.id {
                None => {
                    let id = new_id();
                    tx.prepare_cached(
                        "INSERT INTO collection (id, name, color, sort_key, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    )?
                    .execute(params![id, name, color, input.sort_key, now])?;
                    id
                }
                Some(id) => {
                    let changed = tx
                        .prepare_cached(
                            "UPDATE collection SET name = ?2, color = ?3, sort_key = ?4, updated_at = ?5
                             WHERE id = ?1 AND deleted_at IS NULL",
                        )?
                        .execute(params![id, name, color, input.sort_key, now])?;
                    if changed == 0 {
                        return Err(CoreError::NotFound(format!("collection {id}")));
                    }
                    id.clone()
                }
            };
            load_collection(tx, &id)?.ok_or_else(|| CoreError::NotFound(format!("collection {id}")))
        })
    }

    /// Tombstones a live collection (unknown or already deleted: `NotFound`). Its bookmarks stay.
    pub fn collection_delete(&self, id: &str) -> Result<()> {
        let now = self.now_ms();
        let changed = self.with(|c| {
            Ok(c.prepare_cached(
                "UPDATE collection SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            )?
            .execute(params![id, now])?)
        })?;
        if changed == 0 {
            return Err(CoreError::NotFound(format!("collection {id}")));
        }
        Ok(())
    }

    /// Makes the live collections of a live bookmark exactly `collection_ids` (deduplicated, each a live collection),
    /// bumps the bookmark's `updated_at` and returns it. Unknown or deleted ids are `NotFound`; nothing is written then.
    pub fn collection_set_membership(
        &self,
        bookmark_id: &str,
        collection_ids: &[String],
    ) -> Result<Bookmark> {
        let collection_ids = dedupe_ids(collection_ids, "collections")?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            touch_live_item(tx, TaggableKind::Bookmark, bookmark_id, now)?;
            set_bookmark_collections(tx, bookmark_id, &collection_ids, now)?;
            load_live_bookmark(tx, bookmark_id)
        })
    }
}

/// Every id must name a live collection (`NotFound` otherwise).
pub(super) fn require_live_collections(c: &Connection, ids: &[String]) -> Result<()> {
    let mut stmt =
        c.prepare_cached("SELECT 1 FROM collection WHERE id = ?1 AND deleted_at IS NULL")?;
    for id in ids {
        if !stmt.exists([id])? {
            return Err(CoreError::NotFound(format!("collection {id}")));
        }
    }
    Ok(())
}

/// Makes the live collections of `bookmark_id` exactly `ids` (validated: each must be a live collection). New members
/// are appended; memberships of tombstoned collections are left alone.
pub(super) fn set_bookmark_collections(
    c: &Connection,
    bookmark_id: &str,
    ids: &[String],
    now: i64,
) -> Result<()> {
    require_live_collections(c, ids)?;
    let keep = serde_json::to_string(ids)?;
    c.prepare_cached(
        "DELETE FROM collection_item WHERE bookmark_id = ?1
           AND collection_id NOT IN (SELECT value FROM json_each(?2))
           AND collection_id IN (SELECT id FROM collection WHERE deleted_at IS NULL)",
    )?
    .execute(params![bookmark_id, keep])?;
    let mut append = c.prepare_cached(
        "INSERT INTO collection_item (collection_id, bookmark_id, sort_key, added_at)
         SELECT ?1, ?2, coalesce(max(sort_key) + 1, 0), ?3 FROM collection_item WHERE collection_id = ?1
         ON CONFLICT (collection_id, bookmark_id) DO NOTHING",
    )?;
    for id in ids {
        append.execute(params![id, bookmark_id, now])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{BookmarkInput, BookmarkKind};

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn collection(db: &UserDb, name: &str, sort_key: i32) -> Collection {
        db.collection_upsert(&CollectionInput {
            id: None,
            name: name.into(),
            color: None,
            sort_key,
        })
        .unwrap()
    }

    fn bookmark(db: &UserDb, ayah_id: u32) -> String {
        db.bookmark_upsert(&BookmarkInput {
            id: None,
            kind: BookmarkKind::Ayah,
            ayah_id,
            layout: None,
            page: None,
            label: None,
            collection_ids: Vec::new(),
            tag_ids: Vec::new(),
        })
        .unwrap()
        .id
    }

    fn members(db: &UserDb, collection_id: &str) -> Vec<(String, i64, i64)> {
        db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT bookmark_id, sort_key, added_at FROM collection_item WHERE collection_id = ?1
                 ORDER BY sort_key",
            )?;
            let rows = stmt
                .query_map([collection_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
    }

    #[test]
    fn create_update_order_and_delete() {
        let (_dir, db) = temp_db();
        let duas = collection(&db, "  Duas ", 2);
        assert_eq!(duas.name, "Duas");
        assert_eq!((duas.item_count, duas.created_at), (0, 1_700_000_000));
        let stories = collection(&db, "stories", 1);
        let alpha = collection(&db, "Alpha", 2);
        let order: Vec<String> = db
            .collections_list()
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(order, ["stories", "Alpha", "Duas"]);

        db.set_test_clock(Some(T0 + 2_000));
        let updated = db
            .collection_upsert(&CollectionInput {
                id: Some(duas.id.clone()),
                name: "Du'as".into(),
                color: Some("gold".into()),
                sort_key: -1,
            })
            .unwrap();
        assert_eq!(
            (
                updated.name.as_str(),
                updated.color.as_deref(),
                updated.sort_key
            ),
            ("Du'as", Some("gold"), -1)
        );
        assert_eq!(
            (updated.created_at, updated.updated_at),
            (1_700_000_000, 1_700_000_002)
        );
        assert_eq!(db.collections_list().unwrap()[0].id, duas.id);

        db.collection_delete(&alpha.id).unwrap();
        assert!(matches!(
            db.collection_delete(&alpha.id),
            Err(CoreError::NotFound(_))
        ));
        let after: Vec<String> = db
            .collections_list()
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(after, [duas.id.clone(), stories.id]);
        let edit_deleted = db.collection_upsert(&CollectionInput {
            id: Some(alpha.id),
            name: "x".into(),
            color: None,
            sort_key: 0,
        });
        assert!(matches!(edit_deleted, Err(CoreError::NotFound(_))));
        for bad in ["", "   ", &"n".repeat(NAME_MAX_CHARS + 1)] {
            let r = db.collection_upsert(&CollectionInput {
                id: None,
                name: bad.into(),
                color: None,
                sort_key: 0,
            });
            assert!(matches!(r, Err(CoreError::InvalidArgument(_))), "{bad:?}");
        }
    }

    #[test]
    fn membership_appends_keeps_places_and_counts_live_bookmarks() {
        let (_dir, db) = temp_db();
        let a = collection(&db, "a", 0);
        let b = collection(&db, "b", 1);
        let x = bookmark(&db, 1);
        let y = bookmark(&db, 2);
        db.collection_set_membership(&x, std::slice::from_ref(&a.id))
            .unwrap();
        db.set_test_clock(Some(T0 + 5_000));
        let y_in = db
            .collection_set_membership(&y, &[b.id.clone(), a.id.clone(), b.id.clone()])
            .unwrap();
        assert_eq!(
            y_in.collection_ids,
            [a.id.clone(), b.id.clone()],
            "collection order, deduplicated"
        );
        assert_eq!(y_in.updated_at, 1_700_000_005);
        assert_eq!(
            members(&db, &a.id),
            [(x.clone(), 0, T0), (y.clone(), 1, T0 + 5_000)]
        );
        // Re-setting keeps existing places; removing then re-adding appends.
        db.collection_set_membership(&x, &[a.id.clone(), b.id.clone()])
            .unwrap();
        assert_eq!(members(&db, &a.id)[0], (x.clone(), 0, T0));
        db.collection_set_membership(&x, std::slice::from_ref(&b.id))
            .unwrap();
        db.collection_set_membership(&x, &[a.id.clone(), b.id.clone()])
            .unwrap();
        assert_eq!(members(&db, &a.id)[1].0, x);
        let counts: Vec<u32> = db
            .collections_list()
            .unwrap()
            .iter()
            .map(|c| c.item_count)
            .collect();
        assert_eq!(counts, [2, 2]);
        db.bookmark_delete(&y).unwrap();
        let counts: Vec<u32> = db
            .collections_list()
            .unwrap()
            .iter()
            .map(|c| c.item_count)
            .collect();
        assert_eq!(counts, [1, 1], "a deleted bookmark no longer counts");
        db.collection_set_membership(&x, &[]).unwrap();
        assert!(db.bookmark_get(&x).unwrap().collection_ids.is_empty());
    }

    #[test]
    fn deleted_collections_disappear_from_bookmarks_and_cascade_on_purge() {
        let (_dir, db) = temp_db();
        let a = collection(&db, "a", 0);
        let b = collection(&db, "b", 0);
        let x = bookmark(&db, 9);
        db.collection_set_membership(&x, &[a.id.clone(), b.id.clone()])
            .unwrap();
        db.collection_delete(&a.id).unwrap();
        assert_eq!(db.bookmark_get(&x).unwrap().collection_ids, [b.id.as_str()]);
        // Membership of a deleted collection is neither listed nor changed by a later set.
        db.collection_set_membership(&x, &[]).unwrap();
        assert_eq!(members(&db, &a.id).len(), 1);
        db.set_test_clock(Some(T0 + 31 * super::super::DAY_MS));
        assert_eq!(db.purge_tombstones(30).unwrap(), 1);
        assert!(members(&db, &a.id).is_empty(), "cascade");
    }

    #[test]
    fn membership_is_validated_before_writing() {
        let (_dir, db) = temp_db();
        let a = collection(&db, "a", 0);
        let x = bookmark(&db, 3);
        db.collection_set_membership(&x, std::slice::from_ref(&a.id))
            .unwrap();
        for (bookmark, ids) in [
            (x.as_str(), vec!["missing".to_owned()]),
            ("missing", vec![a.id.clone()]),
        ] {
            let r = db.collection_set_membership(bookmark, &ids);
            assert!(
                matches!(r, Err(CoreError::NotFound(_))),
                "{bookmark}: {r:?}"
            );
        }
        assert!(matches!(
            db.collection_set_membership(&x, &[String::new()]),
            Err(CoreError::InvalidArgument(_))
        ));
        db.bookmark_delete(&x).unwrap();
        assert!(matches!(
            db.collection_set_membership(&x, &[]),
            Err(CoreError::NotFound(_))
        ));
        assert_eq!(members(&db, &a.id).len(), 1);
    }
}
