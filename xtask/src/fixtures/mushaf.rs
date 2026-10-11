//! `export-fixtures --only mushaf`: `index.json` (`QuranIndex`), `pages/{style}/p{NNN}.json` (`PageData`) for
//! `super::PAGES` in all four styles, `ayahs/{from}-{to}.json` (`Vec<AyahText>`, layout v2) for
//! `super::AYAH_WINDOWS`; fills `source`, `pages` and `ayahWindows` (docs/ARCHITECTURE.md §4.6). Owner: WP1a.
//!
//! Every file is produced by `quran_core::CoreDb`, the same code the `mushaf_get_pages`/`quran_get_ayahs` commands run,
//! so the mock serves exactly what the app would. The `pages/` and `ayahs/` directories belong to this exporter and are
//! recreated on every run, so a changed page list never leaves stale files behind.

use std::path::Path;

use anyhow::Context;
use quran_core::CoreDb;
use quran_core::core_db::MAX_PAGES_PER_CALL;
use quran_types::{MushafLayout, MushafStyle};

use super::{AYAH_WINDOWS, FixtureCtx, Manifest, PAGES};

pub fn export(ctx: &FixtureCtx, manifest: &mut Manifest) -> anyhow::Result<()> {
    export_with(ctx, manifest, PAGES, AYAH_WINDOWS)
}

/// [`export`] for an explicit page list and ayah windows (tests use a small synthetic core.db).
fn export_with(
    ctx: &FixtureCtx,
    manifest: &mut Manifest,
    pages: &[u32],
    windows: &[(u32, u32)],
) -> anyhow::Result<()> {
    let core = open(&ctx.db)?;
    for dir in ["pages", "ayahs"] {
        let path = ctx.out.join(dir);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("remove {}", path.display())),
        }
    }

    let index = core.index().context("build QuranIndex")?;
    ctx.write_json("index.json", &index)?;

    let mut page_files = 0usize;
    for style in MushafStyle::ALL {
        let name = style_name(style)?;
        for chunk in pages.chunks(MAX_PAGES_PER_CALL) {
            let data = core
                .pages(style, chunk)
                .with_context(|| format!("pages {chunk:?} in style {name}"))?;
            for page in &data {
                ctx.write_json(&format!("pages/{name}/p{:03}.json", page.page), page)?;
                page_files += 1;
            }
        }
    }

    let mut ayah_rows = 0usize;
    for &(from, to) in windows {
        let rows = core
            .ayahs(MushafLayout::V2, from, to)
            .with_context(|| format!("ayahs {from}..={to}"))?;
        anyhow::ensure!(
            rows.len() == usize::try_from(to - from + 1)?,
            "ayahs {from}..={to}: core.db returned {} rows",
            rows.len()
        );
        ayah_rows += rows.len();
        ctx.write_json(&format!("ayahs/{from}-{to}.json"), &rows)?;
    }

    manifest.source.clone_from(&core.meta().source);
    manifest.pages = pages.to_vec();
    manifest.ayah_windows = windows.iter().map(|&(from, to)| [from, to]).collect();
    eprintln!(
        "mushaf: index.json ({} surahs, {} layouts), {page_files} page files ({} pages × {} styles), \
         {} ayah windows ({ayah_rows} rows) from core.db source {:?}",
        index.surahs.len(),
        index.layouts.len(),
        pages.len(),
        MushafStyle::ALL.len(),
        windows.len(),
        core.meta().source
    );
    Ok(())
}

fn open(db: &Path) -> anyhow::Result<CoreDb> {
    CoreDb::open(db).with_context(|| {
        format!(
            "open {} (build it first: `pnpm core:qdc`, i.e. `cargo xtask build-core --source qdc`)",
            db.display()
        )
    })
}

/// The style as the IPC contract spells it (`hafs`, `qcf_v2`, …): the mock's `pages/${style}/…` key.
fn style_name(style: MushafStyle) -> anyhow::Result<String> {
    match serde_json::to_value(style)? {
        serde_json::Value::String(name) => Ok(name),
        other => anyhow::bail!("style {style:?} serialised as {other}"),
    }
}

/// The synthetic core.db builder shared with quran-core's tests (owner WP1a).
#[cfg(test)]
#[path = "../../../crates/quran-core/tests/support/mini_core.rs"]
mod mini_core;

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use quran_types::{AyahText, PageData, QuranIndex};

    use super::*;

    fn read<T: serde::de::DeserializeOwned>(path: &Path) -> T {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn style_names_follow_the_contract() {
        let names: Vec<String> = MushafStyle::ALL
            .into_iter()
            .map(|s| style_name(s).unwrap())
            .collect();
        assert_eq!(names, ["hafs", "qcf_v2", "qcf_v1", "qcf_v4"]);
    }

    #[test]
    fn exports_index_pages_and_ayahs_from_a_core_db() {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let out = dir.path().join("fixtures");
        let ctx = FixtureCtx {
            out: out.clone(),
            db: mini.path.clone(),
            content_db: None,
            packs: None,
        };
        // A stale file from an earlier export with another page list must disappear.
        std::fs::create_dir_all(out.join("pages/hafs")).unwrap();
        std::fs::write(out.join("pages/hafs/p999.json"), "{}").unwrap();

        let mut manifest = Manifest {
            packs: vec!["tr.en.saheeh".into()],
            ..Manifest::default()
        };
        export_with(&ctx, &mut manifest, &[1, 2, 3, 4], &[(1, 7), (8, 12)]).unwrap();

        assert_eq!(manifest.source, "mini");
        assert_eq!(manifest.pages, vec![1, 2, 3, 4]);
        assert_eq!(manifest.ayah_windows, vec![[1, 7], [8, 12]]);
        assert_eq!(
            manifest.packs,
            vec!["tr.en.saheeh".to_owned()],
            "other domains are kept"
        );

        let core = CoreDb::open(&mini.path).unwrap();
        let index: QuranIndex = read(&out.join("index.json"));
        assert_eq!(index, core.index().unwrap());
        for style in MushafStyle::ALL {
            let name = style_name(style).unwrap();
            for n in 1..=4 {
                let page: PageData = read(&out.join(format!("pages/{name}/p{n:03}.json")));
                assert_eq!(page, core.pages(style, &[n]).unwrap()[0]);
            }
        }
        assert!(!out.join("pages/hafs/p999.json").exists());
        let rows: Vec<AyahText> = read(&out.join("ayahs/8-12.json"));
        assert_eq!(rows, core.ayahs(MushafLayout::V2, 8, 12).unwrap());
        let text = std::fs::read_to_string(out.join("pages/qcf_v4/p001.json")).unwrap();
        assert!(
            text.contains("\"headSurah\":1") && text.ends_with('\n'),
            "camelCase DTO JSON"
        );
    }

    #[test]
    fn a_placeholder_core_db_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("core.db");
        std::fs::write(&db, b"").unwrap();
        let ctx = FixtureCtx {
            out: dir.path().join("fixtures"),
            db,
            content_db: None,
            packs: None,
        };
        let err = export(&ctx, &mut Manifest::default()).unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("pnpm core:qdc") && text.contains("schema mismatch"),
            "{text}"
        );
        assert!(!ctx.out.exists(), "nothing is written");
    }

    #[test]
    fn the_spec_windows_fit_one_call() {
        for &(from, to) in AYAH_WINDOWS {
            assert!(
                to - from < quran_core::core_db::MAX_AYAHS_PER_CALL,
                "{from}..={to}"
            );
        }
    }
}
