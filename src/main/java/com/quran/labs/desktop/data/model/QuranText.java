package com.quran.labs.desktop.data.model;

public record QuranText(int sura, int ayah, String text, String extraData) {
    public QuranText(int sura, int ayah, String text) {
        this(sura, ayah, text, null);
    }
}