package com.quran.labs.desktop.core.fx;

/**
 * An interface that should be implemented by controllers that need to be triggered
 * on showing/hiding its corresponding UI region.
 *
 * @author Fouad Almalki
 */
public interface GuiVisibility {
    /**
     * Invoked on showing the corresponding UI region.
     */
    default void onShowing(){}

    /**
     * Invoked on hiding the corresponding UI region.
     */
    default void onHiding(){}
}