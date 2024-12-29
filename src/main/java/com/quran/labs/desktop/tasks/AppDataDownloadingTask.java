package com.quran.labs.desktop.tasks;

import com.quran.labs.desktop.core.utils.AppConstants;
import com.quran.labs.desktop.core.utils.FileUtils;
import com.quran.labs.desktop.tasks.AppDataDownloadingTask.AppDataDownloadingPhase;
import io.quarkus.arc.Unremovable;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.Dependent;
import javafx.concurrent.Task;

import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

@Dependent
@Unremovable
public class AppDataDownloadingTask extends Task<AppDataDownloadingPhase> {

    public enum AppDataDownloadingPhase {
        DELETING_OLD_FILES,
        DOWNLOADING_FILE,
        DECOMPRESSING_FILE,
        DELETING_TEMP_FILE,
        DONE,
    }

    AtomicLong soFarBytes = new AtomicLong(0);
    AtomicLong totalBytes = new AtomicLong(0);
    boolean downloadPatch;

    public void setDownloadPatch(boolean downloadPatch) {
        this.downloadPatch = downloadPatch;
    }

    public long soFarBytes() {
        return soFarBytes.get();
    }

    public long totalBytes() {
        return totalBytes.get();
    }

    @Override
    protected AppDataDownloadingPhase call() {
        long startMs = System.currentTimeMillis();
        String downloadUrl = downloadPatch ? AppConstants.URL_MADANI_DATA_PATCH_FILE :
                                             AppConstants.URL_MADANI_DATA_FULL_FILE;
        var downloadFilePath = AppConstants.PATH_TEMP_DIR.resolve(UUID.randomUUID() + ".zip");
        var decompressDirPath = AppConstants.PATH_MADANI_DATA_DIR;

        // delete data directory if it is a full download
        if (!downloadPatch) {
            updateValue(AppDataDownloadingPhase.DELETING_OLD_FILES);
            FileUtils.deletePathRecursively(AppConstants.PATH_MADANI_DATA_DIR);
        }

        // download the zip file or the patch with reporting progress to UI
        updateValue(AppDataDownloadingPhase.DOWNLOADING_FILE);
        FileUtils.downloadFile(downloadUrl, downloadFilePath, p -> {
            if (p.total() != null) {
                soFarBytes.set(p.soFar());
                totalBytes.set(p.total());
                updateProgress(p.soFar(), p.total());
            } else {
                updateProgress(-1, -1);
            }
        });

        // extract the zip file
        updateValue(AppDataDownloadingPhase.DECOMPRESSING_FILE);
        FileUtils.decompressZipFile(downloadFilePath, decompressDirPath);

        // delete the zip file
        updateValue(AppDataDownloadingPhase.DELETING_TEMP_FILE);
        FileUtils.deletePath(downloadFilePath);

        Log.info(String.format(Locale.ENGLISH, "AppDataDownloadingTask completed successfully (took %d ms)",
                System.currentTimeMillis() - startMs));
        return AppDataDownloadingPhase.DONE;
    }
}