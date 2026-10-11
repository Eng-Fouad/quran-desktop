//! `quran-audio`: the recitation engine of Quran for Desktop (docs/ARCHITECTURE.md §2.3).
//!
//! Threads (§1.1): `qd-audio-ctl` (commands, planner, timings and sources), `qd-audio-decode` (symphonia → WSOLA →
//! rubato → channel map → ring + markers), `qd-audio-out` (owns the cpal stream; rebuilds it on device changes) and
//! `qd-audio-tick` (30 Hz ticks and marker edges). Every discontinuity is an in-band [`shared::Marker`] at the exact ring
//! frame where it becomes audible, so highlighting is sample-accurate and repeats are gapless.
//!
//! The crate depends on `quran-types` only (no tauri, no SQLite): storage and network reach it through the
//! [`traits`] implemented by `src-tauri/src/audio_glue.rs`.
//!
//! Release builds use `panic = "abort"`, so a panic on an audio thread is a crash: production code here must not
//! panic (§0.2). Module visibility is `pub` so the integration tests in `tests/` can drive the internals; the stable
//! surface is the re-exported engine, planner, sources and traits.
//!
//! Frozen after wave 0 (§14.2), together with `error.rs`, `traits.rs` and `shared.rs`.
#![cfg_attr(
    not(test),
    deny(
        clippy::indexing_slicing,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable
    )
)]

pub mod control;
pub mod decode;
pub mod dsp;
pub mod engine;
mod error;
#[cfg(any(test, feature = "testing"))]
pub mod fake_out;
pub mod output;
pub mod plan;
pub mod shared;
#[cfg(debug_assertions)]
pub mod sink;
pub mod source;
pub mod ticker;
pub mod traits;

pub use engine::*;
pub use error::AudioError;
pub use plan::*;
pub use source::*;
pub use traits::*;
