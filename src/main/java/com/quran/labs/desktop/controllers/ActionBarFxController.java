package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.ui.GuiFactory;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.Button;
import javafx.scene.control.MenuButton;

import java.util.ResourceBundle;

/**
 * FX controller for the action bar pane.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ActionBarFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @Inject GuiFactory guiFactory;

    @FXML MenuButton mbLanguage;
    @FXML Button btnSearch;
    @FXML Button btnSettings;

    @Override
    protected void initialize() {
        guiFactory.initLanguageButton(mbLanguage);
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}