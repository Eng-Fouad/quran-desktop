//! Query tokenising (phrase groups and bare tokens), `build_match` and the id-range filters.
//!
//! A raw query is split into **terms** before it is folded: text between quote marks is one quoted term (an exact
//! word, or a phrase when it folds to several tokens), everything else is a run of bare tokens. Each piece is then
//! folded the way the searched column was built ([`Fold`]) and split into tokens exactly where an FTS5 `unicode61`
//! tokenizer would split it, so the FTS expression, the word-match mapping and the snippet marks all agree on what a
//! token is. Every token reaches FTS5 inside double quotes (embedded quotes doubled), so no user input is ever parsed
//! as FTS5 syntax (`AND`, `NEAR(`, `-`, `^`, `col:` …).

use quran_types::{MushafLayout, QuranIndex, SearchRequest};

use crate::normalize::{Level, fold_latin, normalize_ar};
use crate::{CoreError, Result};

/// Largest `SearchRequest::limit` (1..=2000).
pub const MAX_LIMIT: u32 = 2000;
/// Longest accepted query, in characters (a pasted ayah of 2:282 is about 700).
pub const MAX_QUERY_CHARS: usize = 2000;
/// Most tokens one query may fold to.
pub const MAX_QUERY_TOKENS: usize = 200;

/// Which `ayah_fts` column a query targets: `loose` (smart, substring) or `strict` (exact).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Column {
    Loose,
    Strict,
}

impl Column {
    /// The FTS5 column name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Loose => "loose",
            Self::Strict => "strict",
        }
    }

    /// The [`normalize_ar`] level the column was built with (`norm_loose` / `norm_strict`).
    #[must_use]
    pub const fn level(self) -> Level {
        match self {
            Self::Loose => Level::Loose,
            Self::Strict => Level::Strict,
        }
    }
}

/// A compiled FTS5 query: `fts` = `{loose|strict} : ("t1" "t2 t3" "t4"*)`, plus the normalised tokens it was built
/// from (for word-match mapping) and whether the last bare token is a prefix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchExpr {
    pub fts: String,
    pub tokens: Vec<String>,
    pub prefix_last: bool,
}

/// Compiles a user query for `column`. `None` when nothing is left after normalisation.
///
/// - A bare token becomes `"tok"`; a quoted group becomes `"t1 t2"` (an FTS5 phrase); embedded `"` are doubled.
/// - With `prefix_last` (smart mode), `*` follows the last term when it is a bare token, or a phrase whose closing
///   quote has not been typed yet (search-as-you-type inside a phrase). A closed quoted term is never a prefix.
/// - Terms are joined by spaces (FTS5's implicit AND) inside one column filter.
#[must_use]
pub fn build_match(user_query: &str, column: Column, prefix_last: bool) -> Option<MatchExpr> {
    let parsed = ParsedQuery::parse(user_query, Fold::Arabic(column.level()));
    if parsed.is_empty() {
        return None;
    }
    let prefix = prefix_last && parsed.last_is_prefixable();
    Some(MatchExpr {
        fts: render_fts(Some(column.name()), &parsed.groups(prefix)),
        tokens: parsed.tokens().map(str::to_owned).collect(),
        prefix_last: prefix,
    })
}

/// How the searched text was folded, so the query is folded the same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fold {
    /// `normalize_ar(level)`: core.db `norm_*` columns, `arabic_normalized` pack folds.
    Arabic(Level),
    /// `fold_latin(normalize_ar(x, Loose))`: note `body_search`.
    Notes,
    /// `fold_latin`: `like_fallback` pack folds.
    Latin,
    /// No folding (`fold` = `plain`): `porter_unicode61` and `unicode61_remove_diacritics` packs, whose FTS5 tokenizer
    /// folds case and diacritics itself. Folding the query in Rust would diverge from it (`fold_latin` drops the Mn
    /// viramas and nuktas that `unicode61` treats as separators in Devanagari or Bengali), so only whitespace is
    /// collapsed and token splitting is left to the tokenizer.
    Raw,
}

impl Fold {
    /// Folds `s` like the searched column.
    pub(crate) fn apply(self, s: &str) -> String {
        match self {
            Self::Arabic(level) => normalize_ar(s, level),
            Self::Notes => fold_latin(&normalize_ar(s, Level::Loose)),
            Self::Latin => fold_latin(s),
            Self::Raw => collapse_whitespace(s),
        }
    }

    /// Whether `c` (alone) folds to a separator: whitespace for every fold, plus ASCII and Arabic punctuation for the
    /// [`normalize_ar`] folds.
    pub(crate) fn is_separator(self, c: char) -> bool {
        c.is_whitespace()
            || (matches!(self, Self::Arabic(_) | Self::Notes)
                && (c.is_ascii_punctuation()
                    || matches!(c, '\u{060C}' | '\u{061B}' | '\u{061F}' | '\u{06D4}')))
    }

    /// The tokens of already folded text: split where an FTS5 `unicode61` tokenizer splits (on every character that is
    /// not a letter, a number or private-use), except for [`Fold::Raw`], whose whitespace-separated words are handed to
    /// the pack's tokenizer whole (words without any letter or number are dropped).
    fn split(self, folded: &str) -> Vec<String> {
        match self {
            Self::Raw => folded
                .split_whitespace()
                .filter(|w| w.chars().any(char::is_alphanumeric))
                .map(str::to_owned)
                .collect(),
            _ => split_tokens(folded).map(str::to_owned).collect(),
        }
    }
}

/// Whether FTS5's `unicode61` tokenizer keeps `c` inside a token (categories `L*`, `N*` and `Co`).
#[must_use]
pub(crate) fn is_token_char(c: char) -> bool {
    c.is_alphanumeric()
        || matches!(c, '\u{E000}'..='\u{F8FF}' | '\u{F0000}'..='\u{FFFFD}' | '\u{100000}'..='\u{10FFFD}')
}

/// The tokens of folded text, split on every non-token character (see [`is_token_char`]).
pub(crate) fn split_tokens(folded: &str) -> impl Iterator<Item = &str> {
    folded
        .split(|c: char| !is_token_char(c))
        .filter(|t| !t.is_empty())
}

/// Quote marks that open and close a phrase: ASCII `"`, typographic `“ ” „` and the guillemets `« »` that Arabic
/// keyboards type.
#[must_use]
pub(crate) fn is_quote(c: char) -> bool {
    matches!(
        c,
        '"' | '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{00AB}' | '\u{00BB}'
    )
}

/// Runs of whitespace become one space; leading and trailing whitespace is dropped.
pub(crate) fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for word in s.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// The `LIKE` needle of a substring search: quote marks carry no meaning there, so they become spaces; the rest is
/// folded like the column and whitespace-collapsed.
pub(crate) fn substring_needle(raw: &str, fold: Fold) -> String {
    let unquoted: String = raw
        .chars()
        .map(|c| if is_quote(c) { ' ' } else { c })
        .collect();
    collapse_whitespace(&fold.apply(&unquoted))
}

/// Escapes the `LIKE` wildcards for `ESCAPE '\'`.
pub(crate) fn escape_like(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len());
    for c in needle.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// One query term: a bare token, or a quoted word or phrase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Term {
    /// Folded tokens; exactly one for a bare term, one or more for a quoted term.
    pub(crate) tokens: Vec<String>,
    /// Written between quote marks: matched as written (never a prefix unless still open, never typo-expanded).
    pub(crate) quoted: bool,
    /// A quoted term whose closing quote has not been typed (only ever the last term).
    pub(crate) open: bool,
}

/// A raw query split into terms.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedQuery {
    pub(crate) terms: Vec<Term>,
}

impl ParsedQuery {
    /// Splits `raw` into quoted groups and bare tokens, folds each with `fold` and drops empty tokens.
    pub(crate) fn parse(raw: &str, fold: Fold) -> Self {
        let mut parsed = Self::default();
        let mut quoted = false;
        let mut piece = String::new();
        for c in raw.chars() {
            if is_quote(c) {
                parsed.push(&piece, fold, quoted, false);
                piece.clear();
                quoted = !quoted;
            } else {
                piece.push(c);
            }
        }
        parsed.push(&piece, fold, quoted, quoted);
        parsed
    }

    fn push(&mut self, piece: &str, fold: Fold, quoted: bool, open: bool) {
        let tokens = fold.split(&fold.apply(piece));
        if tokens.is_empty() {
            return;
        }
        if quoted {
            self.terms.push(Term {
                tokens,
                quoted: true,
                open,
            });
        } else {
            self.terms.extend(tokens.into_iter().map(|t| Term {
                tokens: vec![t],
                quoted: false,
                open: false,
            }));
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// Every token, in query order (phrase tokens individually).
    pub(crate) fn tokens(&self) -> impl Iterator<Item = &str> {
        self.terms
            .iter()
            .flat_map(|t| t.tokens.iter().map(String::as_str))
    }

    pub(crate) fn token_count(&self) -> usize {
        self.terms.iter().map(|t| t.tokens.len()).sum()
    }

    /// Whether the last term can carry FTS5's prefix operator: a bare token, or a phrase still being typed.
    pub(crate) fn last_is_prefixable(&self) -> bool {
        self.terms.last().is_some_and(|t| !t.quoted || t.open)
    }

    /// The folded query as reported in `SearchResults::normalized`: bare tokens, and quoted terms in `"…"`.
    pub(crate) fn display(&self) -> String {
        let mut out = String::new();
        for term in &self.terms {
            if !out.is_empty() {
                out.push(' ');
            }
            let text = term.tokens.join(" ");
            if term.quoted {
                out.push('"');
                out.push_str(&text);
                if !term.open {
                    out.push('"');
                }
            } else {
                out.push_str(&text);
            }
        }
        out
    }

    /// One single-alternative group per term; with `prefix_last`, the last term is a prefix.
    pub(crate) fn groups(&self, prefix_last: bool) -> Vec<Group> {
        let last = self.terms.len().saturating_sub(1);
        self.terms
            .iter()
            .enumerate()
            .map(|(i, term)| {
                Group(vec![Alt {
                    text: term.tokens.join(" "),
                    prefix: prefix_last && i == last,
                }])
            })
            .collect()
    }
}

/// One AND-ed element of an FTS5 expression: its alternatives are OR-ed (several only after a typo expansion).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Group(pub(crate) Vec<Alt>);

/// One FTS5 phrase: folded tokens joined by spaces, optionally a prefix (`"…"*`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Alt {
    pub(crate) text: String,
    pub(crate) prefix: bool,
}

/// `"text"` with embedded quotes doubled, then `*` for a prefix.
fn quote(alt: &Alt, out: &mut String) {
    out.push('"');
    for c in alt.text.chars() {
        if c == '"' {
            out.push('"');
        }
        out.push(c);
    }
    out.push('"');
    if alt.prefix {
        out.push('*');
    }
}

/// The FTS5 expression of `groups`, inside `column : (…)` when a column filter is given. Phrases are joined by
/// spaces (FTS5's implicit AND); once a group has alternatives, groups are joined by an explicit `AND`, because the
/// implicit AND only joins phrases, never a parenthesised `(… OR …)` (that is a syntax error in FTS5).
pub(crate) fn render_fts(column: Option<&str>, groups: &[Group]) -> String {
    let separator = if groups.iter().any(|g| g.0.len() > 1) {
        " AND "
    } else {
        " "
    };
    let mut body = String::new();
    for group in groups {
        if !body.is_empty() {
            body.push_str(separator);
        }
        match group.0.as_slice() {
            [one] => quote(one, &mut body),
            alts => {
                body.push('(');
                for (i, alt) in alts.iter().enumerate() {
                    if i > 0 {
                        body.push_str(" OR ");
                    }
                    quote(alt, &mut body);
                }
                body.push(')');
            }
        }
    }
    match column {
        Some(name) => format!("{name} : ({body})"),
        None => body,
    }
}

/// Rejects requests outside the contract before any IO.
pub(crate) fn check_request(req: &SearchRequest) -> Result<()> {
    if !(1..=MAX_LIMIT).contains(&req.limit) {
        return Err(CoreError::InvalidArgument(format!(
            "search limit {} is not within 1..={MAX_LIMIT}",
            req.limit
        )));
    }
    let chars = req.query.chars().count();
    if chars > MAX_QUERY_CHARS {
        return Err(CoreError::InvalidArgument(format!(
            "search query has {chars} characters; at most {MAX_QUERY_CHARS} are accepted"
        )));
    }
    Ok(())
}

/// Rejects a query that folds to more than [`MAX_QUERY_TOKENS`] tokens.
pub(crate) fn check_tokens(parsed: &ParsedQuery) -> Result<()> {
    let n = parsed.token_count();
    if n > MAX_QUERY_TOKENS {
        return Err(CoreError::InvalidArgument(format!(
            "search query has {n} tokens; at most {MAX_QUERY_TOKENS} are accepted"
        )));
    }
    Ok(())
}

/// The ayah-id geometry search needs, taken once from the core index: surah and juz ranges (the SQL range
/// filters), the first word of every ayah and the page starts of every layout (hit page numbers).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Geometry {
    /// `(first, last)` ayah id of each surah; index = surah − 1.
    surahs: Vec<(u32, u32)>,
    /// `(first, last)` ayah id of each juz; index = juz − 1.
    juz: Vec<(u32, u32)>,
    /// First word id of each ayah; index = ayah id − 1.
    ayah_first_word: Vec<u32>,
    /// First word id of each page, per layout; index = page − 1.
    pages: Vec<(MushafLayout, Vec<u32>)>,
}

impl Geometry {
    pub(crate) fn from_index(index: &QuranIndex) -> Result<Self> {
        let mut surahs = Vec::with_capacity(index.surahs.len());
        let mut next = 1u32;
        for s in &index.surahs {
            let last = s
                .first_ayah_id
                .checked_add(s.ayah_count)
                .and_then(|end| end.checked_sub(1))
                .filter(|&last| s.ayah_count > 0 && s.first_ayah_id == next && last >= next)
                .ok_or_else(|| {
                    CoreError::Corrupt(format!(
                        "surah {} does not continue the ayah ids at {next}",
                        s.id
                    ))
                })?;
            surahs.push((s.first_ayah_id, last));
            next = last.saturating_add(1);
        }
        let ayah_count = u32::try_from(index.ayah_first_word.len())
            .map_err(|_| CoreError::Corrupt("the index has too many ayahs".into()))?;
        if next != ayah_count.saturating_add(1) {
            return Err(CoreError::Corrupt(format!(
                "surahs cover ayahs 1..{next} but the index has {ayah_count} ayahs"
            )));
        }
        Ok(Self {
            surahs,
            juz: index
                .juz
                .iter()
                .map(|d| (d.first_ayah_id, d.last_ayah_id))
                .collect(),
            ayah_first_word: index.ayah_first_word.clone(),
            pages: index
                .layouts
                .iter()
                .map(|l| (l.layout, l.page_first_word.clone()))
                .collect(),
        })
    }

    /// Number of ayahs (6,236 in a real core.db).
    pub(crate) fn ayah_count(&self) -> u32 {
        u32::try_from(self.ayah_first_word.len()).unwrap_or(u32::MAX)
    }

    /// The ayah-id range of the filters: everything, a surah, a juz, or their intersection. `None` when a surah and a
    /// juz do not overlap (an empty result, not an error). A surah or juz the index lacks is `InvalidArgument`.
    pub(crate) fn range(&self, surah: Option<u32>, juz: Option<u32>) -> Result<Option<(u32, u32)>> {
        let mut range = (1, self.ayah_count());
        if let Some(s) = surah {
            let (first, last) = self.surah_range(s).ok_or_else(|| {
                CoreError::InvalidArgument(format!(
                    "surah filter {s} is not within 1..={}",
                    self.surahs.len()
                ))
            })?;
            range = (range.0.max(first), range.1.min(last));
        }
        if let Some(j) = juz {
            let (first, last) = usize::try_from(j)
                .ok()
                .and_then(|j| j.checked_sub(1))
                .and_then(|i| self.juz.get(i).copied())
                .ok_or_else(|| {
                    CoreError::InvalidArgument(format!(
                        "juz filter {j} is not within 1..={}",
                        self.juz.len()
                    ))
                })?;
            range = (range.0.max(first), range.1.min(last));
        }
        Ok((range.0 <= range.1).then_some(range))
    }

    /// `(first, last)` ayah id of `surah`.
    pub(crate) fn surah_range(&self, surah: u32) -> Option<(u32, u32)> {
        let i = usize::try_from(surah).ok()?.checked_sub(1)?;
        self.surahs.get(i).copied()
    }

    /// `(surah, ayah)` of an ayah id.
    pub(crate) fn ayah_ref(&self, ayah_id: u32) -> Option<(u32, u32)> {
        let i = self.surahs.partition_point(|&(first, _)| first <= ayah_id);
        let (first, last) = *self.surahs.get(i.checked_sub(1)?)?;
        (ayah_id <= last).then(|| (u32::try_from(i).unwrap_or(u32::MAX), ayah_id - first + 1))
    }

    /// The first word id of an ayah.
    pub(crate) fn first_word(&self, ayah_id: u32) -> Option<u32> {
        let i = usize::try_from(ayah_id).ok()?.checked_sub(1)?;
        self.ayah_first_word.get(i).copied()
    }

    /// The page of `layout` holding the ayah's first word.
    pub(crate) fn page(&self, layout: MushafLayout, ayah_id: u32) -> Option<u32> {
        let word = self.first_word(ayah_id)?;
        let (_, starts) = self.pages.iter().find(|(l, _)| *l == layout)?;
        let page = starts.partition_point(|&first| first <= word);
        u32::try_from(page).ok().filter(|&p| p > 0)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::{Division, LayoutInfo, RevelationPlace, SearchMode, SearchScope, SurahInfo};

    use super::*;

    fn loose(q: &str) -> Option<MatchExpr> {
        build_match(q, Column::Loose, true)
    }

    #[test]
    fn bare_tokens_are_quoted_and_the_last_is_a_prefix() {
        let m = loose("الرحمن الرحيم").unwrap();
        assert_eq!(m.fts, r#"loose : ("الرحمن" "الرحيم"*)"#);
        assert_eq!(m.tokens, ["الرحمن", "الرحيم"]);
        assert!(m.prefix_last);
        let exact = build_match("الرحمن الرحيم", Column::Strict, false).unwrap();
        assert_eq!(exact.fts, r#"strict : ("الرحمن" "الرحيم")"#);
        assert!(!exact.prefix_last);
    }

    #[test]
    fn queries_are_normalised_with_the_column_level() {
        // Harakat, alef forms and the loose-only folds (ة→ه, hamza seats).
        let m = loose("الصَّلَاةَ يُؤْمِنُونَ").unwrap();
        assert_eq!(m.tokens, ["الصلاه", "يومنون"]);
        let s = build_match("الصَّلَاةَ يُؤْمِنُونَ", Column::Strict, false).unwrap();
        assert_eq!(s.tokens, ["الصلاة", "يؤمنون"]);
        // Punctuation and tatweel never reach FTS5.
        assert_eq!(loose("كتاب، كتب؟").unwrap().tokens, ["كتاب", "كتب"]);
        assert_eq!(loose("كتـــاب").unwrap().tokens, ["كتاب"]);
    }

    #[test]
    fn phrases_stay_together_and_close_without_a_prefix() {
        let m = loose(r#""يا ايها" الذين"#).unwrap();
        assert_eq!(m.fts, r#"loose : ("يا ايها" "الذين"*)"#);
        assert_eq!(m.tokens, ["يا", "ايها", "الذين"]);
        let closed = loose(r#"الذين "يا ايها""#).unwrap();
        assert_eq!(closed.fts, r#"loose : ("الذين" "يا ايها")"#);
        assert!(!closed.prefix_last, "a closed phrase is matched as written");
        // A single quoted word is an exact word, not a prefix.
        assert_eq!(loose(r#""الرح""#).unwrap().fts, r#"loose : ("الرح")"#);
    }

    #[test]
    fn an_unterminated_phrase_is_still_being_typed() {
        let m = loose(r#"الله "يا اي"#).unwrap();
        assert_eq!(m.fts, r#"loose : ("الله" "يا اي"*)"#);
        assert!(m.prefix_last);
        let exact = build_match(r#""يا اي"#, Column::Strict, false).unwrap();
        assert_eq!(exact.fts, r#"strict : ("يا اي")"#);
    }

    #[test]
    fn guillemets_and_typographic_quotes_delimit_phrases() {
        assert_eq!(
            loose("«يا ايها» الناس").unwrap().fts,
            r#"loose : ("يا ايها" "الناس"*)"#
        );
        assert_eq!(
            loose("\u{201C}يا ايها\u{201D}").unwrap().fts,
            r#"loose : ("يا ايها")"#
        );
    }

    #[test]
    fn fts_syntax_in_the_input_is_inert() {
        for q in [
            "AND",
            "OR",
            "NOT",
            "NEAR(",
            "loose:",
            "-الله",
            "^الله",
            "الله*",
            "(الله)",
            "{loose}",
            "الله + رب",
            "a\"b",
        ] {
            let m = loose(q).unwrap_or_else(|| panic!("{q} keeps a token"));
            assert!(m.fts.starts_with("loose : (\""), "{q}: {}", m.fts);
            for t in &m.tokens {
                assert!(t.chars().all(is_token_char), "{q}: token {t:?}");
            }
        }
        // Embedded quotes are doubled (a raw fold keeps punctuation inside a word).
        let mut fts = String::new();
        quote(
            &Alt {
                text: "say\"hi".into(),
                prefix: true,
            },
            &mut fts,
        );
        assert_eq!(fts, r#""say""hi"*"#);
    }

    #[test]
    fn empty_queries_compile_to_nothing() {
        for q in [
            "",
            "   ",
            "\"\"",
            "؟،",
            "ـــ",
            "\u{064E}\u{0650}",
            "*",
            "«»",
        ] {
            assert_eq!(loose(q), None, "{q:?}");
        }
    }

    #[test]
    fn symbols_split_tokens_like_unicode61() {
        assert_eq!(loose("الله♥رب").unwrap().tokens, ["الله", "رب"]);
        assert_eq!(loose("٢٥٥").unwrap().tokens, ["255"]);
    }

    #[test]
    fn raw_folds_keep_words_whole_and_drop_bare_punctuation() {
        let p = ParsedQuery::parse("Mercy,  - and \"the light\" हिन्दी", Fold::Raw);
        assert_eq!(p.display(), "Mercy, and \"the light\" हिन्दी");
        assert_eq!(
            render_fts(None, &p.groups(true)),
            r#""Mercy," "and" "the light" "हिन्दी"*"#
        );
    }

    #[test]
    fn notes_fold_arabic_then_latin() {
        let p = ParsedQuery::parse("Café الصَّلَاةَ", Fold::Notes);
        assert_eq!(p.display(), "cafe الصلاه");
    }

    #[test]
    fn typo_groups_render_as_alternatives() {
        let groups = vec![
            Group(vec![
                Alt {
                    text: "الرحمن".into(),
                    prefix: false,
                },
                Alt {
                    text: "الرحمه".into(),
                    prefix: false,
                },
            ]),
            Group(vec![Alt {
                text: "الرح".into(),
                prefix: true,
            }]),
        ];
        assert_eq!(
            render_fts(Some("loose"), &groups),
            r#"loose : (("الرحمن" OR "الرحمه") AND "الرح"*)"#
        );
    }

    /// Every expression shape this module renders is valid FTS5 syntax: run them all on an in-memory FTS5 table
    /// shaped like `ayah_fts` (and without a column filter, like a pack's `entry_fts`).
    #[test]
    fn rendered_expressions_are_valid_fts5() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(loose, strict, tokenize='unicode61');
             INSERT INTO t(rowid, loose, strict) VALUES (1, 'بسم الله الرحمن الرحيم', 'بسم الله الرحمن الرحيم');
             INSERT INTO t(rowid, loose, strict) VALUES (2, 'يا ايها الناس', 'يا ايها الناس');",
        )
        .unwrap();
        let count = |fts: &str| -> i64 {
            conn.query_row("SELECT count(*) FROM t WHERE t MATCH ?1", [fts], |r| {
                r.get(0)
            })
            .unwrap_or_else(|e| panic!("{fts}: {e}"))
        };
        let alt = |text: &str, prefix: bool| Alt {
            text: text.into(),
            prefix,
        };
        let shapes = [
            vec![Group(vec![alt("الله", false)])],
            vec![
                Group(vec![alt("الله", false)]),
                Group(vec![alt("الرح", true)]),
            ],
            vec![
                Group(vec![alt("يا ايها", false)]),
                Group(vec![alt("النا", true)]),
            ],
            vec![Group(vec![alt("يا اي", true)])],
            vec![Group(vec![alt("الرحمن", false), alt("الرحيم", false)])],
            vec![
                Group(vec![alt("بسم", false)]),
                Group(vec![alt("الرحمن", false), alt("الرحيم", false)]),
                Group(vec![alt("الل", true)]),
            ],
            vec![
                Group(vec![alt("يا ايها", false), alt("كلا", false)]),
                Group(vec![alt("الناس", false), alt("زز", false)]),
            ],
            vec![Group(vec![alt("say\"hi", true)])],
        ];
        let expected = [1, 1, 1, 1, 1, 1, 1, 0];
        for (groups, want) in shapes.iter().zip(expected) {
            for column in [Some("loose"), Some("strict"), None] {
                let fts = render_fts(column, groups);
                assert_eq!(count(&fts), want, "{fts}");
            }
        }
        // Whatever a user types compiles to a valid expression.
        for q in [
            "AND",
            "OR الله",
            "NOT",
            "NEAR(الله رب)",
            "loose:الله",
            "-الله",
            "^الله",
            "الله*",
            "(الله",
            "\"الله",
            "الله\"\"رب",
            "«يا ايها» الناس",
            "a\"b\"c\"",
            "{loose strict} : x",
        ] {
            for column in [Column::Loose, Column::Strict] {
                for prefix in [true, false] {
                    if let Some(m) = build_match(q, column, prefix) {
                        count(&m.fts);
                    }
                }
            }
        }
    }

    #[test]
    fn substring_needles_drop_quotes_and_fold() {
        assert_eq!(
            substring_needle("  «الرَّحْمَٰنِ   الرحيم»", Fold::Arabic(Level::Loose)),
            "الرحمن الرحيم"
        );
        assert_eq!(substring_needle("\"The  Light\"", Fold::Raw), "The Light");
        assert_eq!(escape_like("100%_a\\b"), "100\\%\\_a\\\\b");
    }

    fn request(query: &str, limit: u32) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            scope: SearchScope::Quran,
            mode: SearchMode::Smart,
            surah: None,
            juz: None,
            limit,
            layout: MushafLayout::V2,
        }
    }

    #[test]
    fn requests_are_checked() {
        assert!(check_request(&request("x", 1)).is_ok());
        assert!(check_request(&request("x", MAX_LIMIT)).is_ok());
        for bad in [
            request("x", 0),
            request("x", MAX_LIMIT + 1),
            request(&"ب".repeat(MAX_QUERY_CHARS + 1), 10),
        ] {
            assert!(matches!(
                check_request(&bad),
                Err(CoreError::InvalidArgument(_))
            ));
        }
        let many = ParsedQuery::parse(
            &"كلمة ".repeat(MAX_QUERY_TOKENS + 1),
            Fold::Arabic(Level::Loose),
        );
        assert!(check_tokens(&many).is_err());
        let ok = ParsedQuery::parse(
            &"كلمة ".repeat(MAX_QUERY_TOKENS),
            Fold::Arabic(Level::Loose),
        );
        assert!(check_tokens(&ok).is_ok());
    }

    /// 3 surahs (1..=7, 8..=12, 13..=20), 2 juz (1..=10, 11..=20), 2 words per ayah, pages of 10 words.
    fn index() -> QuranIndex {
        let surah = |id: u32, first: u32, count: u32| SurahInfo {
            id,
            name_ar: String::new(),
            name_simple: String::new(),
            name_complex: String::new(),
            name_en: String::new(),
            revelation_place: RevelationPlace::Makkah,
            revelation_order: id,
            ayah_count: count,
            first_ayah_id: first,
            bismillah_pre: true,
            header_cp: None,
        };
        let div = |id, first_ayah_id, last_ayah_id| Division {
            id,
            first_ayah_id,
            last_ayah_id,
        };
        QuranIndex {
            surahs: vec![surah(1, 1, 7), surah(2, 8, 5), surah(3, 13, 8)],
            juz: vec![div(1, 1, 10), div(2, 11, 20)],
            hizb: Vec::new(),
            rub: Vec::new(),
            manzil: Vec::new(),
            sajdas: Vec::new(),
            layouts: vec![LayoutInfo {
                layout: MushafLayout::V2,
                pages: 4,
                lines_per_page: 15,
                page_first_ayah: vec![1, 6, 11, 16],
                page_first_word: vec![1, 11, 21, 31],
            }],
            ayah_first_word: (0..20).map(|i| 1 + 2 * i).collect(),
        }
    }

    #[test]
    fn filters_become_one_ayah_range() {
        let g = Geometry::from_index(&index()).unwrap();
        assert_eq!(g.ayah_count(), 20);
        assert_eq!(g.range(None, None).unwrap(), Some((1, 20)));
        assert_eq!(g.range(Some(2), None).unwrap(), Some((8, 12)));
        assert_eq!(g.range(None, Some(2)).unwrap(), Some((11, 20)));
        assert_eq!(g.range(Some(2), Some(2)).unwrap(), Some((11, 12)));
        assert_eq!(g.range(Some(1), Some(2)).unwrap(), None, "no overlap");
        for (s, j) in [
            (Some(0), None),
            (Some(4), None),
            (None, Some(0)),
            (None, Some(3)),
        ] {
            assert!(matches!(g.range(s, j), Err(CoreError::InvalidArgument(_))));
        }
    }

    #[test]
    fn geometry_maps_ayahs_to_references_words_and_pages() {
        let g = Geometry::from_index(&index()).unwrap();
        assert_eq!(g.ayah_ref(1), Some((1, 1)));
        assert_eq!(g.ayah_ref(7), Some((1, 7)));
        assert_eq!(g.ayah_ref(8), Some((2, 1)));
        assert_eq!(g.ayah_ref(20), Some((3, 8)));
        assert_eq!(g.ayah_ref(0), None);
        assert_eq!(g.ayah_ref(21), None);
        assert_eq!(g.first_word(6), Some(11));
        assert_eq!(g.page(MushafLayout::V2, 1), Some(1));
        assert_eq!(g.page(MushafLayout::V2, 5), Some(1));
        assert_eq!(g.page(MushafLayout::V2, 6), Some(2));
        assert_eq!(g.page(MushafLayout::V2, 20), Some(4));
        assert_eq!(g.page(MushafLayout::V1, 1), None, "layout not in the index");
        assert_eq!(g.surah_range(3), Some((13, 20)));
        assert_eq!(g.surah_range(0), None);
    }

    #[test]
    fn a_gap_in_the_surah_table_is_corrupt() {
        let mut idx = index();
        idx.surahs[1].first_ayah_id = 9;
        assert!(matches!(
            Geometry::from_index(&idx),
            Err(CoreError::Corrupt(_))
        ));
        let mut short = index();
        short.ayah_first_word.pop();
        assert!(Geometry::from_index(&short).is_err());
    }
}
