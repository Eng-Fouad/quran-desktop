//! Strings that originate in Rust, keyed by `settings.ui_language`.
//!
//! They are the few texts the webview cannot render: the tray menu and its "Now: {ref}" label, the tray tooltip and the
//! one-time "still running in the tray" notice, the media-session album, the fatal startup dialog, the close-to-tray
//! question and the dialog shown when the window's web engine keeps failing (`window::webview2`). Everything else lives
//! in the frontend dictionaries.
//!
//! Conventions shared with the frontend dictionaries: the app's name follows the UI language ([`RustText::AppName`] =
//! `common.appName`: "Quran" / "قرآن"), while the OS-level name (window title, taskbar, installer, media flyout) is the
//! bundle's `productName`, "Quran"; play/pause use the words of `common.play`/`common.pause`, and templates use
//! `{name}` placeholders that [`fill`] replaces. Surah names inside Rust strings come from `media::now_playing`, which
//! already picks `name_ar` and Arabic-Indic digits in the Arabic UI.

use quran_types::UiLanguage;

/// Every Rust-side UI string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RustText {
    /// Tray menu: bring the main window back.
    TrayShow,
    /// Tray menu: the transport item while nothing is loaded (shown disabled).
    TrayPlayPause,
    /// Tray menu: the transport item while a recitation is loaded and paused.
    TrayPlay,
    /// Tray menu: the transport item while a recitation is playing (or loading/buffering).
    TrayPause,
    TrayNext,
    TrayPrevious,
    TrayQuit,
    /// Template: replace `{ref}` with the localised ayah reference (`media::NowPlaying::title`).
    TrayNowPlaying,
    /// The one-time notice after the first hide to the tray while a recitation plays.
    TrayStillPlaying,
    /// The one-time notice after the first hide to the tray with nothing playing.
    TrayStillRunning,
    MediaAlbum,
    StartupErrorTitle,
    /// Template: replace `{detail}` with the error (see [`startup_error`]).
    StartupErrorBody,
    /// The fatal dialog's text when the library was saved by a newer version of the app (it is left untouched).
    StartupNewerLibrary,
    /// The close-to-tray question, shown as the dialog's main text.
    CloseToTrayTitle,
    /// What the two answers mean; shown under the question.
    CloseToTrayBody,
    CloseToTrayKeep,
    CloseToTrayQuit,
    /// Dismisses the question: the window stays open and the question comes back on the next close.
    CloseToTrayCancel,
    /// The app's name in the UI language (`common.appName`): the first line of the tray tooltip and the title of the
    /// tray notice and of the close-to-tray dialog.
    AppName,
    /// The window's page stopped working (`window::webview2`, Windows): the dialog's question.
    WindowFailedTitle,
    /// The page crashed again and again, so it is not reloaded once more by itself.
    WindowCrashLoopBody,
    /// The web engine itself (WebView2's browser process) ended: the window cannot be reloaded, only the app restarted.
    WindowEngineGoneBody,
    /// Reloads the window's page.
    WindowReload,
    /// Restarts the app.
    WindowRestart,
}

impl RustText {
    /// Every key, for completeness tests.
    pub const ALL: [Self; 25] = [
        Self::TrayShow,
        Self::TrayPlayPause,
        Self::TrayPlay,
        Self::TrayPause,
        Self::TrayNext,
        Self::TrayPrevious,
        Self::TrayQuit,
        Self::TrayNowPlaying,
        Self::TrayStillPlaying,
        Self::TrayStillRunning,
        Self::MediaAlbum,
        Self::StartupErrorTitle,
        Self::StartupErrorBody,
        Self::StartupNewerLibrary,
        Self::CloseToTrayTitle,
        Self::CloseToTrayBody,
        Self::CloseToTrayKeep,
        Self::CloseToTrayQuit,
        Self::CloseToTrayCancel,
        Self::AppName,
        Self::WindowFailedTitle,
        Self::WindowCrashLoopBody,
        Self::WindowEngineGoneBody,
        Self::WindowReload,
        Self::WindowRestart,
    ];

    /// The placeholders a template key must keep (and [`fill`] replaces); empty for plain strings.
    #[must_use]
    pub const fn placeholders(self) -> &'static [&'static str] {
        match self {
            Self::TrayNowPlaying => &["{ref}"],
            Self::StartupErrorBody => &["{detail}"],
            _ => &[],
        }
    }
}

/// The string for `key` in `lang`.
#[must_use]
pub const fn text(lang: UiLanguage, key: RustText) -> &'static str {
    match lang {
        UiLanguage::En => en(key),
        UiLanguage::Ar => ar(key),
    }
}

const fn en(key: RustText) -> &'static str {
    use RustText as T;
    match key {
        T::TrayShow => "Show Quran",
        T::TrayPlayPause => "Play / Pause",
        T::TrayPlay => "Play",
        T::TrayPause => "Pause",
        T::TrayNext => "Next ayah",
        T::TrayPrevious => "Previous ayah",
        T::TrayQuit => "Quit",
        T::TrayNowPlaying => "Now: {ref}",
        T::TrayStillPlaying => {
            "Quran is still playing in the tray. Click its icon to open the window again."
        }
        T::TrayStillRunning => {
            "Quran is still running in the tray. Click its icon to open the window again."
        }
        T::MediaAlbum => "The Holy Quran",
        T::StartupErrorTitle => "Quran could not start",
        T::StartupErrorBody => {
            "Quran could not start because of an error:\n\n{detail}\n\nReinstalling the app usually fixes this."
        }
        T::StartupNewerLibrary => {
            "Your library was saved by a newer version of Quran. Install the latest version to open it. \
             Nothing in your library was changed."
        }
        T::CloseToTrayTitle => "Keep reciting in the tray?",
        T::CloseToTrayBody => {
            "Quran can keep the recitation playing from its tray icon after you close the window. \
             You can change this later in Settings."
        }
        T::CloseToTrayKeep => "Keep playing in tray",
        T::CloseToTrayQuit => "Quit",
        T::CloseToTrayCancel => "Cancel",
        T::AppName => "Quran",
        T::WindowFailedTitle => "The window stopped working",
        T::WindowCrashLoopBody => {
            "Quran's window stopped working several times in a short while, so it was not reloaded again. \
             Your library is safe. Reload the window to try again, or quit Quran."
        }
        T::WindowEngineGoneBody => {
            "The component that draws Quran's window (Microsoft Edge WebView2) stopped. \
             Your library is safe. Restart Quran to continue."
        }
        T::WindowReload => "Reload",
        T::WindowRestart => "Restart",
    }
}

const fn ar(key: RustText) -> &'static str {
    use RustText as T;
    match key {
        T::TrayShow => "إظهار النافذة",
        T::TrayPlayPause => "تشغيل / إيقاف مؤقت",
        T::TrayPlay => "تشغيل",
        T::TrayPause => "إيقاف مؤقت",
        T::TrayNext => "الآية التالية",
        T::TrayPrevious => "الآية السابقة",
        T::TrayQuit => "خروج",
        T::TrayNowPlaying => "الآن: {ref}",
        T::TrayStillPlaying => {
            "ما زالت التلاوة مستمرة والتطبيق في علبة النظام. انقر أيقونته لإظهار النافذة من جديد."
        }
        T::TrayStillRunning => {
            "ما زال التطبيق يعمل في علبة النظام. انقر أيقونته لإظهار النافذة من جديد."
        }
        T::MediaAlbum => "القرآن الكريم",
        T::StartupErrorTitle => "تعذّر تشغيل التطبيق",
        T::StartupErrorBody => {
            "تعذّر تشغيل التطبيق بسبب خطأ:\n\n{detail}\n\nعادةً ما تحلّ إعادة تثبيت التطبيق هذه المشكلة."
        }
        T::StartupNewerLibrary => {
            "حُفظت مكتبتك بإصدار أحدث من التطبيق. ثبّت أحدث إصدار لفتحها. لم يتغيّر شيء في مكتبتك."
        }
        T::CloseToTrayTitle => "هل تريد متابعة التلاوة في علبة النظام؟",
        T::CloseToTrayBody => {
            "يمكن أن تستمر التلاوة بعد إغلاق النافذة، ويبقى التطبيق في علبة النظام. \
             يمكنك تغيير ذلك لاحقًا من الإعدادات."
        }
        T::CloseToTrayKeep => "متابعة التشغيل في علبة النظام",
        T::CloseToTrayQuit => "خروج",
        T::CloseToTrayCancel => "إلغاء",
        T::AppName => "قرآن",
        T::WindowFailedTitle => "توقفت النافذة عن العمل",
        T::WindowCrashLoopBody => {
            "توقفت نافذة التطبيق عن العمل عدة مرات في وقت قصير، فلم يُعَد تحميلها مرة أخرى. \
             مكتبتك سليمة. أعد تحميل النافذة للمحاولة من جديد، أو اخرج من التطبيق."
        }
        T::WindowEngineGoneBody => {
            "توقف المكوّن الذي يعرض نافذة التطبيق (Microsoft Edge WebView2). \
             مكتبتك سليمة. أعد تشغيل التطبيق للمتابعة."
        }
        T::WindowReload => "إعادة التحميل",
        T::WindowRestart => "إعادة التشغيل",
    }
}

/// `key` in `lang` with each `(placeholder, value)` pair substituted, e.g.
/// `fill(lang, RustText::TrayNowPlaying, &[("{ref}", "Al-Fatihah 1:2")])`.
#[must_use]
pub fn fill(lang: UiLanguage, key: RustText, values: &[(&str, &str)]) -> String {
    values
        .iter()
        .fold(text(lang, key).to_owned(), |acc, (placeholder, value)| {
            acc.replace(placeholder, value)
        })
}

/// Body of the fatal startup dialog with the developer-oriented `detail` embedded.
#[must_use]
pub fn startup_error(lang: UiLanguage, detail: &dyn std::fmt::Display) -> String {
    fill(
        lang,
        RustText::StartupErrorBody,
        &[("{detail}", &detail.to_string())],
    )
}

/// The tray's "Now: {ref}" label for a now-playing title (`media::NowPlaying::title`).
#[must_use]
pub fn now_playing(lang: UiLanguage, title: &str) -> String {
    fill(lang, RustText::TrayNowPlaying, &[("{ref}", title)])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    const LANGS: [UiLanguage; 2] = [UiLanguage::En, UiLanguage::Ar];

    /// Arabic letters (U+0600–U+06FF), the test for "really translated".
    fn has_arabic(s: &str) -> bool {
        s.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c))
    }

    #[test]
    fn every_key_has_text_in_both_languages() {
        for lang in LANGS {
            for key in RustText::ALL {
                let s = text(lang, key);
                assert!(!s.trim().is_empty(), "{lang:?} {key:?}");
                assert_eq!(s, s.trim(), "{lang:?} {key:?} has outer whitespace");
            }
        }
    }

    #[test]
    fn all_lists_every_key_once() {
        let mut seen = std::collections::HashSet::new();
        for key in RustText::ALL {
            assert!(seen.insert(key), "{key:?} twice");
        }
        assert_eq!(seen.len(), RustText::ALL.len());
    }

    #[test]
    fn arabic_is_translated_and_english_is_not_arabic() {
        for key in RustText::ALL {
            assert!(has_arabic(text(UiLanguage::Ar, key)), "ar {key:?}");
            assert!(!has_arabic(text(UiLanguage::En, key)), "en {key:?}");
        }
    }

    #[test]
    fn templates_keep_exactly_their_placeholders() {
        for lang in LANGS {
            for key in RustText::ALL {
                let s = text(lang, key);
                for placeholder in key.placeholders() {
                    assert_eq!(s.matches(placeholder).count(), 1, "{lang:?} {key:?}");
                }
                if key.placeholders().is_empty() {
                    assert!(!s.contains('{') && !s.contains('}'), "{lang:?} {key:?}");
                }
            }
        }
    }

    #[test]
    fn startup_error_embeds_the_detail() {
        let body = startup_error(UiLanguage::En, &"cannot create C:\\data: access denied");
        assert!(body.contains("cannot create C:\\data: access denied"));
        assert!(!body.contains("{detail}"));
        let ar = startup_error(UiLanguage::Ar, &"x: {detail}");
        assert!(
            ar.contains("x: {detail}"),
            "a placeholder inside the detail survives"
        );
        assert!(has_arabic(&ar));
    }

    /// The app's name is the frontend's `common.appName` in each language.
    #[test]
    fn the_app_name_is_the_frontend_one() {
        const EN: &str = include_str!("../../src/lib/i18n/en/common.ts");
        const AR: &str = include_str!("../../src/lib/i18n/ar/common.ts");
        for (lang, dictionary) in [(UiLanguage::En, EN), (UiLanguage::Ar, AR)] {
            let entry = format!("appName: '{}',", text(lang, RustText::AppName));
            assert!(dictionary.contains(&entry), "{lang:?}: {entry}");
        }
        assert_eq!(text(UiLanguage::En, RustText::AppName), "Quran");
    }

    #[test]
    fn now_playing_labels() {
        assert_eq!(
            now_playing(UiLanguage::En, "Al-Fatihah 1:2"),
            "Now: Al-Fatihah 1:2"
        );
        assert_eq!(
            now_playing(UiLanguage::Ar, "الفاتحة ١:٢"),
            "الآن: الفاتحة ١:٢"
        );
    }

    #[test]
    fn fill_replaces_every_pair_and_leaves_plain_strings_alone() {
        assert_eq!(
            fill(UiLanguage::En, RustText::TrayQuit, &[("{ref}", "x")]),
            "Quit"
        );
        assert_eq!(
            fill(UiLanguage::En, RustText::TrayNowPlaying, &[]),
            "Now: {ref}"
        );
    }

    #[test]
    fn os_dialog_and_tray_limits_hold() {
        // Windows balloon text: 255 UTF-16 units; tray menu items stay short enough for one line.
        for lang in LANGS {
            for key in [RustText::TrayStillPlaying, RustText::TrayStillRunning] {
                assert!(
                    text(lang, key).encode_utf16().count() < 256,
                    "{lang:?} {key:?}"
                );
            }
            for key in [
                RustText::TrayShow,
                RustText::TrayPlayPause,
                RustText::TrayPlay,
                RustText::TrayPause,
                RustText::TrayNext,
                RustText::TrayPrevious,
                RustText::TrayQuit,
                RustText::CloseToTrayKeep,
                RustText::CloseToTrayQuit,
                RustText::CloseToTrayCancel,
                RustText::WindowReload,
                RustText::WindowRestart,
            ] {
                assert!(text(lang, key).chars().count() <= 40, "{lang:?} {key:?}");
            }
        }
    }
}
