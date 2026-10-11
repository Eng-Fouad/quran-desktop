//! `qd-audio-out`: host selection (`cpal::available_hosts()` + `host_from_id`, never `default_host()`), the cpal
//! stream lifecycle and callback, device events (`StreamInvalidated`/`DeviceNotAvailable` → rebuild,
//! `DeviceChanged` → relabel only), default-device polling on ALSA/PulseAudio, one rebuild per output generation
//! (docs/ARCHITECTURE.md §2.3.6, D19). Owner: WP4c.
//!
//! # The callback ([`Renderer`])
//! The §2.3.4 algorithm, real-time safe (no allocation, lock, log, block or panic), in order:
//! 1. **Flush.** When decode bumped [`Shared::generation`], the ring holds stale frames. If audio was audible, the first
//!    ≤ 8 ms of the stale frames are played with a fade to silence (a *declick*: a flush never cuts a waveform mid-swing),
//!    then every stale frame and marker is discarded up to the first marker of the new generation, which is applied.
//!    The new generation starts with decode's own 4 ms fade-in, so the gain jumps straight back to the volume.
//! 2. **Copy**, split at marker frames so the marker in force changes on its exact frame (a Sync marker only refreshes
//!    the position; Sync markers may be met behind the read position and apply at once).
//! 3. **Gain.** Volume changes ramp linearly across the buffer. Pause slews to 0 over 8 ms
//!    ([`crate::shared::PAUSE_RAMP_MS`]) while still consuming, then outputs silence **without consuming** the ring;
//!    resume slews back up over 8 ms.
//! 4. **Publish** the state as of the buffer's first frame, all of a piece: its position (`cur.position_at(read)`), the
//!    segment index and marker kind in force there (the kind of the last non-Sync marker), the generation heard (in
//!    [`OutputStats`]); plus the output latency and the latency-compensated audible position at the end of the buffer
//!    (a rebuild's `resume_at_us`). A marker met inside a buffer is therefore published by the next one, never paired
//!    with the previous segment's position.
//! 5. **Underruns**: one per buffer that found too few frames while playing.
//!
//! Cross-thread order: the ring occupancy is read **before** the marker ring is peeked, so frames written after a flush
//! marker that was not yet visible are never mistaken for stale ones.
//!
//! # The output thread
//! - **Lazy stream.** The engine follows the play state ([`Demand`]): a stream (or debug sink) is opened when playback
//!   starts, kept while paused for [`PAUSED_LINGER`] and while idle for [`IDLE_LINGER`], then closed. An open output
//!   stream keeps the OS audio engine awake (on Windows it is an "audio stream in use" power request that blocks idle
//!   sleep), so the app holds the device only while it is, or is about to be, needed. A reopen continues exactly at the
//!   consumed ring position (`DecodeCmd::NewOutput` with `resume_at_us: None`).
//! - **Startup probe.** At start (and every 2 s while there is no device) the thread looks for a default output device
//!   without opening it: `CtlMsg::OutputReady` carries its label, `CtlMsg::OutputFailed(NoOutputDevice)` reports none
//!   (status `error`, §2.3.2).
//! - **Device events** ([`classify`]): `StreamInvalidated`/`DeviceNotAvailable` (how WASAPI reports a default-device
//!   change, D19) and any other error that ends the stream → [`OutCmd::Rebuild`] for that stream's generation;
//!   `DeviceChanged` → relabel only, no flush; `Xrun` is counted.
//! - **Debounce.** At most one rebuild per output generation: a `Rebuild` for a stream that was already replaced is
//!   dropped (the poll and an error callback can report the same change). Three rebuilds within 5 s back off to the 2 s
//!   retry (reported as status `error` until a stream runs again), so a device that fails on every start cannot spin.
//!   A resume position kept across a failed rebuild is used only if decode has not flushed since (a seek or a new play
//!   makes it stale).
//! - **Polling** of the default device id every 2 s only on hosts that report no device event ([`polls_default_device`]:
//!   ALSA, PulseAudio).
//! - **Rebuild**: drop the stream, open the default device again, create a new ring pair and send
//!   `DecodeCmd::NewOutput` with the last audible position; a failed rebuild retries every 2 s with status
//!   `error(NoOutputDevice)`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use rtrb::{Consumer, Producer, RingBuffer};

use crate::AudioError;
use crate::dsp::{GainRamp, ms_to_frames};
use crate::shared::{
    CtlMsg, DEVICE_RETRY_MS, DecodeCmd, MARKER_RING_SLOTS, Marker, MarkerKind, OutCmd,
    PAUSE_RAMP_MS, Shared,
};

/// How long a paused engine keeps its output stream open before releasing the device.
pub const PAUSED_LINGER: Duration = Duration::from_secs(30);
/// How long an idle (stopped, ended or failed) engine keeps its output stream open.
pub const IDLE_LINGER: Duration = Duration::from_secs(5);
/// Default-device polling period on ALSA/PulseAudio (§2.3.6).
pub const DEFAULT_DEVICE_POLL: Duration = Duration::from_millis(DEVICE_RETRY_MS as u64);
/// Rebuilds allowed within [`REBUILD_WINDOW`] before the next one waits for the 2 s retry.
const REBUILD_BURST: usize = 3;
const REBUILD_WINDOW: Duration = Duration::from_secs(5);
/// Frames the callback converts at once for non-f32 devices (the scratch buffer is allocated up front).
const SCRATCH_FRAMES: usize = 4_096;

// ---------------------------------------------------------------------------------------------------------------------
// Where audio goes.

/// The output backend of an engine.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum OutputKind {
    /// The system default output device through cpal (the only kind in release builds).
    Device,
    /// A debug sink instead of hardware (`QD_AUDIO_SINK`, D24).
    #[cfg(debug_assertions)]
    Sink(crate::sink::SinkKind),
}

impl OutputKind {
    /// Debug builds: the sink named by `QD_AUDIO_SINK`, else the device. Release builds: always the device (D24).
    #[must_use]
    pub fn from_env() -> Self {
        #[cfg(debug_assertions)]
        if let Some(kind) = crate::sink::SinkKind::from_env() {
            return Self::Sink(kind);
        }
        Self::Device
    }
}

/// What the engine needs from the output, sent by control after every user command and status change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Demand {
    /// Loading or playing: a stream must run.
    Play,
    /// Paused: keep (or reopen, so a seek is heard and published) the stream for [`PAUSED_LINGER`].
    Pause,
    /// Idle, ended or failed: release the stream after [`IDLE_LINGER`].
    Idle,
}

/// Messages to `qd-audio-out`.
#[derive(Debug)]
pub(crate) enum OutMsg {
    /// The frozen device commands (`Rebuild`, `DeviceChanged`, `Shutdown`).
    Cmd(OutCmd),
    Demand(Demand),
}

/// What a stream error means (D19, verified in cpal 0.18.2 `error.rs` and `host/wasapi/stream.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StreamEvent {
    /// The stream is gone: open the default device again (`StreamInvalidated`, `DeviceNotAvailable`, and every error
    /// after which cpal stops calling back).
    Rebuild,
    /// The stream was already rerouted to the new default device (CoreAudio, PipeWire): refresh the label only.
    Relabel,
    /// A glitch; the stream keeps running.
    Xrun,
    /// Informational (real-time priority refused).
    Ignore,
}

/// The device-event policy of §2.3.6.
#[must_use]
pub fn classify(kind: cpal::ErrorKind) -> StreamEvent {
    match kind {
        cpal::ErrorKind::DeviceChanged => StreamEvent::Relabel,
        cpal::ErrorKind::Xrun => StreamEvent::Xrun,
        cpal::ErrorKind::RealtimeDenied => StreamEvent::Ignore,
        // StreamInvalidated and DeviceNotAvailable by the spec; any other error ends cpal's stream thread (WASAPI breaks
        // its run loop after reporting it), so the stream must be rebuilt as well.
        _ => StreamEvent::Rebuild,
    }
}

/// Hosts that report neither `StreamInvalidated` nor `DeviceChanged` on a default-device change: the output thread
/// polls the default device id on them (§2.3.6).
#[must_use]
pub fn polls_default_device(host: cpal::HostId) -> bool {
    let name = host.name();
    name.eq_ignore_ascii_case("alsa") || name.eq_ignore_ascii_case("pulseaudio")
}

/// Host preference (§2.3.6): Linux PipeWire (when compiled in), PulseAudio, then ALSA; Windows WASAPI; macOS
/// CoreAudio; any other available host after those, in cpal's order.
#[must_use]
pub fn host_rank(host: cpal::HostId) -> usize {
    const PREFERENCE: [&str; 5] = ["pipewire", "pulseaudio", "alsa", "wasapi", "coreaudio"];
    let name = host.name();
    PREFERENCE
        .iter()
        .position(|p| name.eq_ignore_ascii_case(p))
        .unwrap_or(PREFERENCE.len())
}

// ---------------------------------------------------------------------------------------------------------------------
// The callback.

/// Callback-side counters and the output thread's state, for the ticker, control and diagnostics. Atomics only.
#[derive(Debug, Default)]
pub struct OutputStats {
    /// Generation of the marker in force at the callback (0 before the first marker of a stream).
    pub heard_generation: AtomicU32,
    /// Ring frames played (fade-out of a flush included; discarded frames excluded).
    pub played_frames: AtomicU64,
    /// Latency-compensated file position (µs) at the last buffer: what a rebuild resumes at.
    pub audible_us: AtomicU64,
    /// Format of the running stream.
    pub rate: AtomicU32,
    pub channels: AtomicU32,
    /// Streams built so far: the output generation [`OutCmd::Rebuild`] refers to.
    pub output_generation: AtomicU32,
    /// Streams replaced after a device event.
    pub rebuilds: AtomicU32,
    /// A stream (or debug sink) is running.
    pub open: AtomicBool,
    /// cpal `Xrun` reports.
    pub xruns: AtomicU32,
}

/// Sees every marker the callback applies (debug sinks log them; the cpal callback uses `()`, which compiles away).
pub trait MarkerObserver {
    /// `marker` took effect at ring frame `read_frame`, `offset` frames into the current buffer.
    fn applied(&mut self, marker: &Marker, read_frame: u64, offset: usize);
}

impl MarkerObserver for () {
    #[inline]
    fn applied(&mut self, _marker: &Marker, _read_frame: u64, _offset: usize) {}
}

/// A marker as a [`Renderer`] applied it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedMarker {
    pub marker: Marker,
    pub read_frame: u64,
    /// Frames into the buffer being rendered.
    pub offset: usize,
}

impl MarkerObserver for Vec<AppliedMarker> {
    fn applied(&mut self, marker: &Marker, read_frame: u64, offset: usize) {
        self.push(AppliedMarker {
            marker: *marker,
            read_frame,
            offset,
        });
    }
}

/// The §2.3.4 callback over one ring pair. Real-time safe: it never allocates, locks, logs, blocks or panics.
pub struct Renderer {
    shared: Arc<Shared>,
    stats: Arc<OutputStats>,
    cons: Consumer<f32>,
    mcons: Consumer<Marker>,
    rate: u32,
    channels: usize,
    /// Ring frames consumed (played or discarded).
    read: u64,
    /// The marker in force.
    cur: Marker,
    /// Kind of the last non-Sync marker applied (what `Shared::marker_kind` publishes).
    kind: MarkerKind,
    ramp: GainRamp,
    /// [`PAUSE_RAMP_MS`] in frames: the slope of pause/resume ramps and of the flush declick.
    ramp_frames: usize,
    /// The pause ramp completed: silence is output and the ring is not consumed.
    silent: bool,
    /// Coming back from silence: slew up to the volume rather than ramping linearly across the buffer.
    resuming: bool,
    /// f32 staging for devices with integer sample formats (allocated here, never in the callback).
    scratch: Vec<f32>,
}

impl Renderer {
    /// A renderer for a stream at `rate` Hz with `channels`, reading the ring pair decode writes into.
    #[must_use]
    pub fn new(
        shared: Arc<Shared>,
        stats: Arc<OutputStats>,
        cons: Consumer<f32>,
        mcons: Consumer<Marker>,
        rate: u32,
        channels: u16,
    ) -> Self {
        let rate = rate.max(1);
        let channels = usize::from(channels.max(1));
        Self {
            shared,
            stats,
            cons,
            mcons,
            rate,
            channels,
            read: 0,
            cur: Marker::INITIAL,
            kind: Marker::INITIAL.kind,
            ramp: GainRamp::new(0.0),
            ramp_frames: ms_to_frames(PAUSE_RAMP_MS, rate).max(1),
            silent: true,
            resuming: false,
            scratch: vec![0.0; SCRATCH_FRAMES * channels],
        }
    }

    /// Ring frames consumed so far.
    #[must_use]
    pub fn read_frame(&self) -> u64 {
        self.read
    }

    /// The marker in force.
    #[must_use]
    pub fn current(&self) -> Marker {
        self.cur
    }

    /// The gain applied to the last frame.
    #[must_use]
    pub fn gain(&self) -> f32 {
        self.ramp.gain()
    }

    /// One device buffer of interleaved f32 frames (a trailing partial frame is left silent). `latency_us` is the
    /// stream's output latency (playback instant − callback instant).
    pub fn render<O: MarkerObserver>(&mut self, out: &mut [f32], latency_us: u64, obs: &mut O) {
        let ch = self.channels;
        out.fill(0.0);
        let frames = out.len() / ch;
        let Some(out) = out.get_mut(..frames * ch) else {
            return;
        };
        self.shared
            .out_latency_us
            .store(latency_us, Ordering::Relaxed);
        let want = self.shared.generation.load(Ordering::Acquire);
        let playing = self.shared.playing.load(Ordering::Acquire);
        let target = self.shared.gain();

        // 1. Flush: fade out what was audible, then drop the stale generation.
        let mut pos = 0;
        if self.cur.generation != want {
            pos = self.declick(out, want);
            self.ramp.set(0.0);
            self.silent = true;
            self.resuming = false;
            self.catch_up(want, playing, target, obs, pos);
        }
        // What this buffer starts with: position, segment and kind are published together, as of its first frame.
        let start_read = self.read;
        let start_marker = self.cur;
        let start_kind = self.kind;
        let mut played = pos as u64;
        let underrun;

        if self.cur.generation == want {
            // 2. Copy (pause: only what the 8 ms ramp to silence needs).
            let budget = frames.saturating_sub(pos);
            let consume = if playing {
                budget
            } else if self.silent {
                0
            } else {
                self.ramp.frames_to_reach(0.0, self.ramp_frames).min(budget)
            };
            let begin = pos;
            let copied = self.copy(out, begin, consume, want, obs);
            played += copied as u64;
            underrun = playing && copied < consume;
            // 3. Gain.
            if let Some(region) = out.get_mut(begin * ch..(begin + copied) * ch) {
                self.apply_gain(region, playing, target);
            }
            if !playing && (copied < consume || self.ramp.gain() <= 0.0) {
                self.ramp.set(0.0);
                self.silent = true;
            }
        } else {
            // The new generation has no marker in the ring yet (decode is waiting for a source or an output).
            underrun = playing;
        }

        // 4. Publish the start of this buffer (§2.3.4 step 4): its position, and the segment and kind in force there, so
        //    the three always agree (a marker met inside the buffer is published by the next one).
        if underrun {
            self.shared.underruns.fetch_add(1, Ordering::Relaxed);
        }
        self.shared
            .file_pos_us
            .store(start_marker.position_at(start_read), Ordering::Release);
        self.shared
            .seg_index
            .store(start_marker.seg_index, Ordering::Release);
        self.shared
            .marker_kind
            .store(start_kind.as_u8(), Ordering::Release);
        self.shared.set_repeat_progress(&start_marker);
        let latency_frames = latency_us.saturating_mul(u64::from(self.rate)) / 1_000_000;
        let audible = self
            .cur
            .position_at(self.read)
            .saturating_sub(self.cur.rate.advance_us(latency_frames));
        self.stats.audible_us.store(audible, Ordering::Relaxed);
        self.stats
            .played_frames
            .fetch_add(played, Ordering::Relaxed);
        self.stats
            .heard_generation
            .store(start_marker.generation, Ordering::Release);
    }

    /// [`Renderer::render`] for an integer sample format, staged through the preallocated f32 scratch buffer.
    pub fn render_converted<T>(&mut self, out: &mut [T], latency_us: u64)
    where
        T: Sample + FromSample<f32>,
    {
        let ch = self.channels;
        let mut scratch = std::mem::take(&mut self.scratch);
        for chunk in out.chunks_mut(SCRATCH_FRAMES * ch) {
            let Some(buf) = scratch.get_mut(..chunk.len()) else {
                break;
            };
            self.render(buf, latency_us, &mut ());
            for (o, s) in chunk.iter_mut().zip(buf.iter()) {
                *o = T::from_sample(*s);
            }
        }
        self.scratch = scratch;
    }

    /// Plays up to 8 ms of the stale generation with a slew to silence (only when something was audible), never past
    /// the next marker. Returns the frames written at the start of `out`.
    fn declick(&mut self, out: &mut [f32], want: u32) -> usize {
        if self.silent || self.ramp.gain() <= 0.0 {
            return 0;
        }
        let ch = self.channels;
        // Occupancy before the markers (see `catch_up`): only frames older than any marker not yet visible.
        let avail = self.cons.slots() / ch;
        // Late Sync markers of the stale generation behind the read position would stop the fade before it starts;
        // the catch-up drops them anyway.
        while let Ok(m) = self.mcons.peek().copied() {
            if m.generation == want || m.ring_frame > self.read {
                break;
            }
            let _ = self.mcons.pop();
        }
        let mut n = self
            .ramp
            .frames_to_reach(0.0, self.ramp_frames)
            .min(out.len() / ch)
            .min(avail);
        if let Ok(m) = self.mcons.peek() {
            n = n.min(frames_usize(m.ring_frame.saturating_sub(self.read)));
        }
        if n == 0 {
            return 0;
        }
        let Some(dst) = out.get_mut(..n * ch) else {
            return 0;
        };
        if !read_into(&mut self.cons, dst) {
            return 0;
        }
        self.read += n as u64;
        self.ramp.apply_slew(dst, ch, 0.0, self.ramp_frames);
        n
    }

    /// Step 1: discards frames and stale markers up to the first marker of generation `want` and applies it.
    fn catch_up<O: MarkerObserver>(
        &mut self,
        want: u32,
        playing: bool,
        target: f32,
        obs: &mut O,
        offset: usize,
    ) {
        let ch = self.channels;
        loop {
            // Occupancy first, marker second: decode pushes a flush marker before the first frame of its generation,
            // so every frame counted here precedes any marker that is not visible yet.
            let avail = self.cons.slots() / ch;
            let Ok(m) = self.mcons.peek().copied() else {
                // No marker of the new generation yet: everything in the ring is stale.
                self.discard(avail);
                return;
            };
            if m.ring_frame > self.read {
                let n = frames_usize(m.ring_frame - self.read).min(self.cons.slots() / ch);
                self.discard(n);
                if self.read < m.ring_frame {
                    return;
                }
            }
            let _ = self.mcons.pop();
            if m.generation == want {
                self.apply(m, offset, obs);
                // Decode fades every new generation in over 4 ms: no ramp on top of it.
                if playing {
                    self.ramp.set(target);
                    self.silent = false;
                }
                return;
            }
        }
    }

    /// Step 2: copies up to `count` frames into `out` from frame `begin`, applying markers on their exact frames.
    /// Returns the frames copied.
    fn copy<O: MarkerObserver>(
        &mut self,
        out: &mut [f32],
        begin: usize,
        count: usize,
        want: u32,
        obs: &mut O,
    ) -> usize {
        let ch = self.channels;
        let mut copied = 0;
        while copied < count {
            self.apply_due(want, begin + copied, obs);
            let mut n = (count - copied).min(self.cons.slots() / ch);
            if let Ok(m) = self.mcons.peek() {
                // Any marker bounds the copy: one of `want` changes `cur` there, a newer one is the next flush.
                n = n.min(frames_usize(m.ring_frame.saturating_sub(self.read)));
            }
            if n == 0 {
                break;
            }
            let at = (begin + copied) * ch;
            let Some(dst) = out.get_mut(at..at + n * ch) else {
                break;
            };
            if !read_into(&mut self.cons, dst) {
                break;
            }
            self.read += n as u64;
            copied += n;
        }
        // Markers due exactly at the end of the copied frames apply now (the next frame starts with them).
        self.apply_due(want, begin + copied, obs);
        copied
    }

    fn apply_due<O: MarkerObserver>(&mut self, want: u32, offset: usize, obs: &mut O) {
        while let Ok(m) = self.mcons.peek().copied() {
            if m.generation != want || m.ring_frame > self.read {
                break;
            }
            let _ = self.mcons.pop();
            self.apply(m, offset, obs);
        }
    }

    fn apply<O: MarkerObserver>(&mut self, m: Marker, offset: usize, obs: &mut O) {
        obs.applied(&m, self.read, offset);
        if m.kind != MarkerKind::Sync {
            self.kind = m.kind;
        }
        self.cur = m;
    }

    fn discard(&mut self, frames: usize) {
        if frames == 0 {
            return;
        }
        if let Ok(chunk) = self.cons.read_chunk(frames * self.channels) {
            chunk.commit_all();
            self.read += frames as u64;
        }
    }

    /// Step 3 on the frames just copied.
    fn apply_gain(&mut self, region: &mut [f32], playing: bool, target: f32) {
        if region.is_empty() {
            return;
        }
        let ch = self.channels;
        if !playing {
            self.resuming = false;
            self.ramp.apply_slew(region, ch, 0.0, self.ramp_frames);
        } else if self.silent || self.resuming {
            self.silent = false;
            self.ramp.apply_slew(region, ch, target, self.ramp_frames);
            self.resuming = (self.ramp.gain() - target).abs() > f32::EPSILON;
        } else {
            self.ramp.apply_linear(region, ch, target);
        }
    }
}

impl std::fmt::Debug for Renderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Renderer")
            .field("rate", &self.rate)
            .field("channels", &self.channels)
            .field("read", &self.read)
            .field("cur", &self.cur)
            .field("gain", &self.ramp.gain())
            .field("silent", &self.silent)
            .finish_non_exhaustive()
    }
}

/// Moves exactly `dst.len()` samples out of the ring. `false` (nothing consumed) if they are not all there.
fn read_into(cons: &mut Consumer<f32>, dst: &mut [f32]) -> bool {
    let Ok(chunk) = cons.read_chunk(dst.len()) else {
        return false;
    };
    let (a, b) = chunk.as_slices();
    let Some((d1, d2)) = dst.split_at_mut_checked(a.len()) else {
        return false;
    };
    if d2.len() != b.len() {
        return false;
    }
    d1.copy_from_slice(a);
    d2.copy_from_slice(b);
    chunk.commit_all();
    true
}

fn frames_usize(frames: u64) -> usize {
    usize::try_from(frames).unwrap_or(usize::MAX)
}

/// A device sample type the stream can be built for, and how the callback fills it.
trait OutputSample: SizedSample + FromSample<f32> + Send + 'static {
    fn render(r: &mut Renderer, out: &mut [Self], latency_us: u64);
}

impl OutputSample for f32 {
    fn render(r: &mut Renderer, out: &mut [Self], latency_us: u64) {
        r.render(out, latency_us, &mut ());
    }
}

macro_rules! converted_output_sample {
    ($($t:ty),*) => {$(
        impl OutputSample for $t {
            fn render(r: &mut Renderer, out: &mut [Self], latency_us: u64) {
                r.render_converted(out, latency_us);
            }
        }
    )*};
}
converted_output_sample!(i16, i32, u16);

/// The formats the stream is built for, in the order a fallback config is searched.
const SUPPORTED_FORMATS: [SampleFormat; 4] = [
    SampleFormat::F32,
    SampleFormat::I32,
    SampleFormat::I16,
    SampleFormat::U16,
];

/// cpal's latency estimate for one callback.
fn latency_us(info: &cpal::OutputCallbackInfo) -> u64 {
    let ts = info.timestamp();
    ts.playback
        .checked_duration_since(ts.callback)
        .map_or(0, |d| u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
}

// ---------------------------------------------------------------------------------------------------------------------
// The output thread.

/// Everything `qd-audio-out` needs.
pub(crate) struct OutputParts {
    pub kind: OutputKind,
    pub rx: Receiver<OutMsg>,
    /// Its own sender (cpal error callbacks report through it).
    pub tx: Sender<OutMsg>,
    pub decode: Sender<DecodeCmd>,
    pub ctl: Sender<CtlMsg>,
    pub shared: Arc<Shared>,
    pub stats: Arc<OutputStats>,
    pub ring_ms: u32,
    /// The WAV sink's log, shared with the ticker.
    #[cfg(debug_assertions)]
    pub sink_log: Option<Arc<crate::sink::EventLog>>,
}

/// Spawns `qd-audio-out`.
///
/// # Errors
/// [`AudioError::Device`] when the OS refuses the thread (never panics, §0.2).
pub(crate) fn spawn(parts: OutputParts) -> Result<JoinHandle<()>, AudioError> {
    std::thread::Builder::new()
        .name("qd-audio-out".to_owned())
        .spawn(move || Worker::new(parts).run())
        .map_err(|e| AudioError::Device(format!("cannot start qd-audio-out: {e}")))
}

/// Why a stream is being built (logged).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Build {
    /// First stream, or a reopen after a linger close.
    Open,
    /// Replacing a stream after a device event.
    Rebuild,
    /// The 2 s retry after a failure.
    Retry,
}

impl Build {
    const fn name(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Rebuild => "rebuild",
            Self::Retry => "retry",
        }
    }
}

/// A running cpal stream (kept on this thread: PulseAudio/PipeWire streams are not `Send`).
struct CpalOut {
    /// Owned to keep the stream running: dropping it stops and joins cpal's stream thread.
    _stream: cpal::Stream,
    host: cpal::Host,
    device: cpal::Device,
    /// The id the stream was built from (default-device polling).
    device_id: Option<cpal::DeviceId>,
    next_poll: Option<Instant>,
}

/// A running debug sink: the renderer driven by the wall clock.
#[cfg(debug_assertions)]
struct SinkOut {
    renderer: Renderer,
    clock: Instant,
    /// Frames rendered since `clock`.
    rendered: u64,
    buf: Vec<f32>,
    applied: Vec<AppliedMarker>,
}

enum Backend {
    Cpal(Box<CpalOut>),
    #[cfg(debug_assertions)]
    Sink(Box<SinkOut>),
}

impl Backend {
    fn cpal(&self) -> Option<&CpalOut> {
        match self {
            Self::Cpal(c) => Some(c),
            #[cfg(debug_assertions)]
            Self::Sink(_) => None,
        }
    }

    fn cpal_mut(&mut self) -> Option<&mut CpalOut> {
        match self {
            Self::Cpal(c) => Some(c),
            #[cfg(debug_assertions)]
            Self::Sink(_) => None,
        }
    }
}

struct Active {
    generation: u32,
    backend: Backend,
    rate: u32,
    channels: u16,
    label: String,
}

/// A stream ready to run plus the producer side of its rings.
struct Opened {
    backend: Backend,
    rate: u32,
    channels: u16,
    label: String,
    prod: Producer<f32>,
    mprod: Producer<Marker>,
}

struct Worker {
    kind: OutputKind,
    rx: Receiver<OutMsg>,
    tx: Sender<OutMsg>,
    decode: Sender<DecodeCmd>,
    ctl: Sender<CtlMsg>,
    shared: Arc<Shared>,
    stats: Arc<OutputStats>,
    ring_ms: u32,
    demand: Demand,
    demand_at: Instant,
    active: Option<Active>,
    /// Streams built so far.
    generation: u32,
    /// When to retry a failed build or probe.
    retry_at: Option<Instant>,
    /// The position (µs) the next build resumes at after a device failure while audio was audible, with the decode
    /// generation it belongs to: any flush since (a seek, a new play) makes it stale.
    resume: Option<(u64, u32)>,
    /// The last failure reported to control (repeated identical failures are not resent).
    reported_failure: Option<AudioError>,
    rebuild_times: VecDeque<Instant>,
    #[cfg(debug_assertions)]
    sink_files: crate::sink::SinkFiles,
    /// Sink frames rendered over the whole run (silence included).
    #[cfg(debug_assertions)]
    device_frames: u64,
}

impl Worker {
    fn new(p: OutputParts) -> Self {
        #[cfg(debug_assertions)]
        let sink_files = match &p.kind {
            OutputKind::Sink(crate::sink::SinkKind::Wav(path)) => crate::sink::SinkFiles {
                wav: crate::sink::WavWriter::create(
                    path,
                    crate::sink::SINK_RATE,
                    crate::sink::SINK_CHANNELS,
                )
                .map_err(|e| log::error!("WAV sink: cannot create {}: {e}", path.display()))
                .ok(),
                log: p.sink_log.clone(),
            },
            _ => crate::sink::SinkFiles::default(),
        };
        Self {
            kind: p.kind,
            rx: p.rx,
            tx: p.tx,
            decode: p.decode,
            ctl: p.ctl,
            shared: p.shared,
            stats: p.stats,
            ring_ms: p.ring_ms,
            demand: Demand::Idle,
            demand_at: Instant::now(),
            active: None,
            generation: 0,
            retry_at: None,
            resume: None,
            reported_failure: None,
            rebuild_times: VecDeque::with_capacity(REBUILD_BURST + 1),
            #[cfg(debug_assertions)]
            sink_files,
            #[cfg(debug_assertions)]
            device_frames: 0,
        }
    }

    fn run(mut self) {
        self.probe();
        loop {
            let msg = match self.next_deadline() {
                Some(at) => self
                    .rx
                    .recv_timeout(at.saturating_duration_since(Instant::now())),
                None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match msg {
                Ok(OutMsg::Cmd(OutCmd::Shutdown)) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(OutMsg::Cmd(OutCmd::Rebuild { generation })) => self.rebuild(generation),
                Ok(OutMsg::Cmd(OutCmd::DeviceChanged)) => self.relabel(),
                Ok(OutMsg::Demand(d)) => self.set_demand(d),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.timers();
        }
        self.close("shutdown");
        #[cfg(debug_assertions)]
        if let Some(wav) = self.sink_files.wav.as_mut()
            && let Err(e) = wav.finish()
        {
            log::warn!("WAV sink: cannot finalise the file: {e}");
        }
    }

    /// The earliest timer: a retry, a linger close, a default-device poll, the next sink buffer.
    fn next_deadline(&self) -> Option<Instant> {
        let mut at = self.retry_at;
        let mut earliest = |t: Instant| at = Some(at.map_or(t, |a| a.min(t)));
        if let Some(active) = &self.active {
            if let Some(linger) = self.linger() {
                earliest(self.demand_at + linger);
            }
            match &active.backend {
                Backend::Cpal(c) => {
                    if let Some(t) = c.next_poll {
                        earliest(t);
                    }
                }
                #[cfg(debug_assertions)]
                Backend::Sink(s) => earliest(s.next_buffer_at(active.rate)),
            }
        }
        at
    }

    fn linger(&self) -> Option<Duration> {
        match self.demand {
            Demand::Play => None,
            Demand::Pause => Some(PAUSED_LINGER),
            Demand::Idle => Some(IDLE_LINGER),
        }
    }

    fn timers(&mut self) {
        let now = Instant::now();
        #[cfg(debug_assertions)]
        self.render_sink();
        if self.active.is_some()
            && let Some(linger) = self.linger()
            && now >= self.demand_at + linger
        {
            self.close("released after the linger");
            // A reopen continues at the consumed ring position, which is exact.
            self.resume = None;
        }
        if self.retry_at.is_some_and(|t| now >= t) {
            self.retry_at = None;
            if self.wants_stream() {
                let resume = self.take_resume();
                self.build(resume, Build::Retry);
            } else {
                self.probe();
            }
        }
        self.poll_default_device(now);
    }

    fn wants_stream(&self) -> bool {
        matches!(self.demand, Demand::Play | Demand::Pause)
    }

    fn set_demand(&mut self, d: Demand) {
        self.demand = d;
        self.demand_at = Instant::now();
        if self.wants_stream() && self.active.is_none() && self.retry_at.is_none() {
            let resume = self.take_resume();
            self.build(resume, Build::Open);
        }
    }

    /// `OutCmd::Rebuild { generation }`: at most one rebuild per output generation.
    fn rebuild(&mut self, generation: u32) {
        let Some(active) = &self.active else {
            log::debug!(
                "audio output: rebuild for generation {generation} without a stream: ignored"
            );
            return;
        };
        if active.generation != generation {
            log::debug!(
                "audio output: rebuild for generation {generation} ignored (stream {} is current)",
                active.generation
            );
            return;
        }
        let resume = self.audible_resume();
        log::info!(
            "audio output: rebuilding stream {generation} on {} (resume at {resume:?} µs)",
            active.label
        );
        self.close("rebuild");
        self.stats.rebuilds.fetch_add(1, Ordering::Relaxed);
        if !self.wants_stream() {
            // Idle: the next stream belongs to whatever plays next.
            self.resume = None;
            return;
        }
        self.keep_resume(resume);
        let now = Instant::now();
        self.rebuild_times
            .retain(|t| now.saturating_duration_since(*t) < REBUILD_WINDOW);
        if self.rebuild_times.len() >= REBUILD_BURST {
            log::warn!(
                "audio output: {REBUILD_BURST} rebuilds within {REBUILD_WINDOW:?}; backing off"
            );
            self.retry_at = Some(now + DEFAULT_DEVICE_POLL);
            // Silent until the retry: say so (status error) instead of a frozen "playing".
            self.report_failure(AudioError::Device(
                "the output device keeps failing; retrying".to_owned(),
            ));
            return;
        }
        self.rebuild_times.push_back(now);
        self.build(resume, Build::Rebuild);
    }

    /// `DeviceChanged`: the stream was rerouted; refresh the label, no flush (D19).
    fn relabel(&mut self) {
        let Some(active) = &mut self.active else {
            return;
        };
        if let Some(c) = active.backend.cpal() {
            active.label = device_label(&c.device);
            log::info!("audio output: rerouted to {}", active.label);
        }
        let ready = CtlMsg::OutputReady {
            device: active.label.clone(),
            rate: active.rate,
            channels: active.channels,
        };
        self.send_ctl(ready);
    }

    /// Keeps `us` for the next build, tagged with the current decode generation.
    fn keep_resume(&mut self, us: Option<u64>) {
        let generation = self.shared.generation.load(Ordering::Acquire);
        self.resume = us.map(|us| (us, generation));
    }

    /// The kept resume position, unless decode flushed since (then its consumed position is the right one).
    fn take_resume(&mut self) -> Option<u64> {
        let current = self.shared.generation.load(Ordering::Acquire);
        self.resume
            .take()
            .filter(|&(_, generation)| generation == current)
            .map(|(us, _)| us)
    }

    /// The position to resume at after replacing an audible stream: the callback's latency-compensated position, when
    /// it was playing the current generation.
    fn audible_resume(&self) -> Option<u64> {
        let heard = self.stats.heard_generation.load(Ordering::Acquire);
        let current = self.shared.generation.load(Ordering::Acquire);
        (heard != Marker::INITIAL.generation && heard == current)
            .then(|| self.stats.audible_us.load(Ordering::Relaxed))
    }

    /// Opens a stream for the current demand and hands its rings to decode.
    fn build(&mut self, resume_at_us: Option<u64>, why: Build) {
        let generation = self.generation.wrapping_add(1);
        let opened = match &self.kind {
            OutputKind::Device => self.open_device(generation),
            #[cfg(debug_assertions)]
            OutputKind::Sink(kind) => Ok(self.open_sink(kind)),
        };
        let o = match opened {
            Ok(o) => o,
            Err(e) => {
                log::warn!(
                    "audio output: {} failed: {e}; retrying every {DEVICE_RETRY_MS} ms",
                    why.name()
                );
                self.keep_resume(resume_at_us);
                self.retry_at = Some(Instant::now() + DEFAULT_DEVICE_POLL);
                self.report_failure(e);
                return;
            }
        };
        self.generation = generation;
        self.retry_at = None;
        self.resume = None;
        self.reported_failure = None;
        self.stats.rate.store(o.rate, Ordering::Relaxed);
        self.stats
            .channels
            .store(u32::from(o.channels), Ordering::Relaxed);
        self.stats
            .output_generation
            .store(generation, Ordering::Release);
        self.stats.open.store(true, Ordering::Release);
        log::info!(
            "audio output: stream {generation} ({}) on {} at {} Hz × {}",
            why.name(),
            o.label,
            o.rate,
            o.channels
        );
        #[cfg(debug_assertions)]
        if let Some(log) = &self.sink_files.log {
            log.write(&[crate::sink::LogLine::Output {
                generation,
                rate: o.rate,
                channels: o.channels,
                resume_at_us,
                reason: why.name(),
                device_frame: self.device_frames,
            }]);
        }
        let new_output = DecodeCmd::NewOutput {
            prod: o.prod,
            mprod: o.mprod,
            rate: o.rate,
            channels: o.channels,
            resume_at_us,
        };
        if self.decode.send(new_output).is_err() {
            log::debug!("audio output: decode is gone");
        }
        self.send_ctl(CtlMsg::OutputReady {
            device: o.label.clone(),
            rate: o.rate,
            channels: o.channels,
        });
        self.active = Some(Active {
            generation,
            backend: o.backend,
            rate: o.rate,
            channels: o.channels,
            label: o.label,
        });
    }

    /// A ring pair sized for `ring_ms` at the stream's format, and the renderer that reads it.
    fn rings(&self, rate: u32, channels: u16) -> (Producer<f32>, Producer<Marker>, Renderer) {
        let ch = usize::from(channels.max(1));
        let frames = u64::from(self.ring_ms) * u64::from(rate.max(1)) / 1_000;
        let frames = usize::try_from(frames).unwrap_or(48_000).max(64);
        let (prod, cons) = RingBuffer::<f32>::new(frames * ch);
        let (mprod, mcons) = RingBuffer::<Marker>::new(MARKER_RING_SLOTS);
        let renderer = Renderer::new(
            Arc::clone(&self.shared),
            Arc::clone(&self.stats),
            cons,
            mcons,
            rate,
            channels,
        );
        (prod, mprod, renderer)
    }

    /// The system default output device, at its own rate (resampling happens in decode).
    fn open_device(&self, generation: u32) -> Result<Opened, AudioError> {
        let (host, device) = select_device()?;
        let supported = device
            .default_output_config()
            .map_err(|e| device_error("default output config", &e))?;
        let (config, format) = choose_config(&device, supported)?;
        let rate = config.sample_rate;
        let channels = config.channels;
        let label = device_label(&device);
        let device_id = device.id().ok();
        let (prod, mprod, renderer) = self.rings(rate, channels);
        let tx = self.tx.clone();
        let stats = Arc::clone(&self.stats);
        let on_error = move |e: cpal::Error| stream_error(&tx, &stats, generation, &e);
        let stream = match format {
            SampleFormat::F32 => build_stream::<f32, _>(&device, config, renderer, on_error),
            SampleFormat::I32 => build_stream::<i32, _>(&device, config, renderer, on_error),
            SampleFormat::I16 => build_stream::<i16, _>(&device, config, renderer, on_error),
            SampleFormat::U16 => build_stream::<u16, _>(&device, config, renderer, on_error),
            other => {
                return Err(AudioError::Device(format!(
                    "unsupported sample format {other}"
                )));
            }
        }
        .map_err(|e| device_error("build output stream", &e))?;
        // cpal 0.18 streams do not start on their own.
        stream
            .play()
            .map_err(|e| device_error("start output stream", &e))?;
        let next_poll =
            polls_default_device(host.id()).then(|| Instant::now() + DEFAULT_DEVICE_POLL);
        Ok(Opened {
            backend: Backend::Cpal(Box::new(CpalOut {
                _stream: stream,
                host,
                device,
                device_id,
                next_poll,
            })),
            rate,
            channels,
            label,
            prod,
            mprod,
        })
    }

    #[cfg(debug_assertions)]
    fn open_sink(&self, kind: &crate::sink::SinkKind) -> Opened {
        use crate::sink::{SINK_BUFFER_FRAMES, SINK_CHANNELS, SINK_RATE};
        let (prod, mprod, renderer) = self.rings(SINK_RATE, SINK_CHANNELS);
        Opened {
            backend: Backend::Sink(Box::new(SinkOut {
                renderer,
                clock: Instant::now(),
                rendered: 0,
                buf: vec![0.0; SINK_BUFFER_FRAMES * usize::from(SINK_CHANNELS)],
                applied: Vec::with_capacity(16),
            })),
            rate: SINK_RATE,
            channels: SINK_CHANNELS,
            label: kind.label(),
            prod,
            mprod,
        }
    }

    /// Drops the running stream (the ring pair goes with it; decode keeps writing into its producer until the next
    /// `NewOutput`).
    fn close(&mut self, why: &str) {
        if let Some(active) = self.active.take() {
            log::info!(
                "audio output: stream {} on {} closed ({why})",
                active.generation,
                active.label
            );
            drop(active);
            self.stats.open.store(false, Ordering::Release);
        }
    }

    /// Without a stream: is there a default output device? Reports its label, or `NoOutputDevice` with a 2 s retry.
    fn probe(&mut self) {
        let found = match &self.kind {
            OutputKind::Device => select_device().map(|(_, device)| {
                let (rate, channels) = device
                    .default_output_config()
                    .map(|c| (c.sample_rate(), c.channels()))
                    .unwrap_or((0, 0));
                (device_label(&device), rate, channels)
            }),
            #[cfg(debug_assertions)]
            OutputKind::Sink(kind) => Ok((
                kind.label(),
                crate::sink::SINK_RATE,
                crate::sink::SINK_CHANNELS,
            )),
        };
        match found {
            Ok((device, rate, channels)) => {
                self.reported_failure = None;
                self.send_ctl(CtlMsg::OutputReady {
                    device,
                    rate,
                    channels,
                });
            }
            Err(e) => {
                self.retry_at = Some(Instant::now() + DEFAULT_DEVICE_POLL);
                self.report_failure(e);
            }
        }
    }

    fn report_failure(&mut self, e: AudioError) {
        if self.reported_failure.as_ref() != Some(&e) {
            self.reported_failure = Some(e.clone());
            self.send_ctl(CtlMsg::OutputFailed(e));
        }
    }

    fn send_ctl(&self, msg: CtlMsg) {
        if self.ctl.send(msg).is_err() {
            log::debug!("audio output: control is gone");
        }
    }

    /// ALSA/PulseAudio: rebuild when the default device id differs from the one the stream was built from.
    fn poll_default_device(&mut self, now: Instant) {
        let Some(active) = &mut self.active else {
            return;
        };
        let Some(c) = active.backend.cpal_mut() else {
            return;
        };
        if !c.next_poll.is_some_and(|t| now >= t) {
            return;
        }
        c.next_poll = Some(now + DEFAULT_DEVICE_POLL);
        let current = c.host.default_output_device().and_then(|d| d.id().ok());
        if current != c.device_id {
            log::info!(
                "audio output: default device changed ({:?} → {current:?})",
                c.device_id
            );
            let generation = active.generation;
            self.rebuild(generation);
        }
    }

    /// Debug sinks: renders every 10 ms buffer that is due by the wall clock, writes it to the WAV and logs the
    /// markers it applied.
    #[cfg(debug_assertions)]
    fn render_sink(&mut self) {
        use crate::sink::{SINK_BUFFER_FRAMES, marker_line};
        let Some(Active {
            backend: Backend::Sink(s),
            generation,
            rate,
            ..
        }) = &mut self.active
        else {
            return;
        };
        let rate = u64::from(*rate);
        let due = u64::try_from(s.clock.elapsed().as_nanos() * u128::from(rate) / 1_000_000_000)
            .unwrap_or(u64::MAX);
        let buffer = SINK_BUFFER_FRAMES as u64;
        // A stalled thread (debugger, suspended machine) skips ahead instead of rendering a burst.
        let max_lag = rate / 2;
        if due > s.rendered + max_lag {
            s.rendered = due - due % buffer;
        }
        while s.rendered + buffer <= due {
            s.applied.clear();
            s.renderer.render(&mut s.buf, 0, &mut s.applied);
            if let Some(wav) = self.sink_files.wav.as_mut()
                && let Err(e) = wav.write(&s.buf)
            {
                log::warn!("WAV sink: write failed, WAV disabled: {e}");
                self.sink_files.wav = None;
            }
            if let Some(log) = &self.sink_files.log
                && !s.applied.is_empty()
            {
                let base = self.device_frames;
                let lines: Vec<_> = s
                    .applied
                    .iter()
                    .map(|a| {
                        marker_line(&a.marker, a.read_frame, base + a.offset as u64, *generation)
                    })
                    .collect();
                log.write(&lines);
            }
            s.rendered += buffer;
            self.device_frames += buffer;
        }
    }
}

#[cfg(debug_assertions)]
impl SinkOut {
    fn next_buffer_at(&self, rate: u32) -> Instant {
        let next = self.rendered + crate::sink::SINK_BUFFER_FRAMES as u64;
        let nanos = u128::from(next) * 1_000_000_000 / u128::from(rate.max(1));
        self.clock + Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
    }
}

/// Runs on cpal's stream thread: maps a stream error to the device-event policy.
fn stream_error(tx: &Sender<OutMsg>, stats: &OutputStats, generation: u32, e: &cpal::Error) {
    let msg = match classify(e.kind()) {
        StreamEvent::Rebuild => {
            log::warn!(
                "audio stream {generation}: {e} ({:?}): rebuilding",
                e.kind()
            );
            OutMsg::Cmd(OutCmd::Rebuild { generation })
        }
        StreamEvent::Relabel => {
            log::info!("audio stream {generation}: {e}: rerouted");
            OutMsg::Cmd(OutCmd::DeviceChanged)
        }
        StreamEvent::Xrun => {
            stats.xruns.fetch_add(1, Ordering::Relaxed);
            return;
        }
        StreamEvent::Ignore => {
            log::debug!("audio stream {generation}: {e}");
            return;
        }
    };
    if tx.send(msg).is_err() {
        log::debug!("audio stream {generation}: output thread is gone");
    }
}

fn build_stream<T, E>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut renderer: Renderer,
    on_error: E,
) -> Result<cpal::Stream, cpal::Error>
where
    T: OutputSample,
    E: FnMut(cpal::Error) + Send + 'static,
{
    device.build_output_stream_raw(
        config,
        T::FORMAT,
        move |data: &mut cpal::Data, info: &cpal::OutputCallbackInfo| {
            if let Some(buf) = data.as_slice_mut::<T>() {
                T::render(&mut renderer, buf, latency_us(info));
            }
        },
        on_error,
        None,
    )
}

/// The first preferred host that initialises and has a default output device.
fn select_device() -> Result<(cpal::Host, cpal::Device), AudioError> {
    let mut hosts = cpal::available_hosts();
    hosts.sort_by_key(|id| host_rank(*id));
    let mut tried = Vec::with_capacity(hosts.len());
    for id in hosts {
        match cpal::host_from_id(id) {
            Ok(host) => match host.default_output_device() {
                Some(device) => return Ok((host, device)),
                None => tried.push(format!("{}: no default output device", id.name())),
            },
            Err(e) => tried.push(format!("{}: {e}", id.name())),
        }
    }
    log::debug!("audio output: no device ({})", tried.join("; "));
    Err(AudioError::NoOutputDevice)
}

/// The device's default config when its format is supported, else a supported format at the default rate.
fn choose_config(
    device: &cpal::Device,
    default: cpal::SupportedStreamConfig,
) -> Result<(cpal::StreamConfig, SampleFormat), AudioError> {
    let format = default.sample_format();
    if SUPPORTED_FORMATS.contains(&format) {
        return Ok((default.config(), format));
    }
    let rate = default.sample_rate();
    let ranges: Vec<_> = device
        .supported_output_configs()
        .map_err(|e| device_error("supported output configs", &e))?
        .collect();
    for wanted in SUPPORTED_FORMATS {
        if let Some(c) = ranges
            .iter()
            .copied()
            .filter(|r| r.sample_format() == wanted)
            .find_map(|r| r.try_with_sample_rate(rate))
        {
            log::info!("audio output: default format {format} unsupported, using {wanted}");
            return Ok((c.config(), wanted));
        }
    }
    Err(AudioError::Device(format!(
        "no supported sample format at {rate} Hz (default {format})"
    )))
}

/// `Device::description().name()`, the `AudioSnapshot.device` label.
fn device_label(device: &cpal::Device) -> String {
    device
        .description()
        .ok()
        .map(|d| d.name().trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "System default output".to_owned())
}

fn device_error(what: &str, e: &cpal::Error) -> AudioError {
    match e.kind() {
        cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::HostUnavailable => {
            AudioError::NoOutputDevice
        }
        _ => AudioError::Device(format!("{what}: {e}")),
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::float_cmp
)]
mod tests {
    use super::*;
    use crate::shared::MediaRate;

    const RATE: u32 = 48_000;

    /// A renderer with its producers.
    struct Rig {
        shared: Arc<Shared>,
        stats: Arc<OutputStats>,
        prod: Producer<f32>,
        mprod: Producer<Marker>,
        r: Renderer,
        written: u64,
    }

    impl Rig {
        fn new(channels: u16) -> Self {
            let shared = Arc::new(Shared::new());
            let stats = Arc::new(OutputStats::default());
            let (prod, cons) = RingBuffer::<f32>::new(RATE as usize * usize::from(channels));
            let (mprod, mcons) = RingBuffer::<Marker>::new(64);
            let r = Renderer::new(
                Arc::clone(&shared),
                Arc::clone(&stats),
                cons,
                mcons,
                RATE,
                channels,
            );
            Self {
                shared,
                stats,
                prod,
                mprod,
                r,
                written: 0,
            }
        }

        /// Writes `frames` frames whose samples are `value` (every channel).
        fn write(&mut self, frames: usize, value: f32) {
            let ch = self.r.channels;
            for _ in 0..frames * ch {
                self.prod.push(value).unwrap();
            }
            self.written += frames as u64;
        }

        fn marker(&mut self, generation: u32, kind: MarkerKind, seg: u32, pos_us: u64) {
            self.mprod
                .push(Marker {
                    generation,
                    ring_frame: self.written,
                    kind,
                    seg_index: seg,
                    file_pos_us: pos_us,
                    rate: MediaRate::new(100, RATE),
                    plays: 1,
                    passes: 1,
                })
                .unwrap();
        }

        /// A flush: bumps the generation and writes its marker at the current end.
        fn flush(&mut self, seg: u32, pos_us: u64) -> u32 {
            let g = self.shared.generation.load(Ordering::Relaxed) + 1;
            self.shared.generation.store(g, Ordering::Relaxed);
            self.marker(g, MarkerKind::Segment, seg, pos_us);
            g
        }

        fn render(&mut self, frames: usize) -> (Vec<f32>, Vec<AppliedMarker>) {
            let mut out = vec![9.0; frames * self.r.channels];
            let mut applied = Vec::new();
            self.r.render(&mut out, 0, &mut applied);
            (out, applied)
        }
    }

    #[test]
    fn plays_markers_on_their_exact_frames() {
        let mut rig = Rig::new(2);
        rig.shared.playing.store(true, Ordering::Relaxed);
        let g = rig.flush(0, 1_000_000);
        rig.write(100, 0.5);
        rig.marker(g, MarkerKind::Segment, 1, 2_000_000);
        rig.write(100, 0.5);
        let (out, applied) = rig.render(150);
        assert_eq!(applied.len(), 2);
        assert_eq!((applied[0].read_frame, applied[0].offset), (0, 0));
        assert_eq!((applied[1].read_frame, applied[1].offset), (100, 100));
        assert_eq!(rig.r.current().seg_index, 1);
        // Playing at full volume after a flush: bit-exact samples (decode fades in, the callback adds nothing).
        assert!(out.iter().all(|&s| s == 0.5));
        // Published as of the buffer's first frame: segment 0 at 1 s.
        assert_eq!(rig.shared.seg_index.load(Ordering::Relaxed), 0);
        assert_eq!(
            rig.shared.file_pos_us.load(Ordering::Relaxed),
            1_000_000,
            "position at the start of the buffer"
        );
        let (_, applied) = rig.render(10);
        assert!(applied.is_empty());
        assert_eq!(rig.shared.seg_index.load(Ordering::Relaxed), 1);
        // 150 frames in, under the second marker (100 frames past its 2 s).
        assert_eq!(
            rig.shared.file_pos_us.load(Ordering::Relaxed),
            2_000_000 + 50 * 1_000_000 / u64::from(RATE)
        );
        assert_eq!(rig.stats.heard_generation.load(Ordering::Relaxed), g);
        assert_eq!(rig.stats.played_frames.load(Ordering::Relaxed), 160);
    }

    #[test]
    fn sync_markers_never_change_the_published_kind() {
        let mut rig = Rig::new(1);
        rig.shared.playing.store(true, Ordering::Relaxed);
        let g = rig.flush(0, 0);
        rig.write(10, 0.1);
        rig.marker(g, MarkerKind::Gap, 0, 5_000);
        rig.write(10, 0.0);
        rig.marker(g, MarkerKind::Sync, 0, 5_000);
        rig.write(10, 0.0);
        rig.render(30);
        assert_eq!(
            rig.shared.marker_kind(),
            MarkerKind::Segment,
            "as of the first frame"
        );
        rig.render(1);
        assert_eq!(rig.shared.marker_kind(), MarkerKind::Gap);
        assert_eq!(rig.r.current().kind, MarkerKind::Sync);
    }

    #[test]
    fn stale_generations_are_discarded_with_a_declick() {
        let mut rig = Rig::new(1);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 0);
        rig.write(2_000, 1.0);
        let (out, _) = rig.render(100);
        assert!(out.iter().all(|&s| s == 1.0));
        // Flush with 1,900 stale frames in the ring.
        let g = rig.flush(3, 7_000_000);
        rig.write(1_000, 0.25);
        let (out, applied) = rig.render(1_000);
        let ramp = ms_to_frames(PAUSE_RAMP_MS, RATE);
        // The stale audio fades to silence over 8 ms…
        assert!(out[..ramp].windows(2).all(|w| w[1] <= w[0]));
        assert!(out[0] > 0.99 && out[ramp - 1] < 0.01);
        // …then the new generation plays at full volume from its marker.
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].marker.generation, g);
        assert_eq!(applied[0].read_frame, 2_000);
        assert_eq!(applied[0].offset, ramp);
        assert!(out[ramp..].iter().all(|&s| s == 0.25));
        assert_eq!(rig.r.read_frame(), 2_000 + (1_000 - ramp as u64));
        assert_eq!(rig.shared.seg_index.load(Ordering::Relaxed), 3);
        assert_eq!(rig.shared.file_pos_us.load(Ordering::Relaxed), 7_000_000);
    }

    #[test]
    fn a_flush_before_its_marker_drops_everything_and_waits() {
        let mut rig = Rig::new(1);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 0);
        rig.write(500, 0.5);
        rig.render(100);
        // Decode bumped the generation but has not written the new marker yet.
        rig.shared.generation.fetch_add(1, Ordering::Relaxed);
        let (out, _) = rig.render(400);
        assert!(
            out[384..].iter().all(|&s| s == 0.0),
            "silent after the declick"
        );
        assert_eq!(rig.r.read_frame(), 500, "every stale frame dropped");
        assert!(rig.shared.underruns.load(Ordering::Relaxed) >= 1);
    }

    #[test]
    fn pause_ramps_down_then_stops_consuming() {
        let mut rig = Rig::new(2);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 0);
        rig.write(10_000, 1.0);
        rig.render(480);
        rig.shared.playing.store(false, Ordering::Relaxed);
        let (out, _) = rig.render(480);
        let ramp = ms_to_frames(PAUSE_RAMP_MS, RATE);
        assert_eq!(rig.r.read_frame(), 480 + ramp as u64);
        assert!(out[(ramp - 1) * 2] < 0.01);
        assert!(out[ramp * 2..].iter().all(|&s| s == 0.0));
        let underruns = rig.shared.underruns.load(Ordering::Relaxed);
        let (out, _) = rig.render(480);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(
            rig.r.read_frame(),
            480 + ramp as u64,
            "paused: nothing consumed"
        );
        assert_eq!(rig.shared.underruns.load(Ordering::Relaxed), underruns);
        // Resume slews back up over 8 ms.
        rig.shared.playing.store(true, Ordering::Relaxed);
        let (out, _) = rig.render(480);
        assert!(out[0] < 0.01);
        assert!(out[..ramp * 2].windows(2).all(|w| w[1] >= w[0]));
        assert!(out[ramp * 2..].iter().all(|&s| s == 1.0));
    }

    #[test]
    fn volume_changes_ramp_linearly_across_the_buffer() {
        let mut rig = Rig::new(1);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 0);
        rig.write(1_000, 1.0);
        rig.render(100);
        rig.shared.set_gain(0.5);
        let (out, _) = rig.render(100);
        assert!((out[49] - 0.75).abs() < 0.01);
        assert!((out[99] - 0.5).abs() < 1e-6);
        let (out, _) = rig.render(100);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn underruns_count_while_playing_only() {
        let mut rig = Rig::new(1);
        rig.flush(0, 0);
        rig.render(100);
        assert_eq!(rig.shared.underruns.load(Ordering::Relaxed), 0);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.write(50, 0.5);
        let (out, _) = rig.render(100);
        assert_eq!(rig.shared.underruns.load(Ordering::Relaxed), 1);
        assert!(out[50..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn paused_flushes_publish_the_new_position() {
        let mut rig = Rig::new(1);
        rig.flush(0, 0);
        rig.write(100, 0.5);
        rig.render(50);
        let g = rig.flush(4, 9_000_000);
        rig.write(100, 0.5);
        let (out, applied) = rig.render(50);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(applied.len(), 1);
        assert_eq!(rig.shared.file_pos_us.load(Ordering::Relaxed), 9_000_000);
        assert_eq!(rig.stats.heard_generation.load(Ordering::Relaxed), g);
    }

    #[test]
    fn audible_position_subtracts_the_latency() {
        let mut rig = Rig::new(1);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 10_000_000);
        rig.write(4_800, 0.5);
        let mut out = vec![0.0; 2_400];
        rig.r.render(&mut out, 20_000, &mut ());
        assert_eq!(rig.shared.out_latency_us.load(Ordering::Relaxed), 20_000);
        // Read 2,400 frames (50 ms) past 10 s; 20 ms of it is still in the device.
        assert_eq!(rig.stats.audible_us.load(Ordering::Relaxed), 10_030_000);
    }

    #[test]
    fn integer_formats_are_converted() {
        let mut rig = Rig::new(2);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 0);
        rig.write(10_000, 0.5);
        let mut out = vec![0_i16; 2 * 5_000]; // larger than the scratch buffer
        rig.r.render_converted(&mut out, 0);
        assert!(out.iter().all(|&s| s == i16::from_sample(0.5_f32)));
        let mut out = vec![0_u16; 8];
        rig.r.render_converted(&mut out, 0);
        assert!(out.iter().all(|&s| s == u16::from_sample(0.5_f32)));
    }

    #[test]
    fn a_partial_trailing_frame_stays_silent() {
        let mut rig = Rig::new(2);
        rig.shared.playing.store(true, Ordering::Relaxed);
        rig.flush(0, 0);
        rig.write(10, 0.5);
        let mut out = vec![9.0; 5];
        rig.r.render(&mut out, 0, &mut ());
        assert_eq!(&out[..4], &[0.5; 4]);
        assert_eq!(out[4], 0.0);
    }

    #[test]
    fn device_event_policy() {
        assert_eq!(
            classify(cpal::ErrorKind::StreamInvalidated),
            StreamEvent::Rebuild
        );
        assert_eq!(
            classify(cpal::ErrorKind::DeviceNotAvailable),
            StreamEvent::Rebuild
        );
        assert_eq!(
            classify(cpal::ErrorKind::BackendError),
            StreamEvent::Rebuild
        );
        assert_eq!(
            classify(cpal::ErrorKind::DeviceChanged),
            StreamEvent::Relabel
        );
        assert_eq!(classify(cpal::ErrorKind::Xrun), StreamEvent::Xrun);
        assert_eq!(
            classify(cpal::ErrorKind::RealtimeDenied),
            StreamEvent::Ignore
        );
    }

    #[test]
    fn host_order_and_polling() {
        for id in cpal::available_hosts() {
            let name = id.name().to_ascii_lowercase();
            assert_eq!(
                polls_default_device(id),
                name == "alsa" || name == "pulseaudio",
                "{name}"
            );
            let rank = host_rank(id);
            match name.as_str() {
                "pipewire" => assert_eq!(rank, 0),
                "pulseaudio" => assert_eq!(rank, 1),
                "alsa" => assert_eq!(rank, 2),
                "wasapi" => assert_eq!(rank, 3),
                "coreaudio" => assert_eq!(rank, 4),
                _ => assert_eq!(rank, 5),
            }
        }
    }

    /// Decode on one thread flushing as fast as it can (each generation: its marker, then frames), the callback on
    /// another: every flush marker is applied on its own frame, never after frames of its generation were dropped.
    /// (The occupancy-before-marker order in `catch_up` closes a window of a few nanoseconds that this cannot hit
    /// reliably; the test guards the rest of the cross-thread protocol.)
    #[test]
    fn flush_markers_apply_on_their_frame_under_concurrency() {
        use std::sync::atomic::AtomicBool;
        let shared = Arc::new(Shared::new());
        shared.playing.store(true, Ordering::Relaxed);
        let stats = Arc::new(OutputStats::default());
        let (mut prod, cons) = RingBuffer::<f32>::new(4_096);
        let (mut mprod, mcons) = RingBuffer::<Marker>::new(256);
        let mut r = Renderer::new(Arc::clone(&shared), stats, cons, mcons, RATE, 1);
        let done = Arc::new(AtomicBool::new(false));
        let decode = {
            let shared = Arc::clone(&shared);
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let mut rng = crate::dsp::signals::Lcg::new(7);
                let mut written = 0_u64;
                for g in 1..=20_000_u32 {
                    shared.generation.store(g, Ordering::Release);
                    let m = Marker {
                        generation: g,
                        ring_frame: written,
                        kind: MarkerKind::Segment,
                        seg_index: g,
                        file_pos_us: 0,
                        rate: MediaRate::new(100, RATE),
                        plays: 1,
                        passes: 1,
                    };
                    while mprod.push(m).is_err() {
                        std::thread::yield_now();
                    }
                    let frames = 1 + ((rng.next_f32() + 1.0) * 40.0) as u64;
                    for _ in 0..frames {
                        while prod.push(0.5).is_err() {
                            std::thread::yield_now();
                        }
                        written += 1;
                    }
                }
                done.store(true, Ordering::Release);
            })
        };
        let mut applied = Vec::new();
        let mut out = vec![0.0; 64];
        while !done.load(Ordering::Acquire) {
            r.render(&mut out, 0, &mut applied);
        }
        decode.join().unwrap();
        assert!(applied.len() > 100, "{} markers applied", applied.len());
        for a in &applied {
            assert_eq!(
                a.read_frame, a.marker.ring_frame,
                "marker of generation {} applied late",
                a.marker.generation
            );
        }
    }

    #[test]
    fn stream_errors_map_to_commands() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let stats = OutputStats::default();
        stream_error(
            &tx,
            &stats,
            4,
            &cpal::Error::new(cpal::ErrorKind::StreamInvalidated),
        );
        stream_error(
            &tx,
            &stats,
            4,
            &cpal::Error::new(cpal::ErrorKind::DeviceChanged),
        );
        stream_error(&tx, &stats, 4, &cpal::Error::new(cpal::ErrorKind::Xrun));
        assert!(matches!(
            rx.try_recv(),
            Ok(OutMsg::Cmd(OutCmd::Rebuild { generation: 4 }))
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(OutMsg::Cmd(OutCmd::DeviceChanged))
        ));
        assert!(rx.try_recv().is_err());
        assert_eq!(stats.xruns.load(Ordering::Relaxed), 1);
    }
}
