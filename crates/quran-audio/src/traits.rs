//! The engine's view of storage, network and the app (docs/ARCHITECTURE.md §2.3.2, §2.3.7). Frozen after wave 0.
//!
//! Implemented by `src-tauri/src/audio_glue.rs` over `ContentDb` + `PackManager` (WP4d); tests implement them with
//! fixtures. **Every `TimingsSource`/`SourceProvider` method is blocking and runs ONLY on `qd-audio-ctl`** (a plain OS
//! thread, never a tokio worker): implementations may call `Handle::block_on` on async APIs and MUST start with
//! `debug_assert!(tokio::runtime::Handle::try_current().is_err())` (§0.2). Never call them from async code.

use std::fmt;
use std::io;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;

use quran_types::{AudioSnapshot, AudioTick, AyahChange};
use symphonia::core::io::MediaSource;
use tokio::sync::watch;

use crate::AudioError;

/// One play's cancellation (§2.3.2 "Commands while blocked"). The engine handle raises it as soon as a newer play, a
/// stop or the shutdown makes the play moot, so the blocking work done for it gives up instead of waiting for the
/// network: loading its timings ([`TimingsSource::surah_timings_for`]), opening its sources
/// ([`SourceProvider::open_for`]), and the reads of its streams that wait for bytes ([`ReadCancelled`]). A plain
/// read of bytes that are there is never affected. Cheap to clone; a new play gets a new token.
#[derive(Clone)]
pub struct CancelToken(Arc<watch::Sender<bool>>);

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        Self(Arc::new(watch::channel(false).0))
    }

    /// Cancels the play (idempotent).
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    /// Resolves once the play is cancelled (at once if it already is): `select!` it against a network wait.
    pub async fn cancelled(&self) {
        let mut rx = self.0.subscribe();
        let _ = rx.wait_for(|&cancelled| cancelled).await;
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

/// The error inside the `io::Error` of a stream read that gave up because its play was cancelled while it waited for
/// bytes ([`CancelToken`]). Decode recognises it ([`ReadCancelled::is`]) and drops the ended play quietly instead of
/// reporting a decode failure. Its kind is `ConnectionAborted`: never `Interrupted`, which readers retry, nor
/// `UnexpectedEof`, which the decoder takes for the end of the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadCancelled;

impl ReadCancelled {
    /// The `io::Error` a cancelled read returns.
    #[must_use]
    pub fn io_error() -> io::Error {
        io::Error::new(io::ErrorKind::ConnectionAborted, Self)
    }

    /// Whether `e` is (or wraps) a cancelled read.
    #[must_use]
    pub fn is(e: &io::Error) -> bool {
        e.get_ref().is_some_and(|inner| inner.is::<Self>())
    }
}

impl fmt::Display for ReadCancelled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the play ended while this read waited for the network")
    }
}

impl std::error::Error for ReadCancelled {}

/// Timings and Quran structure for the planner (blocking, control thread only).
pub trait TimingsSource: Send + Sync + 'static {
    /// The surah's file and ayah/word spans (content.db, fetched from QDC when missing or stale and online).
    fn surah_timings(&self, reciter_id: u32, surah: u16)
    -> Result<Arc<SurahTimingSet>, AudioError>;
    /// [`Self::surah_timings`] for a play that `cancel` can end: an implementation that waits on the network gives up
    /// with [`AudioError::Cancelled`] once the play is cancelled. The default ignores the token.
    fn surah_timings_for(
        &self,
        reciter_id: u32,
        surah: u16,
        cancel: &CancelToken,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        let _ = cancel;
        self.surah_timings(reciter_id, surah)
    }
    fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags;
    fn surah_ayah_count(&self, surah: u16) -> u16;
    /// Canonical ayah id (1..=6236) of `surah:ayah`.
    fn ayah_id(&self, surah: u16, ayah: u16) -> u32;
}

/// Per-reciter facts the planner needs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ReciterFlags {
    /// The surah file starts with the basmala. `false` for all 14 QDC reciters (FACT C8): their basmala is the surah-1
    /// file's 1:1 range.
    pub basmala_in_file: bool,
}

/// One surah's timings on its file's timeline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurahTimingSet {
    pub reciter_id: u32,
    pub surah: u16,
    pub file: FileKey,
    pub duration_ms: u32,
    /// Ayahs `1..=n` in order.
    pub ayahs: Vec<AyahSpan>,
    /// `false`: ayah-level timings only.
    pub word_level: bool,
}

impl SurahTimingSet {
    /// The span of `ayah` (1-based), if present.
    #[must_use]
    pub fn ayah(&self, ayah: u16) -> Option<&AyahSpan> {
        self.ayahs.iter().find(|a| a.ayah == ayah)
    }
}

/// One ayah on the file timeline. `words` = `(position, start_ms, end_ms)` sorted by start; positions may repeat or go
/// backwards (the active word is chosen by time).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AyahSpan {
    pub ayah: u16,
    pub from_ms: u32,
    pub to_ms: u32,
    pub words: Vec<(u16, u32, u32)>,
}

/// Identity of one audio file. `expected_len` is the HTTP `Content-Length` the timings were recorded against: a cached
/// file is only used when its size matches, and a mismatch means the timings are stale (§2.3.7 rule 7).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct FileKey {
    pub reciter_id: u32,
    pub surah: u16,
    pub url: String,
    pub expected_len: Option<u64>,
}

/// Audio bytes for the decoder (blocking, control thread only).
pub trait SourceProvider: Send + Sync + 'static {
    /// Returns a local file when complete and correctly sized, a reader over a live stream for the same key, or a new
    /// progressive stream that fills the cache. Offline and not cached ⇒ [`AudioError::Offline`].
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError>;
    /// [`Self::open`] for a play that `cancel` can end: an open that waits on the network gives up with
    /// [`AudioError::Cancelled`], and once the play is cancelled the source's reads that wait for bytes fail with
    /// [`ReadCancelled`] (so a stalled stream never holds decode, and with it the next play, until its stall timeout).
    /// The default ignores the token.
    fn open_for(&self, key: &FileKey, cancel: &CancelToken) -> Result<OpenedSource, AudioError> {
        let _ = cancel;
        self.open(key)
    }
}

/// A readable, seekable source plus its download progress (`1000` = complete; streams count up as bytes arrive).
pub struct OpenedSource {
    pub source: Box<dyn MediaSource>,
    pub buffered_permille: Arc<AtomicU32>,
}

impl OpenedSource {
    /// A source that is already complete (local file, test fixture).
    #[must_use]
    pub fn complete(source: Box<dyn MediaSource>) -> Self {
        Self {
            source,
            buffered_permille: Arc::new(AtomicU32::new(1000)),
        }
    }
}

impl fmt::Debug for OpenedSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenedSource")
            .field("byte_len", &self.source.byte_len())
            .field("buffered_permille", &self.buffered_permille)
            .finish_non_exhaustive()
    }
}

/// Where the engine reports to the app (called from engine threads; implementations must be cheap and never block on
/// the UI).
pub trait EventSink: Send + Sync + 'static {
    /// At most `tick_hz` per second while playing; once per change otherwise.
    fn tick(&self, t: &AudioTick);
    /// Any snapshot change except position.
    fn state(&self, s: &AudioSnapshot);
    /// Marker edge into a new segment (basmala: `ayah = 0`).
    fn ayah_changed(&self, c: &AyahChange);
    fn error(&self, e: &AudioError);
}

/// An [`EventSink`] that drops everything (tests, headless runs).
#[derive(Clone, Copy, Debug, Default)]
pub struct NullEventSink;

impl EventSink for NullEventSink {
    fn tick(&self, _t: &AudioTick) {}
    fn state(&self, _s: &AudioSnapshot) {}
    fn ayah_changed(&self, _c: &AyahChange) {}
    fn error(&self, _e: &AudioError) {}
}

/// The single-writer registry for audio files (PackManager's `writers.rs`, §2.5.5), seen from the streaming source:
/// a progressive stream announces that it writes `{sss}.stream.part`, and how it ended.
pub trait StreamRegistry: Send + Sync + 'static {
    /// A stream started writing `{sss}.stream.part`.
    fn begin(&self, key: &FileKey);
    /// `Some(bytes)`: promoted to `{sss}.mp3`; `None`: abandoned (temp deleted).
    fn end(&self, key: &FileKey, promoted_bytes: Option<u64>);
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::io::Cursor;
    use std::sync::atomic::Ordering;

    use super::*;

    #[test]
    fn tokens_cancel_once_and_wake_their_waiters() {
        let token = CancelToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let woke = rt.block_on(async {
            let waiter = clone.cancelled();
            let canceller = async {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                token.cancel();
            };
            tokio::join!(waiter, canceller);
            true
        });
        assert!(woke && clone.is_cancelled());
        token.cancel();
        // Already cancelled: resolves at once.
        rt.block_on(clone.cancelled());
    }

    #[test]
    fn a_cancelled_read_is_recognisable_through_io() {
        let e = ReadCancelled::io_error();
        assert_eq!(e.kind(), io::ErrorKind::ConnectionAborted);
        assert!(ReadCancelled::is(&e));
        assert!(!ReadCancelled::is(&io::Error::other("network")));
        assert!(!ReadCancelled::is(&io::Error::from(
            io::ErrorKind::TimedOut
        )));
    }

    #[test]
    fn complete_sources_report_full_buffering() {
        let src = OpenedSource::complete(Box::new(Cursor::new(vec![0_u8; 16])));
        assert_eq!(src.buffered_permille.load(Ordering::Relaxed), 1000);
        assert!(format!("{src:?}").contains("byte_len: Some(16)"));
    }

    #[test]
    fn finds_ayah_spans() {
        let set = SurahTimingSet {
            reciter_id: 7,
            surah: 1,
            file: FileKey {
                reciter_id: 7,
                surah: 1,
                url: "https://example.invalid/001.mp3".into(),
                expected_len: None,
            },
            duration_ms: 10,
            ayahs: vec![AyahSpan {
                ayah: 1,
                from_ms: 0,
                to_ms: 10,
                words: Vec::new(),
            }],
            word_level: false,
        };
        assert_eq!(set.ayah(1).map(|a| a.to_ms), Some(10));
        assert!(set.ayah(2).is_none());
    }
}
