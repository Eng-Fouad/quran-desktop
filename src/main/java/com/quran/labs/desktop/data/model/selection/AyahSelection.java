package com.quran.labs.desktop.data.model.selection;

import com.quran.labs.desktop.data.model.SuraAyah;

public interface AyahSelection {

    AyahSelection NONE = new AyahSelection(){};

    record Ayah(SuraAyah suraAyah, SelectionIndicator selectionIndicator) implements AyahSelection {
        public Ayah(SuraAyah suraAyah) {
            this(suraAyah, SelectionIndicator.NONE);
        }
    }

    record AyahRange(SuraAyah startSuraAyah, SuraAyah endSuraAyah,
                     SelectionIndicator selectionIndicator) implements AyahSelection {
        public AyahRange(SuraAyah startSuraAyah, SuraAyah endSuraAyah) {
            this(startSuraAyah, endSuraAyah, SelectionIndicator.NONE);
        }
    }

    default AyahSelection withSelectionIndicator(SelectionIndicator selectionIndicator) {
        if (this instanceof Ayah a) {
            return new Ayah(a.suraAyah(), selectionIndicator);
        } else if (this instanceof AyahRange ar) {
            return new AyahRange(ar.startSuraAyah(), ar.endSuraAyah(), selectionIndicator);
        } else {
            return this;
        }
    }

    default SelectionIndicator selectionIndicator() {
        if (this instanceof Ayah a) {
            return a.selectionIndicator();
        } else if (this instanceof AyahRange ar) {
            return ar.selectionIndicator();
        } else {
            return SelectionIndicator.NONE;
        }
    }

    default SuraAyah startSuraAyah() {
        if (this instanceof Ayah a) {
            return a.suraAyah();
        } else if (this instanceof AyahRange ar) {
            return ar.startSuraAyah();
        } else {
            return null;
        }
    }

    default SuraAyah endSuraAyah() {
        if (this instanceof Ayah a) {
            return a.endSuraAyah();
        } else if (this instanceof AyahRange ar) {
            return ar.endSuraAyah();
        } else {
            return null;
        }
    }
}