//! Shared derivation rules: line kinds, pages 1–2, divisions with `xtask/data/division_exceptions.toml`,
//! `ayah.flags`, texts and `norm_*`, page ranges, `header_cp`.
//!
//! [`derive`] turns an adapter's [`SourceQuran`] plus Tanzil into the exact rows of core.db ([`CoreData`]), in id order.
//! It fails on anything it cannot represent faithfully (a gap in the word sequence, an unexplained empty line, a
//! division difference that is not allowlisted, …), and it records every source anomaly it tolerates in the
//! [`DeriveReport`], which `build-core` prints. The `verify-core` gates re-check the written database
//! independently.
//!
//! Source facts this module absorbs (verified on the 1,812 cached QDC responses, 2026-10-10):
//! - QDC labels the end marker of 2:181 (`١٨١`) `char_type_name = "word"`. An ayah whose last word is its own number
//!   and that has no `end` word gets that word relabelled as its end marker; anything else fails.
//! - In V2 and V1 the `surah_name` line of some surahs is the last line of the previous page (the basmala opens the
//!   next page), e.g. An-Nisa: 76:15 / 77:1 (18 surahs in V2, 21 in V1, none in V4). Line kinds are assigned in reading
//!   order, so the header slots are the line(s) just before the first ayah line, the basmala always on the same page.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, anyhow, bail, ensure};
use quran_core::{Level, normalize_ar};
use quran_types::MushafLayout;
use serde::Deserialize;

use super::model::{
    AYAH_COUNT, AyahKey, Layout, LineKind, Location, MUSHAFS, OPENING_PAGE_LINES, PAGE_COUNT,
    RawLine, RevelationPlace, SURAH_COUNT, SourceDivisions, SourceQuran, SourceWord, WORD_COUNT,
    WordKind, lines_on_page,
};
use super::tanzil::{HIZB_COUNT, QUARTER_COUNT, SajdaKind, Tanzil};

/// U+06DD ARABIC END OF AYAH: the end-marker prefix KFGQPC Hafs V30 needs before the digits.
pub const END_OF_AYAH: char = '\u{06DD}';
/// U+06E9 ARABIC PLACE OF SAJDAH (۩).
pub const SAJDA_SIGN: char = '\u{06E9}';
/// U+06DE ARABIC START OF RUB EL HIZB (۞).
pub const RUB_SIGN: char = '\u{06DE}';

/// `ayah.flags` bit0: a new rub starts with this ayah (mushaf-source rub).
pub const FLAG_RUB_START: u32 = 1 << 0;
/// bit1: the new rub is also a hizb start (`(rub − 1) % 4 == 0`).
pub const FLAG_HIZB_START: u32 = 1 << 1;
/// bit2: a new juz starts with this ayah.
pub const FLAG_JUZ_START: u32 = 1 << 2;
/// bit3: `ayah == 1`.
pub const FLAG_SURAH_START: u32 = 1 << 3;

/// V2 ayah lines that are centred besides pages 1–2 (quran.com constant; gate G9).
pub const V2_CENTRED_LINES: [(u32, &[u32]); 11] = [
    (255, &[2]),
    (528, &[9]),
    (534, &[6]),
    (545, &[6]),
    (586, &[1]),
    (593, &[2]),
    (594, &[5]),
    (600, &[10]),
    (602, &[5, 15]),
    (603, &[10, 15]),
    (604, &[4, 9, 14, 15]),
];

/// QCF glyph codes are 1–4 chars (gate G4).
pub const MAX_GLYPH_CHARS: usize = 4;

// ---- inputs: header map and division exceptions -----------------------------------------------------------------

/// `xtask/data/qcf_surah_header_cmap.json`: `surah-N` → the first code point of its QCF_SurahHeader ligature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeaderMap {
    /// Index `surah − 1`.
    code_points: Vec<u32>,
}

#[derive(Deserialize)]
struct HeaderEntry {
    codepoints: String,
}

impl HeaderMap {
    /// Reads the map, or `None` when the file does not exist (`surah.header_cp` is then NULL).
    pub fn load(path: &Path) -> anyhow::Result<Option<Self>> {
        match std::fs::read_to_string(path) {
            Ok(json) => Self::parse(&json)
                .with_context(|| format!("{}", path.display()))
                .map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        }
    }

    pub fn parse(json: &str) -> anyhow::Result<Self> {
        let entries: BTreeMap<String, HeaderEntry> =
            serde_json::from_str(json).context("parse the header map")?;
        ensure!(
            entries.len() == SURAH_COUNT as usize,
            "{} entries, expected surah-1..surah-{SURAH_COUNT}",
            entries.len()
        );
        let mut code_points = Vec::with_capacity(entries.len());
        for surah in 1..=SURAH_COUNT {
            let key = format!("surah-{surah}");
            let entry = entries
                .get(&key)
                .ok_or_else(|| anyhow!("{key} is missing"))?;
            let first = entry
                .codepoints
                .split_whitespace()
                .next()
                .and_then(|cp| cp.strip_prefix("U+"))
                .ok_or_else(|| {
                    anyhow!(
                        "{key}: codepoints {:?} do not start with U+XXXX",
                        entry.codepoints
                    )
                })?;
            let cp = u32::from_str_radix(first, 16)
                .with_context(|| format!("{key}: code point {first:?}"))?;
            ensure!(
                char::from_u32(cp).is_some_and(|c| !c.is_whitespace() && !c.is_control()),
                "{key}: U+{cp:04X} is not a glyph"
            );
            code_points.push(cp);
        }
        Ok(Self { code_points })
    }

    #[must_use]
    pub fn get(&self, surah: u32) -> Option<u32> {
        let index = usize::try_from(surah.checked_sub(1)?).ok()?;
        self.code_points.get(index).copied()
    }
}

/// `xtask/data/division_exceptions.toml` (G11).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DivisionExceptions {
    pub rub: Vec<RubException>,
}

/// One allowlisted rub boundary difference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RubException {
    pub id: u32,
    /// The rub's first ayah in the mushaf source.
    pub source: AyahKey,
    /// The rub's first ayah in Tanzil.
    pub tanzil: AyahKey,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExceptionsToml {
    #[serde(default)]
    rub: Vec<RubExceptionToml>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RubExceptionToml {
    id: u32,
    source: String,
    tanzil: String,
}

impl DivisionExceptions {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        Self::parse(&text).with_context(|| format!("{}", path.display()))
    }

    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let parsed: ExceptionsToml =
            toml::from_str(text).context("parse the division exceptions")?;
        let mut rub = Vec::with_capacity(parsed.rub.len());
        let mut ids = BTreeSet::new();
        for entry in parsed.rub {
            ensure!(
                (1..=QUARTER_COUNT as u32).contains(&entry.id),
                "rub {} is outside 1..={QUARTER_COUNT}",
                entry.id
            );
            ensure!(ids.insert(entry.id), "rub {} is listed twice", entry.id);
            let exception = RubException {
                id: entry.id,
                source: entry
                    .source
                    .parse()
                    .with_context(|| format!("rub {} source", entry.id))?,
                tanzil: entry
                    .tanzil
                    .parse()
                    .with_context(|| format!("rub {} tanzil", entry.id))?,
            };
            ensure!(
                exception.source != exception.tanzil,
                "rub {}: source and tanzil are both {}",
                entry.id,
                exception.source
            );
            rub.push(exception);
        }
        Ok(Self { rub })
    }
}

// ---- output rows -----------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurahRow {
    pub id: u32,
    pub name_ar: String,
    pub name_simple: String,
    pub name_complex: String,
    pub name_en: String,
    pub revelation_place: RevelationPlace,
    pub revelation_order: u32,
    pub ayah_count: u32,
    pub first_ayah_id: u32,
    pub rukus: u32,
    pub bismillah_pre: bool,
    pub header_cp: Option<u32>,
}

/// A `juz`/`hizb`/`rub`/`manzil` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeRow {
    pub id: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RukuRow {
    pub id: u32,
    pub surah: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SajdaRow {
    pub id: u32,
    pub ayah_id: u32,
    pub kind: SajdaKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AyahRow {
    pub id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub juz: u32,
    pub hizb: u32,
    pub rub: u32,
    pub manzil: u32,
    pub ruku: u32,
    /// 0 none, 1 recommended, 2 obligatory.
    pub sajda: u32,
    pub flags: u32,
    pub first_word_id: u32,
    pub last_word_id: u32,
    pub text_hafs: String,
    pub text_imlaei: String,
    pub norm_loose: String,
    pub norm_strict: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordRow {
    pub id: u32,
    pub ayah_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub position: u32,
    pub is_end: bool,
    pub text_hafs: String,
    pub text_imlaei: Option<String>,
    pub norm_loose: Option<String>,
    pub code_v1: String,
    pub code_v2: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageRow {
    pub mushaf_id: u32,
    pub page: u32,
    pub first_word_id: u32,
    pub last_word_id: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineRow {
    pub mushaf_id: u32,
    pub page: u32,
    pub line: u32,
    pub kind: LineKind,
    pub centered: bool,
    /// Header lines: the surah being introduced.
    pub surah_id: Option<u32>,
    /// Ayah lines: the word range.
    pub words: Option<(u32, u32)>,
}

/// Every row of core.db except `meta`, the FTS index and `vocab_loose` (written by `write.rs`), in id order.
#[derive(Clone, Debug)]
pub struct CoreData {
    pub surahs: Vec<SurahRow>,
    pub juzs: Vec<RangeRow>,
    pub hizbs: Vec<RangeRow>,
    pub rubs: Vec<RangeRow>,
    pub manzils: Vec<RangeRow>,
    pub rukus: Vec<RukuRow>,
    pub sajdas: Vec<SajdaRow>,
    pub ayahs: Vec<AyahRow>,
    pub words: Vec<WordRow>,
    pub pages: Vec<PageRow>,
    pub lines: Vec<LineRow>,
    pub report: DeriveReport,
}

/// What `derive` tolerated, checked or measured (printed by `build-core`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeriveReport {
    /// Last words relabelled as end markers (QDC: 2:181:14).
    pub end_markers_relabelled: Vec<Location>,
    /// The canonical V1 regrouping of 38:24:32–33 had to be applied (the combined exporter's grouping).
    pub v1_regrouped: bool,
    /// Words whose `code_v1` / `code_v2` has more than one char (expected 4,580 / 4,517, U+0020 included).
    pub multi_char_v1: usize,
    pub multi_char_v2: usize,
    /// Words whose `code_v1` / `code_v2` contains U+0020 (the ۞ glyph before a rub-start word).
    pub space_in_code_v1: usize,
    pub space_in_code_v2: usize,
    /// Non-end words whose `text_hafs` contains U+0020, by kind: before ۩, after ۞, and between two letters.
    pub space_before_sajda: Vec<Location>,
    pub space_after_rub_sign: usize,
    pub space_between_letters: Vec<Location>,
    /// Rub-start ayahs whose first word carries the inline ۞ (`"۞ "` prefix; QDC: 199 = every rub start that is not
    /// ayah 1 of a surah). A ۞ anywhere else fails the build.
    pub inline_rub_signs: usize,
    /// One line per division cross-check (juz, hizb, manzil, rub).
    pub division_checks: Vec<String>,
    /// Surah fields that differ from Tanzil's (revelation place/order); report only.
    pub surah_notes: Vec<String>,
    /// `true` when `xtask/data/qcf_surah_header_cmap.json` was absent (all `header_cp` NULL).
    pub header_map_missing: bool,
    pub layouts: Vec<LayoutReport>,
}

/// Per layout.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LayoutReport {
    pub mushaf_id: u32,
    pub ayah_lines: usize,
    pub surah_name_lines: usize,
    pub basmallah_lines: usize,
    pub centred_ayah_lines: usize,
    /// Surahs whose `surah_name` line is the last line of the page before their first ayah.
    pub surah_name_on_previous_page: Vec<u32>,
    /// Pages whose first word is not position 1 (G10 expects none).
    pub pages_not_starting_an_ayah: Vec<u32>,
    /// V1 only: pages whose first ayah equals Tanzil's page start (G10 expects 604).
    pub tanzil_page_starts_matched: Option<usize>,
}

// ---- derivation -------------------------------------------------------------------------------------------------

/// Applies every derivation rule (see the module docs).
pub fn derive(
    source: &SourceQuran,
    tanzil: &Tanzil,
    headers: Option<&HeaderMap>,
    exceptions: &DivisionExceptions,
) -> anyhow::Result<CoreData> {
    let mut report = DeriveReport {
        header_map_missing: headers.is_none(),
        ..DeriveReport::default()
    };
    let surahs = derive_surahs(source, tanzil, headers, &mut report).context("surahs")?;
    let words = derive_words(source, tanzil, &mut report).context("words")?;
    let divisions =
        derive_divisions(source, tanzil, exceptions, &mut report).context("divisions")?;
    let ayahs = derive_ayahs(&words, &divisions).context("ayahs")?;
    report.inline_rub_signs = check_inline_rub_signs(&words, &ayahs)?;
    let index = WordIndex::new(&words);
    let surah_starts: Vec<u32> = surahs
        .iter()
        .map(|s| index.id(Location::new(s.id, 1, 1)))
        .collect::<anyhow::Result<_>>()?;

    let mut pages = Vec::with_capacity(PAGE_COUNT as usize * MUSHAFS.len());
    let mut lines = Vec::with_capacity(PAGE_COUNT as usize * LINES_ESTIMATE * MUSHAFS.len());
    let mut v2_centred: Option<BTreeSet<(u32, u32)>> = None;
    ensure!(
        source.layouts.len() == MUSHAFS.len(),
        "{} layouts, expected v2, v1 and v4",
        source.layouts.len()
    );
    for spec in MUSHAFS {
        let mut found = source.layouts.iter().filter(|l| l.layout == spec.layout);
        let (Some(layout), None) = (found.next(), found.next()) else {
            bail!("expected exactly one {} layout", spec.code);
        };
        let derived = derive_layout(layout, &index, &surah_starts, v2_centred.as_ref(), tanzil)
            .with_context(|| format!("layout {} (mushaf {})", spec.code, spec.layout.db_id()))?;
        if spec.layout == MushafLayout::V2 {
            v2_centred = Some(derived.centred_ranges);
        }
        pages.extend(derived.pages);
        lines.extend(derived.lines);
        report.layouts.push(derived.report);
    }

    Ok(CoreData {
        surahs,
        juzs: divisions.juzs,
        hizbs: divisions.hizbs,
        rubs: divisions.rubs,
        manzils: divisions.manzils,
        rukus: divisions.rukus,
        sajdas: divisions.sajdas,
        ayahs,
        words,
        pages,
        lines,
        report,
    })
}

const LINES_ESTIMATE: usize = 15;

fn derive_surahs(
    source: &SourceQuran,
    tanzil: &Tanzil,
    headers: Option<&HeaderMap>,
    report: &mut DeriveReport,
) -> anyhow::Result<Vec<SurahRow>> {
    let mut sorted: Vec<_> = source.surahs.iter().collect();
    sorted.sort_by_key(|s| s.id);
    ensure!(
        sorted.iter().map(|s| s.id).eq(1..=SURAH_COUNT),
        "the source must list surahs 1..={SURAH_COUNT} exactly once"
    );
    sorted
        .into_iter()
        .zip(&tanzil.suras)
        .map(|(s, t)| {
            ensure!(
                s.ayah_count == t.ayas,
                "surah {}: {} ayahs in the source, {} in Tanzil",
                s.id,
                s.ayah_count,
                t.ayas
            );
            let expected_bismillah = !matches!(s.id, 1 | 9);
            ensure!(
                s.bismillah_pre == expected_bismillah,
                "surah {}: bismillah_pre = {}, expected {expected_bismillah}",
                s.id,
                s.bismillah_pre
            );
            if s.revelation_place != t.revelation {
                report.surah_notes.push(format!(
                    "surah {}: revelation place {} (Tanzil: {})",
                    s.id,
                    s.revelation_place.as_str(),
                    t.revelation.as_str()
                ));
            }
            if s.revelation_order != t.order {
                report.surah_notes.push(format!(
                    "surah {}: revelation order {} (Tanzil: {})",
                    s.id, s.revelation_order, t.order
                ));
            }
            Ok(SurahRow {
                id: s.id,
                name_ar: s.name_ar.clone(),
                name_simple: s.name_simple.clone(),
                name_complex: s.name_complex.clone(),
                name_en: t.ename.clone(),
                revelation_place: s.revelation_place,
                revelation_order: s.revelation_order,
                ayah_count: s.ayah_count,
                first_ayah_id: t.start + 1,
                rukus: t.rukus,
                bismillah_pre: s.bismillah_pre,
                header_cp: headers.and_then(|h| h.get(s.id)),
            })
        })
        .collect()
}

/// `n` in Arabic-Indic digits (U+0660–U+0669).
#[must_use]
pub fn arabic_indic(n: u32) -> String {
    n.to_string()
        .chars()
        .map(|d| {
            d.to_digit(10)
                .and_then(|d| char::from_u32(0x0660 + d))
                .unwrap_or(d)
        })
        .collect()
}

/// The end-marker text for `ayah`, from the source's text (digits with or without U+06DD).
fn end_marker_text(text: &str, ayah: u32) -> Option<String> {
    let digits = text.trim().trim_start_matches(END_OF_AYAH);
    (digits == arabic_indic(ayah)).then(|| format!("{END_OF_AYAH}{digits}"))
}

fn check_glyph_code(location: Location, column: &str, code: &str) -> anyhow::Result<()> {
    let chars = code.chars().count();
    ensure!(
        (1..=MAX_GLYPH_CHARS).contains(&chars),
        "word {location}: {column} has {chars} chars, expected 1..={MAX_GLYPH_CHARS}"
    );
    ensure!(
        code.chars().all(|c| c == ' ' || !c.is_whitespace()) && code.trim() == code,
        "word {location}: {column} {code:?} has leading, trailing or non-space whitespace"
    );
    Ok(())
}

/// Text checks shared by `text_hafs` and `text_imlaei`: non-empty, single U+0020 separators only.
fn check_text(location: Location, column: &str, text: &str) -> anyhow::Result<()> {
    ensure!(!text.is_empty(), "word {location}: empty {column}");
    ensure!(
        text.trim() == text
            && !text.contains("  ")
            && text.chars().all(|c| c == ' ' || !c.is_whitespace()),
        "word {location}: {column} {text:?} has stray whitespace"
    );
    Ok(())
}

fn derive_words(
    source: &SourceQuran,
    tanzil: &Tanzil,
    report: &mut DeriveReport,
) -> anyhow::Result<Vec<WordRow>> {
    ensure!(
        source.words.len() == WORD_COUNT as usize,
        "{} word locations, expected {WORD_COUNT}",
        source.words.len()
    );
    let mut by_ayah: BTreeMap<AyahKey, Vec<(Location, &SourceWord)>> = BTreeMap::new();
    for (location, word) in &source.words {
        by_ayah
            .entry(location.ayah_key())
            .or_default()
            .push((*location, word));
    }
    let expected: Vec<AyahKey> = tanzil
        .suras
        .iter()
        .flat_map(|s| (1..=s.ayas).map(move |a| AyahKey::new(s.index, a)))
        .collect();
    if let Some(key) = expected.iter().find(|k| !by_ayah.contains_key(k)) {
        bail!("ayah {key} has no words");
    }
    if let Some(key) = by_ayah.keys().find(|k| tanzil.ayah_id(**k).is_err()) {
        bail!("words of {key}, which is not an ayah");
    }

    let mut rows = Vec::with_capacity(WORD_COUNT as usize);
    for (ayah_index, (key, words)) in by_ayah.iter().enumerate() {
        let ayah_id = u32::try_from(ayah_index + 1)?;
        ensure!(
            words.len() >= 2,
            "ayah {key} has {} word(s), expected words + an end marker",
            words.len()
        );
        for (i, (location, _)) in words.iter().enumerate() {
            ensure!(
                usize::try_from(location.word).ok() == Some(i + 1),
                "ayah {key}: positions are not 1..={} (found {location})",
                words.len()
            );
        }
        let ends: Vec<usize> = words
            .iter()
            .enumerate()
            .filter(|(_, (_, w))| w.kind == WordKind::End)
            .map(|(i, _)| i)
            .collect();
        let last = words.len() - 1;
        let end_index = match ends.as_slice() {
            [i] if *i == last => last,
            [] => {
                let (location, word) = words
                    .get(last)
                    .ok_or_else(|| anyhow!("ayah {key} has no words"))?;
                ensure!(
                    end_marker_text(&word.text_hafs, key.ayah).is_some(),
                    "ayah {key} has no end marker, and its last word {location} ({:?}) is not its number",
                    word.text_hafs
                );
                report.end_markers_relabelled.push(*location);
                last
            }
            _ => bail!(
                "ayah {key}: end markers at word index(es) {ends:?}, expected exactly one, last"
            ),
        };

        for (i, (location, word)) in words.iter().enumerate() {
            let is_end = i == end_index;
            let id = u32::try_from(rows.len() + 1)?;
            check_glyph_code(*location, "code_v1", &word.code_v1)?;
            check_glyph_code(*location, "code_v2", &word.code_v2)?;
            let (text_hafs, text_imlaei, norm_loose) = if is_end {
                let text = end_marker_text(&word.text_hafs, key.ayah).ok_or_else(|| {
                    anyhow!(
                        "end marker {location}: {:?} is not U+06DD + {}",
                        word.text_hafs,
                        arabic_indic(key.ayah)
                    )
                })?;
                (text, None, None)
            } else {
                check_text(*location, "text_hafs", &word.text_hafs)?;
                ensure!(
                    !word.text_hafs.contains(END_OF_AYAH),
                    "word {location}: U+06DD inside a word"
                );
                let imlaei = word
                    .text_imlaei
                    .as_deref()
                    .ok_or_else(|| anyhow!("word {location} has no Imla'i text"))?;
                check_text(*location, "text_imlaei", imlaei)?;
                let norm = normalize_ar(imlaei, Level::Loose);
                ensure!(
                    !norm.is_empty(),
                    "word {location}: {imlaei:?} normalises to nothing"
                );
                classify_spaces(*location, &word.text_hafs, report);
                (word.text_hafs.clone(), Some(imlaei.to_owned()), Some(norm))
            };
            rows.push(WordRow {
                id,
                ayah_id,
                surah: key.surah,
                ayah: key.ayah,
                position: location.word,
                is_end,
                text_hafs,
                text_imlaei,
                norm_loose,
                code_v1: word.code_v1.clone(),
                code_v2: word.code_v2.clone(),
            });
        }
    }

    report.v1_regrouped = regroup_v1(&mut rows)?;
    for row in &rows {
        report.multi_char_v1 += usize::from(row.code_v1.chars().count() > 1);
        report.multi_char_v2 += usize::from(row.code_v2.chars().count() > 1);
        report.space_in_code_v1 += usize::from(row.code_v1.contains(' '));
        report.space_in_code_v2 += usize::from(row.code_v2.contains(' '));
    }
    Ok(rows)
}

/// G5b classification of the U+0020s inside one word's `text_hafs`.
fn classify_spaces(location: Location, text: &str, report: &mut DeriveReport) {
    let chars: Vec<char> = text.chars().collect();
    let mut before_sajda = false;
    let mut between_letters = false;
    for (i, c) in chars.iter().enumerate() {
        if *c != ' ' {
            continue;
        }
        let previous = i.checked_sub(1).and_then(|p| chars.get(p));
        let next = chars.get(i + 1);
        if next == Some(&SAJDA_SIGN) {
            before_sajda = true;
        } else if previous == Some(&RUB_SIGN) {
            report.space_after_rub_sign += 1;
        } else {
            between_letters = true;
        }
    }
    if before_sajda {
        report.space_before_sajda.push(location);
    }
    if between_letters {
        report.space_between_letters.push(location);
    }
}

/// The rub sign ۞ may only open the first word of a rub-start ayah, as `"۞ "` (the printed inline sign; the source's
/// rub and this text must agree). Returns how many rub starts carry it.
fn check_inline_rub_signs(words: &[WordRow], ayahs: &[AyahRow]) -> anyhow::Result<usize> {
    let mut count = 0;
    for word in words.iter().filter(|w| w.text_hafs.contains(RUB_SIGN)) {
        let location = Location::new(word.surah, word.ayah, word.position);
        let ayah = usize::try_from(word.ayah_id - 1)
            .ok()
            .and_then(|i| ayahs.get(i))
            .ok_or_else(|| anyhow!("word {location}: no ayah row"))?;
        let prefix = format!("{RUB_SIGN} ");
        ensure!(
            word.position == 1
                && ayah.flags & FLAG_RUB_START != 0
                && word.text_hafs.starts_with(&prefix)
                && word.text_hafs.matches(RUB_SIGN).count() == 1,
            "word {location} ({:?}): a ۞ is only allowed as the \"۞ \" prefix of the first word of a rub start \
             (the source's rub data and its text disagree)",
            word.text_hafs
        );
        count += 1;
    }
    Ok(count)
}

/// The canonical V1 grouping of 38:24:32–33 is `U+FBE9 U+FBEA` / `U+FBEB`. A source with the combined exporter's
/// grouping (`U+FBE9` / `U+FBEA U+FBEB`) is regrouped; any other value fails. Returns whether it regrouped.
fn regroup_v1(rows: &mut [WordRow]) -> anyhow::Result<bool> {
    let find = |rows: &[WordRow], position: u32| {
        rows.iter()
            .position(|w| w.surah == 38 && w.ayah == 24 && w.position == position)
            .ok_or_else(|| anyhow!("word 38:24:{position} is missing"))
    };
    let (a, b) = (find(rows, 32)?, find(rows, 33)?);
    let current = (
        rows.get(a).map(|w| w.code_v1.clone()).unwrap_or_default(),
        rows.get(b).map(|w| w.code_v1.clone()).unwrap_or_default(),
    );
    let regrouped = match (current.0.as_str(), current.1.as_str()) {
        ("\u{FBE9}\u{FBEA}", "\u{FBEB}") => false,
        ("\u{FBE9}", "\u{FBEA}\u{FBEB}") => {
            if let Some(w) = rows.get_mut(a) {
                w.code_v1 = "\u{FBE9}\u{FBEA}".to_owned();
            }
            if let Some(w) = rows.get_mut(b) {
                w.code_v1 = "\u{FBEB}".to_owned();
            }
            true
        }
        (x, y) => {
            bail!("code_v1 of 38:24:32–33 is {x:?} / {y:?}, expected U+FBE9 U+FBEA / U+FBEB")
        }
    };
    Ok(regrouped)
}

/// Per-ayah division numbers and the division tables.
struct Divisions {
    /// Index `ayah_id − 1`.
    per_ayah: Vec<AyahDivisions>,
    juzs: Vec<RangeRow>,
    hizbs: Vec<RangeRow>,
    rubs: Vec<RangeRow>,
    manzils: Vec<RangeRow>,
    rukus: Vec<RukuRow>,
    sajdas: Vec<SajdaRow>,
}

#[derive(Clone, Copy, Debug, Default)]
struct AyahDivisions {
    juz: u32,
    hizb: u32,
    rub: u32,
    manzil: u32,
    ruku: u32,
    sajda: u32,
}

/// The division number of every ayah id 1..=`count`, given the (strictly increasing, first = 1) start ids.
fn assign_from_starts(starts: &[u32], count: u32) -> anyhow::Result<Vec<u32>> {
    ensure!(
        starts.first() == Some(&1),
        "the first division must start at ayah 1"
    );
    ensure!(
        starts.windows(2).all(|w| matches!(w, [a, b] if a < b)),
        "division starts are not strictly increasing"
    );
    let mut out = Vec::with_capacity(usize::try_from(count)?);
    let mut number = 0_u32;
    let mut next = starts.iter().peekable();
    for id in 1..=count {
        while next.next_if(|&&s| s <= id).is_some() {
            number += 1;
        }
        out.push(number);
    }
    Ok(out)
}

/// `RangeRow`s 1..=n from per-ayah numbers that run 1..=n without gaps.
fn ranges(per_ayah: &[u32], what: &str, expected: usize) -> anyhow::Result<Vec<RangeRow>> {
    let mut rows: Vec<RangeRow> = Vec::with_capacity(expected);
    for (index, &number) in per_ayah.iter().enumerate() {
        let id = u32::try_from(index + 1)?;
        match rows.last_mut() {
            Some(row) if row.id == number => row.last_ayah_id = id,
            last => {
                let expected_number = last.map_or(1, |r| r.id + 1);
                ensure!(
                    number == expected_number,
                    "{what} goes from {} to {number} at ayah id {id}",
                    expected_number - 1
                );
                rows.push(RangeRow {
                    id: number,
                    first_ayah_id: id,
                    last_ayah_id: id,
                });
            }
        }
    }
    ensure!(
        rows.len() == expected,
        "{} {what}s, expected {expected}",
        rows.len()
    );
    Ok(rows)
}

fn derive_divisions(
    source: &SourceQuran,
    tanzil: &Tanzil,
    exceptions: &DivisionExceptions,
    report: &mut DeriveReport,
) -> anyhow::Result<Divisions> {
    let ids = |keys: &[AyahKey]| -> anyhow::Result<Vec<u32>> {
        keys.iter().map(|k| tanzil.ayah_id(*k)).collect()
    };
    let juz = assign_from_starts(&ids(&tanzil.juz_starts)?, AYAH_COUNT)?;
    let hizb = assign_from_starts(&ids(&tanzil.hizb_starts())?, AYAH_COUNT)?;
    let manzil = assign_from_starts(&ids(&tanzil.manzil_starts)?, AYAH_COUNT)?;
    let ruku = assign_from_starts(&ids(&tanzil.ruku_starts)?, AYAH_COUNT)?;

    // The mushaf source's per-ayah values, in ayah-id order.
    let mut source_divisions: Vec<Option<SourceDivisions>> = vec![None; AYAH_COUNT as usize];
    for ayah in &source.ayahs {
        let id = tanzil
            .ayah_id(ayah.key)
            .with_context(|| format!("source ayah {}", ayah.key))?;
        let slot = usize::try_from(id - 1)
            .ok()
            .and_then(|i| source_divisions.get_mut(i))
            .ok_or_else(|| anyhow!("ayah id {id}"))?;
        ensure!(slot.is_none(), "the source lists ayah {} twice", ayah.key);
        *slot = Some(ayah.divisions);
    }
    let source_divisions: Vec<SourceDivisions> = source_divisions
        .into_iter()
        .enumerate()
        .map(|(i, d)| d.ok_or_else(|| anyhow!("the source has no divisions for ayah id {}", i + 1)))
        .collect::<anyhow::Result<_>>()?;
    let key_of = |index: usize| -> String {
        u32::try_from(index + 1)
            .ok()
            .and_then(|id| ayah_key_of(tanzil, id))
            .map_or_else(|| format!("#{}", index + 1), |k| k.to_string())
    };

    // juz, hizb, manzil: Tanzil, hard cross-checked against the source.
    for (what, tanzil_values) in [("juz", &juz), ("hizb", &hizb), ("manzil", &manzil)] {
        let pick = |d: &SourceDivisions| match what {
            "juz" => d.juz,
            "hizb" => d.hizb,
            _ => d.manzil,
        };
        let mut checked = 0_usize;
        let mut differences = Vec::new();
        for (index, (expected, actual)) in tanzil_values.iter().zip(&source_divisions).enumerate() {
            if let Some(value) = pick(actual) {
                checked += 1;
                if value != *expected {
                    differences.push(format!(
                        "{} source {value} / Tanzil {expected}",
                        key_of(index)
                    ));
                }
            }
        }
        ensure!(
            differences.is_empty(),
            "{what}: {} ayah(s) differ from Tanzil (none may): {}",
            differences.len(),
            differences
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
        );
        report.division_checks.push(if checked == 0 {
            format!("{what}: Tanzil (the source has no {what} field; not cross-checked)")
        } else {
            format!(
                "{what}: Tanzil, {checked} ayahs cross-checked against the source, 0 differences"
            )
        });
    }

    // rub: the mushaf source, cross-checked against Tanzil with the allowlist.
    let rub: Vec<u32> = source_divisions.iter().map(|d| d.rub).collect();
    let rubs = ranges(&rub, "rub", QUARTER_COUNT).context("source rub numbers")?;
    let mut differences = BTreeMap::new();
    for (row, tanzil_start) in rubs.iter().zip(&tanzil.quarter_starts) {
        let source_start =
            ayah_key_of(tanzil, row.first_ayah_id).ok_or_else(|| anyhow!("rub {}", row.id))?;
        if source_start != *tanzil_start {
            differences.insert(row.id, (source_start, *tanzil_start));
        }
    }
    let allowed: BTreeMap<u32, (AyahKey, AyahKey)> = exceptions
        .rub
        .iter()
        .map(|e| (e.id, (e.source, e.tanzil)))
        .collect();
    for (id, (source_start, tanzil_start)) in &differences {
        match allowed.get(id) {
            Some(pair) if *pair == (*source_start, *tanzil_start) => {}
            Some((s, t)) => bail!(
                "rub {id}: source {source_start} / Tanzil {tanzil_start}, but division_exceptions.toml lists {s} / {t}"
            ),
            None => bail!(
                "rub {id}: source {source_start} / Tanzil {tanzil_start} is not in xtask/data/division_exceptions.toml"
            ),
        }
    }
    if let Some((id, (s, t))) = allowed.iter().find(|(id, _)| !differences.contains_key(id)) {
        bail!(
            "division_exceptions.toml lists rub {id} ({s} / {t}), which no longer differs: remove the entry"
        );
    }
    report.division_checks.push(format!(
        "rub: the mushaf source, {} start(s) differ from Tanzil, all allowlisted ({})",
        differences.len(),
        differences
            .iter()
            .map(|(id, (s, t))| format!("rub {id}: {s} / {t}"))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    // The source rub must sit inside the Tanzil hizb, and the hizb inside the juz.
    for (index, ((&r, &h), &j)) in rub.iter().zip(&hizb).zip(&juz).enumerate() {
        ensure!(
            (r - 1) / 4 + 1 == h,
            "{}: rub {r} is not in hizb {h}",
            key_of(index)
        );
        ensure!(
            (h - 1) / 2 + 1 == j,
            "{}: hizb {h} is not in juz {j}",
            key_of(index)
        );
    }

    let mut sajda = vec![0_u32; AYAH_COUNT as usize];
    let mut sajdas = Vec::with_capacity(tanzil.sajdas.len());
    for s in &tanzil.sajdas {
        let ayah_id = tanzil.ayah_id(s.key)?;
        if let Some(slot) = usize::try_from(ayah_id - 1)
            .ok()
            .and_then(|i| sajda.get_mut(i))
        {
            *slot = s.kind.ayah_value();
        }
        sajdas.push(SajdaRow {
            id: s.index,
            ayah_id,
            kind: s.kind,
        });
    }

    let ruku_ranges = ranges(&ruku, "ruku", tanzil.ruku_starts.len())?;
    let rukus = ruku_ranges
        .iter()
        .zip(&tanzil.ruku_starts)
        .map(|(row, start)| {
            let last =
                ayah_key_of(tanzil, row.last_ayah_id).ok_or_else(|| anyhow!("ruku {}", row.id))?;
            ensure!(
                last.surah == start.surah,
                "ruku {} runs from {start} into surah {}",
                row.id,
                last.surah
            );
            Ok(RukuRow {
                id: row.id,
                surah: start.surah,
                first_ayah_id: row.first_ayah_id,
                last_ayah_id: row.last_ayah_id,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let per_ayah = (0..AYAH_COUNT as usize)
        .map(|i| -> anyhow::Result<AyahDivisions> {
            let get = |v: &[u32]| v.get(i).copied().ok_or_else(|| anyhow!("ayah index {i}"));
            Ok(AyahDivisions {
                juz: get(&juz)?,
                hizb: get(&hizb)?,
                rub: get(&rub)?,
                manzil: get(&manzil)?,
                ruku: get(&ruku)?,
                sajda: get(&sajda)?,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(Divisions {
        per_ayah,
        juzs: ranges(&juz, "juz", tanzil.juz_starts.len())?,
        hizbs: ranges(&hizb, "hizb", HIZB_COUNT)?,
        rubs,
        manzils: ranges(&manzil, "manzil", tanzil.manzil_starts.len())?,
        rukus,
        sajdas,
    })
}

/// The `s:a` of a canonical ayah id.
fn ayah_key_of(tanzil: &Tanzil, id: u32) -> Option<AyahKey> {
    let sura = tanzil
        .suras
        .iter()
        .find(|s| id > s.start && id <= s.start + s.ayas)?;
    Some(AyahKey::new(sura.index, id - sura.start))
}

fn derive_ayahs(words: &[WordRow], divisions: &Divisions) -> anyhow::Result<Vec<AyahRow>> {
    let mut ayahs: Vec<AyahRow> = Vec::with_capacity(AYAH_COUNT as usize);
    let mut start = 0_usize;
    while let Some(first) = words.get(start) {
        let end = words
            .iter()
            .skip(start)
            .position(|w| w.ayah_id != first.ayah_id)
            .map_or(words.len(), |n| start + n);
        let ayah_words = words
            .get(start..end)
            .ok_or_else(|| anyhow!("word range {start}..{end}"))?;
        let last = ayah_words
            .last()
            .ok_or_else(|| anyhow!("ayah {} has no words", first.ayah_id))?;
        let d = usize::try_from(first.ayah_id - 1)
            .ok()
            .and_then(|i| divisions.per_ayah.get(i))
            .copied()
            .ok_or_else(|| anyhow!("no divisions for ayah id {}", first.ayah_id))?;
        let text_imlaei = ayah_words
            .iter()
            .filter_map(|w| w.text_imlaei.as_deref())
            .collect::<Vec<_>>()
            .join(" ");
        let previous = ayahs.last();
        let mut flags = 0;
        if previous.is_none_or(|p| p.rub != d.rub) {
            flags |= FLAG_RUB_START;
            if (d.rub - 1) % 4 == 0 {
                flags |= FLAG_HIZB_START;
            }
        }
        if previous.is_none_or(|p| p.juz != d.juz) {
            flags |= FLAG_JUZ_START;
        }
        if first.ayah == 1 {
            flags |= FLAG_SURAH_START;
        }
        ayahs.push(AyahRow {
            id: first.ayah_id,
            surah: first.surah,
            ayah: first.ayah,
            juz: d.juz,
            hizb: d.hizb,
            rub: d.rub,
            manzil: d.manzil,
            ruku: d.ruku,
            sajda: d.sajda,
            flags,
            first_word_id: first.id,
            last_word_id: last.id,
            text_hafs: ayah_words
                .iter()
                .map(|w| w.text_hafs.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            norm_loose: normalize_ar(&text_imlaei, Level::Loose),
            norm_strict: normalize_ar(&text_imlaei, Level::Strict),
            text_imlaei,
        });
        start = end;
    }
    ensure!(
        ayahs.len() == AYAH_COUNT as usize && ayahs.iter().zip(1..).all(|(a, id)| a.id == id),
        "ayah ids are not 1..={AYAH_COUNT}"
    );
    Ok(ayahs)
}

/// Location → canonical word id, and word id → (ayah id, position).
struct WordIndex {
    ids: BTreeMap<Location, u32>,
    /// Index `word_id − 1`.
    words: Vec<(u32, u32)>,
}

impl WordIndex {
    fn new(words: &[WordRow]) -> Self {
        Self {
            ids: words
                .iter()
                .map(|w| (Location::new(w.surah, w.ayah, w.position), w.id))
                .collect(),
            words: words.iter().map(|w| (w.ayah_id, w.position)).collect(),
        }
    }

    fn id(&self, location: Location) -> anyhow::Result<u32> {
        self.ids
            .get(&location)
            .copied()
            .ok_or_else(|| anyhow!("unknown word location {location}"))
    }

    fn get(&self, word_id: u32) -> anyhow::Result<(u32, u32)> {
        usize::try_from(word_id.checked_sub(1).ok_or_else(|| anyhow!("word id 0"))?)
            .ok()
            .and_then(|i| self.words.get(i))
            .copied()
            .ok_or_else(|| anyhow!("unknown word id {word_id}"))
    }

    fn ayah(&self, word_id: u32) -> anyhow::Result<u32> {
        self.get(word_id).map(|(ayah, _)| ayah)
    }

    fn position(&self, word_id: u32) -> anyhow::Result<u32> {
        self.get(word_id).map(|(_, position)| position)
    }

    fn word_count(&self) -> u32 {
        u32::try_from(self.words.len()).unwrap_or(u32::MAX)
    }
}

/// One line slot of a page while lines are being typed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot {
    /// A line with words (`centered` as the source gives it).
    Ayah {
        first: u32,
        last: u32,
        centered: Option<bool>,
    },
    /// A header line the source typed (qul), not yet matched to a surah.
    Header {
        kind: LineKind,
        surah: Option<u32>,
        centered: Option<bool>,
    },
    /// No words and no type (qdc): must be explained as a header.
    Empty,
    /// Typed by the header rule ([`assign_headers`]).
    Derived {
        kind: LineKind,
        surah: u32,
        centered: Option<bool>,
    },
}

struct DerivedLayout {
    pages: Vec<PageRow>,
    lines: Vec<LineRow>,
    /// Word ranges of the centred ayah lines (v2 → the v1/v4 approximation).
    centred_ranges: BTreeSet<(u32, u32)>,
    report: LayoutReport,
}

fn derive_layout(
    layout: &Layout,
    index: &WordIndex,
    surah_starts: &[u32],
    v2_centred: Option<&BTreeSet<(u32, u32)>>,
    tanzil: &Tanzil,
) -> anyhow::Result<DerivedLayout> {
    let mushaf_id = layout.layout.db_id();
    ensure!(
        layout.pages.iter().map(|p| p.number).eq(1..=PAGE_COUNT),
        "pages must be 1..={PAGE_COUNT} in order"
    );
    let mut pages: Vec<Vec<Slot>> = layout
        .pages
        .iter()
        .map(|page| {
            page_slots(page.number, &page.lines, index)
                .with_context(|| format!("page {}", page.number))
        })
        .collect::<anyhow::Result<_>>()?;
    check_coverage(&pages, index.word_count())?;
    let mut report = LayoutReport {
        mushaf_id,
        ..LayoutReport::default()
    };
    report.surah_name_on_previous_page = assign_headers(&mut pages, surah_starts)?;
    check_opening_pages(&pages)?;

    let centring = match (layout.layout, v2_centred) {
        (MushafLayout::V2, _) => Centring::V2List,
        (_, Some(set)) => Centring::LikeV2(set),
        (_, None) => Centring::Unavailable,
    };
    if matches!(centring, Centring::V2List) {
        check_v2_centred_lines(&pages)?;
    }

    let mut rows = Vec::with_capacity(pages.len());
    let mut lines = Vec::with_capacity(pages.len() * LINES_ESTIMATE);
    let mut centred_ranges = BTreeSet::new();
    for (page_number, slots) in (1..).zip(&pages) {
        let mut first_word = None;
        let mut last_word = None;
        for (line, slot) in (1..).zip(slots) {
            let (kind, surah_id, words, provided) = match *slot {
                Slot::Ayah {
                    first,
                    last,
                    centered,
                } => {
                    first_word.get_or_insert(first);
                    last_word = Some(last);
                    (LineKind::Ayah, None, Some((first, last)), centered)
                }
                Slot::Derived {
                    kind,
                    surah,
                    centered,
                } => (kind, Some(surah), None, centered),
                Slot::Header { .. } | Slot::Empty => {
                    bail!("page {page_number} line {line} was not typed (internal error)")
                }
            };
            let centered = centred(&centring, page_number, line, kind, words, provided)
                .with_context(|| format!("page {page_number} line {line}"))?;
            match kind {
                LineKind::Ayah => {
                    report.ayah_lines += 1;
                    if centered {
                        report.centred_ayah_lines += 1;
                        if let Some(range) = words {
                            centred_ranges.insert(range);
                        }
                    }
                }
                LineKind::SurahName => report.surah_name_lines += 1,
                LineKind::Basmallah => report.basmallah_lines += 1,
            }
            lines.push(LineRow {
                mushaf_id,
                page: page_number,
                line,
                kind,
                centered,
                surah_id,
                words,
            });
        }
        let (Some(first_word_id), Some(last_word_id)) = (first_word, last_word) else {
            bail!("page {page_number} has no ayah line");
        };
        if index.position(first_word_id)? != 1 {
            report.pages_not_starting_an_ayah.push(page_number);
        }
        rows.push(PageRow {
            mushaf_id,
            page: page_number,
            first_word_id,
            last_word_id,
            first_ayah_id: index.ayah(first_word_id)?,
            last_ayah_id: index.ayah(last_word_id)?,
        });
    }
    if layout.layout == MushafLayout::V1 {
        let starts: Vec<u32> = tanzil
            .page_starts
            .iter()
            .map(|k| tanzil.ayah_id(*k))
            .collect::<anyhow::Result<_>>()?;
        report.tanzil_page_starts_matched = Some(
            rows.iter()
                .zip(&starts)
                .filter(|(row, start)| row.first_ayah_id == **start)
                .count(),
        );
    }
    Ok(DerivedLayout {
        pages: rows,
        lines,
        centred_ranges,
        report,
    })
}

/// The slots of one page (index `line − 1`), from the source's lines.
fn page_slots(page: u32, raw: &[RawLine], index: &WordIndex) -> anyhow::Result<Vec<Slot>> {
    let count = lines_on_page(page);
    let mut slots = vec![Slot::Empty; usize::try_from(count)?];
    let mut seen = BTreeSet::new();
    for line in raw {
        ensure!(
            (1..=count).contains(&line.line),
            "line {} is outside 1..={count}",
            line.line
        );
        ensure!(seen.insert(line.line), "line {} appears twice", line.line);
        let slot = if line.words.is_empty() {
            match line.kind {
                Some(kind @ (LineKind::SurahName | LineKind::Basmallah)) => Slot::Header {
                    kind,
                    surah: line.surah,
                    centered: line.centered,
                },
                _ => bail!("line {} is an ayah line without words", line.line),
            }
        } else {
            ensure!(
                matches!(line.kind, None | Some(LineKind::Ayah)),
                "line {} is typed {:?} but has words",
                line.line,
                line.kind
            );
            let ids = line
                .words
                .iter()
                .map(|l| index.id(*l))
                .collect::<anyhow::Result<Vec<u32>>>()
                .with_context(|| format!("line {}", line.line))?;
            ensure!(
                ids.windows(2).all(|w| matches!(w, [a, b] if *b == a + 1)),
                "line {}: words {} are not consecutive",
                line.line,
                line.words
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let (Some(&first), Some(&last)) = (ids.first(), ids.last()) else {
                bail!("line {} has no words", line.line);
            };
            Slot::Ayah {
                first,
                last,
                centered: line.centered,
            }
        };
        let position = usize::try_from(line.line - 1)?;
        if let Some(target) = slots.get_mut(position) {
            *target = slot;
        }
    }
    Ok(slots)
}

/// G7 in reading order: ayah lines cover word ids 1..=`word_count` exactly once, contiguously across lines and pages.
fn check_coverage(pages: &[Vec<Slot>], word_count: u32) -> anyhow::Result<()> {
    let mut next = 1_u32;
    for (page, slots) in (1_u32..).zip(pages) {
        for (line, slot) in (1_u32..).zip(slots) {
            if let Slot::Ayah { first, last, .. } = *slot {
                ensure!(
                    first == next && last >= first,
                    "page {page} line {line} holds words {first}..={last}, expected to start at {next}"
                );
                next = last + 1;
            }
        }
    }
    ensure!(
        next == word_count + 1,
        "the lines cover words 1..={}, expected 1..={word_count}",
        next - 1
    );
    Ok(())
}

/// Places the surah headers in reading order. For surah `s` whose first ayah line is `(P, L)`, the slot before it is
/// the `basmallah` (the `surah_name` for s ∈ {1, 9}) and must be on page `P`; the slot before that is the `surah_name`
/// and may be the last line of page `P − 1`. Every such slot must be empty (or typed identically by the source), and
/// every empty or source-typed header slot must be explained. Returns the surahs whose `surah_name` is on the previous
/// page.
fn assign_headers(pages: &mut [Vec<Slot>], surah_starts: &[u32]) -> anyhow::Result<Vec<u32>> {
    let mut on_previous_page = Vec::new();
    for (surah, &first_word) in (1_u32..).zip(surah_starts) {
        let (page, line) = find_line_starting_with(pages, first_word).ok_or_else(|| {
            anyhow!("surah {surah}: no line starts with its first word (id {first_word})")
        })?;
        let needed: &[LineKind] = if matches!(surah, 1 | 9) {
            &[LineKind::SurahName]
        } else {
            &[LineKind::SurahName, LineKind::Basmallah]
        };
        let mut cursor = (page, line);
        for (step, kind) in needed.iter().rev().enumerate() {
            cursor = previous_slot(pages, cursor).ok_or_else(|| {
                anyhow!(
                    "surah {surah}: no line above its first ayah line {}:{} for the {}",
                    page + 1,
                    line + 1,
                    kind.as_str()
                )
            })?;
            ensure!(
                step > 0 || cursor.0 == page,
                "surah {surah}: its {} would be on page {}, before the page of its first ayah ({})",
                kind.as_str(),
                cursor.0 + 1,
                page + 1
            );
            let slot = pages
                .get_mut(cursor.0)
                .and_then(|p| p.get_mut(cursor.1))
                .ok_or_else(|| anyhow!("slot {cursor:?}"))?;
            let centered = match *slot {
                Slot::Empty => None,
                Slot::Header {
                    kind: typed,
                    surah: typed_surah,
                    centered,
                } if typed == *kind && typed_surah.is_none_or(|s| s == surah) => centered,
                other => bail!(
                    "surah {surah}: line {}:{} should be its {} but holds {other:?}",
                    cursor.0 + 1,
                    cursor.1 + 1,
                    kind.as_str()
                ),
            };
            *slot = Slot::Derived {
                kind: *kind,
                surah,
                centered,
            };
        }
        if cursor.0 != page {
            on_previous_page.push(surah);
        }
    }
    for (page, slots) in (1..).zip(pages.iter()) {
        for (line, slot) in (1..).zip(slots) {
            match slot {
                Slot::Empty => {
                    bail!("page {page} line {line} is empty and is not a surah header")
                }
                Slot::Header { kind, .. } => bail!(
                    "page {page} line {line} is typed {} by the source, but no surah header belongs there",
                    kind.as_str()
                ),
                Slot::Ayah { .. } | Slot::Derived { .. } => {}
            }
        }
    }
    Ok(on_previous_page)
}

/// `(page index, line index)` of the ayah line whose first word is `word_id`.
fn find_line_starting_with(pages: &[Vec<Slot>], word_id: u32) -> Option<(usize, usize)> {
    pages.iter().enumerate().find_map(|(p, slots)| {
        slots
            .iter()
            .position(|s| matches!(s, Slot::Ayah { first, .. } if *first == word_id))
            .map(|l| (p, l))
    })
}

/// The slot before `(page, line)` in reading order (the last line of the previous page before line 1).
fn previous_slot(pages: &[Vec<Slot>], (page, line): (usize, usize)) -> Option<(usize, usize)> {
    if line > 0 {
        return Some((page, line - 1));
    }
    let previous = page.checked_sub(1)?;
    let last = pages.get(previous)?.len().checked_sub(1)?;
    Some((previous, last))
}

/// Pages 1–2 have exactly lines 1..=8, line 1 is the `surah_name`, page 2 line 2 the `basmallah`.
fn check_opening_pages(pages: &[Vec<Slot>]) -> anyhow::Result<()> {
    for (page, surah) in [(1_usize, 1_u32), (2, 2)] {
        let slots = pages
            .get(page - 1)
            .ok_or_else(|| anyhow!("page {page} is missing"))?;
        ensure!(
            slots.len() == OPENING_PAGE_LINES as usize,
            "page {page} has {} lines, expected {OPENING_PAGE_LINES}",
            slots.len()
        );
        ensure!(
            matches!(slots.first(), Some(Slot::Derived { kind: LineKind::SurahName, surah: s, .. }) if *s == surah),
            "page {page} line 1 is not the surah_name of surah {surah}"
        );
        if page == 2 {
            ensure!(
                matches!(
                    slots.get(1),
                    Some(Slot::Derived {
                        kind: LineKind::Basmallah,
                        surah: 2,
                        ..
                    })
                ),
                "page 2 line 2 is not the basmallah of surah 2"
            );
        }
    }
    Ok(())
}

/// The listed V2 lines exist and are ayah lines.
fn check_v2_centred_lines(pages: &[Vec<Slot>]) -> anyhow::Result<()> {
    for (page, lines) in V2_CENTRED_LINES {
        for line in lines {
            let slot = usize::try_from(page - 1)
                .ok()
                .and_then(|p| pages.get(p))
                .and_then(|slots| slots.get(usize::try_from(line - 1).ok()?));
            ensure!(
                matches!(slot, Some(Slot::Ayah { .. })),
                "v2 centred line {page}:{line} is not an ayah line"
            );
        }
    }
    Ok(())
}

/// How the centring of untyped ayah lines is decided.
enum Centring<'a> {
    /// V2: pages 1–2 plus [`V2_CENTRED_LINES`].
    V2List,
    /// V1/V4 (dev approximation): pages 1–2 plus ayah lines whose words equal a centred V2 line.
    LikeV2(&'a BTreeSet<(u32, u32)>),
    /// No V2 layout was derived first.
    Unavailable,
}

fn centred(
    centring: &Centring<'_>,
    page: u32,
    line: u32,
    kind: LineKind,
    words: Option<(u32, u32)>,
    provided: Option<bool>,
) -> anyhow::Result<bool> {
    let must = page <= 2 || kind != LineKind::Ayah;
    if let Some(value) = provided {
        ensure!(
            value || !must,
            "the source does not centre a line that must be centred (pages 1–2 and header lines)"
        );
        return Ok(value);
    }
    if must {
        return Ok(true);
    }
    Ok(match centring {
        Centring::V2List => V2_CENTRED_LINES
            .iter()
            .any(|(p, lines)| *p == page && lines.contains(&line)),
        Centring::LikeV2(set) => words.is_some_and(|range| set.contains(&range)),
        Centring::Unavailable => {
            bail!("centring is not given by the source and there is no v2 layout to copy it from")
        }
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn arabic_indic_digits_and_end_markers() {
        assert_eq!(arabic_indic(7), "٧");
        assert_eq!(arabic_indic(181), "١٨١");
        assert_eq!(arabic_indic(286), "٢٨٦");
        assert_eq!(end_marker_text("١٨١", 181).as_deref(), Some("\u{06DD}١٨١"));
        assert_eq!(
            end_marker_text("\u{06DD}٧", 7).as_deref(),
            Some("\u{06DD}٧")
        );
        assert_eq!(end_marker_text("٧", 8), None);
        assert_eq!(end_marker_text("سَمِيعٌ", 1), None);
        assert_eq!(
            end_marker_text("7", 7),
            None,
            "ASCII digits are not the source's form"
        );
    }

    #[test]
    fn division_assignment_from_starts() {
        assert_eq!(assign_from_starts(&[1, 3, 4], 5).unwrap(), [1, 1, 2, 3, 3]);
        assert!(assign_from_starts(&[2, 3], 5).is_err());
        assert!(assign_from_starts(&[1, 3, 3], 5).is_err());
        let rows = ranges(&[1, 1, 2, 3, 3], "x", 3).unwrap();
        assert_eq!(
            rows,
            [
                RangeRow {
                    id: 1,
                    first_ayah_id: 1,
                    last_ayah_id: 2
                },
                RangeRow {
                    id: 2,
                    first_ayah_id: 3,
                    last_ayah_id: 3
                },
                RangeRow {
                    id: 3,
                    first_ayah_id: 4,
                    last_ayah_id: 5
                },
            ]
        );
        assert!(ranges(&[1, 3], "x", 2).is_err(), "a skipped number");
        assert!(ranges(&[1, 2, 1], "x", 2).is_err(), "going back");
        assert!(ranges(&[2, 2], "x", 1).is_err(), "not starting at 1");
        assert!(ranges(&[1, 2], "x", 3).is_err(), "too few");
    }

    #[test]
    fn exceptions_parse_strictly() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/data/division_exceptions.toml"
        ))
        .unwrap();
        let parsed = DivisionExceptions::parse(&text).unwrap();
        assert_eq!(
            parsed.rub,
            [RubException {
                id: 106,
                source: AyahKey::new(15, 49),
                tanzil: AyahKey::new(15, 50)
            }],
            "the committed allowlist has exactly one entry"
        );
        assert_eq!(
            DivisionExceptions::parse("").unwrap(),
            DivisionExceptions::default()
        );
        for bad in [
            "[[rub]]\nid = 106\nsource = \"15:49\"\n",
            "[[rub]]\nid = 106\nsource = \"15:49\"\ntanzil = \"15:50\"\nnote = \"x\"\n",
            "[[rub]]\nid = 241\nsource = \"15:49\"\ntanzil = \"15:50\"\n",
            "[[rub]]\nid = 1\nsource = \"1:1\"\ntanzil = \"1:1\"\n",
            "[[rub]]\nid = 2\nsource = \"2:1\"\ntanzil = \"2:2\"\n[[rub]]\nid = 2\nsource = \"2:1\"\ntanzil = \"2:2\"\n",
            "[[juz]]\nid = 2\n",
        ] {
            assert!(DivisionExceptions::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_committed_header_map_parses() {
        let path = Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/data/qcf_surah_header_cmap.json"
        ));
        let map = HeaderMap::load(path)
            .unwrap()
            .expect("the map is committed");
        assert_eq!(map.get(1), Some(0xFC45));
        assert_eq!(map.get(4), Some(0xFC4A), "non-contiguous");
        assert_eq!(map.get(114), Some(0xFBEB));
        assert_eq!(map.get(0), None);
        assert_eq!(map.get(115), None);
        assert!(
            HeaderMap::load(Path::new("no/such/map.json"))
                .unwrap()
                .is_none()
        );
        assert!(HeaderMap::parse(r#"{"surah-1": {"codepoints": "FC45"}}"#).is_err());
    }

    #[test]
    fn d5_regrouping() {
        let word = |position: u32, code_v1: &str| WordRow {
            id: position,
            ayah_id: 1,
            surah: 38,
            ayah: 24,
            position,
            is_end: false,
            text_hafs: String::new(),
            text_imlaei: None,
            norm_loose: None,
            code_v1: code_v1.to_owned(),
            code_v2: String::new(),
        };
        let mut canonical = vec![word(32, "\u{FBE9}\u{FBEA}"), word(33, "\u{FBEB}")];
        assert!(!regroup_v1(&mut canonical).unwrap());
        let mut combined = vec![word(32, "\u{FBE9}"), word(33, "\u{FBEA}\u{FBEB}")];
        assert!(regroup_v1(&mut combined).unwrap());
        assert_eq!(combined, canonical);
        let mut other = vec![word(32, "\u{FBE9}"), word(33, "\u{FBEB}")];
        assert!(regroup_v1(&mut other).is_err());
        assert!(regroup_v1(&mut []).is_err());
    }

    #[test]
    fn the_rub_sign_only_opens_a_rub_start() {
        let word = |position: u32, text: &str| WordRow {
            id: position,
            ayah_id: 1,
            surah: 2,
            ayah: 26,
            position,
            is_end: false,
            text_hafs: text.to_owned(),
            text_imlaei: None,
            norm_loose: None,
            code_v1: String::new(),
            code_v2: String::new(),
        };
        let ayah = |flags: u32| AyahRow {
            id: 1,
            surah: 2,
            ayah: 26,
            juz: 1,
            hizb: 1,
            rub: 2,
            manzil: 1,
            ruku: 1,
            sajda: 0,
            flags,
            first_word_id: 1,
            last_word_id: 2,
            text_hafs: String::new(),
            text_imlaei: String::new(),
            norm_loose: String::new(),
            norm_strict: String::new(),
        };
        let start = [ayah(FLAG_RUB_START)];
        assert_eq!(
            check_inline_rub_signs(&[word(1, "۞ إِنَّ"), word(2, "ٱللَّهَ")], &start).unwrap(),
            1
        );
        assert_eq!(
            check_inline_rub_signs(&[word(1, "إِنَّ")], &start).unwrap(),
            0,
            "optional"
        );
        assert!(
            check_inline_rub_signs(&[word(1, "۞ إِنَّ")], &[ayah(0)]).is_err(),
            "not a rub start"
        );
        assert!(
            check_inline_rub_signs(&[word(2, "۞ ٱللَّهَ")], &start).is_err(),
            "not the first word"
        );
        assert!(
            check_inline_rub_signs(&[word(1, "إِنَّ ۞")], &start).is_err(),
            "not a prefix"
        );
        assert!(
            check_inline_rub_signs(&[word(1, "۞إِنَّ")], &start).is_err(),
            "no space"
        );
    }

    #[test]
    fn spaces_are_classified() {
        let mut report = DeriveReport::default();
        classify_spaces(Location::new(38, 24, 32), "وَأَنَابَ ۩", &mut report);
        classify_spaces(Location::new(2, 26, 1), "۞ إِنَّ", &mut report);
        classify_spaces(Location::new(2, 181, 3), "بَعۡدَ مَا", &mut report);
        classify_spaces(Location::new(1, 1, 1), "بِسۡمِ", &mut report);
        assert_eq!(report.space_before_sajda, [Location::new(38, 24, 32)]);
        assert_eq!(report.space_after_rub_sign, 1);
        assert_eq!(report.space_between_letters, [Location::new(2, 181, 3)]);
    }

    fn ayah_line(first: u32, last: u32) -> Slot {
        Slot::Ayah {
            first,
            last,
            centered: None,
        }
    }

    #[test]
    fn headers_follow_c15_in_reading_order() {
        // Surah 1 starts on page 1 line 2; surah 2 on page 2 line 3; surah 3's surah_name is the last line of page 2
        // and its basmallah opens page 3 (the An-Nisa shape); surah 4 starts mid-page 3.
        let mut pages = vec![
            vec![Slot::Empty, ayah_line(1, 5)],
            vec![Slot::Empty, Slot::Empty, ayah_line(6, 9), Slot::Empty],
            vec![
                Slot::Empty,
                ayah_line(10, 12),
                Slot::Empty,
                Slot::Empty,
                ayah_line(13, 20),
            ],
        ];
        let previous = assign_headers(&mut pages, &[1, 6, 10, 13]).unwrap();
        assert_eq!(previous, [3]);
        let kinds: Vec<Vec<Option<(LineKind, u32)>>> = pages
            .iter()
            .map(|p| {
                p.iter()
                    .map(|s| match s {
                        Slot::Derived { kind, surah, .. } => Some((*kind, *surah)),
                        _ => None,
                    })
                    .collect()
            })
            .collect();
        assert_eq!(
            kinds,
            [
                vec![Some((LineKind::SurahName, 1)), None],
                vec![
                    Some((LineKind::SurahName, 2)),
                    Some((LineKind::Basmallah, 2)),
                    None,
                    Some((LineKind::SurahName, 3))
                ],
                vec![
                    Some((LineKind::Basmallah, 3)),
                    None,
                    Some((LineKind::SurahName, 4)),
                    Some((LineKind::Basmallah, 4)),
                    None
                ],
            ]
        );
    }

    #[test]
    fn headers_reject_unexplained_and_misplaced_lines() {
        // An extra empty line.
        let mut extra = vec![vec![Slot::Empty, ayah_line(1, 5), Slot::Empty]];
        assert!(assign_headers(&mut extra, &[1]).is_err());
        // A header slot that holds words.
        let mut occupied = vec![vec![Slot::Empty, ayah_line(1, 5), ayah_line(6, 7)]];
        assert!(assign_headers(&mut occupied, &[1, 6]).is_err());
        // The basmallah would have to be on the previous page.
        let mut split = vec![
            vec![Slot::Empty, ayah_line(1, 5), Slot::Empty],
            vec![ayah_line(6, 9)],
        ];
        assert!(assign_headers(&mut split, &[1, 6]).is_err());
        // A surah that does not start a line.
        let mut mid = vec![vec![Slot::Empty, ayah_line(1, 5)]];
        assert!(assign_headers(&mut mid, &[1, 3]).is_err());
        // A source-typed header that matches is accepted; one of the wrong kind is not.
        let typed = |kind| Slot::Header {
            kind,
            surah: Some(1),
            centered: Some(true),
        };
        let mut good = vec![vec![typed(LineKind::SurahName), ayah_line(1, 5)]];
        assert!(assign_headers(&mut good, &[1]).is_ok());
        let mut wrong = vec![vec![typed(LineKind::Basmallah), ayah_line(1, 5)]];
        assert!(assign_headers(&mut wrong, &[1]).is_err());
    }

    #[test]
    fn surahs_1_and_9_have_no_basmallah_line() {
        // Surah s (1..=9) starts at word s; every surah gets its header slot(s) right above its one-word line.
        let page = |basmallah_for_9: bool| {
            let mut slots = vec![Slot::Empty, ayah_line(1, 1)];
            for s in 2..=9 {
                let headers = if s == 9 && !basmallah_for_9 { 1 } else { 2 };
                slots.extend(std::iter::repeat_n(Slot::Empty, headers));
                slots.push(ayah_line(s, s));
            }
            vec![slots]
        };
        let starts: Vec<u32> = (1..=9).collect();
        let mut good = page(false);
        assert_eq!(
            assign_headers(&mut good, &starts).unwrap(),
            Vec::<u32>::new()
        );
        let first_line_of_9 = good[0].len() - 2;
        assert_eq!(
            good[0][first_line_of_9],
            Slot::Derived {
                kind: LineKind::SurahName,
                surah: 9,
                centered: None
            }
        );
        let mut extra = page(true);
        assert!(
            assign_headers(&mut extra, &starts).is_err(),
            "a basmallah slot for surah 9 is unexplained"
        );
    }

    #[test]
    fn coverage_must_be_contiguous() {
        let pages = vec![vec![Slot::Empty, ayah_line(1, 3)], vec![ayah_line(4, 6)]];
        assert!(check_coverage(&pages, 6).is_ok());
        assert!(check_coverage(&pages, 7).is_err());
        let gap = vec![vec![ayah_line(1, 3)], vec![ayah_line(5, 6)]];
        assert!(check_coverage(&gap, 6).is_err());
        let overlap = vec![vec![ayah_line(1, 3), ayah_line(3, 6)]];
        assert!(check_coverage(&overlap, 6).is_err());
    }

    #[test]
    fn centring_rules() {
        let v2 = Centring::V2List;
        assert!(centred(&v2, 1, 5, LineKind::Ayah, Some((1, 2)), None).unwrap());
        assert!(centred(&v2, 300, 1, LineKind::SurahName, None, None).unwrap());
        assert!(centred(&v2, 604, 15, LineKind::Ayah, Some((1, 2)), None).unwrap());
        assert!(!centred(&v2, 604, 13, LineKind::Ayah, Some((1, 2)), None).unwrap());
        let set = BTreeSet::from([(10, 15)]);
        let like = Centring::LikeV2(&set);
        assert!(centred(&like, 600, 9, LineKind::Ayah, Some((10, 15)), None).unwrap());
        assert!(!centred(&like, 600, 10, LineKind::Ayah, Some((10, 14)), None).unwrap());
        assert!(
            centred(
                &Centring::Unavailable,
                3,
                3,
                LineKind::Ayah,
                Some((1, 2)),
                None
            )
            .is_err()
        );
        assert!(
            centred(
                &Centring::Unavailable,
                3,
                3,
                LineKind::Ayah,
                Some((1, 2)),
                Some(false)
            )
            .is_ok()
        );
        assert!(
            centred(
                &Centring::Unavailable,
                1,
                3,
                LineKind::Ayah,
                Some((1, 2)),
                Some(false)
            )
            .is_err(),
            "pages 1–2 are always centred"
        );
    }
}
