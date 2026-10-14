//! The startup sweep: stale `*.stream.part` (not a live stream's), orphan `.dl.part` without a job journal, interrupted
//! `.part`/`.tmp` temps, staging without a journal, unreferenced version directories (an old version Windows held), and
//! interrupted removals.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::path::Path;

use quran_core::{InstalledPackRow, InstalledStatus};
use quran_packs::install;
use quran_types::PackKind;
use support::TestEnv;

fn put(path: &Path, len: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, vec![0u8; len]).unwrap();
}

fn row(
    pack_id: &str,
    kind: PackKind,
    path: Option<&str>,
    status: InstalledStatus,
) -> InstalledPackRow {
    InstalledPackRow {
        pack_id: pack_id.into(),
        kind,
        version: "1".into(),
        path: path.map(str::to_owned),
        status,
        bytes: 1,
        items_total: 1,
        items_present: 1,
        sha256: None,
        source_version: None,
        installed_at: 0,
        updated_at: 0,
        last_checked_at: None,
    }
}

#[tokio::test]
async fn sweep_removes_stale_temps_and_keeps_what_is_live_or_resumable() {
    let env = TestEnv::new();
    let r = &env.root;
    // Streams: 7/001 is live, 7/002 is stale.
    put(&install::stream_part_path(r, 7, 1), 100);
    put(&install::stream_part_path(r, 7, 2), 100);
    env.writers.stream_begin(7, 1);
    // Job temps: reciter 7 has a journal (resumable), reciter 5 does not.
    put(&install::dl_part_path(&install::audio_path(r, 7, 18)), 50);
    put(
        &install::dl_sidecar_path(&install::audio_path(r, 7, 18)),
        10,
    );
    put(&install::dl_part_path(&install::audio_path(r, 5, 18)), 50);
    put(
        &install::dl_sidecar_path(&install::audio_path(r, 5, 18)),
        10,
    );
    put(
        &install::staging_dir(r, "audio.qdc.7")
            .unwrap()
            .join("job.json"),
        0,
    );
    std::fs::write(
        install::staging_dir(r, "audio.qdc.7")
            .unwrap()
            .join("job.json"),
        br#"{"packId":"audio.qdc.7"}"#,
    )
    .unwrap();
    // Installed files survive.
    put(&install::audio_path(r, 7, 3), 300);
    put(&install::audio_path(r, 5, 3), 300);
    // Interrupted per-item temps.
    let font = install::font_page_path(r, quran_packs::adapters::FontVariant::V2, 9);
    put(&install::part_path(&font), 20);
    put(&font, 20);
    put(
        &install::part_path(&install::decor_path(r, "quran-common.ttf").unwrap()),
        20,
    );
    put(&r.join("decor").join("sura-names.woff2.tmp"), 20);
    // Staging without a journal (an interrupted job before it wrote one), and a stray file.
    put(
        &install::staging_dir(r, "tr.en.rwwad")
            .unwrap()
            .join("pack.dl.part"),
        70,
    );
    put(&install::staging_root(r).join("junk.bin"), 5);

    let report = install::sweep(r, &env.user, &env.writers).await.unwrap();
    assert_eq!(report.stream_parts, 1);
    assert_eq!(report.orphan_downloads, 2);
    assert_eq!(report.part_files, 3);
    assert_eq!(report.staging_dirs, 2);
    assert_eq!(report.bytes, 100 + 60 + 60 + 75);

    assert!(
        install::stream_part_path(r, 7, 1).exists(),
        "a live stream's temp stays"
    );
    assert!(!install::stream_part_path(r, 7, 2).exists());
    assert!(
        install::dl_part_path(&install::audio_path(r, 7, 18)).exists(),
        "resumable"
    );
    assert!(!install::dl_part_path(&install::audio_path(r, 5, 18)).exists());
    assert!(install::audio_path(r, 7, 3).exists() && install::audio_path(r, 5, 3).exists());
    assert!(font.exists() && !install::part_path(&font).exists());
    assert!(install::staging_dir(r, "audio.qdc.7").unwrap().exists());
    assert!(!install::staging_dir(r, "tr.en.rwwad").unwrap().exists());

    // Nothing left to do the second time.
    let again = install::sweep(r, &env.user, &env.writers).await.unwrap();
    assert_eq!(again, install::SweepReport::default());
}

#[tokio::test]
async fn sweep_deletes_unreferenced_versions_and_finishes_removals() {
    let env = TestEnv::new();
    let r = &env.root;
    // Installed: v2 referenced, v1 left behind by Windows.
    put(&r.join("translation/tr.en.saheeh/1.1.1/pack.db"), 10);
    put(&r.join("translation/tr.en.saheeh/1.1.2/pack.db"), 10);
    env.user
        .pack_upsert(&row(
            "tr.en.saheeh",
            PackKind::Translation,
            Some("translation/tr.en.saheeh/1.1.2/pack.db"),
            InstalledStatus::Installed,
        ))
        .unwrap();
    // A pack directory nobody references.
    put(&r.join("tafsir/tafsir.ar.orphan/1/pack.db"), 10);
    // An interrupted removal of a whole pack, and one whose directory is already gone.
    put(&r.join("translation/tr.ur.junagarhi/2/pack.db"), 10);
    env.user
        .pack_upsert(&row(
            "tr.ur.junagarhi",
            PackKind::Translation,
            Some("translation/tr.ur.junagarhi/2/pack.db"),
            InstalledStatus::Removing,
        ))
        .unwrap();
    env.user
        .pack_upsert(&row(
            "tr.fr.rashid",
            PackKind::Translation,
            None,
            InstalledStatus::Removing,
        ))
        .unwrap();
    // A per-item pack stuck in removal: reported for the manager.
    env.user
        .pack_upsert(&row(
            "mushaf.v4",
            PackKind::MushafFonts,
            None,
            InstalledStatus::Removing,
        ))
        .unwrap();

    let report = install::sweep(r, &env.user, &env.writers).await.unwrap();
    assert_eq!(report.version_dirs, 2);
    assert_eq!(report.removals, 2);
    assert_eq!(report.pending_removals, ["mushaf.v4"]);
    assert!(r.join("translation/tr.en.saheeh/1.1.2/pack.db").exists());
    assert!(!r.join("translation/tr.en.saheeh/1.1.1").exists());
    assert!(!r.join("tafsir/tafsir.ar.orphan").exists());
    assert!(!r.join("translation/tr.ur.junagarhi").exists());
    assert!(
        env.user
            .pack_installed("tr.ur.junagarhi")
            .unwrap()
            .is_none()
    );
    assert!(env.user.pack_installed("tr.fr.rashid").unwrap().is_none());
    assert_eq!(
        env.user
            .pack_installed("tr.en.saheeh")
            .unwrap()
            .unwrap()
            .status,
        InstalledStatus::Installed
    );
}

#[tokio::test]
async fn sweep_of_an_empty_root_is_a_no_op() {
    let env = TestEnv::new();
    let report = install::sweep(&env.root.join("missing"), &env.user, &env.writers)
        .await
        .unwrap();
    assert_eq!(report, install::SweepReport::default());
}
