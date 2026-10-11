//! `export-fixtures --only packs` (docs/ARCHITECTURE.md §4.6). Owner: WP5a.
//!
//! Writes, through `quran_packs::Catalog` (the same API the pack manager builds its list from):
//! - `packs/list.json`: `Vec<PackInfo>`, every catalog pack `NotInstalled`, in catalog order (the browser mock's
//!   catalogue, `src/lib/ipc/mock/fixtures.ts`);
//! - `packs/reciters.json`: `Vec<ReciterInfo>` from the catalog (names, styles, the probed `wordLevel`), nothing
//!   downloaded — what `audio_list_reciters` returns on a fresh install.
//!
//! The catalog is validated first (`Catalog::validate_release`), so a broken catalog never reaches the mock. Nothing
//! here comes from a QF API, so these two files carry no caching constraints. `manifest.json` is left alone: its `packs`
//! field lists the content domain's translation/tafsir/WBW fixtures (WP1c).

use anyhow::Context;
use quran_packs::Catalog;

use super::{FixtureCtx, Manifest};
use crate::cli::{DEFAULT_CATALOG, or_root};

pub fn export(ctx: &FixtureCtx, manifest: &mut Manifest) -> anyhow::Result<()> {
    let _ = manifest;
    let path = or_root(None, DEFAULT_CATALOG);
    let catalog = Catalog::load(&path).with_context(|| format!("load {}", path.display()))?;
    catalog.validate_release().with_context(|| {
        format!(
            "{} is invalid (run `cargo xtask catalog-check`)",
            path.display()
        )
    })?;
    write(ctx, &catalog)
}

fn write(ctx: &FixtureCtx, catalog: &Catalog) -> anyhow::Result<()> {
    let list = catalog.infos();
    let reciters = catalog.reciters();
    ctx.write_json("packs/list.json", &list)?;
    ctx.write_json("packs/reciters.json", &reciters)?;
    eprintln!(
        "packs: {} packs and {} reciters → {}",
        list.len(),
        reciters.len(),
        ctx.out.join("packs").display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use quran_types::{PackInfo, PackState, ReciterInfo};

    use super::*;

    #[test]
    fn exports_the_catalog_as_ipc_dtos() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = FixtureCtx {
            out: dir.path().join("fixtures"),
            db: dir.path().join("core.db"),
            content_db: None,
            packs: None,
        };
        let mut manifest = Manifest::default();
        export(&ctx, &mut manifest).unwrap();
        assert_eq!(
            manifest,
            Manifest::default(),
            "the manifest's packs field belongs to the content domain"
        );

        let catalog = Catalog::load(&or_root(None, DEFAULT_CATALOG)).unwrap();
        let text = std::fs::read_to_string(ctx.out.join("packs/list.json")).unwrap();
        assert!(text.ends_with('\n'));
        let list: Vec<PackInfo> = serde_json::from_str(&text).unwrap();
        assert_eq!(list, catalog.infos());
        assert!(list.iter().all(|p| p.state == PackState::NotInstalled));
        let raw: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            raw[0]["sizeKib"],
            u64::from(list[0].size_kib),
            "camelCase IPC names"
        );

        let reciters: Vec<ReciterInfo> = serde_json::from_str(
            &std::fs::read_to_string(ctx.out.join("packs/reciters.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(reciters, catalog.reciters());
        assert_eq!(reciters.len(), 14);
    }
}
