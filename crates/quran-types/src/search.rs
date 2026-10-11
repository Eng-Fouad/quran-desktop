//! Search requests and results (§5.6).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::MushafLayout;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SearchScope {
    Quran,
    Translation { pack_id: String },
    Notes,
}

/// `smart`: loose, prefix on the last token, typo fallback · `exact`: strict, no prefix · `substring`: `LIKE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    Smart,
    Exact,
    Substring,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    pub scope: SearchScope,
    pub mode: SearchMode,
    pub surah: Option<u32>,
    pub juz: Option<u32>,
    /// 1..=2000; UI default 500.
    pub limit: u32,
    /// Layout for the page numbers in hits.
    pub layout: MushafLayout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub ayah_id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub page: u32,
    /// Quran scope: id of `words[0]`.
    pub first_word_id: u32,
    /// Quran scope: per-word `text_hafs`, end marker last (never derived by splitting ayah text).
    pub words: Vec<String>,
    /// Quran scope: `words[id − firstWordId]` is matched; empty otherwise.
    pub matched_word_ids: Vec<u32>,
    /// Translation/notes scopes: escaped HTML with `<mark>…</mark>` only.
    pub snippet: Option<String>,
    pub note_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchGroup {
    pub surah: u32,
    pub count: u32,
    pub hits: Vec<SearchHit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub query: String,
    pub normalized: String,
    pub total: u32,
    pub truncated: bool,
    pub took_ms: u32,
    /// Mushaf order.
    pub groups: Vec<SearchGroup>,
    /// Typo-expansion terms used (smart mode), else empty.
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchSuggestion {
    pub term: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchHistoryEntry {
    pub query: String,
    pub scope: SearchScope,
    pub last_used_at: u32,
    pub use_count: u32,
}
