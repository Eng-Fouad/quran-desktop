//! The no-op backend: used when the platform backend fails to initialise (the failure is logged and the app runs
//! without OS media controls) and on platforms without a backend.

use crate::{Backend, Metadata, PlaybackState};

/// Accepts every update and does nothing (trace-logged).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct NoopBackend;

impl Backend for NoopBackend {
    fn set_metadata(&self, m: Metadata) {
        log::trace!("media session (no-op): metadata {:?}", m.title);
    }

    fn set_state(&self, s: PlaybackState) {
        log::trace!("media session (no-op): state {:?}", s.status);
    }

    fn shutdown(self: Box<Self>) {
        log::trace!("media session (no-op): shutdown");
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::Status;

    #[test]
    fn accepts_every_update() {
        let backend: Box<dyn Backend> = Box::new(NoopBackend);
        backend.set_metadata(Metadata {
            title: "Al-Fatihah 1:1".into(),
            duration: Some(Duration::from_secs(47)),
            ..Metadata::default()
        });
        backend.set_state(PlaybackState {
            status: Status::Playing,
            rate: f64::NAN,
            ..PlaybackState::STOPPED
        });
        backend.set_state(PlaybackState::STOPPED);
        backend.shutdown();
    }
}
