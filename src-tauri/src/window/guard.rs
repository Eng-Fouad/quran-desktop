//! The webview never navigates (there is no remote origin anywhere): the main window only ever shows the app.
//!
//! Every link in the UI opens through `system_open_external` (About, attributions, notes), but that rests on each
//! anchor's click handler. These guards hold whatever the page does, on every platform:
//! - a top-level navigation ([`on_navigation`]) is allowed only to the app itself (`tauri://localhost`,
//!   `http(s)://tauri.localhost`, `about:blank`, and the dev server in `tauri dev`);
//! - a new window ([`on_new_window`]: `window.open`, a middle click, `target="_blank"`) is never opened;
//! - an `https:` or `mailto:` target of either goes to the system handler instead, with `system_open_external`'s checks;
//!   anything else (a dropped file, `file:`, `javascript:`, plain `http:`) is refused.
//!
//! On Windows the webview also refuses dropped files and links outright (`SetAllowExternalDrop(false)`,
//! `window::webview2`); WKWebView and WebKitGTK have no such switch, so a drop there is a navigation this guard refuses.

use tauri::Runtime;
use tauri::webview::NewWindowResponse;
use url::Url;

/// What happens to a navigation or a new window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// The app's own page (a reload, the first load).
    Allow,
    /// Refused here; opened by the system handler instead.
    External(Url),
    /// Refused.
    Deny,
}

/// Whether `url` is the app's own page. `dev_url` is the dev server's (`build.devUrl`), passed only in `tauri dev`.
#[must_use]
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        // macOS and Linux serve the frontend from the custom protocol.
        "tauri" => url.host_str() == Some("localhost"),
        // Windows (and Android) serve it from `http://tauri.localhost` (`https` with `useHttpsScheme`).
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev_url.is_some_and(|dev| {
                    dev.scheme() == url.scheme()
                        && dev.host_str() == url.host_str()
                        && dev.port_or_known_default() == url.port_or_known_default()
                })
        }
        // A blank page shows nothing that is not the app's.
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

/// The decision for a top-level navigation to `url`.
#[must_use]
pub fn decide(url: &Url, dev_url: Option<&Url>) -> Decision {
    if is_app_url(url, dev_url) {
        return Decision::Allow;
    }
    match crate::commands::system::external_url(url.as_str()) {
        Ok(external) => Decision::External(external),
        Err(_) => Decision::Deny,
    }
}

/// The main window's navigation handler: `true` lets the navigation happen.
pub fn on_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    match decide(url, dev_url) {
        Decision::Allow => true,
        Decision::External(external) => {
            log::info!(
                "webview: a navigation to {} opens in the system handler instead",
                external.scheme()
            );
            open_external(external);
            false
        }
        Decision::Deny => {
            // The URL may be a local path: debug level only.
            log::warn!(
                "webview: a navigation to a {}: URL was refused",
                url.scheme()
            );
            log::debug!("webview: refused navigation to {url}");
            false
        }
    }
}

/// The main window's new-window handler: never a second window; an `https:` or `mailto:` target opens in the system
/// handler.
pub fn on_new_window<R: Runtime>(url: &Url) -> NewWindowResponse<R> {
    match decide(url, None) {
        Decision::External(external) => {
            log::info!(
                "webview: a new window for {} opens in the system handler instead",
                external.scheme()
            );
            open_external(external);
        }
        Decision::Allow | Decision::Deny => {
            log::warn!("webview: a new {}: window was refused", url.scheme());
        }
    }
    NewWindowResponse::Deny
}

/// Hands `url` to the OS (the opener plugin), off the webview's thread.
fn open_external(url: Url) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
            log::warn!(
                "webview: no application could open the {} link: {e}",
                url.scheme()
            );
        }
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_app_itself_is_navigable() {
        let dev = url("http://localhost:1420");
        for (target, dev_url, allowed) in [
            ("http://tauri.localhost/", None, true),
            ("http://tauri.localhost/index.html?x=1#y", None, true),
            ("https://tauri.localhost/", None, true),
            ("tauri://localhost/", None, true),
            ("tauri://localhost/assets/index.js", None, true),
            ("about:blank", None, true),
            ("http://localhost:1420/", Some(&dev), true),
            // The dev server only in `tauri dev`, and only its exact origin.
            ("http://localhost:1420/", None, false),
            ("http://localhost:1421/", Some(&dev), false),
            ("https://localhost:1420/", Some(&dev), false),
            ("tauri://evil/", None, false),
            ("http://tauri.localhost.evil.example/", None, false),
            ("http://quran.localhost/mushaf/v2/p1.woff2", None, false),
            ("quran://localhost/mushaf/v2/p1.woff2", None, false),
            ("about:srcdoc", None, false),
            ("https://quran.com/", Some(&dev), false),
            ("file:///C:/Users/u/Desktop/notes.txt", None, false),
        ] {
            assert_eq!(is_app_url(&url(target), dev_url), allowed, "{target}");
        }
    }

    #[test]
    fn web_links_go_to_the_system_handler_and_everything_else_is_refused() {
        assert_eq!(
            decide(&url("http://tauri.localhost/"), None),
            Decision::Allow
        );
        assert_eq!(
            decide(&url("https://quran.com/2/255"), None),
            Decision::External(url("https://quran.com/2/255"))
        );
        assert_eq!(
            decide(&url("mailto:feedback@example.com"), None),
            Decision::External(url("mailto:feedback@example.com"))
        );
        for refused in [
            "file:///C:/Users/u/Desktop/dropped.pdf",
            "http://example.com/",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "https://user:secret@example.com/",
            "ms-settings:privacy",
            "quran://localhost/x",
        ] {
            assert_eq!(decide(&url(refused), None), Decision::Deny, "{refused}");
        }
    }
}
