package com.quran.labs.desktop.controllers;

import com.quran.labs.desktop.core.enums.GuiLanguage;
import com.quran.labs.desktop.core.fx.FxControllerBase;
import com.quran.labs.desktop.core.fx.GuiVisibility;
import com.quran.labs.desktop.core.fx.LanguageChangeAware;
import com.quran.labs.desktop.core.utils.AppConstants;
import com.quran.labs.desktop.core.utils.GuiUtils;
import io.quarkus.runtime.annotations.RegisterForReflection;
import jakarta.inject.Singleton;
import javafx.fxml.FXML;
import javafx.scene.control.ScrollPane;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.layout.Pane;

import java.util.Locale;
import java.util.ResourceBundle;

/**
 * FX controller for the home UI, that is shown after login.
 *
 * @author Fouad Almalki
 */
@Singleton
@RegisterForReflection
public class ReadingViewFxController extends FxControllerBase implements LanguageChangeAware, GuiVisibility {

    @FXML ScrollPane panZoomedSinglePage;
    @FXML Pane panFullSinglePage;
    @FXML Pane panFullDoublePage;
    @FXML ImageView ivZoomedSinglePage;
    @FXML ImageView ivFullSinglePage;
    @FXML ImageView ivFullDoubleLeftPage;
    @FXML ImageView ivFullDoubleRightPage;

    int shownPage;
    PageLayout selectedPageLayout = PageLayout.FULL_SINGLE_PAGE;

    @Override
    public void onLanguageChanged(GuiLanguage language) {
        resources = ResourceBundle.getBundle(resources.getBaseBundleName(), language.getLocale());
    }

    public void setPage(int page) {
        shownPage = page;
        var pageImage = loadPageImage(page);
        switch (selectedPageLayout) {
            case ZOOMED_SINGLE_PAGE -> {
                ivFullSinglePage.setImage(null);
                ivFullDoubleLeftPage.setImage(null);
                ivFullDoubleRightPage.setImage(null);
                ivZoomedSinglePage.setImage(pageImage);
            }
            case FULL_SINGLE_PAGE -> {
                ivZoomedSinglePage.setImage(null);
                ivFullDoubleLeftPage.setImage(null);
                ivFullDoubleRightPage.setImage(null);
                ivFullSinglePage.setImage(pageImage);
            }
            case FULL_DOUBLE_PAGE -> {
                ivFullSinglePage.setImage(null);
                ivZoomedSinglePage.setImage(null);
                if (page % 2 == 0) {
                    var otherPageImage = loadPageImage(page - 1);
                    ivFullDoubleLeftPage.setImage(pageImage);
                    ivFullDoubleRightPage.setImage(otherPageImage);
                } else {
                    var otherPageImage = loadPageImage(page + 1);
                    ivFullDoubleRightPage.setImage(pageImage);
                    ivFullDoubleLeftPage.setImage(otherPageImage);
                }
            }
        }
    }

    public enum PageLayout {
        ZOOMED_SINGLE_PAGE,
        FULL_SINGLE_PAGE,
        FULL_DOUBLE_PAGE
    }
    public void setPageLayout(PageLayout pageLayout) {
        selectedPageLayout = pageLayout;
        switch (pageLayout) {
            case ZOOMED_SINGLE_PAGE -> {
                GuiUtils.showNode(panFullSinglePage, false);
                GuiUtils.showNode(panFullDoublePage, false);
                setPage(shownPage);
                GuiUtils.showNode(panZoomedSinglePage);
            }
            case FULL_SINGLE_PAGE -> {
                GuiUtils.showNode(panZoomedSinglePage, false);
                GuiUtils.showNode(panFullDoublePage, false);
                setPage(shownPage);
                GuiUtils.showNode(panFullSinglePage);
            }
            case FULL_DOUBLE_PAGE -> {
                GuiUtils.showNode(panZoomedSinglePage, false);
                GuiUtils.showNode(panFullSinglePage, false);
                setPage(shownPage);
                GuiUtils.showNode(panFullDoublePage);
            }
        }
    }

    private Image loadPageImage(int page) {
        return new Image(AppConstants.PATH_MADANI_PAGES_DIR.resolve(
                String.format(Locale.ENGLISH, "page%03d.png", page)).toUri().toString(), true);
    }
}