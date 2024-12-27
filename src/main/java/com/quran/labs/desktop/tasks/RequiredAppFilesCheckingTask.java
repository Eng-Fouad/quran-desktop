package com.quran.labs.desktop.tasks;

import com.quran.labs.desktop.core.utils.AppConstants;
import io.quarkus.arc.Unremovable;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.Dependent;
import javafx.concurrent.Task;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

@Dependent
@Unremovable
public class RequiredAppFilesCheckingTask extends Task<RequiredAppFilesCheckingTask.RequiredAppFilesCheckingOutput> {

    public record RequiredAppFilesCheckingOutput(boolean validData, boolean purgeData, boolean downloadPatch,
                                                 Path appRootPath) {
        
        public static RequiredAppFilesCheckingOutput invalidWithPurgeData() {
            return new RequiredAppFilesCheckingOutput(false, true, false,
                                                      AppConstants.PATH_APP_ROOT_DIR);
        }

        public static RequiredAppFilesCheckingOutput invalidWithoutPurgeData() {
            return new RequiredAppFilesCheckingOutput(false, false, false,
                                                      AppConstants.PATH_APP_ROOT_DIR);
        }
        
        public static RequiredAppFilesCheckingOutput valid(boolean downloadPatch) {
            return new RequiredAppFilesCheckingOutput(true, false, downloadPatch,
                                                      AppConstants.PATH_APP_ROOT_DIR);
        }
    }

    @Override
    protected RequiredAppFilesCheckingOutput call() {
        long startMs = System.currentTimeMillis();
        boolean downloadPatch = false;
        try {
            // validate app root path
            if (!Files.exists(AppConstants.PATH_APP_ROOT_DIR)) {
                Log.infof("App root path does not exist (%s)", AppConstants.PATH_APP_ROOT_DIR);
                return RequiredAppFilesCheckingOutput.invalidWithoutPurgeData();
            } else if (!Files.isDirectory(AppConstants.PATH_APP_ROOT_DIR)) {
                Log.warnf("App root path is not a directory (%s)", AppConstants.PATH_APP_ROOT_DIR);
                return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
            }
            
            // validate pages directory
            if (!Files.exists(AppConstants.PATH_PAGES_DIR)) {
                Log.warnf("Pages directory path does not exist (%s)", AppConstants.PATH_PAGES_DIR);
                return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
            } else if (!Files.isDirectory(AppConstants.PATH_PAGES_DIR)) {
                Log.warnf("Pages directory path is not a directory (%s)", AppConstants.PATH_PAGES_DIR);
                return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
            } else {
                // validate pages
                for (int i = 1; i <= 604; i++) {
                    var pageFilePath = AppConstants.PATH_PAGES_DIR
                                                   .resolve(String.format(Locale.ENGLISH, "page%03d.png", i));
                    if (!Files.exists(pageFilePath)) {
                        Log.warn(String.format(Locale.ENGLISH, "Page (%d) file does not exist (%s)",
                                               i, pageFilePath));
                        return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                    } else if (!Files.isRegularFile(pageFilePath)) {
                        Log.warn(String.format(Locale.ENGLISH, "Page (%d) file path is not a file (%s)",
                                               i, pageFilePath));
                        return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                    }
                }
                // check for patch update
                var versionFilePath = AppConstants.PATH_PAGES_DIR
                                                  .resolve(String.format(Locale.ENGLISH,
                                                           ".v%d", AppConstants.MADANI_PAGES_VERSION));
                if (!Files.exists(versionFilePath)) {
                    if (!Files.isRegularFile(versionFilePath)) {
                        Log.warnf("Version file path is not a file (%s)", versionFilePath);
                        return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                    }
                    downloadPatch = true;
                }
            }

            // validate db directory
            if (!Files.exists(AppConstants.PATH_DB_DIR)) {
                Log.warnf("DB directory path does not exist (%s)", AppConstants.PATH_DB_DIR);
                return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
            } else if (!Files.isDirectory(AppConstants.PATH_DB_DIR)) {
                Log.warnf("DB directory path is not a directory (%s)", AppConstants.PATH_DB_DIR);
                return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
            } else {
                // validate database files
                if (!Files.exists(AppConstants.PATH_MADANI_AYAH_INFO_DB_FILE)) {
                    Log.warnf("DB ayah info file does not exist (%s)",
                              AppConstants.PATH_MADANI_AYAH_INFO_DB_FILE);
                    return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                } else if (!Files.isRegularFile(AppConstants.PATH_MADANI_AYAH_INFO_DB_FILE)) {
                    Log.warnf("DB ayah info file path is not a file (%s)",
                              AppConstants.PATH_MADANI_AYAH_INFO_DB_FILE);
                    return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                }
                if (!Files.exists(AppConstants.PATH_MADANI_QURAN_DB_FILE)) {
                    Log.warnf("DB quran file does not exist (%s)",
                              AppConstants.PATH_MADANI_QURAN_DB_FILE);
                    return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                } else if (!Files.isRegularFile(AppConstants.PATH_MADANI_QURAN_DB_FILE)) {
                    Log.warnf("DB quran file path is not a file (%s)",
                              AppConstants.PATH_MADANI_QURAN_DB_FILE);
                    return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
                }
            }

            Log.info(String.format(Locale.ENGLISH,
                                   "RequiredAppFilesCheckingTask completed successfully (took %d ms)",
                                   System.currentTimeMillis() - startMs));
            return RequiredAppFilesCheckingOutput.valid(downloadPatch);
        } catch (Throwable t) {
            Log.error("A failure occurs while checking for required app files!", t);
            return RequiredAppFilesCheckingOutput.invalidWithPurgeData();
        }
    }
}