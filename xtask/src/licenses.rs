//! `cargo xtask licenses`: the third-party notices of the shipped app → `src/lib/about/thirdparty.json`
//! (the About screen's "Open-source licences").
//!
//! Inputs:
//! - **Rust**: `cargo metadata --locked --filter-platform <target>` once per release target, merged (Windows
//!   x64 and arm64, macOS x64 and arm64, Linux x64 and arm64). The crates are the *normal* dependency closure of the app crate `quran-desktop`: build
//!   scripts' and dev-dependencies' crates are not shipped, and workspace crates are our own. Filtering by the release
//!   targets (not the host) keeps the output identical on every OS, which the CI drift check relies on.
//! - **npm**: `pnpm licenses list --json --prod` (the `dependencies` closure; devDependencies are build tools) plus each
//!   package's own `package.json` for its repository.
//!
//! Every package's declared licence is parsed as an SPDX expression (legacy `MIT/Apache-2.0` included) and must be
//! satisfiable with the [`policy::ALLOWED`] licences; anything else (GPL-only, unknown, missing) fails the command, so
//! a new dependency with an unshippable licence cannot slip in. For a choice (`MIT OR Apache-2.0`) the preferred
//! allowed alternative is used, and only the licence files that apply to it are kept (`LICENSE-MIT`, not
//! `LICENSE-APACHE`); generic files (`LICENSE`, `COPYRIGHT`, `NOTICE`, third-party notices) are always kept. Texts are
//! split into [`segments`] (copyright lines apart from the standard MIT/Apache/OFL bodies), stored once and referenced
//! by index, which halves the file.
//!
//! **Every package carries the text of each licence the app uses it under** (MIT, BSD, Apache-2.0, MPL-2.0, … require
//! it with binary copies), or the command fails. Texts are recognised by their content ([`policy::text_families`]), so
//! an SPDX metadata document (`LICENSE.spdx`) or a bare copyright line does not count, and a generic `LICENSE` backs the
//! alternative it actually contains (`brotli-decompressor`'s BSD text). A package that publishes no licence text gets
//! reviewed stand-ins from [`VENDORED`] (`xtask/licenses/<ecosystem>/<name>/`, pinned to the shipped versions); the
//! same directory adds notices for components a package bundles (the Microsoft WebView2 SDK that `webview2-com-sys`
//! links into the Windows exe). Stale entries fail too.
//!
//! Output (`ThirdParty`), deterministic: packages sorted by
//! ecosystem, name and version; texts in order of first use; no paths, dates or host details; one package or text per
//! line; written only when it changes.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::assets::{byte_len, group, rel_path, write_if_changed};
use crate::cli::workspace_root;

/// The output, relative to the repository root.
pub const OUTPUT: &str = "src/lib/about/thirdparty.json";

/// Reviewed stand-in licence texts and extra notices, relative to the repository root.
pub const VENDORED: &str = "xtask/licenses";

/// The shipped app crate whose dependency closure is listed.
pub const APP_CRATE: &str = "quran-desktop";

/// The release targets (release.yml's matrix): Windows x64 and arm64, a universal macOS app, Linux x64 and arm64.
pub const RELEASE_TARGETS: [&str; 6] = [
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
];

pub fn run() -> anyhow::Result<()> {
    let root = workspace_root();

    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    let manifest = root.join("Cargo.toml");
    let mut base: Vec<OsString> = [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--manifest-path",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    base.push(manifest.into_os_string());
    // One `cargo metadata` per target, the closures merged (`assemble` drops the duplicates): cargo 1.99 panics ("no
    // entry found for key") when one call filters for both Windows targets, x86_64- and aarch64-pc-windows-msvc.
    let mut candidates = Vec::new();
    for target in RELEASE_TARGETS {
        let mut args = base.clone();
        args.push("--filter-platform".into());
        args.push(target.into());
        let metadata: Metadata =
            serde_json::from_slice(&capture(std::slice::from_ref(&cargo), &args, &root)?)
                .with_context(|| format!("parse the `cargo metadata` output for {target}"))?;
        candidates.extend(cargo_packages(&metadata, APP_CRATE)?);
    }
    let crates = candidates
        .iter()
        .map(|c| (c.name.as_str(), c.version.as_str()))
        .collect::<BTreeSet<_>>()
        .len();

    let pnpm_args: Vec<OsString> = ["licenses", "list", "--json", "--prod"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let pnpm_json: Value = serde_json::from_slice(&capture(&pnpm_programs(), &pnpm_args, &root)?)
        .context("parse the `pnpm licenses list --json --prod` output")?;
    let npm = npm_packages(&pnpm_json)?;
    let npm_count = npm.len();
    candidates.extend(npm);

    let vendored = Vendored::load(&rel_path(&root, VENDORED), VENDORED)?;
    let notices = assemble(candidates, &vendored)?;
    let json = notices.render()?;
    let out = rel_path(&root, OUTPUT);
    let written = write_if_changed(&out, json.as_bytes())?;

    println!(
        "licenses: {crates} crates (normal dependencies of {APP_CRATE} on {}) + {npm_count} npm packages \
         (pnpm --prod) → {OUTPUT} ({}, {} B)",
        RELEASE_TARGETS.join(", "),
        if written { "updated" } else { "unchanged" },
        group(byte_len(json.as_bytes()))
    );
    let mut chosen: BTreeMap<&str, usize> = BTreeMap::new();
    for package in &notices.packages {
        *chosen.entry(package.used.as_str()).or_default() += 1;
    }
    let mut by_count: Vec<(&str, usize)> = chosen.into_iter().collect();
    by_count.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let top: Vec<String> = by_count
        .iter()
        .take(8)
        .map(|(licence, n)| format!("{licence} {n}"))
        .collect();
    println!(
        "  ok   policy: every licence is satisfiable with the allowed set ({})",
        top.join(", ")
    );
    let text_bytes: u64 = notices.texts.iter().map(|t| byte_len(t.as_bytes())).sum();
    println!(
        "  ok   {} distinct licence/notice text segments ({} B)",
        notices.texts.len(),
        group(text_bytes)
    );
    let stand_ins = vendored
        .entries()
        .filter(|e| !e.licences.is_empty())
        .count();
    println!(
        "  ok   every package carries the text of each licence it is used under ({stand_ins} that publish none use \
         the reviewed texts in {VENDORED}/)"
    );
    let noticed: Vec<String> = vendored
        .entries()
        .filter(|e| !e.notices.is_empty())
        .map(|e| {
            let names: Vec<&str> = e.notices.iter().map(|n| n.name.as_str()).collect();
            format!("{} ({})", e.package, names.join(", "))
        })
        .collect();
    if !noticed.is_empty() {
        println!("  ok   bundled-component notices: {}", noticed.join("; "));
    }
    Ok(())
}

/// Runs the first of `programs` that exists with `args` in `dir`; returns its stdout. Fails on a non-zero exit with
/// the tool's stderr.
fn capture(programs: &[OsString], args: &[OsString], dir: &Path) -> anyhow::Result<Vec<u8>> {
    let shown = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    for program in programs {
        let output = match Command::new(program)
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .output()
        {
            Ok(output) => output,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("run {} {shown}", program.to_string_lossy()));
            }
        };
        ensure!(
            output.status.success(),
            "`{} {shown}` failed ({}):\n{}",
            program.to_string_lossy(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return Ok(output.stdout);
    }
    bail!(
        "none of {} is on PATH (needed for `{shown}`)",
        programs
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// `pnpm` is a `.cmd` shim on Windows, which `Command` only finds by its full name.
fn pnpm_programs() -> Vec<OsString> {
    if cfg!(windows) {
        vec!["pnpm.exe".into(), "pnpm.cmd".into()]
    } else {
        vec!["pnpm".into()]
    }
}

// ---- inputs -----------------------------------------------------------------------------------------------------

/// The part of `cargo metadata --format-version 1` this task reads.
#[derive(Debug, Clone, Deserialize)]
pub struct Metadata {
    pub packages: Vec<MetaPackage>,
    pub resolve: Option<Resolve>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MetaPackage {
    pub name: String,
    pub version: String,
    pub id: String,
    pub license: Option<String>,
    pub license_file: Option<String>,
    /// `None` for workspace and path crates.
    pub source: Option<String>,
    pub manifest_path: PathBuf,
    #[serde(default)]
    pub authors: Vec<String>,
    pub repository: Option<String>,
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Resolve {
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Node {
    pub id: String,
    pub deps: Vec<NodeDep>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NodeDep {
    pub pkg: String,
    pub dep_kinds: Vec<DepKind>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DepKind {
    /// `None` = normal, `"dev"`, `"build"`.
    pub kind: Option<String>,
}

/// Which registry a package comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ecosystem {
    Cargo,
    Npm,
}

/// A third-party package before its licence is checked and its texts are read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    /// The declared SPDX expression.
    pub licence: Option<String>,
    /// Repository or homepage (normalised to http(s) later).
    pub url: Option<String>,
    pub authors: Vec<String>,
    /// The package's files, where its licence files are looked up.
    pub dir: Option<PathBuf>,
    /// A licence file the manifest names explicitly (Cargo `license-file`).
    pub licence_file: Option<PathBuf>,
}

/// The crates of `root`'s normal-dependency closure (as resolved by the metadata's platform filter), workspace and
/// path crates excluded.
pub fn cargo_packages(metadata: &Metadata, root: &str) -> anyhow::Result<Vec<Candidate>> {
    let by_id: HashMap<&str, &MetaPackage> = metadata
        .packages
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let resolve = metadata
        .resolve
        .as_ref()
        .context("`cargo metadata` returned no dependency resolution")?;
    let nodes: HashMap<&str, &Node> = resolve.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let root_id = metadata
        .packages
        .iter()
        .find(|p| p.name == root && p.source.is_none())
        .map(|p| p.id.as_str())
        .with_context(|| format!("the workspace has no crate {root:?}"))?;

    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut queue: VecDeque<&str> = VecDeque::from([root_id]);
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        let node = nodes
            .get(id)
            .with_context(|| format!("{id} is not in the resolve graph"))?;
        for dep in &node.deps {
            if dep.dep_kinds.iter().any(|k| k.kind.is_none()) {
                queue.push_back(dep.pkg.as_str());
            }
        }
    }

    let mut out = Vec::new();
    for id in seen {
        let package = by_id
            .get(id)
            .with_context(|| format!("{id} is in the resolve graph but not in the package list"))?;
        if package.source.is_none() {
            continue;
        }
        let dir = package.manifest_path.parent().map(Path::to_path_buf);
        out.push(Candidate {
            ecosystem: Ecosystem::Cargo,
            name: package.name.clone(),
            version: package.version.clone(),
            licence: package.license.clone(),
            url: package
                .repository
                .clone()
                .or_else(|| package.homepage.clone()),
            authors: package.authors.clone(),
            licence_file: match (&dir, &package.license_file) {
                (Some(dir), Some(file)) => Some(dir.join(file)),
                _ => None,
            },
            dir,
        });
    }
    Ok(out)
}

/// The packages of `pnpm licenses list --json` (`{ "<licence>": [{ name, versions, paths, license, author?,
/// homepage? }] }`), one per installed version. `package.json` in each path supplies the repository and author.
pub fn npm_packages(listing: &Value) -> anyhow::Result<Vec<Candidate>> {
    let groups = listing
        .as_object()
        .context("the pnpm licence listing is not a JSON object")?;
    let mut out = Vec::new();
    for (group_licence, entries) in groups {
        let entries = entries
            .as_array()
            .with_context(|| format!("pnpm licence group {group_licence:?} is not an array"))?;
        for entry in entries {
            let name = entry["name"]
                .as_str()
                .with_context(|| format!("a pnpm entry under {group_licence:?} has no name"))?;
            let versions = entry["versions"]
                .as_array()
                .with_context(|| format!("{name}: no versions"))?;
            let paths = entry["paths"].as_array();
            for (i, version) in versions.iter().enumerate() {
                let version = version
                    .as_str()
                    .with_context(|| format!("{name}: a version is not a string"))?;
                let dir = paths
                    .and_then(|p| p.get(i).or_else(|| p.first()))
                    .and_then(Value::as_str)
                    .map(PathBuf::from);
                let manifest: Value = dir
                    .as_ref()
                    .and_then(|d| std::fs::read(d.join("package.json")).ok())
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or(Value::Null);
                let licence = entry["license"]
                    .as_str()
                    .or_else(|| manifest["license"].as_str())
                    .map(str::to_owned);
                let url = repository_url(&manifest["repository"])
                    .or_else(|| entry["homepage"].as_str().map(str::to_owned))
                    .or_else(|| manifest["homepage"].as_str().map(str::to_owned));
                let author = match &manifest["author"] {
                    Value::String(s) => Some(s.clone()),
                    Value::Object(o) => o.get("name").and_then(Value::as_str).map(str::to_owned),
                    _ => entry["author"].as_str().map(str::to_owned),
                };
                out.push(Candidate {
                    ecosystem: Ecosystem::Npm,
                    name: name.to_owned(),
                    version: version.to_owned(),
                    licence,
                    url,
                    authors: author.into_iter().collect(),
                    dir,
                    licence_file: None,
                });
            }
        }
    }
    Ok(out)
}

/// The URL of a `package.json` `repository` (string, shorthand or `{ url }`).
fn repository_url(repository: &Value) -> Option<String> {
    let raw = match repository {
        Value::String(s) => s.as_str(),
        Value::Object(o) => o.get("url").and_then(Value::as_str)?,
        _ => return None,
    };
    let raw = raw.trim();
    for (prefix, host) in [
        ("github:", "https://github.com/"),
        ("gitlab:", "https://gitlab.com/"),
        ("bitbucket:", "https://bitbucket.org/"),
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return Some(format!("{host}{rest}"));
        }
    }
    // npm shorthand `user/repo`.
    if !raw.contains(':') && raw.matches('/').count() == 1 && !raw.starts_with('/') {
        return Some(format!("https://github.com/{raw}"));
    }
    Some(raw.to_owned())
}

// ---- output -----------------------------------------------------------------------------------------------------

/// `src/lib/about/thirdparty.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThirdParty {
    /// Sorted by ecosystem (cargo, then npm), name (case-insensitively) and version.
    pub packages: Vec<Package>,
    /// Licence and notice text segments, each stored once (compared ignoring whitespace layout), in order of first
    /// use. A licence file is split before the standard MIT permission paragraph ("Permission is hereby granted…")
    /// and after the Apache terms ("END OF TERMS AND CONDITIONS"), so the copyright lines stay per package while the
    /// standard body is shared.
    pub texts: Vec<String>,
}

/// One shipped third-party package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    /// The declared licence as a normalised SPDX expression (`MIT/Apache-2.0` → `MIT OR Apache-2.0`).
    pub licence: String,
    /// The alternative of `licence` the app uses (`MIT` for `MIT OR Apache-2.0`).
    pub used: String,
    /// Repository, else homepage, else the registry page (always http(s)).
    pub url: String,
    /// Declared authors, without e-mail addresses.
    pub authors: Vec<String>,
    /// Indices into [`ThirdParty::texts`]: the package's own licence/notice files for `used`, then any reviewed
    /// stand-ins and bundled-component notices from [`VENDORED`], as segments; the package's licence text is
    /// `texts.map(i => all[i]).join('\n\n')`. Never empty: it contains the text of every licence in `used`.
    pub texts: Vec<usize>,
}

impl ThirdParty {
    /// JSON with one package and one text per line (compact, yet line-diffable), and a trailing newline.
    pub fn render(&self) -> anyhow::Result<String> {
        let mut json = String::from("{\n  \"packages\": [");
        for (i, package) in self.packages.iter().enumerate() {
            json.push_str(if i == 0 { "\n    " } else { ",\n    " });
            json.push_str(&serde_json::to_string(package).context("serialise a package")?);
        }
        json.push_str(if self.packages.is_empty() {
            "],\n  \"texts\": ["
        } else {
            "\n  ],\n  \"texts\": ["
        });
        for (i, text) in self.texts.iter().enumerate() {
            json.push_str(if i == 0 { "\n    " } else { ",\n    " });
            json.push_str(&serde_json::to_string(text).context("serialise a text")?);
        }
        json.push_str(if self.texts.is_empty() {
            "]\n}\n"
        } else {
            "\n  ]\n}\n"
        });
        Ok(json)
    }
}

/// Splits a normalised licence text into shareable segments: before a paragraph starting with the MIT permission
/// grant or the OFL 1.1 title, and after a paragraph starting with Apache's "END OF TERMS AND CONDITIONS". So the
/// copyright lines stay with their package and the standard text is stored once. Segment text is kept verbatim.
#[must_use]
pub fn segments(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut cuts = BTreeSet::new();
    let mut start = 0;
    while start < lines.len() {
        if lines.get(start).is_none_or(|l| l.is_empty()) {
            start += 1;
            continue;
        }
        let end = (start..lines.len())
            .find(|i| lines.get(*i).is_some_and(|l| l.is_empty()))
            .unwrap_or(lines.len());
        let paragraph = collapse_whitespace(&lines.get(start..end).unwrap_or_default().join(" "));
        let title = paragraph.trim_start_matches(['-', ' ']);
        if start > 0
            && (paragraph.starts_with("Permission is hereby granted, free of charge")
                || title.starts_with("SIL OPEN FONT LICENSE Version 1.1"))
        {
            cuts.insert(start);
        }
        if end < lines.len() && paragraph.starts_with("END OF TERMS AND CONDITIONS") {
            cuts.insert(end);
        }
        start = end;
    }
    let mut bounds: Vec<usize> = vec![0];
    bounds.extend(cuts);
    bounds.push(lines.len());
    bounds
        .windows(2)
        .filter_map(|w| match w {
            [from, to] => lines.get(*from..*to),
            _ => None,
        })
        .map(|part| normalise_text(&part.join("\n")))
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// All whitespace runs → one space, trimmed: the key under which segments are shared.
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One licence or notice file, read and classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenceText {
    /// The file name (`LICENSE-MIT`).
    pub name: String,
    /// The normalised text ([`normalise_text`]); a vendored notice starts with its `heading` paragraph.
    pub text: String,
    /// The families the file name points at ([`policy::file_families`]; empty for a generic name).
    pub named: Vec<&'static str>,
    /// The licences the text contains ([`policy::text_families`]).
    pub contains: BTreeSet<&'static str>,
}

impl LicenceText {
    #[must_use]
    pub fn new(name: &str, text: &str) -> Self {
        let text = normalise_text(text);
        Self {
            name: name.to_owned(),
            named: policy::file_families(name),
            contains: policy::text_families(&text),
            text,
        }
    }

    /// An SPDX tag-value document (`LICENSE.spdx`): machine-readable metadata that names licences without their
    /// text.
    #[must_use]
    pub fn is_spdx_document(&self) -> bool {
        self.name.to_ascii_lowercase().ends_with(".spdx") || self.text.starts_with("SPDXVersion:")
    }
}

/// Every family a set of files backs for choosing an alternative: by name or by content.
fn backing(texts: &[&LicenceText]) -> Vec<&'static str> {
    let mut families: BTreeSet<&'static str> = BTreeSet::new();
    for text in texts {
        families.extend(text.named.iter().copied());
        families.extend(text.contains.iter().copied());
    }
    families.into_iter().collect()
}

/// The terms of `used` whose licence text none of `texts` contains (by content).
fn lacking(used: &[String], texts: &[&LicenceText]) -> Vec<String> {
    used.iter()
        .filter(|term| {
            policy::family(term)
                .is_none_or(|family| !texts.iter().any(|t| t.contains.contains(family)))
        })
        .cloned()
        .collect()
}

/// Appends `text`'s segments to the shared list (each stored once) and their indices to `indices`.
fn add_segments(
    text: &str,
    out: &mut ThirdParty,
    index: &mut HashMap<String, usize>,
    indices: &mut Vec<usize>,
) {
    for segment in segments(text) {
        let next = index.len();
        let at = *index
            .entry(collapse_whitespace(&segment))
            .or_insert_with(|| {
                out.texts.push(segment);
                next
            });
        if !indices.contains(&at) {
            indices.push(at);
        }
    }
}

/// Checks every candidate against the licence policy, reads its licence files, checks that they contain the text of
/// every licence the app uses the package under (falling back to `vendored` stand-ins, and adding its notices) and
/// builds the output. Fails with every problem listed at once: policy violations, missing licence texts, and stale or
/// outdated `vendored` entries.
pub fn assemble(mut candidates: Vec<Candidate>, vendored: &Vendored) -> anyhow::Result<ThirdParty> {
    candidates.sort_by(|a, b| {
        a.ecosystem
            .cmp(&b.ecosystem)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| compare_versions(&a.version, &b.version))
    });
    candidates
        .dedup_by(|a, b| a.ecosystem == b.ecosystem && a.name == b.name && a.version == b.version);

    let mut out = ThirdParty::default();
    let mut text_index: HashMap<String, usize> = HashMap::new();
    let mut problems = Vec::new();
    // Which vendored entries and versions the shipped packages use (the rest is stale).
    let mut shipped: BTreeMap<(Ecosystem, &str), BTreeSet<String>> = BTreeMap::new();
    for candidate in &candidates {
        shipped
            .entry((candidate.ecosystem, candidate.name.as_str()))
            .or_default()
            .insert(candidate.version.clone());
    }
    for (key, entry) in &vendored.entries {
        let Some(versions) = shipped.get(&(key.0, key.1.as_str())) else {
            problems.push(format!(
                "{}/: {} {} is not shipped any more; delete the directory",
                entry.rel,
                ecosystem_name(key.0),
                key.1
            ));
            continue;
        };
        for version in entry.versions.iter().filter(|v| !versions.contains(*v)) {
            problems.push(format!(
                "{}/source.toml: {}@{version} is not shipped any more; remove it from `versions`",
                entry.rel, key.1
            ));
        }
    }

    for candidate in candidates {
        let label = format!(
            "{} {}@{}",
            ecosystem_name(candidate.ecosystem),
            candidate.name,
            candidate.version
        );
        let entry = vendored.get(candidate.ecosystem, &candidate.name);
        if let Some(entry) = entry
            && !entry.versions.contains(&candidate.version)
        {
            problems.push(format!(
                "{label}: {}/ was reviewed for {} only; check the upstream licence at {}, then add it to `versions` in \
                 source.toml (and update the files if it changed)",
                entry.rel,
                entry.versions.join(", "),
                candidate.version
            ));
        }
        let Some(declared) = candidate
            .licence
            .as_deref()
            .map(str::trim)
            .filter(|l| !l.is_empty())
        else {
            problems.push(format!("{label}: declares no licence"));
            continue;
        };
        let expr = match spdx::parse(declared) {
            Ok(expr) => expr,
            Err(e) => {
                problems.push(format!(
                    "{label}: licence {declared:?} is not an SPDX expression ({e:#})"
                ));
                continue;
            }
        };
        let files = match &candidate.dir {
            Some(dir) => licence_files(dir, candidate.licence_file.as_deref())
                .with_context(|| format!("{label}: list licence files in {}", dir.display()))?,
            None => Vec::new(),
        };
        let mut own = Vec::with_capacity(files.len());
        for file in &files {
            let bytes = std::fs::read(file).with_context(|| format!("read {}", file.display()))?;
            let name = file
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            own.push(LicenceText::new(&name, &String::from_utf8_lossy(&bytes)));
        }
        let own_refs: Vec<&LicenceText> = own.iter().collect();
        let Some(mut used) = policy::choose(&expr, &backing(&own_refs)) else {
            problems.push(format!(
                "{label}: licence {} is not satisfiable with the allowed licences ({})",
                expr.render(),
                policy::ALLOWED.join(", ")
            ));
            continue;
        };

        // The package's own texts must contain every licence it is used under; otherwise reviewed stand-ins fill in.
        let mut stand_ins: &[LicenceText] = &[];
        let stand_in_entry = entry.filter(|e| !e.licences.is_empty());
        if let Some(entry) = stand_in_entry {
            if lacking(&used, &own_refs).is_empty() {
                problems.push(format!(
                    "{label}: ships the text of {} itself now; delete the `licence` files from {}/",
                    used.join(" AND "),
                    entry.rel
                ));
            } else {
                stand_ins = &entry.licences;
                let pool: Vec<&LicenceText> = own.iter().chain(stand_ins).collect();
                if let Some(better) = policy::choose(&expr, &backing(&pool)) {
                    used = better;
                }
            }
        }
        let pool: Vec<&LicenceText> = own.iter().chain(stand_ins).collect();
        let missing = lacking(&used, &pool);
        if !missing.is_empty() {
            let shipped_files: Vec<&str> = own.iter().map(|t| t.name.as_str()).collect();
            problems.push(format!(
                "{label}: no {} licence text among {}; add the upstream licence file at this version to \
                 {}/{}/{}/",
                missing.join(" or "),
                if shipped_files.is_empty() {
                    "its files (it ships none)".to_owned()
                } else {
                    format!("its files ({})", shipped_files.join(", "))
                },
                vendored.label,
                ecosystem_dir(candidate.ecosystem),
                candidate.name,
            ));
            continue;
        }

        // Order: the package's licence texts, the stand-ins, bundled-component notices, then SPDX metadata documents
        // (kept for their copyright line, but a reader should meet the licence first).
        let families: BTreeSet<&str> = used.iter().filter_map(|id| policy::family(id)).collect();
        let kept: Vec<&LicenceText> = own
            .iter()
            .filter(|text| text.named.is_empty() || text.named.iter().any(|f| families.contains(f)))
            .collect();
        let (metadata, licences): (Vec<&LicenceText>, Vec<&LicenceText>) =
            kept.into_iter().partition(|text| text.is_spdx_document());
        let mut texts = Vec::new();
        for text in licences
            .into_iter()
            .chain(stand_ins)
            .chain(entry.map_or(&[][..], |e| &e.notices))
            .chain(metadata)
        {
            add_segments(&text.text, &mut out, &mut text_index, &mut texts);
        }
        let url = clean_url(candidate.url.as_deref())
            .unwrap_or_else(|| registry_url(candidate.ecosystem, &candidate.name));
        out.packages.push(Package {
            ecosystem: candidate.ecosystem,
            name: candidate.name,
            version: candidate.version,
            licence: expr.render(),
            used: used.join(" AND "),
            url,
            authors: clean_authors(&candidate.authors),
            texts,
        });
    }
    if !problems.is_empty() {
        bail!(
            "licenses: {} problem(s) with the licence policy or the licence texts:\n  {}",
            problems.len(),
            problems.join("\n  ")
        );
    }
    Ok(out)
}

fn ecosystem_name(ecosystem: Ecosystem) -> &'static str {
    match ecosystem {
        Ecosystem::Cargo => "crate",
        Ecosystem::Npm => "npm",
    }
}

/// The directory of an ecosystem under [`VENDORED`].
fn ecosystem_dir(ecosystem: Ecosystem) -> &'static str {
    match ecosystem {
        Ecosystem::Cargo => "cargo",
        Ecosystem::Npm => "npm",
    }
}

// ---- vendored stand-ins and notices -----------------------------------------------------------------------------

/// The reviewed files of [`VENDORED`], by package.
#[derive(Debug, Clone, Default)]
pub struct Vendored {
    /// How the root is named in messages (`xtask/licenses`).
    pub label: String,
    entries: BTreeMap<(Ecosystem, String), VendorEntry>,
}

/// `<root>/<ecosystem>/<package>/`: what stands in for a package's missing licence text, and notices it needs.
#[derive(Debug, Clone)]
pub struct VendorEntry {
    pub package: String,
    /// The directory as shown in messages (`xtask/licenses/cargo/objc2`).
    pub rel: String,
    /// The shipped versions the files were reviewed for (exact).
    pub versions: Vec<String>,
    /// `kind = "licence"`: used only while the package's own files lack the licence text.
    pub licences: Vec<LicenceText>,
    /// `kind = "notice"`: always added (a third-party component the package bundles).
    pub notices: Vec<LicenceText>,
}

/// `source.toml`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceToml {
    versions: Vec<String>,
    #[serde(rename = "file")]
    files: Vec<SourceFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    name: String,
    kind: SourceKind,
    /// Where the file comes from (a URL at the package's commit, or how a canonical text was filled in).
    source: String,
    /// A first paragraph that names a bundled component (notices).
    heading: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SourceKind {
    Licence,
    Notice,
}

/// The manifest of a vendored package directory.
pub const SOURCE_TOML: &str = "source.toml";

impl Vendored {
    /// Reads and validates every `<root>/{cargo,npm}/<package>/` (npm scopes nest: `npm/@scope/name/`). A missing root
    /// is empty. Fails on a malformed directory: no or an invalid `source.toml`, a declared file that is missing,
    /// empty or not UTF-8, a file that is not declared, or a stray file or directory.
    pub fn load(root: &Path, label: &str) -> anyhow::Result<Self> {
        let mut vendored = Self {
            label: label.to_owned(),
            entries: BTreeMap::new(),
        };
        for ecosystem in [Ecosystem::Cargo, Ecosystem::Npm] {
            let dir = root.join(ecosystem_dir(ecosystem));
            if !dir.is_dir() {
                continue;
            }
            for (name, path) in subdirectories(&dir)? {
                if ecosystem == Ecosystem::Npm && name.starts_with('@') {
                    for (inner, inner_path) in subdirectories(&path)? {
                        vendored.add(ecosystem, &format!("{name}/{inner}"), &inner_path)?;
                    }
                } else {
                    vendored.add(ecosystem, &name, &path)?;
                }
            }
        }
        Ok(vendored)
    }

    fn add(&mut self, ecosystem: Ecosystem, package: &str, dir: &Path) -> anyhow::Result<()> {
        let rel = format!("{}/{}/{package}", self.label, ecosystem_dir(ecosystem));
        let manifest_path = dir.join(SOURCE_TOML);
        let manifest: SourceToml = toml::from_str(
            &std::fs::read_to_string(&manifest_path)
                .with_context(|| format!("{rel}/: read {SOURCE_TOML}"))?,
        )
        .with_context(|| format!("{rel}/{SOURCE_TOML}"))?;
        ensure!(
            !manifest.versions.is_empty() && manifest.versions.iter().all(|v| !v.trim().is_empty()),
            "{rel}/{SOURCE_TOML}: `versions` must list the reviewed versions"
        );
        ensure!(
            !manifest.files.is_empty(),
            "{rel}/{SOURCE_TOML}: no [[file]]"
        );
        let mut entry = VendorEntry {
            package: package.to_owned(),
            rel: rel.clone(),
            versions: manifest.versions,
            licences: Vec::new(),
            notices: Vec::new(),
        };
        let mut declared: BTreeSet<String> = BTreeSet::new();
        for file in manifest.files {
            ensure!(
                !file.name.is_empty()
                    && !file.name.contains(['/', '\\'])
                    && file.name != SOURCE_TOML
                    && declared.insert(file.name.clone()),
                "{rel}/{SOURCE_TOML}: file name {:?} is empty, a path, {SOURCE_TOML} or repeated",
                file.name
            );
            ensure!(
                !file.source.trim().is_empty(),
                "{rel}/{SOURCE_TOML}: {} needs a `source`",
                file.name
            );
            let path = dir.join(&file.name);
            let bytes =
                std::fs::read(&path).with_context(|| format!("{rel}/{}: read", file.name))?;
            let body = String::from_utf8(bytes)
                .with_context(|| format!("{rel}/{}: not UTF-8", file.name))?;
            ensure!(
                !normalise_text(&body).is_empty(),
                "{rel}/{}: empty",
                file.name
            );
            let text = match file.heading.as_deref().map(str::trim) {
                Some(heading) if !heading.is_empty() => format!("{heading}\n\n{body}"),
                _ => body,
            };
            let text = LicenceText::new(&file.name, &text);
            match file.kind {
                SourceKind::Licence => entry.licences.push(text),
                SourceKind::Notice => entry.notices.push(text),
            }
        }
        for item in std::fs::read_dir(dir).with_context(|| format!("{rel}/: list"))? {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            ensure!(
                name == SOURCE_TOML || (item.file_type()?.is_file() && declared.contains(&name)),
                "{rel}/{name}: not declared in {SOURCE_TOML}"
            );
        }
        self.entries.insert((ecosystem, package.to_owned()), entry);
        Ok(())
    }

    /// The entry of a package, if any.
    #[must_use]
    pub fn get(&self, ecosystem: Ecosystem, name: &str) -> Option<&VendorEntry> {
        self.entries.get(&(ecosystem, name.to_owned()))
    }

    /// Every entry, by ecosystem and package name.
    pub fn entries(&self) -> impl Iterator<Item = &VendorEntry> {
        self.entries.values()
    }
}

/// The subdirectories of `dir` with their names, sorted; any other entry is an error.
fn subdirectories(dir: &Path) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    for item in std::fs::read_dir(dir).with_context(|| format!("list {}", dir.display()))? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        ensure!(
            item.file_type()?.is_dir(),
            "{}: only package directories belong here",
            item.path().display()
        );
        out.push((name, item.path()));
    }
    out.sort();
    Ok(out)
}

/// The registry page: the fallback when a package names no usable URL.
#[must_use]
pub fn registry_url(ecosystem: Ecosystem, name: &str) -> String {
    match ecosystem {
        Ecosystem::Cargo => format!("https://crates.io/crates/{name}"),
        Ecosystem::Npm => format!("https://www.npmjs.com/package/{name}"),
    }
}

/// Licence-ish files of a package directory (and its `LICENSES/` folder, REUSE style), plus `extra`; sorted by
/// lowercase file name, no duplicates. Source files that merely start with "license" are skipped.
pub fn licence_files(dir: &Path, extra: Option<&Path>) -> anyhow::Result<Vec<PathBuf>> {
    const PREFIXES: [&str; 7] = [
        "licen",
        "copying",
        "copyright",
        "notice",
        "unlicense",
        "third-party",
        "thirdparty",
    ];
    const CODE: [&str; 12] = [
        "rs", "js", "mjs", "cjs", "ts", "json", "toml", "py", "c", "h", "yml", "yaml",
    ];
    let is_licence = |path: &Path| {
        let Some(name) = path
            .file_name()
            .map(|n| n.to_string_lossy().to_ascii_lowercase())
        else {
            return false;
        };
        let code = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .is_some_and(|e| CODE.contains(&e.as_str()));
        PREFIXES.iter().any(|p| name.starts_with(p)) && !code
    };
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_file() && is_licence(&path) {
            files.push(path);
        } else if file_type.is_dir() && entry.file_name().eq_ignore_ascii_case("LICENSES") {
            for inner in std::fs::read_dir(&path)? {
                let inner = inner?;
                if inner.file_type()?.is_file() {
                    files.push(inner.path());
                }
            }
        }
    }
    if let Some(extra) = extra
        && extra.is_file()
    {
        files.push(extra.to_path_buf());
    }
    let key = |p: &PathBuf| {
        (
            p.file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase()),
            p.clone(),
        )
    };
    files.sort_by_key(key);
    files.dedup_by(|a, b| same_file(a, b));
    Ok(files)
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

/// BOM removed, CR LF and lone CR → LF, trailing whitespace removed from every line, blank lines trimmed at both
/// ends. Inner text is kept verbatim.
#[must_use]
pub fn normalise_text(text: &str) -> String {
    let text = text
        .strip_prefix('\u{FEFF}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<&str> = text.split('\n').map(str::trim_end).collect();
    let start = lines.iter().position(|l| !l.is_empty());
    let end = lines.iter().rposition(|l| !l.is_empty());
    match (start, end) {
        (Some(start), Some(end)) => lines
            .get(start..=end)
            .map(|l| l.join("\n"))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// An http(s) URL: `git+https://…/x.git` → `https://…/x`, `git://` and `git@host:` → `https://`. `None` when the
/// value cannot be made into one.
#[must_use]
pub fn clean_url(url: Option<&str>) -> Option<String> {
    let mut url = url?.trim().to_owned();
    if let Some(rest) = url.strip_prefix("git+") {
        url = rest.to_owned();
    }
    if let Some(rest) = url.strip_prefix("git://") {
        url = format!("https://{rest}");
    } else if let Some(rest) = url.strip_prefix("ssh://git@") {
        url = format!("https://{rest}");
    } else if let Some(rest) = url.strip_prefix("git@")
        && let Some((host, path)) = rest.split_once(':')
    {
        url = format!("https://{host}/{path}");
    }
    if let Some(rest) = url.strip_prefix("http://")
        && [
            "github.com/",
            "gitlab.com/",
            "bitbucket.org/",
            "codeberg.org/",
        ]
        .iter()
        .any(|h| rest.starts_with(h))
    {
        url = format!("https://{rest}");
    }
    while url.ends_with('/') {
        url.pop();
    }
    if let Some(stripped) = url.strip_suffix(".git") {
        url = stripped.to_owned();
    }
    let valid = (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() > "https://".len()
        && !url.chars().any(char::is_whitespace);
    valid.then_some(url)
}

/// Names only: `Jane Doe <jane@example.com>` → `Jane Doe`, `Joe (https://joe.dev)` → `Joe`; blanks and repeats
/// dropped.
#[must_use]
pub fn clean_authors(authors: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for author in authors {
        let mut name = String::new();
        let mut depth = 0usize;
        for ch in author.chars() {
            match ch {
                '<' | '(' => depth += 1,
                '>' | ')' => depth = depth.saturating_sub(1),
                _ if depth == 0 => name.push(ch),
                _ => {}
            }
        }
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        let name = name
            .trim_matches(|c: char| c == ',' || c == ';')
            .trim()
            .to_owned();
        if !name.is_empty() && !name.contains('@') && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// Version order: dot/dash-separated parts, numeric parts numerically and before textual ones.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parts = |v: &str| -> Vec<String> { v.split(['.', '-', '+']).map(str::to_owned).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for (x, y) in pa.iter().zip(&pb) {
        let order = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    pa.len().cmp(&pb.len()).then_with(|| a.cmp(b))
}

// ---- SPDX expressions ---------------------------------------------------------------------------------------------

/// SPDX licence expressions (SPDX 2.3 annex D): `AND`, `OR`, `WITH`, parentheses, plus the legacy Cargo separator
/// `/` (= `OR`). Identifiers are matched case-insensitively against the ids the policy knows and keep their
/// canonical spelling.
pub mod spdx {
    use anyhow::{bail, ensure};

    /// A parsed expression.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Expr {
        /// A licence id (or `LicenseRef-…`).
        Id(String),
        /// `licence WITH exception`.
        With(String, String),
        And(Vec<Expr>),
        Or(Vec<Expr>),
    }

    /// The maximum number of alternatives an expression may expand to.
    const MAX_ALTERNATIVES: usize = 256;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Token {
        Open,
        Close,
        And,
        Or,
        With,
        Id(String),
    }

    fn tokenize(text: &str) -> anyhow::Result<Vec<Token>> {
        let mut tokens = Vec::new();
        let mut word = String::new();
        let flush = |word: &mut String, tokens: &mut Vec<Token>| {
            if word.is_empty() {
                return;
            }
            let token = match word.to_ascii_uppercase().as_str() {
                "AND" => Token::And,
                "OR" => Token::Or,
                "WITH" => Token::With,
                _ => Token::Id(canonical_id(word)),
            };
            tokens.push(token);
            word.clear();
        };
        for ch in text.chars() {
            match ch {
                '(' | ')' | '/' => {
                    flush(&mut word, &mut tokens);
                    tokens.push(match ch {
                        '(' => Token::Open,
                        ')' => Token::Close,
                        _ => Token::Or,
                    });
                }
                c if c.is_whitespace() => flush(&mut word, &mut tokens),
                c if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | ':') => {
                    word.push(c)
                }
                c => bail!("unexpected character {c:?}"),
            }
        }
        flush(&mut word, &mut tokens);
        Ok(tokens)
    }

    /// The policy's spelling of a known id (`mit` → `MIT`), else the id as written.
    fn canonical_id(id: &str) -> String {
        super::policy::KNOWN
            .iter()
            .find(|known| known.eq_ignore_ascii_case(id))
            .map_or_else(|| id.to_owned(), |known| (*known).to_owned())
    }

    struct Parser {
        tokens: Vec<Token>,
        at: usize,
    }

    impl Parser {
        fn peek(&self) -> Option<&Token> {
            self.tokens.get(self.at)
        }

        fn next(&mut self) -> Option<Token> {
            let token = self.tokens.get(self.at).cloned();
            self.at += 1;
            token
        }

        fn or(&mut self) -> anyhow::Result<Expr> {
            let mut terms = vec![self.and()?];
            while self.peek() == Some(&Token::Or) {
                self.at += 1;
                terms.push(self.and()?);
            }
            Ok(flatten(terms, true))
        }

        fn and(&mut self) -> anyhow::Result<Expr> {
            let mut terms = vec![self.with()?];
            while self.peek() == Some(&Token::And) {
                self.at += 1;
                terms.push(self.with()?);
            }
            Ok(flatten(terms, false))
        }

        fn with(&mut self) -> anyhow::Result<Expr> {
            let primary = self.primary()?;
            if self.peek() != Some(&Token::With) {
                return Ok(primary);
            }
            self.at += 1;
            let Expr::Id(licence) = primary else {
                bail!("WITH must follow a licence id");
            };
            match self.next() {
                Some(Token::Id(exception)) => Ok(Expr::With(licence, exception)),
                other => bail!("WITH must be followed by an exception id, found {other:?}"),
            }
        }

        fn primary(&mut self) -> anyhow::Result<Expr> {
            match self.next() {
                Some(Token::Open) => {
                    let inner = self.or()?;
                    ensure!(self.next() == Some(Token::Close), "unbalanced parentheses");
                    Ok(inner)
                }
                Some(Token::Id(id)) => Ok(Expr::Id(id)),
                other => bail!("expected a licence id, found {other:?}"),
            }
        }
    }

    /// `OR`/`AND` lists with nested lists of the same operator inlined; a single term stays itself.
    fn flatten(terms: Vec<Expr>, or: bool) -> Expr {
        let mut flat = Vec::with_capacity(terms.len());
        for term in terms {
            match term {
                Expr::Or(inner) if or => flat.extend(inner),
                Expr::And(inner) if !or => flat.extend(inner),
                other => flat.push(other),
            }
        }
        if flat.len() == 1
            && let Some(single) = flat.pop()
        {
            return single;
        }
        if or { Expr::Or(flat) } else { Expr::And(flat) }
    }

    /// Parses an expression; the whole text must be consumed.
    pub fn parse(text: &str) -> anyhow::Result<Expr> {
        let tokens = tokenize(text)?;
        ensure!(!tokens.is_empty(), "empty expression");
        let mut parser = Parser { tokens, at: 0 };
        let expr = parser.or()?;
        ensure!(
            parser.at == parser.tokens.len(),
            "unexpected {:?} after a complete expression",
            parser.peek()
        );
        Ok(expr)
    }

    impl Expr {
        /// Canonical text: ` OR `/` AND ` separators, parentheses only around an `OR` inside an `AND`.
        #[must_use]
        pub fn render(&self) -> String {
            match self {
                Self::Id(id) => id.clone(),
                Self::With(licence, exception) => format!("{licence} WITH {exception}"),
                Self::Or(terms) => terms
                    .iter()
                    .map(Self::render)
                    .collect::<Vec<_>>()
                    .join(" OR "),
                Self::And(terms) => terms
                    .iter()
                    .map(|t| match t {
                        Self::Or(_) => format!("({})", t.render()),
                        _ => t.render(),
                    })
                    .collect::<Vec<_>>()
                    .join(" AND "),
            }
        }

        /// The expression as alternatives (disjunctive normal form): each is the set of licence terms (`MIT`,
        /// `Apache-2.0 WITH LLVM-exception`) that together satisfy it, in first-appearance order.
        pub fn alternatives(&self) -> anyhow::Result<Vec<Vec<String>>> {
            let alternatives = match self {
                Self::Id(_) | Self::With(..) => vec![vec![self.render()]],
                Self::Or(terms) => {
                    let mut all = Vec::new();
                    for term in terms {
                        all.extend(term.alternatives()?);
                    }
                    all
                }
                Self::And(terms) => {
                    let mut product: Vec<Vec<String>> = vec![Vec::new()];
                    for term in terms {
                        let options = term.alternatives()?;
                        let mut next = Vec::with_capacity(product.len() * options.len());
                        for base in &product {
                            for option in &options {
                                let mut combined = base.clone();
                                for id in option {
                                    if !combined.contains(id) {
                                        combined.push(id.clone());
                                    }
                                }
                                next.push(combined);
                            }
                        }
                        ensure!(
                            next.len() <= MAX_ALTERNATIVES,
                            "the expression has too many alternatives"
                        );
                        product = next;
                    }
                    product
                }
            };
            ensure!(
                alternatives.len() <= MAX_ALTERNATIVES,
                "the expression has too many alternatives"
            );
            Ok(alternatives)
        }
    }
}

// ---- licence policy -------------------------------------------------------------------------------------------------

/// What the app may ship, and which alternative and files to use.
pub mod policy {
    use std::collections::BTreeSet;

    use super::spdx::Expr;

    /// Licences compatible with distributing the app's binaries under its own licence, GPL-3.0-or-later, in order of
    /// preference when a package offers a choice: permissive licences, then file-level copyleft (MPL-2.0), then font
    /// and data licences (shipped alongside, not linked). Dependencies stay permissive or weak-copyleft: GPL, LGPL,
    /// AGPL, SSPL, EUPL, the GPL-incompatible OpenSSL licence and every unknown id are refused.
    pub const ALLOWED: [&str; 21] = [
        "MIT",
        "Apache-2.0",
        "BSD-3-Clause",
        "BSD-2-Clause",
        "ISC",
        "Zlib",
        "0BSD",
        "MIT-0",
        "Unlicense",
        "CC0-1.0",
        "BSL-1.0",
        "Unicode-3.0",
        "Unicode-DFS-2016",
        "CDLA-Permissive-2.0",
        "BlueOak-1.0.0",
        "NCSA",
        "Python-2.0",
        "MPL-2.0",
        "OFL-1.1",
        "CC-BY-4.0",
        "CC-BY-3.0",
    ];

    /// Every id the parser canonicalises (allowed ones plus common refused ones, so error messages read well).
    pub const KNOWN: [&str; 37] = [
        "MIT",
        "Apache-2.0",
        "BSD-3-Clause",
        "BSD-2-Clause",
        "ISC",
        "Zlib",
        "0BSD",
        "MIT-0",
        "Unlicense",
        "CC0-1.0",
        "BSL-1.0",
        "Unicode-3.0",
        "Unicode-DFS-2016",
        "CDLA-Permissive-2.0",
        "BlueOak-1.0.0",
        "NCSA",
        "OpenSSL",
        "Python-2.0",
        "MPL-2.0",
        "OFL-1.1",
        "CC-BY-4.0",
        "CC-BY-3.0",
        "LLVM-exception",
        "GPL-2.0",
        "GPL-2.0-only",
        "GPL-2.0-or-later",
        "GPL-3.0",
        "GPL-3.0-only",
        "GPL-3.0-or-later",
        "LGPL-2.1",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
        "AGPL-3.0-only",
        "AGPL-3.0-or-later",
    ];

    /// The preference rank of an allowed term (`A WITH exception` ranks as `A`: an exception only adds permissions);
    /// `None` when it is not allowed.
    #[must_use]
    pub fn rank(term: &str) -> Option<usize> {
        let base = term.split(" WITH ").next().unwrap_or(term);
        ALLOWED.iter().position(|a| *a == base)
    }

    /// The licence-text family a term's text belongs to (`MIT` → `mit`, `Apache-2.0 WITH LLVM-exception` → `apache`).
    /// Every [`ALLOWED`] licence has one, so [`text_families`] can check that its text is shipped.
    #[must_use]
    pub fn family(term: &str) -> Option<&'static str> {
        let base = term
            .split(" WITH ")
            .next()
            .unwrap_or(term)
            .to_ascii_lowercase();
        Some(match base.as_str() {
            b if b.starts_with("mit") => "mit",
            b if b.starts_with("apache") => "apache",
            "0bsd" => "0bsd",
            b if b.starts_with("bsd") => "bsd",
            "zlib" => "zlib",
            "isc" => "isc",
            "unlicense" => "unlicense",
            b if b.starts_with("mpl") => "mpl",
            b if b.starts_with("cc0") => "cc0",
            "bsl-1.0" => "boost",
            b if b.starts_with("unicode") => "unicode",
            b if b.starts_with("ofl") => "ofl",
            b if b.starts_with("cdla-permissive") => "cdla-permissive",
            b if b.starts_with("blueoak") => "blueoak",
            "ncsa" => "ncsa",
            "python-2.0" => "python",
            b if b.starts_with("cc-by-") => "cc-by",
            _ => return None,
        })
    }

    /// The licences whose text `text` contains, recognised by each licence's operative wording (case, line breaks,
    /// typographic quotes and comment leaders such as `//` or ` * ` ignored). A notice that only names a licence
    /// ("Licensed under the MIT license", an SPDX document, an Apache-2.0 file header) contains none.
    #[must_use]
    pub fn text_families(text: &str) -> BTreeSet<&'static str> {
        let flat = text
            .lines()
            .map(|line| {
                line.trim_start_matches(|c: char| {
                    c.is_whitespace() || matches!(c, '/' | '*' | '#' | '!')
                })
            })
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
            .replace(['\u{2018}', '\u{2019}', '`'], "'")
            .replace(['\u{201C}', '\u{201D}'], "\"");
        let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
        let has = |needle: &str| flat.contains(needle);
        let mut families = BTreeSet::new();
        let mut found = |family: &'static str, present: bool| {
            if present {
                families.insert(family);
            }
        };
        found(
            "mit",
            has(
                "permission is hereby granted, free of charge, to any person obtaining a copy of this software",
            ),
        );
        found(
            "apache",
            has("apache license")
                && has("terms and conditions for use, reproduction, and distribution"),
        );
        found(
            "bsd",
            has(
                "redistribution and use in source and binary forms, with or without modification, are permitted \
                 provided that",
            ),
        );
        found(
            "isc",
            has(
                "with or without fee is hereby granted, provided that the above copyright notice and this \
                 permission notice appear in all copies",
            ),
        );
        found("0bsd", has("with or without fee is hereby granted."));
        found(
            "zlib",
            has("altered source versions must be plainly marked as such"),
        );
        found(
            "mpl",
            has("mozilla public license") && has("covered software"),
        );
        found(
            "unicode",
            has("unicode")
                && has("data files")
                && has(
                    "permission is hereby granted, free of charge, to any person obtaining a copy",
                ),
        );
        found("ofl", has("sil open font license") && has("font software"));
        found("cc0", has("cc0 1.0 universal"));
        found(
            "unlicense",
            has("this is free and unencumbered software released into the public domain"),
        );
        found(
            "boost",
            has("boost software license")
                && has(
                    "permission is hereby granted, free of charge, to any person or organization",
                ),
        );
        found(
            "cdla-permissive",
            has("community data license agreement") && has("permissive"),
        );
        found("blueoak", has("blue oak model license"));
        found(
            "ncsa",
            has("university of illinois/ncsa open source license"),
        );
        found("python", has("python software foundation license"));
        found(
            "cc-by",
            has("creative commons")
                && (has("attribution 4.0 international") || has("attribution 3.0")),
        );
        families
    }

    /// The families a licence file's name points at (`LICENSE-MIT` → `mit`; `LICENSE`, `COPYRIGHT` → none, i.e.
    /// generic).
    #[must_use]
    pub fn file_families(file_name: &str) -> Vec<&'static str> {
        let mut families = Vec::new();
        for token in file_name
            .to_ascii_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
        {
            let family = match token {
                "mit" => "mit",
                "apache" | "apache2" => "apache",
                "0bsd" => "0bsd",
                "bsd" => "bsd",
                "zlib" => "zlib",
                "isc" => "isc",
                "unlicense" => "unlicense",
                "mpl" => "mpl",
                "cc0" => "cc0",
                "boost" | "bsl" => "boost",
                "unicode" => "unicode",
                "ofl" => "ofl",
                "cdla" => "cdla-permissive",
                "blueoak" => "blueoak",
                "ncsa" => "ncsa",
                _ => continue,
            };
            if !families.contains(&family) {
                families.push(family);
            }
        }
        families
    }

    /// The alternative of `expr` the app uses: every term allowed; preferring an alternative whose licences are all
    /// `backed` (families the package's files contain or are named after, see [`file_families`] and
    /// [`text_families`]), then by preference rank. `None` when no alternative is allowed.
    #[must_use]
    pub fn choose(expr: &Expr, backed: &[&str]) -> Option<Vec<String>> {
        expr.alternatives()
            .ok()?
            .into_iter()
            .filter_map(|terms| {
                let ranks: Option<Vec<usize>> = terms.iter().map(|t| rank(t)).collect();
                let ranks = ranks?;
                let missing = terms
                    .iter()
                    .filter(|t| family(t).is_none_or(|f| !backed.contains(&f)))
                    .count();
                let worst = ranks.iter().copied().max().unwrap_or(0);
                let total: usize = ranks.iter().sum();
                Some(((missing, worst, total, terms.len()), terms))
            })
            .min_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, terms)| terms)
    }
}
