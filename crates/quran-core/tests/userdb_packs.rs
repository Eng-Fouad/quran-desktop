//! The pack registry as the pack manager uses it: install/partial/remove of whole packs, per-item rows
//! for on-demand packs, the LRU stream cache, and persistence.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use quran_core::InstalledStatus;
use quran_types::PackKind;
use support::user::{T0, TempUserDb, installed_row, item_row};

#[test]
fn a_whole_pack_install_update_and_removal() {
    let t = TempUserDb::at(T0);
    // A job starts: partial, then installed in one write.
    t.db.pack_upsert(&installed_row(
        "tr.en.saheeh",
        PackKind::Translation,
        InstalledStatus::Partial,
    ))
    .unwrap();
    let mut row = installed_row(
        "tr.en.saheeh",
        PackKind::Translation,
        InstalledStatus::Installed,
    );
    t.db.pack_upsert(&row).unwrap();
    // An update flips version and path in place.
    row.version = "1.1.3".into();
    row.path = Some("translation/tr.en.saheeh/1.1.3/pack.db".into());
    row.updated_at = T0 + 1;
    row.last_checked_at = Some(T0 + 1);
    t.db.pack_upsert(&row).unwrap();
    let reopened = t.reopen();
    assert_eq!(reopened.packs_installed().unwrap(), [row.clone()]);
    assert_eq!(reopened.pack_installed("tr.en.saheeh").unwrap(), Some(row));
    // Removal: `removing` while files are deleted, then the row goes.
    t.db.pack_upsert(&installed_row(
        "tr.en.saheeh",
        PackKind::Translation,
        InstalledStatus::Removing,
    ))
    .unwrap();
    t.db.pack_delete("tr.en.saheeh").unwrap();
    assert!(t.db.packs_installed().unwrap().is_empty());
}

#[test]
fn on_demand_items_and_the_stream_cache_lru() {
    let t = TempUserDb::at(T0);
    // Fonts viewed page by page (pinned), audio streamed (unpinned) and one explicit surah download (pinned).
    for page in [1_u32, 2, 262] {
        t.db.pack_item_upsert(&item_row("mushaf.v2", &format!("p{page}"), true, T0))
            .unwrap();
    }
    for (surah, used) in [(18_u32, 300), (36, 100), (67, 200)] {
        t.db.pack_item_upsert(&item_row(
            "audio.qdc.7",
            &format!("{surah:03}"),
            false,
            T0 + used,
        ))
        .unwrap();
    }
    t.db.pack_item_upsert(&item_row("audio.qdc.7", "001", true, T0))
        .unwrap();
    // Playing surah 36 again makes it the most recently used.
    t.db.set_test_clock(Some(T0 + 1_000));
    t.db.pack_item_touch("audio.qdc.7", "036").unwrap();
    let evict: Vec<String> =
        t.db.pack_items_evictable(10)
            .unwrap()
            .into_iter()
            .map(|i| i.item)
            .collect();
    assert_eq!(evict, ["067", "018", "036"]);
    // Evicting the oldest one.
    t.db.pack_item_delete("audio.qdc.7", "067").unwrap();
    assert_eq!(t.db.pack_items("audio.qdc.7").unwrap().len(), 3);
    assert_eq!(
        t.reopen()
            .pack_items("mushaf.v2")
            .unwrap()
            .iter()
            .map(|i| i.item.as_str())
            .collect::<Vec<_>>(),
        ["p1", "p2", "p262"]
    );
    // Removing the font pack clears its items in one call.
    assert_eq!(t.db.pack_items_clear("mushaf.v2").unwrap(), 3);
    assert!(t.db.pack_items("mushaf.v2").unwrap().is_empty());
    assert!(
        t.db.pack_item("audio.qdc.7", "001")
            .unwrap()
            .unwrap()
            .pinned
    );
}

#[test]
fn every_status_and_kind_round_trips() {
    let t = TempUserDb::at(T0);
    let kinds = [
        PackKind::MushafFonts,
        PackKind::Decor,
        PackKind::Translation,
        PackKind::Tafsir,
        PackKind::Recitation,
        PackKind::Wbw,
    ];
    let statuses = [
        InstalledStatus::Installed,
        InstalledStatus::Partial,
        InstalledStatus::Paused,
        InstalledStatus::Failed,
        InstalledStatus::Removing,
    ];
    let mut expected = Vec::new();
    for (i, kind) in kinds.into_iter().enumerate() {
        for (j, status) in statuses.into_iter().enumerate() {
            let row = installed_row(&format!("pack{i}.s{j}"), kind, status);
            t.db.pack_upsert(&row).unwrap();
            expected.push(row);
        }
    }
    expected.sort_by(|a, b| a.pack_id.cmp(&b.pack_id));
    assert_eq!(t.db.packs_installed().unwrap(), expected);
}
