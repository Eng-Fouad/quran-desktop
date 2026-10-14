//! `SourceQuran { surahs, ayahs (with divisions), words (location → fields), layouts: [Layout { mushaf_id, pages: [Page {
//! lines: [RawLine { line, kind?, centered?, words: Vec<location> }] }] }] }`: the adapter-neutral intermediate both
//! adapters fill.
//!
//! An adapter (`qdc.rs`, `qul.rs`) only *reads* its source into this model: it keeps the source's values verbatim and
//! leaves every derived value (canonical ids, end-marker text, line kinds and centring where the source has none,
//! division tables, flags, normalised text) to `derive.rs`, so both sources go through exactly the same rules.
//! Everything that crosses sources is keyed by [`Location`] (`s:a:w`), never by a source's own ids.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use anyhow::{Context, anyhow, bail, ensure};
use quran_types::MushafLayout;

/// Surahs in the Hafs canon.
pub const SURAH_COUNT: u32 = 114;
/// Ayahs in the Hafs canon (`ayah.id` 1..=6236).
pub const AYAH_COUNT: u32 = 6_236;
/// Word rows: 77,429 words + 6,236 end markers (`word.id` 1..=83,665).
pub const WORD_COUNT: u32 = 83_665;
/// Pages per layout.
pub const PAGE_COUNT: u32 = 604;
/// Lines per page (pages 1–2 use lines 1..=8 only).
pub const LINES_PER_PAGE: u32 = 15;
/// The last line on pages 1 and 2.
pub const OPENING_PAGE_LINES: u32 = 8;

/// The number of lines page `page` has: 8 on pages 1–2, 15 elsewhere.
#[must_use]
pub const fn lines_on_page(page: u32) -> u32 {
    if page <= 2 {
        OPENING_PAGE_LINES
    } else {
        LINES_PER_PAGE
    }
}

/// An ayah `s:a`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AyahKey {
    pub surah: u32,
    pub ayah: u32,
}

impl AyahKey {
    #[must_use]
    pub const fn new(surah: u32, ayah: u32) -> Self {
        Self { surah, ayah }
    }
}

impl fmt::Display for AyahKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.surah, self.ayah)
    }
}

impl FromStr for AyahKey {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> anyhow::Result<Self> {
        let [surah, ayah] = parse_numbers::<2>(s).with_context(|| format!("ayah key {s:?}"))?;
        Ok(Self { surah, ayah })
    }
}

/// A word location `s:a:w` (`w` is 1-based; the end marker is the last position of its ayah).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Location {
    pub surah: u32,
    pub ayah: u32,
    pub word: u32,
}

impl Location {
    #[must_use]
    pub const fn new(surah: u32, ayah: u32, word: u32) -> Self {
        Self { surah, ayah, word }
    }

    #[must_use]
    pub const fn ayah_key(self) -> AyahKey {
        AyahKey::new(self.surah, self.ayah)
    }
}

impl fmt::Display for Location {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}:{}", self.surah, self.ayah, self.word)
    }
}

impl FromStr for Location {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> anyhow::Result<Self> {
        let [surah, ayah, word] =
            parse_numbers::<3>(s).with_context(|| format!("word location {s:?}"))?;
        Ok(Self { surah, ayah, word })
    }
}

/// Exactly `N` colon-separated positive decimal numbers (no signs, no spaces).
fn parse_numbers<const N: usize>(s: &str) -> anyhow::Result<[u32; N]> {
    let mut out = [0_u32; N];
    let mut parts = s.split(':');
    for slot in &mut out {
        let part = parts
            .next()
            .ok_or_else(|| anyhow!("expected {N} numbers"))?;
        ensure!(
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()),
            "{part:?} is not a decimal number"
        );
        *slot = part
            .parse()
            .with_context(|| format!("{part:?} is out of range"))?;
        ensure!(*slot > 0, "numbers are 1-based");
    }
    ensure!(parts.next().is_none(), "expected {N} numbers");
    Ok(out)
}

/// Where a surah was revealed (`surah.revelation_place`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevelationPlace {
    Makkah,
    Madinah,
}

impl RevelationPlace {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Makkah => "makkah",
            Self::Madinah => "madinah",
        }
    }
}

impl FromStr for RevelationPlace {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "makkah" => Ok(Self::Makkah),
            "madinah" => Ok(Self::Madinah),
            other => bail!("revelation place {other:?} is neither \"makkah\" nor \"madinah\""),
        }
    }
}

/// A surah as the mushaf source describes it. `name_en` and the ruku count come from Tanzil, not from here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceSurah {
    pub id: u32,
    /// `الفاتحة`.
    pub name_ar: String,
    /// `Al-Fatihah` (ASCII transliteration).
    pub name_simple: String,
    /// `Al-Fātiĥah` (transliteration with diacritics).
    pub name_complex: String,
    pub revelation_place: RevelationPlace,
    pub revelation_order: u32,
    pub ayah_count: u32,
    pub bismillah_pre: bool,
}

/// Division numbers of one ayah as the mushaf source gives them. `rub` is the value core.db stores; `juz`, `hizb`
/// (of 60) and `manzil` only cross-check Tanzil, which is their source. `None` = the source has no such field, so the
/// cross-check of that field is reported as skipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceDivisions {
    pub juz: Option<u32>,
    pub hizb: Option<u32>,
    pub rub: u32,
    pub manzil: Option<u32>,
}

/// One ayah of the mushaf source, in any order (derive sorts by key).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceAyah {
    pub key: AyahKey,
    pub divisions: SourceDivisions,
}

/// The source's word type (QDC `char_type_name`; QUL: an end marker is the last word of its ayah).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WordKind {
    Word,
    End,
}

/// The word-level fields of one location, verbatim from the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceWord {
    pub kind: WordKind,
    /// QPC Hafs text (QDC `text_qpc_hafs`, QUL script 312). For an end marker: the ayah number in Arabic-Indic digits,
    /// with or without the leading U+06DD (derive normalises it to U+06DD + digits).
    pub text_hafs: String,
    /// Imla'i text with diacritics, the search seed (QDC word-level `text_imlaei`, QUL script 54; not the "simple"
    /// variant). Ignored for end markers (stored as NULL).
    pub text_imlaei: Option<String>,
    /// QCF V1 glyph code(s) (1405H).
    pub code_v1: String,
    /// QCF V2 glyph code(s) (1421H; also used by V4).
    pub code_v2: String,
}

/// A line type, where the source provides one (`line.kind`: 0, 1, 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LineKind {
    Ayah,
    SurahName,
    Basmallah,
}

impl LineKind {
    /// `line.kind`.
    #[must_use]
    pub const fn db_value(self) -> u32 {
        match self {
            Self::Ayah => 0,
            Self::SurahName => 1,
            Self::Basmallah => 2,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ayah => "ayah",
            Self::SurahName => "surah_name",
            Self::Basmallah => "basmallah",
        }
    }
}

/// One line of a page as the source gives it. A source without line types (qdc) gives only the lines that carry
/// words (`kind`, `centered`, `surah` = `None`); a source with types (qul) gives every line, header lines with no words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawLine {
    /// 1-based line number (after any source fix).
    pub line: u32,
    pub kind: Option<LineKind>,
    pub centered: Option<bool>,
    /// The surah a header line introduces, when the source says so (QUL `surah_number`); checked against the
    /// header placement.
    pub surah: Option<u32>,
    /// The words on the line, in reading order.
    pub words: Vec<Location>,
}

/// One page of a layout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub number: u32,
    pub lines: Vec<RawLine>,
}

/// One mushaf layout (`mushaf_id` 1, 2 or 19).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub layout: MushafLayout,
    pub pages: Vec<Page>,
}

/// Provenance written to `meta`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceInfo {
    /// `meta.source`: `qdc` or `qul`.
    pub source: &'static str,
    /// `meta.source_manifest_sha256`: the sha256 of the source's input manifest (see the adapter for its definition).
    pub manifest_sha256: String,
    /// `meta.licence_note`.
    pub licence_note: String,
}

/// The adapter-neutral source model.
#[derive(Clone, Debug)]
pub struct SourceQuran {
    pub info: SourceInfo,
    pub surahs: Vec<SourceSurah>,
    pub ayahs: Vec<SourceAyah>,
    pub words: BTreeMap<Location, SourceWord>,
    pub layouts: Vec<Layout>,
}

/// Every layout core.db stores, with its `mushaf` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MushafSpec {
    pub layout: MushafLayout,
    pub code: &'static str,
    pub name: &'static str,
    pub glyph_column: &'static str,
}

/// The three layouts in `mushaf.id` order.
pub const MUSHAFS: [MushafSpec; 3] = [
    MushafSpec {
        layout: MushafLayout::V2,
        code: "v2",
        name: "Madani Mushaf 1421H (QCF V2)",
        glyph_column: "code_v2",
    },
    MushafSpec {
        layout: MushafLayout::V1,
        code: "v1",
        name: "Madani Mushaf 1405H (QCF V1)",
        glyph_column: "code_v1",
    },
    MushafSpec {
        layout: MushafLayout::V4,
        code: "v4",
        name: "Madani Mushaf 1441H tajweed (QCF V4)",
        glyph_column: "code_v2",
    },
];

/// The `mushaf` row of `layout`.
#[must_use]
pub fn mushaf_spec(layout: MushafLayout) -> MushafSpec {
    match layout {
        MushafLayout::V2 => MUSHAFS[0],
        MushafLayout::V1 => MUSHAFS[1],
        MushafLayout::V4 => MUSHAFS[2],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_parse_print_and_sort_canonically() -> anyhow::Result<()> {
        let loc: Location = "38:24:32".parse()?;
        assert_eq!(loc, Location::new(38, 24, 32));
        assert_eq!(loc.to_string(), "38:24:32");
        assert_eq!(loc.ayah_key(), AyahKey::new(38, 24));
        let mut locs = [
            Location::new(2, 10, 1),
            Location::new(2, 9, 12),
            Location::new(1, 7, 9),
        ];
        locs.sort();
        assert_eq!(
            locs,
            [
                Location::new(1, 7, 9),
                Location::new(2, 9, 12),
                Location::new(2, 10, 1)
            ]
        );
        for bad in [
            "",
            "1:2",
            "1:2:3:4",
            "1:x:3",
            "1: 2:3",
            "0:1:1",
            "-1:1:1",
            "+1:1:1",
            "1:2:99999999999",
        ] {
            assert!(bad.parse::<Location>().is_err(), "{bad:?}");
        }
        let key: AyahKey = "15:49".parse()?;
        assert_eq!(key, AyahKey::new(15, 49));
        assert_eq!(key.to_string(), "15:49");
        assert!("15".parse::<AyahKey>().is_err());
        Ok(())
    }

    #[test]
    fn page_shapes_and_mushaf_rows() {
        assert_eq!(lines_on_page(1), 8);
        assert_eq!(lines_on_page(2), 8);
        assert_eq!(lines_on_page(3), 15);
        assert_eq!(lines_on_page(604), 15);
        let ids: Vec<u32> = MUSHAFS.iter().map(|m| m.layout.db_id()).collect();
        assert_eq!(ids, [1, 2, 19]);
        for layout in MushafLayout::ALL {
            assert_eq!(mushaf_spec(layout).layout, layout);
        }
        assert_eq!(mushaf_spec(MushafLayout::V4).glyph_column, "code_v2");
        assert_eq!(LineKind::Basmallah.db_value(), 2);
        assert_eq!(
            "madinah".parse::<RevelationPlace>().ok(),
            Some(RevelationPlace::Madinah)
        );
        assert!("Meccan".parse::<RevelationPlace>().is_err());
    }
}
