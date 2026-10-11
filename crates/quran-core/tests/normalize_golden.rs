//! The shared normaliser golden file through the public API and the shared test support (WP0B).
//! The TS port (`src/lib/text/normalize.ts`, WP10a) must pass the same `tests/data/normalize_vectors.json` (§12.3).

mod support;

use quran_core::{Level, NORMALIZER_VERSION, normalize_ar, tokens};

#[derive(serde::Deserialize)]
struct Vector {
    #[serde(rename = "in")]
    input: String,
    strict: String,
    loose: String,
}

#[test]
fn golden_file_through_the_public_api() {
    let vectors: Vec<Vector> = support::golden("normalize_vectors.json");
    assert!(vectors.len() >= 14);
    for v in &vectors {
        assert_eq!(
            normalize_ar(&v.input, Level::Strict),
            v.strict,
            "strict {:?}",
            v.input
        );
        assert_eq!(
            normalize_ar(&v.input, Level::Loose),
            v.loose,
            "loose {:?}",
            v.input
        );
        // Normalised text tokenises without empty tokens and re-joins to itself.
        assert_eq!(tokens(&v.loose).collect::<Vec<_>>().join(" "), v.loose);
    }
}

#[test]
fn normalizer_version_is_pinned() {
    // Bumping it forces a core.db rebuild and a pack/notes FTS rebuild (G13): change the golden file in the same PR.
    assert_eq!(NORMALIZER_VERSION, 1);
}

#[test]
fn env_paths_resolve_against_the_workspace_root() {
    let root = support::workspace_root();
    assert!(root.join("Cargo.toml").is_file(), "{}", root.display());
    assert!(support::data_path("normalize_vectors.json").is_file());
}
