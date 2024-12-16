package com.quran.labs.desktop.core.ui;

import io.quarkiverse.fx.views.FxView;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.*;
import javafx.stage.Stage;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * FX controller for managing a dialog containing stacktrace.
 *
 * @author Fouad Almalki
 */
@Singleton
public class StacktraceDialogFxController extends AlertDialogFxControllerBase {

    @FXML TextArea txtStacktrace;

    public void setException(Throwable throwable) {
        alertDialog.getButtonTypes().setAll(new ButtonType(resources.getString("dialogs.buttons.close"),
                ButtonBar.ButtonData.CANCEL_CLOSE));

        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        throwable.printStackTrace(pw);
        String stacktraceText = sw.toString();
        txtStacktrace.setText(stacktraceText);
        var stage = (Stage) dialogPane.getScene().getWindow();
        stage.sizeToScene();
    }
}