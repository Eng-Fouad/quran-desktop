//! The interactive page-font lane (`quran_packs::fonts`): `hafs` without IO, pages on disk with content-versioned URLs,
//! `Unavailable` offline, one shared download per page, mirrors, integrity failures, corrupt files, lanes, registry
//! rows and order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod fonts_support;
mod support;

use std::time::Duration;

use fonts_support::{BASE, catalog, fonts, mushaf_pack, names, woff2};
use quran_core::PackItemRow;
use quran_packs::adapters::FontVariant;
use quran_packs::install;
use quran_types::{FetchPriority, FontAvailability, MushafStyle, PageFontStatus};
use support::http::{Action, Gate, Route, TestServer};
use support::{TestEnv, sha256_hex};

const V2: &str = "mushaf.v2";

fn v2_catalog(s: &TestServer) -> quran_packs::Catalog {
    catalog(vec![mushaf_pack(
        "v2",
        &[s.url("/a/v2/p{page}.woff2"), s.url("/b/v2/p{page}.woff2")],
    )])
}

fn page_path(env: &TestEnv, page: u32) -> std::path::PathBuf {
    install::font_page_path(&env.root, FontVariant::V2, page)
}

fn ready(status: &PageFontStatus, page: u32, body: &[u8]) {
    let sha = sha256_hex(body);
    assert_eq!(status.style, MushafStyle::QcfV2);
    assert_eq!(status.page, page);
    assert_eq!(status.availability, FontAvailability::Ready);
    assert_eq!(status.family, format!("qcf-v2-p{page}"));
    assert_eq!(
        status.url.as_deref(),
        Some(format!("{BASE}mushaf/v2/p{page}.woff2?v={}", &sha[..8]).as_str())
    );
    assert_eq!(
        status.rel.as_deref(),
        Some(format!("mushaf/v2/p{page}.woff2").as_str())
    );
    assert_eq!(status.bytes, u32::try_from(body.len()).unwrap());
}

#[tokio::test]
async fn hafs_is_ready_without_io() {
    let s = TestServer::start();
    let env = TestEnv::new();
    env.http.set_network_allowed(false);
    let (f, _) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(
            MushafStyle::Hafs,
            &[1, 262, 604],
            FetchPriority::Interactive,
        )
        .await
        .unwrap();
    assert_eq!(got.len(), 3);
    for (st, page) in got.iter().zip([1, 262, 604]) {
        assert_eq!(st.style, MushafStyle::Hafs);
        assert_eq!(st.page, page);
        assert_eq!(st.availability, FontAvailability::Ready);
        assert_eq!(st.family, "qd-hafs");
        assert_eq!(
            (st.url.as_deref(), st.rel.as_deref(), st.bytes),
            (None, None, 0)
        );
    }
    assert!(s.requests().is_empty());
    assert!(names(&env.root).is_empty(), "no file touched");
    for bad in [0, 605] {
        let err = f
            .ensure_page_fonts(MushafStyle::QcfV2, &[1, bad], FetchPriority::Interactive)
            .await
            .unwrap_err();
        assert_eq!(quran_types::AppError::from(err).kind(), "invalid_argument");
    }
    assert!(
        f.ensure_page_fonts(MushafStyle::Hafs, &[], FetchPriority::Prefetch)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_page_on_disk_is_ready_with_a_content_versioned_url() {
    let s = TestServer::start();
    let env = TestEnv::new();
    env.http.set_network_allowed(false);
    let body = woff2(3_000, 1);
    std::fs::create_dir_all(page_path(&env, 3).parent().unwrap()).unwrap();
    std::fs::write(page_path(&env, 3), &body).unwrap();
    let (f, heard) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[3], FetchPriority::Interactive)
        .await
        .unwrap();
    ready(&got[0], 3, &body);
    // The URL follows the content.
    std::thread::sleep(Duration::from_millis(20));
    let other = woff2(3_500, 2);
    std::fs::write(page_path(&env, 3), &other).unwrap();
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[3], FetchPriority::Prefetch)
        .await
        .unwrap();
    ready(&got[0], 3, &other);
    assert!(s.requests().is_empty());
    assert!(heard.lock().unwrap().is_empty());
    assert!(
        env.user.pack_items(V2).unwrap().is_empty(),
        "files on disk need no registry row"
    );
}

#[tokio::test]
async fn missing_pages_are_unavailable_while_the_network_is_off() {
    let s = TestServer::start();
    s.route("/a/v2/p4.woff2", Route::bytes(woff2(2_000, 4)));
    let env = TestEnv::new();
    env.http.set_network_allowed(false);
    let (f, _) = fonts(&env, &v2_catalog(&s));
    for prio in [FetchPriority::Interactive, FetchPriority::Prefetch] {
        let got = f
            .ensure_page_fonts(MushafStyle::QcfV2, &[4], prio)
            .await
            .unwrap();
        assert_eq!(got[0].availability, FontAvailability::Unavailable);
        assert_eq!(got[0].family, "qcf-v2-p4");
        assert_eq!(
            (got[0].url.as_deref(), got[0].rel.as_deref(), got[0].bytes),
            (None, None, 0)
        );
    }
    assert!(s.requests().is_empty());
    env.http.set_network_allowed(true);
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[4], FetchPriority::Interactive)
        .await
        .unwrap();
    assert_eq!(got[0].availability, FontAvailability::Ready);
}

#[tokio::test]
async fn a_missing_page_is_fetched_once_and_recorded_on_demand() {
    let s = TestServer::start();
    let gate = Gate::new();
    let body = woff2(20_000, 5);
    s.route("/a/v2/p5.woff2", Route::bytes(body.clone()).gated(&gate));
    let env = TestEnv::new();
    let (f, heard) = fonts(&env, &v2_catalog(&s));
    let (f1, f2) = (f.clone(), f.clone());
    let a = tokio::spawn(async move {
        f1.ensure_page_fonts(MushafStyle::QcfV2, &[5, 5], FetchPriority::Interactive)
            .await
    });
    let b = tokio::spawn(async move {
        f2.ensure_page_fonts(MushafStyle::QcfV2, &[5], FetchPriority::Interactive)
            .await
    });
    assert!(support::eventually(Duration::from_secs(5), || gate.waiting() == 1).await);
    gate.open();
    let (a, b) = (a.await.unwrap().unwrap(), b.await.unwrap().unwrap());
    for st in a.iter().chain(&b) {
        ready(st, 5, &body);
    }
    assert_eq!(
        s.hits("/a/v2/p5.woff2"),
        1,
        "concurrent requests share one download"
    );
    assert_eq!(std::fs::read(page_path(&env, 5)).unwrap(), body);
    assert_eq!(
        names(page_path(&env, 5).parent().unwrap()),
        ["p5.woff2"],
        "no temp is left"
    );
    let row = env.user.pack_item(V2, "p5").unwrap().unwrap();
    assert!(!row.pinned, "fetched on demand");
    assert_eq!(
        (row.bytes, row.sha256.as_str()),
        (20_000, sha256_hex(&body).as_str())
    );
    let heard = heard.lock().unwrap().clone();
    assert!(
        !heard.is_empty() && heard.iter().all(|ids| ids == &[V2.to_owned()]),
        "{heard:?}"
    );
    // A later call is answered from disk.
    let again = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[5], FetchPriority::Interactive)
        .await
        .unwrap();
    ready(&again[0], 5, &body);
    assert_eq!(s.hits("/a/v2/p5.woff2"), 1);
}

#[tokio::test]
async fn the_second_template_is_a_mirror() {
    let s = TestServer::start();
    let body = woff2(1_000, 6);
    s.route("/b/v2/p6.woff2", Route::bytes(body.clone()));
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[6], FetchPriority::Interactive)
        .await
        .unwrap();
    ready(&got[0], 6, &body);
    assert_eq!((s.hits("/a/v2/p6.woff2"), s.hits("/b/v2/p6.woff2")), (1, 1));
}

#[tokio::test]
async fn a_page_that_is_not_a_font_fails_and_can_be_retried() {
    let s = TestServer::start();
    s.route(
        "/a/v2/p7.woff2",
        Route::bytes(b"<html>captive portal</html>".to_vec()),
    );
    s.route(
        "/b/v2/p7.woff2",
        Route::bytes(vec![0u8; 100]).then(Action::Status(404)),
    );
    let env = TestEnv::new();
    let (f, heard) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[7], FetchPriority::Interactive)
        .await
        .unwrap();
    assert_eq!(got[0].availability, FontAvailability::Failed);
    assert_eq!((got[0].url.as_deref(), got[0].bytes), (None, 0));
    assert!(
        names(page_path(&env, 7).parent().unwrap()).is_empty(),
        "nothing is left behind"
    );
    assert!(env.user.pack_item(V2, "p7").unwrap().is_none());
    assert!(heard.lock().unwrap().is_empty());
    // Retry once a mirror serves the font.
    let body = woff2(1_500, 7);
    s.route("/b/v2/p7.woff2", Route::bytes(body.clone()));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[7], FetchPriority::Interactive)
        .await
        .unwrap();
    ready(&got[0], 7, &body);
}

#[tokio::test]
async fn a_corrupt_file_on_disk_is_fetched_again() {
    let s = TestServer::start();
    let body = woff2(2_500, 8);
    s.route("/a/v2/p8.woff2", Route::bytes(body.clone()));
    let env = TestEnv::new();
    std::fs::create_dir_all(page_path(&env, 8).parent().unwrap()).unwrap();
    std::fs::write(page_path(&env, 8), b"<html>not a font</html>").unwrap();
    let (f, _) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[8], FetchPriority::Interactive)
        .await
        .unwrap();
    ready(&got[0], 8, &body);
    assert_eq!(s.hits("/a/v2/p8.woff2"), 1);
    // An empty file too.
    std::fs::write(page_path(&env, 8), b"").unwrap();
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[8], FetchPriority::Interactive)
        .await
        .unwrap();
    ready(&got[0], 8, &body);
    assert_eq!(s.hits("/a/v2/p8.woff2"), 2);
}

#[tokio::test]
async fn prefetch_resolves_when_the_page_is_final() {
    let s = TestServer::start();
    let body = woff2(9_000, 9);
    s.route(
        "/a/v2/p9.woff2",
        Route::bytes(body.clone()).throttle(1_000, Duration::from_millis(5)),
    );
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV2, &[9], FetchPriority::Prefetch)
        .await
        .unwrap();
    ready(&got[0], 9, &body);
    assert_eq!(names(page_path(&env, 9).parent().unwrap()), ["p9.woff2"]);
}

#[tokio::test]
async fn a_pinned_row_stays_pinned() {
    let s = TestServer::start();
    let body = woff2(1_200, 10);
    s.route("/a/v2/p10.woff2", Route::bytes(body.clone()));
    let env = TestEnv::new();
    env.user
        .pack_item_upsert(&PackItemRow {
            pack_id: V2.into(),
            item: "p10".into(),
            bytes: 1,
            sha256: String::new(),
            pinned: true,
            fetched_at: 0,
            last_used_at: 0,
        })
        .unwrap();
    let (f, _) = fonts(&env, &v2_catalog(&s));
    f.ensure_page_fonts(MushafStyle::QcfV2, &[10], FetchPriority::Interactive)
        .await
        .unwrap();
    let row = env.user.pack_item(V2, "p10").unwrap().unwrap();
    assert!(row.pinned);
    assert_eq!(row.bytes, 1_200);
    assert_eq!(row.sha256, sha256_hex(&body));
}

#[tokio::test]
async fn statuses_follow_the_requested_order() {
    let s = TestServer::start();
    for p in [11, 12, 13] {
        s.route(
            &format!("/a/v2/p{p}.woff2"),
            Route::bytes(woff2(1_000 + p as usize, 11)),
        );
    }
    s.route(
        "/a/v2/p14.woff2",
        Route::bytes(vec![]).then(Action::Status(404)),
    );
    s.route(
        "/b/v2/p14.woff2",
        Route::bytes(vec![]).then(Action::Status(404)),
    );
    let env = TestEnv::new();
    let (f, heard) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(
            MushafStyle::QcfV2,
            &[13, 14, 11, 12],
            FetchPriority::Interactive,
        )
        .await
        .unwrap();
    assert_eq!(
        got.iter().map(|g| g.page).collect::<Vec<_>>(),
        [13, 14, 11, 12]
    );
    assert_eq!(
        got.iter().map(|g| g.availability).collect::<Vec<_>>(),
        [
            FontAvailability::Ready,
            FontAvailability::Failed,
            FontAvailability::Ready,
            FontAvailability::Ready
        ]
    );
    assert_eq!(heard.lock().unwrap().len(), 1, "one notification per call");
}

#[tokio::test]
async fn a_style_without_a_catalog_pack_fails_without_requests() {
    let s = TestServer::start();
    let env = TestEnv::new();
    let (f, _) = fonts(&env, &v2_catalog(&s));
    let got = f
        .ensure_page_fonts(MushafStyle::QcfV1, &[1], FetchPriority::Interactive)
        .await
        .unwrap();
    assert_eq!(got[0].availability, FontAvailability::Failed);
    assert_eq!(got[0].family, "qcf-v1-p1");
    assert!(s.requests().is_empty());
}
