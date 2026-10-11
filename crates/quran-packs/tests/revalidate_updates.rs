//! Update checks (docs/ARCHITECTURE.md §2.5.7, `packs_check_updates`): recitation packs whose pinned files changed
//! upstream, the known-update cache, `last_checked_at`, and the network rule. Owner: WP5d.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod qf_support;
mod support;

use std::sync::{Arc, Mutex};

use qf_support::{DAY_MS, T0, audio_pack, catalog, qdc_files, revalidate_env, upstream};
use quran_core::{CoreDb, InstalledPackRow, InstalledStatus, PackItemRow};
use quran_packs::PackError;
use quran_packs::adapters::{QdcAudioConfig, qdc_audio};
use quran_packs::install;
use quran_packs::jobs::JobHandle;
use quran_packs::revalidate::{Revalidator, RevalidatorConfig};
use quran_types::{PackKind, PackUpdate};
use support::http::{Route, TestServer};
use support::{TestEnv, bytes};

const PACK: &str = "audio.qdc.7";
const LM: &str = "Wed, 21 Oct 2026 07:28:00 GMT";

struct World {
    env: TestEnv,
    files: TestServer,
    cfg: QdcAudioConfig,
    changes: Arc<Mutex<Vec<Vec<String>>>>,
    revalidator: Revalidator,
}

impl World {
    fn new() -> Self {
        let env = TestEnv::new();
        env.user.set_test_clock(Some(T0));
        let files = TestServer::start();
        let pack = audio_pack(7, &[format!("127.0.0.1:{}", files.port())]);
        let cfg = pack.reciter().unwrap().clone();
        let changes: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let sink = Arc::clone(&changes);
        let core = CoreDb::unavailable("timings need no core.db".into());
        let revalidator = Revalidator::new(
            revalidate_env(&env, &core, catalog(vec![pack])),
            RevalidatorConfig::default(),
            move |ids| sink.lock().unwrap().push(ids),
        );
        Self {
            env,
            files,
            cfg,
            changes,
            revalidator,
        }
    }

    fn serve(&self, api: &qf_support::ApiServer, surah: u32, v: u32, len: usize) -> Vec<u8> {
        let path = format!("/v{v}/{surah}.mp3");
        let body = bytes(len, u8::try_from(v * 16 + surah % 16).unwrap());
        self.files
            .route(&path, Route::bytes(body.clone()).last_modified(LM));
        api.json(
            &qdc_audio::timings_url(7, surah),
            &qdc_files(surah, &self.files.url(&path), 1000, v),
        );
        body
    }

    /// Surahs 1 and 112 explicitly downloaded at T0, with their registry rows.
    async fn pin(&self, api: &qf_support::ApiServer) {
        let ctx = self.env.ctx(
            PACK,
            PackKind::Recitation,
            Some(JobHandle::detached(1, PACK)),
            true,
        );
        for surah in [1, 112] {
            self.serve(api, surah, 1, 2_000);
            qdc_audio::fetch_surah(&ctx, &self.cfg, surah)
                .await
                .unwrap();
            self.env
                .user
                .pack_item_upsert(&PackItemRow {
                    pack_id: PACK.into(),
                    item: format!("{surah:03}"),
                    bytes: 2_000,
                    sha256: String::new(),
                    pinned: true,
                    fetched_at: T0,
                    last_used_at: T0,
                })
                .unwrap();
        }
        self.env
            .user
            .pack_upsert(&self.row(InstalledStatus::Partial))
            .unwrap();
        api.clear_log();
    }

    fn row(&self, status: InstalledStatus) -> InstalledPackRow {
        InstalledPackRow {
            pack_id: PACK.into(),
            kind: PackKind::Recitation,
            version: "2026.10".into(),
            path: None,
            status,
            bytes: 4_000,
            items_total: 114,
            items_present: 2,
            sha256: None,
            source_version: None,
            installed_at: T0,
            updated_at: T0,
            last_checked_at: None,
        }
    }

    fn installed(&self) -> InstalledPackRow {
        self.env.user.pack_installed(PACK).unwrap().unwrap()
    }
}

#[tokio::test]
async fn changed_pinned_audio_is_offered_and_then_applied() {
    let up = upstream().await;
    let w = World::new();
    w.pin(&up.api).await;

    // Verified this week: nothing to do, no request, the check is recorded.
    assert!(w.revalidator.check_updates().await.unwrap().is_empty());
    assert!(up.api.requests().is_empty());
    assert_eq!(w.installed().last_checked_at, Some(T0));

    // 112 was re-encoded upstream.
    let v2 = w.serve(&up.api, 112, 2, 2_600);
    let now = T0 + 8 * DAY_MS;
    w.env.user.set_test_clock(Some(now));
    let updates = w.revalidator.check_updates().await.unwrap();
    let expected = PackUpdate {
        pack_id: PACK.into(),
        installed: "2026.10".into(),
        latest: "2026.10.21".into(),
        size_kib: 3,
    };
    assert_eq!(updates, std::slice::from_ref(&expected));
    assert_eq!(
        w.revalidator.known_updates(),
        std::slice::from_ref(&expected)
    );
    let row = w.installed();
    assert_eq!(row.last_checked_at, Some(now));
    assert_eq!(
        (row.status, row.version.as_str()),
        (InstalledStatus::Partial, "2026.10"),
        "only the check time changed"
    );
    assert_eq!(w.revalidator.update_for(&row), Some(expected));
    // Surah 1 was unchanged and is re-stamped; 112 keeps its old pair until it is applied.
    assert_eq!(
        w.env
            .content
            .timings_get(7, 1)
            .unwrap()
            .unwrap()
            .file
            .fetched_at_ms,
        now
    );
    assert_eq!(
        w.env
            .content
            .timings_get(7, 112)
            .unwrap()
            .unwrap()
            .file
            .content_length,
        Some(2_000)
    );

    // "Update" of a recitation pack = revalidate it now.
    let report = w.revalidator.revalidate_pack(PACK).await.unwrap();
    assert_eq!((report.due, report.files_swapped), (1, 1), "{report:?}");
    assert_eq!(
        std::fs::read(install::audio_path(&w.env.root, 7, 112)).unwrap(),
        v2
    );
    assert!(w.revalidator.known_updates().is_empty());
    assert_eq!(w.revalidator.update_for(&w.installed()), None);
    assert_eq!(*w.changes.lock().unwrap(), [vec![PACK.to_owned()]]);
    assert!(w.revalidator.check_updates().await.unwrap().is_empty());
}

#[tokio::test]
async fn known_updates_follow_the_installed_version() {
    let up = upstream().await;
    let w = World::new();
    w.pin(&up.api).await;
    w.serve(&up.api, 112, 2, 2_600);
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    assert_eq!(w.revalidator.check_updates().await.unwrap().len(), 1);

    let mut other = w.installed();
    other.version = "2026.11".into();
    assert_eq!(
        w.revalidator.update_for(&other),
        None,
        "an update found for another installed version is obsolete"
    );
    w.revalidator.forget_update(PACK);
    assert!(w.revalidator.known_updates().is_empty());
}

#[tokio::test]
async fn packs_that_are_not_installed_are_not_checked() {
    let up = upstream().await;
    let w = World::new();
    w.pin(&up.api).await;
    w.serve(&up.api, 112, 2, 2_600);
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    w.env
        .user
        .pack_upsert(&w.row(InstalledStatus::Paused))
        .unwrap();
    assert!(w.revalidator.check_updates().await.unwrap().is_empty());
    assert!(up.api.requests().is_empty());
}

#[tokio::test]
async fn update_checks_need_the_network() {
    let up = upstream().await;
    let w = World::new();
    w.pin(&up.api).await;
    w.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    w.env.http.set_network_allowed(false);
    let err = w.revalidator.check_updates().await.unwrap_err();
    assert!(matches!(err, PackError::Offline), "{err:?}");
    assert_eq!(w.installed().last_checked_at, None);
}
