//! Versioned translation/tafsir pack databases.
//!
//! One file per pack version, `packs/{kind}/{id}/{version}/pack.db`, built by [`PackDbWriter`] from a QuranEnc export
//! in a staging directory (atomic install) and read through [`PackDb`] (read-only pool). The `fold` column and
//! its FTS5 table follow the pack's [`PackTokenizer`]; search snippets for packs whose `fold` differs from
//! `plain` are built in Rust from `plain`, which [`PackDb::plain_texts`] serves; copied translations
//! read the same column through [`PackDb::plain_range`].

mod pool;
mod reader;
mod writer;

use std::path::PathBuf;
use std::sync::Arc;

use quran_types::{PackKind, TextDir};
use serde::{Deserialize, Serialize};

pub use writer::PackDbWriter;

use crate::normalize::{Level, fold_latin, normalize_ar};

/// `meta.format` of this schema.
pub const PACK_FORMAT: u32 = 1;

/// Read-only handle on one pack DB (`READ_ONLY | URI`, not immutable; pool of 2). `Clone + Send + Sync`. Dropping the
/// last clone closes the file before it returns, so the pack can be deleted or replaced right after (Windows).
#[derive(Clone)]
pub struct PackDb {
    pool: r2d2::Pool<pool::Manager>,
    meta: Arc<PackMeta>,
    path: PathBuf,
    /// After `pool`, so dropped after it: the last clone waits here for the file to close (the `pool` module).
    _closer: Arc<pool::Closer>,
}

/// The `meta` table of a pack DB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackMeta {
    pub pack_id: String,
    /// `Translation` or `Tafsir`.
    pub kind: PackKind,
    /// BCP-47 of the content.
    pub lang: String,
    pub dir: TextDir,
    pub name: String,
    pub author: String,
    pub source: String,
    pub source_version: String,
    pub licence: String,
    pub attribution: String,
    pub tokenizer: PackTokenizer,
    /// `normalize_ar` version the `fold` column was built with (startup rebuild check).
    pub normalizer_version: u32,
    /// Always 1 for this schema.
    pub format: u32,
}

/// How a pack's `fold` column is built and indexed. The serde/text form is the catalog's `tokenizer`
/// value and the `meta.tokenizer` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PackTokenizer {
    /// `porter unicode61 remove_diacritics 2`, fold = `plain` (en).
    #[serde(rename = "porter_unicode61")]
    PorterUnicode61,
    /// `unicode61 remove_diacritics 2`, fold = `plain` (fr, es, de, id, tr, ru, bn, hi, …).
    #[serde(rename = "unicode61_remove_diacritics")]
    Unicode61RemoveDiacritics,
    /// `unicode61`, fold = `normalize_ar(plain, Loose)` (ar, ur, fa, ps, ku).
    #[serde(rename = "arabic_normalized")]
    ArabicNormalized,
    /// No FTS table; fold = `fold_latin(plain)`, searched with `LIKE` (zh, ja, ko, th, km).
    #[serde(rename = "like_fallback")]
    LikeFallback,
}

impl PackTokenizer {
    /// Every tokenizer.
    pub const ALL: [Self; 4] = [
        Self::PorterUnicode61,
        Self::Unicode61RemoveDiacritics,
        Self::ArabicNormalized,
        Self::LikeFallback,
    ];

    /// The catalog / `meta.tokenizer` text.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PorterUnicode61 => "porter_unicode61",
            Self::Unicode61RemoveDiacritics => "unicode61_remove_diacritics",
            Self::ArabicNormalized => "arabic_normalized",
            Self::LikeFallback => "like_fallback",
        }
    }

    /// Inverse of [`Self::as_str`].
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == s)
    }

    /// The FTS5 `tokenize` argument (`<T>` in `schema/pack.sql`), or `None` when the pack has no FTS table.
    #[must_use]
    pub const fn fts_tokenize(self) -> Option<&'static str> {
        match self {
            Self::PorterUnicode61 => Some("porter unicode61 remove_diacritics 2"),
            Self::Unicode61RemoveDiacritics => Some("unicode61 remove_diacritics 2"),
            Self::ArabicNormalized => Some("unicode61"),
            Self::LikeFallback => None,
        }
    }

    /// The `fold` column content for `plain` text.
    #[must_use]
    pub fn fold(self, plain: &str) -> String {
        match self {
            Self::PorterUnicode61 | Self::Unicode61RemoveDiacritics => plain.to_owned(),
            Self::ArabicNormalized => normalize_ar(plain, Level::Loose),
            Self::LikeFallback => fold_latin(plain),
        }
    }

    /// `crate::PACK_SQL` for this tokenizer: `<T>` substituted, or the `entry_fts` statement left out for
    /// `like_fallback`.
    #[must_use]
    pub fn pack_sql(self) -> String {
        match self.fts_tokenize() {
            Some(t) => crate::PACK_SQL.replace("<T>", t),
            None => crate::PACK_SQL
                .lines()
                .filter(|l| !l.trim_start().starts_with("CREATE VIRTUAL TABLE entry_fts"))
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

/// One `entry` row as read: an ayah (translations) or an ayah range (tafsir) with sanitised HTML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntry {
    pub ayah_id: u32,
    pub to_ayah_id: u32,
    pub html: String,
}

/// One entry to write. `fold` is derived by the writer from `plain` and the pack's tokenizer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntryInput {
    /// First ayah of the range (the explicit rowid).
    pub ayah_id: u32,
    /// `= ayah_id` for translations.
    pub to_ayah_id: u32,
    /// Sanitised (ammonia policy).
    pub html: String,
    /// Tags stripped, footnote markers removed.
    pub plain: String,
}

/// One footnote to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FootnoteInput {
    /// `"{s}:{a}:{n}"` (QuranEnc) or the upstream id.
    pub id: String,
    pub ayah_id: u32,
    pub marker: String,
    pub html: String,
}

/// What [`PackDbWriter::finish`] produced.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PackStats {
    pub entries: u32,
    pub footnotes: u32,
    /// Size of the finished file.
    pub bytes: u64,
}

/// `meta.kind` text (`translation` / `tafsir`); `None` for kinds that never have a pack DB.
const fn kind_text(kind: PackKind) -> Option<&'static str> {
    match kind {
        PackKind::Translation => Some("translation"),
        PackKind::Tafsir => Some("tafsir"),
        PackKind::MushafFonts | PackKind::Decor | PackKind::Recitation | PackKind::Wbw => None,
    }
}

fn parse_kind(s: &str) -> Option<PackKind> {
    match s {
        "translation" => Some(PackKind::Translation),
        "tafsir" => Some(PackKind::Tafsir),
        _ => None,
    }
}

/// `meta.dir` text.
const fn dir_text(dir: TextDir) -> &'static str {
    match dir {
        TextDir::Ltr => "ltr",
        TextDir::Rtl => "rtl",
    }
}

fn parse_dir(s: &str) -> Option<TextDir> {
    match s {
        "ltr" => Some(TextDir::Ltr),
        "rtl" => Some(TextDir::Rtl),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_text_matches_serde() {
        for t in PackTokenizer::ALL {
            let json = serde_json::to_string(&t).unwrap_or_default();
            assert_eq!(json, format!("\"{}\"", t.as_str()));
            assert_eq!(PackTokenizer::parse(t.as_str()), Some(t));
        }
        assert_eq!(PackTokenizer::parse("porter"), None);
    }

    #[test]
    fn folds_follow_the_table() {
        assert_eq!(PackTokenizer::PorterUnicode61.fold("Mercy"), "Mercy");
        assert_eq!(PackTokenizer::ArabicNormalized.fold("الصَّلَاةَ"), "الصلاه");
        assert_eq!(
            PackTokenizer::LikeFallback.fold("Ünïcode  Text"),
            "unicode text"
        );
    }

    #[test]
    fn meta_texts_round_trip() {
        for kind in [PackKind::Translation, PackKind::Tafsir] {
            assert_eq!(parse_kind(kind_text(kind).unwrap_or_default()), Some(kind));
        }
        for kind in [
            PackKind::MushafFonts,
            PackKind::Decor,
            PackKind::Recitation,
            PackKind::Wbw,
        ] {
            assert_eq!(kind_text(kind), None);
        }
        assert_eq!(parse_kind("wbw"), None);
        for dir in [TextDir::Ltr, TextDir::Rtl] {
            assert_eq!(parse_dir(dir_text(dir)), Some(dir));
        }
        assert_eq!(parse_dir("RTL"), None);
    }

    #[test]
    fn pack_sql_substitutes_or_drops_fts() {
        assert!(!PackTokenizer::LikeFallback.pack_sql().contains("entry_fts"));
        let sql = PackTokenizer::ArabicNormalized.pack_sql();
        assert!(sql.contains("tokenize='unicode61'") && !sql.contains("<T>"));
    }
}
