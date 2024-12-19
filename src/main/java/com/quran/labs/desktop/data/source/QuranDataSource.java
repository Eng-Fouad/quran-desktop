package com.quran.labs.desktop.data.source;

import com.quran.labs.desktop.data.model.SuraAyah;

import java.util.Map;

public interface QuranDataSource {
    int numberOfPages();
    int[] pageForSuraArray();
    int[] suraForPageArray();
    int[] ayahForPageArray();
    int[] pageForJuzArray();
    Map<Integer, Integer> juzDisplayPageArrayOverride();
    int[] numberOfAyahsForSuraArray();
    boolean[] isMakkiBySuraArray();
    int[] quarterStartByPage();
    SuraAyah[] quartersArray();
    int pagesToSkip();
}