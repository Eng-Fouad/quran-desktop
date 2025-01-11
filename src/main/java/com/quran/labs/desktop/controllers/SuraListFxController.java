package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.data.QuranDataProvider;
import com.quran.labs.desktop.data.model.SuraNavRow;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.collections.FXCollections;
import javafx.fxml.FXML;
import javafx.scene.Node;
import javafx.scene.control.Label;
import javafx.scene.control.ListCell;
import javafx.scene.control.ListView;

import java.util.ResourceBundle;
import java.util.function.Consumer;

/**
 * FX controller for Sura list.
 *
 * @author Fouad Almalki
 */
@Singleton
public class SuraListFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @Inject QuranDataProvider quranDataProvider;

    @FXML ListView<SuraNavRow> lvSuraList;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }

    @Override
    public void onShowing() {
        lvSuraList.setCellFactory(_ -> new ListCell<>() {

            final RowControl rowControl = constructSuraNavRowNode();

            @Override
            protected void updateItem(SuraNavRow item, boolean empty) {
                super.updateItem(item, empty);
                setText(null);

                if (empty || item == null) {
                    setGraphic(null);
                } else {
                    rowControl.rowDataApplier().accept(item);
                    setGraphic(rowControl.rowNode());
                }
            }
        });
        lvSuraList.setItems(FXCollections.observableList(quranDataProvider.suraNavRows()));
    }

    private record RowControl(Node rowNode, Consumer<SuraNavRow> rowDataApplier){}
    private static RowControl constructSuraNavRowNode() {
        Label label = new Label();
        Consumer<SuraNavRow> rowDataApplier = row -> {
            label.setText(String.valueOf(row.index()));
        };
        return new RowControl(label, rowDataApplier);
    }
}