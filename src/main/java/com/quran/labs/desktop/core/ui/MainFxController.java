package com.quran.labs.desktop.core.ui;

import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.utils.AppConstants;
import io.quarkiverse.fx.views.FxView;
import io.quarkiverse.fx.views.FxViewRepository;
import io.quarkus.logging.Log;
import io.quarkus.runtime.LaunchMode;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.application.Platform;
import javafx.fxml.FXML;
import javafx.scene.Scene;
import javafx.scene.image.Image;
import javafx.scene.input.KeyEvent;
import javafx.scene.layout.Pane;
import javafx.stage.Stage;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.scenicview.ScenicView;

import java.util.Locale;
import java.util.ResourceBundle;
import java.util.prefs.Preferences;

/**
 * FX controller of the primary stage, i.e. controller of the main application GUI.
 *
 * @author Fouad Almalki
 */
@FxView(MainFxController.VIEW_NAME)
@Singleton
public class MainFxController extends FxControllerBase implements LanguageChangeAware {

    public static final String VIEW_NAME = "main";

    @ConfigProperty(name = "quarkus.application.version")
    String appVersion;

    @Inject GuiFactory guiFactory;
    @Inject FxViewRepository fxViewRepository;
    @Inject GuiStateManager guiStateManager;

    @FXML Pane rootPane;

    public void initStage(Stage stage, GuiLanguage language) {
        stage.setHeight(AppConstants.STAGE_HEIGHT);
        stage.setWidth(AppConstants.STAGE_WIDTH);
        stage.setMinHeight(AppConstants.STAGE_HEIGHT);
        stage.setMinWidth(AppConstants.STAGE_WIDTH);
        stage.getIcons().setAll(new Image("/assets/images/ic_launcher.png"));
        stage.setTitle("%s %s".formatted(resources.getString("window.title"), appVersion));
        stage.setScene(new Scene(rootPane));
        stage.getScene().setNodeOrientation(language.getNodeOrientation());
        stage.centerOnScreen();
        stage.setOnCloseRequest(event -> {
            event.consume(); // prevent the stage from closing
            boolean confirmed = guiFactory.showConfirmationDialog(resources.getString("message.confirmExitingApp"));
            if(confirmed) {
                stage.hide();
                Log.info("The main window is closed");
                Platform.exit();
                System.exit(0);
            }
        });
        if (LaunchMode.current() == LaunchMode.DEVELOPMENT) {
            stage.getScene().addEventFilter(KeyEvent.KEY_PRESSED, event -> {
                if(AppConstants.SCENIC_VIEW_KEY_COMBINATION.match(event)) {
                    Log.info("Showing scenic view...");
                    try {
                        ScenicView.show(stage.getScene());
                    }
                    catch(NoClassDefFoundError e) {
                        Log.info("Failed to load ScenicView!", e);
                    }
                }
            });
        }
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        fxViewRepository.getPrimaryStage().setTitle("%s %s".formatted(resources.getString("window.title"), appVersion));
        fxViewRepository.getPrimaryStage().getScene().setNodeOrientation(language.getNodeOrientation());
    }

    public String getLocalizedText(String key) {
        return resources.getString(key);
    }

    /**
     * Switch the language of the application to a different language.
     *
     * @param toLanguage the language to apply to the application GUI
     */
    public boolean switchUiLanguage(GuiLanguage toLanguage) {
        var currentLanguage = guiStateManager.getCurrentGuiLanguage();

        // do not proceed if it is the same language
        if (currentLanguage == toLanguage) {
            return false;
        }

        Log.info("Switching the GUI language to " + toLanguage.name());
        Locale.setDefault(toLanguage.getLocale());
        guiStateManager.setCurrentGuiLanguage(toLanguage);

        // save the language for later usage
        var preferences = Preferences.userNodeForPackage(AppConstants.PREF_NODE_CLASS);
        preferences.put(AppConstants.UI_LANGUAGE_PREF_NAME, toLanguage.getLocale().getLanguage());

        // propagate language change to all controllers
        onLanguageChanged(toLanguage);

        // hide the primary stage and show it again in case the language orientation is different
        if (currentLanguage.getNodeOrientation() != toLanguage.getNodeOrientation()) {
            var primaryStage = fxViewRepository.getPrimaryStage();
            primaryStage.hide();
            primaryStage.show();
        }

        return true;
    }
}