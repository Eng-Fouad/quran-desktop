//! Source adapters by enum dispatch.
//!
//! [`Adapter`] is at the same time the catalog's `source` union (internally tagged by `"adapter"`, camelCase fields,
//! unknown fields rejected) and the dispatcher of the per-adapter functions. This file fixes:
//! - each variant's config type,
//! - the item ids ([`ItemKey`] ⇄ `pack_item.item` ⇄ IPC item numbers) and [`Adapter::items`],
//! - the shared [`AdapterCtx`] / [`ItemOutcome`] / [`StagedPack`] types,
//! - the per-adapter function signatures, by calling them: `qcf_font_pages::fetch_page`, `static_files::fetch_file`,
//!   `quranenc_sqlite::{install, check_update}`; `qurancom_tafsir::fetch_chapter`, `qurancom_wbw::fetch_chapter`,
//!   `qdc_audio::{fetch_surah, check_update}`.
//!
//! So each adapter's variant file is implemented without editing a shared file. Every adapter future MUST be `Send`
//! (jobs run on the tokio runtime); `tests::adapter_futures_are_send` enforces it at compile time.

pub mod qcf_font_pages;
pub mod qdc_audio;
pub mod qurancom_tafsir;
pub mod qurancom_wbw;
pub mod quranenc_sqlite;
pub mod static_files;

use std::fmt;
use std::path::{Path, PathBuf};

use quran_core::{ContentDb, CoreDb, CoreError, InstalledPackRow, PackTokenizer, UserDb};
use quran_types::{InstallScope, L10nText, MushafStyle, PAGE_COUNT, PackKind, SURAH_COUNT};
use serde::{Deserialize, Serialize};

use crate::PackError;
use crate::http::Http;
use crate::jobs::JobHandle;
use crate::writers::Writers;

/// A catalog source, and the adapter that installs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "adapter")]
pub enum Adapter {
    /// QCF per-page fonts (`mushaf_fonts`).
    #[serde(rename = "qcf_font_pages")]
    QcfFontPages(QcfFontPagesConfig),
    /// Fixed files (`decor`, `decor.nastaliq`).
    #[serde(rename = "static_files")]
    StaticFiles(StaticFilesConfig),
    /// A QuranEnc SQLite export → a pack DB (`translation`, `tafsir`).
    #[serde(rename = "quranenc_sqlite")]
    QuranEncSqlite(QuranEncSqliteConfig),
    /// Quran.com tafsir by chapter → content.db (`tafsir`).
    #[serde(rename = "qurancom_v4_tafsir_by_chapter")]
    QurancomTafsir(QurancomTafsirConfig),
    /// Quran.com word-by-word by chapter → content.db (`wbw`).
    #[serde(rename = "qurancom_v4_wbw")]
    QurancomWbw(QurancomWbwConfig),
    /// QDC recitation files and timings (`recitation`).
    #[serde(rename = "qdc_audio")]
    QdcAudio(QdcAudioConfig),
}

/// `{ adapter: "qcf_font_pages"; variant; urlTemplates }`; templates carry a `{page}` placeholder, tried in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QcfFontPagesConfig {
    pub variant: FontVariant,
    pub url_templates: Vec<String>,
}

/// QCF glyph variant: the `packs/mushaf/{v1|v2|v4}/` directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontVariant {
    V1,
    V2,
    V4,
}

impl FontVariant {
    /// Directory name under `packs/mushaf/` and the family infix (`qcf-v2-p262`).
    #[must_use]
    pub const fn dir(self) -> &'static str {
        match self {
            Self::V1 => "v1",
            Self::V2 => "v2",
            Self::V4 => "v4",
        }
    }

    /// The variant a QCF style renders with; `None` for `hafs` (no page fonts).
    #[must_use]
    pub const fn for_style(style: MushafStyle) -> Option<Self> {
        match style {
            MushafStyle::Hafs => None,
            MushafStyle::QcfV1 => Some(Self::V1),
            MushafStyle::QcfV2 => Some(Self::V2),
            MushafStyle::QcfV4 => Some(Self::V4),
        }
    }
}

/// `{ adapter: "static_files"; files }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticFilesConfig {
    pub files: Vec<StaticFile>,
}

/// One file of a `static_files` pack, written to `packs/{kind dir}/{path}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticFile {
    /// File name, e.g. `qcf-surah-header.woff2`.
    pub path: String,
    /// Mirrors, tried in order.
    pub urls: Vec<String>,
    pub bytes: u64,
    /// Verified when present; otherwise recorded on first download (trust on first use).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// `{ adapter: "quranenc_sqlite"; key; version; sha256?; versionSource; tokenizer; contentKind }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuranEncSqliteConfig {
    /// QuranEnc key, e.g. `english_saheeh` → `https://quranenc.com/downloads/sqlite/{key}.zip`.
    pub key: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub version_source: VersionSource,
    pub tokenizer: PackTokenizer,
    pub content_kind: ContentKind,
}

/// How QuranEnc updates are detected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionSource {
    /// `GET https://quranenc.com/api/v1/translations/list`, compare `version`.
    List,
    /// Conditional `HEAD` of the zip (`If-None-Match`/`If-Modified-Since`): not 304 and a validator or length differs.
    HttpValidators,
}

/// What a QuranEnc export holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    Translation,
    /// One entry per ayah (`to = from`).
    Tafsir,
}

/// `{ adapter: "qurancom_v4_tafsir_by_chapter"; resourceId }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QurancomTafsirConfig {
    pub resource_id: u32,
}

/// `{ adapter: "qurancom_v4_wbw"; language }` (ISO code, e.g. `"en"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QurancomWbwConfig {
    pub language: String,
}

/// `{ adapter: "qdc_audio"; reciterId; name; style?; basmalaInFile; hosts; wordLevel }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QdcAudioConfig {
    pub reciter_id: u32,
    pub name: L10nText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<L10nText>,
    /// `false` for every QDC reciter: the basmala plays from the surah-1 file.
    pub basmala_in_file: bool,
    /// Download hosts in fallback order (`download.quranicaudio.com`, then `.org`).
    pub hosts: Vec<String>,
    /// From the one-time `catalog-check --online` probe; reported until real timings arrive.
    pub word_level: bool,
}

/// One installable unit of a pack. Its `pack_item.item` text is [`ItemKey::db_key`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ItemKey {
    /// Mushaf font page `N` ↔ `p{N}`.
    Page(u32),
    /// Recitation surah `N` ↔ `{N:03}`.
    Surah(u32),
    /// WBW / Quran.com tafsir chapter `N` ↔ `ch{N}`.
    Chapter(u32),
    /// A static file ↔ `file:{path}`.
    File(String),
    /// A whole-pack install (QuranEnc) ↔ `pack`.
    Whole,
}

impl ItemKey {
    /// The `pack_item.item` text: `p262`, `002`, `ch18`, `file:qcf-surah-header.woff2`, `pack`.
    #[must_use]
    pub fn db_key(&self) -> String {
        match self {
            Self::Page(n) => format!("p{n}"),
            Self::Surah(n) => format!("{n:03}"),
            Self::Chapter(n) => format!("ch{n}"),
            Self::File(path) => format!("file:{path}"),
            Self::Whole => "pack".to_owned(),
        }
    }

    /// Inverse of [`Self::db_key`].
    #[must_use]
    pub fn parse_db_key(s: &str) -> Option<Self> {
        let number = |digits: &str| -> Option<u32> {
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| digits.parse().ok())
                .flatten()
        };
        if s == "pack" {
            Some(Self::Whole)
        } else if let Some(path) = s.strip_prefix("file:") {
            (!path.is_empty()).then(|| Self::File(path.to_owned()))
        } else if let Some(n) = s.strip_prefix("ch") {
            number(n).map(Self::Chapter)
        } else if let Some(n) = s.strip_prefix('p') {
            number(n).map(Self::Page)
        } else if s.len() == 3 {
            number(s).map(Self::Surah)
        } else {
            None
        }
    }

    /// The IPC item number (`PackItemState.item`, `InstallScope::Items`); `None` for files and whole packs.
    #[must_use]
    pub const fn number(&self) -> Option<u32> {
        match self {
            Self::Page(n) | Self::Surah(n) | Self::Chapter(n) => Some(*n),
            Self::File(_) | Self::Whole => None,
        }
    }
}

impl fmt::Display for ItemKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.db_key())
    }
}

/// Everything an adapter needs, as cheap clones of shared handles (so adapter futures can be spawned).
#[derive(Clone)]
pub struct AdapterCtx {
    pub pack_id: String,
    pub kind: PackKind,
    /// `<app_local_data_dir>/packs` (the `quran://` root).
    pub packs_root: PathBuf,
    /// The shared HTTP layer: limits, retries, mirrors, `.dl.part` resume, online tracking.
    pub http: Http,
    pub core: CoreDb,
    pub user: UserDb,
    pub content: ContentDb,
    /// Single writer per audio file (streams vs jobs).
    pub writers: Writers,
    /// The background job this work belongs to (cancel/pause checks between 64 KiB chunks, byte progress); `None` on
    /// the interactive lane.
    pub job: Option<JobHandle>,
    /// Explicit download (`pinned = 1`, survives "Clear cache") rather than on-demand cache.
    pub pin: bool,
}

/// What fetching one item did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemOutcome {
    /// Downloaded (or fetched into content.db), verified and moved into place: record it in `pack_item`.
    Stored { bytes: u64, sha256: String },
    /// Already present and complete (resume, or a stream promoted the file first): only (re)pin or touch it.
    Present { bytes: u64 },
}

/// A whole pack built in staging, ready for the atomic flip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedPack {
    /// The finished `pack.db` inside `packs/.staging/{uuid}/`.
    pub db_path: PathBuf,
    /// Directory name of the new version: `packs/{kind}/{id}/{version}/pack.db`.
    pub version: String,
    /// `installed_pack.source_version` (JSON: the list version, or `{etag, lastModified, contentLength}`).
    pub source_version: String,
    /// sha256 of the downloaded archive.
    pub sha256: String,
    /// Size of `pack.db`.
    pub bytes: u64,
}

impl Adapter {
    /// The catalog `adapter` tag.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::QcfFontPages(_) => "qcf_font_pages",
            Self::StaticFiles(_) => "static_files",
            Self::QuranEncSqlite(_) => "quranenc_sqlite",
            Self::QurancomTafsir(_) => "qurancom_v4_tafsir_by_chapter",
            Self::QurancomWbw(_) => "qurancom_v4_wbw",
            Self::QdcAudio(_) => "qdc_audio",
        }
    }

    /// Whether this adapter can install a pack of `kind` (catalog consistency rule).
    #[must_use]
    pub fn supports_kind(&self, kind: PackKind) -> bool {
        match self {
            Self::QcfFontPages(_) => kind == PackKind::MushafFonts,
            Self::StaticFiles(_) => kind == PackKind::Decor,
            Self::QuranEncSqlite(c) => match c.content_kind {
                ContentKind::Translation => kind == PackKind::Translation,
                ContentKind::Tafsir => kind == PackKind::Tafsir,
            },
            Self::QurancomTafsir(_) => kind == PackKind::Tafsir,
            Self::QurancomWbw(_) => kind == PackKind::Wbw,
            Self::QdcAudio(_) => kind == PackKind::Recitation,
        }
    }

    /// The items an install of `scope` covers, sorted and deduplicated. Decor, QuranEnc translations and tafsir have no
    /// per-item scope (`All` only). Pinning any surah of a reciter also pins surah 1, whose file plays every other
    /// surah's basmala.
    pub fn items(&self, scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        let numbered = |max: u32, what: &str, make: fn(u32) -> ItemKey| match scope {
            InstallScope::All => Ok((1..=max).map(make).collect::<Vec<_>>()),
            InstallScope::Items { items } => {
                if items.is_empty() {
                    return Err(invalid(format!("no {what} given")));
                }
                items
                    .iter()
                    .map(|&n| {
                        if (1..=max).contains(&n) {
                            Ok(make(n))
                        } else {
                            Err(invalid(format!("{what} {n} is outside 1..={max}")))
                        }
                    })
                    .collect()
            }
        };
        let mut keys = match self {
            Self::QcfFontPages(_) => numbered(PAGE_COUNT, "page", ItemKey::Page)?,
            Self::QurancomTafsir(_) | Self::QurancomWbw(_) => {
                numbered(SURAH_COUNT, "chapter", ItemKey::Chapter)?
            }
            Self::QdcAudio(_) => {
                let mut surahs = numbered(SURAH_COUNT, "surah", ItemKey::Surah)?;
                surahs.push(ItemKey::Surah(1));
                surahs
            }
            Self::StaticFiles(c) => match scope {
                InstallScope::All => c
                    .files
                    .iter()
                    .map(|f| ItemKey::File(f.path.clone()))
                    .collect(),
                InstallScope::Items { .. } => return Err(whole_only(self)),
            },
            Self::QuranEncSqlite(_) => match scope {
                InstallScope::All => vec![ItemKey::Whole],
                InstallScope::Items { .. } => return Err(whole_only(self)),
            },
        };
        keys.sort();
        keys.dedup();
        Ok(keys)
    }

    /// Downloads (or fetches into content.db), verifies and stores one item. Whole packs use
    /// [`Adapter::install_whole`] instead.
    pub async fn fetch_item(
        &self,
        ctx: &AdapterCtx,
        item: &ItemKey,
    ) -> Result<ItemOutcome, PackError> {
        match (self, item) {
            (Self::QcfFontPages(c), ItemKey::Page(page)) => {
                qcf_font_pages::fetch_page(ctx, c, *page).await
            }
            (Self::StaticFiles(c), ItemKey::File(path)) => {
                let file = c.files.iter().find(|f| f.path == *path).ok_or_else(|| {
                    PackError::NotFound(format!("{}: no file {path}", ctx.pack_id))
                })?;
                static_files::fetch_file(ctx, c, file).await
            }
            (Self::QurancomTafsir(c), ItemKey::Chapter(surah)) => {
                qurancom_tafsir::fetch_chapter(ctx, c, *surah).await
            }
            (Self::QurancomWbw(c), ItemKey::Chapter(surah)) => {
                qurancom_wbw::fetch_chapter(ctx, c, *surah).await
            }
            (Self::QdcAudio(c), ItemKey::Surah(surah)) => {
                qdc_audio::fetch_surah(ctx, c, *surah).await
            }
            (adapter, item) => Err(PackError::Unsupported(format!(
                "{}: {} has no item {item}",
                ctx.pack_id,
                adapter.name()
            ))),
        }
    }

    /// Builds a whole pack (QuranEnc) in `staging` (`packs/.staging/{uuid}/`) for the atomic flip.
    pub async fn install_whole(
        &self,
        ctx: &AdapterCtx,
        staging: &Path,
    ) -> Result<StagedPack, PackError> {
        match self {
            Self::QuranEncSqlite(c) => quranenc_sqlite::install(ctx, c, staging).await,
            other => Err(PackError::Unsupported(format!(
                "{}: {} installs per item",
                ctx.pack_id,
                other.name()
            ))),
        }
    }

    /// The latest upstream version when it differs from `installed` (QuranEnc list version or HTTP validators; QDC
    /// audio file changes). `Ok(None)`: up to date, or the adapter has no update check (fonts, decor, QF chapters,
    /// which the revalidator refreshes in place).
    pub async fn check_update(
        &self,
        ctx: &AdapterCtx,
        installed: &InstalledPackRow,
    ) -> Result<Option<String>, PackError> {
        match self {
            Self::QuranEncSqlite(c) => quranenc_sqlite::check_update(ctx, c, installed).await,
            Self::QdcAudio(c) => qdc_audio::check_update(ctx, c, installed).await,
            Self::QcfFontPages(_)
            | Self::StaticFiles(_)
            | Self::QurancomTafsir(_)
            | Self::QurancomWbw(_) => Ok(None),
        }
    }
}

fn invalid(message: String) -> PackError {
    PackError::Core(CoreError::InvalidArgument(message))
}

fn whole_only(adapter: &Adapter) -> PackError {
    PackError::Unsupported(format!(
        "{} packs install whole: per-item scope is not supported",
        adapter.name()
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use serde_json::json;

    use super::*;

    fn parse(v: serde_json::Value) -> Adapter {
        serde_json::from_value(v).unwrap()
    }

    /// The catalog's `Source` union, one example per adapter, round-trips through [`Adapter`].
    #[test]
    fn catalog_sources_round_trip() {
        let sources = [
            json!({ "adapter": "qcf_font_pages", "variant": "v4", "urlTemplates": [
                "https://verses.quran.foundation/fonts/quran/hafs/v4/colrv1/woff2/p{page}.woff2",
                "https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/v4-tajweed/woff2/p{page}.woff2"] }),
            json!({ "adapter": "static_files", "files": [
                { "path": "qcf-surah-header.woff2", "urls": ["https://example.invalid/h.woff2"], "bytes": 118_552 },
                { "path": "quran-common.ttf", "urls": ["https://example.invalid/c.ttf"], "bytes": 125_444,
                  "sha256": "00" }] }),
            json!({ "adapter": "quranenc_sqlite", "key": "english_saheeh", "version": "1.1.2",
                    "versionSource": "list", "tokenizer": "porter_unicode61", "contentKind": "translation" }),
            json!({ "adapter": "quranenc_sqlite", "key": "arabic_moyassar", "version": "2026.10",
                    "versionSource": "http_validators", "tokenizer": "arabic_normalized", "contentKind": "tafsir" }),
            json!({ "adapter": "qurancom_v4_tafsir_by_chapter", "resourceId": 169 }),
            json!({ "adapter": "qurancom_v4_wbw", "language": "en" }),
            json!({ "adapter": "qdc_audio", "reciterId": 7,
                    "name": { "en": "Mishari Rashid al-Afasy", "ar": "مشاري راشد العفاسي" },
                    "basmalaInFile": false,
                    "hosts": ["download.quranicaudio.com", "download.quranicaudio.org"], "wordLevel": true }),
        ];
        let names = [
            "qcf_font_pages",
            "static_files",
            "quranenc_sqlite",
            "quranenc_sqlite",
            "qurancom_v4_tafsir_by_chapter",
            "qurancom_v4_wbw",
            "qdc_audio",
        ];
        for (source, name) in sources.into_iter().zip(names) {
            let adapter = parse(source.clone());
            assert_eq!(adapter.name(), name);
            assert_eq!(
                serde_json::to_value(&adapter).unwrap(),
                source,
                "{name} round-trips"
            );
        }
    }

    #[test]
    fn unknown_fields_and_adapters_are_rejected() {
        let typo = json!({ "adapter": "qurancom_v4_wbw", "language": "en", "lang": "en" });
        assert!(serde_json::from_value::<Adapter>(typo).is_err());
        let unknown = json!({ "adapter": "everyayah", "url": "x" });
        assert!(serde_json::from_value::<Adapter>(unknown).is_err());
        let bad_variant =
            json!({ "adapter": "qcf_font_pages", "variant": "v3", "urlTemplates": [] });
        assert!(serde_json::from_value::<Adapter>(bad_variant).is_err());
    }

    #[test]
    fn item_keys_round_trip() {
        for key in [
            ItemKey::Page(1),
            ItemKey::Page(604),
            ItemKey::Surah(2),
            ItemKey::Surah(114),
            ItemKey::Chapter(18),
            ItemKey::File("qcf-surah-header.woff2".into()),
            ItemKey::Whole,
        ] {
            assert_eq!(
                ItemKey::parse_db_key(&key.db_key()),
                Some(key.clone()),
                "{key}"
            );
        }
        assert_eq!(ItemKey::Page(262).db_key(), "p262");
        assert_eq!(ItemKey::Surah(2).db_key(), "002");
        assert_eq!(ItemKey::Chapter(18).db_key(), "ch18");
        for bad in ["", "p", "px", "ch", "02", "0002", "file:", "p-1", "pack2"] {
            assert_eq!(ItemKey::parse_db_key(bad), None, "{bad:?}");
        }
        assert_eq!(ItemKey::Chapter(18).number(), Some(18));
        assert_eq!(ItemKey::Whole.number(), None);
    }

    #[test]
    fn items_follow_the_scope_rules() {
        let fonts =
            parse(json!({ "adapter": "qcf_font_pages", "variant": "v2", "urlTemplates": [] }));
        assert_eq!(fonts.items(&InstallScope::All).unwrap().len(), 604);
        assert_eq!(
            fonts
                .items(&InstallScope::Items {
                    items: vec![3, 1, 3]
                })
                .unwrap(),
            [ItemKey::Page(1), ItemKey::Page(3)]
        );
        let err = fonts
            .items(&InstallScope::Items { items: vec![605] })
            .unwrap_err();
        assert_eq!(quran_types::AppError::from(err).kind(), "invalid_argument");
        assert!(fonts.items(&InstallScope::Items { items: vec![] }).is_err());

        let audio = parse(
            json!({ "adapter": "qdc_audio", "reciterId": 7, "name": { "en": "a", "ar": "b" },
                                  "basmalaInFile": false, "hosts": [], "wordLevel": true }),
        );
        assert_eq!(
            audio
                .items(&InstallScope::Items {
                    items: vec![36, 18]
                })
                .unwrap(),
            [ItemKey::Surah(1), ItemKey::Surah(18), ItemKey::Surah(36)],
            "pinning any surah pins surah 1 too"
        );
        assert_eq!(audio.items(&InstallScope::All).unwrap().len(), 114);

        let wbw = parse(json!({ "adapter": "qurancom_v4_wbw", "language": "en" }));
        assert_eq!(wbw.items(&InstallScope::All).unwrap().len(), 114);

        let zip = parse(
            json!({ "adapter": "quranenc_sqlite", "key": "k", "version": "1", "versionSource": "list",
                                "tokenizer": "like_fallback", "contentKind": "translation" }),
        );
        assert_eq!(zip.items(&InstallScope::All).unwrap(), [ItemKey::Whole]);
        let err = zip
            .items(&InstallScope::Items { items: vec![1] })
            .unwrap_err();
        assert!(matches!(err, PackError::Unsupported(_)));

        let decor = parse(json!({ "adapter": "static_files", "files": [
            { "path": "b.woff2", "urls": [], "bytes": 1 }, { "path": "a.ttf", "urls": [], "bytes": 1 }] }));
        assert_eq!(
            decor.items(&InstallScope::All).unwrap(),
            [
                ItemKey::File("a.ttf".into()),
                ItemKey::File("b.woff2".into())
            ]
        );
    }

    #[test]
    fn kinds_and_variants() {
        let tafsir = parse(
            json!({ "adapter": "quranenc_sqlite", "key": "k", "version": "1",
            "versionSource": "list", "tokenizer": "arabic_normalized", "contentKind": "tafsir" }),
        );
        assert!(tafsir.supports_kind(PackKind::Tafsir));
        assert!(!tafsir.supports_kind(PackKind::Translation));
        assert_eq!(FontVariant::for_style(MushafStyle::Hafs), None);
        assert_eq!(
            FontVariant::for_style(MushafStyle::QcfV4).map(FontVariant::dir),
            Some("v4")
        );
    }

    /// Compile-time guard: every adapter future is `Send`, so jobs can run them on the tokio runtime.
    #[allow(dead_code)]
    fn adapter_futures_are_send(
        a: &Adapter,
        ctx: &AdapterCtx,
        item: &ItemKey,
        row: &InstalledPackRow,
    ) {
        fn send<T: Send>(_: &T) {}
        send(&a.fetch_item(ctx, item));
        send(&a.install_whole(ctx, Path::new("staging")));
        send(&a.check_update(ctx, row));
    }
}
