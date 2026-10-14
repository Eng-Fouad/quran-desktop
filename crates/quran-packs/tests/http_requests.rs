//! The HTTP layer's requests: mirrors, retries and backoff, `Retry-After`, the network gate, conditional `HEAD`, online
//! tracking with the re-probe, and the global/per-host limits with the interactive reserve.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use quran_packs::PackError;
use quran_packs::http::{Http, Lane, Request, Validators};
use quran_types::AppError;
use serde_json::{Value, json};
use support::http::{Action, Gate, Route, TestServer, closed_port_url};
use support::{eventually, fast_http_config};

fn http() -> Http {
    Http::new(fast_http_config()).unwrap()
}

#[tokio::test]
async fn get_reads_the_body_and_its_validators() {
    let s = TestServer::start();
    s.route(
        "/a.json",
        Route::json(&json!({ "verses": [1, 2] }))
            .etag("\"v1\"")
            .last_modified("Tue, 24 Dec 2024 06:33:19 GMT"),
    );
    let http = http();
    let urls = vec![s.url("/a.json")];
    let body = http.get(Request::new(&urls)).await.unwrap();
    assert_eq!(body.json::<Value>().unwrap(), json!({ "verses": [1, 2] }));
    assert_eq!(body.validators.etag.as_deref(), Some("\"v1\""));
    assert_eq!(
        body.validators.last_modified.as_deref(),
        Some("Tue, 24 Dec 2024 06:33:19 GMT")
    );
    assert_eq!(body.url, urls[0]);
    assert_eq!(body.sha256_hex(), support::sha256_hex(&body.bytes));

    let v: Value = http.get_json(Request::new(&urls)).await.unwrap();
    assert_eq!(v["verses"][1], 2);
    let reqs = s.requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[1].header("accept"), Some("application/json"));
    assert_eq!(reqs[0].header("user-agent"), Some("QuranForDesktop/test"));
}

#[tokio::test]
async fn malformed_json_is_an_integrity_failure() {
    let s = TestServer::start();
    s.route("/bad.json", Route::bytes(b"{ not json".to_vec()));
    let urls = vec![s.url("/bad.json")];
    let err = http()
        .get_json::<Value>(Request::new(&urls))
        .await
        .unwrap_err();
    assert_eq!(AppError::from(err).kind(), "integrity");
}

#[tokio::test]
async fn mirrors_are_tried_in_order_past_connect_errors_and_404s() {
    let s = TestServer::start();
    s.route("/ok", Route::bytes(b"payload".to_vec()));
    let urls = vec![closed_port_url("/x"), s.url("/missing"), s.url("/ok")];
    let body = http().get(Request::new(&urls)).await.unwrap();
    assert_eq!(body.bytes, b"payload");
    assert_eq!(body.url, urls[2]);
    assert_eq!(s.hits("/missing"), 1, "a 404 is not retried");
    assert_eq!(s.hits("/ok"), 1);
}

#[tokio::test]
async fn transient_failures_are_retried_with_backoff() {
    let s = TestServer::start();
    s.route(
        "/flaky",
        Route::bytes(b"ok".to_vec())
            .then(Action::Status(503))
            .then(Action::Status(500)),
    );
    let urls = vec![s.url("/flaky")];
    let t = Instant::now();
    let body = http().get(Request::new(&urls)).await.unwrap();
    assert_eq!(body.bytes, b"ok");
    assert_eq!(s.hits("/flaky"), 3);
    assert!(
        t.elapsed() >= Duration::from_millis(60),
        "waited 20 + 40 ms between rounds"
    );
}

#[tokio::test]
async fn retries_stop_after_three_retry_rounds_with_the_last_error() {
    let s = TestServer::start();
    let mut route = Route::bytes(b"never".to_vec());
    for _ in 0..10 {
        route = route.then(Action::Status(500));
    }
    s.route("/down", route);
    let urls = vec![s.url("/down")];
    let err = http().get(Request::new(&urls)).await.unwrap_err();
    assert!(
        matches!(err, PackError::Http { status: 500, .. }),
        "{err:?}"
    );
    assert_eq!(s.hits("/down"), 4, "the first attempt and 3 retries");
    assert_eq!(AppError::from(err).kind(), "network");
}

/// A link that accepts connections and never answers: an interactive request (someone waits) ends at its deadline,
/// not after four 30 s idle timeouts and the backoff (≈ 130 s); a body that is flowing is never cut; background work
/// waits for the answer as before.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_interactive_request_has_a_deadline_and_background_work_does_not() {
    let s = TestServer::start();
    let gate = Gate::new();
    s.route("/stalled", Route::bytes(b"late".to_vec()).gated(&gate));
    // A slow but flowing body: 8 KiB in 1 KiB pieces 150 ms apart, longer than the whole deadline.
    s.route(
        "/slow",
        Route::bytes(vec![7u8; 8 * 1024]).throttle(1024, Duration::from_millis(150)),
    );
    let mut cfg = fast_http_config();
    cfg.interactive_response_timeout = Duration::from_millis(300);
    cfg.interactive_deadline = Duration::from_millis(700);
    let http = Http::new(cfg).unwrap();

    let stalled = vec![s.url("/stalled")];
    let t = Instant::now();
    let err = http.get(Request::new(&stalled)).await.unwrap_err();
    let took = t.elapsed();
    assert!(matches!(err, PackError::Timeout(_)), "{err:?}");
    assert!(took < Duration::from_millis(1500), "{took:?}");
    assert!(
        (2..=4).contains(&s.hits("/stalled")),
        "retried within the deadline only"
    );
    assert_eq!(AppError::from(err).kind(), "network");
    assert!(http.online(), "a link that answers late is not offline");

    let slow = vec![s.url("/slow")];
    let t = Instant::now();
    let body = http.get(Request::new(&slow)).await.unwrap();
    assert_eq!(body.bytes.len(), 8 * 1024);
    assert!(
        t.elapsed() > Duration::from_millis(700),
        "outlived the deadline"
    );

    let background = {
        let http = http.clone();
        let urls = stalled.clone();
        tokio::spawn(async move {
            http.get(Request::new(&urls).lane(Lane::Background))
                .await
                .map(|b| b.bytes)
        })
    };
    tokio::time::sleep(Duration::from_millis(1200)).await;
    gate.open();
    assert_eq!(background.await.unwrap().unwrap(), b"late");
}

#[tokio::test]
async fn a_404_everywhere_is_not_found() {
    let s = TestServer::start();
    let urls = vec![s.url("/a"), s.url("/b")];
    let err = http().get(Request::new(&urls)).await.unwrap_err();
    assert!(matches!(err, PackError::Http { status: 404, .. }));
    assert_eq!(AppError::from(err).kind(), "not_found");
    assert_eq!(s.requests().len(), 2, "each mirror once");
}

#[tokio::test]
async fn retry_after_is_honoured() {
    let s = TestServer::start();
    s.route(
        "/busy",
        Route::bytes(b"ok".to_vec()).then(Action::RetryAfter(429, "1".into())),
    );
    let urls = vec![s.url("/busy")];
    let t = Instant::now();
    http().get(Request::new(&urls)).await.unwrap();
    assert!(t.elapsed() >= Duration::from_secs(1), "{:?}", t.elapsed());
    assert_eq!(s.hits("/busy"), 2);
}

#[tokio::test]
async fn an_excessive_retry_after_retires_the_mirror() {
    let s = TestServer::start();
    s.route(
        "/busy",
        Route::bytes(b"no".to_vec()).then(Action::RetryAfter(503, "3600".into())),
    );
    s.route("/ok", Route::bytes(b"yes".to_vec()));
    let urls = vec![s.url("/busy"), s.url("/ok")];
    let t = Instant::now();
    let body = http().get(Request::new(&urls)).await.unwrap();
    assert_eq!(body.bytes, b"yes");
    assert!(t.elapsed() < Duration::from_secs(5));
    assert_eq!(s.hits("/busy"), 1);
}

#[tokio::test]
async fn nothing_leaves_the_machine_while_the_network_is_not_allowed() {
    let s = TestServer::start();
    s.route("/a", Route::bytes(b"x".to_vec()));
    let http = Http::new(fast_http_config().network_allowed(false)).unwrap();
    let urls = vec![s.url("/a")];
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a.bin");
    assert!(matches!(
        http.get(Request::new(&urls)).await,
        Err(PackError::Offline)
    ));
    assert!(matches!(
        http.head(Request::new(&urls), None).await,
        Err(PackError::Offline)
    ));
    assert!(matches!(
        http.fetch_file(Request::new(&urls), &dest, &Default::default())
            .await,
        Err(PackError::Offline)
    ));
    assert!(matches!(
        http.download(Request::new(&urls), &dest, &Default::default())
            .await,
        Err(PackError::Offline)
    ));
    assert!(!http.probe().await);
    assert!(s.requests().is_empty());
    assert!(!http.online());
    http.set_network_allowed(true);
    assert!(http.online());
    http.get(Request::new(&urls)).await.unwrap();
}

#[tokio::test]
async fn conditional_head() {
    let s = TestServer::start();
    s.route(
        "/f.zip",
        Route::bytes(vec![7u8; 1000])
            .etag("\"e1\"")
            .last_modified("Thu, 26 Mar 2000 17:35:45 GMT"),
    );
    let http = http();
    let urls = vec![s.url("/f.zip")];
    let head = http.head(Request::new(&urls), None).await.unwrap();
    assert_eq!(head.status, 200);
    assert!(!head.not_modified);
    assert_eq!(head.content_length, Some(1000));
    assert_eq!(head.validators.etag.as_deref(), Some("\"e1\""));

    let same = Validators {
        etag: Some("\"e1\"".into()),
        last_modified: None,
    };
    let head = http.head(Request::new(&urls), Some(&same)).await.unwrap();
    assert!(head.not_modified);
    assert_eq!(head.status, 304);
    assert_eq!(
        s.requests().last().unwrap().header("if-none-match"),
        Some("\"e1\"")
    );

    let old = Validators {
        etag: Some("\"e0\"".into()),
        last_modified: None,
    };
    let head = http.head(Request::new(&urls), Some(&old)).await.unwrap();
    assert!(!head.not_modified, "a different ETag is an update");
    assert!(s.requests().iter().all(|r| r.method == "HEAD"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_connect_failures_go_offline_and_the_probe_comes_back() {
    let s = TestServer::start();
    s.route("/probe", Route::bytes(Vec::new()));
    let mut cfg = fast_http_config();
    cfg.probe_url = s.url("/probe");
    let http = Http::new(cfg).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        http.set_listener(move |online| seen.lock().unwrap().push(online));
    }
    assert!(http.online());

    let dead = vec![closed_port_url("/x")];
    let t = Instant::now();
    let err = http.get(Request::new(&dead)).await.unwrap_err();
    let ladder = t.elapsed();
    assert!(matches!(err, PackError::Offline), "{err:?}");
    assert!(!http.online());
    assert_eq!(*seen.lock().unwrap(), [false]);
    assert_eq!(AppError::from(err).kind(), "offline");

    // While offline, a request fails after one round of connect errors, without the backoff ladder (three rounds
    // above). Windows takes ~2 s to refuse a loopback connection, so compare durations rather than use a bound.
    let t = Instant::now();
    assert!(matches!(
        http.get(Request::new(&dead)).await,
        Err(PackError::Offline)
    ));
    assert!(
        t.elapsed() * 2 < ladder,
        "{:?} offline vs {ladder:?} for the ladder",
        t.elapsed()
    );

    // The re-probe (started late so it cannot end the offline phase above early) finds the network again.
    http.start_probe(&tokio::runtime::Handle::current());
    http.start_probe(&tokio::runtime::Handle::current());
    assert!(
        eventually(Duration::from_secs(5), || http.online()).await,
        "the re-probe found the network"
    );
    assert!(s.hits("/probe") >= 1);
    assert_eq!(*seen.lock().unwrap(), [false, true]);

    // The setting is part of `online()`.
    http.set_network_allowed(false);
    assert!(!http.online());
    http.set_network_allowed(true);
    assert!(http.online());
    assert_eq!(*seen.lock().unwrap(), [false, true, false, true]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_allowing_the_network_probes_at_once() {
    let s = TestServer::start();
    s.route("/probe", Route::bytes(Vec::new()));
    let mut cfg = fast_http_config();
    cfg.probe_url = s.url("/probe");
    cfg.probe_interval = Duration::from_secs(3600);
    let http = Http::new(cfg).unwrap();
    http.start_probe(&tokio::runtime::Handle::current());
    let dead = vec![closed_port_url("/x")];
    let _ = http.get(Request::new(&dead)).await;
    assert!(!http.online());
    http.set_network_allowed(false);
    http.set_network_allowed(true);
    assert!(
        eventually(Duration::from_secs(5), || http.online()).await,
        "probed without waiting for the hour-long interval"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn global_and_per_host_limits() {
    let s = TestServer::start();
    let gate = Gate::new();
    s.route("/slow", Route::bytes(b"x".to_vec()).gated(&gate));
    let http = http();
    let mut tasks = Vec::new();
    for host in ["127.0.0.1", "localhost"] {
        for _ in 0..8 {
            let http = http.clone();
            let urls = vec![s.url_as(host, "/slow")];
            tasks.push(tokio::spawn(async move {
                http.get(Request::new(&urls)).await.map(|b| b.bytes)
            }));
        }
    }
    assert!(eventually(Duration::from_secs(5), || gate.waiting() == 6).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(gate.waiting(), 6, "global limit 6");
    gate.open();
    for t in tasks {
        assert_eq!(t.await.unwrap().unwrap(), b"x");
    }
    assert!(s.peak() <= 6, "peak {}", s.peak());
    let a = s.peak_for_host(&format!("127.0.0.1:{}", s.port()));
    let b = s.peak_for_host(&format!("localhost:{}", s.port()));
    assert!(a <= 4 && b <= 4, "per host 4: {a} {b}");
    assert_eq!(s.peak(), 6);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_work_leaves_room_for_interactive_requests() {
    let s = TestServer::start();
    let gate = Gate::new();
    s.route("/slow", Route::bytes(b"x".to_vec()).gated(&gate));
    let http = http();
    let spawn = |host: &str, lane: Lane| {
        let http = http.clone();
        let urls = vec![s.url_as(host, "/slow")];
        tokio::spawn(async move { http.get(Request::new(&urls).lane(lane)).await.map(|_| ()) })
    };
    let mut tasks = Vec::new();
    for _ in 0..6 {
        tasks.push(spawn("127.0.0.1", Lane::Background));
    }
    assert!(eventually(Duration::from_secs(5), || gate.waiting() == 3).await);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(gate.waiting(), 3, "background holds at most 3 per host");
    for _ in 0..4 {
        tasks.push(spawn("localhost", Lane::Background));
    }
    assert!(eventually(Duration::from_secs(5), || gate.waiting() == 4).await);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(gate.waiting(), 4, "background holds at most 4 globally");
    // Interactive requests still get through on both hosts.
    tasks.push(spawn("127.0.0.1", Lane::Interactive));
    tasks.push(spawn("localhost", Lane::Interactive));
    assert!(
        eventually(Duration::from_secs(5), || gate.waiting() == 6).await,
        "the interactive reserve: {}",
        gate.waiting()
    );
    gate.open();
    for t in tasks {
        t.await.unwrap().unwrap();
    }
}
