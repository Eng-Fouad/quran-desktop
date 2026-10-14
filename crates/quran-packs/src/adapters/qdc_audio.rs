//! `qdc_audio`: QDC recitation files and their timings.
//!
//! **Timings** come from `GET {QDC_API}/audio/reciters/{id}/audio_files?chapter={n}&segments=true`: the element of
//! `audio_files[]` for the surah is read with `timings::qdc_file_info` and sanitised with `sanitize_qdc`, then bound
//! to the exact file it describes: its `audio_url` and the **HTTP `Content-Length`** of a `HEAD` on that file (never
//! QDC's `file_size`). The payload sha256 drives revalidation.
//!
//! **Files.** The URL of a file is `audio_url`, then the same path on every catalog host (`download.quranicaudio.com`,
//! then `.org`). An explicit download (a job item) claims the single writer of `{sss}.mp3` (it waits for a live stream
//! of the same surah), downloads `{sss}.dl.part` → `{sss}.mp3` resumably with the timings' length, keeps a file a
//! stream already completed, and pins the surah's timings. Pinning any surah also pins surah 1
//! ([`super::Adapter::items`]), whose file plays every other surah's basmala.
//!
//! **Upstream changes** are applied by [`refresh_timings`] / [`revalidate_surah`]:
//! - same file, same payload → only `fetched_at` moves; same file, new payload → the timings are replaced;
//! - a new file (another `audio_url` or `Content-Length`):
//!   - unpinned: the cached mp3 and its stream-cache `pack_item` row are deleted, the new timings stored;
//!   - pinned: the old pair stays in use ([`TimingsChange::PinnedFileChanged`]); [`revalidate_surah`] downloads the new
//!     file to `{sss}.mp3.next` and swaps file and timings in one step, under the writer claim, once it is complete.
//!
//! Every request runs on the context's lane: a job's background lane, or the interactive lane without a job.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use quran_core::content_db::geometry;
use quran_core::timings::{is_word_level, qdc_file_info};
use quran_core::{
    ContentDb, CoreError, InstalledPackRow, PackItemRow, SanitizeReport, StoredTimings, TimingFile,
    UserDb, sanitize_qdc,
};
use serde_json::Value;
use url::Url;

use super::{AdapterCtx, ItemKey, ItemOutcome, QdcAudioConfig};
use crate::PackError;
use crate::http::{Expect, Request};
use crate::install;
use crate::revalidate::{CONCURRENCY, MAX_AGE, QDC_API, blocking, check_surah, is_fresh};

/// `timing_file.source` of QDC timings.
pub const SOURCE: &str = "qdc";
/// Suffix of a pinned file's replacement while it downloads and waits for the swap (`001.mp3.next`).
pub const NEXT_SUFFIX: &str = ".mp3.next";

/// `{QDC_API}/audio/reciters/{id}/audio_files?chapter={n}&segments=true`.
#[must_use]
pub fn timings_url(reciter_id: u32, surah: u32) -> String {
    format!(
        "{}/audio/reciters/{reciter_id}/audio_files?chapter={surah}&segments=true",
        QDC_API.get()
    )
}

/// `packs/audio/{reciter}/{sss}.mp3.next`.
#[must_use]
pub fn next_path(root: &Path, reciter_id: u32, surah: u32) -> PathBuf {
    install::audio_dir(root, reciter_id).join(format!("{surah:03}{NEXT_SUFFIX}"))
}

/// The mirrors of an audio file: `audio_url` itself, then the same URL on each catalog host (`host` or `host:port`),
/// when `audio_url` is served by one of them. A URL on a host outside the catalog list is used alone.
#[must_use]
pub fn audio_mirrors(audio_url: &str, hosts: &[String]) -> Vec<String> {
    let mut out = vec![audio_url.to_owned()];
    let Ok(url) = Url::parse(audio_url) else {
        return out;
    };
    let Some(own) = url.host_str().map(|h| match url.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_owned(),
    }) else {
        return out;
    };
    if !hosts.iter().any(|h| h.eq_ignore_ascii_case(&own)) {
        return out;
    }
    for host in hosts {
        let (name, port) = match host.rsplit_once(':') {
            Some((name, port)) if !name.is_empty() => match port.parse::<u16>() {
                Ok(p) => (name, Some(p)),
                Err(_) => (host.as_str(), None),
            },
            _ => (host.as_str(), None),
        };
        let mut alt = url.clone();
        if alt.set_host(Some(name)).is_err() || alt.set_port(port).is_err() {
            continue;
        }
        let alt = alt.to_string();
        if !out.contains(&alt) {
            out.push(alt);
        }
    }
    out
}

/// One surah as upstream serves it now: sanitised timings bound to the exact file (`audio_url` + HEAD
/// `Content-Length`), stamped with the current time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub timings: StoredTimings,
    /// `Last-Modified` of the audio file.
    pub last_modified: Option<String>,
    /// What `sanitize_qdc` repaired.
    pub report: SanitizeReport,
}

/// What a timings refresh changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimingsChange {
    /// No timings were stored before.
    New,
    /// Same payload and file: only `fetched_at` moved.
    Unchanged,
    /// Same file, new segments: the timings were replaced.
    Updated,
    /// The file changed and it was not pinned: the cached mp3 (`freed` bytes) and its stream-cache row were deleted
    /// and the new timings stored.
    FileReplaced { freed: u64 },
    /// The file changed but it is pinned: the old pair stays in use until [`revalidate_surah`] swaps in the new one.
    PinnedFileChanged,
    /// The new file of a pinned surah was downloaded and swapped in with its new timings.
    PinnedFileSwapped,
}

/// The timings in use after a refresh, and what changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingsRefresh {
    pub timings: StoredTimings,
    pub change: TimingsChange,
}

/// The timings of a surah for playback ([`ensure_timings`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsuredTimings {
    pub timings: StoredTimings,
    /// Older than the revalidation period and could not be refreshed: the stored copy is used.
    pub stale: bool,
    /// Set when this call refreshed the timings.
    pub change: Option<TimingsChange>,
}

/// A pinned file that no longer matches upstream ([`pinned_changes`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedChange {
    pub surah: u32,
    /// The pinned pair in use (`None`: a pinned file without stored timings).
    pub old_url: Option<String>,
    pub old_len: Option<u64>,
    pub new_url: String,
    pub new_len: Option<u64>,
    /// `Last-Modified` of the new file.
    pub last_modified: Option<String>,
}

/// What is stored locally for one surah.
#[derive(Debug, Clone)]
struct Local {
    timings: Option<StoredTimings>,
    timings_pinned: bool,
    item: Option<PackItemRow>,
    file_len: Option<u64>,
}

impl Local {
    /// The surah's file is an explicit download (its `pack_item` row or its timings are pinned).
    fn pinned(&self) -> bool {
        self.timings_pinned || self.item.as_ref().is_some_and(|i| i.pinned)
    }
}

/// `pack_item.item` of a surah (`002`).
fn item_key(surah: u32) -> String {
    ItemKey::Surah(surah).db_key()
}

/// Maps a `sanitize_qdc`/`qdc_file_info` rejection of upstream data to an integrity error of that upstream.
fn upstream_error(cfg: &QdcAudioConfig, surah: u32, e: CoreError) -> PackError {
    match e {
        CoreError::Corrupt(m) | CoreError::InvalidArgument(m) => PackError::Integrity(format!(
            "QDC timings of reciter {} surah {surah}: {m}",
            cfg.reciter_id
        )),
        other => PackError::Core(other),
    }
}

/// Fetches the surah's timings and HEADs its file, without storing anything.
pub async fn fetch_upstream(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<Upstream, PackError> {
    check_surah(surah)?;
    let ayah_count = geometry::surah_ayah_count(surah).ok_or_else(|| {
        upstream_error(
            cfg,
            surah,
            CoreError::InvalidArgument("no such surah".into()),
        )
    })?;
    let urls = [timings_url(cfg.reciter_id, surah)];
    let body = ctx.http.get(Request::for_ctx(ctx, &urls)).await?;
    let payload_sha256 = body.sha256_hex();
    let value: Value = body.json()?;
    let file = value
        .get("audio_files")
        .and_then(Value::as_array)
        .and_then(|files| {
            files
                .iter()
                .find(|f| qdc_file_info(f).is_ok_and(|i| i.chapter_id == surah))
        })
        .ok_or_else(|| {
            PackError::Integrity(format!(
                "{}: no audio file for reciter {} surah {surah}",
                body.url, cfg.reciter_id
            ))
        })?;
    let info = qdc_file_info(file).map_err(|e| upstream_error(cfg, surah, e))?;
    let (ayahs, report) =
        sanitize_qdc(file, ayah_count).map_err(|e| upstream_error(cfg, surah, e))?;
    let mirrors = audio_mirrors(&info.audio_url, &cfg.hosts);
    let head = ctx.http.head(Request::for_ctx(ctx, &mirrors), None).await?;
    if head.content_length.is_none() {
        log::warn!(
            "{}: no Content-Length; reciter {} surah {surah} is bound to its URL only",
            head.url,
            cfg.reciter_id
        );
    }
    Ok(Upstream {
        timings: StoredTimings {
            file: TimingFile {
                reciter_id: cfg.reciter_id,
                surah,
                audio_url: info.audio_url,
                content_length: head.content_length,
                duration_ms: info.duration_ms,
                source: SOURCE.to_owned(),
                fetched_at_ms: ctx.user.now_ms(),
                etag: head.validators.etag,
                payload_sha256,
            },
            word_level: is_word_level(&ayahs),
            ayahs,
        },
        last_modified: head.validators.last_modified,
        report,
    })
}

async fn load_local(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<Local, PackError> {
    let (content, user) = (ctx.content.clone(), ctx.user.clone());
    let (pack_id, reciter) = (ctx.pack_id.clone(), cfg.reciter_id);
    let path = install::audio_path(&ctx.packs_root, reciter, surah);
    blocking(move || {
        let timings = content.timings_get(reciter, surah)?;
        let timings_pinned = content
            .timing_stamps(Some(reciter))?
            .iter()
            .any(|s| s.surah == surah && s.pinned);
        let item = user.pack_item(&pack_id, &item_key(surah))?;
        let file_len = std::fs::metadata(&path)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map(|m| m.len());
        Ok(Local {
            timings,
            timings_pinned,
            item,
            file_len,
        })
    })
    .await
}

/// Both describe the same file: the same URL and, when both are known, the same length.
fn same_file(old: &TimingFile, new: &TimingFile) -> bool {
    old.audio_url == new.audio_url
        && match (old.content_length, new.content_length) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
}

/// Stores `up` against what is stored locally (module docs, "Upstream changes"); never downloads audio.
async fn apply_upstream(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
    local: Local,
    up: StoredTimings,
) -> Result<TimingsRefresh, PackError> {
    let (content, user, pack_id) = (ctx.content.clone(), ctx.user.clone(), ctx.pack_id.clone());
    let path = install::audio_path(&ctx.packs_root, cfg.reciter_id, surah);
    blocking(move || apply_blocking(&content, &user, &pack_id, &path, local, up)).await
}

fn apply_blocking(
    content: &ContentDb,
    user: &UserDb,
    pack_id: &str,
    path: &Path,
    local: Local,
    mut up: StoredTimings,
) -> Result<TimingsRefresh, PackError> {
    let pinned = local.pinned();
    let Some(old) = local.timings else {
        // First timings of this surah. A pinned file on disk keeps its pin when it is the file they describe; a pinned
        // file of another length is outdated and waits for the swap.
        let fits = up
            .file
            .content_length
            .is_none_or(|n| local.file_len == Some(n));
        let outdated = pinned && local.file_len.is_some() && !fits;
        content.timings_put(&up, pinned && local.file_len.is_some() && fits)?;
        let change = if outdated {
            TimingsChange::PinnedFileChanged
        } else {
            TimingsChange::New
        };
        return Ok(TimingsRefresh {
            timings: up,
            change,
        });
    };
    if same_file(&old.file, &up.file) {
        if up.file.content_length.is_none() {
            up.file.content_length = old.file.content_length;
        }
        let change = if old.file.payload_sha256 == up.file.payload_sha256 {
            TimingsChange::Unchanged
        } else {
            TimingsChange::Updated
        };
        // `pinned` only goes up in `timings_put`: an existing pin is kept.
        content.timings_put(&up, false)?;
        return Ok(TimingsRefresh {
            timings: up,
            change,
        });
    }
    if pinned {
        log::info!(
            "QDC reciter {} surah {}: the pinned file changed upstream ({} → {}); keeping the old pair until the new \
             file is complete",
            old.file.reciter_id,
            old.file.surah,
            old.file
                .content_length
                .map_or_else(|| "?".to_owned(), |n| n.to_string()),
            up.file
                .content_length
                .map_or_else(|| "?".to_owned(), |n| n.to_string()),
        );
        return Ok(TimingsRefresh {
            timings: old,
            change: TimingsChange::PinnedFileChanged,
        });
    }
    let freed = drop_cached_file(user, pack_id, path, local.item.as_ref())?;
    content.timings_put(&up, false)?;
    Ok(TimingsRefresh {
        timings: up,
        change: TimingsChange::FileReplaced { freed },
    })
}

/// Deletes an unpinned cached mp3 and its stream-cache row; returns the bytes freed.
fn drop_cached_file(
    user: &UserDb,
    pack_id: &str,
    path: &Path,
    item: Option<&PackItemRow>,
) -> Result<u64, PackError> {
    let freed = install::remove_file_blocking(path)?;
    if let Some(item) = item.filter(|i| !i.pinned) {
        user.pack_item_delete(pack_id, &item.item)?;
    }
    Ok(freed)
}

/// Refetches the surah's timings and applies the upstream-change policy, without downloading audio (the interactive
/// lane uses it before playback; a changed pinned file keeps its old pair).
pub async fn refresh_timings(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<TimingsRefresh, PackError> {
    check_surah(surah)?;
    let local = load_local(ctx, cfg, surah).await?;
    let up = fetch_upstream(ctx, cfg, surah).await?;
    apply_upstream(ctx, cfg, surah, local, up.timings).await
}

/// Fetches, sanitises and stores the surah's timings ([`refresh_timings`]); returns the timings in use.
pub async fn fetch_timings(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<StoredTimings, PackError> {
    Ok(refresh_timings(ctx, cfg, surah).await?.timings)
}

/// The surah's timings for playback: the stored ones while fresh (`max_age`), else refreshed; when the refresh fails
/// (offline, network off, upstream down) the stored copy is used and marked stale. Missing timings that cannot be
/// fetched are an error (`Offline` when the network is unavailable).
pub async fn ensure_timings(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
    max_age: Duration,
) -> Result<EnsuredTimings, PackError> {
    check_surah(surah)?;
    let (content, reciter) = (ctx.content.clone(), cfg.reciter_id);
    let stored = blocking(move || Ok(content.timings_get(reciter, surah)?)).await?;
    let now = ctx.user.now_ms();
    if let Some(t) = &stored
        && is_fresh(t.file.fetched_at_ms, now, max_age)
    {
        return Ok(EnsuredTimings {
            timings: t.clone(),
            stale: false,
            change: None,
        });
    }
    match refresh_timings(ctx, cfg, surah).await {
        Ok(r) => Ok(EnsuredTimings {
            timings: r.timings,
            stale: false,
            change: Some(r.change),
        }),
        Err(e) => match stored {
            Some(timings) if !matches!(e, PackError::Cancelled) => {
                log::info!(
                    "QDC reciter {reciter} surah {surah}: using stored timings, refresh failed: {e}"
                );
                Ok(EnsuredTimings {
                    timings,
                    stale: true,
                    change: None,
                })
            }
            _ => Err(e),
        },
    }
}

/// Revalidates one surah: [`refresh_timings`], and when a pinned file changed upstream, downloads the new file beside
/// it and swaps file and timings ([`TimingsChange::PinnedFileSwapped`]). A failed swap leaves the old pair in use and
/// stale, so the next pass retries it.
pub async fn revalidate_surah(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<TimingsRefresh, PackError> {
    check_surah(surah)?;
    let local = load_local(ctx, cfg, surah).await?;
    let up = fetch_upstream(ctx, cfg, surah).await?;
    let refreshed = apply_upstream(ctx, cfg, surah, local, up.timings.clone()).await?;
    if refreshed.change != TimingsChange::PinnedFileChanged {
        return Ok(refreshed);
    }
    swap_pinned(ctx, cfg, surah, up.timings).await
}

/// Downloads the new file of a pinned surah to `{sss}.mp3.next` (resumable; a completed one from an interrupted
/// run is reused), then, under the writer claim, renames it over `{sss}.mp3` and stores the new timings pinned. When
/// the surah stopped being pinned meanwhile, the change is applied like an unpinned one.
async fn swap_pinned(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
    mut up: StoredTimings,
) -> Result<TimingsRefresh, PackError> {
    let reciter = cfg.reciter_id;
    let dest = install::audio_path(&ctx.packs_root, reciter, surah);
    let next = next_path(&ctx.packs_root, reciter, surah);
    let urls = audio_mirrors(&up.file.audio_url, &cfg.hosts);
    let mut expect = Expect::default().keep_existing();
    if let Some(len) = up.file.content_length {
        expect = expect.len(len);
    }
    let done = ctx
        .http
        .download(Request::for_ctx(ctx, &urls), &next, &expect)
        .await?;
    up.file.content_length = Some(done.bytes);
    let _claim = ctx
        .writers
        .claim_job(reciter, surah, ctx.job.as_ref())
        .await?;
    let local = load_local(ctx, cfg, surah).await?;
    let (content, user, pack_id) = (ctx.content.clone(), ctx.user.clone(), ctx.pack_id.clone());
    blocking(move || {
        if !local.pinned() {
            install::remove_file_blocking(&next)?;
            let freed = drop_cached_file(&user, &pack_id, &dest, local.item.as_ref())?;
            content.timings_put(&up, false)?;
            return Ok(TimingsRefresh {
                timings: up,
                change: TimingsChange::FileReplaced { freed },
            });
        }
        install::commit_blocking(&next, &dest)?;
        content.timings_put(&up, true)?;
        let now = user.now_ms();
        user.pack_item_upsert(&PackItemRow {
            pack_id: pack_id.clone(),
            item: item_key(surah),
            bytes: done.bytes,
            sha256: done.sha256,
            pinned: true,
            fetched_at: now,
            last_used_at: local.item.as_ref().map_or(now, |i| i.last_used_at),
        })?;
        refresh_installed_bytes(&user, &pack_id)?;
        log::info!(
            "QDC reciter {reciter} surah {surah}: swapped in the new pinned file ({} bytes)",
            done.bytes
        );
        Ok(TimingsRefresh {
            timings: up,
            change: TimingsChange::PinnedFileSwapped,
        })
    })
    .await
}

/// `installed_pack.bytes` = the pinned items' bytes after a file of the pack changed size.
fn refresh_installed_bytes(user: &UserDb, pack_id: &str) -> Result<(), PackError> {
    let Some(row) = user.pack_installed(pack_id)? else {
        return Ok(());
    };
    let bytes = user
        .pack_items(pack_id)?
        .iter()
        .filter(|i| i.pinned)
        .map(|i| i.bytes)
        .fold(0u64, u64::saturating_add);
    if bytes != row.bytes {
        user.pack_upsert(&InstalledPackRow { bytes, ..row })?;
    }
    Ok(())
}

/// Downloads (or pins an already complete) surah file and pins its timings: the job item of an explicit download.
///
/// The timings are refreshed first so the file pinned is the one upstream serves now (a stored pair is used when the
/// API cannot be reached); the writer claim waits for a live stream of the surah; a file a stream already completed
/// with the right length is kept (`Present`).
pub async fn fetch_surah(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<ItemOutcome, PackError> {
    check_surah(surah)?;
    let local = load_local(ctx, cfg, surah).await?;
    let timings = match fetch_upstream(ctx, cfg, surah).await {
        Ok(up) => {
            let refreshed = apply_upstream(ctx, cfg, surah, local, up.timings.clone()).await?;
            if refreshed.change == TimingsChange::PinnedFileChanged {
                // This download brings the new pair in: the rename below is the swap.
                up.timings
            } else {
                refreshed.timings
            }
        }
        Err(e @ (PackError::Cancelled | PackError::Offline)) => return Err(e),
        Err(e) => match local.timings {
            Some(stored) => {
                log::warn!(
                    "{}: surah {surah}: timings refresh failed ({e}); downloading the stored pair",
                    ctx.pack_id
                );
                stored
            }
            None => return Err(e),
        },
    };
    let dest = install::audio_path(&ctx.packs_root, cfg.reciter_id, surah);
    let urls = audio_mirrors(&timings.file.audio_url, &cfg.hosts);
    let _claim = ctx
        .writers
        .claim_job(cfg.reciter_id, surah, ctx.job.as_ref())
        .await?;
    let mut expect = Expect::default().keep_existing();
    if let Some(len) = timings.file.content_length {
        expect = expect.len(len);
    }
    let done = ctx
        .http
        .download(Request::for_ctx(ctx, &urls), &dest, &expect)
        .await?;
    let mut timings = timings;
    timings.file.content_length = Some(done.bytes);
    let (content, pin) = (ctx.content.clone(), ctx.pin);
    blocking(move || Ok(content.timings_put(&timings, pin)?)).await?;
    Ok(if done.kept_existing {
        ItemOutcome::Present { bytes: done.bytes }
    } else {
        ItemOutcome::Stored {
            bytes: done.bytes,
            sha256: done.sha256,
        }
    })
}

/// The pinned files of the context's recitation pack that no longer match upstream. Surahs whose timings were
/// verified within [`MAX_AGE`] are trusted without a request; the others are refetched (`GET` + `HEAD`, a few at a
/// time) and an unchanged pair is re-stamped on the way (plain revalidation). Changed pairs are only reported: the
/// revalidator swaps them.
pub async fn pinned_changes(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
) -> Result<Vec<PinnedChange>, PackError> {
    let (content, user) = (ctx.content.clone(), ctx.user.clone());
    let (pack_id, reciter) = (ctx.pack_id.clone(), cfg.reciter_id);
    let surahs = blocking(move || {
        let mut surahs: Vec<u32> = user
            .pack_items(&pack_id)?
            .iter()
            .filter(|i| i.pinned)
            .filter_map(|i| match ItemKey::parse_db_key(&i.item) {
                Some(ItemKey::Surah(n)) => Some(n),
                _ => None,
            })
            .collect();
        surahs.extend(
            content
                .timing_stamps(Some(reciter))?
                .iter()
                .filter(|s| s.pinned)
                .map(|s| s.surah),
        );
        surahs.sort_unstable();
        surahs.dedup();
        Ok(surahs)
    })
    .await?;
    let checks: Vec<Result<Option<PinnedChange>, PackError>> = futures_util::stream::iter(surahs)
        .map(|surah| pinned_change(ctx, cfg, surah))
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    let mut changes = Vec::new();
    for check in checks {
        match check {
            Ok(Some(change)) => changes.push(change),
            Ok(None) => {}
            Err(e @ (PackError::Offline | PackError::Cancelled)) => return Err(e),
            Err(e) => log::warn!("{}: pinned-file check failed: {e}", ctx.pack_id),
        }
    }
    changes.sort_by_key(|c| c.surah);
    Ok(changes)
}

async fn pinned_change(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    surah: u32,
) -> Result<Option<PinnedChange>, PackError> {
    let local = load_local(ctx, cfg, surah).await?;
    if !local.pinned() {
        return Ok(None);
    }
    let now = ctx.user.now_ms();
    let swap_waiting = install::file_len(&next_path(&ctx.packs_root, cfg.reciter_id, surah))
        .await
        .is_some();
    let verified = local
        .timings
        .as_ref()
        .is_some_and(|t| is_fresh(t.file.fetched_at_ms, now, MAX_AGE));
    if verified && !swap_waiting {
        return Ok(None);
    }
    let up = fetch_upstream(ctx, cfg, surah).await?;
    let changed = local
        .timings
        .as_ref()
        .is_none_or(|old| !same_file(&old.file, &up.timings.file));
    if !changed {
        apply_upstream(ctx, cfg, surah, local, up.timings).await?;
        return Ok(None);
    }
    Ok(Some(PinnedChange {
        surah,
        old_url: local.timings.as_ref().map(|t| t.file.audio_url.clone()),
        old_len: local.timings.as_ref().and_then(|t| t.file.content_length),
        new_url: up.timings.file.audio_url,
        new_len: up.timings.file.content_length,
        last_modified: up.last_modified,
    }))
}

/// A version label for changed recitation files: the newest upstream `Last-Modified` as `YYYY.MM.DD` (the catalog
/// versions are `YYYY.MM`), else the date of `now_ms`.
#[must_use]
pub fn changes_label(changes: &[PinnedChange], now_ms: i64) -> String {
    let format = time::macros::format_description!(
        "[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT"
    );
    let newest = changes
        .iter()
        .filter_map(|c| c.last_modified.as_deref())
        .filter_map(|v| time::PrimitiveDateTime::parse(v.trim(), format).ok())
        .map(time::PrimitiveDateTime::assume_utc)
        .max();
    let date = newest.unwrap_or_else(|| {
        time::OffsetDateTime::from_unix_timestamp(now_ms.div_euclid(1000))
            .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
    });
    format!(
        "{:04}.{:02}.{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// `Some(label)` when a pinned file of the installed recitation pack no longer matches upstream (a new `audio_url` or
/// `Content-Length`) — see [`pinned_changes`] and [`changes_label`]. The revalidator brings such files up to date by
/// itself; this makes the change visible to "Check for updates".
pub async fn check_update(
    ctx: &AdapterCtx,
    cfg: &QdcAudioConfig,
    installed: &InstalledPackRow,
) -> Result<Option<String>, PackError> {
    let changes = pinned_changes(ctx, cfg).await?;
    if changes.is_empty() {
        return Ok(None);
    }
    log::info!(
        "{} {}: {} pinned file(s) changed upstream",
        installed.pack_id,
        installed.version,
        changes.len()
    );
    Ok(Some(changes_label(&changes, ctx.user.now_ms())))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn hosts() -> Vec<String> {
        vec![
            "download.quranicaudio.com".into(),
            "download.quranicaudio.org".into(),
        ]
    }

    #[test]
    fn mirrors_follow_the_catalog_hosts() {
        let url = "https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/1.mp3";
        assert_eq!(
            audio_mirrors(url, &hosts()),
            [
                url,
                "https://download.quranicaudio.org/qdc/mishari_al_afasy/murattal/1.mp3"
            ]
        );
        // The .org URL first when QDC names it; the empty segment of Dussary's paths survives.
        let org = "https://download.quranicaudio.org/quran/yasser_ad-dussary//001.mp3";
        assert_eq!(
            audio_mirrors(org, &hosts()),
            [
                org,
                "https://download.quranicaudio.com/quran/yasser_ad-dussary//001.mp3"
            ]
        );
        // A host outside the catalog is used alone; garbage is passed through for the HTTP layer to reject.
        let other = "https://cdn.example.org/1.mp3";
        assert_eq!(audio_mirrors(other, &hosts()), [other]);
        assert_eq!(audio_mirrors("not a url", &hosts()), ["not a url"]);
        // host:port entries (local mirrors, tests).
        let local = vec!["127.0.0.1:8080".to_owned(), "localhost:8080".to_owned()];
        assert_eq!(
            audio_mirrors("http://127.0.0.1:8080/a/1.mp3", &local),
            [
                "http://127.0.0.1:8080/a/1.mp3",
                "http://localhost:8080/a/1.mp3"
            ]
        );
    }

    #[test]
    fn urls_and_paths() {
        assert_eq!(
            timings_url(7, 2),
            "https://api.qurancdn.com/api/qdc/audio/reciters/7/audio_files?chapter=2&segments=true"
        );
        let root = Path::new("/data/packs");
        assert_eq!(
            next_path(root, 7, 2),
            root.join("audio").join("7").join("002.mp3.next")
        );
        // The swap's resumable temp never collides with a job's `002.dl.part`.
        assert_eq!(
            install::dl_part_path(&next_path(root, 7, 2)),
            root.join("audio").join("7").join("002.mp3.dl.part")
        );
    }

    fn file(url: &str, len: Option<u64>) -> TimingFile {
        TimingFile {
            reciter_id: 7,
            surah: 1,
            audio_url: url.into(),
            content_length: len,
            duration_ms: None,
            source: SOURCE.into(),
            fetched_at_ms: 0,
            etag: None,
            payload_sha256: String::new(),
        }
    }

    #[test]
    fn file_identity_is_url_plus_length() {
        assert!(same_file(&file("a", Some(1)), &file("a", Some(1))));
        assert!(!same_file(&file("a", Some(1)), &file("a", Some(2))));
        assert!(!same_file(&file("a", Some(1)), &file("b", Some(1))));
        assert!(
            same_file(&file("a", None), &file("a", Some(2))),
            "an unknown length cannot differ"
        );
    }

    #[test]
    fn labels_use_the_newest_last_modified() {
        let change = |lm: Option<&str>| PinnedChange {
            surah: 1,
            old_url: None,
            old_len: None,
            new_url: String::new(),
            new_len: None,
            last_modified: lm.map(str::to_owned),
        };
        let changes = [
            change(Some("Tue, 03 Mar 2026 10:00:00 GMT")),
            change(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            change(Some("not a date")),
            change(None),
        ];
        assert_eq!(changes_label(&changes, 0), "2026.10.21");
        // 2026-10-10T00:00:00Z.
        assert_eq!(
            changes_label(&[change(None)], 1_791_590_400_000),
            "2026.10.10"
        );
    }
}
