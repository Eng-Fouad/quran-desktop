package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.ListView;

import java.util.ResourceBundle;

/**
 * FX controller for Hizb list.
 *
 * @author Fouad Almalki
 */
@Singleton
@RegisterForReflection
public class HizbListFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @FXML ListView<?> lvHizbList;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}