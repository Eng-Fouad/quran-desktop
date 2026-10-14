//! The whole engine on a progressive stream (null sink, never the speakers): a play of 1:1–1:7 decodes a silent MP3
//! served by the in-repo HTTP server through `CachingHttpSource`, the file is promoted into the cache, and the next
//! play (even offline) reads the cached file without a request. Debug builds only: the debug sinks do not exist in
//! release builds, and these tests never use the audio device.
#![cfg(debug_assertions)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::missing_panics_doc
)]

#[path = "source_common.rs"]
mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use common::{Behavior, Fixture, RECITER, RegEvent, Server, exists, wait_for};
use quran_audio::fake_out::fixtures::silent_mp3;
use quran_audio::sink::SinkKind;
use quran_audio::{
    AudioEngine, AudioError, AyahSpan, EngineConfig, FileKey, NullEventSink, OutputKind,
    ReciterFlags, SourceProvider, SurahTimingSet, TimingsSource,
};
use quran_types::{AudioSnapshot, AyahRef, GapSetting, MushafLayout, PlayRequest, PlaybackStatus};

/// 115 MP3 frames of 1,152 samples at 44.1 kHz ≈ 3,004 ms.
const MP3_FRAMES: usize = 115;
const AYAH_MS: u32 = 400;

/// Surah 1 of the test reciter on the server's file.
struct ServerTimings {
    file: FileKey,
}

impl TimingsSource for ServerTimings {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        if reciter_id != RECITER || surah != 1 {
            return Err(AudioError::Timings(format!(
                "no timings for {reciter_id}/{surah}"
            )));
        }
        let ayahs = (1..=7_u16)
            .map(|a| {
                let from = u32::from(a - 1) * AYAH_MS;
                AyahSpan {
                    ayah: a,
                    from_ms: from,
                    to_ms: from + AYAH_MS,
                    words: vec![
                        (1, from, from + AYAH_MS / 2),
                        (2, from + AYAH_MS / 2, from + AYAH_MS),
                    ],
                }
            })
            .collect();
        Ok(Arc::new(SurahTimingSet {
            reciter_id,
            surah,
            file: self.file.clone(),
            duration_ms: 3_004,
            ayahs,
            word_level: true,
        }))
    }

    fn reciter_flags(&self, _reciter_id: u32) -> ReciterFlags {
        ReciterFlags::default()
    }

    fn surah_ayah_count(&self, surah: u16) -> u16 {
        if surah == 1 { 7 } else { 0 }
    }

    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        if surah == 1 { u32::from(ayah) } else { 0 }
    }
}

/// Surah 1 streams from the server; surah 2 is a complete file in the cache (both 7 ayahs here).
struct TwoSurahs {
    streamed: FileKey,
    cached: FileKey,
}

impl TimingsSource for TwoSurahs {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        let file = match surah {
            1 => self.streamed.clone(),
            2 => self.cached.clone(),
            _ => return Err(AudioError::Timings(format!("no timings for {surah}"))),
        };
        let mut set = (*ServerTimings { file: file.clone() }.surah_timings(reciter_id, 1)?).clone();
        set.surah = surah;
        set.file = file;
        Ok(Arc::new(set))
    }

    fn reciter_flags(&self, _reciter_id: u32) -> ReciterFlags {
        ReciterFlags::default()
    }

    fn surah_ayah_count(&self, surah: u16) -> u16 {
        if matches!(surah, 1 | 2) { 7 } else { 0 }
    }

    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        match surah {
            1 => u32::from(ayah),
            2 => 7 + u32::from(ayah),
            _ => 0,
        }
    }
}

fn request() -> PlayRequest {
    PlayRequest {
        reciter_id: RECITER,
        from: AyahRef { surah: 1, ayah: 1 },
        to: Some(AyahRef { surah: 1, ayah: 7 }),
        stop_at: None,
        layout: MushafLayout::V2,
        ayah_repeat: 1,
        range_repeat: 1,
        gap: GapSetting::None,
        start_paused: false,
        record: true,
    }
}

fn wait(
    engine: &AudioEngine,
    timeout: Duration,
    what: &str,
    pred: impl Fn(&AudioSnapshot) -> bool,
) -> AudioSnapshot {
    let deadline = Instant::now() + timeout;
    loop {
        let s = engine.snapshot();
        if pred(&s) {
            return s;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {s:#?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_engine_plays_a_progressive_stream_and_replays_it_from_the_cache() {
    let server = Server::start();
    let mp3 = silent_mp3(MP3_FRAMES, true);
    server.put("/7/001.mp3", mp3.clone());
    // Slow enough that playback starts long before the download ends.
    server.set_behavior(Behavior::throttled(4 * 1024, Duration::from_millis(10)));
    let fx = Fixture::new();
    let file = FileKey {
        reciter_id: RECITER,
        surah: 1,
        url: server.url("/7/001.mp3"),
        expected_len: Some(mp3.len() as u64),
    };
    let Fixture {
        rt: _rt,
        dir: _dir,
        registry,
        online,
        source,
    } = fx;
    let root = source.root().to_path_buf();
    let source: Arc<dyn SourceProvider> = Arc::new(source);
    let engine = AudioEngine::start_with_output(
        EngineConfig::default(),
        Arc::new(ServerTimings { file }),
        source,
        Arc::new(NullEventSink),
        OutputKind::Sink(SinkKind::Null),
    )
    .unwrap();

    engine.play(request());
    wait(&engine, Duration::from_secs(10), "playing", |s| {
        s.status == PlaybackStatus::Playing
    });
    let s = wait(&engine, Duration::from_secs(10), "1:7", |s| {
        s.current == Some(AyahRef { surah: 1, ayah: 7 })
    });
    assert_eq!(s.reciter_id, Some(RECITER));
    wait(&engine, Duration::from_secs(10), "the end", |s| {
        s.status == PlaybackStatus::Idle
    });
    assert_eq!(engine.snapshot().error, None);
    let cached = quran_audio::cached_file_path(&root, RECITER, 1);
    wait_for(Duration::from_secs(10), "promotion", || {
        registry.events() == vec![RegEvent::Begin(1), RegEvent::End(1, Some(mp3.len() as u64))]
    });
    assert_eq!(std::fs::read(&cached).unwrap(), mp3);
    assert!(!exists(&quran_audio::stream_part_path(&root, RECITER, 1)));
    let requests = server.requests().len();

    // Offline now: the second play reads the cache.
    online.store(false, Ordering::Release);
    engine.play(request());
    wait(
        &engine,
        Duration::from_secs(10),
        "1:3 from the cache",
        |s| s.current == Some(AyahRef { surah: 1, ayah: 3 }),
    );
    engine.stop();
    wait(&engine, Duration::from_secs(5), "stopped", |s| {
        s.status == PlaybackStatus::Idle
    });
    assert_eq!(
        server.requests().len(),
        requests,
        "no request for a cached file"
    );
    assert_eq!(registry.events().len(), 2, "no second stream");
    engine.shutdown();
}

/// A stream that stalls (the connection stays open, nothing more arrives, Range requests stall too) holds decode in
/// a read. A new play of a cached surah must not wait for the stalled stream's 30 s watchdog: the new play cancels the
/// old one, its waiting read gives up, decode drops the old queue and the cached surah starts at once. (It started
/// 28 s after the play command before.)
#[test]
fn a_new_play_never_waits_for_a_stalled_stream_of_the_old_one() {
    let server = Server::start();
    let mp3 = silent_mp3(MP3_FRAMES, true);
    server.put("/7/001.mp3", mp3.clone());
    server.set_behavior(Behavior {
        stall_after: Some(12 * 1024),
        ..Behavior::default()
    });
    let fx = Fixture::new();
    let Fixture {
        rt: _rt,
        dir: _dir,
        registry,
        online: _online,
        source,
    } = fx;
    let root = source.root().to_path_buf();
    let cached = quran_audio::cached_file_path(&root, RECITER, 2);
    std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
    std::fs::write(&cached, &mp3).unwrap();
    let timings = TwoSurahs {
        streamed: FileKey {
            reciter_id: RECITER,
            surah: 1,
            url: server.url("/7/001.mp3"),
            expected_len: Some(mp3.len() as u64),
        },
        cached: FileKey {
            reciter_id: RECITER,
            surah: 2,
            url: server.url("/7/002.mp3"),
            expected_len: Some(mp3.len() as u64),
        },
    };
    let engine = AudioEngine::start_with_output(
        EngineConfig::default(),
        Arc::new(timings),
        Arc::new(source) as Arc<dyn SourceProvider>,
        Arc::new(NullEventSink),
        OutputKind::Sink(SinkKind::Null),
    )
    .unwrap();

    engine.play(request());
    wait(
        &engine,
        Duration::from_secs(10),
        "buffering on the stall",
        |s| s.status == PlaybackStatus::Buffering,
    );
    // Let decode block in the read for a while (the watchdog would fail it after 30 s).
    std::thread::sleep(Duration::from_millis(500));
    let t = Instant::now();
    engine.play(PlayRequest {
        from: AyahRef { surah: 2, ayah: 2 },
        to: Some(AyahRef { surah: 2, ayah: 4 }),
        ..request()
    });
    let s = wait(
        &engine,
        Duration::from_secs(10),
        "2:2 from the cache",
        |s| s.current == Some(AyahRef { surah: 2, ayah: 2 }),
    );
    let waited = t.elapsed();
    assert!(waited < Duration::from_secs(1), "{waited:?}");
    assert_eq!((s.status, s.error), (PlaybackStatus::Playing, None));
    // The stalled stream was let go: its temp deleted, never promoted.
    wait_for(Duration::from_secs(5), "the stream abandoned", || {
        registry.events().contains(&RegEvent::End(1, None))
    });
    assert!(!exists(&quran_audio::stream_part_path(&root, RECITER, 1)));
    engine.shutdown();
}
