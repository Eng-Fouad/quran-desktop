//! `export-fixtures --only search`: `search/vocab.json` (top 2,000 `vocab_loose` terms), `search/ayahs.json`
//! (6,236 × `[id, normLoose]`) and `search/results/{slug}.json` (`SearchResults` from the real `SearchEngine`) for
//! `super::SEARCH_QUERIES`; fills `queries`.
//!
//! - `vocab.json` is `Vec<SearchSuggestion>` (the `search_suggest` DTO), most frequent first: the mock filters it by
//!   prefix.
//! - `ayahs.json` is `[[ayahId, normLoose], …]` in mushaf order: the mock folds a query with the TS port of
//!   `normalize_ar` and scans it for ad-hoc searches.
//! - `results/{slug}.json` is exactly what `search_query` returns for the request recorded in `manifest.queries` (smart
//!   mode, limit 500, layout v2). Quran queries run on core.db; translation queries on the first `tr.en.*` pack under
//!   `--packs` (`tr.en.saheeh` preferred), else on the content exporter's synthetic `tr.en.saheeh`, written the way an
//!   install writes it.
//!
//! The `search/` directory belongs to this exporter and is recreated on every run.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail, ensure};
use quran_core::{CoreDb, PackDb, SearchEngine};
use quran_types::{
    MushafLayout, PackKind, SearchMode, SearchRequest, SearchResults, SearchScope, SearchSuggestion,
};

use super::content::write_synthetic_pack;
use super::{FixtureCtx, FixtureQuery, Manifest, QueryRef, SEARCH_QUERIES};

/// Terms in `search/vocab.json`.
const VOCAB_TERMS: u32 = 2000;
/// `limit` of every fixture request (the UI default).
const LIMIT: u32 = 500;
/// The synthetic English pack (from the content exporter) used when `--packs` has none.
const SYNTHETIC_ENGLISH: &str = "tr.en.saheeh";
/// The directory under `--out` this exporter owns.
const OUTPUT_DIR: &str = "search";

pub fn export(ctx: &FixtureCtx, manifest: &mut Manifest) -> anyhow::Result<()> {
    export_with(ctx, manifest, SEARCH_QUERIES)
}

/// [`export`] for an explicit query list (tests use a small synthetic core.db).
fn export_with(
    ctx: &FixtureCtx,
    manifest: &mut Manifest,
    queries: &[FixtureQuery],
) -> anyhow::Result<()> {
    let core = CoreDb::open(&ctx.db).with_context(|| {
        format!(
            "open {} (build it first: `pnpm core:qdc`, i.e. `cargo xtask build-core --source qdc`)",
            ctx.db.display()
        )
    })?;
    let out = ctx.out.join(OUTPUT_DIR);
    match std::fs::remove_dir_all(&out) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("remove {}", out.display())),
    }
    let engine = SearchEngine::new(core.clone());

    let vocab = top_terms(&core, VOCAB_TERMS)?;
    ctx.write_json(&format!("{OUTPUT_DIR}/vocab.json"), &vocab)?;
    let ayahs = ayah_norms(&core)?;
    ctx.write_json(&format!("{OUTPUT_DIR}/ayahs.json"), &ayahs)?;

    let scratch = Scratch::new()?;
    let mut pack: Option<(PackDb, &'static str)> = None;
    let mut refs = Vec::with_capacity(queries.len());
    for q in queries {
        let (results, request) = if q.translation {
            if pack.is_none() {
                pack = Some(english_pack(ctx, &scratch)?);
            }
            let Some((db, _)) = &pack else {
                bail!("no translation pack for {}", q.slug)
            };
            let request = fixture_request(
                q.query,
                SearchScope::Translation {
                    pack_id: db.meta().pack_id.clone(),
                },
            );
            (engine.search_pack(db, &request), request)
        } else {
            let request = fixture_request(q.query, SearchScope::Quran);
            (engine.search_quran(&request), request)
        };
        let results: SearchResults =
            results.with_context(|| format!("search fixture {} ({:?})", q.slug, q.query))?;
        ensure!(
            results.total > 0,
            "search fixture {} ({:?}) finds nothing: is {} a built core.db?",
            q.slug,
            q.query,
            ctx.db.display()
        );
        ctx.write_json(&format!("{OUTPUT_DIR}/results/{}.json", q.slug), &results)?;
        refs.push(QueryRef {
            slug: q.slug.to_owned(),
            request,
        });
    }
    manifest.queries = refs;
    eprintln!(
        "search: {} vocabulary terms, {} ayah norms, {} result files{}",
        vocab.len(),
        ayahs.len(),
        manifest.queries.len(),
        pack.map_or_else(String::new, |(db, origin)| format!(
            " (translation queries on {origin} pack {})",
            db.meta().pack_id
        ))
    );
    Ok(())
}

/// The request a fixture answers: smart mode, no filters, the UI's default limit, layout v2.
fn fixture_request(query: &str, scope: SearchScope) -> SearchRequest {
    SearchRequest {
        query: query.to_owned(),
        scope,
        mode: SearchMode::Smart,
        surah: None,
        juz: None,
        limit: LIMIT,
        layout: MushafLayout::V2,
    }
}

/// The `limit` most frequent `vocab_loose` terms, most frequent first (ties by term).
fn top_terms(core: &CoreDb, limit: u32) -> anyhow::Result<Vec<SearchSuggestion>> {
    let conn = core.conn()?;
    let mut stmt = conn.prepare(
        "SELECT term, doc_count FROM vocab_loose ORDER BY doc_count DESC, term LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(SearchSuggestion {
                term: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("read vocab_loose")?;
    Ok(rows)
}

/// `[id, norm_loose]` of every ayah, in mushaf order.
fn ayah_norms(core: &CoreDb) -> anyhow::Result<Vec<(u32, String)>> {
    let conn = core.conn()?;
    let mut stmt = conn.prepare("SELECT id, norm_loose FROM ayah ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("read ayah.norm_loose")?;
    Ok(rows)
}

/// The English translation pack the translation queries run on, and where it came from: a real `tr.en.*` pack under
/// `--packs` (`tr.en.saheeh` preferred, else the first id), otherwise the content exporter's synthetic `tr.en.saheeh`.
fn english_pack(ctx: &FixtureCtx, scratch: &Scratch) -> anyhow::Result<(PackDb, &'static str)> {
    if let Some(dir) = &ctx.packs {
        let mut found: Vec<PackDb> = Vec::new();
        for path in pack_files(dir)? {
            let db = PackDb::open(&path).with_context(|| format!("open {}", path.display()))?;
            let meta = db.meta();
            if meta.kind == PackKind::Translation && meta.pack_id.starts_with("tr.en.") {
                found.push(db);
            }
        }
        found.sort_by(|a, b| {
            let key = |db: &PackDb| {
                (
                    db.meta().pack_id != SYNTHETIC_ENGLISH,
                    db.meta().pack_id.clone(),
                )
            };
            key(a).cmp(&key(b))
        });
        if let Some(db) = found.into_iter().next() {
            return Ok((db, "real"));
        }
        eprintln!(
            "search: no tr.en.* translation pack under {}; translation queries use the synthetic {SYNTHETIC_ENGLISH}",
            dir.display()
        );
    }
    let path = scratch.path().join(SYNTHETIC_ENGLISH).join("pack.db");
    write_synthetic_pack(SYNTHETIC_ENGLISH, &path)?;
    let db = PackDb::open(&path).with_context(|| format!("open {}", path.display()))?;
    Ok((db, "synthetic"))
}

/// Every `pack.db` below `dir`, sorted.
fn pack_files(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
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
    Ok(found)
}

/// A temporary directory removed on drop (best effort).
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> anyhow::Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path =
            std::env::temp_dir().join(format!("qd-fixtures-search-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // A leftover temp directory is harmless.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The synthetic core.db builder shared with quran-core's tests. `fixtures::mushaf` includes the same
/// file privately for its own tests; a second private copy here keeps the two exporters' tests independent.
#[cfg(test)]
#[allow(clippy::duplicate_mod)]
#[path = "../../../crates/quran-core/tests/support/mini_core.rs"]
mod mini_core;

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use super::*;

    fn read<T: serde::de::DeserializeOwned>(path: &Path) -> T {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    const QUERIES: &[FixtureQuery] = &[
        FixtureQuery {
            slug: "rahman",
            query: "الرحمن",
            translation: false,
        },
        FixtureQuery {
            slug: "ya-ayyuha",
            query: "يا ايها",
            translation: false,
        },
        FixtureQuery {
            slug: "tr-mercy",
            query: "mercy",
            translation: true,
        },
    ];

    #[test]
    fn exports_vocabulary_norms_and_results() {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let out = dir.path().join("fixtures");
        let ctx = FixtureCtx {
            out: out.clone(),
            db: mini.path.clone(),
            content_db: None,
            packs: None,
        };
        std::fs::create_dir_all(out.join("search/results")).unwrap();
        std::fs::write(out.join("search/results/stale.json"), "{}").unwrap();
        let mut manifest = Manifest {
            pages: vec![1, 2],
            ..Manifest::default()
        };
        export_with(&ctx, &mut manifest, QUERIES).unwrap();

        assert!(
            !out.join("search/results/stale.json").exists(),
            "the directory is recreated"
        );
        assert_eq!(manifest.pages, [1, 2], "other domains are kept");

        let vocab: Vec<SearchSuggestion> = read(&out.join("search/vocab.json"));
        assert!(!vocab.is_empty() && vocab.len() <= VOCAB_TERMS as usize);
        assert!(vocab.windows(2).all(|w| w[0].count >= w[1].count));
        assert!(vocab.iter().any(|s| s.term == "الرحمن"));

        let ayahs: Vec<(u32, String)> = read(&out.join("search/ayahs.json"));
        assert_eq!(ayahs.len(), mini.ayahs.len());
        for ((id, norm), a) in ayahs.iter().zip(&mini.ayahs) {
            assert_eq!((*id, norm.as_str()), (a.id, a.norm_loose.as_str()));
        }
        let text = std::fs::read_to_string(out.join("search/ayahs.json")).unwrap();
        assert!(
            text.starts_with("[[1,\"بسم الله الرحمن الرحيم\"]"),
            "{}",
            &text[..60]
        );

        let engine = SearchEngine::new(CoreDb::open(&mini.path).unwrap());
        assert_eq!(
            manifest
                .queries
                .iter()
                .map(|q| q.slug.as_str())
                .collect::<Vec<_>>(),
            ["rahman", "ya-ayyuha", "tr-mercy"]
        );
        for q in &manifest.queries {
            let mut results: SearchResults =
                read(&out.join(format!("search/results/{}.json", q.slug)));
            assert!(results.total > 0, "{}", q.slug);
            assert_eq!(q.request.limit, LIMIT);
            assert_eq!(q.request.mode, SearchMode::Smart);
            if let SearchScope::Translation { pack_id } = &q.request.scope {
                assert_eq!(pack_id, SYNTHETIC_ENGLISH);
                let hit = &results.groups[0].hits[0];
                assert!(
                    hit.snippet.as_deref().unwrap().contains("<mark>"),
                    "{hit:?}"
                );
            } else {
                let mut again = engine.search_quran(&q.request).unwrap();
                again.took_ms = 0;
                results.took_ms = 0;
                assert_eq!(
                    results, again,
                    "{}: the fixture is the command's answer",
                    q.slug
                );
            }
        }
        let text = std::fs::read_to_string(out.join("search/results/ya-ayyuha.json")).unwrap();
        assert!(
            text.contains("\"matchedWordIds\"") && text.ends_with('\n'),
            "camelCase DTO JSON"
        );
    }

    #[test]
    fn real_english_packs_are_preferred() {
        let dir = tempfile::tempdir().unwrap();
        let mini = mini_core::build(dir.path());
        let packs = dir.path().join("packs");
        write_synthetic_pack(
            "tr.ur.junagarhi",
            &packs.join("translation/tr.ur.junagarhi/1/pack.db"),
        )
        .unwrap();
        let ctx = FixtureCtx {
            out: dir.path().join("fixtures"),
            db: mini.path.clone(),
            content_db: None,
            packs: Some(packs.clone()),
        };
        let scratch = Scratch::new().unwrap();
        // Only an Urdu pack: the synthetic English pack is used.
        let (db, origin) = english_pack(&ctx, &scratch).unwrap();
        assert_eq!(
            (db.meta().pack_id.as_str(), origin),
            (SYNTHETIC_ENGLISH, "synthetic")
        );
        // A real English pack wins.
        write_synthetic_pack(
            SYNTHETIC_ENGLISH,
            &packs.join("translation/tr.en.saheeh/2/pack.db"),
        )
        .unwrap();
        let (db, origin) = english_pack(&ctx, &scratch).unwrap();
        assert_eq!(
            (db.meta().pack_id.as_str(), origin),
            (SYNTHETIC_ENGLISH, "real")
        );
        assert!(db.path().starts_with(&packs));
        let scratch_path = scratch.path().to_path_buf();
        drop(scratch);
        assert!(!scratch_path.exists(), "the scratch directory is removed");
    }

    #[test]
    fn a_placeholder_core_db_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("core.db");
        std::fs::write(&db, b"").unwrap();
        let ctx = FixtureCtx {
            out: dir.path().join("fixtures"),
            db,
            content_db: None,
            packs: None,
        };
        let err = export(&ctx, &mut Manifest::default()).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("pnpm core:qdc"), "{text}");
        assert!(!ctx.out.exists(), "nothing is written");
    }

    #[test]
    fn the_spec_queries_are_wired() {
        assert_eq!(SEARCH_QUERIES.len(), 7);
        assert!(
            SEARCH_QUERIES
                .iter()
                .any(|q| q.slug == "rah-prefix" && q.query == "الرح")
        );
    }
}
