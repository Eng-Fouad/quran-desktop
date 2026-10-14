//! `qd-audio-decode`: symphonia decode, the segment/repeat/A-B/gap state machine, flush generations and markers
//! (Segment/Gap/End and a Sync marker every ~100 ms) into the sample and marker rings.
//!
//! Talks to control only through [`crate::shared::DecodeCmd`] and [`crate::shared::CtlMsg`]; never does network IO
//! itself (its reads may block on a stream-download source that control opened and prefetched).
//!
//! # Timeline
//! Every position is an integer: **source frames** on the file's own rate while decoding, **µs** on the file timeline in
//! markers, **ring frames** (frames written into the current output ring since it was created) for marker placement.
//! A millisecond position maps to the first source frame at or after it (`⌈ms·rate/1000⌉`), so a segment boundary
//! shared by two segments is the same frame for both, and a marker's `file_pos_us` (`⌊frame·10⁶/rate⌋`) never reads
//! before the millisecond it stands for.
//!
//! After each chain reset (a flush, or a drain at a non-contiguous segment end) the chain's output frame `u` is ring
//! frame `gen_origin + u` and source position `origin + u·α` (the [`DspChain`] position contract, i.e.
//! [`MediaRate::advance_us`]). So:
//! - the flush/entry `Segment` marker sits at `gen_origin` with the entry position;
//! - a **contiguous** segment boundary at source frame `E` sits at `gen_origin + chain.out_frame_at_src(E − origin)`;
//! - a **Sync** marker every ~100 ms of output sits at the latest WSOLA hop boundary already released
//!   ([`DspChain::sync_point`]);
//! - Gap and End markers sit right after the drained (faded-out) tail.
//!
//! A marker is handed to the marker ring only once every frame before it is in the sample ring (and no frame at or
//! after it is written before it), so the callback always meets markers in order and a flush marker can never sit
//! behind a future marker of an older generation.
//!
//! # State machine
//! `Playing` decodes towards the next event: the segment end (normal mode) or, while an A-B loop is active on the
//! current file, the next segment start (marker only) or B (wrap to A). At a segment end:
//! 1. decide what comes next: replay (Ayah segments, `ayah_repeat`), the next segment, a range restart
//!    (`range_repeat`), or the end of the queue;
//! 2. a seamless continuation into the same file at the same frame only pushes a `Segment` marker;
//! 3. anything else drains the chain with a 4 ms fade-out, then (after an Ayah play, unless the queue ends) pushes a
//!    `Gap` marker and writes the gap's silence, then enters the next segment (seek or open, 4 ms fade-in).
//!
//! Flushes (load, jump, next pass, seek, speed, new output, an A-B loop set behind the decode position) bump the
//! generation, drop everything not yet in the ring, and restart from the **consumed position**: the ring frame the
//! callback reads next, mapped back through this generation's markers (so repeats, passes and gaps resume exactly where
//! the listener is, not where decode had got to).
//!
//! A seek and an A-B loop's wrap to A stay inside the queue's run of the file they are on ([`seek_in_run`]): the file's
//! audio outside the planned range never plays under the label of the run's first or last segment.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use quran_types::AbLoop;
use quran_types::limits::{REPEAT, SPEED_PCT};
use rtrb::Producer;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::{Error as SymError, SeekErrorKind};
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{TimeBase, Timestamp};

use crate::dsp::{DspChain, StreamFormat};
use crate::plan::{Segment, SegmentKind, gap_ms, seek_in_run, segment_for_position};
use crate::shared::{
    CtlMsg, DecodeCmd, DecodeParams, Marker, MarkerKind, MediaRate, SYNC_INTERVAL_MS, Shared,
};
use crate::{AudioError, EngineConfig, FileKey, OpenedSource, ReadCancelled};

/// Source frames pushed into the chain per step. Small enough that Sync markers land within a few ms of their 100 ms
/// cadence even at 0.5× and that commands are polled often; large enough to keep the per-step cost negligible.
pub const FEED_CHUNK_FRAMES: usize = 512;
/// Silence frames written per step during a gap.
const GAP_CHUNK_FRAMES: u64 = 4_096;
/// Seeks land this many source frames early (two MP3 frames), and decode forward: the decoder's overlap and bit
/// reservoir are primed before the first audible frame.
const SEEK_PREROLL_FRAMES: u64 = 2_304;
/// A forward seek shorter than this (in seconds of source) decodes through instead of seeking the demuxer.
const DECODE_THROUGH_SECS: u64 = 2;
/// Consecutive undecodable packets tolerated before the file is declared broken.
const MAX_DECODE_ERRORS_IN_ROW: u32 = 64;
/// Files kept open after playback moved to another file (the surah-1 file backs every basmala of a range).
const PARKED_FILES: usize = 2;
/// Upper bound of the marker history (it is pruned as the callback consumes; this only guards a stalled callback).
const MAX_HISTORY: usize = 16_384;
/// Poll period while the ring is full and playing / paused (the 750 ms ring covers either).
const POLL_PLAYING: Duration = Duration::from_millis(5);
const POLL_PAUSED: Duration = Duration::from_millis(50);
/// Poll period while waiting (source, output) with frames still draining, so repeat counters keep publishing.
const POLL_WAITING: Duration = Duration::from_millis(25);

/// Tuning of the decode thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DecodeConfig {
    /// Ask control for the next file this long before the current file's last segment ends (`CtlMsg::NeedSource`).
    pub prefetch_next_file_ms: u32,
}

impl Default for DecodeConfig {
    fn default() -> Self {
        Self::from(&EngineConfig::default())
    }
}

impl From<&EngineConfig> for DecodeConfig {
    fn from(cfg: &EngineConfig) -> Self {
        Self {
            prefetch_next_file_ms: cfg.prefetch_next_file_ms,
        }
    }
}

/// What one [`Decoder::pump`] call achieved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Pump {
    /// Work was done; call again.
    Progress,
    /// The sample or marker ring is full: wait for the callback to consume.
    Blocked,
    /// Nothing to do until the next command (no queue, no output, waiting for a source, or ended).
    Idle,
}

/// The decoder's state, for diagnostics and tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeState {
    Idle,
    /// A queue is loaded but no output ring exists yet.
    WaitingForOutput,
    /// The next segment's file has not been opened by control yet (`NeedSource` sent).
    WaitingForSource(FileKey),
    Playing {
        index: u32,
    },
    /// Writing the silence after an ayah play.
    Gap {
        index: u32,
    },
    /// The End marker is written (or about to be).
    Ended,
}

/// Spawns `qd-audio-decode` running [`Decoder::run`].
///
/// # Errors
/// [`AudioError::Device`] when the OS refuses the thread (never panics).
pub fn spawn(
    cfg: DecodeConfig,
    cmds: Receiver<DecodeCmd>,
    ctl: Sender<CtlMsg>,
    shared: Arc<Shared>,
) -> Result<JoinHandle<()>, AudioError> {
    let decoder = Decoder::new(cfg, ctl, shared);
    std::thread::Builder::new()
        .name("qd-audio-decode".to_owned())
        .spawn(move || decoder.run(&cmds))
        .map_err(|e| AudioError::Device(format!("cannot start qd-audio-decode: {e}")))
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeline conversions (exact integer arithmetic).

/// First source frame at or after `ms`: `⌈ms·rate/1000⌉`.
#[must_use]
pub const fn ms_to_frame(ms: u32, rate: u32) -> u64 {
    (ms as u64 * rate as u64).div_ceil(1_000)
}

/// First source frame at or after `us`: `⌈us·rate/10⁶⌉` (saturating).
#[must_use]
pub const fn us_to_frame(us: u64, rate: u32) -> u64 {
    let v = (us as u128 * rate as u128).div_ceil(1_000_000);
    if v > u64::MAX as u128 {
        u64::MAX
    } else {
        v as u64
    }
}

/// Position of source frame `frame` in µs: `⌊frame·10⁶/rate⌋` (0 for a zero rate, saturating).
#[must_use]
pub const fn frame_to_us(frame: u64, rate: u32) -> u64 {
    if rate == 0 {
        return 0;
    }
    let v = frame as u128 * 1_000_000 / rate as u128;
    if v > u64::MAX as u128 {
        u64::MAX
    } else {
        v as u64
    }
}

/// Position of source frame `frame` in whole ms (rounded down, saturating at `u32::MAX`).
#[must_use]
pub const fn frame_to_ms(frame: u64, rate: u32) -> u32 {
    let us = frame_to_us(frame, rate) / 1_000;
    if us > u32::MAX as u64 {
        u32::MAX
    } else {
        us as u32
    }
}

/// Output frames of `ms` of silence at `rate`.
#[must_use]
pub const fn silence_frames(ms: u32, rate: u32) -> u64 {
    ms as u64 * rate as u64 / 1_000
}

// ---------------------------------------------------------------------------------------------------------------------
// One open file: demuxer + decoder + exact frame positions.

/// Outcome of [`OpenFile::read`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Chunk {
    Frames(usize),
    Eof,
}

/// A demuxed, decoding file that delivers frames at exact source positions. Positions come from packet timestamps
/// (after symphonia's encoder-delay trim), so a dropped packet becomes silence instead of shifting the timeline.
struct OpenFile {
    key: FileKey,
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: TimeBase,
    rate: u32,
    channels: usize,
    /// Decoded interleaved frames of the last packet, starting at source frame `buf_start`.
    buf: Vec<f32>,
    buf_start: u64,
    buf_frames: usize,
    /// Frames of `buf` already delivered or skipped.
    buf_pos: usize,
    /// Source frame of the next frame [`OpenFile::read`] delivers.
    next: u64,
    eof: bool,
    decode_errors: u32,
}

impl OpenFile {
    fn open(key: FileKey, source: OpenedSource) -> Result<Self, AudioError> {
        let what = describe(&key);
        let probing = Arc::new(AtomicBool::new(true));
        let guarded = ProbeGuard {
            inner: source.source,
            probing: Arc::clone(&probing),
        };
        let mss = MediaSourceStream::new(Box::new(guarded), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = url_extension(&key.url) {
            hint.with_extension(ext);
        }
        let opts = FormatOptions::default().seek_index_fill_period_ms(250);
        let reader = symphonia::default::get_probe()
            .probe(&hint, mss, opts, MetadataOptions::default())
            .map_err(|e| sym_error(&what, &e))?;
        probing.store(false, Ordering::Relaxed);
        let track = reader
            .default_track(TrackType::Audio)
            .ok_or_else(|| AudioError::Decode(format!("{what}: no audio track")))?;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|p| p.audio())
            .ok_or_else(|| AudioError::Decode(format!("{what}: no audio parameters")))?
            .clone();
        let rate = params
            .sample_rate
            .filter(|&r| r > 0)
            .ok_or_else(|| AudioError::Decode(format!("{what}: unknown sample rate")))?;
        let channels = params.channels.as_ref().map_or(0, |c| c.count());
        let time_base = track
            .time_base
            .or_else(|| TimeBase::try_from_recip(rate))
            .ok_or_else(|| AudioError::Decode(format!("{what}: no time base")))?;
        let track_id = track.id;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|e| sym_error(&what, &e))?;
        let mut file = Self {
            key,
            reader,
            decoder,
            track_id,
            time_base,
            rate,
            channels,
            buf: Vec::with_capacity(8_192),
            buf_start: 0,
            buf_frames: 0,
            buf_pos: 0,
            next: 0,
            eof: false,
            decode_errors: 0,
        };
        if file.channels == 0 {
            // The container did not say: decode the first packet to learn it (its frames stay buffered).
            while file.channels == 0 && !file.eof {
                file.decode_next()?;
            }
            if file.channels == 0 {
                return Err(AudioError::Decode(format!("{what}: no decodable audio")));
            }
        }
        Ok(file)
    }

    fn ts_to_frame(&self, ts: i64) -> u64 {
        if ts <= 0 {
            return 0;
        }
        let v = ts as u128 * u128::from(self.time_base.numer.get()) * u128::from(self.rate)
            / u128::from(self.time_base.denom.get());
        u64::try_from(v).unwrap_or(u64::MAX)
    }

    fn frame_to_ts(&self, frame: u64) -> i64 {
        let v = u128::from(frame) * u128::from(self.time_base.denom.get())
            / (u128::from(self.time_base.numer.get()) * u128::from(self.rate));
        i64::try_from(v).unwrap_or(i64::MAX)
    }

    /// Positions the file so the next delivered frame is source frame `frame` (or EOF when it lies past the end).
    fn seek(&mut self, frame: u64) -> Result<(), AudioError> {
        let through = DECODE_THROUGH_SECS * u64::from(self.rate);
        if frame >= self.next && frame - self.next <= through {
            // Short forward move (or none): keep decoding; the frames before `frame` are dropped.
            self.next = frame;
            return Ok(());
        }
        let target = frame.saturating_sub(SEEK_PREROLL_FRAMES);
        let to = SeekTo::Timestamp {
            ts: Timestamp::new(self.frame_to_ts(target)),
            track_id: self.track_id,
        };
        match self.reader.seek(SeekMode::Accurate, to) {
            Ok(_) => {
                self.after_seek(frame, false);
                Ok(())
            }
            Err(SymError::SeekError(SeekErrorKind::OutOfRange)) => {
                self.after_seek(frame, true);
                Ok(())
            }
            Err(e) if frame >= self.next => {
                // A forward-only source: decode through to the target.
                log::debug!(
                    "{}: seek failed ({e}); decoding through to frame {frame}",
                    describe(&self.key)
                );
                self.next = frame;
                Ok(())
            }
            Err(e) => Err(sym_error(&describe(&self.key), &e)),
        }
    }

    fn after_seek(&mut self, frame: u64, eof: bool) {
        self.decoder.reset();
        self.buf.clear();
        self.buf_frames = 0;
        self.buf_pos = 0;
        self.next = frame;
        self.eof = eof;
        self.decode_errors = 0;
    }

    /// Appends up to `max` frames (interleaved, [`Self::channels`]) starting exactly at [`Self::next`].
    fn read(&mut self, max: usize, out: &mut Vec<f32>) -> Result<Chunk, AudioError> {
        if max == 0 {
            return Ok(Chunk::Frames(0));
        }
        loop {
            if self.buf_pos < self.buf_frames {
                let first = self.buf_start + self.buf_pos as u64;
                let left = self.buf_frames - self.buf_pos;
                if first < self.next {
                    let drop = usize::try_from(self.next - first)
                        .unwrap_or(usize::MAX)
                        .min(left);
                    self.buf_pos += drop;
                    continue;
                }
                let ch = self.channels.max(1);
                if first > self.next {
                    // A packet was lost: keep the timeline exact with silence.
                    let n = usize::try_from(first - self.next)
                        .unwrap_or(usize::MAX)
                        .min(max);
                    out.resize(out.len() + n * ch, 0.0);
                    self.next += n as u64;
                    return Ok(Chunk::Frames(n));
                }
                let n = left.min(max);
                let start = self.buf_pos * ch;
                let samples = self
                    .buf
                    .get(start..start + n * ch)
                    .ok_or_else(|| AudioError::Decode("decoded buffer underflow".to_owned()))?;
                out.extend_from_slice(samples);
                self.buf_pos += n;
                self.next += n as u64;
                return Ok(Chunk::Frames(n));
            }
            if self.eof {
                return Ok(Chunk::Eof);
            }
            self.decode_next()?;
        }
    }

    /// Decodes the next packet of the track into `buf`, or sets `eof`.
    fn decode_next(&mut self) -> Result<(), AudioError> {
        let packet = match self.reader.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => {
                self.eof = true;
                return Ok(());
            }
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                self.eof = true;
                return Ok(());
            }
            Err(SymError::ResetRequired) => return self.remake_decoder(),
            Err(e) => return Err(sym_error(&describe(&self.key), &e)),
        };
        if packet.track_id != self.track_id {
            return Ok(());
        }
        let first_ts = packet
            .pts
            .get()
            .saturating_add(i64::try_from(packet.trim_start.get()).unwrap_or(i64::MAX));
        let buf_start = self.ts_to_frame(first_ts);
        match self.decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = decoded.spec();
                let (rate, channels) = (spec.rate(), spec.channels().count());
                if channels == 0 {
                    return Err(AudioError::Decode(format!(
                        "{}: packet without channels",
                        describe(&self.key)
                    )));
                }
                if rate != self.rate {
                    return Err(AudioError::Decode(format!(
                        "{}: sample rate changed mid-file ({} → {rate} Hz)",
                        describe(&self.key),
                        self.rate
                    )));
                }
                decoded.copy_to_vec_interleaved::<f32>(&mut self.buf);
                self.channels = channels;
                self.buf_frames = self.buf.len() / channels;
                self.buf_pos = 0;
                self.buf_start = buf_start;
                self.decode_errors = 0;
                Ok(())
            }
            Err(SymError::DecodeError(msg)) => self.skip_packet(msg),
            Err(SymError::IoError(e)) => self.skip_packet(&e.to_string()),
            Err(SymError::ResetRequired) => self.remake_decoder(),
            Err(e) => Err(sym_error(&describe(&self.key), &e)),
        }
    }

    fn skip_packet(&mut self, why: &str) -> Result<(), AudioError> {
        self.decode_errors += 1;
        log::debug!(
            "{}: skipping undecodable packet: {why}",
            describe(&self.key)
        );
        if self.decode_errors > MAX_DECODE_ERRORS_IN_ROW {
            return Err(AudioError::Decode(format!(
                "{}: {} undecodable packets in a row ({why})",
                describe(&self.key),
                self.decode_errors
            )));
        }
        Ok(())
    }

    fn remake_decoder(&mut self) -> Result<(), AudioError> {
        let what = describe(&self.key);
        let params = self
            .reader
            .tracks()
            .iter()
            .find(|t| t.id == self.track_id)
            .and_then(|t| t.codec_params.as_ref())
            .and_then(|p| p.audio())
            .cloned()
            .ok_or_else(|| AudioError::Decode(format!("{what}: track vanished on reset")))?;
        self.decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|e| sym_error(&what, &e))?;
        self.buf_frames = 0;
        self.buf_pos = 0;
        Ok(())
    }
}

/// Hides the source's length while symphonia probes it. When a trailing-tag reader is registered (symphonia's `ape` or
/// `id3v1` features, off in this workspace today) and the length is known, the probe seeks to the end of the file; on a
/// progressive stream that read would wait for the whole download before the first frame plays. Trailing tags never
/// matter for playback, so the guard keeps opening independent of the feature set. After the probe the length is
/// visible again.
struct ProbeGuard {
    inner: Box<dyn MediaSource>,
    probing: Arc<AtomicBool>,
}

impl Read for ProbeGuard {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for ProbeGuard {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for ProbeGuard {
    fn is_seekable(&self) -> bool {
        self.inner.is_seekable()
    }

    fn byte_len(&self) -> Option<u64> {
        if self.probing.load(Ordering::Relaxed) {
            None
        } else {
            self.inner.byte_len()
        }
    }
}

fn describe(key: &FileKey) -> String {
    format!("reciter {} surah {:03}", key.reciter_id, key.surah)
}

/// The URL's file extension (`mp3`, `wav`, …), ignoring a query or fragment.
fn url_extension(url: &str) -> Option<&str> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or(path);
    let (_, ext) = name.rsplit_once('.')?;
    (!ext.is_empty() && ext.len() <= 5).then_some(ext)
}

fn sym_error(what: &str, e: &SymError) -> AudioError {
    match e {
        SymError::IoError(io) if ReadCancelled::is(io) => AudioError::Cancelled,
        SymError::IoError(io) => AudioError::Source(format!("{what}: {io}")),
        other => AudioError::Decode(format!("{what}: {other}")),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The decoder.

/// The output ring decode writes into (from `DecodeCmd::NewOutput`).
struct OutputRing {
    prod: Producer<f32>,
    mprod: Producer<Marker>,
    rate: u32,
    channels: usize,
    /// Frames written into this ring since it was created (the ring-frame clock of markers).
    written: u64,
}

impl OutputRing {
    fn free_frames(&self) -> usize {
        self.prod.slots() / self.channels
    }

    /// The ring frame the callback reads next.
    fn read_frame(&self) -> u64 {
        let occupied = self
            .prod
            .buffer()
            .capacity()
            .saturating_sub(self.prod.slots())
            / self.channels;
        self.written.saturating_sub(occupied as u64)
    }
}

/// Where to (re)start playing: a segment, an optional file position (µs) inside or before it, and the repeat
/// counters to restore.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
    idx: usize,
    at_us: Option<u64>,
    /// Plays of this segment started so far, including this one (≥ 1).
    plays: u32,
    /// Passes over the queue started so far, including this one (≥ 1).
    passes: u32,
}

/// What follows a segment end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Next {
    Replay,
    Advance(usize),
    Restart,
    End,
}

#[derive(Clone, Debug)]
enum Phase {
    Idle,
    WaitOutput(Entry),
    WaitSource {
        key: FileKey,
        entry: Entry,
    },
    Playing,
    Gap {
        left: u64,
        then: Next,
    },
    /// The End marker is emitted; `QueueEnded` follows once it is in the ring.
    Ending,
    Ended,
}

/// The consumed (heard next) state to continue from after a flush.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Resume {
    Play(Entry),
    Gap {
        idx: usize,
        left: u64,
        plays: u32,
        passes: u32,
        pos_us: u64,
    },
    Ended,
}

/// A marker plus the counters in force from its frame on.
#[derive(Clone, Copy, Debug)]
struct HistEntry {
    marker: Marker,
    plays: u32,
    passes: u32,
    /// Gap markers: the gap's length in output frames.
    gap_frames: u64,
}

/// An active A-B loop, bound to the file it was set on.
#[derive(Clone, Debug)]
struct AbState {
    a_ms: u32,
    b_ms: u32,
    file: FileKey,
    /// Source frames decoded since the last wrap (a wrap with none means A is unreachable: the loop is dropped).
    since_wrap: u64,
    wrapped: bool,
}

/// What `Playing` decodes towards.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    SegmentEnd,
    /// A-B mode: the next segment of the file starts (marker only).
    Boundary(usize),
    /// A-B mode: B reached (or EOF): drain and seek to A.
    Wrap,
}

/// The decode thread's state machine. [`spawn`] runs it on `qd-audio-decode`; tests drive it synchronously with
/// [`Decoder::handle`] and [`Decoder::pump`] against [`crate::fake_out::FakeOut`].
pub struct Decoder {
    cfg: DecodeConfig,
    ctl: Sender<CtlMsg>,
    shared: Arc<Shared>,
    out: Option<OutputRing>,
    generation: u32,
    queue: Arc<[Segment]>,
    params: DecodeParams,
    ab: Option<AbState>,
    phase: Phase,
    idx: usize,
    plays: u32,
    passes: u32,
    /// Source frames decoded in the current play / pass (guards against endless zero-length loops).
    play_frames: u64,
    pass_frames: u64,
    file: Option<OpenFile>,
    parked: Vec<OpenFile>,
    ready: Vec<(FileKey, OpenedSource)>,
    requested: Vec<FileKey>,
    failed: Vec<(FileKey, AudioError)>,
    chain: Option<DspChain>,
    /// Source frame and µs of chain output frame 0 (since the last chain reset).
    origin_frame: u64,
    origin_us: u64,
    /// Ring frame of chain output frame 0.
    gen_origin: u64,
    /// Next source frame to feed into the chain.
    fed: u64,
    /// Output frames produced but not yet in the ring (interleaved; consumed from `pending_off`).
    pending: Vec<f32>,
    pending_off: usize,
    /// Markers emitted but not yet in the marker ring (each waits until every frame before it is written).
    markers: VecDeque<Marker>,
    /// This generation's markers from the one the callback is at onwards.
    history: VecDeque<HistEntry>,
    last_marker_frame: Option<u64>,
    scratch: Vec<f32>,
}

impl Decoder {
    #[must_use]
    pub fn new(cfg: DecodeConfig, ctl: Sender<CtlMsg>, shared: Arc<Shared>) -> Self {
        let generation = shared.generation.load(Ordering::Acquire);
        Self {
            cfg,
            ctl,
            shared,
            out: None,
            generation,
            queue: Arc::from(Vec::new()),
            params: DecodeParams::default(),
            ab: None,
            phase: Phase::Idle,
            idx: 0,
            plays: 1,
            passes: 1,
            play_frames: 0,
            pass_frames: 0,
            file: None,
            parked: Vec::new(),
            ready: Vec::new(),
            requested: Vec::new(),
            failed: Vec::new(),
            chain: None,
            origin_frame: 0,
            origin_us: 0,
            gen_origin: 0,
            fed: 0,
            pending: Vec::with_capacity(16_384),
            pending_off: 0,
            markers: VecDeque::with_capacity(64),
            history: VecDeque::with_capacity(64),
            last_marker_frame: None,
            scratch: Vec::with_capacity(FEED_CHUNK_FRAMES * 2),
        }
    }

    /// The thread body: commands first, then decode until the ring is full; parks on the command channel when there is
    /// nothing to do. Returns on `Shutdown` or when every command sender is gone.
    pub fn run(mut self, cmds: &Receiver<DecodeCmd>) {
        loop {
            loop {
                match cmds.try_recv() {
                    Ok(cmd) => {
                        if !self.handle(cmd) {
                            return;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }
            self.publish_progress();
            let wait = match self.pump() {
                Pump::Progress => continue,
                Pump::Blocked => Some(if self.shared.playing.load(Ordering::Relaxed) {
                    POLL_PLAYING
                } else {
                    POLL_PAUSED
                }),
                // Nothing can change without a command: no output ring (no device), nothing loaded, or ended.
                Pump::Idle
                    if self.out.is_none() || matches!(self.phase, Phase::Idle | Phase::Ended) =>
                {
                    None
                }
                Pump::Idle => Some(POLL_WAITING),
            };
            let cmd = match wait {
                Some(timeout) => match cmds.recv_timeout(timeout) {
                    Ok(cmd) => cmd,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                },
                None => match cmds.recv() {
                    Ok(cmd) => cmd,
                    Err(_) => return,
                },
            };
            if !self.handle(cmd) {
                return;
            }
        }
    }

    /// Applies one command. Returns `false` on `Shutdown`.
    pub fn handle(&mut self, cmd: DecodeCmd) -> bool {
        match cmd {
            DecodeCmd::Load {
                queue,
                start,
                start_ms,
                passes,
                source,
                params,
            } => self.load(queue, (start, start_ms, passes), source, params),
            DecodeCmd::SourceReady { key, source } => self.source_ready(key, source),
            DecodeCmd::SourceFailed { key, error } => self.source_failed(key, error),
            DecodeCmd::Jump { index } => self.jump(index),
            DecodeCmd::NextPass => self.next_pass(),
            DecodeCmd::Seek { file_ms } => self.seek(file_ms),
            DecodeCmd::SetSpeed { speed_pct } => self.set_speed(speed_pct),
            DecodeCmd::SetRepeat {
                ayah_repeat,
                range_repeat,
            } => {
                self.params.ayah_repeat = REPEAT.apply(ayah_repeat);
                self.params.range_repeat = REPEAT.apply(range_repeat);
            }
            DecodeCmd::SetGap(gap) => self.params.gap = gap.clamped(),
            DecodeCmd::SetAbLoop(ab) => self.set_ab_loop(ab),
            DecodeCmd::NewOutput {
                prod,
                mprod,
                rate,
                channels,
                resume_at_us,
            } => self.new_output(prod, mprod, rate, channels, resume_at_us),
            DecodeCmd::Stop => self.stop(),
            DecodeCmd::Shutdown => return false,
        }
        true
    }

    /// One bounded unit of work: writes what is pending into the rings, then decodes one chunk, writes one chunk of
    /// gap silence, or advances the state machine.
    pub fn pump(&mut self) -> Pump {
        if self.out.is_none() {
            return Pump::Idle;
        }
        self.prune_history();
        if !self.flush_out() {
            return Pump::Blocked;
        }
        match self.phase.clone() {
            Phase::Idle | Phase::WaitOutput(_) | Phase::WaitSource { .. } | Phase::Ended => {
                Pump::Idle
            }
            Phase::Ending => {
                if !self.markers.is_empty() {
                    return Pump::Blocked;
                }
                self.send(CtlMsg::QueueEnded);
                self.release_files();
                self.phase = Phase::Ended;
                Pump::Progress
            }
            Phase::Gap { left, then } => self.gap_step(left, then),
            Phase::Playing => {
                if self.out.as_ref().is_some_and(|o| o.free_frames() == 0) {
                    return Pump::Blocked;
                }
                self.play_step();
                Pump::Progress
            }
        }
    }

    /// Publishes the repeat counters of the segment the callback is in (`Shared::ayah_repeat_left`/`range_repeat_left`:
    /// plays/passes left after the current one; 0 when infinite or not applicable).
    pub fn publish_progress(&mut self) {
        self.prune_history();
        let Some(h) = self.consumed_entry().copied() else {
            return;
        };
        let kind = self.queue.get(h.marker.seg_index as usize).map(|s| s.kind);
        let n = self.params.ayah_repeat;
        let ayah_left = if n == 0 || kind != Some(SegmentKind::Ayah) || self.ab.is_some() {
            0
        } else {
            n.saturating_sub(h.plays)
        };
        let r = self.params.range_repeat;
        let range_left = if r == 0 {
            0
        } else {
            r.saturating_sub(h.passes)
        };
        self.shared
            .ayah_repeat_left
            .store(ayah_left, Ordering::Relaxed);
        self.shared
            .range_repeat_left
            .store(range_left, Ordering::Relaxed);
    }

    /// The current flush generation (also in [`Shared::generation`]).
    #[must_use]
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// The loaded queue.
    #[must_use]
    pub fn queue(&self) -> &Arc<[Segment]> {
        &self.queue
    }

    /// The playback parameters in force.
    #[must_use]
    pub fn params(&self) -> DecodeParams {
        let mut p = self.params;
        p.ab_loop = self.ab.as_ref().map(|ab| AbLoop {
            a_ms: ab.a_ms,
            b_ms: ab.b_ms,
        });
        p
    }

    /// Frames written into the current output ring.
    #[must_use]
    pub fn written_frames(&self) -> u64 {
        self.out.as_ref().map_or(0, |o| o.written)
    }

    /// How far decoding has got (ahead of what is heard by the ring and the DSP latency): the current segment index
    /// and the file position (µs) of the next source frame, while a file is open.
    #[must_use]
    pub fn position(&self) -> Option<(u32, u64)> {
        let file = self.file.as_ref()?;
        Some((
            u32::try_from(self.idx).unwrap_or(u32::MAX),
            frame_to_us(self.fed, file.rate),
        ))
    }

    #[must_use]
    pub fn state(&self) -> DecodeState {
        let index = u32::try_from(self.idx).unwrap_or(u32::MAX);
        match &self.phase {
            Phase::Idle => DecodeState::Idle,
            Phase::WaitOutput(_) => DecodeState::WaitingForOutput,
            Phase::WaitSource { key, .. } => DecodeState::WaitingForSource(key.clone()),
            Phase::Playing => DecodeState::Playing { index },
            Phase::Gap { .. } => DecodeState::Gap { index },
            Phase::Ending | Phase::Ended => DecodeState::Ended,
        }
    }

    // --- commands ----------------------------------------------------------------------------------------------------

    /// `start`: `(segment index, file position, pass)` to start at (see [`DecodeCmd::Load`]).
    fn load(
        &mut self,
        queue: Arc<[Segment]>,
        (start, start_ms, passes): (u32, Option<u32>, u32),
        source: OpenedSource,
        params: DecodeParams,
    ) {
        self.flush();
        self.release_files();
        self.queue = queue;
        self.params = DecodeParams {
            speed_pct: SPEED_PCT.apply(params.speed_pct),
            ayah_repeat: REPEAT.apply(params.ayah_repeat),
            range_repeat: REPEAT.apply(params.range_repeat),
            gap: params.gap.clamped(),
            ab_loop: None,
        };
        self.pass_frames = 0;
        let idx = start as usize;
        let Some(seg) = self.queue.get(idx) else {
            self.fail(AudioError::Invalid(format!(
                "load: start {start} outside a queue of {}",
                self.queue.len()
            )));
            return;
        };
        let file = seg.file.clone();
        self.ab = params.ab_loop.and_then(|ab| AbState::new(ab, file.clone()));
        self.ready.push((file, source));
        self.start(Entry {
            idx,
            at_us: start_ms.map(|ms| u64::from(ms) * 1_000),
            plays: 1,
            passes: passes.max(1),
        });
    }

    fn source_ready(&mut self, key: FileKey, source: OpenedSource) {
        self.requested.retain(|k| k != &key);
        self.failed.retain(|(k, _)| k != &key);
        if let Phase::WaitSource { key: wanted, entry } = &self.phase
            && *wanted == key
        {
            let entry = *entry;
            self.ready.push((key, source));
            self.enter(entry);
            return;
        }
        let in_use = self.file.as_ref().is_some_and(|f| f.key == key)
            || self.parked.iter().any(|f| f.key == key);
        if !in_use && self.queue.iter().any(|s| s.file == key) {
            self.ready.retain(|(k, _)| k != &key);
            self.ready.push((key, source));
        } else {
            log::debug!("decode: dropping unneeded source for {}", describe(&key));
        }
    }

    fn source_failed(&mut self, key: FileKey, error: AudioError) {
        self.requested.retain(|k| k != &key);
        self.failed.retain(|(k, _)| k != &key);
        self.failed.push((key.clone(), error.clone()));
        if let Phase::WaitSource { key: wanted, entry } = &self.phase
            && *wanted == key
        {
            let entry = *entry;
            self.source_failure(entry, error);
        }
    }

    fn jump(&mut self, index: u32) {
        let idx = index as usize;
        if self.queue.get(idx).is_none() {
            log::warn!(
                "decode: jump to {index} outside a queue of {}",
                self.queue.len()
            );
            return;
        }
        let passes = self
            .reference()
            .map_or(self.passes, |(_, _, passes)| passes);
        self.flush();
        self.start(Entry {
            idx,
            at_us: None,
            plays: 1,
            passes,
        });
    }

    /// The next pass over the queue, from its first segment (what a segment end does after the last segment while
    /// range repeats remain, here at once: Next at the last segment).
    fn next_pass(&mut self) {
        let Some((_, _, passes)) = self.reference() else {
            log::debug!("decode: next pass without a queue");
            return;
        };
        self.flush();
        self.pass_frames = 0;
        self.start(Entry {
            idx: 0,
            at_us: None,
            plays: 1,
            passes: passes.saturating_add(1),
        });
    }

    /// Continues at `file_ms` on the timeline of the file heard next, bounded to the queue's run of that file
    /// ([`seek_in_run`]): the file's audio outside the planned range is never played under the label of its first or
    /// last ayah (the OS scrubber dragged to 0, a nudge back at the first ayah).
    fn seek(&mut self, file_ms: u32) {
        let Some((ref_idx, plays, passes)) = self.reference() else {
            log::debug!("decode: seek without a queue");
            return;
        };
        let Some((idx, bounded)) = seek_in_run(&self.queue, ref_idx, file_ms) else {
            return;
        };
        if bounded != file_ms {
            log::debug!("decode: seek to {file_ms} ms bounded to {bounded} ms (the queued run)");
        }
        let file_ms = bounded;
        let plays = if idx == ref_idx { plays } else { 1 };
        self.flush();
        self.start(Entry {
            idx,
            at_us: Some(u64::from(file_ms) * 1_000),
            plays,
            passes,
        });
    }

    fn set_speed(&mut self, speed_pct: u32) {
        let pct = SPEED_PCT.apply(speed_pct);
        if pct == self.params.speed_pct {
            return;
        }
        self.params.speed_pct = pct;
        match self.phase {
            Phase::Idle | Phase::Ended | Phase::WaitOutput(_) => {}
            _ => self.flush_and_resume(None),
        }
    }

    fn set_ab_loop(&mut self, ab: Option<AbLoop>) {
        let Some(ab) = ab else {
            self.ab = None;
            return;
        };
        let Some((ref_idx, _, _)) = self.reference() else {
            log::debug!("decode: A-B loop without a queue");
            return;
        };
        let Some(file) = self.queue.get(ref_idx).map(|s| s.file.clone()) else {
            return;
        };
        let Some(state) = AbState::new(ab, file.clone()) else {
            self.ab = None;
            return;
        };
        self.ab = Some(state);
        let in_band = matches!(self.phase, Phase::Playing)
            && self
                .file
                .as_ref()
                .is_some_and(|f| f.key == file && self.fed < ms_to_frame(ab.b_ms, f.rate));
        if in_band
            || matches!(
                self.phase,
                Phase::Idle | Phase::Ended | Phase::WaitOutput(_)
            )
        {
            return;
        }
        // Decode is already past B (or elsewhere): restart from what is heard next; `enter` wraps to A if that is at or
        // past B.
        self.flush_and_resume(None);
    }

    fn new_output(
        &mut self,
        prod: Producer<f32>,
        mprod: Producer<Marker>,
        rate: u32,
        channels: u16,
        resume_at_us: Option<u64>,
    ) {
        let resume = self.consumed_resume();
        let old_rate = self.out.as_ref().map(|o| o.rate);
        self.out = Some(OutputRing {
            prod,
            mprod,
            rate: rate.max(1),
            channels: usize::from(channels.max(1)),
            written: 0,
        });
        // The device format may have changed: the chain is rebuilt on entry.
        self.chain = None;
        let phase = std::mem::replace(&mut self.phase, Phase::Idle);
        self.flush();
        let resume = match (phase, resume) {
            (Phase::WaitOutput(entry), _) => Some(Resume::Play(entry)),
            (Phase::Idle | Phase::Ended, _) | (_, None) => None,
            (_, Some(Resume::Play(mut entry))) => {
                if let Some(us) = resume_at_us {
                    // The audible position may sit in the segment before the consumed one (device latency).
                    let ms = u32::try_from(us / 1_000).unwrap_or(u32::MAX);
                    let idx = self
                        .queue
                        .get(entry.idx)
                        .and_then(|s| segment_for_position(&self.queue, &s.file, ms, entry.idx))
                        .unwrap_or(entry.idx);
                    if idx != entry.idx {
                        // The tail of the previous segment: finish it as its last play (∞ keeps repeating).
                        entry.idx = idx;
                        entry.plays = self.params.ayah_repeat.max(1);
                    }
                    entry.at_us = Some(us);
                }
                Some(Resume::Play(entry))
            }
            (
                _,
                Some(Resume::Gap {
                    idx,
                    left,
                    plays,
                    passes,
                    pos_us,
                }),
            ) => {
                let left = old_rate.map_or(left, |old| {
                    let v = u128::from(left) * u128::from(rate.max(1)) / u128::from(old.max(1));
                    u64::try_from(v).unwrap_or(u64::MAX)
                });
                Some(Resume::Gap {
                    idx,
                    left,
                    plays,
                    passes,
                    pos_us,
                })
            }
            (_, Some(Resume::Ended)) => Some(Resume::Ended),
        };
        if let Some(r) = resume {
            self.apply_resume(r);
        }
    }

    fn stop(&mut self) {
        self.flush();
        self.release_files();
        self.queue = Arc::from(Vec::new());
        self.ab = None;
        self.phase = Phase::Idle;
    }

    // --- flushes and resumes -------------------------------------------------------------------------------------------

    /// New generation: the callback drops every older frame; nothing not yet in the ring survives.
    fn flush(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == Marker::INITIAL.generation {
            self.generation = self.generation.wrapping_add(1);
        }
        self.shared
            .generation
            .store(self.generation, Ordering::Release);
        self.pending.clear();
        self.pending_off = 0;
        self.markers.clear();
        self.history.clear();
        self.last_marker_frame = None;
        if let Some(chain) = &mut self.chain {
            chain.reset();
        }
        self.phase = Phase::Idle;
    }

    /// Flush, then continue from the consumed position (speed change, A-B set behind decode). `resume_at_us`
    /// overrides the position of a play resume.
    fn flush_and_resume(&mut self, resume_at_us: Option<u64>) {
        let resume = self.consumed_resume();
        self.flush();
        match resume {
            Some(Resume::Play(mut entry)) => {
                if resume_at_us.is_some() {
                    entry.at_us = resume_at_us;
                }
                self.apply_resume(Resume::Play(entry));
            }
            Some(r) => self.apply_resume(r),
            None => {}
        }
    }

    fn apply_resume(&mut self, resume: Resume) {
        // The pass is under way: a restart stays possible even if this generation decodes nothing more.
        self.pass_frames = self.pass_frames.max(1);
        match resume {
            Resume::Play(entry) => self.start(entry),
            Resume::Gap {
                idx,
                left,
                plays,
                passes,
                pos_us,
            } => {
                if self.out.is_none() || self.queue.get(idx).is_none() {
                    self.phase = Phase::Idle;
                    return;
                }
                self.idx = idx;
                self.plays = plays;
                self.passes = passes;
                self.play_frames = self.play_frames.max(1);
                let then = self.next_after_end();
                let at = self.queued_frames();
                self.emit(MarkerKind::Gap, at, pos_us, MediaRate::FROZEN, left);
                if left == 0 {
                    self.go(then);
                } else {
                    self.phase = Phase::Gap { left, then };
                }
            }
            Resume::Ended => self.phase = Phase::Ended,
        }
    }

    /// `(segment index, plays, passes)` of what the callback plays next, else of decode's own position.
    fn reference(&self) -> Option<(usize, u32, u32)> {
        if self.queue.is_empty() {
            return None;
        }
        match self.consumed_resume() {
            Some(Resume::Play(e)) => Some((e.idx, e.plays, e.passes)),
            Some(Resume::Gap {
                idx, plays, passes, ..
            }) => Some((idx, plays, passes)),
            Some(Resume::Ended) | None => {
                Some((self.idx.min(self.queue.len() - 1), self.plays, self.passes))
            }
        }
    }

    /// The history entry in force at the ring frame the callback reads next (the flush marker when the callback has not
    /// reached this generation yet).
    fn consumed_entry(&self) -> Option<&HistEntry> {
        let read = self.out.as_ref()?.read_frame();
        let mut best = None;
        for h in &self.history {
            if h.marker.ring_frame <= read {
                best = Some(h);
            } else {
                break;
            }
        }
        best.or_else(|| self.history.front())
    }

    fn consumed_resume(&self) -> Option<Resume> {
        if let Some(h) = self.consumed_entry() {
            let m = h.marker;
            let read = self
                .out
                .as_ref()
                .map_or(m.ring_frame, |o| o.read_frame().max(m.ring_frame));
            let idx = m.seg_index as usize;
            return Some(match m.kind {
                MarkerKind::Segment | MarkerKind::Sync => Resume::Play(Entry {
                    idx,
                    at_us: Some(m.position_at(read)),
                    plays: h.plays,
                    passes: h.passes,
                }),
                MarkerKind::Gap => Resume::Gap {
                    idx,
                    left: h.gap_frames.saturating_sub(read - m.ring_frame),
                    plays: h.plays,
                    passes: h.passes,
                    pos_us: m.file_pos_us,
                },
                MarkerKind::End => Resume::Ended,
            });
        }
        let here_us = self
            .file
            .as_ref()
            .map_or(0, |f| frame_to_us(self.fed, f.rate));
        match &self.phase {
            Phase::Idle => None,
            Phase::WaitOutput(e) | Phase::WaitSource { entry: e, .. } => Some(Resume::Play(*e)),
            Phase::Playing => Some(Resume::Play(Entry {
                idx: self.idx,
                at_us: Some(here_us),
                plays: self.plays,
                passes: self.passes,
            })),
            Phase::Gap { left, .. } => Some(Resume::Gap {
                idx: self.idx,
                left: *left,
                plays: self.plays,
                passes: self.passes,
                pos_us: here_us,
            }),
            Phase::Ending | Phase::Ended => Some(Resume::Ended),
        }
    }

    fn prune_history(&mut self) {
        let Some(read) = self.out.as_ref().map(OutputRing::read_frame) else {
            return;
        };
        while self
            .history
            .get(1)
            .is_some_and(|h| h.marker.ring_frame <= read)
            || self.history.len() > MAX_HISTORY
        {
            self.history.pop_front();
        }
    }

    // --- entering segments ----------------------------------------------------------------------------------------------

    /// Enters `entry` now, or once an output exists.
    fn start(&mut self, entry: Entry) {
        if self.out.is_some() {
            self.enter(entry);
        } else {
            self.phase = Phase::WaitOutput(entry);
        }
    }

    /// Starts playing `entry` with a freshly reset chain (after a flush or a drain): opens or reuses the file, seeks,
    /// and pushes the entry `Segment` marker at the current end of the output.
    fn enter(&mut self, entry: Entry) {
        let queue = Arc::clone(&self.queue);
        let Some(seg) = queue.get(entry.idx) else {
            self.finish_queue();
            return;
        };
        if seg.kind == SegmentKind::Basmala
            && let Some(err) = self.failure_of(&seg.file)
            && matches!(err, AudioError::Offline(_))
        {
            self.skip_basmala(entry);
            return;
        }
        match self.activate(&seg.file) {
            Activation::Ready => {}
            Activation::Waiting => {
                self.phase = Phase::WaitSource {
                    key: seg.file.clone(),
                    entry,
                };
                return;
            }
            Activation::Failed(err) => {
                self.source_failure(entry, err);
                return;
            }
        }
        let Some(rate) = self.file.as_ref().map(|f| f.rate) else {
            self.fail(AudioError::Decode("no open file".to_owned()));
            return;
        };
        let mut entry = entry;
        let mut at = entry.at_us.map_or_else(
            || ms_to_frame(seg.start_ms, rate),
            |us| us_to_frame(us, rate),
        );
        if let Some(ab) = &self.ab
            && ab.file == seg.file
            && at >= ms_to_frame(ab.b_ms, rate)
        {
            // At or past B: the loop takes over (A within the queued run of the file, like a seek).
            let (idx, a_ms) =
                seek_in_run(&queue, entry.idx, ab.a_ms).unwrap_or((entry.idx, ab.a_ms));
            entry.idx = idx;
            entry.plays = 1;
            at = ms_to_frame(a_ms, rate);
        }
        if let Err(e) = self.ensure_chain() {
            self.fail(e);
            return;
        }
        if let Some(Err(e)) = self.file.as_mut().map(|f| f.seek(at)) {
            self.fail(e);
            return;
        }
        self.origin_frame = at;
        self.origin_us = frame_to_us(at, rate);
        self.gen_origin = self.queued_frames();
        self.fed = at;
        self.idx = entry.idx;
        self.plays = entry.plays.max(1);
        self.passes = entry.passes.max(1);
        self.play_frames = 0;
        let rate_m = self
            .chain
            .as_ref()
            .map_or(MediaRate::FROZEN, DspChain::media_rate);
        self.emit(
            MarkerKind::Segment,
            self.gen_origin,
            self.origin_us,
            rate_m,
            0,
        );
        self.phase = Phase::Playing;
    }

    /// Makes `key` the current file: already current, parked, or opened from a ready source; else asks control.
    fn activate(&mut self, key: &FileKey) -> Activation {
        if self.file.as_ref().is_some_and(|f| &f.key == key) {
            return Activation::Ready;
        }
        let opened = if let Some(i) = self.parked.iter().position(|f| &f.key == key) {
            Ok(self.parked.remove(i))
        } else if let Some(i) = self.ready.iter().position(|(k, _)| k == key) {
            let (k, source) = self.ready.remove(i);
            OpenFile::open(k, source)
        } else if let Some(err) = self.failure_of(key) {
            return Activation::Failed(err);
        } else {
            self.request(key);
            return Activation::Waiting;
        };
        match opened {
            Ok(file) => {
                if let Some(old) = self.file.replace(file) {
                    self.park(old);
                }
                Activation::Ready
            }
            Err(e) => Activation::Failed(e),
        }
    }

    fn park(&mut self, file: OpenFile) {
        if self.queue.iter().any(|s| s.file == file.key) {
            self.parked.insert(0, file);
            self.parked.truncate(PARKED_FILES);
        }
    }

    fn failure_of(&self, key: &FileKey) -> Option<AudioError> {
        self.failed
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, e)| e.clone())
    }

    /// Asks control to open `key` unless it is already open, parked, ready, requested or failed.
    fn request(&mut self, key: &FileKey) {
        let known = self.file.as_ref().is_some_and(|f| &f.key == key)
            || self.parked.iter().any(|f| &f.key == key)
            || self.ready.iter().any(|(k, _)| k == key)
            || self.requested.iter().any(|k| k == key)
            || self.failed.iter().any(|(k, _)| k == key);
        if !known {
            self.requested.push(key.clone());
            self.send(CtlMsg::NeedSource(key.clone()));
        }
    }

    /// A segment's file cannot be opened: an offline basmala is skipped, anything else fails the queue.
    fn source_failure(&mut self, entry: Entry, error: AudioError) {
        let is_basmala = self
            .queue
            .get(entry.idx)
            .is_some_and(|s| s.kind == SegmentKind::Basmala);
        if is_basmala && matches!(error, AudioError::Offline(_)) {
            log::info!("decode: basmala skipped: {error}");
            self.skip_basmala(entry);
        } else {
            self.fail(error);
        }
    }

    fn skip_basmala(&mut self, entry: Entry) {
        self.idx = entry.idx;
        self.plays = 1;
        self.passes = entry.passes;
        self.play_frames = 0;
        let next = self.next_after_end();
        self.go(next);
    }

    /// (Re)builds or resets the chain for the current file and output formats at the current speed.
    fn ensure_chain(&mut self) -> Result<(), AudioError> {
        let (Some(out), Some(file)) = (&self.out, &self.file) else {
            return Err(AudioError::Decode("no output or file".to_owned()));
        };
        let format = StreamFormat {
            src_rate: file.rate,
            src_channels: file.channels,
            out_rate: out.rate,
            out_channels: out.channels,
        };
        let speed = self.params.speed_pct;
        match &mut self.chain {
            Some(chain) if chain.format() == format => {
                if chain.speed_pct() != speed {
                    chain.reset_with_speed(speed);
                } else if chain.src_frames_pushed() > 0 || chain.out_frames_pulled() > 0 {
                    chain.reset();
                }
            }
            _ => self.chain = Some(DspChain::new(format, speed)?),
        }
        Ok(())
    }

    // --- playing -----------------------------------------------------------------------------------------------------

    fn play_step(&mut self) {
        let Some((at, event)) = self.next_event() else {
            self.fail(AudioError::Decode("playing without a file".to_owned()));
            return;
        };
        if self.fed >= at {
            self.on_event(event);
            return;
        }
        let want = usize::try_from(at - self.fed)
            .unwrap_or(usize::MAX)
            .min(FEED_CHUNK_FRAMES);
        self.scratch.clear();
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let read = file.read(want, &mut self.scratch);
        let channels = file.channels;
        match read {
            Err(e) => self.fail(e),
            Ok(Chunk::Eof) => match event {
                Event::SegmentEnd => self.segment_end(),
                Event::Boundary(_) | Event::Wrap => self.wrap(),
            },
            Ok(Chunk::Frames(n)) => {
                if self
                    .chain
                    .as_ref()
                    .is_some_and(|c| c.format().src_channels != channels)
                    && let Err(e) = self.rebuild_chain_midstream()
                {
                    self.fail(e);
                    return;
                }
                let Some(chain) = self.chain.as_mut() else {
                    return;
                };
                chain.push(&self.scratch);
                chain.pull(&mut self.pending);
                let n = n as u64;
                self.fed += n;
                self.play_frames += n;
                self.pass_frames += n;
                if let Some(ab) = &mut self.ab {
                    ab.since_wrap += n;
                }
                self.maybe_sync();
                self.maybe_prefetch();
            }
        }
    }

    /// The next event frame and kind for the current segment.
    fn next_event(&self) -> Option<(u64, Event)> {
        let file = self.file.as_ref()?;
        let seg = self.queue.get(self.idx)?;
        let rate = file.rate;
        if let Some(ab) = &self.ab
            && ab.file == file.key
        {
            let mut event = (ms_to_frame(ab.b_ms, rate), Event::Wrap);
            if let Some(next) = self.queue.get(self.idx + 1)
                && next.file == file.key
                && next.start_ms > seg.start_ms
            {
                let starts = ms_to_frame(next.start_ms, rate);
                if starts < event.0 {
                    event = (starts, Event::Boundary(self.idx + 1));
                }
            }
            return Some(event);
        }
        Some((ms_to_frame(seg.end_ms, rate), Event::SegmentEnd))
    }

    fn on_event(&mut self, event: Event) {
        match event {
            Event::SegmentEnd => self.segment_end(),
            Event::Boundary(j) => self.emit_boundary(j),
            Event::Wrap => self.wrap(),
        }
    }

    /// What follows the current segment (normal mode).
    fn next_after_end(&self) -> Next {
        let Some(seg) = self.queue.get(self.idx) else {
            return Next::End;
        };
        let n = self.params.ayah_repeat;
        if seg.kind == SegmentKind::Ayah
            && seg.end_ms > seg.start_ms
            && self.play_frames > 0
            && (n == 0 || self.plays < n)
        {
            return Next::Replay;
        }
        if self.idx + 1 < self.queue.len() {
            return Next::Advance(self.idx + 1);
        }
        let r = self.params.range_repeat;
        if self.pass_frames > 0 && (r == 0 || self.passes < r) {
            Next::Restart
        } else {
            Next::End
        }
    }

    fn segment_end(&mut self) {
        let next = self.next_after_end();
        let gap = match next {
            Next::End => 0,
            _ => self.gap_frames(),
        };
        if gap == 0
            && let Next::Advance(j) = next
            && self.is_contiguous(j)
        {
            self.emit_boundary(j);
            return;
        }
        self.drain_chain();
        if gap > 0 {
            let at = self.queued_frames();
            let pos = self.position_us();
            self.emit(MarkerKind::Gap, at, pos, MediaRate::FROZEN, gap);
            self.phase = Phase::Gap {
                left: gap,
                then: next,
            };
            return;
        }
        self.go(next);
    }

    fn go(&mut self, next: Next) {
        match next {
            Next::Replay => self.enter(Entry {
                idx: self.idx,
                at_us: None,
                plays: self.plays.saturating_add(1),
                passes: self.passes,
            }),
            Next::Advance(j) => self.enter(Entry {
                idx: j,
                at_us: None,
                plays: 1,
                passes: self.passes,
            }),
            Next::Restart => {
                self.pass_frames = 0;
                self.enter(Entry {
                    idx: 0,
                    at_us: None,
                    plays: 1,
                    passes: self.passes.saturating_add(1),
                });
            }
            Next::End => self.finish_queue(),
        }
    }

    /// The gap after the current Ayah segment's play, in output frames.
    fn gap_frames(&self) -> u64 {
        let (Some(seg), Some(out)) = (self.queue.get(self.idx), &self.out) else {
            return 0;
        };
        silence_frames(gap_ms(self.params.gap, seg), out.rate)
    }

    /// The next segment continues the same file exactly where decode stands (no gap, no seek, no fade).
    fn is_contiguous(&self, j: usize) -> bool {
        let (Some(next), Some(file)) = (self.queue.get(j), &self.file) else {
            return false;
        };
        matches!(self.phase, Phase::Playing)
            && self.chain.is_some()
            && next.file == file.key
            && ms_to_frame(next.start_ms, file.rate) == self.fed
    }

    /// A seamless segment boundary at the current source frame: only a marker, at the exact output frame where it
    /// becomes audible.
    fn emit_boundary(&mut self, j: usize) {
        let Some(chain) = &self.chain else {
            return;
        };
        let u = chain.out_frame_at_src(self.fed.saturating_sub(self.origin_frame));
        let ring = self.gen_origin + u;
        let pos = self.origin_us + chain.src_us_at(u);
        let rate = chain.media_rate();
        self.idx = j;
        self.plays = 1;
        self.play_frames = 0;
        self.emit(MarkerKind::Segment, ring, pos, rate, 0);
    }

    /// A-B: B (or EOF) reached: fade out, seek to A.
    fn wrap(&mut self) {
        let Some(ab) = self.ab.as_mut() else {
            self.segment_end();
            return;
        };
        if ab.wrapped && ab.since_wrap == 0 {
            log::warn!(
                "decode: A-B loop {}..{} ms produces no audio; loop dropped",
                ab.a_ms,
                ab.b_ms
            );
            self.ab = None;
            self.segment_end();
            return;
        }
        ab.wrapped = true;
        ab.since_wrap = 0;
        let a_ms = ab.a_ms;
        self.drain_chain();
        // A within the queued run of the file, like a seek.
        let (idx, a_ms) = seek_in_run(&self.queue, self.idx, a_ms).unwrap_or((self.idx, a_ms));
        self.enter(Entry {
            idx,
            at_us: Some(u64::from(a_ms) * 1_000),
            plays: 1,
            passes: self.passes,
        });
    }

    fn finish_queue(&mut self) {
        let at = self.queued_frames();
        let pos = self.position_us();
        self.emit(MarkerKind::End, at, pos, MediaRate::FROZEN, 0);
        self.phase = Phase::Ending;
    }

    fn gap_step(&mut self, left: u64, then: Next) -> Pump {
        let Some(out) = &self.out else {
            return Pump::Idle;
        };
        let free = out.free_frames() as u64;
        if free == 0 && left > 0 {
            return Pump::Blocked;
        }
        let n = left.min(free).min(GAP_CHUNK_FRAMES);
        let samples = usize::try_from(n).unwrap_or(0) * out.channels;
        self.pending.resize(self.pending.len() + samples, 0.0);
        let left = left - n;
        if left == 0 {
            self.go(then);
        } else {
            self.phase = Phase::Gap { left, then };
        }
        Pump::Progress
    }

    /// Fades out and flushes the chain's tail into the output (non-contiguous segment end, gap, wrap, end of queue).
    /// The chain is reset afterwards.
    fn drain_chain(&mut self) {
        if let Some(chain) = &mut self.chain {
            chain.drain(&mut self.pending, true);
        }
    }

    /// The decoded channel count changed inside a file: fade the old format out and continue with a new chain at the
    /// same position (re-anchored with a Sync marker).
    fn rebuild_chain_midstream(&mut self) -> Result<(), AudioError> {
        self.drain_chain();
        self.chain = None;
        self.ensure_chain()?;
        self.origin_frame = self.fed;
        let rate = self.file.as_ref().map_or(1, |f| f.rate);
        self.origin_us = frame_to_us(self.fed, rate);
        self.gen_origin = self.queued_frames();
        let media = self
            .chain
            .as_ref()
            .map_or(MediaRate::FROZEN, DspChain::media_rate);
        self.emit(MarkerKind::Sync, self.gen_origin, self.origin_us, media, 0);
        Ok(())
    }

    /// A Sync marker at the latest WSOLA hop boundary when ~100 ms of output passed since the last marker.
    fn maybe_sync(&mut self) {
        let (Some(chain), Some(out)) = (&self.chain, &self.out) else {
            return;
        };
        let sp = chain.sync_point();
        let ring = self.gen_origin + sp.out_frame;
        let interval = silence_frames(SYNC_INTERVAL_MS, out.rate);
        if self
            .last_marker_frame
            .is_some_and(|last| ring < last.saturating_add(interval))
        {
            return;
        }
        let pos = self.origin_us + sp.src_us;
        let rate = chain.media_rate();
        self.emit(MarkerKind::Sync, ring, pos, rate, 0);
    }

    /// `CtlMsg::NeedSource` for the next file when the current segment is its file's last play and ends within
    /// `prefetch_next_file_ms`.
    fn maybe_prefetch(&mut self) {
        let queue = Arc::clone(&self.queue);
        let (Some(seg), Some(file)) = (queue.get(self.idx), &self.file) else {
            return;
        };
        if self.ab.as_ref().is_some_and(|ab| ab.file == file.key) {
            return;
        }
        let n = self.params.ayah_repeat;
        if seg.kind == SegmentKind::Ayah && (n == 0 || self.plays < n) {
            return;
        }
        let r = self.params.range_repeat;
        let next = if self.idx + 1 < queue.len() {
            queue.get(self.idx + 1)
        } else if r == 0 || self.passes < r {
            queue.first()
        } else {
            None
        };
        let Some(next) = next else {
            return;
        };
        if next.file == seg.file {
            return;
        }
        let pos_ms = frame_to_ms(self.fed, file.rate);
        if seg.end_ms.saturating_sub(pos_ms) <= self.cfg.prefetch_next_file_ms {
            self.request(&next.file);
        }
    }

    // --- output -------------------------------------------------------------------------------------------------------

    fn emit(
        &mut self,
        kind: MarkerKind,
        ring_frame: u64,
        file_pos_us: u64,
        rate: MediaRate,
        gap_frames: u64,
    ) {
        let marker = Marker {
            generation: self.generation,
            ring_frame,
            kind,
            seg_index: u32::try_from(self.idx).unwrap_or(u32::MAX),
            file_pos_us,
            rate,
            plays: self.plays,
            passes: self.passes,
        };
        self.markers.push_back(marker);
        self.history.push_back(HistEntry {
            marker,
            plays: self.plays,
            passes: self.passes,
            gap_frames,
        });
        self.last_marker_frame = Some(ring_frame);
    }

    fn pending_frames(&self) -> u64 {
        let ch = self.out.as_ref().map_or(1, |o| o.channels);
        (self.pending.len().saturating_sub(self.pending_off) / ch) as u64
    }

    /// Ring frame of the next output frame decode produces.
    fn queued_frames(&self) -> u64 {
        self.out.as_ref().map_or(0, |o| o.written) + self.pending_frames()
    }

    /// The file position decode stands at (µs).
    fn position_us(&self) -> u64 {
        self.file
            .as_ref()
            .map_or(0, |f| frame_to_us(self.fed, f.rate))
    }

    /// Moves markers and frames into the rings, in order: a marker goes in once every frame before it is written, and
    /// no frame at or after a waiting marker is written before it. Returns `false` when a ring is full with work left.
    fn flush_out(&mut self) -> bool {
        let Some(out) = self.out.as_mut() else {
            return true;
        };
        let ch = out.channels;
        loop {
            while let Some(m) = self.markers.front() {
                if m.ring_frame > out.written {
                    break;
                }
                if out.mprod.push(*m).is_err() {
                    return false;
                }
                self.markers.pop_front();
            }
            let avail = self.pending.len().saturating_sub(self.pending_off) / ch;
            if avail == 0 {
                break;
            }
            let mut n = avail.min(out.prod.slots() / ch);
            if let Some(m) = self.markers.front() {
                n = n.min(usize::try_from(m.ring_frame - out.written).unwrap_or(usize::MAX));
            }
            if n == 0 {
                break;
            }
            let Some(slice) = self
                .pending
                .get(self.pending_off..self.pending_off + n * ch)
            else {
                break;
            };
            let (done, _) = out.prod.push_partial_slice(slice);
            let pushed = done.len() / ch;
            self.pending_off += pushed * ch;
            out.written += pushed as u64;
            if pushed < n {
                break;
            }
        }
        if self.pending_off >= self.pending.len() {
            self.pending.clear();
            self.pending_off = 0;
        }
        let markers_due = self
            .markers
            .front()
            .is_some_and(|m| m.ring_frame <= out.written);
        self.pending.is_empty() && !markers_due
    }

    // --- errors and housekeeping -----------------------------------------------------------------------------------------

    fn fail(&mut self, error: AudioError) {
        if error == AudioError::Cancelled {
            // A read of the play's stream gave up because a newer play or a stop ended it (`ReadCancelled`): control
            // is about to drop the queue anyway, and nothing failed.
            log::debug!("decode: the ended play's stream read was cancelled; its queue is dropped");
        } else {
            log::error!("decode: {error}");
            self.send(CtlMsg::DecodeFailed(error));
        }
        self.release_files();
        self.queue = Arc::from(Vec::new());
        self.ab = None;
        self.phase = Phase::Idle;
    }

    fn release_files(&mut self) {
        self.file = None;
        self.parked.clear();
        self.ready.clear();
        self.requested.clear();
        self.failed.clear();
        if let Some(chain) = &mut self.chain {
            chain.reset();
        }
    }

    fn send(&self, msg: CtlMsg) {
        if self.ctl.send(msg).is_err() {
            log::debug!("decode: control is gone");
        }
    }
}

/// Result of making a file current.
enum Activation {
    Ready,
    Waiting,
    Failed(AudioError),
}

impl AbState {
    /// `None` (with a warning) for an empty or inverted loop.
    fn new(ab: AbLoop, file: FileKey) -> Option<Self> {
        if ab.b_ms <= ab.a_ms {
            log::warn!("decode: ignoring A-B loop {}..{} ms", ab.a_ms, ab.b_ms);
            return None;
        }
        Some(Self {
            a_ms: ab.a_ms,
            b_ms: ab.b_ms,
            file,
            since_wrap: 0,
            wrapped: false,
        })
    }
}

impl std::fmt::Debug for Decoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Decoder")
            .field("generation", &self.generation)
            .field("state", &self.state())
            .field("queue_len", &self.queue.len())
            .field("written", &self.written_frames())
            .field("fed", &self.fed)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]
mod tests {
    use std::io::Cursor;

    use quran_types::{AyahRef, GapSetting, MushafLayout, PlayRequest};

    use super::*;
    use crate::fake_out::Rig;
    use crate::fake_out::fixtures::{
        FixtureSources, FixtureTimings, file_key, ramp_frame, ramp_sample, ramp_wav, silent_mp3,
    };
    use crate::plan::plan;

    fn wav_file(rate: u32, channels: u16, frames: u64) -> OpenFile {
        let bytes = ramp_wav(rate, channels, frames);
        OpenFile::open(
            file_key(1, 1),
            OpenedSource::complete(Box::new(Cursor::new(bytes))),
        )
        .unwrap()
    }

    fn read_all(f: &mut OpenFile, out: &mut Vec<f32>) -> u64 {
        let mut total = 0;
        while let Chunk::Frames(n) = f.read(1_000, out).unwrap() {
            total += n as u64;
        }
        total
    }

    #[test]
    fn conversions_are_exact_and_consistent() {
        assert_eq!(ms_to_frame(1_000, 44_100), 44_100);
        assert_eq!(ms_to_frame(1, 44_100), 45, "ceil(44.1)");
        assert_eq!(ms_to_frame(0, 44_100), 0);
        for ms in [0_u32, 1, 7, 999, 123_456] {
            for rate in [8_000_u32, 22_050, 44_100, 48_000] {
                let f = ms_to_frame(ms, rate);
                // The frame's position never reads before the millisecond it stands for.
                assert!(frame_to_us(f, rate) >= u64::from(ms) * 1_000);
                assert_eq!(frame_to_ms(f, rate), ms);
                assert_eq!(us_to_frame(u64::from(ms) * 1_000, rate), f);
            }
        }
        assert_eq!(frame_to_us(5, 0), 0);
        assert_eq!(silence_frames(250, 48_000), 12_000);
        assert_eq!(url_extension("https://x/a/112.mp3"), Some("mp3"));
        assert_eq!(url_extension("https://x/a/112.mp3?x=1#f"), Some("mp3"));
        assert_eq!(url_extension("fixture://7/001.wav"), Some("wav"));
        assert_eq!(url_extension("https://x/a/noext"), None);
        assert_eq!(DecodeConfig::default().prefetch_next_file_ms, 20_000);
    }

    #[test]
    fn wav_reads_every_frame_at_its_position() {
        let mut f = wav_file(48_000, 2, 100_000);
        assert_eq!((f.rate, f.channels), (48_000, 2));
        let mut out = Vec::new();
        assert_eq!(read_all(&mut f, &mut out), 100_000);
        for (i, frame) in out.chunks(2).enumerate() {
            assert_eq!(ramp_frame(frame[0]), i as u64);
            assert_eq!(frame[0], frame[1]);
        }
    }

    #[test]
    fn wav_seeks_are_sample_accurate() {
        let mut f = wav_file(44_100, 1, 300_000);
        // Backward, forward (far), forward (decode-through), to 0, to the last frame.
        for target in [
            150_000_u64,
            20_000,
            290_000,
            290_500,
            0,
            299_999,
            1,
            123_457,
        ] {
            f.seek(target).unwrap();
            let mut out = Vec::new();
            let want = 64.min((300_000 - target) as usize);
            assert_eq!(f.read(64, &mut out).unwrap(), Chunk::Frames(want));
            assert_eq!(ramp_frame(out[0]), target, "seek to {target}");
            assert_eq!(f.next, target + (out.len() as u64));
        }
        f.seek(300_000).unwrap();
        assert_eq!(f.read(10, &mut Vec::new()).unwrap(), Chunk::Eof);
        f.seek(400_000).unwrap();
        assert_eq!(
            f.read(10, &mut Vec::new()).unwrap(),
            Chunk::Eof,
            "past the end"
        );
        f.seek(5).unwrap();
        let mut out = Vec::new();
        f.read(1, &mut out).unwrap();
        assert_eq!(out, [ramp_sample(5)], "seekable again after EOF");
    }

    #[test]
    fn mp3_frames_have_exact_positions() {
        let bytes = silent_mp3(200, true);
        let key = FileKey {
            url: "https://example.invalid/112.mp3".into(),
            ..file_key(1, 112)
        };
        let mut f =
            OpenFile::open(key, OpenedSource::complete(Box::new(Cursor::new(bytes)))).unwrap();
        assert_eq!((f.rate, f.channels), (44_100, 2));
        let mut out = Vec::new();
        let total = read_all(&mut f, &mut out);
        assert_eq!(total, 200 * 1_152);
        assert!(out.iter().all(|&s| s == 0.0));
        // A seek lands exactly: the frames left to EOF are exact.
        for target in [100_000_u64, 3_000, 229_000] {
            f.seek(target).unwrap();
            assert_eq!(
                read_all(&mut f, &mut Vec::new()),
                total - target,
                "seek to {target}"
            );
        }
    }

    /// A source that records the furthest byte it was asked to read.
    struct Spy {
        inner: Cursor<Vec<u8>>,
        furthest: Arc<std::sync::atomic::AtomicU64>,
    }

    impl Read for Spy {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.furthest
                .fetch_max(self.inner.position(), Ordering::Relaxed);
            Ok(n)
        }
    }

    impl Seek for Spy {
        fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    impl MediaSource for Spy {
        fn is_seekable(&self) -> bool {
            true
        }

        fn byte_len(&self) -> Option<u64> {
            Some(self.inner.get_ref().len() as u64)
        }
    }

    #[test]
    fn opening_never_reads_the_end_of_a_progressive_file() {
        for (bytes, url) in [
            (silent_mp3(2_000, true), "https://x/112.mp3"),
            (ramp_wav(48_000, 2, 1_000_000), "https://x/112.wav"),
        ] {
            let len = bytes.len() as u64;
            let furthest = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let spy = Spy {
                inner: Cursor::new(bytes),
                furthest: Arc::clone(&furthest),
            };
            let key = FileKey {
                url: url.into(),
                ..file_key(1, 112)
            };
            let mut f = OpenFile::open(key, OpenedSource::complete(Box::new(spy))).unwrap();
            let read = furthest.load(Ordering::Relaxed);
            assert!(
                read < 200_000 && read < len / 4,
                "{url}: read {read} of {len} bytes to open"
            );
            // The length is visible again for decoding.
            let mut out = Vec::new();
            assert_eq!(f.read(10, &mut out).unwrap(), Chunk::Frames(10));
        }
    }

    #[test]
    fn broken_sources_are_errors_not_panics() {
        let garbage = OpenedSource::complete(Box::new(Cursor::new(vec![0x42_u8; 4_096])));
        assert!(matches!(
            OpenFile::open(file_key(1, 1), garbage),
            Err(AudioError::Decode(_) | AudioError::Source(_))
        ));
        let empty = OpenedSource::complete(Box::new(Cursor::new(Vec::<u8>::new())));
        assert!(OpenFile::open(file_key(1, 1), empty).is_err());
    }

    fn request(from: (u32, u32), to: (u32, u32)) -> PlayRequest {
        PlayRequest {
            reciter_id: 7,
            from: AyahRef {
                surah: from.0,
                ayah: from.1,
            },
            to: Some(AyahRef {
                surah: to.0,
                ayah: to.1,
            }),
            stop_at: None,
            layout: MushafLayout::V2,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            start_paused: false,
            record: true,
        }
    }

    #[test]
    fn continuous_play_marks_every_ayah_on_its_exact_frame() {
        let timings = FixtureTimings::new(7);
        let sources = Arc::new(FixtureSources::new(timings.layout(), 48_000, 1));
        let queue = plan(&request((1, 1), (1, 7)), &timings).unwrap();
        let mut rig = Rig::new(48_000, 2, 750).with_sources(sources);
        rig.out.set_recording(true);
        rig.load(queue.clone(), 0, None, DecodeParams::default())
            .unwrap();
        assert!(rig.run_to_end(30));
        let events = rig.events();
        assert_eq!(events.len(), queue.len() + 1, "{events:#?}");
        let origin = ms_to_frame(queue[0].start_ms, 48_000);
        for (i, (a, seg)) in events.iter().zip(&queue).enumerate() {
            let start = ms_to_frame(seg.start_ms, 48_000);
            assert_eq!(a.marker.kind, MarkerKind::Segment);
            assert_eq!(a.marker.seg_index, i as u32);
            assert_eq!(a.read_frame, a.marker.ring_frame, "applied on its frame");
            assert_eq!(a.marker.ring_frame, start - origin, "ayah {}", i + 1);
            assert_eq!(a.marker.file_pos_us, frame_to_us(start, 48_000));
            assert_eq!(a.marker.rate, MediaRate::new(100, 48_000));
            if i > 0 {
                // Seamless: the marker's frame is the ayah's first source frame, the one before it the previous
                // ayah's last.
                let here = rig.out.played_ring_frame(a.marker.ring_frame).unwrap();
                let before = rig.out.played_ring_frame(a.marker.ring_frame - 1).unwrap();
                assert_eq!(ramp_frame(here[0]), start);
                assert_eq!(ramp_frame(before[1]), start - 1);
            }
        }
        let end = events.last().unwrap();
        assert_eq!(end.marker.kind, MarkerKind::End);
        let last_end = ms_to_frame(queue[6].end_ms, 48_000);
        assert_eq!(end.marker.ring_frame, last_end - origin);
        assert!(matches!(rig.messages.last(), Some(CtlMsg::QueueEnded)));
        assert_eq!(rig.decoder.state(), DecodeState::Ended);
        assert_eq!(rig.out.discarded(), 0);
    }
}
