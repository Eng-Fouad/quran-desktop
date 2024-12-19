package com.quran.labs.desktop.data.core;

public interface QuranPageInfo {
    String juz(int page);
    String suraName(int page);
    String displayRub3(int page);
    String localizedPage(int page);
    int pageForSuraAyah(int sura, int ayah);
    int skippedPagesCount();
}