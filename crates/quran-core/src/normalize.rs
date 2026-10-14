//! Arabic search normaliser, Latin folding and tokens.
//!
//! [`normalize_ar`] is the single definition of "the same word" for search: core.db's `ayah.norm_*`/`word.norm_loose`
//! columns, `vocab_loose`, user queries, note bodies and Arabic pack folds are all produced by it. The TypeScript port
//! (`src/lib/text/normalize.ts`) MUST pass the same golden file, `tests/data/normalize_vectors.json`.
//!
//! Any change to the output for any input is a [`NORMALIZER_VERSION`] bump, which forces a core.db rebuild and a
//! pack/notes FTS rebuild at startup.

use std::cmp::Ordering;

use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Type, ValueRef};
use unicode_normalization::UnicodeNormalization;

/// Version of the [`normalize_ar`] rules. Bump ⇒ core.db rebuild + pack/notes FTS rebuild (startup check, G13).
pub const NORMALIZER_VERSION: u32 = 1;

/// How much of the Arabic orthography a search ignores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Level {
    /// Diacritics, alef forms, alef maqsura and Persian/Urdu letter forms are folded; hamza seats and teh marbuta are
    /// kept (the `strict` FTS column, "exact" search mode).
    Strict,
    /// Strict, plus ة→ه, ؤ→و, ئ→ي and ء dropped (the `loose` FTS column, "smart" and "substring" search modes).
    Loose,
}

/// Normalises Arabic text for indexing and search. The steps, applied in order to each char of the NFKC form:
///
/// | Step | Input | Action | Levels |
/// |---|---|---|---|
/// | 0 | whole string | Unicode NFKC (ﷲ → الله; ا+U+0653 → آ; ا+U+0654 → أ; و+U+0654 → ؤ; ي+U+0654 → ئ) | both |
/// | 1 | U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED, U+08D3–08FF, U+0640, U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF | delete | both |
/// | 2 | أ إ آ ٱ ٲ ٳ | → ا | both |
/// | 3 | ى ی | → ي | both |
/// | 4 | ک → ك; ہ ھ → ه; ۃ → ة | map | both |
/// | 5 | ة | → ه | Loose |
/// | 6 | ؤ → و; ئ → ي | map | Loose |
/// | 7 | ء | delete | Loose |
/// | 8 | U+0660–0669, U+06F0–06F9 | → ASCII 0–9 | both |
/// | 9 | whitespace, ASCII punctuation, ، ؛ ؟ ۔ | → one space; collapse runs; trim | both |
///
/// Latin letters keep their case (see [`fold_latin`] for Latin search folding). Never split the *source* text of an
/// ayah or word on spaces to recover words; split only normalised query text, with [`tokens`].
#[must_use]
pub fn normalize_ar(s: &str, level: Level) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.nfkc() {
        match fold_char(c, level) {
            Folded::Drop => {}
            // Step 9: a run of separators becomes one space, and only between two kept chars (collapse + trim).
            Folded::Space => pending_space = !out.is_empty(),
            Folded::Char(c) => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push(c);
            }
        }
    }
    out
}

/// Folds text for Latin-script search: Unicode NFKD, drop nonspacing marks (`General_Category = Mn`), Unicode lowercase,
/// and collapse whitespace runs to one space (trimmed). Used for `like_fallback` pack folds, non-Arabic pack queries and
/// note bodies (`body_search = fold_latin(normalize_ar(body, Loose))`).
#[must_use]
pub fn fold_latin(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.nfkd() {
        if is_nonspacing_mark(c) {
            continue;
        }
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// The tokens of an already normalised string ([`normalize_ar`] or [`fold_latin`] output): split on U+0020, skipping
/// empty pieces.
pub fn tokens(normalized: &str) -> impl Iterator<Item = &str> {
    normalized.split(' ').filter(|t| !t.is_empty())
}

/// Whether `c` is in the step-1 deletion set (harakat, Quranic annotation marks, tatweel, zero-width and bidi
/// controls). A normalised string never contains such a char (verify-core gate G13).
#[must_use]
pub const fn is_stripped(c: char) -> bool {
    matches!(
        c as u32,
        0x0610..=0x061A
            | 0x064B..=0x065F
            | 0x0670
            | 0x06D6..=0x06ED
            | 0x08D3..=0x08FF
            | 0x0640
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2066..=0x2069
            | 0xFEFF
    )
}

/// Registers the deterministic SQL scalar function `ar_norm(text)` = `normalize_ar(text, Loose)` on `conn` (used by
/// `CoreDb`'s pool initialiser and `UserDb::open`). `NULL` maps to `NULL`; numbers are normalised as
/// their decimal text; a BLOB argument is an error.
pub fn register_ar_norm(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "ar_norm",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let text = match ctx.get_raw(0) {
                ValueRef::Null => return Ok(None),
                ValueRef::Text(bytes) => std::str::from_utf8(bytes)
                    .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?
                    .to_owned(),
                ValueRef::Integer(i) => i.to_string(),
                ValueRef::Real(f) => f.to_string(),
                ValueRef::Blob(_) => {
                    return Err(rusqlite::Error::InvalidFunctionParameterType(0, Type::Blob));
                }
            };
            Ok(Some(normalize_ar(&text, Level::Loose)))
        },
    )
}

/// What one NFKC char becomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Folded {
    Drop,
    Space,
    Char(char),
}

/// Steps 1–9 of [`normalize_ar`] for one char, in table order.
fn fold_char(c: char, level: Level) -> Folded {
    // Step 1: harakat, Quranic marks, tatweel, zero-width and bidi controls.
    if is_stripped(c) {
        return Folded::Drop;
    }
    let c = match c {
        // Step 2: أ إ آ ٱ ٲ ٳ → ا
        '\u{0623}' | '\u{0625}' | '\u{0622}' | '\u{0671}' | '\u{0672}' | '\u{0673}' => '\u{0627}',
        // Step 3: ى (alef maqsura), ی (Farsi yeh) → ي
        '\u{0649}' | '\u{06CC}' => '\u{064A}',
        // Step 4: ک → ك; ہ ھ → ه; ۃ → ة
        '\u{06A9}' => '\u{0643}',
        '\u{06C1}' | '\u{06BE}' => '\u{0647}',
        '\u{06C3}' => '\u{0629}',
        other => other,
    };
    let c = if level == Level::Loose {
        match c {
            // Step 5: ة → ه
            '\u{0629}' => '\u{0647}',
            // Step 6: ؤ → و; ئ → ي
            '\u{0624}' => '\u{0648}',
            '\u{0626}' => '\u{064A}',
            // Step 7: ء is dropped
            '\u{0621}' => return Folded::Drop,
            other => other,
        }
    } else {
        c
    };
    // Step 8: Arabic-Indic and Extended Arabic-Indic (Persian/Urdu) digits → ASCII.
    let c = match c as u32 {
        cp @ 0x0660..=0x0669 => ascii_digit(cp - 0x0660),
        cp @ 0x06F0..=0x06F9 => ascii_digit(cp - 0x06F0),
        _ => c,
    };
    // Step 9: separators.
    if c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(c, '\u{060C}' | '\u{061B}' | '\u{061F}' | '\u{06D4}')
    {
        return Folded::Space;
    }
    Folded::Char(c)
}

/// `0..=9` → `'0'..='9'` (callers pass a digit offset).
fn ascii_digit(offset: u32) -> char {
    char::from_digit(offset, 10).unwrap_or('0')
}

/// `General_Category = Mn` (nonspacing mark), by binary search over [`MN_RANGES`].
fn is_nonspacing_mark(c: char) -> bool {
    let cp = c as u32;
    if cp < 0x0300 {
        return false;
    }
    MN_RANGES
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                Ordering::Less
            } else if lo > cp {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

/// Inclusive code-point ranges of `General_Category = Mn`, sorted and disjoint. Generated from the Unicode Character
/// Database with `/^\p{Mn}$/u` over every code point (Node ICU); regenerate when bumping Unicode, which is a
/// [`NORMALIZER_VERSION`] bump only if it changes [`normalize_ar`] (it does not: `fold_latin` is not versioned there).
#[rustfmt::skip]
const MN_RANGES: &[(u32, u32)] = &[
    // 365 ranges, Unicode 17.0, ICU 78.3
    (0x0300, 0x036F), (0x0483, 0x0487), (0x0591, 0x05BD), (0x05BF, 0x05BF), (0x05C1, 0x05C2), (0x05C4, 0x05C5),
    (0x05C7, 0x05C7), (0x0610, 0x061A), (0x064B, 0x065F), (0x0670, 0x0670), (0x06D6, 0x06DC), (0x06DF, 0x06E4),
    (0x06E7, 0x06E8), (0x06EA, 0x06ED), (0x0711, 0x0711), (0x0730, 0x074A), (0x07A6, 0x07B0), (0x07EB, 0x07F3),
    (0x07FD, 0x07FD), (0x0816, 0x0819), (0x081B, 0x0823), (0x0825, 0x0827), (0x0829, 0x082D), (0x0859, 0x085B),
    (0x0897, 0x089F), (0x08CA, 0x08E1), (0x08E3, 0x0902), (0x093A, 0x093A), (0x093C, 0x093C), (0x0941, 0x0948),
    (0x094D, 0x094D), (0x0951, 0x0957), (0x0962, 0x0963), (0x0981, 0x0981), (0x09BC, 0x09BC), (0x09C1, 0x09C4),
    (0x09CD, 0x09CD), (0x09E2, 0x09E3), (0x09FE, 0x09FE), (0x0A01, 0x0A02), (0x0A3C, 0x0A3C), (0x0A41, 0x0A42),
    (0x0A47, 0x0A48), (0x0A4B, 0x0A4D), (0x0A51, 0x0A51), (0x0A70, 0x0A71), (0x0A75, 0x0A75), (0x0A81, 0x0A82),
    (0x0ABC, 0x0ABC), (0x0AC1, 0x0AC5), (0x0AC7, 0x0AC8), (0x0ACD, 0x0ACD), (0x0AE2, 0x0AE3), (0x0AFA, 0x0AFF),
    (0x0B01, 0x0B01), (0x0B3C, 0x0B3C), (0x0B3F, 0x0B3F), (0x0B41, 0x0B44), (0x0B4D, 0x0B4D), (0x0B55, 0x0B56),
    (0x0B62, 0x0B63), (0x0B82, 0x0B82), (0x0BC0, 0x0BC0), (0x0BCD, 0x0BCD), (0x0C00, 0x0C00), (0x0C04, 0x0C04),
    (0x0C3C, 0x0C3C), (0x0C3E, 0x0C40), (0x0C46, 0x0C48), (0x0C4A, 0x0C4D), (0x0C55, 0x0C56), (0x0C62, 0x0C63),
    (0x0C81, 0x0C81), (0x0CBC, 0x0CBC), (0x0CBF, 0x0CBF), (0x0CC6, 0x0CC6), (0x0CCC, 0x0CCD), (0x0CE2, 0x0CE3),
    (0x0D00, 0x0D01), (0x0D3B, 0x0D3C), (0x0D41, 0x0D44), (0x0D4D, 0x0D4D), (0x0D62, 0x0D63), (0x0D81, 0x0D81),
    (0x0DCA, 0x0DCA), (0x0DD2, 0x0DD4), (0x0DD6, 0x0DD6), (0x0E31, 0x0E31), (0x0E34, 0x0E3A), (0x0E47, 0x0E4E),
    (0x0EB1, 0x0EB1), (0x0EB4, 0x0EBC), (0x0EC8, 0x0ECE), (0x0F18, 0x0F19), (0x0F35, 0x0F35), (0x0F37, 0x0F37),
    (0x0F39, 0x0F39), (0x0F71, 0x0F7E), (0x0F80, 0x0F84), (0x0F86, 0x0F87), (0x0F8D, 0x0F97), (0x0F99, 0x0FBC),
    (0x0FC6, 0x0FC6), (0x102D, 0x1030), (0x1032, 0x1037), (0x1039, 0x103A), (0x103D, 0x103E), (0x1058, 0x1059),
    (0x105E, 0x1060), (0x1071, 0x1074), (0x1082, 0x1082), (0x1085, 0x1086), (0x108D, 0x108D), (0x109D, 0x109D),
    (0x135D, 0x135F), (0x1712, 0x1714), (0x1732, 0x1733), (0x1752, 0x1753), (0x1772, 0x1773), (0x17B4, 0x17B5),
    (0x17B7, 0x17BD), (0x17C6, 0x17C6), (0x17C9, 0x17D3), (0x17DD, 0x17DD), (0x180B, 0x180D), (0x180F, 0x180F),
    (0x1885, 0x1886), (0x18A9, 0x18A9), (0x1920, 0x1922), (0x1927, 0x1928), (0x1932, 0x1932), (0x1939, 0x193B),
    (0x1A17, 0x1A18), (0x1A1B, 0x1A1B), (0x1A56, 0x1A56), (0x1A58, 0x1A5E), (0x1A60, 0x1A60), (0x1A62, 0x1A62),
    (0x1A65, 0x1A6C), (0x1A73, 0x1A7C), (0x1A7F, 0x1A7F), (0x1AB0, 0x1ABD), (0x1ABF, 0x1ADD), (0x1AE0, 0x1AEB),
    (0x1B00, 0x1B03), (0x1B34, 0x1B34), (0x1B36, 0x1B3A), (0x1B3C, 0x1B3C), (0x1B42, 0x1B42), (0x1B6B, 0x1B73),
    (0x1B80, 0x1B81), (0x1BA2, 0x1BA5), (0x1BA8, 0x1BA9), (0x1BAB, 0x1BAD), (0x1BE6, 0x1BE6), (0x1BE8, 0x1BE9),
    (0x1BED, 0x1BED), (0x1BEF, 0x1BF1), (0x1C2C, 0x1C33), (0x1C36, 0x1C37), (0x1CD0, 0x1CD2), (0x1CD4, 0x1CE0),
    (0x1CE2, 0x1CE8), (0x1CED, 0x1CED), (0x1CF4, 0x1CF4), (0x1CF8, 0x1CF9), (0x1DC0, 0x1DFF), (0x20D0, 0x20DC),
    (0x20E1, 0x20E1), (0x20E5, 0x20F0), (0x2CEF, 0x2CF1), (0x2D7F, 0x2D7F), (0x2DE0, 0x2DFF), (0x302A, 0x302D),
    (0x3099, 0x309A), (0xA66F, 0xA66F), (0xA674, 0xA67D), (0xA69E, 0xA69F), (0xA6F0, 0xA6F1), (0xA802, 0xA802),
    (0xA806, 0xA806), (0xA80B, 0xA80B), (0xA825, 0xA826), (0xA82C, 0xA82C), (0xA8C4, 0xA8C5), (0xA8E0, 0xA8F1),
    (0xA8FF, 0xA8FF), (0xA926, 0xA92D), (0xA947, 0xA951), (0xA980, 0xA982), (0xA9B3, 0xA9B3), (0xA9B6, 0xA9B9),
    (0xA9BC, 0xA9BD), (0xA9E5, 0xA9E5), (0xAA29, 0xAA2E), (0xAA31, 0xAA32), (0xAA35, 0xAA36), (0xAA43, 0xAA43),
    (0xAA4C, 0xAA4C), (0xAA7C, 0xAA7C), (0xAAB0, 0xAAB0), (0xAAB2, 0xAAB4), (0xAAB7, 0xAAB8), (0xAABE, 0xAABF),
    (0xAAC1, 0xAAC1), (0xAAEC, 0xAAED), (0xAAF6, 0xAAF6), (0xABE5, 0xABE5), (0xABE8, 0xABE8), (0xABED, 0xABED),
    (0xFB1E, 0xFB1E), (0xFE00, 0xFE0F), (0xFE20, 0xFE2F), (0x101FD, 0x101FD), (0x102E0, 0x102E0), (0x10376, 0x1037A),
    (0x10A01, 0x10A03), (0x10A05, 0x10A06), (0x10A0C, 0x10A0F), (0x10A38, 0x10A3A), (0x10A3F, 0x10A3F),
    (0x10AE5, 0x10AE6), (0x10D24, 0x10D27), (0x10D69, 0x10D6D), (0x10EAB, 0x10EAC), (0x10EFA, 0x10EFF),
    (0x10F46, 0x10F50), (0x10F82, 0x10F85), (0x11001, 0x11001), (0x11038, 0x11046), (0x11070, 0x11070),
    (0x11073, 0x11074), (0x1107F, 0x11081), (0x110B3, 0x110B6), (0x110B9, 0x110BA), (0x110C2, 0x110C2),
    (0x11100, 0x11102), (0x11127, 0x1112B), (0x1112D, 0x11134), (0x11173, 0x11173), (0x11180, 0x11181),
    (0x111B6, 0x111BE), (0x111C9, 0x111CC), (0x111CF, 0x111CF), (0x1122F, 0x11231), (0x11234, 0x11234),
    (0x11236, 0x11237), (0x1123E, 0x1123E), (0x11241, 0x11241), (0x112DF, 0x112DF), (0x112E3, 0x112EA),
    (0x11300, 0x11301), (0x1133B, 0x1133C), (0x11340, 0x11340), (0x11366, 0x1136C), (0x11370, 0x11374),
    (0x113BB, 0x113C0), (0x113CE, 0x113CE), (0x113D0, 0x113D0), (0x113D2, 0x113D2), (0x113E1, 0x113E2),
    (0x11438, 0x1143F), (0x11442, 0x11444), (0x11446, 0x11446), (0x1145E, 0x1145E), (0x114B3, 0x114B8),
    (0x114BA, 0x114BA), (0x114BF, 0x114C0), (0x114C2, 0x114C3), (0x115B2, 0x115B5), (0x115BC, 0x115BD),
    (0x115BF, 0x115C0), (0x115DC, 0x115DD), (0x11633, 0x1163A), (0x1163D, 0x1163D), (0x1163F, 0x11640),
    (0x116AB, 0x116AB), (0x116AD, 0x116AD), (0x116B0, 0x116B5), (0x116B7, 0x116B7), (0x1171D, 0x1171D),
    (0x1171F, 0x1171F), (0x11722, 0x11725), (0x11727, 0x1172B), (0x1182F, 0x11837), (0x11839, 0x1183A),
    (0x1193B, 0x1193C), (0x1193E, 0x1193E), (0x11943, 0x11943), (0x119D4, 0x119D7), (0x119DA, 0x119DB),
    (0x119E0, 0x119E0), (0x11A01, 0x11A0A), (0x11A33, 0x11A38), (0x11A3B, 0x11A3E), (0x11A47, 0x11A47),
    (0x11A51, 0x11A56), (0x11A59, 0x11A5B), (0x11A8A, 0x11A96), (0x11A98, 0x11A99), (0x11B60, 0x11B60),
    (0x11B62, 0x11B64), (0x11B66, 0x11B66), (0x11C30, 0x11C36), (0x11C38, 0x11C3D), (0x11C3F, 0x11C3F),
    (0x11C92, 0x11CA7), (0x11CAA, 0x11CB0), (0x11CB2, 0x11CB3), (0x11CB5, 0x11CB6), (0x11D31, 0x11D36),
    (0x11D3A, 0x11D3A), (0x11D3C, 0x11D3D), (0x11D3F, 0x11D45), (0x11D47, 0x11D47), (0x11D90, 0x11D91),
    (0x11D95, 0x11D95), (0x11D97, 0x11D97), (0x11EF3, 0x11EF4), (0x11F00, 0x11F01), (0x11F36, 0x11F3A),
    (0x11F40, 0x11F40), (0x11F42, 0x11F42), (0x11F5A, 0x11F5A), (0x13440, 0x13440), (0x13447, 0x13455),
    (0x1611E, 0x16129), (0x1612D, 0x1612F), (0x16AF0, 0x16AF4), (0x16B30, 0x16B36), (0x16F4F, 0x16F4F),
    (0x16F8F, 0x16F92), (0x16FE4, 0x16FE4), (0x1BC9D, 0x1BC9E), (0x1CF00, 0x1CF2D), (0x1CF30, 0x1CF46),
    (0x1D167, 0x1D169), (0x1D17B, 0x1D182), (0x1D185, 0x1D18B), (0x1D1AA, 0x1D1AD), (0x1D242, 0x1D244),
    (0x1DA00, 0x1DA36), (0x1DA3B, 0x1DA6C), (0x1DA75, 0x1DA75), (0x1DA84, 0x1DA84), (0x1DA9B, 0x1DA9F),
    (0x1DAA1, 0x1DAAF), (0x1E000, 0x1E006), (0x1E008, 0x1E018), (0x1E01B, 0x1E021), (0x1E023, 0x1E024),
    (0x1E026, 0x1E02A), (0x1E08F, 0x1E08F), (0x1E130, 0x1E136), (0x1E2AE, 0x1E2AE), (0x1E2EC, 0x1E2EF),
    (0x1E4EC, 0x1E4EF), (0x1E5EE, 0x1E5EF), (0x1E6E3, 0x1E6E3), (0x1E6E6, 0x1E6E6), (0x1E6EE, 0x1E6EF),
    (0x1E6F5, 0x1E6F5), (0x1E8D0, 0x1E8D6), (0x1E944, 0x1E94A), (0xE0100, 0xE01EF),
];

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        #[serde(rename = "in")]
        input: String,
        strict: String,
        loose: String,
    }

    fn vectors() -> Vec<Vector> {
        serde_json::from_str(include_str!("../tests/data/normalize_vectors.json"))
            .expect("tests/data/normalize_vectors.json is valid")
    }

    #[test]
    fn golden_vectors_strict_and_loose() {
        let vectors = vectors();
        assert!(vectors.len() >= 14, "the minimum set has 14 rows");
        let mut failures = Vec::new();
        for v in &vectors {
            let strict = normalize_ar(&v.input, Level::Strict);
            let loose = normalize_ar(&v.input, Level::Loose);
            if strict != v.strict {
                failures.push(format!(
                    "strict({:?}) = {strict:?}, want {:?}",
                    v.input, v.strict
                ));
            }
            if loose != v.loose {
                failures.push(format!(
                    "loose({:?}) = {loose:?}, want {:?}",
                    v.input, v.loose
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn golden_vectors_are_fixed_points() {
        for v in vectors() {
            assert_eq!(
                normalize_ar(&v.strict, Level::Strict),
                v.strict,
                "strict is idempotent"
            );
            assert_eq!(
                normalize_ar(&v.loose, Level::Loose),
                v.loose,
                "loose is idempotent"
            );
            assert_eq!(
                normalize_ar(&v.strict, Level::Loose),
                v.loose,
                "loose(strict(x)) == loose(x)"
            );
        }
    }

    #[test]
    fn spec_minimum_rows() {
        let rows = [
            (
                "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
                "بسم الله الرحمن الرحيم",
                "بسم الله الرحمن الرحيم",
            ),
            ("ٱلرَّحۡمَٰنِ", "الرحمن", "الرحمن"),
            ("الصَّلَاةَ", "الصلاة", "الصلاه"),
            ("شَيْءٍ", "شيء", "شي"),
            ("يُؤْمِنُونَ", "يؤمنون", "يومنون"),
            ("شَاطِئِ", "شاطئ", "شاطي"),
            ("ﷲ", "الله", "الله"),
            ("٢٥٥", "255", "255"),
            ("كتاب، كتب؟  ", "كتاب كتب", "كتاب كتب"),
        ];
        for (input, strict, loose) in rows {
            assert_eq!(
                normalize_ar(input, Level::Strict),
                strict,
                "strict {input:?}"
            );
            assert_eq!(normalize_ar(input, Level::Loose), loose, "loose {input:?}");
        }
    }

    #[test]
    fn separators_collapse_and_trim() {
        assert_eq!(normalize_ar("", Level::Loose), "");
        assert_eq!(normalize_ar(" \t\n ", Level::Loose), "");
        assert_eq!(normalize_ar("\u{064E}\u{0651}", Level::Strict), "");
        assert_eq!(normalize_ar("  أ - ب ؛ ج  ", Level::Strict), "ا ب ج");
        // A dropped hamza between separators leaves one space, not two.
        assert_eq!(normalize_ar("و ء ه", Level::Loose), "و ه");
    }

    #[test]
    fn stripped_set_boundaries() {
        for cp in [
            0x0610, 0x061A, 0x064B, 0x065F, 0x0670, 0x06D6, 0x06DD, 0x06E9, 0x06ED, 0x08D3, 0x08FF,
            0x0640,
        ]
        .into_iter()
        .chain([0x200B, 0x200F, 0x202A, 0x202E, 0x2066, 0x2069, 0xFEFF])
        {
            let c = char::from_u32(cp).unwrap();
            assert!(is_stripped(c), "U+{cp:04X} is stripped");
        }
        for cp in [
            0x060F, 0x061B, 0x064A, 0x0660, 0x066F, 0x0671, 0x06D5, 0x06EE, 0x08D2, 0x2010, 0x0627,
        ] {
            let c = char::from_u32(cp).unwrap();
            assert!(!is_stripped(c), "U+{cp:04X} is kept");
        }
    }

    #[test]
    fn normalised_text_never_contains_stripped_chars() {
        for v in vectors() {
            for out in [&v.strict, &v.loose] {
                assert!(!out.chars().any(is_stripped), "{out:?}");
                assert!(
                    !out.starts_with(' ') && !out.ends_with(' ') && !out.contains("  "),
                    "{out:?}"
                );
            }
        }
    }

    #[test]
    fn fold_latin_examples() {
        assert_eq!(fold_latin("Mūsā"), "musa");
        assert_eq!(fold_latin("  Ünïcödé \t TEST  "), "unicode test");
        assert_eq!(fold_latin("ﬁnal Straße"), "final straße");
        assert_eq!(fold_latin("İstanbul"), "istanbul");
        assert_eq!(fold_latin("Ἀθῆναι"), "αθηναι");
        assert_eq!(fold_latin("ÇA VA"), "ca va");
        assert_eq!(fold_latin(""), "");
        // Arabic after normalize_ar: NFKD of a hamza seat drops the combining hamza.
        assert_eq!(
            fold_latin(&normalize_ar("يُؤْمِنُونَ ٱلصَّلَوٰةَ", Level::Loose)),
            "يومنون الصلوه"
        );
    }

    #[test]
    fn fold_latin_keeps_spacing_marks() {
        // U+093E DEVANAGARI VOWEL SIGN AA is Mc (spacing) and stays; U+094D VIRAMA is Mn and is dropped.
        assert_eq!(fold_latin("का"), "का");
        assert_eq!(fold_latin("क्"), "क");
    }

    #[test]
    fn tokens_skip_empty_pieces() {
        assert_eq!(tokens("بسم  الله ").collect::<Vec<_>>(), ["بسم", "الله"]);
        assert_eq!(tokens("").count(), 0);
    }

    #[test]
    fn mn_table_is_sorted_and_disjoint() {
        assert!(MN_RANGES.len() > 300);
        for &(lo, hi) in MN_RANGES {
            assert!(lo <= hi, "U+{lo:04X}..U+{hi:04X}");
        }
        for pair in MN_RANGES.windows(2) {
            assert!(pair[0].1 < pair[1].0, "{pair:?}");
        }
        assert!(is_nonspacing_mark('\u{0301}'));
        assert!(is_nonspacing_mark('\u{064E}'));
        assert!(!is_nonspacing_mark('a'));
        assert!(!is_nonspacing_mark('\u{093E}'));
    }

    #[test]
    fn sql_ar_norm_function() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        register_ar_norm(&conn).unwrap();
        let norm: String = conn
            .query_row("SELECT ar_norm(?1)", ["ٱلرَّحۡمَٰنِ الصَّلَاةَ"], |r| r.get(0))
            .unwrap();
        assert_eq!(norm, "الرحمن الصلاه");
        let null: Option<String> = conn
            .query_row("SELECT ar_norm(NULL)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(null, None);
        let num: String = conn
            .query_row("SELECT ar_norm(255)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(num, "255");
        assert!(
            conn.query_row("SELECT ar_norm(x'00')", [], |r| r.get::<_, String>(0))
                .is_err()
        );
    }
}
