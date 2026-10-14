//! Test catalogs and font bytes for the `fonts_*` tests.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::{Arc, Mutex};

use quran_packs::Catalog;
use quran_packs::fonts::{Fonts, FontsConfig};
use serde_json::{Value, json};

use crate::support::http::{Route, TestServer};
use crate::support::{TestEnv, bytes, sha256_hex};

/// The base the tests give [`FontsConfig::protocol_base`].
pub const BASE: &str = "quran://localhost/";

/// A woff2-looking file: `wOF2` then `len - 4` deterministic bytes.
pub fn woff2(len: usize, seed: u8) -> Vec<u8> {
    let mut v = b"wOF2".to_vec();
    v.extend(bytes(len.saturating_sub(4), seed));
    v
}

/// A TrueType-looking file.
pub fn ttf(len: usize, seed: u8) -> Vec<u8> {
    let mut v = vec![0, 1, 0, 0];
    v.extend(bytes(len.saturating_sub(4), seed));
    v
}

fn attribution() -> Value {
    json!({ "text": { "en": "Test", "ar": "اختبار" }, "url": "https://example.invalid", "licence": "test" })
}

/// A page-font pack whose templates are `{server}/{prefix}{n}/p{page}.woff2` for each prefix.
pub fn mushaf_pack(variant: &str, templates: &[String]) -> Value {
    json!({
        "id": format!("mushaf.{variant}"),
        "kind": "mushaf_fonts",
        "title": { "en": "Mushaf", "ar": "مصحف" },
        "description": { "en": "Pages", "ar": "صفحات" },
        "version": "2026.10",
        "installMode": "on_demand",
        "requires": ["decor"],
        "sizeBytes": 604 * 1000,
        "itemCount": 604,
        "attribution": attribution(),
        "source": { "adapter": "qcf_font_pages", "variant": variant, "urlTemplates": templates }
    })
}

/// One decor file: `(path, urls, bytes, sha256)`.
pub type DecorFile = (String, Vec<String>, usize, Option<String>);

/// The `decor` pack.
pub fn decor_pack(files: &[DecorFile]) -> Value {
    let total: usize = files.iter().map(|f| f.2).sum();
    json!({
        "id": "decor",
        "kind": "decor",
        "title": { "en": "Decor", "ar": "زخارف" },
        "description": { "en": "Decor", "ar": "زخارف" },
        "version": "2026.10",
        "installMode": "whole",
        "sizeBytes": total,
        "itemCount": files.len(),
        "attribution": attribution(),
        "source": { "adapter": "static_files", "files": files.iter().map(|(path, urls, bytes, sha)| {
            let mut f = json!({ "path": path, "urls": urls, "bytes": bytes });
            if let Some(sha) = sha {
                f["sha256"] = json!(sha);
            }
            f
        }).collect::<Vec<_>>() }
    })
}

pub fn catalog(packs: Vec<Value>) -> Catalog {
    Catalog::from_json(
        &json!({ "catalogVersion": 1, "generatedAt": "2026-10-10", "packs": packs }).to_string(),
    )
    .unwrap()
}

/// The three decor files served by `s` under `/decor/{name}`: `(name, bytes)`.
pub fn serve_decor(s: &TestServer) -> Vec<(String, Vec<u8>)> {
    let files = vec![
        ("qcf-surah-header.woff2".to_owned(), woff2(5_000, 1)),
        ("quran-common.ttf".to_owned(), ttf(6_000, 2)),
        ("sura-names.woff2".to_owned(), woff2(4_000, 3)),
    ];
    for (name, body) in &files {
        s.route(&format!("/decor/{name}"), Route::bytes(body.clone()));
    }
    files
}

/// Decor catalog entries for [`serve_decor`]'s files, sha256-pinned.
pub fn decor_files(s: &TestServer, files: &[(String, Vec<u8>)]) -> Vec<DecorFile> {
    files
        .iter()
        .map(|(name, body)| {
            (
                name.clone(),
                vec![s.url(&format!("/decor/{name}"))],
                body.len(),
                Some(sha256_hex(body)),
            )
        })
        .collect()
}

/// A font lane on `env` with [`BASE`], recording what its listener hears.
pub fn fonts(env: &TestEnv, catalog: &Catalog) -> (Fonts, Arc<Mutex<Vec<Vec<String>>>>) {
    let fonts = Fonts::new(
        FontsConfig {
            packs_root: env.root.clone(),
            http: env.http.clone(),
            user: env.user.clone(),
            protocol_base: BASE.to_owned(),
        },
        catalog,
    );
    let heard = Arc::new(Mutex::new(Vec::new()));
    let h = Arc::clone(&heard);
    fonts.set_listener(move |ids| h.lock().unwrap().push(ids));
    (fonts, heard)
}

/// File names in a directory, sorted (empty when it does not exist).
pub fn names(dir: &std::path::Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<String> = rd
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}
