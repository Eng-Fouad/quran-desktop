//! `cargo xtask fetch-dev-packs [--out data/dev-packs] [--force] [--all-pages]` (docs/ARCHITECTURE.md §4.8).
//! Owner: WP3c. **Local development only.**
//!
//! Downloads, through the URL templates and mirrors of `src-tauri/resources/catalog.json` (`quran_packs::catalog`,
//! WP5a), the QCF V1, V2 and V4 page fonts of the fixture pages (`crate::fixtures::PAGES`, 3 × 47 files, or all 604
//! pages per variant with `--all-pages` for the glyph-scale measurement) and the three `decor` files, into the app's
//! `packs/` layout:
//! ```text
//! data/dev-packs/
//! ├─ mushaf/{v1,v2,v4}/p{N}.woff2
//! └─ decor/{qcf-surah-header.woff2, quran-common.ttf, sura-names.woff2}
//! ```
//! The Vite dev-packs plugin (WP8b) serves the directory at `/__packs/*` in `--mode mock`, so QCF rendering, the D13
//! cross-fade, palettes, the COLR probe and decor headers work in a plain browser before the pack manager exists.
//!
//! Every file is checked before it is written (and an existing file before it is kept): the font signature (`wOF2`,
//! TrueType/OpenType), the WOFF2 header's own total length (which detects truncation for page fonts, whose sizes the
//! catalog does not list), and the catalog's exact size and sha256 for decor. Mirrors are tried in catalog order, each
//! with bounded retries. Files that already pass are not downloaded again unless `--force` is given.
//!
//! `data/dev-packs/` is gitignored and MUST never be committed or uploaded: the QF terms let the app cache these
//! fonts for its user, not redistribute them.

use std::path::Path;

use anyhow::{Context, bail, ensure};
use futures_util::{StreamExt, stream};
use quran_packs::Catalog;
use quran_packs::adapters::{Adapter, FontVariant};
use quran_packs::catalog::{DECOR_FILES, DECOR_PACK_ID};
use quran_types::{MushafStyle, PAGE_COUNT};

use crate::assets::{byte_len, group, net, rel_path, sha256_hex, write_atomic};
use crate::cli::{DEFAULT_CATALOG, FetchDevPacksArgs, or_root};

/// Downloads in flight at once.
pub const PARALLEL: usize = 8;

/// Upper bound for one file (QCF pages are 20–400 KB, decor up to 160 KB).
const MAX_FILE_BYTES: u64 = 16 << 20;

/// The QCF styles whose page fonts are fetched, in output order.
const STYLES: [MushafStyle; 3] = [MushafStyle::QcfV1, MushafStyle::QcfV2, MushafStyle::QcfV4];

pub fn run(args: &FetchDevPacksArgs) -> anyhow::Result<()> {
    let catalog_path = or_root(None, DEFAULT_CATALOG);
    let catalog =
        Catalog::load(&catalog_path).with_context(|| format!("load {}", catalog_path.display()))?;
    let pages: Vec<u32> = if args.all_pages {
        (1..=PAGE_COUNT).collect()
    } else {
        crate::fixtures::PAGES.to_vec()
    };
    let files = plan(&catalog, &pages)?;
    let out = args.out();
    println!(
        "fetch-dev-packs: {} files ({} pages × {} QCF variants + {} decor) → {}",
        files.len(),
        pages.len(),
        STYLES.len(),
        files.iter().filter(|f| f.group == Group::Decor).count(),
        out.display()
    );
    println!("  local development only: never commit or upload this directory (QF terms)");

    let runtime = net::runtime()?;
    let client = net::client("fetch-dev-packs")?;
    let outcomes = runtime.block_on(fetch_all(
        &client,
        net::Retry::DEFAULT,
        &files,
        &out,
        args.force,
        PARALLEL,
        |done, total| {
            if total >= 200 && (done.is_multiple_of(200) || done == total) {
                println!("  … {done}/{total}");
            }
        },
    ));

    let report = Report::new(&files, &outcomes);
    for line in report.lines() {
        println!("  {line}");
    }
    if !report.failures.is_empty() {
        bail!(
            "fetch-dev-packs: {} of {} files failed (the others are in place; run again to retry)",
            report.failures.len(),
            files.len()
        );
    }
    Ok(())
}

/// Which part of the dev-packs tree a file belongs to (for the summary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Group {
    Mushaf(FontVariant),
    Decor,
}

impl Group {
    #[must_use]
    pub fn label(self) -> String {
        match self {
            Self::Mushaf(variant) => format!("mushaf/{}", variant.dir()),
            Self::Decor => "decor".to_owned(),
        }
    }
}

/// One file to fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevFile {
    pub group: Group,
    /// Path under the output directory, `/`-separated: `mushaf/v2/p262.woff2`, `decor/quran-common.ttf`.
    pub rel: String,
    /// Mirrors, tried in order.
    pub urls: Vec<String>,
    /// Exact size, when the catalog pins it.
    pub bytes: Option<u64>,
    /// Lowercase hex sha256, when the catalog pins it.
    pub sha256: Option<String>,
}

/// The files for `pages` (each 1..=604) in every QCF variant, then the `decor` pack's files, from the catalog's URL
/// templates and mirrors.
pub fn plan(catalog: &Catalog, pages: &[u32]) -> anyhow::Result<Vec<DevFile>> {
    ensure!(!pages.is_empty(), "no pages to fetch");
    if let Some(page) = pages.iter().find(|p| !(1..=PAGE_COUNT).contains(*p)) {
        bail!("page {page} is outside 1..={PAGE_COUNT}");
    }
    let mut files = Vec::with_capacity(pages.len() * STYLES.len() + DECOR_FILES.len());
    for style in STYLES {
        let pack = catalog
            .mushaf_pack(style)
            .with_context(|| format!("the catalog has no page-font pack for {style:?}"))?;
        let Adapter::QcfFontPages(config) = &pack.source else {
            bail!("{}: not a qcf_font_pages pack", pack.id);
        };
        ensure!(
            !config.url_templates.is_empty(),
            "{}: no URL templates",
            pack.id
        );
        for template in &config.url_templates {
            ensure!(
                template.starts_with("https://") && template.matches("{page}").count() == 1,
                "{}: URL template {template:?} must be https with exactly one {{page}}",
                pack.id
            );
        }
        for page in pages {
            files.push(DevFile {
                group: Group::Mushaf(config.variant),
                rel: format!("mushaf/{}/p{page}.woff2", config.variant.dir()),
                urls: config
                    .url_templates
                    .iter()
                    .map(|t| t.replace("{page}", &page.to_string()))
                    .collect(),
                bytes: None,
                sha256: None,
            });
        }
    }

    let decor = catalog
        .require(DECOR_PACK_ID)
        .context("the catalog has no decor pack")?;
    let Adapter::StaticFiles(config) = &decor.source else {
        bail!("{DECOR_PACK_ID}: not a static_files pack");
    };
    for file in &config.files {
        // Only the fixed §6.2 decor routes: a catalog path can never escape the output directory.
        ensure!(
            DECOR_FILES.contains(&file.path.as_str()),
            "{DECOR_PACK_ID}: {:?} is not a decor route (§6.2)",
            file.path
        );
        ensure!(
            !file.urls.is_empty(),
            "{DECOR_PACK_ID}: {} has no URL",
            file.path
        );
        files.push(DevFile {
            group: Group::Decor,
            rel: format!("decor/{}", file.path),
            urls: file.urls.clone(),
            bytes: Some(file.bytes),
            sha256: file.sha256.as_ref().map(|s| s.to_ascii_lowercase()),
        });
    }
    Ok(files)
}

/// Why `bytes` cannot be `file` (signature, WOFF2 header length, pinned size and sha256); `None` when it can.
#[must_use]
pub fn check(file: &DevFile, bytes: &[u8]) -> Option<String> {
    let len = byte_len(bytes);
    if bytes.is_empty() {
        return Some("empty file".to_owned());
    }
    let extension = file.rel.rsplit('.').next().unwrap_or_default();
    match extension {
        "woff2" => {
            if !bytes.starts_with(b"wOF2") {
                return Some("not a WOFF2 font (no wOF2 signature)".to_owned());
            }
            // WOFF2 header: signature, flavor, then the total file length (u32 BE).
            let declared = bytes
                .get(8..12)
                .and_then(|b| <[u8; 4]>::try_from(b).ok())
                .map(u32::from_be_bytes);
            if declared.map(u64::from) != Some(len) {
                return Some(format!(
                    "truncated or padded WOFF2: header says {declared:?} B, the file is {len} B"
                ));
            }
        }
        "ttf" | "otf" => {
            let signature = bytes.get(..4);
            if !matches!(
                signature,
                Some([0, 1, 0, 0] | [b't', b'r', b'u', b'e'] | [b'O', b'T', b'T', b'O'])
            ) {
                return Some("not a TrueType/OpenType font".to_owned());
            }
        }
        other => return Some(format!("unexpected file type {other:?}")),
    }
    if let Some(expected) = file.bytes
        && expected != len
    {
        return Some(format!("{len} B, the catalog says {expected} B"));
    }
    if let Some(expected) = &file.sha256 {
        let actual = sha256_hex(bytes);
        if &actual != expected {
            return Some(format!("sha256 {actual}, the catalog pins {expected}"));
        }
    }
    None
}

/// What happened to one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Already on disk and valid: not downloaded.
    Present { bytes: u64 },
    /// Downloaded from `urls[mirror]` and written.
    Downloaded { bytes: u64, mirror: usize },
    /// Every mirror failed; one line per mirror.
    Failed { errors: Vec<String> },
}

/// Fetches every file (at most `parallel` at once) into `out`; one [`Outcome`] per file, in `files` order.
/// `progress(done, total)` is called after each file. Never fails as a whole: failures are per file.
pub async fn fetch_all(
    client: &reqwest::Client,
    retry: net::Retry,
    files: &[DevFile],
    out: &Path,
    force: bool,
    parallel: usize,
    mut progress: impl FnMut(usize, usize),
) -> Vec<Outcome> {
    let total = files.len();
    let mut results: Vec<(usize, Outcome)> = Vec::with_capacity(total);
    let mut pending =
        stream::iter(files.iter().enumerate())
            .map(|(index, file)| async move {
                (index, fetch_one(client, retry, file, out, force).await)
            })
            .buffer_unordered(parallel.max(1));
    while let Some(result) = pending.next().await {
        results.push(result);
        progress(results.len(), total);
    }
    results.sort_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, outcome)| outcome).collect()
}

async fn fetch_one(
    client: &reqwest::Client,
    retry: net::Retry,
    file: &DevFile,
    out: &Path,
    force: bool,
) -> Outcome {
    let path = rel_path(out, &file.rel);
    if !force
        && let Ok(bytes) = tokio::fs::read(&path).await
        && check(file, &bytes).is_none()
    {
        return Outcome::Present {
            bytes: byte_len(&bytes),
        };
    }
    let mut errors = Vec::new();
    for (mirror, url) in file.urls.iter().enumerate() {
        match net::get(client, url, MAX_FILE_BYTES, retry).await {
            Ok(bytes) => {
                if let Some(problem) = check(file, &bytes) {
                    errors.push(format!("{url}: {problem}"));
                    continue;
                }
                return match write_atomic(&path, &bytes) {
                    Ok(()) => Outcome::Downloaded {
                        bytes: byte_len(&bytes),
                        mirror,
                    },
                    Err(e) => Outcome::Failed {
                        errors: vec![format!("{e:#}")],
                    },
                };
            }
            Err(e) => errors.push(format!("{e:#}")),
        }
    }
    Outcome::Failed { errors }
}

/// The per-group summary of a run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    /// One entry per group, in the order the groups first appear in the plan.
    pub groups: Vec<GroupReport>,
    /// `(rel, errors)` of every failed file.
    pub failures: Vec<(String, Vec<String>)>,
}

/// One line of the summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupReport {
    pub group: Group,
    pub files: usize,
    pub downloaded: usize,
    pub present: usize,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    /// Downloads that came from a mirror other than the first.
    pub fallbacks: usize,
}

impl Report {
    #[must_use]
    pub fn new(files: &[DevFile], outcomes: &[Outcome]) -> Self {
        let mut report = Self::default();
        for (file, outcome) in files.iter().zip(outcomes) {
            let index = match report.groups.iter().position(|g| g.group == file.group) {
                Some(index) => index,
                None => {
                    report.groups.push(GroupReport {
                        group: file.group,
                        files: 0,
                        downloaded: 0,
                        present: 0,
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        fallbacks: 0,
                    });
                    report.groups.len() - 1
                }
            };
            let Some(group) = report.groups.get_mut(index) else {
                continue;
            };
            group.files += 1;
            match outcome {
                Outcome::Present { bytes } => {
                    group.present += 1;
                    group.total_bytes += bytes;
                }
                Outcome::Downloaded { bytes, mirror } => {
                    group.downloaded += 1;
                    group.downloaded_bytes += bytes;
                    group.total_bytes += bytes;
                    if *mirror > 0 {
                        group.fallbacks += 1;
                    }
                }
                Outcome::Failed { errors } => {
                    report.failures.push((file.rel.clone(), errors.clone()));
                }
            }
        }
        report
    }

    /// Human-readable summary lines (`ok`/`FAIL` prefixed).
    #[must_use]
    pub fn lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for g in &self.groups {
            let failed = g.files - g.downloaded - g.present;
            lines.push(format!(
                "{} {:<10} {:>4} files, {:>11} B: {} downloaded ({} B{}), {} already present{}",
                if failed == 0 { "ok  " } else { "FAIL" },
                g.group.label(),
                g.files,
                group(g.total_bytes),
                g.downloaded,
                group(g.downloaded_bytes),
                if g.fallbacks > 0 {
                    format!(", {} from a fallback mirror", g.fallbacks)
                } else {
                    String::new()
                },
                g.present,
                if failed > 0 {
                    format!(", {failed} failed")
                } else {
                    String::new()
                }
            ));
        }
        for (rel, errors) in &self.failures {
            lines.push(format!("FAIL {rel}"));
            for error in errors {
                lines.push(format!("       {error}"));
            }
        }
        lines
    }
}
