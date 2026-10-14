//! Signal processing on the decode thread, plus the callback's gain ramp.
//!
//! - [`wsola`]: own pure-Rust WSOLA time-stretcher (pitch-preserving speed 0.5×–2.0×, absolute analysis positions).
//! - [`resample`]: rubato `Fft` wrapper (`FixedSync::Input`, 1024-frame chunks) with the exact frame ratio and its
//!   startup delay trimmed.
//! - [`mix`]: channel map, 4 ms raised-cosine fades, the callback's gain ramp and volume curve.
//! - [`chain`]: the decode chain WSOLA → resampler → channel map → fades, with the exact output-frame ⇄ source-position
//!   mapping the markers use (`src_us = u·speed_pct·10⁶ / (100·out_rate)`, i.e. [`crate::shared::MediaRate`]).
//!
//! All slicing uses checked `get(..)` ranges: the crate denies `clippy::indexing_slicing`, and nothing here panics.

pub mod chain;
pub mod mix;
pub mod resample;
#[cfg(any(test, feature = "testing"))]
pub mod signals;
pub mod wsola;

pub use chain::{DspChain, StreamFormat, SyncPoint};
pub use mix::{Fade, GainRamp, map_channels, ms_to_frames, volume_gain};
pub use resample::Resampler;
pub use wsola::Wsola;
