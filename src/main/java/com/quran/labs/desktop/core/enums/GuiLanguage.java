package com.quran.labs.desktop.core.enums;

import javafx.geometry.NodeOrientation;
import com.quran.labs.desktop.core.utils.AppConstants;

import java.util.Locale;

/**
 * Represents the supported GUI languages for the application.
 *
 * @author Fouad Almalki
 */
public enum GuiLanguage {

    ARABIC(AppConstants.Locales.AR_LOCALE, NodeOrientation.RIGHT_TO_LEFT, "عربي"),
    ENGLISH(AppConstants.Locales.EN_LOCALE, NodeOrientation.LEFT_TO_RIGHT, "English");

    private final Locale locale;
    private final NodeOrientation nodeOrientation;
    private final String text;

    GuiLanguage(Locale locale, NodeOrientation nodeOrientation, String text) {
        this.locale = locale;
        this.nodeOrientation = nodeOrientation;
        this.text = text;
    }

    public final Locale getLocale(){return locale;}
    public final NodeOrientation getNodeOrientation(){return nodeOrientation;}

    @Override
    public String toString() {
        return text;
    }
}