package com.quran.labs.desktop.launcher;

import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.errors.CoreError;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.core.ui.MainFxController;
import com.quran.labs.desktop.core.utils.AppConstants;
import io.quarkiverse.fx.FxApplicationStartupEvent;
import io.quarkiverse.fx.FxPostStartupEvent;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.inject.Inject;
import javafx.application.Platform;

import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Locale;
import java.util.prefs.Preferences;

/**
 * Manages the lifecycle events of a JavaFX application.
 *
 * @author Fouad Almalki
 */
@ApplicationScoped
public class QuranFxApplicationLifecycle {

    @Inject GuiFactory guiFactory;
    @Inject GuiStateManager guiStateManager;
    @Inject MainFxController mainFxController;

    GuiLanguage initialLanguage;
    boolean anotherInstanceRunning;

    /**
     * Callback that is invoked when the application is started. Initializations can be performed here.
     */
    void onApplicationStartup(@Observes FxApplicationStartupEvent event) {

        // check the last selected language by the user, otherwise use the OS default language
        var preferences = Preferences.userNodeForPackage(AppConstants.PREF_NODE_CLASS);
        String userLanguage = preferences.get(AppConstants.UI_LANGUAGE_PREF_NAME, null);
        boolean firstTime = false;
        if(userLanguage == null) {
            firstTime = true;
            userLanguage = System.getProperty("user.language", "en"); // use the OS default language
            Log.infof("No previous locale is stored. The OS default language is: %s", userLanguage);
        }

        // set the default language
        if("ar".equalsIgnoreCase(userLanguage)) initialLanguage = GuiLanguage.ARABIC;
        else initialLanguage = GuiLanguage.ENGLISH;

        // set the default locale
        Locale.setDefault(initialLanguage.getLocale());

        if (firstTime) {
            // save the language for later usage
            preferences.put(AppConstants.UI_LANGUAGE_PREF_NAME, initialLanguage.getLocale().getLanguage());
        }

        Log.infof("The language (%s) and locale (%s) will be applied",
                  initialLanguage.name(), initialLanguage.getLocale());

        // set default uncaught exception handler
        Thread.setDefaultUncaughtExceptionHandler((_, throwable) -> Platform.runLater(() ->
                                                  guiFactory.showErrorDialog(throwable, CoreError.UNCAUGHT_ERROR)));

        // check if another instance is already running
        if(checkIfAnotherInstanceAlreadyRunning()) {
            anotherInstanceRunning = true;
        }

        guiStateManager.setCurrentGuiLanguage(initialLanguage);
    }

    /**
     * Callback that is invoked when the application has finished starting and that Stage instance is available for use.
     * Views (constructed by @FxView) are also available.
     */
    void onPostStartup(@Observes FxPostStartupEvent event) {
        if (anotherInstanceRunning) {
            Log.warn("Another instance of the application is already running!");
            guiFactory.showWarningDialog(mainFxController.getResources().getString("message.anotherInstanceRunning"));
            Platform.exit();
            System.exit(0);
            return;
        }

        // initialize the primary stage and then show it
        var primaryStage = event.getPrimaryStage();
        mainFxController.initStage(primaryStage, initialLanguage);
        primaryStage.show();
        Log.info("The main window is shown");
    }

    /**
     * Check whether if another instance of the application is already running or not, using file locks mechanism.
     */
    private static boolean checkIfAnotherInstanceAlreadyRunning() {
        Path filePath = Path.of(System.getProperty("user.home"), "quran-desktop.lock");
        try {
            var fileChannel = FileChannel.open(filePath, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                                               StandardOpenOption.DELETE_ON_CLOSE);
            var fileLock = fileChannel.tryLock();
            if(fileLock != null) {
                Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                    try {
                        fileLock.release();
                        fileChannel.close();
                    } catch(Exception e) {
                        Log.error("Unable to release the file lock: " + filePath.toAbsolutePath(), e);
                    }
                }));
                return false;
            } else {
                fileChannel.close();
            }
        } catch(Exception e) {
            Log.error("Unable to create and/or lock file: " + filePath.toAbsolutePath(), e);
        }
        return true;
    }
}