//! The pack manager's caches: streamed audio recorded as cache and evicted least recently used first, "Clear stream
//! cache", "Clear cache" with its re-sync, and removing single items (surah 1 kept while other surahs need its basmala;
//! chapters removed without touching the others).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod manager_support;
mod qf_support;
mod support;

use std::path::Path;
use std::time::Duration;

use manager_support::{Fixture, T0, decor_pack, mushaf_pack};
use qf_support::{audio_pack, wbw_pack};
use quran_core::content_db::geometry;
use quran_core::{
    ChapterStamp, InstalledPackRow, InstalledStatus, PackItemRow, StoredTimings, TimedAyah,
    TimingFile,
};
use quran_packs::adapters::qdc_audio;
use quran_packs::install;
use quran_types::{PackKind, PackState, Settings, WbwEntry};
use support::eventually;
use support::http::TestServer;

const KIB: usize = 1024;
const AUDIO: &str = "audio.qdc.7";

fn write(path: &Path, len: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, support::bytes(len, 7)).unwrap();
}

fn item(pack_id: &str, item: &str, bytes: u64, pinned: bool, at: i64) -> PackItemRow {
    PackItemRow {
        pack_id: pack_id.into(),
        item: item.into(),
        bytes,
        sha256: String::new(),
        pinned,
        fetched_at: at,
        last_used_at: at,
    }
}

fn timings(surah: u32) -> StoredTimings {
    StoredTimings {
        file: TimingFile {
            reciter_id: 7,
            surah,
            audio_url: format!("https://download.quranicaudio.com/qdc/x/{surah}.mp3"),
            content_length: Some(4_096),
            duration_ms: Some(1_000),
            source: "qdc".into(),
            fetched_at_ms: T0,
            etag: None,
            payload_sha256: "00".repeat(32),
        },
        ayahs: vec![TimedAyah {
            ayah: 1,
            from_ms: 0,
            to_ms: 1_000,
            words: Vec::new(),
        }],
        word_level: false,
    }
}

fn audio_fixture() -> (Fixture, TestServer) {
    let server = TestServer::start();
    let hosts = vec![format!("127.0.0.1:{}", server.port())];
    let f = Fixture::new(vec![
        decor_pack(&server),
        mushaf_pack(&server, "v2"),
        audio_pack(7, &hosts),
        wbw_pack("en"),
    ]);
    f.env.user.set_test_clock(Some(T0));
    (f, server)
}

fn mp3(f: &Fixture, surah: u32) -> std::path::PathBuf {
    install::audio_path(&f.env.root, 7, surah)
}

/// A pinned surah: its file, its row and its pinned timings.
fn pin_surah(f: &Fixture, surah: u32, len: usize) {
    write(&mp3(f, surah), len);
    f.env
        .user
        .pack_item_upsert(&item(
            AUDIO,
            &format!("{surah:03}"),
            u64::try_from(len).unwrap(),
            true,
            T0,
        ))
        .unwrap();
    f.env.content.timings_put(&timings(surah), true).unwrap();
}

fn surah_rows(f: &Fixture) -> Vec<(String, bool)> {
    f.env
        .user
        .pack_items(AUDIO)
        .unwrap()
        .into_iter()
        .map(|r| (r.item, r.pinned))
        .collect()
}

#[tokio::test]
async fn streams_are_recorded_as_cache_and_evicted_least_recently_used_first() {
    let (f, _server) = audio_fixture();
    pin_surah(&f, 1, 50 * KIB);
    // A page read on demand is an unpinned row too, but never stream cache.
    write(&f.env.path("mushaf/v2/p1.woff2"), 10 * KIB);
    f.env
        .user
        .pack_item_upsert(&item("mushaf.v2", "p1", 10_240, false, T0 - 1))
        .unwrap();

    for (i, surah) in [2u32, 3, 4].into_iter().enumerate() {
        f.env
            .user
            .set_test_clock(Some(T0 + 1_000 * i64::try_from(i).unwrap()));
        f.manager.audio_stream_begin(7, surah);
        write(&mp3(&f, surah), 100 * KIB);
        f.manager.audio_stream_end(7, surah, Some(100 * 1024));
        let key = format!("{surah:03}");
        assert!(
            eventually(Duration::from_secs(10), || f
                .env
                .user
                .pack_item(AUDIO, &key)
                .unwrap()
                .is_some())
            .await,
            "surah {surah} recorded"
        );
    }
    assert!(f.events.changed().contains(AUDIO));
    let reciter = |f: &Fixture| {
        f.manager
            .reciters()
            .into_iter()
            .find(|r| r.id == 7)
            .unwrap()
    };
    assert_eq!(
        (reciter(&f).downloaded_surahs, reciter(&f).cached_surahs),
        (1, 3)
    );

    // Above the cap: the least recently streamed goes first.
    let freed = f
        .manager
        .enforce_stream_cache_cap(250 * 1024)
        .await
        .unwrap();
    assert_eq!(freed, 100 * 1024);
    assert!(!mp3(&f, 2).exists() && mp3(&f, 3).exists() && mp3(&f, 4).exists());

    // A file being streamed is never evicted; once its stream ends it is.
    f.manager.audio_stream_begin(7, 3);
    assert_eq!(
        f.manager.enforce_stream_cache_cap(0).await.unwrap(),
        100 * 1024
    );
    assert!(mp3(&f, 3).exists() && !mp3(&f, 4).exists());
    f.manager.audio_stream_end(7, 3, None);
    assert_eq!(
        f.manager.enforce_stream_cache_cap(0).await.unwrap(),
        100 * 1024
    );
    assert!(!mp3(&f, 3).exists());
    assert_eq!(surah_rows(&f), [("001".to_owned(), true)]);
    assert!(mp3(&f, 1).exists(), "pinned audio is never evicted");
    assert!(f.env.path("mushaf/v2/p1.woff2").exists());
    assert_eq!(f.env.user.pack_items("mushaf.v2").unwrap().len(), 1);
    assert_eq!(
        (reciter(&f).downloaded_surahs, reciter(&f).cached_surahs),
        (1, 0)
    );

    // A stream that promotes an already pinned surah keeps the pin.
    f.manager.audio_stream_begin(7, 1);
    f.manager.audio_stream_end(7, 1, Some(50 * 1024));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(surah_rows(&f), [("001".to_owned(), true)]);
}

/// "Least recently used" means played, not streamed: a cached surah played again from the cache moves to the back of
/// the eviction queue.
#[tokio::test]
async fn playing_from_the_cache_refreshes_its_recency() {
    let (f, _server) = audio_fixture();
    for (i, surah) in [2u32, 3].into_iter().enumerate() {
        let at = T0 + 1_000 * i64::try_from(i).unwrap();
        write(&mp3(&f, surah), 100 * KIB);
        f.env
            .user
            .pack_item_upsert(&item(AUDIO, &format!("{surah:03}"), 102_400, false, at))
            .unwrap();
    }
    f.env.user.set_test_clock(Some(T0 + 5_000));
    f.manager.audio_used(7, 2); // surah 2, streamed first, is played again from the cache
    f.manager.audio_used(7, 9); // no row: nothing to touch
    f.manager.audio_used(99, 2); // not a catalog reciter
    assert!(
        eventually(Duration::from_secs(10), || f
            .env
            .user
            .pack_item(AUDIO, "002")
            .unwrap()
            .is_some_and(|r| r.last_used_at == T0 + 5_000))
        .await,
        "surah 2 marked as played"
    );
    assert_eq!(f.env.user.pack_item(AUDIO, "009").unwrap(), None);

    let freed = f
        .manager
        .enforce_stream_cache_cap(100 * 1024)
        .await
        .unwrap();
    assert_eq!(freed, 100 * 1024);
    assert!(
        mp3(&f, 2).exists() && !mp3(&f, 3).exists(),
        "surah 3 was used longest ago"
    );
}

#[tokio::test]
async fn a_lower_cap_from_the_settings_evicts_at_once() {
    let (f, _server) = audio_fixture();
    for surah in [2u32, 3] {
        write(&mp3(&f, surah), 600 * KIB);
        f.env
            .user
            .pack_item_upsert(&item(
                AUDIO,
                &format!("{surah:03}"),
                600 * 1024,
                false,
                T0 + i64::from(surah),
            ))
            .unwrap();
    }
    let prev = Settings::default();
    let next = Settings {
        stream_cache_cap_mib: 1,
        ..Settings::default()
    };
    f.manager.apply_settings(&prev, &next);
    assert_eq!(f.manager.stream_cache_cap_bytes(), 1024 * 1024);
    assert!(
        eventually(Duration::from_secs(10), || !mp3(&f, 2).exists()).await,
        "the older file went"
    );
    assert!(mp3(&f, 3).exists());
}

#[tokio::test]
async fn clearing_the_stream_cache_drops_unpinned_files_and_orphans() {
    let (f, _server) = audio_fixture();
    pin_surah(&f, 1, 10 * KIB);
    write(&mp3(&f, 2), 20 * KIB);
    f.env
        .user
        .pack_item_upsert(&item(AUDIO, "002", 20_480, false, T0))
        .unwrap();
    // A promoted file no row accounts for, a job's resumable temp and a stream temp.
    write(&mp3(&f, 3), 30 * KIB);
    let part = install::dl_part_path(&mp3(&f, 4));
    write(&part, 5 * KIB);
    let stream = install::stream_part_path(&f.env.root, 7, 5);
    write(&stream, 5 * KIB);

    let freed = f.manager.clear_stream_cache().await.unwrap();
    assert_eq!(freed, 50 * 1024);
    assert!(mp3(&f, 1).exists() && !mp3(&f, 2).exists() && !mp3(&f, 3).exists());
    assert!(
        part.exists() && stream.exists(),
        "temps belong to their writers"
    );
    assert_eq!(surah_rows(&f), [("001".to_owned(), true)]);
    assert_eq!(f.manager.clear_stream_cache().await.unwrap(), 0);
}

fn chapter(f: &Fixture, surah: u32, pinned: bool, fetched_at_ms: i64, sha: &str) {
    let words = geometry::surah_word_ids(surah).unwrap();
    let rows: Vec<WbwEntry> = words
        .take(3)
        .map(|w| WbwEntry {
            word_id: w,
            text: String::new(),
            translation: Some(format!("gloss {w}")),
            transliteration: Some(format!("tl {w}")),
        })
        .collect();
    f.env
        .content
        .wbw_put_chapter(
            "wbw.en",
            surah,
            &rows,
            &ChapterStamp {
                surah,
                fetched_at_ms,
                sha256: sha.into(),
                pinned,
            },
        )
        .unwrap();
}

#[tokio::test]
async fn clear_cache_drops_unpinned_content_and_resyncs_the_registry() {
    let (f, _server) = audio_fixture();
    let user = &f.env.user;
    // WBW: chapter 1 fetched on demand, chapter 2 downloaded, chapter 3 recorded as downloaded although content.db
    // holds it unpinned (an inconsistent state that clearing must not hide).
    chapter(&f, 1, false, T0, "a1");
    chapter(&f, 2, true, T0, "a2");
    chapter(&f, 3, false, T0, "a3");
    user.pack_item_upsert(&item("wbw.en", "ch1", 300, false, T0))
        .unwrap();
    user.pack_item_upsert(&item("wbw.en", "ch2", 300, true, T0))
        .unwrap();
    user.pack_item_upsert(&item("wbw.en", "ch3", 300, true, T0))
        .unwrap();
    user.pack_upsert(&InstalledPackRow {
        pack_id: "wbw.en".into(),
        kind: PackKind::Wbw,
        version: "2026.10".into(),
        path: None,
        status: InstalledStatus::Partial,
        bytes: 600,
        items_total: 114,
        items_present: 2,
        sha256: None,
        source_version: None,
        installed_at: T0,
        updated_at: T0,
        last_checked_at: None,
    })
    .unwrap();
    // Audio: pinned surah 1 with its timings; timings of a stream-cached surah 2 and its file.
    pin_surah(&f, 1, 10 * KIB);
    f.env.content.timings_put(&timings(2), false).unwrap();
    write(&mp3(&f, 2), 20 * KIB);
    user.pack_item_upsert(&item(AUDIO, "002", 20_480, false, T0))
        .unwrap();
    f.env.content.kv_put("anything", "{}", T0).unwrap();

    let freed = f.manager.clear_cache().await.unwrap();
    assert!(freed > 20 * 1024, "the file and the content rows: {freed}");
    let stored: Vec<u32> = f
        .env
        .content
        .chapters("wbw.en")
        .unwrap()
        .iter()
        .map(|s| s.surah)
        .collect();
    assert_eq!(stored, [2], "pinned content survives");
    let stamps: Vec<u32> = f
        .env
        .content
        .timing_stamps(Some(7))
        .unwrap()
        .iter()
        .map(|s| s.surah)
        .collect();
    assert_eq!(stamps, [1]);
    assert_eq!(f.env.content.kv_get("anything").unwrap(), None);
    assert!(mp3(&f, 1).exists() && !mp3(&f, 2).exists());
    let wbw: Vec<String> = user
        .pack_items("wbw.en")
        .unwrap()
        .into_iter()
        .map(|r| r.item)
        .collect();
    assert_eq!(wbw, ["ch2"]);
    assert_eq!(
        f.state("wbw.en"),
        PackState::Partial {
            items_present: 1,
            items_total: 114
        },
        "a chapter whose data vanished is no longer counted"
    );
    let changed = f.events.changed();
    assert!(changed.contains("wbw.en") && changed.contains(AUDIO));
}

#[tokio::test]
async fn removing_surahs_keeps_surah_one_while_others_need_it() {
    let (f, _server) = audio_fixture();
    for surah in [1u32, 2, 3] {
        pin_surah(&f, surah, 8 * KIB);
    }
    // A pending swap of surah 2 (the revalidator's `.mp3.next`).
    let next = qdc_audio::next_path(&f.env.root, 7, 2);
    write(&next, 2 * KIB);
    f.manager.resync(None).await.unwrap();
    assert_eq!(
        f.state(AUDIO),
        PackState::Partial {
            items_present: 3,
            items_total: 114
        }
    );

    let freed = f.manager.remove_items(AUDIO, &[1, 2]).await.unwrap();
    assert_eq!(freed, 10 * 1024, "surah 2 and its pending swap");
    assert!(mp3(&f, 1).exists() && !mp3(&f, 2).exists() && !next.exists());
    assert_eq!(
        surah_rows(&f),
        [("001".to_owned(), true), ("003".to_owned(), true)]
    );
    let pinned = |surah: u32| {
        f.env
            .content
            .timing_stamps(Some(7))
            .unwrap()
            .into_iter()
            .find(|s| s.surah == surah)
            .map(|s| s.pinned)
    };
    assert_eq!(pinned(2), Some(false), "its timings stay as cache");
    assert_eq!(pinned(1), Some(true));
    assert_eq!(
        f.state(AUDIO),
        PackState::Partial {
            items_present: 2,
            items_total: 114
        }
    );
    assert!(f.events.changed().contains(AUDIO));

    // With no other surah left, surah 1 goes too.
    let freed = f.manager.remove_items(AUDIO, &[1, 3]).await.unwrap();
    assert_eq!(freed, 16 * 1024);
    assert!(surah_rows(&f).is_empty());
    assert_eq!(f.state(AUDIO), PackState::NotInstalled);
    assert_eq!(pinned(1), Some(false));
}

#[tokio::test]
async fn removing_chapters_leaves_the_other_chapters_intact() {
    let (f, _server) = audio_fixture();
    chapter(&f, 1, true, T0, "c1");
    chapter(&f, 112, false, T0 + 5, "c112");
    chapter(&f, 114, true, T0 + 9, "c114");
    for (key, pinned) in [("ch1", true), ("ch112", false), ("ch114", true)] {
        f.env
            .user
            .pack_item_upsert(&item("wbw.en", key, 100, pinned, T0))
            .unwrap();
    }
    let before: Vec<ChapterStamp> = f.env.content.chapters("wbw.en").unwrap();

    let freed = f.manager.remove_items("wbw.en", &[1]).await.unwrap();
    assert_eq!(freed, 100);
    let after = f.env.content.chapters("wbw.en").unwrap();
    assert_eq!(
        after,
        before[1..].to_vec(),
        "the other chapters keep their stamps"
    );
    let ch1 = geometry::surah_word_ids(1).unwrap();
    assert!(
        f.env
            .content
            .wbw_range("wbw.en", *ch1.start(), *ch1.end())
            .unwrap()
            .is_empty()
    );
    let ch112 = geometry::surah_word_ids(112).unwrap();
    let kept = f
        .env
        .content
        .wbw_range("wbw.en", *ch112.start(), *ch112.end())
        .unwrap();
    assert_eq!(kept.len(), 3);
    assert_eq!(
        kept[0].translation.as_deref(),
        Some(&*format!("gloss {}", ch112.start()))
    );
    let listed = f.manager.items("wbw.en").unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|i| (i.item, i.pinned))
            .collect::<Vec<_>>(),
        [(112, false), (114, true)]
    );
}

#[tokio::test]
async fn removing_pages_deletes_their_files() {
    let (f, _server) = audio_fixture();
    for page in 1..=2 {
        write(&f.env.path(&format!("mushaf/v2/p{page}.woff2")), 2 * KIB);
        f.env
            .user
            .pack_item_upsert(&item("mushaf.v2", &format!("p{page}"), 2_048, true, T0))
            .unwrap();
    }
    let freed = f
        .manager
        .remove_items("mushaf.v2", &[2, 600])
        .await
        .unwrap();
    assert_eq!(freed, 2_048);
    assert!(f.env.path("mushaf/v2/p1.woff2").exists());
    assert!(!f.env.path("mushaf/v2/p2.woff2").exists());
    assert_eq!(
        f.state("mushaf.v2"),
        PackState::Partial {
            items_present: 1,
            items_total: 604
        }
    );
}
