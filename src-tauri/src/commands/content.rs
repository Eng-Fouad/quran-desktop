//! Translation, tafsir and word-by-word commands (§5.13). Owner: WP5e.
//!
//! - `translation_get` reads installed translation packs (`PackManager::translation_db`, cached handles) on the blocking
//!   pool: one row per ayah of the range, each with the packs' items in the requested order (a pack without an entry
//!   for an ayah is left out of that row) and their footnotes.
//! - `tafsir_get` and `wbw_get_range` await the pack manager, which reads a QuranEnc pack DB or fetches Quran.com
//!   chapters on demand (§2.5.6, §2.5.7).
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.

use std::collections::HashMap;

use quran_core::PackEntry;
use quran_packs::PackManager;
use quran_types::limits::MAX_TRANSLATIONS;
use quran_types::{
    AYAH_COUNT, AppError, TafsirEntry, TranslationRow, TranslationText, WORD_COUNT, WbwEntry,
};
use tauri::State;

use crate::state::AppState;
use crate::util::blocking;

/// Most ayahs one `translation_get` call reads (§5.13).
pub const MAX_TRANSLATION_AYAHS: u32 = 300;
/// Most words one `wbw_get_range` call reads (§5.13).
pub const MAX_WBW_WORDS: u32 = 2_000;

/// At most 300 ayahs and 5 packs; items in requested pack order.
#[tauri::command]
#[specta::specta]
pub async fn translation_get(
    state: State<'_, AppState>,
    pack_ids: Vec<String>,
    from_ayah_id: u32,
    to_ayah_id: u32,
) -> Result<Vec<TranslationRow>, AppError> {
    let packs = state.packs.clone();
    blocking(move || translations(&packs, &pack_ids, from_ayah_id, to_ayah_id)).await
}

/// May fetch the chapter (QF-sourced packs).
#[tauri::command]
#[specta::specta]
pub async fn tafsir_get(
    state: State<'_, AppState>,
    pack_id: String,
    ayah_id: u32,
) -> Result<TafsirEntry, AppError> {
    check_ayah_range(ayah_id, ayah_id)?;
    Ok(state.packs.tafsir_entry(pack_id.trim(), ayah_id).await?)
}

/// At most 2000 words.
#[tauri::command]
#[specta::specta]
pub async fn wbw_get_range(
    state: State<'_, AppState>,
    pack_id: String,
    from_word_id: u32,
    to_word_id: u32,
) -> Result<Vec<WbwEntry>, AppError> {
    check_word_range(from_word_id, to_word_id)?;
    Ok(state
        .packs
        .wbw_range(pack_id.trim(), from_word_id, to_word_id)
        .await?)
}

// The body of `translation_get` (blocking; tests drive it with any manager). Pack ids are trimmed and deduplicated
// (first occurrence wins); a pack that is not installed fails the call with `not_found` (the store then asks pack by
// pack, WP11a). Footnotes are read per ayah, so each item carries exactly its own.
pub(crate) fn translations(
    packs: &PackManager,
    pack_ids: &[String],
    from: u32,
    to: u32,
) -> Result<Vec<TranslationRow>, AppError> {
    check_ayah_range(from, to)?;
    if to - from >= MAX_TRANSLATION_AYAHS {
        return Err(AppError::InvalidArgument(format!(
            "ayahs {from}..={to}: at most {MAX_TRANSLATION_AYAHS} per call"
        )));
    }
    let mut ids: Vec<&str> = Vec::new();
    for id in pack_ids.iter().map(|id| id.trim()) {
        if id.is_empty() {
            return Err(AppError::InvalidArgument("an empty pack id".into()));
        }
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() || ids.len() > MAX_TRANSLATIONS {
        return Err(AppError::InvalidArgument(format!(
            "{} translation packs asked for; 1..={MAX_TRANSLATIONS} per call",
            ids.len()
        )));
    }

    struct PackRows {
        id: String,
        entries: HashMap<u32, PackEntry>,
        db: quran_core::PackDb,
    }
    let mut sources = Vec::with_capacity(ids.len());
    for id in ids {
        let db = packs.translation_db(id)?;
        let entries = db
            .entries(from, to)?
            .into_iter()
            .map(|e| (e.ayah_id, e))
            .collect();
        sources.push(PackRows {
            id: id.to_owned(),
            entries,
            db,
        });
    }

    let mut rows = Vec::with_capacity(usize::try_from(to - from + 1).unwrap_or(0));
    for ayah_id in from..=to {
        let mut items = Vec::with_capacity(sources.len());
        for source in &mut sources {
            let Some(entry) = source.entries.remove(&ayah_id) else {
                continue;
            };
            items.push(TranslationText {
                pack_id: source.id.clone(),
                html: entry.html,
                footnotes: source.db.footnotes_for(&[ayah_id])?,
            });
        }
        rows.push(TranslationRow { ayah_id, items });
    }
    Ok(rows)
}

fn check_ayah_range(from: u32, to: u32) -> Result<(), AppError> {
    if from == 0 || to > AYAH_COUNT || from > to {
        Err(AppError::InvalidArgument(format!(
            "ayahs {from}..={to} are not a range in 1..={AYAH_COUNT}"
        )))
    } else {
        Ok(())
    }
}

fn check_word_range(from: u32, to: u32) -> Result<(), AppError> {
    if from == 0 || to > WORD_COUNT || from > to {
        return Err(AppError::InvalidArgument(format!(
            "words {from}..={to} are not a range in 1..={WORD_COUNT}"
        )));
    }
    if to - from >= MAX_WBW_WORDS {
        return Err(AppError::InvalidArgument(format!(
            "words {from}..={to}: at most {MAX_WBW_WORDS} per call"
        )));
    }
    Ok(())
}

#[cfg(all(test, debug_assertions))]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use std::path::Path;

    use quran_core::{
        FootnoteInput, InstalledPackRow, InstalledStatus, PackDbWriter, PackEntryInput, PackMeta,
        PackTokenizer,
    };
    use quran_types::{PackKind, TextDir};
    use tauri::Manager;
    use tempfile::TempDir;

    use super::*;
    use crate::commands::packs::test_support::{app, run, shutdown};

    fn invalid<T: std::fmt::Debug>(r: Result<T, AppError>) -> bool {
        matches!(r, Err(AppError::InvalidArgument(_)))
    }

    /// A small pack DB at `packs/{kind}/{id}/1/pack.db`, registered as installed: one entry per ayah of `ayahs` (tafsir
    /// packs: one range entry over all of them), and a footnote on the first.
    fn install_pack(state: &AppState, id: &str, kind: PackKind, ayahs: &[u32]) {
        let dir_kind = if kind == PackKind::Tafsir {
            "tafsir"
        } else {
            "translation"
        };
        let rel = format!("{dir_kind}/{id}/1/pack.db");
        let path = rel
            .split('/')
            .fold(state.paths.packs.clone(), |p, seg| p.join(seg));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_pack(&path, id, kind, ayahs);
        let now = state.user.now_ms();
        state
            .user
            .pack_upsert(&InstalledPackRow {
                pack_id: id.to_owned(),
                kind,
                version: "1".into(),
                path: Some(rel),
                status: InstalledStatus::Installed,
                bytes: std::fs::metadata(&path).unwrap().len(),
                items_total: 1,
                items_present: 1,
                sha256: None,
                source_version: None,
                installed_at: now,
                updated_at: now,
                last_checked_at: Some(now),
            })
            .unwrap();
    }

    fn write_pack(path: &Path, id: &str, kind: PackKind, ayahs: &[u32]) {
        let (lang, dir) = if kind == PackKind::Tafsir {
            ("ar", TextDir::Rtl)
        } else {
            ("en", TextDir::Ltr)
        };
        let meta = PackMeta {
            pack_id: id.to_owned(),
            kind,
            lang: lang.into(),
            dir,
            name: id.into(),
            author: "test".into(),
            source: "test".into(),
            source_version: "1".into(),
            licence: "test".into(),
            attribution: "test".into(),
            tokenizer: PackTokenizer::Unicode61RemoveDiacritics,
            normalizer_version: quran_core::NORMALIZER_VERSION,
            format: 1,
        };
        let mut w = PackDbWriter::create(path, &meta).unwrap();
        if kind == PackKind::Tafsir {
            let (first, last) = (ayahs[0], *ayahs.last().unwrap());
            w.entry(&PackEntryInput {
                ayah_id: first,
                to_ayah_id: last,
                html: format!("<p>tafsir {first}-{last}</p>"),
                plain: format!("tafsir {first}-{last}"),
            })
            .unwrap();
        } else {
            for &a in ayahs {
                w.entry(&PackEntryInput {
                    ayah_id: a,
                    to_ayah_id: a,
                    html: format!("<p>{id} {a}</p>"),
                    plain: format!("{id} {a}"),
                })
                .unwrap();
            }
            w.footnote(&FootnoteInput {
                id: format!("1:{}:1", ayahs[0]),
                ayah_id: ayahs[0],
                marker: "1".into(),
                html: "a note".into(),
            })
            .unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn translations_come_in_pack_order_with_their_footnotes() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let state = app.state::<AppState>();
        install_pack(&state, "tr.en.saheeh", PackKind::Translation, &[1, 2, 3]);
        install_pack(&state, "tr.en.rwwad", PackKind::Translation, &[2, 3]);
        let ids = vec![
            "tr.en.rwwad".to_owned(),
            " tr.en.saheeh ".to_owned(),
            "tr.en.rwwad".to_owned(),
        ];
        let rows = run(translation_get(app.state(), ids, 1, 3)).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].ayah_id, 1);
        let order = |r: &TranslationRow| {
            r.items
                .iter()
                .map(|i| i.pack_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(order(&rows[0]), ["tr.en.saheeh"], "rwwad has no ayah 1");
        assert_eq!(order(&rows[1]), ["tr.en.rwwad", "tr.en.saheeh"]);
        assert_eq!(rows[1].items[1].html, "<p>tr.en.saheeh 2</p>");
        assert_eq!(rows[0].items[0].footnotes.len(), 1, "saheeh's note on 1");
        assert_eq!(rows[0].items[0].footnotes[0].id, "1:1:1");
        assert_eq!(rows[1].items[0].footnotes.len(), 1, "rwwad's note on 2");
        assert!(rows[2].items.iter().all(|i| i.footnotes.is_empty()));

        // A pack that is not installed fails the call; the store then asks pack by pack.
        assert!(matches!(
            run(translation_get(
                app.state(),
                vec!["tr.en.saheeh".into(), "tr.fr.rashid".into()],
                1,
                3
            )),
            Err(AppError::NotFound(_))
        ));
        // An installed pack whose database has gone: not found as well (the copy command copies the Arabic only then).
        install_pack(&state, "tr.fr.rashid", PackKind::Translation, &[1]);
        std::fs::remove_file(
            state
                .paths
                .packs
                .join("translation")
                .join("tr.fr.rashid")
                .join("1")
                .join("pack.db"),
        )
        .unwrap();
        assert!(matches!(
            run(translation_get(
                app.state(),
                vec!["tr.fr.rashid".into()],
                1,
                1
            )),
            Err(AppError::NotFound(_))
        ));
        shutdown(&app);
    }

    #[test]
    fn translation_arguments_are_validated() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let get = |ids: Vec<&str>, from, to| {
            run(translation_get(
                app.state(),
                ids.into_iter().map(str::to_owned).collect(),
                from,
                to,
            ))
        };
        assert!(invalid(get(vec!["tr.en.saheeh"], 0, 1)));
        assert!(invalid(get(vec!["tr.en.saheeh"], 2, 1)));
        assert!(invalid(get(vec!["tr.en.saheeh"], 6_236, 6_237)));
        assert!(invalid(get(vec!["tr.en.saheeh"], 1, 301)));
        assert!(invalid(get(vec![], 1, 1)));
        assert!(invalid(get(vec![""], 1, 1)));
        assert!(invalid(get(
            vec!["a.b", "c.d", "e.f", "g.h", "i.j", "k.l"],
            1,
            1
        )));
        assert!(matches!(
            get(vec!["tr.en.saheeh"], 1, 300),
            Err(AppError::NotFound(_))
        ));
        shutdown(&app);
    }

    #[test]
    fn tafsir_reads_pack_dbs_and_fetches_chapters_on_demand() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let state = app.state::<AppState>();
        // Not installed QuranEnc tafsir: not found; a translation pack id: not found either.
        assert!(matches!(
            run(tafsir_get(app.state(), "tafsir.ar.muyassar".into(), 8)),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            run(tafsir_get(app.state(), "tr.en.saheeh".into(), 8)),
            Err(AppError::NotFound(_))
        ));
        install_pack(&state, "tafsir.ar.muyassar", PackKind::Tafsir, &[8, 9, 10]);
        let entry = run(tafsir_get(app.state(), "tafsir.ar.muyassar".into(), 9)).unwrap();
        assert_eq!((entry.from_ayah_id, entry.to_ayah_id), (8, 10));
        assert_eq!(entry.lang, "ar");
        assert_eq!(entry.dir, TextDir::Rtl);
        assert_eq!(entry.fetched_at, None);
        assert!(!entry.stale);
        assert!(matches!(
            run(tafsir_get(app.state(), "tafsir.ar.muyassar".into(), 11)),
            Err(AppError::NotFound(_))
        ));
        // A Quran.com tafsir that is not stored needs the network, which is off.
        assert!(matches!(
            run(tafsir_get(app.state(), "tafsir.en.ibn_kathir".into(), 1)),
            Err(AppError::Offline(_))
        ));
        assert!(invalid(run(tafsir_get(
            app.state(),
            "tafsir.ar.muyassar".into(),
            0
        ))));
        assert!(invalid(run(tafsir_get(
            app.state(),
            "tafsir.ar.muyassar".into(),
            6_237
        ))));
        shutdown(&app);
    }

    #[test]
    fn wbw_ranges_are_validated_and_fetched_on_demand() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let wbw = |from, to| run(wbw_get_range(app.state(), "wbw.en".into(), from, to));
        assert!(invalid(wbw(0, 1)));
        assert!(invalid(wbw(2, 1)));
        assert!(invalid(wbw(1, 2_001)));
        assert!(invalid(wbw(83_665, 83_666)));
        assert!(matches!(wbw(1, 2_000), Err(AppError::Offline(_))));
        assert!(matches!(
            run(wbw_get_range(app.state(), "tr.en.saheeh".into(), 1, 5)),
            Err(AppError::NotFound(_))
        ));
        shutdown(&app);
    }
}
