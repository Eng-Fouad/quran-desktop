//! `quranenc_sqlite`: QuranEnc SQLite exports → versioned pack DBs.
//!
//! **Install** ([`install`], built in the pack's staging directory `packs/.staging/{packId}/`):
//! 1. `GET https://quranenc.com/downloads/sqlite/{key}.zip` with the job: resumable (`{key}.dl.part` + sidecar), must
//!    start with `PK\x03\x04`, at most [`MAX_ZIP_BYTES`], and match the catalog `sha256` when one is pinned. The catalog
//!    size is **not** enforced: QuranEnc's terms require the latest version, whose length changes. The verified zip and
//!    its validators (`{key}.zip.json`) stay in staging, so a resume after a pause or a failed build skips the download.
//! 2. `versionSource: list` packs read `GET https://quranenc.com/api/v1/translations/list` for the version, title and
//!    description of the key (the catalog version is the fallback when the list is unreachable or lacks the key).
//!    `http_validators` packs are versioned `YYYY.MM` from the nginx ETag (`"<mtime hex>-<size hex>"`), as the catalog
//!    is; an update within the same month gets `YYYY.MM.DD` ([`validators_version`]).
//! 3. Phase `verifying`: exactly one `*.sqlite` entry (its name is not assumed; at most [`MAX_SQLITE_BYTES`], CRC
//!    checked) is extracted and turned into `pack.db` by [`crate::transform::translation::build_pack_db`] (6,236 rows,
//!    footnotes, the ammonia policy, the pack's tokenizer). A damaged zip or export is deleted, so "Retry" downloads it
//!    again.
//! 4. The job runner flips `pack.db` into `packs/{kind}/{id}/{version}/` and stores [`SourceVersion`] (key, list
//!    version, ETag, Last-Modified, Content-Length) as `installed_pack.source_version`.
//!
//! **Updates** ([`check_update`]): `list` compares the list API's version with the installed one (a key that vanished
//! from the list falls back to the validators); `http_validators` sends a conditional `HEAD` with `If-None-Match` only —
//! QuranEnc answers every zip with the same year-2000 `Last-Modified`, so `If-Modified-Since` would hide every update —
//! and reports an update when the answer is not `304` and the ETag or the length changed. The latest version is named
//! as an install would name it. Without a job the checks take the interactive lane: they are a few small requests that
//! someone (Settings › Check for updates) may be waiting for.
//!
//! [`install_from`] and [`check_update_from`] take the [`Endpoints`] explicitly (tests point them at a local server).

use std::io::{self, Read};
use std::path::{Path, PathBuf};

use quran_core::pack_db::PACK_FORMAT;
use quran_core::{InstalledPackRow, InstalledStatus, NORMALIZER_VERSION, PackMeta};
use quran_types::{JobPhase, PackKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{AdapterCtx, ContentKind, QuranEncSqliteConfig, StagedPack, VersionSource};
use crate::PackError;
use crate::catalog::language_direction;
use crate::http::{Expect, Lane, Request, Validators};
use crate::install::{self, PACK_DB_FILE};
use crate::jobs::JobHandle;
use crate::transform::translation::build_pack_db;

/// Where QuranEnc serves the zips (`{ZIP_BASE}{key}.zip`).
pub const ZIP_BASE: &str = "https://quranenc.com/downloads/sqlite/";
/// The versioned translations list.
pub const LIST_URL: &str = "https://quranenc.com/api/v1/translations/list";
/// The largest zip accepted (the biggest export, Bengali Zakaria, is 4.2 MB).
pub const MAX_ZIP_BYTES: u64 = 128 * 1024 * 1024;
/// The largest export accepted once unzipped (Bengali Zakaria: 15.3 MB).
pub const MAX_SQLITE_BYTES: u64 = 512 * 1024 * 1024;
/// Every zip starts with a local file header.
pub const ZIP_MAGIC: &[u8] = b"PK\x03\x04";
/// `meta.licence` of the pack DBs (QuranEnc's republishing terms).
pub const LICENCE: &str =
    "QuranEnc terms: republished unmodified, credited with its version, kept up to date";
/// `meta.attribution` of the pack DBs.
pub const ATTRIBUTION: &str = "QuranEnc.com — The Noble Qur'an Encyclopedia";

/// The URLs an install or update check talks to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// Mirrors of the zip, tried in order.
    pub zip: Vec<String>,
    /// The list API.
    pub list: String,
}

impl Endpoints {
    /// QuranEnc's own URLs for `key`.
    #[must_use]
    pub fn quranenc(key: &str) -> Self {
        Self {
            zip: vec![format!("{ZIP_BASE}{key}.zip")],
            list: LIST_URL.to_owned(),
        }
    }
}

/// `installed_pack.source_version` of a QuranEnc pack (JSON, camelCase).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVersion {
    pub key: String,
    /// The list API's version (`versionSource: list` packs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The list API's `last_update` (Unix seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_update: Option<i64>,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    /// The zip's length.
    #[serde(default)]
    pub content_length: Option<u64>,
}

impl SourceVersion {
    /// Parses a stored value; `None` when it is not this JSON.
    #[must_use]
    pub fn parse(json: &str) -> Option<Self> {
        serde_json::from_str(json).ok()
    }

    /// The stored JSON.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// One entry of the list API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListEntry {
    pub key: String,
    pub version: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub last_update: Option<i64>,
}

/// `{key}.zip.json` next to a verified zip in staging: what the download returned, so a resume can skip it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipRecord {
    url: String,
    bytes: u64,
    sha256: String,
    validators: Validators,
}

/// Downloads, verifies and transforms the export into `staging/pack.db`.
pub async fn install(
    ctx: &AdapterCtx,
    cfg: &QuranEncSqliteConfig,
    staging: &Path,
) -> Result<StagedPack, PackError> {
    install_from(ctx, cfg, staging, &Endpoints::quranenc(&cfg.key)).await
}

/// `Some(latest)` when the list version or the zip's HTTP validators differ from `installed`.
pub async fn check_update(
    ctx: &AdapterCtx,
    cfg: &QuranEncSqliteConfig,
    installed: &InstalledPackRow,
) -> Result<Option<String>, PackError> {
    check_update_from(ctx, cfg, installed, &Endpoints::quranenc(&cfg.key)).await
}

/// [`install`] against explicit endpoints.
pub async fn install_from(
    ctx: &AdapterCtx,
    cfg: &QuranEncSqliteConfig,
    staging: &Path,
    endpoints: &Endpoints,
) -> Result<StagedPack, PackError> {
    check_config(ctx, cfg)?;
    let lang = pack_language(&ctx.pack_id).ok_or_else(|| {
        PackError::Catalog(format!(
            "{}: no language in the pack id (tr.{{lang}}.{{name}})",
            ctx.pack_id
        ))
    })?;
    tokio::fs::create_dir_all(staging).await?;
    let zip_path = staging.join(format!("{}.zip", cfg.key));
    let record_path = staging.join(format!("{}.zip.json", cfg.key));

    // 1. The zip (reused when a previous run verified it).
    let record = match reusable_zip(&zip_path, &record_path, cfg.sha256.as_deref()).await {
        Some(record) => {
            log::info!(
                "{}: reusing the verified download of {}",
                ctx.pack_id,
                cfg.key
            );
            if let Some(job) = &ctx.job {
                job.set_expected_len(record.bytes);
                job.add_resumed(record.bytes);
            }
            record
        }
        None => {
            install::remove_file(&zip_path).await?;
            install::remove_file(&record_path).await?;
            let mut expect = Expect::default().max_len(MAX_ZIP_BYTES).magic(ZIP_MAGIC);
            if let Some(sha) = &cfg.sha256 {
                expect = expect.sha256(sha.clone());
            }
            let done = ctx
                .http
                .download(Request::for_ctx(ctx, &endpoints.zip), &zip_path, &expect)
                .await?;
            let record = ZipRecord {
                url: done.url,
                bytes: done.bytes,
                sha256: done.sha256,
                validators: done.validators,
            };
            let json = serde_json::to_vec(&record)
                .map_err(|e| PackError::Io(io::Error::other(e.to_string())))?;
            install::write_atomic(&record_path, json).await?;
            record
        }
    };

    // 2. Version, name and description.
    let listed = match cfg.version_source {
        VersionSource::List => list_entry(ctx, cfg, endpoints).await?,
        VersionSource::HttpValidators => None,
    };
    let version = match cfg.version_source {
        VersionSource::List => listed
            .as_ref()
            .map_or_else(|| cfg.version.clone(), |e| e.version.clone()),
        VersionSource::HttpValidators => {
            let current = installed_row(ctx).await?;
            let current_etag = current
                .as_ref()
                .and_then(|r| r.source_version.as_deref())
                .and_then(SourceVersion::parse)
                .and_then(|s| s.etag);
            validators_version(
                record.validators.etag.as_deref(),
                &cfg.version,
                current
                    .as_ref()
                    .map(|r| (r.version.as_str(), current_etag.as_deref())),
            )
        }
    };
    let source_version = SourceVersion {
        key: cfg.key.clone(),
        version: listed.as_ref().map(|e| e.version.clone()),
        last_update: listed.as_ref().and_then(|e| e.last_update),
        etag: record.validators.etag.clone(),
        last_modified: record.validators.last_modified.clone(),
        content_length: Some(record.bytes),
    };

    // 3. Verify and transform.
    if let Some(job) = &ctx.job {
        job.set_phase(JobPhase::Verifying);
    }
    let meta = PackMeta {
        pack_id: ctx.pack_id.clone(),
        kind: ctx.kind,
        lang: lang.to_owned(),
        dir: language_direction(lang),
        name: listed
            .as_ref()
            .and_then(|e| e.title.clone())
            .unwrap_or_else(|| cfg.key.clone()),
        author: listed
            .as_ref()
            .and_then(|e| e.description.clone())
            .unwrap_or_default(),
        source: if record.url.is_empty() {
            endpoints.zip.first().cloned().unwrap_or_default()
        } else {
            record.url.clone()
        },
        source_version: version.clone(),
        licence: LICENCE.to_owned(),
        attribution: ATTRIBUTION.to_owned(),
        tokenizer: cfg.tokenizer,
        normalizer_version: NORMALIZER_VERSION,
        format: PACK_FORMAT,
    };
    let db_path = staging.join(PACK_DB_FILE);
    let sqlite_path = staging.join(format!("{}.sqlite", cfg.key));
    let built = {
        let (zip_path, sqlite_path, db_path) =
            (zip_path.clone(), sqlite_path.clone(), db_path.clone());
        let sha = record.sha256.clone();
        let job = ctx.job.clone();
        tokio::task::spawn_blocking(move || {
            let check = || job.as_ref().map_or(Ok(()), JobHandle::check);
            let result = extract_single_sqlite(&zip_path, &sqlite_path, MAX_SQLITE_BYTES).and_then(
                |entry| {
                    log::debug!("{}: extracted {entry}", meta.pack_id);
                    check()?;
                    build_pack_db(&sqlite_path, &db_path, &meta, &sha, &check)
                },
            );
            // The export is only an input; the staging directory goes after the flip anyway.
            let _ = install::remove_file_blocking(&sqlite_path);
            result
        })
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("build task failed: {e}"))))?
    };
    let stats = match built {
        Ok(stats) => stats,
        Err(e) => {
            if matches!(e, PackError::Integrity(_) | PackError::Zip(_)) {
                // A damaged download must not be reused by "Retry".
                install::remove_file(&zip_path).await?;
                install::remove_file(&record_path).await?;
            }
            return Err(e);
        }
    };
    log::info!(
        "{}: built {} version {version} ({} entries, {} footnotes, {} bytes)",
        ctx.pack_id,
        cfg.key,
        stats.entries,
        stats.footnotes,
        stats.bytes
    );
    Ok(StagedPack {
        db_path,
        version,
        source_version: source_version.to_json(),
        sha256: record.sha256,
        bytes: stats.bytes,
    })
}

/// [`check_update`] against explicit endpoints.
pub async fn check_update_from(
    ctx: &AdapterCtx,
    cfg: &QuranEncSqliteConfig,
    installed: &InstalledPackRow,
    endpoints: &Endpoints,
) -> Result<Option<String>, PackError> {
    check_config(ctx, cfg)?;
    let stored = installed
        .source_version
        .as_deref()
        .and_then(SourceVersion::parse);
    if cfg.version_source == VersionSource::List {
        let entries = fetch_list(ctx, &endpoints.list).await?;
        if let Some(entry) = entries.into_iter().find(|e| e.key == cfg.key) {
            let current = stored
                .as_ref()
                .and_then(|s| s.version.clone())
                .unwrap_or_else(|| installed.version.clone());
            return Ok((entry.version != current).then_some(entry.version));
        }
        log::warn!(
            "{}: {} is no longer in the QuranEnc list; checking the zip's validators",
            ctx.pack_id,
            cfg.key
        );
    }
    validators_update(ctx, cfg, installed, stored.unwrap_or_default(), endpoints).await
}

/// The conditional `HEAD` check (module docs).
async fn validators_update(
    ctx: &AdapterCtx,
    cfg: &QuranEncSqliteConfig,
    installed: &InstalledPackRow,
    stored: SourceVersion,
    endpoints: &Endpoints,
) -> Result<Option<String>, PackError> {
    if stored.etag.is_none() && stored.content_length.is_none() {
        log::warn!(
            "{}: no stored validators, so updates of {} cannot be detected until it is reinstalled",
            ctx.pack_id,
            cfg.key
        );
        return Ok(None);
    }
    let conditional = Validators {
        etag: stored.etag.clone(),
        last_modified: None,
    };
    let head = ctx
        .http
        .head(
            Request::for_ctx(ctx, &endpoints.zip),
            stored.etag.is_some().then_some(&conditional),
        )
        .await?;
    if head.not_modified {
        return Ok(None);
    }
    let etag_changed = match (&stored.etag, &head.validators.etag) {
        (Some(old), Some(new)) => !same_etag(old, new),
        _ => false,
    };
    let length_changed = match (stored.content_length, head.content_length) {
        (Some(old), Some(new)) => old != new,
        _ => false,
    };
    if !etag_changed && !length_changed {
        return Ok(None);
    }
    Ok(Some(validators_version(
        head.validators.etag.as_deref(),
        &cfg.version,
        Some((installed.version.as_str(), stored.etag.as_deref())),
    )))
}

/// The version of a validators-versioned pack whose zip has `etag`: the ETag's `YYYY.MM` (as the catalog), or
/// `YYYY.MM.DD` when the installed version already carries that month (an update within the month), or
/// `YYYY.MM.DD.HHMM` when even the day is taken. Reinstalling the installed file (same ETag) keeps its version; an
/// opaque ETag falls back to the installed version (same file) or the catalog version.
#[must_use]
pub fn validators_version(
    etag: Option<&str>,
    catalog_version: &str,
    installed: Option<(&str, Option<&str>)>,
) -> String {
    if let (Some(new), Some((version, Some(old)))) = (etag, installed)
        && same_etag(new, old)
    {
        return version.to_owned();
    }
    let Some(at) = etag.and_then(etag_time) else {
        return catalog_version.to_owned();
    };
    let month = format!("{:04}.{:02}", at.year(), u8::from(at.month()));
    let Some((current, _)) = installed else {
        return month;
    };
    if !current.starts_with(&month) {
        return month;
    }
    let day = format!("{month}.{:02}", at.day());
    if current == day {
        format!("{day}.{:02}{:02}", at.hour(), at.minute())
    } else {
        day
    }
}

/// The modification time in an nginx ETag (`"67e2bd39-c64f2"` → 2025-03-25T14:27:05Z); weak prefixes are ignored.
#[must_use]
pub fn etag_time(etag: &str) -> Option<time::OffsetDateTime> {
    let inner = etag.trim().trim_start_matches("W/").trim_matches('"');
    let (mtime, size) = inner.split_once('-')?;
    if mtime.is_empty() || mtime.len() > 12 || size.is_empty() {
        return None;
    }
    u64::from_str_radix(size, 16).ok()?;
    let secs = i64::from_str_radix(mtime, 16).ok()?;
    time::OffsetDateTime::from_unix_timestamp(secs).ok()
}

/// ETags compared without the weak prefix and quotes (a CDN may weaken a strong ETag).
fn same_etag(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .trim_start_matches("W/")
            .trim_matches('"')
            .to_owned()
    };
    norm(a) == norm(b)
}

/// The language subtag of a pack id: `tr.en.saheeh` → `en`, `tafsir.ar.muyassar` → `ar`.
#[must_use]
pub fn pack_language(pack_id: &str) -> Option<&str> {
    let lang = pack_id.split('.').nth(1)?;
    ((2..=3).contains(&lang.len()) && lang.bytes().all(|b| b.is_ascii_lowercase())).then_some(lang)
}

/// The pack kind must match the export kind, and the key must be a plain name (it becomes a file name and a URL path).
fn check_config(ctx: &AdapterCtx, cfg: &QuranEncSqliteConfig) -> Result<(), PackError> {
    let expected = match cfg.content_kind {
        ContentKind::Translation => PackKind::Translation,
        ContentKind::Tafsir => PackKind::Tafsir,
    };
    if ctx.kind != expected {
        return Err(PackError::Catalog(format!(
            "{}: a {:?} export cannot install a {:?} pack",
            ctx.pack_id, cfg.content_kind, ctx.kind
        )));
    }
    let key_ok = !cfg.key.is_empty()
        && cfg.key.len() <= 64
        && cfg
            .key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !key_ok {
        return Err(PackError::Catalog(format!(
            "{}: QuranEnc key {:?} is not a plain name",
            ctx.pack_id, cfg.key
        )));
    }
    Ok(())
}

/// The current `installed_pack` row, if a version is installed.
async fn installed_row(ctx: &AdapterCtx) -> Result<Option<InstalledPackRow>, PackError> {
    let (user, pack_id) = (ctx.user.clone(), ctx.pack_id.clone());
    let row = tokio::task::spawn_blocking(move || user.pack_installed(&pack_id))
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("registry task failed: {e}"))))??;
    Ok(row.filter(|r| r.status == InstalledStatus::Installed && r.path.is_some()))
}

/// The list entry of `cfg.key` for an install. The list is metadata: when it cannot be read the catalog version is
/// used, unless the job stopped or the network is off (those end the install).
async fn list_entry(
    ctx: &AdapterCtx,
    cfg: &QuranEncSqliteConfig,
    endpoints: &Endpoints,
) -> Result<Option<ListEntry>, PackError> {
    match fetch_list(ctx, &endpoints.list).await {
        Ok(entries) => {
            let entry = entries.into_iter().find(|e| e.key == cfg.key);
            if entry.is_none() {
                log::warn!(
                    "{}: {} is not in the QuranEnc list; recording catalog version {}",
                    ctx.pack_id,
                    cfg.key,
                    cfg.version
                );
            }
            Ok(entry)
        }
        Err(e @ (PackError::Cancelled | PackError::Offline)) => Err(e),
        Err(e) => {
            log::warn!(
                "{}: QuranEnc list unavailable ({e}); recording catalog version {}",
                ctx.pack_id,
                cfg.version
            );
            Ok(None)
        }
    }
}

/// `GET` the list API, tolerant of field types (numbers or strings). Inside a job it runs on the background lane without
/// counting toward the job's bytes (the zip is the job's payload) but stops as soon as the job does; an update check
/// (no job) is a small request someone waits for, so it takes the interactive lane.
pub async fn fetch_list(ctx: &AdapterCtx, url: &str) -> Result<Vec<ListEntry>, PackError> {
    let urls = [url.to_owned()];
    let lane = if ctx.job.is_some() {
        Lane::Background
    } else {
        Lane::Interactive
    };
    let fetch = ctx.http.get_json::<Value>(Request::new(&urls).lane(lane));
    let value = match &ctx.job {
        Some(job) => tokio::select! {
            biased;
            () = job.stopped() => return Err(PackError::Cancelled),
            v = fetch => v?,
        },
        None => fetch.await?,
    };
    let list = value
        .get("translations")
        .and_then(Value::as_array)
        .ok_or_else(|| PackError::Integrity(format!("{url}: no `translations` array")))?;
    Ok(list.iter().filter_map(parse_list_entry).collect())
}

fn parse_list_entry(v: &Value) -> Option<ListEntry> {
    let text = |key: &str| match v.get(key)? {
        Value::String(s) => Some(s.trim().to_owned()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    Some(ListEntry {
        key: text("key")?,
        version: text("version")?,
        title: text("title"),
        description: text("description"),
        last_update: match v.get("last_update") {
            Some(Value::Number(n)) => n.as_i64(),
            Some(Value::String(s)) => s.trim().parse().ok(),
            _ => None,
        },
    })
}

/// The recorded zip, when its file is still exactly what was verified (and what the catalog pins, if it does).
async fn reusable_zip(zip: &Path, record: &Path, pinned: Option<&str>) -> Option<ZipRecord> {
    let bytes = tokio::fs::read(record).await.ok()?;
    let rec: ZipRecord = serde_json::from_slice(&bytes).ok()?;
    if pinned.is_some_and(|want| !want.eq_ignore_ascii_case(&rec.sha256)) {
        return None;
    }
    if install::file_len(zip).await != Some(rec.bytes) {
        return None;
    }
    let path = zip.to_path_buf();
    let sha = tokio::task::spawn_blocking(move || sha256_file(&path))
        .await
        .ok()?
        .ok()?;
    (sha == rec.sha256).then_some(rec)
}

/// Lowercase hex sha256 of a file.
pub(crate) fn sha256_file(path: &Path) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(buf.get(..n).unwrap_or_default());
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Extracts the archive's only `*.sqlite` entry to `out` (replacing it) and returns the entry's name. Directories and
/// other files are ignored; zero or several `*.sqlite` entries, an entry over `max_bytes` or a bad CRC is an integrity
/// failure. The entry name never becomes a path. Blocking.
pub fn extract_single_sqlite(zip: &Path, out: &Path, max_bytes: u64) -> Result<String, PackError> {
    let file = std::fs::File::open(zip)?;
    let mut archive = zip::ZipArchive::new(io::BufReader::new(file))?;
    let mut found: Option<(usize, String)> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name()?.into_owned();
        if !name.to_ascii_lowercase().ends_with(".sqlite") {
            continue;
        }
        if let Some((_, first)) = &found {
            return Err(PackError::Integrity(format!(
                "the zip holds more than one *.sqlite entry ({first}, {name})"
            )));
        }
        found = Some((i, name));
    }
    let (index, name) =
        found.ok_or_else(|| PackError::Integrity("the zip holds no *.sqlite entry".into()))?;
    let mut entry = archive.by_index(index)?;
    if entry.size() > max_bytes {
        return Err(PackError::Integrity(format!(
            "{name} unpacks to {} bytes (limit {max_bytes})",
            entry.size()
        )));
    }
    install::remove_file_blocking(out)?;
    let result = (|| -> Result<u64, PackError> {
        let mut dest = std::fs::File::create(out)?;
        let copied = io::copy(
            &mut (&mut entry).take(max_bytes.saturating_add(1)),
            &mut dest,
        )
        .map_err(|e| PackError::Integrity(format!("{name}: {e}")))?;
        if copied > max_bytes {
            return Err(PackError::Integrity(format!(
                "{name} unpacks to more than {max_bytes} bytes"
            )));
        }
        if copied != entry.size() {
            return Err(PackError::Integrity(format!(
                "{name}: {copied} bytes unpacked, the zip says {}",
                entry.size()
            )));
        }
        dest.sync_all()?;
        Ok(copied)
    })();
    if let Err(e) = result {
        let _ = install::remove_file_blocking(out);
        return Err(e);
    }
    Ok(name)
}

/// `packs/.staging/{packId}/` paths a QuranEnc install leaves (for diagnostics and tests).
#[must_use]
pub fn staging_files(staging: &Path, key: &str) -> Vec<PathBuf> {
    let zip = staging.join(format!("{key}.zip"));
    vec![
        install::dl_part_path(&zip),
        install::dl_sidecar_path(&zip),
        staging.join(format!("{key}.zip.json")),
        staging.join(format!("{key}.sqlite")),
        zip,
        staging.join(PACK_DB_FILE),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_versions() {
        // 0x67e2bd39 = 2025-03-25T14:27:05Z.
        let e = "\"67e2bd39-c64f2\"";
        assert_eq!(validators_version(Some(e), "2025.01", None), "2025.03");
        assert_eq!(
            validators_version(Some(&format!("W/{e}")), "x", None),
            "2025.03"
        );
        // Reinstalling the installed file keeps its version.
        assert_eq!(
            validators_version(Some(e), "x", Some(("2024.11", Some(e)))),
            "2024.11"
        );
        // An update within the month.
        assert_eq!(
            validators_version(Some(e), "x", Some(("2025.03", Some("\"67e00000-1\"")))),
            "2025.03.25"
        );
        assert_eq!(
            validators_version(Some(e), "x", Some(("2025.03.25", Some("\"67e2a000-1\"")))),
            "2025.03.25.1427"
        );
        assert_eq!(
            validators_version(Some(e), "x", Some(("2025.02", None))),
            "2025.03"
        );
        // Opaque ETags.
        assert_eq!(
            validators_version(
                Some("\"f32c4df2ac5f47885761cccf2efbc536\""),
                "2026.10",
                None
            ),
            "2026.10"
        );
        assert_eq!(validators_version(None, "2026.10", None), "2026.10");
        assert!(etag_time("\"zz-1\"").is_none());
        assert!(etag_time("\"\"").is_none());
    }

    #[test]
    fn languages_and_etags() {
        assert_eq!(pack_language("tr.en.saheeh"), Some("en"));
        assert_eq!(pack_language("tafsir.ar.muyassar"), Some("ar"));
        assert_eq!(pack_language("tr.EN.x"), None);
        assert_eq!(pack_language("decor"), None);
        assert!(same_etag("W/\"a-1\"", "\"a-1\""));
        assert!(!same_etag("\"a-1\"", "\"a-2\""));
    }

    #[test]
    fn source_version_round_trips() {
        let v = SourceVersion {
            key: "english_saheeh".into(),
            version: Some("1.1.2".into()),
            last_update: Some(1_750_772_247),
            etag: Some("\"67e2bd2a-7ead2\"".into()),
            last_modified: Some("Thu, 26 Mar 2000 17:35:45 GMT".into()),
            content_length: Some(518_866),
        };
        let json = v.to_json();
        assert!(json.contains("\"contentLength\":518866"), "{json}");
        assert!(json.contains("\"lastModified\""), "{json}");
        assert_eq!(SourceVersion::parse(&json), Some(v));
        assert_eq!(SourceVersion::parse("1.1.2"), None);
    }

    #[test]
    fn list_entries_parse_tolerantly() {
        let v: Value =
            serde_json::json!({"key": "k", "version": 2, "title": " T ", "last_update": "17"});
        assert_eq!(
            parse_list_entry(&v),
            Some(ListEntry {
                key: "k".into(),
                version: "2".into(),
                title: Some("T".into()),
                description: None,
                last_update: Some(17),
            })
        );
        assert_eq!(parse_list_entry(&serde_json::json!({"key": "k"})), None);
    }
}
