//! The Windows backend end to end (`support/smtc.rs`): a hidden window owned by a blocked STA thread, the session
//! verified through the system's session manager, commands round-tripped to `on_command`, `Stopped` hiding it.
//! Registers a Paused session for about a second; plays nothing.
#![cfg(windows)]

#[path = "support/smtc.rs"]
mod smtc;

use media_session::BackendKind;

#[test]
fn the_smtc_session_is_visible_to_the_system_and_answers_its_commands() {
    let report = smtc::run();
    for step in &report.steps {
        match &step.result {
            Ok(detail) => eprintln!("ok    {}: {detail}", step.name),
            Err(problem) => eprintln!("FAIL  {}: {problem}", step.name),
        }
    }
    // Hosted CI runners may lack the media-session service; there the backend falls back to no-op by design. A
    // developer machine must pass the whole check.
    if report.backend == Some(BackendKind::Noop) && std::env::var_os("CI").is_some() {
        eprintln!("skipped: SMTC is unavailable on this CI runner (no-op fallback)");
        return;
    }
    assert!(
        report.passed(),
        "SMTC end-to-end check failed (see the steps above)"
    );
}
