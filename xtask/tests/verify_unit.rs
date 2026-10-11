//! The `verify-core` unit tests (`mod tests` of `xtask/src/verify.rs`), under `cargo test -p xtask --test 'verify_*'`.
//!
//! xtask is a binary crate, so the module is compiled here by `#[path]`, together with what it uses (`cli.rs` and the
//! build modules), the same way `build_*.rs` do. These tests need no real data: the gate logic runs on synthetic rows,
//! a tiny core.sql database, an empty file and synthetic Tanzil metadata. `verify_core.rs` runs the gates end to end on
//! the real core.db.

#![allow(dead_code)]

#[path = "../src/cli.rs"]
mod cli;

// The modules' directory: a `#[path]` on each would resolve through `tests/build/`, which does not exist (only
// Windows normalises `..` before opening the file).
#[path = "../src/build"]
mod build {
    pub mod derive;
    pub mod model;
    pub mod tanzil;

    /// `xtask/data/` (the same as `build::data_dir` in the binary).
    pub fn data_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data")
    }
}

#[path = "../src/verify.rs"]
mod verify;
