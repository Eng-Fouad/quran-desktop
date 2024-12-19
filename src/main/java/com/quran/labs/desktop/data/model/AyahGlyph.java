package com.quran.labs.desktop.data.model;

import java.io.Serializable;
import java.util.Comparator;

public sealed interface AyahGlyph extends Comparable<AyahGlyph>, Serializable {

    SuraAyah ayah();
    int position();

    record HizbGlyph(SuraAyah ayah, int position) implements AyahGlyph {}
    record SajdahGlyph(SuraAyah ayah, int position) implements AyahGlyph {}
    record PauseGlyph(SuraAyah ayah, int position) implements AyahGlyph {}
    record AyahEndGlyph(SuraAyah ayah, int position) implements AyahGlyph {}
    record WordGlyph(SuraAyah ayah, int position, int wordPosition) implements AyahGlyph {
        public AyahWord toAyahWord() {
            return new AyahWord(ayah, wordPosition);
        }
    }

    @SuppressWarnings("NullableProblems")
    @Override
    default int compareTo(AyahGlyph other) {
        return Comparator.comparing(AyahGlyph::ayah).thenComparing(AyahGlyph::position).compare(this, other);
    }
}