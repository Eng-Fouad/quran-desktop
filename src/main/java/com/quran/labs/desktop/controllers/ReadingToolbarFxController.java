package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Singleton;
import javafx.beans.binding.Bindings;
import javafx.fxml.FXML;
import javafx.scene.control.Label;
import javafx.scene.control.Slider;
import javafx.scene.control.TextField;
import javafx.scene.control.ToggleButton;
import org.controlsfx.control.SegmentedButton;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ReadingToolbarFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @FXML SegmentedButton sbReadingLayout;
    @FXML ToggleButton tbZoomedSinglePage;
    @FXML ToggleButton tbFullOnePage;
    @FXML ToggleButton tbFullTwoPages;
    @FXML TextField txtChapter;
    @FXML TextField txtPart;
    @FXML TextField txtPage;
    @FXML Label lblPart;
    @FXML Label lblChapter;
    @FXML Label lblPage;
    @FXML Slider sPage;

    @Override
    protected void initialize() {
        txtPage.textProperty().bind(Bindings.format("%.0f", sPage.valueProperty()));
        sbReadingLayout.getToggleGroup().selectedToggleProperty().addListener((_, oldVal, newVal) -> {
            if (newVal == null) oldVal.setSelected(true);
        });
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        lblPart.setText(resources.getString("label.part"));
        lblChapter.setText(resources.getString("label.chapter"));
        lblPage.setText(resources.getString("label.page"));
    }
}