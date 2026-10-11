//! Shared helpers of the `engine_*` tests (included with `#[path]`; also built as its own empty test target).
//!
//! Every engine here runs on a debug sink (`OutputKind::Sink`), never on the audio device (LEAD item 9).
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::missing_panics_doc
)]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use quran_audio::fake_out::fixtures::{FixtureSources, FixtureTimings, Layout};
use quran_audio::{AudioEngine, AudioError, EngineConfig, EventSink, OutputKind};
use quran_types::{
    AudioSnapshot, AudioTick, AyahChange, AyahRef, GapSetting, MushafLayout, PlayRequest,
    PlaybackStatus,
};

/// The fixture reciter.
pub const RECITER: u32 = 7;
/// The sinks' rate: fixtures at this rate play bit-exactly at 100 % (no resampling).
pub const RATE: u32 = 48_000;

/// Everything the engine reported.
#[derive(Default)]
pub struct Events {
    pub ticks: Mutex<Vec<AudioTick>>,
    pub states: Mutex<Vec<AudioSnapshot>>,
    pub ayahs: Mutex<Vec<AyahChange>>,
    pub errors: Mutex<Vec<AudioError>>,
}

impl EventSink for Events {
    fn tick(&self, t: &AudioTick) {
        self.ticks.lock().unwrap().push(t.clone());
    }
    fn state(&self, s: &AudioSnapshot) {
        self.states.lock().unwrap().push(s.clone());
    }
    fn ayah_changed(&self, c: &AyahChange) {
        self.ayahs.lock().unwrap().push(*c);
    }
    fn error(&self, e: &AudioError) {
        self.errors.lock().unwrap().push(e.clone());
    }
}

impl Events {
    /// `(surah, ayah)` of every ayah change so far.
    pub fn ayah_refs(&self) -> Vec<(u32, u32)> {
        self.ayahs
            .lock()
            .unwrap()
            .iter()
            .map(|c| (c.surah, c.ayah))
            .collect()
    }

    /// Every status reported by a state event, consecutive duplicates removed.
    pub fn statuses(&self) -> Vec<PlaybackStatus> {
        let mut out: Vec<PlaybackStatus> = Vec::new();
        for s in self.states.lock().unwrap().iter() {
            if out.last() != Some(&s.status) {
                out.push(s.status);
            }
        }
        out
    }
}

/// An engine on `output` over the fixture timings and ramp-WAV sources (48 kHz stereo, default layout).
pub struct Rig {
    pub engine: AudioEngine,
    pub events: Arc<Events>,
    pub sources: Arc<FixtureSources>,
    pub timings: Arc<FixtureTimings>,
}

impl Rig {
    pub fn new(output: OutputKind) -> Self {
        Self::with(output, FixtureTimings::new(RECITER))
    }

    pub fn with(output: OutputKind, timings: FixtureTimings) -> Self {
        let _ = log_init();
        let timings = Arc::new(timings);
        let sources = Arc::new(FixtureSources::new(timings.layout(), RATE, 2));
        let events = Arc::new(Events::default());
        let engine = AudioEngine::start_with_output(
            EngineConfig::default(),
            Arc::clone(&timings) as Arc<dyn quran_audio::TimingsSource>,
            Arc::clone(&sources) as Arc<dyn quran_audio::SourceProvider>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            output,
        )
        .expect("engine starts");
        Self {
            engine,
            events,
            sources,
            timings,
        }
    }

    /// Waits until `pred(snapshot)` holds; panics with the last snapshot after `timeout`.
    pub fn wait(
        &self,
        timeout: Duration,
        what: &str,
        pred: impl Fn(&AudioSnapshot) -> bool,
    ) -> AudioSnapshot {
        let deadline = Instant::now() + timeout;
        loop {
            let s = self.engine.snapshot();
            if pred(&s) {
                return s;
            }
            assert!(
                Instant::now() < deadline,
                "timed out after {timeout:?} waiting for {what}; last snapshot: {s:#?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Waits until the reported events satisfy `pred` (the ticker reports edges at up to 30 Hz, after the snapshot).
    pub fn wait_events(&self, timeout: Duration, what: &str, pred: impl Fn(&Events) -> bool) {
        let deadline = Instant::now() + timeout;
        while !pred(&self.events) {
            assert!(
                Instant::now() < deadline,
                "timed out after {timeout:?} waiting for {what}; ayahs {:?}, statuses {:?}",
                self.events.ayah_refs(),
                self.events.statuses()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Waits until the snapshot reports `status`.
    pub fn wait_status(&self, status: PlaybackStatus, timeout: Duration) -> AudioSnapshot {
        self.wait(timeout, &format!("{status:?}"), |s| s.status == status)
    }

    /// Waits until `surah:ayah` is heard.
    pub fn wait_ayah(&self, surah: u32, ayah: u32, timeout: Duration) -> AudioSnapshot {
        self.wait(timeout, &format!("{surah}:{ayah}"), |s| {
            s.current == Some(AyahRef { surah, ayah })
        })
    }
}

/// A plain play request of `from ..= to` for the fixture reciter.
pub fn request(from: (u32, u32), to: (u32, u32)) -> PlayRequest {
    PlayRequest {
        reciter_id: RECITER,
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

/// The fixture layout.
pub fn layout() -> Layout {
    Layout::default()
}

/// The JSON lines of a WAV sink's log.
pub fn read_log(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The interleaved f32 samples of a WAV sink's file (58-byte header, 32-bit float).
pub fn read_wav(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    bytes[58..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

/// The applied markers in a log, Sync markers excluded.
pub fn markers(log: &[serde_json::Value]) -> Vec<&serde_json::Value> {
    log.iter()
        .filter(|l| l["event"] == "marker" && l["kind"] != "sync")
        .collect()
}

pub fn u(v: &serde_json::Value) -> u64 {
    v.as_u64().unwrap()
}

/// Test logs go to stderr when `RUST_LOG` is set (no logger crate: a minimal one).
fn log_init() -> Result<(), log::SetLoggerError> {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata<'_>) -> bool {
            m.level() <= log::Level::Debug
        }
        fn log(&self, r: &log::Record<'_>) {
            if std::env::var_os("RUST_LOG").is_some() {
                eprintln!("[{} {}] {}", r.level(), r.target(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Debug))
}
