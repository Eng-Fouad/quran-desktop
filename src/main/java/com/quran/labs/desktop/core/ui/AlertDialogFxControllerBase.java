package com.quran.labs.desktop.core.ui;

import io.quarkiverse.fx.views.FxViewRepository;
import jakarta.inject.Inject;
import javafx.fxml.FXML;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonType;
import javafx.scene.control.DialogPane;
import javafx.stage.Stage;
import com.quran.labs.desktop.core.fx.FxControllerBase;

import java.util.Optional;

/**
 * An abstract base class for handling common dialog-related functionality in JavaFX applications.
 * It extends {@code FxControllerBase} and provides utilities for managing and showing dialog windows.
 *
 * @author Fouad Almalki
 */
public abstract class AlertDialogFxControllerBase extends FxControllerBase {

    @FXML protected Alert alertDialog;
    @FXML protected DialogPane dialogPane;

    @Inject FxViewRepository fxViewRepository;

    Stage primaryStage;
    Stage dialogStage;

    @Override
    protected void initialize() {
        primaryStage = fxViewRepository.getPrimaryStage();
        dialogStage = (Stage) dialogPane.getScene().getWindow();
        dialogStage.getIcons().setAll(primaryStage.getIcons());
        dialogStage.initOwner(primaryStage);
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
        return alertDialog.showAndWait();
    }
}