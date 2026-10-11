//! `qd-audio-ctl`: the command loop (`CtlCmd` from [`crate::AudioEngine`], [`crate::shared::CtlMsg`] from decode and
//! output), the planner call, timings and source open/prefetch, the status machine and the published snapshot
//! (docs/ARCHITECTURE.md §2.3.2, §2.3.6). Owner: WP4c.
//!
//! The only place where `TimingsSource`/`SourceProvider` (blocking; may `block_on`) are called (§0.2).
//!
//! # Status machine (§2.3.6)
//! `idle → loading` (play: timings, plan, start-source open) `→ playing ⇄ paused`; `playing ⇄ buffering` (reported by
//! the ticker: the ring starves while the heard source is incomplete or a source is being opened); any state `→ error`
//! on an unrecoverable failure (the snapshot carries the `AppError`); `stop → idle`; the End marker, once **heard**,
//! `→ idle`. Without an output device the status is `error(NoOutputDevice)`; a play still loads and starts as soon as a
//! device appears.
//!
//! # Exact queue hand-over (the fence)
//! A new play first stops decode (the old audio is dropped at once, with the callback's declick) and then sends decode a
//! *fence*: a `SourceReady` for a key no queue uses, whose source records its own drop. Decode processes commands in
//! order and drops an unneeded source immediately, so once the fence is dropped decode has dropped the previous queue
//! and every message it sent about that queue is already in the channel. Control drains those as stale before it sends
//! the new `Load`, and publishes the new queue to the ticker as valid for every generation after the one in force at
//! that moment. A `NeedSource`, `DecodeFailed` or `QueueEnded` is therefore never attributed to the wrong play, and a
//! segment index is never mapped through the wrong queue. Control keeps serving commands while it waits.
//!
//! # Commands while blocked
//! Planning and opening a source can block on the network. Commands that arrive meanwhile queue up; a newer play or a
//! stop supersedes the play being prepared, a pending pause starts it paused, and a seek, skip or A-B loop sent right
//! after the play is held until the play starts and then applies to it. `pause`, `stop` and `set_volume`
//! also act on the atomics directly in [`crate::AudioEngine`], so they are heard immediately whatever control is doing.
//!
//! A newer play or a stop also **cancels** the play it replaces at once ([`CancelToken`], raised by the engine handle
//! right after it sends the command): a timings fetch or a source open control is blocked in gives up
//! ([`TimingsSource::surah_timings_for`], [`SourceProvider::open_for`]), and so does a read of the play's stream that
//! decode is blocked in (`ReadCancelled`). Control then serves the newer command without waiting for the network, and
//! decode drops the old queue without waiting for a stalled stream's 30 s watchdog, so the fence below completes and a
//! cached surah starts at once.
//!
//! # A file that changed upstream (§2.3.7 rule 7)
//! A source whose length differs from the one its timings were recorded against fails its open with
//! [`AudioError::FileMismatch`], after the glue stored the timings of the server's file. For the first file of a play,
//! control plans again once with them; for a later file (decode's `NeedSource`), decode stops at that file and the
//! play continues from its first ayah, planned with the new timings, instead of failing.
//!
//! # A failed play
//! - **Before it started** (timings, plan, the start source): the snapshot keeps the play's reciter and range while its
//!   error shows, so whoever started it (the window, a media key, the tray) the listener is told what failed.
//! - **Mid-way** (a stream that stalled or went offline, a later file that is offline, a decode error): the play and
//!   what was heard stay in the snapshot, shown paused, and **play** (resume, toggle: the OS media session, the tray)
//!   starts it again where it stopped: the original request planned anew with the repeats and gap in force, from the
//!   segment that was heard, in the pass it was heard in. It is the same play, with the same cancellation.
//!
//! # Positions on the file timeline
//! A seek to a file position (the OS scrubber, a nudge) and an A-B loop are bounded by the run of the heard segment's
//! file in the queue ([`crate::plan::file_run_span`]): the file's audio outside the planned range is never played under
//! the label of its first or last ayah.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Select, Sender, TryRecvError};
use quran_types::limits::{REPEAT, SPEED_PCT, VOLUME_PCT};
use quran_types::{
    AbLoop, AppError, AudioSnapshot, AyahRange, AyahRef, GapSetting, PlayRequest, PlaybackStatus,
    SeekTarget, SkipDirection,
};
use symphonia::core::io::MediaSource;

use crate::dsp::volume_gain;
use crate::output::{Demand, OutMsg, OutputStats};
use crate::plan::{PlannedQueue, Segment, SegmentKind, file_run_span, index_of_ayah, plan_queue};
use crate::shared::{
    CtlMsg, DecodeCmd, DecodeParams, FULLY_BUFFERED, MarkerKind, SKIP_RESTART_WINDOW_MS, Shared,
    idle_snapshot,
};
use crate::ticker::TickerMsg;
use crate::{
    AudioError, CancelToken, EventSink, FileKey, OpenedSource, ReciterFlags, SourceProvider,
    SurahTimingSet, TimingsSource,
};

/// How often control re-checks the fence while a load waits for decode to drop the previous queue: from the first
/// interval, doubling up to the last (decode normally answers in microseconds; a long wait means it is blocked in a
/// stalled stream read of the previous play).
const FENCE_POLL_FIRST: Duration = Duration::from_millis(1);
const FENCE_POLL_MAX: Duration = Duration::from_millis(50);
/// A continuation (rule 7) waits at most this long for the ring to play out what decode already wrote.
const DRAIN_MAX: Duration = Duration::from_millis(1_500);
/// The shortest A-B loop (the frontend's `MIN_AB_MS`): a loop that bounding to the queue makes shorter is ignored.
pub const MIN_AB_LOOP_MS: u32 = 300;

// ---------------------------------------------------------------------------------------------------------------------
// Commands.

/// The public API's commands (engine → control), plus what the ticker hears.
#[derive(Debug)]
pub(crate) enum CtlCmd {
    /// A play, its cancellation (the engine handle cancels it when the next play or a stop is sent) and its number
    /// from [`Hub::announce_play`].
    Play(Box<PlayRequest>, CancelToken, u64),
    Pause,
    Resume,
    Toggle,
    Stop,
    Skip(SkipDirection),
    Seek(SeekTarget),
    SetSpeed(u32),
    SetVolume(u32),
    SetRepeat {
        ayah: u32,
        range: u32,
    },
    SetGap(GapSetting),
    SetAbLoop(Option<AbLoop>),
    Heard(Heard),
    Shutdown,
}

/// Edges the ticker observes at the callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Heard {
    /// The ring starves while the heard source is incomplete (`true`), or flows again (`false`).
    Buffering(bool),
    /// The End marker of generation `generation` was heard.
    Ended { generation: u32 },
}

/// `a` is a later flush generation than `b` (wrapping-aware; decode skips 0 on wrap).
#[must_use]
pub(crate) fn generation_after(a: u32, b: u32) -> bool {
    let d = a.wrapping_sub(b);
    d != 0 && d < u32::MAX / 2
}

// ---------------------------------------------------------------------------------------------------------------------
// The hub: state shared by the engine handle, control and the ticker.

/// One distinct file of the queue.
#[derive(Debug)]
pub(crate) struct ViewFile {
    pub key: FileKey,
    pub duration_ms: u32,
    /// The download progress of the source decode reads (set when control opens it).
    pub buffered: Mutex<Option<Arc<AtomicU32>>>,
}

/// The queue the ticker and the snapshot map `Shared::seg_index` through.
#[derive(Debug)]
pub(crate) struct View {
    pub reciter_id: u32,
    pub queue: Arc<[Segment]>,
    /// Markers of generations after this one belong to `queue`.
    pub valid_after: u32,
    /// Per segment: the ayah's own `[from_ms, to_ms]` (a basmala: its segment).
    pub spans: Vec<(u32, u32)>,
    /// Per segment: its file in `files`.
    pub seg_file: Vec<usize>,
    pub files: Vec<ViewFile>,
}

impl View {
    fn build(
        reciter_id: u32,
        queue: Arc<[Segment]>,
        timings: &[Arc<SurahTimingSet>],
        valid_after: u32,
    ) -> Self {
        let by_surah: HashMap<u16, &SurahTimingSet> =
            timings.iter().map(|t| (t.surah, t.as_ref())).collect();
        let mut index: HashMap<&FileKey, usize> = HashMap::new();
        let mut files: Vec<ViewFile> = Vec::new();
        let mut seg_file = Vec::with_capacity(queue.len());
        let mut spans = Vec::with_capacity(queue.len());
        for seg in queue.iter() {
            let i = *index.entry(&seg.file).or_insert_with(|| {
                let duration_ms = timings
                    .iter()
                    .find(|t| t.file == seg.file)
                    .map_or(0, |t| t.duration_ms);
                files.push(ViewFile {
                    key: seg.file.clone(),
                    duration_ms,
                    buffered: Mutex::new(None),
                });
                files.len() - 1
            });
            seg_file.push(i);
            let span = match seg.kind {
                SegmentKind::Basmala => None,
                SegmentKind::Ayah => by_surah.get(&seg.surah).and_then(|t| {
                    t.ayahs
                        .get(usize::from(seg.ayah).saturating_sub(1))
                        .filter(|a| a.ayah == seg.ayah)
                        .or_else(|| t.ayah(seg.ayah))
                        .map(|a| (a.from_ms, a.to_ms))
                }),
            };
            spans.push(span.unwrap_or((seg.start_ms, seg.end_ms)));
        }
        Self {
            reciter_id,
            queue,
            valid_after,
            spans,
            seg_file,
            files,
        }
    }

    fn file_of(&self, idx: usize) -> Option<&ViewFile> {
        self.seg_file.get(idx).and_then(|&i| self.files.get(i))
    }

    /// Records the download progress of `key`'s newly opened source.
    fn set_buffered(&self, key: &FileKey, buffered: &Arc<AtomicU32>) {
        if let Some(f) = self.files.iter().find(|f| &f.key == key) {
            *f.buffered.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(buffered));
        }
    }
}

/// What is heard right now, mapped through the queue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Live {
    pub generation: u32,
    pub seg_index: u32,
    /// Segment, Gap or End (never Sync).
    pub kind: MarkerKind,
    pub segment_kind: SegmentKind,
    pub reciter_id: u32,
    pub surah: u32,
    /// 0 during the basmala.
    pub ayah: u32,
    pub ayah_id: u32,
    /// Audible, latency-compensated.
    pub file_ms: u32,
    /// 0 = none (always 0 during the basmala: its words are 1:1's).
    pub word_pos: u32,
    pub file_duration_ms: u32,
    pub ayah_from_ms: u32,
    pub ayah_to_ms: u32,
    pub buffered_permille: u32,
    /// Computed from the callback's current state; `false` while a flush is not heard yet (the last known values).
    pub fresh: bool,
}

/// Shared by the engine handle, control and the ticker.
pub(crate) struct Hub {
    pub shared: Arc<Shared>,
    pub stats: Arc<OutputStats>,
    pub sink: Arc<dyn EventSink>,
    /// Control's part of the snapshot; the live fields are overlaid by [`Hub::snapshot`].
    base: RwLock<AudioSnapshot>,
    view: RwLock<Option<Arc<View>>>,
    last_live: Mutex<Option<Live>>,
    /// Speed of the current play (latency compensation of the audible position).
    pub speed_pct: AtomicU32,
    /// `SourceProvider::open` calls in progress: a starving ring then means buffering.
    pub opening: AtomicU32,
    /// The latest play's cancellation (the engine handle replaces it on every play and cancels it on stop).
    play_token: Mutex<CancelToken>,
    /// The number of the latest play announced by [`Hub::announce_play`], written under the `base` write lock.
    plays_announced: AtomicU64,
    /// The WAV sink's marker/tick log.
    #[cfg(debug_assertions)]
    pub log: Option<Arc<crate::sink::EventLog>>,
}

impl Hub {
    pub fn new(shared: Arc<Shared>, stats: Arc<OutputStats>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            shared,
            stats,
            sink,
            base: RwLock::new(idle_snapshot()),
            view: RwLock::new(None),
            last_live: Mutex::new(None),
            speed_pct: AtomicU32::new(100),
            opening: AtomicU32::new(0),
            play_token: Mutex::new(CancelToken::new()),
            plays_announced: AtomicU64::new(0),
            #[cfg(debug_assertions)]
            log: None,
        }
    }

    /// Makes `token` the latest play's and returns the one it replaces (the engine handle cancels that one once the new
    /// play is sent).
    pub fn replace_play_token(&self, token: CancelToken) -> CancelToken {
        std::mem::replace(
            &mut *self
                .play_token
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            token,
        )
    }

    /// Cancels the latest play (stop, shutdown).
    pub fn cancel_play(&self) {
        self.play_token
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .cancel();
    }

    /// Shares the WAV sink's log with the ticker.
    #[cfg(debug_assertions)]
    #[must_use]
    pub fn with_log(mut self, log: Option<Arc<crate::sink::EventLog>>) -> Self {
        self.log = log;
        self
    }

    pub fn view(&self) -> Option<Arc<View>> {
        self.view
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set_view(&self, view: Option<Arc<View>>) {
        *self.view.write().unwrap_or_else(PoisonError::into_inner) = view;
        *self
            .last_live
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn base(&self) -> AudioSnapshot {
        self.base
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Control's snapshot, unless a play was announced that control has not taken in yet (`play_taken`, the number of
    /// the latest play it has): that play's optimistic `loading` stays until control has it, and publishes again.
    /// Without this, whatever control published in between (an output message, a fence poll, its first publish) put
    /// the previous state back, and `audio_play` could return `idle` for the play it had just started. Returns whether
    /// `s` was written.
    fn set_base(&self, s: AudioSnapshot, play_taken: u64) -> bool {
        let mut base = self.base.write().unwrap_or_else(PoisonError::into_inner);
        if self.plays_announced.load(Ordering::Relaxed) > play_taken {
            return false;
        }
        *base = s;
        true
    }

    /// Writes the optimistic part of a play into the snapshot before control picks it up (so `audio_play` returns
    /// `loading`, not the previous state), and returns the play's number, which its `CtlCmd::Play` carries.
    pub fn announce_play(&self, req: &PlayRequest) -> u64 {
        let mut s = self.base.write().unwrap_or_else(PoisonError::into_inner);
        let number = self.plays_announced.fetch_add(1, Ordering::Relaxed) + 1;
        s.status = PlaybackStatus::Loading;
        s.reciter_id = Some(req.reciter_id);
        s.current = None;
        s.current_ayah_id = None;
        s.range = Some(AyahRange {
            from: req.from,
            to: req.to.unwrap_or(req.from),
        });
        s.ayah_repeat = REPEAT.apply(req.ayah_repeat);
        s.range_repeat = REPEAT.apply(req.range_repeat);
        s.ayah_repeat_left = 0;
        s.range_repeat_left = 0;
        s.gap = req.gap.clamped();
        s.ab_loop = None;
        s.file_ms = 0;
        s.basmala_skipped = false;
        s.error = None;
        number
    }

    /// What the callback plays now, through the published queue; the last known values while a flush is not heard yet.
    pub fn live(&self) -> Option<Live> {
        let view = self.view()?;
        let generation = self.shared.generation.load(Ordering::Acquire);
        let heard = self.stats.heard_generation.load(Ordering::Acquire);
        let mut last = self
            .last_live
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if heard == generation
            && generation_after(heard, view.valid_after)
            && let Some(live) = self.compute_live(&view, heard)
        {
            *last = Some(live.clone());
            return Some(live);
        }
        last.clone().map(|mut l| {
            l.fresh = false;
            l
        })
    }

    fn compute_live(&self, view: &View, generation: u32) -> Option<Live> {
        let idx = self.shared.seg_index.load(Ordering::Acquire);
        let seg = view.queue.get(usize::try_from(idx).ok()?)?;
        let kind = self.shared.marker_kind();
        let raw_us = self.shared.file_pos_us.load(Ordering::Acquire);
        let file_us = match kind {
            // Position frozen: nothing to compensate.
            MarkerKind::Gap | MarkerKind::End => raw_us,
            MarkerKind::Segment | MarkerKind::Sync => audible_us(
                raw_us,
                self.shared.out_latency_us.load(Ordering::Relaxed),
                self.speed_pct.load(Ordering::Relaxed),
                seg.start_ms,
            ),
        };
        let file_ms = u32::try_from(file_us / 1_000).unwrap_or(u32::MAX);
        let word_pos = match (seg.kind, kind) {
            (SegmentKind::Ayah, MarkerKind::Segment | MarkerKind::Sync | MarkerKind::Gap) => {
                seg.word_at(file_ms).map_or(0, u32::from)
            }
            _ => 0,
        };
        let idx_usize = usize::try_from(idx).ok()?;
        let (ayah_from_ms, ayah_to_ms) = view
            .spans
            .get(idx_usize)
            .copied()
            .unwrap_or((seg.start_ms, seg.end_ms));
        let file = view.file_of(idx_usize);
        let buffered_permille = file
            .and_then(|f| {
                f.buffered
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                    .map(|b| b.load(Ordering::Relaxed).min(FULLY_BUFFERED))
            })
            .unwrap_or(0);
        Some(Live {
            generation,
            seg_index: idx,
            kind,
            segment_kind: seg.kind,
            reciter_id: view.reciter_id,
            surah: u32::from(seg.surah),
            ayah: u32::from(seg.ayah),
            ayah_id: seg.ayah_id,
            file_ms,
            word_pos,
            file_duration_ms: file.map_or(0, |f| f.duration_ms),
            ayah_from_ms,
            ayah_to_ms,
            buffered_permille,
            fresh: true,
        })
    }

    /// The full snapshot: control's state plus the live position of what is heard.
    pub fn snapshot(&self) -> AudioSnapshot {
        let mut s = self.base();
        if s.status != PlaybackStatus::Idle
            && let Some(live) = self.live()
            && live.kind != MarkerKind::End
        {
            s.current = Some(AyahRef {
                surah: live.surah,
                ayah: live.ayah,
            });
            s.current_ayah_id = Some(live.ayah_id);
            s.file_ms = live.file_ms;
            s.file_duration_ms = live.file_duration_ms;
            s.ayah_from_ms = live.ayah_from_ms;
            s.ayah_to_ms = live.ayah_to_ms;
            s.buffered_pct = live.buffered_permille / 10;
            let (plays, passes) = self.progress_of(live.seg_index);
            let (ayah_left, range_left) = repeats_left(&s, live.segment_kind, plays, passes);
            s.ayah_repeat_left = ayah_left;
            s.range_repeat_left = range_left;
        }
        s
    }

    /// `(plays, passes)` started of segment `seg_index`, as the callback publishes them in-band: `(0, 0)` (counted as
    /// the first) when its progress is another segment's (a torn read, or a flush not heard yet).
    pub fn progress_of(&self, seg_index: u32) -> (u32, u32) {
        let progress = self.shared.repeat_progress();
        if progress.seg_index == seg_index {
            (progress.plays, progress.passes)
        } else {
            (0, 0)
        }
    }
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub")
            .field("shared", &self.shared)
            .field("stats", &self.stats)
            .finish_non_exhaustive()
    }
}

/// `(ayah_repeat_left, range_repeat_left)` of the snapshot: plays (passes) left after the heard one, from the counts in
/// force (`s`, control's: a `set_repeat` shows at once) and the heard progress (`plays`, `passes`, published in-band by
/// the callback: 0 before the first is heard, which counts as the first). 0 when infinite or not applicable (a basmala,
/// an A-B loop).
#[must_use]
pub(crate) fn repeats_left(
    s: &AudioSnapshot,
    segment: SegmentKind,
    plays: u32,
    passes: u32,
) -> (u32, u32) {
    let ayah = if s.ayah_repeat == 0 || segment != SegmentKind::Ayah || s.ab_loop.is_some() {
        0
    } else {
        s.ayah_repeat.saturating_sub(plays.max(1))
    };
    let range = if s.range_repeat == 0 {
        0
    } else {
        s.range_repeat.saturating_sub(passes.max(1))
    };
    (ayah, range)
}

/// The audible position: the published position (start of the last buffer) minus the output latency in file time,
/// never before the start of the segment it is in (so the reported word and ayah agree).
#[must_use]
pub(crate) fn audible_us(raw_us: u64, latency_us: u64, speed_pct: u32, seg_start_ms: u32) -> u64 {
    let latency_file_us = latency_us.saturating_mul(u64::from(speed_pct)) / 100;
    let compensated = raw_us.saturating_sub(latency_file_us);
    let start_us = u64::from(seg_start_ms) * 1_000;
    if raw_us >= start_us {
        compensated.max(start_us)
    } else {
        compensated
    }
}

/// `skip(dir)` at segment `idx` of a queue of `len`, `elapsed_ms` (wall time) into it: the segment to jump to, `None`
/// past the last segment (control then starts the next pass while range repeats remain, else ends the play). Previous
/// within [`SKIP_RESTART_WINDOW_MS`] of the start goes back one segment; later it restarts the current one.
#[must_use]
pub(crate) fn skip_target(
    len: usize,
    idx: usize,
    dir: SkipDirection,
    elapsed_ms: u32,
) -> Option<usize> {
    match dir {
        SkipDirection::Next => (idx + 1 < len).then_some(idx + 1),
        SkipDirection::Previous => {
            if elapsed_ms < SKIP_RESTART_WINDOW_MS && idx > 0 {
                Some(idx - 1)
            } else {
                Some(idx.min(len.saturating_sub(1)))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The control thread.

/// Everything `qd-audio-ctl` needs.
pub(crate) struct ControlParts {
    pub hub: Arc<Hub>,
    pub timings: Arc<dyn TimingsSource>,
    pub sources: Arc<dyn SourceProvider>,
    pub cmd_rx: Receiver<CtlCmd>,
    pub msg_rx: Receiver<CtlMsg>,
    /// Kept so `msg_rx` never disconnects (decode and output may exit first on shutdown).
    pub msg_tx: Sender<CtlMsg>,
    pub decode: Sender<DecodeCmd>,
    pub out: Sender<OutMsg>,
    pub ticker: Sender<TickerMsg>,
}

/// Spawns `qd-audio-ctl`.
///
/// # Errors
/// [`AudioError::Device`] when the OS refuses the thread (never panics, §0.2).
pub(crate) fn spawn(parts: ControlParts) -> Result<JoinHandle<()>, AudioError> {
    let mut control = Control::new(parts);
    // The idle engine is published before the engine handle exists, so before any play is announced: the first state
    // event is always it, and never comes after (or over) a play's `loading`.
    control.publish();
    std::thread::Builder::new()
        .name("qd-audio-ctl".to_owned())
        .spawn(move || control.run())
        .map_err(|e| AudioError::Device(format!("cannot start qd-audio-ctl: {e}")))
}

/// The play in progress.
#[derive(Debug)]
struct Session {
    reciter_id: u32,
    queue: Arc<[Segment]>,
    view: Arc<View>,
    range: AyahRange,
    basmala_skipped: bool,
    /// The End marker was heard: this play is over.
    finished: bool,
    /// Decode failed: this play is over.
    failed: bool,
    /// The request this play was started with (a continuation after a changed file starts from it).
    req: PlayRequest,
    /// This play's cancellation (its sources were opened with it).
    token: CancelToken,
    /// A later file of the queue changed upstream (rule 7): decode stops there, and the play continues from it.
    changed_file: Option<FileKey>,
}

impl Session {
    fn active(&self) -> bool {
        !self.finished && !self.failed
    }

    /// What continues this play at the first segment of `file` from segment `from_index` on: the request (the same
    /// range end, reciter and settings, from that segment's ayah; a basmala's surah from ayah 1), and whether the new
    /// plan's leading basmala is to be dropped because decode already wrote this surah's basmala (it is heard while
    /// the rest is planned).
    fn continuation(
        &self,
        file: &FileKey,
        from_index: usize,
        paused: bool,
    ) -> Option<(PlayRequest, bool)> {
        let index = self
            .queue
            .iter()
            .skip(from_index)
            .position(|s| &s.file == file)
            .map(|i| i + from_index)
            .or_else(|| self.queue.iter().position(|s| &s.file == file))?;
        let seg = self.queue.get(index)?;
        let basmala_written = index
            .checked_sub(1)
            .and_then(|i| self.queue.get(i))
            .is_some_and(|prev| prev.kind == SegmentKind::Basmala && prev.surah == seg.surah);
        let req = PlayRequest {
            from: AyahRef {
                surah: u32::from(seg.surah),
                ayah: u32::from(seg.ayah.max(1)),
            },
            start_paused: paused,
            ..self.req.clone()
        };
        Some((req, basmala_written && seg.kind == SegmentKind::Ayah))
    }
}

/// Where in its queue a play starts when it does not start at the beginning: a failed play retried from the segment
/// that was heard, in the pass it was heard in. Found again by what it plays, because the queue is planned anew (the
/// repeats and gap in force may change the segments' ends).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StartAt {
    kind: SegmentKind,
    surah: u16,
    /// 0 for a basmala.
    ayah: u16,
    passes: u32,
}

impl StartAt {
    /// The index of this start in `queue`: the same segment, else (a basmala no longer planned: its file went offline)
    /// the first ayah of the queue at or after it; 0 when there is none.
    fn index_in(self, queue: &[Segment]) -> usize {
        queue
            .iter()
            .position(|s| s.kind == self.kind && s.surah == self.surah && s.ayah == self.ayah)
            .or_else(|| {
                queue.iter().position(|s| {
                    s.kind == SegmentKind::Ayah && (s.surah, s.ayah) >= (self.surah, self.ayah)
                })
            })
            .unwrap_or(0)
    }
}

/// A play being prepared: planned and opened, waiting for decode to drop the previous queue.
struct PendingLoad {
    fence: u64,
    reciter_id: u32,
    queue: Arc<[Segment]>,
    timings: Vec<Arc<SurahTimingSet>>,
    range: AyahRange,
    basmala_skipped: bool,
    /// The segment decode starts at (`source` is its file's) and the pass it starts in.
    start: usize,
    passes: u32,
    source: OpenedSource,
    req: PlayRequest,
    token: CancelToken,
    /// A continuation waits for what decode already wrote to be heard (the ring to run dry: a new underrun), at most
    /// until this deadline, so the `Load`'s flush cuts nothing: `(underruns when it began, deadline)`.
    drain: Option<(u32, Instant)>,
}

/// What control is preparing (for the snapshot while loading).
#[derive(Clone, Copy, Debug)]
struct Loading {
    reciter_id: u32,
    range: AyahRange,
    basmala_skipped: bool,
}

enum Event {
    Cmd(CtlCmd),
    Msg(CtlMsg),
    /// A fence poll while a load waits.
    Poll,
}

struct Control {
    hub: Arc<Hub>,
    timings: Arc<dyn TimingsSource>,
    sources: Arc<dyn SourceProvider>,
    cmd_rx: Receiver<CtlCmd>,
    msg_rx: Receiver<CtlMsg>,
    _msg_tx: Sender<CtlMsg>,
    decode: Sender<DecodeCmd>,
    out: Sender<OutMsg>,
    ticker: Sender<TickerMsg>,
    /// Commands taken off the channel early (to see whether a play is superseded), served in order.
    pending: VecDeque<CtlCmd>,
    /// The number of the latest announced play served (see [`Hub::set_base`]).
    play_taken: u64,
    /// Seeks, skips and A-B loops that arrived while a play was loading: served once it starts.
    deferred: Vec<CtlCmd>,
    status: PlaybackStatus,
    /// The user wants sound (play/resume) rather than silence (pause).
    want_playing: bool,
    error: Option<AudioError>,
    session: Option<Session>,
    loading: Option<Loading>,
    /// A play that failed before it started (`fail_play`): the snapshot keeps its reciter and range while its error
    /// shows. Cleared by the next play, a stop, and an output failure that replaces the error.
    failed_play: Option<Loading>,
    pending_load: Option<PendingLoad>,
    fence_next: u64,
    /// The current fence poll interval.
    fence_poll: Duration,
    fence_done: Arc<AtomicU64>,
    speed_pct: u32,
    volume_pct: u32,
    ayah_repeat: u32,
    range_repeat: u32,
    gap: GapSetting,
    ab_loop: Option<AbLoop>,
    device: Option<String>,
    /// The output's last failure, until it reports a device again (`OutputReady`).
    output_error: Option<AudioError>,
    published: Option<AudioSnapshot>,
    demand: Option<Demand>,
}

impl Control {
    fn new(p: ControlParts) -> Self {
        let base = p.hub.base();
        Self {
            hub: p.hub,
            timings: p.timings,
            sources: p.sources,
            cmd_rx: p.cmd_rx,
            msg_rx: p.msg_rx,
            _msg_tx: p.msg_tx,
            decode: p.decode,
            out: p.out,
            ticker: p.ticker,
            pending: VecDeque::new(),
            play_taken: 0,
            deferred: Vec::new(),
            status: PlaybackStatus::Idle,
            want_playing: false,
            error: None,
            session: None,
            loading: None,
            failed_play: None,
            pending_load: None,
            fence_next: 0,
            fence_poll: FENCE_POLL_FIRST,
            fence_done: Arc::new(AtomicU64::new(0)),
            speed_pct: base.speed_pct,
            volume_pct: base.volume_pct,
            ayah_repeat: base.ayah_repeat,
            range_repeat: base.range_repeat,
            gap: base.gap,
            ab_loop: None,
            device: None,
            output_error: None,
            published: None,
            demand: None,
        }
    }

    fn run(mut self) {
        self.update_demand(true);
        while let Some(event) = self.next_event() {
            match event {
                Event::Cmd(CtlCmd::Shutdown) => break,
                Event::Cmd(cmd) => {
                    let user = !matches!(cmd, CtlCmd::Heard(_));
                    self.command(cmd);
                    self.try_start_pending();
                    self.publish();
                    self.update_demand(user);
                    if user {
                        self.wake_ticker();
                    }
                }
                Event::Msg(msg) => {
                    self.message(msg);
                    self.try_start_pending();
                    self.publish();
                    self.update_demand(false);
                    self.wake_ticker();
                }
                Event::Poll => {
                    self.try_start_pending();
                    self.publish();
                    self.update_demand(false);
                }
            }
        }
        log::debug!("qd-audio-ctl: exiting");
    }

    /// The next command (queued ones first), message, or a fence poll. `None` when the engine handle is gone.
    fn next_event(&mut self) -> Option<Event> {
        if let Some(cmd) = self.pending.pop_front() {
            return Some(Event::Cmd(cmd));
        }
        loop {
            // Messages first: decode may be waiting for a source.
            if let Ok(msg) = self.msg_rx.try_recv() {
                return Some(Event::Msg(msg));
            }
            match self.cmd_rx.try_recv() {
                Ok(cmd) => return Some(Event::Cmd(cmd)),
                Err(TryRecvError::Disconnected) => return None,
                Err(TryRecvError::Empty) => {}
            }
            let mut sel = Select::new();
            sel.recv(&self.cmd_rx);
            sel.recv(&self.msg_rx);
            if self.pending_load.is_some() {
                if sel.ready_timeout(self.fence_poll).is_err() {
                    self.fence_poll = (self.fence_poll * 2).min(FENCE_POLL_MAX);
                    return Some(Event::Poll);
                }
            } else {
                let _ready = sel.ready();
            }
        }
    }

    /// Moves every queued command into `pending` and tells whether one of them replaces the play being prepared.
    fn superseded(&mut self) -> bool {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            self.pending.push_back(cmd);
        }
        self.pending
            .iter()
            .any(|c| matches!(c, CtlCmd::Play(..) | CtlCmd::Stop | CtlCmd::Shutdown))
    }

    fn command(&mut self, cmd: CtlCmd) {
        match cmd {
            CtlCmd::Play(req, token, number) => {
                self.play_taken = self.play_taken.max(number);
                self.play(*req, token);
            }
            CtlCmd::Pause => self.pause(),
            CtlCmd::Resume => self.resume(),
            CtlCmd::Toggle => {
                if self.want_playing && self.has_play() {
                    self.pause();
                } else {
                    self.resume();
                }
            }
            CtlCmd::Stop => self.stop(),
            // Position commands for a play that is still loading apply to it once it starts (play, then seek).
            cmd @ (CtlCmd::Skip(_) | CtlCmd::Seek(_) | CtlCmd::SetAbLoop(_))
                if self.loading.is_some() =>
            {
                self.deferred.push(cmd);
            }
            CtlCmd::Skip(dir) => self.skip(dir),
            CtlCmd::Seek(target) => self.seek(target),
            CtlCmd::SetSpeed(pct) => self.set_speed(pct),
            CtlCmd::SetVolume(pct) => {
                self.volume_pct = VOLUME_PCT.apply(pct);
                self.hub.shared.set_gain(volume_gain(self.volume_pct));
            }
            CtlCmd::SetRepeat { ayah, range } => {
                self.ayah_repeat = REPEAT.apply(ayah);
                self.range_repeat = REPEAT.apply(range);
                if self.active_session().is_some() {
                    self.to_decode(DecodeCmd::SetRepeat {
                        ayah_repeat: self.ayah_repeat,
                        range_repeat: self.range_repeat,
                    });
                }
            }
            CtlCmd::SetGap(gap) => {
                self.gap = gap.clamped();
                if self.active_session().is_some() {
                    self.to_decode(DecodeCmd::SetGap(self.gap));
                }
            }
            CtlCmd::SetAbLoop(ab) => self.set_ab_loop(ab),
            CtlCmd::Heard(h) => self.heard(h),
            CtlCmd::Shutdown => {}
        }
    }

    // --- play -----------------------------------------------------------------------------------------------------

    fn play(&mut self, req: PlayRequest, token: CancelToken) {
        if self.superseded() {
            log::debug!("audio control: play superseded before it started");
            return;
        }
        // Drop what plays now (the callback declicks), then fence decode.
        self.end_session(true);
        self.prepare(req, token, false, None, None);
    }

    /// Play (resume, toggle) after the play failed mid-way: the play starts again where it stopped (see the module
    /// docs). It is the same play, so it keeps its cancellation: a newer play or a stop cancels it as it would have
    /// cancelled the failed one, and when the engine handle has already cancelled it for a newer play on its way, this
    /// does nothing (that play is served next).
    fn retry(&mut self) {
        if self.superseded() {
            log::debug!("audio control: no retry: a newer play or a stop is waiting");
            return;
        }
        let Some(s) = self.session.as_ref().filter(|s| s.failed) else {
            return;
        };
        if s.token.is_cancelled() {
            return;
        }
        // The segment heard when the play failed (`live` keeps the last values: the view stays with the failed play).
        let at = self.hub.live().and_then(|l| {
            let seg = s.queue.get(usize::try_from(l.seg_index).ok()?)?;
            Some(StartAt {
                kind: seg.kind,
                surah: seg.surah,
                ayah: seg.ayah,
                passes: self.hub.progress_of(l.seg_index).1.max(1),
            })
        });
        let req = PlayRequest {
            start_paused: false,
            ayah_repeat: self.ayah_repeat,
            range_repeat: self.range_repeat,
            gap: self.gap,
            ..s.req.clone()
        };
        let (token, from) = (s.token.clone(), s.range.from);
        match at {
            Some(at) => log::info!(
                "audio control: playing the failed play again from {}:{} (pass {})",
                at.surah,
                at.ayah,
                at.passes
            ),
            None => log::info!("audio control: playing the failed play again from its start"),
        }
        // Decode dropped the failed queue when it failed, and the callback is silent. The failed play and its view stay
        // until the new queue loads: what was heard still shows while it loads, and when it fails again before it
        // starts (still offline) the failed play stays as it was, so the next Play tries again from the same place.
        self.prepare(req, token, false, None, at);
        self.keep_range_from(from);
    }

    /// Continues the current play from `req.from` (a later file changed upstream): the same play and token, re-planned
    /// with the timings the glue just stored. Decode already dropped the queue at that file; what it wrote before plays
    /// on (no stop, the view kept) while the rest is planned, and the new queue is loaded once that has been heard
    /// (`drain`). `skip_basmala`: the surah's basmala was among it.
    fn continue_play(&mut self, req: PlayRequest, token: CancelToken, skip_basmala: bool) {
        // The range shown stays the one the listener asked for.
        let from = self.session.as_ref().map(|s| s.range.from);
        self.session = None;
        let drain = (
            self.hub.shared.underruns.load(Ordering::Acquire),
            Instant::now() + DRAIN_MAX,
        );
        self.prepare(req, token, skip_basmala, Some(drain), None);
        if let Some(from) = from {
            self.keep_range_from(from);
        }
    }

    /// The range shown starts at `from` (the one the listener asked for) while a play that continues an earlier one is
    /// prepared, plays, or has failed.
    fn keep_range_from(&mut self, from: AyahRef) {
        let ranges = [
            self.pending_load.as_mut().map(|p| &mut p.range),
            self.loading.as_mut().map(|l| &mut l.range),
            self.failed_play.as_mut().map(|f| &mut f.range),
        ];
        for range in ranges.into_iter().flatten() {
            range.from = from;
        }
    }

    /// Plans and opens a play (blocking: may fetch; gives up when `token` is cancelled), then waits for the fence (and
    /// for `drain`, see [`PendingLoad::drain`]). `skip_basmala` drops the plan's leading basmala; `start_at` starts the
    /// play at a later segment of its queue (a retry).
    fn prepare(
        &mut self,
        req: PlayRequest,
        token: CancelToken,
        skip_basmala: bool,
        drain: Option<(u32, Instant)>,
        start_at: Option<StartAt>,
    ) {
        let fence = self.send_fence();
        self.status = PlaybackStatus::Loading;
        self.error = None;
        self.failed_play = None;
        self.want_playing = !req.start_paused;
        self.ayah_repeat = REPEAT.apply(req.ayah_repeat);
        self.range_repeat = REPEAT.apply(req.range_repeat);
        self.gap = req.gap.clamped();
        self.ab_loop = None;
        self.loading = Some(Loading {
            reciter_id: req.reciter_id,
            range: AyahRange {
                from: req.from,
                to: req.to.unwrap_or(req.from),
            },
            basmala_skipped: false,
        });
        self.publish();
        self.update_demand(true);
        self.wake_ticker();

        // Timings and plan (blocking: may fetch).
        let mut recorder = Recorder::new(Arc::clone(&self.timings), token.clone());
        let mut planned = match plan_queue(&req, &recorder) {
            Ok(planned) => planned,
            Err(e) => return self.fail_play(e),
        };
        if self.superseded() {
            log::debug!("audio control: play superseded while planning");
            return;
        }
        if skip_basmala
            && planned
                .segments
                .first()
                .is_some_and(|s| s.kind == SegmentKind::Basmala)
        {
            planned.segments.remove(0);
        }
        // The start source (blocking: may connect). An offline basmala is skipped, not the play (§2.3.3). A file that
        // changed upstream (rule 7) is planned again once, with the timings the glue stored for the server's file.
        let mut replanned = false;
        let (start, source) = loop {
            let start = start_at.map_or(0, |at| at.index_in(&planned.segments));
            let Some(first) = planned.segments.get(start) else {
                return self.fail_play(AudioError::Invalid("empty play queue".to_owned()));
            };
            let (key, kind) = (first.file.clone(), first.kind);
            match self.open_source(&key, &token) {
                Ok(source) => break (start, source),
                Err(AudioError::Offline(why)) if kind == SegmentKind::Basmala => {
                    log::info!("audio control: basmala offline ({why}); starting at the ayah");
                    if planned.skip_basmalas_in(&key) == 0 {
                        return self.fail_play(AudioError::Offline(why));
                    }
                }
                Err(AudioError::FileMismatch(why)) if !replanned => {
                    log::info!("audio control: {why}; planning again with the refreshed timings");
                    replanned = true;
                    if self.superseded() {
                        log::debug!("audio control: play superseded before it was planned again");
                        return;
                    }
                    recorder = Recorder::new(Arc::clone(&self.timings), token.clone());
                    planned = match plan_queue(&req, &recorder) {
                        Ok(planned) => planned,
                        Err(e) => return self.fail_play(e),
                    };
                }
                Err(e) => return self.fail_play(e),
            }
        };
        if self.superseded() {
            log::debug!("audio control: play superseded while opening its source");
            return;
        }
        let PlannedQueue {
            segments,
            basmala_skipped,
        } = planned;
        let range = AyahRange {
            from: req.from,
            to: segments
                .iter()
                .rev()
                .find(|s| s.kind == SegmentKind::Ayah)
                .map_or(req.to.unwrap_or(req.from), Segment::ayah_ref),
        };
        self.loading = Some(Loading {
            reciter_id: req.reciter_id,
            range,
            basmala_skipped,
        });
        self.fence_poll = FENCE_POLL_FIRST;
        self.pending_load = Some(PendingLoad {
            fence,
            reciter_id: req.reciter_id,
            queue: Arc::from(segments),
            timings: recorder.into_seen(),
            range,
            basmala_skipped,
            start,
            passes: start_at.map_or(1, |at| at.passes),
            source,
            req,
            token,
            drain,
        });
    }

    /// Sends `Load` once decode has dropped the previous queue (the fence).
    fn try_start_pending(&mut self) {
        let Some(fence) = self.pending_load.as_ref().map(|p| p.fence) else {
            return;
        };
        if self.fence_done.load(Ordering::Acquire) < fence {
            return;
        }
        if let Some((underruns, deadline)) = self.pending_load.as_ref().and_then(|p| p.drain)
            && self.hub.shared.underruns.load(Ordering::Acquire) == underruns
            && Instant::now() < deadline
        {
            return;
        }
        let Some(p) = self.pending_load.take() else {
            return;
        };
        // Everything decode sent before the fence concerns the dropped queue.
        while let Ok(msg) = self.msg_rx.try_recv() {
            match msg {
                CtlMsg::OutputReady { .. } | CtlMsg::OutputFailed(_) => self.message(msg),
                stale => log::debug!("audio control: stale decode message dropped: {stale:?}"),
            }
        }
        let valid_after = self.hub.shared.generation.load(Ordering::Acquire);
        let view = Arc::new(View::build(
            p.reciter_id,
            Arc::clone(&p.queue),
            &p.timings,
            valid_after,
        ));
        if let Some(start) = p.queue.get(p.start) {
            view.set_buffered(&start.file, &p.source.buffered_permille);
        }
        self.hub.set_view(Some(Arc::clone(&view)));
        // A pause that arrived meanwhile starts the play paused (it is served right after, as a no-op).
        let _superseded = self.superseded();
        if self.pending.iter().any(|c| matches!(c, CtlCmd::Pause)) {
            self.want_playing = false;
        }
        self.to_decode(DecodeCmd::Load {
            queue: Arc::clone(&p.queue),
            start: u32::try_from(p.start).unwrap_or(0),
            start_ms: None,
            passes: p.passes,
            source: p.source,
            params: DecodeParams {
                speed_pct: self.speed_pct,
                ayah_repeat: self.ayah_repeat,
                range_repeat: self.range_repeat,
                gap: self.gap,
                ab_loop: None,
            },
        });
        self.session = Some(Session {
            reciter_id: p.reciter_id,
            queue: p.queue,
            view,
            range: p.range,
            basmala_skipped: p.basmala_skipped,
            finished: false,
            failed: false,
            req: p.req,
            token: p.token,
            changed_file: None,
        });
        self.loading = None;
        for cmd in self.deferred.drain(..).rev() {
            self.pending.push_front(cmd);
        }
        self.hub
            .shared
            .playing
            .store(self.want_playing, Ordering::Release);
        self.status = self.running_status();
        log::info!(
            "audio control: playing {} segment(s) (reciter {})",
            self.session.as_ref().map_or(0, |s| s.queue.len()),
            p.reciter_id
        );
    }

    fn fail_play(&mut self, e: AudioError) {
        if self.superseded() {
            log::debug!("audio control: a superseded play failed: {e}");
            return;
        }
        log::warn!("audio control: play failed: {e}");
        // What failed stays in the snapshot with the error, whoever started the play.
        self.failed_play = self.loading.take().or_else(|| {
            self.pending_load.as_ref().map(|p| Loading {
                reciter_id: p.reciter_id,
                range: p.range,
                basmala_skipped: p.basmala_skipped,
            })
        });
        self.pending_load = None;
        self.deferred.clear();
        self.want_playing = false;
        self.hub.shared.playing.store(false, Ordering::Release);
        self.status = PlaybackStatus::Error;
        self.error = Some(e.clone());
        self.hub.sink.error(&e);
    }

    /// Silences and drops the current play (and any play being prepared). `cancel`: the play is over, so its blocked
    /// work and its sources' waiting reads give up (the engine handle normally did that already); a continuation keeps
    /// the play's token.
    fn end_session(&mut self, cancel: bool) {
        self.hub.shared.playing.store(false, Ordering::Release);
        if cancel {
            if let Some(s) = &self.session {
                s.token.cancel();
            }
            if let Some(p) = &self.pending_load {
                p.token.cancel();
            }
        }
        self.to_decode(DecodeCmd::Stop);
        self.session = None;
        self.loading = None;
        self.pending_load = None;
        self.deferred.clear();
        self.hub.set_view(None);
    }

    /// A fence after everything sent to decode so far (see the module docs). Returns its token.
    fn send_fence(&mut self) -> u64 {
        self.fence_next += 1;
        let token = self.fence_next;
        let source = OpenedSource::complete(Box::new(FenceSource {
            token,
            done: Arc::clone(&self.fence_done),
        }));
        self.to_decode(DecodeCmd::SourceReady {
            key: fence_key(token),
            source,
        });
        token
    }

    // --- transport ------------------------------------------------------------------------------------------------

    fn pause(&mut self) {
        self.want_playing = false;
        self.hub.shared.playing.store(false, Ordering::Release);
        if matches!(
            self.status,
            PlaybackStatus::Playing | PlaybackStatus::Buffering
        ) {
            self.status = PlaybackStatus::Paused;
        }
    }

    fn resume(&mut self) {
        if self.loading.is_some() {
            self.want_playing = true;
            return;
        }
        // A play that failed mid-way starts again where it stopped.
        if self.session.as_ref().is_some_and(|s| s.failed) {
            self.retry();
            return;
        }
        if self.active_session().is_none() {
            log::debug!("audio control: resume without a play");
            return;
        }
        self.want_playing = true;
        self.hub.shared.playing.store(true, Ordering::Release);
        if self.status == PlaybackStatus::Paused {
            self.status = PlaybackStatus::Playing;
        }
    }

    fn stop(&mut self) {
        self.end_session(true);
        self.want_playing = false;
        self.ab_loop = None;
        self.status = PlaybackStatus::Idle;
        self.error = None;
        self.failed_play = None;
        self.settle_idle();
    }

    /// Idle without a device is `error(NoOutputDevice)` (§2.3.2).
    fn settle_idle(&mut self) {
        if let Some(e) = &self.output_error
            && self.error.is_none()
        {
            self.status = PlaybackStatus::Error;
            self.error = Some(e.clone());
        }
    }

    fn skip(&mut self, dir: SkipDirection) {
        let Some(len) = self.active_session().map(|s| s.queue.len()) else {
            return;
        };
        let (idx, elapsed_ms) = self.heard_position();
        match skip_target(len, idx, dir, elapsed_ms) {
            Some(index) => self.jump(index),
            // What the end of the last segment would do: the next pass while range repeats remain (the snapshot's
            // `range_repeat_left`, which the OS media session offers Next by), else the end of the play.
            None if self.passes_remain() => {
                log::debug!("audio control: next at the last segment starts the next pass");
                self.to_decode(DecodeCmd::NextPass);
            }
            None => {
                log::debug!("audio control: next at the last segment ends the play");
                self.stop();
            }
        }
    }

    /// Whether a pass over the queue follows the one being heard (infinite range repeats, or fewer passes started than
    /// asked for). The pass is the callback's in-band progress, whichever segment it was published for: the callback
    /// publishes a buffer's segment just before its progress, and the pass only changes at the queue's first segment.
    fn passes_remain(&self) -> bool {
        let passes = self.hub.shared.repeat_progress().passes.max(1);
        self.range_repeat == 0 || passes < self.range_repeat
    }

    /// The heard segment and how long (wall time) it has played.
    fn heard_position(&self) -> (usize, u32) {
        let Some(live) = self.hub.live() else {
            return (0, 0);
        };
        let idx = usize::try_from(live.seg_index).unwrap_or(0);
        let start = self
            .active_session()
            .and_then(|s| s.queue.get(idx))
            .map_or(0, |s| s.start_ms);
        let elapsed_file = u64::from(live.file_ms.saturating_sub(start));
        let elapsed = elapsed_file * 100 / u64::from(self.speed_pct.max(1));
        (idx, u32::try_from(elapsed).unwrap_or(u32::MAX))
    }

    fn jump(&mut self, index: usize) {
        let Ok(index) = u32::try_from(index) else {
            return;
        };
        self.to_decode(DecodeCmd::Jump { index });
    }

    fn seek(&mut self, target: SeekTarget) {
        let Some(queue) = self.active_session().map(|s| Arc::clone(&s.queue)) else {
            log::debug!("audio control: seek without a play");
            return;
        };
        match target {
            SeekTarget::Ayah { ayah_id } => match index_of_ayah(&queue, ayah_id) {
                Some(index) => self.jump(index),
                None => log::info!("audio control: ayah {ayah_id} is outside the playing range"),
            },
            SeekTarget::FileMs { ms } => self.seek_file(ms),
            SeekTarget::RelativeMs { delta_ms } => {
                let Some(base) = self.hub.live().map(|l| l.file_ms) else {
                    log::debug!("audio control: relative seek before anything was heard");
                    return;
                };
                let to = (i64::from(base) + i64::from(delta_ms)).clamp(0, i64::from(u32::MAX));
                self.seek_file(u32::try_from(to).unwrap_or(0));
            }
        }
    }

    /// A seek on the heard file's timeline. Decode bounds it to the queue's run of that file
    /// ([`crate::plan::seek_in_run`]): before it, the run's start (the start of the range for the OS scrubber dragged
    /// to 0, a nudge back at the first ayah); past it, its end (which ends the run's last segment at once).
    fn seek_file(&mut self, file_ms: u32) {
        self.to_decode(DecodeCmd::Seek { file_ms });
    }

    /// The span of the heard file that the queue plays around the heard segment ([`file_run_span`]); before anything
    /// is heard, the first segment's.
    fn heard_run(&self, queue: &[Segment]) -> Option<(u32, u32)> {
        let idx = self
            .hub
            .live()
            .and_then(|l| usize::try_from(l.seg_index).ok())
            .unwrap_or(0);
        file_run_span(queue, idx)
    }

    fn set_speed(&mut self, pct: u32) {
        let pct = SPEED_PCT.apply(pct);
        if pct == self.speed_pct {
            return;
        }
        self.speed_pct = pct;
        self.hub.speed_pct.store(pct, Ordering::Relaxed);
        if self.active_session().is_some() {
            self.to_decode(DecodeCmd::SetSpeed { speed_pct: pct });
        }
    }

    /// A loop on the heard file's timeline, bounded to the queue's run of that file ([`file_run_span`]: the snapshot
    /// reports the loop that plays). An inverted loop, or one that the bounds leave shorter than [`MIN_AB_LOOP_MS`]
    /// (set outside the range), is ignored, which clears the loop in force.
    fn set_ab_loop(&mut self, ab: Option<AbLoop>) {
        let Some(queue) = self.active_session().map(|s| Arc::clone(&s.queue)) else {
            // A loop binds to the file being heard: nothing to bind to.
            self.ab_loop = None;
            return;
        };
        let ab = ab.and_then(|asked| {
            let (start, end) = self.heard_run(&queue).unwrap_or((0, u32::MAX));
            let bounded = AbLoop {
                a_ms: asked.a_ms.clamp(start, end),
                b_ms: asked.b_ms.clamp(start, end),
            };
            if asked.b_ms <= asked.a_ms
                || bounded.b_ms.saturating_sub(bounded.a_ms) < MIN_AB_LOOP_MS
            {
                log::warn!(
                    "audio control: ignoring A-B loop {}..{} ms (the queue plays {start}..{end} ms of this file)",
                    asked.a_ms,
                    asked.b_ms
                );
                return None;
            }
            if bounded != asked {
                log::debug!(
                    "audio control: A-B loop {}..{} ms bounded to {}..{} ms",
                    asked.a_ms,
                    asked.b_ms,
                    bounded.a_ms,
                    bounded.b_ms
                );
            }
            Some(bounded)
        });
        self.ab_loop = ab;
        self.to_decode(DecodeCmd::SetAbLoop(ab));
    }

    fn heard(&mut self, h: Heard) {
        match h {
            Heard::Buffering(true) if self.status == PlaybackStatus::Playing => {
                self.status = PlaybackStatus::Buffering;
            }
            Heard::Buffering(false) if self.status == PlaybackStatus::Buffering => {
                self.status = PlaybackStatus::Playing;
            }
            Heard::Buffering(_) => {}
            Heard::Ended { generation } => {
                let Some(s) = self.session.as_mut() else {
                    return;
                };
                if !s.active() || !generation_after(generation, s.view.valid_after) {
                    return;
                }
                s.finished = true;
                log::info!("audio control: the play ended");
                self.want_playing = false;
                self.hub.shared.playing.store(false, Ordering::Release);
                self.ab_loop = None;
                self.status = PlaybackStatus::Idle;
                self.error = None;
                self.settle_idle();
            }
        }
    }

    // --- messages ------------------------------------------------------------------------------------------------

    fn message(&mut self, msg: CtlMsg) {
        match msg {
            CtlMsg::NeedSource(key) => self.need_source(key),
            CtlMsg::DecodeFailed(e) => {
                // A newer play or a stop is already waiting (it may have caused this, by cancelling the play's
                // reads): it ends this play anyway, and the failure must not show on its successor.
                if self.superseded() {
                    log::debug!("audio control: decode failure of a play being replaced: {e}");
                    return;
                }
                let paused = !self.want_playing;
                let (ayah_repeat, range_repeat, gap) =
                    (self.ayah_repeat, self.range_repeat, self.gap);
                let heard =
                    usize::try_from(self.hub.live().map_or(0, |l| l.seg_index)).unwrap_or(0);
                let Some(s) = self.session.as_mut().filter(|s| s.active()) else {
                    log::debug!("audio control: decode failure without a play: {e}");
                    return;
                };
                // A later file changed upstream (rule 7): decode stopped at it; the play goes on from there with the
                // timings the glue stored for the server's file.
                if matches!(e, AudioError::FileMismatch(_))
                    && let Some(file) = s.changed_file.take()
                    && let Some((req, skip_basmala)) = s.continuation(&file, heard, paused)
                {
                    log::info!(
                        "audio control: {e}; continuing from {}:{} with the refreshed timings",
                        req.from.surah,
                        req.from.ayah
                    );
                    let token = s.token.clone();
                    let req = PlayRequest {
                        ayah_repeat,
                        range_repeat,
                        gap,
                        ..req
                    };
                    return self.continue_play(req, token, skip_basmala);
                }
                s.failed = true;
                log::warn!("audio control: playback failed: {e}");
                self.want_playing = false;
                self.hub.shared.playing.store(false, Ordering::Release);
                self.status = PlaybackStatus::Error;
                self.error = Some(e.clone());
                self.hub.sink.error(&e);
            }
            // The End marker is in the ring; the play ends when it is heard (`Heard::Ended`).
            CtlMsg::QueueEnded => log::debug!("audio control: decode reached the end of the queue"),
            CtlMsg::OutputReady { device, .. } => {
                // A new stream or a reroute (`DeviceChanged`): always a state change (§2.3.6), even under the same
                // label.
                self.published = None;
                self.device = Some(device);
                self.output_error = None;
                if matches!(
                    self.error,
                    Some(AudioError::NoOutputDevice | AudioError::Device(_))
                ) {
                    self.error = None;
                    if self.status == PlaybackStatus::Error {
                        self.status = if self.loading.is_some() {
                            PlaybackStatus::Loading
                        } else if self.active_session().is_some() {
                            self.running_status()
                        } else {
                            PlaybackStatus::Idle
                        };
                    }
                }
            }
            CtlMsg::OutputFailed(e) => {
                self.output_error = Some(e.clone());
                if self.session.as_ref().is_some_and(|s| s.failed) {
                    return;
                }
                log::warn!("audio control: no audio output: {e}");
                self.status = PlaybackStatus::Error;
                // The device's error replaces a failed play's: its range goes with it.
                self.failed_play = None;
                self.error = Some(e.clone());
                self.hub.sink.error(&e);
            }
        }
    }

    /// Decode needs the next file: open it (blocking) and answer.
    fn need_source(&mut self, key: FileKey) {
        let Some(s) = self.active_session() else {
            log::debug!("audio control: source request without a play ignored");
            return;
        };
        if !s.queue.iter().any(|seg| seg.file == key) {
            log::debug!("audio control: stale source request ignored");
            return;
        }
        let basmala_only = s
            .queue
            .iter()
            .filter(|seg| seg.file == key)
            .all(|seg| seg.kind == SegmentKind::Basmala);
        let view = Arc::clone(&s.view);
        let token = s.token.clone();
        let reply = match self.open_source(&key, &token) {
            Ok(source) => {
                view.set_buffered(&key, &source.buffered_permille);
                DecodeCmd::SourceReady { key, source }
            }
            Err(error) => {
                if basmala_only && matches!(error, AudioError::Offline(_)) {
                    log::info!("audio control: basmala file offline: the basmala is skipped");
                    if let Some(s) = self.session.as_mut() {
                        s.basmala_skipped = true;
                    }
                }
                if matches!(error, AudioError::FileMismatch(_)) {
                    // Decode fails the queue when it reaches this file; the play then continues from it.
                    log::info!(
                        "audio control: {error}; the play continues from that file when it gets there"
                    );
                    if let Some(s) = self.session.as_mut() {
                        s.changed_file = Some(key.clone());
                    }
                }
                DecodeCmd::SourceFailed { key, error }
            }
        };
        self.to_decode(reply);
    }

    /// `SourceProvider::open_for` the play of `token` (blocking; gives up when the play is cancelled), counted in
    /// [`Hub::opening`] so a starving ring reads as buffering.
    fn open_source(&self, key: &FileKey, token: &CancelToken) -> Result<OpenedSource, AudioError> {
        self.hub.opening.fetch_add(1, Ordering::AcqRel);
        let result = self.sources.open_for(key, token);
        self.hub.opening.fetch_sub(1, Ordering::AcqRel);
        result
    }

    // --- state ---------------------------------------------------------------------------------------------------

    fn active_session(&self) -> Option<&Session> {
        self.session.as_ref().filter(|s| s.active())
    }

    /// A play is loading or running.
    fn has_play(&self) -> bool {
        self.loading.is_some() || self.active_session().is_some()
    }

    /// The status of a running play: playing or paused, or `error` while the output is failing.
    fn running_status(&mut self) -> PlaybackStatus {
        if let Some(e) = &self.output_error {
            self.error = Some(e.clone());
            return PlaybackStatus::Error;
        }
        if self.want_playing {
            PlaybackStatus::Playing
        } else {
            PlaybackStatus::Paused
        }
    }

    fn base_snapshot(&self) -> AudioSnapshot {
        let failed = self
            .failed_play
            .filter(|_| self.status == PlaybackStatus::Error);
        let (reciter_id, range, basmala_skipped) = match (&self.loading, &self.session, failed) {
            (Some(l), _, _) => (Some(l.reciter_id), Some(l.range), l.basmala_skipped),
            (None, Some(s), _) => (Some(s.reciter_id), Some(s.range), s.basmala_skipped),
            // A play that failed before it started: what failed, with its error.
            (None, None, Some(f)) => (Some(f.reciter_id), Some(f.range), f.basmala_skipped),
            (None, None, None) => (None, None, false),
        };
        AudioSnapshot {
            status: self.status,
            reciter_id,
            current: None,
            current_ayah_id: None,
            range,
            ayah_repeat: self.ayah_repeat,
            ayah_repeat_left: 0,
            range_repeat: self.range_repeat,
            range_repeat_left: 0,
            gap: self.gap,
            ab_loop: self.ab_loop,
            speed_pct: self.speed_pct,
            volume_pct: self.volume_pct,
            file_ms: 0,
            file_duration_ms: 0,
            ayah_from_ms: 0,
            ayah_to_ms: 0,
            buffered_pct: 0,
            device: self.device.clone(),
            basmala_skipped,
            error: self.error.clone().map(AppError::from),
        }
    }

    /// Publishes the snapshot and emits a state change when control's part changed.
    fn publish(&mut self) {
        let base = self.base_snapshot();
        self.hub.shared.set_status(base.status);
        // Always rewritten (`AudioEngine::play` writes an optimistic `loading` that a superseded play never confirms),
        // except over a play announced and not served yet: control publishes again once it has served it.
        if !self.hub.set_base(base.clone(), self.play_taken) {
            return;
        }
        if self.published.as_ref() == Some(&base) {
            return;
        }
        self.published = Some(base);
        self.hub.sink.state(&self.hub.snapshot());
    }

    /// Tells the output what this state needs. `refresh`: resend even if unchanged (restarts a linger, reopens a
    /// closed stream so a command while paused is heard and published).
    fn update_demand(&mut self, refresh: bool) {
        let demand = match self.status {
            PlaybackStatus::Loading | PlaybackStatus::Playing | PlaybackStatus::Buffering => {
                Demand::Play
            }
            PlaybackStatus::Paused => Demand::Pause,
            PlaybackStatus::Error if self.has_play() => {
                if self.want_playing {
                    Demand::Play
                } else {
                    Demand::Pause
                }
            }
            PlaybackStatus::Error | PlaybackStatus::Idle => Demand::Idle,
        };
        if refresh || self.demand != Some(demand) {
            self.demand = Some(demand);
            if self.out.send(OutMsg::Demand(demand)).is_err() {
                log::debug!("audio control: output thread is gone");
            }
        }
    }

    fn to_decode(&self, cmd: DecodeCmd) {
        if self.decode.send(cmd).is_err() {
            log::debug!("audio control: decode thread is gone");
        }
    }

    fn wake_ticker(&self) {
        let _ = self.ticker.send(TickerMsg::Wake);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers.

/// A [`TimingsSource`] that keeps every timing set the planner loaded (file durations and ayah spans for the snapshot)
/// and loads them for one play ([`TimingsSource::surah_timings_for`]: a fetch gives up when the play is cancelled).
struct Recorder {
    inner: Arc<dyn TimingsSource>,
    token: CancelToken,
    seen: Mutex<Vec<Arc<SurahTimingSet>>>,
}

impl Recorder {
    fn new(inner: Arc<dyn TimingsSource>, token: CancelToken) -> Self {
        Self {
            inner,
            token,
            seen: Mutex::new(Vec::new()),
        }
    }

    fn into_seen(self) -> Vec<Arc<SurahTimingSet>> {
        self.seen
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl TimingsSource for Recorder {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        let t = self
            .inner
            .surah_timings_for(reciter_id, surah, &self.token)?;
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Arc::clone(&t));
        Ok(t)
    }

    fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags {
        self.inner.reciter_flags(reciter_id)
    }

    fn surah_ayah_count(&self, surah: u16) -> u16 {
        self.inner.surah_ayah_count(surah)
    }

    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        self.inner.ayah_id(surah, ayah)
    }
}

/// The key of fence `token`: no queue contains it (surah 0).
fn fence_key(token: u64) -> FileKey {
    FileKey {
        reciter_id: 0,
        surah: 0,
        url: format!("fence://{token}"),
        expected_len: None,
    }
}

/// An empty source that records its drop: decode drops it as soon as it processes the `SourceReady` that carries it.
struct FenceSource {
    token: u64,
    done: Arc<AtomicU64>,
}

impl Read for FenceSource {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}

impl Seek for FenceSource {
    fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
        Ok(0)
    }
}

impl MediaSource for FenceSource {
    fn is_seekable(&self) -> bool {
        false
    }

    fn byte_len(&self) -> Option<u64> {
        Some(0)
    }
}

impl Drop for FenceSource {
    fn drop(&mut self) {
        self.done.fetch_max(self.token, Ordering::Release);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use quran_types::MushafLayout;

    use super::*;
    use crate::fake_out::fixtures::FixtureTimings;
    use crate::plan::plan;
    use crate::{AyahSpan, NullEventSink};

    #[test]
    fn generations_compare_across_the_wrap() {
        assert!(generation_after(2, 1));
        assert!(!generation_after(1, 1));
        assert!(!generation_after(1, 2));
        assert!(generation_after(1, u32::MAX));
        assert!(!generation_after(u32::MAX, 1));
    }

    #[test]
    fn audible_position_compensates_latency_in_file_time() {
        // 40 ms of latency at 150 % is 60 ms of file time.
        assert_eq!(audible_us(10_000_000, 40_000, 150, 0), 9_940_000);
        // Never before the segment the position is in…
        assert_eq!(audible_us(5_010_000, 40_000, 100, 5_000), 5_000_000);
        // …unless the position itself is before it (a lead-in).
        assert_eq!(audible_us(4_990_000, 40_000, 100, 5_000), 4_950_000);
        assert_eq!(audible_us(10_000, 40_000, 100, 0), 0);
    }

    #[test]
    fn skip_targets() {
        use SkipDirection::{Next, Previous};
        assert_eq!(skip_target(5, 2, Next, 0), Some(3));
        assert_eq!(skip_target(5, 4, Next, 0), None);
        assert_eq!(skip_target(5, 2, Previous, 1_499), Some(1));
        assert_eq!(skip_target(5, 2, Previous, 1_500), Some(2));
        assert_eq!(skip_target(5, 0, Previous, 0), Some(0));
    }

    /// A retried play starts at the heard segment, found in the queue planned anew; a heard basmala that is no longer
    /// planned (its file went offline) starts at its surah's first ayah.
    #[test]
    fn retries_find_the_heard_segment_in_the_new_plan() {
        let src = FixtureTimings::new(7);
        let mut req = PlayRequest {
            reciter_id: 7,
            from: AyahRef {
                surah: 112,
                ayah: 3,
            },
            to: Some(AyahRef {
                surah: 113,
                ayah: 2,
            }),
            stop_at: None,
            layout: MushafLayout::V2,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            start_paused: false,
            record: true,
        };
        // 112:3, 112:4, the basmala of 113, 113:1, 113:2.
        let queue = plan(&req, &src).unwrap();
        let at = |kind, surah, ayah| StartAt {
            kind,
            surah,
            ayah,
            passes: 1,
        };
        assert_eq!(at(SegmentKind::Ayah, 112, 3).index_in(&queue), 0);
        assert_eq!(at(SegmentKind::Basmala, 113, 0).index_in(&queue), 2);
        assert_eq!(at(SegmentKind::Ayah, 113, 2).index_in(&queue), 4);
        // Repeat mode changes the segments' ends, not what they play.
        req.ayah_repeat = 3;
        let repeated = plan(&req, &src).unwrap();
        assert_ne!(repeated[3].end_ms, queue[3].end_ms);
        assert_eq!(at(SegmentKind::Ayah, 113, 1).index_in(&repeated), 3);
        // The basmala skipped (offline): the surah's first ayah.
        let mut skipped = PlannedQueue {
            segments: queue.clone(),
            basmala_skipped: false,
        };
        let basmala_file = queue[2].file.clone();
        assert_eq!(skipped.skip_basmalas_in(&basmala_file), 1);
        assert_eq!(
            at(SegmentKind::Basmala, 113, 0).index_in(&skipped.segments),
            2
        );
        assert_eq!(
            skipped.segments[2].ayah_ref(),
            AyahRef {
                surah: 113,
                ayah: 1
            }
        );
        // Not in the queue: the first ayah after it, else the start.
        assert_eq!(at(SegmentKind::Ayah, 2, 1).index_in(&queue), 0);
        assert_eq!(at(SegmentKind::Ayah, 114, 1).index_in(&queue), 0);
    }

    #[test]
    fn views_index_files_spans_and_durations() {
        let src = FixtureTimings::new(7);
        let req = PlayRequest {
            reciter_id: 7,
            from: AyahRef { surah: 1, ayah: 6 },
            to: Some(AyahRef { surah: 2, ayah: 2 }),
            stop_at: None,
            layout: MushafLayout::V2,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            start_paused: false,
            record: true,
        };
        let recorder = Recorder::new(Arc::new(src), CancelToken::new());
        let queue: Arc<[Segment]> = Arc::from(plan(&req, &recorder).unwrap());
        let seen = recorder.into_seen();
        let view = View::build(7, Arc::clone(&queue), &seen, 4);
        // 1:6, 1:7, basmala (surah-1 file), 2:1, 2:2 → two files.
        assert_eq!(queue.len(), 5);
        assert_eq!(view.files.len(), 2);
        assert_eq!(view.seg_file, vec![0, 0, 0, 1, 1]);
        let t1 = FixtureTimings::new(7).timings(1);
        assert_eq!(view.files[0].duration_ms, t1.duration_ms);
        // Continuous segments end at the next ayah; the span keeps the ayah's own end.
        assert_eq!(view.spans[0], (t1.ayahs[5].from_ms, t1.ayahs[5].to_ms));
        assert_ne!(queue[0].end_ms, t1.ayahs[5].to_ms);
        assert_eq!(view.spans[2], (queue[2].start_ms, queue[2].end_ms));
        let buffered = Arc::new(AtomicU32::new(400));
        view.set_buffered(&queue[3].file, &buffered);
        assert!(view.files[1].buffered.lock().unwrap().is_some());
        assert!(view.files[0].buffered.lock().unwrap().is_none());
    }

    fn hub_with(queue: Vec<Segment>, valid_after: u32) -> Hub {
        let hub = Hub::new(
            Arc::new(Shared::new()),
            Arc::new(OutputStats::default()),
            Arc::new(NullEventSink),
        );
        let view = View::build(7, Arc::from(queue), &[], valid_after);
        hub.set_view(Some(Arc::new(view)));
        hub
    }

    fn segment(surah: u16, ayah: u16, start: u32, end: u32) -> Segment {
        Segment {
            kind: SegmentKind::Ayah,
            surah,
            ayah,
            ayah_id: u32::from(ayah),
            file: FileKey {
                reciter_id: 7,
                surah,
                url: "x".to_owned(),
                expected_len: None,
            },
            start_ms: start,
            end_ms: end,
            words: Arc::from(vec![(1, start, start + 100), (2, start + 100, end)]),
        }
    }

    #[test]
    fn live_values_follow_the_heard_generation_only() {
        let hub = hub_with(
            vec![segment(1, 1, 0, 1_000), segment(1, 2, 1_000, 2_000)],
            3,
        );
        assert!(hub.live().is_none(), "nothing heard yet");
        // Heard generation 4 > 3 and current.
        hub.shared.generation.store(4, Ordering::Relaxed);
        hub.stats.heard_generation.store(4, Ordering::Relaxed);
        hub.shared.seg_index.store(1, Ordering::Relaxed);
        hub.shared.file_pos_us.store(1_150_000, Ordering::Relaxed);
        let live = hub.live().unwrap();
        assert!(live.fresh);
        assert_eq!((live.ayah, live.file_ms, live.word_pos), (2, 1_150, 2));
        assert_eq!((live.ayah_from_ms, live.ayah_to_ms), (1_000, 2_000));
        // A flush not heard yet: the last values, not fresh.
        hub.shared.generation.store(5, Ordering::Relaxed);
        hub.shared.seg_index.store(0, Ordering::Relaxed);
        let stale = hub.live().unwrap();
        assert!(!stale.fresh);
        assert_eq!(stale.ayah, 2);
        // A generation from before the view (the previous queue) is never mapped.
        let hub = hub_with(vec![segment(1, 1, 0, 1_000)], 9);
        hub.shared.generation.store(9, Ordering::Relaxed);
        hub.stats.heard_generation.store(9, Ordering::Relaxed);
        assert!(hub.live().is_none());
    }

    #[test]
    fn snapshots_overlay_the_live_position() {
        let hub = hub_with(vec![segment(1, 1, 0, 1_000)], 0);
        hub.shared.generation.store(1, Ordering::Relaxed);
        hub.stats.heard_generation.store(1, Ordering::Relaxed);
        hub.shared.file_pos_us.store(500_000, Ordering::Relaxed);
        // Idle: no overlay.
        assert!(hub.snapshot().current.is_none());
        let mut base = idle_snapshot();
        base.status = PlaybackStatus::Paused;
        assert!(hub.set_base(base, 0));
        let s = hub.snapshot();
        assert_eq!(s.current, Some(AyahRef { surah: 1, ayah: 1 }));
        assert_eq!(s.file_ms, 500);
        // The End marker: nothing current.
        hub.shared
            .marker_kind
            .store(MarkerKind::End.as_u8(), Ordering::Relaxed);
        assert!(hub.snapshot().current.is_none());
    }

    #[test]
    fn announce_play_is_optimistic() {
        let hub = Hub::new(
            Arc::new(Shared::new()),
            Arc::new(OutputStats::default()),
            Arc::new(NullEventSink),
        );
        let req = PlayRequest {
            reciter_id: 7,
            from: AyahRef { surah: 2, ayah: 1 },
            to: None,
            stop_at: None,
            layout: MushafLayout::V2,
            ayah_repeat: 150,
            range_repeat: 2,
            gap: GapSetting::Fixed { ms: 99_999 },
            start_paused: false,
            record: true,
        };
        let number = hub.announce_play(&req);
        assert_eq!(number, 1);
        let s = hub.snapshot();
        assert_eq!(s.status, PlaybackStatus::Loading);
        assert_eq!(s.reciter_id, Some(7));
        assert_eq!(s.ayah_repeat, 99);
        assert_eq!(s.gap, GapSetting::Fixed { ms: 30_000 });
        // Control publishing before it has served that play (its first publish, an output message, a fence poll)
        // leaves the announcement: `audio_play` never returns the previous state for the play it just started.
        assert!(!hub.set_base(idle_snapshot(), 0));
        assert_eq!(hub.snapshot().status, PlaybackStatus::Loading);
        // Served (control publishes again), control's snapshot is the truth; a later announcement is protected anew.
        assert!(hub.set_base(idle_snapshot(), number));
        assert_eq!(hub.snapshot().status, PlaybackStatus::Idle);
        assert_eq!(hub.announce_play(&req), 2);
        assert!(!hub.set_base(idle_snapshot(), number));
        assert_eq!(hub.snapshot().status, PlaybackStatus::Loading);
    }

    #[test]
    fn fences_record_their_drop() {
        let done = Arc::new(AtomicU64::new(0));
        let mut f = FenceSource {
            token: 3,
            done: Arc::clone(&done),
        };
        let mut buf = [0_u8; 4];
        assert_eq!(f.read(&mut buf).unwrap(), 0);
        assert_eq!(f.seek(SeekFrom::Start(9)).unwrap(), 0);
        assert!(!f.is_seekable() && f.byte_len() == Some(0));
        drop(f);
        assert_eq!(done.load(Ordering::Relaxed), 3);
        assert_eq!(fence_key(3).surah, 0);
    }

    #[test]
    fn recorder_keeps_what_the_planner_loaded() {
        let r = Recorder::new(Arc::new(FixtureTimings::new(7)), CancelToken::new());
        assert!(r.surah_timings(7, 112).is_ok());
        assert!(r.surah_timings(8, 112).is_err());
        assert_eq!(r.surah_ayah_count(112), 4);
        assert_eq!(r.ayah_id(1, 1), 1);
        assert!(!r.reciter_flags(7).basmala_in_file);
        let seen = r.into_seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].ayahs.first().map(|a: &AyahSpan| a.ayah), Some(1));
    }
}
