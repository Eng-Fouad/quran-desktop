package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.ui.AlertDialogFxControllerBase;
import com.quran.labs.desktop.core.ui.GuiFactory;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonType;
import javafx.scene.control.TextArea;

import java.util.Arrays;

/**
 * FX controller for managing JavaFX alert dialog that shows a message.
 *
 * @author Fouad Almalki
 */
@Singleton
@RegisterForReflection
public class MessageDialogFxController extends AlertDialogFxControllerBase {

    @FXML TextArea txtDetails;

    public void setContent(Alert.AlertType alertType, String titleLabelKey, String headerText,
                           String messageText, String extraDetailsText, GuiFactory.ButtonInfo... buttons) {
        alertDialog.setAlertType(alertType);
        alertDialog.setTitle(resources.getString(titleLabelKey));
        alertDialog.setHeaderText(headerText);
        alertDialog.setContentText(messageText);
        alertDialog.getButtonTypes().setAll(Arrays.stream(buttons)
                .map(i -> new ButtonType(resources.getString(i.labelKey()),
                        i.buttonData()))
                .toList());

        if(extraDetailsText != null) {
            String buttonMoreDetailsText = resources.getString("dialogs.buttons.showMoreDetails");
            String buttonLessDetailsText = resources.getString("dialogs.buttons.showLessDetails");
            /*var detailsButton = (Hyperlink) alertDialog.getDialogPane().lookup(".details-button");
            detailsButton.setText(buttonMoreDetailsText);
            dialogPane.expandedProperty().addListener((observable, oldValue, newValue) ->
                    detailsButton.setText(newValue ? buttonLessDetailsText : buttonMoreDetailsText));*/
            txtDetails.setText(extraDetailsText);
        } else {
            dialogPane.setExpandableContent(null);
        }

        dialogStage.sizeToScene();
    }
}