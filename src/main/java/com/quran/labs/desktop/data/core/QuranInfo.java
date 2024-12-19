package com.quran.labs.desktop.data.core;

import com.quran.labs.desktop.data.source.QuranDataSource;
import com.quran.labs.desktop.data.model.SuraAyah;
import com.quran.labs.desktop.data.model.VerseRange;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

public record QuranInfo(int numberOfPages, int[] pageForSuraArray, int[] suraForPageArray, int[] ayahForPageArray,
                        int[] pageForJuzArray, Map<Integer, Integer> juzDisplayPageArrayOverride,
                        int[] numberOfAyahsForSuraArray, boolean[] isMakkiBySuraArray, int[] quarterStartByPage,
                        SuraAyah[] quartersArray, int pagesToSkip, int firstPage,
                        int numberOfPagesConsideringSkipped, int numberOfPagesDual) {

    public QuranInfo(QuranDataSource quranDataSource) {
        this(quranDataSource.numberOfPages(), quranDataSource.pageForSuraArray(), quranDataSource.suraForPageArray(),
             quranDataSource.ayahForPageArray(), quranDataSource.pageForJuzArray(),
             quranDataSource.juzDisplayPageArrayOverride(), quranDataSource.numberOfAyahsForSuraArray(),
             quranDataSource.isMakkiBySuraArray(), quranDataSource.quarterStartByPage(),
             quranDataSource.quartersArray(), quranDataSource.pagesToSkip(),
             QuranConstants.PAGES_FIRST + quranDataSource.pagesToSkip(),
             quranDataSource.numberOfPages() - quranDataSource.pagesToSkip(),
             (quranDataSource.numberOfPages() - quranDataSource.pagesToSkip()) / 2 +
             (quranDataSource.numberOfPages() - quranDataSource.pagesToSkip()) % 2);
    }

    public int getStartingPageForJuz(int juz) {
        return pageForJuzArray[juz - 1];
    }

    public int getPageNumberForSura(int sura) {
        return pageForSuraArray[sura - 1];
    }

    public boolean isValidPage(int page) {
        return IntStream.rangeClosed(firstPage, numberOfPages).anyMatch(i -> page == i);
    }

    public int getSuraNumberFromPage(int page) {
        var sura = -1;
        for (int i = 0; i < QuranConstants.SURA_COUNT; i++) {
            if (pageForSuraArray[i] == page) {
                sura = i + 1;
                break;
            } else if (pageForSuraArray[i] > page) {
                sura = i;
                break;
            }
        }
        return sura;
    }

    public List<Integer> getListOfSurahWithStartingOnPage(int page) {
        int startIndex = suraForPageArray[page - 1] - 1;
        List<Integer> result = new ArrayList<>();
        for (int i = startIndex; i < QuranConstants.SURA_COUNT; i++) {
            if (pageForSuraArray[i] == page) {
                result.add(i + 1);
            } else if (pageForSuraArray[i] > page) break;
        }
        return result;
    }

    public VerseRange getVerseRangeForPage(int page) {
        int[] result = getPageBounds(page);
        int versesInRange = 1 + Math.abs(getAyahId(result[0], result[1]) - getAyahId(result[2], result[3]));
        return new VerseRange(result[0], result[1], result[2], result[3], versesInRange);
    }

    public int getFirstAyahOnPage(int page) {
        return ayahForPageArray[page - 1];
    }

    public int[] getPageBounds(int inputPage) {
        int page;
        if (inputPage > numberOfPages) page = numberOfPages;
        else page = Math.max(inputPage, firstPage);

        int[] bounds = new int[4];
        bounds[0] = suraForPageArray[page - 1];
        bounds[1] = ayahForPageArray[page - 1];
        if (page == numberOfPages) {
            bounds[2] = QuranConstants.LAST_SURA;
            bounds[3] = 6;
        } else {
            int nextPageSura = suraForPageArray[page];
            int nextPageAyah = ayahForPageArray[page];
            if (nextPageSura == bounds[0]) {
                bounds[2] = bounds[0];
                bounds[3] = nextPageAyah - 1;
            } else {
                if (nextPageAyah > 1) {
                    bounds[2] = nextPageSura;
                    bounds[3] = nextPageAyah - 1;
                } else {
                    bounds[2] = nextPageSura - 1;
                    bounds[3] = numberOfAyahsForSuraArray[bounds[2] - 1];
                }
            }
        }
        return bounds;
    }

    public int getSuraOnPage(int page) {
        return suraForPageArray[page - 1];
    }

    public int getJuzFromPage(int page) {
        for (int i = 0; i < pageForJuzArray.length; i++) {
            if (pageForJuzArray[i] > page) {
                return i;
            } else if (pageForJuzArray[i] == page) {
                return i + 1;
            }
        }
        return 30;
    }

    public int getRub3FromPage(int page) {
        return page > numberOfPages || page < 1 ? -1 : quarterStartByPage[page - 1];
    }

    public int getPageFromSuraAyah(int sura, int ayah) {
        // basic bounds checking
        int currentAyah = ayah == 0 ? 1 : ayah;
        if (sura < 1 || sura > QuranConstants.SURA_COUNT ||currentAyah < QuranConstants.MIN_AYAH ||
            currentAyah > QuranConstants.MAX_AYAH) {
            return -1;
        }

        // what page does the sura start on?
        var index = pageForSuraArray[sura - 1] - 1;
        while (index < numberOfPages) {
            // what's the first sura in that page?
            int ss = suraForPageArray[index];

            // if we've passed the sura, return the previous page
            // or, if we're at the same sura and passed the ayah
            if (ss > sura || ss == sura && ayahForPageArray[index] > currentAyah) {
                break;
            }

            // otherwise, look at the next page
            index++;
        }

        return index;
    }

    public int getAyahId(int sura, int ayah) {
        var ayahId = 0;
        for (int i = 0; i < sura - 1; i++) {
            ayahId += numberOfAyahsForSuraArray[i];
        }
        ayahId += ayah;
        return ayahId;
    }

    /// Returns how many ayahs away end is from start (-ve if end is before start)
    public int diff(SuraAyah start, SuraAyah end) {
        return getAyahId(end.sura(), end.ayah()) - getAyahId(start.sura(), start.ayah());
    }

    public int getNumberOfAyahs(int sura) {
        return sura < 1 || sura > QuranConstants.SURA_COUNT ? -1 : numberOfAyahsForSuraArray[sura - 1];
    }

    public int getNumberOfAyahsInQuran() {
        return IntStream.of(numberOfAyahsForSuraArray).sum();
    }

    public int getPageFromPosition(int position, boolean isDualPagesVisible) {
        if (isDualPagesVisible) {
            // return the "first" page in a tablet view
            // i.e. for [page 2][page 1] should return [page 1].
            // similarly, for Naskh, [page 3][page 2] should return [page 2].
            return (((numberOfPagesDual - position) * 2) + pagesToSkip) - 1;
        } else {
            return (numberOfPagesConsideringSkipped - position) + pagesToSkip;
        }
    }

    public int getPositionFromPage(int page, boolean isDualPagesVisible) {
        if (isDualPagesVisible) {
            int pageToUse = page % 2 != 0 ? page + 1 : page;
            int delta = page % 2 != 0 ? pagesToSkip : 0;
            return numberOfPagesDual - pageToUse / 2 + delta;
        } else {
            return (numberOfPagesConsideringSkipped - page) + pagesToSkip;
        }
    }

    public int mapDualPageToSinglePage(int page) {
        // selects the "first" page when mapping this dual page to a single page
        // i.e. maps "left | right" => "right" (i.e. to first landscape page)
        int amount = pagesToSkip % 2;
        return page % 2 == amount ? page - 1 : page;
    }

    public int mapSinglePageToDualPage(int page) {
        // selects the "second" page when viewing this page by another
        // i.e. "left | right" => "left" irrespective of which is chosen, left/right
        int amount = pagesToSkip % 2;
        return page % 2 != amount ? page + 1 : page;
    }

    /// Gets the juz' that should be printed at the top of the page
    /// This may be different than the actual juz' for the page (for example, juz' 7 starts at page
    /// 121, but despite this, the title of the page is juz' 6).
    ///
    /// @param page the page
    /// @return the display juz' display string for the page
    public int getJuzForDisplayFromPage(int page) {
        int actualJuz = getJuzFromPage(page);
        Integer overriddenJuz = juzDisplayPageArrayOverride.get(page);
        return overriddenJuz != null ? overriddenJuz : actualJuz;
    }

    public SuraAyah getSuraAyahFromAyahId(int ayahId) {
        var sura = 0;
        var ayahIdentifier = ayahId;
        while (ayahIdentifier > numberOfAyahsForSuraArray[sura]) {
            ayahIdentifier -= numberOfAyahsForSuraArray[sura++];
        }
        return new SuraAyah(sura + 1, ayahIdentifier);
    }

    public SuraAyah getQuarterByIndex(int quarter) {
        return quartersArray[quarter];
    }

    public int getJuzFromSuraAyah(int sura, int ayah, int juz) {
        if (juz == 30) {
            return juz;
        }

        // get the starting point of the next juz'
        var lastQuarter = quartersArray[juz * 8];

        // if we're after that starting point, return juz + 1
        if (sura > lastQuarter.sura() || lastQuarter.sura() == sura && ayah >= lastQuarter.ayah()) {
            return juz + 1;
        } else {
            // otherwise just return this juz
            return juz;
        }
    }

    public boolean isMakki(int sura) {
        return isMakkiBySuraArray[sura - 1];
    }
}