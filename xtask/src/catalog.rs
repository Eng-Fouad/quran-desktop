//! `cargo xtask catalog-check [--online]`.
//!
//! Offline, it proves that `src-tauri/resources/catalog.json` is what the app will accept:
//! 1. strict deserialisation through `quran_packs::Catalog` (unknown fields and adapters are errors);
//! 2. the committed `catalog.schema.json` (draft 2020-12, the same subset validator the tests use);
//! 3. every structural rule (`Catalog::issues`: ids, kinds, adapters, install modes, sizes, languages, tokenizers, URLs,
//!    digests, `requires`, revalidation, uniqueness, no Clear Quran) and the starter-set rules
//!    (`Catalog::starter_issues`), then prints the exact onboarding starter sets.
//!
//! `--online` then probes every upstream the catalog names (≈ 110 requests, 6 at a time):
//! - page fonts: HEAD p1 and p604 on every URL template; mirrors must agree on the length;
//! - static files: GET every mirror; status, exact length, sha256 and file magic (`wOF2`, TrueType);
//! - QuranEnc: HEAD every zip (type, length, ETag), and the list API (listed keys, versions, language, direction);
//! - Quran.com tafsir and WBW: the resource lists, one chapter each, and no silent fallback to English;
//! - QDC: the reciter list, then the **one-time `wordLevel` probe** (word segments in surah 1) and the `basmalaInFile`
//!   probe (does 112:1 start after a pre-roll?), and HEAD of the surah-1 file on every host (same length everywhere).
//!
//! Broken links and facts that contradict the catalog are errors; upstream drift the catalog should pick up (a newer
//! QuranEnc version, a changed size) is a warning that prints the new values.

use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, bail};
use futures_util::{StreamExt, stream};
use quran_packs::catalog::{SCHEMA_REF, StarterChoices, schema};
use quran_packs::{Adapter, Catalog, CatalogPack};
use quran_types::{PackKind, UiLanguage};

use crate::cli::{CatalogCheckArgs, DEFAULT_CATALOG, or_root};

pub fn run(args: &CatalogCheckArgs) -> anyhow::Result<()> {
    let path = or_root(None, DEFAULT_CATALOG);
    let catalog = check_offline(&path)?;
    if args.online {
        online::run(&catalog)?;
    }
    Ok(())
}

/// Strict parse, schema, rules and starter set; prints a summary and fails with every problem listed.
fn check_offline(path: &Path) -> anyhow::Result<Catalog> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("{} is not JSON", path.display()))?;
    let catalog =
        Catalog::from_json(&text).with_context(|| format!("strict parse of {}", path.display()))?;

    let schema_path = path.with_file_name("catalog.schema.json");
    let schema_text = std::fs::read_to_string(&schema_path)
        .with_context(|| format!("read {}", schema_path.display()))?;
    let schema_value: serde_json::Value = serde_json::from_str(&schema_text)
        .with_context(|| format!("{} is not JSON", schema_path.display()))?;

    let mut problems: Vec<String> = schema::validate(&schema_value, &value)
        .into_iter()
        .map(|e| format!("schema: {e}"))
        .collect();
    if catalog.schema.as_deref() != Some(SCHEMA_REF) {
        problems.push(format!(
            "catalog: $schema must be {SCHEMA_REF:?} so editors validate the file"
        ));
    }
    problems.extend(catalog.issues().iter().map(ToString::to_string));
    problems.extend(catalog.starter_issues().iter().map(ToString::to_string));

    println!(
        "catalog-check: {} (catalogVersion {}, generated {})",
        path.display(),
        catalog.catalog_version,
        catalog.generated_at
    );
    println!("  {}", kind_summary(&catalog));
    if !problems.is_empty() {
        for p in &problems {
            println!("  FAIL {p}");
        }
        bail!(
            "catalog-check: {} problem(s) in {}",
            problems.len(),
            path.display()
        );
    }
    println!("  ok   strict model · catalog.schema.json · structural rules · starter-set rules");
    for ui in [UiLanguage::En, UiLanguage::Ar] {
        let set = catalog.starter_set(&StarterChoices::defaults(&catalog, ui))?;
        let mut line = String::new();
        for item in &set.items {
            let _ = write!(line, "{} ({:?}) ", item.pack_id, item.fetch);
        }
        println!(
            "  ok   starter set ({}): {}= {} B on \"Download now\"",
            match ui {
                UiLanguage::En => "en",
                UiLanguage::Ar => "ar",
            },
            line,
            group(set.download_now_bytes())
        );
    }
    Ok(catalog)
}

fn kind_summary(catalog: &Catalog) -> String {
    let kinds = [
        (PackKind::MushafFonts, "mushaf_fonts"),
        (PackKind::Decor, "decor"),
        (PackKind::Translation, "translation"),
        (PackKind::Tafsir, "tafsir"),
        (PackKind::Recitation, "recitation"),
        (PackKind::Wbw, "wbw"),
    ];
    let parts: Vec<String> = kinds
        .iter()
        .map(|(kind, name)| format!("{} {name}", catalog.of_kind(*kind).count()))
        .collect();
    format!("{} packs: {}", catalog.packs.len(), parts.join(", "))
}

/// `1234567` → `1,234,567`.
fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// The `--online` probes.
mod online {
    use std::collections::HashMap;

    use anyhow::Context;
    use quran_types::{PAGE_COUNT, TextDir};
    use reqwest::header::{ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, ETAG};
    use reqwest::{Client, Method, StatusCode};
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    use super::{Adapter, Catalog, CatalogPack, Duration, StreamExt, bail, group, stream};

    const PARALLEL: usize = 6;
    const QURANENC_LIST: &str = "https://quranenc.com/api/v1/translations/list";
    const QC_TAFSIRS: &str = "https://api.quran.com/api/v4/resources/tafsirs";
    const QC_WBW: &str = "https://api.quran.com/api/v4/resources/word_by_word_translations";
    const QDC_RECITERS: &str = "https://api.qurancdn.com/api/qdc/audio/reciters?locale=en";
    /// A surah-112 first ayah starting this late means the file carries a pre-roll (isti'adha/basmala).
    const PRE_ROLL_MS: u64 = 2_500;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Level {
        Ok,
        Warn,
        Fail,
    }

    #[derive(Debug, Default)]
    struct Report {
        lines: Vec<(Level, String)>,
    }

    impl Report {
        fn ok(&mut self, m: impl Into<String>) {
            self.lines.push((Level::Ok, m.into()));
        }
        fn warn(&mut self, m: impl Into<String>) {
            self.lines.push((Level::Warn, m.into()));
        }
        fn fail(&mut self, m: impl Into<String>) {
            self.lines.push((Level::Fail, m.into()));
        }
    }

    /// Lists fetched once and shared by the per-pack probes.
    #[derive(Default)]
    struct Upstream {
        /// QuranEnc key → list entry.
        quranenc: HashMap<String, Value>,
        /// Quran.com tafsir id → resource entry.
        tafsirs: HashMap<u64, Value>,
        /// WBW ISO code → upstream `language_name`.
        wbw_languages: HashMap<String, String>,
        /// QDC reciter ids.
        reciters: HashMap<u64, Value>,
    }

    struct Head {
        status: StatusCode,
        length: Option<u64>,
        content_type: String,
        etag: Option<String>,
    }

    pub fn run(catalog: &Catalog) -> anyhow::Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("start the tokio runtime")?;
        let client = Client::builder()
            .user_agent(concat!(
                "QuranForDesktop-xtask/",
                env!("CARGO_PKG_VERSION"),
                " (catalog-check)"
            ))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .build()
            .context("build the HTTP client")?;
        println!("catalog-check --online: probing every upstream ({PARALLEL} requests at a time)");
        let (upstream, reports) = runtime.block_on(async {
            let (lists, lists_report) = fetch_upstream(&client).await;
            let mut reports: Vec<(usize, Report)> = stream::iter(catalog.packs.iter().enumerate())
                .map(|(i, pack)| {
                    let client = &client;
                    let lists = &lists;
                    async move { (i, probe_pack(client, lists, pack).await) }
                })
                .buffer_unordered(PARALLEL)
                .collect()
                .await;
            reports.sort_by_key(|(i, _)| *i);
            (lists_report, reports)
        });

        let mut warnings = 0usize;
        let mut failures = 0usize;
        let mut print = |label: &str, report: &Report| {
            for (level, line) in &report.lines {
                let tag = match level {
                    Level::Ok => "ok  ",
                    Level::Warn => {
                        warnings += 1;
                        "warn"
                    }
                    Level::Fail => {
                        failures += 1;
                        "FAIL"
                    }
                };
                println!("  {tag} {label:<22} {line}");
            }
        };
        print("(upstream lists)", &upstream);
        for (i, report) in &reports {
            let id = catalog.packs.get(*i).map_or("?", |p| p.id.as_str());
            print(id, report);
        }
        let checks =
            upstream.lines.len() + reports.iter().map(|(_, r)| r.lines.len()).sum::<usize>();
        println!(
            "catalog-check --online: {checks} checks, {warnings} warning(s), {failures} failure(s)"
        );
        if failures > 0 {
            bail!("catalog-check --online: {failures} failure(s)");
        }
        Ok(())
    }

    async fn fetch_upstream(client: &Client) -> (Upstream, Report) {
        let mut up = Upstream::default();
        let mut r = Report::default();
        match get_json(client, QURANENC_LIST).await {
            Ok(v) => {
                for t in v["translations"].as_array().into_iter().flatten() {
                    if let Some(key) = t["key"].as_str() {
                        up.quranenc.insert(key.to_owned(), t.clone());
                    }
                }
                r.ok(format!(
                    "{QURANENC_LIST}: {} translations",
                    up.quranenc.len()
                ));
            }
            Err(e) => r.fail(format!("{QURANENC_LIST}: {e:#}")),
        }
        match get_json(client, QC_TAFSIRS).await {
            Ok(v) => {
                for t in v["tafsirs"].as_array().into_iter().flatten() {
                    if let Some(id) = t["id"].as_u64() {
                        up.tafsirs.insert(id, t.clone());
                    }
                }
                r.ok(format!("{QC_TAFSIRS}: {} tafsirs", up.tafsirs.len()));
            }
            Err(e) => r.fail(format!("{QC_TAFSIRS}: {e:#}")),
        }
        match get_json(client, QC_WBW).await {
            Ok(v) => {
                for t in v["word_by_word_translations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if let (Some(iso), Some(name)) =
                        (t["iso_code"].as_str(), t["language_name"].as_str())
                    {
                        up.wbw_languages.insert(iso.to_owned(), name.to_owned());
                    }
                }
                r.ok(format!("{QC_WBW}: {} languages", up.wbw_languages.len()));
            }
            Err(e) => r.fail(format!("{QC_WBW}: {e:#}")),
        }
        match get_json(client, QDC_RECITERS).await {
            Ok(v) => {
                for t in v["reciters"].as_array().into_iter().flatten() {
                    if let Some(id) = t["id"].as_u64() {
                        up.reciters.insert(id, t.clone());
                    }
                }
                r.ok(format!("{QDC_RECITERS}: {} reciters", up.reciters.len()));
            }
            Err(e) => r.fail(format!("{QDC_RECITERS}: {e:#}")),
        }
        (up, r)
    }

    async fn probe_pack(client: &Client, up: &Upstream, pack: &CatalogPack) -> Report {
        let mut r = Report::default();
        match &pack.source {
            Adapter::QcfFontPages(c) => {
                for page in [1, PAGE_COUNT] {
                    let mut lengths = Vec::new();
                    for template in &c.url_templates {
                        let url = template.replace("{page}", &page.to_string());
                        match head(client, &url).await {
                            Ok(h)
                                if h.status == StatusCode::OK
                                    && h.length.is_some_and(|l| l > 0) =>
                            {
                                if !h.content_type.contains("woff2") {
                                    r.warn(format!("{url}: content-type {:?}", h.content_type));
                                }
                                r.ok(format!("HEAD {url}: {} B", group(h.length.unwrap_or(0))));
                                lengths.push(h.length);
                            }
                            Ok(h) => {
                                r.fail(format!("HEAD {url}: {} (length {:?})", h.status, h.length))
                            }
                            Err(e) => r.fail(format!("HEAD {url}: {e:#}")),
                        }
                    }
                    if lengths.windows(2).any(|w| w.first() != w.get(1)) {
                        r.fail(format!("mirrors disagree on p{page}: {lengths:?}"));
                    }
                }
            }
            Adapter::StaticFiles(c) => {
                for file in &c.files {
                    for url in &file.urls {
                        probe_static_file(
                            client,
                            &mut r,
                            url,
                            &file.path,
                            file.bytes,
                            file.sha256.as_deref(),
                        )
                        .await;
                    }
                }
            }
            Adapter::QuranEncSqlite(c) => probe_quranenc(client, up, pack, c, &mut r).await,
            Adapter::QurancomTafsir(c) => {
                match up.tafsirs.get(&u64::from(c.resource_id)) {
                    Some(t) => {
                        let upstream_lang = t["language_name"].as_str().unwrap_or_default();
                        match (language_code(upstream_lang), pack.language_subtag()) {
                            (Some(code), Some(lang)) if code == lang => r.ok(format!(
                                "Quran.com tafsir {}: {:?} ({upstream_lang})",
                                c.resource_id,
                                t["name"].as_str().unwrap_or_default()
                            )),
                            (code, lang) => r.fail(format!(
                                "Quran.com tafsir {} is {upstream_lang} ({code:?}), the pack says {lang:?}",
                                c.resource_id
                            )),
                        }
                    }
                    None => r.fail(format!(
                        "Quran.com tafsir {} is not in {QC_TAFSIRS}",
                        c.resource_id
                    )),
                }
                let url = format!(
                    "https://api.quran.com/api/v4/tafsirs/{}/by_chapter/1?per_page=1",
                    c.resource_id
                );
                match get_json(client, &url).await {
                    Ok(v) => {
                        let rows = v["tafsirs"].as_array().map_or(0, Vec::len);
                        let resource = v["tafsirs"][0]["resource_id"].as_u64();
                        if rows > 0 && resource == Some(u64::from(c.resource_id)) {
                            r.ok(format!(
                                "GET {url}: {rows} row(s), next page {}",
                                v["pagination"]["next_page"]
                            ));
                        } else {
                            r.fail(format!("GET {url}: {rows} rows for resource {resource:?}"));
                        }
                    }
                    Err(e) => r.fail(format!("GET {url}: {e:#}")),
                }
            }
            Adapter::QurancomWbw(c) => {
                let expected = up.wbw_languages.get(&c.language).cloned();
                if expected.is_none() {
                    r.fail(format!(
                        "{} is not a Quran.com WBW language ({QC_WBW})",
                        c.language
                    ));
                }
                let url = format!(
                    "https://api.quran.com/api/v4/verses/by_chapter/1?words=true&language={}&word_fields=location&per_page=7",
                    c.language
                );
                match get_json(client, &url).await {
                    Ok(v) => {
                        let names: Vec<&str> = v["verses"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .flat_map(|verse| verse["words"].as_array().into_iter().flatten())
                            .filter(|w| w["char_type_name"] == "word")
                            .filter_map(|w| w["translation"]["language_name"].as_str())
                            .collect();
                        let hits = names
                            .iter()
                            .filter(|n| Some(**n) == expected.as_deref())
                            .count();
                        if names.is_empty() {
                            r.fail(format!("GET {url}: no word glosses"));
                        } else if hits * 2 < names.len() {
                            r.fail(format!(
                                "GET {url}: {hits}/{} glosses are {expected:?} (silent fallback to English?)",
                                names.len()
                            ));
                        } else {
                            r.ok(format!(
                                "GET {url}: {hits}/{} word glosses in {}",
                                names.len(),
                                expected.unwrap_or_default()
                            ));
                        }
                    }
                    Err(e) => r.fail(format!("GET {url}: {e:#}")),
                }
            }
            Adapter::QdcAudio(c) => probe_qdc(client, up, c, &mut r).await,
        }
        r
    }

    async fn probe_static_file(
        client: &Client,
        r: &mut Report,
        url: &str,
        path: &str,
        bytes: u64,
        sha256: Option<&str>,
    ) {
        let body = match send(client, Method::GET, url).await {
            Ok(resp) if resp.status() == StatusCode::OK => match resp.bytes().await {
                Ok(b) => b,
                Err(e) => return r.fail(format!("GET {url}: {e:#}")),
            },
            Ok(resp) => return r.fail(format!("GET {url}: {}", resp.status())),
            Err(e) => return r.fail(format!("GET {url}: {e:#}")),
        };
        let len = body.len() as u64;
        let digest = hex::encode(Sha256::digest(&body));
        let magic_ok = if path.ends_with(".woff2") {
            body.starts_with(b"wOF2")
        } else if path.ends_with(".ttf") {
            body.starts_with(&[0, 1, 0, 0]) || body.starts_with(b"true")
        } else {
            true
        };
        if len != bytes {
            r.fail(format!(
                "GET {url}: {} B, the catalog says {} B",
                group(len),
                group(bytes)
            ));
        } else if !magic_ok {
            r.fail(format!(
                "GET {url}: not a {} file",
                path.rsplit('.').next().unwrap_or("font")
            ));
        } else {
            match sha256 {
                Some(pinned) if pinned == digest => {
                    r.ok(format!("GET {url}: {} B, sha256 pinned", group(len)))
                }
                Some(pinned) => r.fail(format!("GET {url}: sha256 {digest}, pinned {pinned}")),
                None => r.warn(format!("GET {url}: not pinned; sha256 is {digest}")),
            }
        }
    }

    async fn probe_quranenc(
        client: &Client,
        up: &Upstream,
        pack: &CatalogPack,
        c: &quran_packs::adapters::QuranEncSqliteConfig,
        r: &mut Report,
    ) {
        use quran_packs::adapters::VersionSource;

        let url = format!("https://quranenc.com/downloads/sqlite/{}.zip", c.key);
        match head(client, &url).await {
            Ok(h) if h.status == StatusCode::OK => {
                if !h.content_type.contains("zip") {
                    r.fail(format!("HEAD {url}: content-type {:?}", h.content_type));
                }
                match h.length {
                    Some(len) if len == pack.size_bytes => {
                        r.ok(format!("HEAD {url}: {} B", group(len)))
                    }
                    Some(len) => r.warn(format!(
                        "HEAD {url}: upstream is {} B, sizeBytes says {} B: update sizeBytes",
                        group(len),
                        group(pack.size_bytes)
                    )),
                    None => r.fail(format!("HEAD {url}: no Content-Length")),
                }
                match (&h.etag, c.version_source) {
                    (Some(etag), VersionSource::HttpValidators) => {
                        // nginx ETags are "<mtime hex>-<size hex>": the mtime month is the pack's YYYY.MM version.
                        match etag_month(etag) {
                            Some(month) if month == c.version => r.ok(format!("ETag {etag}: version {month}")),
                            Some(month) => r.warn(format!(
                                "ETag {etag} dates the zip {month}, the catalog says {}: update version",
                                c.version
                            )),
                            None => r.ok(format!("ETag {etag}")),
                        }
                    }
                    (None, VersionSource::HttpValidators) => {
                        r.fail(format!(
                            "HEAD {url}: no ETag, so updates cannot be detected"
                        ));
                    }
                    (_, VersionSource::List) => {}
                }
            }
            Ok(h) => r.fail(format!("HEAD {url}: {}", h.status)),
            Err(e) => r.fail(format!("HEAD {url}: {e:#}")),
        }
        let listed = up.quranenc.get(&c.key);
        match (c.version_source, listed) {
            (VersionSource::List, Some(entry)) => {
                let version = entry["version"].as_str().unwrap_or_default();
                if version == c.version {
                    r.ok(format!("list version {version}"));
                } else {
                    r.warn(format!(
                        "list version is {version}, the catalog says {}: update version and sizeBytes",
                        c.version
                    ));
                }
                let lang = entry["language_iso_code"].as_str().unwrap_or_default();
                if pack.language_subtag().as_deref() != Some(lang) {
                    r.fail(format!(
                        "QuranEnc says language {lang:?}, the pack says {:?}",
                        pack.language
                    ));
                }
                let dir = match entry["direction"].as_str() {
                    Some("rtl") => Some(TextDir::Rtl),
                    Some("ltr") => Some(TextDir::Ltr),
                    _ => None,
                };
                if dir != pack.direction {
                    r.fail(format!(
                        "QuranEnc says direction {:?}, the pack says {:?}",
                        entry["direction"], pack.direction
                    ));
                }
            }
            (VersionSource::List, None) => {
                r.fail(format!(
                    "{} is not in the list API: use versionSource http_validators",
                    c.key
                ));
            }
            (VersionSource::HttpValidators, Some(entry)) => r.warn(format!(
                "{} is now in the list API (version {}): switch versionSource to list",
                c.key, entry["version"]
            )),
            (VersionSource::HttpValidators, None) => r.ok("unlisted, as the catalog says"),
        }
    }

    async fn probe_qdc(
        client: &Client,
        up: &Upstream,
        c: &quran_packs::adapters::QdcAudioConfig,
        r: &mut Report,
    ) {
        let id = c.reciter_id;
        match up.reciters.get(&u64::from(id)) {
            Some(entry) => r.ok(format!(
                "QDC reciter {id}: {} ({})",
                entry["name"].as_str().unwrap_or_default(),
                entry["style"]["name"].as_str().unwrap_or("no style")
            )),
            None => r.fail(format!("QDC reciter {id} is not in {QDC_RECITERS}")),
        }
        let timings = |surah: u32| {
            format!(
                "https://api.qurancdn.com/api/qdc/audio/reciters/{id}/audio_files?chapter={surah}&segments=true"
            )
        };

        // One-time wordLevel probe: surah 1 carries word segments `[pos, start, end]`.
        let url = timings(1);
        let surah1 = match get_json(client, &url).await {
            Ok(v) => v,
            Err(e) => return r.fail(format!("GET {url}: {e:#}")),
        };
        let file = &surah1["audio_files"][0];
        let verses = file["verse_timings"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let word_segments = verses
            .iter()
            .flat_map(|v| v["segments"].as_array().cloned().unwrap_or_default())
            .filter(|s| {
                s.as_array()
                    .is_some_and(|a| a.len() >= 3 && a.iter().take(3).all(Value::is_number))
            })
            .count();
        let word_level = word_segments > 0;
        if word_level == c.word_level {
            r.ok(format!(
                "wordLevel {word_level}: {word_segments} word segments in surah 1 ({} ayahs)",
                verses.len()
            ));
        } else {
            r.fail(format!(
                "wordLevel probe found {word_segments} word segments: set wordLevel {word_level}"
            ));
        }
        let first = &verses.first().cloned().unwrap_or_default();
        let span = first["timestamp_to"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(first["timestamp_from"].as_u64().unwrap_or(0));
        if span < 1_000 {
            r.warn(format!(
                "1:1 spans {span} ms in the surah-1 file: the basmala before other surahs will be silent"
            ));
        }

        // basmalaInFile probe: a basmala pre-roll delays 112:1.
        let url = timings(112);
        match get_json(client, &url).await {
            Ok(v) => {
                let from = v["audio_files"][0]["verse_timings"][0]["timestamp_from"].as_u64();
                match from {
                    Some(ms) if (ms >= PRE_ROLL_MS) == c.basmala_in_file => {
                        r.ok(format!(
                            "basmalaInFile {}: 112:1 starts at {ms} ms",
                            c.basmala_in_file
                        ));
                    }
                    Some(ms) => r.fail(format!(
                        "112:1 starts at {ms} ms: set basmalaInFile {}",
                        ms >= PRE_ROLL_MS
                    )),
                    None => r.fail(format!("GET {url}: no 112:1 timing")),
                }
            }
            Err(e) => r.fail(format!("GET {url}: {e:#}")),
        }

        // The surah-1 file on every host.
        let Some(audio_url) = file["audio_url"].as_str() else {
            return r.fail("surah 1 has no audio_url");
        };
        let Ok(parsed) = reqwest::Url::parse(audio_url) else {
            return r.fail(format!("audio_url {audio_url:?} is not a URL"));
        };
        let origin = parsed.host_str().unwrap_or_default().to_owned();
        if !c.hosts.contains(&origin) {
            r.warn(format!(
                "surah 1 is served from {origin}, which is not in hosts"
            ));
        }
        let mut lengths = Vec::new();
        for host in &c.hosts {
            let mut mirror = parsed.clone();
            if mirror.set_host(Some(host)).is_err() {
                r.fail(format!("cannot point {audio_url} at {host}"));
                continue;
            }
            match head(client, mirror.as_str()).await {
                Ok(h) if h.status == StatusCode::OK && h.length.is_some_and(|l| l > 0) => {
                    if !h.content_type.contains("audio/mpeg") {
                        r.warn(format!("HEAD {mirror}: content-type {:?}", h.content_type));
                    }
                    r.ok(format!("HEAD {mirror}: {} B", group(h.length.unwrap_or(0))));
                    lengths.push(h.length);
                }
                Ok(h) => r.fail(format!(
                    "HEAD {mirror}: {} (length {:?})",
                    h.status, h.length
                )),
                Err(e) => r.fail(format!("HEAD {mirror}: {e:#}")),
            }
        }
        if lengths.windows(2).any(|w| w.first() != w.get(1)) {
            r.fail(format!("hosts disagree on the surah-1 file: {lengths:?}"));
        }
    }

    /// `"67e2bd39-c64f2"` (nginx: mtime-size in hex) → `"2025.03"`.
    fn etag_month(etag: &str) -> Option<String> {
        let inner = etag.trim_start_matches("W/").trim_matches('"');
        let (mtime, size) = inner.split_once('-')?;
        u64::from_str_radix(size, 16).ok()?;
        let secs = i64::from_str_radix(mtime, 16).ok()?;
        let at = time::OffsetDateTime::from_unix_timestamp(secs).ok()?;
        Some(format!("{:04}.{:02}", at.year(), u8::from(at.month())))
    }

    /// Quran.com `language_name` → ISO code (the languages our tafsir packs use, plus common ones).
    fn language_code(name: &str) -> Option<&'static str> {
        Some(match name {
            "english" => "en",
            "arabic" => "ar",
            "urdu" => "ur",
            "bengali" => "bn",
            "russian" => "ru",
            "indonesian" => "id",
            "turkish" => "tr",
            "persian" => "fa",
            "kurdish" => "ku",
            _ => return None,
        })
    }

    /// One request with up to 3 attempts (0.5 s, 2 s backoff) on connect errors, timeouts, 429 and 5xx.
    async fn send(client: &Client, method: Method, url: &str) -> anyhow::Result<reqwest::Response> {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let result = client
                .request(method.clone(), url)
                .header(ACCEPT_ENCODING, "identity")
                .send()
                .await;
            let retry = match &result {
                Ok(resp) => {
                    resp.status() == StatusCode::TOO_MANY_REQUESTS
                        || resp.status().is_server_error()
                }
                Err(e) => e.is_connect() || e.is_timeout(),
            };
            if !retry || attempt >= 3 {
                return result.with_context(|| format!("{method} {url}"));
            }
            tokio::time::sleep(Duration::from_millis(if attempt == 1 {
                500
            } else {
                2_000
            }))
            .await;
        }
    }

    async fn head(client: &Client, url: &str) -> anyhow::Result<Head> {
        let resp = send(client, Method::HEAD, url).await?;
        let header = |name| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        Ok(Head {
            status: resp.status(),
            length: header(CONTENT_LENGTH).and_then(|v| v.parse().ok()),
            content_type: header(CONTENT_TYPE).unwrap_or_default(),
            etag: header(ETAG),
        })
    }

    async fn get_json(client: &Client, url: &str) -> anyhow::Result<Value> {
        let resp = send(client, Method::GET, url).await?;
        let status = resp.status();
        if status != StatusCode::OK {
            anyhow::bail!("{status}");
        }
        resp.json()
            .await
            .with_context(|| format!("GET {url}: not JSON"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn nginx_etags_date_the_zip() {
            assert_eq!(etag_month("\"67e2bd39-c64f2\"").as_deref(), Some("2025.03"));
            assert_eq!(etag_month("\"69c915c2-8cb75\"").as_deref(), Some("2026.03"));
            assert_eq!(
                etag_month("W/\"69c915c2-8cb75\"").as_deref(),
                Some("2026.03")
            );
            assert_eq!(
                etag_month("\"f32c4df2ac5f47885761cccf2efbc536\""),
                None,
                "an opaque ETag"
            );
        }

        #[test]
        fn quran_com_language_names() {
            assert_eq!(language_code("english"), Some("en"));
            assert_eq!(language_code("arabic"), Some("ar"));
            assert_eq!(language_code("klingon"), None);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn groups_thousands() {
        assert_eq!(group(0), "0");
        assert_eq!(group(999), "999");
        assert_eq!(group(1_000), "1,000");
        assert_eq!(group(851_422), "851,422");
        assert_eq!(group(1_680_759_654), "1,680,759,654");
    }

    #[test]
    fn the_shipped_catalog_passes_offline() {
        let catalog = check_offline(&or_root(None, DEFAULT_CATALOG)).unwrap();
        assert!(
            kind_summary(&catalog)
                .starts_with(&format!("{} packs: 3 mushaf_fonts", catalog.packs.len()))
        );
    }

    #[test]
    fn a_broken_catalog_fails_with_every_problem() {
        let dir = tempfile::tempdir().unwrap();
        let src = or_root(None, DEFAULT_CATALOG);
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&src).unwrap()).unwrap();
        value["packs"][0]["itemCount"] = serde_json::json!(600);
        value["packs"][1]["recommended"] = serde_json::json!(true);
        let path = dir.path().join("catalog.json");
        std::fs::write(&path, value.to_string()).unwrap();
        std::fs::copy(
            src.with_file_name("catalog.schema.json"),
            dir.path().join("catalog.schema.json"),
        )
        .unwrap();
        let err = check_offline(&path).unwrap_err().to_string();
        assert!(err.contains("problem(s)"), "{err}");

        value["packs"][0]["unknown"] = serde_json::json!(1);
        std::fs::write(&path, value.to_string()).unwrap();
        let err = format!("{:#}", check_offline(&path).unwrap_err());
        assert!(
            err.contains("strict parse") && err.contains("unknown field"),
            "{err}"
        );
    }
}
