package com.quran.labs.desktop.home.ui;

import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.fx.MountableFxController;
import com.quran.labs.desktop.core.ui.BodyFxController;
import com.quran.labs.desktop.core.ui.GuiFactory;
import com.quran.labs.desktop.core.ui.MainFxController;
import io.quarkiverse.fx.views.FxViewRepository;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.collections.FXCollections;
import javafx.fxml.FXML;
import javafx.scene.control.Button;
import javafx.scene.control.MenuButton;
import javafx.scene.control.MenuItem;
import org.controlsfx.glyphfont.FontAwesome;

import java.util.ResourceBundle;

/**
 * FX controller for the action bar pane.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ActionBarFxController extends FxControllerBase implements MountableFxController, LanguageChangeAware {

    @Inject MainFxController mainFxController;
    @Inject BodyFxController bodyFxController;
    @Inject FxViewRepository fxViewRepository;
    @Inject GuiStateManager guiStateManager;
    @Inject GuiFactory guiFactory;

    @FXML MenuButton mbLanguage;
    @FXML Button btnSearch;
    @FXML Button btnSettings;

    @Override
    protected void initialize() {
        // specify icons for buttons
        mbLanguage.setGraphic(guiFactory.createFontAwesomeIcon(FontAwesome.Glyph.GLOBE));
        btnSearch.setGraphic(guiFactory.createFontAwesomeIcon(FontAwesome.Glyph.SEARCH));
        btnSettings.setGraphic(guiFactory.createFontAwesomeIcon(FontAwesome.Glyph.GEAR));

        var languageMenuItems = FXCollections.<MenuItem>observableArrayList();
        for (var guiLanguage : GuiLanguage.values()) {
            var menuItem = new MenuItem(guiLanguage.toString());
            menuItem.setOnAction(_ -> {
                boolean changed = mainFxController.switchUiLanguage(guiLanguage);
                if (changed) {
                    for (var item : languageMenuItems) {
                        if (item.getText().equals(guiLanguage.toString())) {
                            item.setGraphic(guiFactory.createFontAwesomeIcon(FontAwesome.Glyph.CHECK));
                        } else {
                            item.setGraphic(null);
                        }
                    }
                }
            });
            languageMenuItems.add(menuItem);
        }
        mbLanguage.getItems().setAll(languageMenuItems);
    }

    @Override
    public void onMount() {
        for (var item : mbLanguage.getItems()) {
            if (item.getText().equals(guiStateManager.getCurrentGuiLanguage().toString())) {
                item.setGraphic(guiFactory.createFontAwesomeIcon(FontAwesome.Glyph.CHECK));
                break;
            }
        }
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}