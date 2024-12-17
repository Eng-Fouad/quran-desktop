package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.Button;
import javafx.scene.control.ComboBox;
import javafx.scene.layout.Pane;

import java.util.ResourceBundle;

/**
 * FX controller for recitation panel.
 *
 * @author Fouad Almalki
 */
@Singleton
public class RecitationPanelFxController extends FxControllerBase implements LanguageChangeAware {

    @FXML Pane paneIdle;
    @FXML Pane paneDownloading;
    @FXML Pane panePlaying;
    @FXML ComboBox<String> cbFromChapter;
    @FXML ComboBox<Integer> cbFromAyah;
    @FXML ComboBox<String> cbToChapter;
    @FXML ComboBox<Integer> cbToAyah;
    @FXML ComboBox<Integer> cbRecitationRepetition;
    @FXML ComboBox<Integer> cbEachAyahRepetition;
    @FXML ComboBox<String> cbReciter;
    @FXML Button btnPlaySelectedReciter;
    @FXML Button btnBackward;
    @FXML Button btnForward;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}