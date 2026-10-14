//! `cargo xtask`: developer tasks for Quran for Desktop.
//!
//! `main.rs` and `cli.rs` declare every subcommand and dispatch each to its own module: `build/`, `verify.rs`,
//! `assets.rs`, `licenses.rs`, `dev_packs.rs`, `catalog.rs` and `fixtures/`.

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

/// `cargo test -p quran-desktop --lib export_bindings`, from the workspace root (bindings are exported only by
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
