package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.core.utils.AppConstants;
import com.quran.labs.desktop.core.utils.GuiUtils;
import com.quran.labs.desktop.tasks.PreparingDataTask;
import io.quarkus.logging.Log;
import jakarta.enterprise.inject.Instance;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.application.Platform;
import javafx.concurrent.Worker;
import javafx.fxml.FXML;
import javafx.scene.Scene;
import javafx.scene.layout.Pane;
import javafx.stage.Stage;
import javafx.stage.WindowEvent;
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

    @Inject GuiFactory guiFactory;
    @Inject GuiStateManager guiStateManager;
    @Inject Instance<FxControllerBase> fxControllerBaseInstances;
    @Inject Instance<PreparingDataTask> preparingDataTaskProvider;

    @FXML Stage primaryStage;
    @FXML Scene primaryScene;
    @FXML Pane loadingPane;
    @FXML Pane homePane;

    @Override
    protected void initialize() {
        GuiUtils.attachScenicViewInDevEnv(primaryScene);
    }

    @FXML
    void onClosingStage(WindowEvent windowEvent) {
        windowEvent.consume(); // prevent the stage from closing
        boolean confirmed = guiFactory.showConfirmationDialog(resources.getString("message.confirmExitingApp"));
        if(confirmed) {
            primaryStage.hide();
            Log.info("The main window is closed");
            Platform.exit();
            System.exit(0);
        }
    }

    public Stage getPrimaryStage() {
        return primaryStage;
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

    /// Show the primary stage with the specified GUI language.
    ///
    /// @param language the GUI language to use
    public void showPrimaryStage(GuiLanguage language) {
        primaryStage.setTitle("%s %s".formatted(resources.getString("window.title"), appVersion));
        primaryStage.getScene().setNodeOrientation(language.getNodeOrientation());
        primaryStage.centerOnScreen();
        primaryStage.show();
    }

    public void startPreparingDataTask() {
        // get a new instance of PreparingDataTask
        var preparingDataTask = preparingDataTaskProvider.get();

        // add listener for state changing
        preparingDataTask.stateProperty().addListener((_, _, newState) -> {
            /*if (newState == Worker.State.RUNNING) {
                GuiUtils.hideNode(errorPane);
                GuiUtils.hideNode(btnRegister);
                GuiUtils.showNode(piRegistering);
            } else {
                GuiUtils.hideNode(piRegistering);
                GuiUtils.showNode(btnRegister);
                Platform.runLater(txtBarqNumber::requestFocus);
            }*/
        });

        // add listener to get the task output on success
        preparingDataTask.valueProperty().addListener((_, _, value) -> {
            if (value.validData()) {
                GuiUtils.hideNode(loadingPane);
                GuiUtils.showNode(homePane);
            }
        });

        // add listener to get the exception on failure
        preparingDataTask.exceptionProperty().addListener((_, _, exception) -> {
            /*if (exception instanceof WebApplicationException e) {

                String errorMessage = resources.getString("error.registrationRefused");
                lblErrorMessage.setText(errorMessage);
                GuiUtils.showNode(errorPane);

                int statusCode = e.getResponse().getStatus();
                String responseBody = e.getResponse().getEntity() != null ? e.getResponse().getEntity().toString() : null;
                btnErrorDetails.setOnAction(_ -> guiFactory.showHttpErrorDialog(statusCode, responseBody));
            } else {
                String errorMessage = resources.getString("error.failedToContactServer");
                lblErrorMessage.setText(errorMessage);
                GuiUtils.showNode(errorPane);
                btnErrorDetails.setOnAction(_ -> guiFactory.showErrorStacktraceDialog(exception));
            }*/
        });

        // start the task
        Thread.startVirtualThread(preparingDataTask);
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
        preferences.put(AppConstants.PREF_UI_LANGUAGE, toLanguage.getLocale().getLanguage());

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