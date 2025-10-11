package com.quran.labs.desktop.core.ui;

import com.quran.labs.desktop.controllers.MainFxController;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.inject.Inject;
import javafx.fxml.FXML;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonType;
import javafx.scene.control.DialogPane;
import javafx.stage.Stage;

import java.util.Optional;
import java.util.ResourceBundle;

/**
 * An abstract base class for handling common dialog-related functionality in JavaFX applications.
 * It extends {@code FxControllerBase} and provides utilities for managing and showing dialog windows.
 *
 * @author Fouad Almalki
 */
@RegisterForReflection
public abstract class AlertDialogFxControllerBase extends FxControllerBase implements LanguageChangeAware {

    @FXML protected Alert alertDialog;
    @FXML protected DialogPane dialogPane;

    @Inject
    MainFxController mainFxController;

    protected Stage dialogStage;
    private boolean hasBeenVisible = false;

    @Override
    protected void initialize() {
        dialogStage = (Stage) dialogPane.getScene().getWindow();
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }

    /**
     * Displays the dialog to the user and waits for a response.
     * <p>
     * This method shows the {@code Alert} dialog and waits for the user to respond by clicking one of the buttons.
     * It returns an {@code Optional<ButtonType>} representing the user's choice.
     * </p>
     *
     * @return an {@code Optional<ButtonType>} containing the type of button clicked by the user,
     *         or an empty {@code Optional} if no button was clicked.
     */
    public Optional<ButtonType> showDialog() {
        Stage primaryStage = mainFxController.getPrimaryStage();
        dialogStage.getScene().setNodeOrientation(primaryStage.getScene().getNodeOrientation());
        if (!hasBeenVisible) {
            dialogStage.getIcons().setAll(primaryStage.getIcons());
            dialogStage.initOwner(primaryStage);
            hasBeenVisible = true;
        }
        if (alertDialog.isShowing()) {
            return Optional.empty();
        }
        return alertDialog.showAndWait();
    }
}