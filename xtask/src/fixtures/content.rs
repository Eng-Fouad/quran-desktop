//! `export-fixtures --only content`: `translations/{packId}/{from}-{to}.json` (`Vec<TranslationRow>`),
//! `tafsir/{packId}/{ayahId}.json` (`TafsirEntry`), `timings/{reciterId}/{surah}.json` (`SurahTimings`) and
//! `wbw/{packId}/{surah}.json` (`Vec<WbwEntry>`); fills `packs` and `timings` (docs/ARCHITECTURE.md §4.6). Owner: WP1c.
//!
//! Every file goes through the data layer the commands use: pack DBs are read with `quran_core::PackDb`, QF-sourced
//! content with `quran_core::ContentDb`, and timings become `SurahTimings` through `StoredTimings::to_dto`.
//!
//! - **Translations and pack tafsir**: the pack DBs found under `--packs <dir>`; otherwise synthetic packs built with
//!   `PackDbWriter` ([`write_synthetic_pack`]): `tr.en.saheeh` (English, footnotes, the words "mercy" and "light" for
//!   the translation search fixtures), `tr.ur.junagarhi` (Urdu, RTL) and `tafsir.ar.muyassar` (Arabic, RTL).
//! - **Content-DB tafsir, timings and WBW**: from `--content-db <dev content.db>`; otherwise a synthetic content.db with
//!   `tafsir.en.ibn_kathir` (English, multi-ayah ranges, `fetched_at`), synthetic timings (`1200 ms + 380 ms × non-end
//!   words` per ayah, words evenly split, `audio_url = mock://{reciter}/{surah}`, reciter = the default setting) for
//!   `super::TIMING_SURAHS`, and synthetic WBW (`wbw.en`) for every word on the fixture pages.
//!
//! Timings and WBW are keyed by word positions and word ids, so they need a built core.db (`--db`); without one they are
//! left to the mock's synthetic generator, which matches the mock's synthetic index (fixtures from another word
//! numbering would not). Translations and tafsir are keyed by ayah ids and never need core.db.
//!
//! The four output directories belong to this exporter and are recreated on every run.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail, ensure};
use quran_core::content_db::geometry::{ayah_ref, surah_ayah_ids};
use quran_core::pack_db::PACK_FORMAT;
use quran_core::{
    ChapterStamp, ContentDb, FootnoteInput, NORMALIZER_VERSION, PackDb, PackDbWriter,
    PackEntryInput, PackMeta, PackStats, PackTokenizer, StoredTimings, TafsirRow, TimedAyah,
    TimingFile, WordSeg,
};
use quran_types::{
    AYAH_COUNT, PackKind, Settings, TafsirEntry, TextDir, TranslationRow, TranslationText, WbwEntry,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};

use super::{AYAH_WINDOWS, FixtureCtx, Manifest, PAGES, TIMING_SURAHS, TimingRef};

/// Synthetic translation packs (catalog ids, so the mock's pack list and its content line up).
pub const SYNTHETIC_TRANSLATIONS: [&str; 2] = ["tr.en.saheeh", "tr.ur.junagarhi"];
/// The synthetic QuranEnc-style tafsir pack DB (Arabic, RTL, one entry per ayah).
pub const SYNTHETIC_PACK_TAFSIR: &str = "tafsir.ar.muyassar";
/// The synthetic Quran.com-style tafsir in content.db (English, multi-ayah ranges).
pub const SYNTHETIC_CONTENT_TAFSIR: &str = "tafsir.en.ibn_kathir";
/// The synthetic word-by-word pack.
pub const SYNTHETIC_WBW: &str = "wbw.en";

/// Ayahs per synthetic `tafsir.en.ibn_kathir` entry.
const TAFSIR_GROUP: u32 = 3;
/// QF content older than this is `stale` (§2.5.7).
const STALE_AFTER_MS: i64 = 7 * 86_400_000;

/// The content of `--out` this exporter owns.
const OUTPUT_DIRS: [&str; 4] = ["translations", "tafsir", "timings", "wbw"];

pub fn export(ctx: &FixtureCtx, manifest: &mut Manifest) -> anyhow::Result<()> {
    export_with(ctx, manifest, PAGES, AYAH_WINDOWS, TIMING_SURAHS)
}

/// [`export`] for explicit page, window and timing-surah lists (tests use a small synthetic core.db).
fn export_with(
    ctx: &FixtureCtx,
    manifest: &mut Manifest,
    pages: &[u32],
    windows: &[(u32, u32)],
    timing_surahs: &[u32],
) -> anyhow::Result<()> {
    for dir in OUTPUT_DIRS {
        let path = ctx.out.join(dir);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("remove {}", path.display())),
        }
    }
    let scratch = Scratch::new()?;
    let core = CoreWords::open(&ctx.db)?;
    if core.is_none() {
        eprintln!(
            "content: no built core.db at {}: timings and WBW are left to the mock's synthetic generator",
            ctx.db.display()
        );
    }
    let mut packs = BTreeSet::new();
    let window_ayahs: Vec<u32> = windows.iter().flat_map(|&(from, to)| from..=to).collect();

    // Translation and tafsir pack DBs.
    let pack_paths = match &ctx.packs {
        Some(dir) => find_pack_dbs(dir)?,
        None => {
            let mut paths = Vec::new();
            for id in SYNTHETIC_TRANSLATIONS
                .into_iter()
                .chain([SYNTHETIC_PACK_TAFSIR])
            {
                let path = scratch.path().join(id).join("pack.db");
                write_synthetic_pack(id, &path)?;
                paths.push(path);
            }
            paths
        }
    };
    for path in &pack_paths {
        let db = PackDb::open(path).with_context(|| format!("open pack {}", path.display()))?;
        let id = db.meta().pack_id.clone();
        match db.meta().kind {
            PackKind::Translation => export_translation(ctx, &db, windows)?,
            PackKind::Tafsir => export_pack_tafsir(ctx, &db, &window_ayahs)?,
            other => bail!("pack {id}: a {other:?} pack has no pack db"),
        }
        packs.insert(id);
    }

    // content.db: tafsir chapters, timings and WBW.
    let content = match &ctx.content_db {
        Some(path) => {
            ensure!(
                path.is_file(),
                "--content-db {} does not exist",
                path.display()
            );
            ContentDb::open(path).with_context(|| format!("open {}", path.display()))?
        }
        None => synthetic_content(&scratch, core.as_ref(), pages, &window_ayahs, timing_surahs)?,
    };
    for id in content.chapter_pack_ids()? {
        if id.starts_with("tafsir.")
            && export_content_tafsir(ctx, &content, &id, &window_ayahs)? > 0
        {
            packs.insert(id);
        }
    }
    let mut timings = Vec::new();
    if core.is_some() {
        for stamp in content.timing_stamps(None)? {
            if !timing_surahs.contains(&stamp.surah) {
                continue;
            }
            let Some(stored) = content.timings_get(stamp.reciter_id, stamp.surah)? else {
                continue;
            };
            ctx.write_json(
                &format!("timings/{}/{}.json", stamp.reciter_id, stamp.surah),
                &stored.to_dto(),
            )?;
            timings.push(TimingRef {
                reciter_id: stamp.reciter_id,
                surah: stamp.surah,
            });
        }
    }
    let mut wbw_files = 0usize;
    if let Some(core) = &core {
        let words = core.page_words(pages)?;
        for id in content.chapter_pack_ids()? {
            if !id.starts_with("wbw.") {
                continue;
            }
            let written = export_wbw(ctx, &content, &id, &words)?;
            if written > 0 {
                packs.insert(id);
                wbw_files += written;
            }
        }
    }

    manifest.packs = packs.into_iter().collect();
    manifest.timings = timings;
    eprintln!(
        "content: {} packs ({}), {} timing files, {wbw_files} wbw files from {} packs and {} content",
        manifest.packs.len(),
        manifest.packs.join(", "),
        manifest.timings.len(),
        if ctx.packs.is_some() {
            "real"
        } else {
            "synthetic"
        },
        if ctx.content_db.is_some() {
            "real"
        } else {
            "synthetic"
        },
    );
    Ok(())
}

/// `translations/{packId}/{from}-{to}.json` for every window.
fn export_translation(ctx: &FixtureCtx, db: &PackDb, windows: &[(u32, u32)]) -> anyhow::Result<()> {
    let id = &db.meta().pack_id;
    for &(from, to) in windows {
        let mut rows = Vec::new();
        for entry in db.entries(from, to)? {
            rows.push(TranslationRow {
                ayah_id: entry.ayah_id,
                items: vec![TranslationText {
                    pack_id: id.clone(),
                    html: entry.html,
                    footnotes: db.footnotes_for(&[entry.ayah_id])?,
                }],
            });
        }
        ctx.write_json(&format!("translations/{id}/{from}-{to}.json"), &rows)?;
    }
    Ok(())
}

/// `tafsir/{packId}/{ayahId}.json` from a pack DB (QuranEnc tafsir: no fetch stamp, never stale).
fn export_pack_tafsir(ctx: &FixtureCtx, db: &PackDb, ayahs: &[u32]) -> anyhow::Result<()> {
    let meta = db.meta();
    for &ayah in ayahs {
        let Some(entry) = db.entry_for(ayah)? else {
            continue;
        };
        let dto = TafsirEntry {
            pack_id: meta.pack_id.clone(),
            from_ayah_id: entry.ayah_id,
            to_ayah_id: entry.to_ayah_id,
            html: entry.html,
            lang: meta.lang.clone(),
            dir: meta.dir,
            fetched_at: None,
            stale: false,
        };
        ctx.write_json(&format!("tafsir/{}/{ayah}.json", meta.pack_id), &dto)?;
    }
    Ok(())
}

/// `tafsir/{packId}/{ayahId}.json` from content.db chapters; returns the number of files.
fn export_content_tafsir(
    ctx: &FixtureCtx,
    content: &ContentDb,
    id: &str,
    ayahs: &[u32],
) -> anyhow::Result<usize> {
    let stamps: BTreeMap<u32, i64> = content
        .chapters(id)?
        .into_iter()
        .map(|c| (c.surah, c.fetched_at_ms))
        .collect();
    let lang = id.split('.').nth(1).unwrap_or("en").to_owned();
    let dir = text_dir(&lang);
    let now = now_ms();
    let mut files = 0;
    for &ayah in ayahs {
        let Some(row) = content.tafsir_get(id, ayah)? else {
            continue;
        };
        let fetched_at_ms = ayah_ref(ayah)
            .and_then(|(s, _)| stamps.get(&s).copied())
            .unwrap_or(now);
        let dto = TafsirEntry {
            pack_id: id.to_owned(),
            from_ayah_id: row.from_ayah_id,
            to_ayah_id: row.to_ayah_id,
            html: row.html,
            lang: lang.clone(),
            dir,
            fetched_at: u32::try_from(fetched_at_ms.max(0) / 1000).ok(),
            stale: fetched_at_ms < now - STALE_AFTER_MS,
        };
        ctx.write_json(&format!("tafsir/{id}/{ayah}.json"), &dto)?;
        files += 1;
    }
    Ok(files)
}

/// `wbw/{packId}/{surah}.json` with the pack's rows for the fixture-page words; returns the number of files.
fn export_wbw(
    ctx: &FixtureCtx,
    content: &ContentDb,
    id: &str,
    words: &BTreeMap<u32, Vec<(u32, String)>>,
) -> anyhow::Result<usize> {
    let mut files = 0;
    for (surah, list) in words {
        let (Some((first, _)), Some((last, _))) = (list.first(), list.last()) else {
            continue;
        };
        let text: BTreeMap<u32, &str> = list.iter().map(|(w, t)| (*w, t.as_str())).collect();
        let rows: Vec<WbwEntry> = content
            .wbw_range(id, *first, *last)?
            .into_iter()
            .filter_map(|mut e| {
                e.text = (*text.get(&e.word_id)?).to_owned();
                Some(e)
            })
            .collect();
        if rows.is_empty() {
            continue;
        }
        ctx.write_json(&format!("wbw/{id}/{surah}.json"), &rows)?;
        files += 1;
    }
    Ok(files)
}

/// Builds the synthetic content.db in `scratch`: `tafsir.en.ibn_kathir` for the window surahs, and with a core.db the
/// synthetic timings and `wbw.en` for the fixture-page words.
fn synthetic_content(
    scratch: &Scratch,
    core: Option<&CoreWords>,
    pages: &[u32],
    window_ayahs: &[u32],
    timing_surahs: &[u32],
) -> anyhow::Result<ContentDb> {
    let content = ContentDb::open(&scratch.path().join("content.db"))?;
    let now = now_ms();
    let surahs: BTreeSet<u32> = window_ayahs
        .iter()
        .filter_map(|&a| ayah_ref(a).map(|(s, _)| s))
        .collect();
    for &surah in &surahs {
        let rows = synthetic_tafsir_chapter(surah)?;
        let stamp = ChapterStamp {
            surah,
            fetched_at_ms: now,
            sha256: sha256_of(&rows),
            pinned: false,
        };
        content.tafsir_put_chapter(SYNTHETIC_CONTENT_TAFSIR, surah, &rows, &stamp)?;
    }
    let Some(core) = core else { return Ok(content) };

    let reciter = Settings::default().reciter_id;
    for &surah in timing_surahs {
        let Some(counts) = core.non_end_word_counts(surah)? else {
            eprintln!(
                "content: core.db has no complete surah {surah}; no synthetic timings for it"
            );
            continue;
        };
        content.timings_put(&synthetic_timings(reciter, surah, &counts, now), false)?;
    }

    for (surah, words) in core.page_words(pages)? {
        let rows: Vec<WbwEntry> = words
            .iter()
            .map(|(id, _)| WbwEntry {
                word_id: *id,
                text: String::new(),
                translation: Some(format!("gloss {id}")),
                transliteration: Some(format!("translit-{id}")),
            })
            .collect();
        let stamp = ChapterStamp {
            surah,
            fetched_at_ms: now,
            sha256: sha256_of(&rows),
            pinned: false,
        };
        content.wbw_put_chapter(SYNTHETIC_WBW, surah, &rows, &stamp)?;
    }
    Ok(content)
}

/// §4.6 synthetic timings: each ayah lasts `1200 ms + 380 ms × n` (n = its non-end words), its words split that time
/// evenly (rounded like the mock's `Math.round`), ayahs back to back from 0.
fn synthetic_timings(
    reciter: u32,
    surah: u32,
    non_end_words: &[u32],
    fetched_at_ms: i64,
) -> StoredTimings {
    let mut t = 0u32;
    let mut ayahs = Vec::with_capacity(non_end_words.len());
    for (ayah, &n) in (1u32..).zip(non_end_words) {
        let duration = 1200 + 380 * n;
        let at = |i: u32| t + (2 * i * duration + n) / (2 * n);
        let words = (0..n)
            .map(|i| WordSeg {
                pos: u16::try_from(i + 1).unwrap_or(u16::MAX),
                start_ms: at(i),
                end_ms: at(i + 1),
            })
            .collect();
        ayahs.push(TimedAyah {
            ayah,
            from_ms: t,
            to_ms: t + duration,
            words,
        });
        t += duration;
    }
    StoredTimings {
        file: TimingFile {
            reciter_id: reciter,
            surah,
            audio_url: format!("mock://{reciter}/{surah}"),
            content_length: None,
            duration_ms: Some(t),
            source: "qdc".to_owned(),
            fetched_at_ms,
            etag: None,
            payload_sha256: String::new(),
        },
        word_level: true,
        ayahs,
    }
}

/// Synthetic `tafsir.en.ibn_kathir` rows of one surah: groups of [`TAFSIR_GROUP`] ayahs.
fn synthetic_tafsir_chapter(surah: u32) -> anyhow::Result<Vec<TafsirRow>> {
    let Some(ids) = surah_ayah_ids(surah) else {
        bail!("surah {surah} does not exist")
    };
    let (first, last) = (*ids.start(), *ids.end());
    let mut rows = Vec::new();
    let mut from = first;
    while from <= last {
        let to = (from + TAFSIR_GROUP - 1).min(last);
        let (a, b) = (from - first + 1, to - first + 1);
        let span = if a == b {
            format!("{surah}:{a}")
        } else {
            format!("{surah}:{a}–{b}")
        };
        rows.push(TafsirRow {
            from_ayah_id: from,
            to_ayah_id: to,
            html: format!(
                "<h2>Synthetic commentary on {span}</h2><p>Placeholder commentary for the browser mock, grouped over \
                 {} ayah(s) like Quran.com tafsir. Compare <a data-ref=\"2:255\">2:255</a>.</p>",
                to - from + 1
            ),
        });
        from = to + 1;
    }
    Ok(rows)
}

/// Writes the synthetic pack `pack_id` (one of [`SYNTHETIC_TRANSLATIONS`] or [`SYNTHETIC_PACK_TAFSIR`]) to `path`
/// with every ayah of the Quran, through `PackDbWriter` exactly as an install would. Search fixtures can build their
/// `tr.en.*` pack with it.
pub fn write_synthetic_pack(pack_id: &str, path: &Path) -> anyhow::Result<PackStats> {
    let (kind, lang, dir, tokenizer, name) = match pack_id {
        "tr.en.saheeh" => (
            PackKind::Translation,
            "en",
            TextDir::Ltr,
            PackTokenizer::PorterUnicode61,
            "Synthetic English",
        ),
        "tr.ur.junagarhi" => (
            PackKind::Translation,
            "ur",
            TextDir::Rtl,
            PackTokenizer::ArabicNormalized,
            "مصنوعی اردو ترجمہ",
        ),
        "tafsir.ar.muyassar" => (
            PackKind::Tafsir,
            "ar",
            TextDir::Rtl,
            PackTokenizer::ArabicNormalized,
            "تفسير تجريبي",
        ),
        other => bail!("{other} is not a synthetic pack"),
    };
    let meta = PackMeta {
        pack_id: pack_id.to_owned(),
        kind,
        lang: lang.to_owned(),
        dir,
        name: name.to_owned(),
        author: "Synthetic".to_owned(),
        source: "synthetic".to_owned(),
        source_version: "0".to_owned(),
        licence: "synthetic test data".to_owned(),
        attribution: "Synthetic fixture (not a real translation)".to_owned(),
        tokenizer,
        normalizer_version: NORMALIZER_VERSION,
        format: PACK_FORMAT,
    };
    let mut writer = PackDbWriter::create(path, &meta)?;
    for ayah_id in 1..=AYAH_COUNT {
        let Some((s, a)) = ayah_ref(ayah_id) else {
            bail!("ayah {ayah_id} has no reference")
        };
        let (plain, footnote) = synthetic_text(lang, s, a);
        let html = match &footnote {
            Some(_) => format!("{plain}<sup class=\"fn\" data-fn=\"{s}:{a}:1\">1</sup>"),
            None => plain.clone(),
        };
        writer.entry(&PackEntryInput {
            ayah_id,
            to_ayah_id: ayah_id,
            html,
            plain,
        })?;
        if let Some(note) = footnote {
            writer.footnote(&FootnoteInput {
                id: format!("{s}:{a}:1"),
                ayah_id,
                marker: "1".to_owned(),
                html: note,
            })?;
        }
    }
    Ok(writer.finish()?)
}

/// English placeholder sentences: the translation search fixtures look for "mercy" and "light".
const EN_SENTENCES: [&str; 8] = [
    "Placeholder text that mentions mercy.",
    "Placeholder text that mentions light.",
    "Placeholder text about guidance and patience.",
    "Placeholder text about gratitude.",
    "Placeholder text that mentions mercy and light together.",
    "Placeholder text about remembrance.",
    "Placeholder text about justice and kindness.",
    "Placeholder text about the heavens and the earth.",
];

/// The plain text of a synthetic entry and, for every 10th ayah of an English pack, a footnote.
fn synthetic_text(lang: &str, s: u32, a: u32) -> (String, Option<String>) {
    match lang {
        "ur" => (
            format!(
                "مصنوعی ترجمہ برائے آیت {}:{}۔ یہ عبارت صرف آزمائش کے لیے ہے۔",
                digits(s),
                digits(a)
            ),
            None,
        ),
        "ar" => (
            format!(
                "تفسير تجريبي للآية {} من سورة {}: نص مؤقت لأغراض العرض فقط.",
                arabic_digits(a),
                arabic_digits(s)
            ),
            None,
        ),
        _ => {
            let idx = usize::try_from((s * 31 + a * 7) % 8).unwrap_or(0);
            let sentence = EN_SENTENCES.get(idx).copied().unwrap_or(EN_SENTENCES[0]);
            let note = a
                .is_multiple_of(10)
                .then(|| format!("<p>Synthetic footnote on {s}:{a}.</p>"));
            (
                format!("Synthetic translation of {s}:{a}. {sentence}"),
                note,
            )
        }
    }
}

fn digits(n: u32) -> String {
    n.to_string()
}

/// Arabic-Indic digits (U+0660–U+0669).
fn arabic_digits(n: u32) -> String {
    n.to_string()
        .chars()
        .map(|c| {
            c.to_digit(10)
                .and_then(|d| char::from_u32(0x0660 + d))
                .unwrap_or(c)
        })
        .collect()
}

/// The text direction of a content language.
fn text_dir(lang: &str) -> TextDir {
    match lang {
        "ar" | "ur" | "fa" | "ps" | "ku" | "he" | "dv" | "sd" | "ug" => TextDir::Rtl,
        _ => TextDir::Ltr,
    }
}

/// Every `pack.db` under `dir` (one per pack id: the last path in sorted order wins, normally the newest version).
fn find_pack_dbs(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).with_context(|| format!("read {}", d.display()))? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|n| n == "pack.db") {
                found.push(path);
            }
        }
    }
    found.sort();
    let mut by_id: BTreeMap<String, PathBuf> = BTreeMap::new();
    for path in found {
        let id = PackDb::open(&path)
            .with_context(|| format!("open {}", path.display()))?
            .meta()
            .pack_id
            .clone();
        if let Some(previous) = by_id.insert(id.clone(), path) {
            eprintln!(
                "content: {id}: using a later version than {}",
                previous.display()
            );
        }
    }
    ensure!(!by_id.is_empty(), "no pack.db under {}", dir.display());
    Ok(by_id.into_values().collect())
}

/// Read-only access to the parts of a built core.db that timings and WBW are keyed by (word ids and positions).
struct CoreWords {
    conn: Connection,
}

impl CoreWords {
    /// `None` when there is no built core.db (missing, the 0-byte build.rs placeholder, or no `word` table).
    fn open(path: &Path) -> anyhow::Result<Option<Self>> {
        match std::fs::metadata(path) {
            Ok(m) if m.len() > 0 => {}
            _ => return Ok(None),
        }
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("open {}", path.display()))?;
        let tables: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('ayah', 'word', 'page')",
            [],
            |r| r.get(0),
        )?;
        Ok((tables == 3).then_some(Self { conn }))
    }

    /// The non-end word count of every ayah of `surah`, or `None` when core.db does not hold the whole surah.
    fn non_end_word_counts(&self, surah: u32) -> anyhow::Result<Option<Vec<u32>>> {
        let Some(ids) = surah_ayah_ids(surah) else {
            bail!("surah {surah} does not exist")
        };
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, last_word_id - first_word_id FROM ayah WHERE id BETWEEN ?1 AND ?2 ORDER BY id",
        )?;
        let rows = stmt
            .query_map([ids.start(), ids.end()], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let complete = rows.len() == ids.clone().count()
            && rows.iter().zip(ids).all(|((id, _), want)| *id == want);
        if !complete || rows.iter().any(|(_, n)| *n == 0) {
            return Ok(None);
        }
        Ok(Some(rows.into_iter().map(|(_, n)| n).collect()))
    }

    /// The non-end words (id, `text_hafs`) on `pages` in any layout, by surah.
    fn page_words(&self, pages: &[u32]) -> anyhow::Result<BTreeMap<u32, Vec<(u32, String)>>> {
        let mut by_surah: BTreeMap<u32, Vec<(u32, String)>> = BTreeMap::new();
        let mut range = self.conn.prepare_cached(
            "SELECT min(first_word_id), max(last_word_id) FROM page WHERE page = ?1",
        )?;
        let mut words = self.conn.prepare_cached(
            "SELECT id, surah, text_hafs FROM word WHERE id BETWEEN ?1 AND ?2 AND is_end = 0 ORDER BY id",
        )?;
        let mut seen = BTreeSet::new();
        for &page in pages {
            let Some((Some(first), Some(last))) = range
                .query_row([page], |r| {
                    Ok((r.get::<_, Option<u32>>(0)?, r.get::<_, Option<u32>>(1)?))
                })
                .optional()?
            else {
                continue;
            };
            let rows = words.query_map([first, last], |r| {
                Ok((
                    r.get::<_, u32>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (id, surah, text) = row?;
                if seen.insert(id) {
                    by_surah.entry(surah).or_default().push((id, text));
                }
            }
        }
        for list in by_surah.values_mut() {
            list.sort_by_key(|(id, _)| *id);
        }
        Ok(by_surah)
    }
}

/// A temporary directory for synthetic databases, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> anyhow::Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path = std::env::temp_dir().join(format!(
            "qd-fixtures-content-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Best effort: a leftover temp directory is harmless.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A stable fingerprint of synthetic rows (chapter stamps carry the upstream payload's sha256).
fn sha256_of<T: std::fmt::Debug>(rows: &[T]) -> String {
    hex::encode(Sha256::digest(format!("{rows:?}").as_bytes()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use quran_types::SurahTimings;

    use super::*;

    fn read<T: serde::de::DeserializeOwned>(out: &Path, rel: &str) -> T {
        let text = std::fs::read_to_string(out.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
        serde_json::from_str(&text).unwrap()
    }

    /// A core.db with surahs 1 and 112–114: words "w{s}:{a}:{p}", 2 + (a % 3) words per ayah, page 1 = surah 1 and
    /// page 604 = surahs 112–114 in layout v2.
    fn mini_core(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(quran_core::CORE_SQL).unwrap();
        // Only the ayah/word/page rows the exporter reads: no surah or mushaf rows to reference.
        conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        let mut word_id = 0u32;
        let mut page_words: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
        for surah in [1u32, 112, 113, 114] {
            for ayah_id in surah_ayah_ids(surah).unwrap() {
                let (s, a) = ayah_ref(ayah_id).unwrap();
                // Word ids follow the real numbering: start at the surah's first word id.
                if a == 1 {
                    word_id = *quran_core::content_db::geometry::surah_word_ids(s)
                        .unwrap()
                        .start()
                        - 1;
                }
                let first = word_id + 1;
                let n = 2 + a % 3;
                for p in 1..=n + 1 {
                    word_id += 1;
                    let is_end = p == n + 1;
                    conn.execute(
                        "INSERT INTO word (id, ayah_id, surah, ayah, position, is_end, text_hafs, code_v1, code_v2)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'x', 'x')",
                        rusqlite::params![word_id, ayah_id, s, a, p, is_end, format!("w{s}:{a}:{p}")],
                    )
                    .unwrap();
                }
                conn.execute(
                    "INSERT INTO ayah (id, surah, ayah, juz, hizb, rub, manzil, ruku, first_word_id, last_word_id,
                                       text_hafs, text_imlaei, norm_loose, norm_strict)
                     VALUES (?1, ?2, ?3, 1, 1, 1, 1, 1, ?4, ?5, '', '', '', '')",
                    rusqlite::params![ayah_id, s, a, first, word_id],
                )
                .unwrap();
                let page = if s == 1 { 1 } else { 604 };
                let e = page_words.entry(page).or_insert((first, word_id));
                e.0 = e.0.min(first);
                e.1 = e.1.max(word_id);
            }
        }
        for (page, (first, last)) in page_words {
            conn.execute(
                "INSERT INTO page (mushaf_id, page, first_word_id, last_word_id, first_ayah_id, last_ayah_id)
                 VALUES (1, ?1, ?2, ?3, 1, 1)",
                rusqlite::params![page, first, last],
            )
            .unwrap();
        }
    }

    fn ctx(dir: &Path, with_core: bool) -> FixtureCtx {
        let db = dir.join("core.db");
        if with_core {
            mini_core(&db);
        }
        FixtureCtx {
            out: dir.join("fixtures"),
            db,
            content_db: None,
            packs: None,
        }
    }

    #[test]
    fn synthetic_export_without_core_db() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path(), false);
        // A stale file from an earlier run disappears.
        ctx.write_json("timings/7/9.json", &1).unwrap();
        let mut manifest = Manifest::default();
        export_with(
            &ctx,
            &mut manifest,
            &[1, 604],
            &[(1, 7), (6222, 6236)],
            &[1, 112],
        )
        .unwrap();
        assert_eq!(
            manifest.packs,
            [
                "tafsir.ar.muyassar",
                "tafsir.en.ibn_kathir",
                "tr.en.saheeh",
                "tr.ur.junagarhi"
            ]
        );
        assert!(manifest.timings.is_empty());
        assert!(!ctx.out.join("timings").exists());
        assert!(!ctx.out.join("wbw").exists());

        let rows: Vec<TranslationRow> = read(&ctx.out, "translations/tr.en.saheeh/1-7.json");
        assert_eq!(
            rows.iter().map(|r| r.ayah_id).collect::<Vec<_>>(),
            (1..=7).collect::<Vec<_>>()
        );
        assert_eq!(rows[0].items[0].pack_id, "tr.en.saheeh");
        assert!(
            rows[0].items[0]
                .html
                .starts_with("Synthetic translation of 1:1.")
        );
        let ur: Vec<TranslationRow> = read(&ctx.out, "translations/tr.ur.junagarhi/6222-6236.json");
        assert_eq!(ur.len(), 15);
        assert!(
            ur[0].items[0].html.contains("آیت 112:1"),
            "{}",
            ur[0].items[0].html
        );

        let muyassar: TafsirEntry = read(&ctx.out, "tafsir/tafsir.ar.muyassar/3.json");
        assert_eq!(
            (muyassar.from_ayah_id, muyassar.to_ayah_id, muyassar.dir),
            (3, 3, TextDir::Rtl)
        );
        assert_eq!(muyassar.lang, "ar");
        assert_eq!(muyassar.fetched_at, None);
        let kathir: TafsirEntry = read(&ctx.out, "tafsir/tafsir.en.ibn_kathir/5.json");
        assert_eq!((kathir.from_ayah_id, kathir.to_ayah_id), (4, 6));
        assert_eq!((kathir.dir, kathir.stale), (TextDir::Ltr, false));
        assert!(kathir.fetched_at.is_some());
        assert!(kathir.html.contains("data-ref=\"2:255\""));
        let last: TafsirEntry = read(&ctx.out, "tafsir/tafsir.en.ibn_kathir/6236.json");
        assert_eq!((last.from_ayah_id, last.to_ayah_id), (6234, 6236));
    }

    #[test]
    fn synthetic_export_with_core_db() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path(), true);
        let mut manifest = Manifest::default();
        export_with(&ctx, &mut manifest, &[1, 604], &[(1, 7)], &[1, 2, 112]).unwrap();
        // Surah 2 is not in the mini core.db: no timings for it.
        assert_eq!(
            manifest.timings,
            [
                TimingRef {
                    reciter_id: 7,
                    surah: 1
                },
                TimingRef {
                    reciter_id: 7,
                    surah: 112
                }
            ]
        );
        assert!(manifest.packs.contains(&SYNTHETIC_WBW.to_owned()));

        let t: SurahTimings = read(&ctx.out, "timings/7/1.json");
        assert_eq!((t.reciter_id, t.surah, t.ayahs.len()), (7, 1, 7));
        assert!(t.word_level);
        // 1:1 has 2 + 1 % 3 = 3 words: 1200 + 3 × 380 = 2340 ms, split 780/780/780.
        let a1 = &t.ayahs[0];
        assert_eq!((a1.from_ms, a1.to_ms), (0, 2340));
        assert_eq!(
            a1.words
                .iter()
                .map(|w| (w.pos, w.start_ms, w.end_ms))
                .collect::<Vec<_>>(),
            [(1, 0, 780), (2, 780, 1560), (3, 1560, 2340)]
        );
        assert_eq!(t.ayahs[1].from_ms, 2340, "ayahs are back to back");
        assert_eq!(t.duration_ms, t.ayahs.last().unwrap().to_ms);

        let wbw: Vec<WbwEntry> = read(&ctx.out, "wbw/wbw.en/1.json");
        assert_eq!(wbw.len(), (1..=7).map(|a| 2 + a % 3).sum::<u32>() as usize);
        assert_eq!(wbw[0].word_id, 1);
        assert_eq!(wbw[0].text, "w1:1:1");
        assert_eq!(wbw[0].translation.as_deref(), Some("gloss 1"));
        let wbw114: Vec<WbwEntry> = read(&ctx.out, "wbw/wbw.en/114.json");
        assert!(wbw114.iter().all(|e| e.text.starts_with("w114:")));
    }

    #[test]
    fn real_packs_and_content_db_are_exported() {
        let dir = tempfile::tempdir().unwrap();
        let packs = dir.path().join("packs");
        write_synthetic_pack(
            "tr.en.saheeh",
            &packs.join("translation/tr.en.saheeh/1.1.2/pack.db"),
        )
        .unwrap();
        let content_path = dir.path().join("dev-content.db");
        {
            let content = ContentDb::open(&content_path).unwrap();
            let rows = synthetic_tafsir_chapter(1).unwrap();
            let old = now_ms() - 30 * 86_400_000;
            content
                .tafsir_put_chapter(
                    "tafsir.en.maarif",
                    1,
                    &rows,
                    &ChapterStamp {
                        surah: 1,
                        fetched_at_ms: old,
                        sha256: "x".into(),
                        pinned: true,
                    },
                )
                .unwrap();
            content
                .timings_put(&synthetic_timings(3, 112, &[4, 2, 4, 5], old), true)
                .unwrap();
            content
                .timings_put(&synthetic_timings(3, 50, &[1; 45], old), false)
                .unwrap();
        }
        let mut ctx = ctx(dir.path(), true);
        ctx.packs = Some(packs);
        ctx.content_db = Some(content_path);
        let mut manifest = Manifest::default();
        export_with(&ctx, &mut manifest, &[1], &[(1, 7)], &[112]).unwrap();
        assert_eq!(manifest.packs, ["tafsir.en.maarif", "tr.en.saheeh"]);
        assert_eq!(
            manifest.timings,
            [TimingRef {
                reciter_id: 3,
                surah: 112
            }]
        );
        let maarif: TafsirEntry = read(&ctx.out, "tafsir/tafsir.en.maarif/2.json");
        assert!(maarif.stale, "fetched 30 days ago");
        let t: SurahTimings = read(&ctx.out, "timings/3/112.json");
        assert_eq!(t.ayahs.len(), 4);
        // Missing inputs are errors, not silent fallbacks.
        let mut bad = ctx.clone();
        bad.content_db = Some(dir.path().join("missing.db"));
        assert!(export_with(&bad, &mut Manifest::default(), &[1], &[(1, 7)], &[112]).is_err());
        let mut bad = ctx.clone();
        bad.packs = Some(dir.path().join("fixtures"));
        assert!(export_with(&bad, &mut Manifest::default(), &[1], &[(1, 7)], &[112]).is_err());
    }

    #[test]
    fn synthetic_packs_carry_the_search_words() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pack.db");
        let stats = write_synthetic_pack("tr.en.saheeh", &path).unwrap();
        assert_eq!(stats.entries, AYAH_COUNT);
        assert!(stats.footnotes > 500);
        let db = PackDb::open(&path).unwrap();
        assert!(db.fts_count("\"mercy\"", 1, AYAH_COUNT).unwrap() > 500);
        assert!(db.fts_count("\"light\"", 1, AYAH_COUNT).unwrap() > 500);
        // Ayah id 17 is 2:10: every 10th ayah of the English pack has a footnote.
        assert_eq!(db.footnotes_for(&[17]).unwrap()[0].id, "2:10:1");
        assert!(write_synthetic_pack("tr.xx.none", &path).is_err());
    }

    #[test]
    fn digits_and_directions() {
        assert_eq!(arabic_digits(255), "٢٥٥");
        assert_eq!(text_dir("ur"), TextDir::Rtl);
        assert_eq!(text_dir("en"), TextDir::Ltr);
    }
}
