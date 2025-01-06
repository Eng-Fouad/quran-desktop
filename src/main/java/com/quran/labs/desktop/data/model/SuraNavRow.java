package com.quran.labs.desktop.data.model;

public record SuraNavRow(
    SuraNavRowType type, int index, int page, Integer ayahCount, Boolean makki
){
    public enum SuraNavRowType {
        SURA, JUZ
    }

    public static SuraNavRow ofSura(int index, int page, int ayahCount, boolean makki) {
        return new SuraNavRow(SuraNavRowType.SURA, index, page, ayahCount, makki);
    }

    public static SuraNavRow ofJuz(int index, int page) {
        return new SuraNavRow(SuraNavRowType.JUZ, index, page, null, null);
    }
}