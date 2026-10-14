//! `quran-packs`: installable content for Quran for Desktop.
//!
//! - [`catalog`]: the curated `catalog.json` model and validation.
//! - [`manager`]: [`PackManager`], the public API used by the app shell.
//! - [`http`], [`jobs`], [`install`], [`writers`]: the download manager (lanes, limits, retries, resume, integrity,
//!   atomic install, single writer per audio file).
//! - [`adapters`]: one module per catalog source, dispatched through the [`Adapter`] enum.
//! - [`transform`]: the ammonia policy and the QuranEnc → pack DB transform.
//! - [`fonts`]: the interactive lane for page fonts and decor; [`revalidate`]: the 7-day QF revalidator.
//!
//! Release builds use `panic = "abort"`, so a panic in a download task is a crash: production code here must not
//! panic.
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
