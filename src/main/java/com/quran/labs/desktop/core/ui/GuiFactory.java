package com.quran.labs.desktop.core.ui;

import com.quran.labs.desktop.controllers.HttpErrorDialogFxController;
import com.quran.labs.desktop.controllers.MainFxController;
import com.quran.labs.desktop.controllers.MessageDialogFxController;
import com.quran.labs.desktop.controllers.StacktraceDialogFxController;
import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.errors.LabelAndCode;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import javafx.collections.FXCollections;
import javafx.scene.control.Alert;
import javafx.scene.control.ButtonBar;
import javafx.scene.control.MenuButton;
import javafx.scene.control.MenuItem;
import org.kordamp.ikonli.carbonicons.CarbonIcons;
import org.kordamp.ikonli.javafx.FontIcon;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Arrays;

/**
 * A factory class for creating various GUI components.
 *
 * @author Fouad Almalki
 */
@ApplicationScoped
public final class GuiFactory {

    public record ButtonInfo(String labelKey, ButtonBar.ButtonData buttonData){}

    @Inject MainFxController mainFxController;
    @Inject GuiStateManager guiStateManager;
    @Inject MessageDialogFxController alertDialogFxController;
    @Inject HttpErrorDialogFxController httpErrorDialogFxController;
    @Inject StacktraceDialogFxController stacktraceDialogFxController;

    public void initLanguageButton(MenuButton mbLanguage) {
        var checkIcon = new FontIcon(CarbonIcons.CHECKMARK);
        checkIcon.setIconSize(14);
        var languageMenuItems = FXCollections.<MenuItem>observableArrayList();
        for (var guiLanguage : GuiLanguage.values()) {
            var menuItem = new MenuItem(guiLanguage.toString());
            menuItem.setOnAction(_ -> {
                boolean changed = mainFxController.switchUiLanguage(guiLanguage);
                if (changed) {
                    for (var item : languageMenuItems) {
                        if (item.getText().equals(guiLanguage.toString())) {
                            item.setGraphic(checkIcon);
                        } else {
                            item.setGraphic(null);
                        }
                    }
                }
            });
            languageMenuItems.add(menuItem);
        }
        mbLanguage.getItems().setAll(languageMenuItems);
        for (var item : mbLanguage.getItems()) {
            if (item.getText().equals(guiStateManager.getCurrentGuiLanguage().toString())) {
                item.setGraphic(checkIcon);
                break;
            }
        }
    }

    /**
     * Displays an error dialog with the specified details.
     *
     * @param throwable    the {@link Throwable} associated with the error (optional).
     * @param errorCode    the error code to be displayed in the dialog.
     * @param errorDetails additional details about the error (optional).
     */
    public void showErrorDialog(Throwable throwable, LabelAndCode errorCode, String... errorDetails) {
        Log.errorf(throwable, "errorCode = %s | errorDetails = %s", errorCode, Arrays.toString(errorDetails));

        StringBuilder sb = new StringBuilder();
        if(errorDetails != null) {
            for(String s : errorDetails) sb.append(s).append("\n");
        }
        if(throwable != null) {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            throwable.printStackTrace(pw);
            String stacktraceText = sw.toString();
            sb.append(stacktraceText);
        }

        alertDialogFxController.setContent(Alert.AlertType.ERROR, "dialogs.error.title",
                "dialogs.error.header", errorCode.toString(), sb.toString(),
                new ButtonInfo("dialogs.buttons.close", ButtonBar.ButtonData.CANCEL_CLOSE));
        alertDialogFxController.showDialog();
    }

    /**
     * Displays a warning dialog with the specified message.
     *
     * @param messageText the message to be displayed
     */
    public void showWarningDialog(String messageText) {
        alertDialogFxController.setContent(Alert.AlertType.WARNING, "dialogs.warning.title",
                messageText, null, null,
                new ButtonInfo("dialogs.buttons.close", ButtonBar.ButtonData.CANCEL_CLOSE));
        alertDialogFxController.showDialog();
    }

    /**
     * Displays a confirmation dialog with the specified message.
     *
     * @param messageText the message to be displayed
     *
     * @return {@code true} if the user confirms the action, {@code false} otherwise.
     */
    public boolean showConfirmationDialog(String messageText) {
        alertDialogFxController.setContent(Alert.AlertType.CONFIRMATION, "dialogs.confirmation.title",
                messageText, null, null,
                new ButtonInfo("dialogs.buttons.yes", ButtonBar.ButtonData.YES),
                new ButtonInfo("dialogs.buttons.no", ButtonBar.ButtonData.NO));
        var buttonTypeOptional = alertDialogFxController.showDialog();
        return buttonTypeOptional.stream().anyMatch(bt -> bt.getButtonData() == ButtonBar.ButtonData.YES);
    }

    public void showHttpErrorDialog(int httpResponseStatusCode, String httpResponseBody) {
        httpErrorDialogFxController.setHttpResponse(httpResponseStatusCode, httpResponseBody);
        httpErrorDialogFxController.showDialog();
    }

    public void showErrorStacktraceDialog(Throwable throwable) {
        stacktraceDialogFxController.setException(throwable);
        stacktraceDialogFxController.showDialog();
    }
}