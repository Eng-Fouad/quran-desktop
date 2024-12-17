package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.layout.Pane;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class HomeFxController extends FxControllerBase implements LanguageChangeAware {

    @FXML Pane sideBarPane;
    @FXML Pane chatViewPane;

    @Override
    protected void initialize() {

    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}