//! The user library end to end: persistence across a reopen, tombstone purge at open,
//! the library store's undo flows, the marks of a page spread, and concurrent writers on clones of one handle.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::{SystemTime, UNIX_EPOCH};

use quran_core::UserDb;
use quran_types::{
    BookmarkFilter, BookmarkInput, BookmarkKind, CollectionInput, HighlightColor, HighlightInput,
    MushafLayout, NoteFilter, NoteInput, ReadingBookmarkInput, TagInput, TaggableKind,
};
use support::user::{DAY_MS, TempUserDb, count};

fn system_now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
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

fn every_bookmark() -> BookmarkFilter {
    BookmarkFilter {
        kind: None,
        collection_id: None,
        tag_id: None,
        surah: None,
        limit: u32::MAX,
    }
}

fn every_note() -> NoteFilter {
    NoteFilter {
        from_ayah_id: None,
        to_ayah_id: None,
        tag_id: None,
        limit: u32::MAX,
    }
}

fn note(from: u32, to: u32, body: &str) -> NoteInput {
    NoteInput {
        id: None,
        from_ayah_id: from,
        to_ayah_id: to,
        title: None,
        body: body.into(),
        tag_ids: Vec::new(),
    }
}

/// A small library: a collection, two tags, ayah and page bookmarks, a note, highlights and the reading bookmark.
fn populate(db: &UserDb) {
    let duas = db
        .collection_upsert(&CollectionInput {
            id: None,
            name: "Duas".into(),
            color: Some("gold".into()),
            sort_key: 0,
        })
        .unwrap();
    let mercy = db
        .tag_upsert(&TagInput {
            id: None,
            name: "Mercy".into(),
            color: None,
        })
        .unwrap();
    let patience = db
        .tag_upsert(&TagInput {
            id: None,
            name: "patience".into(),
            color: Some("#2a9d8f".into()),
        })
        .unwrap();
    db.bookmark_upsert(&BookmarkInput {
        label: Some("Ayat al-Kursi".into()),
        collection_ids: vec![duas.id.clone()],
        tag_ids: vec![mercy.id.clone(), patience.id.clone()],
        ..ayah(262)
    })
    .unwrap();
    db.bookmark_upsert(&BookmarkInput {
        kind: BookmarkKind::Page,
        layout: Some(MushafLayout::V2),
        page: Some(42),
        ..ayah(260)
    })
    .unwrap();
    db.note_upsert(&NoteInput {
        title: Some("The Throne verse".into()),
        tag_ids: vec![mercy.id],
        ..note(
            262,
            262,
            "Allah — there is no deity except Him.\n\nReflect daily.",
        )
    })
    .unwrap();
    for (from, to, color) in [
        (255, 262, HighlightColor::Green),
        (258, 259, HighlightColor::Yellow),
    ] {
        db.highlight_set(&HighlightInput {
            from_ayah_id: from,
            to_ayah_id: to,
            color,
        })
        .unwrap();
    }
    db.reading_bookmark_set(&ReadingBookmarkInput {
        ayah_id: 263,
        layout: MushafLayout::V2,
        page: 42,
    })
    .unwrap();
}

#[test]
fn the_library_round_trips_through_a_reopen() {
    let t = TempUserDb::new();
    populate(&t.db);
    let again = t.reopen();
    assert_eq!(
        again.bookmarks_list(&every_bookmark()).unwrap(),
        t.db.bookmarks_list(&every_bookmark()).unwrap()
    );
    assert_eq!(
        again.notes_list(&every_note()).unwrap(),
        t.db.notes_list(&every_note()).unwrap()
    );
    assert_eq!(
        again.highlights_list(None).unwrap(),
        t.db.highlights_list(None).unwrap()
    );
    assert_eq!(
        again.collections_list().unwrap(),
        t.db.collections_list().unwrap()
    );
    assert_eq!(again.tags_list().unwrap(), t.db.tags_list().unwrap());
    assert_eq!(
        again.reading_bookmark_get().unwrap(),
        t.db.reading_bookmark_get().unwrap()
    );

    let bookmarks = again.bookmarks_list(&every_bookmark()).unwrap();
    assert_eq!(bookmarks.len(), 2);
    let kursi = bookmarks
        .iter()
        .find(|b| b.kind == BookmarkKind::Ayah)
        .unwrap();
    assert_eq!(
        (kursi.surah, kursi.ayah, kursi.label.as_deref()),
        (2, 255, Some("Ayat al-Kursi"))
    );
    assert_eq!((kursi.collection_ids.len(), kursi.tag_ids.len()), (1, 2));
    let tags = again.tags_list().unwrap();
    assert_eq!(
        tags.iter()
            .map(|t| (t.name.as_str(), t.usage_count))
            .collect::<Vec<_>>(),
        [("Mercy", 2), ("patience", 1)]
    );
    assert_eq!(
        again
            .highlights_list(None)
            .unwrap()
            .iter()
            .map(|h| (h.from_ayah_id, h.to_ayah_id))
            .collect::<Vec<_>>(),
        [(255, 257), (258, 259), (260, 262)]
    );
}

#[test]
fn the_marks_of_a_spread_draw_everything_once() {
    let t = TempUserDb::new();
    populate(&t.db);
    // A spread around Ayat al-Kursi: the visible ayah range and the two pages, as the reader passes them.
    let m = t.db.marks(MushafLayout::V2, 255, 269, &[42, 43]).unwrap();
    assert_eq!(m.bookmarks.len(), 1);
    assert_eq!(m.bookmarks[0].ayah_id, 262);
    assert_eq!(m.page_bookmarks.len(), 1);
    assert_eq!(m.page_bookmarks[0].page, 42);
    assert_eq!(m.highlights.len(), 3);
    assert_eq!(m.notes.len(), 1);
    assert_eq!(m.reading_ayah_id, Some(263));
    // Another layout has no page bookmark there.
    assert!(
        t.db.marks(MushafLayout::V1, 255, 269, &[42, 43])
            .unwrap()
            .page_bookmarks
            .is_empty()
    );
}

#[test]
fn tombstones_older_than_30_days_are_purged_at_open() {
    let now = system_now_ms();
    let t = TempUserDb::at(now - 40 * DAY_MS);
    populate(&t.db);
    let tag = t.db.tags_list().unwrap()[0].clone();
    let old_note =
        t.db.note_upsert(&NoteInput {
            tag_ids: vec![tag.id.clone()],
            ..note(1, 7, "old")
        })
        .unwrap();
    let old_bookmark = t.db.bookmark_toggle_ayah(1).unwrap().bookmark;
    t.db.note_delete(&old_note.id).unwrap();
    t.db.bookmark_delete(&old_bookmark.id).unwrap();
    // Ten days ago: recent tombstones survive the purge.
    t.db.set_test_clock(Some(now - 10 * DAY_MS));
    let recent =
        t.db.note_upsert(&NoteInput {
            tag_ids: vec![tag.id.clone()],
            ..note(8, 8, "recent")
        })
        .unwrap();
    t.db.note_delete(&recent.id).unwrap();
    let notes_before = count(&t.db, "note");
    assert_eq!(notes_before, 3);

    // Reopening on the system clock purges what was deleted 40 days ago.
    let reopened = t.reopen();
    assert_eq!(count(&reopened, "note"), 2);
    assert_eq!(count(&reopened, "bookmark"), 2);
    assert!(reopened.note_restore(&old_note.id).is_err());
    assert!(reopened.bookmark_restore(&old_bookmark.id).is_err());
    let back = reopened.note_restore(&recent.id).unwrap();
    assert_eq!(
        back.tag_ids,
        [tag.id.as_str()],
        "a restored note keeps its tags"
    );
    // Tag links of purged items went with them.
    let orphans: i64 = reopened
        .with(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM item_tag WHERE item_kind = 'note' AND item_id NOT IN (SELECT id FROM note)",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(orphans, 0);
}

type Snapshot = (
    Vec<quran_types::Bookmark>,
    Vec<quran_types::Note>,
    Vec<quran_types::Highlight>,
    Option<quran_types::ReadingBookmark>,
);

#[test]
fn the_store_undo_flows_restore_the_previous_state() {
    let t = TempUserDb::new();
    let db = &t.db;
    populate(db);
    let snapshot = |db: &UserDb| -> Snapshot {
        (
            db.bookmarks_list(&every_bookmark()).unwrap(),
            db.notes_list(&every_note()).unwrap(),
            db.highlights_list(None).unwrap(),
            db.reading_bookmark_get().unwrap(),
        )
    };
    // What the user sees, independent of `updated_at` (an undo is a new write, so list order by recency may change).
    let ids = |s: &Snapshot| {
        let mut bookmarks: Vec<_> =
            s.0.iter()
                .map(|b| {
                    (
                        b.id.clone(),
                        b.label.clone(),
                        b.collection_ids.clone(),
                        b.tag_ids.clone(),
                    )
                })
                .collect();
        bookmarks.sort();
        let mut notes: Vec<_> =
            s.1.iter()
                .map(|n| (n.id.clone(), n.body.clone(), n.tag_ids.clone()))
                .collect();
        notes.sort();
        (
            bookmarks,
            notes,
            s.2.iter()
                .map(|h| (h.from_ayah_id, h.to_ayah_id, h.color))
                .collect::<Vec<_>>(),
            s.3.map(|r| (r.ayah_id, r.layout, r.page)),
        )
    };
    let before = ids(&snapshot(db));

    // Bookmark toggle off, then undo (restore).
    let off = db.bookmark_toggle_ayah(262).unwrap();
    assert!(!off.active);
    db.bookmark_restore(&off.bookmark.id).unwrap();
    // Bookmark toggle on, then undo (delete).
    let on = db.bookmark_toggle_ayah(7).unwrap();
    db.bookmark_delete(&on.bookmark.id).unwrap();
    // Reading bookmark move, then undo (set it back).
    let moved = db
        .reading_bookmark_set(&ReadingBookmarkInput {
            ayah_id: 300,
            layout: MushafLayout::V2,
            page: 50,
        })
        .unwrap();
    let prev = moved.previous.unwrap();
    db.reading_bookmark_set(&ReadingBookmarkInput {
        ayah_id: prev.ayah_id,
        layout: prev.layout,
        page: prev.page,
    })
    .unwrap();
    // Highlight set, then undo (clear the range, re-set the snapshot of overlapping rows).
    let (from, to) = (250, 258);
    let overlapping: Vec<_> = db
        .highlights_list(None)
        .unwrap()
        .into_iter()
        .filter(|h| h.from_ayah_id <= to && h.to_ayah_id >= from)
        .collect();
    db.highlight_set(&HighlightInput {
        from_ayah_id: from,
        to_ayah_id: to,
        color: HighlightColor::Purple,
    })
    .unwrap();
    db.highlight_clear_range(from, to).unwrap();
    for h in &overlapping {
        db.highlight_set(&HighlightInput {
            from_ayah_id: h.from_ayah_id,
            to_ayah_id: h.to_ayah_id,
            color: h.color,
        })
        .unwrap();
    }
    // Highlight clear, then undo (re-set the removed rows).
    let removed = db.highlight_clear_range(256, 261).unwrap();
    for h in &removed {
        db.highlight_set(&HighlightInput {
            from_ayah_id: h.from_ayah_id,
            to_ayah_id: h.to_ayah_id,
            color: h.color,
        })
        .unwrap();
    }
    // Note delete, then undo (restore).
    let n = db.notes_list(&every_note()).unwrap().remove(0);
    db.note_delete(&n.id).unwrap();
    db.note_restore(&n.id).unwrap();
    // Collection membership and tag changes, then undo (set the previous sets back).
    let kursi = db
        .bookmarks_list(&BookmarkFilter {
            kind: Some(BookmarkKind::Ayah),
            ..every_bookmark()
        })
        .unwrap()
        .remove(0);
    db.collection_set_membership(&kursi.id, &[]).unwrap();
    db.collection_set_membership(&kursi.id, &kursi.collection_ids)
        .unwrap();
    db.item_tags_set(TaggableKind::Bookmark, &kursi.id, &[])
        .unwrap();
    db.item_tags_set(TaggableKind::Bookmark, &kursi.id, &kursi.tag_ids)
        .unwrap();

    assert_eq!(ids(&snapshot(db)), before);
}

#[test]
fn concurrent_toggles_on_clones_never_break_uniqueness() {
    let t = TempUserDb::new();
    let threads: Vec<_> = (0..8_u32)
        .map(|n| {
            let db = t.db.clone();
            std::thread::Builder::new()
                .name(format!("toggle-{n}"))
                .spawn(move || {
                    for i in 0..60_u32 {
                        db.bookmark_toggle_ayah(1 + (i * 7 + n) % 20).unwrap();
                        if i % 10 == 0 {
                            db.highlight_set(&HighlightInput {
                                from_ayah_id: 1 + (i + n) % 20,
                                to_ayah_id: 5 + (i + n) % 20,
                                color: HighlightColor::Blue,
                            })
                            .unwrap();
                        }
                    }
                })
                .unwrap()
        })
        .collect();
    for th in threads {
        th.join().unwrap();
    }
    let live = t.db.bookmarks_list(&every_bookmark()).unwrap();
    let mut ayahs: Vec<u32> = live.iter().map(|b| b.ayah_id).collect();
    ayahs.sort_unstable();
    ayahs.dedup();
    assert_eq!(
        ayahs.len(),
        live.len(),
        "at most one live bookmark per ayah"
    );
    // 480 toggles over 20 ayahs, 24 per ayah: every ayah was toggled an even number of times → all off.
    assert!(live.is_empty(), "{live:?}");
    let blue = t.db.highlights_list(None).unwrap();
    assert_eq!(blue.len(), 1, "every blue range merged into one: {blue:?}");
}
