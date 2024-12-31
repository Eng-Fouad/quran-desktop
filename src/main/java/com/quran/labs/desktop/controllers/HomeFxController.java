package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.Tab;
import javafx.scene.control.TitledPane;
import javafx.scene.layout.Pane;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class HomeFxController extends FxControllerBase implements LanguageChangeAware {

    @FXML TitledPane paneRecitation;
    @FXML Tab tabChapterList;
    @FXML Tab tabBookmarks;
    @FXML Tab tabReading;
    @FXML Tab tabTranslations;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        paneRecitation.setText(resources.getString("label.recitation"));
        tabChapterList.setText(resources.getString("label.chaptersList"));
        tabBookmarks.setText(resources.getString("label.bookmarks"));
        tabReading.setText(resources.getString("label.reading"));
        tabTranslations.setText(resources.getString("label.translations"));
    }
}