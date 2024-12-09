package com.quran.labs.desktop.home.ui;

import io.quarkiverse.fx.views.FxView;
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
@FxView(HomeFxController.VIEW_NAME)
@Singleton
public class HomeFxController extends FxControllerBase implements MountableFxController, LanguageChangeAware {

    public static final String VIEW_NAME = "home";

    @FXML Pane sideBarPane;
    @FXML Pane chatViewPane;
    @FXML SideBarFxController sideBarPaneController;
    @FXML ChatViewFxController chatViewPaneController;

    @Override
    protected void initialize() {

    }

    @Override
    public void onMount() {
        sideBarPaneController.onMount();
        chatViewPaneController.onMount();
    }

    @Override
    public void onDismount() {
        sideBarPaneController.onDismount();
        chatViewPaneController.onDismount();
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        sideBarPaneController.onLanguageChanged(language);
        chatViewPaneController.onLanguageChanged(language);
    }
}