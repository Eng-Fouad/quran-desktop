//! `quran-packs`: installable content for Quran for Desktop (docs/ARCHITECTURE.md §2.5).
//!
//! - [`catalog`]: the curated `catalog.json` model and validation (§2.5.4).
//! - [`manager`]: [`PackManager`], the public API used by the app shell (§2.5.2).
//! - [`http`], [`jobs`], [`install`], [`writers`]: the download manager (lanes, limits, retries, resume, integrity,
//!   atomic install, single writer per audio file; §2.5.5).
//! - [`adapters`]: one module per catalog source, dispatched through the [`Adapter`] enum (§2.5.6).
//! - [`transform`]: the ammonia policy and the QuranEnc → pack DB transform (§2.5.6).
//! - [`fonts`]: the interactive lane for page fonts and decor; [`revalidate`]: the 7-day QF revalidator (§2.5.7).
//!
//! Release builds use `panic = "abort"`, so a panic in a download task is a crash: production code here must not
//! panic (§0.2).
//!
//! Frozen after wave 0 (§14.2), together with `error.rs` and `adapters/mod.rs`.
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

pub mod adapters;
pub mod catalog;
mod error;
pub mod fonts;
pub mod http;
pub mod install;
pub mod jobs;
pub mod manager;
pub mod revalidate;
pub mod transform;
pub mod writers;

pub use adapters::{Adapter, AdapterCtx, ItemKey, ItemOutcome, StagedPack};
pub use catalog::{Catalog, CatalogPack};
pub use error::PackError;
pub use manager::{PackEvents, PackManager, PackManagerConfig};
