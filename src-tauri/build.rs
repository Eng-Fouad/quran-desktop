//! Build script: makes a fresh checkout compile, then runs `tauri_build`.
//!
//! `tauri-build` copies every `bundle.resources` entry and fails with `ResourcePathNotFound` when one is missing.
//! `resources/core.db` is generated (`pnpm core:qdc`) and gitignored, and `resources/catalog.json` is curated, so both
//! get placeholders here. A 0-byte core.db opens as `SchemaMismatch { found: 0 }`: debug builds degrade to the "Core
//! data missing (dev build)" screen and release builds show the fatal dialog. CI and release builds set
//! `QD_REQUIRE_CORE=1`, which turns a missing core.db into a build error, so a placeholder can never ship.

use std::fs;
use std::path::{Path, PathBuf};

const CORE_DB: &str = "resources/core.db";
const CATALOG: &str = "resources/catalog.json";
const EMPTY_CATALOG: &[u8] = br#"{"catalogVersion":1,"generatedAt":"1970-01-01","packs":[]}"#;

/// tauri-build's default application manifest: Common Controls v6, required by the dialog plugin (`TaskDialogIndirect`).
const APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    println!("cargo:rerun-if-env-changed=QD_REQUIRE_CORE");
    println!("cargo:rerun-if-changed={CORE_DB}");
    println!("cargo:rerun-if-changed={CATALOG}");

    ensure_placeholders();

    let attributes = tauri_build::Attributes::new().windows_attributes(windows_attributes());
    if let Err(e) = tauri_build::try_build(attributes) {
        // Same contract as `tauri_build::build()`: print the error and fail the build.
        println!("{e:#}");
        std::process::exit(1);
    }
}

fn ensure_placeholders() {
    if let Err(e) = fs::create_dir_all("resources") {
        println!("cargo:warning=cannot create src-tauri/resources: {e}");
    }

    if !Path::new(CORE_DB).exists() {
        if std::env::var("QD_REQUIRE_CORE").as_deref() == Ok("1") {
            panic!(
                "resources/core.db missing and QD_REQUIRE_CORE=1: run `pnpm core:qdc` or `pnpm core:qul`"
            );
        }
        match fs::write(CORE_DB, b"") {
            Ok(()) => println!(
                "cargo:warning=core.db placeholder created; run `pnpm core:qdc` (cargo xtask build-core --source qdc)"
            ),
            Err(e) => println!("cargo:warning=cannot write the core.db placeholder: {e}"),
        }
    }

    if !Path::new(CATALOG).exists()
        && let Err(e) = fs::write(CATALOG, EMPTY_CATALOG)
    {
        println!("cargo:warning=cannot write the catalog.json placeholder: {e}");
    }
}

/// On MSVC the manifest is embedded by the linker for EVERY linked target of this package, not only for the binary
/// (tauri-build links its resource file into binaries only). Without it the unit-test executable cannot resolve
/// comctl32 v6 entry points and dies with `STATUS_ENTRYPOINT_NOT_FOUND` before running a single test.
fn windows_attributes() -> tauri_build::WindowsAttributes {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return tauri_build::WindowsAttributes::new();
    }
    let Some(out_dir) = std::env::var_os("OUT_DIR").map(PathBuf::from) else {
        return tauri_build::WindowsAttributes::new();
    };
    let manifest = out_dir.join("quran-desktop.manifest");
    if let Err(e) = fs::write(&manifest, APP_MANIFEST) {
        println!(
            "cargo:warning=cannot write the app manifest ({e}); tests may fail with STATUS_ENTRYPOINT_NOT_FOUND"
        );
        return tauri_build::WindowsAttributes::new();
    }
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    tauri_build::WindowsAttributes::new_without_app_manifest()
}
