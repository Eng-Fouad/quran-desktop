package com.quran.labs.desktop.core.utils;

import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;

import java.nio.file.Path;
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

    String APP_NAME = "quran-desktop";
    Path PATH_APP_ROOT_DIR = Path.of(System.getProperty("user.home"), APP_NAME);
    Path PATH_PAGES_DIR = PATH_APP_ROOT_DIR.resolve("data/madani/width_1920");
    Path PATH_DB_DIR = PATH_APP_ROOT_DIR.resolve("data/madani/databases");
    Path PATH_MADANI_AYAH_INFO_DB_FILE = PATH_DB_DIR.resolve("ayahinfo_1920.db");
    Path PATH_MADANI_QURAN_DB_FILE = PATH_DB_DIR.resolve("quran.ar.uthmani.v2.db");
    int MADANI_PAGES_VERSION = 8;

    Class<?> PREF_NODE_CLASS = AppConstants.class;
    String PREF_UI_LANGUAGE = "com.quran.labs.desktop.ui.language";

    KeyCombination SCENIC_VIEW_KEY_COMBINATION = new KeyCodeCombination(KeyCode.D,
                                                                        KeyCombination.CONTROL_DOWN,
                                                                        KeyCombination.SHIFT_DOWN,
                                                                        KeyCombination.ALT_DOWN);
}