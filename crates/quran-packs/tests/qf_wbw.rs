//! Quran.com word-by-word chapters (`qurancom_v4_wbw`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod qf_support;
mod support;

use std::sync::Arc;

use qf_support::{DAY_MS, T0, catalog, ctx_with_core, mini_core, upstream, wbw_pack, wbw_page};
use quran_core::CoreDb;
use quran_packs::adapters::{ItemOutcome, QurancomWbwConfig, qurancom_wbw};
use quran_packs::jobs::{JobSpec, catalog_specs};
use quran_packs::revalidate::{ChapterChange, MAX_AGE};
use quran_packs::{AdapterCtx, PackError};
use quran_types::{InstallScope, JobPhase, PackKind};
use support::{TestEnv, sha256_hex};

const PACK: &str = "wbw.en";

fn cfg() -> QurancomWbwConfig {
    QurancomWbwConfig {
        language: "en".into(),
    }
}

struct Fixture {
    env: TestEnv,
    core: CoreDb,
}

impl Fixture {
    fn new() -> Self {
        let env = TestEnv::new();
        env.user.set_test_clock(Some(T0));
        let core = mini_core(env.dir.path(), &[1, 112]);
        Self { env, core }
    }

    fn ctx(&self, pin: bool) -> AdapterCtx {
        ctx_with_core(&self.env, &self.core, PACK, PackKind::Wbw, None, pin)
    }
}

/// Al-Fatiha over two pages (verses 1–4, then 5–7), every word glossed, markers at the real positions.
fn serve_fatiha(api: &qf_support::ApiServer) -> Vec<u8> {
    let p1 = wbw_page(
        &[
            (
                "1:1",
                &[
                    (1, "In (the) name"),
                    (2, "(of) Allah"),
                    (3, "the Most Gracious"),
                    (4, "the Most Merciful"),
                ],
                5,
            ),
            (
                "1:2",
                &[
                    (1, "All praises and thanks"),
                    (2, "(be) to Allah"),
                    (3, "the Lord"),
                    (4, "of the universe"),
                ],
                5,
            ),
            (
                "1:3",
                &[(1, "The Most Gracious"), (2, "the Most Merciful")],
                3,
            ),
            (
                "1:4",
                &[
                    (1, "(The) Master"),
                    (2, "(of the) Day"),
                    (3, "(of the) Judgment"),
                ],
                4,
            ),
        ],
        Some(2),
    );
    let p2 = wbw_page(
        &[
            (
                "1:5",
                &[
                    (1, "You Alone"),
                    (2, "we worship"),
                    (3, "and You Alone"),
                    (4, "we ask for help"),
                ],
                5,
            ),
            (
                "1:6",
                &[(1, "Guide us"), (2, "(to) the path"), (3, "the straight")],
                4,
            ),
            (
                "1:7",
                &[
                    (1, "(The) path"),
                    (2, "(of) those"),
                    (3, "You have bestowed (Your) Favors"),
                    (4, "on them"),
                    (5, "not (of)"),
                    (6, "those who earned (Your) wrath"),
                    (7, "on themselves"),
                    (8, "and not"),
                    (9, "of those who go astray"),
                ],
                10,
            ),
        ],
        None,
    );
    api.json(&qurancom_wbw::chapter_url("en", 1, 1), &p1);
    api.json(&qurancom_wbw::chapter_url("en", 1, 2), &p2);
    [
        serde_json::to_vec(&p1).unwrap(),
        serde_json::to_vec(&p2).unwrap(),
    ]
    .concat()
}

#[tokio::test]
async fn words_join_core_by_location() {
    let up = upstream().await;
    let fx = Fixture::new();
    let payload = serve_fatiha(&up.api);

    let outcome = qurancom_wbw::fetch_chapter(&fx.ctx(true), &cfg(), 1)
        .await
        .unwrap();
    let ItemOutcome::Stored { bytes, sha256 } = outcome else {
        panic!("expected Stored, got {outcome:?}");
    };
    assert_eq!(sha256, sha256_hex(&payload));
    assert!(bytes > 0);

    let rows = fx.env.content.wbw_range(PACK, 1, 36).unwrap();
    // 29 words; the 7 end markers (ids 5, 10, 13, 17, 22, 26, 36) have no gloss.
    assert_eq!(rows.len(), 29);
    let ids: Vec<u32> = rows.iter().map(|r| r.word_id).collect();
    for marker in [5, 10, 13, 17, 22, 26, 36] {
        assert!(!ids.contains(&marker), "marker {marker}");
    }
    assert_eq!(rows[0].word_id, 1);
    assert_eq!(rows[0].translation.as_deref(), Some("In (the) name"));
    assert_eq!(rows[0].transliteration.as_deref(), Some("tl-1"));
    // 1:7:9 = word 35.
    let last = rows.last().unwrap();
    assert_eq!(
        (last.word_id, last.translation.as_deref()),
        (35, Some("of those who go astray"))
    );
    let stamp = &fx.env.content.chapters(PACK).unwrap()[0];
    assert_eq!(
        (stamp.surah, stamp.fetched_at_ms, stamp.pinned),
        (1, T0, true)
    );
}

#[tokio::test]
async fn unknown_locations_are_dropped_and_a_mismatch_fails() {
    let up = upstream().await;
    let fx = Fixture::new();
    // 112:1 has fewer than 9 positions in the mini core: 112:1:9 is not a word.
    up.api.json(
        &qurancom_wbw::chapter_url("en", 112, 1),
        &wbw_page(
            &[("112:1", &[(1, "Say"), (2, "He"), (9, "ghost")], 5)],
            None,
        ),
    );
    qurancom_wbw::fetch_chapter(&fx.ctx(false), &cfg(), 112)
        .await
        .unwrap();
    let range = quran_core::content_db::geometry::surah_word_ids(112).unwrap();
    let rows = fx
        .env
        .content
        .wbw_range(PACK, *range.start(), *range.end())
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.translation.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["Say", "He"]
    );

    // Nothing of the chapter matches core.db: an integrity failure, and the stored chapter is kept.
    up.api.json(
        &qurancom_wbw::chapter_url("en", 112, 1),
        &wbw_page(&[("112:1", &[(9, "ghost")], 10)], None),
    );
    fx.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let err = qurancom_wbw::revalidate_chapter(&fx.ctx(false), &cfg(), 112)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    assert_eq!(
        fx.env
            .content
            .wbw_range(PACK, *range.start(), *range.end())
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn revalidation_and_offline_lookups() {
    let up = upstream().await;
    let fx = Fixture::new();
    serve_fatiha(&up.api);
    let state = qurancom_wbw::ensure_chapter(&fx.ctx(false), &cfg(), 1, MAX_AGE)
        .await
        .unwrap();
    assert_eq!(state.change, Some(ChapterChange::New));

    fx.env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let change = qurancom_wbw::revalidate_chapter(&fx.ctx(false), &cfg(), 1)
        .await
        .unwrap();
    assert_eq!(change, ChapterChange::Unchanged);
    assert_eq!(
        fx.env.content.chapters(PACK).unwrap()[0].fetched_at_ms,
        T0 + 8 * DAY_MS
    );

    // A corrected gloss.
    up.api.json(
        &qurancom_wbw::chapter_url("en", 1, 2),
        &wbw_page(&[("1:5", &[(1, "You alone"), (2, "we worship")], 5)], None),
    );
    fx.env.user.set_test_clock(Some(T0 + 16 * DAY_MS));
    let state = qurancom_wbw::ensure_chapter(&fx.ctx(false), &cfg(), 1, MAX_AGE)
        .await
        .unwrap();
    assert_eq!(state.change, Some(ChapterChange::Replaced));
    let rows = fx.env.content.wbw_range(PACK, 18, 21).unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.translation.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["You alone", "we worship"]
    );

    // Offline: the stored copy, marked stale.
    fx.env.user.set_test_clock(Some(T0 + 30 * DAY_MS));
    fx.env.http.set_network_allowed(false);
    let state = qurancom_wbw::ensure_chapter(&fx.ctx(false), &cfg(), 1, MAX_AGE)
        .await
        .unwrap();
    assert!(state.stale);
    assert_eq!(state.fetched_at_ms, T0 + 16 * DAY_MS);
}

#[tokio::test]
async fn a_core_db_is_required_for_the_join() {
    let up = upstream().await;
    let fx = Fixture::new();
    serve_fatiha(&up.api);
    // TestEnv's core.db is the unavailable handle (debug degrade path).
    let ctx = fx.env.ctx(PACK, PackKind::Wbw, None, false);
    let err = qurancom_wbw::fetch_chapter(&ctx, &cfg(), 1)
        .await
        .unwrap_err();
    assert_eq!(quran_types::AppError::from(err).kind(), "not_found");
    assert!(fx.env.content.chapters(PACK).unwrap().is_empty());
}

#[tokio::test]
async fn download_all_reuses_fresh_chapters() {
    let up = upstream().await;
    let fx = Fixture::new();
    serve_fatiha(&up.api);
    up.api.json(
        &qurancom_wbw::chapter_url("en", 112, 1),
        &wbw_page(
            &[(
                "112:1",
                &[(1, "Say"), (2, "He"), (3, "(is) Allah"), (4, "the One")],
                5,
            )],
            None,
        ),
    );
    // Chapter 1 was viewed on demand an hour ago.
    qurancom_wbw::ensure_chapter(&fx.ctx(false), &cfg(), 1, MAX_AGE)
        .await
        .unwrap();
    up.api.clear_log();
    fx.env.user.set_test_clock(Some(T0 + 3_600_000));

    let pack = wbw_pack("en");
    let catalog = catalog(vec![pack.clone()]);
    let mut job_env = fx.env.job_env();
    job_env.core = fx.core.clone();
    let queue = quran_packs::jobs::JobQueue::with_limits(
        job_env,
        catalog_specs(Arc::clone(&catalog)),
        3,
        4,
    );
    let job = queue
        .enqueue(JobSpec::from_catalog(
            &pack,
            InstallScope::Items {
                items: vec![1, 112],
            },
            true,
        ))
        .await
        .unwrap();
    assert_eq!(queue.wait(job).await, Some(JobPhase::Completed));
    assert_eq!(
        up.api.requests(),
        [qf_support::target(&qurancom_wbw::chapter_url("en", 112, 1))],
        "only the missing chapter is fetched"
    );
    let stamps = fx.env.content.chapters(PACK).unwrap();
    assert!(stamps.iter().all(|s| s.pinned), "{stamps:?}");
    assert_eq!(stamps[0].fetched_at_ms, T0);
    let items = fx.env.user.pack_items(PACK).unwrap();
    assert!(items.iter().all(|i| i.pinned) && items.len() == 2);
}
