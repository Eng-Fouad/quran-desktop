package com.quran.labs.desktop.core.fx;

import javafx.fxml.FXML;

import java.net.URL;
import java.util.ResourceBundle;

/// A base class for all JavaFX controllers.
///
/// @author Fouad Almalki
public class FxControllerBase {

    /// Location of the FXML file.
    @FXML
    @SuppressWarnings("unused")
    protected URL location;

    /// The resource bundle passed to FXMLLoader at initialization.
    @FXML
    protected ResourceBundle resources;

    /// Called after the FXML is completely processed and the JavaFX nodes are created. All fields annotated with @FXML
    /// is processed before this method is called.
    @FXML
    protected void initialize() {}

    /// Get the resource bundle
    ///
    /// @return the resource bundle
    public ResourceBundle getResources() {
        return resources;
    }
}