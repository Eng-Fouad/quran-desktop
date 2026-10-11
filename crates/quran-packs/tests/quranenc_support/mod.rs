//! Synthetic QuranEnc exports for the `quranenc_*` and `transform_*` tests (shaped like the real ones: the
//! `translations(id, sura, aya, translation, footnotes)` table, zipped as one `{key}.sqlite`). Owner: WP5c.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::io::Write;

use quran_core::PackTokenizer;
use quran_core::content_db::geometry::surah_ayah_count;
use quran_packs::adapters::{ContentKind, QuranEncSqliteConfig, VersionSource};
use quran_types::SURAH_COUNT;
use serde_json::{Value, json};

/// One export row: `(sura, aya, translation, footnotes)`.
pub type Row = (u32, u32, Option<String>, Option<String>);

/// Every ayah in canonical order, with `make(sura, aya)` → `(translation, footnotes)`.
pub fn rows(make: impl Fn(u32, u32) -> (Option<String>, Option<String>)) -> Vec<Row> {
    let mut out = Vec::with_capacity(6236);
    for sura in 1..=SURAH_COUNT {
        for aya in 1..=surah_ayah_count(sura).unwrap() {
            let (t, f) = make(sura, aya);
            out.push((sura, aya, t, f));
        }
    }
    out
}

/// Saheeh-shaped rows: `(n) ` prefixes, a `[k]` footnote on every 10th ayah of each surah with `[k]- ` lines.
pub fn saheeh_rows() -> Vec<Row> {
    rows(|sura, aya| {
        if aya % 10 == 0 {
            (
                Some(format!(
                    "({aya}) Mercy of {sura}:{aya}[1] and Allāh's light.[2]"
                )),
                Some(format!(
                    "[1]- First note of {sura}:{aya}.\n[2]- Second note of {sura}:{aya}."
                )),
            )
        } else {
            (Some(format!("({aya}) Mercy of {sura}:{aya}.")), None)
        }
    })
}

/// Muyassar-shaped rows: Arabic tafsir text, no prefixes, `NULL` footnotes.
pub fn muyassar_rows() -> Vec<Row> {
    rows(|sura, aya| {
        (
            Some(format!("تفسير الآية {aya} من سورة {sura}: الرَّحْمَٰنِ")),
            None,
        )
    })
}

/// The bytes of a SQLite export with `rows` (the real `CREATE TABLE`, or `schema` instead).
pub fn sqlite_bytes(rows: &[Row]) -> Vec<u8> {
    sqlite_with_schema(
        rows,
        "CREATE TABLE \"translations\" (\n\t\"id\"\tINTEGER NOT NULL,\n\t\"sura\"\tINTEGER,\n\t\"aya\"\tINTEGER,\n\t\"translation\"\tTEXT,\n\t\"footnotes\"\tTEXT,\n\tPRIMARY KEY(\"id\")\n)",
    )
}

/// A SQLite file with `schema` and `rows` inserted as `(id, sura, aya, translation, footnotes)`.
pub fn sqlite_with_schema(rows: &[Row], schema: &str) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.sqlite");
    {
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(schema).unwrap();
        let tx = conn.transaction().unwrap();
        if schema.contains("translations") && schema.contains("footnotes") {
            let mut stmt = tx
                .prepare("INSERT INTO translations (id, sura, aya, translation, footnotes) VALUES (?1, ?2, ?3, ?4, ?5)")
                .unwrap();
            for (i, (s, a, t, f)) in rows.iter().enumerate() {
                stmt.execute(rusqlite::params![i64::try_from(i).unwrap() + 1, s, a, t, f])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    std::fs::read(&path).unwrap()
}

/// A deflated zip of `(name, bytes)` entries.
pub fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                z.add_directory(*name, opts).unwrap();
            } else {
                z.start_file(*name, opts).unwrap();
                z.write_all(bytes).unwrap();
            }
        }
        z.finish().unwrap();
    }
    buf.into_inner()
}

/// The zip QuranEnc serves for `key`: one `{key}.sqlite` entry.
pub fn export_zip(key: &str, rows: &[Row]) -> Vec<u8> {
    zip_bytes(&[(&format!("{key}.sqlite"), &sqlite_bytes(rows))])
}

/// A source config.
pub fn config(
    key: &str,
    version: &str,
    source: VersionSource,
    tokenizer: PackTokenizer,
    kind: ContentKind,
) -> QuranEncSqliteConfig {
    QuranEncSqliteConfig {
        key: key.into(),
        version: version.into(),
        sha256: None,
        version_source: source,
        tokenizer,
        content_kind: kind,
    }
}

/// The Saheeh pack's config (`list`).
pub fn saheeh(version: &str) -> QuranEncSqliteConfig {
    config(
        "english_saheeh",
        version,
        VersionSource::List,
        PackTokenizer::PorterUnicode61,
        ContentKind::Translation,
    )
}

/// The Muyassar pack's config (`http_validators`).
pub fn muyassar(version: &str) -> QuranEncSqliteConfig {
    config(
        "arabic_moyassar",
        version,
        VersionSource::HttpValidators,
        PackTokenizer::ArabicNormalized,
        ContentKind::Tafsir,
    )
}

/// A list API body with `(key, version, title)` entries (plus the fields QuranEnc sends that we ignore).
pub fn list_json(entries: &[(&str, &str, &str)]) -> Value {
    json!({
        "translations": entries
            .iter()
            .map(|(key, version, title)| json!({
                "key": key,
                "direction": "ltr",
                "language_iso_code": "en",
                "version": version,
                "last_update": 1_750_772_247,
                "title": title,
                "description": format!("Description of {key}"),
                "file": key,
                "database_url": format!("https://quranenc.com/downloads/sqlite/{key}.zip"),
            }))
            .collect::<Vec<_>>()
    })
}
