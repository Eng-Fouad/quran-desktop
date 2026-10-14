//! Quran text commands.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.

use quran_core::{CoreDb, CoreError, PackDb};
use quran_packs::{PackError, PackManager};
use quran_types::{AppError, AyahText, CopyOptions, MushafLayout};
use tauri::State;

use crate::state::AppState;
use crate::util::blocking;

/// Ayahs `from_ayah_id..=to_ayah_id` (at most 300) with page numbers in `layout`.
#[tauri::command]
#[specta::specta]
pub async fn quran_get_ayahs(
    state: State<'_, AppState>,
    layout: MushafLayout,
    from_ayah_id: u32,
    to_ayah_id: u32,
) -> Result<Vec<AyahText>, AppError> {
    get_ayahs(state.core.clone(), layout, from_ayah_id, to_ayah_id).await
}

/// Copy text for an ayah range (at most 6236 ayahs).
#[tauri::command]
#[specta::specta]
pub async fn quran_copy_text(
    state: State<'_, AppState>,
    from_ayah_id: u32,
    to_ayah_id: u32,
    options: CopyOptions,
) -> Result<String, AppError> {
    let core = state.core.clone();
    let packs = state.packs.clone();
    blocking(move || {
        copy_text(&core, from_ayah_id, to_ayah_id, &options, |pack_id| {
            translation_plain(&packs, pack_id, from_ayah_id, to_ayah_id)
        })
    })
    .await
}

// `CoreDb::ayahs` validates before any IO: ids in 1..=6236, from ≤ to, at most 300 ayahs (InvalidArgument).
pub(crate) async fn get_ayahs(
    core: CoreDb,
    layout: MushafLayout,
    from: u32,
    to: u32,
) -> Result<Vec<AyahText>, AppError> {
    blocking(move || Ok(core.ayahs(layout, from, to)?)).await
}

// The copy format: the Arabic part (words, optional ﴿N﴾ markers, optional "\n{reference}") comes from core.db; when a
// translation pack is set, "\n\n{plain text of each ayah joined by ' '}" follows. `translation` returns `None` when the
// pack is not installed (the copy still succeeds with the Arabic only; the setting may name a pack that was removed
// since). The Arabic part is built first, so an invalid range never reaches the pack.
fn copy_text(
    core: &CoreDb,
    from: u32,
    to: u32,
    options: &CopyOptions,
    translation: impl FnOnce(&str) -> Result<Option<String>, AppError>,
) -> Result<String, AppError> {
    let mut text = core.copy_text(from, to, options)?;
    let pack_id = options
        .translation_pack_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(pack_id) = pack_id {
        match translation(pack_id)? {
            Some(plain) if !plain.is_empty() => {
                text.push_str("\n\n");
                text.push_str(&plain);
            }
            _ => {}
        }
    }
    Ok(text)
}

// The translation of `from..=to` as copy text, or `None` when the pack is not there: not installed
// (`PackError::NotFound`) or its database file has gone (`CoreError::NotFound` from `PackDb::open`). Any other failure
// (a corrupt pack, an IO error) is returned, so the user learns that the copy could not include the translation.
fn translation_plain(
    packs: &PackManager,
    pack_id: &str,
    from: u32,
    to: u32,
) -> Result<Option<String>, AppError> {
    let db = match packs.translation_db(pack_id) {
        Ok(db) => db,
        Err(PackError::NotFound(reason) | PackError::Core(CoreError::NotFound(reason))) => {
            log::warn!(
                "copy: translation {pack_id} is not available ({reason}); copying the Arabic only"
            );
            return Ok(None);
        }
        Err(e) => return Err(e.into()),
    };
    Ok(Some(pack_plain(&db, from, to)?))
}

// The pack's stored `plain` text (tags stripped, footnote markers removed) of every ayah in `from..=to`, in mushaf
// order, joined by one space. Ayahs the pack does not translate (or translates with blank text) are skipped.
fn pack_plain(db: &PackDb, from: u32, to: u32) -> Result<String, CoreError> {
    // One indexed range read (`plain_range`), not one query per ayah: a copy may span the whole Quran.
    let texts = db.plain_range(from, to)?;
    Ok(join_plain(texts.iter().map(|(_, plain)| plain.as_str())))
}

fn join_plain<'a>(texts: impl Iterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for text in texts.map(str::trim).filter(|t| !t.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(text);
    }
    out
}

/// Shared by the command tests of this module and `mushaf.rs`.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    use quran_core::CoreDb;

    /// The real core.db for command tests: `QD_CORE_DB` (relative to the workspace root), else
    /// `src-tauri/resources/core.db`. `None` (with a note on stderr) while only the build.rs placeholder exists, so
    /// a fresh clone stays green; the quran-core `--ignored` suite is the place that insists on the real file.
    pub(crate) fn real_core() -> Option<CoreDb> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let path = match std::env::var_os("QD_CORE_DB").filter(|v| !v.is_empty()) {
            Some(p) => {
                let p = PathBuf::from(p);
                if p.is_absolute() {
                    p
                } else {
                    manifest
                        .parent()
                        .map_or_else(|| p.clone(), |root| root.join(&p))
                }
            }
            None => manifest.join("resources").join("core.db"),
        };
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len < 1_000_000 {
            eprintln!(
                "note: {} is not a built core.db ({len} bytes); real-data command checks skipped",
                path.display()
            );
            return None;
        }
        match CoreDb::open(&path) {
            Ok(core) => Some(core),
            Err(e) => panic!("{}: {e}", path.display()),
        }
    }
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

    use quran_core::{NORMALIZER_VERSION, PackDbWriter, PackEntryInput, PackMeta, PackTokenizer};
    use quran_types::{PackKind, ReferenceStyle, SajdaKind, TextDir};

    use super::test_support::real_core;
    use super::*;

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn options(pack: Option<&str>) -> CopyOptions {
        CopyOptions {
            include_reference: true,
            reference_style: ReferenceStyle::Short,
            ayah_numbers: true,
            translation_pack_id: pack.map(str::to_owned),
        }
    }

    /// A translation pack written with `PackDbWriter`: `(ayah_id, html, plain)` rows.
    fn write_pack(path: &Path, rows: &[(u32, &str, &str)]) -> PackDb {
        let meta = PackMeta {
            pack_id: "tr.en.test".into(),
            kind: PackKind::Translation,
            lang: "en".into(),
            dir: TextDir::Ltr,
            name: "Test".into(),
            author: "Test".into(),
            source: "test".into(),
            source_version: "1".into(),
            licence: "test".into(),
            attribution: "test".into(),
            tokenizer: PackTokenizer::PorterUnicode61,
            normalizer_version: NORMALIZER_VERSION,
            format: 1,
        };
        let mut writer = PackDbWriter::create(path, &meta).unwrap();
        for &(ayah_id, html, plain) in rows {
            writer
                .entry(&PackEntryInput {
                    ayah_id,
                    to_ayah_id: ayah_id,
                    html: html.into(),
                    plain: plain.into(),
                })
                .unwrap();
        }
        writer.finish().unwrap();
        PackDb::open(path).unwrap()
    }

    #[test]
    fn ayah_ranges_are_validated_before_any_io() {
        let core = CoreDb::unavailable("test".into());
        for (from, to) in [(0, 1), (2, 1), (1, 6237), (1, 301), (6000, 6300)] {
            let err = run(get_ayahs(core.clone(), MushafLayout::V2, from, to)).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{from}..={to}: {err:?}"
            );
        }
        let never =
            |_: &str| -> Result<Option<String>, AppError> { panic!("translation asked for") };
        for (from, to) in [(0, 1), (7, 1), (1, 6237)] {
            let err = copy_text(&core, from, to, &options(Some("tr.en.x")), never).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{from}..={to}: {err:?}"
            );
        }
        // 300 ayahs (1..=300) is the largest accepted window; then the missing core answers.
        let err = run(get_ayahs(core.clone(), MushafLayout::V2, 1, 300)).unwrap_err();
        assert_eq!(
            err,
            AppError::NotFound(quran_core::core_db::UNAVAILABLE_MESSAGE.into())
        );
        // The whole Quran is a valid copy range.
        let err = copy_text(&core, 1, 6236, &options(None), never).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    }

    #[test]
    fn plain_texts_are_trimmed_and_joined_by_one_space() {
        assert_eq!(join_plain(["A", "", "  ", " B\n"].into_iter()), "A B");
        assert_eq!(join_plain(std::iter::empty()), "");
        assert_eq!(
            join_plain(["one  two", "three"].into_iter()),
            "one  two three",
            "inner text is kept as the pack stores it"
        );
    }

    #[test]
    fn translations_come_from_the_stored_plain_column() {
        let dir = tempfile::tempdir().unwrap();
        let db = write_pack(
            &dir.path().join("pack.db"),
            &[
                (
                    1,
                    r#"<p>In the name of Allah,<sup class="fn" data-fn="1:1:1">1</sup> the Entirely Merciful.</p>"#,
                    "In the name of Allah, the Entirely Merciful.",
                ),
                (
                    2,
                    "<p>[All] praise is [due] to Allah</p>",
                    "[All] praise is [due] to Allah",
                ),
                (4, "<p> </p>", " "),
                (5, "<p>It is You we worship</p>", "It is You we worship"),
            ],
        );
        // In mushaf order; ayah 3 (missing) and ayah 4 (blank) are skipped; the html is never used.
        assert_eq!(
            pack_plain(&db, 1, 7).unwrap(),
            "In the name of Allah, the Entirely Merciful. [All] praise is [due] to Allah It is You we worship"
        );
        assert_eq!(pack_plain(&db, 5, 5).unwrap(), "It is You we worship");
        assert_eq!(pack_plain(&db, 6, 6236).unwrap(), "");
    }

    #[test]
    fn translations_are_appended_only_when_available() {
        let Some(core) = real_core() else {
            return;
        };
        let arabic = copy_text(&core, 1, 1, &options(None), |_| panic!("no pack set")).unwrap();
        assert!(arabic.ends_with("﴿١﴾\n(1:1)"), "{arabic}");
        let blank = copy_text(&core, 1, 1, &options(Some("  ")), |_| panic!("blank id")).unwrap();
        assert_eq!(blank, arabic);
        let with = copy_text(&core, 1, 1, &options(Some(" tr.en.saheeh ")), |id| {
            assert_eq!(id, "tr.en.saheeh");
            Ok(Some("In the name of Allah".into()))
        })
        .unwrap();
        assert_eq!(with, format!("{arabic}\n\nIn the name of Allah"));
        let missing = copy_text(&core, 1, 1, &options(Some("tr.en.gone")), |_| Ok(None)).unwrap();
        assert_eq!(missing, arabic);
        let untranslated = copy_text(&core, 1, 1, &options(Some("tr.en.x")), |_| {
            Ok(Some(String::new()))
        })
        .unwrap();
        assert_eq!(untranslated, arabic);
        let failing = copy_text(&core, 1, 1, &options(Some("tr.en.x")), |_| {
            Err(AppError::Database("broken pack".into()))
        });
        assert_eq!(failing, Err(AppError::Database("broken pack".into())));
    }

    #[test]
    fn a_real_copy_with_a_real_pack() {
        let Some(core) = real_core() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let db = write_pack(
            &dir.path().join("pack.db"),
            &[
                (
                    3994,
                    "<p>…and he fell down bowing and turned in repentance.</p>",
                    "…and he fell down bowing and turned in repentance.",
                ),
                (
                    3995,
                    "<p>So We forgave him that.</p>",
                    "So We forgave him that.",
                ),
            ],
        );
        let opts = CopyOptions {
            include_reference: true,
            reference_style: ReferenceStyle::Long,
            ayah_numbers: true,
            translation_pack_id: Some("tr.en.test".into()),
        };
        let text = copy_text(&core, 3994, 3995, &opts, |_| {
            Ok(Some(pack_plain(&db, 3994, 3995)?))
        })
        .unwrap();
        let (arabic, rest) = text.split_once('\n').unwrap();
        assert!(arabic.contains("وَأَنَابَ ۩ ﴿٢٤﴾"), "{arabic}");
        assert!(!arabic.contains("  "), "{arabic}");
        let sad = &core.index().unwrap().surahs[37].name_simple;
        assert_eq!(
            rest,
            format!(
                "— {sad} 38:24–25\n\n…and he fell down bowing and turned in repentance. So We forgave him that."
            )
        );
    }

    #[test]
    fn real_ayah_rows() {
        let Some(core) = real_core() else {
            return;
        };
        let rows = run(get_ayahs(core.clone(), MushafLayout::V2, 8, 12)).unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!((rows[0].surah, rows[0].ayah, rows[0].page), (2, 1, 2));
        let sajda = run(get_ayahs(core.clone(), MushafLayout::V2, 3994, 3994)).unwrap();
        assert_eq!((sajda[0].surah, sajda[0].ayah), (38, 24));
        assert_eq!(sajda[0].sajda, Some(SajdaKind::Recommended));
        let full = run(get_ayahs(core, MushafLayout::V4, 5937, 6236)).unwrap();
        assert_eq!(full.len(), 300);
        assert_eq!(full.last().unwrap().page, 604);
    }
}
