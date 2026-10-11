//! QuranEnc installs (`quran_packs::adapters::quranenc_sqlite`, docs/ARCHITECTURE.md §2.5.5–§2.5.6): the zip in
//! staging (resumable, reused after a pause, mirrors), the single-entry check, list and ETag versions, the pack DB meta,
//! `source_version`, integrity failures that discard the download, and a whole job through the queue and the atomic
//! flip. Owner: WP5c.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod quranenc_support;
mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use quran_core::{InstalledPackRow, InstalledStatus, PackDb, PackTokenizer};
use quran_packs::PackError;
use quran_packs::adapters::quranenc_sqlite::{Endpoints, SourceVersion, install_from};
use quran_packs::adapters::{AdapterCtx, ItemKey, ItemOutcome, QuranEncSqliteConfig, StagedPack};
use quran_packs::install;
use quran_packs::jobs::{JobHandle, PackWork};
use quran_types::{InstallScope, JobPhase, PackKind, TextDir};
use quranenc_support::{
    export_zip, list_json, muyassar, muyassar_rows, saheeh, saheeh_rows, sqlite_bytes, zip_bytes,
};
use support::http::{Route, TestServer};
use support::work::{spec, spec_source};
use support::{TestEnv, sha256_hex};

const SAHEEH: &str = "tr.en.saheeh";
const MUYASSAR: &str = "tafsir.ar.muyassar";
const SAHEEH_ETAG: &str = "\"67e2bd2a-7ead2\"";
const MUYASSAR_ETAG: &str = "\"67e2bd39-c64f2\"";

fn endpoints(s: &TestServer, zip: &str) -> Endpoints {
    Endpoints {
        zip: vec![s.url(zip)],
        list: s.url("/api/v1/translations/list"),
    }
}

fn serve_list(s: &TestServer, version: &str) {
    s.route(
        "/api/v1/translations/list",
        Route::json(&list_json(&[
            ("english_rwwad", "1.0.19", "English - Rowwad"),
            ("english_saheeh", version, "English - Saheeh International"),
        ])),
    );
}

fn staging(env: &TestEnv, pack_id: &str) -> PathBuf {
    let dir = install::staging_dir(&env.root, pack_id).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn ctx(env: &TestEnv, pack_id: &str, kind: PackKind) -> (AdapterCtx, JobHandle) {
    let job = JobHandle::detached(1, pack_id);
    (env.ctx(pack_id, kind, Some(job.clone()), true), job)
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[tokio::test]
async fn a_list_pack_installs_with_the_list_version() {
    let s = TestServer::start();
    let zip = export_zip("english_saheeh", &saheeh_rows());
    s.route(
        "/english_saheeh.zip",
        Route::bytes(zip.clone())
            .etag(SAHEEH_ETAG)
            .last_modified("Thu, 26 Mar 2000 17:35:45 GMT"),
    );
    serve_list(&s, "1.1.3");
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let (ctx, job) = ctx(&env, SAHEEH, PackKind::Translation);

    let staged = install_from(
        &ctx,
        &saheeh("1.1.2"),
        &dir,
        &endpoints(&s, "/english_saheeh.zip"),
    )
    .await
    .unwrap();
    assert_eq!(
        staged.version, "1.1.3",
        "the list's version, not the catalog's"
    );
    assert_eq!(staged.db_path, dir.join("pack.db"));
    assert_eq!(staged.sha256, sha256_hex(&zip));
    assert_eq!(
        staged.bytes,
        std::fs::metadata(&staged.db_path).unwrap().len()
    );
    assert_eq!(job.phase(), JobPhase::Verifying);
    let sv = SourceVersion::parse(&staged.source_version).unwrap();
    assert_eq!(sv.key, "english_saheeh");
    assert_eq!(sv.version.as_deref(), Some("1.1.3"));
    assert_eq!(sv.last_update, Some(1_750_772_247));
    assert_eq!(sv.etag.as_deref(), Some(SAHEEH_ETAG));
    assert_eq!(
        sv.last_modified.as_deref(),
        Some("Thu, 26 Mar 2000 17:35:45 GMT")
    );
    assert_eq!(sv.content_length, Some(u64::try_from(zip.len()).unwrap()));

    let db = PackDb::open(&staged.db_path).unwrap();
    let m = db.meta();
    assert_eq!(m.pack_id, SAHEEH);
    assert_eq!(m.kind, PackKind::Translation);
    assert_eq!((m.lang.as_str(), m.dir), ("en", TextDir::Ltr));
    assert_eq!(m.name, "English - Saheeh International");
    assert_eq!(m.author, "Description of english_saheeh");
    assert_eq!(m.source, s.url("/english_saheeh.zip"));
    assert_eq!(m.source_version, "1.1.3");
    assert_eq!(m.tokenizer, PackTokenizer::PorterUnicode61);
    assert!(m.licence.contains("QuranEnc"));
    assert_eq!(db.entries(1, 6236).unwrap().len(), 6236);
    assert_eq!(db.entries(1, 1).unwrap()[0].html, "Mercy of 1:1.");

    // The verified zip and its record stay for a resume; the extracted export does not.
    assert_eq!(
        names(&dir),
        ["english_saheeh.zip", "english_saheeh.zip.json", "pack.db"]
    );
}

#[tokio::test]
async fn a_verified_download_is_reused_and_a_changed_one_is_not() {
    let s = TestServer::start();
    let zip = export_zip("english_saheeh", &saheeh_rows());
    s.route(
        "/english_saheeh.zip",
        Route::bytes(zip.clone()).etag(SAHEEH_ETAG),
    );
    serve_list(&s, "1.1.2");
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let ep = endpoints(&s, "/english_saheeh.zip");
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    install_from(&c, &saheeh("1.1.2"), &dir, &ep).await.unwrap();
    assert_eq!(s.hits("/english_saheeh.zip"), 1);

    // A build that failed after the download (or a pause during the build) resumes without downloading again.
    std::fs::remove_file(dir.join("pack.db")).unwrap();
    let (c, job) = ctx(&env, SAHEEH, PackKind::Translation);
    let again = install_from(&c, &saheeh("1.1.2"), &dir, &ep).await.unwrap();
    assert_eq!(s.hits("/english_saheeh.zip"), 1);
    assert_eq!(
        SourceVersion::parse(&again.source_version)
            .unwrap()
            .etag
            .as_deref(),
        Some(SAHEEH_ETAG)
    );
    assert_eq!(
        job.snapshot().received_kib,
        u32::try_from(zip.len() / 1024).unwrap(),
        "the reused bytes count as progress"
    );

    // A zip that changed on disk is downloaded again.
    let mut damaged = std::fs::read(dir.join("english_saheeh.zip")).unwrap();
    let last = damaged.len() - 1;
    damaged[last] ^= 0xff;
    std::fs::write(dir.join("english_saheeh.zip"), &damaged).unwrap();
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    install_from(&c, &saheeh("1.1.2"), &dir, &ep).await.unwrap();
    assert_eq!(s.hits("/english_saheeh.zip"), 2);
}

#[tokio::test]
async fn the_catalog_version_is_the_fallback_when_the_list_cannot_tell() {
    let s = TestServer::start();
    s.route(
        "/english_saheeh.zip",
        Route::bytes(export_zip("english_saheeh", &saheeh_rows())),
    );
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let ep = endpoints(&s, "/english_saheeh.zip");
    // No list at all (404).
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    let staged = install_from(&c, &saheeh("1.1.2"), &dir, &ep).await.unwrap();
    assert_eq!(staged.version, "1.1.2");
    assert_eq!(
        SourceVersion::parse(&staged.source_version)
            .unwrap()
            .version,
        None
    );
    assert_eq!(
        PackDb::open(&staged.db_path).unwrap().meta().name,
        "english_saheeh"
    );
    // A list without the key.
    s.route(
        "/api/v1/translations/list",
        Route::json(&list_json(&[("english_rwwad", "1.0.19", "Rowwad")])),
    );
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    let staged = install_from(&c, &saheeh("1.1.2"), &dir, &ep).await.unwrap();
    assert_eq!(staged.version, "1.1.2");
    // A list that is not the expected JSON.
    s.route(
        "/api/v1/translations/list",
        Route::json(&serde_json::json!({ "error": "x" })),
    );
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    assert_eq!(
        install_from(&c, &saheeh("1.1.2"), &dir, &ep)
            .await
            .unwrap()
            .version,
        "1.1.2"
    );
}

#[tokio::test]
async fn validators_packs_are_versioned_by_their_etag() {
    let s = TestServer::start();
    s.route(
        "/arabic_moyassar.zip",
        Route::bytes(export_zip("arabic_moyassar", &muyassar_rows())).etag(MUYASSAR_ETAG),
    );
    let env = TestEnv::new();
    let dir = staging(&env, MUYASSAR);
    let ep = endpoints(&s, "/arabic_moyassar.zip");
    let (c, _) = ctx(&env, MUYASSAR, PackKind::Tafsir);
    let staged = install_from(&c, &muyassar("2024.12"), &dir, &ep)
        .await
        .unwrap();
    assert_eq!(staged.version, "2025.03", "YYYY.MM of the nginx ETag mtime");
    assert_eq!(
        s.hits("/api/v1/translations/list"),
        0,
        "unlisted keys never ask the list"
    );
    let db = PackDb::open(&staged.db_path).unwrap();
    let m = db.meta();
    assert_eq!(
        (m.kind, m.lang.as_str(), m.dir),
        (PackKind::Tafsir, "ar", TextDir::Rtl)
    );
    assert_eq!(m.tokenizer, PackTokenizer::ArabicNormalized);
    assert_eq!(m.name, "arabic_moyassar");
    let e = db.entry_for(262).unwrap().unwrap();
    assert_eq!((e.ayah_id, e.to_ayah_id), (262, 262));
    drop(db);

    // An update within the same month as the installed version gets a day version.
    let now = env.user.now_ms();
    env.user
        .pack_upsert(&InstalledPackRow {
            pack_id: MUYASSAR.into(),
            kind: PackKind::Tafsir,
            version: "2025.03".into(),
            path: Some("tafsir/tafsir.ar.muyassar/2025.03/pack.db".into()),
            status: InstalledStatus::Installed,
            bytes: 1,
            items_total: 1,
            items_present: 1,
            sha256: None,
            source_version: Some(
                SourceVersion {
                    key: "arabic_moyassar".into(),
                    etag: Some("\"67e00000-1\"".into()),
                    content_length: Some(1),
                    ..SourceVersion::default()
                }
                .to_json(),
            ),
            installed_at: now,
            updated_at: now,
            last_checked_at: None,
        })
        .unwrap();
    std::fs::remove_file(dir.join("pack.db")).unwrap();
    let (c, _) = ctx(&env, MUYASSAR, PackKind::Tafsir);
    assert_eq!(
        install_from(&c, &muyassar("2024.12"), &dir, &ep)
            .await
            .unwrap()
            .version,
        "2025.03.25"
    );
}

#[tokio::test]
async fn a_mirror_serving_something_else_is_skipped() {
    let s = TestServer::start();
    s.route(
        "/portal.zip",
        Route::bytes(b"<html>captive portal</html>".to_vec()),
    );
    s.route(
        "/english_saheeh.zip",
        Route::bytes(export_zip("english_saheeh", &saheeh_rows())),
    );
    serve_list(&s, "1.1.2");
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let ep = Endpoints {
        zip: vec![s.url("/portal.zip"), s.url("/english_saheeh.zip")],
        list: s.url("/api/v1/translations/list"),
    };
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    install_from(&c, &saheeh("1.1.2"), &dir, &ep).await.unwrap();
    assert_eq!(
        s.hits("/portal.zip"),
        1,
        "a payload without the zip magic retires the mirror"
    );
    assert_eq!(s.hits("/english_saheeh.zip"), 1);
}

#[tokio::test]
async fn the_archive_needs_exactly_one_sqlite_entry() {
    let s = TestServer::start();
    serve_list(&s, "1.1.2");
    let env = TestEnv::new();
    let export = sqlite_bytes(&saheeh_rows());
    // The entry name is not assumed, and other entries are ignored.
    s.route(
        "/nested.zip",
        Route::bytes(zip_bytes(&[
            ("data/", b""),
            ("README.txt", b"read me"),
            ("data/Quran-Export.SQLITE", &export),
        ])),
    );
    let dir = staging(&env, SAHEEH);
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    install_from(&c, &saheeh("1.1.2"), &dir, &endpoints(&s, "/nested.zip"))
        .await
        .unwrap();

    for (path, zip, want) in [
        (
            "/two.zip",
            zip_bytes(&[("a.sqlite", &export), ("b.sqlite", &export)]),
            "more than one *.sqlite entry",
        ),
        (
            "/none.zip",
            zip_bytes(&[("readme.txt", b"x")]),
            "no *.sqlite entry",
        ),
        (
            "/short.zip",
            zip_bytes(&[("english_saheeh.sqlite", &sqlite_bytes(&saheeh_rows()[1..]))]),
            "6235 rows",
        ),
        (
            "/notdb.zip",
            zip_bytes(&[("english_saheeh.sqlite", b"<html>not sqlite</html>")]),
            "not a readable SQLite file",
        ),
    ] {
        s.route(path, Route::bytes(zip));
        let env = TestEnv::new();
        let dir = staging(&env, SAHEEH);
        let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
        let err = install_from(&c, &saheeh("1.1.2"), &dir, &endpoints(&s, path))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, PackError::Integrity(m) if m.contains(want)),
            "{path}: {err:?}"
        );
        assert!(
            names(&dir).is_empty(),
            "{path}: a damaged download is discarded: {:?}",
            names(&dir)
        );
        assert_eq!(quran_types::AppError::from(err).kind(), "integrity");
    }
}

#[tokio::test]
async fn a_pinned_catalog_hash_must_match() {
    let s = TestServer::start();
    let zip = export_zip("english_saheeh", &saheeh_rows());
    s.route("/english_saheeh.zip", Route::bytes(zip.clone()));
    serve_list(&s, "1.1.2");
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let ep = endpoints(&s, "/english_saheeh.zip");
    let mut cfg = saheeh("1.1.2");
    cfg.sha256 = Some("00".repeat(32));
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    let err = install_from(&c, &cfg, &dir, &ep).await.unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    cfg.sha256 = Some(sha256_hex(&zip).to_uppercase());
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    install_from(&c, &cfg, &dir, &ep).await.unwrap();
    assert_eq!(s.hits("/english_saheeh.zip"), 2);
    // A download kept in staging is not reused once the catalog pins another file.
    std::fs::remove_file(dir.join("pack.db")).unwrap();
    cfg.sha256 = Some("11".repeat(32));
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    let err = install_from(&c, &cfg, &dir, &ep).await.unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    assert_eq!(s.hits("/english_saheeh.zip"), 3);
}

#[tokio::test]
async fn configuration_errors_make_no_request() {
    let s = TestServer::start();
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let ep = endpoints(&s, "/english_saheeh.zip");
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    let err = install_from(&c, &muyassar("1"), &dir, &ep)
        .await
        .unwrap_err();
    assert!(
        matches!(err, PackError::Catalog(_)),
        "a tafsir export for a translation pack: {err:?}"
    );
    let mut bad_key = saheeh("1");
    bad_key.key = "../english_saheeh".into();
    assert!(matches!(
        install_from(&c, &bad_key, &dir, &ep).await,
        Err(PackError::Catalog(_))
    ));
    let job = JobHandle::detached(1, "translation");
    let no_lang = env.ctx("translation", PackKind::Translation, Some(job), true);
    assert!(matches!(
        install_from(&no_lang, &saheeh("1"), &dir, &ep).await,
        Err(PackError::Catalog(_))
    ));
    assert!(s.requests().is_empty());
}

#[tokio::test]
async fn offline_and_cancelled_installs_stop() {
    let s = TestServer::start();
    s.route(
        "/english_saheeh.zip",
        Route::bytes(export_zip("english_saheeh", &saheeh_rows())),
    );
    let env = TestEnv::new();
    let dir = staging(&env, SAHEEH);
    let ep = endpoints(&s, "/english_saheeh.zip");
    env.http.set_network_allowed(false);
    let (c, _) = ctx(&env, SAHEEH, PackKind::Translation);
    assert!(matches!(
        install_from(&c, &saheeh("1"), &dir, &ep).await,
        Err(PackError::Offline)
    ));
    env.http.set_network_allowed(true);
    let (c, job) = ctx(&env, SAHEEH, PackKind::Translation);
    job.request_cancel();
    assert!(matches!(
        install_from(&c, &saheeh("1"), &dir, &ep).await,
        Err(PackError::Cancelled)
    ));
    assert!(s.requests().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Through the job queue
// ---------------------------------------------------------------------------------------------------------------

/// The production adapter's whole-pack path against test endpoints.
struct QuranEncWork {
    cfg: QuranEncSqliteConfig,
    endpoints: Endpoints,
}

impl PackWork for QuranEncWork {
    fn items(&self, _scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        Ok(vec![ItemKey::Whole])
    }

    fn whole(&self) -> bool {
        true
    }

    fn fetch_item<'a>(
        &'a self,
        _ctx: &'a AdapterCtx,
        item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>> {
        Box::pin(async move { Err(PackError::Unsupported(format!("{item}"))) })
    }

    fn install_whole<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>> {
        Box::pin(install_from(ctx, &self.cfg, staging, &self.endpoints))
    }

    fn temp_paths(&self, _packs_root: &Path, _item: &ItemKey) -> Vec<PathBuf> {
        Vec::new()
    }
}

#[tokio::test]
async fn a_job_installs_and_updates_the_pack_atomically() {
    let s = TestServer::start();
    let v1 = export_zip("english_saheeh", &saheeh_rows());
    s.route(
        "/english_saheeh.zip",
        Route::bytes(v1.clone()).etag(SAHEEH_ETAG),
    );
    serve_list(&s, "1.1.2");
    let env = TestEnv::new();
    let work: Arc<dyn PackWork> = Arc::new(QuranEncWork {
        cfg: saheeh("1.1.2"),
        endpoints: endpoints(&s, "/english_saheeh.zip"),
    });
    let q = env.queue(
        spec_source(vec![(
            SAHEEH,
            PackKind::Translation,
            Arc::clone(&work),
            1,
            518_866,
        )]),
        3,
        4,
    );
    let enqueue = || {
        spec(
            SAHEEH,
            PackKind::Translation,
            Arc::clone(&work),
            InstallScope::All,
            1,
            518_866,
        )
    };
    let id = q.enqueue(enqueue()).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    assert_eq!(
        env.recorder.lifecycle(id),
        ["queued", "started", "verifying", "installing", "completed"]
    );
    let row = env.user.pack_installed(SAHEEH).unwrap().unwrap();
    assert_eq!(row.status, InstalledStatus::Installed);
    assert_eq!(row.version, "1.1.2");
    assert_eq!(
        row.path.as_deref(),
        Some("translation/tr.en.saheeh/1.1.2/pack.db")
    );
    assert_eq!(row.sha256.as_deref(), Some(sha256_hex(&v1).as_str()));
    let sv = SourceVersion::parse(row.source_version.as_deref().unwrap()).unwrap();
    assert_eq!(
        (sv.version.as_deref(), sv.etag.as_deref()),
        (Some("1.1.2"), Some(SAHEEH_ETAG))
    );
    let db_path = install::resolve(&env.root, row.path.as_deref().unwrap()).unwrap();
    assert_eq!(
        PackDb::open(&db_path).unwrap().entries(262, 262).unwrap()[0].html,
        "Mercy of 2:255."
    );
    assert!(!install::staging_dir(&env.root, SAHEEH).unwrap().exists());

    // QuranEnc publishes 1.1.3: the update lands in a new directory and the old one goes.
    let mut rows = saheeh_rows();
    rows[261].2 = Some("(255) Updated wording.".into());
    s.route(
        "/english_saheeh.zip",
        Route::bytes(export_zip("english_saheeh", &rows)).etag("\"6a37d20e-8b5c0\""),
    );
    serve_list(&s, "1.1.3");
    let id = q.enqueue(enqueue()).await.unwrap();
    assert_eq!(q.wait(id).await, Some(JobPhase::Completed));
    let row = env.user.pack_installed(SAHEEH).unwrap().unwrap();
    assert_eq!(row.version, "1.1.3");
    let new_db = install::resolve(&env.root, row.path.as_deref().unwrap()).unwrap();
    assert_eq!(
        PackDb::open(&new_db).unwrap().entries(262, 262).unwrap()[0].html,
        "Updated wording."
    );
    assert!(
        !db_path.exists(),
        "the previous version is deleted after the flip"
    );
    assert_eq!(env.recorder.released(), [SAHEEH, SAHEEH]);
}
