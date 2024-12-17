package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.data.GuiStateManager;
import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.collections.FXCollections;
import javafx.fxml.FXML;
import javafx.scene.control.Button;
import javafx.scene.control.MenuButton;
import javafx.scene.control.MenuItem;
import org.kordamp.ikonli.carbonicons.CarbonIcons;
import org.kordamp.ikonli.javafx.FontIcon;

import java.util.ResourceBundle;

/**
 * FX controller for the action bar pane.
 *
 * @author Fouad Almalki
 */
@Singleton
public class ActionBarFxController extends FxControllerBase implements LanguageChangeAware {

    @Inject MainFxController mainFxController;
    @Inject GuiStateManager guiStateManager;

    @FXML MenuButton mbLanguage;
    @FXML Button btnSearch;
    @FXML Button btnSettings;

    @Override
    protected void initialize() {
        var checkIcon = new FontIcon(CarbonIcons.CHECKMARK);
        checkIcon.setIconSize(14);
        var languageMenuItems = FXCollections.<MenuItem>observableArrayList();
        for (var guiLanguage : GuiLanguage.values()) {
            var menuItem = new MenuItem(guiLanguage.toString());
            menuItem.setOnAction(_ -> {
                boolean changed = mainFxController.switchUiLanguage(guiLanguage);
                if (changed) {
                    for (var item : languageMenuItems) {
                        if (item.getText().equals(guiLanguage.toString())) {
                            item.setGraphic(checkIcon);
                        } else {
                            item.setGraphic(null);
                        }
                    }
                }
            });
            languageMenuItems.add(menuItem);
        }
        mbLanguage.getItems().setAll(languageMenuItems);
        for (var item : mbLanguage.getItems()) {
            if (item.getText().equals(guiStateManager.getCurrentGuiLanguage().toString())) {
                item.setGraphic(checkIcon);
                break;
            }
        }
    }

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }
}