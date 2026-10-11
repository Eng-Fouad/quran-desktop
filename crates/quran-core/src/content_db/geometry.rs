//! Canonical surah geometry: which ayah ids and word ids belong to a chapter (Hafs, 6,236 ayahs, 83,665 words).
//! Owner: WP1c.
//!
//! content.db stores WBW rows by word id and tafsir rows by ayah id, without a surah column (§3.3), yet chapters are
//! fetched, stamped, replaced and cleared one surah at a time. Because ayah ids and word ids are dense and ordered by
//! (surah, ayah, position) (§0.2), a surah is exactly one contiguous range of each, fixed by the per-surah counts below.
//! The word counts include the end-of-ayah markers (one per ayah) and were derived from the QPC Hafs word list that
//! core.db is built from (QDC `verses/by_page`, mushaf 1, 2026-10-10: 83,665 locations; G1). The `content_geometry`
//! integration test cross-checks them against a built core.db (`QD_CORE_DB`).

use std::ops::RangeInclusive;

use quran_types::{AYAH_COUNT, SURAH_COUNT, WORD_COUNT};

/// Ayahs per surah, surah 1 first (canonical Hafs count; sums to 6,236).
const AYAHS: [u32; 114] = [
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
    112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89,
    59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30,
    52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15,
    21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

/// Words per surah including end markers, surah 1 first (sums to 83,665).
const WORDS: [u32; 114] = [
    36, 6402, 3681, 3923, 2924, 3215, 3526, 1308, 2627, 1942, 2040, 1888, 896, 882, 754, 1972,
    1667, 1689, 1059, 1470, 1281, 1352, 1168, 1380, 970, 1545, 1244, 1518, 1045, 877, 580, 402,
    1360, 937, 820, 808, 1042, 821, 1247, 1304, 848, 913, 919, 405, 525, 678, 577, 589, 365, 418,
    420, 361, 422, 397, 429, 475, 603, 494, 469, 361, 235, 186, 191, 259, 299, 261, 363, 352, 310,
    261, 254, 313, 219, 311, 204, 274, 231, 213, 225, 175, 133, 99, 205, 132, 131, 78, 91, 118,
    167, 102, 69, 92, 51, 35, 42, 91, 35, 102, 44, 51, 47, 36, 17, 42, 28, 21, 32, 13, 32, 22, 28,
    19, 28, 26,
];

/// `FIRST[s - 1]` is the first id of surah `s`; `FIRST[114]` is one past the last id.
const fn firsts(counts: &[u32; 114]) -> [u32; 115] {
    let mut out = [0u32; 115];
    out[0] = 1;
    let mut i = 0;
    while i < 114 {
        out[i + 1] = out[i] + counts[i];
        i += 1;
    }
    out
}

const FIRST_AYAH: [u32; 115] = firsts(&AYAHS);
const FIRST_WORD: [u32; 115] = firsts(&WORDS);

// The tables are the canonical totals (checked at compile time).
const _: () = assert!(FIRST_AYAH[114] == AYAH_COUNT + 1);
const _: () = assert!(FIRST_WORD[114] == WORD_COUNT + 1);
const _: () = assert!(SURAH_COUNT as usize == AYAHS.len());

/// `[first, next first)` of surah `surah` in a prefix table, as an inclusive range.
fn range(table: &[u32; 115], surah: u32) -> Option<RangeInclusive<u32>> {
    let i = usize::try_from(surah.checked_sub(1)?).ok()?;
    let first = *table.get(i)?;
    let next = *table.get(i.checked_add(1)?)?;
    Some(first..=next.checked_sub(1)?)
}

/// The ayah ids of `surah` (1..=114), e.g. surah 2 → `8..=293`.
#[must_use]
pub fn surah_ayah_ids(surah: u32) -> Option<RangeInclusive<u32>> {
    range(&FIRST_AYAH, surah)
}

/// The word ids of `surah` (1..=114), end markers included, e.g. surah 1 → `1..=36`.
#[must_use]
pub fn surah_word_ids(surah: u32) -> Option<RangeInclusive<u32>> {
    range(&FIRST_WORD, surah)
}

/// The number of ayahs of `surah` (1..=114).
#[must_use]
pub fn surah_ayah_count(surah: u32) -> Option<u32> {
    let i = usize::try_from(surah.checked_sub(1)?).ok()?;
    AYAHS.get(i).copied()
}

/// `(surah, ayah)` of an ayah id (1..=6236).
#[must_use]
pub fn ayah_ref(ayah_id: u32) -> Option<(u32, u32)> {
    if !(1..=AYAH_COUNT).contains(&ayah_id) {
        return None;
    }
    // FIRST_AYAH is strictly increasing: the surah is the last entry whose first ayah is ≤ ayah_id.
    let idx = FIRST_AYAH.partition_point(|&first| first <= ayah_id);
    let surah = u32::try_from(idx).ok()?;
    let first = *FIRST_AYAH.get(idx.checked_sub(1)?)?;
    Some((surah, ayah_id - first + 1))
}

/// The surah a word id (1..=83,665) belongs to.
#[must_use]
pub fn surah_of_word(word_id: u32) -> Option<u32> {
    if !(1..=WORD_COUNT).contains(&word_id) {
        return None;
    }
    u32::try_from(FIRST_WORD.partition_point(|&first| first <= word_id)).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn known_surahs() {
        assert_eq!(surah_ayah_ids(1), Some(1..=7));
        assert_eq!(surah_ayah_ids(2), Some(8..=293));
        assert_eq!(surah_ayah_ids(114), Some(6231..=6236));
        assert_eq!(surah_word_ids(1), Some(1..=36));
        assert_eq!(surah_word_ids(2), Some(37..=6438));
        assert_eq!(surah_word_ids(114), Some(83_640..=83_665));
        assert_eq!(surah_ayah_count(2), Some(286));
        assert_eq!(surah_ayah_count(9), Some(129));
        for bad in [0, 115, u32::MAX] {
            assert_eq!(surah_ayah_ids(bad), None);
            assert_eq!(surah_word_ids(bad), None);
            assert_eq!(surah_ayah_count(bad), None);
        }
    }

    #[test]
    fn ranges_tile_the_quran() {
        let mut next_ayah = 1;
        let mut next_word = 1;
        for s in 1..=SURAH_COUNT {
            let ayahs = surah_ayah_ids(s).unwrap();
            let words = surah_word_ids(s).unwrap();
            assert_eq!(*ayahs.start(), next_ayah);
            assert_eq!(*words.start(), next_word);
            // Every ayah has at least one word and its end marker.
            assert!(words.end() - words.start() + 1 >= 2 * (ayahs.end() - ayahs.start() + 1));
            next_ayah = ayahs.end() + 1;
            next_word = words.end() + 1;
        }
        assert_eq!(next_ayah, AYAH_COUNT + 1);
        assert_eq!(next_word, WORD_COUNT + 1);
    }

    #[test]
    fn ayah_refs_round_trip() {
        assert_eq!(ayah_ref(1), Some((1, 1)));
        assert_eq!(ayah_ref(7), Some((1, 7)));
        assert_eq!(ayah_ref(8), Some((2, 1)));
        assert_eq!(ayah_ref(262), Some((2, 255)));
        assert_eq!(ayah_ref(6236), Some((114, 6)));
        assert_eq!(ayah_ref(0), None);
        assert_eq!(ayah_ref(6237), None);
        for id in 1..=AYAH_COUNT {
            let (s, a) = ayah_ref(id).unwrap();
            assert_eq!(surah_ayah_ids(s).unwrap().start() + a - 1, id);
        }
    }

    #[test]
    fn words_map_to_their_surah() {
        assert_eq!(surah_of_word(1), Some(1));
        assert_eq!(surah_of_word(36), Some(1));
        assert_eq!(surah_of_word(37), Some(2));
        assert_eq!(surah_of_word(WORD_COUNT), Some(114));
        assert_eq!(surah_of_word(0), None);
        assert_eq!(surah_of_word(WORD_COUNT + 1), None);
        for s in 1..=SURAH_COUNT {
            let words = surah_word_ids(s).unwrap();
            assert_eq!(surah_of_word(*words.start()), Some(s));
            assert_eq!(surah_of_word(*words.end()), Some(s));
        }
    }
}
