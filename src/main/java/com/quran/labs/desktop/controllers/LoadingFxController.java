package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.tasks.AppDataInitializationTask;
import com.quran.labs.desktop.tasks.RequiredAppFilesCheckingTask;
import jakarta.enterprise.inject.Instance;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.concurrent.Worker;
import javafx.event.ActionEvent;
import javafx.fxml.FXML;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.control.MenuButton;
import javafx.scene.control.ProgressBar;
import javafx.scene.layout.Pane;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class LoadingFxController extends FxControllerBase implements LanguageChangeAware {

    @Inject GuiFactory guiFactory;
    @Inject MainFxController mainFxController;
    @Inject Instance<RequiredAppFilesCheckingTask> requiredAppFilesCheckingTaskProvider;
    @Inject Instance<AppDataInitializationTask> appDataInitializationTaskProvider;

    @FXML Pane paneProgressIndicator;
    @FXML Pane paneProgressBar;
    @FXML Pane paneDownloadButton;
    @FXML Pane paneError;
    @FXML Label lblProgressIndicator;
    @FXML Label lblProgressBar;
    @FXML Label lblError;
    @FXML ProgressBar pbLoading;
    @FXML Button btnRetry;
    @FXML Button btnShowErrorDetails;
    @FXML MenuButton mbLanguage;

    @Override
    protected void initialize() {
        guiFactory.initLanguageButton(mbLanguage);
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }

    @FXML
    void onDownloadFilesButtonClicked(ActionEvent ignoredActionEvent) {
        startAppDataDownloadingTask();
    }

    public void startRequiredAppFilesCheckingTask() {
        lblProgressBar.setText(resources.getString("label.checkingInstalledFiles"));
        showPane(LoadingPane.PROGRESS_INDICATOR);

        // get a new instance of RequiredAppFilesCheckingTask
        var requiredAppFilesCheckingTask = requiredAppFilesCheckingTaskProvider.get();

        // add listener to get the task output on success
        requiredAppFilesCheckingTask.valueProperty().addListener((_, _, value) -> {
            if (value.validData()) {
                if (value.downloadPatch()) {
                    startAppDataPatchDownloadingTask();
                } else {
                    startAppDataInitializationTask();
                }
            } else {
                startAppDataDownloadingTask();
            }
        });

        // add listener to get the exception on failure
        requiredAppFilesCheckingTask.exceptionProperty().addListener((_, _, exception) -> {
            showPane(LoadingPane.ERROR);
            lblError.setText(resources.getString("label.errorOnCheckingRequiredFiles"));
            btnRetry.setOnAction(_ -> startRequiredAppFilesCheckingTask());
            btnShowErrorDetails.setOnAction(_ -> guiFactory.showErrorStacktraceDialog(exception));
        });

        // start the task
        Thread.startVirtualThread(requiredAppFilesCheckingTask);
    }

    public void startAppDataInitializationTask() {
        lblProgressIndicator.setText(resources.getString("label.initAppData"));
        showPane(LoadingPane.PROGRESS_INDICATOR);

        // get a new instance of AppDataInitializationTask
        var appDataInitializationTask = appDataInitializationTaskProvider.get();

        // add listener for state changing
        appDataInitializationTask.stateProperty().addListener((_, _, newState) -> {
            if (newState == Worker.State.SUCCEEDED) {
                showPane(null);
                mainFxController.switchToHome();
            }
        });

        // add listener to get the exception on failure
        appDataInitializationTask.exceptionProperty().addListener((_, _, exception) -> {
            showPane(LoadingPane.ERROR);
            lblError.setText(resources.getString("label.errorOnInitializingAppData"));
            btnRetry.setOnAction(_ -> startAppDataInitializationTask());
            btnShowErrorDetails.setOnAction(_ -> guiFactory.showErrorStacktraceDialog(exception));
        });

        // start the task
        Thread.startVirtualThread(appDataInitializationTask);
    }

    private void startAppDataPatchDownloadingTask() {
        showPane(LoadingPane.PROGRESS_BAR);
        // TODO
    }

    public void startAppDataDownloadingTask() {
        showPane(LoadingPane.PROGRESS_BAR);
        // TODO
    }

    private enum LoadingPane {PROGRESS_INDICATOR, PROGRESS_BAR, DOWNLOAD_BUTTON, ERROR}
    private void showPane(LoadingPane loadingPane) {
        paneProgressIndicator.setVisible(loadingPane == LoadingPane.PROGRESS_INDICATOR);
        paneProgressBar.setVisible(loadingPane == LoadingPane.PROGRESS_BAR);
        paneError.setVisible(loadingPane == LoadingPane.ERROR);
        paneDownloadButton.setVisible(loadingPane == LoadingPane.DOWNLOAD_BUTTON);
    }
}