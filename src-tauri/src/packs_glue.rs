//! The pack manager's bridge to the webview.
//!
//! - [`build`] loads and validates the catalog and builds `quran_packs::PackManager` with a [`PackEventsImpl`]. Its
//!   background tasks start later, from `setup::after_manage` (`PackManager::start_background`).
//! - [`PackEventsImpl`] implements `quran_packs::PackEvents`:
//!   - `download` → the `DownloadEvent` channel registered by `packs_subscribe` (at most 10 events per second per job,
//!     throttled by the job runner). A send that fails means the webview reloaded: the channel is dropped until the next
//!     `packs_subscribe`, and events in between are not queued (the next subscription returns the jobs' snapshots);
//!   - `packs_changed` → the `PacksChanged` event (`"packs-changed"`), already coalesced by the manager;
//!   - `network` → the `NetworkChanged` event (`"network-changed"`).
//!
//! The functions are generic over the tauri `Runtime` (callers passing a `&tauri::AppHandle` still compile, with
//! `R = Wry`), so `setup::build_state` stays testable with `tauri::test::mock_app()`. Events are emitted under
//! tauri-specta's names without `Event::emit`'s registry lookup, which panics when the registry is not mounted (and a
//! panic aborts the release build).

use std::sync::{Arc, Mutex, PoisonError};

use quran_packs::{PackEvents, PackManager, PackManagerConfig};
use quran_types::{AppError, DownloadEvent};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_specta::Event;

use crate::ipc::events::{NetworkChanged, PacksChanged};

/// Builds the pack manager and its event bridge. Fails when the catalog cannot be read or does not validate (the
/// startup fatal path).
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    cfg: PackManagerConfig,
) -> Result<(PackManager, Arc<PackEventsImpl>), AppError> {
    let events = Arc::new(PackEventsImpl::new(app));
    let manager = PackManager::new(cfg, events.clone())?;
    Ok((manager, events))
}

/// Forwards pack-manager events to the webview.
pub struct PackEventsImpl {
    emitter: Box<dyn EventEmitter>,
    /// The `packs_subscribe` channel; dropped when a send fails (the webview reloaded).
    channel: Mutex<Option<Channel<DownloadEvent>>>,
}

impl PackEventsImpl {
    fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        Self {
            emitter: Box::new(app.clone()),
            channel: Mutex::new(None),
        }
    }

    /// Replaces the previous channel (`packs_subscribe`).
    pub fn set_channel(&self, ch: Channel<DownloadEvent>) {
        *self.channel.lock().unwrap_or_else(PoisonError::into_inner) = Some(ch);
    }

    /// Whether a channel is registered (and has not failed since).
    #[must_use]
    pub fn has_channel(&self) -> bool {
        self.channel
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}

impl PackEvents for PackEventsImpl {
    fn download(&self, e: DownloadEvent) {
        let mut slot = self.channel.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(channel) = slot.as_ref()
            && let Err(err) = channel.send(e)
        {
            log::debug!(
                "download channel closed ({err}); dropping it until the next packs_subscribe"
            );
            *slot = None;
        }
    }

    fn packs_changed(&self, pack_ids: Vec<String>) {
        log::debug!("packs changed: {}", pack_ids.join(", "));
        emit(self.emitter.as_ref(), &PacksChanged { pack_ids });
    }

    fn network(&self, online: bool) {
        emit(self.emitter.as_ref(), &NetworkChanged { online });
    }
}

/// The app's event emitter, type-erased so the glue works with any tauri runtime.
trait EventEmitter: Send + Sync {
    fn emit_value(&self, name: &str, payload: serde_json::Value);
}

impl<R: Runtime> EventEmitter for AppHandle<R> {
    fn emit_value(&self, name: &str, payload: serde_json::Value) {
        if let Err(e) = Emitter::emit(self, name, payload) {
            log::warn!("emit {name}: {e}");
        }
    }
}

/// Emits a typed event under tauri-specta's name for app events (`E::NAME`), without `Event::emit`'s registry lookup,
/// which panics when the registry is not mounted (and a panic aborts the release build).
fn emit<E: Event + Serialize>(emitter: &dyn EventEmitter, event: &E) {
    match serde_json::to_value(event) {
        Ok(payload) => emitter.emit_value(E::NAME, payload),
        Err(e) => log::error!("serialise {}: {e}", E::NAME),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use std::sync::Mutex;

    use tauri::ipc::InvokeResponseBody;

    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, serde_json::Value)>>);

    impl EventEmitter for Arc<Recorder> {
        fn emit_value(&self, name: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((name.to_owned(), payload));
        }
    }

    fn bridge() -> (PackEventsImpl, Arc<Recorder>) {
        let recorder = Arc::new(Recorder::default());
        let events = PackEventsImpl {
            emitter: Box::new(Arc::clone(&recorder)),
            channel: Mutex::new(None),
        };
        (events, recorder)
    }

    fn queued(job_id: u32) -> DownloadEvent {
        DownloadEvent::Queued {
            job_id,
            pack_id: "tr.en.saheeh".into(),
        }
    }

    #[test]
    fn events_use_the_generated_names_and_shapes() {
        let (events, recorder) = bridge();
        events.packs_changed(vec!["tr.en.saheeh".into(), "decor".into()]);
        events.network(false);
        let seen = recorder.0.lock().unwrap();
        assert_eq!(seen[0].0, "packs-changed");
        assert_eq!(
            seen[0].1,
            serde_json::json!({ "packIds": ["tr.en.saheeh", "decor"] })
        );
        assert_eq!(seen[1].0, "network-changed");
        assert_eq!(seen[1].1, serde_json::json!({ "online": false }));
    }

    #[test]
    fn download_events_reach_the_latest_channel_in_the_contract_shape() {
        let (events, _) = bridge();
        // No channel yet: nothing to deliver to, nothing fails.
        events.download(queued(1));
        assert!(!events.has_channel());

        let first = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&first);
        events.set_channel(Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        }));
        events.download(queued(2));
        let delivered: serde_json::Value = serde_json::from_str(&first.lock().unwrap()[0]).unwrap();
        assert_eq!(
            delivered,
            serde_json::json!({ "type": "queued", "data": { "jobId": 2, "packId": "tr.en.saheeh" } })
        );

        // A new subscription replaces the previous channel.
        let second = Arc::new(Mutex::new(0u32));
        let count = Arc::clone(&second);
        events.set_channel(Channel::new(move |_| {
            *count.lock().unwrap() += 1;
            Ok(())
        }));
        events.download(queued(3));
        assert_eq!(first.lock().unwrap().len(), 1);
        assert_eq!(*second.lock().unwrap(), 1);
    }

    #[test]
    fn a_failing_channel_is_dropped_until_the_next_subscription() {
        let (events, _) = bridge();
        let calls = Arc::new(Mutex::new(0u32));
        let count = Arc::clone(&calls);
        events.set_channel(Channel::new(move |_| {
            *count.lock().unwrap() += 1;
            Err(tauri::Error::WebviewNotFound)
        }));
        assert!(events.has_channel());
        events.download(queued(1));
        assert!(!events.has_channel(), "the closed channel is dropped");
        events.download(queued(2));
        assert_eq!(*calls.lock().unwrap(), 1, "no send after the failure");
    }
}
