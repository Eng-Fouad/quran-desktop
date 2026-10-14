//! The pack manager's on-demand content: surah timings, Quran.com tafsir and word-by-word chapters fetched on the
//! interactive lane and recorded as cache, stale copies served offline, the "Update" of a recitation pack as a job, and
//! the startup repair of pinned files whose timings were lost. Upstream is a local server (`qf_support::upstream`,
//! which also serialises these tests).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod manager_support;
mod qf_support;
mod support;

use std::time::Duration;

use manager_support::{DAY_MS, Fixture, T0, catalog, word_core};
use qf_support::{audio_pack, qdc_files, tafsir_pack, tafsir_page, upstream, wbw_pack, wbw_page};
use quran_core::{CoreError, InstalledPackRow, InstalledStatus, PackItemRow};
use quran_packs::PackError;
use quran_packs::adapters::{qdc_audio, qurancom_tafsir, qurancom_wbw};
use quran_packs::install;
use quran_packs::manager::REVALIDATE_GRACE;
use quran_types::{InstallScope, JobPhase, PackKind, PackState, TextDir};
use support::http::{Route, TestServer};
use support::{TestEnv, bytes, eventually};

const AUDIO: &str = "audio.qdc.7";
const TAFSIR: &str = "tafsir.en.ibn_kathir";

/// The audio file server and the recitation pack served by it.
fn audio_fixture() -> (Fixture, TestServer) {
    let files = TestServer::start();
    let hosts = vec![format!("127.0.0.1:{}", files.port())];
    let f = Fixture::new(vec![audio_pack(7, &hosts)]);
    f.env.user.set_test_clock(Some(T0));
    (f, files)
}

fn audio_path(version: u32, surah: u32) -> String {
    format!("/qdc/v{version}/{surah}.mp3")
}

/// Serves version `version` of surah `surah` (`len` bytes) and the timings that point at it.
fn serve_audio(
    files: &TestServer,
    api: &qf_support::ApiServer,
    surah: u32,
    version: u32,
    len: usize,
) -> Vec<u8> {
    let body = bytes(len, u8::try_from(version * 10 + surah % 10).unwrap());
    files.route(
        &audio_path(version, surah),
        Route::bytes(body.clone()).etag(&format!("\"v{version}-{surah}\"")),
    );
    api.json(
        &qdc_audio::timings_url(7, surah),
        &qdc_files(
            surah,
            &files.url(&audio_path(version, surah)),
            1_000,
            version * 5,
        ),
    );
    body
}

fn invalid<T: std::fmt::Debug>(r: &Result<T, PackError>) -> bool {
    matches!(r, Err(PackError::Core(CoreError::InvalidArgument(_))))
}

#[tokio::test]
async fn timings_are_fetched_once_and_then_served_from_content_db() {
    let up = upstream().await;
    let (f, files) = audio_fixture();
    serve_audio(&files, &up.api, 1, 1, 3_000);
    let url = qdc_audio::timings_url(7, 1);

    let (a, b, c) = tokio::join!(
        f.manager.surah_timings(7, 1),
        f.manager.surah_timings(7, 1),
        f.manager.surah_timings(7, 1)
    );
    let t = a.unwrap();
    assert_eq!(t, b.unwrap());
    assert_eq!(t, c.unwrap());
    assert_eq!(up.api.hits(&url), 1, "one request for overlapping calls");
    assert_eq!(t.ayahs.len(), 7);
    assert_eq!(
        t.file.content_length,
        Some(3_000),
        "bound to the HEAD length"
    );
    assert!(f.env.content.timings_get(7, 1).unwrap().is_some());

    // Fresh: no request. Missing while offline: `Offline`, without a request.
    f.manager.surah_timings(7, 1).await.unwrap();
    assert_eq!(up.api.hits(&url), 1);
    f.manager.set_network_allowed(false);
    assert!(matches!(
        f.manager.surah_timings(7, 2).await,
        Err(PackError::Offline)
    ));
    assert!(matches!(
        f.manager.surah_timings(9_999, 1).await,
        Err(PackError::NotFound(_))
    ));
    assert!(invalid(&f.manager.surah_timings(7, 0).await));
    assert!(invalid(&f.manager.surah_timings(7, 115).await));
    // A stale copy is still served offline.
    f.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let stale = f.manager.surah_timings(7, 1).await.unwrap();
    assert_eq!(Some(stale), f.env.content.timings_get(7, 1).unwrap());
    assert_eq!(up.api.hits(&url), 1);
}

#[tokio::test]
async fn a_cached_file_that_changed_upstream_is_dropped_and_reported() {
    let up = upstream().await;
    let (f, files) = audio_fixture();
    serve_audio(&files, &up.api, 2, 1, 2_000);
    f.manager.surah_timings(7, 2).await.unwrap();
    // The stream cache holds the old file.
    let cached = install::audio_path(&f.env.root, 7, 2);
    std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
    std::fs::write(&cached, bytes(2_000, 1)).unwrap();
    f.env
        .user
        .pack_item_upsert(&PackItemRow {
            pack_id: AUDIO.into(),
            item: "002".into(),
            bytes: 2_000,
            sha256: String::new(),
            pinned: false,
            fetched_at: T0,
            last_used_at: T0,
        })
        .unwrap();

    serve_audio(&files, &up.api, 2, 2, 2_500);
    f.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    f.events.clear();
    let t = f.manager.surah_timings(7, 2).await.unwrap();
    assert!(t.file.audio_url.ends_with("/qdc/v2/2.mp3"));
    assert_eq!(t.file.content_length, Some(2_500));
    assert!(
        !cached.exists(),
        "the cached file no longer matches: dropped"
    );
    assert!(f.env.user.pack_item(AUDIO, "002").unwrap().is_none());
    assert!(f.events.changed().contains(AUDIO));

    // `refresh_surah_timings` refetches whatever the age.
    let before = up.api.hits(&qdc_audio::timings_url(7, 2));
    f.manager.refresh_surah_timings(7, 2).await.unwrap();
    assert_eq!(up.api.hits(&qdc_audio::timings_url(7, 2)), before + 1);
}

#[tokio::test]
async fn quran_com_tafsir_is_fetched_on_demand_recorded_and_served_stale_offline() {
    let up = upstream().await;
    let f = Fixture::new(vec![tafsir_pack(TAFSIR, 169)]);
    f.env.user.set_test_clock(Some(T0));
    let url = qurancom_tafsir::chapter_url(169, 1, 1);
    up.api.json(
        &url,
        &tafsir_page(
            &[
                ("1:1", "<p>one</p>"),
                ("1:2", "<p>two <b>and three</b></p>"),
                ("1:3", ""),
                ("1:4", "<p>four</p>"),
                ("1:5", "<p>five</p>"),
                ("1:6", "<p>six</p>"),
                ("1:7", "<p>seven</p>"),
            ],
            None,
        ),
    );

    let entry = f.manager.tafsir_entry(TAFSIR, 3).await.unwrap();
    assert_eq!(
        (entry.from_ayah_id, entry.to_ayah_id),
        (2, 3),
        "a grouped range"
    );
    assert_eq!(entry.html, "<p>two <b>and three</b></p>");
    assert_eq!((entry.lang.as_str(), entry.dir), ("en", TextDir::Ltr));
    assert_eq!(entry.fetched_at, Some(u32::try_from(T0 / 1000).unwrap()));
    assert!(!entry.stale);
    let row = f.env.user.pack_item(TAFSIR, "ch1").unwrap().unwrap();
    assert!(
        !row.pinned && row.bytes > 0,
        "recorded as an on-demand chapter"
    );
    assert!(f.events.changed().contains(TAFSIR));
    let listed = f.manager.items(TAFSIR).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].item == 1 && !listed[0].pinned);

    // Stored and fresh: no request.
    f.manager.tafsir_entry(TAFSIR, 1).await.unwrap();
    assert_eq!(up.api.hits(&url), 1);

    // Older than 7 days and the upstream failing: the stored copy, marked stale.
    f.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    up.api.fail(&url, 503, 20);
    let stale = f.manager.tafsir_entry(TAFSIR, 4).await.unwrap();
    assert!(stale.stale);
    assert_eq!(stale.html, "<p>four</p>");
    assert_eq!(stale.fetched_at, entry.fetched_at);
    up.api.recover(&url);

    // Not stored and offline.
    f.manager.set_network_allowed(false);
    assert!(matches!(
        f.manager.tafsir_entry(TAFSIR, 8).await,
        Err(PackError::Offline)
    ));
    f.manager.set_network_allowed(true);

    // An installed pack's on-demand chapters are pinned like downloaded ones.
    f.env
        .user
        .pack_upsert(&InstalledPackRow {
            pack_id: TAFSIR.into(),
            kind: PackKind::Tafsir,
            version: "2026.10".into(),
            path: None,
            status: InstalledStatus::Installed,
            bytes: 0,
            items_total: 114,
            items_present: 114,
            sha256: None,
            source_version: None,
            installed_at: T0,
            updated_at: T0,
            last_checked_at: None,
        })
        .unwrap();
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 112, 1),
        &tafsir_page(
            &[
                ("112:1", "<p>a</p>"),
                ("112:2", "<p>b</p>"),
                ("112:3", "<p>c</p>"),
                ("112:4", "<p>d</p>"),
            ],
            None,
        ),
    );
    let first_of_112 = quran_core::content_db::geometry::surah_ayah_ids(112)
        .unwrap()
        .next()
        .unwrap();
    f.manager.tafsir_entry(TAFSIR, first_of_112).await.unwrap();
    assert!(
        f.env
            .user
            .pack_item(TAFSIR, "ch112")
            .unwrap()
            .unwrap()
            .pinned
    );
    assert!(
        f.env
            .content
            .chapters(TAFSIR)
            .unwrap()
            .iter()
            .any(|s| s.surah == 112 && s.pinned)
    );
}

/// Stale-while-revalidate: a stored chapter older than its period is refetched, but a reader never waits past
/// `REVALIDATE_GRACE` for a slow (or stalled) upstream: the stored copy comes at once, marked stale, and the refetch
/// completes by itself, stores the new copy and reports the pack changed. A quick upstream is simply waited for.
#[tokio::test]
async fn a_stale_chapter_is_served_at_once_and_refreshed_in_the_background() {
    let up = upstream().await;
    let f = Fixture::new(vec![tafsir_pack(TAFSIR, 169)]);
    f.env.user.set_test_clock(Some(T0));
    let url = qurancom_tafsir::chapter_url(169, 1, 1);
    let page = |text: &str| {
        tafsir_page(
            &[
                ("1:1", text),
                ("1:2", "<p>2</p>"),
                ("1:3", "<p>3</p>"),
                ("1:4", "<p>4</p>"),
                ("1:5", "<p>5</p>"),
                ("1:6", "<p>6</p>"),
                ("1:7", "<p>7</p>"),
            ],
            None,
        )
    };
    up.api.json(&url, &page("<p>old</p>"));
    assert_eq!(
        f.manager.tafsir_entry(TAFSIR, 1).await.unwrap().html,
        "<p>old</p>"
    );

    // Eight days later upstream has a new text, and answers slowly.
    f.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    up.api.json(&url, &page("<p>new</p>"));
    up.api
        .slow(&url, REVALIDATE_GRACE + Duration::from_millis(1500));
    let t = std::time::Instant::now();
    let entry = f.manager.tafsir_entry(TAFSIR, 1).await.unwrap();
    let waited = t.elapsed();
    assert!(
        waited < REVALIDATE_GRACE + Duration::from_millis(800),
        "{waited:?}"
    );
    assert!(entry.stale);
    assert_eq!(entry.html, "<p>old</p>");
    let content = f.env.content.clone();
    assert!(
        eventually(Duration::from_secs(10), || {
            content
                .tafsir_get(TAFSIR, 1)
                .unwrap()
                .is_some_and(|row| row.html == "<p>new</p>")
        })
        .await,
        "the background refetch stored the new copy"
    );
    let fresh = f.manager.tafsir_entry(TAFSIR, 1).await.unwrap();
    assert!(!fresh.stale);
    assert_eq!(fresh.html, "<p>new</p>");
    assert_eq!(
        up.api.hits(&url),
        2,
        "one refetch, no request for the fresh copy"
    );

    // A quick upstream is waited for: the new copy at once, not stale.
    f.env.user.set_test_clock(Some(T0 + 16 * DAY_MS));
    up.api.slow(&url, Duration::ZERO);
    up.api.json(&url, &page("<p>newer</p>"));
    let entry = f.manager.tafsir_entry(TAFSIR, 1).await.unwrap();
    assert!(!entry.stale);
    assert_eq!(entry.html, "<p>newer</p>");
}

/// A Quran.com tafsir chapter stored without entries (no commentary upstream, e.g. Ibn Kathir abridged on surah 105) is
/// `NotFound` with a message that says so, without a request once stored.
#[tokio::test]
async fn a_chapter_without_commentary_is_not_found_without_a_request() {
    let up = upstream().await;
    let f = Fixture::new(vec![tafsir_pack(TAFSIR, 169)]);
    f.env.user.set_test_clock(Some(T0));
    let url = qurancom_tafsir::chapter_url(169, 105, 1);
    up.api.json(
        &url,
        &tafsir_page(
            &[
                ("105:1", ""),
                ("105:2", ""),
                ("105:3", ""),
                ("105:4", ""),
                ("105:5", ""),
            ],
            None,
        ),
    );
    let first = quran_core::content_db::geometry::surah_ayah_ids(105)
        .unwrap()
        .next()
        .unwrap();
    for _ in 0..2 {
        match f.manager.tafsir_entry(TAFSIR, first + 2).await {
            Err(PackError::NotFound(message)) => {
                assert!(message.contains("no commentary on surah 105"), "{message}");
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
    assert_eq!(
        up.api.hits(&url),
        1,
        "stored once, then served from content.db"
    );
}

#[tokio::test]
async fn word_by_word_ranges_span_chapters_and_carry_the_word_texts() {
    let up = upstream().await;
    let mut env = TestEnv::new();
    env.core = word_core(env.dir.path(), &[1, 2]);
    env.user.set_test_clock(Some(T0));
    let f = Fixture::on(env, catalog(vec![wbw_pack("en")]));
    let fatiha_7: Vec<(u32, String)> = (1..=9).map(|p| (p, format!("g7.{p}"))).collect();
    let fatiha_7: Vec<(u32, &str)> = fatiha_7.iter().map(|(p, g)| (*p, g.as_str())).collect();
    up.api.json(
        &qurancom_wbw::chapter_url("en", 1, 1),
        &wbw_page(&[("1:7", fatiha_7.as_slice(), 10)], None),
    );
    up.api.json(
        &qurancom_wbw::chapter_url("en", 2, 1),
        &wbw_page(&[("2:1", &[(1, "a"), (2, "b"), (3, "c")], 4)], None),
    );

    let words = f.manager.wbw_range("wbw.en", 30, 40).await.unwrap();
    // 1:7 is words 27..=36 (its end marker has no gloss); 2:1 starts at word 37.
    assert_eq!(
        words.iter().map(|w| w.word_id).collect::<Vec<_>>(),
        [30, 31, 32, 33, 34, 35, 37, 38, 39]
    );
    assert_eq!(words[0].translation.as_deref(), Some("g7.4"));
    assert_eq!(words[0].text, "w30", "the word's Hafs text from core.db");
    assert_eq!(words[6].translation.as_deref(), Some("a"));
    let listed = f.manager.items("wbw.en").unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|i| (i.item, i.pinned))
            .collect::<Vec<_>>(),
        [(1, false), (2, false)]
    );
    let requests = up.api.requests().len();
    f.manager.wbw_range("wbw.en", 1, 36).await.unwrap();
    assert_eq!(
        up.api.requests().len(),
        requests,
        "both chapters are stored"
    );

    assert!(invalid(&f.manager.wbw_range("wbw.en", 0, 3).await));
    assert!(invalid(&f.manager.wbw_range("wbw.en", 5, 4).await));
    assert!(invalid(&f.manager.wbw_range("wbw.en", 1, 83_666).await));
    assert!(matches!(
        f.manager.wbw_range("nope", 1, 2).await,
        Err(PackError::NotFound(_))
    ));
}

#[tokio::test]
async fn a_recitation_update_runs_as_a_job_and_swaps_the_changed_files() {
    let up = upstream().await;
    let (f, files) = audio_fixture();
    serve_audio(&files, &up.api, 1, 1, 1_500);
    serve_audio(&files, &up.api, 112, 1, 2_000);
    let job = f
        .manager
        .install(AUDIO, InstallScope::Items { items: vec![112] })
        .await
        .unwrap();
    assert_eq!(f.wait_job(job).await, JobPhase::Completed);
    assert_eq!(
        f.state(AUDIO),
        PackState::Partial {
            items_present: 2,
            items_total: 114
        },
        "surah 1 is pinned with any surah"
    );

    // Upstream re-uploads surah 112; a week later the check finds it.
    let v2 = serve_audio(&files, &up.api, 112, 2, 2_600);
    f.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let updates = f.manager.check_updates().await.unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].pack_id, AUDIO);
    assert!(matches!(f.state(AUDIO), PackState::UpdateAvailable { .. }));

    // "Update" is `install(id, All)`: a job that swaps the pinned pair, not a download of all 114 surahs.
    f.events.clear();
    files.clear_log();
    let update = f.manager.install(AUDIO, InstallScope::All).await.unwrap();
    assert_eq!(f.wait_job(update).await, JobPhase::Completed);
    assert_eq!(
        f.events.lifecycle(update),
        ["queued", "started", "completed"]
    );
    let path = install::audio_path(&f.env.root, 7, 112);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        v2,
        "the new file is in place"
    );
    let stored = f.env.content.timings_get(7, 112).unwrap().unwrap();
    assert!(stored.file.audio_url.ends_with("/qdc/v2/112.mp3"));
    assert_eq!(
        f.state(AUDIO),
        PackState::Partial {
            items_present: 2,
            items_total: 114
        },
        "the update is applied"
    );
    assert!(
        eventually(Duration::from_secs(10), || f
            .env
            .user
            .pack_item(AUDIO, "file:update")
            .unwrap()
            .is_none())
        .await,
        "the update job's row leaves with it"
    );
    let gets: Vec<String> = files
        .requests()
        .into_iter()
        .filter(|r| r.method == "GET")
        .map(|r| r.path)
        .collect();
    assert_eq!(
        gets,
        [audio_path(2, 112)],
        "only the changed file was downloaded"
    );
}

#[tokio::test]
async fn startup_repairs_the_timings_of_pinned_files() {
    let up = upstream().await;
    let (f, files) = audio_fixture();
    let body = serve_audio(&files, &up.api, 1, 1, 1_800);
    // A pinned file whose timings were lost with content.db.
    let path = install::audio_path(&f.env.root, 7, 1);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &body).unwrap();
    f.env
        .user
        .pack_item_upsert(&PackItemRow {
            pack_id: AUDIO.into(),
            item: "001".into(),
            bytes: 1_800,
            sha256: String::new(),
            pinned: true,
            fetched_at: T0,
            last_used_at: T0,
        })
        .unwrap();

    let report = f.manager.startup().await.unwrap();
    assert_eq!(report.resync.missing_timings, [(AUDIO.to_owned(), 1)]);
    assert_eq!(report.timings_repaired, 1);
    let stamp = f
        .env
        .content
        .timing_stamps(Some(7))
        .unwrap()
        .into_iter()
        .find(|s| s.surah == 1)
        .unwrap();
    assert!(stamp.pinned, "the file on disk is the one they describe");
    assert_eq!(
        f.state(AUDIO),
        PackState::Partial {
            items_present: 1,
            items_total: 114
        }
    );
    assert_eq!(
        files
            .requests_to(&audio_path(1, 1))
            .iter()
            .filter(|r| r.method == "GET")
            .count(),
        0,
        "no audio was downloaded"
    );
}
