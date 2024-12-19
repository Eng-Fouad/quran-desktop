package com.quran.labs.desktop.data.model;

public record QuranDataStatus(String portraitWidth, String landscapeWidth, boolean havePortrait, boolean haveLandscape,
                              String patchParam, int totalPages) {

    public boolean needPortrait() {
        return !havePortrait;
    }

    public boolean needLandscape() {
        return !haveLandscape;
    }
    public boolean havePages() {
        return havePortrait && haveLandscape;
    }
}