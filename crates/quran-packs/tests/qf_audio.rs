//! QDC recitations (`qdc_audio`, docs/ARCHITECTURE.md §2.5.5–§2.5.7): timings bound to the exact file, explicit
//! downloads (single writer, surah 1 pinned with any surah), and the upstream-change policy (pinned audio keeps the old
//! pair until the new one is complete). Owner: WP5d.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod qf_support;
mod support;

use std::time::Duration;

use qf_support::{DAY_MS, T0, audio_pack, catalog, qdc_files, upstream};
use quran_core::{InstalledPackRow, InstalledStatus, PackItemRow};
use quran_packs::adapters::qdc_audio::{self, TimingsChange};
use quran_packs::adapters::{ItemOutcome, QdcAudioConfig};
use quran_packs::install;
use quran_packs::jobs::{JobHandle, JobSpec, catalog_specs};
use quran_packs::revalidate::MAX_AGE;
use quran_packs::{AdapterCtx, PackError};
use quran_types::{InstallScope, JobPhase, PackKind};
use support::http::{Action, Route, TestServer};
use support::{TestEnv, bytes, eventually, sha256_hex};

const RECITER: u32 = 7;
const PACK: &str = "audio.qdc.7";
const LM_V1: &str = "Tue, 03 Mar 2026 10:00:00 GMT";
const LM_V2: &str = "Wed, 21 Oct 2026 07:28:00 GMT";

struct Audio {
    env: TestEnv,
    files: TestServer,
    cfg: QdcAudioConfig,
}

impl Audio {
    fn new() -> Self {
        let env = TestEnv::new();
        env.user.set_test_clock(Some(T0));
        let files = TestServer::start();
        let hosts = vec![
            format!("127.0.0.1:{}", files.port()),
            format!("localhost:{}", files.port()),
        ];
        let cfg = match audio_pack(RECITER, &hosts).source {
            quran_packs::Adapter::QdcAudio(c) => c,
            other => panic!("{other:?}"),
        };
        Self { env, files, cfg }
    }

    fn path(version: u32, surah: u32) -> String {
        format!("/qdc/afasy/v{version}/{surah}.mp3")
    }

    fn audio_url(&self, version: u32, surah: u32) -> String {
        self.files.url(&Self::path(version, surah))
    }

    /// Serves version `version` of surah `surah` (`len` bytes) and its timings.
    fn serve(
        &self,
        api: &qf_support::ApiServer,
        surah: u32,
        version: u32,
        len: usize,
        route: impl FnOnce(Route) -> Route,
    ) -> Vec<u8> {
        let body = bytes(len, u8::try_from(version * 10 + surah % 10).unwrap());
        let lm = if version == 1 { LM_V1 } else { LM_V2 };
        self.files.route(
            &Self::path(version, surah),
            route(
                Route::bytes(body.clone())
                    .etag(&format!("\"v{version}\""))
                    .last_modified(lm),
            ),
        );
        api.json(
            &qdc_audio::timings_url(RECITER, surah),
            &qdc_files(surah, &self.audio_url(version, surah), 1000, version * 7),
        );
        body
    }

    fn ctx(&self, job: bool, pin: bool) -> AdapterCtx {
        self.env.ctx(
            PACK,
            PackKind::Recitation,
            job.then(|| JobHandle::detached(1, PACK)),
            pin,
        )
    }

    fn dest(&self, surah: u32) -> std::path::PathBuf {
        install::audio_path(&self.env.root, RECITER, surah)
    }

    fn gets(&self, version: u32, surah: u32) -> usize {
        self.files
            .requests_to(&Self::path(version, surah))
            .iter()
            .filter(|r| r.method == "GET")
            .count()
    }

    fn pinned(&self, surah: u32) -> bool {
        self.env
            .content
            .timing_stamps(Some(RECITER))
            .unwrap()
            .iter()
            .any(|s| s.surah == surah && s.pinned)
    }
}

#[tokio::test]
async fn timings_are_bound_to_the_http_length_of_their_file() {
    let up = upstream().await;
    let a = Audio::new();
    a.serve(&up.api, 112, 1, 40_000, |r| r);

    let refresh = qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap();
    assert_eq!(refresh.change, TimingsChange::New);
    let t = &refresh.timings;
    assert_eq!(t.file.audio_url, a.audio_url(1, 112));
    assert_eq!(
        t.file.content_length,
        Some(40_000),
        "HTTP Content-Length, never QDC's file_size"
    );
    assert_eq!(t.file.etag.as_deref(), Some("\"v1\""));
    assert_eq!((t.file.source.as_str(), t.file.fetched_at_ms), ("qdc", T0));
    let payload = serde_json::to_vec(&qdc_files(112, &a.audio_url(1, 112), 1000, 7)).unwrap();
    assert_eq!(t.file.payload_sha256, sha256_hex(&payload));
    assert!(t.word_level);
    assert_eq!(t.ayahs.len(), 4);
    assert_eq!((t.ayahs[0].from_ms, t.ayahs[3].to_ms), (7, 4007));
    assert_eq!(
        a.env.content.timings_get(RECITER, 112).unwrap().as_ref(),
        Some(t)
    );
    assert!(!a.pinned(112), "on-demand timings are not pinned");
    let reqs = a.files.requests_to(&Audio::path(1, 112));
    assert_eq!(
        reqs.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(),
        ["HEAD"]
    );
    assert_eq!(
        qdc_audio::fetch_timings(&a.ctx(false, false), &a.cfg, 112)
            .await
            .unwrap()
            .file
            .content_length,
        Some(40_000)
    );
}

#[tokio::test]
async fn the_head_falls_back_to_the_next_host() {
    let up = upstream().await;
    let a = Audio::new();
    a.serve(&up.api, 112, 1, 1_000, |r| r.then(Action::Status(503)));
    let t = qdc_audio::fetch_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap();
    assert_eq!(t.file.content_length, Some(1_000));
    let hosts: Vec<String> = a
        .files
        .requests_to(&Audio::path(1, 112))
        .into_iter()
        .map(|r| r.host)
        .collect();
    assert_eq!(hosts.len(), 2, "{hosts:?}");
    assert!(
        hosts[0].starts_with("127.0.0.1:") && hosts[1].starts_with("localhost:"),
        "{hosts:?}"
    );
    assert_eq!(
        t.file.audio_url,
        a.audio_url(1, 112),
        "the canonical URL is stored, not the mirror"
    );
}

#[tokio::test]
async fn an_explicit_download_pins_the_surah_and_surah_1() {
    let up = upstream().await;
    let a = Audio::new();
    let one = a.serve(&up.api, 1, 1, 30_000, |r| r);
    let ikhlas = a.serve(&up.api, 112, 1, 40_000, |r| r);
    let pack = audio_pack(RECITER, &a.cfg.hosts);
    let queue = a
        .env
        .queue(catalog_specs(catalog(vec![pack.clone()])), 3, 4);
    let job = queue
        .enqueue(JobSpec::from_catalog(
            &pack,
            InstallScope::Items { items: vec![112] },
            true,
        ))
        .await
        .unwrap();
    assert_eq!(queue.wait(job).await, Some(JobPhase::Completed));

    assert_eq!(std::fs::read(a.dest(1)).unwrap(), one);
    assert_eq!(std::fs::read(a.dest(112)).unwrap(), ikhlas);
    let items = a.env.user.pack_items(PACK).unwrap();
    assert_eq!(
        items
            .iter()
            .map(|i| (i.item.as_str(), i.pinned, i.bytes))
            .collect::<Vec<_>>(),
        [("001", true, 30_000), ("112", true, 40_000)]
    );
    assert_eq!(items[1].sha256, sha256_hex(&ikhlas));
    assert!(
        a.pinned(1) && a.pinned(112),
        "a pinned file's timings are pinned (they survive Clear cache)"
    );
    let row = a.env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(
        (row.status, row.items_present, row.bytes),
        (InstalledStatus::Partial, 2, 70_000)
    );

    let cleared = a.env.content.clear_unpinned().unwrap();
    assert!(cleared.timings.is_empty());
    assert!(!install::dl_part_path(&a.dest(112)).exists());
}

#[tokio::test]
async fn a_file_a_stream_completed_is_only_pinned() {
    let up = upstream().await;
    let a = Audio::new();
    let body = a.serve(&up.api, 112, 1, 40_000, |r| r);
    // A stream promoted the file and the glue registered it as stream cache.
    std::fs::create_dir_all(a.dest(112).parent().unwrap()).unwrap();
    std::fs::write(a.dest(112), &body).unwrap();
    a.env
        .user
        .pack_item_upsert(&PackItemRow {
            pack_id: PACK.into(),
            item: "112".into(),
            bytes: 40_000,
            sha256: String::new(),
            pinned: false,
            fetched_at: T0,
            last_used_at: T0,
        })
        .unwrap();

    let outcome = qdc_audio::fetch_surah(&a.ctx(true, true), &a.cfg, 112)
        .await
        .unwrap();
    assert_eq!(outcome, ItemOutcome::Present { bytes: 40_000 });
    assert_eq!(a.gets(1, 112), 0, "nothing downloaded");
    assert!(a.pinned(112));
}

#[tokio::test]
async fn a_job_item_waits_for_a_live_stream_of_its_surah() {
    let up = upstream().await;
    let a = Audio::new();
    let body = a.serve(&up.api, 112, 1, 40_000, |r| r);
    a.env.writers.stream_begin(RECITER, 112);

    let task = {
        let (ctx, cfg) = (a.ctx(true, true), a.cfg.clone());
        tokio::spawn(async move { qdc_audio::fetch_surah(&ctx, &cfg, 112).await })
    };
    // The timings are fetched, then the item waits for the stream.
    assert!(
        eventually(Duration::from_secs(5), || a
            .env
            .content
            .timings_get(RECITER, 112)
            .unwrap()
            .is_some())
        .await
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!task.is_finished());
    assert_eq!(a.gets(1, 112), 0);

    // The stream completes and promotes the file.
    std::fs::create_dir_all(a.dest(112).parent().unwrap()).unwrap();
    std::fs::write(a.dest(112), &body).unwrap();
    a.env.writers.stream_end(RECITER, 112, Some(40_000));
    let outcome = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(outcome, ItemOutcome::Present { bytes: 40_000 });
    assert_eq!(a.gets(1, 112), 0);
    assert!(a.pinned(112));
}

#[tokio::test]
async fn an_unpinned_file_that_changed_upstream_is_dropped() {
    let up = upstream().await;
    let a = Audio::new();
    let v1 = a.serve(&up.api, 112, 1, 40_000, |r| r);
    qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap();
    std::fs::create_dir_all(a.dest(112).parent().unwrap()).unwrap();
    std::fs::write(a.dest(112), &v1).unwrap();
    a.env
        .user
        .pack_item_upsert(&PackItemRow {
            pack_id: PACK.into(),
            item: "112".into(),
            bytes: 40_000,
            sha256: String::new(),
            pinned: false,
            fetched_at: T0,
            last_used_at: T0,
        })
        .unwrap();

    a.serve(&up.api, 112, 2, 41_000, |r| r);
    a.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let refresh = qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap();
    assert_eq!(
        refresh.change,
        TimingsChange::FileReplaced { freed: 40_000 }
    );
    assert!(!a.dest(112).exists());
    assert!(a.env.user.pack_item(PACK, "112").unwrap().is_none());
    let stored = a.env.content.timings_get(RECITER, 112).unwrap().unwrap();
    assert_eq!(
        (stored.file.audio_url, stored.file.content_length),
        (a.audio_url(2, 112), Some(41_000))
    );
    assert_eq!(stored.file.fetched_at_ms, T0 + 8 * DAY_MS);
}

/// Pins surah 112 at version 1 (file, timings, item) with an installed row.
async fn pin_v1(a: &Audio, api: &qf_support::ApiServer) -> Vec<u8> {
    let v1 = a.serve(api, 112, 1, 40_000, |r| r);
    let outcome = qdc_audio::fetch_surah(&a.ctx(true, true), &a.cfg, 112)
        .await
        .unwrap();
    let ItemOutcome::Stored { bytes, sha256 } = outcome else {
        panic!("{outcome:?}");
    };
    a.env
        .user
        .pack_item_upsert(&PackItemRow {
            pack_id: PACK.into(),
            item: "112".into(),
            bytes,
            sha256,
            pinned: true,
            fetched_at: T0,
            last_used_at: T0,
        })
        .unwrap();
    a.env
        .user
        .pack_upsert(&InstalledPackRow {
            pack_id: PACK.into(),
            kind: PackKind::Recitation,
            version: "2026.10".into(),
            path: None,
            status: InstalledStatus::Partial,
            bytes,
            items_total: 114,
            items_present: 1,
            sha256: None,
            source_version: None,
            installed_at: T0,
            updated_at: T0,
            last_checked_at: None,
        })
        .unwrap();
    v1
}

#[tokio::test]
async fn pinned_audio_keeps_the_old_pair_until_the_new_one_is_complete() {
    let up = upstream().await;
    let a = Audio::new();
    let v1 = pin_v1(&a, &up.api).await;
    let old = a.env.content.timings_get(RECITER, 112).unwrap().unwrap();

    // Upstream re-encodes the file (new URL and length, re-timed segments); it downloads slowly.
    let v2 = a.serve(&up.api, 112, 2, 45_000, |r| {
        r.throttle(1_500, Duration::from_millis(15))
    });
    a.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));

    // The interactive lane keeps playing the old pair.
    let refresh = qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap();
    assert_eq!(refresh.change, TimingsChange::PinnedFileChanged);
    assert_eq!(refresh.timings, old);
    assert_eq!(
        a.env.content.timings_get(RECITER, 112).unwrap().unwrap(),
        old,
        "old timings, still stale"
    );

    // The revalidator downloads beside it, then swaps.
    let task = {
        let (ctx, cfg) = (a.ctx(true, false), a.cfg.clone());
        tokio::spawn(async move { qdc_audio::revalidate_surah(&ctx, &cfg, 112).await })
    };
    let temp = install::dl_part_path(&qdc_audio::next_path(&a.env.root, RECITER, 112));
    assert!(
        eventually(Duration::from_secs(10), || temp.exists()).await,
        "the new file downloads to {temp:?}"
    );
    assert_eq!(
        std::fs::read(a.dest(112)).unwrap(),
        v1,
        "the pinned file is never deleted first"
    );
    assert_eq!(
        a.env.content.timings_get(RECITER, 112).unwrap().unwrap(),
        old
    );

    let swapped = tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(swapped.change, TimingsChange::PinnedFileSwapped);
    assert_eq!(std::fs::read(a.dest(112)).unwrap(), v2);
    let new = a.env.content.timings_get(RECITER, 112).unwrap().unwrap();
    assert_eq!(
        (new.file.audio_url.clone(), new.file.content_length),
        (a.audio_url(2, 112), Some(45_000))
    );
    assert_eq!(new.ayahs[0].from_ms, 14, "the new pair's timings");
    assert_eq!(new, swapped.timings);
    assert!(a.pinned(112));
    let item = a.env.user.pack_item(PACK, "112").unwrap().unwrap();
    assert_eq!(
        (item.pinned, item.bytes, item.sha256),
        (true, 45_000, sha256_hex(&v2))
    );
    assert_eq!(
        a.env.user.pack_installed(PACK).unwrap().unwrap().bytes,
        45_000
    );
    assert!(!qdc_audio::next_path(&a.env.root, RECITER, 112).exists());
    assert!(!temp.exists());
}

#[tokio::test]
async fn a_failed_swap_leaves_the_old_pair_and_is_retried() {
    let up = upstream().await;
    let a = Audio::new();
    let v1 = pin_v1(&a, &up.api).await;
    let old = a.env.content.timings_get(RECITER, 112).unwrap().unwrap();

    // The HEAD works, every GET of the new file fails.
    let v2 = a.serve(&up.api, 112, 2, 45_000, |r| {
        (0..16).fold(r.then(Action::Serve), |r, _| r.then(Action::Status(500)))
    });
    a.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let err = qdc_audio::revalidate_surah(&a.ctx(true, false), &a.cfg, 112)
        .await
        .unwrap_err();
    assert!(
        matches!(err, PackError::Http { status: 500, .. }),
        "{err:?}"
    );
    assert_eq!(std::fs::read(a.dest(112)).unwrap(), v1);
    let kept = a.env.content.timings_get(RECITER, 112).unwrap().unwrap();
    assert_eq!(kept, old);
    assert_eq!(
        kept.file.fetched_at_ms, T0,
        "still stale, so the next pass retries"
    );

    // The next attempt succeeds.
    a.files.route(
        &Audio::path(2, 112),
        Route::bytes(v2.clone()).last_modified(LM_V2),
    );
    let swapped = qdc_audio::revalidate_surah(&a.ctx(true, false), &a.cfg, 112)
        .await
        .unwrap();
    assert_eq!(swapped.change, TimingsChange::PinnedFileSwapped);
    assert_eq!(std::fs::read(a.dest(112)).unwrap(), v2);
}

#[tokio::test]
async fn ensure_timings_follows_freshness_and_the_network() {
    let up = upstream().await;
    let a = Audio::new();
    a.serve(&up.api, 112, 1, 1_000, |r| r);
    let first = qdc_audio::ensure_timings(&a.ctx(false, false), &a.cfg, 112, MAX_AGE)
        .await
        .unwrap();
    assert_eq!(
        (first.stale, first.change),
        (false, Some(TimingsChange::New))
    );
    up.api.clear_log();

    let fresh = qdc_audio::ensure_timings(&a.ctx(false, false), &a.cfg, 112, MAX_AGE)
        .await
        .unwrap();
    assert_eq!((fresh.stale, fresh.change), (false, None));
    assert!(up.api.requests().is_empty());

    a.env.user.set_test_clock(Some(T0 + 10 * DAY_MS));
    a.env.http.set_network_allowed(false);
    let stale = qdc_audio::ensure_timings(&a.ctx(false, false), &a.cfg, 112, MAX_AGE)
        .await
        .unwrap();
    assert!(stale.stale);
    assert_eq!(stale.timings, first.timings);
    let err = qdc_audio::ensure_timings(&a.ctx(false, false), &a.cfg, 113, MAX_AGE)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Offline), "{err:?}");

    a.env.http.set_network_allowed(true);
    let renewed = qdc_audio::ensure_timings(&a.ctx(false, false), &a.cfg, 112, MAX_AGE)
        .await
        .unwrap();
    assert_eq!(
        (renewed.stale, renewed.change),
        (false, Some(TimingsChange::Unchanged))
    );
    assert_eq!(renewed.timings.file.fetched_at_ms, T0 + 10 * DAY_MS);
}

#[tokio::test]
async fn corrupt_upstream_timings_are_rejected() {
    let up = upstream().await;
    let a = Audio::new();
    a.serve(&up.api, 112, 1, 1_000, |r| r);
    // Ayah 4 is missing.
    let mut files = qdc_files(112, &a.audio_url(1, 112), 1000, 0);
    files["audio_files"][0]["verse_timings"]
        .as_array_mut()
        .unwrap()
        .pop();
    up.api.json(&qdc_audio::timings_url(RECITER, 112), &files);
    let err = qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");

    // No element for this surah.
    up.api.json(
        &qdc_audio::timings_url(RECITER, 112),
        &serde_json::json!({ "audio_files": [] }),
    );
    let err = qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 112)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    assert!(a.env.content.timings_get(RECITER, 112).unwrap().is_none());
    assert!(
        qdc_audio::refresh_timings(&a.ctx(false, false), &a.cfg, 0)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn check_update_reports_changed_pinned_files_only() {
    let up = upstream().await;
    let a = Audio::new();
    pin_v1(&a, &up.api).await;
    let row = a.env.user.pack_installed(PACK).unwrap().unwrap();

    // Verified within 7 days: no request at all.
    up.api.clear_log();
    a.files.clear_log();
    assert_eq!(
        qdc_audio::check_update(&a.ctx(true, false), &a.cfg, &row)
            .await
            .unwrap(),
        None
    );
    assert!(up.api.requests().is_empty() && a.files.requests().is_empty());

    // Stale but unchanged: re-stamped, no update.
    a.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    assert_eq!(
        qdc_audio::check_update(&a.ctx(true, false), &a.cfg, &row)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        a.env
            .content
            .timings_get(RECITER, 112)
            .unwrap()
            .unwrap()
            .file
            .fetched_at_ms,
        T0 + 8 * DAY_MS
    );

    // Changed upstream: reported (labelled by the new file's Last-Modified), nothing replaced.
    a.serve(&up.api, 112, 2, 45_000, |r| r);
    a.env.user.set_test_clock(Some(T0 + 16 * DAY_MS));
    let changes = qdc_audio::pinned_changes(&a.ctx(true, false), &a.cfg)
        .await
        .unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(
        (changes[0].surah, changes[0].old_len, changes[0].new_len),
        (112, Some(40_000), Some(45_000))
    );
    assert_eq!(
        qdc_audio::check_update(&a.ctx(true, false), &a.cfg, &row)
            .await
            .unwrap()
            .as_deref(),
        Some("2026.10.21")
    );
    assert_eq!(
        a.env
            .content
            .timings_get(RECITER, 112)
            .unwrap()
            .unwrap()
            .file
            .content_length,
        Some(40_000)
    );
    assert_eq!(a.gets(2, 112), 0);
}

#[tokio::test]
async fn adapter_dispatch_reaches_the_recitation_items() {
    let up = upstream().await;
    let a = Audio::new();
    a.serve(&up.api, 2, 1, 2_000, |r| r);
    let adapter = quran_packs::Adapter::QdcAudio(a.cfg.clone());
    let outcome = adapter
        .fetch_item(&a.ctx(true, true), &quran_packs::ItemKey::Surah(2))
        .await
        .unwrap();
    assert!(
        matches!(outcome, ItemOutcome::Stored { bytes: 2_000, .. }),
        "{outcome:?}"
    );
    let row = InstalledPackRow {
        pack_id: PACK.into(),
        kind: PackKind::Recitation,
        version: "2026.10".into(),
        path: None,
        status: InstalledStatus::Partial,
        bytes: 2_000,
        items_total: 114,
        items_present: 1,
        sha256: None,
        source_version: None,
        installed_at: T0,
        updated_at: T0,
        last_checked_at: None,
    };
    assert_eq!(
        adapter
            .check_update(&a.ctx(true, false), &row)
            .await
            .unwrap(),
        None
    );
}
