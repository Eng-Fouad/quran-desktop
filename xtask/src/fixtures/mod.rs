//! `cargo xtask export-fixtures`: the browser-mock fixtures.
//!
//! Every file is the serde_json serialisation of the same quran-types DTO the real command returns, so the shapes
//! cannot drift. Each domain is exported by its owner's module through the owner's own Rust API: [`mushaf`],
//! [`search`], [`content`], [`packs`]. This dispatcher owns `manifest.json`: it keeps the parts of domains that were
//! not re-exported (`--only`), and stamps `builtAt`.
//!
//! Output is gitignored local development data (QF terms): never committed or uploaded.

pub mod content;
pub mod mushaf;
pub mod packs;
pub mod search;

use std::path::{Path, PathBuf};

use anyhow::Context;
use quran_types::SearchRequest;
use serde::{Deserialize, Serialize};

use crate::cli::{ExportFixturesArgs, FixtureDomain};

/// Pages exported in all four styles: opening pages, consecutive spreads, the surah-9 header, sajda pages,
/// centred-line pages, the V1/V2 divergent pages, multi-glyph waqf words and the last pages. Also the page list of
/// `fetch-dev-packs`.
#[allow(dead_code)] // read by the domain exporters and dev_packs
pub const PAGES: &[u32] = &[
    1, 2, 3, 4, 5, 42, 43, 50, 51, 76, 77, 106, 107, 121, 122, 123, 145, 176, 177, 187, 206, 207,
    255, 256, 261, 262, 263, 293, 342, 343, 377, 415, 454, 455, 528, 529, 534, 545, 586, 587, 593,
    594, 600, 601, 602, 603, 604,
];

/// Ayah-id windows exported as `ayahs/{from}-{to}.json` (layout v2): 1:1–7, 2:1–33, 2:248–255, al-Kahf start, Yā-Sīn,
/// al-Mulk, 112–114.
#[allow(dead_code)] // read by the domain exporters
pub const AYAH_WINDOWS: &[(u32, u32)] = &[
    (1, 7),
    (8, 40),
    (255, 262),
    (2101, 2140),
    (3706, 3790),
    (5242, 5271),
    (6222, 6236),
];

/// Surahs with synthetic timings (`1200 ms + 380 ms × non-end words` per ayah, words evenly split;
/// `audio_url = mock://{reciter}/{surah}`).
#[allow(dead_code)] // read by the content exporter
pub const TIMING_SURAHS: &[u32] = &[1, 2, 18, 36, 67, 112, 113, 114];

/// The fixed search fixtures (`search/results/{slug}.json`), smart mode. A trailing token is a prefix in smart mode,
/// so `الرح` searches as `الرح*`.
#[allow(dead_code)] // read by the search exporter
pub const SEARCH_QUERIES: &[FixtureQuery] = &[
    FixtureQuery {
        slug: "rahman",
        query: "الرحمن",
        translation: false,
    },
    FixtureQuery {
        slug: "alamin",
        query: "العالمين",
        translation: false,
    },
    FixtureQuery {
        slug: "salah",
        query: "الصلاه",
        translation: false,
    },
    FixtureQuery {
        slug: "rah-prefix",
        query: "الرح",
        translation: false,
    },
    FixtureQuery {
        slug: "ya-ayyuha",
        query: "يا ايها",
        translation: false,
    },
    FixtureQuery {
        slug: "tr-mercy",
        query: "mercy",
        translation: true,
    },
    FixtureQuery {
        slug: "tr-light",
        query: "light",
        translation: true,
    },
];

/// One fixed search fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureQuery {
    /// File name under `search/results/`.
    pub slug: &'static str,
    pub query: &'static str,
    /// Translation scope (against a real or synthetic `tr.en.*` pack) instead of the Quran.
    pub translation: bool,
}

/// What every domain exporter gets.
#[derive(Debug, Clone)]
pub struct FixtureCtx {
    /// Output directory (`src/lib/ipc/mock/fixtures` by default).
    pub out: PathBuf,
    /// The core.db to export from.
    pub db: PathBuf,
    /// A development content.db with real timings/WBW, else synthetic content.
    pub content_db: Option<PathBuf>,
    /// A packs directory with real pack DBs, else synthetic packs.
    pub packs: Option<PathBuf>,
}

impl FixtureCtx {
    /// Writes `value` as compact JSON to `out/<rel>` (creating directories), with a trailing newline.
    pub fn write_json<T: Serialize + ?Sized>(&self, rel: &str, value: &T) -> anyhow::Result<()> {
        let path = self.out.join(rel);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        let mut bytes = serde_json::to_vec(value).with_context(|| format!("serialise {rel}"))?;
        bytes.push(b'\n');
        std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
    }
}

/// `manifest.json`: what the fixture set contains. Each domain exporter fills its own fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// RFC 3339 UTC (`SOURCE_DATE_EPOCH` when set).
    pub built_at: String,
    /// core.db `meta.source` (`qdc`/`qul`) or `synthetic` (mushaf).
    pub source: String,
    /// Pages exported in every style (mushaf).
    pub pages: Vec<u32>,
    /// `[from, to]` ayah-id windows under `ayahs/` (mushaf).
    pub ayah_windows: Vec<[u32; 2]>,
    /// Pack ids with translation/tafsir/WBW fixtures (content).
    pub packs: Vec<String>,
    /// `timings/{reciterId}/{surah}.json` files (content).
    pub timings: Vec<TimingRef>,
    /// `search/results/{slug}.json` files and the request each answers (search).
    pub queries: Vec<QueryRef>,
}

/// One exported timings file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingRef {
    pub reciter_id: u32,
    pub surah: u32,
}

/// One exported search result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRef {
    pub slug: String,
    pub request: SearchRequest,
}

/// Runs the requested domain exporters in order and rewrites `manifest.json`.
pub fn run(args: &ExportFixturesArgs) -> anyhow::Result<()> {
    let ctx = FixtureCtx {
        out: args.out(),
        db: args.db(),
        content_db: args.content_db.clone(),
        packs: args.packs.clone(),
    };
    let manifest_path = ctx.out.join("manifest.json");
    let mut manifest = read_manifest(&manifest_path)?;
    for domain in args.domains() {
        match domain {
            FixtureDomain::Mushaf => mushaf::export(&ctx, &mut manifest),
            FixtureDomain::Search => search::export(&ctx, &mut manifest),
            FixtureDomain::Content => content::export(&ctx, &mut manifest),
            FixtureDomain::Packs => packs::export(&ctx, &mut manifest),
        }
        .with_context(|| format!("export-fixtures --only {domain:?}"))?;
    }
    manifest.built_at = built_at()?;
    ctx.write_json("manifest.json", &manifest)?;
    eprintln!("fixtures written to {}", ctx.out.display());
    Ok(())
}

/// The existing manifest (so `--only` keeps the other domains' parts), or an empty one.
fn read_manifest(path: &Path) -> anyhow::Result<Manifest> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// RFC 3339 UTC from `SOURCE_DATE_EPOCH` (reproducible builds) or the clock.
fn built_at() -> anyhow::Result<String> {
    let at = match std::env::var("SOURCE_DATE_EPOCH") {
        Ok(secs) => {
            let secs: i64 = secs
                .trim()
                .parse()
                .context("SOURCE_DATE_EPOCH is not an integer")?;
            time::OffsetDateTime::from_unix_timestamp(secs)
                .context("SOURCE_DATE_EPOCH is out of range")?
        }
        Err(_) => time::OffsetDateTime::now_utc(),
    };
    at.format(&time::format_description::well_known::Rfc3339)
        .context("format builtAt")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_fixture_lists_are_intact() {
        assert_eq!(PAGES.len(), 47, "3 × 47 dev-pack fonts");
        assert!(PAGES.windows(2).all(|w| w[0] < w[1]));
        assert!(
            AYAH_WINDOWS
                .iter()
                .all(|&(a, b)| 1 <= a && a <= b && b <= 6236)
        );
        assert_eq!(SEARCH_QUERIES.iter().filter(|q| q.translation).count(), 2);
    }

    #[test]
    fn manifests_round_trip_and_merge() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = FixtureCtx {
            out: dir.path().join("fixtures"),
            db: dir.path().join("core.db"),
            content_db: None,
            packs: None,
        };
        let path = ctx.out.join("manifest.json");
        assert_eq!(read_manifest(&path).unwrap(), Manifest::default());
        let manifest = Manifest {
            built_at: "2026-10-10T00:00:00Z".into(),
            source: "qdc".into(),
            pages: PAGES.to_vec(),
            ayah_windows: vec![[1, 7]],
            packs: vec!["tr.en.saheeh".into()],
            timings: vec![TimingRef {
                reciter_id: 7,
                surah: 1,
            }],
            queries: Vec::new(),
        };
        ctx.write_json("manifest.json", &manifest).unwrap();
        assert_eq!(read_manifest(&path).unwrap(), manifest);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"ayahWindows\":[[1,7]]") && text.contains("\"reciterId\":7"));
    }

    #[test]
    fn built_at_honours_source_date_epoch_format() {
        let stamp = built_at().unwrap();
        assert!(stamp.ends_with('Z') && stamp.contains('T'), "{stamp}");
    }
}
