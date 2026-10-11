//! Every `cargo xtask` subcommand of docs/ARCHITECTURE.md §4.1, as clap derive types. Frozen after wave 0 (§14.2).
//!
//! Default paths are anchored at the workspace root, so `pnpm core:qdc` and friends behave the same from any
//! directory; paths given on the command line are taken as given (relative to the current directory).

use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand, ValueEnum};

/// `cargo xtask <command>` (alias in `.cargo/config.toml`).
#[derive(Debug, Parser)]
#[command(
    name = "xtask",
    version,
    about = "Quran for Desktop developer tasks: core.db pipeline, gates, fixtures, assets, licences, catalog (ARCHITECTURE.md §4)"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Build core.db from a source (qdc: development only; qul: release), then run every verify-core gate. Writes
    /// `<out>.tmp` and renames it on success; deterministic under SOURCE_DATE_EPOCH.
    BuildCore(BuildCoreArgs),
    /// Run the verify-core gates G1–G16 on a core.db (§4.5).
    VerifyCore(VerifyCoreArgs),
    /// Export browser-mock fixtures (the same quran-types DTOs the real commands return; gitignored, never committed).
    ExportFixtures(ExportFixturesArgs),
    /// Fetch the KFGQPC Hafs V30 font into public/fonts/ (size-checked, sha-locked in xtask/assets.lock).
    FetchAssets(FetchAssetsArgs),
    /// Fetch QCF v1/v2/v4 page fonts for the fixture pages, plus decor, into data/dev-packs/ (local development only).
    FetchDevPacks(FetchDevPacksArgs),
    /// Regenerate src/lib/about/thirdparty.json from `cargo metadata` and `pnpm licenses`.
    Licenses,
    /// Validate src-tauri/resources/catalog.json (strict schema, id rules, requires/kind consistency).
    CatalogCheck(CatalogCheckArgs),
    /// Regenerate src/lib/ipc/bindings.ts (= `cargo test -p quran-desktop --lib export_bindings`).
    Bindings,
}

/// Where core.db's text, layout and glyph data come from (§4.2, §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, ValueEnum)]
pub enum Source {
    /// The QDC API, development only (QF terms forbid distributing it, BRIEF §4).
    Qdc,
    /// QUL files placed under data/sources/qul/ by a human (release-grade).
    Qul,
}

impl Source {
    /// `meta.source`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Qdc => "qdc",
            Self::Qul => "qul",
        }
    }
}

#[derive(Debug, Args)]
pub struct BuildCoreArgs {
    #[arg(long, value_enum)]
    pub source: Source,
    /// Output file [default: src-tauri/resources/core.db].
    #[arg(long, value_name = "PATH")]
    pub out: Option<PathBuf>,
    /// Raw-response cache [default: data/cache]; files older than 7 days are refetched (QF terms).
    #[arg(long, value_name = "DIR")]
    pub cache: Option<PathBuf>,
    /// Use the cache only; fail on a miss instead of fetching.
    #[arg(long)]
    pub offline: bool,
    /// Concurrent requests.
    #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u32).range(1..=16))]
    pub jobs: u32,
}

impl BuildCoreArgs {
    #[must_use]
    pub fn out(&self) -> PathBuf {
        or_root(self.out.as_deref(), DEFAULT_CORE_DB)
    }

    #[must_use]
    pub fn cache(&self) -> PathBuf {
        or_root(self.cache.as_deref(), "data/cache")
    }
}

#[derive(Debug, Args)]
pub struct VerifyCoreArgs {
    /// core.db to check [default: src-tauri/resources/core.db].
    #[arg(long, value_name = "PATH")]
    pub db: Option<PathBuf>,
    /// Also write the gate results as JSON (e.g. target/verify-core.json).
    #[arg(long, value_name = "PATH")]
    pub report: Option<PathBuf>,
}

impl VerifyCoreArgs {
    #[must_use]
    pub fn db(&self) -> PathBuf {
        or_root(self.db.as_deref(), DEFAULT_CORE_DB)
    }
}

/// A part of the fixture set, exported by its owner's module (§4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, ValueEnum)]
pub enum FixtureDomain {
    /// index.json, pages/, ayahs/ (WP1a).
    Mushaf,
    /// search/ (WP1b).
    Search,
    /// translations/, tafsir/, timings/, wbw/ (WP1c).
    Content,
    /// packs/list.json (WP5a).
    Packs,
}

impl FixtureDomain {
    /// Export order.
    pub const ALL: [Self; 4] = [Self::Mushaf, Self::Search, Self::Content, Self::Packs];
}

#[derive(Debug, Args)]
pub struct ExportFixturesArgs {
    /// Comma-separated subset [default: all].
    #[arg(long, value_enum, value_delimiter = ',', value_name = "DOMAINS")]
    pub only: Vec<FixtureDomain>,
    /// core.db to export from [default: src-tauri/resources/core.db].
    #[arg(long, value_name = "PATH")]
    pub db: Option<PathBuf>,
    /// A development content.db with real timings/WBW (else synthetic content).
    #[arg(long, value_name = "PATH")]
    pub content_db: Option<PathBuf>,
    /// A packs directory with real translation/tafsir pack DBs (else synthetic packs).
    #[arg(long, value_name = "DIR")]
    pub packs: Option<PathBuf>,
    /// Output directory [default: src/lib/ipc/mock/fixtures].
    #[arg(long, value_name = "DIR")]
    pub out: Option<PathBuf>,
}

impl ExportFixturesArgs {
    #[must_use]
    pub fn db(&self) -> PathBuf {
        or_root(self.db.as_deref(), DEFAULT_CORE_DB)
    }

    #[must_use]
    pub fn out(&self) -> PathBuf {
        or_root(self.out.as_deref(), "src/lib/ipc/mock/fixtures")
    }

    /// The requested domains in export order, deduplicated; all of them when `--only` is absent.
    #[must_use]
    pub fn domains(&self) -> Vec<FixtureDomain> {
        if self.only.is_empty() {
            return FixtureDomain::ALL.to_vec();
        }
        let mut domains = self.only.clone();
        domains.sort();
        domains.dedup();
        domains
    }
}

#[derive(Debug, Args)]
pub struct FetchAssetsArgs {
    /// Re-download and accept a new sha256 (updates xtask/assets.lock).
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct FetchDevPacksArgs {
    /// Output directory, laid out like the app's packs/ [default: data/dev-packs].
    #[arg(long, value_name = "DIR")]
    pub out: Option<PathBuf>,
    /// Re-download files that already exist.
    #[arg(long)]
    pub force: bool,
    /// All 604 pages per variant instead of the fixture page list (glyph-scale measurement, §4.8).
    #[arg(long)]
    pub all_pages: bool,
}

impl FetchDevPacksArgs {
    #[must_use]
    pub fn out(&self) -> PathBuf {
        or_root(self.out.as_deref(), "data/dev-packs")
    }
}

#[derive(Debug, Args)]
pub struct CatalogCheckArgs {
    /// Also HEAD every URL, including every QuranEnc zip (and run the one-time `wordLevel` probe).
    #[arg(long)]
    pub online: bool,
}

/// `src-tauri/resources/core.db`, relative to the workspace root.
pub const DEFAULT_CORE_DB: &str = "src-tauri/resources/core.db";
/// `src-tauri/resources/catalog.json`, relative to the workspace root.
pub const DEFAULT_CATALOG: &str = "src-tauri/resources/catalog.json";

/// The repository root (the parent of `xtask/`).
#[must_use]
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// `given` as given, else `default` (a `/`-separated path) under the workspace root, with native separators.
#[must_use]
pub fn or_root(given: Option<&Path>, default: &str) -> PathBuf {
    given.map_or_else(
        || {
            default
                .split('/')
                .fold(workspace_root(), |path, part| path.join(part))
        },
        Path::to_path_buf,
    )
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;

    #[test]
    fn the_cli_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_every_documented_command_line() {
        for line in [
            "xtask build-core --source qdc",
            "xtask build-core --source qul --out x.db --cache c --offline --jobs 8",
            "xtask verify-core",
            "xtask verify-core --db x.db --report target/verify-core.json",
            "xtask export-fixtures",
            "xtask export-fixtures --only mushaf,search --db x.db --content-db c.db --packs p --out o",
            "xtask fetch-assets --force",
            "xtask fetch-dev-packs --out d --force --all-pages",
            "xtask licenses",
            "xtask catalog-check --online",
            "xtask bindings",
        ] {
            let parsed = Cli::try_parse_from(line.split(' '));
            assert!(parsed.is_ok(), "{line}: {parsed:?}");
        }
        assert!(
            Cli::try_parse_from(["xtask", "build-core"]).is_err(),
            "--source is required"
        );
        assert!(
            Cli::try_parse_from(["xtask", "build-core", "--source", "qdc", "--jobs", "0"]).is_err()
        );
        assert!(Cli::try_parse_from(["xtask", "export-fixtures", "--only", "pages"]).is_err());
    }

    #[test]
    fn defaults_are_anchored_at_the_workspace_root() {
        let Ok(Cli {
            command: Command::ExportFixtures(args),
        }) = Cli::try_parse_from(["xtask", "export-fixtures", "--only", "packs,mushaf,packs"])
        else {
            panic!("export-fixtures parses");
        };
        assert_eq!(
            args.domains(),
            [FixtureDomain::Mushaf, FixtureDomain::Packs]
        );
        assert_eq!(
            args.out(),
            workspace_root()
                .join("src")
                .join("lib")
                .join("ipc")
                .join("mock")
                .join("fixtures")
        );
        assert!(workspace_root().join("Cargo.toml").is_file());
        assert_eq!(
            or_root(Some(Path::new("rel/x.db")), DEFAULT_CORE_DB),
            Path::new("rel/x.db")
        );
    }
}
