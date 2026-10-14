//! Mushaf page commands.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.

use quran_core::CoreDb;
use quran_types::{AppError, MushafStyle, PageData};
use tauri::State;

use crate::state::AppState;
use crate::util::blocking;

/// 1..=8 pages of `style` (pages 1..=604), one SQL query per page.
#[tauri::command]
#[specta::specta]
pub async fn mushaf_get_pages(
    state: State<'_, AppState>,
    style: MushafStyle,
    pages: Vec<u32>,
) -> Result<Vec<PageData>, AppError> {
    get_pages(state.core.clone(), style, pages).await
}

// The command body without tauri state, so tests can drive it with any `CoreDb`. `CoreDb::pages` validates the
// arguments before any IO (InvalidArgument: 0 or more than 8 pages, a page outside 1..=604); an unavailable core
// (debug degrade path) answers NotFound("core.db missing — run pnpm core:qdc").
pub(crate) async fn get_pages(
    core: CoreDb,
    style: MushafStyle,
    pages: Vec<u32>,
) -> Result<Vec<PageData>, AppError> {
    blocking(move || Ok(core.pages(style, &pages)?)).await
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use quran_types::{LineKind, MushafLayout};

    use super::*;
    use crate::commands::quran::test_support::real_core;

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn invalid_page_lists_are_rejected_before_any_io() {
        let core = CoreDb::unavailable("test".into());
        for pages in [vec![], vec![1; 9], vec![0], vec![605], vec![1, 2, 700]] {
            let err = run(get_pages(core.clone(), MushafStyle::Hafs, pages.clone())).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{pages:?}: {err:?}"
            );
        }
    }

    #[test]
    fn an_unavailable_core_reports_the_degrade_message() {
        let core = CoreDb::unavailable("test".into());
        let err = run(get_pages(core, MushafStyle::QcfV2, vec![1])).unwrap_err();
        assert_eq!(
            err,
            AppError::NotFound(quran_core::core_db::UNAVAILABLE_MESSAGE.into())
        );
    }

    #[test]
    fn real_pages_in_every_style() {
        let Some(core) = real_core() else {
            return;
        };
        for style in MushafStyle::ALL {
            let pages = run(get_pages(core.clone(), style, vec![1, 2, 604])).unwrap();
            assert_eq!(pages.len(), 3);
            assert_eq!(pages[0].style, style);
            assert_eq!(pages[0].layout, style.layout());
            assert_eq!(pages[0].lines.len(), 8);
            assert_eq!(pages[0].lines[0].kind, LineKind::SurahName);
            assert_eq!(pages[0].info.first_ayah_id, 1);
            assert_eq!(pages[0].info.last_ayah_id, 7);
            assert_eq!(pages[1].lines[1].kind, LineKind::Basmallah);
            assert_eq!(pages[2].info.surah_ids, vec![112, 113, 114]);
            assert_eq!(pages[2].info.last_ayah_id, 6236);
            let glyph = &pages[0].lines[1].words[0].glyph;
            if style == MushafStyle::Hafs {
                assert_eq!(glyph, &pages[0].lines[1].words[0].text);
            } else {
                assert!((1..=4).contains(&glyph.chars().count()), "{glyph:?}");
            }
        }
        let v1 = run(get_pages(core, MushafStyle::QcfV1, vec![3])).unwrap();
        assert_eq!(v1[0].layout, MushafLayout::V1);
    }
}
