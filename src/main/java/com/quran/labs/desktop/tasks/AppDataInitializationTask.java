package com.quran.labs.desktop.tasks;

import com.quran.labs.desktop.core.utils.AppConstants;
import com.quran.labs.desktop.db.AyahInfoDatabase;
import com.quran.labs.desktop.db.QuranDatabase;
import io.quarkus.arc.Unremovable;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.Dependent;
import jakarta.inject.Inject;
import javafx.concurrent.Task;

import java.util.Locale;

@Dependent
@Unremovable
public class AppDataInitializationTask extends Task<Void> {

    @Inject AyahInfoDatabase ayahInfoDatabase;
    @Inject QuranDatabase quranDatabase;

    @Override
    protected Void call() throws Exception {
        long startMs = System.currentTimeMillis();

        // load database files
        ayahInfoDatabase.initDatabase(AppConstants.PATH_MADANI_AYAH_INFO_DB_FILE);
        quranDatabase.initDatabase(AppConstants.PATH_MADANI_QURAN_DB_FILE);

        // TODO: prepare chapters list


        Log.info(String.format(Locale.ENGLISH,
                "AppDataInitializationTask completed successfully (took %d ms)",
                System.currentTimeMillis() - startMs));
        return null;
    }
}