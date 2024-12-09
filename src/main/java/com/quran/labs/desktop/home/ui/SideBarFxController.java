package com.quran.labs.desktop.home.ui;

import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.layout.Pane;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.fx.MountableFxController;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class SideBarFxController extends FxControllerBase implements MountableFxController, LanguageChangeAware {

    @FXML Pane actionBarPane;
    @FXML Pane navigationListPane;

    @FXML ActionBarFxController actionBarPaneController;
    @FXML ChatListFxController navigationListPaneController;

    @Override
    public void onMount() {
        actionBarPaneController.onMount();
        navigationListPaneController.onMount();
    }

    @Override
    public void onDismount() {
        actionBarPaneController.onDismount();
        navigationListPaneController.onDismount();
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        actionBarPaneController.onLanguageChanged(language);
        navigationListPaneController.onLanguageChanged(language);
    }
}