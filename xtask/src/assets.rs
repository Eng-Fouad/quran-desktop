//! `cargo xtask fetch-assets [--force]`.
//!
//! Fetches the KFGQPC Hafs V30 font the app bundles:
//! 1. `GET https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip`; the archive MUST be exactly 844,410 B;
//! 2. extracts `KFGQPC Hafs V30.ttf` (MUST be exactly 301,356 B) and writes it **unmodified** (the EULA forbids any
//!    modification, so no woff2 conversion or subsetting) to `public/fonts/KFGQPC-Hafs-V30.ttf`, and the EULA, read
//!    from the font's own name table (IDs 0 and 13), to `public/fonts/KFGQPC-Hafs-V30.LICENSE.txt`;
//! 3. pins the font's sha256 in `xtask/assets.lock` on first use (trust on first use); later runs MUST match unless
//!    `--force` is given, and a mismatch writes nothing;
//! 4. when the download fails (no connection, a timeout, an HTTP error, a body over the size cap), takes the font from
//!    `xtask/assets/KFGQPC-Hafs-V30.ttf`, the unmodified pinned file committed to the repository (GitHub's runners
//!    cannot connect to fonts.qurancomplex.gov.sa), once its size and sha256 match the pin. Only with a pin and
//!    without `--force`: the committed copy never pins or re-pins. A downloaded archive or font of the wrong size or
//!    hash never falls back: that is an upstream change to review. A run that pins or re-pins rewrites the committed
//!    copy, so it always matches the lock.
//!
//! A run whose local font already matches the lock downloads nothing: CI restores `public/fonts/` from a cache keyed by
//! the lock's hash, and fonts.qurancomplex.gov.sa is not hit on every run. The licence text is still regenerated from
//! the font on every run, so the committed text can never drift from the shipped binary.
//!
//! The HTTP helpers ([`net`]) and the file helpers ([`write_atomic`], [`write_if_changed`], [`sha256_hex`],
//! [`group`]) are shared with `fetch-dev-packs` (`dev_packs.rs`).

use std::fmt::Write as _;
use std::io::{Cursor, Read as _};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cli::{FetchAssetsArgs, workspace_root};

/// A font that ships unmodified after being extracted from an upstream archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveFont<'a> {
    /// Display name: the first line of the licence file.
    pub name: &'a str,
    /// The archive's URL.
    pub url: &'a str,
    /// Exact archive size: it identifies the upstream release.
    pub archive_bytes: u64,
    /// File name of the font inside the archive (in any directory of it).
    pub entry: &'a str,
    /// Exact font size.
    pub bytes: u64,
    /// Output file, `/`-separated and relative to the repository root. Also the key of its `assets.lock` entry.
    pub file: &'a str,
    /// Licence text output, `/`-separated and relative to the repository root.
    pub licence_file: &'a str,
    /// The pinned font committed to the repository (`/`-separated, relative to the root), used when the download
    /// fails.
    pub committed: Option<&'a str>,
}

/// The bundled Mushaf-text font.
pub const KFGQPC_HAFS_V30: ArchiveFont<'static> = ArchiveFont {
    name: "KFGQPC Hafs V30",
    url: "https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip",
    archive_bytes: 844_410,
    entry: "KFGQPC Hafs V30.ttf",
    bytes: 301_356,
    file: "public/fonts/KFGQPC-Hafs-V30.ttf",
    licence_file: "public/fonts/KFGQPC-Hafs-V30.LICENSE.txt",
    committed: Some("xtask/assets/KFGQPC-Hafs-V30.ttf"),
};

/// The sha256 pins, relative to the repository root.
pub const LOCK_FILE: &str = "xtask/assets.lock";

/// Upper bound for any download of this task (the archive is 0.8 MB).
const MAX_ARCHIVE_BYTES: u64 = 64 << 20;

pub fn run(args: &FetchAssetsArgs) -> anyhow::Result<()> {
    let root = workspace_root();
    let font = KFGQPC_HAFS_V30;
    let runtime = net::runtime()?;
    let client = net::client("fetch-assets")?;
    println!("fetch-assets: {} ← {}", font.name, font.url);
    let report = fetch_archive_font(
        &runtime,
        &client,
        net::Retry::DEFAULT,
        &font,
        &root,
        &rel_path(&root, LOCK_FILE),
        args.force,
    )?;
    let state = |written: bool| if written { "written" } else { "unchanged" };
    let how = match &report.pin {
        Pin::Verified => format!("matches {LOCK_FILE}, nothing downloaded"),
        Pin::Matched => format!("downloaded, matches {LOCK_FILE}"),
        Pin::Pinned => format!("downloaded, pinned in {LOCK_FILE} on first use"),
        Pin::Repinned { previous } => {
            format!("downloaded, re-pinned in {LOCK_FILE} with --force; was {previous}")
        }
        Pin::Committed { download_error } => format!(
            "download failed ({download_error}); copied from {}, matches {LOCK_FILE}",
            font.committed.unwrap_or("the committed copy")
        ),
    };
    println!(
        "  ok   {}  {} B  sha256 {}",
        font.file,
        group(report.bytes),
        report.sha256
    );
    println!("       {how}; file {}", state(report.font_written));
    println!(
        "  ok   {}  EULA from the font's name table; {}",
        font.licence_file,
        state(report.licence_written)
    );
    if let (true, Some(committed)) = (report.committed_written, font.committed) {
        println!(
            "  ok   {committed} updated: commit it together with the lock and the licence text"
        );
    }
    if report.lock_written {
        println!("  ok   {LOCK_FILE} updated: commit it together with the licence text");
    }
    Ok(())
}

/// How the font relates to its `assets.lock` pin after a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pin {
    /// The local font already matched the lock: nothing was downloaded.
    Verified,
    /// Downloaded, and it matches the lock.
    Matched,
    /// First use: the lock entry was created from this download.
    Pinned,
    /// `--force` accepted a different file; `previous` is the sha256 it replaced.
    Repinned { previous: String },
    /// The download failed (`download_error`); the committed copy matches the lock and was used.
    Committed { download_error: String },
}

/// What [`fetch_archive_font`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontReport {
    pub pin: Pin,
    /// sha256 of the font now on disk (lowercase hex).
    pub sha256: String,
    pub bytes: u64,
    /// The font file was (re)written.
    pub font_written: bool,
    /// The licence text was (re)written.
    pub licence_written: bool,
    /// `assets.lock` was (re)written.
    pub lock_written: bool,
    /// The committed copy was (re)written (a run that pinned or re-pinned).
    pub committed_written: bool,
}

/// Brings `root/{font.file}` and `root/{font.licence_file}` in line with upstream and the pin in `lock_path`.
/// Every check runs before anything is written, so a failed run leaves the tree as it was.
pub fn fetch_archive_font(
    runtime: &tokio::runtime::Runtime,
    client: &reqwest::Client,
    retry: net::Retry,
    font: &ArchiveFont<'_>,
    root: &Path,
    lock_path: &Path,
    force: bool,
) -> anyhow::Result<FontReport> {
    let mut lock = AssetsLock::read(lock_path)?;
    let pinned = lock.get(font.file).cloned();
    let font_path = rel_path(root, font.file);
    let licence_path = rel_path(root, font.licence_file);
    let local = read_optional(&font_path)?;

    // Offline path: the font on disk is the pinned one.
    if !force
        && let (Some(entry), Some(bytes)) = (&pinned, &local)
        && byte_len(bytes) == font.bytes
        && sha256_hex(bytes) == entry.sha256
    {
        let licence_written =
            write_if_changed(&licence_path, licence_text(font, bytes)?.as_bytes())?;
        return Ok(FontReport {
            pin: Pin::Verified,
            sha256: entry.sha256.clone(),
            bytes: font.bytes,
            font_written: false,
            licence_written,
            lock_written: false,
            committed_written: false,
        });
    }

    let download = runtime
        .block_on(net::get(client, font.url, MAX_ARCHIVE_BYTES, retry))
        .with_context(|| format!("download {}", font.url));
    let (ttf, pin) = match download {
        Ok(archive) => {
            let ttf = downloaded_font(font, &archive)?;
            let sha256 = sha256_hex(&ttf);
            let pin = match pinned {
                None => Pin::Pinned,
                Some(entry) if entry.sha256 == sha256 => Pin::Matched,
                Some(entry) if force => Pin::Repinned {
                    previous: entry.sha256,
                },
                Some(entry) => bail!(
                    "{} has sha256 {sha256}, but {} pins {}. The upstream font changed: review it, then run \
                     `cargo xtask fetch-assets --force` to pin the new file. Nothing was written",
                    font.entry,
                    lock_path.display(),
                    entry.sha256
                ),
            };
            (ttf, pin)
        }
        Err(error) => {
            let download_error = format!("{error:#}");
            let ttf = committed_copy(font, root, pinned.as_ref(), force, error)?;
            (ttf, Pin::Committed { download_error })
        }
    };
    let sha256 = sha256_hex(&ttf);
    // The EULA must be readable before the font is shipped.
    let licence = licence_text(font, &ttf)?;

    let font_written = write_if_changed(&font_path, &ttf)?;
    let licence_written = write_if_changed(&licence_path, licence.as_bytes())?;
    lock.set(LockedAsset {
        file: font.file.to_owned(),
        source: font.url.to_owned(),
        bytes: font.bytes,
        sha256: sha256.clone(),
    });
    let lock_written = write_if_changed(lock_path, lock.render()?.as_bytes())?;
    // A new pin is a new committed copy: the fallback must always match the lock.
    let committed_written = match (&pin, font.committed) {
        (Pin::Pinned | Pin::Repinned { .. }, Some(committed)) => {
            write_if_changed(&rel_path(root, committed), &ttf)?
        }
        _ => false,
    };
    Ok(FontReport {
        pin,
        sha256,
        bytes: font.bytes,
        font_written,
        licence_written,
        lock_written,
        committed_written,
    })
}

/// The font in a downloaded archive, after the exact-size checks that tell an upstream release apart.
fn downloaded_font(font: &ArchiveFont<'_>, archive: &[u8]) -> anyhow::Result<Vec<u8>> {
    ensure!(
        byte_len(archive) == font.archive_bytes,
        "{}: the archive is {} B, expected exactly {} B. Upstream published a new release: \
         review it before changing the expected sizes",
        font.url,
        group(byte_len(archive)),
        group(font.archive_bytes)
    );
    let ttf = extract_entry(archive, font.entry, font.bytes)
        .with_context(|| format!("extract {:?} from {}", font.entry, font.url))?;
    ensure!(
        byte_len(&ttf) == font.bytes,
        "{:?} is {} B, expected exactly {} B",
        font.entry,
        group(byte_len(&ttf)),
        group(font.bytes)
    );
    Ok(ttf)
}

/// The committed copy of `font`, for a run whose download failed with `download`: only with a pin and without
/// `--force` (the copy never pins or re-pins), and only when it is exactly the pinned file. Otherwise the download
/// error, with the reason the copy was not used.
fn committed_copy(
    font: &ArchiveFont<'_>,
    root: &Path,
    pinned: Option<&LockedAsset>,
    force: bool,
    download: anyhow::Error,
) -> anyhow::Result<Vec<u8>> {
    let Some(committed) = font.committed else {
        return Err(download);
    };
    if force {
        return Err(download.context(format!(
            "--force pins from upstream only, never from the committed copy {committed}"
        )));
    }
    let Some(entry) = pinned else {
        return Err(download.context(format!(
            "nothing is pinned yet, so the committed copy {committed} is not used"
        )));
    };
    let bytes = match read_optional(&rel_path(root, committed)) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return Err(download.context(format!("the committed copy {committed} is missing")));
        }
        Err(read) => {
            return Err(download.context(format!(
                "the committed copy {committed} cannot be read ({read:#})"
            )));
        }
    };
    let sha256 = sha256_hex(&bytes);
    if byte_len(&bytes) != font.bytes || sha256 != entry.sha256 {
        return Err(download.context(format!(
            "the committed copy {committed} ({} B, sha256 {sha256}) is not the pinned file ({} B, sha256 {})",
            group(byte_len(&bytes)),
            group(font.bytes),
            entry.sha256
        )));
    }
    Ok(bytes)
}

/// Reads the archive member whose file name (in any directory) is `name`; exactly one such member must exist.
/// Reading stops one byte after `expected_bytes`, so a hostile archive cannot inflate without bound.
pub fn extract_entry(archive: &[u8], name: &str, expected_bytes: u64) -> anyhow::Result<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).context("not a zip archive")?;
    let mut found = Vec::new();
    let mut listing = Vec::new();
    for index in 0..zip.len() {
        let member = zip
            .by_index_raw(index)
            .with_context(|| format!("read archive member {index}"))?;
        let member_name = member
            .name()
            .with_context(|| format!("archive member {index} has an undecodable name"))?
            .into_owned();
        if member.is_file() && member_name.rsplit(['/', '\\']).next() == Some(name) {
            found.push(index);
        }
        listing.push(member_name);
    }
    let index = match found.as_slice() {
        [index] => *index,
        [] => bail!(
            "the archive has no {name:?} (members: {})",
            listing.join(", ")
        ),
        _ => bail!("the archive has {} members named {name:?}", found.len()),
    };
    let member = zip
        .by_index(index)
        .with_context(|| format!("open {name:?}"))?;
    let capacity = usize::try_from(expected_bytes.min(MAX_ARCHIVE_BYTES)).unwrap_or(0);
    let mut out = Vec::with_capacity(capacity);
    member
        .take(expected_bytes.saturating_add(1))
        .read_to_end(&mut out)
        .with_context(|| format!("decompress {name:?}"))?;
    Ok(out)
}

// ---- licence text from the name table ---------------------------------------------------------------------------

/// The `name` table strings the licence file quotes (OpenType `name` IDs).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FontNames {
    /// ID 0.
    pub copyright: Option<String>,
    /// ID 4.
    pub full_name: Option<String>,
    /// ID 5.
    pub version: Option<String>,
    /// ID 13.
    pub licence: Option<String>,
    /// ID 14.
    pub licence_url: Option<String>,
}

/// Reads the [`FontNames`] of a TrueType/OpenType font. Per ID it prefers Windows Unicode BMP US English
/// (3, 1, 0x409), then any Windows Unicode language, then Unicode (platform 0), then Macintosh Roman.
pub fn font_names(font: &[u8]) -> anyhow::Result<FontNames> {
    let version = be_u32(font, 0).context("not a font: shorter than its header")?;
    ensure!(
        matches!(version, 0x0001_0000 | 0x7472_7565 | 0x4F54_544F),
        "not a TrueType/OpenType font (sfnt version {version:#010x})"
    );
    let tables = be_u16(font, 4).context("truncated font header")?;
    let mut name_table = None;
    for i in 0..usize::from(tables) {
        let record = 12 + 16 * i;
        let tag = font
            .get(record..record + 4)
            .context("truncated table directory")?;
        if tag == b"name" {
            let offset = be_u32(font, record + 8).context("truncated table directory")?;
            let length = be_u32(font, record + 12).context("truncated table directory")?;
            let start = usize::try_from(offset)?;
            let end = start
                .checked_add(usize::try_from(length)?)
                .context("name table overflows")?;
            name_table = Some(font.get(start..end).context("name table out of bounds")?);
        }
    }
    let table = name_table.context("the font has no name table")?;
    let count = be_u16(table, 2).context("truncated name table")?;
    let storage = usize::from(be_u16(table, 4).context("truncated name table")?);

    // (rank, platform, bytes) of the best record per wanted ID.
    let mut best: [Option<(u8, u16, &[u8])>; 5] = [None; 5];
    for i in 0..usize::from(count) {
        let record = 6 + 12 * i;
        let field = |at: usize| be_u16(table, record + at).context("truncated name record");
        let (platform, encoding, language, name_id) = (field(0)?, field(2)?, field(4)?, field(6)?);
        let (length, offset) = (usize::from(field(8)?), usize::from(field(10)?));
        let Some(slot) = [0u16, 4, 5, 13, 14].iter().position(|id| *id == name_id) else {
            continue;
        };
        let rank = match (platform, encoding, language) {
            (3, 1, 0x0409) => 0,
            (3, 1 | 10, _) => 1,
            (0, _, _) => 2,
            (1, 0, _) => 3,
            _ => continue,
        };
        let start = storage + offset;
        let bytes = table
            .get(start..start + length)
            .context("name string out of bounds")?;
        if let Some(cell) = best.get_mut(slot)
            && cell.is_none_or(|(r, _, _)| rank < r)
        {
            *cell = Some((rank, platform, bytes));
        }
    }
    let decode = |cell: Option<(u8, u16, &[u8])>| {
        cell.map(|(_, platform, bytes)| {
            if platform == 1 {
                // Macintosh Roman: ASCII is exact; the upper half is not needed for licence text.
                bytes
                    .iter()
                    .map(|b| {
                        if b.is_ascii() {
                            char::from(*b)
                        } else {
                            '\u{FFFD}'
                        }
                    })
                    .collect()
            } else {
                let units = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_be_bytes(*pair));
                char::decode_utf16(units)
                    .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
                    .collect::<String>()
            }
        })
    };
    let [copyright, full_name, version, licence, licence_url] = best;
    Ok(FontNames {
        copyright: decode(copyright),
        full_name: decode(full_name),
        version: decode(version),
        licence: decode(licence),
        licence_url: decode(licence_url),
    })
}

/// The committed licence file: a short provenance header, then the copyright notice (ID 0), the licence (ID 13)
/// and the licence URL (ID 14) exactly as the font carries them (only line endings and trailing spaces normalised).
/// Fails when the font carries no licence: it is never shipped without its EULA.
pub fn licence_text(font: &ArchiveFont<'_>, ttf: &[u8]) -> anyhow::Result<String> {
    let names = font_names(ttf)?;
    let licence = names.licence.as_deref().map(normalise_text).filter(|t| !t.is_empty()).with_context(|| {
        format!(
            "{} carries no licence description (name ID 13): refusing to ship it without its EULA",
            font.entry
        )
    })?;
    let copyright = names
        .copyright
        .as_deref()
        .map(normalise_text)
        .filter(|t| !t.is_empty());
    let licence_url = names
        .licence_url
        .as_deref()
        .map(normalise_text)
        .filter(|t| !t.is_empty());
    let mut ids = Vec::new();
    if copyright.is_some() {
        ids.push("0");
    }
    ids.push("13");
    if licence_url.is_some() {
        ids.push("14");
    }

    let detail: Vec<String> = [&names.full_name, &names.version]
        .into_iter()
        .flatten()
        .map(|s| normalise_text(s))
        .filter(|s| !s.is_empty())
        .collect();
    let file_name = font.file.rsplit('/').next().unwrap_or(font.file);
    let mut out = String::new();
    if detail.is_empty() {
        let _ = writeln!(out, "{}", font.name);
    } else {
        let _ = writeln!(out, "{} ({})", font.name, detail.join(", "));
    }
    let _ = writeln!(out, "Source: {}", font.url);
    let _ = writeln!(
        out,
        "File: {file_name} ({} B, sha256 {}), shipped unmodified.",
        group(byte_len(ttf)),
        sha256_hex(ttf)
    );
    let _ = writeln!(
        out,
        "The licence below is reproduced verbatim from the font's name table (ID{} {}).",
        if ids.len() > 1 { "s" } else { "" },
        join_and(&ids)
    );
    let _ = writeln!(out, "Generated by `cargo xtask fetch-assets`; do not edit.");
    for part in [
        copyright,
        Some(licence),
        licence_url.map(|u| format!("Licence URL: {u}")),
    ]
    .into_iter()
    .flatten()
    {
        out.push('\n');
        out.push_str(&part);
        out.push('\n');
    }
    Ok(out)
}

/// `a`, `a and b`, `a, b and c`.
fn join_and(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// CR LF and lone CR → LF, trailing whitespace removed from every line and from the end.
fn normalise_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned()
}

fn be_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let pair: [u8; 2] = bytes.get(at..at.checked_add(2)?)?.try_into().ok()?;
    Some(u16::from_be_bytes(pair))
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let quad: [u8; 4] = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_be_bytes(quad))
}

// ---- assets.lock ------------------------------------------------------------------------------------------------

const LOCK_HEADER: &str = "\
# sha256 pins of the third-party assets fetched by `cargo xtask fetch-assets`.
# Recorded on first use and checked on every later run; after reviewing an upstream change, re-pin with
# `cargo xtask fetch-assets --force`. CI caches public/fonts/ keyed by the hash of this file.
# Generated: do not edit by hand.
";

/// `xtask/assets.lock`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetsLock {
    #[serde(default, rename = "asset")]
    pub assets: Vec<LockedAsset>,
}

/// One pinned file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockedAsset {
    /// Path relative to the repository root, `/`-separated.
    pub file: String,
    /// Where it comes from.
    pub source: String,
    pub bytes: u64,
    /// Lowercase hex.
    pub sha256: String,
}

impl AssetsLock {
    /// Reads the lock; a missing file is an empty lock (first use).
    pub fn read(path: &Path) -> anyhow::Result<Self> {
        let Some(bytes) = read_optional(path)? else {
            return Ok(Self::default());
        };
        let text =
            String::from_utf8(bytes).with_context(|| format!("{} is not UTF-8", path.display()))?;
        Self::parse(&text).with_context(|| format!("parse {}", path.display()))
    }

    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let lock: Self = toml::from_str(text)?;
        for asset in &lock.assets {
            ensure!(
                is_sha256_hex(&asset.sha256),
                "{}: sha256 {:?} is not 64 lowercase hex digits",
                asset.file,
                asset.sha256
            );
        }
        let mut files: Vec<&str> = lock.assets.iter().map(|a| a.file.as_str()).collect();
        files.sort_unstable();
        ensure!(
            files.windows(2).all(|w| w.first() != w.get(1)),
            "a file is pinned twice"
        );
        Ok(lock)
    }

    #[must_use]
    pub fn get(&self, file: &str) -> Option<&LockedAsset> {
        self.assets.iter().find(|a| a.file == file)
    }

    /// Inserts or replaces the entry for `asset.file`; entries stay sorted by file.
    pub fn set(&mut self, asset: LockedAsset) {
        self.assets.retain(|a| a.file != asset.file);
        self.assets.push(asset);
        self.assets.sort_by(|a, b| a.file.cmp(&b.file));
    }

    /// The file's text: the header comment, then one `[[asset]]` table per pin.
    pub fn render(&self) -> anyhow::Result<String> {
        Ok(format!(
            "{LOCK_HEADER}\n{}",
            toml::to_string(self).context("serialise assets.lock")?
        ))
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ---- shared file helpers ----------------------------------------------------------------------------------------

/// `root` joined with a `/`-separated relative path, with native separators.
#[must_use]
pub fn rel_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Lowercase hex sha256.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `bytes.len()` as `u64`.
#[must_use]
pub fn byte_len(bytes: &[u8]) -> u64 {
    u64::try_from(bytes.len()).unwrap_or(u64::MAX)
}

/// `1234567` → `1,234,567`.
#[must_use]
pub fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// The file's bytes, or `None` when it does not exist.
pub fn read_optional(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// Writes through a temporary sibling and a rename, so readers (the dev server, a concurrent build) never see a
/// partial file. Creates the parent directories.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let name = path
        .file_name()
        .with_context(|| format!("{} has no file name", path.display()))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp = dir.join(tmp_name);
    let result = std::fs::write(&tmp, bytes)
        .with_context(|| format!("write {}", tmp.display()))
        .and_then(|()| {
            std::fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// [`write_atomic`] unless the file already holds exactly `bytes`; returns whether it wrote.
pub fn write_if_changed(path: &Path, bytes: &[u8]) -> anyhow::Result<bool> {
    if read_optional(path)?.as_deref() == Some(bytes) {
        return Ok(false);
    }
    write_atomic(path, bytes)?;
    Ok(true)
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------

/// The HTTP side of `fetch-assets` and `fetch-dev-packs`: one `reqwest` client on a local current-thread runtime,
/// bounded retries with back-off, identity transfer encoding (so `Content-Length` is the file's size), a hard size
/// cap and truncation detection.
pub mod net {
    use std::time::Duration;

    use anyhow::{Context, anyhow};
    use reqwest::header::ACCEPT_ENCODING;
    use reqwest::{Client, StatusCode};

    /// `QuranForDesktop-xtask/<version>`, plus the task in parentheses.
    pub const USER_AGENT: &str = concat!("QuranForDesktop-xtask/", env!("CARGO_PKG_VERSION"));

    /// Retry policy for one URL: `attempts` tries in all, waiting `first_delay`, then 4× longer each time.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Retry {
        pub attempts: u32,
        pub first_delay: Duration,
    }

    impl Retry {
        /// 3 attempts, 0.5 s and 2 s apart.
        pub const DEFAULT: Self = Self {
            attempts: 3,
            first_delay: Duration::from_millis(500),
        };
    }

    /// A current-thread runtime for the async client (xtask is otherwise synchronous).
    pub fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("start the tokio runtime")
    }

    /// The client: `User-Agent: QuranForDesktop-xtask/<version> (<task>)`, 15 s connect and 120 s total timeouts,
    /// system proxy settings (the workspace reqwest features).
    pub fn client(task: &str) -> anyhow::Result<Client> {
        Client::builder()
            .user_agent(format!("{USER_AGENT} ({task})"))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .context("build the HTTP client")
    }

    /// One failed attempt.
    struct Failure {
        message: String,
        /// Worth another attempt (transport errors, truncation, 408/425/429/5xx).
        retryable: bool,
    }

    /// `GET url` → the body (status 200 only). Transient failures are retried per `retry`; a 4xx other than
    /// 408/425/429 fails at once. Bodies over `max_bytes` and bodies shorter than their `Content-Length` are errors.
    pub async fn get(
        client: &Client,
        url: &str,
        max_bytes: u64,
        retry: Retry,
    ) -> anyhow::Result<Vec<u8>> {
        let attempts = retry.attempts.max(1);
        let mut delay = retry.first_delay;
        let mut attempt = 1;
        loop {
            match get_once(client, url, max_bytes).await {
                Ok(body) => return Ok(body),
                Err(failure) if failure.retryable && attempt < attempts => {
                    tokio::time::sleep(delay).await;
                    delay = delay.saturating_mul(4);
                    attempt += 1;
                }
                Err(failure) => {
                    return Err(anyhow!(
                        "GET {url}: {}{}",
                        failure.message,
                        if attempt > 1 {
                            format!(" (after {attempt} attempts)")
                        } else {
                            String::new()
                        }
                    ));
                }
            }
        }
    }

    async fn get_once(client: &Client, url: &str, max_bytes: u64) -> Result<Vec<u8>, Failure> {
        let transport = |e: reqwest::Error| Failure {
            message: error_chain(&e),
            retryable: true,
        };
        let mut response = client
            .get(url)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(transport)?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(Failure {
                message: format!("HTTP {status}"),
                retryable: matches!(status.as_u16(), 408 | 425 | 429) || status.is_server_error(),
            });
        }
        let expected = response.content_length();
        if let Some(length) = expected
            && length > max_bytes
        {
            return Err(Failure {
                message: format!("{length} B is over the {max_bytes} B limit"),
                retryable: false,
            });
        }
        let mut body =
            Vec::with_capacity(usize::try_from(expected.unwrap_or(0).min(max_bytes)).unwrap_or(0));
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            body.extend_from_slice(&chunk);
            if super::byte_len(&body) > max_bytes {
                return Err(Failure {
                    message: format!("the body is over the {max_bytes} B limit"),
                    retryable: false,
                });
            }
        }
        if let Some(length) = expected
            && super::byte_len(&body) != length
        {
            return Err(Failure {
                message: format!("truncated body: {} of {length} B", super::byte_len(&body)),
                retryable: true,
            });
        }
        Ok(body)
    }

    /// `error: cause: cause`, without repeating a cause the outer message already contains.
    fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
        let mut message = error.to_string();
        let mut source = error.source();
        while let Some(cause) = source {
            let text = cause.to_string();
            if !message.contains(&text) {
                message.push_str(": ");
                message.push_str(&text);
            }
            source = cause.source();
        }
        message
    }
}
