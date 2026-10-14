//! `CachingHttpSource` against the in-repo HTTP server: progressive reads, live-stream reuse, promotion only on full
//! byte coverage, abandonment, the length check, the host fallback, the stall watchdog.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::missing_panics_doc
)]

#[path = "source_common.rs"]
mod common;

use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use common::{
    Behavior, Fixture, RECITER, RegEvent, Server, content, dead_authority, exists, key, read_all,
    wait_for,
};
use quran_audio::{AudioError, SourceProvider};

const PATH: &str = "/7/001.mp3";

fn serve(len: usize, behavior: Behavior) -> (Server, Vec<u8>) {
    let server = Server::start();
    let bytes = content(len, 1);
    server.put(PATH, bytes.clone());
    server.set_behavior(behavior);
    (server, bytes)
}

#[test]
fn a_stream_is_read_while_it_downloads_and_promoted_once_complete() {
    let (server, bytes) = serve(
        400 * 1024,
        Behavior::throttled(16 * 1024, Duration::from_millis(5)),
    );
    let fx = Fixture::new();
    let k = key(server.url(PATH), 1, Some(bytes.len() as u64));

    let mut opened = fx.source.open(&k).unwrap();
    assert_eq!(opened.source.byte_len(), Some(bytes.len() as u64));
    assert!(opened.source.is_seekable());
    assert!(exists(&fx.part(1)), "the stream writes {{sss}}.stream.part");
    assert_eq!(fx.source.live_streams(), 1);
    let read = read_all(&mut opened.source).unwrap();
    assert!(read == bytes, "the stream returns the file's bytes");

    wait_for(Duration::from_secs(5), "promotion", || {
        fx.registry.events()
            == vec![
                RegEvent::Begin(1),
                RegEvent::End(1, Some(bytes.len() as u64)),
            ]
    });
    assert_eq!(
        std::fs::read(fx.mp3(1)).unwrap(),
        bytes,
        "promoted byte-exact"
    );
    assert!(!exists(&fx.part(1)), "the temp is renamed, not copied");
    assert_eq!(opened.buffered_permille.load(Ordering::Acquire), 1000);
    assert_eq!(
        server.requests().len(),
        1,
        "one GET: {:?}",
        server.requests()
    );
    assert_eq!(server.range_requests(), 0);

    // The cached file now serves without the network.
    drop(opened);
    fx.online.store(false, Ordering::Release);
    let mut again = fx.source.open(&k).unwrap();
    assert_eq!(again.buffered_permille.load(Ordering::Acquire), 1000);
    assert!(read_all(&mut again.source).unwrap() == bytes);
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn a_second_open_reuses_the_live_stream() {
    let (server, bytes) = serve(
        1536 * 1024,
        Behavior::throttled(32 * 1024, Duration::from_millis(15)),
    );
    let fx = Fixture::new();
    let k = key(server.url(PATH), 1, Some(bytes.len() as u64));

    let mut a = fx.source.open(&k).unwrap();
    let mut b = fx.source.open(&k).unwrap();
    assert_eq!(
        server.requests().len(),
        1,
        "a second play never opens a second writer"
    );
    assert_eq!(fx.registry.events(), vec![RegEvent::Begin(1)]);
    assert!(
        std::sync::Arc::ptr_eq(&a.buffered_permille, &b.buffered_permille),
        "cursors of one stream share its progress"
    );

    // Each cursor keeps its own position: read them interleaved, from two threads.
    let ta = std::thread::spawn(move || read_all(&mut a.source).unwrap());
    let mut first = vec![0_u8; 100_000];
    b.source.read_exact(&mut first).unwrap();
    assert!(first == bytes[..100_000]);
    b.source.seek(SeekFrom::Start(10)).unwrap();
    let mut rest = Vec::new();
    b.source.read_to_end(&mut rest).unwrap();
    assert!(rest == bytes[10..]);
    assert!(ta.join().unwrap() == bytes);

    drop(b);
    wait_for(Duration::from_secs(5), "promotion", || {
        fx.registry.events()
            == vec![
                RegEvent::Begin(1),
                RegEvent::End(1, Some(bytes.len() as u64)),
            ]
    });
    assert_eq!(std::fs::read(fx.mp3(1)).unwrap(), bytes);
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn an_abandoned_stream_leaves_no_temp_and_ends_unpromoted() {
    let (server, bytes) = serve(
        2 * 1024 * 1024,
        Behavior::throttled(8 * 1024, Duration::from_millis(20)),
    );
    let fx = Fixture::new();
    let k = key(server.url(PATH), 1, Some(bytes.len() as u64));

    let mut opened = fx.source.open(&k).unwrap();
    let mut head = vec![0_u8; 64 * 1024];
    opened.source.read_exact(&mut head).unwrap();
    assert!(head == bytes[..head.len()]);
    assert_eq!(
        std::fs::metadata(fx.part(1)).unwrap().len(),
        bytes.len() as u64,
        "the temp is pre-sized to Content-Length"
    );
    let permille = opened.buffered_permille.load(Ordering::Acquire);
    assert!(
        permille > 0 && permille < 1000,
        "partial progress: {permille}"
    );

    drop(opened);
    assert!(
        !exists(&fx.part(1)),
        "the last cursor deletes the temp at once"
    );
    assert!(!exists(&fx.mp3(1)));
    wait_for(Duration::from_secs(5), "end(None)", || {
        fx.registry.events() == vec![RegEvent::Begin(1), RegEvent::End(1, None)]
    });
    wait_for(Duration::from_secs(5), "the download is cancelled", || {
        server.open_connections() == 0
    });
    assert_eq!(fx.source.live_streams(), 0);
}

#[test]
fn a_stream_that_seeked_past_a_gap_never_promotes_holes() {
    let len = 1024 * 1024;
    let (server, bytes) = serve(
        len,
        Behavior::throttled(16 * 1024, Duration::from_millis(20)),
    );
    let fx = Fixture::new();
    let k = key(server.url(PATH), 1, Some(len as u64));

    let mut opened = fx.source.open(&k).unwrap();
    let mut head = vec![0_u8; 32 * 1024];
    opened.source.read_exact(&mut head).unwrap();
    // Jump to the tail: a Range request fills it while the middle is still a hole.
    opened.source.seek(SeekFrom::End(-64 * 1024)).unwrap();
    let mut tail = vec![0_u8; 64 * 1024];
    opened.source.read_exact(&mut tail).unwrap();
    assert!(
        tail == bytes[len - 64 * 1024..],
        "the tail is the file's tail, not zeros"
    );
    assert!(
        server.range_requests() >= 1,
        "the seek asked for a range: {:?}",
        server.requests()
    );
    assert!(!exists(&fx.mp3(1)), "a stream with a gap is not complete");

    drop(opened);
    assert!(
        !exists(&fx.mp3(1)),
        "an incomplete stream is never promoted"
    );
    assert!(!exists(&fx.part(1)));
    wait_for(Duration::from_secs(5), "end(None)", || {
        fx.registry.events() == vec![RegEvent::Begin(1), RegEvent::End(1, None)]
    });
}

#[test]
fn a_read_near_the_end_is_served_without_waiting_for_the_whole_file() {
    // 1 MiB at 16 KiB per 20 ms: about 1.3 s for the whole file.
    let len = 1024 * 1024;
    let (server, bytes) = serve(
        len,
        Behavior::throttled(16 * 1024, Duration::from_millis(20)),
    );
    let fx = Fixture::new();
    let mut opened = fx
        .source
        .open(&key(server.url(PATH), 1, Some(len as u64)))
        .unwrap();
    let started = Instant::now();
    // A decoder probing the last bytes (trailing tags), or a seek to the last ayah of a surah.
    opened.source.seek(SeekFrom::End(-8 * 1024)).unwrap();
    let mut tail = vec![0_u8; 8 * 1024];
    opened.source.read_exact(&mut tail).unwrap();
    assert!(tail == bytes[len - 8 * 1024..]);
    assert!(
        started.elapsed() < Duration::from_millis(700),
        "the tail took {:?}: it waited for the whole download",
        started.elapsed()
    );
    // And the head is still there to read, byte-exact.
    opened.source.seek(SeekFrom::Start(0)).unwrap();
    let mut head = vec![0_u8; 40 * 1024];
    opened.source.read_exact(&mut head).unwrap();
    assert!(head == bytes[..40 * 1024]);
}

#[test]
fn back_filled_gaps_promote_byte_exact() {
    let len = 768 * 1024;
    let (server, bytes) = serve(
        len,
        Behavior::throttled(16 * 1024, Duration::from_millis(5)),
    );
    let fx = Fixture::new();
    let k = key(server.url(PATH), 1, Some(len as u64));

    let mut opened = fx.source.open(&k).unwrap();
    let mut buf = vec![0_u8; 16 * 1024];
    opened.source.read_exact(&mut buf).unwrap();
    opened.source.seek(SeekFrom::Start(600 * 1024)).unwrap();
    opened.source.read_exact(&mut buf).unwrap();
    assert!(buf == bytes[600 * 1024..616 * 1024]);
    // Keep the cursor: stream-download back-fills the gaps, then the coverage is complete.
    wait_for(Duration::from_secs(10), "promotion after back-fill", || {
        fx.registry
            .events()
            .contains(&RegEvent::End(1, Some(len as u64)))
    });
    assert!(
        std::fs::read(fx.mp3(1)).unwrap() == bytes,
        "no zero-filled hole was promoted"
    );
    // The cursor still reads the whole file correctly after the rename.
    opened.source.seek(SeekFrom::Start(0)).unwrap();
    assert!(read_all(&mut opened.source).unwrap() == bytes);
}

#[test]
fn a_length_that_differs_from_the_timings_is_a_mismatch() {
    let (server, bytes) = serve(64 * 1024, Behavior::default());
    let fx = Fixture::new();
    let k = key(server.url(PATH), 1, Some(bytes.len() as u64 + 1));

    match fx.source.open(&k) {
        Err(AudioError::FileMismatch(m)) => {
            assert!(m.contains("bytes upstream, the timings expect"), "{m}");
        }
        other => panic!("expected the timings/file mismatch, got {other:?}"),
    }
    assert!(!exists(&fx.part(1)), "no temp for a rejected file");
    assert!(fx.registry.events().is_empty(), "nothing began writing");
}

#[test]
fn an_unknown_expected_length_accepts_any_file() {
    let (server, bytes) = serve(48 * 1024, Behavior::default());
    let fx = Fixture::new();
    let mut opened = fx.source.open(&key(server.url(PATH), 1, None)).unwrap();
    assert!(read_all(&mut opened.source).unwrap() == bytes);
    wait_for(Duration::from_secs(5), "promotion", || exists(&fx.mp3(1)));
}

#[test]
fn a_file_without_content_length_streams_but_is_never_cached() {
    let (server, bytes) = serve(
        48 * 1024,
        Behavior {
            no_length: true,
            ..Behavior::default()
        },
    );
    let fx = Fixture::new();
    let mut opened = fx.source.open(&key(server.url(PATH), 1, None)).unwrap();
    assert_eq!(opened.source.byte_len(), None);
    assert!(!opened.source.is_seekable());
    assert!(read_all(&mut opened.source).unwrap() == bytes);
    drop(opened);
    assert!(!exists(&fx.mp3(1)));
    assert!(!exists(&fx.part(1)));
    wait_for(Duration::from_secs(5), "end(None)", || {
        fx.registry.events() == vec![RegEvent::Begin(1), RegEvent::End(1, None)]
    });
}

#[test]
fn the_fallback_host_serves_after_a_5xx() {
    let (fallback, bytes) = serve(96 * 1024, Behavior::default());
    let primary = Server::start();
    primary.set_behavior(Behavior {
        status: Some(503),
        ..Behavior::default()
    });
    let (from, to) = (primary.authority(), fallback.authority());
    let fx = Fixture::with(|s| s.with_host_fallbacks(vec![(from, to)]));

    let mut opened = fx
        .source
        .open(&key(primary.url(PATH), 1, Some(bytes.len() as u64)))
        .unwrap();
    assert!(read_all(&mut opened.source).unwrap() == bytes);
    assert_eq!(primary.requests().len(), 1, "the first host is tried once");
    assert!(!fallback.requests().is_empty());
    wait_for(Duration::from_secs(5), "promotion", || exists(&fx.mp3(1)));
}

#[test]
fn the_fallback_host_serves_after_a_connect_error() {
    let (fallback, bytes) = serve(96 * 1024, Behavior::default());
    let dead = dead_authority();
    let fx = Fixture::with(|s| s.with_host_fallbacks(vec![(dead.clone(), fallback.authority())]));

    let url = format!("http://{dead}{PATH}");
    let mut opened = fx
        .source
        .open(&key(url, 1, Some(bytes.len() as u64)))
        .unwrap();
    assert!(read_all(&mut opened.source).unwrap() == bytes);
    assert_eq!(fallback.requests().len(), 1);
}

#[test]
fn a_404_is_not_retried_on_the_fallback_host() {
    let primary = Server::start(); // serves nothing: 404
    let (fallback, _) = serve(16 * 1024, Behavior::default());
    let fx =
        Fixture::with(|s| s.with_host_fallbacks(vec![(primary.authority(), fallback.authority())]));

    match fx.source.open(&key(primary.url(PATH), 1, None)) {
        Err(AudioError::Source(m)) => assert!(m.contains("404"), "{m}"),
        other => panic!("expected a source error, got {other:?}"),
    }
    assert!(
        fallback.requests().is_empty(),
        "a 404 is not a host failure"
    );
    assert!(fx.registry.events().is_empty());
}

#[test]
fn an_unreachable_host_without_fallback_reads_as_offline() {
    let fx = Fixture::new();
    let url = format!("http://{}{PATH}", dead_authority());
    assert!(matches!(
        fx.source.open(&key(url, 1, None)),
        Err(AudioError::Offline(_))
    ));
    assert!(!exists(&fx.part(1)));
}

#[test]
fn offline_and_uncached_is_offline_without_a_request() {
    let (server, _) = serve(16 * 1024, Behavior::default());
    let fx = Fixture::new();
    fx.online.store(false, Ordering::Release);
    assert!(matches!(
        fx.source.open(&key(server.url(PATH), 1, None)),
        Err(AudioError::Offline(_))
    ));
    assert!(server.requests().is_empty());
}

#[test]
fn an_explicit_download_that_finished_first_keeps_its_file() {
    let len = 512 * 1024;
    let (server, bytes) = serve(
        len,
        Behavior::throttled(16 * 1024, Duration::from_millis(5)),
    );
    let fx = Fixture::new();
    let mut opened = fx
        .source
        .open(&key(server.url(PATH), 1, Some(len as u64)))
        .unwrap();
    // A job renames its own complete file into place while the stream is still running.
    let job_file = vec![0xAB_u8; len];
    std::fs::write(fx.mp3(1), &job_file).unwrap();

    assert!(read_all(&mut opened.source).unwrap() == bytes);
    wait_for(Duration::from_secs(5), "end(Some)", || {
        fx.registry.events() == vec![RegEvent::Begin(1), RegEvent::End(1, Some(len as u64))]
    });
    assert!(
        std::fs::read(fx.mp3(1)).unwrap() == job_file,
        "the job's file is not replaced"
    );
    assert!(!exists(&fx.part(1)), "the stream's temp is deleted");
}

#[test]
fn a_stalled_stream_fails_the_blocked_read_and_is_not_reused() {
    let (server, bytes) = serve(
        1024 * 1024,
        Behavior {
            stall_after: Some(160 * 1024),
            ..Behavior::default()
        },
    );
    let fx = Fixture::with(|s| s.with_stall_timeout(Duration::from_millis(800)));
    let k = key(server.url(PATH), 1, Some(bytes.len() as u64));

    let mut opened = fx.source.open(&k).unwrap();
    let started = Instant::now();
    let err = read_all(&mut opened.source).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::TimedOut, "{err}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "failed within the stall timeout"
    );

    // The failed stream is never handed out again: a new open starts a new download.
    let requests = server.requests().len();
    let second = fx.source.open(&k).unwrap();
    assert_eq!(server.requests().len(), requests + 1, "a fresh GET");
    drop(opened);
    drop(second);
    assert!(!exists(&fx.mp3(1)));
    assert!(!exists(&fx.part(1)));
    wait_for(Duration::from_secs(5), "both streams ended", || {
        fx.registry.events()
            == vec![
                RegEvent::Begin(1),
                RegEvent::End(1, None),
                RegEvent::Begin(1),
                RegEvent::End(1, None),
            ]
    });
}

#[test]
fn going_offline_fails_a_blocked_read_at_once() {
    let (server, _) = serve(
        1024 * 1024,
        Behavior {
            stall_after: Some(128 * 1024),
            ..Behavior::default()
        },
    );
    let fx = Fixture::new(); // the default 30 s stall timeout
    let mut opened = fx.source.open(&key(server.url(PATH), 1, None)).unwrap();
    let online = std::sync::Arc::clone(&fx.online);
    let flip = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        online.store(false, Ordering::Release);
        Instant::now()
    });
    let err = read_all(&mut opened.source).unwrap_err();
    let offline_at = flip.join().unwrap();
    assert_eq!(err.kind(), ErrorKind::NotConnected, "{err}");
    assert!(
        offline_at.elapsed() < Duration::from_secs(2),
        "failed promptly after going offline"
    );
}

#[test]
fn a_new_file_for_the_same_surah_replaces_the_old_stream() {
    let server = Server::start();
    let old = content(512 * 1024, 1);
    let new = content(300 * 1024, 2);
    server.put("/old/001.mp3", old.clone());
    server.put("/new/001.mp3", new.clone());
    server.set_behavior(Behavior::throttled(16 * 1024, Duration::from_millis(10)));
    let fx = Fixture::new();

    let mut a = fx
        .source
        .open(&key(server.url("/old/001.mp3"), 1, Some(old.len() as u64)))
        .unwrap();
    let mut head = vec![0_u8; 16 * 1024];
    a.source.read_exact(&mut head).unwrap();
    // Revalidated timings point at a different file: it takes over the temp.
    let mut b = fx
        .source
        .open(&key(server.url("/new/001.mp3"), 1, Some(new.len() as u64)))
        .unwrap();
    assert!(read_all(&mut b.source).unwrap() == new);
    // The old stream ended unpromoted, the new one was cached. A stream's end reaches the registry from the blocking
    // pool (never on the caller's thread), so the old end may come after the new begin: the registry counts streams,
    // and only the events themselves are asserted, not their order.
    let mut expected = vec![
        RegEvent::Begin(1),
        RegEvent::Begin(1),
        RegEvent::End(1, None),
        RegEvent::End(1, Some(new.len() as u64)),
    ];
    expected.sort_by_key(|e| format!("{e:?}"));
    wait_for(Duration::from_secs(5), "both streams ended", || {
        let mut events = fx.registry.events();
        events.sort_by_key(|e| format!("{e:?}"));
        events == expected
    });
    assert!(std::fs::read(fx.mp3(1)).unwrap() == new);
    // The old cursor fails rather than reading the new file's bytes.
    assert!(read_all(&mut a.source).is_err());
}

#[test]
fn files_of_other_reciters_and_surahs_do_not_interfere() {
    let server = Server::start();
    let one = content(256 * 1024, 11);
    let two = content(320 * 1024, 12);
    server.put("/7/001.mp3", one.clone());
    server.put("/7/002.mp3", two.clone());
    server.set_behavior(Behavior::throttled(16 * 1024, Duration::from_millis(10)));
    let fx = Fixture::new();
    let mut a = fx
        .source
        .open(&key(server.url("/7/001.mp3"), 1, Some(one.len() as u64)))
        .unwrap();
    let mut b = fx
        .source
        .open(&key(server.url("/7/002.mp3"), 2, Some(two.len() as u64)))
        .unwrap();
    assert_eq!(fx.source.live_streams(), 2);
    assert!(read_all(&mut b.source).unwrap() == two);
    assert!(read_all(&mut a.source).unwrap() == one);
    wait_for(Duration::from_secs(5), "both cached", || {
        exists(&fx.mp3(1)) && exists(&fx.mp3(2))
    });
    assert_eq!(std::fs::read(fx.mp3(2)).unwrap(), two);
    let _ = RECITER;
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "qd-audio-ctl only")]
fn opening_from_async_code_is_a_debug_assertion() {
    let fx = Fixture::new();
    let k = key("http://127.0.0.1:9/7/001.mp3".to_owned(), 1, None);
    let source = &fx.source;
    fx.rt.block_on(async { drop(source.open(&k)) });
}
