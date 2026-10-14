//! The shared HTTP layer.
//!
//! - **Clients.** One API client (gzip, for JSON) and one file client (no decompression, `Accept-Encoding: identity`,
//!   so `Content-Length` is the file's length; also handed to the audio streaming source through
//!   [`Http::client`]). Both: User-Agent `QuranForDesktop/<version>`, system proxy, connect timeout 10 s, idle read
//!   timeout 30 s.
//! - **Network gate.** While `settings.network_allowed == false` every operation fails with `PackError::Offline`
//!   before any IO (`quran://` is unaffected).
//! - **Lanes and limits.** A global semaphore of 6 and 4 per host (`host:port`). [`Lane::Background`] work (jobs, the
//!   revalidator) may hold at most 4 global and 3 per-host slots, so [`Lane::Interactive`] work (visible page fonts,
//!   tafsir, WBW, timings) always finds capacity: it skips the queue and shares the host limits.
//! - **Retries and mirrors.** Each request walks its mirror list in rounds: a round tries every live URL once in
//!   order; a 404/410 (or another 4xx, or a payload that fails integrity) retires that URL; a connect error, a 5xx, a
//!   408/425/429, a timeout or a broken body moves on to the next URL at once and retries the URL next round. Up to
//!   3 retry rounds after the first, with backoff 0.5 s, 2 s, 8 s (`Retry-After` on 429/503 is honoured up to 60 s;
//!   a longer one retires the URL). When a round fails only on connect errors and the tracker says offline, the
//!   request ends with `PackError::Offline` instead of waiting. A resumable download that made progress starts a
//!   fresh retry budget.
//! - **Interactive budget.** Someone waits for an interactive request (a tafsir or word-by-word chapter, a recitation's
//!   timings, a visible page font), so it has a deadline: each attempt must start answering (status and headers) within
//!   [`INTERACTIVE_RESPONSE_TIMEOUT`], and no attempt or retry wait begins, and no response is awaited, past
//!   [`INTERACTIVE_DEADLINE`] after the request began ([`PackError::Timeout`] then, `network` over IPC). On a link that
//!   accepts connections and never answers, that is ≤ 15 s instead of four 30 s idle timeouts plus the backoff
//!   (≈ 130 s). Fast failures (refused connections, 5xx) keep the full ladder within the deadline, and a body that is
//!   arriving is never cut. Background work (jobs, the revalidator, font prefetch) keeps the plain idle timeout.
//! - **Small files** ([`Http::fetch_file`]): `{dest}.part` → integrity → fsync → rename into place.
//! - **Large files** ([`Http::download`]): `{name}.dl.part` + `{name}.dl.part.json` sidecar `{url, etag,
//!   lastModified, total, received}`. `received` is advanced only after the bytes are written and fsynced (every
//!   [`SIDECAR_EVERY`] bytes and when a stream ends). Resume truncates the temp to `received` (never trusting the file
//!   length), re-hashes that prefix and sends `Range: bytes={received}-` with `If-Range: <strong ETag | Last-Modified>`;
//!   `206` appends, `200` restarts from zero.
//! - **Integrity.** sha256 is computed while streaming; when expected it must match, otherwise it is reported (trust
//!   on first use). Before a file is renamed into place its length must equal `Content-Length` (and the sidecar's
//!   `total`, and the expected length); an optional magic prefix (`wOF2`) is checked as soon as the first bytes
//!   arrive. A failing file is never moved into place, and its temp is deleted.
//! - **Online tracking.** Any HTTP response → online; [`OFFLINE_AFTER_CONNECT_FAILURES`] consecutive connect failures →
//!   offline; while offline (and allowed) a background task re-probes every 60 s with `HEAD
//!   https://verses.quran.foundation/`, and at once when the network becomes allowed again. Every change of
//!   [`Http::online`] calls the listener (`PackEvents::network`).
//! - **In-flight dedupe** for the interactive lane: [`InFlight`] (a shared-future map keyed by item).
//!
//! Cancellation: with a [`JobHandle`], every wait (permits, backoff, response, each body chunk) ends with
//! `PackError::Cancelled` as soon as the job is paused or cancelled; resumable temps are kept (pause), and the job
//! runner deletes them on cancel.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::{Mutex, RwLock};
use reqwest::header::{self, HeaderMap, HeaderValue};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use url::Url;

use crate::PackError;
use crate::adapters::AdapterCtx;
use crate::install;
use crate::jobs::JobHandle;

/// Requests in flight across the app.
pub const GLOBAL_LIMIT: usize = 6;
/// Requests in flight per `host:port`.
pub const PER_HOST_LIMIT: usize = 4;
/// Of [`GLOBAL_LIMIT`], what background work may hold.
pub const BACKGROUND_GLOBAL_LIMIT: usize = 4;
/// Of [`PER_HOST_LIMIT`], what background work may hold.
pub const BACKGROUND_PER_HOST_LIMIT: usize = 3;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Idle read timeout (resets with every byte received).
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Delays before retry rounds 1, 2 and 3.
pub const BACKOFF: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_secs(2),
    Duration::from_secs(8),
];
/// Longest `Retry-After` honoured; a longer one retires the URL for this request.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);
/// An interactive attempt must start answering (status and headers) within this.
pub const INTERACTIVE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
/// An interactive request starts no attempt or retry wait, and awaits no response, past this after it began.
pub const INTERACTIVE_DEADLINE: Duration = Duration::from_secs(15);
/// Consecutive connect failures that mark the network offline.
pub const OFFLINE_AFTER_CONNECT_FAILURES: u32 = 3;
/// Re-probe period while offline.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(60);
/// `HEAD` target of the reachability probe.
pub const PROBE_URL: &str = "https://verses.quran.foundation/";
/// Disk writes and cancel/pause checks happen per 64 KiB chunk.
pub const CHUNK_BYTES: usize = 64 * 1024;
/// The sidecar's `received` advances (after an fsync) every this many bytes, and when a response ends.
pub const SIDECAR_EVERY: u64 = 1024 * 1024;
/// Cap on an in-memory response body ([`Http::get`]).
pub const MAX_BODY_BYTES: u64 = 64 * 1024 * 1024;
/// The first bytes of every woff2 file.
pub const WOFF2_MAGIC: &[u8] = b"wOF2";

/// Which capacity a request draws on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    /// Something the user is waiting for: never starved by background work.
    Interactive,
    /// Jobs and the revalidator.
    Background,
}

/// Tunables of the HTTP layer; [`HttpConfig::new`] gives the default values (tests shorten the waits).
#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub user_agent: String,
    pub network_allowed: bool,
    pub global_limit: usize,
    pub per_host_limit: usize,
    pub background_global_limit: usize,
    pub background_per_host_limit: usize,
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    /// Delays before each retry round; its length is the number of retry rounds.
    pub backoff: Vec<Duration>,
    pub max_retry_after: Duration,
    /// [`INTERACTIVE_RESPONSE_TIMEOUT`] (module docs, "Interactive budget").
    pub interactive_response_timeout: Duration,
    /// [`INTERACTIVE_DEADLINE`].
    pub interactive_deadline: Duration,
    pub offline_after_connect_failures: u32,
    pub probe_url: String,
    pub probe_interval: Duration,
    pub max_body_bytes: u64,
}

impl HttpConfig {
    /// The defaults, network allowed.
    #[must_use]
    pub fn new(user_agent: impl Into<String>) -> Self {
        Self {
            user_agent: user_agent.into(),
            network_allowed: true,
            global_limit: GLOBAL_LIMIT,
            per_host_limit: PER_HOST_LIMIT,
            background_global_limit: BACKGROUND_GLOBAL_LIMIT,
            background_per_host_limit: BACKGROUND_PER_HOST_LIMIT,
            connect_timeout: CONNECT_TIMEOUT,
            read_timeout: READ_TIMEOUT,
            backoff: BACKOFF.to_vec(),
            max_retry_after: MAX_RETRY_AFTER,
            interactive_response_timeout: INTERACTIVE_RESPONSE_TIMEOUT,
            interactive_deadline: INTERACTIVE_DEADLINE,
            offline_after_connect_failures: OFFLINE_AFTER_CONNECT_FAILURES,
            probe_url: PROBE_URL.to_owned(),
            probe_interval: PROBE_INTERVAL,
            max_body_bytes: MAX_BODY_BYTES,
        }
    }

    #[must_use]
    pub const fn network_allowed(mut self, allowed: bool) -> Self {
        self.network_allowed = allowed;
        self
    }
}

/// One request: its mirrors (tried in order), lane and owning job.
#[derive(Clone, Copy)]
pub struct Request<'a> {
    urls: &'a [String],
    lane: Lane,
    job: Option<&'a JobHandle>,
    /// Interactive requests only: set when the request starts ([`HttpConfig::interactive_deadline`]).
    deadline: Option<Instant>,
}

impl<'a> Request<'a> {
    /// An interactive request without a job.
    #[must_use]
    pub const fn new(urls: &'a [String]) -> Self {
        Self {
            urls,
            lane: Lane::Interactive,
            job: None,
            deadline: None,
        }
    }

    /// The request of an adapter call: on the job's background lane when `ctx.job` is set, else interactive.
    #[must_use]
    pub fn for_ctx(ctx: &'a AdapterCtx, urls: &'a [String]) -> Self {
        Self::new(urls).job(ctx.job.as_ref())
    }

    #[must_use]
    pub const fn lane(mut self, lane: Lane) -> Self {
        self.lane = lane;
        self
    }

    /// Attaches a job (progress, cancel/pause); a job always runs on the background lane.
    #[must_use]
    pub const fn job(mut self, job: Option<&'a JobHandle>) -> Self {
        if job.is_some() {
            self.lane = Lane::Background;
        }
        self.job = job;
        self
    }

    #[must_use]
    pub const fn urls(&self) -> &'a [String] {
        self.urls
    }

    /// The request as it starts: an interactive one gets its deadline (module docs, "Interactive budget").
    fn started(mut self, cfg: &HttpConfig) -> Self {
        if self.lane == Lane::Interactive && self.deadline.is_none() {
            self.deadline = Some(Instant::now() + cfg.interactive_deadline);
        }
        self
    }

    /// How long this attempt may wait for its response: `None` (the client's idle read timeout) on the background
    /// lane; else the interactive response timeout, never past the deadline.
    fn response_timeout(&self, cfg: &HttpConfig) -> Option<Duration> {
        let deadline = self.deadline?;
        let left = deadline.saturating_duration_since(Instant::now());
        Some(
            cfg.interactive_response_timeout
                .min(left)
                .max(Duration::from_millis(1)),
        )
    }
}

/// HTTP cache validators of a response.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

impl Validators {
    fn from_headers(h: &HeaderMap) -> Self {
        let text = |name| {
            h.get(name)
                .and_then(|v: &HeaderValue| v.to_str().ok())
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        };
        Self {
            etag: text(header::ETAG),
            last_modified: text(header::LAST_MODIFIED),
        }
    }

    /// The `If-Range` value: a strong ETag, else `Last-Modified` (weak ETags never match `If-Range`).
    #[must_use]
    pub fn if_range(&self) -> Option<&str> {
        self.etag
            .as_deref()
            .filter(|e| !e.starts_with("W/"))
            .or(self.last_modified.as_deref())
    }
}

/// An in-memory response body ([`Http::get`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Body {
    pub bytes: Vec<u8>,
    /// The mirror that answered.
    pub url: String,
    pub validators: Validators,
    /// As sent (before any decompression); `None` when absent or when the body was decompressed.
    pub content_length: Option<u64>,
}

impl Body {
    /// Lowercase hex sha256 of the body (revalidation compares payload hashes).
    #[must_use]
    pub fn sha256_hex(&self) -> String {
        hex::encode(Sha256::digest(&self.bytes))
    }

    /// Parses the body as JSON; a malformed payload is an integrity failure of that upstream.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, PackError> {
        serde_json::from_slice(&self.bytes)
            .map_err(|e| PackError::Integrity(format!("unexpected JSON from {}: {e}", self.url)))
    }
}

/// A `HEAD` answer ([`Http::head`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub url: String,
    pub status: u16,
    /// `304` to a conditional request.
    pub not_modified: bool,
    pub validators: Validators,
    pub content_length: Option<u64>,
}

/// What a downloaded file must satisfy before it is moved into place.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Expect {
    /// Exact length (catalog bytes, QDC timings' `content_length`).
    pub len: Option<u64>,
    /// Lowercase or uppercase hex sha256 (catalog pin).
    pub sha256: Option<String>,
    /// Required prefix, e.g. [`WOFF2_MAGIC`].
    pub magic: Option<&'static [u8]>,
    /// Refuse anything longer (guards against a wrong URL serving something huge).
    pub max_len: Option<u64>,
    /// [`Http::download`] only: a complete file already at `dest` wins ("first complete wins" between a stream and a
    /// job, and a resume after the download finished but the job did not). Before any request, a `dest` of exactly
    /// [`Self::len`] bytes (and [`Self::sha256`] / [`Self::magic`], when given) is accepted as is; after a download, a
    /// `dest` that appeared meanwhile with the downloaded length and hash is kept and the temp deleted.
    pub keep_existing: bool,
}

impl Expect {
    #[must_use]
    pub const fn len(mut self, len: u64) -> Self {
        self.len = Some(len);
        self
    }

    #[must_use]
    pub fn sha256(mut self, sha256: impl Into<String>) -> Self {
        self.sha256 = Some(sha256.into());
        self
    }

    #[must_use]
    pub const fn magic(mut self, magic: &'static [u8]) -> Self {
        self.magic = Some(magic);
        self
    }

    #[must_use]
    pub const fn max_len(mut self, max_len: u64) -> Self {
        self.max_len = Some(max_len);
        self
    }

    #[must_use]
    pub const fn keep_existing(mut self) -> Self {
        self.keep_existing = true;
        self
    }
}

/// A file that was verified and moved into place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Downloaded {
    /// `dest`.
    pub path: PathBuf,
    pub bytes: u64,
    /// Lowercase hex sha256 of the bytes.
    pub sha256: String,
    /// The mirror that served the last bytes (empty when an existing file was accepted without a request).
    pub url: String,
    pub validators: Validators,
    /// Bytes reused from an earlier, interrupted download (0 = fresh).
    pub resumed_from: u64,
    /// `dest` already held a complete file of this length and was kept ([`Expect::keep_existing`]).
    pub kept_existing: bool,
}

/// The `.dl.part.json` sidecar.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    pub url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub total: Option<u64>,
    /// Bytes known to be written **and fsynced**; resume truncates the temp to this.
    pub received: u64,
}

impl Sidecar {
    fn validators(&self) -> Validators {
        Validators {
            etag: self.etag.clone(),
            last_modified: self.last_modified.clone(),
        }
    }
}

/// Reads a sidecar; `None` when it is missing or unreadable.
pub async fn read_sidecar(path: &Path) -> Option<Sidecar> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Cheap-to-clone handle on the HTTP layer. `Send + Sync`.
#[derive(Clone)]
pub struct Http {
    inner: Arc<HttpShared>,
}

type Listener = Arc<dyn Fn(bool) + Send + Sync>;

struct HttpShared {
    cfg: HttpConfig,
    api: reqwest::Client,
    files: reqwest::Client,
    global: Arc<Semaphore>,
    global_bg: Arc<Semaphore>,
    hosts: Mutex<HashMap<String, HostSlots>>,
    allowed: AtomicBool,
    reachable: AtomicBool,
    connect_failures: AtomicU32,
    /// The last value reported to the listener (serialises reports).
    reported: Mutex<bool>,
    listener: RwLock<Option<Listener>>,
    probing: AtomicBool,
    probe_now: AtomicBool,
    probe_wake: Arc<Notify>,
}

#[derive(Clone)]
struct HostSlots {
    all: Arc<Semaphore>,
    background: Arc<Semaphore>,
}

impl Http {
    /// Builds both clients. No IO.
    pub fn new(cfg: HttpConfig) -> Result<Self, PackError> {
        let builder = || {
            reqwest::Client::builder()
                .user_agent(cfg.user_agent.as_str())
                .connect_timeout(cfg.connect_timeout)
                .read_timeout(cfg.read_timeout)
        };
        let api = builder().build()?;
        let files = builder().no_gzip().build()?;
        let allowed = cfg.network_allowed;
        Ok(Self {
            inner: Arc::new(HttpShared {
                global: Arc::new(Semaphore::new(cfg.global_limit.max(1))),
                global_bg: Arc::new(Semaphore::new(
                    cfg.background_global_limit
                        .clamp(1, cfg.global_limit.max(1)),
                )),
                hosts: Mutex::new(HashMap::new()),
                allowed: AtomicBool::new(allowed),
                reachable: AtomicBool::new(true),
                connect_failures: AtomicU32::new(0),
                reported: Mutex::new(allowed),
                listener: RwLock::new(None),
                probing: AtomicBool::new(false),
                probe_now: AtomicBool::new(false),
                probe_wake: Arc::new(Notify::new()),
                api,
                files,
                cfg,
            }),
        })
    }

    /// The file client (no decompression), shared with the audio streaming source (`PackManager::http_client`).
    #[must_use]
    pub fn client(&self) -> reqwest::Client {
        self.inner.files.clone()
    }

    #[must_use]
    pub fn config(&self) -> &HttpConfig {
        &self.inner.cfg
    }

    // -----------------------------------------------------------------------------------------------------------
    // Network state
    // -----------------------------------------------------------------------------------------------------------

    /// `settings.network_allowed`. Turning it on re-probes at once when the network was last seen offline.
    pub fn set_network_allowed(&self, allowed: bool) {
        let s = &self.inner;
        let was = s.allowed.swap(allowed, Ordering::SeqCst);
        if allowed && !was {
            s.connect_failures.store(0, Ordering::SeqCst);
            s.probe_now.store(true, Ordering::SeqCst);
        }
        s.report();
        s.probe_wake.notify_waiters();
    }

    #[must_use]
    pub fn network_allowed(&self) -> bool {
        self.inner.allowed.load(Ordering::SeqCst)
    }

    /// Reachability tracked from request outcomes; never `true` while the network is not allowed.
    #[must_use]
    pub fn online(&self) -> bool {
        self.inner.online()
    }

    /// Called with the new value on every change of [`Self::online`] (`PackEvents::network`).
    pub fn set_listener(&self, listener: impl Fn(bool) + Send + Sync + 'static) {
        *self.inner.listener.write() = Some(Arc::new(listener));
    }

    /// Starts the offline re-probe task once (idempotent). It ends when the last `Http` handle is dropped.
    pub fn start_probe(&self, rt: &tokio::runtime::Handle) {
        if self.inner.probing.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        let wake = Arc::clone(&self.inner.probe_wake);
        rt.spawn(probe_loop(weak, wake));
    }

    /// One reachability probe now (`HEAD` of the probe URL); `true` when anything answered.
    pub async fn probe(&self) -> bool {
        let s = &self.inner;
        if !s.allowed.load(Ordering::SeqCst) {
            return false;
        }
        let timeout = s.cfg.connect_timeout.saturating_add(s.cfg.read_timeout);
        match s
            .files
            .head(s.cfg.probe_url.as_str())
            .timeout(timeout)
            .send()
            .await
        {
            Ok(_) => {
                s.record_response();
                true
            }
            Err(e) => {
                log::debug!("reachability probe failed: {e}");
                false
            }
        }
    }

    fn gate(&self) -> Result<(), PackError> {
        if self.network_allowed() {
            Ok(())
        } else {
            Err(PackError::Offline)
        }
    }

    /// The gate inside a request: turning the network off stops transfers in flight (resumable temps are kept).
    fn still_allowed(&self) -> Result<(), Failure> {
        self.gate().map_err(Failure::Fatal)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Requests
    // -----------------------------------------------------------------------------------------------------------

    /// `GET` into memory (API JSON, small payloads) with the API client; at most [`HttpConfig::max_body_bytes`].
    pub async fn get(&self, req: Request<'_>) -> Result<Body, PackError> {
        self.get_impl(req, false).await
    }

    /// `GET` with `Accept: application/json`, parsed into `T`.
    pub async fn get_json<T: DeserializeOwned>(&self, req: Request<'_>) -> Result<T, PackError> {
        self.get_impl(req, true).await?.json()
    }

    async fn get_impl(&self, req: Request<'_>, json: bool) -> Result<Body, PackError> {
        self.gate()?;
        let req = req.started(&self.inner.cfg);
        let mut plan = Plan::new(req.urls, &self.inner.cfg, req.deadline)?;
        loop {
            let i = match plan.next(self.inner.reachable()) {
                Step::Try(i) => i,
                Step::Wait(d) => {
                    pause(d, req.job).await?;
                    continue;
                }
                Step::Done(e) => return Err(self.final_error(e)),
            };
            let Some(url) = plan.url(i).cloned() else {
                continue;
            };
            match self.get_once(&url, &req, json).await {
                Ok(body) => return Ok(body),
                Err(f) => plan.failed(i, f)?,
            }
        }
    }

    async fn get_once(&self, url: &Url, req: &Request<'_>, json: bool) -> Result<Body, Failure> {
        self.still_allowed()?;
        let _permits = self.acquire(url, req).await.map_err(Failure::Fatal)?;
        let mut rb = self.inner.api.get(url.clone());
        if json {
            rb = rb.header(header::ACCEPT, "application/json");
        }
        let resp = self.send(url, rb, req).await?;
        if let Some(f) = status_failure(&resp, url, false) {
            return Err(f);
        }
        let validators = Validators::from_headers(resp.headers());
        let content_length = resp.content_length();
        let max = self.inner.cfg.max_body_bytes;
        if content_length.is_some_and(|n| n > max) {
            return Err(Failure::Dead(too_large(url, max)));
        }
        let capacity = content_length.map_or(64 * 1024, |n| n.min(4 * 1024 * 1024));
        let mut bytes = Vec::with_capacity(usize::try_from(capacity).unwrap_or(64 * 1024));
        let mut counted = Counted::new(req.job);
        let mut resp = resp;
        loop {
            let chunk = until_stopped(req.job, resp.chunk())
                .await
                .map_err(Failure::Fatal)?;
            self.still_allowed()?;
            match chunk {
                Ok(Some(c)) => {
                    if u64::try_from(bytes.len().saturating_add(c.len())).unwrap_or(u64::MAX) > max
                    {
                        return Err(Failure::Dead(too_large(url, max)));
                    }
                    bytes.extend_from_slice(&c);
                    counted.add(c.len());
                }
                Ok(None) => break,
                Err(e) => return Err(Failure::Retry(e.into(), None)),
            }
        }
        if let Some(n) = content_length
            && u64::try_from(bytes.len()).unwrap_or(u64::MAX) != n
        {
            return Err(Failure::Retry(
                PackError::Integrity(format!(
                    "{url}: body of {} bytes, Content-Length {n}",
                    bytes.len()
                )),
                None,
            ));
        }
        counted.keep();
        Ok(Body {
            bytes,
            url: url.to_string(),
            validators,
            content_length,
        })
    }

    /// `HEAD` with the file client (so `Content-Length` is the file's), conditional when `validators` are given
    /// (`If-None-Match` / `If-Modified-Since`); a `304` is a normal answer.
    pub async fn head(
        &self,
        req: Request<'_>,
        validators: Option<&Validators>,
    ) -> Result<Head, PackError> {
        self.gate()?;
        let req = req.started(&self.inner.cfg);
        let mut plan = Plan::new(req.urls, &self.inner.cfg, req.deadline)?;
        loop {
            let i = match plan.next(self.inner.reachable()) {
                Step::Try(i) => i,
                Step::Wait(d) => {
                    pause(d, req.job).await?;
                    continue;
                }
                Step::Done(e) => return Err(self.final_error(e)),
            };
            let Some(url) = plan.url(i).cloned() else {
                continue;
            };
            match self.head_once(&url, &req, validators).await {
                Ok(head) => return Ok(head),
                Err(f) => plan.failed(i, f)?,
            }
        }
    }

    async fn head_once(
        &self,
        url: &Url,
        req: &Request<'_>,
        validators: Option<&Validators>,
    ) -> Result<Head, Failure> {
        self.still_allowed()?;
        let _permits = self.acquire(url, req).await.map_err(Failure::Fatal)?;
        let mut rb = self
            .inner
            .files
            .head(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if let Some(v) = validators {
            if let Some(etag) = &v.etag {
                rb = rb.header(header::IF_NONE_MATCH, etag.as_str());
            }
            if let Some(lm) = &v.last_modified {
                rb = rb.header(header::IF_MODIFIED_SINCE, lm.as_str());
            }
        }
        let resp = self.send(url, rb, req).await?;
        let status = resp.status();
        let not_modified = status == reqwest::StatusCode::NOT_MODIFIED;
        if !not_modified && let Some(f) = status_failure(&resp, url, false) {
            return Err(f);
        }
        Ok(Head {
            url: url.to_string(),
            status: status.as_u16(),
            not_modified,
            validators: Validators::from_headers(resp.headers()),
            content_length: header_u64(resp.headers(), header::CONTENT_LENGTH),
        })
    }

    /// Downloads a small file (font page, decor file) to `{dest}.part`, verifies it and renames it over `dest`. No
    /// resume: an interrupted attempt starts again. The temp never survives a failure.
    pub async fn fetch_file(
        &self,
        req: Request<'_>,
        dest: &Path,
        expect: &Expect,
    ) -> Result<Downloaded, PackError> {
        self.gate()?;
        let part = install::part_path(dest);
        let req = req.started(&self.inner.cfg);
        let mut plan = Plan::new(req.urls, &self.inner.cfg, req.deadline)?;
        loop {
            let i = match plan.next(self.inner.reachable()) {
                Step::Try(i) => i,
                Step::Wait(d) => {
                    pause(d, req.job).await?;
                    continue;
                }
                Step::Done(e) => return Err(self.final_error(e)),
            };
            let Some(url) = plan.url(i).cloned() else {
                continue;
            };
            match self.fetch_file_once(&url, &req, dest, &part, expect).await {
                Ok(done) => return Ok(done),
                Err(f) => plan.failed(i, f)?,
            }
        }
    }

    async fn fetch_file_once(
        &self,
        url: &Url,
        req: &Request<'_>,
        dest: &Path,
        part: &Path,
        expect: &Expect,
    ) -> Result<Downloaded, Failure> {
        self.still_allowed()?;
        let _permits = self.acquire(url, req).await.map_err(Failure::Fatal)?;
        let rb = self
            .inner
            .files
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        let resp = self.send(url, rb, req).await?;
        if let Some(f) = status_failure(&resp, url, true) {
            return Err(f);
        }
        let total = file_total(&resp, url, expect)?;
        if let Some(job) = req.job {
            job.set_expected_len(total);
        }
        let validators = Validators::from_headers(resp.headers());

        if let Some(parent) = part.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| Failure::Fatal(e.into()))?;
        }
        // Declared before the file so the file closes first and the guard then deletes the temp.
        let mut guard = TempGuard::new(part);
        let mut file = tokio::fs::File::create(part)
            .await
            .map_err(|e| Failure::Fatal(e.into()))?;
        let mut hasher = Sha256::new();
        let mut head = Vec::new();
        let mut buf = Vec::with_capacity(CHUNK_BYTES);
        let mut written = 0u64;
        let mut counted = Counted::new(req.job);
        let mut resp = resp;
        loop {
            let chunk = until_stopped(req.job, resp.chunk())
                .await
                .map_err(Failure::Fatal)?;
            self.still_allowed()?;
            let c = match chunk {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => return Err(Failure::Retry(e.into(), None)),
            };
            let n = u64::try_from(c.len()).unwrap_or(u64::MAX);
            if written.saturating_add(n) > total {
                return Err(Failure::Dead(PackError::Integrity(format!(
                    "{url}: longer than its Content-Length {total}"
                ))));
            }
            check_magic(&mut head, &c, expect.magic, url)?;
            hasher.update(&c);
            buf.extend_from_slice(&c);
            written = written.saturating_add(n);
            counted.add(c.len());
            if buf.len() >= CHUNK_BYTES {
                file.write_all(&buf)
                    .await
                    .map_err(|e| Failure::Fatal(e.into()))?;
                buf.clear();
            }
        }
        file.write_all(&buf)
            .await
            .map_err(|e| Failure::Fatal(e.into()))?;
        file.flush().await.map_err(|e| Failure::Fatal(e.into()))?;
        file.sync_all()
            .await
            .map_err(|e| Failure::Fatal(e.into()))?;
        drop(file);
        if written != total {
            return Err(Failure::Retry(
                PackError::Integrity(format!(
                    "{url}: connection closed after {written} of {total} bytes"
                )),
                None,
            ));
        }
        finish_magic(&head, expect.magic, url)?;
        let sha256 = hex::encode(hasher.finalize());
        check_sha(&sha256, expect, url)?;
        install::commit(part, dest).await.map_err(Failure::Fatal)?;
        guard.disarm();
        counted.keep();
        Ok(Downloaded {
            path: dest.to_path_buf(),
            bytes: total,
            sha256,
            url: url.to_string(),
            validators,
            resumed_from: 0,
            kept_existing: false,
        })
    }

    /// Downloads a large file (zip, mp3) resumably to `{name}.dl.part` + sidecar, verifies it and renames it to
    /// `dest`. An interrupted download (pause, crash, network) continues from the sidecar's `received`. On an integrity
    /// failure the temp and sidecar are deleted; on cancel/pause and network failures they are kept.
    pub async fn download(
        &self,
        req: Request<'_>,
        dest: &Path,
        expect: &Expect,
    ) -> Result<Downloaded, PackError> {
        self.gate()?;
        if let Some(done) = accept_existing(dest, expect).await? {
            if let Some(job) = req.job {
                job.set_expected_len(done.bytes);
            }
            return Ok(done);
        }
        let mut st = Resume::prepare(dest, req.urls, expect)
            .await
            .map_err(PackError::from)?;
        let resumed_from = st.meta.received;
        if let Some(job) = req.job
            && resumed_from > 0
        {
            job.add_resumed(resumed_from);
            if let Some(total) = st.meta.total {
                job.set_expected_len(total);
            }
        }
        let preferred = (!st.meta.url.is_empty()).then(|| st.meta.url.clone());
        let req = req.started(&self.inner.cfg);
        let mut plan =
            Plan::new(req.urls, &self.inner.cfg, req.deadline)?.prefer(preferred.as_deref());
        loop {
            let i = match plan.next(self.inner.reachable()) {
                Step::Try(i) => i,
                Step::Wait(d) => {
                    pause(d, req.job).await?;
                    continue;
                }
                Step::Done(e) => return Err(self.final_error(e)),
            };
            let Some(url) = plan.url(i).cloned() else {
                continue;
            };
            let before = st.meta.received;
            match self.download_once(&url, &req, &mut st, expect).await {
                Ok(()) => break,
                Err(f) => {
                    if st.meta.received > before {
                        plan.progressed();
                    }
                    plan.failed(i, f)?;
                }
            }
        }
        st.finish(dest, expect, resumed_from).await
    }

    async fn download_once(
        &self,
        url: &Url,
        req: &Request<'_>,
        st: &mut Resume,
        expect: &Expect,
    ) -> Result<(), Failure> {
        self.still_allowed()?;
        let _permits = self.acquire(url, req).await.map_err(Failure::Fatal)?;
        let validators = st.meta.validators();
        let if_range = validators.if_range().map(str::to_owned);
        if st.meta.received > 0 && if_range.is_none() {
            // Nothing to prove the bytes on disk belong to the current file: start over.
            st.reset(req.job).await.map_err(Failure::Fatal)?;
        }
        let resuming = st.meta.received > 0;
        let mut rb = self
            .inner
            .files
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if resuming && let Some(v) = &if_range {
            rb = rb
                .header(header::RANGE, format!("bytes={}-", st.meta.received))
                .header(header::IF_RANGE, v.as_str());
        }
        let resp = self.send(url, rb, req).await?;
        let status = resp.status().as_u16();
        let total = match status {
            206 if resuming => {
                let range =
                    header_str(resp.headers(), header::CONTENT_RANGE).and_then(parse_content_range);
                match range {
                    Some((start, Some(total)))
                        if start == st.meta.received
                            && st.meta.total.is_none_or(|t| t == total) =>
                    {
                        total
                    }
                    _ => {
                        st.reset(req.job).await.map_err(Failure::Fatal)?;
                        return Err(Failure::Retry(
                            PackError::Integrity(format!(
                                "{url}: unexpected Content-Range for a resume"
                            )),
                            None,
                        ));
                    }
                }
            }
            416 if resuming => {
                if st.meta.total == Some(st.meta.received) {
                    return Ok(());
                }
                st.reset(req.job).await.map_err(Failure::Fatal)?;
                return Err(Failure::Retry(
                    PackError::Http {
                        status,
                        url: url.to_string(),
                    },
                    None,
                ));
            }
            200 => {
                if st.meta.received > 0 {
                    // If-Range did not match (the file changed) or the server ignores ranges: restart.
                    st.reset(req.job).await.map_err(Failure::Fatal)?;
                }
                file_total(&resp, url, expect)?
            }
            _ => {
                return Err(status_failure(&resp, url, true).unwrap_or_else(|| {
                    Failure::Dead(PackError::Http {
                        status,
                        url: url.to_string(),
                    })
                }));
            }
        };
        if let Some(len) = expect.len
            && len != total
        {
            st.discard().await;
            return Err(Failure::Dead(length_mismatch(url, total, len)));
        }
        if let Some(max) = expect.max_len
            && total > max
        {
            st.discard().await;
            return Err(Failure::Dead(too_large(url, max)));
        }
        if let Some(job) = req.job {
            job.set_expected_len(total);
        }
        let fresh = Validators::from_headers(resp.headers());
        st.meta.url = url.to_string();
        st.meta.total = Some(total);
        if status == 200 || fresh.etag.is_some() || fresh.last_modified.is_some() {
            st.meta.etag = fresh.etag;
            st.meta.last_modified = fresh.last_modified;
        }
        st.save().await.map_err(Failure::Fatal)?;

        let mut file = st.open_for_append().await.map_err(Failure::Fatal)?;
        let mut buf = Vec::with_capacity(CHUNK_BYTES);
        let mut unsynced = 0u64;
        let mut resp = resp;
        loop {
            let chunk = match until_stopped(req.job, resp.chunk())
                .await
                .and_then(|c| self.gate().map(|()| c))
            {
                Ok(c) => c,
                Err(stop) => {
                    // Paused, cancelled or the network was turned off: keep what arrived for a resume.
                    st.persist(&mut file, &mut buf, &mut unsynced)
                        .await
                        .map_err(Failure::Fatal)?;
                    return Err(Failure::Fatal(stop));
                }
            };
            let c = match chunk {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    st.persist(&mut file, &mut buf, &mut unsynced)
                        .await
                        .map_err(Failure::Fatal)?;
                    return Err(Failure::Retry(e.into(), None));
                }
            };
            let n = u64::try_from(c.len()).unwrap_or(u64::MAX);
            let pending = st.meta.received.saturating_add(unsynced).saturating_add(n);
            if pending > total {
                drop(file);
                st.discard().await;
                return Err(Failure::Dead(PackError::Integrity(format!(
                    "{url}: longer than its length {total}"
                ))));
            }
            if let Err(f) = check_magic(&mut st.head, &c, expect.magic, url) {
                drop(file);
                st.discard().await;
                return Err(f);
            }
            st.hasher.update(&c);
            buf.extend_from_slice(&c);
            unsynced = unsynced.saturating_add(n);
            if let Some(job) = req.job {
                job.add_received(n);
            }
            if buf.len() >= CHUNK_BYTES {
                file.write_all(&buf)
                    .await
                    .map_err(|e| Failure::Fatal(e.into()))?;
                buf.clear();
            }
            if unsynced >= SIDECAR_EVERY {
                st.persist(&mut file, &mut buf, &mut unsynced)
                    .await
                    .map_err(Failure::Fatal)?;
            }
        }
        st.persist(&mut file, &mut buf, &mut unsynced)
            .await
            .map_err(Failure::Fatal)?;
        if st.meta.received == total {
            Ok(())
        } else {
            Err(Failure::Retry(
                PackError::Integrity(format!(
                    "{url}: connection closed after {} of {total} bytes",
                    st.meta.received
                )),
                None,
            ))
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Plumbing
    // -----------------------------------------------------------------------------------------------------------

    async fn acquire(&self, url: &Url, req: &Request<'_>) -> Result<Permits, PackError> {
        let s = &self.inner;
        let host = format!(
            "{}:{}",
            url.host_str().unwrap_or_default().to_ascii_lowercase(),
            url.port_or_known_default().unwrap_or(0)
        );
        let slots = {
            let mut hosts = s.hosts.lock();
            hosts
                .entry(host)
                .or_insert_with(|| HostSlots {
                    all: Arc::new(Semaphore::new(s.cfg.per_host_limit.max(1))),
                    background: Arc::new(Semaphore::new(
                        s.cfg
                            .background_per_host_limit
                            .clamp(1, s.cfg.per_host_limit.max(1)),
                    )),
                })
                .clone()
        };
        let background = req.lane == Lane::Background;
        let mut permits = Vec::with_capacity(4);
        // One global order (host-bg, host, global-bg, global): no cycles, so no deadlock.
        if background {
            permits.push(acquire_one(&slots.background, req.job).await?);
        }
        permits.push(acquire_one(&slots.all, req.job).await?);
        if background {
            permits.push(acquire_one(&s.global_bg, req.job).await?);
        }
        permits.push(acquire_one(&s.global, req.job).await?);
        Ok(Permits { _held: permits })
    }

    /// Sends one attempt and waits for its response: on the interactive lane at most the response timeout (module
    /// docs, "Interactive budget"), which is then a transient failure of this URL like a timeout of the client.
    async fn send(
        &self,
        url: &Url,
        rb: reqwest::RequestBuilder,
        req: &Request<'_>,
    ) -> Result<reqwest::Response, Failure> {
        let sent = until_stopped(req.job, rb.send());
        let outcome = match req.response_timeout(&self.inner.cfg) {
            None => sent.await,
            Some(limit) => match tokio::time::timeout(limit, sent).await {
                Ok(outcome) => outcome,
                Err(_) => {
                    return Err(Failure::Retry(
                        PackError::Timeout(format!(
                            "{url}: no response within {} ms",
                            limit.as_millis()
                        )),
                        None,
                    ));
                }
            },
        };
        match outcome.map_err(Failure::Fatal)? {
            Ok(resp) => {
                self.inner.record_response();
                Ok(resp)
            }
            Err(e) => Err(self.classify(e)),
        }
    }

    fn classify(&self, e: reqwest::Error) -> Failure {
        if e.is_connect() {
            self.inner.record_connect_failure();
            Failure::Connect(e.into())
        } else if e.is_builder() || e.is_redirect() {
            Failure::Dead(e.into())
        } else {
            Failure::Retry(e.into(), None)
        }
    }

    fn final_error(&self, e: PackError) -> PackError {
        let connect = matches!(&e, PackError::Network(n) if n.is_connect());
        if connect && !self.inner.reachable() {
            PackError::Offline
        } else {
            e
        }
    }
}

impl HttpShared {
    fn reachable(&self) -> bool {
        self.reachable.load(Ordering::SeqCst)
    }

    fn online(&self) -> bool {
        self.allowed.load(Ordering::SeqCst) && self.reachable()
    }

    fn record_response(&self) {
        self.connect_failures.store(0, Ordering::SeqCst);
        if !self.reachable.swap(true, Ordering::SeqCst) {
            log::info!("network: online");
            self.report();
        }
    }

    fn record_connect_failure(&self) {
        let n = self
            .connect_failures
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        if n >= self.cfg.offline_after_connect_failures.max(1)
            && self.reachable.swap(false, Ordering::SeqCst)
        {
            log::info!("network: offline after {n} consecutive connect failures");
            self.report();
            self.probe_wake.notify_waiters();
        }
    }

    /// Reports the effective value to the listener when it changed (serialised by `reported`).
    fn report(&self) {
        let mut last = self.reported.lock();
        let now = self.online();
        if *last != now {
            *last = now;
            let listener = self.listener.read().clone();
            if let Some(listener) = listener {
                listener(now);
            }
        }
    }
}

async fn probe_loop(weak: Weak<HttpShared>, wake: Arc<Notify>) {
    loop {
        let notified = wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let Some((interval, needs_probe, now)) = weak.upgrade().map(|s| {
            let needs = s.allowed.load(Ordering::SeqCst) && !s.reachable();
            let now = needs && s.probe_now.swap(false, Ordering::SeqCst);
            (s.cfg.probe_interval, needs, now)
        }) else {
            return;
        };
        if needs_probe && !now {
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                () = &mut notified => continue,
            }
        } else if !needs_probe {
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                () = &mut notified => {}
            }
            continue;
        }
        let Some(shared) = weak.upgrade() else {
            return;
        };
        let http = Http { inner: shared };
        if !http.online() && http.network_allowed() {
            http.probe().await;
        }
    }
}

/// How one attempt against one URL failed.
enum Failure {
    /// This URL cannot serve the request (404/410, other 4xx, a payload that failed integrity): never again.
    Dead(PackError),
    /// No connection: next mirror now; this URL again next round.
    Connect(PackError),
    /// Transient (5xx, 408/425/429, timeout, broken body): next mirror now; this URL again next round, after the
    /// backoff or `Retry-After`.
    Retry(PackError, Option<Duration>),
    /// Stop the request (cancelled/paused, local IO).
    Fatal(PackError),
}

enum Step {
    Try(usize),
    Wait(Duration),
    Done(PackError),
}

/// The mirror/retry schedule of one request (module docs).
struct Plan {
    urls: Vec<Option<Url>>,
    dead: Vec<bool>,
    order: Vec<usize>,
    pos: usize,
    round: usize,
    backoff: Vec<Duration>,
    max_retry_after: Duration,
    round_wait: Duration,
    round_only_connect: bool,
    round_tried: bool,
    last: Option<PackError>,
    /// An interactive request's deadline: no attempt or retry wait begins past it.
    deadline: Option<Instant>,
}

impl Plan {
    fn new(
        urls: &[String],
        cfg: &HttpConfig,
        deadline: Option<Instant>,
    ) -> Result<Self, PackError> {
        if urls.is_empty() {
            return Err(PackError::Catalog("no URL to fetch".into()));
        }
        let mut last = None;
        let parsed: Vec<Option<Url>> = urls
            .iter()
            .map(|u| match Url::parse(u) {
                Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => {
                    Some(url)
                }
                _ => {
                    last = Some(PackError::Catalog(format!("not an http(s) URL: {u:?}")));
                    None
                }
            })
            .collect();
        let dead = parsed.iter().map(Option::is_none).collect();
        Ok(Self {
            order: (0..parsed.len()).collect(),
            urls: parsed,
            dead,
            pos: 0,
            round: 0,
            backoff: cfg.backoff.clone(),
            max_retry_after: cfg.max_retry_after,
            round_wait: Duration::ZERO,
            round_only_connect: true,
            round_tried: false,
            last,
            deadline,
        })
    }

    /// Whether something that would end `wait` from now passes the deadline.
    fn past_deadline(&self, wait: Duration) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() + wait >= deadline)
    }

    /// The request ran out of time: the last attempt's error (normally its response timeout).
    fn out_of_time(&mut self) -> Step {
        log::debug!("http: an interactive request ran out of time");
        Step::Done(
            self.last
                .take()
                .unwrap_or_else(|| PackError::Timeout("no answer before the deadline".into())),
        )
    }

    /// Tries `url` first (the sidecar's mirror) when it is in the list.
    fn prefer(mut self, url: Option<&str>) -> Self {
        if let Some(url) = url
            && let Some(i) = self
                .urls
                .iter()
                .position(|u| u.as_ref().is_some_and(|u| u.as_str() == url))
        {
            self.order.retain(|&j| j != i);
            self.order.insert(0, i);
        }
        self
    }

    fn url(&self, i: usize) -> Option<&Url> {
        self.urls.get(i).and_then(Option::as_ref)
    }

    fn next(&mut self, reachable: bool) -> Step {
        while let Some(&i) = self.order.get(self.pos) {
            self.pos += 1;
            if !self.dead.get(i).copied().unwrap_or(true) {
                if self.last.is_some() && self.past_deadline(Duration::ZERO) {
                    return self.out_of_time();
                }
                self.round_tried = true;
                return Step::Try(i);
            }
        }
        let last = || PackError::Catalog("every URL failed".into());
        if self.dead.iter().all(|d| *d) {
            return Step::Done(self.last.take().unwrap_or_else(last));
        }
        if self.round_tried && self.round_only_connect && !reachable {
            return Step::Done(PackError::Offline);
        }
        let Some(&delay) = self.backoff.get(self.round) else {
            return Step::Done(self.last.take().unwrap_or_else(last));
        };
        let wait = delay.max(self.round_wait);
        if self.past_deadline(wait) {
            return self.out_of_time();
        }
        self.round += 1;
        self.pos = 0;
        self.round_wait = Duration::ZERO;
        self.round_only_connect = true;
        self.round_tried = false;
        Step::Wait(wait)
    }

    fn failed(&mut self, i: usize, f: Failure) -> Result<(), PackError> {
        match f {
            Failure::Dead(e) => {
                if let Some(d) = self.dead.get_mut(i) {
                    *d = true;
                }
                self.round_only_connect = false;
                self.last = Some(e);
            }
            Failure::Connect(e) => self.last = Some(e),
            Failure::Retry(e, retry_after) => {
                self.round_only_connect = false;
                if let Some(ra) = retry_after {
                    if ra > self.max_retry_after {
                        if let Some(d) = self.dead.get_mut(i) {
                            *d = true;
                        }
                    } else {
                        self.round_wait = self.round_wait.max(ra);
                    }
                }
                self.last = Some(e);
            }
            Failure::Fatal(e) => return Err(e),
        }
        Ok(())
    }

    /// A resumable download made progress: the retry budget starts again.
    const fn progressed(&mut self) {
        self.round = 0;
    }
}

/// The semaphore permits of one request, released on drop.
struct Permits {
    _held: Vec<OwnedSemaphorePermit>,
}

async fn acquire_one(
    sem: &Arc<Semaphore>,
    job: Option<&JobHandle>,
) -> Result<OwnedSemaphorePermit, PackError> {
    until_stopped(job, Arc::clone(sem).acquire_owned())
        .await?
        .map_err(|e| PackError::Io(io::Error::other(format!("request limiter closed: {e}"))))
}

/// Runs `fut` unless the job is (or becomes) paused or cancelled.
async fn until_stopped<F: Future>(job: Option<&JobHandle>, fut: F) -> Result<F::Output, PackError> {
    match job {
        None => Ok(fut.await),
        Some(job) => {
            job.check()?;
            tokio::select! {
                biased;
                () = job.stopped() => Err(PackError::Cancelled),
                out = fut => Ok(out),
            }
        }
    }
}

/// Sleeps between retry rounds; ends early with `Cancelled` when the job stops.
async fn pause(d: Duration, job: Option<&JobHandle>) -> Result<(), PackError> {
    until_stopped(job, tokio::time::sleep(d)).await
}

fn status_failure(resp: &reqwest::Response, url: &Url, file: bool) -> Option<Failure> {
    let status = resp.status();
    if status.is_success() && !(file && status.as_u16() != 200) {
        return None;
    }
    let code = status.as_u16();
    let err = PackError::Http {
        status: code,
        url: url.to_string(),
    };
    Some(match code {
        404 | 410 => Failure::Dead(err),
        429 | 503 => Failure::Retry(err, retry_after(resp.headers())),
        408 | 425 | 500..=599 => Failure::Retry(err, None),
        _ => Failure::Dead(err),
    })
}

/// [`Expect::keep_existing`] before any request: a complete `dest` (exact expected length, and hash/magic when given)
/// is accepted; its stale temps are removed.
async fn accept_existing(dest: &Path, expect: &Expect) -> Result<Option<Downloaded>, PackError> {
    let Some(len) = expect.len.filter(|_| expect.keep_existing) else {
        return Ok(None);
    };
    if install::file_len(dest).await != Some(len) {
        return Ok(None);
    }
    let path = dest.to_path_buf();
    let (sha256, head) = tokio::task::spawn_blocking(move || hash_file(&path))
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("blocking task failed: {e}"))))??;
    if expect
        .sha256
        .as_ref()
        .is_some_and(|w| !w.eq_ignore_ascii_case(&sha256))
        || expect.magic.is_some_and(|m| !head.starts_with(m))
    {
        return Ok(None);
    }
    install::remove_file(&install::dl_part_path(dest)).await?;
    install::remove_file(&install::dl_sidecar_path(dest)).await?;
    Ok(Some(Downloaded {
        path: dest.to_path_buf(),
        bytes: len,
        sha256,
        url: String::new(),
        validators: Validators::default(),
        resumed_from: 0,
        kept_existing: true,
    }))
}

/// Whether the file at `path` hashes to `sha256` (`false` when it cannot be read).
async fn same_file(path: &Path, sha256: &str) -> bool {
    let path = path.to_path_buf();
    matches!(
        tokio::task::spawn_blocking(move || hash_file(&path)).await,
        Ok(Ok((sha, _))) if sha == sha256
    )
}

/// sha256 (hex) and the first 16 bytes of a file.
fn hash_file(path: &Path) -> io::Result<(String, Vec<u8>)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut head = Vec::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let Some(read) = buf.get(..n) else {
            break;
        };
        if head.len() < 16 {
            head.extend(read.iter().take(16 - head.len()));
        }
        hasher.update(read);
    }
    Ok((hex::encode(hasher.finalize()), head))
}

/// The full length of a file response: `Content-Length` (or the expected length when the server sends none).
fn file_total(resp: &reqwest::Response, url: &Url, expect: &Expect) -> Result<u64, Failure> {
    match (
        header_u64(resp.headers(), header::CONTENT_LENGTH),
        expect.len,
    ) {
        (Some(n), Some(len)) if n != len => Err(Failure::Dead(length_mismatch(url, n, len))),
        (Some(n), _) | (None, Some(n)) => {
            if expect.max_len.is_some_and(|max| n > max) {
                Err(Failure::Dead(too_large(url, expect.max_len.unwrap_or(0))))
            } else {
                Ok(n)
            }
        }
        (None, None) => Err(Failure::Dead(PackError::Integrity(format!(
            "{url}: no Content-Length, so the file cannot be verified"
        )))),
    }
}

fn length_mismatch(url: &Url, got: u64, want: u64) -> PackError {
    PackError::Integrity(format!("{url}: length {got}, expected {want}"))
}

fn too_large(url: &Url, max: u64) -> PackError {
    PackError::Integrity(format!("{url}: larger than {max} bytes"))
}

fn check_magic(
    head: &mut Vec<u8>,
    chunk: &[u8],
    magic: Option<&'static [u8]>,
    url: &Url,
) -> Result<(), Failure> {
    let Some(magic) = magic else {
        return Ok(());
    };
    if head.len() >= magic.len() {
        return Ok(());
    }
    let need = magic.len().saturating_sub(head.len());
    head.extend(chunk.iter().take(need));
    if head.len() >= magic.len() && !head.starts_with(magic) {
        return Err(Failure::Dead(PackError::Integrity(format!(
            "{url}: does not start with {:?}",
            String::from_utf8_lossy(magic)
        ))));
    }
    Ok(())
}

fn finish_magic(head: &[u8], magic: Option<&'static [u8]>, url: &Url) -> Result<(), Failure> {
    match magic {
        Some(m) if !head.starts_with(m) => Err(Failure::Dead(PackError::Integrity(format!(
            "{url}: does not start with {:?}",
            String::from_utf8_lossy(m)
        )))),
        _ => Ok(()),
    }
}

fn check_sha(sha256: &str, expect: &Expect, url: &Url) -> Result<(), Failure> {
    match &expect.sha256 {
        Some(want) if !want.eq_ignore_ascii_case(sha256) => {
            Err(Failure::Dead(PackError::Integrity(format!(
                "{url}: sha256 {sha256}, expected {}",
                want.to_ascii_lowercase()
            ))))
        }
        _ => Ok(()),
    }
}

fn header_str(h: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    h.get(name).and_then(|v| v.to_str().ok()).map(str::trim)
}

fn header_u64(h: &HeaderMap, name: header::HeaderName) -> Option<u64> {
    header_str(h, name).and_then(|s| s.parse().ok())
}

/// `bytes {start}-{end}/{total|*}` → `(start, total)`.
#[must_use]
pub fn parse_content_range(v: &str) -> Option<(u64, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.trim().split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    if end < start {
        return None;
    }
    let total = match total.trim() {
        "*" => None,
        t => {
            let t: u64 = t.parse().ok()?;
            if end >= t {
                return None;
            }
            Some(t)
        }
    };
    Some((start, total))
}

/// `Retry-After`: delta-seconds or an IMF-fixdate.
#[must_use]
pub fn parse_retry_after(v: &str) -> Option<Duration> {
    let v = v.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let format = time::macros::format_description!(
        "[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT"
    );
    let when = time::PrimitiveDateTime::parse(v, format).ok()?.assume_utc();
    let delta = when - time::OffsetDateTime::now_utc();
    Some(Duration::try_from(delta).unwrap_or(Duration::ZERO))
}

fn retry_after(h: &HeaderMap) -> Option<Duration> {
    header_str(h, header::RETRY_AFTER).and_then(parse_retry_after)
}

/// Bytes an attempt added to a job's progress; rewound unless the attempt succeeded.
struct Counted<'a> {
    job: Option<&'a JobHandle>,
    bytes: u64,
}

impl<'a> Counted<'a> {
    const fn new(job: Option<&'a JobHandle>) -> Self {
        Self { job, bytes: 0 }
    }

    fn add(&mut self, n: usize) {
        let n = u64::try_from(n).unwrap_or(u64::MAX);
        self.bytes = self.bytes.saturating_add(n);
        if let Some(job) = self.job {
            job.add_received(n);
        }
    }

    const fn keep(&mut self) {
        self.bytes = 0;
    }
}

impl Drop for Counted<'_> {
    fn drop(&mut self) {
        if let Some(job) = self.job
            && self.bytes > 0
        {
            job.rewind(self.bytes);
        }
    }
}

/// Deletes a non-resumable temp unless disarmed (also when the future is dropped mid-download).
struct TempGuard {
    path: PathBuf,
    armed: bool,
}

impl TempGuard {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            armed: true,
        }
    }

    const fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.armed
            && let Err(e) = std::fs::remove_file(&self.path)
            && e.kind() != io::ErrorKind::NotFound
        {
            log::warn!("cannot remove {}: {e}", self.path.display());
        }
    }
}

/// The state of one resumable download (module docs).
struct Resume {
    part: PathBuf,
    sidecar: PathBuf,
    meta: Sidecar,
    hasher: Sha256,
    /// The first bytes of the file (magic check).
    head: Vec<u8>,
}

impl Resume {
    /// Loads the sidecar and truncates the temp to its `received`, or starts fresh when they are unusable.
    async fn prepare(dest: &Path, urls: &[String], expect: &Expect) -> io::Result<Self> {
        let part = install::dl_part_path(dest);
        let sidecar = install::dl_sidecar_path(dest);
        let mut st = Self {
            part,
            sidecar,
            meta: Sidecar::default(),
            hasher: Sha256::new(),
            head: Vec::new(),
        };
        let Some(meta) = read_sidecar(&st.sidecar).await else {
            st.remove_files().await?;
            return Ok(st);
        };
        let part_len = tokio::fs::metadata(&st.part).await.map(|m| m.len()).ok();
        let usable = part_len.is_some_and(|len| len >= meta.received)
            && urls.contains(&meta.url)
            && meta.total.is_none_or(|t| meta.received <= t)
            && expect
                .len
                .is_none_or(|len| meta.total.is_none_or(|t| t == len))
            && meta.received > 0;
        if !usable {
            st.remove_files().await?;
            return Ok(st);
        }
        // Truncate to what is known to be durable, then hash that prefix (never the file length).
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&st.part)
            .await?;
        file.set_len(meta.received).await?;
        let mut file = file;
        file.seek(io::SeekFrom::Start(0)).await?;
        let mut left = meta.received;
        let mut buf = vec![0u8; 1024 * 1024];
        while left > 0 {
            let want = usize::try_from(left.min(1024 * 1024)).unwrap_or(1024 * 1024);
            let Some(slot) = buf.get_mut(..want) else {
                break;
            };
            let n = file.read(slot).await?;
            if n == 0 {
                break;
            }
            let Some(read) = buf.get(..n) else {
                break;
            };
            if let Some(magic_len) = expect.magic.map(<[u8]>::len)
                && st.head.len() < magic_len
            {
                let need = magic_len.saturating_sub(st.head.len());
                st.head.extend(read.iter().take(need));
            }
            st.hasher.update(read);
            left = left.saturating_sub(u64::try_from(n).unwrap_or(u64::MAX));
        }
        if left > 0 {
            st.remove_files().await?;
            st.hasher = Sha256::new();
            st.head.clear();
            return Ok(st);
        }
        st.meta = meta;
        Ok(st)
    }

    async fn remove_files(&self) -> io::Result<()> {
        for p in [&self.part, &self.sidecar] {
            match tokio::fs::remove_file(p).await {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Starts over from byte 0 (keeps the temp file, empty).
    async fn reset(&mut self, job: Option<&JobHandle>) -> Result<(), PackError> {
        if let Some(job) = job {
            job.restart_item();
        }
        self.meta = Sidecar::default();
        self.hasher = Sha256::new();
        self.head.clear();
        self.remove_files().await?;
        Ok(())
    }

    /// Integrity failure: drop everything (best effort).
    async fn discard(&mut self) {
        self.meta = Sidecar::default();
        self.hasher = Sha256::new();
        self.head.clear();
        if let Err(e) = self.remove_files().await {
            log::warn!("cannot remove {}: {e}", self.part.display());
        }
    }

    async fn save(&self) -> Result<(), PackError> {
        let json =
            serde_json::to_vec(&self.meta).map_err(|e| PackError::Io(io::Error::other(e)))?;
        install::write_atomic(&self.sidecar, json).await
    }

    async fn open_for_append(&self) -> Result<tokio::fs::File, PackError> {
        if let Some(parent) = self.part.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.part)
            .await?;
        file.set_len(self.meta.received).await?;
        file.seek(io::SeekFrom::Start(self.meta.received)).await?;
        Ok(file)
    }

    /// Writes the buffer, fsyncs, and only then advances `received` in the sidecar.
    async fn persist(
        &mut self,
        file: &mut tokio::fs::File,
        buf: &mut Vec<u8>,
        unsynced: &mut u64,
    ) -> Result<(), PackError> {
        if !buf.is_empty() {
            file.write_all(buf).await?;
            buf.clear();
        }
        if *unsynced == 0 {
            return Ok(());
        }
        file.flush().await?;
        file.sync_data().await?;
        self.meta.received = self.meta.received.saturating_add(*unsynced);
        *unsynced = 0;
        self.save().await
    }

    /// Verifies the complete temp and moves it into place.
    async fn finish(
        mut self,
        dest: &Path,
        expect: &Expect,
        resumed_from: u64,
    ) -> Result<Downloaded, PackError> {
        let total = self.meta.total.unwrap_or(self.meta.received);
        let on_disk = install::file_len(&self.part).await.unwrap_or(0);
        let url = self.meta.url.clone();
        let fail = |msg: String| PackError::Integrity(format!("{url}: {msg}"));
        if self.meta.received != total || on_disk != total {
            self.discard().await;
            return Err(fail(format!(
                "{on_disk} bytes on disk, {} received, length {total}",
                self.meta.received
            )));
        }
        if let Some(len) = expect.len
            && len != total
        {
            self.discard().await;
            return Err(fail(format!("length {total}, expected {len}")));
        }
        if let Some(magic) = expect.magic
            && !self.head.starts_with(magic)
        {
            self.discard().await;
            return Err(fail(format!(
                "does not start with {:?}",
                String::from_utf8_lossy(magic)
            )));
        }
        let sha256 = hex::encode(self.hasher.clone().finalize());
        if let Some(want) = &expect.sha256
            && !want.eq_ignore_ascii_case(&sha256)
        {
            self.discard().await;
            return Err(fail(format!(
                "sha256 {sha256}, expected {}",
                want.to_ascii_lowercase()
            )));
        }
        let validators = self.meta.validators();
        // First complete wins, but only when the file that won is the same file (same length and hash); anything else
        // at `dest` is replaced by the verified download.
        let kept_existing = expect.keep_existing
            && install::file_len(dest).await == Some(total)
            && same_file(dest, &sha256).await;
        if kept_existing {
            self.remove_files().await?;
        } else {
            install::commit(&self.part, dest).await?;
            install::remove_file(&self.sidecar).await?;
        }
        Ok(Downloaded {
            path: dest.to_path_buf(),
            bytes: total,
            sha256,
            url,
            validators,
            resumed_from,
            kept_existing,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// In-flight dedupe (interactive lane)
// ---------------------------------------------------------------------------------------------------------------

type SharedOutcome<T> = Shared<BoxFuture<'static, Result<T, Arc<PackError>>>>;
/// Key → (generation, shared outcome).
type FlightMap<K, T> = Arc<Mutex<HashMap<K, (u64, SharedOutcome<T>)>>>;

/// A shared-future map: concurrent requests for the same item key share one fetch. The fetch runs as its own task (so a
/// caller that goes away does not hold permits or stall the others) and leaves the map as soon as it completes, so a
/// later request always fetches afresh.
pub struct InFlight<K, T> {
    map: FlightMap<K, T>,
    next: AtomicU64,
}

impl<K, T> Default for InFlight<K, T> {
    fn default() -> Self {
        Self {
            map: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(0),
        }
    }
}

impl<K, T> InFlight<K, T>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    T: Clone + Send + Sync + 'static,
{
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Joins the fetch for `key`, or starts `make()` when none is in flight. Every caller gets the outcome; an error
    /// reaches each caller as an equivalent `PackError` ([`duplicate_error`]).
    pub async fn run<F>(&self, key: K, make: impl FnOnce() -> F) -> Result<T, PackError>
    where
        F: Future<Output = Result<T, PackError>> + Send + 'static,
    {
        let existing = self.map.lock().get(&key).map(|(_, fut)| fut.clone());
        let shared = if let Some(fut) = existing {
            fut
        } else {
            // Built outside the lock (`make` may do anything); a fetch that raced in first wins and ours is dropped
            // unpolled.
            let work = make();
            let mut map = self.map.lock();
            if let Some((_, fut)) = map.get(&key) {
                fut.clone()
            } else {
                let id = self.next.fetch_add(1, Ordering::Relaxed);
                let weak = Arc::downgrade(&self.map);
                let k = key.clone();
                let task = async move {
                    let out = work.await.map_err(Arc::new);
                    if let Some(map) = weak.upgrade() {
                        let mut map = map.lock();
                        if map.get(&k).is_some_and(|(i, _)| *i == id) {
                            map.remove(&k);
                        }
                    }
                    out
                };
                let fut: BoxFuture<'static, Result<T, Arc<PackError>>> =
                    match tokio::runtime::Handle::try_current() {
                        Ok(rt) => {
                            let handle = rt.spawn(task);
                            async move {
                                handle.await.unwrap_or_else(|e| {
                                    Err(Arc::new(PackError::Io(io::Error::other(format!(
                                        "fetch task failed: {e}"
                                    )))))
                                })
                            }
                            .boxed()
                        }
                        Err(_) => task.boxed(),
                    };
                let fut = fut.shared();
                map.insert(key, (id, fut.clone()));
                fut
            }
        };
        shared
            .await
            .map_err(|e| Arc::try_unwrap(e).unwrap_or_else(|arc| duplicate_error(&arc)))
    }

    /// Fetches in flight right now.
    #[must_use]
    pub fn len(&self) -> usize {
        self.map.lock().len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// An equivalent `PackError` for another waiter of a shared outcome: the same variant and message where the payload is
/// cloneable, otherwise a variant with the same IPC `kind` and the original message.
#[must_use]
pub fn duplicate_error(e: &PackError) -> PackError {
    use quran_core::CoreError;
    match e {
        PackError::Http { status, url } => PackError::Http {
            status: *status,
            url: url.clone(),
        },
        PackError::Network(n) => PackError::Http {
            status: n.status().map_or(0, |s| s.as_u16()),
            url: n
                .url()
                .map_or_else(|| n.to_string(), |u| format!("{u} ({n})")),
        },
        PackError::Offline => PackError::Offline,
        PackError::Timeout(m) => PackError::Timeout(m.clone()),
        PackError::Io(io_err) => PackError::Io(io::Error::new(io_err.kind(), io_err.to_string())),
        PackError::Integrity(m) => PackError::Integrity(m.clone()),
        PackError::Zip(z) => PackError::Integrity(format!("zip: {z}")),
        PackError::Core(c) => PackError::Core(match c {
            CoreError::NotFound(m) => CoreError::NotFound(m.clone()),
            CoreError::InvalidArgument(m) => CoreError::InvalidArgument(m.clone()),
            CoreError::SchemaMismatch { expected, found } => CoreError::SchemaMismatch {
                expected: *expected,
                found: *found,
            },
            CoreError::Io(io_err) => {
                CoreError::Io(io::Error::new(io_err.kind(), io_err.to_string()))
            }
            CoreError::Json(j) => return PackError::Catalog(format!("json: {j}")),
            CoreError::NotImplemented(m) => CoreError::NotImplemented(m),
            other => CoreError::Corrupt(other.to_string()),
        }),
        PackError::Catalog(m) => PackError::Catalog(m.clone()),
        PackError::NotFound(m) => PackError::NotFound(m.clone()),
        PackError::Cancelled => PackError::Cancelled,
        PackError::Conflict(m) => PackError::Conflict(m.clone()),
        PackError::Unsupported(m) => PackError::Unsupported(m.clone()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::AppError;

    use super::*;

    fn cfg() -> HttpConfig {
        let mut c = HttpConfig::new("QuranForDesktop/test");
        c.backoff = vec![Duration::from_millis(1); 3];
        c
    }

    fn plan(urls: &[&str]) -> Plan {
        let urls: Vec<String> = urls.iter().map(|s| (*s).to_owned()).collect();
        Plan::new(&urls, &cfg(), None).unwrap()
    }

    /// An interactive request past its deadline starts no further attempt or wait, and ends with the last error;
    /// a deadline still ahead changes nothing.
    #[test]
    fn plan_stops_at_the_interactive_deadline() {
        let urls = vec!["https://a.test/x".to_owned(), "https://b.test/x".to_owned()];
        let timeout = || PackError::Timeout("no response".into());

        let mut p = Plan::new(&urls, &cfg(), Some(Instant::now())).unwrap();
        // The first attempt always runs.
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(0, Failure::Retry(timeout(), None)).unwrap();
        // Out of time: not the second mirror, not a retry round.
        assert!(matches!(p.next(true), Step::Done(PackError::Timeout(_))));

        let mut p = Plan::new(
            &urls,
            &cfg(),
            Some(Instant::now() + Duration::from_secs(3600)),
        )
        .unwrap();
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(0, Failure::Retry(timeout(), None)).unwrap();
        assert!(matches!(p.next(true), Step::Try(1)));
        p.failed(1, Failure::Retry(timeout(), None)).unwrap();
        assert!(matches!(p.next(true), Step::Wait(_)));

        // A retry wait that would end past the deadline is not started.
        let mut p = Plan::new(
            &urls[..1],
            &cfg(),
            Some(Instant::now() + Duration::from_millis(500)),
        )
        .unwrap();
        p.backoff = vec![Duration::from_secs(8)];
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(0, Failure::Retry(http_err(503), None)).unwrap();
        assert!(matches!(
            p.next(true),
            Step::Done(PackError::Http { status: 503, .. })
        ));
    }

    fn http_err(status: u16) -> PackError {
        PackError::Http {
            status,
            url: "u".into(),
        }
    }

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 1000-1999/793327"),
            Some((1000, Some(793_327)))
        );
        assert_eq!(parse_content_range("bytes 0-0/*"), Some((0, None)));
        assert_eq!(parse_content_range("bytes 5-4/10"), None);
        assert_eq!(parse_content_range("bytes 5-10/10"), None);
        assert_eq!(parse_content_range("items 0-1/2"), None);
        assert_eq!(parse_content_range("bytes x-1/2"), None);
    }

    #[test]
    fn retry_after_parsing() {
        assert_eq!(parse_retry_after("7"), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after(" 0 "), Some(Duration::ZERO));
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(Duration::ZERO),
            "a date in the past means now"
        );
        let future = time::OffsetDateTime::now_utc() + time::Duration::seconds(120);
        let fmt = time::macros::format_description!(
            "[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT"
        );
        let text = future.format(fmt).unwrap();
        let d = parse_retry_after(&text).unwrap();
        assert!(
            d > Duration::from_secs(100) && d <= Duration::from_secs(121),
            "{d:?}"
        );
        assert_eq!(parse_retry_after("soon"), None);
    }

    #[test]
    fn if_range_prefers_a_strong_etag() {
        let v = Validators {
            etag: Some("\"abc\"".into()),
            last_modified: Some("Tue, 24 Dec 2024 06:33:19 GMT".into()),
        };
        assert_eq!(v.if_range(), Some("\"abc\""));
        let weak = Validators {
            etag: Some("W/\"abc\"".into()),
            ..v.clone()
        };
        assert_eq!(weak.if_range(), Some("Tue, 24 Dec 2024 06:33:19 GMT"));
        assert_eq!(Validators::default().if_range(), None);
    }

    #[test]
    fn plan_walks_mirrors_in_rounds_and_retires_dead_urls() {
        let mut p = plan(&["https://a.test/x", "https://b.test/x"]);
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(0, Failure::Dead(http_err(404))).unwrap();
        assert!(matches!(p.next(true), Step::Try(1)));
        p.failed(1, Failure::Retry(http_err(503), None)).unwrap();
        // Round 2 skips the dead mirror.
        assert!(matches!(p.next(true), Step::Wait(_)));
        assert!(matches!(p.next(true), Step::Try(1)));
        p.failed(1, Failure::Retry(http_err(503), None)).unwrap();
        assert!(matches!(p.next(true), Step::Wait(_)));
        assert!(matches!(p.next(true), Step::Try(1)));
        p.failed(1, Failure::Retry(http_err(503), None)).unwrap();
        assert!(matches!(p.next(true), Step::Wait(_)));
        assert!(matches!(p.next(true), Step::Try(1)));
        p.failed(1, Failure::Retry(http_err(502), None)).unwrap();
        match p.next(true) {
            Step::Done(PackError::Http { status: 502, .. }) => {}
            _ => panic!("4 attempts on the live mirror, then the last error"),
        }
    }

    #[test]
    fn plan_gives_up_on_all_dead_and_offline() {
        let mut p = plan(&["https://a.test/x"]);
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(0, Failure::Dead(http_err(404))).unwrap();
        assert!(matches!(
            p.next(true),
            Step::Done(PackError::Http { status: 404, .. })
        ));

        let mut p = plan(&["https://a.test/x", "https://b.test/x"]);
        assert!(matches!(p.next(false), Step::Try(0)));
        p.failed(0, Failure::Connect(PackError::Offline)).unwrap();
        assert!(matches!(p.next(false), Step::Try(1)));
        p.failed(1, Failure::Connect(PackError::Offline)).unwrap();
        assert!(matches!(p.next(false), Step::Done(PackError::Offline)));

        let mut p = plan(&["ftp://a.test/x", "not a url"]);
        assert!(matches!(p.next(true), Step::Done(PackError::Catalog(_))));
        assert!(Plan::new(&[], &cfg(), None).is_err());
    }

    #[test]
    fn plan_honours_retry_after_and_retires_long_ones() {
        let mut p = plan(&["https://a.test/x", "https://b.test/x"]);
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(
            0,
            Failure::Retry(http_err(429), Some(Duration::from_secs(3))),
        )
        .unwrap();
        assert!(matches!(p.next(true), Step::Try(1)));
        p.failed(
            1,
            Failure::Retry(http_err(503), Some(Duration::from_secs(3600))),
        )
        .unwrap();
        match p.next(true) {
            Step::Wait(d) => assert_eq!(d, Duration::from_secs(3)),
            _ => panic!("waits for Retry-After"),
        }
        assert!(matches!(p.next(true), Step::Try(0)), "b is retired");
        assert!(matches!(
            p.failed(0, Failure::Fatal(PackError::Cancelled)),
            Err(PackError::Cancelled)
        ));
    }

    #[test]
    fn plan_progress_restores_the_budget_and_prefer_reorders() {
        let mut p =
            plan(&["https://a.test/x", "https://b.test/x"]).prefer(Some("https://b.test/x"));
        assert!(
            matches!(p.next(true), Step::Try(1)),
            "the preferred mirror goes first"
        );
        // Far more rounds than the budget, because every round made progress.
        for _ in 0..10 {
            p.failed(1, Failure::Retry(http_err(500), None)).unwrap();
            assert!(matches!(p.next(true), Step::Try(0)));
            p.failed(0, Failure::Retry(http_err(500), None)).unwrap();
            assert!(matches!(p.next(true), Step::Wait(_)));
            p.progressed();
            assert!(matches!(p.next(true), Step::Try(1)));
        }
        // Without progress the budget runs out.
        for _ in 0..3 {
            p.failed(1, Failure::Retry(http_err(500), None)).unwrap();
            assert!(matches!(p.next(true), Step::Try(0)));
            p.failed(0, Failure::Retry(http_err(500), None)).unwrap();
            assert!(matches!(p.next(true), Step::Wait(_)));
            assert!(matches!(p.next(true), Step::Try(1)));
        }
        p.failed(1, Failure::Retry(http_err(500), None)).unwrap();
        assert!(matches!(p.next(true), Step::Try(0)));
        p.failed(0, Failure::Retry(http_err(500), None)).unwrap();
        assert!(matches!(
            p.next(true),
            Step::Done(PackError::Http { status: 500, .. })
        ));
    }

    #[test]
    fn duplicated_errors_keep_their_ipc_kind() {
        let cases = [
            PackError::Http {
                status: 404,
                url: "u".into(),
            },
            PackError::Offline,
            PackError::Timeout("no response".into()),
            PackError::Io(io::Error::other("disk")),
            PackError::Integrity("sha".into()),
            PackError::Zip(zip::result::ZipError::FileNotFound),
            PackError::Core(quran_core::CoreError::InvalidArgument("x".into())),
            PackError::Core(quran_core::CoreError::Corrupt("x".into())),
            PackError::Catalog("c".into()),
            PackError::NotFound("n".into()),
            PackError::Cancelled,
            PackError::Conflict("c".into()),
            PackError::Unsupported("u".into()),
        ];
        for e in cases {
            let kind = AppError::from(duplicate_error(&e)).kind();
            assert_eq!(kind, AppError::from(e).kind());
        }
    }

    #[tokio::test]
    async fn in_flight_shares_one_fetch_and_forgets_it_afterwards() {
        let flight: InFlight<u32, u32> = InFlight::new();
        let calls = Arc::new(AtomicU32::new(0));
        let gate = Arc::new(Notify::new());
        let make = |calls: Arc<AtomicU32>, gate: Arc<Notify>| {
            move || async move {
                calls.fetch_add(1, Ordering::SeqCst);
                gate.notified().await;
                Ok::<u32, PackError>(42)
            }
        };
        let a = flight.run(1, make(calls.clone(), gate.clone()));
        let b = flight.run(1, make(calls.clone(), gate.clone()));
        let opener = async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            gate.notify_waiters();
        };
        let (a, b, ()) = tokio::join!(a, b, opener);
        assert_eq!((a.unwrap(), b.unwrap()), (42, 42));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(flight.is_empty());
        let err = flight
            .run(2, || async { Err::<u32, _>(PackError::Offline) })
            .await
            .unwrap_err();
        assert!(matches!(err, PackError::Offline));
        assert!(flight.is_empty());
    }
}
