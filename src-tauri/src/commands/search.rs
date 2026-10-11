//! Search commands (§5.13). Owner: WP1b.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.

use quran_core::{PackDb, SearchEngine, UserDb};
use quran_types::{AppError, SearchRequest, SearchResults, SearchScope, SearchSuggestion};
use tauri::State;

use crate::state::AppState;
use crate::util::blocking;

// One search in the request's scope (§2.2.5): the Quran (core.db), an installed translation pack, or the notes. The
// engine validates the request before any IO (limit 1..=2000, query length; then the surah/juz filters against the
// index) and answers a query that normalises to nothing with an empty result. A translation pack that is not
// installed is NotFound (from the pack manager). Runs on the blocking pool: SQLite only, no network.
#[tauri::command]
#[specta::specta]
pub async fn search_query(
    state: State<'_, AppState>,
    request: SearchRequest,
) -> Result<SearchResults, AppError> {
    let search = state.search.clone();
    let user = state.user.clone();
    let packs = state.packs.clone();
    blocking(move || {
        query(
            &search,
            &user,
            |pack_id| Ok(packs.translation_db(pack_id)?),
            &request,
        )
    })
    .await
}

// Completions of the word being typed (vocab_loose, most frequent first); limit 1..=100.
#[tauri::command]
#[specta::specta]
pub async fn search_suggest(
    state: State<'_, AppState>,
    prefix: String,
    limit: u32,
) -> Result<Vec<SearchSuggestion>, AppError> {
    let search = state.search.clone();
    blocking(move || suggest(&search, &prefix, limit)).await
}

// The command bodies without tauri state, so tests can drive them with any core, user.db and pack. `open_pack` is
// `PackManager::translation_db` in the app.
pub(crate) fn query(
    search: &SearchEngine,
    user: &UserDb,
    open_pack: impl FnOnce(&str) -> Result<PackDb, AppError>,
    request: &SearchRequest,
) -> Result<SearchResults, AppError> {
    match &request.scope {
        SearchScope::Quran => Ok(search.search_quran(request)?),
        SearchScope::Notes => Ok(search.search_notes(user, request)?),
        SearchScope::Translation { pack_id } => {
            let pack_id = pack_id.trim();
            if pack_id.is_empty() {
                return Err(AppError::InvalidArgument(
                    "the translation scope needs a pack id".into(),
                ));
            }
            let pack = open_pack(pack_id)?;
            Ok(search.search_pack(&pack, request)?)
        }
    }
}

pub(crate) fn suggest(
    search: &SearchEngine,
    prefix: &str,
    limit: u32,
) -> Result<Vec<SearchSuggestion>, AppError> {
    Ok(search.suggest(prefix, limit)?)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use std::path::Path;

    use quran_core::core_db::UNAVAILABLE_MESSAGE;
    use quran_core::pack_db::PACK_FORMAT;
    use quran_core::{
        CoreDb, Level, NORMALIZER_VERSION, PackDbWriter, PackEntryInput, PackMeta, PackTokenizer,
        fold_latin, normalize_ar,
    };
    use quran_packs::PackError;
    use quran_types::{MushafLayout, PackKind, SearchMode, TextDir};

    use super::*;
    use crate::commands::quran::test_support::real_core;

    fn request(query: &str, scope: SearchScope) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            scope,
            mode: SearchMode::Smart,
            surah: None,
            juz: None,
            limit: 50,
            layout: MushafLayout::V2,
        }
    }

    fn translation(pack_id: &str) -> SearchScope {
        SearchScope::Translation {
            pack_id: pack_id.into(),
        }
    }

    fn user_db(dir: &Path) -> UserDb {
        UserDb::open(&dir.join("user.db")).unwrap()
    }

    fn no_pack(_: &str) -> Result<PackDb, AppError> {
        panic!("the pack must not be opened")
    }

    /// A small English pack (porter tokenizer) with "mercy" in 1:1 and 1:3.
    fn english_pack(dir: &Path) -> PackDb {
        let path = dir.join("tr.en.test").join("pack.db");
        let meta = PackMeta {
            pack_id: "tr.en.test".into(),
            kind: PackKind::Translation,
            lang: "en".into(),
            dir: TextDir::Ltr,
            name: "Test".into(),
            author: "test".into(),
            source: "test".into(),
            source_version: "1".into(),
            licence: "test".into(),
            attribution: "test".into(),
            tokenizer: PackTokenizer::PorterUnicode61,
            normalizer_version: NORMALIZER_VERSION,
            format: PACK_FORMAT,
        };
        let mut w = PackDbWriter::create(&path, &meta).unwrap();
        for (ayah_id, plain) in [
            (
                1,
                "In the name of Allah, the Entirely Merciful, the Especially Merciful.",
            ),
            (2, "All praise is due to Allah, Lord of the worlds."),
            (
                3,
                "The Entirely Merciful, the Especially Merciful, full of mercy.",
            ),
        ] {
            w.entry(&PackEntryInput {
                ayah_id,
                to_ayah_id: ayah_id,
                html: plain.into(),
                plain: plain.into(),
            })
            .unwrap();
        }
        w.finish().unwrap();
        PackDb::open(&path).unwrap()
    }

    #[test]
    fn invalid_requests_fail_before_any_io() {
        let dir = tempfile::tempdir().unwrap();
        let search = SearchEngine::new(CoreDb::unavailable("test".into()));
        let user = user_db(dir.path());
        for scope in [SearchScope::Quran, SearchScope::Notes] {
            let mut req = request("الله", scope);
            req.limit = 0;
            let err = query(&search, &user, no_pack, &req).unwrap_err();
            assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
            req.limit = 2001;
            let err = query(&search, &user, no_pack, &req).unwrap_err();
            assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
        }
        for blank in ["", "   "] {
            let err = query(
                &search,
                &user,
                no_pack,
                &request("mercy", translation(blank)),
            )
            .unwrap_err();
            assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
        }
        for limit in [0, 101] {
            let err = suggest(&search, "ال", limit).unwrap_err();
            assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
        }
    }

    #[test]
    fn an_unavailable_core_reports_the_degrade_message() {
        let dir = tempfile::tempdir().unwrap();
        let search = SearchEngine::new(CoreDb::unavailable("test".into()));
        let user = user_db(dir.path());
        let expected = AppError::NotFound(UNAVAILABLE_MESSAGE.into());
        for scope in [SearchScope::Quran, SearchScope::Notes] {
            assert_eq!(
                query(&search, &user, no_pack, &request("الله", scope)),
                Err(expected.clone())
            );
        }
        let pack = english_pack(dir.path());
        assert_eq!(
            query(
                &search,
                &user,
                |_| Ok(pack),
                &request("mercy", translation("tr.en.test"))
            ),
            Err(expected.clone())
        );
        assert_eq!(suggest(&search, "ال", 5), Err(expected));
    }

    #[test]
    fn pack_errors_map_to_their_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let search = SearchEngine::new(CoreDb::unavailable("test".into()));
        let user = user_db(dir.path());
        let mut opened = String::new();
        let err = query(
            &search,
            &user,
            |id| {
                opened = id.to_owned();
                Err(PackError::NotFound(format!("pack {id} is not installed")).into())
            },
            &request("mercy", translation(" tr.en.gone ")),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
        assert_eq!(opened, "tr.en.gone", "the pack id is trimmed");
    }

    #[test]
    fn every_scope_on_the_real_core() {
        let Some(core) = real_core() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let search = SearchEngine::new(core);
        let user = user_db(dir.path());

        // Quran: 1:1 and 1:3 carry الرحمن; the hit words are the ayah's words, end marker last.
        let r = query(
            &search,
            &user,
            no_pack,
            &request("الرحمن", SearchScope::Quran),
        )
        .unwrap();
        let first = &r.groups[0].hits[0];
        assert_eq!((first.surah, first.ayah, first.page), (1, 1, 1));
        assert_eq!(first.matched_word_ids, [first.first_word_id + 2]);
        assert!(first.words.last().unwrap().starts_with('\u{06DD}'));

        // Translation: snippets from FTS5, escaped, with marks.
        let pack = english_pack(dir.path());
        let r = query(
            &search,
            &user,
            |_| Ok(pack),
            &request("mercy", translation("tr.en.test")),
        )
        .unwrap();
        assert_eq!(r.total, 2, "porter: Merciful (1:1) and mercy (1:3)");
        assert_eq!(
            r.groups[0].hits[0].snippet.as_deref(),
            Some(
                "In the name of Allah, the Entirely <mark>Merciful</mark>, the Especially <mark>Merciful</mark>."
            )
        );

        // Notes: the FTS index is kept by user.db's triggers.
        let body = "Reflections on الرَّحْمَٰنِ and mercy";
        let body_search = fold_latin(&normalize_ar(&format!(" {body}"), Level::Loose));
        user.with(|c| {
            c.execute(
                &format!(
                    "INSERT INTO note (id, from_ayah_id, to_ayah_id, body, body_search, created_at, updated_at) \
                     VALUES ('n1', 1, 7, '{body}', '{body_search}', 0, 0)"
                ),
                (),
            )?;
            Ok(())
        })
        .unwrap();
        let r = query(
            &search,
            &user,
            no_pack,
            &request("الرحمن", SearchScope::Notes),
        )
        .unwrap();
        assert_eq!(r.total, 1);
        let hit = &r.groups[0].hits[0];
        assert_eq!(hit.note_id.as_deref(), Some("n1"));
        assert_eq!(
            hit.snippet.as_deref(),
            Some("Reflections on <mark>الرَّحْمَٰنِ</mark> and mercy")
        );

        // Suggestions.
        let s = suggest(&search, "الرح", 5).unwrap();
        assert!(!s.is_empty() && s.iter().all(|t| t.term.starts_with("الرح")));
    }

    #[test]
    fn the_async_commands_run_on_the_blocking_pool() {
        let dir = tempfile::tempdir().unwrap();
        let search = SearchEngine::new(CoreDb::unavailable("test".into()));
        let user = user_db(dir.path());
        let req = request("", SearchScope::Notes);
        let out =
            tauri::async_runtime::block_on(blocking(move || query(&search, &user, no_pack, &req)));
        // A query that normalises to nothing is answered without any IO, even on an unavailable core.
        let out = out.unwrap();
        assert_eq!((out.total, out.groups.len(), out.truncated), (0, 0, false));
    }
}
