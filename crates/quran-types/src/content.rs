//! Translations, tafsir and word-by-word (§5.7). Every `html` field is already sanitised (ammonia); the webview
//! sanitises again with DOMPurify through `SafeHtml`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::TextDir;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Footnote {
    pub id: String,
    pub marker: String,
    pub html: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranslationText {
    pub pack_id: String,
    pub html: String,
    pub footnotes: Vec<Footnote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRow {
    pub ayah_id: u32,
    /// In requested pack order.
    pub items: Vec<TranslationText>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TafsirEntry {
    pub pack_id: String,
    pub from_ayah_id: u32,
    pub to_ayah_id: u32,
    pub html: String,
    pub lang: String,
    pub dir: TextDir,
    /// QF-sourced content only.
    pub fetched_at: Option<u32>,
    /// Older than 7 days and revalidation not yet possible (UI footer, §9.8).
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WbwEntry {
    pub word_id: u32,
    /// The word's `text_hafs` from core.db, so the Words tab never splits ayah text.
    pub text: String,
    pub translation: Option<String>,
    pub transliteration: Option<String>,
}
