//! Quran text and copy options (§5.5).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::SajdaKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahText {
    pub id: u32,
    pub surah: u32,
    pub ayah: u32,
    pub juz: u32,
    pub hizb: u32,
    pub rub: u32,
    pub sajda: Option<SajdaKind>,
    pub flags: u32,
    /// Page in the requested layout.
    pub page: u32,
    pub text_hafs: String,
}

/// `short`: "(2:255)" · `long`: "— Al-Baqarah 2:255" · `arabic`: "[البقرة: ٢٥٥]"; ranges "2:255–257" / "[البقرة: ٢٥٥–٢٥٧]".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceStyle {
    Short,
    Long,
    Arabic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyOptions {
    pub include_reference: bool,
    pub reference_style: ReferenceStyle,
    /// Render end markers as ﴿N﴾ (Arabic-Indic) instead of dropping them.
    pub ayah_numbers: bool,
    /// Append that translation (plain text) after the Arabic.
    pub translation_pack_id: Option<String>,
}
