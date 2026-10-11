//! Smart-mode typo fallback over `vocab_loose` with `levenshtein_bounded` (§2.2.5 step 5). Owner: WP1b.
//!
//! When a smart query finds nothing and every token has at least 3 characters, each bare token that is not a word
//! of the Quran (nor, for the last token, the start of one) is replaced by the vocabulary terms within 1 edit (2 for
//! tokens of 6+ characters): the nearest first, then the most frequent, at most 8, OR-ed together. Tokens that are
//! already words stay as typed, so a correct word is never "corrected" and the suggestions name only real fixes.
//! The vocabulary (≈14,650 terms) is read once per engine and scanned in memory with an early-exit edit distance.

use rusqlite::Connection;

use super::query::{Alt, Group, ParsedQuery};
use crate::Result;

/// Most vocabulary terms one token expands to (§2.2.5 step 5).
pub(crate) const MAX_EXPANSIONS: usize = 8;
/// Typo fallback only runs when every token has at least this many characters.
pub(crate) const MIN_TOKEN_CHARS: usize = 3;
/// Tokens of this many characters or more allow 2 edits, shorter ones 1.
const TWO_EDITS_FROM: usize = 6;

/// Char-level Levenshtein distance with early exit: `Some(d)` when `d <= max`, else `None`.
#[must_use]
pub fn levenshtein_bounded(a: &str, b: &str, max: u32) -> Option<u32> {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let max = usize::try_from(max).unwrap_or(usize::MAX);
    distance(&a, &b, max).and_then(|d| u32::try_from(d).ok())
}

/// The edit distance of two char slices when it is at most `max`. One DP row; the scan stops as soon as a whole row
/// exceeds `max` (no later cell can come back under it), and length differences above `max` never start.
fn distance(a: &[char], b: &[char], max: usize) -> Option<usize> {
    if a.len().abs_diff(b.len()) > max {
        return None;
    }
    // Keep the shorter word in the row.
    let (a, b) = if a.len() < b.len() { (b, a) } else { (a, b) };
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        // `row` holds row i (cell 0 = i); rewrite it in place into row i + 1.
        let mut diag = i;
        let mut left = i + 1;
        let mut row_min = left;
        for (cell, cb) in row.iter_mut().skip(1).zip(b) {
            let up = *cell;
            let value = (diag + usize::from(ca != cb)).min(up + 1).min(left + 1);
            diag = up;
            *cell = value;
            left = value;
            row_min = row_min.min(value);
        }
        if let Some(first) = row.first_mut() {
            *first = i + 1;
        }
        if row_min > max {
            return None;
        }
    }
    row.last().copied().filter(|&d| d <= max)
}

/// The most edits a token of `chars` characters is corrected by.
pub(crate) const fn max_edits(chars: usize) -> usize {
    if chars >= TWO_EDITS_FROM { 2 } else { 1 }
}

/// Whether a smart query may fall back to typo expansion: at least one bare token, and every token (phrase tokens
/// included) has [`MIN_TOKEN_CHARS`] or more characters.
pub(crate) fn eligible(parsed: &ParsedQuery) -> bool {
    parsed.terms.iter().any(|t| !t.quoted)
        && parsed
            .tokens()
            .all(|t| t.chars().count() >= MIN_TOKEN_CHARS)
}

/// One vocabulary term in memory.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VocabTerm {
    term: String,
    chars: Box<[char]>,
    doc_count: u32,
}

/// `vocab_loose` (§3.1.1), sorted by term (code point order, like SQLite's `BINARY` collation).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Vocab {
    terms: Vec<VocabTerm>,
}

/// A correction candidate for one token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) term: String,
    pub(crate) distance: usize,
    pub(crate) doc_count: u32,
}

impl Vocab {
    /// Reads the whole vocabulary (≈14,650 rows, a few milliseconds).
    pub(crate) fn load(conn: &Connection) -> Result<Self> {
        let mut stmt = conn.prepare("SELECT term, doc_count FROM vocab_loose ORDER BY term")?;
        let terms = stmt
            .query_map([], |r| {
                let term: String = r.get(0)?;
                let doc_count: i64 = r.get(1)?;
                Ok(VocabTerm {
                    chars: term.chars().collect(),
                    term,
                    doc_count: u32::try_from(doc_count.max(0)).unwrap_or(u32::MAX),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Self::from_terms(terms))
    }

    fn from_terms(mut terms: Vec<VocabTerm>) -> Self {
        terms.sort_by(|a, b| a.term.cmp(&b.term));
        terms.dedup_by(|a, b| a.term == b.term);
        Self { terms }
    }

    #[cfg(test)]
    pub(crate) fn from_pairs(pairs: &[(&str, u32)]) -> Self {
        Self::from_terms(
            pairs
                .iter()
                .map(|&(term, doc_count)| VocabTerm {
                    term: term.to_owned(),
                    chars: term.chars().collect(),
                    doc_count,
                })
                .collect(),
        )
    }

    pub(crate) fn len(&self) -> usize {
        self.terms.len()
    }

    /// Whether `token` is a term.
    pub(crate) fn contains(&self, token: &str) -> bool {
        self.terms
            .binary_search_by(|t| t.term.as_str().cmp(token))
            .is_ok()
    }

    /// Whether some term starts with `prefix`.
    pub(crate) fn has_prefix(&self, prefix: &str) -> bool {
        let i = self.terms.partition_point(|t| t.term.as_str() < prefix);
        self.terms
            .get(i)
            .is_some_and(|t| t.term.starts_with(prefix))
    }

    /// The nearest terms within [`max_edits`] of `token` (only the smallest distance found: a one-letter slip is not
    /// widened by two-letter neighbours), the most frequent first, then by term; at most [`MAX_EXPANSIONS`].
    pub(crate) fn candidates(&self, token: &str) -> Vec<Candidate> {
        let chars: Vec<char> = token.chars().collect();
        let max = max_edits(chars.len());
        let mut found: Vec<Candidate> = self
            .terms
            .iter()
            .filter_map(|t| {
                distance(&chars, &t.chars, max).map(|d| Candidate {
                    term: t.term.clone(),
                    distance: d,
                    doc_count: t.doc_count,
                })
            })
            .collect();
        found.sort_by(|a, b| {
            a.distance
                .cmp(&b.distance)
                .then(b.doc_count.cmp(&a.doc_count))
                .then_with(|| a.term.cmp(&b.term))
        });
        if let Some(nearest) = found.first().map(|c| c.distance) {
            found.retain(|c| c.distance == nearest);
        }
        found.truncate(MAX_EXPANSIONS);
        found
    }
}

/// A typo-tolerant rewrite of a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Expansion {
    /// The groups to search: unknown bare tokens become their candidates OR-ed, everything else as before.
    pub(crate) groups: Vec<Group>,
    /// The vocabulary terms that replace unknown tokens, in query order, nearest first (`SearchResults::suggestions`).
    pub(crate) corrections: Vec<String>,
}

/// Rewrites `parsed` for the typo fallback, or `None` when no bare token is both unknown and correctable (rerunning
/// would only repeat the failed query). `prefix_last` keeps the last term's prefix semantics when it is known.
pub(crate) fn expand(parsed: &ParsedQuery, prefix_last: bool, vocab: &Vocab) -> Option<Expansion> {
    let last = parsed.terms.len().saturating_sub(1);
    let mut groups = Vec::with_capacity(parsed.terms.len());
    let mut corrections: Vec<String> = Vec::new();
    for (i, term) in parsed.terms.iter().enumerate() {
        let prefix = prefix_last && i == last;
        let text = term.tokens.join(" ");
        let as_typed = Group(vec![Alt {
            text: text.clone(),
            prefix,
        }]);
        let known = if prefix {
            vocab.has_prefix(&text)
        } else {
            vocab.contains(&text)
        };
        if term.quoted || known {
            groups.push(as_typed);
            continue;
        }
        let candidates = vocab.candidates(&text);
        if candidates.is_empty() {
            groups.push(as_typed);
            continue;
        }
        for c in &candidates {
            if !corrections.contains(&c.term) {
                corrections.push(c.term.clone());
            }
        }
        groups.push(Group(
            candidates
                .into_iter()
                .map(|c| Alt {
                    text: c.term,
                    prefix: false,
                })
                .collect(),
        ));
    }
    (!corrections.is_empty()).then_some(Expansion {
        groups,
        corrections,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use crate::normalize::Level;
    use crate::search::query::{Fold, render_fts};

    #[test]
    fn levenshtein_counts_char_edits() {
        assert_eq!(levenshtein_bounded("", "", 0), Some(0));
        assert_eq!(levenshtein_bounded("abc", "abc", 0), Some(0));
        assert_eq!(levenshtein_bounded("abc", "abd", 1), Some(1));
        assert_eq!(levenshtein_bounded("abc", "ab", 1), Some(1));
        assert_eq!(levenshtein_bounded("ab", "abc", 1), Some(1));
        assert_eq!(levenshtein_bounded("kitten", "sitting", 3), Some(3));
        assert_eq!(levenshtein_bounded("kitten", "sitting", 2), None);
        assert_eq!(levenshtein_bounded("flaw", "lawn", 2), Some(2));
        assert_eq!(levenshtein_bounded("", "abc", 3), Some(3));
        assert_eq!(levenshtein_bounded("", "abc", 2), None);
        assert_eq!(levenshtein_bounded("abc", "", 5), Some(3));
        // Characters, not bytes: one Arabic letter is one edit (two UTF-8 bytes).
        assert_eq!(levenshtein_bounded("الرحمان", "الرحمن", 1), Some(1));
        assert_eq!(levenshtein_bounded("الرحمن", "الرحيم", 2), Some(2));
        assert_eq!(levenshtein_bounded("الرحمن", "الرحيم", 1), None);
    }

    #[test]
    fn levenshtein_matches_a_reference_implementation() {
        fn reference(a: &str, b: &str) -> usize {
            let a: Vec<char> = a.chars().collect();
            let b: Vec<char> = b.chars().collect();
            let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
            for (i, row) in d.iter_mut().enumerate() {
                row[0] = i;
            }
            for (j, cell) in d[0].iter_mut().enumerate() {
                *cell = j;
            }
            for i in 1..=a.len() {
                for j in 1..=b.len() {
                    let cost = usize::from(a[i - 1] != b[j - 1]);
                    d[i][j] = (d[i - 1][j - 1] + cost)
                        .min(d[i - 1][j] + 1)
                        .min(d[i][j - 1] + 1);
                }
            }
            d[a.len()][b.len()]
        }
        let words = [
            "",
            "ا",
            "ab",
            "ba",
            "abc",
            "acb",
            "الله",
            "لله",
            "والله",
            "اللهم",
            "الرحمن",
            "الرحيم",
            "رحمن",
            "الصلاه",
            "الصلوه",
            "يومنون",
            "يؤمنون",
            "abcdef",
            "azcdxf",
            "qwerty",
        ];
        for a in words {
            for b in words {
                let d = reference(a, b);
                for max in 0..4u32 {
                    let expected = (d <= max as usize).then(|| u32::try_from(d).unwrap());
                    assert_eq!(
                        levenshtein_bounded(a, b, max),
                        expected,
                        "{a} / {b} ≤ {max}"
                    );
                }
            }
        }
    }

    fn vocab() -> Vocab {
        Vocab::from_pairs(&[
            ("الرحمن", 57),
            ("الرحيم", 95),
            ("الرحمه", 20),
            ("رحمن", 3),
            ("الله", 1567),
            ("لله", 116),
            ("الصلاه", 58),
            ("العالمين", 61),
            ("العالمون", 2),
        ])
    }

    fn parse(q: &str) -> ParsedQuery {
        ParsedQuery::parse(q, Fold::Arabic(Level::Loose))
    }

    #[test]
    fn candidates_are_nearest_then_most_frequent() {
        let v = vocab();
        assert_eq!(v.len(), 9);
        let c = v.candidates("الرحمان");
        let terms: Vec<_> = c.iter().map(|c| (c.term.as_str(), c.distance)).collect();
        // 7 letters allow 2 edits, but only the nearest tier is kept: الرحمه (2 edits) loses to الرحمن (1);
        // الرحيم is 3 away and رحمن 3 letters shorter.
        assert_eq!(terms, [("الرحمن", 1)]);
        // Several terms at the nearest distance: most frequent first.
        let c = v.candidates("الرحيمن");
        let terms: Vec<_> = c.iter().map(|c| (c.term.as_str(), c.distance)).collect();
        assert_eq!(terms, [("الرحيم", 1), ("الرحمن", 1)]);
        assert!(v.candidates("زززز").is_empty());
        assert!(v.contains("الله") && !v.contains("الل"));
        assert!(v.has_prefix("الل") && v.has_prefix("الرح") && !v.has_prefix("زز"));
    }

    #[test]
    fn at_most_eight_candidates() {
        let pairs: Vec<(String, u32)> = (0..20)
            .map(|i| (format!("ab{}", char::from(b'a' + i)), u32::from(i)))
            .collect();
        let refs: Vec<(&str, u32)> = pairs.iter().map(|(t, n)| (t.as_str(), *n)).collect();
        let v = Vocab::from_pairs(&refs);
        let c = v.candidates("abz");
        assert_eq!(c.len(), MAX_EXPANSIONS);
        assert_eq!(c[0].doc_count, 19, "most frequent first among equals");
    }

    #[test]
    fn only_unknown_tokens_are_expanded() {
        let v = vocab();
        let p = parse("الله الرحمان");
        let e = expand(&p, false, &v).unwrap();
        assert_eq!(
            render_fts(Some("loose"), &e.groups),
            r#"loose : ("الله" "الرحمن")"#
        );
        assert_eq!(e.corrections, ["الرحمن"]);
        let e = expand(&parse("الله الرحيمن"), false, &v).unwrap();
        assert_eq!(
            render_fts(Some("loose"), &e.groups),
            r#"loose : ("الله" AND ("الرحيم" OR "الرحمن"))"#
        );
        assert_eq!(e.corrections, ["الرحيم", "الرحمن"]);
        // Every token is a word: nothing to correct.
        assert_eq!(expand(&parse("الله الرحمن"), false, &v), None);
        // A known prefix stays a prefix.
        let e = expand(&parse("العالمبن الرح"), true, &v).unwrap();
        assert_eq!(
            render_fts(Some("loose"), &e.groups),
            r#"loose : (("العالمين" OR "العالمون") AND "الرح"*)"#
        );
        // An unknown last token is corrected to whole words.
        let e = expand(&parse("الصلاع"), true, &v).unwrap();
        assert_eq!(render_fts(None, &e.groups), r#""الصلاه""#);
        // Phrases are never expanded.
        assert_eq!(expand(&parse("\"الرحمان الرحيم\""), false, &v), None);
    }

    #[test]
    fn eligibility_needs_three_letters_everywhere() {
        assert!(eligible(&parse("الرحمان")));
        assert!(eligible(&parse("الله \"الرحمن الرحيم\"")));
        assert!(
            !eligible(&parse("الله \"رب العالمين\"")),
            "رب has two letters"
        );
        assert!(!eligible(&parse("يا ايها")), "يا has two letters");
        assert!(!eligible(&parse("\"الرحمان\"")), "no bare token");
        assert!(!eligible(&parse("")));
    }
}
