package com.quran.labs.desktop.data.source;

public interface PageContentType {
    PageContentType IMAGE = new PageContentType(){};
    record Line(float ratio, int lineHeight, boolean allowOverlapOfLines) implements PageContentType {}
}