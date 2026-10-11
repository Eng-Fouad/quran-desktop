//! Small helpers shared by every command module (§5.1). Frozen after wave 0.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use quran_types::AppError;

/// Runs synchronous SQLite/disk work on tauri's blocking pool and awaits it. A panic or cancellation of the task maps to
/// `AppError::Internal`. Never use it for async managers (`PackManager`, `AudioService::timings`): await those directly.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(internal)?
}

/// The only way to turn foreign errors (`tauri::Error`, `JoinError`, …) into [`AppError`]:
/// `impl From<tauri::Error> for AppError` cannot be written anywhere (orphan rule here; quran-types has no tauri
/// dependency). Use `.map_err(util::internal)`.
pub fn internal(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(e.to_string())
}

/// Current Unix time in seconds as the IPC timestamp type (§0.2). Saturates instead of wrapping in 2106 and returns 0
/// for a clock set before 1970.
#[must_use]
pub fn now_secs() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
}

/// A path as sent to JS: dunce-simplified, so Windows paths carry no `\\?\` verbatim prefix (§0.2).
#[must_use]
pub fn to_js_path(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn blocking_returns_the_closure_result() {
        let ok = tauri::async_runtime::block_on(blocking(|| Ok(41 + 1)));
        assert_eq!(ok, Ok(42));
        let err = tauri::async_runtime::block_on(blocking(|| {
            Err::<(), _>(AppError::NotFound("x".into()))
        }));
        assert_eq!(err, Err(AppError::NotFound("x".into())));
    }

    #[test]
    fn blocking_maps_a_panicking_task_to_internal() {
        let res =
            tauri::async_runtime::block_on(blocking(|| -> Result<(), AppError> { panic!("boom") }));
        assert!(matches!(res, Err(AppError::Internal(_))), "{res:?}");
    }

    #[test]
    fn internal_keeps_the_message() {
        assert_eq!(
            internal("disk full"),
            AppError::Internal("disk full".into())
        );
    }

    #[test]
    fn now_secs_is_after_2025() {
        assert!(now_secs() > 1_735_689_600);
    }

    #[test]
    fn to_js_path_strips_the_verbatim_prefix() {
        if cfg!(windows) {
            assert_eq!(
                to_js_path(Path::new(r"\\?\C:\Users\a\data")),
                r"C:\Users\a\data"
            );
        }
        assert_eq!(to_js_path(Path::new("relative/dir")), "relative/dir");
    }
}
