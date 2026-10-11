//! Cached files (docs/ARCHITECTURE.md §2.3.7 rule 1): a complete `{sss}.mp3` of the expected length is served without
//! the network by `CachingHttpSource` and `LocalFileSource`; anything else is streamed (online) or `Offline`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::missing_panics_doc
)]

#[path = "source_common.rs"]
mod common;

use std::sync::atomic::Ordering;
use std::time::Duration;

use common::{
    Behavior, Fixture, RECITER, RegEvent, Server, content, exists, key, read_all, wait_for,
};
use quran_audio::{AudioError, LocalFileSource, SourceProvider, cached_file_path};

fn put_cached(fx: &Fixture, surah: u16, bytes: &[u8]) {
    let path = fx.mp3(surah);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn a_complete_cached_file_is_served_without_the_network() {
    let fx = Fixture::new();
    let bytes = content(40_000, 3);
    put_cached(&fx, 2, &bytes);
    fx.online.store(false, Ordering::Release);
    // An address nothing listens on: any network use would fail the open.
    let k = key(
        "http://127.0.0.1:9/7/002.mp3".to_owned(),
        2,
        Some(bytes.len() as u64),
    );

    let mut opened = fx.source.open(&k).unwrap();
    assert_eq!(opened.buffered_permille.load(Ordering::Acquire), 1000);
    assert_eq!(opened.source.byte_len(), Some(bytes.len() as u64));
    assert!(read_all(&mut opened.source).unwrap() == bytes);
    assert!(
        fx.registry.events().is_empty(),
        "no stream for a cached file"
    );

    // Unknown expected length: any complete file is used.
    let any = key("http://127.0.0.1:9/7/002.mp3".to_owned(), 2, None);
    assert!(fx.source.open(&any).is_ok());
}

#[test]
fn a_cached_file_of_the_wrong_length_is_not_used() {
    let server = Server::start();
    let fresh = content(50_000, 4);
    server.put("/7/002.mp3", fresh.clone());
    server.set_behavior(Behavior::default());
    let fx = Fixture::new();
    put_cached(&fx, 2, &content(10_000, 5)); // stale: timings now expect another file
    let k = key(server.url("/7/002.mp3"), 2, Some(fresh.len() as u64));

    fx.online.store(false, Ordering::Release);
    assert!(
        matches!(fx.source.open(&k), Err(AudioError::Offline(_))),
        "offline: a stale file is not played against new timings"
    );

    fx.online.store(true, Ordering::Release);
    let mut opened = fx.source.open(&k).unwrap();
    assert!(read_all(&mut opened.source).unwrap() == fresh);
    wait_for(
        Duration::from_secs(5),
        "the fresh file replaces the stale one",
        || {
            fx.registry.events()
                == vec![
                    RegEvent::Begin(2),
                    RegEvent::End(2, Some(fresh.len() as u64)),
                ]
        },
    );
    assert_eq!(std::fs::read(fx.mp3(2)).unwrap(), fresh);
}

#[test]
fn an_empty_cached_file_is_never_complete() {
    let fx = Fixture::new();
    put_cached(&fx, 3, &[]);
    fx.online.store(false, Ordering::Release);
    let k = key("http://127.0.0.1:9/7/003.mp3".to_owned(), 3, None);
    assert!(matches!(fx.source.open(&k), Err(AudioError::Offline(_))));
}

#[test]
fn the_local_file_source_serves_complete_files_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("audio");
    let local = LocalFileSource::new(root.clone());
    assert_eq!(local.root(), root.as_path());
    let bytes = content(30_000, 6);
    let path = cached_file_path(&root, RECITER, 1);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &bytes).unwrap();

    let ok = key(
        "https://download.quranicaudio.com/x/001.mp3".to_owned(),
        1,
        Some(bytes.len() as u64),
    );
    let mut opened = local.open(&ok).unwrap();
    assert!(read_all(&mut opened.source).unwrap() == bytes);
    assert_eq!(opened.buffered_permille.load(Ordering::Acquire), 1000);

    let wrong_len = key(ok.url.clone(), 1, Some(bytes.len() as u64 + 7));
    assert!(matches!(
        local.open(&wrong_len),
        Err(AudioError::Offline(_))
    ));
    let missing = key(ok.url.clone(), 2, None);
    assert!(matches!(local.open(&missing), Err(AudioError::Offline(_))));
    assert!(!exists(&cached_file_path(&root, RECITER, 2)));
}
