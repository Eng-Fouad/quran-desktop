//! Shared helpers for the quran-core integration tests (`tests/*.rs` include it with `mod support;`).
//!
//! Every test crate compiles this module but uses only part of it, hence the `dead_code` allowance.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod mini_core;
pub mod user;

use std::path::{Path, PathBuf};

/// The repository root (two levels above this crate's manifest).
#[must_use]
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/quran-core sits two levels below the workspace root")
        .to_path_buf()
}

/// A path from an environment variable, or `None` when unset or blank. Relative values resolve against the workspace
/// root, so `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core …` works from the repository root even
/// though cargo runs test binaries with the crate directory as cwd.
#[must_use]
pub fn env_path(name: &str) -> Option<PathBuf> {
    let value = std::env::var_os(name).filter(|v| !v.is_empty())?;
    let path = PathBuf::from(value);
    Some(if path.is_absolute() {
        path
    } else {
        workspace_root().join(path)
    })
}

/// The real core.db for `#[ignore]`d integration tests: `QD_CORE_DB`. Panics with a helpful message when it
/// is unset or missing, because ignored tests only run when asked for.
#[must_use]
pub fn real_core_db() -> PathBuf {
    let path = env_path("QD_CORE_DB").unwrap_or_else(|| {
        panic!("set QD_CORE_DB to a built core.db (e.g. QD_CORE_DB=src-tauri/resources/core.db)")
    });
    let len = std::fs::metadata(&path)
        .unwrap_or_else(|e| panic!("QD_CORE_DB={}: {e}", path.display()))
        .len();
    assert!(
        len > 1_000_000,
        "QD_CORE_DB={} is {len} bytes: the build.rs placeholder, not a built core.db (run `pnpm core:qdc`)",
        path.display()
    );
    path
}

/// A fresh temporary directory, removed when dropped.
#[must_use]
pub fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("create a temp dir")
}

/// `tests/data/<name>`.
#[must_use]
pub fn data_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join(name)
}

/// Reads and deserialises the shared golden file `tests/data/<name>`.
#[must_use]
pub fn golden<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = data_path(name);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}
