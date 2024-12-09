package com.quran.labs.desktop.core.data;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped
public class GuiStateManager {

    private GuiLanguage currentGuiLanguage;

    public GuiLanguage getCurrentGuiLanguage() {
        return currentGuiLanguage;
    }

    public void setCurrentGuiLanguage(GuiLanguage currentGuiLanguage) {
        this.currentGuiLanguage = currentGuiLanguage;
    }
}