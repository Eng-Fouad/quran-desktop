//! `cargo xtask build-core`: core.db from a source (docs/ARCHITECTURE.md §4.1–§4.4). Owner: WP3a (`qul.rs`: WP3d).
//!
//! `model.rs` is the adapter-neutral intermediate `SourceQuran`; the `qdc`/`qul` adapters (plus `tanzil`) fill it,
//! `derive.rs` applies the shared derivation rules and `write.rs` writes a deterministic DB (`quran_core::CORE_SQL`
//! plus the §3.1.1 finalisation) to `<out>.tmp`, runs `crate::verify::verify_db_with` against the Tanzil file the
//! build used, and renames it on success.
//!
//! Inputs besides the adapter's: `xtask/data/qcf_surah_header_cmap.json` (`surah.header_cp`, §3.1.2) and
//! `xtask/data/division_exceptions.toml` (the D6 rub allowlist). `built_at` is `SOURCE_DATE_EPOCH` when set, so two
//! builds from the same cache with the same epoch are byte-identical.
//!
//! For `verify-core` (WP3b): [`tanzil::Tanzil`] parses and validates Tanzil `quran-data.xml` (including the V1 page
//! starts of G10), [`derive::DivisionExceptions`] reads the allowlist and [`derive::HeaderMap`] the header map, so the
//! gates can use the same inputs as the build.

pub mod derive;
pub mod model;
pub mod qdc;
mod qul;
pub mod tanzil;
pub mod write;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use self::derive::{DeriveReport, DivisionExceptions, HeaderMap};
use self::model::{SourceQuran, mushaf_spec};
use self::tanzil::Tanzil;
use self::write::BuildMeta;
use crate::cli::{BuildCoreArgs, Source};

/// `xtask/data/`.
#[must_use]
pub fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("data")
}

pub fn run(args: &BuildCoreArgs) -> anyhow::Result<()> {
    let started = Instant::now();
    let out = args.out();
    let cache = args.cache();
    let built_at = built_at()?;
    let (source, tanzil_path) = match args.source {
        Source::Qdc => {
            eprintln!(
                "build-core: source {} (development only: QF Developer Terms, never distribute the result)",
                args.source.as_str()
            );
            let phase = Instant::now();
            let prepared = qdc::prepare(&cache, &qdc::Endpoints::live(), args.offline, args.jobs)?;
            eprintln!(
                "build-core: cache {}: {} file(s) reused, {} fetched (missing), {} refetched (older than 7 days), {} \
                 refetched (not in the current request shape) [{:.1} s]",
                cache.display(),
                prepared.cached,
                prepared.fetched_missing,
                prepared.refetched_stale,
                prepared.refetched_invalid,
                phase.elapsed().as_secs_f64()
            );
            let phase = Instant::now();
            let (source, report) = qdc::load(&cache)?;
            eprintln!(
                "build-core: read {} QDC files [{:.1} s]; report only (D6, never stored): QDC numbers {} rukus, and \
                 gives a sajdah_number to {} ayahs",
                report.files,
                phase.elapsed().as_secs_f64(),
                report.rukus,
                report.sajdah_ayahs.len()
            );
            (source, qdc::tanzil_path(&cache))
        }
        Source::Qul => {
            // `--cache`, `--offline` and `--jobs` do not apply: QUL inputs are placed by a human (data/sources/README.md).
            eprintln!(
                "build-core: source qul (release-grade; distribution needs the permission recorded in \
                 data/sources/README.md)"
            );
            qul::load(
                &crate::cli::workspace_root()
                    .join("data")
                    .join("sources")
                    .join("qul"),
            )?
        }
    };
    build(&source, &tanzil_path, &out, built_at)?;
    eprintln!(
        "build-core: done in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// `SOURCE_DATE_EPOCH` (Unix seconds) when set, else now; RFC 3339 UTC with whole seconds.
fn built_at() -> anyhow::Result<String> {
    built_at_from(std::env::var("SOURCE_DATE_EPOCH"))
}

fn built_at_from(epoch: Result<String, std::env::VarError>) -> anyhow::Result<String> {
    let at = match epoch {
        Ok(value) => {
            let seconds: i64 = value.trim().parse().with_context(|| {
                format!("SOURCE_DATE_EPOCH={value:?} is not a number of seconds")
            })?;
            OffsetDateTime::from_unix_timestamp(seconds)
                .with_context(|| format!("SOURCE_DATE_EPOCH={seconds}"))?
        }
        Err(std::env::VarError::NotPresent) => OffsetDateTime::now_utc()
            .replace_nanosecond(0)
            .context("truncate the clock to seconds")?,
        Err(std::env::VarError::NotUnicode(_)) => bail!("SOURCE_DATE_EPOCH is not valid Unicode"),
    };
    at.format(&Rfc3339).context("format built_at")
}

/// The shared pipeline after an adapter: Tanzil + data files → derive → `<out>.tmp` → verify → rename.
fn build(
    source: &SourceQuran,
    tanzil_path: &Path,
    out: &Path,
    built_at: String,
) -> anyhow::Result<()> {
    let tanzil = Tanzil::load(tanzil_path)?;
    let headers = HeaderMap::load(&data_dir().join("qcf_surah_header_cmap.json"))?;
    let exceptions = DivisionExceptions::load(&data_dir().join("division_exceptions.toml"))?;
    let phase = Instant::now();
    let data = derive::derive(source, &tanzil, headers.as_ref(), &exceptions)?;
    eprintln!(
        "build-core: derived the rows [{:.1} s]",
        phase.elapsed().as_secs_f64()
    );
    print_report(&data.report);

    if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let tmp = tmp_path(out);
    remove_if_present(&tmp)?;
    let meta = BuildMeta {
        source: source.info.source.to_owned(),
        source_manifest_sha256: source.info.manifest_sha256.clone(),
        tanzil_sha256: tanzil.sha256.clone(),
        built_at,
        builder: concat!("xtask ", env!("CARGO_PKG_VERSION")).to_owned(),
        licence_note: source.info.licence_note.clone(),
    };
    let phase = Instant::now();
    let stats = match write::write(&tmp, &data, &meta) {
        Ok(stats) => stats,
        Err(e) => {
            // A half-written database is useless; leave nothing behind.
            if let Err(cleanup) = remove_if_present(&tmp) {
                eprintln!("build-core: {cleanup:#}");
            }
            return Err(e.context(format!("write {}", tmp.display())));
        }
    };
    eprintln!(
        "build-core: wrote {} ({} KiB, {} FTS rows, {} vocab_loose terms, built_at {}) [{:.1} s]",
        tmp.display(),
        stats.bytes / 1024,
        stats.fts_rows,
        stats.vocab_terms,
        meta.built_at,
        phase.elapsed().as_secs_f64()
    );
    let phase = Instant::now();
    // The Tanzil file this build used, so a build with its own `--cache` is verified against the right copy.
    crate::verify::verify_db_with(&tmp, None, Some(tanzil_path)).with_context(|| {
        format!(
            "verify-core failed; the database is left at {} for inspection",
            tmp.display()
        )
    })?;
    eprintln!(
        "build-core: verify-core [{:.1} s]",
        phase.elapsed().as_secs_f64()
    );
    std::fs::rename(&tmp, out).with_context(|| {
        format!(
            "rename {} to {} (is the app or a test holding core.db open?)",
            tmp.display(),
            out.display()
        )
    })?;
    let bytes = std::fs::read(out).with_context(|| format!("read {}", out.display()))?;
    eprintln!(
        "build-core: {} sha256 {} ({} bytes)",
        out.display(),
        hex::encode(Sha256::digest(&bytes)),
        bytes.len()
    );
    Ok(())
}

/// `<out>.tmp` (appended, so `core.db` → `core.db.tmp`).
fn tmp_path(out: &Path) -> PathBuf {
    let mut tmp = out.as_os_str().to_owned();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

fn remove_if_present(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("remove {}", path.display())),
    }
}

fn print_report(report: &DeriveReport) {
    let locations = |list: &[model::Location]| {
        list.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(" ")
    };
    for line in &report.division_checks {
        eprintln!("build-core: divisions: {line}");
    }
    eprintln!("build-core: divisions: ruku and sajda from Tanzil only (D6)");
    for note in &report.surah_notes {
        eprintln!("build-core: note: {note}");
    }
    if !report.end_markers_relabelled.is_empty() {
        eprintln!(
            "build-core: source fix: end marker(s) labelled as words in the source, relabelled: {}",
            locations(&report.end_markers_relabelled)
        );
    }
    if report.v1_regrouped {
        eprintln!(
            "build-core: source fix: regrouped code_v1 of 38:24:32–33 to the canonical D5 grouping"
        );
    }
    eprintln!(
        "build-core: glyph codes: {} V1 / {} V2 multi-char words (FACT C5: 4,580 / 4,517); {} / {} contain U+0020 \
         (۞ before a rub-start word)",
        report.multi_char_v1,
        report.multi_char_v2,
        report.space_in_code_v1,
        report.space_in_code_v2
    );
    eprintln!(
        "build-core: text_hafs spaces: {} before ۩ ({}), {} after ۞, {} between letters ({})",
        report.space_before_sajda.len(),
        locations(&report.space_before_sajda),
        report.space_after_rub_sign,
        report.space_between_letters.len(),
        locations(&report.space_between_letters)
    );
    eprintln!(
        "build-core: inline rub sign: {} rub start(s) open with \"۞ \" (kept as printed; all at rub starts)",
        report.inline_rub_signs
    );
    if report.header_map_missing {
        eprintln!(
            "build-core: warning: xtask/data/qcf_surah_header_cmap.json is missing; surah.header_cp is NULL"
        );
    }
    for layout in &report.layouts {
        let code = quran_types::MushafLayout::from_db_id(layout.mushaf_id)
            .map_or("?", |l| mushaf_spec(l).code);
        eprintln!(
            "build-core: layout {code} (mushaf {}): {} ayah lines ({} centred), {} surah_name, {} basmallah; \
             surah_name on the previous page for {} surah(s){}{}{}",
            layout.mushaf_id,
            layout.ayah_lines,
            layout.centred_ayah_lines,
            layout.surah_name_lines,
            layout.basmallah_lines,
            layout.surah_name_on_previous_page.len(),
            if layout.surah_name_on_previous_page.is_empty() {
                String::new()
            } else {
                format!(
                    " ({})",
                    layout
                        .surah_name_on_previous_page
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            },
            if layout.pages_not_starting_an_ayah.is_empty() {
                String::new()
            } else {
                format!(
                    "; WARNING: pages not starting an ayah: {:?}",
                    layout.pages_not_starting_an_ayah
                )
            },
            layout
                .tanzil_page_starts_matched
                .map(|n| format!("; page starts equal Tanzil's on {n}/604 pages"))
                .unwrap_or_default()
        );
    }
}

#[cfg(test)]
mod tests {
    use std::env::VarError;

    use super::*;

    #[test]
    fn built_at_follows_source_date_epoch() -> anyhow::Result<()> {
        assert_eq!(
            built_at_from(Ok("1791590400".into()))?,
            "2026-10-10T00:00:00Z"
        );
        assert_eq!(built_at_from(Ok(" 0\n".into()))?, "1970-01-01T00:00:00Z");
        assert!(built_at_from(Ok("yesterday".into())).is_err());
        assert!(built_at_from(Ok("1.5".into())).is_err());
        let now = built_at_from(Err(VarError::NotPresent))?;
        assert!(
            now.ends_with('Z') && !now.contains('.'),
            "{now}: whole seconds, UTC"
        );
        assert!(OffsetDateTime::parse(&now, &Rfc3339).is_ok());
        Ok(())
    }

    #[test]
    fn the_temp_file_sits_next_to_the_output() {
        assert_eq!(
            tmp_path(Path::new("src-tauri/resources/core.db")),
            Path::new("src-tauri/resources/core.db.tmp")
        );
        assert!(data_dir().join("division_exceptions.toml").is_file());
        assert!(data_dir().join("qcf_surah_header_cmap.json").is_file());
    }
}
