package com.quran.labs.desktop.data.source;

import com.quran.labs.desktop.data.model.audio.Qari;

import java.util.List;

public interface PageProvider {
    QuranDataSource getDataSource();
    PageSizeCalculator getPageSizeCalculator(DisplaySize displaySize);

    int getImageVersion();

    String getImagesBaseUrl();
    String getImagesZipBaseUrl();
    String getPatchBaseUrl();
    String getAyahInfoBaseUrl();
    String getDatabasesBaseUrl();
    String getAudioDatabasesBaseUrl();

    String getAudioDirectoryName();
    String getDatabaseDirectoryName();
    String getAyahInfoDirectoryName();
    String getImagesDirectoryName();

    default boolean ayahInfoDbHasGlyphData() {
        return false;
    }

    int getPreviewTitle();
    int getPreviewDescription();

    default PageContentType getPageContentType() {
        return PageContentType.IMAGE;
    }

    default String getFallbackPageType() {
        return null;
    }

    List<Qari> getQaris();
    int getDefaultQariId();
    default String pageType() {
        return "";
    }
}