package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.core.utils.AppConstants;
import io.quarkus.logging.Log;
import io.quarkus.runtime.LaunchMode;
import jakarta.enterprise.inject.Instance;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.application.Platform;
import javafx.fxml.FXML;
import javafx.scene.Scene;
import javafx.scene.input.KeyEvent;
import javafx.stage.Stage;
import org.eclipse.microprofile.config.inject.ConfigProperty;

import java.util.Locale;
import java.util.ResourceBundle;
import java.util.prefs.Preferences;

/// FX controller of the primary stage, i.e. controller of the main application GUI.
///
/// @author Fouad Almalki
@Singleton
public class MainFxController extends FxControllerBase implements LanguageChangeAware {

    public static final String STRINGS_RESOURCE_BUNDLE = "/i18n/strings";
    public static final String FXML = "/views/main/main.fxml";

    @ConfigProperty(name = "quarkus.application.version", defaultValue = "0.0")
    String appVersion;

    @Inject
    GuiFactory guiFactory;
    @Inject GuiStateManager guiStateManager;
    @Inject Instance<FxControllerBase> fxControllerBaseInstances;

    @FXML Stage primaryStage;
    @FXML Scene primaryScene;

    public Stage getPrimaryStage() {
        return primaryStage;
    }

    /// Show the primary stage with the specified GUI language.
    ///
    /// @param language the GUI language to use
    public void showPrimaryStage(GuiLanguage language) {
        primaryStage.setTitle("%s %s".formatted(resources.getString("window.title"), appVersion));
        primaryStage.getScene().setNodeOrientation(language.getNodeOrientation());
        primaryStage.centerOnScreen();
        primaryStage.setOnCloseRequest(event -> {
            event.consume(); // prevent the stage from closing
            boolean confirmed = guiFactory.showConfirmationDialog(resources.getString("message.confirmExitingApp"));
            if(confirmed) {
                primaryStage.hide();
                Log.info("The main window is closed");
                Platform.exit();
                System.exit(0);
            }
        });
        if (LaunchMode.current() == LaunchMode.DEVELOPMENT) {
            primaryStage.getScene().addEventFilter(KeyEvent.KEY_PRESSED, event -> {
                if(AppConstants.SCENIC_VIEW_KEY_COMBINATION.match(event)) {
                    Log.info("Showing ScenicView for UI debugging...");
                    try {
                        // invoking "org.scenicview.ScenicView.show(primaryScene)" by Reflection API
                        var scenicViewClass = Class.forName("org.scenicview.ScenicView");
                        scenicViewClass.getMethod("show", Scene.class).invoke(null, primaryScene);
                    }
                    catch(Throwable e) {
                        Log.error("Failed to load ScenicView!", e);
                    }
                }
            });
        }
        primaryStage.show();
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        primaryStage.setTitle("%s %s".formatted(resources.getString("window.title"), appVersion));
        primaryScene.setNodeOrientation(language.getNodeOrientation());

        // notify all other controllers
        fxControllerBaseInstances.stream()
                                 .filter(c -> c.getClass() != this.getClass())
                                 .filter(c -> c instanceof LanguageChangeAware)
                                 .map(LanguageChangeAware.class::cast)
                                 .forEach(c -> c.onLanguageChanged(language));
    }

    /// Switch the language of the application to a different language.
    ///
    /// @param toLanguage the language to apply to the application GUI
    ///
    /// @return <code>true</code> in case the language is changed successfully, otherwise <code>false</code>
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
            primaryStage.hide();
            primaryStage.show();
        }

        return true;
    }
}