//! `SearchEngine`: FTS5 search over core.db, translation packs and notes.
//!
//! - **Quran** ([`SearchEngine::search_quran`]): `ayah_fts` over the normalised Imla'i text. Smart mode searches the
//!   `loose` column with the last token as a prefix and falls back to typo expansion over `vocab_loose`; exact mode
//!   searches `strict`; substring mode scans `ayah.norm_loose` with `LIKE`. Hits carry the ayah's words (`text_hafs`,
//!   end marker last) and the ids of the matched words, so the UI highlights words without splitting any text.
//! - **Translation packs** ([`SearchEngine::search_pack`]): the pack's `entry_fts` (or `LIKE` on its `fold` column for
//!   `like_fallback` packs, queries under 3 characters and substring mode), with escaped HTML snippets.
//! - **Notes** ([`SearchEngine::search_notes`]): user.db's `note_fts` over `body_search`, with snippets of the body.
//! - **Suggestions** ([`SearchEngine::suggest`]): `vocab_loose` completions of the word being typed.
//!
//! Filters are pushed into SQL as one ayah-id range (a surah and a juz are each contiguous); `total`
//! comes from a `count(*)` with the same predicate. Results are in mushaf order, grouped by surah; a group's `count`
//! is the number of matches in that surah within the filters, also when the hit list was truncated before its end.
//! The tokenising rules live in `query.rs`, the typo fallback in `typo.rs`, word mapping and snippets in
//! `highlight.rs`.

mod highlight;
mod query;
mod typo;

pub use query::{Column, MAX_LIMIT, MAX_QUERY_CHARS, MAX_QUERY_TOKENS, MatchExpr, build_match};
pub use typo::levenshtein_bounded;

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use quran_types::{
    MushafLayout, SearchGroup, SearchHit, SearchMode, SearchRequest, SearchResults, SearchScope,
    SearchSuggestion,
};
use rusqlite::{Connection, params};

use crate::normalize::{Level, normalize_ar};
use crate::pack_db::PackTokenizer;
use crate::{CoreDb, CoreError, PackDb, Result, UserDb};
use highlight::{
    TextMatcher, TokenSet, WordRow, WordRule, fts_snippet_html, lead_snippet, markdown_text,
};
use query::{
    Fold, Geometry, Group, ParsedQuery, check_request, check_tokens, escape_like, is_quote,
    render_fts, split_tokens, substring_needle,
};
use typo::Vocab;

/// Largest `limit` of [`SearchEngine::suggest`].
pub const MAX_SUGGEST_LIMIT: u32 = 100;
/// Pack queries shorter than this (in characters, after folding) use `LIKE` instead of FTS5.
pub const MIN_FTS_QUERY_CHARS: usize = 3;

/// `ayah_fts` hits in mushaf order.
const QURAN_FTS_IDS: &str = "SELECT rowid FROM ayah_fts WHERE ayah_fts MATCH ?1 AND rowid BETWEEN ?3 AND ?4 \
                             ORDER BY rowid LIMIT ?2";
const QURAN_FTS_COUNT: &str =
    "SELECT count(*) FROM ayah_fts WHERE ayah_fts MATCH ?1 AND rowid BETWEEN ?2 AND ?3";
/// Substring mode.
const QURAN_LIKE_IDS: &str = "SELECT id FROM ayah WHERE norm_loose LIKE '%' || ?1 || '%' ESCAPE '\\' \
                              AND id BETWEEN ?3 AND ?4 ORDER BY id LIMIT ?2";
const QURAN_LIKE_COUNT: &str = "SELECT count(*) FROM ayah WHERE norm_loose LIKE '%' || ?1 || '%' ESCAPE '\\' \
                                AND id BETWEEN ?2 AND ?3";
/// Every word of one ayah, end marker last.
const AYAH_WORDS: &str = "SELECT w.id, w.is_end, w.text_hafs, w.norm_loose, w.text_imlaei \
                          FROM ayah AS a JOIN word AS w ON w.id BETWEEN a.first_word_id AND a.last_word_id \
                          WHERE a.id = ?1 ORDER BY w.id";
/// Completions of a prefix, most frequent first.
const SUGGEST: &str = "SELECT term, doc_count FROM vocab_loose WHERE term >= ?1 AND term < ?1 || char(1114111) \
                       ORDER BY doc_count DESC, term LIMIT ?2";

/// Notes overlapping the filter range; the hit ayah is the note's first ayah inside the range.
const NOTES_FTS_ROWS: &str = "SELECT n.id, max(n.from_ayah_id, ?3), coalesce(n.title, ''), n.body \
     FROM note_fts JOIN note AS n ON n.rid = note_fts.rowid \
     WHERE note_fts MATCH ?1 AND n.deleted_at IS NULL AND n.from_ayah_id <= ?4 AND n.to_ayah_id >= ?3 \
     ORDER BY n.from_ayah_id, n.to_ayah_id, n.rid LIMIT ?2";
/// `?2..=?3` is the filter range, `?4..=?5` the range the hit ayah must fall in (all of it, or one surah).
const NOTES_FTS_COUNT: &str = "SELECT count(*) FROM note_fts JOIN note AS n ON n.rid = note_fts.rowid \
     WHERE note_fts MATCH ?1 AND n.deleted_at IS NULL AND n.from_ayah_id <= ?3 AND n.to_ayah_id >= ?2 \
     AND max(n.from_ayah_id, ?2) BETWEEN ?4 AND ?5";
const NOTES_LIKE_ROWS: &str = "SELECT n.id, max(n.from_ayah_id, ?3), coalesce(n.title, ''), n.body FROM note AS n \
     WHERE n.body_search LIKE '%' || ?1 || '%' ESCAPE '\\' AND n.deleted_at IS NULL \
     AND n.from_ayah_id <= ?4 AND n.to_ayah_id >= ?3 \
     ORDER BY n.from_ayah_id, n.to_ayah_id, n.rid LIMIT ?2";
const NOTES_LIKE_COUNT: &str = "SELECT count(*) FROM note AS n \
     WHERE n.body_search LIKE '%' || ?1 || '%' ESCAPE '\\' AND n.deleted_at IS NULL \
     AND n.from_ayah_id <= ?3 AND n.to_ayah_id >= ?2 AND max(n.from_ayah_id, ?2) BETWEEN ?4 AND ?5";

/// Search over the bundled core.db (plus packs and notes handed in per call). `Clone + Send + Sync`; clones share
/// the lazily loaded geometry and typo vocabulary. Call it from `spawn_blocking`.
#[derive(Clone)]
pub struct SearchEngine {
    core: CoreDb,
    cache: Arc<Cache>,
}

/// Read once from the immutable core.db, on first use (a failed load is retried by the next search).
#[derive(Default)]
struct Cache {
    geometry: OnceLock<Geometry>,
    vocab: OnceLock<Vocab>,
}

impl std::fmt::Debug for SearchEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchEngine")
            .field("core", &self.core)
            .field("geometry_loaded", &self.cache.geometry.get().is_some())
            .field("vocab_terms", &self.cache.vocab.get().map(Vocab::len))
            .finish()
    }
}

/// How a Quran query reaches core.db.
enum CoreMatch {
    /// `ayah_fts MATCH` on one column.
    Fts { column: Column, groups: Vec<Group> },
    /// `ayah.norm_loose LIKE '%needle%'` (substring mode).
    Like { needle: String },
}

impl CoreMatch {
    fn fts(&self) -> Option<String> {
        match self {
            Self::Fts { column, groups } => Some(render_fts(Some(column.name()), groups)),
            Self::Like { .. } => None,
        }
    }

    /// The SQL argument: the FTS5 expression or the escaped needle.
    fn argument(&self) -> String {
        match self {
            Self::Fts { .. } => self.fts().unwrap_or_default(),
            Self::Like { needle } => escape_like(needle),
        }
    }

    fn ids(&self, conn: &Connection, (from, to): (u32, u32), limit: u32) -> Result<Vec<u32>> {
        let sql = match self {
            Self::Fts { .. } => QURAN_FTS_IDS,
            Self::Like { .. } => QURAN_LIKE_IDS,
        };
        let mut stmt = conn.prepare_cached(sql)?;
        let ids = stmt
            .query_map(params![self.argument(), limit, from, to], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<u32>>>()?;
        Ok(ids)
    }

    fn count(&self, conn: &Connection, (from, to): (u32, u32)) -> Result<u32> {
        let sql = match self {
            Self::Fts { .. } => QURAN_FTS_COUNT,
            Self::Like { .. } => QURAN_LIKE_COUNT,
        };
        let n = conn
            .prepare_cached(sql)?
            .query_row(params![self.argument(), from, to], |r| r.get(0))?;
        Ok(n)
    }

    fn word_rule(&self) -> WordRule {
        match self {
            Self::Fts { column, groups } => WordRule::Tokens {
                set: TokenSet::from_groups(groups),
                level: column.level(),
            },
            Self::Like { needle } => WordRule::Substring(needle.clone()),
        }
    }
}

impl SearchEngine {
    #[must_use]
    pub fn new(core: CoreDb) -> Self {
        Self {
            core,
            cache: Arc::new(Cache::default()),
        }
    }

    /// Scope = quran.
    pub fn search_quran(&self, req: &SearchRequest) -> Result<SearchResults> {
        let started = Instant::now();
        check_request(req)?;
        if req.scope != SearchScope::Quran {
            return Err(CoreError::InvalidArgument(
                "search_quran needs the quran scope".into(),
            ));
        }
        let (mut matcher, parsed, normalized) = match req.mode {
            SearchMode::Substring => {
                let needle = substring_needle(&req.query, Fold::Arabic(Level::Loose));
                let normalized = needle.clone();
                (CoreMatch::Like { needle }, None, normalized)
            }
            SearchMode::Smart | SearchMode::Exact => {
                let column = if req.mode == SearchMode::Smart {
                    Column::Loose
                } else {
                    Column::Strict
                };
                let parsed = ParsedQuery::parse(&req.query, Fold::Arabic(column.level()));
                check_tokens(&parsed)?;
                let prefix = req.mode == SearchMode::Smart && parsed.last_is_prefixable();
                let groups = parsed.groups(prefix);
                let normalized = parsed.display();
                (CoreMatch::Fts { column, groups }, Some(parsed), normalized)
            }
        };
        let empty_query = match &matcher {
            CoreMatch::Fts { groups, .. } => groups.is_empty(),
            CoreMatch::Like { needle } => needle.is_empty(),
        };
        if empty_query {
            return Ok(empty_results(req, normalized, started));
        }
        let geo = self.geometry()?;
        let Some(range) = geo.range(req.surah, req.juz)? else {
            return Ok(empty_results(req, normalized, started));
        };

        let conn = self.core.conn()?;
        let mut total = matcher.count(&conn, range)?;
        let mut ids = if total > 0 {
            matcher.ids(&conn, range, req.limit)?
        } else {
            Vec::new()
        };
        let mut suggestions = Vec::new();
        if let Some(parsed) =
            parsed.filter(|p| total == 0 && req.mode == SearchMode::Smart && typo::eligible(p))
        {
            let vocab = self.vocab(&conn)?;
            if let Some(expansion) = typo::expand(&parsed, parsed.last_is_prefixable(), vocab) {
                let retry = CoreMatch::Fts {
                    column: Column::Loose,
                    groups: expansion.groups,
                };
                let retry_total = retry.count(&conn, range)?;
                if retry_total > 0 {
                    ids = retry.ids(&conn, range, req.limit)?;
                    total = retry_total;
                    suggestions = expansion.corrections;
                    matcher = retry;
                }
            }
        }

        let rule = matcher.word_rule();
        let mut words_stmt = conn.prepare_cached(AYAH_WORDS)?;
        let mut hits = Vec::with_capacity(ids.len());
        for ayah_id in ids {
            let words = words_stmt
                .query_map([ayah_id], |r| {
                    Ok(WordRow {
                        id: r.get(0)?,
                        is_end: r.get(1)?,
                        text_hafs: r.get(2)?,
                        norm_loose: r.get(3)?,
                        text_imlaei: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut hit = base_hit(geo, req.layout, ayah_id)?;
            hit.first_word_id = words
                .first()
                .map(|w| w.id)
                .ok_or_else(|| CoreError::Corrupt(format!("ayah {ayah_id} has no words")))?;
            hit.matched_word_ids = rule.matched(&words);
            hit.words = words.into_iter().map(|w| w.text_hafs).collect();
            hits.push(hit);
        }
        let results = assemble(
            req,
            normalized,
            hits,
            total,
            suggestions,
            started,
            |surah| matcher.count(&conn, surah_within(geo, surah, range)?),
        )?;
        log_search("quran", req, &results);
        Ok(results)
    }

    /// Scope = translation: `pack` must be the pack the request names.
    pub fn search_pack(&self, pack: &PackDb, req: &SearchRequest) -> Result<SearchResults> {
        let started = Instant::now();
        check_request(req)?;
        let meta = pack.meta();
        match &req.scope {
            SearchScope::Translation { pack_id } if pack_id.trim() == meta.pack_id => {}
            SearchScope::Translation { pack_id } => {
                return Err(CoreError::InvalidArgument(format!(
                    "search_pack: the request names pack {pack_id} but searches {}",
                    meta.pack_id
                )));
            }
            _ => {
                return Err(CoreError::InvalidArgument(
                    "search_pack needs a translation scope".into(),
                ));
            }
        }
        let fold = match meta.tokenizer {
            PackTokenizer::ArabicNormalized => Fold::Arabic(Level::Loose),
            PackTokenizer::LikeFallback => Fold::Latin,
            PackTokenizer::PorterUnicode61 | PackTokenizer::Unicode61RemoveDiacritics => Fold::Raw,
        };
        let parsed = ParsedQuery::parse(&req.query, fold);
        check_tokens(&parsed)?;
        let needle = substring_needle(&req.query, fold);
        let like = req.mode == SearchMode::Substring
            || !pack.has_fts()
            || needle.chars().count() < MIN_FTS_QUERY_CHARS;
        let normalized = if like {
            needle.clone()
        } else {
            parsed.display()
        };
        let empty_query = if like {
            needle.is_empty()
        } else {
            parsed.is_empty()
        };
        if empty_query {
            return Ok(empty_results(req, normalized, started));
        }
        let geo = self.geometry()?;
        let Some((from, to)) = geo.range(req.surah, req.juz)? else {
            return Ok(empty_results(req, normalized, started));
        };

        let mut hits = Vec::new();
        let results = if like {
            let matcher = TextMatcher::substring(fold, &needle);
            for (ayah_id, plain) in pack.like_search_in(&needle, from, to, req.limit)? {
                let mut hit = base_hit(geo, req.layout, ayah_id)?;
                hit.snippet = Some(
                    matcher
                        .snippet(&plain)
                        .unwrap_or_else(|| lead_snippet(&plain)),
                );
                hits.push(hit);
            }
            let total = pack.like_count(&needle, from, to)?;
            assemble(req, normalized, hits, total, Vec::new(), started, |surah| {
                let (a, b) = surah_within(geo, surah, (from, to))?;
                pack.like_count(&needle, a, b)
            })?
        } else {
            let prefix = req.mode == SearchMode::Smart && parsed.last_is_prefixable();
            let groups = parsed.groups(prefix);
            let fts = render_fts(None, &groups);
            let rows = pack.fts_search_in(&fts, from, to, req.limit)?;
            if fold == Fold::Raw {
                // `fold` = `plain`: FTS5's own snippet is display text.
                for (ayah_id, raw) in rows {
                    let mut hit = base_hit(geo, req.layout, ayah_id)?;
                    hit.snippet = Some(fts_snippet_html(&raw));
                    hits.push(hit);
                }
            } else {
                // `fold` = `normalize_ar(plain)`: FTS5 would show folded text, so the snippet is built from `plain`.
                let ids: Vec<u32> = rows.iter().map(|(id, _)| *id).collect();
                let matcher = TextMatcher::tokens(fold, &groups);
                for (ayah_id, plain) in pack.plain_texts(&ids)? {
                    let mut hit = base_hit(geo, req.layout, ayah_id)?;
                    hit.snippet = Some(
                        matcher
                            .snippet(&plain)
                            .unwrap_or_else(|| lead_snippet(&plain)),
                    );
                    hits.push(hit);
                }
            }
            let total = pack.fts_count(&fts, from, to)?;
            assemble(req, normalized, hits, total, Vec::new(), started, |surah| {
                let (a, b) = surah_within(geo, surah, (from, to))?;
                pack.fts_count(&fts, a, b)
            })?
        };
        log_search("translation", req, &results);
        Ok(results)
    }

    /// Scope = notes: live notes overlapping the filter range, by first ayah.
    pub fn search_notes(&self, user: &UserDb, req: &SearchRequest) -> Result<SearchResults> {
        let started = Instant::now();
        check_request(req)?;
        if req.scope != SearchScope::Notes {
            return Err(CoreError::InvalidArgument(
                "search_notes needs the notes scope".into(),
            ));
        }
        let fold = Fold::Notes;
        let like = req.mode == SearchMode::Substring;
        let parsed = ParsedQuery::parse(&req.query, fold);
        check_tokens(&parsed)?;
        let needle = substring_needle(&req.query, fold);
        let prefix = req.mode == SearchMode::Smart && parsed.last_is_prefixable();
        let groups = parsed.groups(prefix);
        let (argument, rows_sql, count_sql, matcher, normalized) = if like {
            (
                escape_like(&needle),
                NOTES_LIKE_ROWS,
                NOTES_LIKE_COUNT,
                TextMatcher::substring(fold, &needle),
                needle.clone(),
            )
        } else {
            (
                render_fts(None, &groups),
                NOTES_FTS_ROWS,
                NOTES_FTS_COUNT,
                TextMatcher::tokens(fold, &groups),
                parsed.display(),
            )
        };
        let empty_query = if like {
            needle.is_empty()
        } else {
            parsed.is_empty()
        };
        if empty_query {
            return Ok(empty_results(req, normalized, started));
        }
        let geo = self.geometry()?;
        let Some((from, to)) = geo.range(req.surah, req.juz)? else {
            return Ok(empty_results(req, normalized, started));
        };

        let results = user.with(|conn| {
            let mut stmt = conn.prepare_cached(rows_sql)?;
            let rows = stmt
                .query_map(params![argument, req.limit, from, to], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, u32>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut hits = Vec::with_capacity(rows.len());
            for (note_id, ayah_id, title, body) in rows {
                let mut hit = base_hit(geo, req.layout, ayah_id)?;
                hit.snippet = Some(note_snippet(&matcher, &title, &body));
                hit.note_id = Some(note_id);
                hits.push(hit);
            }
            let count = |(a, b): (u32, u32)| -> Result<u32> {
                let n = conn
                    .prepare_cached(count_sql)?
                    .query_row(params![argument, from, to, a, b], |r| r.get(0))?;
                Ok(n)
            };
            let total = count((from, to))?;
            assemble(req, normalized, hits, total, Vec::new(), started, |surah| {
                count(surah_within(geo, surah, (from, to))?)
            })
        })?;
        log_search("notes", req, &results);
        Ok(results)
    }

    /// Completions of the word being typed: `vocab_loose` terms starting with the last token of the
    /// normalised `prefix`, most frequent first. Empty when nothing is being typed (an empty prefix, or one that ends
    /// with a space, punctuation or a quote mark).
    pub fn suggest(&self, prefix: &str, limit: u32) -> Result<Vec<SearchSuggestion>> {
        if !(1..=MAX_SUGGEST_LIMIT).contains(&limit) {
            return Err(CoreError::InvalidArgument(format!(
                "suggestion limit {limit} is not within 1..={MAX_SUGGEST_LIMIT}"
            )));
        }
        let chars = prefix.chars().count();
        if chars > MAX_QUERY_CHARS {
            return Err(CoreError::InvalidArgument(format!(
                "suggestion prefix has {chars} characters; at most {MAX_QUERY_CHARS} are accepted"
            )));
        }
        let fold = Fold::Arabic(Level::Loose);
        let typing = prefix
            .chars()
            .next_back()
            .is_some_and(|c| !fold.is_separator(c) && !is_quote(c));
        let folded = normalize_ar(prefix, Level::Loose);
        let Some(last) = split_tokens(&folded).last().filter(|_| typing) else {
            return Ok(Vec::new());
        };
        let conn = self.core.conn()?;
        let mut stmt = conn.prepare_cached(SUGGEST)?;
        let rows = stmt
            .query_map(params![last, limit], |r| {
                Ok(SearchSuggestion {
                    term: r.get(0)?,
                    count: u32::try_from(r.get::<_, i64>(1)?.max(0)).unwrap_or(u32::MAX),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// The core geometry, read from the index on first use.
    fn geometry(&self) -> Result<&Geometry> {
        if let Some(geometry) = self.cache.geometry.get() {
            return Ok(geometry);
        }
        let built = Geometry::from_index(&self.core.index()?)?;
        Ok(self.cache.geometry.get_or_init(|| built))
    }

    /// The typo vocabulary, read on the first typo fallback.
    fn vocab(&self, conn: &Connection) -> Result<&Vocab> {
        if let Some(vocab) = self.cache.vocab.get() {
            return Ok(vocab);
        }
        let loaded = Vocab::load(conn)?;
        Ok(self.cache.vocab.get_or_init(|| loaded))
    }
}

/// A hit for `ayah_id` with its reference, page and first word id; the scope fills the rest.
fn base_hit(geo: &Geometry, layout: MushafLayout, ayah_id: u32) -> Result<SearchHit> {
    let outside = || CoreError::Corrupt(format!("hit ayah {ayah_id} is outside the core index"));
    let (surah, ayah) = geo.ayah_ref(ayah_id).ok_or_else(outside)?;
    Ok(SearchHit {
        ayah_id,
        surah,
        ayah,
        page: geo.page(layout, ayah_id).ok_or_else(outside)?,
        first_word_id: geo.first_word(ayah_id).ok_or_else(outside)?,
        words: Vec::new(),
        matched_word_ids: Vec::new(),
        snippet: None,
        note_id: None,
    })
}

/// A note's snippet: from the body (Markdown reduced to text), else from the title when only the title matches, else
/// the start of the body.
fn note_snippet(matcher: &TextMatcher, title: &str, body: &str) -> String {
    let text = markdown_text(body);
    matcher
        .snippet(&text)
        .or_else(|| matcher.snippet(title))
        .unwrap_or_else(|| {
            if text.is_empty() {
                lead_snippet(title)
            } else {
                lead_snippet(&text)
            }
        })
}

/// The ayah-id range of `surah` inside the filter `range`.
fn surah_within(geo: &Geometry, surah: u32, (from, to): (u32, u32)) -> Result<(u32, u32)> {
    let (first, last) = geo
        .surah_range(surah)
        .ok_or_else(|| CoreError::Corrupt(format!("surah {surah} is not in the core index")))?;
    Ok((first.max(from), last.min(to)))
}

/// Groups `hits` (mushaf order) by surah. When the list was cut at the limit, only the last group can be incomplete:
/// its count comes from `count_surah` (the matches of that surah within the filters), so every group reports all of
/// its matches.
fn assemble(
    req: &SearchRequest,
    normalized: String,
    hits: Vec<SearchHit>,
    total: u32,
    suggestions: Vec<String>,
    started: Instant,
    count_surah: impl FnOnce(u32) -> Result<u32>,
) -> Result<SearchResults> {
    let returned = u32::try_from(hits.len()).unwrap_or(u32::MAX);
    let truncated = total > returned;
    let mut groups: Vec<SearchGroup> = Vec::new();
    for hit in hits {
        match groups.last_mut() {
            Some(group) if group.surah == hit.surah => {
                group.count += 1;
                group.hits.push(hit);
            }
            _ => groups.push(SearchGroup {
                surah: hit.surah,
                count: 1,
                hits: vec![hit],
            }),
        }
    }
    if truncated && let Some(last) = groups.last_mut() {
        last.count = last.count.max(count_surah(last.surah)?);
    }
    Ok(SearchResults {
        query: req.query.clone(),
        normalized,
        total,
        truncated,
        took_ms: elapsed_ms(started),
        groups,
        suggestions,
    })
}

fn empty_results(req: &SearchRequest, normalized: String, started: Instant) -> SearchResults {
    SearchResults {
        query: req.query.clone(),
        normalized,
        total: 0,
        truncated: false,
        took_ms: elapsed_ms(started),
        groups: Vec::new(),
        suggestions: Vec::new(),
    }
}

fn elapsed_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn log_search(scope: &str, req: &SearchRequest, results: &SearchResults) {
    // Never the query text: it may be private (notes).
    log::debug!(
        "search {scope} {:?}: {} hits of {} in {} ms",
        req.mode,
        results.groups.iter().map(|g| g.hits.len()).sum::<usize>(),
        results.total,
        results.took_ms
    );
}
