//! The `qul` adapter (release-grade): the QUL exports a human placed under `data/sources/qul/` → the adapter-neutral
//! [`SourceQuran`].
//!
//! [`load`] is the `build-core --source qul` entry point: it verifies `manifest.toml` and every file's SHA-256, reads the
//! inputs and prints a short report. [`read`] does the same without printing.
//!
//! | Manifest key | QUL resource | Read as |
//! |---|---|---|
//! | `layout.v2`, `layout.v1`, `layout.v4` | mushaf-layout 10, 15, 19 | SQLite `pages` (+ `info`, + `words` if present) |
//! | `script.code_v2`, `script.code_v1` | quran-script 61, 57 | QCF glyph codes (SQLite `words`, or JSON) |
//! | `script.text_hafs` | quran-script 312 | QPC Hafs text |
//! | `script.imlaei` | quran-script 54 | Imla'i with diacritics, the search seed (not 60, Imla'i simple) |
//! | `meta.surah` | quran-metadata 70 | names, revelation place/order, ayah counts, `bismillah_pre` (JSON or SQLite) |
//! | `meta.rub` | quran-metadata 63 | per-ayah rub el hizb, stored (67 is QUL's *hizb* file) |
//! | `meta.juz`, `meta.hizb`, `meta.manzil` | quran-metadata 68, 67, 66 | optional: cross-check of Tanzil's values |
//! | `tanzil` | — | Tanzil `quran-data.xml`, returned to the shared pipeline |
//!
//! Reading rules:
//! - **Manifest.** Before anything is parsed, every file must exist and match its recorded SHA-256 (64 hex digits, any
//!   case), and every `resource` must be the expected QUL id. All problems are reported at once, each with the file's
//!   actual hash, so the human who placed the files can check and record them.
//! - **Scripts.** `words(id|word_index, location|word_key, surah, ayah, word?, text)` (both column-name variants; a
//!   `word_key` of the form `s:a` is completed with `word`), or QUL's JSON exports (records keyed by location, or by
//!   ayah with a `words` array). `surah`/`ayah`/`word` must agree with the location.
//! - **Canonical words.** The four scripts must have identical location sets; sorted by (s, a, w) they are the canonical
//!   word sequence, which must hold exactly 83,665 locations. Any other count fails the build and lists the locations
//!   that look extra (unparsable, outside an ayah, after the ayah's end marker, …) for a human decision. The
//!   last word of every ayah is its end marker.
//! - **QUL ids.** A layout's `first_word_id`/`last_word_id` are QUL `word_index` values. They are mapped to locations
//!   through the layout DB's own `words` table when it has one, else through script 61, whose `word_index` order must
//!   equal location order. A line holds the locations of every id in its range; ids that name no word (such as QUL's
//!   extra slots) are skipped. Raw ids are never compared with canonical ids.
//! - **Layouts.** `pages(page_number, line_number, line_type, is_centered, first_word_id, last_word_id, surah_number)`,
//!   with `''` read as NULL. Every page has exactly lines 1..=15 (1..=8 on pages 1–2). `line_type` maps to kind 0/1/2;
//!   a `basmallah` line takes the surah of the next ayah line in reading order. `derive.rs` checks the kinds against
//!   the header placement and the centring rules.
//! - **Divisions.** One record per division with `first_verse_key`/`last_verse_key` (plus `verses_count` and
//!   `verse_mapping`, which must agree with the range); the ranges must cover every ayah once, in order.
//! - **38:24:32–33** is regrouped by `derive.rs`, for every source.
//!
//! `meta.source_manifest_sha256` is the SHA-256 of the canonical manifest text: one line `"<sha256>  <key>  <file>\n"`
//! per input in [`Input::ALL`] order. Comments, formatting and line endings of `manifest.toml` don't change it, while
//! every input byte does.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, anyhow, bail, ensure};
use quran_types::MushafLayout;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::derive::{END_OF_AYAH, arabic_indic};
use super::model::{
    AYAH_COUNT, AyahKey, LINES_PER_PAGE, Layout, LineKind, Location, MUSHAFS, PAGE_COUNT, Page,
    RawLine, RevelationPlace, SURAH_COUNT, SourceAyah, SourceDivisions, SourceInfo, SourceQuran,
    SourceSurah, SourceWord, WORD_COUNT, WordKind, lines_on_page, mushaf_spec,
};
use super::tanzil::{self, HIZB_COUNT, JUZ_COUNT, MANZIL_COUNT, QUARTER_COUNT, Tanzil};

/// The manifest inside the QUL directory.
pub const MANIFEST_FILE: &str = "manifest.toml";
/// The first 16 bytes of every SQLite 3 database file.
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";
/// How many items an error message lists before "… and N more".
const LIST_LIMIT: usize = 12;
/// Tables that may hold QUL's surah metadata in its SQLite export.
const SURAH_TABLES: &[&str] = &["chapters", "surahs", "surah"];
/// The `pages` columns of a QUL layout export, in the order they are read.
const LAYOUT_COLUMNS: [&str; 7] = [
    "page_number",
    "line_number",
    "line_type",
    "is_centered",
    "first_word_id",
    "last_word_id",
    "surah_number",
];

// ---- inputs and the manifest ----------------------------------------------------------------------------------------

/// One input of `manifest.toml`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Input {
    LayoutV2,
    LayoutV1,
    LayoutV4,
    CodeV2,
    CodeV1,
    TextHafs,
    Imlaei,
    Surahs,
    Rub,
    Juz,
    Hizb,
    Manzil,
    Tanzil,
}

impl Input {
    /// Every input, in manifest (and declaration) order.
    #[allow(
        dead_code,
        reason = "the manifest's order is its BTreeMap order; the tests check that this list matches it"
    )]
    pub const ALL: [Self; 13] = [
        Self::LayoutV2,
        Self::LayoutV1,
        Self::LayoutV4,
        Self::CodeV2,
        Self::CodeV1,
        Self::TextHafs,
        Self::Imlaei,
        Self::Surahs,
        Self::Rub,
        Self::Juz,
        Self::Hizb,
        Self::Manzil,
        Self::Tanzil,
    ];
    /// The layouts, in `mushaf.id` order (v2, v1, v4).
    pub const LAYOUTS: [Self; 3] = [Self::LayoutV2, Self::LayoutV1, Self::LayoutV4];
    /// The word scripts; script 61 first, since it is the reference set and maps the layouts' QUL ids.
    pub const SCRIPTS: [Self; 4] = [Self::CodeV2, Self::CodeV1, Self::TextHafs, Self::Imlaei];

    /// The dotted manifest key.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::LayoutV2 => "layout.v2",
            Self::LayoutV1 => "layout.v1",
            Self::LayoutV4 => "layout.v4",
            Self::CodeV2 => "script.code_v2",
            Self::CodeV1 => "script.code_v1",
            Self::TextHafs => "script.text_hafs",
            Self::Imlaei => "script.imlaei",
            Self::Surahs => "meta.surah",
            Self::Rub => "meta.rub",
            Self::Juz => "meta.juz",
            Self::Hizb => "meta.hizb",
            Self::Manzil => "meta.manzil",
            Self::Tanzil => "tanzil",
        }
    }

    /// The QUL resource id the manifest must name (`None`: not a QUL resource).
    #[must_use]
    pub const fn resource(self) -> Option<u32> {
        match self {
            Self::LayoutV2 => Some(10),
            Self::LayoutV1 => Some(15),
            Self::LayoutV4 => Some(19),
            Self::CodeV2 => Some(61),
            Self::CodeV1 => Some(57),
            Self::TextHafs => Some(312),
            Self::Imlaei => Some(54),
            Self::Surahs => Some(70),
            Self::Rub => Some(63),
            Self::Juz => Some(68),
            Self::Hizb => Some(67),
            Self::Manzil => Some(66),
            Self::Tanzil => None,
        }
    }

    /// The resource's title on qul.tarteel.ai (Tanzil: the file).
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::LayoutV2 => "KFGQPC V2 layout (1421H print)",
            Self::LayoutV1 => "KFGQPC V1 layout (1405H print)",
            Self::LayoutV4 => "KFGQPC V4 layout (1441H print)",
            Self::CodeV2 => "QPC V2 Glyph - Word by Word",
            Self::CodeV1 => "QPC V1 Glyphs - Word by Word",
            Self::TextHafs => "KFGQPC Hafs script - Word by word",
            Self::Imlaei => "Imlaei script - Word by Word",
            Self::Surahs => "Surah names",
            Self::Rub => "Rub",
            Self::Juz => "Juz",
            Self::Hizb => "Hizb",
            Self::Manzil => "Manzil",
            Self::Tanzil => "Tanzil quran-data.xml",
        }
    }

    /// The three cross-check inputs are optional; everything else is required.
    #[must_use]
    pub const fn required(self) -> bool {
        !matches!(self, Self::Juz | Self::Hizb | Self::Manzil)
    }

    /// The page to download the input from.
    #[must_use]
    pub fn url(self) -> String {
        let kind = match self {
            Self::LayoutV2 | Self::LayoutV1 | Self::LayoutV4 => "mushaf-layout",
            Self::CodeV2 | Self::CodeV1 | Self::TextHafs | Self::Imlaei => "quran-script",
            Self::Surahs | Self::Rub | Self::Juz | Self::Hizb | Self::Manzil => "quran-metadata",
            Self::Tanzil => "",
        };
        match self.resource() {
            Some(id) => format!("https://qul.tarteel.ai/resources/{kind}/{id}"),
            None => tanzil::URL.to_owned(),
        }
    }

    /// The download format the reader expects.
    #[must_use]
    pub const fn formats(self) -> &'static str {
        match self {
            Self::LayoutV2 | Self::LayoutV1 | Self::LayoutV4 => "SQLite",
            Self::CodeV2 | Self::CodeV1 | Self::TextHafs | Self::Imlaei => "SQLite (or JSON)",
            Self::Surahs | Self::Rub | Self::Juz | Self::Hizb | Self::Manzil => "JSON or SQLite",
            Self::Tanzil => "XML",
        }
    }

    /// The layout this input describes.
    #[must_use]
    pub const fn layout(self) -> Option<MushafLayout> {
        match self {
            Self::LayoutV2 => Some(MushafLayout::V2),
            Self::LayoutV1 => Some(MushafLayout::V1),
            Self::LayoutV4 => Some(MushafLayout::V4),
            _ => None,
        }
    }

    /// Why a resource id is wrong, for the ids a human is likely to confuse.
    const fn wrong_resource_hint(self, found: u32) -> &'static str {
        match (self, found) {
            (Self::Imlaei, 60) => {
                "; 60 is \"Imlaei simple\", which writes the dagger alef as a full alef and pre-folds hamza seats \
                 (الرحمان, ذالك, يومنون), so the everyday spellings never match in search"
            }
            (Self::Rub, 67) => {
                "; 67 is QUL's Hizb metadata (60 hizbs), the 240 rub el hizb quarters are resource 63"
            }
            (Self::Hizb, 63) => {
                "; 63 is QUL's Rub metadata (240 quarters), the 60 hizbs are resource 67"
            }
            _ => "",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestToml {
    layout: LayoutsToml,
    script: ScriptsToml,
    meta: MetaToml,
    tanzil: EntryToml,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LayoutsToml {
    v2: EntryToml,
    v1: EntryToml,
    v4: EntryToml,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScriptsToml {
    code_v2: EntryToml,
    code_v1: EntryToml,
    text_hafs: EntryToml,
    imlaei: EntryToml,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetaToml {
    surah: EntryToml,
    rub: EntryToml,
    juz: Option<EntryToml>,
    hizb: Option<EntryToml>,
    manzil: Option<EntryToml>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryToml {
    file: String,
    resource: Option<u32>,
    sha256: String,
}

/// One input as `manifest.toml` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestEntry {
    pub input: Input,
    /// Relative to the QUL directory, `/`-separated.
    pub file: String,
    pub resource: Option<u32>,
    /// As written: 64 hex digits, or empty while not recorded yet.
    pub sha256: String,
}

/// `data/sources/qul/manifest.toml`: the inputs, in [`Input::ALL`] order (absent optional inputs left out).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    entries: Vec<ManifestEntry>,
}

impl Manifest {
    /// Parses the TOML and its shape (known keys only, every required input present). Values are checked by
    /// [`Manifest::problems`] and against the files by [`verify_inputs`].
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let ManifestToml {
            layout,
            script,
            meta,
            tanzil,
        } = toml::from_str(text).context("parse the QUL manifest (TOML)")?;
        let entries = [
            (Input::LayoutV2, Some(layout.v2)),
            (Input::LayoutV1, Some(layout.v1)),
            (Input::LayoutV4, Some(layout.v4)),
            (Input::CodeV2, Some(script.code_v2)),
            (Input::CodeV1, Some(script.code_v1)),
            (Input::TextHafs, Some(script.text_hafs)),
            (Input::Imlaei, Some(script.imlaei)),
            (Input::Surahs, Some(meta.surah)),
            (Input::Rub, Some(meta.rub)),
            (Input::Juz, meta.juz),
            (Input::Hizb, meta.hizb),
            (Input::Manzil, meta.manzil),
            (Input::Tanzil, Some(tanzil)),
        ]
        .into_iter()
        .filter_map(|(input, entry)| {
            entry.map(|e| ManifestEntry {
                input,
                file: e.file,
                resource: e.resource,
                sha256: e.sha256,
            })
        })
        .collect();
        Ok(Self { entries })
    }

    #[must_use]
    pub fn entries(&self) -> &[ManifestEntry] {
        &self.entries
    }

    #[allow(dead_code, reason = "read by the qul_adapter tests")]
    #[must_use]
    pub fn get(&self, input: Input) -> Option<&ManifestEntry> {
        self.entries.iter().find(|e| e.input == input)
    }

    /// Problems with the manifest's values, independent of the files: file names that leave the directory or repeat,
    /// wrong or missing resource ids, and `sha256` values that are neither empty nor 64 hex digits. Empty = valid.
    #[must_use]
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let mut files: BTreeMap<String, &str> = BTreeMap::new();
        for entry in &self.entries {
            let key = entry.input.key();
            if let Err(why) = check_relative_file(&entry.file) {
                problems.push(format!("{key}: file {:?} {why}", entry.file));
            }
            // Case-insensitive: two names that differ only in case are one file on Windows and macOS.
            if let Some(other) = files.insert(entry.file.to_lowercase(), key) {
                problems.push(format!("{key}: file {:?} is also {other}'s", entry.file));
            }
            match (entry.input.resource(), entry.resource) {
                (Some(expected), Some(found)) if found == expected => {}
                (Some(expected), Some(found)) => problems.push(format!(
                    "{key}: resource {found}, expected {expected} (\"{}\", {}){}",
                    entry.input.title(),
                    entry.input.url(),
                    entry.input.wrong_resource_hint(found)
                )),
                (Some(expected), None) => problems.push(format!(
                    "{key}: no resource id, expected {expected} (\"{}\", {})",
                    entry.input.title(),
                    entry.input.url()
                )),
                (None, Some(found)) => problems.push(format!(
                    "{key}: resource {found}, but this input is not a QUL resource (remove the field)"
                )),
                (None, None) => {}
            }
            if matches!(recorded_hash(&entry.sha256), Recorded::Invalid) {
                problems.push(format!(
                    "{key}: sha256 {:?} is neither 64 hex digits nor empty (= not recorded yet)",
                    entry.sha256
                ));
            }
        }
        problems
    }
}

/// A manifest `sha256` value.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Recorded {
    /// Empty: the human has not recorded the file's hash yet.
    NotYet,
    /// Lowercase hex.
    Hash(String),
    Invalid,
}

fn recorded_hash(value: &str) -> Recorded {
    if value.is_empty() {
        Recorded::NotYet
    } else if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Recorded::Hash(value.to_ascii_lowercase())
    } else {
        Recorded::Invalid
    }
}

/// A manifest file name must stay inside the QUL directory: relative, `/`-separated, no `.`/`..`.
fn check_relative_file(file: &str) -> Result<(), &'static str> {
    if file.is_empty() {
        return Err("is empty");
    }
    if file.contains('\\') {
        return Err("contains `\\`: separate directories with `/`");
    }
    // `:` too: only Windows parses `C:/x.db` as a drive, and the manifest is checked on every OS.
    if file.split('/').any(str::is_empty)
        || file.contains(':')
        || !Path::new(file)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(
            "must be a relative path inside the QUL directory (no root, drive, `.` or `..`)",
        );
    }
    Ok(())
}

/// One input file whose bytes matched the manifest's SHA-256.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputFile {
    pub input: Input,
    /// As the manifest names it.
    pub file: String,
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    /// Lowercase hex.
    pub sha256: String,
    pub resource: Option<u32>,
}

impl InputFile {
    fn context(&self) -> String {
        format!("{} ({})", self.input.key(), self.path.display())
    }
}

/// The verified inputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inputs {
    files: BTreeMap<Input, InputFile>,
}

impl Inputs {
    pub fn get(&self, input: Input) -> anyhow::Result<&InputFile> {
        self.files
            .get(&input)
            .ok_or_else(|| anyhow!("{} is not in the manifest", input.key()))
    }

    #[must_use]
    pub fn optional(&self, input: Input) -> Option<&InputFile> {
        self.files.get(&input)
    }

    pub fn files(&self) -> impl Iterator<Item = &InputFile> {
        self.files.values()
    }

    /// `meta.source_manifest_sha256` (see the module docs).
    #[must_use]
    pub fn manifest_sha256(&self) -> String {
        let text: String = self
            .files
            .values()
            .map(|f| format!("{}  {}  {}\n", f.sha256, f.input.key(), f.file))
            .collect();
        hex::encode(Sha256::digest(text.as_bytes()))
    }
}

/// Reads every input the manifest lists under `dir` and checks it against the manifest. Every problem (manifest values,
/// missing files, unrecorded or different hashes) is reported in one error, with each file's actual SHA-256.
pub fn verify_inputs(dir: &Path, manifest: &Manifest) -> anyhow::Result<Inputs> {
    let mut problems = manifest.problems();
    let readable: Vec<&ManifestEntry> = manifest
        .entries()
        .iter()
        .filter(|e| check_relative_file(&e.file).is_ok())
        .collect();
    let read = in_parallel("hash", &readable, |entry| read_input(dir, entry))?;
    let mut files = BTreeMap::new();
    for (entry, result) in readable.into_iter().zip(read) {
        let key = entry.input.key();
        let file = match result {
            Ok(file) => file,
            Err(problem) => {
                problems.push(format!("{key}: {problem}"));
                continue;
            }
        };
        match recorded_hash(&entry.sha256) {
            Recorded::Hash(hash) if hash == file.sha256 => {
                files.insert(entry.input, file);
            }
            Recorded::Hash(hash) => problems.push(format!(
                "{key}: {} has sha256 {}, but the manifest records {hash} (if the file was replaced on purpose, check \
                 that it is QUL's \"{}\" and record the new hash)",
                entry.file,
                file.sha256,
                entry.input.title()
            )),
            Recorded::NotYet => problems.push(format!(
                "{key}: sha256 not recorded yet; {} has sha256 {} (check that it is \"{}\" from {}, then record it)",
                entry.file,
                file.sha256,
                entry.input.title(),
                entry.input.url()
            )),
            Recorded::Invalid => problems.push(format!(
                "{key}: {} has sha256 {}",
                entry.file, file.sha256
            )),
        }
    }
    if !problems.is_empty() {
        bail!(
            "{}: {} problem(s) with the QUL inputs:\n  - {}",
            dir.join(MANIFEST_FILE).display(),
            problems.len(),
            problems.join("\n  - ")
        );
    }
    Ok(Inputs { files })
}

fn read_input(dir: &Path, entry: &ManifestEntry) -> Result<InputFile, String> {
    let path = entry
        .file
        .split('/')
        .fold(dir.to_path_buf(), |path, part| path.join(part));
    match std::fs::read(&path) {
        Ok(bytes) => Ok(InputFile {
            input: entry.input,
            file: entry.file.clone(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            path,
            bytes,
            resource: entry.resource,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "{} is missing: download \"{}\" ({}) from {}{}",
            path.display(),
            entry.input.title(),
            entry.input.formats(),
            entry.input.url(),
            if entry.input.required() {
                ""
            } else {
                ", or remove this optional entry"
            }
        )),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

// ---- the adapter ----------------------------------------------------------------------------------------------------

/// What [`read`] produces.
#[derive(Clone, Debug)]
pub struct QulLoad {
    pub source: SourceQuran,
    /// The verified Tanzil metadata file, for the shared pipeline.
    pub tanzil: PathBuf,
    pub report: QulReport,
}

/// `build-core --source qul`: reads `qul_dir` (normally `data/sources/qul`) and prints the [`QulReport`]. Returns the
/// source model and the Tanzil `quran-data.xml` path for the shared pipeline.
pub fn load(qul_dir: &Path) -> anyhow::Result<(SourceQuran, PathBuf)> {
    let started = Instant::now();
    let loaded = read(qul_dir)?;
    for line in loaded.report.lines() {
        eprintln!("build-core: qul: {line}");
    }
    eprintln!(
        "build-core: qul: read {} [{:.1} s]",
        qul_dir.display(),
        started.elapsed().as_secs_f64()
    );
    Ok((loaded.source, loaded.tanzil))
}

/// Verifies and reads every input (see the module docs).
pub fn read(qul_dir: &Path) -> anyhow::Result<QulLoad> {
    let manifest_path = qul_dir.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest_path).with_context(|| {
        format!(
            "read {} (--source qul reads the QUL exports it lists)",
            manifest_path.display()
        )
    })?;
    let manifest =
        Manifest::parse(&text).with_context(|| format!("{}", manifest_path.display()))?;
    let inputs = verify_inputs(qul_dir, &manifest)?;

    let tanzil_file = inputs.get(Input::Tanzil)?;
    Tanzil::parse(&tanzil_file.bytes).with_context(|| tanzil_file.context())?;

    let surah_file = inputs.get(Input::Surahs)?;
    let surahs = read_records(&surah_file.path, &surah_file.bytes, SURAH_TABLES)
        .and_then(|records| parse_surahs(&records, SURAH_COUNT))
        .with_context(|| surah_file.context())?;
    let ayahs = ayah_keys(&surahs);
    ensure!(
        ayahs.len() == AYAH_COUNT as usize,
        "{}: the verses_count values add up to {} ayahs, expected {AYAH_COUNT}",
        surah_file.context(),
        ayahs.len()
    );

    let (scripts, layout_files) = read_scripts_and_layouts(&inputs)?;
    let words = canonical_words(&scripts, &surahs, WORD_COUNT as usize)?;
    let script_ids = script_word_ids(&scripts, &words)?;
    let (layouts, layout_sources) =
        assemble_layouts(&inputs, &layout_files, &words, script_ids.as_ref())?;
    let source_ayahs = source_ayahs(&inputs, &ayahs)?;

    let report = QulReport {
        inputs: describe_inputs(&inputs, &scripts, &layout_sources),
        manifest_sha256: inputs.manifest_sha256(),
        words: words.len(),
        word_index_max: script_ids.as_ref().map(WordIds::max),
        unused_word_indexes: script_ids
            .as_ref()
            .map(|ids| ids.unused().collect())
            .unwrap_or_default(),
        id_disagreements: script_ids
            .as_ref()
            .map(|ids| {
                scripts
                    .iter()
                    .filter(|s| s.input != Input::CodeV2 && s.rows.iter().any(|r| r.id.is_some()))
                    .map(|s| (s.input, ids.disagreements(&s.rows)))
                    .collect()
            })
            .unwrap_or_default(),
        layouts: layout_sources,
        cross_checks: [Input::Juz, Input::Hizb, Input::Manzil]
            .into_iter()
            .filter(|i| inputs.optional(*i).is_some())
            .collect(),
    };
    let source = SourceQuran {
        info: SourceInfo {
            source: "qul",
            manifest_sha256: report.manifest_sha256.clone(),
            licence_note: licence_note(&inputs),
        },
        surahs,
        ayahs: source_ayahs,
        words,
        layouts,
    };
    Ok(QulLoad {
        source,
        tanzil: tanzil_file.path.clone(),
        report,
    })
}

/// `meta.licence_note` of a qul build: the QUL resources actually used, their origin, the permission note, and the
/// Tanzil attribution (CC BY 3.0).
#[must_use]
pub fn licence_note(inputs: &Inputs) -> String {
    let ids = |group: &[Input]| {
        group
            .iter()
            .filter(|i| inputs.optional(**i).is_some())
            .filter_map(|i| i.resource())
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "Quran text, glyph codes, page layouts and surah names: Quranic Universal Library (QUL, qul.tarteel.ai) mushaf \
         layouts {}, word scripts {} and metadata {}; the Mushaf data originates from the King Fahd Glorious Qur'an \
         Printing Complex (KFGQPC). QUL publishes no licence for these resources: distribution requires permission. \
         Division metadata, ruku, sajda and English surah meanings: {}.",
        ids(&Input::LAYOUTS),
        ids(&Input::SCRIPTS),
        ids(&[
            Input::Surahs,
            Input::Rub,
            Input::Juz,
            Input::Hizb,
            Input::Manzil
        ]),
        tanzil::ATTRIBUTION
    )
}

/// One parsed script or layout.
enum Parsed {
    Script(Script),
    Layout(LayoutFile),
}

fn parse_input(file: &InputFile) -> anyhow::Result<Parsed> {
    let parsed = if file.input.layout().is_some() {
        read_layout_file(&file.path, &file.bytes).map(Parsed::Layout)
    } else {
        read_script(file.input, &file.path, &file.bytes).map(Parsed::Script)
    };
    parsed.with_context(|| file.context())
}

/// The four scripts (in [`Input::SCRIPTS`] order) and the three layouts: independent files, read on parallel threads.
fn read_scripts_and_layouts(
    inputs: &Inputs,
) -> anyhow::Result<(Vec<Script>, BTreeMap<Input, LayoutFile>)> {
    let jobs: Vec<&InputFile> = Input::SCRIPTS
        .iter()
        .chain(&Input::LAYOUTS)
        .map(|input| inputs.get(*input))
        .collect::<anyhow::Result<_>>()?;
    let mut scripts = Vec::with_capacity(Input::SCRIPTS.len());
    let mut layouts = BTreeMap::new();
    for (file, parsed) in jobs
        .iter()
        .zip(in_parallel("read", &jobs, |file| parse_input(file))?)
    {
        match parsed? {
            Parsed::Script(script) => scripts.push(script),
            Parsed::Layout(layout) => {
                layouts.insert(file.input, layout);
            }
        }
    }
    Ok((scripts, layouts))
}

/// Script 61's `word_index` → location table, if its export has ids (the JSON keyed by ayah has none).
fn script_word_ids(
    scripts: &[Script],
    words: &BTreeMap<Location, SourceWord>,
) -> anyhow::Result<Option<WordIds>> {
    let code_v2 = scripts
        .iter()
        .find(|s| s.input == Input::CodeV2)
        .ok_or_else(|| anyhow!("script.code_v2 was not read"))?;
    if !code_v2.rows.iter().any(|r| r.id.is_some()) {
        return Ok(None);
    }
    WordIds::new(&code_v2.rows, words)
        .context("script.code_v2: its word_index values map the layouts' word ids to locations")
        .map(Some)
}

/// The three layouts in `mushaf.id` order, each mapped through its own `words` table or else script 61's ids.
fn assemble_layouts(
    inputs: &Inputs,
    files: &BTreeMap<Input, LayoutFile>,
    words: &BTreeMap<Location, SourceWord>,
    script_ids: Option<&WordIds>,
) -> anyhow::Result<(Vec<Layout>, Vec<LayoutSource>)> {
    let mut layouts = Vec::with_capacity(MUSHAFS.len());
    let mut sources = Vec::with_capacity(MUSHAFS.len());
    for input in Input::LAYOUTS {
        let file = inputs.get(input)?;
        let layout = input
            .layout()
            .ok_or_else(|| anyhow!("{} is not a layout", input.key()))?;
        let parsed = files
            .get(&input)
            .ok_or_else(|| anyhow!("{} was not read", input.key()))?;
        let own_ids = parsed
            .words
            .as_ref()
            .map(|rows| WordIds::new(rows, words))
            .transpose()
            .with_context(|| format!("{}: its own words table", file.context()))?;
        let ids = own_ids.as_ref().or(script_ids).ok_or_else(|| {
            anyhow!(
                "{}: the layout has no words table and script.code_v2 has no word_index values, so its \
                 first_word_id/last_word_id cannot be mapped; download script 61 as SQLite",
                file.context()
            )
        })?;
        let assembled =
            assemble_layout(layout, parsed, ids, PAGE_COUNT).with_context(|| file.context())?;
        sources.push(LayoutSource::new(&assembled, parsed, own_ids.is_some()));
        layouts.push(assembled);
    }
    Ok((layouts, sources))
}

/// Every ayah with its divisions: the rub from `meta.rub`, juz/hizb/manzil from the optional cross-check inputs.
fn source_ayahs(inputs: &Inputs, ayahs: &[AyahKey]) -> anyhow::Result<Vec<SourceAyah>> {
    let read = |division: Division| -> anyhow::Result<Option<Vec<u32>>> {
        inputs
            .optional(division.input())
            .map(|file| {
                read_records(&file.path, &file.bytes, division.tables())
                    .and_then(|records| {
                        division_numbers(division, &records, ayahs, division.count())
                    })
                    .with_context(|| file.context())
            })
            .transpose()
    };
    let rub = read(Division::Rub)?.ok_or_else(|| anyhow!("meta.rub is not in the manifest"))?;
    let juz = read(Division::Juz)?;
    let hizb = read(Division::Hizb)?;
    let manzil = read(Division::Manzil)?;
    let value_at =
        |values: Option<&Vec<u32>>, index: usize| values.and_then(|v| v.get(index).copied());
    Ok(ayahs
        .iter()
        .zip(&rub)
        .enumerate()
        .map(|(index, (key, rub))| SourceAyah {
            key: *key,
            divisions: SourceDivisions {
                juz: value_at(juz.as_ref(), index),
                hizb: value_at(hizb.as_ref(), index),
                rub: *rub,
                manzil: value_at(manzil.as_ref(), index),
            },
        })
        .collect())
}

/// `f` over `items`, one named thread per item; results in `items` order.
fn in_parallel<T: Sync, R: Send>(
    what: &str,
    items: &[T],
    f: impl Fn(&T) -> R + Sync,
) -> anyhow::Result<Vec<R>> {
    let f = &f;
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let handle = std::thread::Builder::new()
                .name(format!("qul-{what}-{index}"))
                .spawn_scoped(scope, move || f(item))
                .with_context(|| format!("spawn a {what} thread"))?;
            handles.push(handle);
        }
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| anyhow!("a {what} thread panicked"))
            })
            .collect()
    })
}

// ---- SQLite and JSON helpers ----------------------------------------------------------------------------------------

/// Whether `bytes` are a SQLite database (else they are read as JSON).
#[must_use]
pub fn is_sqlite(bytes: &[u8]) -> bool {
    bytes.starts_with(SQLITE_MAGIC)
}

fn open_sqlite(path: &Path) -> anyhow::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {} read-only", path.display()))
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_names(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name")
        .context("list the tables")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .context("list the tables")?
        .collect::<Result<Vec<_>, _>>()
        .context("list the tables")?;
    Ok(names)
}

/// The first of `candidates` (case-insensitive) that the database has.
fn find_table_opt(conn: &Connection, candidates: &[&str]) -> anyhow::Result<Option<String>> {
    let names = table_names(conn)?;
    Ok(candidates.iter().find_map(|candidate| {
        names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(candidate))
            .cloned()
    }))
}

fn find_table(conn: &Connection, candidates: &[&str]) -> anyhow::Result<String> {
    match find_table_opt(conn, candidates)? {
        Some(table) => Ok(table),
        None => bail!(
            "the database has no table {} (it has: {})",
            candidates.join(" / "),
            list(table_names(conn)?)
        ),
    }
}

fn table_columns(conn: &Connection, table: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .with_context(|| format!("columns of {table}"))?;
    let names = stmt
        .query_map([table], |row| row.get::<_, String>(0))
        .with_context(|| format!("columns of {table}"))?
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("columns of {table}"))?;
    Ok(names)
}

/// The first of `candidates` (case-insensitive) among `columns`, as the table spells it.
fn pick<'c>(columns: &'c [String], candidates: &[&str]) -> Option<&'c str> {
    candidates.iter().find_map(|candidate| {
        columns
            .iter()
            .find(|c| c.eq_ignore_ascii_case(candidate))
            .map(String::as_str)
    })
}

/// Cell `index` of `row` as a number (`what` names it in errors).
fn cell_u32(
    row: &rusqlite::Row<'_>,
    index: usize,
    what: impl Fn() -> String,
) -> anyhow::Result<Option<u32>> {
    let value = row.get_ref(index).with_context(&what)?;
    sql_u32(value).map_err(|e| anyhow!("{}: {e}", what()))
}

/// Cell `index` of `row` as text (`what` names it in errors).
fn cell_text(
    row: &rusqlite::Row<'_>,
    index: usize,
    what: impl Fn() -> String,
) -> anyhow::Result<Option<String>> {
    let value = row.get_ref(index).with_context(&what)?;
    sql_text(value).map_err(|e| anyhow!("{}: {e}", what()))
}

/// A non-negative integer cell. NULL and `''` (QUL's exporter writes `''` for columns that don't apply) are `None`.
fn sql_u32(value: ValueRef<'_>) -> Result<Option<u32>, String> {
    match value {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(n) => u32::try_from(n)
            .map(Some)
            .map_err(|_| format!("{n} is not a non-negative 32-bit integer")),
        ValueRef::Text(bytes) => {
            let text = std::str::from_utf8(bytes).map_err(|_| "text is not UTF-8".to_owned())?;
            let text = text.trim();
            if text.is_empty() {
                Ok(None)
            } else {
                text.parse()
                    .map(Some)
                    .map_err(|_| format!("{text:?} is not a non-negative integer"))
            }
        }
        ValueRef::Real(f) => Err(format!("{f} is not an integer")),
        ValueRef::Blob(_) => Err("a blob is not an integer".to_owned()),
    }
}

/// A text cell (NULL is `None`; an integer is its decimal text).
fn sql_text(value: ValueRef<'_>) -> Result<Option<String>, String> {
    match value {
        ValueRef::Null => Ok(None),
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .map(|s| Some(s.to_owned()))
            .map_err(|_| "text is not UTF-8".to_owned()),
        ValueRef::Integer(n) => Ok(Some(n.to_string())),
        ValueRef::Real(f) => Err(format!("{f} is not text")),
        ValueRef::Blob(_) => Err("a blob is not text".to_owned()),
    }
}

fn sql_json(value: ValueRef<'_>) -> anyhow::Result<Value> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(bytes) => Value::String(
            std::str::from_utf8(bytes)
                .context("text is not UTF-8")?
                .to_owned(),
        ),
        ValueRef::Blob(_) => bail!("a blob"),
    })
}

/// A non-negative integer: a JSON number or a numeric string (QUL's JSON exports write some numbers as strings).
fn json_u32(value: &Value) -> Result<Option<u32>, String> {
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("{n} is not a non-negative 32-bit integer")),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => s
            .trim()
            .parse()
            .map(Some)
            .map_err(|_| format!("{s:?} is not a non-negative integer")),
        other => Err(format!("{other} is not a number")),
    }
}

fn json_string(value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        Value::Number(n) => Ok(Some(n.to_string())),
        other => Err(format!("{other} is not a string")),
    }
}

/// `true`/`false`, `1`/`0`, or their string forms.
fn json_bool(value: &Value) -> Result<bool, String> {
    match value {
        Value::Bool(b) => Ok(*b),
        Value::Number(n) if n.as_u64() == Some(1) => Ok(true),
        Value::Number(n) if n.as_u64() == Some(0) => Ok(false),
        Value::String(s) if matches!(s.trim(), "true" | "1") => Ok(true),
        Value::String(s) if matches!(s.trim(), "false" | "0") => Ok(false),
        other => Err(format!("{other} is not a boolean")),
    }
}

/// The first of `names` the record has (even if null), with the name found.
fn json_field<'r, 'n>(
    record: &'r Map<String, Value>,
    names: &[&'n str],
) -> Option<(&'n str, &'r Value)> {
    names
        .iter()
        .find_map(|name| record.get(*name).map(|value| (*name, value)))
}

fn json_field_u32(record: &Map<String, Value>, names: &[&str]) -> anyhow::Result<Option<u32>> {
    json_field(record, names)
        .map(|(name, value)| json_u32(value).map_err(|e| anyhow!("{name}: {e}")))
        .transpose()
        .map(Option::flatten)
}

fn json_field_string(
    record: &Map<String, Value>,
    names: &[&str],
) -> anyhow::Result<Option<String>> {
    json_field(record, names)
        .map(|(name, value)| json_string(value).map_err(|e| anyhow!("{name}: {e}")))
        .transpose()
        .map(Option::flatten)
}

/// One record of a JSON export: the key it is listed under (none in an array) and its fields.
type JsonRecord<'a> = (Option<&'a str>, &'a Map<String, Value>);

/// The records of a JSON export: an object of objects (keyed) or an array of objects.
fn json_objects(value: &Value) -> anyhow::Result<Vec<JsonRecord<'_>>> {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(key, item)| {
                item.as_object()
                    .map(|record| (Some(key.as_str()), record))
                    .ok_or_else(|| anyhow!("entry {key:?} is not an object"))
            })
            .collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                item.as_object()
                    .map(|record| (None, record))
                    .ok_or_else(|| anyhow!("item {index} is not an object"))
            })
            .collect(),
        _ => bail!("expected a JSON object or array of records"),
    }
}

/// One metadata record: a JSON object (with the key it was listed under) or a SQLite row (column → value).
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// The JSON object key (`None` for arrays and SQLite rows).
    pub key: Option<String>,
    pub fields: Map<String, Value>,
}

impl Record {
    fn label(&self, index: usize) -> String {
        self.key
            .as_ref()
            .map_or_else(|| format!("#{}", index + 1), |k| format!("{k:?}"))
    }
}

fn sqlite_records(conn: &Connection, table: &str) -> anyhow::Result<Vec<Record>> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {}", quote_ident(table)))
        .with_context(|| format!("query table {table}"))?;
    let names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(str::to_ascii_lowercase)
        .collect();
    let mut rows = stmt
        .query([])
        .with_context(|| format!("query table {table}"))?;
    let mut records = Vec::new();
    while let Some(row) = rows.next().with_context(|| format!("read table {table}"))? {
        let mut fields = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = sql_json(row.get_ref(index)?)
                .with_context(|| format!("table {table} row {}: {name}", records.len() + 1))?;
            fields.insert(name.clone(), value);
        }
        records.push(Record { key: None, fields });
    }
    Ok(records)
}

/// The records of a metadata export: the first of `tables` in a SQLite file, else JSON.
pub fn read_records(path: &Path, bytes: &[u8], tables: &[&str]) -> anyhow::Result<Vec<Record>> {
    if is_sqlite(bytes) {
        let conn = open_sqlite(path)?;
        let table = find_table(&conn, tables)?;
        return sqlite_records(&conn, &table);
    }
    let value: Value = serde_json::from_slice(bytes).context("parse JSON")?;
    Ok(json_objects(&value)?
        .into_iter()
        .map(|(key, fields)| Record {
            key: key.map(str::to_owned),
            fields: fields.clone(),
        })
        .collect())
}

/// The record's number: its field `names[..]` or the key it is listed under; both, when present, must agree.
fn record_number(record: &Record, names: &[&str]) -> anyhow::Result<u32> {
    let field = json_field(&record.fields, names)
        .map(|(name, value)| {
            json_u32(value)
                .map(|number| number.map(|number| (name, number)))
                .map_err(|e| anyhow!("{name}: {e}"))
        })
        .transpose()?
        .flatten();
    let key = record
        .key
        .as_deref()
        .map(|k| {
            k.trim()
                .parse::<u32>()
                .map_err(|_| anyhow!("key {k:?} is not a number"))
        })
        .transpose()?;
    match (field, key) {
        (Some((name, field)), Some(key)) => {
            ensure!(field == key, "{name} {field} is listed under key {key}");
            Ok(field)
        }
        (Some((_, number)), None) | (None, Some(number)) => Ok(number),
        (None, None) => bail!("no {} field", names.join("/")),
    }
}

/// `items` joined by ", ", at most [`LIST_LIMIT`] of them.
fn list<T: Display>(items: impl IntoIterator<Item = T>) -> String {
    let all: Vec<String> = items.into_iter().map(|item| item.to_string()).collect();
    let shown = all
        .iter()
        .take(LIST_LIMIT)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match all.len().checked_sub(LIST_LIMIT) {
        Some(more) if more > 0 => format!("{shown} … and {more} more"),
        _ => shown,
    }
}

// ---- word scripts ---------------------------------------------------------------------------------------------------

/// One row of a word script.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptRow {
    /// QUL `word_index` (`id`), when the export has it.
    pub id: Option<u32>,
    /// The parsed location, or the raw value when it is not `s:a:w`.
    pub location: Result<Location, String>,
    pub text: Option<String>,
}

/// One word script as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Script {
    pub input: Input,
    /// How it was read (for the report), e.g. `SQLite words(word_index, word_key)`.
    pub format: String,
    pub rows: Vec<ScriptRow>,
}

/// Reads a word script: SQLite `words` (both column variants) or JSON (both shapes).
pub fn read_script(input: Input, path: &Path, bytes: &[u8]) -> anyhow::Result<Script> {
    let (rows, format) = if is_sqlite(bytes) {
        let conn = open_sqlite(path)?;
        let table = find_table(&conn, &["words"])?;
        read_words_table(&conn, &table)?
    } else {
        read_words_json(bytes)?
    };
    ensure!(!rows.is_empty(), "the script has no words");
    Ok(Script {
        input,
        format,
        rows,
    })
}

/// A `words` table: `id|word_index`, `location|word_key`, `text`, and optional `surah`, `ayah`, `word`.
fn read_words_table(conn: &Connection, table: &str) -> anyhow::Result<(Vec<ScriptRow>, String)> {
    let columns = table_columns(conn, table)?;
    let location = pick(&columns, &["location", "word_key"]).ok_or_else(|| {
        anyhow!(
            "table {table} has neither a location nor a word_key column (it has: {})",
            list(&columns)
        )
    })?;
    let text = pick(&columns, &["text"]).ok_or_else(|| {
        anyhow!(
            "table {table} has no text column (it has: {})",
            list(&columns)
        )
    })?;
    let id = pick(&columns, &["word_index", "id"]);
    let parts = [
        pick(&columns, &["surah"]),
        pick(&columns, &["ayah"]),
        pick(&columns, &["word"]),
    ];
    let expr = |column: Option<&str>| column.map_or_else(|| "NULL".to_owned(), quote_ident);
    let sql = format!(
        "SELECT {}, {}, {}, {}, {}, {} FROM {}",
        expr(id),
        quote_ident(location),
        quote_ident(text),
        expr(parts[0]),
        expr(parts[1]),
        expr(parts[2]),
        quote_ident(table)
    );
    let mut stmt = conn
        .prepare(&sql)
        .with_context(|| format!("query table {table}"))?;
    let mut rows = stmt
        .query([])
        .with_context(|| format!("query table {table}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().with_context(|| format!("read table {table}"))? {
        let number = out.len() + 1;
        let id_value = cell_u32(row, 0, || {
            format!("{table} row {number}: {}", id.unwrap_or("id"))
        })?;
        let raw = cell_text(row, 1, || format!("{table} row {number}: {location}"))?
            .ok_or_else(|| anyhow!("{table} row {number}: {location} is NULL"))?;
        let text_value = cell_text(row, 2, || format!("{table} row {number}: {text}"))?;
        let mut numbers = [None; 3];
        for (slot, (index, name)) in
            numbers
                .iter_mut()
                .zip([(3, "surah"), (4, "ayah"), (5, "word")])
        {
            *slot = cell_u32(row, index, || format!("{table} row {number}: {name}"))?;
        }
        out.push(
            script_row(id_value, &raw, text_value, numbers)
                .with_context(|| format!("row {number} ({location} {raw:?})"))?,
        );
    }
    let format = format!(
        "SQLite {table}({}, {location}{})",
        id.unwrap_or("no word_index"),
        if parts[2].is_some() { ", word" } else { "" }
    );
    Ok((out, format))
}

/// QUL's JSON word scripts: records keyed by location (`{id, surah, ayah, word, location, text}`, the exporter's
/// shape) or keyed by ayah with a `words` array (`{verse_key, words: [{position, text, location}]}`, the shape the
/// resource pages document).
fn read_words_json(bytes: &[u8]) -> anyhow::Result<(Vec<ScriptRow>, String)> {
    let value: Value = serde_json::from_slice(bytes).context("parse JSON")?;
    let records = json_objects(&value)?;
    let by_ayah = records
        .first()
        .is_some_and(|(_, record)| matches!(record.get("words"), Some(Value::Array(_))));
    let mut out = Vec::with_capacity(records.len());
    for (index, (key, record)) in records.into_iter().enumerate() {
        let label = key.map_or_else(|| format!("#{}", index + 1), |k| format!("{k:?}"));
        if by_ayah {
            let verse_key = json_field_string(record, &["verse_key"])?
                .or_else(|| key.map(str::to_owned))
                .ok_or_else(|| anyhow!("record {label} has no verse_key"))?;
            let Some(Value::Array(words)) = record.get("words") else {
                bail!("ayah {verse_key} has no words array");
            };
            for word in words {
                let word = word
                    .as_object()
                    .ok_or_else(|| anyhow!("ayah {verse_key}: a word is not an object"))?;
                let id = json_field_u32(word, &["word_index", "id"])?;
                let position = json_field_u32(word, &["position", "word"])?;
                let raw = match (
                    json_field_string(word, &["location", "word_key"])?,
                    position,
                ) {
                    (Some(location), _) => location,
                    (None, Some(position)) => format!("{}:{position}", verse_key.trim()),
                    (None, None) => {
                        bail!("ayah {verse_key}: a word has neither location nor position")
                    }
                };
                let text = json_field_string(word, &["text"])?;
                out.push(
                    script_row(id, &raw, text, [None, None, position])
                        .with_context(|| format!("ayah {verse_key}"))?,
                );
            }
        } else {
            let id = json_field_u32(record, &["word_index", "id"])?;
            let raw = json_field_string(record, &["location", "word_key"])?
                .or_else(|| key.map(str::to_owned))
                .ok_or_else(|| anyhow!("record {label} has no location"))?;
            let text = json_field_string(record, &["text"])?;
            let numbers = [
                json_field_u32(record, &["surah"])?,
                json_field_u32(record, &["ayah"])?,
                json_field_u32(record, &["word"])?,
            ];
            out.push(
                script_row(id, &raw, text, numbers).with_context(|| format!("record {label}"))?,
            );
        }
    }
    let format = if by_ayah {
        "JSON keyed by ayah (words[])"
    } else {
        "JSON keyed by location"
    };
    Ok((out, format.to_owned()))
}

/// One script row: the location parsed (an `s:a` key is completed with the `word` number), and the optional
/// `surah`/`ayah`/`word` numbers checked against it. An unparsable location is kept raw for the report.
fn script_row(
    id: Option<u32>,
    raw: &str,
    text: Option<String>,
    [surah, ayah, word]: [Option<u32>; 3],
) -> anyhow::Result<ScriptRow> {
    let trimmed = raw.trim();
    let location = match trimmed.parse::<Location>() {
        Ok(location) => Ok(location),
        Err(_) => match (trimmed.parse::<AyahKey>(), word) {
            (Ok(key), Some(word)) if word > 0 => Ok(Location::new(key.surah, key.ayah, word)),
            _ => Err(raw.to_owned()),
        },
    };
    if let Ok(location) = location {
        for (name, given, actual) in [
            ("surah", surah, location.surah),
            ("ayah", ayah, location.ayah),
            ("word", word, location.word),
        ] {
            if let Some(given) = given {
                ensure!(given == actual, "location {location}, but {name} = {given}");
            }
        }
    }
    Ok(ScriptRow { id, location, text })
}

/// Joins the four scripts on location into the canonical words (see the module docs). `expected` is the exact
/// location count (83,665).
pub fn canonical_words(
    scripts: &[Script],
    surahs: &[SourceSurah],
    expected: usize,
) -> anyhow::Result<BTreeMap<Location, SourceWord>> {
    let mut texts: Vec<(Input, BTreeMap<Location, Option<&str>>)> = Vec::with_capacity(4);
    let mut unparsed = BTreeSet::new();
    let mut problems = Vec::new();
    for input in Input::SCRIPTS {
        let script = scripts
            .iter()
            .find(|s| s.input == input)
            .ok_or_else(|| anyhow!("{} was not read", input.key()))?;
        let mut map = BTreeMap::new();
        let mut duplicates = Vec::new();
        for row in &script.rows {
            match &row.location {
                Ok(location) => {
                    if map.insert(*location, row.text.as_deref()).is_some() {
                        duplicates.push(*location);
                    }
                }
                Err(raw) => {
                    unparsed.insert(row.id.map_or_else(
                        || format!("{raw:?}"),
                        |id| format!("{raw:?} (word_index {id})"),
                    ));
                }
            }
        }
        if !duplicates.is_empty() {
            problems.push(format!(
                "{} lists {} location(s) twice: {}",
                input.key(),
                duplicates.len(),
                list(&duplicates)
            ));
        }
        texts.push((input, map));
    }
    let Some(((reference_input, reference), others)) = texts.split_first() else {
        bail!("no scripts");
    };
    let reference_ends = last_words(reference.keys());
    for (input, map) in others {
        let missing: Vec<Location> = reference
            .keys()
            .filter(|l| !map.contains_key(l))
            .copied()
            .collect();
        let extra: Vec<Location> = map
            .keys()
            .filter(|l| !reference.contains_key(l))
            .copied()
            .collect();
        let mut parts = Vec::new();
        if !missing.is_empty() {
            parts.push(format!(
                "lacks {} of its location(s): {}",
                missing.len(),
                list(&missing)
            ));
            if missing.iter().all(|l| reference_ends.contains(l)) {
                parts.push(
                    "every missing location is an ayah's end marker: use the SQLite export, which lists them"
                        .to_owned(),
                );
            }
        }
        if !extra.is_empty() {
            parts.push(format!(
                "has {} location(s) it lacks: {}",
                extra.len(),
                list(&extra)
            ));
        }
        if !parts.is_empty() {
            problems.push(format!(
                "{} differs from {}: {}",
                input.key(),
                reference_input.key(),
                parts.join("; ")
            ));
        }
    }
    ensure!(
        problems.is_empty(),
        "the word scripts must have identical location sets:\n  - {}",
        problems.join("\n  - ")
    );
    if reference.len() != expected || !unparsed.is_empty() {
        let hafs = texts
            .iter()
            .find(|(input, _)| *input == Input::TextHafs)
            .map(|(_, map)| map);
        bail!(
            "{}",
            explain_count(reference, &unparsed, surahs, hafs, expected)
        );
    }

    let text = |input: Input, location: &Location| -> anyhow::Result<&str> {
        texts
            .iter()
            .find(|(i, _)| *i == input)
            .and_then(|(_, map)| map.get(location).copied().flatten())
            .ok_or_else(|| anyhow!("{}: word {location} has no text", input.key()))
    };
    let locations: Vec<Location> = reference.keys().copied().collect();
    let mut words = BTreeMap::new();
    for (index, location) in locations.iter().enumerate() {
        let is_end = locations
            .get(index + 1)
            .is_none_or(|next| next.ayah_key() != location.ayah_key());
        let word = SourceWord {
            kind: if is_end {
                WordKind::End
            } else {
                WordKind::Word
            },
            text_hafs: text(Input::TextHafs, location)?.to_owned(),
            text_imlaei: if is_end {
                None
            } else {
                Some(text(Input::Imlaei, location)?.to_owned())
            },
            code_v1: text(Input::CodeV1, location)?.to_owned(),
            code_v2: text(Input::CodeV2, location)?.to_owned(),
        };
        words.insert(*location, word);
    }
    Ok(words)
}

/// The last location of every ayah among `locations` (sorted).
fn last_words<'a>(locations: impl Iterator<Item = &'a Location>) -> BTreeSet<Location> {
    let mut last: BTreeMap<AyahKey, Location> = BTreeMap::new();
    for location in locations {
        last.insert(location.ayah_key(), *location);
    }
    last.into_values().collect()
}

/// Why the canonical sequence does not have `expected` locations: the candidates a human should look at.
fn explain_count(
    locations: &BTreeMap<Location, Option<&str>>,
    unparsed: &BTreeSet<String>,
    surahs: &[SourceSurah],
    hafs: Option<&BTreeMap<Location, Option<&str>>>,
    expected: usize,
) -> String {
    let mut out = format!(
        "the word scripts have {} word locations{}, expected exactly {expected} (77,429 words + 6,236 end markers). \
         QUL's word_index has 3 extra slots: a human must decide how the extra rows map before core.db can be built \
         from these files.",
        locations.len(),
        if unparsed.is_empty() {
            String::new()
        } else {
            format!(" (plus {} unparsable)", unparsed.len())
        }
    );
    let mut candidates = Vec::new();
    if !unparsed.is_empty() {
        candidates.push(format!("locations that are not s:a:w: {}", list(unparsed)));
    }
    let ayah_counts: BTreeMap<u32, u32> = surahs.iter().map(|s| (s.id, s.ayah_count)).collect();
    let outside: Vec<Location> = locations
        .keys()
        .filter(|l| ayah_counts.get(&l.surah).is_none_or(|n| l.ayah > *n))
        .copied()
        .collect();
    if !outside.is_empty() {
        candidates.push(format!(
            "locations outside their surah's ayahs: {}",
            list(&outside)
        ));
    }
    let mut by_ayah: BTreeMap<AyahKey, Vec<Location>> = BTreeMap::new();
    for location in locations.keys() {
        by_ayah
            .entry(location.ayah_key())
            .or_default()
            .push(*location);
    }
    let mut gaps = Vec::new();
    let mut after_marker = Vec::new();
    let mut without_marker = Vec::new();
    let mut several_markers = Vec::new();
    for (key, words) in &by_ayah {
        let count = u32::try_from(words.len()).unwrap_or(u32::MAX);
        if !words.iter().map(|l| l.word).eq(1..=count) {
            gaps.push(format!(
                "{key} (positions {})",
                list(words.iter().map(|l| l.word))
            ));
        }
        let Some(hafs) = hafs else { continue };
        let number = arabic_indic(key.ayah);
        let markers: Vec<&Location> = words
            .iter()
            .filter(|l| {
                hafs.get(*l)
                    .copied()
                    .flatten()
                    .is_some_and(|t| t.trim().trim_start_matches(END_OF_AYAH) == number)
            })
            .collect();
        match markers.as_slice() {
            [] => without_marker.push(*key),
            [marker] => after_marker.extend(words.iter().filter(|l| l.word > marker.word).copied()),
            _ => several_markers.push(*key),
        }
    }
    if !gaps.is_empty() {
        candidates.push(format!(
            "ayahs whose positions are not 1..n: {}",
            list(&gaps)
        ));
    }
    if !after_marker.is_empty() {
        candidates.push(format!(
            "locations after their ayah's end marker (script.text_hafs): {}",
            list(&after_marker)
        ));
    }
    if !several_markers.is_empty() {
        candidates.push(format!(
            "ayahs with more than one end marker: {}",
            list(&several_markers)
        ));
    }
    if !without_marker.is_empty() {
        candidates.push(format!(
            "ayahs without an end marker: {}",
            list(&without_marker)
        ));
    }
    let missing: Vec<AyahKey> = surahs
        .iter()
        .flat_map(|s| (1..=s.ayah_count).map(move |a| AyahKey::new(s.id, a)))
        .filter(|k| !by_ayah.contains_key(k))
        .collect();
    if !missing.is_empty() {
        candidates.push(format!("ayahs without words: {}", list(&missing)));
    }
    if candidates.is_empty() {
        out.push_str(
            " No location stands out structurally (every ayah has positions 1..n and ends with its number); compare \
             the per-ayah word counts with QUL metadata 69 (words_count + 1 end marker).",
        );
    } else {
        out.push_str(" Candidates:");
        for candidate in candidates {
            out.push_str("\n  - ");
            out.push_str(&candidate);
        }
    }
    out
}

/// QUL `word_index` → location, from one table (script 61 or a layout's own `words`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordIds {
    by_id: BTreeMap<u32, Location>,
}

impl WordIds {
    /// Every canonical word must have exactly one id, and id order must be location order.
    pub fn new(rows: &[ScriptRow], words: &BTreeMap<Location, SourceWord>) -> anyhow::Result<Self> {
        let mut by_id = BTreeMap::new();
        let mut seen = BTreeSet::new();
        for row in rows {
            let location = row
                .location
                .as_ref()
                .map_err(|raw| anyhow!("location {raw:?} is not s:a:w"))?;
            let id = row.id.ok_or_else(|| {
                anyhow!(
                    "word {location} has no word_index, so the layout's word ids cannot be mapped"
                )
            })?;
            ensure!(
                words.contains_key(location),
                "word_index {id} is {location}, which is not a word of the scripts"
            );
            ensure!(
                seen.insert(*location),
                "{location} has two word_index values"
            );
            if let Some(other) = by_id.insert(id, *location) {
                bail!("word_index {id} is both {other} and {location}");
            }
        }
        ensure!(
            by_id.len() == words.len(),
            "word_index values for {} of the {} words",
            by_id.len(),
            words.len()
        );
        let mut previous: Option<(u32, Location)> = None;
        for (&id, &location) in &by_id {
            if let Some((previous_id, previous_location)) = previous {
                ensure!(
                    location > previous_location,
                    "word_index order and location order disagree: word_index {previous_id} is \
                     {previous_location}, but {id} is {location}"
                );
            }
            previous = Some((id, location));
        }
        Ok(Self { by_id })
    }

    /// The largest id.
    #[must_use]
    pub fn max(&self) -> u32 {
        self.by_id.last_key_value().map_or(0, |(id, _)| *id)
    }

    /// The ids in `1..=max` that name no word (QUL's extra slots).
    pub fn unused(&self) -> impl Iterator<Item = u32> + '_ {
        (1..=self.max()).filter(|id| !self.by_id.contains_key(id))
    }

    /// The words of a layout line `first..=last`, in reading order (ids that name no word are skipped).
    pub fn line(&self, first: u32, last: u32) -> anyhow::Result<Vec<Location>> {
        ensure!(
            first <= last,
            "first_word_id {first} is after last_word_id {last}"
        );
        for id in [first, last] {
            ensure!(self.by_id.contains_key(&id), "word id {id} names no word");
        }
        Ok(self
            .by_id
            .range(first..=last)
            .map(|(_, location)| *location)
            .collect())
    }

    /// How many of `rows` carry an id that this table maps to another location (0 when the exports agree).
    #[must_use]
    pub fn disagreements(&self, rows: &[ScriptRow]) -> usize {
        rows.iter()
            .filter(|row| match (row.id, &row.location) {
                (Some(id), Ok(location)) => self.by_id.get(&id) != Some(location),
                _ => false,
            })
            .count()
    }
}

// ---- layouts --------------------------------------------------------------------------------------------------------

/// One row of a layout's `pages` table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutRow {
    pub page: u32,
    pub line: u32,
    pub line_type: String,
    pub centered: Option<bool>,
    pub first_word_id: Option<u32>,
    pub last_word_id: Option<u32>,
    pub surah: Option<u32>,
}

/// A layout's `info` row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LayoutInfo {
    pub name: Option<String>,
    pub pages: Option<u32>,
    pub lines_per_page: Option<u32>,
    pub font: Option<String>,
}

/// A layout export as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutFile {
    pub rows: Vec<LayoutRow>,
    pub info: Option<LayoutInfo>,
    /// Its own `words` table, if it has one (then its ids are mapped through it, not script 61).
    pub words: Option<Vec<ScriptRow>>,
}

/// Reads a layout export (SQLite only: QUL's JSON layout export is a directory of pages).
pub fn read_layout_file(path: &Path, bytes: &[u8]) -> anyhow::Result<LayoutFile> {
    ensure!(
        is_sqlite(bytes),
        "not a SQLite database: download the layout in SQLite format"
    );
    let conn = open_sqlite(path)?;
    let table = find_table(&conn, &["pages"])?;
    let columns = table_columns(&conn, &table)?;
    let names = LAYOUT_COLUMNS
        .iter()
        .map(|column| {
            pick(&columns, &[column]).map(quote_ident).ok_or_else(|| {
                anyhow!(
                    "table {table} has no {column} column (it has: {})",
                    list(&columns)
                )
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let sql = format!("SELECT {} FROM {}", names.join(", "), quote_ident(&table));
    let rows = {
        let mut stmt = conn
            .prepare(&sql)
            .with_context(|| format!("query table {table}"))?;
        let mut rows = stmt
            .query([])
            .with_context(|| format!("query table {table}"))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().with_context(|| format!("read table {table}"))? {
            let number = out.len() + 1;
            let int = |index: usize| {
                cell_u32(row, index, || {
                    let column = LAYOUT_COLUMNS.get(index).copied().unwrap_or("?");
                    format!("{table} row {number}: {column}")
                })
            };
            let page =
                int(0)?.ok_or_else(|| anyhow!("{table} row {number}: page_number is NULL"))?;
            let line =
                int(1)?.ok_or_else(|| anyhow!("{table} row {number}: line_number is NULL"))?;
            let line_type = cell_text(row, 2, || format!("page {page} line {line}: line_type"))?
                .ok_or_else(|| anyhow!("page {page} line {line}: line_type is NULL"))?;
            let centered = match int(3)? {
                None => None,
                Some(0) => Some(false),
                Some(1) => Some(true),
                Some(other) => {
                    bail!("page {page} line {line}: is_centered = {other}, expected 0 or 1")
                }
            };
            out.push(LayoutRow {
                page,
                line,
                line_type,
                centered,
                first_word_id: int(4)?,
                last_word_id: int(5)?,
                surah: int(6)?,
            });
        }
        out
    };

    let info = match find_table_opt(&conn, &["info"])? {
        Some(table) => {
            let records = sqlite_records(&conn, &table)?;
            ensure!(
                records.len() <= 1,
                "table {table} has {} rows, expected one",
                records.len()
            );
            records
                .first()
                .map(|record| -> anyhow::Result<LayoutInfo> {
                    let f = &record.fields;
                    Ok(LayoutInfo {
                        name: json_field_string(f, &["name"])?,
                        pages: json_field_u32(f, &["number_of_pages"])?,
                        lines_per_page: json_field_u32(f, &["lines_per_page"])?,
                        font: json_field_string(f, &["font_name"])?,
                    })
                })
                .transpose()
                .with_context(|| format!("table {table}"))?
        }
        None => None,
    };
    let words = match find_table_opt(&conn, &["words"])? {
        Some(table) => Some(read_words_table(&conn, &table)?.0),
        None => None,
    };
    Ok(LayoutFile { rows, info, words })
}

/// Builds the model layout: pages `1..=page_count`, every page with exactly its lines, ayah lines mapped through `ids`,
/// basmallah lines given the surah of the next ayah line.
pub fn assemble_layout(
    layout: MushafLayout,
    file: &LayoutFile,
    ids: &WordIds,
    page_count: u32,
) -> anyhow::Result<Layout> {
    if let Some(info) = &file.info {
        if let Some(pages) = info.pages {
            ensure!(
                pages == page_count,
                "info.number_of_pages = {pages}, expected {page_count}"
            );
        }
        if let Some(lines) = info.lines_per_page {
            ensure!(
                lines == LINES_PER_PAGE,
                "info.lines_per_page = {lines}, expected {LINES_PER_PAGE}"
            );
        }
    }
    let mut pages: BTreeMap<u32, BTreeMap<u32, &LayoutRow>> = BTreeMap::new();
    for row in &file.rows {
        ensure!(
            (1..=page_count).contains(&row.page),
            "page {} is outside 1..={page_count}",
            row.page
        );
        let lines = lines_on_page(row.page);
        ensure!(
            (1..=lines).contains(&row.line),
            "page {} line {} is outside 1..={lines}",
            row.page,
            row.line
        );
        ensure!(
            pages
                .entry(row.page)
                .or_default()
                .insert(row.line, row)
                .is_none(),
            "page {} line {} is listed twice",
            row.page,
            row.line
        );
    }
    let missing: Vec<u32> = (1..=page_count)
        .filter(|p| !pages.contains_key(p))
        .collect();
    ensure!(missing.is_empty(), "pages {} have no lines", list(&missing));
    let mut out = Vec::with_capacity(pages.len());
    for (&number, lines) in &pages {
        let expected = lines_on_page(number);
        let missing: Vec<u32> = (1..=expected).filter(|l| !lines.contains_key(l)).collect();
        ensure!(
            missing.is_empty(),
            "page {number} has no line(s) {} (every page has lines 1..={expected})",
            list(&missing)
        );
        let lines = lines
            .values()
            .map(|row| {
                raw_line(row, ids).with_context(|| format!("page {} line {}", row.page, row.line))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        out.push(Page { number, lines });
    }
    assign_basmallah_surahs(&mut out)?;
    Ok(Layout { layout, pages: out })
}

fn raw_line(row: &LayoutRow, ids: &WordIds) -> anyhow::Result<RawLine> {
    let kind = match row.line_type.trim() {
        "ayah" => LineKind::Ayah,
        "surah_name" => LineKind::SurahName,
        "basmallah" => LineKind::Basmallah,
        other => bail!("line_type {other:?} is not ayah, surah_name or basmallah"),
    };
    let words = if kind == LineKind::Ayah {
        ensure!(
            row.surah.is_none(),
            "an ayah line with surah_number {}",
            row.surah.unwrap_or_default()
        );
        let (Some(first), Some(last)) = (row.first_word_id, row.last_word_id) else {
            bail!("an ayah line without first_word_id and last_word_id");
        };
        ids.line(first, last)?
    } else {
        ensure!(
            row.first_word_id.is_none() && row.last_word_id.is_none(),
            "a {} line with word ids",
            kind.as_str()
        );
        Vec::new()
    };
    Ok(RawLine {
        line: row.line,
        kind: Some(kind),
        centered: row.centered,
        surah: row.surah,
        words,
    })
}

/// A `basmallah` line takes the surah of the next ayah line in reading order (QUL leaves its `surah_number` empty;
/// one that is given must agree).
fn assign_basmallah_surahs(pages: &mut [Page]) -> anyhow::Result<()> {
    let mut next_surah: Option<u32> = None;
    for page in pages.iter_mut().rev() {
        let number = page.number;
        for line in page.lines.iter_mut().rev() {
            match line.kind {
                Some(LineKind::Ayah) => next_surah = line.words.first().map(|l| l.surah),
                Some(LineKind::Basmallah) => {
                    let surah = next_surah.ok_or_else(|| {
                        anyhow!(
                            "page {number} line {}: a basmallah line with no ayah line after it",
                            line.line
                        )
                    })?;
                    match line.surah {
                        Some(given) => ensure!(
                            given == surah,
                            "page {number} line {}: basmallah of surah {given}, but the next ayah line is in \
                             surah {surah}",
                            line.line
                        ),
                        None => line.surah = Some(surah),
                    }
                }
                Some(LineKind::SurahName) | None => {}
            }
        }
    }
    Ok(())
}

// ---- metadata -------------------------------------------------------------------------------------------------------

/// QUL 70 (`{id, name, name_simple, name_arabic, revelation_order, revelation_place, verses_count, bismillah_pre}`,
/// keyed by id) → surahs `1..=expected` in order. `name_complex` is QUL's `name` (transliteration with diacritics).
pub fn parse_surahs(records: &[Record], expected: u32) -> anyhow::Result<Vec<SourceSurah>> {
    let mut by_id = BTreeMap::new();
    for (index, record) in records.iter().enumerate() {
        let surah = surah_record(record)
            .with_context(|| format!("surah record {}", record.label(index)))?;
        let id = surah.id;
        ensure!(
            by_id.insert(id, surah).is_none(),
            "surah {id} is listed twice"
        );
    }
    ensure!(
        by_id.keys().copied().eq(1..=expected),
        "the records are surahs {}, expected 1..={expected}",
        list(by_id.keys())
    );
    Ok(by_id.into_values().collect())
}

fn surah_record(record: &Record) -> anyhow::Result<SourceSurah> {
    let fields = &record.fields;
    let text = |names: &[&str]| -> anyhow::Result<String> {
        let value =
            json_field_string(fields, names)?.ok_or_else(|| anyhow!("no {}", names.join("/")))?;
        ensure!(!value.trim().is_empty(), "empty {}", names.join("/"));
        Ok(value)
    };
    let number = |names: &[&str]| -> anyhow::Result<u32> {
        json_field_u32(fields, names)?.ok_or_else(|| anyhow!("no {}", names.join("/")))
    };
    let id = record_number(record, &["id"])?;
    let revelation_place = text(&["revelation_place"])?
        .trim()
        .to_ascii_lowercase()
        .parse::<RevelationPlace>()?;
    let (name, bismillah) =
        json_field(fields, &["bismillah_pre"]).ok_or_else(|| anyhow!("no bismillah_pre"))?;
    let bismillah_pre = json_bool(bismillah).map_err(|e| anyhow!("{name}: {e}"))?;
    let ayah_count = number(&["verses_count", "ayah_count"])?;
    ensure!(ayah_count > 0, "surah {id} has no verses");
    Ok(SourceSurah {
        id,
        name_ar: text(&["name_arabic", "name_ar"])?,
        name_simple: text(&["name_simple"])?,
        name_complex: text(&["name", "name_complex"])?,
        revelation_place,
        revelation_order: number(&["revelation_order"])?,
        ayah_count,
        bismillah_pre,
    })
}

/// Every ayah in canonical order, from the surahs' ayah counts.
#[must_use]
pub fn ayah_keys(surahs: &[SourceSurah]) -> Vec<AyahKey> {
    surahs
        .iter()
        .flat_map(|s| (1..=s.ayah_count).map(move |a| AyahKey::new(s.id, a)))
        .collect()
}

/// A QUL division metadata file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Division {
    Juz,
    Hizb,
    Rub,
    Manzil,
}

impl Division {
    pub const ALL: [Self; 4] = [Self::Juz, Self::Hizb, Self::Rub, Self::Manzil];

    #[must_use]
    pub const fn input(self) -> Input {
        match self {
            Self::Juz => Input::Juz,
            Self::Hizb => Input::Hizb,
            Self::Rub => Input::Rub,
            Self::Manzil => Input::Manzil,
        }
    }

    /// Divisions in the Hafs canon.
    #[must_use]
    pub const fn count(self) -> usize {
        match self {
            Self::Juz => JUZ_COUNT,
            Self::Hizb => HIZB_COUNT,
            Self::Rub => QUARTER_COUNT,
            Self::Manzil => MANZIL_COUNT,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Juz => "juz",
            Self::Hizb => "hizb",
            Self::Rub => "rub",
            Self::Manzil => "manzil",
        }
    }

    /// The record's number field (QUL's exporter writes `rub_number`; its database column is `rub_el_hizb_number`).
    const fn number_fields(self) -> &'static [&'static str] {
        match self {
            Self::Juz => &["juz_number"],
            Self::Hizb => &["hizb_number"],
            Self::Rub => &["rub_number", "rub_el_hizb_number"],
            Self::Manzil => &["manzil_number"],
        }
    }

    /// The table of the SQLite export.
    const fn tables(self) -> &'static [&'static str] {
        match self {
            Self::Juz => &["juz", "juzs"],
            Self::Hizb => &["hizbs", "hizb"],
            Self::Rub => &["rub", "rubs", "rub_el_hizbs", "rub_el_hizb"],
            Self::Manzil => &["manzil", "manzils"],
        }
    }
}

/// One division record.
struct DivisionRange {
    number: u32,
    first: AyahKey,
    last: AyahKey,
    verses_count: Option<u32>,
    mapping: Option<BTreeSet<AyahKey>>,
}

/// The per-ayah number (index = position in `ayahs`) of `division`, from its `expected` records
/// (`{<kind>_number, verses_count, first_verse_key, last_verse_key, verse_mapping}`): numbered `1..=expected`,
/// contiguous, covering every ayah once; `verses_count` and `verse_mapping` must agree with each range.
pub fn division_numbers(
    division: Division,
    records: &[Record],
    ayahs: &[AyahKey],
    expected: usize,
) -> anyhow::Result<Vec<u32>> {
    let name = division.name();
    // A file of another division (e.g. QUL's hizb file in the rub slot) is the likeliest mistake: name it.
    let foreign = records.iter().find_map(|record| {
        if json_field(&record.fields, division.number_fields()).is_some() {
            return None;
        }
        Division::ALL
            .into_iter()
            .filter(|other| *other != division)
            .find_map(|other| {
                json_field(&record.fields, other.number_fields()).map(|(field, _)| (field, other))
            })
    });
    let hint = foreign.map_or_else(String::new, |(field, other)| {
        format!(
            " (its records carry {field}: this looks like QUL's \"{}\" metadata, resource {}, not \"{}\", resource {})",
            other.input().title(),
            other.input().resource().unwrap_or_default(),
            division.input().title(),
            division.input().resource().unwrap_or_default()
        )
    });
    let mut ranges: BTreeMap<u32, DivisionRange> = BTreeMap::new();
    for (index, record) in records.iter().enumerate() {
        let range = division_range(division, record)
            .with_context(|| format!("{name} record {}{hint}", record.label(index)))?;
        let number = range.number;
        ensure!(
            usize::try_from(number).is_ok_and(|n| (1..=expected).contains(&n)),
            "{name} {number} is outside 1..={expected}{hint}"
        );
        ensure!(
            ranges.insert(number, range).is_none(),
            "{name} {number} is listed twice"
        );
    }
    ensure!(
        ranges.len() == expected,
        "{} {name} records, expected {expected}{hint}",
        ranges.len()
    );

    let index: BTreeMap<AyahKey, usize> = ayahs.iter().enumerate().map(|(i, k)| (*k, i)).collect();
    let position = |key: AyahKey, number: u32, field: &str| -> anyhow::Result<usize> {
        index
            .get(&key)
            .copied()
            .ok_or_else(|| anyhow!("{name} {number}: {field} {key} is not an ayah"))
    };
    let mut numbers = vec![0_u32; ayahs.len()];
    let mut next = 0_usize;
    for (&number, range) in &ranges {
        let first = position(range.first, number, "first_verse_key")?;
        let last = position(range.last, number, "last_verse_key")?;
        ensure!(
            first == next,
            "{name} {number} starts at {}, expected {} (a gap or an overlap with {name} {})",
            range.first,
            ayahs.get(next).map_or_else(
                || "nothing: every ayah is covered".to_owned(),
                ToString::to_string
            ),
            number.saturating_sub(1)
        );
        ensure!(
            last >= first,
            "{name} {number} ends at {}, before it starts ({})",
            range.last,
            range.first
        );
        let span = ayahs
            .get(first..=last)
            .ok_or_else(|| anyhow!("{name} {number}: ayah range {first}..={last}"))?;
        if let Some(count) = range.verses_count {
            ensure!(
                usize::try_from(count).ok() == Some(span.len()),
                "{name} {number}: verses_count {count}, but {}–{} holds {} ayahs",
                range.first,
                range.last,
                span.len()
            );
        }
        if let Some(mapping) = &range.mapping {
            let expected_set: BTreeSet<AyahKey> = span.iter().copied().collect();
            ensure!(
                *mapping == expected_set,
                "{name} {number}: verse_mapping covers {} ayah(s) ({} not in {}–{}; {} of the range missing)",
                mapping.len(),
                list(mapping.difference(&expected_set)),
                range.first,
                range.last,
                list(expected_set.difference(mapping))
            );
        }
        for slot in numbers
            .get_mut(first..=last)
            .ok_or_else(|| anyhow!("{name} {number}: ayah range {first}..={last}"))?
        {
            *slot = number;
        }
        next = last + 1;
    }
    ensure!(
        next == ayahs.len(),
        "the last {name} ends at {}, before the last ayah {}",
        next.checked_sub(1)
            .and_then(|i| ayahs.get(i))
            .map_or_else(|| "nothing".to_owned(), ToString::to_string),
        ayahs
            .last()
            .map_or_else(|| "nothing".to_owned(), ToString::to_string)
    );
    Ok(numbers)
}

fn division_range(division: Division, record: &Record) -> anyhow::Result<DivisionRange> {
    let fields = &record.fields;
    let key = |field: &str| -> anyhow::Result<AyahKey> {
        json_field_string(fields, &[field])?
            .ok_or_else(|| anyhow!("no {field}"))?
            .trim()
            .parse()
            .with_context(|| field.to_owned())
    };
    Ok(DivisionRange {
        number: record_number(record, division.number_fields())?,
        first: key("first_verse_key")?,
        last: key("last_verse_key")?,
        verses_count: json_field_u32(fields, &["verses_count"])?,
        mapping: json_field(fields, &["verse_mapping"])
            .map(|(_, value)| verse_mapping(value))
            .transpose()
            .context("verse_mapping")?
            .flatten(),
    })
}

/// `{"2": "1-141", "3": "5"}` (an object, or that object as JSON text in the SQLite export) → the ayahs it names.
fn verse_mapping(value: &Value) -> anyhow::Result<Option<BTreeSet<AyahKey>>> {
    let parsed: Value;
    let map = match value {
        Value::Null => return Ok(None),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => {
            parsed = serde_json::from_str(text).context("parse the JSON text")?;
            parsed
                .as_object()
                .ok_or_else(|| anyhow!("{text:?} is not a JSON object"))?
        }
        Value::Object(map) => map,
        other => bail!("{other} is not an object"),
    };
    let mut ayahs = BTreeSet::new();
    for (surah, range) in map {
        let surah: u32 = surah
            .trim()
            .parse()
            .with_context(|| format!("surah {surah:?}"))?;
        let (from, to) = match range {
            Value::String(text) => verse_range(text)?,
            Value::Number(_) => {
                let ayah = json_u32(range)
                    .map_err(|e| anyhow!("surah {surah}: {e}"))?
                    .ok_or_else(|| anyhow!("surah {surah}: no ayah"))?;
                (ayah, ayah)
            }
            other => bail!("surah {surah}: {other} is not an ayah range"),
        };
        ensure!(
            from >= 1 && from <= to,
            "surah {surah}: {from}-{to} is not an ayah range"
        );
        for ayah in from..=to {
            ensure!(
                ayahs.insert(AyahKey::new(surah, ayah)),
                "{surah}:{ayah} is listed twice"
            );
        }
    }
    Ok(Some(ayahs))
}

/// `"1-141"` → (1, 141); `"5"` → (5, 5).
fn verse_range(text: &str) -> anyhow::Result<(u32, u32)> {
    let number = |s: &str| -> anyhow::Result<u32> {
        s.trim()
            .parse()
            .with_context(|| format!("{text:?} is not an ayah range"))
    };
    match text.split_once('-') {
        Some((from, to)) => Ok((number(from)?, number(to)?)),
        None => {
            let ayah = number(text)?;
            Ok((ayah, ayah))
        }
    }
}

// ---- report ---------------------------------------------------------------------------------------------------------

/// What one layout export provided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutSource {
    pub layout: MushafLayout,
    pub name: Option<String>,
    pub font: Option<String>,
    /// The ids were mapped through the layout's own `words` table (else through script 61).
    pub own_word_ids: bool,
    pub ayah_lines: usize,
    pub centred_ayah_lines: usize,
    pub surah_name_lines: usize,
    pub basmallah_lines: usize,
}

impl LayoutSource {
    fn new(layout: &Layout, file: &LayoutFile, own_word_ids: bool) -> Self {
        let lines = || layout.pages.iter().flat_map(|p| &p.lines);
        let count = |kind: LineKind| lines().filter(|l| l.kind == Some(kind)).count();
        Self {
            layout: layout.layout,
            name: file.info.as_ref().and_then(|i| i.name.clone()),
            font: file.info.as_ref().and_then(|i| i.font.clone()),
            own_word_ids,
            ayah_lines: count(LineKind::Ayah),
            centred_ayah_lines: lines()
                .filter(|l| l.kind == Some(LineKind::Ayah) && l.centered == Some(true))
                .count(),
            surah_name_lines: count(LineKind::SurahName),
            basmallah_lines: count(LineKind::Basmallah),
        }
    }
}

/// What the qul adapter read (printed by [`load`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QulReport {
    /// One line per input: `key = file (QUL n "title", format, sha256 prefix)`.
    pub inputs: Vec<String>,
    /// `meta.source_manifest_sha256`.
    pub manifest_sha256: String,
    pub words: usize,
    /// The largest QUL `word_index` of script 61 (`None` if it has none).
    pub word_index_max: Option<u32>,
    /// The ids in `1..=word_index_max` that name no word (QUL numbers 83,668 slots for 83,665 words).
    pub unused_word_indexes: Vec<u32>,
    /// Scripts whose `word_index` names another location than script 61's for this many words (joins are by
    /// location, so this is only a sign of exports from different QUL versions).
    pub id_disagreements: Vec<(Input, usize)>,
    pub layouts: Vec<LayoutSource>,
    /// The optional cross-check inputs present (`meta.juz`, `meta.hizb`, `meta.manzil`).
    pub cross_checks: Vec<Input>,
}

impl QulReport {
    /// The report, one line each.
    #[must_use]
    pub fn lines(&self) -> Vec<String> {
        let mut lines = self.inputs.clone();
        lines.push(format!(
            "manifest sha256 {} (meta.source_manifest_sha256)",
            self.manifest_sha256
        ));
        lines.push(format!(
            "words: {} locations, identical in the four scripts; {}",
            self.words,
            match self.word_index_max {
                Some(max) => format!(
                    "QUL word_index 1..={max} with {} unused value(s){}",
                    self.unused_word_indexes.len(),
                    if self.unused_word_indexes.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", list(&self.unused_word_indexes))
                    }
                ),
                None => "script.code_v2 has no word_index".to_owned(),
            }
        ));
        for (input, count) in &self.id_disagreements {
            if *count > 0 {
                lines.push(format!(
                    "warning: {} gives {count} word(s) another word_index than script.code_v2 (exports of \
                     different QUL versions? words are joined by location, so the build is unaffected)",
                    input.key()
                ));
            }
        }
        for layout in &self.layouts {
            lines.push(format!(
                "layout {} ({}{}): {} ayah lines ({} centred), {} surah_name, {} basmallah; word ids via {}",
                mushaf_spec(layout.layout).code,
                layout.name.as_deref().unwrap_or("no info row"),
                layout
                    .font
                    .as_deref()
                    .map(|f| format!(", font {f}"))
                    .unwrap_or_default(),
                layout.ayah_lines,
                layout.centred_ayah_lines,
                layout.surah_name_lines,
                layout.basmallah_lines,
                if layout.own_word_ids {
                    "its own words table"
                } else {
                    "script.code_v2"
                }
            ));
        }
        let missing: Vec<&str> = [Input::Juz, Input::Hizb, Input::Manzil]
            .into_iter()
            .filter(|i| !self.cross_checks.contains(i))
            .map(Input::key)
            .collect();
        lines.push(format!(
            "divisions: rub from QUL {} (stored); juz/hizb/manzil from Tanzil, cross-checked against {}",
            Input::Rub.resource().unwrap_or_default(),
            if missing.is_empty() {
                "QUL 68/67/66".to_owned()
            } else if missing.len() == 3 {
                "nothing (meta.juz/hizb/manzil are not in the manifest)".to_owned()
            } else {
                format!(
                    "{} (not in the manifest: {})",
                    list(self.cross_checks.iter().map(|i| i.key())),
                    missing.join(", ")
                )
            }
        ));
        lines
    }
}

fn describe_inputs(inputs: &Inputs, scripts: &[Script], layouts: &[LayoutSource]) -> Vec<String> {
    inputs
        .files()
        .map(|file| {
            let format = match file.input {
                input if input.layout().is_some() => {
                    let own = layouts
                        .iter()
                        .any(|l| Some(l.layout) == input.layout() && l.own_word_ids);
                    format!("SQLite pages{}", if own { " + words" } else { "" })
                }
                input if Input::SCRIPTS.contains(&input) => scripts
                    .iter()
                    .find(|s| s.input == input)
                    .map_or_else(String::new, |s| {
                        format!("{}, {} rows", s.format, s.rows.len())
                    }),
                Input::Tanzil => "XML".to_owned(),
                _ if is_sqlite(&file.bytes) => "SQLite".to_owned(),
                _ => "JSON".to_owned(),
            };
            let source = file.resource.map_or_else(
                || "Tanzil".to_owned(),
                |id| format!("QUL {id} \"{}\"", file.input.title()),
            );
            format!(
                "{} = {} ({source}, {format}, sha256 {}…)",
                file.input.key(),
                file.file,
                file.sha256.get(..12).unwrap_or(&file.sha256)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_input_table_is_consistent() {
        let keys: BTreeSet<&str> = Input::ALL.iter().map(|i| i.key()).collect();
        assert_eq!(keys.len(), Input::ALL.len(), "keys are unique");
        let resources: BTreeSet<u32> = Input::ALL.iter().filter_map(|i| i.resource()).collect();
        assert_eq!(
            resources.len(),
            Input::ALL.len() - 1,
            "one QUL resource each, Tanzil has none"
        );
        let mut sorted = Input::ALL;
        sorted.sort();
        assert_eq!(sorted, Input::ALL, "ALL is in declaration (BTreeMap) order");
        assert_eq!(
            Input::Imlaei.resource(),
            Some(54),
            "QUL 54 = Imla'i with diacritics, 60 = simple"
        );
        assert_eq!(Input::Rub.resource(), Some(63), "QUL 63 = Rub, 67 = Hizb");
        assert_eq!(
            Input::LayoutV4.url(),
            "https://qul.tarteel.ai/resources/mushaf-layout/19"
        );
        assert_eq!(
            Input::TextHafs.url(),
            "https://qul.tarteel.ai/resources/quran-script/312"
        );
        assert_eq!(
            Input::Rub.url(),
            "https://qul.tarteel.ai/resources/quran-metadata/63"
        );
        assert_eq!(Input::Tanzil.url(), tanzil::URL);
        let layouts: Vec<MushafLayout> = Input::LAYOUTS.iter().filter_map(|i| i.layout()).collect();
        assert_eq!(layouts, MUSHAFS.map(|m| m.layout));
        assert!(Input::ALL.iter().filter(|i| !i.required()).eq(&[
            Input::Juz,
            Input::Hizb,
            Input::Manzil
        ]));
        for division in Division::ALL {
            assert!(!division.number_fields().is_empty());
            assert_eq!(
                Input::ALL
                    .iter()
                    .filter(|i| **i == division.input())
                    .count(),
                1
            );
        }
    }

    #[test]
    fn recorded_hashes_and_file_names() {
        let hex = "8867C1D88191472ADEC9DB694B3CD9F135B1A2EF580574D32CF888DCB22C5C7A";
        assert_eq!(recorded_hash(hex), Recorded::Hash(hex.to_ascii_lowercase()));
        assert_eq!(recorded_hash(""), Recorded::NotYet);
        let longer = format!("{hex}0");
        let not_hex = hex.replace('8', "g");
        for bad in ["…", "abc", &hex[1..], &longer, &not_hex] {
            assert_eq!(recorded_hash(bad), Recorded::Invalid, "{bad}");
        }
        assert!(check_relative_file("layout-10.sqlite").is_ok());
        assert!(check_relative_file("qul-2026/layout-10.sqlite").is_ok());
        for bad in [
            "",
            "../core.db",
            "a/../b",
            "./a",
            "/etc/passwd",
            "C:/x.db",
            "a\\b",
            "a//b",
            "a/",
        ] {
            assert!(check_relative_file(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn cell_and_field_conversions() {
        assert_eq!(sql_u32(ValueRef::Null), Ok(None));
        assert_eq!(sql_u32(ValueRef::Text(b"")), Ok(None), "QUL's '' for NULL");
        assert_eq!(sql_u32(ValueRef::Text(b" 12 ")), Ok(Some(12)));
        assert_eq!(sql_u32(ValueRef::Integer(83_668)), Ok(Some(83_668)));
        assert!(sql_u32(ValueRef::Integer(-1)).is_err());
        assert!(sql_u32(ValueRef::Real(1.5)).is_err());
        assert!(sql_u32(ValueRef::Text(b"x")).is_err());
        assert_eq!(sql_text(ValueRef::Integer(7)), Ok(Some("7".to_owned())));
        assert!(sql_text(ValueRef::Blob(b"x")).is_err());
        assert_eq!(json_u32(&Value::from("114")), Ok(Some(114)));
        assert_eq!(json_u32(&Value::from(3)), Ok(Some(3)));
        assert!(json_u32(&Value::from(-3)).is_err());
        assert!(json_u32(&Value::from(true)).is_err());
        assert_eq!(json_bool(&Value::from(0)), Ok(false));
        assert_eq!(json_bool(&Value::from("true")), Ok(true));
        assert!(json_bool(&Value::from(2)).is_err());
        assert_eq!(verse_range("1-141").unwrap(), (1, 141));
        assert_eq!(verse_range(" 5 ").unwrap(), (5, 5));
        assert!(verse_range("1-x").is_err());
        let mapping = verse_mapping(&serde_json::json!({"1": "1-7", "2": "1-2"})).unwrap();
        assert_eq!(mapping.map(|m| m.len()), Some(9));
        let text = verse_mapping(&Value::from(r#"{"2":"5","3":7}"#))
            .unwrap()
            .unwrap();
        assert!(text.contains(&AyahKey::new(2, 5)) && text.contains(&AyahKey::new(3, 7)));
        assert!(verse_mapping(&Value::from("[1]")).is_err());
        assert!(verse_mapping(&serde_json::json!({"1": "7-1"})).is_err());
        assert_eq!(verse_mapping(&Value::Null).unwrap(), None);
    }

    #[test]
    fn lists_are_capped() {
        assert_eq!(list([1, 2, 3]), "1, 2, 3");
        let long = list(1..=20);
        assert!(long.ends_with("12 … and 8 more"), "{long}");
        assert_eq!(list(Vec::<u32>::new()), "");
    }

    #[test]
    fn script_rows_complete_and_check_locations() {
        let row = script_row(
            Some(5),
            "1:1:5",
            Some("١".into()),
            [Some(1), Some(1), Some(5)],
        )
        .unwrap();
        assert_eq!(row.location, Ok(Location::new(1, 1, 5)));
        let short = script_row(None, "2:3", None, [None, None, Some(4)]).unwrap();
        assert_eq!(short.location, Ok(Location::new(2, 3, 4)), "s:a + word");
        let raw = script_row(Some(6439), "3:0:1", None, [None, None, None]).unwrap();
        assert_eq!(raw.location, Err("3:0:1".to_owned()), "kept for the report");
        assert!(script_row(None, "1:1:5", None, [Some(2), None, None]).is_err());
        assert!(script_row(None, "1:1:5", None, [None, None, Some(4)]).is_err());
    }
}
