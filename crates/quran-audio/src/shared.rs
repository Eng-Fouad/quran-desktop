//! What the engine threads share: in-band markers, the exact media rate, the lock-free [`Shared`] atomics, and the
//! messages between `qd-audio-ctl`, `qd-audio-decode` and `qd-audio-out`.
//!
//! Message flow:
//! ```text
//! AudioEngine ──CtlCmd──► qd-audio-ctl ──DecodeCmd──► qd-audio-decode ──rtrb<f32> + rtrb<Marker>──► cpal callback
//!                              ▲   ▲                      │      ▲                                        │
//!                              │   └──── CtlMsg ──────────┘      └──── DecodeCmd::NewOutput ── qd-audio-out
//!                              └──────── CtlMsg (OutputReady/OutputFailed) ─────────────────────────┘
//! callback ──Shared atomics──► qd-audio-tick ──► EventSink
//! ```
//! (`CtlCmd`, the public API's commands, is private to `control.rs`/`engine.rs`.)

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};

use quran_types::{AbLoop, AudioSnapshot, GapSetting, PlaybackStatus};

use crate::{AudioError, FileKey, OpenedSource, Segment};

/// Slots of the marker ring. A Sync marker every ~100 ms plus segment/gap markers keeps a 750 ms ring far below it.
pub const MARKER_RING_SLOTS: usize = 4096;
/// Output time between two Sync markers (pushed at a WSOLA hop boundary).
pub const SYNC_INTERVAL_MS: u32 = 100;
/// Fade in after a flush, and fade out/in around a non-contiguous segment end or an A-B wrap.
pub const FADE_MS: u32 = 4;
/// Pause ramps the gain to 0 over this, then outputs silence without consuming the ring.
pub const PAUSE_RAMP_MS: u32 = 8;
/// Retry period while there is no host or output device, or a rebuild failed.
pub const DEVICE_RETRY_MS: u32 = 2_000;
/// `skip(Previous)` within this of the segment start goes to the previous ayah; later it restarts the current one.
pub const SKIP_RESTART_WINDOW_MS: u32 = 1_500;
/// `SourceProvider::open` reports `buffered_permille == FULLY_BUFFERED` for a complete file.
pub const FULLY_BUFFERED: u32 = 1_000;

/// What a [`Marker`] marks. `repr(u8)` so the callback can publish it in [`Shared::marker_kind`].
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MarkerKind {
    /// Start of a segment (ayah or basmala); also the first marker after every flush.
    Segment = 0,
    /// Start of a gap's silence after an ayah; the highlight stays on the finished ayah, position frozen.
    Gap = 1,
    /// End of the queue; the ticker then sets status `idle`.
    End = 2,
    /// Position refresh only (~every 100 ms); never changes [`Shared::marker_kind`].
    Sync = 3,
}

impl MarkerKind {
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    #[must_use]
    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Segment),
            1 => Some(Self::Gap),
            2 => Some(Self::End),
            3 => Some(Self::Sync),
            _ => None,
        }
    }
}

/// Exact rational rate: file-timeline µs advanced per output frame = `num / den`, with `num = speed_pct · 1_000_000`
/// and `den = 100 · out_rate` (no truncation). `num = 0` during a gap (position frozen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MediaRate {
    pub num: u64,
    pub den: u64,
}

impl MediaRate {
    /// Position frozen (gap silence, or no stream yet).
    pub const FROZEN: Self = Self { num: 0, den: 1 };

    /// The rate for `speed_pct` at `out_rate` Hz. A zero `out_rate` yields [`Self::FROZEN`] (never a zero `den`).
    #[must_use]
    pub const fn new(speed_pct: u32, out_rate: u32) -> Self {
        if out_rate == 0 {
            return Self::FROZEN;
        }
        Self {
            num: speed_pct as u64 * 1_000_000,
            den: 100 * out_rate as u64,
        }
    }

    /// File-timeline µs advanced over `frames` output frames: `frames · num / den`, in 128-bit integers (exact,
    /// saturating at `u64::MAX`, 0 for a zero `den`).
    #[must_use]
    pub const fn advance_us(self, frames: u64) -> u64 {
        if self.den == 0 {
            return 0;
        }
        let us = frames as u128 * self.num as u128 / self.den as u128;
        if us > u64::MAX as u128 {
            u64::MAX
        } else {
            us as u64
        }
    }
}

/// An in-band event at an exact output frame. Pushed by decode into the marker ring; applied by the cpal callback on
/// the exact frame (`ring_frame` counts frames written since the stream's ring was created).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Marker {
    /// Flush generation. Frames and markers of an older generation are discarded by the callback.
    pub generation: u32,
    pub ring_frame: u64,
    pub kind: MarkerKind,
    /// Index into the current queue (`Arc<[Segment]>`).
    pub seg_index: u32,
    /// EXACT file-timeline position at `ring_frame`, from consumed source frames (Sync markers keep it exact).
    pub file_pos_us: u64,
    pub rate: MediaRate,
    /// Plays of the segment started so far, including this one (≥ 1; 0 before any marker): in-band, so the callback
    /// publishes the repeat progress together with the segment it belongs to ([`Shared::repeat_progress`]).
    pub plays: u32,
    /// Passes over the queue started so far, including this one (≥ 1; 0 before any marker).
    pub passes: u32,
}

impl Marker {
    /// The callback's state before the first marker of a stream.
    pub const INITIAL: Self = Self {
        generation: 0,
        ring_frame: 0,
        kind: MarkerKind::Segment,
        seg_index: 0,
        file_pos_us: 0,
        rate: MediaRate::FROZEN,
        plays: 0,
        passes: 0,
    };

    /// Exact file position at output frame `frame` (≥ `ring_frame`): `file_pos_us + (frame − ring_frame) · num / den`.
    #[must_use]
    pub const fn position_at(&self, frame: u64) -> u64 {
        self.file_pos_us
            .saturating_add(self.rate.advance_us(frame.saturating_sub(self.ring_frame)))
    }
}

/// Lock-free state written by the callback/decode threads and read by the ticker and control. Atomics only: the cpal
/// callback must not allocate, lock, log or block.
#[derive(Debug)]
pub struct Shared {
    /// Current flush generation (decode bumps it; the callback drops older frames).
    pub generation: AtomicU32,
    /// Play/pause as heard (the callback ramps the gain on changes).
    pub playing: AtomicBool,
    /// Audible segment.
    pub seg_index: AtomicU32,
    /// [`MarkerKind`] of the audible segment (Segment/Gap/End; Sync never changes it).
    pub marker_kind: AtomicU8,
    /// Position at the start of the last output buffer, on the file timeline.
    pub file_pos_us: AtomicU64,
    /// Output latency (playback instant − callback instant).
    pub out_latency_us: AtomicU64,
    /// Callbacks that found the ring empty while playing.
    pub underruns: AtomicU32,
    /// `f32` bits of the target volume gain (0.0..=1.0).
    pub gain_bits: AtomicU32,
    pub ayah_repeat_left: AtomicU32,
    pub range_repeat_left: AtomicU32,
    /// The audible repeat progress, published by the callback with [`Self::seg_index`] from the same marker, packed into
    /// one word so a reader never sees one segment's counters with another's index ([`RepeatProgress`]).
    pub repeat_progress: AtomicU64,
    /// [`PlaybackStatus`] as `u8` ([`status_to_u8`]).
    pub status: AtomicU8,
}

impl Shared {
    /// Idle, paused, generation 0, gain 1.0.
    #[must_use]
    pub fn new() -> Self {
        Self {
            generation: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            seg_index: AtomicU32::new(0),
            marker_kind: AtomicU8::new(MarkerKind::Segment.as_u8()),
            file_pos_us: AtomicU64::new(0),
            out_latency_us: AtomicU64::new(0),
            underruns: AtomicU32::new(0),
            gain_bits: AtomicU32::new(1.0_f32.to_bits()),
            ayah_repeat_left: AtomicU32::new(0),
            range_repeat_left: AtomicU32::new(0),
            repeat_progress: AtomicU64::new(0),
            status: AtomicU8::new(status_to_u8(PlaybackStatus::Idle)),
        }
    }

    #[must_use]
    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain_bits.load(Ordering::Relaxed))
    }

    /// Stores the target gain, clamped to 0.0..=1.0 (NaN ⇒ 0.0).
    pub fn set_gain(&self, gain: f32) {
        let g = if gain.is_nan() {
            0.0
        } else {
            gain.clamp(0.0, 1.0)
        };
        self.gain_bits.store(g.to_bits(), Ordering::Relaxed);
    }

    #[must_use]
    pub fn status(&self) -> PlaybackStatus {
        status_from_u8(self.status.load(Ordering::Acquire))
    }

    pub fn set_status(&self, status: PlaybackStatus) {
        self.status.store(status_to_u8(status), Ordering::Release);
    }

    /// The audible segment's kind; an unknown value reads as `Segment`.
    #[must_use]
    pub fn marker_kind(&self) -> MarkerKind {
        MarkerKind::from_u8(self.marker_kind.load(Ordering::Acquire)).unwrap_or(MarkerKind::Segment)
    }

    /// The audible repeat progress (see [`RepeatProgress`]).
    #[must_use]
    pub fn repeat_progress(&self) -> RepeatProgress {
        RepeatProgress::unpack(self.repeat_progress.load(Ordering::Acquire))
    }

    /// Publishes the repeat progress of `marker` (the callback, with the segment it publishes).
    pub fn set_repeat_progress(&self, marker: &Marker) {
        let progress = RepeatProgress {
            seg_index: marker.seg_index,
            plays: marker.plays,
            passes: marker.passes,
        };
        self.repeat_progress
            .store(progress.pack(), Ordering::Release);
    }

    /// Latency-compensated audible position on the file timeline (µs).
    #[must_use]
    pub fn audible_us(&self) -> u64 {
        self.file_pos_us
            .load(Ordering::Acquire)
            .saturating_sub(self.out_latency_us.load(Ordering::Relaxed))
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

/// The heard segment's repeat progress: which segment, how many plays of it and passes over the queue have started
/// (each including the current one; 0 before anything is heard). With the repeat counts in force this gives the
/// snapshot's `ayah_repeat_left`/`range_repeat_left` at once, right after a `set_repeat` too (decode applies new counts
/// at the next boundary, but the number of the play being heard does not change). Packed as `seg_index` (32 bits) |
/// `plays` (16) | `passes` (16), the counts saturating: past 65,535 only an infinite repeat counts, and it shows none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct RepeatProgress {
    pub seg_index: u32,
    pub plays: u32,
    pub passes: u32,
}

impl RepeatProgress {
    #[must_use]
    pub fn pack(self) -> u64 {
        let narrow = |n: u32| u64::from(u16::try_from(n).unwrap_or(u16::MAX));
        (u64::from(self.seg_index) << 32) | (narrow(self.plays) << 16) | narrow(self.passes)
    }

    #[must_use]
    pub const fn unpack(word: u64) -> Self {
        Self {
            seg_index: (word >> 32) as u32,
            plays: ((word >> 16) & 0xFFFF) as u32,
            passes: (word & 0xFFFF) as u32,
        }
    }
}

/// [`PlaybackStatus`] → [`Shared::status`] byte.
#[must_use]
pub const fn status_to_u8(status: PlaybackStatus) -> u8 {
    match status {
        PlaybackStatus::Idle => 0,
        PlaybackStatus::Loading => 1,
        PlaybackStatus::Buffering => 2,
        PlaybackStatus::Playing => 3,
        PlaybackStatus::Paused => 4,
        PlaybackStatus::Error => 5,
    }
}

/// Inverse of [`status_to_u8`]; an unknown byte reads as `Error`.
#[must_use]
pub const fn status_from_u8(v: u8) -> PlaybackStatus {
    match v {
        0 => PlaybackStatus::Idle,
        1 => PlaybackStatus::Loading,
        2 => PlaybackStatus::Buffering,
        3 => PlaybackStatus::Playing,
        4 => PlaybackStatus::Paused,
        _ => PlaybackStatus::Error,
    }
}

/// The snapshot of an engine that has played nothing: idle, 100 % speed and volume, no repeats, no gap.
#[must_use]
pub fn idle_snapshot() -> AudioSnapshot {
    AudioSnapshot {
        status: PlaybackStatus::Idle,
        reciter_id: None,
        current: None,
        current_ayah_id: None,
        range: None,
        ayah_repeat: 1,
        ayah_repeat_left: 0,
        range_repeat: 1,
        range_repeat_left: 0,
        gap: GapSetting::None,
        ab_loop: None,
        speed_pct: 100,
        volume_pct: 100,
        file_ms: 0,
        file_duration_ms: 0,
        ayah_from_ms: 0,
        ayah_to_ms: 0,
        buffered_pct: 0,
        device: None,
        basmala_skipped: false,
        error: None,
    }
}

/// Playback parameters that travel with a queue to the decode thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DecodeParams {
    /// 50..=200, step 5; 100 bypasses WSOLA.
    pub speed_pct: u32,
    /// 1..=99, 0 = ∞; Ayah segments only.
    pub ayah_repeat: u32,
    /// 1..=99, 0 = ∞; replays the whole queue (a leading basmala too).
    pub range_repeat: u32,
    pub gap: GapSetting,
    pub ab_loop: Option<AbLoop>,
}

impl Default for DecodeParams {
    fn default() -> Self {
        Self {
            speed_pct: 100,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            ab_loop: None,
        }
    }
}

/// Commands to `qd-audio-out`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OutCmd {
    /// `StreamInvalidated`/`DeviceNotAvailable` from the error callback, or a changed default-device id (ALSA/PulseAudio
    /// polling): drop the stream, open the default device, create a new ring pair and send
    /// [`DecodeCmd::NewOutput`]. `generation` is the **output** generation (streams built so far) the request was
    /// raised for: at most one rebuild per output generation, later requests for a replaced stream are dropped.
    Rebuild { generation: u32 },
    /// `DeviceChanged` (CoreAudio/PipeWire default-device streams were already rerouted): refresh the device label and
    /// latency and emit a state change; never flush or rebuild.
    DeviceChanged,
    /// Drop the stream and exit the thread.
    Shutdown,
}

/// Commands to `qd-audio-decode` (from control, and `NewOutput` from the output thread).
pub enum DecodeCmd {
    /// A new queue (play): flush, open `source` for `queue[start]`, seek to `start_ms` (default: the segment start).
    /// `passes`: the pass over the queue this starts in (1 for a play; a play retried after a failure continues the
    /// pass it failed in, so its range repeats still count).
    Load {
        queue: Arc<[Segment]>,
        start: u32,
        start_ms: Option<u32>,
        passes: u32,
        source: OpenedSource,
        params: DecodeParams,
    },
    /// Reply to [`CtlMsg::NeedSource`].
    SourceReady { key: FileKey, source: OpenedSource },
    /// Reply to [`CtlMsg::NeedSource`] when the file cannot be opened.
    SourceFailed { key: FileKey, error: AudioError },
    /// Flush and continue at the start of `queue[index]` (skip, seek to an ayah).
    Jump { index: u32 },
    /// Flush and start the next pass over the queue at its first segment: Next at the last segment while range repeats
    /// remain (control decides that they do).
    NextPass,
    /// Flush and continue at `file_ms` on the current file's timeline; the segment containing it becomes current.
    Seek { file_ms: u32 },
    /// Flush and re-seek at the audible position with the new speed.
    SetSpeed { speed_pct: u32 },
    /// In-band (no flush): new counts apply from the next segment boundary.
    SetRepeat { ayah_repeat: u32, range_repeat: u32 },
    /// In-band (no flush).
    SetGap(GapSetting),
    /// In-band (no flush): reaching `b_ms` seeks to `a_ms` like a non-contiguous segment end.
    SetAbLoop(Option<AbLoop>),
    /// A stream was (re)built: write into these rings at the device format from now on. Decode flushes and re-seeks to
    /// `resume_at_us` (the last audible position; `None` on the first build).
    NewOutput {
        prod: rtrb::Producer<f32>,
        mprod: rtrb::Producer<Marker>,
        rate: u32,
        channels: u16,
        resume_at_us: Option<u64>,
    },
    /// Drop the queue and its sources; write nothing more until the next `Load`.
    Stop,
    /// Exit the thread.
    Shutdown,
}

/// Messages to `qd-audio-ctl` from the decode and output threads.
#[derive(Debug)]
pub enum CtlMsg {
    /// Decode: the current segment is the last one in its file and less than `prefetch_next_file_ms` remains; open
    /// this file and reply with [`DecodeCmd::SourceReady`]/[`DecodeCmd::SourceFailed`].
    NeedSource(FileKey),
    /// Decode: an unrecoverable decode or seek failure on the current queue (status → error).
    DecodeFailed(AudioError),
    /// Decode: the End marker of the queue was written; its sources can be released.
    QueueEnded,
    /// Output: a stream runs on `device` (its `description()`) at `rate` Hz with `channels` (first build, rebuild or
    /// a `DeviceChanged` relabel).
    OutputReady {
        device: String,
        rate: u32,
        channels: u16,
    },
    /// Output: no host or device, or the (re)build failed; retried every [`DEVICE_RETRY_MS`].
    OutputFailed(AudioError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_are_exact_rationals() {
        // 125 % at 44.1 kHz: 1 s of output frames advances exactly 1.25 s of file time.
        let r = MediaRate::new(125, 44_100);
        assert_eq!(r.advance_us(44_100), 1_250_000);
        assert_eq!(MediaRate::new(100, 48_000).advance_us(48), 1_000);
        assert_eq!(MediaRate::FROZEN.advance_us(1_000_000), 0);
        assert_eq!(MediaRate::new(100, 0), MediaRate::FROZEN);
        assert_eq!(
            MediaRate {
                num: u64::MAX,
                den: 1
            }
            .advance_us(u64::MAX),
            u64::MAX
        );
        assert_eq!(MediaRate { num: 1, den: 0 }.advance_us(10), 0);
    }

    #[test]
    fn markers_extrapolate_from_their_frame() {
        let m = Marker {
            generation: 3,
            ring_frame: 1_000,
            kind: MarkerKind::Sync,
            seg_index: 2,
            file_pos_us: 5_000_000,
            rate: MediaRate::new(150, 48_000),
            plays: 1,
            passes: 1,
        };
        assert_eq!(m.position_at(1_000), 5_000_000);
        assert_eq!(m.position_at(49_000), 6_500_000);
        assert_eq!(
            m.position_at(0),
            5_000_000,
            "frames before the marker never go back"
        );
    }

    #[test]
    fn marker_kinds_and_statuses_round_trip() {
        for k in [
            MarkerKind::Segment,
            MarkerKind::Gap,
            MarkerKind::End,
            MarkerKind::Sync,
        ] {
            assert_eq!(MarkerKind::from_u8(k.as_u8()), Some(k));
        }
        assert_eq!(MarkerKind::from_u8(9), None);
        for s in [
            PlaybackStatus::Idle,
            PlaybackStatus::Loading,
            PlaybackStatus::Buffering,
            PlaybackStatus::Playing,
            PlaybackStatus::Paused,
            PlaybackStatus::Error,
        ] {
            assert_eq!(status_from_u8(status_to_u8(s)), s);
        }
    }

    #[test]
    fn shared_defaults_and_gain() {
        let s = Shared::new();
        assert_eq!(s.status(), PlaybackStatus::Idle);
        assert_eq!(s.marker_kind(), MarkerKind::Segment);
        assert!((s.gain() - 1.0).abs() < f32::EPSILON);
        s.set_gain(1.7);
        assert!((s.gain() - 1.0).abs() < f32::EPSILON);
        s.set_gain(f32::NAN);
        assert!(s.gain().abs() < f32::EPSILON);
        s.file_pos_us.store(10_000, Ordering::Relaxed);
        s.out_latency_us.store(25_000, Ordering::Relaxed);
        assert_eq!(s.audible_us(), 0);
        s.set_status(PlaybackStatus::Buffering);
        assert_eq!(s.status(), PlaybackStatus::Buffering);
    }

    #[test]
    fn repeat_progress_packs_into_one_word() {
        let p = RepeatProgress {
            seg_index: 6_349,
            plays: 3,
            passes: 2,
        };
        assert_eq!(RepeatProgress::unpack(p.pack()), p);
        let huge = RepeatProgress {
            seg_index: u32::MAX,
            plays: 70_000,
            passes: 1,
        };
        assert_eq!(
            RepeatProgress::unpack(huge.pack()),
            RepeatProgress {
                plays: u32::from(u16::MAX),
                ..huge
            }
        );
        let s = Shared::new();
        assert_eq!(s.repeat_progress(), RepeatProgress::default());
        s.set_repeat_progress(&Marker {
            seg_index: 4,
            plays: 2,
            passes: 1,
            ..Marker::INITIAL
        });
        assert_eq!(
            s.repeat_progress(),
            RepeatProgress {
                seg_index: 4,
                plays: 2,
                passes: 1
            }
        );
    }

    #[test]
    fn idle_snapshot_is_idle() {
        let s = idle_snapshot();
        assert_eq!(s.status, PlaybackStatus::Idle);
        assert_eq!((s.speed_pct, s.volume_pct), (100, 100));
        assert!(s.error.is_none() && s.current.is_none());
    }
}
