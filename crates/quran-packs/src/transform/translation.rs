//! QuranEnc `translations(id, sura, aya, translation, footnotes)` → pack DB rows.
//!
//! [`read_rows`] validates an export (the table with that column set, exactly 6,236 rows, every `(sura, aya)` a real
//! ayah exactly once); [`transform_row`] turns one row into an entry and its footnotes; [`build_pack_db`] runs both
//! into a [`PackDbWriter`].
//!
//! QuranEnc exports differ per translation (measured on 14 exports, 2026-10-10), so each rule is data-driven:
//! - **Number prefix.** `(n) ` (Saheeh) or `n. ` (Hilali-Khan, García) is stripped when `n` is the row's ayah number;
//!   any other leading number is content and stays.
//! - **Markup.** Text and footnotes are HTML fragments (Zakaria's Bengali uses `<b>`; stray `>` occur) and go through
//!   [`sanitize`]. Line breaks become `<br>`.
//! - **Bracket footnotes** (most exports). Markers `[n]` (`\p{Nd}`, so `[১]` too) in the text become
//!   `<sup class="fn" data-fn="{s}:{a}:{n}">{n}</sup>`, the marker keeping its source digits. A footnote starts at a
//!   line beginning with `[n]` (optionally `-`, as in `[2]- …`, and after leading spaces, as in Rowwad), or mid-line at
//!   ` [n]` when `n` is referenced in the text and not yet defined (Rowwad puts several notes on one line). Other lines
//!   continue the current footnote (Hilali-Khan's numbered lists, Zakaria's paragraphs).
//! - **Parenthesis footnotes** (Indonesian Affairs): no `[n]` anywhere, notes start with `*n)` or `n)`, and the text
//!   marks them `…pembalasan.1)`. Text markers become `sup.fn` only for numbers this row defines, never after `(` or
//!   another digit, so `(5)` and `416)` of another row stay text.
//! - **Preamble.** Footnote text before the first note (Zakaria's surah introductions) is kept as a general note with
//!   id `{s}:{a}:0` and an empty marker.
//! - A note number defined twice in one row is merged into one footnote; empty notes are dropped.
//!
//! `plain` is [`plain_text`] of the sanitised entry (markers removed); `fold` is derived by the writer from the pack's
//! tokenizer. Tafsir exports use the same rules, one entry per ayah (`to_ayah_id = ayah_id`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use quran_core::content_db::geometry::{surah_ayah_count, surah_ayah_ids};
use quran_core::{FootnoteInput, PackDbWriter, PackEntryInput, PackMeta, PackStats};
use quran_types::AYAH_COUNT;
use regex::{Captures, Regex};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use super::html::{plain_text, sanitize};
use crate::PackError;

/// The QuranEnc table.
pub const TABLE: &str = "translations";
/// Its columns. Extra columns are tolerated and ignored.
pub const REQUIRED_COLUMNS: [&str; 5] = ["id", "sura", "aya", "translation", "footnotes"];
/// Rows between cancel checks while building.
const CHECK_EVERY: usize = 256;

/// `[n]` in the text.
static BRACKET_MARKER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\[(\p{Nd}{1,4})\]").ok());
/// A footnote line starting with `[n]`, `[n]-` or ` [n] `.
static BRACKET_DEF_START: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*\[(\p{Nd}{1,4})\]\s*[-–—]?\s*").ok());
/// ` [n] ` inside a footnote line (a further note on the same line).
static BRACKET_DEF_INLINE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\s\[(\p{Nd}{1,4})\]\s*[-–—]?\s*").ok());
/// A footnote line starting with `*n)` or `n)`.
static PAREN_DEF_START: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*\*?(\p{Nd}{1,4})\)\s*").ok());
/// ` *n) ` inside a footnote line.
static PAREN_DEF_INLINE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\s\*(\p{Nd}{1,4})\)\s*").ok());
/// `n)` in the text (the preceding character is checked separately: the regex crate has no look-behind).
static PAREN_MARKER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(\p{Nd}{1,4})\)").ok());
/// `(n) ` or `n. ` at the start of the text.
static NUMBER_PREFIX: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*(?:\((\p{Nd}{1,4})\)\s*|(\p{Nd}{1,4})\.\s+)").ok());
/// One decimal digit of any script.
static DECIMAL_DIGIT: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^\p{Nd}$").ok());

fn re(cell: &'static LazyLock<Option<Regex>>) -> Result<&'static Regex, PackError> {
    cell.as_ref()
        .ok_or_else(|| PackError::Integrity("internal: a QuranEnc pattern did not compile".into()))
}

/// One validated row of an export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRow {
    pub sura: u32,
    pub aya: u32,
    /// `NULL` reads as empty.
    pub translation: String,
    /// `NULL` reads as empty.
    pub footnotes: String,
}

impl SourceRow {
    /// The canonical ayah id of `(sura, aya)`.
    #[must_use]
    pub fn ayah_id(&self) -> Option<u32> {
        ayah_id(self.sura, self.aya)
    }
}

/// The canonical ayah id of `(sura, aya)`, `None` outside the Hafs count.
#[must_use]
pub fn ayah_id(sura: u32, aya: u32) -> Option<u32> {
    let ids = surah_ayah_ids(sura)?;
    let count = surah_ayah_count(sura)?;
    (1..=count)
        .contains(&aya)
        .then(|| ids.start().saturating_add(aya - 1))
}

/// One row, ready for the writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformedRow {
    pub entry: PackEntryInput,
    pub footnotes: Vec<FootnoteInput>,
}

/// Reads and validates the `translations` table: the five columns exist, there are exactly [`AYAH_COUNT`] rows, and
/// every `(sura, aya)` is a real ayah, exactly once (so every ayah is covered). Numbers stored as text or integral reals
/// are accepted; `NULL` text is empty. Rows come back in ayah order.
pub fn read_rows(conn: &Connection) -> Result<Vec<SourceRow>, PackError> {
    let columns: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info(?1)")
            .map_err(sql("read the table schema"))?;
        stmt.query_map([TABLE], |r| r.get::<_, String>(0))
            .map_err(sql("read the table schema"))?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql("read the table schema"))?
    };
    if columns.is_empty() {
        return Err(PackError::Integrity(format!(
            "the export has no `{TABLE}` table"
        )));
    }
    let missing: Vec<&str> = REQUIRED_COLUMNS
        .into_iter()
        .filter(|c| !columns.iter().any(|have| have.eq_ignore_ascii_case(c)))
        .collect();
    if !missing.is_empty() {
        return Err(PackError::Integrity(format!(
            "`{TABLE}` lacks column(s) {}",
            missing.join(", ")
        )));
    }
    let count: i64 = conn
        .query_row(&format!("SELECT count(*) FROM {TABLE}"), [], |r| r.get(0))
        .map_err(sql("count rows"))?;
    if count != i64::from(AYAH_COUNT) {
        return Err(PackError::Integrity(format!(
            "`{TABLE}` has {count} rows, expected {AYAH_COUNT}"
        )));
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT sura, aya, translation, footnotes FROM {TABLE}"
        ))
        .map_err(sql("read rows"))?;
    let mut rows = stmt.query([]).map_err(sql("read rows"))?;
    let mut seen = vec![false; usize::try_from(AYAH_COUNT).unwrap_or(0)];
    let mut out: Vec<(u32, SourceRow)> = Vec::with_capacity(seen.len());
    while let Some(r) = rows.next().map_err(sql("read rows"))? {
        let sura = number(r.get_ref(0).map_err(sql("read sura"))?, "sura")?;
        let aya = number(r.get_ref(1).map_err(sql("read aya"))?, "aya")?;
        let id = ayah_id(sura, aya).ok_or_else(|| {
            PackError::Integrity(format!("row {sura}:{aya} is not an ayah of the Hafs count"))
        })?;
        let slot = usize::try_from(id.saturating_sub(1))
            .ok()
            .and_then(|i| seen.get_mut(i))
            .ok_or_else(|| PackError::Integrity(format!("ayah id {id} out of range")))?;
        if *slot {
            return Err(PackError::Integrity(format!(
                "ayah {sura}:{aya} appears twice"
            )));
        }
        *slot = true;
        out.push((
            id,
            SourceRow {
                sura,
                aya,
                translation: text(
                    r.get_ref(2).map_err(sql("read translation"))?,
                    "translation",
                )?,
                footnotes: text(r.get_ref(3).map_err(sql("read footnotes"))?, "footnotes")?,
            },
        ));
    }
    if out.len() != seen.len() {
        return Err(PackError::Integrity(format!(
            "`{TABLE}` yielded {} rows, expected {AYAH_COUNT}",
            out.len()
        )));
    }
    out.sort_by_key(|(id, _)| *id);
    Ok(out.into_iter().map(|(_, row)| row).collect())
}

fn sql(what: &'static str) -> impl Fn(rusqlite::Error) -> PackError {
    move |e| PackError::Integrity(format!("QuranEnc export: cannot {what}: {e}"))
}

/// An integer column value: INTEGER, TEXT digits or an integral REAL.
fn number(v: ValueRef<'_>, column: &str) -> Result<u32, PackError> {
    let bad = || PackError::Integrity(format!("`{column}` holds a non-numeric value"));
    match v {
        ValueRef::Integer(i) => u32::try_from(i).map_err(|_| bad()),
        ValueRef::Text(t) => std::str::from_utf8(t)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .ok_or_else(bad),
        ValueRef::Real(f) => {
            if f.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&f) {
                format!("{f:.0}").parse::<u32>().map_err(|_| bad())
            } else {
                Err(bad())
            }
        }
        ValueRef::Null | ValueRef::Blob(_) => Err(bad()),
    }
}

/// A text column value; `NULL` is empty, numbers are written out, invalid UTF-8 is replaced.
fn text(v: ValueRef<'_>, column: &str) -> Result<String, PackError> {
    match v {
        ValueRef::Text(t) => Ok(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Null => Ok(String::new()),
        ValueRef::Integer(i) => Ok(i.to_string()),
        ValueRef::Real(f) => Ok(f.to_string()),
        ValueRef::Blob(_) => Err(PackError::Integrity(format!(
            "`{column}` holds binary data"
        ))),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------------------------------------------

/// How a row marks its footnotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    /// `[n]` in the text and at the start of each note.
    Bracket,
    /// `n)` in the text, `*n)` / `n)` at the start of each note.
    Paren,
}

/// One parsed note: its marker (source digits) and lines.
#[derive(Debug, Default)]
struct Note {
    marker: String,
    lines: Vec<String>,
}

/// Transforms one row (module docs). `ayah_id` is the row's canonical id.
pub fn transform_row(row: &SourceRow, ayah_id: u32) -> Result<TransformedRow, PackError> {
    let text = strip_number_prefix(&row.translation, row.aya)?;
    let bracket_refs: HashSet<String> = re(&BRACKET_MARKER)?
        .captures_iter(text)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_owned()))
        .collect();
    let bracket_start = re(&BRACKET_DEF_START)?;
    let paren_start = re(&PAREN_DEF_START)?;
    let style =
        if !bracket_refs.is_empty() || row.footnotes.lines().any(|l| bracket_start.is_match(l)) {
            Style::Bracket
        } else if row.footnotes.lines().any(|l| paren_start.is_match(l)) {
            Style::Paren
        } else {
            Style::Bracket
        };
    let (preamble, notes) = parse_notes(&row.footnotes, style, &bracket_refs)?;

    let (s, a) = (row.sura, row.aya);
    let marker_html = |n: &str| format!(r#"<sup class="fn" data-fn="{s}:{a}:{n}">{n}</sup>"#);
    let marked = match style {
        Style::Bracket => re(&BRACKET_MARKER)?
            .replace_all(text, |c: &Captures<'_>| {
                c.get(1)
                    .map_or_else(String::new, |n| marker_html(n.as_str()))
            })
            .into_owned(),
        Style::Paren => {
            let defined: HashSet<&str> = notes.iter().map(|n| n.marker.as_str()).collect();
            replace_paren_markers(text, &defined, &marker_html)?
        }
    };
    let html = sanitize(&join_lines(marked.lines()));
    let plain = plain_text(&html);

    let mut footnotes = Vec::with_capacity(notes.len().saturating_add(1));
    let preamble_html = sanitize(&join_lines(preamble.iter().map(String::as_str)));
    if !preamble_html.trim().is_empty() {
        footnotes.push(FootnoteInput {
            id: format!("{s}:{a}:0"),
            ayah_id,
            marker: String::new(),
            html: preamble_html,
        });
    }
    for note in notes {
        let html = sanitize(&join_lines(note.lines.iter().map(String::as_str)));
        if html.trim().is_empty() {
            continue;
        }
        let id = format!("{s}:{a}:{}", note.marker);
        match footnotes.iter_mut().find(|f| f.id == id) {
            // `[0]` next to a preamble: one footnote.
            Some(existing) => {
                existing.html.push_str("<br>");
                existing.html.push_str(&html);
            }
            None => footnotes.push(FootnoteInput {
                id,
                ayah_id,
                marker: note.marker,
                html,
            }),
        }
    }
    Ok(TransformedRow {
        entry: PackEntryInput {
            ayah_id,
            to_ayah_id: ayah_id,
            html,
            plain,
        },
        footnotes,
    })
}

/// Splits footnote text into the preamble and the notes (module docs).
fn parse_notes(
    footnotes: &str,
    style: Style,
    text_refs: &HashSet<String>,
) -> Result<(Vec<String>, Vec<Note>), PackError> {
    let (start, inline) = match style {
        Style::Bracket => (re(&BRACKET_DEF_START)?, re(&BRACKET_DEF_INLINE)?),
        Style::Paren => (re(&PAREN_DEF_START)?, re(&PAREN_DEF_INLINE)?),
    };
    let mut preamble: Vec<String> = Vec::new();
    let mut notes: Vec<Note> = Vec::new();
    // The note receiving lines.
    let mut current: Option<usize> = None;
    for line in footnotes.lines() {
        let mut body = line;
        if let Some(c) = start.captures(line)
            && let (Some(all), Some(n)) = (c.get(0), c.get(1))
        {
            current = Some(open_note(&mut notes, n.as_str()));
            body = line.get(all.end()..).unwrap_or("");
        }
        // Further notes on the same line.
        loop {
            let split = inline.captures_iter(body).find_map(|c| {
                let (all, n) = (c.get(0)?, c.get(1)?);
                let n = n.as_str();
                let known = notes.iter().any(|note| note.marker == n);
                let referenced = style == Style::Paren || text_refs.contains(n);
                (!known && referenced).then(|| (all.start(), all.end(), n.to_owned()))
            });
            let Some((from, to, n)) = split else {
                break;
            };
            push_line(
                &mut notes,
                current,
                &mut preamble,
                body.get(..from).unwrap_or(""),
            );
            current = Some(open_note(&mut notes, &n));
            body = body.get(to..).unwrap_or("");
        }
        push_line(&mut notes, current, &mut preamble, body);
    }
    Ok((preamble, notes))
}

/// The index of the note `marker`, created when new (a number defined twice continues the first note).
fn open_note(notes: &mut Vec<Note>, marker: &str) -> usize {
    if let Some(i) = notes.iter().position(|n| n.marker == marker) {
        return i;
    }
    notes.push(Note {
        marker: marker.to_owned(),
        lines: Vec::new(),
    });
    notes.len().saturating_sub(1)
}

fn push_line(notes: &mut [Note], current: Option<usize>, preamble: &mut Vec<String>, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    match current.and_then(|i| notes.get_mut(i)) {
        Some(note) => note.lines.push(line.to_owned()),
        None => preamble.push(line.to_owned()),
    }
}

/// Non-empty lines, trimmed, joined with `<br>`.
fn join_lines<'a>(lines: impl Iterator<Item = &'a str>) -> String {
    lines
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("<br>")
}

/// `n)` → marker for the numbers in `defined`, unless preceded by `(` or a digit.
fn replace_paren_markers(
    text: &str,
    defined: &HashSet<&str>,
    marker_html: &dyn Fn(&str) -> String,
) -> Result<String, PackError> {
    let mut out = String::with_capacity(text.len().saturating_add(64));
    let mut last = 0usize;
    for c in re(&PAREN_MARKER)?.captures_iter(text) {
        let (Some(all), Some(n)) = (c.get(0), c.get(1)) else {
            continue;
        };
        let before = text.get(..all.start()).and_then(|b| b.chars().next_back());
        let attached = before.is_none_or(|ch| ch != '(' && !is_decimal_digit(ch));
        if !attached || !defined.contains(n.as_str()) {
            continue;
        }
        out.push_str(text.get(last..all.start()).unwrap_or(""));
        out.push_str(&marker_html(n.as_str()));
        last = all.end();
    }
    out.push_str(text.get(last..).unwrap_or(""));
    Ok(out)
}

/// Strips a leading `(n) ` or `n. ` when `n` is the ayah number.
fn strip_number_prefix(text: &str, aya: u32) -> Result<&str, PackError> {
    let Some(c) = re(&NUMBER_PREFIX)?.captures(text) else {
        return Ok(text);
    };
    let (Some(all), Some(n)) = (c.get(0), c.get(1).or_else(|| c.get(2))) else {
        return Ok(text);
    };
    if decimal_value(n.as_str()) == Some(aya) {
        Ok(text.get(all.end()..).unwrap_or(""))
    } else {
        Ok(text)
    }
}

fn is_decimal_digit(c: char) -> bool {
    if c.is_ascii_digit() {
        return true;
    }
    if c.is_ascii() {
        return false;
    }
    let mut buf = [0u8; 4];
    DECIMAL_DIGIT
        .as_ref()
        .is_some_and(|re| re.is_match(c.encode_utf8(&mut buf)))
}

/// The value of one decimal digit of any script. Unicode decimal digits come in runs of ten starting at zero, so the
/// value is the distance to the start of the run, modulo ten (runs of several sets, as in the mathematical digits, stay
/// aligned).
fn digit_value(c: char) -> Option<u32> {
    if let Some(d) = c.to_digit(10) {
        return Some(d);
    }
    if !is_decimal_digit(c) {
        return None;
    }
    let mut code = u32::from(c);
    let mut offset = 0u32;
    while offset < 100 {
        let Some(prev) = code.checked_sub(1).and_then(char::from_u32) else {
            break;
        };
        if !is_decimal_digit(prev) {
            break;
        }
        code = u32::from(prev);
        offset = offset.saturating_add(1);
    }
    Some(offset % 10)
}

/// The value of a run of decimal digits of one script (`"২৫৫"` → 255).
fn decimal_value(s: &str) -> Option<u32> {
    if s.is_empty() {
        return None;
    }
    s.chars().try_fold(0u32, |acc, c| {
        acc.checked_mul(10)?.checked_add(digit_value(c)?)
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The whole export
// ---------------------------------------------------------------------------------------------------------------

/// Builds `dest` (a pack DB) from the QuranEnc SQLite file `source`: opens it read-only, checks it (`quick_check` and
/// [`read_rows`]), transforms every row into a [`PackDbWriter`] created with `meta`, records `source_sha256` and
/// finishes the file. `check` runs every few hundred rows; its error (a cancel) aborts the build. Blocking: call from
/// `spawn_blocking`.
pub fn build_pack_db(
    source: &Path,
    dest: &Path,
    meta: &PackMeta,
    source_sha256: &str,
    check: &dyn Fn() -> Result<(), PackError>,
) -> Result<PackStats, PackError> {
    let rows = {
        let unreadable = |e: rusqlite::Error| {
            PackError::Integrity(format!(
                "QuranEnc export is not a readable SQLite file: {e}"
            ))
        };
        let conn = Connection::open_with_flags(
            source,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(unreadable)?;
        let verdict: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(unreadable)?;
        if verdict != "ok" {
            return Err(PackError::Integrity(format!(
                "QuranEnc export is damaged: {verdict}"
            )));
        }
        read_rows(&conn)?
    };
    check()?;
    let mut writer = PackDbWriter::create(dest, meta)?;
    writer.set_source_sha256(source_sha256)?;
    let mut footnotes = 0usize;
    for (i, row) in rows.iter().enumerate() {
        if i % CHECK_EVERY == 0 {
            check()?;
        }
        let id = row.ayah_id().ok_or_else(|| {
            PackError::Integrity(format!("row {}:{} is not an ayah", row.sura, row.aya))
        })?;
        let t = transform_row(row, id)?;
        writer.entry(&t.entry)?;
        for f in &t.footnotes {
            writer.footnote(f)?;
        }
        footnotes = footnotes.saturating_add(t.footnotes.len());
    }
    check()?;
    let stats = writer.finish()?;
    if stats.entries != AYAH_COUNT {
        return Err(PackError::Integrity(format!(
            "the built pack has {} entries, expected {AYAH_COUNT}",
            stats.entries
        )));
    }
    log::debug!(
        "{}: built {} entries and {footnotes} footnotes ({} bytes)",
        meta.pack_id,
        stats.entries,
        stats.bytes
    );
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for cell in [
            &BRACKET_MARKER,
            &BRACKET_DEF_START,
            &BRACKET_DEF_INLINE,
            &PAREN_DEF_START,
            &PAREN_DEF_INLINE,
            &PAREN_MARKER,
            &NUMBER_PREFIX,
            &DECIMAL_DIGIT,
        ] {
            assert!(cell.is_some());
        }
    }

    #[test]
    fn digits_of_any_script() {
        assert_eq!(decimal_value("255"), Some(255));
        assert_eq!(decimal_value("২৫৫"), Some(255), "Bengali");
        assert_eq!(decimal_value("٢٥٥"), Some(255), "Arabic-Indic");
        assert_eq!(decimal_value("۲۵۵"), Some(255), "Extended Arabic-Indic");
        assert_eq!(decimal_value("२५५"), Some(255), "Devanagari");
        assert_eq!(decimal_value("𝟐𝟓𝟓"), Some(255), "mathematical bold");
        assert_eq!(decimal_value("𝟸𝟻𝟻"), Some(255), "mathematical monospace");
        assert_eq!(decimal_value(""), None);
        assert_eq!(decimal_value("1a"), None);
        assert_eq!(decimal_value("½"), None);
        assert!(!is_decimal_digit('a') && !is_decimal_digit('Ⅳ'));
    }

    #[test]
    fn ayah_ids() {
        assert_eq!(ayah_id(1, 1), Some(1));
        assert_eq!(ayah_id(2, 255), Some(262));
        assert_eq!(ayah_id(114, 6), Some(6236));
        assert_eq!(ayah_id(1, 8), None);
        assert_eq!(ayah_id(0, 1), None);
        assert_eq!(ayah_id(115, 1), None);
        assert_eq!(ayah_id(2, 0), None);
    }
}
