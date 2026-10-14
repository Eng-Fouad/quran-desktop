//! `AudioEngine`: spawns the engine threads and exposes the public command API.
//!
//! ```text
//! AudioEngine ──CtlCmd──► qd-audio-ctl ──DecodeCmd──► qd-audio-decode ──sample + marker rings──► callback
//!   │                       ▲   │ Demand               ▲ NewOutput (new rings)           (stream owned by qd-audio-out)
//!   │                       │   ▼                      │                                         │
//!   │                       │ qd-audio-out ────────────┘                                         │ Shared, OutputStats
//!   │                       │   └─ CtlMsg::OutputReady/OutputFailed ──► qd-audio-ctl             ▼
//!   │                       └──── CtlCmd::Heard (end, buffering) ◄──── qd-audio-tick ──► EventSink (ticks, edges)
//!   └── atomics: pause, stop, volume (heard within one device buffer)
//! ```
//!
//! Every command is a non-blocking channel send; `pause`, `stop` and `set_volume` also act on the callback's atomics
//! directly, so they are heard within one device buffer even while control is blocked on the network. Every thread is
//! started with `std::thread::Builder` and never panics; a thread that cannot be started makes [`AudioEngine::start`]
//! fail with [`AudioError::Device`] after stopping the ones already running.
//!
//! The output is chosen at start: the system default device, or in debug builds a `QD_AUDIO_SINK` sink — see
//! [`OutputKind`]. Having no device is not an error: the engine runs with status `error(NoOutputDevice)` and retries
//! every 2 s.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Sender, unbounded};
use quran_types::limits::VOLUME_PCT;
use quran_types::{AbLoop, AudioSnapshot, GapSetting, PlayRequest, SeekTarget, SkipDirection};

use crate::control::{self, ControlParts, CtlCmd, Hub};
use crate::decode::{self, DecodeConfig};
use crate::dsp::volume_gain;
pub use crate::output::OutputKind;
use crate::output::{self, OutMsg, OutputParts, OutputStats};
use crate::shared::{DecodeCmd, OutCmd, Shared};
use crate::ticker::{self, TickerMsg};
use crate::{AudioError, CancelToken, EventSink, SourceProvider, TimingsSource};

/// How long [`AudioEngine::shutdown`] waits for the threads, in total.
const SHUTDOWN_WAIT: Duration = Duration::from_millis(500);

/// Engine tuning.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EngineConfig {
    /// Tick rate while playing (30).
    pub tick_hz: u32,
    /// Sample ring length (750 ms).
    pub ring_ms: u32,
    /// Ask control for the next file this long before the current file's last segment ends (20 s).
    pub prefetch_next_file_ms: u32,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            tick_hz: 30,
            ring_ms: 750,
            prefetch_next_file_ms: 20_000,
        }
    }
}

impl EngineConfig {
    /// Clamped to workable values: 1..=120 Hz ticks, a 100..=5000 ms ring.
    #[must_use]
    pub fn validated(self) -> Self {
        Self {
            tick_hz: self.tick_hz.clamp(1, 120),
            ring_ms: self.ring_ms.clamp(100, 5_000),
            prefetch_next_file_ms: self.prefetch_next_file_ms,
        }
    }
}

/// Counters for logs, diagnostics and tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct EngineDiagnostics {
    /// Output streams built so far (the generation `OutCmd::Rebuild` refers to).
    pub output_generation: u32,
    /// Streams replaced after a device event.
    pub rebuilds: u32,
    /// A stream (or debug sink) is running.
    pub output_open: bool,
    /// Sample rate and channels of the running (or last) stream.
    pub sample_rate: u32,
    pub channels: u32,
    /// Decode's flush generation, and the one the callback hears.
    pub decode_generation: u32,
    pub heard_generation: u32,
    /// Device buffers that found the ring short while playing.
    pub underruns: u32,
    /// cpal `Xrun` reports.
    pub xruns: u32,
}

/// Handle on the running engine. `Send + Sync`; every command is non-blocking (a channel send).
pub struct AudioEngine {
    hub: Arc<Hub>,
    ctl: Sender<CtlCmd>,
    decode: Sender<DecodeCmd>,
    out: Sender<OutMsg>,
    tick: Sender<TickerMsg>,
    /// Joined once by [`AudioEngine::shutdown`].
    threads: Mutex<Option<Vec<JoinHandle<()>>>>,
}

impl AudioEngine {
    /// Starts the engine threads on the system default output (in debug builds, on the `QD_AUDIO_SINK` sink when the
    /// variable is set). Having no output device is not an error: the engine runs with status `error(NoOutputDevice)`
    /// and retries every 2 s.
    ///
    /// # Errors
    /// [`AudioError::Device`] when the OS refuses one of the engine threads.
    pub fn start(
        cfg: EngineConfig,
        timings: Arc<dyn TimingsSource>,
        sources: Arc<dyn SourceProvider>,
        sink: Arc<dyn EventSink>,
    ) -> Result<Self, AudioError> {
        Self::start_with_output(cfg, timings, sources, sink, OutputKind::from_env())
    }

    /// [`AudioEngine::start`] on an explicit output (tests use the debug sinks this way, without the environment).
    ///
    /// # Errors
    /// [`AudioError::Device`] when the OS refuses one of the engine threads.
    pub fn start_with_output(
        cfg: EngineConfig,
        timings: Arc<dyn TimingsSource>,
        sources: Arc<dyn SourceProvider>,
        sink: Arc<dyn EventSink>,
        output: OutputKind,
    ) -> Result<Self, AudioError> {
        let cfg = cfg.validated();
        let shared = Arc::new(Shared::new());
        let stats = Arc::new(OutputStats::default());
        #[cfg(debug_assertions)]
        let sink_log = match &output {
            OutputKind::Sink(crate::sink::SinkKind::Wav(path)) => {
                let path = crate::sink::SinkKind::log_path(path);
                crate::sink::EventLog::create(&path)
                    .map_err(|e| log::error!("WAV sink: cannot create {}: {e}", path.display()))
                    .ok()
                    .map(Arc::new)
            }
            _ => None,
        };
        let hub = Hub::new(Arc::clone(&shared), Arc::clone(&stats), sink);
        #[cfg(debug_assertions)]
        let hub = hub.with_log(sink_log.clone());
        let hub = Arc::new(hub);
        log::info!("audio engine: starting on {output:?} ({cfg:?})");

        let (ctl_tx, ctl_rx) = unbounded::<CtlCmd>();
        // Unbounded: decode blocks on sending NeedSource/DecodeFailed/QueueEnded.
        let (msg_tx, msg_rx) = unbounded();
        let (decode_tx, decode_rx) = unbounded::<DecodeCmd>();
        let (out_tx, out_rx) = unbounded::<OutMsg>();
        let (tick_tx, tick_rx) = unbounded::<TickerMsg>();

        let engine = Self {
            hub: Arc::clone(&hub),
            ctl: ctl_tx.clone(),
            decode: decode_tx.clone(),
            out: out_tx.clone(),
            tick: tick_tx.clone(),
            threads: Mutex::new(Some(Vec::with_capacity(4))),
        };
        let started = |handle: Result<JoinHandle<()>, AudioError>| -> Result<(), AudioError> {
            let handle = handle?;
            engine
                .threads
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_or_insert_with(Vec::new)
                .push(handle);
            Ok(())
        };
        let spawned = (|| {
            started(decode::spawn(
                DecodeConfig::from(&cfg),
                decode_rx,
                msg_tx.clone(),
                Arc::clone(&shared),
            ))?;
            started(output::spawn(OutputParts {
                kind: output,
                rx: out_rx,
                tx: out_tx.clone(),
                decode: decode_tx.clone(),
                ctl: msg_tx.clone(),
                shared: Arc::clone(&shared),
                stats: Arc::clone(&stats),
                ring_ms: cfg.ring_ms,
                #[cfg(debug_assertions)]
                sink_log,
            }))?;
            started(ticker::spawn(
                Arc::clone(&hub),
                ctl_tx.clone(),
                tick_rx,
                cfg.tick_hz,
            ))?;
            started(control::spawn(ControlParts {
                hub: Arc::clone(&hub),
                timings,
                sources,
                cmd_rx: ctl_rx,
                msg_rx,
                msg_tx: msg_tx.clone(),
                decode: decode_tx.clone(),
                out: out_tx.clone(),
                ticker: tick_tx.clone(),
            }))
        })();
        if let Err(e) = spawned {
            log::error!("audio engine: {e}");
            engine.shutdown();
            return Err(e);
        }
        Ok(engine)
    }

    /// Plays `req.from ..= req.to` (`to` resolved by the glue). The snapshot reads `loading` from now on. The play this
    /// one replaces is cancelled ([`CancelToken`]): whatever it is blocked on (a timings fetch, a connect, a stream
    /// read waiting for bytes) gives up, so this play never waits for the network on its behalf.
    pub fn play(&self, req: PlayRequest) {
        let number = self.hub.announce_play(&req);
        let token = CancelToken::new();
        let replaced = self.hub.replace_play_token(token.clone());
        self.send(CtlCmd::Play(Box::new(req), token, number));
        // After the send: when the replaced play's work gives up, control already finds this play waiting.
        replaced.cancel();
    }

    /// Heard within one device buffer (an 8 ms ramp to silence).
    pub fn pause(&self) {
        self.hub.shared.playing.store(false, Ordering::Release);
        self.send(CtlCmd::Pause);
    }

    /// Plays on after a pause. After the play failed mid-way (a stream that stalled or went offline, a later file that
    /// is offline), it starts again where it stopped: the segment that was heard, in the same pass.
    pub fn resume(&self) {
        self.send(CtlCmd::Resume);
    }

    /// Pauses what is heard, else resumes (see [`AudioEngine::resume`]).
    pub fn toggle(&self) {
        if self.hub.shared.playing.load(Ordering::Acquire) {
            self.pause();
        } else {
            self.send(CtlCmd::Toggle);
        }
    }

    /// Silences at once (ramped) and drops the play, cancelling what it is blocked on.
    pub fn stop(&self) {
        self.hub.shared.playing.store(false, Ordering::Release);
        self.send(CtlCmd::Stop);
        self.hub.cancel_play();
    }

    /// Previous within 1.5 s of the segment start ⇒ previous ayah, else restart the current one. Next at the last
    /// segment starts the next pass while range repeats remain (the snapshot's `range_repeat_left > 0`, or infinite),
    /// else ends the play.
    pub fn skip(&self, dir: SkipDirection) {
        self.send(CtlCmd::Skip(dir));
    }

    /// An ayah of the playing range, or a position on the heard file's timeline (absolute or relative), bounded to the
    /// part of that file the queue plays around the heard ayah (never the file's audio outside the range).
    pub fn seek(&self, target: SeekTarget) {
        self.send(CtlCmd::Seek(target));
    }

    /// 50..=200, step 5; 100 bypasses WSOLA. A change flushes and continues at the heard position.
    pub fn set_speed(&self, pct: u32) {
        self.send(CtlCmd::SetSpeed(pct));
    }

    /// 0..=100 (square-law gain); ramped across one device buffer, heard at once.
    pub fn set_volume(&self, pct: u32) {
        let pct = VOLUME_PCT.apply(pct);
        self.hub.shared.set_gain(volume_gain(pct));
        self.send(CtlCmd::SetVolume(pct));
    }

    /// 1..=99, 0 = infinite; applied in-band from the next segment boundary.
    pub fn set_repeat(&self, ayah_repeat: u32, range_repeat: u32) {
        self.send(CtlCmd::SetRepeat {
            ayah: ayah_repeat,
            range: range_repeat,
        });
    }

    pub fn set_gap(&self, gap: GapSetting) {
        self.send(CtlCmd::SetGap(gap));
    }

    /// On the heard file's timeline, bounded like a seek (the snapshot reports the bounded loop); `None` clears it.
    /// Ignored without a play, when `b ≤ a`, or when the bounded loop is shorter than 300 ms (which clears a loop in
    /// force).
    pub fn set_ab_loop(&self, ab: Option<AbLoop>) {
        self.send(CtlCmd::SetAbLoop(ab));
    }

    /// The current state with the live, latency-compensated position.
    #[must_use]
    pub fn snapshot(&self) -> AudioSnapshot {
        self.hub.snapshot()
    }

    /// Output and flush counters.
    #[must_use]
    pub fn diagnostics(&self) -> EngineDiagnostics {
        let stats = &self.hub.stats;
        let shared = &self.hub.shared;
        EngineDiagnostics {
            output_generation: stats.output_generation.load(Ordering::Acquire),
            rebuilds: stats.rebuilds.load(Ordering::Relaxed),
            output_open: stats.open.load(Ordering::Acquire),
            sample_rate: stats.rate.load(Ordering::Relaxed),
            channels: stats.channels.load(Ordering::Relaxed),
            decode_generation: shared.generation.load(Ordering::Acquire),
            heard_generation: stats.heard_generation.load(Ordering::Acquire),
            underruns: shared.underruns.load(Ordering::Relaxed),
            xruns: stats.xruns.load(Ordering::Relaxed),
        }
    }

    /// Sends a device command to `qd-audio-out` as if a stream had reported it (tests of the device-event policy).
    #[cfg(any(test, feature = "testing"))]
    pub fn inject_output_command(&self, cmd: OutCmd) {
        if self.out.send(OutMsg::Cmd(cmd)).is_err() {
            log::debug!("audio engine: output thread is gone");
        }
    }

    /// Idempotent and callable through `&AppState`: the first call stops the threads and joins them within 500 ms
    /// (a thread still blocked after that, e.g. control in a network open, is detached), later calls return
    /// immediately.
    pub fn shutdown(&self) {
        let Some(threads) = self
            .threads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        else {
            return;
        };
        self.hub.shared.playing.store(false, Ordering::Release);
        let _ = self.ctl.send(CtlCmd::Shutdown);
        // A control thread blocked in a fetch or a connect for the play returns now, and joins in time.
        self.hub.cancel_play();
        let _ = self.decode.send(DecodeCmd::Shutdown);
        let _ = self.out.send(OutMsg::Cmd(OutCmd::Shutdown));
        let _ = self.tick.send(TickerMsg::Shutdown);
        let deadline = Instant::now() + SHUTDOWN_WAIT;
        for handle in threads {
            while !handle.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            let name = handle.thread().name().unwrap_or("audio thread").to_owned();
            if handle.is_finished() {
                if handle.join().is_err() {
                    log::error!("audio engine: {name} panicked");
                }
            } else {
                log::warn!("audio engine: {name} did not stop within {SHUTDOWN_WAIT:?}; detached");
            }
        }
        log::info!("audio engine: stopped");
    }

    fn send(&self, cmd: CtlCmd) {
        if self.ctl.send(cmd).is_err() {
            log::debug!("audio engine: control is gone (engine stopped)");
        }
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl std::fmt::Debug for AudioEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioEngine")
            .field("diagnostics", &self.diagnostics())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn configs_are_clamped() {
        let c = EngineConfig {
            tick_hz: 0,
            ring_ms: 10,
            prefetch_next_file_ms: 7,
        }
        .validated();
        assert_eq!((c.tick_hz, c.ring_ms, c.prefetch_next_file_ms), (1, 100, 7));
        assert_eq!(EngineConfig::default().validated(), EngineConfig::default());
    }

    #[test]
    fn engines_are_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<AudioEngine>();
    }
}
