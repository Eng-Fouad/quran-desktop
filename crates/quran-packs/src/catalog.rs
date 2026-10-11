//! The curated `catalog.json` (resource `data/catalog.json`): model, validation, the onboarding starter set and the
//! catalog views the pack manager builds on (docs/ARCHITECTURE.md §2.5.3, §2.5.4). Owner: WP5a.
//!
//! - **Model.** The serde types mirror the §2.5.4 TypeScript notation exactly: camelCase keys, unknown fields rejected,
//!   `source` is the frozen [`Adapter`] union. The only addition is the optional `$schema` key, so editors validate the
//!   file against `catalog.schema.json` (draft 2020-12, committed next to it).
//! - **Validation.** [`Catalog::issues`] collects every structural problem at once (ids, kinds, adapters, install modes,
//!   item counts, sizes, languages, directions, tokenizers, URLs, digests, `requires`, revalidation, uniqueness, and the
//!   BRIEF §4 rule that The Clear Quran is never listed). [`Catalog::starter_issues`] adds what onboarding needs on top
//!   (§2.5.4 starter set). `cargo xtask catalog-check` runs both, plus the JSON Schema and, with `--online`, live probes.
//! - **Views.** [`CatalogPack::info`] / [`CatalogPack::summary`] build the IPC DTOs, [`Catalog::reciters`] the
//!   catalog-level [`ReciterInfo`] list (`word_level` from the one-time probe until real timings override it), and
//!   [`Catalog::starter_set`] the exact onboarding starter set.
//!
//! Nothing here does IO except [`Catalog::load`], and nothing panics (§0.2).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;

use quran_core::PackTokenizer;
use quran_types::{
    Attribution, InstallMode, JobSnapshot, L10nText, MushafStyle, PAGE_COUNT, PackInfo, PackKind,
    PackState, PackSummary, ReciterInfo, SURAH_COUNT, Settings, TextDir, UiLanguage,
};
use serde::{Deserialize, Serialize};

use crate::adapters::{FontVariant, QdcAudioConfig, StaticFile};
use crate::{Adapter, PackError};

/// The only `catalogVersion` this build understands.
pub const CATALOG_VERSION: u32 = 1;

/// The `$schema` value of the shipped catalog (the JSON Schema committed next to it).
pub const SCHEMA_REF: &str = "./catalog.schema.json";

/// Id of the decor pack every `mushaf.*` pack requires and the starter set always contains (§2.5.3, §2.5.4).
pub const DECOR_PACK_ID: &str = "decor";

/// The files a `static_files` pack may install: exactly the `quran://` decor routes (§6.2), stored under `packs/decor/`.
/// The first three are the `decor` pack (FACT §4.2); the last is the optional `decor.nastaliq` pack (§9.3).
pub const DECOR_FILES: [&str; 4] = [
    "qcf-surah-header.woff2",
    "quran-common.ttf",
    "sura-names.woff2",
    "noto-nastaliq-urdu.woff2",
];

/// Languages Quran.com serves a word-by-word gloss for (`/api/v4/resources/word_by_word_translations`, verified
/// 2026-10-10). Any other `language=` silently falls back to English, so a `wbw.*` pack outside this list would install
/// English under another name.
pub const QURANCOM_WBW_LANGUAGES: [&str; 9] =
    ["en", "ur", "id", "bn", "tr", "fa", "hi", "ta", "inh"];

/// QF terms allow caching QF content for at most 7 days (BRIEF §4, §2.5.7).
pub const QF_MAX_REVALIDATE_DAYS: u32 = 7;

/// Content languages written right to left (BCP-47 primary subtags).
const RTL_LANGUAGES: [&str; 11] = [
    "ar", "ckb", "dv", "fa", "he", "ku", "ps", "sd", "ug", "ur", "yi",
];

/// §3.4: languages whose `fold` is `normalize_ar(plain, Loose)`.
const ARABIC_SCRIPT_LANGUAGES: [&str; 5] = ["ar", "ur", "fa", "ps", "ku"];

/// §3.4: languages written without spaces between words (no FTS table, `LIKE` search).
const LIKE_FALLBACK_LANGUAGES: [&str; 5] = ["zh", "ja", "ko", "th", "km"];

/// `{ $schema?; catalogVersion: 1; generatedAt; packs }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    /// Editor hint (`./catalog.schema.json`); ignored by the app.
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// Always [`CATALOG_VERSION`].
    pub catalog_version: u32,
    /// ISO date (`YYYY-MM-DD`) of the last curation.
    pub generated_at: String,
    pub packs: Vec<CatalogPack>,
}

/// One installable pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPack {
    /// `/^decor$|^[a-z0-9]+(\.[a-z0-9_]+)+$/`, shaped per kind (§2.5.3).
    pub id: String,
    pub kind: PackKind,
    pub title: L10nText,
    pub description: L10nText,
    /// BCP-47 of the content (`"en"`, `"ar"`, `"ur"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<TextDir>,
    /// Upstream version, or `"YYYY.MM"`.
    pub version: String,
    pub install_mode: InstallMode,
    /// E.g. `["decor"]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    /// Full-install estimate, shown before download: exact download bytes for files, measured storage for content.db
    /// packs.
    pub size_bytes: u64,
    pub item_count: u32,
    /// Starter-set candidate for onboarding (at most one per kind and language).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recommended: bool,
    /// 1..=7 for QF-sourced content (§2.5.7), absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revalidate_days: Option<u32>,
    pub attribution: Attribution,
    pub source: Adapter,
}

/// One validation problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogIssue {
    /// The pack the problem is in; `None` for catalog-level problems.
    pub pack_id: Option<String>,
    pub message: String,
}

impl fmt::Display for CatalogIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.pack_id {
            Some(id) => write!(f, "{id}: {}", self.message),
            None => write!(f, "catalog: {}", self.message),
        }
    }
}

impl Catalog {
    /// A catalog without packs (the inert pack manager, and the build.rs placeholder's content).
    #[must_use]
    pub fn empty() -> Self {
        Self {
            schema: None,
            catalog_version: CATALOG_VERSION,
            generated_at: "1970-01-01".to_owned(),
            packs: Vec::new(),
        }
    }

    /// Strict deserialisation (unknown fields and adapters are errors).
    pub fn from_json(json: &str) -> Result<Self, PackError> {
        serde_json::from_str(json).map_err(|e| PackError::Catalog(e.to_string()))
    }

    /// Reads and parses `path` (not validated: call [`Catalog::validate`]).
    pub fn load(path: &Path) -> Result<Self, PackError> {
        let json = std::fs::read_to_string(path)?;
        Self::from_json(&json)
    }

    /// [`Catalog::load`] then [`Catalog::validate`]: what the pack manager uses at startup.
    pub fn load_validated(path: &Path) -> Result<Self, PackError> {
        let catalog = Self::load(path)?;
        catalog.validate()?;
        Ok(catalog)
    }

    /// The id rules and the `requires`/`kind`/adapter consistency rules (§2.5.4), all problems in one error.
    pub fn validate(&self) -> Result<(), PackError> {
        into_result(self.issues())
    }

    /// [`Catalog::validate`] plus [`Catalog::starter_issues`]: the bar the shipped catalog meets (`catalog-check`).
    pub fn validate_release(&self) -> Result<(), PackError> {
        let mut issues = self.issues();
        issues.extend(self.starter_issues());
        into_result(issues)
    }

    /// Every structural problem, in catalog order (empty when valid).
    #[must_use]
    pub fn issues(&self) -> Vec<CatalogIssue> {
        let mut c = Checker::default();
        c.catalog(self);
        c.issues
    }

    /// What onboarding needs from the catalog on top of [`Catalog::issues`] (§2.5.4, §9.7): `decor`, a page-font pack for
    /// every QCF style with exactly one recommended, a default translation for each UI language, the default reciter
    /// as the one recommended recitation, and WBW for the English UI.
    #[must_use]
    pub fn starter_issues(&self) -> Vec<CatalogIssue> {
        let mut c = Checker::default();
        c.starter(self);
        c.issues
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&CatalogPack> {
        self.packs.iter().find(|p| p.id == id)
    }

    /// [`Catalog::get`], or `PackError::NotFound`.
    pub fn require(&self, id: &str) -> Result<&CatalogPack, PackError> {
        self.get(id)
            .ok_or_else(|| PackError::NotFound(format!("pack {id} is not in the catalog")))
    }

    /// The packs of one kind, in catalog order.
    pub fn of_kind(&self, kind: PackKind) -> impl Iterator<Item = &CatalogPack> {
        self.packs.iter().filter(move |p| p.kind == kind)
    }

    /// Every pack as `NotInstalled` (`export-fixtures --only packs`, and the list before the registry is read).
    #[must_use]
    pub fn infos(&self) -> Vec<PackInfo> {
        self.packs
            .iter()
            .map(|p| p.info(PackState::NotInstalled, 0, None))
            .collect()
    }

    /// The page-font pack a QCF style renders with; `None` for `hafs` (bundled font, no pack).
    #[must_use]
    pub fn mushaf_pack(&self, style: MushafStyle) -> Option<&CatalogPack> {
        let variant = FontVariant::for_style(style)?;
        self.of_kind(PackKind::MushafFonts)
            .find(|p| p.font_variant() == Some(variant))
    }

    /// The `wbw.*` pack for a gloss language (ISO code, e.g. `"en"`).
    #[must_use]
    pub fn wbw_pack(&self, language: &str) -> Option<&CatalogPack> {
        self.of_kind(PackKind::Wbw).find(|p| match &p.source {
            Adapter::QurancomWbw(c) => c.language == language,
            _ => false,
        })
    }

    /// The recitation pack and its source config for a QDC reciter id.
    #[must_use]
    pub fn reciter(&self, reciter_id: u32) -> Option<(&CatalogPack, &QdcAudioConfig)> {
        self.of_kind(PackKind::Recitation).find_map(|p| {
            p.reciter()
                .filter(|c| c.reciter_id == reciter_id)
                .map(|c| (p, c))
        })
    }

    /// `(name, basmala_in_file)` for the audio planner (`PackManager::reciter_meta`).
    #[must_use]
    pub fn reciter_meta(&self, reciter_id: u32) -> Option<(L10nText, bool)> {
        self.reciter(reciter_id)
            .map(|(_, c)| (c.name.clone(), c.basmala_in_file))
    }

    /// Every reciter in catalog order, with nothing downloaded or cached. `word_level` is the catalog's probe result,
    /// which the pack manager overrides once real timings for the reciter are stored.
    #[must_use]
    pub fn reciters(&self) -> Vec<ReciterInfo> {
        self.of_kind(PackKind::Recitation)
            .filter_map(|p| {
                p.reciter().map(|c| ReciterInfo {
                    id: c.reciter_id,
                    pack_id: p.id.clone(),
                    name: c.name.clone(),
                    style: c.style.clone(),
                    word_level: c.word_level,
                    size_kib: p.size_kib(),
                    downloaded_surahs: 0,
                    cached_surahs: 0,
                })
            })
            .collect()
    }

    /// Onboarding's preselected translation for a UI language: the recommended translation in that language, else the
    /// recommended tafsir in it (`en` → `tr.en.saheeh`, `ar` → `tafsir.ar.muyassar`).
    #[must_use]
    pub fn default_translation(&self, ui: UiLanguage) -> Option<&CatalogPack> {
        let code = ui_code(ui);
        let recommended = |kind: PackKind| {
            self.of_kind(kind)
                .find(|p| p.recommended && p.language_subtag().as_deref() == Some(code))
        };
        recommended(PackKind::Translation).or_else(|| recommended(PackKind::Tafsir))
    }

    /// The exact onboarding starter set (§2.5.4), in its order:
    /// 1. `decor`, downloaded now (for every style, hafs included);
    /// 2. the chosen translation, downloaded now (an on-demand Quran.com tafsir chosen here downloads by chapter);
    /// 3. the chosen style's page fonts **on demand**, or downloaded now when "Download all pages" is ticked (hafs has
    ///    no pack);
    /// 4. WBW for the UI language, on demand (none when Quran.com has no gloss in that language, e.g. Arabic);
    /// 5. the chosen reciter's timings, fetched on first play; audio streams and is cached (never bulk-downloaded).
    ///
    /// Anything a "now" pack `requires` is added as "now" too. [`StarterSet::download_now_bytes`] is the exact total
    /// shown above "Download now".
    pub fn starter_set(&self, choices: &StarterChoices) -> Result<StarterSet, PackError> {
        let mut set = StarterSet { items: Vec::new() };
        let decor = self
            .get(DECOR_PACK_ID)
            .filter(|p| p.kind == PackKind::Decor)
            .ok_or_else(|| {
                PackError::Catalog("the starter set needs the `decor` pack".to_owned())
            })?;
        set.push(decor, StarterFetch::Now);

        if let Some(id) = &choices.translation {
            let pack = self.require(id)?;
            if !matches!(pack.kind, PackKind::Translation | PackKind::Tafsir) {
                return Err(PackError::Catalog(format!(
                    "{id} is not a translation or tafsir pack"
                )));
            }
            let fetch = match pack.install_mode {
                InstallMode::Whole => StarterFetch::Now,
                InstallMode::OnDemand => StarterFetch::OnDemand,
            };
            set.push(pack, fetch);
        }

        if FontVariant::for_style(choices.style).is_some() {
            let pack = self.mushaf_pack(choices.style).ok_or_else(|| {
                PackError::Catalog(format!("no page-font pack for style {:?}", choices.style))
            })?;
            let fetch = if choices.download_all_pages {
                StarterFetch::Now
            } else {
                StarterFetch::OnDemand
            };
            set.push(pack, fetch);
        }

        if let Some(pack) = self.wbw_pack(ui_code(choices.ui_language)) {
            set.push(pack, StarterFetch::OnDemand);
        }

        let (reciter, _) = self.reciter(choices.reciter_id).ok_or_else(|| {
            PackError::NotFound(format!(
                "reciter {} is not in the catalog",
                choices.reciter_id
            ))
        })?;
        set.push(reciter, StarterFetch::TimingsOnFirstPlay);

        self.close_requirements(&mut set);
        Ok(set)
    }

    /// Adds, as "now", every pack a "now" item requires (transitively) that is not in the set yet.
    fn close_requirements(&self, set: &mut StarterSet) {
        let mut queue: Vec<String> = set
            .items
            .iter()
            .filter(|i| i.fetch == StarterFetch::Now)
            .flat_map(|i| {
                self.get(&i.pack_id)
                    .map(|p| p.requires.clone())
                    .unwrap_or_default()
            })
            .collect();
        while let Some(id) = queue.pop() {
            if set.items.iter().any(|i| i.pack_id == id) {
                continue;
            }
            if let Some(pack) = self.get(&id) {
                queue.extend(pack.requires.iter().cloned());
                set.push(pack, StarterFetch::Now);
            }
        }
    }
}

impl CatalogPack {
    /// `size_bytes` in KiB, rounded up (the IPC unit, §0.2); saturates at `u32::MAX`.
    #[must_use]
    pub fn size_kib(&self) -> u32 {
        u32::try_from(self.size_bytes.div_ceil(1024)).unwrap_or(u32::MAX)
    }

    /// The IPC view of this pack in a given registry state.
    #[must_use]
    pub fn info(&self, state: PackState, installed_kib: u32, job: Option<JobSnapshot>) -> PackInfo {
        PackInfo {
            id: self.id.clone(),
            kind: self.kind,
            title: self.title.clone(),
            description: self.description.clone(),
            language: self.language.clone(),
            direction: self.direction,
            version: self.version.clone(),
            install_mode: self.install_mode,
            requires: self.requires.clone(),
            size_kib: self.size_kib(),
            item_count: self.item_count,
            recommended: self.recommended,
            revalidate_days: self.revalidate_days,
            attribution: self.attribution.clone(),
            state,
            installed_kib,
            job,
        }
    }

    /// The short IPC view (`Bootstrap.packs`).
    #[must_use]
    pub fn summary(&self, state: PackState) -> PackSummary {
        PackSummary {
            id: self.id.clone(),
            kind: self.kind,
            title: self.title.clone(),
            language: self.language.clone(),
            state,
        }
    }

    /// The QDC reciter config of a recitation pack.
    #[must_use]
    pub fn reciter(&self) -> Option<&QdcAudioConfig> {
        match &self.source {
            Adapter::QdcAudio(c) => Some(c),
            _ => None,
        }
    }

    /// The glyph variant of a page-font pack.
    #[must_use]
    pub fn font_variant(&self) -> Option<FontVariant> {
        match &self.source {
            Adapter::QcfFontPages(c) => Some(c.variant),
            _ => None,
        }
    }

    /// Whether the content comes from Quran Foundation APIs and is revalidated every `revalidate_days` (§2.5.7).
    #[must_use]
    pub const fn is_qf_sourced(&self) -> bool {
        matches!(
            self.source,
            Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_) | Adapter::QdcAudio(_)
        )
    }

    /// The lowercase BCP-47 primary subtag of `language` (`"en"` for `"en-GB"`).
    #[must_use]
    pub fn language_subtag(&self) -> Option<String> {
        self.language.as_deref().map(primary_subtag)
    }
}

/// What onboarding chose (§9.7 steps 1–3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterChoices {
    pub ui_language: UiLanguage,
    /// The translation (or tafsir) pack picked in the translation select; `None` = no translation.
    pub translation: Option<String>,
    pub style: MushafStyle,
    /// "Download all pages in the background" (off by default).
    pub download_all_pages: bool,
    pub reciter_id: u32,
}

impl StarterChoices {
    /// Onboarding's preselection: the UI language's [`Catalog::default_translation`], the default style and reciter
    /// from `Settings::default()`, and "Download all pages" off.
    #[must_use]
    pub fn defaults(catalog: &Catalog, ui_language: UiLanguage) -> Self {
        let settings = Settings::default();
        Self {
            ui_language,
            translation: catalog
                .default_translation(ui_language)
                .map(|p| p.id.clone()),
            style: settings.mushaf_style,
            download_all_pages: false,
            reciter_id: settings.reciter_id,
        }
    }
}

/// When a starter-set pack is fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StarterFetch {
    /// Installed (scope `All`) by "Download now".
    Now,
    /// Nothing now: items download as they are viewed (pages, WBW chapters).
    OnDemand,
    /// Nothing now: the reciter's timings are fetched on first play, and audio streams and is cached.
    TimingsOnFirstPlay,
}

/// One pack of the starter set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterItem {
    pub pack_id: String,
    pub fetch: StarterFetch,
    /// What "Download now" fetches for this pack: its `size_bytes` when [`StarterFetch::Now`], else 0.
    pub bytes_now: u64,
}

/// The onboarding starter set (§2.5.4), in order and without duplicates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StarterSet {
    pub items: Vec<StarterItem>,
}

impl StarterSet {
    /// The exact total shown above "Download now".
    #[must_use]
    pub fn download_now_bytes(&self) -> u64 {
        self.items.iter().map(|i| i.bytes_now).sum()
    }

    /// The packs "Download now" installs with scope `All`, in order.
    #[must_use]
    pub fn download_now(&self) -> Vec<&str> {
        self.items
            .iter()
            .filter(|i| i.fetch == StarterFetch::Now)
            .map(|i| i.pack_id.as_str())
            .collect()
    }

    /// The item for a pack.
    #[must_use]
    pub fn get(&self, pack_id: &str) -> Option<&StarterItem> {
        self.items.iter().find(|i| i.pack_id == pack_id)
    }

    fn push(&mut self, pack: &CatalogPack, fetch: StarterFetch) {
        if let Some(existing) = self.items.iter_mut().find(|i| i.pack_id == pack.id) {
            if fetch == StarterFetch::Now && existing.fetch != StarterFetch::Now {
                existing.fetch = StarterFetch::Now;
                existing.bytes_now = pack.size_bytes;
            }
            return;
        }
        self.items.push(StarterItem {
            pack_id: pack.id.clone(),
            fetch,
            bytes_now: if fetch == StarterFetch::Now {
                pack.size_bytes
            } else {
                0
            },
        });
    }
}

/// Whether `id` matches `/^decor$|^[a-z0-9]+(\.[a-z0-9_]+)+$/` (§2.5.4).
#[must_use]
pub fn is_valid_pack_id(id: &str) -> bool {
    if id == DECOR_PACK_ID {
        return true;
    }
    let mut segments = id.split('.');
    let head_ok = segments.next().is_some_and(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    });
    let mut tail = 0usize;
    for s in segments {
        if s.is_empty()
            || !s
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        {
            return false;
        }
        tail += 1;
    }
    head_ok && tail >= 1
}

/// The writing direction of a content language (BCP-47; only the primary subtag counts).
#[must_use]
pub fn language_direction(language: &str) -> TextDir {
    if RTL_LANGUAGES.contains(&primary_subtag(language).as_str()) {
        TextDir::Rtl
    } else {
        TextDir::Ltr
    }
}

/// The pack tokenizer §3.4 assigns to a content language: `porter_unicode61` for English, `arabic_normalized` for
/// Arabic-script languages, `like_fallback` for languages written without spaces, `unicode61_remove_diacritics` else.
#[must_use]
pub fn tokenizer_for_language(language: &str) -> PackTokenizer {
    let primary = primary_subtag(language);
    if primary == "en" {
        PackTokenizer::PorterUnicode61
    } else if ARABIC_SCRIPT_LANGUAGES.contains(&primary.as_str()) {
        PackTokenizer::ArabicNormalized
    } else if LIKE_FALLBACK_LANGUAGES.contains(&primary.as_str()) {
        PackTokenizer::LikeFallback
    } else {
        PackTokenizer::Unicode61RemoveDiacritics
    }
}

const fn ui_code(ui: UiLanguage) -> &'static str {
    match ui {
        UiLanguage::En => "en",
        UiLanguage::Ar => "ar",
    }
}

fn primary_subtag(language: &str) -> String {
    language
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn into_result(issues: Vec<CatalogIssue>) -> Result<(), PackError> {
    if issues.is_empty() {
        return Ok(());
    }
    let count = issues.len();
    let list = issues
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ");
    Err(PackError::Catalog(format!(
        "{count} problem{}: {list}",
        if count == 1 { "" } else { "s" }
    )))
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation

#[derive(Default)]
struct Checker {
    issues: Vec<CatalogIssue>,
}

impl Checker {
    fn global(&mut self, message: impl Into<String>) {
        self.issues.push(CatalogIssue {
            pack_id: None,
            message: message.into(),
        });
    }

    fn pack(&mut self, id: &str, message: impl Into<String>) {
        self.issues.push(CatalogIssue {
            pack_id: Some(id.to_owned()),
            message: message.into(),
        });
    }

    fn catalog(&mut self, catalog: &Catalog) {
        if catalog.catalog_version != CATALOG_VERSION {
            self.global(format!(
                "catalogVersion is {}, this build reads {CATALOG_VERSION}",
                catalog.catalog_version
            ));
        }
        if !is_iso_date(&catalog.generated_at) {
            self.global(format!(
                "generatedAt {:?} is not an ISO date (YYYY-MM-DD)",
                catalog.generated_at
            ));
        }
        if catalog
            .schema
            .as_deref()
            .is_some_and(|s| s.trim().is_empty())
        {
            self.global("$schema is empty");
        }
        let mut ids = HashSet::new();
        for pack in &catalog.packs {
            if !ids.insert(pack.id.as_str()) {
                self.pack(&pack.id, "duplicate id");
            }
        }
        for pack in &catalog.packs {
            self.pack_rules(catalog, pack);
        }
        self.requires_graph(catalog);
        self.uniqueness(catalog);
    }

    fn pack_rules(&mut self, catalog: &Catalog, p: &CatalogPack) {
        let id = p.id.as_str();
        if !is_valid_pack_id(id) {
            self.pack(id, "id must match /^decor$|^[a-z0-9]+(\\.[a-z0-9_]+)+$/");
        }
        if p.source.supports_kind(p.kind) {
            self.id_shape(p);
        } else {
            self.pack(
                id,
                format!(
                    "kind {} cannot be installed by adapter {}",
                    kind_name(p.kind),
                    p.source.name()
                ),
            );
        }

        let mode = expected_install_mode(&p.source);
        if p.install_mode != mode {
            self.pack(
                id,
                format!(
                    "installMode must be {} for adapter {}",
                    mode_name(mode),
                    p.source.name()
                ),
            );
        }
        if let Some(items) = expected_item_count(&p.source)
            && p.item_count != items
        {
            self.pack(
                id,
                format!(
                    "itemCount is {}, adapter {} installs {items}",
                    p.item_count,
                    p.source.name()
                ),
            );
        }
        if p.size_bytes == 0 {
            self.pack(id, "sizeBytes must be positive");
        } else if p.size_bytes.div_ceil(1024) > u64::from(u32::MAX) {
            self.pack(id, "sizeBytes does not fit the u32 KiB IPC unit");
        }

        self.l10n(id, "title", &p.title);
        self.l10n(id, "description", &p.description);
        self.language(p);
        self.version(p);
        self.revalidation(p);
        self.attribution(id, &p.attribution);
        if mentions_clear_quran(p) {
            self.pack(id, "The Clear Quran is never listed (BRIEF §4)");
        }

        for required in &p.requires {
            if required == id {
                self.pack(id, "requires itself");
            } else if catalog.get(required).is_none() {
                self.pack(id, format!("requires unknown pack {required}"));
            }
        }
        if has_duplicates(p.requires.iter()) {
            self.pack(id, "requires lists a pack twice");
        }
        if p.kind == PackKind::MushafFonts && !p.requires.iter().any(|r| r == DECOR_PACK_ID) {
            self.pack(id, "page-font packs require decor (§2.5.3)");
        }

        self.source(p);
    }

    /// §2.5.3 id patterns: `mushaf.{v}`, `decor[.x]`, `tr.{lang}.{name}`, `tafsir.{lang}.{name}`, `audio.qdc.{id}`,
    /// `wbw.{lang}`.
    fn id_shape(&mut self, p: &CatalogPack) {
        let id = p.id.as_str();
        let segments: Vec<&str> = id.split('.').collect();
        let lang = p.language_subtag();
        let lang_ok = |segment: &str| lang.as_deref() == Some(segment);
        let ok = match (p.kind, &p.source) {
            (PackKind::MushafFonts, Adapter::QcfFontPages(c)) => {
                matches!(segments.as_slice(), ["mushaf", v] if *v == c.variant.dir())
            }
            (PackKind::Decor, _) => {
                matches!(segments.as_slice(), ["decor"] | ["decor", _])
            }
            (PackKind::Translation, _) => {
                matches!(segments.as_slice(), ["tr", l, _] if lang_ok(l))
            }
            (PackKind::Tafsir, _) => {
                matches!(segments.as_slice(), ["tafsir", l, _] if lang_ok(l))
            }
            (PackKind::Recitation, Adapter::QdcAudio(c)) => {
                matches!(segments.as_slice(), ["audio", "qdc", n] if *n == c.reciter_id.to_string())
            }
            (PackKind::Wbw, Adapter::QurancomWbw(c)) => {
                matches!(segments.as_slice(), ["wbw", l] if *l == c.language && lang_ok(l))
            }
            _ => false,
        };
        if !ok {
            let expected = match p.kind {
                PackKind::MushafFonts => "mushaf.{variant}",
                PackKind::Decor => "decor or decor.{name}",
                PackKind::Translation => "tr.{language}.{name}",
                PackKind::Tafsir => "tafsir.{language}.{name}",
                PackKind::Recitation => "audio.qdc.{reciterId}",
                PackKind::Wbw => "wbw.{language}",
            };
            self.pack(
                id,
                format!("a {} pack id has the shape {expected}", kind_name(p.kind)),
            );
        }
    }

    fn l10n(&mut self, id: &str, field: &str, text: &L10nText) {
        for (lang, value) in [("en", &text.en), ("ar", &text.ar)] {
            if value.trim().is_empty() {
                self.pack(id, format!("{field}.{lang} is empty"));
            } else if value.trim() != value.as_str() {
                self.pack(
                    id,
                    format!("{field}.{lang} has leading or trailing whitespace"),
                );
            } else if value.chars().any(char::is_control) {
                self.pack(id, format!("{field}.{lang} contains a control character"));
            }
        }
        if !text.ar.trim().is_empty() && !text.ar.chars().any(is_arabic_letter) {
            self.pack(id, format!("{field}.ar has no Arabic text"));
        }
    }

    fn language(&mut self, p: &CatalogPack) {
        let id = p.id.as_str();
        let text_kind = matches!(
            p.kind,
            PackKind::Translation | PackKind::Tafsir | PackKind::Wbw
        );
        match (&p.language, p.direction) {
            (None, _) if text_kind => {
                self.pack(
                    id,
                    format!("a {} pack needs language and direction", kind_name(p.kind)),
                );
            }
            (None, Some(_)) => self.pack(id, "direction without language"),
            (None, None) => {}
            (Some(language), direction) => {
                if !is_bcp47(language) {
                    self.pack(id, format!("language {language:?} is not a BCP-47 tag"));
                }
                match direction {
                    Some(dir) if dir != language_direction(language) => self.pack(
                        id,
                        format!(
                            "{language} is written {}",
                            dir_name(language_direction(language))
                        ),
                    ),
                    Some(_) if !text_kind => {
                        self.pack(
                            id,
                            format!("a {} pack has no text direction", kind_name(p.kind)),
                        );
                    }
                    None if text_kind => self.pack(id, "direction is missing"),
                    _ => {}
                }
            }
        }
    }

    fn version(&mut self, p: &CatalogPack) {
        let id = p.id.as_str();
        if p.version.is_empty()
            || p.version.len() > 32
            || p.version.chars().any(char::is_whitespace)
        {
            self.pack(id, "version must be 1–32 characters without whitespace");
        }
        if let Adapter::QuranEncSqlite(c) = &p.source
            && c.version != p.version
        {
            self.pack(
                id,
                format!(
                    "version {} differs from source.version {}",
                    p.version, c.version
                ),
            );
        }
    }

    fn revalidation(&mut self, p: &CatalogPack) {
        let id = p.id.as_str();
        match (p.is_qf_sourced(), p.revalidate_days) {
            (true, Some(days)) if (1..=QF_MAX_REVALIDATE_DAYS).contains(&days) => {}
            (true, _) => self.pack(
                id,
                format!(
                    "QF-sourced content needs revalidateDays 1..={QF_MAX_REVALIDATE_DAYS} (§2.5.7)"
                ),
            ),
            (false, Some(_)) => self.pack(
                id,
                format!(
                    "adapter {} is not revalidated: drop revalidateDays",
                    p.source.name()
                ),
            ),
            (false, None) => {}
        }
    }

    fn attribution(&mut self, id: &str, a: &Attribution) {
        self.l10n(id, "attribution.text", &a.text);
        if !is_https_url(&a.url) {
            self.pack(
                id,
                format!("attribution.url {:?} is not an https URL", a.url),
            );
        }
        if a.licence.trim().is_empty() {
            self.pack(id, "attribution.licence is empty");
        }
    }

    fn source(&mut self, p: &CatalogPack) {
        let id = p.id.as_str();
        match &p.source {
            Adapter::QcfFontPages(c) => {
                if c.url_templates.is_empty() {
                    self.pack(id, "urlTemplates is empty");
                }
                for template in &c.url_templates {
                    if template.matches("{page}").count() != 1 {
                        self.pack(
                            id,
                            format!("url template {template} needs exactly one {{page}}"),
                        );
                    } else if !is_https_url(&template.replace("{page}", "1")) {
                        self.pack(id, format!("url template {template} is not an https URL"));
                    } else if !template.ends_with(".woff2") {
                        self.pack(
                            id,
                            format!("url template {template} must name a .woff2 file"),
                        );
                    }
                }
                if has_duplicates(c.url_templates.iter()) {
                    self.pack(id, "urlTemplates lists a template twice");
                }
            }
            Adapter::StaticFiles(c) => {
                if c.files.is_empty() {
                    self.pack(id, "files is empty");
                }
                for file in &c.files {
                    self.static_file(id, file);
                }
                if has_duplicates(c.files.iter().map(|f| &f.path)) {
                    self.pack(id, "files lists a path twice");
                }
                let total = c.files.iter().fold(0u64, |a, f| a.saturating_add(f.bytes));
                if total != p.size_bytes {
                    self.pack(
                        id,
                        format!("sizeBytes is {}, the files total {total}", p.size_bytes),
                    );
                }
            }
            Adapter::QuranEncSqlite(c) => {
                if c.key.is_empty()
                    || !c.key.starts_with(|ch: char| ch.is_ascii_lowercase())
                    || !c
                        .key
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                {
                    self.pack(
                        id,
                        format!("QuranEnc key {:?} must match /^[a-z][a-z0-9_]*$/", c.key),
                    );
                }
                if let Some(sha) = &c.sha256
                    && !is_sha256(sha)
                {
                    self.pack(id, "source.sha256 must be 64 lowercase hex digits");
                }
                if let Some(language) = &p.language {
                    let expected = tokenizer_for_language(language);
                    if c.tokenizer != expected {
                        self.pack(
                            id,
                            format!(
                                "tokenizer for {language} is {} (§3.4), not {}",
                                expected.as_str(),
                                c.tokenizer.as_str()
                            ),
                        );
                    }
                }
            }
            Adapter::QurancomTafsir(c) => {
                if c.resource_id == 0 {
                    self.pack(id, "resourceId must be positive");
                }
            }
            Adapter::QurancomWbw(c) => {
                if !QURANCOM_WBW_LANGUAGES.contains(&c.language.as_str()) {
                    self.pack(
                        id,
                        format!(
                            "Quran.com has no word-by-word gloss in {:?} (it would silently serve English)",
                            c.language
                        ),
                    );
                }
                if p.language.as_deref() != Some(c.language.as_str()) {
                    self.pack(id, "language must equal source.language");
                }
            }
            Adapter::QdcAudio(c) => {
                if c.reciter_id == 0 {
                    self.pack(id, "reciterId must be positive");
                }
                self.l10n(id, "source.name", &c.name);
                if let Some(style) = &c.style {
                    self.l10n(id, "source.style", style);
                }
                if c.hosts.is_empty() {
                    self.pack(id, "hosts is empty");
                }
                for host in &c.hosts {
                    if !is_hostname(host) {
                        self.pack(id, format!("host {host:?} must be a bare hostname"));
                    }
                }
                if has_duplicates(c.hosts.iter()) {
                    self.pack(id, "hosts lists a host twice");
                }
            }
        }
    }

    fn static_file(&mut self, id: &str, file: &StaticFile) {
        let path = file.path.as_str();
        if !DECOR_FILES.contains(&path) {
            self.pack(
                id,
                format!(
                    "file {path} is not a decor route (§6.2): one of {}",
                    DECOR_FILES.join(", ")
                ),
            );
        }
        if file.bytes == 0 {
            self.pack(id, format!("file {path} has no bytes"));
        }
        if let Some(sha) = &file.sha256
            && !is_sha256(sha)
        {
            self.pack(
                id,
                format!("file {path}: sha256 must be 64 lowercase hex digits"),
            );
        }
        if file.urls.is_empty() {
            self.pack(id, format!("file {path} has no urls"));
        }
        let file_type = extension(path);
        for url in &file.urls {
            if !is_https_url(url) {
                self.pack(id, format!("file {path}: {url} is not an https URL"));
            } else if extension(url_path(url)) != file_type {
                self.pack(
                    id,
                    format!("file {path}: {url} serves a different file type"),
                );
            }
        }
        if has_duplicates(file.urls.iter()) {
            self.pack(id, format!("file {path} lists a url twice"));
        }
    }

    fn requires_graph(&mut self, catalog: &Catalog) {
        let edges: HashMap<&str, Vec<&str>> = catalog
            .packs
            .iter()
            .map(|p| {
                (
                    p.id.as_str(),
                    p.requires.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        for pack in &catalog.packs {
            // Depth-first walk from the pack; reaching it again is a cycle. Self-edges are reported above.
            let mut stack: Vec<&str> = pack
                .requires
                .iter()
                .map(String::as_str)
                .filter(|r| *r != pack.id)
                .collect();
            let mut seen = HashSet::new();
            while let Some(next) = stack.pop() {
                if next == pack.id {
                    self.pack(&pack.id, "requires forms a cycle");
                    break;
                }
                if seen.insert(next) {
                    stack.extend(edges.get(next).into_iter().flatten().copied());
                }
            }
        }
    }

    fn uniqueness(&mut self, catalog: &Catalog) {
        let mut static_paths: HashMap<&str, &str> = HashMap::new();
        let mut keys: HashMap<String, &str> = HashMap::new();
        let mut titles: HashMap<(PackKind, Option<String>, &str), &str> = HashMap::new();
        let mut recommended: HashMap<(PackKind, Option<String>), &str> = HashMap::new();
        for p in &catalog.packs {
            let id = p.id.as_str();
            let source_key = match &p.source {
                Adapter::QuranEncSqlite(c) => Some(format!("QuranEnc key {}", c.key)),
                Adapter::QurancomTafsir(c) => Some(format!("Quran.com tafsir {}", c.resource_id)),
                Adapter::QurancomWbw(c) => Some(format!("Quran.com WBW language {}", c.language)),
                Adapter::QdcAudio(c) => Some(format!("QDC reciter {}", c.reciter_id)),
                Adapter::QcfFontPages(c) => Some(format!("QCF variant {}", c.variant.dir())),
                Adapter::StaticFiles(c) => {
                    for file in &c.files {
                        if let Some(other) = static_paths.insert(file.path.as_str(), id)
                            && other != id
                        {
                            self.pack(
                                id,
                                format!("file {} is also installed by {other}", file.path),
                            );
                        }
                    }
                    None
                }
            };
            if let Some(key) = source_key
                && let Some(other) = keys.insert(key.clone(), id)
            {
                self.pack(id, format!("{key} is also listed as {other}"));
            }
            let lang = p.language_subtag();
            for title in [p.title.en.as_str(), p.title.ar.as_str()] {
                if let Some(other) = titles.insert((p.kind, lang.clone(), title), id) {
                    self.pack(id, format!("title {title:?} is also used by {other}"));
                }
            }
            if p.recommended
                && let Some(other) = recommended.insert((p.kind, lang.clone()), id)
            {
                self.pack(
                    id,
                    format!(
                        "{other} is already the recommended {} pack{}",
                        kind_name(p.kind),
                        lang.map(|l| format!(" for {l}")).unwrap_or_default()
                    ),
                );
            }
        }
    }

    fn starter(&mut self, catalog: &Catalog) {
        match catalog.get(DECOR_PACK_ID) {
            Some(p) if p.kind == PackKind::Decor => {}
            _ => self.global("the starter set needs the `decor` pack"),
        }
        for style in MushafStyle::ALL {
            if FontVariant::for_style(style).is_some() && catalog.mushaf_pack(style).is_none() {
                self.global(format!("no page-font pack for style {style:?}"));
            }
        }
        if catalog
            .of_kind(PackKind::MushafFonts)
            .filter(|p| p.recommended)
            .count()
            != 1
        {
            self.global("exactly one page-font pack must be recommended");
        }
        for ui in [UiLanguage::En, UiLanguage::Ar] {
            if catalog.default_translation(ui).is_none() {
                self.global(format!(
                    "no recommended translation or tafsir for the {} UI",
                    ui_code(ui)
                ));
            }
        }
        let default_reciter = Settings::default().reciter_id;
        let recommended: Vec<_> = catalog
            .of_kind(PackKind::Recitation)
            .filter(|p| p.recommended)
            .collect();
        match recommended.as_slice() {
            [p] if p.reciter().is_some_and(|c| c.reciter_id == default_reciter) => {}
            _ => self.global(format!(
                "the default reciter {default_reciter} must be the one recommended recitation"
            )),
        }
        if !catalog.wbw_pack("en").is_some_and(|p| p.recommended) {
            self.global("wbw.en must exist and be recommended (WBW for the English UI)");
        }
    }
}

const fn expected_install_mode(source: &Adapter) -> InstallMode {
    match source {
        Adapter::QcfFontPages(_)
        | Adapter::QurancomTafsir(_)
        | Adapter::QurancomWbw(_)
        | Adapter::QdcAudio(_) => InstallMode::OnDemand,
        Adapter::StaticFiles(_) | Adapter::QuranEncSqlite(_) => InstallMode::Whole,
    }
}

fn expected_item_count(source: &Adapter) -> Option<u32> {
    match source {
        Adapter::QcfFontPages(_) => Some(PAGE_COUNT),
        Adapter::QurancomTafsir(_) | Adapter::QurancomWbw(_) | Adapter::QdcAudio(_) => {
            Some(SURAH_COUNT)
        }
        Adapter::QuranEncSqlite(_) => Some(1),
        Adapter::StaticFiles(c) => u32::try_from(c.files.len()).ok(),
    }
}

const fn kind_name(kind: PackKind) -> &'static str {
    match kind {
        PackKind::MushafFonts => "mushaf_fonts",
        PackKind::Decor => "decor",
        PackKind::Translation => "translation",
        PackKind::Tafsir => "tafsir",
        PackKind::Recitation => "recitation",
        PackKind::Wbw => "wbw",
    }
}

const fn mode_name(mode: InstallMode) -> &'static str {
    match mode {
        InstallMode::Whole => "whole",
        InstallMode::OnDemand => "on_demand",
    }
}

const fn dir_name(dir: TextDir) -> &'static str {
    match dir {
        TextDir::Ltr => "ltr",
        TextDir::Rtl => "rtl",
    }
}

fn is_iso_date(s: &str) -> bool {
    s.len() == 10
        && time::Date::parse(s, time::macros::format_description!("[year]-[month]-[day]")).is_ok()
}

/// A simplified BCP-47 check: a 2–3 letter lowercase primary subtag, then `-`-separated alphanumeric subtags.
fn is_bcp47(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let primary_ok = parts
        .next()
        .is_some_and(|p| (2..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_lowercase()));
    primary_ok
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn is_https_url(s: &str) -> bool {
    s.starts_with("https://")
        && url::Url::parse(s)
            .is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty()))
}

/// The path part of an absolute URL (no query or fragment).
fn url_path(s: &str) -> &str {
    let without_scheme = s.split_once("://").map_or(s, |(_, rest)| rest);
    let path = without_scheme
        .find('/')
        .map_or("", |i| without_scheme.get(i..).unwrap_or(""));
    path.split(['?', '#']).next().unwrap_or(path)
}

fn extension(path: &str) -> &str {
    path.rsplit_once('.').map_or("", |(_, ext)| ext)
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_hostname(s: &str) -> bool {
    s.contains('.')
        && s.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

const fn is_arabic_letter(c: char) -> bool {
    matches!(c, '\u{0620}'..='\u{064A}' | '\u{066E}'..='\u{06D3}' | '\u{0750}'..='\u{077F}' | '\u{08A0}'..='\u{08C9}' | '\u{FB50}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFC}')
}

fn has_duplicates<'a, T: AsRef<str> + 'a>(items: impl Iterator<Item = &'a T>) -> bool {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .any(|i| !seen.insert(i.as_ref().to_owned()))
}

/// BRIEF §4: The Clear Quran (Khattab) is never listed, under any id, key or title.
fn mentions_clear_quran(p: &CatalogPack) -> bool {
    let mut haystacks = vec![
        p.id.clone(),
        p.title.en.clone(),
        p.description.en.clone(),
        p.attribution.text.en.clone(),
    ];
    if let Adapter::QuranEncSqlite(c) = &p.source {
        haystacks.push(c.key.clone());
    }
    haystacks.iter().any(|h| {
        let folded: String = h
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|c| c.to_ascii_lowercase())
            .collect();
        folded.contains("clearquran") || folded.contains("khattab")
    })
}

/// A validator for the JSON Schema (draft 2020-12) subset that `catalog.schema.json` uses, so `catalog-check` and the
/// tests prove that the curated file, the committed schema and the serde model agree. A keyword outside the subset is
/// reported as an error rather than ignored, so the schema cannot silently promise more than is checked.
///
/// Supported: `$ref` (local JSON pointers), `type`, `const`, `enum`, `pattern`, `minLength`, `maxLength`, `minimum`,
/// `maximum`, `items`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `properties`, `required`,
/// `additionalProperties`, `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`; annotations (`$schema`, `$id`,
/// `$defs`, `$comment`, `title`, `description`, `default`, `examples`) are skipped. `pattern` uses the `regex` crate
/// (search semantics, as in JSON Schema); keep patterns to the common ECMA-262/Rust subset.
pub mod schema {
    use std::collections::HashMap;

    use serde_json::Value;

    /// The draft this validator implements.
    pub const DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";

    /// Maximum `$ref` nesting (a cyclic schema is reported, not followed forever).
    const MAX_DEPTH: u32 = 64;

    /// Every violation of `schema` by `instance`, as `"<json path>: <problem>"`; empty when valid.
    #[must_use]
    pub fn validate(schema: &Value, instance: &Value) -> Vec<String> {
        let mut v = Validator {
            root: schema,
            regexes: HashMap::new(),
            errors: Vec::new(),
        };
        v.check(schema, instance, "$", 0);
        v.errors
    }

    struct Validator<'s> {
        root: &'s Value,
        regexes: HashMap<String, Option<regex::Regex>>,
        errors: Vec<String>,
    }

    impl<'s> Validator<'s> {
        fn fail(&mut self, path: &str, message: impl AsRef<str>) {
            self.errors.push(format!("{path}: {}", message.as_ref()));
        }

        /// Runs `schema` against `value` and returns its errors without recording them.
        fn probe(
            &mut self,
            schema: &'s Value,
            value: &Value,
            path: &str,
            depth: u32,
        ) -> Vec<String> {
            let saved = std::mem::take(&mut self.errors);
            self.check(schema, value, path, depth);
            std::mem::replace(&mut self.errors, saved)
        }

        fn check(&mut self, schema: &'s Value, value: &Value, path: &str, depth: u32) {
            if depth > MAX_DEPTH {
                self.fail(path, "schema nesting too deep (cyclic $ref?)");
                return;
            }
            let rules = match schema {
                Value::Bool(true) => return,
                Value::Bool(false) => return self.fail(path, "no value is allowed here"),
                Value::Object(rules) => rules,
                _ => return self.fail(path, "schema is neither an object nor a boolean"),
            };
            for (keyword, arg) in rules {
                self.keyword(rules, keyword, arg, value, path, depth);
            }
        }

        fn keyword(
            &mut self,
            rules: &'s serde_json::Map<String, Value>,
            keyword: &str,
            arg: &'s Value,
            value: &Value,
            path: &str,
            depth: u32,
        ) {
            match keyword {
                "$schema" | "$id" | "$defs" | "$comment" | "title" | "description" | "default"
                | "examples" | "then" | "else" => {}
                "$ref" => match arg.as_str().and_then(|r| self.resolve(r)) {
                    Some(target) => self.check(target, value, path, depth + 1),
                    None => self.fail(path, format!("unresolvable $ref {arg}")),
                },
                "type" => {
                    let ok = match arg {
                        Value::String(t) => has_type(value, t),
                        Value::Array(ts) => ts
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|t| has_type(value, t)),
                        _ => false,
                    };
                    if !ok {
                        self.fail(
                            path,
                            format!("expected type {arg}, found {}", type_name(value)),
                        );
                    }
                }
                "const" => {
                    if value != arg {
                        self.fail(path, format!("must be {arg}"));
                    }
                }
                "enum" => {
                    if !arg
                        .as_array()
                        .is_some_and(|options| options.contains(value))
                    {
                        self.fail(path, format!("must be one of {arg}"));
                    }
                }
                "pattern" => {
                    if let (Some(text), Some(pattern)) = (value.as_str(), arg.as_str()) {
                        match self.regex(pattern).map(|re| re.is_match(text)) {
                            Some(true) => {}
                            Some(false) => {
                                self.fail(path, format!("{text:?} does not match /{pattern}/"))
                            }
                            None => self.fail(path, format!("invalid pattern /{pattern}/")),
                        }
                    }
                }
                "minLength" | "maxLength" => {
                    if let (Some(text), Some(limit)) = (value.as_str(), arg.as_u64()) {
                        let len = text.chars().count() as u64;
                        let ok = if keyword == "minLength" {
                            len >= limit
                        } else {
                            len <= limit
                        };
                        if !ok {
                            self.fail(path, format!("length {len} violates {keyword} {limit}"));
                        }
                    }
                }
                "minimum" | "maximum" => {
                    if let (Some(n), Some(limit)) = (value.as_f64(), arg.as_f64()) {
                        let ok = if keyword == "minimum" {
                            n >= limit
                        } else {
                            n <= limit
                        };
                        if !ok {
                            self.fail(path, format!("{value} violates {keyword} {arg}"));
                        }
                    }
                }
                "items" => {
                    if let Some(items) = value.as_array() {
                        for (i, item) in items.iter().enumerate() {
                            self.check(arg, item, &format!("{path}[{i}]"), depth + 1);
                        }
                    }
                }
                "minItems" | "maxItems" => {
                    if let (Some(items), Some(limit)) = (value.as_array(), arg.as_u64()) {
                        let len = items.len() as u64;
                        let ok = if keyword == "minItems" {
                            len >= limit
                        } else {
                            len <= limit
                        };
                        if !ok {
                            self.fail(path, format!("{len} items violate {keyword} {limit}"));
                        }
                    }
                }
                "uniqueItems" => {
                    if let (Some(items), Some(true)) = (value.as_array(), arg.as_bool()) {
                        let duplicate = items
                            .iter()
                            .enumerate()
                            .any(|(i, a)| items.iter().skip(i + 1).any(|b| a == b));
                        if duplicate {
                            self.fail(path, "items must be unique");
                        }
                    }
                }
                "contains" => {
                    if let Some(items) = value.as_array() {
                        let found = items
                            .iter()
                            .any(|item| self.probe(arg, item, path, depth + 1).is_empty());
                        if !found {
                            self.fail(path, format!("no item matches {arg}"));
                        }
                    }
                }
                "properties" => {
                    if let (Some(object), Some(props)) = (value.as_object(), arg.as_object()) {
                        for (name, sub) in props {
                            if let Some(field) = object.get(name) {
                                self.check(sub, field, &format!("{path}.{name}"), depth + 1);
                            }
                        }
                    }
                }
                "required" => {
                    if let (Some(object), Some(names)) = (value.as_object(), arg.as_array()) {
                        for name in names.iter().filter_map(Value::as_str) {
                            if !object.contains_key(name) {
                                self.fail(path, format!("missing required property {name:?}"));
                            }
                        }
                    }
                }
                "additionalProperties" => {
                    if let Some(object) = value.as_object() {
                        let declared = rules.get("properties").and_then(Value::as_object);
                        for (name, field) in object {
                            if declared.is_some_and(|d| d.contains_key(name)) {
                                continue;
                            }
                            if arg == &Value::Bool(false) {
                                self.fail(path, format!("unknown property {name:?}"));
                            } else {
                                self.check(arg, field, &format!("{path}.{name}"), depth + 1);
                            }
                        }
                    }
                }
                "allOf" => {
                    for sub in arg.as_array().into_iter().flatten() {
                        self.check(sub, value, path, depth + 1);
                    }
                }
                "anyOf" | "oneOf" => {
                    let outcomes: Vec<Vec<String>> = arg
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|sub| self.probe(sub, value, path, depth + 1))
                        .collect();
                    let matching = outcomes.iter().filter(|e| e.is_empty()).count();
                    if matching == 0 {
                        // Report the closest alternative: the one with the fewest errors.
                        let closest = outcomes
                            .into_iter()
                            .min_by_key(Vec::len)
                            .unwrap_or_default();
                        self.fail(path, format!("matches none of the {keyword} alternatives"));
                        self.errors.extend(closest);
                    } else if keyword == "oneOf" && matching > 1 {
                        self.fail(
                            path,
                            format!("matches {matching} oneOf alternatives, expected exactly one"),
                        );
                    }
                }
                "not" => {
                    if self.probe(arg, value, path, depth + 1).is_empty() {
                        self.fail(path, format!("must not match {arg}"));
                    }
                }
                "if" => {
                    let branch = if self.probe(arg, value, path, depth + 1).is_empty() {
                        rules.get("then")
                    } else {
                        rules.get("else")
                    };
                    if let Some(branch) = branch {
                        self.check(branch, value, path, depth + 1);
                    }
                }
                other => self.fail(path, format!("unsupported schema keyword {other:?}")),
            }
        }

        fn resolve(&self, reference: &str) -> Option<&'s Value> {
            let pointer = reference.strip_prefix('#')?;
            self.root.pointer(pointer)
        }

        fn regex(&mut self, pattern: &str) -> Option<&regex::Regex> {
            self.regexes
                .entry(pattern.to_owned())
                .or_insert_with(|| regex::Regex::new(pattern).ok())
                .as_ref()
        }
    }

    fn has_type(value: &Value, t: &str) -> bool {
        match t {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            "number" => value.is_number(),
            "integer" => {
                value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|f| f.fract() == 0.0)
            }
            _ => false,
        }
    }

    const fn type_name(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
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

    use serde_json::{Value, json};

    use super::*;

    fn l10n(en: &str, ar: &str) -> Value {
        json!({ "en": en, "ar": ar })
    }

    fn attribution() -> Value {
        json!({ "text": l10n("Quran Foundation", "مؤسسة القرآن"), "url": "https://quran.foundation",
                "licence": "Quran Foundation terms" })
    }

    fn mushaf(v: &str, recommended: bool) -> Value {
        let mut pack = json!({ "id": format!("mushaf.{v}"), "kind": "mushaf_fonts",
                "title": l10n(&format!("Mushaf {v}"), &format!("مصحف {v}")),
                "description": l10n("Page fonts", "خطوط الصفحات"), "version": "2026.10", "installMode": "on_demand",
                "requires": ["decor"], "sizeBytes": 1000, "itemCount": 604, "attribution": attribution(),
                "source": { "adapter": "qcf_font_pages", "variant": v,
                            "urlTemplates": [format!("https://verses.quran.foundation/fonts/quran/hafs/{v}/woff2/p{{page}}.woff2")] } });
        if recommended {
            pack["recommended"] = json!(true);
        }
        pack
    }

    /// A small catalog that passes `issues()` and `starter_issues()`.
    fn valid() -> Value {
        json!({
          "$schema": SCHEMA_REF, "catalogVersion": 1, "generatedAt": "2026-10-10",
          "packs": [
            { "id": "decor", "kind": "decor", "title": l10n("Ornaments", "الزخارف"),
              "description": l10n("Surah headers", "عناوين السور"), "version": "2026.10", "installMode": "whole",
              "sizeBytes": 30, "itemCount": 3, "recommended": true, "attribution": attribution(),
              "source": { "adapter": "static_files", "files": [
                { "path": "qcf-surah-header.woff2", "urls": ["https://a.example.org/h.woff2"], "bytes": 10 },
                { "path": "quran-common.ttf", "urls": ["https://a.example.org/c.ttf"], "bytes": 10,
                  "sha256": "0".repeat(64) },
                { "path": "sura-names.woff2", "urls": ["https://a.example.org/n.woff2?v=1"], "bytes": 10 } ] } },
            mushaf("v2", true), mushaf("v1", false), mushaf("v4", false),
            { "id": "tr.en.saheeh", "kind": "translation", "title": l10n("Saheeh International", "صحيح إنترناشونال"),
              "description": l10n("English", "الإنجليزية"), "language": "en", "direction": "ltr", "version": "1.1.2",
              "installMode": "whole", "sizeBytes": 518_866, "itemCount": 1, "recommended": true,
              "attribution": attribution(),
              "source": { "adapter": "quranenc_sqlite", "key": "english_saheeh", "version": "1.1.2",
                          "versionSource": "list", "tokenizer": "porter_unicode61", "contentKind": "translation" } },
            { "id": "tafsir.ar.muyassar", "kind": "tafsir", "title": l10n("Al-Muyassar", "التفسير الميسر"),
              "description": l10n("Concise tafsir", "تفسير موجز"), "language": "ar", "direction": "rtl",
              "version": "2025.03", "installMode": "whole", "sizeBytes": 812_274, "itemCount": 1, "recommended": true,
              "attribution": attribution(),
              "source": { "adapter": "quranenc_sqlite", "key": "arabic_moyassar", "version": "2025.03",
                          "versionSource": "http_validators", "tokenizer": "arabic_normalized", "contentKind": "tafsir" } },
            { "id": "wbw.en", "kind": "wbw", "title": l10n("Word by word: English", "كلمة بكلمة: الإنجليزية"),
              "description": l10n("Glosses", "معاني الكلمات"), "language": "en", "direction": "ltr", "version": "2026.10",
              "installMode": "on_demand", "sizeBytes": 3_000_000, "itemCount": 114, "recommended": true,
              "revalidateDays": 7, "attribution": attribution(),
              "source": { "adapter": "qurancom_v4_wbw", "language": "en" } },
            { "id": "audio.qdc.7", "kind": "recitation", "title": l10n("Mishary Rashid Alafasy", "مشاري راشد العفاسي"),
              "description": l10n("Gapless", "متصلة"), "language": "ar", "version": "2026.10", "installMode": "on_demand",
              "sizeBytes": 1_680_759_654, "itemCount": 114, "recommended": true, "revalidateDays": 7,
              "attribution": attribution(),
              "source": { "adapter": "qdc_audio", "reciterId": 7, "name": l10n("Mishary Rashid Alafasy", "مشاري راشد العفاسي"),
                          "style": l10n("Murattal", "مرتل"), "basmalaInFile": false,
                          "hosts": ["download.quranicaudio.com", "download.quranicaudio.org"], "wordLevel": true } }
          ]
        })
    }

    fn parse(v: &Value) -> Catalog {
        Catalog::from_json(&v.to_string()).unwrap()
    }

    fn messages(v: &Value) -> Vec<String> {
        let c = parse(v);
        c.issues()
            .into_iter()
            .chain(c.starter_issues())
            .map(|i| i.to_string())
            .collect()
    }

    fn pack_mut<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
        v["packs"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["id"] == id)
            .unwrap()
    }

    fn assert_issue(v: &Value, needle: &str) {
        let all = messages(v);
        assert!(
            all.iter().any(|m| m.contains(needle)),
            "expected an issue containing {needle:?}, got {all:#?}"
        );
    }

    #[test]
    fn the_build_rs_placeholder_parses() {
        let c = Catalog::from_json(r#"{"catalogVersion":1,"generatedAt":"1970-01-01","packs":[]}"#)
            .unwrap();
        assert_eq!(c, Catalog::empty());
        assert!(
            c.validate().is_ok(),
            "an empty catalog is structurally valid"
        );
        assert!(!c.starter_issues().is_empty(), "but cannot seed onboarding");
    }

    #[test]
    fn the_valid_fixture_has_no_issues_and_round_trips() {
        let v = valid();
        assert_eq!(messages(&v), Vec::<String>::new());
        let c = parse(&v);
        assert!(c.validate_release().is_ok());
        assert_eq!(c.schema.as_deref(), Some(SCHEMA_REF));
        let again = Catalog::from_json(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(again, c);
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            v,
            "serialisation is the curated shape"
        );
    }

    #[test]
    fn a_pack_parses_strictly() {
        let mut v = valid();
        pack_mut(&mut v, "tr.en.saheeh")["itemsCount"] = json!(1);
        assert!(matches!(
            Catalog::from_json(&v.to_string()),
            Err(PackError::Catalog(_))
        ));
        let mut v = valid();
        v["extra"] = json!(true);
        assert!(Catalog::from_json(&v.to_string()).is_err());
    }

    #[test]
    fn pack_id_syntax() {
        for ok in [
            "decor",
            "decor.nastaliq",
            "tr.en.saheeh",
            "audio.qdc.173",
            "wbw.en",
            "tafsir.en.ibn_kathir",
            "a.b",
        ] {
            assert!(is_valid_pack_id(ok), "{ok}");
        }
        for bad in [
            "",
            "decor.",
            ".x",
            "tr",
            "Tr.en.x",
            "tr..x",
            "tr.en-x.y",
            "tr.en.x ",
            "trå.en",
            "x_y.z",
            "decor..a",
        ] {
            assert!(!is_valid_pack_id(bad), "{bad}");
        }
    }

    #[test]
    fn languages_map_to_direction_and_tokenizer() {
        assert_eq!(language_direction("ur"), TextDir::Rtl);
        assert_eq!(language_direction("fa-IR"), TextDir::Rtl);
        assert_eq!(language_direction("en"), TextDir::Ltr);
        assert_eq!(language_direction("bn"), TextDir::Ltr);
        assert_eq!(
            tokenizer_for_language("en-GB"),
            PackTokenizer::PorterUnicode61
        );
        assert_eq!(
            tokenizer_for_language("ar"),
            PackTokenizer::ArabicNormalized
        );
        assert_eq!(
            tokenizer_for_language("ur"),
            PackTokenizer::ArabicNormalized
        );
        assert_eq!(
            tokenizer_for_language("bn"),
            PackTokenizer::Unicode61RemoveDiacritics
        );
        assert_eq!(tokenizer_for_language("zh"), PackTokenizer::LikeFallback);
        assert!(is_bcp47("en") && is_bcp47("zh-Hant") && is_bcp47("inh"));
        assert!(!is_bcp47("EN") && !is_bcp47("e") && !is_bcp47("en_GB") && !is_bcp47("en-"));
    }

    #[test]
    fn url_helpers() {
        assert_eq!(url_path("https://a.org/x/y.woff2?v=1#f"), "/x/y.woff2");
        assert_eq!(url_path("https://a.org"), "");
        assert_eq!(extension("/x/y.woff2"), "woff2");
        assert!(is_https_url("https://download.quranicaudio.com/x.mp3"));
        assert!(
            !is_https_url("http://a.org/x")
                && !is_https_url("https://")
                && !is_https_url("ftp://a")
        );
        assert!(is_hostname("download.quranicaudio.org"));
        assert!(
            !is_hostname("https://a.org") && !is_hostname("localhost") && !is_hostname("a.org/x")
        );
        assert!(is_sha256(&"ab".repeat(32)) && !is_sha256(&"AB".repeat(32)));
        assert!(
            is_iso_date("2026-10-10") && !is_iso_date("2026-13-01") && !is_iso_date("10/10/2026")
        );
    }

    #[test]
    fn every_rule_reports_its_problem() {
        type Mutation = fn(&mut Value);
        let cases: &[(&str, Mutation)] = &[
            ("catalogVersion is 2", |v| v["catalogVersion"] = json!(2)),
            ("not an ISO date", |v| v["generatedAt"] = json!("2026-10")),
            ("duplicate id", |v| {
                let copy = v["packs"][1].clone();
                v["packs"].as_array_mut().unwrap().push(copy);
            }),
            ("id must match", |v| {
                pack_mut(v, "wbw.en")["id"] = json!("WBW.en")
            }),
            ("cannot be installed by adapter", |v| {
                pack_mut(v, "wbw.en")["kind"] = json!("tafsir")
            }),
            ("has the shape tr.{language}.{name}", |v| {
                pack_mut(v, "tr.en.saheeh")["id"] = json!("tr.fr.saheeh")
            }),
            ("has the shape audio.qdc.{reciterId}", |v| {
                pack_mut(v, "audio.qdc.7")["source"]["reciterId"] = json!(8)
            }),
            ("installMode must be on_demand", |v| {
                pack_mut(v, "mushaf.v2")["installMode"] = json!("whole")
            }),
            ("itemCount is 603", |v| {
                pack_mut(v, "mushaf.v1")["itemCount"] = json!(603)
            }),
            ("sizeBytes must be positive", |v| {
                pack_mut(v, "tr.en.saheeh")["sizeBytes"] = json!(0)
            }),
            ("the files total 30", |v| {
                pack_mut(v, "decor")["sizeBytes"] = json!(31)
            }),
            ("title.ar is empty", |v| {
                pack_mut(v, "decor")["title"]["ar"] = json!(" ")
            }),
            ("description.ar has no Arabic text", |v| {
                pack_mut(v, "decor")["description"]["ar"] = json!("Headers")
            }),
            ("leading or trailing whitespace", |v| {
                pack_mut(v, "decor")["title"]["en"] = json!("Ornaments ")
            }),
            ("needs language and direction", |v| {
                let p = pack_mut(v, "tafsir.ar.muyassar");
                p.as_object_mut().unwrap().remove("language");
                p.as_object_mut().unwrap().remove("direction");
            }),
            ("ar is written rtl", |v| {
                pack_mut(v, "tafsir.ar.muyassar")["direction"] = json!("ltr")
            }),
            ("direction is missing", |v| {
                pack_mut(v, "wbw.en")
                    .as_object_mut()
                    .unwrap()
                    .remove("direction");
            }),
            ("has no text direction", |v| {
                pack_mut(v, "audio.qdc.7")["direction"] = json!("rtl")
            }),
            ("not a BCP-47 tag", |v| {
                pack_mut(v, "audio.qdc.7")["language"] = json!("Arabic")
            }),
            ("differs from source.version", |v| {
                pack_mut(v, "tr.en.saheeh")["version"] = json!("1.1.3")
            }),
            ("version must be 1–32 characters", |v| {
                pack_mut(v, "mushaf.v4")["version"] = json!("2026 10")
            }),
            ("needs revalidateDays 1..=7", |v| {
                pack_mut(v, "wbw.en")["revalidateDays"] = json!(30)
            }),
            ("is not revalidated", |v| {
                pack_mut(v, "tr.en.saheeh")["revalidateDays"] = json!(7)
            }),
            ("attribution.url", |v| {
                pack_mut(v, "decor")["attribution"]["url"] = json!("http://x.org")
            }),
            ("attribution.licence is empty", |v| {
                pack_mut(v, "decor")["attribution"]["licence"] = json!("")
            }),
            ("The Clear Quran is never listed", |v| {
                pack_mut(v, "tr.en.saheeh")["title"]["en"] =
                    json!("The Clear Quran (Dr. Mustafa Khattab)");
            }),
            ("The Clear Quran is never listed", |v| {
                pack_mut(v, "tr.en.saheeh")["source"]["key"] = json!("english_clearquran")
            }),
            ("requires unknown pack nope", |v| {
                pack_mut(v, "mushaf.v2")["requires"] = json!(["decor", "nope"])
            }),
            ("requires itself", |v| {
                pack_mut(v, "mushaf.v2")["requires"] = json!(["decor", "mushaf.v2"])
            }),
            ("requires lists a pack twice", |v| {
                pack_mut(v, "mushaf.v2")["requires"] = json!(["decor", "decor"])
            }),
            ("page-font packs require decor", |v| {
                pack_mut(v, "mushaf.v1")["requires"] = json!([])
            }),
            ("requires forms a cycle", |v| {
                pack_mut(v, "decor")["requires"] = json!(["mushaf.v2"])
            }),
            ("needs exactly one {page}", |v| {
                pack_mut(v, "mushaf.v2")["source"]["urlTemplates"] =
                    json!(["https://a.org/p.woff2"]);
            }),
            ("is not an https URL", |v| {
                pack_mut(v, "mushaf.v2")["source"]["urlTemplates"] =
                    json!(["http://a.org/p{page}.woff2"]);
            }),
            ("must name a .woff2 file", |v| {
                pack_mut(v, "mushaf.v2")["source"]["urlTemplates"] =
                    json!(["https://a.org/p{page}.ttf"]);
            }),
            ("urlTemplates lists a template twice", |v| {
                let t = pack_mut(v, "mushaf.v2")["source"]["urlTemplates"][0].clone();
                pack_mut(v, "mushaf.v2")["source"]["urlTemplates"] = json!([t.clone(), t]);
            }),
            ("is not a decor route", |v| {
                pack_mut(v, "decor")["source"]["files"][0]["path"] = json!("../x.woff2")
            }),
            ("serves a different file type", |v| {
                pack_mut(v, "decor")["source"]["files"][1]["urls"] =
                    json!(["https://a.org/c.woff2"]);
            }),
            ("sha256 must be 64 lowercase hex digits", |v| {
                pack_mut(v, "decor")["source"]["files"][1]["sha256"] = json!("ABC");
            }),
            ("has no urls", |v| {
                pack_mut(v, "decor")["source"]["files"][0]["urls"] = json!([])
            }),
            ("must match /^[a-z][a-z0-9_]*$/", |v| {
                pack_mut(v, "tr.en.saheeh")["source"]["key"] = json!("English-Saheeh")
            }),
            ("tokenizer for en is porter_unicode61", |v| {
                pack_mut(v, "tr.en.saheeh")["source"]["tokenizer"] =
                    json!("unicode61_remove_diacritics");
            }),
            ("silently serve English", |v| {
                let p = pack_mut(v, "wbw.en");
                p["id"] = json!("wbw.ar");
                p["language"] = json!("ar");
                p["direction"] = json!("rtl");
                p["source"]["language"] = json!("ar");
            }),
            ("language must equal source.language", |v| {
                pack_mut(v, "wbw.en")["source"]["language"] = json!("ur")
            }),
            ("must be a bare hostname", |v| {
                pack_mut(v, "audio.qdc.7")["source"]["hosts"] =
                    json!(["https://download.quranicaudio.com"]);
            }),
            ("hosts is empty", |v| {
                pack_mut(v, "audio.qdc.7")["source"]["hosts"] = json!([])
            }),
            ("source.name.ar is empty", |v| {
                pack_mut(v, "audio.qdc.7")["source"]["name"]["ar"] = json!("")
            }),
            ("is also used by mushaf.v1", |v| {
                pack_mut(v, "mushaf.v4")["title"] = l10n("Mushaf v1", "مصحف ٤")
            }),
            ("is already the recommended mushaf_fonts pack", |v| {
                pack_mut(v, "mushaf.v4")["recommended"] = json!(true)
            }),
            ("QDC reciter 7 is also listed", |v| {
                let mut copy = pack_mut(v, "audio.qdc.7").clone();
                copy["recommended"] = json!(false);
                copy["title"] = l10n("Other", "آخر");
                v["packs"].as_array_mut().unwrap().push(copy);
            }),
            ("also installed by decor", |v| {
                let mut copy = pack_mut(v, "decor").clone();
                copy["id"] = json!("decor.extra");
                copy["recommended"] = json!(false);
                copy["title"] = l10n("Extra", "إضافي");
                v["packs"].as_array_mut().unwrap().push(copy);
            }),
            ("the starter set needs the `decor` pack", |v| {
                v["packs"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|p| p["id"] != "decor");
            }),
            ("no page-font pack for style QcfV4", |v| {
                v["packs"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|p| p["id"] != "mushaf.v4");
            }),
            ("no recommended translation or tafsir for the ar UI", |v| {
                pack_mut(v, "tafsir.ar.muyassar")["recommended"] = json!(false);
            }),
            (
                "the default reciter 7 must be the one recommended recitation",
                |v| {
                    pack_mut(v, "audio.qdc.7")["recommended"] = json!(false);
                },
            ),
            ("wbw.en must exist and be recommended", |v| {
                pack_mut(v, "wbw.en")["recommended"] = json!(false)
            }),
        ];
        for (needle, mutate) in cases {
            let mut v = valid();
            mutate(&mut v);
            assert_issue(&v, needle);
        }
    }

    #[test]
    fn validate_reports_every_problem_at_once() {
        let mut v = valid();
        pack_mut(&mut v, "decor")["sizeBytes"] = json!(31);
        pack_mut(&mut v, "wbw.en")["revalidateDays"] = json!(30);
        let err = parse(&v).validate().unwrap_err().to_string();
        assert!(err.starts_with("catalog: 2 problems: decor: "), "{err}");
        assert!(err.contains("wbw.en: QF-sourced"), "{err}");
        assert_eq!(
            quran_types::AppError::from(parse(&v).validate().unwrap_err()).kind(),
            "internal"
        );
    }

    #[test]
    fn infos_summaries_and_reciters() {
        let c = parse(&valid());
        let infos = c.infos();
        assert_eq!(infos.len(), c.packs.len());
        assert!(
            infos
                .iter()
                .all(|i| i.state == PackState::NotInstalled && i.job.is_none())
        );
        let decor = &infos[0];
        assert_eq!(
            (decor.size_kib, decor.item_count),
            (1, 3),
            "30 B round up to 1 KiB"
        );
        let saheeh = c.get("tr.en.saheeh").unwrap();
        assert_eq!(saheeh.size_kib(), 507);
        assert_eq!(
            saheeh.summary(PackState::NotInstalled).language.as_deref(),
            Some("en")
        );
        let reciters = c.reciters();
        assert_eq!(reciters.len(), 1);
        assert_eq!(reciters[0].id, 7);
        assert_eq!(reciters[0].pack_id, "audio.qdc.7");
        assert!(reciters[0].word_level);
        assert_eq!(reciters[0].size_kib, 1_641_367);
        assert_eq!(
            c.reciter_meta(7).map(|(n, b)| (n.en, b)),
            Some(("Mishary Rashid Alafasy".into(), false))
        );
        assert_eq!(c.reciter_meta(8), None);
        assert!(matches!(c.require("x"), Err(PackError::NotFound(_))));
        assert_eq!(
            c.mushaf_pack(MushafStyle::QcfV1).map(|p| p.id.as_str()),
            Some("mushaf.v1")
        );
        assert_eq!(c.mushaf_pack(MushafStyle::Hafs), None);
        assert_eq!(c.wbw_pack("en").map(|p| p.id.as_str()), Some("wbw.en"));
        assert!(c.get("audio.qdc.7").unwrap().is_qf_sourced());
        assert!(!c.get("tr.en.saheeh").unwrap().is_qf_sourced());
        let huge = CatalogPack {
            size_bytes: u64::MAX,
            ..saheeh.clone()
        };
        assert_eq!(huge.size_kib(), u32::MAX);
    }

    #[test]
    fn starter_sets_follow_the_spec() {
        let c = parse(&valid());
        assert_eq!(
            c.default_translation(UiLanguage::En).map(|p| p.id.as_str()),
            Some("tr.en.saheeh")
        );
        assert_eq!(
            c.default_translation(UiLanguage::Ar).map(|p| p.id.as_str()),
            Some("tafsir.ar.muyassar")
        );

        let en = StarterChoices::defaults(&c, UiLanguage::En);
        assert_eq!(en.style, MushafStyle::Hafs);
        assert_eq!(en.reciter_id, 7);
        let set = c.starter_set(&en).unwrap();
        let shape: Vec<_> = set
            .items
            .iter()
            .map(|i| (i.pack_id.as_str(), i.fetch))
            .collect();
        assert_eq!(
            shape,
            [
                ("decor", StarterFetch::Now),
                ("tr.en.saheeh", StarterFetch::Now),
                ("wbw.en", StarterFetch::OnDemand),
                ("audio.qdc.7", StarterFetch::TimingsOnFirstPlay)
            ]
        );
        assert_eq!(set.download_now_bytes(), 30 + 518_866);
        assert_eq!(set.download_now(), ["decor", "tr.en.saheeh"]);

        let qcf = StarterChoices {
            style: MushafStyle::QcfV2,
            ..en.clone()
        };
        let set = c.starter_set(&qcf).unwrap();
        assert_eq!(
            set.get("mushaf.v2").map(|i| (i.fetch, i.bytes_now)),
            Some((StarterFetch::OnDemand, 0))
        );
        assert_eq!(set.download_now_bytes(), 30 + 518_866);
        let all_pages = StarterChoices {
            download_all_pages: true,
            ..qcf
        };
        let set = c.starter_set(&all_pages).unwrap();
        assert_eq!(set.download_now_bytes(), 30 + 518_866 + 1000);

        let ar = StarterChoices::defaults(&c, UiLanguage::Ar);
        let set = c.starter_set(&ar).unwrap();
        assert_eq!(set.download_now(), ["decor", "tafsir.ar.muyassar"]);
        assert!(
            set.items.iter().all(|i| i.pack_id != "wbw.en"),
            "no Arabic WBW gloss exists"
        );

        let none = StarterChoices {
            translation: None,
            ..en.clone()
        };
        assert_eq!(c.starter_set(&none).unwrap().download_now(), ["decor"]);
        let bad = StarterChoices {
            translation: Some("wbw.en".into()),
            ..en.clone()
        };
        assert!(matches!(c.starter_set(&bad), Err(PackError::Catalog(_))));
        let unknown = StarterChoices {
            reciter_id: 999,
            ..en
        };
        assert!(matches!(
            c.starter_set(&unknown),
            Err(PackError::NotFound(_))
        ));
    }

    #[test]
    fn now_packs_pull_in_their_requirements() {
        let mut v = valid();
        // A translation that needs the (optional) Nastaliq font: "Download now" fetches it too.
        v["packs"].as_array_mut().unwrap().push(json!({
            "id": "decor.nastaliq", "kind": "decor", "title": l10n("Urdu Nastaliq font", "خط النستعليق الأردي"),
            "description": l10n("Noto Nastaliq Urdu", "نوتو نستعليق"), "language": "ur", "version": "5.3.0",
            "installMode": "whole", "sizeBytes": 5, "itemCount": 1, "attribution": attribution(),
            "source": { "adapter": "static_files", "files": [
              { "path": "noto-nastaliq-urdu.woff2", "urls": ["https://a.org/n.woff2"], "bytes": 5 } ] } }));
        pack_mut(&mut v, "tr.en.saheeh")["requires"] = json!(["decor.nastaliq"]);
        assert_eq!(messages(&v), Vec::<String>::new());
        let c = parse(&v);
        let set = c
            .starter_set(&StarterChoices::defaults(&c, UiLanguage::En))
            .unwrap();
        assert_eq!(
            set.download_now(),
            ["decor", "tr.en.saheeh", "decor.nastaliq"]
        );
        assert_eq!(set.download_now_bytes(), 30 + 518_866 + 5);
    }
}
