//! Word-match mapping for hit highlighting and Rust-built snippets from `plain`.
//!
//! **Words.** A Quran hit carries the ids of its matched words: a word matches when one of its own tokens (its
//! `norm_loose`, or `normalize_ar(text_imlaei, Strict)` in exact mode, split like FTS5 splits) equals a query token, or
//! starts with the last one in prefix mode. Substring mode marks every word that overlaps an occurrence of the needle in
//! the ayah's loose text, so a needle may span words. Ayah and word texts are never split on spaces to recover words
//! (a word may itself contain a space): words come from `word` rows.
//!
//! **Snippets.** Translation and note hits carry an HTML snippet (escaped text plus `<mark>`): FTS5's own `snippet()`
//! where the indexed text is the display text, otherwise built here from the display text. The source is cut into
//! segments (a character with its combining marks), each segment is folded like the index, and every folded byte
//! remembers its source segment, so matches found in folded text are marked on the original, vocalised text. The
//! snippet keeps ±12 words around the first match, and is cut by characters when the text has no spaces (CJK, Thai).

use std::collections::HashSet;
use std::ops::Range;

use unicode_normalization::char::is_combining_mark;

use super::query::{Fold, Group, is_token_char, split_tokens};
use crate::normalize::{Level, normalize_ar};

/// Words of context kept on each side of the first match.
pub(crate) const CONTEXT_WORDS: usize = 12;
/// Longest snippet in characters; longer windows (text without spaces) are cut by characters.
pub(crate) const MAX_SNIPPET_CHARS: usize = 320;
/// Characters kept before the first match when a window is cut by characters.
const LEAD_CHARS: usize = 120;
/// How far a character cut may move to land between words instead of inside one.
const SNAP_CHARS: usize = 24;
/// Marks a cut.
const ELLIPSIS: char = '…';
/// FTS5 `snippet()` match delimiters (`char(57344)`, `char(57345)`).
const MATCH_OPEN: char = '\u{E000}';
const MATCH_CLOSE: char = '\u{E001}';

/// The query tokens a word or text token is compared with: equal to one of `exact`, or starting with one of
/// `prefixes`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TokenSet {
    exact: HashSet<String>,
    prefixes: Vec<String>,
}

impl TokenSet {
    /// Every token of every alternative; the last token of a prefix alternative is a prefix. Phrase tokens are matched
    /// individually.
    pub(crate) fn from_groups(groups: &[Group]) -> Self {
        let mut set = Self::default();
        for alt in groups.iter().flat_map(|g| &g.0) {
            let tokens: Vec<&str> = split_tokens(&alt.text).collect();
            for (i, token) in tokens.iter().enumerate() {
                if alt.prefix && i + 1 == tokens.len() {
                    if !set.prefixes.iter().any(|p| p == token) {
                        set.prefixes.push((*token).to_owned());
                    }
                } else {
                    set.exact.insert((*token).to_owned());
                }
            }
        }
        set
    }

    /// The same set, lower-cased (FTS5 tokenizers fold case; text tokens are lower-cased before comparing).
    fn lowercased(&self) -> Self {
        Self {
            exact: self.exact.iter().map(|t| t.to_lowercase()).collect(),
            prefixes: self.prefixes.iter().map(|p| p.to_lowercase()).collect(),
        }
    }

    pub(crate) fn matches(&self, token: &str) -> bool {
        self.exact.contains(token) || self.prefixes.iter().any(|p| token.starts_with(p.as_str()))
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.exact.is_empty() && self.prefixes.is_empty()
    }
}

/// One `word` row of a hit ayah, in word order (end marker last).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WordRow {
    pub(crate) id: u32,
    pub(crate) is_end: bool,
    pub(crate) text_hafs: String,
    /// `normalize_ar(text_imlaei, Loose)`; `None` for end markers.
    pub(crate) norm_loose: Option<String>,
    /// `None` for end markers.
    pub(crate) text_imlaei: Option<String>,
}

/// How the words of a Quran hit are matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WordRule {
    /// Smart (`Level::Loose`, the stored `norm_loose`) or exact (`Level::Strict`, `normalize_ar(text_imlaei,
    /// Strict)`): a word matches when one of its tokens is in the set.
    Tokens { set: TokenSet, level: Level },
    /// Substring: words overlapping an occurrence of the (loose) needle in the ayah's loose text.
    Substring(String),
}

impl WordRule {
    /// The ids of the matched words (never the end marker), in word order.
    pub(crate) fn matched(&self, words: &[WordRow]) -> Vec<u32> {
        match self {
            Self::Tokens { set, level } => words
                .iter()
                .filter(|w| !w.is_end && word_matches(w, set, *level))
                .map(|w| w.id)
                .collect(),
            Self::Substring(needle) => substring_words(needle, words),
        }
    }
}

fn word_matches(word: &WordRow, set: &TokenSet, level: Level) -> bool {
    match level {
        Level::Loose => word
            .norm_loose
            .as_deref()
            .is_some_and(|n| split_tokens(n).any(|t| set.matches(t))),
        Level::Strict => word.text_imlaei.as_deref().is_some_and(|text| {
            split_tokens(&normalize_ar(text, Level::Strict)).any(|t| set.matches(t))
        }),
    }
}

/// The words whose `norm_loose` overlaps an occurrence of `needle` in the words' loose texts joined by single spaces
/// (which is the ayah's `norm_loose`, the text `LIKE` matched).
fn substring_words(needle: &str, words: &[WordRow]) -> Vec<u32> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut joined = String::new();
    let mut spans: Vec<(Range<usize>, u32)> = Vec::new();
    for word in words.iter().filter(|w| !w.is_end) {
        let Some(text) = word.norm_loose.as_deref().filter(|t| !t.is_empty()) else {
            continue;
        };
        if !joined.is_empty() {
            joined.push(' ');
        }
        let start = joined.len();
        joined.push_str(text);
        spans.push((start..joined.len(), word.id));
    }
    let mut hit = vec![false; spans.len()];
    for found in occurrences(&joined, needle) {
        for ((span, _), flag) in spans.iter().zip(hit.iter_mut()) {
            if span.start < found.end && found.start < span.end {
                *flag = true;
            }
        }
    }
    spans
        .iter()
        .zip(hit)
        .filter_map(|((_, id), flag)| flag.then_some(*id))
        .collect()
}

/// Every occurrence of `needle` in `haystack`, overlapping ones included.
fn occurrences(haystack: &str, needle: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut from = 0;
    while let Some(pos) = haystack.get(from..).and_then(|rest| rest.find(needle)) {
        let start = from + pos;
        out.push(start..start + needle.len());
        let step = haystack
            .get(start..)
            .and_then(|rest| rest.chars().next())
            .map_or(1, char::len_utf8);
        from = start + step;
    }
    out
}

/// Finds and marks query matches in display text (translation `plain`, note bodies).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TextMatcher {
    fold: Fold,
    rule: TextRule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TextRule {
    /// Folded text tokens equal to (or, for the prefix, starting with) a query token (FTS5 hits).
    Tokens(TokenSet),
    /// Occurrences of the folded needle (`LIKE` hits).
    Substring(String),
}

impl TextMatcher {
    /// Token matching for FTS5 hits of `groups`, on text folded with `fold`.
    pub(crate) fn tokens(fold: Fold, groups: &[Group]) -> Self {
        Self {
            fold,
            rule: TextRule::Tokens(TokenSet::from_groups(groups).lowercased()),
        }
    }

    /// Substring matching for `LIKE` hits of `needle` (already folded with `fold`).
    pub(crate) fn substring(fold: Fold, needle: &str) -> Self {
        Self {
            fold,
            rule: TextRule::Substring(needle.to_lowercase()),
        }
    }

    /// The byte ranges of `source` that match, sorted and merged.
    pub(crate) fn find(&self, source: &str) -> Vec<Range<usize>> {
        let folded = FoldedText::new(source, self.fold);
        let found: Vec<Range<usize>> = match &self.rule {
            TextRule::Tokens(set) if set.is_empty() => Vec::new(),
            TextRule::Tokens(set) => token_ranges(&folded.text)
                .filter(|r| folded.text.get(r.clone()).is_some_and(|t| set.matches(t)))
                .collect(),
            TextRule::Substring(needle) => occurrences(&folded.text, needle),
        };
        merge(
            found
                .into_iter()
                .filter_map(|r| folded.source_range(&r))
                .collect(),
        )
    }

    /// The snippet of `source` around its first match, or `None` when nothing in it matches.
    pub(crate) fn snippet(&self, source: &str) -> Option<String> {
        let marks = self.find(source);
        (!marks.is_empty()).then(|| cut(source, &marks))
    }
}

/// A snippet without marks: the start of `source` (for a hit whose match the highlighter cannot place).
pub(crate) fn lead_snippet(source: &str) -> String {
    cut(source, &[])
}

/// FTS5 `snippet()` output (matches between U+E000 and U+E001) as escaped HTML with `<mark>`. Stray or unbalanced
/// delimiters are dropped, so the result is always well formed.
pub(crate) fn fts_snippet_html(raw: &str) -> String {
    let mut out = HtmlWriter::default();
    for c in raw.chars() {
        match c {
            MATCH_OPEN => out.open_mark(),
            MATCH_CLOSE => out.close_mark(),
            c => out.push(c),
        }
    }
    out.finish()
}

/// Folded text that remembers, for every folded segment, the source bytes it came from.
#[derive(Debug, Default)]
struct FoldedText {
    text: String,
    spans: Vec<Span>,
}

/// A folded segment: it starts at `fold` in the folded text and came from `src` in the source.
#[derive(Debug, Clone)]
struct Span {
    fold: usize,
    src: Range<usize>,
}

impl FoldedText {
    /// Folds `source` segment by segment (a character plus its combining marks, so compositions and dropped marks stay
    /// inside one segment), lower-cased; separators become one space.
    fn new(source: &str, fold: Fold) -> Self {
        let mut out = Self::default();
        for seg in segments(source) {
            let Some(piece) = source.get(seg.clone()) else {
                continue;
            };
            let folded = fold.apply(piece).to_lowercase();
            if folded.trim().is_empty() {
                let separator = piece.chars().next().is_some_and(|c| fold.is_separator(c));
                if separator && !out.text.is_empty() && !out.text.ends_with(' ') {
                    out.spans.push(Span {
                        fold: out.text.len(),
                        src: seg,
                    });
                    out.text.push(' ');
                }
                continue;
            }
            out.spans.push(Span {
                fold: out.text.len(),
                src: seg,
            });
            out.text.push_str(&folded);
        }
        out
    }

    /// The source bytes behind the folded bytes `range`.
    fn source_range(&self, range: &Range<usize>) -> Option<Range<usize>> {
        if range.start >= range.end {
            return None;
        }
        let first = self
            .spans
            .partition_point(|s| s.fold <= range.start)
            .checked_sub(1)?;
        let last = self
            .spans
            .partition_point(|s| s.fold < range.end)
            .checked_sub(1)?;
        Some(self.spans.get(first)?.src.start..self.spans.get(last)?.src.end)
    }
}

/// A character and the combining marks that follow it, as byte ranges. A mark at the very start is its own segment.
fn segments(s: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    for (i, c) in s.char_indices() {
        let end = i + c.len_utf8();
        match out.last_mut() {
            Some(last) if is_combining_mark(c) => last.end = end,
            _ => out.push(i..end),
        }
    }
    out
}

/// Maximal runs of token characters (see [`is_token_char`]) as byte ranges.
fn token_ranges(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    let mut start: Option<usize> = None;
    let mut chars = text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')));
    std::iter::from_fn(move || {
        for (i, c) in chars.by_ref() {
            let token = i < text.len() && is_token_char(c);
            match (start, token) {
                (None, true) => start = Some(i),
                (Some(s), false) => {
                    start = None;
                    return Some(s..i);
                }
                _ => {}
            }
        }
        None
    })
}

/// Sorts ranges and merges overlapping or touching ones.
fn merge(mut ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    ranges.sort_by_key(|r| (r.start, r.end));
    let mut out: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for r in ranges {
        match out.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

/// Whitespace-separated words of `s` as byte ranges.
fn word_ranges(s: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in s.char_indices() {
        match (start, c.is_whitespace()) {
            (None, false) => start = Some(i),
            (Some(st), true) => {
                out.push(st..i);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(st) = start {
        out.push(st..s.len());
    }
    out
}

/// The byte offset `n` characters before `at` (or 0).
fn chars_before(s: &str, at: usize, n: usize) -> usize {
    s.get(..at)
        .and_then(|head| head.char_indices().rev().nth(n.saturating_sub(1)))
        .map_or(0, |(i, _)| i)
}

/// The byte offset `n` characters after `at` (or the end).
fn chars_after(s: &str, at: usize, n: usize) -> usize {
    s.get(at..)
        .and_then(|tail| tail.char_indices().nth(n))
        .map_or(s.len(), |(i, _)| at + i)
}

/// The window of `source` around the first mark (±[`CONTEXT_WORDS`] words, at most [`MAX_SNIPPET_CHARS`]
/// characters), rendered as escaped HTML with every mark inside it wrapped in `<mark>`, and `…` where text was cut.
/// Without marks, the window starts at the beginning of the text.
fn cut(source: &str, marks: &[Range<usize>]) -> String {
    let words = word_ranges(source);
    let (Some(first_word), Some(last_word)) = (words.first(), words.last()) else {
        return String::new();
    };
    let (text_start, text_end) = (first_word.start, last_word.end);
    let first = marks.first().cloned().unwrap_or(text_start..text_start);
    let w0 = words
        .partition_point(|w| w.end <= first.start)
        .min(words.len() - 1);
    let w1 = words
        .partition_point(|w| w.start < first.end)
        .saturating_sub(1)
        .max(w0);
    let lo = w0.saturating_sub(CONTEXT_WORDS);
    let hi = (w1 + CONTEXT_WORDS).min(words.len() - 1);
    let mut start = words.get(lo).map_or(text_start, |w| w.start);
    let mut end = words.get(hi).map_or(text_end, |w| w.end);
    if source
        .get(start..end)
        .is_some_and(|w| w.chars().count() > MAX_SNIPPET_CHARS)
    {
        // Text with few spaces: cut by characters around the first match, preferring a cut between words.
        let cut_start = chars_before(source, first.start, LEAD_CHARS).max(start);
        let cut_end = chars_after(source, cut_start, MAX_SNIPPET_CHARS)
            .min(end)
            .max(first.end.min(end));
        start = snap_forward(source, cut_start, first.start).unwrap_or(cut_start);
        end = snap_backward(source, cut_end, first.end).unwrap_or(cut_end);
    }
    let mut out = HtmlWriter::default();
    if start > text_start {
        out.push(ELLIPSIS);
    }
    let mut at = start;
    for mark in marks {
        let (ms, me) = (mark.start.max(start), mark.end.min(end));
        if ms >= me {
            continue;
        }
        out.push_str(source.get(at..ms).unwrap_or_default());
        out.open_mark();
        out.push_str(source.get(ms..me).unwrap_or_default());
        out.close_mark();
        at = me;
    }
    out.push_str(source.get(at..end).unwrap_or_default());
    if end < text_end {
        out.push(ELLIPSIS);
    }
    out.finish()
}

/// A word start at or after `at` within [`SNAP_CHARS`] characters, not past `limit`; `None` when `at` already starts a
/// word or none is close.
fn snap_forward(s: &str, at: usize, limit: usize) -> Option<usize> {
    let starts_word = s
        .get(..at)
        .and_then(|head| head.chars().next_back())
        .is_none_or(char::is_whitespace);
    if starts_word {
        return None;
    }
    let tail = s.get(at..limit)?;
    let (i, c) = tail
        .char_indices()
        .take(SNAP_CHARS)
        .find(|(_, c)| c.is_whitespace())?;
    Some(at + i + c.len_utf8())
}

/// A word end at or before `at` within [`SNAP_CHARS`] characters, not before `limit`; `None` when `at` already ends a
/// word or none is close.
fn snap_backward(s: &str, at: usize, limit: usize) -> Option<usize> {
    let ends_word = s
        .get(at..)
        .and_then(|tail| tail.chars().next())
        .is_none_or(char::is_whitespace);
    if ends_word || limit > at {
        return None;
    }
    let head = s.get(limit..at)?;
    let (i, _) = head
        .char_indices()
        .rev()
        .take(SNAP_CHARS)
        .find(|(_, c)| c.is_whitespace())?;
    Some(limit + i)
}

/// Escaped HTML text with `<mark>` elements: `& < > " '` are escaped, whitespace runs become one space and the
/// result is trimmed; marks are balanced (a mark left open is closed at the end, an empty one is dropped).
#[derive(Debug, Default)]
struct HtmlWriter {
    out: String,
    pending_space: bool,
    open: bool,
    /// The mark was opened but nothing was written into it yet (emitted lazily, so empty marks vanish).
    open_pending: bool,
}

impl HtmlWriter {
    fn push_str(&mut self, s: &str) {
        for c in s.chars() {
            self.push(c);
        }
    }

    fn push(&mut self, c: char) {
        if c.is_whitespace() {
            self.pending_space = !self.out.is_empty();
            return;
        }
        if self.pending_space {
            self.out.push(' ');
            self.pending_space = false;
        }
        if self.open_pending {
            self.out.push_str("<mark>");
            self.open_pending = false;
        }
        match c {
            '&' => self.out.push_str("&amp;"),
            '<' => self.out.push_str("&lt;"),
            '>' => self.out.push_str("&gt;"),
            '"' => self.out.push_str("&quot;"),
            '\'' => self.out.push_str("&#39;"),
            c => self.out.push(c),
        }
    }

    fn open_mark(&mut self) {
        if !self.open {
            self.open = true;
            self.open_pending = true;
        }
    }

    fn close_mark(&mut self) {
        if !self.open {
            return;
        }
        self.open = false;
        if self.open_pending {
            self.open_pending = false;
        } else {
            self.out.push_str("</mark>");
        }
    }

    fn finish(mut self) -> String {
        self.close_mark();
        self.out
    }
}

/// Plain text of a note body for its snippet: the Markdown subset's block markers (headings, quotes, list bullets,
/// task boxes), emphasis/code/strike markers and link targets are removed and lines are joined with spaces. Purely
/// cosmetic: the snippet is escaped afterwards like any other text.
pub(crate) fn markdown_text(md: &str) -> String {
    let mut out = String::new();
    for line in md.lines() {
        let inline = strip_inline(strip_block_markers(line));
        let inline = inline.trim();
        if inline.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(inline);
    }
    out
}

fn strip_block_markers(line: &str) -> &str {
    let mut line = line.trim_start();
    while let Some(rest) = line.strip_prefix('>') {
        line = rest.trim_start();
    }
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes)
        && let Some(rest) = line.get(hashes..)
        && (rest.is_empty() || rest.starts_with(char::is_whitespace))
    {
        line = rest.trim_start();
    }
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(bullet) {
            line = rest.trim_start();
            break;
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0
        && let Some(rest) = line.get(digits..)
        && let Some(rest) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
    {
        line = rest.trim_start();
    }
    for task in ["[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = line.strip_prefix(task) {
            line = rest;
            break;
        }
    }
    line
}

fn strip_inline(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        let next = chars.get(i + 1).copied();
        match c {
            '\\' if next.is_some_and(|n| n.is_ascii_punctuation()) => {
                out.extend(next);
                i += 2;
            }
            '!' if next == Some('[') => i += 1,
            '[' => match link_at(&chars, i) {
                Some((text, after)) => {
                    out.push_str(&strip_inline(&text));
                    i = after;
                }
                None => {
                    out.push('[');
                    i += 1;
                }
            },
            '*' | '`' => i += 1,
            '~' if next == Some('~') => i += 2,
            '_' => {
                let prev = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
                let inside_word = prev.is_some_and(char::is_alphanumeric)
                    && next.is_some_and(char::is_alphanumeric);
                if inside_word {
                    out.push('_');
                }
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `[text](target)` starting at `open`: the link text and the index after `)`.
fn link_at(chars: &[char], open: usize) -> Option<(String, usize)> {
    let rest = chars.get(open + 1..)?;
    let close = rest.iter().position(|&c| c == ']')?;
    let text: String = rest.get(..close)?.iter().collect();
    let after_text = open + 1 + close + 1;
    if chars.get(after_text) != Some(&'(') {
        return None;
    }
    let target = chars.get(after_text + 1..)?;
    let end = target.iter().position(|&c| c == ')')?;
    Some((text, after_text + 1 + end + 1))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use crate::search::query::{Alt, ParsedQuery};

    fn word(id: u32, loose: &str, imlaei: &str) -> WordRow {
        WordRow {
            id,
            is_end: false,
            text_hafs: format!("hafs{id}"),
            norm_loose: Some(loose.into()),
            text_imlaei: Some(imlaei.into()),
        }
    }

    fn end(id: u32) -> WordRow {
        WordRow {
            id,
            is_end: true,
            text_hafs: "\u{06DD}\u{0661}".into(),
            norm_loose: None,
            text_imlaei: None,
        }
    }

    fn groups(q: &str, level: Level, prefix: bool) -> Vec<Group> {
        let p = ParsedQuery::parse(q, Fold::Arabic(level));
        p.groups(prefix && p.last_is_prefixable())
    }

    /// 2:21-like ayah: "يا ايها" is ONE word with a space in its loose text.
    fn ayah() -> Vec<WordRow> {
        vec![
            word(10, "يا ايها", "يَا أَيُّهَا"),
            word(11, "الناس", "النَّاسُ"),
            word(12, "اعبدوا", "اعْبُدُوا"),
            word(13, "ربكم", "رَبَّكُمُ"),
            word(14, "الصلاه", "الصَّلَاةَ"),
            word(15, "واناب", "وَأَنَابَ ۩"),
            end(16),
        ]
    }

    #[test]
    fn words_match_their_own_tokens() {
        let rule = WordRule::Tokens {
            set: TokenSet::from_groups(&groups("يا ايها الناس", Level::Loose, true)),
            level: Level::Loose,
        };
        assert_eq!(rule.matched(&ayah()), [10, 11]);
        // Prefix on the last token only.
        let rule = WordRule::Tokens {
            set: TokenSet::from_groups(&groups("الناس رب", Level::Loose, true)),
            level: Level::Loose,
        };
        assert_eq!(rule.matched(&ayah()), [11, 13]);
        let rule = WordRule::Tokens {
            set: TokenSet::from_groups(&groups("رب الناس", Level::Loose, true)),
            level: Level::Loose,
        };
        assert_eq!(rule.matched(&ayah()), [11], "رب is not a prefix here");
        // The sajda word with "space + ۩" in its text matches on its letters.
        let rule = WordRule::Tokens {
            set: TokenSet::from_groups(&groups("واناب", Level::Loose, false)),
            level: Level::Loose,
        };
        assert_eq!(rule.matched(&ayah()), [15]);
    }

    #[test]
    fn exact_mode_compares_strict_text() {
        let strict = |q: &str| WordRule::Tokens {
            set: TokenSet::from_groups(&groups(q, Level::Strict, false)),
            level: Level::Strict,
        };
        assert_eq!(strict("الصلاة").matched(&ayah()), [14]);
        assert!(
            strict("الصلاه").matched(&ayah()).is_empty(),
            "ة is kept in strict"
        );
        assert_eq!(strict("أيها").matched(&ayah()), [10]);
    }

    #[test]
    fn substring_marks_every_overlapped_word() {
        let rule = WordRule::Substring("ايها الن".into());
        assert_eq!(rule.matched(&ayah()), [10, 11]);
        assert_eq!(WordRule::Substring("بكم".into()).matched(&ayah()), [13]);
        assert_eq!(
            WordRule::Substring("ا".into()).matched(&ayah()),
            [10, 11, 12, 14, 15]
        );
        assert!(WordRule::Substring("زز".into()).matched(&ayah()).is_empty());
        assert!(
            WordRule::Substring(String::new())
                .matched(&ayah())
                .is_empty()
        );
    }

    #[test]
    fn typo_groups_match_every_alternative() {
        let g = vec![Group(vec![
            Alt {
                text: "الناس".into(),
                prefix: false,
            },
            Alt {
                text: "ربكم".into(),
                prefix: false,
            },
        ])];
        let rule = WordRule::Tokens {
            set: TokenSet::from_groups(&g),
            level: Level::Loose,
        };
        assert_eq!(rule.matched(&ayah()), [11, 13]);
    }

    #[test]
    fn overlapping_occurrences_are_all_found() {
        assert_eq!(occurrences("aaaa", "aa"), [0..2, 1..3, 2..4]);
        assert!(occurrences("abc", "").is_empty());
        assert_eq!(occurrences("الله الله", "الله"), [0..8, 9..17]);
    }

    fn arabic_tokens(q: &str) -> TextMatcher {
        let p = ParsedQuery::parse(q, Fold::Arabic(Level::Loose));
        TextMatcher::tokens(
            Fold::Arabic(Level::Loose),
            &p.groups(p.last_is_prefixable()),
        )
    }

    #[test]
    fn arabic_snippets_mark_the_vocalised_source() {
        let plain = "شروع اللہ کے نام سے جو بڑا مہربان نہایت رحم والا ہے، الرَّحْمَٰنِ";
        let m = arabic_tokens("الله");
        let marks = m.find(plain);
        assert_eq!(marks.len(), 1);
        assert_eq!(&plain[marks[0].clone()], "اللہ", "ہ folds to ه");
        assert_eq!(
            m.snippet(plain).unwrap(),
            "شروع <mark>اللہ</mark> کے نام سے جو بڑا مہربان نہایت رحم والا ہے، الرَّحْمَٰنِ"
        );
        // Prefix matching on the last token, and marks around harakat-laden words.
        let m = arabic_tokens("الرحم");
        let s = m.snippet(plain).unwrap();
        assert!(s.ends_with("<mark>الرَّحْمَٰنِ</mark>"), "{s}");
        // Punctuation glued to a word stays outside the mark.
        let s = arabic_tokens("ہے").snippet(plain).unwrap();
        assert!(s.contains("<mark>ہے</mark>،"), "{s}");
        assert_eq!(arabic_tokens("زززز").snippet(plain), None);
    }

    #[test]
    fn windows_keep_twelve_words_each_side() {
        let words: Vec<String> = (0..60).map(|i| format!("w{i}")).collect();
        let text = words.join(" ");
        let m = TextMatcher::substring(Fold::Raw, "w30");
        let s = m.snippet(&text).unwrap();
        let expected: Vec<String> = (18..=42)
            .map(|i| {
                if i == 30 {
                    "<mark>w30</mark>".to_owned()
                } else {
                    format!("w{i}")
                }
            })
            .collect();
        assert_eq!(s, format!("…{}…", expected.join(" ")));
        // At the very start: no leading ellipsis.
        let s = TextMatcher::substring(Fold::Raw, "w0")
            .snippet(&text)
            .unwrap();
        assert!(s.starts_with("<mark>w0</mark> w1"), "{s}");
        assert!(s.ends_with("w12…"), "{s}");
    }

    #[test]
    fn substring_marks_are_case_insensitive_and_may_span_words() {
        let text = "And He is the Most Merciful. Mercy, and light.";
        let s = TextMatcher::substring(Fold::Raw, "merc")
            .snippet(text)
            .unwrap();
        assert_eq!(
            s,
            "And He is the Most <mark>Merc</mark>iful. <mark>Merc</mark>y, and light."
        );
        let s = TextMatcher::substring(Fold::Raw, "most merciful")
            .snippet(text)
            .unwrap();
        assert!(s.contains("<mark>Most Merciful</mark>"), "{s}");
    }

    #[test]
    fn text_without_spaces_is_cut_by_characters() {
        let text: String = "天".repeat(400) + "慈悲" + &"地".repeat(400);
        let s = TextMatcher::substring(Fold::Latin, "慈悲")
            .snippet(&text)
            .unwrap();
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(s.contains("<mark>慈悲</mark>"));
        let visible = s.chars().filter(|&c| c == '天' || c == '地').count();
        assert!(visible + 2 <= MAX_SNIPPET_CHARS, "{visible}");
        assert_eq!(
            s.chars().filter(|&c| c == '天').count(),
            LEAD_CHARS,
            "the match keeps its lead"
        );
    }

    #[test]
    fn long_words_are_cut_between_words_when_possible() {
        // 25 words of 20 letters exceed the character budget, so the window is cut by characters, and each cut moves
        // to the nearest gap between words.
        let long = "x".repeat(20);
        let side = vec![long.as_str(); 20].join(" ");
        let text = format!("{side} needle {side}");
        let s = TextMatcher::substring(Fold::Raw, "needle")
            .snippet(&text)
            .unwrap();
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        let inner = s.trim_matches('…');
        let visible = inner.replace("<mark>", "").replace("</mark>", "");
        assert!(visible.chars().count() <= MAX_SNIPPET_CHARS, "{s}");
        assert!(
            inner
                .split(' ')
                .all(|w| w.len() == 20 || w == "<mark>needle</mark>"),
            "every cut is between words: {s}"
        );
    }

    #[test]
    fn snippets_are_escaped() {
        let text = "a <b>&\"quoted\" 'x' mercy";
        let s = TextMatcher::substring(Fold::Raw, "mercy")
            .snippet(text)
            .unwrap();
        assert_eq!(
            s,
            "a &lt;b&gt;&amp;&quot;quoted&quot; &#39;x&#39; <mark>mercy</mark>"
        );
        assert_eq!(lead_snippet("  one\n\ntwo  "), "one two");
        assert_eq!(lead_snippet(""), "");
    }

    #[test]
    fn fts_snippets_become_marks() {
        assert_eq!(
            fts_snippet_html("…the \u{E000}Merciful\u{E001} <and> \u{E000}mercy\u{E001}…"),
            "…the <mark>Merciful</mark> &lt;and&gt; <mark>mercy</mark>…"
        );
        // Unbalanced or empty delimiters never break the markup.
        assert_eq!(fts_snippet_html("a \u{E000}b"), "a <mark>b</mark>");
        assert_eq!(fts_snippet_html("a\u{E001} b"), "a b");
        assert_eq!(fts_snippet_html("a \u{E000}\u{E001}b"), "a b");
        assert_eq!(
            fts_snippet_html("\u{E000}\u{E000}x\u{E001}\u{E001}"),
            "<mark>x</mark>"
        );
    }

    #[test]
    fn note_snippets_fold_arabic_then_latin() {
        let p = ParsedQuery::parse("cafe الصلاة", Fold::Notes);
        let m = TextMatcher::tokens(Fold::Notes, &p.groups(false));
        let s = m.snippet("Le Café et الصَّلَاةَ").unwrap();
        assert_eq!(s, "Le <mark>Café</mark> et <mark>الصَّلَاةَ</mark>");
    }

    #[test]
    fn markdown_is_reduced_to_text() {
        let md = "# Heading\n\n> quoted **bold** and _em_ text\n- item with `code`\n1. [link text](https://x.y) ![img](a.png)\n- [x] done ~~gone~~ snake_case \\*star\\*";
        assert_eq!(
            markdown_text(md),
            "Heading quoted bold and em text item with code link text img done gone snake_case *star*"
        );
        assert_eq!(
            markdown_text("#hashtag [not a link]"),
            "#hashtag [not a link]"
        );
    }

    #[test]
    fn segments_keep_marks_with_their_base() {
        let s = "بِسْمِ";
        let segs = segments(s);
        assert_eq!(segs.len(), 3);
        assert_eq!(&s[segs[0].clone()], "بِ");
        assert_eq!(segments("\u{064E}a"), [0..2, 2..3]);
    }
}
