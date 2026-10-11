//! `SearchEngine::search_pack` (§2.2.5 step 7) on packs written with `PackDbWriter`, one per tokenizer, against the
//! mini core.db (whose geometry gives references and pages). Snippets are checked as exact HTML.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::path::Path;

use quran_core::pack_db::PACK_FORMAT;
use quran_core::{
    CoreDb, CoreError, NORMALIZER_VERSION, PackDb, PackDbWriter, PackEntryInput, PackMeta,
    PackTokenizer, SearchEngine,
};
use quran_types::{
    MushafLayout, PackKind, SearchHit, SearchMode, SearchRequest, SearchResults, SearchScope,
    TextDir,
};
use support::mini_core::{self, MiniCore};

struct Fixture {
    mini: MiniCore,
    engine: SearchEngine,
    dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = support::tempdir();
    let mini = mini_core::build(dir.path());
    let engine = SearchEngine::new(CoreDb::open(&mini.path).unwrap());
    Fixture { mini, engine, dir }
}

/// Writes a translation pack whose entries are `texts` (ayah id, plain text).
fn pack(
    dir: &Path,
    id: &str,
    lang: &str,
    tokenizer: PackTokenizer,
    texts: &[(u32, String)],
) -> PackDb {
    let path = dir.join(id).join("pack.db");
    let meta = PackMeta {
        pack_id: id.into(),
        kind: PackKind::Translation,
        lang: lang.into(),
        dir: if tokenizer == PackTokenizer::ArabicNormalized {
            TextDir::Rtl
        } else {
            TextDir::Ltr
        },
        name: id.into(),
        author: "test".into(),
        source: "test".into(),
        source_version: "1".into(),
        licence: "test".into(),
        attribution: "test".into(),
        tokenizer,
        normalizer_version: NORMALIZER_VERSION,
        format: PACK_FORMAT,
    };
    let mut w = PackDbWriter::create(&path, &meta).unwrap();
    for (ayah_id, plain) in texts {
        w.entry(&PackEntryInput {
            ayah_id: *ayah_id,
            to_ayah_id: *ayah_id,
            html: format!("<p>{plain}</p>"),
            plain: plain.clone(),
        })
        .unwrap();
    }
    w.finish().unwrap();
    PackDb::open(&path).unwrap()
}

fn request(pack: &PackDb, query: &str, mode: SearchMode) -> SearchRequest {
    SearchRequest {
        query: query.into(),
        scope: SearchScope::Translation {
            pack_id: pack.meta().pack_id.clone(),
        },
        mode,
        surah: None,
        juz: None,
        limit: 500,
        layout: MushafLayout::V2,
    }
}

fn hits(r: &SearchResults) -> Vec<&SearchHit> {
    r.groups.iter().flat_map(|g| &g.hits).collect()
}

fn snippets(r: &SearchResults) -> Vec<(u32, &str)> {
    hits(r)
        .into_iter()
        .map(|h| (h.ayah_id, h.snippet.as_deref().unwrap()))
        .collect()
}

/// English: ayah 1 mentions mercy and the Merciful, every third ayah light, ayah 30 has a long text.
fn english(mini: &MiniCore) -> Vec<(u32, String)> {
    (1..=mini.ayah_count())
        .map(|id| {
            let text = match id {
                1 => "In the name of Allah, the Most Merciful, the Especially Merciful.".to_owned(),
                2 => "All praise is for Allah, Lord of the worlds, the God of mercy.".to_owned(),
                30 => format!(
                    "{} the mercy of your Lord {}",
                    "and they said that ".repeat(4).trim_end(),
                    "is near to the doers of good and they were grateful "
                        .repeat(2)
                        .trim_end()
                ),
                id if id % 3 == 0 => {
                    format!("Ayah {id}: a light upon light, <guidance> & \"truth\".")
                }
                id => format!("Ayah {id}: remembrance and patience."),
            };
            (id, text)
        })
        .collect()
}

#[test]
fn english_packs_use_the_fts_snippet() {
    let f = fixture();
    let db = pack(
        f.dir.path(),
        "tr.en.test",
        "en",
        PackTokenizer::PorterUnicode61,
        &english(&f.mini),
    );
    // Porter stems: "mercy" also finds "Merciful"; the snippet marks what the tokenizer matched, escaped.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "mercy", SearchMode::Exact))
        .unwrap();
    assert_eq!(r.total, 3);
    assert_eq!(r.normalized, "mercy");
    let s = snippets(&r);
    assert_eq!(s[0].0, 1);
    assert_eq!(
        s[0].1,
        "In the name of Allah, the Most <mark>Merciful</mark>, the Especially <mark>Merciful</mark>."
    );
    assert_eq!(
        s[1],
        (
            2,
            "All praise is for Allah, Lord of the worlds, the God of <mark>mercy</mark>."
        )
    );
    assert!(
        s[2].1.contains("<mark>mercy</mark>") && s[2].1.starts_with('…'),
        "{}",
        s[2].1
    );
    for h in hits(&r) {
        let a = f.mini.ayah_by_id(h.ayah_id);
        assert_eq!(
            (h.surah, h.ayah, h.first_word_id),
            (a.surah, a.ayah, a.first_word_id)
        );
        assert_eq!(h.page, f.mini.page_of_word(1, a.first_word_id));
        assert!(h.words.is_empty() && h.matched_word_ids.is_empty() && h.note_id.is_none());
    }
    // HTML in the text is escaped; smart mode prefixes the last token.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "ligh", SearchMode::Smart))
        .unwrap();
    let expected: Vec<u32> = (1..=f.mini.ayah_count())
        .filter(|id| id % 3 == 0 && *id != 30)
        .collect();
    assert_eq!(
        hits(&r).iter().map(|h| h.ayah_id).collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        snippets(&r)[0].1,
        "Ayah 3: a <mark>light</mark> upon <mark>light</mark>, &lt;guidance&gt; &amp; &quot;truth&quot;."
    );
    assert_eq!(
        f.engine
            .search_pack(&db, &request(&db, "ligh", SearchMode::Exact))
            .unwrap()
            .total,
        0,
        "no prefix in exact mode"
    );
    // Phrases.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "\"most merciful\"", SearchMode::Smart))
        .unwrap();
    assert_eq!(r.total, 1);
    assert_eq!(r.normalized, "\"most merciful\"");
}

#[test]
fn short_queries_and_substring_mode_use_like() {
    let f = fixture();
    let db = pack(
        f.dir.path(),
        "tr.en.test",
        "en",
        PackTokenizer::PorterUnicode61,
        &english(&f.mini),
    );
    // Two characters: LIKE on `fold` (= plain), ASCII case-insensitive, marks the substring.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "Go", SearchMode::Smart))
        .unwrap();
    let ids: Vec<u32> = hits(&r).iter().map(|h| h.ayah_id).collect();
    assert_eq!(ids, [2, 30]);
    assert_eq!(r.normalized, "Go");
    assert_eq!(
        snippets(&r)[0].1,
        "All praise is for Allah, Lord of the worlds, the <mark>Go</mark>d of mercy."
    );
    assert!(snippets(&r)[1].1.contains("<mark>go</mark>od"));
    // Substring mode, inside words and across words.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "ercif", SearchMode::Substring))
        .unwrap();
    assert_eq!(r.total, 1);
    assert_eq!(
        snippets(&r)[0].1,
        "In the name of Allah, the Most M<mark>ercif</mark>ul, the Especially M<mark>ercif</mark>ul."
    );
    let r = f
        .engine
        .search_pack(&db, &request(&db, "\"of mercy\"", SearchMode::Substring))
        .unwrap();
    assert_eq!(r.total, 1);
    assert!(snippets(&r)[0].1.contains("<mark>of mercy</mark>"));
    // Wildcards are literal.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "%", SearchMode::Substring))
        .unwrap();
    assert_eq!(r.total, 0);
}

#[test]
fn latin_diacritics_and_indic_marks_follow_the_pack_tokenizer() {
    let f = fixture();
    let texts = vec![
        (
            1,
            "Au nom d'Allah, le Tout Miséricordieux, le Très Miséricordieux.".to_owned(),
        ),
        (2, "हिन्दी अनुवाद में दया और प्रकाश".to_owned()),
        (3, "Louange à Allah, Seigneur de l'univers.".to_owned()),
    ];
    let db = pack(
        f.dir.path(),
        "tr.fr.test",
        "fr",
        PackTokenizer::Unicode61RemoveDiacritics,
        &texts,
    );
    let r = f
        .engine
        .search_pack(&db, &request(&db, "misericordieux", SearchMode::Exact))
        .unwrap();
    assert_eq!(r.total, 1);
    assert_eq!(
        snippets(&r)[0].1,
        "Au nom d&#39;Allah, le Tout <mark>Miséricordieux</mark>, le Très <mark>Miséricordieux</mark>."
    );
    // Devanagari: the query is not folded in Rust (fold_latin would drop the virama the tokenizer splits on).
    let r = f
        .engine
        .search_pack(&db, &request(&db, "हिन्दी", SearchMode::Smart))
        .unwrap();
    assert_eq!(r.total, 1, "{r:?}");
    assert_eq!(hits(&r)[0].ayah_id, 2);
    let r = f
        .engine
        .search_pack(&db, &request(&db, "दया", SearchMode::Exact))
        .unwrap();
    assert_eq!(r.total, 1);
}

#[test]
fn arabic_script_packs_build_snippets_from_plain() {
    let f = fixture();
    let texts = vec![
        (
            1,
            "شروع اللہ کے نام سے جو بڑا مہربان نہایت رحم والا ہے۔".to_owned(),
        ),
        (
            2,
            "سب تعریفیں اللّٰہ کے لیے ہیں جو تمام جہانوں کا پالنے والا ہے".to_owned(),
        ),
        (3, "وہ لوگ جو نماز (الصَّلَاةَ) قائم کرتے ہیں".to_owned()),
    ];
    let db = pack(
        f.dir.path(),
        "tr.ur.test",
        "ur",
        PackTokenizer::ArabicNormalized,
        &texts,
    );
    let r = f
        .engine
        .search_pack(&db, &request(&db, "الله", SearchMode::Exact))
        .unwrap();
    assert_eq!(r.total, 2);
    assert_eq!(r.normalized, "الله");
    assert_eq!(
        snippets(&r),
        [
            (
                1,
                "شروع <mark>اللہ</mark> کے نام سے جو بڑا مہربان نہایت رحم والا ہے۔"
            ),
            (
                2,
                "سب تعریفیں <mark>اللّٰہ</mark> کے لیے ہیں جو تمام جہانوں کا پالنے والا ہے"
            ),
        ]
    );
    // The query is folded loosely (ة → ه, harakat dropped); the mark covers the vocalised word, not the brackets.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "الصلاة", SearchMode::Smart))
        .unwrap();
    assert_eq!(
        snippets(&r),
        [(3, "وہ لوگ جو نماز (<mark>الصَّلَاةَ</mark>) قائم کرتے ہیں")]
    );
    // Short Arabic queries use LIKE on the folded column and mark the substring.
    let r = f
        .engine
        .search_pack(&db, &request(&db, "رح", SearchMode::Smart))
        .unwrap();
    assert_eq!(
        snippets(&r),
        [(
            1,
            "شروع اللہ کے نام سے جو بڑا مہربان نہایت <mark>رح</mark>م والا ہے۔"
        )]
    );
}

#[test]
fn like_fallback_packs_search_substrings() {
    let f = fixture();
    let middle = "天".repeat(300);
    let texts = vec![
        (1, format!("奉至仁至慈的真主之名{middle}慈悲{middle}")),
        (8, "一切赞颂，全归真主，众世界的主。".to_owned()),
    ];
    let db = pack(
        f.dir.path(),
        "tr.zh.test",
        "zh",
        PackTokenizer::LikeFallback,
        &texts,
    );
    assert!(!db.has_fts());
    let r = f
        .engine
        .search_pack(&db, &request(&db, "慈悲", SearchMode::Smart))
        .unwrap();
    assert_eq!(r.total, 1);
    let s = snippets(&r)[0].1;
    assert!(
        s.starts_with('…') && s.ends_with('…') && s.contains("<mark>慈悲</mark>"),
        "{s}"
    );
    assert!(s.chars().count() < 340, "cut by characters");
    let r = f
        .engine
        .search_pack(&db, &request(&db, "真主", SearchMode::Exact))
        .unwrap();
    assert_eq!(
        hits(&r)
            .iter()
            .map(|h| (h.ayah_id, h.surah))
            .collect::<Vec<_>>(),
        [(1, 1), (8, 2)]
    );
    assert_eq!(r.groups.len(), 2);
}

#[test]
fn filters_truncation_and_group_counts() {
    let f = fixture();
    let db = pack(
        f.dir.path(),
        "tr.en.test",
        "en",
        PackTokenizer::PorterUnicode61,
        &english(&f.mini),
    );
    let lights: Vec<u32> = (1..=f.mini.ayah_count())
        .filter(|id| id % 3 == 0 && *id != 30)
        .collect();
    let per_surah = |ids: &[u32], surah: u32| {
        u32::try_from(
            ids.iter()
                .filter(|&&id| f.mini.ayah_by_id(id).surah == surah)
                .count(),
        )
        .unwrap()
    };
    for (query, mode) in [
        ("light", SearchMode::Smart),
        ("ight", SearchMode::Substring),
        ("li", SearchMode::Smart),
    ] {
        for limit in [1, 2, 4, 500] {
            let mut req = request(&db, query, mode);
            req.limit = limit;
            let r = f.engine.search_pack(&db, &req).unwrap();
            let ids: Vec<u32> = hits(&r).iter().map(|h| h.ayah_id).collect();
            assert_eq!(
                ids,
                lights[..lights.len().min(limit as usize)],
                "{query} {limit}"
            );
            assert_eq!(r.total as usize, lights.len(), "{query}: {ids:?}");
            assert_eq!(r.truncated, lights.len() > limit as usize);
            for g in &r.groups {
                assert_eq!(
                    g.count,
                    per_surah(&lights, g.surah),
                    "{query} {limit} surah {}",
                    g.surah
                );
            }
        }
    }
    let mut req = request(&db, "light", SearchMode::Smart);
    req.surah = Some(2);
    let r = f.engine.search_pack(&db, &req).unwrap();
    let in_surah: Vec<u32> = lights
        .iter()
        .copied()
        .filter(|id| (8..=32).contains(id))
        .collect();
    assert_eq!(
        hits(&r).iter().map(|h| h.ayah_id).collect::<Vec<_>>(),
        in_surah
    );
    req.juz = Some(1);
    let r = f.engine.search_pack(&db, &req).unwrap();
    assert!(hits(&r).iter().all(|h| (8..=20).contains(&h.ayah_id)));
    req.surah = Some(3);
    let r = f.engine.search_pack(&db, &req).unwrap();
    assert_eq!(r.total, 0, "surah 3 and juz 1 do not overlap");
}

#[test]
fn the_pack_must_match_the_request() {
    let f = fixture();
    let db = pack(
        f.dir.path(),
        "tr.en.test",
        "en",
        PackTokenizer::PorterUnicode61,
        &english(&f.mini),
    );
    let mut req = request(&db, "mercy", SearchMode::Smart);
    req.scope = SearchScope::Translation {
        pack_id: "tr.en.other".into(),
    };
    assert!(matches!(
        f.engine.search_pack(&db, &req),
        Err(CoreError::InvalidArgument(_))
    ));
    req.scope = SearchScope::Quran;
    assert!(matches!(
        f.engine.search_pack(&db, &req),
        Err(CoreError::InvalidArgument(_))
    ));
    let mut req = request(&db, "mercy", SearchMode::Smart);
    req.limit = 0;
    assert!(matches!(
        f.engine.search_pack(&db, &req),
        Err(CoreError::InvalidArgument(_))
    ));
    for q in ["", "  ", "\"\"", "-", "?!"] {
        for mode in [SearchMode::Smart, SearchMode::Exact] {
            let r = f.engine.search_pack(&db, &request(&db, q, mode)).unwrap();
            assert_eq!(r.total, 0, "{q:?}");
        }
    }
    // FTS5 syntax is searched as text.
    for q in [
        "AND",
        "mercy OR",
        "NEAR(mercy light)",
        "fold:mercy",
        "mercy*",
        "^light",
        "-light",
        "(",
        "\"mercy",
    ] {
        f.engine
            .search_pack(&db, &request(&db, q, SearchMode::Smart))
            .unwrap_or_else(|e| panic!("{q}: {e}"));
    }
}
