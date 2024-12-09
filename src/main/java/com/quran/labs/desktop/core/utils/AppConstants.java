package com.quran.labs.desktop.core.utils;

import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;

import java.time.ZoneId;
import java.util.Locale;

/**
 * Defines application-wide constants for use throughout the application.
 *
 * @author Fouad Almalki
 */
public interface AppConstants {
    interface Locales {
        Locale SAUDI_AR_LOCALE = new Locale.Builder()
                                           .setLanguage("ar")
                                           .setRegion("SA")
                                           .setExtension('u', "nu-arab") // nu is for numbers
                                           .build();
        Locale SAUDI_EN_LOCALE = Locale.of("en", "SA");
    }

    // lowest resolution we support is 1024x768, subtract from that the windows task bar 40px
    double STAGE_WIDTH = 1024.0;
    double STAGE_HEIGHT = 768.0 - 40.0;

    ZoneId SAUDI_TIMEZONE = ZoneId.of("Asia/Riyadh");
    Class<?> PREF_NODE_CLASS = AppConstants.class;
    String UI_LANGUAGE_PREF_NAME = "com.quran.labs.desktop.ui.language";

    KeyCombination SCENIC_VIEW_KEY_COMBINATION = new KeyCodeCombination(KeyCode.D,
                                                                        KeyCombination.CONTROL_DOWN,
                                                                        KeyCombination.SHIFT_DOWN,
                                                                        KeyCombination.ALT_DOWN);
}