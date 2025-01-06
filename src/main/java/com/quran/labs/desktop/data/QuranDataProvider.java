package com.quran.labs.desktop.data;

import com.quran.labs.desktop.data.core.QuranInfo;
import com.quran.labs.desktop.data.madani.MadaniDataSource;
import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped
public class QuranDataProvider {

    private final QuranInfo madaniQuranInfo;
    private QuranDataStyle selectedQuranDataStyle;

    public QuranDataProvider() {
        this.madaniQuranInfo = new QuranInfo(new MadaniDataSource());
        this.selectedQuranDataStyle = QuranDataStyle.MADANI;
    }

    public void selectQuranDataStyle(QuranDataStyle quranDataStyle) {
        this.selectedQuranDataStyle = quranDataStyle;
    }

    public QuranInfo quranInfo() {
        return switch (selectedQuranDataStyle) {
            case MADANI -> madaniQuranInfo;
        };
    }
}