package com.quran.labs.desktop.data.model;

import com.quran.labs.desktop.data.core.QuranConstants;
import com.quran.labs.desktop.data.core.QuranInfo;

import java.io.Serializable;
import java.util.Comparator;

public record SuraAyah(int sura, int ayah) implements Comparable<SuraAyah>, Serializable, QuranRef.QuranId {

    @SuppressWarnings("NullableProblems")
    @Override
    public int compareTo(SuraAyah other) {
        return Comparator.comparing(SuraAyah::sura).thenComparing(SuraAyah::ayah).compare(this, other);
    }

    @Override
    public String toString() {
        return "(%s:%s)".formatted(sura, ayah);
    }

    public boolean after(SuraAyah next) {
        return this.compareTo(next) > 0;
    }

    public SuraAyah next(QuranInfo quranInfo) {
        if (ayah < quranInfo.getNumberOfAyahs(sura)) {
            return new SuraAyah(sura, ayah + 1);
        } else if (sura < QuranConstants.SURA_COUNT) {
            return new SuraAyah(sura + 1, 1);
        } else {
            return null;
        }
    }

    public SuraAyah prev(QuranInfo quranInfo) {
        if (ayah > 1) {
            return new SuraAyah(sura, ayah - 1);
        } else if (sura > 1) {
            return new SuraAyah(sura - 1, quranInfo.getNumberOfAyahs(sura - 1));
        } else {
            return null;
        }
    }

    public int id(QuranInfo quranInfo) {
        return quranInfo.getAyahId(sura, ayah);
    }

    public static SuraAyah min(SuraAyah a, SuraAyah b) {
        return a.compareTo(b) <= 0 ? a : b;
    }

    public static SuraAyah max(SuraAyah a, SuraAyah b) {
        return a.compareTo(b) >= 0 ? a : b;
    }
}