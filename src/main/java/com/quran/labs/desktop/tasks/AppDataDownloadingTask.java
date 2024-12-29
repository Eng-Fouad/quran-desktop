package com.quran.labs.desktop.tasks;

import com.quran.labs.desktop.core.utils.FileUtils;
import io.quarkus.arc.Unremovable;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.Dependent;
import javafx.concurrent.Task;

import java.nio.file.Path;
import java.util.Locale;

@Dependent
@Unremovable
public class AppDataDownloadingTask extends Task<Void> {

    boolean downloadPatch;

    public void setDownloadPatch(boolean downloadPatch) {
        this.downloadPatch = downloadPatch;
    }

    @Override
    protected Void call() {
        long startMs = System.currentTimeMillis();
        // TODO: fill these
        String downloadUrl = "";
        var downloadFilePath = Path.of("");
        var decompressDirPath = Path.of("");

        // download the zip file or the patch with reporting progress to UI
        FileUtils.downloadFile(downloadUrl, downloadFilePath, p -> {
            if (p.total() != null) {
                updateProgress(p.soFar(), p.total());
            } else {
                updateProgress(-1, -1);
            }
        });

        // extract the zip file
        FileUtils.decompressZipFile(downloadFilePath, decompressDirPath);

        Log.info(String.format(Locale.ENGLISH, "AppDataDownloadingTask completed successfully (took %d ms)",
                System.currentTimeMillis() - startMs));
        return null;
    }
}