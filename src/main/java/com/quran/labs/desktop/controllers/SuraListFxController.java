package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.utils.GuiUtils;
import com.quran.labs.desktop.data.QuranDataProvider;
import com.quran.labs.desktop.data.model.SuraNavRow;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;
import javafx.application.Platform;
import javafx.collections.FXCollections;
import javafx.css.PseudoClass;
import javafx.fxml.FXML;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.control.Label;
import javafx.scene.control.ListCell;
import javafx.scene.control.ListView;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.VBox;
import javafx.scene.text.Font;
import javafx.scene.text.FontWeight;

import java.util.ResourceBundle;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * FX controller for Sura list.
 *
 * @author Fouad Almalki
 */
@Singleton
@RegisterForReflection
public class SuraListFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    private static final PseudoClass HEADER_PSEUDO_CLASS = PseudoClass.getPseudoClass("header");

    @Inject QuranDataProvider quranDataProvider;
    @Inject ReadingViewFxController readingViewFxController;

    @FXML ListView<SuraNavRow> lvSuraList;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
        lvSuraList.getItems().setAll(FXCollections.observableList(quranDataProvider.suraNavRows()));
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
                    rowControl.rowDataApplier().accept(this, item);
                    setGraphic(rowControl.rowNode());
                }
            }
        });
        lvSuraList.getItems().setAll(FXCollections.observableList(quranDataProvider.suraNavRows()));

        // workaround to fix a bug of sync issues between the listview and its scrollbar
        Platform.runLater(() -> lvSuraList.requestFocus());

        lvSuraList.getSelectionModel().selectedItemProperty().addListener((_, oldValue, newValue) -> {
            if (newValue != null && (oldValue == null || oldValue.page() != newValue.page())) {
                readingViewFxController.setPage(newValue.page());
            }
        });
        lvSuraList.getSelectionModel().select(1);
    }

    private record RowControl(Node rowNode, BiConsumer<ListCell<SuraNavRow>, SuraNavRow> rowDataApplier){}
    private RowControl constructSuraNavRowNode() {
        var panRow = new HBox();
        panRow.setAlignment(Pos.CENTER);
        var panJuz = new HBox();
        var panSura = new HBox();
        panSura.setAlignment(Pos.CENTER_LEFT);
        var panContent = new StackPane(panJuz, panSura);
        HBox.setHgrow(panContent, Priority.ALWAYS);
        panContent.getChildren().addAll();
        var lblPage = new Label();
        lblPage.setFont(Font.font(lblPage.getFont().getFamily(), 11.0));
        panRow.getChildren().addAll(panContent, lblPage);
        var panDoubleLine = new VBox();
        panDoubleLine.setAlignment(Pos.CENTER_LEFT);

        var lblJuz = new Label();
        lblJuz.setFont(Font.font(lblJuz.getFont().getFamily(), FontWeight.BOLD, 11.0));
        panJuz.getChildren().add(lblJuz);
        var lblSuraIndex = new Label();
        lblSuraIndex.setFont(Font.font(lblSuraIndex.getFont().getFamily(), FontWeight.BOLD, 13.0));
        lblSuraIndex.setPadding(new Insets(0.0, 20.0, 0.0, 10.0));
        var lblSuraName = new Label();
        lblSuraName.setFont(Font.font(lblSuraName.getFont().getFamily(), FontWeight.BOLD, 13.0));
        var lblSuraMetadata = new Label();
        lblSuraMetadata.setFont(Font.font(lblSuraMetadata.getFont().getFamily(), 10.0));
        panSura.getChildren().addAll(lblSuraIndex, panDoubleLine);
        panDoubleLine.getChildren().addAll(lblSuraName, lblSuraMetadata);

        BiConsumer<ListCell<SuraNavRow>, SuraNavRow> rowDataApplier = (listCell, row) -> {
            GuiUtils.showNode(panJuz, false);
            GuiUtils.showNode(panSura, false);
            if (row.type() == SuraNavRow.SuraNavRowType.JUZ) {
                lblJuz.setText("%s %d".formatted(resources.getString("label.juz"), row.index()));
                listCell.pseudoClassStateChanged(HEADER_PSEUDO_CLASS, true);
                GuiUtils.showNode(panJuz, true);
            } else {
                lblSuraIndex.setText("%d".formatted(row.index()));
                lblSuraName.setText("%s %s".formatted(resources.getString("label.sura"),
                                                      resources.getString("label.sura." + row.index())));
                lblSuraMetadata.setText("%s - %d %s".formatted(
                        row.makki() ? resources.getString("label.makki") :
                                      resources.getString("label.madani"),
                        row.ayahCount(), row.ayahCount() > 10 ? resources.getString("label.ayahGreaterThan10") :
                                                                resources.getString("label.ayah10OrLess")));
                listCell.pseudoClassStateChanged(HEADER_PSEUDO_CLASS, false);
                GuiUtils.showNode(panSura, true);
            }
            lblPage.setText("%d".formatted(row.page()));
        };
        return new RowControl(panRow, rowDataApplier);
    }
}