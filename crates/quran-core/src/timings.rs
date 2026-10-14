//! Recitation timing model and the QDC sanitiser.
//!
//! A [`StoredTimings`] ties one exact audio file ([`TimingFile`]: `audio_url` + HTTP `Content-Length`) to its ayah and
//! word segments on that file's timeline. Timings come from QDC's
//! `GET /api/qdc/audio/reciters/{id}/audio_files?chapter={n}&segments=true`, whose data is known to be messy: numbers
//! as strings or floats, malformed segments (`[1]`), negative verse durations, word segments that start before their
//! ayah, positions that repeat or go backwards (waqf/ibtida repeats), junk rows with a null `chapter_id`, and whole
//! reciters with ayah-level timings only (`segments: []`). [`sanitize_qdc`] turns one `audio_files[]` element into a
//! timeline the audio engine can trust; [`qdc_file_info`] reads the file-level fields with the same tolerance.
//!
//! The active word is always chosen **by time** (words are sorted by `start_ms`), never by position.

use quran_types::{AyahTiming, SURAH_COUNT, SurahTimings, WordTiming};
use serde_json::Value;

use crate::{CoreError, Result};

/// Bytes per packed word: LE `u16 pos`, `u32 start_ms`, `u32 end_ms`.
const PACKED_WORD_LEN: usize = 10;

/// The longest surah (al-Baqarah) has 286 ayahs.
const MAX_AYAHS_PER_SURAH: u32 = 286;

/// One surah audio file and where its timings came from (`timing_file`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingFile {
    pub reciter_id: u32,
    pub surah: u32,
    pub audio_url: String,
    /// HTTP `Content-Length` of `audio_url` (never QDC's `file_size`).
    pub content_length: Option<u64>,
    pub duration_ms: Option<u32>,
    /// `"qdc"`.
    pub source: String,
    pub fetched_at_ms: i64,
    pub etag: Option<String>,
    pub payload_sha256: String,
}

/// One word segment on the file timeline. `pos` is the word position in the ayah; positions may repeat or go
/// backwards (the active word is chosen by time).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WordSeg {
    pub pos: u16,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// One ayah on the file timeline, words sorted by `start_ms`. Not the IPC type (`quran_types::AyahTiming`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimedAyah {
    pub ayah: u32,
    pub from_ms: u32,
    pub to_ms: u32,
    pub words: Vec<WordSeg>,
}

/// A surah's timings as stored in content.db.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTimings {
    pub file: TimingFile,
    pub ayahs: Vec<TimedAyah>,
    /// `false` when only ayah-level timings survived sanitising.
    pub word_level: bool,
}

impl StoredTimings {
    /// The IPC shape (`audio_get_timings`).
    ///
    /// `duration_ms` is the larger of the file's `duration_ms` and the last ayah's end: QDC rounds the file duration
    /// to whole seconds, so it can be *shorter* than the timeline (Afasy 1: `duration` 46,000, 1:7 ends at 46,490), and
    /// it may be unknown.
    #[must_use]
    pub fn to_dto(&self) -> SurahTimings {
        let last_to = self.ayahs.iter().map(|a| a.to_ms).max().unwrap_or(0);
        SurahTimings {
            reciter_id: self.file.reciter_id,
            surah: self.file.surah,
            duration_ms: self.file.duration_ms.unwrap_or(0).max(last_to),
            word_level: self.word_level,
            ayahs: self
                .ayahs
                .iter()
                .map(|a| AyahTiming {
                    ayah: a.ayah,
                    from_ms: a.from_ms,
                    to_ms: a.to_ms,
                    words: a
                        .words
                        .iter()
                        .map(|w| WordTiming {
                            pos: u32::from(w.pos),
                            start_ms: w.start_ms,
                            end_ms: w.end_ms,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// What [`sanitize_qdc`] had to repair (logged, and asserted by tests).
///
/// - `dropped_segments`: word segments removed: not exactly three numbers, a position outside `1..=65535`, or empty
///   after clamping to the ayah (`end ≤ start`); plus every word of a file demoted to ayah-level timings.
/// - `coerced_values`: numbers that were not already non-negative integers (strings, floats, negatives) and were
///   rounded and floored at 0.
/// - `clamped`: word segments moved into their ayah's `[from, to]`, plus ayah ends repaired because `to < from`.
/// - `reordered`: ayahs whose words were re-sorted by start time, plus 1 when the verse rows arrived out of order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SanitizeReport {
    pub dropped_segments: u32,
    pub coerced_values: u32,
    pub clamped: u32,
    pub reordered: u32,
}

impl SanitizeReport {
    /// True when the payload needed no repair at all.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        *self == Self::default()
    }
}

/// The file-level fields of one QDC `audio_files[]` element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QdcFileInfo {
    /// `chapter_id`, 1..=114.
    pub chapter_id: u32,
    /// `audio_url`, trimmed and non-empty.
    pub audio_url: String,
    /// QDC's `duration` in ms (rounded to whole seconds upstream, so only an estimate); `None` when absent or not a
    /// number.
    pub duration_ms: Option<u32>,
}

/// Reads `chapter_id`, `audio_url` and `duration` of one QDC `audio_files[]` element with the [`sanitize_qdc`]
/// tolerance (numbers may be strings or floats). A missing or null `chapter_id` or `audio_url` (Sudais has such a junk
/// row) is `Corrupt`: that file must be dropped.
pub fn qdc_file_info(file: &Value) -> Result<QdcFileInfo> {
    if !file.is_object() {
        return Err(CoreError::Corrupt(
            "qdc audio file: not a JSON object".into(),
        ));
    }
    let chapter_id = file
        .get("chapter_id")
        .and_then(coerce)
        .map(|n| n.value)
        .ok_or_else(|| CoreError::Corrupt("qdc audio file: no chapter_id".into()))?;
    if !(1..=SURAH_COUNT).contains(&chapter_id) {
        return Err(CoreError::Corrupt(format!(
            "qdc audio file: chapter_id {chapter_id} is not a surah"
        )));
    }
    let audio_url = file
        .get("audio_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| {
            CoreError::Corrupt(format!(
                "qdc audio file for surah {chapter_id}: no audio_url"
            ))
        })?
        .to_owned();
    let duration_ms = file.get("duration").and_then(coerce).map(|n| n.value);
    Ok(QdcFileInfo {
        chapter_id,
        audio_url,
        duration_ms,
    })
}

/// Sanitises ONE element of QDC `audio_files[]` (tolerant: numbers may be strings or floats) for a surah with
/// `ayah_count` ayahs, following these rules:
///
/// 1. `verse_timings[].verse_key` (`s:a`) is parsed; rows of another surah than `chapter_id` (and unparseable keys) are
///    dropped. A file without `chapter_id` or `audio_url` is `Corrupt` ([`qdc_file_info`]).
/// 2. Every number is coerced with `round().max(0)`.
/// 3. Segments that are not exactly three numbers are dropped.
/// 4. The verse `duration` is ignored. If `to < from`, `to` becomes the next ayah's `from` (or `from + 1` for the last
///    ayah, or when the next ayah does not start later).
/// 5. Words are clamped to `[from, to]`; a word with `end ≤ start` afterwards is dropped.
/// 6. Words are stably sorted by `start`; repeated and backward positions are kept.
/// 7. Ayahs `1..=ayah_count` must each appear exactly once, with non-decreasing `from` and a numeric
///    `timestamp_from`/`timestamp_to`; otherwise the file is `Corrupt`. When the ayah rows are valid but the words are
///    not (some ayah has no usable word segment, e.g. `segments: []`), every word is dropped and the result is
///    ayah-level only ([`is_word_level`] is then false).
pub fn sanitize_qdc(file: &Value, ayah_count: u32) -> Result<(Vec<TimedAyah>, SanitizeReport)> {
    if !(1..=MAX_AYAHS_PER_SURAH).contains(&ayah_count) {
        return Err(CoreError::InvalidArgument(format!(
            "ayah_count {ayah_count} is outside 1..={MAX_AYAHS_PER_SURAH}"
        )));
    }
    let info = qdc_file_info(file)?;
    let surah = info.chapter_id;
    let rows = file
        .get("verse_timings")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoreError::Corrupt(format!("qdc timings for surah {surah}: no verse_timings"))
        })?;

    let mut report = SanitizeReport::default();
    let mut ayahs = Vec::with_capacity(rows.len());
    for row in rows {
        let Some((row_surah, ayah)) = row.get("verse_key").and_then(parse_verse_key) else {
            log::debug!("qdc timings for surah {surah}: dropped a row without a valid verse_key");
            continue;
        };
        if row_surah != surah {
            log::debug!(
                "qdc timings for surah {surah}: dropped row {row_surah}:{ayah} of another surah"
            );
            continue;
        }
        let from_ms = timestamp(row, "timestamp_from", surah, ayah, &mut report)?;
        let to_ms = timestamp(row, "timestamp_to", surah, ayah, &mut report)?;
        let words = match row.get("segments").and_then(Value::as_array) {
            Some(segments) => segments
                .iter()
                .filter_map(|seg| word_segment(seg, &mut report))
                .collect(),
            None => Vec::new(),
        };
        ayahs.push(TimedAyah {
            ayah,
            from_ms,
            to_ms,
            words,
        });
    }

    // Rule 7 (shape): ayahs 1..=ayah_count, each exactly once.
    if !ayahs.is_sorted_by_key(|a| a.ayah) {
        report.reordered = report.reordered.saturating_add(1);
        ayahs.sort_by_key(|a| a.ayah);
    }
    let expected = usize::try_from(ayah_count).unwrap_or(usize::MAX);
    let complete =
        ayahs.len() == expected && ayahs.iter().zip(1..=ayah_count).all(|(a, n)| a.ayah == n);
    if !complete {
        let listed: Vec<u32> = ayahs.iter().map(|a| a.ayah).collect();
        return Err(CoreError::Corrupt(format!(
            "qdc timings for surah {surah}: expected ayahs 1..={ayah_count} exactly once, got {}",
            summarize_ayahs(&listed)
        )));
    }

    // Rule 4: repair negative ayah durations from the next ayah's start.
    let next_from: Vec<Option<u32>> = ayahs
        .iter()
        .skip(1)
        .map(|a| Some(a.from_ms))
        .chain(std::iter::once(None))
        .collect();
    for (a, next) in ayahs.iter_mut().zip(next_from) {
        if a.to_ms < a.from_ms {
            a.to_ms = match next {
                Some(n) if n > a.from_ms => n,
                _ => a.from_ms.saturating_add(1),
            };
            report.clamped = report.clamped.saturating_add(1);
        }
    }

    // Rule 7 (order): non-decreasing `from`.
    for pair in ayahs.windows(2) {
        if let [a, b] = pair
            && b.from_ms < a.from_ms
        {
            return Err(CoreError::Corrupt(format!(
                "qdc timings for surah {surah}: ayah {} starts at {} ms, before ayah {} ({} ms)",
                b.ayah, b.from_ms, a.ayah, a.from_ms
            )));
        }
    }

    // Rules 5 and 6: clamp, drop empty words, sort by start.
    for a in &mut ayahs {
        let (from, to) = (a.from_ms, a.to_ms);
        a.words.retain_mut(|w| {
            let start = w.start_ms.clamp(from, to);
            let end = w.end_ms.clamp(from, to);
            if (start, end) != (w.start_ms, w.end_ms) {
                report.clamped = report.clamped.saturating_add(1);
                w.start_ms = start;
                w.end_ms = end;
            }
            let keep = end > start;
            if !keep {
                report.dropped_segments = report.dropped_segments.saturating_add(1);
            }
            keep
        });
        if !a.words.is_sorted_by_key(|w| w.start_ms) {
            report.reordered = report.reordered.saturating_add(1);
            a.words.sort_by_key(|w| w.start_ms); // stable: equal starts keep their upstream order
        }
    }

    // Rule 7 (words): word level only when every ayah kept a usable word.
    if !is_word_level(&ayahs) {
        let with_words = ayahs.iter().filter(|a| !a.words.is_empty()).count();
        if with_words > 0 {
            let dropped: usize = ayahs.iter().map(|a| a.words.len()).sum();
            log::warn!(
                "qdc timings for surah {surah}: {with_words} of {ayah_count} ayahs have word segments; keeping ayah-level \
                 timings only ({dropped} words dropped)"
            );
            report.dropped_segments = report
                .dropped_segments
                .saturating_add(u32::try_from(dropped).unwrap_or(u32::MAX));
            for a in &mut ayahs {
                a.words.clear();
            }
        }
    }
    if !report.is_clean() {
        log::debug!("qdc timings for surah {surah} sanitised: {report:?}");
    }
    Ok((ayahs, report))
}

/// True when every ayah has at least one word segment: the timings drive word highlighting. [`sanitize_qdc`] output is
/// either fully word-level or has no words at all.
#[must_use]
pub fn is_word_level(ayahs: &[TimedAyah]) -> bool {
    !ayahs.is_empty() && ayahs.iter().all(|a| !a.words.is_empty())
}

/// Packs word segments for `timing_ayah.words`: per word LE `u16 pos`, `u32 start_ms`, `u32 end_ms` (10 bytes).
#[must_use]
pub fn pack_words(w: &[WordSeg]) -> Vec<u8> {
    let mut out = Vec::with_capacity(w.len() * PACKED_WORD_LEN);
    for seg in w {
        out.extend_from_slice(&seg.pos.to_le_bytes());
        out.extend_from_slice(&seg.start_ms.to_le_bytes());
        out.extend_from_slice(&seg.end_ms.to_le_bytes());
    }
    out
}

/// Inverse of [`pack_words`]. A length that is not a multiple of 10 is `Corrupt`.
pub fn unpack_words(b: &[u8]) -> Result<Vec<WordSeg>> {
    let (words, rest) = b.as_chunks::<PACKED_WORD_LEN>();
    if !rest.is_empty() {
        return Err(CoreError::Corrupt(format!(
            "packed words: {} bytes is not a multiple of {PACKED_WORD_LEN}",
            b.len()
        )));
    }
    Ok(words
        .iter()
        .map(|&[p0, p1, s0, s1, s2, s3, e0, e1, e2, e3]| WordSeg {
            pos: u16::from_le_bytes([p0, p1]),
            start_ms: u32::from_le_bytes([s0, s1, s2, s3]),
            end_ms: u32::from_le_bytes([e0, e1, e2, e3]),
        })
        .collect())
}

/// A coerced JSON number (rule 2): its value, and whether it needed coercion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Coerced {
    value: u32,
    coerced: bool,
}

/// `round().max(0)` of a JSON number or numeric string. `None` for anything else, non-finite values and values above
/// `u32::MAX`.
fn coerce(v: &Value) -> Option<Coerced> {
    match v {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                u32::try_from(u).ok().map(|value| Coerced {
                    value,
                    coerced: false,
                })
            } else if n.as_i64().is_some() {
                // A negative integer.
                Some(Coerced {
                    value: 0,
                    coerced: true,
                })
            } else {
                n.as_f64().and_then(round_non_negative)
            }
        }
        Value::String(s) => s.trim().parse::<f64>().ok().and_then(round_non_negative),
        _ => None,
    }
}

fn round_non_negative(f: f64) -> Option<Coerced> {
    if !f.is_finite() {
        return None;
    }
    let r = f.round().max(0.0);
    if r > f64::from(u32::MAX) {
        return None;
    }
    // In range and integral after `round()`: the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let value = r as u32;
    Some(Coerced {
        value,
        coerced: true,
    })
}

/// `"s:a"` → `(s, a)`, both ≥ 1.
fn parse_verse_key(v: &Value) -> Option<(u32, u32)> {
    let (s, a) = v.as_str()?.trim().split_once(':')?;
    let s: u32 = s.trim().parse().ok()?;
    let a: u32 = a.trim().parse().ok()?;
    (s >= 1 && a >= 1).then_some((s, a))
}

/// A required ayah timestamp (rules 2 and 7).
fn timestamp(
    row: &Value,
    field: &str,
    surah: u32,
    ayah: u32,
    report: &mut SanitizeReport,
) -> Result<u32> {
    let n = row.get(field).and_then(coerce).ok_or_else(|| {
        CoreError::Corrupt(format!(
            "qdc timings for {surah}:{ayah}: {field} is missing or not a number"
        ))
    })?;
    if n.coerced {
        report.coerced_values = report.coerced_values.saturating_add(1);
    }
    Ok(n.value)
}

/// One `[pos, start, end]` segment (rules 2 and 3), or `None` (counted as dropped).
fn word_segment(seg: &Value, report: &mut SanitizeReport) -> Option<WordSeg> {
    let parsed = match seg.as_array().map(Vec::as_slice) {
        Some([p, s, e]) => match (coerce(p), coerce(s), coerce(e)) {
            (Some(p), Some(s), Some(e)) => Some((p, s, e)),
            _ => None,
        },
        _ => None,
    };
    let Some((p, s, e)) = parsed else {
        report.dropped_segments = report.dropped_segments.saturating_add(1);
        return None;
    };
    let coerced = [p, s, e].iter().filter(|n| n.coerced).count();
    report.coerced_values = report
        .coerced_values
        .saturating_add(u32::try_from(coerced).unwrap_or(u32::MAX));
    match u16::try_from(p.value) {
        Ok(pos) if pos >= 1 => Some(WordSeg {
            pos,
            start_ms: s.value,
            end_ms: e.value,
        }),
        _ => {
            report.dropped_segments = report.dropped_segments.saturating_add(1);
            None
        }
    }
}

/// A short description of the ayah numbers that were found, for the `Corrupt` message.
fn summarize_ayahs(listed: &[u32]) -> String {
    const SHOWN: usize = 12;
    let mut text: Vec<String> = listed.iter().take(SHOWN).map(u32::to_string).collect();
    if listed.len() > SHOWN {
        text.push(format!("… ({} rows)", listed.len()));
    }
    if text.is_empty() {
        "no rows".to_owned()
    } else {
        format!("[{}]", text.join(", "))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use serde_json::json;

    use super::*;

    fn seg(pos: u16, start_ms: u32, end_ms: u32) -> WordSeg {
        WordSeg {
            pos,
            start_ms,
            end_ms,
        }
    }

    #[test]
    fn packed_words_round_trip() {
        let words = [seg(1, 0, 640), seg(2, 640, 1_910), seg(1, 1_910, u32::MAX)];
        let packed = pack_words(&words);
        assert_eq!(packed.len(), 30);
        assert_eq!(&packed[..2], &[1, 0]);
        assert_eq!(unpack_words(&packed).unwrap(), words);
        assert!(unpack_words(&[]).unwrap().is_empty());
        assert!(matches!(
            unpack_words(&packed[..9]),
            Err(CoreError::Corrupt(_))
        ));
    }

    fn stored(duration_ms: Option<u32>, last_to: u32) -> StoredTimings {
        StoredTimings {
            file: TimingFile {
                reciter_id: 7,
                surah: 112,
                audio_url:
                    "https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/112.mp3".into(),
                content_length: Some(214_038),
                duration_ms,
                source: "qdc".into(),
                fetched_at_ms: 0,
                etag: None,
                payload_sha256: String::new(),
            },
            ayahs: vec![TimedAyah {
                ayah: 1,
                from_ms: 0,
                to_ms: last_to,
                words: vec![seg(1, 20, 700)],
            }],
            word_level: true,
        }
    }

    #[test]
    fn dto_uses_the_last_ayah_when_duration_is_unknown() {
        let dto = stored(None, 3_000).to_dto();
        assert_eq!(dto.duration_ms, 3_000);
        assert_eq!(dto.ayahs[0].words[0].pos, 1);
        assert_eq!(dto.reciter_id, 7);
        assert_eq!(dto.surah, 112);
        assert!(dto.word_level);
    }

    #[test]
    fn dto_duration_never_ends_before_the_timeline() {
        // QDC rounds the file duration down to whole seconds (Afasy 1: 46,000 vs 1:7 ending at 46,490).
        assert_eq!(stored(Some(46_000), 46_490).to_dto().duration_ms, 46_490);
        // A longer file (trailing silence) keeps its own duration.
        assert_eq!(stored(Some(11_000), 10_490).to_dto().duration_ms, 11_000);
    }

    #[test]
    fn coercion_follows_rule_2() {
        let c = |v: Value| coerce(&v).map(|c| (c.value, c.coerced));
        assert_eq!(c(json!(580)), Some((580, false)));
        assert_eq!(c(json!(0)), Some((0, false)));
        assert_eq!(c(json!(580.4)), Some((580, true)));
        assert_eq!(c(json!(580.5)), Some((581, true)));
        assert_eq!(c(json!(0.0)), Some((0, true)));
        assert_eq!(c(json!("12855")), Some((12_855, true)));
        assert_eq!(c(json!(" 7.6 ")), Some((8, true)));
        assert_eq!(c(json!(-120)), Some((0, true)));
        assert_eq!(c(json!(-0.4)), Some((0, true)));
        assert_eq!(c(json!("-3")), Some((0, true)));
        assert_eq!(c(json!(u64::from(u32::MAX))), Some((u32::MAX, false)));
        assert_eq!(c(json!(u64::from(u32::MAX) + 1)), None);
        assert_eq!(c(json!(1e20)), None);
        assert_eq!(c(json!("NaN")), None);
        assert_eq!(c(json!("inf")), None);
        assert_eq!(c(json!("abc")), None);
        assert_eq!(c(json!(null)), None);
        assert_eq!(c(json!([1])), None);
        assert_eq!(c(json!(true)), None);
    }

    #[test]
    fn verse_keys_parse_strictly() {
        assert_eq!(parse_verse_key(&json!("2:255")), Some((2, 255)));
        assert_eq!(parse_verse_key(&json!(" 1 : 7 ")), Some((1, 7)));
        assert_eq!(parse_verse_key(&json!("1:0")), None);
        assert_eq!(parse_verse_key(&json!("1-7")), None);
        assert_eq!(parse_verse_key(&json!("a:b")), None);
        assert_eq!(parse_verse_key(&json!(17)), None);
    }

    #[test]
    fn file_info_requires_chapter_and_url() {
        let info = qdc_file_info(&json!({
            "chapter_id": "112", "audio_url": " https://x/112.mp3 ", "duration": 11000.0
        }))
        .unwrap();
        assert_eq!(info.chapter_id, 112);
        assert_eq!(info.audio_url, "https://x/112.mp3");
        assert_eq!(info.duration_ms, Some(11_000));
        let no_duration = qdc_file_info(&json!({"chapter_id": 1, "audio_url": "u"})).unwrap();
        assert_eq!(no_duration.duration_ms, None);
        for bad in [
            json!({"chapter_id": null, "audio_url": null}),
            json!({"chapter_id": 3, "audio_url": null}),
            json!({"chapter_id": 3, "audio_url": "  "}),
            json!({"chapter_id": 0, "audio_url": "u"}),
            json!({"chapter_id": 115, "audio_url": "u"}),
            json!([1, 2]),
        ] {
            assert!(
                matches!(qdc_file_info(&bad), Err(CoreError::Corrupt(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn summaries_stay_short() {
        assert_eq!(summarize_ayahs(&[]), "no rows");
        assert_eq!(summarize_ayahs(&[1, 2, 4]), "[1, 2, 4]");
        let long: Vec<u32> = (1..=20).collect();
        assert!(summarize_ayahs(&long).ends_with("… (20 rows)]"));
    }

    #[test]
    fn word_level_needs_words_everywhere() {
        let a = |words: Vec<WordSeg>| TimedAyah {
            ayah: 1,
            from_ms: 0,
            to_ms: 10,
            words,
        };
        assert!(!is_word_level(&[]));
        assert!(is_word_level(&[a(vec![seg(1, 0, 5)])]));
        assert!(!is_word_level(&[a(vec![seg(1, 0, 5)]), a(vec![])]));
    }

    #[test]
    fn rejects_impossible_ayah_counts() {
        let file = json!({"chapter_id": 1, "audio_url": "u", "verse_timings": []});
        assert!(matches!(
            sanitize_qdc(&file, 0),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(matches!(
            sanitize_qdc(&file, 287),
            Err(CoreError::InvalidArgument(_))
        ));
    }
}
