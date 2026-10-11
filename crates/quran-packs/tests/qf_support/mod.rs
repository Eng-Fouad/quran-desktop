//! Helpers for the QF adapter and revalidation tests (`tests/qf_*.rs`, `tests/revalidate_*.rs`). Owner: WP5d.
//!
//! - [`ApiServer`]: a std-only JSON API server routed on the **full request target** (path and query), so paginated
//!   endpoints (`…&page=1`, `…&page=2`) and per-language WBW requests serve different bodies (the shared
//!   `support::http::TestServer` routes on the path only; it still serves the audio files, with ranges and gates).
//! - [`upstream`]: points the adapters' API roots at a fresh [`ApiServer`] for the duration of one test. The roots are
//!   process-wide, so the guard also serialises the tests of one test binary.
//! - [`mini_core`]: a core.db with just `meta` and the `ayah` rows of some surahs (what the WBW location join reads).
//! - Catalog packs, QDC timings payloads, Quran.com pages and an adapter context with a given core.db.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use quran_core::content_db::geometry;
use quran_core::{CORE_SQL, CoreDb, NORMALIZER_VERSION};
use quran_packs::AdapterCtx;
use quran_packs::catalog::{Catalog, CatalogPack};
use quran_packs::jobs::JobHandle;
use quran_packs::revalidate::{QDC_API, QURAN_COM_API, RevalidateEnv};
use quran_types::PackKind;
use serde_json::{Value, json};

use crate::support::TestEnv;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 2026-10-10T00:00:00Z in Unix ms: the pinned test clock.
pub const T0: i64 = 1_791_590_400_000;
pub const DAY_MS: i64 = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// JSON API server
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct ApiRoute {
    body: Vec<u8>,
    /// Statuses answered before the body is served again.
    script: VecDeque<u16>,
    /// Every answer waits this long first (a slow upstream).
    delay: Duration,
}

#[derive(Default)]
struct ApiState {
    routes: Mutex<HashMap<String, ApiRoute>>,
    log: Mutex<Vec<String>>,
}

/// A JSON API on `127.0.0.1`, routed on the exact request target; unknown targets answer 404.
pub struct ApiServer {
    addr: SocketAddr,
    state: Arc<ApiState>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// The path and query of a URL (what the server routes on).
pub fn target(url: &str) -> String {
    let u = url::Url::parse(url).unwrap();
    match u.query() {
        Some(q) => format!("{}?{q}", u.path()),
        None => u.path().to_owned(),
    }
}

impl ApiServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(ApiState::default());
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (state, stop) = (Arc::clone(&state), Arc::clone(&stop));
            std::thread::Builder::new()
                .name("qf-api".into())
                .spawn(move || {
                    for conn in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(stream) = conn else { continue };
                        let state = Arc::clone(&state);
                        let _ = std::thread::Builder::new()
                            .name("qf-api-conn".into())
                            .spawn(move || serve(&state, stream));
                    }
                })
                .unwrap()
        };
        Self {
            addr,
            state,
            stop,
            thread: Some(thread),
        }
    }

    /// `http://127.0.0.1:{port}`.
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    /// Serves `value` at `url` (matched on its path and query).
    pub fn json(&self, url: &str, value: &Value) {
        let mut routes = lock(&self.state.routes);
        let script = routes
            .remove(&target(url))
            .map(|r| r.script)
            .unwrap_or_default();
        routes.insert(
            target(url),
            ApiRoute {
                body: serde_json::to_vec(value).unwrap(),
                script,
                delay: Duration::ZERO,
            },
        );
    }

    /// Every later answer at `url` waits `delay` first (a slow upstream); `Duration::ZERO` restores it.
    pub fn slow(&self, url: &str, delay: Duration) {
        if let Some(route) = lock(&self.state.routes).get_mut(&target(url)) {
            route.delay = delay;
        }
    }

    /// The next `times` requests to `url` answer `status`.
    pub fn fail(&self, url: &str, status: u16, times: usize) {
        let mut routes = lock(&self.state.routes);
        let route = routes.entry(target(url)).or_insert_with(|| ApiRoute {
            body: Vec::new(),
            script: VecDeque::new(),
            delay: Duration::ZERO,
        });
        route.script.extend(std::iter::repeat_n(status, times));
    }

    /// Drops the statuses still scripted for `url`: it serves its body again.
    pub fn recover(&self, url: &str) {
        if let Some(route) = lock(&self.state.routes).get_mut(&target(url)) {
            route.script.clear();
        }
    }

    /// Requests made to `url` (exact target).
    pub fn hits(&self, url: &str) -> usize {
        let t = target(url);
        lock(&self.state.log).iter().filter(|r| **r == t).count()
    }

    /// Every request target so far.
    pub fn requests(&self) -> Vec<String> {
        lock(&self.state.log).clone()
    }

    pub fn clear_log(&self) {
        lock(&self.state.log).clear();
    }
}

impl Drop for ApiServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn serve(state: &ApiState, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(clone) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(clone);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return;
    };
    let (method, target) = (method.to_owned(), target.to_owned());
    loop {
        let mut h = String::new();
        match reader.read_line(&mut h) {
            Ok(0) | Err(_) => break,
            Ok(_) if h.trim_end().is_empty() => break,
            Ok(_) => {}
        }
    }
    lock(&state.log).push(target.clone());
    let reply = {
        let mut routes = lock(&state.routes);
        match routes.get_mut(&target) {
            Some(route) => match route.script.pop_front() {
                Some(status) => (status, format!("{status}").into_bytes(), route.delay),
                None => (200, route.body.clone(), route.delay),
            },
            None => (404, b"{\"status\":404}".to_vec(), Duration::ZERO),
        }
    };
    let (status, body, delay) = reply;
    if !delay.is_zero() {
        std::thread::sleep(delay);
    }
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        if status == 200 { "OK" } else { "Status" },
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    if !method.eq_ignore_ascii_case("HEAD") {
        let _ = stream.write_all(&body);
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

// ---------------------------------------------------------------------------------------------------------------
// API roots
// ---------------------------------------------------------------------------------------------------------------

static SERIAL: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// The upstream APIs of one test: the adapters' roots point at `api` until the guard drops.
pub struct Upstream {
    pub api: ApiServer,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

pub async fn upstream() -> Upstream {
    let serial = SERIAL.lock().await;
    let api = ApiServer::start();
    QURAN_COM_API.set(Some(&format!("{}/api/v4", api.base())));
    QDC_API.set(Some(&format!("{}/api/qdc", api.base())));
    Upstream {
        api,
        _serial: serial,
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        QURAN_COM_API.set(None);
        QDC_API.set(None);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// core.db, catalog, contexts
// ---------------------------------------------------------------------------------------------------------------

/// Words per ayah (end marker included) of al-Fatiha, as in the real core.db.
pub const FATIHA_WORDS: [u32; 7] = [5, 5, 3, 4, 5, 4, 10];

/// Words per ayah of `surah`: al-Fatiha's real counts, else the surah's total spread evenly (the last ayah takes the
/// rest) — consistent with `geometry`, which is all the location join needs.
pub fn words_per_ayah(surah: u32) -> Vec<u32> {
    if surah == 1 {
        return FATIHA_WORDS.to_vec();
    }
    let ayahs = geometry::surah_ayah_count(surah).unwrap();
    let words = geometry::surah_word_ids(surah).unwrap();
    let total = words.end() - words.start() + 1;
    let each = total / ayahs;
    let mut out = vec![each; ayahs as usize];
    *out.last_mut().unwrap() += total - each * ayahs;
    out
}

/// A core.db at `dir/core.db` with `meta` and the `ayah` rows of `surahs`.
pub fn mini_core(dir: &Path, surahs: &[u32]) -> CoreDb {
    let path = dir.join("core.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(CORE_SQL).unwrap();
        // Only `ayah` rows are written: no `surah` rows for them to reference.
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        for (k, v) in [
            ("schema_version", "1".to_owned()),
            ("normalizer_version", NORMALIZER_VERSION.to_string()),
            ("source", "test".to_owned()),
            ("built_at", "2026-10-10T00:00:00Z".to_owned()),
            ("word_count", "83665".to_owned()),
        ] {
            conn.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", (k, v))
                .unwrap();
        }
        for &surah in surahs {
            let ids = geometry::surah_ayah_ids(surah).unwrap();
            let mut word = *geometry::surah_word_ids(surah).unwrap().start();
            for ((ayah_id, ayah), n) in ids.zip(1u32..).zip(words_per_ayah(surah)) {
                conn.execute(
                    "INSERT INTO ayah (id, surah, ayah, juz, hizb, rub, manzil, ruku, first_word_id, last_word_id,
                                       text_hafs, text_imlaei, norm_loose, norm_strict)
                     VALUES (?1, ?2, ?3, 1, 1, 1, 1, 1, ?4, ?5, '', '', '', '')",
                    (ayah_id, surah, ayah, word, word + n - 1),
                )
                .unwrap();
                word += n;
            }
        }
    }
    CoreDb::open(&path).unwrap()
}

/// An adapter context on `env` with another core.db.
pub fn ctx_with_core(
    env: &TestEnv,
    core: &CoreDb,
    pack_id: &str,
    kind: PackKind,
    job: Option<JobHandle>,
    pin: bool,
) -> AdapterCtx {
    let mut ctx = env.ctx(pack_id, kind, job, pin);
    ctx.core = core.clone();
    ctx
}

/// A catalog pack around `source`.
pub fn pack(id: &str, kind: &str, size_bytes: u64, source: Value) -> CatalogPack {
    serde_json::from_value(json!({
        "id": id,
        "kind": kind,
        "title": { "en": id, "ar": "حزمة" },
        "description": { "en": id, "ar": "حزمة" },
        "version": "2026.10",
        "installMode": "on_demand",
        "sizeBytes": size_bytes,
        "itemCount": 114,
        "revalidateDays": 7,
        "attribution": { "text": { "en": "Quran.com", "ar": "قرآن" }, "url": "https://quran.com", "licence": "QF terms" },
        "source": source
    }))
    .unwrap()
}

pub fn tafsir_pack(id: &str, resource_id: u32) -> CatalogPack {
    pack(
        id,
        "tafsir",
        11_000_000,
        json!({ "adapter": "qurancom_v4_tafsir_by_chapter", "resourceId": resource_id }),
    )
}

pub fn wbw_pack(language: &str) -> CatalogPack {
    pack(
        &format!("wbw.{language}"),
        "wbw",
        3_000_000,
        json!({ "adapter": "qurancom_v4_wbw", "language": language }),
    )
}

/// `audio.qdc.{reciter}` served by `hosts` (`host:port` of the file server).
pub fn audio_pack(reciter: u32, hosts: &[String]) -> CatalogPack {
    pack(
        &format!("audio.qdc.{reciter}"),
        "recitation",
        1_000_000,
        json!({ "adapter": "qdc_audio", "reciterId": reciter,
                "name": { "en": "Reciter", "ar": "قارئ" },
                "basmalaInFile": false, "hosts": hosts, "wordLevel": true }),
    )
}

pub fn catalog(packs: Vec<CatalogPack>) -> Arc<Catalog> {
    Arc::new(Catalog {
        schema: None,
        catalog_version: 1,
        generated_at: "2026-10-10".into(),
        packs,
    })
}

/// The revalidator's environment on `env` with `core` and `catalog`.
pub fn revalidate_env(env: &TestEnv, core: &CoreDb, catalog: Arc<Catalog>) -> RevalidateEnv {
    RevalidateEnv {
        packs_root: env.root.clone(),
        http: env.http.clone(),
        core: core.clone(),
        user: env.user.clone(),
        content: env.content.clone(),
        writers: env.writers.clone(),
        catalog,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Upstream payloads
// ---------------------------------------------------------------------------------------------------------------

/// A QDC `audio_files` answer for `chapter`: ayah `a` spans `[(a−1)·step, a·step)` with two word segments; `shift`
/// moves every timestamp (a re-timed upload).
pub fn qdc_files(chapter: u32, audio_url: &str, step_ms: u32, shift: u32) -> Value {
    let ayahs = geometry::surah_ayah_count(chapter).unwrap();
    let verses: Vec<Value> = (1..=ayahs)
        .map(|a| {
            let from = (a - 1) * step_ms + shift;
            let mid = from + step_ms / 2;
            let to = a * step_ms + shift;
            json!({
                "verse_key": format!("{chapter}:{a}"),
                "timestamp_from": from, "timestamp_to": to, "duration": to - from,
                "segments": [[1, from, mid], [2, mid, to]]
            })
        })
        .collect();
    json!({ "audio_files": [{
        "id": 900 + chapter, "chapter_id": chapter, "file_size": 1.0, "format": "mp3",
        "audio_url": audio_url, "duration": ayahs * step_ms + shift, "verse_timings": verses
    }] })
}

/// One Quran.com tafsir page: `(verse_key, text)` rows, `next_page` as given.
pub fn tafsir_page(rows: &[(&str, &str)], next_page: Option<u32>) -> Value {
    json!({
        "tafsirs": rows.iter().enumerate().map(|(i, (key, text))| json!({
            "id": 1000 + i, "resource_id": 169, "verse_key": key, "language_id": 38, "text": text, "slug": "x"
        })).collect::<Vec<_>>(),
        "pagination": { "per_page": 300, "current_page": 1, "next_page": next_page, "total_pages": 1,
                        "total_records": rows.len() }
    })
}

/// One verse of a WBW page: `(verse_key, [(position, translation)], end-marker position)`.
pub type WbwVerse<'a> = (&'a str, &'a [(u32, &'a str)], u32);

/// One Quran.com `verses/by_chapter` page with words.
pub fn wbw_page(verses: &[WbwVerse<'_>], next_page: Option<u32>) -> Value {
    json!({
        "verses": verses.iter().map(|(key, words, end)| {
            let mut ws: Vec<Value> = words.iter().map(|(pos, tr)| json!({
                "id": 10 * pos, "position": pos, "char_type_name": "word", "location": format!("{key}:{pos}"),
                "translation": { "text": tr, "language_name": "english" },
                "transliteration": { "text": format!("tl-{pos}"), "language_name": "english" }
            })).collect();
            ws.push(json!({
                "id": 10 * end, "position": end, "char_type_name": "end", "location": format!("{key}:{end}"),
                "translation": { "text": "(1)", "language_name": "english" },
                "transliteration": { "text": null, "language_name": "english" }
            }));
            json!({ "id": 1, "verse_key": key, "words": ws })
        }).collect::<Vec<_>>(),
        "pagination": { "per_page": 300, "current_page": 1, "next_page": next_page, "total_pages": 1,
                        "total_records": verses.len() }
    })
}
