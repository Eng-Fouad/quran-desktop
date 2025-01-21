package com.quran.labs.desktop.data;

import com.quran.labs.desktop.data.core.QuranConstants;
import com.quran.labs.desktop.data.core.QuranInfo;
import com.quran.labs.desktop.data.madani.MadaniDataSource;
import com.quran.labs.desktop.data.model.SuraNavRow;
import jakarta.enterprise.context.ApplicationScoped;

import java.util.ArrayList;
import java.util.List;

@ApplicationScoped
public class QuranDataProvider {

    private final QuranInfo madaniQuranInfo;
    private final List<SuraNavRow> suraNavRows;
    private QuranDataStyle selectedQuranDataStyle;

    public QuranDataProvider() {
        this.madaniQuranInfo = new QuranInfo(new MadaniDataSource());
        this.suraNavRows = new ArrayList<>();
        this.selectedQuranDataStyle = QuranDataStyle.MADANI;
    }

    public List<SuraNavRow> suraNavRows() {
        return suraNavRows;
    }

    public void selectQuranDataStyle(QuranDataStyle quranDataStyle) {
        this.selectedQuranDataStyle = quranDataStyle;
    }

    public void constructSuraNavRows() {
        suraNavRows.clear();
        int next;
        int sura = 1;
        for (int juz = 1; juz <= QuranConstants.JUZ_COUNT; juz++) {
            // add Juz header
            int startingPageForJuz = quranInfo().getStartingPageForJuz(juz);
            suraNavRows.add(SuraNavRow.ofJuz(juz, startingPageForJuz));

            next = juz == QuranConstants.JUZ_COUNT ? quranInfo().numberOfPages() + 1 :
                                                     quranInfo().getStartingPageForJuz(juz + 1);

            // add sura rows
            while (sura <= QuranConstants.SURA_COUNT &&
                    quranInfo().getPageNumberForSura(sura) < next) {
                int page = quranInfo().getPageNumberForSura(sura);
                boolean makki = quranInfo().isMakki(sura);
                int ayahCount = quranInfo().getNumberOfAyahs(sura);
                suraNavRows.add(SuraNavRow.ofSura(sura, page, ayahCount, makki));
                sura++;
            }
        }
    }

    private QuranInfo quranInfo() {
        return switch (selectedQuranDataStyle) {
            case MADANI -> madaniQuranInfo;
        };
    }
}