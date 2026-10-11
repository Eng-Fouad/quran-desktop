//! Navigation requests and window chrome (§5.12).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ChromeEffect;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AppView {
    Reader,
    Downloads,
    Settings,
    About,
}

/// Where a tray action, a second-instance argv or a deep link asks the UI to go (`NavigateRequested`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NavTarget {
    Ayah { ayah_id: u32 },
    Page { page: u32 },
    Surah { surah: u32 },
    View { view: AppView },
    Search { query: String },
}

/// Sent by the frontend (the single chrome owner) whenever the resolved theme or `chromeEffect` changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChromeAppearance {
    pub dark: bool,
    pub effect: ChromeEffect,
}
