package com.quran.labs.desktop.data.model.highlight;

public record HighlightInfo(int sura, int ayah, int word, HighlightType highlightType, boolean scrollToAyah){}