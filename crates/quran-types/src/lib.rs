//! `quran-types`: the IPC contract of Quran for Desktop.
//!
//! This crate holds **only** the DTOs exchanged between the Rust core and the webview, `Settings::default()`,
//! `Settings::validated()` and a few small pure helpers. It depends on serde, specta and thiserror, never on tauri or
//! SQLite, so every crate can return these types directly and `src/lib/ipc/bindings.ts` is generated from them.
//!
//! Conventions, enforced by `tests/dto.rs` (wire shapes) and `tests/settings.rs` (defaults snapshot):
//! - integers only (`u32`/`i32`), no floats and no 64-bit integers;
//! - structs are `camelCase`, unit-only enums are `snake_case` string unions;
//! - data enums are adjacently tagged `{ "type": …, "data": { …camelCase } }`, except [`AppError`]
//!   (`{ "kind": …, "message": … }`).

mod audio;
mod content;
mod error;
mod ids;
mod meta;
mod mushaf;
mod packs;
mod search;
mod settings;
mod system;
mod text;
mod user;

pub use audio::*;
pub use content::*;
pub use error::*;
pub use ids::*;
pub use meta::*;
pub use mushaf::*;
pub use packs::*;
pub use search::*;
pub use settings::*;
pub use system::*;
pub use text::*;
pub use user::*;
