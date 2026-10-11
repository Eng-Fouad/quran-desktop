//! Test-only output: drains the rings at a simulated device rate like the cpal callback and records every applied
//! marker with its frame, so tests assert marker frames exactly (±0) without audio hardware (docs/ARCHITECTURE.md
//! §2.3.1, §12.1). Compiled with `cfg(test)` or the `testing` feature only. Owner: WP4b.
//!
//! - [`FakeOut`] runs the §2.3.4 callback algorithm on a ring pair: generation catch-up (discard up to the first
//!   marker of the current generation), copy split at marker frames, pause without consuming, position publication.
//! - [`Rig`] drives a [`Decoder`] and a [`FakeOut`] deterministically on one thread and plays control's part for
//!   `NeedSource` (through a [`SourceProvider`]).
//! - [`fixtures`]: a synthetic [`crate::TimingsSource`] with the real surah sizes, WAV fixtures whose samples encode
//!   their own frame index (so a test can read the exact source position back from the output), a matching
//!   [`SourceProvider`], and silent MPEG-1 Layer III files for the MP3 path.
//!
//! The crate denies panics and slicing outside `cfg(test)`, and this module is also built with the `testing` feature
//! for `tests/`: it reports problems through return values instead.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crossbeam_channel::{Receiver, Sender, unbounded};
use rtrb::{Consumer, RingBuffer};

use crate::decode::{DecodeConfig, Decoder, Pump};
use crate::shared::{
    CtlMsg, DecodeCmd, DecodeParams, MARKER_RING_SLOTS, Marker, MarkerKind, Shared,
};
use crate::{Segment, SourceProvider};

/// A marker as the fake device applied it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Applied {
    pub marker: Marker,
    /// Ring frame the callback was at when it applied the marker (equals `marker.ring_frame` unless the marker was
    /// pushed late, which only Sync markers may be).
    pub read_frame: u64,
    /// Device output frame (all frames rendered so far, silence included) at which it applied.
    pub device_frame: u64,
}

/// A contiguous run of ring frames that reached the device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
    ring_start: u64,
    device_start: u64,
    frames: u64,
}

/// The §2.3.4 callback on a ring pair, rendering into memory.
pub struct FakeOut {
    shared: Arc<Shared>,
    cons: Consumer<f32>,
    mcons: Consumer<Marker>,
    rate: u32,
    channels: usize,
    read: u64,
    device: u64,
    cur: Marker,
    applied: Vec<Applied>,
    discarded: u64,
    underruns: u32,
    record: bool,
    audio: Vec<f32>,
    spans: Vec<Span>,
    scratch: Vec<f32>,
}

impl FakeOut {
    /// A fake device at `rate` Hz with `channels`, and the `NewOutput` command that hands decode its ring pair
    /// (`ring_ms` of frames, 4096 marker slots).
    #[must_use]
    pub fn new(shared: Arc<Shared>, rate: u32, channels: u16, ring_ms: u32) -> (Self, DecodeCmd) {
        Self::with_resume(shared, rate, channels, ring_ms, None)
    }

    /// As [`Self::new`], for a rebuilt output that resumes at `resume_at_us`.
    #[must_use]
    pub fn with_resume(
        shared: Arc<Shared>,
        rate: u32,
        channels: u16,
        ring_ms: u32,
        resume_at_us: Option<u64>,
    ) -> (Self, DecodeCmd) {
        let rate = rate.max(1);
        let ch = usize::from(channels.max(1));
        let frames = usize::try_from(u64::from(ring_ms) * u64::from(rate) / 1_000).unwrap_or(4_096);
        let (prod, cons) = RingBuffer::<f32>::new(frames.max(1) * ch);
        let (mprod, mcons) = RingBuffer::<Marker>::new(MARKER_RING_SLOTS);
        let out = Self {
            shared,
            cons,
            mcons,
            rate,
            channels: ch,
            read: 0,
            device: 0,
            cur: Marker::INITIAL,
            applied: Vec::new(),
            discarded: 0,
            underruns: 0,
            record: false,
            audio: Vec::new(),
            spans: Vec::new(),
            scratch: Vec::new(),
        };
        let cmd = DecodeCmd::NewOutput {
            prod,
            mprod,
            rate,
            channels: channels.max(1),
            resume_at_us,
        };
        (out, cmd)
    }

    /// Records the rendered audio (device output and which ring frame each played frame was).
    pub fn set_recording(&mut self, on: bool) {
        self.record = on;
    }

    #[must_use]
    pub fn rate(&self) -> u32 {
        self.rate
    }

    #[must_use]
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Ring frames consumed (played or discarded).
    #[must_use]
    pub fn read_frame(&self) -> u64 {
        self.read
    }

    /// Device frames rendered (silence included).
    #[must_use]
    pub fn device_frames(&self) -> u64 {
        self.device
    }

    /// Ring frames dropped by generation catch-ups.
    #[must_use]
    pub fn discarded(&self) -> u64 {
        self.discarded
    }

    /// Buffers that found the ring empty while playing.
    #[must_use]
    pub fn underruns(&self) -> u32 {
        self.underruns
    }

    /// Every marker applied so far, in order.
    #[must_use]
    pub fn applied(&self) -> &[Applied] {
        &self.applied
    }

    /// The marker in force.
    #[must_use]
    pub fn current(&self) -> Marker {
        self.cur
    }

    /// The recorded device output (interleaved).
    #[must_use]
    pub fn audio(&self) -> &[f32] {
        &self.audio
    }

    /// The recorded frame that ring frame `ring` produced on the device, if it was played (not discarded) while
    /// recording.
    #[must_use]
    pub fn played_ring_frame(&self, ring: u64) -> Option<&[f32]> {
        let i = self.spans.partition_point(|s| s.ring_start <= ring);
        let span = self.spans.get(i.checked_sub(1)?)?;
        let off = ring.checked_sub(span.ring_start)?;
        if off >= span.frames {
            return None;
        }
        let dev = usize::try_from(span.device_start + off).ok()?;
        self.audio
            .get(dev * self.channels..(dev + 1) * self.channels)
    }

    /// One callback of `frames` device frames. Returns the ring frames played.
    pub fn render(&mut self, frames: usize) -> usize {
        let ch = self.channels;
        let want = self.shared.generation.load(Ordering::Acquire);
        if self.cur.generation != want {
            self.catch_up(want);
        }
        let start_read = self.read;
        let start_marker = self.cur;
        let mut played = 0_usize;
        if self.cur.generation == want && self.shared.playing.load(Ordering::Relaxed) {
            while played < frames {
                self.apply_due(want, played);
                let mut n = (frames - played).min(self.cons.slots() / ch);
                if let Ok(m) = self.mcons.peek()
                    && m.generation == want
                {
                    n = n.min(
                        usize::try_from(m.ring_frame.saturating_sub(self.read))
                            .unwrap_or(usize::MAX),
                    );
                }
                if n == 0 {
                    break;
                }
                let Ok(chunk) = self.cons.read_chunk(n * ch) else {
                    break;
                };
                let (a, b) = chunk.as_slices();
                self.scratch.clear();
                self.scratch.extend_from_slice(a);
                self.scratch.extend_from_slice(b);
                chunk.commit_all();
                if self.record {
                    let device_start = self.device + played as u64;
                    match self.spans.last_mut() {
                        Some(s)
                            if s.ring_start + s.frames == self.read
                                && s.device_start + s.frames == device_start =>
                        {
                            s.frames += n as u64;
                        }
                        _ => self.spans.push(Span {
                            ring_start: self.read,
                            device_start,
                            frames: n as u64,
                        }),
                    }
                    self.audio.extend_from_slice(&self.scratch);
                }
                self.read += n as u64;
                played += n;
            }
            // Markers due exactly at the end of the buffer apply now (the next frame starts with them).
            self.apply_due(want, played);
            if played < frames {
                self.underruns += 1;
            }
        }
        if self.record {
            self.audio
                .resize(self.audio.len() + (frames - played) * ch, 0.0);
        }
        self.device += frames as u64;
        // Publish the position at the start of this buffer (§2.3.4 step 4).
        self.shared
            .file_pos_us
            .store(start_marker.position_at(start_read), Ordering::Release);
        self.shared
            .seg_index
            .store(self.cur.seg_index, Ordering::Release);
        if self.cur.kind != MarkerKind::Sync {
            self.shared
                .marker_kind
                .store(self.cur.kind.as_u8(), Ordering::Release);
        }
        played
    }

    /// Renders until `total` device frames, in buffers of `buffer` frames.
    pub fn render_frames(&mut self, total: u64, buffer: usize) {
        let buffer = buffer.max(1);
        let mut left = total;
        while left > 0 {
            let n = usize::try_from(left).unwrap_or(usize::MAX).min(buffer);
            self.render(n);
            left -= n as u64;
        }
    }

    /// Step 1: drop frames (and stale markers) up to the first marker of generation `want`.
    fn catch_up(&mut self, want: u32) {
        let ch = self.channels;
        loop {
            let Ok(m) = self.mcons.peek().copied() else {
                // No marker of the new generation yet: everything in the ring is stale.
                let n = self.cons.slots() / ch;
                self.discard(n);
                return;
            };
            if m.ring_frame > self.read {
                let n = usize::try_from(m.ring_frame - self.read)
                    .unwrap_or(usize::MAX)
                    .min(self.cons.slots() / ch);
                self.discard(n);
                if self.read < m.ring_frame {
                    return;
                }
            }
            let _ = self.mcons.pop();
            if m.generation == want {
                self.apply(m, 0);
                return;
            }
        }
    }

    fn discard(&mut self, frames: usize) {
        if frames == 0 {
            return;
        }
        if let Ok(chunk) = self.cons.read_chunk(frames * self.channels) {
            chunk.commit_all();
            self.read += frames as u64;
            self.discarded += frames as u64;
        }
    }

    fn apply_due(&mut self, want: u32, played: usize) {
        while let Ok(m) = self.mcons.peek().copied() {
            if m.generation != want || m.ring_frame > self.read {
                break;
            }
            let _ = self.mcons.pop();
            self.apply(m, played);
        }
    }

    fn apply(&mut self, m: Marker, played: usize) {
        self.applied.push(Applied {
            marker: m,
            read_frame: self.read,
            device_frame: self.device + played as u64,
        });
        self.cur = m;
    }
}

impl std::fmt::Debug for FakeOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeOut")
            .field("rate", &self.rate)
            .field("channels", &self.channels)
            .field("read", &self.read)
            .field("device", &self.device)
            .field("applied", &self.applied.len())
            .finish_non_exhaustive()
    }
}

/// A [`Decoder`] and a [`FakeOut`] stepped together on one thread, with control's `NeedSource` answered from a
/// [`SourceProvider`].
pub struct Rig {
    pub decoder: Decoder,
    pub out: FakeOut,
    pub shared: Arc<Shared>,
    ctl_rx: Receiver<CtlMsg>,
    /// Every control message decode sent, in order.
    pub messages: Vec<CtlMsg>,
    sources: Option<Arc<dyn SourceProvider>>,
    /// Answer `NeedSource` immediately (default `true`); tests that answer by hand turn it off.
    pub answer_need_source: bool,
    /// Device buffer size per [`Rig::step`].
    pub buffer_frames: usize,
}

/// Pump iterations allowed without the decoder blocking (catches state-machine loops in tests).
const MAX_PUMPS_PER_STEP: usize = 1_000_000;

impl Rig {
    /// A playing rig at `rate` Hz with `channels` and a `ring_ms` ring (the first `NewOutput` is delivered).
    #[must_use]
    pub fn new(rate: u32, channels: u16, ring_ms: u32) -> Self {
        Self::with_config(DecodeConfig::default(), rate, channels, ring_ms)
    }

    #[must_use]
    pub fn with_config(cfg: DecodeConfig, rate: u32, channels: u16, ring_ms: u32) -> Self {
        let shared = Arc::new(Shared::new());
        shared.playing.store(true, Ordering::Relaxed);
        let (ctl_tx, ctl_rx): (Sender<CtlMsg>, Receiver<CtlMsg>) = unbounded();
        let mut decoder = Decoder::new(cfg, ctl_tx, Arc::clone(&shared));
        let (out, cmd) = FakeOut::new(Arc::clone(&shared), rate, channels, ring_ms);
        decoder.handle(cmd);
        let buffer_frames = usize::try_from(rate / 100).unwrap_or(480).max(1);
        Self {
            decoder,
            out,
            shared,
            ctl_rx,
            messages: Vec::new(),
            sources: None,
            answer_need_source: true,
            buffer_frames,
        }
    }

    /// Opens files through `sources` (for [`Rig::load`] and `NeedSource`).
    #[must_use]
    pub fn with_sources(mut self, sources: Arc<dyn SourceProvider>) -> Self {
        self.sources = Some(sources);
        self
    }

    /// Sends a command to the decoder.
    pub fn cmd(&mut self, cmd: DecodeCmd) {
        self.decoder.handle(cmd);
    }

    /// Opens `queue[start]`'s file and loads the queue (in its first pass). Returns the open error, if any.
    pub fn load(
        &mut self,
        queue: Vec<Segment>,
        start: u32,
        start_ms: Option<u32>,
        params: DecodeParams,
    ) -> Result<(), crate::AudioError> {
        self.load_in_pass(queue, start, start_ms, 1, params)
    }

    /// [`Rig::load`] starting in pass `passes` (a failed play retried where it stopped).
    pub fn load_in_pass(
        &mut self,
        queue: Vec<Segment>,
        start: u32,
        start_ms: Option<u32>,
        passes: u32,
        params: DecodeParams,
    ) -> Result<(), crate::AudioError> {
        let queue: Arc<[Segment]> = Arc::from(queue);
        let Some(sources) = &self.sources else {
            return Err(crate::AudioError::Invalid("rig without sources".to_owned()));
        };
        let Some(seg) = queue.get(start as usize) else {
            return Err(crate::AudioError::Invalid(
                "start outside the queue".to_owned(),
            ));
        };
        let source = sources.open(&seg.file)?;
        self.decoder.handle(DecodeCmd::Load {
            queue,
            start,
            start_ms,
            passes,
            source,
            params,
        });
        Ok(())
    }

    /// Pumps the decoder until it blocks or idles, answering control messages. Returns `false` if the decoder kept
    /// making progress without ever blocking (a state-machine loop).
    pub fn pump(&mut self) -> bool {
        for _ in 0..MAX_PUMPS_PER_STEP {
            let pumped = self.decoder.pump();
            let answered = self.service_messages();
            if pumped != Pump::Progress && !answered {
                self.decoder.publish_progress();
                return true;
            }
        }
        false
    }

    /// Answers pending control messages; returns whether any command was sent back.
    fn service_messages(&mut self) -> bool {
        let mut answered = false;
        while let Ok(msg) = self.ctl_rx.try_recv() {
            if let (CtlMsg::NeedSource(key), true, Some(sources)) =
                (&msg, self.answer_need_source, &self.sources)
            {
                let key = key.clone();
                let cmd = match sources.open(&key) {
                    Ok(source) => DecodeCmd::SourceReady { key, source },
                    Err(error) => DecodeCmd::SourceFailed { key, error },
                };
                self.decoder.handle(cmd);
                answered = true;
            }
            self.messages.push(msg);
        }
        answered
    }

    /// Pump, then render one device buffer. Returns `false` on a decoder loop.
    pub fn step(&mut self) -> bool {
        let ok = self.pump();
        self.out.render(self.buffer_frames);
        self.decoder.publish_progress();
        ok
    }

    /// Steps until `done(self)` or `max_device_frames` rendered. Returns whether `done` became true.
    pub fn run_until(
        &mut self,
        max_device_frames: u64,
        mut done: impl FnMut(&Self) -> bool,
    ) -> bool {
        let limit = self.out.device_frames().saturating_add(max_device_frames);
        while self.out.device_frames() < limit {
            if done(self) {
                return true;
            }
            if !self.step() {
                return false;
            }
        }
        done(self)
    }

    /// Steps until an End marker is applied (at most `max_secs` of device time).
    pub fn run_to_end(&mut self, max_secs: u32) -> bool {
        let max = u64::from(max_secs) * u64::from(self.out.rate());
        self.run_until(max, |r| {
            r.out
                .applied()
                .iter()
                .any(|a| a.marker.kind == MarkerKind::End)
        })
    }

    /// The applied markers except Sync.
    #[must_use]
    pub fn events(&self) -> Vec<Applied> {
        self.out
            .applied()
            .iter()
            .filter(|a| a.marker.kind != MarkerKind::Sync)
            .copied()
            .collect()
    }
}

impl std::fmt::Debug for Rig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Rig")
            .field("decoder", &self.decoder)
            .field("out", &self.out)
            .finish_non_exhaustive()
    }
}

/// Synthetic timings, sources and audio files.
pub mod fixtures {
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex, PoisonError};

    use crate::{
        AudioError, AyahSpan, FileKey, OpenedSource, ReciterFlags, SourceProvider, SurahTimingSet,
        TimingsSource,
    };

    /// Ayahs per surah (Hafs, 6,236 in total).
    pub const SURAH_AYAHS: [u16; 114] = [
        7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98,
        135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
        54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11,
        18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17,
        19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5,
        6,
    ];

    /// Ayah count of `surah` (0 outside 1..=114).
    #[must_use]
    pub fn ayah_count(surah: u16) -> u16 {
        usize::from(surah)
            .checked_sub(1)
            .and_then(|i| SURAH_AYAHS.get(i))
            .copied()
            .unwrap_or(0)
    }

    /// Canonical ayah id of `surah:ayah` (0 when invalid).
    #[must_use]
    pub fn ayah_id(surah: u16, ayah: u16) -> u32 {
        if ayah == 0 || ayah > ayah_count(surah) {
            return 0;
        }
        let before: u32 = SURAH_AYAHS
            .iter()
            .take(usize::from(surah).saturating_sub(1))
            .map(|&n| u32::from(n))
            .sum();
        before + u32::from(ayah)
    }

    /// How the synthetic surah files are laid out: `lead_in_ms` of silence, then ayahs of `ayah_ms + jitter`, each
    /// ending `breath_ms` before the next one starts, then `tail_ms`.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct Layout {
        pub lead_in_ms: u32,
        pub ayah_ms: u32,
        pub breath_ms: u32,
        pub tail_ms: u32,
        pub words_per_ayah: u16,
    }

    impl Default for Layout {
        fn default() -> Self {
            Self {
                lead_in_ms: 200,
                ayah_ms: 1_000,
                breath_ms: 150,
                tail_ms: 400,
                words_per_ayah: 4,
            }
        }
    }

    impl Layout {
        /// Length of ayah `k` (1-based) including its breath: `ayah_ms` plus a deterministic 0–52 ms jitter, so
        /// boundaries do not fall on a regular grid.
        #[must_use]
        pub fn slot_ms(&self, k: u16) -> u32 {
            self.ayah_ms + (u32::from(k).wrapping_mul(7_919) % 5) * 13
        }

        /// The timing set of `surah` for `reciter`.
        #[must_use]
        pub fn timings(&self, reciter: u32, surah: u16) -> SurahTimingSet {
            let n = ayah_count(surah);
            let mut from = self.lead_in_ms;
            let mut ayahs = Vec::with_capacity(usize::from(n));
            for k in 1..=n {
                let slot = self.slot_ms(k);
                let to = from + slot.saturating_sub(self.breath_ms).max(1);
                let words = self.words_per_ayah.max(1);
                let word_ms = (to - from) / u32::from(words);
                let words = (1..=words)
                    .map(|w| {
                        let s = from + u32::from(w - 1) * word_ms;
                        (w, s, s + word_ms)
                    })
                    .collect();
                ayahs.push(AyahSpan {
                    ayah: k,
                    from_ms: from,
                    to_ms: to,
                    words,
                });
                from += slot;
            }
            SurahTimingSet {
                reciter_id: reciter,
                surah,
                file: file_key(reciter, surah),
                duration_ms: from + self.tail_ms,
                ayahs,
                word_level: true,
            }
        }

        /// Duration of `surah`'s file.
        #[must_use]
        pub fn duration_ms(&self, surah: u16) -> u32 {
            let ayahs: u32 = (1..=ayah_count(surah)).map(|k| self.slot_ms(k)).sum();
            self.lead_in_ms + ayahs + self.tail_ms
        }
    }

    /// The fixture file of `reciter`/`surah`.
    #[must_use]
    pub fn file_key(reciter: u32, surah: u16) -> FileKey {
        FileKey {
            reciter_id: reciter,
            surah,
            url: format!("fixture://{reciter}/{surah:03}.wav"),
            expected_len: None,
        }
    }

    /// A [`TimingsSource`] over [`Layout`] timings with the real surah sizes, configurable offline/failing surahs.
    #[derive(Debug)]
    pub struct FixtureTimings {
        reciter: u32,
        layout: Layout,
        basmala_in_file: bool,
        offline: Vec<u16>,
        failing: Vec<(u16, AudioError)>,
        calls: Mutex<Vec<u16>>,
    }

    impl FixtureTimings {
        #[must_use]
        pub fn new(reciter: u32) -> Self {
            Self {
                reciter,
                layout: Layout::default(),
                basmala_in_file: false,
                offline: Vec::new(),
                failing: Vec::new(),
                calls: Mutex::new(Vec::new()),
            }
        }

        #[must_use]
        pub fn with_layout(mut self, layout: Layout) -> Self {
            self.layout = layout;
            self
        }

        /// Reciter files start with the basmala: ayah 1 starts at `lead_in_ms`.
        #[must_use]
        pub fn with_basmala_in_file(mut self, lead_in_ms: u32) -> Self {
            self.basmala_in_file = true;
            self.layout.lead_in_ms = lead_in_ms;
            self
        }

        /// `surah_timings(surah)` fails with [`AudioError::Offline`].
        #[must_use]
        pub fn with_offline(mut self, surah: u16) -> Self {
            self.offline.push(surah);
            self
        }

        /// `surah_timings(surah)` fails with `error`.
        #[must_use]
        pub fn with_failing(mut self, surah: u16, error: AudioError) -> Self {
            self.failing.push((surah, error));
            self
        }

        #[must_use]
        pub fn layout(&self) -> Layout {
            self.layout
        }

        #[must_use]
        pub fn reciter(&self) -> u32 {
            self.reciter
        }

        /// The timing set the source serves for `surah` (ignores offline/failing).
        #[must_use]
        pub fn timings(&self, surah: u16) -> SurahTimingSet {
            self.layout.timings(self.reciter, surah)
        }

        /// Surahs asked for so far.
        #[must_use]
        pub fn calls(&self) -> Vec<u16> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    impl TimingsSource for FixtureTimings {
        fn surah_timings(
            &self,
            reciter_id: u32,
            surah: u16,
        ) -> Result<Arc<SurahTimingSet>, AudioError> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(surah);
            if let Some((_, e)) = self.failing.iter().find(|(s, _)| *s == surah) {
                return Err(e.clone());
            }
            if self.offline.contains(&surah) {
                return Err(AudioError::Offline(format!(
                    "surah {surah} timings not cached"
                )));
            }
            if reciter_id != self.reciter || ayah_count(surah) == 0 {
                return Err(AudioError::Timings(format!(
                    "no timings for reciter {reciter_id} surah {surah}"
                )));
            }
            Ok(Arc::new(self.layout.timings(reciter_id, surah)))
        }

        fn reciter_flags(&self, _reciter_id: u32) -> ReciterFlags {
            ReciterFlags {
                basmala_in_file: self.basmala_in_file,
            }
        }

        fn surah_ayah_count(&self, surah: u16) -> u16 {
            ayah_count(surah)
        }

        fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
            ayah_id(surah, ayah)
        }
    }

    /// Frames per ramp period: a ramp sample is `(frame mod 2²⁴) / 2²⁴`, exact in `f32`.
    pub const RAMP_PERIOD: u64 = 1 << 24;

    /// The sample a ramp fixture holds at source frame `frame`.
    #[must_use]
    pub fn ramp_sample(frame: u64) -> f32 {
        (frame % RAMP_PERIOD) as f32 / RAMP_PERIOD as f32
    }

    /// The source frame a ramp sample encodes (exact for unprocessed samples).
    #[must_use]
    pub fn ramp_frame(sample: f32) -> u64 {
        (f64::from(sample) * RAMP_PERIOD as f64).round().max(0.0) as u64
    }

    /// A 32-bit IEEE-float WAV of `frames` frames whose every channel holds [`ramp_sample`] of its frame index.
    #[must_use]
    pub fn ramp_wav(rate: u32, channels: u16, frames: u64) -> Vec<u8> {
        wav_f32(rate, channels, frames, |frame, _| ramp_sample(frame))
    }

    /// A 32-bit IEEE-float WAV of `frames` frames with `sample(frame, channel)`.
    #[must_use]
    pub fn wav_f32(
        rate: u32,
        channels: u16,
        frames: u64,
        sample: impl Fn(u64, u16) -> f32,
    ) -> Vec<u8> {
        let ch = channels.max(1);
        let data_len = frames * u64::from(ch) * 4;
        let data_len32 = u32::try_from(data_len).unwrap_or(u32::MAX);
        let mut w = Vec::with_capacity(usize::try_from(data_len).unwrap_or(0) + 58);
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(50_u32.saturating_add(data_len32)).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&18_u32.to_le_bytes());
        w.extend_from_slice(&3_u16.to_le_bytes()); // WAVE_FORMAT_IEEE_FLOAT
        w.extend_from_slice(&ch.to_le_bytes());
        w.extend_from_slice(&rate.to_le_bytes());
        w.extend_from_slice(&(rate * u32::from(ch) * 4).to_le_bytes());
        w.extend_from_slice(&(ch * 4).to_le_bytes());
        w.extend_from_slice(&32_u16.to_le_bytes());
        w.extend_from_slice(&0_u16.to_le_bytes()); // cbSize
        w.extend_from_slice(b"fact");
        w.extend_from_slice(&4_u32.to_le_bytes());
        w.extend_from_slice(&u32::try_from(frames).unwrap_or(u32::MAX).to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len32.to_le_bytes());
        for frame in 0..frames {
            for c in 0..ch {
                w.extend_from_slice(&sample(frame, c).to_le_bytes());
            }
        }
        w
    }

    /// A silent CBR MPEG-1 Layer III stream (44.1 kHz, 128 kbit/s, no tags) of `mp3_frames` frames of 1,152 samples:
    /// every granule has zero side info and no main data, so it decodes to exact silence.
    #[must_use]
    pub fn silent_mp3(mp3_frames: usize, stereo: bool) -> Vec<u8> {
        // 144 · 128 000 / 44 100 = 417 bytes per frame (no padding).
        const FRAME_BYTES: usize = 417;
        let header: [u8; 4] = [0xFF, 0xFB, 0x90, if stereo { 0x00 } else { 0xC0 }];
        let mut out = Vec::with_capacity(mp3_frames * FRAME_BYTES);
        for _ in 0..mp3_frames {
            out.extend_from_slice(&header);
            out.resize(out.len() + FRAME_BYTES - header.len(), 0);
        }
        out
    }

    /// Serves fixture files as in-memory ramp WAVs at `rate`/`channels` (per surah, sized by the [`Layout`]), with
    /// configurable offline files and an open log.
    pub struct FixtureSources {
        layout: Layout,
        rate: u32,
        channels: u16,
        offline: Mutex<Vec<u16>>,
        opens: Mutex<Vec<FileKey>>,
        extra: Mutex<HashMap<FileKey, Arc<[u8]>>>,
        cache: Mutex<HashMap<u16, Arc<[u8]>>>,
    }

    impl FixtureSources {
        #[must_use]
        pub fn new(layout: Layout, rate: u32, channels: u16) -> Self {
            Self {
                layout,
                rate,
                channels,
                offline: Mutex::new(Vec::new()),
                opens: Mutex::new(Vec::new()),
                extra: Mutex::new(HashMap::new()),
                cache: Mutex::new(HashMap::new()),
            }
        }

        /// Opening surah `surah`'s file fails with [`AudioError::Offline`] from now on.
        pub fn set_offline(&self, surah: u16, offline: bool) {
            let mut list = self.offline.lock().unwrap_or_else(PoisonError::into_inner);
            list.retain(|&s| s != surah);
            if offline {
                list.push(surah);
            }
        }

        /// Serves `bytes` for `key` instead of a generated file (e.g. a silent MP3).
        pub fn insert(&self, key: FileKey, bytes: Vec<u8>) {
            self.extra
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key, Arc::from(bytes));
        }

        /// Keys opened so far, in order.
        #[must_use]
        pub fn opens(&self) -> Vec<FileKey> {
            self.opens
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        #[must_use]
        pub fn rate(&self) -> u32 {
            self.rate
        }

        /// Frames of `surah`'s file.
        #[must_use]
        pub fn frames(&self, surah: u16) -> u64 {
            u64::from(self.layout.duration_ms(surah)) * u64::from(self.rate) / 1_000
        }

        fn bytes(&self, key: &FileKey) -> Arc<[u8]> {
            if let Some(b) = self
                .extra
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(key)
            {
                return Arc::clone(b);
            }
            let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            Arc::clone(cache.entry(key.surah).or_insert_with(|| {
                Arc::from(ramp_wav(self.rate, self.channels, self.frames(key.surah)))
            }))
        }
    }

    impl std::fmt::Debug for FixtureSources {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("FixtureSources")
                .field("layout", &self.layout)
                .field("rate", &self.rate)
                .field("channels", &self.channels)
                .finish_non_exhaustive()
        }
    }

    impl SourceProvider for FixtureSources {
        fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError> {
            self.opens
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(key.clone());
            if self
                .offline
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(&key.surah)
            {
                return Err(AudioError::Offline(format!(
                    "surah {} file not cached",
                    key.surah
                )));
            }
            Ok(OpenedSource::complete(Box::new(Cursor::new(
                self.bytes(key),
            ))))
        }
    }
}
