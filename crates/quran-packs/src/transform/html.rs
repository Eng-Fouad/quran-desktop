//! The HTML policy for translations, footnotes and tafsir (docs/ARCHITECTURE.md §2.5.6, §7.6). Owner: WP5c.
//!
//! [`sanitize`] is the only way upstream HTML reaches a pack DB or `content.db`:
//! - **tags** [`ALLOWED_TAGS`]: `p, br, b, strong, i, em, span, sup, sub, h2, h3, h4, ul, ol, li, a, blockquote`; any
//!   other tag is unwrapped (its text kept), `script`/`style` are removed with their content, comments are dropped;
//! - **classes** [`ALLOWED_CLASSES`]: `span.h .s .green .arabic .qpc-hafs .brown`, `sup.fn`, `i.s`; other class tokens
//!   are dropped (and an empty `class` with them);
//! - **attributes**: `sup[data-fn]` (`s:a:n`, the marker keeping its source digits) and `a[data-ref]` (`s:a` or
//!   `s:a-b`) only. `style`, `href`, event handlers and every other attribute are dropped;
//! - **references**: an upstream `a[href]` whose href is a verse reference (`^/?\d{1,3}:\d{1,3}(-\d{1,3})?$`, and a
//!   real ayah or ayah range) becomes `<a data-ref="{s}:{a}[-{b}]">` without `href`; every other link is unwrapped. No
//!   URL scheme is involved, so DOMPurify's `ALLOWED_URI_REGEXP` and ammonia's `url_schemes` cannot strip it;
//! - `h1` becomes `h2`.
//!
//! It runs ammonia twice. The first pass normalises arbitrary (often malformed) upstream markup into html5ever's
//! serialisation, keeping only the allowed tags plus `h1` and verse-reference hrefs. A small tokenizer over that
//! well-formed output then rewrites `a[href]` to `a[data-ref]`, unwraps the other links and renames `h1`. The second
//! pass applies exactly the final policy, so the stored HTML is ammonia-clean whatever the rewrite did. The webview runs
//! the same allowlist again with DOMPurify (`src/lib/text/html.ts`), whose `REF_PATTERN` and `FOOTNOTE_PATTERN` the
//! attribute checks here mirror.
//!
//! [`plain_text`] derives the `plain` column (tags stripped, footnote markers removed, entities decoded, whitespace
//! collapsed, one line per block), which feeds the FTS `fold` column, search snippets and "copy".

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ammonia::{Builder, UrlRelative};
use quran_core::content_db::geometry::surah_ayah_count;
use quran_types::SURAH_COUNT;
use regex::Regex;

/// Tags that survive sanitising (§2.5.6).
pub const ALLOWED_TAGS: [&str; 17] = [
    "p",
    "br",
    "b",
    "strong",
    "i",
    "em",
    "span",
    "sup",
    "sub",
    "h2",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "a",
    "blockquote",
];

/// Class tokens allowed per tag (§2.5.6).
pub const ALLOWED_CLASSES: [(&str, &[&str]); 3] = [
    ("span", &["h", "s", "green", "arabic", "qpc-hafs", "brown"]),
    ("sup", &["fn"]),
    ("i", &["s"]),
];

/// Tags whose content is dropped along with them.
const DROP_CONTENT_TAGS: [&str; 2] = ["script", "style"];

/// Tags that end a line in [`plain_text`].
const BLOCK_TAGS: [&str; 10] = [
    "p",
    "br",
    "h2",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "blockquote",
    "div",
];

/// `data-fn` values: `s:a:n` with ASCII surah/ayah and a 1–4 digit marker in the source's digits (Bengali, Arabic-Indic,
/// …), as `FOOTNOTE_PATTERN` in `src/lib/text/html.ts`.
static FOOTNOTE_ID: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,3}:[0-9]{1,3}:\p{Nd}{1,4}$").ok());

/// Pass 1: the policy plus `h1` and verse-reference `href`s (normalised by [`parse_ref`]), so the rewrite sees
/// well-formed markup.
static NORMALIZE: LazyLock<Builder<'static>> = LazyLock::new(|| {
    let mut tags: HashSet<&'static str> = ALLOWED_TAGS.into_iter().collect();
    tags.insert("h1");
    let mut b = base_builder(tags);
    b.url_relative(UrlRelative::PassThrough);
    b.attribute_filter(|element, attribute, value| match (element, attribute) {
        ("a", "href" | "data-ref") => parse_ref(value).map(Cow::Owned),
        ("sup", "data-fn") => footnote_id(value),
        _ => Some(Cow::Borrowed(value)),
    });
    b
});

/// Pass 2: exactly the final policy.
static POLICY: LazyLock<Builder<'static>> = LazyLock::new(|| {
    let mut b = base_builder(ALLOWED_TAGS.into_iter().collect());
    b.url_relative(UrlRelative::Deny);
    b.attribute_filter(|element, attribute, value| match (element, attribute) {
        ("a", "data-ref") => parse_ref(value).map(Cow::Owned),
        ("sup", "data-fn") => footnote_id(value),
        _ => Some(Cow::Borrowed(value)),
    });
    b
});

/// What both passes share: no generic attributes, no `rel` on links, no URL schemes, comments stripped; `a` keeps
/// `href` and `data-ref` (pass 1, so sanitising is idempotent) or `data-ref` (pass 2), `sup` keeps `data-fn`.
fn base_builder(tags: HashSet<&'static str>) -> Builder<'static> {
    let pass_one = tags.contains("h1");
    let mut b = Builder::empty();
    b.tags(tags)
        .clean_content_tags(DROP_CONTENT_TAGS.into_iter().collect())
        .generic_attributes(HashSet::new())
        .generic_attribute_prefixes(HashSet::new())
        .url_schemes(HashSet::new())
        .link_rel(None)
        .strip_comments(true)
        .id_prefix(None)
        .allowed_classes(
            ALLOWED_CLASSES
                .into_iter()
                .map(|(tag, classes)| (tag, classes.iter().copied().collect()))
                .collect(),
        )
        .tag_attributes(HashMap::from([
            (
                "a",
                if pass_one {
                    HashSet::from(["href", "data-ref"])
                } else {
                    HashSet::from(["data-ref"])
                },
            ),
            ("sup", HashSet::from(["data-fn"])),
        ]));
    b
}

/// Sanitises upstream HTML with the §2.5.6 policy (module docs). Never fails: anything outside the policy is dropped or
/// unwrapped.
#[must_use]
pub fn sanitize(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    let normalized = NORMALIZE.clean(html).to_string();
    let rewritten = rewrite(&normalized);
    POLICY.clean(&rewritten).to_string()
}

/// A verse reference as `data-ref` wants it: `"s:a"` or `"s:a-b"` from `^/?\d{1,3}:\d{1,3}(-\d{1,3})?$`, leading zeros
/// dropped, the surah 1..=114 and the ayah (range) inside it; `"s:a-a"` becomes `"s:a"`. `None` for anything else.
#[must_use]
pub fn parse_ref(href: &str) -> Option<String> {
    let s = href.trim();
    let s = s.strip_prefix('/').unwrap_or(s);
    let (surah, rest) = s.split_once(':')?;
    let (from, to) = match rest.split_once('-') {
        Some((from, to)) => (from, Some(to)),
        None => (rest, None),
    };
    let surah = small_number(surah)?;
    let from = small_number(from)?;
    let to = match to {
        Some(t) => Some(small_number(t)?),
        None => None,
    };
    let count = surah_ayah_count(surah).filter(|_| surah <= SURAH_COUNT)?;
    if !(1..=count).contains(&from) {
        return None;
    }
    match to {
        None => Some(format!("{surah}:{from}")),
        Some(to) if to == from => Some(format!("{surah}:{from}")),
        Some(to) if to > from && to <= count => Some(format!("{surah}:{from}-{to}")),
        Some(_) => None,
    }
}

/// 1–3 ASCII digits.
fn small_number(s: &str) -> Option<u32> {
    if (1..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// Whether `id` is a valid `data-fn` value (`s:a:n`, the marker in any decimal digits).
#[must_use]
pub fn is_footnote_id(id: &str) -> bool {
    FOOTNOTE_ID.as_ref().is_some_and(|re| re.is_match(id))
}

fn footnote_id(value: &str) -> Option<Cow<'_, str>> {
    let v = value.trim();
    is_footnote_id(v).then_some(Cow::Borrowed(v))
}

/// Escapes text for an HTML text node or a double-quoted attribute.
#[must_use]
pub fn escape(text: &str) -> Cow<'_, str> {
    if !text.contains(['&', '<', '>', '"']) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 16);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// The visible text of (sanitised) HTML for the `plain` column: tags stripped, footnote markers (`sup.fn`) and
/// `script`/`style` content removed, entities decoded, runs of whitespace collapsed to one space, and one line per block
/// (`p`, `br`, `li`, headings, …) with blank lines dropped.
#[must_use]
pub fn plain_text(html: &str) -> String {
    let mut raw = String::with_capacity(html.len());
    // Depth inside a skipped element (`sup.fn`, `script`, `style`) and its tag name.
    let mut skip: Option<(String, u32)> = None;
    for token in Tokens::new(html) {
        match token {
            Token::Text(t) => {
                if skip.is_none() {
                    // Source line breaks are spaces in HTML; only block boundaries end a line.
                    raw.extend(decode_entities(t).chars().map(|c| match c {
                        '\n' | '\r' => ' ',
                        c => c,
                    }));
                }
            }
            Token::Start {
                name,
                attrs,
                self_closing,
            } => {
                let name = name.to_ascii_lowercase();
                if let Some((skipped, depth)) = &mut skip {
                    if *skipped == name && !self_closing {
                        *depth = depth.saturating_add(1);
                    }
                    continue;
                }
                let is_marker = name == "sup"
                    && attrs.iter().any(|(k, v)| {
                        k.eq_ignore_ascii_case("class")
                            && v.split_ascii_whitespace().any(|c| c == "fn")
                    });
                if (is_marker || DROP_CONTENT_TAGS.contains(&name.as_str())) && !self_closing {
                    skip = Some((name, 1));
                } else if BLOCK_TAGS.contains(&name.as_str()) {
                    raw.push('\n');
                }
            }
            Token::End { name } => {
                let name = name.to_ascii_lowercase();
                if let Some((skipped, depth)) = &mut skip {
                    if *skipped == name {
                        *depth = depth.saturating_sub(1);
                        if *depth == 0 {
                            skip = None;
                        }
                    }
                    continue;
                }
                if BLOCK_TAGS.contains(&name.as_str()) {
                    raw.push('\n');
                }
            }
            Token::Other => {}
        }
    }
    collapse_whitespace(&raw)
}

/// One space between words, one line break between blocks, no blank lines, no leading/trailing whitespace.
fn collapse_whitespace(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for line in raw.split('\n') {
        let mut words = line.split_whitespace().peekable();
        if words.peek().is_none() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        let mut first = true;
        for w in words {
            if !first {
                out.push(' ');
            }
            out.push_str(w);
            first = false;
        }
    }
    out
}

/// Decodes the character references html5ever's serialiser emits (`&amp; &lt; &gt; &quot; &nbsp;`), plus `&apos;`,
/// `&#39;` and other numeric references. Unknown references stay as written. A no-break space becomes a plain space.
#[must_use]
pub fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') && !s.contains('\u{a0}') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        let (before, after) = rest.split_at(i);
        out.push_str(before);
        let decoded = after.find(';').filter(|&end| end <= 12).and_then(|end| {
            let name = after.get(1..end)?;
            let c = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                "nbsp" => ' ',
                _ => {
                    let num = name.strip_prefix('#')?;
                    let code = match num.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => num.parse::<u32>().ok()?,
                    };
                    char::from_u32(code)?
                }
            };
            Some((c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = after.get(end.saturating_add(1)..).unwrap_or("");
            }
            None => {
                out.push('&');
                rest = after.get(1..).unwrap_or("");
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out.replace('\u{a0}', " "))
}

// ---------------------------------------------------------------------------------------------------------------
// The rewrite between the passes
// ---------------------------------------------------------------------------------------------------------------

/// Rewrites pass-1 output: `a[data-ref]` or `a[href]` → `a[data-ref]`, other `a` unwrapped, `h1` → `h2`, empty
/// `class` dropped. Every start tag is re-emitted from its parsed attributes (values stay escaped and double-quoted).
fn rewrite(html: &str) -> String {
    let mut out = String::with_capacity(html.len().saturating_add(32));
    // One entry per open `a`: whether it was kept.
    let mut links: Vec<bool> = Vec::new();
    for token in Tokens::new(html) {
        match token {
            Token::Text(t) => out.push_str(t),
            Token::Start {
                name,
                attrs,
                self_closing: _,
            } => {
                let lower = name.to_ascii_lowercase();
                let (name, attrs): (&str, Vec<(&str, &str)>) = match lower.as_str() {
                    "a" => {
                        let target = |name: &str| {
                            attrs
                                .iter()
                                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                                .and_then(|(_, v)| parse_ref(v))
                        };
                        match target("data-ref").or_else(|| target("href")) {
                            Some(r) => {
                                links.push(true);
                                out.push_str("<a data-ref=\"");
                                out.push_str(&r);
                                out.push_str("\">");
                            }
                            None => links.push(false),
                        }
                        continue;
                    }
                    "h1" => ("h2", attrs),
                    _ => (name, attrs),
                };
                out.push('<');
                out.push_str(name);
                for (k, v) in attrs {
                    if k.eq_ignore_ascii_case("class") && v.trim().is_empty() {
                        continue;
                    }
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    out.push_str(v);
                    out.push('"');
                }
                out.push('>');
            }
            Token::End { name } => {
                let lower = name.to_ascii_lowercase();
                match lower.as_str() {
                    "a" => {
                        if links.pop() == Some(true) {
                            out.push_str("</a>");
                        }
                    }
                    "h1" => out.push_str("</h2>"),
                    _ => {
                        out.push_str("</");
                        out.push_str(name);
                        out.push('>');
                    }
                }
            }
            Token::Other => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// A minimal tokenizer for html5ever's serialised output
// ---------------------------------------------------------------------------------------------------------------

/// One piece of serialised HTML. Attribute values are returned as written (still escaped).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token<'a> {
    Text(&'a str),
    Start {
        name: &'a str,
        attrs: Vec<(&'a str, &'a str)>,
        self_closing: bool,
    },
    End {
        name: &'a str,
    },
    /// A comment, doctype or processing instruction (never in sanitised output).
    Other,
}

/// Splits HTML into text and tags. Built for html5ever's serialisation (quoted attribute values, `<` escaped in text),
/// it never panics on other input: a `<` that does not open a complete tag is text.
struct Tokens<'a> {
    rest: &'a str,
}

impl<'a> Tokens<'a> {
    const fn new(html: &'a str) -> Self {
        Self { rest: html }
    }

    /// The tag starting at `self.rest` (which begins with `<`), and the input after it.
    fn tag(&self) -> Option<(Token<'a>, &'a str)> {
        let s = self.rest;
        let body = s.get(1..)?;
        if let Some(after) = body.strip_prefix('/') {
            let end = after.find('>')?;
            let name = after.get(..end)?.trim();
            if !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
                return None;
            }
            return Some((Token::End { name }, after.get(end.saturating_add(1)..)?));
        }
        if body.starts_with(['!', '?']) {
            let end = body.find('>')?;
            return Some((Token::Other, body.get(end.saturating_add(1)..)?));
        }
        if !body.starts_with(|c: char| c.is_ascii_alphabetic()) {
            return None;
        }
        let name_len = body
            .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
            .unwrap_or(body.len());
        let name = body.get(..name_len)?;
        let mut rest = body.get(name_len..)?;
        let mut attrs = Vec::new();
        loop {
            rest = rest.trim_start();
            if let Some(after) = rest.strip_prefix('>') {
                return Some((
                    Token::Start {
                        name,
                        attrs,
                        self_closing: false,
                    },
                    after,
                ));
            }
            if let Some(after) = rest.strip_prefix("/>") {
                return Some((
                    Token::Start {
                        name,
                        attrs,
                        self_closing: true,
                    },
                    after,
                ));
            }
            if let Some(after) = rest.strip_prefix('/') {
                rest = after;
                continue;
            }
            if rest.is_empty() {
                return None;
            }
            let key_len = rest
                .find(|c: char| c.is_ascii_whitespace() || c == '=' || c == '>' || c == '/')
                .unwrap_or(rest.len());
            let key = rest.get(..key_len)?;
            rest = rest.get(key_len..)?.trim_start();
            let Some(after_eq) = rest.strip_prefix('=') else {
                attrs.push((key, ""));
                continue;
            };
            let after_eq = after_eq.trim_start();
            let (value, after_value) = if let Some(q) = after_eq.strip_prefix('"') {
                let end = q.find('"')?;
                (q.get(..end)?, q.get(end.saturating_add(1)..)?)
            } else if let Some(q) = after_eq.strip_prefix('\'') {
                let end = q.find('\'')?;
                (q.get(..end)?, q.get(end.saturating_add(1)..)?)
            } else {
                let end = after_eq
                    .find(|c: char| c.is_ascii_whitespace() || c == '>')
                    .unwrap_or(after_eq.len());
                (after_eq.get(..end)?, after_eq.get(end..)?)
            };
            if key.is_empty() {
                // A stray `=`: skip the value.
                rest = after_value;
                continue;
            }
            attrs.push((key, value));
            rest = after_value;
        }
    }
}

impl<'a> Iterator for Tokens<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        if self.rest.is_empty() {
            return None;
        }
        if let Some(after) = self.rest.strip_prefix('<') {
            if let Some((token, rest)) = self.tag() {
                self.rest = rest;
                return Some(token);
            }
            // Not a tag: a literal `<` (pass-1 output never has one; other input may).
            let text = self.rest.get(..1).unwrap_or("<");
            self.rest = after;
            return Some(Token::Text(text));
        }
        // `rest` does not start with `<`, so the text is never empty.
        let end = self.rest.find('<').unwrap_or(self.rest.len());
        let text = self.rest.get(..end).unwrap_or(self.rest);
        self.rest = self.rest.get(end..).unwrap_or("");
        Some(Token::Text(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regexes_compile() {
        assert!(FOOTNOTE_ID.is_some());
    }

    #[test]
    fn tokenizer_handles_serialised_and_odd_input() {
        let toks: Vec<Token<'_>> =
            Tokens::new(r#"a<p class="x y">b &amp; c</p><br><a href="2:255">r</a>"#).collect();
        assert_eq!(
            toks,
            [
                Token::Text("a"),
                Token::Start {
                    name: "p",
                    attrs: vec![("class", "x y")],
                    self_closing: false
                },
                Token::Text("b &amp; c"),
                Token::End { name: "p" },
                Token::Start {
                    name: "br",
                    attrs: vec![],
                    self_closing: false
                },
                Token::Start {
                    name: "a",
                    attrs: vec![("href", "2:255")],
                    self_closing: false
                },
                Token::Text("r"),
                Token::End { name: "a" },
            ]
        );
        // Never panics, whatever the input.
        for odd in [
            "<",
            "<<",
            "< p>",
            "<p",
            "<p class=\"x",
            "</",
            "</>",
            "<!--",
            "<a =x>",
            "<a b='c' d=e/>t",
            "x<y z",
            "\u{a0}<p>é</p>",
        ] {
            let _ = Tokens::new(odd).count();
            let _ = rewrite(odd);
            let _ = plain_text(odd);
        }
    }

    #[test]
    fn rewrite_turns_links_and_headings() {
        assert_eq!(
            rewrite(r#"<a href="2:255">x</a> <a>y</a> <h1>T</h1><span class="">z</span>"#),
            r#"<a data-ref="2:255">x</a> y <h2>T</h2><span>z</span>"#
        );
    }

    #[test]
    fn entities_decode() {
        assert_eq!(
            decode_entities("a &amp; b &lt;c&gt; &quot;&#39;&#x41;&nbsp;&bogus; &"),
            "a & b <c> \"'A &bogus; &"
        );
        assert_eq!(decode_entities("plain"), "plain");
    }
}
