//! `build-core` pipeline tests that need no network and no real cache (WP3a).
//!
//! `xtask` is a binary crate, so the pipeline modules are compiled into this test crate by path. They only refer to
//! each other through `super::`, which keeps this inclusion exact; `build/mod.rs` (which needs `crate::cli` and
//! `crate::verify`) is exercised end to end by `build_qdc.rs`. The modules' own unit tests run here too.
//!
//! Covered here: the raw-response cache against a local HTTP server (fetch, User-Agent, reuse, 7-day expiry,
//! request-shape refresh, retries, fatal statuses, invalid responses, `--offline`), and the deterministic writer.

#![allow(dead_code)]

// The modules' directory: a `#[path]` on each would resolve through `tests/build/`, which does not exist (only
// Windows normalises `..` before opening the file).
#[path = "../src/build"]
mod build {
    pub mod derive;
    pub mod model;
    pub mod qdc;
    pub mod tanzil;
    pub mod write;
}

use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use anyhow::{Context, anyhow, ensure};

use build::derive::{
    AyahRow, CoreData, DeriveReport, LineRow, PageRow, RangeRow, RukuRow, SajdaRow, SurahRow,
    WordRow,
};
use build::model::{LineKind, RevelationPlace};
use build::qdc::{self, Endpoints, PrepareReport};
use build::tanzil::SajdaKind;
use build::write::{self, BuildMeta};

// ---- a tiny HTTP/1.1 server --------------------------------------------------------------------------------------

/// A canned answer for one request target (path + query).
#[derive(Clone)]
struct Canned {
    status: u16,
    body: Vec<u8>,
}

#[derive(Default)]
struct ServerState {
    /// Every request: (target, User-Agent).
    requests: Vec<(String, String)>,
    /// Targets whose next answers are these (consumed in order) before the normal answer.
    scripted: BTreeMap<String, VecDeque<Canned>>,
}

struct Server {
    addr: SocketAddr,
    state: Arc<Mutex<ServerState>>,
}

impl Server {
    fn start() -> anyhow::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let state = Arc::new(Mutex::new(ServerState::default()));
        let shared = Arc::clone(&state);
        std::thread::Builder::new()
            .name("test-http".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let shared = Arc::clone(&shared);
                    // One thread per connection; a failed spawn just drops the connection (the client retries).
                    let _ = std::thread::Builder::new()
                        .name("test-http-conn".into())
                        .spawn(move || serve(stream, &shared));
                }
            })?;
        Ok(Self { addr, state })
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints {
            qdc_api: format!("http://{}/api/qdc", self.addr),
            tanzil: format!("http://{}/tanzil/quran-data.xml", self.addr),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut ServerState) -> T) -> T {
        f(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }

    fn request_count(&self) -> usize {
        self.with(|s| s.requests.len())
    }

    fn requests_to(&self, prefix: &str) -> usize {
        self.with(|s| {
            s.requests
                .iter()
                .filter(|(t, _)| t.starts_with(prefix))
                .count()
        })
    }

    fn script(&self, target: &str, answers: Vec<Canned>) {
        self.with(|s| s.scripted.insert(target.to_owned(), answers.into()));
    }
}

fn serve(stream: TcpStream, state: &Mutex<ServerState>) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut user_agent = String::new();
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) | Err(_) => return,
            Ok(_) if header == "\r\n" => break,
            Ok(_) => {
                if let Some((name, value)) = header.split_once(':')
                    && name.eq_ignore_ascii_case("user-agent")
                {
                    value.trim().clone_into(&mut user_agent);
                }
            }
        }
    }
    let target = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_owned();
    let answer = {
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        state.requests.push((target.clone(), user_agent));
        state
            .scripted
            .get_mut(&target)
            .and_then(VecDeque::pop_front)
    }
    .unwrap_or_else(|| default_answer(&target));
    let reason = match answer.status {
        200 => "OK",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Status",
    };
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nRetry-After: 0\r\n\
         Connection: close\r\n\r\n",
        answer.status,
        answer.body.len()
    );
    // One write (and no Nagle delay), so the client never waits for a delayed ACK between head and body.
    let mut response = head.into_bytes();
    response.extend_from_slice(&answer.body);
    let mut stream = stream;
    let _ = stream.set_nodelay(true);
    let _ = stream.write_all(&response);
    let _ = stream.flush();
}

fn ok(body: impl Into<Vec<u8>>) -> Canned {
    Canned {
        status: 200,
        body: body.into(),
    }
}

/// A valid response for every target the qdc adapter requests.
fn default_answer(target: &str) -> Canned {
    if target.starts_with("/api/qdc/chapters?language=en") {
        return ok(chapters_json());
    }
    if target == "/tanzil/quran-data.xml" {
        return ok(build::tanzil::tests::synthetic_xml());
    }
    if let Some(rest) = target.strip_prefix("/api/qdc/verses/by_page/")
        && let Some((page, query)) = rest.split_once('?')
        && let Ok(page) = page.parse::<u32>()
        && query.contains(&format!("word_fields={}", qdc::WORD_FIELDS))
    {
        return ok(page_json(page, "null"));
    }
    Canned {
        status: 404,
        body: b"not found".to_vec(),
    }
}

fn chapters_json() -> String {
    let chapters: Vec<String> = (1..=114)
        .map(|id| {
            format!(
                r#"{{"id":{id},"revelation_place":"makkah","revelation_order":{id},"bismillah_pre":{},
                "name_simple":"S{id}","name_complex":"S{id}","name_arabic":"س","verses_count":5,"pages":[1,1],
                "translated_name":{{"language_name":"english","name":"N{id}"}}}}"#,
                id != 1 && id != 9
            )
        })
        .collect();
    format!(r#"{{"chapters":[{}]}}"#, chapters.join(","))
}

/// One word on the page (the cache check is per file, so any page-consistent content is valid).
fn page_json(page: u32, next_page: &str) -> String {
    let line = if page <= 2 { 9 } else { 1 };
    format!(
        r#"{{"verses":[{{"id":1,"verse_key":"1:1","juz_number":1,"hizb_number":1,"rub_el_hizb_number":1,
        "manzil_number":1,"ruku_number":1,"sajdah_number":null,"page_number":{page},"words":[{{"id":1,"position":1,
        "location":"1:1:1","char_type_name":"word","page_number":{page},"line_number":{line},"code_v1":"ﭑ",
        "code_v2":"ﱁ","text_qpc_hafs":"بِسۡمِ","text_imlaei":"بِسْمِ"}}]}}],
        "pagination":{{"per_page":1,"current_page":1,"next_page":{next_page},"total_pages":1,"total_records":1}}}}"#
    )
}

fn page_target(page: u32, mushaf: u32) -> String {
    format!(
        "/api/qdc/verses/by_page/{page}?mushaf={mushaf}&per_page=all&words=true&word_fields={}",
        qdc::WORD_FIELDS
    )
}

fn page_file(cache: &Path, page: u32, mushaf: u32) -> std::path::PathBuf {
    cache
        .join("qdc")
        .join("by_page")
        .join(format!("m{mushaf}"))
        .join(format!("p{page:03}.json"))
}

const ALL_FILES: usize = 1 + 3 * 604 + 1;

// ---- cache tests -------------------------------------------------------------------------------------------------

#[test]
fn the_cache_is_fetched_reused_and_refreshed() -> anyhow::Result<()> {
    let server = Server::start()?;
    let dir = tempfile::tempdir()?;
    let cache = dir.path();
    let endpoints = server.endpoints();

    // An empty cache is fetched completely, with the documented User-Agent.
    let report = qdc::prepare(cache, &endpoints, false, 4)?;
    assert_eq!(
        report,
        PrepareReport {
            fetched_missing: ALL_FILES,
            ..PrepareReport::default()
        }
    );
    assert_eq!(server.request_count(), ALL_FILES);
    let agents: Vec<String> =
        server.with(|s| s.requests.iter().map(|(_, ua)| ua.clone()).collect());
    assert!(
        agents
            .iter()
            .all(|ua| ua == concat!("QuranForDesktop-xtask/", env!("CARGO_PKG_VERSION"))),
        "User-Agent: {:?}",
        agents.first()
    );
    assert!(cache.join("qdc").join("chapters.json").is_file());
    assert!(page_file(cache, 604, 19).is_file());
    assert!(qdc::tanzil_path(cache).is_file());
    assert!(
        std::fs::read_dir(cache.join("qdc").join("by_page").join("m1"))?
            .flatten()
            .all(|e| e.file_name().to_string_lossy().ends_with(".json")),
        "no .part files are left behind"
    );

    // A complete, fresh, valid cache needs no request, online or offline.
    assert_eq!(qdc::prepare(cache, &endpoints, false, 4)?.cached, ALL_FILES);
    assert_eq!(qdc::prepare(cache, &endpoints, true, 4)?.cached, ALL_FILES);
    assert_eq!(server.request_count(), ALL_FILES);

    // An 8-day-old QDC file is refetched (QF terms); an old Tanzil file is not; a file in an old request shape is.
    let stale = page_file(cache, 5, 2);
    std::fs::File::options()
        .write(true)
        .open(&stale)?
        .set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 3600))?;
    std::fs::File::options()
        .write(true)
        .open(qdc::tanzil_path(cache))?
        .set_modified(SystemTime::now() - Duration::from_secs(400 * 24 * 3600))?;
    let old_shape = page_file(cache, 6, 19);
    std::fs::write(
        &old_shape,
        page_json(6, "null").replace("\"text_imlaei\"", "\"text_imlaei_simple\""),
    )?;

    let offline = qdc::prepare(cache, &endpoints, true, 4);
    let message = format!(
        "{:#}",
        offline
            .err()
            .ok_or_else(|| anyhow!("--offline must refuse"))?
    );
    assert!(
        message.contains("--offline")
            && message.contains("1 older than 7 days")
            && message.contains("1 not in"),
        "{message}"
    );
    assert_eq!(server.request_count(), ALL_FILES, "--offline never fetches");

    let report = qdc::prepare(cache, &endpoints, false, 2)?;
    assert_eq!(
        report,
        PrepareReport {
            cached: ALL_FILES - 2,
            refetched_stale: 1,
            refetched_invalid: 1,
            ..PrepareReport::default()
        }
    );
    assert_eq!(server.request_count(), ALL_FILES + 2);
    let age = SystemTime::now().duration_since(std::fs::metadata(&stale)?.modified()?)?;
    assert!(
        age < Duration::from_secs(3600),
        "the stale file was rewritten"
    );
    assert!(std::fs::read_to_string(&old_shape)?.contains("\"text_imlaei\""));
    Ok(())
}

#[test]
fn transient_failures_are_retried_and_others_are_not() -> anyhow::Result<()> {
    let server = Server::start()?;
    let dir = tempfile::tempdir()?;
    let cache = dir.path();
    let endpoints = server.endpoints();
    qdc::prepare(cache, &endpoints, false, 4)?;
    let base = server.request_count();

    // 503 twice (Retry-After: 0), then the real answer.
    let target = page_target(7, 1);
    let unavailable = Canned {
        status: 503,
        body: b"busy".to_vec(),
    };
    server.script(&target, vec![unavailable.clone(), unavailable]);
    std::fs::remove_file(page_file(cache, 7, 1))?;
    let report = qdc::prepare(cache, &endpoints, false, 4)?;
    assert_eq!(report.fetched_missing, 1);
    assert_eq!(
        server.requests_to(&target) - 1,
        3,
        "two retries after the first fetch of the full run"
    );
    assert!(page_file(cache, 7, 1).is_file());
    let after_retry = server.request_count();
    assert_eq!(after_retry, base + 3);

    // 404 is final: no retry, nothing written.
    let target = page_target(8, 1);
    server.script(
        &target,
        vec![Canned {
            status: 404,
            body: b"gone".to_vec(),
        }],
    );
    std::fs::remove_file(page_file(cache, 8, 1))?;
    let error = qdc::prepare(cache, &endpoints, false, 4)
        .err()
        .context("404 must fail")?;
    assert!(format!("{error:#}").contains("404"), "{error:#}");
    assert_eq!(server.request_count(), after_retry + 1);
    assert!(!page_file(cache, 8, 1).exists());
    assert_eq!(
        qdc::prepare(cache, &endpoints, false, 4)?.fetched_missing,
        1,
        "the next run fetches it"
    );

    // A response that fails validation (paginated) is never written.
    let target = page_target(9, 2);
    server.script(&target, vec![ok(page_json(9, "2"))]);
    std::fs::remove_file(page_file(cache, 9, 2))?;
    let error = qdc::prepare(cache, &endpoints, false, 4)
        .err()
        .context("a paginated page must fail")?;
    let message = format!("{error:#}");
    assert!(
        message.contains("invalid response") && message.contains("next_page"),
        "{message}"
    );
    assert!(!page_file(cache, 9, 2).exists());

    // With the server answering normally again, the cache completes.
    let report = qdc::prepare(cache, &endpoints, false, 4)?;
    assert_eq!(report.fetched_missing, 1);
    assert_eq!(report.cached, ALL_FILES - 1);
    Ok(())
}

// ---- the writer --------------------------------------------------------------------------------------------------

/// A minimal but schema-valid `CoreData`: one surah of one ayah (one word + its end marker) on one page of one layout.
fn tiny_core() -> CoreData {
    let word = |id: u32, is_end: bool| WordRow {
        id,
        ayah_id: 1,
        surah: 1,
        ayah: 1,
        position: id,
        is_end,
        text_hafs: if is_end {
            "\u{06DD}١".into()
        } else {
            "ٱلرَّحۡمَٰنِ".into()
        },
        text_imlaei: (!is_end).then(|| "الرَّحْمَٰنِ".into()),
        norm_loose: (!is_end).then(|| "الرحمن".into()),
        code_v1: "ﭑ".into(),
        code_v2: "ﱁ".into(),
    };
    let range = |id| RangeRow {
        id,
        first_ayah_id: 1,
        last_ayah_id: 1,
    };
    CoreData {
        surahs: vec![SurahRow {
            id: 1,
            name_ar: "الفاتحة".into(),
            name_simple: "Al-Fatihah".into(),
            name_complex: "Al-Fātiĥah".into(),
            name_en: "The Opening".into(),
            revelation_place: RevelationPlace::Makkah,
            revelation_order: 5,
            ayah_count: 1,
            first_ayah_id: 1,
            rukus: 1,
            bismillah_pre: false,
            header_cp: Some(0xFC45),
        }],
        juzs: vec![range(1)],
        hizbs: vec![range(1)],
        rubs: vec![range(1)],
        manzils: vec![range(1)],
        rukus: vec![RukuRow {
            id: 1,
            surah: 1,
            first_ayah_id: 1,
            last_ayah_id: 1,
        }],
        sajdas: vec![SajdaRow {
            id: 1,
            ayah_id: 1,
            kind: SajdaKind::Obligatory,
        }],
        ayahs: vec![AyahRow {
            id: 1,
            surah: 1,
            ayah: 1,
            juz: 1,
            hizb: 1,
            rub: 1,
            manzil: 1,
            ruku: 1,
            sajda: 2,
            flags: 15,
            first_word_id: 1,
            last_word_id: 2,
            text_hafs: "ٱلرَّحۡمَٰنِ \u{06DD}١".into(),
            text_imlaei: "الرَّحْمَٰنِ".into(),
            norm_loose: "الرحمن".into(),
            norm_strict: "الرحمن".into(),
        }],
        words: vec![word(1, false), word(2, true)],
        pages: vec![PageRow {
            mushaf_id: 1,
            page: 1,
            first_word_id: 1,
            last_word_id: 2,
            first_ayah_id: 1,
            last_ayah_id: 1,
        }],
        lines: vec![
            LineRow {
                mushaf_id: 1,
                page: 1,
                line: 1,
                kind: LineKind::SurahName,
                centered: true,
                surah_id: Some(1),
                words: None,
            },
            LineRow {
                mushaf_id: 1,
                page: 1,
                line: 2,
                kind: LineKind::Ayah,
                centered: true,
                surah_id: None,
                words: Some((1, 2)),
            },
        ],
        report: DeriveReport::default(),
    }
}

fn tiny_meta() -> BuildMeta {
    BuildMeta {
        source: "qdc".into(),
        source_manifest_sha256: "0".repeat(64),
        tanzil_sha256: "1".repeat(64),
        built_at: "2026-10-10T00:00:00Z".into(),
        builder: "xtask test".into(),
        licence_note: "test".into(),
    }
}

#[test]
fn the_writer_is_deterministic_and_finalises_the_database() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let data = tiny_core();
    let (a, b) = (dir.path().join("a.db"), dir.path().join("sub-dir-b.db"));
    let stats = write::write(&a, &data, &tiny_meta())?;
    write::write(&b, &data, &tiny_meta())?;
    assert_eq!(
        std::fs::read(&a)?,
        std::fs::read(&b)?,
        "same rows, same bytes"
    );
    assert_eq!(stats.fts_rows, 1);
    assert_eq!(stats.vocab_terms, 1);
    assert_eq!(stats.bytes, std::fs::metadata(&a)?.len());
    assert!(
        write::write(&a, &data, &tiny_meta()).is_err(),
        "never overwrites"
    );

    let mut other_meta = tiny_meta();
    other_meta.built_at = "2026-10-11T00:00:00Z".into();
    let c = dir.path().join("c.db");
    write::write(&c, &data, &other_meta)?;
    assert_ne!(
        std::fs::read(&a)?,
        std::fs::read(&c)?,
        "built_at is part of the file"
    );

    let conn =
        rusqlite::Connection::open_with_flags(&a, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let text = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, String>(0));
    assert_eq!(text("PRAGMA journal_mode")?, "delete");
    assert_eq!(
        text("SELECT value FROM meta WHERE key = 'schema_version'")?,
        "1"
    );
    assert_eq!(
        text("SELECT value FROM meta WHERE key = 'normalizer_version'")?,
        quran_core::NORMALIZER_VERSION.to_string()
    );
    assert_eq!(
        text("SELECT value FROM meta WHERE key = 'word_count'")?,
        "2"
    );
    assert_eq!(text("SELECT term FROM vocab_loose")?, "الرحمن");
    assert_eq!(
        text(
            "SELECT code || '|' || name || '|' || pages || '|' || lines_per_page || '|' || glyph_column FROM mushaf"
        )?,
        "v2|Madani Mushaf 1421H (QCF V2)|1|2|code_v2"
    );
    let hit: u32 = conn.query_row(
        "SELECT rowid FROM ayah_fts WHERE ayah_fts MATCH 'loose : (\"الرح\"*)'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(hit, 1);
    let keys: Vec<String> = conn
        .prepare("SELECT key FROM meta ORDER BY key")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    assert_eq!(
        keys,
        [
            "ayah_count",
            "builder",
            "built_at",
            "licence_note",
            "normalizer_version",
            "schema_version",
            "source",
            "source_manifest_sha256",
            "tanzil_sha256",
            "word_count"
        ]
    );
    let line: (u32, Option<u32>, Option<u32>) = conn.query_row(
        "SELECT kind, surah_id, first_word_id FROM line WHERE line = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(line, (1, Some(1), None));
    ensure!(
        text("SELECT kind FROM sajda")? == "obligatory",
        "sajda kind is stored as text"
    );
    Ok(())
}

#[test]
fn the_writer_rejects_rows_the_schema_forbids() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let mut data = tiny_core();
    if let Some(line) = data.lines.first_mut() {
        line.words = Some((1, 1)); // a surah_name line with words violates the line CHECK
    }
    let path = dir.path().join("bad.db");
    assert!(write::write(&path, &data, &tiny_meta()).is_err());
    Ok(())
}
