package com.quran.labs.desktop.tasks;

import com.quran.labs.desktop.core.utils.AppConstants;
import com.quran.labs.desktop.data.QuranDataProvider;
import com.quran.labs.desktop.data.core.QuranConstants;
import com.quran.labs.desktop.data.model.SuraNavRow;
import com.quran.labs.desktop.db.AyahInfoDatabase;
import com.quran.labs.desktop.db.QuranDatabase;
import io.quarkus.arc.Unremovable;
import io.quarkus.logging.Log;
import jakarta.enterprise.context.Dependent;
import jakarta.inject.Inject;
import javafx.concurrent.Task;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@Dependent
@Unremovable
public class AppDataInitializationTask extends Task<Void> {

    @Inject AyahInfoDatabase ayahInfoDatabase;
    @Inject QuranDatabase quranDatabase;
    @Inject QuranDataProvider quranDataProvider;

    @Override
    protected Void call() throws Exception {
        long startMs = System.currentTimeMillis();

        // load database files
        ayahInfoDatabase.initDatabase(AppConstants.PATH_MADANI_AYAH_INFO_DB_FILE);
        quranDatabase.initDatabase(AppConstants.PATH_MADANI_QURAN_DB_FILE);

        // TODO: prepare sura list
        List<SuraNavRow> suraNavRows = new ArrayList<>();
        int next;
        int sura = 1;
        for (int juz = 1; juz <= QuranConstants.JUZ_COUNT; juz++) {
            // add Juz header
            int startingPageForJuz = quranDataProvider.quranInfo().getStartingPageForJuz(juz);
            suraNavRows.add(SuraNavRow.ofJuz(juz, startingPageForJuz));

            next = juz == QuranConstants.JUZ_COUNT ? quranDataProvider.quranInfo().numberOfPages() :
                                                     quranDataProvider.quranInfo().getStartingPageForJuz(juz + 1);

            // add sura rows
            while (sura <= QuranConstants.SURA_COUNT &&
                   quranDataProvider.quranInfo().getPageNumberForSura(sura) < next) {
                int page = quranDataProvider.quranInfo().getPageNumberForSura(sura);
                boolean makki = quranDataProvider.quranInfo().isMakki(sura);
                int ayahCount = quranDataProvider.quranInfo().getNumberOfAyahs(sura);
                suraNavRows.add(SuraNavRow.ofSura(sura, page, ayahCount, makki));
                sura++;
            }
        }


        Log.info(String.format(Locale.ENGLISH,
                "AppDataInitializationTask completed successfully (took %d ms)",
                System.currentTimeMillis() - startMs));
        return null;
    }
}