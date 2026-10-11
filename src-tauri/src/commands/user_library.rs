//! User library commands: bookmarks, reading bookmark, highlights, notes, collections, tags, marks (§5.13).
//! Owner: WP2a. Every mutating command emits `UserDataChanged`.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.
//
// Layout (as in `user_study.rs`): each command is a one-line wrapper that takes the `UserDb` out of the managed state and
// calls its twin in [`ops`], which is generic over the tauri `Runtime` and therefore tested end to end with
// `tauri::test::mock_app()` and a real user.db. SQLite work runs on the blocking pool (§0.2) and the semantics (target-keyed
// upserts, tombstones and undo, highlight splitting and merging) live in `quran_core::user_db`. Events are emitted only
// after the write committed; a failed command emits nothing.
//
// `UserDataChanged` kinds name every list whose content or counts the change can alter, so each panel refetches exactly
// what it shows (the library store also drops its cached marks on bookmarks/highlights/notes/reading_bookmark):
// - bookmark upsert/toggle/delete/restore → bookmarks, collections (item counts), tags (usage counts);
// - reading bookmark set/clear → reading_bookmark;
// - highlight set/clear/delete/restore → highlights, tags; note upsert/delete/restore → notes, tags;
// - collection upsert → collections; collection delete and membership → collections, bookmarks;
// - tag upsert → tags; tag delete → tags, bookmarks, notes, highlights; item_tags_set → tags + the item's kind.

use quran_core::UserDb;
use quran_types::{
    AppError, Bookmark, BookmarkFilter, BookmarkInput, BookmarkToggle, Collection, CollectionInput,
    Highlight, HighlightColor, HighlightInput, MushafLayout, Note, NoteFilter, NoteInput,
    ReadingBookmark, ReadingBookmarkInput, ReadingBookmarkMove, Tag, TagInput, TaggableKind,
    UserDataKind, UserMarks,
};
use tauri::{AppHandle, Runtime, State};

use super::user_study::{emit_event, with_user};
use crate::ipc::events::UserDataChanged;
use crate::state::AppState;

use UserDataKind::{Bookmarks, Collections, Highlights, Notes, ReadingBookmark as Ribbon, Tags};

const BOOKMARK_CHANGE: &[UserDataKind] = &[Bookmarks, Collections, Tags];
const RIBBON_CHANGE: &[UserDataKind] = &[Ribbon];
const HIGHLIGHT_CHANGE: &[UserDataKind] = &[Highlights, Tags];
const NOTE_CHANGE: &[UserDataKind] = &[Notes, Tags];
const COLLECTION_CHANGE: &[UserDataKind] = &[Collections];
const MEMBERSHIP_CHANGE: &[UserDataKind] = &[Collections, Bookmarks];
const TAG_CHANGE: &[UserDataKind] = &[Tags];
const TAG_DELETE: &[UserDataKind] = &[Tags, Bookmarks, Notes, Highlights];

/// The kinds `item_tags_set` reports: tag usage counts and the tagged item's list.
fn item_tags_change(kind: TaggableKind) -> [UserDataKind; 2] {
    [
        Tags,
        match kind {
            TaggableKind::Bookmark => Bookmarks,
            TaggableKind::Note => Notes,
            TaggableKind::Highlight => Highlights,
        },
    ]
}

/// [`with_user`] for a mutation: on success emits `UserDataChanged { kinds }`.
async fn mutate<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    user: UserDb,
    kinds: &[UserDataKind],
    f: impl FnOnce(&UserDb) -> quran_core::Result<T> + Send + 'static,
) -> Result<T, AppError> {
    let out = with_user(user, f).await?;
    emit_event(
        app,
        &UserDataChanged {
            kinds: kinds.to_vec(),
        },
    );
    Ok(out)
}

/// The command bodies, generic over the tauri runtime (see the file comment).
pub(crate) mod ops {
    use super::*;

    // ---- bookmarks

    pub async fn bookmark_list(
        user: UserDb,
        filter: BookmarkFilter,
    ) -> Result<Vec<Bookmark>, AppError> {
        with_user(user, move |u| u.bookmarks_list(&filter)).await
    }

    pub async fn bookmark_upsert<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: BookmarkInput,
    ) -> Result<Bookmark, AppError> {
        mutate(app, user, BOOKMARK_CHANGE, move |u| {
            u.bookmark_upsert(&input)
        })
        .await
    }

    pub async fn bookmark_toggle_ayah<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        ayah_id: u32,
    ) -> Result<BookmarkToggle, AppError> {
        mutate(app, user, BOOKMARK_CHANGE, move |u| {
            u.bookmark_toggle_ayah(ayah_id)
        })
        .await
    }

    pub async fn bookmark_delete<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<Bookmark, AppError> {
        mutate(app, user, BOOKMARK_CHANGE, move |u| u.bookmark_delete(&id)).await
    }

    pub async fn bookmark_restore<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<Bookmark, AppError> {
        mutate(app, user, BOOKMARK_CHANGE, move |u| u.bookmark_restore(&id)).await
    }

    // ---- reading bookmark

    pub async fn reading_bookmark_set<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: ReadingBookmarkInput,
    ) -> Result<ReadingBookmarkMove, AppError> {
        mutate(app, user, RIBBON_CHANGE, move |u| {
            u.reading_bookmark_set(&input)
        })
        .await
    }

    pub async fn reading_bookmark_clear<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
    ) -> Result<Option<ReadingBookmark>, AppError> {
        mutate(app, user, RIBBON_CHANGE, UserDb::reading_bookmark_clear).await
    }

    // ---- highlights

    pub async fn highlight_list(
        user: UserDb,
        color: Option<HighlightColor>,
    ) -> Result<Vec<Highlight>, AppError> {
        with_user(user, move |u| u.highlights_list(color)).await
    }

    pub async fn highlight_set<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: HighlightInput,
    ) -> Result<Highlight, AppError> {
        mutate(app, user, HIGHLIGHT_CHANGE, move |u| {
            u.highlight_set(&input)
        })
        .await
    }

    pub async fn highlight_delete<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<Highlight, AppError> {
        mutate(app, user, HIGHLIGHT_CHANGE, move |u| {
            u.highlight_delete(&id)
        })
        .await
    }

    pub async fn highlight_restore<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<Highlight, AppError> {
        mutate(app, user, HIGHLIGHT_CHANGE, move |u| {
            u.highlight_restore(&id)
        })
        .await
    }

    pub async fn highlight_clear_range<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        from_ayah_id: u32,
        to_ayah_id: u32,
    ) -> Result<Vec<Highlight>, AppError> {
        mutate(app, user, HIGHLIGHT_CHANGE, move |u| {
            u.highlight_clear_range(from_ayah_id, to_ayah_id)
        })
        .await
    }

    // ---- notes

    pub async fn note_list(user: UserDb, filter: NoteFilter) -> Result<Vec<Note>, AppError> {
        with_user(user, move |u| u.notes_list(&filter)).await
    }

    pub async fn note_get(user: UserDb, id: String) -> Result<Note, AppError> {
        with_user(user, move |u| u.note_get(&id)).await
    }

    pub async fn note_upsert<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: NoteInput,
    ) -> Result<Note, AppError> {
        mutate(app, user, NOTE_CHANGE, move |u| u.note_upsert(&input)).await
    }

    pub async fn note_delete<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<Note, AppError> {
        mutate(app, user, NOTE_CHANGE, move |u| u.note_delete(&id)).await
    }

    pub async fn note_restore<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<Note, AppError> {
        mutate(app, user, NOTE_CHANGE, move |u| u.note_restore(&id)).await
    }

    // ---- collections and tags

    pub async fn collection_list(user: UserDb) -> Result<Vec<Collection>, AppError> {
        with_user(user, UserDb::collections_list).await
    }

    pub async fn collection_upsert<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: CollectionInput,
    ) -> Result<Collection, AppError> {
        mutate(app, user, COLLECTION_CHANGE, move |u| {
            u.collection_upsert(&input)
        })
        .await
    }

    pub async fn collection_delete<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<(), AppError> {
        mutate(app, user, MEMBERSHIP_CHANGE, move |u| {
            u.collection_delete(&id)
        })
        .await
    }

    pub async fn collection_set_membership<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        bookmark_id: String,
        collection_ids: Vec<String>,
    ) -> Result<Bookmark, AppError> {
        mutate(app, user, MEMBERSHIP_CHANGE, move |u| {
            u.collection_set_membership(&bookmark_id, &collection_ids)
        })
        .await
    }

    pub async fn tag_list(user: UserDb) -> Result<Vec<Tag>, AppError> {
        with_user(user, UserDb::tags_list).await
    }

    pub async fn tag_upsert<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: TagInput,
    ) -> Result<Tag, AppError> {
        mutate(app, user, TAG_CHANGE, move |u| u.tag_upsert(&input)).await
    }

    pub async fn tag_delete<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: String,
    ) -> Result<(), AppError> {
        mutate(app, user, TAG_DELETE, move |u| u.tag_delete(&id)).await
    }

    pub async fn item_tags_set<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        kind: TaggableKind,
        item_id: String,
        tag_ids: Vec<String>,
    ) -> Result<(), AppError> {
        mutate(app, user, &item_tags_change(kind), move |u| {
            u.item_tags_set(kind, &item_id, &tag_ids)
        })
        .await
    }

    // ---- marks

    pub async fn user_marks(
        user: UserDb,
        layout: MushafLayout,
        from_ayah_id: u32,
        to_ayah_id: u32,
        pages: Vec<u32>,
    ) -> Result<UserMarks, AppError> {
        with_user(user, move |u| {
            u.marks(layout, from_ayah_id, to_ayah_id, &pages)
        })
        .await
    }
}

// ---- bookmarks

#[tauri::command]
#[specta::specta]
pub async fn bookmark_list(
    state: State<'_, AppState>,
    filter: BookmarkFilter,
) -> Result<Vec<Bookmark>, AppError> {
    ops::bookmark_list(state.user.clone(), filter).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmark_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    input: BookmarkInput,
) -> Result<Bookmark, AppError> {
    ops::bookmark_upsert(&app, state.user.clone(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmark_toggle_ayah(
    app: AppHandle,
    state: State<'_, AppState>,
    ayah_id: u32,
) -> Result<BookmarkToggle, AppError> {
    ops::bookmark_toggle_ayah(&app, state.user.clone(), ayah_id).await
}

/// Tombstones the bookmark and returns it (undo = `bookmark_restore`).
#[tauri::command]
#[specta::specta]
pub async fn bookmark_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Bookmark, AppError> {
    ops::bookmark_delete(&app, state.user.clone(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmark_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Bookmark, AppError> {
    ops::bookmark_restore(&app, state.user.clone(), id).await
}

// ---- reading bookmark

#[tauri::command]
#[specta::specta]
pub async fn reading_bookmark_set(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReadingBookmarkInput,
) -> Result<ReadingBookmarkMove, AppError> {
    ops::reading_bookmark_set(&app, state.user.clone(), input).await
}

/// Undo of a first `reading_bookmark_set`; returns the cleared ribbon.
#[tauri::command]
#[specta::specta]
pub async fn reading_bookmark_clear(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ReadingBookmark>, AppError> {
    ops::reading_bookmark_clear(&app, state.user.clone()).await
}

// ---- highlights

#[tauri::command]
#[specta::specta]
pub async fn highlight_list(
    state: State<'_, AppState>,
    color: Option<HighlightColor>,
) -> Result<Vec<Highlight>, AppError> {
    ops::highlight_list(state.user.clone(), color).await
}

#[tauri::command]
#[specta::specta]
pub async fn highlight_set(
    app: AppHandle,
    state: State<'_, AppState>,
    input: HighlightInput,
) -> Result<Highlight, AppError> {
    ops::highlight_set(&app, state.user.clone(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn highlight_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Highlight, AppError> {
    ops::highlight_delete(&app, state.user.clone(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn highlight_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Highlight, AppError> {
    ops::highlight_restore(&app, state.user.clone(), id).await
}

/// Returns the removed rows (for undo).
#[tauri::command]
#[specta::specta]
pub async fn highlight_clear_range(
    app: AppHandle,
    state: State<'_, AppState>,
    from_ayah_id: u32,
    to_ayah_id: u32,
) -> Result<Vec<Highlight>, AppError> {
    ops::highlight_clear_range(&app, state.user.clone(), from_ayah_id, to_ayah_id).await
}

// ---- notes

#[tauri::command]
#[specta::specta]
pub async fn note_list(
    state: State<'_, AppState>,
    filter: NoteFilter,
) -> Result<Vec<Note>, AppError> {
    ops::note_list(state.user.clone(), filter).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_get(state: State<'_, AppState>, id: String) -> Result<Note, AppError> {
    ops::note_get(state.user.clone(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    input: NoteInput,
) -> Result<Note, AppError> {
    ops::note_upsert(&app, state.user.clone(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Note, AppError> {
    ops::note_delete(&app, state.user.clone(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn note_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Note, AppError> {
    ops::note_restore(&app, state.user.clone(), id).await
}

// ---- collections and tags

#[tauri::command]
#[specta::specta]
pub async fn collection_list(state: State<'_, AppState>) -> Result<Vec<Collection>, AppError> {
    ops::collection_list(state.user.clone()).await
}

#[tauri::command]
#[specta::specta]
pub async fn collection_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CollectionInput,
) -> Result<Collection, AppError> {
    ops::collection_upsert(&app, state.user.clone(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn collection_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    ops::collection_delete(&app, state.user.clone(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn collection_set_membership(
    app: AppHandle,
    state: State<'_, AppState>,
    bookmark_id: String,
    collection_ids: Vec<String>,
) -> Result<Bookmark, AppError> {
    ops::collection_set_membership(&app, state.user.clone(), bookmark_id, collection_ids).await
}

#[tauri::command]
#[specta::specta]
pub async fn tag_list(state: State<'_, AppState>) -> Result<Vec<Tag>, AppError> {
    ops::tag_list(state.user.clone()).await
}

#[tauri::command]
#[specta::specta]
pub async fn tag_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    input: TagInput,
) -> Result<Tag, AppError> {
    ops::tag_upsert(&app, state.user.clone(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn tag_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    ops::tag_delete(&app, state.user.clone(), id).await
}

#[tauri::command]
#[specta::specta]
pub async fn item_tags_set(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: TaggableKind,
    item_id: String,
    tag_ids: Vec<String>,
) -> Result<(), AppError> {
    ops::item_tags_set(&app, state.user.clone(), kind, item_id, tag_ids).await
}

// ---- marks

/// Bookmark, highlight, note and reading-ribbon marks for the visible ayah range and pages (§8.9).
#[tauri::command]
#[specta::specta]
pub async fn user_marks(
    state: State<'_, AppState>,
    layout: MushafLayout,
    from_ayah_id: u32,
    to_ayah_id: u32,
    pages: Vec<u32>,
) -> Result<UserMarks, AppError> {
    ops::user_marks(state.user.clone(), layout, from_ayah_id, to_ayah_id, pages).await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::sync::{Arc, Mutex};

    use quran_types::BookmarkKind;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_app};

    use super::*;

    /// A mock app, a fresh user.db and the payloads of every `user-data-changed` event.
    struct Fixture {
        app: tauri::App<MockRuntime>,
        user: UserDb,
        events: Arc<Mutex<Vec<serde_json::Value>>>,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let user = UserDb::open(&dir.path().join("user.db")).unwrap();
            let app = mock_app();
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            app.listen_any("user-data-changed", move |e| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(e.payload()).unwrap());
            });
            Self {
                app,
                user,
                events,
                _dir: dir,
            }
        }

        fn handle(&self) -> &AppHandle<MockRuntime> {
            self.app.handle()
        }

        fn user(&self) -> UserDb {
            self.user.clone()
        }

        /// The `kinds` of every event so far (as wire strings), then forgets them.
        fn take_kinds(&self) -> Vec<Vec<String>> {
            std::mem::take(&mut *self.events.lock().unwrap())
                .into_iter()
                .map(|v| serde_json::from_value(v["kinds"].clone()).unwrap())
                .collect()
        }
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn kinds(names: &[&str]) -> Vec<String> {
        names.iter().map(|&n| n.to_owned()).collect()
    }

    fn ayah_input(ayah_id: u32) -> BookmarkInput {
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

    #[test]
    fn bookmarks_round_trip_and_report_their_lists() {
        let f = Fixture::new();
        let on = run(ops::bookmark_toggle_ayah(f.handle(), f.user(), 262)).unwrap();
        assert!(on.active);
        let labelled = run(ops::bookmark_upsert(
            f.handle(),
            f.user(),
            BookmarkInput {
                label: Some("Kursi".into()),
                ..ayah_input(262)
            },
        ))
        .unwrap();
        assert_eq!(labelled.id, on.bookmark.id);
        let all = BookmarkFilter {
            kind: None,
            collection_id: None,
            tag_id: None,
            surah: Some(2),
            limit: 50,
        };
        assert_eq!(
            run(ops::bookmark_list(f.user(), all.clone())).unwrap(),
            std::slice::from_ref(&labelled)
        );
        let deleted = run(ops::bookmark_delete(
            f.handle(),
            f.user(),
            labelled.id.clone(),
        ))
        .unwrap();
        assert_eq!(deleted, labelled);
        let restored = run(ops::bookmark_restore(
            f.handle(),
            f.user(),
            labelled.id.clone(),
        ))
        .unwrap();
        assert_eq!(restored.label.as_deref(), Some("Kursi"));
        let off = run(ops::bookmark_toggle_ayah(f.handle(), f.user(), 262)).unwrap();
        assert!(!off.active);
        assert!(run(ops::bookmark_list(f.user(), all)).unwrap().is_empty());
        assert_eq!(
            f.take_kinds(),
            vec![kinds(&["bookmarks", "collections", "tags"]); 5]
        );
    }

    #[test]
    fn the_reading_bookmark_moves_and_its_first_set_can_be_undone() {
        let f = Fixture::new();
        let input = ReadingBookmarkInput {
            ayah_id: 262,
            layout: MushafLayout::V2,
            page: 42,
        };
        let first = run(ops::reading_bookmark_set(f.handle(), f.user(), input)).unwrap();
        assert_eq!(first.previous, None);
        let moved = run(ops::reading_bookmark_set(
            f.handle(),
            f.user(),
            ReadingBookmarkInput {
                ayah_id: 263,
                ..input
            },
        ))
        .unwrap();
        assert_eq!(moved.previous, Some(first.current));
        let cleared = run(ops::reading_bookmark_clear(f.handle(), f.user())).unwrap();
        assert_eq!(cleared, Some(moved.current));
        assert_eq!(
            run(ops::reading_bookmark_clear(f.handle(), f.user())).unwrap(),
            None
        );
        assert_eq!(f.take_kinds(), vec![kinds(&["reading_bookmark"]); 4]);
    }

    #[test]
    fn highlights_split_clear_and_restore() {
        let f = Fixture::new();
        let set = |from, to, color| {
            run(ops::highlight_set(
                f.handle(),
                f.user(),
                HighlightInput {
                    from_ayah_id: from,
                    to_ayah_id: to,
                    color,
                },
            ))
            .unwrap()
        };
        let green = set(1, 10, HighlightColor::Green);
        set(4, 5, HighlightColor::Yellow);
        let list = run(ops::highlight_list(f.user(), None)).unwrap();
        let ranges: Vec<(u32, u32)> = list
            .iter()
            .map(|h| (h.from_ayah_id, h.to_ayah_id))
            .collect();
        assert_eq!(ranges, [(1, 3), (4, 5), (6, 10)]);
        let yellow_only = run(ops::highlight_list(f.user(), Some(HighlightColor::Yellow))).unwrap();
        assert_eq!(yellow_only.len(), 1);
        let removed = run(ops::highlight_clear_range(f.handle(), f.user(), 1, 10)).unwrap();
        assert_eq!(removed.len(), 3);
        assert!(run(ops::highlight_list(f.user(), None)).unwrap().is_empty());
        let back = run(ops::highlight_restore(
            f.handle(),
            f.user(),
            green.id.clone(),
        ))
        .unwrap();
        assert_eq!(
            (back.from_ayah_id, back.to_ayah_id),
            (1, 3),
            "restored as last stored"
        );
        run(ops::highlight_delete(f.handle(), f.user(), green.id)).unwrap();
        assert_eq!(f.take_kinds(), vec![kinds(&["highlights", "tags"]); 5]);
    }

    #[test]
    fn notes_round_trip() {
        let f = Fixture::new();
        let note = run(ops::note_upsert(
            f.handle(),
            f.user(),
            NoteInput {
                id: None,
                from_ayah_id: 1,
                to_ayah_id: 7,
                title: Some("Fatiha".into()),
                body: "The opening".into(),
                tag_ids: Vec::new(),
            },
        ))
        .unwrap();
        assert_eq!(run(ops::note_get(f.user(), note.id.clone())).unwrap(), note);
        let filter = NoteFilter {
            from_ayah_id: Some(3),
            to_ayah_id: Some(3),
            tag_id: None,
            limit: 10,
        };
        assert_eq!(
            run(ops::note_list(f.user(), filter.clone())).unwrap(),
            std::slice::from_ref(&note)
        );
        run(ops::note_delete(f.handle(), f.user(), note.id.clone())).unwrap();
        let gone = run(ops::note_get(f.user(), note.id.clone()));
        assert!(matches!(gone, Err(AppError::NotFound(_))), "{gone:?}");
        run(ops::note_restore(f.handle(), f.user(), note.id.clone())).unwrap();
        assert_eq!(run(ops::note_list(f.user(), filter)).unwrap().len(), 1);
        assert_eq!(f.take_kinds(), vec![kinds(&["notes", "tags"]); 3]);
    }

    #[test]
    fn collections_tags_and_item_tags_report_what_they_change() {
        let f = Fixture::new();
        let b = run(ops::bookmark_upsert(f.handle(), f.user(), ayah_input(1))).unwrap();
        f.take_kinds();
        let c = run(ops::collection_upsert(
            f.handle(),
            f.user(),
            CollectionInput {
                id: None,
                name: "Duas".into(),
                color: None,
                sort_key: 0,
            },
        ))
        .unwrap();
        let member = run(ops::collection_set_membership(
            f.handle(),
            f.user(),
            b.id.clone(),
            vec![c.id.clone()],
        ))
        .unwrap();
        assert_eq!(member.collection_ids, [c.id.as_str()]);
        assert_eq!(
            run(ops::collection_list(f.user())).unwrap()[0].item_count,
            1
        );
        let t = run(ops::tag_upsert(
            f.handle(),
            f.user(),
            TagInput {
                id: None,
                name: "mercy".into(),
                color: Some("teal".into()),
            },
        ))
        .unwrap();
        run(ops::item_tags_set(
            f.handle(),
            f.user(),
            TaggableKind::Bookmark,
            b.id.clone(),
            vec![t.id.clone()],
        ))
        .unwrap();
        assert_eq!(run(ops::tag_list(f.user())).unwrap()[0].usage_count, 1);
        run(ops::tag_delete(f.handle(), f.user(), t.id)).unwrap();
        run(ops::collection_delete(f.handle(), f.user(), c.id)).unwrap();
        assert!(run(ops::collection_list(f.user())).unwrap().is_empty());
        assert_eq!(
            f.take_kinds(),
            [
                kinds(&["collections"]),
                kinds(&["collections", "bookmarks"]),
                kinds(&["tags"]),
                kinds(&["tags", "bookmarks"]),
                kinds(&["tags", "bookmarks", "notes", "highlights"]),
                kinds(&["collections", "bookmarks"]),
            ]
        );
        assert_eq!(item_tags_change(TaggableKind::Note), [Tags, Notes]);
        assert_eq!(
            item_tags_change(TaggableKind::Highlight),
            [Tags, Highlights]
        );
    }

    #[test]
    fn marks_read_without_events() {
        let f = Fixture::new();
        run(ops::bookmark_toggle_ayah(f.handle(), f.user(), 9)).unwrap();
        f.take_kinds();
        let marks = run(ops::user_marks(f.user(), MushafLayout::V2, 8, 12, vec![2])).unwrap();
        assert_eq!(marks.bookmarks.len(), 1);
        assert!(f.take_kinds().is_empty());
        let bad = run(ops::user_marks(f.user(), MushafLayout::V2, 12, 8, vec![2]));
        assert!(matches!(bad, Err(AppError::InvalidArgument(_))), "{bad:?}");
    }

    #[test]
    fn failed_mutations_emit_nothing_and_map_errors() {
        let f = Fixture::new();
        let invalid = [
            run(ops::bookmark_toggle_ayah(f.handle(), f.user(), 0)).map(|_| ()),
            run(ops::bookmark_upsert(f.handle(), f.user(), ayah_input(6237))).map(|_| ()),
            run(ops::highlight_clear_range(f.handle(), f.user(), 9, 8)).map(|_| ()),
            run(ops::reading_bookmark_set(
                f.handle(),
                f.user(),
                ReadingBookmarkInput {
                    ayah_id: 1,
                    layout: MushafLayout::V1,
                    page: 605,
                },
            ))
            .map(|_| ()),
            run(ops::tag_upsert(
                f.handle(),
                f.user(),
                TagInput {
                    id: None,
                    name: " ".into(),
                    color: None,
                },
            ))
            .map(|_| ()),
        ];
        for r in invalid {
            assert!(matches!(r, Err(AppError::InvalidArgument(_))), "{r:?}");
        }
        let missing = [
            run(ops::bookmark_delete(f.handle(), f.user(), "x".into())).map(|_| ()),
            run(ops::bookmark_restore(f.handle(), f.user(), "x".into())).map(|_| ()),
            run(ops::highlight_delete(f.handle(), f.user(), "x".into())).map(|_| ()),
            run(ops::highlight_restore(f.handle(), f.user(), "x".into())).map(|_| ()),
            run(ops::note_delete(f.handle(), f.user(), "x".into())).map(|_| ()),
            run(ops::note_restore(f.handle(), f.user(), "x".into())).map(|_| ()),
            run(ops::collection_delete(f.handle(), f.user(), "x".into())),
            run(ops::collection_set_membership(
                f.handle(),
                f.user(),
                "x".into(),
                Vec::new(),
            ))
            .map(|_| ()),
            run(ops::tag_delete(f.handle(), f.user(), "x".into())),
            run(ops::item_tags_set(
                f.handle(),
                f.user(),
                TaggableKind::Note,
                "x".into(),
                Vec::new(),
            )),
        ];
        for r in missing {
            assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
        }
        assert!(f.take_kinds().is_empty());
    }
}
