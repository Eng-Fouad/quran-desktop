package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.Tab;
import javafx.scene.control.TitledPane;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
@RegisterForReflection
public class HomeFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @Inject ActionBarFxController actionBarFxController;
    @Inject BookmarksListFxController bookmarksListFxController;
    @Inject HizbListFxController hizbListFxController;
    @Inject ReadingToolbarFxController readingToolbarFxController;
    @Inject ReadingViewFxController readingViewFxController;
    @Inject RecitationPanelFxController recitationPanelFxController;
    @Inject SuraListFxController suraListFxController;
    @Inject TranslationsViewFxController translationsViewFxController;

    @FXML TitledPane paneRecitation;
    @FXML Tab tabSuras;
    @FXML Tab tabHizbs;
    @FXML Tab tabBookmarks;
    @FXML Tab tabReading;
    @FXML Tab tabTranslations;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        paneRecitation.setText(resources.getString("label.recitation"));
        tabSuras.setText(resources.getString("label.suras"));
        tabHizbs.setText(resources.getString("label.hizbs"));
        tabBookmarks.setText(resources.getString("label.bookmarks"));
        tabReading.setText(resources.getString("label.reading"));
        tabTranslations.setText(resources.getString("label.translations"));
    }

    @Override
    public void onShowing() {
        actionBarFxController.onShowing();
        bookmarksListFxController.onShowing();
        hizbListFxController.onShowing();
        readingToolbarFxController.onShowing();
        readingViewFxController.onShowing();
        recitationPanelFxController.onShowing();
        suraListFxController.onShowing();
        translationsViewFxController.onShowing();
    }
}