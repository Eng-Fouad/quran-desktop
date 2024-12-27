package com.quran.labs.desktop.tasks;

import com.quran.labs.desktop.core.utils.AppConstants;
import com.quran.labs.desktop.db.AyahInfoDatabase;
import com.quran.labs.desktop.db.QuranDatabase;
import io.quarkus.arc.Unremovable;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.Dependent;
import jakarta.inject.Inject;
import javafx.concurrent.Task;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

@Dependent
@Unremovable
public class AppDataDownloadingTask extends Task<AppDataDownloadingTask.PreparingDataOutput> {

    public record PreparingDataOutput(boolean validData, boolean purgeData, boolean downloadPatch, Path appRootPath) {
        
        public static PreparingDataOutput invalidWithPurgeData() {
            return new PreparingDataOutput(false, true, false,
                                           AppConstants.PATH_APP_ROOT_DIR);
        }

        public static PreparingDataOutput invalidWithoutPurgeData() {
            return new PreparingDataOutput(false, false, false,
                                           AppConstants.PATH_APP_ROOT_DIR);
        }
        
        public static PreparingDataOutput valid(boolean downloadPatch) {
            return new PreparingDataOutput(true, false, downloadPatch,
                                           AppConstants.PATH_APP_ROOT_DIR);
        }
    }

    @Override
    protected PreparingDataOutput call() {
        long startMs = System.currentTimeMillis();
        boolean downloadPatch = false;
        try {
            // TODO: download the zip file or the patch with reporting progress to UI
            // TODO: extract the zip file

            Log.info(String.format(Locale.ENGLISH, "Preparing data succeeded (took %d ms)",
                                   System.currentTimeMillis() - startMs));
            return PreparingDataOutput.valid(downloadPatch);
        } catch (Throwable t) {
            Log.error("A failure occurs while preparing data!", t);
            return PreparingDataOutput.invalidWithPurgeData();
        }
    }
}