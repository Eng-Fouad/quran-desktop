//! The engine's status machine and commands end to end (§2.3.2, §2.3.6), in real time on the null sink: play, pause,
//! resume, stop, seeks, skips, speed, volume, repeats, superseding plays, the offline basmala, failures, shutdown.
#![cfg(debug_assertions)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

#[path = "engine_common.rs"]
mod common;

use std::time::{Duration, Instant};

use std::sync::Arc;

use common::{Rig, request};
use quran_audio::fake_out::fixtures::{FixtureSources, FixtureTimings, file_key};
use quran_audio::sink::SinkKind;
use quran_audio::{
    AudioEngine, AudioError, CancelToken, EngineConfig, EventSink, FileKey, OpenedSource,
    OutputKind, ReciterFlags, SourceProvider, SurahTimingSet, TimingsSource,
};
use quran_types::{AbLoop, AyahRef, GapSetting, PlaybackStatus, SeekTarget, SkipDirection};

const SEC: Duration = Duration::from_secs(1);

fn null_rig() -> Rig {
    Rig::new(OutputKind::Sink(SinkKind::Null))
}

#[test]
fn play_pause_resume_stop() {
    let rig = null_rig();
    rig.engine.play(request((113, 1), (113, 5)));
    // 113:1 is preceded by the basmala (the surah-1 file's 1:1 range), reported as ayah 0.
    let s = rig.wait_ayah(113, 0, 5 * SEC);
    assert_eq!(s.current_ayah_id, Some(0));
    let s = rig.wait_ayah(113, 1, 5 * SEC);
    assert_eq!(s.status, PlaybackStatus::Playing);
    assert_eq!(
        s.current_ayah_id,
        Some(quran_audio::fake_out::fixtures::ayah_id(113, 1))
    );
    let t = FixtureTimings::new(7).timings(113);
    assert_eq!(s.file_duration_ms, t.duration_ms);
    assert_eq!(
        (s.ayah_from_ms, s.ayah_to_ms),
        (t.ayahs[0].from_ms, t.ayahs[0].to_ms)
    );
    assert_eq!(s.buffered_pct, 100);

    rig.engine.pause();
    let paused = rig.wait_status(PlaybackStatus::Paused, SEC);
    std::thread::sleep(Duration::from_millis(400));
    let still = rig.engine.snapshot();
    assert_eq!(still.status, PlaybackStatus::Paused);
    // The 8 ms pause ramp, plus one late sink tick (Windows timers run at ~15.6 ms).
    assert!(
        still.file_ms.abs_diff(paused.file_ms) <= 50,
        "the position holds: {} then {}",
        paused.file_ms,
        still.file_ms
    );
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        rig.engine.snapshot().file_ms,
        still.file_ms,
        "nothing is consumed while paused"
    );

    rig.engine.resume();
    let resumed = rig.wait(2 * SEC, "playing on", |s| {
        s.status == PlaybackStatus::Playing && s.file_ms >= still.file_ms + 200
    });
    assert!(resumed.file_ms < still.file_ms + 1_000, "no jump on resume");

    rig.engine.toggle();
    rig.wait_status(PlaybackStatus::Paused, SEC);
    rig.engine.toggle();
    rig.wait_status(PlaybackStatus::Playing, SEC);

    rig.engine.stop();
    let stopped = rig.wait_status(PlaybackStatus::Idle, SEC);
    assert!(stopped.current.is_none() && stopped.range.is_none());
    assert!(rig.events.errors.lock().unwrap().is_empty());
    // Ayah changes: the basmala, then 113:1 (pause/resume/toggle are not changes).
    let ayahs = rig.events.ayah_refs();
    assert_eq!(ayahs, [(113, 0), (113, 1)]);
}

#[test]
fn start_paused_then_seek_while_paused() {
    let rig = null_rig();
    let mut req = request((1, 2), (1, 5));
    req.start_paused = true;
    rig.engine.play(req);
    let s = rig.wait(3 * SEC, "paused on 1:2", |s| {
        s.status == PlaybackStatus::Paused && s.current == Some(AyahRef { surah: 1, ayah: 2 })
    });
    let t = FixtureTimings::new(7).timings(1);
    assert_eq!(s.file_ms, t.ayahs[1].from_ms, "paused at the start of 1:2");

    // A seek while paused is heard (and published) without playing.
    let target = t.ayahs[2].from_ms + 300;
    rig.engine.seek(SeekTarget::FileMs { ms: target });
    let s = rig.wait(2 * SEC, "the seek position", |s| s.file_ms == target);
    assert_eq!(s.status, PlaybackStatus::Paused);
    assert_eq!(s.current, Some(AyahRef { surah: 1, ayah: 3 }));
    // The ticker reports it once (paused: one tick per change), with the word there.
    rig.wait(2 * SEC, "the tick at the seek position", |_| {
        rig.events
            .ticks
            .lock()
            .unwrap()
            .last()
            .is_some_and(|t| t.file_ms == target && t.ayah == 3)
    });
    let tick = rig.events.ticks.lock().unwrap().last().cloned().unwrap();
    assert_eq!(tick.status, PlaybackStatus::Paused);
    let seg_words = &t.ayahs[2].words;
    let expected = seg_words
        .iter()
        .rev()
        .find(|w| w.1 <= target)
        .map(|w| u32::from(w.0));
    assert_eq!(Some(tick.word_pos), expected);

    // Relative seeks move from the heard position.
    rig.engine.seek(SeekTarget::RelativeMs { delta_ms: -200 });
    rig.wait(2 * SEC, "the relative seek", |s| s.file_ms == target - 200);
    // An ayah of the range.
    rig.engine.seek(SeekTarget::Ayah {
        ayah_id: quran_audio::fake_out::fixtures::ayah_id(1, 5),
    });
    let s = rig.wait_ayah(1, 5, 2 * SEC);
    assert_eq!(s.file_ms, t.ayahs[4].from_ms);
    // An ayah outside it is ignored.
    rig.engine.seek(SeekTarget::Ayah { ayah_id: 1_000 });
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        rig.engine.snapshot().current,
        Some(AyahRef { surah: 1, ayah: 5 })
    );
    rig.engine.resume();
    rig.wait_status(PlaybackStatus::Idle, 5 * SEC);
}

#[test]
fn a_seek_right_after_play_applies_to_that_play() {
    let rig = null_rig();
    let t = FixtureTimings::new(7).timings(1);
    for round in 0..5 {
        let mut req = request((1, 1), (1, 7));
        req.start_paused = true;
        let target = t.ayahs[2].from_ms + 100 * (round + 1);
        // No wait in between: the seek may arrive while the play is still loading.
        rig.engine.play(req);
        rig.engine.seek(SeekTarget::FileMs { ms: target });
        let s = rig.wait(3 * SEC, "the seek on the new play", |s| {
            s.status == PlaybackStatus::Paused && s.file_ms == target
        });
        assert_eq!(s.current, Some(AyahRef { surah: 1, ayah: 3 }));
    }
}

#[test]
fn skips_follow_the_heard_segment() {
    let rig = null_rig();
    rig.engine.play(request((1, 1), (1, 7)));
    rig.wait_ayah(1, 1, 3 * SEC);
    rig.engine.skip(SkipDirection::Next);
    rig.wait_ayah(1, 2, 2 * SEC);
    // Previous within 1.5 s of the start: the previous ayah.
    rig.engine.skip(SkipDirection::Previous);
    rig.wait_ayah(1, 1, 2 * SEC);
    // Previous 1.5 s (wall time) or more into the ayah: restart it. 1:4 is 0.86 s of file time, so at 50 % its last
    // 0.1 s is more than 1.5 s in.
    rig.engine.set_speed(50);
    rig.wait(SEC, "speed 50", |s| s.speed_pct == 50);
    let t = FixtureTimings::new(7).timings(1);
    let from = t.ayahs[3].from_ms;
    rig.engine.seek(SeekTarget::FileMs {
        ms: t.ayahs[3].to_ms - 100,
    });
    rig.wait(2 * SEC, "late in 1:4", |s| {
        s.current == Some(AyahRef { surah: 1, ayah: 4 }) && s.file_ms + 150 >= t.ayahs[3].to_ms
    });
    rig.engine.skip(SkipDirection::Previous);
    let s = rig.wait(2 * SEC, "1:4 restarted", |s| s.file_ms < from + 150);
    assert_eq!(s.current, Some(AyahRef { surah: 1, ayah: 4 }));
    rig.engine.set_speed(100);
    // Next at the last ayah ends the play.
    rig.engine.seek(SeekTarget::Ayah { ayah_id: 7 });
    rig.wait_ayah(1, 7, 2 * SEC);
    rig.engine.skip(SkipDirection::Next);
    rig.wait_status(PlaybackStatus::Idle, 2 * SEC);
}

#[test]
fn speed_volume_repeat_gap_and_ab_loop_reach_the_snapshot_and_the_audio() {
    let rig = null_rig();
    let mut req = request((114, 1), (114, 6));
    req.ayah_repeat = 2;
    req.gap = GapSetting::Fixed { ms: 300 };
    rig.engine.play(req);
    // 114 starts with the basmala; then 114:1 plays twice, with gaps.
    rig.wait_ayah(114, 1, 5 * SEC);
    let s = rig.engine.snapshot();
    assert_eq!((s.ayah_repeat, s.gap), (2, GapSetting::Fixed { ms: 300 }));
    rig.wait(3 * SEC, "the repeat counter", |s| {
        s.current
            == Some(AyahRef {
                surah: 114,
                ayah: 1,
            })
            && s.ayah_repeat_left == 1
    });
    rig.wait(4 * SEC, "the second play of 114:1", |s| {
        s.current
            == Some(AyahRef {
                surah: 114,
                ayah: 1,
            })
            && s.ayah_repeat_left == 0
    });
    let gap_ticks = rig
        .events
        .ticks
        .lock()
        .unwrap()
        .iter()
        .filter(|t| t.in_gap)
        .count();
    assert!(gap_ticks > 0, "the gap is reported");

    // Speed: 150 % advances the file 1.5× faster than the clock.
    rig.engine.set_speed(150);
    let s = rig.wait(SEC, "speed 150", |s| s.speed_pct == 150);
    let (t0, ms0) = (Instant::now(), s.file_ms);
    std::thread::sleep(Duration::from_millis(600));
    let s = rig.engine.snapshot();
    let advanced = f64::from(s.file_ms.saturating_sub(ms0));
    let elapsed = t0.elapsed().as_secs_f64() * 1_000.0;
    // Gaps freeze the position, so the ratio is at most 1.5 (plus tick jitter).
    assert!(
        advanced <= elapsed * 1.5 + 80.0,
        "{advanced} ms in {elapsed} ms"
    );
    rig.engine.set_speed(137); // rounded to the 5 % grid
    rig.wait(SEC, "speed 135", |s| s.speed_pct == 135);

    rig.engine.set_volume(40);
    rig.wait(SEC, "volume 40", |s| s.volume_pct == 40);
    rig.engine.set_repeat(1, 3);
    rig.wait(SEC, "repeats", |s| {
        s.ayah_repeat == 1 && s.range_repeat == 3
    });
    rig.engine.set_gap(GapSetting::None);
    rig.wait(SEC, "no gap", |s| s.gap == GapSetting::None);

    // A-B loop on the heard file: held while playing, cleared by None.
    let s = rig.engine.snapshot();
    let ab = AbLoop {
        a_ms: s.ayah_from_ms,
        b_ms: s.ayah_from_ms + 500,
    };
    rig.engine.set_ab_loop(Some(ab));
    rig.wait(SEC, "the A-B loop", |s| s.ab_loop == Some(ab));
    std::thread::sleep(Duration::from_millis(1_200));
    let s = rig.engine.snapshot();
    assert!(
        s.file_ms >= ab.a_ms && s.file_ms <= ab.b_ms + 50,
        "looping inside A-B: {} not in {ab:?}",
        s.file_ms
    );
    rig.engine.set_ab_loop(None);
    rig.wait(SEC, "the loop cleared", |s| s.ab_loop.is_none());
    // An inverted loop is ignored.
    rig.engine.set_ab_loop(Some(AbLoop {
        a_ms: 900,
        b_ms: 100,
    }));
    std::thread::sleep(Duration::from_millis(100));
    assert!(rig.engine.snapshot().ab_loop.is_none());
    rig.engine.stop();
    rig.wait_status(PlaybackStatus::Idle, SEC);
}

/// Consecutive duplicates removed.
fn runs(values: impl IntoIterator<Item = u32>) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    for v in values {
        if out.last() != Some(&v) {
            out.push(v);
        }
    }
    out
}

/// The player's repeat badge ("2/3") follows the engine live: every play of a repeated ayah is a state edge carrying
/// its counter (it used to show the first play's counter for all three), and a `set_repeat` is published with the
/// counters of the segment being heard (it used to read "left 0", shown as 3/3).
#[test]
fn repeat_iterations_are_state_edges_with_live_counters() {
    let rig = null_rig();
    let mut req = request((1, 2), (1, 3));
    req.ayah_repeat = 3;
    rig.engine.play(req);
    rig.wait_ayah(1, 3, 10 * SEC);
    let on_1_2 = |states: &[quran_types::AudioSnapshot]| {
        runs(
            states
                .iter()
                .filter(|s| s.current == Some(AyahRef { surah: 1, ayah: 2 }))
                .map(|s| s.ayah_repeat_left),
        )
    };
    assert_eq!(
        on_1_2(&rig.events.states.lock().unwrap()),
        [2, 1, 0],
        "one state event per play of 1:2, counting down"
    );
    rig.engine.stop();
    rig.wait_status(PlaybackStatus::Idle, SEC);

    // Paused on the first play of 1:2 with no repeat: setting ayah ×3 is published as "2 more after this one".
    rig.events.states.lock().unwrap().clear();
    let mut req = request((1, 2), (1, 3));
    req.start_paused = true;
    rig.engine.play(req);
    rig.wait(3 * SEC, "paused on 1:2", |s| {
        s.status == PlaybackStatus::Paused && s.current == Some(AyahRef { surah: 1, ayah: 2 })
    });
    assert_eq!(rig.engine.snapshot().ayah_repeat_left, 0);
    rig.engine.set_repeat(3, 1);
    rig.wait_events(SEC, "the set_repeat state", |e| {
        e.states.lock().unwrap().iter().any(|s| s.ayah_repeat == 3)
    });
    let first = rig
        .events
        .states
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.ayah_repeat == 3)
        .cloned()
        .unwrap();
    assert_eq!(
        (first.ayah_repeat_left, first.current),
        (2, Some(AyahRef { surah: 1, ayah: 2 }))
    );
    rig.events.states.lock().unwrap().clear();
    rig.engine.resume();
    rig.wait_ayah(1, 3, 10 * SEC);
    assert_eq!(on_1_2(&rig.events.states.lock().unwrap()), [2, 1, 0]);
    rig.engine.stop();
}

#[test]
fn a_newer_play_supersedes_the_current_one() {
    let rig = null_rig();
    rig.engine.play(request((1, 1), (1, 7)));
    rig.engine.play(request((112, 2), (112, 4)));
    rig.wait_ayah(112, 2, 5 * SEC);
    rig.wait_events(SEC, "112:2 reported", |e| e.ayah_refs().contains(&(112, 2)));
    // Nothing of the first play was ever heard or reported.
    let ayahs = rig.events.ayah_refs();
    assert!(ayahs.iter().all(|&(s, _)| s == 112), "{ayahs:?}");
    let s = rig.engine.snapshot();
    assert_eq!(
        s.range.map(|r| (r.from, r.to)),
        Some((
            AyahRef {
                surah: 112,
                ayah: 2
            },
            AyahRef {
                surah: 112,
                ayah: 4
            }
        ))
    );
    // While a play runs, another replaces it at once.
    rig.engine.play(request((114, 3), (114, 4)));
    rig.wait_ayah(114, 3, 3 * SEC);
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !rig.engine
            .snapshot()
            .current
            .is_some_and(|c| c.surah == 112),
        "the old play is gone"
    );
    assert!(rig.events.errors.lock().unwrap().is_empty());
}

/// Timings whose surah 112 takes a while to load (a fetch), else the fixtures.
struct SlowTimings(FixtureTimings);

impl TimingsSource for SlowTimings {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        if surah == 112 {
            std::thread::sleep(Duration::from_millis(60));
        }
        self.0.surah_timings(reciter_id, surah)
    }
    fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags {
        self.0.reciter_flags(reciter_id)
    }
    fn surah_ayah_count(&self, surah: u16) -> u16 {
        self.0.surah_ayah_count(surah)
    }
    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        self.0.ayah_id(surah, ayah)
    }
}

/// Fixture files, except surah 113: a stream that stalls for 25 ms and then delivers garbage (decode fails on it).
struct StallingSources(FixtureSources);

struct Stalling {
    stalled: bool,
    bytes: std::io::Cursor<Vec<u8>>,
}

impl std::io::Read for Stalling {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if !self.stalled {
            self.stalled = true;
            std::thread::sleep(Duration::from_millis(25));
        }
        self.bytes.read(buf)
    }
}

impl std::io::Seek for Stalling {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.bytes.seek(pos)
    }
}

impl symphonia::core::io::MediaSource for Stalling {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(4_096)
    }
}

impl SourceProvider for StallingSources {
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError> {
        if key.surah == 113 {
            return Ok(OpenedSource::complete(Box::new(Stalling {
                stalled: false,
                bytes: std::io::Cursor::new(vec![0x5A; 4_096]),
            })));
        }
        self.0.open(key)
    }
}

#[test]
fn a_failure_of_a_replaced_play_never_fails_its_successor() {
    let events = Arc::new(common::Events::default());
    let engine = AudioEngine::start_with_output(
        EngineConfig::default(),
        Arc::new(SlowTimings(FixtureTimings::new(7))),
        Arc::new(StallingSources(FixtureSources::new(
            common::layout(),
            common::RATE,
            2,
        ))),
        Arc::clone(&events) as Arc<dyn EventSink>,
        OutputKind::Sink(SinkKind::Null),
    )
    .unwrap();
    for round in 0..6 {
        // A's Load is sent, then decode stalls on A's file and fails it while control is still planning B (slow
        // timings): A's failure reaches control only after B's play began.
        engine.play(request((113, 2), (113, 3)));
        std::thread::sleep(Duration::from_millis(8));
        engine.play(request((112, 2), (112, 3)));
        let deadline = Instant::now() + 3 * SEC;
        loop {
            let s = engine.snapshot();
            assert!(
                s.error.is_none() || s.range.is_some_and(|r| r.from.surah == 113),
                "round {round}: the replaced play's failure was pinned on its successor: {s:#?}"
            );
            if s.current
                == Some(AyahRef {
                    surah: 112,
                    ayah: 2,
                })
            {
                break;
            }
            assert!(Instant::now() < deadline, "round {round}: {s:#?}");
            std::thread::sleep(Duration::from_millis(2));
        }
        std::thread::sleep(Duration::from_millis(150));
        let s = engine.snapshot();
        assert!(
            s.error.is_none() && s.status == PlaybackStatus::Playing,
            "round {round}: {s:#?}"
        );
    }
    engine.stop();
}

/// Fixture timings, except surah 112's, which hang like a fetch on a link that never answers (15 s), unless the play
/// they are loaded for is cancelled.
struct HangingTimings {
    inner: FixtureTimings,
    gave_up: std::sync::atomic::AtomicBool,
}

impl TimingsSource for HangingTimings {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        self.surah_timings_for(reciter_id, surah, &CancelToken::new())
    }
    fn surah_timings_for(
        &self,
        reciter_id: u32,
        surah: u16,
        cancel: &CancelToken,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        if surah == 112 {
            let deadline = Instant::now() + 15 * SEC;
            while Instant::now() < deadline {
                if cancel.is_cancelled() {
                    self.gave_up
                        .store(true, std::sync::atomic::Ordering::Release);
                    return Err(AudioError::Cancelled);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        self.inner.surah_timings(reciter_id, surah)
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

/// A play whose timings hang on the network never holds up the next play (or a stop): the newer command cancels it,
/// control gives up at once, and the newer play starts without an error.
#[test]
fn a_play_blocked_on_its_timings_is_superseded_at_once() {
    let events = Arc::new(common::Events::default());
    let timings = Arc::new(HangingTimings {
        inner: FixtureTimings::new(7),
        gave_up: std::sync::atomic::AtomicBool::new(false),
    });
    let engine = AudioEngine::start_with_output(
        EngineConfig::default(),
        Arc::clone(&timings) as Arc<dyn TimingsSource>,
        Arc::new(FixtureSources::new(common::layout(), common::RATE, 2)),
        Arc::clone(&events) as Arc<dyn EventSink>,
        OutputKind::Sink(SinkKind::Null),
    )
    .unwrap();
    engine.play(request((112, 2), (112, 3)));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(engine.snapshot().status, PlaybackStatus::Loading);
    let t = Instant::now();
    engine.play(request((113, 2), (113, 3)));
    let deadline = t + 3 * SEC;
    while engine.snapshot().current
        != Some(AyahRef {
            surah: 113,
            ayah: 2,
        })
    {
        assert!(Instant::now() < deadline, "{:#?}", engine.snapshot());
        std::thread::sleep(Duration::from_millis(2));
    }
    let waited = t.elapsed();
    assert!(waited < Duration::from_millis(1500), "{waited:?}");
    assert!(timings.gave_up.load(std::sync::atomic::Ordering::Acquire));
    assert!(events.errors.lock().unwrap().is_empty());
    assert!(engine.snapshot().error.is_none());

    // A stop does the same for a play still loading.
    engine.play(request((112, 2), (112, 3)));
    std::thread::sleep(Duration::from_millis(200));
    let t = Instant::now();
    engine.stop();
    while engine.snapshot().status != PlaybackStatus::Idle {
        assert!(t.elapsed() < 3 * SEC, "{:#?}", engine.snapshot());
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(t.elapsed() < Duration::from_millis(1500));
    // Control is free again: a play starts promptly.
    engine.play(request((114, 2), (114, 3)));
    let t = Instant::now();
    while engine.snapshot().current
        != Some(AyahRef {
            surah: 114,
            ayah: 2,
        })
    {
        assert!(t.elapsed() < 3 * SEC, "{:#?}", engine.snapshot());
        std::thread::sleep(Duration::from_millis(2));
    }
    engine.shutdown();
}

/// §2.3.7 rule 7 as the glue does it: a surah's stored timings describe an older file (`expected_len` 1); opening it
/// fails with `FileMismatch` and stores the server's timings (here: the fixture's, with no length), like
/// `TimingsStore::on_file_mismatch`.
struct ChangedUpstream {
    timings: FixtureTimings,
    sources: FixtureSources,
    stale: std::sync::Mutex<Vec<u16>>,
    mismatches: std::sync::Mutex<Vec<u16>>,
}

const OLD_LEN: u64 = 1;

impl ChangedUpstream {
    fn new(stale: &[u16]) -> Arc<Self> {
        Arc::new(Self {
            timings: FixtureTimings::new(7),
            sources: FixtureSources::new(common::layout(), common::RATE, 2),
            stale: std::sync::Mutex::new(stale.to_vec()),
            mismatches: std::sync::Mutex::new(Vec::new()),
        })
    }
}

impl TimingsSource for ChangedUpstream {
    fn surah_timings(
        &self,
        reciter_id: u32,
        surah: u16,
    ) -> Result<Arc<SurahTimingSet>, AudioError> {
        let mut set = (*self.timings.surah_timings(reciter_id, surah)?).clone();
        if self.stale.lock().unwrap().contains(&surah) {
            set.file.expected_len = Some(OLD_LEN);
        }
        Ok(Arc::new(set))
    }
    fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags {
        self.timings.reciter_flags(reciter_id)
    }
    fn surah_ayah_count(&self, surah: u16) -> u16 {
        self.timings.surah_ayah_count(surah)
    }
    fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
        self.timings.ayah_id(surah, ayah)
    }
}

impl SourceProvider for ChangedUpstream {
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError> {
        if key.expected_len == Some(OLD_LEN) {
            self.mismatches.lock().unwrap().push(key.surah);
            self.stale.lock().unwrap().retain(|&s| s != key.surah);
            return Err(AudioError::FileMismatch(format!(
                "surah {} is another file upstream",
                key.surah
            )));
        }
        self.sources.open(key)
    }
}

fn changed_upstream_engine(
    upstream: &Arc<ChangedUpstream>,
    events: &Arc<common::Events>,
) -> AudioEngine {
    AudioEngine::start_with_output(
        EngineConfig::default(),
        Arc::clone(upstream) as Arc<dyn TimingsSource>,
        Arc::clone(upstream) as Arc<dyn SourceProvider>,
        Arc::clone(events) as Arc<dyn EventSink>,
        OutputKind::Sink(SinkKind::Null),
    )
    .unwrap()
}

/// The first file changed upstream: the play is planned again with the refreshed timings and starts, instead of
/// failing with a "network" error until the user pressed play again.
#[test]
fn a_changed_first_file_is_planned_again_and_plays() {
    let upstream = ChangedUpstream::new(&[112]);
    let events = Arc::new(common::Events::default());
    let engine = changed_upstream_engine(&upstream, &events);
    engine.play(request((112, 2), (112, 3)));
    let t = Instant::now();
    while engine.snapshot().current
        != Some(AyahRef {
            surah: 112,
            ayah: 2,
        })
    {
        assert!(t.elapsed() < 3 * SEC, "{:#?}", engine.snapshot());
        std::thread::sleep(Duration::from_millis(2));
    }
    let s = engine.snapshot();
    assert_eq!((s.status, s.error), (PlaybackStatus::Playing, None));
    assert_eq!(*upstream.mismatches.lock().unwrap(), [112]);
    assert!(events.errors.lock().unwrap().is_empty());
    engine.shutdown();
}

/// A later file changed upstream: decode stops at it and the play goes on from its first ayah with the refreshed
/// timings, instead of failing the whole queue there. The range shown stays the one asked for.
#[test]
fn a_changed_later_file_continues_the_play_from_it() {
    let upstream = ChangedUpstream::new(&[113]);
    let events = Arc::new(common::Events::default());
    let engine = changed_upstream_engine(&upstream, &events);
    engine.play(request((112, 4), (113, 2)));
    let t = Instant::now();
    while engine.snapshot().current
        != Some(AyahRef {
            surah: 113,
            ayah: 2,
        })
    {
        let s = engine.snapshot();
        assert!(s.error.is_none(), "{s:#?}");
        assert!(t.elapsed() < 8 * SEC, "{s:#?}");
        std::thread::sleep(Duration::from_millis(2));
    }
    let s = engine.snapshot();
    assert_eq!((s.status, s.error), (PlaybackStatus::Playing, None));
    assert_eq!(
        s.range.map(|r| r.from),
        Some(AyahRef {
            surah: 112,
            ayah: 4
        })
    );
    assert_eq!(*upstream.mismatches.lock().unwrap(), [113]);
    // The ticker reports the edge just after the snapshot shows it.
    let t = Instant::now();
    while !events.ayah_refs().contains(&(113, 2)) {
        assert!(t.elapsed() < SEC, "{:?}", events.ayah_refs());
        std::thread::sleep(Duration::from_millis(2));
    }
    let ayahs = events.ayah_refs();
    let heard: Vec<(u32, u32)> = ayahs.iter().copied().filter(|&(s, _)| s == 113).collect();
    assert_eq!(
        heard,
        [(113, 0), (113, 1), (113, 2)],
        "the basmala once (written before decode stopped, heard while the rest was planned), then 113:1: {ayahs:?}"
    );
    assert!(ayahs.contains(&(112, 4)), "{ayahs:?}");
    assert!(events.errors.lock().unwrap().is_empty());
    engine.shutdown();
}

#[test]
fn a_play_stopped_before_it_starts_leaves_the_engine_idle() {
    let rig = null_rig();
    rig.wait(SEC, "the device probe", |s| s.device.is_some());
    for _ in 0..5 {
        rig.engine.play(request((1, 1), (1, 7)));
        assert_eq!(rig.engine.snapshot().status, PlaybackStatus::Loading);
        rig.engine.stop();
        let s = rig.wait_status(PlaybackStatus::Idle, SEC);
        assert!(s.range.is_none() && s.reciter_id.is_none(), "{s:#?}");
    }
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(rig.engine.snapshot().status, PlaybackStatus::Idle);
}

#[test]
fn an_offline_basmala_is_skipped_with_the_flag() {
    let rig = null_rig();
    rig.sources.set_offline(1, true);
    rig.engine.play(request((112, 1), (112, 2)));
    let s = rig.wait_ayah(112, 1, 3 * SEC);
    assert!(s.basmala_skipped);
    assert_eq!(s.status, PlaybackStatus::Playing);
    rig.wait_events(SEC, "112:1 reported", |e| !e.ayah_refs().is_empty());
    assert_eq!(rig.events.ayah_refs().first(), Some(&(112, 1)));
    rig.wait_status(PlaybackStatus::Idle, 5 * SEC);

    // Mid-queue: the surah-1 file is needed again for 113's basmala, and is still offline.
    rig.engine.play(request((112, 4), (113, 1)));
    rig.wait_ayah(113, 1, 6 * SEC);
    assert!(rig.engine.snapshot().basmala_skipped);
    rig.wait_events(SEC, "113:1 reported", |e| e.ayah_refs().contains(&(113, 1)));
    assert!(!rig.events.ayah_refs().contains(&(113, 0)));
}

#[test]
fn failures_reach_the_status_and_the_sink() {
    // Timings that cannot be loaded fail the play.
    let rig = Rig::with(
        OutputKind::Sink(SinkKind::Null),
        FixtureTimings::new(7).with_failing(112, AudioError::Timings("corrupt".to_owned())),
    );
    rig.engine.play(request((112, 2), (112, 3)));
    let s = rig.wait_status(PlaybackStatus::Error, 3 * SEC);
    assert_eq!(s.error.as_ref().map(|e| e.kind()), Some("audio"));
    assert!(matches!(
        rig.events.errors.lock().unwrap().first(),
        Some(AudioError::Timings(_))
    ));
    // An undecodable file fails during playback.
    rig.sources.insert(file_key(7, 113), vec![0x5A; 4_096]);
    rig.engine.play(request((113, 2), (113, 3)));
    let s = rig.wait(3 * SEC, "a decode error", |s| {
        s.status == PlaybackStatus::Error
            && s.reciter_id == Some(7)
            && s.range.is_some_and(|r| r.from.surah == 113)
    });
    assert!(s.error.is_some());
    // An offline ayah fails the play (only basmalas are skipped).
    rig.sources.set_offline(114, true);
    rig.engine.play(request((114, 2), (114, 3)));
    let s = rig.wait(3 * SEC, "offline", |s| {
        s.error.as_ref().is_some_and(|e| e.kind() == "offline")
    });
    assert_eq!(s.status, PlaybackStatus::Error);
    // A good play afterwards clears the error.
    rig.engine.play(request((1, 1), (1, 1)));
    let s = rig.wait_ayah(1, 1, 3 * SEC);
    assert!(s.error.is_none());
    // Commands without a play are harmless.
    rig.engine.stop();
    rig.engine.stop();
    rig.engine.resume();
    rig.engine.skip(SkipDirection::Next);
    rig.engine.seek(SeekTarget::FileMs { ms: 5 });
    rig.wait_status(PlaybackStatus::Idle, SEC);
}

/// A play that fails before it starts keeps what failed in the snapshot with its error, whoever started it: the dock
/// names the surah and the reciter (and offers to download it) for a media key's or the tray's replay too, not only for
/// the window's own plays. The next play or a stop forgets it.
#[test]
fn a_play_that_fails_before_it_starts_keeps_its_range_with_the_error() {
    let rig = null_rig();
    rig.sources.set_offline(37, true);
    rig.engine.play(request((37, 2), (37, 5)));
    let s = rig.wait(3 * SEC, "the offline error", |s| {
        s.status == PlaybackStatus::Error && s.error.is_some()
    });
    assert_eq!(s.error.as_ref().map(|e| e.kind()), Some("offline"));
    assert_eq!(
        (s.reciter_id, s.range.map(|r| (r.from, r.to)), s.current),
        (
            Some(7),
            Some((
                AyahRef { surah: 37, ayah: 2 },
                AyahRef { surah: 37, ayah: 5 }
            )),
            None
        )
    );
    // The state event carries it too (what the UI hears).
    rig.wait_events(SEC, "the error state", |e| {
        e.states.lock().unwrap().iter().any(|s| {
            s.status == PlaybackStatus::Error && s.range.is_some_and(|r| r.from.surah == 37)
        })
    });
    rig.engine.stop();
    let s = rig.wait_status(PlaybackStatus::Idle, SEC);
    assert!(
        s.range.is_none() && s.reciter_id.is_none() && s.error.is_none(),
        "{s:#?}"
    );

    rig.engine.play(request((37, 2), (37, 5)));
    rig.wait_status(PlaybackStatus::Error, 3 * SEC);
    rig.engine.play(request((1, 1), (1, 1)));
    let s = rig.wait_ayah(1, 1, 3 * SEC);
    assert_eq!(
        (s.error, s.range.map(|r| r.from.surah)),
        (None, Some(1)),
        "the next play replaces it"
    );
    rig.engine.stop();
}

/// A play that failed mid-way (here: the next surah's file is offline) stays in the snapshot with what was heard, which
/// the OS media session and the tray show paused with Play enabled. Their Play (resume, toggle) starts it again where
/// it stopped: the segment that was heard, in the pass it was heard in, the range shown unchanged. Still offline, it
/// fails again at the same place.
#[test]
fn a_play_that_failed_mid_way_plays_again_from_where_it_stopped() {
    let rig = null_rig();
    rig.sources.set_offline(113, true);
    let mut req = request((112, 3), (113, 2));
    req.range_repeat = 2;
    rig.engine.play(req);
    let failed = rig.wait_status(PlaybackStatus::Error, 10 * SEC);
    let basmala = Some(AyahRef {
        surah: 113,
        ayah: 0,
    });
    assert_eq!(failed.current, basmala, "{failed:#?}");
    assert_eq!(failed.error.as_ref().map(|e| e.kind()), Some("offline"));
    let range = failed.range;

    // Still offline: Play fails again where it stopped, without replaying the start.
    rig.events.ayahs.lock().unwrap().clear();
    rig.engine.resume();
    rig.wait(3 * SEC, "retrying", |s| s.status != PlaybackStatus::Error);
    let again = rig.wait_status(PlaybackStatus::Error, 5 * SEC);
    assert_eq!((again.current, again.range), (basmala, range));
    assert!(
        rig.events.ayah_refs().iter().all(|&(s, _)| s == 113),
        "{:?}",
        rig.events.ayah_refs()
    );
    // Failing again before it starts (the basmala's file offline too, so the retry opens 113 at once): the failed
    // play stays as it was, and the next Play still tries from the same place.
    rig.sources.set_offline(1, true);
    let errors = rig.events.errors.lock().unwrap().len();
    rig.engine.resume();
    rig.wait_events(3 * SEC, "the retry's error", |e| {
        e.errors.lock().unwrap().len() > errors
    });
    std::thread::sleep(Duration::from_millis(200));
    let s = rig.engine.snapshot();
    assert_eq!(
        (s.status, s.current, s.range),
        (PlaybackStatus::Error, basmala, range),
        "{s:#?}"
    );
    rig.sources.set_offline(1, false);

    // Online again: Play/Pause continues the first pass at the basmala, then the second pass runs, then the end.
    rig.sources.set_offline(113, false);
    rig.events.ayahs.lock().unwrap().clear();
    rig.engine.toggle();
    let s = rig.wait_ayah(113, 1, 5 * SEC);
    assert_eq!((s.status, s.error.clone()), (PlaybackStatus::Playing, None));
    assert_eq!(s.range, range, "the range shown is the one asked for");
    assert_eq!(s.range_repeat_left, 1, "still the first pass");
    rig.wait(8 * SEC, "the second pass", |s| {
        s.current
            == Some(AyahRef {
                surah: 112,
                ayah: 3,
            })
            && s.range_repeat_left == 0
    });
    rig.wait_status(PlaybackStatus::Idle, 10 * SEC);
    rig.wait_events(SEC, "the last ayah reported", |e| {
        e.ayah_refs().iter().filter(|&&r| r == (113, 2)).count() == 2
    });
    let heard = rig.events.ayah_refs();
    assert!(
        heard.ends_with(&[
            (113, 1),
            (113, 2),
            (112, 3),
            (112, 4),
            (113, 0),
            (113, 1),
            (113, 2)
        ]),
        "{heard:?}"
    );
    assert!(!heard[..heard.len() - 5].contains(&(112, 3)), "{heard:?}");
}

/// A position on the file timeline outside the playing range is bounded to it: the OS scrubber dragged to the start
/// of the surah's file, a nudge back at the first ayah, an A-B loop set before the range. The file's earlier ayahs are
/// never played under the first ayah's label.
#[test]
fn file_positions_are_bounded_to_the_playing_range() {
    let rig = null_rig();
    rig.engine.play(request((2, 5), (2, 6)));
    let s = rig.wait_ayah(2, 5, 5 * SEC);
    let (from, first) = (s.ayah_from_ms, Some(AyahRef { surah: 2, ayah: 5 }));
    let stays_in_range = |what: &str, for_ms: u64| {
        let until = Instant::now() + Duration::from_millis(for_ms);
        while Instant::now() < until {
            let s = rig.engine.snapshot();
            assert!(
                s.file_ms >= from && s.current.is_some_and(|c| c.surah == 2 && c.ayah >= 5),
                "{what}: {s:#?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    };

    // The OS scrubber at 0 (2:1 starts there): the range's start.
    rig.engine.seek(SeekTarget::FileMs { ms: 0 });
    stays_in_range("seek to 0", 700);
    // A 5 s nudge back at the range's start.
    rig.engine.seek(SeekTarget::FileMs { ms: from + 200 });
    rig.wait(SEC, "near the start", |s| s.file_ms < from + 600);
    rig.engine.seek(SeekTarget::RelativeMs { delta_ms: -5_000 });
    stays_in_range("nudge back", 500);
    // An A-B loop from before the range: from its start.
    rig.engine.set_ab_loop(Some(AbLoop {
        a_ms: 0,
        b_ms: from + 600,
    }));
    let bounded = AbLoop {
        a_ms: from,
        b_ms: from + 600,
    };
    rig.wait(SEC, "the bounded loop", |s| s.ab_loop == Some(bounded));
    stays_in_range("the A-B loop", 1_500);
    assert_eq!(rig.engine.snapshot().current, first);
    // A loop entirely before the range is ignored (and clears the one in force).
    rig.engine.set_ab_loop(Some(AbLoop {
        a_ms: 0,
        b_ms: from - 100,
    }));
    rig.wait(SEC, "the loop ignored", |s| s.ab_loop.is_none());
    // Past the range: its last ayah ends at once, so the play ends.
    rig.engine.seek(SeekTarget::FileMs { ms: u32::MAX });
    rig.wait_status(PlaybackStatus::Idle, 2 * SEC);
    let heard = rig.events.ayah_refs();
    assert!(
        heard.iter().all(|&r| r == (2, 5) || r == (2, 6)),
        "{heard:?}"
    );

    // A file that also backs a basmala elsewhere in the queue: from 1:7, the scrubber at 0 goes to 1:6, the start of
    // the range, not to the basmala before surah 2 (the 1:1 audio).
    let mut req = request((1, 6), (2, 2));
    req.start_paused = true;
    rig.engine.play(req);
    rig.wait(3 * SEC, "paused on 1:6", |s| {
        s.status == PlaybackStatus::Paused && s.current == Some(AyahRef { surah: 1, ayah: 6 })
    });
    rig.engine.seek(SeekTarget::Ayah {
        ayah_id: quran_audio::fake_out::fixtures::ayah_id(1, 7),
    });
    rig.wait_ayah(1, 7, 2 * SEC);
    let start = FixtureTimings::new(7).timings(1).ayahs[5].from_ms;
    rig.engine.seek(SeekTarget::FileMs { ms: 0 });
    let s = rig.wait(2 * SEC, "1:6 from its start", |s| s.file_ms == start);
    assert_eq!(s.current, Some(AyahRef { surah: 1, ayah: 6 }));
    rig.engine.stop();
}

/// Next at the last ayah does what its end would do: while range repeats remain (the snapshot's `range_repeat_left`,
/// which the OS media session offers Next by) it starts the next pass; on the last pass it ends the play.
#[test]
fn next_at_the_last_ayah_starts_the_next_pass_while_range_repeats_remain() {
    let rig = null_rig();
    let mut req = request((1, 6), (1, 7));
    req.range_repeat = 2;
    rig.engine.play(req.clone());
    let s = rig.wait_ayah(1, 7, 5 * SEC);
    assert_eq!((s.range_repeat, s.range_repeat_left), (2, 1));
    rig.engine.skip(SkipDirection::Next);
    let s = rig.wait(2 * SEC, "the second pass", |s| {
        s.current == Some(AyahRef { surah: 1, ayah: 6 }) && s.range_repeat_left == 0
    });
    assert_eq!(s.status, PlaybackStatus::Playing);
    rig.engine.skip(SkipDirection::Next);
    rig.wait_ayah(1, 7, 2 * SEC);
    rig.engine.skip(SkipDirection::Next);
    rig.wait_status(PlaybackStatus::Idle, 2 * SEC);

    // Infinite range repeats: always a next pass.
    req.range_repeat = 0;
    rig.engine.play(req);
    rig.wait_ayah(1, 7, 5 * SEC);
    for _ in 0..2 {
        rig.engine.skip(SkipDirection::Next);
        rig.wait_ayah(1, 6, 2 * SEC);
        rig.engine.skip(SkipDirection::Next);
        rig.wait_ayah(1, 7, 2 * SEC);
    }
    assert_eq!(rig.engine.snapshot().status, PlaybackStatus::Playing);
    rig.engine.stop();
}

#[test]
fn shutdown_is_idempotent_and_prompt() {
    let rig = null_rig();
    rig.engine.play(request((2, 1), (2, 5)));
    rig.wait_ayah(2, 1, 5 * SEC);
    let t0 = Instant::now();
    rig.engine.shutdown();
    let first = t0.elapsed();
    rig.engine.shutdown();
    assert!(first < Duration::from_millis(500), "joined in {first:?}");
    // A stopped engine ignores commands.
    rig.engine.play(request((1, 1), (1, 2)));
    rig.engine.pause();
    let _ = rig.engine.snapshot();
}
