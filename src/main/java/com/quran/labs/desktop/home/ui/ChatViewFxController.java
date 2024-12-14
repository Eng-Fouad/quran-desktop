package com.quran.labs.desktop.home.ui;

import com.quran.labs.desktop.core.ui.GuiFactory;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.fx.MountableFxController;
import javafx.beans.binding.Bindings;
import javafx.beans.property.ObjectProperty;
import javafx.beans.property.SimpleObjectProperty;
import javafx.event.EventHandler;
import javafx.fxml.FXML;
import javafx.geometry.Point2D;
import javafx.geometry.Rectangle2D;
import javafx.scene.Node;
import javafx.scene.control.ScrollPane;
import javafx.scene.control.Slider;
import javafx.scene.control.Tab;
import javafx.scene.control.TextField;
import javafx.scene.control.ToggleButton;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.input.ScrollEvent;
import javafx.scene.layout.Pane;
import javafx.scene.shape.SVGPath;
import org.controlsfx.control.SegmentedButton;
import org.controlsfx.glyphfont.FontAwesome;

import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ChatViewFxController extends FxControllerBase implements MountableFxController, LanguageChangeAware {

    @Inject GuiFactory guiFactory;


    @FXML ImageView ivPage;
    @FXML Tab tabReading;
    @FXML Tab tabTranslations;
    @FXML SegmentedButton sbReadingLayout;
    @FXML ToggleButton tbZoomedSinglePage;
    @FXML ToggleButton tbFullOnePage;
    @FXML ToggleButton tbFullTwoPages;
    @FXML TextField txtChapter;
    @FXML TextField txtPart;
    @FXML TextField txtPage;
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
    }
}