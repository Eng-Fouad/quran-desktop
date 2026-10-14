//! System integration commands.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.
//
// `system_open_external` is the app's only way out to the web (About, attributions, feedback). The URL is parsed and
// checked before the OS sees it: `https:` (with a host and without embedded credentials, so `https://good@evil` cannot
// pose as `good`) or `mailto:`, at most 2048 bytes; the OS gets the parsed, normalised form (percent-encoded, so no
// stray quotes or spaces reach the shell handler). The OS handlers are called on the blocking pool (`ShellExecute`,
// `open`, `xdg-open` can take a moment).

use std::path::Path;

use quran_types::AppError;
use tauri::State;
use url::Url;

use crate::state::AppState;
use crate::util::blocking;

/// Longest URL handed to the OS (Windows' `ShellExecute` stops around 2 KiB).
const MAX_URL_BYTES: usize = 2048;

/// Opens an `https://` or `mailto:` URL in the default handler; any other scheme is `InvalidArgument`.
#[tauri::command]
#[specta::specta]
pub async fn system_open_external(url: String) -> Result<(), AppError> {
    let url = external_url(&url)?;
    blocking(move || {
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|e| {
            AppError::Io(format!(
                "no application could open the {} link: {e}",
                url.scheme()
            ))
        })
    })
    .await
}

/// Reveals the app data directory in the OS file manager.
#[tauri::command]
#[specta::specta]
pub async fn system_reveal_data_dir(state: State<'_, AppState>) -> Result<(), AppError> {
    let dir = state.paths.data.clone();
    blocking(move || open_folder(&dir)).await
}

/// The URL `system_open_external` may open, parsed and normalised (also the webview's navigation guard's test,
/// `window::guard`).
pub(crate) fn external_url(raw: &str) -> Result<Url, AppError> {
    let invalid = |why: &str| AppError::InvalidArgument(format!("{why}: {raw:?}"));
    if raw.len() > MAX_URL_BYTES {
        return Err(AppError::InvalidArgument(format!(
            "URL longer than {MAX_URL_BYTES} bytes ({} bytes)",
            raw.len()
        )));
    }
    let url = Url::parse(raw).map_err(|e| invalid(&format!("not a URL ({e})")))?;
    match url.scheme() {
        "https" => {
            if url.host_str().is_none_or(str::is_empty) {
                return Err(invalid("https URL without a host"));
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err(invalid("URL with embedded credentials"));
            }
        }
        "mailto" => {}
        other => {
            return Err(invalid(&format!(
                "only https: and mailto: URLs open, not {other}:"
            )));
        }
    }
    Ok(url)
}

/// Opens `dir` (created if needed) in the file manager: the folder itself, not its parent with it selected. The file
/// manager gets the plain form of a verbatim (`\\?\`) data directory whenever one exists (`setup::long_path_safe`).
fn open_folder(dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Io(format!("cannot create the data folder: {e}")))?;
    tauri_plugin_opener::open_path(dunce::simplified(dir), None::<&str>)
        .map_err(|e| AppError::Io(format!("cannot open the data folder: {e}")))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn https_and_mailto_open() {
        for (raw, normalised) in [
            ("https://quran.com/2/255", "https://quran.com/2/255"),
            ("HTTPS://Tanzil.NET", "https://tanzil.net/"),
            (
                "https://example.com/a b?q=\"x\"",
                "https://example.com/a%20b?q=%22x%22",
            ),
            (
                "https://example.com:8443/p#frag",
                "https://example.com:8443/p#frag",
            ),
            ("mailto:feedback@example.com", "mailto:feedback@example.com"),
            (
                "mailto:a@example.com?subject=Quran for Desktop",
                "mailto:a@example.com?subject=Quran%20for%20Desktop",
            ),
            (
                "https://xn--mgbcd4a2b0d2b.example/",
                "https://xn--mgbcd4a2b0d2b.example/",
            ),
        ] {
            assert_eq!(external_url(raw).unwrap().as_str(), normalised, "{raw}");
        }
    }

    #[test]
    fn everything_else_is_an_invalid_argument() {
        for raw in [
            "http://example.com",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.com",
            "ms-settings:privacy",
            "quran://localhost/mushaf/v2/p1.woff2",
            "http://quran.localhost/mushaf/v2/p1.woff2",
            "C:\\Windows\\notepad.exe",
            "/etc/passwd",
            "example.com",
            "",
            "https://",
            "https://user:secret@example.com/",
            "https://quran.com@evil.example/",
        ] {
            assert!(
                matches!(external_url(raw), Err(AppError::InvalidArgument(_))),
                "{raw:?}"
            );
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert!(matches!(
            external_url(&long),
            Err(AppError::InvalidArgument(_))
        ));
    }
}
