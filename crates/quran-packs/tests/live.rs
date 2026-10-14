//! Live network tests of the pack manager against the real upstreams.
//!
//! Opt-in: `QD_NET_TESTS=1 cargo test -p quran-packs --test live -- --ignored`. Without `QD_NET_TESTS=1` an ignored run
//! skips with a note. The shipped catalog (`src-tauri/resources/catalog.json`) drives every download:
//! - `install_resume`: installs `tr.en.saheeh` (QuranEnc zip → pack DB), `mushaf.v2` pages 1–3 and `audio.qdc.7` surah 1
//!   into a temp dir; then starts surah 67, **kills** the app's runtime once at least 1 MiB is durably on disk, starts a
//!   new manager on the same data and checks that the interrupted job resumes from its sidecar (never from byte 0) and
//!   completes with the exact `Content-Length`.
//! - `on_demand`: timings, a Quran.com tafsir entry and a word-by-word range fetched on demand (word texts need the
//!   checkout's built core.db; that part is skipped without one).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use quran_core::{ContentDb, CoreDb, UserDb};
use quran_packs::catalog::Catalog;
use quran_packs::http::read_sidecar;
use quran_packs::install;
use quran_packs::manager::{ManagerOptions, PackEvents, PackManager, PackManagerConfig};
use quran_types::{
    DownloadEvent, FetchPriority, FontAvailability, InstallScope, JobPhase, MushafStyle, PackState,
};

const SKIP: &str = "set QD_NET_TESTS=1 to run the live network tests";
/// Al-Mulk by Alafasy: a few MB, large enough to be interrupted after the first durable MiB.
const RESUME_SURAH: u32 = 67;

fn enabled() -> bool {
    std::env::var("QD_NET_TESTS").as_deref() == Ok("1")
}

fn repo_file(rel: &str) -> PathBuf {
    rel.split('/').fold(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(".."),
        |p, seg| p.join(seg),
    )
}

#[derive(Default)]
struct Events(Mutex<Vec<DownloadEvent>>);

impl PackEvents for Events {
    fn download(&self, e: DownloadEvent) {
        self.0.lock().unwrap().push(e);
    }
    fn packs_changed(&self, _pack_ids: Vec<String>) {}
    fn network(&self, _online: bool) {}
}

impl Events {
    fn outcome(&self, job_id: u32) -> Option<(JobPhase, Option<String>)> {
        self.0.lock().unwrap().iter().find_map(|e| match e {
            DownloadEvent::Completed { job_id: id, .. } if *id == job_id => {
                Some((JobPhase::Completed, None))
            }
            DownloadEvent::Failed {
                job_id: id, error, ..
            } if *id == job_id => Some((JobPhase::Failed, Some(error.to_string()))),
            DownloadEvent::Cancelled { job_id: id, .. } if *id == job_id => {
                Some((JobPhase::Cancelled, None))
            }
            _ => None,
        })
    }
}

/// The data of one "installation": packs root and databases in a temp dir.
struct Data {
    dir: tempfile::TempDir,
}

impl Data {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("packs")).unwrap();
        Self { dir }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("packs")
    }

    /// A manager on this data (fresh database handles, as a new process opens them), on `rt`.
    fn manager(&self, rt: &tokio::runtime::Handle, core: CoreDb) -> (PackManager, Arc<Events>) {
        let user = UserDb::open(&self.dir.path().join("user.db")).unwrap();
        let content = ContentDb::open(&self.dir.path().join("content.db")).unwrap();
        let catalog =
            Catalog::load_validated(&repo_file("src-tauri/resources/catalog.json")).unwrap();
        let events = Arc::new(Events::default());
        let manager = PackManager::with_catalog(
            PackManagerConfig {
                packs_root: self.root(),
                catalog_path: repo_file("src-tauri/resources/catalog.json"),
                core,
                user,
                content,
                runtime: rt.clone(),
                user_agent: "QuranForDesktop/live-test".into(),
                network_allowed: true,
                stream_cache_cap_bytes: 2 * 1024 * 1024 * 1024,
            },
            catalog,
            Arc::clone(&events) as Arc<dyn PackEvents>,
            ManagerOptions {
                changes_coalesce: Duration::ZERO,
                ..ManagerOptions::default()
            },
        )
        .unwrap();
        (manager, events)
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap()
}

async fn wait(events: &Events, job_id: u32, budget: Duration) -> JobPhase {
    let deadline = Instant::now() + budget;
    loop {
        if let Some((phase, error)) = events.outcome(job_id) {
            assert_eq!(phase, JobPhase::Completed, "job {job_id}: {error:?}");
            return phase;
        }
        assert!(
            Instant::now() < deadline,
            "job {job_id} did not finish in {budget:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn state(manager: &PackManager, pack_id: &str) -> PackState {
    manager
        .list()
        .unwrap()
        .into_iter()
        .find(|p| p.id == pack_id)
        .unwrap()
        .state
}

#[test]
#[ignore = "network: QD_NET_TESTS=1 cargo test -p quran-packs --test live -- --ignored"]
fn install_resume() {
    if !enabled() {
        eprintln!("{SKIP}");
        return;
    }
    let data = Data::new();
    let first = runtime();
    let (manager, events) = data.manager(first.handle(), CoreDb::unavailable("not needed".into()));

    let (sidecar_received, part) = first.block_on(async {
        // 1. A QuranEnc translation: zip → verified export → pack DB, flipped into place.
        let job = manager
            .install("tr.en.saheeh", InstallScope::All)
            .await
            .unwrap();
        wait(&events, job, Duration::from_secs(180)).await;
        let PackState::Installed { version } = state(&manager, "tr.en.saheeh") else {
            panic!("tr.en.saheeh: {:?}", state(&manager, "tr.en.saheeh"));
        };
        let db = manager.translation_db("tr.en.saheeh").unwrap();
        let entries = db.entries(1, 300).unwrap();
        assert_eq!(entries.len(), 300);
        assert_eq!(db.entries(6_000, 6_236).unwrap().len(), 237);
        eprintln!(
            "tr.en.saheeh {version}: 2:255 = {}",
            db.entry_for(262).unwrap().unwrap().html
        );

        // 2. Mushaf pages 1–3 (QCF v2) as an item install.
        let job = manager
            .install(
                "mushaf.v2",
                InstallScope::Items {
                    items: vec![1, 2, 3],
                },
            )
            .await
            .unwrap();
        wait(&events, job, Duration::from_secs(120)).await;
        for page in 1..=3 {
            let path = data
                .root()
                .join("mushaf")
                .join("v2")
                .join(format!("p{page}.woff2"));
            let bytes = std::fs::read(&path).unwrap();
            assert!(bytes.starts_with(b"wOF2"), "p{page}");
        }
        let fonts = manager
            .ensure_page_fonts(MushafStyle::QcfV2, &[1, 2, 3], FetchPriority::Interactive)
            .await
            .unwrap();
        assert!(
            fonts
                .iter()
                .all(|p| p.availability == FontAvailability::Ready)
        );
        assert_eq!(
            state(&manager, "mushaf.v2"),
            PackState::Partial {
                items_present: 3,
                items_total: 604
            }
        );

        // 3. Alafasy surah 1, with its timings pinned to the exact file.
        let job = manager
            .install("audio.qdc.7", InstallScope::Items { items: vec![1] })
            .await
            .unwrap();
        wait(&events, job, Duration::from_secs(180)).await;
        let timings = manager.surah_timings(7, 1).await.unwrap();
        let file = install::audio_path(&data.root(), 7, 1);
        assert_eq!(
            Some(std::fs::metadata(&file).unwrap().len()),
            timings.file.content_length,
            "the pinned file is the one the timings describe"
        );
        assert_eq!(timings.ayahs.len(), 7);
        let reciter = manager.reciters().into_iter().find(|r| r.id == 7).unwrap();
        assert_eq!(reciter.downloaded_surahs, 1);

        // 4. Surah 67, interrupted once at least 1 MiB is durably written.
        let job = manager
            .install(
                "audio.qdc.7",
                InstallScope::Items {
                    items: vec![RESUME_SURAH],
                },
            )
            .await
            .unwrap();
        let mp3 = install::audio_path(&data.root(), 7, RESUME_SURAH);
        let part = install::dl_part_path(&mp3);
        let sidecar = install::dl_sidecar_path(&mp3);
        let deadline = Instant::now() + Duration::from_secs(180);
        let received = loop {
            if let Some(s) = read_sidecar(&sidecar).await
                && s.received >= 1024 * 1024
            {
                break s.received;
            }
            assert!(
                events.outcome(job).is_none(),
                "surah {RESUME_SURAH} finished before it could be interrupted"
            );
            assert!(
                Instant::now() < deadline,
                "no durable MiB of surah {RESUME_SURAH}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        (received, part)
    });
    // The kill: every task of the first "process" stops where it is.
    first.shutdown_background();
    drop(manager);
    eprintln!("killed with {sidecar_received} bytes durable");
    assert!(part.exists(), "the resumable temp survives");

    // The next start resumes the job from the sidecar.
    let second = runtime();
    let (manager, events) = data.manager(second.handle(), CoreDb::unavailable("not needed".into()));
    let smallest = Arc::new(AtomicU64::new(u64::MAX));
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (smallest, stop, part) = (Arc::clone(&smallest), Arc::clone(&stop), part.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                if let Ok(m) = std::fs::metadata(&part) {
                    smallest.fetch_min(m.len(), Ordering::SeqCst);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    second.block_on(async {
        let report = manager.startup().await.unwrap();
        assert_eq!(report.resumed_jobs.len(), 1, "{report:?}");
        wait(&events, report.resumed_jobs[0], Duration::from_secs(300)).await;
    });
    stop.store(true, Ordering::SeqCst);
    watcher.join().unwrap();
    let smallest = smallest.load(Ordering::SeqCst);
    assert!(
        smallest >= sidecar_received,
        "the resumed download restarted below its durable offset: {smallest} < {sidecar_received}"
    );
    let mp3 = install::audio_path(&data.root(), 7, RESUME_SURAH);
    let timings = second
        .block_on(manager.surah_timings(7, RESUME_SURAH))
        .unwrap();
    assert_eq!(
        Some(std::fs::metadata(&mp3).unwrap().len()),
        timings.file.content_length
    );
    assert_eq!(
        state(&manager, "audio.qdc.7"),
        PackState::Partial {
            items_present: 2,
            items_total: 114
        }
    );
    eprintln!(
        "surah {RESUME_SURAH}: resumed at ≥ {sidecar_received} of {} bytes (smallest temp seen {smallest})",
        timings.file.content_length.unwrap_or(0)
    );
    second.block_on(async {
        // The installed QuranEnc pack is checked against the list API.
        let updates = manager.check_updates().await.unwrap();
        eprintln!("updates: {updates:?}");
    });
    second.shutdown_background();
}

#[test]
#[ignore = "network: QD_NET_TESTS=1 cargo test -p quran-packs --test live -- --ignored"]
fn on_demand() {
    if !enabled() {
        eprintln!("{SKIP}");
        return;
    }
    let core_path = repo_file("src-tauri/resources/core.db");
    let core = match CoreDb::open(&core_path) {
        Ok(core) => Some(core),
        Err(e) => {
            eprintln!("note: no built core.db ({e}); the word-by-word part is skipped");
            None
        }
    };
    let data = Data::new();
    let rt = runtime();
    let (manager, events) = data.manager(
        rt.handle(),
        core.clone()
            .unwrap_or_else(|| CoreDb::unavailable("no core.db".into())),
    );
    rt.block_on(async {
        let timings = manager.surah_timings(7, 112).await.unwrap();
        assert_eq!(timings.ayahs.len(), 4);
        assert!(timings.file.content_length.is_some_and(|n| n > 10_000));

        let entry = manager
            .tafsir_entry("tafsir.en.ibn_kathir", 262)
            .await
            .unwrap();
        assert!(entry.from_ayah_id <= 262 && entry.to_ayah_id >= 262);
        assert!(!entry.html.is_empty() && !entry.stale && entry.fetched_at.is_some());
        let items = manager.items("tafsir.en.ibn_kathir").unwrap();
        assert_eq!(items.len(), 1, "chapter 2 recorded");
        assert!(!items[0].pinned && items[0].item == 2);

        if core.is_some() {
            let words = manager.wbw_range("wbw.en", 1, 36).await.unwrap();
            assert!(
                words.len() >= 29,
                "al-Fatiha's glossed words: {}",
                words.len()
            );
            assert!(words.iter().all(|w| !w.text.is_empty()));
            assert!(words.iter().any(|w| w.translation.is_some()));
        }
        // Offline afterwards: everything stored still answers.
        manager.set_network_allowed(false);
        manager
            .tafsir_entry("tafsir.en.ibn_kathir", 263)
            .await
            .unwrap();
        manager.surah_timings(7, 112).await.unwrap();
    });
    assert!(events.0.lock().unwrap().is_empty(), "no job ran");
    rt.shutdown_background();
}
