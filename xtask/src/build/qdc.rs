//! The `qdc` adapter (development only): QDC chapters and `verses/by_page` for mushafs 1, 2 and 19, cached under
//! `data/cache/qdc/` (refetched after 7 days), D4 line fix on pages 1–2 (docs/ARCHITECTURE.md §4.2). Owner: WP3a.
//!
//! Two phases:
//! - [`prepare`] makes the raw-response cache complete, fresh and current: a file that is missing, older than 7 days
//!   (QF Developer Terms; QDC files only) or does not parse as the current request shape (e.g. fetched with other
//!   `word_fields`) is fetched (`--jobs` concurrent requests, `QuranForDesktop-xtask/<version>` User-Agent, retries with
//!   backoff on 429/5xx/network errors), validated exactly as [`load`] will read it, and written atomically. With
//!   `--offline` any such file is an error instead. Tanzil's CC BY metadata has no age limit.
//! - [`load`] parses the cache (in parallel) into the adapter-neutral [`SourceQuran`]: word fields from mushaf 1, which
//!   mushafs 2 and 19 must repeat exactly; per-mushaf `(page, line)` groups with the D4 fix; per-ayah division numbers.
//!   The QDC `ruku_number`/`sajdah_number` fields are read for the report only (D6).
//!
//! Search seed (deviation from §4.2, docs/deviations/WP3a.md): `word.text_imlaei` is QDC's word-level `text_imlaei`
//! (Imla'i with diacritics, = QUL script 54), not `text_imlaei_simple`. The "simple" field spells the dagger alef as a
//! full alef and pre-folds hamza seats (`الرحمان`, `ذالك`, `هاذا`, `اولائك`, `يومنون`), so `normalize_ar` could never
//! match the everyday spellings (`الرحمن`, `ذلك`, `هذا`, `أولئك`, strict `يؤمنون`) and G12 failed; the diacritised
//! text normalises to exactly those forms.
//!
//! Cache layout (shared with the prefetch recorded in docs/deviations/LEAD.md item 8):
//! `qdc/chapters.json`, `qdc/by_page/m{1|2|19}/p{NNN}.json`, `tanzil/quran-data.xml`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use anyhow::{Context, anyhow, bail, ensure};
use futures_util::{TryStreamExt, stream};
use quran_types::MushafLayout;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::model::{
    AyahKey, Layout, Location, MUSHAFS, OPENING_PAGE_LINES, PAGE_COUNT, Page, RawLine,
    RevelationPlace, SURAH_COUNT, SourceAyah, SourceDivisions, SourceInfo, SourceQuran,
    SourceSurah, SourceWord, WordKind, lines_on_page,
};
use super::tanzil::{self, Tanzil};

/// The QDC API base (FACT §2.1: development only).
pub const API_BASE: &str = "https://api.qurancdn.com/api/qdc";
/// `word_fields` of every `verses/by_page` request (§4.2, with `text_imlaei` for `text_imlaei_simple`: see the module
/// docs).
pub const WORD_FIELDS: &str = "code_v1,code_v2,text_qpc_hafs,text_imlaei,location";
/// QF Developer Terms: QF content may not be cached for longer than one week.
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// D4: QDC numbers the lines of pages 1 and 2 as if the text started on line 9 (p1) / 10 (p2).
pub const OPENING_LINE_OFFSET: u32 = 7;
/// Attempts per request (1 + retries) for transient failures.
const MAX_ATTEMPTS: u32 = 5;
/// The longest `Retry-After` honoured.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// `meta.licence_note` of a qdc build.
#[must_use]
pub fn licence_note() -> String {
    format!(
        "DEVELOPMENT BUILD, NEVER DISTRIBUTE: Quran text, layouts and glyph codes come from the Quran Foundation QDC API \
         (api.qurancdn.com) under the QF Developer Terms, which forbid redistributing them or anything derived from them \
         (BRIEF section 4). Division metadata, ruku, sajda and English surah meanings: {}.",
        tanzil::ATTRIBUTION
    )
}

/// Where the requests go. [`Endpoints::live`] in the CLI; tests point it at a local server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    /// Base URL of the QDC API, without a trailing slash.
    pub qdc_api: String,
    /// The full Tanzil metadata URL.
    pub tanzil: String,
}

impl Endpoints {
    #[must_use]
    pub fn live() -> Self {
        Self {
            qdc_api: API_BASE.to_owned(),
            tanzil: tanzil::URL.to_owned(),
        }
    }
}

/// What one cache file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileKind {
    Chapters,
    Page { layout: MushafLayout, page: u32 },
    Tanzil,
}

impl FileKind {
    /// QF content expires after [`MAX_AGE`]; Tanzil's CC BY metadata does not.
    const fn expires(self) -> bool {
        !matches!(self, Self::Tanzil)
    }

    /// Path below the cache root, `/`-separated (also the name in the source manifest).
    fn relative_path(self) -> String {
        match self {
            Self::Chapters => "qdc/chapters.json".to_owned(),
            Self::Page { layout, page } => {
                format!("qdc/by_page/m{}/p{page:03}.json", layout.db_id())
            }
            Self::Tanzil => "tanzil/quran-data.xml".to_owned(),
        }
    }

    fn url(self, endpoints: &Endpoints) -> String {
        match self {
            Self::Chapters => format!("{}/chapters?language=en", endpoints.qdc_api),
            Self::Page { layout, page } => format!(
                "{}/verses/by_page/{page}?mushaf={}&per_page=all&words=true&word_fields={WORD_FIELDS}",
                endpoints.qdc_api,
                layout.db_id()
            ),
            Self::Tanzil => endpoints.tanzil.clone(),
        }
    }

    /// Checks downloaded bytes exactly as [`load`] reads them, so nothing invalid ever lands in the cache.
    fn validate(self, bytes: &[u8]) -> anyhow::Result<()> {
        match self {
            Self::Chapters => parse_chapters(bytes).map(drop),
            Self::Page { layout, page } => parse_page(bytes, layout, page).map(drop),
            Self::Tanzil => Tanzil::parse(bytes).map(drop),
        }
    }
}

/// Every file of a complete cache: chapters, 3 × 604 pages, Tanzil.
fn cache_files() -> Vec<FileKind> {
    let mut files = vec![FileKind::Chapters];
    for spec in MUSHAFS {
        files.extend((1..=PAGE_COUNT).map(|page| FileKind::Page {
            layout: spec.layout,
            page,
        }));
    }
    files.push(FileKind::Tanzil);
    files
}

fn path_in(cache: &Path, kind: FileKind) -> PathBuf {
    kind.relative_path()
        .split('/')
        .fold(cache.to_path_buf(), |path, part| path.join(part))
}

/// The cached Tanzil metadata file.
#[must_use]
pub fn tanzil_path(cache: &Path) -> PathBuf {
    path_in(cache, FileKind::Tanzil)
}

/// What [`prepare`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PrepareReport {
    /// Files already cached, fresh and valid.
    pub cached: usize,
    /// Files fetched because they were missing.
    pub fetched_missing: usize,
    /// Files refetched because they were older than [`MAX_AGE`].
    pub refetched_stale: usize,
    /// Files refetched because they did not parse as the current request shape.
    pub refetched_invalid: usize,
}

/// The state of one cache file.
enum CacheState {
    Fresh,
    Missing,
    Stale,
    /// Present but not what [`load`] reads (the reason).
    Invalid(String),
}

fn inspect(cache: &Path, kind: FileKind, now: SystemTime) -> anyhow::Result<CacheState> {
    let path = path_in(cache, kind);
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CacheState::Missing),
        Err(e) => return Err(e).with_context(|| format!("stat {}", path.display())),
    };
    ensure!(meta.is_file(), "{} is not a file", path.display());
    let modified = meta
        .modified()
        .with_context(|| format!("modification time of {}", path.display()))?;
    if kind.expires() && now.duration_since(modified).unwrap_or(Duration::ZERO) > MAX_AGE {
        return Ok(CacheState::Stale);
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    Ok(match kind.validate(&bytes) {
        Ok(()) => CacheState::Fresh,
        Err(e) => CacheState::Invalid(format!("{e:#}")),
    })
}

/// Makes the cache under `cache` complete, fresh and current (see the module docs).
pub fn prepare(
    cache: &Path,
    endpoints: &Endpoints,
    offline: bool,
    jobs: u32,
) -> anyhow::Result<PrepareReport> {
    let now = SystemTime::now();
    let files = cache_files();
    let states = parallel_map(&files, |kind| inspect(cache, *kind, now))?;
    let mut report = PrepareReport::default();
    let mut pending = Vec::new();
    let mut first_invalid = None;
    for (&kind, state) in files.iter().zip(states) {
        match state? {
            CacheState::Fresh => {
                report.cached += 1;
                continue;
            }
            CacheState::Missing => report.fetched_missing += 1,
            CacheState::Stale => report.refetched_stale += 1,
            CacheState::Invalid(reason) => {
                report.refetched_invalid += 1;
                first_invalid.get_or_insert_with(|| format!("{}: {reason}", kind.relative_path()));
            }
        }
        pending.push((kind, path_in(cache, kind)));
    }
    if pending.is_empty() {
        return Ok(report);
    }
    let summary = format!(
        "{} missing, {} older than 7 days (QF Developer Terms), {} not in the current request shape{}",
        report.fetched_missing,
        report.refetched_stale,
        report.refetched_invalid,
        first_invalid
            .map(|e| format!(" (first: {e})"))
            .unwrap_or_default()
    );
    if offline {
        bail!(
            "--offline: {} cache file(s) need fetching: {summary}; run without --offline",
            pending.len()
        );
    }
    eprintln!(
        "build-core: fetching {} file(s) into {}: {summary}; {jobs} at a time",
        pending.len(),
        cache.display()
    );
    fetch_all(&pending, endpoints, jobs)?;
    Ok(report)
}

/// `f` over `items` on up to 16 named worker threads; results in `items` order.
fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    f: impl Fn(&T) -> R + Sync,
) -> anyhow::Result<Vec<R>> {
    let workers = std::thread::available_parallelism()
        .map_or(4, std::num::NonZero::get)
        .clamp(1, 16)
        .min(items.len().max(1));
    let next = AtomicUsize::new(0);
    let f = &f;
    let mut results: Vec<(usize, R)> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for worker in 0..workers {
            let next = &next;
            let handle = std::thread::Builder::new()
                .name(format!("qdc-cache-{worker}"))
                .spawn_scoped(scope, move || {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(i) else {
                            break;
                        };
                        out.push((i, f(item)));
                    }
                    out
                })
                .context("spawn a cache worker thread")?;
            handles.push(handle);
        }
        let mut all = Vec::with_capacity(items.len());
        for handle in handles {
            all.extend(
                handle
                    .join()
                    .map_err(|_| anyhow!("a cache worker thread panicked"))?,
            );
        }
        anyhow::Ok(all)
    })?;
    results.sort_unstable_by_key(|(i, _)| *i);
    ensure!(
        results.len() == items.len(),
        "processed {} of {} items",
        results.len(),
        items.len()
    );
    Ok(results.into_iter().map(|(_, r)| r).collect())
}

fn fetch_all(
    pending: &[(FileKind, PathBuf)],
    endpoints: &Endpoints,
    jobs: u32,
) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("start the tokio runtime")?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("QuranForDesktop-xtask/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .build()
        .context("build the HTTP client")?;
    let done = AtomicUsize::new(0);
    let total = pending.len();
    let concurrency = usize::try_from(jobs.max(1)).unwrap_or(1);
    runtime.block_on(
        stream::iter(pending.iter().map(Ok::<_, anyhow::Error>)).try_for_each_concurrent(
            concurrency,
            |(kind, path)| {
                let client = &client;
                let done = &done;
                async move {
                    let url = kind.url(endpoints);
                    let bytes = fetch_with_retries(client, &url)
                        .await
                        .with_context(|| format!("GET {url}"))?;
                    kind.validate(&bytes)
                        .with_context(|| format!("invalid response from {url}"))?;
                    write_atomic(path, &bytes)?;
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if n.is_multiple_of(100) || n == total {
                        eprintln!("build-core: fetched {n}/{total}");
                    }
                    Ok(())
                }
            },
        ),
    )
}

/// A failed attempt: transient ones are retried.
enum Attempt {
    Retry(anyhow::Error, Option<Duration>),
    Fail(anyhow::Error),
}

async fn fetch_with_retries(client: &reqwest::Client, url: &str) -> anyhow::Result<Vec<u8>> {
    let mut backoff = Duration::from_secs(1);
    let mut attempt = 1;
    loop {
        match fetch_once(client, url).await {
            Ok(bytes) => return Ok(bytes),
            Err(Attempt::Retry(e, retry_after)) if attempt < MAX_ATTEMPTS => {
                let wait = retry_after.unwrap_or(backoff).min(MAX_RETRY_AFTER);
                eprintln!("build-core: {url}: {e:#}; retrying in {} s", wait.as_secs());
                tokio::time::sleep(wait).await;
                backoff = backoff.saturating_mul(2);
                attempt += 1;
            }
            Err(Attempt::Retry(e, _) | Attempt::Fail(e)) => return Err(e),
        }
    }
}

async fn fetch_once(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, Attempt> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| Attempt::Retry(anyhow!(e), None))?;
    let status = response.status();
    if !status.is_success() {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let error = anyhow!("HTTP {status}");
        return Err(
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                Attempt::Retry(error, retry_after)
            } else {
                Attempt::Fail(error)
            },
        );
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| Attempt::Retry(anyhow!(e), None))
}

/// Writes `bytes` to a sibling temp file and renames it over `path`, so a cache file is always complete.
fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let mut part = path.as_os_str().to_owned();
    part.push(format!(".part-{}", std::process::id()));
    let part = PathBuf::from(part);
    std::fs::write(&part, bytes).with_context(|| format!("write {}", part.display()))?;
    std::fs::rename(&part, path)
        .with_context(|| format!("rename {} to {}", part.display(), path.display()))
}

/// Report-only facts from QDC (D6: never stored).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QdcReport {
    /// Distinct `ruku_number` values (QDC numbers 558 rukus; Tanzil, the stored source, 556).
    pub rukus: usize,
    /// Ayahs with a `sajdah_number` (QDC misses 22:77).
    pub sajdah_ayahs: Vec<AyahKey>,
    /// Raw files read.
    pub files: usize,
}

/// Parses a complete cache into the source model (see the module docs).
pub fn load(cache: &Path) -> anyhow::Result<(SourceQuran, QdcReport)> {
    let chapters_path = path_in(cache, FileKind::Chapters);
    let chapters_bytes = std::fs::read(&chapters_path)
        .with_context(|| format!("read {}", chapters_path.display()))?;
    let surahs =
        parse_chapters(&chapters_bytes).with_context(|| format!("{}", chapters_path.display()))?;

    let kinds: Vec<FileKind> = cache_files()
        .into_iter()
        .filter(|k| matches!(k, FileKind::Page { .. }))
        .collect();
    let pages = read_pages(cache, &kinds)?;

    let mut manifest = String::new();
    push_manifest_line(&mut manifest, &chapters_bytes, FileKind::Chapters);
    for page in &pages {
        manifest.push_str(&format!("{}  {}\n", page.sha256, page.kind.relative_path()));
    }

    let mut words: BTreeMap<Location, SourceWord> = BTreeMap::new();
    let mut ayahs: BTreeMap<AyahKey, SourceAyah> = BTreeMap::new();
    let mut ruku_numbers = BTreeSet::new();
    let mut sajdah_ayahs = Vec::new();
    let mut layouts = Vec::with_capacity(MUSHAFS.len());
    for (index, spec) in MUSHAFS.iter().enumerate() {
        let canonical = index == 0;
        let mut seen_words = 0_usize;
        let mut seen_ayahs = BTreeSet::new();
        let mut layout_pages = Vec::with_capacity(PAGE_COUNT as usize);
        for page in pages
            .iter()
            .filter(|p| matches!(p.kind, FileKind::Page { layout, .. } if layout == spec.layout))
        {
            let FileKind::Page { page: number, .. } = page.kind else {
                continue;
            };
            let mut lines: BTreeMap<u32, Vec<Location>> = BTreeMap::new();
            for verse in &page.data.verses {
                ensure!(
                    seen_ayahs.insert(verse.key),
                    "mushaf {}: ayah {} appears on two pages",
                    spec.layout.db_id(),
                    verse.key
                );
                let source_ayah = SourceAyah {
                    key: verse.key,
                    divisions: verse.divisions,
                };
                if canonical {
                    ayahs.insert(verse.key, source_ayah);
                    if let Some(r) = verse.ruku {
                        ruku_numbers.insert(r);
                    }
                    if verse.sajdah.is_some() {
                        sajdah_ayahs.push(verse.key);
                    }
                } else {
                    let first = ayahs.get(&verse.key).ok_or_else(|| {
                        anyhow!(
                            "ayah {} is in mushaf {} but not in mushaf 1",
                            verse.key,
                            spec.layout.db_id()
                        )
                    })?;
                    ensure!(
                        first.divisions == source_ayah.divisions,
                        "ayah {}: mushaf {} gives divisions {:?}, mushaf 1 {:?}",
                        verse.key,
                        spec.layout.db_id(),
                        source_ayah.divisions,
                        first.divisions
                    );
                }
                for word in &verse.words {
                    seen_words += 1;
                    if canonical {
                        ensure!(
                            words.insert(word.location, word.fields.clone()).is_none(),
                            "word {} appears twice in mushaf 1",
                            word.location
                        );
                    } else {
                        let first = words.get(&word.location).ok_or_else(|| {
                            anyhow!(
                                "word {} is in mushaf {} but not in mushaf 1",
                                word.location,
                                spec.layout.db_id()
                            )
                        })?;
                        ensure!(
                            *first == word.fields,
                            "word {}: mushaf {} gives {:?}, mushaf 1 {:?} (word fields must be identical, §4.2)",
                            word.location,
                            spec.layout.db_id(),
                            word.fields,
                            first
                        );
                    }
                    lines.entry(word.line).or_default().push(word.location);
                }
            }
            let lines = lines
                .into_iter()
                .map(|(line, mut locations)| {
                    locations.sort_unstable();
                    RawLine {
                        line,
                        kind: None,
                        centered: None,
                        surah: None,
                        words: locations,
                    }
                })
                .collect();
            layout_pages.push(Page { number, lines });
        }
        ensure!(
            seen_words == words.len() && seen_ayahs.len() == ayahs.len(),
            "mushaf {} has {seen_words} words and {} ayahs, mushaf 1 {} and {}",
            spec.layout.db_id(),
            seen_ayahs.len(),
            words.len(),
            ayahs.len()
        );
        check_opening_lines(spec.layout, &layout_pages)?;
        layouts.push(Layout {
            layout: spec.layout,
            pages: layout_pages,
        });
    }

    let source = SourceQuran {
        info: SourceInfo {
            source: "qdc",
            manifest_sha256: hex::encode(Sha256::digest(manifest.as_bytes())),
            licence_note: licence_note(),
        },
        surahs,
        ayahs: ayahs.into_values().collect(),
        words,
        layouts,
    };
    let report = QdcReport {
        rukus: ruku_numbers.len(),
        sajdah_ayahs,
        files: 1 + pages.len(),
    };
    Ok((source, report))
}

fn push_manifest_line(manifest: &mut String, bytes: &[u8], kind: FileKind) {
    manifest.push_str(&format!(
        "{}  {}\n",
        hex::encode(Sha256::digest(bytes)),
        kind.relative_path()
    ));
}

/// D4 result: page 1 has exactly lines 2..=8 and page 2 exactly 3..=8 (the header slots above are derived).
fn check_opening_lines(layout: MushafLayout, pages: &[Page]) -> anyhow::Result<()> {
    for (number, first) in [(1_u32, 2_u32), (2, 3)] {
        let page = pages
            .iter()
            .find(|p| p.number == number)
            .ok_or_else(|| anyhow!("mushaf {}: page {number} is missing", layout.db_id()))?;
        let lines: Vec<u32> = page.lines.iter().map(|l| l.line).collect();
        let expected: Vec<u32> = (first..=OPENING_PAGE_LINES).collect();
        ensure!(
            lines == expected,
            "mushaf {} page {number}: ayah lines {lines:?} after the D4 fix, expected {expected:?}",
            layout.db_id()
        );
    }
    Ok(())
}

/// One parsed page file.
struct ParsedPage {
    kind: FileKind,
    sha256: String,
    data: PageData,
}

/// Reads and parses every page file, on all cores; the result is in `kinds` order.
fn read_pages(cache: &Path, kinds: &[FileKind]) -> anyhow::Result<Vec<ParsedPage>> {
    parallel_map(kinds, |kind| read_page(cache, *kind))?
        .into_iter()
        .collect()
}

fn read_page(cache: &Path, kind: FileKind) -> anyhow::Result<ParsedPage> {
    let FileKind::Page { layout, page } = kind else {
        bail!("{kind:?} is not a page file");
    };
    let path = path_in(cache, kind);
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let data = parse_page(&bytes, layout, page).with_context(|| format!("{}", path.display()))?;
    Ok(ParsedPage {
        kind,
        sha256: hex::encode(Sha256::digest(&bytes)),
        data,
    })
}

// ---- response parsing -------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChaptersJson {
    chapters: Vec<ChapterJson>,
}

#[derive(Deserialize)]
struct ChapterJson {
    id: u32,
    revelation_place: String,
    revelation_order: u32,
    bismillah_pre: bool,
    name_simple: String,
    name_complex: String,
    name_arabic: String,
    verses_count: u32,
}

/// `chapters?language=en` → the 114 surahs in id order.
fn parse_chapters(bytes: &[u8]) -> anyhow::Result<Vec<SourceSurah>> {
    let json: ChaptersJson = serde_json::from_slice(bytes).context("parse chapters JSON")?;
    ensure!(
        json.chapters.len() == SURAH_COUNT as usize,
        "{} chapters, expected {SURAH_COUNT}",
        json.chapters.len()
    );
    json.chapters
        .into_iter()
        .zip(1..)
        .map(|(c, expected)| {
            ensure!(c.id == expected, "chapter #{expected} has id {}", c.id);
            for (field, value) in [
                ("name_simple", &c.name_simple),
                ("name_complex", &c.name_complex),
                ("name_arabic", &c.name_arabic),
            ] {
                ensure!(!value.trim().is_empty(), "chapter {}: empty {field}", c.id);
            }
            ensure!(c.verses_count > 0, "chapter {}: no verses", c.id);
            Ok(SourceSurah {
                id: c.id,
                name_ar: c.name_arabic,
                name_simple: c.name_simple,
                name_complex: c.name_complex,
                revelation_place: c
                    .revelation_place
                    .parse::<RevelationPlace>()
                    .with_context(|| format!("chapter {}", c.id))?,
                revelation_order: c.revelation_order,
                ayah_count: c.verses_count,
                bismillah_pre: c.bismillah_pre,
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct PageJson {
    verses: Vec<VerseJson>,
    pagination: PaginationJson,
}

#[derive(Deserialize)]
struct PaginationJson {
    #[serde(default)]
    next_page: serde_json::Value,
}

#[derive(Deserialize)]
struct VerseJson {
    verse_key: String,
    juz_number: u32,
    hizb_number: u32,
    rub_el_hizb_number: u32,
    manzil_number: u32,
    ruku_number: Option<u32>,
    sajdah_number: Option<u32>,
    words: Vec<WordJson>,
}

#[derive(Deserialize)]
struct WordJson {
    location: String,
    char_type_name: String,
    page_number: u32,
    line_number: u32,
    code_v1: String,
    code_v2: String,
    text_qpc_hafs: String,
    /// Required (not `Option`): a file fetched without it is "not in the current request shape" and is refetched.
    text_imlaei: String,
}

/// One page response, checked and mapped.
struct PageData {
    verses: Vec<VerseData>,
}

struct VerseData {
    key: AyahKey,
    divisions: SourceDivisions,
    ruku: Option<u32>,
    sajdah: Option<u32>,
    words: Vec<WordData>,
}

struct WordData {
    location: Location,
    /// The line after the D4 fix.
    line: u32,
    fields: SourceWord,
}

/// `verses/by_page/{page}?mushaf={layout}`: `pagination.next_page` must be null (`per_page=all`), every word must be on
/// `page`, lines are fixed with D4 on pages 1–2 and must fall on the page.
fn parse_page(bytes: &[u8], layout: MushafLayout, page: u32) -> anyhow::Result<PageData> {
    let json: PageJson = serde_json::from_slice(bytes).context("parse verses/by_page JSON")?;
    ensure!(
        json.pagination.next_page.is_null(),
        "pagination.next_page is {} (per_page=all must return the whole page)",
        json.pagination.next_page
    );
    ensure!(!json.verses.is_empty(), "no verses");
    let max_line = lines_on_page(page);
    let mut verses = Vec::with_capacity(json.verses.len());
    for verse in json.verses {
        let key: AyahKey = verse.verse_key.parse()?;
        ensure!(!verse.words.is_empty(), "verse {key} has no words");
        let mut words = Vec::with_capacity(verse.words.len());
        for word in verse.words {
            let location: Location = word.location.parse()?;
            ensure!(
                location.ayah_key() == key,
                "word {location} is listed under verse {key}"
            );
            ensure!(
                word.page_number == page,
                "word {location} is on page {}, not {page} (mushaf {})",
                word.page_number,
                layout.db_id()
            );
            let line = if page <= 2 {
                word.line_number.saturating_sub(OPENING_LINE_OFFSET)
            } else {
                word.line_number
            };
            ensure!(
                (1..=max_line).contains(&line),
                "word {location}: line_number {} is outside 1..={max_line}{}",
                word.line_number,
                if page <= 2 {
                    " after the D4 fix (−7)"
                } else {
                    ""
                }
            );
            let kind = match word.char_type_name.as_str() {
                "word" => WordKind::Word,
                "end" => WordKind::End,
                other => bail!("word {location}: char_type_name {other:?}"),
            };
            words.push(WordData {
                location,
                line,
                fields: SourceWord {
                    kind,
                    text_hafs: word.text_qpc_hafs,
                    text_imlaei: Some(word.text_imlaei),
                    code_v1: word.code_v1,
                    code_v2: word.code_v2,
                },
            });
        }
        verses.push(VerseData {
            key,
            divisions: SourceDivisions {
                juz: Some(verse.juz_number),
                hizb: Some(verse.hizb_number),
                rub: verse.rub_el_hizb_number,
                manzil: Some(verse.manzil_number),
            },
            ruku: verse.ruku_number,
            sajdah: verse.sajdah_number,
            words,
        });
    }
    Ok(PageData { verses })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_json(next_page: &str, page: u32, line: u32, char_type: &str) -> String {
        format!(
            r#"{{"verses":[{{"id":1,"verse_key":"1:1","juz_number":1,"hizb_number":1,"rub_el_hizb_number":1,
            "manzil_number":1,"ruku_number":1,"sajdah_number":null,"page_number":{page},"words":[
            {{"id":1,"location":"1:1:1","char_type_name":"{char_type}","page_number":{page},"line_number":{line},
              "code_v1":"ﭑ","code_v2":"ﱁ","text_qpc_hafs":"بِسۡمِ","text_imlaei":"بِسْمِ","audio_url":null}}]}}],
            "pagination":{{"per_page":7,"current_page":1,"next_page":{next_page},"total_pages":1,"total_records":7}}}}"#
        )
    }

    #[test]
    fn pages_apply_d4_and_reject_bad_responses() -> anyhow::Result<()> {
        let ok = parse_page(
            page_json("null", 1, 9, "word").as_bytes(),
            MushafLayout::V2,
            1,
        )?;
        let verse = ok.verses.first().ok_or_else(|| anyhow!("one verse"))?;
        let word = verse.words.first().ok_or_else(|| anyhow!("one word"))?;
        assert_eq!(word.line, 2, "D4: line 9 on page 1 is line 2");
        assert_eq!(word.location, Location::new(1, 1, 1));
        assert_eq!(verse.divisions.rub, 1);
        assert_eq!(word.fields.kind, WordKind::Word);

        let p3 = parse_page(
            page_json("null", 3, 9, "end").as_bytes(),
            MushafLayout::V1,
            3,
        )?;
        let line = p3
            .verses
            .first()
            .and_then(|v| v.words.first())
            .map(|w| w.line);
        assert_eq!(line, Some(9), "no D4 fix after page 2");

        for (json, page, why) in [
            (page_json("2", 1, 9, "word"), 1, "paginated"),
            (page_json("null", 1, 7, "word"), 1, "line 7 − 7 = 0"),
            (page_json("null", 2, 16, "word"), 2, "line 16 − 7 = 9 > 8"),
            (page_json("null", 3, 16, "word"), 3, "line 16"),
            (page_json("null", 4, 2, "word"), 3, "word on another page"),
            (page_json("null", 3, 2, "pause"), 3, "unknown char type"),
            ("{\"verses\":[]}".to_owned(), 3, "no pagination"),
            (
                page_json("null", 3, 2, "word")
                    .replace("\"text_imlaei\"", "\"text_imlaei_simple\""),
                3,
                "fetched with the old word_fields",
            ),
        ] {
            assert!(
                parse_page(json.as_bytes(), MushafLayout::V2, page).is_err(),
                "{why}"
            );
        }
        Ok(())
    }

    #[test]
    fn chapters_must_be_complete() {
        let one = r#"{"id":ID,"revelation_place":"makkah","revelation_order":5,"bismillah_pre":true,"name_simple":"A",
            "name_complex":"Ā","name_arabic":"ا","verses_count":3,"translated_name":{"name":"x"}}"#;
        let all: Vec<String> = (1..=114)
            .map(|i| one.replace("ID", &i.to_string()))
            .collect();
        let json = format!("{{\"chapters\":[{}]}}", all.join(","));
        let parsed = parse_chapters(json.as_bytes());
        assert!(
            matches!(&parsed, Ok(s) if s.len() == 114 && s[113].id == 114),
            "{:?}",
            parsed.err()
        );
        let short = format!("{{\"chapters\":[{}]}}", all[..113].join(","));
        assert!(parse_chapters(short.as_bytes()).is_err());
        let swapped = json.replacen("\"id\":1,", "\"id\":2,", 1);
        assert!(parse_chapters(swapped.as_bytes()).is_err());
        let bad_place = json.replacen("makkah", "mecca", 1);
        assert!(parse_chapters(bad_place.as_bytes()).is_err());
    }

    #[test]
    fn cache_layout_matches_the_prefetch() {
        let files = cache_files();
        assert_eq!(files.len(), 1 + 3 * 604 + 1);
        assert_eq!(FileKind::Chapters.relative_path(), "qdc/chapters.json");
        assert_eq!(
            FileKind::Page {
                layout: MushafLayout::V4,
                page: 7
            }
            .relative_path(),
            "qdc/by_page/m19/p007.json"
        );
        assert_eq!(FileKind::Tanzil.relative_path(), "tanzil/quran-data.xml");
        let live = Endpoints::live();
        assert_eq!(
            FileKind::Page {
                layout: MushafLayout::V1,
                page: 600
            }
            .url(&live),
            "https://api.qurancdn.com/api/qdc/verses/by_page/600?mushaf=2&per_page=all&words=true\
             &word_fields=code_v1,code_v2,text_qpc_hafs,text_imlaei,location"
        );
        assert_eq!(
            FileKind::Chapters.url(&live),
            "https://api.qurancdn.com/api/qdc/chapters?language=en"
        );
        assert_eq!(
            FileKind::Tanzil.url(&live),
            "https://tanzil.net/res/text/metadata/quran-data.xml"
        );
        assert!(!FileKind::Tanzil.expires());
        assert!(FileKind::Chapters.expires());
    }
}
