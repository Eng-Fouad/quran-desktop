package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.tasks.AppDataDownloadingTask;
import com.quran.labs.desktop.tasks.AppDataInitializationTask;
import com.quran.labs.desktop.tasks.RequiredAppFilesCheckingTask;
import io.quarkus.logging.Log;
import io.quarkus.runtime.annotations.RegisterForReflection;
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
@RegisterForReflection
public class LoadingFxController extends FxControllerBase implements LanguageChangeAware {

    @Inject GuiFactory guiFactory;
    @Inject MainFxController mainFxController;
    @Inject Instance<RequiredAppFilesCheckingTask> requiredAppFilesCheckingTaskProvider;
    @Inject Instance<AppDataInitializationTask> appDataInitializationTaskProvider;
    @Inject Instance<AppDataDownloadingTask> appDataDownloadingTaskProvider;

    @FXML Pane paneProgressIndicator;
    @FXML Pane paneProgressBar;
    @FXML Pane paneDownloadButton;
    @FXML Pane paneError;
    @FXML Label lblDownloadFiles;
    @FXML Label lblProgressIndicator;
    @FXML Label lblProgressBar;
    @FXML Label lblError;
    @FXML ProgressBar pbLoading;
    @FXML Button btnDownloadFiles;
    @FXML Button btnRetry;
    @FXML Button btnShowErrorDetails;
    @FXML MenuButton mbLanguage;

    boolean downloadPatch;
    String errorLabelKey;

    @Override
    protected void initialize() {
        guiFactory.initLanguageButton(mbLanguage);
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        btnDownloadFiles.setText(resources.getString("button.downloadFiles"));
        btnRetry.setText(resources.getString("button.retry"));
        btnShowErrorDetails.setText(resources.getString("button.showErrorDetails"));
        lblDownloadFiles.setText(resources.getString("label.someFilesMustBeDownloaded"));
        if (errorLabelKey != null) lblError.setText(resources.getString(errorLabelKey));
    }

    @FXML
    void onDownloadFilesButtonClicked(ActionEvent ignoredActionEvent) {
        startAppDataDownloadingTask(downloadPatch);
    }

    @FXML
    void onRetryButtonClicked(ActionEvent ignoredActionEvent) {
        startAppDataDownloadingTask(false);
    }

    public void startRequiredAppFilesCheckingTask() {
        lblProgressIndicator.setText(resources.getString("label.checkingInstalledFiles"));
        showPane(LoadingPane.PROGRESS_INDICATOR);

        // get a new instance of RequiredAppFilesCheckingTask
        var requiredAppFilesCheckingTask = requiredAppFilesCheckingTaskProvider.get();

        // add listener to get the task output on success
        requiredAppFilesCheckingTask.valueProperty().addListener((_, _, value) -> {
            if (value.validData()) {
                downloadPatch = value.downloadPatch();
                if (downloadPatch) {
                    showPane(LoadingPane.DOWNLOAD_BUTTON);
                    btnDownloadFiles.requestFocus();
                } else {
                    startAppDataInitializationTask();
                }
            } else {
                showPane(LoadingPane.DOWNLOAD_BUTTON);
                btnDownloadFiles.requestFocus();
            }
        });

        // add listener to get the exception on failure
        requiredAppFilesCheckingTask.exceptionProperty().addListener((_, _, exception) -> {
            showPane(LoadingPane.ERROR);
            errorLabelKey = "label.errorOnCheckingRequiredFiles";
            lblError.setText(resources.getString(errorLabelKey));
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
            errorLabelKey = "label.errorOnInitializingAppData";
            lblError.setText(resources.getString(errorLabelKey));
            btnShowErrorDetails.setOnAction(_ -> guiFactory.showErrorStacktraceDialog(exception));
            Log.errorf(exception, "error on initializing app data");
        });

        // start the task
        Thread.startVirtualThread(appDataInitializationTask);
    }

    public void startAppDataDownloadingTask(boolean downloadPatch) {
        showPane(LoadingPane.PROGRESS_BAR);

        // get a new instance of AppDataDownloadingTask
        var appDataDownloadingTask = appDataDownloadingTaskProvider.get();
        appDataDownloadingTask.setDownloadPatch(downloadPatch);

        // add listener for state changing
        appDataDownloadingTask.stateProperty().addListener((_, _, newState) -> {
            if (newState == Worker.State.SUCCEEDED) {
                startAppDataInitializationTask();
            }
        });

        // add listener for progress changing
        appDataDownloadingTask.progressProperty().addListener((_, _, newState) -> {
            if (newState.doubleValue() >= 0.0) {
                double soFarMegaBytes = appDataDownloadingTask.soFarBytes() / (1024.0 * 1024.0);
                double totalMegaBytes = appDataDownloadingTask.totalBytes() / (1024.0 * 1024.0);
                pbLoading.setProgress(newState.doubleValue());
                lblProgressBar.setText(resources.getString("label.downloadingProgress")
                                    .formatted(newState.doubleValue() * 100.0, soFarMegaBytes, totalMegaBytes));
            } else {
                pbLoading.setProgress(-1);
                lblProgressBar.setText(resources.getString("label.downloadingProgressUnknownTotal"));
            }
        });

        appDataDownloadingTask.valueProperty().addListener((_, _, value) -> {
            if (value == AppDataDownloadingTask.AppDataDownloadingPhase.DELETING_OLD_FILES) {
                lblProgressBar.setText(resources.getString("label.deletingOldFiles"));
            } else if (value == AppDataDownloadingTask.AppDataDownloadingPhase.DOWNLOADING_FILE) {
                lblProgressBar.setText(resources.getString("label.downloadingProgressUnknownTotal"));
            } else if (value == AppDataDownloadingTask.AppDataDownloadingPhase.DECOMPRESSING_FILE) {
                lblProgressBar.setText(resources.getString("label.extractingCompressedFiles"));
            } else if (value == AppDataDownloadingTask.AppDataDownloadingPhase.DELETING_TEMP_FILE) {
                lblProgressBar.setText(resources.getString("label.deletingTempFiles"));
            }
        });

        // add listener to get the exception on failure
        appDataDownloadingTask.exceptionProperty().addListener((_, _, exception) -> {
            showPane(LoadingPane.ERROR);
            errorLabelKey = "label.errorOnDownloadingFiles";
            lblError.setText(resources.getString(errorLabelKey));
            btnShowErrorDetails.setOnAction(_ -> guiFactory.showErrorStacktraceDialog(exception));
        });

        // start the task
        Thread.startVirtualThread(appDataDownloadingTask);
    }

    private enum LoadingPane {PROGRESS_INDICATOR, PROGRESS_BAR, DOWNLOAD_BUTTON, ERROR}
    private void showPane(LoadingPane loadingPane) {
        paneDownloadButton.setVisible(loadingPane == LoadingPane.DOWNLOAD_BUTTON);
        paneError.setVisible(loadingPane == LoadingPane.ERROR);
        paneProgressBar.setVisible(loadingPane == LoadingPane.PROGRESS_BAR);
        paneProgressIndicator.setVisible(loadingPane == LoadingPane.PROGRESS_INDICATOR);
        mbLanguage.setVisible(loadingPane == LoadingPane.DOWNLOAD_BUTTON || loadingPane == LoadingPane.ERROR);
    }
}