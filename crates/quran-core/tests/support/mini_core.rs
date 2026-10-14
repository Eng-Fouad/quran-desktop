//! A small synthetic core.db (built from `schema/core.sql`) for page-assembly tests before and besides the real one.
//!
//! The data is synthetic but structurally faithful to the Madani mushaf rules the real build enforces: 3 surahs, 38
//! ayahs and 281 words (end markers included) laid out in the three layouts (`v2`, `v1`, `v4`) on 4 pages each. Pages
//! 1–2 have 8 centred lines, pages 3–4 have 15; every page starts at an ayah start (G10); surah headers sit on fixed
//! lines (`surah_name` at L−2, `basmallah` at L−1, none before surah 1); ayahs span lines; `v1` breaks pages and lines
//! differently from `v2`, `v4` breaks only lines differently (G10: v4 page starts == v2). It also carries the two sajda
//! shapes (`"… ۩"` with a space inside ONE word, and `۩` attached), an Imla'i word with a space (`يا أيها`), multi-char
//! glyph codes, a surah without `header_cp`, all four division tables, flags, and a finalised FTS index +
//! `vocab_loose`, so search code can use it too.
//!
//! The file is self-contained (std, rusqlite, the schema file): `tests/support/mod.rs` includes it for the integration
//! tests, and `src/core_db/mod.rs` and `xtask/src/fixtures/mushaf.rs` include it (`#[path]`, `cfg(test)`) for unit
//! tests. The normalised columns are
//! spelled out in [`VOCAB`]; `tests/core_mini.rs` proves they equal `normalize_ar` of the Imla'i text.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};

/// The core.db DDL, read from the same file `quran_core::CORE_SQL` embeds (relative to this file, so the
/// include works from every crate that `#[path]`-includes it).
pub const SCHEMA: &str = include_str!("../../schema/core.sql");

/// `meta.source` of a mini DB.
pub const SOURCE: &str = "mini";
/// `meta.built_at` of a mini DB.
pub const BUILT_AT: &str = "2026-10-10T00:00:00Z";
/// Pages per layout.
pub const PAGES: u32 = 4;

/// One vocabulary word: QPC Hafs text, Imla'i text and `normalize_ar(imlaei, Loose | Strict)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Vocab {
    pub hafs: &'static str,
    pub imlaei: &'static str,
    pub loose: &'static str,
    pub strict: &'static str,
}

const fn v(
    hafs: &'static str,
    imlaei: &'static str,
    loose: &'static str,
    strict: &'static str,
) -> Vocab {
    Vocab {
        hafs,
        imlaei,
        loose,
        strict,
    }
}

/// Non-end words cycle through this list in word order (so 1:1 reads `بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ`).
pub const VOCAB: [Vocab; 12] = [
    v("بِسۡمِ", "بسم", "بسم", "بسم"),
    v("ٱللَّهِ", "الله", "الله", "الله"),
    v("ٱلرَّحۡمَٰنِ", "الرحمن", "الرحمن", "الرحمن"),
    v("ٱلرَّحِيمِ", "الرحيم", "الرحيم", "الرحيم"),
    v("ٱلۡحَمۡدُ", "الحمد", "الحمد", "الحمد"),
    v("لِلَّهِ", "لله", "لله", "لله"),
    v("رَبِّ", "رب", "رب", "رب"),
    v("ٱلۡعَٰلَمِينَ", "العالمين", "العالمين", "العالمين"),
    v("ٱلصَّلَوٰةَ", "الصلاة", "الصلاه", "الصلاة"),
    v("يُؤۡمِنُونَ", "يؤمنون", "يومنون", "يؤمنون"),
    v("شَيۡءٖ", "شيء", "شي", "شيء"),
    v("يَٰٓأَيُّهَا", "يا أيها", "يا ايها", "يا ايها"),
];

/// The last non-end word of 2:20: `"space + ۩"` inside ONE word, like 38:24:32 (G5b).
pub const SAJDA_SPACED: Vocab = v("وَأَنَابَ ۩", "وأناب ۩", "واناب", "واناب");
/// The last non-end word of 3:6: `۩` attached, like 7:206:13.
pub const SAJDA_ATTACHED: Vocab = v("يَسۡجُدُونَ۩", "يسجدون", "يسجدون", "يسجدون");

/// A surah of the mini Quran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Surah {
    pub id: u32,
    pub name_ar: &'static str,
    pub name_simple: &'static str,
    pub name_complex: &'static str,
    pub name_en: &'static str,
    /// `makkah` | `madinah`.
    pub revelation_place: &'static str,
    pub revelation_order: u32,
    pub first_ayah_id: u32,
    pub rukus: u32,
    pub bismillah_pre: bool,
    pub header_cp: Option<u32>,
    /// Non-end words per ayah (the end marker comes on top).
    pub words_per_ayah: Vec<u32>,
}

impl Surah {
    #[must_use]
    pub fn ayah_count(&self) -> u32 {
        u32::try_from(self.words_per_ayah.len()).unwrap()
    }
}

/// A `word` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub id: u32,
    pub ayah_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub position: u32,
    pub is_end: bool,
    pub text_hafs: String,
    pub text_imlaei: Option<String>,
    pub norm_loose: Option<String>,
    pub norm_strict: Option<String>,
    pub code_v1: String,
    pub code_v2: String,
}

/// An `ayah` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ayah {
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

/// A `line` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub line: u32,
    /// 0 ayah, 1 surah_name, 2 basmallah.
    pub kind: u32,
    pub centered: bool,
    pub surah_id: Option<u32>,
    pub first_word_id: Option<u32>,
    pub last_word_id: Option<u32>,
}

/// A `page` row and its lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub page: u32,
    pub lines: Vec<Line>,
    pub first_word_id: u32,
    pub last_word_id: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

/// One layout (`mushaf` row) with its pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub mushaf_id: u32,
    pub code: &'static str,
    pub name: &'static str,
    pub glyph_column: &'static str,
    pub pages: Vec<Page>,
}

/// An inclusive ayah-id range of a division table (`juz`, `hizb`, `rub`, `manzil`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Division {
    pub id: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

/// A `ruku` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ruku {
    pub id: u32,
    pub surah: u32,
    pub first_ayah_id: u32,
    pub last_ayah_id: u32,
}

/// A `sajda` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sajda {
    pub id: u32,
    pub ayah_id: u32,
    /// `recommended` | `obligatory`.
    pub kind: &'static str,
}

/// The whole mini Quran: the model the DB is written from, so tests can derive their expectations independently of
/// the code under test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniCore {
    /// Where [`build`] wrote it (empty for [`model`]).
    pub path: PathBuf,
    pub surahs: Vec<Surah>,
    pub ayahs: Vec<Ayah>,
    pub words: Vec<Word>,
    pub juz: Vec<Division>,
    pub hizb: Vec<Division>,
    pub rub: Vec<Division>,
    pub manzil: Vec<Division>,
    pub ruku: Vec<Ruku>,
    pub sajdas: Vec<Sajda>,
    /// `v2` (1), `v1` (2), `v4` (19).
    pub layouts: Vec<Layout>,
}

impl MiniCore {
    #[must_use]
    pub fn surah(&self, id: u32) -> &Surah {
        self.surahs.iter().find(|s| s.id == id).unwrap()
    }

    /// The ayah `surah:ayah`.
    #[must_use]
    pub fn ayah(&self, surah: u32, ayah: u32) -> &Ayah {
        self.ayahs
            .iter()
            .find(|a| a.surah == surah && a.ayah == ayah)
            .unwrap_or_else(|| panic!("mini core has no ayah {surah}:{ayah}"))
    }

    #[must_use]
    pub fn ayah_by_id(&self, id: u32) -> &Ayah {
        &self.ayahs[usize::try_from(id - 1).unwrap()]
    }

    #[must_use]
    pub fn word(&self, id: u32) -> &Word {
        &self.words[usize::try_from(id - 1).unwrap()]
    }

    /// The layout with this `mushaf_id` (1, 2 or 19).
    #[must_use]
    pub fn layout(&self, mushaf_id: u32) -> &Layout {
        self.layouts
            .iter()
            .find(|l| l.mushaf_id == mushaf_id)
            .unwrap()
    }

    /// The page of `layout` that holds `word_id`.
    #[must_use]
    pub fn page_of_word(&self, mushaf_id: u32, word_id: u32) -> u32 {
        self.layout(mushaf_id)
            .pages
            .iter()
            .find(|p| (p.first_word_id..=p.last_word_id).contains(&word_id))
            .unwrap()
            .page
    }

    #[must_use]
    pub fn ayah_count(&self) -> u32 {
        u32::try_from(self.ayahs.len()).unwrap()
    }

    #[must_use]
    pub fn word_count(&self) -> u32 {
        u32::try_from(self.words.len()).unwrap()
    }
}

/// One segment of a page description.
#[derive(Debug, Clone, Copy)]
enum Seg {
    /// The header lines of a surah: `surah_name`, plus `basmallah` when `bismillah_pre`.
    Header(u32),
    /// `lines` ayah lines holding every word up to the end of ayah id `until` (evenly spread, earlier lines longer).
    Run { lines: u32, until: u32 },
}

/// A layout to generate: `(mushaf_id, code, name, glyph_column, pages)`.
type LayoutSpec = (u32, &'static str, &'static str, &'static str, Vec<Vec<Seg>>);

/// Pages of each layout. Ayah ids: surah 1 = 1..=7, surah 2 = 8..=32, surah 3 = 33..=38.
fn layout_specs() -> [LayoutSpec; 3] {
    use Seg::{Header, Run};
    [
        (
            1,
            "v2",
            "Madani 1421H (mini)",
            "code_v2",
            vec![
                vec![Header(1), Run { lines: 7, until: 7 }],
                vec![
                    Header(2),
                    Run {
                        lines: 6,
                        until: 12,
                    },
                ],
                vec![Run {
                    lines: 15,
                    until: 27,
                }],
                vec![
                    Run {
                        lines: 7,
                        until: 32,
                    },
                    Header(3),
                    Run {
                        lines: 6,
                        until: 38,
                    },
                ],
            ],
        ),
        (
            2,
            "v1",
            "Madani 1405H (mini)",
            "code_v1",
            vec![
                vec![Header(1), Run { lines: 7, until: 7 }],
                vec![
                    Header(2),
                    Run {
                        lines: 6,
                        until: 11,
                    },
                ],
                vec![Run {
                    lines: 15,
                    until: 26,
                }],
                vec![
                    Run {
                        lines: 8,
                        until: 32,
                    },
                    Header(3),
                    Run {
                        lines: 5,
                        until: 38,
                    },
                ],
            ],
        ),
        (
            19,
            "v4",
            "Madani 1441H tajweed (mini)",
            "code_v2",
            vec![
                vec![Header(1), Run { lines: 7, until: 7 }],
                vec![
                    Header(2),
                    Run {
                        lines: 6,
                        until: 12,
                    },
                ],
                vec![Run {
                    lines: 15,
                    until: 27,
                }],
                vec![
                    Run {
                        lines: 6,
                        until: 32,
                    },
                    Header(3),
                    Run {
                        lines: 7,
                        until: 38,
                    },
                ],
            ],
        ),
    ]
}

/// Extra centred ayah lines beyond pages 1–2 and header lines: `(mushaf_id, page, line)`.
const CENTRED: &[(u32, u32, u32)] = &[(1, 4, 15), (19, 4, 15)];

fn surah_defs() -> Vec<Surah> {
    vec![
        Surah {
            id: 1,
            name_ar: "الفاتحة",
            name_simple: "Al-Fatihah",
            name_complex: "Al-Fātiĥah",
            name_en: "The Opener",
            revelation_place: "makkah",
            revelation_order: 5,
            first_ayah_id: 1,
            rukus: 1,
            bismillah_pre: false,
            header_cp: Some(0xFC45),
            words_per_ayah: vec![4, 4, 2, 3, 4, 5, 9],
        },
        Surah {
            id: 2,
            name_ar: "البقرة",
            name_simple: "Al-Baqarah",
            name_complex: "Al-Baqarah",
            name_en: "The Cow",
            revelation_place: "madinah",
            revelation_order: 87,
            first_ayah_id: 8,
            rukus: 2,
            bismillah_pre: true,
            header_cp: Some(0xFC46),
            words_per_ayah: (1..=25).map(|k| 3 + (5 * k) % 9).collect(),
        },
        Surah {
            id: 3,
            name_ar: "آل عمران",
            name_simple: "Ali 'Imran",
            name_complex: "Āli `Imrān",
            name_en: "Family of Imran",
            revelation_place: "madinah",
            revelation_order: 89,
            first_ayah_id: 33,
            rukus: 1,
            bismillah_pre: true,
            header_cp: None,
            words_per_ayah: vec![3, 6, 4, 8, 5, 7],
        },
    ]
}

const fn d(id: u32, first_ayah_id: u32, last_ayah_id: u32) -> Division {
    Division {
        id,
        first_ayah_id,
        last_ayah_id,
    }
}

const JUZ: [Division; 2] = [d(1, 1, 20), d(2, 21, 38)];
const HIZB: [Division; 4] = [d(1, 1, 12), d(2, 13, 20), d(3, 21, 30), d(4, 31, 38)];
/// Hizb h = rub 4h−3..=4h, so the hizb flag (bit1) lands on rub 1, 5, 9, 13.
const RUB: [Division; 16] = [
    d(1, 1, 5),
    d(2, 6, 8),
    d(3, 9, 10),
    d(4, 11, 12),
    d(5, 13, 14),
    d(6, 15, 16),
    d(7, 17, 18),
    d(8, 19, 20),
    d(9, 21, 23),
    d(10, 24, 26),
    d(11, 27, 28),
    d(12, 29, 30),
    d(13, 31, 33),
    d(14, 34, 35),
    d(15, 36, 37),
    d(16, 38, 38),
];
const MANZIL: [Division; 1] = [d(1, 1, 38)];
const RUKU: [Ruku; 4] = [
    Ruku {
        id: 1,
        surah: 1,
        first_ayah_id: 1,
        last_ayah_id: 7,
    },
    Ruku {
        id: 2,
        surah: 2,
        first_ayah_id: 8,
        last_ayah_id: 17,
    },
    Ruku {
        id: 3,
        surah: 2,
        first_ayah_id: 18,
        last_ayah_id: 32,
    },
    Ruku {
        id: 4,
        surah: 3,
        first_ayah_id: 33,
        last_ayah_id: 38,
    },
];
/// 2:20 (id 27) recommended, 3:6 (id 38) obligatory.
const SAJDAS: [Sajda; 2] = [
    Sajda {
        id: 1,
        ayah_id: 27,
        kind: "recommended",
    },
    Sajda {
        id: 2,
        ayah_id: 38,
        kind: "obligatory",
    },
];

fn division_of(table: &[Division], ayah_id: u32) -> u32 {
    table
        .iter()
        .find(|d| (d.first_ayah_id..=d.last_ayah_id).contains(&ayah_id))
        .unwrap()
        .id
}

/// Arabic-Indic digits of `n` (U+0660–U+0669).
#[must_use]
pub fn arabic_digits(n: u32) -> String {
    n.to_string()
        .chars()
        .map(|c| char::from_u32(0x0660 + c.to_digit(10).unwrap()).unwrap())
        .collect()
}

/// Synthetic glyph codes in the private-use area; every tenth word gets two chars (like waqf ligatures).
fn glyph_code(base: u32, word_id: u32) -> String {
    let mut code = String::new();
    code.push(char::from_u32(base + word_id).unwrap());
    if word_id.is_multiple_of(10) {
        code.push(char::from_u32(base + 0x200 + word_id).unwrap());
    }
    code
}

/// The mini Quran without writing it.
#[must_use]
pub fn model() -> MiniCore {
    let surahs = surah_defs();
    let mut ayahs = Vec::new();
    let mut words = Vec::new();
    let mut vocab_cursor = 0usize;
    let (mut prev_juz, mut prev_rub) = (0, 0);
    for surah in &surahs {
        for (index, &count) in surah.words_per_ayah.iter().enumerate() {
            let ayah_no = u32::try_from(index).unwrap() + 1;
            let ayah_id = u32::try_from(ayahs.len()).unwrap() + 1;
            let first_word_id = u32::try_from(words.len()).unwrap() + 1;
            let mut texts = Vec::new();
            for position in 1..=count {
                let mut entry = VOCAB[vocab_cursor % VOCAB.len()];
                vocab_cursor += 1;
                if position == count && (surah.id, ayah_no) == (2, 20) {
                    entry = SAJDA_SPACED;
                }
                if position == count && (surah.id, ayah_no) == (3, 6) {
                    entry = SAJDA_ATTACHED;
                }
                texts.push(entry);
                let id = u32::try_from(words.len()).unwrap() + 1;
                words.push(Word {
                    id,
                    ayah_id,
                    surah: surah.id,
                    ayah: ayah_no,
                    position,
                    is_end: false,
                    text_hafs: entry.hafs.to_owned(),
                    text_imlaei: Some(entry.imlaei.to_owned()),
                    norm_loose: Some(entry.loose.to_owned()),
                    norm_strict: Some(entry.strict.to_owned()),
                    code_v1: glyph_code(0xF100, id),
                    code_v2: glyph_code(0xF500, id),
                });
            }
            let end_id = u32::try_from(words.len()).unwrap() + 1;
            let marker = format!("\u{06DD}{}", arabic_digits(ayah_no));
            words.push(Word {
                id: end_id,
                ayah_id,
                surah: surah.id,
                ayah: ayah_no,
                position: count + 1,
                is_end: true,
                text_hafs: marker.clone(),
                text_imlaei: None,
                norm_loose: None,
                norm_strict: None,
                code_v1: glyph_code(0xF100, end_id),
                code_v2: glyph_code(0xF500, end_id),
            });
            let juz = division_of(&JUZ, ayah_id);
            let rub = division_of(&RUB, ayah_id);
            let mut flags = 0;
            if rub != prev_rub {
                flags |= 1;
                if (rub - 1).is_multiple_of(4) {
                    flags |= 2;
                }
            }
            if juz != prev_juz {
                flags |= 4;
            }
            if ayah_no == 1 {
                flags |= 8;
            }
            (prev_juz, prev_rub) = (juz, rub);
            let join =
                |f: fn(&Vocab) -> &'static str| texts.iter().map(f).collect::<Vec<_>>().join(" ");
            let mut text_hafs = join(|v| v.hafs);
            text_hafs.push(' ');
            text_hafs.push_str(&marker);
            ayahs.push(Ayah {
                id: ayah_id,
                surah: surah.id,
                ayah: ayah_no,
                juz,
                hizb: division_of(&HIZB, ayah_id),
                rub,
                manzil: division_of(&MANZIL, ayah_id),
                ruku: RUKU
                    .iter()
                    .find(|r| (r.first_ayah_id..=r.last_ayah_id).contains(&ayah_id))
                    .unwrap()
                    .id,
                sajda: SAJDAS
                    .iter()
                    .find(|s| s.ayah_id == ayah_id)
                    .map_or(0, |s| if s.kind == "obligatory" { 2 } else { 1 }),
                flags,
                first_word_id,
                last_word_id: end_id,
                text_hafs,
                text_imlaei: join(|v| v.imlaei),
                norm_loose: join(|v| v.loose),
                norm_strict: join(|v| v.strict),
            });
        }
    }
    let layouts = layout_specs()
        .into_iter()
        .map(|(mushaf_id, code, name, glyph_column, pages)| Layout {
            mushaf_id,
            code,
            name,
            glyph_column,
            pages: lay_out(mushaf_id, &pages, &surahs, &ayahs),
        })
        .collect();
    MiniCore {
        path: PathBuf::new(),
        surahs,
        ayahs,
        words,
        juz: JUZ.to_vec(),
        hizb: HIZB.to_vec(),
        rub: RUB.to_vec(),
        manzil: MANZIL.to_vec(),
        ruku: RUKU.to_vec(),
        sajdas: SAJDAS.to_vec(),
        layouts,
    }
}

/// Expands the page descriptions of one layout into lines (checking the shape rules as it goes).
fn lay_out(mushaf_id: u32, specs: &[Vec<Seg>], surahs: &[Surah], ayahs: &[Ayah]) -> Vec<Page> {
    let mut next_word = 1u32;
    let mut pages = Vec::new();
    for (index, segs) in specs.iter().enumerate() {
        let page_no = u32::try_from(index).unwrap() + 1;
        let mut lines: Vec<Line> = Vec::new();
        let page_first_word = next_word;
        for seg in segs {
            match *seg {
                Seg::Header(surah_id) => {
                    let surah = surahs.iter().find(|s| s.id == surah_id).unwrap();
                    let mut push = |kind| {
                        let line = u32::try_from(lines.len()).unwrap() + 1;
                        lines.push(Line {
                            line,
                            kind,
                            centered: true,
                            surah_id: Some(surah_id),
                            first_word_id: None,
                            last_word_id: None,
                        });
                    };
                    push(1);
                    if surah.bismillah_pre {
                        push(2);
                    }
                }
                Seg::Run {
                    lines: count,
                    until,
                } => {
                    let last = ayahs[usize::try_from(until - 1).unwrap()].last_word_id;
                    let total = last + 1 - next_word;
                    let (base, extra) = (total / count, total % count);
                    assert!(
                        base >= 1,
                        "layout {mushaf_id} page {page_no}: an empty line"
                    );
                    for i in 0..count {
                        let len = base + u32::from(i < extra);
                        let line = u32::try_from(lines.len()).unwrap() + 1;
                        lines.push(Line {
                            line,
                            kind: 0,
                            centered: page_no <= 2 || CENTRED.contains(&(mushaf_id, page_no, line)),
                            surah_id: None,
                            first_word_id: Some(next_word),
                            last_word_id: Some(next_word + len - 1),
                        });
                        next_word += len;
                    }
                    assert_eq!(next_word, last + 1);
                }
            }
        }
        let expected_lines = if page_no <= 2 { 8 } else { 15 };
        assert_eq!(
            lines.len(),
            expected_lines,
            "layout {mushaf_id} page {page_no}: line count"
        );
        let page_last_word = next_word - 1;
        let ayah_of = |word: u32| {
            ayahs
                .iter()
                .find(|a| (a.first_word_id..=a.last_word_id).contains(&word))
                .unwrap()
        };
        assert_eq!(
            ayah_of(page_first_word).first_word_id,
            page_first_word,
            "G10: page {page_no} starts at an ayah start"
        );
        pages.push(Page {
            page: page_no,
            lines,
            first_word_id: page_first_word,
            last_word_id: page_last_word,
            first_ayah_id: ayah_of(page_first_word).id,
            last_ayah_id: ayah_of(page_last_word).id,
        });
    }
    let total_words = ayahs.last().unwrap().last_word_id;
    assert_eq!(
        next_word,
        total_words + 1,
        "layout {mushaf_id} covers every word"
    );
    pages
}

/// Writes the mini core.db to `dir/core.db` and returns its model (with `path` set).
#[must_use]
pub fn build(dir: &Path) -> MiniCore {
    let path = dir.join("core.db");
    let mut mini = model();
    write(&mini, &path);
    mini.path = path;
    mini
}

/// Writes `mini` to `path` (which must not exist), finalised like a real build: FTS + optimize, vocab,
/// ANALYZE, journal_mode DELETE, VACUUM.
pub fn write(mini: &MiniCore, path: &Path) {
    let mut conn = Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    let tx = conn.transaction().unwrap();
    {
        let meta = [
            ("schema_version", "1".to_owned()),
            ("normalizer_version", "1".to_owned()),
            ("source", SOURCE.to_owned()),
            ("source_manifest_sha256", "0".repeat(64)),
            ("tanzil_sha256", "0".repeat(64)),
            ("built_at", BUILT_AT.to_owned()),
            ("builder", "mini_core".to_owned()),
            ("ayah_count", mini.ayah_count().to_string()),
            ("word_count", mini.word_count().to_string()),
            ("licence_note", "synthetic test data".to_owned()),
        ];
        for (key, value) in meta {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .unwrap();
        }
        for layout in &mini.layouts {
            tx.execute(
                "INSERT INTO mushaf (id, code, name, pages, lines_per_page, glyph_column)
                 VALUES (?1, ?2, ?3, ?4, 15, ?5)",
                params![
                    layout.mushaf_id,
                    layout.code,
                    layout.name,
                    u32::try_from(layout.pages.len()).unwrap(),
                    layout.glyph_column
                ],
            )
            .unwrap();
        }
        for s in &mini.surahs {
            tx.execute(
                "INSERT INTO surah (id, name_ar, name_simple, name_complex, name_en, revelation_place,
                                    revelation_order, ayah_count, first_ayah_id, rukus, bismillah_pre, header_cp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    s.id,
                    s.name_ar,
                    s.name_simple,
                    s.name_complex,
                    s.name_en,
                    s.revelation_place,
                    s.revelation_order,
                    s.ayah_count(),
                    s.first_ayah_id,
                    s.rukus,
                    s.bismillah_pre,
                    s.header_cp
                ],
            )
            .unwrap();
        }
        for (table, rows) in [
            ("juz", &mini.juz),
            ("hizb", &mini.hizb),
            ("rub", &mini.rub),
            ("manzil", &mini.manzil),
        ] {
            for r in rows {
                tx.execute(
                    &format!(
                        "INSERT INTO {table} (id, first_ayah_id, last_ayah_id) VALUES (?1, ?2, ?3)"
                    ),
                    params![r.id, r.first_ayah_id, r.last_ayah_id],
                )
                .unwrap();
            }
        }
        for r in &mini.ruku {
            tx.execute(
                "INSERT INTO ruku (id, surah, first_ayah_id, last_ayah_id) VALUES (?1, ?2, ?3, ?4)",
                params![r.id, r.surah, r.first_ayah_id, r.last_ayah_id],
            )
            .unwrap();
        }
        for s in &mini.sajdas {
            tx.execute(
                "INSERT INTO sajda (id, ayah_id, kind) VALUES (?1, ?2, ?3)",
                params![s.id, s.ayah_id, s.kind],
            )
            .unwrap();
        }
        for a in &mini.ayahs {
            tx.execute(
                "INSERT INTO ayah (id, surah, ayah, juz, hizb, rub, manzil, ruku, sajda, flags, first_word_id,
                                   last_word_id, text_hafs, text_imlaei, norm_loose, norm_strict)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    a.id,
                    a.surah,
                    a.ayah,
                    a.juz,
                    a.hizb,
                    a.rub,
                    a.manzil,
                    a.ruku,
                    a.sajda,
                    a.flags,
                    a.first_word_id,
                    a.last_word_id,
                    a.text_hafs,
                    a.text_imlaei,
                    a.norm_loose,
                    a.norm_strict
                ],
            )
            .unwrap();
        }
        for w in &mini.words {
            tx.execute(
                "INSERT INTO word (id, ayah_id, surah, ayah, position, is_end, text_hafs, text_imlaei, norm_loose,
                                   code_v1, code_v2)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    w.id,
                    w.ayah_id,
                    w.surah,
                    w.ayah,
                    w.position,
                    w.is_end,
                    w.text_hafs,
                    w.text_imlaei,
                    w.norm_loose,
                    w.code_v1,
                    w.code_v2
                ],
            )
            .unwrap();
        }
        for layout in &mini.layouts {
            for page in &layout.pages {
                tx.execute(
                    "INSERT INTO page (mushaf_id, page, first_word_id, last_word_id, first_ayah_id, last_ayah_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        layout.mushaf_id,
                        page.page,
                        page.first_word_id,
                        page.last_word_id,
                        page.first_ayah_id,
                        page.last_ayah_id
                    ],
                )
                .unwrap();
                for line in &page.lines {
                    tx.execute(
                        "INSERT INTO line (mushaf_id, page, line, kind, centered, surah_id, first_word_id,
                                           last_word_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            layout.mushaf_id,
                            page.page,
                            line.line,
                            line.kind,
                            line.centered,
                            line.surah_id,
                            line.first_word_id,
                            line.last_word_id
                        ],
                    )
                    .unwrap();
                }
            }
        }
    }
    tx.commit().unwrap();
    conn.execute_batch(
        "INSERT INTO ayah_fts(rowid, loose, strict) SELECT id, norm_loose, norm_strict FROM ayah;
         INSERT INTO ayah_fts(ayah_fts) VALUES('optimize');
         CREATE VIRTUAL TABLE temp.v USING fts5vocab(main, ayah_fts, 'col');
         INSERT INTO vocab_loose(term, doc_count) SELECT term, doc FROM temp.v WHERE col = 'loose';
         DROP TABLE temp.v;
         ANALYZE;
         PRAGMA journal_mode = DELETE;
         VACUUM;",
    )
    .unwrap();
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(check, "ok");
}
