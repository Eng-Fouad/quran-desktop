package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.ListView;

import java.util.ResourceBundle;

/**
 * FX controller for Chapters list.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ChaptersListFxController extends FxControllerBase implements LanguageChangeAware {

    @FXML ListView<?> lvChaptersList;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}