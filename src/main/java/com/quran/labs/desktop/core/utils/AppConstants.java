package com.quran.labs.desktop.core.utils;

import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;

import java.util.Locale;

/// Defines application-wide constants for use throughout the application.
///
/// @author Fouad Almalki
public interface AppConstants {
    interface Locales {
        Locale AR_LOCALE = new Locale.Builder()
                                     .setLanguage("ar")
                                     .setExtension('u', "nu-arab") // nu is for numbers
                                     .build();
        Locale EN_LOCALE = Locale.ENGLISH;
    }

    Class<?> PREF_NODE_CLASS = AppConstants.class;
    String UI_LANGUAGE_PREF_NAME = "com.quran.labs.desktop.ui.language";

    KeyCombination SCENIC_VIEW_KEY_COMBINATION = new KeyCodeCombination(KeyCode.D,
                                                                        KeyCombination.CONTROL_DOWN,
                                                                        KeyCombination.SHIFT_DOWN,
                                                                        KeyCombination.ALT_DOWN);
}