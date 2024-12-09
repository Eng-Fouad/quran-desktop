package com.quran.labs.desktop.core.fx;

import com.quran.labs.desktop.core.enums.GuiLanguage;

/**
 * An interface that should be implemented by classes that need to respond
 * to changes in the application's language settings.
 *
 * @author Fouad Almalki
 */
public interface LanguageChangeAware {
    /**
     * Invoked when the application's GUI language changes.
     *
     * @param language the new {@link GuiLanguage} that has been selected,
     *                 representing the updated language.
     */
    void onLanguageChanged(GuiLanguage language);
}