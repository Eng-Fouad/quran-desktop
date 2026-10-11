//! Helpers for the pack manager tests (`tests/manager_*.rs`). Owner: WP5e.
//!
//! - [`Events`]: a `PackEvents` recorder (download events, `packs_changed` notifications, network changes).
//! - [`Fixture`]: a `PackManager` on a [`TestEnv`] (temp `packs/`, real user.db and content.db) with a test catalog,
//!   the fast HTTP config, an idle revalidator schedule and immediate change notifications; [`Fixture::restart`] builds
//!   a second manager on the same data, as the next app start would.
//! - Catalog packs for the test server: Mushaf pages, decor, recitations, Quran.com chapters and QuranEnc packs.
//! - [`word_core`]: a mini core.db with the `ayah` and `word` rows of some surahs (WBW joins and word texts).
//! - [`install_pack_db`]: a QuranEnc-style pack DB installed through the real atomic flip.
//!
//! The directory is named after the owned `manager_*` prefix; it is not a test target.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use quran_core::content_db::geometry;
use quran_core::{
    CoreDb, FootnoteInput, PackDbWriter, PackEntryInput, PackMeta, PackTokenizer, UserDb,
};
use quran_packs::StagedPack;
use quran_packs::catalog::{Catalog, CatalogPack};
use quran_packs::install::{self, Staging};
use quran_packs::manager::{ManagerOptions, PackEvents, PackManager, PackManagerConfig};
use quran_packs::revalidate::RevalidatorConfig;
use quran_types::{DownloadEvent, JobPhase, PackInfo, PackKind, PackState, TextDir};
use serde_json::{Value, json};

use crate::support::http::{Route, TestServer};
use crate::support::{TestEnv, event_job, event_name, fast_http_config};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 2026-10-10T00:00:00Z in Unix ms (the pinned test clock of the QF tests).
pub const T0: i64 = 1_791_590_400_000;
pub const DAY_MS: i64 = 86_400_000;
/// The protocol base the tests give the font lane.
pub const BASE: &str = "quran://localhost/";

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

/// Everything the manager reports.
#[derive(Default)]
pub struct Events {
    downloads: Mutex<Vec<DownloadEvent>>,
    changed: Mutex<Vec<Vec<String>>>,
    network: Mutex<Vec<bool>>,
}

impl PackEvents for Events {
    fn download(&self, e: DownloadEvent) {
        lock(&self.downloads).push(e);
    }

    fn packs_changed(&self, pack_ids: Vec<String>) {
        lock(&self.changed).push(pack_ids);
    }

    fn network(&self, online: bool) {
        lock(&self.network).push(online);
    }
}

impl Events {
    pub fn downloads(&self) -> Vec<DownloadEvent> {
        lock(&self.downloads).clone()
    }

    /// Event names of one job without `progress`.
    pub fn lifecycle(&self, job_id: u32) -> Vec<&'static str> {
        self.downloads()
            .iter()
            .filter(|e| event_job(e) == job_id)
            .map(event_name)
            .filter(|n| *n != "progress")
            .collect()
    }

    /// The terminal phase of a job, once it has one.
    pub fn outcome(&self, job_id: u32) -> Option<JobPhase> {
        self.downloads()
            .iter()
            .filter(|e| event_job(e) == job_id)
            .find_map(|e| match e {
                DownloadEvent::Completed { .. } => Some(JobPhase::Completed),
                DownloadEvent::Failed { .. } => Some(JobPhase::Failed),
                DownloadEvent::Cancelled { .. } => Some(JobPhase::Cancelled),
                DownloadEvent::Paused { .. } => Some(JobPhase::Paused),
                _ => None,
            })
    }

    /// Every pack id reported changed so far.
    pub fn changed(&self) -> BTreeSet<String> {
        lock(&self.changed).iter().flatten().cloned().collect()
    }

    pub fn network(&self) -> Vec<bool> {
        lock(&self.network).clone()
    }

    pub fn clear(&self) {
        lock(&self.downloads).clear();
        lock(&self.changed).clear();
        lock(&self.network).clear();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------------------------

/// Test tunables: the fast HTTP layer, a revalidator that never runs on its own, immediate change events.
pub fn options() -> ManagerOptions {
    let hour = Duration::from_secs(3_600);
    ManagerOptions {
        http: Some(fast_http_config()),
        revalidator: RevalidatorConfig {
            first_delay: hour,
            interval: hour,
            offline_retry: hour,
            ..RevalidatorConfig::default()
        },
        protocol_base: BASE.to_owned(),
        changes_coalesce: Duration::ZERO,
        ..ManagerOptions::default()
    }
}

pub struct Fixture {
    pub env: TestEnv,
    pub catalog: Catalog,
    pub events: Arc<Events>,
    pub manager: PackManager,
}

impl Fixture {
    /// A manager on a fresh environment (inside a tokio runtime).
    pub fn new(packs: Vec<CatalogPack>) -> Self {
        Self::on(TestEnv::new(), catalog(packs))
    }

    pub fn on(env: TestEnv, catalog: Catalog) -> Self {
        let events = Arc::new(Events::default());
        let manager = manager(&env, &catalog, Arc::clone(&events), 2 * 1024 * 1024 * 1024);
        Self {
            env,
            catalog,
            events,
            manager,
        }
    }

    /// A second manager on the same data and catalog, with its own events (the next app start).
    pub fn restart(&self) -> (PackManager, Arc<Events>) {
        let events = Arc::new(Events::default());
        let manager = manager(
            &self.env,
            &self.catalog,
            Arc::clone(&events),
            self.manager.stream_cache_cap_bytes(),
        );
        (manager, events)
    }

    pub fn info(&self, pack_id: &str) -> PackInfo {
        self.manager
            .list()
            .unwrap()
            .into_iter()
            .find(|p| p.id == pack_id)
            .unwrap()
    }

    pub fn state(&self, pack_id: &str) -> PackState {
        self.info(pack_id).state
    }

    /// Waits for job `job_id` to reach a terminal phase (completed, failed, cancelled or paused).
    pub async fn wait_job(&self, job_id: u32) -> JobPhase {
        wait_job(&self.events, job_id).await
    }
}

/// A manager on `env` with `catalog`, the network allowed and the given stream-cache cap.
pub fn manager(env: &TestEnv, catalog: &Catalog, events: Arc<Events>, cap: u64) -> PackManager {
    PackManager::with_catalog(
        PackManagerConfig {
            packs_root: env.root.clone(),
            catalog_path: env.dir.path().join("catalog.json"),
            core: env.core.clone(),
            user: env.user.clone(),
            content: env.content.clone(),
            runtime: tokio::runtime::Handle::current(),
            user_agent: "QuranForDesktop/test".into(),
            network_allowed: true,
            stream_cache_cap_bytes: cap,
        },
        catalog.clone(),
        events,
        options(),
    )
    .unwrap()
}

/// Waits (at most 30 s) for job `job_id` to reach a terminal phase.
pub async fn wait_job(events: &Events, job_id: u32) -> JobPhase {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(phase) = events.outcome(job_id) {
            return phase;
        }
        assert!(
            Instant::now() < deadline,
            "job {job_id} did not end: {:?}",
            events.lifecycle(job_id)
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog packs
// ---------------------------------------------------------------------------------------------------------------

pub fn catalog(packs: Vec<CatalogPack>) -> Catalog {
    Catalog {
        schema: None,
        catalog_version: 1,
        generated_at: "2026-10-10".into(),
        packs,
    }
}

pub fn pack(v: Value) -> CatalogPack {
    serde_json::from_value(v).unwrap()
}

fn attribution() -> Value {
    json!({ "text": { "en": "Test", "ar": "اختبار" }, "url": "https://example.invalid", "licence": "test" })
}

/// `mushaf.{variant}` served by `server` at `/{variant}/p{page}.woff2` (requires decor).
pub fn mushaf_pack(server: &TestServer, variant: &str) -> CatalogPack {
    pack(json!({
        "id": format!("mushaf.{variant}"), "kind": "mushaf_fonts",
        "title": { "en": "Mushaf", "ar": "مصحف" }, "description": { "en": "Pages", "ar": "صفحات" },
        "version": "2026.10", "installMode": "on_demand", "requires": ["decor"],
        "sizeBytes": 604 * 600, "itemCount": 604, "attribution": attribution(),
        "source": { "adapter": "qcf_font_pages", "variant": variant,
                    "urlTemplates": [server.url(&format!("/{variant}/p{{page}}.woff2"))] }
    }))
}

/// A woff2-looking page font: `wOF2` then deterministic bytes.
pub fn woff2(len: usize, seed: u8) -> Vec<u8> {
    let mut v = b"wOF2".to_vec();
    v.extend(crate::support::bytes(len.saturating_sub(4), seed));
    v
}

/// Serves pages `pages` of `variant` (each `len` bytes); returns the bodies by page.
pub fn serve_pages(
    server: &TestServer,
    variant: &str,
    pages: impl IntoIterator<Item = u32>,
    len: usize,
) {
    for page in pages {
        let seed = u8::try_from(page % 251).unwrap();
        server.route(
            &format!("/{variant}/p{page}.woff2"),
            Route::bytes(woff2(len, seed)),
        );
    }
}

/// The `decor` pack: three files served by `server` (sha256-pinned).
pub fn decor_pack(server: &TestServer) -> CatalogPack {
    let files: Vec<Value> = [
        ("qcf-surah-header.woff2", woff2(3_000, 1)),
        ("quran-common.ttf", {
            let mut v = vec![0, 1, 0, 0];
            v.extend(crate::support::bytes(4_000, 2));
            v
        }),
        ("sura-names.woff2", woff2(2_000, 3)),
    ]
    .into_iter()
    .map(|(name, body)| {
        let path = format!("/decor/{name}");
        let (len, sha) = (body.len(), crate::support::sha256_hex(&body));
        server.route(&path, Route::bytes(body));
        json!({ "path": name, "urls": [server.url(&path)], "bytes": len, "sha256": sha })
    })
    .collect();
    pack(json!({
        "id": "decor", "kind": "decor",
        "title": { "en": "Decor", "ar": "زخارف" }, "description": { "en": "Decor", "ar": "زخارف" },
        "version": "2026.10", "installMode": "whole", "sizeBytes": 9_008, "itemCount": 3,
        "attribution": attribution(), "source": { "adapter": "static_files", "files": files }
    }))
}

/// A QuranEnc pack (`translation` or `tafsir`) with the given id; its endpoints are quranenc.com, so these tests
/// install it through [`install_pack_db`] instead of a job.
pub fn quranenc_pack(id: &str, kind: PackKind) -> CatalogPack {
    let (kind_name, content_kind, language, tokenizer) = match kind {
        PackKind::Tafsir => ("tafsir", "tafsir", "ar", "arabic_normalized"),
        _ => ("translation", "translation", "en", "porter_unicode61"),
    };
    pack(json!({
        "id": id, "kind": kind_name,
        "title": { "en": id, "ar": "ترجمة" }, "description": { "en": id, "ar": "ترجمة" },
        "language": language, "version": "1.1.2", "installMode": "whole", "sizeBytes": 500_000, "itemCount": 1,
        "attribution": attribution(),
        "source": { "adapter": "quranenc_sqlite", "key": id.replace('.', "_"), "version": "1.1.2",
                    "versionSource": "list", "tokenizer": tokenizer, "contentKind": content_kind }
    }))
}

/// Builds a pack DB in staging and installs it with the real atomic flip (`install::flip_whole`): one entry per ayah of
/// `ayahs` (a tafsir: one range entry over all of them) and a footnote on the first.
pub async fn install_pack_db(env: &TestEnv, pack: &CatalogPack, version: &str, ayahs: &[u32]) {
    let staging = Staging::open(&env.root, &pack.id).await.unwrap();
    let db_path = staging.pack_db_path();
    let (lang, dir, tokenizer) = if pack.kind == PackKind::Tafsir {
        ("ar", TextDir::Rtl, PackTokenizer::ArabicNormalized)
    } else {
        ("en", TextDir::Ltr, PackTokenizer::PorterUnicode61)
    };
    let meta = PackMeta {
        pack_id: pack.id.clone(),
        kind: pack.kind,
        lang: lang.into(),
        dir,
        name: pack.id.clone(),
        author: "test".into(),
        source: "test".into(),
        source_version: version.into(),
        licence: "test".into(),
        attribution: "test".into(),
        tokenizer,
        normalizer_version: quran_core::NORMALIZER_VERSION,
        format: 1,
    };
    let mut w = PackDbWriter::create(&db_path, &meta).unwrap();
    if pack.kind == PackKind::Tafsir {
        let (first, last) = (ayahs[0], *ayahs.last().unwrap());
        w.entry(&PackEntryInput {
            ayah_id: first,
            to_ayah_id: last,
            html: format!("<p>tafsir {first}–{last}</p>"),
            plain: format!("tafsir {first} {last}"),
        })
        .unwrap();
    } else {
        for &a in ayahs {
            w.entry(&PackEntryInput {
                ayah_id: a,
                to_ayah_id: a,
                html: format!("<p>{} {a} v{version}</p>", pack.id),
                plain: format!("{} {a}", pack.id),
            })
            .unwrap();
        }
        w.footnote(&FootnoteInput {
            id: format!("1:{}:1", ayahs[0]),
            ayah_id: ayahs[0],
            marker: "1".into(),
            html: "a note".into(),
        })
        .unwrap();
    }
    let stats = w.finish().unwrap();
    let staged = StagedPack {
        db_path,
        version: version.into(),
        source_version: json!({ "version": version }).to_string(),
        sha256: "00".repeat(32),
        bytes: stats.bytes,
    };
    install::flip_whole(&env.root, &env.user, &pack.id, pack.kind, &staged, || {})
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------------------------------------------
// core.db with words
// ---------------------------------------------------------------------------------------------------------------

/// A core.db at `dir/core.db` with the `ayah` rows of `surahs` (via WP5d's `mini_core`) and their `word` rows, whose
/// `text_hafs` is `w{id}`.
pub fn word_core(dir: &Path, surahs: &[u32]) -> CoreDb {
    drop(crate::qf_support::mini_core(dir, surahs));
    let path = dir.join("core.db");
    {
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        // One transaction: thousands of autocommit inserts would each wait for the disk.
        let conn = conn.transaction().unwrap();
        for &surah in surahs {
            let ids = geometry::surah_ayah_ids(surah).unwrap();
            let mut word = *geometry::surah_word_ids(surah).unwrap().start();
            for ((ayah_id, ayah), n) in ids
                .zip(1u32..)
                .zip(crate::qf_support::words_per_ayah(surah))
            {
                for pos in 1..=n {
                    conn.execute(
                        "INSERT INTO word (id, ayah_id, surah, ayah, position, is_end, text_hafs, code_v1, code_v2)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'x', 'x')",
                        rusqlite::params![word, ayah_id, surah, ayah, pos, pos == n, format!("w{word}")],
                    )
                    .unwrap();
                    word += 1;
                }
            }
        }
        conn.commit().unwrap();
    }
    CoreDb::open(&path).unwrap()
}

/// Row counts of the registry: `(installed_pack rows, pack_item rows)` of one pack.
pub fn rows(user: &UserDb, pack_id: &str) -> (bool, usize) {
    (
        user.pack_installed(pack_id).unwrap().is_some(),
        user.pack_items(pack_id).unwrap().len(),
    )
}
