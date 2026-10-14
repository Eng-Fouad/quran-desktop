//! User study commands: positions, history, search history, memorisation, loop presets, backup. Every mutating command
//! except `position_set` emits `UserDataChanged`.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.
//
// Layout: each command is a one-line wrapper that takes the `UserDb` out of the managed state and calls its twin in
// [`ops`], which is generic over the tauri `Runtime` and therefore tested end to end with `tauri::test::mock_app()` and a
// real user.db (a full `AppState` cannot be built in a unit test). SQLite work runs on the blocking pool; events are
// emitted only after the write committed.
//
// `UserDataChanged` kinds: history and search history → `history` (the contract has no search-history kind; the
// history sidebar and the search panel both refresh on it), memorisation and self-tests → `memo`, presets → `presets`.
// `user_backup_create` changes no user data and emits nothing.
//
// `user_backup_restore` (the "library recovered" banner's "Restore from backup…") replaces the whole library, settings
// and pack registry included, inside the settings writers' gate: it validates the file, keeps a copy of the current
// library in `<data>/backups/` (a restore of the wrong file can be undone), restores (`UserDb::restore_from`: verified
// first, nothing changes on a bad file), then applies the settings hooks to the settings before and after and emits
// `SettingsChanged`, `UserDataChanged` with every kind, and (through the pack manager's re-sync) `PacksChanged` for
// every pack.

use std::path::{Path, PathBuf};

use quran_core::{CoreError, UserDb};
use quran_types::{
    AYAH_COUNT, AppError, HistoryEntry, HistoryInput, LoopPreset, LoopPresetInput, MemoProgress,
    MemoReviewInput, MemoStatus, MemoTest, MemoTestResult, ReadingPosition, SearchHistoryEntry,
    SearchScope, Settings, UserDataKind,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::ipc::events::UserDataChanged;
use crate::state::AppState;
use crate::util::{blocking, now_secs, to_js_path};

/// Emits a typed app event under its tauri-specta name (`E::NAME`, e.g. `"user-data-changed"`) through
/// `tauri::Emitter`, without tauri-specta's `Event::emit`, which `expect`s its registry (a panic, i.e. an abort in
/// release, if `mount_events` never ran). A failed emit is logged; the command's own result stands.
pub(crate) fn emit_event<R: Runtime, E: tauri_specta::Event + Serialize>(
    app: &AppHandle<R>,
    event: &E,
) {
    if let Err(e) = app.emit(E::NAME, event) {
        log::warn!("emit {}: {e}", E::NAME);
    }
}

/// Runs `f` on the blocking pool with the user database.
pub(crate) async fn with_user<T: Send + 'static>(
    user: UserDb,
    f: impl FnOnce(&UserDb) -> quran_core::Result<T> + Send + 'static,
) -> Result<T, AppError> {
    blocking(move || f(&user).map_err(AppError::from)).await
}

/// [`with_user`] for a mutation: on success emits `UserDataChanged { kinds: [kind] }`.
async fn mutate<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    user: UserDb,
    kind: UserDataKind,
    f: impl FnOnce(&UserDb) -> quran_core::Result<T> + Send + 'static,
) -> Result<T, AppError> {
    let out = with_user(user, f).await?;
    emit_event(app, &UserDataChanged { kinds: vec![kind] });
    Ok(out)
}

/// `from..=to` must be a non-empty ayah range (checked before anything else uses it, e.g. `fastrand`).
fn check_range(from: u32, to: u32) -> Result<(), AppError> {
    let ayahs = 1..=AYAH_COUNT;
    if !ayahs.contains(&from) || !ayahs.contains(&to) {
        return Err(AppError::InvalidArgument(format!(
            "ayah range {from}..={to} is not within 1..={AYAH_COUNT}"
        )));
    }
    if from > to {
        return Err(AppError::InvalidArgument(format!(
            "ayah range {from}..={to} is reversed"
        )));
    }
    Ok(())
}

/// The default backup file name for a UTC time: `user-YYYYMMDD-HHMMSSZ.qdb`.
fn backup_file_name(unix_secs: u32) -> String {
    let secs = i64::from(unix_secs);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!(
        "user-{y:04}{m:02}{d:02}-{:02}{:02}{:02}Z.qdb",
        t / 3600,
        t % 3600 / 60,
        t % 60
    )
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian calendar (H. Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// `dir/name`, or `dir/{stem}-2.qdb`, `-3`, … when that file already exists.
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = name.strip_suffix(".qdb").unwrap_or(name);
    (2_u32..)
        .map(|n| dir.join(format!("{stem}-{n}.qdb")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Where `user_backup_create` writes: `None` → `<data>/backups/<default name>` (the folder is created); a folder →
/// the default name inside it; otherwise the given file (replaced if it exists, its folder must exist). Paths must be
/// absolute: the app's working directory means nothing to the user.
fn resolve_backup_dest(
    dest: Option<&str>,
    default_dir: &Path,
    now_secs: u32,
) -> Result<PathBuf, AppError> {
    let name = backup_file_name(now_secs);
    let Some(raw) = dest else {
        std::fs::create_dir_all(default_dir).map_err(|e| AppError::from(CoreError::Io(e)))?;
        return Ok(unique_in(default_dir, &name));
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidArgument(
            "backup path is empty (pass null for the default folder)".into(),
        ));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(AppError::InvalidArgument(format!(
            "backup path {raw} is not absolute"
        )));
    }
    if path.is_dir() {
        check_outside_live_data(&path, default_dir, raw)?;
        return Ok(unique_in(&path, &name));
    }
    match path.parent() {
        Some(parent) if parent.is_dir() => {
            check_outside_live_data(parent, default_dir, raw)?;
            Ok(path)
        }
        _ => Err(AppError::InvalidArgument(format!(
            "the folder of {raw} does not exist"
        ))),
    }
}

/// A backup goes into `backups/` or outside the data folder, never among the live data (content.db and its journal,
/// the pack databases, the stream cache): `UserDb::backup_to` only guards user.db itself, and a backup written over
/// another open database would corrupt it. `backups_dir` is `<data>/backups`; `folder` is where the backup would be
/// written. Folders compare by their canonical form (links, `..`, letter case resolved).
fn check_outside_live_data(folder: &Path, backups_dir: &Path, raw: &str) -> Result<(), AppError> {
    let Some(data_dir) = backups_dir.parent() else {
        return Ok(());
    };
    let canonical = |p: &Path| dunce::canonicalize(p).ok();
    let (Some(folder), Some(data_dir)) = (canonical(folder), canonical(data_dir)) else {
        return Ok(());
    };
    let in_backups = canonical(backups_dir).is_some_and(|b| folder.starts_with(b));
    if folder.starts_with(&data_dir) && !in_backups {
        return Err(AppError::InvalidArgument(format!(
            "{raw} is inside the app's data folder: a backup goes into its backups folder or anywhere outside it"
        )));
    }
    Ok(())
}

/// What `user_backup_restore` reads: an absolute path to an existing file.
fn resolve_restore_source(raw: &str) -> Result<PathBuf, AppError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::InvalidArgument("backup path is empty".into()));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(AppError::InvalidArgument(format!(
            "backup path {raw} is not absolute"
        )));
    }
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(path),
        Ok(_) => Err(AppError::InvalidArgument(format!("{raw} is not a file"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(AppError::NotFound(format!("backup {raw} does not exist")))
        }
        Err(e) => Err(AppError::from(CoreError::Io(e))),
    }
}

/// Every kind of user data: a restore replaces all of it.
const ALL_USER_DATA: [UserDataKind; 10] = [
    UserDataKind::Bookmarks,
    UserDataKind::ReadingBookmark,
    UserDataKind::Highlights,
    UserDataKind::Notes,
    UserDataKind::Collections,
    UserDataKind::Tags,
    UserDataKind::Positions,
    UserDataKind::History,
    UserDataKind::Memo,
    UserDataKind::Presets,
];

/// The command bodies, generic over the tauri runtime (see the file comment).
pub(crate) mod ops {
    use super::*;

    pub async fn position_set(user: UserDb, position: ReadingPosition) -> Result<(), AppError> {
        with_user(user, move |u| u.position_set(&position)).await
    }

    pub async fn history_record<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        entry: HistoryInput,
    ) -> Result<(), AppError> {
        mutate(app, user, UserDataKind::History, move |u| {
            u.history_record(&entry)
        })
        .await
    }

    pub async fn history_list(
        user: UserDb,
        limit: u32,
        before_id: Option<u32>,
    ) -> Result<Vec<HistoryEntry>, AppError> {
        with_user(user, move |u| u.history_list(limit, before_id)).await
    }

    pub async fn history_clear<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
    ) -> Result<(), AppError> {
        mutate(app, user, UserDataKind::History, UserDb::history_clear).await
    }

    pub async fn search_history_add<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        query: String,
        scope: SearchScope,
    ) -> Result<(), AppError> {
        mutate(app, user, UserDataKind::History, move |u| {
            u.search_history_add(&query, &scope)
        })
        .await
    }

    pub async fn search_history_list(
        user: UserDb,
        limit: u32,
    ) -> Result<Vec<SearchHistoryEntry>, AppError> {
        with_user(user, move |u| u.search_history_list(limit)).await
    }

    pub async fn search_history_clear<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
    ) -> Result<(), AppError> {
        mutate(
            app,
            user,
            UserDataKind::History,
            UserDb::search_history_clear,
        )
        .await
    }

    pub async fn memo_progress(
        user: UserDb,
        from: u32,
        to: u32,
    ) -> Result<Vec<MemoProgress>, AppError> {
        with_user(user, move |u| u.memo_progress(from, to)).await
    }

    pub async fn memo_set_status<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        from: u32,
        to: u32,
        status: MemoStatus,
    ) -> Result<Vec<MemoProgress>, AppError> {
        mutate(app, user, UserDataKind::Memo, move |u| {
            u.memo_set_status(from, to, status)
        })
        .await
    }

    pub async fn memo_review<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: MemoReviewInput,
    ) -> Result<Vec<MemoProgress>, AppError> {
        mutate(app, user, UserDataKind::Memo, move |u| {
            u.memo_review(&input)
        })
        .await
    }

    pub async fn memo_test_start<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        from: u32,
        to: u32,
    ) -> Result<MemoTest, AppError> {
        // The range is checked before `fastrand::u32`, which panics on an empty range.
        check_range(from, to)?;
        let start = fastrand::u32(from..=to);
        mutate(app, user, UserDataKind::Memo, move |u| {
            u.memo_test_start(from, to, start)
        })
        .await
    }

    pub async fn memo_test_finish<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        result: MemoTestResult,
    ) -> Result<MemoTest, AppError> {
        mutate(app, user, UserDataKind::Memo, move |u| {
            u.memo_test_finish(&result)
        })
        .await
    }

    pub async fn loop_preset_list(user: UserDb) -> Result<Vec<LoopPreset>, AppError> {
        with_user(user, UserDb::loop_presets).await
    }

    pub async fn loop_preset_upsert<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        input: LoopPresetInput,
    ) -> Result<LoopPreset, AppError> {
        mutate(app, user, UserDataKind::Presets, move |u| {
            u.loop_preset_upsert(&input)
        })
        .await
    }

    pub async fn loop_preset_delete<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        id: u32,
    ) -> Result<(), AppError> {
        mutate(app, user, UserDataKind::Presets, move |u| {
            u.loop_preset_delete(id)
        })
        .await
    }

    pub async fn user_backup_create(
        user: UserDb,
        backups_dir: PathBuf,
        dest_path: Option<String>,
    ) -> Result<String, AppError> {
        blocking(move || {
            let dest = resolve_backup_dest(dest_path.as_deref(), &backups_dir, now_secs())?;
            user.backup_to(&dest)?;
            log::info!("user.db backed up");
            Ok(to_js_path(&dest))
        })
        .await
    }

    /// See the file comment. `hooks` are the settings hooks; the pack registry's re-sync is the caller's (it needs the
    /// pack manager). Returns the copy of the library as it was before the restore.
    pub async fn user_backup_restore<R: Runtime>(
        app: &AppHandle<R>,
        user: UserDb,
        backups_dir: PathBuf,
        src_path: String,
        hooks: impl FnOnce(&Settings, &Settings),
    ) -> Result<PathBuf, AppError> {
        let (_, kept) = crate::commands::settings::ops::replace_store(
            app,
            user,
            move |user| {
                let src = resolve_restore_source(&src_path)?;
                // Verified before the safety copy is made, so a wrong file leaves no trace.
                UserDb::check_backup(&src)?;
                let kept = resolve_backup_dest(None, &backups_dir, now_secs())?;
                user.backup_to(&kept)?;
                user.restore_from(&src)?;
                log::info!(
                    "user.db restored from a backup; the previous library was kept as a backup"
                );
                Ok(kept)
            },
            hooks,
        )
        .await?;
        emit_event(
            app,
            &UserDataChanged {
                kinds: ALL_USER_DATA.to_vec(),
            },
        );
        Ok(kept)
    }
}

// ---- positions and history

/// No event.
#[tauri::command]
#[specta::specta]
pub async fn position_set(
    state: State<'_, AppState>,
    position: ReadingPosition,
) -> Result<(), AppError> {
    ops::position_set(state.user.clone(), position).await
}

#[tauri::command]
#[specta::specta]
pub async fn history_record(
    app: AppHandle,
    state: State<'_, AppState>,
    entry: HistoryInput,
) -> Result<(), AppError> {
    ops::history_record(&app, state.user.clone(), entry).await
}

#[tauri::command]
#[specta::specta]
pub async fn history_list(
    state: State<'_, AppState>,
    limit: u32,
    before_id: Option<u32>,
) -> Result<Vec<HistoryEntry>, AppError> {
    ops::history_list(state.user.clone(), limit, before_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn history_clear(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    ops::history_clear(&app, state.user.clone()).await
}

#[tauri::command]
#[specta::specta]
pub async fn search_history_add(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
    scope: SearchScope,
) -> Result<(), AppError> {
    ops::search_history_add(&app, state.user.clone(), query, scope).await
}

#[tauri::command]
#[specta::specta]
pub async fn search_history_list(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<SearchHistoryEntry>, AppError> {
    ops::search_history_list(state.user.clone(), limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn search_history_clear(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    ops::search_history_clear(&app, state.user.clone()).await
}

// ---- memorisation

#[tauri::command]
#[specta::specta]
pub async fn memo_progress(
    state: State<'_, AppState>,
    from_ayah_id: u32,
    to_ayah_id: u32,
) -> Result<Vec<MemoProgress>, AppError> {
    ops::memo_progress(state.user.clone(), from_ayah_id, to_ayah_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn memo_set_status(
    app: AppHandle,
    state: State<'_, AppState>,
    from_ayah_id: u32,
    to_ayah_id: u32,
    status: MemoStatus,
) -> Result<Vec<MemoProgress>, AppError> {
    ops::memo_set_status(&app, state.user.clone(), from_ayah_id, to_ayah_id, status).await
}

/// Applies the Leitner-style schedule to every ayah in the range.
#[tauri::command]
#[specta::specta]
pub async fn memo_review(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MemoReviewInput,
) -> Result<Vec<MemoProgress>, AppError> {
    ops::memo_review(&app, state.user.clone(), input).await
}

/// Starts a recall test at a random ayah of the range (fastrand).
#[tauri::command]
#[specta::specta]
pub async fn memo_test_start(
    app: AppHandle,
    state: State<'_, AppState>,
    from_ayah_id: u32,
    to_ayah_id: u32,
) -> Result<MemoTest, AppError> {
    ops::memo_test_start(&app, state.user.clone(), from_ayah_id, to_ayah_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn memo_test_finish(
    app: AppHandle,
    state: State<'_, AppState>,
    result: MemoTestResult,
) -> Result<MemoTest, AppError> {
    ops::memo_test_finish(&app, state.user.clone(), result).await
}

// ---- loop presets and backup

#[tauri::command]
#[specta::specta]
pub async fn loop_preset_list(state: State<'_, AppState>) -> Result<Vec<LoopPreset>, AppError> {
    ops::loop_preset_list(state.user.clone()).await
}

#[tauri::command]
#[specta::specta]
pub async fn loop_preset_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    input: LoopPresetInput,
) -> Result<LoopPreset, AppError> {
    ops::loop_preset_upsert(&app, state.user.clone(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn loop_preset_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u32,
) -> Result<(), AppError> {
    ops::loop_preset_delete(&app, state.user.clone(), id).await
}

/// Writes a user.db backup (default: `<data>/backups/`) and returns its path.
#[tauri::command]
#[specta::specta]
pub async fn user_backup_create(
    state: State<'_, AppState>,
    dest_path: Option<String>,
) -> Result<String, AppError> {
    ops::user_backup_create(
        state.user.clone(),
        state.paths.data.join("backups"),
        dest_path,
    )
    .await
}

/// Replaces the library (bookmarks, highlights, notes, history, memorisation, presets, settings, download registry) with
/// a backup made by `user_backup_create`. The file is verified first and nothing changes when it is not a valid backup;
/// the current library is kept as a new backup in `<data>/backups/` before it is replaced. Emits `SettingsChanged`,
/// `UserDataChanged` with every kind and `PacksChanged`.
#[tauri::command]
#[specta::specta]
pub async fn user_backup_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    src_path: String,
) -> Result<(), AppError> {
    let hooks = crate::commands::settings::apply_hooks(&app, &state);
    ops::user_backup_restore(
        &app,
        state.user.clone(),
        state.paths.backups(),
        src_path,
        hooks,
    )
    .await?;
    state.library_restored();
    // The restored registry may name packs this machine does not hold (another machine's backup, an older one).
    if let Err(e) = state.packs.registry_replaced().await {
        log::warn!("restore: the pack registry was not re-synced: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::sync::{Arc, Mutex};

    use quran_types::{GapSetting, HistoryMode, MushafLayout, PositionContext};
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_app};

    use super::*;

    /// A mock app, a fresh user.db and the payloads of every `user-data-changed` event.
    struct Fixture {
        app: tauri::App<MockRuntime>,
        user: UserDb,
        events: Arc<Mutex<Vec<serde_json::Value>>>,
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let user = UserDb::open(&dir.path().join("user.db")).unwrap();
            let app = mock_app();
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            app.listen_any("user-data-changed", move |e| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(e.payload()).unwrap());
            });
            Self {
                app,
                user,
                events,
                dir,
            }
        }

        fn handle(&self) -> &AppHandle<MockRuntime> {
            self.app.handle()
        }

        fn user(&self) -> UserDb {
            self.user.clone()
        }

        /// The `kinds` of every event so far, then forgets them.
        fn take_kinds(&self) -> Vec<Vec<String>> {
            std::mem::take(&mut *self.events.lock().unwrap())
                .into_iter()
                .map(|v| serde_json::from_value(v["kinds"].clone()).unwrap())
                .collect()
        }
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn the_event_name_and_payload_match_the_contract() {
        let f = Fixture::new();
        emit_event(
            f.handle(),
            &UserDataChanged {
                kinds: vec![UserDataKind::ReadingBookmark, UserDataKind::Memo],
            },
        );
        assert_eq!(
            *f.events.lock().unwrap(),
            [serde_json::json!({"kinds": ["reading_bookmark", "memo"]})]
        );
    }

    #[test]
    fn positions_emit_nothing() {
        let f = Fixture::new();
        let p = ReadingPosition {
            context: PositionContext::Mushaf,
            layout: Some(MushafLayout::V2),
            page: Some(3),
            ayah_id: 14,
            scroll_px: None,
            updated_at: 0,
        };
        run(ops::position_set(f.user(), p)).unwrap();
        assert_eq!(f.user.positions().unwrap()[0].ayah_id, 14);
        assert!(f.take_kinds().is_empty());
        let bad = run(ops::position_set(
            f.user(),
            ReadingPosition { ayah_id: 0, ..p },
        ));
        assert!(matches!(bad, Err(AppError::InvalidArgument(_))), "{bad:?}");
    }

    #[test]
    fn history_and_search_history_round_trip_and_emit_history() {
        let f = Fixture::new();
        let entry = HistoryInput {
            mode: HistoryMode::Read,
            layout: Some(MushafLayout::V2),
            page: Some(1),
            ayah_id: 1,
            dwell_s: 12,
        };
        run(ops::history_record(f.handle(), f.user(), entry)).unwrap();
        let list = run(ops::history_list(f.user(), 10, None)).unwrap();
        assert_eq!((list.len(), list[0].dwell_s), (1, 12));
        run(ops::search_history_add(
            f.handle(),
            f.user(),
            "الرحمن".into(),
            SearchScope::Quran,
        ))
        .unwrap();
        assert_eq!(
            run(ops::search_history_list(f.user(), 10)).unwrap()[0].query,
            "الرحمن"
        );
        run(ops::search_history_clear(f.handle(), f.user())).unwrap();
        run(ops::history_clear(f.handle(), f.user())).unwrap();
        assert!(
            run(ops::history_list(f.user(), 10, None))
                .unwrap()
                .is_empty()
        );
        assert_eq!(f.take_kinds(), vec![vec!["history".to_owned()]; 4]);
    }

    #[test]
    fn failed_mutations_emit_nothing_and_map_errors() {
        let f = Fixture::new();
        let blank = run(ops::search_history_add(
            f.handle(),
            f.user(),
            "  ".into(),
            SearchScope::Notes,
        ));
        assert!(
            matches!(blank, Err(AppError::InvalidArgument(_))),
            "{blank:?}"
        );
        let missing = run(ops::loop_preset_delete(f.handle(), f.user(), 7));
        assert!(matches!(missing, Err(AppError::NotFound(_))), "{missing:?}");
        let finished = run(ops::memo_test_finish(
            f.handle(),
            f.user(),
            MemoTestResult {
                id: 1,
                reveals: 0,
                mistakes: 0,
                rating: 3,
            },
        ));
        assert!(
            matches!(finished, Err(AppError::NotFound(_))),
            "{finished:?}"
        );
        assert!(f.take_kinds().is_empty());
    }

    #[test]
    fn memorisation_commands_emit_memo() {
        let f = Fixture::new();
        let set = run(ops::memo_set_status(
            f.handle(),
            f.user(),
            1,
            7,
            MemoStatus::Learning,
        ))
        .unwrap();
        assert_eq!(set.len(), 7);
        let reviewed = run(ops::memo_review(
            f.handle(),
            f.user(),
            MemoReviewInput {
                from_ayah_id: 1,
                to_ayah_id: 7,
                rating: 4,
                mistakes: 0,
            },
        ))
        .unwrap();
        assert!(reviewed.iter().all(|p| p.strength == 2 && p.reviews == 1));
        assert_eq!(run(ops::memo_progress(f.user(), 1, 286)).unwrap(), reviewed);
        let test = run(ops::memo_test_start(f.handle(), f.user(), 1, 7)).unwrap();
        let done = run(ops::memo_test_finish(
            f.handle(),
            f.user(),
            MemoTestResult {
                id: test.id,
                reveals: 1,
                mistakes: 0,
                rating: 4,
            },
        ))
        .unwrap();
        assert_eq!(done.rating, Some(4));
        assert_eq!(f.take_kinds(), vec![vec!["memo".to_owned()]; 4]);
    }

    #[test]
    fn test_starts_are_random_within_the_range_and_bad_ranges_never_reach_fastrand() {
        let f = Fixture::new();
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..200 {
            let t = run(ops::memo_test_start(f.handle(), f.user(), 255, 257)).unwrap();
            assert!((255..=257).contains(&t.start_ayah_id));
            seen.insert(t.start_ayah_id);
        }
        assert_eq!(seen.len(), 3, "every ayah can start a test");
        for (from, to) in [(10, 9), (0, 5), (1, 6237), (6237, 6237)] {
            let r = run(ops::memo_test_start(f.handle(), f.user(), from, to));
            assert!(
                matches!(r, Err(AppError::InvalidArgument(_))),
                "{from}..={to}: {r:?}"
            );
        }
        let single = run(ops::memo_test_start(f.handle(), f.user(), 6236, 6236)).unwrap();
        assert_eq!(single.start_ayah_id, 6236);
    }

    #[test]
    fn presets_emit_presets() {
        let f = Fixture::new();
        let input = LoopPresetInput {
            id: None,
            name: "Kursi".into(),
            reciter_id: None,
            from_ayah_id: 262,
            to_ayah_id: 262,
            ayah_repeat: 5,
            range_repeat: 1,
            gap: GapSetting::None,
            speed_pct: 100,
        };
        let p = run(ops::loop_preset_upsert(f.handle(), f.user(), input)).unwrap();
        assert_eq!(
            run(ops::loop_preset_list(f.user())).unwrap(),
            std::slice::from_ref(&p)
        );
        run(ops::loop_preset_delete(f.handle(), f.user(), p.id)).unwrap();
        assert_eq!(f.take_kinds(), vec![vec!["presets".to_owned()]; 2]);
    }

    #[test]
    fn backups_go_to_the_default_folder_or_where_asked() {
        let f = Fixture::new();
        let backups = f.dir.path().join("backups");
        let first = run(ops::user_backup_create(f.user(), backups.clone(), None)).unwrap();
        let second = run(ops::user_backup_create(f.user(), backups.clone(), None)).unwrap();
        assert_ne!(
            first, second,
            "two backups in the same second get distinct names"
        );
        for path in [&first, &second] {
            let path = Path::new(path);
            assert_eq!(path.parent(), Some(backups.as_path()));
            assert!(UserDb::open(path).is_ok());
        }
        // An explicit file (replaced when it exists) and an explicit folder, outside the data folder.
        let elsewhere = tempfile::TempDir::new().unwrap();
        let chosen = elsewhere.path().join("mine.qdb");
        std::fs::write(&chosen, b"old").unwrap();
        let out = run(ops::user_backup_create(
            f.user(),
            backups.clone(),
            Some(chosen.to_string_lossy().into_owned()),
        ))
        .unwrap();
        assert_eq!(Path::new(&out), chosen);
        assert!(UserDb::open(&chosen).is_ok());
        let in_folder = run(ops::user_backup_create(
            f.user(),
            backups.clone(),
            Some(elsewhere.path().to_string_lossy().into_owned()),
        ))
        .unwrap();
        assert!(
            Path::new(&in_folder)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("user-")
        );
        // Into `backups/` by name is fine.
        let named = backups.join("named.qdb");
        let out = run(ops::user_backup_create(
            f.user(),
            backups.clone(),
            Some(named.to_string_lossy().into_owned()),
        ))
        .unwrap();
        assert_eq!(Path::new(&out), named);
        let no_folder = elsewhere.path().join("missing").join("x.qdb");
        // Among the live data (the data folder itself, a pack folder, over content.db), however it is spelled.
        let data = f.dir.path();
        let packs = data.join("packs");
        std::fs::create_dir_all(&packs).unwrap();
        for bad in [
            String::new(),
            "relative/file.qdb".to_owned(),
            no_folder.to_string_lossy().into_owned(),
            data.to_string_lossy().into_owned(),
            data.join("content.db").to_string_lossy().into_owned(),
            packs.join("x.qdb").to_string_lossy().into_owned(),
            backups
                .join("..")
                .join("packs")
                .to_string_lossy()
                .into_owned(),
        ] {
            let r = run(ops::user_backup_create(
                f.user(),
                backups.clone(),
                Some(bad.clone()),
            ));
            assert!(
                matches!(r, Err(AppError::InvalidArgument(_))),
                "{bad}: {r:?}"
            );
        }
        assert!(f.take_kinds().is_empty(), "a backup changes no user data");
    }

    /// The banner's "Restore from backup…": the backup replaces the library and the settings (hooks and every event
    /// follow), and the library it replaced is kept as a new backup.
    #[test]
    fn restore_replaces_the_library_keeps_the_old_one_and_reports_everything() {
        use quran_types::ThemeMode;

        let f = Fixture::new();
        let settings_events = Arc::new(Mutex::new(Vec::<Settings>::new()));
        let sink = Arc::clone(&settings_events);
        f.app.listen_any("settings-changed", move |e| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(e.payload()).unwrap());
        });
        let backups = f.dir.path().join("backups");
        let preset = |name: &str| LoopPresetInput {
            id: None,
            name: name.into(),
            reciter_id: None,
            from_ayah_id: 1,
            to_ayah_id: 7,
            ayah_repeat: 3,
            range_repeat: 1,
            gap: GapSetting::Fixed { ms: 500 },
            speed_pct: 100,
        };
        f.user.loop_preset_upsert(&preset("backed up")).unwrap();
        let night = Settings {
            theme: ThemeMode::Night,
            ..Settings::default()
        };
        f.user.settings_save(&night).unwrap();
        let backup = run(ops::user_backup_create(f.user(), backups.clone(), None)).unwrap();

        // The library moves on after the backup.
        f.user
            .loop_preset_delete(f.user.loop_presets().unwrap()[0].id)
            .unwrap();
        f.user.loop_preset_upsert(&preset("newer")).unwrap();
        let sepia = Settings {
            theme: ThemeMode::Sepia,
            ..Settings::default()
        };
        f.user.settings_save(&sepia).unwrap();
        f.take_kinds();

        let mut hooks = Vec::new();
        let kept = run(ops::user_backup_restore(
            f.handle(),
            f.user(),
            backups.clone(),
            backup.clone(),
            |prev, next| hooks.push((prev.theme, next.theme)),
        ))
        .unwrap();
        let names = |db: &UserDb| -> Vec<String> {
            db.loop_presets()
                .unwrap()
                .into_iter()
                .map(|p| p.name)
                .collect()
        };
        assert_eq!(names(&f.user), ["backed up"]);
        assert_eq!(f.user.settings_load().unwrap(), night);
        assert_eq!(hooks, [(ThemeMode::Sepia, ThemeMode::Night)]);
        assert_eq!(*settings_events.lock().unwrap(), [night]);
        assert_eq!(
            f.take_kinds(),
            [[
                "bookmarks",
                "reading_bookmark",
                "highlights",
                "notes",
                "collections",
                "tags",
                "positions",
                "history",
                "memo",
                "presets",
            ]
            .map(str::to_owned)
            .to_vec()]
        );
        // The replaced library is a backup of its own, in the backups folder.
        assert_eq!(kept.parent(), Some(backups.as_path()));
        assert_ne!(to_js_path(&kept), backup);
        let old = UserDb::open(&kept).unwrap();
        assert_eq!(names(&old), ["newer"]);
        assert_eq!(old.settings_load().unwrap().theme, ThemeMode::Sepia);
    }

    #[test]
    fn restore_refuses_bad_sources_and_changes_nothing() {
        let f = Fixture::new();
        let backups = f.dir.path().join("backups");
        f.user.memo_set_status(1, 7, MemoStatus::Learning).unwrap();
        let garbage = f.dir.path().join("garbage.qdb");
        std::fs::write(&garbage, b"not a library".repeat(100)).unwrap();
        let missing = f.dir.path().join("missing.qdb");
        for (src, expected) in [
            (String::new(), "invalid_argument"),
            ("relative/user.qdb".to_owned(), "invalid_argument"),
            (to_js_path(f.dir.path()), "invalid_argument"),
            (to_js_path(&missing), "not_found"),
            (to_js_path(&garbage), "invalid_argument"),
        ] {
            let r = run(ops::user_backup_restore(
                f.handle(),
                f.user(),
                backups.clone(),
                src.clone(),
                |_, _| panic!("no hook after a refused restore"),
            ));
            let kind = serde_json::to_value(r.unwrap_err()).unwrap()["kind"].clone();
            assert_eq!(kind, expected, "{src:?}");
        }
        assert_eq!(
            f.user.memo_progress(1, 7).unwrap().len(),
            7,
            "nothing changed"
        );
        assert!(f.take_kinds().is_empty(), "nothing emitted");
        assert!(
            !backups.exists(),
            "a refused restore keeps no copy of the current library"
        );
    }

    #[test]
    fn backup_names_are_utc_timestamps() {
        assert_eq!(backup_file_name(0), "user-19700101-000000Z.qdb");
        assert_eq!(backup_file_name(1_760_000_000), "user-20251009-085320Z.qdb");
        assert_eq!(backup_file_name(951_825_600), "user-20000229-120000Z.qdb");
        assert_eq!(backup_file_name(u32::MAX), "user-21060207-062815Z.qdb");
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }
}
