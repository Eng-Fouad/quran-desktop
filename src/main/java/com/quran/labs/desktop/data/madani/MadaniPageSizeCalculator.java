package com.quran.labs.desktop.data.madani;

import com.quran.labs.desktop.data.source.DisplaySize;
import com.quran.labs.desktop.data.source.PageSizeCalculator;

public final class MadaniPageSizeCalculator implements PageSizeCalculator {

    private final DisplaySize displaySize;
    private final int maxWidth;
    private String overrideParam;

    public MadaniPageSizeCalculator(DisplaySize displaySize) {
        this.displaySize = displaySize;
        this.maxWidth = Math.max(displaySize.x(), displaySize.y());
    }

    @Override
    public String getWidthParameter() {
        if (overrideParam != null) {
            return overrideParam;
        } else {
            if (maxWidth <= 320) {
                return "320";
            } else if (maxWidth <= 480) {
                return "480";
            } else if (maxWidth <= 800) {
                return "800";
            } else if (maxWidth <= 1280) {
                return "1024";
            } else {
                return "1260";
            }
        }
    }

    @Override
    public String getTabletWidthParameter() {
        return overrideParam.equals("1920") ? "1024" : getWidthParameter();
    }

    @Override
    public void setOverrideParameter(String parameter) {
        this.overrideParam = parameter != null && !parameter.isBlank() ? parameter : null;
    }

    public DisplaySize displaySize() {
        return displaySize;
    }

}