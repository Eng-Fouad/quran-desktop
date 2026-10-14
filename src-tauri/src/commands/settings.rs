//! Settings commands.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.
//
// `settings_set` / `settings_reset`:
// 1. read the stored settings and write the new ones in one user.db transaction (`UserDb::settings_replace` /
//    `settings_reset`), which yields the consistent `(prev, next)` pair; only changed keys are written;
// 2. apply the side effects through the stable hooks: `crate::window::apply_settings` (tray, close-to-tray, labels, UI
//    zoom; not the chrome effect), `PackManager::apply_settings` (network allowed, stream-cache cap),
//    `AudioService::apply_settings` (volume live; speed/repeat/gap are defaults for the next play);
// 3. emit `SettingsChanged(next)` and return `next`.
// Writers are serialised by one async gate held across all three steps, so two overlapping calls can never apply
// their hooks out of order (the hooks always see the chain prev₁→next₁ = prev₂→next₂ …). A failed write applies no
// hook and emits nothing.
//
// Reset keeps `quran_core::user_db::RESET_PRESERVED_KEYS` (UI language, onboarding done, hints seen, close-to-tray
// asked): it restores preferences without re-running onboarding or switching the language under the user.

use quran_core::UserDb;
use quran_types::{AppError, Settings};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Runtime, State};

use super::user_study::{emit_event, with_user};
use crate::ipc::events::SettingsChanged;
use crate::state::AppState;
use crate::util::blocking;

/// Serialises settings writers (see the file comment).
static WRITE_GATE: Mutex<()> = Mutex::const_new(());

/// What a write does (boxed: `Settings` is large and moves through the async state machine).
pub(crate) enum Change {
    Set(Box<Settings>),
    Reset,
}

/// The command bodies, generic over the tauri runtime and with the hooks passed in, so they are tested with
/// `tauri::test::mock_app()`, a real user.db and recording hooks.
pub(crate) mod ops {
    use super::*;

    pub async fn get(user: UserDb) -> Result<Settings, AppError> {
        with_user(user, UserDb::settings_load).await
    }

    pub async fn write<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        change: Change,
        hooks: impl FnOnce(&Settings, &Settings),
    ) -> Result<Settings, AppError> {
        let _gate = WRITE_GATE.lock().await;
        let (prev, next) = blocking(move || {
            match change {
                Change::Set(next) => user.settings_replace(&next),
                Change::Reset => user.settings_reset(),
            }
            .map_err(AppError::from)
        })
        .await?;
        hooks(&prev, &next);
        emit_event(app, &SettingsChanged(next.clone()));
        Ok(next)
    }

    /// A read-modify-write of a few fields (the window layer's close-to-tray answer and tray hint): `edit` runs on the
    /// settings as stored at that moment, inside the gate and one user.db transaction, so it can never undo a write
    /// that happened since the caller last looked. Like [`write`], but an edit that changes nothing applies no hook and
    /// emits nothing; returns the stored settings when something changed.
    pub async fn edit<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        edit: impl FnOnce(&mut Settings) + Send + 'static,
        hooks: impl FnOnce(&Settings, &Settings),
    ) -> Result<Option<Settings>, AppError> {
        let _gate = WRITE_GATE.lock().await;
        let (prev, next) =
            blocking(move || user.settings_edit(edit).map_err(AppError::from)).await?;
        if prev == next {
            return Ok(None);
        }
        hooks(&prev, &next);
        emit_event(app, &SettingsChanged(next.clone()));
        Ok(Some(next))
    }

    /// Replaces user.db's content as a whole (`swap`, e.g. a backup restore) inside the gate, then applies the hooks to
    /// the settings before and after it and emits `SettingsChanged(after)`, as a settings write would. Returns the
    /// settings after it and what `swap` returned. A failed swap applies no hook and emits nothing.
    pub async fn replace_store<R: Runtime, T: Send + 'static>(
        app: &AppHandle<R>,
        user: UserDb,
        swap: impl FnOnce(&UserDb) -> Result<T, AppError> + Send + 'static,
        hooks: impl FnOnce(&Settings, &Settings),
    ) -> Result<(Settings, T), AppError> {
        let _gate = WRITE_GATE.lock().await;
        let (prev, next, out) = blocking(move || {
            let prev = user.settings_load()?;
            let out = swap(&user)?;
            Ok((prev, user.settings_load()?, out))
        })
        .await?;
        hooks(&prev, &next);
        emit_event(app, &SettingsChanged(next.clone()));
        Ok((next, out))
    }
}

/// The production hooks: the window layer, the pack manager and the audio service follow `prev → next`.
pub(crate) fn apply_hooks<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    state: &'a AppState,
) -> impl FnOnce(&Settings, &Settings) + 'a {
    move |prev, next| {
        crate::window::apply_settings(app, prev, next);
        state.packs.apply_settings(prev, next);
        state.audio.apply_settings(prev, next);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Settings, AppError> {
    ops::get(state.user.clone()).await
}

/// Validates, persists the changed keys and applies side effects through the stable hooks:
/// `crate::window::apply_settings(&app, &prev, &next)`, `state.packs.apply_settings(&prev, &next)` and
/// `state.audio.apply_settings(&prev, &next)`; then emits `SettingsChanged(next)`.
#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    next: Settings,
) -> Result<Settings, AppError> {
    let hooks = apply_hooks(&app, &state);
    ops::write(&app, state.user.clone(), Change::Set(Box::new(next)), hooks).await
}

#[tauri::command]
#[specta::specta]
pub async fn settings_reset(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Settings, AppError> {
    let hooks = apply_hooks(&app, &state);
    ops::write(&app, state.user.clone(), Change::Reset, hooks).await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::sync::{Arc, Mutex as StdMutex};

    use quran_types::{GapSetting, ThemeMode, UiLanguage};
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_app};

    use super::*;

    struct Fixture {
        app: tauri::App<MockRuntime>,
        user: UserDb,
        events: Arc<StdMutex<Vec<Settings>>>,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let user = UserDb::open(&dir.path().join("user.db")).unwrap();
            let app = mock_app();
            let events = Arc::new(StdMutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            app.listen_any("settings-changed", move |e| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(e.payload()).unwrap());
            });
            Self {
                app,
                user,
                events,
                _dir: dir,
            }
        }

        fn write(
            &self,
            change: Change,
            hooks: impl FnOnce(&Settings, &Settings),
        ) -> Result<Settings, AppError> {
            tauri::async_runtime::block_on(ops::write(
                self.app.handle(),
                self.user.clone(),
                change,
                hooks,
            ))
        }
    }

    #[test]
    fn get_returns_the_stored_settings() {
        let f = Fixture::new();
        let get = || tauri::async_runtime::block_on(ops::get(f.user.clone())).unwrap();
        assert_eq!(get(), Settings::default());
        let night = Settings {
            theme: ThemeMode::Night,
            ..Settings::default()
        };
        f.user.settings_save(&night).unwrap();
        assert_eq!(get(), night);
    }

    #[test]
    fn set_validates_persists_calls_the_hooks_and_emits_camel_case() {
        let f = Fixture::new();
        let calls = StdMutex::new(Vec::new());
        let requested = Settings {
            volume_pct: 250,
            speed_pct: 133,
            gap: GapSetting::Fixed { ms: 900 },
            ..Settings::default()
        };
        let stored = f
            .write(Change::Set(Box::new(requested)), |prev, next| {
                calls.lock().unwrap().push((prev.clone(), next.clone()));
            })
            .unwrap();
        assert_eq!((stored.volume_pct, stored.speed_pct), (100, 135));
        assert_eq!(
            *calls.lock().unwrap(),
            [(Settings::default(), stored.clone())]
        );
        assert_eq!(f.user.settings_load().unwrap(), stored);
        assert_eq!(*f.events.lock().unwrap(), std::slice::from_ref(&stored));
        // The event payload is the IPC shape (camelCase), i.e. what the generated TS listener expects.
        let json = serde_json::to_value(SettingsChanged(stored)).unwrap();
        assert_eq!(json["volumePct"], serde_json::json!(100));
        assert_eq!(
            json["sidePane"]["autoCollapseSidebar"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn reset_keeps_the_language_and_reports_the_previous_settings() {
        let f = Fixture::new();
        let custom = Settings {
            ui_language: UiLanguage::Ar,
            onboarding_done: true,
            theme: ThemeMode::Black,
            volume_pct: 30,
            ..Settings::default()
        };
        f.user.settings_save(&custom).unwrap();
        let mut seen = None;
        let now = f
            .write(Change::Reset, |prev, next| {
                seen = Some((prev.clone(), next.clone()));
            })
            .unwrap();
        let expected = Settings {
            ui_language: UiLanguage::Ar,
            onboarding_done: true,
            ..Settings::default()
        };
        assert_eq!(now, expected);
        assert_eq!(seen, Some((custom, expected.clone())));
        assert_eq!(*f.events.lock().unwrap(), [expected]);
    }

    #[test]
    fn a_failed_write_applies_no_hook_and_emits_nothing() {
        let f = Fixture::new();
        // Make every write fail: a trigger that aborts inserts into `setting`.
        f.user
            .with(|c| {
                c.execute_batch(
                    "CREATE TRIGGER no_settings BEFORE INSERT ON setting BEGIN SELECT RAISE(ABORT, 'read-only'); END;",
                )?;
                Ok(())
            })
            .unwrap();
        let mut called = false;
        let r = f.write(
            Change::Set(Box::new(Settings {
                theme: ThemeMode::Sepia,
                ..Settings::default()
            })),
            |_, _| called = true,
        );
        assert!(matches!(r, Err(AppError::Database(_))), "{r:?}");
        assert!(!called);
        assert!(f.events.lock().unwrap().is_empty());
        assert_eq!(f.user.settings_load().unwrap(), Settings::default());
    }

    #[test]
    fn overlapping_writes_apply_their_hooks_in_one_chain() {
        let f = Fixture::new();
        let chain = Arc::new(StdMutex::new(Vec::new()));
        let handle = f.app.handle().clone();
        let tasks: Vec<_> = (0..16_u32)
            .map(|i| {
                let handle = handle.clone();
                let user = f.user.clone();
                let chain = Arc::clone(&chain);
                tauri::async_runtime::spawn(async move {
                    let next = Settings {
                        volume_pct: i,
                        ..Settings::default()
                    };
                    ops::write(
                        &handle,
                        user,
                        Change::Set(Box::new(next)),
                        move |prev, next| {
                            chain
                                .lock()
                                .unwrap()
                                .push((prev.volume_pct, next.volume_pct));
                        },
                    )
                    .await
                    .unwrap();
                })
            })
            .collect();
        for t in tasks {
            tauri::async_runtime::block_on(t).unwrap();
        }
        let chain = chain.lock().unwrap();
        assert_eq!(chain.len(), 16);
        assert_eq!(chain[0].0, 100, "the first write starts from the default");
        for pair in chain.windows(2) {
            assert_eq!(
                pair[0].1, pair[1].0,
                "each write starts where the previous ended: {chain:?}"
            );
        }
        assert_eq!(
            f.user.settings_load().unwrap().volume_pct,
            chain[15].1,
            "the last hook call matches what is stored"
        );
    }

    /// The window layer's edits (close-to-tray answer, tray hint) run on the settings stored at that moment: a
    /// concurrent `settings_set` is never undone by a copy read before it.
    #[test]
    fn edits_change_only_their_fields_and_skip_no_ops() {
        let f = Fixture::new();
        let handle = f.app.handle().clone();
        let edit = |e: fn(&mut Settings)| {
            let mut calls = Vec::new();
            let out = tauri::async_runtime::block_on(ops::edit(
                &handle,
                f.user.clone(),
                e,
                |prev, next| calls.push((prev.clone(), next.clone())),
            ))
            .unwrap();
            (out, calls)
        };
        // A settings_set lands first (e.g. the theme picked in Settings) …
        f.write(
            Change::Set(Box::new(Settings {
                theme: ThemeMode::Sepia,
                ..Settings::default()
            })),
            |_, _| {},
        )
        .unwrap();
        // … and the edit keeps it.
        let (stored, calls) = edit(|s| {
            s.close_to_tray = true;
            s.close_to_tray_asked = true;
        });
        let stored = stored.expect("changed");
        assert_eq!(stored.theme, ThemeMode::Sepia);
        assert!(stored.close_to_tray && stored.close_to_tray_asked);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0.theme, ThemeMode::Sepia);
        assert_eq!(calls[0].1, stored);
        assert_eq!(f.user.settings_load().unwrap(), stored);
        assert_eq!(f.events.lock().unwrap().last(), Some(&stored));

        let before = f.events.lock().unwrap().len();
        let (unchanged, calls) = edit(|s| s.close_to_tray = true);
        assert_eq!(unchanged, None, "nothing changed");
        assert!(calls.is_empty(), "no hook");
        assert_eq!(f.events.lock().unwrap().len(), before, "no event");
    }

    /// A whole-store swap (backup restore) reports the settings before and after it, like a write.
    #[test]
    fn a_store_swap_applies_the_hooks_to_the_settings_it_brings() {
        let f = Fixture::new();
        let restored = Settings {
            ui_language: UiLanguage::Ar,
            theme: ThemeMode::Night,
            ..Settings::default()
        };
        let mut calls = Vec::new();
        let swapped = {
            let restored = restored.clone();
            tauri::async_runtime::block_on(ops::replace_store(
                f.app.handle(),
                f.user.clone(),
                move |user| {
                    user.settings_save(&restored)
                        .map(drop)
                        .map_err(AppError::from)
                },
                |prev, next| calls.push((prev.clone(), next.clone())),
            ))
            .unwrap()
            .0
        };
        assert_eq!(swapped, restored);
        assert_eq!(calls, [(Settings::default(), restored.clone())]);
        assert_eq!(*f.events.lock().unwrap(), [restored]);

        let failed = tauri::async_runtime::block_on(ops::replace_store(
            f.app.handle(),
            f.user.clone(),
            |_| Err::<(), _>(AppError::InvalidArgument("not a backup".into())),
            |_, _| panic!("no hook after a failed swap"),
        ));
        assert!(
            matches!(failed, Err(AppError::InvalidArgument(_))),
            "{failed:?}"
        );
        assert_eq!(f.events.lock().unwrap().len(), 1, "nothing emitted");
    }
}
