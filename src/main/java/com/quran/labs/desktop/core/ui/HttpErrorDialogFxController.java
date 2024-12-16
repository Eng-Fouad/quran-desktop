package com.quran.labs.desktop.core.ui;

import io.quarkiverse.fx.views.FxView;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.ButtonBar;
import javafx.scene.control.ButtonType;
import javafx.scene.control.Label;
import javafx.scene.control.TextArea;
import javafx.stage.Stage;

/**
 * FX controller for managing a dialog containing HTTP error details.
 *
 * @author Fouad Almalki
 */
@Singleton
public class HttpErrorDialogFxController extends AlertDialogFxControllerBase {

    @FXML Label lblStatusCode;
    @FXML TextArea txtResponseBody;

    public void setHttpResponse(int statusCode, String body) {
        alertDialog.getButtonTypes().setAll(new ButtonType(resources.getString("dialogs.buttons.close"),
                ButtonBar.ButtonData.CANCEL_CLOSE));
        lblStatusCode.setText(String.valueOf(statusCode));
        txtResponseBody.setText(body);
        var stage = (Stage) dialogPane.getScene().getWindow();
        stage.sizeToScene();
    }
}