package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.ui.AlertDialogFxControllerBase;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.ButtonBar;
import javafx.scene.control.ButtonType;
import javafx.scene.control.TextArea;
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
        alertDialog.setTitle(resources.getString("dialogs.stacktrace.title"));
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