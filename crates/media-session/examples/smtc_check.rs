//! A runtime check of the Windows backend: `cargo run -p media-session --example smtc_check` prints every verified step
//! and then `SMTC ok`, or `SMTC FAILED` with exit code 1.
//!
//! It answers an open question: `ISystemMediaTransportControlsInterop::GetForWindow` called on the backend's MTA thread
//! for a hidden window owned by a blocked STA thread (the shape of `media::init` inside tauri's setup) works, so no
//! `run_on_main_thread` fallback is needed. It then checks the session end to end through the system's session manager
//! (`tests/support/smtc.rs`). It registers a media session for about a second, only ever **Paused**, and plays nothing;
//! the commands it sends reach only this process.

#[cfg(windows)]
#[path = "../tests/support/smtc.rs"]
mod smtc;

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    use std::process::ExitCode;

    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let report = smtc::run();
    for step in &report.steps {
        match &step.result {
            Ok(detail) => println!("  ok    {}: {detail}", step.name),
            Err(problem) => println!("  FAIL  {}: {problem}", step.name),
        }
    }
    let warnings = LOGGER.warnings();
    if warnings > 0 {
        println!("  FAIL  backend log: {warnings} warning(s) or error(s), see stderr");
    }
    if report.passed() && warnings == 0 {
        println!("SMTC ok");
        ExitCode::SUCCESS
    } else {
        println!("SMTC FAILED (backend: {:?})", report.backend);
        ExitCode::FAILURE
    }
}

#[cfg(not(windows))]
fn main() {
    println!("smtc_check: SMTC exists only on Windows; nothing to check here");
}

/// Prints the crate's log to stderr and counts warnings and errors (a healthy run logs none).
#[cfg(windows)]
struct CheckLogger {
    warnings: std::sync::atomic::AtomicUsize,
}

#[cfg(windows)]
impl CheckLogger {
    fn warnings(&self) -> usize {
        self.warnings.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(windows)]
impl log::Log for CheckLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if record.level() <= log::Level::Warn {
            self.warnings
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        eprintln!(
            "  [{} {}] {}",
            record.level(),
            record.target(),
            record.args()
        );
    }

    fn flush(&self) {}
}

#[cfg(windows)]
static LOGGER: CheckLogger = CheckLogger {
    warnings: std::sync::atomic::AtomicUsize::new(0),
};
