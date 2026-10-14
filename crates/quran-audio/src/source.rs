//! Audio sources.
//!
//! - [`CachingHttpSource`]: the app's [`SourceProvider`]. In order:
//!   1. a complete cached file `root/{reciter}/{sss}.mp3` (its size matches `FileKey::expected_len`, or that is unknown);
//!   2. a new cursor over a **live stream** of the same [`FileKey`] (a second play of the same surah never opens a second
//!      writer; every cursor keeps its own position);
//!   3. [`AudioError::Offline`] when the network is unavailable or not allowed;
//!   4. a new progressive download (stream-download + this module's file storage) that fills
//!      `root/{reciter}/{sss}.stream.part` while it plays.
//! - [`LocalFileSource`]: complete cached files only; everything else is [`AudioError::Offline`].
//!
//! **Promotion.** A stream's temp becomes `{sss}.mp3` only when the byte ranges written cover `[0, Content-Length)`
//! exactly ([`ByteRanges`]), so a stream that seeked past a gap and stopped never pins zero-filled holes as complete.
//! If `{sss}.mp3` already exists with that length (an explicit download finished first), the temp is deleted instead.
//! Then `StreamRegistry::end(key, Some(bytes))`. When the last cursor goes away before that, the temp is deleted and
//! `StreamRegistry::end(key, None)` is sent (a download that is already complete is promoted instead of thrown away).
//!
//! **One writer per temp.** The temp path depends on `(reciter, surah)` only, so a stream is always *retired* (promoted
//! or abandoned, its write handle closed and its temp deleted) under the path lock before a new stream of the same surah
//! may create the file; a retired stream's late writes fail instead of landing in its successor's file.
//!
//! **Reads.** stream-download drives the HTTP side (the first GET, Range requests for seeks, reconnects, back-filling
//! gaps). Cursors never read through it: they read the temp through their own handle, and only bytes this module's
//! coverage says were written. A read of bytes not written yet asks stream-download for that range (unless the
//! download is about to reach it anyway) and waits for [`PREFETCH_BYTES`] of cushion. This also avoids a quirk of
//! stream-download's own reader, which after a Range seek near the end of a file is only woken when the whole download
//! is done.
//!
//! **Liveness.** A watchdog cancels a download whose blocked reader has seen no new byte for [`STALL_TIMEOUT`], or at
//! once when the network goes away, so the decode thread is never stuck behind a dead connection; the read then fails
//! with [`io::ErrorKind::TimedOut`] / [`io::ErrorKind::NotConnected`] (never `UnexpectedEof`, which the decoder would
//! take for the end of the file). Every cursor belongs to one play ([`SourceProvider::open_for`]): when that play is
//! cancelled (a newer play, a stop), a read waiting for bytes gives up at once with [`ReadCancelled`], so a stalled
//! stream never holds decode, and with it the next play, for the stall timeout; a connect still waiting for the server
//! ends the same way ([`AudioError::Cancelled`]). A file whose length is not the one its timings were recorded against
//! is [`AudioError::FileMismatch`].
//!
//! Threads: [`SourceProvider::open`] runs on `qd-audio-ctl` only and is the one place that calls
//! `Handle::block_on`; reads run on `qd-audio-decode`; the download, the watchdog and promotion run on the tokio
//! runtime. Nothing here panics.

use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

use reqwest::Url;
use stream_download::http::reqwest_client::FetchError;
use stream_download::http::{HttpStream, HttpStreamError};
use stream_download::source::SourceStream;
use stream_download::storage::StorageProvider;
use stream_download::{Settings, StreamDownload, StreamInitializationError, StreamPhase};
use symphonia::core::io::MediaSource;

use crate::{
    AudioError, CancelToken, FileKey, OpenedSource, ReadCancelled, SourceProvider, StreamRegistry,
};

/// Network availability as seen by the pack manager (`PackManager::online() && settings.network_allowed`).
pub type OnlineFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// stream-download's prefetch, and the cushion a blocked read waits for before it resumes, so playback does not stutter
/// right behind the download.
pub const PREFETCH_BYTES: u64 = 64 * 1024;
/// A blocked read whose download has delivered nothing for this long fails the stream (the pack layer's idle-read
/// timeout).
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the watchdog looks at a stream.
const WATCHDOG_PERIOD: Duration = Duration::from_millis(200);
/// How often a blocked reader re-checks failure, the end of the download and where the download is heading.
const COVERAGE_POLL: Duration = Duration::from_millis(100);
/// A blocked read re-requests its range this often while the download is elsewhere.
const RANGE_RETRY: Duration = Duration::from_secs(1);
/// A read this close ahead of the download's write position waits for it instead of requesting a range.
const SEQUENTIAL_SLACK: u64 = 256 * 1024;
/// A temp that is still being released (delete pending on a filesystem without POSIX delete semantics) is retried for
/// this long before the new stream gives up.
const CREATE_RETRY: Duration = Duration::from_millis(1_500);

/// Rule 6: on a connect error or a 5xx from the first host, retry once on the second.
pub const DEFAULT_HOST_FALLBACKS: [(&str, &str); 1] =
    [("download.quranicaudio.com", "download.quranicaudio.org")];
/// File name suffix of a progressive stream's temp (`001.stream.part`).
pub const STREAM_PART_SUFFIX: &str = ".stream.part";

/// `root/{reciter}/{sss}.mp3`.
#[must_use]
pub fn cached_file_path(root: &Path, reciter_id: u32, surah: u16) -> PathBuf {
    root.join(reciter_id.to_string())
        .join(format!("{surah:03}.mp3"))
}

/// `root/{reciter}/{sss}.stream.part`.
#[must_use]
pub fn stream_part_path(root: &Path, reciter_id: u32, surah: u16) -> PathBuf {
    root.join(reciter_id.to_string())
        .join(format!("{surah:03}{STREAM_PART_SUFFIX}"))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn describe(key: &FileKey) -> String {
    format!("reciter {} surah {:03}", key.reciter_id, key.surah)
}

// ---------------------------------------------------------------------------------------------------------------------
// Byte coverage.

/// A set of byte ranges `[start, end)`, kept sorted, disjoint and merged. Tracks exactly what a stream wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ByteRanges {
    ranges: Vec<(u64, u64)>,
}

impl ByteRanges {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `[start, end)`; an empty range is ignored.
    pub fn insert(&mut self, start: u64, end: u64) {
        if end <= start {
            return;
        }
        // Every range that overlaps or touches [start, end) merges into it: ranges[first..last]. The ranges are sorted
        // and disjoint, so first ≤ last ≤ len (clamped anyway: this runs on the download task).
        let last = self
            .ranges
            .partition_point(|&(s, _)| s <= end)
            .min(self.ranges.len());
        let first = self.ranges.partition_point(|&(_, e)| e < start).min(last);
        let (mut lo, mut hi) = (start, end);
        for (s, e) in self.ranges.drain(first..last) {
            lo = lo.min(s);
            hi = hi.max(e);
        }
        self.ranges.insert(first, (lo, hi));
    }

    /// Whether `[start, end)` lies inside one written range (an empty range is always covered).
    #[must_use]
    pub fn covers(&self, start: u64, end: u64) -> bool {
        if end <= start {
            return true;
        }
        let i = self.ranges.partition_point(|&(_, e)| e <= start);
        self.ranges
            .get(i)
            .is_some_and(|&(s, e)| s <= start && end <= e)
    }

    /// The end of the range that contains `pos`, if `pos` is covered.
    #[must_use]
    pub fn run_end(&self, pos: u64) -> Option<u64> {
        let i = self.ranges.partition_point(|&(_, e)| e <= pos);
        self.ranges
            .get(i)
            .filter(|&&(s, _)| s <= pos)
            .map(|&(_, e)| e)
    }

    /// Total bytes covered.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.ranges.iter().map(|&(s, e)| e - s).sum()
    }

    /// The ranges, sorted.
    #[must_use]
    pub fn ranges(&self) -> &[(u64, u64)] {
        &self.ranges
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The caching HTTP source.

/// Opens `root/{reciter_id}/{surah:03}.mp3` when complete, else reuses a live stream for the same key, else (online)
/// starts a progressive download that fills the cache while it plays. See the module docs.
pub struct CachingHttpSource {
    inner: Arc<SourceInner>,
}

struct SourceInner {
    root: PathBuf,
    rt: tokio::runtime::Handle,
    client: reqwest::Client,
    registry: Arc<dyn StreamRegistry>,
    online: OnlineFn,
    /// `(from, to)` authorities (`host` or `host:port`), matched case-insensitively.
    fallbacks: Vec<(String, String)>,
    prefetch_bytes: u64,
    stall_timeout: Duration,
    /// Serialises `open` (only `qd-audio-ctl` calls it; tests may not).
    open_lock: Mutex<()>,
    /// The stream that owns each `(reciter, surah)` temp path.
    slots: Mutex<HashMap<(u32, u16), Slot>>,
    /// Serialises every rename/delete of a temp (promotion, abandonment); taken after `slots`, never before.
    path_lock: Arc<Mutex<()>>,
}

struct Slot {
    key: FileKey,
    shared: Arc<StreamShared>,
    live: Weak<LiveStream>,
}

impl CachingHttpSource {
    #[must_use]
    pub fn new(
        root: PathBuf,
        rt: tokio::runtime::Handle,
        client: reqwest::Client,
        registry: Arc<dyn StreamRegistry>,
        online: OnlineFn,
    ) -> Self {
        Self {
            inner: Arc::new(SourceInner {
                root,
                rt,
                client,
                registry,
                online,
                fallbacks: DEFAULT_HOST_FALLBACKS
                    .iter()
                    .map(|&(from, to)| (from.to_owned(), to.to_owned()))
                    .collect(),
                prefetch_bytes: PREFETCH_BYTES,
                stall_timeout: STALL_TIMEOUT,
                open_lock: Mutex::new(()),
                slots: Mutex::new(HashMap::new()),
                path_lock: Arc::new(Mutex::new(())),
            }),
        }
    }

    /// Replaces the host fallbacks: each `(from, to)` is an authority, `host` or `host:port`; a pattern without a port
    /// matches any port and keeps it.
    #[must_use]
    pub fn with_host_fallbacks(self, fallbacks: Vec<(String, String)>) -> Self {
        self.reconfigure(|inner| inner.fallbacks = fallbacks)
    }

    /// Bytes to download before the first read proceeds ([`PREFETCH_BYTES`]).
    #[must_use]
    pub fn with_prefetch_bytes(self, bytes: u64) -> Self {
        self.reconfigure(|inner| inner.prefetch_bytes = bytes)
    }

    /// How long a blocked read may wait without a new byte before the stream fails ([`STALL_TIMEOUT`]).
    #[must_use]
    pub fn with_stall_timeout(self, timeout: Duration) -> Self {
        self.reconfigure(|inner| inner.stall_timeout = timeout.max(WATCHDOG_PERIOD))
    }

    /// Builder helper: only valid before the source is shared (it always is, since builders take `self`).
    fn reconfigure(self, f: impl FnOnce(&mut SourceInner)) -> Self {
        match Arc::try_unwrap(self.inner) {
            Ok(mut inner) => {
                f(&mut inner);
                Self {
                    inner: Arc::new(inner),
                }
            }
            // Unreachable in practice (no clone of `inner` escapes before `open`); keep the source unchanged.
            Err(inner) => Self { inner },
        }
    }

    /// The cache root (`packs/audio`).
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    /// Number of streams currently writing a temp (diagnostics and tests).
    #[must_use]
    pub fn live_streams(&self) -> usize {
        lock(&self.inner.slots)
            .values()
            .filter(|s| s.live.strong_count() > 0 && s.shared.phase() == Phase::Streaming)
            .count()
    }
}

impl fmt::Debug for CachingHttpSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CachingHttpSource")
            .field("root", &self.inner.root)
            .field("fallbacks", &self.inner.fallbacks)
            .field("prefetch_bytes", &self.inner.prefetch_bytes)
            .field("stall_timeout", &self.inner.stall_timeout)
            .finish_non_exhaustive()
    }
}

impl SourceProvider for CachingHttpSource {
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError> {
        self.open_for(key, &CancelToken::new())
    }

    /// See the module docs; `cancel` ends a connect that waits for the server, and the reads of the stream's cursor
    /// that wait for bytes ([`ReadCancelled`]).
    fn open_for(&self, key: &FileKey, cancel: &CancelToken) -> Result<OpenedSource, AudioError> {
        debug_assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "SourceProvider::open runs on qd-audio-ctl only, never in async code"
        );
        // Release builds: `Handle::block_on` inside a runtime would panic, and a panic aborts.
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(AudioError::Source(
                "audio source opened from async code (control thread only)".to_owned(),
            ));
        }
        let inner = &self.inner;
        let _serial = lock(&inner.open_lock);
        if let Some(local) = open_local(&inner.root, key) {
            return Ok(local);
        }
        if let Some(cursor) = inner.reuse(key, cancel) {
            log::debug!("audio source: {} reuses its live stream", describe(key));
            return Ok(cursor);
        }
        if !(inner.online)() {
            return Err(AudioError::Offline(format!(
                "{} is not cached and the network is unavailable",
                describe(key)
            )));
        }
        SourceInner::start_stream(inner, key, cancel)
    }
}

/// A complete cached file for `key`, if there is one.
fn open_local(root: &Path, key: &FileKey) -> Option<OpenedSource> {
    let path = cached_file_path(root, key.reciter_id, key.surah);
    match fs::metadata(&path) {
        Ok(meta) if meta.is_file() => {
            let len = meta.len();
            if len == 0 || key.expected_len.is_some_and(|expected| expected != len) {
                log::debug!(
                    "audio source: cached {} has {len} bytes, expected {:?}; not used",
                    describe(key),
                    key.expected_len
                );
                return None;
            }
            match File::open(&path) {
                Ok(file) => Some(OpenedSource::complete(Box::new(file))),
                Err(e) => {
                    log::warn!(
                        "audio source: cached {} cannot be opened: {e}",
                        describe(key)
                    );
                    None
                }
            }
        }
        Ok(_) => None,
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("audio source: cached {} is unreadable: {e}", describe(key));
            None
        }
    }
}

impl SourceInner {
    /// A new cursor over a live, healthy stream of exactly `key`, for the play of `cancel`.
    fn reuse(&self, key: &FileKey, cancel: &CancelToken) -> Option<OpenedSource> {
        let slots = lock(&self.slots);
        let slot = slots.get(&(key.reciter_id, key.surah))?;
        if slot.key != *key || !slot.shared.reusable() {
            return None;
        }
        let live = slot.live.upgrade()?;
        Some(StreamCursor::opened(live, cancel.clone()))
    }

    /// Retires whatever owns the temp of `key`'s surah, then starts a new progressive download. A play cancelled while
    /// the server has not answered yet ends the connect at once ([`AudioError::Cancelled`]).
    fn start_stream(
        this: &Arc<Self>,
        key: &FileKey,
        cancel: &CancelToken,
    ) -> Result<OpenedSource, AudioError> {
        let slot_key = (key.reciter_id, key.surah);
        let retired = lock(&this.slots).remove(&slot_key);
        if let Some(old) = retired {
            old.shared.retire();
        }
        // A retired stream may just have been promoted to exactly this file.
        if let Some(local) = open_local(&this.root, key) {
            return Ok(local);
        }
        let url = Url::parse(&key.url).map_err(|e| {
            AudioError::Source(format!("{}: invalid URL {:?}: {e}", describe(key), key.url))
        })?;

        let shared = Arc::new(StreamShared::new(this, key));
        let started = this.rt.block_on(async {
            tokio::select! {
                started = Self::connect(this, url, key, &shared) => started,
                () = cancel.cancelled() => {
                    log::debug!("audio source: {}: the play ended before the server answered", describe(key));
                    Err(AudioError::Cancelled)
                }
            }
        });
        let download = match started {
            Ok(download) => download,
            Err(e) => {
                // Deletes a temp the storage may have created and ends a registered stream.
                shared.abandon();
                return Err(e);
            }
        };
        let token = download.cancellation_token();
        shared.set_cancel(Box::new(move || token.cancel()));
        spawn_watchdog(this, &shared, download.handle());
        let file = match shared.take_reader() {
            Some(file) => file,
            None => {
                shared.abandon();
                return Err(AudioError::Source(format!(
                    "{}: the stream cache file has no read handle",
                    describe(key)
                )));
            }
        };

        let live = Arc::new(LiveStream {
            shared: Arc::clone(&shared),
            file: Mutex::new(Some(file)),
            download: Arc::new(Mutex::new(Some(download))),
            seeks: Arc::new(Mutex::new(SeekState::default())),
            source: Arc::downgrade(this),
        });
        lock(&this.slots).insert(
            slot_key,
            Slot {
                key: key.clone(),
                shared,
                live: Arc::downgrade(&live),
            },
        );
        log::info!("audio source: streaming {} into the cache", describe(key));
        Ok(StreamCursor::opened(live, cancel.clone()))
    }

    /// The HTTP request (with the host fallback), the length check and the download task.
    async fn connect(
        this: &Arc<Self>,
        url: Url,
        key: &FileKey,
        shared: &Arc<StreamShared>,
    ) -> Result<StreamDownload<PartStorage>, AudioError> {
        let stream = match HttpStream::new(this.client.clone(), url.clone()).await {
            Ok(stream) => stream,
            Err(e) => match fallback_url(&this.fallbacks, &url).filter(|_| retryable(&e)) {
                Some(alt) => {
                    log::info!(
                        "audio source: {} on {}; retrying on {}",
                        error_text(&e),
                        authority(&url).unwrap_or_default(),
                        authority(&alt).unwrap_or_default()
                    );
                    HttpStream::new(this.client.clone(), alt.clone())
                        .await
                        .map_err(|e| stream_error(key, &alt, &e))?
                }
                None => return Err(stream_error(key, &url, &e)),
            },
        };
        let len = stream.content_length();
        if let (Some(expected), Some(got)) = (key.expected_len, len)
            && expected != got
        {
            log::warn!(
                "audio source: {} is {got} bytes upstream, the timings expect {expected}",
                describe(key)
            );
            return Err(AudioError::FileMismatch(format!(
                "{} is {got} bytes upstream, the timings expect {expected}",
                describe(key)
            )));
        }
        if len.is_none() {
            log::info!(
                "audio source: {} has no Content-Length; it streams but is never cached",
                describe(key)
            );
        }
        shared.set_len(len);
        // The temp is created by the storage below: announce the writer first, so its end always follows its begin.
        shared.begin();

        let on_complete = Arc::clone(shared);
        let rt = this.rt.clone();
        let settings = Settings::<HttpStream<reqwest::Client>>::default()
            .prefetch_bytes(this.prefetch_bytes)
            .on_progress(move |_stream, state, _cancel| {
                if matches!(state.phase, StreamPhase::Complete) {
                    let shared = Arc::clone(&on_complete);
                    // Promotion fsyncs and renames: never on a runtime worker.
                    drop(rt.spawn_blocking(move || shared.promote()));
                }
            });
        let storage = PartStorage {
            shared: Arc::clone(shared),
        };
        StreamDownload::from_stream(stream, storage, settings)
            .await
            .map_err(|e| init_error(key, &e))
    }
}

/// The fallback URL of `url`, if its authority has one.
fn fallback_url(fallbacks: &[(String, String)], url: &Url) -> Option<Url> {
    let host = url.host_str()?;
    let port = url.port();
    fallbacks.iter().find_map(|(from, to)| {
        let (from_host, from_port) = split_authority(from);
        let host_matches = from_host.eq_ignore_ascii_case(host);
        let port_matches = from_port.is_none() || from_port == port;
        if !(host_matches && port_matches) {
            return None;
        }
        let (to_host, to_port) = split_authority(to);
        let mut alt = url.clone();
        alt.set_host(Some(to_host)).ok()?;
        if to_port.is_some() || from_port.is_some() {
            alt.set_port(to_port).ok()?;
        }
        (alt != *url).then_some(alt)
    })
}

/// `host[:port]` → `(host, port)`.
fn split_authority(s: &str) -> (&str, Option<u16>) {
    match s.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => match port.parse::<u16>() {
            Ok(p) => (host, Some(p)),
            Err(_) => (s, None),
        },
        _ => (s, None),
    }
}

fn authority(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_owned(),
    })
}

/// A connect error or a 5xx moves to the fallback host; anything else (a 404, a TLS failure) does not.
fn retryable(e: &HttpStreamError<reqwest::Client>) -> bool {
    match e {
        HttpStreamError::FetchFailure(e) => e.is_connect() || e.is_timeout(),
        HttpStreamError::ResponseFailure(e) => response_status(e).is_some_and(|s| s >= 500),
    }
}

fn response_status(e: &FetchError) -> Option<u16> {
    Some(e.response().status().as_u16())
}

fn error_text(e: &HttpStreamError<reqwest::Client>) -> String {
    match e {
        HttpStreamError::FetchFailure(e) => error_chain(e),
        HttpStreamError::ResponseFailure(e) => match response_status(e) {
            Some(status) => format!("HTTP {status}"),
            None => e.to_string(),
        },
    }
}

/// `e` and its sources (reqwest's own message hides the cause: "error sending request for url (…)").
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

/// A failed request: unreachable hosts are `Offline` (so an uncached basmala is skipped), everything else is `Source`
/// (`network` over IPC).
fn stream_error(key: &FileKey, url: &Url, e: &HttpStreamError<reqwest::Client>) -> AudioError {
    let what = format!(
        "{} from {}",
        describe(key),
        authority(url).unwrap_or_else(|| url.to_string())
    );
    match e {
        HttpStreamError::FetchFailure(err) if err.is_connect() => {
            AudioError::Offline(format!("{what}: cannot connect: {}", error_chain(err)))
        }
        _ => AudioError::Source(format!("{what}: {}", error_text(e))),
    }
}

fn init_error(
    key: &FileKey,
    e: &StreamInitializationError<HttpStream<reqwest::Client>>,
) -> AudioError {
    match e {
        StreamInitializationError::StorageCreationFailure(io) => AudioError::Source(format!(
            "{}: cannot create the stream cache file: {io}",
            describe(key)
        )),
        StreamInitializationError::StreamCreationFailure(e) => {
            AudioError::Source(format!("{}: {}", describe(key), error_text(e)))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// One stream's shared state.

/// Where a stream's temp stands. Every transition away from `Streaming` happens under the path lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Streaming,
    Promoted,
    Abandoned,
}

/// Why a stream was stopped (the reader's error).
#[derive(Clone, Debug)]
struct Failure {
    kind: io::ErrorKind,
    message: String,
}

/// State shared by the download task (through [`PartWriter`]), the watchdog, the cursors and promotion. It does not
/// keep the source alive.
struct StreamShared {
    key: FileKey,
    part: PathBuf,
    dest: PathBuf,
    rt: tokio::runtime::Handle,
    registry: Arc<dyn StreamRegistry>,
    online: OnlineFn,
    path_lock: Arc<Mutex<()>>,
    /// HTTP `Content-Length`.
    len: OnceLock<Option<u64>>,
    /// The temp's write handle; `None` before the storage exists and once the stream is retired.
    file: Mutex<Option<File>>,
    /// The cursors' read handle, handed from the storage to the [`LiveStream`].
    reader: Mutex<Option<File>>,
    coverage: Mutex<ByteRanges>,
    /// Signalled on every write, on failure and when the download task ends.
    progress: Condvar,
    /// Where the download task writes next (a reader just ahead of it needs no Range request).
    writer_pos: AtomicU64,
    /// The download task ended (complete, cancelled or failed).
    finished: AtomicBool,
    permille: Arc<AtomicU32>,
    phase: Mutex<Phase>,
    failure: Mutex<Option<Failure>>,
    /// A reader is blocked on bytes since then.
    waiting_since: Mutex<Option<Instant>>,
    last_progress: Mutex<Instant>,
    /// Cancels the download task (set once it exists).
    cancel: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    began: AtomicBool,
    ended: AtomicBool,
}

impl StreamShared {
    fn new(inner: &SourceInner, key: &FileKey) -> Self {
        Self {
            key: key.clone(),
            part: stream_part_path(&inner.root, key.reciter_id, key.surah),
            dest: cached_file_path(&inner.root, key.reciter_id, key.surah),
            rt: inner.rt.clone(),
            registry: Arc::clone(&inner.registry),
            online: Arc::clone(&inner.online),
            path_lock: Arc::clone(&inner.path_lock),
            len: OnceLock::new(),
            file: Mutex::new(None),
            reader: Mutex::new(None),
            coverage: Mutex::new(ByteRanges::new()),
            progress: Condvar::new(),
            writer_pos: AtomicU64::new(0),
            finished: AtomicBool::new(false),
            permille: Arc::new(AtomicU32::new(0)),
            phase: Mutex::new(Phase::Streaming),
            failure: Mutex::new(None),
            waiting_since: Mutex::new(None),
            last_progress: Mutex::new(Instant::now()),
            cancel: Mutex::new(None),
            began: AtomicBool::new(false),
            ended: AtomicBool::new(false),
        }
    }

    fn take_reader(&self) -> Option<File> {
        lock(&self.reader).take()
    }

    /// The download task ended; readers re-check what they wait for.
    fn mark_finished(&self) {
        self.finished.store(true, Ordering::Release);
        self.notify();
    }

    fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }

    /// Wakes every waiting reader (taking the coverage lock, so a reader between its check and its wait cannot miss it).
    fn notify(&self) {
        drop(lock(&self.coverage));
        self.progress.notify_all();
    }

    /// The end of the written run that contains `pos`.
    fn run_end(&self, pos: u64) -> Option<u64> {
        lock(&self.coverage).run_end(pos)
    }

    fn len(&self) -> Option<u64> {
        self.len.get().copied().flatten()
    }

    fn set_len(&self, len: Option<u64>) {
        if self.len.set(len).is_err() {
            log::debug!("audio source: stream length set twice");
        }
    }

    fn set_cancel(&self, cancel: Box<dyn Fn() + Send + Sync>) {
        *lock(&self.cancel) = Some(cancel);
        // A stream retired while it was being set up cancels its task now.
        if self.phase() != Phase::Streaming || self.failed().is_some() {
            self.cancel_download();
        }
    }

    fn cancel_download(&self) {
        if let Some(cancel) = lock(&self.cancel).as_ref() {
            cancel();
        }
    }

    fn phase(&self) -> Phase {
        *lock(&self.phase)
    }

    fn failed(&self) -> Option<Failure> {
        lock(&self.failure).clone()
    }

    /// Still downloading, or done, and never failed: new cursors may share it.
    fn reusable(&self) -> bool {
        self.phase() == Phase::Streaming && self.failed().is_none()
    }

    /// Every byte of a known length is written.
    fn is_complete(&self) -> bool {
        self.len()
            .is_some_and(|len| len > 0 && lock(&self.coverage).covers(0, len))
    }

    fn covers(&self, start: u64, end: u64) -> bool {
        lock(&self.coverage).covers(start, end)
    }

    /// The writer wrote `[start, end)`.
    fn on_written(&self, start: u64, end: u64) {
        let covered = {
            let mut coverage = lock(&self.coverage);
            coverage.insert(start, end);
            coverage.total()
        };
        self.writer_pos.store(end, Ordering::Release);
        if let Some(len) = self.len().filter(|&len| len > 0) {
            let permille = covered.saturating_mul(1000) / len;
            self.permille.store(
                u32::try_from(permille.min(1000)).unwrap_or(1000),
                Ordering::Release,
            );
        }
        *lock(&self.last_progress) = Instant::now();
        self.progress.notify_all();
    }

    /// Stops the download with `failure` (the watchdog, or a failed read); readers wake up and fail.
    fn fail(&self, kind: io::ErrorKind, message: String) {
        {
            let mut failure = lock(&self.failure);
            if failure.is_some() {
                return;
            }
            log::warn!("audio source: {}: {message}", describe(&self.key));
            *failure = Some(Failure { kind, message });
        }
        self.cancel_download();
        self.notify();
    }

    /// Announces the writer (`StreamRegistry::begin`), once.
    fn begin(&self) {
        if !self.began.swap(true, Ordering::AcqRel) {
            self.registry.begin(&self.key);
        }
    }

    /// `StreamRegistry::end`, once per begun stream, off the calling thread (the decode thread may be the caller, and
    /// the registry may write to SQLite).
    fn end(&self, promoted: Option<u64>) {
        if !self.began.load(Ordering::Acquire) || self.ended.swap(true, Ordering::AcqRel) {
            return;
        }
        let registry = Arc::clone(&self.registry);
        let key = self.key.clone();
        drop(self.rt.spawn_blocking(move || registry.end(&key, promoted)));
    }

    /// Closes the temp's write handle: later writes of the download task fail instead of landing in a successor's
    /// file.
    fn close_writer(&self) -> Option<File> {
        lock(&self.file).take()
    }

    /// Retires a stream that lost its slot: a complete download is promoted (blocking: control thread or blocking
    /// pool), anything else abandoned.
    fn retire(&self) {
        if self.is_complete() {
            self.promote();
        } else {
            self.abandon();
        }
    }

    /// Stops the download, deletes the temp and ends the stream (`None`). A no-op once promoted or abandoned.
    fn abandon(&self) {
        {
            let _paths = lock(&self.path_lock);
            {
                let mut phase = lock(&self.phase);
                if *phase != Phase::Streaming {
                    return;
                }
                *phase = Phase::Abandoned;
            }
            drop(self.close_writer());
            self.cancel_download();
            remove_temp(&self.part, &self.key);
        }
        self.notify();
        log::debug!("audio source: {} abandoned", describe(&self.key));
        self.end(None);
    }

    /// Promotes a complete temp to `{sss}.mp3` (or deletes it when an explicit download already put a file of the
    /// same length there) and ends the stream with its length. Blocking; idempotent.
    fn promote(&self) {
        let Some(len) = self.len().filter(|&len| len > 0) else {
            return;
        };
        if !self.covers(0, len) {
            log::warn!(
                "audio source: {} finished without covering [0, {len}); not cached",
                describe(&self.key)
            );
            return;
        }
        // Durable before it is renamed into place (outside the path lock: fsync can be slow).
        if let Some(file) = lock(&self.file).as_ref()
            && let Err(e) = file.sync_data()
        {
            log::warn!("audio source: {}: fsync failed: {e}", describe(&self.key));
            return;
        }
        let outcome = {
            let _paths = lock(&self.path_lock);
            let mut phase = lock(&self.phase);
            if *phase != Phase::Streaming {
                return;
            }
            drop(self.close_writer());
            let outcome = match fs::metadata(&self.dest) {
                Ok(meta) if meta.is_file() && meta.len() == len => {
                    // An explicit download finished first: keep its file, drop ours.
                    remove_temp(&self.part, &self.key);
                    Ok(false)
                }
                _ => fs::rename(&self.part, &self.dest).map(|()| true),
            };
            match &outcome {
                Ok(_) => *phase = Phase::Promoted,
                Err(_) => {
                    *phase = Phase::Abandoned;
                    remove_temp(&self.part, &self.key);
                }
            }
            outcome
        };
        match outcome {
            Ok(renamed) => {
                self.permille.store(1000, Ordering::Release);
                log::info!(
                    "audio source: {} cached ({len} bytes{})",
                    describe(&self.key),
                    if renamed {
                        ""
                    } else {
                        ", an explicit download was first"
                    }
                );
                self.end(Some(len));
            }
            Err(e) => {
                log::warn!(
                    "audio source: {}: cannot move the stream into the cache: {e}",
                    describe(&self.key)
                );
                self.end(None);
            }
        }
        self.notify();
    }

    /// Marks a reader as blocked on bytes (for the watchdog) until the guard drops.
    fn waiting(&self) -> WaitGuard<'_> {
        let mut since = lock(&self.waiting_since);
        if since.is_none() {
            *since = Some(Instant::now());
        }
        WaitGuard { shared: self }
    }

    /// Waits (at most `timeout`) until `[start, end)` is written; checked and waited on under one lock, so no write is
    /// missed. Returns whether it is covered.
    fn wait_covered(&self, start: u64, end: u64, timeout: Duration) -> bool {
        let coverage = lock(&self.coverage);
        if coverage.covers(start, end) {
            return true;
        }
        let coverage = self
            .progress
            .wait_timeout(coverage, timeout)
            .map_or_else(|e| e.into_inner().0, |(g, _)| g);
        coverage.covers(start, end)
    }
}

fn remove_temp(path: &Path, key: &FileKey) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "audio source: {}: cannot delete the stream temp: {e}",
            describe(key)
        ),
    }
}

struct WaitGuard<'a> {
    shared: &'a StreamShared,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.shared.waiting_since) = None;
    }
}

/// Cancels a stream whose blocked reader starves ([`STALL_TIMEOUT`], or at once when the network goes away), and
/// marks a download that ended without covering the file as failed. Holds the stream weakly.
fn spawn_watchdog(
    inner: &SourceInner,
    shared: &Arc<StreamShared>,
    handle: stream_download::StreamHandle,
) {
    let weak = Arc::downgrade(shared);
    let stall = inner.stall_timeout;
    drop(inner.rt.spawn(async move {
        let finished = handle.wait_for_completion();
        tokio::pin!(finished);
        let mut done = false;
        loop {
            if !done {
                tokio::select! {
                    () = &mut finished => done = true,
                    () = tokio::time::sleep(WATCHDOG_PERIOD) => {}
                }
            } else {
                tokio::time::sleep(WATCHDOG_PERIOD).await;
            }
            let Some(shared) = weak.upgrade() else {
                return;
            };
            if done {
                shared.mark_finished();
            }
            if shared.phase() != Phase::Streaming || shared.failed().is_some() {
                return;
            }
            if done {
                if !shared.is_complete() && shared.len().is_some() {
                    shared.fail(
                        io::ErrorKind::Other,
                        "the download ended before the file was complete".to_owned(),
                    );
                }
                return;
            }
            let Some(since) = *lock(&shared.waiting_since) else {
                continue;
            };
            if !(shared.online)() {
                shared.fail(
                    io::ErrorKind::NotConnected,
                    "the network became unavailable while streaming".to_owned(),
                );
                return;
            }
            let quiet = since.max(*lock(&shared.last_progress)).elapsed();
            if quiet >= stall {
                shared.fail(
                    io::ErrorKind::TimedOut,
                    format!("no data for {} s; the stream is stalled", quiet.as_secs()),
                );
                return;
            }
        }
    }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage: the temp file, written through a handle the stream can revoke.

/// stream-download storage over `{sss}.stream.part`: pre-sized to `Content-Length` and written through [`PartWriter`]
/// (which records coverage). stream-download's own reader is an empty dummy: cursors read through their own handle,
/// gated by this module's coverage, never through stream-download's position notifications (which, after a Range
/// seek, can hold a reader until the whole download ends).
struct PartStorage {
    shared: Arc<StreamShared>,
}

impl StorageProvider for PartStorage {
    type Reader = io::Cursor<Vec<u8>>;
    type Writer = PartWriter;

    fn into_reader_writer(
        self,
        content_length: Option<u64>,
    ) -> io::Result<(io::Cursor<Vec<u8>>, PartWriter)> {
        let shared = self.shared;
        if let Some(dir) = shared.part.parent() {
            fs::create_dir_all(dir)?;
        }
        let writer = create_temp(&shared.part)?;
        if let Some(len) = content_length {
            // Sparse pre-allocation, so writes after a Range seek land at their offsets.
            writer.set_len(len)?;
        }
        // An independent handle (own file pointer) for the cursors; unbuffered, since a read-ahead could reach bytes
        // that are not written yet.
        let reader = File::open(&shared.part)?;
        {
            let _paths = lock(&shared.path_lock);
            if shared.phase() != Phase::Streaming {
                // Retired while connecting: do not resurrect its temp.
                drop(writer);
                drop(reader);
                remove_temp(&shared.part, &shared.key);
                return Err(io::Error::other("the stream was retired"));
            }
            *lock(&shared.file) = Some(writer);
            *lock(&shared.reader) = Some(reader);
        }
        Ok((io::Cursor::new(Vec::new()), PartWriter { shared, pos: 0 }))
    }
}

/// Creates (truncating) the temp, retrying briefly while a retired stream's handles still pin it (delete pending on a
/// filesystem without POSIX delete semantics).
fn create_temp(path: &Path) -> io::Result<File> {
    let started = Instant::now();
    loop {
        match OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
        {
            Ok(file) => return Ok(file),
            Err(e)
                if e.kind() == io::ErrorKind::PermissionDenied
                    && started.elapsed() < CREATE_RETRY =>
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }
}

/// The download task's writer: positioned writes into the temp that record coverage. Fails once the stream is retired.
struct PartWriter {
    shared: Arc<StreamShared>,
    pos: u64,
}

fn retired() -> io::Error {
    io::Error::other("the stream was retired")
}

impl Write for PartWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = {
            let mut file = lock(&self.shared.file);
            let file = file.as_mut().ok_or_else(retired)?;
            file.write(buf)?
        };
        let start = self.pos;
        self.pos = start.saturating_add(written as u64);
        self.shared.on_written(start, self.pos);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for PartWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let mut file = lock(&self.shared.file);
        let file = file.as_mut().ok_or_else(retired)?;
        self.pos = file.seek(pos)?;
        self.shared.writer_pos.store(self.pos, Ordering::Release);
        Ok(self.pos)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Live streams and cursors.

/// One progressive download and the cursors reading it. Dropped with its last cursor: a complete download is then
/// promoted, anything else abandoned.
struct LiveStream {
    shared: Arc<StreamShared>,
    /// The cursors' read handle on the temp (it survives the rename into the cache). `None` once dropping.
    file: Mutex<Option<File>>,
    /// The download driver. Only Range requests go through it (`StreamDownload::seek`, on the blocking pool: it waits
    /// for stream-download's own position notification). Shared with an in-flight request, which may outlive the
    /// stream for a moment (until the cancelled task releases it).
    download: Arc<Mutex<Option<StreamDownload<PartStorage>>>>,
    seeks: Arc<Mutex<SeekState>>,
    source: Weak<SourceInner>,
}

/// Range requests are coalesced: one in flight, the latest target next.
#[derive(Default)]
struct SeekState {
    in_flight: bool,
    next: Option<u64>,
}

impl LiveStream {
    /// Asks the download to fetch from `pos` (a Range request when `pos` is not downloaded), without blocking.
    fn request_range(&self, pos: u64) {
        {
            let mut seeks = lock(&self.seeks);
            if seeks.in_flight {
                seeks.next = Some(pos);
                return;
            }
            seeks.in_flight = true;
        }
        let download = Arc::clone(&self.download);
        let seeks = Arc::clone(&self.seeks);
        let key = self.shared.key.clone();
        drop(self.shared.rt.spawn_blocking(move || {
            let mut pos = pos;
            loop {
                if let Some(download) = lock(&download).as_mut()
                    && let Err(e) = download.seek(SeekFrom::Start(pos))
                {
                    log::debug!(
                        "audio source: {}: range request at {pos}: {e}",
                        describe(&key)
                    );
                }
                let mut state = lock(&seeks);
                match state.next.take() {
                    Some(next) => pos = next,
                    None => {
                        state.in_flight = false;
                        return;
                    }
                }
            }
        }));
    }
}

impl Drop for LiveStream {
    fn drop(&mut self) {
        // Our read handle goes first, so the temp can be deleted or renamed cleanly.
        drop(
            self.file
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
        if self.shared.is_complete() {
            let shared = Arc::clone(&self.shared);
            drop(self.shared.rt.spawn_blocking(move || shared.promote()));
        } else {
            // Cancels the task, which also releases an in-flight Range request (and with it the download driver).
            self.shared.abandon();
        }
        if let Some(source) = self.source.upgrade() {
            let mut slots = lock(&source.slots);
            let slot_key = (self.shared.key.reciter_id, self.shared.key.surah);
            if slots
                .get(&slot_key)
                .is_some_and(|slot| Arc::ptr_eq(&slot.shared, &self.shared))
            {
                slots.remove(&slot_key);
            }
        }
    }
}

/// One reader of a live stream, with its own position. Reads return only bytes the stream wrote; a read of bytes not
/// written yet asks for them (unless the download is already heading there) and waits, until its play is cancelled.
struct StreamCursor {
    live: Arc<LiveStream>,
    pos: u64,
    /// The play this cursor reads for: once it is cancelled (a newer play, a stop), a read waiting for bytes gives up
    /// ([`ReadCancelled`]) instead of holding decode until the stall timeout. The stream itself goes on for other
    /// cursors (a replay of the same surah reuses it).
    cancel: CancelToken,
}

/// What a blocked read found.
enum Ready {
    /// Bytes are available at the position.
    Bytes,
    /// The end of a stream of unknown length.
    Eof,
}

impl StreamCursor {
    fn opened(live: Arc<LiveStream>, cancel: CancelToken) -> OpenedSource {
        let buffered = Arc::clone(&live.shared.permille);
        OpenedSource {
            source: Box::new(Self {
                live,
                pos: 0,
                cancel,
            }),
            buffered_permille: buffered,
        }
    }

    fn read_at(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let shared = &self.live.shared;
        if shared.len().is_some_and(|len| self.pos >= len) {
            return Ok(0);
        }
        if let Some(f) = shared.failed() {
            return Err(io::Error::new(f.kind, f.message));
        }
        if !shared.covers(self.pos, self.pos.saturating_add(1))
            && let Ready::Eof = self.wait_for_bytes(buf.len() as u64)?
        {
            return Ok(0);
        }
        let Some(run_end) = shared.run_end(self.pos) else {
            return Err(io::Error::other(format!(
                "{}: no bytes at {}",
                describe(&shared.key),
                self.pos
            )));
        };
        let n = usize::try_from(run_end - self.pos)
            .unwrap_or(usize::MAX)
            .min(buf.len());
        let Some(dest) = buf.get_mut(..n) else {
            return Ok(0);
        };
        let got = {
            let mut file = lock(&self.live.file);
            let file = file
                .as_mut()
                .ok_or_else(|| io::Error::other("the stream is closed"))?;
            file.seek(SeekFrom::Start(self.pos))?;
            file.read(dest)?
        };
        if got == 0 {
            return Err(io::Error::other(format!(
                "{}: the cache file ends before byte {}",
                describe(&shared.key),
                self.pos
            )));
        }
        self.pos += got as u64;
        Ok(got)
    }

    /// Blocks until bytes at the position are written, with a cushion of [`PREFETCH_BYTES`] (or the read size, or the
    /// rest of the file), so playback does not stutter right behind the download. Requests a range when the download
    /// is not heading here; the watchdog fails the stream when nothing arrives; a cancelled play gives up within one
    /// [`COVERAGE_POLL`] ([`ReadCancelled`]).
    fn wait_for_bytes(&self, read_len: u64) -> io::Result<Ready> {
        let shared = &self.live.shared;
        let pos = self.pos;
        let cushion = read_len.max(PREFETCH_BYTES);
        let target = shared.len().map_or(pos.saturating_add(cushion), |len| {
            len.min(pos.saturating_add(cushion))
        });
        let _waiting = shared.waiting();
        let mut requested: Option<Instant> = None;
        loop {
            if self.cancel.is_cancelled() {
                log::debug!(
                    "audio source: {}: a read waiting for byte {pos} gave up, its play ended",
                    describe(&shared.key)
                );
                return Err(ReadCancelled::io_error());
            }
            if let Some(f) = shared.failed() {
                return Err(io::Error::new(f.kind, f.message));
            }
            if shared.phase() == Phase::Abandoned {
                return Err(io::Error::other(format!(
                    "{}: the stream was closed",
                    describe(&shared.key)
                )));
            }
            if shared.covers(pos, target) {
                return Ok(Ready::Bytes);
            }
            let have_some = shared.covers(pos, pos.saturating_add(1));
            if shared.is_finished() {
                if have_some {
                    return Ok(Ready::Bytes);
                }
                if shared.len().is_none() {
                    return Ok(Ready::Eof);
                }
                // A known length that ended short: the watchdog records the failure in a moment.
            } else if !have_some
                && !self.download_is_heading_to(pos)
                && requested.is_none_or(|at| at.elapsed() >= RANGE_RETRY)
            {
                self.live.request_range(pos);
                requested = Some(Instant::now());
            }
            if shared.wait_covered(pos, target, COVERAGE_POLL) {
                return Ok(Ready::Bytes);
            }
        }
    }

    /// The download writes sequentially just before `pos`, so it gets there without a Range request.
    fn download_is_heading_to(&self, pos: u64) -> bool {
        let writer = self.live.shared.writer_pos.load(Ordering::Acquire);
        writer <= pos && pos - writer <= SEQUENTIAL_SLACK
    }
}

impl Read for StreamCursor {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.read_at(buf)
    }
}

impl Seek for StreamCursor {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(p) => i128::from(p),
            SeekFrom::Current(d) => i128::from(self.pos) + i128::from(d),
            SeekFrom::End(d) => match self.live.shared.len() {
                Some(len) => i128::from(len) + i128::from(d),
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "cannot seek from the end of a stream of unknown length",
                    ));
                }
            },
        };
        let target = u64::try_from(target).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of the stream",
            )
        })?;
        // Lazy: the shared download is positioned by the next read.
        self.pos = target;
        Ok(target)
    }
}

impl MediaSource for StreamCursor {
    fn is_seekable(&self) -> bool {
        self.live.shared.len().is_some()
    }

    fn byte_len(&self) -> Option<u64> {
        self.live.shared.len()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Local files only.

/// Opens complete cached files only (`root/{reciter_id}/{surah:03}.mp3`, of `expected_len` bytes when known); everything
/// else is [`AudioError::Offline`]. Used when streaming is unavailable and in tests.
#[derive(Debug, Clone)]
pub struct LocalFileSource {
    root: PathBuf,
}

impl LocalFileSource {
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The cache root (`packs/audio`).
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl SourceProvider for LocalFileSource {
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError> {
        debug_assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "SourceProvider::open runs on qd-audio-ctl only, never in async code"
        );
        open_local(&self.root, key)
            .ok_or_else(|| AudioError::Offline(format!("{} is not cached", describe(key))))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn byte_ranges_merge_and_cover() {
        let mut r = ByteRanges::new();
        assert!(r.covers(5, 5));
        assert!(!r.covers(0, 1));
        r.insert(10, 20);
        r.insert(30, 40);
        assert_eq!(r.ranges(), &[(10, 20), (30, 40)]);
        assert!(r.covers(10, 20) && r.covers(12, 18) && !r.covers(9, 11) && !r.covers(15, 31));
        r.insert(20, 30); // touching on both sides
        assert_eq!(r.ranges(), &[(10, 40)]);
        r.insert(0, 5);
        r.insert(45, 50);
        r.insert(3, 47); // swallows everything
        assert_eq!(r.ranges(), &[(0, 50)]);
        assert_eq!(r.total(), 50);
        r.insert(60, 60); // empty
        assert_eq!(r.ranges(), &[(0, 50)]);
        r.insert(55, 70);
        r.insert(52, 53);
        assert_eq!(r.ranges(), &[(0, 50), (52, 53), (55, 70)]);
        assert_eq!(r.total(), 50 + 1 + 15);
        assert!(r.covers(0, 50) && !r.covers(0, 51) && r.covers(56, 70) && !r.covers(50, 52));
    }

    #[test]
    fn byte_ranges_agree_with_a_bitmap() {
        // Deterministic pseudo-random inserts against a naive model.
        let mut r = ByteRanges::new();
        let mut model = vec![false; 256];
        let mut x: u32 = 0x9E37_79B9;
        for _ in 0..2_000 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            let a = u64::from(x % 256);
            let b = u64::from((x >> 8) % 256);
            let (s, e) = (a.min(b), a.max(b));
            r.insert(s, e);
            for i in s..e {
                model[i as usize] = true;
            }
            let total = model.iter().filter(|&&b| b).count() as u64;
            assert_eq!(r.total(), total);
            for w in r.ranges().windows(2) {
                assert!(
                    w[0].1 < w[1].0,
                    "ranges must be disjoint and non-adjacent: {:?}",
                    r.ranges()
                );
            }
            let (qs, qe) = (u64::from((x >> 16) % 256), u64::from((x >> 24) % 256));
            let (qs, qe) = (qs.min(qe), qs.max(qe));
            assert_eq!(r.covers(qs, qe), (qs..qe).all(|i| model[i as usize]));
        }
    }

    #[test]
    fn host_fallbacks_rewrite_the_authority() {
        let defaults: Vec<(String, String)> = DEFAULT_HOST_FALLBACKS
            .iter()
            .map(|&(a, b)| (a.to_owned(), b.to_owned()))
            .collect();
        let url =
            Url::parse("https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/1.mp3")
                .unwrap();
        assert_eq!(
            fallback_url(&defaults, &url).unwrap().as_str(),
            "https://download.quranicaudio.org/qdc/mishari_al_afasy/murattal/1.mp3"
        );
        let upper = Url::parse("https://DOWNLOAD.QURANICAUDIO.COM/x.mp3").unwrap();
        assert!(fallback_url(&defaults, &upper).is_some());
        let other = Url::parse("https://download.quranicaudio.org/x.mp3").unwrap();
        assert!(fallback_url(&defaults, &other).is_none());

        let local = vec![("127.0.0.1:4000".to_owned(), "127.0.0.1:4001".to_owned())];
        let url = Url::parse("http://127.0.0.1:4000/7/001.mp3").unwrap();
        assert_eq!(
            fallback_url(&local, &url).unwrap().as_str(),
            "http://127.0.0.1:4001/7/001.mp3"
        );
        let wrong_port = Url::parse("http://127.0.0.1:4002/7/001.mp3").unwrap();
        assert!(fallback_url(&local, &wrong_port).is_none());
        // A pattern without a port matches any port and keeps it.
        let any_port = vec![("example.com".to_owned(), "example.org".to_owned())];
        let url = Url::parse("http://example.com:8080/a").unwrap();
        assert_eq!(
            fallback_url(&any_port, &url).unwrap().as_str(),
            "http://example.org:8080/a"
        );
    }

    #[test]
    fn authorities_split_into_host_and_port() {
        assert_eq!(split_authority("a.b"), ("a.b", None));
        assert_eq!(split_authority("a.b:81"), ("a.b", Some(81)));
        assert_eq!(split_authority("a.b:x"), ("a.b:x", None));
        assert_eq!(split_authority(":81"), (":81", None));
    }

    #[test]
    fn paths_follow_the_cache_layout() {
        let root = Path::new("packs").join("audio");
        assert_eq!(
            cached_file_path(&root, 7, 2),
            root.join("7").join("002.mp3")
        );
        assert_eq!(
            stream_part_path(&root, 7, 114),
            root.join("7").join("114.stream.part")
        );
    }
}
