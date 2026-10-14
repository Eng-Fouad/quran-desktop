//! Resumable downloads (`Http::download`): `.dl.part` + sidecar, `received` advanced only after fsync, truncation to
//! `received` (never the file length), `Range` + `If-Range` with a strong ETag or `Last-Modified`, `206` append / `200`
//! restart, length and sha256 checks before the rename, and "first complete wins" with an existing file.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::Path;
use std::time::Duration;

use quran_packs::PackError;
use quran_packs::http::{Expect, Http, Request, Sidecar, read_sidecar};
use quran_packs::install::{dl_part_path, dl_sidecar_path};
use quran_packs::jobs::JobHandle;
use quran_types::AppError;
use support::http::{Action, Route, TestServer};
use support::{bytes, eventually, fast_http_config, sha256_hex};

const LM: &str = "Tue, 24 Dec 2024 06:33:19 GMT";

fn http() -> Http {
    Http::new(fast_http_config()).unwrap()
}

/// Leaves an interrupted download: the first `received` bytes (plus `junk` past them) and a sidecar.
fn seed(dest: &Path, body: &[u8], received: usize, junk: usize, sidecar: &Sidecar) {
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    let mut part = body[..received].to_vec();
    part.extend(std::iter::repeat_n(0xEE, junk));
    std::fs::write(dl_part_path(dest), part).unwrap();
    std::fs::write(dl_sidecar_path(dest), serde_json::to_vec(sidecar).unwrap()).unwrap();
}

fn no_temps(dest: &Path) -> bool {
    !dl_part_path(dest).exists() && !dl_sidecar_path(dest).exists()
}

#[tokio::test]
async fn a_fresh_download_leaves_only_the_file() {
    let s = TestServer::start();
    let body = bytes(300_000, 1);
    s.route("/001.mp3", Route::bytes(body.clone()).etag("\"a1\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("audio").join("7").join("001.mp3");
    let urls = vec![s.url("/001.mp3")];
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default().len(300_000))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    assert_eq!(done.sha256, sha256_hex(&body));
    assert_eq!(done.validators.etag.as_deref(), Some("\"a1\""));
    assert_eq!(done.resumed_from, 0);
    assert!(!done.kept_existing);
    assert!(no_temps(&dest));
    assert!(s.requests()[0].header("range").is_none());
}

#[tokio::test]
async fn a_mid_stream_disconnect_resumes_from_the_sidecar() {
    let s = TestServer::start();
    let body = bytes(3 * 1024 * 1024, 2);
    s.route(
        "/f.zip",
        Route::bytes(body.clone())
            .etag("\"z1\"")
            .then(Action::Disconnect(1_500_000)),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.zip");
    let urls = vec![s.url("/f.zip")];
    let done = http()
        .download(
            Request::new(&urls),
            &dest,
            &Expect::default().sha256(sha256_hex(&body)),
        )
        .await
        .unwrap();
    assert_eq!(done.sha256, sha256_hex(&body));
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    let reqs = s.requests_to("/f.zip");
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[1].header("range"), Some("bytes=1500000-"));
    assert_eq!(reqs[1].header("if-range"), Some("\"z1\""));
    assert!(no_temps(&dest));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pause_keeps_the_temp_and_resume_truncates_to_received() {
    let s = TestServer::start();
    let body = bytes(3 * 1024 * 1024, 3);
    s.route(
        "/002.mp3",
        Route::bytes(body.clone())
            .last_modified(LM)
            .throttle(64 * 1024, Duration::from_millis(10)),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("002.mp3");
    let urls = vec![s.url("/002.mp3")];
    let http = http();
    let job = JobHandle::detached(1, "audio.qdc.7");
    let task = {
        let (http, urls, dest, job) = (http.clone(), urls.clone(), dest.clone(), job.clone());
        tokio::spawn(async move {
            http.download(
                Request::new(&urls).job(Some(&job)),
                &dest,
                &Expect::default(),
            )
            .await
        })
    };
    let sidecar = dl_sidecar_path(&dest);
    assert!(
        eventually(Duration::from_secs(20), || {
            std::fs::read(&sidecar)
                .ok()
                .and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok())
                .is_some_and(|sc| sc.received >= 1024 * 1024)
        })
        .await
    );
    job.request_pause();
    let err = task.await.unwrap().unwrap_err();
    assert!(matches!(err, PackError::Cancelled));
    let saved = read_sidecar(&sidecar).await.unwrap();
    assert_eq!(saved.total, Some(body.len() as u64));
    assert_eq!(saved.last_modified.as_deref(), Some(LM));
    assert_eq!(saved.url, urls[0]);
    let part_len = std::fs::metadata(dl_part_path(&dest)).unwrap().len();
    assert!(part_len >= saved.received);
    assert!(!dest.exists());

    // Junk past `received` (a torn write) must not be trusted.
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(dl_part_path(&dest))
            .unwrap();
        f.write_all(&[0xAB; 100_000]).unwrap();
    }
    s.clear_log();
    let job = JobHandle::detached(2, "audio.qdc.7").for_item(0);
    let done = http
        .download(
            Request::new(&urls).job(Some(&job)),
            &dest,
            &Expect::default(),
        )
        .await
        .unwrap();
    assert_eq!(done.resumed_from, saved.received);
    assert_eq!(done.sha256, sha256_hex(&body));
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    let reqs = s.requests_to("/002.mp3");
    assert_eq!(reqs.len(), 1);
    assert_eq!(
        reqs[0].header("range"),
        Some(format!("bytes={}-", saved.received).as_str())
    );
    assert_eq!(
        reqs[0].header("if-range"),
        Some(LM),
        "Last-Modified without an ETag"
    );
    assert_eq!(
        u64::from(job.snapshot().received_kib),
        body.len() as u64 / 1024,
        "resumed bytes count as progress"
    );
    assert!(no_temps(&dest));
}

#[tokio::test]
async fn a_changed_file_restarts_from_zero() {
    let s = TestServer::start();
    let v1 = bytes(200_000, 4);
    let v2 = bytes(200_000, 5);
    s.route("/t.zip", Route::bytes(v2.clone()).etag("\"v2\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("t.zip");
    let urls = vec![s.url("/t.zip")];
    seed(
        &dest,
        &v1,
        50_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("\"v1\"".into()),
            last_modified: None,
            total: Some(200_000),
            received: 50_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(
        done.sha256,
        sha256_hex(&v2),
        "If-Range failed, so the whole new file came"
    );
    assert_eq!(std::fs::read(&dest).unwrap(), v2);
    let reqs = s.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].header("if-range"), Some("\"v1\""));
}

#[tokio::test]
async fn weak_etags_are_never_used_for_if_range() {
    let s = TestServer::start();
    let body = bytes(100_000, 6);
    s.route(
        "/w",
        Route::bytes(body.clone())
            .etag("W/\"weak\"")
            .last_modified(LM),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("w.bin");
    let urls = vec![s.url("/w")];
    seed(
        &dest,
        &body,
        40_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("W/\"weak\"".into()),
            last_modified: Some(LM.into()),
            total: Some(100_000),
            received: 40_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.resumed_from, 40_000);
    assert_eq!(done.sha256, sha256_hex(&body));
    assert_eq!(s.requests()[0].header("if-range"), Some(LM));
    assert_eq!(s.requests()[0].header("range"), Some("bytes=40000-"));
}

#[tokio::test]
async fn without_validators_a_download_starts_over() {
    let s = TestServer::start();
    let body = bytes(80_000, 7);
    s.route("/n", Route::bytes(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("n.bin");
    let urls = vec![s.url("/n")];
    seed(
        &dest,
        &body,
        30_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: None,
            last_modified: None,
            total: Some(80_000),
            received: 30_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.sha256, sha256_hex(&body));
    assert!(s.requests()[0].header("range").is_none());
}

#[tokio::test]
async fn a_server_that_ignores_ranges_restarts_the_file() {
    let s = TestServer::start();
    let body = bytes(120_000, 8);
    s.route("/r", Route::bytes(body.clone()).etag("\"r\"").no_ranges());
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("r.bin");
    let urls = vec![s.url("/r")];
    seed(
        &dest,
        &body,
        60_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("\"r\"".into()),
            last_modified: None,
            total: Some(120_000),
            received: 60_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(
        done.sha256,
        sha256_hex(&body),
        "200 → truncate and restart, no duplicate bytes"
    );
    assert_eq!(std::fs::read(&dest).unwrap(), body);
}

#[tokio::test]
async fn a_wrong_content_range_restarts_cleanly() {
    let s = TestServer::start();
    let body = bytes(90_000, 9);
    s.route(
        "/c",
        Route::bytes(body.clone())
            .etag("\"c\"")
            .then(Action::WrongRange),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("c.bin");
    let urls = vec![s.url("/c")];
    seed(
        &dest,
        &body,
        10_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("\"c\"".into()),
            last_modified: None,
            total: Some(90_000),
            received: 10_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.sha256, sha256_hex(&body));
    let reqs = s.requests();
    assert_eq!(reqs.len(), 2);
    assert!(reqs[1].header("range").is_none(), "started over");
}

#[tokio::test]
async fn a_complete_temp_is_finished_without_refetching_the_body() {
    let s = TestServer::start();
    let body = bytes(50_000, 10);
    s.route("/done", Route::bytes(body.clone()).etag("\"d\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("done.bin");
    let urls = vec![s.url("/done")];
    seed(
        &dest,
        &body,
        50_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("\"d\"".into()),
            last_modified: None,
            total: Some(50_000),
            received: 50_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default().len(50_000))
        .await
        .unwrap();
    assert_eq!(done.sha256, sha256_hex(&body));
    assert_eq!(
        s.requests()[0].header("range"),
        Some("bytes=50000-"),
        "answered 416"
    );
    assert!(no_temps(&dest));
}

#[tokio::test]
async fn a_length_mismatch_is_never_moved_into_place() {
    let s = TestServer::start();
    s.route("/003.mp3", Route::bytes(bytes(10_000, 11)));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("003.mp3");
    let urls = vec![s.url("/003.mp3")];
    let err = http()
        .download(Request::new(&urls), &dest, &Expect::default().len(10_001))
        .await
        .unwrap_err();
    assert_eq!(AppError::from(err).kind(), "integrity");
    assert!(!dest.exists());
    assert!(no_temps(&dest));
}

#[tokio::test]
async fn a_sha256_mismatch_deletes_the_temp() {
    let s = TestServer::start();
    s.route("/x.zip", Route::bytes(bytes(70_000, 12)).etag("\"x\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("x.zip");
    let urls = vec![s.url("/x.zip")];
    let err = http()
        .download(
            Request::new(&urls),
            &dest,
            &Expect::default().sha256("00".repeat(32)),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&err, PackError::Integrity(m) if m.contains("sha256")),
        "{err:?}"
    );
    assert!(!dest.exists());
    assert!(no_temps(&dest));
}

#[tokio::test]
async fn a_sidecar_for_another_length_is_discarded() {
    let s = TestServer::start();
    let body = bytes(64_000, 13);
    s.route("/l", Route::bytes(body.clone()).etag("\"l\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("l.bin");
    let urls = vec![s.url("/l")];
    seed(
        &dest,
        &body,
        20_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("\"l\"".into()),
            last_modified: None,
            total: Some(63_000),
            received: 20_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default().len(64_000))
        .await
        .unwrap();
    assert_eq!(done.resumed_from, 0);
    assert!(s.requests()[0].header("range").is_none());
}

#[tokio::test]
async fn a_sidecar_whose_temp_is_shorter_is_not_trusted() {
    let s = TestServer::start();
    let body = bytes(64_000, 14);
    s.route("/s", Route::bytes(body.clone()).etag("\"s\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("s.bin");
    let urls = vec![s.url("/s")];
    seed(
        &dest,
        &body,
        10_000,
        0,
        &Sidecar {
            url: urls[0].clone(),
            etag: Some("\"s\"".into()),
            last_modified: None,
            total: Some(64_000),
            received: 30_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.resumed_from, 0);
    assert_eq!(done.sha256, sha256_hex(&body));
}

#[tokio::test]
async fn the_sidecar_mirror_is_tried_first_on_resume() {
    let s = TestServer::start();
    let body = bytes(100_000, 15);
    s.route("/com/001.mp3", Route::bytes(body.clone()).etag("\"m\""));
    s.route("/org/001.mp3", Route::bytes(body.clone()).etag("\"m\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("001.mp3");
    let urls = vec![s.url("/com/001.mp3"), s.url("/org/001.mp3")];
    seed(
        &dest,
        &body,
        25_000,
        0,
        &Sidecar {
            url: urls[1].clone(),
            etag: Some("\"m\"".into()),
            last_modified: None,
            total: Some(100_000),
            received: 25_000,
        },
    );
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.url, urls[1]);
    assert_eq!(s.hits("/com/001.mp3"), 0);
    assert_eq!(done.sha256, sha256_hex(&body));
}

#[tokio::test]
async fn first_complete_wins_against_an_existing_file() {
    let s = TestServer::start();
    let body = bytes(30_000, 16);
    s.route("/004.mp3", Route::bytes(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("004.mp3");
    // A stream promoted the same file while the job downloaded (no expected length, so nothing is accepted upfront).
    std::fs::write(&dest, &body).unwrap();
    let urls = vec![s.url("/004.mp3")];
    let done = http()
        .download(
            Request::new(&urls),
            &dest,
            &Expect::default().keep_existing(),
        )
        .await
        .unwrap();
    assert!(
        done.kept_existing,
        "the file that completed first stays in place"
    );
    assert_eq!(s.hits("/004.mp3"), 1);
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    assert!(no_temps(&dest));
    // A different file of the same length is not the same file: the verified download replaces it.
    std::fs::write(&dest, bytes(30_000, 17)).unwrap();
    let done = http()
        .download(
            Request::new(&urls),
            &dest,
            &Expect::default().keep_existing(),
        )
        .await
        .unwrap();
    assert!(!done.kept_existing);
    assert_eq!(std::fs::read(&dest).unwrap(), body);
}

#[tokio::test]
async fn a_failing_mirror_mid_file_continues_on_the_next() {
    let s = TestServer::start();
    let body = bytes(500_000, 18);
    s.route(
        "/a/f",
        Route::bytes(body.clone())
            .etag("\"same\"")
            .then(Action::Disconnect(200_000))
            .then(Action::Status(503))
            .then(Action::Status(503))
            .then(Action::Status(503))
            .then(Action::Status(503)),
    );
    s.route("/b/f", Route::bytes(body.clone()).etag("\"same\""));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("f.bin");
    let urls = vec![s.url("/a/f"), s.url("/b/f")];
    let done = http()
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert_eq!(done.sha256, sha256_hex(&body));
    assert_eq!(done.url, urls[1]);
    let b = s.requests_to("/b/f");
    assert_eq!(
        b[0].header("range"),
        Some("bytes=200000-"),
        "same validator: resumed on the mirror"
    );
}

#[tokio::test]
async fn a_complete_file_is_accepted_without_a_request() {
    let s = TestServer::start();
    let body = bytes(40_000, 19);
    s.route("/005.mp3", Route::bytes(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("005.mp3");
    std::fs::write(&dest, &body).unwrap();
    std::fs::write(dl_part_path(&dest), b"stale").unwrap();
    let urls = vec![s.url("/005.mp3")];
    let expect = Expect::default().len(40_000).keep_existing();
    let done = http()
        .download(Request::new(&urls), &dest, &expect)
        .await
        .unwrap();
    assert!(done.kept_existing);
    assert_eq!(done.sha256, sha256_hex(&body));
    assert!(done.url.is_empty());
    assert!(s.requests().is_empty(), "no request for a complete file");
    assert!(no_temps(&dest));

    // A file of another length (or failing a pinned hash) is downloaded again.
    std::fs::write(&dest, b"short").unwrap();
    let done = http()
        .download(Request::new(&urls), &dest, &expect)
        .await
        .unwrap();
    assert!(!done.kept_existing);
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    let pinned = Expect::default()
        .len(40_000)
        .sha256(sha256_hex(&body))
        .keep_existing();
    std::fs::write(&dest, bytes(40_000, 20)).unwrap();
    let done = http()
        .download(Request::new(&urls), &dest, &pinned)
        .await
        .unwrap();
    assert!(!done.kept_existing);
    assert_eq!(std::fs::read(&dest).unwrap(), body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_the_network_off_stops_a_download_and_keeps_it_resumable() {
    let s = TestServer::start();
    let body = bytes(3 * 1024 * 1024, 21);
    s.route(
        "/006.mp3",
        Route::bytes(body.clone())
            .etag("\"n\"")
            .throttle(64 * 1024, Duration::from_millis(10)),
    );
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("006.mp3");
    let urls = vec![s.url("/006.mp3")];
    let http = http();
    let task = {
        let (http, urls, dest) = (http.clone(), urls.clone(), dest.clone());
        tokio::spawn(async move {
            http.download(Request::new(&urls), &dest, &Expect::default())
                .await
        })
    };
    let sidecar = dl_sidecar_path(&dest);
    assert!(
        eventually(Duration::from_secs(20), || {
            std::fs::read(&sidecar)
                .ok()
                .and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok())
                .is_some_and(|sc| sc.received >= 1024 * 1024)
        })
        .await
    );
    http.set_network_allowed(false);
    let err = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(matches!(err, PackError::Offline), "{err:?}");
    assert!(dl_part_path(&dest).exists() && sidecar.exists());
    http.set_network_allowed(true);
    let done = http
        .download(Request::new(&urls), &dest, &Expect::default())
        .await
        .unwrap();
    assert!(done.resumed_from >= 1024 * 1024);
    assert_eq!(done.sha256, sha256_hex(&body));
}
