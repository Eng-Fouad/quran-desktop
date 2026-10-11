//! `qd-audio-tick`: while playing, every `1000 / tick_hz` ms reads [`crate::shared::Shared`], maps `seg_index` through the
//! published `Arc<[Segment]>`, finds the active word by binary search and sends `AudioTick`; on a `seg_index` or
//! `marker_kind` edge calls `EventSink::ayah_changed` and `EventSink::state`; parks while paused or idle
//! (docs/ARCHITECTURE.md §2.3.6). Owner: WP4c.
//!
//! - **Ticks.** At most `tick_hz` per second while playing or buffering; otherwise one tick per change, during a short
//!   window after each control wake-up (a seek while paused is published as soon as the callback has heard it), then the
//!   thread parks on its channel: no busy loop.
//! - **Edges.** A new (generation, segment, marker kind) heard at the callback emits `state`; entering a segment whose
//!   ayah differs from the last one reported also emits `ayah_changed` (the basmala as ayah 0). Repeats of one ayah and
//!   seeks inside it are not ayah changes, but a new play or pass of a repeat is a `state` edge: the repeat counters
//!   (`ayah_repeat_left`, `range_repeat_left`) change there, and the player's "2/3" badge follows them live.
//! - **Heard events** go back to control, which owns the status: the End marker heard (→ idle), and buffering on/off —
//!   the ring starving for two consecutive ticks while the heard source is incomplete or a source is being opened, and
//!   flowing again for two (§2.3.6: "while the underrun counter rises and the source is not complete").

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use quran_types::{AudioTick, AyahChange, PlaybackStatus};

use crate::AudioError;
use crate::control::{CtlCmd, Heard, Hub, Live};
use crate::shared::{FULLY_BUFFERED, MarkerKind};

/// How long the ticker keeps watching after a control wake-up while not playing.
const WAKE_WINDOW: Duration = Duration::from_millis(1_000);
/// Consecutive starving (or flowing) ticks before buffering is reported on (or off).
const BUFFERING_TICKS: u32 = 2;

/// Messages to `qd-audio-tick`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TickerMsg {
    /// Something changed (a command, a status): watch for a while.
    Wake,
    Shutdown,
}

/// Spawns `qd-audio-tick`.
///
/// # Errors
/// [`AudioError::Device`] when the OS refuses the thread (never panics, §0.2).
pub(crate) fn spawn(
    hub: Arc<Hub>,
    ctl: Sender<CtlCmd>,
    rx: Receiver<TickerMsg>,
    tick_hz: u32,
) -> Result<JoinHandle<()>, AudioError> {
    let period = Duration::from_micros(1_000_000 / u64::from(tick_hz.max(1)));
    std::thread::Builder::new()
        .name("qd-audio-tick".to_owned())
        .spawn(move || Ticker::new(hub, ctl, rx, period).run())
        .map_err(|e| AudioError::Device(format!("cannot start qd-audio-tick: {e}")))
}

/// Starvation tracking between ticks.
#[derive(Debug)]
struct Flow {
    underruns: u32,
    played: u64,
    at: Instant,
    starving: u32,
    flowing: u32,
    /// What was last asked of control (cleared when the status moves on).
    asked: Option<bool>,
    status: PlaybackStatus,
}

struct Ticker {
    hub: Arc<Hub>,
    ctl: Sender<CtlCmd>,
    rx: Receiver<TickerMsg>,
    period: Duration,
    seq: u32,
    last_tick: Option<AudioTick>,
    /// (generation, segment, marker kind) last heard.
    edge: Option<(u32, u32, MarkerKind)>,
    /// Decode's repeat progress (plays of the heard segment, passes over the queue) at the last edge.
    progress: (u32, u32),
    /// (reciter, surah, ayah) last reported by `ayah_changed`.
    ayah: Option<(u32, u32, u32)>,
    /// Generation whose End was reported to control.
    ended: Option<u32>,
    flow: Flow,
    awake_until: Instant,
    next_tick: Instant,
}

impl Ticker {
    fn new(hub: Arc<Hub>, ctl: Sender<CtlCmd>, rx: Receiver<TickerMsg>, period: Duration) -> Self {
        let now = Instant::now();
        Self {
            hub,
            ctl,
            rx,
            period,
            seq: 0,
            last_tick: None,
            edge: None,
            progress: (0, 0),
            ayah: None,
            ended: None,
            flow: Flow {
                underruns: 0,
                played: 0,
                at: now,
                starving: 0,
                flowing: 0,
                asked: None,
                status: PlaybackStatus::Idle,
            },
            awake_until: now,
            next_tick: now,
        }
    }

    fn run(mut self) {
        loop {
            let now = Instant::now();
            let active = playing(self.hub.shared.status()) || now < self.awake_until;
            let msg = if active {
                self.rx.recv_deadline(self.next_tick.max(now))
            } else {
                // Parked until the next command wake-up.
                self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            };
            match msg {
                Ok(TickerMsg::Wake) => {
                    let now = Instant::now();
                    if !active {
                        self.next_tick = now;
                    }
                    self.awake_until = now + WAKE_WINDOW;
                }
                Ok(TickerMsg::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            if now >= self.next_tick {
                self.step(now);
                // Fixed cadence; after a stall, restart from now instead of bursting.
                self.next_tick += self.period;
                if self.next_tick < now {
                    self.next_tick = now + self.period;
                }
            }
        }
    }

    fn step(&mut self, now: Instant) {
        let status = self.hub.shared.status();
        let live = if status == PlaybackStatus::Idle {
            None
        } else {
            self.hub.live()
        };
        self.edges(live.as_ref());
        self.watch_end(live.as_ref());
        self.watch_buffering(status, live.as_ref(), now);
        let tick = self.tick(status, live.as_ref());
        let changed = self
            .last_tick
            .as_ref()
            .is_none_or(|last| !same_tick(last, &tick));
        if playing(status) || changed {
            self.seq = self.seq.wrapping_add(1);
            let tick = AudioTick {
                seq: self.seq,
                ..tick
            };
            self.hub.sink.tick(&tick);
            #[cfg(debug_assertions)]
            if let Some(log) = &self.hub.log {
                log.tick(&tick);
            }
            self.last_tick = Some(tick);
        }
    }

    fn tick(&self, status: PlaybackStatus, live: Option<&Live>) -> AudioTick {
        let speed_pct = self.hub.speed_pct.load(Ordering::Relaxed);
        match live.filter(|l| l.kind != MarkerKind::End) {
            Some(l) => AudioTick {
                seq: 0,
                generation: l.generation,
                status,
                surah: l.surah,
                ayah: l.ayah,
                ayah_id: l.ayah_id,
                file_ms: l.file_ms,
                word_pos: l.word_pos,
                speed_pct,
                in_gap: l.kind == MarkerKind::Gap,
                buffered_pct: l.buffered_permille / 10,
            },
            None => AudioTick {
                seq: 0,
                generation: self.hub.shared.generation.load(Ordering::Acquire),
                status,
                surah: 0,
                ayah: 0,
                ayah_id: 0,
                file_ms: 0,
                word_pos: 0,
                speed_pct,
                in_gap: false,
                buffered_pct: 0,
            },
        }
    }

    /// Marker edges and repeat iterations → `state`, ayah changes → `ayah_changed`.
    fn edges(&mut self, live: Option<&Live>) {
        let Some(l) = live else {
            // Stopped or idle: the next play reports its first ayah again.
            self.edge = None;
            self.ayah = None;
            self.progress = (0, 0);
            return;
        };
        if !l.fresh {
            return;
        }
        let key = (l.generation, l.seg_index, l.kind);
        // The callback publishes the progress with the segment it belongs to; another segment's (a read between two
        // publications) is not this one's and waits for the next tick.
        let published = self.hub.shared.repeat_progress();
        let progress = if published.seg_index == l.seg_index {
            (published.plays, published.passes)
        } else {
            self.progress
        };
        let new_marker = self.edge != Some(key);
        if !new_marker && self.progress == progress {
            return;
        }
        self.progress = progress;
        if !new_marker {
            // The same segment again: another play of a repeated ayah (or pass of the range).
            self.hub.sink.state(&self.hub.snapshot());
            return;
        }
        self.edge = Some(key);
        match l.kind {
            MarkerKind::Segment | MarkerKind::Sync => {
                let ayah = (l.reciter_id, l.surah, l.ayah);
                if self.ayah != Some(ayah) {
                    self.ayah = Some(ayah);
                    self.hub.sink.ayah_changed(&AyahChange {
                        reciter_id: l.reciter_id,
                        surah: l.surah,
                        ayah: l.ayah,
                        ayah_id: l.ayah_id,
                    });
                }
            }
            MarkerKind::End => self.ayah = None,
            MarkerKind::Gap => {}
        }
        self.hub.sink.state(&self.hub.snapshot());
    }

    /// The End marker heard → control sets idle.
    fn watch_end(&mut self, live: Option<&Live>) {
        let Some(l) = live.filter(|l| l.fresh && l.kind == MarkerKind::End) else {
            return;
        };
        if self.ended != Some(l.generation) {
            self.ended = Some(l.generation);
            self.to_control(Heard::Ended {
                generation: l.generation,
            });
        }
    }

    /// Playing ⇄ buffering (see the module docs).
    fn watch_buffering(&mut self, status: PlaybackStatus, live: Option<&Live>, now: Instant) {
        let underruns = self.hub.shared.underruns.load(Ordering::Relaxed);
        let played = self.hub.stats.played_frames.load(Ordering::Relaxed);
        let rate = u64::from(self.hub.stats.rate.load(Ordering::Relaxed));
        let f = &mut self.flow;
        let new_underruns = underruns.wrapping_sub(f.underruns);
        let new_played = played.saturating_sub(f.played);
        let elapsed = now.saturating_duration_since(f.at);
        let expected =
            u64::try_from(elapsed.as_micros() * u128::from(rate) / 1_000_000).unwrap_or(u64::MAX);
        f.underruns = underruns;
        f.played = played;
        f.at = now;
        if status != f.status {
            f.status = status;
            f.asked = None;
            f.starving = 0;
            f.flowing = 0;
        }
        if !playing(status) {
            return;
        }
        let ended = live.is_some_and(|l| l.kind == MarkerKind::End);
        if new_underruns > 0 && new_played.saturating_mul(2) < expected && !ended {
            f.starving += 1;
            f.flowing = 0;
        } else if new_played > 0 {
            f.flowing += 1;
            f.starving = 0;
        }
        let ask = match status {
            PlaybackStatus::Playing
                if f.starving >= BUFFERING_TICKS && source_incomplete(&self.hub, live) =>
            {
                Some(true)
            }
            PlaybackStatus::Buffering if f.flowing >= BUFFERING_TICKS => Some(false),
            _ => None,
        };
        if let Some(on) = ask
            && f.asked != Some(on)
        {
            f.asked = Some(on);
            self.to_control(Heard::Buffering(on));
        }
    }

    fn to_control(&self, heard: Heard) {
        if self.ctl.send(CtlCmd::Heard(heard)).is_err() {
            log::debug!("qd-audio-tick: control is gone");
        }
    }
}

/// Playing or buffering: ticks run at `tick_hz`.
fn playing(status: PlaybackStatus) -> bool {
    matches!(status, PlaybackStatus::Playing | PlaybackStatus::Buffering)
}

/// A starving ring means buffering (not a glitch) when the heard source is still downloading, a source is being
/// opened, or the callback has not heard the current generation yet (decode waits for a source).
fn source_incomplete(hub: &Hub, live: Option<&Live>) -> bool {
    hub.opening.load(Ordering::Acquire) > 0
        || live.is_none_or(|l| !l.fresh || l.buffered_permille < FULLY_BUFFERED)
}

/// Two ticks report the same thing (the sequence number aside).
fn same_tick(a: &AudioTick, b: &AudioTick) -> bool {
    AudioTick {
        seq: 0,
        ..a.clone()
    } == AudioTick {
        seq: 0,
        ..b.clone()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use std::sync::Mutex;

    use quran_types::AudioSnapshot;

    use super::*;
    use crate::output::OutputStats;
    use crate::shared::Shared;
    use crate::{AudioError as Err_, EventSink};

    #[derive(Default)]
    struct Recording {
        ticks: Mutex<Vec<AudioTick>>,
        states: Mutex<u32>,
        ayahs: Mutex<Vec<AyahChange>>,
    }

    impl EventSink for Recording {
        fn tick(&self, t: &AudioTick) {
            self.ticks.lock().unwrap().push(t.clone());
        }
        fn state(&self, _s: &AudioSnapshot) {
            *self.states.lock().unwrap() += 1;
        }
        fn ayah_changed(&self, c: &AyahChange) {
            self.ayahs.lock().unwrap().push(*c);
        }
        fn error(&self, _e: &Err_) {}
    }

    fn ticker(sink: Arc<Recording>) -> (Ticker, Receiver<CtlCmd>) {
        let hub = Arc::new(Hub::new(
            Arc::new(Shared::new()),
            Arc::new(OutputStats::default()),
            sink,
        ));
        let (ctl, ctl_rx) = crossbeam_channel::unbounded();
        let (_tx, rx) = crossbeam_channel::unbounded();
        (Ticker::new(hub, ctl, rx, Duration::from_millis(33)), ctl_rx)
    }

    fn live(generation: u32, seg: u32, ayah: u32, kind: MarkerKind) -> Live {
        Live {
            generation,
            seg_index: seg,
            kind,
            segment_kind: crate::SegmentKind::Ayah,
            reciter_id: 7,
            surah: 1,
            ayah,
            ayah_id: ayah,
            file_ms: 0,
            word_pos: 0,
            file_duration_ms: 0,
            ayah_from_ms: 0,
            ayah_to_ms: 0,
            buffered_permille: 1_000,
            fresh: true,
        }
    }

    #[test]
    fn ayah_changes_fire_on_new_ayahs_only() {
        let sink = Arc::new(Recording::default());
        let (mut t, _ctl) = ticker(Arc::clone(&sink));
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment)));
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment)));
        t.edges(Some(&live(1, 0, 1, MarkerKind::Gap)));
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment))); // a repeat of 1:1
        t.edges(Some(&live(2, 0, 1, MarkerKind::Segment))); // a seek inside it
        t.edges(Some(&live(2, 1, 2, MarkerKind::Segment)));
        let ayahs: Vec<u32> = sink.ayahs.lock().unwrap().iter().map(|c| c.ayah).collect();
        assert_eq!(ayahs, [1, 2]);
        assert_eq!(*sink.states.lock().unwrap(), 5, "every marker edge");
        // Not fresh: no edge. Stopped: the next play reports its first ayah again.
        t.edges(Some(&Live {
            fresh: false,
            ..live(3, 0, 9, MarkerKind::Segment)
        }));
        t.edges(None);
        t.edges(Some(&live(4, 1, 2, MarkerKind::Segment)));
        assert_eq!(sink.ayahs.lock().unwrap().len(), 3);
    }

    /// Another play of a repeated ayah reuses its marker key (same generation, segment and kind) but not its progress:
    /// a state edge, never an ayah change. Progress published for another segment is not taken for this one's.
    #[test]
    fn repeat_iterations_are_state_edges() {
        use crate::shared::Marker;
        let sink = Arc::new(Recording::default());
        let (mut t, _ctl) = ticker(Arc::clone(&sink));
        let publish = |t: &Ticker, seg_index: u32, plays: u32| {
            t.hub.shared.set_repeat_progress(&Marker {
                seg_index,
                plays,
                passes: 1,
                ..Marker::INITIAL
            });
        };
        publish(&t, 0, 1);
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment)));
        assert_eq!(*sink.states.lock().unwrap(), 1);
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment)));
        assert_eq!(*sink.states.lock().unwrap(), 1, "nothing new");
        publish(&t, 0, 2);
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment)));
        assert_eq!(*sink.states.lock().unwrap(), 2, "the second play");
        // The next segment's counters while segment 0 is still published as heard: not an edge yet.
        publish(&t, 1, 1);
        t.edges(Some(&live(1, 0, 1, MarkerKind::Segment)));
        assert_eq!(*sink.states.lock().unwrap(), 2);
        assert_eq!(sink.ayahs.lock().unwrap().len(), 1, "one ayah change");
    }

    #[test]
    fn the_end_is_reported_once_per_generation() {
        let sink = Arc::new(Recording::default());
        let (mut t, ctl) = ticker(sink);
        t.watch_end(Some(&live(5, 3, 7, MarkerKind::End)));
        t.watch_end(Some(&live(5, 3, 7, MarkerKind::End)));
        t.watch_end(Some(&live(5, 3, 7, MarkerKind::Segment)));
        assert!(matches!(
            ctl.try_recv(),
            Ok(CtlCmd::Heard(Heard::Ended { generation: 5 }))
        ));
        assert!(ctl.try_recv().is_err());
    }

    #[test]
    fn buffering_needs_starvation_and_an_incomplete_source() {
        let sink = Arc::new(Recording::default());
        let (mut t, ctl) = ticker(sink);
        t.hub.stats.rate.store(48_000, Ordering::Relaxed);
        let start = Instant::now();
        let mut at = start;
        let mut step = |t: &mut Ticker, status, l: &Live, underrun: bool, played: u64| {
            at += Duration::from_millis(33);
            if underrun {
                t.hub.shared.underruns.fetch_add(1, Ordering::Relaxed);
            }
            t.hub
                .stats
                .played_frames
                .fetch_add(played, Ordering::Relaxed);
            t.watch_buffering(status, Some(l), at);
        };
        let complete = live(1, 0, 1, MarkerKind::Segment);
        let streaming = Live {
            buffered_permille: 300,
            ..complete.clone()
        };
        // A glitch on a complete file is not buffering.
        for _ in 0..4 {
            step(&mut t, PlaybackStatus::Playing, &complete, true, 0);
        }
        assert!(ctl.try_recv().is_err());
        step(&mut t, PlaybackStatus::Playing, &complete, false, 1_584);
        // A starving stream is, after two ticks.
        step(&mut t, PlaybackStatus::Playing, &streaming, true, 0);
        assert!(ctl.try_recv().is_err());
        step(&mut t, PlaybackStatus::Playing, &streaming, true, 0);
        assert!(matches!(
            ctl.try_recv(),
            Ok(CtlCmd::Heard(Heard::Buffering(true)))
        ));
        step(&mut t, PlaybackStatus::Playing, &streaming, true, 0);
        assert!(ctl.try_recv().is_err(), "asked once");
        // Flowing again for two ticks ends it.
        step(&mut t, PlaybackStatus::Buffering, &streaming, false, 1_584);
        step(&mut t, PlaybackStatus::Buffering, &streaming, false, 1_584);
        assert!(matches!(
            ctl.try_recv(),
            Ok(CtlCmd::Heard(Heard::Buffering(false)))
        ));
    }

    #[test]
    fn ticks_send_while_playing_and_on_change_otherwise() {
        let sink = Arc::new(Recording::default());
        let (mut t, _ctl) = ticker(Arc::clone(&sink));
        let now = Instant::now();
        t.hub.shared.set_status(PlaybackStatus::Paused);
        t.step(now);
        t.step(now);
        assert_eq!(
            sink.ticks.lock().unwrap().len(),
            1,
            "paused: once per change"
        );
        t.hub.shared.set_status(PlaybackStatus::Playing);
        t.step(now);
        t.step(now);
        let ticks = sink.ticks.lock().unwrap();
        assert_eq!(ticks.len(), 3);
        assert_eq!(ticks[2].seq, 3);
        assert_eq!(ticks[2].status, PlaybackStatus::Playing);
    }
}
