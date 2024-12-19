package com.quran.labs.desktop.data.model;

import java.util.Comparator;

/// Reference to a portion in the Quran. Can be a single id (e.g. 18:1)
/// or can be multiple such as a range of ayahs (e.g. 18:1 to 18:10)
@SuppressWarnings("NullableProblems")
public interface QuranRef {

    QuranRef NONE = new QuranRef(){};
    QuranId THE_QURAN = new QuranId(){};

    /// Reference to a single Quran Identifier
    /// (e.g. single word, ayatul kursi, pg. 23, Al-Kahf, 30th Juz2, ...)
    interface QuranId extends QuranRef {}

    /// Reference to a range of Quran IDs
    /// (e.g. ayahs 18:1-18:10, pgs. 582-604, Juz' 30-30, surahs Al-Naba'-Al-Nas, ...)
    sealed interface Range<T extends QuranId> extends QuranRef permits QuranRange {}

    record Word(Ayah ayah, int word) implements QuranId, Comparable<Word> {
        @Override
        public int compareTo(Word other) {
            return Comparator.comparing(Word::ayah).thenComparing(Word::word).compare(this, other);
        }
    }
    record Ayah(int sura, int ayah) implements QuranId, Comparable<Ayah> {
        @Override
        public int compareTo(Ayah other) {
            return Comparator.comparing(Ayah::sura).thenComparing(Ayah::ayah).compare(this, other);
        }
    }
    record Sura(int sura) implements QuranId, Comparable<Sura> {
        @Override
        public int compareTo(Sura other) {
            return Integer.compare(sura, other.sura);
        }
    }
    record Page(int page) implements QuranId, Comparable<Page> {
        @Override
        public int compareTo(Page other) {
            return Integer.compare(page, other.page);
        }
    }
    record Rub3(int rub3) implements QuranId, Comparable<Rub3> {
        @Override
        public int compareTo(Rub3 other) {
            return Integer.compare(rub3, other.rub3);
        }
    }
    record Hizb(int hizb) implements QuranId, Comparable<Hizb> {
        @Override
        public int compareTo(Hizb other) {
            return Integer.compare(hizb, other.hizb);
        }
    }
    record Juz2(int juz2) implements QuranId, Comparable<Juz2> {
        @Override
        public int compareTo(Juz2 other) {
            return Integer.compare(juz2, other.juz2);
        }
    }
    record QuranRange<T extends QuranId>(T start, T endInclusive) implements Range<T> {}
}