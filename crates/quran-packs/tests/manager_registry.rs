//! The pack manager's registry view and startup: states, reciters, known updates across restarts, the startup sweep and
//! re-sync, interrupted removals and jobs, the network switch, and disk usage.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod manager_support;
mod qf_support;
mod support;

use std::path::Path;

use manager_support::{
    DAY_MS, Fixture, T0, decor_pack, install_pack_db, mushaf_pack, quranenc_pack, serve_pages,
};
use qf_support::{audio_pack, wbw_pack};
use quran_core::{
    ChapterStamp, InstalledPackRow, InstalledStatus, PackItemRow, StoredTimings, TimedAyah,
    TimingFile,
};
use quran_packs::PackError;
use quran_packs::install;
use quran_packs::jobs::{JobJournal, JournalState};
use quran_types::{
    FetchPriority, FontAvailability, InstallScope, JobPhase, MushafStyle, PackKind, PackState,
    Settings, WbwEntry,
};
use support::TestEnv;
use support::http::TestServer;

fn write(path: &Path, len: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, support::bytes(len, 1)).unwrap();
}

fn item(pack_id: &str, item: &str, bytes: u64, pinned: bool, at: i64) -> PackItemRow {
    PackItemRow {
        pack_id: pack_id.into(),
        item: item.into(),
        bytes,
        sha256: String::new(),
        pinned,
        fetched_at: at,
        last_used_at: at,
    }
}

fn installed(
    pack_id: &str,
    kind: PackKind,
    status: InstalledStatus,
    present: u32,
) -> InstalledPackRow {
    InstalledPackRow {
        pack_id: pack_id.into(),
        kind,
        version: "2026.10".into(),
        path: None,
        status,
        bytes: 0,
        items_total: 604,
        items_present: present,
        sha256: None,
        source_version: None,
        installed_at: T0,
        updated_at: T0,
        last_checked_at: None,
    }
}

fn timings(reciter: u32, surah: u32, word_level: bool) -> StoredTimings {
    StoredTimings {
        file: TimingFile {
            reciter_id: reciter,
            surah,
            audio_url: format!("https://download.quranicaudio.com/qdc/x/{surah}.mp3"),
            content_length: Some(4_096),
            duration_ms: Some(1_000),
            source: "qdc".into(),
            fetched_at_ms: T0,
            etag: None,
            payload_sha256: "00".repeat(32),
        },
        ayahs: vec![TimedAyah {
            ayah: 1,
            from_ms: 0,
            to_ms: 1_000,
            words: Vec::new(),
        }],
        word_level,
    }
}

fn hosts(server: &TestServer) -> Vec<String> {
    vec![format!("127.0.0.1:{}", server.port())]
}

#[tokio::test]
async fn a_fresh_registry_lists_the_catalog_as_not_installed() {
    let server = TestServer::start();
    let f = Fixture::new(vec![
        decor_pack(&server),
        mushaf_pack(&server, "v2"),
        quranenc_pack("tr.en.saheeh", PackKind::Translation),
        audio_pack(7, &hosts(&server)),
    ]);
    let list = f.manager.list().unwrap();
    assert_eq!(
        list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["decor", "mushaf.v2", "tr.en.saheeh", "audio.qdc.7"],
        "catalog order"
    );
    assert!(
        list.iter()
            .all(|p| p.state == PackState::NotInstalled && p.installed_kib == 0 && p.job.is_none())
    );
    assert_eq!(f.manager.summaries().unwrap().len(), 4);
    let reciters = f.manager.reciters();
    assert_eq!(reciters.len(), 1);
    assert_eq!(
        (
            reciters[0].id,
            reciters[0].word_level,
            reciters[0].downloaded_surahs,
            reciters[0].cached_surahs
        ),
        (7, true, 0, 0)
    );
    assert_eq!(
        f.manager.reciter_meta(7).map(|(_, in_file)| in_file),
        Some(false)
    );
    assert!(f.manager.items("audio.qdc.7").unwrap().is_empty());
    assert!(f.manager.audio_root().ends_with("audio"));
    assert!(f.manager.online());
}

#[tokio::test]
async fn reciters_count_downloads_and_cache_and_learn_the_word_level() {
    let server = TestServer::start();
    let f = Fixture::new(vec![
        audio_pack(7, &hosts(&server)),
        audio_pack(5, &hosts(&server)),
    ]);
    let user = &f.env.user;
    for (surah, pinned) in [("001", true), ("002", true), ("003", false)] {
        user.pack_item_upsert(&item("audio.qdc.7", surah, 10, pinned, T0))
            .unwrap();
    }
    // A row that is not a surah never counts.
    user.pack_item_upsert(&item("audio.qdc.7", "file:update", 0, false, T0))
        .unwrap();
    f.env
        .content
        .timings_put(&timings(7, 1, false), true)
        .unwrap();
    let reciters = f.manager.reciters();
    let afasy = reciters.iter().find(|r| r.id == 7).unwrap();
    assert_eq!(
        (
            afasy.downloaded_surahs,
            afasy.cached_surahs,
            afasy.word_level
        ),
        (2, 1, false),
        "real timings without word segments override the catalog"
    );
    let other = reciters.iter().find(|r| r.id == 5).unwrap();
    assert!(
        other.word_level,
        "no timings yet: the catalog's probe result"
    );
    let listed = f.manager.items("audio.qdc.7").unwrap();
    assert_eq!(listed.iter().map(|i| i.item).collect::<Vec<_>>(), [1, 2, 3]);
}

#[tokio::test]
async fn known_updates_survive_a_restart_until_a_later_check() {
    let pack = quranenc_pack("tr.en.saheeh", PackKind::Translation);
    let f = Fixture::new(vec![pack.clone()]);
    f.env.user.set_test_clock(Some(T0));
    install_pack_db(&f.env, &pack, "1.1.2", &[1]).await;
    let checked = f
        .env
        .user
        .pack_installed("tr.en.saheeh")
        .unwrap()
        .unwrap()
        .last_checked_at;
    assert_eq!(checked, Some(T0));
    let known = serde_json::json!([{
        "update": { "packId": "tr.en.saheeh", "installed": "1.1.2", "latest": "1.1.3", "sizeKib": 507 },
        "checkedAt": T0
    }]);
    f.env
        .content
        .kv_put("packs.known_updates", &known.to_string(), T0)
        .unwrap();

    // The next start loads them.
    let (manager, _) = f.restart();
    manager.set_network_allowed(false);
    assert!(manager.startup().await.is_some());
    assert!(manager.startup().await.is_none(), "startup runs once");
    let state = |m: &quran_packs::PackManager| {
        m.list()
            .unwrap()
            .into_iter()
            .find(|p| p.id == "tr.en.saheeh")
            .unwrap()
            .state
    };
    assert_eq!(
        state(&manager),
        PackState::UpdateAvailable {
            installed: "1.1.2".into(),
            latest: "1.1.3".into()
        }
    );
    // A later check that found nothing makes it obsolete.
    let mut row = f.env.user.pack_installed("tr.en.saheeh").unwrap().unwrap();
    row.last_checked_at = Some(T0 + DAY_MS);
    f.env.user.pack_upsert(&row).unwrap();
    assert_eq!(
        state(&manager),
        PackState::Installed {
            version: "1.1.2".into()
        }
    );
    // Update checks need the network.
    assert!(matches!(
        manager.check_updates().await,
        Err(PackError::Offline)
    ));
}

#[tokio::test]
async fn startup_resyncs_the_registry_with_its_data() {
    let server = TestServer::start();
    let saheeh = quranenc_pack("tr.en.saheeh", PackKind::Translation);
    let f = Fixture::new(vec![
        decor_pack(&server),
        mushaf_pack(&server, "v2"),
        wbw_pack("en"),
        audio_pack(7, &hosts(&server)),
        saheeh.clone(),
    ]);
    let (user, content) = (&f.env.user, &f.env.content);
    // Mushaf: p1 is on disk, p2's file has gone.
    write(&f.env.path("mushaf/v2/p1.woff2"), 1_000);
    for page in ["p1", "p2"] {
        user.pack_item_upsert(&item("mushaf.v2", page, 1_000, true, T0))
            .unwrap();
    }
    user.pack_upsert(&installed(
        "mushaf.v2",
        PackKind::MushafFonts,
        InstalledStatus::Partial,
        2,
    ))
    .unwrap();
    // WBW: chapter 1 stored without a row; a pinned row for chapter 2 whose data is gone.
    let rows: Vec<WbwEntry> = (1..=4)
        .map(|w| WbwEntry {
            word_id: w,
            text: String::new(),
            translation: Some(format!("g{w}")),
            transliteration: None,
        })
        .collect();
    content
        .wbw_put_chapter(
            "wbw.en",
            1,
            &rows,
            &ChapterStamp {
                surah: 1,
                fetched_at_ms: T0,
                sha256: "ab".repeat(32),
                pinned: false,
            },
        )
        .unwrap();
    user.pack_item_upsert(&item("wbw.en", "ch2", 500, true, T0))
        .unwrap();
    // Audio: a pinned file whose timings were lost (a recovered content.db), an update job's leftover row, a stale
    // stream temp.
    write(&install::audio_path(&f.env.root, 7, 1), 4_096);
    user.pack_item_upsert(&item("audio.qdc.7", "001", 4_096, true, T0))
        .unwrap();
    user.pack_item_upsert(&item("audio.qdc.7", "file:update", 0, false, T0))
        .unwrap();
    write(&install::stream_part_path(&f.env.root, 7, 5), 100);
    // A whole pack whose database has gone.
    install_pack_db(&f.env, &saheeh, "1.1.2", &[1]).await;
    for entry in std::fs::read_dir(f.env.path("translation/tr.en.saheeh")).unwrap() {
        std::fs::remove_file(entry.unwrap().path().join("pack.db")).unwrap();
    }

    f.manager.set_network_allowed(false);
    let report = f.manager.startup().await.unwrap();
    assert_eq!(report.swept.stream_parts, 1);
    assert_eq!(report.resync.rows_dropped, 3, "{report:?}");
    assert_eq!(report.resync.rows_added, 1);
    assert_eq!(
        report.resync.missing_timings,
        [("audio.qdc.7".to_owned(), 1)]
    );
    assert_eq!(report.timings_repaired, 0, "offline: they wait");
    for id in ["mushaf.v2", "wbw.en", "audio.qdc.7", "tr.en.saheeh"] {
        assert!(report.resync.changed.contains(&id.to_owned()), "{id}");
        assert!(f.events.changed().contains(id), "{id} reported");
    }

    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 1,
            items_total: 604
        }
    );
    let wbw = f.manager.items("wbw.en").unwrap();
    assert_eq!(wbw.len(), 1);
    assert!(wbw[0].item == 1 && !wbw[0].pinned && wbw[0].kib > 0);
    assert_eq!(f.state("wbw.en"), PackState::NotInstalled);
    assert_eq!(
        f.state("audio.qdc.7"),
        PackState::Partial {
            items_present: 0,
            items_total: 114
        },
        "a pinned file without timings keeps its pin but is not present"
    );
    let audio = f.manager.items("audio.qdc.7").unwrap();
    assert_eq!(audio.len(), 1);
    assert!(audio[0].pinned, "never demoted to the evictable cache");
    assert!(install::audio_path(&f.env.root, 7, 1).is_file());
    assert_eq!(f.state("tr.en.saheeh"), PackState::NotInstalled);

    // Nothing more to fix: a second re-sync changes nothing.
    let again = f.manager.resync(None).await.unwrap();
    assert!(again.changed.is_empty() && again.rows_dropped == 0 && again.rows_added == 0);
}

/// A restored user.db (an older one, or another machine's) claims data this machine does not hold: the registry is
/// re-synced with what is on disk, and every catalog pack is reported changed.
#[tokio::test]
async fn a_replaced_registry_is_resynced_and_every_pack_reported() {
    let server = TestServer::start();
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v2")]);
    let user = &f.env.user;
    write(&f.env.path("mushaf/v2/p1.woff2"), 1_000);
    for page in ["p1", "p2", "p3"] {
        user.pack_item_upsert(&item("mushaf.v2", page, 1_000, true, T0))
            .unwrap();
    }
    user.pack_upsert(&installed(
        "mushaf.v2",
        PackKind::MushafFonts,
        InstalledStatus::Installed,
        604,
    ))
    .unwrap();
    f.events.clear();

    let report = f.manager.registry_replaced().await.unwrap();
    assert_eq!(
        report.rows_dropped, 2,
        "p2 and p3 are not on disk: {report:?}"
    );
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 1,
            items_total: 604
        },
        "never installed without its data"
    );
    assert_eq!(f.state("decor"), PackState::NotInstalled);
    assert_eq!(
        f.events.changed(),
        ["decor", "mushaf.v2"].map(str::to_owned).into(),
        "every pack is reported, changed by the re-sync or not"
    );
}

#[tokio::test]
async fn an_interrupted_removal_finishes_at_the_next_start() {
    let server = TestServer::start();
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v1")]);
    for page in 1..=2 {
        write(&f.env.path(&format!("mushaf/v1/p{page}.woff2")), 500);
        f.env
            .user
            .pack_item_upsert(&item("mushaf.v1", &format!("p{page}"), 500, true, T0))
            .unwrap();
    }
    f.env
        .user
        .pack_upsert(&installed(
            "mushaf.v1",
            PackKind::MushafFonts,
            InstalledStatus::Removing,
            2,
        ))
        .unwrap();
    assert_eq!(f.state("mushaf.v1"), PackState::NotInstalled);
    f.manager.set_network_allowed(false);
    let report = f.manager.startup().await.unwrap();
    assert_eq!(report.swept.pending_removals, ["mushaf.v1"]);
    assert_eq!(report.removals_finished, ["mushaf.v1"]);
    assert!(!f.env.path("mushaf/v1").exists());
    assert_eq!(manager_support::rows(&f.env.user, "mushaf.v1"), (false, 0));
}

#[tokio::test]
async fn interrupted_jobs_resume_at_the_next_start() {
    let server = TestServer::start();
    serve_pages(&server, "v2", 1..=2, 600);
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v2")]);
    // The journal of a job that was running when the app stopped.
    let journal = JobJournal {
        pack_id: "mushaf.v2".into(),
        scope: InstallScope::Items { items: vec![1, 2] },
        pin: true,
        state: JournalState::Active,
        error: None,
        created_at: T0,
        updated_at: T0,
    };
    let dir = install::staging_dir(&f.env.root, "mushaf.v2").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(install::JOURNAL_FILE),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    let report = f.manager.startup().await.unwrap();
    assert_eq!(report.resumed_jobs.len(), 1);
    assert_eq!(
        f.wait_job(report.resumed_jobs[0]).await,
        JobPhase::Completed
    );
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 2,
            items_total: 604
        }
    );
    assert!(!dir.exists(), "the journal leaves with the job");
}

#[tokio::test]
async fn the_network_switch_is_reported_and_gates_every_request() {
    let server = TestServer::start();
    serve_pages(&server, "v2", 1..=1, 600);
    let f = Fixture::new(vec![decor_pack(&server), mushaf_pack(&server, "v2")]);
    let on = Settings::default();
    let off = Settings {
        network_allowed: false,
        stream_cache_cap_mib: 300,
        ..Settings::default()
    };
    f.manager.apply_settings(&on, &off);
    assert_eq!(f.events.network(), [false]);
    assert!(!f.manager.online());
    assert_eq!(f.manager.stream_cache_cap_bytes(), 300 * 1024 * 1024);
    let page = f
        .manager
        .ensure_page_fonts(MushafStyle::QcfV2, &[1], FetchPriority::Interactive)
        .await
        .unwrap();
    assert_eq!(page[0].availability, FontAvailability::Unavailable);
    assert!(matches!(
        f.manager.ensure_decor().await,
        Err(PackError::Offline)
    ));
    assert_eq!(server.requests().len(), 0, "nothing reached the network");

    f.manager.apply_settings(&off, &on);
    assert_eq!(f.events.network(), [false, true]);
    assert!(f.manager.online());
    let page = f
        .manager
        .ensure_page_fonts(MushafStyle::QcfV2, &[1], FetchPriority::Interactive)
        .await
        .unwrap();
    assert_eq!(page[0].availability, FontAvailability::Ready);
    let decor = f.manager.ensure_decor().await.unwrap();
    assert!(decor.installed);
    assert_eq!(
        f.state("decor"),
        PackState::Installed {
            version: "2026.10".into()
        }
    );
}

#[tokio::test]
async fn disk_usage_counts_each_category() {
    let server = TestServer::start();
    let env = TestEnv::new();
    let root = env.root.clone();
    let f = Fixture::on(
        env,
        manager_support::catalog(vec![audio_pack(7, &hosts(&server))]),
    );
    write(&root.join("mushaf").join("v2").join("p1.woff2"), 2_048);
    write(&root.join("decor").join("quran-common.ttf"), 1_024);
    write(
        &root
            .join("translation")
            .join("tr.en.saheeh")
            .join("1")
            .join("pack.db"),
        3_000,
    );
    write(&install::audio_path(&root, 7, 1), 4_096);
    write(&install::audio_path(&root, 7, 2), 1_024);
    write(&install::stream_part_path(&root, 7, 3), 1_024);
    write(&root.join(".staging").join("x").join("job.json"), 1_024);
    f.env
        .user
        .pack_item_upsert(&item("audio.qdc.7", "001", 4_096, true, T0))
        .unwrap();
    f.env
        .user
        .pack_item_upsert(&item("audio.qdc.7", "002", 1_024, false, T0))
        .unwrap();
    let usage = f.manager.disk_usage().unwrap();
    assert_eq!(
        (
            usage.mushaf_kib,
            usage.decor_kib,
            usage.translation_kib,
            usage.tafsir_kib,
            usage.audio_pinned_kib,
            usage.audio_stream_kib
        ),
        (2, 1, 3, 0, 4, 2)
    );
    assert!(usage.user_db_kib > 0 && usage.content_db_kib > 0);
    assert_eq!(
        usage.total_kib,
        2 + 1 + 3 + 4 + 2 + usage.user_db_kib + usage.content_db_kib + 1,
        "the parts plus in-progress downloads"
    );
    assert_eq!(
        Path::new(&usage.data_dir),
        dunce::simplified(f.env.dir.path())
    );
}
