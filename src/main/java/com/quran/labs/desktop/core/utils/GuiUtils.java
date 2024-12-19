package com.quran.labs.desktop.core.utils;

import io.quarkus.logging.Log;
import io.quarkus.runtime.LaunchMode;
import javafx.scene.Node;
import javafx.scene.Scene;
import javafx.scene.control.TextFormatter;
import javafx.scene.control.TextInputControl;
import javafx.scene.input.KeyEvent;

import java.util.regex.Pattern;

/// Utility class for dealing with GUI components.
///
/// @author Fouad Almalki
public class GuiUtils {

    private static final Pattern NUMBERS_ONLY_PATTERN = Pattern.compile("\\d*");

    /**
     * Sets the visibility and managed state of a given {@link Node}.
     *
     * @param node  the {@link Node} to be shown or hidden.
     * @param bShow {@code true} to make the node visible and managed,
     *              {@code false} to hide the node and set it to be unmanaged.
     */
    public static void showNode(Node node, boolean bShow) {
        node.setVisible(bShow);
        node.setManaged(bShow);
    }

    /**
     * Makes a given {@link Node} visible and managed.
     *
     * @param node the {@link Node} to be shown.
     */
    public static void showNode(Node node) {
        showNode(node, true);
    }

    /**
     * Hides a given {@link Node} and sets it to be unmanaged.
     *
     * @param node the {@link Node} to be hidden.
     */
    public static void hideNode(Node node) {
        showNode(node, false);
    }

    public static void allowNumbersOnlyForTextInputControl(TextInputControl textInputControl) {
        textInputControl.setTextFormatter(new TextFormatter<>(change -> {
            if (NUMBERS_ONLY_PATTERN.matcher(change.getControlNewText()).matches()) {
                return change;
            } else {
                return null;
            }
        }));
    }

    public static void attachScenicViewInDevEnv(Scene scene) {
        if (LaunchMode.current() == LaunchMode.DEVELOPMENT) {
            scene.addEventFilter(KeyEvent.KEY_PRESSED, event -> {
                if(AppConstants.SCENIC_VIEW_KEY_COMBINATION.match(event)) {
                    Log.info("Showing ScenicView for UI debugging...");
                    try {
                        // invoking "org.scenicview.ScenicView.show(scene)" by Reflection API
                        var scenicViewClass = Class.forName("org.scenicview.ScenicView");
                        scenicViewClass.getMethod("show", Scene.class).invoke(null, scene);
                    }
                    catch(Throwable e) {
                        Log.error("Failed to load ScenicView!", e);
                    }
                }
            });
        }
    }
}