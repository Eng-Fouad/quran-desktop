//! The 7-day revalidator: what a pass refetches, the audio policy, the network rule and the scheduler.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod qf_support;
mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use qf_support::{
    DAY_MS, T0, audio_pack, catalog, ctx_with_core, mini_core, qdc_files, revalidate_env,
    tafsir_pack, tafsir_page, upstream, wbw_pack, wbw_page,
};
use quran_core::{CoreDb, PackItemRow};
use quran_packs::adapters::{
    QdcAudioConfig, QurancomTafsirConfig, QurancomWbwConfig, qdc_audio, qurancom_tafsir,
    qurancom_wbw,
};
use quran_packs::install;
use quran_packs::jobs::JobHandle;
use quran_packs::revalidate::{MAX_AGE, PassReport, Revalidator, RevalidatorConfig};
use quran_packs::{AdapterCtx, PackError};
use quran_types::PackKind;
use support::http::{Route, TestServer};
use support::{TestEnv, bytes, eventually};

const TAFSIR: &str = "tafsir.en.ibn_kathir";
const WBW: &str = "wbw.en";
const AUDIO: &str = "audio.qdc.7";

struct World {
    env: TestEnv,
    core: CoreDb,
    files: TestServer,
    hosts: Vec<String>,
    changes: Arc<Mutex<Vec<Vec<String>>>>,
    revalidator: Revalidator,
}

fn fast() -> RevalidatorConfig {
    RevalidatorConfig {
        first_delay: Duration::from_millis(30),
        interval: Duration::from_secs(3600),
        offline_retry: Duration::from_millis(50),
        concurrency: 2,
        update_check_interval: Duration::from_secs(86_400),
    }
}

impl World {
    fn new(cfg: RevalidatorConfig) -> Self {
        let env = TestEnv::new();
        env.user.set_test_clock(Some(T0));
        let core = mini_core(env.dir.path(), &[1, 112]);
        let files = TestServer::start();
        let hosts = vec![format!("127.0.0.1:{}", files.port())];
        let catalog = catalog(vec![
            tafsir_pack(TAFSIR, 169),
            wbw_pack("en"),
            audio_pack(7, &hosts),
        ]);
        let changes: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let sink = Arc::clone(&changes);
        let revalidator = Revalidator::new(revalidate_env(&env, &core, catalog), cfg, move |ids| {
            sink.lock().unwrap().push(ids);
        });
        Self {
            env,
            core,
            files,
            hosts,
            changes,
            revalidator,
        }
    }

    fn ctx(&self, pack: &str, kind: PackKind, pin: bool) -> AdapterCtx {
        ctx_with_core(
            &self.env,
            &self.core,
            pack,
            kind,
            Some(JobHandle::detached(1, pack)),
            pin,
        )
    }

    fn audio_cfg(&self) -> QdcAudioConfig {
        QdcAudioConfig {
            reciter_id: 7,
            name: quran_types::L10nText {
                en: "R".into(),
                ar: "ق".into(),
            },
            style: None,
            basmala_in_file: false,
            hosts: self.hosts.clone(),
            word_level: true,
        }
    }

    /// Serves version `v` of surah `surah`'s audio (`len` bytes) and its timings.
    fn serve_audio(&self, api: &qf_support::ApiServer, surah: u32, v: u32, len: usize) -> Vec<u8> {
        let path = format!("/v{v}/{surah}.mp3");
        let body = bytes(len, u8::try_from(v * 16 + surah % 16).unwrap());
        self.files.route(&path, Route::bytes(body.clone()));
        api.json(
            &qdc_audio::timings_url(7, surah),
            &qdc_files(surah, &self.files.url(&path), 1000, v),
        );
        body
    }

    fn changes(&self) -> Vec<Vec<String>> {
        self.changes.lock().unwrap().clone()
    }

    fn timings_at(&self, surah: u32) -> i64 {
        self.env
            .content
            .timings_get(7, surah)
            .unwrap()
            .unwrap()
            .file
            .fetched_at_ms
    }

    fn chapter_at(&self, pack: &str) -> i64 {
        self.env.content.chapters(pack).unwrap()[0].fetched_at_ms
    }
}

/// Tafsir and WBW chapter 1 and the timings of 112, all fetched at T0.
async fn seed(w: &World, api: &qf_support::ApiServer) {
    api.json(
        &qurancom_tafsir::chapter_url(169, 1, 1),
        &tafsir_page(&[("1:1", "<p>a</p>"), ("1:2", "<p>b</p>")], None),
    );
    api.json(
        &qurancom_wbw::chapter_url("en", 1, 1),
        &wbw_page(
            &[("1:1", &[(1, "In (the) name"), (2, "(of) Allah")], 5)],
            None,
        ),
    );
    w.serve_audio(api, 112, 1, 4_000);
    let tafsir = QurancomTafsirConfig { resource_id: 169 };
    qurancom_tafsir::ensure_chapter(&w.ctx(TAFSIR, PackKind::Tafsir, false), &tafsir, 1, MAX_AGE)
        .await
        .unwrap();
    let wbw = QurancomWbwConfig {
        language: "en".into(),
    };
    qurancom_wbw::ensure_chapter(&w.ctx(WBW, PackKind::Wbw, false), &wbw, 1, MAX_AGE)
        .await
        .unwrap();
    qdc_audio::refresh_timings(
        &w.ctx(AUDIO, PackKind::Recitation, false),
        &w.audio_cfg(),
        112,
    )
    .await
    .unwrap();
    api.clear_log();
}

#[tokio::test]
async fn a_pass_refetches_only_items_past_their_period() {
    let up = upstream().await;
    let w = World::new(fast());
    seed(&w, &up.api).await;

    w.env.user.set_test_clock(Some(T0 + 3 * DAY_MS));
    let report = w.revalidator.run_pass().await.unwrap();
    assert_eq!(report, PassReport::default());
    assert!(up.api.requests().is_empty(), "{:?}", up.api.requests());

    let now = T0 + 7 * DAY_MS;
    w.env.user.set_test_clock(Some(now));
    let report = w.revalidator.run_pass().await.unwrap();
    assert_eq!(
        (report.due, report.unchanged, report.failed, report.skipped),
        (3, 3, 0, 0),
        "{report:?}"
    );
    assert_eq!(
        (w.chapter_at(TAFSIR), w.chapter_at(WBW), w.timings_at(112)),
        (now, now, now)
    );
    assert_eq!(up.api.requests().len(), 3);
    assert!(
        w.changes().is_empty(),
        "content refreshes do not change pack states"
    );
}

#[tokio::test]
async fn a_pass_applies_the_audio_policy() {
    let up = upstream().await;
    let w = World::new(fast());
    let ctx = w.ctx(AUDIO, PackKind::Recitation, true);
    // 112 pinned (an explicit download), 113 stream-cached.
    w.serve_audio(&up.api, 112, 1, 4_000);
    qdc_audio::fetch_surah(&ctx, &w.audio_cfg(), 112)
        .await
        .unwrap();
    let v1_113 = w.serve_audio(&up.api, 113, 1, 3_000);
    qdc_audio::refresh_timings(
        &w.ctx(AUDIO, PackKind::Recitation, false),
        &w.audio_cfg(),
        113,
    )
    .await
    .unwrap();
    std::fs::write(install::audio_path(&w.env.root, 7, 113), &v1_113).unwrap();
    for (item, pinned) in [("112", true), ("113", false)] {
        w.env
            .user
            .pack_item_upsert(&PackItemRow {
                pack_id: AUDIO.into(),
                item: item.into(),
                bytes: 0,
                sha256: String::new(),
                pinned,
                fetched_at: T0,
                last_used_at: T0,
            })
            .unwrap();
    }

    let v2_112 = w.serve_audio(&up.api, 112, 2, 4_500);
    w.serve_audio(&up.api, 113, 2, 3_300);
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let report = w.revalidator.run_pass().await.unwrap();
    assert_eq!(
        (
            report.due,
            report.files_swapped,
            report.files_dropped,
            report.failed
        ),
        (2, 1, 1, 0),
        "{report:?}"
    );
    assert_eq!(report.changed_packs, [AUDIO]);
    assert_eq!(w.changes(), [vec![AUDIO.to_owned()]]);
    assert_eq!(
        std::fs::read(install::audio_path(&w.env.root, 7, 112)).unwrap(),
        v2_112
    );
    assert!(!install::audio_path(&w.env.root, 7, 113).exists());
    assert!(w.env.user.pack_item(AUDIO, "113").unwrap().is_none());
    assert_eq!(
        w.env
            .content
            .timings_get(7, 113)
            .unwrap()
            .unwrap()
            .file
            .content_length,
        Some(3_300)
    );
}

#[tokio::test]
async fn a_pass_needs_the_network() {
    let up = upstream().await;
    let w = World::new(fast());
    seed(&w, &up.api).await;
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    w.env.http.set_network_allowed(false);
    let err = w.revalidator.run_pass().await.unwrap_err();
    assert!(matches!(err, PackError::Offline), "{err:?}");
    assert!(up.api.requests().is_empty());
    assert_eq!(
        w.chapter_at(TAFSIR),
        T0,
        "stale content is kept, never deleted"
    );
}

#[tokio::test]
async fn failed_items_stay_stale_for_the_next_pass() {
    let up = upstream().await;
    let w = World::new(fast());
    seed(&w, &up.api).await;
    let url = qurancom_tafsir::chapter_url(169, 1, 1);
    up.api.fail(&url, 500, 100);
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let report = w.revalidator.run_pass().await.unwrap();
    assert_eq!(
        (report.due, report.unchanged, report.failed),
        (3, 2, 1),
        "{report:?}"
    );
    assert_eq!(w.chapter_at(TAFSIR), T0);
    assert!(w.env.content.tafsir_get(TAFSIR, 1).unwrap().is_some());

    up.api.recover(&url);
    let report = w.revalidator.run_pass().await.unwrap();
    assert_eq!(
        (report.due, report.unchanged, report.failed),
        (1, 1, 0),
        "{report:?}"
    );
    assert_eq!(w.chapter_at(TAFSIR), T0 + 8 * DAY_MS);
}

#[tokio::test]
async fn revalidate_pack_touches_one_pack() {
    let up = upstream().await;
    let w = World::new(fast());
    seed(&w, &up.api).await;
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let report = w.revalidator.revalidate_pack(WBW).await.unwrap();
    assert_eq!((report.due, report.unchanged), (1, 1));
    assert_eq!(w.chapter_at(WBW), T0 + 8 * DAY_MS);
    assert_eq!((w.chapter_at(TAFSIR), w.timings_at(112)), (T0, T0));
}

#[tokio::test]
async fn obsolete_swap_files_are_swept() {
    let up = upstream().await;
    let w = World::new(fast());
    seed(&w, &up.api).await;
    let next = qdc_audio::next_path(&w.env.root, 7, 112);
    let temp = install::dl_part_path(&next);
    std::fs::create_dir_all(install::audio_dir(&w.env.root, 7)).unwrap();
    std::fs::write(&next, b"left over").unwrap();
    std::fs::write(&temp, b"left over").unwrap();
    let unrelated = install::audio_dir(&w.env.root, 7).join("112.mp3");
    std::fs::write(&unrelated, b"x").unwrap();
    // 112's timings are fresh: nothing waits for a swap.
    w.revalidator.run_pass().await.unwrap();
    assert!(!next.exists() && !temp.exists());
    assert!(unrelated.exists());
}

#[tokio::test]
async fn the_scheduler_runs_waits_for_the_network_and_stops() {
    let up = upstream().await;
    let w = World::new(fast());
    seed(&w, &up.api).await;
    let t1 = T0 + 8 * DAY_MS;
    w.env.user.set_test_clock(Some(t1));
    w.env.http.set_network_allowed(false);
    w.revalidator.start(&tokio::runtime::Handle::current());
    w.revalidator.start(&tokio::runtime::Handle::current());

    // The first pass is due after 30 ms but waits for the network.
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(w.chapter_at(TAFSIR), T0);
    w.env.http.set_network_allowed(true);
    // The whole first pass (every due entry) before the clock moves on: an entry it had not reached yet would be
    // stamped with the later time.
    assert!(eventually(Duration::from_secs(10), || w.chapter_at(TAFSIR) == t1).await);
    assert!(eventually(Duration::from_secs(10), || w.timings_at(112) == t1).await);
    assert!(eventually(Duration::from_secs(10), || w.chapter_at(WBW) == t1).await);

    // The next pass is 1 h away; a wake runs one now.
    let t2 = T0 + 16 * DAY_MS;
    w.env.user.set_test_clock(Some(t2));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(w.chapter_at(WBW), t1);
    w.revalidator.wake();
    assert!(eventually(Duration::from_secs(10), || w.chapter_at(WBW) == t2).await);

    // After shutdown nothing runs.
    w.revalidator.shutdown();
    let t3 = T0 + 24 * DAY_MS;
    w.env.user.set_test_clock(Some(t3));
    w.revalidator.wake();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(w.chapter_at(WBW), t2);
    assert!(
        w.revalidator.run_pass().await.is_ok_and(|r| r.skipped == 3),
        "requests are cancelled after shutdown"
    );
}
