package com.quran.labs.desktop.data.model;

import java.io.Serializable;
import java.util.Comparator;
import java.util.Locale;

public record AyahWord(SuraAyah ayah, int wordPosition) implements Comparable<AyahWord>, Serializable, QuranRef.QuranId {

    @SuppressWarnings("NullableProblems")
    @Override
    public int compareTo(AyahWord other) {
        return Comparator.comparing(AyahWord::ayah).thenComparing(AyahWord::wordPosition).compare(this, other);
    }

    @Override
    public String toString() {
        return String.format(Locale.ENGLISH, "%d:%d:%d", ayah.sura(), ayah.ayah(), wordPosition);
    }
}