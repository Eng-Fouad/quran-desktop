//! `qurancom_v4_tafsir_by_chapter`: Quran.com tafsir chapters → `content.db`.
//!
//! `GET {QURAN_COM_API}/tafsirs/{resourceId}/by_chapter/{ch}?per_page=300&page={n}` until `pagination.next_page` is
//! `null`. Quran.com groups ayahs: the group's first ayah carries the HTML and the others come with empty `text`, so an
//! empty row extends the previous entry's range (`to_ayah_id`). An empty row is only joined to an entry that ends on
//! the ayah right before it: some tafsirs have no row at all for a few ayahs (As-Sa'di misses 59), and an entry must
//! never claim an ayah upstream gave nothing for. The HTML goes through the shared ammonia policy
//! ([`crate::transform::html::sanitize`]). Rows land in `tafsir_entry` with the chapter's `content_chapter` stamp
//! (payload sha256, `fetched_at`, `pinned` = an explicit download).
//!
//! - [`fetch_chapter`] is the job item (an explicit download, or "download all"): a chapter already stored and fresh
//!   is only pinned (`Present`, no request).
//! - [`ensure_chapter`] is the on-demand lookup: fresh → no request; missing or stale → refetched; a failed refetch
//!   of a stored chapter serves the stored copy as stale.
//! - [`revalidate_chapter`] is the revalidator's refetch: an unchanged payload only moves `fetched_at`.

use std::collections::BTreeMap;
use std::time::Duration;

use quran_core::content_db::geometry;
use quran_core::{ChapterStamp, ContentDb, TafsirRow};
use serde::Deserialize;

use super::{AdapterCtx, ItemOutcome, QurancomTafsirConfig};
use crate::PackError;
use crate::revalidate::{
    ChapterChange, ChapterState, MAX_AGE, QURAN_COM_API, blocking, chapter_stamp, check_surah,
    fetch_pages, invalid_surah, is_fresh,
};
use crate::transform::html;

/// Rows per page requested (Quran.com accepts it; al-Baqarah's 286 ayahs fit one page).
pub const PER_PAGE: u32 = 300;
/// Storage estimate per row on top of its HTML (the catalog's `sizeBytes` uses the same measure).
const ROW_OVERHEAD: u64 = 32;

/// `{QURAN_COM_API}/tafsirs/{resource_id}/by_chapter/{surah}?per_page=300&page={page}`.
#[must_use]
pub fn chapter_url(resource_id: u32, surah: u32, page: u32) -> String {
    format!(
        "{}/tafsirs/{resource_id}/by_chapter/{surah}?per_page={PER_PAGE}&page={page}",
        QURAN_COM_API.get()
    )
}

#[derive(Deserialize)]
struct TafsirPage {
    #[serde(default)]
    tafsirs: Vec<RawTafsir>,
}

#[derive(Deserialize)]
struct RawTafsir {
    #[serde(default)]
    verse_key: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

/// A chapter as Quran.com serves it now, sanitised and grouped, ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedChapter {
    pub surah: u32,
    pub rows: Vec<TafsirRow>,
    /// sha256 over the page bodies (the `content_chapter.sha256` revalidation compares).
    pub sha256: String,
    /// Body bytes received.
    pub received: u64,
}

/// The stored size of a chapter's rows (HTML + 32 B per row).
#[must_use]
pub fn stored_size(rows: &[TafsirRow]) -> u64 {
    rows.iter()
        .map(|r| {
            u64::try_from(r.html.len())
                .unwrap_or(u64::MAX)
                .saturating_add(ROW_OVERHEAD)
        })
        .fold(0, u64::saturating_add)
}

/// `"s:a"` → `(s, a)`.
fn parse_verse_key(key: &str) -> Option<(u32, u32)> {
    let (s, a) = key.trim().split_once(':')?;
    Some((s.parse().ok()?, a.parse().ok()?))
}

/// Groups upstream records `(verse_key, sanitised html)` of chapter `surah` into ranged rows (module docs).
///
/// Records of another surah or of an ayah outside the surah are dropped; a repeated ayah keeps its first non-empty
/// text. A chapter for which upstream sent no record of its own ayahs (none at all, or only wrong keys) is an integrity
/// failure of the upstream. A chapter whose records are all empty is valid and empty: the tafsir has no commentary
/// there (Ibn Kathir abridged, 169, serves 105:1–5 with empty text), so it is stored without entries and counts as
/// present, instead of failing every download of the pack at "113 of 114".
pub fn group_rows(
    surah: u32,
    records: impl IntoIterator<Item = (Option<String>, String)>,
) -> Result<Vec<TafsirRow>, PackError> {
    let (Some(ids), Some(count)) = (
        geometry::surah_ayah_ids(surah),
        geometry::surah_ayah_count(surah),
    ) else {
        return Err(invalid_surah(surah));
    };
    let mut by_ayah: BTreeMap<u32, String> = BTreeMap::new();
    for (key, html) in records {
        let Some((s, a)) = key.as_deref().and_then(parse_verse_key) else {
            log::debug!("tafsir chapter {surah}: dropped a row without a valid verse_key");
            continue;
        };
        if s != surah || !(1..=count).contains(&a) {
            log::debug!("tafsir chapter {surah}: dropped row {s}:{a}");
            continue;
        }
        let slot = by_ayah.entry(a).or_default();
        if slot.trim().is_empty() {
            *slot = html;
        }
    }
    if by_ayah.is_empty() {
        return Err(PackError::Integrity(format!(
            "tafsir chapter {surah}: upstream returned no row for it"
        )));
    }
    let records = by_ayah.len();
    let first = *ids.start();
    let mut rows: Vec<TafsirRow> = Vec::new();
    let mut orphans = 0u32;
    for (ayah, html) in by_ayah {
        let id = first.saturating_add(ayah - 1);
        if html.trim().is_empty() {
            match rows.last_mut() {
                Some(last) if last.to_ayah_id.checked_add(1) == Some(id) => last.to_ayah_id = id,
                _ => orphans = orphans.saturating_add(1),
            }
        } else {
            rows.push(TafsirRow {
                from_ayah_id: id,
                to_ayah_id: id,
                html,
            });
        }
    }
    if rows.is_empty() {
        log::info!(
            "tafsir chapter {surah}: upstream has no commentary for it ({records} empty row(s)); stored as an empty \
             chapter"
        );
    } else if orphans > 0 {
        log::debug!("tafsir chapter {surah}: {orphans} empty row(s) without a preceding group");
    }
    Ok(rows)
}

/// Fetches and prepares chapter `surah` without storing it.
pub async fn fetch_remote(
    ctx: &AdapterCtx,
    cfg: &QurancomTafsirConfig,
    surah: u32,
) -> Result<FetchedChapter, PackError> {
    check_surah(surah)?;
    let paged =
        fetch_pages::<TafsirPage>(ctx, |page| chapter_url(cfg.resource_id, surah, page)).await?;
    let records: Vec<(Option<String>, String)> = paged
        .pages
        .into_iter()
        .flat_map(|p| p.tafsirs)
        .map(|t| (t.verse_key, t.text.unwrap_or_default()))
        .collect();
    // Sanitising a large chapter (Ibn Kathir's al-Baqarah is megabytes of HTML) is CPU work: off the async workers.
    let rows = blocking(move || {
        group_rows(
            surah,
            records
                .into_iter()
                .map(|(key, text)| (key, sanitize_record(&text))),
        )
    })
    .await?;
    Ok(FetchedChapter {
        surah,
        rows,
        sha256: paged.sha256,
        received: paged.received,
    })
}

/// The shared policy; text that sanitises to nothing visible counts as empty (a group member).
fn sanitize_record(text: &str) -> String {
    if text.trim().is_empty() {
        String::new()
    } else {
        html::sanitize(text)
    }
}

/// Stores a fetched chapter (rows + stamp in one transaction); pins only go up.
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
        content.tafsir_put_chapter(&pack_id, fetched.surah, &fetched.rows, &stamp)?;
        Ok(fetched_at_ms)
    })
    .await
}

/// The rows stored for a chapter (each entry once, by its first ayah).
fn stored_rows(
    content: &ContentDb,
    pack_id: &str,
    surah: u32,
) -> Result<Vec<TafsirRow>, PackError> {
    let Some(ids) = geometry::surah_ayah_ids(surah) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for id in ids {
        if let Some(row) = content.tafsir_get(pack_id, id)?
            && row.from_ayah_id == id
        {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Pins a stored chapter (same rows, `fetched_at` and sha256) when `pin` asks for it; returns its stored size.
async fn keep_stored(ctx: &AdapterCtx, stamp: ChapterStamp, pin: bool) -> Result<u64, PackError> {
    let (content, pack_id) = (ctx.content.clone(), ctx.pack_id.clone());
    blocking(move || {
        let rows = stored_rows(&content, &pack_id, stamp.surah)?;
        if pin && !stamp.pinned {
            let surah = stamp.surah;
            content.tafsir_put_chapter(
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
    cfg: &QurancomTafsirConfig,
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
    cfg: &QurancomTafsirConfig,
    surah: u32,
) -> Result<ChapterChange, PackError> {
    refetch(ctx, cfg, surah, ctx.pin)
        .await
        .map(|(change, _)| change)
}

async fn refetch(
    ctx: &AdapterCtx,
    cfg: &QurancomTafsirConfig,
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

/// Makes chapter `surah` available for lookups (`tafsir_entry`): fresh (`max_age`) → no request; missing or stale →
/// refetched and stored (pinned when `ctx.pin`); a stale chapter that cannot be refetched is served as stale.
pub async fn ensure_chapter(
    ctx: &AdapterCtx,
    cfg: &QurancomTafsirConfig,
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

    use super::*;

    fn rec(key: &str, html: &str) -> (Option<String>, String) {
        (Some(key.to_owned()), html.to_owned())
    }

    #[test]
    fn groups_extend_contiguously() {
        // Surah 2 starts at ayah id 8: 2:49 = 56.
        let rows = group_rows(
            2,
            [
                rec("2:49", "<p>a</p>"),
                rec("2:50", ""),
                rec("2:51", "  "),
                rec("2:52", "<p>b</p>"),
            ],
        )
        .unwrap();
        assert_eq!(
            rows,
            [
                TafsirRow {
                    from_ayah_id: 56,
                    to_ayah_id: 58,
                    html: "<p>a</p>".into()
                },
                TafsirRow {
                    from_ayah_id: 59,
                    to_ayah_id: 59,
                    html: "<p>b</p>".into()
                },
            ]
        );
    }

    #[test]
    fn a_gap_is_never_claimed() {
        // 2:107 has no row at all (As-Sa'di): the empty 2:108 does not join 2:106's entry across it.
        let rows = group_rows(2, [rec("2:106", "<p>x</p>"), rec("2:108", "")]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].from_ayah_id, rows[0].to_ayah_id), (113, 113));
        // A leading empty row has no group.
        let rows = group_rows(1, [rec("1:1", ""), rec("1:2", "<p>y</p>")]).unwrap();
        assert_eq!((rows[0].from_ayah_id, rows[0].to_ayah_id), (2, 2));
    }

    #[test]
    fn order_duplicates_and_strays() {
        let rows = group_rows(
            1,
            [
                rec("1:3", "<p>c</p>"),
                rec("1:1", ""),
                rec("1:1", "<p>a</p>"),
                rec("1:1", "<p>dup</p>"),
                rec("1:2", ""),
                rec("2:1", "<p>other surah</p>"),
                rec("1:8", "<p>past the end</p>"),
                (None, "<p>no key</p>".into()),
                rec("x:y", "<p>bad key</p>"),
            ],
        )
        .unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| (r.from_ayah_id, r.to_ayah_id, r.html.as_str()))
                .collect::<Vec<_>>(),
            [(1, 2, "<p>a</p>"), (3, 3, "<p>c</p>")]
        );
    }

    #[test]
    fn a_chapter_without_its_rows_is_an_upstream_failure() {
        // Nothing at all, or only rows that are not this chapter's ayahs (wrong keys).
        assert!(matches!(
            group_rows(112, std::iter::empty()),
            Err(PackError::Integrity(_))
        ));
        assert!(matches!(
            group_rows(112, [rec("113:1", "<p>x</p>"), rec("112:9", "<p>y</p>")]),
            Err(PackError::Integrity(_))
        ));
        assert!(group_rows(0, std::iter::empty()).is_err());
        assert!(group_rows(115, std::iter::empty()).is_err());
    }

    /// Ibn Kathir (abridged, 169) serves surah 105 as five rows with empty text: a chapter without commentary, stored
    /// empty, never an integrity failure (the pack could never complete "Download all").
    #[test]
    fn an_all_empty_chapter_is_valid_and_empty() {
        let rows = group_rows(
            105,
            [
                rec("105:1", ""),
                rec("105:2", ""),
                rec("105:3", " "),
                rec("105:4", ""),
                rec("105:5", ""),
            ],
        )
        .unwrap();
        assert!(rows.is_empty());
        assert_eq!(stored_size(&rows), 0);
        assert_eq!(group_rows(112, [rec("112:1", "")]).unwrap(), []);
    }

    #[test]
    fn urls_and_sizes() {
        assert_eq!(
            chapter_url(169, 2, 1),
            "https://api.quran.com/api/v4/tafsirs/169/by_chapter/2?per_page=300&page=1"
        );
        let rows = [TafsirRow {
            from_ayah_id: 1,
            to_ayah_id: 1,
            html: "abcd".into(),
        }];
        assert_eq!(stored_size(&rows), 36);
        assert_eq!(parse_verse_key(" 2:255 "), Some((2, 255)));
        assert_eq!(parse_verse_key("2"), None);
    }
}
