package com.quran.labs.desktop.data.model.highlight;

public record HighlightType(long id, int colorResId, Mode mode, boolean isSingle, boolean isTransitionAnimated) implements Comparable<HighlightType> {

    public enum Mode {
        HIGHLIGHT,  // Highlights the text of the ayah (rectangular overlay on the text)
        BACKGROUND, // Applies a background color to the entire line (full height/width, even ayahs that are centered like first 2 pages)
        UNDERLINE,  // Draw an underline below the text of the ayah
        COLOR,      // Change the text color of the ayah/word (apply a color filter)
        HIDE        // Hide the ayah/word (i.e. won't be rendered)
    }

    public HighlightType(long id, int colorResId, Mode mode) {
        this(id, colorResId, mode, false, false);
    }

    @Override
    public int compareTo(HighlightType other) {
        return Long.compare(this.id, other.id);
    }
}