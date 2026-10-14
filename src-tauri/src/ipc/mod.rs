//! Typed IPC registration.
//!
//! [`specta_builder`] is the single list of typed commands and events. `lib.rs` turns it into the invoke handler and
//! mounts its events; the `export_bindings` test writes `src/lib/ipc/bindings.ts` from it (bindings are never exported
//! at app start). Regenerate with `pnpm bindings` (= `cargo test -p quran-desktop --lib export_bindings`).
//!
//! `protocol::font_bytes` is deliberately absent: it returns raw bytes and is dispatched by name in `lib.rs`.

pub mod events;

use tauri_specta::{collect_commands, collect_events};

use crate::commands::{
    app, audio, content, mushaf, packs, quran, search, settings, system, user_library, user_study,
};

/// Path of the generated bindings, relative to this crate's manifest directory.
pub const BINDINGS_PATH: &str = "../src/lib/ipc/bindings.ts";

/// Every typed command (all but `font_bytes`) and every event.
#[must_use]
pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            // app and window
            app::app_bootstrap,
            app::window_ready,
            app::window_set_chrome,
            app::window_set_caption,
            app::app_quit,
            system::system_open_external,
            system::system_reveal_data_dir,
            // mushaf and text
            mushaf::mushaf_get_pages,
            quran::quran_get_ayahs,
            quran::quran_copy_text,
            // search
            search::search_query,
            search::search_suggest,
            // content
            content::translation_get,
            content::tafsir_get,
            content::wbw_get_range,
            // packs and fonts
            packs::packs_list,
            packs::packs_subscribe,
            packs::packs_install,
            packs::packs_pause,
            packs::packs_resume,
            packs::packs_cancel,
            packs::packs_remove,
            packs::packs_items,
            packs::packs_remove_items,
            packs::packs_disk_usage,
            packs::packs_check_updates,
            packs::packs_clear_stream_cache,
            packs::cache_clear,
            packs::mushaf_ensure_page_fonts,
            packs::decor_ensure,
            // audio
            audio::audio_subscribe,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_resume,
            audio::audio_toggle,
            audio::audio_stop,
            audio::audio_skip,
            audio::audio_seek,
            audio::audio_set_speed,
            audio::audio_set_volume,
            audio::audio_set_repeat,
            audio::audio_set_gap,
            audio::audio_set_ab_loop,
            audio::audio_get_snapshot,
            audio::audio_get_timings,
            audio::audio_list_reciters,
            // user library
            user_library::bookmark_list,
            user_library::bookmark_upsert,
            user_library::bookmark_toggle_ayah,
            user_library::bookmark_delete,
            user_library::bookmark_restore,
            user_library::reading_bookmark_set,
            user_library::reading_bookmark_clear,
            user_library::highlight_list,
            user_library::highlight_set,
            user_library::highlight_delete,
            user_library::highlight_restore,
            user_library::highlight_clear_range,
            user_library::note_list,
            user_library::note_get,
            user_library::note_upsert,
            user_library::note_delete,
            user_library::note_restore,
            user_library::collection_list,
            user_library::collection_upsert,
            user_library::collection_delete,
            user_library::collection_set_membership,
            user_library::tag_list,
            user_library::tag_upsert,
            user_library::tag_delete,
            user_library::item_tags_set,
            user_library::user_marks,
            // user study data
            user_study::position_set,
            user_study::history_record,
            user_study::history_list,
            user_study::history_clear,
            user_study::search_history_add,
            user_study::search_history_list,
            user_study::search_history_clear,
            user_study::memo_progress,
            user_study::memo_set_status,
            user_study::memo_review,
            user_study::memo_test_start,
            user_study::memo_test_finish,
            user_study::loop_preset_list,
            user_study::loop_preset_upsert,
            user_study::loop_preset_delete,
            user_study::user_backup_create,
            user_study::user_backup_restore,
            // settings
            settings::settings_get,
            settings::settings_set,
            settings::settings_reset,
        ])
        .events(collect_events![
            events::AudioStateChanged,
            events::AudioAyahChanged,
            events::PacksChanged,
            events::SettingsChanged,
            events::UserDataChanged,
            events::NavigateRequested,
            events::NetworkChanged,
            events::QuitRequested,
            events::SettingsRequested,
        ])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use std::path::PathBuf;

    use super::*;

    fn bindings_file() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BINDINGS_PATH)
    }

    fn render() -> String {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("bindings.ts");
        specta_builder()
            .export(specta_typescript::Typescript::default(), &file)
            .expect("export TS bindings");
        std::fs::read_to_string(file).unwrap()
    }

    /// Writes `src/lib/ipc/bindings.ts`. `pnpm bindings:check` re-runs it and fails on any diff. The file is only
    /// rewritten when its content changes, so an unchanged contract never triggers a Vite reload.
    #[test]
    fn export_bindings() {
        let fresh = render();
        let target = bindings_file();
        if std::fs::read_to_string(&target).ok().as_deref() != Some(fresh.as_str()) {
            std::fs::create_dir_all(target.parent().expect("bindings path has a parent"))
                .expect("create src/lib/ipc");
            std::fs::write(&target, fresh).expect("write src/lib/ipc/bindings.ts");
        }
    }

    /// The generated contract has the full surface (92 typed commands, every one returning the `AppError` result type),
    /// the 9 events below, and no raw `font_bytes`. Rendered into a temp dir so it never races the export.
    #[test]
    fn bindings_cover_the_contract() {
        let ts = render();
        let commands = ts.matches("__TAURI_INVOKE(\"").count();
        assert_eq!(
            commands, 92,
            "typed command count changed: update this test"
        );
        assert_eq!(
            ts.matches(", AppError>(__TAURI_INVOKE(").count(),
            92,
            "every command must return Result<_, AppError>"
        );
        for event in [
            "audio-state-changed",
            "audio-ayah-changed",
            "packs-changed",
            "settings-changed",
            "user-data-changed",
            "navigate-requested",
            "network-changed",
            "quit-requested",
            "settings-requested",
        ] {
            assert!(
                ts.contains(&format!("(\"{event}\")")),
                "event {event} missing"
            );
        }
        assert!(
            !ts.contains("\"font_bytes\""),
            "font_bytes must stay out of bindings.ts (raw bytes)"
        );
        assert!(!ts.contains("bigint"), "DTOs must use u32/i32 only");
    }
}
