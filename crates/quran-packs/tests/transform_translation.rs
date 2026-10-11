//! QuranEnc rows → pack DB rows (`quran_packs::transform::translation`): number prefixes, bracket and parenthesis
//! footnotes in the shapes of the real exports (Saheeh, Rowwad, Hilali-Khan, Zakaria's Bengali, Indonesian Affairs,
//! García, Junagarhi, Muyassar), export validation and a full build into a pack DB. Owner: WP5c.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod quranenc_support;

use quran_core::pack_db::PACK_FORMAT;
use quran_core::{NORMALIZER_VERSION, PackDb, PackMeta, PackTokenizer};
use quran_packs::PackError;
use quran_packs::transform::translation::{
    SourceRow, TransformedRow, ayah_id, build_pack_db, read_rows, transform_row,
};
use quran_types::{PackKind, TextDir};
use quranenc_support::{Row, muyassar_rows, rows, saheeh_rows, sqlite_bytes, sqlite_with_schema};

fn row(sura: u32, aya: u32, translation: &str, footnotes: &str) -> TransformedRow {
    let r = SourceRow {
        sura,
        aya,
        translation: translation.into(),
        footnotes: footnotes.into(),
    };
    transform_row(&r, ayah_id(sura, aya).unwrap()).unwrap()
}

fn notes(t: &TransformedRow) -> Vec<(&str, &str, &str)> {
    t.footnotes
        .iter()
        .map(|f| (f.id.as_str(), f.marker.as_str(), f.html.as_str()))
        .collect()
}

#[test]
fn saheeh_prefix_and_bracket_notes() {
    let t = row(
        1,
        1,
        "(1) In the name of Allāh,[2] the Entirely Merciful, the Especially Merciful.[3]",
        "[2]- Allāh is a proper name.\n[3]- Ar-Raḥmān and ar-Raḥeem are two names.",
    );
    assert_eq!(t.entry.ayah_id, 1);
    assert_eq!(t.entry.to_ayah_id, 1);
    assert_eq!(
        t.entry.html,
        r#"In the name of Allāh,<sup class="fn" data-fn="1:1:2">2</sup> the Entirely Merciful, the Especially Merciful.<sup class="fn" data-fn="1:1:3">3</sup>"#
    );
    assert_eq!(
        t.entry.plain,
        "In the name of Allāh, the Entirely Merciful, the Especially Merciful."
    );
    assert_eq!(
        notes(&t),
        [
            ("1:1:2", "2", "Allāh is a proper name."),
            ("1:1:3", "3", "Ar-Raḥmān and ar-Raḥeem are two names."),
        ]
    );
    for f in &t.footnotes {
        assert_eq!(f.ayah_id, 1);
    }
}

#[test]
fn translator_insertions_in_brackets_are_text() {
    let t = row(
        1,
        2,
        "(2) [All] praise is [due] to Allāh, Lord[4] of the worlds -",
        "[4]- Rabb.",
    );
    assert_eq!(
        t.entry.html,
        r#"[All] praise is [due] to Allāh, Lord<sup class="fn" data-fn="1:2:4">4</sup> of the worlds -"#
    );
    assert_eq!(
        t.entry.plain,
        "[All] praise is [due] to Allāh, Lord of the worlds -"
    );
}

#[test]
fn only_the_ayah_number_is_a_prefix() {
    assert_eq!(row(2, 5, "(5) Those are.", "").entry.plain, "Those are.");
    assert_eq!(
        row(2, 5, "5. Those are.", "").entry.plain,
        "Those are.",
        "Hilali-Khan / García"
    );
    assert_eq!(
        row(2, 5, "(6) Those are.", "").entry.plain,
        "(6) Those are."
    );
    assert_eq!(row(2, 5, "5.5 kg", "").entry.plain, "5.5 kg");
    assert_eq!(row(2, 5, "5 Those", "").entry.plain, "5 Those");
    assert_eq!(
        row(2, 255, "(٢٥٥) الله", "").entry.plain,
        "الله",
        "any script's digits"
    );
    assert_eq!(row(2, 255, "  (255)Allāh", "").entry.plain, "Allāh");
}

#[test]
fn rowwad_puts_several_notes_on_one_line() {
    let t = row(
        2,
        3,
        "those who believe in the unseen, establish prayer[3], and spend out of what We[4] have provided for them,",
        r#"[3] At its proper times and fulfill its all conditions. [4] "We" in reference to Allah denotes grandeur."#,
    );
    assert_eq!(
        notes(&t),
        [
            (
                "2:3:3",
                "3",
                "At its proper times and fulfill its all conditions."
            ),
            (
                "2:3:4",
                "4",
                "\"We\" in reference to Allah denotes grandeur."
            ),
        ]
    );
    // Lines that start with a space are notes too.
    let t = row(
        1,
        2,
        "Lord[2] of the worlds[3]",
        "[1] One.\n [2] Two.\n [3] Three.",
    );
    assert_eq!(
        notes(&t).iter().map(|n| n.0).collect::<Vec<_>>(),
        ["1:2:1", "1:2:2", "1:2:3"]
    );
}

#[test]
fn hilali_lists_continue_the_note() {
    let t = row(
        2,
        4,
        "4. And who believe in (the Qur’ân and the Sunnah)[4] which has been sent down [the Taurât (Torah)].",
        "[4] (V.2:4) Narrated Ibn ‘Umar: Islâm is based on five:\n1. To testify.\n2. Iqâmat-as-Salât. \n* The intimate friend\n(A) To invite mankind.\n9) A list item.",
    );
    assert_eq!(
        t.entry.plain,
        "And who believe in (the Qur’ân and the Sunnah) which has been sent down [the Taurât (Torah)]."
    );
    assert_eq!(
        notes(&t),
        [(
            "2:4:4",
            "4",
            "(V.2:4) Narrated Ibn ‘Umar: Islâm is based on five:<br>1. To testify.<br>2. Iqâmat-as-Salât.<br>* The intimate friend<br>(A) To invite mankind.<br>9) A list item."
        )]
    );
}

#[test]
fn bengali_markers_keep_their_digits_and_the_preamble_is_a_general_note() {
    let t = row(
        1,
        1,
        "রহমান, রহীম [১] আল্লাহ্\u{200c}র নামে [২]",
        "<b> সূরার নাম ও কিছু বৈশিষ্ট্য: </b> \nসূরা আল-ফাতিহা। [তাবারী, কাশশাফ]\n\n[১] রহমান অর্থ।\nদ্বিতীয় লাইন।\n[২] আল্লাহ্‌র নামে।",
    );
    assert_eq!(
        t.entry.html,
        "রহমান, রহীম <sup class=\"fn\" data-fn=\"1:1:১\">১</sup> আল্লাহ্\u{200c}র নামে <sup class=\"fn\" data-fn=\"1:1:২\">২</sup>"
    );
    assert_eq!(t.entry.plain, "রহমান, রহীম আল্লাহ্\u{200c}র নামে");
    assert_eq!(
        notes(&t),
        [
            (
                "1:1:0",
                "",
                "<b> সূরার নাম ও কিছু বৈশিষ্ট্য: </b><br>সূরা আল-ফাতিহা। [তাবারী, কাশশাফ]"
            ),
            ("1:1:১", "১", "রহমান অর্থ।<br>দ্বিতীয় লাইন।"),
            ("1:1:২", "২", "আল্লাহ্‌র নামে।"),
        ]
    );
    // Zakaria's 18:32 is a bold heading.
    let t = row(18, 32, "<b> পঞ্চম রুকু’ </b>", "");
    assert_eq!(t.entry.html, "<b> পঞ্চম রুকু’ </b>");
    assert_eq!(t.entry.plain, "পঞ্চম রুকু’");
}

#[test]
fn indonesian_parenthesis_notes() {
    let t = row(
        1,
        4,
        "Pemilik hari pembalasan.1)",
        "*1) Yaumiddīn (hari pembalasan), hari waktu manusia menerima pembalasan amalnya.",
    );
    assert_eq!(
        t.entry.html,
        r#"Pemilik hari pembalasan.<sup class="fn" data-fn="1:4:1">1</sup>"#
    );
    assert_eq!(t.entry.plain, "Pemilik hari pembalasan.");
    assert_eq!(
        notes(&t),
        [(
            "1:4:1",
            "1",
            "Yaumiddīn (hari pembalasan), hari waktu manusia menerima pembalasan amalnya."
        )]
    );
    // A marker whose note lives in another row stays text; `(5)` and `416)` are never markers.
    let t = row(
        2,
        40,
        "Wahai Bani Israil!21) Ingatlah (5) nikmat-Ku. Penuhilah janjimu,22) niscaya 416)",
        "21) Bani Israil ialah keturunan Nabi Ya'qub.\n*416) Catatan.",
    );
    assert_eq!(
        t.entry.html,
        r#"Wahai Bani Israil!<sup class="fn" data-fn="2:40:21">21</sup> Ingatlah (5) nikmat-Ku. Penuhilah janjimu,22) niscaya <sup class="fn" data-fn="2:40:416">416</sup>"#
    );
    assert_eq!(notes(&t).len(), 2);
}

#[test]
fn junagarhi_stray_angle_brackets_are_text() {
    let t = row(
        4,
        106,
        "اور اللہ تعالیٰ سے بخشش مانگو![1] بے شک اللہ تعالیٰ بخشش کرنے واﻻ، مہربانی کرنے واﻻ ہے>",
        "[1] نوٹ۔",
    );
    assert!(t.entry.html.ends_with("واﻻ ہے&gt;"), "{}", t.entry.html);
    assert!(t.entry.plain.ends_with("واﻻ ہے>"), "{}", t.entry.plain);
    assert_eq!(notes(&t), [("4:106:1", "1", "نوٹ۔")]);
}

#[test]
fn line_breaks_duplicates_and_empty_notes() {
    let t = row(2, 1, "First line\nsecond line", "[1] a\n[1] b\n[2]\n[3] c");
    assert_eq!(t.entry.html, "First line<br>second line");
    assert_eq!(t.entry.plain, "First line\nsecond line");
    assert_eq!(notes(&t), [("2:1:1", "1", "a<br>b"), ("2:1:3", "3", "c")]);
    let t = row(2, 2, "", "");
    assert_eq!((t.entry.html.as_str(), t.entry.plain.as_str()), ("", ""));
    assert!(t.footnotes.is_empty());
    // A note `[0]` next to a preamble becomes one footnote.
    let t = row(2, 3, "x[0]", "intro\n[0] zero");
    assert_eq!(notes(&t), [("2:3:0", "", "intro<br>zero")]);
}

#[test]
fn hostile_markup_in_an_export_is_sanitised() {
    let t = row(
        1,
        5,
        r#"<script>alert(1)</script>You alone <a href="javascript:x">we</a> worship<img src=x onerror=y>[1]"#,
        r#"[1] <a href="2:255">see</a> <span style="x" class="arabic">آية</span>"#,
    );
    assert_eq!(
        t.entry.html,
        r#"You alone we worship<sup class="fn" data-fn="1:5:1">1</sup>"#
    );
    assert_eq!(
        notes(&t),
        [(
            "1:5:1",
            "1",
            r#"<a data-ref="2:255">see</a> <span class="arabic">آية</span>"#
        )]
    );
}

#[test]
fn muyassar_tafsir_rows_are_one_ayah_each() {
    let t = row(
        1,
        1,
        "أبتدئ قراءة القرآن باسم الله، (اللهِ) علم على الرب",
        "",
    );
    assert_eq!(t.entry.ayah_id, 1);
    assert_eq!(t.entry.to_ayah_id, 1);
    assert_eq!(
        t.entry.plain,
        "أبتدئ قراءة القرآن باسم الله، (اللهِ) علم على الرب"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------------------------------------------

fn open(bytes: &[u8]) -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("e.sqlite");
    std::fs::write(&path, bytes).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    (dir, conn)
}

fn integrity(rows_: &[Row]) -> String {
    let (_d, conn) = open(&sqlite_bytes(rows_));
    match read_rows(&conn) {
        Err(PackError::Integrity(m)) => m,
        other => panic!("expected an integrity error, got {other:?}"),
    }
}

#[test]
fn a_complete_export_reads_in_ayah_order() {
    let mut all = saheeh_rows();
    all.reverse();
    let (_d, conn) = open(&sqlite_bytes(&all));
    let got = read_rows(&conn).unwrap();
    assert_eq!(got.len(), 6236);
    assert_eq!((got[0].sura, got[0].aya), (1, 1));
    assert_eq!((got[6235].sura, got[6235].aya), (114, 6));
    assert!(got.windows(2).all(|w| w[0].ayah_id() < w[1].ayah_id()));
}

#[test]
fn exports_must_cover_every_ayah_once() {
    let all = saheeh_rows();
    assert!(integrity(&all[1..]).contains("6235 rows"));
    let mut extra = all.clone();
    extra.push((1, 1, Some("again".into()), None));
    assert!(integrity(&extra).contains("6237 rows"));
    let mut dup = all.clone();
    dup[1] = (1, 1, Some("x".into()), None);
    assert!(integrity(&dup).contains("1:1 appears twice"));
    let mut out_of_range = all.clone();
    out_of_range[6] = (1, 8, Some("x".into()), None);
    assert!(integrity(&out_of_range).contains("1:8 is not an ayah"));
    let mut zero = all;
    zero[0] = (0, 1, Some("x".into()), None);
    assert!(integrity(&zero).contains("0:1"));
}

#[test]
fn the_table_and_columns_must_exist() {
    let (_d, conn) = open(&sqlite_with_schema(&[], "CREATE TABLE other (id INTEGER)"));
    assert!(
        matches!(read_rows(&conn), Err(PackError::Integrity(m)) if m.contains("no `translations` table"))
    );
    let (_d, conn) = open(&sqlite_with_schema(
        &[],
        "CREATE TABLE translations (id INTEGER, sura INTEGER, aya INTEGER, translation TEXT)",
    ));
    assert!(matches!(read_rows(&conn), Err(PackError::Integrity(m)) if m.contains("footnotes")));
}

#[test]
fn loose_column_types_are_accepted() {
    let all = saheeh_rows();
    let (_d, conn) = open(&sqlite_bytes(&all));
    conn.execute_batch(
        "UPDATE translations SET sura = CAST(sura AS TEXT), aya = CAST(aya AS REAL) WHERE id <= 7;
         UPDATE translations SET translation = NULL, footnotes = NULL WHERE id = 1;",
    )
    .unwrap();
    let got = read_rows(&conn).unwrap();
    assert_eq!((got[0].sura, got[0].aya), (1, 1));
    assert_eq!(
        (got[0].translation.as_str(), got[0].footnotes.as_str()),
        ("", "")
    );
    conn.execute_batch("UPDATE translations SET aya = 1.5 WHERE id = 2")
        .unwrap();
    assert!(matches!(read_rows(&conn), Err(PackError::Integrity(m)) if m.contains("aya")));
}

// ---------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------

fn meta(kind: PackKind, tokenizer: PackTokenizer, lang: &str, dir: TextDir) -> PackMeta {
    PackMeta {
        pack_id: if kind == PackKind::Tafsir {
            "tafsir.ar.muyassar"
        } else {
            "tr.en.saheeh"
        }
        .into(),
        kind,
        lang: lang.into(),
        dir,
        name: "Test".into(),
        author: String::new(),
        source: "https://quranenc.com/downloads/sqlite/test.zip".into(),
        source_version: "1.1.2".into(),
        licence: "QuranEnc terms".into(),
        attribution: "QuranEnc.com".into(),
        tokenizer,
        normalizer_version: NORMALIZER_VERSION,
        format: PACK_FORMAT,
    }
}

#[test]
fn a_translation_pack_builds_and_reads_back() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("english_saheeh.sqlite");
    std::fs::write(&src, sqlite_bytes(&saheeh_rows())).unwrap();
    let dest = dir.path().join("pack.db");
    let m = meta(
        PackKind::Translation,
        PackTokenizer::PorterUnicode61,
        "en",
        TextDir::Ltr,
    );
    let stats = build_pack_db(&src, &dest, &m, "abc123", &|| Ok(())).unwrap();
    assert_eq!(stats.entries, 6236);
    // Every 10th ayah of each surah has two notes.
    let expected_notes: u32 = (1..=114u32)
        .map(|s| quran_core::content_db::geometry::surah_ayah_count(s).unwrap() / 10 * 2)
        .sum();
    assert_eq!(stats.footnotes, expected_notes);
    let db = PackDb::open(&dest).unwrap();
    assert_eq!(db.meta().tokenizer, PackTokenizer::PorterUnicode61);
    assert_eq!(db.meta().lang, "en");
    let e = db.entries(262, 262).unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].html, "Mercy of 2:255.");
    let e = db.entries(17, 17).unwrap(); // 2:10
    assert_eq!(
        e[0].html,
        r#"Mercy of 2:10<sup class="fn" data-fn="2:10:1">1</sup> and Allāh's light.<sup class="fn" data-fn="2:10:2">2</sup>"#
    );
    let f = db.footnotes_for(&[17]).unwrap();
    assert_eq!(f.len(), 2);
    assert_eq!(f[0].id, "2:10:1");
    assert_eq!(f[0].html, "First note of 2:10.");
    // FTS over `plain` (porter, diacritics folded): "allah" finds "Allāh's".
    let hits = db.fts_search("allah", 1000).unwrap();
    assert_eq!(hits.len(), usize::try_from(expected_notes / 2).unwrap());
}

#[test]
fn a_tafsir_pack_builds_with_arabic_folding() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("arabic_moyassar.sqlite");
    std::fs::write(&src, sqlite_bytes(&muyassar_rows())).unwrap();
    let dest = dir.path().join("pack.db");
    let m = meta(
        PackKind::Tafsir,
        PackTokenizer::ArabicNormalized,
        "ar",
        TextDir::Rtl,
    );
    let stats = build_pack_db(&src, &dest, &m, "abc", &|| Ok(())).unwrap();
    assert_eq!((stats.entries, stats.footnotes), (6236, 0));
    let db = PackDb::open(&dest).unwrap();
    let e = db.entry_for(262).unwrap().unwrap();
    assert_eq!((e.ayah_id, e.to_ayah_id), (262, 262));
    assert_eq!(db.meta().dir, TextDir::Rtl);
    // The fold column drops harakat: "الرحمن" matches "الرَّحْمَٰنِ".
    assert_eq!(db.fts_search("الرحمن", 10_000).unwrap().len(), 6236);
}

#[test]
fn a_cancel_or_a_broken_file_stops_the_build() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("e.sqlite");
    std::fs::write(&src, sqlite_bytes(&saheeh_rows())).unwrap();
    let m = meta(
        PackKind::Translation,
        PackTokenizer::PorterUnicode61,
        "en",
        TextDir::Ltr,
    );
    let calls = std::cell::Cell::new(0u32);
    let err = build_pack_db(&src, &dir.path().join("p.db"), &m, "x", &|| {
        calls.set(calls.get() + 1);
        if calls.get() > 3 {
            Err(PackError::Cancelled)
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(matches!(err, PackError::Cancelled));

    std::fs::write(&src, b"<html>not a database</html>").unwrap();
    let err = build_pack_db(&src, &dir.path().join("q.db"), &m, "x", &|| Ok(())).unwrap_err();
    assert!(matches!(err, PackError::Integrity(_)), "{err:?}");

    let short: Vec<Row> = rows(|_, _| (Some("x".into()), None))
        .into_iter()
        .skip(1)
        .collect();
    std::fs::write(&src, sqlite_bytes(&short)).unwrap();
    let err = build_pack_db(&src, &dir.path().join("r.db"), &m, "x", &|| Ok(())).unwrap_err();
    assert!(matches!(err, PackError::Integrity(m) if m.contains("6235")));
}
