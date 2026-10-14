//! `qurancom_v4_wbw`: Quran.com word-by-word chapters → `content.db`.
//!
//! `GET {QURAN_COM_API}/verses/by_chapter/{ch}?words=true&language={iso}&word_fields=location&per_page=300&page={n}`
//! until `pagination.next_page` is `null`. Words with `char_type_name == "word"` (end markers have no gloss) are joined
//! to our word ids on their `location` `s:a:w` through core.db (never on Quran.com ids), keeping `translation.text` and
//! `transliteration.text` (English-only upstream; either may be null). Rows land in `wbw` with the chapter's
//! `content_chapter` stamp (payload sha256, `fetched_at`, `pinned` = an explicit download).
//!
//! [`fetch_chapter`] (job item), [`ensure_chapter`] (on demand) and [`revalidate_chapter`] (revalidator) follow the same
//! freshness rules as the tafsir adapter.

use std::collections::BTreeMap;
use std::time::Duration;

use quran_core::content_db::geometry;
use quran_core::{ChapterStamp, ContentDb};
use quran_types::WbwEntry;
use serde::Deserialize;

use super::{AdapterCtx, ItemOutcome, QurancomWbwConfig};
use crate::PackError;
use crate::revalidate::{
    ChapterChange, ChapterState, MAX_AGE, QURAN_COM_API, blocking, chapter_stamp, check_surah,
    fetch_pages, invalid_surah, is_fresh,
};

/// Verses per page requested (al-Baqarah's 286 fit one page).
pub const PER_PAGE: u32 = 300;
/// Storage estimate per word on top of its texts (the catalog's `sizeBytes` uses the same measure).
const ROW_OVERHEAD: u64 = 24;

/// `{QURAN_COM_API}/verses/by_chapter/{surah}?words=true&language={language}&word_fields=location&per_page=300&page={page}`.
#[must_use]
pub fn chapter_url(language: &str, surah: u32, page: u32) -> String {
    format!(
        "{}/verses/by_chapter/{surah}?words=true&language={}&word_fields=location&per_page={PER_PAGE}&page={page}",
        QURAN_COM_API.get(),
        url_safe(language)
    )
}

/// A catalog language code as a query value (`[A-Za-z0-9-]`, anything else dropped).
fn url_safe(language: &str) -> String {
    language
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

#[derive(Deserialize)]
struct VersesPage {
    #[serde(default)]
    verses: Vec<RawVerse>,
}

#[derive(Deserialize)]
struct RawVerse {
    #[serde(default)]
    words: Vec<RawWord>,
}

#[derive(Deserialize)]
struct RawWord {
    #[serde(default)]
    char_type_name: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    translation: Option<Gloss>,
    #[serde(default)]
    transliteration: Option<Gloss>,
}

#[derive(Deserialize)]
struct Gloss {
    #[serde(default)]
    text: Option<String>,
}

/// One glossed word of a chapter, before the word-id join.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Glossed {
    /// `(surah, ayah, position)`.
    pub location: (u32, u32, u32),
    pub translation: Option<String>,
    pub transliteration: Option<String>,
}

/// A chapter as Quran.com serves it now, joined to word ids, ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedChapter {
    pub surah: u32,
    pub rows: Vec<WbwEntry>,
    /// sha256 over the page bodies (the `content_chapter.sha256` revalidation compares).
    pub sha256: String,
    /// Body bytes received.
    pub received: u64,
}

/// The stored size of a chapter's rows (texts + 24 B per word).
#[must_use]
pub fn stored_size(rows: &[WbwEntry]) -> u64 {
    let len = |s: &Option<String>| {
        s.as_ref()
            .map_or(0, |s| u64::try_from(s.len()).unwrap_or(u64::MAX))
    };
    rows.iter()
        .map(|r| {
            len(&r.translation)
                .saturating_add(len(&r.transliteration))
                .saturating_add(ROW_OVERHEAD)
        })
        .fold(0, u64::saturating_add)
}

/// `"s:a:w"` → `(s, a, w)`.
fn parse_location(loc: &str) -> Option<(u32, u32, u32)> {
    let mut parts = loc.trim().split(':');
    let s = parts.next()?.parse().ok()?;
    let a = parts.next()?.parse().ok()?;
    let w = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((s, a, w))
}

/// A gloss text: trimmed, `None` when empty.
fn text(gloss: Option<Gloss>) -> Option<String> {
    gloss
        .and_then(|g| g.text)
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
}

/// The glossed words of chapter `surah` in upstream order: `word` entries only, each location once (the first wins).
/// Words of another surah and unparseable locations are dropped.
fn glossed_words(surah: u32, pages: Vec<VersesPage>) -> Vec<Glossed> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for word in pages
        .into_iter()
        .flat_map(|p| p.verses)
        .flat_map(|v| v.words)
    {
        if word.char_type_name.as_deref() != Some("word") {
            continue;
        }
        let Some(location) = word.location.as_deref().and_then(parse_location) else {
            log::debug!("wbw chapter {surah}: dropped a word without a valid location");
            continue;
        };
        if location.0 != surah || !seen.insert(location) {
            continue;
        }
        out.push(Glossed {
            location,
            translation: text(word.translation),
            transliteration: text(word.transliteration),
        });
    }
    out
}

/// Joins glossed words to word ids (`ids[i]` is the id of `words[i]`, `None` when core.db has no such location) and
/// checks them against the chapter's id range. Unknown locations are dropped with a warning; a chapter where none
/// resolves is an integrity failure (upstream and core.db disagree).
pub fn join_words(
    surah: u32,
    words: Vec<Glossed>,
    ids: &[Option<u32>],
) -> Result<Vec<WbwEntry>, PackError> {
    let Some(range) = geometry::surah_word_ids(surah) else {
        return Err(invalid_surah(surah));
    };
    let mut rows: BTreeMap<u32, WbwEntry> = BTreeMap::new();
    let mut unknown = Vec::new();
    for (word, id) in words.into_iter().zip(ids.iter().copied()) {
        match id.filter(|id| range.contains(id)) {
            Some(word_id) => {
                rows.entry(word_id).or_insert(WbwEntry {
                    word_id,
                    text: String::new(),
                    translation: word.translation,
                    transliteration: word.transliteration,
                });
            }
            None => unknown.push(word.location),
        }
    }
    if !unknown.is_empty() {
        log::warn!(
            "wbw chapter {surah}: {} word location(s) are not in core.db (first {}:{}:{})",
            unknown.len(),
            unknown.first().map_or(0, |l| l.0),
            unknown.first().map_or(0, |l| l.1),
            unknown.first().map_or(0, |l| l.2),
        );
    }
    if rows.is_empty() {
        return Err(PackError::Integrity(format!(
            "wbw chapter {surah}: no glossed word of upstream matches core.db"
        )));
    }
    Ok(rows.into_values().collect())
}

/// Fetches and prepares chapter `surah` without storing it.
pub async fn fetch_remote(
    ctx: &AdapterCtx,
    cfg: &QurancomWbwConfig,
    surah: u32,
) -> Result<FetchedChapter, PackError> {
    check_surah(surah)?;
    let paged =
        fetch_pages::<VersesPage>(ctx, |page| chapter_url(&cfg.language, surah, page)).await?;
    let words = glossed_words(surah, paged.pages);
    let core = ctx.core.clone();
    let rows = blocking(move || {
        let locations: Vec<(u32, u32, u32)> = words.iter().map(|w| w.location).collect();
        let ids = core.word_ids_by_location(&locations)?;
        join_words(surah, words, &ids)
    })
    .await?;
    Ok(FetchedChapter {
        surah,
        rows,
        sha256: paged.sha256,
        received: paged.received,
    })
}

/// Stores a fetched chapter (rows + stamp in one transaction); pins only go up. Returns `fetched_at`.
async fn store(ctx: &AdapterCtx, fetched: FetchedChapter, pinned: bool) -> Result<i64, PackError> {
    let (content, pack_id) = (ctx.content.clone(), ctx.pack_id.clone());
    let fetched_at_ms = ctx.user.now_ms();
    blocking(move || {
        let stamp = ChapterStamp {
            surah: fetched.surah,
            fetched_at_ms,
            sha256: fetched.sha256,
            pinned,
        };
        content.wbw_put_chapter(&pack_id, fetched.surah, &fetched.rows, &stamp)?;
        Ok(fetched_at_ms)
    })
    .await
}

fn stored_rows(content: &ContentDb, pack_id: &str, surah: u32) -> Result<Vec<WbwEntry>, PackError> {
    let Some(range) = geometry::surah_word_ids(surah) else {
        return Err(invalid_surah(surah));
    };
    Ok(content.wbw_range(pack_id, *range.start(), *range.end())?)
}

/// Pins a stored chapter (same rows, `fetched_at` and sha256) when `pin` asks for it; returns its stored size.
async fn keep_stored(ctx: &AdapterCtx, stamp: ChapterStamp, pin: bool) -> Result<u64, PackError> {
    let (content, pack_id) = (ctx.content.clone(), ctx.pack_id.clone());
    blocking(move || {
        let rows = stored_rows(&content, &pack_id, stamp.surah)?;
        if pin && !stamp.pinned {
            let surah = stamp.surah;
            content.wbw_put_chapter(
                &pack_id,
                surah,
                &rows,
                &ChapterStamp {
                    pinned: true,
                    ..stamp
                },
            )?;
        }
        Ok(stored_size(&rows))
    })
    .await
}

/// Fetches and stores chapter `surah` (1..=114): the job item. A chapter already stored and fresh is reused without a
/// request (`Present`, pinned when the job pins).
pub async fn fetch_chapter(
    ctx: &AdapterCtx,
    cfg: &QurancomWbwConfig,
    surah: u32,
) -> Result<ItemOutcome, PackError> {
    check_surah(surah)?;
    if let Some(stamp) = chapter_stamp(&ctx.content, &ctx.pack_id, surah).await?
        && is_fresh(stamp.fetched_at_ms, ctx.user.now_ms(), MAX_AGE)
    {
        let bytes = keep_stored(ctx, stamp, ctx.pin).await?;
        return Ok(ItemOutcome::Present { bytes });
    }
    let fetched = fetch_remote(ctx, cfg, surah).await?;
    let (bytes, sha256) = (stored_size(&fetched.rows), fetched.sha256.clone());
    store(ctx, fetched, ctx.pin).await?;
    Ok(ItemOutcome::Stored { bytes, sha256 })
}

/// Refetches chapter `surah` and stores it (pins kept): `Unchanged` when the payload sha256 is the stored one (only
/// `fetched_at` moves), else `Replaced` (`New` when it was not stored).
pub async fn revalidate_chapter(
    ctx: &AdapterCtx,
    cfg: &QurancomWbwConfig,
    surah: u32,
) -> Result<ChapterChange, PackError> {
    refetch(ctx, cfg, surah, ctx.pin)
        .await
        .map(|(change, _)| change)
}

async fn refetch(
    ctx: &AdapterCtx,
    cfg: &QurancomWbwConfig,
    surah: u32,
    pin: bool,
) -> Result<(ChapterChange, i64), PackError> {
    check_surah(surah)?;
    let previous = chapter_stamp(&ctx.content, &ctx.pack_id, surah).await?;
    let fetched = fetch_remote(ctx, cfg, surah).await?;
    let change = match &previous {
        None => ChapterChange::New,
        Some(p) if p.sha256 == fetched.sha256 => ChapterChange::Unchanged,
        Some(_) => ChapterChange::Replaced,
    };
    let fetched_at = store(ctx, fetched, pin).await?;
    Ok((change, fetched_at))
}

/// Makes chapter `surah` available for `wbw_range`: fresh (`max_age`) → no request; missing or stale → refetched and
/// stored (pinned when `ctx.pin`); a stale chapter that cannot be refetched is served as stale.
pub async fn ensure_chapter(
    ctx: &AdapterCtx,
    cfg: &QurancomWbwConfig,
    surah: u32,
    max_age: Duration,
) -> Result<ChapterState, PackError> {
    check_surah(surah)?;
    let stamp = chapter_stamp(&ctx.content, &ctx.pack_id, surah).await?;
    if let Some(s) = &stamp
        && is_fresh(s.fetched_at_ms, ctx.user.now_ms(), max_age)
    {
        return Ok(ChapterState {
            fetched_at_ms: s.fetched_at_ms,
            stale: false,
            change: None,
        });
    }
    match refetch(ctx, cfg, surah, ctx.pin).await {
        Ok((change, fetched_at_ms)) => Ok(ChapterState {
            fetched_at_ms,
            stale: false,
            change: Some(change),
        }),
        Err(e) => match stamp {
            Some(s) if !matches!(e, PackError::Cancelled) => {
                log::info!(
                    "{} chapter {surah}: serving the stored copy, refetch failed: {e}",
                    ctx.pack_id
                );
                Ok(ChapterState {
                    fetched_at_ms: s.fetched_at_ms,
                    stale: true,
                    change: None,
                })
            }
            _ => Err(e),
        },
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use serde_json::json;

    use super::*;

    fn pages(v: serde_json::Value) -> Vec<VersesPage> {
        vec![serde_json::from_value(v).unwrap()]
    }

    #[test]
    fn only_words_of_the_chapter_once() {
        let words = glossed_words(
            1,
            pages(json!({ "verses": [
                { "words": [
                    { "char_type_name": "word", "location": "1:1:1",
                      "translation": { "text": " In (the) name " }, "transliteration": { "text": "bis'mi" } },
                    { "char_type_name": "word", "location": "1:1:2",
                      "translation": { "text": "" }, "transliteration": { "text": null } },
                    { "char_type_name": "word", "location": "1:1:1", "translation": { "text": "dup" } },
                    { "char_type_name": "end", "location": "1:1:5", "translation": { "text": "(1)" } },
                    { "char_type_name": "word", "location": "2:1:1" },
                    { "char_type_name": "word", "location": "1:x:1" },
                    { "char_type_name": "word" }
                ] }
            ] })),
        );
        assert_eq!(
            words,
            [
                Glossed {
                    location: (1, 1, 1),
                    translation: Some("In (the) name".into()),
                    transliteration: Some("bis'mi".into())
                },
                Glossed {
                    location: (1, 1, 2),
                    translation: None,
                    transliteration: None
                },
            ]
        );
    }

    #[test]
    fn join_keeps_the_chapter_range() {
        let g = |w| Glossed {
            location: (1, 1, w),
            translation: Some(format!("t{w}")),
            transliteration: None,
        };
        let rows = join_words(1, vec![g(1), g(2), g(3)], &[Some(2), None, Some(1)]).unwrap();
        assert_eq!(rows.iter().map(|r| r.word_id).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(rows[0].translation.as_deref(), Some("t3"));
        // An id outside surah 1 (1..=36) is not trusted.
        assert!(join_words(1, vec![g(1)], &[Some(37)]).is_err());
        assert!(matches!(
            join_words(1, vec![g(1)], &[None]),
            Err(PackError::Integrity(_))
        ));
        assert!(join_words(0, vec![], &[]).is_err());
    }

    #[test]
    fn urls_locations_and_sizes() {
        assert_eq!(
            chapter_url("en", 1, 2),
            "https://api.quran.com/api/v4/verses/by_chapter/1?words=true&language=en&word_fields=location&per_page=300&page=2"
        );
        assert_eq!(url_safe("en&x=1"), "enx1");
        assert_eq!(parse_location("2:255:3"), Some((2, 255, 3)));
        assert_eq!(parse_location("2:255"), None);
        assert_eq!(parse_location("2:255:3:1"), None);
        let rows = [WbwEntry {
            word_id: 1,
            text: String::new(),
            translation: Some("ab".into()),
            transliteration: None,
        }];
        assert_eq!(stored_size(&rows), 26);
    }
}
