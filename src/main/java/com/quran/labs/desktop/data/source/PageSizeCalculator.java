package com.quran.labs.desktop.data.source;

public interface PageSizeCalculator {
    String getWidthParameter();
    String getTabletWidthParameter();
    void setOverrideParameter(String parameter);
}