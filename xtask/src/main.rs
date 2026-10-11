//! `cargo xtask`: developer tasks for Quran for Desktop (docs/ARCHITECTURE.md §2.7, §4).
//!
//! `main.rs` and `cli.rs` (WP0B, frozen) declare every subcommand and dispatch each to its own module, so the owners
//! never edit the same file: `build/` (WP3a; `build/qul.rs` WP3d), `verify.rs` (WP3b), `assets.rs`, `licenses.rs`,
//! `dev_packs.rs` (WP3c), `catalog.rs` (WP5a), `fixtures/` (dispatcher WP0B; mushaf WP1a, search WP1b, content WP1c,
//! packs WP5a).

mod assets;
mod build;
mod catalog;
mod cli;
mod dev_packs;
mod fixtures;
mod licenses;
mod verify;

use std::process::ExitCode;

use anyhow::{Context, ensure};
use clap::Parser;

use crate::cli::{Cli, Command};

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> anyhow::Result<()> {
    match command {
        Command::BuildCore(args) => build::run(&args),
        Command::VerifyCore(args) => verify::run(&args),
        Command::ExportFixtures(args) => fixtures::run(&args),
        Command::FetchAssets(args) => assets::run(&args),
        Command::FetchDevPacks(args) => dev_packs::run(&args),
        Command::Licenses => licenses::run(),
        Command::CatalogCheck(args) => catalog::run(&args),
        Command::Bindings => bindings(),
    }
}

/// `cargo test -p quran-desktop --lib export_bindings`, from the workspace root (D8: bindings are exported only by
/// that test, never at app start).
fn bindings() -> anyhow::Result<()> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = std::process::Command::new(cargo)
        .args(["test", "-p", "quran-desktop", "--lib", "export_bindings"])
        .current_dir(cli::workspace_root())
        .status()
        .context("run cargo")?;
    ensure!(status.success(), "export_bindings failed ({status})");
    Ok(())
}
