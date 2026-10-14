//! Quran.com tafsir chapters (`qurancom_v4_tafsir_by_chapter`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod qf_support;
mod support;

use std::sync::Arc;
use std::time::Duration;

use qf_support::{DAY_MS, T0, catalog, tafsir_pack, tafsir_page, upstream};
use quran_core::InstalledStatus;
use quran_packs::adapters::{Adapter, ItemOutcome, QurancomTafsirConfig, qurancom_tafsir};
use quran_packs::jobs::{JobSpec, catalog_specs};
use quran_packs::revalidate::{ChapterChange, MAX_AGE};
use quran_packs::{AdapterCtx, PackError};
use quran_types::{InstallScope, JobPhase, PackKind};
use support::{TestEnv, sha256_hex};

const PACK: &str = "tafsir.en.ibn_kathir";
const CFG: QurancomTafsirConfig = QurancomTafsirConfig { resource_id: 169 };

fn ctx(env: &TestEnv, pin: bool) -> AdapterCtx {
    env.ctx(PACK, PackKind::Tafsir, None, pin)
}

fn env() -> TestEnv {
    let env = TestEnv::new();
    env.user.set_test_clock(Some(T0));
    env
}

/// Chapter 1 over two pages: 1:1 heads a group with 1:2; page 2 carries markup that the policy rewrites.
fn serve_fatiha(api: &qf_support::ApiServer) -> (Vec<u8>, Vec<u8>) {
    let p1 = tafsir_page(
        &[
            ("1:1", "<p>Basmala</p>"),
            ("1:2", ""),
            ("1:3", "<p>Mercy</p>"),
            ("1:4", "<p>Day</p>"),
        ],
        Some(2),
    );
    let p2 = tafsir_page(
        &[
            (
                "1:5",
                "<h1 style=\"color: red\">Worship</h1><p>See <a href=\"/2:255\">2:255</a> and \
                     <a href=\"https://example.com/x\">this site</a>.</p>",
            ),
            (
                "1:6",
                "<p>Guide <span class=\"arabic\" style=\"x\">اهدنا</span><script>alert(1)</script></p>",
            ),
            ("1:7", "<p>Path</p>"),
        ],
        None,
    );
    api.json(&qurancom_tafsir::chapter_url(169, 1, 1), &p1);
    api.json(&qurancom_tafsir::chapter_url(169, 1, 2), &p2);
    (
        serde_json::to_vec(&p1).unwrap(),
        serde_json::to_vec(&p2).unwrap(),
    )
}

#[tokio::test]
async fn pages_are_grouped_sanitised_and_stamped() {
    let up = upstream().await;
    let env = env();
    let (p1, p2) = serve_fatiha(&up.api);

    let outcome = qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 1)
        .await
        .unwrap();
    let ItemOutcome::Stored { bytes, sha256 } = outcome else {
        panic!("expected Stored, got {outcome:?}");
    };
    assert_eq!(
        sha256,
        sha256_hex(&[p1, p2].concat()),
        "payload hash over both pages in order"
    );
    assert!(bytes > 0);
    assert_eq!(up.api.hits(&qurancom_tafsir::chapter_url(169, 1, 1)), 1);
    assert_eq!(up.api.hits(&qurancom_tafsir::chapter_url(169, 1, 2)), 1);

    // 1:1 heads the group 1:1–1:2.
    let first = env.content.tafsir_get(PACK, 2).unwrap().unwrap();
    assert_eq!((first.from_ayah_id, first.to_ayah_id), (1, 2));
    assert_eq!(first.html, "<p>Basmala</p>");
    let worship = env.content.tafsir_get(PACK, 5).unwrap().unwrap();
    assert_eq!((worship.from_ayah_id, worship.to_ayah_id), (5, 5));
    assert!(
        worship.html.contains("<h2>Worship</h2>"),
        "{}",
        worship.html
    );
    assert!(
        worship.html.contains(r#"<a data-ref="2:255">2:255</a>"#),
        "{}",
        worship.html
    );
    assert!(
        !worship.html.contains("href") && !worship.html.contains("style"),
        "{}",
        worship.html
    );
    assert!(
        worship.html.contains("this site"),
        "other links are unwrapped, their text kept"
    );
    let guide = env.content.tafsir_get(PACK, 6).unwrap().unwrap().html;
    assert!(
        guide.contains(r#"<span class="arabic">اهدنا</span>"#),
        "{guide}"
    );
    assert!(
        !guide.contains("script") && !guide.contains("alert"),
        "{guide}"
    );

    let stamp = &env.content.chapters(PACK).unwrap()[0];
    assert_eq!(
        (stamp.surah, stamp.fetched_at_ms, stamp.pinned),
        (1, T0, true)
    );
    assert_eq!(stamp.sha256, sha256);
}

#[tokio::test]
async fn a_fresh_chapter_is_reused_and_pinned_without_a_request() {
    let up = upstream().await;
    let env = env();
    serve_fatiha(&up.api);

    // On demand first (not pinned).
    let state = qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 1, MAX_AGE)
        .await
        .unwrap();
    assert_eq!(state.change, Some(ChapterChange::New));
    assert!(!state.stale);
    assert!(!env.content.chapters(PACK).unwrap()[0].pinned);
    up.api.clear_log();

    // A fresh lookup does not refetch.
    let again = qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 1, MAX_AGE)
        .await
        .unwrap();
    assert_eq!((again.change, again.fetched_at_ms), (None, T0));
    // "Download all" later: the stored chapter is only pinned.
    env.user.set_test_clock(Some(T0 + DAY_MS));
    let outcome = qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 1)
        .await
        .unwrap();
    assert!(
        matches!(outcome, ItemOutcome::Present { bytes } if bytes > 0),
        "{outcome:?}"
    );
    assert!(
        up.api.requests().is_empty(),
        "no request for a fresh chapter: {:?}",
        up.api.requests()
    );
    let stamp = &env.content.chapters(PACK).unwrap()[0];
    assert!(stamp.pinned);
    assert_eq!(stamp.fetched_at_ms, T0, "pinning keeps the fetch time");

    // Pinned rows survive "Clear cache".
    let report = env.content.clear_unpinned().unwrap();
    assert!(report.chapters.is_empty());
    assert!(env.content.tafsir_get(PACK, 7).unwrap().is_some());
}

#[tokio::test]
async fn revalidation_moves_fetched_at_or_replaces() {
    let up = upstream().await;
    let env = env();
    serve_fatiha(&up.api);
    qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 1)
        .await
        .unwrap();
    let before = env.content.tafsir_get(PACK, 3).unwrap();

    env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let change = qurancom_tafsir::revalidate_chapter(&ctx(&env, false), &CFG, 1)
        .await
        .unwrap();
    assert_eq!(change, ChapterChange::Unchanged);
    let stamp = env.content.chapters(PACK).unwrap()[0].clone();
    assert_eq!(stamp.fetched_at_ms, T0 + 8 * DAY_MS);
    assert!(stamp.pinned, "a revalidation never unpins");
    assert_eq!(env.content.tafsir_get(PACK, 3).unwrap(), before);

    // Upstream edits one entry and merges 1:6 into 1:5's group.
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 1, 2),
        &tafsir_page(
            &[
                ("1:5", "<p>Worship, revised</p>"),
                ("1:6", ""),
                ("1:7", "<p>Path</p>"),
            ],
            None,
        ),
    );
    env.user.set_test_clock(Some(T0 + 16 * DAY_MS));
    let change = qurancom_tafsir::revalidate_chapter(&ctx(&env, false), &CFG, 1)
        .await
        .unwrap();
    assert_eq!(change, ChapterChange::Replaced);
    let five = env.content.tafsir_get(PACK, 6).unwrap().unwrap();
    assert_eq!((five.from_ayah_id, five.to_ayah_id), (5, 6));
    assert_eq!(five.html, "<p>Worship, revised</p>");
    let stamp = &env.content.chapters(PACK).unwrap()[0];
    assert_ne!(stamp.sha256, "");
    assert!(stamp.pinned);
}

#[tokio::test]
async fn stale_copies_are_served_when_the_network_is_unavailable() {
    let up = upstream().await;
    let env = env();
    serve_fatiha(&up.api);
    qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 1, MAX_AGE)
        .await
        .unwrap();

    env.user.set_test_clock(Some(T0 + 9 * DAY_MS));
    env.http.set_network_allowed(false);
    let state = qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 1, MAX_AGE)
        .await
        .unwrap();
    assert!(state.stale);
    assert_eq!((state.fetched_at_ms, state.change), (T0, None));
    assert!(
        env.content.tafsir_get(PACK, 1).unwrap().is_some(),
        "never deleted for being old"
    );

    // A chapter that was never fetched cannot be served.
    let err = qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 2, MAX_AGE)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Offline), "{err:?}");

    // Upstream down (500 on every attempt) while allowed: still the stale copy.
    env.http.set_network_allowed(true);
    up.api
        .fail(&qurancom_tafsir::chapter_url(169, 1, 1), 500, 10);
    let state = qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 1, Duration::from_secs(1))
        .await
        .unwrap();
    assert!(state.stale);
}

#[tokio::test]
async fn upstream_failures_store_nothing() {
    let up = upstream().await;
    let env = env();

    // Unknown chapter: 404 on every mirror.
    let err = qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 3)
        .await
        .unwrap_err();
    assert!(
        matches!(err, PackError::Http { status: 404, .. }),
        "{err:?}"
    );

    // A page that points back to itself.
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 4, 1),
        &tafsir_page(&[("4:1", "<p>a</p>")], Some(1)),
    );
    let err = qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 4)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");

    // No row of this chapter (only another chapter's keys): nothing to store. (Rows that are all empty are a valid,
    // empty chapter: `a_chapter_without_commentary_is_stored_empty_and_completes_the_download`.)
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 5, 1),
        &tafsir_page(&[("6:1", "<p>another chapter</p>")], None),
    );
    let err = qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 5)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");

    // Not JSON at all.
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 6, 1),
        &serde_json::json!("<html>captive portal</html>"),
    );
    assert!(
        qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 6)
            .await
            .is_err()
    );

    assert!(env.content.chapters(PACK).unwrap().is_empty());
    let err = qurancom_tafsir::fetch_chapter(&ctx(&env, true), &CFG, 115)
        .await
        .unwrap_err();
    assert_eq!(quran_types::AppError::from(err).kind(), "invalid_argument");
}

/// Ibn Kathir (abridged, 169) has no commentary for surah 105: Quran.com serves its five ayahs with empty text. The
/// chapter is stored empty and counts as present, so "Download all" completes (it stayed at "113 of 114", failing with
/// an integrity error on every retry).
#[tokio::test]
async fn a_chapter_without_commentary_is_stored_empty_and_completes_the_download() {
    let up = upstream().await;
    let env = env();
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 105, 1),
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
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 112, 1),
        &tafsir_page(
            &[
                ("112:1", "<p>Ikhlas</p>"),
                ("112:2", ""),
                ("112:3", ""),
                ("112:4", ""),
            ],
            None,
        ),
    );
    let pack = tafsir_pack(PACK, 169);
    let catalog = catalog(vec![pack.clone()]);
    let queue = env.queue(catalog_specs(Arc::clone(&catalog)), 3, 4);
    let job = queue
        .enqueue(JobSpec::from_catalog(
            &pack,
            InstallScope::Items {
                items: vec![105, 112],
            },
            true,
        ))
        .await
        .unwrap();
    assert_eq!(queue.wait(job).await, Some(JobPhase::Completed));

    let items = env.user.pack_items(PACK).unwrap();
    assert_eq!(
        items.iter().map(|i| i.item.as_str()).collect::<Vec<_>>(),
        ["ch105", "ch112"]
    );
    let empty = items.iter().find(|i| i.item == "ch105").unwrap();
    assert!(empty.pinned && empty.bytes == 0 && empty.sha256.len() == 64);
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(row.items_present, 2, "the empty chapter counts as present");

    // Stored with its stamp and no entry: a lookup is fresh (no request) and finds nothing for its ayahs.
    let ids = quran_core::content_db::geometry::surah_ayah_ids(105).unwrap();
    assert!(
        env.content
            .chapters(PACK)
            .unwrap()
            .iter()
            .any(|c| c.surah == 105 && c.pinned)
    );
    for id in ids {
        assert!(env.content.tafsir_get(PACK, id).unwrap().is_none());
    }
    up.api.clear_log();
    let state = qurancom_tafsir::ensure_chapter(&ctx(&env, false), &CFG, 105, MAX_AGE)
        .await
        .unwrap();
    assert_eq!((state.change, state.stale), (None, false));
    assert!(up.api.requests().is_empty(), "{:?}", up.api.requests());
    // A revalidation of the still-empty chapter is unchanged, never a failure.
    env.user.set_test_clock(Some(T0 + 8 * DAY_MS));
    let change = qurancom_tafsir::revalidate_chapter(&ctx(&env, false), &CFG, 105)
        .await
        .unwrap();
    assert_eq!(change, ChapterChange::Unchanged);
}

#[tokio::test]
async fn a_download_job_runs_through_the_frozen_dispatch() {
    let up = upstream().await;
    let env = env();
    serve_fatiha(&up.api);
    up.api.json(
        &qurancom_tafsir::chapter_url(169, 112, 1),
        &tafsir_page(
            &[
                ("112:1", "<p>Ikhlas</p>"),
                ("112:2", ""),
                ("112:3", ""),
                ("112:4", ""),
            ],
            None,
        ),
    );
    let pack = tafsir_pack(PACK, 169);
    assert!(matches!(pack.source, Adapter::QurancomTafsir(_)));
    let catalog = catalog(vec![pack.clone()]);
    let queue = env.queue(catalog_specs(Arc::clone(&catalog)), 3, 4);
    let job = queue
        .enqueue(JobSpec::from_catalog(
            &pack,
            InstallScope::Items {
                items: vec![112, 1],
            },
            true,
        ))
        .await
        .unwrap();
    assert_eq!(queue.wait(job).await, Some(JobPhase::Completed));

    let items = env.user.pack_items(PACK).unwrap();
    assert_eq!(
        items.iter().map(|i| i.item.as_str()).collect::<Vec<_>>(),
        ["ch1", "ch112"]
    );
    assert!(
        items
            .iter()
            .all(|i| i.pinned && i.bytes > 0 && i.sha256.len() == 64)
    );
    let row = env.user.pack_installed(PACK).unwrap().unwrap();
    assert_eq!(
        (row.status, row.items_present),
        (InstalledStatus::Partial, 2)
    );
    // 112:1–4 are ayah ids 6222–6225; 112:3 falls in the group headed by 112:1.
    let ikhlas = env.content.tafsir_get(PACK, 6224).unwrap().unwrap();
    assert_eq!((ikhlas.from_ayah_id, ikhlas.to_ayah_id), (6222, 6225));
    assert!(env.content.chapters(PACK).unwrap().iter().all(|c| c.pinned));
}
