//! Pack DB writer and reader (docs/ARCHITECTURE.md §2.2.7, §3.4). Owner: WP1c.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};

use quran_core::pack_db::PACK_FORMAT;
use quran_core::{
    CoreError, FootnoteInput, NORMALIZER_VERSION, PackDb, PackDbWriter, PackEntry, PackEntryInput,
    PackMeta, PackTokenizer,
};
use quran_types::{AYAH_COUNT, Footnote, PackKind, TextDir};
use rusqlite::Connection;

fn meta(pack_id: &str, kind: PackKind, tokenizer: PackTokenizer) -> PackMeta {
    PackMeta {
        pack_id: pack_id.into(),
        kind,
        lang: "en".into(),
        dir: TextDir::Ltr,
        name: "Saheeh International".into(),
        author: "Saheeh International".into(),
        source: "quranenc".into(),
        source_version: "1.1.2".into(),
        licence: "QuranEnc terms".into(),
        attribution: "QuranEnc.com".into(),
        tokenizer,
        normalizer_version: NORMALIZER_VERSION,
        format: PACK_FORMAT,
    }
}

fn entry(ayah_id: u32, to_ayah_id: u32, plain: &str) -> PackEntryInput {
    PackEntryInput {
        ayah_id,
        to_ayah_id,
        html: format!("<p>{plain}</p>"),
        plain: plain.into(),
    }
}

fn footnote(id: &str, ayah_id: u32, marker: &str) -> FootnoteInput {
    FootnoteInput {
        id: id.into(),
        ayah_id,
        marker: marker.into(),
        html: format!("note {id}"),
    }
}

const FATIHA: [&str; 7] = [
    "In the name of Allah, the Entirely Merciful, the Especially Merciful.",
    "[All] praise is [due] to Allah, Lord of the worlds -",
    "The Entirely Merciful, the Especially Merciful,",
    "Sovereign of the Day of Recompense.",
    "It is You we worship and You we ask for help.",
    "Guide us to the straight path -",
    "The path of those upon whom You have bestowed favor, not of those who have evoked [Your] anger or of those \
     who are astray.",
];

/// A translation pack with al-Fatihah, 2:255 and 24:35 and four footnotes.
fn build_translation(path: &Path, tokenizer: PackTokenizer) -> quran_core::PackStats {
    let mut w = PackDbWriter::create(
        path,
        &meta("tr.en.saheeh", PackKind::Translation, tokenizer),
    )
    .unwrap();
    for (i, text) in FATIHA.iter().enumerate() {
        let id = u32::try_from(i).unwrap() + 1;
        w.entry(&entry(id, id, text)).unwrap();
    }
    w.entry(&entry(
        262,
        262,
        "Allah - there is no deity except Him, the Ever-Living, the Sustainer of [all] existence.",
    ))
    .unwrap();
    w.entry(&entry(2826, 2826, "Allah is the Light of the heavens and the earth. The example of His light is like a niche."))
        .unwrap();
    // Inserted out of marker order on purpose.
    w.footnote(&footnote("1:1:10", 1, "10")).unwrap();
    w.footnote(&footnote("1:1:2", 1, "2")).unwrap();
    w.footnote(&footnote("1:1:1", 1, "1")).unwrap();
    w.footnote(&footnote("2:255:1", 262, "1")).unwrap();
    w.set_source_sha256("ab12").unwrap();
    w.finish().unwrap()
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn raw_meta(path: &Path, key: &str) -> Option<String> {
    let conn = Connection::open(path).unwrap();
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

#[test]
fn translation_pack_round_trips() {
    let dir = tmp();
    let path = dir.path().join("staging").join("pack.db");
    let stats = build_translation(&path, PackTokenizer::PorterUnicode61);
    assert_eq!(stats.entries, 9);
    assert_eq!(stats.footnotes, 4);
    assert_eq!(stats.bytes, std::fs::metadata(&path).unwrap().len());

    let db = PackDb::open(&path).unwrap();
    assert_eq!(
        db.meta(),
        &meta(
            "tr.en.saheeh",
            PackKind::Translation,
            PackTokenizer::PorterUnicode61
        )
    );
    assert_eq!(db.path(), path);
    assert!(db.has_fts());

    let rows = db.entries(1, 7).unwrap();
    assert_eq!(rows.len(), 7);
    assert_eq!(
        rows[0],
        PackEntry {
            ayah_id: 1,
            to_ayah_id: 1,
            html: format!("<p>{}</p>", FATIHA[0])
        }
    );
    assert!(rows.windows(2).all(|w| w[0].ayah_id < w[1].ayah_id));
    assert_eq!(db.entries(8, 261).unwrap(), Vec::new());
    assert_eq!(db.entries(255, 300).unwrap().len(), 1);
    assert_eq!(db.entry_for(262).unwrap().unwrap().ayah_id, 262);
    assert_eq!(
        db.entry_for(263).unwrap(),
        None,
        "a translation entry covers one ayah"
    );

    // The extra §3.4 keys exist in the file.
    assert_eq!(raw_meta(&path, "source_sha256").as_deref(), Some("ab12"));
    let created: u64 = raw_meta(&path, "created_at").unwrap().parse().unwrap();
    assert!(created > 1_700_000_000);
}

#[test]
fn footnotes_follow_ayah_order_then_marker_number() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    build_translation(&path, PackTokenizer::PorterUnicode61);
    let db = PackDb::open(&path).unwrap();
    let ids = |v: Vec<Footnote>| v.into_iter().map(|f| f.id).collect::<Vec<_>>();
    assert_eq!(
        ids(db.footnotes_for(&[1]).unwrap()),
        ["1:1:1", "1:1:2", "1:1:10"]
    );
    assert_eq!(
        ids(db.footnotes_for(&[262, 1, 262, 7]).unwrap()),
        ["2:255:1", "1:1:1", "1:1:2", "1:1:10"]
    );
    assert!(db.footnotes_for(&[]).unwrap().is_empty());
    let f = &db.footnotes_for(&[262]).unwrap()[0];
    assert_eq!((f.marker.as_str(), f.html.as_str()), ("1", "note 2:255:1"));
}

/// QuranEnc numbers the notes of e.g. the Bengali translation in Bengali digits: `১০` (10) comes after `২` (2), and the
/// general note with an empty marker comes first.
#[test]
fn footnotes_in_other_scripts_sort_by_their_number() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let mut w = PackDbWriter::create(
        &path,
        &meta(
            "tr.bn.zakaria",
            PackKind::Translation,
            PackTokenizer::Unicode61RemoveDiacritics,
        ),
    )
    .unwrap();
    w.entry(&entry(8, 8, "আলিফ-লাম-মীম।")).unwrap();
    for (id, marker) in [
        ("2:1:10", "১০"),
        ("2:1:2", "২"),
        ("2:1:0", ""),
        ("2:1:1", "১"),
    ] {
        w.footnote(&footnote(id, 8, marker)).unwrap();
    }
    w.finish().unwrap();
    let db = PackDb::open(&path).unwrap();
    let markers: Vec<String> = db
        .footnotes_for(&[8])
        .unwrap()
        .into_iter()
        .map(|f| f.marker)
        .collect();
    assert_eq!(markers, ["", "১", "২", "১০"]);
}

#[test]
fn full_text_search_with_snippets_ranges_and_counts() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    build_translation(&path, PackTokenizer::PorterUnicode61);
    let db = PackDb::open(&path).unwrap();

    // Porter stemming: "mercy" matches "Merciful".
    let hits = db.fts_search("fold : (\"mercy\"*)", 50).unwrap();
    assert_eq!(hits.iter().map(|h| h.0).collect::<Vec<_>>(), [1, 3]);
    assert!(
        hits[0].1.contains("\u{E000}Merciful\u{E001}"),
        "{}",
        hits[0].1
    );
    assert_eq!(
        db.fts_count("fold : (\"mercy\"*)", 1, AYAH_COUNT).unwrap(),
        2
    );

    let light = db.fts_search("\"light\"", 10).unwrap();
    assert_eq!(light.len(), 1);
    assert_eq!(light[0].0, 2826);
    assert_eq!(
        light[0].1.matches('\u{E000}').count(),
        2,
        "both occurrences are marked"
    );

    // Range filter (a surah or juz) and limits.
    assert_eq!(
        db.fts_search_in("\"allah\"", 8, 6236, 10)
            .unwrap()
            .iter()
            .map(|h| h.0)
            .collect::<Vec<_>>(),
        [262, 2826]
    );
    assert_eq!(db.fts_count("\"allah\"", 1, 7).unwrap(), 2);
    assert_eq!(db.fts_search("\"allah\"", 1).unwrap().len(), 1);
    assert!(db.fts_search("\"allah\"", 0).unwrap().is_empty());
    assert!(matches!(
        db.fts_search_in("\"allah\"", 9, 8, 10),
        Err(CoreError::InvalidArgument(_))
    ));
    // A malformed FTS expression is an SQLite error, not a panic.
    assert!(matches!(
        db.fts_search("\"unterminated", 10),
        Err(CoreError::Sqlite(_))
    ));
}

#[test]
fn like_search_escapes_wildcards_and_counts() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    build_translation(&path, PackTokenizer::Unicode61RemoveDiacritics);
    let db = PackDb::open(&path).unwrap();
    let hits = db.like_search("merciful", 50).unwrap();
    assert_eq!(
        hits.iter().map(|h| h.0).collect::<Vec<_>>(),
        [1, 3],
        "LIKE is ASCII case-insensitive"
    );
    assert_eq!(hits[0].1, FATIHA[0], "LIKE hits carry plain text");
    assert_eq!(db.like_count("merciful", 1, AYAH_COUNT).unwrap(), 2);
    assert_eq!(db.like_count("merciful", 2, 7).unwrap(), 1);
    assert!(db.like_search("%", 50).unwrap().is_empty(), "% is literal");
    assert!(db.like_search("_", 50).unwrap().is_empty(), "_ is literal");
    assert_eq!(
        db.like_search("[all]", 50)
            .unwrap()
            .iter()
            .map(|h| h.0)
            .collect::<Vec<_>>(),
        [2, 262],
        "brackets are not special in LIKE"
    );
    assert!(db.like_search("", 50).unwrap().is_empty());
    assert_eq!(db.like_count("", 1, AYAH_COUNT).unwrap(), 0);

    assert_eq!(
        db.plain_texts(&[3, 1, 3, 4000]).unwrap(),
        vec![(3, FATIHA[2].to_owned()), (1, FATIHA[0].to_owned())]
    );
}

#[test]
fn plain_range_serves_the_stored_plain_text() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let mut w = PackDbWriter::create(
        &path,
        &meta(
            "tr.en.saheeh",
            PackKind::Translation,
            PackTokenizer::PorterUnicode61,
        ),
    )
    .unwrap();
    // The html carries a footnote marker; plain (as the installer stores it) does not.
    w.entry(&PackEntryInput {
        ayah_id: 262,
        to_ayah_id: 262,
        html: "<p>Allah - there is no deity except Him<sup class=\"fn\" data-fn=\"2:255:1\">1</sup>.</p>".into(),
        plain: "Allah - there is no deity except Him.".into(),
    })
    .unwrap();
    for id in [263, 265] {
        w.entry(&entry(id, id, &format!("plain {id}"))).unwrap();
    }
    w.finish().unwrap();

    let db = PackDb::open(&path).unwrap();
    assert_eq!(
        db.plain_range(262, 265).unwrap(),
        vec![
            (262, "Allah - there is no deity except Him.".to_owned()),
            (263, "plain 263".to_owned()),
            (265, "plain 265".to_owned()),
        ],
        "by ayah id, missing ayahs skipped, footnote markers absent"
    );
    assert_eq!(
        db.plain_range(263, 263).unwrap(),
        vec![(263, "plain 263".to_owned())]
    );
    assert!(db.plain_range(1, 261).unwrap().is_empty());
    for (from, to) in [(0, 5), (9, 8), (1, AYAH_COUNT + 1)] {
        assert!(
            matches!(db.plain_range(from, to), Err(CoreError::InvalidArgument(_))),
            "{from}..={to}"
        );
    }
}

#[test]
fn like_fallback_packs_have_no_fts_table() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let mut w = PackDbWriter::create(
        &path,
        &meta(
            "tr.zh.makin",
            PackKind::Translation,
            PackTokenizer::LikeFallback,
        ),
    )
    .unwrap();
    w.entry(&entry(1, 1, "奉至仁至慈的真主之名")).unwrap();
    w.entry(&entry(2, 2, "Ünïcode Text")).unwrap();
    w.finish().unwrap();
    let db = PackDb::open(&path).unwrap();
    assert!(!db.has_fts());
    assert!(matches!(
        db.fts_search("\"x\"", 10),
        Err(CoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        db.fts_count("\"x\"", 1, 7),
        Err(CoreError::InvalidArgument(_))
    ));
    assert_eq!(
        db.like_search("至仁", 10).unwrap(),
        vec![(1, "奉至仁至慈的真主之名".to_owned())]
    );
    // fold = fold_latin(plain): diacritics dropped and lowercased, plain kept for display.
    assert_eq!(
        db.like_search("unicode text", 10).unwrap(),
        vec![(2, "Ünïcode Text".to_owned())]
    );
    let conn = Connection::open(&path).unwrap();
    let fts: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'entry_fts'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fts, 0);
}

#[test]
fn arabic_normalized_packs_fold_with_the_loose_normaliser() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let mut m = meta(
        "tafsir.ar.muyassar",
        PackKind::Tafsir,
        PackTokenizer::ArabicNormalized,
    );
    m.lang = "ar".into();
    m.dir = TextDir::Rtl;
    let mut w = PackDbWriter::create(&path, &m).unwrap();
    w.entry(&entry(9, 9, "الَّذِينَ يُؤْمِنُونَ بِالْغَيْبِ وَيُقِيمُونَ الصَّلَاةَ"))
        .unwrap();
    w.finish().unwrap();
    let db = PackDb::open(&path).unwrap();
    assert_eq!(db.meta().dir, TextDir::Rtl);
    // ة→ه, hamza seat dropped, harakat stripped: the query is normalised the same way.
    let hits = db.fts_search("fold : (\"الصلاه\" \"يومنون\")", 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, 9);
    assert!(
        hits[0].1.contains("\u{E000}الصلاه\u{E001}"),
        "the raw snippet is folded text: {}",
        hits[0].1
    );
    assert_eq!(
        db.plain_texts(&[9]).unwrap()[0].1,
        "الَّذِينَ يُؤْمِنُونَ بِالْغَيْبِ وَيُقِيمُونَ الصَّلَاةَ"
    );
}

#[test]
fn tafsir_ranges_and_lookups() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let mut w = PackDbWriter::create(
        &path,
        &meta(
            "tafsir.en.test",
            PackKind::Tafsir,
            PackTokenizer::PorterUnicode61,
        ),
    )
    .unwrap();
    w.entry(&entry(1, 1, "On the basmala")).unwrap();
    w.entry(&entry(2, 4, "On praise, mercy and the Day"))
        .unwrap();
    w.entry(&entry(6, 7, "On guidance")).unwrap();
    w.finish().unwrap();
    let db = PackDb::open(&path).unwrap();
    let range = |a| db.entry_for(a).unwrap().map(|e| (e.ayah_id, e.to_ayah_id));
    assert_eq!(range(1), Some((1, 1)));
    assert_eq!(range(2), Some((2, 4)));
    assert_eq!(range(3), Some((2, 4)));
    assert_eq!(range(4), Some((2, 4)));
    assert_eq!(range(5), None, "gap between ranges");
    assert_eq!(range(7), Some((6, 7)));
    assert_eq!(range(8), None);
    assert!(matches!(
        db.entry_for(0),
        Err(CoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        db.entry_for(AYAH_COUNT + 1),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn writer_rejects_bad_input() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let tr = meta(
        "tr.en.x",
        PackKind::Translation,
        PackTokenizer::PorterUnicode61,
    );

    for bad in [
        PackMeta {
            kind: PackKind::Wbw,
            ..tr.clone()
        },
        PackMeta {
            format: 2,
            ..tr.clone()
        },
        PackMeta {
            normalizer_version: NORMALIZER_VERSION + 1,
            ..tr.clone()
        },
        PackMeta {
            pack_id: " ".into(),
            ..tr.clone()
        },
        PackMeta {
            lang: String::new(),
            ..tr.clone()
        },
    ] {
        assert!(
            matches!(
                PackDbWriter::create(&path, &bad),
                Err(CoreError::InvalidArgument(_))
            ),
            "{bad:?}"
        );
    }

    let mut w = PackDbWriter::create(&path, &tr).unwrap();
    for bad in [
        entry(0, 0, "x"),
        entry(5, 4, "x"),
        entry(6236, 6237, "x"),
        entry(1, 2, "range in a translation"),
    ] {
        assert!(
            matches!(w.entry(&bad), Err(CoreError::InvalidArgument(_))),
            "{bad:?}"
        );
    }
    w.entry(&entry(1, 1, "one")).unwrap();
    assert!(
        matches!(w.entry(&entry(1, 1, "again")), Err(CoreError::InvalidArgument(m)) if m.contains("ayah 1"))
    );
    w.footnote(&footnote("1:1:1", 1, "1")).unwrap();
    assert!(matches!(
        w.footnote(&footnote("1:1:1", 1, "1")),
        Err(CoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        w.footnote(&footnote("", 1, "1")),
        Err(CoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        w.footnote(&footnote("x", 6237, "1")),
        Err(CoreError::InvalidArgument(_))
    ));
    w.finish().unwrap();

    // No entries at all.
    let empty = PackDbWriter::create(&dir.path().join("empty.db"), &tr).unwrap();
    assert!(matches!(empty.finish(), Err(CoreError::InvalidArgument(_))));

    // Overlapping tafsir ranges are caught at finish.
    let mut w = PackDbWriter::create(
        &dir.path().join("overlap.db"),
        &meta(
            "tafsir.en.x",
            PackKind::Tafsir,
            PackTokenizer::PorterUnicode61,
        ),
    )
    .unwrap();
    w.entry(&entry(2, 5, "a")).unwrap();
    w.entry(&entry(4, 4, "b")).unwrap();
    assert!(matches!(w.finish(), Err(CoreError::InvalidArgument(m)) if m.contains("2..=5")));
}

#[test]
fn finished_files_are_compact_and_self_contained() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    build_translation(&path, PackTokenizer::PorterUnicode61);
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut side = path.as_os_str().to_owned();
        side.push(suffix);
        assert!(!PathBuf::from(side).exists(), "{suffix} left behind");
    }
    let conn = Connection::open(&path).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    let free: i64 = conn
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    assert_eq!(free, 0, "VACUUMed");
    let analyzed: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(analyzed, 1, "ANALYZEd");
}

#[test]
fn create_replaces_a_leftover_file() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    std::fs::write(&path, b"stale partial build").unwrap();
    let mut journal = path.as_os_str().to_owned();
    journal.push("-journal");
    std::fs::write(PathBuf::from(&journal), b"stale").unwrap();
    build_translation(&path, PackTokenizer::PorterUnicode61);
    assert!(!PathBuf::from(journal).exists());
    assert_eq!(PackDb::open(&path).unwrap().entries(1, 7).unwrap().len(), 7);
}

#[test]
fn dropping_a_writer_discards_its_rows() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    let mut w = PackDbWriter::create(
        &path,
        &meta(
            "tr.en.x",
            PackKind::Translation,
            PackTokenizer::PorterUnicode61,
        ),
    )
    .unwrap();
    w.entry(&entry(1, 1, "one")).unwrap();
    drop(w);
    // Never finished: no meta was committed, so it is not a pack.
    assert!(matches!(
        PackDb::open(&path),
        Err(CoreError::SchemaMismatch {
            expected: 1,
            found: 0
        })
    ));
}

#[test]
fn open_rejects_foreign_files() {
    let dir = tmp();
    assert!(matches!(
        PackDb::open(&dir.path().join("missing.db")),
        Err(CoreError::NotFound(_))
    ));

    let empty = dir.path().join("empty.db");
    std::fs::write(&empty, b"").unwrap();
    assert!(matches!(
        PackDb::open(&empty),
        Err(CoreError::SchemaMismatch {
            expected: 1,
            found: 0
        })
    ));

    let text = dir.path().join("text.db");
    std::fs::write(&text, vec![b'x'; 4096]).unwrap();
    let err = PackDb::open(&text).err().unwrap();
    assert!(err.is_corruption(), "{err}");

    // A valid pack whose format or meta was tampered with.
    let path = dir.path().join("pack.db");
    build_translation(&path, PackTokenizer::PorterUnicode61);
    let edit = |sql: &str| Connection::open(&path).unwrap().execute_batch(sql).unwrap();
    edit("UPDATE meta SET value = '2' WHERE key = 'format'");
    assert!(matches!(
        PackDb::open(&path),
        Err(CoreError::SchemaMismatch {
            expected: 1,
            found: 2
        })
    ));
    edit(
        "UPDATE meta SET value = '1' WHERE key = 'format'; UPDATE meta SET value = 'poem' WHERE key = 'kind'",
    );
    assert!(matches!(PackDb::open(&path), Err(CoreError::Corrupt(m)) if m.contains("kind")));
    edit(
        "UPDATE meta SET value = 'tafsir' WHERE key = 'kind'; DELETE FROM meta WHERE key = 'licence'",
    );
    assert!(matches!(PackDb::open(&path), Err(CoreError::Corrupt(m)) if m.contains("licence")));
    edit("INSERT INTO meta VALUES ('licence', 'x')");
    assert_eq!(PackDb::open(&path).unwrap().meta().kind, PackKind::Tafsir);
}

#[test]
fn handles_are_shared_across_threads() {
    let dir = tmp();
    let path = dir.path().join("pack.db");
    build_translation(&path, PackTokenizer::PorterUnicode61);
    let db = PackDb::open(&path).unwrap();
    let threads: Vec<_> = (0..6)
        .map(|_| {
            let db = db.clone();
            std::thread::spawn(move || {
                for _ in 0..50 {
                    assert_eq!(db.entries(1, 7).unwrap().len(), 7);
                    assert_eq!(db.fts_count("\"allah\"", 1, AYAH_COUNT).unwrap(), 4);
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
}
