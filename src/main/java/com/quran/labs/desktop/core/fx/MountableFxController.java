package com.quran.labs.desktop.core.fx;

public interface MountableFxController {
    default void onMount(){}
    default void onDismount(){}
}