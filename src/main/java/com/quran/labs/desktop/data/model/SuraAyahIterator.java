package com.quran.labs.desktop.data.model;

import com.quran.labs.desktop.data.core.QuranInfo;

import java.util.Iterator;

public final class SuraAyahIterator implements Iterator<Boolean> {

    private final QuranInfo quranInfo;
    private final SuraAyah start;
    private final SuraAyah end;
    private boolean started = false;
    private int sura = 0;
    private int ayah = 0;

    public SuraAyahIterator(QuranInfo quranInfo, SuraAyah start, SuraAyah end) {
        this.quranInfo = quranInfo;

        // Sanity check
        if ((start.compareTo(end)) <= 0) {
            this.start = start;
            this.end = end;
        } else {
            this.start = end;
            this.end = start;
        }
        reset();
    }

    @Override
    public boolean hasNext() {
        return !started || sura < end.sura() || ayah < end.ayah();
    }

    @Override
    public Boolean next() {
        if (!started) {
            started = true;
            return true;
        } else if (!hasNext()) {
            return false;
        }
        if (ayah < quranInfo.getNumberOfAyahs(sura)) {
            ayah++;
        } else {
            ayah = 1;
            sura++;
        }
        return true;
    }

    public SuraAyah currentAyah() {
        return new SuraAyah(sura, ayah);
    }

    private void reset() {
        sura = start.sura();
        ayah = start.ayah();
        started = false;
    }
}