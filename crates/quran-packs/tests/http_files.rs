//! Small-file downloads (`Http::fetch_file`, docs/ARCHITECTURE.md §2.5.5 "Integrity"): `.part` + rename, length =
//! `Content-Length`, sha256 (pinned or trust on first use), magic prefix, mirror fallback on a bad payload, and no
//! temp ever left behind. Owner: WP5b.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use quran_packs::PackError;
use quran_packs::http::{Expect, Http, Request, WOFF2_MAGIC};
use quran_packs::install;
use quran_packs::jobs::JobHandle;
use quran_types::AppError;
use support::http::{Action, Route, TestServer};
use support::{bytes, fast_http_config, sha256_hex};

fn http() -> Http {
    Http::new(fast_http_config()).unwrap()
}

fn woff2(len: usize, seed: u8) -> Vec<u8> {
    let mut b = WOFF2_MAGIC.to_vec();
    b.extend(bytes(len - WOFF2_MAGIC.len(), seed));
    b
}

#[tokio::test]
async fn a_verified_file_is_renamed_into_place() {
    let s = TestServer::start();
    let font = woff2(40_960, 1);
    s.route("/p1.woff2", Route::bytes(font.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("mushaf").join("v2").join("p1.woff2");
    let urls = vec![s.url("/p1.woff2")];
    let job = JobHandle::detached(1, "mushaf.v2");
    let item = job.for_item(10_000);
    let done = http()
        .fetch_file(
            Request::new(&urls).job(Some(&item)),
            &dest,
            &Expect::default()
                .len(40_960)
                .sha256(sha256_hex(&font).to_uppercase())
                .magic(WOFF2_MAGIC),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), font);
    assert_eq!(done.bytes, 40_960);
    assert_eq!(done.sha256, sha256_hex(&font));
    assert_eq!(done.path, dest);
    assert_eq!(done.resumed_from, 0);
    assert!(!install::part_path(&dest).exists());
    assert_eq!(s.requests()[0].header("accept-encoding"), Some("identity"));
    let snap = job.snapshot();
    assert_eq!(snap.received_kib, 40, "bytes counted for the job");
    assert_eq!(
        snap.total_kib, 40,
        "the estimate was replaced by the real length"
    );
}

#[tokio::test]
async fn without_an_expected_hash_the_computed_one_is_reported() {
    let s = TestServer::start();
    let data = bytes(5000, 2);
    s.route("/decor.ttf", Route::bytes(data.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("decor.ttf");
    let urls = vec![s.url("/decor.ttf")];
    let done = http()
        .fetch_file(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.sha256, sha256_hex(&data), "trust on first use");
}

#[tokio::test]
async fn a_length_mismatch_is_never_placed() {
    let s = TestServer::start();
    s.route("/p2.woff2", Route::bytes(woff2(1000, 3)));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("p2.woff2");
    let urls = vec![s.url("/p2.woff2")];
    let err = http()
        .fetch_file(Request::new(&urls), &dest, &Expect::default().len(1001))
        .await
        .unwrap_err();
    assert_eq!(AppError::from(err).kind(), "integrity");
    assert!(!dest.exists());
    assert!(!install::part_path(&dest).exists());
    assert_eq!(s.hits("/p2.woff2"), 1, "a wrong file is not retried");
}

#[tokio::test]
async fn a_sha256_mismatch_falls_back_to_the_next_mirror() {
    let s = TestServer::start();
    let good = bytes(3000, 4);
    s.route("/stale/f.ttf", Route::bytes(bytes(3000, 5)));
    s.route("/fresh/f.ttf", Route::bytes(good.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.ttf");
    let urls = vec![s.url("/stale/f.ttf"), s.url("/fresh/f.ttf")];
    let expect = Expect::default().sha256(sha256_hex(&good));
    let done = http()
        .fetch_file(Request::new(&urls), &dest, &expect)
        .await
        .unwrap();
    assert_eq!(done.url, urls[1]);
    assert_eq!(std::fs::read(&dest).unwrap(), good);

    // Only a wrong file anywhere: Integrity, nothing placed.
    let urls = vec![s.url("/stale/f.ttf")];
    let other = dir.path().join("g.ttf");
    let err = http()
        .fetch_file(Request::new(&urls), &other, &expect)
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");
    assert!(!other.exists() && !install::part_path(&other).exists());
}

#[tokio::test]
async fn a_page_that_is_not_a_font_is_rejected_early() {
    let s = TestServer::start();
    let mut html = b"<!doctype html><title>captive portal</title>".to_vec();
    html.extend(bytes(200_000, 6));
    s.route("/p3.woff2", Route::bytes(html));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("p3.woff2");
    let urls = vec![s.url("/p3.woff2")];
    let err = http()
        .fetch_file(
            Request::new(&urls),
            &dest,
            &Expect::default().magic(WOFF2_MAGIC),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&err, PackError::Integrity(m) if m.contains("wOF2")),
        "{err:?}"
    );
    assert!(!dest.exists() && !install::part_path(&dest).exists());
}

#[tokio::test]
async fn a_short_body_is_retried() {
    let s = TestServer::start();
    let data = woff2(100_000, 7);
    s.route(
        "/p4.woff2",
        Route::bytes(data.clone()).then(Action::Disconnect(30_000)),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("p4.woff2");
    let urls = vec![s.url("/p4.woff2")];
    let job = JobHandle::detached(1, "mushaf.v2").for_item(100_000);
    http()
        .fetch_file(
            Request::new(&urls).job(Some(&job)),
            &dest,
            &Expect::default(),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), data);
    assert_eq!(s.hits("/p4.woff2"), 2);
    assert_eq!(
        job.snapshot().received_kib,
        97,
        "the broken attempt's bytes were taken back"
    );
}

#[tokio::test]
async fn a_body_without_content_length_needs_an_expected_length() {
    let s = TestServer::start();
    let data = bytes(2048, 8);
    s.route("/nolen", Route::bytes(data.clone()).no_length());
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("nolen.bin");
    let urls = vec![s.url("/nolen")];
    let err = http()
        .fetch_file(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap_err();
    assert_eq!(AppError::from(err).kind(), "integrity");
    let done = http()
        .fetch_file(Request::new(&urls), &dest, &Expect::default().len(2048))
        .await
        .unwrap();
    assert_eq!(done.bytes, 2048);
    assert_eq!(std::fs::read(&dest).unwrap(), data);
}

#[tokio::test]
async fn an_existing_file_is_replaced_atomically() {
    let s = TestServer::start();
    let data = bytes(4096, 9);
    s.route("/f", Route::bytes(data.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.bin");
    std::fs::write(&dest, b"old").unwrap();
    let urls = vec![s.url("/f")];
    http()
        .fetch_file(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), data);
}

#[tokio::test]
async fn an_oversized_file_is_refused_before_download() {
    let s = TestServer::start();
    s.route("/big", Route::bytes(bytes(10_000, 10)));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("big.bin");
    let urls = vec![s.url("/big")];
    let err = http()
        .fetch_file(Request::new(&urls), &dest, &Expect::default().max_len(1000))
        .await
        .unwrap_err();
    assert_eq!(AppError::from(err).kind(), "integrity");
    assert!(!dest.exists() && !install::part_path(&dest).exists());
}

#[tokio::test]
async fn a_cancelled_job_stops_and_leaves_no_temp() {
    let s = TestServer::start();
    s.route(
        "/slow",
        Route::bytes(bytes(400_000, 11)).throttle(8 * 1024, std::time::Duration::from_millis(20)),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("slow.bin");
    let urls = vec![s.url("/slow")];
    let job = JobHandle::detached(1, "mushaf.v2");
    let canceller = {
        let job = job.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            job.request_cancel();
        })
    };
    let err = http()
        .fetch_file(
            Request::new(&urls).job(Some(&job)),
            &dest,
            &Expect::default(),
        )
        .await
        .unwrap_err();
    canceller.await.unwrap();
    assert!(matches!(err, PackError::Cancelled));
    assert!(!dest.exists() && !install::part_path(&dest).exists());
}
