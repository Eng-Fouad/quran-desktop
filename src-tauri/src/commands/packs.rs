//! Pack, download and font commands.
//!
//! Thin wrappers over `quran_packs::PackManager` (`state.packs`): argument validation, the KiB conversions, and the
//! blocking pool for the registry reads (`list`, `items`, `disk_usage`). Async manager calls are awaited directly,
//! never through `blocking()`.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.

use quran_packs::PackManager;
use quran_types::{
    AppError, DecorStatus, DiskUsage, DownloadEvent, FetchPriority, InstallScope, JobSnapshot,
    MushafStyle, PAGE_COUNT, PackInfo, PackItemState, PackUpdate, PageFontStatus,
};
use tauri::State;
use tauri::ipc::Channel;

use crate::state::AppState;
use crate::util::blocking;

/// Most pages one `mushaf_ensure_page_fonts` call accepts.
pub const MAX_FONT_PAGES: usize = 12;

#[tauri::command]
#[specta::specta]
pub async fn packs_list(state: State<'_, AppState>) -> Result<Vec<PackInfo>, AppError> {
    let packs = state.packs.clone();
    blocking(move || Ok(packs.list()?)).await
}

/// Registers the download-event channel (`state.pack_events.set_channel`, replacing any previous one) and returns the
/// current jobs.
#[tauri::command]
#[specta::specta]
pub async fn packs_subscribe(
    state: State<'_, AppState>,
    on_event: Channel<DownloadEvent>,
) -> Result<Vec<JobSnapshot>, AppError> {
    // The channel first: a job event that happens between the two lines then reaches the webview as well as the
    // snapshot (the store keeps the later state of a job).
    state.pack_events.set_channel(on_event);
    Ok(state.packs.jobs())
}

/// Returns the job id. Also "Update" on a pack whose state is `update_available`.
#[tauri::command]
#[specta::specta]
pub async fn packs_install(
    state: State<'_, AppState>,
    pack_id: String,
    scope: InstallScope,
) -> Result<u32, AppError> {
    Ok(state.packs.install(check_id(&pack_id)?, scope).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn packs_pause(state: State<'_, AppState>, pack_id: String) -> Result<(), AppError> {
    Ok(state.packs.pause(check_id(&pack_id)?).await?)
}

/// Returns the job id. Also "Retry" on a failed job or pack.
#[tauri::command]
#[specta::specta]
pub async fn packs_resume(state: State<'_, AppState>, pack_id: String) -> Result<u32, AppError> {
    Ok(state.packs.resume(check_id(&pack_id)?).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn packs_cancel(state: State<'_, AppState>, pack_id: String) -> Result<(), AppError> {
    Ok(state.packs.cancel(check_id(&pack_id)?).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn packs_remove(state: State<'_, AppState>, pack_id: String) -> Result<(), AppError> {
    Ok(state.packs.remove(check_id(&pack_id)?).await?)
}

/// Per-item state of an on-demand pack.
#[tauri::command]
#[specta::specta]
pub async fn packs_items(
    state: State<'_, AppState>,
    pack_id: String,
) -> Result<Vec<PackItemState>, AppError> {
    check_id(&pack_id)?;
    let packs = state.packs.clone();
    blocking(move || Ok(packs.items(&pack_id)?)).await
}

/// Returns the KiB freed.
#[tauri::command]
#[specta::specta]
pub async fn packs_remove_items(
    state: State<'_, AppState>,
    pack_id: String,
    items: Vec<u32>,
) -> Result<u32, AppError> {
    let freed = state
        .packs
        .remove_items(check_id(&pack_id)?, &items)
        .await?;
    Ok(kib(freed))
}

#[tauri::command]
#[specta::specta]
pub async fn packs_disk_usage(state: State<'_, AppState>) -> Result<DiskUsage, AppError> {
    let packs = state.packs.clone();
    blocking(move || Ok(packs.disk_usage()?)).await
}

#[tauri::command]
#[specta::specta]
pub async fn packs_check_updates(state: State<'_, AppState>) -> Result<Vec<PackUpdate>, AppError> {
    Ok(state.packs.check_updates().await?)
}

/// Unpinned (streamed) audio only; returns the KiB freed.
#[tauri::command]
#[specta::specta]
pub async fn packs_clear_stream_cache(state: State<'_, AppState>) -> Result<u32, AppError> {
    Ok(kib(state.packs.clear_stream_cache().await?))
}

/// "Clear cache" (`PackManager::clear_cache`); returns the KiB freed.
#[tauri::command]
#[specta::specta]
pub async fn cache_clear(state: State<'_, AppState>) -> Result<u32, AppError> {
    Ok(kib(state.packs.clear_cache().await?))
}

/// At most 12 pages; resolves when each is ready/failed/unavailable (prefetch too). Style `hafs` → ready `"qd-hafs"`
/// without IO.
#[tauri::command]
#[specta::specta]
pub async fn mushaf_ensure_page_fonts(
    state: State<'_, AppState>,
    style: MushafStyle,
    pages: Vec<u32>,
    priority: FetchPriority,
) -> Result<Vec<PageFontStatus>, AppError> {
    ensure_page_fonts(&state.packs, style, &pages, priority).await
}

#[tauri::command]
#[specta::specta]
pub async fn decor_ensure(state: State<'_, AppState>) -> Result<DecorStatus, AppError> {
    Ok(state.packs.ensure_decor().await?)
}

// The command body without tauri state (tests drive it with any manager). Every page must be in 1..=604 and at most
// `MAX_FONT_PAGES` are accepted; the answer has one status per requested page, in order.
pub(crate) async fn ensure_page_fonts(
    packs: &PackManager,
    style: MushafStyle,
    pages: &[u32],
    priority: FetchPriority,
) -> Result<Vec<PageFontStatus>, AppError> {
    if pages.len() > MAX_FONT_PAGES {
        return Err(AppError::InvalidArgument(format!(
            "{} pages asked for; at most {MAX_FONT_PAGES} per call",
            pages.len()
        )));
    }
    if let Some(page) = pages.iter().find(|p| !(1..=PAGE_COUNT).contains(*p)) {
        return Err(AppError::InvalidArgument(format!(
            "page {page} is not in 1..={PAGE_COUNT}"
        )));
    }
    Ok(packs.ensure_page_fonts(style, pages, priority).await?)
}

// Pack ids are short ASCII identifiers; an empty or oversized id is a caller bug, not a lookup.
fn check_id(pack_id: &str) -> Result<&str, AppError> {
    let id = pack_id.trim();
    if id.is_empty() || id.len() > 64 {
        Err(AppError::InvalidArgument(format!(
            "pack id {pack_id:?} is not a pack id"
        )))
    } else {
        Ok(id)
    }
}

/// Bytes → KiB, rounded up, saturating.
pub(crate) fn kib(bytes: u64) -> u32 {
    u32::try_from(bytes.div_ceil(1024)).unwrap_or(u32::MAX)
}

/// The app's real `AppState` on a mock app, shared by the command tests of this module and `content.rs`. It starts the
/// audio service, which only debug builds can put on the null sink, so these tests are debug-only.
#[cfg(all(test, debug_assertions))]
pub(crate) mod test_support {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use quran_types::FontTransport;
    use tauri::Manager;
    use tauri::test::MockRuntime;
    use tempfile::TempDir;

    use crate::setup::tests::{build_mock, real_core_db, temp_paths};
    use crate::setup::{CorePolicy, StartupEnv};
    use crate::state::AppState;

    /// The built core.db when this checkout has one (else the debug degrade path), the checkout's catalog, and the
    /// network switched off, so no command here reaches the internet.
    pub(crate) fn app(dir: &TempDir) -> tauri::App<MockRuntime> {
        let real = real_core_db();
        let policy = if real.is_some() {
            CorePolicy::Fatal
        } else {
            CorePolicy::Degrade
        };
        let core = real.unwrap_or_else(|| dir.path().join("no-core.db"));
        let env = StartupEnv {
            paths: temp_paths(dir.path(), core),
            os_locale: Some("en-US".to_owned()),
            test_mode: false,
            font_transport: FontTransport::Url,
        };
        let (app, built) = build_mock(env, policy);
        let (state, _) = built.unwrap();
        state.packs.set_network_allowed(false);
        assert!(app.manage(state));
        app
    }

    pub(crate) fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    /// Stops the audio threads of a test app.
    pub(crate) fn shutdown(app: &tauri::App<MockRuntime>) {
        app.state::<AppState>().audio.shutdown();
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use quran_types::{FontAvailability, InstallScope, PackKind, PackState};
    use tauri::Manager;
    use tauri::ipc::InvokeResponseBody;
    use tauri::test::MockRuntime;
    use tempfile::TempDir;

    use super::test_support::{app, run, shutdown};
    use super::*;

    fn s(app: &tauri::App<MockRuntime>) -> State<'_, AppState> {
        app.state::<AppState>()
    }

    fn invalid<T: std::fmt::Debug>(r: Result<T, AppError>) -> bool {
        matches!(r, Err(AppError::InvalidArgument(_)))
    }

    /// A channel that records every message it carries.
    fn recording_channel() -> (Channel<DownloadEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, seen)
    }

    #[test]
    fn the_catalog_lists_with_states_and_usage() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let list = run(packs_list(s(&app))).unwrap();
        assert!(
            list.len() >= 30,
            "the shipped catalog: {} packs",
            list.len()
        );
        assert!(
            list.iter()
                .all(|p| p.state == PackState::NotInstalled && p.job.is_none())
        );
        assert!(
            list.iter()
                .any(|p| p.id == "decor" && p.kind == PackKind::Decor)
        );
        let usage = run(packs_disk_usage(s(&app))).unwrap();
        assert!(
            usage.user_db_kib > 0 && usage.content_db_kib > 0,
            "{usage:?}"
        );
        assert_eq!(usage.audio_pinned_kib + usage.audio_stream_kib, 0);
        assert!(!usage.data_dir.starts_with(r"\\?\"));
        assert!(
            run(packs_items(s(&app), "mushaf.v2".into()))
                .unwrap()
                .is_empty()
        );
        assert!(
            run(packs_items(s(&app), "tr.en.saheeh".into()))
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            run(packs_items(s(&app), "tr.xx.unknown".into())),
            Err(AppError::NotFound(_))
        ));
        assert!(invalid(run(packs_items(s(&app), "  ".into()))));
        shutdown(&app);
    }

    #[test]
    fn arguments_are_validated() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let fonts = |pages: Vec<u32>| {
            run(mushaf_ensure_page_fonts(
                s(&app),
                MushafStyle::QcfV2,
                pages,
                FetchPriority::Interactive,
            ))
        };
        assert!(invalid(fonts((1..=13).collect())));
        assert!(invalid(fonts(vec![0])));
        assert!(invalid(fonts(vec![605])));
        assert_eq!(fonts(Vec::new()).unwrap(), Vec::new());
        assert!(invalid(run(packs_install(
            s(&app),
            "mushaf.v2".into(),
            InstallScope::Items { items: vec![605] }
        ))));
        assert!(matches!(
            run(packs_install(
                s(&app),
                "tr.en.saheeh".into(),
                InstallScope::Items { items: vec![1] }
            )),
            Err(AppError::Unsupported(_))
        ));
        assert!(invalid(run(packs_remove_items(
            s(&app),
            "audio.qdc.7".into(),
            vec![115]
        ))));
        assert!(matches!(
            run(packs_remove_items(s(&app), "decor".into(), vec![1])),
            Err(AppError::Unsupported(_))
        ));
        assert!(matches!(
            run(packs_pause(s(&app), "decor".into())),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            run(packs_resume(s(&app), "decor".into())),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            run(packs_cancel(s(&app), "decor".into())),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            run(packs_install(
                s(&app),
                "nope.pack".into(),
                InstallScope::All
            )),
            Err(AppError::NotFound(_))
        ));
        assert_eq!(kib(0), 0);
        assert_eq!(kib(1), 1);
        assert_eq!(kib(u64::MAX), u32::MAX);
        shutdown(&app);
    }

    #[test]
    fn fonts_answer_without_the_network() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let state = s(&app);
        // Hafs never touches the disk or the network.
        let hafs = run(mushaf_ensure_page_fonts(
            s(&app),
            MushafStyle::Hafs,
            vec![1, 604],
            FetchPriority::Interactive,
        ))
        .unwrap();
        assert!(
            hafs.iter()
                .all(|p| p.availability == FontAvailability::Ready
                    && p.family == "qd-hafs"
                    && p.url.is_none())
        );
        // A page on disk is ready with its content-hashed URL; a missing one is unavailable while offline.
        let page = state.paths.packs.join("mushaf").join("v2").join("p3.woff2");
        std::fs::create_dir_all(page.parent().unwrap()).unwrap();
        let mut font = b"wOF2".to_vec();
        font.extend(std::iter::repeat_n(7u8, 2_000));
        std::fs::write(&page, &font).unwrap();
        let qcf = run(mushaf_ensure_page_fonts(
            s(&app),
            MushafStyle::QcfV2,
            vec![3, 4],
            FetchPriority::Prefetch,
        ))
        .unwrap();
        assert_eq!(qcf[0].availability, FontAvailability::Ready);
        assert_eq!(qcf[0].family, "qcf-v2-p3");
        assert_eq!(qcf[0].rel.as_deref(), Some("mushaf/v2/p3.woff2"));
        assert!(
            qcf[0]
                .url
                .as_deref()
                .unwrap()
                .contains("mushaf/v2/p3.woff2?v=")
        );
        assert_eq!(qcf[0].bytes, 2_004);
        assert_eq!(qcf[1].availability, FontAvailability::Unavailable);
        // Decor cannot be fetched offline; its status says what is there.
        assert!(matches!(
            run(decor_ensure(s(&app))),
            Err(AppError::Offline(_))
        ));
        assert!(!state.packs.decor_status().installed);
        shutdown(&app);
    }

    #[test]
    fn a_job_reports_through_the_channel_and_the_list() {
        let dir = TempDir::new().unwrap();
        let app = app(&dir);
        let (channel, seen) = recording_channel();
        assert!(run(packs_subscribe(s(&app), channel)).unwrap().is_empty());

        // The network is off: the job is queued, starts and fails with `offline` at its first request.
        let job = run(packs_install(
            s(&app),
            "mushaf.v1".into(),
            InstallScope::Items { items: vec![1, 2] },
        ))
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let failed = loop {
            let events = seen.lock().unwrap().clone();
            if let Some(failed) = events.iter().find(|e| e["type"] == "failed") {
                break failed.clone();
            }
            assert!(Instant::now() < deadline, "no failed event: {events:?}");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(failed["data"]["jobId"], job);
        assert_eq!(failed["data"]["packId"], "mushaf.v1");
        assert_eq!(failed["data"]["error"]["kind"], "offline");
        let kinds: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(kinds.first().map(String::as_str), Some("queued"));
        assert!(kinds.contains(&"started".to_owned()), "{kinds:?}");

        // The failed job is listed and its pack is failed; queued items show in the grid until it is cancelled.
        let jobs = run(packs_subscribe(s(&app), recording_channel().0)).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, job);
        let list = run(packs_list(s(&app))).unwrap();
        let v1 = list.iter().find(|p| p.id == "mushaf.v1").unwrap();
        assert!(matches!(&v1.state, PackState::Failed { error } if error.kind() == "offline"));
        assert_eq!(v1.job.as_ref().map(|j| j.job_id), Some(job));
        run(packs_cancel(s(&app), "mushaf.v1".into())).unwrap();
        let list = run(packs_list(s(&app))).unwrap();
        let v1 = list.iter().find(|p| p.id == "mushaf.v1").unwrap();
        assert_eq!(v1.state, PackState::NotInstalled);
        assert!(v1.job.is_none());
        // Removing a pack that is not installed is a no-op.
        run(packs_remove(s(&app), "mushaf.v1".into())).unwrap();
        assert_eq!(run(packs_clear_stream_cache(s(&app))).unwrap(), 0);
        let freed = run(cache_clear(s(&app))).unwrap();
        assert!(freed < 64, "an empty cache frees nothing much: {freed} KiB");
        // Offline update checks report it.
        assert!(matches!(
            run(packs_check_updates(s(&app))),
            Err(AppError::Offline(_))
        ));
        shutdown(&app);
    }
}
