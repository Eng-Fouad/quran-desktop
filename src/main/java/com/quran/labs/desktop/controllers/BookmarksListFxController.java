package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.ListView;

import java.util.ResourceBundle;

/**
 * FX controller for bookmarks list.
 *
 * @author Fouad Almalki
 */
@Singleton
public class BookmarksListFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @FXML ListView<?> lvBookmarksList;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}