package com.quran.labs.desktop.core.ui;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.fx.MountableFxController;
import io.quarkiverse.fx.views.FxViewRepository;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.layout.BorderPane;

import java.util.ResourceBundle;

/**
 * FX controller for the body region. Its content can be changed dynamically depending on the UI flow.
 *
 * @author Fouad Almalki
 */
@Singleton
public class BodyFxController extends FxControllerBase implements LanguageChangeAware {

    @Inject FxViewRepository fxViewRepository;

    @FXML BorderPane bodyPane;

    MountableFxController mountedPaneController;

    public void attachView(String viewName) {
        if (mountedPaneController != null) {
            mountedPaneController.onDismount();
        }

        var viewData = fxViewRepository.getViewData(viewName);
        mountedPaneController = viewData.getController();
        mountedPaneController.onMount();
        bodyPane.setCenter(viewData.getRootNode());
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        if (mountedPaneController instanceof LanguageChangeAware l) {
            l.onLanguageChanged(language);
        }
    }
}