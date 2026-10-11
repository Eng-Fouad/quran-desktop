//! Recitation commands (§5.13). Owner: WP4d.
//!
//! Every command validates its input (`InvalidArgument`, §5.1) and talks to `state.audio`, whose engine commands are
//! non-blocking channel sends. `audio_play` first warms the Quran index on the blocking pool (once per run, normally
//! already done by `app_bootstrap`), so resolving `to` never touches SQLite on an async worker. `audio_get_timings`
//! awaits `state.audio.timings(..)` directly (no `blocking()` wrapper and no `block_on`, §0.2).
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.

use quran_types::limits::VOLUME_PCT;
use quran_types::{
    AYAH_COUNT, AbLoop, AppError, AudioSnapshot, AudioTick, GapSetting, PlayRequest, ReciterInfo,
    SeekTarget, SkipDirection, SurahTimings,
};
use tauri::State;
use tauri::ipc::Channel;

use crate::audio_glue::{check_gap, check_repeat, check_speed};
use crate::state::AppState;

/// The shortest A-B loop (§5.8: `b − a ≥ 300`).
const MIN_AB_LOOP_MS: u32 = 300;

/// Registers the 30 Hz tick channel (replacing any previous one) and returns the current snapshot.
#[tauri::command]
#[specta::specta]
pub async fn audio_subscribe(
    state: State<'_, AppState>,
    on_tick: Channel<AudioTick>,
) -> Result<AudioSnapshot, AppError> {
    state.audio.set_tick_channel(on_tick);
    Ok(state.audio.snapshot())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_play(
    state: State<'_, AppState>,
    request: PlayRequest,
) -> Result<AudioSnapshot, AppError> {
    // `play` resolves page and juz ends from the index: build it off the async workers the first time.
    if !state.audio.index_ready() && state.core.is_available() {
        let core = state.core.clone();
        let warmed =
            crate::util::blocking(move || core.index().map(drop).map_err(AppError::from)).await;
        if let Err(e) = warmed {
            // `play` reports it when the request needs the index; a surah or Quran end does not.
            log::warn!("audio_play: the Quran index is unavailable: {e}");
        }
    }
    state.audio.play(request)
}

#[tauri::command]
#[specta::specta]
pub async fn audio_pause(state: State<'_, AppState>) -> Result<(), AppError> {
    state.audio.engine().pause();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_resume(state: State<'_, AppState>) -> Result<(), AppError> {
    state.audio.engine().resume();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_toggle(state: State<'_, AppState>) -> Result<(), AppError> {
    state.audio.engine().toggle();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_stop(state: State<'_, AppState>) -> Result<(), AppError> {
    state.audio.engine().stop();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_skip(
    state: State<'_, AppState>,
    direction: SkipDirection,
) -> Result<(), AppError> {
    state.audio.engine().skip(direction);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_seek(state: State<'_, AppState>, target: SeekTarget) -> Result<(), AppError> {
    check_seek(target)?;
    state.audio.engine().seek(target);
    Ok(())
}

/// 50..=200, step 5 (`quran_types::limits::SPEED_PCT`).
#[tauri::command]
#[specta::specta]
pub async fn audio_set_speed(state: State<'_, AppState>, speed_pct: u32) -> Result<(), AppError> {
    check_speed(speed_pct)?;
    state.audio.engine().set_speed(speed_pct);
    Ok(())
}

/// 0..=100.
#[tauri::command]
#[specta::specta]
pub async fn audio_set_volume(state: State<'_, AppState>, volume_pct: u32) -> Result<(), AppError> {
    check_volume(volume_pct)?;
    state.audio.engine().set_volume(volume_pct);
    Ok(())
}

/// Each 0..=99, 0 = ∞.
#[tauri::command]
#[specta::specta]
pub async fn audio_set_repeat(
    state: State<'_, AppState>,
    ayah_repeat: u32,
    range_repeat: u32,
) -> Result<(), AppError> {
    check_repeat("ayah repeat", ayah_repeat)?;
    check_repeat("range repeat", range_repeat)?;
    state.audio.engine().set_repeat(ayah_repeat, range_repeat);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_set_gap(state: State<'_, AppState>, gap: GapSetting) -> Result<(), AppError> {
    check_gap(gap)?;
    state.audio.engine().set_gap(gap);
    Ok(())
}

/// `null` clears the loop; `b − a ≥ 300` ms.
#[tauri::command]
#[specta::specta]
pub async fn audio_set_ab_loop(
    state: State<'_, AppState>,
    ab_loop: Option<AbLoop>,
) -> Result<(), AppError> {
    if let Some(ab) = ab_loop {
        check_ab_loop(ab)?;
    }
    state.audio.engine().set_ab_loop(ab_loop);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_get_snapshot(state: State<'_, AppState>) -> Result<AudioSnapshot, AppError> {
    Ok(state.audio.snapshot())
}

#[tauri::command]
#[specta::specta]
pub async fn audio_get_timings(
    state: State<'_, AppState>,
    reciter_id: u32,
    surah: u32,
) -> Result<SurahTimings, AppError> {
    state.audio.timings(reciter_id, surah).await
}

#[tauri::command]
#[specta::specta]
pub async fn audio_list_reciters(state: State<'_, AppState>) -> Result<Vec<ReciterInfo>, AppError> {
    // The catalog's reciters with their download state: `PackManager::reciters` reads user.db and content.db (about 15
    // small indexed queries), so it runs on the blocking pool, never on an async worker (§0.2).
    let packs = state.packs.clone();
    crate::util::blocking(move || Ok(packs.reciters())).await
}

fn check_volume(pct: u32) -> Result<(), AppError> {
    if VOLUME_PCT.contains(pct) {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!(
            "volume {pct} % is not in 0..=100"
        )))
    }
}

/// An ayah target must be an ayah id; file positions are clamped by the engine.
fn check_seek(target: SeekTarget) -> Result<(), AppError> {
    match target {
        SeekTarget::Ayah { ayah_id } if !(1..=AYAH_COUNT).contains(&ayah_id) => Err(
            AppError::InvalidArgument(format!("ayah {ayah_id} is not in 1..={AYAH_COUNT}")),
        ),
        _ => Ok(()),
    }
}

fn check_ab_loop(ab: AbLoop) -> Result<(), AppError> {
    if ab.b_ms >= ab.a_ms && ab.b_ms - ab.a_ms >= MIN_AB_LOOP_MS {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!(
            "A-B loop {}..{} ms is shorter than {MIN_AB_LOOP_MS} ms",
            ab.a_ms, ab.b_ms
        )))
    }
}

// Every test here starts the real audio service, which only debug builds can put on the null sink (LEAD item 9).
#[cfg(all(test, debug_assertions))]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use quran_types::{AyahRef, FontTransport, PlaybackStatus, StopAt};
    use tauri::Manager;
    use tauri::test::MockRuntime;
    use tempfile::TempDir;

    use super::*;
    use crate::audio_glue::tests::{MP3_FRAMES, request, silent_mp3, stored};
    use crate::setup::tests::{build_mock, real_core_db, temp_paths};
    use crate::setup::{CorePolicy, StartupEnv};

    /// The app's real `AppState` on a mock app: the built core.db when this checkout has one (else the debug degrade
    /// path), the null audio sink, and the network switched off so no command here can reach it.
    fn app(dir: &TempDir) -> (tauri::App<MockRuntime>, bool) {
        let real = real_core_db();
        let has_core = real.is_some();
        let core = real.unwrap_or_else(|| dir.path().join("no-core.db"));
        let env = StartupEnv {
            paths: temp_paths(dir.path(), core),
            os_locale: Some("en-US".to_owned()),
            test_mode: false,
            font_transport: FontTransport::Url,
        };
        let policy = if has_core {
            CorePolicy::Fatal
        } else {
            CorePolicy::Degrade
        };
        let (app, built) = build_mock(env, policy);
        let (state, _) = built.unwrap();
        state.packs.set_network_allowed(false);
        assert!(app.manage(state));
        (app, has_core)
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn invalid<T: std::fmt::Debug>(r: Result<T, AppError>) -> bool {
        matches!(r, Err(AppError::InvalidArgument(_)))
    }

    #[test]
    fn arguments_are_validated() {
        let dir = TempDir::new().unwrap();
        let (app, _) = app(&dir);
        let s = || app.state::<AppState>();
        assert!(invalid(run(audio_set_speed(s(), 52))));
        assert!(invalid(run(audio_set_speed(s(), 45))));
        assert!(invalid(run(audio_set_speed(s(), 205))));
        assert!(run(audio_set_speed(s(), 125)).is_ok());
        assert!(invalid(run(audio_set_volume(s(), 101))));
        assert!(run(audio_set_volume(s(), 0)).is_ok());
        assert!(invalid(run(audio_set_repeat(s(), 100, 1))));
        assert!(invalid(run(audio_set_repeat(s(), 1, 100))));
        assert!(run(audio_set_repeat(s(), 0, 99)).is_ok());
        assert!(invalid(run(audio_set_gap(
            s(),
            GapSetting::Fixed { ms: 30_001 }
        ))));
        assert!(invalid(run(audio_set_gap(
            s(),
            GapSetting::Multiplier { pct: 301 }
        ))));
        assert!(run(audio_set_gap(s(), GapSetting::Multiplier { pct: 300 })).is_ok());
        assert!(run(audio_set_gap(s(), GapSetting::None)).is_ok());
        let ab = |a_ms, b_ms| Some(AbLoop { a_ms, b_ms });
        assert!(invalid(run(audio_set_ab_loop(s(), ab(100, 399)))));
        assert!(invalid(run(audio_set_ab_loop(s(), ab(500, 100)))));
        assert!(run(audio_set_ab_loop(s(), ab(100, 400))).is_ok());
        assert!(run(audio_set_ab_loop(s(), None)).is_ok());
        assert!(invalid(run(audio_seek(
            s(),
            SeekTarget::Ayah { ayah_id: 0 }
        ))));
        assert!(invalid(run(audio_seek(
            s(),
            SeekTarget::Ayah { ayah_id: 6_237 }
        ))));
        assert!(run(audio_seek(s(), SeekTarget::Ayah { ayah_id: 6_236 })).is_ok());
        assert!(run(audio_seek(s(), SeekTarget::FileMs { ms: 10 })).is_ok());
        assert!(run(audio_seek(s(), SeekTarget::RelativeMs { delta_ms: -5_000 })).is_ok());
        assert!(invalid(run(audio_get_timings(s(), 7, 0))));
        assert!(invalid(run(audio_get_timings(s(), 7, 115))));
        let bad = request(AyahRef { surah: 1, ayah: 8 }, None, None);
        assert!(invalid(run(audio_play(s(), bad))));
        // Transport commands are fire-and-forget.
        for r in [
            run(audio_pause(s())),
            run(audio_resume(s())),
            run(audio_toggle(s())),
            run(audio_skip(s(), SkipDirection::Next)),
            run(audio_skip(s(), SkipDirection::Previous)),
            run(audio_stop(s())),
        ] {
            assert!(r.is_ok());
        }
        assert!(run(audio_list_reciters(s())).is_ok());
        // Nothing was played: the engine is still idle, with the last speed and volume.
        let snapshot = run(audio_get_snapshot(s())).unwrap();
        assert_eq!(snapshot.status, PlaybackStatus::Idle);
        app.state::<AppState>().audio.shutdown();
    }

    #[test]
    fn subscribe_play_and_timings_through_the_commands() {
        let dir = TempDir::new().unwrap();
        let (app, has_core) = app(&dir);
        let s = || app.state::<AppState>();
        let state = s();

        // A cached recitation: 1:1–1:7 timings bound to a silent file in packs/audio.
        let mp3 = silent_mp3(MP3_FRAMES);
        state
            .content
            .timings_put(&stored(7, 1, mp3.len() as u64, Duration::ZERO), false)
            .unwrap();
        let file = quran_audio::cached_file_path(&state.packs.audio_root(), 7, 1);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, &mp3).unwrap();

        let ticks = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&ticks);
        let first = run(audio_subscribe(
            s(),
            Channel::new(move |_body| {
                counted.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }),
        ))
        .unwrap();
        assert_eq!(first.status, PlaybackStatus::Idle);

        let timings = run(audio_get_timings(s(), 7, 1)).unwrap();
        assert_eq!((timings.surah, timings.ayahs.len()), (1, 7));
        // Not stored and the network is off: offline, without a request.
        assert!(matches!(
            run(audio_get_timings(s(), 7, 2)),
            Err(AppError::Offline(_))
        ));

        let stop = if has_core {
            StopAt::EndOfPage // page 1 of the v2 layout is al-Fatihah
        } else {
            StopAt::EndOfSurah
        };
        let played = run(audio_play(
            s(),
            request(AyahRef { surah: 1, ayah: 1 }, None, Some(stop)),
        ))
        .unwrap();
        assert_eq!(played.status, PlaybackStatus::Loading);
        assert_eq!(
            played.range.map(|r| r.to),
            Some(AyahRef { surah: 1, ayah: 7 })
        );
        if has_core {
            assert!(state.audio.index_ready(), "audio_play warmed the index");
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let snap = run(audio_get_snapshot(s())).unwrap();
            if snap.status == PlaybackStatus::Idle && snap.current.is_none() && snap.range.is_some()
            {
                assert_eq!(snap.error, None);
                break;
            }
            assert!(Instant::now() < deadline, "the play did not end: {snap:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            ticks.load(Ordering::Acquire) > 10,
            "ticks reached the channel"
        );
        state.audio.shutdown();
    }
}
